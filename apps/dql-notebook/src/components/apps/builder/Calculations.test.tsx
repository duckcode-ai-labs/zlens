import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import type { DashboardVizEncoding } from '@zlens/core/apps/viz-encoding';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import { readerTileTrust } from '@zlens/core/apps/reader-trust';
import { ShelfEditor, quickCalcState } from './ShelfEditor';
import { checkFormula } from './CalculationEditor';
import { readerTileReceipt } from '../reader-trust';
import { exploreByQuery } from '../mark-actions';

const descriptor = {
  version: 1, id: 'orders', kind: 'block', sourceRevision: 'r1', snapshotId: 's1', label: 'Orders',
  contractRef: { kind: 'block_source', id: 'orders', fingerprint: 'c1' },
  binding: { sourceQualifiedId: 'orders', sourceRevision: 'r1', contractFingerprint: 'c1', state: 'valid' },
  lifecycle: 'certified', trust: 'certified', grain: { entityIds: ['order_line'], keyFields: ['order_line_id'] },
  fields: [
    { kind: 'physical', name: 'region', qualifiedId: 'f.region', type: 'string', role: 'dimension', status: 'approved' },
    { kind: 'physical', name: 'order_date', qualifiedId: 'f.order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
    { kind: 'measure', name: 'revenue', qualifiedId: 'm.revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], format: { kind: 'currency', currency: 'USD' }, status: 'approved' },
    { kind: 'measure', name: 'order_count', qualifiedId: 'm.order_count', aggregation: 'count_distinct', from: 'order_id', dependsOn: ['order_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
  ],
  operations: ['filter', 'group', 'trend', 'rank', 'compare', 'having'], execution: { route: 'certified' },
} as unknown as DatasetDescriptor;

const query: TileQuery = {
  dimensions: [{ field: 'order_date', timeGrain: 'month' }, { field: 'region' }],
  measures: [{ measure: 'revenue' }],
  calculations: [
    { id: 'aov', label: 'Average order value', expr: { op: '/', left: { measure: 'revenue' }, right: { measure: 'order_count' } } },
    { id: 'revenue_running_total', quick: { kind: 'running_total', of: 'revenue' } },
  ],
};
const encoding: DashboardVizEncoding = {
  version: 1,
  columns: [{ dimension: 'order_date' }],
  rows: [{ measure: 'revenue_running_total' }, { measure: 'aov' }],
  color: { dimension: 'region' },
};

describe('calculations in Studio (RFC 0009 step 3)', () => {
  it('shows calculation pills by name, the formula list, and a way to add one', () => {
    const markup = renderToStaticMarkup(<ShelfEditor descriptor={descriptor} encoding={encoding} query={query} disabled={false} onChange={() => undefined} />);
    expect(markup).toContain('Running total of Revenue');
    expect(markup).toContain('Average order value');
    expect(markup).toContain('title="revenue / order_count"');
    expect(markup).toContain('New formula');
    expect(markup).toContain('aria-label="Edit Average order value: revenue / order_count"');
  });

  it('checks a formula as it is typed, in words', () => {
    expect(checkFormula(descriptor, query, 'revenue / order_count', 'x')).toMatchObject({ state: 'ok', output: { format: { kind: 'currency', currency: 'USD' } } });
    expect(checkFormula(descriptor, query, 'revenue + order_count', 'x')).toMatchObject({ state: 'error', message: 'revenue is money (USD) and order_count is a count; they cannot be added.' });
    expect(checkFormula(descriptor, query, 'revenue / net_amount', 'x')).toMatchObject({ state: 'error' });
    expect(checkFormula(descriptor, query, '', 'x')).toEqual({ state: 'empty' });
  });

  it('offers quick calculations with the rule that rules one out', () => {
    const revenue = quickCalcState(descriptor, { ...query, measures: [{ measure: 'revenue' }, { measure: 'order_count' }] }, { measure: 'order_count' })!;
    expect(revenue.current).toBeNull();
    expect(revenue.options.find((option) => option.kind === 'percent_of_total')?.refusal).toContain('Order Count is a distinct count');
    expect(revenue.options.find((option) => option.kind === 'difference')?.refusal).toBeUndefined();
    const running = quickCalcState(descriptor, query, { measure: 'revenue_running_total' })!;
    expect(running).toMatchObject({ current: 'running_total', sourceAlias: 'revenue', sourceRef: 'revenue' });
    const overFormula = quickCalcState(descriptor, query, { measure: 'aov' })!;
    expect(overFormula.options.find((option) => option.kind === 'moving_average')?.refusal).toContain('would average ratios');
  });

  it('reads a calculated tile over certified data as Certified (T2) and shows its formulas on the receipt', () => {
    const item = { i: 't1', title: 'Revenue', query, viz: { type: 'line' } } as never;
    const tile = { tileId: 't1', status: 'ok', dataset: { trust: 'certified', validation: { outcome: 'covered' } } } as never;
    expect(readerTileTrust(item, tile)).toMatchObject({ state: 'certified', label: 'Certified' });
    expect(readerTileTrust({ ...(item as object), query: { ...query, calculations: undefined } } as never, tile)).toMatchObject({ state: 'certified' });
    const rows = readerTileReceipt(item, tile, null, undefined);
    expect(rows.find((row) => row.label === 'Calculations')?.value).toBe('Average order value = revenue / order_count · Running total of revenue');
  });

  it('keeps calculated measures when a reader breaks a tile down, and leaves quick calculations behind', () => {
    const next = exploreByQuery(query, [], { name: 'region', role: 'dimension' } as never);
    expect(next.calculations?.map((calculation) => calculation.id)).toEqual(['aov']);
  });
});
