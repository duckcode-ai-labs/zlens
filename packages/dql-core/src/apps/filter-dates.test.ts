import { describe, expect, it } from 'vitest';
import {
  dashboardDateBoundsForColumn,
  describeDashboardDateRange,
  isEmptyDashboardDateValue,
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
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: 'March' })).toMatchObject({ kind: 'error' });
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: ['2026-03-31', '2026-03-01'] })).toMatchObject({ kind: 'error' });
  });

  it('returns nothing for an empty value or a filter type it does not own', () => {
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: [] })).toBeNull();
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'date', value: '' })).toBeNull();
    expect(resolveDashboardDateFilter({ filterId: 'region', type: 'select', value: 'East' })).toBeNull();
  });

  it('compares every column with calendar dates, timestamps included, so buckets and filter share one calendar', () => {
    const bounds = { startDate: '2026-03-07', endDate: '2026-03-08', endExclusiveDate: '2026-03-09' };
    expect(dashboardDateBoundsForColumn(bounds, 'date')).toEqual({ start: '2026-03-07', endExclusive: '2026-03-09' });
    expect(dashboardDateBoundsForColumn(bounds, 'unknown')).toEqual({ start: '2026-03-07', endExclusive: '2026-03-09' });
    // No instant in a timezone: 23:30 on 8 March stays in, 00:30 on 9 March stays out,
    // whatever zone the filter was created in (B5).
    expect(dashboardDateBoundsForColumn(bounds, 'timestamp')).toEqual({ start: '2026-03-07', endExclusive: '2026-03-09' });
    expect(dashboardDateBoundsForColumn({ startDate: '2026-03-07' }, 'timestamp')).toEqual({ start: '2026-03-07' });
    expect(dashboardDateBoundsForColumn({ endDate: '2026-03-08', endExclusiveDate: '2026-03-09' }, 'date')).toEqual({ endExclusive: '2026-03-09' });
  });

  it('reads a one-sided range as "from" or "until" (D8)', () => {
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: { start: '2025-03-01' } })).toEqual({
      kind: 'calendar', bounds: { startDate: '2025-03-01' },
    });
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: { start: '2025-03-01', end: '' } })).toEqual({
      kind: 'calendar', bounds: { startDate: '2025-03-01' },
    });
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: { end: '2025-06-30' } })).toEqual({
      kind: 'calendar', bounds: { endDate: '2025-06-30', endExclusiveDate: '2025-07-01' },
    });
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: ['', '2025-06-30'] })).toEqual({
      kind: 'calendar', bounds: { endDate: '2025-06-30', endExclusiveDate: '2025-07-01' },
    });
    expect(resolveDashboardDateFilter({ filterId: 'season', type: 'daterange', value: { min: 2016 } })).toEqual({ kind: 'explicit', start: 2016 });
  });

  it('treats a range with neither end as no value', () => {
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: { start: '', end: '' } })).toBeNull();
    expect(resolveDashboardDateFilter({ filterId: 'period', type: 'daterange', value: ['', null] })).toBeNull();
    expect(isEmptyDashboardDateValue({ start: '', end: undefined })).toBe(true);
    expect(isEmptyDashboardDateValue({ start: '2025-03-01' })).toBe(false);
    expect(isEmptyDashboardDateValue({ region: '' })).toBe(false);
  });

  it('describes a range the way the control shows it', () => {
    expect(describeDashboardDateRange({ start: '2025-03-01' })).toBe('From 1 Mar 2025');
    expect(describeDashboardDateRange({ end: '2025-06-30' })).toBe('Until 30 Jun 2025');
    expect(describeDashboardDateRange({ start: '2025-03-01', end: '2025-06-30' })).toBe('1 Mar 2025 – 30 Jun 2025');
    expect(describeDashboardDateRange({ start: '', end: '' })).toBeNull();
    expect(describeDashboardDateRange(undefined)).toBeNull();
  });
});
