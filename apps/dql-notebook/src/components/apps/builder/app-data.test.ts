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
  sourceCatalogKindLabel,
  splitAddDataCatalog,
  tilesUsingSource,
  unusedAppDataSources,
  unusedSourcesPublishNote,
} from './app-data';
import { draftRevenueQuery, draftWith, marginMetrics, orderLinesDataset, topCustomersQuery } from './app-data.fixtures';

describe('App data: one list per App (design D1, D3, D4)', () => {
  it('splits the trust-ordered catalog into Datasets & Metrics and Saved queries, keeping its order', () => {
    const { datasets, queries } = splitAddDataCatalog([orderLinesDataset, topCustomersQuery, marginMetrics, draftRevenueQuery]);
    expect(datasets.map((item) => item.name)).toEqual(['order_lines', 'margin']);
    expect(queries.map((item) => item.name)).toEqual(['top_customers', 'draft_revenue']);
    expect(sourceCatalogKindLabel(marginMetrics)).toBe('Metrics');
    expect(sourceCatalogKindLabel(topCustomersQuery)).toBe('Saved query');
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

  it('adds data that needs review only with an explicit choice, which also changes the data rule', () => {
    const blocked = planAddDataSource(draftWith(), draftRevenueQuery);
    expect(blocked).toMatchObject({ ok: false, code: 'REVIEW_POLICY_REQUIRED' });
    const allowed = planAddDataSource(draftWith(), draftRevenueQuery, { allowReview: true });
    expect(allowed.ok && allowed.operations).toEqual([
      { type: 'set_source_policy', sourcePolicy: 'include_review_required' },
      { type: 'upsert_source', source: expect.objectContaining({ id: draftRevenueQuery.sourceId, trustState: 'review_required', reviewStatus: 'required' }) },
    ]);
    const alreadyAllowed = planAddDataSource(draftWith({ sourcePolicy: 'include_review_required' }), draftRevenueQuery);
    expect(alreadyAllowed.ok && alreadyAllowed.operations.map((operation) => operation.type)).toEqual(['upsert_source']);
    expect(planAddDataSource(draftWith(), undefined)).toMatchObject({ ok: false, code: 'SOURCE_UNAVAILABLE' });
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
    expect(openCanvasLabel(0)).toBe('Open canvas');
    expect(openCanvasLabel(1)).toBe('Open canvas with 1 source');
    expect(openCanvasLabel(2)).toBe('Open canvas with 2 sources');
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
