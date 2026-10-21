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
});
