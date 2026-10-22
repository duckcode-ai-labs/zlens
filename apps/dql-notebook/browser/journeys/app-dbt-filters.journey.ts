import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startNotebookServer, type NotebookServer } from '../support/server';
import { writeDbtShop } from '../support/dbt-shop';

/**
 * Phase-4 new-user review, problems 7, 9 and 10, against the built
 * `zlens notebook` CLI on a dbt-style shop whose orders.customer_id has dbt
 * `relationships` tests to both `customers` and its staging copy
 * `stg_customers` (the jaffle-shop sample's shape):
 *   - Orders has one "Orders → Customer" group (not a second, staging one),
 *     so a Customer Name filter reaches the Orders trend "via Customer" and
 *     narrows it;
 *   - the filter field search starts empty for every new filter;
 *   - the Data pane's field list does not move when a new tile starts;
 *   - a tile added after the filter offers "Customer Name filter can apply to
 *     this tile — Apply", is not linked until Apply, and is linked after it;
 *   - Publish says the App is saved as files (this folder is not a git repo);
 *   - a published App with an open draft is one card in the Apps list.
 *
 * It starts its own server on its own project.
 */

let workDir = '';
let server: NotebookServer | null = null;
let draftId = '';

type RunRequest = { variables?: Record<string, unknown> };
type RunResponse = { tiles: Array<{ tileId: string; title?: string; status?: string; result?: { rows?: Array<Record<string, unknown>> } }> };

async function call<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`${server!.baseUrl}${path}`, body === undefined
    ? {}
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 800)}`);
  return JSON.parse(text) as T;
}

async function openStudio(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-dbt-filters-'));
  const projectDir = join(workDir, 'dbt-shop');
  writeDbtShop(projectDir, workDir);
  server = await startNotebookServer({ projectDir, workDir });

  // The staging test does not add a second join: Orders joins customers once.
  const listing = await call<{ tables: Array<{ id: string; name: string; joins?: string[] }> }>('/api/app-datasets/tables');
  expect(listing.tables.find((table) => table.name === 'orders')?.joins).toEqual(['customers']);
  for (const name of ['orders', 'customers']) {
    const table = listing.tables.find((candidate) => candidate.name === name)!;
    const created = await call<{ status: string; sourceId: string }>('/api/app-datasets/tables/create', { tableId: table.id, name: name === 'orders' ? 'Orders' : 'Customers', domain: 'shop' });
    // "Check and use", then "I vouch for this — certify" (design Q1).
    expect(created.status).toBe('checked');
    expect((await call<{ status: string }>('/api/app-datasets/certify', { sourceId: created.sourceId })).status).toBe('certified');
  }

  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Customer Review', goal: 'Orders by customer', domain: 'shop', authoringMode: 'manual', template: 'blank',
  });
  draftId = app.draft.id;
  const candidates = await call<{ items: Array<{ sourceId: string; name: string; capabilities: { dataset?: { joins?: Array<{ id: string; table: string }>; fields: Array<{ name: string; kind: string; aggregation?: string }> } } }> }>(`/api/app-builds/${draftId}/source-candidates?limit=50`);
  const orders = candidates.items.find((item) => item.name === 'Orders')!;
  const customers = candidates.items.find((item) => item.name === 'Customers')!;
  expect(orders.capabilities.dataset?.joins?.map((join) => [join.id, join.table])).toEqual([['customer', 'customers']]);
  const customerCount = customers.capabilities.dataset!.fields.find((field) => field.kind === 'measure' && field.aggregation === 'count_distinct')!.name;
  await call(`/api/app-builds/${draftId}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [
      { sourceId: orders.sourceId, view: 'chart', title: 'Orders trend', query: { dimensions: [{ field: 'ordered_at', timeGrain: 'month' }], measures: [{ measure: 'order_total' }] } },
      { sourceId: customers.sourceId, view: 'chart', title: 'Customers by name', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: customerCount }] } },
    ],
  });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('dbt relationships: one Customer group on Orders, and a Customer Name filter reaches the Orders trend via Customer', async ({ page }) => {
  test.setTimeout(180_000);
  await openStudio(page);
  const panel = page.locator('.data-panel');
  await panel.locator('.dataset-current').click();
  await page.getByRole('menuitemradio', { name: /^Orders/ }).click();
  const fields = panel.locator('.field-groups');
  await expect(fields.getByRole('region', { name: 'Orders → Customer' }).getByRole('button', { name: /Customer Name/ })).toBeVisible();
  // One Customer group, not "Customer" plus a staging "Customer 2".
  await expect(fields.locator('section.related-fields')).toHaveCount(1);

  // The field search starts empty for every new filter.
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  await page.getByPlaceholder('Search fields').fill('ordered');
  await page.getByRole('button', { name: 'Back to filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  await expect(page.getByPlaceholder('Search fields')).toHaveValue('');

  await page.locator('.filter-field-results button').filter({ hasText: 'Customer Name' }).click();
  const trendChoice = page.getByRole('radiogroup', { name: 'Does this filter apply to Orders Trend?' });
  await expect(page.locator('[data-testid="filter-tile-choice"]').filter({ hasText: 'Orders Trend' })).toContainText('From Orders · via Customer');
  await expect(trendChoice.getByRole('radio', { name: 'Does not apply' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('checkbox', { name: 'Also filter Orders · via Customer' }).check();
  await expect(page.getByText('Applies to 2 of 2 tiles')).toBeVisible();
  await page.getByRole('button', { name: 'Create filter' }).click();
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });

  // Picking Ann narrows the Orders trend to her orders (January only, 150).
  const filtered = page.waitForResponse((response) => /\/dashboards\/[^/]+\/run$/.test(response.url())
    && (JSON.parse(response.request().postData() ?? '{}') as RunRequest).variables?.customer_name === 'Ann Archer');
  const customerControl = page.locator('.studio-page-filterbar details.studio-filter.dropdown');
  await customerControl.locator('summary').click();
  await customerControl.getByRole('button', { name: 'Ann Archer', exact: true }).click();
  const result = await (await filtered).json() as RunResponse;
  const trend = result.tiles.find((tile) => tile.result?.rows?.some((row) => 'ordered_at_month' in row));
  expect(trend?.status).toBe('ok');
  expect(trend?.result?.rows).toHaveLength(1);
  expect(Number(trend?.result?.rows?.[0]?.order_total)).toBe(150);
  // Back to every customer for the next test.
  await customerControl.locator('summary').click();
  await customerControl.getByRole('button', { name: 'All values' }).click();
});

test('a new tile keeps the field list in place, then offers the Customer Name filter in one click', async ({ page }) => {
  test.setTimeout(180_000);
  await openStudio(page);
  const panel = page.locator('.data-panel');
  await panel.locator('.dataset-current').click();
  await page.getByRole('menuitemradio', { name: /^Orders/ }).click();
  const orderTotal = panel.locator('.field-groups').getByRole('button', { name: /Order Total/ }).first();
  const customerName = panel.locator('.field-groups').getByRole('region', { name: 'Orders → Customer' }).getByRole('button', { name: /Customer Name/ });
  const before = await customerName.boundingBox();
  await orderTotal.click();
  await expect(panel.locator('.field-target')).toContainText('Building a new tile');
  // The note above the list changed; the list did not move (no click lands on the wrong field).
  const after = await customerName.boundingBox();
  expect(Math.round(after!.y)).toBe(Math.round(before!.y));

  await page.getByRole('button', { name: 'Add to page' }).click();
  const offer = page.locator('[data-testid="tile-filter-offer"]');
  await expect(offer).toHaveCount(1, { timeout: 60_000 });
  await expect(offer).toContainText('Customer Name filter can apply to this tile');
  await expect(offer).toContainText('via Customer');
  // Not linked until the author says so.
  await page.getByRole('tab', { name: 'Filters' }).click();
  await expect(page.locator('.filter-contract-list article').filter({ hasText: 'Customer Name' })).toContainText('2 linked tiles');
  await offer.getByRole('button', { name: /^Apply the Customer Name filter/ }).click();
  await expect(offer).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.filter-contract-list article').filter({ hasText: 'Customer Name' })).toContainText('3 linked tiles', { timeout: 30_000 });
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
});

test('Publish says "saved as files" outside git, and a published App with an open draft is one card', async ({ page }) => {
  test.setTimeout(180_000);
  await openStudio(page);
  await page.getByRole('button', { name: /Review and publish to Project/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText('Publishing saves the App as files in your project folder.')).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText(/review in git/)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page).toHaveURL(/app=customer-review/, { timeout: 60_000 });
  // Plain names in the published App (new-user round 2, problem 9): the filter reads
  // "Customer Name", never "Customer Customer Name"; no raw field or saved query ids.
  await expect(page.getByText(/tiles up to date|Customer Name/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Customer Customer/)).toHaveCount(0);
  await expect(page.getByText(/customer__customer_name/)).toHaveCount(0);

  // Edit the published App: that opens a private draft of it.
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(page.getByText(/tiles up to date|Unpublished changes|Saved/).first()).toBeVisible({ timeout: 60_000 });
  // A private draft of the published App exists (before, it was a second "Customer Review" card).
  await expect.poll(async () => (await call<{ drafts: Array<{ appId: string; state: string }> }>('/api/app-builds'))
    .drafts.filter((draft) => draft.appId === 'customer-review' && draft.state !== 'project_published').length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.goto(`${server!.baseUrl}/?view=apps`);
  const cards = page.locator('article.dql-app-card').filter({ hasText: 'Customer Review' });
  await expect(cards).toHaveCount(1, { timeout: 30_000 });
  await expect(cards.getByText(/Unpublished changes/)).toBeVisible();
  await expect(cards.getByRole('button', { name: 'Continue editing Customer Review' })).toBeVisible();
  await expect(cards.getByRole('button', { name: 'View Customer Review' })).toBeVisible();
  // The card keeps a plain description, never "Governed analytical App for …" (new-user round 2, problem 10).
  await expect(cards.getByText(/Governed analytical App/)).toHaveCount(0);
});
