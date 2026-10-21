import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedProject } from '../global-setup';
import { repoRoot, run, startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Sort and Top N where people look (design D3), plain source names (B7) and
 * a field click after "Add to page" (B14), against the built `zlens notebook`
 * CLI on its own copy of the jaffle-supply-chain fixture with 120 customers:
 * build a bar by customer → it is sorted by spend, highest first, with
 * "Showing top 25 of 120 · Show all" → Top 10 from the measure pill's menu →
 * 10 bars → Add to page → the next field click starts a new tile → the
 * filter field list says "from Customers", never an internal ID.
 *
 * Set ZLENS_TOPN_SHOTS_DIR to also save the documentation screenshot.
 */

let workDir = '';
let server: NotebookServer | null = null;
let draftId = '';
const shotsDir = process.env.ZLENS_TOPN_SHOTS_DIR;
const CUSTOMERS = 120;

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
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-topn-'));
  const projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });

  // More customers than a bar chart shows at once. Customer 007 spends the most.
  const rows = Array.from({ length: CUSTOMERS }, (_, index) => ({
    customer_id: `C${index}`,
    customer_name: `Customer ${String(index).padStart(3, '0')}`,
    count_lifetime_orders: 1 + (index % 4),
    lifetime_spend: index === 7 ? 99_000 : 100 + index * 10,
  }));
  const seedPath = join(workDir, 'customers-seed.json');
  writeFileSync(seedPath, JSON.stringify({ tables: { dim_customers: {
    columns: [
      { name: 'customer_id', type: 'text' },
      { name: 'customer_name', type: 'text' },
      { name: 'count_lifetime_orders', type: 'int' },
      { name: 'lifetime_spend', type: 'decimal' },
    ],
    rows,
  } } }));
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  const warehouse = join(projectDir, 'jaffle_shop.duckdb');
  for (const schema of [['--schema', 'dev'], []]) {
    run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--out', warehouse, '--seed', seedPath, ...schema]);
  }
  server = await startNotebookServer({ projectDir, workDir });

  const listing = await call<{ tables: Array<{ id: string; name: string }> }>('/api/app-datasets/tables');
  const table = listing.tables.find((candidate) => candidate.name === 'dim_customers')!;
  const drafted = await call<{ proposal: { measures: Array<{ name: string; include: boolean; format: string }> } }>('/api/app-datasets/tables/draft', { tableId: table.id });
  const created = await call<{ status: string }>('/api/app-datasets/tables/create', {
    tableId: table.id,
    name: 'Customers',
    domain: 'orders',
    measures: drafted.proposal.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format })),
  });
  expect(created.status).toBe('certified');

  // A manual App whose data is the Customers Dataset, with one KPI on the page.
  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Customer Ranking', goal: 'Rank customers by spend', domain: 'orders', authoringMode: 'manual', sourcePolicy: 'governed_only', template: 'blank',
  });
  draftId = app.draft.id;
  const candidates = await call<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${draftId}/source-candidates?limit=50`);
  const customers = candidates.items.find((candidate) => candidate.name === 'Customers')!;
  await call(`/api/app-builds/${draftId}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [{ sourceId: customers.sourceId, view: 'kpi', title: 'Lifetime Spend', query: { dimensions: [], measures: [{ measure: 'lifetime_spend' }] } }],
  });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a bar by customer is sorted by spend and shows the top 25; Top 10 comes from the pill menu', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });

  // Build a bar by customer from field clicks.
  const fields = page.locator('.data-panel .field-groups');
  await fields.getByRole('button', { name: /Lifetime Spend/ }).first().click();
  await fields.getByRole('button', { name: /Customer Name/ }).first().click();
  const draft = page.locator('.studio-draft-slot, .draft-tile-card').first();
  const note = page.locator('.bar-cap-note');
  await expect(note).toContainText(`Showing top 25 of ${CUSTOMERS}`, { timeout: 60_000 });
  await expect(note.getByRole('button', { name: 'Show all' })).toBeVisible();

  // Sorted by spend, highest first: the default for a new bar chart.
  const pillMenu = page.getByRole('button', { name: 'Options for Lifetime Spend on Columns' });
  await pillMenu.click();
  await expect(page.getByRole('menuitemradio', { name: 'Sort descending by Lifetime Spend' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: 'Show top 10 by Lifetime Spend' })).toHaveAttribute('aria-checked', 'false');
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, '14-topn-pill.png') });
  }

  // "Show all" draws every customer; "Top 25" brings the cap back.
  await page.keyboard.press('Escape');
  await note.getByRole('button', { name: 'Show all' }).click();
  await expect(note).toContainText(`Showing all ${CUSTOMERS}`);
  await note.getByRole('button', { name: 'Top 25' }).click();
  await expect(note).toContainText(`Showing top 25 of ${CUSTOMERS}`);

  // Top 10 from the pill's menu: the query asks for 10 rows and 10 bars are drawn.
  await pillMenu.click();
  await page.getByRole('menuitemradio', { name: 'Show top 10 by Lifetime Spend' }).click();
  await expect(draft.getByText(/Live · 10 rows/)).toBeVisible({ timeout: 60_000 });
  await expect(note).toHaveCount(0);
  // "Filters, sort and more" shows the same choice.
  await page.locator('.studio-right summary').filter({ hasText: 'Filters, sort and more' }).click();
  await expect(page.locator('.studio-right .dataset-sort-row input[type="number"]')).toHaveValue('10');

  // Add to page, then the next field click starts a new tile.
  await page.getByRole('button', { name: 'Add to page' }).click();
  await expect(page.getByRole('group', { name: /App tile: Lifetime Spend by customer name/i })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.field-target')).toHaveText('Click a field to start a new tile.', { timeout: 60_000 });
  await fields.getByRole('button', { name: /Count Lifetime Orders/ }).first().click();
  await expect(page.locator('.field-target')).toContainText('Building a new tile');
  await expect(page.locator('.studio-right header').first()).toContainText('NEW TILE');
  await page.getByRole('button', { name: 'Cancel new tile' }).click();

  // The filter field list names the data, never an internal ID.
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  const customerName = page.locator('.filter-field-results button').filter({ hasText: 'Customer Name' });
  await expect(customerName).toContainText('from Customers');
  await expect(page.locator('.filter-field-results')).not.toContainText('::');
  // "customer name" with a space finds customer_name.
  await page.locator('.filter-field-search input').fill('customer name');
  await expect(page.locator('.filter-field-results button')).toHaveCount(1);
  await expect(page.locator('.filter-field-results button').first()).toContainText('Customer Name');

  // A selected or hovered tile's tools never cover its title or trust dot, at 1440 and 1280 wide.
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const kpi = page.getByRole('group', { name: 'App tile: Lifetime Spend', exact: true });
    await kpi.locator('header strong').click();
    await expect(page.getByRole('complementary', { name: 'Tile settings' })).toBeVisible();
    expect(await headerOverlaps(kpi)).toEqual([]);
    const bar = page.getByRole('group', { name: /App tile: Lifetime Spend by customer name/i });
    await bar.hover();
    expect(await headerOverlaps(bar)).toEqual([]);
  }
});

/** Which of the title and trust dot the visible tile tools overlap. */
async function headerOverlaps(tile: import('@playwright/test').Locator): Promise<string[]> {
  return tile.evaluate((card) => {
    const header = card.querySelector(':scope > header')!;
    const tools = [...header.querySelectorAll('.tile-tools > button')].map((node) => node.getBoundingClientRect());
    const parts: Array<[string, Element | null]> = [['title', header.querySelector('strong')], ['trust dot', header.querySelector('.trust-dot')]];
    return parts.flatMap(([name, node]) => {
      if (!node) return [];
      const box = node.getBoundingClientRect();
      const hit = tools.some((tool) => tool.left < box.right && box.left < tool.right && tool.top < box.bottom && box.top < tool.bottom);
      return hit ? [name] : [];
    });
  });
}
