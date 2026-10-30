import type { QueryBatch, QueryExecutionOptions, QueryResult } from './result-types.js';

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
   * File connections: a folder whose CSV, TSV, Parquet and JSON files each
   * become a view named after the file (`orders.csv` → `orders`), so the
   * folder reads like a database. The files are read where they are, at
   * query time.
   */
  dataFolder?: string;
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
  schema: string;
  name: string;
  type: string; // 'BASE TABLE' | 'VIEW' | etc.
}

export interface ColumnInfo {
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
  listColumns?(schema?: string, table?: string): Promise<ColumnInfo[]>;
}
