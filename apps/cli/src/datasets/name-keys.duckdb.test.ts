import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { startLocalServer } from '../local-runtime.js';

/**
 * New-user round 3 on real DuckDB, through the local runtime: two customers
 * called Maria Lopez stay two bars (problem 4), on the Customers table and
 * through Orders' Customer join, a bar told apart by its key filters to that
 * one customer, a filter's value list still reads plain names, a name with no
 * key says it may repeat, and a table made into a Dataset says so in Add data
 * (problem 7). Needs a DuckDB connector root
 * (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;

type Json = any;

describe('names grouped by their key on DuckDB (new-user round 3)', () => {
  duckDbIt('keeps namesakes apart, filters one of them, lists plain names, warns without a key, and marks added tables', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-name-keys-'));
    const databasePath = join(projectRoot, 'shop.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    let base = '';
    const call = async (path: string, body?: unknown): Promise<{ status: number; body: Json; text: string }> => {
      const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
    };
    try {
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
        project: 'shop', manifestVersion: 3, modeling: { mode: 'warehouse-first' }, apps: { datasets: true },
        connections: { default: { driver: 'duckdb', filepath: './shop.duckdb' } },
      }));
      for (const statement of [
        'CREATE TABLE main.customers (customer_id VARCHAR, customer_name VARCHAR, lifetime_spend DOUBLE)',
        "INSERT INTO main.customers VALUES ('C1', 'Maria Lopez', 300), ('C2', 'Maria Lopez', 200), ('C3', 'Bob', 50)",
        'CREATE TABLE main.orders (order_id VARCHAR, customer_id VARCHAR, store_name VARCHAR, ordered_at TIMESTAMP, order_total DOUBLE)',
        [
          'INSERT INTO main.orders VALUES',
          "('O1', 'C1', 'Brooklyn', TIMESTAMP '2026-01-05 10:00:00', 100),",
          "('O2', 'C1', 'Philadelphia', TIMESTAMP '2026-01-20 10:00:00', 50),",
          "('O3', 'C2', 'Brooklyn', TIMESTAMP '2026-02-02 10:00:00', 25),",
          "('O4', 'C3', 'Brooklyn', TIMESTAMP '2026-02-10 10:00:00', 10)",
        ].join(' '),
      ]) await executor.executePositional(statement, [], connection);
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      base = `http://127.0.0.1:${port}`;

      expect((await call('/api/connections/default/metadata-sync', {})).status).toBe(200);
      const discovered = await call('/api/modeling/warehouse/discover', { validate: true });
      expect(discovered.status, discovered.text).toBe(200);
      expect((await call('/api/modeling/warehouse/discover/proposal', { validate: true })).status).toBe(201);

      const tables = await call('/api/app-datasets/tables');
      expect(tables.status, tables.text).toBe(200);
      const customersTable = tables.body.tables.find((table: Json) => table.name === 'customers');
      const ordersTable = tables.body.tables.find((table: Json) => table.name === 'orders');
      // Nothing made from them yet: "Not checked yet · Check and add".
      expect(customersTable.datasets).toBeUndefined();

      const customers = await call('/api/app-datasets/tables/create', { tableId: customersTable.id, name: 'Customers', domain: 'shop' });
      expect(customers.status, customers.text).toBe(201);
      const orders = await call('/api/app-datasets/tables/create', { tableId: ordersTable.id, name: 'Orders', domain: 'shop' });
      expect(orders.status, orders.text).toBe(201);

      // Problem 7: each table now names the Dataset made from it, so Add data says "Added · Checked".
      const after = await call('/api/app-datasets/tables');
      expect(after.body.tables.find((table: Json) => table.name === 'customers').datasets).toEqual([{ sourceId: customers.body.sourceId, name: 'Customers', state: 'checked' }]);
      expect(after.body.tables.find((table: Json) => table.name === 'orders').datasets).toEqual([{ sourceId: orders.body.sourceId, name: 'Orders', state: 'checked' }]);

      const run = async (sourceId: string, query: Json) => {
        const result = await call('/api/app-datasets/run', { sourceId, query });
        expect(result.status, result.text).toBe(200);
        expect(result.body.ok, result.text).toBe(true);
        return result.body;
      };

      // Problem 4: Top customers on the Customers table keeps both Marias.
      const top = await run(customers.body.sourceId, { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }], orderBy: [{ alias: 'lifetime_spend', direction: 'desc' }], limit: 10 });
      expect(top.result.rows.map((row: Json) => [row.customer_name, Number(row.lifetime_spend)])).toEqual([
        ['Maria Lopez (#C1)', 300],
        ['Maria Lopez (#C2)', 200],
        ['Bob', 50],
      ]);
      expect(top.nameWarnings).toBeUndefined();

      // Through Orders' Customer join: still two Marias, every total unchanged.
      const byCustomer = await run(orders.body.sourceId, { dimensions: [{ field: 'customer__customer_name' }], measures: [{ measure: 'order_total' }] });
      expect(Object.fromEntries(byCustomer.result.rows.map((row: Json) => [row.customer__customer_name, Number(row.order_total)]))).toEqual({ 'Maria Lopez (#C1)': 150, 'Maria Lopez (#C2)': 25, Bob: 10 });

      // A bar told apart by its key filters to that one customer; a plain name filters every Maria.
      const onlyC2 = await run(orders.body.sourceId, { dimensions: [], measures: [{ measure: 'order_total' }], filters: [{ field: 'customer__customer_name', op: 'in', values: ['Maria Lopez (#C2)'] }] });
      expect(Number(onlyC2.result.rows[0].order_total)).toBe(25);
      const everyMaria = await run(orders.body.sourceId, { dimensions: [], measures: [{ measure: 'order_total' }], filters: [{ field: 'customer__customer_name', op: 'in', values: ['Maria Lopez'] }] });
      expect(Number(everyMaria.result.rows[0].order_total)).toBe(175);

      // The filter's value list reads plain names, never "Maria Lopez (#C1)".
      const values = await call('/api/app-datasets/field-values', { sourceId: customers.body.sourceId, field: 'customer_name' });
      expect(values.status, values.text).toBe(200);
      expect(values.body.values.map((value: Json) => value.value ?? value).sort()).toEqual(['Bob', 'Maria Lopez']);

      // A name with no key ZLens knows: the tile says it may repeat.
      const byStore = await run(orders.body.sourceId, { dimensions: [{ field: 'store_name' }], measures: [{ measure: 'order_total' }] });
      expect(byStore.result.rows).toHaveLength(2);
      expect(byStore.nameWarnings).toEqual([expect.objectContaining({ field: 'store_name', entity: 'store', message: expect.stringContaining('Store Name may not be unique') })]);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
