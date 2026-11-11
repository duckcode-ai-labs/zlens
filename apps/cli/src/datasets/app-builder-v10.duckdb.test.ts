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
 * New-user test V10, end to end on real DuckDB: the averages rule from V9
 * was too broad, and broke a published App.
 *   - The tester's certified Ask saved query makes GAME_TYPE with a CASE
 *     expression and ends in Ask's LIMIT 501, so ZLens can't read its
 *     grouping from its SQL. V10 refused every tile of POINTS_PER_GAME, even
 *     one bar per game type, and the published App's bar of it, certified in
 *     V9, showed Blocked. An average now shows as it is wherever each group
 *     holds one row of the result; the run refuses only a tile that would
 *     combine rows (the 235.18 KPI).
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
 * the 2016 regular season, 17–20 the 2016 playoffs. The Warriors score
 * 110 + the game number: 123.5 a game in the 2016 regular season, 128.5 in
 * the playoffs.
 */
function teamGameRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let game = 1; game <= 20; game += 1) {
    const season = game <= 10 ? 2015 : 2016;
    rows.push({ GAME_ID: 22000000 + game, TEAM_ID: WARRIORS, SEASON: season, PTS: 110 + game });
    rows.push({ GAME_ID: 22000000 + game, TEAM_ID: 1610612738, SEASON: season, PTS: 100 + game });
  }
  return rows;
}

const block = (name: string, description: string, sql: string) => [
  '// dql-format: 1',
  '',
  `block "${name}" {`,
  '  domain = "nba"',
  '  type = "custom"',
  '  status = "certified"',
  '  owner = "nba@example.test"',
  `  description = "${description}"`,
  '  query = """',
  sql,
  '"""',
  '}',
  '',
].join('\n');

// The tester's shape: game type from the game id, points per game, Ask's LIMIT 501.
const pointsPerGame = block('Warriors ppg regular vs playoffs 2016', 'Warriors points per game in 2016, regular season and playoffs.', [
  `SELECT CASE WHEN GAME_ID > 22000016 THEN 'Playoffs' ELSE 'Regular season' END AS GAME_TYPE,`,
  '  ROUND(SUM(PTS) * 1.0 / COUNT(DISTINCT GAME_ID), 2) AS POINTS_PER_GAME',
  'FROM LOCAL_TEAM_GAME_FACTS',
  `WHERE TEAM_ID = ${WARRIORS} AND SEASON = 2016`,
  'GROUP BY 1',
  'ORDER BY 1',
  'LIMIT 501',
].join('\n'));

// Grouped by season, filtered to one season: one row.
const playoffPoints = block('Warriors playoff ppg 2016', 'Warriors points per game in the 2016 playoffs.',
  `SELECT SEASON, AVG(PTS) AS POINTS_PER_GAME FROM LOCAL_TEAM_GAME_FACTS WHERE TEAM_ID = ${WARRIORS} AND SEASON = 2016 AND GAME_ID > 22000016 GROUP BY SEASON`);

const tileOf = (tiles: any[], title: string) => {
  const tile = tiles.find((candidate) => candidate.title === title);
  expect(tile, `tile ${title}: ${JSON.stringify(tiles.map((candidate) => ({ title: candidate.title, status: candidate.status, error: candidate.error })))}`).toBeDefined();
  return tile;
};
const byGameType = (rows: any[]) => rows.map((row) => [row.GAME_TYPE, Number(row.POINTS_PER_GAME)]).sort();

describe('averages shown as they are from new-user test V10', () => {
  duckDbIt('runs and publishes a certified bar of points per game by game type, refuses only the KPI that adds them up, and shows a one-row average', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-builder-v10-'));
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
      writeFileSync(join(projectRoot, 'domains', 'nba', 'blocks', 'warriors-playoff-ppg.dql'), playoffPoints);
      const seed = join(projectRoot, 'seed.json');
      writeFileSync(seed, JSON.stringify({ tables: { LOCAL_TEAM_GAME_FACTS: {
        columns: [{ name: 'GAME_ID', type: 'int' }, { name: 'TEAM_ID', type: 'int' }, { name: 'SEASON', type: 'int' }, { name: 'PTS', type: 'int' }],
        rows: teamGameRows(),
      } } }));
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', seed, '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;

      const created = await call(base, '/api/app-builds', { name: 'Warriors 2016 scoring', goal: 'Warriors points per game, regular season and playoffs', domain: 'nba', authoringMode: 'manual', sourcePolicy: 'include_review_required', template: 'blank' });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const items = (await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?limit=50`)).body.items as any[];
      const byName = (name: string) => {
        const item = items.find((candidate) => candidate.name === name);
        expect(item, JSON.stringify(items.map((candidate) => candidate.name))).toBeDefined();
        return item;
      };
      const ppg = byName('Warriors ppg regular vs playoffs 2016');
      const playoff = byName('Warriors playoff ppg 2016');
      expect(ppg).toMatchObject({ trust: 'certified' });
      const fields = await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: ppg.sourceId });
      expect(fields.status, fields.text).toBe(200);
      // Its SQL names no grouping ZLens can read (GAME_TYPE is a CASE expression).
      expect(fields.body.descriptor.result).toMatchObject({ groupBy: [], asIs: ['POINTS_PER_GAME'], keepsFirstRows: 501 });
      expect((await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: playoff.sourceId })).status).toBe(200);

      // 1. A bar by game type shows each row as it is, certified, with no row count leaking out.
      const barQuery = { dimensions: [{ field: 'GAME_TYPE' }], measures: [{ measure: 'POINTS_PER_GAME' }], respectsGlobalFilters: true };
      const bar = await call(base, '/api/app-datasets/tile-preview', { sourceId: ppg.sourceId, query: barQuery });
      expect(bar.body.ok, bar.text).toBe(true);
      expect(bar.body.trustState).toBe('certified');
      expect(byGameType(bar.body.result.rows)).toEqual([['Playoffs', 128.5], ['Regular season', 123.5]]);
      expect(bar.text).not.toContain('__zlens_rows_per_group');

      // 2. The first-click KPI would add the two averages up: refused, never 252.
      const kpi = await call(base, '/api/app-datasets/tile-preview', { sourceId: ppg.sourceId, query: { dimensions: [], measures: [{ measure: 'POINTS_PER_GAME' }], respectsGlobalFilters: true } });
      expect(kpi.body.ok, kpi.text).toBe(false);
      expect(kpi.body.diagnostics).toEqual(['NON_ADDITIVE_RESULT_ROLLUP']);
      expect(kpi.body.error).toBe("Averages can't be added up: Points per game is worked out on each row of Warriors ppg regular vs playoffs 2016, and this tile puts 2 of them together. Use Min points per game or Max points per game, or group by a column that is different on each row to show each row as it is.");
      expect(kpi.text).not.toContain('252');
      // Max is still there for a KPI, and is what it says.
      const max = await call(base, '/api/app-datasets/tile-preview', { sourceId: ppg.sourceId, query: { dimensions: [], measures: [{ measure: 'max_POINTS_PER_GAME' }], respectsGlobalFilters: true } });
      expect(max.body.ok, max.text).toBe(true);
      expect(Number(max.body.result.rows[0].max_POINTS_PER_GAME)).toBe(128.5);

      // 3. A KPI over a one-row result shows its average, although the saved query is grouped by season.
      const one = await call(base, '/api/app-datasets/tile-preview', { sourceId: playoff.sourceId, query: { dimensions: [], measures: [{ measure: 'POINTS_PER_GAME' }], respectsGlobalFilters: true } });
      expect(one.body.ok, one.text).toBe(true);
      expect(Number(one.body.result.rows[0].POINTS_PER_GAME)).toBe(128.5);

      // 4. The App the tester published in V9: the bar, then a table of the same rows. It publishes,
      //    and the published page runs the bar certified, as it is, without "max".
      const composed = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [
          { sourceId: ppg.sourceId, pageId: 'overview', view: 'chart', title: 'POINTS PER GAME by game type', query: barQuery },
          { sourceId: ppg.sourceId, pageId: 'overview', view: 'table', title: 'Points per game table', query: barQuery },
        ],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const run = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, { fullRun: true });
      expect(run.status, run.text).toBe(200);
      for (const title of ['POINTS PER GAME by game type', 'Points per game table']) {
        const tile = tileOf(run.body.tiles, title);
        expect(tile, JSON.stringify(tile.error)).toMatchObject({ status: 'ok', trustState: 'certified' });
        expect(byGameType(tile.result.rows)).toEqual([['Playoffs', 128.5], ['Regular season', 123.5]]);
        expect(tile.artifact.explanation[0]).toBe('Shows the rows of Warriors ppg regular vs playoffs 2016 as they are.');
      }
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
      const publishedBar = tileOf(publishedRun.body.tiles, 'POINTS PER GAME by game type');
      expect(publishedBar).toMatchObject({ status: 'ok', trustState: 'certified' });
      expect(byGameType(publishedBar.result.rows)).toEqual([['Playoffs', 128.5], ['Regular season', 123.5]]);
      expect(publishedRun.text).not.toContain('max points per game');
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
