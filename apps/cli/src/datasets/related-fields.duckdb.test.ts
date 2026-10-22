import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { startLocalServer, validateProjectRelationships } from '../local-runtime.js';

/**
 * Fields from related tables (design D2) on real DuckDB, through the local
 * runtime: a database-only project, Settings → Sync schema, setup's "Draft
 * my models" (orders → locations stays a draft), one join kept in the model
 * and certified (orders → customers), then an Orders Dataset from its table.
 * Its fields include Customer Name and Location Name; tiles on them read
 * names, not ids, and every total is the same with and without a joined
 * field. A related table that repeats a key is refused before it can double
 * count. Needs a DuckDB connector root (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;

type Json = any;

const LOCATIONS = {
  philadelphia: '4b6c2304-2b9e-41a3-8f1e-6c9a1d2f0001',
  brooklyn: '9a1e77d0-5c3b-4e2a-b7d4-0e5f6a7b0002',
};

describe('fields from related tables on DuckDB (D2)', () => {
  duckDbIt('shows related fields, joins them without changing any total, keeps trust honest, and refuses a repeated key', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-related-fields-'));
    const databasePath = join(projectRoot, 'shop.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    const start = async () => {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      return `http://127.0.0.1:${port}`;
    };
    const stop = () => new Promise<void>((done) => (server ? server.close(() => done()) : done()));
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
        'CREATE TABLE main.customers (customer_id VARCHAR, customer_name VARCHAR)',
        "INSERT INTO main.customers VALUES ('C1', 'Ann'), ('C2', 'Bob'), ('C3', 'Cy')",
        'CREATE TABLE main.locations (location_id VARCHAR, location_name VARCHAR)',
        `INSERT INTO main.locations VALUES ('${LOCATIONS.philadelphia}', 'Philadelphia'), ('${LOCATIONS.brooklyn}', 'Brooklyn')`,
        'CREATE TABLE main.orders (order_id VARCHAR, customer_id VARCHAR, location_id VARCHAR, ordered_at TIMESTAMP, order_total DOUBLE)',
        [
          'INSERT INTO main.orders VALUES',
          `('O1', 'C1', '${LOCATIONS.philadelphia}', TIMESTAMP '2026-01-05 10:00:00', 100),`,
          `('O2', 'C1', '${LOCATIONS.brooklyn}', TIMESTAMP '2026-01-20 10:00:00', 50),`,
          `('O3', 'C2', '${LOCATIONS.philadelphia}', TIMESTAMP '2026-02-02 10:00:00', 25),`,
          `('O4', 'C3', '${LOCATIONS.philadelphia}', TIMESTAMP '2026-02-10 10:00:00', 10),`,
          // An order with no customer: the LEFT JOIN keeps it.
          `('O5', NULL, '${LOCATIONS.brooklyn}', TIMESTAMP '2026-02-11 10:00:00', 5)`,
        ].join(' '),
      ]) await executor.executePositional(statement, [], connection);
      base = await start();

      // Settings → Sync schema, then setup's Draft my models.
      const synced = await call('/api/connections/default/metadata-sync', {});
      expect(synced.status, synced.text).toBe(200);
      const discovered = await call('/api/modeling/warehouse/discover', { validate: true });
      expect(discovered.status, discovered.text).toBe(200);
      const relationships = discovered.body.report.relationships as Array<{ id: string; fromRelation: string; toRelation: string; cardinality: string }>;
      const toCustomers = relationships.find((item) => item.fromRelation.endsWith('orders') && item.toRelation.endsWith('customers'));
      const toLocations = relationships.find((item) => item.fromRelation.endsWith('orders') && item.toRelation.endsWith('locations'));
      expect(toCustomers, JSON.stringify(relationships)).toMatchObject({ cardinality: 'many_to_one' });
      expect(toLocations, JSON.stringify(relationships)).toMatchObject({ cardinality: 'many_to_one' });
      // Keep orders → customers in the model and certify it; orders → locations stays a setup draft.
      const applied = await call('/api/modeling/warehouse/discover/apply', { validate: true, expectedSnapshotId: discovered.body.snapshotId, relationshipIds: [toCustomers!.id], entityIds: [] });
      expect(applied.status, applied.text).toBe(200);
      const certified = await validateProjectRelationships(projectRoot, { ids: [toCustomers!.id], write: true, certify: true, executor });
      expect(certified.results[0], JSON.stringify(certified.results)).toMatchObject({ certified: true });
      const drafted = await call('/api/modeling/warehouse/discover/proposal', { validate: true });
      expect(drafted.status, drafted.text).toBe(201);
      expect(drafted.body.proposal.operations.some((operation: Json) => operation.change?.operation === 'upsert_relationship' && operation.change.value.id === toLocations!.id)).toBe(true);

      // Add data lists the tables Orders reaches.
      const tables = await call('/api/app-datasets/tables');
      expect(tables.status, tables.text).toBe(200);
      const ordersTable = tables.body.tables.find((table: Json) => table.name === 'orders');
      expect(ordersTable.joins).toEqual(['customers', 'locations']);

      const created = await call('/api/app-datasets/tables/create', { tableId: ordersTable.id, name: 'Orders', domain: 'shop' });
      expect(created.status, created.text).toBe(201);
      // Checking a table leaves it Checked · Needs certifying; certifying is its own step (design Q1).
      expect(created.body.status).toBe('checked');
      expect((await call('/api/app-datasets/certify', { sourceId: created.body.sourceId })).body.status).toBe('certified');
      const customersTable = tables.body.tables.find((table: Json) => table.name === 'customers');
      const customersCreated = await call('/api/app-datasets/tables/create', { tableId: customersTable.id, name: 'Customers', domain: 'shop' });
      expect(customersCreated.status, customersCreated.text).toBe(201);
      expect((await call('/api/app-datasets/certify', { sourceId: customersCreated.body.sourceId })).body.status).toBe('certified');

      // The Data pane: Orders shows its related tables' fields; Customers says why it does not show orders.
      const app = await call('/api/app-builds', { name: 'Sales', goal: 'Sales by store', domain: 'shop', authoringMode: 'manual', sourcePolicy: 'governed_only', template: 'blank' });
      const candidates = await call(`/api/app-builds/${encodeURIComponent(app.body.draft.id)}/source-candidates?limit=50`);
      const orders = candidates.body.items.find((item: Json) => item.sourceId === created.body.sourceId);
      const descriptor = orders.capabilities.dataset;
      expect(descriptor.joins.map((join: Json) => [join.id, join.table, join.trust])).toEqual([
        ['customer', 'customers', 'certified'],
        ['location', 'locations', 'review_required'],
      ]);
      expect(descriptor.fields.filter((field: Json) => field.related).map((field: Json) => field.name)).toEqual(['customer__customer_name', 'location__location_name']);
      const customers = candidates.body.items.find((item: Json) => item.sourceId === customersCreated.body.sourceId);
      expect(customers.capabilities.dataset.joins).toBeUndefined();
      expect(customers.capabilities.dataset.joinNotes).toEqual(['Orders per customer: add it from Orders. One customer has many orders, so following that join here would count each customer more than once.']);

      const run = async (query: Json) => {
        const result = await call('/api/app-datasets/run', { sourceId: created.body.sourceId, query });
        expect(result.status, result.text).toBe(200);
        expect(result.body.ok, result.text).toBe(true);
        return result.body;
      };
      const sum = (rows: Json[], column: string) => rows.reduce((total, row) => total + Number(row[column] ?? 0), 0);
      const countMeasure = descriptor.fields.find((field: Json) => field.kind === 'measure' && field.aggregation === 'count_distinct' && field.from === 'order_id').name;

      // Totals: identical with and without a joined field.
      const total = await run({ dimensions: [], measures: [{ measure: 'order_total' }, { measure: countMeasure }] });
      expect(Number(total.result.rows[0].order_total)).toBe(190);
      expect(Number(total.result.rows[0][countMeasure])).toBe(5);
      expect(total.trustState).toBe('certified');
      expect(total.joins).toBeUndefined();

      const byLocation = await run({ dimensions: [{ field: 'location__location_name' }], measures: [{ measure: 'order_total' }, { measure: countMeasure }] });
      expect(byLocation.result.rows.map((row: Json) => row.location__location_name).sort()).toEqual(['Brooklyn', 'Philadelphia']);
      expect(JSON.stringify(byLocation.result.rows)).not.toContain(LOCATIONS.philadelphia);
      expect(sum(byLocation.result.rows, 'order_total')).toBe(190);
      expect(sum(byLocation.result.rows, countMeasure)).toBe(5);
      // A drafted join keeps the tile Needs review, and the receipt says how it joined.
      expect(byLocation.trustState).toBe('review_required');
      expect(byLocation.joins).toEqual([expect.objectContaining({
        trust: 'review_required',
        sentence: 'Joined to locations on location_id (each order has one location — checked; the join is not certified yet)',
      })]);

      const byCustomer = await run({ dimensions: [{ field: 'customer__customer_name' }], measures: [{ measure: 'order_total' }, { measure: countMeasure }] });
      expect(Object.fromEntries(byCustomer.result.rows.map((row: Json) => [row.customer__customer_name ?? '(none)', Number(row.order_total)]))).toEqual({ Ann: 150, Bob: 25, Cy: 10, '(none)': 5 });
      expect(sum(byCustomer.result.rows, countMeasure)).toBe(5);
      // A certified join keeps the certified Dataset's trust.
      expect(byCustomer.trustState).toBe('certified');
      expect(byCustomer.joins).toEqual([expect.objectContaining({ trust: 'certified', sentence: 'Joined to customers on customer_id (each order has one customer — checked)' })]);

      // A filter on a related field narrows Orders' own rows.
      const annOnly = await run({ dimensions: [{ field: 'ordered_at', timeGrain: 'month' }], measures: [{ measure: 'order_total' }], filters: [{ field: 'customer__customer_name', op: 'in', values: ['Ann'] }] });
      expect(sum(annOnly.result.rows, 'order_total')).toBe(150);
      expect(annOnly.trustState).toBe('certified');

      // Both joins at once still count each order once.
      const both = await run({ dimensions: [{ field: 'customer__customer_name' }, { field: 'location__location_name' }], measures: [{ measure: 'order_total' }, { measure: countMeasure }] });
      expect(sum(both.result.rows, 'order_total')).toBe(190);
      expect(sum(both.result.rows, countMeasure)).toBe(5);

      // The filter's value list reads the related table's names through the join.
      const values = await call('/api/app-datasets/field-values', { sourceId: created.body.sourceId, field: 'location__location_name' });
      expect(values.status, values.text).toBe(200);
      expect(values.body.values.map((value: Json) => value.value ?? value).sort()).toEqual(['Brooklyn', 'Philadelphia']);

      // A related table that now repeats a key is refused before it can double count.
      await stop();
      await executor.executePositional(`INSERT INTO main.locations VALUES ('${LOCATIONS.brooklyn}', 'Brooklyn (old)')`, [], connection);
      base = await start();
      const refused = await call('/api/app-datasets/run', { sourceId: created.body.sourceId, query: { dimensions: [{ field: 'location__location_name' }], measures: [{ measure: 'order_total' }] } });
      expect(refused.body.ok, refused.text).toBe(false);
      expect(refused.body.error).toContain('JOIN_KEY_NOT_UNIQUE: locations has more than one row for some location_id values');
      // Orders' own fields still run.
      expect((await run({ dimensions: [], measures: [{ measure: 'order_total' }] })).result.rows[0].order_total).toBe(190);
    } finally {
      await stop();
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
