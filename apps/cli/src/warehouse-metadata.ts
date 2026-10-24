import { createHash } from 'node:crypto';
import {
  latestRuntimeSchemaSnapshotForProject,
  recordRuntimeSchemaSnapshot,
  type RuntimeSchemaObservedTarget,
  type RuntimeSchemaScope,
  type RuntimeSchemaSnapshot,
  type RuntimeSchemaTable,
} from '@zlens/agent';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
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

export interface WarehouseMetadataDiscoveredSchema {
  name: string;
  inDbtProject: boolean;
  dbtRelationCount: number;
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
}

const MAX_SCOPES = 20;
const MAX_SCHEMAS = 100;
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
  const relations = uniqueStrings(
    mode === 'selected_scopes' ? [] : currentDbtRelations,
  )
    .map(normalizeRelation)
    .filter((value): value is string => Boolean(value))
    .slice(0, MAX_RELATIONS);
  const explicitScopes = normalizeScopes(input?.scopes ?? []);
  const relationScopes = scopesFromRelations(relations, defaultDatabase, defaultSchema);
  const fallbackScopes = defaultDatabase && defaultSchema
    ? [{ catalogOrDatabase: defaultDatabase, schemas: [defaultSchema] }]
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
    source: 'activated warehouse metadata generation',
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

  const scopes = Array.from(discovered.values())
    .map((scope) => ({
      catalogOrDatabase: scope.catalogOrDatabase,
      schemas: Array.from(scope.schemas.values())
        .sort((left, right) => left.localeCompare(right))
        .map((schema) => {
          const count = dbtCounts.get(scopeKey(scope.catalogOrDatabase, schema)) ?? 0;
          return {
            name: schema,
            inDbtProject: count > 0,
            dbtRelationCount: count,
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
  };
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
    return [{
      catalogOrDatabase,
      sql: [
        `SELECT ${top ? `TOP (${MAX_METADATA_ROWS_PER_QUERY}) ` : ''}table_catalog, table_schema, table_name, column_name, data_type, ordinal_position`,
        `FROM ${informationSchemaColumnsRelation(connection, catalogOrDatabase)}`,
        `WHERE ${predicate}`,
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
  const includeCatalog = driver === 'snowflake' || driver === 'databricks' || driver === 'bigquery';
  const relation = includeCatalog
    ? [catalog, schema, tableName].filter(Boolean).join('.')
    : [schema, tableName].filter(Boolean).join('.');
  const key = normalizeIdentifierKey(relation);
  const current = tables.get(key) ?? {
    relation,
    catalogOrDatabase: catalog,
    schema,
    name: tableName,
    source: 'activated warehouse metadata generation',
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
  for (const value of values.slice(0, MAX_SCOPES)) {
    const catalogOrDatabase = cleanIdentifier(value.catalogOrDatabase);
    if (!catalogOrDatabase) continue;
    const key = normalizeIdentifierKey(catalogOrDatabase);
    const current = grouped.get(key) ?? { catalogOrDatabase, schemas: new Set<string>() };
    for (const schema of value.schemas ?? []) {
      const clean = cleanIdentifier(schema);
      if (clean && current.schemas.size < MAX_SCHEMAS) current.schemas.add(clean);
    }
    grouped.set(key, current);
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
  for (const relation of relations.slice(0, MAX_RELATIONS)) {
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
  return `UPPER(table_schema) IN (${schemas.map((schema) => `UPPER(${sqlLiteral(schema)})`).join(', ')})`;
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

function normalizeRelation(value: string): string | undefined {
  const parts = value.split('.').map(cleanIdentifier).filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join('.') : undefined;
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
