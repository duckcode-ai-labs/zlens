// @dql/connectors - DQL Database Connectors

export type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo, LakeCatalogConfig, LakeSourceConfig, LakeStorageConfig } from './connector.js';
export {
  ConnectorQueryError,
  type QueryBatch,
  type QueryExecutionOptions,
  type QueryPurpose,
  type QueryResult,
  type ColumnMeta,
  type ColumnType,
  type Row,
} from './result-types.js';
export { ConnectionPoolManager } from './connection-pool.js';
export { QueryExecutor } from './query-executor.js';
export { MissingConnectorDependencyError, ConnectorNativeBindingError } from './optional-dependency.js';
export {
  NATIVE_INSTALL_SCRIPT_PACKAGES,
  NATIVE_OPTIONAL_BINARY_PACKAGES,
  isNativeBindingError,
  isNodeAbiMismatch,
  nativeBindingHelp,
  nativeInstallContextFor,
  packageManagerFromUserAgent,
  type NativeBindingHelpOptions,
  type NativeInstallContext,
} from './native-binding.js';
export type { SQLParamSpec } from './sql-params.js';
export { buildParamValues, expandArrayParameters, normalizeSQLPlaceholders } from './sql-params.js';
export { SnowflakeConnector } from './drivers/snowflake.js';
export { DuckDBConnector, DUCKDB_DRIVER_PACKAGE, duckDBNewerFileMessage, duckDBOpenFailureMessage, ZLENS_DUCKDB_READER_LINE, type DuckDBConsistentReadScope } from './drivers/duckdb.js';
export { FileConnector } from './drivers/file.js';
export {
  dataFolderSkipped,
  dataFolderTables,
  excelSheets,
  isDataFile,
  isUrlPath,
  newestIcebergMetadata,
  readDataFolder,
  type DataFolderCatalog,
  type DataFolderContents,
  type DataFolderSkip,
  type DataFolderTable,
} from './data-folder.js';
export { type DataFolderProblem, type DataFolderStatus } from './data-folder-views.js';
export { defaultLakeSignIns, describeLakeStorage, lakeSignInFailure, lakeStorageClouds, lakeStorageSecretStatements } from './lake-storage.js';
export { LAKE_LISTING_DEADLINE_MS, listBucketPrefix, readBucketFolder, resolveLakeSources, type LakeProblem } from './lake-listing.js';
export { DatabricksConnector } from './drivers/databricks.js';
export { SQLiteConnector } from './drivers/sqlite.js';
export { PostgreSQLConnector } from './drivers/postgresql.js';
export { RedshiftConnector } from './drivers/redshift.js';
export { MySQLConnector } from './drivers/mysql.js';
export { MSSQLConnector } from './drivers/mssql.js';
export { FabricConnector } from './drivers/fabric.js';
export { TrinoConnector } from './drivers/trino.js';
export { ClickHouseConnector } from './drivers/clickhouse.js';
export { AthenaConnector } from './drivers/athena.js';
export { BigQueryConnector } from './drivers/bigquery.js';
