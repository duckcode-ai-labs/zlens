import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutionOptions, QueryExecutor, QueryResult } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import type { SnowflakeAppQuery } from './snowflake-app-settings.js';
import { SetupOperationProgress, formatDuration, setupMessage, setupPercent, type SetupDetail } from './setup-operation-progress.js';

/**
 * Onboarding design P2: the ZLens app for Snowflake sets itself up as a
 * background operation with phases and counts, and Stop cancels it within
 * seconds. A stopped setup drafts nothing and stays stopped until someone
 * starts it again.
 */

const result = (rows: Array<Record<string, unknown>>): QueryResult => ({ columns: [], rows, rowCount: rows.length, executionTimeMs: 1 });

function fakeAppSettings(): SnowflakeAppQuery {
  return (async (sql: string) => {
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

async function startApp(executor: QueryExecutor) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-setup-operation-'));
  roots.push(projectRoot);
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
  type Setup = { state: string; database?: string; operationId?: string; operation?: { id: string; status: string; phase: string; message: string; cancellable: boolean; detail?: SetupDetail } | null };
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

describe('the app sets itself up as a background operation (onboarding design P2)', () => {
  it('shows its phase and counts, stops within seconds, drafts nothing, and starts again only when asked', async () => {
    const warehouse = fakeWarehouse({ hang: true });
    const app = await startApp(warehouse.executor);
    // Any request by the person starts the setup on the granted database.
    expect((await app.call('/api/connections')).status).toBe(200);
    const reading = await app.until((value) => value.operation?.phase === 'names');
    expect(reading).toMatchObject({ state: 'running', database: 'SALES' });
    expect(reading.operation).toMatchObject({ status: 'running', cancellable: true, detail: { kind: 'warehouse-setup', phase: 'names', database: 'SALES', schemas: 1 } });
    expect(reading.operation!.message).toMatch(/^Reading names in SALES: 0 tables so far \(statement 1 of 1\) · \d+ s$/);

    // The operation is also in the background tasks list, with its counts.
    const listed = await (await app.call('/api/operations')).json() as { operations: Array<{ id: string; type: string; detail?: unknown }> };
    expect(listed.operations.find((operation) => operation.id === reading.operation!.id)).toMatchObject({ type: 'warehouse-setup', detail: { phase: 'names' } });

    const stoppedAt = Date.now();
    const cancelled = await app.call(`/api/operations/${encodeURIComponent(reading.operation!.id)}`, { method: 'DELETE' });
    expect(cancelled.status).toBe(200);
    const stopped = await app.until((value) => value.state === 'stopped', 5_000);
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(stopped.operation).toMatchObject({ status: 'cancelled' });
    // Nothing was read into the project and nothing drafted.
    expect(existsSync(join(app.projectRoot, '.dql', 'warehouse-catalog.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(app.projectRoot, '.dql', 'local', 'snowflake-app-setup.json'), 'utf8'))).toMatchObject({ state: 'stopped', database: 'SALES' });

    // It does not start again by itself.
    const before = warehouse.statements.length;
    await app.call('/api/connections');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await app.setup()).state).toBe('stopped');
    expect(warehouse.statements.length).toBe(before);

    // Start again: a new operation.
    const again = await app.call('/api/snowflake-app/setup', { method: 'POST', body: '{}' });
    expect(again.status).toBe(202);
    const restarted = await app.until((value) => value.operation?.phase === 'names' && value.operationId !== reading.operationId);
    expect(restarted.state).toBe('running');
    await app.call(`/api/operations/${encodeURIComponent(restarted.operation!.id)}`, { method: 'DELETE' });
    await app.until((value) => value.state === 'stopped', 5_000);
  }, 30_000);

  it('reads names, then keys and comments, then checks the drafts, and says done', async () => {
    const warehouse = fakeWarehouse({ hang: false });
    const app = await startApp(warehouse.executor);
    expect((await app.call('/api/connections')).status).toBe(200);
    const done = await app.until((value) => value.state === 'done' || value.state === 'failed', 20_000);
    expect(done).toMatchObject({ state: 'done', database: 'SALES' });
    expect(done.operation).toMatchObject({ status: 'succeeded', type: 'warehouse-setup' });
    // The last counts it reported: one table read.
    expect(done.operation?.detail).toMatchObject({ kind: 'warehouse-setup', tables: 1 });
    // Names, then keys and comments, then the checks: in that order.
    const firstColumns = warehouse.statements.findIndex((sql) => sql.includes('INFORMATION_SCHEMA.COLUMNS'));
    const primaryKeys = warehouse.statements.findIndex((sql) => sql.startsWith('SHOW PRIMARY KEYS'));
    expect(firstColumns).toBeGreaterThan(-1);
    expect(primaryKeys).toBeGreaterThan(firstColumns);
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
