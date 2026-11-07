import type { QueryBatch, QueryExecutionOptions, QueryResult } from './result-types.js';

/** A named table of a file connection, read where it is: a file, a folder of files, a Delta or Iceberg table, an Excel sheet. */
export interface LakeSourceConfig {
  /** The table's name; by default the last part of `path` (`s3://lake/sales/orders/` → `orders`). */
  name?: string;
  /** A path (relative to the project) or a bucket URL (`s3://`, `gs://`, `az://`, `abfss://`, `r2://`, `https://`). */
  path: string;
  /** What it is: found from the path (`auto`, the default), or said. */
  format?: 'auto' | 'parquet' | 'csv' | 'json' | 'excel' | 'delta' | 'iceberg';
  /** An Excel sheet (default: the first). */
  sheet?: string;
  /**
   * Made in a catalog of ZLens's own (an in-memory database it attaches)
   * rather than beside the connection's tables: `catalog.schema.name`. A dbt
   * project's external sources are `dbt_sources.<source>.<table>`.
   */
  catalog?: string;
  /** The schema in `catalog` (default `main`). */
  schema?: string;
}

/** The kinds of catalog a connection attaches: database files, and catalog services. */
export type LakeCatalogType = 'duckdb' | 'ducklake' | 'sqlite' | 'iceberg' | 'glue' | 's3_tables' | 'unity';

/**
 * A catalog attached read-only beside a connection's own database: a DuckDB,
 * DuckLake or SQLite file (`path`), or a catalog service (an Iceberg REST
 * catalog, AWS Glue, S3 Tables, Unity Catalog). Its tables are
 * `name.schema.table`. Secret fields (`clientSecret`, `token`, `password`)
 * are connection secrets: `${ENV}` or the private secrets file.
 */
export interface LakeCatalogConfig {
  /** The catalog's name: its tables are `name.schema.table`. */
  name: string;
  /**
   * Database files: a path (relative to the project) or a bucket URL. A
   * `ducklake` catalog may also keep its catalog in a database:
   * `postgres:dbname=lake host=db.internal user=zlens`, `mysql:…`, `sqlite:meta.sqlite`.
   */
  path?: string;
  /** Found from the path's extension when left out (`.ducklake`, `.sqlite`, `.db`/`.duckdb`). */
  type?: LakeCatalogType;
  /** Iceberg REST and Unity Catalog: the catalog's address (`https://catalog.example.com/catalog`). */
  endpoint?: string;
  /** Iceberg REST: the warehouse (or catalog) to open on the endpoint. */
  warehouse?: string;
  /** Iceberg REST sign-in: `oauth2` (client id and secret), `token`, or `none`. Found from the fields given when left out. */
  auth?: 'none' | 'oauth2' | 'token';
  clientId?: string;
  clientSecret?: string;
  /** OAuth2 token address, when it is not the catalog's own `/v1/oauth/tokens`. */
  oauth2Url?: string;
  /** OAuth2 scope (`PRINCIPAL_ROLE:ALL` for Polaris, a Lakekeeper scope). */
  scope?: string;
  /** Iceberg REST bearer token (R2 Data Catalog), or Unity Catalog personal access token. */
  token?: string;
  /** Iceberg REST: who reads the table files: `catalog` (default: the credentials it hands out) or `storage` (this connection's `storage`). */
  files?: 'catalog' | 'storage';
  /** AWS Glue: the account id (`123456789012`, or `123456789012:s3tablescatalog/bucket`). */
  account?: string;
  /** S3 Tables: the table bucket's ARN. */
  arn?: string;
  /** AWS Glue: its region (default: `storage.s3.region`). Unity Catalog: the region of the storage holding its tables. */
  region?: string;
  /** Unity Catalog: the catalog to open. */
  catalog?: string;
  /** DuckLake with its catalog in Postgres or MySQL: the database password. */
  password?: string;
  /** DuckLake: where its data files are, when not where the catalog says. */
  dataPath?: string;
  /** DuckLake in Postgres or MySQL: the schema holding its catalog, when one database holds several. */
  metadataSchema?: string;
  /** Catalog services: the namespaces (schemas) to read; all by default. */
  namespaces?: string[];
}

/** How a DuckDB or file connection reaches buckets. */
export interface LakeStorageConfig {
  /** Amazon S3, and other S3 APIs (MinIO, Ceph, Wasabi) through `endpoint`. */
  s3?: {
    region?: string;
    /**
     * `credential_chain` (default: environment, profile, SSO, instance role),
     * `keys`, or `none`: public data, read without signing in (an open-data
     * bucket in `region`).
     */
    auth?: 'credential_chain' | 'keys' | 'none';
    /** An AWS profile of `~/.aws/config` (credential chain). */
    profile?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    /** Another S3 API: `minio.internal:9000`. */
    endpoint?: string;
    urlStyle?: 'path' | 'vhost';
    useSsl?: boolean;
  };
  /** Google Cloud Storage. */
  gcs?: {
    /** `credential_chain` (default: application default credentials) or `hmac` keys. */
    auth?: 'credential_chain' | 'hmac';
    keyId?: string;
    secret?: string;
  };
  /** Azure Blob Storage and ADLS Gen2. */
  azure?: {
    /** `credential_chain` (default: Azure CLI, environment, managed identity) or `connection_string`. */
    auth?: 'credential_chain' | 'connection_string';
    accountName?: string;
    connectionString?: string;
  };
  /** Cloudflare R2. */
  r2?: {
    accountId?: string;
    keyId?: string;
    secret?: string;
  };
}

export interface ConnectionConfig {
  driver:
    | 'postgresql'
    | 'mysql'
    | 'sqlite'
    | 'bigquery'
    | 'snowflake'
    | 'duckdb'
    | 'mssql'
    | 'file'
    | 'redshift'
    | 'fabric'
    | 'clickhouse'
    | 'databricks'
    | 'athena'
    | 'trino';
  host?: string;
  port?: number;
  database?: string;
  catalog?: string;
  username?: string;
  password?: string;
  token?: string;
  ssl?: boolean;
  /** TLS policy (libpq terms): `require` encrypts, `verify-full` also checks the certificate. */
  sslMode?: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  /** A CA bundle for `verify-ca` / `verify-full`: a PEM file path or the PEM text. */
  sslRootCert?: string;
  /** Redshift provisioned cluster, for IAM sign-in. */
  clusterId?: string;
  /**
   * Reach a database inside a private network through an SSH bastion.
   * Supported for PostgreSQL, Redshift, MySQL and SQL Server.
   */
  sshTunnel?: {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
    privateKeyPath?: string;
    passphrase?: string;
  };
  /** The name TLS checks the certificate against when the socket goes through a tunnel. */
  tlsServername?: string;
  /** SQL Server / Fabric: accept a self-signed server certificate. */
  trustServerCertificate?: boolean;
  filepath?: string;
  /**
   * File connections: a folder (on disk, or a bucket: `s3://lake/sales/`)
   * whose data files, Excel sheets, Delta and Iceberg tables and folders of
   * files each become a view named after them (`orders.csv` → `orders`), so
   * the folder reads like a database. The data is read where it is, at query
   * time. See `readDataFolder`.
   */
  dataFolder?: string;
  /**
   * DuckDB and file connections: named tables at any path or bucket URL, read
   * where they are. A source's name wins over a table of the data folder.
   */
  sources?: LakeSourceConfig[];
  /**
   * DuckDB and file connections: catalogs attached read-only beside the
   * connection's own database: DuckDB, DuckLake or SQLite files (on disk or
   * in a bucket), Iceberg REST catalogs, AWS Glue, S3 Tables, Unity Catalog.
   * Their tables are `name.schema.table`.
   */
  catalogs?: LakeCatalogConfig[];
  /**
   * DuckDB and file connections: how buckets are reached. Credentials come
   * from the cloud's own sign-in (the credential chain) unless keys are given;
   * they are held in memory only.
   */
  storage?: LakeStorageConfig;
  /**
   * DuckDB and file connections, with a host: folders whose files a statement
   * may still read once the engine is restricted (`restrictExternalAccess`),
   * for example a data folder mounted for this connection. None by default.
   */
  allowedDirectories?: string[];
  /**
   * DuckDB and file connections: set by DQL when it serves people through a
   * host (RFC 0010). The engine then reads no files (beyond
   * `allowedDirectories`), no environment, installs and loads no extensions
   * and opens no network connection, and its settings are locked, after the
   * database itself is open.
   */
  restrictExternalAccess?: boolean;
  projectId?: string;
  account?: string;
  warehouse?: string;
  workgroup?: string;
  schema?: string;
  role?: string;
  region?: string;
  outputLocation?: string;
  httpPath?: string;
  privateKey?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  connectionString?: string;
  accessUrl?: string;
  application?: string;
  browserActionTimeout?: number;
  clientRequestMFAToken?: boolean;
  clientStoreTemporaryCredential?: boolean;
  clientSessionKeepAlive?: boolean;
  clientSessionKeepAliveHeartbeatFrequency?: number;
  credentialCacheDir?: string;
  keepAlive?: boolean;
  noProxy?: string;
  oauthAuthorizationUrl?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRedirectUri?: string;
  oauthScope?: string;
  oauthTokenRequestUrl?: string;
  passcode?: string;
  passcodeInPassword?: boolean;
  proxyHost?: string;
  proxyPassword?: string;
  proxyPort?: number;
  proxyProtocol?: string;
  proxyUser?: string;
  queryTag?: string;
  timeout?: number;
  workloadIdentityProvider?: string;
  workloadIdentityAzureClientId?: string;
  workloadIdentityImpersonationPath?: string[];
  waitTimeout?: string;
  byteLimit?: number;
  authMethod?:
    | 'password'
    | 'key_pair'
    | 'external_browser'
    | 'mfa'
    | 'oauth'
    | 'oauth_authorization_code'
    | 'oauth_client_credentials'
    | 'programmatic_access_token'
    | 'workload_identity'
    | 'application_default'
    | 'service_account_key_file'
    | 'service_account_json'
    | 'aws_default'
    | 'aws_profile'
    | 'aws_access_key'
    | 'token'
    | 'azure_default'
    | 'azure_service_principal'
    | 'azure_password';
  authenticator?: string;
  keyFilename?: string;
  serviceAccountJson?: string;
  credentials?: Record<string, unknown>;
  location?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  profile?: string;
  /** Microsoft Entra tenant for SQL Server / Fabric service principals. */
  tenantId?: string;
  /**
   * Where a file-backed SQLite connection runs its queries: on its own thread
   * (default), where a deadline can stop a slow one, or on the caller's
   * (`inline`). ZLENS_SQLITE_QUERY_ISOLATION=inline sets the same.
   */
  sqliteQueryIsolation?: 'worker' | 'inline';
  moduleSearchPaths?: string[];
}

export type DriverName = ConnectionConfig['driver'];

export interface TableInfo {
  /**
   * DuckDB: the database a table is in, only when it is attached beside the
   * one the connection opened (`ATTACH … AS lake` → `lake`). Its name is then
   * `catalog.schema.name`; without it, `schema.name`.
   */
  catalog?: string;
  schema: string;
  name: string;
  type: string; // 'BASE TABLE' | 'VIEW' | etc.
}

export interface ColumnInfo {
  /** As `TableInfo.catalog`: set for a table in an attached database only. */
  catalog?: string;
  schema: string;
  table: string;
  name: string;
  dataType: string;
  ordinalPosition: number;
}

export interface DatabaseConnector {
  readonly driverName: DriverName;
  connect(config: ConnectionConfig): Promise<void>;
  execute(sql: string, params?: unknown[], options?: QueryExecutionOptions): Promise<QueryResult>;
  stream?(sql: string, params?: unknown[], options?: QueryExecutionOptions): AsyncIterable<QueryBatch>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  listTables?(): Promise<TableInfo[]>;
  /** DuckDB also takes `catalog.schema` for a table in an attached database. */
  listColumns?(schema?: string, table?: string): Promise<ColumnInfo[]>;
}
