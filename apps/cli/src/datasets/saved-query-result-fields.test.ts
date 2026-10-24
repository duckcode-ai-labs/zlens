import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { startLocalServer } from '../local-runtime.js';

/**
 * Everything you add has fields (design D1), end to end on real DuckDB: a
 * saved query (a block with no Dataset definition) offers its result columns
 * as fields without a review step, and tiles over them compile as one query
 * over its complete result. Grouping by the saved query's own columns shows
 * values as they are; anything else rolls them up (Sum), never sums an
 * average, keeps the saved query's trust and says so on the receipt. Page
 * filters and click-to-filter reach these tiles like any Dataset tile.
 * Needs a DuckDB connector root (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');

async function call(base: string, path: string, body?: unknown, method?: string): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

function block(input: { name: string; status: 'certified' | 'draft'; sql: string }): string {
  return [
    '// dql-format: 1',
    '',
    `block "${input.name}" {`,
    '  domain = "commerce"',
    '  type = "custom"',
    `  status = "${input.status}"`,
    '  owner = "commerce@example.test"',
    '  description = "A saved query for the D1 tests."',
    '  tags = ["revenue"]',
    '  query = """',
    input.sql,
    '"""',
    '}',
    '',
  ].join('\n');
}

const findTile = (tiles: any[], title: string) => {
  const tile = tiles.find((candidate) => candidate.title === title);
  expect(tile, `tile ${title}: ${JSON.stringify(tiles.map((candidate) => ({ title: candidate.title, status: candidate.status, error: candidate.error })))}`).toBeDefined();
  return tile;
};

describe('fields from a saved query result', () => {
  duckDbIt('builds tiles from a saved query\'s columns with the roll-up rules, its own trust, filters and publication', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-saved-query-result-'));
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
      const blocksDir = join(projectRoot, 'domains', 'commerce', 'blocks');
      writeFileSync(join(blocksDir, 'monthly-revenue.dql'), block({
        name: 'Monthly revenue',
        status: 'certified',
        sql: [
          "SELECT date_trunc('month', order_date) AS month, SUM(net_amount) AS gross_revenue, COUNT(*) AS line_count, AVG(net_amount) AS avg_line_value",
          'FROM order_lines',
          "GROUP BY date_trunc('month', order_date)",
        ].join('\n'),
      }));
      writeFileSync(join(blocksDir, 'customer-lines.dql'), block({
        name: 'Customer lines',
        status: 'certified',
        sql: 'SELECT customer_id AS customer_name, region, net_amount AS line_spend FROM order_lines',
      }));
      writeFileSync(join(blocksDir, 'region-draft.dql'), block({
        name: 'Region draft',
        status: 'draft',
        sql: 'SELECT region, SUM(net_amount) AS revenue FROM order_lines GROUP BY region',
      }));
      writeFileSync(join(blocksDir, 'region-monthly.dql'), block({
        name: 'Region monthly',
        status: 'certified',
        sql: "SELECT date_trunc('month', order_date) AS month, region, SUM(net_amount) AS net_revenue FROM order_lines GROUP BY 1, 2",
      }));
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;

      const created = await call(base, '/api/app-builds', { name: 'Saved query fields', goal: 'Monthly revenue and top customers', domain: 'commerce', authoringMode: 'manual', sourcePolicy: 'include_review_required', template: 'blank' });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const list = async () => (await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?limit=50`)).body.items as any[];
      const byName = (items: any[], name: string) => {
        const item = items.find((candidate) => candidate.name === name);
        expect(item, JSON.stringify(items.map((candidate) => candidate.name))).toBeDefined();
        return item;
      };
      expect(byName(await list(), 'Monthly revenue').capabilities.dataset).toBeUndefined();

      // Reading the columns needs no review step and changes nothing in the block.
      const before = readFileSync(join(blocksDir, 'monthly-revenue.dql'), 'utf-8');
      const monthlySourceId = byName(await list(), 'Monthly revenue').sourceId;
      const fields = await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: monthlySourceId });
      expect(fields.status, fields.text).toBe(200);
      expect(fields.body).toMatchObject({ ok: true, read: true, sourceId: monthlySourceId });
      expect(readFileSync(join(blocksDir, 'monthly-revenue.dql'), 'utf-8')).toBe(before);
      expect(existsSync(join(projectRoot, '.dql', 'local', 'datasets', 'result-columns.json'))).toBe(true);
      const descriptor = fields.body.descriptor;
      expect(descriptor).toMatchObject({ trust: 'certified', lifecycle: 'certified', result: { savedQuery: 'Monthly revenue', groupBy: ['month'], asIs: ['avg_line_value'], typesFrom: 'probe' } });
      const field = (kind: string, name: string) => descriptor.fields.find((candidate: any) => candidate.kind === kind && candidate.name === name);
      expect(field('physical', 'month')).toMatchObject({ role: 'time', time: { grains: ['month', 'quarter', 'year'], baseGrain: 'month' } });
      expect(field('measure', 'gross_revenue')).toMatchObject({ aggregation: 'sum' });
      expect(field('measure', 'line_count')).toMatchObject({ aggregation: 'sum' });
      expect(field('measure', 'min_avg_line_value')).toMatchObject({ aggregation: 'min' });
      expect(field('measure', 'count_of_rows')).toMatchObject({ aggregation: 'count' });
      // A second read is a no-op; the catalog now lists the fields.
      expect((await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: monthlySourceId })).body).toMatchObject({ ok: true, read: false });
      const listed = await list();
      const monthly = byName(listed, 'Monthly revenue');
      expect(monthly).toMatchObject({ trust: 'certified', capabilities: { dataset: { result: { savedQuery: 'Monthly revenue' } } } });
      // Refusals: a Dataset already has fields; an unknown source.
      expect((await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: 'app:block:missing' })).status).toBe(404);

      // The other two are read on first use, by the page run itself.
      const customers = byName(listed, 'Customer lines');
      const regionDraft = byName(listed, 'Region draft');
      for (const source of [customers, regionDraft]) {
        expect((await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: source.sourceId })).status).toBe(200);
      }
      const relisted = await list();
      const customerSource = byName(relisted, 'Customer lines');
      const draftSource = byName(relisted, 'Region draft');
      expect(customerSource.capabilities.dataset.result.groupBy).toEqual([]);
      expect(draftSource).toMatchObject({ trust: 'review_required', capabilities: { dataset: { trust: 'review_required' } } });

      // Make row-level is still offered for a saved query with result fields.
      const rowLevel = await call(base, '/api/app-datasets/saved-queries/draft', { sourceId: monthly.sourceId });
      expect(rowLevel.status, rowLevel.text).toBe(200);

      const selection = (sourceId: string, title: string, view: 'kpi' | 'chart' | 'table', query: Record<string, unknown>) => ({ sourceId, pageId: 'overview', view, title, query: { ...query, respectsGlobalFilters: true } });
      const composed = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [
          selection(monthly.sourceId, 'Revenue by month', 'chart', { dimensions: [{ field: 'month', timeGrain: 'month' }], measures: [{ measure: 'gross_revenue' }] }),
          selection(monthly.sourceId, 'Revenue by quarter', 'chart', { dimensions: [{ field: 'month', timeGrain: 'quarter' }], measures: [{ measure: 'gross_revenue' }, { measure: 'max_avg_line_value' }] }),
          selection(monthly.sourceId, 'Total revenue', 'kpi', { dimensions: [], measures: [{ measure: 'gross_revenue' }] }),
          selection(customerSource.sourceId, 'Spend by customer', 'chart', { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'line_spend' }], orderBy: [{ alias: 'line_spend', direction: 'desc' }], limit: 10 }),
          selection(draftSource.sourceId, 'Draft revenue', 'kpi', { dimensions: [], measures: [{ measure: 'revenue' }] }),
        ],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const page = draft.pages.find((candidate: any) => candidate.id === 'overview');
      expect(page.layout.items).toHaveLength(5);
      expect(page.layout.items.every((item: any) => item.query && !item.block)).toBe(true);

      const run = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, { fullRun: true });
      expect(run.status, run.text).toBe(200);
      expect(run.body.tiles.map((tile: any) => ({ title: tile.title, status: tile.status, error: tile.error })).filter((tile: any) => tile.status !== 'ok')).toEqual([]);

      // As it is: one point per month of the saved query, its own numbers, no roll-up note.
      const byMonth = findTile(run.body.tiles, 'Revenue by month');
      expect(byMonth.result.rows.map((row: any) => Number(row.gross_revenue))).toEqual([60, 30, 40]);
      expect(Object.keys(byMonth.result.rows[0]).sort()).toEqual(['gross_revenue', 'month_month']);
      expect(byMonth.dataset.validation).toEqual({ outcome: 'covered', adaptations: [] });
      expect(byMonth.trustState).toBe('certified');
      // D5: a certified tile carries who certified its source; one certified by hand, before receipts, carries {}.
      expect(byMonth.certification).toEqual({});
      expect(byMonth.artifact.sql).toContain('WITH ds AS');
      // Rolled up: summed, and the receipt says from what.
      const byQuarter = findTile(run.body.tiles, 'Revenue by quarter');
      expect(byQuarter.result.rows.map((row: any) => Number(row.gross_revenue))).toEqual([130]);
      expect(byQuarter.dataset.validation).toEqual({ outcome: 'adapted', adaptations: [{ kind: 'saved_query_rollup', message: 'Rolled up from the certified result of Monthly revenue.' }] });
      expect(byQuarter.trustState).toBe('certified');
      expect(byQuarter.artifact.explanation[0]).toBe('Rolled up from the certified result of Monthly revenue.');
      expect(Number(findTile(run.body.tiles, 'Total revenue').result.rows[0].gross_revenue)).toBe(130);
      // A plain row query: Sum by customer, top first.
      const spend = findTile(run.body.tiles, 'Spend by customer');
      expect(spend.result.rows.map((row: any) => [row.customer_name, Number(row.line_spend)])).toEqual([['C-001', 70], ['C-002', 30], ['C-003', 30]]);
      // Needs review stays Needs review.
      const reviewTile = findTile(run.body.tiles, 'Draft revenue');
      expect(reviewTile.trustState).toBe('review_required');
      expect(reviewTile.certification).toBeUndefined();
      expect(reviewTile.dataset.validation.adaptations[0].message).toBe('Rolled up from the result of Region draft, which needs review.');

      // An average is never summed.
      const averaged = await call(base, '/api/app-datasets/run', { sourceId: monthly.sourceId, query: { dimensions: [], measures: [{ measure: 'avg_line_value' }] } });
      expect(averaged.status, averaged.text).toBe(400);
      expect(averaged.text).toContain("Averages can't be added up");
      const asIs = await call(base, '/api/app-datasets/run', { sourceId: monthly.sourceId, query: { dimensions: [{ field: 'month', timeGrain: 'month' }], measures: [{ measure: 'avg_line_value' }] } });
      expect(asIs.status, asIs.text).toBe(200);
      expect(asIs.body.result.rows.map((row: any) => Number(row.avg_line_value))).toEqual([30, 15, 40 / 3]);

      // A page filter on a result column, and click-to-filter on a tile's own field.
      const customerBinding = page.datasets.find((binding: any) => binding.sourceId === customerSource.sourceId);
      const monthBinding = page.datasets.find((binding: any) => binding.sourceId === monthly.sourceId);
      expect(customerBinding && monthBinding).toBeTruthy();
      const filtered = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [
          { type: 'set_filter', pageId: page.id, filter: { id: 'customer', type: 'multiselect', label: 'Customer', scope: { app: true }, datasetBindings: { [customerBinding.id]: { field: 'customer_name' } } } },
          { type: 'set_filter', pageId: page.id, filter: { id: 'period', type: 'daterange', label: 'Period', scope: { app: true }, datasetBindings: { [monthBinding.id]: { field: 'month' } } } },
        ],
      }, 'PATCH');
      expect(filtered.status, filtered.text).toBe(200);
      draft = filtered.body.draft;
      const filteredRun = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, {
        variables: { customer: ['C-002', 'C-003'], period: { start: '2026-02-01', end: '2026-03-31' } },
        fullRun: true,
      });
      expect(filteredRun.status, filteredRun.text).toBe(200);
      expect(findTile(filteredRun.body.tiles, 'Spend by customer').result.rows.map((row: any) => row.customer_name)).toEqual(['C-002', 'C-003']);
      expect(findTile(filteredRun.body.tiles, 'Revenue by month').error).toBeUndefined();
      expect(findTile(filteredRun.body.tiles, 'Revenue by month').result.rows.map((row: any) => Number(row.gross_revenue))).toEqual([30, 40]);
      expect(findTile(filteredRun.body.tiles, 'Spend by customer').dataset.appliedFilters).toEqual([{ field: 'customer_name', op: 'in', values: ['C-002', 'C-003'], placement: 'where' }]);
      const spendTile = page.layout.items.find((item: any) => item.title === 'Spend by customer');
      const clicked = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, {
        fullRun: true,
        crossFilters: [{ fromTileId: spendTile.i, fromSourceId: customerSource.sourceId, fromSourceRevision: customerSource.sourceRevision, field: 'customer_name', values: ['C-001'] }],
      });
      expect(clicked.status, clicked.text).toBe(200);
      expect(findTile(clicked.body.tiles, 'Spend by customer').result.rows).toEqual([{ customer_name: 'C-001', line_spend: 70 }]);

      // The certified tiles publish like Dataset tiles (the review-required one is removed first).
      const reviewItem = page.layout.items.find((item: any) => item.title === 'Draft revenue');
      const trimmed = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [
          { type: 'remove_tile', pageId: page.id, tileId: reviewItem.i },
          { type: 'remove_source', sourceId: draftSource.sourceId },
          ...(draft.reviewTasks ?? [])
            .filter((task: any) => task.sourceId === draftSource.sourceId || task.tileId === reviewItem.i)
            .map((task: any) => ({ type: 'remove_review_task', taskId: task.id })),
          { type: 'set_source_policy', sourcePolicy: 'governed_only' },
        ],
      }, 'PATCH');
      expect(trimmed.status, trimmed.text).toBe(200);
      draft = trimmed.body.draft;
      const fullRun = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, { fullRun: true });
      expect(fullRun.status, fullRun.text).toBe(200);
      const receipt = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{ type: 'set_preview_receipt', receipt: { id: fullRun.body.runId, pageId: 'overview', revision: draft.revision, snapshotId: fullRun.body.snapshotId, filterFingerprint: fullRun.body.filterFingerprint, resultFingerprint: fullRun.body.resultFingerprint, createdAt: new Date().toISOString() } }],
      }, 'PATCH');
      expect(receipt.status, receipt.text).toBe(200);
      draft = receipt.body.draft;
      const preflight = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/preflight`, { expectedRevision: draft.revision, proposalHash: draft.proposalHash });
      expect(preflight.status, preflight.text).toBe(200);
      draft = preflight.body.draft;
      const published = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/publish-to-project`, { expectedRevision: draft.revision, proposalHash: draft.proposalHash });
      expect(published.status, published.text).toBe(201);
      const overview = JSON.parse(readFileSync(join(projectRoot, 'apps', draft.appId, 'dashboards', 'overview.dqld'), 'utf-8'));
      expect(overview.version).toBe(3);
      expect(overview.layout.items.find((item: any) => item.title === 'Revenue by month')).toMatchObject({ sourceId: monthly.sourceId, query: { measures: [{ measure: 'gross_revenue' }] } });

      // A fresh checkout has no local column cache: the published page reads the columns again and runs.
      rmSync(join(projectRoot, '.dql', 'local', 'datasets', 'result-columns.json'), { force: true });
      const publishedRun = await call(base, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/overview/run`, {});
      expect(publishedRun.status, publishedRun.text).toBe(200);
      expect(publishedRun.body.tiles.map((tile: any) => tile.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
      expect(findTile(publishedRun.body.tiles, 'Revenue by month').result.rows.map((row: any) => Number(row.gross_revenue))).toEqual([60, 30, 40]);

      // The AI path: the App planner reads a saved query's result fields first
      // and composes a field tile from them instead of a fixed one.
      const aiApp = await call(base, '/api/app-builds', { name: 'AI fields', goal: 'Monthly net revenue trend', domain: 'commerce', authoringMode: 'ai', sourcePolicy: 'governed_only', template: 'blank' });
      expect(aiApp.status, aiApp.text).toBe(201);
      const aiCandidates = (await call(base, `/api/app-builds/${encodeURIComponent(aiApp.body.draft.id)}/source-candidates?limit=50`)).body.items as any[];
      const regionMonthly = aiCandidates.find((candidate) => candidate.name === 'Region monthly');
      expect(regionMonthly.capabilities.dataset).toBeUndefined();
      const aiProposal = await call(base, `/api/app-builds/${encodeURIComponent(aiApp.body.draft.id)}/ai-proposals`, {
        prompt: 'Monthly net revenue trend',
        expectedRevision: aiApp.body.draft.revision,
        proposalHash: aiApp.body.draft.proposalHash,
        selectedBlockIds: [regionMonthly.sourceId],
        mode: 'replace',
      });
      expect(aiProposal.status, aiProposal.text).toBe(201);
      const aiOperations = aiProposal.body.proposal.operations as any[];
      const aiSource = aiOperations.find((operation) => operation.type === 'upsert_source' && operation.source.id === regionMonthly.sourceId);
      expect(aiSource?.source.capabilities.dataset.result).toMatchObject({ savedQuery: 'Region monthly', groupBy: ['month', 'region'] });
      const aiTiles = aiOperations.filter((operation) => operation.type === 'upsert_page').flatMap((operation) => operation.page.layout.items);
      const aiTile = aiTiles.find((tile: any) => tile.sourceId === regionMonthly.sourceId);
      expect(aiTile, JSON.stringify(aiTiles)).toMatchObject({ query: { dimensions: [{ field: 'month', timeGrain: 'month' }], measures: [{ measure: 'net_revenue' }] } });
      expect(aiTile.block).toBeUndefined();

    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 240_000);
});
