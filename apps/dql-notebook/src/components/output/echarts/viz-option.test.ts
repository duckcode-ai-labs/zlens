import { describe, expect, it } from 'vitest';
import type { QueryResult } from '../../../store/types';
import { DQL_SERIES_DARK, DQL_SERIES_LIGHT } from '../chart-palettes';
import { buildVizOption, chronological, MAX_SERIES } from './viz-option';
import { renderOptionToSvg } from './EChartsChart';

const monthly: QueryResult = {
  columns: ['order_month', 'revenue'],
  rows: [
    { order_month: '2026-06-01', revenue: 1.53 },
    { order_month: '2026-07-01', revenue: 1.46 },
    { order_month: '2026-08-01', revenue: 1.39 },
    { order_month: '2026-09-01', revenue: 1.36 },
  ],
  rowCount: 4,
  executionTime: 1,
};

const regions: QueryResult = {
  columns: ['region', 'revenue'],
  rows: [{ region: 'US', revenue: 1.86 }, { region: 'EU', revenue: 1.22 }, { region: 'APAC', revenue: 0.78 }],
  rowCount: 3,
  executionTime: 1,
};

const series = (option: any) => option.series as any[];

describe('buildVizOption (RFC 0008 step 4)', () => {
  it('turns reference lines, bands and dated notes into chart marks', () => {
    const built = buildVizOption({
      chartType: 'line', result: monthly, themeMode: 'paper',
      config: { chart: 'line', style: {
        referenceLines: [{ value: 1.5, label: 'Target' }],
        bands: [{ from: 1.45, to: 1.55, label: 'Target range' }],
        annotations: [{ at: '2026-07', text: 'EU price change' }, { at: '2031-01', text: 'Not on this chart' }],
      } },
    })!;
    const first = series(built.option)[0];
    expect(first.markLine.data).toEqual([
      expect.objectContaining({ yAxis: 1.5, name: 'Target' }),
      expect.objectContaining({ xAxis: 1, name: 'EU price change' }),
    ]);
    expect(first.markArea.data).toEqual([[expect.objectContaining({ yAxis: 1.45, name: 'Target range' }), { yAxis: 1.55 }]]);
  });

  it('draws dates left to right with an emphasised last point, and named categories as horizontal bars', () => {
    const line = buildVizOption({ chartType: 'line', result: monthly, themeMode: 'paper', config: { chart: 'line' } })!;
    expect((line.option.xAxis as any).type).toBe('category');
    expect((line.option.xAxis as any).data).toEqual(['Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026']);
    expect(series(line.option)[0].data.at(-1)).toMatchObject({ value: 1.36, symbol: 'circle', symbolSize: 8 });

    const bars = buildVizOption({ chartType: 'bar', result: regions, themeMode: 'paper', config: { chart: 'bar' } })!;
    expect((bars.option.yAxis as any)).toMatchObject({ type: 'category', inverse: true, data: ['US', 'EU', 'APAC'] });
    expect(series(bars.option)[0].itemStyle.borderRadius).toEqual([0, 4, 4, 0]);
    // A column named "category" is not a date.
    const category = buildVizOption({ chartType: 'bar', result: { ...regions, columns: ['category', 'revenue'], rows: regions.rows.map((row) => ({ category: row.region, revenue: row.revenue })) }, themeMode: 'paper', config: { chart: 'bar' } })!;
    expect((category.option.yAxis as any).type).toBe('category');
  });

  it('draws periods oldest to newest even when the query returns them out of order', () => {
    const shuffled = { ...monthly, rows: [monthly.rows[0], monthly.rows[2], monthly.rows[1], monthly.rows[3]] };
    const line = buildVizOption({ chartType: 'line', result: shuffled, themeMode: 'paper', config: { chart: 'line' } })!;
    expect((line.option.xAxis as any).data).toEqual(['Jun 2026', 'Jul 2026', 'Aug 2026', 'Sep 2026']);
    expect(series(line.option)[0].data.map((point: any) => point?.value ?? point)).toEqual([1.53, 1.46, 1.39, 1.36]);
    // An explicit sort still wins, and named categories keep query order.
    const sorted = buildVizOption({ chartType: 'bar', result: shuffled, themeMode: 'paper', config: { chart: 'bar', style: { sort: 'asc' } } })!;
    expect((sorted.option.xAxis as any).data[0]).toBe('Sep 2026');
    expect(chronological(['US', 'EU'])).toEqual(['US', 'EU']);
    expect(chronological(['2024', '2022', '2023'])).toEqual(['2022', '2023', '2024']);
  });

  it('labels only the last mark when asked, and sorts by value', () => {
    const built = buildVizOption({ chartType: 'bar', result: regions, themeMode: 'paper', config: { chart: 'bar', style: { labels: 'last', sort: 'asc' } } })!;
    expect(built.categories).toEqual(['APAC', 'EU', 'US']);
    const data = series(built.option)[0].data;
    expect(data[0]).toBe(0.78);
    expect(data[2]).toMatchObject({ value: 1.86, label: { show: true } });
  });

  it('stacks series with rounding only on the top segment', () => {
    const result: QueryResult = {
      columns: ['quarter', 'web', 'app'],
      rows: [{ quarter: 'Q1', web: 1.8, app: 1.28 }, { quarter: 'Q2', web: 1.9, app: 1.42 }],
      rowCount: 2, executionTime: 1,
    };
    const built = buildVizOption({ chartType: 'stacked-bar', result, themeMode: 'paper', config: { chart: 'stacked-bar' } })!;
    const [web, app] = series(built.option);
    expect(web).toMatchObject({ stack: 'total', name: 'Web', itemStyle: { borderRadius: 0 } });
    expect(app.itemStyle.borderRadius).not.toBe(0);
    expect((built.option.legend as any).show).toBe(true);
  });

  it('never cycles colours: at most eight series, and a pie folds the rest into Other', () => {
    const wide: QueryResult = {
      columns: ['month', ...Array.from({ length: 10 }, (_, index) => `m${index}`)],
      rows: [Object.fromEntries([['month', '2026-01-01'], ...Array.from({ length: 10 }, (_, index) => [`m${index}`, index + 1])])],
      rowCount: 1, executionTime: 1,
    };
    const lines = buildVizOption({ chartType: 'line', result: wide, themeMode: 'paper', config: { chart: 'line' } })!;
    expect(series(lines.option)).toHaveLength(MAX_SERIES);
    expect(lines.droppedSeries).toBe(2);

    const slices: QueryResult = {
      columns: ['country', 'revenue'],
      rows: Array.from({ length: 11 }, (_, index) => ({ country: `C${index}`, revenue: 100 - index })),
      rowCount: 11, executionTime: 1,
    };
    const pie = buildVizOption({ chartType: 'donut', result: slices, themeMode: 'paper', config: { chart: 'donut' } })!;
    const data = series(pie.option)[0].data;
    expect(data).toHaveLength(8);
    expect(data.at(-1)).toEqual({ name: 'Other', value: 93 + 92 + 91 + 90 });
  });

  it('uses the dark series and ramp on dark themes', () => {
    expect(buildVizOption({ chartType: 'bar', result: regions, themeMode: 'obsidian', config: { chart: 'bar' } })!.option.color).toEqual([...DQL_SERIES_DARK]);
    expect(buildVizOption({ chartType: 'bar', result: regions, themeMode: 'paper', config: { chart: 'bar' } })!.option.color).toEqual([...DQL_SERIES_LIGHT]);
  });

  it('formats values compactly when asked', () => {
    const big: QueryResult = { ...regions, rows: [{ region: 'US', revenue: 1_860_000 }] };
    const built = buildVizOption({ chartType: 'bar', result: big, themeMode: 'paper', config: { chart: 'bar', style: { format: 'compact' } } })!;
    expect((built.option.xAxis as any).axisLabel.formatter(1_860_000)).toBe('1.9M');
  });

  it('reads heatmaps in long and wide form and leaves types it does not draw to the caller', () => {
    const long = buildVizOption({
      chartType: 'heatmap', themeMode: 'paper', config: { chart: 'heatmap' },
      result: { columns: ['region', 'channel', 'revenue'], rows: [{ region: 'US', channel: 'Web', revenue: 800 }, { region: 'US', channel: 'App', revenue: 600 }], rowCount: 2, executionTime: 1 },
    })!;
    expect((long.option.xAxis as any).data).toEqual(['Web', 'App']);
    expect(series(long.option)[0].data).toEqual([[0, 0, 800], [1, 0, 600]]);
    expect(buildVizOption({ chartType: 'kpi', result: regions, themeMode: 'paper' })).toBeUndefined();
    expect(buildVizOption({ chartType: 'scatter', result: regions, themeMode: 'paper' })).toBeUndefined();
  });

  it('escapes result text in rendered SVG', () => {
    const hostile: QueryResult = { ...regions, rows: [{ region: '<script>alert(1)</script>', revenue: 1 }] };
    const svg = renderOptionToSvg(buildVizOption({ chartType: 'bar', result: hostile, themeMode: 'paper', config: { chart: 'bar' } })!, 400, 200);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script');
  });
});

describe('series with different units', () => {
  it('formats each measure in the tooltip with its own unit', () => {
    const result = {
      columns: ['order_date_month', 'revenue_per_order', 'share'],
      rows: [{ order_date_month: '2026-01-01', revenue_per_order: 60, share: 0.41 }],
      columnsMeta: [
        { name: 'order_date_month', kind: 'date' },
        { name: 'revenue_per_order', kind: 'currency', unit: 'USD', label: 'Revenue per order' },
        { name: 'share', kind: 'percent', unit: 'fraction', label: 'Percent of total' },
      ],
    } as unknown as QueryResult;
    const option = buildVizOption({ chartType: 'grouped-bar', result, themeMode: 'paper', config: { chart: 'grouped-bar', x: 'order_date_month', metrics: ['share', 'revenue_per_order'] } })!.option as { series: Array<{ name: string; data: unknown[]; tooltip?: { valueFormatter: (value: unknown) => string } }> };
    expect(option.series.map((series) => [series.name, series.tooltip?.valueFormatter(series.data[0])])).toEqual([['Percent of total', '41%'], ['Revenue per order', '$60.0']]);
  });
});

describe('an axis shared by different units', () => {
  it('names no unit on the axis', () => {
    const result = {
      columns: ['m', 'price', 'share'],
      rows: [{ m: '2026-01-01', price: 60, share: 0.41 }],
      columnsMeta: [{ name: 'm', kind: 'date' }, { name: 'price', kind: 'currency', unit: 'USD' }, { name: 'share', kind: 'percent', unit: 'fraction' }],
    } as unknown as QueryResult;
    const option = buildVizOption({ chartType: 'grouped-bar', result, themeMode: 'paper', config: { chart: 'grouped-bar', x: 'm', metrics: ['share', 'price'] } })!.option as { yAxis: { axisLabel: { formatter: (value: number) => string } } };
    expect(option.yAxis.axisLabel.formatter(60)).toBe('60');
  });
});

describe('the chosen "Y / value" field', () => {
  const revenueAndOrders: QueryResult = {
    columns: ['month', 'gross_revenue', 'order_count'],
    rows: [
      { month: '2025-01-01', gross_revenue: 1200, order_count: 30 },
      { month: '2025-02-01', gross_revenue: 1500, order_count: 41 },
      { month: '2025-03-01', gross_revenue: 900, order_count: 22 },
    ],
    rowCount: 3,
    executionTime: 1,
  };

  it.each(['line', 'area', 'bar'] as const)('is the only series of a %s chart', (chartType) => {
    const built = buildVizOption({ chartType, result: revenueAndOrders, themeMode: 'paper', config: { chart: chartType, x: 'month', y: 'gross_revenue' } })!;
    expect(series(built.option).map((entry) => entry.name)).toEqual(['Gross Revenue']);
    expect(series(built.option)[0].data.map((point: any) => (typeof point === 'object' && point ? point.value : point))).toEqual([1200, 1500, 900]);
  });

  it('leaves every number column on a line chart when no value field is chosen', () => {
    const built = buildVizOption({ chartType: 'line', result: revenueAndOrders, themeMode: 'paper', config: { chart: 'line', x: 'month' } })!;
    expect(series(built.option)).toHaveLength(2);
  });

  it('keeps the measures on the shelves, and every measure of a stacked bar', () => {
    const shelves = buildVizOption({ chartType: 'line', result: revenueAndOrders, themeMode: 'paper', config: { chart: 'line', x: 'month', y: 'gross_revenue', metrics: ['gross_revenue', 'order_count'], orientation: 'vertical' } })!;
    expect(series(shelves.option)).toHaveLength(2);
    const stacked = buildVizOption({ chartType: 'stacked-bar', result: revenueAndOrders, themeMode: 'paper', config: { chart: 'stacked-bar', x: 'month', y: 'gross_revenue' } })!;
    expect(series(stacked.option)).toHaveLength(2);
  });
});
