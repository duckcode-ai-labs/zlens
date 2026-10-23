import { describe, expect, it } from 'vitest';
import { normalizeDatasetDescriptor, type DatasetMeasureField, type DatasetPhysicalField } from './descriptor.js';
import {
  isNonAdditiveColumnName,
  savedQueryGroupByFromOutputs,
  savedQueryResultDescriptor,
  savedQueryResultFields,
  savedQueryKeepsFirstRows,
  savedQueryResultRollup,
} from './result-fields.js';
import { validateTileQuery } from '../apps/tile-query.js';

const monthly = (certified = true) => savedQueryResultDescriptor({
  sourceId: 'app:block:commerce:monthly',
  sourceRevision: 'sha256:rev1',
  savedQuery: 'monthly_revenue',
  qualifiedId: 'commerce::block::monthly_revenue',
  domain: 'commerce',
  lifecycle: certified ? 'certified' : 'review',
  certified,
  columns: [
    { name: 'month', type: 'TIMESTAMP' },
    { name: 'gross_revenue', type: 'DOUBLE' },
    { name: 'order_count', type: 'BIGINT' },
    { name: 'avg_order_value', type: 'DOUBLE' },
  ],
  groupBy: ['month'],
  typesFrom: 'probe',
})!;

const customers = savedQueryResultDescriptor({
  sourceId: 'app:block:orders:top',
  sourceRevision: 'sha256:rev2',
  savedQuery: 'top_customers',
  qualifiedId: 'orders::block::top_customers',
  lifecycle: 'certified',
  certified: true,
  columns: [
    { name: 'customer_name', type: 'string' },
    { name: 'lifetime_spend', type: 'number' },
    { name: 'order_count', type: 'number' },
  ],
  groupBy: [],
  typesFrom: 'run',
})!;

const measure = (name: string) => monthly().fields.find((field): field is DatasetMeasureField => field.kind === 'measure' && field.name === name);
const physical = (name: string) => monthly().fields.find((field): field is DatasetPhysicalField => field.kind === 'physical' && field.name === name);

describe('fields from a saved query result (design D1)', () => {
  it('reads numbers as measures, text as dimensions and dates as time fields by day, week or month', () => {
    const derived = savedQueryResultFields({
      sourceId: 's',
      columns: [
        { name: 'ordered_on', type: 'DATE' },
        { name: 'region', type: 'VARCHAR' },
        { name: 'is_repeat', type: 'BOOLEAN' },
        { name: 'customer_id', type: 'INTEGER' },
        { name: 'net_amount', type: 'DECIMAL(18,2)' },
        { name: 'count(*)', type: 'BIGINT' },
      ],
    });
    const byName = new Map(derived.fields.map((field) => [`${field.kind}:${field.name}`, field]));
    expect(byName.get('physical:ordered_on')).toMatchObject({ role: 'time', type: 'date', time: { grains: ['day', 'week', 'month', 'quarter', 'year'], baseGrain: 'day', primary: true } });
    expect(byName.get('physical:region')).toMatchObject({ role: 'dimension', type: 'string' });
    expect(byName.get('physical:is_repeat')).toMatchObject({ role: 'dimension', type: 'boolean' });
    expect(byName.get('physical:customer_id')).toMatchObject({ role: 'key', type: 'number' });
    expect(byName.has('measure:customer_id')).toBe(false);
    expect(byName.get('measure:net_amount')).toMatchObject({ aggregation: 'sum', from: 'net_amount', format: { kind: 'currency' } });
    expect(byName.get('physical:net_amount')).toMatchObject({ role: 'attribute', type: 'number' });
    expect(byName.get('measure:count_of_rows')).toMatchObject({ aggregation: 'count', expression: { kind: 'aggregate', function: 'count', countStar: true } });
    expect(derived.skipped).toEqual(['count(*)']);
  });

  it('gives a period column its own period and longer ones', () => {
    expect(physical('month')?.time).toEqual({ grains: ['month', 'quarter', 'year'], baseGrain: 'month', primary: true });
  });

  it('keeps averages and ratios from being summed, with Min and Max beside them', () => {
    expect(['avg_order_value', 'conversion_rate', 'margin_pct', 'repeat_share', 'gross_margin', 'average_basket', 'click_ratio'].every(isNonAdditiveColumnName)).toBe(true);
    expect(['gross_revenue', 'order_count', 'average', 'rated_items'].map(isNonAdditiveColumnName)).toEqual([false, false, true, false]);
    expect(measure('avg_order_value')).toMatchObject({ aggregation: 'max', additivity: { entities: 'non_additive' } });
    expect(measure('min_avg_order_value')).toMatchObject({ aggregation: 'min', from: 'avg_order_value' });
    expect(measure('max_avg_order_value')).toMatchObject({ aggregation: 'max', from: 'avg_order_value' });
    expect(monthly().result).toEqual({ savedQuery: 'monthly_revenue', groupBy: ['month'], asIs: ['avg_order_value'], typesFrom: 'probe' });
  });

  it('finds the grouping columns of an aggregate query from its column lineage', () => {
    expect(savedQueryGroupByFromOutputs([{ name: 'month' }, { name: 'gross_revenue', isAggregate: true }])).toEqual(['month']);
    expect(savedQueryGroupByFromOutputs([{ name: 'customer_name' }, { name: 'lifetime_spend' }])).toEqual([]);
    expect(savedQueryGroupByFromOutputs([{ name: '*', unresolved: true }, { name: 'n', isAggregate: true }])).toEqual([]);
    expect(savedQueryGroupByFromOutputs(undefined)).toEqual([]);
  });

  it('is a JSON-safe descriptor that keeps its trust and changes fingerprint when a column changes', () => {
    const descriptor = monthly();
    expect(normalizeDatasetDescriptor(JSON.parse(JSON.stringify(descriptor)))).toEqual(descriptor);
    expect(normalizeDatasetDescriptor({ ...descriptor, result: { savedQuery: '' } })).toBeUndefined();
    expect(descriptor).toMatchObject({ trust: 'certified', lifecycle: 'certified', kind: 'block', execution: { route: 'certified' }, grain: { keyFields: ['month'] } });
    expect(monthly(false)).toMatchObject({ trust: 'review_required', execution: { route: 'governed_sql' } });
    const changed = savedQueryResultDescriptor({
      sourceId: 'app:block:commerce:monthly', sourceRevision: 'sha256:rev1', savedQuery: 'monthly_revenue', qualifiedId: 'commerce::block::monthly_revenue',
      lifecycle: 'certified', certified: true, columns: [{ name: 'month', type: 'VARCHAR' }, { name: 'gross_revenue', type: 'DOUBLE' }], groupBy: ['month'], typesFrom: 'probe',
    })!;
    expect(changed.contractRef.fingerprint).not.toBe(descriptor.contractRef.fingerprint);
    expect(descriptor.operations).toContain('detail');
    expect(customers.operations).not.toContain('detail');
  });
});

describe('roll-up rules over a saved query result', () => {
  it('shows values as they are when the tile groups by the saved query grouping', () => {
    const byMonth = validateTileQuery(monthly(), { dimensions: [{ field: 'month', timeGrain: 'month' }], measures: [{ measure: 'gross_revenue' }, { measure: 'avg_order_value' }] });
    expect(byMonth).toEqual({ outcome: 'covered', diagnostics: [], adaptations: [] });
  });

  it('sums numbers when the tile rolls rows up, and says so on the receipt', () => {
    const byQuarter = validateTileQuery(monthly(), { dimensions: [{ field: 'month', timeGrain: 'quarter' }], measures: [{ measure: 'gross_revenue' }] });
    expect(byQuarter.outcome).toBe('adapted');
    expect(byQuarter.adaptations).toEqual([{ kind: 'saved_query_rollup', message: 'Rolled up from the certified result of monthly_revenue.' }]);
    const kpi = validateTileQuery(monthly(), { dimensions: [], measures: [{ measure: 'gross_revenue' }] });
    expect(kpi.outcome).toBe('adapted');
    const review = validateTileQuery(monthly(false), { dimensions: [], measures: [{ measure: 'gross_revenue' }] });
    expect(review.adaptations[0]?.message).toBe('Rolled up from the result of monthly_revenue, which needs review.');
  });

  it('refuses to sum an average and offers Min, Max or the saved query grouping', () => {
    const kpi = validateTileQuery(monthly(), { dimensions: [], measures: [{ measure: 'avg_order_value' }] });
    expect(kpi.outcome).toBe('rejected');
    expect(kpi.diagnostics).toEqual([{
      code: 'NON_ADDITIVE_RESULT_ROLLUP',
      field: 'avg_order_value',
      message: "Averages can't be added up: Avg order value is worked out on each row of monthly_revenue, so it can't be summed. Use Min avg order value or Max avg order value, or group by month to show it as it is.",
    }]);
    expect(validateTileQuery(monthly(), { dimensions: [], measures: [{ measure: 'max_avg_order_value' }] }).outcome).toBe('adapted');
    // Totals add rows up as well.
    expect(validateTileQuery(monthly(), { dimensions: [{ field: 'month', timeGrain: 'month' }], measures: [{ measure: 'avg_order_value' }], rollups: [[]] }).outcome).toBe('rejected');
    // A calculation that reads the average is checked the same way.
    expect(validateTileQuery(monthly(), {
      dimensions: [],
      measures: [{ measure: 'gross_revenue' }],
      calculations: [{ id: 'per_order', expr: { op: '/', left: { measure: 'avg_order_value' }, right: { number: 2 } } }],
    }).outcome).toBe('rejected');
  });

  it('rolls a plain row query up whenever it groups, and counts its rows', () => {
    const bar = validateTileQuery(customers, { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }], orderBy: [{ alias: 'lifetime_spend', direction: 'desc' }], limit: 10 });
    expect(bar.outcome).toBe('adapted');
    expect(validateTileQuery(customers, { dimensions: [], measures: [{ measure: 'count_of_rows' }] }).outcome).toBe('adapted');
    expect(savedQueryResultRollup(customers, { dimensions: [{ field: 'customer_name' }] }, ['lifetime_spend']).rollsUp).toBe(true);
  });

  it('filters on result columns like any physical field', () => {
    const filtered = validateTileQuery(monthly(), {
      dimensions: [{ field: 'month', timeGrain: 'month' }],
      measures: [{ measure: 'gross_revenue' }],
      filters: [{ field: 'month', op: 'gte', values: ['2024-02-01'] }, { field: 'gross_revenue', op: 'gt', values: [10] }],
    });
    expect(filtered.outcome).toBe('covered');
  });

  it('never applies to a row-level Dataset', () => {
    const { result: _result, ...rowLevel } = monthly();
    expect(savedQueryResultRollup(rowLevel, { dimensions: [] }, ['gross_revenue'])).toEqual({ rollsUp: false, blocked: [] });
  });
});

describe('a Top N saved query (0.2.4)', () => {
  // top_beverage_customers keeps its first 10 rows; a Total over it summed
  // those 10 and was labelled Certified.
  const topBeverage = (groupBy: string[]) => savedQueryResultDescriptor({
    sourceId: 'app:block:commerce:top_beverage_customers',
    sourceRevision: 'sha256:rev3',
    savedQuery: 'top_beverage_customers',
    qualifiedId: 'commerce::block::top_beverage_customers',
    domain: 'commerce',
    lifecycle: 'certified',
    certified: true,
    columns: [
      { name: 'customer_name', type: 'VARCHAR' },
      { name: 'beverage_revenue', type: 'DOUBLE' },
    ],
    groupBy,
    typesFrom: 'contract',
    keepsFirstRows: savedQueryKeepsFirstRows('SELECT customer_name, SUM(x) AS beverage_revenue FROM t GROUP BY 1 ORDER BY 2 DESC LIMIT 10'),
  })!;

  it('reads the outer LIMIT and ignores one inside a subquery', () => {
    expect(savedQueryKeepsFirstRows('select a from t order by a desc\n  LIMIT 10\n')).toBe(10);
    expect(savedQueryKeepsFirstRows('select a from t fetch first 5 rows only')).toBe(5);
    expect(savedQueryKeepsFirstRows('select * from (select a from t limit 3) s')).toBeUndefined();
    expect(savedQueryKeepsFirstRows("with top as (select a from t limit 3) select a from top where note = 'limit 9'")).toBeUndefined();
    expect(savedQueryKeepsFirstRows('select a from t -- limit 4')).toBeUndefined();
    expect(savedQueryKeepsFirstRows('select a from t')).toBeUndefined();
    expect(topBeverage(['customer_name']).result?.keepsFirstRows).toBe(10);
  });

  it('marks a total over its rows as not a certified total', () => {
    const total = validateTileQuery(topBeverage(['customer_name']), { dimensions: [], measures: [{ measure: 'beverage_revenue' }] });
    expect(total.outcome).toBe('adapted');
    expect(total.adaptations).toEqual([{
      kind: 'saved_query_rollup',
      message: 'Totals only the 10 rows top_beverage_customers keeps (it is a Top 10), not all of the data, so it is not a certified total.',
      topRowsOnly: 10,
    }]);
  });

  it('leaves the rows as they are certified', () => {
    const asIs = validateTileQuery(topBeverage(['customer_name']), { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'beverage_revenue' }] });
    expect(asIs).toEqual({ outcome: 'covered', diagnostics: [], adaptations: [] });
    // No declared grouping: a bar per row still shows those rows, so only a grand total is flagged.
    const bar = validateTileQuery(topBeverage([]), { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'beverage_revenue' }] });
    expect(bar.adaptations[0]?.topRowsOnly).toBeUndefined();
    const kpi = validateTileQuery(topBeverage([]), { dimensions: [], measures: [{ measure: 'beverage_revenue' }] });
    expect(kpi.adaptations[0]?.topRowsOnly).toBe(10);
  });

  it('survives a round trip through the descriptor normalizer', () => {
    expect(normalizeDatasetDescriptor(JSON.parse(JSON.stringify(topBeverage(['customer_name']))))?.result?.keepsFirstRows).toBe(10);
  });
});
