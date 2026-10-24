import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedProject } from '../global-setup';
import { repoRoot, run, startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Without AI, a new App starts from three quick choices (round-2 design Q2),
 * against the built `zlens notebook` CLI on its own copy of the
 * jaffle-supply-chain fixture, with Orders (dated) and Customers checked as
 * certified data in the Sales Domain:
 * Apps → Build new App opens on Quick start (no Describe with AI tab, no free
 * text, no keyword suggestions) → Choose data → add Orders and Customers →
 * Next: choose tiles → Total of Order Total, Order Total by month, Top 10
 * Customer Name by Lifetime Spend → Build App → exactly three tiles with
 * plain titles, the App named "Sales overview" → Quick tiles on the canvas
 * opens the same choices → Publish is not blocked.
 *
 * No AI provider is configured; nothing reaches a model. Set
 * ZLENS_QUICK_SHOTS_DIR to also save the documentation screenshot.
 */

let workDir = '';
let server: NotebookServer | null = null;
const shotsDir = process.env.ZLENS_QUICK_SHOTS_DIR;
const CUSTOMERS = 14;
const NO_PROVIDER: NodeJS.ProcessEnv = {
  ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', ZLENS_OPENAI_COMPAT_API_KEY: '',
  OLLAMA_BASE_URL: '', OLLAMA_MODEL: '', ZLENS_EVAL_CASSETTE_DIR: '', ZLENS_EVAL_CASSETTE_MODE: '',
};

type DraftTile = { i: string; title?: string; viz: { type: string }; query?: { dimensions: Array<{ field: string; timeGrain?: string }>; measures: Array<{ measure: string }>; limit?: number; orderBy?: Array<{ alias: string; direction: string }> } };
type Draft = { id: string; name: string; pages: Array<{ layout: { items: DraftTile[] } }> };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${server!.baseUrl}${path}`, body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 800)}`);
  return JSON.parse(text) as T;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-quick-'));
  const projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });

  // Customers with a lifetime spend, and dated orders. Customer 003 spends the most.
  const customers = Array.from({ length: CUSTOMERS }, (_, index) => ({
    customer_id: `C${index}`,
    customer_name: `Customer ${String(index).padStart(3, '0')}`,
    lifetime_spend: index === 3 ? 9_000 : 100 + index * 10,
  }));
  const orders = Array.from({ length: 30 }, (_, index) => ({
    order_id: `O${index}`,
    customer_id: `C${index % CUSTOMERS}`,
    ordered_at: `2026-0${1 + (index % 3)}-${String(1 + (index % 27)).padStart(2, '0')} 10:00:00`,
    // A yes/no count before the money column: the first summed measure, never the default (new-user round 2, problem 8).
    count_drink_items: index % 2,
    order_total: 10 + index,
  }));
  const seedPath = join(workDir, 'quick-seed.json');
  writeFileSync(seedPath, JSON.stringify({ tables: {
    dim_customers: {
      columns: [{ name: 'customer_id', type: 'text' }, { name: 'customer_name', type: 'text' }, { name: 'lifetime_spend', type: 'decimal' }],
      rows: customers,
    },
    orders: {
      columns: [{ name: 'order_id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'ordered_at', type: 'timestamp' }, { name: 'count_drink_items', type: 'int' }, { name: 'order_total', type: 'decimal' }],
      rows: orders,
    },
  } }));
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  const warehouse = join(projectDir, 'jaffle_shop.duckdb');
  for (const schema of [['--schema', 'dev'], []]) {
    run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--out', warehouse, '--seed', seedPath, ...schema]);
  }
  server = await startNotebookServer({ projectDir, workDir, env: NO_PROVIDER });

  // Orders and Customers become certified data through the calls Add data's "Check and use" and
  // "I vouch for this — certify" make (design Q1: checking alone leaves data Not certified yet).
  const listing = await call<{ ok: boolean; tables: Array<{ id: string; name: string }> }>('/api/app-datasets/tables');
  for (const [table, name] of [['orders', 'Orders'], ['dim_customers', 'Customers']] as const) {
    const found = listing.tables.find((candidate) => candidate.name === table);
    expect(found, JSON.stringify(listing.tables.map((candidate) => candidate.name))).toBeDefined();
    const drafted = await call<{ proposal: { measures: Array<{ name: string; include: boolean; format: string }> } }>('/api/app-datasets/tables/draft', { tableId: found!.id });
    const created = await call<{ status: string; sourceId: string; blockers?: string[] }>('/api/app-datasets/tables/create', {
      tableId: found!.id,
      name,
      domain: 'sales',
      measures: drafted.proposal.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format })),
    });
    expect(created.status, (created.blockers ?? []).join(' ')).toBe('checked');
    expect((await call<{ status: string }>('/api/app-datasets/certify', { sourceId: created.sourceId })).status).toBe('certified');
  }
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('without AI, three quick choices build exactly those tiles with plain titles, and publishing is allowed', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server!.baseUrl);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Build new App' }).click();

  // With no AI provider the form opens on Quick start: no Describe with AI, no free text, no keyword suggestions.
  await expect(page.getByRole('tab', { name: 'Quick start' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Describe with AI' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'What decision should this App support?' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try keyword suggestions' })).toHaveCount(0);
  await expect(page.getByText(/keyword/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect an AI provider to describe an App in your own words' })).toBeVisible();
  // The name is left empty: Build App names it after the data's Domain.
  await expect(page.getByRole('textbox', { name: 'What should this App be called?' })).toHaveValue('');
  await page.getByRole('button', { name: 'Choose data' }).click();

  // The Data step first: add Orders and Customers.
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 60_000 });
  const next = page.getByRole('button', { name: 'Next: choose tiles' });
  await expect(next).toBeDisabled();
  const addData = page.getByRole('region', { name: 'Add data' });
  for (const name of ['Orders', 'Customers']) {
    await addData.getByRole('button', { name: `Add to App: ${name}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `Remove ${name} from this App` }).first()).toBeVisible({ timeout: 30_000 });
  }
  await expect(next).toBeEnabled();
  await next.click();

  // What should this App show? A KPI, a trend and a top list, picked from this App's data.
  await expect(page.getByRole('heading', { name: 'What should this App show?' })).toBeVisible();
  await expect(page.getByText('No AI is used', { exact: false })).toBeVisible();
  const tiles = page.getByRole('list', { name: 'Tiles to build' });
  await expect(tiles.getByRole('listitem')).toHaveCount(3);
  await expect(tiles.getByRole('listitem').nth(0)).toHaveAttribute('aria-label', 'Tile 1: KPI');
  await expect(tiles.getByRole('listitem').nth(1)).toHaveAttribute('aria-label', 'Tile 2: Trend');
  await expect(tiles.getByRole('listitem').nth(2)).toHaveAttribute('aria-label', 'Tile 3: Top');
  // The defaults lead with money (new-user round 2, problem 8): Order Total, by month, and the top
  // customers by name ranked by a money measure, never "Count Drink Items".
  await expect(page.getByRole('combobox', { name: 'Tile 1: measure' }).locator('option:checked')).toHaveText('Order Total');
  await expect(page.getByRole('combobox', { name: 'Tile 2: measure' }).locator('option:checked')).toHaveText('Order Total');
  await expect(page.getByRole('combobox', { name: 'Tile 2: time grain' })).toHaveValue('month');
  await expect(page.getByRole('combobox', { name: 'Tile 3: rank' }).locator('option:checked')).toHaveText('Customer Name');
  await expect(page.getByRole('combobox', { name: 'Tile 3: measure' }).locator('option:checked')).toHaveText(/^(Order Total|Lifetime Spend)$/);
  await expect(tiles).not.toContainText('Count Drink Items by');
  await page.getByRole('combobox', { name: 'Tile 1: measure' }).selectOption({ label: 'Order Total' });
  await page.getByRole('combobox', { name: 'Tile 2: measure' }).selectOption({ label: 'Order Total' });
  await page.getByRole('combobox', { name: 'Tile 2: time grain' }).selectOption('month');
  await page.getByRole('combobox', { name: 'Tile 3: how many' }).selectOption('10');
  await page.getByRole('combobox', { name: 'Tile 3: rank' }).selectOption({ label: 'Customer Name' });
  await page.getByRole('combobox', { name: 'Tile 3: measure' }).selectOption({ label: 'Lifetime Spend' });
  // Each row says the title its tile gets, in words.
  await expect(tiles.getByText('Title:')).toHaveCount(3);
  await expect(tiles.getByRole('listitem').nth(0)).toContainText('Title: Order Total');
  await expect(tiles.getByRole('listitem').nth(1)).toContainText('Title: Order Total by month');
  await expect(tiles.getByRole('listitem').nth(2)).toContainText('Title: Top 10 customers by Lifetime Spend');
  await expect(page.getByRole('button', { name: 'Add a Trend tile' })).toBeEnabled();
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, '19-quick-choices.png') });
  }
  await page.getByRole('button', { name: 'Build App' }).click();

  // Exactly the three tiles chosen, with their titles, and the App named after its Domain.
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
  const cards = page.locator('.studio-page-grid .studio-component-card');
  await expect(cards).toHaveCount(3);
  for (const title of ['Order Total', 'Order Total by month', 'Top 10 customers by Lifetime Spend']) {
    await expect(page.locator('.studio-page-grid').getByText(title, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('textbox', { name: 'App name' })).toHaveValue('Sales overview');

  // Saved as ordinary field tiles: a single value, a monthly line, a bar of the top 10 by spend.
  const { drafts } = await call<{ drafts: Draft[] }>('/api/app-builds');
  const draft = drafts.find((candidate) => candidate.name === 'Sales overview');
  expect(draft, drafts.map((candidate) => candidate.name).join(', ')).toBeDefined();
  const saved = draft!.pages[0]!.layout.items.filter((item) => item.query).sort((left, right) => (left.title ?? '').localeCompare(right.title ?? ''));
  expect(saved.map((item) => [item.title, item.viz.type])).toEqual([
    ['Order Total', 'single_value'],
    ['Order Total by month', 'line'],
    ['Top 10 customers by Lifetime Spend', 'bar'],
  ]);
  expect(saved[1]!.query!.dimensions).toEqual([{ field: 'ordered_at', timeGrain: 'month' }]);
  expect(saved[2]!.query).toMatchObject({ dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }], limit: 10, orderBy: [{ alias: 'lifetime_spend', direction: 'desc' }] });

  // On the canvas, the toolbar's Quick tiles opens the same choices for this page; there is no Ask AI or keyword suggestions.
  await expect(page.getByRole('button', { name: 'Ask AI', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Suggest tiles' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Quick tiles' }).click();
  const panel = page.getByRole('complementary', { name: 'Quick tiles' });
  await expect(panel.getByRole('list', { name: 'Tiles to build' })).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Add \d+ tiles? to page$/ })).toBeVisible();
  await panel.getByRole('button', { name: 'Close quick tiles' }).click();
  await expect(panel).toHaveCount(0);

  // Publishing is allowed.
  await page.getByRole('button', { name: /^Review and publish to Project/ }).click();
  await expect(page.getByText('Ready to publish')).toBeVisible({ timeout: 60_000 });
});
