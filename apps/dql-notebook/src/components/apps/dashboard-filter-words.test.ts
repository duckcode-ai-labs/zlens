import { describe, expect, it } from 'vitest';
import {
  dataSourceCountWords,
  describeDashboardFilterValues,
  formatDashboardFilterValue,
  runDataSourceCount,
} from './dashboard-filter-words';
import { formatVariableEntryValue } from './app-variables';
import { storyFilterChips } from './dashboard-presentation';

describe('dashboard filter words', () => {
  it('writes every kind of value as a person would say it', () => {
    expect(formatDashboardFilterValue({ start: '2025-01-01', end: '2025-06-30' })).toBe('1 Jan 2025 – 30 Jun 2025');
    expect(formatDashboardFilterValue({ start: '2025-01-01' })).toBe('From 1 Jan 2025');
    expect(formatDashboardFilterValue({ end: '2025-06-30' })).toBe('Until 30 Jun 2025');
    expect(formatDashboardFilterValue({ start: '', end: '' })).toBeNull();
    expect(formatDashboardFilterValue({ min: 500, max: 1000 })).toBe('500 – 1,000');
    expect(formatDashboardFilterValue({ min: 500 })).toBe('At least 500');
    expect(formatDashboardFilterValue({ max: 1000 }, { type: 'number_range' })).toBe('At most 1,000');
    expect(formatDashboardFilterValue(['EU', 'US'])).toBe('EU, US');
    expect(formatDashboardFilterValue([])).toBeNull();
    expect(formatDashboardFilterValue('last_30_days')).toBe('Last 30 days');
    expect(formatDashboardFilterValue('2025-03-01')).toBe('1 Mar 2025');
    expect(formatDashboardFilterValue(true)).toBe('Yes');
    expect(formatDashboardFilterValue(2024, { id: 'season' })).toBe('2024');
    expect(formatDashboardFilterValue('')).toBeNull();
  });

  it('labels declared filters by their label and skips internal keys', () => {
    expect(describeDashboardFilterValues(
      { ordered_at: { start: '2025-01-01' }, customer_name: 'Angela Moyer', smartView: 'x', __viewer: 'y', region: '' },
      [{ id: 'ordered_at', type: 'daterange', label: 'Order date' }],
    )).toEqual([
      { id: 'ordered_at', label: 'Order date', value: 'From 1 Jan 2025' },
      { id: 'customer_name', label: 'Customer Name', value: 'Angela Moyer' },
    ]);
  });

  it('counts distinct data sources, not story evidence', () => {
    expect(runDataSourceCount([
      { dataset: { sourceId: 'orders' } },
      { dataset: { sourceId: 'orders' } },
      { blockPath: 'blocks/revenue.dql' },
      { tileType: 'text' },
    ])).toBe(2);
    expect(dataSourceCountWords(1)).toBe('1 data source');
    expect(dataSourceCountWords(2)).toBe('2 data sources');
  });

  it('never prints JSON for a range in Research or the summary story', () => {
    expect(formatVariableEntryValue('ordered_at', { start: '2025-01-01', end: '2025-06-30' })).toBe('1 Jan 2025 – 30 Jun 2025');
    expect(storyFilterChips(
      { ordered_at: { start: '2025-01-01', end: '2025-06-30' }, region: ['EU'] },
      [{ id: 'ordered_at', type: 'daterange', label: 'Ordered At' }],
    )).toEqual([
      { label: 'Ordered At', value: '1 Jan 2025 – 30 Jun 2025' },
      { label: expect.any(String), value: 'EU' },
    ]);
  });
});
