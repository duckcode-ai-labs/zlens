import { describe, expect, it } from 'vitest';
import { extractReaderCalls, isReaderFunction, readerTableName } from './reader-functions.js';
import { extractTablesFromSql } from './sql-parser.js';

describe('reads of lake data in SQL', () => {
  it('finds every reader, one read per path, options left out', () => {
    expect(extractReaderCalls(`
      SELECT * FROM delta_scan('./data/customers_delta')
      JOIN iceberg_scan('s3://lake/orders', allow_moved_paths = true, version = '00003-a') o USING (id)
      JOIN read_xlsx('./data/targets.xlsx', sheet = 'Q1') t USING (region)
      JOIN READ_PARQUET(['./data/a.parquet', "./data/b.parquet"], union_by_name = true) p USING (id)
      JOIN read_ndjson_auto('./logs/*.jsonl') l USING (id)
    `)).toEqual([
      "delta_scan('./data/customers_delta')",
      "iceberg_scan('s3://lake/orders')",
      "read_xlsx('./data/targets.xlsx')",
      "read_parquet('./data/a.parquet')",
      "read_parquet('./data/b.parquet')",
      "read_ndjson_auto('./logs/*.jsonl')",
    ]);
    expect(isReaderFunction('ICEBERG_SCAN')).toBe(true);
    expect(isReaderFunction('orders')).toBe(false);
  });

  it('names each read by what it reads', () => {
    expect(readerTableName("read_csv_auto('./data/revenue.csv')")).toBe('revenue');
    expect(readerTableName("read_parquet('./data/events/**/*.parquet')")).toBe('events');
    expect(readerTableName("read_parquet('s3://lake/events/year=2025/month=1/*.parquet')")).toBe('events');
    expect(readerTableName("delta_scan('./data/customers_delta')")).toBe('customers_delta');
    expect(readerTableName("delta_scan('s3://lake/customers/')")).toBe('customers');
    expect(readerTableName("iceberg_scan('./data/orders/metadata/00003-1b2c.metadata.json')")).toBe('orders');
    expect(readerTableName("read_xlsx('C:\\\\data\\\\targets.xlsx')")).toBe('targets');
    expect(readerTableName("read_csv('./data/daily.csv.gz')")).toBe('daily');
    expect(readerTableName('main.orders')).toBe('main.orders');
  });

  it('lineage lists the reads as tables, never the reader names', () => {
    const result = extractTablesFromSql(`
      SELECT c.region, SUM(o.amount)
      FROM iceberg_scan('./data/orders_iceberg') o
      JOIN delta_scan('./data/customers_delta') c USING (customer_id)
      JOIN read_xlsx('./data/targets.xlsx', sheet = 'Q1') t USING (region)
      GROUP BY 1
    `);
    expect(result.tables).toEqual([
      "iceberg_scan('./data/orders_iceberg')",
      "delta_scan('./data/customers_delta')",
      "read_xlsx('./data/targets.xlsx')",
    ]);
  });
});
