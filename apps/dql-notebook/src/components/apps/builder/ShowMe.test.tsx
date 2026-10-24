import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import type { DashboardVizEncoding } from '@zlens/core/apps/viz-encoding';
import { ShowMePanel, currentShowMeChart, tileShowMe } from './ShowMe';
import { ShelfEditor, describeEncodedChart } from './ShelfEditor';
import { descriptorTimeField } from './field-query';
import type { QueryResult } from '../../../store/types';

const descriptor = {
  version: 1, id: 'orders', kind: 'block', label: 'Orders',
  fields: [
    { kind: 'physical', name: 'region', qualifiedId: 'f.region', type: 'string', role: 'dimension', status: 'approved' },
    { kind: 'physical', name: 'customer', qualifiedId: 'f.customer', type: 'string', role: 'dimension', status: 'approved' },
    { kind: 'physical', name: 'order_date', qualifiedId: 'f.order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
    { kind: 'measure', name: 'revenue', qualifiedId: 'm.revenue', aggregation: 'sum', additivity: { entities: 'additive', time: 'additive' }, format: { kind: 'currency', currency: 'USD' }, status: 'approved' },
    { kind: 'measure', name: 'buyers', qualifiedId: 'm.buyers', aggregation: 'count_distinct', additivity: { entities: 'non_additive', time: 'non_additive' }, status: 'approved' },
  ],
} as unknown as DatasetDescriptor;
const isTime = descriptorTimeField(descriptor);

const overTime: DashboardVizEncoding = { version: 1, columns: [{ dimension: 'order_date' }], rows: [{ measure: 'revenue' }], color: { dimension: 'customer' } };
const overTimeQuery = { dimensions: [{ field: 'order_date', timeGrain: 'month' }, { field: 'customer' }], measures: [{ measure: 'revenue' }] };

describe('Show Me in Studio (RFC 0009 step 2)', () => {
  it('counts values in the tile result: forty customers make a heatmap, not forty lines', () => {
    const result: QueryResult = {
      columns: ['order_date_month', 'customer', 'revenue'],
      rows: Array.from({ length: 40 }, (_, index) => ({ order_date_month: '2026-01-01', customer: `C-${index}`, revenue: 10 })),
      rowCount: 40, executionTime: 1,
    };
    const ranked = tileShowMe(descriptor, overTime, overTimeQuery, result);
    expect(ranked[0]).toMatchObject({ chart: 'heatmap', recommended: true });
    expect(ranked.find((entry) => entry.chart === 'line')).toMatchObject({ available: false, reason: expect.stringContaining('Customer has 40 values') });
    // Without a result, the count is unknown and a line per customer is offered.
    expect(tileShowMe(descriptor, overTime, overTimeQuery)[0]?.chart).toBe('line');
  });

  it('counts every value of a field the tile groups by alone, not only the rows it loaded (new-user round 3)', () => {
    const query = { dimensions: [{ field: 'customer' }], measures: [{ measure: 'revenue' }] };
    const bars: DashboardVizEncoding = { version: 1, columns: [{ measure: 'revenue' }], rows: [{ dimension: 'customer' }] };
    const result: QueryResult = {
      columns: ['customer', 'revenue'],
      rows: Array.from({ length: 500 }, (_, index) => ({ customer: `C-${index}`, revenue: 10 })),
      rowCount: 935, executionTime: 1,
    };
    const pie = tileShowMe(descriptor, bars, query, result).find((entry) => entry.chart === 'pie');
    expect(pie?.reason).toContain('Customer has 935 values');
  });

  it('names fields as the author renamed them', () => {
    const renamed = { ...overTime, fields: { 'measure:revenue': { label: 'Net sales' } } };
    expect(tileShowMe(descriptor, renamed, overTimeQuery)[0]?.reason).toContain('Net sales over Order Date');
  });

  it('reads which chart a tile draws now', () => {
    const bars: DashboardVizEncoding = { version: 1, columns: [{ measure: 'revenue' }], rows: [{ dimension: 'region' }] };
    const columns: DashboardVizEncoding = { version: 1, columns: [{ dimension: 'region' }], rows: [{ measure: 'revenue' }] };
    expect(currentShowMeChart('bar', bars, isTime)).toBe('bar');
    expect(currentShowMeChart('bar', columns, isTime)).toBe('column');
    expect(currentShowMeChart('kpi', { version: 1, columns: [], rows: [{ measure: 'revenue' }] }, isTime)).toBe('kpi');
    expect(currentShowMeChart('stacked_bar', bars, isTime)).toBe('stacked_bar');
    expect(currentShowMeChart('line', { ...columns, detail: [{ dimension: 'customer' }] }, isTime)).toBe('table');
    // The sentence under the shelves names the chart that was picked.
    expect(describeEncodedChart(overTime, isTime, 'stacked_bar')).toBe('Stacked bars over Order Date, split by Customer.');
    expect(describeEncodedChart(overTime, isTime, 'line')).toBe('A line over Order Date, split by Customer.');
    expect(describeEncodedChart(bars, isTime, 'donut')).toBe('A donut of Revenue by Region.');
  });

  it('marks the best chart, greys out the ones that do not fit and says why', () => {
    const bars: DashboardVizEncoding = { version: 1, columns: [{ measure: 'buyers' }], rows: [{ dimension: 'region' }] };
    const suggestions = tileShowMe(descriptor, bars, { dimensions: [{ field: 'region' }], measures: [{ measure: 'buyers' }] });
    const markup = renderToStaticMarkup(<ShowMePanel suggestions={suggestions} current="bar" disabled={false} onPick={() => undefined} />);
    expect(markup).toContain('aria-label="Show Me"');
    expect(markup).toContain('role="radiogroup" aria-label="Chart type"');
    expect(markup).toMatch(/class="on best"[^>]*>.*?Horizontal bars.*?Best/);
    // A distinct count cannot be cut into slices.
    expect(markup).toMatch(/aria-disabled="true"[^>]*class="unfit"[^>]*title="Buyers does not add up across Region, so the slices would not make a whole."/);
    expect(markup).toContain('<strong>Horizontal bars</strong> Compares Buyers across Region');
  });

  it('sits under the shelves when the tile has a chart type', () => {
    const query = { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] };
    const bars: DashboardVizEncoding = { version: 1, columns: [{ measure: 'revenue' }], rows: [{ dimension: 'region' }] };
    const withShowMe = renderToStaticMarkup(<ShelfEditor descriptor={descriptor} encoding={bars} query={query} disabled={false} onChange={() => undefined} visualization="bar" />);
    expect(withShowMe).toContain('aria-label="Show Me"');
    const without = renderToStaticMarkup(<ShelfEditor descriptor={descriptor} encoding={bars} query={query} disabled={false} onChange={() => undefined} />);
    expect(without).not.toContain('aria-label="Show Me"');
  });
});

describe('Show Me when the drawn chart no longer fits (RFC 0009 evaluation B1, B4)', () => {
  it('gives every chart its own accessible reason and offers the best chart in place of one that no longer fits', () => {
    const result: QueryResult = {
      columns: ['order_date_month', 'customer', 'revenue'],
      rows: Array.from({ length: 40 }, (_, index) => ({ order_date_month: '2026-01-01', customer: `C-${index}`, revenue: 10 })),
      rowCount: 40, executionTime: 1,
    };
    const suggestions = tileShowMe(descriptor, overTime, overTimeQuery, result);
    const markup = renderToStaticMarkup(<ShowMePanel suggestions={suggestions} current="line" disabled={false} onPick={() => undefined} />);
    expect(markup).toContain('<strong>Line no longer fits.</strong>');
    expect(markup).toContain('>Use Heatmap</button>');
    const line = /aria-describedby="([^"]+-line)"/.exec(markup)![1];
    expect(markup).toContain(`id="${line}">Does not fit: Customer has 40 values`);
    const kpi = /aria-describedby="([^"]+-kpi)"/.exec(markup)![1];
    expect(kpi).not.toBe(line);
  });
});
