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
