import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import { knowledgeServersFor } from './knowledge-sources.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';

/**
 * The host-hook contract: RFC 0010 is the contract a host author reads. It must list every hook and field
 * of `DqlHostHooks` (and of the `ui` answer) once, with a default, and each documented default must be what ZLens does
 * when the hook is absent. The hook types are read from request-context.ts and row-policy.ts, the RFC from
 * docs/rfcs/0010-host-hooks.md; nothing is listed by hand except the RFC's own wording of each default, which the
 * behavioural checks below quote.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const rfc = readFileSync(join(repo, 'docs/rfcs/0010-host-hooks.md'), 'utf8');
const contextSource = readFileSync(join(here, 'request-context.ts'), 'utf8');
const rowPolicySource = readFileSync(join(here, 'row-policy.ts'), 'utf8');

/** The top-level members of `export interface <name> { ... }` in a TypeScript source (comments skipped). */
function interfaceMembers(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`interface ${name} not found`);
  let depth = 0;
  let body = '';
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '{') depth += 1;
    if (char === '}') { depth -= 1; if (depth === 0) break; }
    body += char;
  }
  const members: string[] = [];
  let level = 0;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
    const trimmed = line.trim();
    if (level === 1 && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) {
      const match = /^(?:readonly\s+)?([A-Za-z_]\w*)\??\s*[:(]/.exec(trimmed);
      if (match) members.push(match[1]!);
    }
    for (const char of line) {
      if (char === '{' || char === '(' || char === '[') level += 1;
      if (char === '}' || char === ')' || char === ']') level -= 1;
    }
  }
  return [...new Set(members)];
}

/** The ```ts block of the RFC that declares `interface <name>`, and the members it lists. */
function rfcInterfaceMembers(name: string): string[] {
  const blocks = [...rfc.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const block = blocks.find((text) => text.includes(`interface ${name} {`));
  if (!block) return [];
  return interfaceMembers(block.replace(`interface ${name} {`, `export interface ${name} {`), name);
}

/** The first column of the "Local defaults (no hooks)" table, each backticked name. */
function rfcDefaultsTable(): Map<string, string> {
  const section = rfc.slice(rfc.indexOf('### Local defaults'), rfc.indexOf('### Rules every hook follows'));
  const rows = new Map<string, string>();
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4 || cells[1] === 'Hook or field' || /^-+$/.test(cells[1] ?? '')) continue;
    for (const name of cells[1]!.matchAll(/`([A-Za-z_.*]+)`/g)) rows.set(name[1]!.replace(/\.\*$/, ''), cells[2]!);
  }
  return rows;
}

describe('RFC 0010 lists every hook and field once, with a default', () => {
  const hooks = interfaceMembers(contextSource, 'DqlHostHooks');
  const uiFields = interfaceMembers(contextSource, 'DqlHostUi');

  it('reads the hook types (guards the parser)', () => {
    expect(hooks.length).toBeGreaterThanOrEqual(30);
    expect(hooks).toEqual(expect.arrayContaining(['resolvePrincipal', 'authorize', 'rowPolicy', 'stores', 'purposeAttributes', 'keepsAnswerText', 'figuresDependOnReader', 'columnsVisible', 'statements', 'traceSalt']));
    expect(uiFields).toEqual(expect.arrayContaining(['signOutUrl', 'links', 'answerActions', 'environment', 'banner', 'audience', 'appNotFound', 'certification']));
  });

  it('the RFC\'s DqlHostHooks block lists every hook in request-context.ts, and nothing that is not there', () => {
    const listed = rfcInterfaceMembers('DqlHostHooks');
    expect(hooks.filter((hook) => !listed.includes(hook)), 'hooks missing from the RFC block').toEqual([]);
    expect(listed.filter((hook) => !hooks.includes(hook)), 'RFC hooks that do not exist').toEqual([]);
  });

  it('every hook has a row in the defaults table, and the table names no hook that does not exist', () => {
    const table = rfcDefaultsTable();
    expect(hooks.filter((hook) => !table.has(hook)), 'hooks without a documented default').toEqual([]);
    expect([...table.keys()].filter((name) => !hooks.includes(name)), 'defaults for hooks that do not exist').toEqual([]);
  });

  it('the RFC\'s ui answer lists every DqlHostUi field', () => {
    const open = rfc.indexOf('ui?(principal: DqlPrincipal): Promise<{');
    const block = rfc.slice(open, rfc.indexOf('\n  }>;', open));
    expect(uiFields.filter((field) => !new RegExp(`\\b${field}\\??:`).test(block)), 'ui fields missing from the RFC').toEqual([]);
  });

  it('the RFC\'s rowPolicy answer names every field ZLens reads (sql, params, groupRows, refuse) and its query context every field ZLens passes', () => {
    const resultFields = ['sql', 'params', 'groupRows', 'refuse'];
    const rfcRow = /rowPolicy\?\(query: DqlQueryContext\): Promise<([^\n]*)>;/.exec(rfc)?.[1] ?? '';
    expect(resultFields.filter((field) => !rfcRow.includes(field))).toEqual([]);
    expect(rowPolicySource).toContain('export type DqlRowPolicyResult = { sql: string; params?: unknown[]; groupRows?: DqlGroupRowsCheck } | { refuse: string };');
    const contextFields = interfaceMembers(rowPolicySource, 'DqlQueryContext');
    // The RFC names the query context's fields in prose (HH-3 "What the policy is told", HH-17 destination/action).
    const told = rfc.slice(rfc.indexOf('**What the policy is told:**'), rfc.indexOf('**Refusals:**', rfc.indexOf('**What the policy is told:**')));
    const prose = { principal: /person/, sql: /SQL/, params: /values/, relations: /tables/, connection: /connection/, purpose: /purpose/ } as Record<string, RegExp>;
    const missing = contextFields.filter((field) => (prose[field] ? !prose[field]!.test(told) : !rfc.includes(`DqlQueryContext.${field}`) && !new RegExp(`\\*\\*\`${field}\`\\*\\*`).test(rfc)));
    expect(missing, 'query context fields the RFC does not describe').toEqual([]);
  });

  it('the RFC\'s DqlPrincipal and DqlRequestContext match the code (source values, optional fields, appGrants)', () => {
    const principalFields = interfaceMembers(contextSource, 'DqlPrincipal');
    const rfcPrincipal = rfcInterfaceMembers('DqlPrincipal');
    expect.soft(principalFields.filter((field) => !rfcPrincipal.includes(field)), 'DqlPrincipal fields missing from the RFC block').toEqual([]);
    const rfcSource = /source: ([^;]+);/.exec(rfc.slice(rfc.indexOf('export interface DqlPrincipal')))?.[1] ?? '';
    const codeSource = /source: ([^;]+);/.exec(contextSource.slice(contextSource.indexOf('export interface DqlPrincipal')))?.[1] ?? '';
    expect.soft(rfcSource.replace(/\s/g, ''), 'the values of `source`').toBe(codeSource.replace(/\s/g, ''));
    const rfcContext = rfc.slice(rfc.indexOf('export interface DqlRequestContext'), rfc.indexOf('}', rfc.indexOf('export interface DqlRequestContext')));
    expect.soft(rfcContext, 'the RFC says a request context always has a principal; the code makes it optional').toMatch(/principal\?:/);
  });
});

// ── Each documented default, against what ZLens does without the hook ──

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(hostHooks?: Partial<DqlHostHooks>, setup?: (projectRoot: string) => void) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-rfc-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'host_rfc' }));
  setup?.(projectRoot);
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, connection: { driver: 'file' } as ConnectionConfig, preferredPort: 0,
    ...(hostHooks ? { hostHooks: hostHooks as DqlHostHooks } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: response.status, text, body: parsed };
  };
  return { call, projectRoot };
}

const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@example.test', source: 'host' };

describe('each documented default is what ZLens does without the hook', () => {
  // The RFC's row states both defaults: no host is the local owner; a host without resolvePrincipal places no one.
  // This checks each documented default against what ZLens does.
  it('resolvePrincipal — "No host: the local owner"; "A host without it: no one is placed"', async () => {
    const row = rfcDefaultsTable().get('resolvePrincipal') ?? '';
    expect(row).toMatch(/No host: the local owner from `resolveLocalOwner`/);
    expect(row).toMatch(/A host without it: no one is placed, so nothing personal is read or kept/);
    const plain = await serve();
    const noHost = await plain.call('GET', '/api/identity');
    expect(noHost.status).toBe(200);
    expect(noHost.body.owner, 'no hooks: the local owner').toBeTruthy();
    // A host that supplies other hooks but no resolvePrincipal (for example only a row policy).
    const partial = await serve({ statements: () => undefined });
    await partial.call('POST', '/api/agent/threads', { title: 'Mine', surface: 'ask' });
    const listed = await partial.call('GET', '/api/agent/threads');
    expect((listed.body?.threads ?? []).length, 'with hooks but no resolvePrincipal nothing personal is kept or listed').toBe(0);
  });

  it('authorize — every placed person may do everything', async () => {
    const { call } = await serve({ resolvePrincipal: () => priya });
    expect((await call('POST', '/api/agent/threads', { title: 'x', surface: 'ask' })).status).toBe(201);
    expect((await call('GET', '/api/host/ui')).body.capabilities).toEqual(expect.objectContaining({ ask: true, 'dataset.certify': true, 'settings.manage': true }));
  });

  it('ui — no host: { host: false }; a host and no field: no links, actions, banner or sign-out', async () => {
    expect((await (await serve()).call('GET', '/api/host/ui')).body).toEqual({ host: false });
    const hosted = (await (await serve({ resolvePrincipal: () => priya })).call('GET', '/api/host/ui')).body;
    expect(hosted).toMatchObject({ host: true, links: [], answerActions: [] });
    expect(hosted.banner).toBeUndefined();
    expect(hosted.signOutUrl).toBeUndefined();
    expect(hosted.audience).toBeUndefined();
    expect(hosted.appNotFound).toBeUndefined();
    expect(hosted.certification).toBeUndefined();
  });

  it('homeCards — none; directoryGroups — the author types group names; answerStatus — no status', async () => {
    const { call } = await serve({ resolvePrincipal: () => priya });
    expect((await call('GET', '/api/host/home-cards')).body).toEqual({ cards: [] });
    expect((await call('GET', '/api/host/groups')).body).toEqual({ source: 'free_text' });
    expect((await call('POST', '/api/host/answer-status', { runIds: ['r1'] })).body).toEqual({ statuses: {} });
  });

  it('follows — the person\'s own file in .dql/local/private/home/', async () => {
    const { call, projectRoot } = await serve({ resolvePrincipal: () => priya }, (root) => {
      mkdirSync(join(root, 'apps', 'claims'), { recursive: true });
      writeFileSync(join(root, 'apps', 'claims', 'dql.app.json'), JSON.stringify({ version: 1, id: 'claims', name: 'Claims', description: 'Claims', visibility: 'shared', domain: 'claims', lifecycle: 'draft', owners: ['t@example.test'] }));
    });
    expect((await call('POST', '/api/apps/claims/follow', { following: true })).status).toBe(200);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(projectRoot, '.dql', 'local', 'private', 'home')).length).toBeGreaterThan(0);
  });

  it('knowledgeSources — the RFC table says "None"; without a host ZLens reads the project\'s .dql/mcp-servers.json', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-rfc-knowledge-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, '.dql'), { recursive: true });
    writeFileSync(join(projectRoot, '.dql', 'mcp-servers.json'), JSON.stringify({ servers: [{ name: 'docs', url: 'http://127.0.0.1:9/mcp', use: ['knowledge'], enabled: true, trusted: true }] }));
    const servers = await knowledgeServersFor({ projectRoot, hooks: undefined, principal: undefined });
    expect(servers.map((server) => server.id), 'the project file is read without a host (guards this check)').toEqual(['docs']);
    const table = rfcDefaultsTable().get('knowledgeSources') ?? '';
    // The table must not say "None" while ZLens reads the project file without a host.
    expect.soft(servers.length === 0 || !/^None$/.test(table), `table says "${table}", ZLens reads ${servers.length} project server(s) without a host`).toBe(true);
  });

  it('enterpriseCertification — the table says "the request\'s own choice"; with a host and no field the request\'s choice is ignored', () => {
    const table = rfcDefaultsTable().get('enterpriseCertification') ?? '';
    const runtime = readFileSync(join(here, '../local-runtime.ts'), 'utf8');
    const hostDecides = runtime.includes('enterprise: hostIdentity ? hostHooks?.enterpriseCertification === true : body.enterprise === true');
    expect(hostDecides).toBe(true);
    expect.soft(/host/i.test(table), `the table's default ("${table}") does not say a host without the field certifies without the enterprise gates`).toBe(true);
  });
});
