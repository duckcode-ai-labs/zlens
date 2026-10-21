import { clip, expect, openAndRecord } from './support/clip-test';

const DATASET = 'Customers';

/**
 * Make the sample's `customers` table a certified Dataset, through the same
 * calls the Add data "Database tables" tab makes (check, then certify). The
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
  }) as { ok: boolean; status?: string; error?: string; blockers?: string[] };
  expect(created.ok, created.error).toBe(true);
  expect(created.status, (created.blockers ?? []).join(' ')).toBe('certified');
}

/**
 * Apps: build an App by hand (pick a Domain, add a certified Dataset in the
 * Data step, click a measure, add the tile), then describe one to AI and check
 * the data it picked before it builds pages. The server has no AI provider, so
 * the built-in planner picks the data; nothing reaches a model.
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
  await director.click(page.getByRole('button', { name: /Open blank Studio/ }), { after: 300 });

  // 2. Data for this App: add a certified Dataset and see its fields.
  await expect(page.getByRole('heading', { name: 'Data for this App' })).toBeVisible({ timeout: 30_000 });
  const browser = page.getByRole('region', { name: 'Add data' });
  const row = browser.locator('article.add-data-row').filter({ hasText: DATASET }).first();
  await expect(row).toContainText('Dataset · Certified');
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
  await director.click(page.getByRole('button', { name: /Open canvas with 1 source/ }), { after: 400 });

  // 3. On the canvas, click a measure: a new tile; then add it to the page.
  await director.click(page.locator('.data-panel button.data-field').filter({ hasText: /^Σ\s*Lifetime Spend\s*sum$/ }), { after: 300 });
  const draftTile = page.locator('article.draft-tile');
  await director.fastForward(() => expect(draftTile).toContainText('Lifetime Spend', { timeout: 30_000 }));
  await director.beat(1200);
  await director.click(page.getByRole('button', { name: 'Add to page' }), { after: 400 });
  await expect(draftTile).toHaveCount(0);
  await director.point(page.locator('.studio-page-grid .studio-component-card').first());
  await director.beat(1500);

  // 4. Describe with AI: it shows the data it picked, and why, before building pages.
  await director.click(page.getByRole('button', { name: 'Back to Apps' }), { after: 400 });
  await director.click(page.getByRole('button', { name: 'Build new App' }));
  await director.click(page.getByRole('tab', { name: 'Describe with AI' }), { after: 300 });
  await director.type(
    page.getByRole('textbox', { name: 'What decision should this App support?' }),
    'Customer spend and order counts for the commerce team',
    { clear: true },
  );
  await director.click(page.getByRole('button', { name: /Generate editable App/ }), { after: 300 });
  const picked = page.getByRole('heading', { name: /^AI picked \d+ sources?$/ });
  await director.fastForward(() => expect(picked).toBeVisible({ timeout: 60_000 }));
  await expect(page.getByText('Deterministic planner fallback')).toBeVisible();
  await director.beat(600);
  await director.point(picked);
  await director.beat(1000);
  const picks = page.getByRole('list', { name: 'AI picks' });
  director.poster();
  await director.point(picks.getByText(/^Why: /).first());
  await director.beat(1800);
  await director.point(picks.getByText(/^Why: /).nth(1));
  await director.beat(1400);

  // 5. Build pages, then review the proposed tiles before anything is applied.
  await director.click(page.getByRole('button', { name: /Build pages with \d+ sources?/ }), { after: 300 });
  const review = page.getByRole('complementary', { name: 'AI proposal' });
  await director.fastForward(() => expect(review.getByRole('heading', { name: 'Review the tiles' })).toBeVisible({ timeout: 60_000 }));
  await expect(page.locator('.proposal-tile').first()).toBeVisible();
  await director.beat(800);
  await director.point(review.getByRole('heading', { name: 'Review the tiles' }));
  await director.beat(1200);
  await director.point(review.getByRole('button', { name: /^Apply \d+ changes?$/ }));
  await director.beat(2400);
});
