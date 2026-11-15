import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedProject } from '../global-setup';
import { repoRoot, run, startNotebookServer, type NotebookServer } from '../support/server';

/**
 * A line over seasons is drawn in season order (V13 retest, B7), against the built `zlens notebook` CLI on its
 * own copy of the jaffle-supply-chain fixture with the Warriors' regular-season wins 2014–2018: an App tile of
 * wins by season, drawn as a line sorted by wins (the tester's applied App drew 2018, 2017, 2014, 2016, 2015,
 * a rise that never happened) → the chart's season labels read 2014 to 2018 left to right, and its points
 * follow them.
 */

let workDir = '';
let server: NotebookServer | null = null;
let draftId = '';
const WINS: Array<[number, number]> = [[2018, 57], [2017, 58], [2014, 67], [2016, 67], [2015, 73]];

async function call<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`${server!.baseUrl}${path}`, body === undefined
    ? {}
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 800)}`);
  return JSON.parse(text) as T;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-season-line-'));
  const projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });

  // The rows in the order a saved query sorted by wins returns them.
  const seedPath = join(workDir, 'seasons-seed.json');
  writeFileSync(seedPath, JSON.stringify({ tables: { warriors_seasons: {
    columns: [{ name: 'team_season_id', type: 'text' }, { name: 'season', type: 'int' }, { name: 'wins', type: 'int' }],
    rows: WINS.map(([season, wins]) => ({ team_season_id: `GSW-${season}`, season, wins })),
  } } }));
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  const warehouse = join(projectDir, 'jaffle_shop.duckdb');
  for (const schema of [['--schema', 'dev'], []]) {
    run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--out', warehouse, '--seed', seedPath, ...schema]);
  }
  server = await startNotebookServer({ projectDir, workDir });

  const listing = await call<{ tables: Array<{ id: string; name: string }> }>('/api/app-datasets/tables');
  const table = listing.tables.find((candidate) => candidate.name === 'warriors_seasons');
  expect(table, listing.tables.map((candidate) => candidate.name).join(', ')).toBeDefined();
  const drafted = await call<{ proposal: { measures: Array<{ name: string; include: boolean; format: string }> } }>('/api/app-datasets/tables/draft', { tableId: table!.id });
  const created = await call<{ status: string; sourceId: string; blockers?: string[] }>('/api/app-datasets/tables/create', {
    tableId: table!.id,
    name: 'Warriors seasons',
    domain: 'nba',
    measures: drafted.proposal.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format })),
  });
  expect(created.status, (created.blockers ?? []).join(' ')).toBe('checked');
  expect((await call<{ status: string }>('/api/app-datasets/certify', { sourceId: created.sourceId })).status).toBe('certified');

  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Warriors by season', goal: 'Warriors wins by season', domain: 'nba', authoringMode: 'manual', template: 'blank',
  });
  draftId = app.draft.id;
  const candidates = await call<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${draftId}/source-candidates?limit=50`);
  const seasons = candidates.items.find((candidate) => candidate.name === 'Warriors seasons')!;
  const composed = await call<{ draft: { id: string; revision: number; proposalHash: string; pages: Array<{ id: string; layout: { items: Array<{ i: string; title?: string }> } }> } }>(`/api/app-builds/${draftId}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [{ sourceId: seasons.sourceId, view: 'chart', title: 'Warriors Wins by Season', query: { dimensions: [{ field: 'season' }], measures: [{ measure: 'wins' }] } }],
  });
  // Drawn as the tester's App drew it: a line, sorted by wins, the last point labelled.
  const page = composed.draft.pages[0]!;
  const tile = page.layout.items.find((item) => item.title === 'Warriors Wins by Season')!;
  await call(`/api/app-builds/${draftId}`, {
    expectedRevision: composed.draft.revision,
    expectedProposalHash: composed.draft.proposalHash,
    operations: [{ type: 'update_tile', pageId: page.id, tileId: tile.i, patch: { viz: { type: 'line', style: { sort: 'asc', labels: 'last' } } } }],
  }, 'PATCH');
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a line of wins over seasons reads 2014 to 2018 left to right, though it is sorted by wins', async ({ page }) => {
  test.setTimeout(180_000);
  // The tile is stored as the tester's was: a line sorted by its values.
  const { drafts } = await call<{ drafts: Array<{ id: string; pages: Array<{ layout: { items: Array<{ title?: string; viz: { type: string; style?: { sort?: string } } }> } }> }> }>('/api/app-builds');
  const stored = drafts.find((draft) => draft.id === draftId)!.pages[0]!.layout.items.find((item) => item.title === 'Warriors Wins by Season')!;
  expect(stored.viz).toMatchObject({ type: 'line', style: { sort: 'asc' } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
  const chart = page.getByRole('group', { name: /App tile: Warriors Wins by Season/i });
  await expect(chart.locator('svg').first()).toBeVisible({ timeout: 60_000 });
  // The season labels on the axis, in the order they are drawn left to right.
  const seasons = async () => chart.locator('svg text').evaluateAll((nodes) => nodes
    .filter((node) => /^20\d\d$/.test((node.textContent ?? '').trim()))
    .map((node) => ({ text: (node.textContent ?? '').trim(), x: node.getBoundingClientRect().left }))
    .sort((left, right) => left.x - right.x)
    .map((label) => label.text));
  await expect.poll(seasons, { timeout: 30_000 }).toEqual(['2014', '2015', '2016', '2017', '2018']);
  // The last point is 2018's 57, labelled: the line ends where the Warriors' wins ended, not at their best.
  await expect(chart.locator('svg text').filter({ hasText: /^57$/ })).toHaveCount(1);
});
