import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { startLocalServer, type LocalServerOptions } from '../local-runtime.js';
import { dispatchNotifications } from '../schedule/notifiers/index.js';
import { snapshotKeyId, verifySnapshot, type SnapshotSigner } from '../snapshot/app-snapshot.js';
import { hooksWithDeadlines } from './hook-deadline.js';
import { observabilityFailures } from './observability.js';
import { withRequestContext, type DqlHostHooks, type DqlPrincipal } from './request-context.js';
import { readEnv } from '@zlens/core';

/**
 * RFC 0010 rule 1: a hook's answer that ZLens cannot use, or a failure ZLens did
 * not expect while serving a hosted request, is refused or explained in plain
 * words. The failure's own text (which can name code or quote what a hook
 * answered) goes to the server's log under a reference of eight letters.
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckIt = connectorRoot ? it : it.skip;
const person: DqlPrincipal = { id: 'u-ana', kind: 'person', email: 'ana@example.test', source: 'host' };
const INTERNALS = /TypeError|is not a function|is not iterable|Cannot read propert|Cannot use 'in'|\.ts:\d+|\.js:\d+/;
const REFERENCE = /reference ([bcdfghjkmnpqrstvwxz]{8})\b/;

const servers: Server[] = [];
const roots: string[] = [];
const executors: QueryExecutor[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const executor of executors.splice(0)) await executor.disconnect().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(hooks: Partial<DqlHostHooks>, options: { warehouse?: boolean; extra?: Partial<LocalServerOptions> } = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-hook-answers-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'hook_answers' }));
  let executor = {} as QueryExecutor;
  let connection = { driver: 'file' } as ConnectionConfig;
  if (options.warehouse) {
    executor = new QueryExecutor();
    connection = { driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [connectorRoot!] } as ConnectionConfig;
    mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
    symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
  }
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor,
    connection,
    preferredPort: 0,
    hostHooks: { resolvePrincipal: () => person, ...hooks } as DqlHostHooks,
    captureServer: (created) => { servers.push(created); },
    ...(options.extra ?? {}),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: response.status, text, body: parsed };
  };
  return { call, projectRoot };
}

describe('a failure ZLens did not expect, with a host', () => {
  duckIt('a notebook query reads a plain sentence and a reference; the failure\'s own text is only in the log, under that reference', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    // A hook answer whose reading fails in a way ZLens did not foresee (a getter that throws a TypeError).
    const { call } = await serve({
      credentials: () => ({ connection: { get schema(): string { throw new TypeError("Cannot read properties of undefined (reading 'inner-7f3a')"); } } as never }),
    }, { warehouse: true });
    const answer = await call('POST', '/api/query', { sql: 'SELECT 1 AS n' });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(String(answer.body?.error ?? '')).not.toMatch(INTERNALS);
    expect(answer.text).not.toContain('inner-7f3a');
    const reference = REFERENCE.exec(String(answer.body?.error ?? ''))?.[1];
    expect(reference, answer.text).toBeTruthy();
    expect(logged.some((line) => line.includes(`reference ${reference}`) && line.includes('inner-7f3a'))).toBe(true);
  }, 60_000);
});

describe('a hosted page and its answers say they are hosted (the app never falls back to single-user screens)', () => {
  it('marks the page and every API answer, refusals and failures included; without a host nothing is marked', async () => {
    const page = '<!DOCTYPE html>\n<html><head><meta charset="UTF-8" /></head><body><div id="root"></div></body></html>';
    const { call, projectRoot } = await serve({ authorize: (_principal, action) => (action === 'settings.manage' ? { allow: false } : { allow: true }) });
    writeFileSync(join(projectRoot, 'index.html'), page);
    const html = await call('GET', '/');
    expect(html.text).toContain('<meta name="dql-hosted" content="1" />');
    const port = (servers.at(-1)!.address() as { port: number }).port;
    const refusal = await fetch(`http://127.0.0.1:${port}/api/settings/providers`, { method: 'PUT', body: '{}' });
    expect(refusal.status).toBe(403);
    expect(refusal.headers.get('x-dql-hosted')).toBe('1');
    expect((await fetch(`http://127.0.0.1:${port}/api/host/ui`)).headers.get('x-dql-hosted')).toBe('1');

    const plainRoot = mkdtempSync(join(tmpdir(), 'dql-hook-answers-plain-'));
    roots.push(plainRoot);
    writeFileSync(join(plainRoot, 'dql.config.json'), '{}');
    writeFileSync(join(plainRoot, 'index.html'), page);
    const plainPort = await startLocalServer({ rootDir: plainRoot, projectRoot: plainRoot, executor: {} as QueryExecutor, connection: { driver: 'file' } as ConnectionConfig, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
    const plainPage = await (await fetch(`http://127.0.0.1:${plainPort}/`)).text();
    expect(plainPage).toBe(page);
    const plainUi = await fetch(`http://127.0.0.1:${plainPort}/api/host/ui`);
    expect(plainUi.headers.get('x-dql-hosted')).toBeNull();
    expect(await plainUi.json()).toEqual({ host: false });
  });

  it('GET /api/host/ui passes on only well-formed host additions, never a 500, whatever the ui hook answers', async () => {
    const junk: unknown[] = [
      'links', 42, [], { links: { id: 'x' } }, { links: [null, 7, 'x'] }, { answerActions: [null] }, { answerActions: 'x' },
      { links: [{ id: 'a', label: 'A', href: '/\\evil.example', placement: 'nav' }, { id: 'b', label: 'B', href: '/e/b', placement: 'nav', badge: 'many', icon: 'rocket' }] },
      { signOutUrl: '/\\evil.example/logout', environment: { name: 'x' }, banner: 'x', appNotFound: 5, audience: 'everyone' },
    ];
    for (const answer of junk) {
      const { call } = await serve({ ui: () => answer as never });
      const ui = await call('GET', '/api/host/ui');
      expect(ui.status, JSON.stringify(answer)).toBe(200);
      expect(ui.body).toMatchObject({ host: true, person: { id: 'u-ana' } });
      expect(ui.text).not.toContain('evil.example');
      expect(Array.isArray(ui.body.links) && Array.isArray(ui.body.answerActions)).toBe(true);
      for (const link of ui.body.links) expect(link).toEqual({ id: 'b', label: 'B', href: '/e/b', placement: 'nav' });
      expect(ui.body.environment).toBeUndefined();
      expect(ui.body.audience).toBeUndefined();
      expect(ui.body.certification).toBeUndefined();
    }
  }, 60_000);

  it('GET /api/host/ui passes `certification: proposes` through (the host certifies through its review) and drops any other value', async () => {
    const proposes = await (await serve({ ui: () => ({ certification: 'proposes' }) })).call('GET', '/api/host/ui');
    expect(proposes.status).toBe(200);
    expect(proposes.body).toMatchObject({ host: true, certification: 'proposes' });
    for (const other of ['certifies', 'PROPOSES', true, { kind: 'proposes' }, undefined]) {
      const ui = await (await serve({ ui: () => ({ certification: other } as never) })).call('GET', '/api/host/ui');
      expect(ui.status, JSON.stringify(other)).toBe(200);
      expect(ui.body, JSON.stringify(other)).toMatchObject({ host: true });
      expect(ui.body, JSON.stringify(other)).not.toHaveProperty('certification');
    }
    // Without a host: { host: false }, nothing else.
    expect((await (await serve({})).call('GET', '/api/host/ui')).body).not.toHaveProperty('certification');
  }, 60_000);
});

describe('the capability map and the routes decide alike', () => {
  it('export is allowed on the map only when the SQL export would be: it runs the statement too (query.run)', async () => {
    const next = { label: 'Request access', href: '/e/access' };
    const { call } = await serve({ authorize: (_principal, action) => (action === 'query.run' ? { allow: false, reason: 'Viewers read here.', next } : { allow: true }) });
    const ui = await call('GET', '/api/host/ui');
    expect(ui.body.capabilities.export).toBe(false);
    expect(ui.body.refusals.export).toEqual({ reason: 'Viewers read here.', next });
    const refused = await call('POST', '/api/query/export', { sql: 'SELECT 1 AS one', format: 'csv' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'Viewers read here.', code: 'PERMISSION_DENIED', next });
    // Allowed both: the map says so.
    const both = await serve({ authorize: () => ({ allow: true }) });
    expect((await both.call('GET', '/api/host/ui')).body.capabilities.export).toBe(true);
  });
});

// ── Hooks ZLens calls for status and effects: answerStatus, pageEdition, traces, traceSalt, delivery, signing, git ──

const INTERNAL = 'host-internal-7d41 at 10.0.3.7:5432';
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = join(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');
const never = <T>() => new Promise<T>(() => undefined);
const answered = () => ({
  summary: 'A greeting.', answer: 'Hello.', status: 'completed' as const, trustState: 'not_applicable' as const, stopReason: 'completed' as const,
  artifacts: [], evaluations: [], nextActions: [],
});
const scriptedRuns = { conversation: answered, generated_answer: answered, semantic_answer: answered, certified_answer: answered, research: answered };

/** A seeded copy of the App fixture on DuckDB, served with these hooks: a page run, a schedule, a snapshot. */
async function serveApps(hooks: Partial<DqlHostHooks>, extra: Partial<LocalServerOptions> = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-hook-effects-'));
  roots.push(projectRoot);
  cpSync(fixtureRoot, projectRoot, { recursive: true });
  // A weekly schedule on the page, delivered through the host (so a scheduled run makes an edition, and nothing is sent).
  const appPath = join(projectRoot, 'apps', 'commerce-pilot', 'dql.app.json');
  const app = JSON.parse(readFileSync(appPath, 'utf-8'));
  app.schedules = [{ id: 'weekly', cron: '0 7 * * 1', dashboard: 'overview', deliver: [{ kind: 'webhook', url: 'https://hooks.example.test/x' }] }];
  writeFileSync(appPath, `${JSON.stringify(app, null, 2)}\n`);
  mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
  symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
  const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
  execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
  const executor = new QueryExecutor();
  executors.push(executor);
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor, preferredPort: 0,
    connection: { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] } as ConnectionConfig,
    // An analyst, as the fixture App's policies ask, so its tiles run.
    hostHooks: { resolvePrincipal: () => ({ ...person, groups: ['analyst'] }), delivery: async () => ({ delivered: true }), ...hooks } as DqlHostHooks,
    captureServer: (created) => { servers.push(created); },
    ...extra,
  });
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: response.status, text, body: parsed };
  };
}

describe('answerStatus (HH-10): a throw, junk or no answer shows no status, never a 500 or the host\'s words', () => {
  it('keeps only well-formed statuses with same-origin links', async () => {
    const answers: Array<[string, DqlHostHooks['answerStatus']]> = [
      ['throw', () => { throw new Error(INTERNAL); }],
      ['reject', () => Promise.reject(new Error(INTERNAL))],
      ['string', () => INTERNAL as never],
      ['array', () => [INTERNAL] as never],
      ['junk entries', () => ({ 'RUN': null }) as never],
      ['never', () => never()],
    ];
    for (const [label, hook] of answers) {
      const { call } = await serve({ answerStatus: hook }, { extra: { agentRunExecutors: scriptedRuns as never, hostHookTimeoutMs: 300 } });
      const run = await call('POST', '/api/agent-runs', { question: 'hello' });
      const runId = run.body?.run?.id as string;
      expect(runId, label).toBeTruthy();
      const status = await call('POST', '/api/host/answer-status', { runIds: [runId] });
      expect(status.status, label).toBe(200);
      expect(status.body, label).toEqual({ statuses: {} });
      expect(status.text, label).not.toContain('host-internal');
    }
    // A status whose link is not a path on this site keeps its words and loses the link.
    let runId = '';
    const { call } = await serve({ answerStatus: () => ({ [runId]: { state: 'checked', label: 'Checked by Dan', href: '/\\evil.example' } }) }, { extra: { agentRunExecutors: scriptedRuns as never } });
    runId = (await call('POST', '/api/agent-runs', { question: 'hello' })).body.run.id;
    expect((await call('POST', '/api/host/answer-status', { runIds: [runId] })).body).toEqual({ statuses: { [runId]: { state: 'checked', label: 'Checked by Dan' } } });
  }, 60_000);
});

describe('traces and traceSalt (HH-6): a sink that fails or is not a sink, and a key that is not a text, change no answer', () => {
  it('Ask answers as usual; a failing sink is counted, a key that is not a text is not used and not quoted', async () => {
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
    const before = observabilityFailures().traces;
    for (const traces of [() => { throw new Error(INTERNAL); }, () => Promise.reject(new Error(INTERNAL)), () => never(), 'not a sink'] as unknown as Array<DqlHostHooks['traces']>) {
      const { call } = await serve({ traces, traceSalt: 42 as never }, { extra: { agentRunExecutors: scriptedRuns as never } });
      const run = await call('POST', '/api/agent-runs', { question: 'hello' });
      expect(run.status).toBe(201);
      expect(run.text).not.toContain('host-internal');
    }
    await new Promise((done) => setTimeout(done, 100));
    expect(observabilityFailures().traces).toBeGreaterThan(before);
    expect(warned.join('\n')).not.toContain('42');
  }, 60_000);
});

describe('delivery (HH-8): only `{ delivered: true }` is delivered; a failing sink is "not delivered" in plain words', () => {
  it('reads junk as not delivered and keeps the host\'s own words out of the result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const payload = { block: 'b', path: 'p', startedAt: 't', alerts: [], queries: [], trigger: 'cron' } as never;
    const deliver = (delivery: DqlHostHooks['delivery']) => withRequestContext({ principal: person, requestId: 'r', hooks: { delivery } }, () => dispatchNotifications([{ type: 'email', recipients: ['a@example.test'] } as never], payload, tmpdir()));
    for (const junk of [undefined, null, 'yes', true, { delivered: 'true' }, { delivered: 1 }]) {
      const [result] = await deliver(async () => junk as never);
      expect(result, JSON.stringify(junk)).toMatchObject({ delivered: false, error: 'The host did not say it delivered this message.' });
    }
    expect((await deliver(async () => ({ delivered: false, error: 'Slack channel not allowed.' })))[0]).toMatchObject({ delivered: false, error: 'Slack channel not allowed.' });
    expect((await deliver(async () => ({ delivered: true, error: 42 } as never)))[0]).toEqual({ type: 'email', recipients: ['a@example.test'], delivered: true });
    for (const failing of [() => { throw new Error(INTERNAL); }, () => Promise.reject(new Error(INTERNAL))] as Array<DqlHostHooks['delivery']>) {
      const [result] = await deliver(failing);
      expect(result.delivered).toBe(false);
      expect(result.error).toMatch(/^The host could not deliver this message \(reference [bcdfghjkmnpqrstvwxz]{8}\)\.$/);
    }
  });
});

describe('git (HH-8): a review link is a web address or a path here; anything else, a throw or no answer is a plain refusal', () => {
  it('opens the review only with a usable link and never shows the host\'s words', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { openHostPullRequest } = await import('../local-runtime.js');
    const input = { gitRoot: tmpdir(), branch: 'b', base: 'main', title: 't', body: 'b' };
    const open = (openPullRequest: NonNullable<DqlHostHooks['git']>['openPullRequest']) => withRequestContext({ principal: person, requestId: 'r', hooks: { git: { openPullRequest } } }, () => openHostPullRequest(input));
    expect(await open(async () => ({ url: 'https://git.example.test/org/repo/pull/7' }))).toEqual({ ok: true, url: 'https://git.example.test/org/repo/pull/7' });
    expect(await open(async () => ({ url: '/e/reviews/7' }))).toEqual({ ok: true, url: '/e/reviews/7' });
    for (const bad of [async () => undefined, async () => ({ url: 42 }), async () => ({ url: 'javascript:alert(1)' }), async () => ({ url: '//evil.example/x' }), () => { throw new Error(INTERNAL); }] as Array<NonNullable<DqlHostHooks['git']>['openPullRequest']>) {
      const result = await open(bad);
      expect(result).toMatchObject({ ok: false });
      expect((result as { error: string }).error).toMatch(/^The review request could not be opened right now\..*reference [bcdfghjkmnpqrstvwxz]{8}\.$/);
      expect(JSON.stringify(result)).not.toMatch(/host-internal|javascript|evil/);
    }
    const late = hooksWithDeadlines({ git: { openPullRequest: () => never() } }, 20);
    expect(await withRequestContext({ principal: person, requestId: 'r', hooks: late }, () => openHostPullRequest(input))).toMatchObject({ ok: false });
  });
});

describe('pageEdition and signing (HH-16, HH-8) on a real page run', () => {
  duckIt('a page edition hook that throws, rejects, never answers or answers junk changes nothing for the scheduled run', async () => {
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.map(String).join(' ')); });
    let told = 0;
    for (const pageEdition of [() => { throw new Error(INTERNAL); }, () => Promise.reject(new Error(INTERNAL)), () => never(), () => INTERNAL] as unknown as Array<DqlHostHooks['pageEdition']>) {
      const call = await serveApps({ pageEdition: (edition) => { told += 1; return pageEdition!(edition); } });
      const scheduled = await call('POST', '/api/apps/commerce-pilot/schedules/weekly/run', {});
      expect(scheduled.body?.failedTiles, scheduled.text.slice(0, 200)).toBe(0);
      expect(scheduled.status, scheduled.text.slice(0, 200)).toBe(200);
      expect(scheduled.text).not.toContain('host-internal');
    }
    await new Promise((done) => setTimeout(done, 50));
    expect(told).toBe(4);
    expect(warned.filter((line) => /Telling the host of a new page edition failed \(reference [bcdfghjkmnpqrstvwxz]{8}\)/.test(line)).length).toBe(2);
  }, 180_000);

  duckIt('a key service that fails, answers late or answers something that is not a signature gives no signed export, only a plain refusal', async () => {
    const pair = generateKeyPairSync('ed25519');
    const der = pair.publicKey.export({ format: 'der', type: 'spki' });
    const good: SnapshotSigner = { id: snapshotKeyId(der), publicKeyBase64: der.toString('base64'), sign: (data) => edSign(null, data, pair.privateKey) };
    const signers: Array<[string, SnapshotSigner, number]> = [
      ['a working key service', good, 200],
      ['throws', { ...good, sign: () => { throw new Error(INTERNAL); } }, 503],
      ['rejects', { ...good, sign: () => Promise.reject(new Error(INTERNAL)) }, 503],
      ['not a signature', { ...good, sign: () => Buffer.from('not-a-signature') }, 503],
      ['another key', { ...good, sign: (data) => edSign(null, data, generateKeyPairSync('ed25519').privateKey) }, 503],
      ['a key id that is not its key', { ...good, id: 'k-other' }, 503],
      ['never answers', { ...good, sign: () => never() }, 503],
    ];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const [label, signing, expected] of signers) {
      const call = await serveApps({ signing }, { hostHookTimeoutMs: 50 });
      const run = await call('POST', '/api/apps/commerce-pilot/dashboards/overview/run', {});
      expect(run.status, run.text.slice(0, 200)).toBe(200);
      const exported = await call('POST', '/api/apps/commerce-pilot/dashboards/overview/snapshot', { runId: run.body.runId, body: '<section><h1>Overview</h1></section>' });
      expect(exported.status, `${label}: ${exported.text.slice(0, 200)}`).toBe(expected);
      expect(exported.text, label).not.toContain('host-internal');
      if (expected === 200) expect(verifySnapshot(exported.body.html).signatureValid).toBe(true);
      else expect(exported.body.error, label).toMatch(/^This export could not be signed right now\..*reference [bcdfghjkmnpqrstvwxz]{8}\.$/);
    }
  }, 240_000);
});
