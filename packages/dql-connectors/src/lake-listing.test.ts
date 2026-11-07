import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listBucketPrefix, readBucketFolder, resolveLakeSources, type LakeRun } from './lake-listing.js';
import { dataFolderViewStatement, readDataFolder } from './data-folder.js';
import type { QueryResult } from './result-types.js';

/** A workbook (a stored zip) whose `xl/workbook.xml` lists `sheets`. */
function workbook(sheets: string[]): Buffer {
  const xml = Buffer.from(`<workbook><sheets>${sheets.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}"/>`).join('')}</sheets></workbook>`);
  const name = Buffer.from('xl/workbook.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(xml.length, 18);
  local.writeUInt32LE(xml.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(xml.length, 20);
  central.writeUInt32LE(xml.length, 24);
  central.writeUInt16LE(name.length, 28);
  const directory = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(30 + name.length + xml.length, 16);
  return Buffer.concat([local, name, xml, directory, end]);
}

const result = (rows: Record<string, unknown>[]): QueryResult => ({ columns: [], rows, rowCount: rows.length, executionTimeMs: 1 });
const escape = (text: string) => text.replace(/[.+^${}()|[\]\\?]/g, '\\$&');

/** A bucket as DuckDB answers ZLens's listing statements: `glob`, `read_text`, `read_blob`. */
function bucket(objects: Record<string, string | Buffer>): { run: LakeRun; statements: string[] } {
  const statements: string[] = [];
  const run: LakeRun = async (sql) => {
    statements.push(sql);
    const glob = /^SELECT file FROM glob\('(.+)'\)$/.exec(sql);
    if (glob) {
      const pattern = new RegExp(`^${glob[1].split('**').map((part) => part.split('*').map(escape).join('[^/]*')).join('.*')}$`);
      return result(Object.keys(objects).filter((key) => pattern.test(key)).sort().map((file) => ({ file })));
    }
    const text = /read_text\('(.+)'\)/.exec(sql);
    if (text) return result([{ content: String(objects[text[1]] ?? '') }]);
    const blob = /read_blob\('(.+)'\)/.exec(sql);
    if (blob) {
      const content = objects[blob[1]];
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '');
      return result([{ size: bytes.length, data: bytes.toString('base64') }]);
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { run, statements };
}

const LAKE: Record<string, string | Buffer> = {
  's3://acme/sales/orders.csv': 'id\n1\n',
  's3://acme/sales/targets.xlsx': workbook(['Plan', 'Actuals']),
  's3://acme/sales/customers/_delta_log/00000000000000000000.json': '{}',
  's3://acme/sales/customers/part-0.parquet': '',
  's3://acme/sales/orders_ice/metadata/00001-a.metadata.json': '{}',
  's3://acme/sales/orders_ice/metadata/00002-b.metadata.json': '{}',
  's3://acme/sales/orders_ice/metadata/version-hint.text': '1',
  's3://acme/sales/orders_ice/data/0.parquet': '',
  's3://acme/sales/events/year=2025/month=1/a.parquet': '',
  's3://acme/sales/events/year=2025/month=2/b.parquet': '',
  's3://acme/sales/lake.ducklake': '',
  's3://acme/sales/clicks.avro': '',
};

describe('a bucket folder read like a folder on disk', () => {
  it('finds the same kinds of tables from one listing: files, sheets, Delta, Iceberg at its version hint, partitioned folders, catalogs', async () => {
    const { run, statements } = bucket(LAKE);
    const contents = await readBucketFolder(run, 's3://acme/sales/');
    expect(contents.tables.map(({ name, source, kind }) => `${name} ${source} ${kind}`)).toEqual([
      'customers customers/ Delta Lake table',
      'events events/ 2 Parquet files, partitioned by year, month',
      'orders_ice orders_ice/ Iceberg table (version 1)',
      'orders orders.csv CSV file',
      'targets_plan targets.xlsx Excel sheet "Plan"',
      'targets_actuals targets.xlsx Excel sheet "Actuals"',
    ]);
    expect(contents.catalogs.map(({ name, file }) => `${name} ${file}`)).toEqual(['lake s3://acme/sales/lake.ducklake']);
    expect(contents.skipped).toEqual([{ name: 'clicks.avro', kind: 'an Avro file (not read yet)' }]);
    const byName = Object.fromEntries(contents.tables.map((table) => [table.name, table]));
    expect(dataFolderViewStatement(byName.events)).toBe("CREATE OR REPLACE VIEW \"events\" AS SELECT * FROM read_parquet('s3://acme/sales/events/**/*.parquet', union_by_name = true, hive_partitioning = true)");
    // A folder of many files seen to share their columns is read with the first file's (L4-9): one footer per statement.
    expect(dataFolderViewStatement({ ...byName.events, folder: { partitioned: true, sameColumns: true } })).toBe("CREATE OR REPLACE VIEW \"events\" AS SELECT * FROM read_parquet('s3://acme/sales/events/**/*.parquet', hive_partitioning = true)");
    expect(dataFolderViewStatement(byName.orders_ice)).toBe("CREATE OR REPLACE VIEW \"orders_ice\" AS SELECT * FROM iceberg_scan('s3://acme/sales/orders_ice', allow_moved_paths = true, version = '00001-a')");
    // One listing of the folder, then only the version hint and the workbook are read.
    expect(statements.filter((sql) => sql.includes('glob('))).toEqual(["SELECT file FROM glob('s3://acme/sales/**')"]);
  });

  it('says to name the tables when listing a large folder takes too long', async () => {
    const run: LakeRun = async () => {
      throw new Error('DuckDB query exceeded the 30000ms deadline.');
    };
    await expect(listBucketPrefix(run, 's3://huge/lake/')).rejects.toThrow('listing s3://huge/lake/ took longer than 30 s: name its tables in "sources" instead of reading the whole folder');
  });
});

describe('a connection\'s sources', () => {
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it('reads each source as one named table: said formats, found ones, and the cheapest listing for a bucket folder', async () => {
    const local = mkdtempSync(join(tmpdir(), 'zlens-sources-'));
    folders.push(local);
    mkdirSync(join(local, 'daily'));
    writeFileSync(join(local, 'daily', 'a.csv'), 'a\n1\n');
    writeFileSync(join(local, 'plan.xlsx'), workbook(['Q1']));
    const { run, statements } = bucket(LAKE);
    const { tables, problems } = await resolveLakeSources(run, [
      { path: 's3://acme/sales/customers/' },
      { name: 'orders', path: 's3://acme/sales/orders_ice', format: 'iceberg' },
      { name: 'events', path: 's3://acme/sales/events/**/*.parquet' },
      { name: 'daily', path: join(local, 'daily'), format: 'csv' },
      { path: join(local, 'plan.xlsx') },
      { name: 'targets', path: 's3://acme/sales/targets.xlsx', sheet: 'Actuals' },
      { path: 's3://acme/sales/customers' },
    ]);
    expect(tables.map(({ name, kind }) => `${name}: ${kind}`)).toEqual([
      'customers: Delta Lake table',
      'orders: Iceberg table (version 1)',
      'events: Parquet files',
      'daily: CSV files',
      'plan: Excel sheet "Q1"',
      'targets: Excel sheet "Actuals"',
      'customers_2: Delta Lake table',
    ]);
    expect(problems).toEqual([]);
    expect(dataFolderViewStatement(tables[3])).toBe(`CREATE OR REPLACE VIEW "daily" AS SELECT * FROM read_csv_auto('${join(local, 'daily')}/**/*.csv', union_by_name = true)`);
    // A bucket folder that is a Delta table is known from its log alone; nothing else under it is listed.
    expect(statements).toContain("SELECT file FROM glob('s3://acme/sales/customers/_delta_log/*.json')");
    expect(statements).not.toContain("SELECT file FROM glob('s3://acme/sales/customers/**')");
  });

  it('says why a source is not read; the others still are', async () => {
    const { run } = bucket(LAKE);
    const { tables, problems } = await resolveLakeSources(run, [
      { path: join(tmpdir(), 'zlens-no-such-source', 'orders.csv') },
      { name: 'notes', path: 's3://acme/sales/notes.txt' },
      { name: 'ice', path: 's3://acme/sales/events', format: 'iceberg' },
      { name: 'empty', path: 's3://acme/nothing/' },
      { path: 's3://acme/sales/orders.csv' },
    ]);
    // A source keeps its name whether it reads or not: names never shift when one starts to work.
    expect(tables.map((table) => table.name)).toEqual(['orders_2']);
    expect(problems.map(({ name, reason }) => `${name}: ${reason}`)).toEqual([
      `orders: ${join(tmpdir(), 'zlens-no-such-source', 'orders.csv')} does not exist`,
      'notes: ZLens cannot tell what s3://acme/sales/notes.txt holds: say its "format" (parquet, csv, json, excel, delta or iceberg)',
      'ice: no Iceberg metadata in s3://acme/sales/events/metadata/',
      'empty: s3://acme/nothing/ holds no data ZLens reads',
    ]);
  });

  it('a bucket URL is never read as a folder on disk', () => {
    expect(readDataFolder('s3://acme/sales/')).toEqual({ tables: [], catalogs: [], skipped: [] });
  });
});
