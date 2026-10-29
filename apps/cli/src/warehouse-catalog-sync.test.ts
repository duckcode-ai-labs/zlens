import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readWarehouseCatalog } from '@zlens/core';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { assembleWarehouseCatalog, buildWarehouseCatalogQueries, syncWarehouseCatalog } from './warehouse-catalog-sync.js';
import type { ConnectionMetadataScopeV1 } from './warehouse-metadata.js';

const scope = (catalogOrDatabase: string, schemas: string[]): ConnectionMetadataScopeV1 => ({
  version: 1, connectionId: 'default', driver: 'x', mode: 'selected_scopes',
  scopes: [{ catalogOrDatabase, schemas }], selectedScopes: [{ catalogOrDatabase, schemas }], relations: [], scopeFingerprint: 'f',
});

describe('assembling a warehouse catalog from metadata rows', () => {
  it('DuckDB: columns, comments, declared keys and view SQL (rows as a real DuckDB returns them)', () => {
    const queries = buildWarehouseCatalogQueries('duckdb', { catalogOrDatabase: 'memory', schemas: ['sales'] });
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    const relations = assembleWarehouseCatalog('duckdb', [
      { query: byKind('columns'), rows: [
        { table_catalog: 'memory', table_schema: 'sales', table_name: 'customers', column_name: 'customer_id', data_type: 'INTEGER', is_nullable: false, comment: null },
        { table_catalog: 'memory', table_schema: 'sales', table_name: 'customers', column_name: 'name', data_type: 'VARCHAR', is_nullable: true, comment: 'Full name' },
        { table_catalog: 'memory', table_schema: 'sales', table_name: 'orders', column_name: 'order_id', data_type: 'INTEGER', is_nullable: false, comment: null },
        { table_catalog: 'memory', table_schema: 'sales', table_name: 'orders', column_name: 'customer_id', data_type: 'INTEGER', is_nullable: true, comment: null },
        { table_catalog: 'memory', table_schema: 'sales', table_name: 'big_orders', column_name: 'order_id', data_type: 'INTEGER', is_nullable: true, comment: null },
      ] },
      { query: byKind('tables'), rows: [{ table_catalog: 'memory', table_schema: 'sales', table_name: 'customers', table_type: 'BASE TABLE', comment: 'One row per customer', row_count: 0 }] },
      { query: byKind('views'), rows: [{ table_catalog: 'memory', table_schema: 'sales', table_name: 'big_orders', comment: null, view_definition: 'CREATE VIEW sales.big_orders AS SELECT o.order_id FROM sales.orders AS o' }] },
      { query: byKind('keys'), rows: [
        { table_schema: 'sales', table_name: 'customers', constraint_type: 'PRIMARY KEY', constraint_column_names: ['customer_id'], referenced_table: null, referenced_column_names: [] },
        { table_schema: 'sales', table_name: 'orders', constraint_type: 'PRIMARY KEY', constraint_column_names: ['order_id'], referenced_table: null, referenced_column_names: [] },
        { table_schema: 'sales', table_name: 'orders', constraint_type: 'FOREIGN KEY', constraint_column_names: ['customer_id'], referenced_table: 'customers', referenced_column_names: ['customer_id'] },
      ] },
    ]);
    const byName = Object.fromEntries(relations.map((relation) => [relation.name, relation]));
    // Three-part, as Ask's schema index and dbt name DuckDB tables; the id is unchanged.
    expect(byName.customers).toMatchObject({ id: 'warehouse.sales.customers', database: 'memory', relation: 'memory.sales.customers', kind: 'table', comment: 'One row per customer', primaryKey: ['customer_id'] });
    expect(byName.customers!.columns).toEqual([{ name: 'customer_id', type: 'INTEGER', nullable: false }, { name: 'name', type: 'VARCHAR', comment: 'Full name', nullable: true }]);
    expect(byName.orders!.foreignKeys).toEqual([{ columns: ['customer_id'], references: { relation: 'sales.customers', columns: ['customer_id'] } }]);
    expect(byName.big_orders!.relation).toBe('memory.sales.big_orders');
    expect(byName.big_orders).toMatchObject({ kind: 'view', viewSql: expect.stringContaining('CREATE VIEW') });
  });

  it('Snowflake: keys from SHOW PRIMARY KEYS / SHOW IMPORTED KEYS, relations qualified with the database', () => {
    const queries = buildWarehouseCatalogQueries('snowflake', { catalogOrDatabase: 'ACME', schemas: ['SALES'] });
    expect(queries.map((query) => query.kind)).toEqual(['columns', 'tables', 'views', 'primary_keys', 'foreign_keys']);
    expect(queries[0]!.sql).toContain('"ACME".INFORMATION_SCHEMA.COLUMNS');
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    const relations = assembleWarehouseCatalog('snowflake', [
      { query: byKind('columns'), rows: [
        { TABLE_CATALOG: 'ACME', TABLE_SCHEMA: 'SALES', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'ORDER_ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'NO', COMMENT: 'The order' },
        { TABLE_CATALOG: 'ACME', TABLE_SCHEMA: 'SALES', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'CUSTOMER_ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'YES', COMMENT: null },
        { TABLE_CATALOG: 'ACME', TABLE_SCHEMA: 'SALES', TABLE_NAME: 'CUSTOMERS', COLUMN_NAME: 'CUSTOMER_ID', DATA_TYPE: 'NUMBER', IS_NULLABLE: 'NO', COMMENT: null },
      ] },
      { query: byKind('tables'), rows: [{ TABLE_CATALOG: 'ACME', TABLE_SCHEMA: 'SALES', TABLE_NAME: 'ORDERS', TABLE_TYPE: 'BASE TABLE', COMMENT: 'Orders', ROW_COUNT: 1200 }] },
      { query: byKind('primary_keys'), rows: [{ schema_name: 'SALES', table_name: 'ORDERS', column_name: 'ORDER_ID', key_sequence: 1 }] },
      { query: byKind('foreign_keys'), rows: [{ pk_database_name: 'ACME', pk_schema_name: 'SALES', pk_table_name: 'CUSTOMERS', pk_column_name: 'CUSTOMER_ID', fk_schema_name: 'SALES', fk_table_name: 'ORDERS', fk_column_name: 'CUSTOMER_ID', key_sequence: 1, fk_name: 'FK_ORDERS_CUSTOMER' }] },
    ]);
    const orders = relations.find((relation) => relation.name === 'ORDERS')!;
    expect(orders).toMatchObject({ id: 'warehouse.acme.sales.orders', relation: 'ACME.SALES.ORDERS', comment: 'Orders', rowCountEstimate: 1200, primaryKey: ['ORDER_ID'] });
    expect(orders.foreignKeys).toEqual([{ columns: ['CUSTOMER_ID'], references: { relation: 'ACME.SALES.CUSTOMERS', columns: ['CUSTOMER_ID'] }, name: 'FK_ORDERS_CUSTOMER' }]);
  });

  it('Postgres: a composite primary key in key order, and a foreign key with the referenced side resolved', () => {
    const queries = buildWarehouseCatalogQueries('postgres', { catalogOrDatabase: 'app', schemas: ['public'] });
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    const relations = assembleWarehouseCatalog('postgres', [
      { query: byKind('columns'), rows: [
        { table_catalog: 'app', table_schema: 'public', table_name: 'line_items', column_name: 'order_id', data_type: 'integer', is_nullable: 'NO', comment: null },
        { table_catalog: 'app', table_schema: 'public', table_name: 'line_items', column_name: 'line_no', data_type: 'integer', is_nullable: 'NO', comment: null },
      ] },
      { query: byKind('keys'), rows: [
        { constraint_type: 'PRIMARY KEY', constraint_name: 'line_items_pkey', table_schema: 'public', table_name: 'line_items', column_name: 'line_no', position: 2 },
        { constraint_type: 'PRIMARY KEY', constraint_name: 'line_items_pkey', table_schema: 'public', table_name: 'line_items', column_name: 'order_id', position: 1 },
        { constraint_type: 'FOREIGN KEY', constraint_name: 'line_items_order_fk', table_schema: 'public', table_name: 'line_items', column_name: 'order_id', position: 1, ref_schema: 'public', ref_table: 'orders', ref_column: 'id' },
      ] },
    ]);
    expect(relations[0]).toMatchObject({ relation: 'app.public.line_items', primaryKey: ['order_id', 'line_no'] });
    expect(relations[0]!.foreignKeys).toEqual([{ columns: ['order_id'], references: { relation: 'public.orders', columns: ['id'] }, name: 'line_items_order_fk' }]);
  });

  it('Postgres: keys and view SQL come from pg_catalog, which a read-only login can read', () => {
    // information_schema.table_constraints and views.view_definition show a
    // table's constraints and a view's SQL only to its owner.
    const queries = buildWarehouseCatalogQueries('postgresql', { catalogOrDatabase: 'shop', schemas: ['sales'] });
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    expect(queries.map((query) => query.kind)).toEqual(['columns', 'tables', 'views', 'keys']);
    expect(byKind('keys').sql).toContain('pg_catalog.pg_constraint');
    expect(byKind('keys').sql).toContain("UPPER(n.nspname) IN (UPPER('sales'))");
    expect(byKind('views').sql).toContain('pg_get_viewdef(c.oid)');
    for (const kind of ['keys', 'views']) expect(byKind(kind).sql).not.toContain('information_schema');
    // Rows as Postgres 16 returns them to a SELECT-only role: a composite
    // foreign key unnests to one row per column pair, in key order.
    const relations = assembleWarehouseCatalog('postgresql', [
      { query: byKind('columns'), rows: [
        { table_catalog: 'shop', table_schema: 'sales', table_name: 'shipments', column_name: 'shipment_id', data_type: 'text', is_nullable: 'NO', comment: null },
        { table_catalog: 'shop', table_schema: 'sales', table_name: 'shipments', column_name: 'order_id', data_type: 'text', is_nullable: 'YES', comment: null },
        { table_catalog: 'shop', table_schema: 'sales', table_name: 'shipments', column_name: 'line_no', data_type: 'integer', is_nullable: 'YES', comment: null },
        { table_catalog: 'shop', table_schema: 'sales', table_name: 'open_shipments', column_name: 'shipment_id', data_type: 'text', is_nullable: 'YES', comment: null },
      ] },
      { query: byKind('tables'), rows: [{ table_catalog: 'shop', table_schema: 'sales', table_name: 'open_shipments', table_type: 'VIEW', comment: null }] },
      { query: byKind('views'), rows: [{ table_catalog: 'shop', table_schema: 'sales', table_name: 'open_shipments', view_definition: ' SELECT shipments.shipment_id\n   FROM sales.shipments;' }] },
      { query: byKind('keys'), rows: [
        { constraint_type: 'FOREIGN KEY', constraint_name: 'shipments_line_fk', table_schema: 'sales', table_name: 'shipments', column_name: 'order_id', position: '1', ref_schema: 'sales', ref_table: 'order_items', ref_column: 'order_id' },
        { constraint_type: 'FOREIGN KEY', constraint_name: 'shipments_line_fk', table_schema: 'sales', table_name: 'shipments', column_name: 'line_no', position: '2', ref_schema: 'sales', ref_table: 'order_items', ref_column: 'line_no' },
        { constraint_type: 'PRIMARY KEY', constraint_name: 'shipments_pkey', table_schema: 'sales', table_name: 'shipments', column_name: 'shipment_id', position: '1', ref_schema: null, ref_table: null, ref_column: null },
      ] },
    ]);
    const byName = Object.fromEntries(relations.map((relation) => [relation.name, relation]));
    expect(byName.shipments).toMatchObject({ relation: 'shop.sales.shipments', primaryKey: ['shipment_id'] });
    expect(byName.shipments!.foreignKeys).toEqual([{ columns: ['order_id', 'line_no'], references: { relation: 'sales.order_items', columns: ['order_id', 'line_no'] }, name: 'shipments_line_fk' }]);
    expect(byName.open_shipments).toMatchObject({ kind: 'view', viewSql: expect.stringContaining('FROM sales.shipments') });
  });

  it('Redshift keeps reading keys and views from information_schema', () => {
    const queries = buildWarehouseCatalogQueries('redshift', { catalogOrDatabase: 'dw', schemas: ['sales'] });
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    expect(byKind('keys').sql).toContain('information_schema.table_constraints');
    expect(byKind('views').sql).toContain('information_schema.views');
    expect(queries.some((query) => query.sql.includes('LATERAL'))).toBe(false);
  });

  it('Databricks: Unity Catalog information_schema, informational keys, catalog-qualified relations', () => {
    const queries = buildWarehouseCatalogQueries('databricks', { catalogOrDatabase: 'main', schemas: ['sales'] });
    expect(queries.map((query) => query.kind)).toEqual(['columns', 'tables', 'views', 'keys']);
    expect(queries[0]!.sql).toContain('`main`.information_schema.columns');
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    const relations = assembleWarehouseCatalog('databricks', [
      { query: byKind('columns'), rows: [
        { table_catalog: 'main', table_schema: 'sales', table_name: 'orders', column_name: 'order_id', data_type: 'bigint', is_nullable: 'NO', comment: 'Order number' },
        { table_catalog: 'main', table_schema: 'sales', table_name: 'orders', column_name: 'customer_id', data_type: 'bigint', is_nullable: 'YES', comment: null },
        { table_catalog: 'main', table_schema: 'sales', table_name: 'customers', column_name: 'customer_id', data_type: 'bigint', is_nullable: 'NO', comment: null },
        { table_catalog: 'main', table_schema: 'sales', table_name: 'daily', column_name: 'day', data_type: 'date', is_nullable: 'YES', comment: null },
      ] },
      { query: byKind('tables'), rows: [
        { table_catalog: 'main', table_schema: 'sales', table_name: 'orders', table_type: 'MANAGED', comment: 'All orders' },
        { table_catalog: 'main', table_schema: 'sales', table_name: 'daily', table_type: 'MATERIALIZED_VIEW', comment: null },
      ] },
      { query: byKind('keys'), rows: [
        { constraint_type: 'PRIMARY KEY', constraint_name: 'orders_pk', table_schema: 'sales', table_name: 'orders', column_name: 'order_id', position: 1 },
        { constraint_type: 'FOREIGN KEY', constraint_name: 'orders_customer_fk', table_schema: 'sales', table_name: 'orders', column_name: 'customer_id', position: 1, ref_catalog: 'main', ref_schema: 'sales', ref_table: 'customers', ref_column: 'customer_id' },
      ] },
    ]);
    const byName = Object.fromEntries(relations.map((relation) => [relation.name, relation]));
    expect(byName.orders).toMatchObject({ id: 'warehouse.main.sales.orders', relation: 'main.sales.orders', kind: 'table', comment: 'All orders', primaryKey: ['order_id'] });
    expect(byName.orders!.columns[0]).toEqual({ name: 'order_id', type: 'bigint', comment: 'Order number', nullable: false });
    expect(byName.orders!.foreignKeys).toEqual([{ columns: ['customer_id'], references: { relation: 'main.sales.customers', columns: ['customer_id'] }, name: 'orders_customer_fk' }]);
    expect(byName.daily).toMatchObject({ kind: 'materialized_view' });
  });

  it('BigQuery: one read per kind across the datasets, descriptions from options and field paths', () => {
    const queries = buildWarehouseCatalogQueries('bigquery', { catalogOrDatabase: 'acme-prod', schemas: ['sales', 'crm'] });
    expect(queries.map((query) => query.kind)).toEqual(['columns', 'tables', 'views', 'keys']);
    expect(queries[0]!.sql).toContain('`acme-prod`.`sales`.INFORMATION_SCHEMA.COLUMNS');
    expect(queries[0]!.sql).toContain('`acme-prod`.`crm`.INFORMATION_SCHEMA.COLUMNS');
    expect(queries[0]!.sql.match(/UNION ALL/g)).toHaveLength(1);
    expect(buildWarehouseCatalogQueries('bigquery', { catalogOrDatabase: 'acme-prod', schemas: [] })[0]!.sql).toMatch(/Choose the BigQuery datasets/);
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    const relations = assembleWarehouseCatalog('bigquery', [
      { query: byKind('columns'), rows: [
        { table_catalog: 'acme-prod', table_schema: 'sales', table_name: 'orders', column_name: 'order_id', data_type: 'INT64', is_nullable: 'NO', comment: 'Order number' },
        { table_catalog: 'acme-prod', table_schema: 'sales', table_name: 'orders', column_name: 'account_id', data_type: 'INT64', is_nullable: 'YES', comment: null },
        { table_catalog: 'acme-prod', table_schema: 'crm', table_name: 'accounts', column_name: 'account_id', data_type: 'INT64', is_nullable: 'NO', comment: null },
      ] },
      { query: byKind('tables'), rows: [{ table_catalog: 'acme-prod', table_schema: 'sales', table_name: 'orders', table_type: 'BASE TABLE', comment: 'One row per order' }] },
      { query: byKind('keys'), rows: [
        { constraint_type: 'PRIMARY KEY', constraint_name: 'orders.pk$', table_schema: 'sales', table_name: 'orders', column_name: 'order_id', position: 1 },
        { constraint_type: 'FOREIGN KEY', constraint_name: 'orders_account', table_schema: 'sales', table_name: 'orders', column_name: 'account_id', position: 1, ref_catalog: 'acme-prod', ref_schema: 'crm', ref_table: 'accounts', ref_column: 'account_id' },
      ] },
    ]);
    const orders = relations.find((relation) => relation.name === 'orders')!;
    expect(orders).toMatchObject({ id: 'warehouse.acme-prod.sales.orders', relation: 'acme-prod.sales.orders', comment: 'One row per order', primaryKey: ['order_id'] });
    expect(orders.foreignKeys).toEqual([{ columns: ['account_id'], references: { relation: 'acme-prod.crm.accounts', columns: ['account_id'] }, name: 'orders_account' }]);
  });

  it('another driver reads tables, views and columns from information_schema only', () => {
    expect(buildWarehouseCatalogQueries('vertica', { catalogOrDatabase: 'shop', schemas: ['shop'] }).map((query) => query.kind)).toEqual(['columns', 'tables']);
  });

  it('MySQL: a database is the schema; comments and keys come with names of their targets', () => {
    const queries = buildWarehouseCatalogQueries('mysql', { catalogOrDatabase: 'shop', schemas: ['shop'] });
    expect(queries.map((query) => query.kind)).toEqual(['columns', 'tables', 'views', 'keys']);
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    // MySQL 8 returns information_schema column names in upper case.
    const relations = assembleWarehouseCatalog('mysql', [
      { query: byKind('columns'), rows: [
        { TABLE_SCHEMA: 'shop', TABLE_NAME: 'orders', COLUMN_NAME: 'id', DATA_TYPE: 'bigint', IS_NULLABLE: 'NO', COMMENT: '' },
        { TABLE_SCHEMA: 'shop', TABLE_NAME: 'orders', COLUMN_NAME: 'customer_id', DATA_TYPE: 'bigint', IS_NULLABLE: 'YES', COMMENT: 'Who ordered' },
        { TABLE_SCHEMA: 'shop', TABLE_NAME: 'customers', COLUMN_NAME: 'id', DATA_TYPE: 'bigint', IS_NULLABLE: 'NO', COMMENT: '' },
      ] },
      { query: byKind('tables'), rows: [{ TABLE_SCHEMA: 'shop', TABLE_NAME: 'orders', TABLE_TYPE: 'BASE TABLE', COMMENT: 'One row per order', ROW_COUNT: 50 }] },
      { query: byKind('keys'), rows: [
        { CONSTRAINT_TYPE: 'PRIMARY KEY', CONSTRAINT_NAME: 'PRIMARY', TABLE_SCHEMA: 'shop', TABLE_NAME: 'orders', COLUMN_NAME: 'id', POSITION: 1 },
        { CONSTRAINT_TYPE: 'FOREIGN KEY', CONSTRAINT_NAME: 'orders_customer', TABLE_SCHEMA: 'shop', TABLE_NAME: 'orders', COLUMN_NAME: 'customer_id', POSITION: 1, REF_SCHEMA: 'shop', REF_TABLE: 'customers', REF_COLUMN: 'id' },
      ] },
    ]);
    const orders = relations.find((relation) => relation.name === 'orders')!;
    // Two parts: MySQL has no catalog to qualify with.
    expect(orders).toMatchObject({ relation: 'shop.orders', comment: 'One row per order', primaryKey: ['id'], rowCountEstimate: 50 });
    expect(orders.foreignKeys).toEqual([{ columns: ['customer_id'], references: { relation: 'shop.customers', columns: ['id'] }, name: 'orders_customer' }]);
    expect(orders.columns.find((column) => column.name === 'customer_id')?.comment).toBe('Who ordered');
  });

  it('SQL Server: TOP instead of LIMIT, MS_Description comments, keys from sys views, three-part names', () => {
    const queries = buildWarehouseCatalogQueries('mssql', { catalogOrDatabase: 'sales', schemas: ['dbo'] });
    expect(queries.map((query) => query.kind)).toEqual(['columns', 'tables', 'views', 'keys']);
    expect(queries.every((query) => !/\bLIMIT\b/.test(query.sql))).toBe(true);
    expect(queries[0]!.sql).toContain('MS_Description');
    const byKind = (kind: string) => queries.find((query) => query.kind === kind)!;
    const relations = assembleWarehouseCatalog('mssql', [
      { query: byKind('columns'), rows: [
        { table_catalog: 'sales', table_schema: 'dbo', table_name: 'orders', column_name: 'id', data_type: 'bigint', is_nullable: 'NO', comment: null },
        { table_catalog: 'sales', table_schema: 'dbo', table_name: 'orders', column_name: 'line', data_type: 'int', is_nullable: 'NO', comment: null },
      ] },
      { query: byKind('keys'), rows: [
        { constraint_type: 'PRIMARY KEY', constraint_name: 'pk_orders', table_schema: 'dbo', table_name: 'orders', column_name: 'line', position: 2 },
        { constraint_type: 'PRIMARY KEY', constraint_name: 'pk_orders', table_schema: 'dbo', table_name: 'orders', column_name: 'id', position: 1 },
      ] },
    ]);
    expect(relations[0]).toMatchObject({ relation: 'sales.dbo.orders', primaryKey: ['id', 'line'] });
  });

  it('ClickHouse: system tables, no keys (a sorting key is not unique)', () => {
    const queries = buildWarehouseCatalogQueries('clickhouse', { catalogOrDatabase: 'analytics', schemas: ['analytics'] });
    expect(queries.map((query) => query.kind)).toEqual(['columns', 'tables']);
    expect(queries[0]!.sql).toContain('system.columns');
  });

  it('Trino reads its catalog\'s own information_schema and names relations with the catalog', () => {
    const queries = buildWarehouseCatalogQueries('trino', { catalogOrDatabase: 'hive', schemas: ['sales'] });
    expect(queries[0]!.sql).toContain('"hive".information_schema.columns');
    const relations = assembleWarehouseCatalog('trino', [
      { query: queries[0]!, rows: [{ table_catalog: 'hive', table_schema: 'sales', table_name: 'orders', column_name: 'id', data_type: 'bigint', is_nullable: 'NO', comment: null }] },
    ]);
    expect(relations[0]!.relation).toBe('hive.sales.orders');
  });
});

describe('syncing a live SQLite warehouse', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('leaves out a broken view instead of failing the whole sync', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-broken-view-'));
    roots.push(projectRoot);
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE staging (a INTEGER);
      CREATE VIEW stale AS SELECT a FROM staging;
      DROP TABLE staging;
    `);
    const executor = { executePositional: async (sql: string) => ({ rows: db.prepare(sql).all(), columns: [], rowCount: 0 }) } as unknown as QueryExecutor;
    const result = await syncWarehouseCatalog({ projectRoot, executor, connection: { driver: 'sqlite' } as ConnectionConfig, scope: scope('main', ['main']) });
    expect(result.snapshot.relations.map((relation) => relation.name)).toEqual(['customers']);
    expect(result.snapshot.relations[0]).toMatchObject({ primaryKey: ['customer_id'] });
    expect(result.warnings.join(' ')).toMatch(/could not be described and were left out/);
  });

  it('reads declared keys and views, writes the snapshot, and reports an unreadable optional part as a warning', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-sync-'));
    roots.push(projectRoot);
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(customer_id), amount REAL);
      CREATE VIEW big_orders AS SELECT order_id FROM orders WHERE amount > 100;
    `);
    const executor = {
      executePositional: async (sql: string) => {
        if (/pragma_foreign_key_list/.test(sql) && failForeignKeys) throw new Error('permission denied');
        return { rows: db.prepare(sql).all(), columns: [], rowCount: 0 };
      },
    } as unknown as QueryExecutor;
    let failForeignKeys = false;
    const connection = { driver: 'sqlite' } as ConnectionConfig;

    const first = await syncWarehouseCatalog({ projectRoot, executor, connection, scope: scope('main', ['main']) });
    expect(first.warnings).toEqual([]);
    const snapshot = readWarehouseCatalog(projectRoot).snapshot!;
    expect(snapshot.fingerprint).toBe(first.snapshot.fingerprint);
    const byName = Object.fromEntries(snapshot.relations.map((relation) => [relation.name, relation]));
    expect(byName.customers).toMatchObject({ relation: 'main.customers', primaryKey: ['customer_id'] });
    // SQLite has no three-part names: no database is recorded.
    expect(byName.customers!.database).toBeUndefined();
    expect(byName.customers!.columns.find((column) => column.name === 'name')).toMatchObject({ nullable: false });
    expect(byName.orders!.foreignKeys).toEqual([{ columns: ['customer_id'], references: { relation: 'main.customers', columns: ['customer_id'] }, name: '0' }]);
    expect(byName.big_orders).toMatchObject({ kind: 'view', viewSql: expect.stringContaining('CREATE VIEW') });

    failForeignKeys = true;
    const second = await syncWarehouseCatalog({ projectRoot, executor, connection, scope: scope('main', ['main']) });
    expect(second.warnings.join(' ')).toMatch(/foreign keys of main not read: permission denied/);
    expect(second.snapshot.relations.find((relation) => relation.name === 'orders')!.foreignKeys).toBeUndefined();
  });
});
