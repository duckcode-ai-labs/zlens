import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installDuckdbConnector, repoRoot, run } from './server';

/**
 * A small dbt-style shop for journeys about dbt relationships: the marts
 * `orders` and `customers`, the staging copy `stg_customers`, and dbt
 * `relationships` tests from orders.customer_id to both (as dbt projects
 * often have: the staging test and the mart test). A target/manifest.json is
 * written by hand; no dbt install is needed.
 */
export const DBT_SHOP_CUSTOMERS = [
  { customer_id: 'C1', customer_name: 'Ann Archer' },
  { customer_id: 'C2', customer_name: 'Bob Baker' },
  { customer_id: 'C3', customer_name: 'Cy Cole' },
];

export function writeDbtShop(projectDir: string, workDir: string): void {
  mkdirSync(projectDir, { recursive: true });
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  const shared = process.env.ZLENS_E2E_DUCKDB_CONNECTORS;
  if (shared && existsSync(shared)) cpSync(shared, connectorRoot, { recursive: true });
  else installDuckdbConnector(projectDir);
  const order = (id: string, customer: string, at: string, total: number) => ({ order_id: id, customer_id: customer, ordered_at: at, order_total: total });
  const customerColumns = [{ name: 'customer_id', type: 'text' }, { name: 'customer_name', type: 'text' }];
  const orderColumns = [{ name: 'order_id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'ordered_at', type: 'timestamp' }, { name: 'order_total', type: 'decimal' }];
  const seedPath = join(workDir, 'dbt-shop-seed.json');
  writeFileSync(seedPath, JSON.stringify({ tables: {
    customers: { columns: customerColumns, rows: DBT_SHOP_CUSTOMERS },
    stg_customers: { columns: customerColumns, rows: DBT_SHOP_CUSTOMERS },
    orders: { columns: orderColumns, rows: [
      order('O1', 'C1', '2026-01-05 10:00:00', 100),
      order('O2', 'C1', '2026-01-20 10:00:00', 50),
      order('O3', 'C2', '2026-02-02 10:00:00', 25),
      order('O4', 'C3', '2026-02-10 10:00:00', 10),
      order('O5', 'C2', '2026-03-01 10:00:00', 40),
    ] },
  } }));
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--seed', seedPath, '--connector-root', connectorRoot, '--out', join(projectDir, 'shop.duckdb')]);

  writeFileSync(join(projectDir, 'dbt_project.yml'), 'name: shop\nversion: "1.0.0"\nprofile: shop\nmodel-paths: ["models"]\n');
  writeFileSync(join(projectDir, 'dql.config.json'), `${JSON.stringify({
    project: 'dbt-shop',
    manifestVersion: 3,
    modeling: { mode: 'dbt-first' },
    defaultConnectionName: 'default',
    connections: { default: { driver: 'duckdb', filepath: 'shop.duckdb' } },
    semanticLayer: { provider: 'dbt', projectPath: '.' },
    dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
  }, null, 2)}\n`);
  const column = (name: string, type: string) => [name, { name, data_type: type, description: '' }];
  const model = (name: string, columns: Array<[string, string]>) => [`model.shop.${name}`, {
    unique_id: `model.shop.${name}`, resource_type: 'model', package_name: 'shop', name, alias: name,
    database: 'shop', schema: 'main', relation_name: `"shop"."main"."${name}"`,
    path: `${name}.sql`, original_file_path: `models/${name}.sql`, fqn: ['shop', name],
    description: '', tags: [], meta: {}, config: { materialized: 'table' },
    columns: Object.fromEntries(columns.map(([field, type]) => column(field, type))),
    depends_on: { nodes: [], macros: [] }, refs: [], sources: [], raw_code: `select * from ${name}`,
  }];
  const relationshipTest = (to: string) => [`test.shop.relationships_orders_customer_id__customer_id__ref_${to}_.x`, {
    unique_id: `test.shop.relationships_orders_customer_id__customer_id__ref_${to}_.x`, resource_type: 'test', package_name: 'shop',
    name: `relationships_orders_customer_id__customer_id__ref_${to}_`, column_name: 'customer_id', attached_node: 'model.shop.orders',
    test_metadata: { name: 'relationships', kwargs: { column_name: 'customer_id', field: 'customer_id', to: `ref('${to}')` } },
    depends_on: { nodes: [`model.shop.${to}`, 'model.shop.orders'], macros: [] }, refs: [{ name: to }, { name: 'orders' }],
    path: 'schema.yml', original_file_path: 'models/schema.yml', fqn: ['shop', 'relationships'], config: { severity: 'ERROR' },
  }];
  mkdirSync(join(projectDir, 'target'), { recursive: true });
  writeFileSync(join(projectDir, 'target', 'manifest.json'), JSON.stringify({
    metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json', dbt_version: '1.9.0', project_name: 'shop', adapter_type: 'duckdb' },
    nodes: Object.fromEntries([
      model('orders', [['order_id', 'VARCHAR'], ['customer_id', 'VARCHAR'], ['ordered_at', 'TIMESTAMP'], ['order_total', 'DECIMAL']]),
      model('customers', [['customer_id', 'VARCHAR'], ['customer_name', 'VARCHAR']]),
      model('stg_customers', [['customer_id', 'VARCHAR'], ['customer_name', 'VARCHAR']]),
      relationshipTest('stg_customers'),
      relationshipTest('customers'),
    ]),
    sources: {}, macros: {}, docs: {}, exposures: {}, metrics: {}, groups: {}, selectors: {}, disabled: {}, parent_map: {}, child_map: {}, group_map: {}, saved_queries: {}, semantic_models: {}, unit_tests: {},
  }));
}
