import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectionConfigKey } from '../connection-pool.js';
import {
  dataFolderSkipped,
  dataFolderTables,
  dataFolderViewStatement,
  dataFolderViewStatements,
  excelSheets,
  isDataFile,
  newestIcebergMetadata,
  readDataFolder,
} from '../data-folder.js';
import { DuckDBConnector } from './duckdb.js';
import { readEnv } from '../env.js';
import { FileConnector } from './file.js';

const configuredDuckDbConnectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = configuredDuckDbConnectorRoot ? it : it.skip;
/** A small Delta Lake table (two commits and a delete: 9 rows) and Iceberg table (two appends and a delete: 8 rows), written elsewhere. */
const LAKE_FIXTURES = fileURLToPath(new URL('../../test/fixtures/lake', import.meta.url));

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

/** A zip archive of stored (uncompressed) files: enough for an `.xlsx` whose sheets are listed. */
function storedZip(files: Record<string, string>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function workbook(sheets: string): Buffer {
  return storedZip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>${sheets}</sheets></workbook>`,
  });
}

describe('what a data folder holds', () => {
  it('reads files, Excel sheets, Delta and Iceberg tables and folders of files as tables, and database files as catalogs', () => {
    const folder = dataFolder({
      'orders.parquet': '',
      'customers_delta/_delta_log/00000000000000000000.json': '{}',
      'orders_iceberg/metadata/00001-a.metadata.json': '{}',
      'orders_iceberg/metadata/00003-c.metadata.json': '{}',
      'orders_iceberg/metadata/00002-b.metadata.json': '{}',
      'orders_iceberg/data/0.parquet': '',
      'events/year=2024/month=1/a.parquet': '',
      'events/year=2024/month=2/b.parquet': '',
      'events/year=2025/month=1/c.parquet': '',
      'events/_SUCCESS': '',
      'daily/2024-01-01.csv': 'a\n1\n',
      'daily/2024-01-02.csv': 'a\n1\n',
      'daily/schema.json': '{}',
      'lake.ducklake': '',
      'lake.ducklake.files/main/orders/x.parquet': '',
      'shop.duckdb': '',
      'settings/app.json': '{}',
      'docs/readme.md': '# not data',
      '.cache/x.parquet': '',
      'node_modules/pkg/data.csv': 'a\n1\n',
    });
    writeFileSync(join(folder, 'targets.xlsx'), workbook('<sheet name="Targets" sheetId="1" r:id="rId1"/>'));
    const contents = readDataFolder(folder);
    expect(contents.tables.map(({ name, source, kind }) => ({ name, source, kind }))).toEqual([
      { name: 'customers_delta', source: 'customers_delta/', kind: 'Delta Lake table' },
      { name: 'daily', source: 'daily/', kind: '2 CSV files' },
      { name: 'events', source: 'events/', kind: '3 Parquet files, partitioned by year, month' },
      { name: 'orders_iceberg', source: 'orders_iceberg/', kind: 'Iceberg table (version 3)' },
      { name: 'orders', source: 'orders.parquet', kind: 'Parquet file' },
      { name: 'targets', source: 'targets.xlsx', kind: 'Excel sheet "Targets"' },
    ]);
    expect(contents.catalogs).toEqual([
      { name: 'lake', file: join(folder, 'lake.ducklake'), type: 'ducklake', source: 'lake.ducklake', kind: 'DuckLake catalog, attached as lake' },
      { name: 'shop', file: join(folder, 'shop.duckdb'), type: 'duckdb', source: 'shop.duckdb', kind: 'DuckDB database, attached as shop' },
    ]);
    expect(contents.skipped).toEqual([]);
    const byName = Object.fromEntries(contents.tables.map((table) => [table.name, table]));
    expect(dataFolderViewStatement(byName.events)).toBe(`CREATE OR REPLACE VIEW "events" AS SELECT * FROM read_parquet('${folder}/events/**/*.parquet', union_by_name = true, hive_partitioning = true)`);
    expect(dataFolderViewStatement(byName.daily)).toBe(`CREATE OR REPLACE VIEW "daily" AS SELECT * FROM read_csv_auto('${folder}/daily/**/*.csv', union_by_name = true)`);
    expect(dataFolderViewStatement(byName.customers_delta)).toBe(`CREATE OR REPLACE VIEW "customers_delta" AS SELECT * FROM delta_scan('${join(folder, 'customers_delta')}')`);
    // An Iceberg table is read from its own folder at its newest version, wherever it was written.
    expect(dataFolderViewStatement(byName.orders_iceberg)).toBe(`CREATE OR REPLACE VIEW "orders_iceberg" AS SELECT * FROM iceberg_scan('${join(folder, 'orders_iceberg')}', allow_moved_paths = true, version = '00003-c')`);
    expect(dataFolderViewStatement(byName.targets)).toBe(`CREATE OR REPLACE VIEW "targets" AS SELECT * FROM read_xlsx('${join(folder, 'targets.xlsx')}', sheet = 'Targets')`);
  });

  it('says what it skips and why: other formats, mixed folders, folders of tables, pattern names', () => {
    const folder = dataFolder({
      'clicks.avro': '',
      'old.xls': '',
      'mixed/a.csv': 'a\n1\n',
      'mixed/b.parquet': '',
      'tables/orders/_delta_log/0.json': '{}',
      'tables/customers/metadata/v1.metadata.json': '{}',
      'workbooks2/a.xlsx': '',
      'sales[1].csv': 'a\n1\n',
      'parts[1]/a.csv': 'a\n1\n',
      'broken.xlsx': 'not a zip',
    });
    expect(dataFolderSkipped(folder)).toEqual([
      { name: 'broken.xlsx', kind: 'an Excel workbook ZLens could not open' },
      { name: 'clicks.avro', kind: 'an Avro file (not read yet)' },
      { name: 'mixed/', kind: 'a folder of 2 files in CSV and Parquet (ZLens reads a folder of one format as one table)' },
      { name: 'old.xls', kind: 'an Excel 97-2003 workbook (save it as .xlsx to read it)' },
      { name: 'parts[1]/', kind: '1 CSV file, in a folder whose name DuckDB would read as a pattern (it holds * ? [ ] { or })' },
      { name: 'sales[1].csv', kind: 'a data file whose name DuckDB would read as a pattern (it holds * ? [ ] { or })' },
      { name: 'tables/', kind: 'a folder of 2 Delta Lake or Iceberg tables (ZLens reads a table at the top of the data folder)' },
      { name: 'workbooks2/', kind: 'a folder of 1 Excel file (ZLens reads a folder of CSV, TSV, Parquet or JSON files)' },
    ]);
    expect(dataFolderTables(folder)).toEqual([]);
  });

  it('names each visible sheet of a workbook, and the connection\'s own database file is never a catalog', () => {
    const folder = dataFolder({ 'own.duckdb': '', 'notes.sqlite': '' });
    writeFileSync(join(folder, 'plan.xlsx'), workbook(
      '<sheet name="Q1 &amp; Q2" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/><x:sheet name="Q3" sheetId="3" r:id="rId3"/>',
    ));
    expect(excelSheets(join(folder, 'plan.xlsx'))).toEqual(['Q1 & Q2', 'Q3']);
    const contents = readDataFolder(folder, { exclude: [join(folder, 'own.duckdb')] });
    expect(contents.tables.map(({ name, sheet }) => ({ name, sheet }))).toEqual([
      { name: 'plan_q1_q2', sheet: 'Q1 & Q2' },
      { name: 'plan_q3', sheet: 'Q3' },
    ]);
    expect(contents.catalogs.map(({ name, type }) => ({ name, type }))).toEqual([{ name: 'notes', type: 'sqlite' }]);
    // Without catalogs (the project's data folder of a duckdb connection), a database file is skipped.
    expect(readDataFolder(folder, { catalogs: false, exclude: [join(folder, 'own.duckdb')] }).skipped).toEqual([
      { name: 'notes.sqlite', kind: 'a SQLite database (only a file connection\'s data folder attaches one)' },
    ]);
  });

  it('picks an Iceberg table\'s newest metadata: the version hint, else the highest version', () => {
    const folder = dataFolder({
      'metadata/v1.metadata.json': '{}',
      'metadata/v2.metadata.json': '{}',
      'metadata/v10.metadata.json': '{}',
    });
    expect(newestIcebergMetadata(join(folder, 'metadata'))).toMatchObject({ name: 'v10', version: 10, gzip: false });
    writeFileSync(join(folder, 'metadata', 'version-hint.text'), '2\n');
    expect(newestIcebergMetadata(join(folder, 'metadata'))).toMatchObject({ name: 'v2', version: 2 });
    const compressed = dataFolder({ 'metadata/00004-x.gz.metadata.json': '' });
    expect(newestIcebergMetadata(join(compressed, 'metadata'))).toMatchObject({ name: '00004-x', version: 4, gzip: true });
    expect(newestIcebergMetadata(join(folder, 'no-metadata'))).toBeUndefined();
  });

  it('has nothing to say about a missing folder or one of plain files', () => {
    expect(dataFolderSkipped(join(tmpdir(), 'zlens-no-such-folder-xyz'))).toEqual([]);
    expect(dataFolderSkipped(dataFolder({ 'orders.csv': 'a\n1\n', 'customers.parquet': '' }))).toEqual([]);
  });
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
      { name: 'archive', reader: 'read_csv_auto' },
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

describe('a lake folder read through a connection', () => {
  const sqlPath = (path: string) => path.replace(/'/g, "''");

  duckDbIt('reads every kind of table a lake folder holds by name, and attaches its database files read-only', async () => {
    const folder = dataFolder({
      'daily/2024-01-01.csv': 'day,amount\n2024-01-01,5\n',
      'daily/2024-01-02.csv': 'day,amount\n2024-01-02,7\n',
      'drift/a.csv': 'id\n1\n',
      'drift/b.csv': 'id,name\n2,x\n',
    });
    cpSync(join(LAKE_FIXTURES, 'customers_delta'), join(folder, 'customers_delta'), { recursive: true });
    cpSync(join(LAKE_FIXTURES, 'orders_iceberg'), join(folder, 'orders_iceberg'), { recursive: true });
    // Written by DuckDB itself: a partitioned folder, an Excel sheet, a DuckDB file and a DuckLake catalog.
    const writer = new DuckDBConnector();
    await writer.connect({ driver: 'duckdb', moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      // Writing Excel needs its extension loaded (reading loads it by itself).
      await writer.execute('INSTALL excel');
      await writer.execute('LOAD excel');
      await writer.execute(`COPY (SELECT i AS id, 2024 + i % 2 AS year FROM range(6) t(i)) TO '${sqlPath(join(folder, 'events'))}' (FORMAT parquet, PARTITION_BY (year))`);
      await writer.execute(`COPY (SELECT 'north' AS region, 100 AS target UNION ALL SELECT 'south', 80) TO '${sqlPath(join(folder, 'targets.xlsx'))}' (FORMAT xlsx, HEADER true, SHEET 'Targets')`);
      await writer.execute(`ATTACH '${sqlPath(join(folder, 'shop.duckdb'))}' AS shop`);
      await writer.execute('CREATE TABLE shop.main.stores AS SELECT 1 AS store_id');
      await writer.execute('DETACH shop');
      await writer.execute(`ATTACH 'ducklake:${sqlPath(join(folder, 'lake.ducklake'))}' AS lake (DATA_PATH '${sqlPath(join(folder, 'lake.ducklake.files'))}/')`);
      await writer.execute('CREATE TABLE lake.main.returns AS SELECT 1 AS return_id UNION ALL SELECT 2');
      await writer.execute('DETACH lake');
    } finally {
      await writer.disconnect();
    }

    const connector = new FileConnector();
    await connector.connect({ driver: 'file', dataFolder: folder, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      const first = async (sql: string) => (await connector.execute(sql)).rows[0];
      expect(await first('SELECT COUNT(*) AS n FROM orders_iceberg')).toEqual({ n: 8 });
      expect(await first('SELECT COUNT(*) AS n FROM customers_delta')).toEqual({ n: 9 });
      expect(await first('SELECT COUNT(*) AS n, COUNT(DISTINCT year) AS years FROM events')).toEqual({ n: 6, years: 2 });
      expect(await first('SELECT CAST(SUM(amount) AS INTEGER) AS total FROM daily')).toEqual({ total: 12 });
      expect(await first('SELECT CAST(SUM(target) AS INTEGER) AS total FROM targets')).toEqual({ total: 180 });
      expect(await first('SELECT COUNT(*) AS n FROM shop.main.stores')).toEqual({ n: 1 });
      expect(await first('SELECT COUNT(*) AS n FROM lake.main.returns')).toEqual({ n: 2 });
      const status = await connector.dataFolderStatus();
      expect(status?.tables.map(({ name, kind }) => `${name}: ${kind}`)).toEqual([
        'customers_delta: Delta Lake table',
        'daily: 2 CSV files',
        'events: 2 Parquet files, partitioned by year',
        'orders_iceberg: Iceberg table (version 3)',
        'targets: Excel sheet "Targets"',
      ]);
      expect(status?.catalogs.map(({ name, source }) => `${name}: ${source}`)).toEqual(['lake: lake.ducklake', 'shop: shop.duckdb']);
      expect(status?.problems).toEqual([{
        source: 'drift/',
        name: 'drift',
        reason: 'its files have different columns: a.csv has id, b.csv has id, name (ZLens reads a folder as one table when its files share their columns)',
      }]);
      // Each table once, an attached database's under its own name.
      const listed = (await connector.listTables()).map((table) => [table.catalog, table.schema, table.name].filter(Boolean).join('.'));
      expect(listed).toEqual(expect.arrayContaining(['main.orders_iceberg', 'main.targets', 'lake.main.returns', 'shop.main.stores']));
      expect(new Set(listed).size).toBe(listed.length);
      // Attached read-only: a statement cannot write into a database file of the folder.
      await expect(connector.execute('INSERT INTO shop.main.stores VALUES (2)')).rejects.toThrow(/read.only/i);
    } finally {
      await connector.disconnect();
    }
  }, 60_000);

  duckDbIt('a connection\'s own catalogs are attached read-only under their names, beside its database', async () => {
    const folder = dataFolder({});
    const raw = join(folder, 'raw.duckdb');
    const writer = new DuckDBConnector();
    await writer.connect({ driver: 'duckdb', filepath: raw, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    await writer.execute('CREATE TABLE stores AS SELECT 1 AS store_id UNION ALL SELECT 2');
    await writer.disconnect();
    const connector = new DuckDBConnector();
    await connector.connect({ driver: 'duckdb', filepath: join(folder, 'dev.duckdb'), catalogs: [{ name: 'raw', path: raw }, { name: 'gone', path: join(folder, 'missing.duckdb') }], moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      expect((await connector.execute('SELECT COUNT(*) AS n FROM raw.main.stores')).rows).toEqual([{ n: 2 }]);
      await expect(connector.execute('INSERT INTO raw.main.stores VALUES (3)')).rejects.toThrow(/read.only/i);
      const status = await connector.dataFolderStatus();
      expect(status?.catalogs.map(({ name, kind }) => `${name}: ${kind}`)).toEqual(['raw: DuckDB database, attached as raw']);
      expect(status?.problems.map(({ name }) => name)).toEqual(['gone']);
    } finally {
      await connector.disconnect();
    }
  });

  duckDbIt('follows an Iceberg table to its newest commit', async () => {
    const folder = dataFolder({});
    cpSync(join(LAKE_FIXTURES, 'orders_iceberg'), join(folder, 'orders_iceberg'), { recursive: true });
    const metadata = join(folder, 'orders_iceberg', 'metadata');
    const newest = newestIcebergMetadata(metadata)!;
    const held = join(folder, 'held.json');
    cpSync(newest.file, held);
    rmSync(newest.file);
    const connector = new FileConnector();
    await connector.connect({ driver: 'file', dataFolder: folder, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      // Before the delete: two appends.
      expect((await connector.execute('SELECT COUNT(*) AS n FROM orders_iceberg')).rows).toEqual([{ n: 10 }]);
      cpSync(held, newest.file);
      rmSync(held);
      utimesSync(folder, new Date(), new Date(Date.now() + 5000));
      expect((await connector.execute('SELECT COUNT(*) AS n FROM orders_iceberg')).rows).toEqual([{ n: 8 }]);
    } finally {
      await connector.disconnect();
    }
  }, 60_000);

  duckDbIt('a duckdb connection reading the project\'s data folder writes nothing into its database, keeps its own tables, and its read scopes see the views', async () => {
    const folder = dataFolder({ 'data/orders.csv': 'id\n1\n2\n3\n', 'data/customers.csv': 'id,name\n1,Ada\n' });
    const database = join(folder, 'warehouse.duckdb');
    const setup = new DuckDBConnector();
    await setup.connect({ driver: 'duckdb', filepath: database, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    await setup.execute('CREATE TABLE orders AS SELECT 42 AS id');
    await setup.disconnect();

    const connector = new DuckDBConnector();
    await connector.connect({ driver: 'duckdb', filepath: database, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      await connector.useDataFolder(join(folder, 'data'), { catalogs: false });
      // The database's own table is the one read; the file of the same name is not made over it.
      expect((await connector.execute('SELECT id FROM orders')).rows).toEqual([{ id: 42 }]);
      expect((await connector.execute('SELECT name FROM customers')).rows).toEqual([{ name: 'Ada' }]);
      expect((await connector.dataFolderStatus())?.problems).toEqual([
        { source: 'orders.csv', name: 'orders', reason: 'the database already has a table or view named orders, and that one is read' },
      ]);
      const scope = await connector.openConsistentReadScope();
      try {
        expect((await scope.execute('SELECT name FROM customers')).rows).toEqual([{ name: 'Ada' }]);
      } finally {
        await scope.close();
      }
    } finally {
      await connector.disconnect();
    }
    const plain = new DuckDBConnector();
    await plain.connect({ driver: 'duckdb', filepath: database, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      expect((await plain.execute('SELECT COUNT(*) AS n FROM duckdb_views() WHERE NOT internal')).rows).toEqual([{ n: 0 }]);
    } finally {
      await plain.disconnect();
    }
  });
  duckDbIt('sources in a catalog of ZLens\'s own (a dbt project\'s external sources) are read by their full name, from every connection, and written nowhere', async () => {
    const folder = dataFolder({ 'raw/orders.csv': 'order_id,amount\n1,5\n2,7\n' });
    cpSync(join(LAKE_FIXTURES, 'customers_delta'), join(folder, 'raw', 'customers_delta'), { recursive: true });
    const database = join(folder, 'shop.duckdb');
    const setup = new DuckDBConnector();
    await setup.connect({ driver: 'duckdb', filepath: database, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    // The dbt project's own model reads the same name as a table of its own: no clash.
    await setup.execute('CREATE TABLE orders AS SELECT 42 AS order_id');
    await setup.disconnect();

    const connector = new DuckDBConnector();
    await connector.connect({
      driver: 'duckdb',
      filepath: database,
      sources: [
        { name: 'orders', path: join(folder, 'raw', 'orders.csv'), catalog: 'dbt_sources', schema: 'shop' },
        { name: 'customers', path: join(folder, 'raw', 'customers_delta'), format: 'delta', catalog: 'dbt_sources', schema: 'shop' },
        { name: 'orders', path: join(folder, 'raw', 'orders.csv'), catalog: 'dbt_sources', schema: 'archive' },
      ],
      moduleSearchPaths: [configuredDuckDbConnectorRoot!],
    });
    try {
      expect((await connector.execute('SELECT CAST(SUM(amount) AS INTEGER) AS total FROM dbt_sources.shop.orders')).rows).toEqual([{ total: 12 }]);
      expect((await connector.execute('SELECT COUNT(*) AS n FROM dbt_sources.shop.customers')).rows).toEqual([{ n: 9 }]);
      expect((await connector.execute('SELECT COUNT(*) AS n FROM dbt_sources.archive.orders')).rows).toEqual([{ n: 2 }]);
      expect((await connector.execute('SELECT order_id FROM orders')).rows).toEqual([{ order_id: 42 }]);
      const status = await connector.dataFolderStatus();
      expect(status?.tables.map(({ name, kind }) => `${name}: ${kind}`)).toEqual([
        'dbt_sources.shop.orders: CSV file',
        'dbt_sources.shop.customers: Delta Lake table',
        'dbt_sources.archive.orders: CSV file',
      ]);
      expect(status?.problems).toEqual([]);
      const tables = await connector.listTables();
      expect(tables.filter((table) => table.catalog === 'dbt_sources').map((table) => `${table.schema}.${table.name}`).sort())
        .toEqual(['archive.orders', 'shop.customers', 'shop.orders']);
      const scope = await connector.openConsistentReadScope();
      try {
        expect((await scope.execute('SELECT COUNT(*) AS n FROM dbt_sources.shop.orders')).rows).toEqual([{ n: 2 }]);
      } finally {
        await scope.close();
      }
    } finally {
      await connector.disconnect();
    }
    const plain = new DuckDBConnector();
    await plain.connect({ driver: 'duckdb', filepath: database, moduleSearchPaths: [configuredDuckDbConnectorRoot!] });
    try {
      expect((await plain.execute('SELECT COUNT(*) AS n FROM duckdb_views() WHERE NOT internal')).rows).toEqual([{ n: 0 }]);
    } finally {
      await plain.disconnect();
    }
  });
});
