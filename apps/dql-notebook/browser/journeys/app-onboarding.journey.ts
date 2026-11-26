import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { cliEntry, repoRoot } from '../support/server';

/**
 * The first open of the ZLens app for Snowflake (onboarding design "pick your data, fast first, details later"),
 * in a real browser against the built CLI: the setup wizard asks which schemas to read and shows their sizes,
 * Read these tables reads names only and says Ready to ask, Ask opens with the strip that follows the background
 * checks, and the Setup page shows every stage until the drafts wait for review.
 *
 * As in the History journey, the app's server runs in this process in Snowflake mode, with Snowflake's own parts
 * stood in for: the signed-in user header, the app's settings, and the warehouse's answers (catalog rows, sizes).
 */

const USER = 'JSMITH';
const TABLES: Record<string, string[]> = {
  SALES: ['CUSTOMERS', 'ORDERS', 'ORDER_LINES'],
  FINANCE: ['INVOICES', 'PAYMENTS'],
};

let workDir = '';
let server: Server | undefined;
let baseUrl = '';
const savedEnv: Record<string, string | undefined> = {};

const result = (rows: Array<Record<string, unknown>>) => ({ columns: [], rows, rowCount: rows.length, executionTimeMs: 1 });

function columnsOf(database: string) {
  return Object.entries(TABLES).flatMap(([schema, tables]) => tables.flatMap((table) => [
    { TABLE_CATALOG: database, TABLE_SCHEMA: schema, TABLE_NAME: table, COLUMN_NAME: `${table.replace(/S$/, '')}_ID`, DATA_TYPE: 'NUMBER', ORDINAL_POSITION: 1, IS_NULLABLE: 'NO', COMMENT: null },
    { TABLE_CATALOG: database, TABLE_SCHEMA: schema, TABLE_NAME: table, COLUMN_NAME: 'AMOUNT', DATA_TYPE: 'NUMBER', ORDINAL_POSITION: 2, IS_NULLABLE: 'YES', COMMENT: null },
  ]));
}

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'zlens-app-onboarding-journey-'));
  const projectDir = join(workDir, 'project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'dql.config.json'), JSON.stringify({
    project: 'onboarding', manifestVersion: 3, modeling: { mode: 'warehouse-first' },
    connections: { default: { driver: 'snowflake', account: 'test-account', username: 'app', database: 'ZLENS_APP', warehouse: 'ZLENS_APP_WH' } },
  }));
  const executePositional = async (sql: string, _params: unknown[], config: { database?: string }, options?: { signal?: AbortSignal }) => {
    if (sql.includes('CURRENT_ACCOUNT()')) return result([{ DQL_ACCOUNT_LOCATOR: 'XY1', DQL_ACCOUNT_NAME: 'TEST', DQL_ORGANIZATION: 'ORG', DQL_ACCOUNT: 'ORG-TEST', DQL_DATABASE: config.database, DQL_ROLE: 'APP', DQL_WAREHOUSE: 'ZLENS_APP_WH' }]);
    if (sql.startsWith('SHOW TERSE SCHEMAS')) return result(Object.keys(TABLES).map((name) => ({ database_name: 'ACME', name })));
    if (sql.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) {
      return result(Object.entries(TABLES).map(([schema, tables]) => ({ TABLE_CATALOG: 'ACME', TABLE_SCHEMA: schema, TABLE_COUNT: tables.length, VIEW_COUNT: 0, ROW_COUNT: tables.length * 1_500_000, BYTES: tables.length * 9e7, KEYED_TABLE_COUNT: 0, FOREIGN_KEY_COUNT: 0, LARGE_TABLE_COUNT: 0, LARGEST_TABLE_ROWS: 2_000_000, COLUMN_COUNT: tables.length * 2 })));
    }
    // A read that takes a moment, so the page shows its counts.
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1_500); options?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true }); });
      return result(columnsOf(config.database ?? 'ACME'));
    }
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return result(Object.entries(TABLES).flatMap(([schema, tables]) => tables.map((table) => ({ TABLE_CATALOG: 'ACME', TABLE_SCHEMA: schema, TABLE_NAME: table, TABLE_TYPE: 'BASE TABLE', ROW_COUNT: 1_500_000 })))) ;
    if (sql.startsWith('SHOW')) return result([]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return result([{ ROW_COUNT: 100, NN_0: 100, ND_0: 100, REFERENCING: 100, UNMATCHED: 0 }]);
  };
  const executor = {
    getConnector: async () => ({
      execute: async (sql: string) => (sql.startsWith('SHOW WAREHOUSES') ? result([{ name: 'ZLENS_APP_WH', state: 'STARTED', auto_resume: 'true' }]) : result([{ ACCOUNT_NAME: 'TEST', USER_NAME: 'APP', ROLE_NAME: 'APP', DATABASE_NAME: 'ACME', SCHEMA_NAME: null, WAREHOUSE_NAME: 'ZLENS_APP_WH' }])),
      ping: async () => true,
    }),
    executePositional,
    executeQuery: (sql: string, _params: unknown[], _variables: unknown, config: { database?: string }, options?: { signal?: AbortSignal }) => executePositional(sql, [], config, options),
    disconnect: async () => undefined,
  };
  const settings = async (sql: string): Promise<Array<Record<string, unknown>>> => {
    if (sql.includes('GET_CONFIGURATION_VALUE')) return [{ V: USER }];
    if (sql.startsWith('SHOW TERSE DATABASES')) return [{ name: 'ACME', kind: 'STANDARD' }];
    if (sql.startsWith('SHOW TERSE SCHEMAS IN DATABASE')) return [{ name: 'SALES' }];
    if (sql.startsWith('SHOW TERSE OBJECTS IN SCHEMA')) return [{ name: 'ORDERS' }];
    return [];
  };
  // The app's install: its connection locked; no driver fetched for the stand-in warehouse.
  for (const [name, value] of [['ZLENS_LOCK_CONNECTIONS', '1'], ['ZLENS_NO_EGRESS', '1']] as const) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
  const runtime = await import(pathToFileURL(join(dirname(cliEntry), 'local-runtime.js')).href) as { startLocalServer: (options: Record<string, unknown>) => Promise<number> };
  const port = await runtime.startLocalServer({
    rootDir: join(repoRoot, 'apps/cli/dist/assets/dql-notebook'),
    projectRoot: projectDir,
    executor,
    preferredPort: 0,
    host: '127.0.0.1',
    snowflakeIngress: {},
    snowflakeAppSettings: { userConfiguration: 'ZLENS_USER', appName: 'ZLENS_APP', ttlMs: 60_000 },
    snowflakeAppQuery: settings,
    captureServer: (created: Server) => { server = created; },
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test.use({ extraHTTPHeaders: { 'Sf-Context-Current-User': USER } });

test('first open: choose your data with sizes, read names, ask right away, follow the checks on the Setup page', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(baseUrl);
  const setup = page.getByRole('dialog', { name: 'Guided Setup' });
  await expect(setup.getByRole('heading', { name: 'Choose your data' })).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByRole('banner').getByText('Step 1 of 2')).toBeVisible();
  // No step about where the model lives or which AI: the app answers those itself.
  await expect(setup.getByRole('heading', { name: 'Where does your data model live?' })).toHaveCount(0);
  await expect(setup.getByText(/Test passed/).first()).toBeVisible({ timeout: 60_000 });
  // Sizes in the picker; with 5 tables in all, every schema is ticked already (decision D4).
  await expect(setup.getByText(/^3 tables · 4\.5M rows · \d+ MB$/)).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByRole('checkbox', { name: /^SALES/ })).toBeChecked();
  await expect(setup.getByRole('checkbox', { name: /^FINANCE/ })).toBeChecked();
  await expect(setup.getByText(/^Reading names: about \d+ s\./)).toBeVisible();
  await setup.getByRole('button', { name: 'Read these tables' }).click();
  await expect(setup.getByRole('status').filter({ hasText: /Reading names in ACME/ })).toBeVisible({ timeout: 30_000 });
  // Names read: ready to ask, Ask first.
  await expect(setup.getByRole('heading', { name: 'Where do you want to start?' })).toBeVisible({ timeout: 60_000 });
  await expect(setup.getByText(/ZLens read 5 tables\./)).toBeVisible();
  await setup.getByRole('button', { name: /Finish setup · Open Ask/ }).click();
  await expect(setup).toBeHidden();
  const strip = page.getByTestId('snowflake-app-setup-banner');
  await expect(strip).toContainText(/Ready to ask|ZLens read 5 tables/, { timeout: 30_000 });
  // The Setup page, from the strip or Settings » Database: every stage, until the drafts wait for review.
  await page.goto(baseUrl);
  await page.getByTestId('snowflake-app-setup-banner').getByRole('button', { name: 'Setup' }).click();
  const panel = page.getByRole('region', { name: 'Setup' });
  await expect(panel).toContainText('Read 5 tables in 2 schemas in ACME: names, types, comments, keys.', { timeout: 30_000 });
  await expect(panel).toContainText('Ready to ask.');
  await expect(panel).toContainText(/Drafts ready: \d+ models? wait for review\.|Nothing new to draft\./, { timeout: 120_000 });
  await expect(page.getByTestId('snowflake-app-setup-banner')).toContainText(/drafted|ZLens read 5 tables/, { timeout: 30_000 });
});
