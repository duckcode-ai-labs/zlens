import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { installDuckdbConnector, repoRoot, run, startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Fields from related tables (design D2), against the built `zlens notebook`
 * CLI on a database-only shop whose stores are UUIDs: setup's "Draft my
 * models" drafts and checks orders → customers and orders → locations; Orders
 * and Customers become Datasets from their tables. In the App:
 *   - Orders' field list shows "Orders → Location" (Not certified yet: the
 *     join is a setup draft) with Location Name;
 *   - Order Total + Location Name (dragged onto a shelf) draws a bar labelled
 *     with store names, never the UUIDs;
 *   - a Customer Name filter offers the Orders trend "via Customer"; once
 *     linked, picking a customer narrows the trend.
 *
 * It starts its own server on its own database-only project. Set
 * ZLENS_JOINS_SHOTS_DIR to also save the documentation screenshot.
 */

let workDir = '';
let server: NotebookServer | null = null;
let draftId = '';
const shotsDir = process.env.ZLENS_JOINS_SHOTS_DIR;

const STORES = {
  philadelphia: '4b6c2304-2b9e-41a3-8f1e-6c9a1d2f0001',
  brooklyn: '9a1e77d0-5c3b-4e2a-b7d4-0e5f6a7b0002',
};

type RunRequest = { variables?: Record<string, unknown> };
type PreviewResponse = { result?: { rows?: Array<Record<string, unknown>> }; trustState?: string; joins?: Array<{ sentence: string }> };
type RunResponse = { tiles: Array<{ tileId: string; title?: string; status?: string; result?: { rows?: Array<Record<string, unknown>> } }> };

async function call<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`${server!.baseUrl}${path}`, body === undefined
    ? {}
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 800)}`);
  return JSON.parse(text) as T;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-joins-'));
  const projectDir = join(workDir, 'shop');
  mkdirSync(projectDir, { recursive: true });
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  const shared = process.env.ZLENS_E2E_DUCKDB_CONNECTORS;
  if (shared && existsSync(shared)) cpSync(shared, connectorRoot, { recursive: true });
  else installDuckdbConnector(projectDir);
  const order = (id: string, customer: string, store: string, at: string, total: number) => ({ order_id: id, customer_id: customer, location_id: store, ordered_at: at, order_total: total });
  const seedPath = join(workDir, 'shop-seed.json');
  writeFileSync(seedPath, JSON.stringify({ tables: {
    customers: {
      columns: [{ name: 'customer_id', type: 'text' }, { name: 'customer_name', type: 'text' }],
      rows: [{ customer_id: 'C1', customer_name: 'Ann' }, { customer_id: 'C2', customer_name: 'Bob' }, { customer_id: 'C3', customer_name: 'Cy' }],
    },
    locations: {
      columns: [{ name: 'location_id', type: 'text' }, { name: 'location_name', type: 'text' }],
      rows: [{ location_id: STORES.philadelphia, location_name: 'Philadelphia' }, { location_id: STORES.brooklyn, location_name: 'Brooklyn' }],
    },
    orders: {
      columns: [{ name: 'order_id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'location_id', type: 'text' }, { name: 'ordered_at', type: 'timestamp' }, { name: 'order_total', type: 'decimal' }],
      rows: [
        order('O1', 'C1', STORES.philadelphia, '2026-01-05 10:00:00', 100),
        order('O2', 'C1', STORES.brooklyn, '2026-01-20 10:00:00', 50),
        order('O3', 'C2', STORES.philadelphia, '2026-02-02 10:00:00', 25),
        order('O4', 'C3', STORES.philadelphia, '2026-02-10 10:00:00', 10),
        order('O5', 'C2', STORES.brooklyn, '2026-03-01 10:00:00', 40),
      ],
    },
  } }));
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--seed', seedPath, '--connector-root', connectorRoot, '--out', join(projectDir, 'shop.duckdb')]);
  // `--yes` makes a Database only project around the file, as a new user's first start does.
  server = await startNotebookServer({ projectDir, workDir, args: ['--yes'] });

  // Settings → Sync schema, then setup's Draft my models: the joins are drafted and checked on the data.
  await call('/api/connections/default/metadata-sync', {});
  const drafted = await call<{ proposal: { operations: Array<{ change?: { operation?: string; value?: { from?: string; to?: string } } }> } }>('/api/modeling/warehouse/discover/proposal', { validate: true });
  expect(drafted.proposal.operations.filter((operation) => operation.change?.operation === 'upsert_relationship').length).toBeGreaterThanOrEqual(2);

  // Orders and Customers become Datasets from their tables (Add data → Check and add).
  const listing = await call<{ tables: Array<{ id: string; name: string; joins?: string[] }> }>('/api/app-datasets/tables');
  expect(listing.tables.find((table) => table.name === 'orders')?.joins).toEqual(['customers', 'locations']);
  for (const name of ['orders', 'customers']) {
    const table = listing.tables.find((candidate) => candidate.name === name)!;
    const created = await call<{ status: string; sourceId: string }>('/api/app-datasets/tables/create', { tableId: table.id, name: name === 'orders' ? 'Orders' : 'Customers', domain: 'shop' });
    // "Check and use", then "I vouch for this — certify" (design Q1).
    expect(created.status).toBe('checked');
    expect((await call<{ status: string }>('/api/app-datasets/certify', { sourceId: created.sourceId })).status).toBe('certified');
  }

  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Store Review', goal: 'Sales by store and customer', domain: 'shop', authoringMode: 'manual', template: 'blank',
  });
  draftId = app.draft.id;
  const candidates = await call<{ items: Array<{ sourceId: string; name: string; capabilities: { dataset?: { fields: Array<{ name: string; kind: string; aggregation?: string }> } } }> }>(`/api/app-builds/${draftId}/source-candidates?limit=50`);
  const orders = candidates.items.find((item) => item.name === 'Orders')!;
  const customers = candidates.items.find((item) => item.name === 'Customers')!;
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

test('Orders shows its related tables\' fields; a bar by Location Name reads store names; a Customer Name filter reaches the Orders trend via Customer', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });

  // Choose Orders: its related tables' fields are under it, grouped by the join.
  const panel = page.locator('.data-panel');
  await panel.locator('.dataset-current').click();
  await page.getByRole('menuitemradio', { name: /^Orders/ }).click();
  const fields = panel.locator('.field-groups');
  const locationGroup = fields.getByRole('region', { name: 'Orders → Location' });
  await expect(locationGroup).toBeVisible();
  await expect(locationGroup.locator('h3')).toContainText('Not certified yet');
  await expect(fields.getByRole('region', { name: 'Orders → Customer' }).getByRole('button', { name: /Customer Name/ })).toBeVisible();

  // Order Total, then Location Name dragged onto the Columns shelf: a bar by store.
  const previews: PreviewResponse[] = [];
  page.on('response', async (response) => {
    if (response.url().endsWith('/api/app-datasets/run') && response.request().method() === 'POST') {
      try { previews.push(await response.json() as PreviewResponse); } catch { /* a newer edit cancelled it */ }
    }
  });
  await fields.getByRole('button', { name: /Order Total/ }).first().click();
  const columns = page.locator('.shelf').filter({ has: page.getByRole('list', { name: 'Columns shelf' }) });
  await expect(columns).toBeVisible({ timeout: 30_000 });
  await locationGroup.getByRole('button', { name: /Location Name/ }).dragTo(columns);
  await expect(page.getByRole('list', { name: 'Columns shelf' })).toContainText('Location Name', { timeout: 30_000 });
  const draft = page.locator('.studio-draft-slot, .draft-tile-card').first();
  await expect(draft.locator('svg').getByText('Philadelphia').first()).toBeVisible({ timeout: 60_000 });
  await expect(draft.locator('svg').getByText('Brooklyn').first()).toBeVisible();
  await expect(draft.getByText(STORES.philadelphia)).toHaveCount(0);
  // The rows the server returned are store names that add up to every order,
  // and the drafted join keeps the tile Not certified yet, with the join on its receipt.
  await expect.poll(() => previews.some((preview) => preview.result?.rows?.some((row) => 'location__location_name' in row)), { timeout: 30_000 }).toBe(true);
  const byStore = previews.filter((preview) => preview.result?.rows?.some((row) => 'location__location_name' in row)).at(-1)!;
  expect(byStore.result!.rows!.map((row) => row.location__location_name).sort()).toEqual(['Brooklyn', 'Philadelphia']);
  expect(byStore.result!.rows!.reduce((total, row) => total + Number(row.order_total), 0)).toBe(225);
  expect(byStore.trustState).toBe('review_required');
  expect(byStore.joins?.[0]?.sentence).toBe('Joined to locations on location_id (each order has one location — checked; the join is not certified yet)');
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, '17-related-fields.png') });
  }
  await page.getByRole('button', { name: 'Cancel new tile' }).click();

  // A Customer Name filter: Customers has the field; the Orders trend reaches it via Customer.
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  await expect(page.locator('.filter-field-results button').filter({ hasText: 'Customer Name' })).toHaveCount(1);
  await page.locator('.filter-field-results button').filter({ hasText: 'Customer Name' }).click();
  const trendChoice = page.getByRole('radiogroup', { name: 'Does this filter apply to Orders Trend?' });
  // Never automatic: offered, with the join shown, and not linked until checked.
  await expect(trendChoice.getByRole('radio', { name: 'Does not apply' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-testid="filter-tile-choice"]').filter({ hasText: 'Orders Trend' })).toContainText('From Orders · via Customer');
  const viaCustomer = page.getByRole('checkbox', { name: 'Also filter Orders · via Customer' });
  await expect(viaCustomer).not.toBeChecked();
  await viaCustomer.check();
  await expect(trendChoice.getByRole('radio', { name: 'Applies' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Applies to 2 of 2 tiles')).toBeVisible();
  await page.getByRole('button', { name: 'Create filter' }).click();
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Not filtered by Customer Name')).toHaveCount(0);
  // The filter is "Customer Name", never "Customer Customer Name" (new-user round 2, problem 9).
  await expect(page.getByText(/Customer Customer/)).toHaveCount(0);

  // Picking Ann narrows the Orders trend to her orders (January only, 150).
  const filtered = page.waitForResponse((response) => /\/dashboards\/[^/]+\/run$/.test(response.url())
    && (JSON.parse(response.request().postData() ?? '{}') as RunRequest).variables?.customer_name === 'Ann');
  const customerControl = page.locator('.studio-page-filterbar details.studio-filter.dropdown');
  await customerControl.locator('summary').click();
  await customerControl.getByRole('button', { name: 'Ann', exact: true }).click();
  const result = await (await filtered).json() as RunResponse;
  const trend = result.tiles.find((tile) => tile.title === 'Orders trend' || tile.result?.rows?.some((row) => 'ordered_at_month' in row));
  expect(trend?.status).toBe('ok');
  expect(trend?.result?.rows).toHaveLength(1);
  expect(Number(trend?.result?.rows?.[0]?.order_total)).toBe(150);
});

test('at 1440x900 the click-to-filter hint has its own row under the chart and never covers the axis labels (Codex F10)', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
  const card = page.locator('.studio-component-card').filter({ has: page.locator('.dataset-link-hint') }).first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.hover();
  const hint = card.locator('.dataset-link-hint');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText(/Clicking a (bar|point|row|slice)/);
  const chart = card.locator('.live-component-body').first();
  const [hintBox, chartBox] = [await hint.boundingBox(), await chart.boundingBox()];
  expect(hintBox && chartBox).toBeTruthy();
  // The hint starts below the chart area (the axis labels live inside it).
  expect(hintBox!.y).toBeGreaterThanOrEqual(chartBox!.y + chartBox!.height - 1);
  // Away from the card it is hidden but keeps its row, so the chart does not jump.
  await page.mouse.move(5, 5);
  await expect(hint).toBeHidden();
  const chartAfter = await chart.boundingBox();
  expect(Math.abs(chartAfter!.height - chartBox!.height)).toBeLessThanOrEqual(1);
});

test('a tile on a join nobody certified publishes as Not certified yet: the dialog lists it with its join action, and the count agrees everywhere (T3)', async ({ page }) => {
  test.setTimeout(180_000);
  // A Revenue by store tile reads Location Name through the join setup drafted (not certified).
  const current = await call<{ draft: { revision: number; proposalHash: string } }>(`/api/app-builds/${draftId}`, undefined, 'GET');
  const candidates = await call<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${draftId}/source-candidates?limit=50`);
  const orders = candidates.items.find((item) => item.name === 'Orders')!;
  await call(`/api/app-builds/${draftId}/compose`, {
    expectedRevision: current.draft.revision,
    expectedProposalHash: current.draft.proposalHash,
    mode: 'manual',
    selections: [
      { sourceId: orders.sourceId, view: 'chart', title: 'Revenue by store', query: { dimensions: [{ field: 'location__location_name' }], measures: [{ measure: 'order_total' }] } },
    ],
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
  // B6/T3: nothing to fix, so the Publish button counts no fixes.
  const publishButton = page.getByRole('button', { name: /^Review and publish to Project/ });
  await expect(publishButton).toHaveAttribute('aria-label', 'Review and publish to Project', { timeout: 30_000 });
  await publishButton.click();
  const ready = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(ready).toBeVisible({ timeout: 60_000 });
  await expect(ready.getByText(/Complete governed validation|Scoped review| is review /)).toHaveCount(0);
  // Revenue by store and the Orders trend (the Customer filter reaches it) are not certified; Customers by name is.
  await expect(ready.locator('.readiness-trust-count')).toHaveText('1 of 3 tiles certified');
  await expect(ready.getByText(/Every check passed|All checks passed/)).toHaveCount(0);
  const list = ready.getByRole('region', { name: '2 tiles not certified yet' });
  const store = list.getByRole('listitem', { name: 'Not certified yet: Revenue by store' });
  await expect(store).toContainText('Uses a join nobody has certified.');
  await expect(store.getByRole('button', { name: 'Certify the join for Revenue by store' })).toBeVisible();
  await expect(store.getByRole('button', { name: 'Remove the related field' })).toBeVisible();
  await expect(list.getByRole('listitem', { name: 'Not certified yet: Orders trend' })).toBeVisible();
  await expect(ready.getByText('Readers will see \u2018Not certified yet\u2019 on 2 tiles.')).toBeVisible();
  await expect(ready.getByText(/Allow data that needs review|data rule|Only certified data/)).toHaveCount(0);
  await ready.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page).toHaveURL(/app=store-review/, { timeout: 60_000 });

  // The App header says the same as the dialog.
  await expect(page.getByText('1 of 3 tiles certified').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/All tiles certified/)).toHaveCount(0);
  // The tile on the uncertified join says so to readers.
  await expect(page.locator('.dql-trust-badge.review').first()).toContainText('Not certified yet');

  // A reader picks a customer: trust is the page's, not the filter value's, so the count holds.
  await page.goto(`${server!.baseUrl}/?app=store-review&page=overview`);
  await expect(page.getByText('1 of 3 tiles certified').first()).toBeVisible({ timeout: 60_000 });
  const customer = page.getByRole('button', { name: /^Customer Name: / });
  await expect(customer).toBeVisible({ timeout: 60_000 });
  const picked = page.waitForResponse((response) => /\/api\/apps\/[^/]+\/dashboards\/[^/]+\/run$/.test(new URL(response.url()).pathname)
    && (JSON.parse(response.request().postData() ?? '{}') as RunRequest).variables?.customer_name === 'Ann');
  await customer.click();
  await page.getByRole('option', { name: 'Ann', exact: true }).click();
  await picked;
  await expect(page.getByRole('button', { name: /^Customer Name: / })).toHaveAccessibleName('Customer Name: Ann', { timeout: 30_000 });
  await expect(page.getByText('1 of 3 tiles certified').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/[02] of 3 tiles certified/)).toHaveCount(0);

  // The Apps card agrees, after a reload too: never "App certified" over a tile not certified yet.
  await page.goto(server!.baseUrl);
  await page.getByRole('button', { name: 'Apps', exact: true }).first().click();
  const card = page.locator('article.dql-app-card').filter({ hasText: 'Store Review' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('1 of 3 tiles certified')).toBeVisible();
  await expect(card.getByText(/App certified/)).toHaveCount(0);
});

test('certify a join inside the publish dialog: a fresh check, "I vouch for this join — certify", and the count becomes All tiles certified without leaving the App (T4)', async ({ page }) => {
  test.setTimeout(300_000);
  // A new App with two tiles, each through a join setup drafted (nobody certified either).
  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Store Joins', goal: 'Revenue by store and customer', domain: 'shop', authoringMode: 'manual', template: 'blank',
  });
  const candidates = await call<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${app.draft.id}/source-candidates?limit=50`);
  const orders = candidates.items.find((item) => item.name === 'Orders')!;
  await call(`/api/app-builds/${app.draft.id}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [
      { sourceId: orders.sourceId, view: 'chart', title: 'Revenue by store', query: { dimensions: [{ field: 'location__location_name' }], measures: [{ measure: 'order_total' }] } },
      { sourceId: orders.sourceId, view: 'chart', title: 'Revenue by customer', query: { dimensions: [{ field: 'customer__customer_name' }], measures: [{ measure: 'order_total' }] } },
    ],
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${app.draft.id}`);
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Review and publish to Project/ }).click();
  const ready = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('0 of 2 tiles certified', { timeout: 60_000 });

  // "Certify this join" opens the join's short review here, not Modeling.
  const list = ready.getByRole('region', { name: '2 tiles not certified yet' });
  const store = list.getByRole('listitem', { name: 'Not certified yet: Revenue by store' });
  await expect(store.getByRole('button', { name: 'Certify the join for Revenue by store' })).toHaveText('Certify this join (recommended)');
  await store.getByRole('button', { name: 'Certify the join for Revenue by store' }).click();
  const review = page.getByRole('dialog', { name: 'Certify the join Orders → Location' });
  await expect(review.getByRole('region', { name: 'The keys' })).toContainText('orders.location_id = locations.location_id', { timeout: 60_000 });
  await expect(review.getByRole('region', { name: 'The check' })).toContainText('each order has one location — checked on 5 rows');
  await expect(review.getByRole('region', { name: 'What would double-count' })).toContainText('would be counted more than once');
  await expect(review.getByText(/set them in the model|Open Modeling/i)).toHaveCount(0);
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, '22-certify-join-inline.png') });
  }
  await review.getByRole('button', { name: 'I vouch for this join — certify' }).click();
  await expect(review).toBeHidden({ timeout: 60_000 });

  // The count updates in place, and the tile leaves the list.
  await expect(ready.locator('.readiness-trust-count')).toHaveText('1 of 2 tiles certified', { timeout: 120_000 });
  await expect(ready.getByRole('listitem', { name: 'Not certified yet: Revenue by store' })).toHaveCount(0);
  // Still in the App: the publish dialog never closed.
  await expect(ready).toBeVisible();

  // The other join, the same way: then every tile is certified.
  const customer = ready.getByRole('listitem', { name: 'Not certified yet: Revenue by customer' });
  await customer.getByRole('button', { name: 'Certify the join for Revenue by customer' }).click();
  const second = page.getByRole('dialog', { name: 'Certify the join Orders → Customer' });
  await expect(second.getByRole('region', { name: 'The check' })).toContainText('each order has one customer — checked on 5 rows', { timeout: 60_000 });
  await second.getByRole('button', { name: 'I vouch for this join — certify' }).click();
  await expect(second).toBeHidden({ timeout: 60_000 });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('All tiles certified', { timeout: 120_000 });
  await expect(ready.getByText('All checks passed')).toBeVisible();
  await expect(ready.getByRole('region', { name: /not certified yet/ })).toHaveCount(0);

  // Modeling has both joins certified (written through its own path), and the Data pane agrees.
  const after = await call<{ items: Array<{ sourceId: string; capabilities: { dataset?: { joins?: Array<{ id: string; origin: string; trust: string }> } } }> }>(`/api/app-builds/${app.draft.id}/source-candidates?limit=50`);
  const joins = after.items.find((item) => item.sourceId === orders.sourceId)!.capabilities.dataset!.joins!;
  expect(joins.map((join) => [join.id, join.origin, join.trust])).toEqual([['customer', 'model', 'certified'], ['location', 'model', 'certified']]);
});
