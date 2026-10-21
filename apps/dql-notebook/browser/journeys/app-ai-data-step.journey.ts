import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedProject } from '../global-setup';
import { startNotebookServer, type NotebookServer } from '../support/server';

/**
 * AI shows the data it picked before building pages (design D3, AI path),
 * against the built `zlens notebook` CLI on the jaffle-supply-chain fixture:
 * Apps → Build new App → Describe with AI → Generate editable App → the Data
 * step lists AI's picks with a Why line → Build pages → the canvas shows the
 * proposed tiles with Review the tiles → Back to data and back → Apply.
 *
 * No AI provider is configured, so the server's deterministic planner answers
 * (the review says "Deterministic planner fallback"); nothing reaches a model.
 * It starts its own server on its own copy of the fixture, with one extra
 * certified Dataset for AI to pick.
 */

let workDir = '';
let server: NotebookServer | null = null;
const DATASET = 'Journey Customers';
const NO_PROVIDER: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', ZLENS_OPENAI_COMPAT_API_KEY: '',
  OLLAMA_BASE_URL: '', OLLAMA_MODEL: '', ZLENS_EVAL_CASSETTE_DIR: '', ZLENS_EVAL_CASSETTE_MODE: '',
};

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-aidata-'));
  const projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });
  server = await startNotebookServer({ projectDir, workDir, env: NO_PROVIDER });

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

test('AI shows the data it picked in the Data step, then builds pages for tile review', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto(server!.baseUrl);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Build new App' }).click();
  await page.getByRole('tab', { name: 'Describe with AI' }).click();
  // The example request is a placeholder, not text a request is appended to.
  const describe = page.getByRole('textbox', { name: 'What decision should this App support?' });
  await expect(describe).toHaveValue('');
  await expect(describe).toHaveAttribute('placeholder', /\S/);
  await describe.fill('Journey customers overview for the sales team\nKeep it short and clear.');
  await page.getByRole('button', { name: /Generate editable App/ }).click();

  // The Data step shows what AI picked, with the planner's reason, before any page is built.
  const heading = page.getByRole('heading', { name: /^AI picked \d+ sources?$/ });
  await expect(heading).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('For:')).toBeVisible();
  await expect(page.getByText('Check the data before AI builds pages. Remove anything you don’t trust.')).toBeVisible();
  await expect(page.getByText('Deterministic planner fallback')).toBeVisible();
  const picks = page.getByRole('list', { name: 'AI picks' });
  await expect(picks.locator('li').first()).toBeVisible();
  await expect(picks.getByText(/^Why: /).first()).toBeVisible();
  await expect(picks.getByText(/^Creates \d+ tiles?$/).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Add data' })).toBeVisible();

  const buildPages = page.getByRole('button', { name: /Build pages with \d+ sources?/ });
  await expect(buildPages).toBeEnabled();
  await buildPages.click();

  // The canvas shows the proposed tiles; the review keeps only the tile part.
  const review = page.getByRole('complementary', { name: 'AI proposal' });
  await expect(review.getByRole('heading', { name: 'Review the tiles' })).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText('Selected for this App')).toHaveCount(0);
  await expect(page.locator('.proposal-tile').first()).toBeVisible();
  await expect(review.getByRole('button', { name: /^Apply \d+ changes?$/ })).toBeVisible();

  // Back to data returns to AI's picks while the tiles are not applied.
  await review.getByRole('button', { name: 'Back to data' }).click();
  await expect(heading).toBeVisible();
  await page.getByRole('button', { name: /Build pages with \d+ sources?/ }).click();
  await expect(review.getByRole('heading', { name: 'Review the tiles' })).toBeVisible();

  // Apply adds the tiles and their data to the App.
  await review.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await expect(page.getByRole('complementary', { name: 'AI proposal' })).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.studio-page-grid .studio-component-card').first()).toBeVisible();
  await expect(page.locator('.proposal-tile')).toHaveCount(0);
  // The App is named from the first line of the request, and the name stays editable.
  await expect(page.getByRole('textbox', { name: 'App name' })).toHaveValue('Journey customers overview for the sales team');
  await expect(page.getByRole('textbox', { name: 'App name' })).toBeEditable();
});
