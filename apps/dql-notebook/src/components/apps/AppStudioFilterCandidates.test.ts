import { describe, expect, it } from 'vitest';
import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../api/client';
import {
  datasetFilterBindingsForSelection,
  defaultStudioFilterType,
  discoverAppFilterCandidates,
  discoverPageFilterCandidates,
  filterLinkSuggestions,
  filterPrimarySourceId,
  filterTileMappingsForField,
  initialFilterMappingKeys,
  tileFilterOfferOperations,
  tileFilterOffers,
  type StudioFilterTileMapping,
} from './app-studio-filter-candidates';

describe('App Studio filter discovery (UI-022)', () => {
  it('keeps an exact Dataset component selection, including an intentional empty set', () => {
    const mappings: StudioFilterTileMapping[] = [
      {
        key: 'overview:revenue', pageId: 'overview', pageTitle: 'Overview', tileId: 'revenue', tileTitle: 'Revenue',
        sourceName: 'Orders', supported: true, datasetId: 'orders', datasetField: 'region',
      },
      {
        key: 'overview:monthly-revenue', pageId: 'overview', pageTitle: 'Overview', tileId: 'monthly-revenue', tileTitle: 'Monthly Revenue',
        sourceName: 'Orders', supported: true, datasetId: 'orders', datasetField: 'region',
      },
    ];

    expect(datasetFilterBindingsForSelection(mappings, new Set(['overview:revenue']))).toEqual({
      orders: { field: 'region', tileIds: ['revenue'] },
    });
    expect(datasetFilterBindingsForSelection(mappings, new Set())).toEqual({
      orders: { field: 'region', tileIds: [] },
    });
  });

  it('infers warehouse timestamp columns as date range controls', () => {
    expect(defaultStudioFilterType('first_ordered_at')).toBe('daterange');
    expect(defaultStudioFilterType('created_on')).toBe('daterange');
    expect(defaultStudioFilterType('customer_name')).toBe('select');
  });

  it('derives candidates from every governed source already used on the page', () => {
    const page = {
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          { i: 'revenue-chart', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } },
          { i: 'revenue-table', x: 6, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'table' } },
          { i: 'orders', x: 0, y: 4, w: 6, h: 4, block: { blockId: 'orders' }, viz: { type: 'bar' } },
        ],
      },
    } as AppStudioBuildDraft['pages'][number];
    const catalog = [
      { id: 'monthly_revenue', name: 'Monthly revenue', filterIds: ['order_date', 'customer_segment'] },
      { id: 'orders', name: 'Orders', filterIds: ['order_date', 'status'] },
    ] as AppBlockRecommendation[];

    expect(discoverPageFilterCandidates(page, catalog)).toEqual([
      { id: 'customer_segment', sourceNames: ['Monthly revenue'], affectedTileCount: 2, pageCount: 1 },
      { id: 'order_date', sourceNames: ['Monthly revenue', 'Orders'], affectedTileCount: 3, pageCount: 1 },
      { id: 'status', sourceNames: ['Orders'], affectedTileCount: 1, pageCount: 1 },
    ]);
  });

  it('discovers governed semantic dimensions and explains incompatible components across pages', () => {
    const pages = [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          { i: 'revenue', title: 'Revenue', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } },
          {
            i: 'segments', title: 'Segments', x: 6, y: 0, w: 6, h: 4,
            semantic: {
              id: 'segment_metrics', provider: 'metricflow', metrics: ['revenue'], dimensions: ['customer_segment'],
              semanticModelRefs: ['orders'], definitionFingerprint: 'sha256:semantic',
            },
            viz: { type: 'bar' },
          },
        ],
      },
    }, {
      version: 2,
      id: 'detail',
      metadata: { title: 'Detail' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{ i: 'orders', title: 'Orders', x: 0, y: 0, w: 12, h: 4, block: { blockId: 'orders' }, viz: { type: 'table' } }],
      },
    }] as AppStudioBuildDraft['pages'];
    const catalog = [
      { id: 'monthly_revenue', name: 'Monthly revenue', filterIds: ['order_date', 'customer_segment'] },
      { id: 'orders', name: 'Orders', filterIds: ['order_date'] },
    ] as AppBlockRecommendation[];

    expect(discoverAppFilterCandidates(pages, catalog)).toContainEqual({
      id: 'customer_segment',
      sourceNames: ['Monthly revenue', 'Segment Metrics'],
      affectedTileCount: 2,
      pageCount: 1,
    });
    expect(discoverAppFilterCandidates(pages, catalog)).toContainEqual({
      id: 'order_date',
      sourceNames: ['Monthly revenue', 'Orders'],
      affectedTileCount: 2,
      pageCount: 2,
    });

    expect(filterTileMappingsForField(pages, catalog, 'customer_segment')).toEqual([
      expect.objectContaining({ key: 'overview:revenue', supported: true, mode: 'predicate' }),
      expect.objectContaining({ key: 'overview:segments', supported: true, mode: 'semantic' }),
      expect.objectContaining({ key: 'detail:orders', supported: false, reason: 'Orders has no Customer Segment field.' }),
    ]);
  });

  it('offers only server-approved settled result columns as filter bindings', () => {
    const pages = [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{ i: 'trend', title: 'Revenue trend', x: 0, y: 0, w: 12, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } }],
      },
    }] as AppStudioBuildDraft['pages'];
    const catalog = [{ id: 'monthly_revenue', name: 'Monthly revenue', filterIds: [] }] as unknown as AppBlockRecommendation[];
    const runtimeFields = {
      overview: {
        trend: [{ column: 'month', predicateTarget: 'orders.order_date' }],
      },
    };

    expect(discoverAppFilterCandidates(pages, catalog, runtimeFields)).toEqual([{
      id: 'month',
      sourceNames: ['Monthly revenue'],
      affectedTileCount: 1,
      pageCount: 1,
    }]);
    expect(filterTileMappingsForField(pages, catalog, 'month', runtimeFields)).toEqual([
      expect.objectContaining({ supported: true, binding: 'month', mode: 'predicate' }),
    ]);
  });

  it('offers certified block dimensions even when the block has no parameter filters', () => {
    const pages = [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          { i: 'trend', title: 'Revenue trend', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } },
          { i: 'table', title: 'Revenue table', x: 6, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'table' } },
        ],
      },
    }] as AppStudioBuildDraft['pages'];
    const catalog = [{
      id: 'monthly_revenue', name: 'Monthly revenue', filterIds: [], dimensionIds: ['month'],
    }] as unknown as AppBlockRecommendation[];

    expect(discoverAppFilterCandidates(pages, catalog)).toEqual([{
      id: 'month',
      sourceNames: ['Monthly revenue'],
      affectedTileCount: 2,
      pageCount: 1,
    }]);
  });

  it('restores filter capabilities from canonical draft bindings when the source is off-page', () => {
    const pages = [{
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{
          i: 'orders', title: 'Orders by region', x: 0, y: 0, w: 6, h: 4,
          sourceId: 'app:block:sales:orders', sourceRevision: 'sha256:orders',
          block: { ref: 'blocks/sales/orders.dql' }, viz: { type: 'bar' },
        }],
      },
    }] as AppStudioBuildDraft['pages'];
    const boundSources = [{
      id: 'app:block:sales:orders', kind: 'block', sourceRef: 'blocks/sales/orders.dql',
      sourceRevision: 'sha256:orders', sourceFingerprint: 'sha256:orders', lifecycle: 'draft',
      qualifiedIdentity: 'sales::block::Orders by Region', trustState: 'review_required', reviewStatus: 'required',
      capabilities: {
        measures: ['orders'], dimensions: ['region'], outputs: ['orders', 'region'],
        filters: ['order_date'], allowedVisualizations: ['bar'], parameters: [],
      },
    }] as AppStudioBuildDraft['sources'];

    expect(discoverAppFilterCandidates(pages, [], {}, boundSources)).toEqual([
      { id: 'order_date', sourceNames: ['Orders by Region'], affectedTileCount: 1, pageCount: 1 },
      { id: 'region', sourceNames: ['Orders by Region'], affectedTileCount: 1, pageCount: 1 },
    ]);
  });

  it('maps a field-based Dataset filter by exact Dataset binding, never by a matching source field name', () => {
    const descriptor = {
      version: 1,
      id: 'orders', kind: 'block', sourceRevision: 'sha256:orders', snapshotId: 'snapshot-orders',
      contractRef: { kind: 'block_source', id: 'commerce::orders', fingerprint: 'sha256:contract-orders' },
      binding: { sourceQualifiedId: 'commerce::orders', sourceRevision: 'sha256:orders', contractFingerprint: 'sha256:contract-orders', state: 'target_required', proofId: 'proof-orders' },
      label: 'Orders', lifecycle: 'certified', trust: 'certified',
      grain: { entityIds: ['order_line'], keyFields: ['order_line_id'], keyEvidence: 'proof-orders' },
      fields: [
        { kind: 'physical', name: 'region', qualifiedId: 'commerce::orders::region', type: 'string', role: 'dimension', status: 'approved' },
        { kind: 'physical', name: 'order_line_id', qualifiedId: 'commerce::orders::order_line_id', type: 'string', role: 'key', status: 'approved' },
        { kind: 'measure', name: 'revenue', qualifiedId: 'commerce::orders::revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
      ], operations: ['filter', 'group'], execution: { route: 'certified' },
    } as const;
    const pages = [{
      version: 3,
      id: 'overview',
      metadata: { title: 'Overview' },
      datasets: [{ id: 'dataset-orders', sourceId: 'source-orders', sourceRevision: 'sha256:orders', snapshotId: 'snapshot-orders', contractFingerprint: 'sha256:contract-orders' }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [{
          i: 'orders-by-region', title: 'Orders by region', x: 0, y: 0, w: 6, h: 4,
          sourceId: 'source-orders', sourceRevision: 'sha256:orders',
          query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], respectsGlobalFilters: true },
          viz: { type: 'bar' },
        }],
      },
    }] as unknown as AppStudioBuildDraft['pages'];
    const boundSources = [{
      id: 'source-orders', kind: 'block', sourceRef: 'blocks/orders.dql', sourceRevision: 'sha256:orders', sourceFingerprint: 'sha256:orders',
      qualifiedIdentity: 'commerce::orders', lifecycle: 'certified', trustState: 'certified', reviewStatus: 'not_required',
      capabilities: { measures: ['revenue'], dimensions: ['region'], outputs: ['revenue', 'region'], filters: [], allowedVisualizations: ['bar'], parameters: [], dataset: descriptor },
    }] as unknown as AppStudioBuildDraft['sources'];

    expect(discoverAppFilterCandidates(pages, [], {}, boundSources)).toEqual([{
      id: 'order_line_id', sourceNames: ['Orders'], affectedTileCount: 1, pageCount: 1,
    }, {
      id: 'region', sourceNames: ['Orders'], affectedTileCount: 1, pageCount: 1,
    }]);
    expect(filterTileMappingsForField(pages, [], 'region', {}, boundSources)).toEqual([
      expect.objectContaining({
        key: 'overview:orders-by-region', supported: true, datasetId: 'dataset-orders', datasetField: 'region',
        sourceId: 'source-orders', sourceRevision: 'sha256:orders',
      }),
    ]);
    expect(filterTileMappingsForField(pages, [], 'revenue', {}, boundSources)[0]).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/^Orders has no .+ field\.$/),
    });
  });

  it('D10 suggests other Datasets with the same field, unchecked, and links one only when checked', () => {
    const datasetSource = (id: string, label: string, regionType: 'string' | 'number') => ({
      id, kind: 'governed_block', sourceRef: id, qualifiedIdentity: `commerce::block::${label}::abc123`, sourceRevision: `rev-${id}`,
      trustState: 'certified', reviewStatus: 'approved',
      capabilities: {
        measures: [], dimensions: [], outputs: [], filters: [], parameters: [],
        dataset: {
          id: `dataset.${id}`, kind: 'block', label, operations: ['group'],
          fields: [
            { name: 'revenue', kind: 'measure', status: 'approved', aggregation: 'sum' },
            { name: 'Region', qualifiedId: 'region', kind: 'physical', status: 'approved', role: regionType === 'number' ? 'attribute' : 'dimension', type: regionType },
          ],
        },
      },
    });
    const sources = [
      datasetSource('orders', 'Orders', 'string'),
      datasetSource('customers', 'Journey Customers', 'string'),
      datasetSource('codes', 'Region codes', 'number'),
    ] as unknown as AppStudioBuildDraft['sources'];
    const tile = (i: string, sourceId: string) => ({ i, title: i, x: 0, y: 0, w: 4, h: 3, sourceId, sourceRevision: `rev-${sourceId}`, query: { measures: [{ measure: 'revenue' }], dimensions: [{ field: 'region' }] }, viz: { type: 'bar' } });
    const pages = [{
      version: 3,
      id: 'overview',
      metadata: { title: 'Overview' },
      datasets: sources.map((source) => ({ id: `ds_${source.id}`, sourceId: source.id, sourceRevision: `rev-${source.id}`, snapshotId: 's', contractFingerprint: 'f' })),
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [tile('orders-by-region', 'orders'), tile('customers-by-region', 'customers'), tile('codes', 'codes')] },
    }] as unknown as AppStudioBuildDraft['pages'];

    const mappings = filterTileMappingsForField(pages, [], 'region', {}, sources);
    const primary = filterPrimarySourceId(mappings, 'overview');
    expect(primary).toBe('orders');
    // A new filter starts linked to the picked field's Dataset only.
    const initial = new Set(initialFilterMappingKeys(mappings, primary));
    expect([...initial]).toEqual(['overview:orders-by-region']);

    const suggestions = filterLinkSuggestions(mappings, primary, sources);
    expect(suggestions).toEqual([{ sourceId: 'customers', datasetName: 'Journey Customers', field: 'Region', mappingKeys: ['overview:customers-by-region'], tileCount: 1 }]);
    // Unchecked: the other Dataset's binding records no tiles.
    expect(datasetFilterBindingsForSelection(mappings, initial)).toMatchObject({
      ds_orders: { field: 'Region', tileIds: ['orders-by-region'] },
      ds_customers: { field: 'Region', tileIds: [] },
    });
    // Checking the suggestion adds its explicit Dataset binding.
    const checked = new Set([...initial, ...suggestions[0]!.mappingKeys]);
    expect(datasetFilterBindingsForSelection(mappings, checked).ds_customers).toEqual({ field: 'Region', tileIds: ['customers-by-region'] });
  });

  it('D2 offers a tile whose Dataset joins to the field\'s table as linkable "via" the join, unchecked, and one filter candidate', () => {
    const own = (name: string, type = 'string') => ({ kind: 'physical', name, qualifiedId: name, type, role: 'dimension', status: 'approved' });
    const customers = {
      id: 'customers', kind: 'governed_block', sourceRef: 'customers', qualifiedIdentity: 'shop::block::Customers::abc', sourceRevision: 'rev-customers', trustState: 'certified', reviewStatus: 'approved',
      capabilities: { measures: [], dimensions: [], outputs: [], filters: [], parameters: [], dataset: {
        id: 'dataset.customers', kind: 'block', label: 'Customers', operations: ['group'],
        fields: [{ name: 'customer_count', kind: 'measure', status: 'approved', aggregation: 'count_distinct' }, own('customer_id'), own('customer_name')],
      } },
    };
    const orders = {
      id: 'orders', kind: 'governed_block', sourceRef: 'orders', qualifiedIdentity: 'shop::block::Orders::def', sourceRevision: 'rev-orders', trustState: 'certified', reviewStatus: 'approved',
      capabilities: { measures: [], dimensions: [], outputs: [], filters: [], parameters: [], dataset: {
        id: 'dataset.orders', kind: 'block', label: 'Orders', operations: ['group', 'trend'],
        fields: [
          { name: 'order_total', kind: 'measure', status: 'approved', aggregation: 'sum' },
          own('customer_id'),
          own('ordered_at', 'timestamp'),
          { ...own('customer__customer_name'), related: { join: 'customer', column: 'customer_name' } },
        ],
        joins: [{ id: 'customer', label: 'Customer', table: 'customers', relation: '"main"."customers"', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', trust: 'certified', origin: 'model', relationshipId: 'r', uniqueness: 'current', sentence: 'each order has one customer' }],
      } },
    };
    const sources = [customers, orders] as unknown as AppStudioBuildDraft['sources'];
    const pages = [{
      version: 3,
      id: 'overview',
      metadata: { title: 'Overview' },
      datasets: sources.map((source) => ({ id: `ds_${source.id}`, sourceId: source.id, sourceRevision: `rev-${source.id}`, snapshotId: 's', contractFingerprint: 'f' })),
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
        { i: 'trend', title: 'Orders trend', x: 0, y: 0, w: 6, h: 3, sourceId: 'orders', sourceRevision: 'rev-orders', query: { measures: [{ measure: 'order_total' }], dimensions: [{ field: 'ordered_at', timeGrain: 'month' }] }, viz: { type: 'line' } },
        { i: 'people', title: 'Customers', x: 6, y: 0, w: 6, h: 3, sourceId: 'customers', sourceRevision: 'rev-customers', query: { measures: [{ measure: 'customer_count' }], dimensions: [{ field: 'customer_name' }] }, viz: { type: 'bar' } },
      ] },
    }] as unknown as AppStudioBuildDraft['pages'];

    // One "Customer Name" candidate, reaching both tiles: the related field is the same filter.
    const candidates = discoverAppFilterCandidates(pages, [], {}, sources);
    expect(candidates.find((candidate) => candidate.id === 'customer_name')).toMatchObject({ affectedTileCount: 2, sourceNames: ['Customers', 'Orders'] });
    expect(candidates.some((candidate) => candidate.id === 'customer__customer_name')).toBe(false);

    const mappings = filterTileMappingsForField(pages, [], 'customer_name', {}, sources);
    expect(mappings.find((mapping) => mapping.tileId === 'trend')).toMatchObject({ supported: true, datasetId: 'ds_orders', datasetField: 'customer__customer_name', via: 'Customer' });
    // The table with the column of its own is the filter's own Dataset, though the trend comes first on the page.
    const primary = filterPrimarySourceId(mappings, 'overview');
    expect(primary).toBe('customers');
    // Never automatic: the trend is offered, unchecked.
    const initial = new Set(initialFilterMappingKeys(mappings, primary));
    expect([...initial]).toEqual(['overview:people']);
    expect(filterLinkSuggestions(mappings, primary, sources)).toEqual([{ sourceId: 'orders', datasetName: 'Orders', field: 'customer__customer_name', via: 'Customer', mappingKeys: ['overview:trend'], tileCount: 1 }]);
    expect(datasetFilterBindingsForSelection(mappings, new Set([...initial, 'overview:trend'])).ds_orders).toEqual({ field: 'customer__customer_name', tileIds: ['trend'] });
  });
});


/** A shop page: Customers (its own Customer Name, main date First Ordered At) and Orders (main date Ordered At, Customer Name via its Customer join). */
function joinedShop(extraItems: unknown[] = [], filters: unknown[] = []) {
  const own = (name: string, type = 'string', primary = false) => ({ kind: 'physical', name, qualifiedId: name, type, role: type === 'timestamp' ? 'time' : 'dimension', status: 'approved', ...(type === 'timestamp' ? { time: { grains: ['month'], ...(primary ? { primary: true } : {}) } } : {}) });
  const customers = {
    id: 'customers', kind: 'governed_block', sourceRef: 'customers', qualifiedIdentity: 'shop::block::Customers::abc', sourceRevision: 'rev-customers', trustState: 'certified', reviewStatus: 'approved',
    capabilities: { measures: [], dimensions: [], outputs: [], filters: [], parameters: [], dataset: {
      id: 'dataset.customers', kind: 'block', label: 'Customers', operations: ['group'],
      fields: [{ name: 'customer_count', kind: 'measure', status: 'approved', aggregation: 'count_distinct' }, own('customer_id'), own('customer_name'), own('last_ordered_at', 'timestamp'), own('first_ordered_at', 'timestamp', true)],
    } },
  };
  const orders = {
    id: 'orders', kind: 'governed_block', sourceRef: 'orders', qualifiedIdentity: 'shop::block::Orders::def', sourceRevision: 'rev-orders', trustState: 'certified', reviewStatus: 'approved',
    capabilities: { measures: [], dimensions: [], outputs: [], filters: [], parameters: [], dataset: {
      id: 'dataset.orders', kind: 'block', label: 'Orders', operations: ['group', 'trend'],
      fields: [
        { name: 'order_total', kind: 'measure', status: 'approved', aggregation: 'sum' },
        own('customer_id'),
        own('ordered_at', 'timestamp', true),
        { ...own('customer__customer_name'), related: { join: 'customer', column: 'customer_name' } },
        { ...own('customer__first_ordered_at', 'timestamp'), related: { join: 'customer', column: 'first_ordered_at' } },
      ],
      joins: [{ id: 'customer', label: 'Customer', table: 'customers', relation: '"main"."customers"', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', trust: 'certified', origin: 'model', relationshipId: 'r', uniqueness: 'current', sentence: 'each order has one customer' }],
    } },
  };
  const sources = [customers, orders] as unknown as AppStudioBuildDraft['sources'];
  const pages = [{
    version: 3,
    id: 'overview',
    metadata: { title: 'Overview' },
    datasets: sources.map((source) => ({ id: `ds_${source.id}`, sourceId: source.id, sourceRevision: `rev-${source.id}`, snapshotId: 's', contractFingerprint: 'f' })),
    filters,
    layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
      { i: 'people', title: 'Customers', x: 6, y: 0, w: 6, h: 3, sourceId: 'customers', sourceRevision: 'rev-customers', query: { measures: [{ measure: 'customer_count' }], dimensions: [{ field: 'customer_name' }] }, viz: { type: 'bar' } },
      { i: 'trend', title: 'Orders trend', x: 0, y: 0, w: 6, h: 3, sourceId: 'orders', sourceRevision: 'rev-orders', query: { measures: [{ measure: 'order_total' }], dimensions: [{ field: 'ordered_at', timeGrain: 'month' }] }, viz: { type: 'line' } },
      ...extraItems,
    ] },
  }] as unknown as AppStudioBuildDraft['pages'];
  return { sources, pages };
}

const customerNameFilter = {
  id: 'customer_name', label: 'Customer Name', type: 'multiselect', bindsTo: 'customer_name', field: { name: 'customer_name' }, scope: { app: true },
  datasetBindings: { ds_customers: { field: 'customer_name', tileIds: ['people'] } },
};

describe('new tiles and existing filters (phase-4 review, problem 7)', () => {
  it('offers a page filter to a tile that can take it, through its join, and never links it on its own', () => {
    const revenue = { i: 'revenue', title: 'Revenue', x: 0, y: 3, w: 3, h: 2, sourceId: 'orders', sourceRevision: 'rev-orders', query: { measures: [{ measure: 'order_total' }], dimensions: [] }, viz: { type: 'kpi' } };
    const { sources, pages } = joinedShop([revenue], [customerNameFilter]);
    const offers = tileFilterOffers({ pages, pageId: 'overview', tileId: 'revenue', catalog: [], boundSources: sources });
    expect(offers.map((offer) => [offer.filterId, offer.filterLabel, offer.via, offer.mapping.datasetField])).toEqual([['customer_name', 'Customer Name', 'Customer', 'customer__customer_name']]);
    // The tile already in the filter's binding is not offered again.
    expect(tileFilterOffers({ pages, pageId: 'overview', tileId: 'people', catalog: [], boundSources: sources })).toEqual([]);

    // Apply: the Orders binding is added for that tile only.
    const operations = tileFilterOfferOperations(pages[0]!, offers[0]!);
    expect(operations).toHaveLength(1);
    const setFilter = operations[0] as { type: string; filter: { datasetBindings: Record<string, { field: string; tileIds?: string[] }> } };
    expect(setFilter.type).toBe('set_filter');
    expect(setFilter.filter.datasetBindings).toEqual({
      ds_customers: { field: 'customer_name', tileIds: ['people'] },
      ds_orders: { field: 'customer__customer_name', tileIds: ['revenue'] },
    });
    // After applying, the tile takes the filter and the offer is gone.
    const applied = [{ ...pages[0]!, filters: [setFilter.filter] }] as unknown as AppStudioBuildDraft['pages'];
    expect(tileFilterOffers({ pages: applied, pageId: 'overview', tileId: 'revenue', catalog: [], boundSources: sources })).toEqual([]);
  });

  it('joins an existing Dataset binding and clears an earlier "Does not apply"', () => {
    const revenue = { i: 'revenue', title: 'Revenue', x: 0, y: 3, w: 3, h: 2, sourceId: 'orders', sourceRevision: 'rev-orders', query: { measures: [{ measure: 'order_total' }], dimensions: [] }, viz: { type: 'kpi' }, filterBindings: [{ filter: 'customer_name', capability: 'unsupported', unsupportedReason: 'x' }] };
    const filter = { ...customerNameFilter, datasetBindings: { ...customerNameFilter.datasetBindings, ds_orders: { field: 'customer__customer_name', tileIds: ['trend'] } } };
    const { sources, pages } = joinedShop([revenue], [filter]);
    const [offer] = tileFilterOffers({ pages, pageId: 'overview', tileId: 'revenue', catalog: [], boundSources: sources });
    const operations = tileFilterOfferOperations(pages[0]!, offer!);
    expect((operations[0] as { filter: { datasetBindings: Record<string, unknown> } }).filter.datasetBindings.ds_orders).toEqual({ field: 'customer__customer_name', tileIds: ['revenue', 'trend'] });
    expect(operations[1]).toEqual({ type: 'update_tile', pageId: 'overview', tileId: 'revenue', patch: { filterBindings: [] } });
  });

  it('ranks a tile\'s own main date first: Ordered At before a customer\'s First Ordered At that reaches more tiles through a join', () => {
    const { sources, pages } = joinedShop([
      { i: 'trend2', title: 'Orders by week', x: 0, y: 3, w: 6, h: 3, sourceId: 'orders', sourceRevision: 'rev-orders', query: { measures: [{ measure: 'order_total' }], dimensions: [{ field: 'ordered_at', timeGrain: 'week' }] }, viz: { type: 'line' } },
    ]);
    const dates = discoverAppFilterCandidates(pages, [], {}, sources).filter((candidate) => /ordered_at$/.test(candidate.id));
    expect(dates.map((candidate) => [candidate.id, candidate.affectedTileCount, candidate.viaJoinCount ?? 0, candidate.mainDateTileCount ?? 0])).toEqual([
      ['ordered_at', 2, 0, 2],
      ['first_ordered_at', 3, 2, 1],
      ['last_ordered_at', 1, 0, 0],
    ]);
    // A tile without the filter's field offers its own main date first.
    const mapping = filterTileMappingsForField(pages, [], 'ordered_at', {}, sources, { dateFilter: true }).find((item) => item.tileId === 'people');
    expect(mapping?.dateFieldOptions?.map((option) => option.field)).toEqual(['first_ordered_at', 'last_ordered_at']);
  });
});
