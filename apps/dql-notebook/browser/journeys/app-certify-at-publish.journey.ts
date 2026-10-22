import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
 * Checked · Needs certifying, never certified) → a tile from one of its
 * measures works right away under "Only certified data" → Publish says
 * "1 table not certified yet" → the short review (what one row is, the row
 * key checked again, number formats) → "I vouch for this — certify" → Ready
 * to publish → published, and the header reads "All data certified by you".
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
  server = await startNotebookServer({ projectDir, workDir });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('checking a table does not certify it; certifying is a short review at publish, then "All data certified by you"', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server!.baseUrl);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  await page.getByRole('button', { name: 'Build new App' }).click();
  await page.getByRole('tab', { name: 'Start manually' }).click();
  await page.getByRole('button', { name: /Open blank Studio/ }).click();
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 30_000 });

  // Add data → Check and add on a table nobody checked yet.
  const browser = page.getByRole('region', { name: 'Add data' });
  await browser.getByRole('group', { name: 'Kind of data' }).getByRole('button', { name: /^Tables/ }).click();
  const tableRow = browser.locator('article.add-data-row.table').filter({ hasText: 'dim_customers' }).first();
  await expect(tableRow).toContainText('Not checked yet', { timeout: 30_000 });
  await tableRow.getByRole('button', { name: 'Check dim_customers and add it' }).click();
  const check = page.getByRole('dialog', { name: 'Check the numbers' });
  await expect(check.getByText(/Each row is one/)).toBeVisible({ timeout: 60_000 });
  await check.getByLabel('Name').fill('Customers');
  // The main button checks; it never certifies.
  await expect(check.getByRole('button', { name: /Certify/ })).toHaveCount(0);
  await check.getByRole('button', { name: 'Check and use' }).click();
  await expect(check).toBeHidden({ timeout: 60_000 });
  await expect(browser.getByRole('status').filter({ hasText: 'Customers · Checked · Needs certifying' })).toBeVisible({ timeout: 30_000 });
  await expect(browser.getByRole('status').filter({ hasText: /Checked by you · \d{1,2} [A-Z][a-z]{2}\. Build tiles now; certify it before you publish\./ })).toBeVisible();
  // Under "Only certified data" it was added without changing the data rule.
  await expect(browser.getByText('Data rule: Only certified data')).toBeVisible();
  await expect(browser.getByRole('button', { name: 'Remove Customers from this App' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Open Studio with 1 source/ }).click();

  // The Data pane says what it is; a tile from one of its measures works right away.
  const dataPane = page.locator('.data-panel');
  await expect(dataPane.locator('.dataset-current')).toContainText('Customers');
  await expect(dataPane.locator('.dataset-current')).toContainText('Table · Checked · Needs certifying');
  await dataPane.locator('button.data-field').filter({ hasText: 'Lifetime Spend' }).click();
  await expect(page.locator('article.draft-tile')).toBeVisible();
  await page.getByRole('button', { name: 'Add to page' }).click();
  await expect(page.locator('article.draft-tile')).toHaveCount(0);
  const card = page.locator('.studio-page-grid .studio-component-card').filter({ hasText: 'Lifetime Spend' }).first();
  await expect(card.locator('.dql-kpi-value')).toHaveText('$380.00', { timeout: 60_000 });

  // Publish: "Only certified data" holds it until the table is certified on purpose.
  await page.getByRole('button', { name: 'Review and publish to Project' }).click();
  const notCertified = page.getByRole('region', { name: '1 table not certified yet' });
  await expect(notCertified).toBeVisible({ timeout: 90_000 });
  await expect(notCertified).toContainText('Customers');
  await expect(notCertified).toContainText('Table · Checked · Needs certifying');
  await expect(page.getByText('Ready to publish')).toHaveCount(0);
  await notCertified.getByRole('button', { name: 'Review and certify Customers' }).click();

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

  // Certified: the page runs again and the check is ready.
  const ready = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(ready).toBeVisible({ timeout: 120_000 });
  await ready.getByRole('button', { name: 'Publish to Project', exact: true }).click();
  await expect(page).toHaveURL(/app=/, { timeout: 60_000 });

  // The reader's side: certified by you, with the date.
  await expect(page.getByText(/^All data certified by you · \d{1,2} [A-Z][a-z]{2}/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('All 1 tile certified')).toBeVisible();
});
