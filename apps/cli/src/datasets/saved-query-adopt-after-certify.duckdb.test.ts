import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { startLocalServer } from '../local-runtime.js';

/**
 * R01: a saved query certified from inside an App is adopted by that App in
 * place, on real DuckDB through the local runtime.
 *
 * A saved query's fields are read once per revision of its file (design D1).
 * Certifying writes a new revision (status and receipt), so before the fix
 * the App's catalog card for it had no fields any more and the App refused to
 * move: "… does not expose one complete current data version and contract".
 * Both kinds are covered: a saved query used through its result fields and one
 * made row-level (a Dataset definition in its file).
 *
 * Needs a DuckDB connector root (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');
// The App Studio's own refresh planner: the same code "I vouch for this — certify"
// and "Refresh this data" run in the browser. Loaded by path so the CLI build
// does not compile the notebook app's sources.
const rebindPlannerPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dql-notebook/src/components/apps/app-dataset-source-rebind.ts');
type RebindPlan = { ok: true; requiresReviewPolicy: boolean; operations: unknown[] } | { ok: false; code: string; error: string };
const loadRebindPlanner = async () => (await import(/* @vite-ignore */ rebindPlannerPath)).planDatasetSourceRebind as (draft: unknown, candidate: unknown) => RebindPlan;

type Json = any;

async function call(base: string, path: string, body?: unknown, method?: string): Promise<{ status: number; body: Json; text: string }> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

function savedQuery(input: { name: string; sql: string; dimensions?: string[] }): string {
  return [
    '// dql-format: 1',
    '',
    `block "${input.name}" {`,
    '  domain = "commerce"',
    '  type = "custom"',
    '  status = "draft"',
    '  owner = "commerce@example.test"',
    '  description = "A saved query for the R01 tests."',
    ...(input.dimensions ? [`  dimensions = [${input.dimensions.map((name) => `"${name}"`).join(', ')}]`] : []),
    '  tags = ["revenue"]',
    '  query = """',
    input.sql,
    '"""',
    '  tests {',
    '    assert row_count > 0',
    '  }',
    '}',
    '',
  ].join('\n');
}

describe('a saved query certified from its App is adopted in place (R01)', () => {
  duckDbIt('moves the App\'s field tiles to the certified revision for result-field and row-level saved queries', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-adopt-after-certify-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    const planDatasetSourceRebind = await loadRebindPlanner();
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const blocksDir = join(projectRoot, 'domains', 'commerce', 'blocks');
      writeFileSync(join(blocksDir, 'region-probe.dql'), savedQuery({
        name: 'Region probe',
        dimensions: ['region'],
        sql: 'SELECT region, SUM(net_amount) AS region_revenue, COUNT(*) AS line_count FROM order_lines GROUP BY region',
      }));
      writeFileSync(join(blocksDir, 'region-rows.dql'), savedQuery({
        name: 'Region rows',
        dimensions: ['order_line_id', 'region'],
        sql: 'SELECT order_line_id, region, net_amount AS row_revenue FROM order_lines',
      }));
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;

      const created = await call(base, '/api/app-builds', { name: 'Adopt after certify', goal: 'Revenue by region', domain: 'commerce', authoringMode: 'manual', template: 'blank' });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const list = async () => (await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?limit=50`)).body.items as Json[];
      const byName = (items: Json[], name: string) => {
        const item = items.find((candidate) => candidate.name === name);
        expect(item, JSON.stringify(items.map((candidate) => candidate.name))).toBeDefined();
        return item;
      };

      // One saved query is used through its result fields; the other is made row-level first.
      const probeId = byName(await list(), 'Region probe').sourceId;
      expect((await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: probeId })).status).toBe(200);
      const rowsId = byName(await list(), 'Region rows').sourceId;
      const rowLevelDraft = await call(base, '/api/app-datasets/saved-queries/draft', { sourceId: rowsId });
      expect(rowLevelDraft.status, rowLevelDraft.text).toBe(200);
      const rowLevel = await call(base, '/api/app-datasets/saved-queries/create', { sourceId: rowsId, sourceRevision: rowLevelDraft.body.source.sourceRevision });
      expect(rowLevel.status, rowLevel.text).toBe(200);
      expect(rowLevel.body.status).not.toBe('certified');

      const listed = await list();
      const probe = byName(listed, 'Region probe');
      const rows = byName(listed, 'Region rows');
      expect(probe).toMatchObject({ trust: 'review_required', capabilities: { dataset: { result: { savedQuery: 'Region probe' } } } });
      expect(rows.trust).toBe('review_required');
      expect(rows.capabilities.dataset).toBeDefined();

      const composed = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [
          { sourceId: probe.sourceId, pageId: 'overview', view: 'kpi', title: 'Probe revenue', query: { dimensions: [], measures: [{ measure: 'region_revenue' }], respectsGlobalFilters: true } },
          { sourceId: rows.sourceId, pageId: 'overview', view: 'kpi', title: 'Rows revenue', query: { dimensions: [], measures: [{ measure: 'row_revenue' }], respectsGlobalFilters: true } },
        ],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;

      for (const source of [probe, rows]) {
        // "I vouch for this — certify": a new revision of its file.
        const certified = await call(base, '/api/app-datasets/certify', { sourceId: source.sourceId });
        expect(certified.status, certified.text).toBe(200);
        expect(certified.body.status).toBe('certified');

        // What the App Studio does next: resolve the current card for this App, plan, PATCH.
        const resolved = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates`, { sourceIds: [source.sourceId], includeReviewRequired: true });
        expect(resolved.status, resolved.text).toBe(200);
        const candidate = resolved.body.items.find((item: Json) => item.sourceId === source.sourceId);
        expect(candidate).toMatchObject({ trust: 'certified', lifecycle: 'certified' });
        expect(candidate.sourceRevision).not.toBe(source.sourceRevision);
        const descriptor = candidate.capabilities.dataset;
        expect(descriptor, `${source.name} lost its fields after certifying`).toBeDefined();
        expect(descriptor.sourceRevision).toBe(candidate.sourceRevision);
        expect(descriptor.binding).toMatchObject({ sourceRevision: candidate.sourceRevision, contractFingerprint: descriptor.contractRef.fingerprint });

        // The browser maps the wire card (`id` = sourceId) before planning.
        const plan = planDatasetSourceRebind(draft, { ...candidate, id: candidate.sourceId });
        expect(plan, JSON.stringify(plan)).toMatchObject({ ok: true, requiresReviewPolicy: false });
        if (!plan.ok) throw new Error(plan.error);
        const patched = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, {
          expectedRevision: draft.revision,
          expectedProposalHash: draft.proposalHash,
          operations: plan.operations,
        }, 'PATCH');
        expect(patched.status, patched.text).toBe(200);
        draft = patched.body.draft;
        const page = draft.pages.find((candidatePage: Json) => candidatePage.id === 'overview');
        const tile = page.layout.items.find((item: Json) => item.sourceId === source.sourceId);
        expect(tile).toMatchObject({ sourceRevision: candidate.sourceRevision, trustState: 'certified' });
        expect(page.datasets.find((binding: Json) => binding.sourceId === source.sourceId)).toMatchObject({
          sourceRevision: candidate.sourceRevision,
          contractFingerprint: descriptor.contractRef.fingerprint,
        });
      }

      // The page runs certified: the count reads 2 of 2 in place.
      const run = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, { fullRun: true });
      expect(run.status, run.text).toBe(200);
      expect(run.body.tiles.map((tile: Json) => [tile.title, tile.status, tile.trustState, tile.error])).toEqual(expect.arrayContaining([
        ['Probe revenue', 'ok', 'certified', undefined],
        ['Rows revenue', 'ok', 'certified', undefined],
      ]));
      const probeTile = run.body.tiles.find((tile: Json) => tile.title === 'Probe revenue');
      const rowsTile = run.body.tiles.find((tile: Json) => tile.title === 'Rows revenue');
      expect(Number(probeTile.result.rows[0].region_revenue)).toBe(130);
      expect(Number(rowsTile.result.rows[0].row_revenue)).toBe(130);

      // "Refresh this data" on a later edit outside ZLens (a new revision again) recovers the same way.
      const probePath = join(blocksDir, 'region-probe.dql');
      writeFileSync(probePath, readFileSync(probePath, 'utf-8').replace('GROUP BY region', 'GROUP BY region -- edited'));
      // The project notices the hand edit on its own (file watching).
      const resolveProbe = async () => (await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates`, { sourceIds: [probe.sourceId], includeReviewRequired: true }))
        .body.items.find((item: Json) => item.sourceId === probe.sourceId);
      await expect.poll(async () => {
        const current = await resolveProbe();
        return Boolean(current?.capabilities.dataset && current.capabilities.dataset.sourceRevision === current.sourceRevision && current.trust !== 'certified');
      }, { timeout: 20_000, interval: 500 }).toBe(true);
      const edited = await resolveProbe();
      const refreshPlan = planDatasetSourceRebind(draft, { ...edited, id: edited.sourceId });
      expect(refreshPlan, JSON.stringify(refreshPlan)).toMatchObject({ ok: true });
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 240_000);
});
