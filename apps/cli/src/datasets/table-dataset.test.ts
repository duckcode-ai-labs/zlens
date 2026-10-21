import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import { applyTableDatasetChoices } from './table-dataset.js';
import { readEnv } from '@zlens/core';

/**
 * Start from a table (RFC 0009, "15-minute first page"), end to end on real
 * DuckDB: list the tables, draft one checked against its rows, save it, and
 * find it in App Studio's sources as a certified Dataset. Needs a DuckDB
 * connector root (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');

async function call(base: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

describe('start from a table', () => {
  it('uses only the author\'s choice of numbers and formats from a request', () => {
    const proposal = {
      name: 'Orders', relation: 'orders', keyCandidates: [], fields: [],
      measures: [{ name: 'amount', label: 'Amount', aggregation: 'sum' as const, from: 'amount', format: 'currency' as const, currency: 'USD', include: true, reason: '' }],
    };
    const next = applyTableDatasetChoices(proposal, [{ name: 'amount', include: false, format: 'number', from: 'secret_column', aggregation: 'max' }, { name: 'injected', include: true }]);
    expect(next.measures).toEqual([{ ...proposal.measures[0], include: false, format: 'number' }]);
  });

  duckDbIt('lists tables, drafts a checked Dataset, saves it certified, and App Studio lists it', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-table-dataset-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;

      const tables = await call(base, '/api/app-datasets/tables');
      expect(tables.status, tables.text).toBe(200);
      expect(tables.body.source).toBe('live');
      const orderLines = tables.body.tables.find((table: { name: string }) => table.name === 'order_lines');
      expect(orderLines).toMatchObject({ relation: '"main"."order_lines"', columnCount: 8 });

      const draft = await call(base, '/api/app-datasets/tables/draft', { tableId: orderLines.id });
      expect(draft.status, draft.text).toBe(200);
      expect(draft.body.proposal.key).toEqual({ column: 'order_line_id', entity: 'order_line' });
      expect(draft.body.rows).toBeGreaterThan(0);

      const created = await call(base, '/api/app-datasets/tables/create', {
        tableId: orderLines.id,
        name: 'Order lines from table',
        domain: 'commerce',
        measures: [{ name: 'cost_amount', include: false, format: 'currency' }],
      });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ ok: true, status: 'certified', keyChecked: true });
      expect(created.body.sourceId).toEqual(expect.any(String));
      // D5: who certified it and when, and the checks that passed, in plain words.
      expect(created.body.certification).toMatchObject({ by: expect.any(String), at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
      expect(created.body.certification.checks).toEqual(expect.arrayContaining([
        expect.stringMatching(/^Row key: each row is one order line \(order_line_id is filled and different on all [\d,]+ rows\)$/),
        expect.stringMatching(/^Number formats: .*Net amount: money/),
        'run',
      ]));
      const source = readFileSync(join(projectRoot, created.body.path), 'utf-8');
      expect(source).toContain('status = "certified"');
      expect(source).toContain('keys = ["order_line_id"]');
      expect(source).not.toMatch(/cost_amount \{ agg/);

      const app = await call(base, '/api/app-builds', { name: 'First page', goal: 'Revenue by region', domain: 'commerce', authoringMode: 'manual', sourcePolicy: 'governed_only', template: 'blank' });
      expect(app.status, app.text).toBe(201);
      const candidates = await call(base, `/api/app-builds/${encodeURIComponent(app.body.draft.id)}/source-candidates?limit=50`);
      const listed = candidates.body.items.find((item: { sourceId: string }) => item.sourceId === created.body.sourceId);
      expect(listed).toMatchObject({ lifecycle: 'certified', trust: 'certified' });
      // The Data list names who certified it and when (D5).
      expect(listed.certification).toMatchObject({ by: created.body.certification.by, at: created.body.certification.at });
      expect(listed.capabilities.dataset.fields.filter((field: { kind: string }) => field.kind === 'measure').map((field: { name: string }) => field.name).sort())
        .toEqual(['customer_count', 'margin_amount', 'net_amount', 'order_count', 'order_line_count']);

      const again = await call(base, '/api/app-datasets/tables/create', { tableId: orderLines.id, name: 'Order lines from table', domain: 'commerce' });
      expect(again.status).toBe(409);
      expect(again.body.error).toContain('already exists');
      expect(existsSync(join(projectRoot, created.body.path))).toBe(true);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);

  duckDbIt('reads cents columns as dollars everywhere, and the keyword planner builds tiles from a just-checked table (B11, B13)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-table-dataset-cents-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      await executor.executePositional([
        'CREATE TABLE main.shop_orders AS SELECT * FROM (VALUES',
        "  ('O-1', TIMESTAMP '2026-01-05 10:00:00', 1999, 160, 2159),",
        "  ('O-2', TIMESTAMP '2026-01-20 11:00:00', 500, 40, 540),",
        "  ('O-3', TIMESTAMP '2026-02-02 12:00:00', 12000, 960, 12960)",
        ') AS t(order_id, ordered_at, subtotal_cents, tax_paid_cents, order_total_cents)',
      ].join('\n'), [], connection);
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const tables = await call(base, '/api/app-datasets/tables');
      expect(tables.status, tables.text).toBe(200);

      // B11: the check shows cents columns as Money in dollars, and says so.
      const shopOrders = tables.body.tables.find((table: { name: string }) => table.name === 'shop_orders');
      const draft = await call(base, '/api/app-datasets/tables/draft', { tableId: shopOrders.id });
      expect(draft.status, draft.text).toBe(200);
      const subtotal = draft.body.proposal.measures.find((measure: { from: string }) => measure.from === 'subtotal');
      expect(subtotal).toMatchObject({ format: 'currency', currency: 'USD', unitNote: 'Shown in dollars (stored as cents)' });
      const created = await call(base, '/api/app-datasets/tables/create', { tableId: shopOrders.id, name: 'Shop orders', domain: 'commerce' });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ ok: true, status: 'certified', keyChecked: true });
      // The receipt says the cents were shown in dollars (D5, B11).
      expect(created.body.certification.checks.find((check: string) => check.startsWith('Number formats:'))).toContain('Subtotal: shown in dollars (stored as cents)');
      const source = readFileSync(join(projectRoot, created.body.path), 'utf-8');
      expect(source).toContain('"subtotal_cents" / 100.0 AS "subtotal"');
      // A tile, a KPI and a filter all read the same dollars.
      const total = await call(base, '/api/app-datasets/run', { sourceId: created.body.sourceId, query: { dimensions: [], measures: [{ measure: 'subtotal' }, { measure: 'order_total' }] } });
      expect(total.status, total.text).toBe(200);
      expect(Number(total.body.result.rows[0].subtotal)).toBeCloseTo(144.99, 6);
      expect(Number(total.body.result.rows[0].order_total)).toBeCloseTo(156.59, 6);
      expect(total.body.result.columnsMeta.find((meta: { name: string }) => meta.name === 'subtotal')).toMatchObject({ kind: 'currency', unit: 'USD' });
      const filtered = await call(base, '/api/app-datasets/run', { sourceId: created.body.sourceId, query: { dimensions: [{ field: 'order_id' }], measures: [{ measure: 'subtotal' }], filters: [{ field: 'subtotal', op: 'gt', values: [100] }] } });
      expect(filtered.status, filtered.text).toBe(200);
      expect(filtered.body.result.rows.map((row: { order_id: string }) => row.order_id)).toEqual(['O-3']);

      // B13: the keyword planner (no AI) proposes tiles from a table checked a moment ago.
      const orderLines = tables.body.tables.find((table: { name: string }) => table.name === 'order_lines');
      const checked = await call(base, '/api/app-datasets/tables/create', { tableId: orderLines.id, name: 'Order lines from table', domain: 'commerce' });
      expect(checked.status, checked.text).toBe(201);
      expect(readFileSync(join(projectRoot, checked.body.path), 'utf-8')).toMatch(/net_amount \{ agg = "sum".*status = "approved"/);
      const app = await call(base, '/api/app-builds', { goal: 'Net amount review', domain: 'commerce', authoringMode: 'ai', sourcePolicy: 'governed_only', template: 'operational_dashboard' });
      expect(app.status, app.text).toBe(201);
      const prompt = 'Monthly net amount, top 10 regions by net amount, and total net amount as a KPI';
      for (const selectedBlockIds of [undefined, [checked.body.sourceId]]) {
        const proposed = await call(base, `/api/app-builds/${encodeURIComponent(app.body.draft.id)}/ai-proposals`, {
          prompt,
          expectedRevision: app.body.draft.revision,
          proposalHash: app.body.draft.proposalHash,
          ...(selectedBlockIds ? { selectedBlockIds } : {}),
        });
        expect(proposed.status, proposed.text).toBe(201);
        expect(proposed.body.proposal.plannerProvenance.mode).toBe('deterministic');
        const warnings = proposed.body.proposal.warnings as string[];
        expect(warnings.filter((warning) => warning.includes('Order lines from table')), warnings.join(' | ')).toEqual([]);
        const tiles = (proposed.body.proposal.operations as Array<{ type: string; page?: { layout: { items: Array<{ title?: string; query?: { dimensions: Array<{ field: string }>; measures: Array<{ measure: string }> }; block?: { blockId?: string }; source?: Record<string, unknown> }> } } }>)
          .filter((operation) => operation.type === 'upsert_page')
          .flatMap((operation) => operation.page?.layout.items ?? []);
        expect(tiles.some((tile) => tile.query?.measures[0]?.measure === 'net_amount' && tile.query.dimensions[0]?.field === 'region'), JSON.stringify(tiles.map((tile) => [tile.title, tile.query]))).toBe(true);
      }
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
