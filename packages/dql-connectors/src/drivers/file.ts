import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import type { DataFolderStatus } from '../data-folder-views.js';
import type { QueryResult } from '../result-types.js';
import { DuckDBConnector } from './duckdb.js';

/**
 * FileConnector — uses DuckDB under the hood to query CSV, Parquet, JSON,
 * Excel, Delta and Iceberg data directly with SQL.
 *
 * Usage in dql.config.ts:
 *   { driver: 'file', filepath: ':memory:' }
 *
 * Then in .dql files:
 *   SELECT * FROM read_csv('./data/sales.csv')
 *   SELECT * FROM read_parquet('./data/events.parquet')
 *   SELECT * FROM read_json('./data/config.json')
 *
 * With `dataFolder`, each table the folder holds is also a view named after
 * it (`SELECT * FROM orders` reads `orders.csv`; see `readDataFolder` for
 * Excel sheets, Delta and Iceberg tables and folders of files), and its
 * DuckDB, DuckLake and SQLite files are attached read-only, so sync, Setup
 * and Ask see the folder as tables. The views follow the folder: before each
 * statement a table added since gets its view and a removed one loses it.
 * What DuckDB cannot read gets no view (`dataFolderStatus` says why), and the
 * others still work.
 */
export class FileConnector implements DatabaseConnector {
  readonly driverName = 'file';
  private duckdb: DuckDBConnector;

  constructor() {
    this.duckdb = new DuckDBConnector();
  }

  async connect(config: ConnectionConfig): Promise<void> {
    // The data folder's views read its files at query time, so a host's
    // restriction still lets them read that folder (and only the folders it allows).
    const allowedDirectories = [...(config.allowedDirectories ?? []), ...(config.dataFolder ? [config.dataFolder] : [])];
    // Use in-memory DuckDB by default for file queries
    const duckdbConfig: ConnectionConfig = {
      driver: 'duckdb',
      filepath: config.filepath ?? ':memory:',
      ...(config.moduleSearchPaths ? { moduleSearchPaths: config.moduleSearchPaths } : {}),
      // A host's restriction (and the folders it still allows) holds for file connections too.
      ...(config.restrictExternalAccess ? { restrictExternalAccess: true } : {}),
      ...(allowedDirectories.length ? { allowedDirectories } : {}),
      // In a real DuckDB file, the views are temporary: never written into it.
      ...(config.dataFolder ? { dataFolder: config.dataFolder } : {}),
    };
    await this.duckdb.connect(duckdbConfig);
  }

  /** Make the views match the folder's tables now. */
  async refreshDataFolderViews(): Promise<void> {
    await this.duckdb.dataFolderStatus();
  }

  /** Read a folder of data as tables (a file connection without a `dataFolder` of its own: the project's). */
  async useDataFolder(folder: string, options: { catalogs?: boolean } = {}): Promise<void> {
    await this.duckdb.useDataFolder(folder, options);
  }

  /** What this connection reads from its data folder, or undefined without one. */
  async dataFolderStatus(): Promise<DataFolderStatus | undefined> {
    return this.duckdb.dataFolderStatus();
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    return this.duckdb.execute(sql, params);
  }

  async disconnect(): Promise<void> {
    return this.duckdb.disconnect();
  }

  async ping(): Promise<boolean> {
    return this.duckdb.ping();
  }

  // The catalog lookups are DuckDB's, run through this connector's own `execute`, so whoever wraps this connector
  // (a host's statement check, RFC 0010) sees their statements too.
  async listTables(): Promise<TableInfo[]> {
    return DuckDBConnector.prototype.listTables.call(this);
  }

  async listColumns(schema?: string, table?: string): Promise<ColumnInfo[]> {
    return DuckDBConnector.prototype.listColumns.call(this, schema, table);
  }
}
