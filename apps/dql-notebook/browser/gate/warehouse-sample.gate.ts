import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activateClaudeCode, askAndWait, baseUrl, expect, openRail, openWorkbench, projectDir, test, trustKindsIn } from './gate-support';

/**
 * The README of duckcode-ai/jaffle-shop-warehouse (no dbt), from the moment
 * `npm run notebook` prints "Notebook ready": Guided Setup (Database only), the
 * starter notebook, Modeling's certified joins, the AI provider, a first Ask
 * answer and the lineage of the draft block it saved. In order, one workbench.
 */

const QUESTION = 'Which store locations had the most revenue in 2025?';

function draftBlocks(): string[] {
  const dir = join(projectDir(), 'blocks', '_drafts');
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(folder, entry.name));
      else if (entry.name.endsWith('.dql')) found.push(join(folder, entry.name));
    }
  };
  walk(dir);
  return found;
}

test('Guided Setup: Database only', async ({ page, notes }) => {
  await page.goto(baseUrl());
  const setup = page.getByRole('dialog', { name: 'Guided Setup' });
  await expect(setup.getByRole('heading', { name: 'Where does your data model live?' })).toBeVisible({ timeout: 60_000 });
  // The sample already has a dql.config.json, so Guided Setup opens it as an
  // existing project whose data model is Database only (0.2.3, #159).
  await expect(setup.getByRole('radio', { name: /Open an existing ZLens project/ })).toBeChecked();
  await expect(setup.getByText(/already sets up the data model:\s*Database only/).first()).toBeVisible();
  await setup.getByRole('button', { name: /Continue to credentials/ }).click();
  await expect(setup.getByText(/DuckDB · configured/).first()).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByText(/Test passed/).first()).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByText(/Modeling catalog · 13 tables and views/).first()).toBeVisible({ timeout: 60_000 });
  notes.push('Open an existing ZLens project (Database only) → DuckDB · configured, Test passed, Modeling catalog · 13 tables and views');
  await setup.getByRole('button', { name: /Continue to optional AI/ }).click();
  await setup.getByRole('button', { name: 'Skip AI for now' }).click();
  await setup.getByRole('button', { name: /Finish setup/ }).click();
  await expect(setup).toBeHidden({ timeout: 30_000 });
});

test('Notebook: welcome → Run all', async ({ page, notes }) => {
  await openWorkbench(page);
  await openRail(page, 'Notebooks');
  await page.getByRole('button', { name: /^welcome/ }).first().click();
  await page.getByRole('button', { name: /Run all/ }).first().click();
  await expect(page.getByText(/^\d+ rows? ·/).first()).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => page.getByText(/^\d+ rows? ·/).count(), { timeout: 120_000 }).toBeGreaterThanOrEqual(2);
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/Trust & Steps\s*(Failed|Error)/);
  notes.push(`${await page.getByText(/^\d+ rows? ·/).count()} cells returned rows`);
});

test('Modeling: a certified join shows its warehouse check', async ({ page, notes }) => {
  await openWorkbench(page);
  await openRail(page, 'Modeling');
  await expect(page.getByText(/warehouse catalog · 13 tables/).first()).toBeVisible({ timeout: 60_000 });
  // The README: the joins in green are certified (order lines → orders is one); click one to see its check.
  const join = page.locator('.react-flow__edge[aria-label="Edge from dev::entity::order_item to dev::entity::order"]').first();
  await expect(join).toHaveCount(1);
  await join.locator('text').first().click({ force: true });
  const panel = page.locator('body');
  await expect(panel).toContainText(/certified/i, { timeout: 30_000 });
  const text = await panel.innerText();
  const lines = text.split('\n').filter((line) => /certified|match|null|cardinality|many_to_one|N:1/i.test(line)).slice(0, 8);
  notes.push(`order_item → order: ${lines.join(' · ')}`);
});

test('AI provider: claude-code (local claude login, no API key)', async ({ page, notes }) => {
  await activateClaudeCode(page, notes);
  const settings = JSON.parse(readFileSync(join(projectDir(), '.dql', 'provider-settings.json'), 'utf8'));
  expect(settings.activeProvider).toBe('claude-code');
});

test('Ask: AI-drafted answer joins locations, labelled for review, saved as a draft block', async ({ page, notes }) => {
  await openWorkbench(page);
  await openRail(page, 'Ask');
  await page.getByRole('button', { name: /New chat/ }).first().click();
  const box = page.getByPlaceholder(/Ask anything about your data/).first();
  const before = draftBlocks().length;
  const answer = await askAndWait(page, box, QUESTION);
  const text = await answer.innerText();
  notes.push(`answer: ${text.replace(/\s+/g, ' ').slice(0, 600)}`);
  // No certified block or metric covers this: the honest label is AI-drafted / needs review.
  expect(trustKindsIn(text)).toEqual(['review']);
  expect(text).toMatch(/Philadelphia/);
  expect(text).toMatch(/Brooklyn/);
  await expect.poll(() => draftBlocks().length, { timeout: 30_000 }).toBeGreaterThan(before);
  notes.push(`draft blocks: ${draftBlocks().map((file) => file.slice(projectDir().length + 1)).join(', ')}`);
});

test('Lineage: the draft block traces to the warehouse tables, with no dbt wording', async ({ page, notes }) => {
  const drafts = draftBlocks();
  expect(drafts.length, 'Ask saved a draft block (previous check)').toBeGreaterThan(0);
  const blockName = /block\s+"([^"]+)"/.exec(readFileSync(drafts[drafts.length - 1]!, 'utf8'))?.[1]
    ?? drafts[drafts.length - 1]!.split('/').pop()!.replace(/\.dql$/, '');
  await openWorkbench(page);
  await openRail(page, 'Lineage');
  await expect(page.getByText('Trace lineage')).toBeVisible();
  const search = page.getByPlaceholder(/Search/).first();
  await search.fill(blockName);
  await page.getByRole('button', { name: blockName }).first().click();
  const nodes = page.locator('.react-flow__node');
  await expect(nodes.filter({ hasText: blockName }).first()).toBeVisible({ timeout: 60_000 });
  const labels = (await nodes.allInnerTexts()).map((label) => label.replace(/\s+/g, ' ').trim());
  notes.push(`block ${blockName}; nodes: ${labels.join(' | ')}`);
  expect(labels.some((label) => /orders/.test(label) && !label.includes(blockName))).toBe(true);
  expect(labels.some((label) => /locations/.test(label))).toBe(true);
  const footer = await page.locator('body').innerText();
  expect(footer, 'a project without dbt must not say its lineage was compiled from a dbt manifest').not.toMatch(/Compiled from the dbt manifest/);
});
