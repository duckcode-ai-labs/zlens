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
 * "1 table not certified yet" → Review and certify → "I vouch for this —
 * certify" (design Q1) → Publish to Project → the reader shows real numbers
 * and "All 3 tiles certified" with NO reload, never "superseded", after
 * exactly one page run, and the header says the data was certified by you.
 * Back on the Apps list, the card agrees with the App.
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
  // Checked · Needs certifying: it is certified on purpose at publish (design Q1).
  expect(created.status).toBe('checked');

  // A manual App with three tiles on one page.
  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Sales Review', goal: 'Review sales', domain: 'orders', authoringMode: 'manual', sourcePolicy: 'governed_only', template: 'blank',
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
  // Design Q1: "Only certified data" holds publishing until the table is certified on purpose.
  const notCertified = page.getByRole('region', { name: '1 table not certified yet' });
  await expect(notCertified).toBeVisible({ timeout: 60_000 });
  await expect(notCertified).toContainText('Checked · Needs certifying');
  await notCertified.getByRole('button', { name: 'Review and certify Customers' }).click();
  const review = page.getByRole('dialog', { name: 'Certify Customers' });
  await expect(review.getByText(/is filled and different on every row, checked just now/)).toBeVisible({ timeout: 60_000 });
  await review.getByRole('button', { name: 'I vouch for this — certify' }).click();
  await expect(review).toBeHidden({ timeout: 60_000 });
  await expect(page.getByText('Ready to publish')).toBeVisible({ timeout: 90_000 });
  await page.getByRole('dialog', { name: 'Ready to publish' }).getByRole('button', { name: 'Publish to Project', exact: true }).click();
  await expect(page).toHaveURL(/app=sales-review/, { timeout: 60_000 });

  // No reload: the page publishing opened shows the published App's results.
  await expect(page.getByText('All 3 tiles certified')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.dql-kpi-value').filter({ hasText: '$380.00' })).toBeVisible();
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible();
  await expect(page.getByText('No result.')).toHaveCount(0);
  await expect(page.getByText(/superseded/i)).toHaveCount(0);
  await expect(page.getByText(/\d+ of 3 tiles certified/i)).toHaveCount(0);
  // D5 and design Q1: the header says who certified the data, from the reader's side, and when.
  await expect(page.getByText(/^All data certified by you · \d{1,2} [A-Z][a-z]{2}/)).toBeVisible();
  // Publishing ran the page once, and that run is the one on screen.
  expect(readerRuns).toHaveLength(1);
  expect(readerResponses.some((response) => response.stale)).toBe(false);

  // The Apps card reads the same trust as the App.
  // The header's "← Apps" (the sidebar's Apps button comes first).
  await page.getByRole('button', { name: 'Apps', exact: true }).last().click();
  const card = page.locator('article.dql-app-card').filter({ hasText: 'Sales Review' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/^App certified( by .+)? · \d{1,2} [A-Z][a-z]{2}/)).toBeVisible();
  // D6: Pages and Updated, without the zero counts.
  await expect(card.getByText('Updated')).toBeVisible();
  await expect(card.getByText(/Books|local insights|Shared Project/)).toHaveCount(0);
  await expect(card.getByText(/\d+ of 3 tiles certified/i)).toHaveCount(0);
});
