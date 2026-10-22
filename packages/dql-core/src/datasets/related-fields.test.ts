import { describe, expect, it } from 'vitest';
import { normalizeDatasetDescriptor, type DatasetDescriptor } from './descriptor.js';
import {
  adoptDatasetJoins,
  datasetFieldForFilter,
  datasetJoinReceiptSentence,
  datasetJoinsTrust,
  datasetJoinsUsed,
  discoverDatasetJoins,
  relatedFieldParts,
  relatedFieldWords,
  withDatasetJoins,
  withoutDatasetJoins,
  withoutSupersededEdges,
  type RelatedRelationshipEdge,
} from './related-fields.js';

function ordersDescriptor(overrides: Partial<DatasetDescriptor> = {}): DatasetDescriptor {
  return {
    version: 1,
    id: 'app:block:shop:orders',
    kind: 'block',
    sourceRevision: 'sha256:orders',
    snapshotId: 'target-required',
    contractRef: { kind: 'block_source', id: 'shop::block::Orders', fingerprint: 'sha256:contract' },
    binding: { sourceQualifiedId: 'shop::block::Orders', sourceRevision: 'sha256:orders', contractFingerprint: 'sha256:contract', state: 'target_required' },
    label: 'Orders',
    lifecycle: 'certified',
    trust: 'certified',
    grain: { entityIds: ['order'], keyFields: ['order_id'], keyEvidence: 'proof.orders' },
    fields: [
      { kind: 'physical', name: 'order_id', qualifiedId: 'orders::order_id', type: 'string', role: 'key', status: 'approved' },
      { kind: 'physical', name: 'customer_id', qualifiedId: 'orders::customer_id', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'location_id', qualifiedId: 'orders::location_id', type: 'string', role: 'dimension', status: 'approved' },
      { kind: 'physical', name: 'ordered_at', qualifiedId: 'orders::ordered_at', type: 'timestamp', role: 'time', status: 'approved', time: { grains: ['day', 'month'] } },
      { kind: 'physical', name: 'order_total', qualifiedId: 'orders::order_total', type: 'number', role: 'attribute', status: 'approved' },
      {
        kind: 'measure', name: 'order_total', qualifiedId: 'orders::m::order_total', aggregation: 'sum', from: 'order_total', dependsOn: ['order_total'],
        additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved',
      },
    ],
    operations: ['filter', 'group', 'trend', 'rank', 'detail'],
    execution: { route: 'certified' },
    ...overrides,
  };
}

const COLUMNS: Record<string, Array<{ name: string; type?: string }>> = {
  'main.customers': [{ name: 'customer_id', type: 'VARCHAR' }, { name: 'customer_name', type: 'VARCHAR' }, { name: 'region_id', type: 'VARCHAR' }, { name: 'signed_up_at', type: 'TIMESTAMP' }, { name: 'lifetime_spend', type: 'DOUBLE' }],
  'main.locations': [{ name: 'location_id', type: 'VARCHAR' }, { name: 'location_name', type: 'VARCHAR' }],
  'main.regions': [{ name: 'region_id', type: 'VARCHAR' }, { name: 'region_name', type: 'VARCHAR' }, { name: 'country_id', type: 'VARCHAR' }],
  'main.countries': [{ name: 'country_id', type: 'VARCHAR' }, { name: 'country_name', type: 'VARCHAR' }],
  'main.order_items': [{ name: 'order_item_id', type: 'VARCHAR' }, { name: 'order_id', type: 'VARCHAR' }],
};

function edge(overrides: Partial<RelatedRelationshipEdge> & Pick<RelatedRelationshipEdge, 'id' | 'fromRelation' | 'toRelation' | 'keys'>): RelatedRelationshipEdge {
  const table = (relation: string) => relation.split('.').pop()!.replace(/"/g, '');
  return {
    origin: 'model',
    fromTable: table(overrides.fromRelation),
    toTable: table(overrides.toRelation),
    cardinality: 'many_to_one',
    certified: true,
    evidence: { current: true, toUnique: true },
    ...overrides,
  };
}

const EDGES: RelatedRelationshipEdge[] = [
  edge({ id: 'shop::relationship::orders_customers', fromRelation: 'main.orders', toRelation: 'main.customers', keys: [{ from: 'customer_id', to: 'customer_id' }] }),
  // Authored the other way round: one location has many orders.
  edge({ id: 'shop::relationship::locations_orders', fromRelation: '"main"."locations"', toRelation: 'main.orders', keys: [{ from: 'location_id', to: 'location_id' }], cardinality: 'one_to_many', certified: false, origin: 'drafted', evidence: { current: false, fromUnique: true } }),
  edge({ id: 'shop::relationship::customers_regions', fromRelation: 'main.customers', toRelation: 'main.regions', keys: [{ from: 'region_id', to: 'region_id' }] }),
  // A third hop is never followed.
  edge({ id: 'shop::relationship::regions_countries', fromRelation: 'main.regions', toRelation: 'main.countries', keys: [{ from: 'country_id', to: 'country_id' }] }),
  // One order has many items: not followed from Orders.
  edge({ id: 'shop::relationship::items_orders', fromRelation: 'main.order_items', toRelation: 'main.orders', keys: [{ from: 'order_id', to: 'order_id' }] }),
];

const discover = (descriptor = ordersDescriptor(), edges = EDGES) => discoverDatasetJoins({
  descriptor,
  baseRelation: 'main.orders',
  edges,
  columnsOf: (relation) => COLUMNS[relation.replace(/"/g, '')],
});

describe('fields from related tables (D2)', () => {
  it('follows many-to-one joins from the table, either way they were authored, and a second hop', () => {
    const found = discover();
    expect(found.joins.map((join) => [join.id, join.parent, join.table, join.trust, join.uniqueness])).toEqual([
      ['customer', undefined, 'customers', 'certified', 'current'],
      ['location', undefined, 'locations', 'review_required', 'recheck'],
      ['customer__region', 'customer', 'regions', 'certified', 'current'],
    ]);
    const location = found.joins.find((join) => join.id === 'location')!;
    // Authored as locations → orders (one-to-many); followed as orders → locations.
    expect(location.keys).toEqual([{ from: 'location_id', to: 'location_id' }]);
    expect(location.cardinality).toBe('many_to_one');
    expect(location.sentence).toBe('each order has one location');
    expect(found.joins.find((join) => join.id === 'customer__region')!.sentence).toBe('each customer has one region');
    // Related fields leave out the join key and are dimensions, never measures.
    expect(found.fields.map((field) => field.name)).toEqual([
      'customer__customer_name', 'customer__region_id', 'customer__signed_up_at', 'customer__lifetime_spend',
      'location__location_name',
      'customer__region__region_name', 'customer__region__country_id',
    ]);
    expect(found.fields.every((field) => field.kind === 'physical' && field.status === 'approved')).toBe(true);
    expect(found.fields.find((field) => field.name === 'customer__lifetime_spend')).toMatchObject({ role: 'dimension', type: 'number' });
    expect(found.fields.find((field) => field.name === 'customer__signed_up_at')).toMatchObject({ role: 'time', type: 'timestamp', time: { grains: ['day', 'week', 'month', 'quarter', 'year'] } });
    // No third hop: countries are reached only through regions.
    expect(found.joins.some((join) => join.table === 'countries')).toBe(false);
  });

  it('never follows one-to-many and says how to get it instead', () => {
    const found = discover();
    expect(found.joins.some((join) => join.table === 'order_items')).toBe(false);
    expect(found.notes).toEqual(['Order items per order: add it from Order items. One order has many order items, so following that join here would count each order more than once.']);
  });

  it('refuses a join whose evidence shows the "one" side repeats a key, a failed check, many-to-many and unknown', () => {
    const repeats = edge({ id: 'r1', fromRelation: 'main.orders', toRelation: 'main.customers', keys: [{ from: 'customer_id', to: 'customer_id' }], evidence: { current: false, toUnique: false } });
    const failed = edge({ id: 'r2', fromRelation: 'main.orders', toRelation: 'main.locations', keys: [{ from: 'location_id', to: 'location_id' }], evidence: { current: false, failed: true } });
    const many = edge({ id: 'r3', fromRelation: 'main.orders', toRelation: 'main.regions', keys: [{ from: 'customer_id', to: 'region_id' }], cardinality: 'many_to_many' });
    const unknown = edge({ id: 'r4', fromRelation: 'main.orders', toRelation: 'main.countries', keys: [{ from: 'customer_id', to: 'country_id' }], cardinality: 'unknown' });
    expect(discover(ordersDescriptor(), [repeats, failed, many, unknown]).joins).toEqual([]);
  });

  it('needs the join key to be a field of the Dataset, and changes nothing without relationships', () => {
    const withoutKey = ordersDescriptor({ fields: ordersDescriptor().fields.filter((field) => field.name !== 'customer_id') });
    expect(discover(withoutKey).joins.map((join) => join.id)).toEqual(['location']);
    const none = discover(ordersDescriptor(), []);
    expect(none).toEqual({ joins: [], fields: [], notes: [] });
    const descriptor = ordersDescriptor();
    expect(withDatasetJoins(descriptor, none)).toBe(descriptor);
  });

  it('does not follow joins from a saved query result or an aggregate source', () => {
    expect(discover(ordersDescriptor({ result: { savedQuery: 'orders', groupBy: [], asIs: [], typesFrom: 'run' } })).joins).toEqual([]);
    expect(discover(ordersDescriptor({ grain: { entityIds: ['month'], keyFields: ['month'], aggregate: true } })).joins).toEqual([]);
  });

  it('keeps the best source of the same relationship and names two joins to one table by their keys', () => {
    const drafted = edge({ id: 'drafted', origin: 'drafted', certified: false, fromRelation: 'main.orders', toRelation: 'main.customers', keys: [{ from: 'customer_id', to: 'customer_id' }] });
    const model = edge({ id: 'model', fromRelation: 'main.orders', toRelation: 'main.customers', keys: [{ from: 'customer_id', to: 'customer_id' }] });
    expect(discover(ordersDescriptor(), [drafted, model]).joins.map((join) => join.relationshipId)).toEqual(['model']);
    const shipping = edge({ id: 'ship', fromRelation: 'main.orders', toRelation: 'main.customers', keys: [{ from: 'location_id', to: 'customer_id' }] });
    expect(discover(ordersDescriptor(), [model, shipping]).joins.map((join) => [join.id, join.label])).toEqual([['customer', 'Customer'], ['location', 'Location']]);
  });

  // New-user round 2, problem 5: two identical "Order Items → Product" groups, one per join.
  it('never shows two joins to one table that read the same: the key join wins over a label join, a certified one over a draft', () => {
    const items = ordersDescriptor({
      id: 'app:block:shop:order_items',
      label: 'Order Items',
      grain: { entityIds: ['order_item'], keyFields: ['order_item_id'], keyEvidence: 'proof.items' },
      fields: [
        { kind: 'physical', name: 'order_item_id', qualifiedId: 'items::order_item_id', type: 'string', role: 'key', status: 'approved' },
        { kind: 'physical', name: 'product_id', qualifiedId: 'items::product_id', type: 'string', role: 'dimension', status: 'approved' },
        { kind: 'physical', name: 'product_name', qualifiedId: 'items::product_name', type: 'string', role: 'dimension', status: 'approved' },
      ],
    });
    const columns: Record<string, Array<{ name: string; type?: string }>> = {
      'main.products': [{ name: 'product_id', type: 'VARCHAR' }, { name: 'product_name', type: 'VARCHAR' }, { name: 'product_type', type: 'VARCHAR' }],
    };
    const byId = edge({ id: 'by-id', origin: 'drafted', certified: false, fromRelation: 'main.order_items', toRelation: 'main.products', keys: [{ from: 'product_id', to: 'product_id' }] });
    const byName = edge({ id: 'by-name', origin: 'drafted', certified: false, fromRelation: 'main.order_items', toRelation: 'main.products', keys: [{ from: 'product_name', to: 'product_name' }] });
    const found = (edges: RelatedRelationshipEdge[]) => discoverDatasetJoins({ descriptor: items, baseRelation: 'main.order_items', edges, columnsOf: (relation) => columns[relation] });
    expect(found([byName, byId]).joins.map((join) => [join.id, join.label, join.relationshipId])).toEqual([['product', 'Product', 'by-id']]);
    expect(found([byId, byName]).joins.map((join) => join.relationshipId)).toEqual(['by-id']);
    // Even a certified label join gives way to a key join; alone, it is still followed.
    expect(found([{ ...byName, certified: true, origin: 'model' }, byId]).joins.map((join) => join.relationshipId)).toEqual(['by-id']);
    expect(found([byName]).joins.map((join) => join.relationshipId)).toEqual(['by-name']);
    // Two key joins that read differently are both kept.
    const labels = (joins: Array<{ label: string }>) => joins.map((join) => join.label);
    expect(new Set(labels(found([byId, byName]).joins)).size).toBe(found([byId, byName]).joins.length);
  });

  it('follows one foreign key to one table: a dbt test to a staging copy does not add a second Customer (dbt sample)', () => {
    const columns: Record<string, Array<{ name: string; type?: string }>> = {
      ...COLUMNS,
      'main.stg_customers': [{ name: 'customer_id', type: 'VARCHAR' }, { name: 'customer_name', type: 'VARCHAR' }],
    };
    // The semantic model joins orders.customer_id to customers (not certified yet);
    // a dbt `relationships` test points the same column at stg_customers.
    const model = edge({ id: 'model', certified: false, evidence: undefined, fromRelation: 'main.orders', toRelation: 'main.customers', keys: [{ from: 'customer_id', to: 'customer_id' }] });
    const dbtTest = edge({ id: 'test', origin: 'dbt_test', certified: false, evidence: undefined, fromRelation: 'main.orders', toRelation: 'main.stg_customers', keys: [{ from: 'customer_id', to: 'customer_id' }] });
    const found = discoverDatasetJoins({ descriptor: ordersDescriptor(), baseRelation: 'main.orders', edges: [model, dbtTest], columnsOf: (relation) => columns[relation] });
    expect(found.joins.map((join) => [join.id, join.table])).toEqual([['customer', 'customers']]);
    const descriptor = withDatasetJoins(ordersDescriptor(), found);
    expect(datasetFieldForFilter(descriptor, 'customer_name')?.field.name).toBe('customer__customer_name');
    // Two dbt tests of equal rank: the staging copy gives way to the mart.
    const martTest = edge({ ...dbtTest, id: 'mart-test', toRelation: 'main.customers', toTable: 'customers' });
    expect(withoutSupersededEdges([dbtTest, martTest]).map((item) => item.id)).toEqual(['mart-test']);
    // Two equally good tables on one key are both kept; another key is never touched.
    const addresses = edge({ id: 'addresses', fromRelation: 'main.orders', toRelation: 'main.addresses', keys: [{ from: 'customer_id', to: 'customer_id' }] });
    const certifiedCustomers = edge({ id: 'customers', fromRelation: 'main.orders', toRelation: 'main.customers', keys: [{ from: 'customer_id', to: 'customer_id' }] });
    const kept = [certifiedCustomers, addresses, ...EDGES.slice(1)];
    expect(withoutSupersededEdges(kept)).toBe(kept);
    // Authored the other way round (one customer has many orders), the same rule holds.
    const reversed = edge({ ...dbtTest, id: 'reversed', fromRelation: 'main.stg_customers', toRelation: 'main.orders', fromTable: 'stg_customers', toTable: 'orders', cardinality: 'one_to_many' });
    expect(withoutSupersededEdges([model, reversed]).map((item) => item.id)).toEqual(['model']);
  });

  it('a filter prefers the nearest related table when two joins read the same column', () => {
    const columns: Record<string, Array<{ name: string; type?: string }>> = {
      ...COLUMNS,
      'main.regions': [...COLUMNS['main.regions']!, { name: 'customer_name', type: 'VARCHAR' }],
    };
    const found = discoverDatasetJoins({ descriptor: ordersDescriptor(), baseRelation: 'main.orders', edges: EDGES, columnsOf: (relation) => columns[relation.replace(/"/g, '')] });
    const descriptor = withDatasetJoins(ordersDescriptor(), found);
    expect(datasetFieldForFilter(descriptor, 'customer_name')?.field.name).toBe('customer__customer_name');
  });

  it('finds the joins a query reads, parents first, and their trust', () => {
    const descriptor = withDatasetJoins(ordersDescriptor(), discover());
    expect(datasetJoinsUsed(descriptor, { dimensions: [{ field: 'order_id' }] })).toEqual([]);
    expect(datasetJoinsUsed(descriptor, { dimensions: [{ field: 'customer__region__region_name' }] }).map((join) => join.id)).toEqual(['customer', 'customer__region']);
    const used = datasetJoinsUsed(descriptor, { dimensions: [{ field: 'ordered_at' }], filters: [{ field: 'location__location_name' }] });
    expect(used.map((join) => join.id)).toEqual(['location']);
    expect(datasetJoinsTrust(used)).toBe('review_required');
    expect(datasetJoinsTrust(datasetJoinsUsed(descriptor, { detailColumns: ['customer__customer_name'] }))).toBe('certified');
    expect(datasetJoinsUsed(descriptor, { calculations: [{ expr: { measure: 'order_total', where: [{ field: 'customer__customer_name' }] } }] }).map((join) => join.id)).toEqual(['customer']);
  });

  it('writes the receipt in plain words', () => {
    const { joins } = discover();
    expect(datasetJoinReceiptSentence(joins[0]!, joins)).toBe('Joined to customers on customer_id (each order has one customer — checked)');
    expect(datasetJoinReceiptSentence(joins[2]!, joins)).toBe('Joined to regions through customers on region_id (each customer has one region — checked)');
    expect(datasetJoinReceiptSentence(joins[1]!, joins)).toBe('Joined to locations on location_id (each order has one location — checked; the join is not certified yet)');
  });

  it('names related fields in words', () => {
    expect(relatedFieldParts('customer__region__region_name')).toEqual({ join: 'customer__region', column: 'region_name' });
    expect(relatedFieldParts('customer_name')).toBeUndefined();
    expect(relatedFieldParts('_airbyte__raw')).toBeUndefined();
    expect(relatedFieldWords('location__location_name')).toBe('location name');
    expect(relatedFieldWords('customer__city')).toBe('customer city');
    expect(relatedFieldWords('customer__region__region_name')).toBe('region name');
  });

  it('lets a filter reach a joined Dataset through the single related field of that column', () => {
    const descriptor = withDatasetJoins(ordersDescriptor(), discover());
    expect(datasetFieldForFilter(descriptor, 'customer_id')).toEqual({ field: expect.objectContaining({ name: 'customer_id' }) });
    const viaCustomer = datasetFieldForFilter(descriptor, 'customer_name');
    expect(viaCustomer?.field.name).toBe('customer__customer_name');
    expect(viaCustomer?.join?.label).toBe('Customer');
    expect(datasetFieldForFilter(descriptor, 'customer__customer_name')?.field.name).toBe('customer__customer_name');
    expect(datasetFieldForFilter(descriptor, 'unknown_column')).toBeUndefined();
    // A filter made from Orders' related field reaches a Customers Dataset's own column.
    const customers = ordersDescriptor({ id: 'customers', fields: [{ kind: 'physical', name: 'customer_name', qualifiedId: 'c::customer_name', type: 'string', role: 'dimension', status: 'approved' }] });
    expect(datasetFieldForFilter(customers, 'customer__customer_name')?.field.name).toBe('customer_name');
  });

  it('round-trips joins and related fields through the descriptor reader, and old descriptors are unchanged', () => {
    const plain = ordersDescriptor();
    expect(normalizeDatasetDescriptor(JSON.parse(JSON.stringify(plain)))).toEqual(plain);
    const joined = withDatasetJoins(plain, discover());
    expect(normalizeDatasetDescriptor(JSON.parse(JSON.stringify(joined)))).toEqual(joined);
    // A related field must name a declared join; a second hop's parent comes first.
    expect(normalizeDatasetDescriptor({ ...joined, joins: joined.joins!.filter((join) => join.id !== 'location') })).toBeUndefined();
    expect(normalizeDatasetDescriptor({ ...joined, joins: [...joined.joins!].reverse() })).toBeUndefined();
    expect(normalizeDatasetDescriptor({ ...joined, joins: [{ ...joined.joins![0]!, id: 'bad id' }] })).toBeUndefined();
    expect(withoutDatasetJoins(joined)).toEqual(plain);
    expect(adoptDatasetJoins(plain, joined)).toEqual(joined);
    expect(adoptDatasetJoins(plain, plain)).toBe(plain);
  });
});
