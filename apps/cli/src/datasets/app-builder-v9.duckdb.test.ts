import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { startLocalServer } from '../local-runtime.js';

/**
 * New-user test V9, end to end on real DuckDB: the App builder problems a
 * new customer still hit.
 *   - A DQL block saved in a notebook cell loaded its fields, but every tile
 *     from it failed in the editor: "Dataset MCP source … is not eligible for
 *     governed local execution". Describe with AI picked exactly that block,
 *     so its tiles failed too. The editor's live preview now runs an App's
 *     data under the App's rule, as the page run does; Dataset MCP stays
 *     certified-or-checked only.
 *   - A KPI over points per game added the two averages up. A per-game
 *     value is never summed; "total points" is a number, not money.
 * Needs a DuckDB connector root (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');
const WARRIORS = 1610612744;

async function call(base: string, path: string, body?: unknown, method?: string): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

/**
 * 20 games, two teams each. Games 1–10 are the 2015 regular season, 11–16
 * the 2016 regular season, 17–20 the 2016 playoffs. The Warriors win the
 * even games and score 110 + the game number.
 */
function teamGameRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let game = 1; game <= 20; game += 1) {
    const season = game <= 10 ? 2015 : 2016;
    const gameType = game <= 16 ? 'Regular season' : 'Playoffs';
    rows.push({ GAME_ID: 22000000 + game, TEAM_ID: WARRIORS, SEASON: season, GAME_TYPE: gameType, WL: game % 2 === 0 ? 'W' : 'L', PTS: 110 + game });
    rows.push({ GAME_ID: 22000000 + game, TEAM_ID: 1610612738, SEASON: season, GAME_TYPE: gameType, WL: game % 2 === 0 ? 'L' : 'W', PTS: 100 + game });
  }
  return rows;
}

const winsByGameType = [
  'block "Warriors wins by game type" {',
  '  domain = "nba"',
  '  type = "custom"',
  '  owner = "nba@example.test"',
  '  description = "Warriors wins per season, split by game type."',
  '  query = """',
  `    SELECT SEASON, GAME_TYPE, COUNT(*) AS WINS FROM LOCAL_TEAM_GAME_FACTS WHERE TEAM_ID = ${WARRIORS} AND WL = 'W' GROUP BY SEASON, GAME_TYPE`,
  '  """',
  '}',
].join('\n');

const pointsPerGame = [
  '// dql-format: 1',
  '',
  'block "Warriors points per game 2016" {',
  '  domain = "nba"',
  '  type = "custom"',
  '  status = "certified"',
  '  owner = "nba@example.test"',
  '  description = "Warriors points per game in 2016, regular season and playoffs."',
  '  query = """',
  `SELECT GAME_TYPE, AVG(PTS) AS POINTS_PER_GAME, SUM(PTS) AS TOTAL_POINTS FROM LOCAL_TEAM_GAME_FACTS WHERE TEAM_ID = ${WARRIORS} AND SEASON = 2016 GROUP BY GAME_TYPE`,
  '"""',
  '}',
  '',
].join('\n');

const tileOf = (tiles: any[], title: string) => {
  const tile = tiles.find((candidate) => candidate.title === title);
  expect(tile, `tile ${title}: ${JSON.stringify(tiles.map((candidate) => ({ title: candidate.title, status: candidate.status, error: candidate.error })))}`).toBeDefined();
  return tile;
};

describe('App builder fixes from new-user test V9', () => {
  duckDbIt('runs notebook block tiles in the editor, on the published page and from Describe with AI, and never sums points per game', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-builder-v9-'));
    const databasePath = join(projectRoot, 'nba.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
        project: 'nba',
        apps: { datasets: true },
        defaultConnectionName: 'default',
        connections: { default: { driver: 'duckdb', filepath: 'nba.duckdb' } },
        semanticLayer: { provider: 'dql' },
        manifestVersion: 3,
      }, null, 2));
      mkdirSync(join(projectRoot, 'domains', 'nba', 'blocks'), { recursive: true });
      writeFileSync(join(projectRoot, 'domains', 'nba', 'domain.dql'), '// dql-format: 1\n\ndomain "NBA" {\n  id = "nba"\n  owner = "nba@example.test"\n  description = "NBA games"\n}\n');
      writeFileSync(join(projectRoot, 'domains', 'nba', 'blocks', 'warriors-ppg.dql'), pointsPerGame);
      mkdirSync(join(projectRoot, 'notebooks'), { recursive: true });
      writeFileSync(join(projectRoot, 'notebooks', 'warriors.dqlnb'), JSON.stringify({
        version: 1,
        title: 'Warriors',
        metadata: { domain: 'nba' },
        cells: [{ id: 'cell-wins', type: 'dql', name: 'Warriors wins by game type', content: winsByGameType }],
      }, null, 2));
      const seed = join(projectRoot, 'seed.json');
      writeFileSync(seed, JSON.stringify({ tables: { LOCAL_TEAM_GAME_FACTS: {
        columns: [{ name: 'GAME_ID', type: 'int' }, { name: 'TEAM_ID', type: 'int' }, { name: 'SEASON', type: 'int' }, { name: 'GAME_TYPE', type: 'text' }, { name: 'WL', type: 'text' }, { name: 'PTS', type: 'int' }],
        rows: teamGameRows(),
      } } }));
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', seed, '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;

      const created = await call(base, '/api/app-builds', { name: 'Warriors', goal: 'Warriors wins by season and game type', domain: 'nba', authoringMode: 'manual', sourcePolicy: 'include_review_required', template: 'blank' });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const list = async (id = draft.id) => (await call(base, `/api/app-builds/${encodeURIComponent(id)}/source-candidates?limit=50`)).body.items as any[];
      const byName = (items: any[], name: string) => {
        const item = items.find((candidate) => candidate.name === name);
        expect(item, JSON.stringify(items.map((candidate) => candidate.name))).toBeDefined();
        return item;
      };
      const notebookBlock = byName(await list(), 'Warriors wins by game type');
      expect(notebookBlock).toMatchObject({ sourcePath: 'notebooks/warriors.dqlnb#cell-wins', trust: 'review_required' });
      const ppgBlock = byName(await list(), 'Warriors points per game 2016');
      for (const sourceId of [notebookBlock.sourceId, ppgBlock.sourceId]) {
        const read = await call(base, '/api/app-datasets/saved-queries/fields', { sourceId });
        expect(read.status, read.text).toBe(200);
      }

      // 1. The editor's live preview runs a tile from the notebook block; Dataset MCP still refuses it.
      const winsQuery = { dimensions: [{ field: 'SEASON' }, { field: 'GAME_TYPE' }], measures: [{ measure: 'WINS' }], respectsGlobalFilters: true };
      const preview = await call(base, '/api/app-datasets/tile-preview', { sourceId: notebookBlock.sourceId, query: winsQuery });
      expect(preview.status, preview.text).toBe(200);
      expect(preview.body).toMatchObject({ ok: true, trustState: 'review_required' });
      expect(preview.body.result.rows.map((row: any) => [Number(row.SEASON), row.GAME_TYPE, Number(row.WINS)]).sort()).toEqual([[2015, 'Regular season', 5], [2016, 'Playoffs', 2], [2016, 'Regular season', 3]]);
      const mcp = await call(base, '/api/app-datasets/run', { sourceId: notebookBlock.sourceId, query: winsQuery });
      expect(mcp.status).toBeGreaterThanOrEqual(400);
      expect(mcp.text).toContain('is not eligible for governed local execution');

      // 2. Points per game: the first-click KPI is refused, never 123.5 + 128.5; by game type it shows as it is.
      const ppgFields = (await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: ppgBlock.sourceId })).body.descriptor.fields as any[];
      expect(ppgFields.find((field) => field.kind === 'measure' && field.name === 'POINTS_PER_GAME')).toMatchObject({ aggregation: 'max', additivity: { entities: 'non_additive' } });
      expect(ppgFields.find((field) => field.kind === 'measure' && field.name === 'TOTAL_POINTS')).toMatchObject({ aggregation: 'sum', format: { kind: 'number' } });
      const kpi = await call(base, '/api/app-datasets/tile-preview', { sourceId: ppgBlock.sourceId, query: { dimensions: [], measures: [{ measure: 'POINTS_PER_GAME' }], respectsGlobalFilters: true } });
      expect(kpi.body.ok, kpi.text).not.toBe(true);
      expect(kpi.text).toContain("Averages can't be added up: Points per game is worked out on each row");
      expect(kpi.text).not.toContain('Dataset MCP');
      expect(kpi.text).not.toContain('252');
      const byType = await call(base, '/api/app-datasets/tile-preview', { sourceId: ppgBlock.sourceId, query: { dimensions: [{ field: 'GAME_TYPE' }], measures: [{ measure: 'POINTS_PER_GAME' }], respectsGlobalFilters: true } });
      expect(byType.body.ok, byType.text).toBe(true);
      expect(byType.body.result.rows.map((row: any) => [row.GAME_TYPE, Number(row.POINTS_PER_GAME)]).sort()).toEqual([['Playoffs', 128.5], ['Regular season', 123.5]]);

      // 3. The notebook block's tile runs on the App page and on the published page.
      const composed = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [{ sourceId: notebookBlock.sourceId, pageId: 'overview', view: 'chart', title: 'Wins by season and game type', query: winsQuery }],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const run = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, { fullRun: true });
      expect(run.status, run.text).toBe(200);
      expect(tileOf(run.body.tiles, 'Wins by season and game type')).toMatchObject({ status: 'ok' });
      const receipt = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{ type: 'set_preview_receipt', receipt: { id: run.body.runId, pageId: 'overview', revision: draft.revision, snapshotId: run.body.snapshotId, filterFingerprint: run.body.filterFingerprint, resultFingerprint: run.body.resultFingerprint, createdAt: new Date().toISOString() } }],
      }, 'PATCH');
      expect(receipt.status, receipt.text).toBe(200);
      draft = receipt.body.draft;
      const preflight = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/preflight`, { expectedRevision: draft.revision, proposalHash: draft.proposalHash });
      expect(preflight.status, preflight.text).toBe(200);
      draft = preflight.body.draft;
      const published = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/publish-to-project`, { expectedRevision: draft.revision, proposalHash: draft.proposalHash });
      expect(published.status, published.text).toBe(201);
      const publishedRun = await call(base, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/overview/run`, {});
      expect(publishedRun.status, publishedRun.text).toBe(200);
      const publishedTile = tileOf(publishedRun.body.tiles, 'Wins by season and game type');
      expect(publishedTile).toMatchObject({ status: 'ok', trustState: 'review_required' });
      expect(publishedTile.result.rows.map((row: any) => Number(row.WINS)).sort()).toEqual([2, 3, 5]);

      // 4. Describe with AI plans from the notebook block, and every tile it proposes runs in the editor.
      const aiApp = await call(base, '/api/app-builds', { name: 'Warriors AI', goal: 'Warriors wins by season and game type', domain: 'nba', authoringMode: 'ai', sourcePolicy: 'include_review_required', template: 'blank' });
      expect(aiApp.status, aiApp.text).toBe(201);
      const aiProposal = await call(base, `/api/app-builds/${encodeURIComponent(aiApp.body.draft.id)}/ai-proposals`, {
        prompt: 'Warriors wins by season and game type',
        expectedRevision: aiApp.body.draft.revision,
        proposalHash: aiApp.body.draft.proposalHash,
        selectedBlockIds: [notebookBlock.sourceId],
        mode: 'replace',
      });
      expect(aiProposal.status, aiProposal.text).toBe(201);
      const proposedTiles = (aiProposal.body.proposal.operations as any[])
        .filter((operation) => operation.type === 'upsert_page')
        .flatMap((operation) => operation.page.layout.items)
        .filter((tile: any) => tile.sourceId === notebookBlock.sourceId && tile.query);
      expect(proposedTiles.length, JSON.stringify(aiProposal.body.proposal.operations)).toBeGreaterThan(0);
      for (const tile of proposedTiles) {
        const ran = await call(base, '/api/app-datasets/tile-preview', { sourceId: tile.sourceId, query: tile.query });
        expect(ran.body.ok, `${tile.title}: ${ran.text}`).toBe(true);
      }
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
