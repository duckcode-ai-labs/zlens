import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import type { WarehouseCatalogRelationV1 } from '@zlens/core';
import { addLakeSizes } from './lake-sizes.js';
import { ReadBudgetError, boundedReads } from './read-budget.js';

/**
 * Open-formats plan L4 on real DuckDB: a lake table's size from its files'
 * metadata, and ZLens's own checks kept within the read budget by reading
 * whole files spread across the table. Needs a DuckDB connector root
 * (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT); CI's real-driver step sets it.
 */
const connectorRoot = process.env.ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT?.trim();
const duckDbIt = connectorRoot ? it : it.skip;

describe('lake tables at scale on DuckDB (L4)', () => {
  duckDbIt('sizes a folder from its footers, then reads a sample of its files when a check would read more than the budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-lake-scale-'));
    const executor = new QueryExecutor();
    const writer: ConnectionConfig = { driver: 'duckdb', filepath: ':memory:', moduleSearchPaths: [connectorRoot!] };
    try {
      const path = (part: string) => join(root, part).replace(/'/g, "''");
      mkdirSync(join(root, 'orders'));
      mkdirSync(join(root, 'customers'));
      // 80 files of 100 orders each (one schema), and 3 files of customers.
      for (let index = 0; index < 80; index += 1) {
        await executor.executePositional(`COPY (SELECT ${index} * 100 + i AS order_id, i % 7 AS customer_id, 1.0 * i AS amount FROM range(100) t(i)) TO '${path(`orders/part-${String(index).padStart(3, '0')}.parquet`)}' (FORMAT parquet)`, [], writer);
      }
      for (let index = 0; index < 3; index += 1) {
        await executor.executePositional(`COPY (SELECT ${index} * 3 + i AS customer_id FROM range(3) t(i)) TO '${path(`customers/part-${index}.parquet`)}' (FORMAT parquet)`, [], writer);
      }
      const lake: ConnectionConfig = {
        driver: 'file',
        sources: [{ name: 'orders', path: join(root, 'orders'), format: 'parquet' }, { name: 'customers', path: join(root, 'customers'), format: 'parquet' }],
        moduleSearchPaths: [connectorRoot!],
      };
      const rows = async (sql: string) => (await executor.executePositional(sql, [], lake)).rows as Array<Record<string, unknown>>;
      // The catalog as sync reads it: each view with its SQL and columns.
      const views = await rows("SELECT database_name, schema_name, view_name, sql FROM duckdb_views() WHERE view_name IN ('orders', 'customers') ORDER BY view_name");
      const relations: WarehouseCatalogRelationV1[] = [];
      for (const view of views) {
        const columns = await rows(`SELECT column_name FROM duckdb_columns() WHERE table_name = '${String(view.view_name)}' ORDER BY column_index`);
        relations.push({
          id: `warehouse.${String(view.view_name)}`,
          name: String(view.view_name),
          relation: `${String(view.database_name)}.${String(view.schema_name)}.${String(view.view_name)}`,
          kind: 'view',
          viewSql: String(view.sql),
          columns: columns.map((column) => ({ name: String(column.column_name) })),
        });
      }
      const [customers, orders] = relations;
      expect(await addLakeSizes(relations, rows)).toEqual({ sized: 2, notSized: [], timedOut: 0 });
      // Up to 64 files every footer is read: exact. Above, 16 spread files stand for the rest.
      expect(customers).toMatchObject({ rowCountEstimate: 9, sizeFrom: 'footers of all 3 files' });
      expect(orders!.sizeFrom).toBe('footers of 16 of 80 files (estimated)');
      expect(orders!.rowCountEstimate).toBeGreaterThan(7_000);
      expect(orders!.rowCountEstimate).toBeLessThan(9_000);
      expect(orders!.columns.every((column) => (column.bytesEstimate ?? 0) > 0)).toBe(true);

      // A budget of a few files' worth of order_id: the check reads whole files spread across the folder.
      const perFile = orders!.columns.find((column) => column.name === 'order_id')!.bytesEstimate! / 80;
      const bounded = boundedReads({ run: async (sql) => ({ rows: await rows(sql) }), snapshot: { relations }, budget: { remote: perFile * 4.5, local: perFile * 4.5 } });
      const quoted = orders!.relation.split('.').map((part) => `"${part}"`).join('.');
      const [sampled] = (await bounded.run(`SELECT COUNT(*) AS n, COUNT(DISTINCT "order_id") AS d FROM ${quoted}`)).rows;
      expect(Number(sampled!.n)).toBe(Number(sampled!.d));
      expect(Number(sampled!.n) % 100).toBe(0);
      expect(Number(sampled!.n)).toBeLessThan(8_000);
      const [note] = bounded.notes();
      expect(note!.kind).toBe('sampled');
      expect(note!.text).toMatch(/^orders: checked on \d of 80 files spread across it, about/);
      // COUNT(*) alone reads only metadata: the whole table, as written.
      expect((await bounded.run(`SELECT COUNT(*) AS n FROM ${quoted}`)).rows).toEqual([{ n: 8000 }]);
      // A lookup into a table over the budget is never sampled.
      const lookup = `SELECT COUNT(*) AS n FROM "${customers!.relation.split('.').join('"."')}" WHERE customer_id NOT IN (SELECT customer_id FROM ${quoted} WHERE order_id >= 0)`;
      await expect(bounded.run(lookup, { sample: [customers!.relation] })).rejects.toThrow(ReadBudgetError);
    } finally {
      await executor.disconnect();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
