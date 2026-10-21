import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedProject } from '../global-setup';
import { startNotebookServer, type NotebookServer } from '../support/server';

/**
 * A filter that does not apply to one tile, against the built `zlens notebook`
 * CLI on the jaffle-supply-chain fixture: a page with a Dataset tile and a
 * Saved query tile → Filters → Customer Name → the Saved query tile set to
 * "Does not apply" → picking a customer in the editor re-runs only the linked
 * tile, at once, without Run → publishing is allowed → a reader who picks a
 * customer sees the Dataset tile narrowed and "Not filtered by Customer Name"
 * on the Saved query tile.
 *
 * A second App checks a one-sided date range: only a start date means "from"
 * that day (the control says "From …") and the linked tile narrows.
 *
 * It starts its own server on its own copy of the fixture: the certified
 * Dataset and App it adds would change what the shared server's journeys count.
 * Set ZLENS_FILTER_SHOTS_DIR to also save the two documentation screenshots.
 */

let workDir = '';
let server: NotebookServer | null = null;
let draftId = '';
let itemsDraftId = '';
const shotsDir = process.env.ZLENS_FILTER_SHOTS_DIR;

type RunRequest = { affectedTileIds?: string[]; fullRun?: boolean; refresh?: boolean; variables?: Record<string, unknown> };
type RunResponse = { tiles: Array<{ tileId: string; status?: string; result?: { rows?: Array<Record<string, unknown>> } }> };

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
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-appfilters-'));
  const projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });
  server = await startNotebookServer({ projectDir, workDir });

  // One certified Dataset from dim_customers, the way Add data's table tab makes it.
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

  // A manual App with a Dataset tile and a Saved query tile on one page.
  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Customer Review', goal: 'Review customers', domain: 'orders', authoringMode: 'manual', sourcePolicy: 'governed_only', template: 'blank',
  });
  draftId = app.draft.id;
  const candidates = await call<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${draftId}/source-candidates?limit=50`);
  const sourceId = (name: string) => candidates.items.find((candidate) => candidate.name === name)!.sourceId;
  await call(`/api/app-builds/${draftId}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [
      { sourceId: sourceId('Customers'), view: 'chart', title: 'Spend by customer', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }] } },
      { sourceId: sourceId('top_customers'), view: 'table', title: 'Top customers' },
    ],
  });

  // A second certified Dataset with a timestamp (order_items.ordered_at) and an
  // App that lists items by day next to the same Saved query tile.
  const itemsTable = listing.tables.find((candidate) => candidate.name === 'order_items')!;
  const itemsDraft = await call<{ proposal: { measures: Array<{ name: string; include: boolean; format: string }> } }>('/api/app-datasets/tables/draft', { tableId: itemsTable.id });
  const itemsCreated = await call<{ status: string }>('/api/app-datasets/tables/create', {
    tableId: itemsTable.id,
    name: 'Order items',
    domain: 'orders',
    measures: itemsDraft.proposal.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format })),
  });
  expect(itemsCreated.status).toBe('certified');
  const itemsApp = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Item Review', goal: 'Review order items', domain: 'orders', authoringMode: 'manual', sourcePolicy: 'governed_only', template: 'blank',
  });
  itemsDraftId = itemsApp.draft.id;
  const itemCandidates = await call<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${itemsDraftId}/source-candidates?limit=50`);
  const itemSourceId = (name: string) => itemCandidates.items.find((candidate) => candidate.name === name)!.sourceId;
  const countMeasure = itemsDraft.proposal.measures.find((measure) => measure.name.endsWith('_count') && measure.include)!.name;
  await call(`/api/app-builds/${itemsDraftId}/compose`, {
    expectedRevision: itemsApp.draft.revision,
    expectedProposalHash: itemsApp.draft.proposalHash,
    mode: 'manual',
    selections: [
      { sourceId: itemSourceId('Order items'), view: 'table', title: 'Items by day', query: { dimensions: [{ field: 'ordered_at', timeGrain: 'day' }], measures: [{ measure: countMeasure }] } },
      { sourceId: itemSourceId('top_customers'), view: 'table', title: 'Top customers' },
    ],
  });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a filter that does not apply to a tile still publishes, and readers see "Not filtered by"', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.getByText('Top customers').first()).toBeVisible({ timeout: 60_000 });
  // The Saved query tile's filterable columns come from a settled preview.
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  await page.locator('.filter-field-results button').filter({ hasText: 'Customer Name' }).click();

  const datasetChoice = page.getByRole('radiogroup', { name: 'Does this filter apply to Spend By Customer?' });
  const savedQueryChoice = page.getByRole('radiogroup', { name: 'Does this filter apply to Top Customers?' });
  await expect(datasetChoice.getByRole('radio', { name: 'Applies' })).toHaveAttribute('aria-checked', 'true');
  await savedQueryChoice.getByRole('radio', { name: 'Does not apply' }).click();
  await expect(savedQueryChoice.getByRole('radio', { name: 'Does not apply' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Applies to 1 of 2 tiles')).toBeVisible();
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await page.locator('.filter-mapping').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shotsDir, '10-filters-applies.png') });
  }
  await page.getByRole('button', { name: 'Create filter' }).click();
  // Studio shows the stored choice on the tile itself.
  await expect(page.getByText('Not filtered by Customer Name').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Preview settled/)).toBeVisible({ timeout: 60_000 });

  // Picking a customer in the editor re-runs only the linked Dataset tile, at
  // once and without Run; the unlinked Saved query tile is never re-run or blanked.
  const runs: RunRequest[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/app-builds\/[^/]+\/dashboards\/[^/]+\/run$/.test(request.url())) {
      runs.push(JSON.parse(request.postData() ?? '{}') as RunRequest);
    }
  });
  const filteredRun = page.waitForResponse((response) => /\/dashboards\/[^/]+\/run$/.test(response.url())
    && (JSON.parse(response.request().postData() ?? '{}') as RunRequest).variables?.customer_name === 'Alice');
  const customerControl = page.locator('.studio-page-filterbar details.studio-filter.dropdown');
  await customerControl.locator('summary').click();
  await customerControl.getByRole('button', { name: 'Alice', exact: true }).click();
  const filtered = await (await filteredRun).json() as RunResponse;
  const filterRun = runs.find((run) => run.variables?.customer_name === 'Alice')!;
  expect(filterRun.fullRun).toBeFalsy();
  expect(filterRun.affectedTileIds).toHaveLength(1);
  const linkedTile = filtered.tiles.find((tile) => tile.tileId === filterRun.affectedTileIds![0])!;
  expect(linkedTile.status).toBe('ok');
  expect(linkedTile.result?.rows?.map((row) => row.customer_name)).toEqual(['Alice']);
  expect(filtered.tiles.map((tile) => tile.tileId)).toEqual([linkedTile.tileId]);
  await expect(page.getByText('Customer Name applied · 1 tile updated')).toBeVisible();
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible();
  await expect(page.getByText('Preview is not loaded')).toHaveCount(0);

  // A second change runs the NEW choice, not the previous one.
  const secondRun = page.waitForResponse((response) => /\/dashboards\/[^/]+\/run$/.test(response.url())
    && (JSON.parse(response.request().postData() ?? '{}') as RunRequest).variables?.customer_name === 'Bob');
  await customerControl.locator('summary').click();
  await customerControl.getByRole('button', { name: 'Bob', exact: true }).click();
  const second = await (await secondRun).json() as RunResponse;
  expect(second.tiles.find((tile) => tile.tileId === linkedTile.tileId)?.result?.rows?.map((row) => row.customer_name)).toEqual(['Bob']);
  await expect(customerControl.locator('summary strong')).toHaveText('Bob');
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible();

  // "Does not apply" is a decision, not a gap: publishing is allowed.
  await page.getByRole('button', { name: 'Review and publish to Project' }).click();
  await expect(page.getByText('Ready to publish')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('dialog', { name: 'Ready to publish' }).getByRole('button', { name: 'Publish to Project', exact: true }).click();
  await expect(page).toHaveURL(/app=customer-review/, { timeout: 60_000 });

  // A reader picks a customer: the Dataset tile narrows; the Saved query tile says it was not filtered.
  await page.goto(`${server!.baseUrl}/?app=customer-review&page=overview`);
  const customer = page.locator('select').filter({ has: page.locator('option[value="Alice"]') });
  await expect(customer).toBeVisible({ timeout: 60_000 });
  await customer.selectOption('Alice');
  const pill = page.getByText('Not filtered by Customer Name');
  await expect(pill).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible();
  if (shotsDir) {
    await pill.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shotsDir, '11-reader-not-filtered.png') });
  }
});

test('a start-only date range means "from" that day, in the editor and for readers', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${itemsDraftId}`);
  await expect(page.getByText('Items by day').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Showing 1–4 of 4 rows')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  await page.locator('.filter-field-results button').filter({ hasText: 'Ordered At' }).first().click();
  // A date control never needs a value list: no "No date values" warning.
  await expect(page.getByText(/No date values/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Create filter' }).click();
  await expect(page.getByLabel('Ordered At start')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Preview settled/)).toBeVisible({ timeout: 60_000 });

  // Only a start date: the control says "From 3 Jan 2024" and the linked tile
  // keeps 3 and 4 January; the unlinked tile is untouched.
  await page.getByLabel('Ordered At start').fill('2024-01-03');
  await expect(page.locator('.studio-page-filterbar').getByText('From 3 Jan 2024')).toBeVisible();
  await expect(page.getByText('Showing 1–2 of 2 rows')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible();
  await expect(page.getByText('Preview is not loaded')).toHaveCount(0);
  await expect(page.getByText(/could not be converted into a predicate|No date values/)).toHaveCount(0);

  // Only an end date: "Until 1 Jan 2024" keeps that whole day.
  await page.getByLabel('Ordered At start').fill('');
  await page.getByLabel('Ordered At end').fill('2024-01-01');
  await expect(page.locator('.studio-page-filterbar').getByText('Until 1 Jan 2024')).toBeVisible();
  await expect(page.getByText('Showing 1–1 of 1 rows').or(page.getByText('Showing 1–1 of 1 row'))).toBeVisible({ timeout: 60_000 });

  // A reader gets the same rule: only a "from" date keeps 3 and 4 January.
  await page.getByRole('button', { name: 'Review and publish to Project' }).click();
  await expect(page.getByText('Ready to publish')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('dialog', { name: 'Ready to publish' }).getByRole('button', { name: 'Publish to Project', exact: true }).click();
  await expect(page).toHaveURL(/app=item-review/, { timeout: 60_000 });
  await page.goto(`${server!.baseUrl}/?app=item-review&page=overview`);
  const from = page.getByLabel('Ordered At from');
  await expect(from).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Showing 1–4 of 4 rows')).toBeVisible({ timeout: 60_000 });
  await from.fill('2024-01-03');
  await expect(page.locator('.dql-app-filter-range-note')).toHaveText('From 3 Jan 2024');
  await expect(page.getByText('Showing 1–2 of 2 rows')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible();
});
