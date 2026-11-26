import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutionOptions, QueryExecutor, QueryResult } from '@zlens/connectors';
import { projectHasOwnWork, startLocalServer } from './local-runtime.js';
import type { SnowflakeAppQuery } from './snowflake-app-settings.js';
import { SetupOperationProgress, formatDuration, setupMessage, setupPercent, type SetupDetail } from './setup-operation-progress.js';

/**
 * Onboarding design P2 and P3: setup runs in two stages, each a background
 * operation with phases and counts. The person chooses what ZLens reads;
 * reading names makes it ready to ask; the data checks follow in the
 * background. Stop cancels a stage within seconds; a stopped stage writes
 * nothing and starts again only when someone asks.
 */

const result = (rows: Array<Record<string, unknown>>): QueryResult => ({ columns: [], rows, rowCount: rows.length, executionTimeMs: 1 });

/** What the container wrote to the app's own core.setup_status (onboarding design P5). */
const setupStatusWrites: string[] = [];

function fakeAppSettings(): SnowflakeAppQuery {
  return (async (sql: string) => {
    if (sql.startsWith('MERGE INTO ZLENS_APP.CORE.SETUP_STATUS')) {
      setupStatusWrites.push(sql);
      return [];
    }
    if (sql.includes('GET_CONFIGURATION_VALUE')) return [{ V: 'jsmith' }];
    if (sql.startsWith('SHOW TERSE DATABASES')) return [{ name: 'ZLENS_APP', kind: 'STANDARD' }, { name: 'SALES', kind: 'STANDARD' }];
    if (sql.startsWith('SHOW TERSE SCHEMAS IN DATABASE')) return [{ name: 'INFORMATION_SCHEMA' }, { name: 'PUBLIC' }];
    if (sql.startsWith('SHOW TERSE OBJECTS IN SCHEMA')) return [{ name: 'ORDERS' }];
    throw new Error(`unexpected SQL: ${sql}`);
  }) as SnowflakeAppQuery;
}

/** A warehouse whose column read waits until it is cancelled (`hang`), or answers at once. */
function fakeWarehouse(options: { hang: boolean }) {
  const statements: string[] = [];
  const executePositional = async (sql: string, _params: unknown[], config: { database?: string }, queryOptions?: QueryExecutionOptions): Promise<QueryResult> => {
    statements.push(sql);
    if (sql.includes('CURRENT_ACCOUNT()')) {
      return result([{ DQL_ACCOUNT_LOCATOR: 'XY1', DQL_ACCOUNT_NAME: 'TEST', DQL_ORGANIZATION: 'ORG', DQL_ACCOUNT: 'ORG-TEST', DQL_DATABASE: config.database, DQL_ROLE: 'APP', DQL_WAREHOUSE: 'WH' }]);
    }
    if (sql.startsWith('SHOW TERSE SCHEMAS')) return result([{ database_name: 'SALES', name: 'PUBLIC' }, { database_name: 'SALES', name: 'INFORMATION_SCHEMA' }]);
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS') && options.hang) {
      return new Promise<QueryResult>((_resolve, reject) => {
        const signal = queryOptions?.signal;
        if (!signal) return;
        if (signal.aborted) reject(new Error('Snowflake query was cancelled.'));
        signal.addEventListener('abort', () => reject(new Error('Snowflake query was cancelled.')), { once: true });
      });
    }
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return result([
        { TABLE_CATALOG: 'SALES', TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'ORDER_ID', DATA_TYPE: 'NUMBER', ORDINAL_POSITION: 1, IS_NULLABLE: 'NO' },
        { TABLE_CATALOG: 'SALES', TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'ORDERS', COLUMN_NAME: 'AMOUNT', DATA_TYPE: 'NUMBER', ORDINAL_POSITION: 2, IS_NULLABLE: 'YES' },
      ]);
    }
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return result([{ TABLE_CATALOG: 'SALES', TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: 'ORDERS', TABLE_TYPE: 'BASE TABLE', ROW_COUNT: 10 }]);
    if (sql.startsWith('SHOW PRIMARY KEYS')) return result([{ schema_name: 'PUBLIC', table_name: 'ORDERS', column_name: 'ORDER_ID', key_sequence: 1 }]);
    return result([]);
  };
  const executor = {
    executePositional,
    executeQuery: (sql: string, _params: unknown[], _variables: unknown, config: { database?: string }, queryOptions?: QueryExecutionOptions) => executePositional(sql, [], config, queryOptions),
    disconnect: async () => undefined,
  } as unknown as QueryExecutor;
  return { executor, statements };
}

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function startApp(executor: QueryExecutor, existingRoot?: string) {
  const projectRoot = existingRoot ?? mkdtempSync(join(tmpdir(), 'zlens-setup-operation-'));
  if (!existingRoot) roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
    project: 'sf',
    manifestVersion: 3,
    modeling: { mode: 'warehouse-first' },
    connections: { default: { driver: 'snowflake', account: 'test-account', username: 'app', database: 'ZLENS_APP' } },
  }));
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor, preferredPort: 0, host: '127.0.0.1',
    snowflakeIngress: {},
    snowflakeAppSettings: { userConfiguration: 'ZLENS_USER', appName: 'ZLENS_APP', ttlMs: 0 },
    snowflakeAppQuery: fakeAppSettings(),
    captureServer: (created) => { servers.push(created); },
  });
  const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'Sf-Context-Current-User': 'JSMITH', 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  type Setup = { state: string; stage?: string; checks?: string; database?: string; relations?: number; operationId?: string; operation?: { id: string; type: string; status: string; phase: string; message: string; cancellable: boolean; detail?: SetupDetail } | null };
  const setup = async (): Promise<Setup> => (await call('/api/snowflake-app/setup')).json() as Promise<Setup>;
  const until = async (done: (value: Setup) => boolean, ms = 15_000): Promise<Setup> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await setup();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`setup never reached the expected state: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { projectRoot, call, setup, until };
}

const read = (app: Awaited<ReturnType<typeof startApp>>, body: Record<string, unknown>) => app.call('/api/connections/default/setup/read', { method: 'POST', body: JSON.stringify({ mode: 'selected_scopes', scopes: [{ catalogOrDatabase: 'SALES', schemas: ['PUBLIC'] }], ...body }) });

describe('setup in two stages, run as background operations (onboarding design P2, P3)', () => {
  it('reads nothing until the person chooses; a read shows its counts, stops within seconds, and starts again only when asked', async () => {
    const warehouse = fakeWarehouse({ hang: true });
    const app = await startApp(warehouse.executor);
    expect((await app.call('/api/connections')).status).toBe(200);
    const launch = await (await app.call('/api/onboarding/launch')).json();
    expect(launch).toMatchObject({ shouldOpen: true, snowflakeAppManaged: true, setupStage: 'choose' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(warehouse.statements.filter((sql) => sql.includes('INFORMATION_SCHEMA'))).toEqual([]);
    expect(await app.setup()).toMatchObject({ state: 'idle', stage: 'choose' });

    const started = await read(app, { check: true, tablesExpected: 40 });
    expect(started.status).toBe(202);
    const reading = await app.until((value) => value.operation?.phase === 'names');
    expect(reading).toMatchObject({ state: 'running', database: 'SALES' });
    expect(reading.operation).toMatchObject({ type: 'warehouse-read', status: 'running', cancellable: true, detail: { kind: 'warehouse-setup', phase: 'names', database: 'SALES', schemas: 1, tablesExpected: 40 } });
    expect(reading.operation!.message).toMatch(/^Reading names in SALES: 0 of 40 tables so far \(statement 1 of 1\) · \d+ s$/);
    const listed = await (await app.call('/api/operations')).json() as { operations: Array<{ id: string; type: string; detail?: unknown }> };
    expect(listed.operations.find((operation) => operation.id === reading.operation!.id)).toMatchObject({ type: 'warehouse-read', detail: { phase: 'names' } });

    const stoppedAt = Date.now();
    expect((await app.call(`/api/operations/${encodeURIComponent(reading.operation!.id)}`, { method: 'DELETE' })).status).toBe(200);
    const stopped = await app.until((value) => value.state === 'stopped', 5_000);
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(stopped.stage).toBe('stopped');
    expect(existsSync(join(app.projectRoot, '.dql', 'warehouse-catalog.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(app.projectRoot, '.dql', 'local', 'warehouse-setup.json'), 'utf8'))).toMatchObject({ read: { state: 'stopped' }, checks: { state: 'off' } });

    // It does not start again by itself.
    const before = warehouse.statements.length;
    await app.call('/api/connections');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await app.setup()).state).toBe('stopped');
    expect(warehouse.statements.length).toBe(before);

    // Start again (the strip's button): the same choice, read again.
    expect((await app.call('/api/snowflake-app/setup', { method: 'POST', body: '{}' })).status).toBe(202);
    const restarted = await app.until((value) => value.operation?.phase === 'names' && value.operation.id !== reading.operation!.id);
    expect(restarted.state).toBe('running');
    await app.call(`/api/operations/${encodeURIComponent(restarted.operation!.id)}`, { method: 'DELETE' });
    await app.until((value) => value.state === 'stopped', 5_000);
  }, 30_000);

  it('is ready to ask once names are read, then checks the data in the background and says done', async () => {
    const warehouse = fakeWarehouse({ hang: false });
    const app = await startApp(warehouse.executor);
    expect((await app.call('/api/connections')).status).toBe(200);
    expect((await read(app, { check: true })).status).toBe(202);
    const done = await app.until((value) => value.state === 'done' || value.state === 'failed' || value.stage === 'failed', 20_000);
    expect(done).toMatchObject({ state: 'done', stage: 'checked', database: 'SALES', relations: 1 });
    const status = await (await app.call('/api/connections/default/setup')).json() as { stage: string; setup: { read: { state: string; relations: number }; checks: { state: string } } };
    expect(status).toMatchObject({ stage: 'checked', setup: { read: { state: 'done', relations: 1 }, checks: { state: 'done' } } });
    // Names, then keys and comments, then the checks: in that order.
    const firstColumns = warehouse.statements.findIndex((sql) => sql.includes('INFORMATION_SCHEMA.COLUMNS'));
    const primaryKeys = warehouse.statements.findIndex((sql) => sql.startsWith('SHOW PRIMARY KEYS'));
    expect(firstColumns).toBeGreaterThan(-1);
    expect(primaryKeys).toBeGreaterThan(firstColumns);
    // Set up: the wizard does not open again, and the app's own record says done.
    expect(await (await app.call('/api/onboarding/launch')).json()).toMatchObject({ shouldOpen: false });
    // The launcher page's status row was kept as setup went: reading, then ready and checking, then checked.
    const stages = setupStatusWrites.map((sql) => /'(\w+)' AS stage/.exec(sql)?.[1]);
    expect(stages[0]).toBe('reading');
    expect(stages).toContain('checking');
    expect(stages.at(-1)).toBe('checked');
    expect(setupStatusWrites.at(-1)).toContain("'ZLens is ready to ask. Background checks done: drafts wait for review.' AS line, 100 AS percent");
    expect(JSON.parse(readFileSync(join(app.projectRoot, '.dql', 'local', 'snowflake-app-setup.json'), 'utf8'))).toMatchObject({ state: 'done', database: 'SALES' });
  }, 30_000);

  it('with the checks off, stops at ready; Check the data runs them', async () => {
    const warehouse = fakeWarehouse({ hang: false });
    const app = await startApp(warehouse.executor);
    expect((await app.call('/api/connections')).status).toBe(200);
    expect((await read(app, { check: false })).status).toBe(202);
    const ready = await app.until((value) => value.state === 'ready', 15_000);
    expect(ready).toMatchObject({ stage: 'ready', relations: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await app.setup()).state).toBe('ready');
    expect((await app.call('/api/connections/default/setup/check', { method: 'POST', body: '{}' })).status).toBe(202);
    expect(await app.until((value) => value.state === 'done', 15_000)).toMatchObject({ stage: 'checked' });
  }, 30_000);

  it('says what the drafts hold, and drafts into the Domain named; the name stays for the next run (onboarding D8)', async () => {
    const warehouse = fakeWarehouse({ hang: false });
    const app = await startApp(warehouse.executor);
    expect((await app.call('/api/connections')).status).toBe(200);
    expect((await read(app, { check: false })).status).toBe(202);
    await app.until((value) => value.state === 'ready', 15_000);
    type Status = { stage: string; setup: { draft?: { domain?: string; includeStaging?: boolean }; checks: { state: string; proposalId?: string; summary?: { models: number; relations: number; validated: boolean; domain?: string } } } };
    const status = async () => await (await app.call('/api/connections/default/setup')).json() as Status;
    expect((await app.call('/api/connections/default/setup/check', { method: 'POST', body: JSON.stringify({ domain: '  Sales team  ' }) })).status).toBe(202);
    await app.until((value) => value.state === 'done', 15_000);
    const named = await status();
    expect(named.setup.draft).toEqual({ domain: 'Sales team' });
    expect(named.setup.checks).toMatchObject({ state: 'done', summary: { relations: 1, validated: true } });
    if (named.setup.checks.proposalId) expect(named.setup.checks.summary?.domain).toBe('Sales team');
    // Show staging tables: the Domain name is kept beside it, and a check run again keeps both.
    expect((await app.call('/api/connections/default/setup/check', { method: 'POST', body: JSON.stringify({ includeStaging: true }) })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.until((value) => value.state === 'done', 15_000);
    expect((await status()).setup.draft).toEqual({ domain: 'Sales team', includeStaging: true });
    // Read again on the same connection: the choices stay for its drafts.
    expect((await read(app, { check: false })).status).toBe(202);
    await app.until((value) => value.state === 'ready', 15_000);
    expect((await status()).setup.draft).toEqual({ domain: 'Sales team', includeStaging: true });
  }, 45_000);

  it('a project with work of its own (a saved query) opens no wizard, whatever it recorded', async () => {
    const warehouse = fakeWarehouse({ hang: false });
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-setup-own-work-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, 'blocks', 'nba'), { recursive: true });
    writeFileSync(join(projectRoot, 'blocks', 'nba', 'wins.dql'), 'block "wins" {\n  query = "SELECT 1"\n}\n');
    const app = await startApp(warehouse.executor, projectRoot);
    expect((await app.call('/api/connections')).status).toBe(200);
    expect(await (await app.call('/api/onboarding/launch')).json()).toMatchObject({ shouldOpen: false, snowflakeAppManaged: true });
    expect(projectHasOwnWork(projectRoot)).toBe(true);
    const fresh = mkdtempSync(join(tmpdir(), 'zlens-setup-fresh-'));
    roots.push(fresh);
    mkdirSync(join(fresh, 'notebooks'), { recursive: true });
    writeFileSync(join(fresh, 'notebooks', 'welcome.dqlnb'), '{}');
    expect(projectHasOwnWork(fresh)).toBe(false);
  }, 30_000);

  it('an install set up before keeps its model: no wizard, nothing read or drafted again', async () => {
    const warehouse = fakeWarehouse({ hang: false });
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-setup-upgrade-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, '.dql', 'local'), { recursive: true });
    writeFileSync(join(projectRoot, '.dql', 'local', 'snowflake-app-setup.json'), JSON.stringify({ state: 'done', database: 'SALES', schemas: ['PUBLIC'], relations: 5, drafted: 5, at: '2026-11-20T00:00:00Z' }));
    const app = await startApp(warehouse.executor, projectRoot);
    expect((await app.call('/api/connections')).status).toBe(200);
    expect(await (await app.call('/api/onboarding/launch')).json()).toMatchObject({ shouldOpen: false, snowflakeAppManaged: true });
    expect(await app.setup()).toMatchObject({ state: 'done', database: 'SALES', relations: 5 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(warehouse.statements.filter((sql) => sql.includes('INFORMATION_SCHEMA'))).toEqual([]);
  }, 30_000);
});

describe('the words of a setup in progress', () => {
  const base: SetupDetail = { kind: 'warehouse-setup', phase: 'names', tables: 420, startedAt: '', phaseStartedAt: '', elapsedMs: 12_400, database: 'SALES' };

  it('always says numbers and the time so far', () => {
    expect(setupMessage({ ...base, statementsDone: 0, statements: 2, tablesExpected: 1240 })).toBe('Reading names in SALES: 420 of 1,240 tables so far (statement 1 of 2) · 12 s');
    expect(setupMessage({ ...base, phase: 'catalog', statementsDone: 3, statements: 5 })).toBe('Reading keys and comments in SALES (statement 4 of 5): 420 tables · 12 s');
    expect(setupMessage({ ...base, phase: 'check', elapsedMs: 185_000 })).toBe('Checking keys and joins on the data in SALES · 3 min 05 s');
    expect(formatDuration(3_725_000)).toBe('1 h 02 min');
  });

  it('moves its progress forward within each phase', () => {
    expect(setupPercent({ ...base, statementsDone: 0, statements: 2 })).toBe(5);
    expect(setupPercent({ ...base, statementsDone: 1, statements: 2 })).toBe(18);
    expect(setupPercent({ ...base, phase: 'check' })).toBe(50);
  });

  it('reports again on a heartbeat while a statement runs', async () => {
    const reports: Array<{ message?: string }> = [];
    let now = 0;
    const progress = new SetupOperationProgress((report) => reports.push(report), { database: 'SALES' }, () => now);
    progress.phase('names');
    now = 4_000;
    const stop = progress.heartbeat(10);
    await new Promise((resolve) => setTimeout(resolve, 35));
    stop();
    expect(reports.length).toBeGreaterThanOrEqual(3);
    expect(reports.at(-1)?.message).toBe('Reading names in SALES: 0 tables so far · 4 s');
    // The count never goes back when the keys-and-comments read starts.
    progress.read({ queriesDone: 1, queries: 1, tables: 420 });
    progress.phase('catalog');
    progress.read({ queriesDone: 0, queries: 5, tables: 0 });
    expect(progress.current.tables).toBe(420);
  });
});

describe('long schema syncs and drafts are answered as long requests (onboarding design P2)', () => {
  it('a page that asks gets 202 and polls for the sync answer; one that does not is answered as before', async () => {
    const warehouse = fakeWarehouse({ hang: false });
    const slow = {
      ...warehouse.executor,
      executePositional: async (...args: Parameters<QueryExecutor['executePositional']>) => {
        if (args[0].includes('INFORMATION_SCHEMA.COLUMNS')) await new Promise((resolve) => setTimeout(resolve, 300));
        return warehouse.executor.executePositional(...args);
      },
    } as unknown as QueryExecutor;
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-setup-long-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'shop', manifestVersion: 3, modeling: { mode: 'warehouse-first' },
      connections: { default: { driver: 'snowflake', account: 'test-account', username: 'app', database: 'SALES' } },
    }));
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor: slow, connection: null, preferredPort: 0, captureServer: (created) => { servers.push(created); } });
    const body = JSON.stringify({ mode: 'selected_scopes', scopes: [{ catalogOrDatabase: 'SALES', schemas: ['PUBLIC'] }] });
    const first = await fetch(`http://127.0.0.1:${port}/api/connections/default/metadata-scope`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Prefer: 'respond-async, wait=0' }, body });
    expect(first.status).toBe(202);
    const running = await first.json() as { longRequest: { id: string; poll: string } };
    let answer: Response | undefined;
    for (let tries = 0; tries < 50; tries += 1) {
      answer = await fetch(`http://127.0.0.1:${port}${running.longRequest.poll}`, { headers: { Prefer: 'wait=1' } });
      if (answer.status !== 202) break;
    }
    expect(answer?.status).toBe(200);
    expect(await answer!.json()).toMatchObject({ status: { state: 'ready', relationCount: 1 }, warehouseCatalog: { relations: 1 } });
    // Without the header: one request, as before.
    const plain = await fetch(`http://127.0.0.1:${port}/api/connections/default/metadata-scope`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    expect(plain.status).toBe(200);
  }, 30_000);
});

/** Three tables with no declared keys; the checks can be held on a statement until Stop, or one table can run over its time limit. */
function fakeCheckedWarehouse() {
  const tables = ['CUSTOMERS', 'ORDERS', 'EVENTS'];
  const checks: string[] = [];
  const control = { holdOn: undefined as RegExp | undefined, timeoutOn: undefined as RegExp | undefined };
  const executePositional = async (sql: string, _params: unknown[], config: { database?: string }, queryOptions?: QueryExecutionOptions): Promise<QueryResult> => {
    if (sql.includes('CURRENT_ACCOUNT()')) {
      return result([{ DQL_ACCOUNT_LOCATOR: 'XY1', DQL_ACCOUNT_NAME: 'TEST', DQL_ORGANIZATION: 'ORG', DQL_ACCOUNT: 'ORG-TEST', DQL_DATABASE: config.database, DQL_ROLE: 'APP', DQL_WAREHOUSE: 'WH' }]);
    }
    if (sql.startsWith('SHOW TERSE SCHEMAS')) return result([{ database_name: 'SALES', name: 'PUBLIC' }]);
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return result(tables.flatMap((table) => [
        { TABLE_CATALOG: 'SALES', TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: table, COLUMN_NAME: `${table.slice(0, -1)}_ID`, DATA_TYPE: 'NUMBER', ORDINAL_POSITION: 1, IS_NULLABLE: 'NO' },
        { TABLE_CATALOG: 'SALES', TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: table, COLUMN_NAME: 'CUSTOMER_ID', DATA_TYPE: 'NUMBER', ORDINAL_POSITION: 2, IS_NULLABLE: 'YES' },
      ]));
    }
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return result(tables.map((table, index) => ({ TABLE_CATALOG: 'SALES', TABLE_SCHEMA: 'PUBLIC', TABLE_NAME: table, TABLE_TYPE: 'BASE TABLE', ROW_COUNT: 1000 * (index + 1) })));
    if (sql.startsWith('SHOW')) return result([]);
    // A data check.
    checks.push(sql);
    if (control.timeoutOn?.test(sql)) throw Object.assign(new Error('Snowflake query exceeded the 60000ms deadline.'), { vendorCode: 'TIMEOUT' });
    if (control.holdOn?.test(sql)) {
      return new Promise<QueryResult>((_resolve, reject) => {
        const signal = queryOptions?.signal;
        if (signal?.aborted) reject(new Error('cancelled'));
        signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    }
    return result([{ ROW_COUNT: 100, NN_0: 100, ND_0: 100, NN_1: 100, ND_1: 40, REFERENCING: 100, UNMATCHED: 0 }]);
  };
  const executor = {
    executePositional,
    executeQuery: (sql: string, _params: unknown[], _variables: unknown, config: { database?: string }, queryOptions?: QueryExecutionOptions) => executePositional(sql, [], config, queryOptions),
    disconnect: async () => undefined,
  } as unknown as QueryExecutor;
  return { executor, checks, control };
}

describe('the background checks resume where they stopped (onboarding design P4)', () => {
  it('a check stopped part way repeats no finished statement when it runs again, and counts tables as it goes', async () => {
    const warehouse = fakeCheckedWarehouse();
    // Hold on the first check that reads the largest table: the smaller ones are checked first.
    warehouse.control.holdOn = /"EVENTS"/;
    const app = await startApp(warehouse.executor);
    expect((await app.call('/api/connections')).status).toBe(200);
    expect((await read(app, { check: true })).status).toBe(202);
    const held = await app.until((value) => value.state === 'ready' && value.operation?.type === 'warehouse-check' && (value.operation.detail as SetupDetail | undefined)?.checks?.tablesChecked === 2, 15_000);
    expect(held.operation!.message).toMatch(/^Checking keys and joins in SALES: 2 of 3 tables · \d+ s$/);
    const firstRun = [...warehouse.checks];
    expect(firstRun.some((sql) => sql.includes('"CUSTOMERS"'))).toBe(true);
    await app.call(`/api/operations/${encodeURIComponent(held.operation!.id)}`, { method: 'DELETE' });
    await app.until((value) => value.state === 'ready' && value.checks === 'stopped', 5_000);
    expect(existsSync(join(app.projectRoot, '.dql', 'local', 'setup-checks.jsonl'))).toBe(true);

    // Check the data again: what was answered is not asked again.
    warehouse.control.holdOn = undefined;
    const before = warehouse.checks.length;
    expect((await app.call('/api/snowflake-app/setup', { method: 'POST', body: '{}' })).status).toBe(202);
    const done = await app.until((value) => value.state === 'done', 15_000);
    expect(done.stage).toBe('checked');
    const secondRun = warehouse.checks.slice(before);
    const answered = firstRun.slice(0, -1);
    expect(secondRun.filter((sql) => answered.includes(sql))).toEqual([]);
    expect(secondRun.length).toBeGreaterThan(0);
    const status = await (await app.call('/api/connections/default/setup')).json() as { setup: { checks: { resumed: number } } };
    expect(status.setup.checks.resumed).toBe(new Set(answered).size);
  }, 30_000);

  it('after a restart (the idle stop, an upgrade), checks that were running resume by themselves and repeat nothing', async () => {
    const warehouse = fakeCheckedWarehouse();
    warehouse.control.holdOn = /"EVENTS"/;
    const first = await startApp(warehouse.executor);
    expect((await first.call('/api/connections')).status).toBe(200);
    expect((await read(first, { check: true })).status).toBe(202);
    await first.until((value) => (value.operation?.detail as SetupDetail | undefined)?.checks?.tablesChecked === 2, 15_000);
    const answered = new Set(warehouse.checks.slice(0, -1));
    // ZLens stops with the checks running.
    const server = servers.pop()!;
    await new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); });

    warehouse.control.holdOn = undefined;
    const before = warehouse.checks.length;
    const second = await startApp(warehouse.executor, first.projectRoot);
    roots.push(first.projectRoot);
    expect((await second.call('/api/connections')).status).toBe(200);
    const done = await second.until((value) => value.state === 'done', 15_000);
    expect(done.stage).toBe('checked');
    expect(warehouse.checks.slice(before).filter((sql) => answered.has(sql))).toEqual([]);
  }, 30_000);

  it('a table that runs over the time limit is listed, not waited for again; check it anyway asks again', async () => {
    const warehouse = fakeCheckedWarehouse();
    warehouse.control.timeoutOn = /COUNT\(DISTINCT[^)]*\) AS nd_0 FROM "SALES"\."PUBLIC"\."EVENTS"/;
    const app = await startApp(warehouse.executor);
    expect((await app.call('/api/connections')).status).toBe(200);
    expect((await read(app, { check: true })).status).toBe(202);
    await app.until((value) => value.state === 'done', 15_000);
    const status = await (await app.call('/api/connections/default/setup')).json() as { setup: { checks: { problems: Array<{ relations: string[]; kind: string; text: string }> } } };
    expect(status.setup.checks.problems).toContainEqual({ relations: ['SALES.PUBLIC.EVENTS'], kind: 'too_big', text: 'EVENTS: not checked: a check ran over 60 s, too big for the background check.' });
    const timedOut = warehouse.checks.filter((sql) => warehouse.control.timeoutOn!.test(sql)).length;

    // Checking again keeps the answer: the slow statement is not run again.
    expect((await app.call('/api/connections/default/setup/check', { method: 'POST', body: '{}' })).status).toBe(202);
    await app.until((value) => value.state === 'done', 15_000);
    expect(warehouse.checks.filter((sql) => warehouse.control.timeoutOn!.test(sql)).length).toBe(timedOut);

    // Check it anyway: asked again (with no background time limit).
    warehouse.control.timeoutOn = undefined;
    expect((await app.call('/api/connections/default/setup/check', { method: 'POST', body: JSON.stringify({ anyway: ['SALES.PUBLIC.EVENTS'] }) })).status).toBe(202);
    await app.until((value) => value.state === 'done', 15_000);
    const after = await (await app.call('/api/connections/default/setup')).json() as { setup: { checks: { problems: Array<{ kind: string }> } } };
    expect(after.setup.checks.problems.filter((problem) => problem.kind === 'too_big')).toEqual([]);
  }, 30_000);
});

describe('the idle stop and a running setup (onboarding design P5)', () => {
  it('a setup stage running counts as activity: ZLens is not stopped halfway; once it stops, the quiet spell counts again', async () => {
    const warehouse = fakeWarehouse({ hang: true });
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-setup-idle-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'sf', manifestVersion: 3, modeling: { mode: 'warehouse-first' },
      connections: { default: { driver: 'snowflake', account: 'test-account', username: 'app', database: 'ZLENS_APP' } },
    }));
    const clock = { now: 1_000_000 };
    let idle: { due: () => boolean } | undefined;
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: warehouse.executor, preferredPort: 0, host: '127.0.0.1',
      snowflakeIngress: {},
      snowflakeAppSettings: { userConfiguration: 'ZLENS_USER', appName: 'ZLENS_APP', ttlMs: 0 },
      snowflakeAppQuery: fakeAppSettings(),
      snowflakeIdleSuspend: { minutes: 60, service: 'ZLENS_APP.CORE.ZLENS', now: () => clock.now, capture: (created) => { idle = created as unknown as { due: () => boolean }; } },
      captureServer: (created) => { servers.push(created); },
    });
    const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'Sf-Context-Current-User': 'JSMITH', 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    expect((await call('/api/connections')).status).toBe(200);
    const started = await call('/api/connections/default/setup/read', { method: 'POST', body: JSON.stringify({ mode: 'selected_scopes', scopes: [{ catalogOrDatabase: 'SALES', schemas: ['PUBLIC'] }], check: true }) });
    const { operation } = await started.json() as { operation: { id: string } };
    clock.now += 3 * 60 * 60_000;
    expect(idle!.due()).toBe(false);
    await call(`/api/operations/${encodeURIComponent(operation.id)}`, { method: 'DELETE' });
    for (let tries = 0; tries < 100; tries += 1) {
      const setup = await (await call('/api/snowflake-app/setup')).json() as { state: string };
      if (setup.state === 'stopped') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    clock.now += 61 * 60_000;
    expect(idle!.due()).toBe(true);
  }, 30_000);
});

describe('several databases (onboarding design P6)', () => {
  it('reads every database granted: no "revoke the others", both in the picker, both read in one setup', async () => {
    const statements: string[] = [];
    const executePositional = async (sql: string, _params: unknown[], config: { database?: string }): Promise<QueryResult> => {
      statements.push(sql);
      if (sql.includes('CURRENT_ACCOUNT()')) return result([{ DQL_ACCOUNT_LOCATOR: 'XY1', DQL_ACCOUNT_NAME: 'TEST', DQL_ORGANIZATION: 'ORG', DQL_ACCOUNT: 'ORG-TEST', DQL_DATABASE: config.database, DQL_ROLE: 'APP', DQL_WAREHOUSE: 'WH' }]);
      if (sql.startsWith('SHOW TERSE SCHEMAS')) return result([{ database_name: 'FINANCE', name: 'LEDGER' }, { database_name: 'SALES', name: 'PUBLIC' }]);
      if (sql.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) {
        const database = /"(\w+)"\.INFORMATION_SCHEMA/.exec(sql)?.[1];
        return result([{ TABLE_CATALOG: database, TABLE_SCHEMA: database === 'SALES' ? 'PUBLIC' : 'LEDGER', TABLE_COUNT: 1, VIEW_COUNT: 0, KEYED_TABLE_COUNT: 0, FOREIGN_KEY_COUNT: 0 }]);
      }
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
        const database = /"(\w+)"\.INFORMATION_SCHEMA/.exec(sql)?.[1];
        const [schema, table] = database === 'SALES' ? ['PUBLIC', 'ORDERS'] : ['LEDGER', 'ENTRIES'];
        return result([{ TABLE_CATALOG: database, TABLE_SCHEMA: schema, TABLE_NAME: table, COLUMN_NAME: 'ID', DATA_TYPE: 'NUMBER', ORDINAL_POSITION: 1, IS_NULLABLE: 'NO' }]);
      }
      return result([]);
    };
    const executor = { executePositional, executeQuery: (sql: string, _p: unknown[], _v: unknown, config: { database?: string }) => executePositional(sql, [], config), disconnect: async () => undefined } as unknown as QueryExecutor;
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-setup-several-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'sf', manifestVersion: 3, modeling: { mode: 'warehouse-first' }, connections: { default: { driver: 'snowflake', account: 'test-account', username: 'app', database: 'ZLENS_APP' } } }));
    const appQuery = (async (sql: string) => {
      if (sql.startsWith('MERGE INTO')) return [];
      if (sql.includes('GET_CONFIGURATION_VALUE')) return [{ V: 'jsmith' }];
      if (sql.startsWith('SHOW TERSE DATABASES')) return [{ name: 'ZLENS_APP', kind: 'STANDARD' }, { name: 'SALES', kind: 'STANDARD' }, { name: 'FINANCE', kind: 'STANDARD' }];
      if (sql.startsWith('SHOW TERSE SCHEMAS IN DATABASE')) return [{ name: 'INFORMATION_SCHEMA' }, { name: 'PUBLIC' }];
      if (sql.startsWith('SHOW TERSE OBJECTS IN SCHEMA')) return [{ name: 'T' }];
      throw new Error(`unexpected SQL: ${sql}`);
    }) as SnowflakeAppQuery;
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor, preferredPort: 0, host: '127.0.0.1',
      snowflakeIngress: {}, snowflakeAppSettings: { userConfiguration: 'ZLENS_USER', appName: 'ZLENS_APP', ttlMs: 0 }, snowflakeAppQuery: appQuery,
      captureServer: (created) => { servers.push(created); },
    });
    const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'Sf-Context-Current-User': 'JSMITH', 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

    // Two granted: ZLens serves the person (it used to ask the admin to revoke one).
    expect((await call('/api/connections')).status).toBe(200);
    const discovery = await (await call('/api/connections/default/metadata-scope/discovery', { method: 'POST', body: '{}' })).json() as { scopes: Array<{ catalogOrDatabase: string; schemas: Array<{ name: string; size?: unknown }> }> };
    expect(discovery.scopes.map((scope) => scope.catalogOrDatabase)).toEqual(['FINANCE', 'SALES']);
    expect(discovery.scopes.every((scope) => scope.schemas[0]?.size)).toBe(true);

    const read = await call('/api/connections/default/setup/read', { method: 'POST', body: JSON.stringify({ mode: 'selected_scopes', scopes: [{ catalogOrDatabase: 'SALES', schemas: ['PUBLIC'] }, { catalogOrDatabase: 'FINANCE', schemas: ['LEDGER'] }], check: false }) });
    expect(read.status).toBe(202);
    let setup: { state?: string; database?: string; relations?: number; schemas?: string[]; appName?: string } = {};
    for (let tries = 0; tries < 200 && setup.state !== 'ready' && setup.state !== 'failed'; tries += 1) {
      setup = await (await call('/api/snowflake-app/setup')).json();
      if (setup.state !== 'ready') await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(setup).toMatchObject({ state: 'ready', relations: 2, database: 'FINANCE, SALES', schemas: ['FINANCE.LEDGER', 'SALES.PUBLIC'], appName: 'ZLENS_APP' });
    // One columns read per database.
    expect(statements.filter((sql) => sql.includes('INFORMATION_SCHEMA.COLUMNS') && !sql.includes('TABLE_CONSTRAINTS')).map((sql) => /"(\w+)"\.INFORMATION_SCHEMA/.exec(sql)?.[1]).sort()).toEqual(expect.arrayContaining(['FINANCE', 'SALES']));
  }, 30_000);
});

describe('Check faster (onboarding design P7)', () => {
  it('runs the checks a size up on the app\'s own warehouse and sizes it back when they end; a refusal checks on X-Small and says why', async () => {
    const appStatements: string[] = [];
    let refuse = false;
    const warehouse = fakeCheckedWarehouse();
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-setup-faster-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'sf', manifestVersion: 3, modeling: { mode: 'warehouse-first' }, connections: { default: { driver: 'snowflake', account: 'test-account', username: 'app', database: 'ZLENS_APP', warehouse: 'ZLENS_APP_WH' } } }));
    const base = fakeAppSettings();
    const appQuery = (async (sql: string) => {
      if (sql.startsWith('ALTER WAREHOUSE')) {
        appStatements.push(sql);
        if (refuse) throw new Error('Insufficient privileges to operate on warehouse ZLENS_APP_WH');
        return [];
      }
      return base(sql);
    }) as SnowflakeAppQuery;
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: warehouse.executor, preferredPort: 0, host: '127.0.0.1',
      snowflakeIngress: {}, snowflakeAppSettings: { userConfiguration: 'ZLENS_USER', appName: 'ZLENS_APP', ttlMs: 0 }, snowflakeAppQuery: appQuery,
      captureServer: (created) => { servers.push(created); },
    });
    const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'Sf-Context-Current-User': 'JSMITH', 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    const until = async (state: string) => {
      for (let tries = 0; tries < 300; tries += 1) {
        const setup = await (await call('/api/snowflake-app/setup')).json() as { state: string };
        if (setup.state === state) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`never ${state}`);
    };
    expect((await call('/api/connections')).status).toBe(200);
    expect((await call('/api/connections/default/setup/read', { method: 'POST', body: JSON.stringify({ mode: 'selected_scopes', scopes: [{ catalogOrDatabase: 'SALES', schemas: ['PUBLIC'] }], check: true, checkSize: 'MEDIUM' }) })).status).toBe(202);
    await until('done');
    expect(appStatements).toEqual(["ALTER WAREHOUSE IDENTIFIER('ZLENS_APP_WH') SET WAREHOUSE_SIZE = 'MEDIUM'", "ALTER WAREHOUSE IDENTIFIER('ZLENS_APP_WH') SET WAREHOUSE_SIZE = 'XSMALL'"]);
    let status = await (await call('/api/connections/default/setup')).json() as { setup: { checkSize?: string; checks: { warehouse?: { size: string; resized: boolean; refused?: string } } } };
    expect(status.setup.checkSize).toBe('MEDIUM');
    expect(status.setup.checks.warehouse).toEqual({ size: 'MEDIUM', resized: false });

    // Refused: checked on X-Small, said why, nothing to size back.
    refuse = true;
    appStatements.length = 0;
    expect((await call('/api/connections/default/setup/check', { method: 'POST', body: JSON.stringify({ fresh: true, checkSize: 'SMALL' }) })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await until('done');
    status = await (await call('/api/connections/default/setup')).json() as typeof status;
    expect(status.setup.checks.warehouse).toEqual({ size: 'XSMALL', resized: false, refused: 'Insufficient privileges to operate on warehouse ZLENS_APP_WH' });
    expect(appStatements).toEqual(["ALTER WAREHOUSE IDENTIFIER('ZLENS_APP_WH') SET WAREHOUSE_SIZE = 'SMALL'"]);
  }, 30_000);

  it('never resizes a warehouse that is not the app\'s own', async () => {
    const appStatements: string[] = [];
    const warehouse = fakeCheckedWarehouse();
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-setup-faster-other-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'sf', manifestVersion: 3, modeling: { mode: 'warehouse-first' }, connections: { default: { driver: 'snowflake', account: 'test-account', username: 'app', database: 'ZLENS_APP', warehouse: 'ANALYTICS_WH' } } }));
    const base = fakeAppSettings();
    const appQuery = (async (sql: string) => { if (sql.startsWith('ALTER WAREHOUSE')) { appStatements.push(sql); return []; } return base(sql); }) as SnowflakeAppQuery;
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: warehouse.executor, preferredPort: 0, host: '127.0.0.1',
      snowflakeIngress: {}, snowflakeAppSettings: { userConfiguration: 'ZLENS_USER', appName: 'ZLENS_APP', ttlMs: 0 }, snowflakeAppQuery: appQuery,
      captureServer: (created) => { servers.push(created); },
    });
    const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { 'Sf-Context-Current-User': 'JSMITH', 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    expect((await call('/api/connections')).status).toBe(200);
    await call('/api/connections/default/setup/read', { method: 'POST', body: JSON.stringify({ mode: 'selected_scopes', scopes: [{ catalogOrDatabase: 'SALES', schemas: ['PUBLIC'] }], check: true, checkSize: 'MEDIUM' }) });
    for (let tries = 0; tries < 300; tries += 1) {
      const setup = await (await call('/api/snowflake-app/setup')).json() as { state: string };
      if (setup.state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(appStatements).toEqual([]);
    const status = await (await call('/api/connections/default/setup')).json() as { setup: { checks: { warehouse?: { refused?: string } } } };
    expect(status.setup.checks.warehouse?.refused).toBe("ZLens resizes only the app's own warehouse, <app>_WH");
  }, 30_000);
});
