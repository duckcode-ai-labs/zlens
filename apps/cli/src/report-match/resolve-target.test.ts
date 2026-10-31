import { describe, expect, it } from 'vitest';
import type { DimensionDefinition, MetricDefinition } from '@zlens/core';
import { ComparisonStopped } from './compare.js';
import { readExport } from './read-export.js';
import { columnShape, isFilterAnswered, parseStatedFilter, resolveFilterField, resolveMetricTarget, resolveQueryTarget, type TargetCatalog } from './resolve-target.js';

const metric = (name: string, label: string, extra: Partial<MetricDefinition> = {}): MetricDefinition => ({ name, label, description: '', domain: 'sales', type: 'sum', sql: name, table: 'analytics.orders', ...extra });
const dimension = (name: string, label: string, extra: Partial<DimensionDefinition> = {}): DimensionDefinition => ({ name, label, description: '', sql: name, type: 'string', table: 'analytics.orders', ...extra });

const catalog: TargetCatalog = {
  metrics: [
    metric('total_sales', 'Total Sales', { sql: 'sales', synonyms: ['Revenue'] }),
    metric('sum_of_profit', 'Sum of Profit', { sql: 'profit' }),
    metric('orders', 'Orders', { type: 'count_distinct', sql: 'order_id' }),
    metric('profit_ratio', 'Profit Ratio', { type: 'custom', sql: 'profit_ratio', table: '', metricType: 'ratio', typeParams: { numerator: 'sum_of_profit', denominator: 'total_sales' } }),
  ],
  dimensions: [dimension('region', 'Region'), dimension('order_date', 'Order Date', { type: 'date', isTimeDimension: true })],
  columnsOf: (table) => (table === 'analytics.orders' ? [{ name: 'year', sql: 'year' }, { name: 'store_id', sql: 'store_id' }, { name: 'region', sql: 'region' }] : undefined),
};

const file = (text: string) => readExport(Buffer.from(text), 'export.csv');

describe('working out what the columns are', () => {
  it('matches names against labels, names and synonyms, and says what it did', () => {
    const target = resolveMetricTarget(file('Region,Total Sales,Profit Ratio\nEast,$10.00,12.5%\n'), catalog);
    expect(target.dimensions).toEqual(['region']);
    expect(target.metrics.map((item) => item.name)).toEqual(['total_sales', 'profit_ratio']);
    expect(target.plan.keys).toEqual([{ header: 'Region', output: 'region', kind: 'text' }]);
    expect(target.mapping).toEqual({ Region: 'the dimension region', 'Total Sales': 'the metric total_sales', 'Profit Ratio': 'the metric profit_ratio' });
    expect(resolveMetricTarget(file('Region,Revenue\nEast,10.5\n'), catalog).metrics[0]!.name).toBe('total_sales');
  });

  it('reads how Tableau and Power BI name an aggregate', () => {
    const name = (header: string) => resolveMetricTarget(file(`Region,${header}\nEast,1.5\n`), catalog).metrics[0]!.name;
    expect(name('SUM(Sales)')).toBe('total_sales');
    expect(name('Sum of Sales')).toBe('total_sales');
    expect(name('SUM(Profit)')).toBe('sum_of_profit');
    expect(name('CNTD(Order ID)')).toBe('orders');
    expect(name('AGG(Profit Ratio)')).toBe('profit_ratio');
  });

  it('groups by a date at the grain the header or the values say', () => {
    const byHeader = resolveMetricTarget(file('Month of Order Date,Total Sales\nJanuary 2026,1.5\n'), catalog);
    expect(byHeader.timeDimension).toEqual({ name: 'order_date', granularity: 'month' });
    expect(byHeader.plan.keys[0]).toEqual({ header: 'Month of Order Date', output: 'order_date_month', kind: 'date', grain: 'month' });
    expect(resolveMetricTarget(file('Order Date,Total Sales\nQ1 2026,1.5\n'), catalog).timeDimension).toEqual({ name: 'order_date', granularity: 'quarter' });
    expect(resolveMetricTarget(file('Order Date,Total Sales\n2026-01-05,1.5\n'), catalog).timeDimension).toEqual({ name: 'order_date', granularity: 'day' });
    expect(resolveMetricTarget(file('YEAR(Order Date),Total Sales\n2026,1.5\n'), catalog).timeDimension).toEqual({ name: 'order_date', granularity: 'year' });
    expect(resolveMetricTarget(file('Order Date,Total Sales\n2025,1.5\n2026,2.5\n'), catalog).timeDimension).toEqual({ name: 'order_date', granularity: 'year' });
  });

  it('treats a plain whole number that matches no metric as a key, using the table\'s column', () => {
    const target = resolveMetricTarget(file('year,Total Sales\n2025,1.5\n2026,2.5\n'), catalog);
    expect(target.throwaway[0]).toMatchObject({ sql: 'year', table: 'analytics.orders' });
    expect(target.dimensions).toEqual([target.throwaway[0]!.name]);
    expect(target.mapping.year).toContain('for this comparison');
  });

  it('leaves a number with nothing to compare with out, and says so', () => {
    const target = resolveMetricTarget(file('Region,Total Sales,Discount\nEast,1.5,$2.50\n'), catalog);
    expect(target.plan.notCompared).toEqual(['Discount']);
    expect(target.mapping.Discount).toContain('not compared');
  });

  it('takes the person\'s word: map, key and ignore', () => {
    const mapped = resolveMetricTarget(file('Area,Amount\nEast,1.5\n'), catalog, { map: { Area: 'region', Amount: 'total_sales' } });
    expect(mapped.dimensions).toEqual(['region']);
    expect(mapped.metrics[0]!.name).toBe('total_sales');
    const ignored = resolveMetricTarget(file('Region,Total Sales,Discount\nEast,1.5,$2.50\n'), catalog, { ignore: ['Discount'] });
    expect(ignored.plan.notCompared).toEqual([]);
    expect(ignored.mapping.Discount).toBe('left out, as asked');
    const key = resolveMetricTarget(file('store_id,Total Sales\n1.5,2.5\n'), catalog, { keys: ['store_id'] });
    expect(key.plan.keys[0]!.header).toBe('store_id');
    expect(() => resolveMetricTarget(file('Region,Total Sales\nEast,1.5\n'), catalog, { ignore: ['Nope'] })).toThrow('no column Nope');
    expect(() => resolveMetricTarget(file('Region,Total Sales\nEast,1.5\n'), catalog, { map: { Region: 'nope' } })).toThrow('no metric or dimension named nope');
  });

  it('keeps Profit % apart from Profit, and non-Latin names apart from each other', () => {
    const ignored = resolveMetricTarget(file('Region,Profit %,Sum of Profit\nEast,5%,1.5\n'), catalog, { ignore: ['Profit %'] });
    expect(ignored.metrics.map((item) => item.name)).toEqual(['sum_of_profit']);
    const chinese = file('Region,利润,销售额\nEast,1.5,2.5\n');
    const named: TargetCatalog = { ...catalog, metrics: [metric('profit_cn', '利润'), metric('sales_cn', '销售额')] };
    const target = resolveMetricTarget(chinese, named, { ignore: ['利润'] });
    expect(target.metrics.map((item) => item.name)).toEqual(['sales_cn']);
    expect(isFilterAnswered('地区', [], ['日期: 全部'])).toBe(false);
    expect(isFilterAnswered('地区', [], ['地区: 全部'])).toBe(true);
  });

  it('stops on two columns that mean one metric, since a record holds one result for it', () => {
    expect(() => resolveMetricTarget(file('Region,Total Sales,SUM(Sales)\nEast,1.5,1.6\n'), catalog)).toThrow('both match the metric total_sales');
  });

  it('settles a name that means two things from how the column looks, and otherwise asks', () => {
    const both: TargetCatalog = { ...catalog, metrics: [...catalog.metrics, metric('region_sales', 'Region')] };
    expect(resolveMetricTarget(file('Region,Total Sales\nEast,1.5\n'), both).dimensions).toEqual(['region']);
    expect(resolveMetricTarget(file('Store,Region\nA,$1.50\n'), { ...both, dimensions: [...both.dimensions, dimension('store', 'Store')] }).metrics[0]!.name).toBe('region_sales');
    expect(() => resolveMetricTarget(file('Store,Region\nA,15\n'), { ...both, dimensions: [...both.dimensions, dimension('store', 'Store')] })).toThrow('could be the metric region_sales or the dimension region');
    const twins: TargetCatalog = { ...catalog, metrics: [...catalog.metrics, metric('other', 'Total Sales')] };
    expect(() => resolveMetricTarget(file('Region,Total Sales\nEast,1.5\n'), twins)).toThrow('could be any of these metrics');
  });

  it('prefers the dimension on the metric\'s table when two tables have the name', () => {
    const twoTables: TargetCatalog = { ...catalog, dimensions: [dimension('customer_region', 'Region', { table: 'analytics.customers' }), ...catalog.dimensions] };
    expect(resolveMetricTarget(file('Region,Total Sales\nEast,1.5\n'), twoTables).dimensions).toEqual(['region']);
  });

  it('stops, with the fix, on what cannot be built', () => {
    const stop = (text: string) => expect(() => resolveMetricTarget(file(text), catalog)).toThrow(ComparisonStopped);
    stop('Segment,Total Sales\nSMB,1.5\n');
    stop('Region,Nothing\nEast,x\n');
    expect(() => resolveMetricTarget(file('Month of Order Date,Total Sales\nJanuary,1.5\n'), catalog)).toThrow('does not say which year');
    expect(() => resolveMetricTarget(file('Order Date,year,Total Sales\n2026-01-05,2026-01-05,1.5\n'), catalog)).toThrow('two date columns');
    expect(() => resolveMetricTarget(file('Total Sales,Region\nabc,East\n'), catalog)).toThrow('its values are not numbers');
  });
});

describe('how a column looks', () => {
  it('tells keys from numbers', () => {
    expect(columnShape(['East', 'West'])).toBe('text');
    expect(columnShape(['2024', '2025'])).toBe('plain-number');
    expect(columnShape(['$1.50', '2'])).toBe('marked-number');
    expect(columnShape(['1,234', '5,678'])).toBe('marked-number');
    expect(columnShape(['02134', '10001'])).toBe('text');
    expect(columnShape(['2026-01-05', '2026-02-01'])).toBe('date');
    expect(columnShape(['January 2026'])).toBe('date');
    expect(columnShape(['', 'Null'])).toBe('empty');
  });
});

describe('a saved query as the target', () => {
  it('matches columns by name, and sorts keys from numbers by how they look', () => {
    const { plan, mapping } = resolveQueryTarget(file('Store,Revenue,Note\nA,$1.50,1\n'), ['store', 'revenue']);
    expect(plan.keys).toEqual([{ header: 'Store', output: 'store', kind: 'text' }]);
    expect(plan.numbers).toEqual([{ header: 'Revenue', output: 'revenue', name: 'revenue' }]);
    expect(plan.notCompared).toEqual(['Note']);
    expect(mapping.Store).toBe('the column store');
  });

  it('stops when a key column is not in the query', () => {
    expect(() => resolveQueryTarget(file('Segment,Revenue\nA,1.5\n'), ['revenue'])).toThrow('changes the rows');
  });
});

describe('stating a filter', () => {
  it('reads the strict form', () => {
    expect(parseStatedFilter('order_date >= 2024-01-01')).toMatchObject({ field: 'order_date', operator: 'gte', values: ['2024-01-01'] });
    expect(parseStatedFilter('Order Date < 2025-01-01')).toMatchObject({ field: 'Order Date', operator: 'lt' });
    expect(parseStatedFilter('region = East')).toMatchObject({ operator: 'equals', values: ['East'] });
    expect(parseStatedFilter('region != "New York"')).toMatchObject({ operator: 'not_equals', values: ['New York'] });
    expect(parseStatedFilter('region in (East, West)')).toMatchObject({ operator: 'in', values: ['East', 'West'] });
    expect(parseStatedFilter('order_date between 2024-01-01 and 2024-12-31')).toMatchObject({ operator: 'between', values: ['2024-01-01', '2024-12-31'] });
    expect(parseStatedFilter("name = 'a or b'")).toMatchObject({ values: ['a or b'] });
  });

  it('refuses anything else, so nothing is applied differently from how it was meant', () => {
    for (const text of ['region like East', 'region', '= East', 'region = East or West', 'order_date between 2024', 'region in ()', 'sum(sales) > 5']) {
      expect(() => parseStatedFilter(text), text).toThrow(ComparisonStopped);
    }
  });

  it('finds the field, or a column of the metric\'s table, or stops', () => {
    const target = { metrics: [catalog.metrics[0]!], throwaway: [] as DimensionDefinition[] };
    expect(resolveFilterField('Order Date', catalog, target)).toBe('order_date');
    expect(resolveFilterField('store_id', catalog, target)).toBe('filter_storeid');
    expect(target.throwaway[0]).toMatchObject({ sql: 'store_id' });
    expect(() => resolveFilterField('Segment', catalog, target)).toThrow('--waive');
  });

  it('counts a filter as answered when it is stated or waived', () => {
    expect(isFilterAnswered('Order Date', ['order_date'], [])).toBe(true);
    expect(isFilterAnswered('Order Date', [], ['Order Date: covers every row'])).toBe(true);
    expect(isFilterAnswered('Order Date', ['region'], ['Region: x'])).toBe(false);
  });
});
