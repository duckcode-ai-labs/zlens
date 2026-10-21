import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AppStudioV2Module from './AppStudioV2';
import { studioTileFilterNotices } from './app-studio-filter-notices';
import { datasetFilterBindingsForSelection, filterTileMappingsForField, studioFilterFieldOverrides } from './app-studio-filter-candidates';
import { filterValueCapHint, filterValueSearchRequest, matchFilterValues, searchFilterValues } from './filter-value-search';
import { FilterTileChoice, studioFilterMappingOptions } from './builder/GlobalFilterBar';
import { buildVizOption } from '../output/echarts/viz-option';

/**
 * Phase-2 new-user review fixes: filters show where they do not apply while
 * editing and in Preview, value lists search every value, a date filter maps
 * to a tile's own date field, and a KPI's "Rolled up" note never hides it.
 */

let studio: typeof AppStudioV2Module;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
  studio = await import('./AppStudioV2');
});

const page: any = {
  datasets: [
    { id: 'ds-revenue', sourceId: 'source.revenue', sourceRevision: 'rev-1' },
    { id: 'ds-customers', sourceId: 'source.customers', sourceRevision: 'rev-1' },
  ],
  filters: [
    { id: 'month', label: 'Month', type: 'daterange', datasetBindings: { 'ds-revenue': { field: 'month' } } },
    { id: 'customer_name', label: 'Customer Name', type: 'select', datasetBindings: { 'ds-customers': { field: 'customer_name' } } },
  ],
};
const revenueKpi = { i: 'revenue', query: { dimensions: [], measures: [{ measure: 'gross_revenue' }] }, sourceId: 'source.revenue', sourceRevision: 'rev-1', viz: { type: 'single_value' } };
const customerBars = { i: 'customers', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }] }, sourceId: 'source.customers', sourceRevision: 'rev-1', viz: { type: 'bar' } };

describe('"Not filtered by" in Edit and Preview (review problem 1)', () => {
  it('marks a revenue KPI the selected customer does not reach, in Edit and in Preview', () => {
    const values = { customer_name: 'Aaron Gardner' };
    for (const mode of ['edit', 'preview'] as const) {
      const notices = studioTileFilterNotices({ page, tile: revenueKpi, values, mode });
      expect(notices.map((notice) => notice.label)).toContain('Not filtered by Customer Name');
      expect(studioTileFilterNotices({ page, tile: customerBars, values, mode }).map((notice) => notice.label)).not.toContain('Not filtered by Customer Name');
    }
  });

  it('shows reach without a value only while editing, as readers see nothing until a value is set', () => {
    expect(studioTileFilterNotices({ page, tile: revenueKpi, values: {}, mode: 'edit' }).map((notice) => notice.label)).toEqual(['Not filtered by Customer Name']);
    expect(studioTileFilterNotices({ page, tile: revenueKpi, values: {}, mode: 'preview' })).toEqual([]);
    // A date range with neither end set is no value.
    expect(studioTileFilterNotices({ page, tile: customerBars, values: { month: { start: '', end: '' } }, mode: 'preview' })).toEqual([]);
  });

  it('takes the run\'s filter report as the server\'s word once it mentions the filter', () => {
    const values = { month: { start: '2025-01-01', end: '2025-06-30' } };
    const run = {
      tileId: 'customers', status: 'ok', tileType: 'dataset',
      filterReport: { applied: [], notApplied: [{ filter: 'month', code: 'not_linked', reason: 'Customer Profile has no Month field.' }] },
    } as any;
    const notices = studioTileFilterNotices({ page, tile: customerBars, run, values, mode: 'preview' });
    expect(notices).toEqual([expect.objectContaining({ label: 'Not filtered by Month', detail: 'Customer Profile has no Month field.' })]);
    // A run that applied it wins over the document.
    const applied = { ...run, filterReport: { applied: ['month'], notApplied: [] } };
    expect(studioTileFilterNotices({ page, tile: customerBars, run: applied, values, mode: 'preview' })).toEqual([]);
  });

  it('falls back to the page when the tile\'s last run predates the filter value (only linked tiles re-run)', () => {
    const staleRun = { tileId: 'revenue', status: 'ok', tileType: 'dataset', filterReport: { applied: [], notApplied: [] } } as any;
    const notices = studioTileFilterNotices({ page, tile: revenueKpi, run: staleRun, values: { customer_name: 'Lori Butler' }, mode: 'preview' });
    expect(notices.map((notice) => notice.label)).toEqual(['Not filtered by Customer Name']);
    expect(notices[0]!.detail).toContain('isn’t linked to Customer Name');
  });

  it('keeps an explicit "Does not apply" choice on a saved-query tile and never notices on text', () => {
    const savedQuery = { i: 'top', block: { blockId: 'top_customers' }, viz: { type: 'table' }, filterBindings: [{ filter: 'month', capability: 'unsupported', unsupportedReason: 'Author: does not apply' }] };
    const notices = studioTileFilterNotices({ page, tile: savedQuery, values: { month: { start: '2025-01-01' } }, mode: 'preview' });
    expect(notices).toEqual([expect.objectContaining({ label: 'Not filtered by Month', detail: expect.stringContaining('“Does not apply”') })]);
    expect(studioTileFilterNotices({ page, tile: { i: 'note', text: { markdown: 'Hi' }, viz: { type: 'text' } }, values: { month: { start: '2025-01-01' } }, mode: 'edit' })).toEqual([]);
  });
});

describe('filter values search every value (review problem 3)', () => {
  const capped = { values: Array.from({ length: 200 }, (_, index) => `Customer ${String(index).padStart(3, '0')}`), truncated: true, valueCount: 930 };

  it('says how to reach the rest of a capped list', () => {
    expect(filterValueCapHint(capped)).toBe('Type to search all 930 values');
    expect(filterValueCapHint({ ...capped, valueCount: 5000, valueCountCapped: true })).toBe('Type to search all 5,000+ values');
    expect(filterValueCapHint({ values: ['A', 'B'], truncated: false, valueCount: 2 })).toBeNull();
  });

  it('searches the server for a capped list and the loaded values otherwise', async () => {
    const source = { sourceId: 'source.customers', field: 'customer_name' };
    expect(filterValueSearchRequest(source, capped, ' Lori ')).toEqual({ sourceId: 'source.customers', field: 'customer_name', search: 'Lori' });
    expect(filterValueSearchRequest(source, { values: ['Lori Butler'], truncated: false, valueCount: 1 }, 'Lori')).toBeNull();
    expect(filterValueSearchRequest(undefined, capped, 'Lori')).toBeNull();
    expect(filterValueSearchRequest(source, capped, '  ')).toBeNull();
    const fetchValues = vi.fn(async () => ({ ok: true, values: ['Lori Butler'], truncated: false }));
    await expect(searchFilterValues({ sourceId: 'source.customers', field: 'customer_name', search: 'Lori' }, fetchValues)).resolves.toEqual({ values: ['Lori Butler'], truncated: false, failed: false });
    expect(fetchValues).toHaveBeenCalledWith('source.customers', 'customer_name', { search: 'Lori' });
    expect(matchFilterValues(['Lori Butler', 'Aaron Gardner'], 'lori')).toEqual(['Lori Butler']);
  });

  it('shows the capped hint in the editor dropdown instead of "200 available values"', () => {
    const markup = renderToStaticMarkup(<studio.StudioFilterDropdown label="Customer Name" values={capped.values} value="" multiple={false} applying={false} truncated valueCount={930} searchSource={{ sourceId: 'source.customers', field: 'customer_name' }} onChange={() => undefined} />);
    expect(markup).toContain('Type to search all 930 values');
    expect(markup).not.toContain('200 available values');
  });
});

describe('a date filter maps to a tile\'s own date field (review problem 2)', () => {
  const dataset = (label: string, fields: Array<Record<string, unknown>>) => ({ capabilities: { dataset: { label, fields } } });
  const sources = [
    { id: 'source.revenue', sourceRef: 'monthly_revenue', ...dataset('Monthly Revenue', [{ kind: 'physical', name: 'month', qualifiedId: 'field:month', type: 'date', role: 'time', status: 'approved' }]) },
    { id: 'source.items', sourceRef: 'order_items', ...dataset('Order Items', [
      { kind: 'physical', name: 'ordered_at', qualifiedId: 'field:ordered_at', type: 'timestamp', role: 'time', status: 'approved' },
      { kind: 'physical', name: 'product_name', qualifiedId: 'field:product_name', type: 'string', role: 'dimension', status: 'approved' },
    ]) },
  ] as any;
  const pages = [{
    id: 'overview', metadata: { title: 'Overview' },
    datasets: [
      { id: 'ds-revenue', sourceId: 'source.revenue', sourceRevision: 'rev-1' },
      { id: 'ds-items', sourceId: 'source.items', sourceRevision: 'rev-1' },
    ],
    filters: [],
    layout: { items: [
      { i: 'trend', title: 'Revenue trend', query: { dimensions: [{ field: 'month' }], measures: [] }, sourceId: 'source.revenue', sourceRevision: 'rev-1', viz: { type: 'line' } },
      { i: 'items', title: 'Revenue by product', query: { dimensions: [{ field: 'product_name' }], measures: [] }, sourceId: 'source.items', sourceRevision: 'rev-1', viz: { type: 'bar' } },
    ] },
  }] as any;

  it('offers the tile\'s own date fields for a date filter, and never maps one on its own', () => {
    const plain = filterTileMappingsForField(pages, [], 'month', {}, sources);
    expect(plain.find((mapping) => mapping.tileId === 'items')).toMatchObject({ supported: false });
    expect(plain.find((mapping) => mapping.tileId === 'items')?.dateFieldOptions).toBeUndefined();
    const dated = filterTileMappingsForField(pages, [], 'month', {}, sources, studioFilterMappingOptions({ type: 'daterange' }));
    const items = dated.find((mapping) => mapping.tileId === 'items')!;
    expect(items).toMatchObject({ supported: false, sourceId: 'source.items', dateFieldOptions: [{ field: 'ordered_at', type: 'timestamp' }] });
    const markup = renderToStaticMarkup(<FilterTileChoice mapping={items} applies={false} onChoose={() => undefined} onUseDateField={() => undefined} />);
    expect(markup).toContain('Use Ordered At on Order Items');
  });

  it('a chosen field links the tile through that field and is saved as its Dataset binding', () => {
    const options = studioFilterMappingOptions({ type: 'daterange', fieldOverrides: { 'source.items': 'ordered_at' } });
    const mappings = filterTileMappingsForField(pages, [], 'month', {}, sources, options);
    const items = mappings.find((mapping) => mapping.tileId === 'items')!;
    expect(items).toMatchObject({ supported: true, datasetId: 'ds-items', datasetField: 'ordered_at', mappedFrom: 'month' });
    expect(renderToStaticMarkup(<FilterTileChoice mapping={items} applies onChoose={() => undefined} onClearDateField={() => undefined} />)).toContain('uses Ordered At');
    expect(datasetFilterBindingsForSelection(mappings, new Set(mappings.map((mapping) => mapping.key)))).toEqual({
      'ds-items': { field: 'ordered_at', tileIds: ['items'] },
      'ds-revenue': { field: 'month', tileIds: ['trend'] },
    });
    // A non-date control ignores the date mapping.
    expect(filterTileMappingsForField(pages, [], 'month', {}, sources, studioFilterMappingOptions({ type: 'select', fieldOverrides: { 'source.items': 'ordered_at' } })).find((mapping) => mapping.tileId === 'items')?.supported).toBe(false);
  });

  it('reopening a saved filter keeps the mapped date field', () => {
    const saved = [{ ...pages[0], filters: [{ id: 'month', type: 'daterange', datasetBindings: { 'ds-revenue': { field: 'month', tileIds: ['trend'] }, 'ds-items': { field: 'ordered_at', tileIds: ['items'] } } }] }];
    expect(studioFilterFieldOverrides(saved as any, 'month', 'month')).toEqual({ 'source.items': 'ordered_at' });
  });
});

describe('tile layout keeps the data visible (review problem 8)', () => {
  it('puts "Rolled up from a saved query" behind an info icon in the header, not over the KPI', () => {
    const run = { tileId: 'kpi', status: 'ok', tileType: 'dataset', dataset: { validation: { outcome: 'adapted', adaptations: [{ kind: 'saved_query_rollup', message: 'Rolled up from the certified result of monthly_revenue.' }] } } } as any;
    const markup = renderToStaticMarkup(<studio.TileAdaptedNote run={run} />);
    expect(markup).toContain('class="tile-adapted-note"');
    expect(markup).toContain('aria-label="Rolled up from a saved query: Rolled up from the certified result of monthly_revenue."');
    expect(markup).not.toContain('tile-filter-notice');
    expect(renderToStaticMarkup(<studio.TileAdaptedNote run={{ ...run, dataset: {} }} />)).toBe('');
  });

  it('shows the click-to-filter hint only on hover or while a click-filter is active', () => {
    const tile = { i: 'bars', x: 0, y: 0, w: 6, h: 4, sourceId: 'source.customers', sourceRevision: 'rev-1', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'spend' }] }, viz: { type: 'bar' } } as any;
    const run = { tileId: 'bars', status: 'ok', tileType: 'dataset', result: { columns: ['customer_name', 'spend'], rows: [{ customer_name: 'Alice', spend: 1 }], rowCount: 1, executionTime: 1 } } as any;
    const linkProposal = { fromField: 'customer_name', fieldLabel: 'customer_name', mappings: [{ fromTileId: 'bars', fromField: 'customer_name', toDataset: 'ds', toField: 'customer_name' }], targetLabels: ['Orders'] };
    const render = (activeCrossFilters: any[]) => renderToStaticMarkup(<studio.StudioTilePreview tile={tile} run={run} loading={false} themeMode="paper" linkProposal={linkProposal} onLinkField={() => undefined} onMark={() => undefined} activeCrossFilters={activeCrossFilters} />);
    expect(render([])).toContain('class="dataset-link-hint hover-only"');
    expect(render([{ fromTileId: 'other', fromSourceId: 's', fromSourceRevision: 'r', field: 'customer_name', values: ['Alice'] }])).toContain('class="dataset-link-hint "');
  });

  it('names every bar of a top-25 list, truncating long names, with room for each row', () => {
    const names = ['Aaron Gardner', 'Lori Butler', 'Ryan Byrd', 'Bartholomew Featherstonehaugh-Smythe', ...Array.from({ length: 21 }, (_, index) => `Customer ${index}`)];
    const result = { columns: ['customer_name', 'lifetime_spend'], rows: names.map((name, index) => ({ customer_name: name, lifetime_spend: 1000 - index })), rowCount: 25, executionTime: 1 } as any;
    const built = buildVizOption({ chartType: 'bar', result, themeMode: 'paper', config: { chart: 'bar', x: 'customer_name', y: 'lifetime_spend', maxItems: 25 } as any })!;
    const axis = built.option.yAxis as any;
    expect(axis.axisLabel).toMatchObject({ interval: 0, hideOverlap: false });
    expect(axis.data).toHaveLength(25);
    expect(axis.data[1]).toBe('Lori Butler');
    // The axis shows a short name; the tooltip keeps the full one.
    expect(axis.data[3]).toBe('Bartholomew Featherstonehaugh-Smythe');
    expect(axis.axisLabel.formatter(axis.data[3]).length).toBeLessThanOrEqual(18);
    expect(built.minHeight).toBe(25 * 18 + 32);
    // A crowded vertical axis rotates its labels instead of skipping them.
    const vertical = buildVizOption({ chartType: 'bar', result, themeMode: 'paper', config: { chart: 'bar', x: 'customer_name', y: 'lifetime_spend', orientation: 'vertical', maxItems: 25 } as any })!;
    expect((vertical.option.xAxis as any).axisLabel).toMatchObject({ interval: 0, rotate: 35 });
  });
});
