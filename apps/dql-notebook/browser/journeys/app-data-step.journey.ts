import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedProject } from '../global-setup';
import { startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Choose the App's data first (design D3), against the built `zlens notebook`
 * CLI on the jaffle-supply-chain fixture: Apps → Build new App → Start manually
 * → Open blank Studio → the Data step → add one certified Dataset → Open canvas
 * → the Data pane shows it → click a measure → a new tile is drafted.
 *
 * It starts its own server on its own copy of the fixture: the certified
 * Dataset it needs would change what the shared server's journeys count.
 */

let workDir = '';
let server: NotebookServer | null = null;
const DATASET = 'Journey Customers';

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-appdata-'));
  const projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });
  server = await startNotebookServer({ projectDir, workDir });

  // One certified Dataset from a database table, through the same calls the
  // Add data "Database tables" tab makes (check, then certify).
  const base = server.baseUrl;
  const listing = await (await fetch(`${base}/api/app-datasets/tables`)).json() as { ok: boolean; tables: Array<{ id: string; name: string }>; error?: string };
  expect(listing.ok, listing.error).toBe(true);
  const table = listing.tables.find((candidate) => candidate.name === 'dim_customers');
  expect(table, JSON.stringify(listing.tables.map((candidate) => candidate.name))).toBeDefined();
  const drafted = await (await fetch(`${base}/api/app-datasets/tables/draft`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableId: table!.id }),
  })).json() as { ok: boolean; proposal?: { measures: Array<{ name: string; include: boolean; format: string }> }; error?: string };
  expect(drafted.ok, drafted.error).toBe(true);
  const created = await (await fetch(`${base}/api/app-datasets/tables/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tableId: table!.id,
      name: DATASET,
      domain: 'customers',
      measures: drafted.proposal!.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format })),
    }),
  })).json() as { ok: boolean; status?: string; error?: string; blockers?: string[] };
  expect(created.ok, created.error).toBe(true);
  expect(created.status, (created.blockers ?? []).join(' ')).toBe('certified');
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a new manual App picks its data first, then builds a tile from a measure', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(server!.baseUrl);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => {
      const inter = [...document.fonts].filter((face) => face.family.replace(/["']/g, '') === 'Inter');
      return inter.length > 0 && inter.every((face) => face.status === 'loaded');
    }), { message: 'every Inter font file has loaded' })
    .toBe(true);

  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Build new App' }).click();
  await page.getByRole('tab', { name: 'Start manually' }).click();
  await expect(page.getByRole('combobox', { name: 'Domain' })).toHaveValue('');
  await page.getByRole('button', { name: /Open blank Studio/ }).click();

  // The Data step comes before the canvas.
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Pick the data this App will use. You can add more later from the Data panel.')).toBeVisible();
  const browser = page.getByRole('region', { name: 'Add data' });
  await expect(browser.getByRole('tab', { name: /Datasets & Metrics/ })).toBeVisible();
  await expect(browser.getByRole('tab', { name: /Saved queries/ })).toBeVisible();
  await expect(browser.getByRole('tab', { name: /Database tables/ })).toBeVisible();

  await browser.getByRole('button', { name: `Add to App: ${DATASET}` }).click();
  await expect(browser.getByRole('button', { name: `Remove ${DATASET} from this App` })).toBeVisible({ timeout: 30_000 });
  const openCanvas = page.getByRole('button', { name: /Open canvas with 1 source/ });
  await expect(openCanvas).toBeVisible();
  await openCanvas.click();

  // The Data pane shows the App's data and its fields.
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toHaveCount(0);
  const dataPane = page.locator('.data-panel');
  await expect(dataPane.locator('.dataset-current')).toContainText(DATASET);
  const measures = dataPane.locator('.field-groups section').filter({ has: page.getByRole('heading', { name: 'Measures' }) });
  const firstMeasure = measures.locator('button.data-field').first();
  await expect(firstMeasure).toBeVisible();
  await firstMeasure.click();

  // Clicking a measure drafts a new tile on the canvas.
  await expect(page.getByRole('complementary', { name: 'New tile' })).toBeVisible();
  await expect(page.locator('article.draft-tile')).toBeVisible();
});

test('a saved query gets fields with Add fields, then builds tiles by its measures', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(server!.baseUrl);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Build new App' }).click();
  await page.getByRole('tab', { name: 'Start manually' }).click();
  await page.getByRole('button', { name: /Open blank Studio/ }).click();
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 30_000 });

  // A saved query has no fields until Add fields checks its columns against its rows.
  const browser = page.getByRole('region', { name: 'Add data' });
  await browser.getByRole('tab', { name: /Saved queries/ }).click();
  await browser.getByRole('button', { name: 'Add fields to Top Customers' }).click();
  const dialog = page.locator('.saved-query-fields-card');
  await expect(dialog.getByRole('heading', { name: 'Check the numbers' })).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText('Adding fields sends this saved query back for review.')).toBeVisible();
  await expect(dialog.getByText(/Each row is one/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Check and add fields' }).click();
  await expect(dialog.getByRole('heading', { name: 'Fields added' })).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText('Top Customers has fields now and is certified: its checks passed.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Use its fields' }).click();

  // It is a certified Dataset now: listed with Datasets & Metrics, with Measures.
  await expect(browser.getByRole('tab', { name: /Datasets & Metrics/ })).toHaveAttribute('aria-selected', 'true');
  const row = browser.locator('article.add-data-row').filter({ hasText: 'Top Customers' });
  await expect(row).toContainText('Dataset · Certified');
  await expect(row.getByRole('heading', { name: 'Measures' })).toBeVisible();
  await browser.getByRole('button', { name: 'Add to App: Top Customers' }).click();
  await page.getByRole('button', { name: /Open canvas with 1 source/ }).click();
  const dataPane = page.locator('.data-panel');
  await expect(dataPane.locator('.dataset-current')).toContainText('Top Customers');
  await expect(dataPane.locator('.field-groups').getByRole('heading', { name: 'Measures' })).toBeVisible();
});
