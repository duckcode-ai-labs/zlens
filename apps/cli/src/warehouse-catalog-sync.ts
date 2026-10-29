/**
 * Warehouse catalog extraction (RFC 0007, warehouse-first modeling).
 *
 * Reads the selected schemas' tables, views, columns, comments, declared
 * primary/foreign keys and view definitions, and writes the project's warehouse
 * catalog snapshot (.dql/warehouse-catalog.json). Metadata only: no statement
 * here reads a row of user data. The column read is required; comments, keys
 * and view definitions are best effort, so a warehouse or role that does not
 * expose one still syncs, with a warning naming what was skipped.
 *
 * Per driver: DuckDB, SQLite, Postgres/Redshift, MySQL, SQL Server/Fabric,
 * Snowflake, Databricks (Unity Catalog) and BigQuery read keys and comments;
 * ClickHouse, Trino and Athena read comments and views (they declare no keys);
 * any other driver reads tables, views and columns from information_schema.
 */

import {
  warehouseRelationId,
  writeWarehouseCatalog,
  type WarehouseCatalogRelationV1,
  type WarehouseCatalogSnapshotV1,
} from '@zlens/core';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { sqliteColumnsOneByOne, type ConnectionMetadataScopeV1 } from './warehouse-metadata.js';

const MAX_ROWS = 50_000;
// Schema reads only: a host's row policy (RFC 0010) can tell them from data.
const QUERY_OPTIONS = { maxRows: MAX_ROWS, maxBytes: 32 * 1024 * 1024, batchSize: 1_000, deadlineMs: 60_000, purpose: 'metadata' as const };

type Row = Record<string, unknown>;
interface CatalogQuery { kind: 'columns' | 'tables' | 'views' | 'keys' | 'primary_keys' | 'foreign_keys'; sql: string; catalogOrDatabase: string }

export interface WarehouseCatalogSyncResult {
  snapshot: WarehouseCatalogSnapshotV1;
  /** Optional reads that failed (keys, comments, views), in plain words. */
  warnings: string[];
}

/** `'a'` with quotes doubled: a string literal for a metadata filter. */
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
/** A double-quoted identifier. */
const ident = (value: string) => `"${value.replace(/"/g, '""')}"`;
const inList = (values: string[]) => values.map((value) => `UPPER(${literal(value)})`).join(', ');

/** The queries that read one scope's catalog, per driver. */
export function buildWarehouseCatalogQueries(driver: string, scope: { catalogOrDatabase: string; schemas: string[] }): CatalogQuery[] {
  const db = scope.catalogOrDatabase;
  const schemas = scope.schemas.length ? scope.schemas : [];
  const schemaFilter = (column: string) => (schemas.length ? `UPPER(${column}) IN (${inList(schemas)})` : `UPPER(${column}) NOT IN ('INFORMATION_SCHEMA', 'PG_CATALOG')`);
  const d = driver.toLowerCase();
  if (d === 'duckdb') {
    return [
      { kind: 'columns', catalogOrDatabase: db, sql: `SELECT database_name AS table_catalog, schema_name AS table_schema, table_name, column_name, data_type, is_nullable, comment FROM duckdb_columns() WHERE ${schemaFilter('schema_name')} AND NOT internal ORDER BY schema_name, table_name, column_index LIMIT ${MAX_ROWS}` },
      { kind: 'tables', catalogOrDatabase: db, sql: `SELECT database_name AS table_catalog, schema_name AS table_schema, table_name, 'BASE TABLE' AS table_type, comment, estimated_size AS row_count FROM duckdb_tables() WHERE ${schemaFilter('schema_name')} AND NOT internal` },
      { kind: 'views', catalogOrDatabase: db, sql: `SELECT database_name AS table_catalog, schema_name AS table_schema, view_name AS table_name, comment, sql AS view_definition FROM duckdb_views() WHERE ${schemaFilter('schema_name')} AND NOT internal` },
      { kind: 'keys', catalogOrDatabase: db, sql: `SELECT schema_name AS table_schema, table_name, constraint_type, constraint_column_names, referenced_table, referenced_column_names FROM duckdb_constraints() WHERE ${schemaFilter('schema_name')} AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')` },
    ];
  }
  if (d === 'sqlite') {
    return [
      { kind: 'columns', catalogOrDatabase: db, sql: `SELECT 'main' AS table_schema, m.name AS table_name, p.name AS column_name, p.type AS data_type, CASE WHEN p."notnull" = 1 THEN 'NO' ELSE 'YES' END AS is_nullable, p.pk AS pk_position FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid LIMIT ${MAX_ROWS}` },
      { kind: 'tables', catalogOrDatabase: db, sql: `SELECT 'main' AS table_schema, name AS table_name, CASE WHEN type = 'view' THEN 'VIEW' ELSE 'BASE TABLE' END AS table_type, CASE WHEN type = 'view' THEN sql END AS view_definition FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'` },
      { kind: 'foreign_keys', catalogOrDatabase: db, sql: `SELECT 'main' AS table_schema, m.name AS table_name, f.id AS constraint_name, f.seq AS position, f."from" AS column_name, f."table" AS ref_table, f."to" AS ref_column FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq` },
    ];
  }
  if (d === 'postgres' || d === 'postgresql' || d === 'redshift') {
    const rel = `format('%I.%I', c.table_schema, c.table_name)::regclass`;
    const columnsAndTables: CatalogQuery[] = [
      { kind: 'columns', catalogOrDatabase: db, sql: `SELECT c.table_catalog, c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable, col_description(${rel}, c.ordinal_position) AS comment FROM information_schema.columns c WHERE ${schemaFilter('c.table_schema')} ORDER BY c.table_schema, c.table_name, c.ordinal_position LIMIT ${MAX_ROWS}` },
      { kind: 'tables', catalogOrDatabase: db, sql: `SELECT c.table_catalog, c.table_schema, c.table_name, c.table_type, obj_description(${rel}, 'pg_class') AS comment FROM information_schema.tables c WHERE ${schemaFilter('c.table_schema')}` },
    ];
    if (d === 'redshift') {
      // Redshift has no LATERAL unnest over pg_constraint arrays: it keeps the
      // information_schema reads.
      return [
        ...columnsAndTables,
        { kind: 'views', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, view_definition FROM information_schema.views WHERE ${schemaFilter('table_schema')}` },
        { kind: 'keys', catalogOrDatabase: db, sql: `SELECT tc.constraint_type, tc.constraint_name, kcu.table_schema, kcu.table_name, kcu.column_name, kcu.ordinal_position AS position, ref.table_schema AS ref_schema, ref.table_name AS ref_table, ref.column_name AS ref_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema LEFT JOIN information_schema.referential_constraints rc ON tc.constraint_type = 'FOREIGN KEY' AND rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema LEFT JOIN information_schema.key_column_usage ref ON ref.constraint_name = rc.unique_constraint_name AND ref.constraint_schema = rc.unique_constraint_schema AND ref.ordinal_position = kcu.position_in_unique_constraint WHERE tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY') AND ${schemaFilter('kcu.table_schema')} ORDER BY kcu.table_schema, kcu.table_name, tc.constraint_name, kcu.ordinal_position` },
      ];
    }
    // Postgres: keys and view SQL come from pg_catalog. information_schema
    // shows constraints, and a view's definition, only to the table's owner,
    // so a read-only login (the role the docs recommend) would read none.
    return [
      ...columnsAndTables,
      { kind: 'views', catalogOrDatabase: db, sql: `SELECT current_database() AS table_catalog, n.nspname AS table_schema, c.relname AS table_name, pg_get_viewdef(c.oid) AS view_definition FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND ${schemaFilter('n.nspname')}` },
      { kind: 'keys', catalogOrDatabase: db, sql: `SELECT CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' ELSE 'FOREIGN KEY' END AS constraint_type, con.conname AS constraint_name, n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name, k.position, rn.nspname AS ref_schema, rc.relname AS ref_table, ra.attname AS ref_column FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, ref_attnum, position) JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum LEFT JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace LEFT JOIN pg_catalog.pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.ref_attnum WHERE con.contype IN ('p', 'f') AND ${schemaFilter('n.nspname')} ORDER BY n.nspname, c.relname, con.conname, k.position` },
    ];
  }
  if (d === 'snowflake') {
    const is = `${ident(db)}.INFORMATION_SCHEMA`;
    return [
      { kind: 'columns', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, column_name, data_type, is_nullable, comment FROM ${is}.COLUMNS WHERE ${schemaFilter('table_schema')} ORDER BY table_schema, table_name, ordinal_position LIMIT ${MAX_ROWS}` },
      { kind: 'tables', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, table_type, comment, row_count FROM ${is}.TABLES WHERE ${schemaFilter('table_schema')}` },
      { kind: 'views', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, view_definition FROM ${is}.VIEWS WHERE ${schemaFilter('table_schema')}` },
      // Snowflake reports declared (informational) keys only through SHOW.
      { kind: 'primary_keys', catalogOrDatabase: db, sql: `SHOW PRIMARY KEYS IN DATABASE ${ident(db)}` },
      { kind: 'foreign_keys', catalogOrDatabase: db, sql: `SHOW IMPORTED KEYS IN DATABASE ${ident(db)}` },
    ];
  }
  if (d === 'databricks') {
    // Unity Catalog: one information_schema per catalog, informational keys included.
    const tick = (value: string) => `\`${value.replace(/`/g, '``')}\``;
    const is = `${tick(db)}.information_schema`;
    return [
      { kind: 'columns', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, column_name, full_data_type AS data_type, is_nullable, comment FROM ${is}.columns WHERE ${schemaFilter('table_schema')} ORDER BY table_schema, table_name, ordinal_position LIMIT ${MAX_ROWS}` },
      { kind: 'tables', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, table_type, comment FROM ${is}.tables WHERE ${schemaFilter('table_schema')}` },
      { kind: 'views', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, view_definition FROM ${is}.views WHERE ${schemaFilter('table_schema')}` },
      { kind: 'keys', catalogOrDatabase: db, sql: `SELECT tc.constraint_type, tc.constraint_name, kcu.table_schema, kcu.table_name, kcu.column_name, kcu.ordinal_position AS position, ref.table_catalog AS ref_catalog, ref.table_schema AS ref_schema, ref.table_name AS ref_table, ref.column_name AS ref_column FROM ${is}.table_constraints tc JOIN ${is}.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema LEFT JOIN ${is}.referential_constraints rc ON tc.constraint_type = 'FOREIGN KEY' AND rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema LEFT JOIN ${is}.key_column_usage ref ON ref.constraint_name = rc.unique_constraint_name AND ref.constraint_schema = rc.unique_constraint_schema AND ref.ordinal_position = kcu.position_in_unique_constraint WHERE tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY') AND ${schemaFilter('kcu.table_schema')} ORDER BY kcu.table_schema, kcu.table_name, tc.constraint_name, kcu.ordinal_position` },
    ];
  }
  if (d === 'bigquery') {
    // BigQuery: the scope is a project and its datasets; each dataset has its
    // own INFORMATION_SCHEMA, so each read is a UNION ALL over the datasets.
    // Unenforced primary and foreign keys are read; a foreign key is read when
    // it has one column, since CONSTRAINT_COLUMN_USAGE does not order columns.
    const tick = (value: string) => `\`${value.replace(/`/g, '\\`')}\``;
    const view = (dataset: string, name: string) => `${tick(db)}.${tick(dataset)}.INFORMATION_SCHEMA.${name}`;
    const union = (build: (dataset: string) => string) => schemas.map(build).join(' UNION ALL ');
    if (schemas.length === 0) return [{ kind: 'columns', catalogOrDatabase: db, sql: `SELECT ERROR('Choose the BigQuery datasets to model in the schema selection.')` }];
    return [
      { kind: 'columns', catalogOrDatabase: db, sql: `${union((dataset) => `SELECT c.table_catalog, c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable, f.description AS comment, c.ordinal_position FROM ${view(dataset, 'COLUMNS')} c LEFT JOIN ${view(dataset, 'COLUMN_FIELD_PATHS')} f ON f.table_name = c.table_name AND f.column_name = c.column_name AND f.field_path = c.column_name`)} ORDER BY table_schema, table_name, ordinal_position LIMIT ${MAX_ROWS}` },
      { kind: 'tables', catalogOrDatabase: db, sql: union((dataset) => `SELECT t.table_catalog, t.table_schema, t.table_name, t.table_type, JSON_VALUE(o.option_value) AS comment FROM ${view(dataset, 'TABLES')} t LEFT JOIN ${view(dataset, 'TABLE_OPTIONS')} o ON o.table_name = t.table_name AND o.option_name = 'description'`) },
      { kind: 'views', catalogOrDatabase: db, sql: union((dataset) => `SELECT table_catalog, table_schema, table_name, view_definition FROM ${view(dataset, 'VIEWS')}`) },
      { kind: 'keys', catalogOrDatabase: db, sql: union((dataset) => `SELECT tc.constraint_type, tc.constraint_name, kcu.table_schema, kcu.table_name, kcu.column_name, kcu.ordinal_position AS position, ccu.table_catalog AS ref_catalog, ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column FROM ${view(dataset, 'TABLE_CONSTRAINTS')} tc JOIN ${view(dataset, 'KEY_COLUMN_USAGE')} kcu ON kcu.constraint_name = tc.constraint_name LEFT JOIN ${view(dataset, 'CONSTRAINT_COLUMN_USAGE')} ccu ON tc.constraint_type = 'FOREIGN KEY' AND ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'PRIMARY KEY' OR (tc.constraint_type = 'FOREIGN KEY' AND (SELECT COUNT(*) FROM ${view(dataset, 'KEY_COLUMN_USAGE')} k WHERE k.constraint_name = tc.constraint_name) = 1)`) },
    ];
  }
  if (d === 'mysql') {
    // MySQL: a database is the schema. Comments, keys and view text all come
    // from information_schema; a foreign key names its target directly.
    return [
      { kind: 'columns', catalogOrDatabase: db, sql: `SELECT table_schema AS table_schema, table_name AS table_name, column_name AS column_name, column_type AS data_type, is_nullable AS is_nullable, column_comment AS comment FROM information_schema.columns WHERE ${schemaFilter('table_schema')} ORDER BY table_schema, table_name, ordinal_position LIMIT ${MAX_ROWS}` },
      { kind: 'tables', catalogOrDatabase: db, sql: `SELECT table_schema AS table_schema, table_name AS table_name, table_type AS table_type, NULLIF(table_comment, '') AS comment, table_rows AS row_count FROM information_schema.tables WHERE ${schemaFilter('table_schema')}` },
      { kind: 'views', catalogOrDatabase: db, sql: `SELECT table_schema AS table_schema, table_name AS table_name, view_definition AS view_definition FROM information_schema.views WHERE ${schemaFilter('table_schema')}` },
      { kind: 'keys', catalogOrDatabase: db, sql: `SELECT tc.constraint_type AS constraint_type, kcu.constraint_name AS constraint_name, kcu.table_schema AS table_schema, kcu.table_name AS table_name, kcu.column_name AS column_name, kcu.ordinal_position AS position, kcu.referenced_table_schema AS ref_schema, kcu.referenced_table_name AS ref_table, kcu.referenced_column_name AS ref_column FROM information_schema.key_column_usage kcu JOIN information_schema.table_constraints tc ON tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name WHERE tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY') AND ${schemaFilter('kcu.table_schema')} ORDER BY kcu.table_schema, kcu.table_name, kcu.constraint_name, kcu.ordinal_position` },
    ];
  }
  if (d === 'mssql' || d === 'fabric') {
    // SQL Server: descriptions are MS_Description extended properties; keys
    // come from sys catalog views, which order composite keys reliably.
    const objectId = `OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME))`;
    return [
      { kind: 'columns', catalogOrDatabase: db, sql: `SELECT TOP (${MAX_ROWS}) c.TABLE_CATALOG AS table_catalog, c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable, CAST(ep.value AS NVARCHAR(4000)) AS comment FROM INFORMATION_SCHEMA.COLUMNS c LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.name = 'MS_Description' AND ep.major_id = ${objectId} AND ep.minor_id = COLUMNPROPERTY(${objectId}, c.COLUMN_NAME, 'ColumnId') WHERE ${schemaFilter('c.TABLE_SCHEMA')} ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION` },
      { kind: 'tables', catalogOrDatabase: db, sql: `SELECT c.TABLE_CATALOG AS table_catalog, c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, c.TABLE_TYPE AS table_type, CAST(ep.value AS NVARCHAR(4000)) AS comment FROM INFORMATION_SCHEMA.TABLES c LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.name = 'MS_Description' AND ep.minor_id = 0 AND ep.major_id = ${objectId} WHERE ${schemaFilter('c.TABLE_SCHEMA')}` },
      { kind: 'views', catalogOrDatabase: db, sql: `SELECT c.TABLE_CATALOG AS table_catalog, c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, OBJECT_DEFINITION(${objectId}) AS view_definition FROM INFORMATION_SCHEMA.VIEWS c WHERE ${schemaFilter('c.TABLE_SCHEMA')}` },
      { kind: 'keys', catalogOrDatabase: db, sql: `SELECT 'PRIMARY KEY' AS constraint_type, kc.name AS constraint_name, s.name AS table_schema, t.name AS table_name, col.name AS column_name, ic.key_ordinal AS position, NULL AS ref_schema, NULL AS ref_table, NULL AS ref_column FROM sys.key_constraints kc JOIN sys.tables t ON t.object_id = kc.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id WHERE kc.type = 'PK' AND ${schemaFilter('s.name')} UNION ALL SELECT 'FOREIGN KEY', fk.name, s.name, t.name, col.name, fkc.constraint_column_id, rs.name, rt.name, rc.name FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id JOIN sys.tables t ON t.object_id = fkc.parent_object_id JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.columns col ON col.object_id = fkc.parent_object_id AND col.column_id = fkc.parent_column_id JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id WHERE ${schemaFilter('s.name')}` },
    ];
  }
  if (d === 'clickhouse') {
    // ClickHouse: a database is the schema. It has no foreign keys; its
    // primary (sorting) key is not a uniqueness guarantee, so none is read.
    return [
      { kind: 'columns', catalogOrDatabase: db, sql: `SELECT database AS table_schema, table AS table_name, name AS column_name, type AS data_type, if(startsWith(type, 'Nullable('), 'YES', 'NO') AS is_nullable, nullIf(comment, '') AS comment FROM system.columns WHERE ${schemaFilter('database')} ORDER BY database, table, position LIMIT ${MAX_ROWS}` },
      { kind: 'tables', catalogOrDatabase: db, sql: `SELECT database AS table_schema, name AS table_name, if(engine IN ('View', 'MaterializedView', 'LiveView'), if(engine = 'MaterializedView', 'MATERIALIZED VIEW', 'VIEW'), 'BASE TABLE') AS table_type, nullIf(comment, '') AS comment, total_rows AS row_count, if(engine = 'View', as_select, NULL) AS view_definition FROM system.tables WHERE ${schemaFilter('database')} AND NOT is_temporary` },
    ];
  }
  if (d === 'trino' || d === 'athena') {
    // Trino / Athena: one information_schema per catalog, no declared keys.
    const is = d === 'trino' ? `${ident(db)}.information_schema` : 'information_schema';
    return [
      { kind: 'columns', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, column_name, data_type, is_nullable, comment FROM ${is}.columns WHERE ${schemaFilter('table_schema')} ORDER BY table_schema, table_name, ordinal_position LIMIT ${MAX_ROWS}` },
      { kind: 'tables', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, table_type FROM ${is}.tables WHERE ${schemaFilter('table_schema')}` },
      { kind: 'views', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, view_definition FROM ${is}.views WHERE ${schemaFilter('table_schema')}` },
    ];
  }
  // Every other driver: tables, views and columns from information_schema.
  return [
    { kind: 'columns', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE ${schemaFilter('table_schema')} ORDER BY table_schema, table_name, ordinal_position LIMIT ${MAX_ROWS}` },
    { kind: 'tables', catalogOrDatabase: db, sql: `SELECT table_catalog, table_schema, table_name, table_type FROM information_schema.tables WHERE ${schemaFilter('table_schema')}` },
  ];
}

/** A row field by any of its spellings (drivers differ in case). */
function field(row: Row, ...names: string[]): unknown {
  for (const name of names) {
    for (const key of [name, name.toUpperCase(), name.toLowerCase()]) if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}
const text = (row: Row, ...names: string[]) => {
  const value = field(row, ...names);
  return value === undefined ? undefined : String(value);
};
const list = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.replace(/^\[|\]$/g, '').split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return [];
};
const key = (schema: string | undefined, name: string) => `${(schema ?? '').toLowerCase()}.${name.toLowerCase()}`;

/** Fold the rows of every query into catalog relations. Exported for tests. */
export function assembleWarehouseCatalog(driver: string, results: Array<{ query: CatalogQuery; rows: Row[] }>): WarehouseCatalogRelationV1[] {
  const includeCatalog = ['snowflake', 'databricks', 'bigquery'].includes(driver.toLowerCase());
  // Wherever a three-part name is valid SQL, the database is part of the
  // relation (ids stay as they were): Ask's schema index names these tables
  // `database.schema.table`, and a table must have one name everywhere or its
  // columns are not found under the name it was chosen by.
  const recordDatabase = includeCatalog || ['duckdb', 'postgres', 'postgresql', 'redshift', 'mssql', 'fabric', 'trino'].includes(driver.toLowerCase());
  const relations = new Map<string, WarehouseCatalogRelationV1>();
  const ensure = (row: Row, catalogOrDatabase: string): WarehouseCatalogRelationV1 | undefined => {
    const schema = text(row, 'table_schema');
    const name = text(row, 'table_name');
    if (!name) return undefined;
    const k = key(schema, name);
    let relation = relations.get(k);
    if (!relation) {
      const database = text(row, 'table_catalog') ?? catalogOrDatabase;
      relation = {
        id: warehouseRelationId({ database: includeCatalog ? database : undefined, schema, name }),
        ...(recordDatabase && database ? { database } : {}),
        ...(schema ? { schema } : {}),
        name,
        // The name queries use, spelled as the warehouse's own tools and dbt
        // spell it: three parts wherever that is valid SQL.
        relation: [recordDatabase ? database : undefined, schema, name].filter(Boolean).join('.'),
        kind: 'table',
        columns: [],
      };
      relations.set(k, relation);
    }
    return relation;
  };
  const byKey = (schema: string | undefined, name: string | undefined) => (name ? relations.get(key(schema, name)) : undefined);
  const pkPositions = new Map<string, Array<{ column: string; position: number }>>();
  const fkGroups = new Map<string, { relationKey: string; columns: Array<{ column: string; position: number; refColumn?: string }>; refRelation?: string; name?: string }>();
  const addPk = (relationKey: string, column: string, position: number) => {
    const current = pkPositions.get(relationKey) ?? [];
    if (!current.some((item) => item.column === column)) current.push({ column, position });
    pkPositions.set(relationKey, current);
  };
  const addFk = (groupKey: string, relationKey: string, column: string, position: number, refRelation: string | undefined, refColumn: string | undefined, name?: string) => {
    const group = fkGroups.get(groupKey) ?? { relationKey, columns: [], refRelation, name };
    group.columns.push({ column, position, refColumn });
    if (!group.refRelation && refRelation) group.refRelation = refRelation;
    fkGroups.set(groupKey, group);
  };

  // Columns first: they define which relations exist.
  for (const { query, rows } of results.filter((item) => item.query.kind === 'columns')) {
    for (const row of rows) {
      const relation = ensure(row, query.catalogOrDatabase);
      const name = text(row, 'column_name');
      if (!relation || !name || relation.columns.some((column) => column.name.toLowerCase() === name.toLowerCase())) continue;
      // 'YES'/'NO' from information_schema, a boolean from DuckDB.
      const nullableValue = field(row, 'is_nullable');
      const nullable = nullableValue === undefined ? undefined : typeof nullableValue === 'boolean' ? (nullableValue ? 'YES' : 'NO') : /^(yes|true|1)$/i.test(String(nullableValue)) ? 'YES' : 'NO';
      const comment = text(row, 'comment');
      relation.columns.push({ name, ...(text(row, 'data_type') ? { type: text(row, 'data_type') } : {}), ...(comment ? { comment } : {}), ...(nullable ? { nullable: nullable.toUpperCase() === 'YES' } : {}) });
      const pk = Number(field(row, 'pk_position'));
      if (Number.isFinite(pk) && pk > 0) addPk(key(relation.schema, relation.name), name, pk);
    }
  }
  for (const { rows } of results.filter((item) => item.query.kind === 'tables' || item.query.kind === 'views')) {
    for (const row of rows) {
      const relation = byKey(text(row, 'table_schema'), text(row, 'table_name'));
      if (!relation) continue;
      const type = (text(row, 'table_type') ?? '').toUpperCase();
      const view = text(row, 'view_definition');
      if (view || type.includes('VIEW')) relation.kind = type.includes('MATERIALIZED') ? 'materialized_view' : 'view';
      if (view) relation.viewSql = view;
      const comment = text(row, 'comment');
      if (comment && !relation.comment) relation.comment = comment;
      const rows = Number(field(row, 'row_count'));
      if (Number.isFinite(rows) && rows >= 0 && relation.rowCountEstimate === undefined) relation.rowCountEstimate = rows;
    }
  }
  for (const { rows } of results.filter((item) => item.query.kind === 'keys')) {
    rows.forEach((row, index) => {
      const schema = text(row, 'table_schema');
      const table = text(row, 'table_name');
      const relation = byKey(schema, table);
      if (!relation) return;
      const type = (text(row, 'constraint_type') ?? '').toUpperCase();
      const columnList = list(field(row, 'constraint_column_names'));
      const single = text(row, 'column_name');
      const columns = columnList.length ? columnList : single ? [single] : [];
      const position = Number(field(row, 'position')) || 1;
      if (type === 'PRIMARY KEY') columns.forEach((column, i) => addPk(key(relation.schema, relation.name), column, columnList.length ? i + 1 : position));
      if (type === 'FOREIGN KEY') {
        const refColumns = list(field(row, 'referenced_column_names'));
        const refTable = text(row, 'referenced_table', 'ref_table');
        const refSchema = text(row, 'ref_schema') ?? schema;
        // Catalog-qualified warehouses name the referenced catalog too.
        const refCatalog = includeCatalog ? text(row, 'ref_catalog') : undefined;
        const refRelation = refTable ? [refCatalog, refSchema, refTable].filter(Boolean).join('.') : undefined;
        const groupKey = `${key(schema, table ?? '')}#${text(row, 'constraint_name') ?? `duckdb-${index}`}`;
        columns.forEach((column, i) => addFk(groupKey, key(relation.schema, relation.name), column, columnList.length ? i + 1 : position, refRelation, refColumns[i] ?? text(row, 'ref_column'), text(row, 'constraint_name')));
      }
    });
  }
  for (const { query, rows } of results.filter((item) => item.query.kind === 'primary_keys')) {
    // Snowflake SHOW PRIMARY KEYS: schema_name, table_name, column_name, key_sequence.
    for (const row of rows) {
      const relation = byKey(text(row, 'schema_name'), text(row, 'table_name'));
      const column = text(row, 'column_name');
      if (relation && column) addPk(key(relation.schema, relation.name), column, Number(field(row, 'key_sequence')) || 1);
    }
    void query;
  }
  for (const { rows } of results.filter((item) => item.query.kind === 'foreign_keys')) {
    for (const row of rows) {
      // Snowflake SHOW IMPORTED KEYS names both sides; SQLite pragma rows name the local side.
      const schema = text(row, 'fk_schema_name', 'table_schema');
      const table = text(row, 'fk_table_name', 'table_name');
      const relation = byKey(schema, table);
      const column = text(row, 'fk_column_name', 'column_name');
      if (!relation || !column) continue;
      const refTable = text(row, 'pk_table_name', 'ref_table');
      const refSchema = text(row, 'pk_schema_name') ?? schema;
      const refDatabase = text(row, 'pk_database_name');
      const refRelation = refTable ? [includeCatalog ? refDatabase : undefined, refSchema, refTable].filter(Boolean).join('.') : undefined;
      const name = text(row, 'fk_name', 'constraint_name');
      addFk(`${key(schema, table ?? '')}#${name ?? refRelation ?? ''}`, key(relation.schema, relation.name), column, Number(field(row, 'key_sequence', 'position')) || 1, refRelation, text(row, 'pk_column_name', 'ref_column'), name);
    }
  }
  for (const [relationKey, columns] of pkPositions) {
    const relation = relations.get(relationKey);
    if (relation) relation.primaryKey = columns.sort((a, b) => a.position - b.position).map((item) => item.column);
  }
  for (const group of fkGroups.values()) {
    const relation = relations.get(group.relationKey);
    if (!relation || !group.refRelation) continue;
    const ordered = group.columns.sort((a, b) => a.position - b.position);
    (relation.foreignKeys ??= []).push({
      columns: ordered.map((item) => item.column),
      references: { relation: group.refRelation, columns: ordered.map((item) => item.refColumn ?? '').filter(Boolean) },
      ...(group.name && !/^duckdb-\d+$/.test(group.name) ? { name: group.name } : {}),
    });
  }
  return [...relations.values()].filter((relation) => relation.columns.length > 0);
}

/**
 * Read the scope's catalog from the warehouse and write the project's
 * warehouse catalog snapshot. Throws when no relation could be read.
 */
export async function syncWarehouseCatalog(input: {
  projectRoot: string;
  executor: QueryExecutor;
  connection: ConnectionConfig;
  scope: ConnectionMetadataScopeV1;
}): Promise<WarehouseCatalogSyncResult> {
  const warnings: string[] = [];
  const results: Array<{ query: CatalogQuery; rows: Row[] }> = [];
  for (const scope of input.scope.scopes) {
    for (const query of buildWarehouseCatalogQueries(input.connection.driver, scope)) {
      try {
        const result = await input.executor.executePositional(query.sql, [], input.connection, QUERY_OPTIONS);
        if (query.kind === 'columns' && (result.truncated || result.rows.length >= MAX_ROWS)) {
          throw new Error('the selected schemas have more columns than one sync reads; narrow the schema selection');
        }
        results.push({ query, rows: result.rows as Row[] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // One broken SQLite view fails the one-statement column read: read
        // the relations one at a time and leave the broken ones out.
        if (query.kind === 'columns' && input.connection.driver.toLowerCase() === 'sqlite') {
          const fallback = await sqliteColumnsOneByOne(input.executor, input.connection, scope.catalogOrDatabase, QUERY_OPTIONS);
          results.push({ query, rows: fallback.rows.map((row) => ({ ...row, is_nullable: Number(row.not_null) === 1 ? 'NO' : 'YES' })) as Row[] });
          warnings.push(`some relations of ${scope.catalogOrDatabase} could not be described and were left out: ${message.split('\n')[0]!.slice(0, 200)}`);
          continue;
        }
        if (query.kind === 'columns') throw new Error(`Reading columns of ${scope.catalogOrDatabase} failed: ${message}`);
        warnings.push(`${query.kind.replace('_', ' ')} of ${scope.catalogOrDatabase} not read: ${message.split('\n')[0]!.slice(0, 200)}`);
      }
    }
  }
  const relations = assembleWarehouseCatalog(input.connection.driver, results);
  if (relations.length === 0) {
    throw new Error('The warehouse catalog sync found no tables in the selected schemas. Check the schema selection and the connection role\'s permissions.');
  }
  const snapshot = writeWarehouseCatalog(input.projectRoot, {
    version: 1,
    driver: input.connection.driver,
    connectionId: input.scope.connectionId,
    scopes: input.scope.scopes.map((scope) => ({ catalogOrDatabase: scope.catalogOrDatabase, schemas: [...scope.schemas] })),
    capturedAt: new Date().toISOString(),
    relations,
  });
  return { snapshot, warnings };
}
