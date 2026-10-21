import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedProject } from '../global-setup';
import { startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Honest when no AI is connected (design D4, on top of D3's AI path), against
 * the built `zlens notebook` CLI on the jaffle-supply-chain fixture:
 * Apps → Build new App opens on Start manually → Describe with AI asks to
 * connect a provider → Try keyword suggestions → the Data step says
 * "Suggested from keywords · no AI connected" (never "AI picked") with a Why
 * line and the unmatched part under "Not covered yet" → Build pages → the
 * canvas review is labelled Keyword suggestions → Back to data and back →
 * Apply → Publish is not blocked by the unmatched part.
 *
 * No AI provider is configured, so the server's keyword planner answers;
 * nothing reaches a model. It starts its own server on its own copy of the
 * fixture, with one extra certified Dataset for the keywords to match.
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
  // Add data list makes for a database table (check, then certify).
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

test('without AI, keyword suggestions say so in the Data step and the tile review, and never block publishing', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(server!.baseUrl);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Build new App' }).click();
  // With no AI provider the form opens on Start manually.
  await expect(page.getByRole('tab', { name: 'Start manually' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Describe with AI' })).toHaveAttribute('aria-selected', 'false');

  // Describe with AI asks to connect a provider first; keyword suggestions are the labelled second choice.
  await page.getByRole('tab', { name: 'Describe with AI' }).click();
  await expect(page.getByText('Connect an AI provider to describe an App')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect an AI provider' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Generate editable App/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try keyword suggestions' }).click();
  await expect(page.getByText('Suggested from keywords · no AI connected')).toBeVisible();

  // The example request is a placeholder, not text a request is appended to.
  const describe = page.getByRole('textbox', { name: 'What decision should this App support?' });
  await expect(describe).toHaveValue('');
  await expect(describe).toHaveAttribute('placeholder', /\S/);
  await describe.fill('Journey customers overview for the sales team\nKeep it short and clear.');
  await page.getByRole('button', { name: /Suggest from keywords/ }).click();

  // The Data step says the sources were matched on keywords, with each match's reason.
  const heading = page.getByRole('heading', { name: 'Suggested from keywords · no AI connected' });
  await expect(heading).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: /^AI picked/ })).toHaveCount(0);
  await expect(page.getByText('For:')).toBeVisible();
  await expect(page.getByText(/No AI chose them/)).toBeVisible();
  await expect(page.getByText('Notes from AI')).toHaveCount(0);
  const picks = page.getByRole('list', { name: 'Keyword suggestions' });
  await expect(picks.locator('li').first()).toBeVisible();
  await expect(picks.getByText(/^Why: /).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Add data' })).toBeVisible();
  // The part no source matched is a note, not a publish blocker.
  const notCovered = page.getByRole('region', { name: 'Not covered yet' });
  await expect(notCovered.getByText('They are notes, not publish blockers', { exact: false })).toBeVisible();

  const buildPages = page.getByRole('button', { name: /Build pages with \d+ sources?/ });
  await expect(buildPages).toBeEnabled();
  await buildPages.click();

  // The canvas review is labelled as keyword suggestions, never as an AI proposal.
  const review = page.getByRole('complementary', { name: 'Keyword suggestions' });
  await expect(review.getByRole('heading', { name: 'Review the tiles' })).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText('KEYWORD SUGGESTIONS')).toBeVisible();
  await expect(review.getByText('Suggested from keywords · no AI connected')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'AI proposal' })).toHaveCount(0);
  await expect(review.getByText('Selected for this App')).toHaveCount(0);
  await expect(page.locator('.proposal-tile').first()).toBeVisible();
  await expect(review.getByRole('button', { name: /^Apply \d+ changes?$/ })).toBeVisible();

  // Back to data returns to the suggestions while the tiles are not applied.
  await review.getByRole('button', { name: 'Back to data' }).click();
  await expect(heading).toBeVisible();
  await page.getByRole('button', { name: /Build pages with \d+ sources?/ }).click();
  await expect(review.getByRole('heading', { name: 'Review the tiles' })).toBeVisible();

  // Apply adds the tiles and their data to the App.
  await review.getByRole('button', { name: /^Apply \d+ changes?$/ }).click();
  await expect(page.getByRole('complementary', { name: 'Keyword suggestions' })).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.studio-page-grid .studio-component-card').first()).toBeVisible();
  await expect(page.locator('.proposal-tile')).toHaveCount(0);
  // The App is named from the first line of the request, and the name stays editable.
  await expect(page.getByRole('textbox', { name: 'App name' })).toHaveValue('Journey customers overview for the sales team');
  await expect(page.getByRole('textbox', { name: 'App name' })).toBeEditable();

  // Without AI, the Studio's entry point offers keyword suggestions, labelled.
  await expect(page.getByRole('button', { name: 'Suggest tiles' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ask AI', exact: true })).toHaveCount(0);

  // Publishing is not blocked by the part the keywords did not match.
  await page.getByRole('button', { name: /^Review and publish to Project/ }).click();
  await expect(page.getByText('Ready to publish')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Unanswered App question')).toHaveCount(0);
});
