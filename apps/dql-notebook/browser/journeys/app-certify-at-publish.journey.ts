import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedProject } from '../global-setup';
import { startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Design Q1, "Certified feels like a self-stamp", against the built
 * `zlens notebook` CLI on the jaffle-supply-chain fixture:
 *
 * a new manual App → Add data → "Check and use" on a database table (it is
 * checked, Not certified yet, never certified) → a tile from one of its
 * measures works right away → Publish is ready and lists the tile not
 * certified yet with "Certify now (recommended)" (T3) → the short review
 * (what one row is, the row key checked again, number formats) → "I vouch
 * for this — certify" → All checks passed → published: "All tiles certified",
 * and the tile reads "Certified by you".
 *
 * The Data list's ⋯ menu opens the same review (T4).
 *
 * It starts its own server on its own copy of the fixture: the Dataset and App
 * it adds would change what the shared server's journeys count.
 * ZLENS_CERTIFY_SHOTS_DIR saves 18-certify-at-publish.png (the review).
 */

let workDir = '';
let server: NotebookServer | null = null;
const shotsDir = process.env.ZLENS_CERTIFY_SHOTS_DIR;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-certify-'));
  const projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });
  // A sample project, as the dbt sample ships (B6): its configured owner is a
  // team, and its certified saved query was certified by that team, not by
  // whoever opens the sample.
  const configPath = join(projectDir, 'dql.config.json');
  writeFileSync(configPath, `${JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf8')), identity: { owner: 'analytics@jaffle.shop' } }, null, 2)}\n`);
  mkdirSync(join(projectDir, 'semantic-layer', 'blocks'), { recursive: true });
  writeFileSync(join(projectDir, 'semantic-layer', 'blocks', 'top_customers.yaml'), [
    'name: top_customers',
    'block: top_customers',
    'certification:',
    '  certifiedBy: analytics@jaffle.shop',
    "  certifiedAt: '2026-10-16T12:00:00.000Z'",
    '  via: cli',
    '  rules: oss',
    '',
  ].join('\n'));
  // R01: a saved query nobody certified yet, used through its result fields.
  writeFileSync(join(projectDir, 'blocks', 'product_probe.dql'), [
    '// dql-format: 1',
    '',
    'block "product_probe" {',
    '  domain = "orders"',
    '  type = "custom"',
    '  status = "draft"',
    '  description = "Revenue and items sold for each product."',
    '  owner = "analytics@example.com"',
    '  grain = "one row per product"',
    '  outputs = ["product_name", "probe_revenue", "items_sold"]',
    '  dimensions = ["product_name"]',
    '  query = """',
    '    SELECT product_name, SUM(product_price) AS probe_revenue, COUNT(*) AS items_sold',
    '    FROM order_items',
    '    GROUP BY product_name',
    '  """',
    '  tests {',
    '    assert row_count > 0',
    '  }',
    '}',
    '',
  ].join('\n'));
  server = await startNotebookServer({ projectDir, workDir });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('checking a table does not certify it; certifying is a short review from the publish dialog, then "Certified by you"', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server!.baseUrl);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Build new App' }).click();
  await page.getByRole('tab', { name: 'Start manually' }).click();
  await page.getByRole('button', { name: /^Continue to data/ }).click();
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 30_000 });

  const browser = page.getByRole('region', { name: 'Add data' });
  // The sample's certified saved query names the team that certified it, never "you" (B6).
  const sampleQuery = browser.locator('article.add-data-row').filter({ hasText: 'Top Customers' }).first();
  await expect(sampleQuery).toContainText(/Certified by Analytics \(jaffle\.shop\) · 16 Oct( 2026)?/, { timeout: 30_000 });
  await expect(sampleQuery).not.toContainText('Certified by you');

  // Add data → Check and add on a table nobody checked yet.
  await browser.getByRole('group', { name: 'Kind of data' }).getByRole('button', { name: /^Tables/ }).click();
  const tableRow = browser.locator('article.add-data-row.table').filter({ hasText: 'dim_customers' }).first();
  await expect(tableRow).toContainText('Not certified yet', { timeout: 30_000 });
  await tableRow.getByRole('button', { name: 'Check dim_customers and add it' }).click();
  const check = page.getByRole('dialog', { name: 'Check the numbers' });
  await expect(check.getByText(/Each row is one/)).toBeVisible({ timeout: 60_000 });
  await check.getByLabel('Name').fill('Customers');
  // The main button checks; it never certifies.
  await expect(check.getByRole('button', { name: /Certify/ })).toHaveCount(0);
  await check.getByRole('button', { name: 'Check and use' }).click();
  await expect(check).toBeHidden({ timeout: 60_000 });
  await expect(browser.getByRole('status').filter({ hasText: 'Customers · Not certified yet' })).toBeVisible({ timeout: 30_000 });
  await expect(browser.getByRole('status').filter({ hasText: /Checked by you · \d{1,2} [A-Z][a-z]{2}, not certified yet\. Build tiles now; certify it when you are ready\./ })).toBeVisible();
  // There is no per-App data rule to show or change (T3).
  await expect(page.getByText(/Data rule|Only certified data|data that needs review/)).toHaveCount(0);
  await expect(browser.getByRole('button', { name: 'Remove Customers from this App' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Open Studio with 1 source/ }).click();

  // The Data pane says what it is; a tile from one of its measures works right away.
  const dataPane = page.locator('.data-panel');
  await expect(dataPane.locator('.dataset-current')).toContainText('Customers');
  await expect(dataPane.locator('.dataset-current')).toContainText('Table · Not certified yet');
  // The Data list's ⋯ menu opens the same short review as the publish dialog (T4).
  await dataPane.getByRole('button', { name: 'More for Customers' }).click();
  await dataPane.getByRole('menuitem', { name: /Certify…/ }).click();
  const fromMenu = page.getByRole('dialog', { name: 'Certify Customers' });
  await expect(fromMenu.getByRole('region', { name: 'What one row is' })).toBeVisible({ timeout: 60_000 });
  await fromMenu.getByRole('button', { name: 'Not now' }).click();
  await expect(fromMenu).toBeHidden();
  await dataPane.locator('button.data-field').filter({ hasText: 'Lifetime Spend' }).click();
  await expect(page.locator('article.draft-tile')).toBeVisible();
  await page.getByRole('button', { name: 'Add to page' }).click();
  await expect(page.locator('article.draft-tile')).toHaveCount(0);
  const card = page.locator('.studio-page-grid .studio-component-card').filter({ hasText: 'Lifetime Spend' }).first();
  await expect(card.locator('.dql-kpi-value')).toHaveText('$380.00', { timeout: 60_000 });

  // Publish is ready (T3); the tile not certified yet is listed with Certify now.
  await page.getByRole('button', { name: 'Review and publish to Project' }).click();
  const ready = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(ready).toBeVisible({ timeout: 90_000 });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('0 of 1 tile certified');
  const notCertified = ready.getByRole('region', { name: '1 tile not certified yet' });
  await expect(notCertified).toContainText('Lifetime Spend');
  await expect(notCertified).toContainText('Checked, not certified yet. Data: Customers.');
  await expect(ready.getByText('Readers will see \u2018Not certified yet\u2019 on 1 tile.')).toBeVisible();
  // "Certify now (recommended)" stays on one line inside its button, even when
  // the item's text wraps to two lines (the 0.2.8 overflow seen at 1440×900).
  await notCertified.locator('li small').first().evaluate((node) => {
    node.textContent = 'Changed since it was certified on 15 Oct. Data: Beverage Revenue By Product, a much longer name that has to wrap.';
  });
  const certifyNow = notCertified.getByRole('button', { name: 'Certify now: Customers' });
  const fit = await certifyNow.evaluate((node) => {
    const button = node as HTMLElement;
    // One client rect per line box the text was laid out on.
    const lineCount = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top))).size;
    };
    return {
      overflowY: button.scrollHeight - button.clientHeight,
      overflowX: button.scrollWidth - button.clientWidth,
      lines: lineCount(button),
      textLines: lineCount(button.closest('li')!.querySelector('small')!),
    };
  });
  expect(fit).toMatchObject({ overflowY: 0, overflowX: 0, lines: 1 });
  expect(fit.textLines).toBeGreaterThanOrEqual(2);
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await ready.screenshot({ path: join(shotsDir, '17-certify-now-button.png') });
  }
  await certifyNow.click();

  // The short review: what one row is, the key checked again now, number formats.
  const review = page.getByRole('dialog', { name: 'Certify Customers' });
  await expect(review.getByRole('region', { name: 'What one row is' })).toContainText(/Each row is one .+\(customer_id\)\./, { timeout: 60_000 });
  await expect(review.getByText(/customer_id is filled and different on every row, checked just now\./)).toBeVisible();
  await expect(review.getByRole('region', { name: 'Number formats' })).toContainText('Lifetime Spend: Money (USD)');
  await expect(review.getByRole('region', { name: 'Columns hidden as duplicates' })).toContainText('None.');
  await expect(review.getByText(/Checked by you · /)).toBeVisible();
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, '18-certify-at-publish.png') });
  }
  await review.getByRole('button', { name: 'I vouch for this — certify' }).click();
  await expect(review).toBeHidden({ timeout: 60_000 });

  // Certified: the page runs again and every check passes.
  await expect(ready.getByText('All checks passed')).toBeVisible({ timeout: 120_000 });
  await ready.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page).toHaveURL(/app=/, { timeout: 60_000 });

  // The reader's side: one count, and the tile says certified by you, with the date.
  await expect(page.locator('.dql-trust-summary')).toHaveText('All tiles certified', { timeout: 60_000 });
  await expect(page.locator('.dql-app-view-topbar .dql-app-seal').first()).toHaveText('All tiles certified');
  await expect(page.locator('.dql-trust-badge.certified').filter({ hasText: /^Certified by you · \d{1,2} [A-Z][a-z]{2}/ }).first()).toBeVisible();
});

test('a saved query certified from the publish check is adopted in place: 0 of 1 becomes All tiles certified (R01)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server!.baseUrl);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Build new App' }).click();
  await page.getByRole('tab', { name: 'Start manually' }).click();
  await page.getByRole('button', { name: /^Continue to data/ }).click();
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 30_000 });

  const browser = page.getByRole('region', { name: 'Add data' });
  await browser.getByRole('group', { name: 'Kind of data' }).getByRole('button', { name: /^Saved queries/ }).click();
  const probeRow = browser.locator('article.add-data-row').filter({ hasText: 'Product Probe' }).first();
  await expect(probeRow).toContainText('Not certified yet', { timeout: 30_000 });
  await browser.getByRole('button', { name: 'Add to App: Product Probe' }).click();
  await expect(browser.getByRole('button', { name: 'Remove Product Probe from this App' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Open Studio with 1 source/ }).click();

  // A KPI from one of its result fields.
  const dataPane = page.locator('.data-panel');
  await expect(dataPane.locator('.dataset-current')).toContainText('Product Probe');
  await dataPane.locator('button.data-field').filter({ hasText: 'Probe Revenue' }).click();
  await expect(page.locator('article.draft-tile')).toBeVisible();
  await page.getByRole('button', { name: 'Add to page' }).click();
  await expect(page.locator('article.draft-tile')).toHaveCount(0);
  const card = page.locator('.studio-page-grid .studio-component-card').filter({ hasText: 'Probe Revenue' }).first();
  await expect(card.locator('.dql-kpi-value')).toBeVisible({ timeout: 60_000 });
  const before = (await card.locator('.dql-kpi-value').textContent())?.trim();

  // Publish → Certify now → the passing review → I vouch for this — certify.
  await page.getByRole('button', { name: 'Review and publish to Project' }).click();
  const ready = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('0 of 1 tile certified', { timeout: 90_000 });
  await ready.getByRole('button', { name: 'Certify now: Product Probe' }).click();
  const review = page.getByRole('dialog', { name: 'Certify Product Probe' });
  const vouch = review.getByRole('button', { name: 'I vouch for this — certify' });
  await expect(vouch).toBeEnabled({ timeout: 90_000 });
  await vouch.click();
  await expect(review).toBeHidden({ timeout: 90_000 });

  // The App moves to the certified version in place: no refusal, the count is 1 of 1.
  await expect(ready.getByText('All checks passed')).toBeVisible({ timeout: 120_000 });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('All tiles certified');
  await expect(page.getByText(/data version and contract|couldn.t switch to the newly certified/)).toHaveCount(0);
  await expect(page.locator('.studio-trust-count')).toHaveText('All tiles certified');
  await expect(card.locator('.dql-kpi-value')).toHaveText(before ?? '');
});
