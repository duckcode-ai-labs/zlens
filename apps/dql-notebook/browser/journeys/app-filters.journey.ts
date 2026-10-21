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
 * "Does not apply" → publishing is allowed → a reader who picks a customer
 * sees the Dataset tile narrowed and "Not filtered by Customer Name" on the
 * Saved query tile.
 *
 * It starts its own server on its own copy of the fixture: the certified
 * Dataset and App it adds would change what the shared server's journeys count.
 * Set ZLENS_FILTER_SHOTS_DIR to also save the two documentation screenshots.
 */

let workDir = '';
let server: NotebookServer | null = null;
let draftId = '';
const shotsDir = process.env.ZLENS_FILTER_SHOTS_DIR;

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
