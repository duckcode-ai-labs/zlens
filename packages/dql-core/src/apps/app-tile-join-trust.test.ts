import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '../datasets/descriptor.js';
import { discoverDatasetJoins, withDatasetJoins, type RelatedRelationshipEdge } from '../datasets/related-fields.js';
import { appTilesNeedingJoinReview, tileJoinReviewSentence, type JoinTrustPageLike } from './app-tile-join-trust.js';

const base: DatasetDescriptor = {
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
    { kind: 'physical', name: 'order_total', qualifiedId: 'orders::order_total', type: 'number', role: 'attribute', status: 'approved' },
    {
      kind: 'measure', name: 'order_total', qualifiedId: 'orders::m::order_total', aggregation: 'sum', from: 'order_total', dependsOn: ['order_total'],
      additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved',
    },
  ],
  operations: ['filter', 'group', 'trend', 'rank', 'detail'],
  execution: { route: 'certified' },
};

const edges: RelatedRelationshipEdge[] = [
  // Certified in Modeling.
  { id: 'rel::orders_customers', origin: 'model', fromRelation: 'main.orders', toRelation: 'main.customers', fromTable: 'orders', toTable: 'customers', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', certified: true, evidence: { current: true, toUnique: true } },
  // Drafted in setup, not certified yet.
  { id: 'proposal_1:op_2', origin: 'drafted', fromRelation: 'main.orders', toRelation: 'main.locations', fromTable: 'orders', toTable: 'locations', keys: [{ from: 'location_id', to: 'location_id' }], cardinality: 'many_to_one', certified: false, evidence: { current: false, toUnique: true } },
];

const columns: Record<string, Array<{ name: string; type?: string }>> = {
  'main.customers': [{ name: 'customer_id', type: 'VARCHAR' }, { name: 'customer_name', type: 'VARCHAR' }],
  'main.locations': [{ name: 'location_id', type: 'VARCHAR' }, { name: 'location_name', type: 'VARCHAR' }],
};

const orders = withDatasetJoins(base, discoverDatasetJoins({ descriptor: base, baseRelation: 'main.orders', edges, columnsOf: (relation) => columns[relation] }));

function page(items: JoinTrustPageLike['layout']['items'], filters: JoinTrustPageLike['filters'] = []): JoinTrustPageLike {
  return {
    id: 'overview',
    metadata: { title: 'Overview' },
    datasets: [{ id: 'orders_ds', sourceId: 'orders', sourceRevision: 'sha256:orders' }],
    filters,
    layout: { items },
  };
}

const check = (pages: JoinTrustPageLike[], descriptor = orders) => appTilesNeedingJoinReview({ pages, descriptorFor: (id) => (id === 'orders' ? descriptor : undefined) });

describe('tile trust from the joins it reads', () => {
  it('lists a tile that groups by a field through a drafted join, with the field to remove', () => {
    const found = check([page([
      { i: 'by_location', title: 'Revenue by location', sourceId: 'orders', sourceRevision: 'sha256:orders', query: { dimensions: [{ field: 'location__location_name' }] } },
      { i: 'by_customer', title: 'Revenue by customer', sourceId: 'orders', query: { dimensions: [{ field: 'customer__customer_name' }] } },
      { i: 'total', title: 'Revenue', sourceId: 'orders', query: { dimensions: [] } },
    ])]);
    expect(found.map((item) => [item.tileId, item.joins.map((join) => join.id), item.relatedFields, item.filterIds])).toEqual([
      ['by_location', ['location'], ['location__location_name'], []],
    ]);
    expect(found[0]!.joins[0]!.relationshipId).toBe('proposal_1:op_2');
    expect(tileJoinReviewSentence(found[0]!)).toBe('Revenue by location uses the join to Location, which is not certified yet.');
  });

  it('counts a page filter that reaches the tile through a drafted join, and calculations and drivers', () => {
    const filter = { id: 'location_name', label: 'Location', datasetBindings: { orders_ds: { field: 'location__location_name' } } };
    const viaFilter = check([page([{ i: 'total', sourceId: 'orders', sourceRevision: 'sha256:orders', query: { dimensions: [] } }], [filter])]);
    expect(viaFilter.map((item) => [item.tileId, item.relatedFields, item.filterIds])).toEqual([['total', [], ['location_name']]]);
    // Mapped by the column's own name, it still reaches the tile through the join.
    const byColumn = { ...filter, datasetBindings: { orders_ds: { field: 'location_name' } } };
    expect(check([page([{ i: 'total', sourceId: 'orders', query: { dimensions: [] } }], [byColumn])]).map((item) => item.filterIds)).toEqual([['location_name']]);
    // A filter that does not apply to this tile does not count.
    expect(check([page([{ i: 'total', sourceId: 'orders', query: { dimensions: [] } }], [{ ...filter, scope: { tileIds: ['other'] } }])])).toEqual([]);
    const viaCalc = check([page([{ i: 'calc', sourceId: 'orders', query: { dimensions: [], calculations: [{ expr: { where: [{ field: 'location__location_name' }] } }] } }])]);
    expect(viaCalc).toHaveLength(1);
    const viaDriver = check([page([{ i: 'why', sourceId: 'orders', driver: { dimensions: ['location__location_name'] } }])]);
    expect(viaDriver.map((item) => item.relatedFields)).toEqual([['location__location_name']]);
  });

  it('passes once the join is certified, and ignores tiles without joins', () => {
    const certified = { ...orders, joins: orders.joins!.map((join) => ({ ...join, trust: 'certified' as const })) };
    expect(check([page([{ i: 'by_location', sourceId: 'orders', query: { dimensions: [{ field: 'location__location_name' }] } }])], certified)).toEqual([]);
    expect(check([page([{ i: 'by_location', sourceId: 'orders', query: { dimensions: [{ field: 'location__location_name' }] } }])], base)).toEqual([]);
  });
});
