import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlPrincipal } from './request-context.js';
import type { DqlRowPolicy } from './row-policy.js';

/**
 * RFC 0010: with a host, a block's last Block Studio run (its row count and columns, decided by the runner's row
 * rules) is the person's who ran it: kept in their own folder and shown back only to them. Without a host, the one
 * project-wide record as before.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', source: 'host' };
const mei: DqlPrincipal = { id: 'u-mei', kind: 'person', email: 'mei@harbor.example', attributes: { region: 'West' }, source: 'host' };
const BLOCK = 'block "claims" {\n  domain = "claims"\n  type = "custom"\n  query = """SELECT region FROM claims"""\n}\n';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(hosted: boolean, rowPolicy?: DqlRowPolicy) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-block-runs-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'runs', connections: { default: { driver: 'duckdb', filepath: ':memory:' } } }));
  mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  writeFileSync(join(projectRoot, 'blocks', 'claims.dql'), BLOCK);
  const rows = [{ region: 'West' }, { region: 'West' }, { region: 'West' }, { region: 'West' }, { region: 'West' }, { region: 'West' }, { region: 'West' }];
  const result = { columns: [{ name: 'region', type: 'VARCHAR' }], rows, rowCount: rows.length, executionTime: 1 };
  const executor = {
    // Like the real executor: expands, then runs through executePositional (where the host's row policy sits).
    async executeQuery(this: QueryExecutor, sql: string, _params: unknown, _variables: unknown, config: ConnectionConfig) { return this.executePositional(sql, [], config); },
    executePositional: async () => result,
  } as unknown as QueryExecutor;
  const people: Record<string, DqlPrincipal> = { priya, dan, mei };
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor, preferredPort: 0,
    ...(hosted ? { hostHooks: { resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null, ...(rowPolicy ? { rowPolicy } : {}) } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (person: string, method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-person': person }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
  };
  return { call, projectRoot };
}

describe('a block\'s last Block Studio run', () => {
  it('with a host, is kept for the person who ran it and shown only to them', async () => {
    const { call, projectRoot } = await serve(true);
    const ran = await call('priya', 'POST', '/api/block-studio/run', { source: BLOCK, path: 'blocks/claims.dql' });
    expect(ran.status, ran.text.slice(0, 300)).toBe(200);
    expect((await call('priya', 'GET', '/api/block-studio/open?path=blocks%2Fclaims.dql')).body.lastRun).toMatchObject({ rowCount: 7 });
    expect((await call('dan', 'GET', '/api/block-studio/open?path=blocks%2Fclaims.dql')).body.lastRun).toBeUndefined();
    expect(existsSync(join(projectRoot, '.dql', 'runs', 'block-studio'))).toBe(false);
    expect(readdirSync(join(projectRoot, '.dql', 'local', 'private', 'block-studio-runs'))).toHaveLength(1);
  });

  it('answers a refusal by the host\'s row policy as a 403 in its own words, not as a preview failure', async () => {
    // Seen live: a steward with no region attribute pressed Run and got "Preview failed" with a 500.
    const sentence = 'Your profile has no region, which claims needs to show you any rows. Ask an admin.';
    const policy: DqlRowPolicy = ({ principal, sql, purpose }) => {
      if (purpose === 'metadata' || principal === null) return { sql };
      return typeof principal.attributes?.region === 'string' ? { sql } : { refuse: sentence };
    };
    const { call, projectRoot } = await serve(true, policy);
    const refused = await call('priya', 'POST', '/api/block-studio/run', { source: BLOCK, path: 'blocks/claims.dql' });
    expect(refused.status, refused.text.slice(0, 300)).toBe(403);
    expect(refused.body).toEqual({ error: sentence, code: 'POLICY_DENIED' });
    expect(refused.body.friendlyMessage).toBeUndefined();
    expect(refused.body.recoverable).toBeUndefined();
    // No run happened, so no last-run record for them and nothing saved anywhere.
    expect((await call('priya', 'GET', '/api/block-studio/open?path=blocks%2Fclaims.dql')).body.lastRun).toBeUndefined();
    expect(existsSync(join(projectRoot, '.dql', 'local', 'private', 'block-studio-runs'))).toBe(false);
    // A person the policy lets through still runs as before.
    const ran = await call('mei', 'POST', '/api/block-studio/run', { source: BLOCK, path: 'blocks/claims.dql' });
    expect(ran.status, ran.text.slice(0, 300)).toBe(200);
  });

  it('without a host, is the one project-wide record as before', async () => {
    const { call, projectRoot } = await serve(false);
    expect((await call('', 'POST', '/api/block-studio/run', { source: BLOCK, path: 'blocks/claims.dql' })).status).toBe(200);
    expect((await call('', 'GET', '/api/block-studio/open?path=blocks%2Fclaims.dql')).body.lastRun).toMatchObject({ rowCount: 7 });
    expect(readdirSync(join(projectRoot, '.dql', 'runs', 'block-studio'))).toHaveLength(1);
  });
});
