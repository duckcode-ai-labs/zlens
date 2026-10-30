import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { QueryExecutionOptions, QueryResult, ColumnMeta, ColumnType, Row } from '../result-types.js';
import { importConnectorDependency } from '../optional-dependency.js';
import { readEnv } from '../env.js';

/**
 * A dedicated connection from the already-open DuckDB database. Dataset
 * evidence uses this one transaction for its probe and the tile it proves, so
 * reconnect/pool behavior cannot silently mix database snapshots.
 */
export interface DuckDBConsistentReadScope {
  readonly id: string;
  readonly context: {
    schema?: string;
    timeZone?: string;
    fingerprint: string;
  };
  execute(sql: string, params?: unknown[], options?: QueryExecutionOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

/** The DuckDB driver package ZLens installs into .dql/connectors (RFC 0011). */
export const DUCKDB_DRIVER_PACKAGE = '@duckdb/node-api';

/**
 * The DuckDB release line whose files ZLens reads: the driver installed into
 * .dql/connectors is `@duckdb/node-api` 1.5.x, and a file written by a newer
 * DuckDB (2.0 writes storage version 999) cannot be opened by it.
 */
export const ZLENS_DUCKDB_READER_LINE = '1.5';
/** The pip requirement that installs the reader's release line. */
const ZLENS_DUCKDB_PIP_PIN = 'duckdb<1.6';

/**
 * DuckDB's message for a file a newer DuckDB wrote ("Trying to read a database
 * file with version number 999, but we can only read versions between 64 and
 * 67. The database file was created with an newer version of DuckDB.") says
 * neither which release wrote it nor how to get a readable file. This says
 * both, and keeps DuckDB's words underneath. Anything else returns undefined.
 */
export function duckDBNewerFileMessage(dbPath: string, duckdbMessage: string): string | undefined {
  const match = /version number (\d+)[\s\S]*newer version of DuckDB/i.exec(duckdbMessage);
  if (!match) return undefined;
  // DuckDB 2.0 marks its files with storage version 999.
  const writer = Number(match[1]) >= 999 ? 'a newer DuckDB (2.x)' : 'a newer DuckDB';
  return [
    `This database file was written by ${writer}. ZLens reads files from DuckDB ${ZLENS_DUCKDB_READER_LINE}. `
      + `Rebuild it with \`pip install '${ZLENS_DUCKDB_PIP_PIN}'\` (then rerun dbt), or use a file written by DuckDB ${ZLENS_DUCKDB_READER_LINE}.`,
    `Original DuckDB error (${dbPath}): ${duckdbMessage}`,
  ].join('\n');
}

/**
 * The message for a DuckDB file that could not be opened. DuckDB lets one
 * process at a time open a database file for writing, and its own message
 * ("Could not set lock on file … Conflicting lock is held in … (PID n)")
 * does not say what to do. A locked file says which process holds it and how
 * to free it; any other failure keeps DuckDB's words.
 */
export function duckDBOpenFailureMessage(dbPath: string, duckdbMessage: string): string {
  const newerFile = duckDBNewerFileMessage(dbPath, duckdbMessage);
  if (newerFile) return newerFile;
  if (!/could not set lock on file/i.test(duckdbMessage)) return `DuckDB connection failed: ${duckdbMessage}`;
  const pid = /\(PID (\d+)\)/i.exec(duckdbMessage)?.[1];
  return [
    `DuckDB file ${dbPath} is in use by another process${pid ? ` (PID ${pid})` : ''}: DuckDB lets only one process open a database file at a time.`,
    'Stop that process, then run this again: for a `zlens notebook` (the workbench), press Ctrl+C in its terminal; for anything else (dbt, a SQL client), close it.',
    `(DuckDB: ${duckdbMessage})`,
  ].join(' ');
}

export class DuckDBConnector implements DatabaseConnector {
  readonly driverName = 'duckdb';
  private db: any = null;
  private connection: any = null;
  private releaseDatabase: (() => Promise<void>) | null = null;
  private readonly openScopes = new Set<() => Promise<void>>();

  async connect(config: ConnectionConfig): Promise<void> {
    await this.disconnect();
    const duckdbModule = await importConnectorDependency(DUCKDB_DRIVER_PACKAGE, config);
    const duckdb = resolveDuckDBModule(duckdbModule);

    const dbPath = config.filepath ?? ':memory:';
    const downloadsOff = duckDBAutoinstallOff();
    const { db, release } = await acquireDuckDBDatabase(duckDBDatabaseKey(dbPath), async () => {
      let database: any;
      try {
        database = await duckdb.DuckDBInstance.create(dbPath);
      } catch (err) {
        throw new Error(duckDBOpenFailureMessage(dbPath, err instanceof Error ? err.message : String(err)));
      }
      duckDBDatabaseModules.set(database, duckdb);
      const setup = await database.connect();
      try {
        await executeDuckDBConnection(setup, database, 'PRAGMA disable_checkpoint_on_shutdown');
        // A host that must not download code at run time (ZLENS_DUCKDB_AUTOINSTALL=off): DuckDB uses only the
        // extensions already installed, and a statement that needs another one fails instead of fetching it.
        if (downloadsOff) await turnOffDuckDBExtensionDownloads(setup, database);
      } catch (error) {
        await closeDuckDBConnection(setup);
        await closeDuckDBDatabase(database, false);
        throw error;
      }
      await closeDuckDBConnection(setup);
      return database;
    });
    if (downloadsOff) extensionDownloadsOffDuckDBDatabases.add(db);
    try {
      if (config.restrictExternalAccess) await restrictDuckDBDatabase(db, config.allowedDirectories ?? []);
      this.connection = await openDuckDBConnection(db);
    } catch (error) {
      await release();
      throw error;
    }
    this.db = db;
    this.releaseDatabase = release;
  }

  async execute(sql: string, params?: unknown[], options: QueryExecutionOptions = {}): Promise<QueryResult> {
    if (!this.connection) {
      throw new Error('DuckDB connector not connected. Call connect() first.');
    }
    return executeDuckDBConnection(this.connection, this.db, sql, params, options);
  }

  /**
   * Preserve the active schema and time zone on a separate connection, then
   * hold a transaction open across the App's related read operations. The
   * normal connector keeps its 1.16 cancellation semantics; the scope simply
   * invokes the same execution helper against its own connection.
   */
  async openConsistentReadScope(): Promise<DuckDBConsistentReadScope> {
    if (!this.db || !this.connection) {
      throw new Error('DuckDB connector not connected. Call connect() first.');
    }
    const db = this.db;
    const context = await readDuckDBSessionContext(this.connection, db);
    const connection = await openDuckDBConnection(db);
    let closed = false;
    let pending = Promise.resolve();
    const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
      const task = pending.then(work, work);
      pending = task.then(() => undefined, () => undefined);
      return task;
    };
    try {
      if (context.schema) await executeDuckDBConnection(connection, db, `SET schema = ${quoteDuckDBString(context.schema)}`);
      // A restricted database's settings are locked: its time zone is then already the one every connection has.
      if (context.timeZone && (await readDuckDBSessionContext(connection, db)).timeZone !== context.timeZone) {
        await executeDuckDBConnection(connection, db, `SET TimeZone = ${quoteDuckDBString(context.timeZone)}`);
      }
      await executeDuckDBConnection(connection, db, 'BEGIN TRANSACTION');
    } catch (error) {
      await closeDuckDBConnection(connection);
      throw error;
    }
    const close = async () => {
      if (closed) return;
      closed = true;
      this.openScopes.delete(close);
      await pending;
      try {
        await executeDuckDBConnection(connection, db, 'ROLLBACK');
      } finally {
        await closeDuckDBConnection(connection);
      }
    };
    this.openScopes.add(close);
    return {
      id: `duckdb_scope_${randomUUID()}`,
      context,
      execute: (sql, params, options) => enqueue(async () => {
        if (closed) throw new Error('DuckDB consistent read scope is closed.');
        return executeDuckDBConnection(connection, db, sql, params, options);
      }),
      close,
    };
  }

  /**
   * Close this connector's connections (including open read scopes, whose
   * transactions would otherwise block the final checkpoint), then release its
   * share of the file's Database. See `acquireDuckDBDatabase`. Every reference
   * this connector held (database, connection, release closure, scopes) is
   * dropped first, so the driver's native objects become collectable; the file
   * handle itself is freed at the next GC (see `collectGarbage`).
   */
  async disconnect(): Promise<void> {
    const connection = this.connection;
    const release = this.releaseDatabase;
    const scopes = [...this.openScopes];
    this.db = null;
    this.connection = null;
    this.releaseDatabase = null;
    this.openScopes.clear();
    await Promise.allSettled(scopes.map((close) => close()));
    if (connection) await closeDuckDBConnection(connection);
    await release?.();
  }

  /**
   * Ask V8 to collect now. A native DuckDB instance can keep the file open
   * after it is closed until its last JS handle is garbage-collected, so a host
   * that must delete or unmount the file right after `disconnect()` calls this
   * (a no-op unless the process runs with `--expose-gc`).
   */
  static collectGarbage(): boolean {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== 'function') return false;
    gc();
    return true;
  }

  async ping(): Promise<boolean> {
    if (!this.connection) return false;
    try {
      await this.execute('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async listTables(): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
       ORDER BY table_schema, table_name`,
    );
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      name: String(row['table_name'] ?? ''),
      type: String(row['table_type'] ?? ''),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    let sql = `SELECT table_schema, table_name, column_name, data_type, ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`;
    const params: unknown[] = [];
    if (schema) {
      params.push(schema);
      sql += ` AND table_schema = $${params.length}`;
    }
    if (table) {
      params.push(table);
      sql += ` AND table_name = $${params.length}`;
    }
    sql += ` ORDER BY table_schema, table_name, ordinal_position`;
    const result = await this.execute(sql, params);
    return result.rows.map((row) => ({
      schema: String(row['table_schema'] ?? ''),
      table: String(row['table_name'] ?? ''),
      name: String(row['column_name'] ?? ''),
      dataType: String(row['data_type'] ?? ''),
      ordinalPosition: Number(row['ordinal_position'] ?? 0),
    }));
  }
}

function duckDbCancellationError(reason: unknown): Error {
  const detail = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : undefined;
  return new Error(`DuckDB query was cancelled${detail ? `: ${detail}` : ''}.`);
}

function duckDbDeadlineError(deadlineMs: number): Error {
  return new Error(`DuckDB query exceeded the ${Math.max(0, deadlineMs)}ms deadline.`);
}

function executeDuckDBConnection(
  connection: any,
  database: any,
  sql: string,
  params?: unknown[],
  options: QueryExecutionOptions = {},
): Promise<QueryResult> {
  if (!connection) return Promise.reject(new Error('DuckDB connector not connected. Call connect() first.'));
  if (options.signal?.aborted) return Promise.reject(duckDbCancellationError(options.signal.reason));
  if (options.deadlineMs !== undefined && options.deadlineMs <= 0) return Promise.reject(duckDbDeadlineError(options.deadlineMs));
  const downloadsOff = extensionDownloadsOffDuckDBDatabases.has(database);
  if (downloadsOff) {
    const refusal = extensionDownloadRefusal(sql);
    if (refusal) return Promise.reject(new Error(refusal));
  }

  const startTime = performance.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    // A connection runs one statement at a time; this one may still be queued
    // behind another, and then interrupting the connection would stop that one.
    let running = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = options.signal;
    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      finish();
    };
    const interrupt = () => {
      if (!running) return;
      try { connection.interrupt?.(); } catch { /* local cancellation still wins */ }
    };
    const cancel = (error: Error) => {
      interrupt();
      settle(() => reject(error));
    };
    const onAbort = () => cancel(duckDbCancellationError(signal?.reason));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (options.deadlineMs !== undefined && Number.isFinite(options.deadlineMs)) {
      deadlineTimer = setTimeout(() => cancel(duckDbDeadlineError(options.deadlineMs!)), Math.max(0, options.deadlineMs));
    }
    const fail = (err: Error) => {
      if (settled) return;
      if (signal?.aborted) {
        cancel(duckDbCancellationError(signal.reason));
        return;
      }
      const missing = downloadsOff ? missingDuckDBExtensionName(err.message) : undefined;
      if (missing) {
        // The engine's text offers INSTALL and the auto-install settings, neither of which this install allows.
        duckDBExtensionInstalled(connection, database, missing).then((installed) => {
          settle(() => reject(new Error(`DuckDB query failed: ${extensionDownloadsOffMessage(missing, installed)}`)));
        });
        return;
      }
      settle(() => reject(new Error(`DuckDB query failed: ${withMissingTableHint(err.message)}`)));
    };
    const succeed = (result: DuckDBRows) => {
      if (settled) return;
      if (signal?.aborted) {
        cancel(duckDbCancellationError(signal.reason));
        return;
      }
      const executionTimeMs = performance.now() - startTime;
      if (result.rows.length === 0) {
        settle(() => resolve({ columns: [], rows: [], rowCount: 0, executionTimeMs }));
        return;
      }
      const normalizedRows = result.rows.map((row: Row) => normalizeDuckDBRow(row));
      const columns: ColumnMeta[] = Object.keys(normalizedRows[0]).map((name) => ({
        name,
        // The first row's value, as before; a NULL there no longer hides the column's type.
        type: normalizedRows[0][name] === null || normalizedRows[0][name] === undefined
          ? duckDBColumnType(result.types[name])
          : inferDuckDBType(normalizedRows[0][name]),
        driverType: 'duckdb',
      }));
      settle(() => resolve({ columns, rows: normalizedRows, rowCount: normalizedRows.length, executionTimeMs }));
    };
    enqueueOnDuckDBConnection(connection, async () => {
      if (settled) return;
      running = true;
      try {
        succeed(await runDuckDBStatement(connection, database, sql, params));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        running = false;
      }
    });
  });
}

/**
 * DRIVER ADAPTER (`@duckdb/node-api`, RFC 0011). Everything that touches the
 * driver's API is below; the connector above only opens, connects, runs and
 * closes through these.
 */

/** The driver module each open database was created with (its converters and type constants). */
const duckDBDatabaseModules = new WeakMap<object, any>();

/** One statement at a time per connection, in call order (the old driver queued them itself). */
const duckDBConnectionQueues = new WeakMap<object, Promise<void>>();

function enqueueOnDuckDBConnection(connection: object, work: () => Promise<void>): void {
  const previous = duckDBConnectionQueues.get(connection) ?? Promise.resolve();
  const next = previous.then(work, work);
  duckDBConnectionQueues.set(connection, next.then(() => undefined, () => undefined));
}

interface DuckDBRows {
  rows: Row[];
  /** DuckDB type id name per column (last one wins for a repeated name, like its value). */
  types: Record<string, string | undefined>;
}

async function runDuckDBStatement(connection: any, database: any, sql: string, params?: unknown[]): Promise<DuckDBRows> {
  const duckdb = duckDBDatabaseModules.get(database);
  const bound = params && params.length > 0 ? bindDuckDBParams(duckdb, params) : undefined;
  const result = await connection.run(sql, bound?.values, bound?.types);
  const names: string[] = result.columnNames();
  const columnTypes: any[] = typeof result.columnTypes === 'function' ? result.columnTypes() : [];
  const converter = duckDBValueConverter(duckdb);
  const values: unknown[][] = converter ? await result.convertRows(converter) : await result.getRows();
  const types: DuckDBRows['types'] = {};
  names.forEach((name, index) => { types[name] = duckDBTypeName(duckdb, columnTypes[index]); });
  // A repeated column name keeps its last value, as the old driver's row objects did.
  const rows = values.map((row) => {
    const object: Row = {};
    names.forEach((name, index) => { object[name] = row[index] as Row[string]; });
    return object;
  });
  return { rows, types };
}

/**
 * Parameters with the types the old driver gave them. Left to itself the
 * driver binds every number as DOUBLE, which a statement that expects an
 * integer (`? + 1`, `LIMIT ?`) rejects, and cannot bind a Date or an array.
 */
function bindDuckDBParams(duckdb: any, params: unknown[]): { values: unknown[]; types: unknown[] } | undefined {
  if (!duckdb?.INTEGER) return undefined;
  const values: unknown[] = [];
  const types: unknown[] = [];
  for (const param of params) {
    if (param === null || param === undefined) {
      values.push(null);
      types.push(duckdb.SQLNULL);
    } else if (typeof param === 'number') {
      values.push(Number.isInteger(param) && Number.isSafeInteger(param) && Math.abs(param) > 2_147_483_647 ? BigInt(param) : param);
      types.push(!Number.isInteger(param) ? duckdb.DOUBLE : Math.abs(param) <= 2_147_483_647 ? duckdb.INTEGER : Number.isSafeInteger(param) ? duckdb.BIGINT : duckdb.DOUBLE);
    } else if (typeof param === 'bigint') {
      values.push(param);
      types.push(duckdb.BIGINT);
    } else if (typeof param === 'boolean') {
      values.push(param);
      types.push(duckdb.BOOLEAN);
    } else if (param instanceof Date && typeof duckdb.timestampValueFromDate === 'function') {
      values.push(duckdb.timestampValueFromDate(param));
      types.push(duckdb.TIMESTAMP);
    } else {
      // Strings, and anything else as its text (the old driver did the same).
      values.push(String(param));
      types.push(duckdb.VARCHAR);
    }
  }
  return { values, types };
}

const duckDBValueConverters = new WeakMap<object, (value: any, type: any, converter: any) => unknown>();

/**
 * Values as the old driver returned them: numbers, bigints (made numbers or
 * strings by `normalizeDuckDBValue`), `Date`s for dates and timestamps,
 * strings for TIME, TIMETZ and BIT, a `{key=value}` string for MAP, and
 * nested lists and structs as arrays and objects. A date or timestamp a JS
 * Date cannot hold (`infinity`) is null.
 */
function duckDBValueConverter(duckdb: any): ((value: any, type: any, converter: any) => unknown) | undefined {
  if (!duckdb?.JSDuckDBValueConverter || !duckdb?.DuckDBTypeId) return undefined;
  const cached = duckDBValueConverters.get(duckdb);
  if (cached) return cached;
  const id = duckdb.DuckDBTypeId;
  const js = duckdb.JSDuckDBValueConverter;
  const asText = new Set([id.TIME, id.TIME_TZ, id.TIME_NS, id.BIT].filter((typeId) => typeId !== undefined));
  const dateTypes = new Set([id.DATE, id.TIMESTAMP, id.TIMESTAMP_S, id.TIMESTAMP_MS, id.TIMESTAMP_NS, id.TIMESTAMP_TZ].filter((typeId) => typeId !== undefined));
  const converter = (value: any, type: any, self: any): unknown => {
    if (value === null || value === undefined) return null;
    const typeId = type?.typeId;
    if (asText.has(typeId)) return String(value);
    if (typeId === id.MAP) {
      const entries: Array<{ key: unknown; value: unknown }> = value.entries ?? [];
      return `{${entries.map((entry) => `${String(entry.key)}=${entry.value === null ? 'NULL' : String(entry.value)}`).join(', ')}}`;
    }
    if (dateTypes.has(typeId)) {
      try {
        return js(value, type, self);
      } catch {
        return null;
      }
    }
    return js(value, type, self);
  };
  duckDBValueConverters.set(duckdb, converter);
  return converter;
}

function duckDBTypeName(duckdb: any, type: any): string | undefined {
  const typeId = type?.typeId;
  if (typeId === undefined || !duckdb?.DuckDBTypeId) return undefined;
  return duckdb.DuckDBTypeId[typeId];
}

function duckDBColumnType(typeName: string | undefined): ColumnType {
  if (!typeName) return 'null';
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|DOUBLE|DECIMAL|BIGNUM)$/.test(typeName)) return 'number';
  if (typeName === 'BOOLEAN') return 'boolean';
  if (typeName === 'DATE' || /^TIMESTAMP/.test(typeName)) return 'datetime';
  if (/^(VARCHAR|UUID|ENUM|TIME|TIME_TZ|TIME_NS|BIT)$/.test(typeName)) return 'string';
  if (typeName === 'SQLNULL') return 'null';
  return 'unknown';
}

async function readDuckDBSessionContext(connection: any, database: any): Promise<DuckDBConsistentReadScope['context']> {
  const [schema, timeZone] = await Promise.all([
    executeDuckDBConnection(connection, database, 'SELECT current_schema() AS "__dql_schema"'),
    executeDuckDBConnection(connection, database, "SELECT current_setting('TimeZone') AS \"__dql_timezone\""),
  ]);
  const schemaValue = typeof schema.rows[0]?.__dql_schema === 'string' ? schema.rows[0].__dql_schema : undefined;
  const timeZoneValue = typeof timeZone.rows[0]?.__dql_timezone === 'string' ? timeZone.rows[0].__dql_timezone : undefined;
  return {
    ...(schemaValue ? { schema: schemaValue } : {}),
    ...(timeZoneValue ? { timeZone: timeZoneValue } : {}),
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify({ schema: schemaValue ?? null, timeZone: timeZoneValue ?? null })).digest('hex')}`,
  };
}

function quoteDuckDBString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * RESTRICTED ENGINE (RFC 0010, with a host). Applied once to an open
 * database, which every connector on the same file shares: no extension is
 * installed or loaded on demand, no file outside the database is read or
 * written (COPY, ATTACH, file readers, replacement scans), and the settings
 * are locked, so no statement can turn any of it back on. DuckDB versions
 * with `allowed_directories` (1.2 and later) keep the connection's allowed
 * folders readable in the engine itself; on DuckDB 1.1, which has no such
 * setting, a connection that names allowed folders keeps external access and
 * relies on DQL's statement check (the host's second layer) for them.
 * Restriction only ever tightens: a database restricted once stays so.
 */
export interface DuckDBRestriction {
  /** Whether the engine itself refuses files outside the database. */
  externalAccess: 'off' | 'allowed-directories' | 'statement-check';
}

const restrictedDuckDBDatabases = new WeakMap<object, Promise<DuckDBRestriction>>();

export function restrictDuckDBDatabase(database: any, allowedDirectories: readonly string[]): Promise<DuckDBRestriction> {
  const existing = restrictedDuckDBDatabases.get(database);
  if (existing) return existing;
  const pending = (async (): Promise<DuckDBRestriction> => {
    const setup = await database.connect();
    const run = (sql: string) => executeDuckDBConnection(setup, database, sql);
    try {
      await run('SET autoinstall_known_extensions = false');
      await run('SET autoload_known_extensions = false');
      // Not every DuckDB version has this setting; extensions cannot be installed once external access is off anyway.
      await run('SET allow_community_extensions = false').catch(() => undefined);
      const folders = allowedDirectories.filter((folder) => typeof folder === 'string' && folder.trim() !== '');
      let engineAllowList = false;
      if (folders.length) {
        const list = folders.map((folder) => quoteDuckDBString(folder.endsWith('/') ? folder : `${folder}/`)).join(', ');
        try {
          await run(`SET allowed_directories = [${list}]`);
          engineAllowList = true;
        } catch {
          // DuckDB 1.1: no allow-list in the engine.
        }
      }
      const keepExternalAccess = folders.length > 0 && !engineAllowList;
      if (!keepExternalAccess) await run('SET enable_external_access = false');
      else {
        // External access stays on for the allowed folders: extensions are kept out another way, by a folder
        // and a repository that cannot exist, so nothing can be installed or loaded.
        const nowhere = process.platform === 'win32' ? 'NUL\\dql-no-extensions' : '/dev/null/dql-no-extensions';
        await run(`SET extension_directory = ${quoteDuckDBString(nowhere)}`);
        await run(`SET custom_extension_repository = ${quoteDuckDBString(nowhere)}`);
      }
      await run('SET lock_configuration = true');
      return { externalAccess: keepExternalAccess ? 'statement-check' : engineAllowList ? 'allowed-directories' : 'off' };
    } finally {
      await closeDuckDBConnection(setup);
    }
  })();
  restrictedDuckDBDatabases.set(database, pending);
  return pending;
}

/**
 * Closing a DuckDB instance from JS only drops that handle. Every connection
 * still holds the native instance, which lives on until garbage collection.
 * When it is finally destroyed, DuckDB's shutdown checkpoint writes the
 * snapshot that instance last saw and then deletes the WAL, even if the
 * instance wrote nothing. Commits made meanwhile through a newer instance on
 * the same file (a reconnect, or another pool key naming that file) are
 * lost at a GC-dependent moment, and readers see an older state.
 *
 * So: every connector on one file in this process shares one Database, each
 * Database disables its shutdown checkpoint, and the last release checkpoints
 * explicitly while it is still the only instance. A late destructor then has
 * nothing to write and no WAL to delete.
 */
interface SharedDuckDBDatabase {
  readonly database: Promise<any>;
  refs: number;
}

const sharedDuckDBDatabases = new Map<string, SharedDuckDBDatabase>();
const closingDuckDBDatabases = new Map<string, Promise<void>>();

/**
 * ZLENS_DUCKDB_AUTOINSTALL=off (or false, 0, no; `DQL_DUCKDB_AUTOINSTALL` is
 * the old name): DuckDB never downloads an extension. By default it fetches a
 * known extension, such as httpfs for a URL, from extensions.duckdb.org the
 * first time a statement needs it, and `INSTALL` fetches one on request.
 * Off, every connection of the database starts with auto-install and auto-load
 * off, an `INSTALL` that would download (anything but a local file path) is
 * refused before it reaches the engine, and a statement that needs an
 * extension the install does not have fails with one plain sentence. An
 * extension already in `extension_directory` still loads (`LOAD httpfs`).
 * Unset or `on`: DuckDB's default.
 */
export function duckDBAutoinstallOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(off|false|0|no)$/i.test(readEnv('ZLENS_DUCKDB_AUTOINSTALL', env)?.trim() ?? '');
}

/** The settings every connection of a database with downloads off starts with (both are global in DuckDB). */
export const DUCKDB_EXTENSION_DOWNLOADS_OFF = ['SET autoinstall_known_extensions = false', 'SET autoload_known_extensions = false'] as const;

/** Databases opened while ZLENS_DUCKDB_AUTOINSTALL=off: their statements are checked and their errors reworded. */
const extensionDownloadsOffDuckDBDatabases = new WeakSet<object>();

async function turnOffDuckDBExtensionDownloads(connection: any, database: any): Promise<void> {
  for (const sql of DUCKDB_EXTENSION_DOWNLOADS_OFF) await executeDuckDBConnection(connection, database, sql);
}

/**
 * A new connection on an open database. With downloads off the two settings are
 * (re)issued before anything else runs on it; a restricted database (RFC 0010)
 * already has both off and its settings locked, so nothing is issued there.
 */
async function openDuckDBConnection(database: any): Promise<any> {
  const connection = await database.connect();
  if (extensionDownloadsOffDuckDBDatabases.has(database) && !restrictedDuckDBDatabases.has(database)) {
    try {
      await turnOffDuckDBExtensionDownloads(connection, database);
    } catch (error) {
      await closeDuckDBConnection(connection);
      throw error;
    }
  }
  return connection;
}

export function extensionDownloadsOffMessage(extension: string, installed = false): string {
  return installed
    ? `the ${extension} extension is installed but not loaded, and extension downloads are off on this install (ZLENS_DUCKDB_AUTOINSTALL=off); run LOAD ${extension} first (nothing is fetched)`
    : `the ${extension} extension is not installed and extension downloads are off on this install (ZLENS_DUCKDB_AUTOINSTALL=off); ask an administrator to bundle it`;
}

/**
 * With downloads off, a statement that would fetch an extension or turn
 * fetching back on is refused before the engine sees it: `INSTALL <name>`
 * (from DuckDB's repository, a named one or a URL), and `SET`/`RESET`/`PRAGMA`
 * of the two auto settings. `INSTALL ... FROM '<local path>'` stays: an
 * administrator bundling an extension from disk downloads nothing.
 */
export function extensionDownloadRefusal(sql: string): string | null {
  const bare = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  for (const statement of bare.split(';')) {
    const text = statement.trim();
    const install = /^(?:FORCE\s+)?INSTALL\s+(?:"([^"]+)"|'([^']+)'|([^\s'"(]+))(?:\s+FROM\s+(?:'([^']*)'|"([^"]*)"|([^\s;]+)))?/i.exec(text);
    if (install) {
      const isUrl = (value: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
      const quotedName = install[1] ?? install[2];
      const name = (quotedName ?? install[3] ?? '').replace(/^.*[\\/]/, '').replace(/\.duckdb_extension(?:\.gz)?$/i, '');
      const quotedSource = install[4] ?? install[5];
      // A file on disk: `INSTALL '/path/httpfs.duckdb_extension'` or `INSTALL httpfs FROM '/mirror'`.
      const localFile = quotedName !== undefined && /[\\/]/.test(quotedName) && !isUrl(quotedName) && quotedSource === undefined && install[6] === undefined;
      const localSource = quotedSource !== undefined && !isUrl(quotedSource);
      if (localFile || localSource) continue;
      return `extension downloads are off on this install (ZLENS_DUCKDB_AUTOINSTALL=off): INSTALL ${name || 'extension'} would download it; ask an administrator to bundle it`;
    }
    const setting = /^(?:SET|RESET|PRAGMA)\s+(?:GLOBAL\s+|SESSION\s+|LOCAL\s+)?(autoinstall_known_extensions|autoload_known_extensions)\b/i.exec(text);
    // Turning either setting off again is what this connector itself does on every new connection.
    if (setting && !/^(?:SET|PRAGMA)\b[^=]*(?:=|\bTO\b)\s*'?(?:false|0|off|no)'?\s*$/i.test(text)) {
      return `extension downloads are off on this install (ZLENS_DUCKDB_AUTOINSTALL=off); ${setting[1].toLowerCase()} cannot be changed by a statement`;
    }
  }
  return null;
}

/** The extension a DuckDB error says is missing, if that is what it says (DuckDB 1.1 to 1.5 wordings). */
export function missingDuckDBExtensionName(message: string): string | undefined {
  const patterns = [
    /requires the extension (\w+) to be loaded/i,
    /exists in the (\w+) extension/i,
    /required extension '(\w+)'/i,
    /Extension "(\w+)" is an existing extension/i,
    /Extension "(\w+)" (?:is not installed|not found|could not be loaded)/i,
    /Missing Extension Error:[^\n]*?\b(?:extension|Extension)\s+"?(\w+)"?/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match) return match[1];
  }
  return undefined;
}

/** Whether `extension` is installed in this database's extension directory (so only a LOAD is missing). */
async function duckDBExtensionInstalled(connection: any, database: any, extension: string): Promise<boolean> {
  try {
    const { rows } = await runDuckDBStatement(connection, database, 'SELECT installed FROM duckdb_extensions() WHERE extension_name = ?', [extension]);
    return rows[0]?.installed === true;
  } catch {
    return false;
  }
}

async function acquireDuckDBDatabase(
  key: string | null,
  open: () => Promise<any>,
): Promise<{ db: any; release: () => Promise<void> }> {
  if (key === null) {
    const db = await open();
    return { db, release: () => closeDuckDBDatabase(db, false) };
  }
  let entry = sharedDuckDBDatabases.get(key);
  if (!entry) {
    // Never open a file while its previous instance is still checkpointing.
    const previousClose = closingDuckDBDatabases.get(key) ?? Promise.resolve();
    const created: SharedDuckDBDatabase = { database: previousClose.then(open), refs: 0 };
    created.database.catch(() => {
      if (sharedDuckDBDatabases.get(key) === created) sharedDuckDBDatabases.delete(key);
    });
    sharedDuckDBDatabases.set(key, created);
    entry = created;
  }
  const acquired = entry;
  acquired.refs += 1;
  let db: any;
  try {
    db = await acquired.database;
  } catch (error) {
    acquired.refs -= 1;
    throw error;
  }
  let released = false;
  return {
    db,
    release: async () => {
      if (released) return;
      released = true;
      acquired.refs -= 1;
      if (acquired.refs > 0) return;
      if (sharedDuckDBDatabases.get(key) === acquired) sharedDuckDBDatabases.delete(key);
      const closing: Promise<void> = closeDuckDBDatabase(db, true).finally(() => {
        if (closingDuckDBDatabases.get(key) === closing) closingDuckDBDatabases.delete(key);
      });
      closingDuckDBDatabases.set(key, closing);
      await closing;
    },
  };
}

/** In-memory databases are private to their connector; files are shared by real path. */
function duckDBDatabaseKey(dbPath: string): string | null {
  if (!dbPath || dbPath.startsWith(':memory:')) return null;
  const absolute = resolvePath(dbPath);
  try {
    return realpathSync(absolute);
  } catch {
    // Not created yet: resolve the directory so the key matches the file's
    // real path once it exists (for example /var -> /private/var on macOS).
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

async function closeDuckDBDatabase(db: any, checkpoint: boolean): Promise<void> {
  if (checkpoint) {
    const connection = await db.connect();
    try {
      await executeDuckDBConnection(connection, db, 'CHECKPOINT');
    } catch (error) {
      // The WAL stays in place and is replayed by the next open.
      console.warn('DuckDB checkpoint warning:', error instanceof Error ? error.message : String(error));
    } finally {
      await closeDuckDBConnection(connection);
    }
  }
  try {
    db.closeSync();
  } catch (err) {
    console.warn('DuckDB disconnect warning:', err instanceof Error ? err.message : String(err));
  }
}

async function closeDuckDBConnection(connection: any): Promise<void> {
  if (!connection) return;
  // Let a statement already queued on it finish first.
  await duckDBConnectionQueues.get(connection);
  try {
    if (typeof connection.closeSync === 'function') connection.closeSync();
    else connection.disconnectSync?.();
  } catch {
    // Already closed.
  }
}

type DuckDBInstanceFactory = { create(path?: string, options?: Record<string, string>): Promise<any> };

/** The `@duckdb/node-api` module, as an ES import or a CommonJS require gives it. */
export function resolveDuckDBModule(module: unknown): { DuckDBInstance: DuckDBInstanceFactory } & Record<string, any> {
  const hasInstance = (value: unknown): boolean => Boolean(
    value && typeof value === 'object' && typeof (value as { DuckDBInstance?: { create?: unknown } }).DuckDBInstance?.create === 'function',
  );
  if (hasInstance(module)) return module as { DuckDBInstance: DuckDBInstanceFactory };
  const fallback = (module as { default?: unknown } | null)?.default;
  if (hasInstance(fallback)) return fallback as { DuckDBInstance: DuckDBInstanceFactory };
  throw new Error(`The DuckDB driver (${DUCKDB_DRIVER_PACKAGE}) did not expose DuckDBInstance.create.`);
}

/**
 * When a query fails because a table/catalog is missing, the most common cause is
 * an empty database or a connection pointed at the wrong `.duckdb` file. Append a
 * one-line hint so the user isn't left guessing. Only for a missing table,
 * view or schema: a function or a column the database does not have is not
 * fixed by building models.
 */
function withMissingTableHint(message: string): string {
  if (/(?:Table|View|Schema|Catalog) with name\b[^\n]*\bdoes not exist/i.test(message)) {
    return `${message}\nHint: that table isn't in this database — it may be empty or the connection may point at the wrong .duckdb file. Build your dbt models (e.g. \`dbt build\`) to populate it, then retry.`;
  }
  return message;
}

export function normalizeDuckDBRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeDuckDBValue(value)]),
  ) as Row;
}

export function normalizeDuckDBValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDuckDBValue(item));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeDuckDBValue(nested)]),
    );
  }
  return value;
}

function inferDuckDBType(value: unknown): ColumnType {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (value instanceof Date) return 'datetime';
  return 'unknown';
}
