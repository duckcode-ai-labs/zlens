import { describe, expect, it } from 'vitest';
import type { WarehouseCatalogRelationV1 } from '@zlens/core';
import {
  ALL_FOOTERS_UP_TO,
  SIZE_FOOTER_SAMPLE,
  addLakeSizes,
  fileViewSize,
  formatBytes,
  formatRows,
  isRemotePath,
  lakeReaderCall,
  lakeRelationSize,
  spreadOrder,
} from './lake-sizes.js';

/** A view's SQL as `duckdb_views()` prints it back: options as `(name = CAST('t' AS BOOLEAN))`. */
const PRINTED = "CREATE TEMP VIEW orders AS SELECT * FROM read_parquet('s3://lake/orders/**/*.parquet', (union_by_name = CAST('t' AS BOOLEAN)), (hive_partitioning = CAST('t' AS BOOLEAN)));";

describe('lake reader calls', () => {
  it('reads a data view back from the SQL DuckDB prints, options kept as written', () => {
    expect(lakeReaderCall(PRINTED)).toEqual({
      reader: 'read_parquet',
      pathSql: "'s3://lake/orders/**/*.parquet'",
      optionsSql: ", (union_by_name = CAST('t' AS BOOLEAN)), (hive_partitioning = CAST('t' AS BOOLEAN))",
      columnar: true,
      files: true,
      remote: true,
    });
    expect(lakeReaderCall("CREATE VIEW c AS SELECT * FROM read_csv_auto('/data/it''s.csv')")).toMatchObject({ reader: 'read_csv_auto', pathSql: "'/data/it''s.csv'", optionsSql: '', columnar: false, files: true, remote: false });
    expect(lakeReaderCall("CREATE VIEW c AS SELECT * FROM read_parquet(['a.parquet', 'b,c.parquet'])")).toMatchObject({ pathSql: "['a.parquet', 'b,c.parquet']", optionsSql: '' });
    expect(lakeReaderCall("CREATE VIEW i AS SELECT * FROM iceberg_scan('s3://lake/i', (allow_moved_paths = CAST('t' AS BOOLEAN)))")).toMatchObject({ reader: 'iceberg_scan', files: false });
  });

  it('a view that does more than read files is not a lake table', () => {
    expect(lakeReaderCall('CREATE VIEW v AS SELECT a FROM read_parquet(\'x.parquet\')')).toBeUndefined();
    expect(lakeReaderCall('CREATE VIEW v AS SELECT * FROM orders JOIN customers USING (id)')).toBeUndefined();
    expect(lakeReaderCall("CREATE VIEW v AS SELECT * FROM my_macro('x')")).toBeUndefined();
    expect(lakeReaderCall(undefined)).toBeUndefined();
  });

  it('remote means over the network', () => {
    expect(isRemotePath('s3://b/k')).toBe(true);
    expect(isRemotePath('https://example.com/a.parquet')).toBe(true);
    expect(isRemotePath('/data/a.parquet')).toBe(false);
    expect(isRemotePath('file:///data/a.parquet')).toBe(false);
  });

  it('a spread order reaches across the whole range from its first picks, and every prefix is spread', () => {
    const order = spreadOrder(100);
    expect(new Set(order).size).toBe(100);
    expect(order.slice(0, 2)).toEqual([0, 50]);
    const four = order.slice(0, 4).sort((a, b) => a - b);
    expect(four).toEqual([0, 25, 50, 75]);
    expect(spreadOrder(1)).toEqual([0]);
    expect(spreadOrder(3).sort()).toEqual([0, 1, 2]);
  });

  it('words for sizes', () => {
    expect(formatBytes(1_509_800_000_000)).toBe('1.5 TB');
    expect(formatBytes(238_600_000_000)).toBe('239 GB');
    expect(formatBytes(48_350_000)).toBe('48 MB');
    expect(formatRows(3_672_488_245)).toBe('3.7 billion');
    expect(formatRows(14_011_991)).toBe('14 million');
    expect(formatRows(5000)).toBe('5,000');
  });
});

type Row = Record<string, unknown>;
/** A fake engine: answers the listing, footers and catalog statements, and records each statement. */
function engine(files: Array<{ file: string; size: number; rows: number; columns: Record<string, number> }>, extra: (sql: string) => Row[] | undefined = () => undefined) {
  const statements: string[] = [];
  const picked = (sql: string) => files.filter((file) => sql.includes(`'${file.file}'`));
  const run = async (sql: string): Promise<Row[]> => {
    statements.push(sql);
    const other = extra(sql);
    if (other) return other;
    if (sql.includes('FROM read_blob(')) return files.map(({ file, size }) => ({ file, size }));
    if (sql.includes('FROM parquet_file_metadata(')) return [{ row_count: picked(sql).reduce((sum, file) => sum + file.rows, 0) }];
    if (sql.includes('FROM parquet_metadata(')) {
      const totals = new Map<string, number>();
      for (const file of picked(sql)) for (const [name, bytes] of Object.entries(file.columns)) totals.set(name, (totals.get(name) ?? 0) + bytes);
      return [...totals].map(([column_name, bytes]) => ({ column_name, bytes }));
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  return { run, statements };
}

const callOf = (sql: string) => lakeReaderCall(sql)!;

describe('a view over files: its size from metadata', () => {
  it(`up to ${ALL_FOOTERS_UP_TO} files: every footer, so the rows are exact`, async () => {
    const files = Array.from({ length: 3 }, (_, index) => ({ file: `s3://lake/o/${index}.parquet`, size: 1000, rows: 10 + index, columns: { id: 100, amount: 400 } }));
    const { run } = engine(files);
    expect(await fileViewSize(callOf(PRINTED), run)).toEqual({ rows: 33, bytes: 3000, columns: { id: 300, amount: 1200 }, from: 'footers of all 3 files' });
  });

  it(`more files: the footers of ${SIZE_FOOTER_SAMPLE} spread across them, scaled to the whole by bytes, and said to be estimated`, async () => {
    const files = Array.from({ length: 200 }, (_, index) => ({ file: `s3://lake/o/${String(index).padStart(3, '0')}.parquet`, size: 1000, rows: 10, columns: { id: 100, amount: 400 } }));
    const { run, statements } = engine(files);
    const size = await fileViewSize(callOf(PRINTED), run);
    expect(size).toEqual({ rows: 2000, bytes: 200_000, columns: { id: 20_000, amount: 80_000 }, from: 'footers of 16 of 200 files (estimated)' });
    const footers = statements.find((sql) => sql.includes('parquet_file_metadata'))!;
    expect(footers.match(/s3:\/\/lake\/o\//g)).toHaveLength(SIZE_FOOTER_SAMPLE);
    // Spread: the first file and one past the middle are among them.
    expect(footers).toContain("'s3://lake/o/000.parquet'");
    expect(footers).toContain("'s3://lake/o/100.parquet'");
  });

  it('CSV and JSON: their bytes from the listing only (they are read whole)', async () => {
    const files = [{ file: '/d/a.csv', size: 500, rows: 0, columns: {} }];
    const { run, statements } = engine(files);
    expect(await fileViewSize(callOf("CREATE VIEW a AS SELECT * FROM read_csv_auto('/d/*.csv')"), run)).toEqual({ bytes: 500, from: 'listing of 1 file' });
    expect(statements.some((sql) => sql.includes('parquet'))).toBe(false);
  });
});

const relation = (overrides: Partial<WarehouseCatalogRelationV1>): WarehouseCatalogRelationV1 => ({
  id: 'warehouse.x', name: 'orders', relation: 'lake.sales.orders', kind: 'table', database: 'lake', schema: 'sales', columns: [{ name: 'id', type: 'BIGINT' }], ...overrides,
});

describe('catalog tables: their size from the catalog', () => {
  it('Iceberg: rows from the manifests, less position deletes', async () => {
    const { run, statements } = engine([], (sql) => (sql.includes('iceberg_metadata') ? [{ manifest_content: 'DATA', row_count: 200_000 }, { manifest_content: 'DELETE', row_count: 200 }] : undefined));
    expect(await lakeRelationSize(relation({}), run, new Map([['lake', 'iceberg']]))).toEqual({ rows: 199_800, from: 'Iceberg manifests (rows less deletes, estimated)' });
    expect(statements[0]).toBe(`SELECT manifest_content, sum(record_count) AS row_count FROM iceberg_metadata("lake"."sales"."orders") WHERE status <> 'DELETED' GROUP BY 1`);
  });

  it('Unity Catalog and Delta: rows from COUNT(*), which DuckDB answers from the log', async () => {
    const { run } = engine([], (sql) => (sql.startsWith('SELECT count(*)') ? [{ row_count: 4967 }] : undefined));
    expect(await lakeRelationSize(relation({}), run, new Map([['lake', 'unity_catalog']]))).toEqual({ rows: 4967, from: 'the Delta log' });
  });

  it('DuckLake: rows as DuckDB estimates them, bytes from its catalog', async () => {
    const { run } = engine([]);
    const bytes = async () => new Map([['orders', 504_971]]);
    expect(await lakeRelationSize(relation({ rowCountEstimate: 100_000 }), run, new Map([['lake', 'ducklake']]), bytes)).toEqual({ rows: 100_000, bytes: 504_971, from: 'the DuckLake catalog' });
  });

  it('a table in a DuckDB or SQLite file is not sized: reading it downloads nothing', async () => {
    const { run } = engine([]);
    expect(await lakeRelationSize(relation({}), run, new Map([['lake', 'duckdb']]))).toBeUndefined();
    expect(await lakeRelationSize(relation({ kind: 'view', viewSql: 'CREATE VIEW v AS SELECT * FROM t' }), run, new Map())).toBeUndefined();
  });
});

describe('sizing a catalog snapshot', () => {
  it('sizes the lake tables in place, names the ones it cannot, and leaves the rest alone', async () => {
    const files = [{ file: '/d/o/1.parquet', size: 800, rows: 8, columns: { id: 300, amount: 500 } }];
    const lakeView = relation({ id: 'a', name: 'orders', relation: 'memory.main.orders', kind: 'view', database: 'memory', viewSql: "CREATE VIEW orders AS SELECT * FROM read_parquet('/d/o/*.parquet')", columns: [{ name: 'id' }, { name: 'AMOUNT' }] });
    const broken = relation({ id: 'b', name: 'events', relation: 'memory.main.events', kind: 'view', database: 'memory', viewSql: "CREATE VIEW events AS SELECT * FROM read_parquet('/d/missing/*.parquet')" });
    const own = relation({ id: 'c', name: 'targets', relation: 'memory.main.targets', kind: 'table', database: 'memory', rowCountEstimate: 12 });
    const { run } = engine(files, (sql) => {
      if (sql.includes('duckdb_databases')) return [{ database_name: 'memory', type: 'duckdb' }];
      if (sql.includes("'/d/missing/")) throw new Error('No files found');
      return undefined;
    });
    const result = await addLakeSizes([lakeView, broken, own], run);
    expect(result).toEqual({ sized: 1, notSized: ['memory.main.events'], timedOut: 0 });
    expect(lakeView).toMatchObject({ rowCountEstimate: 8, bytesEstimate: 800, sizeFrom: 'footers of all 1 file' });
    expect(lakeView.columns).toEqual([{ name: 'id', bytesEstimate: 300 }, { name: 'AMOUNT', bytesEstimate: 500 }]);
    expect(own).toEqual(relation({ id: 'c', name: 'targets', relation: 'memory.main.targets', kind: 'table', database: 'memory', rowCountEstimate: 12 }));
  });

  it('stops at its time limit and counts the tables left unsized', async () => {
    let clock = 0;
    const views = [1, 2, 3].map((n) => relation({ id: `v${n}`, name: `t${n}`, relation: `memory.main.t${n}`, kind: 'view', viewSql: `CREATE VIEW t${n} AS SELECT * FROM read_csv_auto('/d/t${n}.csv')` }));
    const { run } = engine([{ file: '/d/t.csv', size: 10, rows: 0, columns: {} }], (sql) => {
      if (sql.includes('duckdb_databases')) return [];
      clock += 50;
      return undefined;
    });
    expect(await addLakeSizes(views, run, { timeLimitMs: 60, now: () => clock })).toEqual({ sized: 2, notSized: [], timedOut: 1 });
  });
});
