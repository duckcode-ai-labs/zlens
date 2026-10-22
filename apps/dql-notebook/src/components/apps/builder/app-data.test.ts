import { describe, expect, it } from 'vitest';
import {
  addDataCatalogRequest,
  addDataDomainChips,
  appDataItems,
  appDataSourceFromCandidate,
  datasetSampleQuery,
  initialStudioStage,
  openCanvasLabel,
  planAddDataSource,
  planRemoveDataSource,
  addDataKindOf,
  canMakeRowLevel,
  filterAddDataCatalog,
  dataTrustLabel,
  savedQueryNeedsFields,
  sourceCatalogKindLabel,
  sourceKindLabel,
  sourceOriginLabel,
  tilesUsingSource,
  unusedAppDataSources,
  unusedSourcesPublishNote,
} from './app-data';
import { draftRevenueQuery, draftWith, marginMetrics, monthlyRevenueQuery, orderLinesDataset, ordersTableDataset, topCustomersQuery } from './app-data.fixtures';

describe('App data: one list per App (design D1, D3, D4)', () => {
  it('keeps one trust-ordered list and narrows it with the kind chips (design D1)', () => {
    const catalog = [ordersTableDataset, orderLinesDataset, monthlyRevenueQuery, topCustomersQuery, marginMetrics, draftRevenueQuery];
    expect(filterAddDataCatalog(catalog, 'all').map((item) => item.name)).toEqual(['orders', 'order_lines', 'monthly_revenue', 'top_customers', 'margin', 'draft_revenue']);
    expect(filterAddDataCatalog(catalog, 'tables').map((item) => item.name)).toEqual(['orders']);
    expect(filterAddDataCatalog(catalog, 'queries').map((item) => item.name)).toEqual(['order_lines', 'monthly_revenue', 'top_customers', 'draft_revenue']);
    expect(filterAddDataCatalog(catalog, 'metrics').map((item) => item.name)).toEqual(['margin']);
    expect(catalog.map(addDataKindOf)).toEqual(['tables', 'queries', 'queries', 'queries', 'metrics', 'queries']);
    expect(sourceCatalogKindLabel(marginMetrics)).toBe('Metrics');
    expect(sourceCatalogKindLabel(topCustomersQuery)).toBe('Saved query');
  });

  it('labels where data comes from: a table, a saved query (with result fields or made row-level) or Metrics', () => {
    expect(sourceOriginLabel(ordersTableDataset)).toBe('Table');
    expect(sourceOriginLabel(orderLinesDataset)).toBe('Saved query');
    expect(sourceOriginLabel(monthlyRevenueQuery)).toBe('Saved query');
    expect(sourceOriginLabel(topCustomersQuery)).toBe('Saved query');
    expect(sourceOriginLabel(marginMetrics)).toBe('Metrics');
    // Result fields keep a saved query a saved query, not a Dataset.
    expect(sourceCatalogKindLabel(monthlyRevenueQuery)).toBe('Saved query');
    expect(sourceKindLabel('block', monthlyRevenueQuery.capabilities)).toBe('Saved query');
    expect(sourceKindLabel('block', orderLinesDataset.capabilities)).toBe('Table');
    // Reading fields applies to a saved query without them; Make row-level to any saved query.
    expect([topCustomersQuery, monthlyRevenueQuery, orderLinesDataset, marginMetrics].map(savedQueryNeedsFields)).toEqual([true, false, false, false]);
    expect([topCustomersQuery, monthlyRevenueQuery, orderLinesDataset, marginMetrics].map(canMakeRowLevel)).toEqual([true, true, false, false]);
  });

  it('sends the chosen domain chip to the catalog, and none for All', () => {
    expect(addDataCatalogRequest({ query: ' orders ', domain: 'finance' })).toEqual({ query: 'orders', limit: 100, domains: ['finance'] });
    expect(addDataCatalogRequest({ query: '', domain: '' })).toEqual({ query: '', limit: 100 });
    expect(addDataCatalogRequest({ query: '', domain: '', cursor: 'c2' })).toMatchObject({ cursor: 'c2' });
  });

  it('offers the project domains, the App domain and the catalog domains as chips', () => {
    const chips = addDataDomainChips(
      [{ value: 'finance', label: 'Finance' }, { value: 'old', label: 'old (missing Domain page)', disabled: true }],
      { orders: 3, Unassigned: 2, general: 1, Finance: 1 },
      'commerce',
    );
    expect(chips).toEqual([
      { value: 'finance', label: 'Finance' },
      { value: 'commerce', label: 'commerce' },
      { value: 'orders', label: 'orders' },
    ]);
  });

  it('adds a source with upsert_source, built like the API builds a composed source', () => {
    const plan = planAddDataSource(draftWith(), orderLinesDataset);
    expect(plan).toEqual({ ok: true, operations: [{ type: 'upsert_source', source: appDataSourceFromCandidate(orderLinesDataset) }] });
    expect(appDataSourceFromCandidate(orderLinesDataset)).toMatchObject({
      id: 'app:block:commerce/order-lines', kind: 'block', sourceRef: 'blocks/commerce/order-lines.dql',
      executionRef: 'blocks/commerce/order-lines.dql', sourcePath: 'blocks/commerce/order-lines.dql',
      sourceRevision: 'sha256:rev', sourceFingerprint: 'sha256:rev', lifecycle: 'certified',
      trustState: 'certified', reviewStatus: 'not_required',
    });
    expect(appDataSourceFromCandidate(marginMetrics)).toMatchObject({ kind: 'governed_semantic' });
  });

  it('adds data nobody certified with one plain step, whatever an old App\'s data rule said (T3)', () => {
    const expected = [
      { type: 'upsert_source', source: expect.objectContaining({ id: draftRevenueQuery.sourceId, trustState: 'review_required', reviewStatus: 'required' }) },
    ];
    expect(planAddDataSource(draftWith(), draftRevenueQuery)).toEqual({ ok: true, operations: expected });
    expect(planAddDataSource(draftWith({ sourcePolicy: 'governed_only' }), draftRevenueQuery)).toEqual({ ok: true, operations: expected });
    expect(planAddDataSource(draftWith({ sourcePolicy: 'include_review_required' }), draftRevenueQuery, { allowReview: true })).toEqual({ ok: true, operations: expected });
    expect(planAddDataSource(draftWith(), undefined)).toMatchObject({ ok: false, code: 'SOURCE_UNAVAILABLE' });
  });

  it('lists certified data first in Add data, and keeps data nobody certified addable (T3)', () => {
    const listed = filterAddDataCatalog([draftRevenueQuery, topCustomersQuery], 'all');
    expect(listed.map((item) => item.id)).toEqual([topCustomersQuery.id, draftRevenueQuery.id]);
    expect(dataTrustLabel(draftRevenueQuery)).toBe('Not certified yet');
  });

  it('removes a source with remove_source, with the tiles that use it and their review tasks', () => {
    const source = appDataSourceFromCandidate(topCustomersQuery);
    const other = appDataSourceFromCandidate(orderLinesDataset);
    const draft = draftWith({
      sources: [source, other],
      items: [
        { i: 'top', x: 0, y: 0, w: 6, h: 4, sourceId: source.id, block: { ref: source.sourceRef }, viz: { type: 'table' }, title: 'Top customers' },
        { i: 'legacy', x: 6, y: 0, w: 6, h: 4, block: { blockId: 'blocks/top_customers.dql' }, viz: { type: 'table' } },
        { i: 'note', x: 0, y: 4, w: 12, h: 1, text: { markdown: 'Hi' }, viz: { type: 'text' } },
      ] as never,
      reviewTasks: [
        { id: 't1', message: 'Review', status: 'open', sourceId: source.id },
        { id: 't2', message: 'Tile', status: 'open', tileId: 'legacy' },
        { id: 't3', message: 'Other', status: 'open', sourceId: other.id },
      ],
    });
    expect(tilesUsingSource(draft, source.id).map((tile) => tile.tileId)).toEqual(['top', 'legacy']);
    expect(planRemoveDataSource(draft, source.id)).toEqual([
      { type: 'remove_tile', pageId: 'overview', tileId: 'top' },
      { type: 'remove_tile', pageId: 'overview', tileId: 'legacy' },
      { type: 'remove_source', sourceId: source.id },
      { type: 'remove_review_task', taskId: 't1' },
      { type: 'remove_review_task', taskId: 't2' },
    ]);
    expect(planRemoveDataSource(draft, other.id)).toEqual([
      { type: 'remove_source', sourceId: other.id },
      { type: 'remove_review_task', taskId: 't3' },
    ]);
  });

  it('lists the App data from the catalog when known, else from the card saved on the draft', () => {
    const dataset = appDataSourceFromCandidate(orderLinesDataset);
    const query = appDataSourceFromCandidate(topCustomersQuery);
    const text = { id: 'ask:1', kind: 'text' as const, sourceRef: 'ask:1', trustState: 'review_required' as const, reviewStatus: 'required' as const };
    const items = appDataItems([dataset, query, text], [topCustomersQuery]);
    expect(items).toHaveLength(2);
    expect(items[1]).toBe(topCustomersQuery);
    expect(items[0]).toMatchObject({ id: dataset.id, sourceId: dataset.id, name: 'Order lines', trust: 'certified', capabilities: dataset.capabilities });
  });

  it('notes connected sources that no tile uses; Publish does not save them', () => {
    const used = appDataSourceFromCandidate(orderLinesDataset);
    const unused = appDataSourceFromCandidate(topCustomersQuery);
    const draft = draftWith({
      sources: [used, unused],
      items: [{ i: 'rev', x: 0, y: 0, w: 6, h: 4, sourceId: used.id, query: { dimensions: [], measures: [{ measure: 'revenue' }] }, viz: { type: 'kpi' } }] as never,
    });
    expect(unusedAppDataSources(draft).map((source) => source.id)).toEqual([unused.id]);
    expect(unusedSourcesPublishNote(1)).toBe('1 data source not used by any tile will not be saved with the App.');
    expect(unusedSourcesPublishNote(3)).toBe('3 data sources not used by any tile will not be saved with the App.');
    expect(unusedSourcesPublishNote(0)).toBeNull();
  });

  it('starts a new App, manual or AI, at the Data step and everything else on the canvas', () => {
    expect(initialStudioStage({ mode: 'manual', resumingDraft: false, editingPublishedApp: false })).toBe('data');
    expect(initialStudioStage({ mode: 'ai', resumingDraft: false, editingPublishedApp: false })).toBe('data');
    expect(initialStudioStage({ mode: 'ai', resumingDraft: false, editingPublishedApp: true })).toBe('canvas');
    expect(initialStudioStage({ mode: 'manual', resumingDraft: true, editingPublishedApp: false })).toBe('canvas');
    expect(initialStudioStage({ mode: 'manual', resumingDraft: false, editingPublishedApp: true })).toBe('canvas');
    expect(openCanvasLabel(0)).toBe('Open blank Studio');
    expect(openCanvasLabel(1)).toBe('Open Studio with 1 source');
    expect(openCanvasLabel(2)).toBe('Open Studio with 2 sources');
  });

  it('reads sample rows only through a bounded row-detail query the Dataset allows', () => {
    const descriptor = orderLinesDataset.capabilities!.dataset!;
    expect(datasetSampleQuery(descriptor)).toEqual({
      dimensions: [], measures: [], detail: true, detailColumns: ['order_line_id', 'region', 'ordered_at'], limit: 10,
    });
    expect(datasetSampleQuery({ ...descriptor, operations: ['group'] })).toBeUndefined();
    expect(datasetSampleQuery(undefined)).toBeUndefined();
  });
});
