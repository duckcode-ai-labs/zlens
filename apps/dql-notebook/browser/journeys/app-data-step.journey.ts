import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { seedProject } from '../global-setup';
import { run, startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Choose the App's data first (design D3), against the built `zlens notebook`
 * CLI on the jaffle-supply-chain fixture: Apps → Build new App → Start manually
 * → Open blank Studio → the Data step → add one certified Dataset → Open canvas
 * → the Data pane shows it → click a measure → a new tile is drafted.
 *
 * Everything you add has fields (design D1): the Data step is one list with
 * chips instead of tabs. A certified saved query (monthly_revenue) shows its
 * result columns as fields with no review step, so Month + Gross Revenue is one
 * line shown as it is, and top_customers by Customer Name is a bar that sums
 * Lifetime Spend, with the receipt saying it was rolled up.
 *
 * It starts its own server on its own copy of the fixture: the certified
 * Dataset and saved query it adds would change what the shared server's
 * journeys count. Set ZLENS_APPDATA_SHOTS_DIR to also save the documentation
 * screenshots.
 */

let workDir = '';
let server: NotebookServer | null = null;
const DATASET = 'Journey Customers';
const shotsDir = process.env.ZLENS_APPDATA_SHOTS_DIR;

/** The fixture's order items are all in January 2024: two more months make a trend. */
const MORE_ORDER_ITEMS = `INSERT INTO order_items VALUES
  ('I8', 'O5', 'P1', 'Burger', 'food', 8, TIMESTAMP '2024-02-03 12:00:00'),
  ('I9', 'O5', 'P3', 'Cola', 'drink', 3, TIMESTAMP '2024-02-03 12:00:00'),
  ('I10', 'O6', 'P4', 'Salad', 'food', 6, TIMESTAMP '2024-02-20 18:30:00'),
  ('I11', 'O7', 'P1', 'Burger', 'food', 8, TIMESTAMP '2024-03-01 11:00:00'),
  ('I12', 'O7', 'P2', 'Fries', 'food', 4, TIMESTAMP '2024-03-01 11:00:00'),
  ('I13', 'O8', 'P1', 'Burger', 'food', 8, TIMESTAMP '2024-03-15 19:00:00'),
  ('I14', 'O8', 'P3', 'Cola', 'drink', 3, TIMESTAMP '2024-03-15 19:00:00')`;

const TRIPLE_QUOTE = '"'.repeat(3);
const MONTHLY_REVENUE = [
  '// dql-format: 1',
  '',
  'block "monthly_revenue" {',
  '  domain = "orders"',
  '  type = "custom"',
  '  status = "certified"',
  '  description = "Revenue and orders for each month."',
  '  tags = ["revenue", "trend"]',
  '  owner = "analytics@example.com"',
  '  outputs = ["month", "gross_revenue", "order_count"]',
  `  query = ${TRIPLE_QUOTE}`,
  "    SELECT date_trunc('month', ordered_at) AS month, SUM(product_price) AS gross_revenue, COUNT(DISTINCT order_id) AS order_count",
  '    FROM order_items',
  '    GROUP BY 1',
  '    ORDER BY 1',
  `  ${TRIPLE_QUOTE}`,
  '}',
  '',
].join('\n');

type DraftTile = { i: string; title?: string; block?: unknown; viz: { type: string }; query?: { dimensions: Array<{ field: string; timeGrain?: string }>; measures: Array<{ measure: string }> } };
type DraftSummary = { id: string; pages: Array<{ id: string; layout: { items: DraftTile[] } }> };
type RunTile = { title?: string; status: string; trustState?: string; result?: { rows: Array<Record<string, unknown>> }; dataset?: { validation?: { outcome: string; adaptations: Array<{ kind: string; message: string }> } } };

async function openDataStep(page: Page): Promise<void> {
  await page.goto(server!.baseUrl);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Build new App' }).click();
  await page.getByRole('tab', { name: 'Start manually' }).click();
  await page.getByRole('button', { name: /Open blank Studio/ }).click();
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-appdata-'));
  const projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });
  // A certified saved query with no Dataset definition, over three months of order items.
  const duckdbModule = join(projectDir, '.dql', 'connectors', 'node_modules', 'duckdb');
  const warehouse = join(projectDir, 'jaffle_shop.duckdb');
  run('node', ['-e', `const duckdb = require(${JSON.stringify(duckdbModule)}); const db = new duckdb.Database(${JSON.stringify(warehouse)}); db.exec(${JSON.stringify(MORE_ORDER_ITEMS)}, (error) => { if (error) { console.error(error); process.exit(1); } db.close(() => process.exit(0)); });`]);
  writeFileSync(join(projectDir, 'blocks', 'monthly_revenue.dql'), MONTHLY_REVENUE);
  server = await startNotebookServer({ projectDir, workDir });

  // One certified Dataset from a database table, through the same calls the
  // Add data list makes for a table (check, then certify).
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
  })).json() as { ok: boolean; status?: string; sourceId?: string; error?: string; blockers?: string[] };
  expect(created.ok, created.error).toBe(true);
  // "Check and use" leaves it Checked · Needs certifying; certifying is its own step (design Q1).
  expect(created.status, (created.blockers ?? []).join(' ')).toBe('checked');
  const certified = await (await fetch(`${base}/api/app-datasets/certify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: created.sourceId }),
  })).json() as { ok: boolean; status?: string; error?: string };
  expect(certified.status, certified.error).toBe('certified');
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
  // One list with chips, not tabs (design D1): a table, a saved query and a table not checked yet side by side.
  await expect(browser.getByRole('tab')).toHaveCount(0);
  const kinds = browser.getByRole('group', { name: 'Kind of data' });
  for (const chip of ['All', 'Tables', 'Saved queries', 'Metrics']) await expect(kinds.getByRole('button', { name: new RegExp(`^${chip}`) })).toBeVisible();
  await expect(browser.locator('article.add-data-row').filter({ hasText: DATASET }).first()).toContainText('Table · Certified');
  await expect(browser.locator('article.add-data-row').filter({ hasText: 'Monthly Revenue' }).first()).toContainText('Saved query · Certified');
  await expect(browser.locator('article.add-data-row.table').filter({ hasText: 'fct_orders' }).first()).toContainText('Table · Not checked yet', { timeout: 30_000 });

  await browser.getByRole('button', { name: `Add to App: ${DATASET}` }).click();
  await expect(browser.getByRole('button', { name: `Remove ${DATASET} from this App` })).toBeVisible({ timeout: 30_000 });
  const openCanvas = page.getByRole('button', { name: /Open Studio with 1 source/ });
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

test('a saved query has fields: Month + Gross Revenue is one line, Customer Name sums Lifetime Spend', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDataStep(page);
  const browser = page.getByRole('region', { name: 'Add data' });

  // Its fields show when it is opened, with no review step; Make row-level waits under ⋯.
  const monthly = browser.locator('article.add-data-row').filter({ hasText: 'Monthly Revenue' }).first();
  await expect(monthly).toContainText('Saved query · Certified · Orders');
  await expect(browser.getByText('Add fields')).toHaveCount(0);
  await browser.getByRole('button', { name: 'Show details for Monthly Revenue' }).click();
  await expect(monthly.getByRole('heading', { name: 'Measures' })).toBeVisible({ timeout: 30_000 });
  await expect(monthly.getByRole('heading', { name: 'Time' })).toBeVisible();
  await expect(monthly).toContainText('Gross Revenue');
  await expect(monthly).toContainText('Grouped by its own columns, values show as they are');
  await monthly.getByRole('button', { name: 'More for Monthly Revenue' }).click();
  await expect(monthly.getByRole('menuitem', { name: /Make row-level/ })).toContainText('Only needed for row-safe measures');
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, '12-one-list.png') });
  }
  await monthly.getByRole('button', { name: 'More for Monthly Revenue' }).click();
  // The Saved queries chip narrows the same list.
  await browser.getByRole('group', { name: 'Kind of data' }).getByRole('button', { name: /^Saved queries/ }).click();
  await expect(browser.locator('article.add-data-row.table')).toHaveCount(0);
  await expect(browser.locator('article.add-data-row').filter({ hasText: 'Top Customers' }).first()).toBeVisible();

  await browser.getByRole('button', { name: 'Add to App: Monthly Revenue' }).click();
  await expect(browser.getByRole('button', { name: 'Remove Monthly Revenue from this App' })).toBeVisible({ timeout: 30_000 });
  await browser.getByRole('button', { name: 'Add to App: Top Customers' }).click();
  await expect(browser.getByRole('button', { name: 'Remove Top Customers from this App' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Open Studio with 2 sources/ }).click();

  // Month + Gross Revenue on the same shelves as any Dataset: one line, as it is.
  const dataPane = page.locator('.data-panel');
  await expect(dataPane.locator('.dataset-current')).toContainText('Monthly Revenue');
  await expect(dataPane.locator('.dataset-current')).toContainText('Saved query · Certified');
  // A time field's name is never cut off by its grain list ("month · quarter · year").
  const monthName = dataPane.locator('button.data-field').filter({ hasText: /^\s*Month/ }).locator('.name');
  await expect(monthName).toHaveText('Month');
  expect(await monthName.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dataPane.locator('button.data-field').filter({ hasText: /^\s*Month/ }).click();
  await dataPane.locator('button.data-field').filter({ hasText: 'Gross Revenue' }).click();
  const draftTile = page.locator('article.draft-tile');
  await expect(draftTile).toHaveAttribute('aria-label', 'New tile: Gross Revenue by month');
  await expect(draftTile).not.toContainText('Order Count');
  await page.getByRole('button', { name: 'Add to page' }).click();
  await expect(draftTile).toHaveCount(0);
  // Deselect before building the next tile.
  await page.keyboard.press('Escape');

  // Top customers: Customer Name + Lifetime Spend is a bar that sums the rows.
  await dataPane.locator('.dataset-current').click();
  await dataPane.getByRole('menuitemradio', { name: /Top Customers/ }).click();
  await expect(dataPane.locator('.dataset-current')).toContainText('Top Customers');
  await expect(dataPane.locator('.field-groups').getByRole('heading', { name: 'Measures' })).toBeVisible({ timeout: 30_000 });
  await dataPane.locator('button.data-field').filter({ hasText: 'Customer Name' }).click();
  await dataPane.locator('button.data-field').filter({ hasText: 'Lifetime Spend' }).click();
  await expect(draftTile).toHaveAttribute('aria-label', 'New tile: Lifetime Spend by customer name');
  await page.getByRole('button', { name: 'Add to page' }).click();
  await expect(draftTile).toHaveCount(0);

  // What was saved: field tiles over the saved queries, not fixed block tiles.
  const draft = await page.evaluate(async () => {
    const response = await fetch('/api/app-builds');
    const body = await response.json() as { drafts: DraftSummary[] };
    return body.drafts.find((candidate) => candidate.pages.some((page) => page.layout.items.some((item) => item.title === 'Gross Revenue by month')));
  });
  expect(draft).toBeDefined();
  const items = draft!.pages[0]!.layout.items;
  const line = items.find((item) => item.title === 'Gross Revenue by month');
  const bar = items.find((item) => item.title === 'Lifetime Spend by customer name');
  expect(line, JSON.stringify(items.map((item) => item.title))).toMatchObject({ viz: { type: 'line' }, query: { dimensions: [{ field: 'month', timeGrain: 'month' }], measures: [{ measure: 'gross_revenue' }] } });
  expect(line!.block).toBeUndefined();
  expect(bar).toMatchObject({ viz: { type: 'bar' }, query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }] } });

  // What they show: the line reads the saved query's rows as they are; the bar sums them and says so.
  const ran = await page.evaluate(async (draftId) => {
    const response = await fetch(`/api/app-builds/${encodeURIComponent(draftId)}/dashboards/${encodeURIComponent('overview')}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullRun: true }),
    });
    return response.json() as Promise<{ tiles: RunTile[] }>;
  }, draft!.id);
  const lineRun = ran.tiles.find((tile) => tile.title === 'Gross Revenue by month')!;
  expect(lineRun).toMatchObject({ status: 'ok', trustState: 'certified', dataset: { validation: { outcome: 'covered', adaptations: [] } } });
  expect(lineRun.result!.rows.map((row) => Number(row.gross_revenue))).toEqual([40, 17, 23]);
  const barRun = ran.tiles.find((tile) => tile.title === 'Lifetime Spend by customer name')!;
  expect(barRun).toMatchObject({ status: 'ok', trustState: 'certified', dataset: { validation: { outcome: 'adapted', adaptations: [{ kind: 'saved_query_rollup', message: 'Rolled up from the certified result of top_customers.' }] } } });
  expect(barRun.result!.rows.map((row) => [row.customer_name, Number(row.lifetime_spend)]).sort()).toEqual([['Alice', 150], ['Bob', 200], ['Carol', 30]]);

  // On the canvas the bar says it was rolled up from the saved query (an info
  // icon in its header, so the result stays visible); the line does not.
  const barCard = page.locator('.studio-page-grid .studio-component-card').filter({ hasText: 'Lifetime Spend by customer name' });
  await expect(barCard.locator('header .tile-adapted-note')).toHaveAttribute('aria-label', /Rolled up from a saved query/, { timeout: 30_000 });
  const lineCard = page.locator('.studio-page-grid .studio-component-card').filter({ hasText: 'Gross Revenue by month' });
  await expect(lineCard.locator('.tile-adapted-note')).toHaveCount(0);
  if (shotsDir) {
    await page.keyboard.press('Escape');
    await dataPane.locator('.dataset-current').click();
    await dataPane.getByRole('menuitemradio', { name: /Monthly Revenue/ }).click();
    await expect(dataPane.locator('.field-groups').getByRole('heading', { name: 'Measures' })).toBeVisible();
    await page.screenshot({ path: join(shotsDir, '13-saved-query-fields.png') });
  }
});
