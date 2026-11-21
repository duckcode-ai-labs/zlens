import type {
  ConnectionConfig,
  DatabaseConnector,
  QueryBatch,
  QueryExecutionOptions,
  QueryExecutor,
  QueryPurpose,
} from '@zlens/connectors';
import { createConnectionConfigKey, type HostSessionProvider } from '@zlens/connectors';
import { EXECUTION_SCOPE, SHARED_EXECUTION_SCOPE, executionIdentityDigest, executionScopeOf, markSignsPeopleIn, unknownExecutionScope } from './execution-scope.js';
import { classifyWarehouseError, hostedWarehouseError, warehouseDiagnosis } from '@zlens/agent';
import { analyzeSqlReferences, extractTablesFromSql } from '@zlens/core';
import { currentDestination, currentPrincipal, currentRequestContext, type DqlDestination, type DqlPrincipal, type DqlStatementObserver } from './request-context.js';
import { HOSTED_STATEMENT_REFUSED, hostedStatementRefusal, isEngineRestrictionError, restrictedEngineConnection } from './engine-guard.js';
import type { DqlAction } from './route-actions.js';
import { newReference } from './plain-errors.js';

/**
 * ONE QUERY PATH (RFC 0010, slice HH-3). Every statement ZLens sends to a
 * warehouse — a certified Dataset, a page tile, AI-written SQL, a notebook
 * cell, a proof — goes through the server's one executor. When a host
 * supplies `rowPolicy`, that executor asks it about each statement first and
 * runs what it returns: the same SQL, a narrowed rewrite, or nothing.
 *
 * The policy sees who is asking (null for work ZLens starts on its own, such
 * as a startup catalog sync), the SQL and its values, the tables it reads
 * (best effort), the connection, and whether it reads data or only schema.
 * Rewrites must keep the placeholder style of the SQL they receive.
 *
 * Cached and proven results are keyed by the signed-in person (HH-2), so a
 * policy must depend only on the person, the statement and its destination
 * (an export's results are keyed apart, HH-17). A policy that changes for
 * other reasons should carry a version in the person's attributes.
 */
export interface DqlQueryContext {
  principal: DqlPrincipal | null;
  sql: string;
  params: unknown[];
  /** Tables the statement reads, from DQL's SQL reference scan (best effort). */
  relations: string[];
  connection: { driver: string; name?: string };
  purpose: QueryPurpose;
  /**
   * HH-17: where the result goes — `person`, `model` (Ask, Research: a
   * question's answer), `delivery` (a scheduled run) or `export` (a CSV,
   * JSON or Excel file). Absent for work nobody asked for (a startup sync).
   */
  destination?: DqlDestination;
  /** HH-17: the route action of the request the statement serves (HH-2), e.g. `ask`, `export`, `app.view`. */
  action?: DqlAction;
}

/**
 * A check on the result before anyone (the person or a model) gets it: the
 * host's statement carries each group's row count in `column`; when any row's
 * count is below `minimum` (or is not a count), ZLens refuses with `refusal` and
 * hands over no row. The column is removed from what passes.
 */
export interface DqlGroupRowsCheck {
  column: string;
  minimum: number;
  refusal: string;
}

export type DqlRowPolicyResult = { sql: string; params?: unknown[]; groupRows?: DqlGroupRowsCheck } | { refuse: string };

export type DqlRowPolicy = (query: DqlQueryContext) => Promise<DqlRowPolicyResult> | DqlRowPolicyResult;

/**
 * WHOSE CREDENTIALS (RFC 0010, slice HH-4). Before any statement runs, the
 * host may resolve the connection for the person asking: their own warehouse
 * token (Snowflake External OAuth, Databricks OAuth, BigQuery end-user
 * credentials, Redshift identity propagation), a per-person role, or a
 * different target. The warehouse's own row and column rules then apply.
 * Refusing — for example an expired token — stops the query with "reconnect";
 * ZLens never retries with the service credential.
 *
 * WHO IT RUNS AS. The answer may name the `identity` the connection runs
 * with: an opaque, stable string for whose warehouse permissions apply (a
 * warehouse user or role, the host's own id for the person), never a
 * credential. ZLens keeps a digest of it, never the name. With it:
 *  - on a warehouse whose session outlives its token (Snowflake), one
 *    session is kept per identity, so a token that renews (even on every
 *    request) does not sign in again; a new sign-in uses the newest token,
 *    and happens at least every ten minutes so a change of role takes effect;
 *  - what ZLens remembers from that person's statements (a table's columns,
 *    a missing table, measured values) stays theirs across renewals.
 * Two people must never share an identity unless the warehouse shows them the
 * same data.
 *
 * WHAT `identity` MUST NAME. Everything that decides what the session may see.
 * ZLens compares the identity and the settings the hook lays over the
 * connection, and never reads the token: on a warehouse that keeps one session
 * per identity the token is not compared at all. So when the role, the tenant,
 * the secondary roles or any other entitlement travels only inside the token
 * (a claim of an OAuth token, say), put it in the identity string, for example
 * `user:<id>|role:<role>|tenant:<tenant>`. Leave it out and a person whose role
 * changed keeps the session and the remembered columns of the old role until
 * the session ages out, and two tenants that share a user name share both.
 * Naming the role as the `role` setting of the connection does as well: every
 * setting the hook changes is part of the scope and of the session's key.
 *
 * Without `identity`, a hook that changes the connection gets one
 * scope and one connection per credential: nothing is shared between people,
 * and nothing survives a renewal either.
 *
 * A SESSION THAT IS NOT THE CONNECTION'S ALONE. The connection the hook
 * answers may carry `sessionRelease: 'abandon'` (the pool then never sends a
 * logout for it, on any path; only a driver that can drop a session takes
 * it, today Snowflake) and `maxSessionAgeMs` (how old an identity session may
 * get before the next statement signs in again). A sign-in for an identity
 * that fails is a `SessionSignInError` from `@zlens/connectors`: the statement
 * fails and no other session is used. See docs/rfcs/0010-host-hooks.md.
 *
 * A SESSION THE HOST KEEPS. The answer may carry `session`, a function that
 * gives the connected session to run this identity's statements on. ZLens
 * then never signs in for the connection and never ends that session; it
 * asks for every statement, and no answer fails the statement
 * (`SessionSignInError`). It needs `identity`.
 */
export interface DqlCredentialsContext {
  principal: DqlPrincipal | null;
  /** The configured connection, without the person's credentials yet. */
  connection: ConnectionConfig;
  purpose: QueryPurpose;
}

/**
 * Settings to lay over the connection for this person (any field but `driver`), with, optionally, the `identity`
 * the connection then runs as; or a refusal.
 */
export type DqlCredentialsResult = { connection: Partial<ConnectionConfig>; identity?: string; session?: HostSessionProvider } | { refuse: string };

export type DqlCredentialsHook = (input: DqlCredentialsContext) => Promise<DqlCredentialsResult> | DqlCredentialsResult;

const CREDENTIALS_UNREADABLE = 'ZLens could not get your warehouse sign-in. Reconnect and try again.';
const POLICY_UNREADABLE = 'ZLens could not check what you may see, so it did not run this query.';

/** A hook's answer that is an object (not null, not a list, not a string or number). */
function isAnswerObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CredentialsRefusedError extends Error {
  readonly code = 'CREDENTIALS_REQUIRED';
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsRefusedError';
  }
}

/** The connection as this person, or a refusal; a hook error refuses too. */
export async function resolvePersonConnection(hook: DqlCredentialsHook, config: ConnectionConfig, purpose: QueryPurpose = 'data'): Promise<ConnectionConfig> {
  let answer: unknown;
  try {
    answer = await hook({ principal: currentPrincipal() ?? null, connection: { ...config }, purpose });
  } catch {
    throw new CredentialsRefusedError(CREDENTIALS_UNREADABLE);
  }
  // Only an object of one of the two shapes counts; anything else (a bare string such as a token, a number, a list)
  // refuses in DQL's own words and is never repeated back.
  if (!isAnswerObject(answer)) throw new CredentialsRefusedError(CREDENTIALS_UNREADABLE);
  if ('refuse' in answer) {
    throw new CredentialsRefusedError(typeof answer.refuse === 'string' && answer.refuse.trim() ? answer.refuse.trim() : 'Reconnect to your warehouse to run this query.');
  }
  const connection = answer.connection;
  if (!isAnswerObject(connection)) throw new CredentialsRefusedError(CREDENTIALS_UNREADABLE);
  // An identity is a name, or absent. An empty one names nobody (it must never pool everyone together); anything
  // else (a number, an object) is a host error and refuses, as any other unusable answer does.
  const named = answer.identity;
  if (named !== undefined && named !== null && typeof named !== 'string') throw new CredentialsRefusedError(CREDENTIALS_UNREADABLE);
  const identity = typeof named === 'string' && named.trim() ? named.trim() : undefined;
  // A session the host supplies is a function, and it is somebody's: without an identity nothing says whose, so
  // the answer refuses rather than run on a session that could be anyone's.
  const session = answer.session;
  if (session !== undefined && session !== null && typeof session !== 'function') throw new CredentialsRefusedError(CREDENTIALS_UNREADABLE);
  if (typeof session === 'function' && !identity) throw new CredentialsRefusedError(CREDENTIALS_UNREADABLE);
  // Only `identity` says who the connection runs as, and only `session` supplies one: never a field of the overlay
  // or of the project's own settings.
  const { driver: _ignored, executionIdentity: _unnamed, hostSession: _supplied, ...overlay } = connection as Partial<ConnectionConfig>;
  const { executionIdentity: _configured, hostSession: _own, ...base } = config;
  return {
    ...base, ...overlay,
    ...(identity ? { executionIdentity: executionIdentityDigest(identity) } : {}),
    ...(typeof session === 'function' ? { hostSession: session as HostSessionProvider } : {}),
  } as ConnectionConfig;
}

export class RowPolicyRefusedError extends Error {
  readonly code = 'ROW_POLICY_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'RowPolicyRefusedError';
  }
}

/**
 * The tables a statement reads: the SQL parser's answer (quoted and
 * schema-qualified names come out as `schema.table`), plus file readers such
 * as `read_parquet(...)` that only the reference scan sees. When the parser
 * cannot read the statement, the scan alone.
 */
export function relationsOf(sql: string, dialect: string): string[] {
  try {
    const scanned = extractTablesFromSql(sql).tables;
    const analysis = analyzeSqlReferences(sql, dialect);
    if (!analysis.parsed) return scanned;
    return [...new Set([...analysis.tables, ...scanned.filter((table) => table.includes('('))])];
  } catch {
    return [];
  }
}

/**
 * Every table a run's values came from, from each statement's SQL as DQL
 * wrote it (before any host rewrite), or undefined when one statement is
 * missing or names no table ZLens can see — then nobody can say where all the
 * values came from.
 */
export function relationsOfStatements(statements: Array<string | undefined>, dialect: string): string[] | undefined {
  const all = new Set<string>();
  for (const sql of statements) {
    if (typeof sql !== 'string' || !sql.trim()) return undefined;
    const relations = relationsOf(sql, dialect);
    if (!relations.length) return undefined;
    for (const relation of relations) all.add(relation);
  }
  return [...all].sort();
}

/** Ask the policy about one statement; refuse on a refusal, an error, or an unusable answer. */
export async function applyRowPolicy(
  policy: DqlRowPolicy,
  sql: string,
  params: unknown[],
  connection: Pick<ConnectionConfig, 'driver'> & { name?: string },
  purpose: QueryPurpose = 'data',
): Promise<{ sql: string; params: unknown[]; groupRows?: DqlGroupRowsCheck }> {
  let answer: unknown;
  const destination = currentDestination();
  const action = currentRequestContext()?.action;
  try {
    answer = await policy({
      principal: currentPrincipal() ?? null,
      sql,
      params: [...params],
      relations: relationsOf(sql, connection.driver),
      connection: { driver: connection.driver, ...(connection.name ? { name: connection.name } : {}) },
      purpose,
      ...(destination ? { destination } : {}),
      ...(action ? { action } : {}),
    });
  } catch {
    throw new RowPolicyRefusedError(POLICY_UNREADABLE);
  }
  // Only an object of one of the two shapes counts; anything else (a bare SQL string, a number, a list) refuses in
  // DQL's own words and is never repeated back.
  if (!isAnswerObject(answer)) throw new RowPolicyRefusedError(POLICY_UNREADABLE);
  if ('refuse' in answer) {
    throw new RowPolicyRefusedError(typeof answer.refuse === 'string' && answer.refuse.trim() ? answer.refuse.trim() : 'You may not see the data this query reads.');
  }
  if (typeof answer.sql !== 'string' || !answer.sql.trim()) throw new RowPolicyRefusedError(POLICY_UNREADABLE);
  const check = answer.groupRows;
  if (check !== undefined) {
    const valid = !!check && typeof check === 'object' && typeof (check as DqlGroupRowsCheck).column === 'string' && !!(check as DqlGroupRowsCheck).column.trim()
      && Number.isInteger((check as DqlGroupRowsCheck).minimum) && (check as DqlGroupRowsCheck).minimum > 0 && typeof (check as DqlGroupRowsCheck).refusal === 'string';
    if (!valid) throw new RowPolicyRefusedError(POLICY_UNREADABLE);
    return { sql: answer.sql, params: Array.isArray(answer.params) ? answer.params : params, groupRows: check as DqlGroupRowsCheck };
  }
  return { sql: answer.sql, params: Array.isArray(answer.params) ? answer.params : params };
}

/** A row's value for a column, whatever case the engine gave the column's name (Snowflake upper-cases). */
function columnKey(names: Iterable<string>, column: string): string | undefined {
  for (const name of names) if (name.toLowerCase() === column.toLowerCase()) return name;
  return undefined;
}

/**
 * The result, once every group holds at least the check's minimum of rows, without the count column; a refusal
 * (no row handed over) when any group holds fewer, or a row has no count.
 */
export function checkedGroupRows<R extends { columns?: Array<{ name: string }>; rows?: Array<Record<string, unknown>> }>(result: R, check: DqlGroupRowsCheck | undefined): R {
  if (!check) return result;
  const refusal = () => new RowPolicyRefusedError(check.refusal.trim() || 'Some groups in this answer are too small to show.');
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  for (const row of rows) {
    const key = columnKey(Object.keys(row ?? {}), check.column);
    const value = key === undefined ? undefined : row[key];
    const count = typeof value === 'bigint' ? Number(value) : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof count !== 'number' || !Number.isFinite(count) || count < check.minimum) throw refusal();
  }
  const strip = (row: Record<string, unknown>) => {
    const key = columnKey(Object.keys(row), check.column);
    if (key === undefined) return row;
    const { [key]: _count, ...rest } = row;
    return rest;
  };
  return {
    ...result,
    rows: rows.map(strip),
    ...(Array.isArray(result?.columns) ? { columns: result.columns.filter((column) => column.name.toLowerCase() !== check.column.toLowerCase()) } : {}),
  };
}

/**
 * WHEN THE WAREHOUSE REFUSES A STATEMENT, WITH A HOST (HH-3). A driver's
 * message can quote the statement it was sent (DuckDB's and Postgres's
 * `LINE 1: …` excerpt, a Spark plan, an echoed query) — and the statement sent
 * is the host's rewrite, with a row rule's predicate and the person's values
 * in it. So the warehouse's own words go to the server's log under a short
 * reference (a host scrubs its log), and what DQL carries on — to a notebook
 * cell, a tile, or Ask, which says only a plain sentence and the reference —
 * is the diagnosis without any excerpt and without anything only the rewrite
 * added. The log line is the same diagnosis (never the excerpt, which can cut
 * a rewrite value short), with the failure's kind and the statement's own
 * tables, so the host's predicate and its values never reach the log either.
 * DQL's own words for a statement it stopped (a deadline, a cancellation)
 * pass on unchanged.
 */
export class WarehouseStatementError extends Error {
  readonly warehouseReference: string;
  readonly warehouseDiagnosis: string;
  constructor(diagnosis: string, reference: string, codes: Record<string, unknown> = {}) {
    super(`${diagnosis} (reference ${reference})`);
    this.name = 'WarehouseStatementError';
    this.warehouseReference = reference;
    this.warehouseDiagnosis = diagnosis;
    // The driver's codes (never its text or the error itself) stay: callers retry or explain by them.
    for (const key of ['code', 'sqlState', 'vendorCode', 'retryable', 'driver'] as const) {
      if (codes[key] !== undefined) Object.defineProperty(this, key, { value: codes[key], enumerable: true });
    }
  }
}

const OWN_STOP = /query was cancelled|exceeded the \d+ms deadline/i;
const LITERAL = /'(?:[^']|'')*'|(?<![\w$.])\d+(?:\.\d+)?(?![\w$.])/g;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a statement's failure may say beyond the log: the warehouse's
 * diagnosis, cut before any excerpt of the statement sent, with every literal
 * that only the host's rewrite holds (a row rule's values) left out. A
 * statement the host ran as written keeps the warehouse's words.
 */
export function plainWarehouseDiagnosis(raw: string, written: string, sent: string): string {
  if (written === sent) return raw;
  return withoutRewriteValues(warehouseDiagnosis(raw), written, sent) || 'The warehouse could not run the statement.';
}

/** A text with the statement sent, and every literal only the host's rewrite holds (quoted or bare), left out. */
function withoutRewriteValues(raw: string, written: string, sent: string): string {
  if (written === sent) return raw;
  let text = raw;
  if (sent.trim()) text = text.split(sent).join('[the statement]');
  const own = new Set(written.match(LITERAL) ?? []);
  const added = [...new Set(sent.match(LITERAL) ?? [])].filter((literal) => !own.has(literal));
  for (const literal of added) {
    const quoted = literal.startsWith("'");
    // A value an engine cut short in its own excerpt (`'Wes...`) is left out too: any start of three characters
    // or more of a quoted value, followed by an ellipsis.
    if (quoted) {
      const value = literal.slice(1, -1).replace(/''/g, "'");
      for (let length = Math.min(value.length - 1, 64); length >= 3; length -= 1) {
        text = text.replace(new RegExp(`'?${escapeRegExp(value.slice(0, length))}(?:\\.\\.\\.|\u2026)`, 'g'), '…');
      }
    }
    // A number the rewrite added goes only as a whole token: cutting it out wherever its digits stand would garble
    // the rest of the text (every 0 of an id or of INT32 for a rule's `= 0`).
    if (quoted) text = text.split(literal).join("'…'");
    const bare = quoted ? literal.slice(1, -1).replace(/''/g, "'") : literal;
    // Unquoted, only a value goes (a region, a number): a mask's own text ('****') is no one's value, and cutting
    // it out of the middle of a masked value ('**** ****** 0003') would garble what the person may see.
    if (/[\p{L}\p{N}]/u.test(bare) && (bare.trim().length >= 2 || /^\d+$/.test(bare))) text = text.replace(new RegExp(`(?<![\\w$])${escapeRegExp(bare)}(?![\\w$])`, 'g'), '…');
  }
  return text;
}

/** A failed run, as the server carries it on with a host (see WarehouseStatementError). */
function hostedFailure(error: unknown, written: string, sent: string, options?: QueryExecutionOptions): unknown {
  // DQL's own refusals (the engine's restriction read plainly, a row policy's) are not warehouse failures.
  if (error instanceof RowPolicyRefusedError || error instanceof CredentialsRefusedError) return error;
  if (options?.signal?.aborted || hostedWarehouseError(error)) return error;
  const raw = error instanceof Error ? error.message : String(error);
  if ((error as { name?: unknown } | null)?.name === 'AbortError' || OWN_STOP.test(raw)) return error;
  const reference = newReference();
  try {
    // The log keeps the warehouse's diagnosis, never its excerpt of the statement sent (which holds the host's
    // predicate and can cut a value short), without any value only the rewrite added; with the failure's kind and
    // the statement's own tables.
    const failure = classifyWarehouseError(raw, { sql: written });
    const tables = failure.relations.length ? `; tables: ${failure.relations.join(', ')}` : '';
    const diagnosis = withoutRewriteValues(warehouseDiagnosis(raw) || 'The warehouse could not run the statement.', written, sent);
    console.warn(`[dql] A statement failed on the warehouse (reference ${reference}; ${failure.class}${tables}): ${diagnosis}`);
  } catch { /* the person still gets the reference */ }
  const codes = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return new WarehouseStatementError(plainWarehouseDiagnosis(raw, written, sent), reference, codes);
}

async function runHosted<R>(hosted: boolean | undefined, run: () => Promise<R>, written: string, sent: string, options?: QueryExecutionOptions): Promise<R> {
  if (!hosted) return run();
  try {
    return await run();
  } catch (error) {
    throw hostedFailure(error, written, sent, options);
  }
}

/**
 * Run one statement and tell the host's observer (HH-6) how it went and how
 * long it took. `prepare` checks the statement (row policy, the person's
 * connection); a refusal there is `refused`, a failure running it `error`.
 * The observer never sees the SQL or rows, and its errors are ignored.
 */
async function timed<R>(observe: DqlStatementObserver | undefined, config: Pick<ConnectionConfig, 'driver'>, purpose: QueryPurpose | undefined, prepare: () => Promise<{ run: () => Promise<R> }>): Promise<R> {
  if (!observe) return (await prepare()).run();
  const started = Date.now();
  const report = (outcome: 'ok' | 'error' | 'refused') => {
    try {
      void Promise.resolve(observe({ at: new Date().toISOString(), driver: String(config.driver ?? 'unknown'), purpose: purpose === 'metadata' ? 'metadata' : 'data', outcome, durationMs: Date.now() - started })).catch(() => undefined);
    } catch { /* an observer never fails a query */ }
  };
  let prepared: { run: () => Promise<R> };
  try {
    prepared = await prepare();
  } catch (error) {
    report('refused');
    throw error;
  }
  try {
    const result = await prepared.run();
    report('ok');
    return result;
  } catch (error) {
    report('error');
    throw error;
  }
}

/**
 * With a host, a statement that reaches beyond the connection's tables (a file, the environment, an
 * extension, a setting) is refused before it runs (engine-guard.ts); the engine's own refusal of one
 * reads the same plain way. A statement a person or a model writes (any purpose but `platform`, which only
 * DQL's own code sets) must also only read: one statement, no change to data, objects or settings.
 */
function engineChecked(engine: boolean | undefined, sql: string, config: Pick<ConnectionConfig, 'driver' | 'allowedDirectories'>, purpose?: QueryPurpose): void {
  if (!engine) return;
  const refusal = hostedStatementRefusal(sql, config.driver, config.allowedDirectories ?? [], { readOnly: purpose !== 'platform' });
  if (refusal) throw new RowPolicyRefusedError(refusal);
}

async function engineRefusalReadable<R>(engine: boolean | undefined, run: () => Promise<R>): Promise<R> {
  if (!engine) return run();
  try {
    return await run();
  } catch (error) {
    if (isEngineRestrictionError(error)) throw new RowPolicyRefusedError(HOSTED_STATEMENT_REFUSED);
    throw error;
  }
}

/** A connector whose statements — direct, streamed, or in a consistent read scope — pass the policy. */
function guardConnector(connector: DatabaseConnector, policy: DqlRowPolicy | undefined, config: ConnectionConfig, observe?: DqlStatementObserver, hosted?: boolean, engine?: boolean): DatabaseConnector {
  if (!policy && !observe && !hosted && !engine) return connector;
  const checked = (sql: string, params: unknown[], purpose?: QueryPurpose): Promise<{ sql: string; params: unknown[]; groupRows?: DqlGroupRowsCheck }> => {
    try {
      engineChecked(engine, sql, config, purpose);
    } catch (error) {
      return Promise.reject(error);
    }
    return policy ? applyRowPolicy(policy, sql, params, config, purpose) : Promise.resolve({ sql, params });
  };
  const target = connector as DatabaseConnector & { openConsistentReadScope?: () => Promise<{ execute: DatabaseConnector['execute'] }> };
  const execute = (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => timed(observe, config, options?.purpose, async () => {
    const allowed = await checked(sql, params, options?.purpose);
    // The engine's own refusal reads plainly, a warehouse failure too (runHosted); the smallest-group check runs on what the warehouse returned.
    return { run: async () => checkedGroupRows(await runHosted(hosted, () => engineRefusalReadable(engine, () => target.execute(allowed.sql, allowed.params.length ? allowed.params : undefined, options)), sql, allowed.sql, options), allowed.groupRows) };
  });
  const stream = (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => {
    const run = target.stream!.bind(target);
    return (async function* guarded() {
      const allowed = await checked(sql, params, options?.purpose);
      const batches: QueryBatch[] = [];
      try {
        if (!allowed.groupRows) {
          yield* run(allowed.sql, allowed.params.length ? allowed.params : undefined, options);
          return;
        }
        for await (const batch of run(allowed.sql, allowed.params.length ? allowed.params : undefined, options)) batches.push(batch);
      } catch (error) {
        const readable = engine && isEngineRestrictionError(error) ? new RowPolicyRefusedError(HOSTED_STATEMENT_REFUSED) : error;
        throw hosted ? hostedFailure(readable, sql, allowed.sql, options) : readable;
      }
      // Every group is checked before any row is handed over: the batches are held, then passed on.
      const checkedBatches = batches.map((batch) => checkedGroupRows(batch, allowed.groupRows));
      yield* checkedBatches;
    })();
  };
  /**
   * The connector's catalog lookups (listTables, listColumns) run their statements through the same check as any
   * other, as metadata (HH-3, HH-6): the observer hears of them and the policy sees them, never the raw driver.
   */
  const asMetadata = (options?: QueryExecutionOptions): QueryExecutionOptions => ({ ...options, purpose: 'metadata' });
  const metadataView: DatabaseConnector = new Proxy(target, {
    get(object, property) {
      if (property === 'execute') return (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => execute(sql, params, asMetadata(options));
      if (property === 'stream' && typeof object.stream === 'function') return (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => stream(sql, params, asMetadata(options));
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(metadataView) : value;
    },
  });
  return new Proxy(target, {
    get(object, property) {
      if (property === 'execute') return execute;
      if (property === 'listTables' || property === 'listColumns') {
        const lookup = Reflect.get(object, property, object);
        return typeof lookup === 'function' ? lookup.bind(metadataView) : lookup;
      }
      if (property === 'stream' && typeof object.stream === 'function') return stream;
      if (property === 'openConsistentReadScope' && typeof object.openConsistentReadScope === 'function') {
        return async () => {
          const scope = await object.openConsistentReadScope!();
          return new Proxy(scope, {
            get(inner, key) {
              if (key === 'execute') {
                return (sql: string, params: unknown[] = [], options?: QueryExecutionOptions) => timed(observe, config, options?.purpose, async () => {
                  const allowed = await checked(sql, params, options?.purpose);
                  return { run: async () => checkedGroupRows(await runHosted(hosted, () => engineRefusalReadable(engine, () => inner.execute(allowed.sql, allowed.params.length ? allowed.params : undefined, options)), sql, allowed.sql, options), allowed.groupRows) };
                });
              }
              const value = Reflect.get(inner, key, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

export interface HostQueryHooks {
  rowPolicy?: DqlRowPolicy;
  credentials?: DqlCredentialsHook;
  /** HH-6: told of each statement's outcome and duration (no SQL, no values). */
  statements?: DqlStatementObserver;
  /**
   * A host is present: a statement the warehouse refuses is told by its
   * diagnosis and a reference, its own words kept in the server's log
   * (WarehouseStatementError).
   */
  hosted?: boolean;
  /**
   * With a host: the engine reaches the connection's database only. DuckDB and file connections open
   * restricted, and a statement that reads a file, the environment or a setting, or loads an extension,
   * is refused (engine-guard.ts).
   */
  engine?: boolean;
}

/**
 * The server's executor with the host's query hooks in front of every
 * statement: first the person's connection (HH-4), then the row policy
 * (HH-3), then the statement. `executeQuery` expands its parameters and
 * then goes through the same guarded `executePositional`, so each
 * statement is checked once.
 */
export function withHostQueryHooks<T extends QueryExecutor>(executor: T, hooks: HostQueryHooks): T {
  const { rowPolicy, credentials, statements, hosted, engine } = hooks;
  if (!rowPolicy && !credentials && !statements && !hosted && !engine) return executor;
  // The person's connection (HH-4), then, with a host, the engine restricted; a host's overlay cannot lift it.
  const personConnection = async (config: ConnectionConfig, purpose?: QueryPurpose) => {
    const connection = credentials ? await resolvePersonConnection(credentials, config, purpose) : config;
    return engine ? restrictedEngineConnection(connection) : connection;
  };
  /**
   * The execution scope a statement of the current request would run in (execution-scope.ts): the same hook, the
   * same person and purpose as the statement itself. Asked once per request, connection and purpose. A hook that
   * refuses or fails gives a scope of the request's own, so nothing it keeps is found by anyone else.
   */
  const requestScopes = new WeakMap<object, Map<string, Promise<string>>>();
  const executionScope = (config: ConnectionConfig, purpose?: QueryPurpose): Promise<string> => {
    if (!credentials) return Promise.resolve(SHARED_EXECUTION_SCOPE);
    const resolve = async (): Promise<string> => {
      try {
        return executionScopeOf(config, await resolvePersonConnection(credentials, config, purpose));
      } catch {
        return unknownExecutionScope();
      }
    };
    const request = currentRequestContext();
    if (!request) return resolve();
    let known = requestScopes.get(request);
    if (!known) requestScopes.set(request, known = new Map());
    const key = `${purpose ?? 'data'}\u0000${createConnectionConfigKey(config)}`;
    let scope = known.get(key);
    if (!scope) known.set(key, scope = resolve());
    return scope;
  };
  // The executor underneath cannot say whose connection a statement runs on: asked directly, its scope is unknown.
  if (credentials) markSignsPeopleIn(executor);
  return new Proxy(executor, {
    get(target, property, receiver) {
      if (property === EXECUTION_SCOPE) return executionScope;
      const own = Reflect.get(target, property, target);
      if (typeof own !== 'function') return own;
      if (property === 'executePositional') {
        return (sql: string, paramValues: unknown[], config: ConnectionConfig, options?: QueryExecutionOptions) => timed(statements, config, options?.purpose, async () => {
          const connection = await personConnection(config, options?.purpose);
          engineChecked(engine, sql, connection, options?.purpose);
          const allowed: { sql: string; params: unknown[]; groupRows?: DqlGroupRowsCheck } = rowPolicy ? await applyRowPolicy(rowPolicy, sql, paramValues ?? [], connection, options?.purpose) : { sql, params: paramValues };
          return { run: async () => checkedGroupRows(await runHosted(hosted, () => engineRefusalReadable(engine, () => target.executePositional(allowed.sql, allowed.params, connection, options)), sql, allowed.sql, options), allowed.groupRows) };
        });
      }
      if (property === 'executeQuery') {
        // Runs the original expansion with `this` = the guarded executor.
        return (target.executeQuery as (...args: unknown[]) => unknown).bind(receiver);
      }
      if (property === 'getConnector') {
        return async (config: ConnectionConfig) => {
          const connection = await personConnection(config);
          return guardConnector(await target.getConnector(connection), rowPolicy, connection, statements, hosted, engine);
        };
      }
      return own.bind(target);
    },
  });
}

/** The executor with only a row policy (HH-3). */
export function withRowPolicy<T extends QueryExecutor>(executor: T, policy: DqlRowPolicy): T {
  return withHostQueryHooks(executor, { rowPolicy: policy });
}
