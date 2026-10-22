import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig, type DatabaseConnector, type QueryResult } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import { withRequestContext, type DqlHostHooks, type DqlModelProvider, type DqlPrincipal } from './request-context.js';
import { composeFailedText, statementFailure } from '@zlens/agent';
import { CredentialsRefusedError, RowPolicyRefusedError, WarehouseStatementError, withHostQueryHooks, withRowPolicy, type DqlCredentialsHook, type DqlQueryContext, type DqlRowPolicy } from './row-policy.js';
import { readEnv } from '@zlens/core';

/**
 * RFC 0010 HH-3: one query path. With a host row policy, every statement the
 * server sends to a warehouse passes the policy first, once.
 */
const here = dirname(fileURLToPath(import.meta.url));
const EMPTY: QueryResult = { columns: [], rows: [], rowCount: 0, executionTime: 0 } as unknown as QueryResult;
const maria: DqlPrincipal = { id: 'u-maria', kind: 'person', email: 'maria@insurer.example', attributes: { region: 'CA' }, source: 'host' };

class RecordingExecutor extends QueryExecutor {
  readonly ran: Array<{ via: string; sql: string; values?: unknown[] }> = [];
  readonly configs: ConnectionConfig[] = [];
  override async executePositional(sql: string, values: unknown[], config?: ConnectionConfig, _options?: unknown): Promise<QueryResult> {
    if (config) this.configs.push(config);
    this.ran.push({ via: 'executor', sql, values });
    return EMPTY;
  }
  override async getConnector(config?: ConnectionConfig): Promise<DatabaseConnector> {
    if (config) this.configs.push(config);
    const ran = this.ran;
    const connector = {
      driverName: 'duckdb',
      async execute(sql: string, values?: unknown[]) { ran.push({ via: 'connector', sql, values }); return EMPTY; },
      async *stream(sql: string, values?: unknown[]) { ran.push({ via: 'stream', sql, values }); yield { rows: [] }; },
      async openConsistentReadScope() {
        return { id: 's1', async execute(sql: string, values?: unknown[]) { ran.push({ via: 'scope', sql, values }); return EMPTY; }, async close() {} };
      },
      async ping() { return true; },
    };
    return connector as unknown as DatabaseConnector;
  }
}

describe('the one query path (RFC 0010 HH-3)', () => {
  const connection: ConnectionConfig = { driver: 'duckdb', filepath: ':memory:' };

  it('tells a statements observer each outcome and duration, never the SQL (HH-6)', async () => {
    const events: Array<Record<string, unknown>> = [];
    const inner = new RecordingExecutor();
    const executor = withHostQueryHooks(inner, {
      rowPolicy: (query) => (query.sql.includes('secret') ? { refuse: 'No.' } : { sql: query.sql }),
      statements: (event) => { events.push(event as unknown as Record<string, unknown>); },
    });
    await executor.executePositional('SELECT 1', [], connection, { purpose: 'metadata' });
    await expect(executor.executePositional('SELECT * FROM secret', [], connection)).rejects.toThrow('No.');
    const connector = await executor.getConnector(connection);
    await connector.execute('SELECT 2');
    // Without a policy the observer still hears of each statement; a failing run is an error.
    const failing = new RecordingExecutor();
    failing.executePositional = async () => { throw new Error('warehouse down'); };
    await expect(withHostQueryHooks(failing, { statements: (event) => { events.push(event as unknown as Record<string, unknown>); } }).executePositional('SELECT 3', [], connection)).rejects.toThrow('warehouse down');
    expect(events.map(({ driver, purpose, outcome }) => ({ driver, purpose, outcome }))).toEqual([
      { driver: 'duckdb', purpose: 'metadata', outcome: 'ok' },
      { driver: 'duckdb', purpose: 'data', outcome: 'refused' },
      { driver: 'duckdb', purpose: 'data', outcome: 'ok' },
      { driver: 'duckdb', purpose: 'data', outcome: 'error' },
    ]);
    for (const event of events) {
      expect(typeof event.durationMs).toBe('number');
      expect(Object.keys(event).sort()).toEqual(['at', 'driver', 'durationMs', 'outcome', 'purpose']);
    }
    // An observer that throws never fails the statement.
    await withHostQueryHooks(new RecordingExecutor(), { statements: () => { throw new Error('metrics down'); } }).executePositional('SELECT 4', [], connection);
  });

  it('checks every kind of statement once, as the signed-in person, and runs what the policy returns', async () => {
    const seen: DqlQueryContext[] = [];
    const policy: DqlRowPolicy = (query) => {
      seen.push(query);
      return { sql: `${query.sql} /* as ${query.principal?.id ?? 'system'} */` };
    };
    const inner = new RecordingExecutor();
    const executor = withRowPolicy(inner, policy);

    await withRequestContext({ principal: maria, requestId: 'r1' }, async () => {
      await executor.executeQuery('SELECT * FROM main.order_lines WHERE region = ?', [{ name: 'region', position: 1 } as never], { region: 'CA' }, connection);
      await executor.executePositional('SELECT 1', [], connection, { purpose: 'metadata' });
      const connector = await executor.getConnector(connection);
      await connector.execute('SELECT 2');
      for await (const _batch of connector.stream!('SELECT 3')) { /* drain */ }
      const scope = await (connector as unknown as { openConsistentReadScope(): Promise<{ execute(sql: string): Promise<QueryResult> }> }).openConsistentReadScope();
      await scope.execute('SELECT 4');
    });
    await executor.executePositional('SELECT 5', [], connection);

    expect(inner.ran.map((entry) => [entry.via, entry.sql])).toEqual([
      ['executor', 'SELECT * FROM main.order_lines WHERE region = ? /* as u-maria */'],
      ['executor', 'SELECT 1 /* as u-maria */'],
      ['connector', 'SELECT 2 /* as u-maria */'],
      ['stream', 'SELECT 3 /* as u-maria */'],
      ['scope', 'SELECT 4 /* as u-maria */'],
      ['executor', 'SELECT 5 /* as system */'],
    ]);
    expect(seen).toHaveLength(6);
    expect(seen[0]).toMatchObject({ relations: ['main.order_lines'], params: ['CA'], purpose: 'data', connection: { driver: 'duckdb' } });
    expect(seen[1]?.purpose).toBe('metadata');
    expect(seen[5]?.principal).toBeNull();
  });

  it('runs nothing when the policy refuses, fails, or answers with no SQL', async () => {
    for (const policy of [
      (() => ({ refuse: 'Claims data is restricted.' })) as DqlRowPolicy,
      (() => { throw new Error('policy store down'); }) as DqlRowPolicy,
      (() => ({ sql: '   ' })) as DqlRowPolicy,
    ]) {
      const inner = new RecordingExecutor();
      const executor = withRowPolicy(inner, policy);
      await expect(executor.executePositional('SELECT * FROM claims', [], connection)).rejects.toBeInstanceOf(RowPolicyRefusedError);
      await expect((await executor.getConnector(connection)).execute('SELECT * FROM claims')).rejects.toBeInstanceOf(RowPolicyRefusedError);
      expect(inner.ran).toEqual([]);
    }
    const refused = withRowPolicy(new RecordingExecutor(), () => ({ refuse: 'Claims data is restricted.' }));
    await expect(refused.executePositional('SELECT 1', [], connection)).rejects.toThrow('Claims data is restricted.');
  });

  it('refuses in its own words, never repeating it, when the policy answers with something that is not one of its two shapes', async () => {
    const answer = 'SELECT id FROM claims /* rewrite-text-7c1d */';
    for (const junk of [answer, 42, true, [answer], null, undefined]) {
      const inner = new RecordingExecutor();
      const executor = withRowPolicy(inner, (() => junk) as unknown as DqlRowPolicy);
      const refusal = await executor.executePositional('SELECT * FROM claims', [], connection).then(() => undefined, (error: unknown) => error);
      expect(refusal, String(junk)).toBeInstanceOf(RowPolicyRefusedError);
      expect((refusal as Error).message).toBe('ZLens could not check what you may see, so it did not run this query.');
      expect(inner.ran).toEqual([]);
    }
  });

  it('hands over a grouped result only when every group holds the host\'s minimum of rows, on every way a statement runs', async () => {
    const rowsOf = (counts: number[]) => counts.map((n, index) => ({ diagnosis: `D${index}`, n: 10 + index, HOST_GROUP_ROWS: n }));
    let counts = [7, 5];
    const result = () => ({ columns: [{ name: 'diagnosis', type: 'string' }, { name: 'n', type: 'number' }, { name: 'HOST_GROUP_ROWS', type: 'number' }], rows: rowsOf(counts), rowCount: counts.length, executionTime: 0 }) as unknown as QueryResult;
    class Grouped extends RecordingExecutor {
      override async executePositional(_sql: string, _values: unknown[], _config?: ConnectionConfig): Promise<QueryResult> { return result(); }
      override async getConnector(_config?: ConnectionConfig): Promise<DatabaseConnector> {
        return {
          driverName: 'duckdb',
          async execute() { return result(); },
          async *stream() { yield { columns: result().columns, rows: result().rows.slice(0, 1), rowCount: 1, byteCount: 1 }; yield { columns: result().columns, rows: result().rows.slice(1), rowCount: 1, byteCount: 1 }; },
          async openConsistentReadScope() { return { id: 's', async execute() { return result(); }, async close() {} }; },
          async ping() { return true; },
        } as unknown as DatabaseConnector;
      }
    }
    const check = { column: 'host_group_rows', minimum: 5, refusal: 'Some groups are too small for the model.' };
    const executor = withRowPolicy(new Grouped(), (query) => ({ sql: query.sql, groupRows: check }));
    const runAll = async () => {
      const connector = await executor.getConnector(connection);
      const scope = await (connector as unknown as { openConsistentReadScope(): Promise<{ execute(sql: string): Promise<QueryResult> }> }).openConsistentReadScope();
      const streamed: Array<Record<string, unknown>> = [];
      for await (const batch of connector.stream!('SELECT 1')) streamed.push(...batch.rows);
      return [(await executor.executePositional('SELECT 1', [], connection)).rows, (await connector.execute('SELECT 1')).rows, (await scope.execute('SELECT 1')).rows, streamed];
    };
    // Every group big enough: the rows pass, without the count column, whatever case the engine gave it.
    for (const rows of await runAll()) expect(rows).toEqual([{ diagnosis: 'D0', n: 10 }, { diagnosis: 'D1', n: 11 }]);
    expect((await executor.executePositional('SELECT 1', [], connection)).columns.map((column) => column.name)).toEqual(['diagnosis', 'n']);
    // One group too small: refused on every path, no row handed over (a stream holds its batches until the check).
    counts = [7, 1];
    await expect(executor.executePositional('SELECT 1', [], connection)).rejects.toThrow('Some groups are too small for the model.');
    const connector = await executor.getConnector(connection);
    await expect(connector.execute('SELECT 1')).rejects.toBeInstanceOf(RowPolicyRefusedError);
    const handed: unknown[] = [];
    await expect((async () => { for await (const batch of connector.stream!('SELECT 1')) handed.push(...batch.rows); })()).rejects.toBeInstanceOf(RowPolicyRefusedError);
    expect(handed).toEqual([]);
    // A row with no count, or a check the host got wrong, is refused too.
    counts = [7, Number.NaN];
    await expect(executor.executePositional('SELECT 1', [], connection)).rejects.toBeInstanceOf(RowPolicyRefusedError);
    const malformed = withRowPolicy(new Grouped(), (query) => ({ sql: query.sql, groupRows: { column: '', minimum: 0, refusal: 'x' } }));
    await expect(malformed.executePositional('SELECT 1', [], connection)).rejects.toThrow('could not check what you may see');
  });

  it('has no other way to a warehouse in server code: no second executor, pool or connector', () => {
    const src = resolve(here, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) files.push(path);
      }
    };
    walk(src);
    const direct = files
      .filter((file) => /new (QueryExecutor|ConnectionPoolManager|[A-Za-z]+Connector)\(/.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(src, file).replaceAll('\\', '/'))
      .sort();
    // One-shot CLI commands own their process; the block scheduler runs only
    // under `zlens notebook` (schedules join the one path in HH-8); `zlens agent`
    // tools run in the CLI, not the server.
    const allowed = new Set([
      'commands/certify.ts', 'commands/doctor.ts', 'commands/model.ts', 'commands/notebook.ts', 'commands/preview.ts',
      'commands/schedule.ts', 'commands/semantic.ts', 'commands/serve.ts', 'commands/sync.ts', 'commands/test.ts',
      'schedule/service.ts', 'llm/answer-loop-tools.ts',
    ]);
    expect(direct.filter((file) => !allowed.has(file))).toEqual([]);
    for (const pkg of ['dql-agent', 'dql-mcp']) {
      const manifest = JSON.parse(readFileSync(resolve(here, `../../../../packages/${pkg}/package.json`), 'utf-8')) as { dependencies?: Record<string, string> };
      expect(Object.keys(manifest.dependencies ?? {}), `${pkg} must reach warehouses only through the server`).not.toContain('@zlens/connectors');
    }
  });
});

describe('whose credentials (RFC 0010 HH-4)', () => {
  const service: ConnectionConfig = { driver: 'snowflake', account: 'insurer', username: 'dql_service', password: 'service-secret', role: 'REPORTING' } as ConnectionConfig;
  const tokens: Record<string, string> = { 'u-maria': 'maria-oauth-token' };
  const credentials: DqlCredentialsHook = ({ principal, connection }) => {
    if (!principal) return { connection: {} };
    const token = tokens[principal.id];
    if (!token) return { refuse: 'Reconnect to Snowflake to run this query.' };
    return { connection: { authenticator: 'OAUTH', token, username: principal.email, password: undefined, role: 'ANALYST', driver: 'duckdb' as never, account: connection.account } };
  };

  it('runs each statement as the person, before the row policy, and keeps the driver', async () => {
    const seen: DqlQueryContext[] = [];
    const inner = new RecordingExecutor();
    const executor = withHostQueryHooks(inner, { credentials, rowPolicy: (query) => { seen.push(query); return { sql: query.sql }; } });
    await withRequestContext({ principal: maria, requestId: 'r1' }, async () => {
      await executor.executePositional('SELECT 1', [], service);
      await (await executor.getConnector(service)).execute('SELECT 2');
    });
    await executor.executePositional('SELECT 3', [], service);
    expect(inner.configs[0]).toMatchObject({ driver: 'snowflake', authenticator: 'OAUTH', token: 'maria-oauth-token', username: 'maria@insurer.example', role: 'ANALYST' });
    expect(inner.configs[0]?.password).toBeUndefined();
    expect(inner.configs[1]).toMatchObject({ token: 'maria-oauth-token' });
    expect(inner.configs[2]).toEqual(service);
    expect(seen[0]?.connection.driver).toBe('snowflake');
    expect(inner.ran.map((entry) => entry.sql)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  it('stops with "reconnect" and never falls back to the service credential', async () => {
    const dev: DqlPrincipal = { id: 'u-dev', kind: 'person', email: 'dev@insurer.example', source: 'host' };
    for (const hook of [credentials, (() => { throw new Error('vault down'); }) as DqlCredentialsHook, (() => ({})) as unknown as DqlCredentialsHook]) {
      const inner = new RecordingExecutor();
      const executor = withHostQueryHooks(inner, { credentials: hook });
      await withRequestContext({ principal: dev, requestId: 'r2' }, async () => {
        await expect(executor.executePositional('SELECT 1', [], service)).rejects.toBeInstanceOf(CredentialsRefusedError);
        await expect(executor.getConnector(service)).rejects.toBeInstanceOf(CredentialsRefusedError);
      });
      expect(inner.ran).toEqual([]);
      expect(inner.configs).toEqual([]);
    }
    const inner = new RecordingExecutor();
    await withRequestContext({ principal: dev, requestId: 'r3' }, () => expect(withHostQueryHooks(inner, { credentials }).executePositional('SELECT 1', [], service)).rejects.toThrow('Reconnect to Snowflake to run this query.'));
  });

  it('refuses in its own words, never repeating it, when the hook answers with a bare value instead of a connection', async () => {
    const token = 'token-text-5e2a';
    for (const junk of [token, 7, [token], { connection: token }, { connection: [token] }, { connection: null }]) {
      const inner = new RecordingExecutor();
      const executor = withHostQueryHooks(inner, { credentials: (() => junk) as unknown as DqlCredentialsHook });
      const refusal = await executor.executePositional('SELECT 1', [], service).then(() => undefined, (error: unknown) => error);
      expect(refusal, JSON.stringify(junk)).toBeInstanceOf(CredentialsRefusedError);
      expect((refusal as Error).message).toBe('ZLens could not get your warehouse sign-in. Reconnect and try again.');
      expect(inner.ran).toEqual([]);
    }
  });

  it('leaves the executor untouched without host query hooks', () => {
    const inner = new RecordingExecutor();
    expect(withHostQueryHooks(inner, {})).toBe(inner);
  });
});

const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(here, '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(here, '../../../../scripts/seed-eval-warehouse.mjs');

describe('two people, the same questions, different rows (RFC 0010 HH-3)', () => {
  duckDbIt('narrows a certified Dataset and SQL a person writes, and refuses what the policy refuses', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-row-policy-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    const people: Record<string, DqlPrincipal> = {
      admin: { id: 'u-admin', kind: 'person', email: 'admin@insurer.example', groups: ['admins'], source: 'host' },
      ca: { id: 'u-ca', kind: 'person', email: 'ca@insurer.example', attributes: { region: 'CA' }, source: 'host' },
      us: { id: 'u-us', kind: 'person', email: 'us@insurer.example', attributes: { region: 'US' }, source: 'host' },
      none: { id: 'u-none', kind: 'person', email: 'none@insurer.example', source: 'host' },
    };
    const policy: DqlRowPolicy = ({ principal, sql, purpose, relations }) => {
      if (purpose === 'metadata' || principal === null || principal.groups?.includes('admins')) return { sql };
      if (!relations.includes('main.order_lines')) return { sql };
      const region = principal.attributes?.region;
      if (typeof region !== 'string') return { refuse: 'Your profile has no region, so you may not see order lines.' };
      return { sql: sql.replace(/(?:"main"|main)\."?order_lines"?/g, `(SELECT * FROM "main"."order_lines" WHERE "region" = '${region.replace(/'/g, "''")}') AS "order_lines"`) };
    };
    const hostHooks: DqlHostHooks = {
      resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
      rowPolicy: policy,
    };
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, hostHooks, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const call = async (person: string, path: string, body?: unknown) => {
        const response = await fetch(`${base}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-person': person },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
      };

      // An admin creates a certified Dataset from the table; the schema listing is metadata.
      const tables = await call('ca', '/api/app-datasets/tables');
      expect(tables.status, tables.text).toBe(200);
      const table = tables.body.tables.find((entry: { name: string }) => entry.name === 'order_lines');
      const created = await call('admin', '/api/app-datasets/tables/create', { tableId: table.id, name: 'Order lines', domain: 'commerce' });
      expect(created.status, created.text).toBe(201);
      // Checking leaves it Checked · Needs certifying; the admin certifies it on purpose (design Q1).
      expect(created.body.status).toBe('checked');
      const certified = await call('admin', '/api/app-datasets/certify', { sourceId: created.body.sourceId });
      expect(certified.status, certified.text).toBe(200);

      // The same Dataset question, asked by each person.
      const byRegion = { dimensions: [{ field: 'region' }], measures: [{ measure: 'order_line_count' }] };
      const rows = async (person: string) => {
        const run = await call(person, '/api/app-datasets/run', { sourceId: created.body.sourceId, query: byRegion });
        expect(run.status, `${person}: ${run.text}`).toBe(200);
        return (run.body.result.rows as Array<{ region: string; order_line_count: number }>).map((row) => [row.region, Number(row.order_line_count)]).sort();
      };
      expect(await rows('admin')).toEqual([['CA', 3], ['US', 5]]);
      expect(await rows('ca')).toEqual([['CA', 3]]);
      expect(await rows('us')).toEqual([['US', 5]]);

      // SQL a person writes, through the same path.
      const sql = { sql: 'SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region ORDER BY region' };
      const mine = await call('ca', '/api/query', sql);
      expect(mine.status, mine.text).toBe(200);
      expect(JSON.stringify(mine.body)).toContain('CA');
      expect(JSON.stringify(mine.body)).not.toContain('"US"');

      // Someone the policy refuses gets the refusal, not rows.
      const refusedRun = await call('none', '/api/app-datasets/run', { sourceId: created.body.sourceId, query: byRegion });
      expect(refusedRun.body.ok).toBe(false);
      expect(refusedRun.body.result?.rows ?? []).toEqual([]);
      expect(refusedRun.text).toContain('Your profile has no region');
      const refusedSql = await call('none', '/api/query', sql);
      expect(refusedSql.text).toContain('Your profile has no region');
      expect(refusedSql.text).not.toMatch(/"n":\s*\d/);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('where a chart\'s values came from (RFC 0010 HH-5)', () => {
  duckDbIt('names the tables an App chart read when a question about it may reach the host\'s model', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-boundary-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    const analyst: DqlPrincipal = { id: 'u-analyst', kind: 'person', email: 'analyst@example.test', appGrants: { 'commerce-pilot': 'execute' }, source: 'host' };
    const boundary: Array<string[] | undefined> = [];
    const model = { name: 'claude', available: async () => true, generate: async () => 'Answered from the chart.' } as unknown as DqlModelProvider;
    const hostHooks: DqlHostHooks = {
      resolvePrincipal: () => analyst,
      rowPolicy: ({ sql }) => ({ sql }),
      modelProvider: () => ({ id: 'anthropic', provider: model }),
      isInBoundary: (_model, context) => { boundary.push(context?.relations); return true; },
    };
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, hostHooks, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const post = async (path: string, body: unknown) => {
        const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
      };
      const run = await post('/api/apps/commerce-pilot/dashboards/overview/run', {});
      expect(run.status, run.text).toBe(200);
      const tile = (run.body.tiles as Array<{ tileId: string; status: string; tileType?: string; error?: string }>)
        .find((candidate) => candidate.status === 'ok' && candidate.tileType === 'dataset');
      expect(tile, JSON.stringify(run.body.tiles.map((t: { tileId: string; status: string; error?: string }) => [t.tileId, t.status, t.error]))).toBeTruthy();
      const asked = await post('/api/apps/commerce-pilot/ask', { question: 'What stands out?', dashboardId: 'overview', tileId: tile!.tileId, runId: run.body.runId });
      expect(asked.status, asked.text).toBe(200);
      // The boundary rule heard exactly which tables the chart's values came from.
      expect(boundary.at(-1)).toEqual(['order_lines']);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);

  duckDbIt('finds the chart a person ran when the host marks the question for the model, and hands its rows over only inside the boundary', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-chart-owner-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    const servers: Server[] = [];
    const people: Record<string, DqlPrincipal> = {
      analyst: { id: 'u-analyst', kind: 'person', email: 'analyst@example.test', appGrants: { 'commerce-pilot': 'execute' }, source: 'host' },
      other: { id: 'u-other', kind: 'person', email: 'other@example.test', appGrants: { 'commerce-pilot': 'execute' }, source: 'host' },
    };
    const prompts: string[] = [];
    const model = { name: 'claude', available: async () => true, generate: async (messages: Array<{ content: string }>) => { prompts.push(messages.map((message) => message.content).join('\n')); return 'Answered from the chart.'; } } as unknown as DqlModelProvider;
    let inBoundary = false;
    // Like a host that marks every request whose values go to a model (an Ask, a question about a chart).
    const hooks = (declared: boolean): DqlHostHooks => ({
      resolvePrincipal: (req) => {
        const person = people[String(req.headers['x-test-person'] ?? '')];
        if (!person) return null;
        return /\/ask$/.test(req.url ?? '') ? { ...person, attributes: { ...(person.attributes ?? {}), forModel: true } } : person;
      },
      rowPolicy: ({ sql }) => ({ sql }),
      modelProvider: () => ({ id: 'anthropic', provider: model }),
      isInBoundary: () => inBoundary,
      ...(declared ? { purposeAttributes: ['forModel'] } : {}),
    });
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const serve = async (declared: boolean) => {
        const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, hostHooks: hooks(declared), captureServer: (created) => { servers.push(created); } });
        return async (person: string, path: string, body: unknown) => {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-person': person }, body: JSON.stringify(body) });
          const text = await response.text();
          return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
        };
      };
      const runAndAsk = async (post: Awaited<ReturnType<typeof serve>>, asker = 'analyst') => {
        const run = await post('analyst', '/api/apps/commerce-pilot/dashboards/overview/run', {});
        expect(run.status, run.text).toBe(200);
        const tile = (run.body.tiles as Array<{ tileId: string; status: string; tileType?: string }>).find((candidate) => candidate.status === 'ok' && candidate.tileType === 'dataset');
        expect(tile).toBeTruthy();
        return post(asker, '/api/apps/commerce-pilot/ask', { question: 'What stands out?', dashboardId: 'overview', tileId: tile!.tileId, runId: run.body.runId });
      };

      const post = await serve(true);
      // Outside the boundary: answered from the chart without the model; no row reaches it.
      inBoundary = false;
      const outside = await runAndAsk(post);
      expect(outside.status, outside.text).toBe(200);
      expect(outside.text).toContain('outside the privacy boundary');
      expect(prompts).toEqual([]);
      // Inside the boundary: the model phrases it from the chart's own context.
      inBoundary = true;
      const inside = await runAndAsk(post);
      expect(inside.status, inside.text).toBe(200);
      expect(inside.body.answer ?? inside.text).toContain('Answered from the chart.');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('governedChartContext');
      // Someone else never asks about another person's chart.
      const stranger = await runAndAsk(post, 'other');
      expect(stranger.text).toContain('no longer current');
      expect(prompts).toHaveLength(1);

      // A host that does not say which attributes are its marks: the marked question is someone else's, as before.
      const undeclared = await serve(false);
      expect((await runAndAsk(undeclared)).text).toContain('no longer current');
    } finally {
      await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('Dataset grain proofs are each person\'s with a host (their row rules decided them)', () => {
  duckDbIt('keeps a page run\'s grain proof in the person\'s own file, never as shared evidence; without a host, as before', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-proofs-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    const servers: Server[] = [];
    const people: Record<string, DqlPrincipal> = {
      ca: { id: 'u-ca', kind: 'person', email: 'ca@example.test', attributes: { region: 'CA' }, appGrants: { 'commerce-pilot': 'execute' }, source: 'host' },
      us: { id: 'u-us', kind: 'person', email: 'us@example.test', attributes: { region: 'US' }, appGrants: { 'commerce-pilot': 'execute' }, source: 'host' },
    };
    const shared = join(projectRoot, '.dql', 'local', 'datasets', 'proofs.json');
    const personal = join(projectRoot, '.dql', 'local', 'private', 'datasets', 'proofs');
    const proofFiles = () => (existsSync(personal) ? readdirSync(personal).sort() : []);
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const serve = async (hostHooks?: DqlHostHooks) => {
        const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, ...(hostHooks ? { hostHooks } : {}), captureServer: (created) => { servers.push(created); } });
        return async (person: string) => {
          const response = await fetch(`http://127.0.0.1:${port}/api/apps/commerce-pilot/dashboards/overview/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-person': person }, body: '{}' });
          return { status: response.status, text: await response.text() };
        };
      };
      // Without a host: one local proofs file, as before.
      const local = await serve();
      expect((await local('')).status).toBe(200);
      expect(existsSync(shared)).toBe(true);
      expect(proofFiles()).toEqual([]);
      // With a host: what was shared is moved aside at start, and each person's run proves into their own file.
      const hosted = await serve({
        resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
        rowPolicy: ({ sql }) => ({ sql }),
      });
      expect(existsSync(shared)).toBe(false);
      expect(existsSync(join(projectRoot, '.dql', 'local', 'private', 'datasets', 'shared-proofs-before-host.json'))).toBe(true);
      expect((await hosted('ca')).status).toBe(200);
      expect(proofFiles()).toHaveLength(1);
      expect((await hosted('us')).status).toBe(200);
      expect(proofFiles()).toHaveLength(2);
      expect(existsSync(shared)).toBe(false);
    } finally {
      await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('each person on their own warehouse sign-in (RFC 0010 HH-4)', () => {
  duckDbIt('runs the same SQL on each person\'s connection and refuses someone who must reconnect', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-credentials-'));
    const warehouse = (name: string) => join(projectRoot, `${name}.duckdb`);
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: warehouse('shared'), moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    const people: Record<string, DqlPrincipal> = {
      ca: { id: 'u-ca', kind: 'person', email: 'ca@insurer.example', source: 'host' },
      us: { id: 'u-us', kind: 'person', email: 'us@insurer.example', source: 'host' },
      lapsed: { id: 'u-lapsed', kind: 'person', email: 'lapsed@insurer.example', source: 'host' },
    };
    // Each person's "sign-in" reaches a warehouse that holds only their rows,
    // as a warehouse applying its own row rules to their token would.
    const signIns: Record<string, string> = { 'u-ca': warehouse('ca'), 'u-us': warehouse('us') };
    const hostHooks: DqlHostHooks = {
      resolvePrincipal: (req) => people[String(req.headers['x-test-person'] ?? '')] ?? null,
      credentials: ({ principal }) => {
        if (!principal) return { connection: {} };
        const filepath = signIns[principal.id];
        return filepath ? { connection: { filepath } } : { refuse: 'Your warehouse sign-in expired. Reconnect to run this query.' };
      },
    };
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
      const setup = new QueryExecutor();
      for (const [name, keep] of [['shared', null], ['ca', 'CA'], ['us', 'US']] as const) {
        execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', warehouse(name)], { stdio: 'pipe' });
        if (keep) await setup.executePositional(`DELETE FROM main.order_lines WHERE region <> '${keep}'`, [], { ...connection, filepath: warehouse(name) });
      }
      await setup.disconnect();
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, hostHooks, captureServer: (created) => { server = created; } });
      const ask = async (person: string) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-test-person': person },
          body: JSON.stringify({ sql: 'SELECT region, COUNT(*) AS n FROM main.order_lines GROUP BY region ORDER BY region' }),
        });
        return response.text();
      };
      const ca = await ask('ca');
      expect(ca).toContain('"CA"');
      expect(ca).not.toContain('"US"');
      const us = await ask('us');
      expect(us).toContain('"US"');
      expect(us).not.toContain('"CA"');
      const lapsed = await ask('lapsed');
      expect(lapsed).toContain('Your warehouse sign-in expired. Reconnect to run this query.');
      expect(lapsed).not.toContain('"CA"');
      expect(lapsed).not.toContain('"US"');
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('a statement the warehouse refuses, with a host (RFC 0010 HH-3)', () => {
  const connection: ConnectionConfig = { driver: 'duckdb', filepath: ':memory:' };
  const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@example.test', attributes: { region: 'West' }, source: 'host' };
  // A region rule (`region = {user.region} OR {user.region} = 'All'`), put in place of the table it guards.
  const regionRule: DqlRowPolicy = ({ principal, sql }) => {
    const region = String(principal?.attributes?.region ?? '').replace(/'/g, "''");
    return { sql: sql.replace(/\bFROM main\.claims\b/gi, `FROM (SELECT * FROM main.claims WHERE (region = '${region}' OR '${region}' = 'All')) AS "claims"`) };
  };
  /** A warehouse that quotes the statement it was sent, as DuckDB's LINE excerpt does. */
  class QuotingExecutor extends RecordingExecutor {
    constructor(private readonly said: (sent: string) => Error) { super(); }
    override async executePositional(sql: string, _values?: unknown[], _config?: ConnectionConfig, _options?: unknown): Promise<QueryResult> { throw this.said(sql); }
    override async getConnector(_config?: ConnectionConfig): Promise<DatabaseConnector> {
      const said = this.said;
      return {
        driverName: 'duckdb',
        async execute(sql: string) { throw said(sql); },
        async *stream(sql: string) { throw said(sql); },
        async openConsistentReadScope() { return { id: 's1', async execute(sql: string) { throw said(sql); }, async close() {} }; },
        async ping() { return true; },
      } as unknown as DatabaseConnector;
    }
  }
  const binder = (sent: string) => Object.assign(new Error(`DuckDB query failed: Binder Error: Referenced column "status" not found in FROM clause!\nCandidate bindings: "claims.claim_status"\nLINE 1: ${sent.slice(20, 110)}...\n                 ^`), { code: 'CONNECTOR_QUERY_FAILED', sqlState: '42703' });
  const quiet = <T>(run: (lines: string[]) => Promise<T>) => async () => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try { return await run(lines); } finally { console.warn = warn; }
  };
  const statement = 'SELECT region, COUNT(*) AS n FROM main.claims WHERE status = \'open\' GROUP BY region';

  it('carries the diagnosis and a reference on, never the rewrite; the warehouse\'s words go to the log under the reference', quiet(async (lines) => {
    const executor = withHostQueryHooks(new QuotingExecutor(binder), { rowPolicy: regionRule, hosted: true });
    const failed = await withRequestContext({ principal: priya, requestId: 'w1' }, () => executor.executePositional(statement, [], connection).then(() => null, (error: unknown) => error)) as WarehouseStatementError;
    expect(failed).toBeInstanceOf(WarehouseStatementError);
    expect(failed.message).toMatch(/^DuckDB query failed: Binder Error: Referenced column "status" not found in FROM clause!\nCandidate bindings: "claims\.claim_status" \(reference [a-z]{8}\)$/);
    expect(failed.message).not.toMatch(/West|'All'|LINE \d/);
    expect(failed.warehouseDiagnosis).not.toMatch(/West|LINE/);
    expect(failed).toMatchObject({ code: 'CONNECTOR_QUERY_FAILED', sqlState: '42703' });
    expect((failed as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`reference ${failed.warehouseReference}`);
    // The log keeps the warehouse's diagnosis, the failure's kind and the statement's own tables; never the excerpt of
    // the statement sent (the host's predicate), nor the person's values from the rewrite.
    expect(lines[0]).toContain('Referenced column "status" not found');
    expect(lines[0]).toMatch(/column_missing; tables: main\.claims\)/);
    expect(lines[0]).not.toContain('LINE 1:');
    expect(lines[0]).not.toMatch(/West|'All'|region =/);
    // A driver that echoes the whole statement, and one that prints the rule's value bare.
    const echo = withHostQueryHooks(new QuotingExecutor((sent) => new Error(`Error running ${sent}\nfilter on region West failed`)), { rowPolicy: regionRule, hosted: true });
    const echoed = await withRequestContext({ principal: priya, requestId: 'w2' }, () => echo.executePositional(statement, [], connection).then(() => null, (error: unknown) => error)) as Error;
    expect(echoed.message).toMatch(/^Error running \[the statement\]\nfilter on region … failed \(reference [a-z]{8}\)$/);
    // The connector, its stream and a consistent read scope take the same path.
    const connector = await withRequestContext({ principal: priya, requestId: 'w3' }, () => executor.getConnector(connection));
    for (const attempt of [
      () => connector.execute(statement),
      async () => { for await (const _ of connector.stream!(statement)) { /* nothing */ } },
      async () => (await (connector as unknown as { openConsistentReadScope(): Promise<{ execute(sql: string): Promise<unknown> }> }).openConsistentReadScope()).execute(statement),
    ]) {
      const error = await withRequestContext({ principal: priya, requestId: 'w4' }, () => attempt().then(() => null, (caught: unknown) => caught)) as Error;
      expect(error).toBeInstanceOf(WarehouseStatementError);
      expect(error.message).not.toMatch(/West|'All'|LINE \d/);
    }
  }));

  it('logs no start of a rewrite value an engine cut short, in its excerpt or in its words', quiet(async (lines) => {
    // DuckDB cuts its LINE excerpt, and with it the second copy of the rule's value ('Wes...').
    const cut = () => new Error("DuckDB query failed: Catalog Error: Table with name claimz does not exist near 'Wes...'\nLINE 1: ...FROM \"claims\" WHERE (region = '…' OR 'Wes...\n                 ^");
    const executor = withHostQueryHooks(new QuotingExecutor(cut), { rowPolicy: regionRule, hosted: true });
    const failed = await withRequestContext({ principal: priya, requestId: 'c1' }, () => executor.executePositional(statement, [], connection).then(() => null, (error: unknown) => error)) as WarehouseStatementError;
    expect(failed).toBeInstanceOf(WarehouseStatementError);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`reference ${failed.warehouseReference}`);
    expect(lines[0]).not.toMatch(/Wes|LINE 1|region =/);
    expect(failed.message).not.toMatch(/Wes/);
  }));

  it('leaves the warehouse\'s other words whole when the rewrite added a number: the number goes as a token only, never every digit like it', quiet(async (lines) => {
    // A rule that adds a bare number (tier <> 0) beside the region value.
    const tiered: DqlRowPolicy = async (query) => ({ sql: `${(await regionRule(query) as { sql: string }).sql} AND tier <> 0` });
    const conversion = () => new Error("DuckDB query failed: Conversion Error: Could not convert string 'M-0003' to INT32 at position 0 for region 'West'");
    const executor = withHostQueryHooks(new QuotingExecutor(conversion), { rowPolicy: tiered, hosted: true });
    const failed = await withRequestContext({ principal: priya, requestId: 'n1' }, () => executor.executePositional(statement, [], connection).then(() => null, (error: unknown) => error)) as WarehouseStatementError;
    expect(failed).toBeInstanceOf(WarehouseStatementError);
    expect(failed.warehouseDiagnosis).toContain("Could not convert string 'M-0003' to INT32");
    // The rewrite's own values are left out, the number as a whole token included.
    expect(failed.warehouseDiagnosis).toMatch(/at position … for region '…'$/);
    expect(failed.message).not.toMatch(/West/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("'M-0003' to INT32");
    expect(lines[0]).not.toMatch(/West/);
    // A mask the rewrite added ('****') is not a value: a masked value quoted by the warehouse stays whole.
    const masking: DqlRowPolicy = async (query) => ({ sql: (await regionRule(query) as { sql: string }).sql.replace(/^SELECT region/, "SELECT CASE WHEN region IS NULL THEN NULL ELSE '****' END AS region") });
    const masked = withHostQueryHooks(new QuotingExecutor(() => new Error("DuckDB query failed: Conversion Error: Could not convert string '**** ****** 0003' to INT32")), { rowPolicy: masking, hosted: true });
    const maskedFailure = await withRequestContext({ principal: priya, requestId: 'n2' }, () => masked.executePositional(statement, [], connection).then(() => null, (error: unknown) => error)) as WarehouseStatementError;
    expect(maskedFailure.warehouseDiagnosis).toContain("Could not convert string '**** ****** 0003' to INT32");
  }));

  it('with the host\'s smallest-group check too: a group too small is the host\'s refusal in its own words (no reference, nothing logged); a warehouse failure stays plain with a reference, on every path', quiet(async (lines) => {
    const check = { column: 'host_group_rows', minimum: 5, refusal: 'Some groups are too small for the model.' };
    // The region rule's rewrite and the group check, as a host answers for a grouped question for the model.
    const groupedRule: DqlRowPolicy = async (query) => ({ ...(await regionRule(query) as { sql: string }), groupRows: check });
    const small = () => ({ columns: [{ name: 'region', type: 'string' }, { name: 'n', type: 'number' }, { name: 'host_group_rows', type: 'number' }], rows: [{ region: 'West', n: 1, host_group_rows: 1 }], rowCount: 1, executionTime: 0 }) as unknown as QueryResult;
    class SmallGroups extends RecordingExecutor {
      override async executePositional(_sql: string, _values?: unknown[], _config?: ConnectionConfig, _options?: unknown): Promise<QueryResult> { return small(); }
      override async getConnector(_config?: ConnectionConfig): Promise<DatabaseConnector> {
        return {
          driverName: 'duckdb',
          async execute() { return small(); },
          async *stream() { yield { columns: small().columns, rows: small().rows, rowCount: 1, byteCount: 1 }; },
          async openConsistentReadScope() { return { id: 's2', async execute() { return small(); }, async close() {} }; },
          async ping() { return true; },
        } as unknown as DatabaseConnector;
      }
    }
    const paths = (executor: QueryExecutor, requestId: string) => withRequestContext({ principal: priya, requestId }, async () => {
      const connector = await executor.getConnector(connection);
      const scope = await (connector as unknown as { openConsistentReadScope(): Promise<{ execute(sql: string): Promise<unknown> }> }).openConsistentReadScope();
      const handed: unknown[] = [];
      const outcomes: unknown[] = [];
      for (const attempt of [
        () => executor.executePositional(statement, [], connection),
        () => connector.execute(statement),
        async () => { for await (const batch of connector.stream!(statement)) handed.push(...batch.rows); },
        () => scope.execute(statement),
      ]) outcomes.push(await attempt().then(() => null, (caught: unknown) => caught));
      return { outcomes, handed };
    });
    const refused = await paths(withHostQueryHooks(new SmallGroups(), { rowPolicy: groupedRule, hosted: true }), 'g1');
    for (const outcome of refused.outcomes) {
      expect(outcome).toBeInstanceOf(RowPolicyRefusedError);
      expect(outcome).not.toBeInstanceOf(WarehouseStatementError);
      expect((outcome as Error).message).toBe('Some groups are too small for the model.');
    }
    expect(refused.handed).toEqual([]);
    expect(lines).toEqual([]);
    const failing = await paths(withHostQueryHooks(new QuotingExecutor(binder), { rowPolicy: groupedRule, hosted: true }), 'g2');
    for (const outcome of failing.outcomes) {
      expect(outcome).toBeInstanceOf(WarehouseStatementError);
      expect((outcome as Error).message).toMatch(/\(reference [bcdfghjkmnpqrstvwxz]{8}\)$/);
      expect((outcome as Error).message).not.toMatch(/West|'All'|LINE \d|host_group_rows/);
    }
    // The warehouse's words are in the log only, one line per failure under its reference, without the rule's values.
    expect(lines).toHaveLength(failing.outcomes.length);
    failing.outcomes.forEach((outcome, index) => expect(lines[index]).toContain(`reference ${(outcome as WarehouseStatementError).warehouseReference}`));
    expect(lines.join('\n')).not.toMatch(/West|'All'/);
  }));

  it('passes on as before: a statement the host did not rewrite (with a reference), a refusal, a cancellation, a deadline, and everything without a host', quiet(async (lines) => {
    const plain = withHostQueryHooks(new QuotingExecutor((sent) => new Error(`Catalog Error: Table with name claimz does not exist!\nLINE 1: ${sent}`)), { rowPolicy: regionRule, hosted: true });
    const unchanged = await withRequestContext({ principal: priya, requestId: 'p1' }, () => plain.executePositional('SELECT * FROM main.claimz', [], connection).then(() => null, (error: unknown) => error)) as WarehouseStatementError;
    expect(unchanged.message).toMatch(/^Catalog Error: Table with name claimz does not exist!\nLINE 1: SELECT \* FROM main\.claimz \(reference [a-z]{8}\)$/);
    const refusing = withHostQueryHooks(new QuotingExecutor(binder), { rowPolicy: () => ({ refuse: 'Claims data is restricted.' }), hosted: true });
    await expect(withRequestContext({ principal: priya, requestId: 'p2' }, () => refusing.executePositional(statement, [], connection))).rejects.toBeInstanceOf(RowPolicyRefusedError);
    for (const stop of [Object.assign(new Error('aborted'), { name: 'AbortError' }), new Error('DuckDB query was cancelled.'), new Error('DuckDB query exceeded the 500ms deadline.')]) {
      const stopping = withHostQueryHooks(new QuotingExecutor(() => stop), { rowPolicy: regionRule, hosted: true });
      await expect(withRequestContext({ principal: priya, requestId: 'p3' }, () => stopping.executePositional(statement, [], connection))).rejects.toBe(stop);
    }
    const raw = binder('x');
    await expect(withHostQueryHooks(new QuotingExecutor(() => raw), { rowPolicy: regionRule }).executePositional(statement, [], connection)).rejects.toBe(raw);
    expect(withHostQueryHooks(new RecordingExecutor(), {})).not.toBe(withHostQueryHooks(new RecordingExecutor(), { hosted: true }));
    expect(lines).toHaveLength(1);
  }));

  duckDbIt('on a real warehouse with a region rule: every kind of failure reads plainly in Ask and never names the rule or the person\'s region', quiet(async (lines) => {
    const dir = mkdtempSync(join(tmpdir(), 'dql-warehouse-failures-'));
    const real: ConnectionConfig = { driver: 'duckdb', filepath: join(dir, 'claims.duckdb'), moduleSearchPaths: [connectorRoot!] };
    const inner = new QueryExecutor();
    try {
      await inner.executePositional("CREATE TABLE main.claims AS SELECT * FROM (VALUES ('C-1', 'West', 'open'), ('C-2', 'Northeast', 'open')) AS t(claim_id, region, claim_status)", [], real);
      const executor = withHostQueryHooks(inner, { rowPolicy: regionRule, hosted: true });
      const failing: Array<[string, RegExp]> = [
        // The column was renamed under the statement (a certified block after a dbt refactor).
        [statement, /^A column this answer reads \(status\) is not in the claims table on the warehouse\. The table may have changed since the answer was defined\. Ask your administrator about reference [a-z]{8}\.$/],
        // A function this warehouse does not have.
        ["SELECT region, ISNULL(claim_status, '') AS s FROM main.claims", /^The statement calls a function \(ISNULL\) that this warehouse does not have\. Rephrase the question\. Ask your administrator about reference [a-z]{8}\.$/i],
        // An alias the statement never declared.
        ['SELECT x.region FROM main.claims c', /^The warehouse could not run this statement\. Ask your administrator about reference [a-z]{8}\.$/],
        // A value of the wrong type.
        ["SELECT region FROM main.claims WHERE claim_id + 1 > 0", /^The warehouse could not run this statement\. Ask your administrator about reference [a-z]{8}\.$/],
        // A table that is not there.
        ['SELECT * FROM main.claimz', /^The warehouse does not have main\.claimz, although the catalog lists it\. Ask your administrator about reference [a-z]{8}\.$/],
      ];
      for (const [sql, said] of failing) {
        const error = await withRequestContext({ principal: priya, requestId: `r-${sql.length}` }, () => executor.executePositional(sql, [], real).then(() => null, (caught: unknown) => caught));
        expect(error, sql).toBeInstanceOf(WarehouseStatementError);
        // What a notebook cell would show: never the rule; the excerpt only of a statement the rule left as written.
        expect((error as Error).message, sql).not.toMatch(/West|'All'/);
        if (sql.includes('main.claims ') || sql.endsWith('main.claims')) expect((error as Error).message, sql).not.toMatch(/LINE \d/);
        const failed = statementFailure(error, { sql });
        const text = composeFailedText('execute', failed.message, failed.warehouse);
        expect(text, sql).toMatch(said);
        expect(`${text} ${failed.message}`, sql).not.toMatch(/West|'All'|Binder Error|Catalog Error|Conversion Error|DuckDB query failed|LINE \d|\^|dbt build/);
      }
      expect(lines).toHaveLength(failing.length);
      expect(lines.every((line) => /reference [a-z]{8}/.test(line))).toBe(true);
      // The rule's values never reach the log, even where DuckDB's excerpt cuts a literal in two.
      expect(lines.join('\n')).not.toMatch(/West|'All'/);
    } finally {
      await inner.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  }), 60_000);
});
