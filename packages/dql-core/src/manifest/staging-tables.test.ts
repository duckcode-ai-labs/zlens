import { describe, expect, it } from 'vitest';
import {
  isStagingTable,
  isTechnicalSchema,
  meaningfulDatabaseName,
  sentenceCaseName,
  splitStagingSchemas,
  splitStagingTables,
  stagingDuplicates,
  tableEntityKey,
} from './staging-tables.js';

const table = (schema: string, name: string) => ({ id: `${schema}.${name}`, schema, name });

describe('staging tables (new-user round 2, Q3)', () => {
  it('knows a staging copy by its stg_ name or its staging/stg/raw schema', () => {
    expect(isStagingTable(table('dev', 'stg_customers'))).toBe(true);
    expect(isStagingTable(table('raw', 'customers'))).toBe(true);
    expect(isStagingTable(table('staging', 'orders'))).toBe(true);
    expect(isStagingTable(table('dev', 'customers'))).toBe(false);
    expect(isStagingTable(table('dev', 'dim_customers'))).toBe(false);
  });

  it('reads what one row is through layer prefixes and plurals', () => {
    expect(tableEntityKey('stg_customers')).toBe('customer');
    expect(tableEntityKey('dim_customers')).toBe('customer');
    expect(tableEntityKey('raw_order_items')).toBe('order_item');
    expect(tableEntityKey('supplies')).toBe('supply');
  });

  it('hides a staging table only when a final table exists for the same thing', () => {
    const tables = [
      table('dev', 'customers'),
      table('dev', 'stg_customers'),
      table('dev', 'orders'),
      table('dev', 'stg_orders'),
      table('dev', 'stg_payments'),
      table('raw', 'raw_customers'),
    ];
    expect([...stagingDuplicates(tables)]).toEqual([
      ['dev.stg_customers', 'dev.customers'],
      ['dev.stg_orders', 'dev.orders'],
      ['raw.raw_customers', 'dev.customers'],
    ]);
    const split = splitStagingTables(tables);
    // stg_payments is the only copy of payments: it stays.
    expect(split.shown.map((item) => item.name)).toEqual(['customers', 'orders', 'stg_payments']);
    expect(split.hidden.map((item) => item.name)).toEqual(['stg_customers', 'stg_orders', 'raw_customers']);
    expect(splitStagingTables(tables, { show: true }).hidden).toEqual([]);
    expect(splitStagingTables(tables, { keep: (item) => item.name === 'stg_orders' }).shown.map((item) => item.name)).toContain('stg_orders');
  });

  it('puts staging schemas behind the toggle when the database has others', () => {
    const schemas = [{ name: 'dev' }, { name: 'main' }, { name: 'raw' }];
    expect(splitStagingSchemas(schemas)).toEqual({ shown: [{ name: 'dev' }, { name: 'main' }], hidden: [{ name: 'raw' }] });
    expect(splitStagingSchemas(schemas, { keep: (schema) => schema.name === 'raw' }).hidden).toEqual([]);
    // Only a raw schema: nothing to hide it behind.
    expect(splitStagingSchemas([{ name: 'raw' }]).shown).toEqual([{ name: 'raw' }]);
  });

  it('names a Domain after the database, never a technical schema', () => {
    expect(isTechnicalSchema('dev')).toBe(true);
    expect(isTechnicalSchema('main')).toBe(true);
    expect(isTechnicalSchema('dbt_kranthi')).toBe(true);
    expect(isTechnicalSchema('sales')).toBe(false);
    expect(meaningfulDatabaseName('/work/shop/jaffle_shop.duckdb')).toBe('jaffle_shop');
    expect(meaningfulDatabaseName('memory', 'main', 'ANALYTICS_PROD')).toBe('ANALYTICS_PROD');
    expect(meaningfulDatabaseName(':memory:', 'postgres')).toBeUndefined();
    expect(sentenceCaseName('jaffle_shop')).toBe('Jaffle shop');
    expect(sentenceCaseName('jaffle_shop.duckdb')).toBe('Jaffle shop');
    expect(sentenceCaseName('ANALYTICS_PROD')).toBe('Analytics prod');
    expect(sentenceCaseName('Shop')).toBe('Shop');
  });
});
