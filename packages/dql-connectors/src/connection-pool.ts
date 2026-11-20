import type { DatabaseConnector, ConnectionConfig } from './connector.js';
import { SnowflakeConnector } from './drivers/snowflake.js';
import { DuckDBConnector } from './drivers/duckdb.js';
import { FileConnector } from './drivers/file.js';
import { DatabricksConnector } from './drivers/databricks.js';
import { SQLiteConnector } from './drivers/sqlite.js';
import { PostgreSQLConnector } from './drivers/postgresql.js';
import { RedshiftConnector } from './drivers/redshift.js';
import { MySQLConnector } from './drivers/mysql.js';
import { MSSQLConnector } from './drivers/mssql.js';
import { FabricConnector } from './drivers/fabric.js';
import { TrinoConnector } from './drivers/trino.js';
import { ClickHouseConnector } from './drivers/clickhouse.js';
import { AthenaConnector } from './drivers/athena.js';
import { BigQueryConnector } from './drivers/bigquery.js';
import { openSshTunnel } from './drivers/ssh-tunnel.js';
import { readEnv } from './env.js';
import { createHmac, randomBytes } from 'node:crypto';

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableSerialize(v)).join(',')}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    entries.push(`${JSON.stringify(k)}:${stableSerialize(v)}`);
  }
  return `{${entries.join(',')}}`;
}

/**
 * The settings that only prove who is signing in (a password, a token, keys). With an execution identity
 * (`ConnectionConfig.executionIdentity`) the identity stands for them in a session connector's key, so a renewed
 * token finds the session its identity already has.
 */
export const CONNECTION_CREDENTIAL_FIELDS = [
  'password',
  'token',
  'sessionToken',
  'accessKeyId',
  'secretAccessKey',
  'privateKey',
  'privateKeyPassphrase',
  'passcode',
  'credentials',
  'serviceAccountJson',
  'oauthClientSecret',
] as const satisfies ReadonlyArray<keyof ConnectionConfig>;

/**
 * Drivers whose session, once signed in, lives on its own: the credential is read at sign-in and never again, so a
 * session outlives the token it signed in with. Every other driver presents the credential with each request, or
 * with each new connection of its own pool, so it keeps one connector per credential: reusing one after a renewal
 * would send a token that has expired.
 */
const SESSION_OUTLIVES_CREDENTIAL = new Set<string>(['snowflake']);

/** Local embedded databases are one per project and hold data in process: never evicted. */
const LOCAL_DRIVERS = new Set(['duckdb', 'file', 'sqlite']);

/** Whether this connection's connector is kept by its execution identity instead of by its credential. */
export function isIdentityPooled(config: ConnectionConfig): boolean {
  return typeof config.executionIdentity === 'string'
    && config.executionIdentity.length > 0
    && SESSION_OUTLIVES_CREDENTIAL.has(config.driver);
}

/**
 * Every setting that tells one connector from another, the credentials included. They are read by name from this
 * one list and only ever go into the keyed digest below.
 */
const CONNECTION_KEY_FIELDS = [
  'driver',
  'host',
  'port',
  'database',
  'username',
  'password',
  'token',
  // The path, not the token in it: a renewed token keeps the same pooled connection until it is lost.
  'tokenFilePath',
  'ssl',
  'sslMode',
  'trustServerCertificate',
  'tenantId',
  'sslRootCert',
  'clusterId',
  'sshTunnel',
  'tlsServername',
  'filepath',
  'dataFolder',
  'sources',
  'catalogs',
  'storage',
  'allowedDirectories',
  'restrictExternalAccess',
  'projectId',
  'account',
  'warehouse',
  'workgroup',
  'connectionString',
  'schema',
  'role',
  'region',
  'outputLocation',
  'httpPath',
  'catalog',
  'accessUrl',
  'application',
  'browserActionTimeout',
  'clientRequestMFAToken',
  'clientStoreTemporaryCredential',
  'clientSessionKeepAlive',
  'clientSessionKeepAliveHeartbeatFrequency',
  'credentialCacheDir',
  'keepAlive',
  'noProxy',
  'oauthAuthorizationUrl',
  'oauthClientId',
  'oauthClientSecret',
  'oauthRedirectUri',
  'oauthScope',
  'oauthTokenRequestUrl',
  'passcode',
  'passcodeInPassword',
  'proxyHost',
  'proxyPassword',
  'proxyPort',
  'proxyProtocol',
  'proxyUser',
  'queryTag',
  'timeout',
  'workloadIdentityProvider',
  'workloadIdentityAzureClientId',
  'workloadIdentityImpersonationPath',
  'waitTimeout',
  'byteLimit',
  'privateKey',
  'privateKeyPath',
  'privateKeyPassphrase',
  'authMethod',
  'authenticator',
  'keyFilename',
  'serviceAccountJson',
  'credentials',
  'location',
  'accessKeyId',
  'secretAccessKey',
  'sessionToken',
  'profile',
  'sqliteQueryIsolation',
  'moduleSearchPaths',
] as const satisfies ReadonlyArray<keyof ConnectionConfig>;

/**
 * Keys are digests under a key made at random when the process starts and kept only in its memory. A connector key
 * covers passwords and tokens, so it is never a plain hash of them: without this key a digest cannot be tested
 * against guessed credentials, and it means nothing to another process. Nothing stores or sends these keys; they
 * name entries of in-memory maps for the life of the process.
 */
const PROCESS_KEY = randomBytes(32);

/**
 * The key a connector is pooled under: equal for equal settings within this process, and different in every other
 * process. Never write it down or compare it across processes.
 */
export function createConnectionConfigKey(config: ConnectionConfig): string {
  const settings = config as unknown as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const field of CONNECTION_KEY_FIELDS) normalized[field] = settings[field];
  if (isIdentityPooled(config)) {
    // Whose permissions the session runs with, in place of what proved it: every other setting (the account, the
    // role, the warehouse, the user name) still tells sessions apart.
    for (const field of CONNECTION_CREDENTIAL_FIELDS) delete normalized[field];
    normalized.executionIdentity = config.executionIdentity;
  }
  return createHmac('sha256', PROCESS_KEY).update(stableSerialize(normalized)).digest('hex');
}

export interface ConnectionPoolOptions {
  /** Disconnect a network connector unused this long (default 30 minutes). */
  idleMs?: number;
  /** At most this many network connectors; past it the least recently used one that is not running anything goes (default 64). */
  maxConnectors?: number;
  /** How often idle connectors are looked for (default 1 minute). */
  sweepMs?: number;
  /**
   * A session kept by its execution identity signs in again at its next use once it is this old, so a change of
   * role or grants at the warehouse takes effect (default 10 minutes, or `ZLENS_POOL_MAX_SESSION_AGE_MS`; 0 keeps
   * a session until it is idle or lost). Sessions kept by their credential are not aged: a renewed credential is
   * already a new session.
   */
  maxSessionAgeMs?: number;
  /**
   * A session that was handed out with `getConnector` (no lease) and has since been retired for its age is kept
   * connected until this long after it was last handed out or last ran a statement (default 5 minutes): whoever
   * holds it may be between two statements. New work never gets it; it signs in again.
   */
  unleasedHoldMs?: number;
}

/** A connector for one statement: `release` says the statement is over. */
export interface ConnectorLease {
  connector: DatabaseConnector;
  release(): void;
}

interface PooledConnector {
  key: string;
  connector: DatabaseConnector;
  /** A local embedded database: never evicted, never aged. */
  local: boolean;
  /** Kept by execution identity (see `isIdentityPooled`). */
  identityPooled: boolean;
  connectedAt: number;
  lastUsed: number;
  /** Statements running on it now, and statements it was handed out for. */
  inFlight: number;
  /** When it was last handed out without a lease (`getConnector`): its holder may use it again at any moment. */
  unleasedAt?: number;
  /** No longer handed out; disconnected once nothing runs on it. */
  retiredAt?: number;
}

interface PendingConnector {
  promise: Promise<PooledConnector>;
  /** Callers waiting for it who will run a statement on it at once (`acquire`). */
  leases: number;
}

/** A retired session is left this long for whoever was handed it just before, then disconnected once nothing runs on it. */
const RETIRED_LINGER_MS = 5_000;

const DEFAULT_MAX_SESSION_AGE_MS = 10 * 60_000;

const DEFAULT_UNLEASED_HOLD_MS = 5 * 60_000;

function defaultMaxSessionAgeMs(): number {
  const configured = Number(readEnv('ZLENS_POOL_MAX_SESSION_AGE_MS'));
  return Number.isFinite(configured) && configured >= 0 && readEnv('ZLENS_POOL_MAX_SESSION_AGE_MS')?.trim() ? configured : DEFAULT_MAX_SESSION_AGE_MS;
}

/**
 * Connectors are kept by their settings. A connection that says whose permissions it runs with
 * (`executionIdentity`, from a host's per-person sign-in) keeps one session per identity on a driver whose session
 * outlives its credential: a token that renews every few minutes, or on every request, finds that session again,
 * and a sign-in happens only when the session is new, lost or too old, always with the credential of the statement
 * that needs it (the pool keeps no credential of its own). Without an identity a connector is kept by its full
 * settings, credential included, so each credential has its own.
 *
 * Idle network connectors are disconnected after a while and their number is capped, but never while a statement
 * runs on one: a busy connector is passed over and goes once it is idle.
 */
export class ConnectionPoolManager {
  private connectors: Map<string, PooledConnector> = new Map();
  private pendingConnectors: Map<string, PendingConnector> = new Map();
  private retired: Set<PooledConnector> = new Set();
  private readonly idleMs: number;
  private readonly maxConnectors: number;
  private readonly sweepMs: number;
  private readonly maxSessionAgeMs: number;
  private readonly unleasedHoldMs: number;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(options: ConnectionPoolOptions = {}) {
    this.idleMs = options.idleMs ?? 30 * 60_000;
    this.maxConnectors = options.maxConnectors ?? 64;
    this.sweepMs = options.sweepMs ?? 60_000;
    this.maxSessionAgeMs = options.maxSessionAgeMs ?? defaultMaxSessionAgeMs();
    this.unleasedHoldMs = options.unleasedHoldMs ?? DEFAULT_UNLEASED_HOLD_MS;
  }

  private arm(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => { void this.evictIdle(); }, this.sweepMs);
    this.sweeper.unref?.();
  }

  /**
   * Disconnect network connectors unused for longer than `idleMs`, and the least recently used past the cap.
   * A connector with a statement running on it is in use, however long ago it was handed out: it is passed over,
   * and goes at a later pass once it is idle (one runs as soon as a busy connector finishes while the pool is over
   * its cap).
   */
  async evictIdle(now = Date.now()): Promise<number> {
    const network = [...this.connectors.values()].filter((entry) => !entry.local);
    const byAge = network.sort((a, b) => a.lastUsed - b.lastUsed);
    const idle = byAge.filter((entry) => entry.inFlight === 0 && now - entry.lastUsed > this.idleMs);
    const excess = Math.max(0, byAge.length - idle.length - this.maxConnectors);
    const overCap = byAge.filter((entry) => entry.inFlight === 0 && !idle.includes(entry)).slice(0, excess);
    // Chosen and taken out of the pool in one step, before any disconnect is awaited: a connector handed out
    // while an earlier one disconnects is no longer among those chosen.
    const evicted = [...idle, ...overCap].filter((entry) => this.connectors.get(entry.key) === entry);
    for (const entry of evicted) this.connectors.delete(entry.key);
    const lingered = [...this.retired].filter((entry) => this.retiredIsDone(entry, now));
    for (const entry of lingered) this.retired.delete(entry);
    for (const entry of [...evicted, ...lingered]) {
      try { await entry.connector.disconnect(); } catch { /* already out of the pool; a later query reconnects */ }
    }
    return evicted.length;
  }

  /**
   * A connector for this connection, for a caller that keeps it over several statements (a catalog listing, a
   * consistent read). No lease says when the caller is done, so a session retired for its age after this is kept
   * connected for `unleasedHoldMs` past its last use. For one statement, prefer `acquire`.
   */
  async getConnector(config: ConnectionConfig): Promise<DatabaseConnector> {
    const entry = await this.obtain(config, false);
    entry.unleasedAt = Date.now();
    return entry.connector;
  }

  /**
   * A connector to run one statement on, counted as in use from this moment until `release`: it is not evicted
   * or disconnected for its age in between.
   */
  async acquire(config: ConnectionConfig): Promise<ConnectorLease> {
    const entry = await this.obtain(config, true);
    let released = false;
    return {
      connector: entry.connector,
      release: () => {
        if (released) return;
        released = true;
        this.finished(entry);
      },
    };
  }

  private obtain(config: ConnectionConfig, lease: boolean): Promise<PooledConnector> {
    const key = this.configKey(config);
    this.arm();
    const now = Date.now();
    const existing = this.connectors.get(key);
    if (existing) {
      if (this.tooOld(existing, now)) {
        // The next use signs in again, with this statement's credential. Statements still running on the old
        // session finish there; it is disconnected once they have.
        this.retire(existing, now);
      } else {
        existing.lastUsed = now;
        if (lease) existing.inFlight += 1;
        return Promise.resolve(existing);
      }
    }
    let pending = this.pendingConnectors.get(key);
    if (!pending) {
      const record: PendingConnector = { leases: 0, promise: undefined as unknown as Promise<PooledConnector> };
      this.pendingConnectors.set(key, record);
      record.promise = this.connect(key, config, record);
      pending = record;
    }
    // Counted before the connector exists, so it is already in use when it enters the pool.
    if (lease) pending.leases += 1;
    return pending.promise;
  }

  private async connect(key: string, config: ConnectionConfig, record: PendingConnector): Promise<PooledConnector> {
    let connector: DatabaseConnector | undefined;
    try {
      const created = this.createConnector(config);
      connector = created;
      // A database in a private network is reached through an SSH bastion;
      // the tunnel lives exactly as long as the connector.
      const tunnel = config.sshTunnel ? await openSshTunnel(config) : null;
      if (tunnel) {
        const disconnect = created.disconnect.bind(created);
        created.disconnect = async () => {
          try {
            await disconnect();
          } finally {
            await tunnel.close();
          }
        };
      }
      await created.connect(tunnel ? tunnel.config : config);
      const now = Date.now();
      const local = LOCAL_DRIVERS.has(config.driver);
      const entry: PooledConnector = {
        key,
        connector: created,
        local,
        identityPooled: !local && isIdentityPooled(config),
        connectedAt: now,
        lastUsed: now,
        // Everyone who waited for it to run a statement at once: it enters the pool already in use.
        inFlight: record.leases,
      };
      if (!local) this.track(entry);
      this.connectors.set(key, entry);
      return entry;
    } catch (error) {
      try {
        await connector?.disconnect();
      } catch {
        // The original connection error remains authoritative.
      }
      throw error;
    } finally {
      if (this.pendingConnectors.get(key) === record) this.pendingConnectors.delete(key);
    }
  }

  private tooOld(entry: PooledConnector, now: number): boolean {
    return entry.identityPooled && this.maxSessionAgeMs > 0 && now - entry.connectedAt > this.maxSessionAgeMs;
  }

  /** Take a connector out of the pool; it is disconnected once nothing runs on it (see `evictIdle`, `finished`). */
  private retire(entry: PooledConnector, now: number): void {
    if (this.connectors.get(entry.key) === entry) this.connectors.delete(entry.key);
    entry.retiredAt = now;
    this.retired.add(entry);
  }

  /**
   * Whether a retired session can be disconnected: nothing runs on it, and nobody who was handed it can still be
   * about to. A lease says when its statement is over; a connector handed out without one (`getConnector`) is
   * held by a caller the pool cannot see, between a listing and the statements that follow it, so the session
   * stays until `unleasedHoldMs` after it was last handed out that way or last ran anything.
   */
  private retiredIsDone(entry: PooledConnector, now: number): boolean {
    if (entry.inFlight > 0) return false;
    if (now - (entry.retiredAt ?? 0) < RETIRED_LINGER_MS) return false;
    if (entry.unleasedAt === undefined) return true;
    return now - Math.max(entry.unleasedAt, entry.lastUsed) >= this.unleasedHoldMs;
  }

  /** One statement on this connector is over. */
  private finished(entry: PooledConnector): void {
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    entry.lastUsed = Date.now();
    if (entry.inFlight > 0) return;
    if (entry.retiredAt !== undefined) {
      if (this.retired.has(entry) && this.retiredIsDone(entry, Date.now())) {
        this.retired.delete(entry);
        void entry.connector.disconnect().catch(() => undefined);
      }
      return;
    }
    // A busy connector kept the pool over its cap: now that it is idle, the cap is applied again.
    const network = [...this.connectors.values()].filter((item) => !item.local).length;
    if (network > this.maxConnectors) void this.evictIdle().catch(() => undefined);
  }

  /**
   * Count the statements that run on a network connector, whoever calls it: the executor's own statements and a
   * caller that keeps the connector (a catalog listing, a stream). `this` is passed through, so a wrapper around
   * the connector still sees its own `execute` from inside a catalog lookup.
   */
  private track(entry: PooledConnector): void {
    const connector = entry.connector as unknown as Record<string, unknown>;
    const pool = this;
    for (const method of ['execute', 'listTables', 'listColumns'] as const) {
      const original = connector[method];
      if (typeof original !== 'function') continue;
      const tracked = function (this: unknown, ...args: unknown[]): unknown {
        entry.inFlight += 1;
        entry.lastUsed = Date.now();
        let result: unknown;
        try {
          result = (original as (...call: unknown[]) => unknown).apply(this ?? connector, args);
        } catch (error) {
          pool.finished(entry);
          throw error;
        }
        return Promise.resolve(result).finally(() => pool.finished(entry));
      };
      try { connector[method] = tracked; } catch { /* a connector that cannot be wrapped is counted by its leases only */ }
    }
    const stream = connector.stream;
    if (typeof stream === 'function') {
      const tracked = function (this: unknown, ...args: unknown[]): AsyncIterable<unknown> {
        const self = this ?? connector;
        return (async function* counted() {
          entry.inFlight += 1;
          entry.lastUsed = Date.now();
          try {
            yield* (stream as (...call: unknown[]) => AsyncIterable<unknown>).apply(self, args);
          } finally {
            pool.finished(entry);
          }
        })();
      };
      try { connector.stream = tracked; } catch { /* as above */ }
    }
  }

  /**
   * Drop a session that is known to be lost (the executor calls this before it signs in again). It is
   * disconnected at once: nothing can finish on it.
   */
  async removeConnector(
    config: ConnectionConfig,
    expectedConnector?: DatabaseConnector,
  ): Promise<void> {
    const key = this.configKey(config);
    const entry = this.connectors.get(key);
    if (!entry || (expectedConnector && entry.connector !== expectedConnector)) return;
    // Evict before disconnecting. A slow vendor disconnect must not delete a
    // replacement connector established concurrently by another query.
    this.connectors.delete(key);
    try {
      await entry.connector.disconnect();
    } catch {
      // The stale connector is already evicted; reconnect remains available.
    }
  }

  async disconnectAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    await Promise.allSettled([...this.pendingConnectors.values()].map((pending) => pending.promise));
    const all = [...this.connectors.values(), ...this.retired];
    this.connectors.clear();
    this.retired.clear();
    this.pendingConnectors.clear();
    await Promise.all(all.map((entry) => entry.connector.disconnect()));
  }

  private createConnector(config: ConnectionConfig): DatabaseConnector {
    switch (config.driver) {
      case 'snowflake':
        return new SnowflakeConnector();
      case 'duckdb':
        return new DuckDBConnector();
      case 'file':
        return new FileConnector();
      case 'databricks':
        return new DatabricksConnector();
      case 'sqlite':
        return new SQLiteConnector();
      case 'postgresql':
        return new PostgreSQLConnector();
      case 'redshift':
        return new RedshiftConnector();
      case 'mysql':
        return new MySQLConnector();
      case 'mssql':
        return new MSSQLConnector();
      case 'fabric':
        return new FabricConnector();
      case 'trino':
        return new TrinoConnector();
      case 'clickhouse':
        return new ClickHouseConnector();
      case 'athena':
        return new AthenaConnector();
      case 'bigquery':
        return new BigQueryConnector();
      default:
        throw new Error(`Unsupported database driver: ${String((config as { driver?: unknown }).driver)}.`);
    }
  }

  private configKey(config: ConnectionConfig): string {
    return `${config.driver}:${createConnectionConfigKey(config)}`;
  }
}
