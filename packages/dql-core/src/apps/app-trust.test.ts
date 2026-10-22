import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '../datasets/descriptor.js';
import { discoverDatasetJoins, withDatasetJoins, type RelatedRelationshipEdge } from '../datasets/related-fields.js';
import { appTileTrustFor, appTrustAnswer, publishReadyLine, publishedTileTrustText, type AppTrustPageLike, type AppTrustSourceLike } from './app-trust.js';
import { certifiedByLabel, certifierDisplayName, readerTileTrust } from './reader-trust.js';

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
    { kind: 'physical', name: 'ordered_at', qualifiedId: 'orders::ordered_at', type: 'timestamp', role: 'time', status: 'approved' },
    { kind: 'physical', name: 'order_total', qualifiedId: 'orders::order_total', type: 'number', role: 'attribute', status: 'approved' },
    {
      kind: 'measure', name: 'order_total', qualifiedId: 'orders::m::order_total', aggregation: 'sum', from: 'order_total', dependsOn: ['order_total'],
      additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved',
    },
  ],
  operations: ['filter', 'group', 'trend', 'rank', 'detail'],
  execution: { route: 'certified' },
};

// The Customer join was drafted (not certified yet), as in the dbt sample.
const edges: RelatedRelationshipEdge[] = [
  { id: 'proposal_1:op_1', origin: 'drafted', fromRelation: 'main.orders', toRelation: 'main.customers', fromTable: 'orders', toTable: 'customers', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', certified: false, evidence: { current: true, toUnique: true } },
];
const columns: Record<string, Array<{ name: string; type?: string }>> = {
  'main.customers': [{ name: 'customer_id', type: 'VARCHAR' }, { name: 'customer_name', type: 'VARCHAR' }],
};
const ordersDescriptor = withDatasetJoins(base, discoverDatasetJoins({ descriptor: base, baseRelation: 'main.orders', edges, columnsOf: (relation) => columns[relation] }));
const certifiedJoins = { ...ordersDescriptor, joins: ordersDescriptor.joins!.map((join) => ({ ...join, trust: 'certified' as const })) };

const certifiedOrders: AppTrustSourceLike = { id: 'orders', kind: 'block', lifecycle: 'certified', trustState: 'certified', reviewStatus: 'not_required', capabilities: { dataset: ordersDescriptor } };
const beverage: AppTrustSourceLike = { id: 'beverage', kind: 'certified_block', trustState: 'certified', reviewStatus: 'not_required', certification: { by: 'analytics@jaffle.shop', at: '2026-10-16T12:00:00Z' } };

const customerFilter = { id: 'customer__customer_name', label: 'Customer Name', datasetBindings: { orders_ds: { field: 'customer__customer_name' } } };

/** The reviewer's App: a KPI and a trend the Customer filter reaches, a Top 10 customers, and a certified saved query. */
function salesPage(filters: AppTrustPageLike['filters'] = [customerFilter]): AppTrustPageLike {
  return {
    id: 'overview',
    metadata: { title: 'Overview' },
    datasets: [{ id: 'orders_ds', sourceId: 'orders', sourceRevision: 'sha256:orders' }],
    filters,
    layout: {
      items: [
        { i: 'kpi', title: 'Order total', sourceId: 'orders', sourceRevision: 'sha256:orders', query: { dimensions: [] } },
        { i: 'trend', title: 'By month', sourceId: 'orders', sourceRevision: 'sha256:orders', query: { dimensions: [{ field: 'ordered_at' }] } },
        { i: 'top', title: 'Top 10 customers', sourceId: 'orders', sourceRevision: 'sha256:orders', query: { dimensions: [{ field: 'customer__customer_name' }] } },
        { i: 'bev', title: 'Beverage revenue', sourceId: 'beverage', block: { blockId: 'beverage_revenue_by_product' } },
        { i: 'note', text: { markdown: 'Notes' } },
      ],
    },
  };
}

const sources = (overrides: Record<string, AppTrustSourceLike> = {}) => {
  const all: Record<string, AppTrustSourceLike> = { orders: certifiedOrders, beverage, ...overrides };
  return (id: string) => all[id];
};

describe('one trust answer for an App (B6)', () => {
  it('counts every tile the Customer join reaches — its own field, or a filter mapped to it — as Needs review', () => {
    const answer = appTrustAnswer({ pages: [salesPage()], sourceFor: sources() });
    expect(answer.total).toBe(4);
    expect(answer.certified).toBe(1);
    expect(answer.needsReview).toBe(3);
    expect(answer.allCertified).toBe(false);
    expect(answer.label).toBe('1 of 4 tiles certified');
    expect(answer.tiles.map((tile) => [tile.tileId, tile.trust.state])).toEqual([
      ['kpi', 'review'], ['trend', 'review'], ['top', 'review'], ['bev', 'certified'],
    ]);
    expect(appTileTrustFor(answer, 'overview', 'kpi')?.joinReview?.filterIds).toEqual(['customer__customer_name']);
    expect(appTileTrustFor(answer, 'overview', 'top')?.joinReview?.relatedFields).toEqual(['customer__customer_name']);
    // The saved query keeps who certified it.
    expect(appTileTrustFor(answer, 'overview', 'bev')?.trust.byline).toBe('Certified by Analytics (jaffle.shop) · 16 Oct');
    expect(appTileTrustFor(answer, 'overview', 'note')).toBeUndefined();
  });

  it('does not depend on the reader’s filter value: the page decides it, not the value picked', () => {
    const unpicked = appTrustAnswer({ pages: [salesPage()], sourceFor: sources() });
    const picked = appTrustAnswer({ pages: [salesPage([{ ...customerFilter, defaultValue: 'Seth Atkinson' } as typeof customerFilter])], sourceFor: sources() });
    expect(picked.label).toBe(unpicked.label);
    expect(picked.tiles.map((tile) => tile.trust.state)).toEqual(unpicked.tiles.map((tile) => tile.trust.state));
    // The run of a tile carries the same joins, so the reader's label agrees with the page's.
    const kpiRun = { status: 'ok', tileType: 'dataset', dataset: { trust: 'certified', joins: [{ trust: 'review_required' }] } };
    expect(readerTileTrust({ query: { dimensions: [] } }, kpiRun)?.state).toBe(appTileTrustFor(unpicked, 'overview', 'kpi')?.trust.state);
    // Without the filter, the KPI and the trend read only their own certified fields.
    const unfiltered = appTrustAnswer({ pages: [salesPage([])], sourceFor: sources() });
    expect(unfiltered.label).toBe('3 of 4 tiles certified');
  });

  it('allowing data that needs review publishes those tiles but never reads as every check passed', () => {
    const allowed = appTrustAnswer({ pages: [salesPage()], sourceFor: sources(), sourcePolicy: 'include_review_required' });
    expect(allowed.reviewAllowed).toBe(3);
    expect(allowed.label).toBe('1 of 4 tiles certified');
    expect(publishReadyLine(allowed)).toEqual({ detail: '3 tiles need review (allowed)', allPassed: false });
    const one = appTrustAnswer({ pages: [salesPage([])], sourceFor: sources(), sourcePolicy: 'include_review_required' });
    expect(publishReadyLine(one).detail).toBe('1 tile needs review (allowed)');
    expect(appTrustAnswer({ pages: [salesPage()], sourceFor: sources() }).reviewAllowed).toBe(0);
  });

  it('says all data certified only when every tile, joins included, is certified', () => {
    const answer = appTrustAnswer({ pages: [salesPage()], sourceFor: sources({ orders: { ...certifiedOrders, capabilities: { dataset: certifiedJoins } } }) });
    expect(answer.allCertified).toBe(true);
    expect(answer.label).toBe('All data certified');
    expect(publishReadyLine(answer)).toEqual({ detail: 'Every check passed.', allPassed: true });
    // A settled run that found the join certified since counts as current evidence.
    const ran = appTrustAnswer({ pages: [salesPage()], sourceFor: sources(), joinTrust: () => 'certified' });
    expect(ran.allCertified).toBe(true);
  });

  it('a calculation reads Governed and a source nobody certified reads Needs certifying, so neither is certified', () => {
    const page = salesPage([]);
    const calc: AppTrustPageLike = { ...page, layout: { items: [{ i: 'aov', title: 'AOV', sourceId: 'orders', query: { dimensions: [], calculations: [{ expr: { op: 'div' } }] } }] } };
    const governed = appTrustAnswer({ pages: [calc], sourceFor: sources({ orders: { ...certifiedOrders, capabilities: { dataset: certifiedJoins } } }) });
    expect(governed.tiles[0]!.trust.state).toBe('governed');
    expect(governed.allCertified).toBe(false);
    expect(governed.label).toBe('0 of 1 tile certified');
    const checked = appTrustAnswer({ pages: [page], sourceFor: sources({ orders: { ...certifiedOrders, lifecycle: 'review', trustState: 'review_required', checked: true } }) });
    expect(checked.tiles.find((tile) => tile.tileId === 'kpi')!.trust.label).toBe('Needs certifying');
    expect(checked.certified).toBe(1);
  });

  it('every page counts, and the stored counts read back the same words', () => {
    const answer = appTrustAnswer({ pages: [salesPage(), { ...salesPage([]), id: 'detail' }], sourceFor: sources() });
    expect(answer.total).toBe(8);
    expect(answer.certified).toBe(4);
    expect(publishedTileTrustText({ certified: answer.certified, total: answer.total })).toBe(answer.text);
    expect(publishedTileTrustText({ certified: 4, total: 4 })).toBe('All 4 tiles certified');
  });
});

describe('a certifier is named as themselves', () => {
  it('a team mailbox keeps its domain; a person reads by name', () => {
    expect(certifierDisplayName('analytics@jaffle.shop')).toBe('Analytics (jaffle.shop)');
    expect(certifierDisplayName('kranthi@acme.com')).toBe('Kranthi');
    expect(certifierDisplayName('232610070+duckcode-ai@users.noreply.github.com')).toBe('Duckcode Ai');
    expect(certifiedByLabel({ by: 'analytics@jaffle.shop', at: '2026-10-16T12:00:00Z' }, new Date('2026-10-22T00:00:00Z'))).toBe('Certified by Analytics (jaffle.shop) · 16 Oct');
    // Only the server's comparison with the viewer's own identity makes it "you".
    expect(certifiedByLabel({ by: 'analytics@jaffle.shop', at: '2026-10-16T12:00:00Z', byYou: true }, new Date('2026-10-22T00:00:00Z'))).toBe('Certified by you · 16 Oct');
  });
});
