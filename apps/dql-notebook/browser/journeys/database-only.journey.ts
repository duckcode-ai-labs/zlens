import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--out', join(projectDir, 'warehouse.duckdb'), '--schema', 'dev']);
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
  expect(config.connections?.default).toEqual({ driver: 'duckdb', filepath: 'warehouse.duckdb' });
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
  await devSchema.check();
  await setup.getByRole('button', { name: 'Apply and synchronize' }).click();
  await expect(setup.getByText(/Modeling catalog · \d+ tables and views/).first()).toBeVisible({ timeout: 90_000 });
  await expect(setup.getByText(/LOCAL_[0-9A-F]{8}/)).toHaveCount(0);

  await draft.getByRole('button', { name: 'Draft my models' }).click();
  await expect(draft.getByRole('status')).toContainText(/Drafted \d+ models? and \d+ joins? from \d+ tables?/, { timeout: 120_000 });

  // A restart resumes at the same step, with the drafted models.
  await page.reload();
  await expect(setup.getByRole('heading', { name: 'Connect your database' })).toBeVisible({ timeout: 60_000 });
  await expect(draft.getByRole('status')).toContainText(/Drafted \d+ models?/);

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
  await expect(page.getByText('Review exact proposal')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/warehouse discovery/).first()).toBeVisible();
  // Finishing cleared the saved progress: the next start does not resume setup.
  expect(existsSync(join(projectDir, '.dql', 'local', 'setup-progress.json'))).toBe(false);
});
