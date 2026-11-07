import type { LakeCatalogConfig, LakeCatalogType, LakeStorageConfig } from './connector.js';
import { namedLakeSecret, s3SecretOptions } from './lake-storage.js';

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;
const sqlIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** Catalog services: reached over the network, attached lazily (nothing is asked until tables are listed). */
export const LAKE_CATALOG_SERVICES: ReadonlySet<LakeCatalogType> = new Set(['iceberg', 'glue', 's3_tables', 'unity']);

/** At most this many tables of a lazy catalog are described (looked up one by one) to learn their columns. */
export const LAKE_CATALOG_DESCRIBE_TABLES = 1_000;
/** And for at most this long per catalog. */
export const LAKE_CATALOG_DESCRIBE_MS = 60_000;

/** How a configured catalog is attached: the secrets it needs (in memory), then one read-only `ATTACH`. */
export interface LakeCatalogPlan {
  /** `CREATE OR REPLACE SECRET` statements to run first: held in memory, never written by DuckDB. */
  secrets: string[];
  /** The `ATTACH IF NOT EXISTS … (READ_ONLY)` statement. */
  attach: string;
  /** Where it is attached from, in plain words, never with a secret: `http://127.0.0.1:8181/catalog (warehouse lab)`. */
  source: string;
  /** A catalog service: attaching asks it nothing, so it is checked by listing its schemas right after. */
  service: boolean;
  /** Its tables are listed with a placeholder column until each is described (Iceberg catalogs in DuckDB 1.5). */
  describeTables: boolean;
  /** The namespaces (schemas) read; all when undefined. */
  namespaces?: string[];
}

/** A required setting of a catalog, or a plain error naming it. */
function required(value: string | undefined, catalog: string, setting: string, why: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`catalog ${catalog}: "${setting}" is missing: ${why}`);
  return text;
}

/** A Postgres or MySQL connection string without its password, to show. */
export function withoutPassword(text: string): string {
  return text.replace(/\b(password|passwd|pwd)\s*=\s*('[^']*'|"[^"]*"|\S+)/gi, '$1=…');
}

const DUCKLAKE_DATABASE = /^(postgres|postgresql|mysql|sqlite):/i;

/** Whether a DuckLake catalog keeps its catalog in a database (`postgres:…`, `mysql:…`, `sqlite:…`) rather than a `.ducklake` file. */
export function isDuckLakeDatabase(path: string | undefined): boolean {
  return DUCKLAKE_DATABASE.test(path?.trim() ?? '');
}

/** What a configured catalog is, by its `type` or its path. */
export function lakeCatalogType(catalog: Pick<LakeCatalogConfig, 'type' | 'path'>): LakeCatalogType {
  if (catalog.type) return catalog.type;
  const path = catalog.path?.trim() ?? '';
  if (isDuckLakeDatabase(path)) return 'ducklake';
  const extension = (/(\.[a-z0-9]+)$/i.exec(path)?.[1] ?? '').toLowerCase();
  return extension === '.ducklake' ? 'ducklake' : extension === '.sqlite' || extension === '.sqlite3' ? 'sqlite' : 'duckdb';
}

/**
 * Whether a catalog needs more than `ATTACH '<file>'`: a catalog service, or
 * a DuckLake catalog kept in a database or with its data elsewhere.
 */
export function needsLakeCatalogPlan(catalog: LakeCatalogConfig): boolean {
  const type = lakeCatalogType(catalog);
  return LAKE_CATALOG_SERVICES.has(type)
    || (type === 'ducklake' && (isDuckLakeDatabase(catalog.path) || Boolean(catalog.password?.trim() || catalog.dataPath?.trim() || catalog.metadataSchema?.trim())));
}

/** The AWS region in an S3 Tables ARN (`arn:aws:s3tables:us-east-1:123456789012:bucket/lake`). */
function arnRegion(arn: string): string | undefined {
  return /^arn:aws[a-z-]*:s3tables:([a-z0-9-]+):/i.exec(arn)?.[1];
}

/**
 * How to attach a configured catalog (`name` is its catalog name in DuckDB):
 * an Iceberg REST catalog, AWS Glue, S3 Tables, Unity Catalog, or a DuckLake
 * catalog kept in a database. Always read-only; secrets are in memory and
 * named after what they hold. A missing setting is a plain error.
 */
export function lakeCatalogPlan(catalog: LakeCatalogConfig, name: string, storage?: LakeStorageConfig): LakeCatalogPlan {
  const type = lakeCatalogType(catalog);
  const label = catalog.name?.trim() || name;
  const namespaces = (catalog.namespaces ?? []).map((value) => String(value).trim()).filter(Boolean);
  const scoped = namespaces.length ? { namespaces } : {};
  const attach = (target: string, options: string[]) => `ATTACH IF NOT EXISTS ${sqlText(target)} AS ${sqlIdent(name)} (${[...options, 'READ_ONLY'].join(', ')})`;

  if (type === 'iceberg') {
    const endpoint = required(catalog.endpoint, label, 'endpoint', 'an Iceberg REST catalog needs its address').replace(/\/+$/, '');
    const warehouse = required(catalog.warehouse, label, 'warehouse', 'an Iceberg REST catalog needs the warehouse (or catalog) to open');
    const auth = catalog.auth ?? (catalog.clientId?.trim() || catalog.clientSecret?.trim() ? 'oauth2' : catalog.token?.trim() ? 'token' : 'none');
    const options = ['TYPE iceberg', `ENDPOINT ${sqlText(endpoint)}`];
    const secrets: string[] = [];
    let signIn = 'no sign-in';
    if (auth === 'oauth2') {
      const clientId = required(catalog.clientId, label, 'clientId', 'an OAuth2 sign-in needs the client id');
      const secret = namedLakeSecret('iceberg', [
        `CLIENT_ID ${sqlText(clientId)}`,
        `CLIENT_SECRET ${sqlText(required(catalog.clientSecret, label, 'clientSecret', 'an OAuth2 sign-in needs the client secret'))}`,
        `OAUTH2_SERVER_URI ${sqlText(catalog.oauth2Url?.trim() || `${endpoint}/v1/oauth/tokens`)}`,
        ...(catalog.scope?.trim() ? [`OAUTH2_SCOPE ${sqlText(catalog.scope.trim())}`] : []),
      ]);
      secrets.push(secret.statement);
      options.push(`SECRET ${secret.name}`);
      signIn = `OAuth2 client ${clientId}`;
    } else if (auth === 'token') {
      const secret = namedLakeSecret('iceberg', [`TOKEN ${sqlText(required(catalog.token, label, 'token', 'a token sign-in needs the token'))}`]);
      secrets.push(secret.statement);
      options.push(`SECRET ${secret.name}`);
      signIn = 'a token';
    } else {
      options.push(`AUTHORIZATION_TYPE 'none'`);
    }
    // A self-hosted catalog (on MinIO) hands out no credentials: the connection's own storage reads the files.
    if (catalog.files === 'storage') options.push(`ACCESS_DELEGATION_MODE 'none'`);
    return {
      secrets,
      attach: attach(warehouse, options),
      source: `${endpoint} (warehouse ${warehouse}; ${signIn}; files read with ${catalog.files === 'storage' ? 'this connection\'s storage' : 'the credentials the catalog hands out'})`,
      service: true,
      describeTables: true,
      ...scoped,
    };
  }

  if (type === 'glue' || type === 's3_tables') {
    const target = type === 'glue'
      ? required(catalog.account, label, 'account', 'an AWS Glue catalog needs the AWS account id')
      : required(catalog.arn, label, 'arn', 'an S3 Tables catalog needs the table bucket\'s ARN');
    const region = type === 's3_tables'
      ? arnRegion(target) ?? required(catalog.region, label, 'region', 'the ARN names no region')
      : required(catalog.region ?? storage?.s3?.region, label, 'region', 'an AWS Glue catalog needs its region (or storage.s3.region)');
    // Signed with the AWS sign-in of the connection's storage (else the credential chain), in the catalog's region.
    const secret = namedLakeSecret('s3', s3SecretOptions({ ...(storage?.s3 ?? {}), region, endpoint: undefined }));
    return {
      secrets: [secret.statement],
      attach: attach(target, ['TYPE iceberg', `ENDPOINT_TYPE ${type}`, `SECRET ${secret.name}`]),
      source: type === 'glue' ? `AWS Glue, account ${target} (${region})` : `S3 Tables ${target}`,
      service: true,
      describeTables: true,
      ...scoped,
    };
  }

  if (type === 'unity') {
    const endpoint = required(catalog.endpoint, label, 'endpoint', 'Unity Catalog needs its address').replace(/\/+$/, '');
    const unity = required(catalog.catalog, label, 'catalog', 'Unity Catalog needs the catalog to open');
    // DuckDB's Unity Catalog reader needs the region of the storage holding the tables.
    const region = catalog.region?.trim() || storage?.s3?.region?.trim() || 'us-east-1';
    const secret = namedLakeSecret('unity_catalog', [
      `TOKEN ${sqlText(catalog.token?.trim() ?? '')}`,
      `ENDPOINT ${sqlText(endpoint)}`,
      `AWS_REGION ${sqlText(region)}`,
    ]);
    return {
      secrets: [secret.statement],
      attach: attach(unity, ['TYPE unity_catalog', `SECRET ${secret.name}`]),
      source: `${endpoint} (catalog ${unity}; ${catalog.token?.trim() ? 'a token' : 'no sign-in'})`,
      service: true,
      describeTables: false,
      ...scoped,
    };
  }

  if (type === 'ducklake') {
    const path = required(catalog.path, label, 'path', 'a DuckLake catalog needs its catalog file or database');
    const dataPath = catalog.dataPath?.trim();
    if (isDuckLakeDatabase(path)) {
      const password = catalog.password?.trim();
      const metadata = password && /^(postgres|postgresql|mysql):/i.test(path) ? `${path} password=${password}` : path;
      // The catalog's address (with its password) is held in a secret, so the ATTACH text names no password.
      const metadataSchema = catalog.metadataSchema?.trim();
      const secret = namedLakeSecret('ducklake', [
        `METADATA_PATH ${sqlText(metadata)}`,
        ...(dataPath ? [`DATA_PATH ${sqlText(dataPath)}`] : []),
        ...(metadataSchema ? [`METADATA_SCHEMA ${sqlText(metadataSchema)}`] : []),
      ]);
      return {
        secrets: [secret.statement],
        attach: attach(`ducklake:${secret.name}`, []),
        source: `${withoutPassword(path)}${metadataSchema ? ` (schema ${metadataSchema})` : ''}`,
        service: false,
        describeTables: false,
      };
    }
    return {
      secrets: [],
      attach: attach(`ducklake:${path}`, dataPath ? [`DATA_PATH ${sqlText(dataPath)}`] : []),
      source: path,
      service: false,
      describeTables: false,
    };
  }

  throw new Error(`catalog ${label}: a ${type} file is attached by its path`);
}

/** Lists a catalog's schemas: a catalog service is first asked anything here (wrong address, catalog or sign-in fail now). */
export function lakeCatalogSchemasStatement(name: string): string {
  return `SELECT schema_name FROM information_schema.schemata WHERE catalog_name = ${sqlText(name)} ORDER BY schema_name`;
}

/** The tables of a lazy catalog whose columns are not known yet (listed with DuckDB's placeholder column). */
export function lakeCatalogUndescribedStatement(name: string, namespaces: string[] | undefined, limit: number): string {
  const inNamespaces = namespaces?.length ? ` AND schema_name IN (${namespaces.map(sqlText).join(', ')})` : '';
  return `SELECT schema_name, table_name FROM duckdb_columns() WHERE database_name = ${sqlText(name)} AND column_name = '__' AND data_type = 'UNKNOWN'${inNamespaces} ORDER BY schema_name, table_name LIMIT ${Math.max(1, Math.floor(limit))}`;
}

/** `DESCRIBE` one table of a catalog: DuckDB keeps its columns from then on, for every connection. */
export function lakeCatalogDescribeStatement(catalog: string, schema: string, table: string): string {
  return `DESCRIBE ${[catalog, schema, table].map(sqlIdent).join('.')}`;
}

const SERVICE_KINDS: Record<string, string> = {
  iceberg: 'Iceberg REST catalog',
  glue: 'AWS Glue catalog',
  s3_tables: 'S3 Tables catalog',
  unity: 'Unity Catalog',
};

/** A catalog's kind in plain words (`Iceberg REST catalog`, `DuckLake catalog in Postgres`). */
export function lakeCatalogKind(catalog: Pick<LakeCatalogConfig, 'type' | 'path'>): string {
  const type = lakeCatalogType(catalog);
  if (SERVICE_KINDS[type]) return SERVICE_KINDS[type];
  if (type === 'ducklake') {
    const database = /^(postgres|postgresql|mysql|sqlite):/i.exec(catalog.path?.trim() ?? '')?.[1]?.toLowerCase();
    if (database) return `DuckLake catalog in ${database === 'mysql' ? 'MySQL' : database === 'sqlite' ? 'SQLite' : 'Postgres'}`;
    return 'DuckLake catalog';
  }
  return type === 'sqlite' ? 'SQLite database' : 'DuckDB database';
}

/** A catalog error in plain words: what to check for the usual failures, with DuckDB's own words after. */
export function lakeCatalogFailure(catalog: Pick<LakeCatalogConfig, 'type' | 'path'>, error: unknown): string {
  const detail = (error instanceof Error ? error.message : String(error)).split('\n')[0].trim().replace(/^DuckDB query failed:\s*/i, '');
  const type = lakeCatalogType(catalog);
  const service = SERVICE_KINDS[type] ?? lakeCatalogKind(catalog);
  if (/could not connect|could not resolve|connection refused|timed out|timeout/i.test(detail)) {
    return `the ${service} cannot be reached: check its address (DuckDB: ${detail})`;
  }
  if (/NotFound_404|HTTP 404|\b404\b/i.test(detail)) {
    return `the ${service} does not know that ${type === 'unity' ? 'catalog' : type === 'iceberg' ? 'warehouse' : 'catalog'}: check its name (DuckDB: ${detail})`;
  }
  if (/Unauthorized|Forbidden|\b401\b|\b403\b|could not get token|token/i.test(detail)) {
    return `the ${service} refused the sign-in: check its credentials${type === 'glue' || type === 's3_tables' ? ' (your AWS sign-in, or storage.s3)' : ''} (DuckDB: ${detail})`;
  }
  return detail;
}
