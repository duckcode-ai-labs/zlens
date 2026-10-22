import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import { applyTableDatasetChoices, draftTableDataset, tableModelStates } from './table-dataset.js';
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

  it('marks tables the model binds as Modeled and tables setup drafted as Drafted, with their checked key (D7)', () => {
    const tables = [
      { id: 'warehouse.dev.customers', relation: '"dev"."customers"' },
      { id: 'warehouse.dev.orders', relation: '"dev"."orders"' },
      { id: 'warehouse.dev.payments', relation: '"dev"."payments"' },
    ];
    const states = tableModelStates({
      tables,
      entities: [{ dbtUniqueId: 'warehouse.dev.customers', localId: 'customers', domain: 'dev', businessName: 'Customers', grain: 'customer_id', keys: ['customer_id'] }],
      proposals: [
        { id: 'ctxprop_old', status: 'committed', origin: 'warehouse_discovery', operations: [{ kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'payments', domain: 'dev', dbtModel: 'warehouse.dev.payments', grain: 'payment_id' } } }] },
        { id: 'ctxprop_new', status: 'proposed', origin: 'warehouse_discovery', operations: [
          { kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'orders', domain: 'dev', dbtModel: 'warehouse.dev.orders', businessName: 'Orders', grain: 'order_id', keys: ['order_id'] } } },
          { kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'customers', domain: 'dev', dbtModel: 'warehouse.dev.customers', grain: 'customer_id' } } },
          { kind: 'modeling_change', change: { operation: 'upsert_relationship', value: { id: 'orders_customers', domain: 'dev', from: 'orders', to: 'customers' } } },
        ] },
      ],
    });
    expect(states.get('warehouse.dev.customers')).toEqual({ state: 'modeled', entity: 'Customers', domain: 'dev', key: 'customer_id' });
    expect(states.get('warehouse.dev.orders')).toEqual({ state: 'drafted', entity: 'Orders', domain: 'dev', key: 'order_id', proposalId: 'ctxprop_new' });
    // A proposal already committed (or turned down) is not a draft waiting for review.
    expect(states.has('warehouse.dev.payments')).toBe(false);
  });

  it('checks a modeled row key on its own first, so Check and add is one quick count (D7)', async () => {
    const statements: string[] = [];
    const run = async (sql: string) => {
      statements.push(sql);
      return [{ dql_rows: 3, dql_distinct_0: 3, dql_filled_0: 3 }];
    };
    const table = { id: 'warehouse.dev.orders', name: 'orders', schema: 'dev', relation: '"dev"."orders"', kind: 'table', columns: [{ name: 'order_id', type: 'VARCHAR' }, { name: 'customer_id', type: 'VARCHAR' }, { name: 'store_id', type: 'VARCHAR' }, { name: 'order_total', type: 'DOUBLE' }] };
    const drafted = await draftTableDataset({ table, driver: 'duckdb', run, modeledKey: 'order_id' });
    expect(drafted.proposal.key).toEqual({ column: 'order_id', entity: 'order' });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('COUNT(DISTINCT "order_id")');
    expect(statements[0]).not.toContain('customer_id');
    // The same numbers as without the modeled key: only the check is shorter.
    const plain = await draftTableDataset({ table, driver: 'duckdb', run: async () => [{ dql_rows: 3, dql_distinct_0: 3, dql_filled_0: 3, dql_distinct_1: 2, dql_filled_1: 3, dql_distinct_2: 1, dql_filled_2: 3 }] });
    expect(drafted.proposal.measures.map((measure) => measure.name)).toEqual(plain.proposal.measures.map((measure) => measure.name));
  });

  it('applies the duplicate-column answer before the number choices (design Q1.4)', () => {
    const proposal = {
      name: 'Orders', relation: 'orders', keyCandidates: [],
      fields: [
        { name: 'order_total', label: 'Order total', role: 'attribute' as const, type: 'number' as const },
        { name: 'order_total_dollars', label: 'Order total dollars', role: 'attribute' as const, type: 'number' as const, column: 'order_total_cents', divideBy: 100 as const },
      ],
      measures: [
        { name: 'order_total', label: 'Order total', aggregation: 'sum' as const, from: 'order_total', format: 'currency' as const, currency: 'USD', include: true, reason: '' },
        { name: 'order_total_dollars', label: 'Order total dollars', aggregation: 'sum' as const, from: 'order_total_dollars', format: 'currency' as const, currency: 'USD', include: true, reason: '' },
      ],
      duplicates: [{ name: 'order_total', label: 'Order total', plainColumn: 'order_total', minorColumn: 'order_total_cents', minorUnits: 'cents' as const, major: 'dollars' as const, convertedField: 'order_total_dollars', question: 'Use Order total in dollars?' }],
    };
    const recommended = applyTableDatasetChoices(proposal, [{ name: 'order_total', format: 'number' }]);
    expect(recommended.fields.map((field) => [field.name, field.column])).toEqual([['order_total', 'order_total_cents']]);
    expect(recommended.measures).toEqual([expect.objectContaining({ name: 'order_total', from: 'order_total', format: 'number' })]);
    expect(recommended.hiddenColumns).toEqual([expect.objectContaining({ column: 'order_total', keptColumn: 'order_total_cents' })]);
    const plain = applyTableDatasetChoices(proposal, [], [{ name: 'order_total', use: 'plain' }]);
    expect(plain.fields.map((field) => field.name)).toEqual(['order_total']);
    expect(plain.fields[0]!.column).toBeUndefined();
    expect(plain.hiddenColumns).toEqual([expect.objectContaining({ column: 'order_total_cents', keptColumn: 'order_total' })]);
  });

  duckDbIt('lists tables, drafts a checked Dataset, saves it Checked · Needs certifying, certifies it on purpose, and App Studio lists it', async () => {
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
      // Design Q1: checking a table no longer certifies it.
      expect(created.body).toMatchObject({ ok: true, status: 'checked', keyChecked: true });
      expect(created.body.certification).toBeUndefined();
      expect(created.body.sourceId).toEqual(expect.any(String));
      // Who checked it and what the check found, in plain words; the person here is "you".
      expect(created.body.check).toMatchObject({ by: expect.any(String), at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), byYou: true });
      expect(created.body.check.checks).toEqual(expect.arrayContaining([
        expect.stringMatching(/^Row key: each row is one order line \(order_line_id is filled and different on all [\d,]+ rows\)$/),
        expect.stringMatching(/^Number formats: .*Net amount: money/),
        'run',
      ]));
      const source = readFileSync(join(projectRoot, created.body.path), 'utf-8');
      expect(source).toContain('status = "review"');
      expect(source).not.toContain('status = "certified"');
      expect(source).toContain('keys = ["order_line_id"]');
      expect(source).not.toMatch(/cost_amount \{ agg/);

      const app = await call(base, '/api/app-builds', { name: 'First page', goal: 'Revenue by region', domain: 'commerce', authoringMode: 'manual', sourcePolicy: 'governed_only', template: 'blank' });
      expect(app.status, app.text).toBe(201);
      const listedChecked = (await call(base, `/api/app-builds/${encodeURIComponent(app.body.draft.id)}/source-candidates?limit=50`)).body.items
        .find((item: { sourceId: string }) => item.sourceId === created.body.sourceId);
      // Checked · Needs certifying: tiles can use it under "Only certified data"; it cannot publish yet.
      expect(listedChecked).toMatchObject({ lifecycle: 'review', trust: 'review_required', check: { byYou: true }, eligibility: { localPreview: true, projectPublish: false, reasonCodes: expect.arrayContaining(['CHECKED_NEEDS_CERTIFYING']) } });

      // The short review before certifying: what one row is, the key check run again, formats, hidden duplicates.
      const review = await call(base, `/api/app-datasets/certify-review?sourceId=${encodeURIComponent(created.body.sourceId)}`);
      expect(review.status, review.text).toBe(200);
      expect(review.body.review).toMatchObject({ kind: 'dataset', origin: 'table', certified: false, canVouch: true, row: 'Each row is one order line (order_line_id).', keyCheck: { ok: true } });
      expect(review.body.review.numbers.map((number: { label: string; format: string }) => `${number.label}: ${number.format}`)).toEqual(expect.arrayContaining(['Net amount: Money (USD)']));

      // "I vouch for this — certify": the receipt records who, when and which checks passed.
      const stale = await call(base, '/api/app-datasets/certify', { sourceId: created.body.sourceId, sourceRevision: 'sha256:old' });
      expect(stale.status).toBe(409);
      const certified = await call(base, '/api/app-datasets/certify', { sourceId: created.body.sourceId, sourceRevision: review.body.review.sourceRevision });
      expect(certified.status, certified.text).toBe(200);
      expect(certified.body).toMatchObject({ ok: true, status: 'certified', certification: { by: created.body.check.by, byYou: true, at: expect.stringMatching(/^\d{4}-/) } });
      expect(certified.body.certification.checks).toEqual(expect.arrayContaining([
        expect.stringMatching(/^Row key: order_line_id is filled and different on every row, checked just now\.$/),
        expect.stringMatching(/^Number formats: .*Net amount: money/),
        'run',
      ]));
      expect(readFileSync(join(projectRoot, created.body.path), 'utf-8')).toContain('status = "certified"');
      const companion = readFileSync(join(projectRoot, 'semantic-layer', 'blocks', 'commerce', 'order-lines-from-table.yaml'), 'utf-8');
      expect(companion).toContain('reviewStatus: certified');
      expect(companion).toContain('via: app-dataset');
      expect(companion).not.toMatch(/^check:/m);
      const again1 = await call(base, '/api/app-datasets/certify', { sourceId: created.body.sourceId });
      expect(again1.status).toBe(409);

      const candidates = await call(base, `/api/app-builds/${encodeURIComponent(app.body.draft.id)}/source-candidates?limit=50`);
      const listed = candidates.body.items.find((item: { sourceId: string }) => item.sourceId === created.body.sourceId);
      expect(listed).toMatchObject({ lifecycle: 'certified', trust: 'certified' });
      expect(listed.check).toBeUndefined();
      // The Data list names who certified it and when, and that it was you (D5, design Q1).
      expect(listed.certification).toMatchObject({ by: certified.body.certification.by, at: certified.body.certification.at, byYou: true });
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
      await executor.executePositional([
        'CREATE TABLE main.dup_orders AS SELECT * FROM (VALUES',
        "  ('D-1', 21.59, 2159),",
        "  ('D-2', 5.40, 540)",
        ') AS t(order_id, order_total, order_total_cents)',
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
      expect(created.body).toMatchObject({ ok: true, status: 'checked', keyChecked: true });
      // The check record says the cents were shown in dollars (D5, B11).
      expect(created.body.check.checks.find((check: string) => check.startsWith('Number formats:'))).toContain('Subtotal: shown in dollars (stored as cents)');
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

      // Design Q1.4: order_total beside order_total_cents is one question, not two numbers.
      const dupOrders = tables.body.tables.find((table: { name: string }) => table.name === 'dup_orders');
      const dupDraft = await call(base, '/api/app-datasets/tables/draft', { tableId: dupOrders.id });
      expect(dupDraft.status, dupDraft.text).toBe(200);
      // Checked on the rows (new-user round 2, problem 7): 21.59 and 2159 are one amount in two units, never "the same number".
      expect(dupDraft.body.proposal.duplicates).toEqual([expect.objectContaining({ relation: 'hundredths', question: 'Order total is stored twice: Order total (dollars) and Order total cents. Use Order total in dollars?', plainColumn: 'order_total', minorColumn: 'order_total_cents' })]);
      const dupCreated = await call(base, '/api/app-datasets/tables/create', { tableId: dupOrders.id, name: 'Dup orders', domain: 'commerce' });
      expect(dupCreated.status, dupCreated.text).toBe(201);
      const dupSource = readFileSync(join(projectRoot, dupCreated.body.path), 'utf-8');
      // No answer means OK (new-user round 3, problem 8): the rows showed order_total is the dollars, so it is used as it is.
      expect(dupSource).not.toContain('"order_total_cents" / 100.0');
      expect(dupSource).toContain('/* Hidden duplicate columns: order_total_cents (order_total is used) */');
      expect(dupSource).toContain('order_total_cents is hidden (order_total holds the same amount)');
      const dupTotal = await call(base, '/api/app-datasets/run', { sourceId: dupCreated.body.sourceId, query: { dimensions: [], measures: [{ measure: 'order_total' }] } });
      expect(dupTotal.status, dupTotal.text).toBe(200);
      expect(Number(dupTotal.body.result.rows[0].order_total)).toBeCloseTo(26.99, 6);
      const dupReview = await call(base, `/api/app-datasets/certify-review?sourceId=${encodeURIComponent(dupCreated.body.sourceId)}`);
      expect(dupReview.body.review.hiddenColumns).toEqual([expect.objectContaining({ column: 'order_total_cents', keptColumn: 'order_total' })]);

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
