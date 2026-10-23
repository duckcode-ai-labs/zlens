import { clip, expect, openAndRecord } from './support/clip-test';

const DATASET = 'Customers';

/**
 * Make the sample's `customers` table a certified Dataset, through the same
 * calls Add data makes for a database table (check, then certify). The
 * sample ships saved queries but no Dataset, and a Dataset is what the App
 * builder picks fields from.
 */
async function certifyCustomersDataset(baseUrl: string): Promise<void> {
  const post = async (path: string, body: unknown) => (await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const tableId = 'warehouse.dev.customers';
  const drafted = await post('/api/app-datasets/tables/draft', { tableId }) as {
    ok: boolean; error?: string; proposal?: { measures: Array<{ name: string; include: boolean; format: string }> };
  };
  expect(drafted.ok, drafted.error).toBe(true);
  const created = await post('/api/app-datasets/tables/create', {
    tableId,
    name: DATASET,
    domain: 'commerce',
    measures: drafted.proposal!.measures.map(({ name, include, format }) => ({ name, include, format })),
  }) as { ok: boolean; status?: string; sourceId?: string; error?: string; blockers?: string[] };
  expect(created.ok, created.error).toBe(true);
  // "Check and use", then "I vouch for this — certify" (design Q1).
  expect(created.status, (created.blockers ?? []).join(' ')).toBe('checked');
  const certified = await post('/api/app-datasets/certify', { sourceId: created.sourceId }) as { status?: string; error?: string };
  expect(certified.status, certified.error).toBe('certified');
}

/**
 * Apps: build an App by hand (pick a Domain, add a certified Dataset in the
 * Data step, click a measure, add the tile), then start one from Quick start:
 * pick the data, then a total, a trend and a top list, and Build App. The
 * server has no AI provider; nothing reaches a model.
 */
clip('app-builder', async ({ page, sample, director }) => {
  const server = await sample.serve(sample.freshProject(), { ai: false });
  await certifyCustomersDataset(server.baseUrl);
  await openAndRecord(page, director, server.baseUrl);

  // 1. Start manually, in the Commerce domain.
  await director.click(page.getByRole('button', { name: 'Apps', exact: true }).first(), { after: 400 });
  await director.click(page.getByRole('button', { name: 'Build new App' }));
  await director.click(page.getByRole('tab', { name: 'Start manually' }), { after: 300 });
  await director.type(page.getByRole('textbox', { name: 'What should this App be called?' }), 'Customer Overview', { clear: true });
  const domain = page.getByRole('combobox', { name: 'Domain' });
  await director.point(domain);
  await domain.selectOption({ label: 'Commerce' });
  await director.beat(700);
  await director.click(page.getByRole('button', { name: /^Continue to data/ }), { after: 300 });

  // 2. Data for this App: add a certified Dataset and see its fields.
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 30_000 });
  const browser = page.getByRole('region', { name: 'Add data' });
  const row = browser.locator('article.add-data-row').filter({ hasText: DATASET }).first();
  await expect(row).toContainText('Table · Certified');
  await director.beat(600);
  await director.point(row);
  await director.beat(900);
  await director.click(browser.getByRole('button', { name: `Show details for ${DATASET}` }), { after: 500 });
  await expect(row.getByRole('heading', { name: 'Measures' })).toBeVisible();
  await director.point(row.getByRole('heading', { name: 'Measures' }));
  await director.beat(1200);
  await director.click(browser.getByRole('button', { name: `Add to App: ${DATASET}` }), { after: 300 });
  await expect(browser.getByRole('button', { name: `Remove ${DATASET} from this App` })).toBeVisible({ timeout: 30_000 });
  await director.beat(700);
  await director.click(page.getByRole('button', { name: /Open Studio with 1 source/ }), { after: 400 });

  // 3. On the canvas, click a measure: a new tile; then add it to the page.
  await director.click(page.locator('.data-panel button.data-field').filter({ hasText: /^Σ\s*Lifetime Spend\s*sum$/ }), { after: 300 });
  const draftTile = page.locator('article.draft-tile');
  await director.fastForward(() => expect(draftTile).toContainText('Lifetime Spend', { timeout: 30_000 }));
  await director.beat(1200);
  await director.click(page.getByRole('button', { name: 'Add to page' }), { after: 400 });
  await expect(draftTile).toHaveCount(0);
  await director.point(page.locator('.studio-page-grid .studio-component-card').first());
  await director.beat(1500);

  // 4. With no AI provider connected, Quick start (round-2 design Q2): pick the
  // data, then a total, a trend and a top list; Build App makes exactly those tiles.
  await director.click(page.getByRole('button', { name: 'Back to Apps' }), { after: 400 });
  await director.click(page.getByRole('button', { name: 'Build new App' }));
  await director.click(page.getByRole('tab', { name: 'Quick start' }), { after: 300 });
  await expect(page.getByRole('tab', { name: 'Quick start' })).toHaveAttribute('aria-selected', 'true');
  await director.beat(700);
  await director.click(page.getByRole('button', { name: 'Choose data' }), { after: 300 });
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 30_000 });
  const quickBrowser = page.getByRole('region', { name: 'Add data' });
  await director.click(quickBrowser.getByRole('button', { name: `Add to App: ${DATASET}` }), { after: 300 });
  await expect(quickBrowser.getByRole('button', { name: `Remove ${DATASET} from this App` })).toBeVisible({ timeout: 30_000 });
  await director.click(page.getByRole('button', { name: 'Next: choose tiles' }), { after: 400 });
  const choices = page.getByRole('list', { name: 'Tiles to build' });
  await expect(choices.getByRole('listitem').first()).toBeVisible();
  director.poster();
  await director.point(choices.getByRole('listitem').first());
  await director.beat(1400);
  await director.point(choices.getByRole('listitem').last());
  await director.beat(1400);

  // 5. Build App: the tiles, with plain titles, on the page.
  await director.click(page.getByRole('button', { name: 'Build App' }), { after: 300 });
  await director.fastForward(() => expect(page.getByText(/tiles up to date/)).toBeVisible({ timeout: 60_000 }));
  await director.beat(800);
  await director.point(page.locator('.studio-page-grid .studio-component-card').first());
  await director.beat(2400);
});
