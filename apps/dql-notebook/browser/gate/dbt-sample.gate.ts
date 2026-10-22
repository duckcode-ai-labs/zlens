import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activateClaudeCode, askAndWait, baseUrl, expect, openRail, openWorkbench, projectDir, test, trustKindsIn } from './gate-support';

/**
 * The README / docs quickstart on duckcode-ai/jaffle-shop-duckdb, from the
 * moment `npm run notebook` prints "Notebook ready": Guided Setup with the dbt
 * project, a first notebook query, the App, lineage, the AI provider and Ask.
 * The tests run in this order and share the one workbench.
 */

test('Guided Setup: dbt project', async ({ page, notes }) => {
  await page.goto(baseUrl());
  const setup = page.getByRole('dialog', { name: 'Guided Setup' });
  await expect(setup.getByRole('heading', { name: 'Where does your data model live?' })).toBeVisible({ timeout: 60_000 });
  // The sample is already a ZLens project on a dbt project: dbt project is selected.
  await expect(setup.getByRole('radio', { name: 'dbt project' })).toBeChecked();
  await expect(setup.getByText('dbt project ready').first()).toBeVisible();
  await setup.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(setup.getByText(/Nothing has changed yet/).first()).toBeVisible({ timeout: 120_000 });
  await setup.getByRole('button', { name: 'Apply project', exact: true }).click();
  const next = setup.getByRole('button', { name: /Continue to database/ });
  await expect(next).toBeEnabled({ timeout: 120_000 });
  await next.click();

  await expect(setup.getByText(/DuckDB · configured/).first()).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByText(/Test passed/).first()).toBeVisible({ timeout: 60_000 });
  await setup.getByRole('button', { name: /Continue to optional AI/ }).click();
  // Step 3 is optional; the gate sets the provider in Settings (next checks).
  await setup.getByRole('button', { name: 'Skip AI for now' }).click();
  await setup.getByRole('button', { name: /Finish setup/ }).click();
  await expect(setup).toBeHidden({ timeout: 30_000 });
  notes.push('Preview → Apply project → DuckDB · configured, Test passed → Finish setup');
});

test('Notebook: first query from the quickstart', async ({ page, notes }) => {
  await openWorkbench(page);
  await openRail(page, 'Notebooks');
  await page.getByRole('button', { name: /New Notebook/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').first().fill('Customer orders');
  await dialog.getByRole('button', { name: 'Create notebook', exact: true }).click();
  await page.getByRole('button', { name: /Create DQL query/ }).first().click();
  await page.getByRole('button', { name: /Switch to SQL cell/ }).first().click();
  const editor = page.locator('.cm-content').last();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(
    'select customer_name, count_lifetime_orders, lifetime_spend\nfrom dev.customers\norder by lifetime_spend desc\nlimit 10',
  );
  await page.keyboard.press('Shift+Enter');
  // The cell's result bar reads "Trust & Steps · Success" and "10 rows · …".
  await expect(page.getByText(/^10 rows ·/).last()).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('body')).toContainText(/Trust & Steps\s*Success/i);
  const file = join(projectDir(), 'notebooks', 'customer_orders.dqlnb');
  await expect.poll(() => existsSync(file), { timeout: 20_000 }).toBe(true);
  notes.push(`saved ${file}`);
});

test('App: Jaffle Growth Review renders with its trust labels', async ({ page, notes }) => {
  await openWorkbench(page);
  await openRail(page, 'Apps');
  await page.getByText('Jaffle Growth Review').first().click();
  await expect(page.getByText(/ALL TILES CERTIFIED/i).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/All tiles certified/).first()).toBeVisible();
  // No tile on an all-certified page may say it needs review or failed.
  const body = await page.locator('main').first().innerText();
  expect(body).not.toMatch(/Needs review|Not certified yet|AI-drafted|Couldn.t run/);
  notes.push('All tiles certified (header and trust line); no Not certified yet/failed label on the page');
});

test('Lineage: monthly_revenue from the dbt model to the App', async ({ page, notes }) => {
  await openWorkbench(page);
  await openRail(page, 'Lineage');
  await expect(page.getByText('Trace lineage')).toBeVisible();
  await page.getByRole('button', { name: 'monthly_revenue', exact: true }).click();
  const nodes = page.locator('.react-flow__node');
  await expect(nodes.filter({ hasText: 'monthly_revenue' }).first()).toBeVisible({ timeout: 60_000 });
  const labels = (await nodes.allInnerTexts()).map((label) => label.replace(/\s+/g, ' ').trim());
  notes.push(`nodes: ${labels.join(' | ')}`);
  // The chain the quickstart promises: dbt source → dbt model → certified block (a "Saved query" node since #165) → App.
  for (const expected of [/^raw_orders DBT SOURCE/i, /^orders DBT MODEL/i, /^monthly_revenue SAVED QUERY/i, /^Jaffle Growth Review APP/i]) {
    expect(labels.some((label) => expected.test(label)), `a lineage node matching ${expected}`).toBe(true);
  }
  notes.push(`footer: ${(await page.getByText(/End-to-end lineage of monthly_revenue/).first().innerText()).trim()}`);
});

test('AI provider: claude-code (local claude login, no API key)', async ({ page, notes }) => {
  await activateClaudeCode(page, notes);
  const settings = JSON.parse(readFileSync(join(projectDir(), '.dql', 'provider-settings.json'), 'utf8'));
  expect(settings.activeProvider).toBe('claude-code');
  notes.push(`.dql/provider-settings.json activeProvider=${settings.activeProvider}`);
});

test('Ask: certified answer from the monthly_revenue block, honestly labelled', async ({ page, notes }) => {
  await openWorkbench(page);
  await openRail(page, 'Ask');
  const box = page.getByPlaceholder(/Ask anything about your data/).first();
  await expect(box).toBeVisible();
  await page.getByRole('button', { name: /New chat/ }).first().click();
  const answer = await askAndWait(page, box, 'How has revenue changed by month?');
  const text = await answer.innerText();
  notes.push(`answer: ${text.replace(/\s+/g, ' ').slice(0, 600)}`);
  expect(trustKindsIn(text)).toEqual(['certified']);
  expect(text).toMatch(/monthly_revenue/);
});

for (const question of ['How has revenue changed by month?', 'What is beverage revenue by product?']) {
  test(`App Ask: "${question}" carries one honest label`, async ({ page, notes }) => {
    await openWorkbench(page);
    await openRail(page, 'Apps');
    await page.getByText('Jaffle Growth Review').first().click();
    await expect(page.getByText(/ALL TILES CERTIFIED/i).first()).toBeVisible({ timeout: 120_000 });
    const box = page.getByPlaceholder(/Ask about Jaffle Growth Review/);
    const answer = await askAndWait(page, box, question, page.getByRole('button', { name: 'Ask', exact: true }).last());
    const text = await answer.innerText();
    notes.push(`answer: ${text.replace(/\s+/g, ' ').slice(0, 600)}`);
    // Heading, badge, note and card must tell one story (one trust kind).
    const kinds = trustKindsIn(text);
    notes.push(`trust labels found: ${kinds.join(', ') || 'none'}`);
    expect(kinds, 'exactly one kind of trust label on the answer').toHaveLength(1);
  });
}
