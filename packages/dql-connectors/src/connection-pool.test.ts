import { describe, expect, it, vi } from 'vitest';
import { ConnectionPoolManager, createConnectionConfigKey } from './connection-pool.js';
import { QueryExecutor } from './query-executor.js';

describe('createConnectionConfigKey', () => {
  it('returns the same key for logically identical configs', () => {
    const a = {
      driver: 'snowflake' as const,
      account: 'acct',
      username: 'user',
      password: 'pw',
      database: 'db',
      warehouse: 'wh',
    };
    const b = {
      warehouse: 'wh',
      database: 'db',
      password: 'pw',
      username: 'user',
      account: 'acct',
      driver: 'snowflake' as const,
    };
    expect(createConnectionConfigKey(a)).toBe(createConnectionConfigKey(b));
  });

  it('returns different keys when config changes', () => {
    const a = {
      driver: 'snowflake' as const,
      account: 'acct',
      username: 'user',
      password: 'pw',
      database: 'db1',
      warehouse: 'wh',
    };
    const b = {
      ...a,
      database: 'db2',
    };
    expect(createConnectionConfigKey(a)).not.toBe(createConnectionConfigKey(b));
  });

  it('includes enterprise credential fields in the key', () => {
    const databricks = {
      driver: 'databricks' as const,
      host: 'adb-123.cloud.databricks.com',
      warehouse: 'prod-warehouse',
      token: 'prod-token',
    };
    expect(createConnectionConfigKey(databricks)).not.toBe(createConnectionConfigKey({
      ...databricks,
      token: 'staging-token',
    }));
    expect(createConnectionConfigKey(databricks)).not.toBe(createConnectionConfigKey({
      ...databricks,
      warehouse: 'staging-warehouse',
    }));
    expect(createConnectionConfigKey(databricks)).not.toBe(createConnectionConfigKey({
      ...databricks,
      httpPath: '/sql/1.0/warehouses/staging-warehouse',
    }));
    expect(createConnectionConfigKey(databricks)).not.toBe(createConnectionConfigKey({
      ...databricks,
      waitTimeout: '5s',
    }));

    const snowflake = {
      driver: 'snowflake' as const,
      account: 'xy12345.us-east-1',
      username: 'svc_dql',
      database: 'PROD',
      schema: 'MARTS',
      warehouse: 'ANALYTICS_WH',
      authMethod: 'key_pair' as const,
      privateKeyPath: '/secure/prod/snowflake_key.p8',
      privateKeyPassphrase: 'prod-passphrase',
    };
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      privateKeyPath: '/secure/staging/snowflake_key.p8',
    }));
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      privateKeyPath: undefined,
      privateKey: '-----BEGIN PRIVATE KEY-----\nstaging\n-----END PRIVATE KEY-----',
    }));
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      privateKeyPassphrase: 'staging-passphrase',
    }));
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      proxyHost: 'proxy.internal',
    }));
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      queryTag: 'team=finance',
    }));
    expect(createConnectionConfigKey(snowflake)).not.toBe(createConnectionConfigKey({
      ...snowflake,
      authMethod: 'workload_identity' as const,
      workloadIdentityProvider: 'AWS',
    }));
  });
});

describe('ConnectionPoolManager singleflight', () => {
  it('shares one in-flight connector creation for concurrent callers', async () => {
    const pool = new ConnectionPoolManager();
    let connectCalls = 0;
    let releaseConnect: (() => void) | undefined;
    const connector = {
      driverName: 'snowflake' as const,
      connect: async () => {
        connectCalls += 1;
        await new Promise<void>((resolve) => {
          releaseConnect = resolve;
        });
      },
      execute: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }),
      disconnect: async () => undefined,
      ping: async () => true,
    };
    (pool as any).createConnector = () => connector;
    const config = { driver: 'snowflake' as const, account: 'acct', username: 'user' };

    const first = pool.getConnector(config);
    const second = pool.getConnector(config);
    await Promise.resolve();
    expect(connectCalls).toBe(1);
    releaseConnect?.();

    expect(await first).toBe(connector);
    expect(await second).toBe(connector);
  });

  it('does not let a slow stale disconnect evict a concurrent replacement', async () => {
    const pool = new ConnectionPoolManager();
    let releaseDisconnect: (() => void) | undefined;
    const stale = {
      driverName: 'snowflake' as const,
      connect: async () => undefined,
      execute: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }),
      disconnect: async () => new Promise<void>((resolve) => { releaseDisconnect = resolve; }),
      ping: async () => true,
    };
    const fresh = {
      ...stale,
      disconnect: async () => undefined,
    };
    let created = 0;
    (pool as any).createConnector = () => created++ === 0 ? stale : fresh;
    const config = { driver: 'snowflake' as const, account: 'acct', username: 'user' };
    expect(await pool.getConnector(config)).toBe(stale);

    const removal = pool.removeConnector(config, stale);
    expect(await pool.getConnector(config)).toBe(fresh);
    releaseDisconnect?.();
    await removal;

    expect(await pool.getConnector(config)).toBe(fresh);
  });
});

describe('ConnectionPoolManager idle eviction', () => {
  const fake = (driverName: string, disconnected: string[], name: string) => ({
    driverName, connect: async () => undefined, disconnect: async () => { disconnected.push(name); },
    execute: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }), ping: async () => true,
  });

  it('disconnects network connectors left idle, keeps local ones, and caps how many it holds', async () => {
    const disconnected: string[] = [];
    const pool = new ConnectionPoolManager({ idleMs: 1_000, maxConnectors: 2, sweepMs: 60_000 });
    let made = 0;
    (pool as any).createConnector = (config: { driver: string; token?: string }) => fake(config.driver, disconnected, `${config.driver}:${config.token ?? made++}`);
    // One person's token renews: a new connector per token; the old one goes idle.
    await pool.getConnector({ driver: 'snowflake', account: 'a', token: 't1' });
    await pool.getConnector({ driver: 'duckdb', filepath: ':memory:' } as never);
    const start = Date.now();
    expect(await pool.evictIdle(start)).toBe(0);
    await pool.getConnector({ driver: 'snowflake', account: 'a', token: 't2' });
    expect(await pool.evictIdle(start + 5_000)).toBe(2);
    expect(disconnected.sort()).toEqual(['snowflake:t1', 'snowflake:t2']);
    // DuckDB (in process, maybe in memory) is never evicted.
    expect(disconnected.some((name) => name.startsWith('duckdb'))).toBe(false);

    // Past the cap, the least recently used network connector goes, even if not yet idle.
    disconnected.length = 0;
    for (const token of ['a', 'b', 'c']) await pool.getConnector({ driver: 'snowflake', account: 'a', token });
    expect(await pool.evictIdle(Date.now())).toBe(1);
    expect(disconnected).toEqual(['snowflake:a']);
    await pool.disconnectAll();
  });
});

/**
 * A program that embeds ZLens can sign each person in to the warehouse with a short-lived token and say whose
 * permissions the connection runs with (`executionIdentity`). The pool then keeps one session per identity.
 */
describe('ConnectionPoolManager per-person sign-in', () => {
  type Fake = {
    name: string;
    driverName: string;
    signedInWith: Array<string | undefined>;
    disconnected: number;
    connect(config: { token?: string }): Promise<void>;
    disconnect(): Promise<void>;
    execute(sql: string): Promise<{ columns: never[]; rows: never[]; rowCount: number; executionTimeMs: number }>;
    ping(): Promise<boolean>;
    release?: () => void;
  };
  const result = { columns: [] as never[], rows: [] as never[], rowCount: 0, executionTimeMs: 0 };
  /** A pool whose connectors are fakes; `made` lists them in the order they signed in. */
  const poolOf = (options: ConstructorParameters<typeof ConnectionPoolManager>[0] = {}) => {
    const made: Fake[] = [];
    const pool = new ConnectionPoolManager({ sweepMs: 60_000, ...options });
    (pool as any).createConnector = (config: { driver: string }) => {
      const connector: Fake = {
        name: `${config.driver}#${made.length + 1}`,
        driverName: config.driver,
        signedInWith: [],
        disconnected: 0,
        connect: async (settings) => { connector.signedInWith.push(settings.token); },
        disconnect: async () => { connector.disconnected += 1; },
        // A statement that runs until the test lets it finish (`release`), when the SQL says so.
        execute: async (sql) => {
          if (sql === 'slow') await new Promise<void>((resolve) => { connector.release = resolve; });
          return result;
        },
        ping: async () => true,
      };
      made.push(connector);
      return connector;
    };
    return { pool, made };
  };
  const snowflake = { driver: 'snowflake' as const, account: 'acct', warehouse: 'WH', authMethod: 'oauth' as const };

  it('keeps one session for one identity whatever token it arrives with', async () => {
    const { pool, made } = poolOf();
    const first = await pool.getConnector({ ...snowflake, token: 'token-1', executionIdentity: 'person-a' });
    const second = await pool.getConnector({ ...snowflake, token: 'token-2', executionIdentity: 'person-a' });
    const third = await pool.getConnector({ ...snowflake, token: 'token-3', executionIdentity: 'person-a' });
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(made).toHaveLength(1);
    // One sign-in, with the token of the statement that needed it.
    expect(made[0]!.signedInWith).toEqual(['token-1']);
    await pool.disconnectAll();
  });

  it('gives each identity its own session, even with the same token', async () => {
    const { pool, made } = poolOf();
    const a = await pool.getConnector({ ...snowflake, token: 'token-1', executionIdentity: 'person-a' });
    const b = await pool.getConnector({ ...snowflake, token: 'token-1', executionIdentity: 'person-b' });
    expect(b).not.toBe(a);
    expect(made).toHaveLength(2);
    // The role and the warehouse still tell one identity's sessions apart.
    const asAnalyst = await pool.getConnector({ ...snowflake, token: 'token-1', executionIdentity: 'person-a', role: 'ANALYST' });
    expect(asAnalyst).not.toBe(a);
    expect(createConnectionConfigKey({ ...snowflake, token: 't', executionIdentity: 'person-a' }))
      .not.toBe(createConnectionConfigKey({ ...snowflake, token: 't', executionIdentity: 'person-b' }));
    await pool.disconnectAll();
  });

  it('signs in again with the newest token, never the one the session started with', async () => {
    const { pool, made } = poolOf();
    const executor = new QueryExecutor(pool);
    await executor.executePositional('SELECT 1', [], { ...snowflake, token: 'token-1', executionIdentity: 'person-a' });
    await executor.executePositional('SELECT 1', [], { ...snowflake, token: 'token-2', executionIdentity: 'person-a' });
    expect(made).toHaveLength(1);
    // The session is lost; the statement that finds out carries the newest token.
    made[0]!.execute = async () => { throw new Error('Authentication token has expired. The user must authenticate again.'); };
    await executor.executePositional('SELECT 1', [], { ...snowflake, token: 'token-3', executionIdentity: 'person-a' });
    expect(made).toHaveLength(2);
    expect(made[1]!.signedInWith).toEqual(['token-3']);
    expect(made[0]!.disconnected).toBe(1);
    // And the next renewal uses the new session.
    await executor.executePositional('SELECT 1', [], { ...snowflake, token: 'token-4', executionIdentity: 'person-a' });
    expect(made).toHaveLength(2);
    await pool.disconnectAll();
  });

  it('signs in again once a session is older than the maximum age, and lets a running statement finish on the old one', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { pool, made } = poolOf({ maxSessionAgeMs: 10 * 60_000 });
      const config = (token: string) => ({ ...snowflake, token, executionIdentity: 'person-a' });
      const old = await pool.getConnector(config('token-1'));
      vi.setSystemTime(Date.now() + 9 * 60_000);
      expect(await pool.getConnector(config('token-2'))).toBe(old);
      // A statement is running on the session when it passes its age.
      const running = old.execute('slow');
      vi.setSystemTime(Date.now() + 2 * 60_000);
      const fresh = await pool.getConnector(config('token-3'));
      expect(fresh).not.toBe(old);
      expect(made[1]!.signedInWith).toEqual(['token-3']);
      // The old session is not disconnected under the statement, however often the pool looks.
      await pool.evictIdle(Date.now() + 60_000);
      expect(made[0]!.disconnected).toBe(0);
      made[0]!.release?.();
      await running;
      await pool.evictIdle(Date.now() + 60_000);
      expect(made[0]!.disconnected).toBe(1);
      expect(made[1]!.disconnected).toBe(0);
      await pool.disconnectAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not age a session kept by its credential, and can leave identity sessions unaged', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { pool, made } = poolOf({ maxSessionAgeMs: 10 * 60_000 });
      const service = await pool.getConnector({ ...snowflake, token: 'service' });
      vi.setSystemTime(Date.now() + 25 * 60_000);
      expect(await pool.getConnector({ ...snowflake, token: 'service' })).toBe(service);
      expect(made).toHaveLength(1);
      await pool.disconnectAll();

      const unaged = poolOf({ maxSessionAgeMs: 0 });
      const kept = await unaged.pool.getConnector({ ...snowflake, token: 't1', executionIdentity: 'person-a' });
      vi.setSystemTime(Date.now() + 25 * 60_000);
      expect(await unaged.pool.getConnector({ ...snowflake, token: 't2', executionIdentity: 'person-a' })).toBe(kept);
      await unaged.pool.disconnectAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never evicts a connector with a statement running on it, and evicts it once it is idle', async () => {
    const { pool, made } = poolOf({ maxConnectors: 2, idleMs: 1_000 });
    const executor = new QueryExecutor(pool);
    const config = (identity: string) => ({ ...snowflake, token: `token-${identity}`, executionIdentity: identity });
    const disconnected = () => made.map((connector) => connector.disconnected);
    // The first person's statement is still running when two more people arrive.
    const running = executor.executePositional('slow', [], config('person-a'));
    await vi.waitFor(() => expect(made[0]?.release).toBeTypeOf('function'));
    await executor.executePositional('SELECT 1', [], config('person-b'));
    await executor.executePositional('SELECT 1', [], config('person-c'));
    expect(made).toHaveLength(3);
    // Past the cap the least recently used idle one goes: not the oldest, which is running a statement.
    await pool.evictIdle(Date.now());
    expect(disconnected()).toEqual([0, 1, 0]);
    // Nor is it idle, however long the statement runs: an hour on, only the one nobody used goes.
    await pool.evictIdle(Date.now() + 60 * 60_000);
    expect(disconnected()).toEqual([0, 1, 1]);
    made[0]!.release?.();
    await running;
    // Finished, and within the cap: it stays until it has been idle long enough.
    expect(disconnected()).toEqual([0, 1, 1]);
    await pool.evictIdle(Date.now() + 60 * 60_000);
    expect(disconnected()).toEqual([1, 1, 1]);
    await pool.disconnectAll();
  });

  it('applies the cap again the moment a busy connector finishes', async () => {
    const { pool, made } = poolOf({ maxConnectors: 1 });
    const executor = new QueryExecutor(pool);
    const config = (identity: string) => ({ ...snowflake, token: 't', executionIdentity: identity });
    const first = executor.executePositional('slow', [], config('person-a'));
    await vi.waitFor(() => expect(made[0]?.release).toBeTypeOf('function'));
    const second = executor.executePositional('slow', [], config('person-b'));
    await vi.waitFor(() => expect(made[1]?.release).toBeTypeOf('function'));
    // Two statements, a cap of one: both keep their sessions while they run.
    await pool.evictIdle(Date.now());
    expect(made.map((connector) => connector.disconnected)).toEqual([0, 0]);
    made[0]!.release?.();
    await first;
    await vi.waitFor(() => expect(made[0]!.disconnected).toBe(1));
    expect(made[1]!.disconnected).toBe(0);
    made[1]!.release?.();
    await second;
    await pool.disconnectAll();
  });

  it('counts a statement run on a connector a caller kept, with the caller\'s own `this`', async () => {
    const { pool, made } = poolOf({ maxConnectors: 1, idleMs: 1_000 });
    const kept = await pool.getConnector({ ...snowflake, token: 't', executionIdentity: 'person-a' }) as unknown as Fake & { listTables?: () => Promise<unknown[]> };
    expect(made).toHaveLength(1);
    const running = kept.execute('slow');
    await pool.getConnector({ ...snowflake, token: 't', executionIdentity: 'person-b' });
    await pool.evictIdle(Date.now() + 60 * 60_000);
    expect(made[0]!.disconnected).toBe(0);
    made[0]!.release?.();
    await running;
    await pool.disconnectAll();

    // A wrapper that calls a lookup with itself as `this` (a host's statement check) still sees its own execute.
    const wrapped = poolOf();
    (wrapped.pool as any).createConnector = () => ({
      driverName: 'snowflake', connect: async () => undefined, disconnect: async () => undefined, ping: async () => true,
      execute: async () => ({ ...result, rows: [{ via: 'connector' }] }),
      async listTables(this: { execute(sql: string): Promise<{ rows: unknown[] }> }) { return (await this.execute('SHOW TABLES')).rows; },
    });
    const connector = await wrapped.pool.getConnector({ ...snowflake, token: 't' }) as unknown as { listTables(): Promise<unknown[]> };
    const view = { execute: async () => ({ rows: [{ via: 'wrapper' }] }) };
    expect(await connector.listTables.call(view)).toEqual([{ via: 'wrapper' }]);
    expect(await connector.listTables()).toEqual([{ via: 'connector' }]);
    await wrapped.pool.disconnectAll();
  });

  it('keeps one connector per credential when no identity is given', async () => {
    const { pool, made } = poolOf();
    const first = await pool.getConnector({ ...snowflake, token: 'token-1' });
    const second = await pool.getConnector({ ...snowflake, token: 'token-2' });
    expect(second).not.toBe(first);
    expect(await pool.getConnector({ ...snowflake, token: 'token-1' })).toBe(first);
    expect(made.map((connector) => connector.signedInWith)).toEqual([['token-1'], ['token-2']]);
    await pool.disconnectAll();
  });

  it('keeps one connector per credential on a driver that presents the credential with every request', async () => {
    const { pool, made } = poolOf();
    const databricks = { driver: 'databricks' as const, host: 'dbc.example.com', httpPath: '/sql/1.0/warehouses/w' };
    const first = await pool.getConnector({ ...databricks, token: 'token-1', executionIdentity: 'person-a' });
    const second = await pool.getConnector({ ...databricks, token: 'token-2', executionIdentity: 'person-a' });
    // Reusing the first would send a token that has since expired.
    expect(second).not.toBe(first);
    expect(made.map((connector) => connector.signedInWith)).toEqual([['token-1'], ['token-2']]);
    await pool.disconnectAll();
  });

  it('leaves a connection without an identity exactly as it was keyed before', () => {
    const base = { driver: 'snowflake' as const, account: 'acct', username: 'svc', password: 'p', warehouse: 'WH' };
    // The key is the same whether or not the field is there at all, and still covers the credential.
    expect(createConnectionConfigKey({ ...base, executionIdentity: undefined })).toBe(createConnectionConfigKey(base));
    expect(createConnectionConfigKey({ ...base, executionIdentity: '' })).toBe(createConnectionConfigKey(base));
    expect(createConnectionConfigKey({ ...base, password: 'other' })).not.toBe(createConnectionConfigKey(base));
    // With an identity the credential is not part of the key; everything else still is.
    const person = { ...base, executionIdentity: 'person-a' };
    expect(createConnectionConfigKey({ ...person, password: 'other', token: 'renewed' })).toBe(createConnectionConfigKey(person));
    expect(createConnectionConfigKey({ ...person, warehouse: 'OTHER' })).not.toBe(createConnectionConfigKey(person));
    expect(createConnectionConfigKey({ ...person, username: 'other' })).not.toBe(createConnectionConfigKey(person));
    // A local database is one per project: an identity changes nothing about how it is kept.
    const local = { driver: 'duckdb' as const, filepath: ':memory:' };
    expect(createConnectionConfigKey({ ...local, executionIdentity: 'person-a' })).toBe(createConnectionConfigKey(local));
  });
});
