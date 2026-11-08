import type { DatabaseConnector, ConnectionConfig } from './connector.js';
import type { QueryExecutionOptions, QueryResult } from './result-types.js';
import { ConnectionPoolManager } from './connection-pool.js';
import { buildParamValues, expandArrayParameters, normalizeSQLPlaceholders, type SQLParamSpec } from './sql-params.js';

const CONNECTION_LOSS_PATTERNS = [
  /\bterminated connection\b/i,
  /\bconnection (?:is )?(?:closed|lost|terminated|reset)\b/i,
  /\bnot connected\b/i,
  /\bsession (?:has )?(?:expired|terminated)\b/i,
  /\binvalid session\b/i,
  /\bECONNRESET\b/i,
  /\bsocket hang up\b/i,
  /\bbroken pipe\b/i,
];

const UNSAFE_SQL_PATTERN = /\b(?:insert|update|delete|merge|upsert|replace|create|alter|drop|truncate|copy|put|get|remove|grant|revoke|call|execute|attach|detach|pragma|vacuum|optimize)\b/i;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return `${error.message}${cause ? ` ${errorMessage(cause)}` : ''}`;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function stripLeadingSqlComments(sql: string): string {
  let value = sql.trimStart();
  while (value.startsWith('--') || value.startsWith('/*')) {
    if (value.startsWith('--')) {
      const newline = value.indexOf('\n');
      value = newline >= 0 ? value.slice(newline + 1).trimStart() : '';
      continue;
    }
    const end = value.indexOf('*/', 2);
    if (end < 0) return '';
    value = value.slice(end + 2).trimStart();
  }
  return value;
}

/**
 * A reconnect may replay a statement, so it is limited to one read-only
 * statement. This deliberately rejects semicolon-separated scripts and any
 * data-changing keyword even when a connector reports a lost session.
 */
export function isReconnectSafeReadOnlySql(sql: string): boolean {
  const normalized = stripLeadingSqlComments(sql).replace(/;\s*$/, '').trim();
  if (!/^(?:select|with)\b/i.test(normalized)) return false;
  if (normalized.includes(';')) return false;
  return !UNSAFE_SQL_PATTERN.test(normalized);
}

export function isRecoverableConnectionLoss(error: unknown): boolean {
  const message = errorMessage(error);
  return CONNECTION_LOSS_PATTERNS.some((pattern) => pattern.test(message));
}

export class QueryExecutor {
  private pool: ConnectionPoolManager;

  constructor(pool?: ConnectionPoolManager) {
    this.pool = pool ?? new ConnectionPoolManager();
  }

  async getConnector(config: ConnectionConfig): Promise<DatabaseConnector> {
    return this.pool.getConnector(config);
  }

  async executeQuery(
    sql: string,
    params: SQLParamSpec[],
    variables: Record<string, unknown>,
    config: ConnectionConfig,
    options?: QueryExecutionOptions,
  ): Promise<QueryResult> {
    const expanded = expandArrayParameters(sql, params ?? [], variables ?? {});
    const paramValues = buildParamValues(expanded.params, expanded.variables);
    return this.executePositional(expanded.sql, paramValues, config, options);
  }

  async executePositional(
    sql: string,
    paramValues: unknown[],
    config: ConnectionConfig,
    options?: QueryExecutionOptions,
  ): Promise<QueryResult> {
    const values = paramValues && paramValues.length > 0 ? paramValues : undefined;
    // With nothing to bind, a `$1` is the SQL's own (Snowflake's `->> … FROM $1` reads the result
    // before it), never a placeholder: rewriting it to `?` broke the statement (live, 2026-11-07).
    const normalizedSQL = values ? normalizeSQLPlaceholders(sql, config.driver) : sql;
    const connector = await this.pool.getConnector(config);
    const startedAt = Date.now();
    try {
      return await connector.execute(normalizedSQL, values, options);
    } catch (error) {
      const retryable = !options?.signal?.aborted
        && isReconnectSafeReadOnlySql(normalizedSQL)
        && isRecoverableConnectionLoss(error);
      if (!retryable) throw error;

      // One bounded retry after evicting the exact failed session. The pool's
      // expected-connector guard prevents concurrent recovery from evicting a
      // healthy replacement established by another request.
      await this.pool.removeConnector(config, connector);
      const replacement = await this.pool.getConnector(config);
      const remainingDeadline = options?.deadlineMs === undefined
        ? undefined
        : options.deadlineMs - (Date.now() - startedAt);
      if (remainingDeadline !== undefined && remainingDeadline <= 0) throw error;
      return replacement.execute(
        normalizedSQL,
        values,
        remainingDeadline === undefined ? options : { ...options, deadlineMs: remainingDeadline },
      );
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.disconnectAll();
  }
}
