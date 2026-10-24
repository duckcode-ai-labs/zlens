import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installDuckdbConnector, repoRoot, run, startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Codex end-to-end report (23 Oct 2026), against the built `zlens notebook`
 * CLI on a folder that already is a ZLens project on a built dbt project (like
 * the Jaffle sample), with 621 customers and a two-tile App:
 *   - F01: Guided Setup opens on "Open an existing ZLens project" and never
 *     says "dbt project missing"; step 2 refreshes dbt data, extra schemas wait
 *     under Advanced (F06), and the words are plain;
 *   - F08: the Apps card title links to the App's page, and an app-only link
 *     opens that page;
 *   - F02: the reader's "Filter by…" picker finds Keith Cook, past the first
 *     500 customers, by searching the server; F05: "Not filtered by Customer
 *     Name", never the column id;
 *   - search stays word-based until you turn on local Ollama embeddings, even
 *     when Ollama answers (detection mocked), and the switch is visible.
 *
 * It starts its own server and leaves the first-run Guided Setup open.
 */

let workDir = '';
let projectDir = '';
let server: NotebookServer | null = null;

const BANNED_WORDS = [
  /dbt project missing/,
  /\bcandidate\b/i,
  /Synchroniz/,
  /governed Ask/,
  /deterministic queries/,
  /hashed-token/,
  /active: /,
  /Daterange/,
  /Open blank Studio/,
  /No columns to display/,
  /Controls linked to certified fields/,
  /Not filtered by customer_name/,
];

/** Later tests do not depend on the first one finishing Guided Setup. */
async function setupDone(): Promise<void> {
  const response = await fetch(`${server!.baseUrl}/api/onboarding/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(response.ok).toBe(true);
}

async function expectPlainWords(page: Page, where: string): Promise<void> {
  const text = await page.locator('body').innerText();
  for (const word of BANNED_WORDS) expect(text, `${where}: ${word}`).not.toMatch(word);
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-setup-links-'));
  projectDir = join(workDir, 'shop');
  // A dbt project ZLens already reads: the fixture's built manifest, a
  // dbt_project.yml, and dql.config.json naming both.
  cpSync(join(repoRoot, 'apps/cli/test/fixtures/jaffle-supply-chain'), projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'dbt_project.yml'), "name: 'jaffle_shop'\nversion: '1.0.0'\nprofile: 'jaffle_shop'\n");
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  const shared = process.env.ZLENS_E2E_DUCKDB_CONNECTORS;
  if (shared && existsSync(shared)) cpSync(shared, connectorRoot, { recursive: true });
  else installDuckdbConnector(projectDir);
  const customers = Array.from({ length: 620 }, (_, index) => ({ customer_name: `Customer ${String(index + 1).padStart(4, '0')}`, lifetime_spend: index + 1 }));
  customers.push({ customer_name: 'Keith Cook', lifetime_spend: 1764.68 });
  const seedPath = join(workDir, 'seed.json');
  writeFileSync(seedPath, JSON.stringify({ tables: {
    customers: { columns: [{ name: 'customer_name', type: 'text' }, { name: 'lifetime_spend', type: 'decimal' }], rows: customers },
  } }));
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--seed', seedPath, '--out', join(projectDir, 'shop.duckdb')]);
  const configPath = join(projectDir, 'dql.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, `${JSON.stringify({
    ...config,
    modeling: { mode: 'dbt-first' },
    defaultConnectionName: 'default',
    connections: { default: { driver: 'duckdb', filepath: 'shop.duckdb' } },
    dbt: { projectDir: '.', manifestPath: 'target/manifest.json' },
  }, null, 2)}\n`);
  writeFileSync(join(projectDir, 'blocks', 'customer_directory.dql'), `block "customer_directory" {
  domain = "orders"
  type = "custom"
  status = "certified"
  description = "Every customer and their lifetime spend."
  owner = "analytics@example.com"
  outputs = ["customer_name", "lifetime_spend"]
  query = """SELECT customer_name, lifetime_spend FROM customers"""
}
`);
  writeFileSync(join(projectDir, 'blocks', 'customer_total.dql'), `block "customer_total" {
  domain = "orders"
  type = "custom"
  status = "certified"
  description = "How many customers there are."
  owner = "analytics@example.com"
  outputs = ["customers"]
  query = """SELECT COUNT(*) AS customers FROM customers"""
}
`);
  const appDir = join(projectDir, 'apps', 'customer-review');
  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  writeFileSync(join(appDir, 'dql.app.json'), `${JSON.stringify({
    version: 1, id: 'customer-review', name: 'Customer Review', description: 'Customers and their spend.',
    visibility: 'shared', domain: 'orders', lifecycle: 'review', owners: ['analytics@example.com'],
    homepage: { type: 'dashboard', id: 'overview' },
  }, null, 2)}\n`);
  writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), `${JSON.stringify({
    version: 1, id: 'overview',
    metadata: { title: 'Customer overview', description: 'Every customer.', domain: 'orders', visibility: 'shared', lifecycle: 'review' },
    layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
      { i: 'directory', x: 0, y: 0, w: 8, h: 5, block: { blockId: 'customer_directory' }, viz: { type: 'table' }, title: 'Customer directory' },
      { i: 'total', x: 8, y: 0, w: 4, h: 3, block: { blockId: 'customer_total' }, viz: { type: 'table' }, title: 'Customer count' },
    ] },
  }, null, 2)}\n`);
  server = await startNotebookServer({ projectDir, workDir, acknowledgeSetup: false });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('Guided Setup opens a configured dbt project as an existing project, never "dbt project missing" (F01, F06)', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server!.baseUrl);
  const setup = page.getByRole('dialog', { name: 'Guided Setup' });
  await expect(setup.getByRole('heading', { name: 'Where does your data model live?' })).toBeVisible({ timeout: 60_000 });
  // Watch the first seconds too: the old card flashed "dbt project missing" while it loaded.
  for (let index = 0; index < 20; index += 1) {
    await expect(setup.getByText('dbt project missing')).toHaveCount(0);
    await page.waitForTimeout(100);
  }
  await expect(setup.getByRole('radio', { name: /Open an existing ZLens project/ })).toBeChecked();
  await expect(setup.getByRole('radio', { name: 'dbt project' })).not.toBeChecked();
  await expect(setup.getByText(/already sets up the data model:\s*dbt project/).first()).toBeVisible();
  await setup.getByRole('button', { name: /Continue to credentials/ }).click();

  await expect(setup.getByRole('heading', { name: 'Check the connection' })).toBeVisible();
  await expect(setup.getByText(/Test passed/).first()).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByRole('button', { name: 'Refresh dbt data', exact: true })).toBeVisible();
  await expect(setup.getByText("Optional: add warehouse schemas dbt doesn't cover")).toBeVisible();
  await expect(setup.getByText('Find available databases & schemas')).toBeHidden();
  await expectPlainWords(page, 'Setup step 2');

  await setup.getByRole('button', { name: /Continue to optional AI/ }).click();
  await expect(setup.getByText('Optional. AI answers questions and helps you build. You can run queries and build Apps without AI.')).toBeVisible();
  await expect(setup.getByText('Search: word-based')).toBeVisible();
  await expectPlainWords(page, 'Setup step 3');
  await setup.getByRole('button', { name: 'Skip AI for now' }).click();
  await setup.getByRole('button', { name: /Finish setup/ }).click();
  await expect(setup).toBeHidden({ timeout: 30_000 });
  // Finish opens the new App form; started manually, its button says where it goes.
  await page.getByRole('tab', { name: 'Start manually' }).click();
  await expect(page.getByRole('button', { name: /^Continue to data/ })).toBeVisible({ timeout: 30_000 });
  await expectPlainWords(page, 'new App form');
});

test('the Apps card title and an app-only link open the App on its page (F08)', async ({ page }) => {
  await setupDone();
  await page.goto(server!.baseUrl);
  await page.getByRole('button', { name: 'Apps', exact: true }).first().click();
  const title = page.locator('a.dql-app-card-link').filter({ hasText: 'Customer Review' });
  await expect(title).toHaveAttribute('href', '/?app=customer-review&page=overview');
  await page.goto(`${server!.baseUrl}/?app=customer-review`);
  await expect(page.getByText('Customer directory').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('No dashboard page selected.')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('overview');
});

test("the reader's Filter by picker finds a customer past the first 500 by searching every value (F02, F05)", async ({ page }) => {
  test.setTimeout(120_000);
  await setupDone();
  await page.goto(`${server!.baseUrl}/?app=customer-review&page=overview`);
  await expect(page.getByText('Customer directory').first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('combobox', { name: 'Filter this page by' }).selectOption('customer_name');
  const trigger = page.getByRole('button', { name: 'Customer Name: choose a value' });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  await expect(page.getByText('Type to search all 621 values')).toBeVisible();
  // Only the first page is listed for browsing, so Keith Cook is not in it…
  await expect(page.getByRole('option', { name: 'Keith Cook' })).toHaveCount(0);
  // …and typing finds him on the server.
  await page.getByRole('searchbox', { name: 'Search Customer Name' }).fill('keith');
  await page.getByRole('option', { name: 'Keith Cook' }).click();
  await page.locator('.dql-app-filter-picker').getByRole('button', { name: 'Apply', exact: true }).click();
  const chip = page.getByTestId('app-viewer-filter-chip');
  await expect(chip).toContainText('Keith Cook');
  // The directory now lists only him.
  await expect(page.locator('td').filter({ hasText: 'Keith Cook' }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('td').filter({ hasText: 'Customer 0001' })).toHaveCount(0, { timeout: 30_000 });
  // The count tile has no customer column: it says so with the label the reader sees.
  await expect(page.getByText('Not filtered by Customer Name').first()).toBeVisible({ timeout: 30_000 });
  await expectPlainWords(page, 'reader');
});

test('search stays word-based with Ollama answering until you turn on local embeddings, and the switch is visible', async ({ page }) => {
  // Mock provider detection: Ollama is running with nomic-embed-text.
  await page.route('**/api/settings/embeddings/models**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ catalog: { ollama: [{ model: 'nomic-embed-text', label: 'Nomic', dimensions: 768, size: '274 MB', recommended: true, description: 'Local' }], openai: [] }, ollamaReachable: true, installed: ['nomic-embed-text'] }),
  }));
  await setupDone();
  await page.goto(server!.baseUrl);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: /^AI provider/ }).first().click();
  await expect(page.getByText('Search: word-based')).toBeVisible({ timeout: 30_000 });
  const localSwitch = page.getByRole('switch', { name: /Use local Ollama embeddings \(nomic-embed-text\) — runs on this computer, nothing leaves it/ });
  await expect(localSwitch).toBeVisible();
  await expect(localSwitch).not.toBeChecked();
  await expect(page.getByText('Ollama is running with nomic-embed-text. ZLens uses it only when this is on.')).toBeVisible();
  // The engineering id waits under Technical details.
  await expect(page.getByText('Embedder in use')).toBeHidden();
  await expectPlainWords(page, 'Settings → AI provider');
  // Nothing switched on the server either.
  const settings = await (await fetch(`${server!.baseUrl}/api/settings/embeddings`)).json() as { settings: { provider: string }; semantic: boolean; indexedProviderId?: string };
  expect(settings.settings.provider).toBe('hashed');
  expect(settings.semantic).toBe(false);
  expect(settings.indexedProviderId ?? 'hashed-token-v1').toBe('hashed-token-v1');
  const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf8')) as { ai?: { embeddings?: unknown } };
  expect(config.ai?.embeddings).toBeUndefined();
  expect(readFileSync(server!.logPath, 'utf8')).not.toMatch(/search uses local Ollama embeddings|semantic retrieval enabled/);
});
