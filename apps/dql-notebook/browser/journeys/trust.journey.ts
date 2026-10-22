import { test, expect } from '../support/test';

/**
 * The trust promise, in a real browser against the built CLI (see
 * ../global-setup.ts): saving never certifies, certifying is explicit and
 * leaves a receipt, and an App page shows one aggregate trust.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => {
      const inter = [...document.fonts].filter((face) => face.family.replace(/["']/g, '') === 'Inter');
      return inter.length > 0 && inter.every((face) => face.status === 'loaded');
    }), { message: 'every Inter font file has loaded' })
    .toBe(true);
});

test('Import SQL: Save draft writes a draft; only Certify certifies, with a receipt (F1)', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Saved queries', exact: true }).first().click();
  await page.getByRole('button', { name: 'Start import' }).click();
  await page.getByPlaceholder(/select \.\.\./).fill('select count(*) as customer_count from dev.dim_customers');
  await page.getByPlaceholder('auto').fill('orders');
  await page.getByPlaceholder('analytics').fill('e2e');
  await page.getByRole('button', { name: 'Generate DQL drafts' }).click();

  // Save is one click and never certifies; Certify stays a separate action.
  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  await expect(save).toBeEnabled({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Certify', exact: true })).toBeDisabled();
  await save.click();
  await expect(page.getByText('draft saved · needs review').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/1 draft saved · certify next/)).toBeVisible();

  // On disk the .dql and its YAML both say draft.
  const library = await (await request.get('/api/blocks/library')).json() as { blocks?: Array<{ path: string; status?: string }> } | Array<{ path: string; status?: string }>;
  const blocks = Array.isArray(library) ? library : library.blocks ?? [];
  const draft = blocks.find((block) => block.path.includes('/_drafts/'));
  expect(draft, JSON.stringify(blocks).slice(0, 400)).toBeDefined();
  const opened = await (await request.get(`/api/block-studio/open?path=${encodeURIComponent(draft!.path)}`)).json() as { source: string; metadata: { reviewStatus: string; certification?: unknown } };
  expect(opened.source).toMatch(/status\s*=\s*"draft"/);
  expect(opened.metadata.reviewStatus).toBe('draft');
  expect(opened.metadata.certification).toBeUndefined();

  // The explicit Certify action runs the rules and records who certified.
  const certify = page.getByRole('button', { name: 'Certify', exact: true });
  await expect(certify).toBeEnabled();
  await certify.click();
  await expect(page.getByRole('button', { name: 'Certified', exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/1 certified/)).toBeVisible();
});

test('an App page shows one aggregate trust: header, trust line and tiles agree (F2)', async ({ page }) => {
  await page.getByRole('button', { name: 'Apps', exact: true }).click();
  // The library card shows App lifecycle, worded so it is not read as data trust.
  await expect(page.getByText(/^App (draft|in review|certified)/).first()).toBeVisible();
  await page.getByText('Smoke Orders').first().click();
  await expect(page.getByText('Orders overview').first()).toBeVisible();
  // Once the page has run, the header repeats exactly the page's trust line.
  const line = page.locator('.dql-trust-summary').first();
  await expect(line).toHaveText(/tiles? certified/, { timeout: 45_000 });
  const lineText = (await line.textContent())?.trim() ?? '';
  const seal = page.locator('.dql-app-view-topbar .dql-app-seal').first();
  if (/^All \d+ tiles? certified$/.test(lineText)) {
    await expect(seal).toHaveText(/All data certified/i);
  } else {
    await expect(seal).toHaveText(new RegExp(lineText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    await expect(page.getByText('Verified result summary')).toHaveCount(0);
  }
});
