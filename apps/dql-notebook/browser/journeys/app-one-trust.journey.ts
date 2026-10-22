import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { seedProject } from '../global-setup';
import { startNotebookServer, type NotebookServer } from '../support/server';

/**
 * One trust model (T1–T3), against the built `zlens notebook` CLI on the
 * jaffle-supply-chain fixture:
 *
 * an App with four tiles — three on certified Customers, one on Orders,
 * checked but not certified → Publish is ready (nothing blocks it): "3 of 4
 * tiles certified", the Orders tile listed with "Certify now (recommended)",
 * and "Readers will see 'Not certified yet' on 1 tile" → Publish → the reader
 * shows "Not certified yet" on that tile, "Certified by you" on the others,
 * and "3 of 4 tiles certified" in the header and on the Apps card, as the
 * stored dql.app.json records it.
 *
 * Then the project requires certified data (`apps.requireCertifiedToPublish:
 * true` in dql.config.json, read at the next publish, no restart): the same
 * App waits — one plain sentence, no Publish button, and the server refuses
 * with APP_BUILD_REQUIRES_CERTIFIED — until Orders is certified from the
 * dialog; then it publishes and the reader says "All tiles certified".
 *
 * Then a saved query certifies inside the publish dialog (T4): it runs, its
 * test passes, nobody owns it so the review asks, "I vouch for this —
 * certify", and the count says All tiles certified without leaving the App.
 * Edited afterwards, the publish dialog says "Changed since it was certified
 * on …".
 *
 * It starts its own server on its own copy of the fixture. ZLENS_TRUST_SHOTS_DIR
 * saves 20-publish-one-trust.png and 21-reader-not-certified.png.
 */

let workDir = '';
let projectDir = '';
let server: NotebookServer | null = null;
const shotsDir = process.env.ZLENS_TRUST_SHOTS_DIR;
let customersId = '';
let ordersId = '';
let spendMeasure = '';
let orderMeasure = '';

async function call<T>(path: string, body?: unknown, method = 'POST'): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server!.baseUrl}${path}`, body === undefined
    ? {}
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as T };
}

async function ok<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const result = await call<T>(path, body, method);
  if (result.status >= 400) throw new Error(`${path}: HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 800)}`);
  return result.body;
}

/** A Dataset from one warehouse table, the way Add data's "Check and use" makes one. */
async function checkTable(table: string, name: string): Promise<{ sourceId: string; measures: string[] }> {
  const listing = await ok<{ tables: Array<{ id: string; name: string }> }>('/api/app-datasets/tables', undefined, 'GET');
  const found = listing.tables.find((candidate) => candidate.name === table);
  if (!found) throw new Error(`No ${table} in ${listing.tables.map((candidate) => candidate.name).join(', ')}`);
  const drafted = await ok<{ proposal: { measures: Array<{ name: string; include: boolean; format: string }> } }>('/api/app-datasets/tables/draft', { tableId: found.id });
  const created = await ok<{ status: string; sourceId: string }>('/api/app-datasets/tables/create', {
    tableId: found.id,
    name,
    domain: 'orders',
    measures: drafted.proposal.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format })),
  });
  expect(created.status).toBe('checked');
  return { sourceId: created.sourceId, measures: drafted.proposal.measures.filter((measure) => measure.include).map((measure) => measure.name) };
}

/** A manual App with the same four tiles: three on Customers, one on Orders. */
async function fourTileApp(name: string): Promise<string> {
  const app = await ok<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name, goal: 'Review sales', domain: 'orders', authoringMode: 'manual', template: 'blank',
  });
  const candidates = await ok<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${app.draft.id}/source-candidates?limit=50`, undefined, 'GET');
  const id = (sourceName: string) => candidates.items.find((candidate) => candidate.name === sourceName)!.sourceId;
  await ok(`/api/app-builds/${app.draft.id}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [
      { sourceId: id('Customers'), view: 'kpi', title: 'Total spend', query: { dimensions: [], measures: [{ measure: spendMeasure }] } },
      { sourceId: id('Customers'), view: 'chart', title: 'Spend by customer', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: spendMeasure }] } },
      { sourceId: id('Customers'), view: 'table', title: 'Spend table', query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: spendMeasure }] } },
      { sourceId: id('Orders'), view: 'kpi', title: 'Order total', query: { dimensions: [], measures: [{ measure: orderMeasure }] } },
    ],
  });
  return app.draft.id;
}

async function openPublishDialog(page: Page, draftId: string) {
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: /^Review and publish to Project/ }).click();
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-onetrust-'));
  projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });
  // A saved query nobody owns or certified yet, with one test (T4).
  writeFileSync(join(projectDir, 'blocks', 'top_spenders.dql'), [
    '// dql-format: 1',
    '',
    'block "top_spenders" {',
    '  domain = "orders"',
    '  type = "custom"',
    '  status = "draft"',
    '  description = "The five customers who spent the most."',
    '  dimensions = ["customer"]',
    '  query = """',
    '    SELECT customer_name, lifetime_spend',
    '    FROM dim_customers',
    '    ORDER BY lifetime_spend DESC',
    '    LIMIT 5',
    '  """',
    '  tests {',
    '    assert row_count > 0',
    '  }',
    '}',
    '',
  ].join('\n'));
  server = await startNotebookServer({ projectDir, workDir });

  // Customers: checked, then certified on purpose. Orders: checked, not certified yet.
  const customers = await checkTable('dim_customers', 'Customers');
  customersId = customers.sourceId;
  spendMeasure = customers.measures.find((measure) => measure.includes('spend')) ?? customers.measures[0]!;
  const certified = await ok<{ ok: boolean; status?: string }>('/api/app-datasets/certify', { sourceId: customersId });
  expect(certified.status).toBe('certified');
  const orders = await checkTable('fct_orders', 'Orders');
  ordersId = orders.sourceId;
  orderMeasure = orders.measures.find((measure) => measure === 'order_total') ?? orders.measures[0]!;
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('publishing is never blocked by trust: one tile reads Not certified yet, and every surface says 3 of 4 tiles certified', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const draftId = await fourTileApp('Sales Trust');
  await openPublishDialog(page, draftId);

  const ready = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(ready).toBeVisible({ timeout: 90_000 });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('3 of 4 tiles certified');
  const list = ready.getByRole('region', { name: '1 tile not certified yet' });
  await expect(list.getByRole('listitem', { name: 'Not certified yet: Order total' })).toContainText('Checked, not certified yet. Data: Orders.');
  await expect(list.getByRole('button', { name: 'Certify now: Orders' })).toHaveText('Certify now (recommended)');
  await expect(ready.getByText('Readers will see ‘Not certified yet’ on 1 tile.')).toBeVisible();
  await expect(ready.getByText(/Needs review|Needs certifying|Only certified data|data that needs review|data rule/i)).toHaveCount(0);
  if (shotsDir) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, '20-publish-one-trust.png') });
  }
  await ready.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page).toHaveURL(/app=sales-trust/, { timeout: 60_000 });

  // The reader: the Orders tile says Not certified yet; the others who certified them; one count.
  await expect(page.locator('.dql-trust-summary')).toHaveText('3 of 4 tiles certified', { timeout: 60_000 });
  await expect(page.locator('.dql-app-view-topbar .dql-app-seal').first()).toHaveText('3 of 4 tiles certified');
  await expect(page.locator('.dql-trust-badge.review')).toHaveCount(1);
  await expect(page.locator('.dql-trust-badge.review')).toHaveText(/Not certified yet/);
  await expect(page.locator('.dql-trust-badge.certified').filter({ hasText: /^Certified by you · \d{1,2} [A-Z][a-z]{2}/ })).toHaveCount(3);
  await expect(page.getByText(/Needs review|Governed|All data certified/)).toHaveCount(0);
  if (shotsDir) await page.screenshot({ path: join(shotsDir, '21-reader-not-certified.png') });

  // The stored file records the same count, and the Apps card reads it.
  const stored = JSON.parse(readFileSync(join(projectDir, 'apps', 'sales-trust', 'dql.app.json'), 'utf8')) as { tileTrust?: unknown; lifecycle?: string };
  expect(stored.tileTrust).toEqual({ certified: 3, total: 4 });
  expect(stored.lifecycle).not.toBe('certified');
  await page.getByRole('button', { name: 'Apps', exact: true }).last().click();
  const card = page.locator('article.dql-app-card').filter({ hasText: 'Sales Trust' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('3 of 4 tiles certified')).toBeVisible();
  await expect(card.getByText(/App certified|All tiles certified/)).toHaveCount(0);
});

test('when the project requires certified data, publishing waits for the certify action, server and client', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const configPath = join(projectDir, 'dql.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, `${JSON.stringify({ ...config, apps: { ...((config.apps as Record<string, unknown> | undefined) ?? {}), requireCertifiedToPublish: true } }, null, 2)}\n`);
  expect((await ok<{ requireCertifiedToPublish: boolean }>('/api/apps/settings', undefined, 'GET')).requireCertifiedToPublish).toBe(true);

  const draftId = await fourTileApp('Sales Trust Required');
  await openPublishDialog(page, draftId);
  const review = page.getByRole('dialog', { name: '1 fix before publishing' });
  await expect(review).toBeVisible({ timeout: 90_000 });
  await expect(review.getByText('This project requires every tile to be certified before an App is published.')).toBeVisible();
  await expect(review.locator('.readiness-trust-count')).toHaveText('3 of 4 tiles certified');
  await expect(review.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);

  // The server refuses too, with the one plain message.
  const current = await ok<{ draft: { revision: number; proposalHash: string } }>(`/api/app-builds/${draftId}`, undefined, 'GET');
  const refused = await call<{ errors?: string[] }>(`/api/app-builds/${draftId}/publish-to-project`, { expectedRevision: current.draft.revision, proposalHash: current.draft.proposalHash });
  expect(refused.status).toBe(400);
  expect(refused.body.errors).toContain('APP_BUILD_REQUIRES_CERTIFIED: This project requires every tile to be certified before an App is published. Not certified yet: Order total.');

  // Certify Orders from the dialog: then it publishes.
  await review.getByRole('button', { name: 'Certify now: Orders' }).click();
  const certify = page.getByRole('dialog', { name: 'Certify Orders' });
  await expect(certify.getByRole('button', { name: 'I vouch for this — certify' })).toBeEnabled({ timeout: 60_000 });
  await certify.getByRole('button', { name: 'I vouch for this — certify' }).click();
  await expect(certify).toBeHidden({ timeout: 60_000 });
  const ready = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(ready.getByText('All checks passed')).toBeVisible({ timeout: 120_000 });
  await ready.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page).toHaveURL(/app=sales-trust-required/, { timeout: 60_000 });
  await expect(page.locator('.dql-trust-summary')).toHaveText('All tiles certified', { timeout: 60_000 });
  await expect(page.locator('.dql-trust-badge.review')).toHaveCount(0);
  void customersId;
  void ordersId;
});

test('a saved query certifies inside the publish dialog; edited afterwards, it says when it was certified (T4)', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Back to the open-source default: publishing is not gated on trust.
  const configPath = join(projectDir, 'dql.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, `${JSON.stringify({ ...config, apps: { ...((config.apps as Record<string, unknown> | undefined) ?? {}), requireCertifiedToPublish: false } }, null, 2)}\n`);

  const app = await ok<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Top Spenders', goal: 'Our best customers', domain: 'orders', authoringMode: 'manual', template: 'blank',
  });
  const candidates = await ok<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${app.draft.id}/source-candidates?limit=50`, undefined, 'GET');
  const spenders = candidates.items.find((candidate) => candidate.name === 'top_spenders');
  expect(spenders, candidates.items.map((candidate) => candidate.name).join(', ')).toBeDefined();
  await ok(`/api/app-builds/${app.draft.id}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [{ sourceId: spenders!.sourceId, view: 'table', title: 'Top spenders' }],
  });
  await openPublishDialog(page, app.draft.id);
  const ready = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('0 of 1 tile certified', { timeout: 90_000 });
  const item = ready.getByRole('listitem', { name: 'Not certified yet: Top spenders' });
  await item.getByRole('button', { name: 'Certify now: Top Spenders' }).click();

  // The short review, here: it runs, its test passes, who owns it, what one row is.
  const review = page.getByRole('dialog', { name: 'Certify Top Spenders' });
  await expect(review.getByRole('region', { name: 'It runs' })).toContainText(/Ran just now: \d+ rows?\./, { timeout: 90_000 });
  await expect(review.getByRole('region', { name: 'Its tests pass' })).toContainText('Its one test passes.');
  await expect(review.getByRole('region', { name: 'What one row is' })).toContainText('One row for each customer.');
  await expect(review.getByRole('button', { name: 'Open in the saved query editor' })).toBeVisible();
  const vouch = review.getByRole('button', { name: 'I vouch for this — certify' });
  // Nobody owns it yet: the review asks, and the button waits for an answer.
  await expect(vouch).toBeDisabled();
  await review.getByRole('textbox', { name: 'Owner' }).fill('Maria Lopez');
  await expect(vouch).toBeEnabled();
  await vouch.click();
  await expect(review).toBeHidden({ timeout: 90_000 });

  // The count updates in place; the App never left the screen.
  await expect(ready.locator('.readiness-trust-count')).toHaveText('All tiles certified', { timeout: 120_000 });
  await expect(ready.getByText('All checks passed')).toBeVisible();
  // Still in the App: the publish dialog never closed.
  await expect(ready).toBeVisible();
  const written = readFileSync(join(projectDir, 'blocks', 'top_spenders.dql'), 'utf8');
  expect(written).toContain('owner = "Maria Lopez"');
  expect(written).toContain('status = "certified"');
  const receipt = readFileSync(join(projectDir, 'semantic-layer', 'blocks', 'top_spenders.yaml'), 'utf8');
  expect(receipt).toContain('reviewStatus: certified');
  expect(receipt).toContain('Owner: Maria Lopez');
  await ready.getByRole('button', { name: 'Back to editing' }).click();

  // Someone edits the file afterwards: no longer certified, and the review says since when.
  writeFileSync(join(projectDir, 'blocks', 'top_spenders.dql'), written.replace('LIMIT 5', 'LIMIT 6'));
  await page.goto(`${server!.baseUrl}/?appDraft=${app.draft.id}`);
  const dataPane = page.locator('.data-panel');
  await dataPane.locator('.dataset-current').click({ timeout: 90_000 });
  await page.getByRole('menuitemradio', { name: /^Top Spenders/ }).click();
  await expect(dataPane.locator('.dataset-current')).toContainText('Not certified yet', { timeout: 60_000 });
  await dataPane.getByRole('button', { name: 'More for Top Spenders' }).click();
  await dataPane.getByRole('menuitem', { name: /Certify…/ }).click();
  const again = page.getByRole('dialog', { name: 'Certify Top Spenders' });
  await expect(again.getByText(/^Changed since it was certified on \d{1,2} [A-Z][a-z]{2}/)).toBeVisible({ timeout: 90_000 });
});
