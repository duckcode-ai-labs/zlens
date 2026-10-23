import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startNotebookServer, type NotebookServer } from '../support/server';
import { writeDbtShop } from '../support/dbt-shop';

/**
 * Round-3 new-user review, the UI and state problems, against the built
 * `zlens notebook` CLI on the dbt-style shop, with no AI provider:
 *   1. a new App built in the UI is on the Apps list as soon as you go Back,
 *      without a reload, and the list says "Not published yet" for it — one
 *      wording, counters that count the cards;
 *   6. no "Edit with AI" / "Change with AI" on tiles, and the reader's Ask box
 *      says "Ask needs an AI provider" instead of answering "AI-generated ·
 *      Refused";
 *  10. a field click never shows the previous query's result as the new
 *      chart ("Live · 1 row"), a click right after "Add to page" starts the
 *      next tile instead of changing this one, the new tile is scrolled into
 *      view, and a reader's filter change re-runs only the tiles it reaches.
 *
 * It starts its own server on its own project.
 */

let workDir = '';
let server: NotebookServer | null = null;
let draftId = '';

async function call<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`${server!.baseUrl}${path}`, body === undefined
    ? {}
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 800)}`);
  return JSON.parse(text) as T;
}

type DraftTile = { i: string; title?: string; viz: { type: string }; query?: { dimensions: Array<{ field: string }>; measures: Array<{ measure: string }> } };
async function draftTiles(): Promise<DraftTile[]> {
  const { drafts } = await call<{ drafts: Array<{ id: string; pages: Array<{ layout: { items: DraftTile[] } }> }> }>('/api/app-builds');
  return drafts.find((draft) => draft.id === draftId)?.pages[0]?.layout.items ?? [];
}

async function openStudio(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
}

async function inViewport(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.height > 0 && box.top < window.innerHeight && box.bottom > 0;
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-round3-'));
  const projectDir = join(workDir, 'dbt-shop');
  writeDbtShop(projectDir, workDir);
  server = await startNotebookServer({ projectDir, workDir });
  // The journey is about what a person sees with no AI provider.
  const providers = await call<{ assistAvailable?: boolean; providers?: Array<{ enabled?: boolean; configured?: boolean }> }>('/api/settings/providers');
  expect(providers.assistAvailable ?? (providers.providers ?? []).some((provider) => provider.enabled && provider.configured)).toBe(false);

  const listing = await call<{ tables: Array<{ id: string; name: string }> }>('/api/app-datasets/tables');
  for (const name of ['orders', 'customers']) {
    const table = listing.tables.find((candidate) => candidate.name === name)!;
    const created = await call<{ status: string }>('/api/app-datasets/tables/create', { tableId: table.id, name: name === 'orders' ? 'Orders' : 'Customers', domain: 'shop' });
    expect(created.status).toBe('checked');
  }
  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Sales Review', goal: 'Orders and customers', domain: 'shop', authoringMode: 'manual', template: 'blank',
  });
  draftId = app.draft.id;
  const candidates = await call<{ items: Array<{ sourceId: string; name: string; capabilities: { dataset?: { fields: Array<{ name: string; kind: string; aggregation?: string }> } } }> }>(`/api/app-builds/${draftId}/source-candidates?limit=50`);
  const orders = candidates.items.find((item) => item.name === 'Orders')!;
  const customers = candidates.items.find((item) => item.name === 'Customers')!;
  const customerCount = customers.capabilities.dataset!.fields.find((field) => field.kind === 'measure' && field.aggregation === 'count_distinct')!.name;
  // Enough tiles that the page scrolls: the trend on Orders, the rest on Customers.
  await call(`/api/app-builds/${draftId}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [
      { sourceId: orders.sourceId, view: 'chart', title: 'Orders trend', query: { dimensions: [{ field: 'ordered_at', timeGrain: 'month' }], measures: [{ measure: 'order_total' }] } },
      { sourceId: customers.sourceId, view: 'chart', title: 'Customers by name', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: customerCount }] } },
      { sourceId: customers.sourceId, view: 'kpi', title: 'Customer count', query: { dimensions: [], measures: [{ measure: customerCount }] } },
      { sourceId: customers.sourceId, view: 'table', title: 'Customer list', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: customerCount }] } },
      { sourceId: customers.sourceId, view: 'chart', title: 'Customers again', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: customerCount }] } },
    ],
  });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a new App is on the Apps list as soon as you go Back, with one wording for unpublished Apps', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?view=apps`);
  await expect(page.getByRole('heading', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });
  const launcher = page.locator('#app-studio-launcher');
  if (!(await launcher.isVisible())) await page.getByRole('button', { name: 'Build new App' }).click();
  await launcher.getByRole('tab', { name: 'Start manually' }).click();
  await launcher.getByPlaceholder('Revenue Operations').fill('Sales Manager Manual');
  await launcher.getByRole('button', { name: /^Continue to data/ }).click();
  await page.getByRole('button', { name: 'Skip, start empty' }).click();
  // A new App says "Not published yet" in Studio, never "Unpublished changes" or "local draft".
  await expect(page.locator('.studio-brand small')).toHaveText(/^(Saved · )?Not published yet \(only you can see it\)$/, { timeout: 30_000 });

  await page.locator('.studio-brand').getByRole('button', { name: 'Back to Apps' }).click();
  // No reload: the card is there at once.
  const card = page.locator('article.dql-app-card').filter({ hasText: 'Sales Manager Manual' });
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator('.dql-app-seal').first()).toHaveText('Not published yet');
  await expect(card).toContainText('Only you');
  // One wording, and the counters count what the cards show (Sales Review is the other new App).
  const summary = page.getByLabel('App library summary');
  await expect(summary).toContainText('2 not published yet');
  await expect(page.locator('.dql-apps-filter-tabs button').filter({ hasText: 'Not published yet' })).toContainText('2');
  await expect(page.locator('main.dql-apps-wrap')).not.toContainText(/local drafts?|Private draft/i);
  await expect(page.locator('article.dql-app-card').filter({ hasText: /Not published yet/ })).toHaveCount(2);
});

test('no AI controls without an AI provider: no Edit with AI or Change with AI on tiles', async ({ page }) => {
  test.setTimeout(150_000);
  await openStudio(page);
  const tiles = page.locator('article.studio-component-card[data-tile-id]');
  await expect(tiles.first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit with AI' })).toHaveCount(0);
  const first = tiles.first();
  await first.hover();
  await first.getByRole('button', { name: 'Tile actions' }).click();
  const menu = first.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Tile settings/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /with AI|Ask about this tile/ })).toHaveCount(0);
  // Quick tiles, the no-AI way to add tiles, stays.
  await expect(page.getByRole('button', { name: 'Quick tiles' })).toBeVisible();
});

test('field clicks: no stale chart, a click after Add to page starts the next tile, and the new tile is scrolled into view', async ({ page }) => {
  test.setTimeout(180_000);
  await openStudio(page);
  const before = new Set((await draftTiles()).map((tile) => tile.i));
  // The author is at the bottom of the page.
  await page.locator('.studio-workspace').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const panel = page.locator('.data-panel');
  await panel.locator('.dataset-current').click();
  await page.getByRole('menuitemradio', { name: /^Orders/ }).click();
  const fields = panel.locator('.field-groups');
  await fields.getByRole('button', { name: /Order Total/ }).first().click();
  const draft = page.locator('.draft-tile');
  await expect(draft.locator('.draft-status')).toContainText('Live · 1 row', { timeout: 30_000 });
  // The tile being built is where the author can see it.
  await expect.poll(() => inViewport(draft), { timeout: 10_000 }).toBe(true);

  // Watch the status from the click on: the KPI's single row is never shown as the trend.
  await page.evaluate(() => {
    const samples: string[] = [];
    (window as unknown as { __r3Samples: string[] }).__r3Samples = samples;
    // Sampling starts once the click has been handled (React commits a click before the next task).
    document.addEventListener('click', () => {
      window.setTimeout(() => {
        const timer = window.setInterval(() => {
          samples.push(document.querySelector('.draft-tile .draft-status')?.textContent ?? '');
          if (samples.length > 200) window.clearInterval(timer);
        }, 20);
      }, 0);
    }, { capture: true, once: true });
  });
  await fields.getByRole('button', { name: /^Ordered At/ }).first().click();
  await expect(draft.locator('.draft-status')).toContainText('Live · 3 rows', { timeout: 30_000 });
  const samples = await page.evaluate(() => (window as unknown as { __r3Samples: string[] }).__r3Samples.slice());
  expect(samples.length).toBeGreaterThan(3);
  expect(samples.filter((sample) => /Live · 1 row\b/.test(sample))).toEqual([]);

  // Add to page: the new tile is scrolled into view wherever it lands.
  await page.getByRole('button', { name: 'Add to page' }).click();
  await expect.poll(async () => (await draftTiles()).filter((tile) => !before.has(tile.i)).length, { timeout: 60_000 }).toBe(1);
  const added = (await draftTiles()).find((tile) => !before.has(tile.i))!;
  expect(added.query?.dimensions.map((dimension) => dimension.field)).toEqual(['ordered_at']);
  // The add keeps the chart the author built: a date reads as a line.
  await expect.poll(async () => (await draftTiles()).find((tile) => tile.i === added.i)?.viz.type, { timeout: 30_000 }).toBe('line');
  const addedCard = page.locator(`article.studio-component-card[data-tile-id="${added.i}"]`);
  await expect(addedCard).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => inViewport(addedCard), { timeout: 10_000 }).toBe(true);
  const addedType = 'line';

  // A KPI, then Add to page and a field click right away: the click starts the
  // next tile; it never lands on the KPI being added (it used to turn it into a bar chart).
  const known = new Set((await draftTiles()).map((tile) => tile.i));
  await fields.getByRole('button', { name: /Order Total/ }).first().click();
  await expect(draft.locator('.draft-status')).toContainText('Live · 1 row', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Add to page' }).click();
  await fields.getByRole('button', { name: /Order Total/ }).first().click();
  await expect.poll(async () => (await draftTiles()).filter((tile) => !known.has(tile.i)).length, { timeout: 60_000 }).toBe(1);
  const kpi = (await draftTiles()).find((tile) => !known.has(tile.i))!;
  expect(kpi.query?.dimensions).toEqual([]);
  expect(kpi.query?.measures.map((measure) => measure.measure)).toEqual(['order_total']);
  await expect.poll(async () => (await draftTiles()).find((tile) => tile.i === kpi.i)?.viz.type, { timeout: 30_000 }).toMatch(/^(single_value|kpi)$/);
  await expect(draft).toBeVisible();
  await expect(draft.locator('.draft-status')).toContainText('Live · 1 row', { timeout: 30_000 });
  // The trend added before is untouched.
  expect((await draftTiles()).find((tile) => tile.i === added.i)?.viz.type).toBe(addedType);
  await page.getByRole('button', { name: 'Cancel new tile' }).click();
});

test('a filter change in the reader re-runs only the tiles it reaches; Ask says it needs an AI provider', async ({ page }) => {
  test.setTimeout(240_000);
  await openStudio(page);
  // A date filter on Ordered At reaches the Orders tiles only.
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  await page.locator('.filter-field-results button').filter({ hasText: /^Ordered At/ }).first().click();
  await page.getByRole('button', { name: 'Create filter' }).click();
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
  const ordersTiles = (await draftTiles()).filter((tile) => tile.query?.dimensions.some((dimension) => dimension.field === 'ordered_at') || tile.query?.measures.some((measure) => measure.measure === 'order_total')).map((tile) => tile.i).sort();
  expect(ordersTiles.length).toBeGreaterThan(0);

  await page.getByRole('button', { name: /Review and publish to Project/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(dialog).toBeVisible({ timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page).toHaveURL(/app=sales-review/, { timeout: 60_000 });

  // The reader's Ask box, with no AI provider: one plain sentence, no question box.
  const ask = page.getByRole('note', { name: /Ask about Sales Review/ });
  await expect(ask).toHaveText('Ask needs an AI provider. The owner can connect one in Settings.', { timeout: 60_000 });
  await expect(page.getByRole('textbox', { name: /Ask a question about/ })).toHaveCount(0);
  await expect(page.getByText(/AI-generated/)).toHaveCount(0);

  const from = page.getByLabel('Ordered At from');
  await expect(from).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.dql-trust-summary')).toBeVisible({ timeout: 60_000 });
  const runs: Array<{ affectedTileIds?: string[]; variables?: Record<string, unknown> }> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/apps\/[^/]+\/dashboards\/[^/]+\/run$/.test(request.url())) runs.push(JSON.parse(request.postData() ?? '{}'));
  });
  await from.fill('2026-02-01');
  await expect.poll(() => runs.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.getByText('Not filtered by Ordered At').first()).toBeVisible({ timeout: 60_000 });
  // One run, of the tiles the filter reaches; the Customers tiles keep their results.
  expect(runs).toHaveLength(1);
  expect([...(runs[0]!.affectedTileIds ?? [])].sort()).toEqual(ordersTiles);
  expect(runs[0]!.variables?.ordered_at).toEqual({ start: '2026-02-01' });
  // Nothing went back to a skeleton: the Customers tiles still show their numbers.
  await expect(page.getByText('Customers by name').first()).toBeVisible();
});
