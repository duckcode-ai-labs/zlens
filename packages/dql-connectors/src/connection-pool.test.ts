import { describe, expect, it, vi } from 'vitest';
import { ConnectionPoolManager, SessionSignInError, createConnectionConfigKey } from './connection-pool.js';
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

describe('createConnectionConfigKey keeps credentials out of any plain hash', () => {
  const config = { driver: 'snowflake' as const, account: 'acct', username: 'svc', password: 'p', token: 't', warehouse: 'WH' };

  it('is a digest under a key of this process: another process gives another key for the same settings', async () => {
    const here = createConnectionConfigKey(config);
    expect(here).toMatch(/^[0-9a-f]{64}$/);
    expect(createConnectionConfigKey({ ...config })).toBe(here);
    // The module loaded again stands for another process: it draws its own key.
    vi.resetModules();
    const other = await import('./connection-pool.js');
    const there = other.createConnectionConfigKey(config);
    expect(there).toMatch(/^[0-9a-f]{64}$/);
    expect(there).not.toBe(here);
    expect(other.createConnectionConfigKey({ ...config })).toBe(there);
    // Within one process it still tells credentials apart.
    expect(other.createConnectionConfigKey({ ...config, password: 'q' })).not.toBe(there);
    expect(other.createConnectionConfigKey({ ...config, token: 'u' })).not.toBe(there);
  });

  it('never contains a setting, a credential or an identity', () => {
    const key = createConnectionConfigKey({ ...config, password: 'correct-horse', token: 'tok-abcdef', executionIdentity: 'id-0123abcd' });
    for (const text of ['correct-horse', 'tok-abcdef', 'id-0123abcd', 'acct', 'svc']) expect(key).not.toContain(text);
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
      // It was handed out without a lease, so its holder may run another statement: it stays for the hold.
      await pool.evictIdle(Date.now() + 60_000);
      expect(made[0]!.disconnected).toBe(0);
      await pool.evictIdle(Date.now() + 5 * 60_000);
      expect(made[0]!.disconnected).toBe(1);
      expect(made[1]!.disconnected).toBe(0);
      await pool.disconnectAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a session it retired for age connected while a caller without a lease may still use it', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { pool, made } = poolOf({ maxSessionAgeMs: 10 * 60_000, unleasedHoldMs: 5 * 60_000 });
      const config = (token: string) => ({ ...snowflake, token, executionIdentity: 'person-a' });
      // A caller keeps the connector over several statements (a catalog listing, then each table's columns).
      await (await pool.acquire(config('token-0'))).release();
      vi.setSystemTime(new Date('2026-01-01T00:09:58Z'));
      const held = await pool.getConnector(config('token-1'));
      expect(made).toHaveLength(1);
      await held.execute('SELECT 1');
      // The session passes its age; the next statement retires it and signs in again.
      vi.setSystemTime(new Date('2026-01-01T00:10:05Z'));
      const lease = await pool.acquire(config('token-2'));
      expect(lease.connector).not.toBe(held);
      lease.release();
      // Ten seconds on (past the five a leased session lingers) the holder is between two statements.
      vi.setSystemTime(new Date('2026-01-01T00:10:15Z'));
      await pool.evictIdle();
      expect(made[0]!.disconnected).toBe(0);
      await held.execute('SELECT 2');
      expect(made[0]!.disconnected).toBe(0);
      // Each statement it runs keeps it for the hold again; new work never gets it back.
      vi.setSystemTime(new Date('2026-01-01T00:14:50Z'));
      await pool.evictIdle();
      expect(made[0]!.disconnected).toBe(0);
      expect(await pool.getConnector(config('token-3'))).toBe(lease.connector);
      // Five minutes after its last statement it goes.
      vi.setSystemTime(new Date('2026-01-01T00:15:16Z'));
      await pool.evictIdle();
      expect(made[0]!.disconnected).toBe(1);
      expect(made[1]!.disconnected).toBe(0);
      await pool.disconnectAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnects a retired session that was only ever leased once its statements are over and five seconds have passed', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { pool, made } = poolOf({ maxSessionAgeMs: 10 * 60_000 });
      const config = (token: string) => ({ ...snowflake, token, executionIdentity: 'person-a' });
      const first = await pool.acquire(config('token-1'));
      const slow = first.connector.execute('slow');
      vi.setSystemTime(new Date('2026-01-01T00:10:01Z'));
      // Its age retires it; the statement and the lease still run on it.
      const second = await pool.acquire(config('token-2'));
      expect(second.connector).not.toBe(first.connector);
      expect(made[1]!.signedInWith).toEqual(['token-2']);
      vi.setSystemTime(new Date('2026-01-01T00:10:30Z'));
      await pool.evictIdle();
      expect(made[0]!.disconnected).toBe(0);
      made[0]!.release?.();
      await slow;
      // The statement is over, the lease is not.
      await pool.evictIdle();
      expect(made[0]!.disconnected).toBe(0);
      // The last release disconnects it at once: nobody else can hold it. Releasing twice counts once.
      first.release();
      first.release();
      await Promise.resolve();
      expect(made[0]!.disconnected).toBe(1);
      await pool.evictIdle();
      expect(made[0]!.disconnected).toBe(1);
      expect((pool as any).retired.size).toBe(0);

      // Released within the five seconds, it is left for the next look instead.
      vi.setSystemTime(new Date('2026-01-01T00:20:02Z'));
      const third = await pool.acquire(config('token-3'));
      expect(third.connector).not.toBe(second.connector);
      second.release();
      await Promise.resolve();
      expect(made[1]!.disconnected).toBe(0);
      await pool.evictIdle(Date.now() + 4_000);
      expect(made[1]!.disconnected).toBe(0);
      await pool.evictIdle(Date.now() + 5_000);
      expect(made[1]!.disconnected).toBe(1);
      third.release();
      await pool.disconnectAll();
      expect(made[2]!.disconnected).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails every caller waiting for a sign-in that fails, counts none of them, and signs in again for the next', async () => {
    const { pool, made } = poolOf();
    const create = (pool as any).createConnector as (config: { driver: string }) => Fake;
    let failing = true;
    let letFail!: () => void;
    (pool as any).createConnector = (settings: { driver: string }) => {
      const connector = create(settings);
      if (failing) connector.connect = () => new Promise<void>((_resolve, reject) => { letFail = () => reject(new Error('sign-in refused')); });
      return connector;
    };
    const config = { ...snowflake, token: 'token-1', executionIdentity: 'person-a' };
    // Two statements and one keeper wait for the same sign-in.
    const waiting = [pool.acquire(config), pool.acquire(config), pool.getConnector(config)];
    const outcomes = Promise.allSettled(waiting);
    await Promise.resolve();
    expect(made).toHaveLength(1);
    letFail();
    for (const outcome of await outcomes) {
      expect(outcome.status).toBe('rejected');
      // Said by type; the driver's own words are the cause, not the message.
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(SessionSignInError);
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: 'SESSION_SIGN_IN_FAILED', replaced: false, driver: 'snowflake', message: 'The credentials given for this connection did not open a session.', cause: { message: 'sign-in refused' } });
    }
    // The connector that never signed in is closed once and kept nowhere.
    expect(made[0]!.disconnected).toBe(1);
    expect((pool as any).connectors.size).toBe(0);
    expect((pool as any).pendingConnectors.size).toBe(0);
    expect((pool as any).retired.size).toBe(0);
    // The next statement signs in afresh, and is the only one counted on the new connector.
    failing = false;
    const lease = await pool.acquire(config);
    expect(made).toHaveLength(2);
    expect(lease.connector).toBe(made[1]);
    const [entry] = [...(pool as any).connectors.values()];
    expect(entry.inFlight).toBe(1);
    lease.release();
    expect(entry.inFlight).toBe(0);
    // Idle, it can be evicted: no lease of the failed sign-in holds it.
    expect(await pool.evictIdle(Date.now() + 31 * 60_000)).toBe(1);
    expect(made[1]!.disconnected).toBe(1);
    await pool.disconnectAll();
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

/**
 * A session that is not this connection's alone (`sessionRelease: 'abandon'`): somebody else holds it too, or one
 * credential is one session wherever it is used, so a logout here would end it for everyone. The pool lets go of
 * such a session on every path without ever ending it.
 */
describe('ConnectionPoolManager sessions that are abandoned, never ended', () => {
  type Fake = {
    driverName: string;
    signedInWith: Array<string | undefined>;
    ended: number;
    abandoned: number;
    failConnect?: Error;
    connect(config: { token?: string }): Promise<void>;
    disconnect(): Promise<void>;
    abandon?(): Promise<void>;
    execute(sql: string): Promise<{ columns: never[]; rows: never[]; rowCount: number; executionTimeMs: number }>;
    ping(): Promise<boolean>;
    release?: () => void;
  };
  const result = { columns: [] as never[], rows: [] as never[], rowCount: 0, executionTimeMs: 0 };
  /** A pool of fakes; a fake can be abandoned unless its driver is in `cannotAbandon`. `failNext` fails the next sign-in. */
  const poolOf = (options: ConstructorParameters<typeof ConnectionPoolManager>[0] = {}, cannotAbandon: string[] = []) => {
    const made: Fake[] = [];
    const state: { failNext?: Error } = {};
    const pool = new ConnectionPoolManager({ sweepMs: 60_000, ...options });
    (pool as any).createConnector = (config: { driver: string }) => {
      const connector: Fake = {
        driverName: config.driver,
        signedInWith: [],
        ended: 0,
        abandoned: 0,
        connect: async (settings) => {
          connector.signedInWith.push(settings.token);
          if (state.failNext) { const error = state.failNext; state.failNext = undefined; throw error; }
        },
        disconnect: async () => { connector.ended += 1; },
        execute: async (sql) => {
          if (sql === 'slow') await new Promise<void>((resolve) => { connector.release = resolve; });
          if (sql.includes('lost_session')) throw new Error('Unable to perform operation using terminated connection.');
          return result;
        },
        ping: async () => true,
      };
      if (!cannotAbandon.includes(config.driver)) connector.abandon = async () => { connector.abandoned += 1; };
      made.push(connector);
      return connector;
    };
    return { pool, made, state };
  };
  const base = { driver: 'snowflake' as const, account: 'acct', warehouse: 'WH', authMethod: 'oauth' as const };
  const shared = { ...base, sessionRelease: 'abandon' as const };
  const own = { ...base };
  /** What each fake was told when the pool let it go: [ended, abandoned]. */
  const letGo = (made: Fake[]) => made.map((connector) => [connector.ended, connector.abandoned]);

  /**
   * Each path on which the pool lets a session go, run twice: with the setting (never ended) and without (ended,
   * as before). Each returns the connectors the path let go of.
   */
  const paths: Array<[string, (config: typeof shared | typeof own) => Promise<Fake[]>]> = [
    ['idle for too long', async (config) => {
      const { pool, made } = poolOf({ idleMs: 1_000 });
      await pool.getConnector({ ...config, token: 't1', executionIdentity: 'person-a' });
      expect(await pool.evictIdle(Date.now() + 5_000)).toBe(1);
      await pool.disconnectAll();
      return made;
    }],
    ['over the cap', async (config) => {
      const { pool, made } = poolOf({ maxConnectors: 1 });
      await pool.getConnector({ ...config, token: 't1', executionIdentity: 'person-a' });
      await new Promise((resolve) => setTimeout(resolve, 2));
      await pool.getConnector({ ...config, token: 't2', executionIdentity: 'person-b' });
      expect(await pool.evictIdle(Date.now())).toBe(1);
      expect((pool as any).connectors.size).toBe(1);
      return [made[0]!];
    }],
    ['retired for its age, at a sweep', async (config) => {
      const { pool, made } = poolOf({ maxSessionAgeMs: 1 });
      (await pool.acquire({ ...config, token: 't1', executionIdentity: 'person-a' })).release();
      await new Promise((resolve) => setTimeout(resolve, 5));
      (await pool.acquire({ ...config, token: 't2', executionIdentity: 'person-a' })).release();
      expect(made).toHaveLength(2);
      await pool.evictIdle(Date.now() + 6_000);
      return [made[0]!];
    }],
    ['retired for its age, when its last statement ends', async (config) => {
      const { pool, made } = poolOf({ maxSessionAgeMs: 1 });
      const first = await pool.acquire({ ...config, token: 't1', executionIdentity: 'person-a' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      (await pool.acquire({ ...config, token: 't2', executionIdentity: 'person-a' })).release();
      const [old] = [...(pool as any).retired];
      old.retiredAt = Date.now() - 6_000;
      first.release();
      await Promise.resolve();
      return [made[0]!];
    }],
    ['lost (the executor drops it and signs in again)', async (config) => {
      const { pool, made } = poolOf();
      const executor = new QueryExecutor(pool);
      const settings = { ...config, token: 't1', executionIdentity: 'person-a' };
      await expect(executor.executePositional('SELECT lost_session', [], settings)).rejects.toThrow('terminated connection');
      expect(made).toHaveLength(2);
      return [made[0]!];
    }],
    ['a sign-in that failed', async (config) => {
      const { pool, made, state } = poolOf();
      state.failNext = new Error('sign-in refused');
      await expect(pool.acquire({ ...config, token: 't1', executionIdentity: 'person-a' })).rejects.toBeInstanceOf(SessionSignInError);
      expect((pool as any).connectors.size).toBe(0);
      return made;
    }],
    ['shutdown', async (config) => {
      const { pool, made } = poolOf({ maxSessionAgeMs: 1 });
      await pool.getConnector({ ...config, token: 't1', executionIdentity: 'person-a' });
      await pool.getConnector({ ...config, token: 't2', executionIdentity: 'person-b' });
      // One more that is already retired, and one whose sign-in is still under way.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await pool.getConnector({ ...config, token: 't3', executionIdentity: 'person-a' });
      const pending = pool.getConnector({ ...config, token: 't4', executionIdentity: 'person-c' });
      await pool.disconnectAll();
      await pending;
      expect(made).toHaveLength(4);
      return made;
    }],
  ];

  for (const [name, run] of paths) {
    it(`never ends a session it lets go of when the connection says abandon: ${name}`, async () => {
      const let_go = await run(shared);
      expect(let_go.length).toBeGreaterThan(0);
      for (const connector of let_go) expect([connector.ended, connector.abandoned]).toEqual([0, 1]);
    });

    it(`ends the session as before without the setting: ${name}`, async () => {
      const let_go = await run(own);
      expect(let_go.length).toBeGreaterThan(0);
      for (const connector of let_go) expect([connector.ended, connector.abandoned]).toEqual([1, 0]);
      // `end` by name is the same as leaving it out.
      const named = await run({ ...own, sessionRelease: 'end' } as never);
      for (const connector of named) expect([connector.ended, connector.abandoned]).toEqual([1, 0]);
    });
  }

  it('leaves no timer behind: an emptied pool, sweeper stopped, lets the process end', async () => {
    vi.useFakeTimers();
    try {
      const { pool, made } = poolOf({ maxSessionAgeMs: 1_000, idleMs: 10_000 });
      await pool.getConnector({ ...shared, token: 't1', executionIdentity: 'person-a' });
      vi.advanceTimersByTime(2_000);
      (await pool.acquire({ ...shared, token: 't2', executionIdentity: 'person-a' })).release();
      await pool.disconnectAll();
      expect(letGo(made)).toEqual([[0, 1], [0, 1]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses the setting on a driver that can only end a session, before it signs in, and never treats it as "end"', async () => {
    const { pool, made } = poolOf({}, ['postgresql']);
    const config = { driver: 'postgresql' as const, host: 'db', sessionRelease: 'abandon' as const };
    await expect(pool.getConnector(config)).rejects.toThrow('The postgresql driver cannot let go of a session without ending it, so it does not take sessionRelease: abandon.');
    await expect(pool.acquire(config)).rejects.toThrow('does not take sessionRelease: abandon');
    expect(made.map((connector) => connector.signedInWith)).toEqual([[], []]);
    expect(letGo(made)).toEqual([[0, 0], [0, 0]]);
    expect((pool as any).connectors.size).toBe(0);
    // The real drivers: Snowflake can, the others cannot.
    const real = new ConnectionPoolManager();
    const create = (driver: string) => (real as any).createConnector({ driver });
    expect(typeof create('snowflake').abandon).toBe('function');
    for (const driver of ['postgresql', 'redshift', 'mysql', 'mssql', 'databricks', 'bigquery', 'trino', 'clickhouse', 'athena', 'fabric', 'duckdb', 'sqlite', 'file']) {
      expect(create(driver).abandon, driver).toBeUndefined();
    }
  });

  it('keeps an abandoned session and an ended one apart, whatever else is equal', async () => {
    const { pool, made } = poolOf();
    const a = await pool.getConnector({ ...shared, token: 't', executionIdentity: 'person-a' });
    const b = await pool.getConnector({ ...own, token: 't', executionIdentity: 'person-a' });
    expect(a).not.toBe(b);
    expect(createConnectionConfigKey({ ...shared, token: 't' })).not.toBe(createConnectionConfigKey({ ...own, token: 't' }));
    await pool.disconnectAll();
    expect(letGo(made)).toEqual([[0, 1], [1, 0]]);
  });

  it('takes the oldest a session may get from the connection, over the pool\'s own', async () => {
    const { pool, made } = poolOf({ maxSessionAgeMs: 60_000 });
    const now = Date.now();
    const aged = (settings: Record<string, unknown>, age: number) => { for (const entry of (pool as any).connectors.values()) entry.connectedAt = now - age; return pool.getConnector(settings as never); };
    const person = { ...shared, executionIdentity: 'person-a' };
    await pool.getConnector({ ...person, token: 't1', maxSessionAgeMs: 1_800_000 });
    // Past the pool's minute, inside the connection's half hour: the same session.
    await aged({ ...person, token: 't2', maxSessionAgeMs: 1_800_000 }, 600_000);
    expect(made).toHaveLength(1);
    // Past the connection's own: signed in again, with the token of the statement that asked.
    await aged({ ...person, token: 't3', maxSessionAgeMs: 1_800_000 }, 1_800_001);
    expect(made).toHaveLength(2);
    expect(made[1]!.signedInWith).toEqual(['t3']);
    // A shorter age on the connection than the pool's works the same way; it is read from the statement that asks.
    await aged({ ...person, token: 't4', maxSessionAgeMs: 5_000 }, 6_000);
    expect(made).toHaveLength(3);
    // 0: never retired for its age. Without one, or with a value that is not an age, the pool's own applies.
    await aged({ ...person, token: 't5', maxSessionAgeMs: 0 }, 86_400_000);
    expect(made).toHaveLength(3);
    for (const bad of [undefined, -1, Number.NaN, '5' as unknown as number]) {
      const before = made.length;
      await aged({ ...person, token: 't6', maxSessionAgeMs: bad }, 30_000);
      expect(made.length, String(bad)).toBe(before);
      await aged({ ...person, token: 't7', maxSessionAgeMs: bad }, 61_000);
      expect(made.length, String(bad)).toBe(before + 1);
    }
    // A session kept by its credential (no identity) is never aged, whatever the connection says.
    const { pool: plain, made: plainMade } = poolOf();
    await plain.getConnector({ ...own, token: 'k', maxSessionAgeMs: 1 });
    for (const entry of (plain as any).connectors.values()) entry.connectedAt = now - 60_000;
    await plain.getConnector({ ...own, token: 'k', maxSessionAgeMs: 1 });
    expect(plainMade).toHaveLength(1);
    await pool.disconnectAll();
    await plain.disconnectAll();
  });

  it('fails the statement, by type, when a session past its age cannot be opened again: no other session is used', async () => {
    const { pool, made, state } = poolOf({ maxSessionAgeMs: 1_000 });
    const executor = new QueryExecutor(pool);
    const person = { ...shared, executionIdentity: 'person-a' };
    const other = { ...shared, executionIdentity: 'person-b' };
    // The configured connection itself (no identity), another person, and this person: three sessions.
    await executor.executePositional('select 1', [], { ...own, token: 'service' });
    await executor.executePositional('select 1', [], { ...other, token: 'b1' });
    await executor.executePositional('select 1', [], { ...person, token: 'a1' });
    expect(made).toHaveLength(3);
    const executed: Fake[] = [];
    for (const connector of made) { const run = connector.execute; connector.execute = async (sql) => { executed.push(connector); return run(sql); }; }
    // The person's session is past its age, and the token that came with the next statement no longer signs in.
    for (const entry of (pool as any).connectors.values()) if (entry.connector === made[2]) entry.connectedAt = Date.now() - 2_000;
    state.failNext = new Error('390303 Invalid OAuth access token.');
    const failure = await executor.executePositional('select 1', [], { ...person, token: 'a1-stale' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionSignInError);
    expect(failure).toMatchObject({ code: 'SESSION_SIGN_IN_FAILED', replaced: true, driver: 'snowflake', message: 'The credentials given for this connection can no longer open a session. Sign in again.' });
    // The driver's words are the cause only: not in the message, which a host may show.
    expect((failure as Error).message).not.toContain('390303');
    expect(((failure as Error).cause as Error).message).toBe('390303 Invalid OAuth access token.');
    // Nothing ran anywhere: not on the old session, not on the other person's, not on the configured connection.
    expect(executed).toEqual([]);
    expect(made).toHaveLength(4);
    expect(made[3]!.signedInWith).toEqual(['a1-stale']);
    // The old session is not handed out again: the next statement tries to sign in again, and fails the same way.
    state.failNext = new Error('390303 Invalid OAuth access token.');
    await expect(executor.executePositional('select 1', [], { ...person, token: 'a1-stale' })).rejects.toMatchObject({ code: 'SESSION_SIGN_IN_FAILED', replaced: true });
    expect(executed).toEqual([]);
    expect(made).toHaveLength(5);
    // Everybody else is where they were, and a newer token signs this person in again.
    await executor.executePositional('select 1', [], { ...other, token: 'b2' });
    expect(executed).toEqual([made[1]]);
    await executor.executePositional('select 1', [], { ...person, token: 'a2' });
    expect(made).toHaveLength(6);
    expect(made[5]!.signedInWith).toEqual(['a2']);
    // None of the person's sessions was ended: the two that failed to open, and the old one once it is let go.
    await pool.evictIdle(Date.now() + 6_000);
    await pool.disconnectAll();
    expect(letGo(made)).toEqual([[1, 0], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1]]);
  });

  it('says "did not open" for an identity that never had a session here, and leaves other connections\' errors as they were', async () => {
    const { pool, state } = poolOf();
    state.failNext = new Error('sign-in refused');
    await expect(pool.acquire({ ...shared, token: 't', executionIdentity: 'never-seen' })).rejects.toMatchObject({ code: 'SESSION_SIGN_IN_FAILED', replaced: false, message: 'The credentials given for this connection did not open a session.' });
    // Without an identity nothing changes: the driver's own error, as before.
    state.failNext = new Error('sign-in refused');
    const plain = await pool.acquire({ ...own, token: 't' }).catch((error: unknown) => error);
    expect(plain).not.toBeInstanceOf(SessionSignInError);
    expect((plain as Error).message).toBe('sign-in refused');
    await pool.disconnectAll();
  });
});
