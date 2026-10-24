import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@zlens/connectors';
import {
  admitDashboardRun,
  dashboardRunRequestKey,
  normalizeDashboardRunVariables,
  parseDashboardRunSequence,
  sharedDashboardRunResponse,
} from './dashboard-run-admission.js';
import { createAppPackage } from './apps-api.js';
import { startLocalServer } from './local-runtime.js';

describe('which run a viewer request gets (B1)', () => {
  it('an identical request joins the run in flight', () => {
    expect(admitDashboardRun({ prior: { requestKey: 'k1', sequence: 1 }, lastSequence: 1, requestKey: 'k1', sequence: 2 }))
      .toEqual({ kind: 'reuse' });
  });

  it('a different, newer request supersedes the run in flight', () => {
    expect(admitDashboardRun({ prior: { requestKey: 'k1', sequence: 1 }, lastSequence: 1, requestKey: 'k2', sequence: 2 }))
      .toEqual({ kind: 'start', supersedesPrior: true });
  });

  it('a request older than one already seen never cancels the newer run', () => {
    expect(admitDashboardRun({ prior: { requestKey: 'k2', sequence: 2 }, lastSequence: 2, requestKey: 'k1', sequence: 1 }))
      .toEqual({ kind: 'refuse_older' });
    // Even when the newer run has already finished.
    expect(admitDashboardRun({ prior: undefined, lastSequence: 2, requestKey: 'k1', sequence: 1 }))
      .toEqual({ kind: 'refuse_older' });
  });

  it('a request that may not be shared, or has no number, keeps the old rule', () => {
    expect(admitDashboardRun({ prior: { requestKey: 'k1' }, requestKey: undefined }))
      .toEqual({ kind: 'start', supersedesPrior: true });
    expect(admitDashboardRun({ prior: { sequence: 3 }, lastSequence: 3, requestKey: 'k1' }))
      .toEqual({ kind: 'start', supersedesPrior: true });
    expect(admitDashboardRun({})).toEqual({ kind: 'start', supersedesPrior: false });
  });

  it('reads a request number only when it is a non-negative whole number', () => {
    expect(parseDashboardRunSequence(4)).toBe(4);
    expect(parseDashboardRunSequence(0)).toBe(0);
    for (const value of [-1, 1.5, '4', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseDashboardRunSequence(value)).toBeUndefined();
    }
  });
});

describe('the request key', () => {
  const base = {
    surface: 'apps',
    appId: 'sales',
    dashboardId: 'overview',
    dashboard: { id: 'overview', layout: { items: [{ i: 'a' }] } },
    snapshotId: 'snap-1',
    person: { principal: null },
    variables: {} as Record<string, unknown>,
  };

  it('treats an unset filter value as no value', () => {
    expect(normalizeDashboardRunVariables({ b: 'x', a: '', c: [], d: null, e: undefined })).toEqual({ b: 'x' });
    expect(dashboardRunRequestKey({ ...base, variables: { customer_name: '' } })).toBe(dashboardRunRequestKey(base));
    // Whitespace is kept: not every filter path trims it.
    expect(dashboardRunRequestKey({ ...base, variables: { customer_name: ' ' } })).not.toBe(dashboardRunRequestKey(base));
  });

  it('ignores object key order but not content', () => {
    expect(dashboardRunRequestKey({ ...base, dashboard: { layout: { items: [{ i: 'a' }] }, id: 'overview' } })).toBe(dashboardRunRequestKey(base));
    expect(dashboardRunRequestKey({ ...base, dashboard: { id: 'overview', layout: { items: [{ i: 'b' }] } } })).not.toBe(dashboardRunRequestKey(base));
  });

  it('changes with anything that changes the result', () => {
    const key = dashboardRunRequestKey(base);
    expect(dashboardRunRequestKey({ ...base, variables: { customer_name: 'Alice' } })).not.toBe(key);
    expect(dashboardRunRequestKey({ ...base, snapshotId: 'snap-2' })).not.toBe(key);
    expect(dashboardRunRequestKey({ ...base, person: { principal: 'someone' } })).not.toBe(key);
    expect(dashboardRunRequestKey({ ...base, viewerFilters: [{ column: 'x', values: ['1'], tileIds: ['a'] }] })).not.toBe(key);
    expect(dashboardRunRequestKey({ ...base, crossFilters: [{ tileId: 'a' }] })).not.toBe(key);
    expect(dashboardRunRequestKey({ ...base, affectedTileIds: ['a'] })).not.toBe(key);
    expect(dashboardRunRequestKey({ ...base, fullRun: true })).not.toBe(key);
  });

  it('a shared response settles once', async () => {
    const shared = sharedDashboardRunResponse();
    shared.settle({ status: 200, body: 'first' });
    shared.settle(null);
    await expect(shared.promise).resolves.toEqual({ status: 200, body: 'first' });
  });
});

describe('App page runs for one viewer, on a real local server', () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()!;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  function project(): string {
    const root = mkdtempSync(join(tmpdir(), 'zlens-run-admission-'));
    tempDirs.push(root);
    writeFileSync(join(root, 'dql.config.json'), '{}\n');
    const blockDir = join(root, 'blocks', 'commerce');
    mkdirSync(blockDir, { recursive: true });
    writeFileSync(join(blockDir, 'product-revenue.dql'), `block "Product revenue" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  owner = "owner@local"
  query = """
SELECT product_name, SUM(price) AS revenue FROM sales GROUP BY 1
  """
  visualization { chart = "bar" }
}\n`);
    const created = createAppPackage(root, {
      name: 'Run Admission App',
      domain: 'commerce',
      owners: ['owner@local'],
      tags: [],
      selectedBlockIds: ['Product revenue'],
    });
    if (!created.ok) throw new Error(created.error);
    return root;
  }

  /** A server whose warehouse waits until the test lets it answer. */
  async function gatedServer(root: string) {
    let release!: () => void;
    let gate = new Promise<void>((resolve) => { release = resolve; });
    const statements: string[] = [];
    const executor = {
      executeQuery: vi.fn(async (statement: string) => {
        statements.push(statement);
        await gate;
        return { columns: ['product_name', 'revenue'], rows: [{ product_name: 'tangaroo', revenue: 10 }], rowCount: 1, sql: statement };
      }),
    } as unknown as QueryExecutor;
    const port = await startLocalServer({
      rootDir: root,
      projectRoot: root,
      executor,
      connection: { driver: 'file' },
      preferredPort: 0,
      captureServer: (created) => { servers.push(created); },
    });
    const runPage = async (body: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/apps/run-admission-app/dashboards/overview/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, payload: await response.json() as any };
    };
    return {
      runPage,
      statements,
      open: () => release(),
      close: () => {
        gate = new Promise<void>((resolve) => { release = resolve; });
      },
    };
  }

  const waitFor = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 200 && !check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(check()).toBe(true);
  };

  it('the same request twice (before and after the filter defaults) runs once and both get its result', async () => {
    const server = await gatedServer(project());
    const first = server.runPage({ variables: {}, runScope: 'viewer_sameRequest01', runSequence: 1 });
    await waitFor(() => server.statements.length > 0);
    const startedStatements = server.statements.length;
    const second = server.runPage({ variables: { product_name: '' }, runScope: 'viewer_sameRequest01', runSequence: 2 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.open();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.payload.stale).toBeUndefined();
    expect(b.payload.stale).toBeUndefined();
    expect(b.payload.runId).toBe(a.payload.runId);
    expect(a.payload.tiles.every((tile: { status: string }) => tile.status === 'ok')).toBe(true);
    // The second request started no warehouse work of its own.
    expect(server.statements.length).toBe(startedStatements);
  });

  it('an older request that arrives late never cancels the newer one', async () => {
    const server = await gatedServer(project());
    const newer = server.runPage({ variables: {}, runScope: 'viewer_lateArrival01', runSequence: 2 });
    await waitFor(() => server.statements.length > 0);
    const older = await server.runPage({ variables: { product_name: 'tangaroo' }, runScope: 'viewer_lateArrival01', runSequence: 1 });
    expect(older.status).toBe(200);
    expect(older.payload).toMatchObject({ stale: true, staleCause: 'superseded', tiles: [] });
    server.open();
    const result = await newer;
    expect(result.status).toBe(200);
    expect(result.payload.stale).toBeUndefined();
    expect(result.payload.tiles.every((tile: { status: string }) => tile.status === 'ok')).toBe(true);
  });

  it('a genuinely different, newer request still supersedes the run in flight', async () => {
    const server = await gatedServer(project());
    const older = server.runPage({ variables: {}, runScope: 'viewer_newerRequest1', runSequence: 1 });
    await waitFor(() => server.statements.length > 0);
    const newer = server.runPage({ variables: { product_name: 'tangaroo' }, runScope: 'viewer_newerRequest1', runSequence: 2 });
    await waitFor(() => server.statements.length > 1);
    server.open();
    const [a, b] = await Promise.all([older, newer]);
    expect(a.payload).toMatchObject({ stale: true, staleCause: 'superseded' });
    expect(a.payload.tiles.every((tile: { status: string }) => tile.status === 'stale')).toBe(true);
    expect(b.payload.stale).toBeUndefined();
    expect(b.payload.tiles.every((tile: { status: string }) => tile.status === 'ok')).toBe(true);
  });

  it('two viewers never share or cancel each other\'s runs', async () => {
    const server = await gatedServer(project());
    const viewerA = server.runPage({ variables: {}, runScope: 'viewer_firstViewer1', runSequence: 1 });
    await waitFor(() => server.statements.length > 0);
    const viewerB = server.runPage({ variables: {}, runScope: 'viewer_secondViewer', runSequence: 1 });
    await waitFor(() => server.statements.length > 1);
    server.open();
    const [a, b] = await Promise.all([viewerA, viewerB]);
    expect(a.payload.stale).toBeUndefined();
    expect(b.payload.stale).toBeUndefined();
    expect(b.payload.runId).not.toBe(a.payload.runId);
  });
});
