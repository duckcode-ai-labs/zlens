import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { applyDashboardFiltersToBlockExecution } from './local-runtime.js';

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
    } finally {
      await executor.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
