import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { seedProject } from '../global-setup';
import { repoRoot, run, startNotebookServer, type NotebookServer } from '../support/server';

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
 * A third App (phase-2 review fixes) checks that the editor marks an unlinked
 * tile "Not filtered by …", that a customer past the first 200 values is found
 * by searching (editor and reader), and that a date filter on Ordered At can be
 * mapped by hand to another table's Signed Up On field.
 *
 * It starts its own server on its own copy of the fixture: the certified
 * Dataset and App it adds would change what the shared server's journeys count.
 * Set ZLENS_FILTER_SHOTS_DIR to also save the two documentation screenshots.
 */

let workDir = '';
let server: NotebookServer | null = null;
let draftId = '';
let itemsDraftId = '';
let contactsDraftId = '';
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
  // 261 contacts, more than one page of filter values: "Contact 001" … "Contact
  // 259" first, then "Zelda Zimmer" (past the first 200 alphabetically) and
  // "Ann Archer". Each has its own date field, signed_up_on, not ordered_at.
  const contacts = [
    ...Array.from({ length: 259 }, (_, index) => ({ contact_id: `K${index + 1}`, contact_name: `Contact ${String(index + 1).padStart(3, '0')}`, signed_up_on: '2023-12-01 09:00:00', spend: 1 })),
    { contact_id: 'K900', contact_name: 'Zelda Zimmer', signed_up_on: '2024-01-03 09:00:00', spend: 40 },
    { contact_id: 'K901', contact_name: 'Ann Archer', signed_up_on: '2024-01-04 09:00:00', spend: 60 },
  ];
  const contactsSeed = join(workDir, 'contacts-seed.json');
  writeFileSync(contactsSeed, JSON.stringify({ tables: { crm_contacts: {
    columns: [
      { name: 'contact_id', type: 'text' },
      { name: 'contact_name', type: 'text' },
      { name: 'signed_up_on', type: 'timestamp' },
      { name: 'spend', type: 'decimal' },
    ],
    rows: contacts,
  } } }));
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--seed', contactsSeed, '--connector-root', join(projectDir, '.dql', 'connectors'), '--out', join(projectDir, 'jaffle_shop.duckdb')]);
  server = await startNotebookServer({ projectDir, workDir });

  // One certified Dataset from dim_customers, the way Add data makes one from a table.
  const listing = await call<{ tables: Array<{ id: string; name: string }> }>('/api/app-datasets/tables');
  const table = listing.tables.find((candidate) => candidate.name === 'dim_customers')!;
  const drafted = await call<{ proposal: { measures: Array<{ name: string; include: boolean; format: string }> } }>('/api/app-datasets/tables/draft', { tableId: table.id });
  const created = await call<{ status: string; sourceId: string }>('/api/app-datasets/tables/create', {
    tableId: table.id,
    name: 'Customers',
    domain: 'orders',
    measures: drafted.proposal.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format })),
  });
  // "Check and use", then "I vouch for this — certify" (design Q1).
  expect(created.status).toBe('checked');
  expect((await call<{ status: string }>('/api/app-datasets/certify', { sourceId: created.sourceId })).status).toBe('certified');

  // A manual App with a Dataset tile and a Saved query tile on one page.
  const app = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Customer Review', goal: 'Review customers', domain: 'orders', authoringMode: 'manual', template: 'blank',
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
  const itemsCreated = await call<{ status: string; sourceId: string }>('/api/app-datasets/tables/create', {
    tableId: itemsTable.id,
    name: 'Order items',
    domain: 'orders',
    measures: itemsDraft.proposal.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format })),
  });
  // "Check and use", then "I vouch for this — certify" (design Q1).
  expect(itemsCreated.status).toBe('checked');
  expect((await call<{ status: string }>('/api/app-datasets/certify', { sourceId: itemsCreated.sourceId })).status).toBe('certified');
  const itemsApp = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Item Review', goal: 'Review order items', domain: 'orders', authoringMode: 'manual', template: 'blank',
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

  // Contacts (261 names) next to Order items, in a third App.
  const contactsTable = listing.tables.find((candidate) => candidate.name === 'crm_contacts')!;
  const contactsDraft = await call<{ proposal: { measures: Array<{ name: string; include: boolean; format: string; from?: string }> } }>('/api/app-datasets/tables/draft', { tableId: contactsTable.id });
  const contactsCreated = await call<{ status: string; sourceId: string }>('/api/app-datasets/tables/create', {
    tableId: contactsTable.id,
    name: 'Contacts',
    domain: 'orders',
    measures: contactsDraft.proposal.measures.map((measure) => ({ name: measure.name, include: measure.include, format: measure.format })),
  });
  // "Check and use", then "I vouch for this — certify" (design Q1).
  expect(contactsCreated.status).toBe('checked');
  expect((await call<{ status: string }>('/api/app-datasets/certify', { sourceId: contactsCreated.sourceId })).status).toBe('certified');
  const contactsApp = await call<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Contact Review', goal: 'Review contacts', domain: 'orders', authoringMode: 'manual', template: 'blank',
  });
  contactsDraftId = contactsApp.draft.id;
  const contactCandidates = await call<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${contactsDraftId}/source-candidates?limit=50`);
  const contactSourceId = (name: string) => contactCandidates.items.find((candidate) => candidate.name === name)!.sourceId;
  const spendMeasure = contactsDraft.proposal.measures.find((measure) => measure.include && (measure.from === 'spend' || measure.name === 'spend'))!.name;
  await call(`/api/app-builds/${contactsDraftId}/compose`, {
    expectedRevision: contactsApp.draft.revision,
    expectedProposalHash: contactsApp.draft.proposalHash,
    mode: 'manual',
    selections: [
      { sourceId: contactSourceId('Contacts'), view: 'table', title: 'Spend by contact', query: { dimensions: [{ field: 'contact_name' }], measures: [{ measure: spendMeasure }] } },
      { sourceId: contactSourceId('Order items'), view: 'table', title: 'Items by day', query: { dimensions: [{ field: 'ordered_at', timeGrain: 'day' }], measures: [{ measure: countMeasure }] } },
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
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });

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
  await page.getByRole('dialog', { name: 'Ready to publish' }).getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page).toHaveURL(/app=customer-review/, { timeout: 60_000 });

  // A reader picks a customer: the Dataset tile narrows; the Saved query tile says it was not filtered.
  await page.goto(`${server!.baseUrl}/?app=customer-review&page=overview`);
  // The reader's value list is a searchable control, like the editor's.
  const customer = page.getByRole('button', { name: /^Customer Name: / });
  await expect(customer).toBeVisible({ timeout: 60_000 });
  await customer.click();
  await page.getByRole('option', { name: 'Alice', exact: true }).click();
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
  await expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 });

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
  await page.getByRole('dialog', { name: 'Ready to publish' }).getByRole('button', { name: 'Publish', exact: true }).click();
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

test('the editor marks unlinked tiles, finds a value past the first 200, and maps a date filter by hand', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?appDraft=${contactsDraftId}`);
  const spendTile = page.getByRole('group', { name: 'App tile: Spend by contact' });
  const itemsTile = page.getByRole('group', { name: 'App tile: Items by day' });
  await expect(spendTile.getByText(/Showing 1–10 of 261 rows/)).toBeVisible({ timeout: 60_000 });
  await expect(itemsTile.getByText('Showing 1–4 of 4 rows')).toBeVisible({ timeout: 60_000 });

  // A Contact Name filter links only its own data; the Order items tile is
  // marked "Not filtered by Contact Name" while editing, before any value.
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'New filter' }).click();
  await page.locator('.filter-field-results button').filter({ hasText: 'Contact Name' }).first().click();
  await page.getByRole('button', { name: 'Create filter' }).click();
  await expect(itemsTile.getByText('Not filtered by Contact Name')).toBeVisible({ timeout: 30_000 });
  await expect(spendTile.getByText('Not filtered by Contact Name')).toHaveCount(0);

  // The list holds the first 200 names and says how to reach the rest;
  // searching finds Zelda Zimmer, who is past the first 200.
  const contactControl = page.locator('.studio-page-filterbar details.studio-filter.dropdown');
  await contactControl.locator('summary').click();
  await expect(contactControl.getByText('Type to search all 261 values')).toBeVisible({ timeout: 30_000 });
  await expect(contactControl.getByRole('button', { name: 'Zelda Zimmer', exact: true })).toHaveCount(0);
  const searched = page.waitForResponse((response) => response.url().endsWith('/api/app-datasets/field-values')
    && (JSON.parse(response.request().postData() ?? '{}') as { search?: string }).search === 'Zelda');
  await contactControl.getByPlaceholder('Search values').fill('Zelda');
  await searched;
  await contactControl.getByRole('button', { name: 'Zelda Zimmer', exact: true }).click();
  await expect(spendTile.getByText(/Showing 1–1 of 1 rows?/)).toBeVisible({ timeout: 60_000 });
  await expect(itemsTile.getByText('Not filtered by Contact Name')).toBeVisible();
  if (shotsDir) await page.screenshot({ path: join(shotsDir, '12-editor-not-filtered.png') });
  // Preview shows readers' view: the selected value still marks the unlinked tile.
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(itemsTile.getByText('Not filtered by Contact Name')).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  // Back to every contact for the date check.
  await contactControl.locator('summary').click();
  await contactControl.getByRole('button', { name: 'All values', exact: true }).click();
  await expect(spendTile.getByText(/Showing 1–10 of 261 rows/)).toBeVisible({ timeout: 60_000 });

  // An Ordered At date filter: Contacts has no Ordered At, so the Filters tab
  // offers its own date field. Nothing is mapped until the author picks it.
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('button', { name: 'Add another filter' }).click();
  await page.locator('.filter-field-results button').filter({ hasText: 'Ordered At' }).first().click();
  const contactsChoice = page.getByRole('radiogroup', { name: 'Does this filter apply to Spend By Contact?' });
  await expect(contactsChoice.getByRole('radio', { name: 'Applies' })).toBeDisabled();
  await page.getByRole('button', { name: 'Use Signed Up On on Contacts' }).click();
  await expect(contactsChoice.getByRole('radio', { name: 'Applies' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Applies to 2 of 2 tiles')).toBeVisible();
  await page.getByRole('button', { name: 'Create filter' }).click();
  await expect(page.getByLabel('Ordered At start')).toBeVisible({ timeout: 30_000 });

  // From 3 Jan 2024: Order items keeps 3 and 4 January, Contacts keeps the two
  // who signed up from that day, through Signed Up On.
  await page.getByLabel('Ordered At start').fill('2024-01-03');
  await expect(itemsTile.getByText('Showing 1–2 of 2 rows')).toBeVisible({ timeout: 60_000 });
  await expect(spendTile.getByText('Showing 1–2 of 2 rows')).toBeVisible({ timeout: 60_000 });
  await expect(spendTile.getByText('Zelda Zimmer')).toBeVisible();
  await expect(spendTile.getByText('Not filtered by Ordered At')).toHaveCount(0);

  // Published, a reader searches the same way.
  await page.getByLabel('Ordered At start').fill('');
  await page.getByRole('button', { name: 'Review and publish to Project' }).click();
  await expect(page.getByText('Ready to publish')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('dialog', { name: 'Ready to publish' }).getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page).toHaveURL(/app=contact-review/, { timeout: 60_000 });
  await page.goto(`${server!.baseUrl}/?app=contact-review&page=overview`);
  const readerContact = page.getByRole('button', { name: /^Contact Name: / });
  await expect(readerContact).toBeVisible({ timeout: 60_000 });
  await readerContact.click();
  await expect(page.getByText('Type to search all 261 values')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search Contact Name' }).fill('zimmer');
  if (shotsDir) {
    await expect(page.getByRole('option', { name: 'Zelda Zimmer', exact: true })).toBeVisible();
    await page.screenshot({ path: join(shotsDir, '13-reader-value-search.png') });
  }
  await page.getByRole('option', { name: 'Zelda Zimmer', exact: true }).click();
  await expect(page.getByText(/Showing 1–1 of 1 rows?/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Not filtered by Contact Name')).toBeVisible();
});

test('a filter value left in this browser by an earlier App is ignored; a remembered one shows in the control with Reset', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // An earlier session on the same port and App id left a single customer for
  // a filter that has since been re-created (no record of which filter it was for).
  await page.goto(`${server!.baseUrl}/`);
  await page.evaluate(() => {
    window.localStorage.setItem('dql.apps.dashboard-filter-values.v1:customer-review', JSON.stringify({
      draft: { customer_name: 'Bob' },
      applied: { customer_name: 'Bob' },
    }));
  });
  const readerVariables: Array<Record<string, unknown>> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/apps\/[^/]+\/dashboards\/[^/]+\/run$/.test(request.url())) {
      readerVariables.push((JSON.parse(request.postData() ?? '{}') as RunRequest).variables ?? {});
    }
  });
  await page.goto(`${server!.baseUrl}/?app=customer-review&page=overview`);
  const customer = page.getByRole('button', { name: /^Customer Name: / });
  await expect(customer).toHaveAccessibleName('Customer Name: All', { timeout: 60_000 });
  await expect(page.getByText('Showing 1–3 of 3 rows')).toBeVisible({ timeout: 60_000 });
  // Nothing narrowed the page while the control said All.
  expect(readerVariables.length).toBeGreaterThan(0);
  expect(readerVariables.some((variables) => variables.customer_name === 'Bob')).toBe(false);
  await expect(page.getByText('Opened with your last filters')).toHaveCount(0);
  await expect(page.getByText('Not filtered by Customer Name')).toHaveCount(0);

  // A value picked now is remembered for this filter, and shown when the page opens again.
  await customer.click();
  await page.getByRole('option', { name: 'Alice', exact: true }).click();
  await expect(page.getByText('Not filtered by Customer Name')).toBeVisible({ timeout: 60_000 });
  readerVariables.length = 0;
  await page.reload();
  await expect(page.getByRole('button', { name: /^Customer Name: / })).toHaveAccessibleName('Customer Name: Alice', { timeout: 60_000 });
  await expect(page.getByText('Opened with your last filters')).toBeVisible();
  await expect.poll(() => readerVariables.some((variables) => variables.customer_name === 'Alice'), { timeout: 30_000 }).toBe(true);
  await page.locator('.dql-app-filter-reset').click();
  await expect(page.getByRole('button', { name: /^Customer Name: / })).toHaveAccessibleName('Customer Name: All', { timeout: 30_000 });
  await expect(page.getByText('Opened with your last filters')).toHaveCount(0);
});

test('the reader\'s review appendix writes a date range in words and counts both data sources', async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${server!.baseUrl}/?app=item-review&page=overview`);
  const from = page.getByLabel('Ordered At from');
  await expect(from).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Showing 1–4 of 4 rows')).toBeVisible({ timeout: 60_000 });
  await from.fill('2024-01-01');
  await page.getByLabel('Ordered At to').fill('2024-01-03');
  await expect(page.getByText('Showing 1–3 of 3 rows').first()).toBeVisible({ timeout: 60_000 });
  const appendix = page.getByRole('group', { name: 'Evidence and review appendix' });
  await expect(appendix.locator('summary').first()).toContainText('2 data sources', { timeout: 60_000 });
  await appendix.locator('summary').first().click();
  await expect(appendix).toContainText('Ordered At: 1 Jan 2024 – 3 Jan 2024');
  await expect(appendix).not.toContainText('[object Object]');
  await expect(appendix).not.toContainText('ordered_at:');
  await expect(appendix).not.toContainText('1 sources');
});
