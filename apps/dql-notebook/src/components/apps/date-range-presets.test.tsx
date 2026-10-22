import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DashboardFilterControls } from './app-dashboard-filters';
import { DateRangePresetSelect } from './date-range-presets';

/** New-user round 3, problem 9: date presets, and the reader's date control says which date it is. */
describe('date range quick choices', () => {
  it('offers Last 7 days to This year and Custom, naming what a range is', () => {
    const markup = renderToStaticMarkup(<DateRangePresetSelect label="Ordered At" value={{ start: '2025-03-01' }} onChange={vi.fn()} />);
    expect(markup).toContain('aria-label="Ordered At quick range"');
    for (const label of ['Any date', 'Last 7 days', 'Last 30 days', 'This month', 'This quarter', 'This year', 'Custom']) expect(markup).toContain(`>${label}</option>`);
    expect(markup).toMatch(/<option value="custom" selected="">Custom<\/option>/);
    expect(renderToStaticMarkup(<DateRangePresetSelect label="Ordered At" value={undefined} onChange={vi.fn()} />)).toMatch(/<option value="any" selected="">Any date<\/option>/);
  });

  it('shows the reader the filter name next to its quick choices and dates', () => {
    const markup = renderToStaticMarkup(<DashboardFilterControls
      filters={[{ id: 'ordered_at', label: 'Ordered At', type: 'daterange' } as any]}
      values={{}}
      onChange={vi.fn()}
    />);
    expect(markup).toContain('<span class="dql-app-filter-label">Ordered At</span>');
    expect(markup).toContain('aria-label="Ordered At quick range"');
    expect(markup).toContain('aria-label="Ordered At from"');
  });
});
