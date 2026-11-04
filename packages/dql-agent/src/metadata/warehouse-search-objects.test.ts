import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { relationColumnsFingerprint, writeMeaningFile, type DQLManifest } from '@zlens/core';
import { buildMetadataSnapshot, dbtMeaningCatalog, dbtMeaningRelations, defaultMetadataPath, MetadataCatalog, recordRuntimeSchemaSnapshot, SCHEMA_SYNC_SOURCE } from './catalog.js';

const relations = [
  { id: 'warehouse.sales.invoicelines', schema: 'sales', name: 'invoicelines', relation: 'sales.invoicelines', kind: 'table', comment: 'One line of an invoice', columns: [{ name: 'extendedprice', type: 'numeric', comment: 'Line total with tax' }, { name: 'taxamount', type: 'numeric' }] },
  { id: 'warehouse.sales.customers', schema: 'sales', name: 'customers', relation: 'sales.customers', kind: 'table', columns: [{ name: 'customerid', type: 'integer' }] },
  { id: 'warehouse.website.customers', schema: 'website', name: 'customers', relation: 'website.customers', kind: 'view', columns: [{ name: 'buyinggroupname', type: 'text' }] },
];

function manifestFor(): DQLManifest {
  return {
    manifestVersion: 3,
    generatedAt: '2026-11-02T00:00:00.000Z',
    blocks: {},
    notebooks: {},
    metrics: {},
    dimensions: {},
    domains: {},
    sources: {},
    dashboards: {},
    apps: {},
    dbtProvenance: {
      manifestPath: '', manifestFingerprint: 'none', metricFlow: {},
      warehouseCatalogPath: '.dql/warehouse-catalog.json', warehouseCatalogFingerprint: 'test',
      nodes: Object.fromEntries(relations.map((relation) => [relation.id, { uniqueId: relation.id, resourceType: 'warehouse', name: relation.name, relation: relation.relation, identityFingerprint: relation.id, available: { description: false, columns: true, tests: false, catalogTypes: true, dqlMeta: false } }])),
    },
  } as unknown as DQLManifest;
}

describe('what search knows about a warehouse table', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'warehouse-search-'));
    mkdirSync(join(root, '.dql'), { recursive: true });
    writeFileSync(join(root, '.dql', 'warehouse-catalog.json'), JSON.stringify({ version: 1, driver: 'postgres', connectionId: 'default', scopes: [], relations, capturedAt: 'now', fingerprint: 'test' }));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const search = (query: string): string[] => {
    const snapshot = buildMetadataSnapshot(root, manifestFor(), undefined, []);
    const catalog = new MetadataCatalog(join(root, 'search.sqlite'));
    try {
      catalog.rebuild(snapshot);
      return catalog.searchObjects({ query, objectTypes: ['warehouse_table'] }).map((object) => String(object.payload?.relation));
    } finally {
      catalog.close();
    }
  };

  // A project opts in by keeping meaning files; one about another table will do.
  const optIn = () => {
    const relation = relations[2]!;
    writeMeaningFile(root, { version: 1, id: relation.id, relation: relation.relation, columnsFingerprint: relationColumnsFingerprint(relation), table: { description: 'Customers as the website sees them.', source: 'person' }, columns: {} });
  };

  it('a project with no meaning files keeps the search it had', () => {
    expect(search('taxamount')).toEqual([]);
    expect(search('total with tax')).toEqual([]);
  });

  it('finds a table by a column it holds', () => {
    optIn();
    expect(search('taxamount')).toEqual(['sales.invoicelines']);
  });

  it("finds a table by the warehouse's own comments", () => {
    optIn();
    expect(search('invoice line')).toContain('sales.invoicelines');
    expect(search('total with tax')).toContain('sales.invoicelines');
  });

  it('keeps two tables of the same name apart', () => {
    for (const relation of relations.slice(1)) writeMeaningFile(root, { version: 1, id: relation.id, relation: relation.relation, columnsFingerprint: relationColumnsFingerprint(relation), table: { description: `About ${relation.relation}`, source: 'person' }, columns: {} });
    expect(search('customerid')).toEqual(['sales.customers']);
    expect(search('buyinggroupname')).toEqual(['website.customers']);
  });

  it('a table nothing describes keeps the entry it had', () => {
    optIn();
    expect(search('customerid')).toEqual([]);
  });

  it('finds a table through a drafted description and other name, labelled as a draft', () => {
    const relation = relations[1]!;
    expect(search('accounts')).toEqual([]);
    writeMeaningFile(root, {
      version: 1, id: relation.id, relation: relation.relation, columnsFingerprint: relationColumnsFingerprint(relation),
      table: { description: 'One store or buying group that places orders.', source: 'ai', otherNames: ['accounts'] }, columns: {},
    });
    expect(search('accounts')).toEqual(['sales.customers']);
    const snapshot = buildMetadataSnapshot(root, manifestFor(), undefined, []);
    expect(snapshot.objects.find((object) => object.payload?.relation === 'sales.customers')?.description).toBe('AI draft: One store or buying group that places orders.');
  });

  it('a stale draft is out of search, and the index changes with the file', () => {
    const relation = relations[1]!;
    const before = buildMetadataSnapshot(root, manifestFor(), undefined, []).fingerprint;
    writeMeaningFile(root, { version: 1, id: relation.id, relation: relation.relation, columnsFingerprint: 'old', table: { description: 'Drafted against other columns', source: 'ai', otherNames: ['accounts'] }, columns: {} });
    expect(search('accounts')).toEqual([]);
    writeMeaningFile(root, { version: 1, id: relation.id, relation: relation.relation, columnsFingerprint: relationColumnsFingerprint(relation), table: { description: 'Now current', source: 'ai' }, columns: {} });
    expect(buildMetadataSnapshot(root, manifestFor(), undefined, []).fingerprint).not.toBe(before);
  });
});

describe('what dbt leaves blank', () => {
  let root: string;
  const manifestPath = () => join(root, 'target', 'manifest.json');
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dbt-meanings-'));
    mkdirSync(join(root, 'target'), { recursive: true });
    writeFileSync(manifestPath(), JSON.stringify({
      nodes: {
        'model.shop.orders': { resource_type: 'model', name: 'orders', alias: 'orders', schema: 'analytics', database: 'shop', relation_name: '"shop"."analytics"."orders"', description: '', columns: { order_id: { name: 'order_id', description: 'The order key', data_type: 'integer' } } },
        'model.shop.customers': { resource_type: 'model', name: 'customers', schema: 'analytics', database: 'shop', description: 'One row per customer.', columns: {} },
        'test.shop.not_null': { resource_type: 'test', name: 'not_null' },
      },
      sources: { 'source.shop.raw.payments': { resource_type: 'source', name: 'payments', schema: 'raw', database: 'shop', columns: {} } },
    }));
    writeFileSync(join(root, 'target', 'catalog.json'), JSON.stringify({ nodes: { 'model.shop.orders': { columns: { ORDER_ID: { name: 'order_id', type: 'integer' }, AMOUNT: { name: 'amount', type: 'numeric' } } } }, sources: {} }));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('lists models and sources, with catalog columns and what dbt wrote', () => {
    const relations = dbtMeaningRelations(manifestPath());
    expect(relations.map((relation) => relation.id)).toEqual(['dbt.model.shop.orders', 'dbt.model.shop.customers', 'dbt.source.shop.raw.payments']);
    expect(relations[0]).toMatchObject({ relation: 'shop.analytics.orders', columns: [{ name: 'order_id', type: 'integer', comment: 'The order key' }, { name: 'amount', type: 'numeric' }] });
    expect(relations[1]?.comment).toBe('One row per customer.');
  });

  it('without catalog.json, takes the columns from the schema ZLens synced', () => {
    rmSync(join(root, 'target', 'catalog.json'));
    expect(dbtMeaningCatalog(manifestPath(), root).columnsUnlisted).toEqual(['shop.analytics.orders', 'shop.analytics.customers', 'shop.raw.payments']);
    expect(existsSync(defaultMetadataPath(root))).toBe(false);
    recordRuntimeSchemaSnapshot(root, {
      generationId: 'g1',
      source: SCHEMA_SYNC_SOURCE,
      connectionId: 'default',
      tables: [
        // As a DuckDB sync spells it: no database in the name, and the file's name as the database.
        { relation: 'analytics.orders', catalogOrDatabase: 'shop_copy', schema: 'analytics', name: 'orders', columns: [{ name: 'order_id', type: 'INTEGER' }, { name: 'amount', type: 'DECIMAL' }] },
        // Another database's copy, named with its database: the database has to agree.
        { relation: 'archive.raw.payments', catalogOrDatabase: 'archive', schema: 'raw', name: 'payments', columns: [{ name: 'payment_id', type: 'INTEGER' }] },
        { relation: 'analytics.customers', schema: 'analytics', name: 'customers', columns: [{ name: 'customer_id', type: 'INTEGER', sampleValues: ['never sent'] }] },
      ],
    });
    const catalog = dbtMeaningCatalog(manifestPath(), root);
    expect(catalog.relations[0]?.columns).toEqual([{ name: 'order_id', type: 'INTEGER', comment: 'The order key' }, { name: 'amount', type: 'DECIMAL' }]);
    expect(catalog.relations[1]?.columns).toEqual([{ name: 'customer_id', type: 'INTEGER' }]);
    expect(catalog.relations[2]?.columns).toEqual([]);
    expect(catalog.columnsUnlisted).toEqual(['shop.raw.payments']);
    // Without the project, only what dbt documents.
    expect(dbtMeaningRelations(manifestPath())[0]?.columns).toEqual([{ name: 'order_id', type: 'integer', comment: 'The order key' }]);
  });

  it('a name two databases share, with nothing to tell them apart, lists nothing', () => {
    rmSync(join(root, 'target', 'catalog.json'));
    writeFileSync(manifestPath(), JSON.stringify({ nodes: { 'model.shop.orders': { resource_type: 'model', name: 'orders', schema: 'analytics', columns: {} } }, sources: {} }));
    recordRuntimeSchemaSnapshot(root, {
      generationId: 'g2',
      source: SCHEMA_SYNC_SOURCE,
      connectionId: 'default',
      // As a Snowflake sync spells them: the database is part of the name.
      tables: [
        { relation: 'SHOP.ANALYTICS.ORDERS', catalogOrDatabase: 'SHOP', schema: 'ANALYTICS', name: 'ORDERS', columns: [{ name: 'ORDER_ID' }] },
        { relation: 'ARCHIVE.ANALYTICS.ORDERS', catalogOrDatabase: 'ARCHIVE', schema: 'ANALYTICS', name: 'ORDERS', columns: [{ name: 'LEGACY_ID' }] },
      ],
    });
    expect(dbtMeaningCatalog(manifestPath(), root)).toMatchObject({ relations: [{ columns: [] }], columnsUnlisted: ['analytics.orders'] });
  });

  it("reads the schema sync, never a partial snapshot Ask records after it, and keeps the sync however many come", () => {
    rmSync(join(root, 'target', 'catalog.json'));
    const sync = { relation: 'analytics.orders', schema: 'analytics', name: 'orders', columns: [{ name: 'order_id', type: 'INTEGER' }, { name: 'amount', type: 'DECIMAL' }] };
    recordRuntimeSchemaSnapshot(root, { generationId: 'sync-1', source: SCHEMA_SYNC_SOURCE, connectionId: 'default', capturedAt: '2026-11-03T00:00:00.000Z', tables: [sync] });
    for (let index = 0; index < 60; index += 1) {
      recordRuntimeSchemaSnapshot(root, { source: 'agent schema context', status: 'partial', capturedAt: `2026-11-04T00:00:${String(index).padStart(2, '0')}.000Z`, tables: [{ relation: 'analytics.orders', schema: 'analytics', name: 'orders', columns: [{ name: 'order_id' }] }] });
    }
    expect(dbtMeaningCatalog(manifestPath(), root).relations[0]?.columns.map((column) => column.name)).toEqual(['order_id', 'amount']);
  });

  it('with syncs of two connections, reads the default connection\'s', () => {
    rmSync(join(root, 'target', 'catalog.json'));
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ defaultConnectionName: 'warehouse', connections: { warehouse: { driver: 'duckdb' }, other: { driver: 'duckdb' } } }));
    recordRuntimeSchemaSnapshot(root, { generationId: 'w', source: SCHEMA_SYNC_SOURCE, connectionId: 'warehouse', capturedAt: '2026-11-03T00:00:00.000Z', tables: [{ relation: 'analytics.orders', schema: 'analytics', name: 'orders', columns: [{ name: 'order_id' }, { name: 'amount' }] }] });
    recordRuntimeSchemaSnapshot(root, { generationId: 'o', source: SCHEMA_SYNC_SOURCE, connectionId: 'other', capturedAt: '2026-11-04T00:00:00.000Z', tables: [{ relation: 'analytics.orders', schema: 'analytics', name: 'orders', columns: [{ name: 'other_id' }] }] });
    expect(dbtMeaningCatalog(manifestPath(), root).relations[0]?.columns.map((column) => column.name)).toEqual(['order_id', 'amount']);
  });

  it('leaves out an ephemeral model: nothing can query it', () => {
    writeFileSync(manifestPath(), JSON.stringify({ nodes: { 'model.shop.stage': { resource_type: 'model', name: 'stage', schema: 'analytics', config: { materialized: 'ephemeral' }, columns: {} } }, sources: {} }));
    expect(dbtMeaningCatalog(manifestPath(), root)).toEqual({ relations: [], columnsUnlisted: [] });
  });

  it('sees a catalog.json built after the manifest', () => {
    rmSync(join(root, 'target', 'catalog.json'));
    expect(dbtMeaningRelations(manifestPath())[0]?.columns).toHaveLength(1);
    writeFileSync(join(root, 'target', 'catalog.json'), JSON.stringify({ nodes: { 'model.shop.orders': { columns: { ORDER_ID: { name: 'order_id', type: 'integer' }, AMOUNT: { name: 'amount', type: 'numeric' } } } }, sources: {} }));
    expect(dbtMeaningRelations(manifestPath())[0]?.columns).toHaveLength(2);
  });

  it('sees a manifest that changed', () => {
    expect(dbtMeaningRelations(manifestPath())).toHaveLength(3);
    writeFileSync(manifestPath(), JSON.stringify({ nodes: {}, sources: {} }));
    expect(dbtMeaningRelations(manifestPath())).toEqual([]);
  });

  it("a draft fills a dbt model's gaps in search and never replaces dbt's words", () => {
    const [orders, customers] = dbtMeaningRelations(manifestPath());
    writeMeaningFile(root, {
      version: 1, id: orders!.id, relation: orders!.relation, columnsFingerprint: relationColumnsFingerprint(orders!),
      table: { description: 'One row per order.', source: 'ai', otherNames: ['sales'] },
      columns: { amount: { description: 'What the order came to', source: 'ai' }, order_id: { description: 'Must lose to dbt', source: 'ai' } },
    });
    writeMeaningFile(root, {
      version: 1, id: customers!.id, relation: customers!.relation, columnsFingerprint: relationColumnsFingerprint(customers!),
      table: { description: 'Must lose to dbt', source: 'ai' }, columns: {},
    });
    const manifest = { manifestVersion: 3, generatedAt: '2026-11-02T00:00:00.000Z', blocks: {}, notebooks: {}, metrics: {}, dimensions: {}, domains: {}, sources: {}, dashboards: {}, apps: {}, dbtImport: { manifestPath: manifestPath() } } as unknown as DQLManifest;
    const objects = buildMetadataSnapshot(root, manifest, undefined, []).objects;
    const find = (name: string) => objects.find((object) => object.objectType === 'dbt_model' && object.name === name)!;
    expect(find('orders').description).toBe('AI draft: One row per order.');
    expect(find('orders').payload?.aliases).toContain('sales');
    expect(find('customers').description).toBe('One row per customer.');
    expect(find('orders').payload?.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'amount', description: 'AI draft: What the order came to' }),
    ]));
    expect(objects.find((object) => object.objectKey === 'dbt:column:orders.order_id')?.description ?? '').not.toContain('Must lose');
    expect(objects.find((object) => object.objectKey === 'dbt:column:orders.amount')?.description).toBe('AI draft: What the order came to');
  });
});
