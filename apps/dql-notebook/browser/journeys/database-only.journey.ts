import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { cliEntry, installDuckdbConnector, repoRoot, run, startNotebookServer, type NotebookServer } from '../support/server';

/**
 * Guided Setup → "Database only" on a fresh `zlens init` folder with a DuckDB
 * file and no dbt project (RFC 0007 §8, design D2): choose Database only,
 * connect the file, choose a schema, Apply and synchronize, Draft my models,
 * finish, and land in Modeling's review of the drafted models.
 *
 * It starts its own server (the shared one is a dbt fixture) and leaves the
 * first-run Guided Setup open, as a new user sees it.
 */

let workDir = '';
let projectDir = '';
let warehouse = '';
let server: NotebookServer | null = null;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  workDir = mkdtempSync(join(tmpdir(), 'dql-browser-nodbt-'));
  projectDir = join(workDir, 'analytics');
  mkdirSync(projectDir, { recursive: true });
  run('node', [cliEntry, 'init', projectDir]);
  const connectorRoot = join(projectDir, '.dql', 'connectors');
  const shared = process.env.ZLENS_E2E_DUCKDB_CONNECTORS;
  if (shared && existsSync(shared)) cpSync(shared, connectorRoot, { recursive: true });
  else installDuckdbConnector(projectDir);
  warehouse = join(projectDir, 'warehouse.duckdb');
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--out', warehouse, '--schema', 'dev']);
  server = await startNotebookServer({ projectDir, workDir, acknowledgeSetup: false });
});

test.afterAll(async () => {
  await server?.stop();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('Database only: connect, choose schemas, synchronize, draft models, review in Modeling', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(server!.baseUrl);
  const setup = page.getByRole('dialog', { name: 'Guided Setup' });
  await expect(setup.getByRole('heading', { name: 'Where does your data model live?' })).toBeVisible({ timeout: 60_000 });

  // A fresh folder without dbt asks; nothing is chosen for the user.
  const next = setup.getByRole('button', { name: /Continue to database/ });
  await expect(next).toBeDisabled();
  await expect(setup.getByRole('radio', { name: 'Open an existing ZLens project' })).toBeDisabled();
  await setup.getByRole('radio', { name: 'Database only' }).check();
  await expect(next).toBeEnabled();
  await next.click();

  await expect(setup.getByRole('heading', { name: 'Connect your database' })).toBeVisible();
  const config = JSON.parse(readFileSync(join(projectDir, 'dql.config.json'), 'utf8'));
  expect(config.modeling?.mode).toBe('warehouse-first');
  expect(config.manifestVersion).toBe(3);
  expect(config.dbt).toBeUndefined();

  // Drafting waits for the synchronized catalog.
  const draft = setup.getByRole('region', { name: 'Draft my models' });
  await expect(draft.getByRole('button', { name: 'Draft my models' })).toBeDisabled();

  await setup.getByLabel(/DuckDB file path/).fill(warehouse);
  await setup.getByRole('button', { name: 'Save connection' }).click();
  await expect(setup.getByText(/Test passed/).first()).toBeVisible({ timeout: 60_000 });

  await setup.getByRole('button', { name: /Find available databases/ }).click();
  await setup.getByRole('checkbox', { name: /^dev/ }).check();
  await setup.getByRole('button', { name: 'Apply and synchronize' }).click();
  await expect(setup.getByText(/Modeling catalog · \d+ tables and views/).first()).toBeVisible({ timeout: 90_000 });

  await draft.getByRole('button', { name: 'Draft my models' }).click();
  await expect(draft.getByRole('status')).toContainText(/Drafted \d+ models? and \d+ joins? from \d+ tables?/, { timeout: 120_000 });

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
});
