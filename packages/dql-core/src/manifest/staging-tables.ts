/**
 * Staging tables and the names a first Domain takes (new-user round 2, Q3).
 *
 * A database that a dbt project (or any layered pipeline) built often holds
 * the same thing twice: `stg_customers` next to `customers`, or a `raw` schema
 * beside the modeled one. A new user should see the final table, with the
 * staging copy one toggle away. The same rule runs on the server (Draft my
 * models) and in the browser (setup's schema list, the Data list), so it lives
 * here.
 *
 * Deliberately dependency-free: this module is exposed as the browser-safe
 * `@zlens/core/staging-tables` subpath. Do not add imports here.
 */

/** Schemas that hold staging or raw copies of tables, by name. */
export const STAGING_SCHEMAS: ReadonlySet<string> = new Set(['staging', 'stg', 'raw']);

/** A table name that says it is a staging or raw copy. */
const STAGING_TABLE_PREFIX = /^(stg|staging|raw)_+/i;
/** Layer prefixes that do not change what a row is (`dim_customers` is customers). */
const LAYER_PREFIX = /^(stg|staging|raw|dim|fct|fact|int|base|src)_+/i;

/**
 * Schema names that say where data sits in a pipeline or which environment it
 * is, not what it is about. A first Domain is never named after one of these
 * (`dev`, `main`, `public` …); it takes the database's name instead.
 */
export const TECHNICAL_SCHEMAS: ReadonlySet<string> = new Set([
  'main', 'public', 'dbo', 'default',
  'dev', 'development', 'prod', 'production', 'test', 'testing', 'qa', 'uat', 'sandbox', 'local',
  'staging', 'stg', 'raw', 'src', 'source', 'sources', 'landing', 'intermediate', 'int',
  'analytics', 'marts', 'mart', 'core', 'reporting', 'bronze', 'silver', 'gold',
  'warehouse', 'dw', 'dwh', 'edw', 'information_schema',
]);

/** Database names that say nothing about the data (DuckDB's in-memory `memory`, Postgres's `postgres` …). */
const GENERIC_DATABASES: ReadonlySet<string> = new Set([
  'memory', 'main', 'temp', 'system', 'default', 'postgres', 'master', 'defaultdb', 'database', 'db', 'data', 'warehouse',
]);

export function isStagingSchema(schema: string | undefined): boolean {
  return Boolean(schema && STAGING_SCHEMAS.has(schema.toLowerCase()));
}

/** A schema named for a pipeline layer or environment (`dev`, `main`, `dbt_kranthi`), not a business area. */
export function isTechnicalSchema(schema: string | undefined): boolean {
  if (!schema) return true;
  const name = schema.toLowerCase();
  return TECHNICAL_SCHEMAS.has(name) || /^dbt(_|$)/.test(name);
}

/** A staging or raw copy: a `stg_` (or `staging_`, `raw_`) name, or a table in a staging/stg/raw schema. */
export function isStagingTable(table: { schema?: string; name: string }): boolean {
  return isStagingSchema(table.schema) || STAGING_TABLE_PREFIX.test(table.name);
}

function singular(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('sses') || name.endsWith('xes') || name.endsWith('ches') || name.endsWith('shes')) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

/** What one row is, from a table name: `stg_customers`, `dim_customers` and `customers` are all `customer`. */
export function tableEntityKey(name: string): string {
  let base = name.toLowerCase();
  // `stg_raw_customers` and similar stack prefixes.
  for (let guard = 0; guard < 3 && LAYER_PREFIX.test(base); guard += 1) base = base.replace(LAYER_PREFIX, '');
  return singular(base.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
}

/**
 * The staging tables that duplicate a final table, mapped to that final
 * table's id. A staging table with no final counterpart is not a duplicate:
 * it is the only copy of its data and stays visible.
 */
export function stagingDuplicates<T extends { id: string; schema?: string; name: string }>(tables: readonly T[]): Map<string, string> {
  const finals = new Map<string, string>();
  for (const table of tables) {
    if (isStagingTable(table)) continue;
    const key = tableEntityKey(table.name);
    if (key && !finals.has(key)) finals.set(key, table.id);
  }
  const duplicates = new Map<string, string>();
  for (const table of tables) {
    if (!isStagingTable(table)) continue;
    const final = finals.get(tableEntityKey(table.name));
    if (final && final !== table.id) duplicates.set(table.id, final);
  }
  return duplicates;
}

/**
 * Split a table list into what a person sees first and the staging duplicates
 * behind "Show staging tables". `keep` holds a table visible regardless (one
 * the project already models, say).
 */
export function splitStagingTables<T extends { id: string; schema?: string; name: string }>(
  tables: readonly T[],
  options: { show?: boolean; keep?: (table: T) => boolean } = {},
): { shown: T[]; hidden: T[] } {
  const duplicates = stagingDuplicates(tables);
  if (options.show || duplicates.size === 0) return { shown: [...tables], hidden: [] };
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const table of tables) {
    if (duplicates.has(table.id) && !options.keep?.(table)) hidden.push(table);
    else shown.push(table);
  }
  return { shown, hidden };
}

/**
 * Split a schema list the same way: staging/stg/raw schemas wait behind the
 * toggle when the database has other schemas. `keep` holds a schema visible
 * (one already ticked).
 */
export function splitStagingSchemas<T extends { name: string }>(
  schemas: readonly T[],
  options: { show?: boolean; keep?: (schema: T) => boolean } = {},
): { shown: T[]; hidden: T[] } {
  const staging = schemas.filter((schema) => isStagingSchema(schema.name));
  if (options.show || staging.length === 0 || staging.length === schemas.length) return { shown: [...schemas], hidden: [] };
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const schema of schemas) {
    if (isStagingSchema(schema.name) && !options.keep?.(schema)) hidden.push(schema);
    else shown.push(schema);
  }
  return { shown, hidden };
}

/** "jaffle_shop" → "Jaffle shop": a database or file name in words, first word capitalized. */
export function sentenceCaseName(value: string): string {
  const words = value
    .replace(/\.(duckdb|ddb|db|sqlite3?)$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s.]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (!words.length) return value;
  const first = words[0]!;
  return [`${first[0]!.toUpperCase()}${first.slice(1)}`, ...words.slice(1)].join(' ');
}

/**
 * The database's own name, when it says something about the data: a DuckDB or
 * SQLite file's name (`jaffle_shop.duckdb` → `jaffle_shop`), or the catalog or
 * database the schemas live in. Generic names (`memory`, `main`, `postgres`)
 * give undefined.
 */
export function meaningfulDatabaseName(...candidates: Array<string | undefined | null>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const base = candidate.split(/[\\/]/).pop()!.replace(/\.(duckdb|ddb|db|sqlite3?|parquet)$/i, '').trim();
    if (!base || base === ':memory:' || GENERIC_DATABASES.has(base.toLowerCase())) continue;
    return base;
  }
  return undefined;
}
