import { describe, expect, it } from 'vitest';
import {
  dashboardDateBoundsForColumn,
  resolveDashboardDateFilter,
  resolveRelativeDateRange,
} from './filter-dates.js';

describe('the one App date rule', () => {
  it('turns a date range into start-inclusive, end-exclusive at the next day', () => {
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: ['2026-03-01', '2026-03-31'] })).toEqual({
      kind: 'calendar',
      bounds: { startDate: '2026-03-01', endDate: '2026-03-31', endExclusiveDate: '2026-04-01' },
    });
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: { start: '2025-12-01', end: '2025-12-31' } })).toMatchObject({
      bounds: { endExclusiveDate: '2026-01-01' },
    });
  });

  it('makes a single date that whole day so it matches a timestamp column', () => {
    expect(resolveDashboardDateFilter({ filterId: 'day', type: 'date', value: '2024-02-29' })).toEqual({
      kind: 'calendar',
      bounds: { startDate: '2024-02-29', endDate: '2024-02-29', endExclusiveDate: '2024-03-01' },
    });
    // A picker that sends a full ISO instant still means that calendar day.
    expect(resolveDashboardDateFilter({ filterId: 'day', type: 'date', value: '2024-02-29T00:00:00.000Z' })).toMatchObject({
      bounds: { startDate: '2024-02-29', endExclusiveDate: '2024-03-01' },
    });
    expect(resolveDashboardDateFilter({ filterId: 'day', type: 'date', value: 'yesterday-ish' })).toMatchObject({ kind: 'error' });
  });

  it('resolves a relative date to a range first, with today taken in the filter timezone', () => {
    // 02:00 UTC on 10 March is still 9 March in Los Angeles.
    const now = new Date('2026-03-10T02:00:00Z');
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'relative_date', value: 'last_7_days', timezone: 'America/Los_Angeles', now })).toEqual({
      kind: 'calendar',
      bounds: { startDate: '2026-03-03', endDate: '2026-03-09', endExclusiveDate: '2026-03-10' },
    });
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'relative_date', value: 'last_7_days', now })).toMatchObject({
      bounds: { startDate: '2026-03-04', endDate: '2026-03-10' },
    });
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'relative_date', value: 'next_week', now })).toMatchObject({ kind: 'error' });
    expect(resolveRelativeDateRange('quarter_to_date', '2026-05-17')).toEqual({ start: '2026-04-01', end: '2026-05-17' });
  });

  it('keeps explicit non-calendar boundaries as written', () => {
    expect(resolveDashboardDateFilter({ filterId: 'season', type: 'daterange', value: [2016, 2017] })).toEqual({ kind: 'explicit', start: 2016, end: 2017 });
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: ['2026-03-01'] })).toMatchObject({ kind: 'error' });
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: ['2026-03-31', '2026-03-01'] })).toMatchObject({ kind: 'error' });
  });

  it('returns nothing for an empty value or a filter type it does not own', () => {
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: [] })).toBeNull();
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'date', value: '' })).toBeNull();
    expect(resolveDashboardDateFilter({ filterId: 'region', type: 'select', value: 'East' })).toBeNull();
  });

  it('compares date columns with calendar dates and timestamp columns with local-midnight instants', () => {
    const bounds = { startDate: '2026-03-07', endDate: '2026-03-08', endExclusiveDate: '2026-03-09' };
    expect(dashboardDateBoundsForColumn(bounds, 'date')).toEqual({ start: '2026-03-07', endExclusive: '2026-03-09' });
    expect(dashboardDateBoundsForColumn(bounds, 'unknown', 'America/New_York')).toEqual({ start: '2026-03-07', endExclusive: '2026-03-09' });
    // The US switches to daylight time on 8 March 2026: the end is 04:00Z, not 05:00Z.
    expect(dashboardDateBoundsForColumn(bounds, 'timestamp', 'America/New_York')).toEqual({
      start: '2026-03-07T05:00:00.000Z',
      endExclusive: '2026-03-09T04:00:00.000Z',
    });
    expect(dashboardDateBoundsForColumn(bounds, 'timestamp')).toMatchObject({ error: expect.stringMatching(/IANA timezone/) });
  });
});
