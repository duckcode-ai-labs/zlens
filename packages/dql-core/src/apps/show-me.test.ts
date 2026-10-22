import { describe, expect, it } from 'vitest';
import {
  applyShowMe,
  showMe,
  showMeFactsFromDescriptor,
  showMeFirstChoice,
  showMeInputFromEncoding,
  showMeInputFromQuery,
  type ShowMeChart,
  type ShowMeDimension,
  type ShowMeInput,
  type ShowMeMeasure,
} from './show-me.js';
import { chartFromEncoding, queryFromEncoding, type DashboardVizEncoding } from './viz-encoding.js';
import type { DatasetDescriptor } from '../datasets/descriptor.js';

const D: Record<string, ShowMeDimension> = {
  order_date: { name: 'order_date', time: true },
  ship_week: { name: 'ship_week', time: true },
  region: { name: 'region', cardinality: 4 },
  region12: { name: 'region', cardinality: 12 },
  segment: { name: 'segment', cardinality: 3 },
  customer: { name: 'customer', cardinality: 40 },
  product: { name: 'product', cardinality: 15 },
  channel: { name: 'channel' },
  stage: { name: 'pipeline_stage', cardinality: 5 },
};
const M: Record<string, ShowMeMeasure> = {
  revenue: { name: 'revenue', additive: true, additiveOverTime: true, unit: 'currency:USD' },
  margin: { name: 'margin', additive: true, additiveOverTime: true, unit: 'currency:USD' },
  cost: { name: 'cost', additive: true, additiveOverTime: true, unit: 'currency:USD' },
  profit: { name: 'profit', additive: true, additiveOverTime: true, unit: 'currency:USD', nonNegative: false },
  orders: { name: 'orders', additive: true, additiveOverTime: true, unit: 'count' },
  customers: { name: 'customers', additive: false, additiveOverTime: false, unit: 'count' },
  conversion: { name: 'conversion_rate', additive: false, additiveOverTime: false, unit: 'percent' },
  balance: { name: 'balance', additive: true, additiveOverTime: false, unit: 'currency:USD' },
};
const input = (dims: string[], measures: string[], extra: Partial<ShowMeInput> = {}): ShowMeInput => ({
  dimensions: dims.map((name) => D[name]!),
  measures: measures.map((name) => M[name]!),
  ...extra,
});
const nine = ['revenue', 'margin', 'cost', 'orders', 'revenue', 'margin', 'cost', 'orders', 'revenue'].map((name, index) => ({ ...M[name]!, name: `${name}_${index}` }));

// The exit check for RFC 0009 step 2: field combinations and the chart an
// analyst would pick first.
const CASES: Array<[string, ShowMeInput, ShowMeChart]> = [
  ['one measure', input([], ['revenue']), 'kpi'],
  ['one distinct count', input([], ['customers']), 'kpi'],
  ['two totals', input([], ['revenue', 'orders']), 'table'],
  ['a total with a period comparison', input([], ['revenue'], { comparison: true }), 'table'],
  ['a measure over time', input(['order_date'], ['revenue']), 'line'],
  ['a distinct count over time', input(['order_date'], ['customers']), 'line'],
  ['a rate over time', input(['order_date'], ['conversion']), 'line'],
  ['a balance over time', input(['order_date'], ['balance']), 'line'],
  ['two money measures over time', input(['order_date'], ['revenue', 'margin']), 'line'],
  ['money and a count over time', input(['order_date'], ['revenue', 'orders']), 'line'],
  ['nine measures over time', { dimensions: [D.order_date!], measures: nine }, 'table'],
  ['time split by a short category', input(['order_date', 'region'], ['revenue']), 'line'],
  ['time split by an unmeasured category', input(['order_date', 'channel'], ['revenue']), 'line'],
  ['time split by a long category', input(['order_date', 'customer'], ['revenue']), 'heatmap'],
  ['a category listed before time', input(['region', 'order_date'], ['revenue']), 'line'],
  ['two dates', input(['order_date', 'ship_week'], ['revenue']), 'heatmap'],
  ['time, a category and two measures', input(['order_date', 'region'], ['revenue', 'orders']), 'table'],
  ['time and two categories', input(['order_date', 'region', 'segment'], ['revenue']), 'table'],
  ['a measure by category', input(['region'], ['revenue']), 'bar'],
  ['a distinct count by category', input(['region'], ['customers']), 'bar'],
  ['a rate by category', input(['region'], ['conversion']), 'bar'],
  ['a measure by a long category', input(['customer'], ['revenue']), 'bar'],
  ['a measure by a three-value category', input(['segment'], ['revenue']), 'bar'],
  ['a measure with negatives by category', input(['region'], ['profit']), 'bar'],
  ['a measure by twelve regions', input(['region12'], ['revenue']), 'bar'],
  ['a count by pipeline stage', input(['stage'], ['orders']), 'funnel'],
  ['two money measures by category', input(['region'], ['revenue', 'margin']), 'grouped_bar'],
  ['two money measures by forty customers', input(['customer'], ['revenue', 'margin']), 'scatter'],
  ['money and a count by four regions', input(['region'], ['revenue', 'orders']), 'table'],
  ['money and a count by an unmeasured category', input(['channel'], ['revenue', 'orders']), 'scatter'],
  ['three measures by fifteen products', input(['product'], ['revenue', 'margin', 'orders']), 'scatter'],
  ['three money measures by four regions', input(['region'], ['revenue', 'margin', 'cost']), 'grouped_bar'],
  ['four measures by category', input(['region'], ['revenue', 'margin', 'cost', 'orders']), 'table'],
  ['an additive measure by two categories', input(['region', 'segment'], ['revenue']), 'stacked_bar'],
  ['a distinct count by two categories', input(['region', 'segment'], ['customers']), 'heatmap'],
  ['a measure by customer and region', input(['region', 'customer'], ['revenue']), 'stacked_bar'],
  ['a measure by two long categories', input(['product', 'customer'], ['revenue']), 'heatmap'],
  ['two measures by two categories', input(['region', 'segment'], ['revenue', 'margin']), 'table'],
  ['three categories', input(['region', 'segment', 'channel'], ['revenue']), 'table'],
  ['a category and no measure', input(['region'], []), 'table'],
  ['nothing on the shelves', input([], []), 'table'],
  ['row details', input(['region'], ['revenue'], { rowDetail: true }), 'table'],
];

const isTime = (name: string) => name === 'order_date' || name === 'ship_week';

describe('Show Me (RFC 0009 step 2)', () => {
  it.each(CASES)('puts the right chart first for %s', (_label, fields, expected) => {
    const [first] = showMe(fields);
    expect(first?.chart).toBe(expected);
    expect(first?.available).toBe(true);
    expect(first?.recommended).toBe(true);
  });

  it('covers at least 40 field combinations', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it('draws every chart it offers the way it says, from the same fields', () => {
    for (const [, fields] of CASES) {
      for (const suggestion of showMe(fields).filter((entry) => entry.available && entry.encoding)) {
        const drawn = chartFromEncoding(suggestion.encoding!, isTime);
        const expected = suggestion.chart === 'kpi' ? 'kpi'
          : suggestion.chart === 'scatter' ? 'scatter'
            : suggestion.chart === 'heatmap' ? 'heatmap'
              : 'cartesian';
        // A pivot is drawn as a pivot from its shelves, whatever a chart would read them as.
        // A KPI with a date draws its trend as a sparkline under the number.
        const kpiTrend = suggestion.chart === 'kpi' && suggestion.encoding!.columns.length > 0;
        if (suggestion.chart !== 'pivot' && !kpiTrend) expect({ chart: suggestion.chart, kind: drawn.kind }).toEqual({ chart: suggestion.chart, kind: expected });
        if (drawn.kind === 'cartesian' && suggestion.chart !== 'pivot' && !kpiTrend) {
          // Bars over time are stored as bars; the line reading applies to line and area only.
          if (suggestion.chart === 'line' || suggestion.chart === 'area') expect(drawn.line).toBe(true);
          else if (!isTime(drawn.category)) expect(drawn.line).toBe(false);
          if (suggestion.chart === 'bar') expect(drawn.orientation).toBe('horizontal');
          if (suggestion.chart === 'column') expect(drawn.orientation).toBe('vertical');
        }
        // Rearranging never adds or drops a field.
        const query = queryFromEncoding(suggestion.encoding!, { dimensions: [], measures: [] }, () => undefined);
        expect(query.dimensions.map((entry) => entry.field).sort()).toEqual(fields.dimensions.map((entry) => entry.name).sort());
        expect(query.measures.map((entry) => entry.measure).sort()).toEqual(fields.measures.map((entry) => entry.name).sort());
      }
    }
  });

  it('greys out charts that would mislead, and says why', () => {
    const reason = (fields: ShowMeInput, chart: ShowMeChart) => {
      const suggestion = showMe(fields).find((entry) => entry.chart === chart)!;
      expect(suggestion.available).toBe(false);
      expect(suggestion.score).toBe(0);
      return suggestion.reason;
    };
    expect(reason(input(['region', 'segment'], ['customers']), 'stacked_bar')).toBe('Customers does not add up across Segment, so the stacked parts would not match the bar\'s total.');
    expect(reason(input(['region'], ['customers']), 'pie')).toContain('does not add up across Region');
    expect(reason(input(['region'], ['profit']), 'donut')).toBe('Profit has negative values, which a donut cannot show.');
    expect(reason(input(['region12'], ['revenue']), 'pie')).toBe('Region has 12 values; more than 6 slices cannot be compared. Use bars.');
    expect(reason(input(['order_date', 'customer'], ['revenue']), 'line')).toContain('Customer has 40 values; more than 8 lines');
    expect(reason(input(['order_date'], ['balance']), 'area')).toContain('does not add up across periods');
    expect(reason(input(['region'], ['revenue']), 'line')).toBe('A line joins points in time order, and Region is not a date. Bars compare categories.');
    expect(reason(input(['region'], ['revenue']), 'kpi')).toBe('A KPI shows one number. Remove Region to show one.');
    expect(reason(input([], ['revenue'], { comparison: true }), 'kpi')).toContain('period comparison');
    expect(reason(input(['region'], ['revenue'], { rowDetail: true }), 'bar')).toContain('Row details');
    // Unavailable charts follow the available ones.
    const ranked = showMe(input(['region'], ['revenue']));
    const firstUnavailable = ranked.findIndex((entry) => !entry.available);
    expect(ranked.slice(firstUnavailable).every((entry) => !entry.available)).toBe(true);
    expect(ranked.filter((entry) => entry.recommended)).toHaveLength(1);
  });

  it('never lets two units share an axis quietly', () => {
    const line = showMe(input(['order_date'], ['revenue', 'orders'])).find((entry) => entry.chart === 'line')!;
    expect(line.reason).toContain('different units');
    const grouped = showMe(input(['region'], ['revenue', 'orders'])).find((entry) => entry.chart === 'grouped_bar')!;
    expect(grouped.reason).toContain('A scatter gives each its own axis');
  });

  it('ranks the alternatives after the first choice', () => {
    const order = (fields: ShowMeInput) => showMe(fields).filter((entry) => entry.available).map((entry) => entry.chart);
    expect(order(input(['order_date'], ['revenue']))).toEqual(['line', 'area', 'column', 'kpi', 'table', 'pivot']);
    expect(order(input(['segment'], ['revenue']))).toEqual(['bar', 'column', 'donut', 'pie', 'funnel', 'table', 'pivot']);
    expect(order(input(['region', 'segment'], ['revenue']))).toEqual(['stacked_bar', 'heatmap', 'grouped_bar', 'pivot', 'table']);
  });

  it('reads the fields off the shelves and the facts off the Dataset contract', () => {
    const descriptor = {
      fields: [
        { kind: 'physical', name: 'order_date', type: 'date', role: 'time', status: 'approved' },
        { kind: 'physical', name: 'region', type: 'string', role: 'dimension', status: 'approved' },
        { kind: 'measure', name: 'revenue', aggregation: 'sum', additivity: { entities: 'additive', time: 'additive' }, format: { kind: 'currency', currency: 'USD' }, status: 'approved' },
        { kind: 'measure', name: 'customers', aggregation: 'count_distinct', additivity: { entities: 'non_additive', time: 'non_additive' }, status: 'approved' },
      ],
    } as unknown as DatasetDescriptor;
    const facts = showMeFactsFromDescriptor(descriptor, { cardinality: (name) => (name === 'region' ? 4 : undefined), nonNegative: () => true });
    const encoding: DashboardVizEncoding = {
      version: 1,
      columns: [{ dimension: 'order_date' }],
      rows: [{ measure: 'revenue' }],
      color: { dimension: 'region' },
      tooltip: [{ measure: 'customers' }],
    };
    expect(showMeInputFromEncoding(encoding, facts)).toEqual({
      dimensions: [{ name: 'order_date', time: true }, { name: 'region', time: false, cardinality: 4 }],
      measures: [{ name: 'revenue', additive: true, additiveOverTime: true, unit: 'currency:USD', nonNegative: true }],
    });
    const fromQuery = showMeInputFromQuery({ dimensions: [{ field: 'region' }], measures: [{ measure: 'customers' }], detail: undefined }, facts);
    expect(fromQuery.measures[0]).toMatchObject({ additive: false, unit: 'count' });
    expect(showMeFirstChoice(fromQuery).chart).toBe('bar');
  });

  it('reads a summed column as adding up when the measure shares its name (new-user round 3)', () => {
    // Customers from a table: `lifetime_spend` is the number column and the sum of it.
    const descriptor = {
      fields: [
        { kind: 'physical', name: 'customer_name', type: 'string', role: 'dimension', status: 'approved' },
        { kind: 'physical', name: 'lifetime_spend', type: 'number', role: 'attribute', status: 'approved' },
        { kind: 'measure', name: 'lifetime_spend', aggregation: 'sum', from: 'lifetime_spend', additivity: { entities: 'additive', time: 'additive' }, format: { kind: 'currency', currency: 'USD' }, status: 'approved' },
      ],
    } as unknown as DatasetDescriptor;
    const facts = showMeFactsFromDescriptor(descriptor, { cardinality: () => 4 });
    const fromQuery = showMeInputFromQuery({ dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }] }, facts);
    expect(fromQuery.measures[0]).toMatchObject({ additive: true, unit: 'currency:USD' });
    const pie = showMe(fromQuery).find((entry) => entry.chart === 'pie')!;
    expect(pie.available).toBe(true);
    expect(pie.reason).not.toContain('does not add up');
  });

  it('rearranges the shelves for a pick, keeping labels, tooltips and names', () => {
    const current: DashboardVizEncoding = {
      version: 1,
      columns: [{ dimension: 'order_date' }],
      rows: [{ measure: 'revenue' }],
      color: { dimension: 'region' },
      tooltip: [{ measure: 'orders' }],
      label: [{ measure: 'revenue' }],
      fields: { 'measure:revenue': { label: 'Net revenue' } },
    };
    const stacked = showMe(input(['order_date', 'region'], ['revenue'])).find((entry) => entry.chart === 'stacked_bar')!;
    expect(applyShowMe(current, stacked)).toEqual({ ...current, columns: [{ dimension: 'order_date' }], rows: [{ measure: 'revenue' }], color: { dimension: 'region' } });
    const heat = showMe(input(['order_date', 'region'], ['revenue'])).find((entry) => entry.chart === 'heatmap')!;
    expect(applyShowMe(current, heat)).toMatchObject({ columns: [{ dimension: 'order_date' }], rows: [{ dimension: 'region' }], color: { measure: 'revenue' }, tooltip: [{ measure: 'orders' }], fields: current.fields });
    const table = showMe(input(['order_date', 'region'], ['revenue'])).find((entry) => entry.chart === 'table')!;
    expect(applyShowMe(current, table)).toBe(current);
  });
});
