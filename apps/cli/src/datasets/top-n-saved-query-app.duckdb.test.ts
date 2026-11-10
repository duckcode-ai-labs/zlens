import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { appTrustSummary, readEnv, readerTileTrust } from '@zlens/core';
import { startLocalServer } from '../local-runtime.js';

/**
 * V9, end to end on real DuckDB: an App over a certified Top N saved query
 * (the question asked for the top 2, so its SQL ends in `LIMIT 2`).
 *
 * The tester's Lakers App ("top 3 rebounders", grouped by player id and name,
 * a bar by name) published while the editor skipped the tile check, so
 * `dql.app.json` stored "1 of 1". The page's run then said "0 of 1 tile
 * certified": the bar groups by one of the two grouping columns, so the check
 * read it as a total over a Top 3, which it never counted as certified. The
 * Apps card kept reading the stored count: "All tiles certified".
 *
 * Now a certified Top N certifies its rows: every tile over them is
 * certified and says it covers only them, and the Apps list works out the
 * count as it is now, so it says what the page says.
 *
 * Needs a DuckDB connector root (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');

type Json = any;

async function call(base: string, path: string, body?: unknown, method?: string): Promise<{ status: number; body: Json; text: string }> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

/** Block Studio's Certify: start the operation, wait for its result. */
async function certify(base: string, input: { source: string; path: string; metadata: Json; aiReviewed?: boolean }): Promise<Json> {
  const started = await call(base, '/api/block-studio/certifications', input);
  expect(started.status, started.text).toBe(202);
  let operation = started.body.operation;
  for (let attempt = 0; attempt < 600 && ['queued', 'running'].includes(String(operation.status)); attempt += 1) {
    await new Promise((done) => setTimeout(done, 25));
    operation = (await call(base, `/api/operations/${encodeURIComponent(operation.id)}`)).body;
  }
  expect(operation.status, JSON.stringify(operation)).toBe('succeeded');
  return operation.result;
}

describe('an App over a certified Top N saved query (V9)', () => {
  duckDbIt('is certified on the page, in the editor and on the Apps list, and the list follows the page', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-top-n-app-'));
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

      // Ask's answer to "top 2 customers by revenue", saved and certified.
      // Like the Lakers query (player id and name), it groups by two columns.
      const saved = await call(base, '/api/blocks/save-from-cell', {
        cellId: 'agent-run-1',
        name: 'top_customers',
        domain: 'commerce',
        owner: 'commerce@example.test',
        description: 'The two customers with the most revenue.',
        tags: ['revenue'],
        content: 'SELECT customer_id, region, SUM(net_amount) AS net_revenue\nFROM order_lines\nGROUP BY customer_id, region\nORDER BY net_revenue DESC, customer_id\nLIMIT 2',
        sourceQuestion: 'Who are our top 2 customers by revenue?',
      });
      expect(saved.status, saved.text).toBe(201);
      const blockPath: string = saved.body.path;
      const opened = await call(base, `/api/block-studio/open?path=${encodeURIComponent(blockPath)}`);
      expect(opened.status, opened.text).toBe(200);
      const certified = await certify(base, { source: opened.body.source, path: blockPath, metadata: opened.body.metadata, aiReviewed: true });
      expect(certified.outcome, JSON.stringify(certified.blockers ?? certified)).toBe('certified');
      const certifiedPath: string = certified.newPath ?? blockPath;

      const created = await call(base, '/api/app-builds', { name: 'Top customers', goal: 'Top customers', domain: 'commerce', authoringMode: 'manual', template: 'blank' });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const list = async () => (await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?limit=50`)).body.items as Json[];
      const candidate = (await list()).find((item) => item.name === 'top_customers');
      expect(candidate, JSON.stringify((await list()).map((item) => item.name))).toBeDefined();
      const fields = await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: candidate.sourceId });
      expect(fields.status, fields.text).toBe(200);
      // LIMIT 2 on a grouped result is a real Top 2 (a LIMIT 501 on a one-row COUNT(*) is not).
      expect(fields.body.descriptor).toMatchObject({ trust: 'certified', result: { savedQuery: 'top_customers', groupBy: ['customer_id', 'region'], keepsFirstRows: 2 } });
      const source = (await list()).find((item) => item.name === 'top_customers');
      const composed = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [
          // The Lakers tile: a bar by one of the two grouping columns.
          { sourceId: source.sourceId, pageId: 'overview', view: 'chart', title: 'Revenue by customer', query: { dimensions: [{ field: 'customer_id' }], measures: [{ measure: 'net_revenue' }], respectsGlobalFilters: true } },
          // A total of the Top 2.
          { sourceId: source.sourceId, pageId: 'overview', view: 'kpi', title: 'Top 2 revenue', query: { dimensions: [], measures: [{ measure: 'net_revenue' }], respectsGlobalFilters: true } },
        ],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;

      // The editor's page run: both certified.
      const preview = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, { fullRun: true });
      expect(preview.status, preview.text).toBe(200);
      const previewBar = preview.body.tiles.find((tile: Json) => tile.title === 'Revenue by customer');
      const previewKpi = preview.body.tiles.find((tile: Json) => tile.title === 'Top 2 revenue');
      expect(previewBar).toMatchObject({ status: 'ok', trustState: 'certified' });
      expect(previewKpi).toMatchObject({ status: 'ok', trustState: 'certified' });
      expect(previewBar.result.rows.map((row: Json) => [row.customer_id, Number(row.net_revenue)]).sort()).toEqual([['C-001', 70], ['C-002', 30]]);
      expect(Number(previewKpi.result.rows[0].net_revenue)).toBe(100);

      const receipt = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{ type: 'set_preview_receipt', receipt: { id: preview.body.runId, pageId: 'overview', revision: draft.revision, snapshotId: preview.body.snapshotId, filterFingerprint: preview.body.filterFingerprint, resultFingerprint: preview.body.resultFingerprint, createdAt: new Date().toISOString() } }],
      }, 'PATCH');
      expect(receipt.status, receipt.text).toBe(200);
      draft = receipt.body.draft;
      const preflight = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/preflight`, { expectedRevision: draft.revision, proposalHash: draft.proposalHash });
      expect(preflight.status, preflight.text).toBe(200);
      draft = preflight.body.draft;
      const published = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/publish-to-project`, { expectedRevision: draft.revision, proposalHash: draft.proposalHash });
      expect(published.status, published.text).toBe(201);

      // The count stored at publish (the publish dialog's answer).
      const appFile = join(projectRoot, 'apps', draft.appId, 'dql.app.json');
      expect(JSON.parse(readFileSync(appFile, 'utf-8')).tileTrust).toEqual({ certified: 2, total: 2 });

      // The published page: the same count, from its own run, and each tile says what it covers.
      const dashboard = JSON.parse(readFileSync(join(projectRoot, 'apps', draft.appId, 'dashboards', 'overview.dqld'), 'utf-8'));
      const pageTrust = async () => {
        const run = await call(base, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/overview/run`, {});
        expect(run.status, run.text).toBe(200);
        const tiles = new Map<string, Json>(run.body.tiles.map((tile: Json) => [tile.tileId, tile]));
        return { run, summary: appTrustSummary(dashboard.layout.items, tiles) };
      };
      const page = await pageTrust();
      expect(page.summary).toMatchObject({ certified: 2, total: 2, text: 'All tiles certified' });
      const bar = page.run.body.tiles.find((tile: Json) => tile.title === 'Revenue by customer');
      const barTrust = readerTileTrust(dashboard.layout.items.find((item: Json) => item.i === bar.tileId), bar);
      expect(barTrust).toMatchObject({ state: 'certified', label: 'Certified' });
      expect(barTrust?.detail).toBe('Certified data. Covers only the 2 rows top_customers keeps (it is a Top 2), not all of the data.');

      // The Apps list: the same count.
      const listed = async () => (await call(base, '/api/apps')).body.apps.find((app: Json) => app.id === draft.appId);
      expect((await listed()).tileTrust).toEqual({ certified: 2, total: 2 });

      // A stale stored count (an App published before a rule changed, as the
      // Lakers App was) no longer decides the card: the list says what the page says.
      const stored = JSON.parse(readFileSync(appFile, 'utf-8'));
      writeFileSync(appFile, `${JSON.stringify({ ...stored, tileTrust: { certified: 0, total: 2 } }, null, 2)}\n`);
      expect((await listed()).tileTrust).toEqual({ certified: 2, total: 2 });

      // And the other way: the saved query is no longer certified. The page
      // and the list both say so, while the stored count still says 2 of 2.
      writeFileSync(appFile, `${JSON.stringify(stored, null, 2)}\n`);
      const certifiedSource = readFileSync(join(projectRoot, certifiedPath), 'utf-8');
      writeFileSync(join(projectRoot, certifiedPath), certifiedSource.replace('status = "certified"', 'status = "draft"'));
      const after = await pageTrust();
      expect(after.summary).toMatchObject({ certified: 0, total: 2 });
      expect((await listed()).tileTrust).toEqual({ certified: after.summary.certified, total: after.summary.total });
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 240_000);
});
