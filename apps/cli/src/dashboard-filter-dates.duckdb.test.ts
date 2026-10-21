import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv, type DashboardDocument, type DatasetDescriptor, type TileQuery } from '@zlens/core';
import { applyDashboardFiltersToBlockExecution } from './local-runtime.js';
import { resolveDashboardDatasetFilters } from './datasets/dashboard-dataset-filters.js';
import { compileDatasetTileQuery } from './datasets/tile-query-compiler.js';

/**
 * The one App date rule on a real DuckDB: the Saved query / draft wrapper
 * keeps rows late on the chosen end date and a single date matches a
 * timestamp column. Needs a DuckDB connector root
 * (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;

const ORDERS = `SELECT * FROM (VALUES
  (1, TIMESTAMP '2026-02-28 23:59:59', DATE '2026-02-28'),
  (2, TIMESTAMP '2026-03-01 00:00:00', DATE '2026-03-01'),
  (3, TIMESTAMP '2026-03-31 23:30:00', DATE '2026-03-31'),
  (4, TIMESTAMP '2026-04-01 00:00:00', DATE '2026-04-01')
) AS orders(order_id, ordered_at, order_date)`;

describe('App date rule on DuckDB', () => {
  duckDbIt('keeps the whole end date and matches a timestamp on a single date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-filter-dates-'));
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: join(dir, 'dates.duckdb'), moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    const ids = async (filter: { id: string; type: 'daterange' | 'date' }, column: string, value: unknown) => {
      const applied = applyDashboardFiltersToBlockExecution({
        sql: ORDERS,
        sqlParams: [],
        variables: { [filter.id]: value },
        block: { name: 'Orders' },
        dashboard: { filters: [filter] },
        tileFilterBindings: [{ filter: filter.id, binding: column, mode: 'predicate' }],
      });
      expect(applied.appliedFilters).toHaveLength(1);
      const result = await executor.executeQuery(`${applied.sql} ORDER BY order_id`, applied.sqlParams, applied.variables, connection);
      return result.rows.map((row) => Number(row.order_id));
    };
    try {
      expect(await ids({ id: 'period', type: 'daterange' }, 'ordered_at', ['2026-03-01', '2026-03-31'])).toEqual([2, 3]);
      expect(await ids({ id: 'period', type: 'daterange' }, 'order_date', ['2026-03-01', '2026-03-31'])).toEqual([2, 3]);
      expect(await ids({ id: 'day', type: 'date' }, 'ordered_at', '2026-03-31')).toEqual([3]);
      expect(await ids({ id: 'day', type: 'date' }, 'order_date', '2026-03-31')).toEqual([3]);
      // One-sided ranges (D8): only a start is "from", only an end is "until".
      expect(await ids({ id: 'period', type: 'daterange' }, 'ordered_at', { start: '2026-03-01' })).toEqual([2, 3, 4]);
      expect(await ids({ id: 'period', type: 'daterange' }, 'ordered_at', { end: '2026-03-31' })).toEqual([1, 2, 3]);
      expect(await ids({ id: 'period', type: 'daterange' }, 'order_date', { start: '', end: '2026-02-28' })).toEqual([1]);
    } finally {
      await executor.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * B5: a range ending 30 June must not plot a July point on a month-bucketed
 * line, whatever timezone the filter was created in. The month buckets group
 * the timestamp by its own clock, so the filter compares the same calendar.
 */
const lineDescriptor = {
  version: 1, id: 'app:block:commerce:orders', kind: 'block', sourceRevision: 'r1', snapshotId: 's1', label: 'Orders',
  contractRef: { kind: 'block_source', id: 'orders', fingerprint: 'c1' },
  binding: { sourceQualifiedId: 'orders', sourceRevision: 'r1', contractFingerprint: 'c1', state: 'valid' },
  lifecycle: 'certified', trust: 'certified', grain: { entityIds: ['order'], keyFields: ['order_id'], keyEvidence: 'proof' },
  fields: [
    { kind: 'physical', name: 'order_id', qualifiedId: 'orders.order_id', type: 'number', role: 'key', status: 'approved' },
    { kind: 'physical', name: 'ordered_at', qualifiedId: 'orders.ordered_at', type: 'timestamp', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
    { kind: 'physical', name: 'amount', qualifiedId: 'orders.amount', type: 'number', role: 'attribute', status: 'approved' },
    { kind: 'measure', name: 'revenue', qualifiedId: 'orders.m.revenue', aggregation: 'sum', from: 'amount', dependsOn: ['amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
  ],
  operations: ['filter', 'group', 'trend'], execution: { route: 'certified' },
} as unknown as DatasetDescriptor;

const LINE_ORDERS = `SELECT * FROM (VALUES
  (1, TIMESTAMP '2025-02-28 23:30:00', 1000.0),
  (2, TIMESTAMP '2025-03-01 00:30:00', 10.0),
  (3, TIMESTAMP '2025-04-15 12:00:00', 20.0),
  (4, TIMESTAMP '2025-06-30 23:30:00', 30.0),
  (5, TIMESTAMP '2025-07-01 00:30:00', 5.0),
  (6, TIMESTAMP '2025-07-01 03:00:00', 7.0)
) AS orders(order_id, ordered_at, amount)`;

describe('App date filter and month buckets on DuckDB (B5)', () => {
  duckDbIt('a range ending 30 June keeps 23:30 on 30 June and plots no July point, with or without a filter timezone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-filter-buckets-'));
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: join(dir, 'buckets.duckdb'), moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    const monthly = async (value: unknown, timezone?: string) => {
      const query: TileQuery = { dimensions: [{ field: 'ordered_at', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] };
      const doc = {
        version: 3, id: 'overview', title: 'Overview', metadata: {},
        datasets: [{ id: 'orders', sourceId: 'app:block:commerce:orders', sourceRevision: 'r1', snapshotId: 's1', contractFingerprint: 'c1' }],
        filters: [{ id: 'period', type: 'daterange', label: 'Period', ...(timezone ? { timezone } : {}), datasetBindings: { orders: { field: 'ordered_at' } } }],
        layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 't1', x: 0, y: 0, w: 6, h: 4, sourceId: 'app:block:commerce:orders', sourceRevision: 'r1', query, viz: { type: 'line' } }] },
      } as unknown as DashboardDocument;
      const resolved = resolveDashboardDatasetFilters({ dashboard: doc, item: doc.layout.items[0]!, descriptor: lineDescriptor, values: { period: value } });
      expect(resolved.errors).toEqual([]);
      const compiled = compileDatasetTileQuery({ descriptor: lineDescriptor, query, driver: 'duckdb', sourceSql: LINE_ORDERS, filters: resolved.filters });
      const result = await executor.executeQuery(compiled.sql, compiled.sqlParams, compiled.variables, connection);
      return Object.fromEntries((result.rows as Array<Record<string, unknown>>).map((row) => {
        const bucket = row.ordered_at_month instanceof Date ? row.ordered_at_month.toISOString() : String(row.ordered_at_month);
        return [bucket.slice(0, 7), Number(row.revenue)];
      }));
    };
    try {
      const expected = { '2025-03': 10, '2025-04': 20, '2025-06': 30 };
      const range = { start: '2025-03-01', end: '2025-06-30' };
      expect(await monthly(range)).toEqual(expected);
      expect(await monthly(range, 'America/New_York')).toEqual(expected);
      expect(await monthly(range, 'Asia/Kolkata')).toEqual(expected);
      expect(await monthly(range, 'UTC')).toEqual(expected);
      // One-sided ranges use the same calendar.
      expect(await monthly({ start: '2025-07-01' }, 'America/Los_Angeles')).toEqual({ '2025-07': 12 });
      expect(await monthly({ end: '2025-02-28' }, 'Asia/Tokyo')).toEqual({ '2025-02': 1000 });
    } finally {
      await executor.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
