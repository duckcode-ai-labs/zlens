import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../api/client';
import {
  missingFieldReason,
  normalizeSearchText,
  plainSourceText,
  sameNameOrigins,
  searchMatches,
  sourceDisplayName,
} from './source-names';
import { discoverAppFilterCandidates, filterTileMappingsForField } from './app-studio-filter-candidates';
import { FilterTileChoice, filterCandidateMatches, filterCandidateOrigin } from './builder/GlobalFilterBar';
import { datasetTileNotices } from './dataset-tile-evidence';
import { canvasShortcut, canvasShortcutApplies, selectionAfterAdd } from './builder/canvas-interactions';
import { appHeaderTitle } from './app-text';
import { tableRowCountLabel } from '../output/TableOutput';
import { kpiValueFontSize } from '../output/ChartOutput';
import { appDataSameNameOrigins } from './builder/app-data-names';
import { DataPanel } from './builder/DataPanel';
import { AddDataBrowser } from './builder/AddDataBrowser';
import { draftWith, orderLinesDataset } from './builder/app-data.fixtures';

type StudioPage = AppStudioBuildDraft['pages'][number];

describe('display names, never internal IDs (B7)', () => {
  it('reads a qualified identity as the source name', () => {
    expect(sourceDisplayName('General::Block::Customers::8f7fac5d8eae716e39ba')).toBe('Customers');
    expect(sourceDisplayName('commerce::block::monthly_revenue::88e1e6c0d79c8e655ab1')).toBe('Monthly Revenue');
    expect(sourceDisplayName('orders::semantic::order_metrics')).toBe('Order Metrics');
    expect(sourceDisplayName('commerce::orders')).toBe('Orders');
    expect(sourceDisplayName('top_customers')).toBe('Top Customers');
    // A label wins, as written.
    expect(sourceDisplayName('General::Block::Customers::8f7f', 'Top customers')).toBe('Top customers');
  });

  it('says what is missing in plain words, also for reasons older Apps stored', () => {
    expect(missingFieldReason('commerce::block::monthly_revenue::88e1e6c0', 'customer_name')).toBe('Monthly Revenue has no Customer Name field.');
    expect(plainSourceText('customer name is not exposed by commerce::block::monthly_revenue::88e1e6c0d79c8e655ab1.'))
      .toBe('Monthly Revenue has no Customer Name field.');
    expect(plainSourceText('customer name is not an approved physical field on this Dataset source.')).toBe('This data has no Customer Name field.');
    expect(plainSourceText('Filter came from General::Block::Customers::8f7fac5d8eae716e39ba today')).toBe('Filter came from Customers today');
    expect(plainSourceText('The author chose “Does not apply” for this tile.')).toBe('The author chose “Does not apply” for this tile.');
  });

  const datasetSource = {
    id: 'src.customers', kind: 'governed_block', qualifiedIdentity: 'General::Block::Customers::8f7fac5d8eae716e39ba', sourceRef: 'blocks/customers.dql',
    capabilities: {
      measures: [], dimensions: [], outputs: [], filters: [], parameters: [],
      dataset: { label: 'Customers', fields: [{ kind: 'physical', name: 'customer_name', qualifiedId: 'f.customer_name', type: 'string', role: 'dimension', status: 'approved' }] },
    },
  } as unknown as AppStudioBuildDraft['sources'][number];
  const revenueSource = {
    id: 'src.revenue', kind: 'governed_block', qualifiedIdentity: 'commerce::block::monthly_revenue::88e1e6c0d79c8e655ab1', sourceRef: 'blocks/monthly_revenue.dql',
    capabilities: { measures: [], dimensions: ['month'], outputs: [], filters: [], parameters: [] },
  } as unknown as AppStudioBuildDraft['sources'][number];
  const page = {
    id: 'overview', metadata: { title: 'Overview' },
    datasets: [{ id: 'ds.customers', sourceId: 'src.customers', sourceRevision: 'r1' }],
    layout: { items: [
      { i: 'spend', title: 'Spend by customer', sourceId: 'src.customers', sourceRevision: 'r1', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }] }, viz: { type: 'bar' } },
      { i: 'revenue', title: 'Monthly revenue', sourceId: 'src.revenue', block: { blockId: 'monthly_revenue' }, viz: { type: 'line' } },
    ] },
  } as unknown as StudioPage;

  it('lists filter fields "from Customers" and explains a tile that cannot take one', () => {
    const [candidate] = discoverAppFilterCandidates([page], [], {}, [datasetSource, revenueSource]).filter((entry) => entry.id === 'customer_name');
    expect(candidate!.sourceNames).toEqual(['Customers']);
    expect(filterCandidateOrigin(candidate!)).toBe('from Customers');
    const mappings = filterTileMappingsForField([page], [], 'customer_name', {}, [datasetSource, revenueSource]);
    const revenue = mappings.find((mapping) => mapping.tileId === 'revenue')!;
    expect(revenue.sourceName).toBe('Monthly Revenue');
    expect(revenue.reason).toBe('Monthly Revenue has no Customer Name field.');
    const spend = mappings.find((mapping) => mapping.tileId === 'spend')!;
    const markup = renderToStaticMarkup(<FilterTileChoice mapping={spend} applies onChoose={() => undefined} />);
    expect(markup).toContain('From Customers · Dataset field');
    expect(markup).not.toContain('8f7fac5d');
    expect(renderToStaticMarkup(<FilterTileChoice mapping={revenue} applies={false} onChoose={() => undefined} />)).not.toContain('88e1');
  });

  it('finds "customer name" whatever its spacing, underscores or case', () => {
    const candidate = { id: 'customer_name', sourceNames: ['General::Block::Customers::8f7fac5d8eae716e39ba'] };
    for (const typed of ['customer name', 'Customer Name', 'customer_name', 'customername', 'CUSTOMER-NAME', 'cust']) {
      expect(filterCandidateMatches(candidate, typed)).toBe(true);
    }
    expect(filterCandidateMatches(candidate, 'customers')).toBe(true);
    expect(filterCandidateMatches(candidate, '8f7fac5d')).toBe(false);
    expect(filterCandidateMatches(candidate, 'order date')).toBe(false);
    expect(normalizeSearchText(' Order_Date ')).toBe('orderdate');
    expect(searchMatches('', ['anything'])).toBe(true);
  });

  it('plain words reach the "Not filtered by" notice in Studio and the reader', () => {
    const notices = datasetTileNotices({
      tileId: 'revenue', status: 'ok', tileType: 'block',
      filterReport: { applied: [], notApplied: [{ filter: 'customer_name', code: 'does_not_apply', reason: 'customer name is not exposed by commerce::block::monthly_revenue::88e1e6c0d79c8e655ab1.' }] },
    } as never, { filterLabels: { customer_name: 'Customer Name' } });
    expect(notices).toEqual([expect.objectContaining({ label: 'Not filtered by Customer Name', detail: 'Monthly Revenue has no Customer Name field.' })]);
  });
});

describe('two items with the same name show where they come from (B14)', () => {
  // A Dataset made from a database table (design D1 origin labels read the from-table tag).
  const ordersTable = { ...orderLinesDataset, id: 'orders-table', sourceId: 'orders-table', name: 'orders', tags: ['app-datasets', 'from-table'] } as unknown as AppBlockRecommendation;
  const ordersMetrics = {
    ...orderLinesDataset, id: 'orders-metrics', sourceId: 'orders-metrics', name: 'Orders', kind: 'semantic',
    capabilities: { ...orderLinesDataset.capabilities, dataset: { ...orderLinesDataset.capabilities!.dataset!, kind: 'semantic' } },
  } as unknown as AppBlockRecommendation;

  it('names the origin only when names collide', () => {
    expect([...appDataSameNameOrigins([ordersTable, ordersMetrics]).entries()]).toEqual([['orders-table', 'Table'], ['orders-metrics', 'Metrics']]);
    expect(appDataSameNameOrigins([ordersTable, orderLinesDataset as unknown as AppBlockRecommendation]).size).toBe(0);
    const twins = sameNameOrigins([
      { id: 'a', name: 'orders', domain: 'commerce', origin: 'Table' },
      { id: 'b', name: 'Orders', domain: 'finance', origin: 'Table' },
    ]);
    expect(twins.get('a')).toBe('Table · Commerce');
    expect(twins.get('b')).toBe('Table · Finance');
  });

  it('shows "Orders · Table" and "Orders · Metrics" in the Data pane picker', () => {
    const markup = renderToStaticMarkup(<DataPanel
      appData={[ordersTable, ordersMetrics]}
      active={ordersTable}
      target={{ kind: 'none' }}
      disabled={false}
      defaultPickerOpen
      onChoose={vi.fn()}
      onPickField={vi.fn()}
      onAddData={vi.fn()}
      onAddSavedQuery={vi.fn()}
      onAddContent={vi.fn()}
    />);
    expect(markup).toContain('Orders<em class="same-name-origin"> · Table</em>');
    expect(markup).toContain('Orders<em class="same-name-origin"> · Metrics</em>');
  });
});

describe('smaller editor fixes (B14)', () => {
  it('Add data shows a loading state, never "No certified data yet / 0", before the catalog arrives', () => {
    const markup = renderToStaticMarkup(<AddDataBrowser draftId="build_1" draft={draftWith()} sourcePolicy="governed_only" onAdd={vi.fn(async () => true)} onRemove={vi.fn()} onChangePolicy={vi.fn()} />);
    expect(markup).toContain('Finding data…');
    expect(markup).not.toContain('No certified data yet');
    expect(markup).not.toContain('<small>0</small>');
  });

  it('a field click after "Add to page" starts a new tile: a tile built from fields is not left selected', () => {
    expect(selectionAfterAdd('field_draft', 'tile-7')).toBeNull();
    expect(selectionAfterAdd('source', 'tile-7')).toBe('tile-7');
  });

  it('Delete removes the selected tile while focus is in its settings panel, but not while typing', () => {
    const remove = canvasShortcut({ key: 'Delete', target: { tagName: 'BUTTON' } }, true)!;
    expect(remove).toEqual({ kind: 'remove' });
    expect(canvasShortcutApplies(remove, { onCanvas: false, inSettingsPanel: true, key: 'Delete' })).toBe(true);
    expect(canvasShortcutApplies(remove, { onCanvas: false, inSettingsPanel: false, key: 'Delete' })).toBe(false);
    // Backspace and arrows stay with the panel's own controls.
    expect(canvasShortcutApplies(canvasShortcut({ key: 'Backspace', target: { tagName: 'BUTTON' } }, true)!, { onCanvas: false, inSettingsPanel: true, key: 'Backspace' })).toBe(false);
    expect(canvasShortcutApplies({ kind: 'move', dx: 1, dy: 0 }, { onCanvas: false, inSettingsPanel: true, key: 'ArrowRight' })).toBe(false);
    // Typing in the title field never deletes.
    expect(canvasShortcut({ key: 'Delete', target: { tagName: 'INPUT' } }, true)).toBeUndefined();
    expect(canvasShortcutApplies(remove, { onCanvas: true, inSettingsPanel: false, key: 'Delete' })).toBe(true);
  });

  it('the reader header shows the App name, not its slug', () => {
    expect(appHeaderTitle('Sales Manager Review', 'sales-manager-review')).toBe('Sales Manager Review');
    expect(appHeaderTitle('  ', 'sales-manager-review')).toBe('sales-manager-review');
    expect(appHeaderTitle(null, null)).toBe('App');
  });

  it('a table that holds the first 500 of 935 rows says so, agreeing with "Live · 935 rows"', () => {
    expect(tableRowCountLabel({ rangeStart: 1, rangeEnd: 10, loaded: 500, total: 935 })).toBe('Showing 1–10 of the first 500 rows · 935 in total');
    expect(tableRowCountLabel({ rangeStart: 1, rangeEnd: 10, loaded: 14, total: 14 })).toBe('Showing 1–10 of 14 rows');
    expect(tableRowCountLabel({ rangeStart: 1, rangeEnd: 3, loaded: 500, total: 935, matching: 3 })).toBe('Showing 1–3 of 3 matching (first 500 of 935 total)');
  });

  it('a KPI figure shrinks to fit its tile instead of reading "$2,880.…"', () => {
    expect(kpiValueFontSize('$2,880.40', 120)).toBeLessThan(24);
    expect(kpiValueFontSize('$2,880.40', 120)! * 0.62 * '$2,880.40'.length).toBeLessThanOrEqual(120 - 16);
    // A pill above the KPI leaves a 42px body: the figure fits it, with no scrollbar.
    expect(kpiValueFontSize('$671.4K', 400, 42)! * 1.1).toBeLessThanOrEqual(42 - 6);
    expect(kpiValueFontSize('$671.4K', 400, 200)).toBe(40);
    expect(kpiValueFontSize('$671.4K')).toBeUndefined();
    expect(kpiValueFontSize('$2.9K', 600)).toBe(40);
    expect(kpiValueFontSize('$2.9K')).toBeUndefined();
  });
});
