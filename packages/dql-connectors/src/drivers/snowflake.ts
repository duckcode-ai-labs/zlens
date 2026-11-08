import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import {
  ConnectorQueryError,
  type QueryBatch,
  type QueryExecutionOptions,
  type QueryResult,
  type ColumnMeta,
  type ColumnType,
  type Row,
} from '../result-types.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createPrivateKey } from 'node:crypto';
import { importConnectorDependency } from '../optional-dependency.js';
import { currentQueryLabels, type QueryLabels } from '../query-labels.js';

/** How ZLens names itself to Snowflake (the `application` connection setting) unless the connection names another. */
export const SNOWFLAKE_APPLICATION = 'ZLens';

/** Snowflake's limit on a statement's `QUERY_TAG`. */
const QUERY_TAG_LIMIT = 2_000;

export class SnowflakeConnector implements DatabaseConnector {
  readonly driverName = 'snowflake';
  private connection: any = null;
  private sdk: any = null;
  /** The connection's own `queryTag`, merged into every statement's tag (see snowflakeQueryTag). */
  private ownQueryTag: string | undefined;

  async connect(config: ConnectionConfig): Promise<void> {
    // snowflake-sdk is a CJS module, so the API lives on .default
    const mod = await importConnectorDependency('snowflake-sdk', config);
    this.sdk = (mod as any).default ?? mod;
    // The SDK logs every connection step as JSON on stdout, into ZLens's own output
    // (`zlens sync warehouse` on a live account, 2026-11-07). ZLens reports failures itself.
    // Once per SDK module: the SDK announces each change of level in one more line.
    if (!loggingConfigured.has(this.sdk)) {
      loggingConfigured.add(this.sdk);
      try {
        this.sdk.configure?.({ logLevel: snowflakeLogLevel() });
      } catch { /* an SDK without configure keeps its own logging */ }
    }

    const connectionConfig: Record<string, unknown> = {
      account: config.account ?? '',
      database: config.database,
      warehouse: config.warehouse,
    };
    // A token names its own user (Snowflake's container token has no user name to give): an empty
    // name is left out rather than sent.
    if (config.username) connectionConfig.username = config.username;

    // Schema, role, and enterprise driver options.
    if (config.schema) connectionConfig.schema = config.schema;
    if (config.role) connectionConfig.role = config.role;
    applySnowflakeConnectionOptions(connectionConfig, config);
    connectionConfig.application ??= SNOWFLAKE_APPLICATION;
    // Each statement carries the tag (`parameters.QUERY_TAG`): a session tag set at sign-in would
    // replace it on SDK 2.2 and newer, and SDK 1.x ignores the session setting altogether.
    this.ownQueryTag = typeof config.queryTag === 'string' ? config.queryTag : undefined;

    const privateKey = await readSnowflakePrivateKey(config);

    // Auth: key-pair, OAuth, PAT, workload identity, SSO/MFA, or password.
    if (privateKey || config.authMethod === 'key_pair') {
      if (!privateKey) {
        throw new Error('Snowflake key-pair authentication requires privateKey or privateKeyPath.');
      }
      connectionConfig.authenticator = 'SNOWFLAKE_JWT';
      connectionConfig.privateKey = privateKey;
      if (config.privateKeyPassphrase) {
        connectionConfig.privateKeyPass = config.privateKeyPassphrase;
      }
    } else if (config.authMethod === 'oauth') {
      connectionConfig.authenticator = config.authenticator ?? 'OAUTH';
      connectionConfig.token = config.token ?? await readSnowflakeTokenFile(config.tokenFilePath) ?? config.password ?? '';
    } else if (config.authMethod === 'oauth_authorization_code') {
      connectionConfig.authenticator = config.authenticator ?? 'OAUTH_AUTHORIZATION_CODE';
    } else if (config.authMethod === 'oauth_client_credentials') {
      connectionConfig.authenticator = config.authenticator ?? 'OAUTH_CLIENT_CREDENTIALS';
    } else if (config.authMethod === 'programmatic_access_token') {
      connectionConfig.authenticator = config.authenticator ?? 'PROGRAMMATIC_ACCESS_TOKEN';
      connectionConfig.token = config.token ?? await readSnowflakeTokenFile(config.tokenFilePath) ?? config.password ?? '';
    } else if (config.authMethod === 'workload_identity') {
      connectionConfig.authenticator = config.authenticator ?? 'WORKLOAD_IDENTITY';
      const token = config.token ?? await readSnowflakeTokenFile(config.tokenFilePath);
      if (token) {
        connectionConfig.token = token;
      }
    } else if (config.authMethod === 'mfa') {
      connectionConfig.authenticator = config.authenticator ?? 'USERNAME_PASSWORD_MFA';
      connectionConfig.password = config.password ?? '';
    } else if (config.authMethod === 'external_browser') {
      connectionConfig.authenticator = config.authenticator ?? 'EXTERNALBROWSER';
    } else {
      connectionConfig.password = config.password ?? '';
      connectionConfig.authenticator = config.authenticator ?? 'SNOWFLAKE';
    }

    if (config.host) {
      connectionConfig.host = config.host;
    }

    await new Promise<void>((resolve, reject) => {
      this.connection = this.sdk.createConnection(connectionConfig);
      this.connection.connect((err: Error | undefined) => {
        if (err) {
          reject(new Error(`Snowflake connection failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });

  }

  async execute(
    sql: string,
    params?: unknown[],
    options: QueryExecutionOptions = {},
  ): Promise<QueryResult> {
    if (!this.connection) {
      throw new Error('Snowflake connector not connected. Call connect() first.');
    }

    const startTime = performance.now();
    const rows: Row[] = [];
    let columns: ColumnMeta[] = [];
    let queryId: string | undefined;
    let truncated = false;
    let bytesRead = 0;

    for await (const batch of this.stream(sql, params, options)) {
      if (columns.length === 0) columns = batch.columns;
      rows.push(...batch.rows);
      queryId = batch.queryId ?? queryId;
      truncated = truncated || Boolean(batch.truncated);
      bytesRead += batch.byteCount;
    }

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: performance.now() - startTime,
      ...(queryId ? { queryId } : {}),
      ...(truncated ? { truncated: true } : {}),
      bytesRead,
    };
  }

  async *stream(
    sql: string,
    params?: unknown[],
    options: QueryExecutionOptions = {},
  ): AsyncIterable<QueryBatch> {
    if (!this.connection) {
      throw new Error('Snowflake connector not connected. Call connect() first.');
    }

    const maxRows = boundedPositiveInteger(options.maxRows, 10_000, 1_000_000);
    const maxBytes = boundedPositiveInteger(options.maxBytes, 16 * 1024 * 1024, 256 * 1024 * 1024);
    const batchSize = boundedPositiveInteger(options.batchSize, 500, 1_000);
    const deadlineMs = boundedPositiveInteger(options.deadlineMs, 120_000, 600_000);
    let statement: any;
    let submittedStatement: any;
    let timedOut = false;
    let cancelled = false;
    const cancelStatement = () => {
      const active = statement ?? submittedStatement;
      if (!active || typeof active.cancel !== 'function') return;
      try {
        active.cancel(() => undefined);
      } catch {
        // Best-effort cancellation; the primary structured failure is retained.
      }
    };
    const abort = () => {
      cancelled = true;
      cancelStatement();
    };
    if (options.signal?.aborted) {
      throw snowflakeControlError('EXECUTION_CANCELLED', 'Snowflake query was cancelled before submission.');
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      cancelStatement();
    }, deadlineMs);

    try {
      statement = await new Promise<any>((resolve, reject) => {
        submittedStatement = this.connection.execute({
        sqlText: sql,
        binds: params ?? [],
        parameters: { QUERY_TAG: snowflakeQueryTag(this.ownQueryTag, { purpose: options.purpose ?? 'data', ...currentQueryLabels() }) },
        // Snowflake otherwise materializes every row in the complete callback.
        // Streaming is mandatory for bounded enterprise result consumption.
        streamResult: true,
        complete: (err: Error | undefined, stmt: any) => {
          if (err) {
            reject(snowflakeQueryError(err, stmt ?? submittedStatement));
            return;
          }
          resolve(stmt ?? submittedStatement);
        },
      });
        if (cancelled || timedOut) cancelStatement();
      });

      if (timedOut) throw snowflakeControlError('TIMEOUT', `Snowflake query exceeded the ${deadlineMs}ms deadline.`);
      if (cancelled) throw snowflakeControlError('EXECUTION_CANCELLED', 'Snowflake query was cancelled.');

      const queryId = snowflakeStatementId(statement);
      const columns: ColumnMeta[] = (statement.getColumns?.() ?? []).map((col: any) => ({
        name: col.getName(),
        type: mapSnowflakeType(col.getType()),
        driverType: col.getType(),
      }));
      const rowStream = statement.streamRows();
      let batchRows: Row[] = [];
      let batchBytes = 0;
      let totalRows = 0;
      let totalBytes = 0;
      let truncated = false;

      try {
        for await (const rawRow of rowStream as AsyncIterable<Row>) {
          if (timedOut) throw snowflakeControlError('TIMEOUT', `Snowflake query exceeded the ${deadlineMs}ms deadline.`);
          if (cancelled) throw snowflakeControlError('EXECUTION_CANCELLED', 'Snowflake query was cancelled.');
          const rowBytes = serializedRowBytes(rawRow);
          if (totalRows >= maxRows || totalBytes + rowBytes > maxBytes) {
            truncated = true;
            cancelStatement();
            break;
          }
          batchRows.push(rawRow);
          batchBytes += rowBytes;
          totalRows += 1;
          totalBytes += rowBytes;
          if (batchRows.length >= batchSize) {
            yield {
              columns,
              rows: batchRows,
              rowCount: batchRows.length,
              byteCount: batchBytes,
              ...(queryId ? { queryId } : {}),
            };
            batchRows = [];
            batchBytes = 0;
          }
        }
      } catch (error) {
        if (timedOut) throw snowflakeControlError('TIMEOUT', `Snowflake query exceeded the ${deadlineMs}ms deadline.`);
        if (cancelled) throw snowflakeControlError('EXECUTION_CANCELLED', 'Snowflake query was cancelled.');
        throw snowflakeQueryError(error, statement);
      }

      // Always yield a terminal batch so zero-row results retain columns/query ID
      // and callers learn whether the bounded result was truncated.
      yield {
        columns,
        rows: batchRows,
        rowCount: batchRows.length,
        byteCount: batchBytes,
        ...(queryId ? { queryId } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      return new Promise((resolve) => {
        this.connection.destroy((err: Error | undefined) => {
          if (err) {
            console.warn('Snowflake disconnect warning:', err.message);
          }
          this.connection = null;
          resolve();
        });
      });
    }
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
       WHERE table_schema NOT IN ('INFORMATION_SCHEMA')
       ORDER BY table_schema, table_name`,
    );
    return result.rows.map((row) => ({
      schema: String(row['TABLE_SCHEMA'] ?? row['table_schema'] ?? ''),
      name: String(row['TABLE_NAME'] ?? row['table_name'] ?? ''),
      type: String(row['TABLE_TYPE'] ?? row['table_type'] ?? ''),
    }));
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    // Names travel as bind values, never inside the statement's text (Snowflake reads backslashes in strings).
    let sql = `SELECT table_schema, table_name, column_name, data_type, ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('INFORMATION_SCHEMA')`;
    const params: unknown[] = [];
    if (schema) {
      params.push(schema);
      sql += ` AND table_schema = ?`;
    }
    if (table) {
      params.push(table);
      sql += ` AND table_name = ?`;
    }
    sql += ` ORDER BY table_schema, table_name, ordinal_position`;
    const result = await this.execute(sql, params);
    return result.rows.map((row) => ({
      schema: String(row['TABLE_SCHEMA'] ?? row['table_schema'] ?? ''),
      table: String(row['TABLE_NAME'] ?? row['table_name'] ?? ''),
      name: String(row['COLUMN_NAME'] ?? row['column_name'] ?? ''),
      dataType: String(row['DATA_TYPE'] ?? row['data_type'] ?? ''),
      ordinalPosition: Number(row['ORDINAL_POSITION'] ?? row['ordinal_position'] ?? 0),
    }));
  }
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(Number(value))));
}

function serializedRowBytes(row: Row): number {
  try {
    return Buffer.byteLength(JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value), 'utf8');
  } catch {
    return Buffer.byteLength(String(row), 'utf8');
  }
}

function snowflakeStatementId(statement: any): string | undefined {
  try {
    const value = statement?.getStatementId?.() ?? statement?.getQueryId?.();
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

const loggingConfigured = new WeakSet<object>();

/**
 * A statement's `QUERY_TAG`: what ZLens was doing, as JSON under a `zlens` key, e.g.
 * `{"zlens":{"purpose":"data","action":"ask","request":"…"}}`. The connection's own tag is the
 * customer's: a JSON object keeps its keys and gains `zlens` (one it already has wins); any other
 * tag is kept exactly as written, without ZLens's, so a cost report that matches it keeps working.
 */
export function snowflakeQueryTag(ownTag: string | undefined, labels: QueryLabels): string {
  const ours = { zlens: { ...labels } };
  const own = ownTag?.trim();
  if (!own) return fitQueryTag(JSON.stringify(ours), '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(own);
  } catch {
    return own;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || 'zlens' in parsed) return own;
  return fitQueryTag(JSON.stringify({ ...(parsed as Record<string, unknown>), ...ours }), own);
}

/** A tag over Snowflake's limit falls back to the customer's own (or to none). */
function fitQueryTag(tag: string, fallback: string): string {
  return tag.length <= QUERY_TAG_LIMIT ? tag : fallback;
}

/** The SDK's log level: off unless ZLENS_SNOWFLAKE_LOG_LEVEL asks for one (ERROR, WARN, INFO, DEBUG, TRACE). */
export function snowflakeLogLevel(env: NodeJS.ProcessEnv = process.env): string {
  const asked = env.ZLENS_SNOWFLAKE_LOG_LEVEL?.trim().toUpperCase();
  return asked && ['OFF', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].includes(asked) ? asked : 'OFF';
}

function snowflakeQueryError(error: unknown, statement?: any): ConnectorQueryError {
  if (error instanceof ConnectorQueryError) return error;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  // Snowflake puts the reason on the lines after "SQL compilation error:"; a reader that keeps the
  // first line of a message would show no reason at all.
  const rawMessage = (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, ' ').trim();
  const linePosition = /line\s+(\d+)\s+(?:at\s+)?position\s+(\d+)/i.exec(rawMessage);
  const queryId = cleanErrorString(record.queryId)
    ?? cleanErrorString(record.queryID)
    ?? snowflakeStatementId(statement);
  return new ConnectorQueryError({
    driver: 'snowflake',
    message: `Snowflake query failed: ${rawMessage}`,
    vendorCode: cleanErrorString(record.code) ?? cleanErrorString(record.errno),
    sqlState: cleanErrorString(record.sqlState) ?? cleanErrorString(record.sqlstate),
    queryId,
    line: linePosition ? Number(linePosition[1]) : undefined,
    position: linePosition ? Number(linePosition[2]) : undefined,
    retryable: Boolean(record.retryable),
    cause: error instanceof Error ? error : undefined,
  });
}

function snowflakeControlError(
  vendorCode: 'TIMEOUT' | 'EXECUTION_CANCELLED',
  message: string,
): ConnectorQueryError {
  return new ConnectorQueryError({
    driver: 'snowflake',
    message,
    vendorCode,
    retryable: vendorCode === 'TIMEOUT',
  });
}

function cleanErrorString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function applySnowflakeConnectionOptions(
  connectionConfig: Record<string, unknown>,
  config: ConnectionConfig,
): void {
  const optionKeys: Array<keyof ConnectionConfig> = [
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
    'timeout',
    'workloadIdentityProvider',
    'workloadIdentityAzureClientId',
    'workloadIdentityImpersonationPath',
  ];

  for (const key of optionKeys) {
    const value = config[key];
    if (value !== undefined && value !== null && value !== '') {
      connectionConfig[key] = value;
    }
  }
}

/**
 * The token in `tokenFilePath`, read now (never cached: Snowflake's container token is rewritten every
 * few minutes). An unreadable or empty file fails the sign-in with the path, never the file's contents.
 */
export async function readSnowflakeTokenFile(tokenFilePath: string | undefined): Promise<string | undefined> {
  const path = tokenFilePath?.trim();
  if (!path) return undefined;
  const resolved = resolvePrivateKeyPath(path);
  let token: string;
  try {
    token = (await readFile(resolved, 'utf-8')).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(`Snowflake sign-in token file ${resolved} could not be read${code ? ` (${code})` : ''}.`);
  }
  if (!token) throw new Error(`Snowflake sign-in token file ${resolved} is empty.`);
  return token;
}

/**
 * A connection's key-pair private key as unencrypted PKCS#8 PEM: from `privateKeyPath` (read now; `${VAR}` and `~`
 * expand) or the pasted `privateKey`, decrypted with `privateKeyPassphrase`. Undefined when the connection has
 * neither. The Snowflake driver signs in with it, and so does Snowflake Cortex (a key-pair JWT).
 */
export async function readSnowflakePrivateKey(
  config: Pick<ConnectionConfig, 'privateKey' | 'privateKeyPath' | 'privateKeyPassphrase'>,
): Promise<string | undefined> {
  const source = config.privateKeyPath
    ? await readFile(resolvePrivateKeyPath(config.privateKeyPath), 'utf-8')
    : config.privateKey;
  return source ? normalizeSnowflakePrivateKeyForAuth(source, config.privateKeyPassphrase) : undefined;
}

function resolvePrivateKeyPath(path: string): string {
  const expandedEnv = path.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    return process.env[key] ?? match;
  });

  if (expandedEnv === '~') return homedir();
  if (expandedEnv.startsWith('~/')) return `${homedir()}${expandedEnv.slice(1)}`;
  return expandedEnv;
}

export function normalizeSnowflakePrivateKeyForAuth(
  privateKey: string,
  passphrase?: string,
): string {
  const cleaned = privateKey
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\n/g, '\n');

  try {
    const keyObject = createPrivateKey({
      key: cleaned,
      format: 'pem',
      passphrase: passphrase || undefined,
    });
    return keyObject.export({
      format: 'pem',
      type: 'pkcs8',
    }).toString();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Snowflake private key could not be parsed or decrypted. Check that the pasted key includes the full PEM header/footer, uses the matching passphrase if encrypted, and belongs to the Snowflake user. Original error: ${detail}`,
    );
  }
}

function mapSnowflakeType(sfType: string): ColumnType {
  const lower = (sfType ?? '').toLowerCase();
  // Snowflake SDK internal types: fixed, real, text, boolean, date, timestamp_ltz/ntz/tz, variant, binary
  if (['fixed', 'real', 'number', 'decimal', 'numeric', 'int', 'integer', 'bigint', 'smallint', 'tinyint', 'float', 'float4', 'float8', 'double', 'double precision'].includes(lower)) {
    return 'number';
  }
  if (lower === 'date') {
    return 'date';
  }
  if (['datetime', 'timestamp', 'timestamp_ltz', 'timestamp_ntz', 'timestamp_tz'].includes(lower)) {
    return 'datetime';
  }
  if (lower === 'boolean') {
    return 'boolean';
  }
  if (['text', 'varchar', 'char', 'character', 'string'].includes(lower)) {
    return 'string';
  }
  if (['variant', 'object', 'array'].includes(lower)) {
    return 'string';
  }
  return 'unknown';
}
