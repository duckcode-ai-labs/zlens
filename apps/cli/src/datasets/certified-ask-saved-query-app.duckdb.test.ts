import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { appTrustSummary, readEnv, readerTileTrust } from '@zlens/core';
import { startLocalServer } from '../local-runtime.js';

/**
 * V8 B5, end to end on real DuckDB: an App built from a certified saved query
 * that Ask wrote publishes as certified ("1 of 1 tile certified", which the
 * count says as "All tiles certified").
 *
 * Before the fix, Ask's row guard (`LIMIT 501`) stayed on a one-row COUNT(*);
 * the App read the saved query as a "Top 501", so the published page said
 * "0 of 1 tile certified" while the editor and the publish dialog said "All
 * tiles certified". Certify also passed "No unreviewed AI-written content"
 * for SQL nobody reviewed, and added the `app-source` tag.
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

describe('an App built from a certified, Ask-born saved query (V8 B5)', () => {
  duckDbIt('publishes as 1 of 1 tile certified, and Certify asked for a review of what AI wrote', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-certified-ask-app-'));
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

      // Ask's answer, saved with "Save as saved query": a one-row COUNT(*)
      // that still carries the row guard, as saved queries made before the fix do.
      const saved = await call(base, '/api/blocks/save-from-cell', {
        cellId: 'agent-run-1',
        name: 'us_order_lines',
        domain: 'commerce',
        owner: 'commerce@example.test',
        description: 'How many order lines are in the US.',
        tags: ['revenue'],
        content: "SELECT COUNT(*) AS us_lines FROM order_lines WHERE region = 'US'\nLIMIT 501",
        sourceQuestion: 'How many order lines are in the US?',
      });
      expect(saved.status, saved.text).toBe(201);
      expect(saved.body.content).toContain('source_question = "How many order lines are in the US?"');
      expect(saved.body.content).toContain('status = "draft"');
      expect(saved.body.blockers).toContain('AI wrote this saved query. Read its SQL and its result, then confirm you reviewed them before certifying.');
      const blockPath: string = saved.body.path;
      const opened = await call(base, `/api/block-studio/open?path=${encodeURIComponent(blockPath)}`);
      expect(opened.status, opened.text).toBe(200);

      // Certify without saying it was reviewed: stopped, nothing certified.
      const unreviewed = await certify(base, { source: opened.body.source, path: blockPath, metadata: opened.body.metadata });
      expect(unreviewed.outcome).toBe('draft_saved_with_blockers');
      expect(unreviewed.checklist).toMatchObject({ run: true, aiReviewed: false });
      expect(unreviewed.checklist.issues.find((issue: Json) => issue.code === 'ai_review_required')).toMatchObject({ action: 'confirm_ai_review' });
      expect(readFileSync(join(projectRoot, blockPath), 'utf-8')).toContain('status = "draft"');

      // "I reviewed it — certify".
      const reopened = await call(base, `/api/block-studio/open?path=${encodeURIComponent(blockPath)}`);
      const certified = await certify(base, { source: reopened.body.source, path: blockPath, metadata: reopened.body.metadata, aiReviewed: true });
      expect(certified.outcome, JSON.stringify(certified.blockers ?? certified)).toBe('certified');
      const certifiedPath: string = certified.newPath ?? blockPath;
      const certifiedSource = readFileSync(join(projectRoot, certifiedPath), 'utf-8');
      expect(certifiedSource).toContain('status = "certified"');
      // Certifying adds no tag of its own.
      expect(certifiedSource).not.toContain('app-source');
      expect(certifiedSource).toContain('tags = ["revenue"]');
      const companion = readFileSync(join(projectRoot, certified.block.companionPath ?? reopened.body.companionPath), 'utf-8');
      expect(companion).toContain('reviewStatus: certified');
      expect(companion).toMatch(/- ai-reviewed/);

      // The App: one KPI over the certified saved query's result.
      const created = await call(base, '/api/app-builds', { name: 'US lines', goal: 'US order lines', domain: 'commerce', authoringMode: 'manual', template: 'blank' });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const list = async () => (await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?limit=50`)).body.items as Json[];
      const candidate = (await list()).find((item) => item.name === 'us_order_lines');
      expect(candidate, JSON.stringify((await list()).map((item) => item.name))).toBeDefined();
      const fields = await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: candidate.sourceId });
      expect(fields.status, fields.text).toBe(200);
      // The row guard on a one-row statement keeps every row: not a Top 501.
      expect(fields.body.descriptor).toMatchObject({ trust: 'certified', result: { savedQuery: 'us_order_lines', groupBy: [] } });
      expect(fields.body.descriptor.result.keepsFirstRows).toBeUndefined();
      const source = (await list()).find((item) => item.name === 'us_order_lines');
      const composed = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [{ sourceId: source.sourceId, pageId: 'overview', view: 'kpi', title: 'US order lines', query: { dimensions: [], measures: [{ measure: 'us_lines' }], respectsGlobalFilters: true } }],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;

      // The editor's page run: certified, 5 lines.
      const preview = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, { fullRun: true });
      expect(preview.status, preview.text).toBe(200);
      const previewTile = preview.body.tiles.find((tile: Json) => tile.title === 'US order lines');
      expect(previewTile).toMatchObject({ status: 'ok', trustState: 'certified' });
      expect(Number(previewTile.result.rows[0].us_lines)).toBe(5);

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

      // What the publish dialog and the Apps card read: the count stored at publish.
      const app = JSON.parse(readFileSync(join(projectRoot, 'apps', draft.appId, 'dql.app.json'), 'utf-8'));
      expect(app.tileTrust).toEqual({ certified: 1, total: 1 });

      // What the published page says: the same count, from its own run.
      const publishedRun = await call(base, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/overview/run`, {});
      expect(publishedRun.status, publishedRun.text).toBe(200);
      const dashboard = JSON.parse(readFileSync(join(projectRoot, 'apps', draft.appId, 'dashboards', 'overview.dqld'), 'utf-8'));
      const tiles = new Map<string, Json>(publishedRun.body.tiles.map((tile: Json) => [tile.tileId, tile]));
      const pageTrust = appTrustSummary(dashboard.layout.items, tiles);
      expect(pageTrust).toMatchObject({ certified: 1, total: 1, allCertified: true, text: 'All tiles certified' });
      const tile = publishedRun.body.tiles.find((item: Json) => item.title === 'US order lines');
      const item = dashboard.layout.items.find((entry: Json) => entry.i === tile.tileId);
      expect(readerTileTrust(item, tile)).toMatchObject({ state: 'certified', label: 'Certified' });
      expect(readerTileTrust(item, tile)?.checks).toContain('No unreviewed AI-written content');
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 240_000);
});
