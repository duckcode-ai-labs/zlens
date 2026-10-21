import { describe, expect, it } from 'vitest';
import { dashboardTileFilterChoice, DASHBOARD_FILTER_DOES_NOT_APPLY_REASON } from './filter-reach.js';
import { parseDashboardDocument } from './dashboard-document.js';

const page = { datasets: [{ id: 'orders', sourceId: 'src-orders', sourceRevision: 'r1' }] };
const region = { id: 'region', datasetBindings: { orders: { field: 'region', tileIds: ['orders-table'] } } };

describe('dashboardTileFilterChoice', () => {
  it('reads Dataset links and exclusions from the filter datasetBindings', () => {
    const tile = { i: 'orders-table', query: {}, sourceId: 'src-orders', sourceRevision: 'r1', viz: { type: 'table' } };
    expect(dashboardTileFilterChoice(page, tile, region).choice).toBe('applies');
    expect(dashboardTileFilterChoice(page, { ...tile, i: 'orders-kpi' }, region).choice).toBe('does_not_apply');
    expect(dashboardTileFilterChoice(page, tile, { id: 'region' }).choice).toBe('unlinked');
  });

  it('treats a stored "Does not apply" binding as an explicit choice, not a missing link', () => {
    const tile = {
      i: 'top-customers', block: { blockId: 'top_customers' }, viz: { type: 'bar' },
      filterBindings: [{ filter: 'region', capability: 'unsupported', unsupportedReason: DASHBOARD_FILTER_DOES_NOT_APPLY_REASON }],
    };
    expect(dashboardTileFilterChoice(page, tile, region)).toEqual({ choice: 'does_not_apply', reason: DASHBOARD_FILTER_DOES_NOT_APPLY_REASON });
    expect(dashboardTileFilterChoice(page, { ...tile, filterBindings: [{ filter: 'region', unsupportedReason: 'Older exclusion' }] }, region).choice).toBe('does_not_apply');
    expect(dashboardTileFilterChoice(page, { ...tile, filterBindings: [] }, region).choice).toBe('unlinked');
  });

  it('counts tile filter bindings and dashboard parameter bindings as links', () => {
    const tile = { i: 'trend', semantic: {}, viz: { type: 'line' }, filterBindings: [{ filter: 'region', binding: 'region', mode: 'semantic', capability: 'preflight_required' }] };
    expect(dashboardTileFilterChoice(page, tile, region).choice).toBe('applies');
    expect(dashboardTileFilterChoice(page, {
      i: 'draft', draftAnalysis: {}, viz: { type: 'table' },
      parameterBindings: [{ param: 'region_param', source: 'dashboard_filter', filter: 'region' }],
    }, region).choice).toBe('applies');
  });

  it('never asks text tiles to choose and honours an explicit filter scope', () => {
    expect(dashboardTileFilterChoice(page, { i: 'note', text: { markdown: 'x' }, viz: { type: 'text' } }, region).choice).toBe('not_applicable');
    expect(dashboardTileFilterChoice(page, { i: 'trend', block: {}, viz: { type: 'line' } }, { id: 'region', scope: { tileIds: ['other'] } }).choice).toBe('does_not_apply');
  });
});

describe('"Does not apply" in the page file', () => {
  it('is stored in existing fields and survives a read and re-read unchanged', () => {
    const page = {
      version: 2,
      id: 'overview',
      metadata: { title: 'Overview' },
      filters: [{ id: 'region', type: 'select', label: 'Region' }],
      layout: {
        kind: 'grid', cols: 12, rowHeight: 80,
        items: [
          { i: 'linked', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'top_customers' }, viz: { type: 'table' },
            filterBindings: [{ filter: 'region', binding: 'region', mode: 'predicate', capability: 'preflight_required' }] },
          { i: 'excluded', x: 6, y: 0, w: 6, h: 4, block: { blockId: 'revenue_trend' }, viz: { type: 'line' },
            filterBindings: [{ filter: 'region', capability: 'unsupported', unsupportedReason: DASHBOARD_FILTER_DOES_NOT_APPLY_REASON }] },
          // An older page with no choice at all still reads; it is simply "unlinked".
          { i: 'legacy', x: 0, y: 4, w: 6, h: 4, block: { blockId: 'top_products' }, viz: { type: 'table' } },
        ],
      },
    };
    const first = parseDashboardDocument(JSON.stringify(page));
    expect(first.errors).toEqual([]);
    const again = parseDashboardDocument(JSON.stringify(first.document));
    expect(again.document).toEqual(first.document);
    const items = first.document!.layout.items;
    const filter = first.document!.filters![0]!;
    expect(items.map((item) => dashboardTileFilterChoice(first.document!, item, filter).choice)).toEqual(['applies', 'does_not_apply', 'unlinked']);
  });
});
