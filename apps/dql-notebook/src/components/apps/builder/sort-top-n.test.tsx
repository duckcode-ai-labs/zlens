import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import type { DashboardVizEncoding } from '@zlens/core/apps/viz-encoding';
import type { QueryResult } from '../../../store/types';
import { FieldMenu } from './ShelfEditor';
import { TileQueryEditor } from './TileQueryEditor';
import { BarCapNote } from './BarCapNote';
import { withDraftSortDefault, type DraftTileState } from './DraftTile';
import {
  barCapNote,
  barCategoryCap,
  canShowTopN,
  sortTouched,
  topNFor,
  withDefaultBarSort,
  measureSortChip,
  withSort,
  withTopN,
} from './sort-top-n';

const descriptor = {
  version: 1, id: 'customers', kind: 'block', sourceRevision: 'r1', snapshotId: 's1', label: 'Customers',
  contractRef: { kind: 'block_source', id: 'customers', fingerprint: 'c1' },
  binding: { sourceQualifiedId: 'customers', sourceRevision: 'r1', contractFingerprint: 'c1', state: 'valid' },
  lifecycle: 'certified', trust: 'certified', grain: { entityIds: ['customer'], keyFields: ['customer_id'] },
  fields: [
    { kind: 'physical', name: 'customer_name', qualifiedId: 'f.customer_name', type: 'string', role: 'dimension', status: 'approved' },
    { kind: 'physical', name: 'first_order', qualifiedId: 'f.first_order', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
    { kind: 'measure', name: 'lifetime_spend', qualifiedId: 'm.lifetime_spend', aggregation: 'sum', from: 'lifetime_spend', dependsOn: ['lifetime_spend'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
  ],
  operations: ['filter', 'group', 'trend', 'rank', 'compare', 'having'], execution: { route: 'certified' },
} as unknown as DatasetDescriptor;

const byCustomer: TileQuery = { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }] };
const barEncoding: DashboardVizEncoding = { version: 1, columns: [{ measure: 'lifetime_spend' }], rows: [{ dimension: 'customer_name' }] };

function customers(count: number, extra: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: ['customer_name', 'lifetime_spend'],
    // Customer 7 spends the most; the rest spend their index.
    rows: Array.from({ length: count }, (_, index) => ({ customer_name: `Customer ${index}`, lifetime_spend: index === 7 ? 1_000_000 : index })),
    ...extra,
  };
}

describe('Top N on the measure pill (D3)', () => {
  it('writes the tile query: sorted by the measure, highest first, capped at N', () => {
    const top10 = withTopN(byCustomer, 'lifetime_spend', 10);
    expect(top10.orderBy).toEqual([{ alias: 'lifetime_spend', direction: 'desc' }]);
    expect(top10.limit).toBe(10);
    expect(topNFor(top10, 'lifetime_spend')).toBe(10);
    // "All" lifts the cap and keeps the sort.
    const all = withTopN(top10, 'lifetime_spend', null);
    expect(all.limit).toBeUndefined();
    expect(all.orderBy).toEqual([{ alias: 'lifetime_spend', direction: 'desc' }]);
    expect(topNFor(all, 'lifetime_spend')).toBeNull();
    // A custom number is kept in range.
    expect(withTopN(byCustomer, 'lifetime_spend', 0).limit).toBe(1);
    expect(withTopN(byCustomer, 'lifetime_spend', 37).limit).toBe(37);
  });

  it('sorts ascending or descending by the measure, and clears only that sort', () => {
    const asc = withSort({ ...byCustomer, orderBy: [{ alias: 'customer_name', direction: 'asc' }] }, 'lifetime_spend', 'asc');
    expect(asc.orderBy).toEqual([{ alias: 'lifetime_spend', direction: 'asc' }, { alias: 'customer_name', direction: 'asc' }]);
    expect(withSort(asc, 'lifetime_spend', null).orderBy).toEqual([{ alias: 'customer_name', direction: 'asc' }]);
    expect(withSort(withSort(byCustomer, 'lifetime_spend', 'desc'), 'lifetime_spend', null).orderBy).toBeUndefined();
  });

  it('offers Top N only when there is a category to rank', () => {
    expect(canShowTopN(byCustomer)).toBe(true);
    expect(canShowTopN({ dimensions: [{ field: 'first_order', timeGrain: 'month' }], measures: [{ measure: 'lifetime_spend' }] })).toBe(false);
    expect(canShowTopN({ dimensions: [], measures: [{ measure: 'lifetime_spend' }] })).toBe(false);
  });

  it('shows Sort and Show top 5/10/25/All with the current choice checked on the measure pill menu', () => {
    const markup = renderToStaticMarkup(
      <FieldMenu
        descriptor={descriptor}
        encoding={barEncoding}
        query={withTopN(byCustomer, 'lifetime_spend', 10)}
        shelf="columns"
        fieldRef={{ measure: 'lifetime_spend' }}
        label="Lifetime Spend"
        onClose={() => undefined}
        onEncoding={() => undefined}
        timeGrainFor={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Sort descending by Lifetime Spend"');
    expect(markup).toContain('aria-label="Sort ascending by Lifetime Spend"');
    expect(markup).toContain('aria-label="Show top"');
    expect(markup).toMatch(/aria-checked="true" aria-label="Show top 10 by Lifetime Spend"/);
    expect(markup).toMatch(/aria-checked="false" aria-label="Show top 5 by Lifetime Spend"/);
    expect(markup).toContain('aria-label="Show top 25 by Lifetime Spend"');
    expect(markup).toContain('aria-label="Custom top N"');
    // A dimension pill has no Top N.
    const dimension = renderToStaticMarkup(
      <FieldMenu descriptor={descriptor} encoding={barEncoding} query={byCustomer} shelf="rows" fieldRef={{ dimension: 'customer_name' }} label="Customer Name" onClose={() => undefined} onEncoding={() => undefined} timeGrainFor={() => undefined} />,
    );
    expect(dimension).not.toContain('aria-label="Show top"');
  });

  it('agrees with "Filters, sort and more": both read the same orderBy and limit', () => {
    const markup = renderToStaticMarkup(
      <TileQueryEditor descriptor={descriptor} query={withTopN(byCustomer, 'lifetime_spend', 10)} disabled={false} onChange={() => undefined} idPrefix="topn" shelves />,
    );
    expect(markup).toContain('Show top');
    expect(markup).toMatch(/<option value="lifetime_spend" selected="">Lifetime Spend<\/option>/);
    expect(markup).toContain('value="10"');
  });
});

describe('bar charts sort by their measure and show the top 25 above 50 categories (D3)', () => {
  it('sorts a new bar over categories by its measure, highest first', () => {
    expect(withDefaultBarSort(byCustomer, 'bar').orderBy).toEqual([{ alias: 'lifetime_spend', direction: 'desc' }]);
    expect(withDefaultBarSort(byCustomer, 'horizontal-bar').orderBy).toEqual([{ alias: 'lifetime_spend', direction: 'desc' }]);
    // Never a line, a date axis, a table, or a query that already has a sort.
    expect(withDefaultBarSort(byCustomer, 'line')).toBe(byCustomer);
    expect(withDefaultBarSort(byCustomer, 'table')).toBe(byCustomer);
    const byMonth: TileQuery = { dimensions: [{ field: 'first_order', timeGrain: 'month' }], measures: [{ measure: 'lifetime_spend' }] };
    expect(withDefaultBarSort(byMonth, 'bar')).toBe(byMonth);
    const sorted = withSort(byCustomer, 'customer_name', 'asc');
    expect(withDefaultBarSort(sorted, 'bar')).toBe(sorted);
  });

  it('starts a bar of names as an explicit Top 10, which the pill shows (new-user round 3)', () => {
    const top = withDefaultBarSort(byCustomer, 'bar');
    expect(top.limit).toBe(10);
    expect(measureSortChip(top, { measure: 'lifetime_spend' })).toEqual({ label: 'Top 10' });
    // A short list of categories shows every bar.
    const byType: TileQuery = { dimensions: [{ field: 'customer_type' }], measures: [{ measure: 'lifetime_spend' }] };
    expect(withDefaultBarSort(byType, 'bar').limit).toBeUndefined();
  });

  it('applies to a new tile only until the author chooses a sort or Top N', () => {
    const draft = (query: TileQuery, extra: Partial<DraftTileState> = {}): DraftTileState => ({
      sourceKey: 'customers', query, encoding: barEncoding, view: 'chart', viewChosen: false, title: '', ...extra,
    });
    const fresh = withDraftSortDefault(descriptor, null, draft(byCustomer));
    expect(fresh.query.orderBy).toEqual([{ alias: 'lifetime_spend', direction: 'desc' }]);
    expect(fresh.sortChosen).toBeFalsy();
    // The author clears the sort: it stays cleared.
    const cleared = withDraftSortDefault(descriptor, fresh, draft(withSort(fresh.query, 'lifetime_spend', null)));
    expect(cleared.sortChosen).toBe(true);
    expect(cleared.query.orderBy).toBeUndefined();
    // A field leaving the tile drops its sort; that is not a choice.
    expect(sortTouched(fresh.query, { dimensions: [{ field: 'customer_name' }], measures: [] })).toBe(false);
    expect(sortTouched(fresh.query, withTopN(fresh.query, 'lifetime_spend', 5))).toBe(true);
  });

  it('draws the top 25 of a bar chart with more than 50 categories, largest first', () => {
    const cap = barCategoryCap(customers(935), { chart: 'bar', category: 'customer_name', value: 'lifetime_spend' });
    expect(cap).toMatchObject({ capped: true, cappable: true, shown: 25, total: 935 });
    expect(cap.result.rows).toHaveLength(25);
    expect(cap.result.rows[0]!.customer_name).toBe('Customer 7');
    expect(cap.result.rows[1]!.customer_name).toBe('Customer 934');
    expect(barCapNote(cap)).toBe('Showing top 25 of 935');
  });

  it('follows the tile\'s own sort, counts every category of a capped result, and shows all on request', () => {
    const sorted = withSort(byCustomer, 'customer_name', 'asc');
    const ordered = barCategoryCap(customers(60), { chart: 'bar', query: sorted });
    expect(ordered.result.rows.map((row) => row.customer_name).slice(0, 2)).toEqual(['Customer 0', 'Customer 1']);
    // The server sent the first 500 of 935 rows.
    const firstRows = barCategoryCap(customers(500, { rowCount: 935 }), { chart: 'bar' });
    expect(firstRows).toMatchObject({ total: 935, shown: 25, loaded: 500 });
    const all = barCategoryCap(customers(935), { chart: 'bar', showAll: true });
    expect(all).toMatchObject({ capped: false, cappable: true, shown: 935 });
    expect(all.result.rows).toHaveLength(935);
  });

  it('leaves small charts, other chart types and tiles with an author row limit alone', () => {
    expect(barCategoryCap(customers(50), { chart: 'bar' }).cappable).toBe(false);
    expect(barCategoryCap(customers(935), { chart: 'line' }).cappable).toBe(false);
    expect(barCategoryCap(customers(935), { chart: 'table' }).cappable).toBe(false);
    expect(barCategoryCap(customers(100), { chart: 'bar', query: withTopN(byCustomer, 'lifetime_spend', 100) }).cappable).toBe(false);
  });

  it('says "Showing top 25 of 935 · Show all", then "Showing all 935 · Top 25"', () => {
    const capped = barCategoryCap(customers(935), { chart: 'bar' });
    const note = renderToStaticMarkup(<BarCapNote cap={capped} showAll={false} onShowAll={() => undefined} />);
    expect(note).toContain('Showing top 25 of 935');
    expect(note).toContain('>Show all</button>');
    const all = barCategoryCap(customers(935), { chart: 'bar', showAll: true });
    const expanded = renderToStaticMarkup(<BarCapNote cap={all} showAll onShowAll={() => undefined} />);
    expect(expanded).toContain('Showing all 935');
    expect(expanded).toContain('>Top 25</button>');
    expect(renderToStaticMarkup(<BarCapNote cap={barCategoryCap(customers(10), { chart: 'bar' })} showAll={false} onShowAll={() => undefined} />)).toBe('');
  });
});
