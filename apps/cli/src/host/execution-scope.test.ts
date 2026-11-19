import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionPoolManager, QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { clearCatalogTableRowCache, resolveSemanticTableMapping, startLocalServer } from '../local-runtime.js';
import { SHARED_EXECUTION_SCOPE, executionScopeFor, executionScopeOf, scopedKey, setBounded } from './execution-scope.js';
import { withRequestContext, type DqlPrincipal } from './request-context.js';
import { CredentialsRefusedError, resolvePersonConnection, withHostQueryHooks, type DqlCredentialsHook } from './row-policy.js';

/**
 * Per-person warehouse sign-in: the host's `credentials` hook may say whose permissions the connection runs with
 * (`identity`). That identity keeps one warehouse session through token renewals, and it is the execution scope
 * every cache of something seen through the connection is held to.
 */
const service: ConnectionConfig = { driver: 'snowflake', account: 'acct', username: 'svc', password: 'service-password', warehouse: 'WH' };
const person = (id: string): DqlPrincipal => ({ id, kind: 'person', source: 'host' });
const as = <T>(id: string, work: () => T, requestId = `request-${id}-${Math.random()}`): T => withRequestContext({ principal: person(id), requestId }, work);

describe('the identity a credentials hook names', () => {
  it('rides on the connection as a digest, replaces nothing else, and never comes from the overlay or the project', async () => {
    const hook: DqlCredentialsHook = ({ principal }) => ({ connection: { token: 'tok', authMethod: 'oauth', executionIdentity: 'smuggled' } as Partial<ConnectionConfig>, identity: `user:${principal?.id}` });
    const maria = await as('maria', () => resolvePersonConnection(hook, service));
    const dev = await as('dev', () => resolvePersonConnection(hook, service));
    expect(maria).toMatchObject({ driver: 'snowflake', token: 'tok', authMethod: 'oauth', warehouse: 'WH' });
    // A digest: the host's name for the person is in no key, log line or error.
    expect(maria.executionIdentity).toMatch(/^id-[0-9a-f]{32}$/);
    expect(maria.executionIdentity).not.toContain('maria');
    expect(dev.executionIdentity).not.toBe(maria.executionIdentity);
    expect(await as('maria', () => resolvePersonConnection(hook, service))).toEqual(maria);
    // Without `identity` the connection carries none, whatever the overlay or the project's settings say.
    const unnamed = await resolvePersonConnection(() => ({ connection: { token: 'tok', executionIdentity: 'smuggled' } as Partial<ConnectionConfig> }), { ...service, executionIdentity: 'from-a-file' });
    expect('executionIdentity' in unnamed).toBe(false);
    // An empty name names nobody (it must never pool everyone together).
    expect('executionIdentity' in await resolvePersonConnection(() => ({ connection: { token: 'tok' }, identity: '  ' }), service)).toBe(false);
  });

  it('refuses an identity that is not a name', async () => {
    for (const identity of [7, { id: 'maria' }, ['maria'], true]) {
      const refusal = await resolvePersonConnection((() => ({ connection: { token: 'tok' }, identity })) as unknown as DqlCredentialsHook, service).then(() => undefined, (error: unknown) => error);
      expect(refusal, JSON.stringify(identity)).toBeInstanceOf(CredentialsRefusedError);
    }
  });
});

describe('the execution scope of a connection', () => {
  it('is shared for the configured connection, and one per identity or per credential otherwise', () => {
    expect(executionScopeOf(service, { ...service })).toBe(SHARED_EXECUTION_SCOPE);
    // An unnamed identity: everything the hook changed, the credential included.
    const first = executionScopeOf(service, { ...service, token: 't1' });
    expect(first).toMatch(/^person-[0-9a-f]{32}$/);
    expect(first).not.toContain('t1');
    expect(executionScopeOf(service, { ...service, token: 't1' })).toBe(first);
    expect(executionScopeOf(service, { ...service, token: 't2' })).not.toBe(first);
    // A role laid over the connection is who it runs as, though it is no credential.
    expect(executionScopeOf(service, { ...service, role: 'ANALYST' })).not.toBe(SHARED_EXECUTION_SCOPE);
    expect(executionScopeOf(service, { ...service, password: undefined })).not.toBe(SHARED_EXECUTION_SCOPE);
    // A named identity: the same scope whatever the token, another for another identity or another role.
    const maria = executionScopeOf(service, { ...service, token: 't1', executionIdentity: 'id-maria' });
    expect(executionScopeOf(service, { ...service, token: 't2', executionIdentity: 'id-maria' })).toBe(maria);
    expect(executionScopeOf(service, { ...service, token: 't1', executionIdentity: 'id-dev' })).not.toBe(maria);
    expect(executionScopeOf(service, { ...service, token: 't1', executionIdentity: 'id-maria', role: 'ADMIN' })).not.toBe(maria);
    expect(executionScopeOf(service, { ...service, executionIdentity: 'id-maria' })).toBe(maria);
    expect(maria).not.toBe(SHARED_EXECUTION_SCOPE);
  });

  it('is asked of the executor that runs the statement: shared without the hook, the person\'s with it', async () => {
    const inner = { executePositional: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }), executeQuery: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }), getConnector: async () => ({}) } as unknown as QueryExecutor;
    // No host, a host without the hook, no connection: shared, and nobody is asked.
    expect(await executionScopeFor(inner, service)).toBe(SHARED_EXECUTION_SCOPE);
    expect(await executionScopeFor(withHostQueryHooks(inner, { hosted: true, rowPolicy: (query) => ({ sql: query.sql }) }), service)).toBe(SHARED_EXECUTION_SCOPE);
    expect(await executionScopeFor(undefined, service)).toBe(SHARED_EXECUTION_SCOPE);
    let renewals = 0;
    const purposes: string[] = [];
    const hook = vi.fn<DqlCredentialsHook>(({ principal, purpose }) => {
      purposes.push(purpose);
      if (!principal) return { connection: {} };
      if (principal.id === 'locked-out') return { refuse: 'Reconnect.' };
      return { connection: { token: `token-${++renewals}` }, identity: principal.id };
    });
    const executor = withHostQueryHooks(inner, { credentials: hook });
    expect(await executionScopeFor(executor, undefined)).toBe(SHARED_EXECUTION_SCOPE);
    // Work nobody asked for runs on the configured connection.
    expect(await executionScopeFor(executor, service)).toBe(SHARED_EXECUTION_SCOPE);
    const maria = await as('maria', () => executionScopeFor(executor, service));
    expect(maria).toMatch(/^person-/);
    expect(await as('maria', () => executionScopeFor(executor, service))).toBe(maria);
    expect(await as('dev', () => executionScopeFor(executor, service))).not.toBe(maria);
    // Asked once per request, connection and purpose; the purpose is the statement's.
    hook.mockClear();
    purposes.length = 0;
    await as('maria', async () => {
      await executionScopeFor(executor, service);
      await executionScopeFor(executor, { ...service });
      await executionScopeFor(executor, service, 'metadata');
    }, 'one-request');
    expect(hook).toHaveBeenCalledTimes(2);
    expect(purposes).toEqual(['data', 'metadata']);
    // A hook that refuses or fails: a scope of the request's own, never the shared one and never another request's.
    const refused = await as('locked-out', async () => [await executionScopeFor(executor, service), await executionScopeFor(executor, service)], 'refused-1');
    expect(refused[0]).toMatch(/^unknown-/);
    expect(refused[1]).toBe(refused[0]);
    expect(await as('locked-out', () => executionScopeFor(executor, service), 'refused-2')).not.toBe(refused[0]);
    const failing = withHostQueryHooks(inner, { credentials: () => { throw new Error('vault down'); } });
    expect(await executionScopeFor(failing, service)).toMatch(/^unknown-/);
  });

  it('keeps the shared key as it was and bounds what scoped keys add', () => {
    expect(scopedKey('account=acct|database=DB', SHARED_EXECUTION_SCOPE)).toBe('account=acct|database=DB');
    expect(scopedKey('account=acct|database=DB', 'person-1')).not.toBe(scopedKey('account=acct|database=DB', 'person-2'));
    const map = new Map<string, number>();
    for (let index = 0; index < 10; index += 1) setBounded(map, `key-${index}`, index, 3);
    expect([...map.keys()]).toEqual(['key-7', 'key-8', 'key-9']);
    setBounded(map, 'key-7', 70, 3);
    expect([...map.entries()].at(-1)).toEqual(['key-7', 70]);
  });
});

describe('one warehouse session per identity, through the host\'s hook', () => {
  it('a token that renews on every statement signs in once; another person signs in on their own', async () => {
    const signIns: Array<{ token?: string; identity?: string }> = [];
    const ran: Array<{ session: number; sql: string }> = [];
    const pool = new ConnectionPoolManager();
    (pool as unknown as { createConnector(config: ConnectionConfig): unknown }).createConnector = () => {
      const session = signIns.length + 1;
      return {
        driverName: 'snowflake',
        connect: async (config: ConnectionConfig) => { signIns.push({ token: config.token, identity: config.executionIdentity }); },
        execute: async (sql: string) => { ran.push({ session, sql }); return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }; },
        disconnect: async () => undefined,
        ping: async () => true,
      };
    };
    let renewals = 0;
    const named = withHostQueryHooks(new QueryExecutor(pool), { credentials: ({ principal }) => (principal ? { connection: { token: `${principal.id}-token-${++renewals}`, password: undefined, authMethod: 'oauth' }, identity: `user:${principal.id}` } : { connection: {} }) });
    for (let statement = 0; statement < 4; statement += 1) await as('maria', () => named.executePositional(`SELECT ${statement}`, [], service));
    await as('dev', () => named.executePositional('SELECT 9', [], service));
    await named.executePositional('SELECT 10', [], service);
    expect(signIns.map((entry) => entry.token)).toEqual(['maria-token-1', 'dev-token-5', undefined]);
    expect(ran.map((entry) => entry.session)).toEqual([1, 1, 1, 1, 2, 3]);
    expect(signIns[0]!.identity).not.toContain('maria');
    await pool.disconnectAll();

    // The same host without `identity`: one session per credential, as before.
    signIns.length = 0;
    renewals = 0;
    const unnamedPool = new ConnectionPoolManager();
    (unnamedPool as unknown as { createConnector: unknown }).createConnector = (pool as unknown as { createConnector: unknown }).createConnector;
    const unnamed = withHostQueryHooks(new QueryExecutor(unnamedPool), { credentials: ({ principal }) => ({ connection: { token: `${principal?.id}-token-${++renewals}` } }) });
    for (let statement = 0; statement < 3; statement += 1) await as('maria', () => unnamed.executePositional(`SELECT ${statement}`, [], service));
    expect(signIns.map((entry) => entry.token)).toEqual(['maria-token-1', 'maria-token-2', 'maria-token-3']);
    await unnamedPool.disconnectAll();
  });
});

describe('the catalog listing behind a semantic table mapping', () => {
  const layer = { listMetrics: () => [{ table: 'main.orders' }], listDimensions: () => [], listMeasures: () => [], listSemanticModels: () => [] } as never;
  const connection = { driver: 'duckdb', filepath: ':memory:' } as ConnectionConfig;

  it('is kept per execution scope: each person maps the tables their own connection lists', async () => {
    const asked: string[] = [];
    const inner = {
      async executeQuery(this: { executePositional(sql: string, params: unknown[], config: ConnectionConfig): Promise<unknown> }, sql: string, _params: unknown, _variables: unknown, config: ConnectionConfig) { return this.executePositional(sql, [], config); },
      async executePositional(_sql: string, _params: unknown[], config: ConnectionConfig) {
        const who = config.token ?? 'service';
        asked.push(who);
        // Maria's role is shown no table; the others see the one the metric reads.
        return { columns: [], rowCount: 1, executionTimeMs: 0, rows: who === 'maria' ? [] : [{ table_schema: 'main', table_name: 'orders' }] };
      },
    } as unknown as QueryExecutor;
    const executor = withHostQueryHooks(inner, { credentials: ({ principal }) => (principal ? { connection: { token: principal.id }, identity: principal.id } : { connection: {} }) });
    const maria = await as('maria', () => resolveSemanticTableMapping(executor, connection, layer));
    const dev = await as('dev', () => resolveSemanticTableMapping(executor, connection, layer));
    const shared = await resolveSemanticTableMapping(executor, connection, layer);
    expect(maria ?? {}).toEqual({});
    expect(dev).toEqual({ 'main.orders': 'main.orders' });
    expect(shared).toEqual({ 'main.orders': 'main.orders' });
    expect(asked).toEqual(['maria', 'dev', 'service']);
    // Warm: each scope reuses its own listing, the shared one included.
    expect(await as('maria', () => resolveSemanticTableMapping(executor, connection, layer))).toEqual(maria);
    await resolveSemanticTableMapping(executor, connection, layer);
    expect(asked).toEqual(['maria', 'dev', 'service']);
    clearCatalogTableRowCache(executor);
  });
});

describe('a dbt model\'s columns, completed from the warehouse', () => {
  const servers: Server[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('are the ones each person\'s own connection shows', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-node-detail-scope-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify({
      metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json', project_name: 'shop', adapter_type: 'duckdb' },
      nodes: { 'model.shop.orders': { unique_id: 'model.shop.orders', resource_type: 'model', name: 'orders', package_name: 'shop', database: 'shop', schema: 'main', alias: 'orders', relation_name: '"shop"."main"."orders"', original_file_path: 'models/orders.sql', path: 'orders.sql', columns: {}, depends_on: { nodes: [] }, config: { materialized: 'table' }, tags: [], meta: {}, description: '' } },
      sources: {}, metrics: {}, semantic_models: {}, exposures: {}, macros: {}, parent_map: {}, child_map: {},
    }));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' }, dbt: { projectDir: '.', manifestPath: 'target/manifest.json' } }));
    const asked: string[] = [];
    const inner = {
      async executeQuery(this: { executePositional(sql: string, params: unknown[], config: ConnectionConfig): Promise<unknown> }, sql: string, _params: unknown, _variables: unknown, config: ConnectionConfig) { return this.executePositional(sql, [], config); },
      async executePositional(sql: string, _params: unknown[], config: ConnectionConfig) {
        if (!sql.includes('information_schema.columns')) return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
        const who = config.token ?? 'service';
        asked.push(who);
        const names = ['order_id', 'amount', `${who}_only_note`];
        return { columns: [], rowCount: names.length, executionTimeMs: 0, rows: names.map((name, index) => ({ table_schema: 'main', table_name: 'orders', column_name: name, data_type: 'VARCHAR', ordinal_position: index + 1 })) };
      },
      async getConnector() { throw new Error('not used'); },
      async disconnect() { /* nothing to close */ },
    } as unknown as QueryExecutor;
    const people: Record<string, DqlPrincipal> = { maria: person('maria'), dev: person('dev') };
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: inner,
      connection: { driver: 'duckdb', filepath: ':memory:' },
      preferredPort: 0,
      hostHooks: {
        resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
        credentials: ({ principal }) => (principal ? { connection: { token: principal.id }, identity: principal.id } : { connection: {} }),
      },
      captureServer: (created) => { servers.push(created); },
    });
    const columnsFor = async (who: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/modeling/dbt-first/nodes/model.shop.orders`, { headers: { 'x-test-person': who } });
      const body = await response.json() as { columns?: Array<{ name: string }> };
      expect(response.status, JSON.stringify(body).slice(0, 300)).toBe(200);
      return (body.columns ?? []).map((column) => column.name);
    };
    expect(await columnsFor('maria')).toEqual(['order_id', 'amount', 'maria_only_note']);
    // Within the same snapshot, Dev gets his own connection's columns, never Maria's.
    expect(await columnsFor('dev')).toEqual(['order_id', 'amount', 'dev_only_note']);
    // And each keeps their own for the next time.
    expect(await columnsFor('maria')).toEqual(['order_id', 'amount', 'maria_only_note']);
    expect(asked).toEqual(['maria', 'dev']);
  });
});
