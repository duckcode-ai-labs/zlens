import { describe, expect, it } from 'vitest';
import type { DashboardDocument, DatasetDescriptor } from '@zlens/core';
import { resolveDashboardDatasetFilters, resolveRelativeDateRange } from './dashboard-dataset-filters.js';

const descriptor = {
  version: 1, id: 'app:block:commerce:orders', kind: 'block', sourceRevision: 'r1', snapshotId: 's1', label: 'Orders',
  contractRef: { kind: 'block_source', id: 'orders', fingerprint: 'c1' },
  binding: { sourceQualifiedId: 'orders', sourceRevision: 'r1', contractFingerprint: 'c1', state: 'valid' },
  lifecycle: 'certified', trust: 'certified', grain: { entityIds: ['order'], keyFields: ['order_id'] },
  fields: [
    { kind: 'physical', name: 'ordered_at', qualifiedId: 'orders.ordered_at', type: 'timestamp', role: 'time', status: 'approved', time: { grains: ['day'] } },
    { kind: 'physical', name: 'order_date', qualifiedId: 'orders.order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day'] } },
    { kind: 'physical', name: 'region', qualifiedId: 'orders.region', type: 'string', role: 'dimension', status: 'approved' },
  ],
  operations: ['filter', 'group'], execution: { route: 'certified' },
} as unknown as DatasetDescriptor;

function dashboard(field: string, timezone?: string): DashboardDocument {
  return {
    version: 3, id: 'overview', title: 'Overview', metadata: {},
    datasets: [{ id: 'orders', sourceId: 'app:block:commerce:orders', sourceRevision: 'r1', snapshotId: 's1', contractFingerprint: 'c1' }],
    filters: [{ id: 'period', type: 'relative_date', label: 'Period', ...(timezone ? { timezone } : {}), datasetBindings: { orders: { field } } }],
    layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 't1', x: 0, y: 0, w: 6, h: 4, sourceId: 'app:block:commerce:orders', sourceRevision: 'r1', query: { dimensions: [], measures: [{ measure: 'orders' }] }, viz: { type: 'single_value' } }] },
  } as unknown as DashboardDocument;
}

const resolveFor = (field: string, value: unknown, now: Date, timezone?: string) => {
  const doc = dashboard(field, timezone);
  return resolveDashboardDatasetFilters({ dashboard: doc, item: doc.layout.items[0]!, descriptor, values: { period: value }, now });
};

describe('relative date dashboard filters on dataset tiles', () => {
  it('resolves presets to inclusive calendar ranges ending today', () => {
    expect(resolveRelativeDateRange('last_7_days', '2026-03-10')).toEqual({ start: '2026-03-04', end: '2026-03-10' });
    expect(resolveRelativeDateRange('last_1_days', '2026-03-10')).toEqual({ start: '2026-03-10', end: '2026-03-10' });
    expect(resolveRelativeDateRange('last_90_days', '2026-03-01')).toEqual({ start: '2025-12-02', end: '2026-03-01' });
    expect(resolveRelativeDateRange('today', '2026-03-10')).toEqual({ start: '2026-03-10', end: '2026-03-10' });
    expect(resolveRelativeDateRange('yesterday', '2026-03-01')).toEqual({ start: '2026-02-28', end: '2026-02-28' });
    expect(resolveRelativeDateRange('month_to_date', '2026-03-10')).toEqual({ start: '2026-03-01', end: '2026-03-10' });
    expect(resolveRelativeDateRange('quarter_to_date', '2026-08-15')).toEqual({ start: '2026-07-01', end: '2026-08-15' });
    expect(resolveRelativeDateRange('year_to_date', '2026-08-15')).toEqual({ start: '2026-01-01', end: '2026-08-15' });
    for (const bad of ['last_0_days', 'last_99999_days', 'next_week', 'last_7_days; DROP']) {
      expect(resolveRelativeDateRange(bad, '2026-03-10')).toBeUndefined();
    }
  });

  it('bounds a date field with a start-inclusive, end-exclusive range', () => {
    const result = resolveFor('order_date', 'last_7_days', new Date('2026-03-10T12:00:00Z'));
    expect(result.errors).toEqual([]);
    expect(result.filters).toEqual([
      { field: 'order_date', op: 'gte', values: ['2026-03-04'] },
      { field: 'order_date', op: 'lt', values: ['2026-03-11'] },
    ]);
  });

  it('takes today from the filter timezone and compares a timestamp with calendar dates', () => {
    // 03:30 UTC on 9 March is still 8 March in New York, so "last 2 days" is 7–8 March.
    const result = resolveFor('ordered_at', 'last_2_days', new Date('2026-03-09T03:30:00Z'), 'America/New_York');
    expect(result.errors).toEqual([]);
    // Calendar dates, not New York instants: the month/day buckets group the
    // same column by its own clock, so the filter uses that calendar too (B5).
    expect(result.filters).toEqual([
      { field: 'ordered_at', op: 'gte', values: ['2026-03-07'] },
      { field: 'ordered_at', op: 'lt', values: ['2026-03-09'] },
    ]);
  });

  it('bounds a timestamp field without a declared timezone and still needs a date-typed binding', () => {
    expect(resolveFor('ordered_at', 'last_7_days', new Date('2026-03-10T00:00:00Z')).filters).toEqual([
      { field: 'ordered_at', op: 'gte', values: ['2026-03-04'] },
      { field: 'ordered_at', op: 'lt', values: ['2026-03-11'] },
    ]);
    expect(resolveFor('region', 'last_7_days', new Date('2026-03-10T00:00:00Z'), 'UTC').errors[0]?.message).toMatch(/not a date or timestamp/);
    expect(resolveFor('order_date', 'next_week', new Date('2026-03-10T00:00:00Z')).errors[0]?.code).toBe('FILTER_VALUE_INVALID');
  });
});

describe('one-sided date ranges on dataset tiles (D8)', () => {
  const rangeDashboard = (field: string) => {
    const doc = dashboard(field, 'America/New_York');
    doc.filters![0] = { ...doc.filters![0]!, type: 'daterange' };
    return doc;
  };
  const resolveRange = (field: string, value: unknown) => {
    const doc = rangeDashboard(field);
    return resolveDashboardDatasetFilters({ dashboard: doc, item: doc.layout.items[0]!, descriptor, values: { period: value } });
  };

  it('reads only a start as "from" and only an end as "until"', () => {
    expect(resolveRange('ordered_at', { start: '2025-03-01' })).toEqual({ filters: [{ field: 'ordered_at', op: 'gte', values: ['2025-03-01'] }], unbound: [], errors: [] });
    expect(resolveRange('order_date', { start: '', end: '2025-06-30' }).filters).toEqual([{ field: 'order_date', op: 'lt', values: ['2025-07-01'] }]);
  });

  it('skips a range with neither end, without an error', () => {
    expect(resolveRange('ordered_at', { start: '', end: '' })).toEqual({ filters: [], unbound: [], errors: [] });
  });
});

describe('keep only and exclude from a clicked mark (RFC 0009 step 6a)', () => {
  const page = (mappings: unknown[] = []) => ({
    version: 3, id: 'overview', title: 'Overview', metadata: {},
    datasets: [
      { id: 'orders', sourceId: 'app:block:commerce:orders', sourceRevision: 'r1', snapshotId: 's1', contractFingerprint: 'c1' },
      { id: 'other', sourceId: 'app:block:commerce:customers', sourceRevision: 'r9', snapshotId: 's9', contractFingerprint: 'c9' },
    ],
    interactions: mappings.length ? { crossFilter: { enabled: true, mappings } } : undefined,
    layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
      { i: 'regions', x: 0, y: 0, w: 6, h: 4, sourceId: 'app:block:commerce:orders', sourceRevision: 'r1', query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'orders' }] }, viz: { type: 'bar' } },
      { i: 'monthly', x: 6, y: 0, w: 6, h: 4, sourceId: 'app:block:commerce:orders', sourceRevision: 'r1', query: { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'orders' }] }, viz: { type: 'line' } },
    ] },
  }) as unknown as DashboardDocument;
  const click = (field: string, exclude?: boolean, fromTileId = 'regions') => ({ fromTileId, fromSourceId: 'app:block:commerce:orders', fromSourceRevision: 'r1', field, values: ['US'], ...(exclude ? { exclude } : {}) });
  const resolve = (doc: DashboardDocument, crossFilter: ReturnType<typeof click>) => resolveDashboardDatasetFilters({ dashboard: doc, item: doc.layout.items[1]!, descriptor, values: {}, crossFilters: [crossFilter] });

  it('filters every tile on the same Dataset by the same field, without an author mapping', () => {
    expect(resolve(page(), click('region')).filters).toEqual([{ field: 'region', op: 'eq', values: ['US'] }]);
  });

  it('excludes with not-equal', () => {
    expect(resolve(page(), click('region', true)).filters).toEqual([{ field: 'region', op: 'neq', values: ['US'] }]);
  });

  it('never treats a period as a value, and still needs a mapping to reach another Dataset', () => {
    const period = resolve(page(), click('order_date_month', false, 'monthly'));
    expect(period.filters).toEqual([]);
    expect(period.unbound[0]?.code).toBe('CROSS_FILTER_UNSUPPORTED');
  });
});
