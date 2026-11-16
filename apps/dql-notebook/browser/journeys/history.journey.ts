import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { cliEntry, repoRoot } from '../support/server';

/**
 * V15 History in the ZLens app for Snowflake, in a real browser against the built CLI: edit a certified saved
 * query, see the edit as the next version, a draft, with the banner; compare the two; restore the certified
 * version as a new draft. The certified file and its receipt never change.
 *
 * The app's server runs in this process, in Snowflake mode, with Snowflake's own parts stood in for: the
 * signed-in user header (which Snowflake's ingress sets) and the app's settings (the user, the database granted).
 * The shared server of the other journeys is open source, which has no History.
 */

const USER = 'JSMITH';
const WINS = 'blocks/nba/wins.dql';
const COMPANION = 'semantic-layer/blocks/nba/wins.yaml';
const SQL_2018 = 'SELECT season, wins FROM team_seasons WHERE season BETWEEN 2014 AND 2018';
const SQL_2019 = 'SELECT season, wins FROM team_seasons WHERE season BETWEEN 2014 AND 2019';

const source = (status: string, sql: string) => `block "wins" {\n  domain = "nba"\n  type = "custom"\n  status = "${status}"\n  description = "Wins by season"\n  owner = "${USER}"\n  query = """\n    ${sql}\n  """\n}\n`;

let workDir = '';
let server: Server | undefined;
/** Set to also save screenshots of the three screens. */
const shotsDir = process.env.ZLENS_HISTORY_SHOTS_DIR;
let baseUrl = '';
let certifiedSource = '';
let certifiedCompanion = '';

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf-8');
}

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'zlens-history-journey-'));
  const projectDir = join(workDir, 'project');
  put(projectDir, 'dql.config.json', JSON.stringify({ project: 'history', connections: { default: { driver: 'sqlite', filepath: 'main.sqlite' } } }));
  // A certified saved query: its source says certified, and its receipt names exactly that source.
  certifiedSource = source('certified', SQL_2018);
  const sha = createHash('sha256').update(certifiedSource.trimEnd() + '\n').digest('hex');
  certifiedCompanion = [
    'name: wins', 'block: wins', 'domain: nba', 'description: Wins by season', 'reviewStatus: certified',
    'certification:', `  certifiedBy: ${USER}`, "  certifiedAt: '2026-11-11T14:20:00.000Z'", '  via: block-studio', '  rules: oss', `  sourceSha256: ${sha}`, '',
  ].join('\n');
  put(projectDir, WINS, certifiedSource);
  put(projectDir, COMPANION, certifiedCompanion);

  const runtime = await import(pathToFileURL(join(dirname(cliEntry), 'local-runtime.js')).href) as { startLocalServer: (options: Record<string, unknown>) => Promise<number> };
  const settings = async (sql: string): Promise<Array<Record<string, unknown>>> => {
    if (sql.includes('GET_CONFIGURATION_VALUE')) return [{ V: USER }];
    if (sql.startsWith('SHOW TERSE DATABASES')) return [{ name: 'SALES', kind: 'STANDARD' }];
    if (sql.startsWith('SHOW TERSE SCHEMAS IN DATABASE')) return [{ name: 'PUBLIC' }];
    if (sql.startsWith('SHOW TERSE OBJECTS IN SCHEMA')) return [{ name: 'T' }];
    if (sql.startsWith('SHOW WAREHOUSES')) return [{ state: 'SUSPENDED' }];
    return [];
  };
  const port = await runtime.startLocalServer({
    rootDir: join(repoRoot, 'apps/cli/dist/assets/dql-notebook'),
    projectRoot: projectDir,
    executor: {} as never,
    preferredPort: 0,
    host: '127.0.0.1',
    snowflakeIngress: {},
    snowflakeAppSettings: { userConfiguration: 'ZLENS_USER', appName: 'ZLENS_APP', ttlMs: 60_000 },
    snowflakeAppQuery: settings,
    captureServer: (created: Server) => { server = created; },
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test.use({ extraHTTPHeaders: { 'Sf-Context-Current-User': USER } });

test('edit a certified query, see the draft with the banner, compare, restore the certified version as a new draft', async ({ page }) => {
  const projectDir = join(workDir, 'project');
  // Edit the certified saved query: saving writes the edit as a draft beside it (the certified one stays in use).
  const saved = await page.request.post(`${baseUrl}/api/block-studio/save`, {
    data: { path: WINS, source: source('certified', SQL_2019), metadata: { name: 'wins', domain: 'nba', description: 'Wins by season', owner: USER, tags: [] } },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await expect.poll(async () => (await (await page.request.get(`${baseUrl}/api/history/item?path=${encodeURIComponent(WINS)}`)).json() as { versions?: unknown[] }).versions?.length ?? 0).toBe(2);

  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
  await expect(page.getByText('Kept in your Snowflake account')).toBeVisible();
  const line = page.locator('[data-history-line="edited"]').first();
  await expect(line).toContainText(USER);
  await expect(line).toContainText('edited');
  await expect(line).toContainText('v2');
  await expect(page.locator('[data-history-line="started"]')).toContainText('ZLens');
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'history-page.png'), fullPage: true });

  // The saved query's versions: v2 is the draft edit of certified v1.
  await line.getByRole('button', { name: 'wins', exact: true }).click();
  await expect(page.getByText('v2 is an edit of certified v1 and is not certified yet. Compare the two, then certify v2 or restore v1.')).toBeVisible();
  await expect(page.locator('tr[data-version="1"]')).toContainText('Certified');
  await expect(page.locator('tr[data-version="2"]')).toContainText('Draft');
  await expect(page.locator('tr[data-version="2"]')).toContainText('Current');
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'history-item.png'), fullPage: true });

  await page.getByRole('button', { name: 'Compare v1 and v2' }).click();
  await expect(page.getByRole('heading', { name: 'Compare v1 and v2' })).toBeVisible();
  await expect(page.locator('[data-diff="removed"]')).toContainText('BETWEEN 2014 AND 2018');
  await expect(page.locator('[data-diff="added"]')).toContainText('BETWEEN 2014 AND 2019');
  await expect(page.locator('[data-version-card="1"]')).toContainText('Certified');
  await expect(page.getByRole('button', { name: 'Certify v2' })).toBeVisible();
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'history-compare.png'), fullPage: true });

  // Restore the certified v1: it comes back as v3, a draft; v1 and its receipt are unchanged.
  await page.getByRole('button', { name: 'Restore v1 as v3' }).click();
  await expect(page.getByText('Restored v1 as v3, as a draft.')).toBeVisible();
  await page.getByRole('button', { name: 'Versions' }).click();
  await expect(page.locator('tr[data-version="3"]')).toContainText('Draft');
  await expect(page.locator('tr[data-version="3"]')).toContainText('Restored v1 as v3, as a draft');
  await expect(page.locator('tr[data-version="1"]')).toContainText('Certified');
  expect(readFileSync(join(projectDir, WINS), 'utf-8')).toBe(certifiedSource);
  expect(readFileSync(join(projectDir, COMPANION), 'utf-8')).toBe(certifiedCompanion);
});

/** The same request App Studio sends, as the signed-in Snowflake user. */
async function appBuild<T>(page: import('@playwright/test').Page, method: 'POST' | 'PATCH' | 'DELETE', path: string, data: unknown): Promise<T> {
  const response = await page.request.fetch(`${baseUrl}${path}`, { method, data });
  expect([200, 201], await response.text()).toContain(response.status());
  return response.json() as Promise<T>;
}

type Draft = { id: string; appId: string; name: string; revision: number; proposalHash: string; pages: Array<{ id: string }> };

test('V3: a Describe with AI plan left unbuilt leaves nothing in History; an App compares in words at 1315 px; + Add tile does something', async ({ page }) => {
  test.setTimeout(180_000);
  // "Generate editable App", then Back to Apps: the plan is discarded, with no line in History and no trash.
  const plan = (await appBuild<{ draft: Draft }>(page, 'POST', '/api/app-builds', { goal: 'How did the Warriors do in each season', authoringMode: 'ai', template: 'operational_dashboard' })).draft;
  const left = await appBuild<{ discarded?: boolean; recoveryId: string | null }>(page, 'DELETE', `/api/app-builds/${plan.id}`, { expectedRevision: plan.revision, proposalHash: plan.proposalHash, discard: true });
  expect(left).toMatchObject({ discarded: true, recoveryId: null });
  const appLines = async () => ((await (await page.request.get(`${baseUrl}/api/history/changes?kind=app`)).json()) as { entries: unknown[] }).entries.length;
  expect(await appLines()).toBe(0);

  // An App made by hand, a text tile added, then its text changed: three versions, one per save.
  let app = (await appBuild<{ draft: Draft }>(page, 'POST', '/api/app-builds', { name: 'Warriors Wins By Season', goal: 'Wins by season', authoringMode: 'manual', template: 'blank' })).draft;
  const key = `apps/${app.appId}`;
  const versions = (count: number) => expect.poll(async () => (await (await page.request.get(`${baseUrl}/api/history/item?path=${encodeURIComponent(key)}`)).json() as { versions?: unknown[] }).versions?.length ?? 0).toBe(count);
  await versions(1);
  const pageId = app.pages[0]!.id;
  const intro = { i: 'intro', x: 0, y: 0, w: 12, h: 2, title: 'Intro', text: { markdown: 'How the Warriors did, season by season.' }, viz: { type: 'text' } };
  app = (await appBuild<{ draft: Draft }>(page, 'PATCH', `/api/app-builds/${app.id}`, { expectedRevision: app.revision, expectedProposalHash: app.proposalHash, operations: [{ type: 'add_tile', pageId, tile: intro }] })).draft;
  await versions(2);
  app = (await appBuild<{ draft: Draft }>(page, 'PATCH', `/api/app-builds/${app.id}`, { expectedRevision: app.revision, expectedProposalHash: app.proposalHash, operations: [{ type: 'update_tile', pageId, tileId: 'intro', patch: { text: { markdown: 'How the Warriors did in every season since 2014, with the playoffs.' } } }] })).draft;
  await versions(3);
  expect(await appLines()).toBe(3);

  await page.setViewportSize({ width: 1315, height: 820 });
  await page.goto(baseUrl);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const textLine = page.locator('[data-history-line="edited"]').filter({ hasText: 'Warriors Wins By Season' }).first();
  await expect(textLine).toContainText('Text changed in "Intro"');
  await textLine.getByRole('button', { name: 'Warriors Wins By Season', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select v1' }).check();
  await page.getByRole('checkbox', { name: 'Select v3' }).check();
  await page.getByRole('button', { name: 'Compare selected' }).click();
  await expect(page.getByRole('heading', { name: 'Compare v1 and v3' })).toBeVisible();

  // In words; the App's file only under Technical details, closed.
  const words = page.getByRole('region', { name: 'What changed' });
  await expect(words).toContainText('Tile added: "Intro"');
  await expect(page.getByText('studio-draft.json', { exact: false })).toBeHidden();
  const details = page.locator('details[data-technical-details]');
  await expect(details).not.toHaveAttribute('open', '');
  // No sideways scroll, and Restore is on screen.
  const restore = page.getByRole('button', { name: 'Restore v1 as v4' });
  await expect(restore).toBeVisible();
  const box = await restore.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(1315);
  const sideways = await page.evaluate(() => [...document.querySelectorAll('main, html, body')].filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.tagName));
  expect(sideways).toEqual([]);
  await details.locator('summary').click();
  await expect(details.getByText('studio-draft.json', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => [...document.querySelectorAll('main, html, body')].filter((element) => element.scrollWidth > element.clientWidth + 1).length)).toBe(0);
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'history-app-compare.png'), fullPage: true });

  // + Add tile on an App whose data is a saved query without fields: something visible happens.
  app = (await appBuild<{ draft: Draft }>(page, 'PATCH', `/api/app-builds/${app.id}`, {
    expectedRevision: app.revision, expectedProposalHash: app.proposalHash,
    operations: [{ type: 'upsert_source', source: { id: 'app:block:nba:wins', kind: 'block', sourceRef: WINS, sourcePath: WINS, trustState: 'certified', reviewStatus: 'not_required' } }],
  })).draft;
  await page.goto(`${baseUrl}/?appDraft=${app.id}`);
  await expect(page.locator('.studio-topbar')).toBeVisible({ timeout: 90_000 });
  const addTile = page.locator('button.add-tile');
  await expect(addTile).toBeVisible({ timeout: 60_000 });
  // The state the tester was in: data that is a saved query with no fields, none chosen (Add tile did nothing).
  await expect(page.locator('.data-panel')).toContainText('Choose data from this App to see its fields.');
  await addTile.click();
  // Its columns are read as fields, it is offered as a Table, Chart or KPI, or the data list opens.
  await expect(page.locator('.data-panel').getByText(/Reading the columns of|Add as it is|This App's data|Click a field to start a new tile|Building a new tile/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.studio-brand small')).toContainText(/New tile/);
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'studio-add-tile.png') });
});
