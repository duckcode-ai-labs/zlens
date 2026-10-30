import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectionConfigKey } from '../connection-pool.js';
import { dataFolderTables, dataFolderViewStatements, isDataFile } from '../data-folder.js';
import { DuckDBConnector } from './duckdb.js';
import { readEnv } from '../env.js';
import { FileConnector } from './file.js';

const configuredDuckDbConnectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = configuredDuckDbConnectorRoot ? it : it.skip;

const folders: string[] = [];
function dataFolder(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), 'zlens-data-folder-'));
  folders.push(folder);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(folder, name, '..'), { recursive: true });
    writeFileSync(join(folder, name), content);
  }
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('a data folder read as a database', () => {
  it('makes each CSV, TSV, Parquet or JSON file one table named after the file', () => {
    const folder = dataFolder({
      'orders.csv': 'id\n1\n',
      'Daily Sales-2026.parquet': '',
      'events.jsonl': '{}\n',
      '2026 targets.tsv': 'a\n',
      'notes.txt': 'not data',
      '.hidden.csv': 'a\n',
      'archive/old.csv': 'a\n',
    });
    expect(dataFolderTables(folder).map(({ name, reader }) => ({ name, reader }))).toEqual([
      { name: 't_2026_targets', reader: 'read_csv_auto' },
      { name: 'daily_sales_2026', reader: 'read_parquet' },
      { name: 'events', reader: 'read_json_auto' },
      { name: 'orders', reader: 'read_csv_auto' },
    ]);
    expect(isDataFile('orders.CSV')).toBe(true);
    expect(isDataFile('.orders.csv')).toBe(false);
    // The project's own settings, when the data folder is the project folder.
    for (const settings of ['dql.config.json', 'package.json', 'package-lock.json', 'tsconfig.build.json', 'vite.config.json']) expect(isDataFile(settings)).toBe(false);
    expect(isDataFile('config.json')).toBe(true);
    expect(dataFolderTables(join(folder, 'missing'))).toEqual([]);
  });

  it('leaves out names DuckDB reads as a pattern, and settings in a project folder', () => {
    expect(isDataFile('sales[1].csv')).toBe(false);
    expect(isDataFile('sales*.csv')).toBe(false);
    expect(isDataFile('dql-manifest.json')).toBe(false);
    const project = dataFolder({ 'dql.config.json': '{}', 'renovate.json': '{}', 'events.jsonl': '{}\n', 'orders.csv': 'id\n1\n' });
    expect(dataFolderTables(project).map((table) => table.name)).toEqual(['events', 'orders']);
    const data = dataFolder({ 'config.json': '[]', 'orders.csv': 'id\n1\n' });
    expect(dataFolderTables(data).map((table) => table.name)).toEqual(['config', 'orders']);
  });

  it('keeps a connection per folder: two data folders never share one', () => {
    expect(createConnectionConfigKey({ driver: 'file', filepath: ':memory:', dataFolder: '/a' }))
      .not.toBe(createConnectionConfigKey({ driver: 'file', filepath: ':memory:', dataFolder: '/b' }));
  });

  it('gives a second file with the same name its format as a suffix', () => {
    const folder = dataFolder({ 'orders.csv': 'id\n1\n', 'orders.parquet': '' });
    expect(dataFolderTables(folder).map((table) => table.name)).toEqual(['orders', 'orders_parquet']);
  });

  it('reads each file where it is, quoting its path and name', () => {
    const statements = dataFolderViewStatements([{ name: 'o"rders', file: "/data/it's/orders.csv", reader: 'read_csv_auto' }]);
    expect(statements).toEqual([`CREATE OR REPLACE VIEW "o""rders" AS SELECT * FROM read_csv_auto('/data/it''s/orders.csv')`]);
  });

  duckDbIt('answers SQL over the folder through a file connection, and lists the files as tables', async () => {
    const folder = dataFolder({
      'orders.csv': 'order_id,customer_id,amount\n1,10,25.5\n2,11,10\n3,10,4.5\n',
      'customers.csv': 'customer_id,name\n10,Ada\n11,Grace\n',
    });
    const connector = new FileConnector();
    await connector.connect({ driver: 'file', dataFolder: folder, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      const result = await connector.execute('SELECT c.name, SUM(o.amount) AS total FROM orders o JOIN customers c USING (customer_id) GROUP BY c.name ORDER BY c.name');
      expect(result.rows).toEqual([{ name: 'Ada', total: 30 }, { name: 'Grace', total: 10 }]);
      const tables = await connector.listTables();
      expect(tables.map((table) => table.name).sort()).toEqual(['customers', 'orders']);
    } finally {
      await connector.disconnect();
    }
  });

  duckDbIt('reads a file that changed since the connection opened', async () => {
    const folder = dataFolder({ 'orders.csv': 'id\n1\n' });
    const connector = new FileConnector();
    await connector.connect({ driver: 'file', dataFolder: folder, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      writeFileSync(join(folder, 'orders.csv'), 'id\n1\n2\n');
      expect((await connector.execute('SELECT COUNT(*) AS n FROM orders')).rows).toEqual([{ n: 2 }]);
    } finally {
      await connector.disconnect();
    }
  });

  duckDbIt('a file DuckDB cannot read gets no table; the others work, and it is tried again once it changes', async () => {
    const folder = dataFolder({ 'orders.csv': 'id\n1\n2\n', 'broken.parquet': 'not parquet' });
    const connector = new FileConnector();
    await connector.connect({ driver: 'file', dataFolder: folder, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      expect((await connector.execute('SELECT COUNT(*) AS n FROM orders')).rows).toEqual([{ n: 2 }]);
      expect((await connector.listTables()).map((table) => table.name)).toEqual(['orders']);
      // Replaced by a real file: now it is a table.
      rmSync(join(folder, 'broken.parquet'));
      await connector.execute(`COPY (SELECT 7 AS v) TO '${join(folder, 'broken.parquet')}' (FORMAT parquet)`);
      utimesSync(join(folder, 'broken.parquet'), new Date(), new Date(Date.now() + 5000));
      expect((await connector.execute('SELECT v FROM broken')).rows).toEqual([{ v: 7 }]);
    } finally {
      await connector.disconnect();
    }
  });

  duckDbIt('follows the folder: a file added while connected becomes a table, a removed one stops being one', async () => {
    const folder = dataFolder({ 'orders.csv': 'id\n1\n' });
    const connector = new FileConnector();
    await connector.connect({ driver: 'file', dataFolder: folder, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      writeFileSync(join(folder, 'customers.csv'), 'id,name\n1,Ada\n');
      expect((await connector.execute('SELECT name FROM customers')).rows).toEqual([{ name: 'Ada' }]);
      rmSync(join(folder, 'orders.csv'));
      expect((await connector.listTables()).map((table) => table.name)).toEqual(['customers']);
    } finally {
      await connector.disconnect();
    }
  });

  duckDbIt('with a real DuckDB file, the views are temporary and never written into it', async () => {
    const folder = dataFolder({ 'orders.csv': 'id\n1\n' });
    const database = join(folder, 'own.duckdb');
    const connector = new FileConnector();
    await connector.connect({ driver: 'file', filepath: database, dataFolder: folder, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    expect((await connector.execute('SELECT COUNT(*) AS n FROM orders')).rows).toEqual([{ n: 1 }]);
    await connector.disconnect();
    const plain = new DuckDBConnector();
    await plain.connect({ driver: 'duckdb', filepath: database, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      expect((await plain.execute("SELECT COUNT(*) AS n FROM duckdb_views() WHERE NOT internal AND view_name = 'orders'")).rows).toEqual([{ n: 0 }]);
    } finally {
      await plain.disconnect();
    }
  });
});
