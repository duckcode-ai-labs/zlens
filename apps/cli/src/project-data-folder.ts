import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DuckDBConnector, FileConnector, type ConnectionConfig, type DatabaseConnector } from '@zlens/connectors';

/**
 * The project's data folder (`dataDir` in dql.config.json, else `data/`) read
 * as tables on a DuckDB or file connection that has no data folder of its own,
 * so `FROM orders` reads `data/orders.csv` (and an Excel sheet, a Delta or
 * Iceberg table, or a folder of files there, see `readDataFolder`).
 *
 * The connection keeps the views in step with the folder before each
 * statement. In a real DuckDB file they are temporary: nothing is written into
 * the user's database, and a table or view it already has keeps its name.
 * Database files in the folder are not attached here (a file connection's own
 * `dataFolder` does that).
 */
export async function useProjectDataFolder(
  executor: { getConnector(config: ConnectionConfig): Promise<DatabaseConnector> },
  connection: ConnectionConfig,
  projectRoot: string,
  dataDir?: string,
): Promise<void> {
  if (connection.driver !== 'duckdb' && connection.driver !== 'file') return;
  // A file connection's own data folder is read by the connection itself.
  if (connection.driver === 'file' && connection.dataFolder) return;
  const folder = dataDir ? resolve(projectRoot, dataDir) : join(projectRoot, 'data');
  if (!existsSync(folder)) return;
  const connector = await executor.getConnector(connection);
  if (connector instanceof DuckDBConnector || connector instanceof FileConnector) {
    await connector.useDataFolder(folder, { catalogs: false });
  }
}
