import {
  createWarehouseTargetIdentity,
  semanticExecutionFingerprint,
  type WarehouseTargetContextV1,
  type WarehouseTargetIdentityV1,
} from '@zlens/core';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';

export class WarehouseTargetIdentityObservationError extends Error {
  readonly code = 'WAREHOUSE_TARGET_IDENTITY_UNAVAILABLE';
  readonly details: { driver: string };

  constructor(driver: string, cause?: unknown) {
    super(
      `Could not observe the active ${driver} warehouse identity. `
      + 'ZLens did not save or validate a semantic target binding; test the SQL connection and retry.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'WarehouseTargetIdentityObservationError';
    this.details = { driver };
  }
}

/**
 * Acquire the redacted warehouse identity on the same connector lease used by
 * semantic validation/execution. Snowflake CURRENT_* values are authoritative;
 * configured values remain the bounded fallback for other adapters.
 */
export async function observeWarehouseTargetIdentity(
  executor: QueryExecutor,
  connection: ConnectionConfig,
): Promise<WarehouseTargetIdentityV1> {
  const configured = configuredWarehouseContext(connection);
  let observed = configured;
  if (connection.driver === 'snowflake') {
    try {
      const result = await executor.executePositional(
        `SELECT
           CURRENT_ACCOUNT() AS DQL_ACCOUNT_LOCATOR,
           CURRENT_ACCOUNT_NAME() AS DQL_ACCOUNT_NAME,
           CURRENT_ORGANIZATION_NAME() AS DQL_ORGANIZATION,
           CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME() AS DQL_ACCOUNT,
           CURRENT_DATABASE() AS DQL_DATABASE,
           CURRENT_SCHEMA() AS DQL_SCHEMA,
           CURRENT_ROLE() AS DQL_ROLE,
           CURRENT_WAREHOUSE() AS DQL_WAREHOUSE`,
        [],
        connection,
        { maxRows: 1, maxBytes: 64 * 1024, deadlineMs: 30_000 },
      );
      const row = result.rows[0];
      const accountLocator = row ? rowString(row, 'DQL_ACCOUNT_LOCATOR') : undefined;
      const accountName = row ? rowString(row, 'DQL_ACCOUNT_NAME') : undefined;
      const organization = row ? rowString(row, 'DQL_ORGANIZATION') : undefined;
      if (!row || (!accountLocator && !accountName)) {
        throw new Error('Snowflake returned no observable account identity.');
      }
      observed = {
        account: rowString(row, 'DQL_ACCOUNT')
          ?? (organization && accountName ? `${organization}-${accountName}` : accountName ?? accountLocator),
        accountLocator,
        accountName,
        organization,
        database: rowString(row, 'DQL_DATABASE') ?? configured.database,
        schema: rowString(row, 'DQL_SCHEMA') ?? configured.schema,
        role: rowString(row, 'DQL_ROLE') ?? configured.role,
        warehouse: rowString(row, 'DQL_WAREHOUSE') ?? configured.warehouse,
      };
    } catch (error) {
      throw new WarehouseTargetIdentityObservationError(connection.driver, error);
    }
  }
  return createWarehouseTargetIdentity({
    connectionRef: connectionReference(connection),
    driver: connection.driver,
    dialect: connection.driver,
    redactedContext: observed,
  });
}

export function configuredWarehouseTargetIdentity(
  connection: ConnectionConfig,
): WarehouseTargetIdentityV1 {
  return createWarehouseTargetIdentity({
    connectionRef: connectionReference(connection),
    driver: connection.driver,
    dialect: connection.driver,
    redactedContext: configuredWarehouseContext(connection),
  });
}

export function connectionReference(connection: ConnectionConfig): string {
  return `connection:${semanticExecutionFingerprint({
    driver: connection.driver,
    host: connection.host,
    account: connection.account,
    database: connection.database,
    catalog: connection.catalog,
    schema: connection.schema,
    role: connection.role,
    warehouse: connection.warehouse,
    filepath: connection.filepath,
    // A file connection's folder of data files is its database; absent elsewhere, so other references keep their value.
    ...(connection.dataFolder ? { dataFolder: connection.dataFolder } : {}),
    projectId: connection.projectId,
    httpPath: connection.httpPath,
  }).slice(0, 24)}`;
}

function configuredWarehouseContext(connection: ConnectionConfig): WarehouseTargetContextV1 {
  // DuckDB/file/sqlite targets have no server-side CURRENT_* identity. Bind a
  // redacted stable marker for the configured local database so target A and
  // target B cannot collapse into one empty-context fingerprint. The marker
  // is a one-way digest, never a filesystem path exposed to a receipt/UI.
  const localDatabase = connection.driver === 'file' && connection.dataFolder && (!connection.filepath || connection.filepath === ':memory:')
    ? connection.dataFolder
    : (connection.driver === 'duckdb' || connection.driver === 'file')
    ? connection.filepath
    : connection.driver === 'sqlite'
      ? connection.database
      : undefined;
  const localCatalog = localDatabase && localDatabase !== ':memory:'
    ? `LOCAL_${semanticExecutionFingerprint({ driver: connection.driver, localDatabase }).slice(0, 24)}`
    : undefined;
  return {
    account: connection.driver === 'snowflake'
      ? normalizeConfiguredSnowflakeAccount(connection.account ?? connection.host)
      : connection.account ?? connection.host,
    database: connection.database,
    catalog: connection.catalog ?? localCatalog,
    schema: connection.schema,
    role: connection.role,
    warehouse: connection.warehouse,
  };
}

function normalizeConfiguredSnowflakeAccount(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
  const withoutPath = withoutProtocol.split('/')[0]?.split(':')[0];
  return withoutPath?.replace(/\.snowflakecomputing\.com$/i, '') || undefined;
}

function rowString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key] ?? row[key.toLowerCase()];
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

/**
 * Name the fields on which dbt's default target and the active ZLens connection
 * disagree.
 *
 * MetricFlow will only be treated as executable when the two identities match,
 * because compiling against one warehouse and executing against another is not
 * a governed answer. When they differ, every metric reports as unrunnable and
 * the message blames the engine — which is installed and working. Saying which
 * field differs turns an unfalsifiable "not ready" into a one-line fix.
 */
export function describeWarehouseTargetIdentityMismatch(
  expected: WarehouseTargetIdentityV1,
  actual: WarehouseTargetIdentityV1,
  profile?: { profileName?: string; targetName?: string },
): string {
  const fields: Array<keyof WarehouseTargetContextV1> = [
    'account', 'database', 'schema', 'role', 'warehouse', 'catalog',
  ];
  const differences = fields.flatMap((field) => {
    const left = expected.redactedContext[field];
    const right = actual.redactedContext[field];
    if (!left && !right) return [];
    if ((left ?? '').toLowerCase() === (right ?? '').toLowerCase()) return [];
    return [`${field}: dbt uses ${left ?? '(unset)'}, ZLens uses ${right ?? '(unset)'}`];
  });
  const where = profile?.profileName && profile?.targetName
    ? `dbt profile "${profile.profileName}" target "${profile.targetName}"`
    : 'the dbt default target';
  if (differences.length === 0) {
    return `MetricFlow is installed, but ${where} and the active ZLens connection resolve to different warehouse identities.`
      + ' Point the ZLens connection at the same target dbt uses, or change dbt\'s default target.';
  }
  return `MetricFlow is installed, but ${where} does not match the active ZLens connection (${differences.join('; ')}).`
    + ' A semantic query must compile and execute against the same warehouse, so ZLens will not run it until they agree.';
}
