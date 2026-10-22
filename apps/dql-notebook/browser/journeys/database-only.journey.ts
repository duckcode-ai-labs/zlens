import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { cliEntry, installDuckdbConnector, repoRoot, run, startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Database only from a bare folder (RFC 0007 §8, designs D2 and D7): a folder
 * that holds only a DuckDB file. `zlens notebook <folder> --yes` creates the
 * project (Database only, its connection set to the file) and opens Guided
 * Setup on "Database only". The connection tests itself and lists its schemas;
 * the person ticks one, Apply and synchronize, Draft my models, and lands in
 * Modeling's review. A reload on the way resumes at the same step, and the
 * drafted tables show as drafted in Apps.
 *
 * New-user round 2, Q3: the database file is jaffle_shop.duckdb and its dev
 * schema holds staging copies (stg_customers, stg_orders) beside the final
 * tables, plus a raw schema. Setup hides the raw schema and the staging copies
 * behind "Show staging tables", names the Domain "Jaffle shop" (not "dev"),
 * says honestly what it does with rows, keeps the drafts across a reload, and
 * Modeling shows one grouped note instead of a line per table.
 *
 * It starts its own server (the shared one is a dbt fixture) and leaves the
 * first-run Guided Setup open, as a new user sees it.
 */

let workDir = '';
let projectDir = '';
let server: NotebookServer | null = null;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-nodbt-'));
  projectDir = join(workDir, 'shop');
  mkdirSync(projectDir, { recursive: true });
  // The DuckDB driver goes where the runtime looks first, as the Connections page installs it.
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  const shared = process.env.ZLENS_E2E_DUCKDB_CONNECTORS;
  if (shared && existsSync(shared)) cpSync(shared, connectorRoot, { recursive: true });
  else installDuckdbConnector(projectDir);
  // The eval seed, plus staging copies of two final tables and a raw schema.
  const seed = JSON.parse(readFileSync(join(repoRoot, 'apps/cli/test/fixtures/jaffle-supply-chain/seeds/seed.json'), 'utf8')) as { tables: Record<string, unknown> };
  seed.tables.stg_customers = seed.tables.dim_customers;
  seed.tables.stg_orders = seed.tables.fct_orders;
  seed.tables['raw.raw_customers'] = seed.tables.dim_customers;
  // A products table: order_items reaches it on product_id, and also shares a
  // unique product_name with it, which once drafted a second Product join
  // (new-user round 2, problem 5).
  seed.tables.products = {
    columns: [{ name: 'product_id', type: 'text' }, { name: 'product_name', type: 'text' }, { name: 'product_type', type: 'text' }],
    rows: [
      { product_id: 'P1', product_name: 'Burger', product_type: 'food' },
      { product_id: 'P2', product_name: 'Fries', product_type: 'food' },
      { product_id: 'P3', product_name: 'Cola', product_type: 'drink' },
      { product_id: 'P4', product_name: 'Salad', product_type: 'food' },
    ],
  };
  const seedPath = join(workDir, 'seed.json');
  writeFileSync(seedPath, JSON.stringify(seed));
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--seed', seedPath, '--out', join(projectDir, 'jaffle_shop.duckdb'), '--schema', 'dev']);
  expect(existsSync(join(projectDir, 'dql.config.json'))).toBe(false);
  server = await startNotebookServer({ projectDir, workDir, acknowledgeSetup: false, args: ['--yes'] });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('Database only from a bare folder: created, connected, schemas, synchronize, draft, resume, review in Modeling', async ({ page }) => {
  test.setTimeout(240_000);
  // `--yes` created a Database only project around the file, with no placeholder block.
  const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf8'));
  expect(config.modeling?.mode).toBe('warehouse-first');
  expect(config.manifestVersion).toBe(3);
  expect(config.dbt).toBeUndefined();
  expect(config.connections?.default).toEqual({ driver: 'duckdb', filepath: 'jaffle_shop.duckdb' });
  expect(readFileSync(join(projectDir, 'notebooks', 'welcome.dqlnb'), 'utf8')).not.toContain('Example Customer Rollup');

  await page.goto(server!.baseUrl);
  const setup = page.getByRole('dialog', { name: 'Guided Setup' });
  await expect(setup.getByRole('heading', { name: 'Where does your data model live?' })).toBeVisible({ timeout: 60_000 });

  // The folder holds a database file and no dbt: Database only is chosen for the person.
  await expect(setup.getByRole('radio', { name: 'Database only' })).toBeChecked();
  // The technical adapter panel is not on this step.
  await expect(setup.getByText('Semantic execution adapters')).toBeHidden();
  const next = setup.getByRole('button', { name: /Continue to database/ });
  await expect(next).toBeEnabled();
  await next.click();

  await expect(setup.getByRole('heading', { name: 'Connect your database' })).toBeVisible();
  // Honest wording about rows, and never "never their rows".
  await expect(setup.getByText(/ZLens reads table structure and counts rows to check keys\. Sample rows are shown only to you, on this computer\. Nothing is sent anywhere unless you turn on value profiles for AI answers\./).first()).toBeVisible();
  // Value profiles are off in this project, so nothing says values are sent.
  await expect(setup.getByText('Value profiles are on')).toHaveCount(0);
  await expect(setup.getByText(/never (their )?rows/)).toHaveCount(0);
  // Drafting waits for the synchronized catalog.
  const draft = setup.getByRole('region', { name: 'Draft my models' });
  await expect(draft.getByRole('button', { name: 'Draft my models' })).toBeDisabled();

  // The connection zlens created tests itself and lists the schemas: one plain question.
  await expect(setup.getByText(/Test passed/).first()).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByText('Which schemas should ZLens read?')).toBeVisible();
  await expect(setup.getByText('Index mode', { exact: true })).toBeHidden();
  await expect(setup.getByText('Import dbt profiles.yml')).toHaveCount(0);
  await expect(setup.getByText(/outside the dbt project/)).toHaveCount(0);
  const devSchema = setup.getByRole('checkbox', { name: /^dev/ });
  await expect(devSchema).toBeVisible({ timeout: 60_000 });
  // The raw schema waits behind "Show staging tables".
  const showStagingSchemas = setup.getByRole('checkbox', { name: /Show staging tables/ });
  await expect(setup.getByRole('checkbox', { name: /^raw/ })).toHaveCount(0);
  await showStagingSchemas.check();
  await expect(setup.getByRole('checkbox', { name: /^raw/ })).toBeVisible();
  await showStagingSchemas.uncheck();
  await expect(setup.getByRole('checkbox', { name: /^raw/ })).toHaveCount(0);
  await devSchema.check();
  await setup.getByRole('button', { name: 'Apply and synchronize' }).click();
  await expect(setup.getByText(/Modeling catalog · \d+ tables and views/).first()).toBeVisible({ timeout: 90_000 });
  await expect(setup.getByText(/LOCAL_[0-9A-F]{8}/)).toHaveCount(0);

  await draft.getByRole('button', { name: 'Draft my models' }).click();
  await expect(draft.getByRole('status')).toContainText(/Drafted 5 models and \d+ joins? from 7 tables/, { timeout: 120_000 });
  // Honest about what is saved (new-user round 2, problem 4).
  await expect(draft.getByRole('status')).toContainText('Not saved yet: review and save them in Modeling.');
  // The staging copies are left out; the Domain is named after the file, not the schema.
  await expect(draft.getByText('Left out 2 staging tables (stg_customers, stg_orders): a final table holds the same data.')).toBeVisible();
  await expect(draft.getByLabel('Domain name')).toContainText('Your tables go in the Domain Jaffle shop, named after your database.');
  await expect(draft.getByText(/Domain dev\b/)).toHaveCount(0);
  // "Show staging tables" drafts them too, and back.
  const showStaging = draft.getByRole('checkbox', { name: 'Show staging tables' });
  await showStaging.check();
  await expect(draft.getByRole('status')).toContainText(/Drafted 7 models/, { timeout: 120_000 });
  await expect(draft.getByText('Staging tables are drafted too.')).toBeVisible();
  await showStaging.uncheck();
  await expect(draft.getByRole('status')).toContainText(/Drafted 5 models/, { timeout: 120_000 });
  await expect(draft.getByLabel('Drafts waiting')).toHaveText('5 drafted models waiting for review in Jaffle shop. They are kept until you save or discard them.');

  // A restart resumes at the same step, with the drafted models kept.
  await page.reload();
  await expect(setup.getByRole('heading', { name: 'Connect your database' })).toBeVisible({ timeout: 60_000 });
  await expect(draft.getByRole('status')).toContainText(/Drafted \d+ models?/);
  await expect(draft.getByLabel('Drafts waiting')).toHaveText('5 drafted models waiting for review in Jaffle shop. They are kept until you save or discard them.');

  // Joins are drafted on keys: one Product join from order items, on product_id, never a second on product_name.
  const waitingNow = await (await page.request.get(`${server!.baseUrl}/api/modeling/warehouse/drafts`)).json() as { waiting: { proposalId: string } };
  const draftedProposal = await (await page.request.get(`${server!.baseUrl}/api/context-proposals/${encodeURIComponent(waitingNow.waiting.proposalId)}`)).json() as { proposal: { operations: Array<{ change?: { operation: string; value: { from?: string; to?: string; keys?: Array<{ from: string; to: string }> } } }> } };
  const joins = draftedProposal.proposal.operations.flatMap((operation) => (operation.change?.operation === 'upsert_relationship' ? [operation.change.value] : []));
  const productJoins = joins.filter((join) => join.from === 'order_item' && String(join.to).endsWith('product'));
  expect(productJoins.map((join) => join.keys?.map((pair) => pair.from).join('+')), JSON.stringify(joins)).toEqual(['product_id']);
  expect(joins.some((join) => join.keys?.some((pair) => /_name$/.test(pair.from))), JSON.stringify(joins)).toBe(false);

  // Apps lists the drafted tables as drafted, with the key setup checked.
  const tables = await (await page.request.get(`${server!.baseUrl}/api/app-datasets/tables`)).json() as { tables: Array<{ name: string; modeled?: { state: string; key?: string } }> };
  const drafted = tables.tables.filter((table) => table.modeled?.state === 'drafted');
  expect(drafted.length, JSON.stringify(tables.tables.map((table) => [table.name, table.modeled?.state]))).toBeGreaterThan(0);
  expect(drafted.some((table) => Boolean(table.modeled?.key))).toBe(true);

  await setup.getByRole('button', { name: /Continue to optional AI/ }).click();
  await setup.getByRole('button', { name: 'Skip AI for now' }).click();
  await expect(setup.getByText('Review drafted models')).toBeVisible();
  // The button goes where the highlighted card says.
  await expect(setup.getByRole('button', { name: /Finish setup/ })).toHaveText(/Finish setup · Open Modeling/);
  await setup.getByRole('button', { name: /Finish setup/ }).click();
  await expect(setup).toBeHidden({ timeout: 30_000 });

  // Modeling opens the drafted models for review; nothing is written until saved.
  const review = page.getByRole('dialog', { name: 'Review context proposal' });
  await expect(review.getByText('Review the models ZLens drafted')).toBeVisible({ timeout: 60_000 });
  await expect(review.getByText('Drafted from your database · needs review')).toBeVisible();
  // One plain line for the tables placed in the default area; codes and ids only under Technical details.
  await expect(review.getByRole('listitem').filter({ hasText: 'tables placed in the default area' })).toHaveCount(1);
  await expect(review.getByText('5 tables placed in the default area. You can rename or move them later.', { exact: true })).toBeVisible();
  await expect(review.getByText(/MODEL_AREA_DEFAULTED/)).toBeHidden();
  await expect(review.getByText(/scope:domain:/)).toBeHidden();
  await expect(review.getByText('Create the Domain Jaffle shop')).toBeVisible();
  await expect(review.getByText(/stg_customers/)).toHaveCount(0);
  // Finishing cleared the saved progress: the next start does not resume setup.
  expect(existsSync(join(projectDir, '.dql', 'local', 'setup-progress.json'))).toBe(false);

  // Leaving without Save keeps the drafts, across a reload.
  await review.getByRole('button', { name: 'Keep for later' }).click();
  await expect(review).toBeHidden();
  const waiting = page.getByRole('status', { name: 'Drafted models waiting for review' });
  await expect(waiting).toContainText('5 drafted models waiting for review in Jaffle shop.');
  await page.reload();
  await expect(waiting).toContainText('5 drafted models waiting for review in Jaffle shop.', { timeout: 60_000 });

  // Something else changes the project before the drafts are saved: an App
  // checks a table, which writes its Dataset (new-user round 2, problem 4).
  const listing = await (await page.request.get(`${server!.baseUrl}/api/app-datasets/tables`)).json() as { tables: Array<{ id: string; name: string }> };
  const customersTable = listing.tables.find((table) => table.name === 'dim_customers');
  expect(customersTable, JSON.stringify(listing.tables.map((table) => table.name))).toBeDefined();
  const checked = await page.request.post(`${server!.baseUrl}/api/app-datasets/tables/create`, { data: { tableId: customersTable!.id, name: 'Customers', measures: [] } });
  expect(checked.ok(), await checked.text()).toBe(true);

  // Review them again and save: saved the first time, no "Rebase proposal", nothing waits any more.
  await waiting.getByRole('button', { name: 'Review drafts' }).click();
  await expect(review.getByText('Review the models ZLens drafted')).toBeVisible();
  await review.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(review).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /Rebase|Update drafts/ })).toHaveCount(0);
  await expect(page.getByText('Project sources changed after this proposal was reviewed.')).toHaveCount(0);
  await expect(waiting).toBeHidden();
  expect(readFileSync(join(projectDir, 'domains', 'jaffle-shop', 'domain.dql'), 'utf8')).toContain('Jaffle shop');

  // The saved model reaches products once: Order Items has one "Product" group of fields, never two.
  const itemsTable = listing.tables.find((table) => table.name === 'order_items');
  expect(itemsTable).toBeDefined();
  const items = await page.request.post(`${server!.baseUrl}/api/app-datasets/tables/create`, { data: { tableId: itemsTable!.id, name: 'Order Items', measures: [] } });
  expect(items.ok(), await items.text()).toBe(true);
  const build = await (await page.request.post(`${server!.baseUrl}/api/app-builds`, { data: { name: 'Products', goal: 'Revenue by product', authoringMode: 'manual', template: 'blank' } })).json() as { draft: { id: string } };
  const candidates = await (await page.request.get(`${server!.baseUrl}/api/app-builds/${build.draft.id}/source-candidates?limit=50`)).json() as { items: Array<{ name: string; capabilities: { dataset?: { joins?: Array<{ id: string; label: string; table: string; keys: Array<{ from: string }> }> } } }> };
  const itemJoins = candidates.items.find((item) => item.name === 'Order Items')?.capabilities.dataset?.joins ?? [];
  expect(itemJoins.filter((join) => join.table === 'products').map((join) => join.keys.map((key) => key.from).join('+')), JSON.stringify(itemJoins)).toEqual(['product_id']);
  expect(new Set(itemJoins.map((join) => join.label)).size, JSON.stringify(itemJoins)).toBe(itemJoins.length);
});
