import { describe, expect, it } from 'vitest';
import {
  askAboutMarkQuestion,
  describeMark,
  drillByFields,
  drillFilters,
  explainDefinitionFor,
  exploreByQuery,
  exploreRowsQuery,
  markContextFor,
  markFilters,
  markMenuItems,
  rowColumns,
  type ExploreField,
} from './mark-actions';
import { buildDatasetCrossFilter, datasetAffectedTileIds } from './app-dataset-interactions';

const trend = {
  i: 'trend', x: 0, y: 0, w: 6, h: 4, sourceId: 'app:block:orders', sourceRevision: 'r1', title: 'Revenue by month and region',
  query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }, { field: 'region' }], measures: [{ measure: 'revenue' }] },
  viz: { type: 'line' },
} as never;
const byRegion = {
  i: 'regions', x: 6, y: 0, w: 6, h: 4, sourceId: 'app:block:orders', sourceRevision: 'r1', title: 'Revenue by region',
  query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], filters: [{ field: 'channel', op: 'eq', values: ['Web'] }] },
  viz: { type: 'bar' },
} as never;
const fields: ExploreField[] = [
  { name: 'order_date', role: 'time', type: 'date', grains: ['day', 'month'], primary: true },
  { name: 'region', role: 'dimension', type: 'string' },
  { name: 'customer_id', role: 'dimension', type: 'string' },
  { name: 'order_line_id', role: 'key', type: 'string' },
  { name: 'net_amount', role: 'attribute', type: 'number' },
];

describe('a clicked mark (RFC 0009 step 6a)', () => {
  const mark = markContextFor(trend, { order_date_month: '2026-02-01', region: 'US', revenue: 70 })!;

  it('reads the row against the tile query: each dimension, its grain, and the measure', () => {
    expect(mark.values).toEqual([
      { field: 'order_date', alias: 'order_date_month', value: '2026-02-01', timeGrain: 'month' },
      { field: 'region', alias: 'region', value: 'US' },
    ]);
    expect(mark.measure).toEqual({ name: 'revenue', alias: 'revenue', value: 70 });
    expect(describeMark(mark)).toBe('February 2026 · Region US');
  });

  it('stands for a period as its start to the next start, and a category as one value', () => {
    expect(markFilters(mark)).toEqual([
      { field: 'order_date', op: 'gte', values: ['2026-02-01'] },
      { field: 'order_date', op: 'lt', values: ['2026-03-01'] },
      { field: 'region', op: 'eq', values: ['US'] },
    ]);
    expect(drillFilters([{ hierarchyId: 'geo', fromField: 'country', values: ['US'] }])).toEqual([{ field: 'country', op: 'eq', values: ['US'] }]);
  });

  it('offers keep and exclude for a category, drill down when a hierarchy continues, and says why an action is off', () => {
    const items = markMenuItems({ mark, keepField: 'region', drillDown: { toField: 'state' }, canDrillBy: true, hasDetailsPage: false, canExplain: true, canAsk: true });
    expect(items.map((item) => item.id)).toEqual(['keep', 'exclude', 'drill-down', 'drill-by', 'rows', 'explain', 'ask']);
    expect(items[0]!.label).toBe('Keep only US');
    const bare = markMenuItems({ mark, canDrillBy: false, hasDetailsPage: true, canExplain: false, canAsk: false });
    expect(bare.find((item) => item.id === 'drill-by')?.disabled).toContain('does not list');
    expect(bare.find((item) => item.id === 'explain')?.disabled).toContain('no time field');
    expect(bare.some((item) => item.id === 'details')).toBe(true);
    // No figure rides in the question: which values a model sees is the governed answer path's decision.
    expect(askAboutMarkQuestion(mark, 'Revenue by month and region')).toBe('In "Revenue by month and region", what explains Revenue for February 2026 · Region US, and what should I look at next?');
    expect(askAboutMarkQuestion(mark, 'Revenue by month and region')).not.toMatch(/\$|\b70\b/);
  });
});

describe('the Explore panel’s queries', () => {
  const regionMark = markContextFor(byRegion, { region: 'US', revenue: 85 })!;
  const path = [{ label: 'Region US', filters: markFilters(regionMark) }];

  it('breaks the tile’s measures down by any approved field inside the path, keeping the tile’s own filters', () => {
    const query = exploreByQuery((byRegion as { query: never }).query, path, fields[2]!);
    expect(query).toEqual({
      dimensions: [{ field: 'customer_id' }],
      measures: [{ measure: 'revenue' }],
      filters: [{ field: 'channel', op: 'eq', values: ['Web'] }, { field: 'region', op: 'eq', values: ['US'] }],
      orderBy: [{ alias: 'revenue', direction: 'desc' }],
      limit: 50,
    });
    expect(exploreByQuery((byRegion as { query: never }).query, path, fields[0]!).dimensions).toEqual([{ field: 'order_date', timeGrain: 'month' }]);
  });

  it('reads bounded rows with the author’s detail columns, else the path’s and tile’s fields first', () => {
    const base = (byRegion as { query: never }).query;
    expect(rowColumns(base, path, fields)).toEqual(['region', 'order_date', 'customer_id', 'net_amount', 'order_line_id']);
    expect(rowColumns(base, path, fields, ['order_line_id', 'unknown'])).toEqual(['order_line_id']);
    expect(exploreRowsQuery(base, path, ['region'])).toMatchObject({ detail: true, detailColumns: ['region'], limit: 100, dimensions: [], measures: [] });
  });

  it('never offers to break down by a field the path holds to one value, and keeps dates and keys last', () => {
    expect(drillByFields(fields, path).map((field) => field.name)).toEqual(['customer_id', 'order_line_id', 'order_date']);
  });
});

describe('explaining a mark', () => {
  it('explains a clicked period at that period, inside the clicked category and the tile’s drills', () => {
    const mark = markContextFor(trend, { order_date_month: '2026-02-01', region: 'US', revenue: 70 })!;
    const planned = explainDefinitionFor({ item: trend, mark, fields, drills: [{ hierarchyId: 'geo', fromField: 'country', values: ['North America'] }] });
    expect(planned).toEqual({ definition: {
      version: 1, measure: 'revenue', timeField: 'order_date', grain: 'month', anchor: '2026-02-01', comparison: 'previous_period', dimensions: ['*'],
      filters: [{ field: 'country', op: 'eq', values: ['North America'] }, { field: 'region', op: 'eq', values: ['US'] }],
    } });
  });

  it('asks for the latest period first when the tile has no time grain', () => {
    const mark = markContextFor(byRegion, { region: 'US', revenue: 85 })!;
    expect(explainDefinitionFor({ item: byRegion, mark, fields })).toEqual({ needsPeriod: { timeField: 'order_date', grain: 'month' } });
    const anchored = explainDefinitionFor({ item: byRegion, mark, fields, anchor: '2026-01-01', comparison: 'previous_year' });
    expect(anchored).toMatchObject({ definition: { anchor: '2026-01-01', comparison: 'previous_year', filters: [{ field: 'region', op: 'eq', values: ['US'] }] } });
    expect(explainDefinitionFor({ item: byRegion, mark, fields: fields.filter((field) => field.role !== 'time') })).toEqual({ unavailable: expect.stringContaining('no time field') });
  });
});

describe('keep only and exclude on the tile’s own Dataset', () => {
  const page = {
    id: 'p', version: 3, metadata: { title: 'P' },
    datasets: [{ id: 'orders', sourceId: 'app:block:orders', sourceRevision: 'r1', snapshotId: 's', contractFingerprint: 'c' }],
    layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [trend, byRegion, { i: 'other', x: 0, y: 4, w: 6, h: 4, sourceId: 'app:block:customers', sourceRevision: 'r2', query: { dimensions: [], measures: [{ measure: 'count' }] }, viz: { type: 'kpi' } }] },
  } as never;

  it('needs no mapping on the same Dataset and field, and can exclude', () => {
    const kept = buildDatasetCrossFilter(page, byRegion, 'region', ['US']);
    expect(kept.crossFilter).toMatchObject({ fromTileId: 'regions', field: 'region', values: ['US'] });
    expect(kept.crossFilter?.exclude).toBeUndefined();
    expect(buildDatasetCrossFilter(page, byRegion, 'region', ['US'], { exclude: true }).crossFilter?.exclude).toBe(true);
    // A period is not a value: a date grain still needs the author's mapping.
    expect(buildDatasetCrossFilter(page, trend, 'order_date_month', ['2026-02-01']).error).toContain('No filter link is set up');
  });

  it('reruns every tile on that Dataset, not tiles on other Datasets', () => {
    const selection = buildDatasetCrossFilter(page, byRegion, 'region', ['US']).crossFilter!;
    expect(datasetAffectedTileIds(page, [selection])).toEqual(['regions', 'trend']);
  });
});

describe('a saved Explore view', () => {
  it('is titled by what it measures, by what, and where', async () => {
    const { savedTitle } = await import('./ExplorePanel');
    const base = { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }, { measure: 'order_count' }] };
    expect(savedTitle(base, [{ label: 'Region US', filters: [] }], 'order_id')).toBe('Revenue and Order Count by Order Id · Region US');
    expect(savedTitle(base, [], undefined)).toBe('Rows');
  });
});
