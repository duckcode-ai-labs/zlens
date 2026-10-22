import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { installDuckdbConnector, repoRoot, run, startNotebookServer, type NotebookServer } from '../support/server';

/**
 * New-user round 3 data fixes, against the built `zlens notebook` CLI on a
 * database-only shop where two customers are both called Maria Lopez and
 * orders keep each amount twice, in dollars and in cents:
 *   - Add data → Check and add asks about the cents columns once for the
 *     table, junk counts start unticked, and the table then reads
 *     "Not certified yet · added" with no second "Check and add" (problems 7, 8);
 *   - Top customers shows two Maria Lopez bars, told apart by their ids (4);
 *   - a date filter lists the order's own Ordered At first, a customer's
 *     date by its table, and a different date only by its meaning (2);
 *   - the date control's quick choices fill the range (9).
 * It starts its own server on its own database-only project.
 */

let workDir = '';
let server: NotebookServer | null = null;

type Candidate = { sourceId: string; name: string; capabilities: { dataset?: { fields: Array<{ name: string; kind: string; aggregation?: string }> } } };
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
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-names-'));
  const projectDir = join(workDir, 'shop');
  mkdirSync(projectDir, { recursive: true });
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  const shared = process.env.ZLENS_E2E_DUCKDB_CONNECTORS;
  if (shared && existsSync(shared)) cpSync(shared, connectorRoot, { recursive: true });
  else installDuckdbConnector(projectDir);
  const order = (id: string, customer: string, number: number, at: string, subtotal: number, total: number) => ({
    order_id: id, customer_id: customer, customer_order_number: number, ordered_at: at,
    subtotal, subtotal_cents: Math.round(subtotal * 100), order_total: total, order_total_cents: Math.round(total * 100),
  });
  const seedPath = join(workDir, 'shop-seed.json');
  writeFileSync(seedPath, JSON.stringify({ tables: {
    customers: {
      columns: [{ name: 'customer_id', type: 'text' }, { name: 'customer_name', type: 'text' }, { name: 'first_ordered_at', type: 'timestamp' }, { name: 'lifetime_spend', type: 'decimal' }],
      rows: [
        { customer_id: 'C1', customer_name: 'Maria Lopez', first_ordered_at: '2026-01-05 10:00:00', lifetime_spend: 300 },
        { customer_id: 'C2', customer_name: 'Maria Lopez', first_ordered_at: '2026-02-02 10:00:00', lifetime_spend: 200 },
        { customer_id: 'C3', customer_name: 'Bob', first_ordered_at: '2026-02-10 10:00:00', lifetime_spend: 50 },
      ],
    },
    orders: {
      columns: [
        { name: 'order_id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'customer_order_number', type: 'int' }, { name: 'ordered_at', type: 'timestamp' },
        { name: 'subtotal', type: 'decimal' }, { name: 'subtotal_cents', type: 'int' }, { name: 'order_total', type: 'decimal' }, { name: 'order_total_cents', type: 'int' },
      ],
      rows: [
        order('O1', 'C1', 1, '2026-01-05 10:00:00', 90, 100),
        order('O2', 'C1', 2, '2026-01-20 10:00:00', 45, 50),
        order('O3', 'C2', 1, '2026-02-02 10:00:00', 22.5, 25),
        order('O4', 'C3', 1, '2026-02-10 10:00:00', 9, 10),
      ],
    },
  } }));
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--seed', seedPath, '--connector-root', connectorRoot, '--out', join(projectDir, 'shop.duckdb')]);
  server = await startNotebookServer({ projectDir, workDir, args: ['--yes'] });
  // Settings → Sync schema, then setup's Draft my models: orders → customers is drafted and checked.
  await call('/api/connections/default/metadata-sync', {});
  await call('/api/modeling/warehouse/discover/proposal', { validate: true });
  // Customers was checked earlier, in another App.
  const listing = await call<{ tables: Array<{ id: string; name: string }> }>('/api/app-datasets/tables');
  const customers = listing.tables.find((table) => table.name === 'customers')!;
  const created = await call<{ status: string }>('/api/app-datasets/tables/create', { tableId: customers.id, name: 'Customers', domain: 'shop' });
  expect(created.status).toBe('checked');
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('Check and add asks about cents once, leaves junk counts off, and the table then reads Not certified yet · added', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server!.baseUrl);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  // A project with no App opens on the new App form; otherwise Build new App opens it.
  const buildNew = page.getByRole('button', { name: 'Build new App' });
  await expect(page.getByRole('tab', { name: 'Start manually' }).or(buildNew).first()).toBeVisible({ timeout: 30_000 });
  if (await buildNew.isVisible()) await buildNew.click();
  await page.getByRole('tab', { name: 'Start manually' }).click();
  await page.getByRole('button', { name: /Open blank Studio/ }).click();
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 30_000 });

  const browser = page.getByRole('region', { name: 'Add data' });
  await browser.getByRole('group', { name: 'Kind of data' }).getByRole('button', { name: /^Tables/ }).click();
  const ordersRow = browser.locator('article.add-data-row.table').filter({ hasText: /^orders/ }).first();
  const customersRow = browser.locator('article.add-data-row.table').filter({ hasText: /^customers/ }).first();
  // Setup drafted it; nothing was made from it yet.
  await expect(ordersRow).toContainText(/Table · Not certified yet/, { timeout: 30_000 });
  // Customers was checked in another App: it is added as that Dataset, never checked into a second copy.
  await expect(customersRow).toContainText('Table · Not certified yet');
  await expect(customersRow.getByRole('button', { name: 'Check customers and add it' })).toHaveCount(0);

  await ordersRow.getByRole('button', { name: 'Check orders and add it' }).click();
  const check = page.getByRole('dialog', { name: 'Check the numbers' });
  await expect(check.getByText(/Each row is one/)).toBeVisible({ timeout: 60_000 });
  // One question for the table, never a Yes/No per column.
  const duplicates = check.getByRole('group', { name: 'Duplicate columns' });
  await expect(duplicates).toContainText('These columns are stored twice, in dollars and in cents: Subtotal and Order total.');
  await expect(duplicates).toContainText('ZLens will use the dollar columns and hide the cents copies.');
  await expect(check.getByText(/stored twice/)).toHaveCount(1);
  await expect(check.getByText(/Yes, use|No, use/)).toHaveCount(0);
  await expect(duplicates.getByRole('button', { name: 'OK' })).toHaveAttribute('aria-pressed', 'true');
  // A running number is offered, never ticked.
  await expect(check.getByRole('checkbox', { name: /Customer order count/ })).not.toBeChecked();
  await expect(check.getByRole('checkbox', { name: /^.*Order total.*Adds up/ }).first()).toBeChecked();
  if (process.env.ZLENS_NAMES_SHOTS_DIR) await page.screenshot({ path: join(process.env.ZLENS_NAMES_SHOTS_DIR, 'cents-question.png') });
  await check.getByRole('button', { name: 'Check and use' }).click();
  await expect(check).toBeHidden({ timeout: 60_000 });

  // The table says what became of it; no second Check and add.
  await expect(ordersRow).toContainText('Table · Not certified yet · added', { timeout: 30_000 });
  await expect(ordersRow.getByRole('button', { name: 'Check orders and add it' })).toHaveCount(0);
  await customersRow.getByRole('button', { name: 'Add customers to App as Customers' }).click();
  await expect(customersRow).toContainText('Table · Not certified yet · added', { timeout: 30_000 });
  if (process.env.ZLENS_NAMES_SHOTS_DIR) await page.screenshot({ path: join(process.env.ZLENS_NAMES_SHOTS_DIR, 'table-states.png') });
});

test('Top customers keeps two Maria Lopez bars; the date filter offers the order date first; quick ranges fill the dates', async ({ page }) => {
  test.setTimeout(180_000);
  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Sales Review', goal: 'Top customers and order trend', domain: 'shop', authoringMode: 'manual', template: 'blank',
  });
  let candidates = await call<{ items: Candidate[] }>(`/api/app-builds/${app.draft.id}/source-candidates?limit=50`);
  if (!candidates.items.some((item) => item.name === 'Orders')) {
    // Run on its own: make Orders from its table here.
    const listing = await call<{ tables: Array<{ id: string; name: string }> }>('/api/app-datasets/tables');
    await call('/api/app-datasets/tables/create', { tableId: listing.tables.find((table) => table.name === 'orders')!.id, name: 'Orders', domain: 'shop' });
    candidates = await call<{ items: Candidate[] }>(`/api/app-builds/${app.draft.id}/source-candidates?limit=50`);
  }
  const customers = candidates.items.find((item) => item.name === 'Customers')!;
  const orders = candidates.items.find((item) => item.name === 'Orders')!;
  await call(`/api/app-builds/${app.draft.id}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [
      { sourceId: customers.sourceId, view: 'chart', title: 'Top customers', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }], orderBy: [{ alias: 'lifetime_spend', direction: 'desc' }], limit: 10 } },
      { sourceId: customers.sourceId, view: 'kpi', title: 'Total spend', query: { dimensions: [], measures: [{ measure: 'lifetime_spend' }] } },
      { sourceId: orders.sourceId, view: 'chart', title: 'Orders trend', query: { dimensions: [{ field: 'ordered_at', timeGrain: 'month' }], measures: [{ measure: 'order_total' }] } },
    ],
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  const firstRun = page.waitForResponse((response) => /\/dashboards\/[^/]+\/run$/.test(response.url()) && response.request().method() === 'POST');
  await page.goto(`${server!.baseUrl}/?appDraft=${app.draft.id}`);
  const result = await (await firstRun).json() as RunResponse;
  const top = result.tiles.find((tile) => tile.title === 'Top customers');
  expect(top?.status).toBe('ok');
  expect(top?.result?.rows?.map((row) => [row.customer_name, Number(row.lifetime_spend)])).toEqual([
    ['Maria Lopez (#C1)', 300],
    ['Maria Lopez (#C2)', 200],
    ['Bob', 50],
  ]);
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });
  const topCard = page.locator('.studio-page-grid .studio-component-card').filter({ hasText: 'Top customers' }).first();
  await expect(topCard.locator('svg').getByText('Maria Lopez (#C1)').first()).toBeVisible({ timeout: 30_000 });
  await expect(topCard.locator('svg').getByText('Maria Lopez (#C2)').first()).toBeVisible();

  // The date filter: the order's own date first; the customer's date says whose it is.
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  const fields = page.locator('.filter-field-results button');
  await expect(fields.first()).toContainText('Ordered At', { timeout: 30_000 });
  await expect(fields.first()).not.toContainText('First Ordered At');
  await expect(fields.first()).toContainText('each row’s own date');
  await expect(fields.filter({ hasText: 'Customer · First Ordered At' })).toHaveCount(1);
  await fields.first().click();
  // Customers has no order date: a different date is offered by its meaning, never as a one-click swap.
  const customersChoice = page.locator('[data-testid="filter-tile-choice"]').filter({ hasText: 'Top Customers' });
  await expect(customersChoice.getByRole('combobox', { name: 'Use a different date on Customers' })).toBeVisible();
  await expect(customersChoice.getByRole('combobox', { name: 'Use a different date on Customers' }).locator('option')).toContainText(['Use a different date…', 'Different meaning: the customer’s First Ordered At']);
  await expect(page.getByRole('button', { name: /^Use First Ordered At on/ })).toHaveCount(0);
  await expect(page.getByText(/Applies to 1 of 3 tiles/)).toBeVisible();
  await page.getByRole('button', { name: 'Create filter' }).click();

  // Quick ranges fill the two dates; Any date clears them.
  const quick = page.getByRole('combobox', { name: 'Ordered At quick range' });
  await expect(quick).toBeVisible({ timeout: 30_000 });
  await quick.selectOption({ label: 'This year' });
  const start = page.getByLabel('Ordered At start');
  const end = page.getByLabel('Ordered At end');
  await expect(start).toHaveValue(/^\d{4}-01-01$/);
  await expect(end).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(quick).toHaveValue('year_to_date');
  if (process.env.ZLENS_NAMES_SHOTS_DIR) await page.screenshot({ path: join(process.env.ZLENS_NAMES_SHOTS_DIR, 'names-dates.png') });
  await quick.selectOption({ label: 'Any date' });
  await expect(start).toHaveValue('');
});
