/**
 * dbt-duckdb sources read where they are: a source (or source table) with an
 * `external_location` (in `meta` or `config`) is not a table in the database.
 * dbt writes the location as the source's `relation_name`: a quoted path
 * (`'s3://lake/raw/orders.parquet'`) or a reader call
 * (`read_csv('s3://lake/raw/customers.csv', header = true)`), and models read
 * that path directly.
 *
 * ZLens reads each such source as a table of its own, named like the dbt
 * source: `dbt_sources.<source>.<table>` (`source('shop', 'orders')` →
 * `dbt_sources.shop.orders`), a view in a small in-memory catalog the DuckDB
 * connection attaches. Sync, the metadata catalog and lineage use that name.
 */

/** The in-memory catalog that holds dbt-duckdb external sources as views. */
export const DBT_SOURCES_CATALOG = 'dbt_sources';

/** What a source's location is read as (the reader dbt-duckdb would use). */
export type DbtExternalSourceFormat = 'auto' | 'parquet' | 'csv' | 'json' | 'excel' | 'delta' | 'iceberg';

export interface DbtExternalSource {
  /** The dbt source's unique id (`source.shop.raw.orders`). */
  uniqueId: string;
  /** The dbt source name: the schema of its ZLens table. */
  source: string;
  /** The source table (its identifier): the name of its ZLens table. */
  table: string;
  /** The ZLens relation: `dbt_sources.shop.orders`. */
  relation: string;
  /** Where the data is, as dbt wrote it (relative paths are relative to the dbt project). */
  path: string;
  format: DbtExternalSourceFormat;
  /** Reader options dbt passes that ZLens does not (`header = true`): the reader finds them itself. */
  options?: string;
}

const READER_FORMATS: Record<string, DbtExternalSourceFormat> = {
  read_csv: 'csv', read_csv_auto: 'csv',
  read_parquet: 'parquet', parquet_scan: 'parquet',
  read_json: 'json', read_json_auto: 'json', read_ndjson: 'json', read_ndjson_auto: 'json',
  read_xlsx: 'excel',
  delta_scan: 'delta',
  iceberg_scan: 'iceberg',
};

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): UnknownRecord => (value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** A dbt name as a DuckDB identifier: lower case, letters, digits and `_`. */
function identifier(value: string): string {
  const clean = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return clean || 'source';
}

/**
 * Whether a `relation_name` is a location rather than a table name: a quoted
 * path or a reader call. Such a name is never split into database, schema
 * and table.
 */
export function isDbtExternalRelationName(relationName: string | undefined): boolean {
  const value = relationName?.trim() ?? '';
  return /^'/.test(value) || /^[a-z_][a-z0-9_]*\s*\(/i.test(value);
}

/** A location as dbt wrote it: a quoted path, or a reader call with a quoted first argument. */
function parseLocation(relationName: string): { path: string; format: DbtExternalSourceFormat; options?: string } | undefined {
  const value = relationName.trim();
  const literal = /^'((?:[^']|'')*)'$/.exec(value);
  if (literal) return { path: literal[1].replace(/''/g, "'"), format: 'auto' };
  const call = /^([a-z_][a-z0-9_]*)\s*\(\s*'((?:[^']|'')*)'\s*(?:,\s*([\s\S]*?))?\s*\)$/i.exec(value);
  if (!call) return undefined;
  const format = READER_FORMATS[call[1].toLowerCase()];
  if (!format) return undefined;
  const options = call[3]?.trim();
  return { path: call[2].replace(/''/g, "'"), format, ...(options ? { options } : {}) };
}

/** dbt-duckdb's `external_location` of a source table (its own, else its source's), with `{name}`-style fields filled in. */
function externalLocation(node: UnknownRecord): string | undefined {
  const config = record(node.config);
  const raw = text(config.external_location) ?? text(record(config.meta).external_location) ?? text(record(node.meta).external_location)
    ?? text(record(node.source_meta).external_location);
  if (!raw) return undefined;
  const fields: Record<string, string | undefined> = {
    name: text(node.name),
    identifier: text(node.identifier) ?? text(node.name),
    schema: text(node.schema),
    source_name: text(node.source_name),
  };
  return raw.replace(/\{(\w+)\}/g, (whole, key: string) => fields[key] ?? whole);
}

/**
 * The external source a dbt source node reads, or undefined when it is a
 * table in the database (or a location ZLens cannot read: a list of paths, a
 * reader it does not know).
 */
export function dbtExternalSource(uniqueId: string, value: unknown): DbtExternalSource | undefined {
  const node = record(value);
  if (node.resource_type !== undefined && node.resource_type !== 'source') return undefined;
  const relationName = text(node.relation_name);
  let location: ReturnType<typeof parseLocation>;
  if (relationName && isDbtExternalRelationName(relationName)) {
    location = parseLocation(relationName);
  } else if (!relationName) {
    const raw = externalLocation(node);
    location = raw ? parseLocation(isDbtExternalRelationName(raw) ? raw : `'${raw.replace(/'/g, "''")}'`) : undefined;
  }
  if (!location) return undefined;
  const source = identifier(text(node.source_name) ?? text(node.schema) ?? 'source');
  const table = identifier(text(node.identifier) ?? text(node.name) ?? 'source');
  return { uniqueId, source, table, relation: `${DBT_SOURCES_CATALOG}.${source}.${table}`, ...location };
}

/** Every external source of a dbt manifest, by unique id order. */
export function dbtExternalSources(manifest: unknown): DbtExternalSource[] {
  return Object.entries(record(record(manifest).sources))
    .map(([uniqueId, value]) => dbtExternalSource(uniqueId, value))
    .filter((source): source is DbtExternalSource => Boolean(source))
    .sort((left, right) => left.uniqueId.localeCompare(right.uniqueId));
}

/**
 * Where a dbt source or model lives for ZLens: its `relation_name`, except
 * that an external source is its `dbt_sources.<source>.<table>` table, and a
 * location ZLens cannot read is no relation at all (undefined), never a name
 * split on the dots of a path.
 */
export function dbtPhysicalRelation(uniqueId: string, node: unknown): { relation?: string; database?: string; schema?: string; external?: DbtExternalSource } {
  const value = record(node);
  const external = dbtExternalSource(uniqueId, value);
  if (external) return { relation: external.relation, database: DBT_SOURCES_CATALOG, schema: external.source, external };
  const relationName = text(value.relation_name);
  if (relationName && isDbtExternalRelationName(relationName)) return {};
  return {
    ...(relationName ? { relation: relationName } : {}),
    ...(text(value.database) ? { database: text(value.database) } : {}),
    ...(text(value.schema) ? { schema: text(value.schema) } : {}),
  };
}
