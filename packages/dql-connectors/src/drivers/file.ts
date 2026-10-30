import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import { dataFolderTables, dataFolderViewStatements } from '../data-folder.js';
import type { QueryResult } from '../result-types.js';
import { DuckDBConnector } from './duckdb.js';

/**
 * FileConnector — uses DuckDB under the hood to query CSV, Parquet, JSON,
 * and Excel files directly with SQL.
 *
 * Usage in dql.config.ts:
 *   { driver: 'file', filepath: ':memory:' }
 *
 * Then in .dql files:
 *   SELECT * FROM read_csv('./data/sales.csv')
 *   SELECT * FROM read_parquet('./data/events.parquet')
 *   SELECT * FROM read_json('./data/config.json')
 *
 * With `dataFolder`, each data file in that folder is also a view named after
 * it (`SELECT * FROM orders` reads `orders.csv`), so sync, Setup and Ask see
 * the folder as tables.
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
    };
    await this.duckdb.connect(duckdbConfig);
    if (config.dataFolder) {
      for (const statement of dataFolderViewStatements(dataFolderTables(config.dataFolder))) await this.duckdb.execute(statement);
    }
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
