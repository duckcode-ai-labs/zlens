import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base, type Locator, type Page } from '@playwright/test';

/**
 * Shared steps for the launch gate's browser checks (see
 * ../../playwright.gate.config.ts). The gate runner passes:
 *   ZLENS_GATE_BASE_URL     the workbench the sample's `npm run notebook` started
 *   ZLENS_GATE_PROJECT_DIR  the sample folder (to check files the UI writes)
 *   ZLENS_GATE_EVIDENCE_DIR where each check's screenshot and notes go
 *   ZLENS_GATE_SAMPLE       dbt | warehouse (prefixes the evidence files)
 */

export function gateEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: run the gate through scripts/launch-gate.mjs.`);
  return value;
}

export const baseUrl = (): string => gateEnv('ZLENS_GATE_BASE_URL');
export const projectDir = (): string => gateEnv('ZLENS_GATE_PROJECT_DIR');

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** Every check leaves a screenshot, passed or failed, and its notes. */
export const test = base.extend<{ notes: string[] }>({
  notes: async ({}, use) => {
    await use([]);
  },
  page: async ({ page }, use, testInfo) => {
    await use(page);
    const dir = gateEnv('ZLENS_GATE_EVIDENCE_DIR');
    mkdirSync(dir, { recursive: true });
    const name = `${process.env.ZLENS_GATE_SAMPLE ?? 'gate'}-${slug(testInfo.title)}`;
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false }).catch(() => {});
  },
});

test.afterEach(async ({ notes }, testInfo) => {
  if (notes.length === 0) return;
  for (const note of notes) testInfo.annotations.push({ type: 'note', description: note });
  const dir = gateEnv('ZLENS_GATE_EVIDENCE_DIR');
  writeFileSync(join(dir, `${process.env.ZLENS_GATE_SAMPLE ?? 'gate'}-${slug(testInfo.title)}.txt`), `${notes.join('\n')}\n`);
});

export { expect };

/** Open the workbench; past Guided Setup it lands in the product. */
export async function openWorkbench(page: Page): Promise<void> {
  await page.goto(baseUrl());
  await expect(page.getByRole('button', { name: 'Notebooks', exact: true }).first()).toBeVisible({ timeout: 60_000 });
}

export async function openRail(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click();
}

/**
 * Settings → AI provider → Anthropic Claude → Subscription → Test, save &
 * activate, as docs/get-started/ai-provider.md says. With the `claude` CLI
 * signed in on this machine, that activates the `claude-code` provider: no
 * API key.
 */
export async function activateClaudeCode(page: Page, notes: string[]): Promise<void> {
  await openWorkbench(page);
  await openRail(page, 'Settings');
  await page.getByRole('button', { name: /AI provider/ }).first().click();
  const provider = page.locator('select').filter({ has: page.locator('option', { hasText: 'Anthropic Claude' }) }).first();
  await provider.selectOption({ label: 'Anthropic Claude' });
  await page.getByRole('button', { name: /^Subscription/ }).first().click();
  await page.getByRole('button', { name: 'Test, save & activate' }).click();
  const active = page.getByText(/^Active ·/).first();
  await expect(active).toBeVisible({ timeout: 180_000 });
  notes.push(`provider card: ${(await active.innerText()).trim()}`);
  await expect(page.getByText(/Claude Code|claude-code/i).first()).toBeVisible();
}

/**
 * The trust labels an answer can carry: the header ("Certified answer from …")
 * and the run badge ("Certified", "AI-generated", "Needs review", …). One
 * answer must carry exactly one kind; two kinds is a contradictory label.
 */
export const TRUST_LABELS: Array<{ kind: 'certified' | 'governed' | 'review' | 'failed'; pattern: RegExp }> = [
  { kind: 'certified', pattern: /\bCertified (block )?answer\b/ },
  { kind: 'governed', pattern: /\bFrom Metrics\b|\bSemantic answer\b/ },
  { kind: 'review', pattern: /\bAI-drafted answer\b|\bNeeds review\b|\bAI-generated\b|\bAnswer to review\b/ },
  { kind: 'failed', pattern: /Couldn.t run this query|\bRefused\b/ },
];

export function trustKindsIn(text: string): string[] {
  return TRUST_LABELS.filter(({ pattern }) => pattern.test(text)).map(({ kind }) => kind);
}

// Every heading an answer can open with; a missing one makes the wait time out
// instead of failing on the label itself.
const ANSWER_HEADER = /Certified (block )?answer|Answer from Metrics|Answer from a certified saved query|AI-drafted answer|AI-generated answer|Semantic answer|Answer to review|Couldn.t run this query|Needs input|Refused/;

/**
 * Ask `question` in `box` (Enter, or click `submit`) and wait until the answer
 * has a trust header and Ask is idle again (the box accepts a new question).
 * Returns the innermost element holding both the question and the answer.
 */
export async function askAndWait(page: Page, box: Locator, question: string, submit?: Locator): Promise<Locator> {
  await box.fill(question);
  if (submit) await submit.click();
  else await box.press('Enter');
  const turn = page.locator('div')
    .filter({ has: page.getByText(question, { exact: true }) })
    .filter({ has: page.getByText(ANSWER_HEADER) })
    .last();
  await expect(turn).toBeVisible({ timeout: 360_000 });
  // Streaming ends when the stop control goes away.
  await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0, { timeout: 360_000 });
  await page.waitForTimeout(1500);
  return turn;
}
