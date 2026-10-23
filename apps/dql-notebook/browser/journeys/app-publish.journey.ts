import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedProject } from '../global-setup';
import { startNotebookServer, type NotebookServer } from '../support/server';

/**
 * B1: a just-published App opens on its results, against the built
 * `zlens notebook` CLI on the jaffle-supply-chain fixture.
 *
 * A page with three tiles (a chart and a KPI from a checked Dataset, and a
 * certified Saved query) and a Customer Name filter → Review and publish →
 * "Ready to publish · 1 of 3 tiles certified", the two tiles not certified
 * yet listed with "Certify now (recommended)" (T3: publishing is not blocked)
 * → Certify now → "I vouch for this — certify" (design Q1) → Publish → the
 * reader shows real numbers and "All tiles certified" with NO reload, never
 * "superseded", after exactly one page run, and each tile says it was
 * certified by you. Back on the Apps list, the card agrees with the App.
 *
 * The bug: opening a page with filters ran it twice (before and after the
 * filter defaults loaded). When the two requests reached the server out of
 * order, the older one cancelled the newer and the reader was left on "A newer
 * dashboard interaction superseded this run." with no Run button. The first
 * reader run is held back a few milliseconds in transit here, which is how the
 * order flipped on a real machine, so a second run would fail this journey.
 *
 * It starts its own server on its own copy of the fixture: the certified
 * Dataset and App it adds would change what the shared server's journeys count.
 */

let workDir = '';
let server: NotebookServer | null = null;
let draftId = '';

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
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-apppublish-'));
  const projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });
  server = await startNotebookServer({ projectDir, workDir });

  // One checked Dataset from dim_customers, the way Add data's "Check and use" makes one from a table.
  const listing = await call<{ tables: Array<{ id: string; name: string }> }>('/api/app-datasets/tables');
  const table = listing.tables.find((candidate) => candidate.name === 'dim_customers')!;
  const drafted = await call<{ proposal: { measures: Array<{ name: string; include: boolean; format: string }> } }>('/api/app-datasets/tables/draft', { tableId: table.id });
  const created = await call<{ status: string }>('/api/app-datasets/tables/create', {
    tableId: table.id,
    name: 'Customers',
    domain: 'orders',
    measures: drafted.proposal.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format })),
  });
  // Checked, not certified yet: it is certified on purpose, here from the publish dialog (design Q1).
  expect(created.status).toBe('checked');

  // A manual App with three tiles on one page.
  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Sales Review', goal: 'Review sales', domain: 'orders', authoringMode: 'manual', template: 'blank',
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
      { sourceId: sourceId('Customers'), view: 'kpi', title: 'Total spend', query: { dimensions: [], measures: [{ measure: 'lifetime_spend' }] } },
      { sourceId: sourceId('top_customers'), view: 'table', title: 'Top customers' },
    ],
  });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a just-published App opens on its results: real numbers, all tiles certified, no reload', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.getByText('Top customers').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible({ timeout: 60_000 });

  // A page filter: the reader seeds its default, which used to start a second run.
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  await page.locator('.filter-field-results button').filter({ hasText: 'Customer Name' }).click();
  await page.getByRole('button', { name: 'Create filter' }).click();
  await expect(page.getByText('3 linked tiles')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('All tiles up to date')).toBeVisible({ timeout: 60_000 });

  // Every reader page run from here on, with the first one held back in transit.
  const readerRuns: unknown[] = [];
  const readerResponses: Array<{ stale?: boolean }> = [];
  let held = false;
  await page.route('**/api/apps/*/dashboards/*/run', async (route) => {
    readerRuns.push(route.request().postDataJSON());
    if (!held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    await route.continue();
  });
  page.on('response', async (response) => {
    if (!/\/api\/apps\/[^/]+\/dashboards\/[^/]+\/run$/.test(new URL(response.url()).pathname)) return;
    try { readerResponses.push(await response.json()); } catch { /* body gone with the page */ }
  });

  await page.getByRole('button', { name: 'Review and publish to Project' }).click();
  // T3: nothing blocks publishing; the two tiles on the checked table are listed, certifying recommended.
  const ready = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(ready).toBeVisible({ timeout: 60_000 });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('1 of 3 tiles certified');
  const notCertified = ready.getByRole('region', { name: '2 tiles not certified yet' });
  await expect(notCertified).toContainText('Checked, not certified yet.');
  await expect(ready.getByText('Readers will see \u2018Not certified yet\u2019 on 2 tiles.')).toBeVisible();
  await expect(ready.getByText(/Needs certifying|Only certified data|needs review/)).toHaveCount(0);
  await notCertified.getByRole('button', { name: 'Certify now: Customers' }).first().click();
  const review = page.getByRole('dialog', { name: 'Certify Customers' });
  await expect(review.getByText(/is filled and different on every row, checked just now/)).toBeVisible({ timeout: 60_000 });
  await review.getByRole('button', { name: 'I vouch for this — certify' }).click();
  await expect(review).toBeHidden({ timeout: 60_000 });
  // B6: every tile is certified, so — and only so — the dialog says every check passed.
  await expect(ready.getByText('All checks passed')).toBeVisible({ timeout: 90_000 });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('All tiles certified');
  await expect(ready.getByRole('region', { name: /not certified yet/ })).toHaveCount(0);
  await ready.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page).toHaveURL(/app=sales-review/, { timeout: 60_000 });

  // No reload: the page publishing opened shows the published App's results.
  await expect(page.locator('.dql-trust-summary')).toHaveText('All tiles certified', { timeout: 60_000 });
  await expect(page.locator('.dql-kpi-value').filter({ hasText: '$380.00' })).toBeVisible();
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible();
  await expect(page.getByText('No result.')).toHaveCount(0);
  await expect(page.getByText(/superseded/i)).toHaveCount(0);
  await expect(page.getByText(/\d+ of 3 tiles certified/i)).toHaveCount(0);
  // T2: the header says the same count; each tile says who certified it, from the reader's side, and when.
  await expect(page.locator('.dql-app-view-topbar .dql-app-seal').first()).toHaveText('All tiles certified');
  await expect(page.locator('.dql-trust-badge.certified').filter({ hasText: /^Certified by you · \d{1,2} [A-Z][a-z]{2}/ }).first()).toBeVisible();
  await expect(page.getByText(/Not certified yet/)).toHaveCount(0);
  // Publishing ran the page once, and that run is the one on screen.
  expect(readerRuns).toHaveLength(1);
  expect(readerResponses.some((response) => response.stale)).toBe(false);

  // The Apps card reads the same trust as the App.
  // The header's "← Apps" (the sidebar's Apps button comes first).
  await page.getByRole('button', { name: 'Apps', exact: true }).last().click();
  const card = page.locator('article.dql-app-card').filter({ hasText: 'Sales Review' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('All tiles certified')).toBeVisible();
  await expect(card.getByText(/App certified/)).toHaveCount(0);
  // D6: Pages and Updated, without the zero counts.
  await expect(card.getByText('Updated')).toBeVisible();
  await expect(card.getByText(/Books|local insights|Shared Project/)).toHaveCount(0);
  await expect(card.getByText(/\d+ of 3 tiles certified/i)).toHaveCount(0);
});

/**
 * C1: Publish clicked while a change is still saving waits for it. Choosing
 * data and adding a tile saves in the background; Publish used to be disabled
 * meanwhile, so a click right after did nothing and said nothing. Here the
 * save is held in transit for a few seconds: the Publish click is taken at
 * once (well before the save lands), the button says "Saving changes…", and
 * the review opens on the saved draft, new tile included.
 */
test('Publish right after choosing data waits for the save, then opens the review (no silent no-op)', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Saving Review', goal: 'Review spend', domain: 'orders', authoringMode: 'manual', template: 'blank',
  });
  const candidates = await call<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${app.draft.id}/source-candidates?limit=50`);
  const customers = candidates.items.find((candidate) => candidate.name === 'Customers')!.sourceId;
  await call(`/api/app-builds/${app.draft.id}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [{ sourceId: customers, view: 'kpi', title: 'Total spend', query: { dimensions: [], measures: [{ measure: 'lifetime_spend' }] } }],
  });
  await page.goto(`${server!.baseUrl}/?appDraft=${app.draft.id}`);
  await expect(page.getByText('Total spend').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.data-panel button.data-field').filter({ hasText: 'Lifetime Spend' })).toBeVisible({ timeout: 60_000 });

  // Every save from here is held in transit, so it is still saving when Publish is clicked.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let heldSaves = 0;
  await page.route(`**/api/app-builds/${app.draft.id}**`, async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH' || request.url().endsWith('/compose')) {
      heldSaves += 1;
      await held;
    }
    await route.continue();
  });

  // Choose data in the Data panel and add it to the page.
  const dataPane = page.locator('.data-panel');
  await dataPane.locator('button.data-field').filter({ hasText: 'Customer Name' }).click();
  await dataPane.locator('button.data-field').filter({ hasText: 'Lifetime Spend' }).click();
  await page.getByRole('button', { name: 'Add to page' }).click();
  await expect.poll(() => heldSaves, { timeout: 15_000 }).toBeGreaterThan(0);

  // Publish while it is saving: the click is taken, never ignored.
  const publish = page.getByRole('button', { name: /^Review and publish to Project/ });
  await publish.click({ timeout: 3_000 });
  await expect(publish).toHaveText(/Saving changes…/);
  await expect(page.getByRole('dialog', { name: /publish|Run the page/ })).toHaveCount(0);

  release();
  const review = page.getByRole('dialog', { name: /publish|Run the page/ });
  await expect(review).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.studio-error')).toHaveCount(0);
  // The review is of the saved draft: the tile added just before Publish is in it.
  const saved = await call<{ drafts: Array<{ id: string; pages: Array<{ layout: { items: Array<{ title?: string }> } }> }> }>('/api/app-builds');
  const tiles = saved.drafts.find((candidate) => candidate.id === app.draft.id)!.pages[0]!.layout.items.map((item) => item.title);
  expect(tiles).toHaveLength(2);
  await expect(review).toContainText(/2 tiles|All tiles certified|of 2 tiles/);
});
