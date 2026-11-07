import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildManifest, warehouseRelationId, type WarehouseCatalogRelationV1 } from '@zlens/core';
import { QueryExecutor } from '@zlens/connectors';
import { dbtModelSnapshot, dbtWarehouseNodes, dbtWarehouseScopes } from './dbt-model-discovery.js';
import { applyProjectWarehouseDiscovery, discoverProjectDbtModel, discoverProjectWarehouseModel, syncProjectWarehouse } from './local-runtime.js';
import { runModel } from './commands/model.js';
import type { CLIFlags } from './args.js';

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

describe('a dbt-duckdb project\'s external sources', () => {
  it('are their dbt_sources tables; a location ZLens cannot read is no warehouse relation', () => {
    const nodes = dbtWarehouseNodes({
      metadata: { adapter_type: 'duckdb' },
      nodes: {},
      sources: {
        'source.shop.raw.orders': { resource_type: 'source', source_name: 'raw', name: 'orders', identifier: 'orders', schema: 'raw', database: 'shop', relation_name: "'s3://lake/raw/orders.parquet'" },
        'source.shop.raw.customers': { resource_type: 'source', source_name: 'raw', name: 'customers', schema: 'raw', database: 'shop', relation_name: "read_csv('s3://lake/raw/customers.csv', header = true)" },
        'source.shop.raw.many': { resource_type: 'source', source_name: 'raw', name: 'many', schema: 'raw', database: 'shop', relation_name: "read_parquet(['s3://a/1.parquet', 's3://a/2.parquet'])" },
        'source.shop.app.users': { resource_type: 'source', source_name: 'app', name: 'users', schema: 'main', database: 'shop', relation_name: '"shop"."main"."users"' },
      },
    });
    expect(nodes.map(({ uniqueId, relation, database, schema }) => ({ uniqueId, relation, database, schema }))).toEqual([
      { uniqueId: 'source.shop.app.users', relation: 'shop.main.users', database: 'shop', schema: 'main' },
      { uniqueId: 'source.shop.raw.customers', relation: 'dbt_sources.raw.customers', database: 'dbt_sources', schema: 'raw' },
      { uniqueId: 'source.shop.raw.orders', relation: 'dbt_sources.raw.orders', database: 'dbt_sources', schema: 'raw' },
    ]);
  });
});

describe('zlens model discover --validate in a dbt-first project', () => {
  const roots: string[] = [];
  const executors: QueryExecutor[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const executor of executors.splice(0)) await executor.disconnect().catch(() => undefined);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const shop = () => {
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
    return projectRoot;
  };

  it('zlens model draft shows the drafted model by group, and --apply --passed-only writes what passed', async () => {
    const projectRoot = shop();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { logs.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runModel('draft', [projectRoot], {} as CLIFlags);
    const text = logs.join('\n');
    expect(text).toContain('ZLens model draft (checked on the warehouse; nothing is written without --apply)');
    expect(text).toContain('2 tables to answer from · 0 with a better table to use instead · 1 join (1 passed)');
    // The staging view is left out by name, as discovery always has, and the review says so.
    expect(text).toContain('Staging copies left out');
    expect(text).toContain('main.stg_orders · same as main.orders');
    expect(text).toMatch(/✓ order → customer on customer_id · many_to_one/);
    expect(existsSync(join(projectRoot, 'domains'))).toBe(false);

    logs.length = 0;
    await runModel('draft', [projectRoot, '--passed-only'], { apply: true } as CLIFlags);
    expect(logs.join('\n')).toContain('ZLens model draft apply');
    const manifest = buildManifest({ projectRoot, dbtManifestPath: join(projectRoot, 'target', 'manifest.json') });
    expect(manifest.diagnostics?.filter((item) => item.severity === 'error')).toEqual([]);
    expect(Object.values(manifest.modeling?.relationships ?? {}).every((relationship) => relationship.validation?.status === 'passed')).toBe(true);
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

// Two subject areas and a Shared table (model-at-scale design S1, S4): a
// marketing mart and a sales mart in one compound Domain, both reading an
// account table that sits in a shared-dimensions folder.
describe('zlens model draft places tables in subject areas', () => {
  const roots: string[] = [];
  const executors: QueryExecutor[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const executor of executors.splice(0)) await executor.disconnect().catch(() => undefined);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const reads = (...names: string[]) => ({ depends_on: { nodes: names.map((name) => `model.shop.${name}`) } });
  const AREAS_MANIFEST = {
    metadata: { project_name: 'shop' },
    nodes: {
      'model.shop.dim_account': model('dim_account', { original_file_path: 'models/common/dimensions_shared/dim_account.sql' }),
      'model.shop.fct_opportunity': model('fct_opportunity', { original_file_path: 'models/common/facts_sales_and_marketing/fct_opportunity.sql', ...reads('dim_account') }),
      'model.shop.mart_pipeline': model('mart_pipeline', { original_file_path: 'models/common_mart_sales/mart_pipeline.sql', ...reads('fct_opportunity') }),
      'model.shop.mart_campaign': model('mart_campaign', { original_file_path: 'models/common_mart_marketing/mart_campaign.sql', ...reads('dim_account') }),
      'test.shop.opportunity_account': relationshipsTest('fct_opportunity', 'account_id', 'dim_account', 'account_id'),
      'test.shop.pipeline_opportunity': relationshipsTest('mart_pipeline', 'opportunity_id', 'fct_opportunity', 'opportunity_id'),
      'test.shop.campaign_account': relationshipsTest('mart_campaign', 'account_id', 'dim_account', 'account_id'),
    },
    sources: {},
    exposures: {},
    groups: {},
    semantic_models: {},
  };

  const shop = () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-dbt-areas-'));
    roots.push(projectRoot);
    const db = new Database(join(projectRoot, 'shop.sqlite'));
    db.exec(`
      CREATE TABLE dim_account (account_id INTEGER, account_name TEXT);
      CREATE TABLE fct_opportunity (opportunity_id INTEGER, account_id INTEGER, amount INTEGER);
      CREATE TABLE mart_pipeline (opportunity_id INTEGER, stage TEXT, amount INTEGER);
      CREATE TABLE mart_campaign (campaign_id INTEGER, account_id INTEGER, spend INTEGER);
    `);
    for (let account = 1; account <= 20; account += 1) db.prepare('INSERT INTO dim_account VALUES (?, ?)').run(account, `A${account}`);
    for (let opportunity = 1; opportunity <= 60; opportunity += 1) {
      db.prepare('INSERT INTO fct_opportunity VALUES (?, ?, ?)').run(opportunity, 1 + (opportunity % 20), opportunity * 10);
      db.prepare('INSERT INTO mart_pipeline VALUES (?, ?, ?)').run(opportunity, opportunity % 2 ? 'open' : 'won', opportunity * 10);
    }
    for (let campaign = 1; campaign <= 30; campaign += 1) db.prepare('INSERT INTO mart_campaign VALUES (?, ?, ?)').run(campaign, 1 + (campaign % 20), campaign * 5);
    db.close();
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify(AREAS_MANIFEST));
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop', manifestVersion: 3, modeling: { mode: 'dbt-first' },
      connections: { default: { driver: 'sqlite', filepath: './shop.sqlite' } },
      dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
    }));
    const executor = new QueryExecutor();
    executors.push(executor);
    return { projectRoot, executor };
  };
  const built = (projectRoot: string) => buildManifest({ projectRoot, dbtManifestPath: join(projectRoot, 'target', 'manifest.json') });
  const entityOf = (projectRoot: string, dbtUniqueId: string) => Object.values(built(projectRoot).modeling?.entities ?? {}).find((entity) => entity.dbtUniqueId === dbtUniqueId);

  it('drafts each table into its area and the account table into the Shared area', async () => {
    const { projectRoot, executor } = shop();
    const report = await discoverProjectDbtModel(projectRoot, { executor });
    const areaOf = (id: string) => report.entities.find((entity) => entity.relationId === id)?.area;
    expect(areaOf('model.shop.dim_account')).toBe('shared');
    expect(areaOf('model.shop.mart_pipeline')).toBe('sales');
    expect(areaOf('model.shop.mart_campaign')).toBe('marketing');
    // A table of the compound Domain with no part named stays in the default area.
    expect(areaOf('model.shop.fct_opportunity')).toBeUndefined();
    expect(report.areas?.map((area) => [area.domain, area.id, area.shared ?? false])).toEqual([
      ['sales_and_marketing', 'marketing', false],
      ['sales_and_marketing', 'sales', false],
      ['shared', 'shared', true],
    ]);
    // Each area shows the tables of other areas its joins reach at its edge.
    expect(report.areas?.find((area) => area.id === 'marketing')?.references).toEqual([expect.stringMatching(/^shared::entity::/)]);

    applyProjectWarehouseDiscovery(projectRoot, report);
    const manifest = built(projectRoot);
    expect(manifest.diagnostics?.filter((item) => item.severity === 'error')).toEqual([]);
    const areas = Object.values(manifest.modeling?.areas ?? {});
    expect(areas.find((area) => area.localId === 'shared')).toMatchObject({ shared: true, name: 'Shared' });
    expect(areas.find((area) => area.localId === 'sales')?.entityIds).toEqual([expect.stringMatching(/::entity::/)]);
    expect(entityOf(projectRoot, 'model.shop.mart_campaign')?.areaId).toMatch(/marketing$/);
    expect(existsSync(join(projectRoot, 'domains', 'shared', 'modeling', 'areas', 'shared.dql.yaml'))).toBe(true);
  });

  it('drafts one area at a time: later runs reuse the Shared tables, draft joins to them, and list joins left for later', async () => {
    const { projectRoot, executor } = shop();
    // Marketing first: its mart and the account table it reads.
    const marketing = await discoverProjectDbtModel(projectRoot, { executor, scope: { select: ['area:marketing'] } });
    expect(marketing.entities.map((entity) => entity.relationId).sort()).toEqual(['model.shop.dim_account', 'model.shop.mart_campaign']);
    applyProjectWarehouseDiscovery(projectRoot, marketing);
    const accountId = entityOf(projectRoot, 'model.shop.dim_account')!.qualifiedId;

    // Then only the opportunity fact: the account table is already modeled,
    // so it is read for the join and not drafted again; the pipeline mart is
    // not modeled yet, so its declared join waits for its own run.
    const opportunity = await discoverProjectDbtModel(projectRoot, { executor, scope: { select: ['fct_opportunity'] } });
    expect(opportunity.scope).toMatchObject({ drafted: 1, context: 1, outside: [{ from: 'main.mart_pipeline', to: 'main.fct_opportunity', column: 'opportunity_id' }] });
    expect(opportunity.entities.filter((entity) => !entity.existing).map((entity) => entity.relationId)).toEqual(['model.shop.fct_opportunity']);
    const toAccount = opportunity.relationships.find((relationship) => relationship.fromRelation === 'main.fct_opportunity' && relationship.toRelation === 'main.dim_account');
    expect(toAccount).toMatchObject({ toDomain: 'shared', validation: { status: 'passed' } });
    applyProjectWarehouseDiscovery(projectRoot, opportunity);
    const manifest = built(projectRoot);
    expect(manifest.diagnostics?.filter((item) => item.severity === 'error')).toEqual([]);
    expect(entityOf(projectRoot, 'model.shop.dim_account')!.qualifiedId).toBe(accountId);
    expect(Object.values(manifest.modeling?.relationships ?? {}).some((relationship) => relationship.to === accountId)).toBe(true);

    // And the CLI says what it read and what it left.
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { logs.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runModel('draft', [projectRoot, '--select', 'area:sales'], {} as CLIFlags);
    const text = logs.join('\n');
    expect(text).toContain('Scope: area:sales');
    expect(text).toContain('Areas: sales_and_marketing/sales: 1 table');
    expect(text).toMatch(/Also read \d+ tables? other areas already model/);
  });
});

// A hybrid project: the dbt shop, and a refunds table in the same warehouse
// that dbt does not build (a loader's table).
describe('a hybrid project drafts its warehouse tables beside its dbt models', () => {
  const roots: string[] = [];
  const executors: QueryExecutor[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const executor of executors.splice(0)) await executor.disconnect().catch(() => undefined);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('never drafts a dbt table twice, leaves unmodeled dbt tables to the dbt draft, and drafts the join across', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-hybrid-'));
    roots.push(projectRoot);
    const db = new Database(join(projectRoot, 'shop.sqlite'));
    db.exec(`
      CREATE TABLE customers (customer_id INTEGER, name TEXT);
      CREATE TABLE orders (order_id INTEGER, customer_id INTEGER, amount INTEGER);
      CREATE VIEW stg_orders AS SELECT order_id, customer_id, amount FROM orders;
      CREATE TABLE refunds (refund_id INTEGER, order_id INTEGER, refunded INTEGER);
    `);
    for (let customer = 1; customer <= 20; customer += 1) db.prepare('INSERT INTO customers VALUES (?, ?)').run(customer, `C${customer}`);
    for (let order = 1; order <= 60; order += 1) db.prepare('INSERT INTO orders VALUES (?, ?, ?)').run(order, 1 + (order % 20), order * 3);
    for (let refund = 1; refund <= 12; refund += 1) db.prepare('INSERT INTO refunds VALUES (?, ?, ?)').run(refund, refund * 4, refund);
    db.close();
    mkdirSync(join(projectRoot, 'target'), { recursive: true });
    writeFileSync(join(projectRoot, 'target', 'manifest.json'), JSON.stringify(MANIFEST));
    const config = (mode: string) => JSON.stringify({
      project: 'shop', manifestVersion: 3, modeling: { mode },
      connections: { default: { driver: 'sqlite', filepath: './shop.sqlite' } },
      dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
    });
    writeFileSync(join(projectRoot, 'dql.config.json'), config('dbt-first'));
    const executor = new QueryExecutor();
    executors.push(executor);
    // The dbt side first, orders and customers only: stg_orders stays unmodeled.
    applyProjectWarehouseDiscovery(projectRoot, await discoverProjectDbtModel(projectRoot, { executor, scope: { select: ['orders', 'customers'] } }));

    // Then hybrid, with the warehouse's schema synced: dbt's tables stay in Ask's scope.
    writeFileSync(join(projectRoot, 'dql.config.json'), config('hybrid'));
    await syncProjectWarehouse(projectRoot, { schemas: ['main'], database: 'main', executor });
    expect(JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf8')).metadataScopes.default.mode).toBe('dbt_plus_selected');

    const report = await discoverProjectWarehouseModel(projectRoot, { validate: true, executor });
    const fresh = report.entities.filter((entity) => !entity.existing);
    // Only the table dbt does not build is drafted; the modeled dbt tables are read as the model's.
    expect(fresh.map((entity) => entity.relation)).toEqual(['main.refunds']);
    expect(report.entities.filter((entity) => entity.existing).map((entity) => entity.relationId).sort()).toEqual(['model.shop.customers', 'model.shop.orders']);
    expect(report.dbtLeftOut).toEqual(['main.stg_orders']);
    // The join from the warehouse table to the dbt model is drafted and checked on the data.
    const refundToOrder = report.relationships.find((relationship) => relationship.fromRelation === 'main.refunds' && relationship.toRelation === 'main.orders');
    expect(refundToOrder).toMatchObject({ keys: [{ from: 'order_id', to: 'order_id' }], validation: { status: 'passed' } });

    applyProjectWarehouseDiscovery(projectRoot, report);
    const manifest = buildManifest({ projectRoot, dbtManifestPath: join(projectRoot, 'target', 'manifest.json') });
    expect(manifest.diagnostics?.filter((item) => item.severity === 'error')).toEqual([]);
    const entities = Object.values(manifest.modeling?.entities ?? {});
    // One orders entity, bound by dbt; refunds bound by its relation.
    expect(entities.filter((entity) => entity.dbtUniqueId === 'model.shop.orders')).toHaveLength(1);
    expect(entities.find((entity) => entity.relation === 'main.refunds')).toBeDefined();
    expect(Object.values(manifest.modeling?.relationships ?? {}).some((relationship) => String(relationship.to).endsWith('order'))).toBe(true);
  });
});
