import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { QueryExecutor, type ConnectionConfig, type QueryResult } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { CHECK_ROW_BUDGET, discoverWarehouseMetadataScopes } from './warehouse-metadata.js';

/**
 * Onboarding design P1: the schema picker shows each schema's size, read from
 * the warehouse's catalog with one statement per database, so a person can
 * start small. No table is read.
 */
const snowflake: ConnectionConfig = {
  driver: 'snowflake',
  account: 'acme-prod',
  database: 'ANALYTICS_PROD',
  schema: 'SALES',
  role: 'ANALYST',
  warehouse: 'REPORTING_WH',
  username: 'service_user',
  password: 'secret-one',
};

const result = (rows: Array<Record<string, unknown>>): QueryResult => ({ columns: [], rows, rowCount: rows.length, executionTimeMs: 1 });
const identity = result([{
  DQL_ACCOUNT: 'ACME-PROD', DQL_ACCOUNT_LOCATOR: 'XY123', DQL_ACCOUNT_NAME: 'PROD', DQL_ORGANIZATION: 'ACME',
  DQL_DATABASE: 'ANALYTICS_PROD', DQL_SCHEMA: 'SALES', DQL_ROLE: 'ANALYST', DQL_WAREHOUSE: 'REPORTING_WH',
}]);
const schemas = result([
  { database_name: 'ANALYTICS_PROD', name: 'SALES' },
  { database_name: 'ANALYTICS_PROD', name: 'GOLD' },
  { database_name: 'REFERENCE_DATA', name: 'SHARED' },
]);

describe('schema sizes in discovery (onboarding design P1)', () => {
  it('Snowflake: one catalog statement per database gives tables, rows, bytes, columns and declared keys per schema', async () => {
    const executePositional = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql.includes('CURRENT_ACCOUNT')) return identity;
      if (sql.startsWith('SHOW TERSE SCHEMAS')) return schemas;
      expect(sql).toContain('"ANALYTICS_PROD".INFORMATION_SCHEMA.TABLES');
      expect(sql).toContain('"ANALYTICS_PROD".INFORMATION_SCHEMA.TABLE_CONSTRAINTS');
      expect(sql).toContain('"ANALYTICS_PROD".INFORMATION_SCHEMA.COLUMNS');
      expect(sql).not.toMatch(/\bFROM\s+"ANALYTICS_PROD"\.(SALES|GOLD)\./);
      return result([
        { TABLE_CATALOG: 'ANALYTICS_PROD', TABLE_SCHEMA: 'SALES', TABLE_COUNT: 42, VIEW_COUNT: 2, ROW_COUNT: 31_000_000, BYTES: 2_400_000_000, KEYED_TABLE_COUNT: 30, FOREIGN_KEY_COUNT: 12, LARGE_TABLE_COUNT: 1, LARGEST_TABLE_ROWS: 25_000_000, COLUMN_COUNT: 610 },
        { TABLE_CATALOG: 'ANALYTICS_PROD', TABLE_SCHEMA: 'GOLD', TABLE_COUNT: 3, VIEW_COUNT: 3, ROW_COUNT: null, BYTES: null, KEYED_TABLE_COUNT: 0, FOREIGN_KEY_COUNT: 0, LARGE_TABLE_COUNT: 0, LARGEST_TABLE_ROWS: null, COLUMN_COUNT: '27' },
      ]);
    });
    const discovery = await discoverWarehouseMetadataScopes({
      connectionId: 'primary',
      executor: { executePositional } as unknown as QueryExecutor,
      connection: snowflake,
      sizes: { databases: ['analytics_prod'] },
    });
    const analytics = discovery.scopes.find((scope) => scope.catalogOrDatabase === 'ANALYTICS_PROD')!;
    expect(analytics.schemas).toEqual([
      { name: 'GOLD', inDbtProject: false, dbtRelationCount: 0, size: { tables: 3, views: 3, columns: 27, tablesWithKeys: 0, foreignKeys: 0, largeTables: 0 } },
      { name: 'SALES', inDbtProject: false, dbtRelationCount: 0, size: { tables: 42, views: 2, columns: 610, rows: 31_000_000, bytes: 2_400_000_000, tablesWithKeys: 30, foreignKeys: 12, largeTables: 1, largestTableRows: 25_000_000 } },
    ]);
    // Only the databases named are sized; the others are listed by name.
    expect(discovery.scopes.find((scope) => scope.catalogOrDatabase === 'REFERENCE_DATA')!.schemas[0]).not.toHaveProperty('size');
    expect(executePositional).toHaveBeenCalledTimes(3);
    expect(discovery.queryCount).toBe(2);
    expect(discovery.limits).toEqual({ tables: 10_000, columnsPerDatabase: 50_000, checkRowBudget: CHECK_ROW_BUDGET });
    expect(discovery.sizesUnavailable).toBeUndefined();
  });

  it('Snowflake: when COLUMNS refuses a large database, sizes come without column counts; a database that fails is named', async () => {
    const executePositional = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql.includes('CURRENT_ACCOUNT')) return identity;
      if (sql.startsWith('SHOW TERSE SCHEMAS')) return schemas;
      if (sql.includes('"REFERENCE_DATA"')) throw new Error('Insufficient privileges');
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) throw new Error('Information schema query returned too much data.');
      return result([{ TABLE_CATALOG: 'ANALYTICS_PROD', TABLE_SCHEMA: 'SALES', TABLE_COUNT: 9000, VIEW_COUNT: 0, ROW_COUNT: 1, BYTES: 1, KEYED_TABLE_COUNT: 0, FOREIGN_KEY_COUNT: 0, LARGE_TABLE_COUNT: 0, LARGEST_TABLE_ROWS: 1 }]);
    });
    const discovery = await discoverWarehouseMetadataScopes({
      connectionId: 'primary',
      executor: { executePositional } as unknown as QueryExecutor,
      connection: snowflake,
      sizes: true,
    });
    const sales = discovery.scopes[0]!.schemas.find((schema) => schema.name === 'SALES')!;
    expect(sales.size).toMatchObject({ tables: 9000 });
    expect(sales.size).not.toHaveProperty('columns');
    expect(discovery.sizesUnavailable).toEqual(['REFERENCE_DATA']);
    // Every schema is still listed.
    expect(discovery.scopes.flatMap((scope) => scope.schemas.map((schema) => schema.name)).sort()).toEqual(['GOLD', 'SALES', 'SHARED']);
  });

  it('without sizes asked for, discovery runs no size statement', async () => {
    const executePositional = vi.fn(async (sql: string): Promise<QueryResult> => (sql.includes('CURRENT_ACCOUNT') ? identity : schemas));
    await discoverWarehouseMetadataScopes({ connectionId: 'primary', executor: { executePositional } as unknown as QueryExecutor, connection: snowflake });
    expect(executePositional).toHaveBeenCalledTimes(2);
  });

  it('PostgreSQL: sizes from the planner estimates in one statement', async () => {
    const connection: ConnectionConfig = { driver: 'postgresql', host: 'db.example.test', database: 'shop', schema: 'public', username: 'u', password: 'p' };
    const executePositional = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql.includes('information_schema.schemata')) return result([{ catalog_name: 'shop', schema_name: 'public' }]);
      if (sql.includes('pg_class')) {
        expect(sql).toContain('reltuples');
        return result([{ table_catalog: 'shop', table_schema: 'public', table_count: '5', view_count: '1', row_count: 1200.0, bytes: '81920', keyed_table_count: '4', foreign_key_count: '3', column_count: '31', large_table_count: '0', largest_table_rows: 1000 }]);
      }
      return result([{ current_database: 'shop', current_schema: 'public' }]);
    });
    const discovery = await discoverWarehouseMetadataScopes({ connectionId: 'pg', executor: { executePositional } as unknown as QueryExecutor, connection, sizes: true });
    expect(discovery.scopes[0]!.schemas[0]!.size).toEqual({ tables: 5, views: 1, columns: 31, rows: 1200, bytes: 81920, tablesWithKeys: 4, foreignKeys: 3, largeTables: 0, largestTableRows: 1000 });
  });
});

const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;

describe('schema sizes on real DuckDB (onboarding design P1)', () => {
  duckDbIt('counts tables, views, rows, columns, declared keys and foreign keys per schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-schema-sizes-'));
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: join(root, 'shop.duckdb'), moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    try {
      for (const statement of [
        'CREATE TABLE customers (id INTEGER PRIMARY KEY, name VARCHAR)',
        'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers (id), amount DOUBLE)',
        'CREATE TABLE events (happened_at TIMESTAMP, kind VARCHAR)',
        'CREATE VIEW big_orders AS SELECT * FROM orders WHERE amount > 100',
        'CREATE SCHEMA staging',
        'CREATE TABLE staging.raw_orders (payload VARCHAR)',
        'INSERT INTO customers SELECT range, \'c\' || range FROM range(50)',
        'INSERT INTO orders SELECT range, range % 50, range * 1.5 FROM range(300)',
      ]) await executor.executePositional(statement, [], connection);
      const discovery = await discoverWarehouseMetadataScopes({ connectionId: 'default', executor, connection, sizes: true });
      const shop = discovery.scopes.find((scope) => scope.catalogOrDatabase === 'shop')!;
      const main = shop.schemas.find((schema) => schema.name === 'main')!;
      expect(main.size).toMatchObject({ tables: 4, views: 1, columns: 10, tablesWithKeys: 2, foreignKeys: 1, largeTables: 0 });
      expect(main.size!.rows).toBeGreaterThanOrEqual(300);
      expect(shop.schemas.find((schema) => schema.name === 'staging')!.size).toMatchObject({ tables: 1, views: 0, columns: 1, tablesWithKeys: 0 });
      expect(discovery.sizesUnavailable).toBeUndefined();
    } finally {
      await executor.disconnect();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
