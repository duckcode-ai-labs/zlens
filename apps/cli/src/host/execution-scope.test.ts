import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionPoolManager, QueryExecutor, createConnectionConfigKey, type ConnectionConfig } from '@zlens/connectors';
import { clearCatalogTableRowCache, resolveSemanticTableMapping, startLocalServer } from '../local-runtime.js';
import { SHARED_EXECUTION_SCOPE, executionScopeFor, executionScopeOf, scopedKey, setBounded } from './execution-scope.js';
import { withRequestContext, withServerScope, type DqlPrincipal } from './request-context.js';
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

  it('is never shared for an executor that cannot say, once a credentials hook signs people in', async () => {
    const result = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
    const bare = () => ({ executePositional: async () => result, executeQuery: async () => result, getConnector: async () => ({}) }) as unknown as QueryExecutor;
    const credentials: DqlCredentialsHook = ({ principal }) => (principal ? { connection: { token: `token-of-${principal.id}` }, identity: principal.id } : { connection: {} });

    // The executor underneath the hook, asked directly: it runs on nobody's connection in particular.
    const inner = bare();
    const hooked = withHostQueryHooks(inner, { credentials });
    const direct = await as('maria', () => executionScopeFor(inner, service));
    expect(direct).toMatch(/^unknown-/);
    expect(direct).not.toBe(await as('maria', () => executionScopeFor(hooked, service)));
    // A scope of its own every time: nothing kept under it is found again, by this person or anyone.
    expect(await as('maria', () => executionScopeFor(inner, service))).not.toBe(direct);
    expect(await as('dev', () => executionScopeFor(inner, service))).toMatch(/^unknown-/);
    expect(await executionScopeFor(inner, service)).toMatch(/^unknown-/);
    expect(scopedKey('columns', direct)).not.toBe('columns');

    // A wrapper that forgets to pass the resolver on, on a server whose host set the hook.
    const forgetful = { executePositional: hooked.executePositional, executeQuery: hooked.executeQuery, getConnector: hooked.getConnector };
    const onServer = <T>(hooks: { credentials?: DqlCredentialsHook }, work: () => T): T => withServerScope({ id: `server-${Math.random()}`, hooks }, work);
    expect(await onServer({ credentials }, () => as('maria', () => executionScopeFor(forgetful, service)))).toMatch(/^unknown-/);
    expect(await onServer({ credentials }, () => executionScopeFor(undefined, service))).toMatch(/^unknown-/);
    expect(await withRequestContext({ principal: person('maria'), requestId: 'named-hooks', hooks: { credentials } }, () => executionScopeFor(bare(), service))).toMatch(/^unknown-/);
    // The executor that can say still says: the person's scope, the same on every request.
    const marias = await onServer({ credentials }, () => as('maria', () => executionScopeFor(hooked, service)));
    expect(marias).toMatch(/^person-/);
    expect(await onServer({ credentials }, () => as('maria', () => executionScopeFor(hooked, service)))).toBe(marias);

    // No credentials hook anywhere: shared, as before (no host, or a host that signs nobody in).
    expect(await executionScopeFor(bare(), service)).toBe(SHARED_EXECUTION_SCOPE);
    expect(await onServer({}, () => as('maria', () => executionScopeFor(bare(), service)))).toBe(SHARED_EXECUTION_SCOPE);
    const policyOnly = bare();
    withHostQueryHooks(policyOnly, { hosted: true, rowPolicy: (query) => ({ sql: query.sql }) });
    expect(await executionScopeFor(policyOnly, service)).toBe(SHARED_EXECUTION_SCOPE);
    // No connection: nothing was seen through one.
    expect(await onServer({ credentials }, () => executionScopeFor(forgetful, undefined))).toBe(SHARED_EXECUTION_SCOPE);
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

describe('a session the host supplies, through the host\'s hook', () => {
  const result = { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 };
  const sessionOf = (owner: string, ran: string[]) => ({
    driverName: 'snowflake' as const,
    connect: async () => { throw new Error('never connected by ZLens'); },
    execute: async (sql: string) => { ran.push(`${owner}: ${sql}`); return result; },
    disconnect: async () => { ran.push(`${owner}: ENDED`); },
    abandon: async () => { ran.push(`${owner}: ABANDONED`); },
    ping: async () => true,
  });

  it('rides on the connection only from `session`, needs an identity, and is not part of the scope', async () => {
    const provider = () => undefined;
    const hook: DqlCredentialsHook = ({ principal }) => ({ connection: { warehouse: 'PEOPLE_WH' }, identity: `user:${principal?.id}`, session: provider });
    const maria = await as('maria', () => resolvePersonConnection(hook, service));
    expect(maria.hostSession).toBe(provider);
    // Never from the overlay or from the project's own settings.
    const smuggled = await as('maria', () => resolvePersonConnection(() => ({ connection: { hostSession: provider } as Partial<ConnectionConfig>, identity: 'user:maria' }), { ...service, hostSession: provider }));
    expect('hostSession' in smuggled).toBe(false);
    // Without an identity nothing says whose session it is: refused, as any unusable answer is.
    for (const identity of [undefined, '', '  ']) {
      await expect(resolvePersonConnection(() => ({ connection: {}, ...(identity === undefined ? {} : { identity }), session: provider }), service)).rejects.toBeInstanceOf(CredentialsRefusedError);
    }
    for (const session of ['a session', 7, {}, true]) {
      await expect(resolvePersonConnection(() => ({ connection: {}, identity: 'user:maria', session } as never), service)).rejects.toBeInstanceOf(CredentialsRefusedError);
    }
    // The scope is the identity's, with or without a supplied session and whichever closure supplies it.
    const named: DqlCredentialsHook = ({ principal }) => ({ connection: { warehouse: 'PEOPLE_WH' }, identity: `user:${principal?.id}` });
    const without = await as('maria', () => resolvePersonConnection(named, service));
    const again = await as('maria', () => resolvePersonConnection(({ principal }) => ({ connection: { warehouse: 'PEOPLE_WH' }, identity: `user:${principal?.id}`, session: () => null }), service));
    const dev = await as('dev', () => resolvePersonConnection(hook, service));
    expect(executionScopeOf(service, maria)).toBe(executionScopeOf(service, without));
    expect(executionScopeOf(service, maria)).toBe(executionScopeOf(service, again));
    expect(executionScopeOf(service, maria)).not.toBe(executionScopeOf(service, dev));
    expect(executionScopeOf(service, maria)).not.toBe(SHARED_EXECUTION_SCOPE);
  });

  it('gives each person their own session across two pools that never sign in; no session fails the statement and its scope is nobody else\'s', async () => {
    const ran: string[] = [];
    const sessions = new Map<string, ReturnType<typeof sessionOf>>([['maria', sessionOf('maria', ran)], ['dev', sessionOf('dev', ran)]]);
    const hooks = { credentials: (({ principal }) => (principal ? { connection: { password: undefined }, identity: `user:${principal.id}`, session: () => sessions.get(principal.id) } : { refuse: 'Nobody is asking.' })) as DqlCredentialsHook };
    const pools = [new ConnectionPoolManager(), new ConnectionPoolManager()];
    for (const pool of pools) (pool as unknown as { createConnector(): never }).createConnector = () => { throw new Error('The pool tried to sign in by itself.'); };
    const [first, second] = pools.map((pool) => withHostQueryHooks(new QueryExecutor(pool), hooks));
    await as('maria', () => first!.executePositional('SELECT 1', [], service));
    await as('dev', () => second!.executePositional('SELECT 2', [], service));
    await as('maria', () => second!.executePositional('SELECT 3', [], service));
    await as('dev', () => first!.executePositional('SELECT 4', [], service));
    expect(ran).toEqual(['maria: SELECT 1', 'dev: SELECT 2', 'maria: SELECT 3', 'dev: SELECT 4']);
    // The scope each statement ran in is its person's, the same from either pool.
    const scope = (id: string, executor: unknown) => as(id, () => executionScopeFor(executor, service));
    expect(await scope('maria', first)).toBe(await scope('maria', second));
    expect(await scope('maria', first)).not.toBe(await scope('dev', first));
    expect(await scope('maria', first)).not.toBe(SHARED_EXECUTION_SCOPE);
    // The host has no session for someone: their statement fails, by type, and runs on nobody's session.
    sessions.delete('dev');
    const failure = await as('dev', () => first!.executePositional('SELECT 5', [], service)).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe('SESSION_SIGN_IN_FAILED');
    await as('ana', () => second!.executePositional('SELECT 6', [], service)).then(() => { throw new Error('It ran.'); }, (error: { code?: string }) => expect(error.code).toBe('SESSION_SIGN_IN_FAILED'));
    // With nobody asking, the hook refuses: nothing runs, and the scope is unknown, never shared.
    await expect(first!.executePositional('SELECT 7', [], service)).rejects.toBeInstanceOf(CredentialsRefusedError);
    expect(await executionScopeFor(first, service)).toMatch(/^unknown-/);
    expect(ran).toHaveLength(4);
    // Shutting both pools down ends nothing of the host's.
    for (const pool of pools) await pool.disconnectAll();
    expect(ran.filter((line) => line.endsWith('ENDED') || line.endsWith('ABANDONED'))).toEqual([]);
  });
});

describe('the identity a host names stays out of logs and errors', () => {
  const IDENTITY = 'warehouse-user:MARIA_7731|role:FINANCE_EU';
  const logged: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => { logged.push(parts.map((part) => (part instanceof Error ? `${part.message}\n${part.stack ?? ''}` : typeof part === 'string' ? part : JSON.stringify(part))).join(' ')); }));
  afterEach(() => { logged.length = 0; });
  const text = (error: unknown): string => (error instanceof Error ? [error.message, error.stack ?? '', JSON.stringify(error, Object.getOwnPropertyNames(error)), String((error as { cause?: unknown }).cause ?? '')].join('\n') : String(error));
  const failure = async (work: () => Promise<unknown>): Promise<unknown> => work().then(() => { throw new Error('expected a failure'); }, (error: unknown) => error);

  it('whether the sign-in fails, the statement fails, the policy refuses or the hook itself throws', async () => {
    expect(spies).toHaveLength(5);
    const configs: ConnectionConfig[] = [];
    const pool = new ConnectionPoolManager();
    let refuseSignIn = true;
    (pool as unknown as { createConnector(config: ConnectionConfig): unknown }).createConnector = () => ({
      driverName: 'snowflake',
      // A driver that quotes its settings when it fails, as some do.
      connect: async (config: ConnectionConfig) => { configs.push(config); if (refuseSignIn) throw new Error(`could not sign in with ${JSON.stringify({ ...config, token: undefined, password: undefined })}`); },
      execute: async (sql: string) => { if (sql.includes('missing_table')) throw new Error('SQL compilation error: Object MISSING_TABLE does not exist or not authorized.'); return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }; },
      disconnect: async () => undefined,
      ping: async () => true,
    });
    const credentials: DqlCredentialsHook = ({ principal }) => {
      if (principal?.id === 'broken') throw new Error(`no token for ${IDENTITY}`);
      if (principal?.id === 'odd') return { connection: { token: 'odd-token' }, identity: { name: IDENTITY } } as never;
      return principal ? { connection: { token: `${principal.id}-token`, password: undefined, authMethod: 'oauth' }, identity: IDENTITY } : { connection: {} };
    };
    const executor = withHostQueryHooks(new QueryExecutor(pool), { hosted: true, credentials, rowPolicy: (query) => (query.sql.includes('forbidden') ? { refuse: 'You may not read that.' } : { sql: query.sql }) });
    const seen: string[] = [];
    // The sign-in fails, with the driver quoting the connection it was given.
    seen.push(text(await failure(() => as('maria', () => executor.executePositional('SELECT 1', [], service)))));
    refuseSignIn = false;
    await as('maria', () => executor.executePositional('SELECT 1', [], service));
    // The warehouse refuses the statement; the policy refuses one; the hook throws; the hook names a non-name.
    seen.push(text(await failure(() => as('maria', () => executor.executePositional('SELECT * FROM missing_table', [], service)))));
    seen.push(text(await failure(() => as('maria', () => executor.executePositional('SELECT forbidden', [], service)))));
    seen.push(text(await failure(() => as('broken', () => executor.executePositional('SELECT 1', [], service)))));
    seen.push(text(await failure(() => as('odd', () => executor.executePositional('SELECT 1', [], service)))));
    // A caller that keeps the connector.
    const connector = await as('maria', () => executor.getConnector(service));
    seen.push(text(await failure(() => as('maria', () => connector.execute('SELECT * FROM missing_table')))));
    expect(seen).toHaveLength(6);

    // What ZLens derived from the identity: the connection's digest, the pool's key, the cache scope.
    expect(configs.length).toBeGreaterThan(1);
    const digests = new Set(configs.map((config) => config.executionIdentity));
    expect(digests.size).toBe(1);
    const derived = [...digests, ...configs.map((config) => createConnectionConfigKey(config)), ...configs.map((config) => JSON.stringify(config)), await as('maria', () => executionScopeFor(executor, service))];
    for (const part of ['MARIA_7731', 'FINANCE_EU', 'warehouse-user', IDENTITY]) {
      for (const value of [...seen, ...logged, ...derived]) expect(value, `"${part}" in: ${String(value).slice(0, 200)}`).not.toContain(part);
    }
    // The statement's failure was logged for the operator, so the logs were really read.
    expect(logged.some((line) => line.includes('A statement failed on the warehouse'))).toBe(true);
    await pool.disconnectAll();
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
