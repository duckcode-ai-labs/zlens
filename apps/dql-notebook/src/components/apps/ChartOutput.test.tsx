import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChartOutput, renderChart } from '../output/ChartOutput';

describe('App-sized chart rendering (UI-022)', () => {
  it('fits a monthly bar series to the measured tile height with business date labels', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      month: `2024-${String(index + 1).padStart(2, '0')}-01T00:00:00.000Z`,
      gross_revenue: (index + 1) * 1_000,
    }));
    const markup = renderToStaticMarkup(renderChart('bar', {
      columns: ['month', 'gross_revenue'],
      rows,
      rowCount: rows.length,
      executionTime: 4,
    }, 'light', { chart: 'bar', x: 'month', y: 'gross_revenue' }, 240));

    // Business month labels, never raw ISO instants; ECharts thins labels
    // that would overlap, so not every month is printed.
    expect(markup).toContain('Jan 2024');
    expect(markup.match(/[A-Z][a-z]{2} 2024/g)!.length).toBeGreaterThanOrEqual(4);
    expect(markup).not.toContain('2024-01-01T00:0');
    expect(markup).toContain('height="236"');
  });

  it('uses one series color when no categorical color field is configured', () => {
    const markup = renderToStaticMarkup(renderChart('bar', {
      columns: ['category', 'revenue'],
      rows: [
        { category: 'A', revenue: 10 },
        { category: 'B', revenue: 20 },
        { category: 'C', revenue: 30 },
      ],
      rowCount: 3,
      executionTime: 2,
    }, 'light', { chart: 'bar' }, 180));

    // The first DQL series colour for light themes; never one colour per bar.
    expect(markup).toContain('fill="#00897b"');
    expect(markup).not.toContain('fill="#3659c9"');
    expect(markup).not.toContain('fill="#e08a1a"');
  });

  it('uses measured narrow width so labels are not scaled from a desktop viewBox', () => {
    const markup = renderToStaticMarkup(renderChart('line', {
      columns: ['month', 'gross_revenue'],
      rows: [
        { month: '2025-01-01T00:00:00.000Z', gross_revenue: 10_000 },
        { month: '2025-02-01T00:00:00.000Z', gross_revenue: 12_000 },
      ],
      rowCount: 2,
      executionTime: 2,
    }, 'light', { chart: 'line' }, 220, 252));

    expect(markup).toContain('viewBox="0 0 252 216"');
    expect(markup).not.toContain('viewBox="0 0 560');
  });

  it('exposes a keyboard-addressable bar mark only when an App supplies a typed selection callback', () => {
    const result = {
      columns: ['region', 'revenue'],
      rows: [{ region: 'CA', revenue: 60 }],
      rowCount: 1,
      executionTime: 2,
    };
    const interactive = renderToStaticMarkup(renderChart('bar', result, 'light', { chart: 'bar' }, 180, undefined, () => undefined));
    const passive = renderToStaticMarkup(renderChart('bar', result, 'light', { chart: 'bar' }, 180));

    // A real button per mark: Tab reaches it and a screen reader names it.
    expect(interactive).toContain('<button type="button" aria-label="Select CA">');
    expect(passive).not.toContain('<button');
  });

  it('renders a null drilled measure as unavailable while retaining a real zero', () => {
    const markup = renderToStaticMarkup(renderChart('bar', {
      columns: ['order_id', 'revenue'],
      columnsMeta: [
        { name: 'order_id', kind: 'text', ref: 'dimension:order_id' },
        { name: 'revenue', kind: 'currency', ref: 'measure:revenue' },
      ],
      rows: [
        { order_id: 'O-100', revenue: 60 },
        { order_id: 'O-101', revenue: null },
        { order_id: 'O-103', revenue: 0 },
      ],
      rowCount: 3,
      executionTime: 2,
    }, 'light', { chart: 'bar', x: 'order_id', y: 'revenue' }, 180));

    expect(markup).toContain('O-101');
    expect(markup).toContain('>—</text>');
    expect(markup).toContain('$0');
  });
});

describe('a chart on a field its data does not have (V11)', () => {
  // A bar of lifetime_spend over a result with only customer_name threw
  // "Cannot read properties of undefined (reading 'replace')" and blanked
  // App Studio, even after a reload.
  const names = { columns: ['customer_name'], rows: [{ customer_name: 'Bob' }, { customer_name: 'Alice' }], rowCount: 2, executionTime: 1 };

  it('says the field is not in the data instead of crashing the page', () => {
    for (const chart of ['bar', 'line', 'area', 'stacked-bar', 'grouped-bar', 'pie', 'donut', 'funnel']) {
      const markup = renderToStaticMarkup(<ChartOutput result={names} themeMode="light" chartConfig={{ chart, x: 'customer_name', y: 'lifetime_spend' }} />);
      expect(markup, chart).toContain('data-testid="chart-missing-field"');
      expect(markup, chart).toContain('This field isn\u2019t in the data: Lifetime Spend. Pick another field, or edit the tile.');
    }
    // With no field named, it says what is missing.
    expect(renderToStaticMarkup(<ChartOutput result={names} themeMode="light" chartConfig={{ chart: 'bar' }} />)).toContain('This chart has no value to show: its data has no number column.');
    // A chart whose named field is missing but another value can stand in is drawn as before.
    const withSpend = { columns: ['customer_name', 'lifetime_spend'], rows: [{ customer_name: 'Bob', lifetime_spend: 200 }], rowCount: 1, executionTime: 1 };
    expect(renderToStaticMarkup(<ChartOutput result={withSpend} themeMode="light" chartConfig={{ chart: 'bar', x: 'customer_name', y: 'lifetime_value' }} />)).not.toContain('chart-missing-field');
  });
});
