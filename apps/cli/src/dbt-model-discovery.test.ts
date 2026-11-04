import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildManifest, warehouseRelationId, type WarehouseCatalogRelationV1 } from '@zlens/core';
import { QueryExecutor } from '@zlens/connectors';
import { dbtModelSnapshot, dbtWarehouseNodes, dbtWarehouseScopes } from './dbt-model-discovery.js';
import { applyProjectWarehouseDiscovery, discoverProjectDbtModel } from './local-runtime.js';

const model = (name: string, extra: Record<string, unknown> = {}) => ({
  resource_type: 'model', name, alias: name, schema: 'main', relation_name: `"main"."${name}"`,
  original_file_path: `models/${name}.sql`, config: { materialized: 'table' }, depends_on: { nodes: [] }, columns: {}, ...extra,
});
const relationshipsTest = (from: string, column: string, to: string, field: string) => ({
  resource_type: 'test', name: `relationships_${from}_${column}`, attached_node: `model.shop.${from}`, column_name: column,
  depends_on: { nodes: [`model.shop.${to}`, `model.shop.${from}`] },
  test_metadata: { name: 'relationships', kwargs: { column_name: column, field, to: `ref('${to}')` } },
});
const MANIFEST = {
  metadata: { project_name: 'shop' },
  nodes: {
    'model.shop.customers': model('customers', { original_file_path: 'models/marts/customers.sql' }),
    'model.shop.orders': model('orders', { original_file_path: 'models/marts/orders.sql', compiled_code: 'select o.order_id, o.customer_id, o.amount from main.stg_orders o' }),
    'model.shop.stg_orders': model('stg_orders', { original_file_path: 'models/staging/stg_orders.sql', config: { materialized: 'view' } }),
    'model.shop.helper': model('helper', { config: { materialized: 'ephemeral' } }),
    'test.shop.orders_customer': relationshipsTest('orders', 'customer_id', 'customers', 'customer_id'),
  },
  sources: {},
  exposures: {},
  groups: {},
  semantic_models: {},
};

describe('a dbt project’s relations in the warehouse', () => {
  it('reads the nodes dbt builds, keys the warehouse relations by them, and declares its relationships tests', () => {
    const nodes = dbtWarehouseNodes(MANIFEST);
    expect(nodes.map((node) => node.uniqueId)).toEqual(['model.shop.customers', 'model.shop.orders', 'model.shop.stg_orders']);
    expect(nodes.find((node) => node.uniqueId === 'model.shop.orders')).toMatchObject({ relation: 'main.orders', schema: 'main', sql: expect.stringContaining('from main.stg_orders') });
    expect(dbtWarehouseScopes(nodes, 'main')).toEqual([{ catalogOrDatabase: 'main', schemas: ['main'] }]);

    const relation = (name: string, columns: string[], extra: Partial<WarehouseCatalogRelationV1> = {}): WarehouseCatalogRelationV1 => ({
      id: warehouseRelationId({ schema: 'main', name }), schema: 'main', name, relation: `main.${name}`, kind: 'table', columns: columns.map((column) => ({ name: column, type: 'INTEGER' })), ...extra,
    });
    const snapshot = dbtModelSnapshot({
      dbtManifest: MANIFEST,
      relations: [relation('customers', ['customer_id']), relation('orders', ['order_id', 'customer_id', 'amount']), relation('stray', ['id'])],
      driver: 'sqlite', connectionId: 'default', scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }],
    });
    expect(snapshot.relations.map((item) => item.id)).toEqual(['model.shop.customers', 'model.shop.orders']);
    expect(snapshot.relations.find((item) => item.id === 'model.shop.orders')).toMatchObject({
      viewSql: expect.stringContaining('from main.stg_orders'),
      foreignKeys: [{ name: 'a dbt relationships test', columns: ['customer_id'], references: { relation: 'main.customers', columns: ['customer_id'] } }],
    });
  });
});

describe('zlens model discover --validate in a dbt-first project', () => {
  const roots: string[] = [];
  const executors: QueryExecutor[] = [];
  afterEach(async () => {
    for (const executor of executors.splice(0)) await executor.disconnect().catch(() => undefined);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('drafts the model from dbt and the warehouse, binds it with dbt_model, and applies as a valid draft', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-model-'));
    roots.push(projectRoot);
    const db = new Database(join(projectRoot, 'shop.sqlite'));
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER, name TEXT);
      CREATE TABLE orders (order_id INTEGER, customer_id INTEGER, amount INTEGER);
      CREATE VIEW stg_orders AS SELECT order_id, customer_id, amount FROM orders;
    `);
    for (let customer = 1; customer <= 20; customer += 1) db.prepare('INSERT INTO customers VALUES (?, ?)').run(customer, `C${customer}`);
    for (let order = 1; order <= 60; order += 1) db.prepare('INSERT INTO orders VALUES (?, ?, ?)').run(order, 1 + (order % 20), order * 3);
    db.close();
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify(MANIFEST));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' },
      connections: { default: { driver: 'sqlite', filepath: './shop.sqlite' } },
      dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
    }));
    const executor = new QueryExecutor();
    executors.push(executor);

    const report = await discoverProjectDbtModel(projectRoot, { executor });
    expect(report.validated).toBe(true);
    expect(report.domains).toEqual([{ id: 'shop', name: 'Shop', existing: false }]);
    expect(report.entities.map((entity) => entity.relationId).sort()).toEqual(['model.shop.customers', 'model.shop.orders', 'model.shop.stg_orders']);
    // The staging view only renames orders: the draft says to use orders.
    expect(report.entities.find((entity) => entity.relationId === 'model.shop.stg_orders')).toMatchObject({ layer: 'staging', useInstead: { relation: 'main.orders' } });
    const orderJoin = report.relationships.find((item) => item.fromRelation === 'main.orders' && item.toRelation === 'main.customers')!;
    expect(orderJoin).toMatchObject({ keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', validation: { status: 'passed' } });
    expect(orderJoin.evidence.map((item) => item.reason).join(' ')).toContain('a dbt relationships test');

    applyProjectWarehouseDiscovery(projectRoot, report);
    const modelFile = readFileSync(join(projectRoot, 'domains', 'shop', 'modeling', 'model.dql.yaml'), 'utf8');
    expect(modelFile).toContain('dbt_model: model.shop.orders');
    expect(modelFile).not.toContain('relation:');
    const manifest = buildManifest({ projectRoot, dbtManifestPath: join(projectRoot, 'target', 'manifest.json') });
    expect(manifest.diagnostics?.filter((item) => item.severity === 'error')).toEqual([]);
    expect(Object.values(manifest.modeling?.entities ?? {}).find((entity) => entity.dbtUniqueId === 'model.shop.stg_orders')?.useInstead).toMatchObject({ entity: expect.stringMatching(/::entity::order$/) });
  });
});
