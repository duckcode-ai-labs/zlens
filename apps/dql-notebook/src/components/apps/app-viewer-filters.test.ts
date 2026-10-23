import { describe, expect, it, vi } from 'vitest';
import type { DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import {
  applyViewerFilterChoice,
  viewerFilterPageVariables,
  viewerFilterReach,
  viewerFiltersForRun,
  type ViewerDashboardFilter,
} from './dashboard-filters';

/**
 * "Filter by… → Product Name → tangaroo → Apply" used to write the value into
 * the page's declared-filter state, which only ever applies filters the page
 * declares — so no value reached the run and nothing narrowed. These pin the
 * replacement path: the choice is held as a viewer filter and every run of the
 * page carries it.
 */
const page = {
  version: 1,
  id: 'overview',
  metadata: { title: 'Jaffle Growth Review' },
  filters: [{ id: 'region', type: 'select' }],
  layout: {
    kind: 'grid',
    cols: 12,
    rowHeight: 80,
    items: [
      { i: 'beverage-products', title: 'Top beverage products', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'beverage_revenue_by_product' }, viz: { type: 'bar' } },
      { i: 'monthly-revenue', title: 'Monthly gross revenue', x: 6, y: 0, w: 6, h: 4, block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } },
      { i: 'note', title: 'Note', x: 0, y: 4, w: 12, h: 1, text: { markdown: 'Read me' }, viz: { type: 'text' } },
    ],
  },
} as unknown as DashboardDocumentResponse['dashboard'];

const tangaroo: ViewerDashboardFilter = { column: 'product_name', value: 'tangaroo', tileIds: ['beverage-products'] };

describe('App viewer filters: the run carries the choice', () => {
  it('adds a choice, and a second choice on the same column replaces its value', () => {
    const once = applyViewerFilterChoice([], tangaroo);
    expect(once).toEqual([tangaroo]);
    const changed = applyViewerFilterChoice(once, { ...tangaroo, value: ' vanilla ice ' });
    expect(changed).toEqual([{ ...tangaroo, value: 'vanilla ice' }]);
    expect(applyViewerFilterChoice(changed, { column: 'customer_name', value: 'Ann', tileIds: [] })).toHaveLength(2);
  });

  it('ignores an empty value instead of filtering to nothing', () => {
    expect(applyViewerFilterChoice([tangaroo], { column: 'customer_name', value: '  ', tileIds: [] })).toEqual([tangaroo]);
  });

  it('sends the column, its value and the tiles it was shown to narrow', () => {
    expect(viewerFiltersForRun(page, [tangaroo])).toEqual([
      { column: 'product_name', values: ['tangaroo'], tileIds: ['beverage-products'] },
    ]);
  });

  it('never sends a column the page has since declared (the declared control owns it)', () => {
    expect(viewerFiltersForRun(page, [{ column: 'Region', value: 'EMEA', tileIds: [] }])).toEqual([]);
  });

  it('adds the value to the page scope that the story, Ask and tile notices read', () => {
    const declared = { region: '' };
    expect(viewerFilterPageVariables(declared, viewerFiltersForRun(page, [tangaroo]))).toEqual({ region: '', product_name: 'tangaroo' });
    // With no viewer filter the declared object is passed through untouched.
    expect(viewerFilterPageVariables(declared, [])).toBe(declared);
  });

  it('reports reach from what the server applied once the run settles', () => {
    const run = { tiles: [
      { tileId: 'beverage-products', status: 'ok', filters: { applied: [{ filter: 'product_name', mode: 'predicate' }] } },
      { tileId: 'monthly-revenue', status: 'ok', filters: { applied: [], skipped: [{ filter: 'product_name', reason: 'no binding' }] } },
      { tileId: 'note', status: 'ok', tileType: 'text' },
    ] } as unknown as DashboardRunResponse;
    expect(viewerFilterReach(page, run, tangaroo)).toEqual({
      applied: ['beverage-products'],
      unaffected: [{ tileId: 'monthly-revenue', title: 'Monthly gross revenue' }],
      filterable: 2,
      settled: true,
    });
    // While the filtered run is in flight, the chip shows what was promised.
    expect(viewerFilterReach(page, null, tangaroo)).toMatchObject({ applied: ['beverage-products'], settled: false });
  });
});

describe('App viewer filters: each tile says whether it was filtered', () => {
  const notices = async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    return (await import('./DashboardRenderer')).dashboardTileFilterNotices;
  };
  const [products, trend] = page.layout.items;

  it('stays quiet on a tile the server filtered, though the page never declared the filter', async () => {
    const dashboardTileFilterNotices = await notices();
    expect(dashboardTileFilterNotices({
      item: products!,
      tile: { tileId: 'beverage-products', status: 'ok', tileType: 'block', filters: { applied: [{ filter: 'product_name', mode: 'predicate' }] } } as never,
      activeVariables: { product_name: 'tangaroo' },
      viewerFilterIds: ['product_name'],
    }).unfilteredNotice).toBeNull();
  });

  it('says so on a tile the filter could not reach', async () => {
    const dashboardTileFilterNotices = await notices();
    expect(dashboardTileFilterNotices({
      item: trend!,
      tile: { tileId: 'monthly-revenue', status: 'ok', tileType: 'block', filters: { applied: [], skipped: [{ filter: 'product_name', reason: 'no binding' }] } } as never,
      activeVariables: { product_name: 'tangaroo' },
      viewerFilterIds: ['product_name'],
    }).unfilteredNotice).toMatchObject({ label: 'Not filtered by Product Name' });
  });

  it('says so on a Dataset tile, which a viewer filter never reaches', async () => {
    const dashboardTileFilterNotices = await notices();
    expect(dashboardTileFilterNotices({
      item: { ...trend!, query: { dimensions: [{ field: 'month' }], measures: [{ measure: 'revenue' }] } } as never,
      tile: { tileId: 'monthly-revenue', status: 'ok', tileType: 'dataset', dataset: { unboundFilters: [] } } as never,
      activeVariables: { product_name: 'tangaroo' },
      viewerFilterIds: ['product_name'],
    }).unfilteredNotice).toMatchObject({ label: 'Not filtered by Product Name' });
  });
});
