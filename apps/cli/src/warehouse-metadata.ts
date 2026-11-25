import { createHash } from 'node:crypto';
import {
  SCHEMA_SYNC_SOURCE,
  latestRuntimeSchemaSnapshotForProject,
  recordRuntimeSchemaSnapshot,
  type RuntimeSchemaObservedTarget,
  type RuntimeSchemaScope,
  type RuntimeSchemaSnapshot,
  type RuntimeSchemaTable,
  parsePhysicalIdentifier,
} from '@zlens/agent';
import { configuredCatalogs, readDataFolder, type ConnectionConfig, type QueryExecutor } from '@zlens/connectors';
import { isAbsolute } from 'node:path';
import { observeWarehouseTargetIdentity } from './semantic-execution/connection-identity.js';

export type ConnectionMetadataScopeMode = 'dbt_relations' | 'selected_scopes' | 'dbt_plus_selected';

export interface ConnectionMetadataScopeV1 {
  version: 1;
  connectionId: string;
  driver: string;
  mode: ConnectionMetadataScopeMode;
  /** Effective union used for status and provenance. */
  scopes: RuntimeSchemaScope[];
  /** User-selected scopes, kept distinct so dbt_plus_selected stays exact for dbt relations. */
  selectedScopes: RuntimeSchemaScope[];
  /** Exact fully-qualified dbt relations used by the recommended default mode. */
  relations: string[];
  dbtFingerprint?: string;
  scopeFingerprint: string;
}

export interface ConnectionMetadataScopeInput {
  mode?: ConnectionMetadataScopeMode;
  scopes?: Array<{
    catalogOrDatabase?: string;
    schemas?: string[];
  }>;
  relations?: string[];
  dbtFingerprint?: string;
}

export interface WarehouseMetadataSyncResult {
  scope: ConnectionMetadataScopeV1;
  snapshot: RuntimeSchemaSnapshot;
}

export interface WarehouseMetadataStatus {
  state: 'missing' | 'ready' | 'stale';
  scopeFingerprint?: string;
  generationId?: string;
  capturedAt?: string;
  relationCount: number;
  columnCount: number;
  queryCount?: number;
  durationMs?: number;
  truncated?: boolean;
  source?: string;
  scopes: RuntimeSchemaScope[];
  observedTarget?: RuntimeSchemaObservedTarget;
}

/**
 * How big a schema is, from the warehouse's own catalog (no table is read):
 * what the schema picker shows so a person can start small (onboarding
 * design P1). Rows and bytes are what the warehouse reports for its tables;
 * a view has neither.
 */
export interface WarehouseSchemaSize {
  /** Tables and views. */
  tables: number;
  views: number;
  /** Columns of those tables and views, when the warehouse lists them. */
  columns?: number;
  rows?: number;
  bytes?: number;
  /** Tables with a declared primary key or unique constraint: their keys need no check. */
  tablesWithKeys: number;
  foreignKeys: number;
  /** Tables over the full-check row budget (CHECK_ROW_BUDGET). */
  largeTables?: number;
  largestTableRows?: number;
}

export interface WarehouseMetadataDiscoveredSchema {
  name: string;
  inDbtProject: boolean;
  dbtRelationCount: number;
  /** Present when the warehouse could say (Snowflake, DuckDB, PostgreSQL). */
  size?: WarehouseSchemaSize;
}

export interface WarehouseMetadataDiscoveredScope {
  catalogOrDatabase: string;
  schemas: WarehouseMetadataDiscoveredSchema[];
}

export interface WarehouseMetadataDiscoveryResult {
  version: 1;
  connectionId: string;
  driver: string;
  discoveredAt: string;
  supported: boolean;
  scopes: WarehouseMetadataDiscoveredScope[];
  dbtScopes: RuntimeSchemaScope[];
  queryCount: number;
  truncated: boolean;
  message: string;
  /** What one Apply and synchronize can read, so the picker says so before a choice fails. */
  limits?: { tables: number; columnsPerDatabase: number; checkRowBudget: number };
  /** Databases whose sizes could not be read (their schemas are listed without sizes). */
  sizesUnavailable?: string[];
}

/** The row budget of a full data check (onboarding design D5); the picker counts the tables above it. */
export const CHECK_ROW_BUDGET = 10_000_000;

// The scope a sync reads matches what discovery can list (40 databases, 1,000
// schemas). A scope past these limits fails with a message; nothing is
// dropped without saying so, which used to leave a large warehouse half read.
const MAX_SCOPES = 40;
const MAX_SCHEMAS = 1_000;
/** One query lists dbt tables by name up to this many; a larger project reads their whole schemas. */
const MAX_RELATIONS = 5_000;
const MAX_TABLES = 10_000;
const MAX_COLUMNS_PER_TABLE = 160;
const MAX_METADATA_ROWS_PER_QUERY = 50_000;
const MAX_METADATA_BYTES_PER_QUERY = 24 * 1024 * 1024;
const METADATA_QUERY_DEADLINE_MS = 60_000;
const MAX_DISCOVERY_CATALOGS = 40;
const MAX_DISCOVERY_SCHEMAS = 1_000;
const DISCOVERY_DEADLINE_MS = 30_000;

export function normalizeConnectionMetadataScope(
  connectionId: string,
  connection: ConnectionConfig,
  input: ConnectionMetadataScopeInput | undefined,
  defaults: { relations?: string[]; dbtFingerprint?: string } = {},
): ConnectionMetadataScopeV1 {
  const defaultDatabase = configuredCatalog(connection);
  const defaultSchema = configuredSchema(connection);
  const mode = input?.mode
    ?? ((defaults.relations?.length ?? input?.relations?.length ?? 0) > 0
      ? 'dbt_relations'
      : 'selected_scopes');
  const currentDbtRelations = (defaults.relations?.length ?? 0) > 0
    ? defaults.relations!
    : input?.relations ?? [];
  const dbtRelations = uniqueStrings(
    mode === 'selected_scopes' ? [] : currentDbtRelations,
  )
    // Each part unquoted, its case kept; a dot inside a quoted part stays (simplification plan Z1).
    .map((value) => parsePhysicalIdentifier(value).map((part) => part.value).join('.'))
    .filter(Boolean);
  // Past MAX_RELATIONS the list of tables by name makes one query too long:
  // read the whole schemas those tables are in instead, so none is left out.
  const relations = dbtRelations.length > MAX_RELATIONS ? [] : dbtRelations;
  const explicitScopes = normalizeScopes(input?.scopes ?? []);
  const relationScopes = scopesFromRelations(dbtRelations, defaultDatabase, defaultSchema);
  const fallbackScopes = defaultDatabase && defaultSchema
    ? [{ catalogOrDatabase: defaultDatabase, schemas: [defaultSchema] }, ...dataFolderCatalogScopes(connection)]
    : [];
  const scopes = normalizeScopes(
    mode === 'dbt_relations'
      ? relationScopes.length > 0 ? relationScopes : fallbackScopes
      : mode === 'dbt_plus_selected'
        ? relationScopes.length > 0 || explicitScopes.length > 0
          ? [...relationScopes, ...explicitScopes]
          : fallbackScopes
        : explicitScopes.length > 0 ? explicitScopes : fallbackScopes,
  );
  if (scopes.length === 0) {
    throw new Error(
      `Metadata scope for ${connection.driver} requires an explicit database/catalog and schema, `
      + 'or at least one fully qualified dbt relation.',
    );
  }
  const dbtFingerprint = defaults.dbtFingerprint ?? input?.dbtFingerprint;
  const identity = redactedConnectionIdentity(connection);
  const scopeFingerprint = sha256(stableSerialize({
    version: 1,
    connectionId,
    driver: connection.driver,
    identity,
    mode,
    scopes,
    selectedScopes: explicitScopes,
    relations,
    dbtFingerprint,
  }));
  return {
    version: 1,
    connectionId,
    driver: connection.driver,
    mode,
    scopes,
    selectedScopes: explicitScopes,
    relations,
    dbtFingerprint,
    scopeFingerprint,
  };
}

export async function syncWarehouseMetadata(input: {
  projectRoot: string;
  executor: QueryExecutor;
  connection: ConnectionConfig;
  scope: ConnectionMetadataScopeV1;
}): Promise<WarehouseMetadataSyncResult> {
  const startedAt = Date.now();
  const observedIdentity = await observeWarehouseTargetIdentity(input.executor, input.connection);
  assertObservedScopeCompatible(input.connection, observedIdentity.redactedContext);
  const observedTarget: RuntimeSchemaObservedTarget = {
    driver: input.connection.driver,
    accountOrWorkspace: observedIdentity.redactedContext.account,
    role: observedIdentity.redactedContext.role,
    warehouse: observedIdentity.redactedContext.warehouse,
    defaultCatalogOrDatabase: observedIdentity.redactedContext.catalog ?? observedIdentity.redactedContext.database,
    defaultSchema: observedIdentity.redactedContext.schema,
  };
  const queries = buildWarehouseMetadataQueries(input.connection, input.scope);
  const tables = new Map<string, RuntimeSchemaTable>();
  let queryCount = 0;
  let truncated = false;
  for (const query of queries) {
    const options = {
      maxRows: MAX_METADATA_ROWS_PER_QUERY,
      maxBytes: MAX_METADATA_BYTES_PER_QUERY,
      batchSize: 1_000,
      deadlineMs: METADATA_QUERY_DEADLINE_MS,
      // Schema only: a host's row policy (RFC 0010) can tell it from data.
      purpose: 'metadata' as const,
    };
    let result: Awaited<ReturnType<QueryExecutor['executePositional']>>;
    try {
      result = await input.executor.executePositional(query.sql, [], input.connection, options);
    } catch (error) {
      // SQLite reads every relation's columns in one statement, so a single
      // broken view (one naming a column that no longer exists) fails them
      // all. Read the relations one at a time instead and leave the broken
      // ones out: they cannot be queried anyway.
      if (input.connection.driver !== 'sqlite') throw error;
      result = await sqliteColumnsOneByOne(input.executor, input.connection, query.catalogOrDatabase, options);
    }
    queryCount += 1;
    truncated ||= result.truncated === true || result.rows.length >= MAX_METADATA_ROWS_PER_QUERY;
    for (const row of result.rows) {
      addMetadataRow(tables, row, query.catalogOrDatabase, input.connection.driver);
      if (tables.size >= MAX_TABLES) {
        truncated = true;
        break;
      }
    }
    if (tables.size >= MAX_TABLES) break;
  }
  const capturedAt = new Date().toISOString();
  const normalizedTables = Array.from(tables.values())
    .sort((left, right) => left.relation.localeCompare(right.relation))
    .slice(0, MAX_TABLES);
  if (truncated) {
    throw new Error(
      'Warehouse metadata exceeded the bounded synchronization limits. '
      + 'Narrow the selected databases/schemas before retrying; the previous active generation was preserved.',
    );
  }
  if (normalizedTables.length === 0) {
    throw new Error(
      'Warehouse metadata synchronization returned no authorized relations. '
      + 'Verify the selected scope and warehouse permissions; the previous active generation was preserved.',
    );
  }
  const generationId = `warehouse_${sha256(stableSerialize({
    scopeFingerprint: input.scope.scopeFingerprint,
    observedIdentity: observedIdentity.identityFingerprint,
    tables: normalizedTables,
  })).slice(0, 32)}`;
  const snapshot = recordRuntimeSchemaSnapshot(input.projectRoot, {
    version: 1,
    generationId,
    scopeFingerprint: input.scope.scopeFingerprint,
    connectionId: input.scope.connectionId,
    status: 'ready',
    source: SCHEMA_SYNC_SOURCE,
    capturedAt,
    observedTarget,
    scopes: input.scope.scopes,
    queryCount,
    durationMs: Date.now() - startedAt,
    tables: normalizedTables,
  });
  return { scope: input.scope, snapshot };
}

/**
 * Explicit setup-time discovery of database/catalog and schema names visible to
 * the configured connection. This is never called by Ask and never persists or
 * broadens a metadata scope. The user must still select and apply additional
 * non-dbt schemas before DQL indexes their tables and columns.
 */
export async function discoverWarehouseMetadataScopes(input: {
  connectionId: string;
  executor: QueryExecutor;
  connection: ConnectionConfig;
  dbtRelations?: string[];
  /**
   * Also read each schema's size from the warehouse's catalog: one query per
   * database (one in all on DuckDB). `databases` limits it to those named
   * (the ZLens app for Snowflake sizes only the databases granted to it).
   */
  sizes?: boolean | { databases?: string[] };
  signal?: AbortSignal;
}): Promise<WarehouseMetadataDiscoveryResult> {
  const observedIdentity = await observeWarehouseTargetIdentity(input.executor, input.connection);
  assertObservedScopeCompatible(input.connection, observedIdentity.redactedContext);
  const dbtScopes = scopesFromRelations(
    input.dbtRelations ?? [],
    configuredCatalog(input.connection),
    configuredSchema(input.connection),
  );
  const dbtCounts = dbtRelationCountsByScope(input.dbtRelations ?? [], input.connection);
  const discovered = new Map<string, { catalogOrDatabase: string; schemas: Map<string, string> }>();
  let queryCount = 0;
  let truncated = false;
  let supported = true;

  const add = (catalogValue: string | undefined, schemaValue: string | undefined): void => {
    const catalogOrDatabase = cleanIdentifier(catalogValue);
    const schema = cleanIdentifier(schemaValue);
    if (!catalogOrDatabase || !schema || isSystemSchema(schema)) return;
    const catalogKey = normalizeIdentifierKey(catalogOrDatabase);
    const current = discovered.get(catalogKey) ?? {
      catalogOrDatabase,
      schemas: new Map<string, string>(),
    };
    if (current.schemas.size < MAX_SCHEMAS) {
      current.schemas.set(normalizeIdentifierKey(schema), schema);
    } else {
      truncated = true;
    }
    discovered.set(catalogKey, current);
  };

  if (input.connection.driver === 'snowflake') {
    const result = await input.executor.executePositional(
      `SHOW TERSE SCHEMAS IN ACCOUNT LIMIT ${MAX_DISCOVERY_SCHEMAS}`,
      [],
      input.connection,
      discoveryQueryOptions(),
    );
    queryCount += 1;
    truncated ||= result.truncated === true || result.rows.length >= MAX_DISCOVERY_SCHEMAS;
    for (const row of result.rows) {
      add(
        firstRowString(row, ['database_name', 'database', 'catalog_name']),
        firstRowString(row, ['name', 'schema_name', 'schema']),
      );
    }
  } else if (input.connection.driver === 'databricks') {
    const catalogsResult = await input.executor.executePositional(
      'SHOW CATALOGS',
      [],
      input.connection,
      discoveryQueryOptions(),
    );
    queryCount += 1;
    const catalogs = uniqueStrings(catalogsResult.rows
      .map((row) => firstRowString(row, ['catalog', 'catalog_name', 'catalogName']))
      .filter((value): value is string => Boolean(value)));
    truncated ||= catalogsResult.truncated === true || catalogs.length > MAX_DISCOVERY_CATALOGS;
    for (const catalog of catalogs.slice(0, MAX_DISCOVERY_CATALOGS)) {
      const schemasResult = await input.executor.executePositional(
        `SHOW SCHEMAS IN ${quoteIdentifier(catalog, '`')}`,
        [],
        input.connection,
        discoveryQueryOptions(),
      );
      queryCount += 1;
      truncated ||= schemasResult.truncated === true;
      for (const row of schemasResult.rows) {
        add(
          catalog,
          firstRowString(row, ['databaseName', 'schema_name', 'schema', 'namespace', 'name']),
        );
      }
    }
  } else {
    // Other drivers: information_schema.schemata where the driver has it
    // (DuckDB, PostgreSQL, Redshift, MySQL, SQL Server), SQLite's attached
    // databases, else the connection's own database and schema.
    const listed = await listSchemasGenerically(input.executor, input.connection).catch(() => undefined);
    if (listed && listed.length > 0) {
      queryCount += 1;
      for (const row of listed) add(row.catalog, row.schema);
    } else {
      supported = false;
      add(
        configuredCatalog(input.connection),
        configuredSchema(input.connection),
      );
    }
  }

  let sized: Awaited<ReturnType<typeof readSchemaSizes>> | undefined;
  if (input.sizes && supported) {
    const only = typeof input.sizes === 'object' && input.sizes.databases
      ? new Set(input.sizes.databases.map(normalizeIdentifierKey))
      : undefined;
    const catalogs = Array.from(discovered.values())
      .map((scope) => scope.catalogOrDatabase)
      .filter((catalog) => !only || only.has(normalizeIdentifierKey(catalog)));
    sized = await readSchemaSizes(input.executor, input.connection, catalogs, input.signal);
    queryCount += sized.queryCount;
  }

  const scopes = Array.from(discovered.values())
    .map((scope) => ({
      catalogOrDatabase: scope.catalogOrDatabase,
      schemas: Array.from(scope.schemas.values())
        .sort((left, right) => left.localeCompare(right))
        .map((schema): WarehouseMetadataDiscoveredSchema => {
          const count = dbtCounts.get(scopeKey(scope.catalogOrDatabase, schema)) ?? 0;
          const size = sized?.sizes.get(scopeKey(scope.catalogOrDatabase, schema));
          return {
            name: schema,
            inDbtProject: count > 0,
            dbtRelationCount: count,
            ...(size ? { size } : {}),
          };
        }),
    }))
    .filter((scope) => scope.schemas.length > 0)
    .sort((left, right) => left.catalogOrDatabase.localeCompare(right.catalogOrDatabase));
  const additionalCount = scopes.reduce(
    (count, scope) => count + scope.schemas.filter((schema) => !schema.inDbtProject).length,
    0,
  );

  return {
    version: 1,
    connectionId: input.connectionId,
    driver: input.connection.driver,
    discoveredAt: new Date().toISOString(),
    supported,
    scopes,
    dbtScopes,
    queryCount,
    truncated,
    // A project without dbt relations has no "dbt project" to be outside of.
    message: !supported
      ? 'Live catalog discovery is not available for this connector. The configured database and schema are shown when available.'
      : dbtScopes.length > 0
        ? `Found ${additionalCount} additional schema${additionalCount === 1 ? '' : 's'} outside the dbt project. Nothing was added or synchronized.`
        : `Found ${additionalCount} schema${additionalCount === 1 ? '' : 's'}. Choose the ones ZLens should read, then Apply and synchronize.`,
    limits: { tables: MAX_TABLES, columnsPerDatabase: MAX_METADATA_ROWS_PER_QUERY, checkRowBudget: CHECK_ROW_BUDGET },
    ...(sized?.unavailable.length ? { sizesUnavailable: sized.unavailable } : {}),
  };
}

const SIZE_QUERY_DEADLINE_MS = 20_000;
const SIZE_QUERY_CONCURRENCY = 4;

/**
 * Each schema's size, from the catalog only: Snowflake's INFORMATION_SCHEMA
 * (TABLES, TABLE_CONSTRAINTS, COLUMNS) in one statement per database, DuckDB's
 * duckdb_tables() and duckdb_views() in one statement, PostgreSQL's pg_class
 * estimates in one statement. Other warehouses list no sizes. A database whose
 * sizes cannot be read is named in `unavailable`; its schemas are still listed.
 */
export async function readSchemaSizes(
  executor: QueryExecutor,
  connection: ConnectionConfig,
  catalogs: string[],
  signal?: AbortSignal,
): Promise<{ sizes: Map<string, WarehouseSchemaSize>; queryCount: number; unavailable: string[] }> {
  const sizes = new Map<string, WarehouseSchemaSize>();
  const unavailable: string[] = [];
  let queryCount = 0;
  const options = {
    maxRows: MAX_DISCOVERY_SCHEMAS,
    maxBytes: 2 * 1024 * 1024,
    batchSize: 500,
    deadlineMs: SIZE_QUERY_DEADLINE_MS,
    purpose: 'metadata' as const,
    ...(signal ? { signal } : {}),
  };
  const take = (rows: Array<Record<string, unknown>>, fallbackCatalog?: string) => {
    for (const row of rows) {
      const catalog = rowString(row, 'table_catalog') ?? fallbackCatalog;
      const schema = rowString(row, 'table_schema');
      if (!catalog || !schema || isSystemSchema(schema)) continue;
      sizes.set(scopeKey(catalog, schema), schemaSizeFromRow(row));
    }
  };
  const driver = connection.driver;
  if (driver === 'snowflake') {
    const queue = [...catalogs];
    const worker = async () => {
      for (let catalog = queue.shift(); catalog !== undefined; catalog = queue.shift()) {
        if (signal?.aborted) return;
        // With the column counts first; INFORMATION_SCHEMA.COLUMNS can refuse a very large database, so then without.
        let done = false;
        for (const withColumns of [true, false]) {
          try {
            queryCount += 1;
            const result = await executor.executePositional(snowflakeSchemaSizeSql(catalog, withColumns), [], connection, options);
            take(result.rows, catalog);
            done = true;
            break;
          } catch {
            if (signal?.aborted) return;
          }
        }
        if (!done) unavailable.push(catalog);
      }
    };
    await Promise.all(Array.from({ length: Math.min(SIZE_QUERY_CONCURRENCY, queue.length) }, worker));
  } else if (driver === 'duckdb' || driver === 'file') {
    try {
      queryCount += 1;
      const result = await executor.executePositional(DUCKDB_SCHEMA_SIZE_SQL, [], connection, options);
      const wanted = new Set(catalogs.map(normalizeIdentifierKey));
      take(result.rows.filter((row) => {
        const catalog = rowString(row, 'table_catalog');
        return catalog !== undefined && wanted.has(normalizeIdentifierKey(catalog));
      }));
    } catch {
      unavailable.push(...catalogs);
    }
  } else if (driver === 'postgresql') {
    try {
      queryCount += 1;
      const result = await executor.executePositional(POSTGRES_SCHEMA_SIZE_SQL, [], connection, options);
      take(result.rows);
    } catch {
      unavailable.push(...catalogs);
    }
  }
  return { sizes, queryCount, unavailable };
}

function snowflakeSchemaSizeSql(catalog: string, withColumns: boolean): string {
  const db = quoteIdentifier(catalog, '"');
  return [
    'WITH t AS (',
    `  SELECT table_schema, table_name, table_type, row_count, bytes FROM ${db}.INFORMATION_SCHEMA.TABLES WHERE table_schema <> 'INFORMATION_SCHEMA'`,
    '), k AS (',
    "  SELECT table_schema, table_name, MAX(IFF(constraint_type IN ('PRIMARY KEY', 'UNIQUE'), 1, 0)) AS has_key, SUM(IFF(constraint_type = 'FOREIGN KEY', 1, 0)) AS foreign_keys",
    `  FROM ${db}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE table_schema <> 'INFORMATION_SCHEMA' GROUP BY table_schema, table_name`,
    ...(withColumns
      ? ['), c AS (', `  SELECT table_schema, COUNT(*) AS column_count FROM ${db}.INFORMATION_SCHEMA.COLUMNS WHERE table_schema <> 'INFORMATION_SCHEMA' GROUP BY table_schema`]
      : []),
    ')',
    `SELECT ${sqlLiteral(catalog)} AS table_catalog, t.table_schema, COUNT(*) AS table_count, COUNT_IF(t.table_type ILIKE '%VIEW%') AS view_count,`,
    '  SUM(t.row_count) AS row_count, SUM(t.bytes) AS bytes, COUNT_IF(k.has_key = 1) AS keyed_table_count, COALESCE(SUM(k.foreign_keys), 0) AS foreign_key_count,',
    `  COUNT_IF(t.row_count > ${CHECK_ROW_BUDGET}) AS large_table_count, MAX(t.row_count) AS largest_table_rows`,
    withColumns ? '  , MAX(c.column_count) AS column_count' : '',
    'FROM t LEFT JOIN k ON k.table_schema = t.table_schema AND k.table_name = t.table_name',
    withColumns ? 'LEFT JOIN c ON c.table_schema = t.table_schema' : '',
    'GROUP BY t.table_schema',
    `LIMIT ${MAX_DISCOVERY_SCHEMAS}`,
  ].filter(Boolean).join('\n');
}

// DuckDB: estimated_size is DuckDB's own row estimate; a view (a data file read in place) has none.
const DUCKDB_SCHEMA_SIZE_SQL = [
  'SELECT database_name AS table_catalog, schema_name AS table_schema, COUNT(*) AS table_count, SUM(is_view) AS view_count,',
  '  SUM(estimated_size) AS row_count, SUM(has_key) AS keyed_table_count, SUM(column_count) AS column_count,',
  `  SUM(CASE WHEN estimated_size > ${CHECK_ROW_BUDGET} THEN 1 ELSE 0 END) AS large_table_count, MAX(estimated_size) AS largest_table_rows,`,
  "  (SELECT COUNT(*) FROM duckdb_constraints() AS k WHERE k.database_name = s.database_name AND k.schema_name = s.schema_name AND k.constraint_type = 'FOREIGN KEY') AS foreign_key_count",
  'FROM (',
  '  SELECT database_name, schema_name, 0 AS is_view, estimated_size, CASE WHEN has_primary_key THEN 1 ELSE 0 END AS has_key, column_count FROM duckdb_tables() WHERE NOT internal AND NOT temporary',
  '  UNION ALL',
  '  SELECT database_name, schema_name, 1 AS is_view, NULL AS estimated_size, 0 AS has_key, column_count FROM duckdb_views() WHERE NOT internal AND NOT temporary',
  ') AS s',
  "WHERE database_name NOT IN ('system', 'temp')",
  'GROUP BY database_name, schema_name',
  `LIMIT ${MAX_DISCOVERY_SCHEMAS}`,
].join('\n');

// PostgreSQL: reltuples is the planner's row estimate (-1 before a first ANALYZE).
const POSTGRES_SCHEMA_SIZE_SQL = [
  'SELECT current_database() AS table_catalog, n.nspname AS table_schema,',
  '  COUNT(*) AS table_count,',
  "  COUNT(*) FILTER (WHERE c.relkind IN ('v', 'm')) AS view_count,",
  "  SUM(GREATEST(c.reltuples, 0)) FILTER (WHERE c.relkind IN ('r', 'p', 'm')) AS row_count,",
  "  SUM(pg_total_relation_size(c.oid)) FILTER (WHERE c.relkind IN ('r', 'p', 'm')) AS bytes,",
  "  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM pg_constraint AS k WHERE k.conrelid = c.oid AND k.contype IN ('p', 'u'))) AS keyed_table_count,",
  "  (SELECT COUNT(*) FROM pg_constraint AS f JOIN pg_class AS fc ON fc.oid = f.conrelid WHERE f.contype = 'f' AND fc.relnamespace = n.oid) AS foreign_key_count,",
  "  (SELECT COUNT(*) FROM pg_attribute AS a JOIN pg_class AS ac ON ac.oid = a.attrelid WHERE ac.relnamespace = n.oid AND ac.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT ac.relispartition AND a.attnum > 0 AND NOT a.attisdropped) AS column_count,",
  `  COUNT(*) FILTER (WHERE c.reltuples > ${CHECK_ROW_BUDGET}) AS large_table_count,`,
  '  MAX(GREATEST(c.reltuples, 0)) AS largest_table_rows',
  'FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace',
  "WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition",
  "  AND n.nspname NOT IN ('information_schema', 'pg_catalog', 'pg_toast') AND n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'",
  'GROUP BY n.oid, n.nspname',
  `LIMIT ${MAX_DISCOVERY_SCHEMAS}`,
].join('\n');

function schemaSizeFromRow(row: Record<string, unknown>): WarehouseSchemaSize {
  const count = (key: string): number | undefined => {
    const value = rowValue(row, key);
    if (value === null || value === undefined || value === '') return undefined;
    const number = typeof value === 'bigint' ? Number(value) : Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : undefined;
  };
  const optional = (key: string, value: number | undefined) => (value === undefined ? {} : { [key]: value });
  return {
    tables: count('table_count') ?? 0,
    views: count('view_count') ?? 0,
    ...optional('columns', count('column_count')),
    ...optional('rows', count('row_count')),
    ...optional('bytes', count('bytes')),
    tablesWithKeys: count('keyed_table_count') ?? 0,
    foreignKeys: count('foreign_key_count') ?? 0,
    ...optional('largeTables', count('large_table_count')),
    ...optional('largestTableRows', count('largest_table_rows')),
  };
}

function rowValue(row: Record<string, unknown>, key: string): unknown {
  const expected = key.toLowerCase();
  for (const [rowKey, value] of Object.entries(row)) {
    if (rowKey.toLowerCase() === expected) return value;
  }
  return undefined;
}

export function warehouseMetadataStatus(
  projectRoot: string,
  expectedScopeFingerprint?: string,
  connectionId?: string,
): WarehouseMetadataStatus {
  const snapshot = latestRuntimeSchemaSnapshotForProject(projectRoot, connectionId);
  if (!snapshot) {
    return { state: 'missing', relationCount: 0, columnCount: 0, scopes: [] };
  }
  const stale = Boolean(
    expectedScopeFingerprint
    && expectedScopeFingerprint !== snapshot.scopeFingerprint
  );
  return {
    state: stale || snapshot.status === 'stale' ? 'stale' : 'ready',
    scopeFingerprint: snapshot.scopeFingerprint,
    generationId: snapshot.generationId,
    capturedAt: snapshot.capturedAt,
    relationCount: snapshot.tables.length,
    columnCount: snapshot.tables.reduce((count, table) => count + table.columns.length, 0),
    queryCount: snapshot.queryCount,
    durationMs: snapshot.durationMs,
    truncated: snapshot.truncated,
    source: snapshot.source,
    scopes: snapshot.scopes ?? [],
    observedTarget: snapshot.observedTarget,
  };
}

export function buildWarehouseMetadataQueries(
  connection: ConnectionConfig,
  scope: ConnectionMetadataScopeV1,
): Array<{ catalogOrDatabase: string; sql: string }> {
  const relationsByScope = groupRelations(scope.relations, connection);
  const selectedSchemasByScope = new Map(
    scope.selectedScopes.map((selected) => [
      normalizeIdentifierKey(selected.catalogOrDatabase),
      selected.schemas,
    ]),
  );
  return scope.scopes.flatMap((selected) => {
    const catalogOrDatabase = selected.catalogOrDatabase;
    if (connection.driver === 'sqlite') {
      // SQLite has no information_schema: each attached database is one
      // schema, read from its sqlite_master and pragma_table_info.
      const literal = `'${catalogOrDatabase.replace(/'/g, "''")}'`;
      return [{
        catalogOrDatabase,
        sql: [
          `SELECT ${literal} AS table_catalog, ${literal} AS table_schema, m.name AS table_name, p.name AS column_name, p.type AS data_type, p.cid + 1 AS ordinal_position`,
          `FROM "${catalogOrDatabase.replace(/"/g, '""')}".sqlite_master AS m JOIN pragma_table_info(m.name, ${literal}) AS p`,
          `WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%'`,
          'ORDER BY m.name, p.cid',
          `LIMIT ${MAX_METADATA_ROWS_PER_QUERY}`,
        ].join('\n'),
      }];
    }
    const exactRelations = relationsByScope.get(normalizeIdentifierKey(catalogOrDatabase)) ?? [];
    const exactPredicate = scope.mode !== 'selected_scopes' && exactRelations.length > 0
      ? buildExactRelationPredicate(exactRelations)
      : undefined;
    const schemaPredicate = buildSchemaPredicate(
      scope.mode === 'dbt_plus_selected'
        ? selectedSchemasByScope.get(normalizeIdentifierKey(catalogOrDatabase)) ?? []
        : selected.schemas,
    );
    const predicate = scope.mode === 'dbt_plus_selected' && exactPredicate && schemaPredicate
      ? `(${exactPredicate} OR ${schemaPredicate})`
      : exactPredicate ?? schemaPredicate;
    if (!predicate) return [];
    const top = connection.driver === 'mssql' || connection.driver === 'fabric';
    const duckdb = connection.driver === 'duckdb' || connection.driver === 'file';
    return [{
      catalogOrDatabase,
      sql: [
        `SELECT ${top ? `TOP (${MAX_METADATA_ROWS_PER_QUERY}) ` : ''}table_catalog, table_schema, table_name, column_name, data_type, ordinal_position${duckdb ? ', current_database() AS current_catalog' : ''}`,
        `FROM ${informationSchemaColumnsRelation(connection, catalogOrDatabase)}`,
        `WHERE ${predicate}`,
        ...(duckdb ? [`  AND ${duckdbCatalogScopePredicate('table_catalog', catalogOrDatabase)}`] : []),
        // An Iceberg catalog's table not looked up yet lists DuckDB's placeholder column, never a real one.
        ...(duckdb ? [`  AND NOT (column_name = '__' AND data_type = 'UNKNOWN')`] : []),
        `  AND UPPER(table_schema) NOT IN ('INFORMATION_SCHEMA', 'PG_CATALOG')`,
        'ORDER BY table_schema, table_name, ordinal_position',
        ...(top ? [] : [`LIMIT ${MAX_METADATA_ROWS_PER_QUERY}`]),
      ].join('\n'),
    }];
  });
}

/** SQLite columns relation by relation, skipping any relation SQLite cannot describe. */
export async function sqliteColumnsOneByOne(
  executor: QueryExecutor,
  connection: ConnectionConfig,
  catalogOrDatabase: string,
  options: Parameters<QueryExecutor['executePositional']>[3],
): Promise<Awaited<ReturnType<QueryExecutor['executePositional']>>> {
  const literal = `'${catalogOrDatabase.replace(/'/g, "''")}'`;
  const listed = await executor.executePositional(
    `SELECT name FROM "${catalogOrDatabase.replace(/"/g, '""')}".sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    [],
    connection,
    options,
  );
  const rows: Array<Record<string, unknown>> = [];
  for (const row of listed.rows as Array<Record<string, unknown>>) {
    const name = String(row.name ?? '');
    if (!name) continue;
    try {
      const columns = await executor.executePositional(
        `SELECT ${literal} AS table_catalog, ${literal} AS table_schema, '${name.replace(/'/g, "''")}' AS table_name, name AS column_name, type AS data_type, "notnull" AS not_null, pk AS pk_position, cid + 1 AS ordinal_position FROM pragma_table_info('${name.replace(/'/g, "''")}', ${literal})`,
        [],
        connection,
        options,
      );
      rows.push(...(columns.rows as Array<Record<string, unknown>>));
    } catch {
      // A relation SQLite cannot describe (a broken view) is left out.
    }
  }
  return { ...listed, rows, rowCount: rows.length } as Awaited<ReturnType<QueryExecutor['executePositional']>>;
}

function addMetadataRow(
  tables: Map<string, RuntimeSchemaTable>,
  row: Record<string, unknown>,
  selectedCatalogOrDatabase: string,
  driver: string,
): void {
  const catalog = rowString(row, 'table_catalog') ?? selectedCatalogOrDatabase;
  const schema = rowString(row, 'table_schema');
  const tableName = rowString(row, 'table_name');
  const columnName = rowString(row, 'column_name');
  if (!schema || !tableName || !columnName) return;
  // A database attached beside the one a DuckDB connection opened keeps its
  // name: `lake.main.orders` and `main.orders` are two tables, never one.
  const includeCatalog = driver === 'snowflake' || driver === 'databricks' || driver === 'bigquery'
    || ((driver === 'duckdb' || driver === 'file') && isAttachedDuckDBCatalog(catalog, rowString(row, 'current_catalog')));
  const relation = includeCatalog
    ? [catalog, schema, tableName].filter(Boolean).join('.')
    : [schema, tableName].filter(Boolean).join('.');
  const key = normalizeIdentifierKey(relation);
  const current = tables.get(key) ?? {
    relation,
    catalogOrDatabase: catalog,
    schema,
    name: tableName,
    source: SCHEMA_SYNC_SOURCE,
    columns: [],
  };
  if (
    current.columns.length < MAX_COLUMNS_PER_TABLE
    && !current.columns.some((column) => normalizeIdentifierKey(column.name) === normalizeIdentifierKey(columnName))
  ) {
    current.columns.push({
      name: columnName,
      type: rowString(row, 'data_type'),
    });
  }
  tables.set(key, current);
}

function assertObservedScopeCompatible(
  connection: ConnectionConfig,
  observed: { database?: string; catalog?: string; schema?: string },
): void {
  const configuredCatalog = cleanIdentifier(connection.catalog ?? connection.database);
  const observedCatalog = cleanIdentifier(observed.catalog ?? observed.database);
  if (configuredCatalog && observedCatalog && normalizeIdentifierKey(configuredCatalog) !== normalizeIdentifierKey(observedCatalog)) {
    throw new Error(
      `Configured database/catalog "${configuredCatalog}" does not match the active target "${observedCatalog}". `
      + 'ZLens did not synchronize metadata from a different target.',
    );
  }
  const configuredSchema = cleanIdentifier(connection.schema);
  const observedSchema = cleanIdentifier(observed.schema);
  if (configuredSchema && observedSchema && normalizeIdentifierKey(configuredSchema) !== normalizeIdentifierKey(observedSchema)) {
    throw new Error(
      `Configured schema "${configuredSchema}" does not match the active target "${observedSchema}". `
      + 'ZLens did not synchronize metadata from a different target.',
    );
  }
}

function normalizeScopes(
  values: Array<{ catalogOrDatabase?: string; schemas?: string[] }>,
): RuntimeSchemaScope[] {
  const grouped = new Map<string, { catalogOrDatabase: string; schemas: Set<string> }>();
  for (const value of values) {
    const catalogOrDatabase = cleanIdentifier(value.catalogOrDatabase);
    if (!catalogOrDatabase) continue;
    const key = normalizeIdentifierKey(catalogOrDatabase);
    const current = grouped.get(key) ?? { catalogOrDatabase, schemas: new Set<string>() };
    for (const schema of value.schemas ?? []) {
      const clean = cleanIdentifier(schema);
      if (clean) current.schemas.add(clean);
    }
    grouped.set(key, current);
  }
  const withSchemas = Array.from(grouped.values()).filter((entry) => entry.schemas.size > 0);
  if (withSchemas.length > MAX_SCOPES) {
    throw new Error(`The metadata scope covers ${withSchemas.length} databases; ZLens reads up to ${MAX_SCOPES} per connection. Choose fewer databases.`);
  }
  for (const entry of withSchemas) {
    if (entry.schemas.size > MAX_SCHEMAS) {
      throw new Error(`The metadata scope covers ${entry.schemas.size} schemas in ${entry.catalogOrDatabase}; ZLens reads up to ${MAX_SCHEMAS.toLocaleString('en-US')} per database. Choose fewer schemas.`);
    }
  }
  return Array.from(grouped.values())
    .map((entry) => ({
      catalogOrDatabase: entry.catalogOrDatabase,
      schemas: Array.from(entry.schemas).sort((left, right) => left.localeCompare(right)),
    }))
    .filter((entry) => entry.schemas.length > 0)
    .sort((left, right) => left.catalogOrDatabase.localeCompare(right.catalogOrDatabase));
}

function scopesFromRelations(
  relations: string[],
  fallbackDatabase: string | undefined,
  fallbackSchema: string | undefined,
): RuntimeSchemaScope[] {
  return normalizeScopes(relations.map((relation) => {
    const parts = relationParts(relation);
    return {
      catalogOrDatabase: parts.catalogOrDatabase ?? fallbackDatabase,
      schemas: [parts.schema ?? fallbackSchema].filter((value): value is string => Boolean(value)),
    };
  }));
}

function groupRelations(
  relations: string[],
  connection: ConnectionConfig,
): Map<string, Array<{ schema: string; table: string }>> {
  const fallbackDatabase = configuredCatalog(connection);
  const fallbackSchema = configuredSchema(connection);
  const grouped = new Map<string, Array<{ schema: string; table: string }>>();
  for (const relation of relations) {
    const parts = relationParts(relation);
    const catalog = parts.catalogOrDatabase ?? fallbackDatabase;
    const schema = parts.schema ?? fallbackSchema;
    if (!catalog || !schema || !parts.table) continue;
    const key = normalizeIdentifierKey(catalog);
    const rows = grouped.get(key) ?? [];
    if (!rows.some((row) =>
      normalizeIdentifierKey(row.schema) === normalizeIdentifierKey(schema)
      && normalizeIdentifierKey(row.table) === normalizeIdentifierKey(parts.table!))) {
      rows.push({ schema, table: parts.table });
    }
    grouped.set(key, rows);
  }
  return grouped;
}

function relationParts(relation: string): {
  catalogOrDatabase?: string;
  schema?: string;
  table?: string;
} {
  const parts = relation.split('.').map(cleanIdentifier).filter((value): value is string => Boolean(value));
  if (parts.length >= 3) {
    return {
      catalogOrDatabase: parts.at(-3),
      schema: parts.at(-2),
      table: parts.at(-1),
    };
  }
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  return { table: parts[0] };
}

function buildExactRelationPredicate(relations: Array<{ schema: string; table: string }>): string | undefined {
  const grouped = new Map<string, { schema: string; tables: Set<string> }>();
  for (const relation of relations) {
    const key = normalizeIdentifierKey(relation.schema);
    const current = grouped.get(key) ?? { schema: relation.schema, tables: new Set<string>() };
    current.tables.add(relation.table);
    grouped.set(key, current);
  }
  const clauses = Array.from(grouped.values()).map((entry) => {
    return `(UPPER(table_schema) = UPPER(${sqlLiteral(entry.schema)}) AND UPPER(table_name) IN (${Array.from(entry.tables).map((table) => `UPPER(${sqlLiteral(table)})`).join(', ')}))`;
  });
  return clauses.length > 0 ? `(${clauses.join(' OR ')})` : undefined;
}

function buildSchemaPredicate(schemas: string[]): string | undefined {
  if (schemas.length === 0) return undefined;
  if (schemas.includes(EVERY_SCHEMA)) return `UPPER(table_schema) NOT IN ('INFORMATION_SCHEMA', 'PG_CATALOG')`;
  return `UPPER(table_schema) IN (${schemas.map((schema) => `UPPER(${sqlLiteral(schema)})`).join(', ')})`;
}

/**
 * DuckDB lists every attached database in one information_schema (and has no
 * per-catalog one). A scope reads its own catalog: an attached database's
 * tables when the scope names one, otherwise the database the connection
 * opened and its temporary views, whatever the scope calls it (`memory` is
 * the default name for a connection with no database configured).
 */
export function duckdbCatalogScopePredicate(column: string, scopeCatalog: string): string {
  const scope = `lower(${sqlLiteral(scopeCatalog)})`;
  return `(lower(${column}) = ${scope} OR (${column} IN (current_database(), 'temp') AND ${scope} NOT IN (`
    + `SELECT lower(catalog_name) FROM information_schema.schemata WHERE catalog_name NOT IN (current_database(), 'temp', 'system'))))`;
}

/** Whether a DuckDB row's catalog is a database attached beside the one the connection opened. */
export function isAttachedDuckDBCatalog(catalog: string | undefined, currentCatalog: string | undefined): boolean {
  if (!catalog || !currentCatalog) return false;
  const name = catalog.toLowerCase();
  return name !== currentCatalog.toLowerCase() && name !== 'temp' && name !== 'system';
}

function informationSchemaColumnsRelation(connection: ConnectionConfig, catalogOrDatabase: string): string {
  const driver = connection.driver;
  if (driver === 'snowflake') return `${quoteIdentifier(catalogOrDatabase, '"')}.INFORMATION_SCHEMA.COLUMNS`;
  if (driver === 'databricks') return `${quoteIdentifier(catalogOrDatabase, '`')}.information_schema.columns`;
  // BigQuery: the project's columns across datasets in one location.
  if (driver === 'bigquery') return `${quoteIdentifier(catalogOrDatabase, '`')}.${quoteIdentifier(`region-${(connection.location ?? 'US').toLowerCase()}`, '`')}.INFORMATION_SCHEMA.COLUMNS`;
  // Trino has one information_schema per catalog.
  if (driver === 'trino') return `${quoteIdentifier(catalogOrDatabase, '"')}.information_schema.columns`;
  return 'information_schema.columns';
}

function quoteIdentifier(value: string, quote: '"' | '`'): string {
  return `${quote}${value.replaceAll(quote, `${quote}${quote}`)}${quote}`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function rowString(row: Record<string, unknown>, key: string): string | undefined {
  const expected = key.toLowerCase();
  for (const [rowKey, value] of Object.entries(row)) {
    if (rowKey.toLowerCase() !== expected) continue;
    return cleanIdentifier(typeof value === 'string' ? value : value == null ? undefined : String(value));
  }
  return undefined;
}

function firstRowString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rowString(row, key);
    if (value) return value;
  }
  return undefined;
}

function discoveryQueryOptions(): {
  maxRows: number;
  maxBytes: number;
  batchSize: number;
  deadlineMs: number;
  purpose: 'metadata';
} {
  return {
    maxRows: MAX_DISCOVERY_SCHEMAS,
    maxBytes: 2 * 1024 * 1024,
    batchSize: 500,
    deadlineMs: DISCOVERY_DEADLINE_MS,
    purpose: 'metadata',
  };
}

function dbtRelationCountsByScope(
  relations: string[],
  connection: ConnectionConfig,
): Map<string, number> {
  const counts = new Map<string, number>();
  const fallbackDatabase = configuredCatalog(connection);
  const fallbackSchema = configuredSchema(connection);
  for (const relation of relations) {
    const parts = relationParts(relation);
    const catalog = parts.catalogOrDatabase ?? fallbackDatabase;
    const schema = parts.schema ?? fallbackSchema;
    if (!catalog || !schema) continue;
    const key = scopeKey(catalog, schema);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function scopeKey(catalogOrDatabase: string, schema: string): string {
  return `${normalizeIdentifierKey(catalogOrDatabase)}::${normalizeIdentifierKey(schema)}`;
}

const GENERIC_SCHEMA_DISCOVERY_DRIVERS = new Set(['duckdb', 'file', 'postgresql', 'postgres', 'redshift', 'mysql', 'sqlserver', 'mssql', 'fabric', 'clickhouse', 'trino', 'athena']);

/** System schemas no user models live in, per engine. */
const SYSTEM_SCHEMAS = new Set([
  'information_schema', 'pg_catalog', 'pg_internal', 'pg_toast', 'sys', 'system', 'mysql', 'performance_schema',
  'guest', 'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin', 'db_backupoperator', 'db_datareader', 'db_datawriter', 'db_denydatareader', 'db_denydatawriter',
]);

async function listSchemasGenerically(
  executor: QueryExecutor,
  connection: ConnectionConfig,
): Promise<Array<{ catalog: string; schema: string }> | undefined> {
  if (connection.driver === 'sqlite') {
    const result = await executor.executePositional('SELECT name FROM pragma_database_list', [], connection, discoveryQueryOptions());
    return result.rows
      .map((row) => firstRowString(row, ['name']))
      .filter((name): name is string => Boolean(name) && name !== 'temp')
      .map((name) => ({ catalog: name, schema: name }));
  }
  if (connection.driver === 'bigquery') {
    // Datasets of the billing project in the connection's location.
    const project = configuredCatalog(connection);
    const region = `region-${(connection.location ?? 'US').toLowerCase()}`;
    const result = await executor.executePositional(
      `SELECT catalog_name, schema_name FROM ${project ? `\`${project.replace(/`/g, '')}\`.` : ''}\`${region}\`.INFORMATION_SCHEMA.SCHEMATA LIMIT ${MAX_DISCOVERY_SCHEMAS}`,
      [],
      connection,
      discoveryQueryOptions(),
    );
    return result.rows.flatMap((row) => {
      const catalog = firstRowString(row, ['catalog_name']);
      const schema = firstRowString(row, ['schema_name']);
      return catalog && schema ? [{ catalog, schema }] : [];
    });
  }
  if (!GENERIC_SCHEMA_DISCOVERY_DRIVERS.has(connection.driver)) return undefined;
  const mssql = connection.driver === 'mssql' || connection.driver === 'fabric';
  const result = await executor.executePositional(
    mssql
      ? `SELECT TOP (${MAX_DISCOVERY_SCHEMAS}) catalog_name, schema_name FROM information_schema.schemata`
      : `SELECT catalog_name, schema_name FROM information_schema.schemata LIMIT ${MAX_DISCOVERY_SCHEMAS}`,
    [],
    connection,
    discoveryQueryOptions(),
  );
  return result.rows.flatMap((row) => {
    const reportedCatalog = firstRowString(row, ['catalog_name', 'CATALOG_NAME']);
    const schema = firstRowString(row, ['schema_name', 'SCHEMA_NAME']);
    // MySQL reports every database under the catalog "def": the database is the scope.
    const catalog = connection.driver === 'mysql' ? schema : reportedCatalog;
    if (schema && SYSTEM_SCHEMAS.has(schema.toLowerCase())) return [];
    // DuckDB's built-in catalogs hold no user tables.
    if (!catalog || !schema || ((connection.driver === 'duckdb' || connection.driver === 'file') && (catalog === 'system' || catalog === 'temp'))) return [];
    if (schema.toLowerCase().startsWith('pg_')) return [];
    return [{ catalog, schema }];
  });
}

function isSystemSchema(schema: string): boolean {
  return ['information_schema', 'pg_catalog', 'sys', 'system']
    .includes(normalizeIdentifierKey(schema));
}

/**
 * The database/catalog a connection's unqualified names resolve in. Engines
 * name it differently: BigQuery's is the project, Athena's the data catalog,
 * and MySQL and ClickHouse have one level only, the database, which serves as
 * both catalog and schema of a scope.
 */
/** In a DuckDB scope: every schema of that catalog (a catalog service whose namespaces are not named). */
export const EVERY_SCHEMA = '*';

/**
 * The catalogs a DuckDB or file connection attaches are read by default too,
 * so their tables (`lake.main.orders`, `glue.sales.orders`) reach Ask and the
 * warehouse catalog: the `main` schema of a database file (of the data folder,
 * or one of its `catalogs`), and the namespaces of a catalog service (those
 * named in `namespaces`, else every one).
 */
function dataFolderCatalogScopes(connection: ConnectionConfig): RuntimeSchemaScope[] {
  if (connection.driver !== 'file' && connection.driver !== 'duckdb') return [];
  const configured = configuredCatalogs(connection.catalogs ?? [], connection.storage);
  const own = configured.map((catalog) => ({
    catalogOrDatabase: catalog.name,
    schemas: catalog.plan?.service ? catalog.plan.namespaces ?? [EVERY_SCHEMA] : ['main'],
  }));
  if (connection.driver !== 'file' || !connection.dataFolder || !isAbsolute(connection.dataFolder)) return own;
  const exclude = connection.filepath && connection.filepath !== ':memory:' ? [connection.filepath] : [];
  const taken = new Set(configured.map((catalog) => catalog.name));
  // A data folder's database file named like one of the connection's own catalogs is attached with its type as a suffix.
  const folder = readDataFolder(connection.dataFolder, { exclude }).catalogs
    .map((catalog) => ({ catalogOrDatabase: taken.has(catalog.name) ? `${catalog.name}_${catalog.type}` : catalog.name, schemas: ['main'] }));
  return [...own, ...folder];
}

function configuredCatalog(connection: ConnectionConfig): string | undefined {
  const driver = connection.driver;
  if (driver === 'bigquery') return cleanIdentifier(connection.catalog ?? connection.projectId ?? connection.database);
  if (driver === 'athena') return cleanIdentifier(connection.catalog) ?? 'awsdatacatalog';
  return cleanIdentifier(connection.catalog ?? connection.database) ?? defaultCatalogForDriver(driver);
}

function configuredSchema(connection: ConnectionConfig): string | undefined {
  const driver = connection.driver;
  if (driver === 'mysql' || driver === 'clickhouse') return cleanIdentifier(connection.schema ?? connection.database) ?? (driver === 'clickhouse' ? 'default' : undefined);
  if (driver === 'athena') return cleanIdentifier(connection.database ?? connection.schema);
  return cleanIdentifier(connection.schema) ?? defaultSchemaForDriver(driver);
}

function defaultCatalogForDriver(driver: string): string | undefined {
  return driver === 'duckdb' || driver === 'file' ? 'memory' : driver === 'sqlite' ? 'main' : undefined;
}

function defaultSchemaForDriver(driver: string): string | undefined {
  if (driver === 'postgresql' || driver === 'redshift') return 'public';
  if (driver === 'mssql' || driver === 'fabric') return 'dbo';
  return driver === 'duckdb' || driver === 'file' || driver === 'sqlite' ? 'main' : undefined;
}


function cleanIdentifier(value: string | undefined): string | undefined {
  const clean = value?.trim().replace(/^["`\[]|["`\]]$/g, '');
  return clean || undefined;
}

function normalizeIdentifierKey(value: string): string {
  return value.trim().replace(/^["`\[]|["`\]]$/g, '').toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function redactedConnectionIdentity(connection: ConnectionConfig): Record<string, unknown> {
  return {
    driver: connection.driver,
    accountOrHost: connection.account ?? connection.host,
    projectId: connection.projectId,
    database: connection.database,
    catalog: connection.catalog,
    schema: connection.schema,
    role: connection.role,
    warehouse: connection.warehouse,
    httpPath: connection.httpPath,
    filepath: connection.filepath,
  };
}

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
