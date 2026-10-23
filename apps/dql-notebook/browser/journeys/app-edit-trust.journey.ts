import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { seedProject } from '../global-setup';
import { startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Editing a published App keeps its data and its receipts (F07), and every
 * App surface says who certified what and how many tiles are certified
 * (F03, F04), against the built `zlens notebook` CLI on the
 * jaffle-supply-chain fixture:
 *
 * - a new App draft's card says "Not published yet · 1 of 2 tiles certified",
 *   and the editor header shows the same count;
 * - a published App whose tiles name saved queries by name only (as the
 *   sample's Jaffle Growth Review does), one changed outside ZLens since it
 *   was certified: the reader says "1 of 2 tiles certified"; Edit says the
 *   same, the certified tile reads "Certified by Analytics (jaffle.shop) ·
 *   15 Oct", the changed one "Changed since it was certified on 15 Oct";
 *   Certify now opens the inline review here and the count becomes "All
 *   tiles certified" — at 1280×800, with the Data panel's byline whole;
 * - the same draft open in two tabs: the stale tab says "This App changed in
 *   another tab. Refresh to review the latest version.", with Refresh and the
 *   code under Technical details.
 *
 * It starts its own server on its own copy of the fixture.
 */

const CERTIFIED_AT = '2026-10-15T12:00:00.000Z';
const CHANGED_IN_ANOTHER_TAB = 'This App changed in another tab. Refresh to review the latest version.';
let workDir = '';
let projectDir = '';
let server: NotebookServer | null = null;

async function ok<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`${server!.baseUrl}${path}`, body === undefined
    ? {}
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 800)}`);
  return JSON.parse(text) as T;
}

/** A saved query; certified ones get a receipt from analytics@jaffle.shop, dated 15 Oct. */
function writeBlock(name: string, description: string, query: string, certified: boolean): string {
  const relPath = `blocks/${name}.dql`;
  const source = [
    '// dql-format: 1',
    '',
    `block "${name}" {`,
    '  domain = "orders"',
    '  type = "custom"',
    `  status = "${certified ? 'certified' : 'draft'}"`,
    `  description = "${description}"`,
    '  owner = "analytics@jaffle.shop"',
    '  tags = ["customers", "revenue"]',
    '  dimensions = ["customer"]',
    '  query = """',
    `    ${query}`,
    '  """',
    '  tests {',
    '    assert row_count > 0',
    '  }',
    '}',
    '',
  ].join('\n');
  writeFileSync(join(projectDir, relPath), source);
  if (certified) {
    mkdirSync(join(projectDir, 'semantic-layer', 'blocks'), { recursive: true });
    writeFileSync(join(projectDir, 'semantic-layer', 'blocks', `${name}.yaml`), [
      `name: ${name}`,
      `block: ${name}`,
      'domain: orders',
      'owner: "analytics@jaffle.shop"',
      'reviewStatus: certified',
      'certification:',
      '  certifiedBy: analytics@jaffle.shop',
      `  certifiedAt: '${CERTIFIED_AT}'`,
      '  via: cli',
      '  rules: oss',
      `  sourceSha256: ${createHash('sha256').update(`${source.trimEnd()}\n`).digest('hex')}`,
      '  checks:',
      '    - run',
      '    - tests',
      '',
    ].join('\n'));
  }
  return relPath;
}

/** A published App written before Studio: its tiles name saved queries by name only. */
function writeLegacyApp(): void {
  const appDir = join(projectDir, 'apps', 'growth-review');
  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  writeFileSync(join(appDir, 'dql.app.json'), `${JSON.stringify({
    version: 1, id: 'growth-review', name: 'Growth Review', domain: 'orders', visibility: 'shared',
    lifecycle: 'certified', owners: ['analytics@jaffle.shop'], homepage: { type: 'dashboard', id: 'overview' },
  }, null, 2)}\n`);
  writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), `${JSON.stringify({
    version: 1,
    id: 'overview',
    metadata: { title: 'Growth Review', domain: 'orders', visibility: 'shared', lifecycle: 'certified' },
    layout: {
      kind: 'grid', cols: 12, rowHeight: 80,
      items: [
        { i: 'spenders', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'big_spenders' }, viz: { type: 'table' }, title: 'Big spenders' },
        { i: 'beverage', x: 6, y: 0, w: 6, h: 4, block: { blockId: 'beverage_buyers' }, viz: { type: 'table' }, title: 'Top beverage buyers' },
      ],
    },
  }, null, 2)}\n`);
}

async function openStudioDraft(page: Page, draftId: string): Promise<void> {
  await page.goto(`${server!.baseUrl}/?appDraft=${draftId}`);
  await expect(page.locator('.studio-topbar')).toBeVisible({ timeout: 90_000 });
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-edittrust-'));
  projectDir = join(workDir, 'project');
  seedProject(projectDir, { connectorRoot: process.env.ZLENS_E2E_DUCKDB_CONNECTORS });
  writeBlock('big_spenders', 'The customers who spent the most.', 'SELECT customer_name, lifetime_spend FROM dim_customers ORDER BY lifetime_spend DESC LIMIT 5', true);
  writeBlock('beverage_buyers', 'Customers by lifetime orders.', 'SELECT customer_name, count_lifetime_orders FROM dim_customers ORDER BY count_lifetime_orders DESC LIMIT 5', true);
  writeBlock('quiet_customers', 'Customers with the fewest orders.', 'SELECT customer_name, count_lifetime_orders FROM dim_customers ORDER BY count_lifetime_orders ASC LIMIT 5', false);
  writeLegacyApp();
  server = await startNotebookServer({ projectDir, workDir });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('a new App draft shows its tile count on its Apps card and in the editor header (F04)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const app = await ok<{ draft: { id: string; revision: number; proposalHash: string } }>('/api/app-builds', {
    name: 'Customer Pulse', goal: 'Who buys and who does not', domain: 'orders', authoringMode: 'manual', template: 'blank',
  });
  const candidates = await ok<{ items: Array<{ sourceId: string; name: string }> }>(`/api/app-builds/${app.draft.id}/source-candidates?limit=50`, undefined, 'GET');
  const id = (name: string) => candidates.items.find((candidate) => candidate.name === name)!.sourceId;
  await ok(`/api/app-builds/${app.draft.id}/compose`, {
    expectedRevision: app.draft.revision,
    expectedProposalHash: app.draft.proposalHash,
    mode: 'manual',
    selections: [
      { sourceId: id('big_spenders'), view: 'table', title: 'Big spenders' },
      { sourceId: id('quiet_customers'), view: 'table', title: 'Quiet customers' },
    ],
  });

  await openStudioDraft(page, app.draft.id);
  await expect(page.locator('.studio-trust-count')).toHaveText('1 of 2 tiles certified', { timeout: 90_000 });

  await page.getByRole('button', { name: 'Back to Apps' }).click();
  const card = page.locator('article.dql-app-draft-card').filter({ hasText: 'Customer Pulse' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('.dql-app-seal')).toHaveText('Not published yet · 1 of 2 tiles certified');
});

test('editing a published App whose saved query changed keeps its data: 1 of 2, "Changed since…", certify inline, All tiles certified (F07, F03, F10)', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  // Someone edits a certified saved query outside ZLens.
  const changed = join(projectDir, 'blocks', 'beverage_buyers.dql');
  writeFileSync(changed, readFileSync(changed, 'utf8').replace('LIMIT 5', 'LIMIT 6'));

  await page.goto(`${server!.baseUrl}/?app=growth-review&page=overview`);
  await expect(page.locator('.dql-trust-summary')).toHaveText('1 of 2 tiles certified', { timeout: 90_000 });
  await page.locator('.dql-app-modeseg button', { hasText: 'Edit' }).click();

  // The editor keeps both saved queries and their receipts.
  await expect(page.locator('.studio-trust-count')).toHaveText('1 of 2 tiles certified', { timeout: 90_000 });
  const certifiedDot = page.locator('.trust-dot[data-trust="certified"]');
  await expect(certifiedDot).toHaveCount(1);
  await expect(certifiedDot).toHaveAttribute('aria-label', /^Certified by Analytics \(jaffle\.shop\) · 15 Oct/);
  const changedDot = page.locator('.trust-dot[data-trust="review"]');
  await expect(changedDot).toHaveCount(1);
  await expect(changedDot).toHaveAttribute('title', /Changed since it was certified on 15 Oct/);
  await expect(page.locator('.trust-dot[aria-label="Certified"]')).toHaveCount(0);
  await expect(page.getByText(/Nobody has certified this saved query yet/)).toHaveCount(0);

  // Certify now opens the saved query's review right here, and it works.
  await page.getByRole('button', { name: /^Review and publish to Project/ }).click();
  const ready = page.getByRole('dialog', { name: 'Ready to publish' });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('1 of 2 tiles certified', { timeout: 120_000 });
  const item = ready.getByRole('listitem', { name: 'Not certified yet: Top beverage buyers' });
  await expect(item).toContainText(/Changed since it was certified on 15 Oct/);
  await item.getByRole('button', { name: 'Certify now: Beverage Buyers' }).click();
  const review = page.getByRole('dialog', { name: 'Certify Beverage Buyers' });
  await expect(review.getByText(/^Changed since it was certified on 15 Oct/)).toBeVisible({ timeout: 90_000 });
  const vouch = review.getByRole('button', { name: 'I vouch for this — certify' });
  await expect(vouch).toBeEnabled({ timeout: 90_000 });
  await vouch.click();
  await expect(review).toBeHidden({ timeout: 90_000 });
  await expect(ready.locator('.readiness-trust-count')).toHaveText('All tiles certified', { timeout: 120_000 });
  await expect(page.locator('.studio-trust-count')).toHaveText('All tiles certified');
  await expect(page.locator('.trust-dot[data-trust="certified"]')).toHaveCount(2);
  await expect(page.locator('.trust-dot[aria-label^="Certified by you · "]')).toHaveCount(1);
  await ready.getByRole('button', { name: 'Back to editing' }).click();

  // The Data panel's byline is whole at 1280: it wraps, it is never cut (F10).
  const dataPane = page.locator('.data-panel');
  await dataPane.locator('.dataset-current').click();
  await page.getByRole('menuitemradio', { name: /^Big Spenders/ }).click();
  const byline = dataPane.locator('.dataset-current small');
  await expect(byline).toContainText(/Certified by Analytics \(jaffle\.shop\) · 15 Oct/, { timeout: 30_000 });
  const clipped = await byline.evaluate((element) => element.scrollWidth > element.clientWidth + 1 || getComputedStyle(element).textOverflow === 'ellipsis');
  expect(clipped).toBe(false);
});

test('the same draft in two tabs: the older tab says the App changed in another tab, with Refresh (F11)', async ({ context }) => {
  test.setTimeout(240_000);
  const app = await ok<{ draft: { id: string } }>('/api/app-builds', {
    name: 'Two Tabs', goal: 'Big spenders', domain: 'orders', authoringMode: 'manual', template: 'blank',
  });
  const first = await context.newPage();
  const second = await context.newPage();
  for (const page of [first, second]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openStudioDraft(page, app.draft.id);
  }
  // A change in the first tab.
  const name = first.getByRole('textbox', { name: 'App name' });
  await name.fill('Two Tabs Renamed');
  await name.press('Tab');
  await expect(first.locator('.studio-brand small')).toContainText(/Saved/, { timeout: 30_000 });

  // The second tab still shows the older version.
  await second.getByRole('button', { name: /^Review and publish to Project/ }).click();
  const banner = second.locator('.studio-error');
  await expect(banner).toContainText(CHANGED_IN_ANOTHER_TAB, { timeout: 60_000 });
  await expect(banner.locator('.studio-error-body > span')).toHaveText(CHANGED_IN_ANOTHER_TAB);
  await expect(banner.getByText('Technical details')).toBeVisible();
  await expect(banner.locator('code')).toContainText('APP_BUILD_REVISION_CONFLICT');
  await expect(banner.locator('.studio-error-body > span')).not.toContainText('APP_BUILD');
  await banner.getByRole('button', { name: 'Refresh' }).click();
  await expect(second.locator('.studio-error')).toHaveCount(0);
  await expect(second.getByRole('textbox', { name: 'App name' })).toHaveValue('Two Tabs Renamed');
});
