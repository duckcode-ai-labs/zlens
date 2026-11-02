import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { capHostLinksByPlacement, safeHostUiExtras, startLocalServer } from '../local-runtime.js';
import { HostModelUnavailableError, hostActor, hostModelProvider, normalizeHostPrincipal, resultValuesMayReachModel, setHostModelHooks, withRequestContext, type DqlHostHooks, type DqlPrincipal } from './request-context.js';

/**
 * RFC 0010 HH-1: a host says who is asking, and ZLens records that person —
 * never a name from the request body.
 */
const PEOPLE: Record<string, DqlPrincipal> = {
  maria: { id: 'u-maria', kind: 'person', email: 'maria@insurer.example', displayName: 'Maria', groups: ['claims'], source: 'host' },
  dev: { id: 'u-dev', kind: 'person', displayName: 'Dev', source: 'host' },
};

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(hostHooks?: DqlHostHooks, fixture?: string): Promise<string> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-host-hooks-'));
  roots.push(projectRoot);
  if (fixture) cpSync(fixture, projectRoot, { recursive: true });
  else writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'host_hooks' }));
  const port = await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    preferredPort: 0,
    ...(hostHooks ? { hostHooks } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  return `http://127.0.0.1:${port}`;
}

/** A host that reads the person from a header, as a proxy in front of ZLens would. */
const headerHost: DqlHostHooks = {
  resolvePrincipal: async (req: IncomingMessage) => {
    const who = req.headers['x-test-person'];
    const delay = Number(req.headers['x-test-delay'] ?? 0);
    if (delay) await new Promise((done) => setTimeout(done, delay));
    return typeof who === 'string' ? PEOPLE[who] ?? null : null;
  },
};

describe('host principal (RFC 0010 HH-1)', () => {
  it('accepts only a well-formed principal and always marks it as the host\'s', () => {
    expect(normalizeHostPrincipal(null)).toBeNull();
    expect(normalizeHostPrincipal({ kind: 'person' })).toBeNull();
    expect(normalizeHostPrincipal({ id: '  ' })).toBeNull();
    expect(normalizeHostPrincipal({ id: 'x', kind: 'robot' })).toBeNull();
    expect(normalizeHostPrincipal({ id: 'x', source: 'local', groups: ['a', 3, ''] })).toEqual({ id: 'x', kind: 'person', groups: ['a'], source: 'host' });
    expect(normalizeHostPrincipal({ id: 'x', appGrants: { claims: 'execute', finance: 'read', ops: 'owner', bad: 1 } })).toEqual({ id: 'x', kind: 'person', appGrants: { claims: 'execute', finance: 'read' }, source: 'host' });
  });

  it('names the acting person by email, then display name, then id — and only for a host principal', () => {
    expect(hostActor()).toBeUndefined();
    expect(withRequestContext({ principal: PEOPLE.maria!, requestId: 'r1' }, () => hostActor())).toBe('maria@insurer.example');
    expect(withRequestContext({ principal: PEOPLE.dev!, requestId: 'r2' }, () => hostActor())).toBe('Dev');
    expect(withRequestContext({ principal: { id: 'me', kind: 'person', source: 'local' }, requestId: 'r3' }, () => hostActor())).toBeUndefined();
  });

  it('refuses API requests the host cannot place, and keeps health open', async () => {
    const base = await start({
      resolvePrincipal: (req) => {
        if (req.headers['x-test-person'] === 'boom') throw new Error('identity provider down');
        if (req.headers['x-test-person'] === 'bad') return { kind: 'person' } as unknown as DqlPrincipal;
        return null;
      },
    });
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    for (const person of [undefined, 'boom', 'bad']) {
      const response = await fetch(`${base}/api/identity`, person ? { headers: { 'x-test-person': person } } : {});
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Sign in to use ZLens.' });
    }
  });

  it('with hooks but no resolvePrincipal, names nobody: not the machine\'s own owner (single-user names it, as before)', async () => {
    const local = await (await fetch(`${await start()}/api/identity`)).json() as { owner: string };
    expect(local.owner).toBeTruthy();
    const hosted = await fetch(`${await start({ statements: () => undefined })}/api/identity`);
    expect(hosted.status).toBe(200);
    expect(await hosted.json()).toEqual({ owner: '', principal: null });
  });

  it('answers each request as its own person, even when they overlap', async () => {
    const base = await start(headerHost);
    const [slow, fast] = await Promise.all([
      fetch(`${base}/api/identity`, { headers: { 'x-test-person': 'maria', 'x-test-delay': '60' } }).then((response) => response.json()),
      fetch(`${base}/api/identity`, { headers: { 'x-test-person': 'dev' } }).then((response) => response.json()),
    ]) as Array<{ owner: string; principal: { id: string; groups: string[] } }>;
    expect(slow).toMatchObject({ owner: 'maria@insurer.example', principal: { id: 'u-maria', groups: ['claims'] } });
    expect(fast).toMatchObject({ owner: 'Dev', principal: { id: 'u-dev', groups: [] } });
  });

  it('records the signed-in person as a correction\'s author and a hint\'s reviewer, ignoring names in the body', async () => {
    const base = await start(headerHost);
    const asMaria = { 'Content-Type': 'application/json', 'x-test-person': 'maria' };
    const captured = await fetch(`${base}/api/agent/learnings/correction`, {
      method: 'POST',
      headers: asMaria,
      body: JSON.stringify({
        question: 'What is net revenue?',
        wrongSql: 'SELECT SUM(amount) FROM orders',
        correctedSql: 'SELECT SUM(net_amount) FROM orders',
        scope: { metric: 'revenue' },
        author: 'mallory@elsewhere.example',
      }),
    }).then((response) => response.json()) as { hint: { id: string; author?: string } };
    expect(captured.hint.author).toBe('maria@insurer.example');

    const retired = await fetch(`${base}/api/agent/hints/${encodeURIComponent(captured.hint.id)}/lifecycle`, {
      method: 'POST',
      headers: asMaria,
      body: JSON.stringify({ action: 'retire', note: 'The metric changed.', reviewer: 'mallory@elsewhere.example' }),
    }).then((response) => response.json()) as { ok: boolean; hint: { status: string; reviewer?: string } };
    expect(retired).toMatchObject({ ok: true, hint: { status: 'retired', reviewer: 'maria@insurer.example' } });
  });

  it('changes nothing without host hooks: the local owner, and names from the body, as before', async () => {
    const base = await start();
    const identity = await fetch(`${base}/api/identity`).then((response) => response.json()) as Record<string, unknown>;
    expect(Object.keys(identity)).toEqual(['owner']);
    const captured = await fetch(`${base}/api/agent/learnings/correction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'What is net revenue?',
        wrongSql: 'SELECT SUM(amount) FROM orders',
        correctedSql: 'SELECT SUM(net_amount) FROM orders',
        scope: { metric: 'revenue' },
        author: 'local-analyst',
      }),
    }).then((response) => response.json()) as { hint: { author?: string } };
    expect(captured.hint.author).toBe('local-analyst');
  });
});

describe('the Apps a person is shown (RFC 0010 HH-2)', () => {
  it('lists only the Apps the host lets this person open', async () => {
    const base = await start({
      ...headerHost,
      authorize: (principal, action, resource) => ({ allow: !(action === 'app.view' && resource.type === 'app' && principal.id === 'u-dev') }),
    }, join(import.meta.dirname, '../../test/fixtures/app-datasets-pilot'));
    const list = async (who: string) => ((await (await fetch(`${base}/api/apps`, { headers: { 'x-test-person': who } })).json()) as { apps: Array<{ id: string }> }).apps.map((app) => app.id);
    expect(await list('maria')).toEqual(['commerce-pilot']);
    expect(await list('dev')).toEqual([]);
  });
});

describe('certified sources a person may use (RFC 0010 HH-13)', () => {
  it('refuses the tiles of a Dataset the host keeps from this person, each on its own', async () => {
    const asked: Array<{ person: string; ids: string[] }> = [];
    const base = await start({
      ...headerHost,
      authorize: () => ({ allow: true }),
      sourceAccess: (principal, sources) => {
        asked.push({ person: principal.id, ids: sources.map((source) => source.id) });
        return principal.id === 'u-maria' ? sources.map((source) => source.id) : [];
      },
    }, join(import.meta.dirname, '../../test/fixtures/app-datasets-pilot'));
    const run = await fetch(`${base}/api/apps/commerce-pilot/dashboards/overview/run`, { method: 'POST', headers: { 'x-test-person': 'dev', 'Content-Type': 'application/json' }, body: '{}' });
    const body = await run.json() as { tiles?: Array<{ status: string; error?: string }> };
    const refused = (body.tiles ?? []).filter((tile) => /You don't have access to the Dataset/.test(tile.error ?? ''));
    expect(refused.length).toBeGreaterThan(0);
    expect(asked.find((entry) => entry.person === 'u-dev')?.ids.every((id) => id.startsWith('app:'))).toBe(true);
  });
});

describe('what a signed-in person may do (RFC 0010 HH-2)', () => {
  it('asks the host about each request and refuses with its reason, naming the action', async () => {
    const asked: Array<{ person: string; action: string; resource: unknown }> = [];
    const base = await start({
      ...headerHost,
      authorize: (principal, action, resource) => {
        asked.push({ person: principal.id, action, resource });
        if (action === 'settings.manage') throw new Error('policy store down');
        if (principal.id === 'u-dev' && action === 'connection.manage') return { allow: false, reason: 'Only admins change connections.' };
        if (action === 'app.view') return { allow: false, reason: 'You don\'t have access to Claims.', next: { label: 'Ask for access', href: '/e/apps/claims/access' } };
        if (action === 'app.author') return { allow: false, reason: 'No.', next: { label: 'Elsewhere', href: 'https://evil.example/phish' } };
        return { allow: true };
      },
    });
    const asDev = { 'Content-Type': 'application/json', 'x-test-person': 'dev' };

    const refused = await fetch(`${base}/api/connections`, { method: 'PUT', headers: asDev, body: JSON.stringify({ connections: {} }) });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Only admins change connections.', code: 'PERMISSION_DENIED', action: 'connection.manage', resource: { type: 'project' } });

    const broken = await fetch(`${base}/api/settings/providers`, { method: 'POST', headers: { ...asDev, 'x-test-person': 'maria' }, body: '{}' });
    expect(broken.status).toBe(403);
    expect(await broken.json()).toMatchObject({ error: 'You do not have permission to do this.', action: 'settings.manage' });

    expect((await fetch(`${base}/api/identity`, { headers: asDev })).status).toBe(200);
    // HH-12: a refusal can say where to go, a same-origin page only.
    const app = await fetch(`${base}/api/apps/claims`, { headers: asDev });
    expect(await app.json()).toMatchObject({ code: 'PERMISSION_DENIED', next: { label: 'Ask for access', href: '/e/apps/claims/access' } });
    const offsite = await fetch(`${base}/api/apps/claims`, { method: 'PUT', headers: asDev, body: '{}' });
    expect(offsite.status).toBe(403);
    expect(await offsite.json()).not.toHaveProperty('next');
    expect(asked).toContainEqual({ person: 'u-dev', action: 'app.view', resource: { type: 'app', id: 'claims' } });
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect(asked.some((entry) => entry.action === 'project.read' && entry.person === 'u-dev')).toBe(true);
  });
});

describe('the model and the privacy boundary (RFC 0010 HH-5)', () => {
  const fakeModel = { name: 'claude', available: async () => true, generate: async () => 'ok' } as unknown as import('./request-context.js').DqlModelProvider;
  afterEach(() => setHostModelHooks(undefined));

  it('uses the host\'s model for the person asking, and DQL\'s own settings otherwise', () => {
    expect(hostModelProvider()).toBeUndefined();
    const asked: Array<string | null> = [];
    setHostModelHooks({ modelProvider: ({ principal }) => { asked.push(principal?.id ?? null); return principal ? { id: 'anthropic', provider: fakeModel } : undefined; } });
    expect(withRequestContext({ principal: PEOPLE.maria!, requestId: 'r' }, () => hostModelProvider())).toEqual({ id: 'anthropic', provider: fakeModel });
    expect(hostModelProvider()).toBeUndefined();
    expect(asked).toEqual(['u-maria', null]);
    // A hook that fails, or answers something that is not a model, refuses: no model at all, not the project's own.
    setHostModelHooks({ modelProvider: () => { throw new Error('model registry down'); } });
    expect(() => hostModelProvider()).toThrow(HostModelUnavailableError);
    for (const junk of ['bedrock', 42, { id: 'x' }, { provider: fakeModel }, { id: '', provider: fakeModel }, { id: 'x', provider: 'a token' }, Promise.resolve({ id: 'x', provider: fakeModel })]) {
      setHostModelHooks({ modelProvider: () => junk as never });
      expect(() => hostModelProvider(), JSON.stringify(junk)).toThrow(HostModelUnavailableError);
    }
  });

  it('lets values reach a model only inside the boundary: this machine by default, the host\'s rule when set', () => {
    const bedrock = { id: 'anthropic', name: 'claude', model: 'eu.anthropic.claude-sonnet-5-v1:0' };
    expect(resultValuesMayReachModel(bedrock, () => false)).toBe(false);
    expect(resultValuesMayReachModel({ id: 'ollama', name: 'ollama' }, () => true)).toBe(true);
    setHostModelHooks({ isInBoundary: (model) => model.model?.startsWith('eu.') === true });
    expect(resultValuesMayReachModel(bedrock, () => false)).toBe(true);
    expect(resultValuesMayReachModel({ ...bedrock, model: 'global.anthropic.claude-sonnet-5' }, () => true)).toBe(false);
    setHostModelHooks({ isInBoundary: () => { throw new Error('boom'); } });
    expect(resultValuesMayReachModel(bedrock, () => true)).toBe(false);
  });

  it('tells the boundary rule which tables the values came from, when ZLens knows them all', () => {
    const bedrock = { id: 'anthropic', name: 'claude', model: 'eu.anthropic.claude-sonnet-5-v1:0' };
    const seen: Array<string[] | undefined> = [];
    setHostModelHooks({ isInBoundary: (_model, context) => { seen.push(context?.relations); return !context?.relations?.includes('claims.patients'); } });
    expect(resultValuesMayReachModel(bedrock, () => false, { relations: ['claims.payments'] })).toBe(true);
    expect(resultValuesMayReachModel(bedrock, () => false, { relations: ['claims.patients', 'claims.payments'] })).toBe(false);
    expect(resultValuesMayReachModel(bedrock, () => false)).toBe(true);
    expect(seen).toEqual([['claims.payments'], ['claims.patients', 'claims.payments'], undefined]);
  });
});

describe('where a run\'s values came from (HH-5)', () => {
  it('lists every table a run read, or nothing when one statement cannot be read', async () => {
    const { relationsOfStatements } = await import('./row-policy.js');
    expect(relationsOfStatements(['SELECT region, SUM(paid) FROM claims.payments GROUP BY 1', 'SELECT * FROM claims.patients p JOIN claims.payments x ON p.id = x.patient_id'], 'duckdb'))
      .toEqual(['claims.patients', 'claims.payments']);
    expect(relationsOfStatements(['SELECT 1'], 'duckdb')).toBeUndefined();
    expect(relationsOfStatements([undefined], 'duckdb')).toBeUndefined();
    expect(relationsOfStatements([], 'duckdb')).toEqual([]);
  });

  it('draws a story\'s tables from every tile it binds to', async () => {
    const { storyValueRelations } = await import('../local-runtime.js');
    const catalog = { paid: { tileId: 'paid' }, count: { tileId: 'count' } } as never;
    expect(storyValueRelations(catalog, { paid: ['claims.payments'], count: ['claims.claims', 'claims.payments'] }))
      .toEqual({ relations: ['claims.claims', 'claims.payments'] });
    expect(storyValueRelations(catalog, { paid: ['claims.payments'], count: null })).toBeUndefined();
    expect(storyValueRelations(catalog, { paid: ['claims.payments'] })).toBeUndefined();
    expect(storyValueRelations(catalog, undefined)).toBeUndefined();
  });
});

describe('one place every tool runs (RFC 0010 HH-7)', () => {
  it('passes each tool call to the host with the person asking, and only with a host', async () => {
    const { runGatedTool } = await import('@zlens/agent');
    const calls: Array<{ name: string; principal: string | null }> = [];
    await start({
      ...headerHost,
      tools: async (call, next) => {
        calls.push({ name: call.name, principal: call.principal?.id ?? null });
        if (call.name === 'run_sql') throw new Error('SQL tools are off for this workspace.');
        return next();
      },
    });
    const catalog = { name: 'search_catalog', run: async () => ['orders'] };
    const sql = { name: 'run_sql', run: async () => [{ n: 1 }] };
    await withRequestContext({ principal: PEOPLE.maria!, requestId: 'r' }, async () => {
      expect(await runGatedTool(catalog, {})).toEqual(['orders']);
      await expect(runGatedTool(sql, {})).rejects.toThrow('SQL tools are off');
    });
    expect(calls).toEqual([{ name: 'search_catalog', principal: 'u-maria' }, { name: 'run_sql', principal: 'u-maria' }]);

    await start();
    expect(await runGatedTool(sql, {})).toEqual([{ n: 1 }]);
  });

  it('has no tool run outside the gate', async () => {
    const { readdirSync, readFileSync: read, statSync } = await import('node:fs');
    const { dirname: dir, join: joinPath, relative, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repo = resolve(dir(fileURLToPath(import.meta.url)), '../../../..');
    const files: string[] = [];
    const walk = (at: string) => {
      for (const name of readdirSync(at)) {
        const path = joinPath(at, name);
        if (statSync(path).isDirectory()) { if (name !== 'node_modules' && name !== 'dist') walk(path); }
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) files.push(path);
      }
    };
    walk(joinPath(repo, 'apps/cli/src'));
    walk(joinPath(repo, 'packages/dql-agent/src'));
    const ungated = files
      .filter((file) => /\b(tool|finish|terminalTool)\.run\(/.test(read(file, 'utf-8')))
      .map((file) => relative(repo, file).replaceAll('\\', '/'))
      .sort();
    // The gate itself, and wrappers that decorate a tool inside a gated call;
    // `zlens agent eval` replays cassettes in the CLI, not the server.
    expect(ungated).toEqual([
      'apps/cli/src/commands/agent-eval-cassette.ts',
      'apps/cli/src/llm/answer-loop-tools.ts',
      'packages/dql-agent/src/agentic/ledger-tools.ts',
      'packages/dql-agent/src/agentic/tool-gate.ts',
    ]);
  });
});

describe('host links in DQL\'s rail and menu (HH-9)', () => {
  it('keeps up to 12 of each, in the host\'s order, so a full menu never pushes a rail link out', () => {
    const menu = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, placement: 'menu' }));
    const nav = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, placement: 'nav' }));
    const kept = capHostLinksByPlacement([...menu.slice(0, 7), ...nav, ...menu.slice(7)], 12);
    expect(kept.filter((link) => link.placement === 'nav').map((link) => link.id)).toEqual(nav.map((link) => link.id));
    expect(kept.filter((link) => link.placement === 'menu').map((link) => link.id)).toEqual(menu.slice(0, 12).map((link) => link.id));
  });
});

describe('a host\'s reshaping of DQL\'s rail and the person\'s role (HH-9 `nav`, `roleLabel`)', () => {
  it('passes known nav ids, plain labels and same-origin actions through, in the host\'s order', () => {
    const { nav, roleLabel } = safeHostUiExtras({
      roleLabel: '  Steward \n ',
      nav: {
        labels: { blocks: 'Blocks', 'ask-traces': 'Ask  traces', unknown: 'X', settings: '' },
        hidden: ['notebooks', 'notebooks', 'nope'],
        groups: [
          { id: 'insights', label: 'Insights', items: ['apps', 'ask', 'nope'] },
          { id: 'build', label: 'Build', items: ['blocks', 'lineage', 'apps'], action: { label: 'My draft spaces', href: '/e/drafts' } },
          { id: 'elsewhere', label: 'Elsewhere', items: ['settings'], action: { label: 'Away', href: 'https://example.com' } },
          { id: '', label: 'No id', items: ['modeling'] },
        ],
      },
    });
    expect(roleLabel).toBe('Steward');
    expect(nav).toEqual({
      labels: { blocks: 'Blocks', 'ask-traces': 'Ask traces' },
      hidden: ['notebooks'],
      groups: [
        { id: 'insights', label: 'Insights', items: ['apps', 'ask'] },
        // An item is in one group only (the first that names it); an action that is not same-origin is dropped.
        { id: 'build', label: 'Build', items: ['blocks', 'lineage'], action: { label: 'My draft spaces', href: '/e/drafts' } },
        { id: 'elsewhere', label: 'Elsewhere', items: ['settings'] },
      ],
    });
  });

  it('leaves both out when the host sends nothing usable', () => {
    expect(safeHostUiExtras({})).not.toHaveProperty('nav');
    expect(safeHostUiExtras({})).not.toHaveProperty('roleLabel');
    expect(safeHostUiExtras({ nav: 'all', roleLabel: 7 })).not.toHaveProperty('nav');
    expect(safeHostUiExtras({ nav: { labels: { nope: 'X' }, hidden: 'apps', groups: [] } })).not.toHaveProperty('nav');
    expect(safeHostUiExtras({ nav: 'all' })).not.toHaveProperty('roleLabel');
  });
});
