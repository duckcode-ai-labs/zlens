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
import { syncWarehouseCatalog } from '../warehouse-catalog-sync.js';

/**
 * New-user test V8, item 5, end to end on real DuckDB: App sources a new
 * customer could not use.
 *   - A DQL block saved in a notebook cell failed with ENOENT on
 *     `notebooks/x.dqlnb#cell`: it now reads, offers its fields and runs.
 *   - A team-game facts table was refused ("No column is filled and different
 *     on every row") although Modeling saved its row key, GAME_ID and TEAM_ID
 *     together: that key is checked and used. SEASON is never summed.
 * Needs a DuckDB connector root (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');

async function call(base: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

/** 20 games, two teams each: one row per team per game; one team wins each game. */
function teamGameRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let game = 1; game <= 20; game += 1) {
    for (const [team, wins] of [[1610612737, game % 2 === 0], [1610612738, game % 2 === 1]] as const) {
      rows.push({ GAME_ID: 22000000 + game, TEAM_ID: team, SEASON: game <= 10 ? 2015 : 2016, WL: wins ? 'W' : 'L', PTS: 100 + game, FG_PCT: 0.45 });
    }
  }
  return rows;
}

const winsBlock = [
  'block "Wins by season" {',
  '  domain = "nba"',
  '  type = "custom"',
  '  owner = "nba@example.test"',
  '  query = """',
  "    SELECT SEASON, COUNT(*) AS WINS FROM LOCAL_TEAM_GAME_FACTS WHERE WL = 'W' GROUP BY SEASON",
  '  """',
  '}',
].join('\n');

describe('App sources a new customer adds (new-user test V8, item 5)', () => {
  duckDbIt('uses a notebook block and a table keyed by two columns as App data', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-sources-new-user-'));
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
        modeling: { mode: 'warehouse-first' },
      }, null, 2));
      mkdirSync(join(projectRoot, 'domains', 'nba', 'modeling'), { recursive: true });
      writeFileSync(join(projectRoot, 'domains', 'nba', 'domain.dql'), '// dql-format: 1\n\ndomain "NBA" {\n  id = "nba"\n  owner = "nba@example.test"\n  description = "NBA games"\n}\n');
      writeFileSync(join(projectRoot, 'domains', 'nba', 'modeling', 'model.dql.yaml'), [
        'entities:',
        '  - id: team_game',
        '    relation: nba.main.LOCAL_TEAM_GAME_FACTS',
        '    business_name: Team game',
        '    status: reviewed',
        '    grain: GAME_ID, TEAM_ID',
        '    keys:',
        '      - GAME_ID',
        '      - TEAM_ID',
        '',
      ].join('\n'));
      mkdirSync(join(projectRoot, 'notebooks'), { recursive: true });
      writeFileSync(join(projectRoot, 'notebooks', 'nba.dqlnb'), JSON.stringify({
        version: 1,
        title: 'NBA research',
        metadata: { domain: 'nba' },
        cells: [
          { id: 'intro', type: 'markdown', content: '# NBA' },
          { id: 'cell-wins', type: 'dql', name: 'Wins by season', content: winsBlock },
        ],
      }, null, 2));
      const seed = join(projectRoot, 'seed.json');
      writeFileSync(seed, JSON.stringify({ tables: { LOCAL_TEAM_GAME_FACTS: {
        columns: [{ name: 'GAME_ID', type: 'int' }, { name: 'TEAM_ID', type: 'int' }, { name: 'SEASON', type: 'int' }, { name: 'WL', type: 'text' }, { name: 'PTS', type: 'int' }, { name: 'FG_PCT', type: 'decimal' }],
        rows: teamGameRows(),
      } } }));
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', seed, '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      await syncWarehouseCatalog({
        projectRoot,
        executor,
        connection,
        scope: { version: 1, connectionId: 'default', driver: 'duckdb', mode: 'selected_scopes', scopes: [{ catalogOrDatabase: 'nba', schemas: ['main'] }], selectedScopes: [{ catalogOrDatabase: 'nba', schemas: ['main'] }], relations: [], scopeFingerprint: 'f' },
      });
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;

      const created = await call(base, '/api/app-builds', { name: 'NBA', goal: 'Wins and points by season', domain: 'nba', authoringMode: 'manual', sourcePolicy: 'include_review_required', template: 'blank' });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const list = async () => (await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?limit=50`)).body.items as any[];
      const byName = (items: any[], name: string) => {
        const item = items.find((candidate) => candidate.name === name);
        expect(item, JSON.stringify(items.map((candidate) => candidate.name))).toBeDefined();
        return item;
      };

      // The notebook block: its fields are read from its cell, with no ENOENT.
      const notebookBlock = byName(await list(), 'Wins by season');
      expect(notebookBlock.sourcePath).toBe('notebooks/nba.dqlnb#cell-wins');
      const fields = await call(base, '/api/app-datasets/saved-queries/fields', { sourceId: notebookBlock.sourceId });
      expect(fields.status, fields.text).toBe(200);
      expect(fields.body).toMatchObject({ ok: true, read: true, sourceId: notebookBlock.sourceId });
      const descriptorField = (kind: string, name: string) => fields.body.descriptor.fields.find((candidate: any) => candidate.kind === kind && candidate.name === name);
      expect(descriptorField('measure', 'WINS')).toMatchObject({ aggregation: 'sum' });
      expect(descriptorField('measure', 'SEASON')).toBeUndefined();

      // The table: Modeling's row key, GAME_ID and TEAM_ID together, is checked and used.
      const tables = await call(base, '/api/app-datasets/tables');
      expect(tables.status, tables.text).toBe(200);
      const teamGames = tables.body.tables.find((table: { name: string }) => table.name === 'LOCAL_TEAM_GAME_FACTS');
      expect(teamGames.modeled).toMatchObject({ state: 'modeled', entity: 'Team game', keys: ['GAME_ID', 'TEAM_ID'] });
      const drafted = await call(base, '/api/app-datasets/tables/draft', { tableId: teamGames.id });
      expect(drafted.status, drafted.text).toBe(200);
      expect(drafted.body.proposal.key).toEqual({ column: 'GAME_ID', columns: ['GAME_ID', 'TEAM_ID'], entity: 'team_game' });
      expect(drafted.body.rows).toBe(40);
      expect(drafted.body.proposal.measures.filter((measure: any) => measure.aggregation === 'sum').map((measure: any) => measure.from)).toEqual(['PTS']);
      const made = await call(base, '/api/app-datasets/tables/create', { tableId: teamGames.id, name: 'Team games', domain: 'nba' });
      expect(made.status, made.text).toBe(201);
      expect(made.body).toMatchObject({ ok: true, keyChecked: true });

      // Both work as App data: tiles from each run.
      const listed = await list();
      const wins = byName(listed, 'Wins by season');
      const games = byName(listed, 'Team games');
      expect(wins.capabilities.dataset).toBeDefined();
      expect(games.capabilities.dataset.grain.keyFields).toEqual(['GAME_ID', 'TEAM_ID']);
      const selection = (sourceId: string, title: string, view: 'kpi' | 'chart', query: Record<string, unknown>) => ({ sourceId, pageId: 'overview', view, title, query: { ...query, respectsGlobalFilters: true } });
      const composed = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [
          selection(wins.sourceId, 'Wins by season', 'chart', { dimensions: [{ field: 'SEASON' }], measures: [{ measure: 'WINS' }] }),
          selection(games.sourceId, 'Points by season', 'chart', { dimensions: [{ field: 'SEASON' }], measures: [{ measure: 'pts' }] }),
          selection(games.sourceId, 'Team games', 'kpi', { dimensions: [], measures: [{ measure: 'team_game_count' }] }),
        ],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const run = await call(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, { fullRun: true });
      expect(run.status, run.text).toBe(200);
      expect(run.body.tiles.map((tile: any) => ({ title: tile.title, status: tile.status, error: tile.error })).filter((tile: any) => tile.status !== 'ok')).toEqual([]);
      const tile = (title: string) => run.body.tiles.find((candidate: any) => candidate.title === title);
      expect(tile('Wins by season').result.rows.map((row: any) => [Number(row.SEASON), Number(row.WINS)])).toEqual([[2015, 10], [2016, 10]]);
      expect(tile('Points by season').result.rows.map((row: any) => [Number(row.SEASON), Number(row.pts)]).sort()).toEqual([[2015, 2110], [2016, 2310]]);
      expect(Number(tile('Team games').result.rows[0].team_game_count)).toBe(40);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
