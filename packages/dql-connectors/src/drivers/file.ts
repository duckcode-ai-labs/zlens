import { statSync } from 'node:fs';
import type { DatabaseConnector, ConnectionConfig, TableInfo, ColumnInfo } from '../connector.js';
import { dataFolderTables, dataFolderViewStatement, dropDataFolderViewStatement } from '../data-folder.js';
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
 * the folder as tables. The views follow the folder: before each statement a
 * file added since gets its view and a removed one loses it. A file DuckDB
 * cannot read gets no view, and the others still work.
 */
export class FileConnector implements DatabaseConnector {
  readonly driverName = 'file';
  private duckdb: DuckDBConnector;
  private dataFolder: string | undefined;
  /** Views in a real DuckDB file would be written into it: they are temporary there. */
  private temporaryViews = false;
  /** View name → the file it reads, as last made. */
  private views = new Map<string, string>();
  /** Files that could not be read, with their modified time: tried again once they change. */
  private unreadable = new Map<string, number>();
  private refreshing: Promise<void> | null = null;

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
    this.dataFolder = config.dataFolder;
    this.temporaryViews = Boolean(config.filepath && config.filepath !== ':memory:');
    this.views.clear();
    this.unreadable.clear();
    await this.refreshDataFolderViews();
  }

  /** Make the views match the folder's files now. */
  async refreshDataFolderViews(): Promise<void> {
    if (!this.dataFolder) return;
    // One refresh at a time; statements arriving meanwhile wait for it.
    this.refreshing ??= this.syncViews().finally(() => { this.refreshing = null; });
    await this.refreshing;
  }

  private async syncViews(): Promise<void> {
    const tables = dataFolderTables(this.dataFolder!);
    const wanted = new Map(tables.map((table) => [table.name, table]));
    for (const name of [...this.views.keys()]) {
      if (wanted.get(name)?.file === this.views.get(name)) continue;
      await this.duckdb.execute(dropDataFolderViewStatement(name)).catch(() => undefined);
      this.views.delete(name);
    }
    for (const table of tables) {
      if (this.views.has(table.name)) continue;
      const modified = modifiedTime(table.file);
      if (this.unreadable.get(table.file) === modified) continue;
      try {
        await this.duckdb.execute(dataFolderViewStatement(table, { temporary: this.temporaryViews }));
        this.views.set(table.name, table.file);
        this.unreadable.delete(table.file);
      } catch {
        this.unreadable.set(table.file, modified);
      }
    }
  }

  async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
    await this.refreshDataFolderViews();
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

function modifiedTime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}
