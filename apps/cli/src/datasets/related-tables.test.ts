import { describe, expect, it } from 'vitest';
import { datasetFieldForFilter, type DatasetDescriptor, type DQLManifest } from '@zlens/core';
import {
  datasetBaseRelation,
  decorateDatasetDescriptor,
  joinableTables,
  joinRepeatsKeyMessage,
  joinUniquenessSql,
  relatedTablesContext,
  relationSql,
} from './related-tables.js';

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function node(uniqueId: string, name: string, relation: string) {
  return { uniqueId, resourceType: 'warehouse' as const, name, relation, identityFingerprint: 'x', available: { description: false, columns: true, tests: false, catalogTypes: true, dqlMeta: false } };
}

const passed = (overrides: Record<string, unknown> = {}) => ({
  status: 'passed' as const, checkedAt: '2026-10-20T00:00:00Z', queryFingerprint: 'q', proofFingerprint: 'p',
  fromRows: 10, toRows: 3, joinedRows: 10, fromNullKeys: 0, toNullKeys: 0, unmatchedFrom: 0, maxFromPerKey: 4, maxToPerKey: 1,
  ...overrides,
});

const manifest = {
  dbtProvenance: {
    manifestPath: '', manifestFingerprint: '', metricFlow: {},
    nodes: {
      'warehouse.main.orders': node('warehouse.main.orders', 'orders', 'main.orders'),
      'warehouse.main.customers': node('warehouse.main.customers', 'customers', 'main.customers'),
      'warehouse.main.locations': node('warehouse.main.locations', 'locations', 'main.locations'),
    },
  },
  modeling: {
    entities: {
      'shop::entity::orders': { id: 'shop::entity::orders', localId: 'orders', qualifiedId: 'shop::entity::orders', domain: 'shop', dbtUniqueId: 'warehouse.main.orders', keys: ['order_id'], sourcePath: 'x', identityFingerprint: 'x' },
      'shop::entity::customers': { id: 'shop::entity::customers', localId: 'customers', qualifiedId: 'shop::entity::customers', domain: 'shop', dbtUniqueId: 'warehouse.main.customers', keys: ['customer_id'], sourcePath: 'x', identityFingerprint: 'x' },
    },
    relationships: {
      'shop::relationship::orders_customers': {
        id: 'shop::relationship::orders_customers', localId: 'orders_customers', qualifiedId: 'shop::relationship::orders_customers',
        from: 'shop::entity::orders', to: 'shop::entity::customers', keys: [{ from: 'customer_id', to: 'customer_id' }],
        cardinality: 'many_to_one', fanout: 'safe', status: 'certified', crossDomain: false, sourcePath: 'x', fingerprint: 'x',
        validation: passed(), staleCertification: false, automaticJoinAllowed: true,
      },
    },
  },
} as unknown as DQLManifest;

// "Draft my models" drafted orders → locations (and the locations entity) as an open proposal.
const proposals = [{
  id: 'ctxprop_1',
  status: 'proposed',
  operations: [
    { id: 'warehouse:entity:shop:locations', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'locations', domain: 'shop', dbtModel: 'warehouse.main.locations' } } },
    { id: 'warehouse:relationship:shop:orders_locations', kind: 'modeling_change', change: { operation: 'upsert_relationship', value: { id: 'orders_locations', domain: 'shop', from: 'orders', to: 'locations', keys: [{ from: 'location_id', to: 'location_id' }], cardinality: 'many_to_one', validation: passed({ toRows: 2 }) } } },
  ],
}, {
  id: 'ctxprop_old',
  status: 'committed',
  operations: [{ id: 'x', kind: 'modeling_change', change: { operation: 'upsert_relationship', value: { id: 'old', domain: 'shop', from: 'orders', to: 'customers', keys: [{ from: 'location_id', to: 'customer_id' }], cardinality: 'many_to_one' } } }],
}];

const warehouseCatalog = {
  relations: [
    { id: 'warehouse.main.orders', name: 'orders', schema: 'main', relation: 'main.orders', kind: 'table' as const, columns: [{ name: 'order_id' }, { name: 'customer_id' }, { name: 'location_id' }, { name: 'order_total', type: 'DOUBLE' }] },
    { id: 'warehouse.main.customers', name: 'customers', schema: 'main', relation: 'main.customers', kind: 'table' as const, columns: [{ name: 'customer_id' }, { name: 'customer_name', type: 'VARCHAR' }] },
    { id: 'warehouse.main.locations', name: 'locations', schema: 'main', relation: 'main.locations', kind: 'table' as const, columns: [{ name: 'location_id' }, { name: 'location_name', type: 'VARCHAR' }] },
  ],
};

function orders(): DatasetDescriptor {
  return {
    version: 1, id: 'app:block:shop:orders', kind: 'block', sourceRevision: 'r', snapshotId: 's',
    contractRef: { kind: 'block_source', id: 'shop::block::Orders', fingerprint: 'c' },
    binding: { sourceQualifiedId: 'shop::block::Orders', sourceRevision: 'r', contractFingerprint: 'c', state: 'target_required' },
    label: 'Orders', lifecycle: 'certified', trust: 'certified',
    grain: { entityIds: ['order'], keyFields: ['order_id'] },
    fields: ['order_id', 'customer_id', 'location_id'].map((name) => ({ kind: 'physical' as const, name, qualifiedId: `o::${name}`, type: 'string' as const, role: 'dimension' as const, status: 'approved' as const })),
    operations: ['filter', 'group'], execution: { route: 'certified' },
  };
}

const block = { sql: 'SELECT "order_id", "customer_id", "location_id" FROM main.orders', rawTableRefs: ['main.orders'], tableDependencies: ['main.orders'], refDependencies: [] };

describe('related tables from the project model (D2)', () => {
  it('reads model relationships, open setup drafts and their evidence, and no closed proposal', () => {
    const context = relatedTablesContext({ manifest, proposals, warehouseCatalog });
    expect(context.edges.map((edge) => [edge.id, edge.origin, edge.fromRelation, edge.toRelation, edge.certified, edge.evidence])).toEqual([
      ['shop::relationship::orders_customers', 'model', 'main.orders', 'main.customers', true, { current: true, toUnique: true, fromUnique: false }],
      ['ctxprop_1:warehouse:relationship:shop:orders_locations', 'drafted', 'main.orders', 'main.locations', false, { current: false, toUnique: true, fromUnique: false }],
    ]);
    expect(context.columnsOf('"main"."customers"')?.map((column) => column.name)).toEqual(['customer_id', 'customer_name']);
    expect(joinableTables(context, '"main"."orders"')).toEqual(['customers', 'locations']);
    expect(joinableTables(context, 'main.customers')).toEqual([]);
  });

  it('reads dbt relationships tests as joins that are checked before use', () => {
    const dbtManifest = {
      nodes: {
        'test.shop.relationships_orders_customer_id': {
          resource_type: 'test', name: 'relationships_orders_customer_id', column_name: 'customer_id', attached_node: 'model.shop.orders',
          test_metadata: { name: 'relationships', kwargs: { field: 'customer_id' } }, depends_on: { nodes: ['model.shop.customers', 'model.shop.orders'] },
        },
      },
    };
    const dbt = {
      ...manifest,
      modeling: { entities: {}, relationships: {} },
      dbtProvenance: { ...manifest.dbtProvenance!, nodes: {
        'model.shop.orders': { ...node('model.shop.orders', 'orders', '"db"."main"."orders"'), resourceType: 'model' as const },
        'model.shop.customers': { ...node('model.shop.customers', 'customers', '"db"."main"."customers"'), resourceType: 'model' as const },
      } },
    } as unknown as DQLManifest;
    const context = relatedTablesContext({ manifest: dbt, dbt: { manifest: dbtManifest, catalog: { nodes: { 'model.shop.customers': { columns: { customer_id: { name: 'customer_id', type: 'TEXT' }, customer_name: { name: 'customer_name', type: 'TEXT' } } } } } } });
    expect(context.edges).toEqual([expect.objectContaining({ origin: 'dbt_test', cardinality: 'many_to_one', certified: false, keys: [{ from: 'customer_id', to: 'customer_id' }] })]);
    expect(context.edges[0]!.evidence).toBeUndefined();
    expect(context.columnsOf('db.main.customers')?.map((column) => column.name)).toEqual(['customer_id', 'customer_name']);
  });

  it('follows the model join, not also a dbt test to the staging copy (jaffle-shop: orders.customer_id → customers and stg_customers)', () => {
    const dbtManifest = {
      nodes: {
        'test.shop.relationships_orders_customer_id__stg_customers': {
          resource_type: 'test', name: 'relationships_orders_customer_id__customer_id__ref_stg_customers_', column_name: 'customer_id', attached_node: 'model.shop.orders',
          test_metadata: { name: 'relationships', kwargs: { field: 'customer_id' } }, depends_on: { nodes: ['model.shop.stg_customers', 'model.shop.orders'] },
        },
      },
    };
    const model = (name: string) => ({ ...node(`model.shop.${name}`, name, `"db"."dev"."${name}"`), resourceType: 'model' as const });
    const sample = {
      ...manifest,
      modeling: {
        entities: {
          'shop::entity::orders': { ...manifest.modeling!.entities['shop::entity::orders']!, dbtUniqueId: 'model.shop.orders' },
          'shop::entity::customers': { ...manifest.modeling!.entities['shop::entity::customers']!, dbtUniqueId: 'model.shop.customers' },
        },
        relationships: {
          // Imported from the semantic model: known, not certified, no warehouse check yet.
          'shop::relationship::orders_customers': { ...manifest.modeling!.relationships['shop::relationship::orders_customers']!, status: 'draft', validation: undefined, automaticJoinAllowed: false },
        },
      },
      dbtProvenance: { ...manifest.dbtProvenance!, nodes: { 'model.shop.orders': model('orders'), 'model.shop.customers': model('customers'), 'model.shop.stg_customers': model('stg_customers') } },
    } as unknown as DQLManifest;
    const columns = (names: string[]) => ({ columns: Object.fromEntries(names.map((name) => [name, { name, type: 'TEXT' }])) });
    const context = relatedTablesContext({
      manifest: sample,
      dbt: { manifest: dbtManifest, catalog: { nodes: {
        'model.shop.customers': columns(['customer_id', 'customer_name', 'lifetime_spend']),
        'model.shop.stg_customers': columns(['customer_id', 'customer_name']),
      } } },
    });
    expect(context.edges.map((edge) => [edge.origin, edge.toTable])).toEqual([['model', 'customers'], ['dbt_test', 'stg_customers']]);
    const decorated = decorateDatasetDescriptor({ descriptor: orders(), block: { ...block, rawTableRefs: ['"db"."dev"."orders"'] }, context, quote });
    // One Customer group (not "Customer · 2 fields" and "Customer · 1 field"), so Customer Name is one field a filter can reach.
    expect(decorated.joins?.map((join) => [join.id, join.table, join.origin])).toEqual([['customer', 'customers', 'model']]);
    expect(decorated.fields.filter((field) => field.kind === 'physical' && field.related).map((field) => field.name)).toEqual(['customer__customer_name', 'customer__lifetime_spend']);
    expect(datasetFieldForFilter(decorated, 'customer_name')?.field.name).toBe('customer__customer_name');
    expect(joinableTables(context, 'db.dev.orders')).toEqual(['customers']);
    // The warehouse listing names the table without its database.
    expect(joinableTables(context, 'dev.orders')).toEqual(['customers']);
    expect(joinableTables(context, '"dev"."orders"')).toEqual(['customers']);
  });

  it('knows which one table a Dataset reads, and never treats a joined, grouped or ref source as a table', () => {
    const known = () => true;
    expect(datasetBaseRelation(block, known)).toBe('main.orders');
    expect(datasetBaseRelation({ ...block, sql: 'SELECT * FROM main.orders o JOIN main.customers c ON o.customer_id = c.customer_id', rawTableRefs: ['main.orders', 'main.customers'] }, known)).toBeUndefined();
    expect(datasetBaseRelation({ ...block, sql: 'SELECT customer_id, SUM(order_total) FROM main.orders GROUP BY 1' }, known)).toBeUndefined();
    expect(datasetBaseRelation({ ...block, refDependencies: ['other_block'] }, known)).toBeUndefined();
    expect(datasetBaseRelation(block, () => false)).toBeUndefined();
  });

  it('decorates a table Dataset with its related fields, with SQL-quoted relations, and leaves others alone', () => {
    const context = relatedTablesContext({ manifest, proposals, warehouseCatalog });
    const decorated = decorateDatasetDescriptor({ descriptor: orders(), block, context, quote });
    expect(decorated.joins?.map((join) => [join.id, join.relation, join.trust, join.uniqueness, join.origin])).toEqual([
      ['customer', '"main"."customers"', 'certified', 'current', 'model'],
      ['location', '"main"."locations"', 'review_required', 'recheck', 'drafted'],
    ]);
    expect(decorated.fields.filter((field) => field.kind === 'physical' && field.related).map((field) => field.name)).toEqual(['customer__customer_name', 'location__location_name']);
    const plain = orders();
    expect(decorateDatasetDescriptor({ descriptor: plain, block, context: { edges: [], columnsOf: () => undefined }, quote })).toBe(plain);
    expect(decorateDatasetDescriptor({ descriptor: plain, block: { ...block, sql: 'SELECT order_id FROM main.orders UNION SELECT order_id FROM main.archive' }, context, quote })).toBe(plain);
    // A schema-less table name finds the one known relation of that name.
    expect(decorateDatasetDescriptor({ descriptor: orders(), block: { ...block, rawTableRefs: ['orders'] }, context, quote }).joins).toHaveLength(2);
  });

  it('checks a related key with one bounded query and refuses in plain words when it repeats', () => {
    expect(joinUniquenessSql({ relation: '"main"."customers"', keys: [{ from: 'customer_id', to: 'customer_id' }] }, quote)).toBe([
      'SELECT 1 AS dql_repeated_key',
      'FROM "main"."customers"',
      'WHERE "customer_id" IS NOT NULL',
      'GROUP BY "customer_id"',
      'HAVING COUNT(*) > 1',
      'LIMIT 1',
    ].join('\n'));
    expect(joinRepeatsKeyMessage({ table: 'customers', keys: [{ from: 'customer_id', to: 'customer_id' }], sentence: 'each order has one customer' }, 'Orders'))
      .toBe('JOIN_KEY_NOT_UNIQUE: customers has more than one row for some customer_id values, so joining it to Orders would count rows more than once. The model says "each order has one customer", but the data does not; check the join in Modeling.');
    expect(relationSql('main.customers', quote)).toBe('"main"."customers"');
    expect(relationSql('"db"."main"."customers"', quote)).toBe('"db"."main"."customers"');
  });
});
