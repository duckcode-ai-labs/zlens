import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { PACKET_JOINS, PACKET_KEYS, REVIEWER_PACKET_TABLES, descriptionOf, draftOnWarehouse, grainsOf, identitiesOf, joinsOf, tpchSnapshot, tpchStatements } from './testkit/tpch-shaped.js';

/**
 * V2 review F1 on real DuckDB: TPC-H tables copied with no declared keys are
 * drafted one row per *KEY, with the joins the reviewer packet needs, through
 * the statements the first-open draft runs. Needs a DuckDB connector root
 * (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT); CI's real-driver step sets it.
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;

describe('model drafts on TPC-H copies with no declared keys, on DuckDB (V2 review, F1)', () => {
  duckDbIt('drafts one row per *KEY and the three packet joins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-tpch-draft-'));
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: join(root, 'review.duckdb'), moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    try {
      for (const statement of tpchStatements()) await executor.executePositional(statement, [], connection);
      const run = async (sql: string) => ({ rows: (await executor.executePositional(sql, [], connection)).rows as Array<Record<string, unknown>> });
      const report = await draftOnWarehouse(tpchSnapshot(REVIEWER_PACKET_TABLES, 'duckdb', 'duckdb'), run, 'duckdb');
      expect(identitiesOf(report)).toEqual(PACKET_KEYS);
      expect(grainsOf(report)).toEqual(PACKET_KEYS);
      expect(joinsOf(report)).toEqual(PACKET_JOINS);
      expect(descriptionOf(report, 'CUSTOMER')).toBe('One row per C_CUSTKEY: 150 rows.');
      expect(descriptionOf(report, 'ORDERS')).toMatch(/^One row per O_ORDERKEY: 1,500 rows; O_ORDERDATE 1992-01-01–/);
      expect((report.rules ?? []).filter((rule) => /repeat|COMMENT|ADDRESS/.test(`${rule.id} ${rule.expression}`))).toEqual([]);
    } finally {
      await executor.disconnect();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
