import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';

/**
 * A preview receipt for a Dataset tile is verified against the connection the
 * server runs by default. A host starts the runtime on a connection of its own:
 * ZLens Enterprise's draft space copies Production's DuckDB file and starts
 * DQL on the copy, with `dql.config.json` still naming Production's file. The
 * page run uses the active connection (the copy); verifying its receipt used
 * to resolve the default connection *by name* from `dql.config.json` (the
 * original file), observe a different warehouse identity and refuse the
 * receipt as "previewed against a different warehouse target", every time.
 * The same happens to a plain `zlens notebook` started with a connection that
 * replaces the config's default. Needs a DuckDB connector root
 * (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');

const cole: DqlPrincipal = { id: 'u-cole', kind: 'person', email: 'cole@insurer.example', source: 'host' };

async function call(base: string, path: string, body?: unknown, method?: string): Promise<{ status: number; body: any; text: string }> {
  const headers = { 'Content-Type': 'application/json', 'x-test-person': 'cole' };
  const response = await fetch(`${base}${path}`, body === undefined ? { headers } : { method: method ?? 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

const savedQuery = [
  '// dql-format: 1',
  '',
  'block "Monthly revenue" {',
  '  domain = "commerce"',
  '  type = "custom"',
  '  status = "certified"',
  '  owner = "commerce@example.test"',
  '  description = "Revenue by month, a saved query."',
  '  tags = ["revenue"]',
  '  query = """',
  "SELECT date_trunc('month', order_date) AS month, SUM(net_amount) AS gross_revenue, COUNT(*) AS line_count",
  'FROM order_lines',
  "GROUP BY date_trunc('month', order_date)",
  '"""',
  '}',
  '',
].join('\n');

/**
 * The project of the Dataset pilot with its warehouse seeded at the file
 * `dql.config.json` names, and a copy of that file under `.dql/preview-data`
 * as a host's draft space makes it (the copy keeps the file's name, so the
 * DuckDB catalog is named the same).
 */
function project(): { projectRoot: string; copy: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-receipt-target-'));
  cpSync(fixtureRoot, projectRoot, { recursive: true });
  const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
  mkdirSync(projectConnectorRoot, { recursive: true });
  symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
  const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
  execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
  writeFileSync(join(projectRoot, 'domains', 'commerce', 'blocks', 'monthly-revenue.dql'), savedQuery);
  const copy = join(projectRoot, '.dql', 'preview-data', String(Date.now()), basename(databasePath));
  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(databasePath, copy);
  return { projectRoot, copy };
}

/** Fields of the saved query, one tile over them, the page run in full, its receipt saved, the draft preflighted. */
async function buildAndSaveReceipt(base: string): Promise<void> {
  const created = await call(base, '/api/app-builds', { name: 'Receipt target', goal: 'Revenue by month', domain: 'commerce', authoringMode: 'manual', template: 'blank' });
  expect(created.status, created.text).toBe(201);
  let draft = created.body.draft;
  const catalogue = (await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?limit=50`)).body.items as any[];
  const monthly = catalogue.find((candidate) => candidate.name === 'Monthly revenue');
  expect(monthly, JSON.stringify(catalogue.map((candidate) => candidate.name))).toBeDefined();
  const fields = await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: monthly.sourceId });
  expect(fields.status, fields.text).toBe(200);
  const composed = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, {
    mode: 'manual',
    expectedRevision: draft.revision,
    expectedProposalHash: draft.proposalHash,
    selections: [{ sourceId: monthly.sourceId, pageId: 'overview', view: 'table', title: 'Revenue by month', query: { dimensions: [{ field: 'month', timeGrain: 'month' }], measures: [{ measure: 'gross_revenue' }], respectsGlobalFilters: true } }],
  });
  expect(composed.status, composed.text).toBe(200);
  draft = composed.body.draft;
  expect(draft.pages[0].layout.items.every((item: any) => item.query)).toBe(true);

  // As App Studio runs a page: no execution target in the request, so the run uses the connection the server was started on.
  const run = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, { variables: {}, fullRun: true });
  expect(run.status, run.text).toBe(200);
  expect(run.body.tiles.map((tile: any) => tile.status)).toEqual(['ok']);
  const receipt = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, {
    expectedRevision: draft.revision,
    expectedProposalHash: draft.proposalHash,
    operations: [{ type: 'set_preview_receipt', receipt: { id: run.body.runId, pageId: 'overview', revision: draft.revision, snapshotId: run.body.snapshotId, filterFingerprint: run.body.filterFingerprint, resultFingerprint: run.body.resultFingerprint, createdAt: new Date().toISOString() } }],
  }, 'PATCH');
  expect(receipt.status, receipt.text).toBe(200);
  draft = receipt.body.draft;
  const preflight = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/preflight`, { expectedRevision: draft.revision, proposalHash: draft.proposalHash });
  expect(preflight.status, preflight.text).toBe(200);
}

describe('a preview receipt when the server runs on a connection that replaces the default', () => {
  for (const [who, hooks] of [
    ['a host that started the runtime on a copy of the default DuckDB file (a draft space)', (): DqlHostHooks => ({ resolvePrincipal: (req) => (req.headers['x-test-person'] === 'cole' ? cole : null), onePerson: true })],
    ['a single person who started the notebook with a connection that replaces the default', undefined],
  ] as const) {
    duckDbIt(`is saved and preflights for ${who}`, async () => {
      const { projectRoot, copy } = project();
      const connection: ConnectionConfig = { driver: 'duckdb', filepath: copy, moduleSearchPaths: [connectorRoot!] };
      const executor = new QueryExecutor();
      let server: Server | undefined;
      try {
        const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, ...(hooks ? { hostHooks: hooks() } : {}), captureServer: (created) => { server = created; } });
        await buildAndSaveReceipt(`http://127.0.0.1:${port}`);
      } finally {
        await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
        await executor.disconnect();
        rmSync(projectRoot, { recursive: true, force: true });
      }
    }, 180_000);
  }
});
