import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { DuckDBConnector, QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import type { AgentProvider } from '@zlens/agent';
import { LocalAppStorage, defaultLocalAppsDbPath } from '@zlens/project';
import { startLocalServer } from '../local-runtime.js';
import { resolveRelativeDateRange } from './dashboard-dataset-filters.js';
import { readEnv } from '@zlens/core';

const configuredDuckDbConnectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = configuredDuckDbConnectorRoot ? it : it.skip;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');

type ApiResponse = { status: number; body: any; text: string };

/**
 * This is the M1 product path, intentionally not a mocked SQL test:
 *
 * choose Dataset -> validate the source key -> choose measures/grouping ->
 * preview field tiles -> record a settled receipt -> publish -> rerun the
 * published App.  A caller must explicitly configure an external DuckDB
 * connector root because the repository deliberately does not ship native
 * bindings in its workspace dependencies.
 */
describe('Dataset App Builder real DuckDB pilot', () => {
  duckDbIt('APP-060 executes explicit governed period comparisons through the App preview and retains exact graph evidence', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-comparison-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const created = await request(base, '/api/app-builds', 'POST', {
        name: 'Commerce comparison App',
        goal: 'Compare governed revenue across explicit closed months.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const candidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      expect(candidates.status, candidates.text).toBe(200);
      const source = candidates.body.items.find((item: any) => item.kind === 'block'
        && item.title === 'Order lines Dataset');
      expect(source).toMatchObject({ lifecycle: 'certified', trust: 'certified' });

      const composed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [
          blockSelection(source.sourceId, 'Revenue Mar versus Feb', 'table', {
            dimensions: [],
            measures: [{ measure: 'revenue' }],
            comparison: monthComparison({
              basePeriodId: 'mar_2026',
              comparisonPeriodId: 'feb_2026',
              periods: [
                absoluteMonth('mar_2026', '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
                absoluteMonth('feb_2026', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
              ],
            }),
          }),
          blockSelection(source.sourceId, 'US revenue Mar versus zero Feb', 'table', {
            dimensions: [],
            measures: [{ measure: 'revenue' }],
            filters: [{ field: 'region', op: 'eq', values: ['US'] }],
            comparison: monthComparison({
              basePeriodId: 'mar_2026',
              comparisonPeriodId: 'feb_2026',
              periods: [
                absoluteMonth('mar_2026', '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
                absoluteMonth('feb_2026', '2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
              ],
            }),
          }),
          blockSelection(source.sourceId, 'US revenue Jan versus missing Dec', 'table', {
            dimensions: [],
            measures: [{ measure: 'revenue' }],
            filters: [{ field: 'region', op: 'eq', values: ['US'] }],
            comparison: monthComparison({
              basePeriodId: 'jan_2026',
              comparisonPeriodId: 'dec_2025',
              periods: [
                absoluteMonth('jan_2026', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
                absoluteMonth('dec_2025', '2025-12-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
              ],
            }),
          }),
        ],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const page = draft.pages.find((candidate: any) => candidate.id === 'overview');
      expect(page?.layout.items).toHaveLength(3);

      const run = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', { fullRun: true });
      expect(run.status, run.text).toBe(200);
      expect(run.body.tiles.map((tile: any) => ({ title: tile.title, status: tile.status, error: tile.error }))).toEqual([
        { title: 'Revenue Mar versus Feb', status: 'ok', error: undefined },
        { title: 'US revenue Mar versus zero Feb', status: 'ok', error: undefined },
        { title: 'US revenue Jan versus missing Dec', status: 'ok', error: undefined },
      ]);

      const march = findTile(run.body.tiles, 'Revenue Mar versus Feb');
      expect(march.result.rows).toHaveLength(1);
      expect(Number(march.result.rows[0].revenue__mar_2026)).toBe(40);
      expect(Number(march.result.rows[0].revenue__feb_2026)).toBe(30);
      expect(Number(march.result.rows[0].revenue__delta__feb_2026)).toBe(10);
      expect(Number(march.result.rows[0].revenue__percent_delta__feb_2026)).toBeCloseTo(100 / 3, 10);
      expect(march.result.columnsMeta).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'revenue__mar_2026', kind: 'currency', unit: 'USD' }),
        expect.objectContaining({ name: 'revenue__percent_delta__feb_2026', kind: 'percent' }),
      ]));
      expect(march.dataset).toMatchObject({
        comparison: {
          version: 1,
          graph: { fingerprint: expect.any(String) },
          periods: [
            expect.objectContaining({ id: 'mar_2026', compiledSqlFingerprint: expect.any(String) }),
            expect.objectContaining({ id: 'feb_2026', compiledSqlFingerprint: expect.any(String) }),
          ],
        },
        executionProvenance: {
          kind: 'block_runtime',
          executedSqlFingerprint: expect.any(String),
        },
      });
      expect(march.artifact.sql).toContain('-- Period mar_2026');

      const observedZero = findTile(run.body.tiles, 'US revenue Mar versus zero Feb');
      expect(Number(observedZero.result.rows[0].revenue__mar_2026)).toBe(10);
      expect(Number(observedZero.result.rows[0].revenue__feb_2026)).toBe(0);
      expect(Number(observedZero.result.rows[0].revenue__delta__feb_2026)).toBe(10);
      expect(observedZero.result.rows[0].revenue__percent_delta__feb_2026).toBeNull();

      const missing = findTile(run.body.tiles, 'US revenue Jan versus missing Dec');
      expect(Number(missing.result.rows[0].revenue__jan_2026)).toBe(60);
      expect(missing.result.rows[0].revenue__dec_2025).toBeNull();
      expect(missing.result.rows[0].revenue__delta__dec_2025).toBeNull();
      expect(missing.result.rows[0].revenue__percent_delta__dec_2025).toBeNull();

      const attached = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_preview_receipt',
          receipt: {
            id: run.body.runId,
            pageId: page.id,
            revision: draft.revision,
            snapshotId: run.body.snapshotId,
            filterFingerprint: run.body.filterFingerprint,
            resultFingerprint: run.body.resultFingerprint,
            createdAt: new Date().toISOString(),
          },
        }],
      });
      expect(attached.status, attached.text).toBe(200);
      expect(attached.body.draft.previewReceipts).toEqual([
        expect.objectContaining({ id: run.body.runId, pageId: page.id }),
      ]);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 90_000);

  duckDbIt('APP-060 preserves a DATE Dataset calendar month in its declared IANA time zone', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-date-comparison-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const sourcePath = join(projectRoot, 'domains', 'commerce', 'blocks', 'order-lines-dataset.dql');
      const dateSource = readFileSync(sourcePath, 'utf8')
        .replace('order_date { role = "time", type = "timestamp"', 'order_date { role = "time", type = "date"')
        .replace('  order_date,\n  net_amount,', '  CAST(order_date AS DATE) AS order_date,\n  net_amount,');
      writeFileSync(sourcePath, dateSource);
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });
      await executor.executePositional(
        "INSERT INTO order_lines VALUES ('OL-AKL-001', 'O-AKL-001', 'C-AKL', 'NZ', '2026-02-28', 1, 0, 1), ('OL-AKL-002', 'O-AKL-002', 'C-AKL', 'NZ', '2026-03-01', 10, 0, 10), ('OL-AKL-003', 'O-AKL-003', 'C-AKL', 'NZ', '2026-03-31', 100, 0, 100), ('OL-AKL-004', 'O-AKL-004', 'C-AKL', 'NZ', '2026-04-01', 1000, 0, 1000)",
        [],
        connection,
      );
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const created = await request(base, '/api/app-builds', 'POST', {
        name: 'Auckland calendar comparison App',
        goal: 'Compare a governed DATE Dataset across Auckland calendar months.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(created.status, created.text).toBe(201);
      const draft = created.body.draft;
      const candidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      expect(candidates.status, candidates.text).toBe(200);
      const source = candidates.body.items.find((item: any) => item.kind === 'block' && item.title === 'Order lines Dataset');
      expect(source?.capabilities?.dataset?.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'order_date', type: 'date' }),
      ]));
      const composed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [blockSelection(source.sourceId, 'Auckland March revenue', 'table', {
          dimensions: [],
          measures: [{ measure: 'revenue' }],
          filters: [{ field: 'region', op: 'eq', values: ['NZ'] }],
          comparison: monthComparison({
            basePeriodId: 'march',
            comparisonPeriodId: 'february',
            timezone: 'Pacific/Auckland',
            periods: [
              absoluteMonth('march', '2026-02-28T11:00:00.000Z', '2026-03-31T11:00:00.000Z'),
              absoluteMonth('february', '2026-01-31T11:00:00.000Z', '2026-02-28T11:00:00.000Z'),
            ],
          }),
        })],
      });
      expect(composed.status, composed.text).toBe(200);
      const run = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', { fullRun: true });
      expect(run.status, run.text).toBe(200);
      const tile = findTile(run.body.tiles, 'Auckland March revenue');
      expect(tile.status, JSON.stringify(tile)).toBe('ok');
      // The selected March is a civil Auckland month. Casting its UTC
      // boundary to DATE would have yielded 11 (Feb 28 + Mar 1); the governed
      // DATE boundary must include Mar 1 and Mar 31 and exclude Apr 1.
      expect(Number(tile.result.rows[0].revenue__march)).toBe(110);
      expect(Number(tile.result.rows[0].revenue__february)).toBe(1);
      expect(Number(tile.result.rows[0].revenue__delta__february)).toBe(109);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 90_000);

  duckDbIt('APP-061 drills and returns through an explicit Dataset hierarchy without changing the parent query scope', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-hierarchy-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const created = await request(base, '/api/app-builds', 'POST', {
        name: 'Commerce hierarchy App',
        goal: 'Inspect customer revenue and declared order detail.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const candidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      const source = candidates.body.items.find((item: any) => item.kind === 'block' && item.title === 'Order lines Dataset');
      expect(source?.capabilities?.dataset?.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'customer_id', hierarchy: { id: 'commerce_customer_orders', level: 0 } }),
        expect.objectContaining({ name: 'order_id', hierarchy: { id: 'commerce_customer_orders', level: 1 } }),
      ]));
      const parentQuery = {
        dimensions: [{ field: 'customer_id' }],
        measures: [{ measure: 'revenue' }],
        orderBy: [{ alias: 'customer_id', direction: 'asc' as const }],
        respectsGlobalFilters: true,
      };
      const composed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [blockSelection(source.sourceId, 'Revenue by customer', 'table', parentQuery)],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const page = draft.pages.find((candidate: any) => candidate.id === 'overview');
      const tile = page.layout.items.find((candidate: any) => candidate.title === 'Revenue by customer');
      const parentRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', { fullRun: true });
      expect(parentRun.status, parentRun.text).toBe(200);
      expect(findTile(parentRun.body.tiles, 'Revenue by customer').result.rows).toEqual([
        { customer_id: 'C-001', revenue: 70 },
        { customer_id: 'C-002', revenue: 30 },
        { customer_id: 'C-003', revenue: 30 },
      ]);

      // A viewer drill carries only an exact declared hierarchy transition and
      // settled mark value. It never patches the saved TileQuery; the runtime
      // reloads the current authored query and source contract before replay.
      const drilledRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
        tileId: tile.i,
        runScope: 'hierarchy-viewer-exploration',
        datasetDrills: [{
          tileId: tile.i,
          steps: [{ hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', values: ['C-001'] }],
        }],
      });
      expect(drilledRun.status, drilledRun.text).toBe(200);
      expect(drilledRun.body).toMatchObject({ partial: true, facts: [] });
      const drilledTile = findTile(drilledRun.body.tiles, 'Revenue by customer');
      expect(drilledTile.result.rows).toEqual([
        { order_id: 'O-100', revenue: 60 },
        { order_id: 'O-101', revenue: null },
        { order_id: 'O-105', revenue: 10 },
      ]);
      expect(drilledTile.dataset).toMatchObject({
        authoredQueryFingerprint: expect.any(String),
        interactionQueryFingerprint: expect.any(String),
        hierarchy: {
          activeSteps: [{ hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', values: ['C-001'] }],
          candidates: [],
        },
      });

      // Interaction results cannot become whole-page receipt evidence. The
      // saved draft still owns the parent grouping and revision.
      const afterDrill = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'GET');
      expect(afterDrill.status, afterDrill.text).toBe(200);
      expect(afterDrill.body.draft.revision).toBe(draft.revision);
      expect(afterDrill.body.draft.previewReceipts ?? []).toEqual([]);
      const savedParentQuery = afterDrill.body.draft.pages.find((candidate: any) => candidate.id === page.id)?.layout.items
        .find((candidate: any) => candidate.i === tile.i)?.query;
      expect(savedParentQuery).toMatchObject({
        dimensions: parentQuery.dimensions,
        measures: parentQuery.measures,
        orderBy: parentQuery.orderBy,
      });
      expect(savedParentQuery.filters).toBeUndefined();
      const rejectedReceipt = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_preview_receipt',
          receipt: {
            id: drilledRun.body.runId,
            pageId: page.id,
            revision: draft.revision,
            snapshotId: drilledRun.body.snapshotId,
            filterFingerprint: drilledRun.body.filterFingerprint,
            resultFingerprint: drilledRun.body.resultFingerprint,
            createdAt: new Date().toISOString(),
          },
        }],
      });
      expect(rejectedReceipt.status, rejectedReceipt.text).toBe(400);
      expect(rejectedReceipt.body.error).toContain('unavailable');

      // Back is a new bounded run of the unchanged authored query, not an
      // inverse mutation inferred from SQL.
      const backRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
        tileId: tile.i,
        runScope: 'hierarchy-viewer-back',
      });
      expect(backRun.status, backRun.text).toBe(200);
      expect(backRun.body).toMatchObject({ partial: true, facts: [] });
      expect(findTile(backRun.body.tiles, 'Revenue by customer').result.rows).toEqual([
        { customer_id: 'C-001', revenue: 70 },
        { customer_id: 'C-002', revenue: 30 },
        { customer_id: 'C-003', revenue: 30 },
      ]);
      expect(findTile(backRun.body.tiles, 'Revenue by customer').dataset.hierarchy).toMatchObject({ activeSteps: [] });

      // A stale browser step is not a fallback to an older query. Change the
      // authored parent grouping after the interaction has been observed, then
      // send its old customer step. The server must reload the current base
      // query and return an actionable error rather than executing a guessed
      // hierarchy against the earlier grouping.
      const currentQueryPatch = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'update_tile',
          pageId: page.id,
          tileId: tile.i,
          patch: {
            query: {
              dimensions: [{ field: 'region' }],
              measures: [{ measure: 'revenue' }],
              orderBy: [{ alias: 'region', direction: 'asc' }],
              respectsGlobalFilters: true,
            },
          },
        }],
      });
      expect(currentQueryPatch.status, currentQueryPatch.text).toBe(200);
      draft = currentQueryPatch.body.draft;
      const staleDrill = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
        tileId: tile.i,
        runScope: 'hierarchy-stale-contract',
        datasetDrills: [{
          tileId: tile.i,
          steps: [{ hierarchyId: 'commerce_customer_orders', fromField: 'customer_id', values: ['C-001'] }],
        }],
      });
      expect(staleDrill.status, staleDrill.text).toBe(200);
      expect(findTile(staleDrill.body.tiles, 'Revenue by customer')).toMatchObject({
        status: 'error',
        error: expect.stringContaining('Dataset hierarchy drill is unavailable'),
      });
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 90_000);

  duckDbIt('APP-062 executes a native semantic total filter after aggregation and retains its governed evidence', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-semantic-having-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const created = await request(base, '/api/app-builds', 'POST', {
        name: 'Semantic totals filter App',
        goal: 'Keep only customer totals above the governed revenue threshold.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const candidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      expect(candidates.status, candidates.text).toBe(200);
      const source = candidates.body.items.find((item: any) => item.kind === 'semantic'
        && item.capabilities?.dataset?.kind === 'semantic');
      expect(source?.capabilities?.dataset?.operations).toContain('having');
      const composed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [blockSelection(source.sourceId, 'Customers with revenue above 50', 'table', {
          dimensions: [{ field: 'customer_id' }],
          measures: [{ measure: 'semantic_revenue' }],
          having: [{ field: 'semantic_revenue', op: 'gt', values: [50] }],
          orderBy: [{ alias: 'customer_id', direction: 'asc' }],
        })],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const run = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', { fullRun: true });
      expect(run.status, run.text).toBe(200);
      const tile = findTile(run.body.tiles, 'Customers with revenue above 50');
      // No raw order-line amount exceeds 50 in the fixture. C-001 is retained
      // only because its post-aggregation semantic total is 70.
      expect(tile.status, JSON.stringify(tile)).toBe('ok');
      expect(tile.result.rows).toEqual([{ customer_id: 'C-001', semantic_revenue: 70 }]);
      expect(tile.dataset).toMatchObject({
        semanticReceipt: { adapterId: 'native', outcome: 'succeeded' },
        semanticRequest: {
          having: [expect.objectContaining({ semanticReference: 'order_lines.semantic_revenue', op: 'gt', values: [50] })],
        },
      });
      expect(tile.artifact.sql).toContain('dql_semantic_aggregate');
      expect(tile.artifact.dql).toContain('"placement": "having"');
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 90_000);

  duckDbIt('APP-057 recomputes current aggregate components, attaches local-preview evidence, and isolates an unsafe distinct rollup', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-aggregate-guard-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    let restoreScopeSpy: (() => void) | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      // Count the redacted existential membership statements rather than
      // ordinary tile SQL. Two tiles that require the same raw distinct
      // component must share one probe for this binding/run.
      let membershipProbeCount = 0;
      let completedMembershipProbeCount = 0;
      const openedAggregateScopeIds: string[] = [];
      let waitForOpenedScope: { minimumCount: number; deferred: ReturnType<typeof deferred<string>> } | undefined;
      let delayedMembershipProbe: {
        scopeId?: string;
        started: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      } | undefined;
      let mutateAfterGrainProbe: (() => Promise<void>) | undefined;
      let mutationScopeId: string | undefined;
      const postMutationScopeSql: string[] = [];
      let aggregateScopeConnector: DuckDBConnector | undefined;
      const originalOpenScope = DuckDBConnector.prototype.openConsistentReadScope;
      const scopeSpy = vi.spyOn(DuckDBConnector.prototype, 'openConsistentReadScope').mockImplementation(async function (this: DuckDBConnector) {
        aggregateScopeConnector = this;
        const scope = await originalOpenScope.call(this);
        openedAggregateScopeIds.push(scope.id);
        if (waitForOpenedScope && openedAggregateScopeIds.length >= waitForOpenedScope.minimumCount) {
          waitForOpenedScope.deferred.resolve(scope.id);
          waitForOpenedScope = undefined;
        }
        return {
          ...scope,
          execute: async (sql, params, options) => {
            const isMembershipProbe = sql.includes('__dql_overlap');
            if (isMembershipProbe) {
              membershipProbeCount += 1;
              if (delayedMembershipProbe && !delayedMembershipProbe.scopeId) {
                delayedMembershipProbe.scopeId = scope.id;
                delayedMembershipProbe.started.resolve();
                await delayedMembershipProbe.release.promise;
              }
            }
            const result = await scope.execute(sql, params, options);
            if (isMembershipProbe) completedMembershipProbeCount += 1;
            if (mutationScopeId === scope.id && !sql.includes('__dql_row_count')) postMutationScopeSql.push(sql);
            if (sql.includes('__dql_row_count') && mutateAfterGrainProbe) {
              const mutate = mutateAfterGrainProbe;
              mutateAfterGrainProbe = undefined;
              mutationScopeId = scope.id;
              await mutate();
            }
            return result;
          },
        };
      });
      restoreScopeSpy = () => scopeSpy.mockRestore();
      const created = await request(base, '/api/app-builds', 'POST', {
        name: 'Aggregate guard App',
        goal: 'Prove aggregate Dataset safety before a rollup runs.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const candidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      expect(candidates.status, candidates.text).toBe(200);
      const aggregateSource = candidates.body.items.find((item: any) => item.kind === 'block'
        && item.title === 'Customer daily Dataset'
        && item.capabilities?.dataset?.grain?.aggregate === true);
      expect(aggregateSource).toMatchObject({ lifecycle: 'certified', trust: 'certified' });

      // The complete-source key probe remains separate from the new component
      // proof. It proves the customer-day output grain but not whether an
      // order can occur in more than one native bucket.
      const grainValidation = await request(base, '/api/datasets/validate-grain', 'POST', {
        sourceId: aggregateSource.sourceId,
        sourceRevision: aggregateSource.sourceRevision,
      });
      expect(grainValidation.status, grainValidation.text).toBe(200);
      expect(grainValidation.body).toMatchObject({ ok: true, eligible: true, evidence: { status: 'passed' } });

      // The complete aggregate recomputation needs a source-expression proof
      // for daily revenue/margin and one membership proof for daily orders.
      // It runs through the normal App preview, not a compiler-only helper.
      const composed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [
          blockSelection(aggregateSource.sourceId, 'Aggregate totals', 'table', {
            dimensions: [],
            measures: [
              { measure: 'revenue' },
              { measure: 'margin' },
              { measure: 'order_count' },
              { measure: 'margin_rate' },
              { measure: 'average_order_value' },
            ],
          }),
          // These two selections are present in the clean receipt as well as
          // the later overlap run. The mutation below therefore proves that a
          // mixed current response invalidates an existing page receipt rather
          // than simply relying on a content edit to clear it.
          blockSelection(aggregateSource.sourceId, 'Safe aggregate sums and rate', 'table', {
            dimensions: [],
            measures: [{ measure: 'revenue' }, { measure: 'margin' }, { measure: 'margin_rate' }],
          }),
          blockSelection(aggregateSource.sourceId, 'Unsafe order components', 'table', {
            dimensions: [],
            measures: [{ measure: 'order_count' }, { measure: 'average_order_value' }],
          }),
        ],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const page = draft.pages.find((candidate: any) => candidate.id === 'overview');
      expect(page).toBeTruthy();
      const positiveRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', { fullRun: true });
      expect(positiveRun.status, positiveRun.text).toBe(200);
      const aggregateTotals = findTile(positiveRun.body.tiles, 'Aggregate totals');
      expect(aggregateTotals).toMatchObject({ status: 'ok' });
      expect(aggregateTotals.result.rows).toHaveLength(1);
      const totalRow = aggregateTotals.result.rows[0];
      expect(Number(totalRow.revenue)).toBe(130);
      expect(Number(totalRow.margin)).toBe(67);
      expect(Number(totalRow.order_count)).toBe(6);
      expect(Number(totalRow.margin_rate)).toBeCloseTo(67 / 130, 12);
      expect(Number(totalRow.average_order_value)).toBeCloseTo(130 / 6, 12);
      expect(aggregateTotals.dataset).toMatchObject({
        aggregateComponentProof: {
          status: 'passed',
          evidence: { method: 'distinct_membership_scope', checkedDistinctComponents: ['daily_orders'] },
          binding: { readScopeId: expect.any(String), readScopeContextFingerprint: expect.any(String) },
        },
        aggregationSafety: { status: 'safe' },
      });
      expect(membershipProbeCount).toBe(1);

      // A superseded view must not turn a late aggregate proof/result into a
      // current receipt. Hold the first membership statement before native
      // execution, submit the same mounted-view scope again, then release it.
      // The first request reaches the actual scoped App path; the retry must
      // create fresh scope/proof evidence rather than reuse its cancelled work.
      const cancellationEnteredBefore = membershipProbeCount;
      const cancellationCompletedBefore = completedMembershipProbeCount;
      const delayedProbe: NonNullable<typeof delayedMembershipProbe> = {
        started: deferred<void>(),
        release: deferred<void>(),
      };
      delayedMembershipProbe = delayedProbe;
      const retryScope = deferred<string>();
      waitForOpenedScope = {
        minimumCount: openedAggregateScopeIds.length + 2,
        deferred: retryScope,
      };
      try {
        const supersededRun = request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
          fullRun: true,
          runScope: 'aggregate-component-cancellation',
        });
        await delayedProbe.started.promise;
        const retryRun = request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
          fullRun: true,
          runScope: 'aggregate-component-cancellation',
        });
        const retryScopeId = await retryScope.promise;
        delayedProbe.release.resolve();
        const [supersededResponse, retryResponse] = await Promise.all([supersededRun, retryRun]);
        expect(supersededResponse.status, supersededResponse.text).toBe(200);
        expect(supersededResponse.body).toMatchObject({ stale: true });
        expect(findTile(supersededResponse.body.tiles, 'Aggregate totals')).toMatchObject({ status: 'stale' });
        expect(findTile(supersededResponse.body.tiles, 'Aggregate totals').result).toBeUndefined();
        expect(retryResponse.status, retryResponse.text).toBe(200);
        expect(retryResponse.body.stale).not.toBe(true);
        const retryTotals = findTile(retryResponse.body.tiles, 'Aggregate totals');
        expect(retryTotals).toMatchObject({ status: 'ok' });
        expect(Number(retryTotals.result.rows[0].revenue)).toBe(130);
        expect(retryTotals.dataset.aggregateComponentProof.binding.readScopeId).toBe(retryScopeId);
        expect(retryTotals.dataset.aggregateComponentProof.binding.readScopeId).not.toBe(delayedProbe.scopeId);
        // The held request entered the wrapper but its native membership
        // statement never completed after AbortSignal was set. Only the retry
        // obtains current proof rows; there is no late result to reuse.
        expect(membershipProbeCount - cancellationEnteredBefore).toBe(2);
        expect(completedMembershipProbeCount - cancellationCompletedBefore).toBe(1);
      } finally {
        delayedProbe.release.resolve();
        delayedMembershipProbe = undefined;
        waitForOpenedScope = undefined;
      }

      // Mutation after the scoped full-source grain query, but before the
      // metadata/membership/tile statements, must remain invisible to all of
      // those dependent statements. A new App run opens a new read scope and
      // then sees the committed row. This uses the server's normal preview
      // endpoint rather than a connector-only transaction test.
      mutationScopeId = undefined;
      postMutationScopeSql.length = 0;
      let snapshotMutationInserted = false;
      let writerRevenueAfterMutation: number | undefined;
      mutateAfterGrainProbe = async () => {
        const writer = aggregateScopeConnector;
        if (!writer) throw new Error('Aggregate component scope did not expose its active DuckDB connector.');
        await writer.execute(
          "INSERT INTO order_lines VALUES ('OL-010', 'O-999', 'C-004', 'US', '2026-03-05', 10, 4, 6)",
        );
        const writerResult = await writer.execute('SELECT SUM(net_amount) AS revenue FROM order_lines');
        writerRevenueAfterMutation = Number(writerResult.rows[0]?.revenue);
        snapshotMutationInserted = true;
      };
      try {
        const snapshotRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
          fullRun: true,
          runScope: 'aggregate-component-snapshot',
        });
        expect(snapshotRun.status, snapshotRun.text).toBe(200);
        expect(snapshotMutationInserted).toBe(true);
        expect(writerRevenueAfterMutation).toBe(140);
        const snapshotTotals = findTile(snapshotRun.body.tiles, 'Aggregate totals');
        expect(snapshotTotals).toMatchObject({ status: 'ok' });
        // The query ran under the transaction snapshot established before the
        // writer committed, so it cannot mix old proof with new tile rows.
        expect(Number(snapshotTotals.result.rows[0].revenue)).toBe(130);
        expect(Number(snapshotTotals.result.rows[0].margin)).toBe(67);
        expect(Number(snapshotTotals.result.rows[0].order_count)).toBe(6);
        expect(snapshotTotals.dataset.aggregateComponentProof.binding.readScopeId).toBe(mutationScopeId);
        expect(postMutationScopeSql.some((sql) => sql.includes('__dql_overlap'))).toBe(true);
        expect(postMutationScopeSql.some((sql) => sql.includes('SUM(ds."daily_revenue")'))).toBe(true);

        const freshRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
          fullRun: true,
          runScope: 'aggregate-component-snapshot-fresh',
        });
        expect(freshRun.status, freshRun.text).toBe(200);
        const freshTotals = findTile(freshRun.body.tiles, 'Aggregate totals');
        expect(freshTotals).toMatchObject({ status: 'ok' });
        expect(Number(freshTotals.result.rows[0].revenue)).toBe(140);
        expect(Number(freshTotals.result.rows[0].margin)).toBe(73);
        expect(Number(freshTotals.result.rows[0].order_count)).toBe(7);
        expect(freshTotals.dataset.aggregateComponentProof.binding.readScopeId).not.toBe(mutationScopeId);
        expect(freshTotals.dataset.aggregateComponentProof.fingerprint).not.toBe(snapshotTotals.dataset.aggregateComponentProof.fingerprint);
      } finally {
        mutateAfterGrainProbe = undefined;
        if (snapshotMutationInserted) {
          await aggregateScopeConnector?.execute("DELETE FROM order_lines WHERE order_line_id = 'OL-010'");
        }
      }

      // A successful aggregate preview must remain eligible for the same
      // receipt attachment path as an ordinary Dataset tile. The run-owned
      // component proof is execution provenance, not a new persisted source
      // authority or a reason to discard correct App results.
      const attachedReceipt = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_preview_receipt',
          receipt: {
            id: positiveRun.body.runId,
            pageId: page.id,
            revision: draft.revision,
            snapshotId: positiveRun.body.snapshotId,
            filterFingerprint: positiveRun.body.filterFingerprint,
            resultFingerprint: positiveRun.body.resultFingerprint,
            createdAt: new Date().toISOString(),
          },
        }],
      });
      expect(attachedReceipt.status, attachedReceipt.text).toBe(200);
      draft = attachedReceipt.body.draft;
      expect(draft.previewReceipts).toEqual([expect.objectContaining({ id: positiveRun.body.runId, pageId: page.id })]);

      // Add one unique customer-day row for an existing order in a different
      // native day bucket. Row grain remains valid and money stays unchanged,
      // but SUM(daily_orders) would become 7 instead of the true 6 orders.
      await executor.executePositional(
        "INSERT INTO order_lines VALUES ('OL-009', 'O-100', 'C-001', 'US', '2026-01-06', 0, 0, 0)",
        [],
        connection,
      );
      await executor.disconnect();

      // The direct SUM/ratio selection uses structural source mapping only;
      // it stays usable when the distinct membership proof fails elsewhere.
      // The order/AOV selection must fail before its tile SQL can use the
      // unsafe day-level count. These tiles already belonged to the successful
      // page receipt, so no content mutation can hide a stale receipt bug.
      const membershipProbeCountBeforeOverlap = membershipProbeCount;
      const overlapRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', { fullRun: true });
      expect(overlapRun.status, overlapRun.text).toBe(200);
      expect(overlapRun.body).toMatchObject({
        incomplete: {
          priorPreviewReceiptInvalidated: true,
        },
        facts: [],
      });
      const safeTile = findTile(overlapRun.body.tiles, 'Safe aggregate sums and rate');
      expect(safeTile).toMatchObject({
        status: 'ok',
        dataset: { aggregateComponentProof: { status: 'passed', evidence: { method: 'direct_sum_mapping' } } },
      });
      expect(Number(safeTile.result.rows[0].revenue)).toBe(130);
      expect(Number(safeTile.result.rows[0].margin)).toBe(67);
      expect(Number(safeTile.result.rows[0].margin_rate)).toBeCloseTo(67 / 130, 12);
      const unsafeTile = findTile(overlapRun.body.tiles, 'Unsafe order components');
      expect(unsafeTile).toMatchObject({
        status: 'error',
        error: expect.stringContaining('raw key in more than one native source bucket'),
        dataset: expect.objectContaining({ errors: ['DATASET_AGGREGATE_COMPONENT_OVERLAP'] }),
      });
      expect(overlapRun.body.incomplete.failedTileIds).toContain(unsafeTile.tileId);
      // Aggregate totals and Unsafe order components both need daily_orders.
      // The later run gets one fresh probe, but duplicate tiles share it.
      expect(membershipProbeCount - membershipProbeCountBeforeOverlap).toBe(1);
      const afterIncomplete = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'GET');
      expect(afterIncomplete.status, afterIncomplete.text).toBe(200);
      expect(afterIncomplete.body.draft.previewReceipts ?? []).toEqual([]);
      // A client cannot re-attach the older successful run after a current
      // incomplete scope. Its local evidence was invalidated with the old
      // page receipt, not merely removed from the draft payload.
      const staleReceiptReplay = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_preview_receipt',
          receipt: {
            id: positiveRun.body.runId,
            pageId: page.id,
            revision: draft.revision,
            snapshotId: positiveRun.body.snapshotId,
            filterFingerprint: positiveRun.body.filterFingerprint,
            resultFingerprint: positiveRun.body.resultFingerprint,
            createdAt: new Date().toISOString(),
          },
        }],
      });
      expect(staleReceiptReplay.status, staleReceiptReplay.text).toBe(400);
      expect(staleReceiptReplay.body.error).toContain('App preview receipt is unavailable');

      // A reviewer cannot opt a known grouped SQL source out of the proof
      // path by clearing its declaration. Restarting forces the catalog to
      // resolve the changed authored definition before the App dispatches any
      // field-tile SQL.
      const aggregateDeclarationPath = join(projectRoot, 'domains', 'commerce', 'blocks', 'customer-daily-dataset.dql');
      writeFileSync(
        aggregateDeclarationPath,
        readFileSync(aggregateDeclarationPath, 'utf8').replace('aggregate = true', 'aggregate = false'),
      );
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      server = undefined;
      await executor.disconnect();
      const declarationPort = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const declarationBase = `http://127.0.0.1:${declarationPort}`;
      const declarationDraftResponse = await request(declarationBase, '/api/app-builds', 'POST', {
        name: 'Aggregate declaration guard App',
        goal: 'Refuse a grouped Dataset whose declaration cleared aggregate.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(declarationDraftResponse.status, declarationDraftResponse.text).toBe(201);
      const declarationDraft = declarationDraftResponse.body.draft;
      const declarationCandidates = await request(declarationBase, `/api/app-builds/${encodeURIComponent(declarationDraft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      expect(declarationCandidates.status, declarationCandidates.text).toBe(200);
      const declarationSource = declarationCandidates.body.items.find((item: any) => item.kind === 'block'
        && item.title === 'Customer daily Dataset');
      expect(declarationSource?.capabilities?.dataset?.grain?.aggregate).not.toBe(true);
      const declarationComposed = await request(declarationBase, `/api/app-builds/${encodeURIComponent(declarationDraft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: declarationDraft.revision,
        expectedProposalHash: declarationDraft.proposalHash,
        selections: [blockSelection(declarationSource.sourceId, 'Bypassed aggregate orders', 'table', {
          dimensions: [],
          measures: [{ measure: 'order_count' }],
        })],
      });
      expect(declarationComposed.status, declarationComposed.text).toBe(200);
      const declarationRun = await request(declarationBase, `/api/app-builds/${encodeURIComponent(declarationDraft.id)}/dashboards/overview/run`, 'POST', { fullRun: true });
      expect(declarationRun.status, declarationRun.text).toBe(200);
      expect(findTile(declarationRun.body.tiles, 'Bypassed aggregate orders')).toMatchObject({
        status: 'error',
        error: expect.stringContaining('declared grain.aggregate is false'),
        dataset: expect.objectContaining({ errors: ['DATASET_AGGREGATE_DECLARATION_MISMATCH'] }),
      });
    } finally {
      restoreScopeSpy?.();
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 60_000);

  duckDbIt('APP-031 APP-034 APP-041 builds, executes, publishes, and rejects live grain drift across block and native semantic Datasets', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-runtime-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      // Local runtime deliberately normalizes every connection to the
      // project-owned `.dql/connectors` search path.  Link the explicitly
      // configured disposable root into this disposable project instead of
      // allowing the startup helper to install anything or fall back to an
      // ambient native binding.
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });

      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const executeQuerySpy = vi.spyOn(executor, 'executeQuery');

      const created = await request(base, '/api/app-builds', 'POST', {
        name: 'Commerce Dataset field App',
        goal: 'Monitor revenue, orders, customers, and margin by region and month.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      expect(draft).toMatchObject({ version: 3, state: 'local_draft' });
      // An older client's data rule is ignored: new Apps store none (T3).
      expect(draft).not.toHaveProperty('sourcePolicy');

      const sourceCandidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      expect(sourceCandidates.status, sourceCandidates.text).toBe(200);
      const blockSource = sourceCandidates.body.items.find((item: any) => item.kind === 'block'
        && item.title === 'Order lines Dataset'
        && item.capabilities?.dataset?.kind === 'block');
      const semanticSource = sourceCandidates.body.items.find((item: any) => item.kind === 'semantic' && item.capabilities?.dataset?.kind === 'semantic');
      expect(blockSource).toMatchObject({ lifecycle: 'certified', trust: 'certified', capabilities: { dataset: { binding: { state: 'target_required' } } } });
      expect(semanticSource).toMatchObject({
        lifecycle: 'certified', trust: 'certified',
        capabilities: {
          dataset: { kind: 'semantic', execution: { route: 'semantic', adapterId: 'native' } },
          metricCapabilities: expect.any(Object),
        },
      });
      expect(Object.keys(semanticSource.capabilities.metricCapabilities)).toHaveLength(5);
      const grainProofPath = join(projectRoot, '.dql', 'local', 'datasets', 'proofs.json');
      // A clean reconstruction has no machine-local receipt. The first App
      // run must create its proof from a complete live-source probe instead
      // of requiring an earlier Studio validation click.
      expect(existsSync(grainProofPath)).toBe(false);

      const composed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [
          blockSelection(blockSource.sourceId, 'Revenue', 'kpi', { dimensions: [], measures: [{ measure: 'revenue' }] }),
          blockSelection(blockSource.sourceId, 'Distinct orders', 'kpi', { dimensions: [], measures: [{ measure: 'order_count' }] }),
          blockSelection(blockSource.sourceId, 'Distinct customers', 'kpi', { dimensions: [], measures: [{ measure: 'customer_count' }] }),
          blockSelection(blockSource.sourceId, 'Margin rate', 'kpi', { dimensions: [], measures: [{ measure: 'margin_rate' }] }),
          blockSelection(blockSource.sourceId, 'Revenue by region', 'chart', {
            dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], orderBy: [{ alias: 'revenue', direction: 'desc' }],
          }),
          blockSelection(blockSource.sourceId, 'Revenue by month', 'chart', {
            dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }], orderBy: [{ alias: 'order_date_month', direction: 'asc' }],
          }),
          blockSelection(blockSource.sourceId, 'Order line details', 'table', {
            dimensions: [],
            measures: [],
            detail: true,
            detailColumns: ['order_line_id', 'order_id', 'customer_id', 'region', 'order_date', 'net_amount'],
            limit: 100,
          }),
          blockSelection(semanticSource.sourceId, 'Semantic commerce totals', 'table', {
            dimensions: [],
            measures: [
              { measure: 'semantic_revenue' },
              { measure: 'semantic_order_count' },
              { measure: 'semantic_customer_count' },
              { measure: 'semantic_margin_rate' },
            ],
          }),
        ],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const page = draft.pages.find((candidate: any) => candidate.id === 'overview');
      expect(page?.layout.items).toHaveLength(8);
      expect(page?.layout.items.find((item: any) => item.title === 'Semantic commerce totals')).toMatchObject({
        viz: { type: 'table' },
        query: {
          dimensions: [],
          measures: [
            { measure: 'semantic_revenue' },
            { measure: 'semantic_order_count' },
            { measure: 'semantic_customer_count' },
            { measure: 'semantic_margin_rate' },
          ],
        },
      });
      const blockDatasetBinding = page.datasets.find((binding: any) => binding.sourceId === blockSource.sourceId);
      const semanticDatasetBinding = page.datasets.find((binding: any) => binding.sourceId === semanticSource.sourceId);
      expect(blockDatasetBinding).toBeTruthy();
      expect(semanticDatasetBinding).toBeTruthy();

      const filterPatch = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_filter',
          pageId: page.id,
          filter: {
            id: 'region',
            type: 'multiselect',
            label: 'Region',
            scope: { app: true },
            datasetBindings: {
              [blockDatasetBinding.id]: { field: 'region' },
              [semanticDatasetBinding.id]: { field: 'region' },
            },
          },
        }],
      });
      expect(filterPatch.status, filterPatch.text).toBe(200);
      draft = filterPatch.body.draft;

      // Keep a native semantic Dataset page in the published package as well
      // as the mixed overview. Reopening the package in a new runtime must
      // restore both page bindings from the current catalog, not just the
      // legacy source registry shape used by the original overview.
      const semanticTotalsTile = page.layout.items.find((item: any) => item.title === 'Semantic commerce totals');
      expect(semanticTotalsTile).toBeTruthy();
      const semanticPagePatch = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'upsert_page',
          page: {
            version: 3,
            id: 'semantic-detail',
            metadata: {
              title: 'Semantic detail',
              description: 'Native semantic Dataset detail page',
              domain: 'commerce',
              audience: 'operators',
              visibility: 'private',
              lifecycle: 'draft',
            },
            datasets: [structuredClone(semanticDatasetBinding)],
            filters: [{
              id: 'region',
              type: 'multiselect',
              label: 'Region',
              scope: { app: true },
              datasetBindings: { [semanticDatasetBinding.id]: { field: 'region' } },
            }],
            layout: {
              kind: 'grid',
              cols: 12,
              rowHeight: 80,
              items: [{ ...structuredClone(semanticTotalsTile), i: 'semantic-detail-totals', x: 0, y: 0, w: 6, h: 4 }],
            },
          },
        }],
      });
      expect(semanticPagePatch.status, semanticPagePatch.text).toBe(200);
      draft = semanticPagePatch.body.draft;
      const semanticPage = draft.pages.find((candidate: any) => candidate.id === 'semantic-detail');
      expect(semanticPage).toMatchObject({
        version: 3,
        datasets: [expect.objectContaining({ sourceId: semanticSource.sourceId, sourceRevision: semanticSource.sourceRevision })],
        layout: { items: [expect.objectContaining({ sourceId: semanticSource.sourceId, query: expect.any(Object) })] },
      });

      // A malformed/local restored draft cannot bypass the parser's v3
      // Dataset boundary merely because it was read from SQLite instead of a
      // .dqld file. Restore the legitimate draft before the live journey.
      const localDraftStorage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
      try {
        localDraftStorage.saveAppBuildDraft({
          ...draft,
          pages: draft.pages.map((candidate: any) => candidate.id === page.id ? { ...candidate, version: 2 } : candidate),
        });
      } finally {
        localDraftStorage.close();
      }
      const legacyDatasetRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
      });
      expect(legacyDatasetRun.status, legacyDatasetRun.text).toBe(400);
      expect(legacyDatasetRun.body.error).toContain('require dashboard version 3');

      // A directly restored v3 draft must also preserve the parser boundary:
      // Dataset field filters and dashboard parameters cannot share an id.
      const collisionDraftStorage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
      try {
        collisionDraftStorage.saveAppBuildDraft({
          ...draft,
          pages: draft.pages.map((candidate: any) => candidate.id === page.id ? {
            ...candidate,
            params: [...(candidate.params ?? []), { id: 'region', type: 'string' }],
          } : candidate),
        });
      } finally {
        collisionDraftStorage.close();
      }
      const collisionDatasetRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
      });
      expect(collisionDatasetRun.status, collisionDatasetRun.text).toBe(400);
      expect(collisionDatasetRun.body.error).toContain('params.region conflicts with filters.region');

      const restoredDraftStorage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
      try {
        restoredDraftStorage.saveAppBuildDraft(draft);
      } finally {
        restoredDraftStorage.close();
      }

      // A page-level Dataset filter can deliberately exclude one compatible
      // component. Keep the page scope broad so the excluded component still
      // runs, reports its exclusion, and retains its own complete-source
      // story scope rather than being presented as a California trend.
      const monthlyRevenueTile = page.layout.items.find((item: any) => item.title === 'Revenue by month');
      expect(monthlyRevenueTile).toBeTruthy();
      const selectedBlockTileIds = page.layout.items
        .filter((item: any) => item.query && item.sourceId === blockSource.sourceId && item.i !== monthlyRevenueTile.i)
        .map((item: any) => item.i)
        .sort();
      const selectedSemanticTileIds = page.layout.items
        .filter((item: any) => item.query && item.sourceId === semanticSource.sourceId)
        .map((item: any) => item.i)
        .sort();
      const explicitSelectionPatch = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_filter',
          pageId: page.id,
          filter: {
            id: 'region',
            type: 'multiselect',
            label: 'Region',
            scope: { app: true },
            datasetBindings: {
              [blockDatasetBinding.id]: { field: 'region', tileIds: selectedBlockTileIds },
              [semanticDatasetBinding.id]: { field: 'region', tileIds: selectedSemanticTileIds },
            },
          },
        }],
      });
      expect(explicitSelectionPatch.status, explicitSelectionPatch.text).toBe(200);
      draft = explicitSelectionPatch.body.draft;

      const excludedComponentRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        fullRun: true,
      });
      expect(excludedComponentRun.status, excludedComponentRun.text).toBe(200);
      const californiaRevenue = findTile(excludedComponentRun.body.tiles, 'Revenue');
      expect(californiaRevenue.error).toBeUndefined();
      expect(californiaRevenue).toMatchObject({ status: 'ok' });
      expect(californiaRevenue.result.rows).toEqual([{ revenue: 60 }]);
      expect(californiaRevenue.dataset).toMatchObject({
        appliedFilters: [expect.objectContaining({ field: 'region', values: ['CA'] })],
        unboundFilters: [],
      });
      const fullSourceMonthlyRevenue = findTile(excludedComponentRun.body.tiles, 'Revenue by month');
      expect(fullSourceMonthlyRevenue).toMatchObject({ status: 'ok' });
      expect(fullSourceMonthlyRevenue.result.rows.map((row: any) => row.revenue)).toEqual([60, 30, 40]);
      expect(fullSourceMonthlyRevenue.dataset).toMatchObject({
        appliedFilters: [],
        unboundFilters: [expect.objectContaining({
          filterId: 'region',
          code: 'DATASET_TILE_EXCLUDED',
          message: expect.stringContaining('Revenue by month'),
        })],
      });
      const monthlyFactIds = new Set((excludedComponentRun.body.facts ?? [])
        .filter((fact: any) => fact.tileId === fullSourceMonthlyRevenue.tileId)
        .map((fact: any) => fact.id));
      expect(monthlyFactIds.size).toBeGreaterThan(0);
      const monthlyFacts = (excludedComponentRun.body.facts ?? [])
        .filter((fact: any) => monthlyFactIds.has(fact.id));
      expect(monthlyFacts.map((fact: any) => fact.filters)).toEqual(
        monthlyFacts.map(() => ({})),
      );
      const narratedFactIds = new Set((excludedComponentRun.body.story.claims ?? []).flatMap((claim: any) => claim.factIds));
      expect([...narratedFactIds].some((factId) => monthlyFactIds.has(factId))).toBe(false);
      expect(excludedComponentRun.body.story.caveat).toContain('outside the current filter scope');

      // Restore the broad v3 form before the remainder of the publication
      // journey, which intentionally verifies page-wide Region filtering.
      const restoredFilterPatch = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_filter',
          pageId: page.id,
          filter: {
            id: 'region',
            type: 'multiselect',
            label: 'Region',
            scope: { app: true },
            datasetBindings: {
              [blockDatasetBinding.id]: { field: 'region' },
              [semanticDatasetBinding.id]: { field: 'region' },
            },
          },
        }],
      });
      expect(restoredFilterPatch.status, restoredFilterPatch.text).toBe(200);
      draft = restoredFilterPatch.body.draft;

      executeQuerySpy.mockClear();
      const firstRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        fullRun: true,
      });
      expect(firstRun.status, firstRun.text).toBe(200);
      expect(firstRun.body.stale).toBeUndefined();
      expect(firstRun.body.tiles).toHaveLength(8);
      expect(firstRun.body.tiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'Revenue', status: 'ok', tileType: 'dataset', trustState: 'certified' }),
        expect.objectContaining({ title: 'Semantic commerce totals', status: 'ok', tileType: 'dataset', trustState: 'certified' }),
      ]));
      expect(firstRun.body.tiles.every((tile: any) => tile.status === 'ok')).toBe(true);
      const grainProbeCallCount = () => executeQuerySpy.mock.calls.filter(([sql]) => typeof sql === 'string'
        && sql.includes('__dql_grain_key_count')).length;
      // Six block tiles share one exact binding, so their first reconstructed
      // run creates exactly one whole-source proof rather than six previews.
      expect(grainProbeCallCount()).toBe(1);
      expect(existsSync(grainProofPath)).toBe(true);

      const regionRevenue = findTile(firstRun.body.tiles, 'Revenue by region');
      expect(regionRevenue.result.rows).toEqual([{ region: 'CA', revenue: 60 }]);
      expect(regionRevenue.dataset).toMatchObject({
        binding: { state: 'valid' },
        proofState: 'valid',
        grainRuntimeEvidence: { status: 'passed', uniqueness: { rowCount: 8, distinctKeyCount: 8 } },
        appliedFilters: [{ field: 'region', op: 'in', values: ['CA'], placement: 'where' }],
      });
      expect(regionRevenue.artifact).toMatchObject({
        sourceKind: 'dataset_query', trustState: 'certified',
        dql: expect.stringContaining('dataset_tile_query'),
        authoredQuerySpec: expect.stringContaining('boundFilterEvidence'),
        sql: expect.stringContaining('WITH ds AS'),
      });
      expect(regionRevenue.dataset).toMatchObject({
        authoredQueryFingerprint: expect.any(String),
        executionProvenance: expect.objectContaining({
          kind: 'block_runtime',
          compiledSqlFingerprint: expect.any(String),
          executedSqlFingerprint: expect.any(String),
          resultFingerprint: expect.any(String),
          targetFingerprint: expect.any(String),
        }),
      });
      // Region is an active dashboard field filter. Its raw selected value
      // remains server-side; the browser gets only the safe binding evidence.
      expect(regionRevenue.artifact.authoredQuerySpec).not.toContain('"CA"');
      const persistedProof = (JSON.parse(readFileSync(grainProofPath, 'utf8')) as { proofs: any[] }).proofs
        .find((proof) => proof.id === 'proof.order-lines');
      expect(persistedProof).toMatchObject({
        status: 'passed',
        sourceFingerprint: blockSource.sourceRevision,
        targetFingerprint: regionRevenue.dataset.executionProvenance.targetFingerprint,
        uniqueness: { rowCount: 8, distinctKeyCount: 8, nullKeyCount: 0, duplicateKeyCount: 0 },
      });

      // A persisted proof is never a cache of warehouse uniqueness. The next
      // complete dashboard run still performs one fresh probe, and deleting
      // local state lets a later run bootstrap again from the real source.
      const repeatRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        fullRun: true,
      });
      expect(repeatRun.status, repeatRun.text).toBe(200);
      expect(repeatRun.body.tiles.every((tile: any) => tile.status === 'ok')).toBe(true);
      expect(grainProbeCallCount()).toBe(2);
      rmSync(grainProofPath, { force: true });
      expect(existsSync(grainProofPath)).toBe(false);
      const reconstructedRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        fullRun: true,
      });
      expect(reconstructedRun.status, reconstructedRun.text).toBe(200);
      expect(reconstructedRun.body.tiles.every((tile: any) => tile.status === 'ok')).toBe(true);
      expect(grainProbeCallCount()).toBe(3);
      expect(existsSync(grainProofPath)).toBe(true);
      const explicitGrainValidation = await request(base, '/api/datasets/validate-grain', 'POST', {
        sourceId: blockSource.sourceId,
        sourceRevision: blockSource.sourceRevision,
      });
      expect(explicitGrainValidation.status, explicitGrainValidation.text).toBe(200);
      expect(explicitGrainValidation.body).toMatchObject({
        ok: true,
        eligible: true,
        localPath: '.dql/local/datasets/proofs.json',
        evidence: {
          status: 'passed',
          keyFields: ['order_line_id'],
          uniqueness: { rowCount: 8, distinctKeyCount: 8, nullKeyCount: 0, duplicateKeyCount: 0 },
        },
      });

      const orderLineDetails = findTile(firstRun.body.tiles, 'Order line details');
      expect(orderLineDetails.result.rows).toEqual([
        expect.objectContaining({ order_line_id: 'OL-004', region: 'CA' }),
        expect.objectContaining({ order_line_id: 'OL-006', region: 'CA' }),
        expect.objectContaining({ order_line_id: 'OL-007', region: 'CA' }),
      ]);
      expect(orderLineDetails.result.columns).toEqual(['order_line_id', 'order_id', 'customer_id', 'region', 'order_date', 'net_amount']);
      expect(orderLineDetails.artifact.sql).toContain('ORDER BY ds."order_line_id" ASC');

      const semanticTotals = findTile(firstRun.body.tiles, 'Semantic commerce totals');
      expect(semanticTotals.result.rows).toEqual([{ semantic_revenue: 60, semantic_order_count: 2, semantic_customer_count: 2, semantic_margin_rate: 0.6 }]);
      expect(semanticTotals.result.columnsMeta).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'semantic_revenue', kind: 'currency', unit: 'USD', decimals: 2 }),
        expect.objectContaining({ name: 'semantic_margin_rate', kind: 'percent', unit: 'fraction', decimals: 1 }),
      ]));
      expect(semanticTotals.dataset).toMatchObject({
        binding: { state: 'valid' },
        semanticTargetBinding: { adapterId: 'native' },
        semanticReceipt: { adapterId: 'native', outcome: 'succeeded' },
        authoredQueryFingerprint: expect.any(String),
        executionProvenance: expect.objectContaining({
          kind: 'semantic_runtime',
          targetFingerprint: expect.any(String),
          executedSqlFingerprint: expect.any(String),
        }),
        semanticRequest: {
          metrics: expect.arrayContaining([
            expect.objectContaining({ metricId: expect.stringMatching(/^semantic:metric:/), semanticReference: 'order_lines.semantic_revenue' }),
          ]),
        },
      });
      expect(semanticTotals.artifact).toMatchObject({
        sourceKind: 'dataset_query', trustState: 'certified',
        dql: expect.stringContaining('semantic'),
      });
      expect(semanticTotals.artifact.dql).toContain('semanticRequest');
      expect(semanticTotals.artifact.dql).toContain('semantic:metric:');
      expect(semanticTotals.artifact.authoredQuerySpec).toContain('boundParameterEvidence');
      expect(semanticTotals.artifact.authoredQuerySpec).not.toContain('"CA"');

      // Supplied cross-filter input must be all-or-nothing. A malformed entry
      // cannot be silently removed and turn a filtered request into an
      // unfiltered warehouse query.
      const malformedCrossFilters = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        crossFilters: [
          {
            field: 'region', values: ['CA'], fromTileId: regionRevenue.tileId,
            fromSourceId: blockSource.sourceId, fromSourceRevision: blockSource.sourceRevision,
          },
          {
            field: 'region', values: ['CA'], fromTileId: regionRevenue.tileId,
            fromSourceId: blockSource.sourceId,
          },
        ],
      });
      expect(malformedCrossFilters.status, malformedCrossFilters.text).toBe(400);
      expect(malformedCrossFilters.body).toMatchObject({ error: expect.stringContaining('crossFilters[1] requires') });
      expect(malformedCrossFilters.body.runId).toBeUndefined();

      const wrongCrossFilterType = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        crossFilters: { field: 'region' },
      });
      expect(wrongCrossFilterType.status, wrongCrossFilterType.text).toBe(400);
      expect(wrongCrossFilterType.body).toMatchObject({ error: expect.stringContaining('crossFilters must be an array') });

      // A mark or retry can refresh only the exact declared affected tile
      // subset, but that result must not acquire a whole-page story or a
      // publishable preview receipt. The next full preview remains the only
      // receipt candidate.
      const partialRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        affectedTileIds: [regionRevenue.tileId],
        runScope: 'pilot_viewer_scope_1',
      });
      expect(partialRun.status, partialRun.text).toBe(200);
      expect(partialRun.body).toMatchObject({
        partial: true,
        executedTileIds: [regionRevenue.tileId],
        facts: [],
        story: { headline: 'Partial dashboard refresh' },
      });
      expect(partialRun.body.tiles).toHaveLength(1);

      // Scheduling bounds are advisory reductions only. Invalid input gets a
      // client error, and an explicit empty set remains a no-op instead of
      // accidentally widening into a receipt-eligible full dashboard run.
      const malformedSchedule = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        visibleTileIds: 'not-an-array',
      });
      expect(malformedSchedule.status, malformedSchedule.text).toBe(400);
      expect(malformedSchedule.body.error).toContain('visibleTileIds must be an array');

      const emptySchedule = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        affectedTileIds: [],
      });
      expect(emptySchedule.status, emptySchedule.text).toBe(200);
      expect(emptySchedule.body).toMatchObject({
        partial: true,
        executedTileIds: [],
        tiles: [],
        facts: [],
        story: { headline: 'Partial dashboard refresh' },
      });
      const partialReceipt = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_preview_receipt',
          receipt: {
            id: partialRun.body.runId,
            pageId: page.id,
            revision: draft.revision,
            snapshotId: partialRun.body.snapshotId,
            filterFingerprint: partialRun.body.filterFingerprint,
            resultFingerprint: partialRun.body.resultFingerprint,
            createdAt: new Date().toISOString(),
          },
        }],
      });
      expect(partialReceipt.status, partialReceipt.text).toBe(400);
      expect(partialReceipt.body.error).toContain('receipt is unavailable');

      // A client must not edit query A into query B and attach A's settled
      // run in the same PATCH.  The server calculates the post-edit intent
      // fingerprint before it accepts a receipt, rather than trusting the
      // browser's revision or result summary.
      const revenueTile = page.layout.items.find((item: any) => item.title === 'Revenue');
      expect(revenueTile).toBeTruthy();
      const replayedReceipt = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [
          {
            type: 'update_tile',
            pageId: page.id,
            tileId: revenueTile.i,
            // Keep the replay test inside the approved Dataset contract. The
            // post-edit intent must differ from Revenue, but query validation
            // must not short-circuit the intended stale-receipt rejection.
            patch: { query: { dimensions: [], measures: [{ measure: 'order_count' }] } },
          },
          {
            type: 'set_preview_receipt',
            receipt: {
              id: firstRun.body.runId,
              pageId: page.id,
              revision: draft.revision,
              snapshotId: firstRun.body.snapshotId,
              filterFingerprint: firstRun.body.filterFingerprint,
              resultFingerprint: firstRun.body.resultFingerprint,
              createdAt: new Date().toISOString(),
            },
          },
        ],
      });
      expect(replayedReceipt.status, replayedReceipt.text).toBe(400);
      expect(replayedReceipt.body.error).toContain('different draft content');

      const receiptPatch = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_preview_receipt',
          receipt: {
            id: firstRun.body.runId,
            pageId: page.id,
            revision: draft.revision,
            snapshotId: firstRun.body.snapshotId,
            filterFingerprint: firstRun.body.filterFingerprint,
            resultFingerprint: firstRun.body.resultFingerprint,
            createdAt: new Date().toISOString(),
          },
        }],
      });
      expect(receiptPatch.status, receiptPatch.text).toBe(200);
      draft = receiptPatch.body.draft;
      expect(draft.previewReceipts).toEqual([expect.objectContaining({ id: firstRun.body.runId, pageId: page.id, revision: draft.revision })]);

      // A stored receipt must bind to the current configured/observed target,
      // rather than reconnecting to the historical target named by the
      // receipt. Restart on another DuckDB target and prove preflight rejects
      // the old run before any publication state is written.
      const configPath = join(projectRoot, 'dql.config.json');
      const originalConfig = readFileSync(configPath, 'utf8');
      const originalConfigStat = statSync(configPath);
      const alternateDatabaseName = 'app-datasets-piloB.duckdb';
      const alternateDatabasePath = join(projectRoot, alternateDatabaseName);
      cpSync(databasePath, alternateDatabasePath);
      writeFileSync(configPath, originalConfig.replace('app-datasets-pilot.duckdb', alternateDatabaseName));
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      server = undefined;
      await executor.disconnect();
      const targetBPort = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const targetDriftPreflight = await request(`http://127.0.0.1:${targetBPort}`, `/api/app-builds/${encodeURIComponent(draft.id)}/preflight`, 'POST', {
        expectedRevision: draft.revision,
        proposalHash: draft.proposalHash,
      });
      expect(targetDriftPreflight.status, targetDriftPreflight.text).toBe(400);
      expect(targetDriftPreflight.body.errors.join('\n')).toContain('different warehouse target');
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      server = undefined;
      await executor.disconnect();
      writeFileSync(configPath, originalConfig);
      utimesSync(configPath, originalConfigStat.atime, originalConfigStat.mtime);
      let delayedChartAnswer: ReturnType<typeof deferred<string>> | null = null;
      const chartAnswerProviderGenerate = vi.fn(async () => {
        const pending = delayedChartAnswer;
        return pending ? pending.promise : 'The governed chart result is available.';
      });
      const chartAnswerProvider = {
        name: 'openai' as const,
        available: async () => true,
        generate: chartAnswerProviderGenerate,
      };
      const restoredPort = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        // Host-only deterministic provider seam for the chart-answer lifecycle
        // check below; no request body can choose a provider or context.
        datasetChartAnswerProviderFactory: () => chartAnswerProvider,
        captureServer: (created) => { server = created; },
      });
      // A configuration mutation changes the project snapshot even after its
      // bytes are restored. Produce a fresh full preview on target A and bind
      // its new server receipt before continuing publication.
      const restoredBase = `http://127.0.0.1:${restoredPort}`;
      const restoredFullRun = await request(restoredBase, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        fullRun: true,
      });
      expect(restoredFullRun.status, restoredFullRun.text).toBe(200);
      const refreshedReceiptPatch = await request(restoredBase, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_preview_receipt',
          receipt: {
            id: restoredFullRun.body.runId,
            pageId: page.id,
            revision: draft.revision,
            snapshotId: restoredFullRun.body.snapshotId,
            filterFingerprint: restoredFullRun.body.filterFingerprint,
            resultFingerprint: restoredFullRun.body.resultFingerprint,
            createdAt: new Date().toISOString(),
          },
        }],
      });
      expect(refreshedReceiptPatch.status, refreshedReceiptPatch.text).toBe(200);
      draft = refreshedReceiptPatch.body.draft;

      const semanticPageFullRun = await request(restoredBase, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(semanticPage.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        fullRun: true,
      });
      expect(semanticPageFullRun.status, semanticPageFullRun.text).toBe(200);
      expect(semanticPageFullRun.body.tiles).toEqual([
        expect.objectContaining({ title: 'Semantic commerce totals', status: 'ok', trustState: 'certified' }),
      ]);
      const semanticReceiptPatch = await request(restoredBase, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_preview_receipt',
          receipt: {
            id: semanticPageFullRun.body.runId,
            pageId: semanticPage.id,
            revision: draft.revision,
            snapshotId: semanticPageFullRun.body.snapshotId,
            filterFingerprint: semanticPageFullRun.body.filterFingerprint,
            resultFingerprint: semanticPageFullRun.body.resultFingerprint,
            createdAt: new Date().toISOString(),
          },
        }],
      });
      expect(semanticReceiptPatch.status, semanticReceiptPatch.text).toBe(200);
      draft = semanticReceiptPatch.body.draft;
      expect(draft.previewReceipts).toEqual(expect.arrayContaining([
        expect.objectContaining({ pageId: page.id }),
        expect.objectContaining({ pageId: semanticPage.id }),
      ]));

      const preflight = await request(restoredBase, `/api/app-builds/${encodeURIComponent(draft.id)}/preflight`, 'POST', {
        expectedRevision: draft.revision,
        proposalHash: draft.proposalHash,
      });
      expect(preflight.status, preflight.text).toBe(200);
      draft = preflight.body.draft;
      expect(draft).toMatchObject({ state: 'preflight_ready', preflightReceipt: expect.any(Object) });

      const published = await request(restoredBase, `/api/app-builds/${encodeURIComponent(draft.id)}/publish-to-project`, 'POST', {
        expectedRevision: draft.revision,
        proposalHash: draft.proposalHash,
      });
      expect(published.status, published.text).toBe(201);
      expect(published.body.draft).toMatchObject({ state: 'project_published' });
      expect(existsSync(join(projectRoot, 'apps', draft.appId, 'dql.app.json'))).toBe(true);

      const publishedRun = await request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        runScope: 'chart_scope_a1b2c3d4',
      });
      expect(publishedRun.status, publishedRun.text).toBe(200);
      expect(publishedRun.body.tiles.every((tile: any) => tile.status === 'ok')).toBe(true);
      expect(findTile(publishedRun.body.tiles, 'Semantic commerce totals').result.rows).toEqual(semanticTotals.result.rows);

      // APP-066: a chart answer is current only within its mounted viewer
      // scope. A newer All-values run in scope A must revoke its old CA
      // answer, while a second viewer scope B remains independently usable.
      const publishedRevenue = findTile(publishedRun.body.tiles, 'Revenue');
      expect(publishedRevenue.result.rows).toEqual([{ revenue: 60 }]);
      const scopeBRun = await request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        runScope: 'chart_scope_b1c2d3e4',
      });
      expect(scopeBRun.status, scopeBRun.text).toBe(200);
      const scopeBRevenue = findTile(scopeBRun.body.tiles, 'Revenue');
      expect(scopeBRevenue.result.rows).toEqual([{ revenue: 60 }]);
      const scopeBAnswerBefore = await request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/ask`, 'POST', {
        question: 'What is revenue in this chart?',
        dashboardId: page.id,
        tileId: scopeBRevenue.tileId,
        runId: scopeBRun.body.runId,
      });
      expect(scopeBAnswerBefore.status, scopeBAnswerBefore.text).toBe(200);
      expect(scopeBAnswerBefore.body).toMatchObject({
        route: 'dataset_chart_answer',
        analyticalContext: { effectiveFilters: { region: ['CA'] } },
      });

      const scopeANewerRun = await request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: {},
        runScope: 'chart_scope_a1b2c3d4',
      });
      expect(scopeANewerRun.status, scopeANewerRun.text).toBe(200);
      expect(findTile(scopeANewerRun.body.tiles, 'Revenue').result.rows).toEqual([{ revenue: 130 }]);
      const supersededScopeAAnswer = await request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/ask`, 'POST', {
        question: 'What is revenue in this chart?',
        dashboardId: page.id,
        tileId: publishedRevenue.tileId,
        runId: publishedRun.body.runId,
      });
      expect(supersededScopeAAnswer.status, supersededScopeAAnswer.text).toBe(400);
      expect(supersededScopeAAnswer.body.error).toMatch(/newer chart run replaced this viewer scope/i);
      const scopeBAnswerAfter = await request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/ask`, 'POST', {
        question: 'What is revenue in this chart?',
        dashboardId: page.id,
        tileId: scopeBRevenue.tileId,
        runId: scopeBRun.body.runId,
      });
      expect(scopeBAnswerAfter.status, scopeBAnswerAfter.text).toBe(200);
      expect(scopeBAnswerAfter.body).toMatchObject({
        route: 'dataset_chart_answer',
        analyticalContext: { effectiveFilters: { region: ['CA'] } },
      });

      // A provider answer that began under scope C cannot arrive after a newer
      // scope-C run and speak for the old CA chart. The physical provider call
      // is intentionally allowed to settle; the runtime suppresses its result
      // through the same server-owned generation check.
      const scopeCRun = await request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        runScope: 'chart_scope_c1d2e3f4',
      });
      expect(scopeCRun.status, scopeCRun.text).toBe(200);
      const scopeCRevenue = findTile(scopeCRun.body.tiles, 'Revenue');
      const pendingScopeCAnswer = deferred<string>();
      delayedChartAnswer = pendingScopeCAnswer;
      const providerCallsBefore = chartAnswerProviderGenerate.mock.calls.length;
      const lateScopeCAnswer = request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/ask`, 'POST', {
        question: 'What is revenue in this chart?',
        dashboardId: page.id,
        tileId: scopeCRevenue.tileId,
        runId: scopeCRun.body.runId,
      });
      await vi.waitFor(() => expect(chartAnswerProviderGenerate).toHaveBeenCalledTimes(providerCallsBefore + 1));
      const scopeCNewerRun = await request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: {},
        runScope: 'chart_scope_c1d2e3f4',
      });
      expect(scopeCNewerRun.status, scopeCNewerRun.text).toBe(200);
      expect(findTile(scopeCNewerRun.body.tiles, 'Revenue').result.rows).toEqual([{ revenue: 130 }]);
      pendingScopeCAnswer.resolve('The old CA result was 60.');
      delayedChartAnswer = null;
      const lateScopeCAnswerResult = await lateScopeCAnswer;
      expect(lateScopeCAnswerResult.status, lateScopeCAnswerResult.text).toBe(400);
      expect(lateScopeCAnswerResult.body.error).toMatch(/newer chart run replaced this viewer scope/i);

      // APP-066: a provider answer must also be refused when the persisted
      // authored tile changes while it is pending, even if no newer viewer run
      // was started. The post-provider validation must re-read the complete
      // source/App/persona/target context rather than only its run scope.
      const scopeDRun = await request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        runScope: 'chart_scope_d1e2f3g4',
      });
      expect(scopeDRun.status, scopeDRun.text).toBe(200);
      const scopeDRevenue = findTile(scopeDRun.body.tiles, 'Revenue');
      const pendingScopeDAnswer = deferred<string>();
      delayedChartAnswer = pendingScopeDAnswer;
      const providerCallsBeforeQueryMutation = chartAnswerProviderGenerate.mock.calls.length;
      const lateScopeDAnswer = request(restoredBase, `/api/apps/${encodeURIComponent(draft.appId)}/ask`, 'POST', {
        question: 'What is revenue in this chart?',
        dashboardId: page.id,
        tileId: scopeDRevenue.tileId,
        runId: scopeDRun.body.runId,
      });
      await vi.waitFor(() => expect(chartAnswerProviderGenerate).toHaveBeenCalledTimes(providerCallsBeforeQueryMutation + 1));
      const publishedDashboardPath = join(projectRoot, 'apps', draft.appId, 'dashboards', `${page.id}.dqld`);
      const originalPublishedDashboard = readFileSync(publishedDashboardPath, 'utf8');
      try {
        const mutatedDashboard = JSON.parse(originalPublishedDashboard) as { layout: { items: Array<{ i: string; query?: { limit?: number } }> } };
        const mutatedTile = mutatedDashboard.layout.items.find((item) => item.i === scopeDRevenue.tileId);
        expect(mutatedTile?.query).toBeDefined();
        mutatedTile!.query!.limit = mutatedTile!.query!.limit === 1 ? 2 : 1;
        writeFileSync(publishedDashboardPath, `${JSON.stringify(mutatedDashboard, null, 2)}\n`);
        pendingScopeDAnswer.resolve('The old CA result was 60.');
        delayedChartAnswer = null;
        const lateScopeDAnswerResult = await lateScopeDAnswer;
        expect(lateScopeDAnswerResult.status, lateScopeDAnswerResult.text).toBe(400);
        expect(lateScopeDAnswerResult.body.error).toMatch(/changed after this chart ran/i);
      } finally {
        delayedChartAnswer = null;
        writeFileSync(publishedDashboardPath, originalPublishedDashboard);
      }

      // Edit from a cold runtime and persisted Project App package. The
      // published Dashboard files retain immutable Dataset binding intent;
      // Studio must rebuild editable source cards from the fresh catalog for
      // both block and native semantic sources before any mutation or run.
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      server = undefined;
      await executor.disconnect();
      const coldPort = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const coldBase = `http://127.0.0.1:${coldPort}`;
      const restoredEdit = await request(coldBase, '/api/app-builds', 'POST', {
        baseAppId: draft.appId,
        name: 'Commerce Dataset field App',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
      });
      expect(restoredEdit.status, restoredEdit.text).toBe(201);
      let editDraft = restoredEdit.body.draft;
      expect(editDraft.pages.map((candidate: any) => candidate.id).sort()).toEqual(['overview', 'semantic-detail']);
      const restoredOverview = editDraft.pages.find((candidate: any) => candidate.id === page.id);
      const restoredSemanticPage = editDraft.pages.find((candidate: any) => candidate.id === semanticPage.id);
      expect(restoredOverview).toMatchObject({
        datasets: expect.arrayContaining([
          expect.objectContaining({ sourceId: blockSource.sourceId, sourceRevision: blockSource.sourceRevision, contractFingerprint: blockDatasetBinding.contractFingerprint }),
          expect.objectContaining({ sourceId: semanticSource.sourceId, sourceRevision: semanticSource.sourceRevision, contractFingerprint: semanticDatasetBinding.contractFingerprint }),
        ]),
        filters: expect.arrayContaining([expect.objectContaining({ id: 'region' })]),
        layout: { items: expect.arrayContaining([expect.objectContaining({ sourceId: blockSource.sourceId, query: expect.any(Object) })]) },
      });
      expect(restoredSemanticPage).toMatchObject({
        datasets: [expect.objectContaining({ sourceId: semanticSource.sourceId, sourceRevision: semanticSource.sourceRevision, contractFingerprint: semanticDatasetBinding.contractFingerprint })],
        filters: [expect.objectContaining({ id: 'region' })],
        layout: { items: [expect.objectContaining({ sourceId: semanticSource.sourceId, sourceRevision: semanticSource.sourceRevision, query: expect.any(Object) })] },
      });
      const restoredBlockSource = editDraft.sources.find((source: any) => source.id === blockSource.sourceId);
      const restoredSemanticSource = editDraft.sources.find((source: any) => source.id === semanticSource.sourceId);
      expect(restoredBlockSource).toMatchObject({
        kind: 'block', sourceRevision: blockSource.sourceRevision, lifecycle: 'certified', trustState: 'certified',
      });
      expect(restoredBlockSource.capabilities.dataset.contractRef.fingerprint).toBe(blockDatasetBinding.contractFingerprint);
      expect(restoredSemanticSource).toMatchObject({
        kind: 'governed_semantic', sourceRevision: semanticSource.sourceRevision, lifecycle: 'certified', trustState: 'certified',
      });
      expect(restoredSemanticSource.capabilities.dataset.contractRef.fingerprint).toBe(semanticDatasetBinding.contractFingerprint);
      expect(restoredSemanticSource.capabilities.metricCapabilities).toEqual(expect.any(Object));
      expect(Object.keys(restoredSemanticSource.capabilities.metricCapabilities)).toHaveLength(5);
      expect(editDraft.reviewTasks).toEqual([]);

      const restoredRevenueTile = restoredOverview.layout.items.find((item: any) => item.title === 'Revenue');
      // A cold restore can intentionally leave a repair-only placeholder when
      // the catalog was unavailable. The runtime must not turn that stored
      // absence into executable authority merely because the catalog becomes
      // available again before the next run.
      const placeholderTask = {
        id: 'repair-order-lines-dataset',
        message: 'Rebind Order lines Dataset before running this restored App.',
        status: 'open',
        sourceId: blockSource.sourceId,
        pageId: restoredOverview.id,
        tileId: restoredRevenueTile.i,
      };
      const placeholderDraft = structuredClone(editDraft);
      placeholderDraft.sources = placeholderDraft.sources.map((source: any) => source.id === blockSource.sourceId
        ? {
          ...source,
          sourceRef: source.id,
          executionRef: undefined,
          sourcePath: undefined,
          lifecycle: 'unknown',
          trustState: 'review_required',
          reviewStatus: 'required',
          capabilities: undefined,
        }
        : source);
      placeholderDraft.reviewTasks = [...placeholderDraft.reviewTasks, placeholderTask];
      const placeholderStorage = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
      try {
        placeholderStorage.saveAppBuildDraft(placeholderDraft);
      } finally {
        placeholderStorage.close();
      }
      const placeholderRun = await request(coldBase, `/api/app-builds/${encodeURIComponent(editDraft.id)}/dashboards/${encodeURIComponent(restoredOverview.id)}/run`, 'POST', {
        tileId: restoredRevenueTile.i,
        variables: { region: ['CA'] },
      });
      expect(placeholderRun.status, placeholderRun.text).toBe(200);
      expect(placeholderRun.body.tiles).toEqual([expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('APP_BUILD_DATASET_SOURCE_REPAIR_REQUIRED'),
      })]);

      // Repair is explicit. The client may name the source, but its supplied
      // lifecycle/ref/capability values are ignored and replaced by the live
      // governed catalog record before the placeholder is allowed to run.
      const repairedSource = await request(coldBase, `/api/app-builds/${encodeURIComponent(editDraft.id)}`, 'PATCH', {
        expectedRevision: placeholderDraft.revision,
        operations: [
          {
            type: 'upsert_source',
            source: {
              id: blockSource.sourceId,
              kind: 'governed_semantic',
              sourceRef: 'browser-forged-source-ref',
              sourceRevision: 'browser-forged-revision',
              sourceFingerprint: 'browser-forged-revision',
              lifecycle: 'certified',
              trustState: 'certified',
              reviewStatus: 'not_required',
              capabilities: { dataset: { contractRef: { fingerprint: 'browser-forged-contract' } } },
            },
          },
          // This is the same bounded operation shape used by Studio's Resolve
          // action: source authority is server-canonicalized and the exact
          // existing tile receives only derived display/review metadata. The
          // field query, Dataset binding, filters, and layout remain pinned.
          {
            type: 'update_tile',
            pageId: restoredOverview.id,
            tileId: restoredRevenueTile.i,
            patch: {
              sourceClass: 'certified_block',
              trustState: 'certified',
              reviewStatus: 'certified',
              review: { status: 'not_required', sourceFingerprint: blockSource.sourceRevision },
            },
          },
          { type: 'remove_review_task', taskId: placeholderTask.id },
        ],
      });
      expect(repairedSource.status, repairedSource.text).toBe(200);
      editDraft = repairedSource.body.draft;
      const repairedBlockSource = editDraft.sources.find((source: any) => source.id === blockSource.sourceId);
      expect(repairedBlockSource).toMatchObject({
        kind: 'block',
        sourceRef: blockSource.executionRef,
        sourceRevision: blockSource.sourceRevision,
        lifecycle: 'certified',
        trustState: 'certified',
        reviewStatus: 'not_required',
      });
      expect(repairedBlockSource.capabilities.dataset.contractRef.fingerprint).toBe(blockDatasetBinding.contractFingerprint);
      expect(editDraft.reviewTasks.some((task: any) => task.id === placeholderTask.id)).toBe(false);
      const repairedOverview = editDraft.pages.find((candidate: any) => candidate.id === restoredOverview.id);
      expect(repairedOverview?.datasets).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sourceId: blockSource.sourceId,
          sourceRevision: blockSource.sourceRevision,
          contractFingerprint: blockDatasetBinding.contractFingerprint,
        }),
      ]));
      expect(repairedOverview?.filters).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'region' })]));
      expect(repairedOverview?.layout.items.find((item: any) => item.i === restoredRevenueTile.i)).toMatchObject({
        sourceId: blockSource.sourceId,
        sourceRevision: blockSource.sourceRevision,
        query: restoredRevenueTile.query,
        sourceClass: 'certified_block',
        trustState: 'certified',
        reviewStatus: 'certified',
        review: { status: 'not_required', sourceFingerprint: blockSource.sourceRevision },
      });

      const restoredEditPatch = await request(coldBase, `/api/app-builds/${encodeURIComponent(editDraft.id)}`, 'PATCH', {
        expectedRevision: editDraft.revision,
        expectedProposalHash: editDraft.proposalHash,
        operations: [{
          type: 'update_tile',
          pageId: restoredOverview.id,
          tileId: restoredRevenueTile.i,
          patch: { title: 'Revenue (restored)' },
        }],
      });
      expect(restoredEditPatch.status, restoredEditPatch.text).toBe(200);
      editDraft = restoredEditPatch.body.draft;

      const restoredOverviewRun = await request(coldBase, `/api/app-builds/${encodeURIComponent(editDraft.id)}/dashboards/${encodeURIComponent(restoredOverview.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        fullRun: true,
      });
      expect(restoredOverviewRun.status, restoredOverviewRun.text).toBe(200);
      expect(restoredOverviewRun.body.tiles).toHaveLength(8);
      expect(findTile(restoredOverviewRun.body.tiles, 'Revenue (restored)').result.rows).toEqual([{ revenue: 60 }]);
      const restoredSemanticRun = await request(coldBase, `/api/app-builds/${encodeURIComponent(editDraft.id)}/dashboards/${encodeURIComponent(restoredSemanticPage.id)}/run`, 'POST', {
        variables: { region: ['CA'] },
        fullRun: true,
      });
      expect(restoredSemanticRun.status, restoredSemanticRun.text).toBe(200);
      expect(restoredSemanticRun.body.tiles).toEqual([
        expect.objectContaining({ status: 'ok', title: 'Semantic commerce totals', trustState: 'certified' }),
      ]);
      for (const run of [restoredOverviewRun, restoredSemanticRun]) {
        const pageId = run === restoredOverviewRun ? restoredOverview.id : restoredSemanticPage.id;
        const attached = await request(coldBase, `/api/app-builds/${encodeURIComponent(editDraft.id)}`, 'PATCH', {
          expectedRevision: editDraft.revision,
          expectedProposalHash: editDraft.proposalHash,
          operations: [{
            type: 'set_preview_receipt',
            receipt: {
              id: run.body.runId,
              pageId,
              revision: editDraft.revision,
              snapshotId: run.body.snapshotId,
              filterFingerprint: run.body.filterFingerprint,
              resultFingerprint: run.body.resultFingerprint,
              createdAt: new Date().toISOString(),
            },
          }],
        });
        expect(attached.status, attached.text).toBe(200);
        editDraft = attached.body.draft;
      }
      const restoredPreflight = await request(coldBase, `/api/app-builds/${encodeURIComponent(editDraft.id)}/preflight`, 'POST', {
        expectedRevision: editDraft.revision,
        proposalHash: editDraft.proposalHash,
      });
      expect(restoredPreflight.status, restoredPreflight.text).toBe(200);
      expect(restoredPreflight.body.draft).toMatchObject({ state: 'preflight_ready' });

      // The current source is rechecked over all rows before field execution.
      // A duplicate key after publication must not inherit the earlier local
      // proof or a cached preview simply because the Git declarations match.
      await executor.executePositional(
        "INSERT INTO order_lines VALUES ('OL-001', 'O-999', 'C-999', 'US', '2026-03-31', 1, 0, 1)",
        [],
        connection,
      );
      const duplicateProbe = await executor.executePositional(
        "SELECT COUNT(*) AS duplicate_rows FROM order_lines WHERE order_line_id = 'OL-001'",
        [],
        connection,
      );
      expect(duplicateProbe.rows).toEqual([{ duplicate_rows: 2 }]);
      // Force the active server connection to reopen before its next run. This
      // models a committed warehouse update from another session and proves a
      // stale in-process DuckDB handle cannot preserve the earlier proof.
      await executor.disconnect();
      const drifted = await request(coldBase, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        tileId: findTile(firstRun.body.tiles, 'Revenue').tileId,
        variables: { region: ['CA'] },
      });
      expect(drifted.status, drifted.text).toBe(200);
      expect(drifted.body.tiles).toEqual([expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('does not satisfy its declared grain'),
      })]);

      // A clean declaration and unchanged target do not hide a null key
      // either. Remove the duplicate, add one null key, and prove the next
      // live full-source check records the distinct failure reason.
      await executor.executePositional("DELETE FROM order_lines WHERE order_id = 'O-999'", [], connection);
      await executor.executePositional(
        "INSERT INTO order_lines VALUES (NULL, 'O-998', 'C-998', 'US', '2026-03-30', 1, 0, 1)",
        [],
        connection,
      );
      await executor.disconnect();
      const nullKeyDrifted = await request(coldBase, `/api/apps/${encodeURIComponent(draft.appId)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        tileId: findTile(firstRun.body.tiles, 'Revenue').tileId,
        variables: { region: ['CA'] },
      });
      expect(nullKeyDrifted.status, nullKeyDrifted.text).toBe(200);
      expect(nullKeyDrifted.body.tiles).toEqual([expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('1 null-key rows'),
      })]);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 180_000);

  duckDbIt('M4-CACHE-01 M4-CACHE-02 delivers only complete identical Dataset results from an opt-in local cache across restart, and Refresh stays live', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-cache-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    let executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const configPath = join(projectRoot, 'dql.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, any>;
      config.apps = { ...config.apps, datasetResultCache: { enabled: true, ttlSeconds: 300 } };
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });

      const start = async () => {
        const port = await startLocalServer({
          rootDir: projectRoot,
          projectRoot,
          executor,
          connection,
          preferredPort: 0,
          captureServer: (created) => { server = created; },
        });
        return `http://127.0.0.1:${port}`;
      };
      const stop = async () => {
        const active = server;
        server = undefined;
        await new Promise<void>((done) => active ? active.close(() => done()) : done());
        await executor.disconnect();
      };

      let base = await start();
      const liveExecutor = vi.spyOn(executor, 'executeQuery');
      const created = await request(base, '/api/app-builds', 'POST', {
        name: 'Commerce Dataset cache App',
        goal: 'Show a complete governed revenue result from a local cache only when it is identical.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const candidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      expect(candidates.status, candidates.text).toBe(200);
      const source = candidates.body.items.find((item: any) => item.kind === 'block' && item.title === 'Order lines Dataset');
      expect(source).toMatchObject({ lifecycle: 'certified', trust: 'certified' });
      const composed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [blockSelection(source.sourceId, 'Revenue', 'kpi', {
          dimensions: [], measures: [{ measure: 'revenue' }],
        })],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const page = draft.pages.find((candidate: any) => candidate.id === 'overview');
      expect(page).toBeTruthy();

      const first = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', { fullRun: true });
      expect(first.status, first.text).toBe(200);
      const firstTile = findTile(first.body.tiles, 'Revenue');
      expect(firstTile.status, firstTile.error).toBe('ok');
      expect(firstTile.result).toMatchObject({ rows: [{ revenue: 130 }] });
      expect(firstTile.dataset?.cacheDelivery).toBeUndefined();
      expect(firstTile.artifact?.sql).toContain('WITH ds AS');
      const executedSql = firstTile.artifact.sql as string;
      const tileExecutionCount = () => liveExecutor.mock.calls.filter(([sql]) => sql === executedSql).length;
      expect(tileExecutionCount()).toBe(1);

      const second = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', { fullRun: true });
      expect(second.status, second.text).toBe(200);
      const cachedTile = findTile(second.body.tiles, 'Revenue');
      expect(cachedTile).toMatchObject({
        status: 'ok', result: { rows: [{ revenue: 130 }] },
        dataset: { cacheDelivery: { kind: 'dataset_cache_delivery', originalReceiptId: first.body.runId } },
      });
      expect(cachedTile.artifact?.sql).toBeUndefined();
      expect(cachedTile.dataset?.executionProvenance).toBeUndefined();
      expect(tileExecutionCount()).toBe(1);

      const cachedReceipt = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{
          type: 'set_preview_receipt',
          receipt: {
            id: second.body.runId,
            pageId: page.id,
            revision: draft.revision,
            snapshotId: second.body.snapshotId,
            filterFingerprint: second.body.filterFingerprint,
            resultFingerprint: second.body.resultFingerprint,
            createdAt: new Date().toISOString(),
          },
        }],
      });
      expect(cachedReceipt.status, cachedReceipt.text).toBe(400);
      expect(cachedReceipt.body.error).toContain('current source/target binding receipt');

      const refreshed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', { fullRun: true, refresh: true });
      expect(refreshed.status, refreshed.text).toBe(200);
      const refreshedTile = findTile(refreshed.body.tiles, 'Revenue');
      expect(refreshedTile.dataset?.cacheDelivery).toBeUndefined();
      expect(refreshedTile.artifact?.sql).toContain('WITH ds AS');
      expect(tileExecutionCount()).toBe(2);
      expect(existsSync(join(projectRoot, '.dql', 'local', 'dataset-results.sqlite'))).toBe(true);

      liveExecutor.mockRestore();
      await stop();
      executor = new QueryExecutor();
      base = await start();
      const restartedExecutor = vi.spyOn(executor, 'executeQuery');
      const afterRestart = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', { fullRun: true });
      expect(afterRestart.status, afterRestart.text).toBe(200);
      const restartedTile = findTile(afterRestart.body.tiles, 'Revenue');
      expect(restartedTile).toMatchObject({
        status: 'ok', result: { rows: [{ revenue: 130 }] },
        // Refresh writes the current live run as the cache authority, so a
        // restart must serve cached B rather than accidentally revive A.
        dataset: { cacheDelivery: { kind: 'dataset_cache_delivery', originalReceiptId: refreshed.body.runId } },
      });
      expect(restartedExecutor.mock.calls.filter(([sql]) => sql === executedSql)).toHaveLength(0);
      restartedExecutor.mockRestore();
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);

  duckDbIt('M4-PROM-01 M4-REPL-01 saves a settled static Dataset tile, rejects stale replacement guards, and atomically replaces it after same-scope equivalence', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-replace-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const created = await request(base, '/api/app-builds', 'POST', {
        name: 'Commerce Dataset replacement App',
        goal: 'Replace a proved static governed Dataset tile with its review draft.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const candidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      expect(candidates.status, candidates.text).toBe(200);
      const source = candidates.body.items.find((item: any) => item.kind === 'block' && item.title === 'Order lines Dataset');
      expect(source).toMatchObject({ lifecycle: 'certified', trust: 'certified' });
      const composed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [blockSelection(source.sourceId, 'Revenue', 'kpi', {
          dimensions: [], measures: [{ measure: 'revenue' }],
        })],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const page = draft.pages.find((candidate: any) => candidate.id === 'overview');
      const revenueTile = page.layout.items.find((item: any) => item.title === 'Revenue');
      expect(revenueTile?.query).toMatchObject({ dimensions: [], measures: [{ measure: 'revenue' }] });

      const run = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', { fullRun: true });
      expect(run.status, run.text).toBe(200);
      expect(findTile(run.body.tiles, 'Revenue')).toMatchObject({ status: 'ok', result: { rows: [{ revenue: 130 }] } });

      const saved = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/tiles/${encodeURIComponent(revenueTile.i)}/save-as-block`, 'POST', {
        runId: run.body.runId,
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
      });
      expect(saved.status, saved.text).toBe(201);
      expect(saved.body).toMatchObject({ ok: true, status: 'draft', replacementEligible: true, path: expect.stringContaining('/_drafts/') });
      expect(existsSync(join(projectRoot, saved.body.path))).toBe(true);
      expect(readFileSync(join(projectRoot, saved.body.path), 'utf8')).toContain('dataset_tile_provenance');

      const stale = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/tiles/${encodeURIComponent(revenueTile.i)}/replace-with-block`, 'POST', {
        runId: run.body.runId,
        expectedRevision: draft.revision + 1,
        expectedProposalHash: draft.proposalHash,
        blockPath: saved.body.path,
        enableReviewRequired: true,
      });
      expect(stale.status, stale.text).toBe(409);
      expect(stale.body).toMatchObject({ ok: false, code: 'APP_BUILD_REVISION_CONFLICT' });

      const replaced = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/tiles/${encodeURIComponent(revenueTile.i)}/replace-with-block`, 'POST', {
        runId: run.body.runId,
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        blockPath: saved.body.path,
        enableReviewRequired: true,
      });
      expect(replaced.status, replaced.text).toBe(200);
      expect(replaced.body).toMatchObject({ ok: true, blockPath: saved.body.path, equivalenceProofFingerprint: expect.any(String) });
      draft = replaced.body.draft;
      const replacementPage = draft.pages.find((candidate: any) => candidate.id === page.id);
      const replacementTile = replacementPage.layout.items.find((item: any) => item.i === revenueTile.i);
      expect(replacementTile).toMatchObject({
        block: { ref: saved.body.path }, sourceClass: 'exploratory_analysis', trustState: 'review_required', reviewStatus: 'review_required',
      });
      expect(replacementTile).not.toHaveProperty('query');
      expect(draft).not.toHaveProperty('sourcePolicy');
      expect(draft.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: source.sourceId, trustState: 'certified' }),
        expect.objectContaining({ kind: 'review_block', sourceRef: saved.body.path, trustState: 'review_required' }),
      ]));
      expect(draft.reviewTasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ pageId: page.id, tileId: revenueTile.i, status: 'open' }),
      ]));

      const persisted = new LocalAppStorage(defaultLocalAppsDbPath(projectRoot));
      try {
        expect(persisted.getAppBuildDraft(draft.id)).toMatchObject({
          revision: draft.revision,
          pages: [expect.objectContaining({ id: page.id })],
        });
      } finally {
        persisted.close();
      }

      // The new review block is still executable only under the explicit
      // review policy. This is a fresh App run, not a replay of the Dataset
      // equivalence rows, and keeps the original source tile provenance in
      // the saved review draft.
      const reviewRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', { fullRun: true });
      expect(reviewRun.status, reviewRun.text).toBe(200);
      expect(findTile(reviewRun.body.tiles, 'Revenue')).toMatchObject({
        status: 'ok', trustState: 'review_required', result: { rows: [{ revenue: 130 }] },
        artifact: { sourceKind: 'review_block', trustState: 'review_required' },
      });
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);

  duckDbIt('APP-067 runs typed Dataset MCP queries through the governed App runtime without creating App evidence', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-mcp-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;

      const listed = await request(base, '/api/app-datasets', 'GET');
      expect(listed.status, listed.text).toBe(200);
      const blockDataset = listed.body.datasets.find((dataset: any) => dataset.title === 'Order lines Dataset');
      expect(blockDataset).toMatchObject({
        sourceId: expect.any(String),
        lifecycle: 'certified',
        trust: 'certified',
        descriptor: expect.objectContaining({ kind: 'block' }),
      });

      const typedQuery = {
        dimensions: [],
        measures: [{ measure: 'revenue' }],
        filters: [{ field: 'region', op: 'eq', values: ['CA'] }],
      };
      const preview = await request(base, '/api/app-datasets/preview', 'POST', {
        sourceId: blockDataset.sourceId,
        query: typedQuery,
      });
      expect(preview.status, preview.text).toBe(200);
      expect(preview.body).toMatchObject({
        ok: true,
        scope: 'ephemeral_mcp_runtime',
        validation: { outcome: 'covered' },
      });

      const run = await request(base, '/api/app-datasets/run', 'POST', {
        sourceId: blockDataset.sourceId,
        query: typedQuery,
      });
      expect(run.status, run.text).toBe(200);
      expect(run.body).toMatchObject({
        ok: true,
        scope: 'ephemeral_mcp_runtime',
        partial: true,
        publicationEvidence: false,
        source: { sourceId: blockDataset.sourceId, trust: 'certified' },
        result: { rows: [{ revenue: 60 }] },
        receipt: {
          snapshotId: expect.any(String),
          queryFingerprint: expect.any(String),
          targetFingerprint: expect.any(String),
        },
      });
      expect(run.body).not.toHaveProperty('artifact');
      expect(run.body).not.toHaveProperty('story');
      expect(run.body).not.toHaveProperty('runId');

      const unknownField = await request(base, '/api/app-datasets/run', 'POST', {
        sourceId: blockDataset.sourceId,
        query: { dimensions: [{ field: 'not_approved' }], measures: [{ measure: 'revenue' }] },
      });
      expect(unknownField.status, unknownField.text).toBe(400);
      expect(unknownField.body.error).toContain('Dataset MCP query was refused');

      const rawSql = await request(base, '/api/app-datasets/run', 'POST', {
        sourceId: blockDataset.sourceId,
        query: typedQuery,
        sql: 'SELECT 1',
      });
      expect(rawSql.status, rawSql.text).toBe(400);
      expect(rawSql.body.error).toContain('accepts only sourceId, query, and optional parameters');
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);

  duckDbIt('M4-CONV-01 converts one exact native legacy semantic tile only after fresh same-scope equivalence', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-semantic-conversion-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const created = await request(base, '/api/app-builds', 'POST', {
        name: 'Legacy semantic conversion App',
        goal: 'Convert one governed legacy semantic KPI only after exact proof.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const candidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      expect(candidates.status, candidates.text).toBe(200);
      const source = candidates.body.items.find((item: any) => item.kind === 'semantic'
        && item.capabilities?.dataset?.kind === 'semantic');
      expect(source).toMatchObject({ lifecycle: 'certified', trust: 'certified' });
      const descriptor = source.capabilities.dataset;
      const metric = descriptor.fields.find((field: any) => field.kind === 'measure' && field.name === 'semantic_revenue');
      expect(metric).toMatchObject({ metricId: expect.any(String), semanticReference: expect.any(String) });
      const modelName = String(metric.semanticReference).split('.')[0];
      const metricName = String(metric.semanticReference).split('.').at(-1);
      const sourceOperation = {
        id: source.sourceId,
        kind: 'governed_semantic',
        sourceRef: source.executionRef,
        qualifiedIdentity: source.qualifiedIdentity,
        sourcePath: source.sourcePath,
        executionRef: source.executionRef,
        snapshotId: source.snapshotId,
        sourceRevision: source.sourceRevision,
        sourceFingerprint: source.sourceRevision,
        lifecycle: source.lifecycle,
        capabilities: source.capabilities,
        trustState: 'certified',
        reviewStatus: 'not_required',
      };
      const legacyTile = {
        i: 'legacy-semantic-revenue', x: 0, y: 0, w: 6, h: 4,
        title: 'Legacy semantic revenue',
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        viz: { type: 'kpi' },
        semantic: {
          id: 'legacy-semantic-revenue',
          provider: 'native',
          metrics: [metricName],
          semanticModelRefs: [modelName],
          qualifiedMetricIds: [metric.metricId],
          qualifiedModelIds: [descriptor.contractRef.id],
          definitionFingerprint: 'sha256:legacy-semantic-revenue',
          snapshotId: source.snapshotId,
        },
        sourceClass: 'governed_semantic',
        trustState: 'certified',
        reviewStatus: 'certified',
        review: { status: 'not_required', sourceFingerprint: source.sourceRevision },
      };
      const seeded = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [
          { type: 'upsert_source', source: sourceOperation },
          {
            type: 'upsert_page',
            page: {
              version: 3,
              id: 'overview',
              metadata: { title: 'Overview', domain: 'commerce', lifecycle: 'draft' },
              layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [legacyTile] },
            },
          },
        ],
      });
      expect(seeded.status, seeded.text).toBe(200);
      draft = seeded.body.draft;

      const preview = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/tiles/legacy-semantic-revenue/preview-semantic-conversion`, 'POST', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
      });
      expect(preview.status, preview.text).toBe(200);
      expect(preview.body).toMatchObject({
        ok: true,
        candidate: {
          sourceId: source.sourceId,
          sourceRevision: source.sourceRevision,
          query: { dimensions: [], measures: [{ measure: 'semantic_revenue' }] },
          provenance: { kind: 'semantic_tile_conversion_provenance', equivalenceProofFingerprint: expect.any(String) },
        },
      });
      const beforeAccept = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'GET');
      expect(beforeAccept.status, beforeAccept.text).toBe(200);
      expect(beforeAccept.body.draft.pages[0].layout.items[0]).toHaveProperty('semantic');
      expect(beforeAccept.body.draft.pages[0].layout.items[0]).not.toHaveProperty('query');

      // A stale browser proposal cannot write even when it still has a valid
      // server-issued proposal id. The old legacy payload remains untouched.
      const revised = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{ type: 'update_tile', pageId: 'overview', tileId: legacyTile.i, patch: { title: 'Legacy semantic revenue (reviewed)' } }],
      });
      expect(revised.status, revised.text).toBe(200);
      draft = revised.body.draft;
      const staleAccept = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/tiles/${encodeURIComponent(legacyTile.i)}/semantic-conversions/${encodeURIComponent(preview.body.proposalId)}/accept`, 'POST', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
      });
      expect(staleAccept.status, staleAccept.text).toBe(409);
      expect(staleAccept.body.code).toMatch(/PREVIEW_STALE/);

      const freshPreview = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/tiles/${encodeURIComponent(legacyTile.i)}/preview-semantic-conversion`, 'POST', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
      });
      expect(freshPreview.status, freshPreview.text).toBe(200);
      const accepted = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/tiles/${encodeURIComponent(legacyTile.i)}/semantic-conversions/${encodeURIComponent(freshPreview.body.proposalId)}/accept`, 'POST', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
      });
      expect(accepted.status, accepted.text).toBe(200);
      draft = accepted.body.draft;
      const converted = draft.pages.find((page: any) => page.id === 'overview').layout.items.find((item: any) => item.i === legacyTile.i);
      expect(converted).toMatchObject({
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        query: { dimensions: [], measures: [{ measure: 'semantic_revenue' }] },
        semanticTileConversionProvenance: {
          kind: 'semantic_tile_conversion_provenance',
          legacyPayload: expect.objectContaining({ semantic: expect.any(Object) }),
          equivalenceProofFingerprint: expect.any(String),
        },
      });
      expect(converted).not.toHaveProperty('semantic');
      expect(draft.pages.find((page: any) => page.id === 'overview').datasets).toEqual([
        expect.objectContaining({ sourceId: source.sourceId, sourceRevision: source.sourceRevision, contractFingerprint: descriptor.contractRef.fingerprint }),
      ]);
      const convertedRun = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', { fullRun: true });
      expect(convertedRun.status, convertedRun.text).toBe(200);
      expect(findTile(convertedRun.body.tiles, 'Legacy semantic revenue (reviewed)')).toMatchObject({
        status: 'ok', result: { rows: [expect.objectContaining({ semantic_revenue: 130 })] },
      });
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);

  duckDbIt('APP-065 keeps App Autopilot grounded in one fresh server-held preview and refuses stale, foreign, late, and restarted context', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-autopilot-preview-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = {
      driver: 'duckdb',
      filepath: databasePath,
      moduleSearchPaths: [connectorRoot],
    };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    let providerResponse = JSON.stringify({ action: 'explain', answer: 'The current CA revenue result is 60.' });
    let heldProvider: ReturnType<typeof deferred<string>> | undefined;
    let providerEntered: ReturnType<typeof deferred<void>> | undefined;
    let providerFailure: (Error & { httpStatus?: number }) | undefined;
    let providerCompletionFailure: (Error & { httpStatus?: number }) | undefined;
    let providerRejectAfterCompletion = false;
    const providerCalls: Array<Parameters<AgentProvider['generate']>[0]> = [];
    const provider: AgentProvider = {
      name: 'openai',
      available: async () => true,
      generate: async (messages, options) => {
        providerCalls.push(messages);
        options?.onProviderDispatch?.({
          provider: 'openai',
          operation: 'generate',
          attemptIndex: 1,
          envelope: { messages },
        });
        const failure = providerFailure;
        if (failure) {
          const completionFailure = providerCompletionFailure ?? failure;
          options?.onProviderDispatchComplete?.({
            provider: 'openai', operation: 'generate', attemptIndex: 1,
            outcome: 'error', settlement: 'transport',
            ...(completionFailure.httpStatus !== undefined ? { httpStatus: completionFailure.httpStatus } : {}),
            error: completionFailure,
          });
          if (providerRejectAfterCompletion) {
            options?.onProviderDispatchRejected?.({
              provider: 'openai', operation: 'generate', attemptIndex: 1,
              error: new Error('generic provider rejection after completion'),
            });
          }
          throw failure;
        }
        const held = heldProvider;
        if (held) {
          providerEntered?.resolve();
          const answer = await held.promise;
          options?.onProviderDispatchComplete?.({
            provider: 'openai', operation: 'generate', attemptIndex: 1,
            outcome: 'ok', settlement: 'transport', httpStatus: 200,
          });
          return answer;
        }
        options?.onProviderDispatchComplete?.({
          provider: 'openai', operation: 'generate', attemptIndex: 1,
          outcome: 'ok', settlement: 'transport', httpStatus: 200,
        });
        return providerResponse;
      },
    };
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [
        seedWarehouse,
        '--seed', join(projectRoot, 'seeds', 'seed.json'),
        '--connector-root', connectorRoot,
        '--out', databasePath,
      ], { stdio: 'pipe' });
      let port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (created) => { server = created; },
        appAutopilotProviderFactory: () => provider,
      });
      let base = `http://127.0.0.1:${port}`;
      const created = await request(base, '/api/app-builds', 'POST', {
        name: 'CA revenue App',
        goal: 'Explain current governed revenue for California.',
        domain: 'commerce',
        authoringMode: 'manual',
        sourcePolicy: 'governed_only',
        template: 'blank',
      });
      expect(created.status, created.text).toBe(201);
      let draft = created.body.draft;
      const candidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
      expect(candidates.status, candidates.text).toBe(200);
      const source = candidates.body.items.find((item: any) => item.kind === 'block' && item.title === 'Order lines Dataset');
      expect(source).toMatchObject({ lifecycle: 'certified', trust: 'certified' });
      const composed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        selections: [blockSelection(source.sourceId, 'CA revenue', 'table', {
          dimensions: [{ field: 'order_date', timeGrain: 'month' }],
          measures: [{ measure: 'revenue' }],
          filters: [{ field: 'region', op: 'eq', values: ['CA'] }],
        })],
      });
      expect(composed.status, composed.text).toBe(200);
      draft = composed.body.draft;
      const tileId = draft.pages.find((page: any) => page.id === 'overview').layout.items[0].i;
      const autopilot = (question: string, previewRunId?: string) => request(base, '/api/agent-runs', 'POST', {
        question,
        requestedMode: 'app',
        workspaceContext: {
          surface: 'app_autopilot',
          appBuildId: draft.id,
          pageId: 'overview',
          tileId,
          ...(previewRunId ? { previewRunId } : {}),
        },
      });

      // A right-side App Autopilot request remains in the universal App path
      // even before the canvas has a selected Dataset tile. It must not fall
      // through to the dedicated initial App generator or dispatch a provider.
      const autopilotWithoutTile = (question: string, previewRunId?: string) => request(base, '/api/agent-runs', 'POST', {
        question,
        requestedMode: 'app',
        workspaceContext: {
          surface: 'app_autopilot',
          appBuildId: draft.id,
          pageId: 'overview',
          ...(previewRunId ? { previewRunId } : {}),
        },
      });
      const missingTile = await autopilotWithoutTile('Show this as a bar chart.');
      expect(missingTile.status, missingTile.text).toBe(201);
      expect(missingTile.body.run).toMatchObject({
        route: 'app_build',
        status: 'blocked',
        trustState: 'blocked',
        answer: expect.stringContaining('APP_AUTOPILOT_DATASET_TILE_REQUIRED'),
        nextActions: [expect.objectContaining({ id: 'select-app-dataset-tile', label: 'Select a Dataset tile' })],
      });
      expect(missingTile.body.run.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'answer',
          payload: expect.objectContaining({
            kind: 'app_autopilot_tile_required',
            code: 'APP_AUTOPILOT_DATASET_TILE_REQUIRED',
            contextScope: `${draft.id}:overview:no-tile:no-preview`,
          }),
        }),
      ]));
      expect(missingTile.body.run.artifacts).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'app_proposal' }),
      ]));
      expect(missingTile.body.run.providerEgressReceipts ?? []).toHaveLength(0);
      expect(providerCalls).toHaveLength(0);

      // "Fix" on presentation wording is a bounded typed App change, not a
      // claim that the query failed. It reaches the same shared provider with
      // no browser preview evidence and still cannot mutate before Apply.
      providerResponse = JSON.stringify({ action: 'rename_tile', title: 'Revenue by Region' });
      const structuralWithoutPreview = await autopilot('Fix title to Revenue by Region.');
      expect(structuralWithoutPreview.status, structuralWithoutPreview.text).toBe(201);
      expect(structuralWithoutPreview.body.run).toMatchObject({ status: 'needs_review', trustState: 'review_required' });
      expect(structuralWithoutPreview.body.run.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'app_autopilot_change',
          payload: expect.objectContaining({
            intent: expect.objectContaining({ action: 'rename_tile', title: 'Revenue by Region' }),
          }),
        }),
      ]));
      expect(providerCalls).toHaveLength(1);
      const beforeStructuralApply = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'GET');
      expect(beforeStructuralApply.status, beforeStructuralApply.text).toBe(200);
      expect(beforeStructuralApply.body.draft.pages.find((page: any) => page.id === 'overview').layout.items[0].title).toBe('CA revenue');

      providerResponse = JSON.stringify({ action: 'change_visualization', visualization: 'bar' });
      const barChartWithoutPreview = await autopilot('Show this as a bar chart.');
      expect(barChartWithoutPreview.status, barChartWithoutPreview.text).toBe(201);
      expect(barChartWithoutPreview.body.run).toMatchObject({ status: 'needs_review', trustState: 'review_required' });
      expect(barChartWithoutPreview.body.run.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'app_autopilot_change',
          payload: expect.objectContaining({ intent: expect.objectContaining({ action: 'change_visualization', visualization: 'bar' }) }),
        }),
      ]));
      expect(providerCalls).toHaveLength(2);

      // A provider completion that drops one explicit compound presentation
      // clause must become visible recovery guidance, never a misleading
      // one-field review proposal.
      providerResponse = JSON.stringify({ action: 'change_visualization', visualization: 'bar' });
      const partialCompound = await autopilot('Change the title to Revenue by Region and show this as a bar chart.');
      expect(partialCompound.status, partialCompound.text).toBe(201);
      expect(partialCompound.body.run).toMatchObject({
        status: 'blocked',
        trustState: 'blocked',
        answer: expect.stringContaining('APP_AUTOPILOT_REQUEST_PARTIAL'),
      });
      expect(partialCompound.body.run.artifacts).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'app_autopilot_change' }),
      ]));
      expect(partialCompound.body.run.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'answer',
          payload: expect.objectContaining({
            kind: 'app_autopilot_blocked',
            code: 'APP_AUTOPILOT_REQUEST_PARTIAL',
            contextScope: `${draft.id}:overview:${tileId}:no-preview`,
          }),
        }),
      ]));
      expect(providerCalls).toHaveLength(3);
      const afterPartial = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'GET');
      expect(afterPartial.status, afterPartial.text).toBe(200);
      expect(afterPartial.body.draft.pages.find((page: any) => page.id === 'overview').layout.items[0]).toMatchObject({ title: 'CA revenue' });

      // Both compatible presentation fields compile to one immutable
      // update_tile proposal. The draft still remains unchanged before Apply.
      providerResponse = JSON.stringify({ action: 'change_visualization', visualization: 'bar', title: 'Revenue by Region' });
      const compound = await autopilot('Change the title to Revenue by Region and show this as a bar chart.');
      expect(compound.status, compound.text).toBe(201);
      expect(compound.body.run).toMatchObject({ status: 'needs_review', trustState: 'review_required' });
      expect(compound.body.run.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'app_autopilot_change',
          payload: expect.objectContaining({
            intent: expect.objectContaining({ action: 'change_visualization', visualization: 'bar', title: 'Revenue by Region' }),
            operations: [{
              type: 'update_tile', pageId: 'overview', tileId,
              patch: { title: 'Revenue by Region', viz: { type: 'bar' } },
            }],
          }),
        }),
      ]));
      expect(providerCalls).toHaveLength(4);
      const beforeCompoundApply = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'GET');
      expect(beforeCompoundApply.status, beforeCompoundApply.text).toBe(200);
      expect(beforeCompoundApply.body.draft.pages.find((page: any) => page.id === 'overview').layout.items[0]).toMatchObject({ title: 'CA revenue' });

      for (const question of [
        'Fix a query.',
        'Repair this metric.',
        'Repair the failed query.',
        'What is the smallest governed repair needed before this selected tile can answer its intended question?',
      ]) {
        const failedRepairWithoutPreview = await autopilot(question);
        expect(failedRepairWithoutPreview.status, failedRepairWithoutPreview.text).toBe(201);
        expect(failedRepairWithoutPreview.body.run.status).toBe('blocked');
        expect(failedRepairWithoutPreview.body.run.artifacts).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'answer',
            payload: expect.objectContaining({ reasonCode: 'APP_AUTOPILOT_PREVIEW_FAILED_TILE_REQUIRED' }),
          }),
        ]));
        expect(providerCalls).toHaveLength(4);
      }

      const mixedResultWithoutPreview = await autopilot('Fix title and explain the current result.');
      expect(mixedResultWithoutPreview.status, mixedResultWithoutPreview.text).toBe(201);
      expect(mixedResultWithoutPreview.body.run.status).toBe('blocked');
      expect(providerCalls).toHaveLength(4);

      const mixedShowExplainWithoutPreview = await autopilot('Show this chart and explain the total.');
      expect(mixedShowExplainWithoutPreview.status, mixedShowExplainWithoutPreview.text).toBe(201);
      expect(mixedShowExplainWithoutPreview.body.run.status).toBe('blocked');
      expect(providerCalls).toHaveLength(4);

      const noPreview = await autopilot('Explain the selected result.');
      expect(noPreview.status, noPreview.text).toBe(201);
      expect(noPreview.body.run).toMatchObject({ status: 'blocked', trustState: 'blocked', answer: expect.stringContaining('Run preview') });
      expect(providerCalls).toHaveLength(4);

      const preview = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
        fullRun: true,
        runScope: 'app-autopilot-preview',
      });
      expect(preview.status, preview.text).toBe(200);
      const monthlyCaPreview = findTile(preview.body.tiles, 'CA revenue');
      expect(monthlyCaPreview).toMatchObject({ status: 'ok' });
      expect(monthlyCaPreview.result.rows).toEqual([
        { order_date_month: '2026-02-01T00:00:00.000Z', revenue: 30 },
        { order_date_month: '2026-03-01T00:00:00.000Z', revenue: 30 },
      ]);

      // The same structural intent stays a provider-backed typed proposal on
      // a successful preview. Layout/chart wording must not silently change it
      // into a failed-query repair.
      providerResponse = JSON.stringify({ action: 'rename_tile', title: 'Revenue by Region (chart layout)' });
      const structuralWithPreview = await autopilot('Fix the title and chart layout to Revenue by Region.', preview.body.runId);
      expect(structuralWithPreview.status, structuralWithPreview.text).toBe(201);
      expect(structuralWithPreview.body.run).toMatchObject({ status: 'needs_review', trustState: 'review_required' });
      expect(providerCalls).toHaveLength(5);
      const failedRepairAgainstSuccessfulPreview = await autopilot('Repair the failed query.', preview.body.runId);
      expect(failedRepairAgainstSuccessfulPreview.status, failedRepairAgainstSuccessfulPreview.text).toBe(201);
      expect(failedRepairAgainstSuccessfulPreview.body.run.status).toBe('blocked');
      expect(failedRepairAgainstSuccessfulPreview.body.run.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'answer',
          payload: expect.objectContaining({
            kind: 'app_autopilot_repair_not_needed',
            reasonCode: 'APP_AUTOPILOT_PREVIEW_FAILED_TILE_HEALTHY',
            refusalDetails: { message: expect.stringContaining('no failed Dataset diagnostic to repair') },
          }),
        }),
      ]));
      expect(failedRepairAgainstSuccessfulPreview.body.run.nextActions ?? []).toEqual([]);
      expect(providerCalls).toHaveLength(5);

      // The visible App Studio shortcut has the same server-side pre-provider
      // guard: a healthy selected Dataset tile is a clear no-op, not a
      // provider-backed repair followed by a misleading preview loop.
      const healthyRepairShortcut = await autopilot(
        'What is the smallest governed repair needed before this selected tile can answer its intended question?',
        preview.body.runId,
      );
      expect(healthyRepairShortcut.status, healthyRepairShortcut.text).toBe(201);
      expect(healthyRepairShortcut.body.run.status).toBe('blocked');
      expect(healthyRepairShortcut.body.run.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'answer',
          payload: expect.objectContaining({
            kind: 'app_autopilot_repair_not_needed',
            reasonCode: 'APP_AUTOPILOT_PREVIEW_FAILED_TILE_HEALTHY',
            refusalDetails: { message: expect.stringContaining('no failed Dataset diagnostic to repair') },
          }),
        }),
      ]));
      expect(healthyRepairShortcut.body.run.nextActions ?? []).toEqual([]);
      expect(providerCalls).toHaveLength(5);

      // A direct value question must load the current opaque preview before
      // provider dispatch. The browser wording is intentionally the same
      // shape as the CA explanation acceptance flow.
      // The provider response is deliberately generic. The assertions below
      // prove native grouped facts reached its server-built prompt; this test
      // does not manufacture a numeric answer in the mock.
      providerResponse = JSON.stringify({ action: 'explain', answer: 'The current governed chart context was used.' });
      const exactFilteredExplanation = await autopilot(
        'What revenue does this filtered chart show, and how is it distributed across months?',
        preview.body.runId,
      );
      expect(exactFilteredExplanation.status, exactFilteredExplanation.text).toBe(201);
      expect(exactFilteredExplanation.body.run).toMatchObject({ status: 'needs_review', answer: 'The current governed chart context was used.' });
      expect(providerCalls).toHaveLength(6);
      const providerPrompt = JSON.stringify(providerCalls[5]);
      expect(providerPrompt).toContain('fresh_server_held_result');
      expect(providerPrompt).toContain('order_date_month = 2026-02-01T00:00:00.000Z: revenue = 30');
      expect(providerPrompt).toContain('order_date_month = 2026-03-01T00:00:00.000Z: revenue = 30');
      expect(providerPrompt).toContain('Safe additive subtotal across these displayed groups: revenue = 60.');
      expect(providerPrompt).not.toContain('"rows"');
      expect(JSON.stringify(exactFilteredExplanation.body.run.providerEgressReceipts ?? [])).not.toContain('result_rows');

      // An indirect question is deliberately outside the wording classifier.
      // The opaque preview ID still hydrates bounded result facts, so an
      // explanation cannot fall into a provider-backed preview-required loop.
      const indirectFilteredExplanation = await autopilot('Walk me through this filtered chart.', preview.body.runId);
      expect(indirectFilteredExplanation.status, indirectFilteredExplanation.text).toBe(201);
      expect(indirectFilteredExplanation.body.run).toMatchObject({ status: 'needs_review', answer: 'The current governed chart context was used.' });
      expect(providerCalls).toHaveLength(7);
      expect(JSON.stringify(providerCalls[6])).toContain('fresh_server_held_result');

      const foreign = await autopilot('Explain the selected result.', 'app_run_foreign');
      expect(foreign.status, foreign.text).toBe(201);
      expect(foreign.body.run.status).toBe('blocked');
      expect(providerCalls).toHaveLength(7);

      const replacementPreview = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
        fullRun: true,
        runScope: 'app-autopilot-preview',
      });
      expect(replacementPreview.status, replacementPreview.text).toBe(200);
      const stale = await autopilot('Explain the selected result.', preview.body.runId);
      expect(stale.status, stale.text).toBe(201);
      expect(stale.body.run.status).toBe('blocked');
      expect(providerCalls).toHaveLength(7);
      const staleRepairShortcut = await autopilot(
        'What is the smallest governed repair needed before this selected tile can answer its intended question?',
        preview.body.runId,
      );
      expect(staleRepairShortcut.status, staleRepairShortcut.text).toBe(201);
      expect(staleRepairShortcut.body.run.status).toBe('blocked');
      expect(staleRepairShortcut.body.run.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'answer',
          payload: expect.objectContaining({ reasonCode: expect.stringMatching(/^APP_AUTOPILOT_PREVIEW_(?:EXPIRED|SUPERSEDED)$/) }),
        }),
      ]));
      expect(staleRepairShortcut.body.run.nextActions).toEqual([{ id: 'run-app-preview', label: 'Run preview' }]);
      expect(providerCalls).toHaveLength(7);

      // Stale optional evidence never blocks a presentation-only edit. Its
      // result facts are withheld, but the normal typed App-change path stays
      // available and cannot mutate the draft before the separate Apply flow.
      providerResponse = JSON.stringify({ action: 'change_visualization', visualization: 'bar' });
      const structuralWithStaleOptionalPreview = await autopilot('Show this as a bar chart.', preview.body.runId);
      expect(structuralWithStaleOptionalPreview.status, structuralWithStaleOptionalPreview.text).toBe(201);
      expect(structuralWithStaleOptionalPreview.body.run).toMatchObject({ status: 'needs_review', trustState: 'review_required' });
      expect(providerCalls).toHaveLength(8);

      // A held provider completion against an unchanged settled preview is
      // accepted. This exercises the same before/after server-held proof that
      // protects the provider await in the browser flow.
      heldProvider = deferred<string>();
      providerEntered = deferred<void>();
      const settledAnswer = autopilot('Walk me through this filtered chart.', replacementPreview.body.runId);
      await providerEntered.promise;
      heldProvider.resolve(JSON.stringify({ action: 'explain', answer: 'The unchanged CA result is still 60.' }));
      heldProvider = undefined;
      const settled = await settledAnswer;
      expect(settled.status, settled.text).toBe(201);
      expect(settled.body.run).toMatchObject({ status: 'needs_review', answer: 'The unchanged CA result is still 60.' });
      expect(providerCalls).toHaveLength(9);

      // A genuinely newer preview during the same held provider completion is
      // still rejected before the answer becomes visible.
      heldProvider = deferred<string>();
      providerEntered = deferred<void>();
      const lateAnswer = autopilot('Walk me through this filtered chart.', replacementPreview.body.runId);
      await providerEntered.promise;
      const newestPreview = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
        fullRun: true,
        runScope: 'app-autopilot-preview',
      });
      expect(newestPreview.status, newestPreview.text).toBe(200);
      heldProvider.resolve(JSON.stringify({ action: 'explain', answer: 'This completion is now stale.' }));
      heldProvider = undefined;
      const late = await lateAnswer;
      expect(late.status, late.text).toBe(201);
      expect(late.body.run).toMatchObject({ status: 'blocked', trustState: 'blocked' });
      expect(late.body.run.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'answer',
          payload: expect.objectContaining({ reasonCode: 'APP_AUTOPILOT_PREVIEW_SUPERSEDED' }),
        }),
      ]));
      expect(providerCalls).toHaveLength(10);

      const drifted = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        operations: [{ type: 'update_tile', pageId: 'overview', tileId, patch: { title: 'CA revenue (revised)' } }],
      });
      expect(drifted.status, drifted.text).toBe(200);
      draft = drifted.body.draft;
      const draftDrift = await autopilot('Explain the selected result.', newestPreview.body.runId);
      expect(draftDrift.status, draftDrift.text).toBe(201);
      expect(draftDrift.body.run.status).toBe('blocked');
      expect(providerCalls).toHaveLength(10);

      // The repair lane receives only a server-held failed-tile diagnostic.
      // It may prepare a normal typed App proposal, but cannot mutate the
      // draft before the existing explicit review-and-Apply flow.
      await executor.executePositional('DROP TABLE order_lines', [], connection);
      await expect(executor.executePositional('SELECT * FROM order_lines LIMIT 1', [], connection)).rejects.toThrow();
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      server = undefined;
      await executor.disconnect();
      port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (createdServer) => { server = createdServer; },
        appAutopilotProviderFactory: () => provider,
      });
      base = `http://127.0.0.1:${port}`;
      const failedPreview = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', {
        fullRun: true,
        runScope: 'app-autopilot-repair',
        refresh: true,
      });
      expect(failedPreview.status, failedPreview.text).toBe(200);
      expect(findTile(failedPreview.body.tiles, 'CA revenue (revised)')).toMatchObject({ status: 'error' });

      // A provider transport failure keeps the shared safe classification in
      // both the physical trace and the App artifact. Raw adapter diagnostics
      // never become durable App context, a prompt, or a visible answer.
      providerFailure = new Error('generic App provider wrapper');
      providerCompletionFailure = Object.assign(
        new Error('openai: 429 opaque-provider-marker-never-persist'),
        { code: 'HTTP_429', httpStatus: 429 },
      );
      // Some adapters report a generic rejection after their richer transport
      // completion. The shared trace deduplicates this physical send; the App
      // artifact must retain the same first, classified failure.
      providerRejectAfterCompletion = true;
      const rateLimitedRepair = await autopilot('Repair the failed tile.', failedPreview.body.runId);
      expect(rateLimitedRepair.status, rateLimitedRepair.text).toBe(201);
      expect(rateLimitedRepair.body.run).toMatchObject({
        status: 'blocked',
        trustState: 'blocked',
        answer: expect.stringContaining('APP_AUTOPILOT_PROVIDER_FAILED'),
      });
      const rateLimitedArtifact = rateLimitedRepair.body.run.artifacts.find((artifact: any) => artifact.kind === 'answer');
      expect(rateLimitedArtifact).toMatchObject({
        title: 'App Autopilot provider failure',
        payload: {
          kind: 'app_autopilot_blocked',
          code: 'APP_AUTOPILOT_PROVIDER_FAILED',
          providerFailure: {
            version: 1,
            transportKind: 'openai',
            normalizedCode: 'provider_rate_limited',
            statusClass: '4xx',
            phase: 'generation',
            cause: 'rate_limited',
            retryable: true,
            safeAction: 'wait_and_retry',
            messageFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            providerFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
        },
      });
      expect(JSON.stringify(rateLimitedRepair.body.run)).not.toContain('opaque-provider-marker-never-persist');
      const rateLimitedTraceId = rateLimitedRepair.body.run.traceReference?.traceId;
      expect(rateLimitedTraceId).toMatch(/^[a-f0-9]{32}$/);
      const rateLimitedTrace = await request(base, `/api/ask-traces/${rateLimitedTraceId}`, 'GET');
      expect(rateLimitedTrace.status, rateLimitedTrace.text).toBe(200);
      expect(rateLimitedTrace.body.spans).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'provider.attempt',
          reasonCode: 'provider_failure',
          payload: expect.objectContaining({
            kind: 'provider',
            attempt: expect.objectContaining({
              phase: 'generation',
              admission: 'admitted',
              httpStatusClass: '4xx',
              cause: 'rate_limited',
              retryable: true,
              safeAction: 'wait_and_retry',
            }),
          }),
        }),
      ]));
      expect(providerCalls).toHaveLength(11);

      // An unclassified provider failure remains honestly unknown instead of
      // being relabeled as an authentication, parse, or App contract error.
      providerFailure = Object.assign(
        new Error('opaque-provider-marker-never-persist-unknown'),
        { code: 'APP_PROVIDER_UNCLASSIFIED' },
      );
      providerCompletionFailure = undefined;
      providerRejectAfterCompletion = false;
      const unknownProviderRepair = await autopilot('Repair the failed tile.', failedPreview.body.runId);
      expect(unknownProviderRepair.status, unknownProviderRepair.text).toBe(201);
      const unknownArtifact = unknownProviderRepair.body.run.artifacts.find((artifact: any) => artifact.kind === 'answer');
      expect(unknownArtifact).toMatchObject({
        payload: {
          code: 'APP_AUTOPILOT_PROVIDER_FAILED',
          providerFailure: {
            normalizedCode: 'provider_unknown',
            cause: 'unknown',
            retryable: false,
            safeAction: 'inspect_run',
            messageFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          },
        },
      });
      expect(unknownArtifact.payload.providerFailure).not.toHaveProperty('statusClass');
      expect(JSON.stringify(unknownProviderRepair.body.run)).not.toContain('opaque-provider-marker-never-persist-unknown');
      expect(providerCalls).toHaveLength(12);

      // Malformed provider output happens after a successful transport. It
      // remains the existing typed App interpretation error, never a provider
      // failure artifact with a fabricated transport diagnosis.
      providerFailure = undefined;
      providerCompletionFailure = undefined;
      providerResponse = 'not valid App Autopilot JSON';
      const invalidProviderOutput = await autopilot('Show this as a bar chart.');
      expect(invalidProviderOutput.status, invalidProviderOutput.text).toBe(201);
      const invalidArtifact = invalidProviderOutput.body.run.artifacts.find((artifact: any) => artifact.kind === 'answer');
      expect(invalidArtifact).toMatchObject({
        payload: {
          kind: 'app_autopilot_blocked',
          code: 'APP_AUTOPILOT_INTERPRETATION_INVALID',
        },
      });
      expect(invalidArtifact.payload).not.toHaveProperty('providerFailure');
      expect(providerCalls).toHaveLength(13);

      providerResponse = JSON.stringify({ action: 'rename_tile', title: 'CA revenue repair review' });
      const repair = await autopilot('Repair the failed tile.', failedPreview.body.runId);
      expect(repair.status, repair.text).toBe(201);
      expect(repair.body.run).toMatchObject({ status: 'needs_review', trustState: 'review_required' });
      expect(repair.body.run.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'app_autopilot_change',
          payload: expect.objectContaining({
            intent: expect.objectContaining({ action: 'rename_tile' }),
          }),
        }),
      ]));
      expect(providerCalls).toHaveLength(14);
      const unchangedBeforeApply = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'GET');
      expect(unchangedBeforeApply.status, unchangedBeforeApply.text).toBe(200);
      expect(unchangedBeforeApply.body.draft.pages.find((page: any) => page.id === 'overview').layout.items[0].title).toBe('CA revenue (revised)');

      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      server = undefined;
      port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection,
        preferredPort: 0,
        captureServer: (createdServer) => { server = createdServer; },
        appAutopilotProviderFactory: () => provider,
      });
      base = `http://127.0.0.1:${port}`;
      const afterRestart = await autopilot('Explain the selected result.', newestPreview.body.runId);
      expect(afterRestart.status, afterRestart.text).toBe(201);
      expect(afterRestart.body.run.status).toBe('blocked');
      expect(providerCalls).toHaveLength(14);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);

  duckDbIt('APP-074 runs at most four Dataset queries at once and executes an identical tile query once per run', async () => {
    const pilot = await startPilotProject('dql-app-datasets-scheduler-');
    try {
      const { base, executor } = pilot;
      let inFlight = 0;
      let maxInFlight = 0;
      const original = executor.executeQuery.bind(executor);
      const spy = vi.spyOn(executor, 'executeQuery').mockImplementation(async (...args: Parameters<QueryExecutor['executeQuery']>) => {
        const isTile = typeof args[0] === 'string' && args[0].startsWith('WITH ds AS');
        if (isTile) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((done) => setTimeout(done, 40));
        }
        try {
          return await original(...args);
        } finally {
          if (isTile) inFlight -= 1;
        }
      });
      const { draft, page } = await composeBlockTiles(base, 'Scheduler App', [
        ['Revenue', 'kpi', { dimensions: [], measures: [{ measure: 'revenue' }] }],
        ['Revenue again', 'kpi', { dimensions: [], measures: [{ measure: 'revenue' }] }],
        ['Orders', 'kpi', { dimensions: [], measures: [{ measure: 'order_count' }] }],
        ['Customers', 'kpi', { dimensions: [], measures: [{ measure: 'customer_count' }] }],
        ['Margin rate', 'kpi', { dimensions: [], measures: [{ measure: 'margin_rate' }] }],
        ['Revenue by region', 'chart', { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] }],
        ['Revenue by month', 'chart', { dimensions: [{ field: 'order_date', timeGrain: 'month' }], measures: [{ measure: 'revenue' }] }],
      ]);
      const run = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', { fullRun: true });
      expect(run.status, run.text).toBe(200);
      expect(run.body.tiles.every((tile: any) => tile.status === 'ok')).toBe(true);
      // The source-key proof probe also reads `ds`; count tile queries only.
      const tileSql = spy.mock.calls.map(([sql]) => sql)
        .filter((sql): sql is string => typeof sql === 'string' && sql.startsWith('WITH ds AS') && !sql.includes('__dql_grain_key'));
      // Seven tiles, six distinct queries: the duplicate KPI shares one execution.
      expect(tileSql).toHaveLength(6);
      expect(new Set(tileSql).size).toBe(6);
      expect(maxInFlight).toBeGreaterThan(1);
      expect(maxInFlight).toBeLessThanOrEqual(4);
      expect(findTile(run.body.tiles, 'Revenue again').result.rows).toEqual(findTile(run.body.tiles, 'Revenue').result.rows);
      spy.mockRestore();
    } finally {
      await pilot.stop();
    }
  }, 120_000);

  duckDbIt('APP-075 returns the same numbers as independent SQL, and the block and semantic routes agree on shared metrics', async () => {
    const pilot = await startPilotProject('dql-app-datasets-parity-');
    try {
      const { base, executor, connection } = pilot;
      const candidates = await createDraftAndCandidates(base, 'Parity App');
      const blockSource = candidates.items.find((item: any) => item.kind === 'block' && item.title === 'Order lines Dataset');
      const semanticSource = candidates.items.find((item: any) => item.kind === 'semantic' && item.capabilities?.dataset?.kind === 'semantic');
      expect(blockSource).toBeTruthy();
      expect(semanticSource).toBeTruthy();
      const composed = await request(base, `/api/app-builds/${encodeURIComponent(candidates.draft.id)}/compose`, 'POST', {
        mode: 'manual',
        expectedRevision: candidates.draft.revision,
        expectedProposalHash: candidates.draft.proposalHash,
        selections: [
          blockSelection(blockSource.sourceId, 'Block totals', 'table', { dimensions: [], measures: [{ measure: 'revenue' }, { measure: 'order_count' }, { measure: 'customer_count' }, { measure: 'margin_rate' }] }),
          blockSelection(blockSource.sourceId, 'Block by region', 'table', { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }, { measure: 'order_count' }, { measure: 'margin_rate' }], orderBy: [{ alias: 'region', direction: 'asc' }] }),
          blockSelection(semanticSource.sourceId, 'Semantic totals', 'table', { dimensions: [], measures: [{ measure: 'semantic_revenue' }, { measure: 'semantic_order_count' }, { measure: 'semantic_customer_count' }, { measure: 'semantic_margin_rate' }] }),
        ],
      });
      expect(composed.status, composed.text).toBe(200);
      const draft = composed.body.draft;
      const page = draft.pages.find((candidate: any) => candidate.id === 'overview');
      const run = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', { fullRun: true });
      expect(run.status, run.text).toBe(200);

      // Independent SQL, written by hand against the seeded table.
      const independent = await executor.executeQuery(`
        SELECT SUM(net_amount) AS revenue, COUNT(DISTINCT order_id) AS order_count,
               COUNT(DISTINCT customer_id) AS customer_count,
               SUM(margin_amount) / NULLIF(SUM(net_amount), 0) AS margin_rate
        FROM order_lines`, [], {}, connection);
      const byRegion = await executor.executeQuery(`
        SELECT region, SUM(net_amount) AS revenue, COUNT(DISTINCT order_id) AS order_count,
               SUM(margin_amount) / NULLIF(SUM(net_amount), 0) AS margin_rate
        FROM order_lines GROUP BY region ORDER BY region`, [], {}, connection);
      const numeric = (value: unknown) => Number(value);
      const expectRow = (actual: Record<string, unknown>, expected: Record<string, unknown>, keys: string[]) => {
        for (const key of keys) expect(numeric(actual[key]), key).toBeCloseTo(numeric(expected[key]), 10);
      };

      const blockTotals = findTile(run.body.tiles, 'Block totals');
      expect(blockTotals.status, blockTotals.error).toBe('ok');
      expectRow(blockTotals.result.rows[0], independent.rows[0]!, ['revenue', 'order_count', 'customer_count', 'margin_rate']);

      const blockByRegion = findTile(run.body.tiles, 'Block by region');
      expect(blockByRegion.result.rows.map((row: any) => row.region)).toEqual(byRegion.rows.map((row) => row.region));
      blockByRegion.result.rows.forEach((row: any, index: number) => expectRow(row, byRegion.rows[index]!, ['revenue', 'order_count', 'margin_rate']));

      const semanticTotals = findTile(run.body.tiles, 'Semantic totals');
      expect(semanticTotals.status, semanticTotals.error).toBe('ok');
      const semanticRow = semanticTotals.result.rows[0];
      expectRow(
        { revenue: semanticRow.semantic_revenue, order_count: semanticRow.semantic_order_count, customer_count: semanticRow.semantic_customer_count, margin_rate: semanticRow.semantic_margin_rate },
        blockTotals.result.rows[0],
        ['revenue', 'order_count', 'customer_count', 'margin_rate'],
      );
      // Both receipts record the C8 outcome they executed under.
      expect(blockTotals.dataset.validation).toEqual({ outcome: 'covered', adaptations: [] });
      expect(semanticTotals.dataset.validation).toEqual({ outcome: 'covered', adaptations: [] });
    } finally {
      await pilot.stop();
    }
  }, 120_000);

  duckDbIt('APP-071 applies a relative-date dashboard filter as the same range an analyst would write by hand', async () => {
    const pilot = await startPilotProject('dql-app-datasets-relative-date-');
    try {
      const { base, executor, connection } = pilot;
      const { draft: composedDraft, page } = await composeBlockTiles(base, 'Relative date App', [
        ['Revenue', 'kpi', { dimensions: [], measures: [{ measure: 'revenue' }] }],
      ]);
      const binding = page.datasets[0];
      const patched = await request(base, `/api/app-builds/${encodeURIComponent(composedDraft.id)}`, 'PATCH', {
        expectedRevision: composedDraft.revision,
        expectedProposalHash: composedDraft.proposalHash,
        operations: [{
          type: 'set_filter',
          pageId: page.id,
          filter: { id: 'period', type: 'relative_date', label: 'Period', timezone: 'UTC', datasetBindings: { [binding.id]: { field: 'order_date' } } },
        }],
      });
      expect(patched.status, patched.text).toBe(200);
      const draft = patched.body.draft;
      // Wide enough to reach the seeded rows for years to come, and still a
      // real bound: the expected value is computed from the same calendar day.
      const today = new Date().toISOString().slice(0, 10);
      const range = resolveRelativeDateRange('last_3660_days', today)!;
      const run = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        fullRun: true,
        variables: { period: 'last_3660_days' },
      });
      expect(run.status, run.text).toBe(200);
      const tile = findTile(run.body.tiles, 'Revenue');
      expect(tile.status, tile.error).toBe('ok');
      expect(tile.dataset.appliedFilters).toEqual([
        // Calendar dates, the calendar the time buckets use (new-user fix B5).
        expect.objectContaining({ field: 'order_date', op: 'gte', values: [range.start] }),
        expect.objectContaining({ field: 'order_date', op: 'lt' }),
      ]);
      const expected = await executor.executeQuery(
        `SELECT SUM(net_amount) AS revenue FROM order_lines WHERE order_date >= CAST('${range.start}' AS TIMESTAMP) AND order_date < CAST('${range.end}' AS TIMESTAMP) + INTERVAL 1 DAY`,
        [], {}, connection,
      );
      expect(Number(tile.result.rows[0].revenue)).toBe(Number(expected.rows[0]!.revenue));

      const unknownPreset = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', {
        fullRun: true,
        variables: { period: 'next_fortnight' },
      });
      expect(findTile(unknownPreset.body.tiles, 'Revenue')).toMatchObject({ status: 'error', error: expect.stringContaining('unknown relative date') });
    } finally {
      await pilot.stop();
    }
  }, 120_000);

  duckDbIt('APP-073 M4-PROM-01 saves a filtered tile as a runnable review block whose params reproduce the tile result', async () => {
    const pilot = await startPilotProject('dql-app-datasets-promotion-params-');
    try {
      const { base, projectRoot } = pilot;
      const { draft, page } = await composeBlockTiles(base, 'Promotion App', [
        ['US revenue by month', 'table', {
          dimensions: [{ field: 'order_date', timeGrain: 'month' }],
          measures: [{ measure: 'revenue' }],
          filters: [{ field: 'region', op: 'eq', values: ['US'] }],
          orderBy: [{ alias: 'order_date_month', direction: 'asc' }],
        }],
      ]);
      const run = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/run`, 'POST', { fullRun: true });
      expect(run.status, run.text).toBe(200);
      const tile = findTile(run.body.tiles, 'US revenue by month');
      expect(tile.status, tile.error).toBe('ok');
      const saved = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/${encodeURIComponent(page.id)}/tiles/${encodeURIComponent(tile.tileId)}/save-as-block`, 'POST', {
        runId: run.body.runId,
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        name: 'US revenue by month review',
      });
      expect(saved.status, saved.text).toBe(201);
      const source = readFileSync(join(projectRoot, saved.body.path), 'utf-8');
      expect(source).toContain('params {');
      expect(source).toMatch(/: string = "US"/);
      expect(source).not.toMatch(/(?<![A-Za-z_])\$[0-9]/);
      expect(saved.body.replacementEligible).toBe(true);
    } finally {
      await pilot.stop();
    }
  }, 120_000);

  duckDbIt('APP-076 runs the committed commerce-pilot App from a clean checkout: shared filter, cross-filter, and detail', async () => {
    const pilot = await startPilotProject('dql-app-datasets-clean-checkout-');
    try {
      const { base } = pilot;
      const runPage = (pageId: string, body: Record<string, unknown>) => request(base, `/api/apps/commerce-pilot/dashboards/${pageId}/run`, 'POST', body);

      const all = await runPage('overview', { fullRun: true });
      expect(all.status, all.text).toBe(200);
      for (const tile of all.body.tiles) expect(tile.status, `${tile.title}: ${tile.error}`).toBe('ok');
      expect(findTile(all.body.tiles, 'Revenue').result.rows).toEqual([{ revenue: 130 }]);
      expect(Number(findTile(all.body.tiles, 'Semantic commerce totals').result.rows[0].semantic_revenue)).toBe(130);

      // One shared filter, bound to both Datasets by field.
      const california = await runPage('overview', { fullRun: true, variables: { region: ['CA'] } });
      expect(california.status, california.text).toBe(200);
      expect(findTile(california.body.tiles, 'Revenue').result.rows).toEqual([{ revenue: 60 }]);
      expect(Number(findTile(california.body.tiles, 'Semantic commerce totals').result.rows[0].semantic_revenue)).toBe(60);

      // A click on the region chart filters its mapped siblings on both Datasets.
      const regionTile = findTile(all.body.tiles, 'Revenue by region');
      const crossFiltered = await runPage('overview', {
        fullRun: true,
        crossFilters: [{ fromTileId: regionTile.tileId, fromSourceId: regionTile.dataset.sourceId, fromSourceRevision: regionTile.dataset.sourceRevision, field: 'region', values: ['US'] }],
      });
      expect(crossFiltered.status, crossFiltered.text).toBe(200);
      expect(findTile(crossFiltered.body.tiles, 'Revenue').result.rows).toEqual([{ revenue: 70 }]);
      expect(Number(findTile(crossFiltered.body.tiles, 'Semantic commerce totals').result.rows[0].semantic_revenue)).toBe(70);

      // Navigation carries `region`; the detail page honours it.
      const detail = await runPage('order-detail', { fullRun: true, variables: { region: ['CA'] } });
      expect(detail.status, detail.text).toBe(200);
      const lines = findTile(detail.body.tiles, 'Order lines');
      expect(lines.status, lines.error).toBe('ok');
      expect(lines.result.rows.map((row: any) => row.order_line_id)).toEqual(['OL-004', 'OL-006', 'OL-007']);
      expect(new Set(lines.result.rows.map((row: any) => row.region))).toEqual(new Set(['CA']));

      // The shared filter's options come from the bound Dataset field through
      // the governed runtime, not from whichever tiles happened to run.
      const blockDataset = all.body.tiles.find((tile: any) => tile.title === 'Revenue').dataset;
      const options = await request(base, '/api/app-datasets/field-values', 'POST', { sourceId: blockDataset.sourceId, field: 'region' });
      expect(options.status, options.text).toBe(200);
      expect(options.body).toMatchObject({ ok: true, values: ['CA', 'US'], truncated: false });
      const unknownField = await request(base, '/api/app-datasets/field-values', 'POST', { sourceId: blockDataset.sourceId, field: 'net_amount_raw' });
      expect(unknownField.status).toBe(400);
    } finally {
      await pilot.stop();
    }
  }, 120_000);

  duckDbIt('APP-077 an App published before Datasets runs unchanged and republishes without new blockers', async () => {
    const pilot = await startPilotProject('dql-app-datasets-legacy-republish-');
    try {
      const { base, projectRoot } = pilot;
      const appDir = join(projectRoot, 'apps', 'legacy-sales');
      mkdirSync(join(appDir, 'dashboards'), { recursive: true });
      writeFileSync(join(appDir, 'dql.app.json'), `${JSON.stringify({
        version: 1, id: 'legacy-sales', name: 'Legacy sales', domain: 'commerce',
        owners: ['analyst@example.test'], members: [{ userId: 'analyst@example.test', roles: ['owner'] }],
        roles: [{ id: 'owner' }], policies: [], homepage: { type: 'dashboard', id: 'overview' },
      }, null, 2)}\n`);
      const legacyPage = {
        version: 1, id: 'overview',
        metadata: { title: 'Overview', domain: 'commerce', lifecycle: 'certified' },
        layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'order-lines', x: 0, y: 0, w: 12, h: 4, block: { blockId: 'Order lines Dataset' }, viz: { type: 'table' } }] },
      };
      const pagePath = join(appDir, 'dashboards', 'overview.dqld');
      writeFileSync(pagePath, `${JSON.stringify(legacyPage, null, 2)}\n`);

      // Runs as a published App with no migration and no file rewrite.
      const published = await request(base, '/api/apps/legacy-sales/dashboards/overview/run', 'POST', { fullRun: true });
      expect(published.status, published.text).toBe(200);
      expect(published.body.tiles).toEqual([expect.objectContaining({ status: 'ok' })]);
      expect(published.body.tiles[0].result.rows).toHaveLength(8);
      expect(JSON.parse(readFileSync(pagePath, 'utf-8'))).toEqual(legacyPage);

      const blockPath = 'domains/commerce/blocks/order-lines-dataset.dql';
      const blockSource = readFileSync(join(projectRoot, blockPath), 'utf-8');
      const sourceId = `app:block:commerce:${createHash('sha256').update(`${blockPath}\u0000Order lines Dataset`).digest('hex').slice(0, 20)}`;
      const sourceRevision = `sha256:${createHash('sha256').update(blockSource).digest('hex')}`;
      // Open for edit, preview, preflight, republish: no blocker, and the published rows are unchanged.
      const republish = async (draft: any) => {
        const preview = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/dashboards/overview/run`, 'POST', { fullRun: true });
        expect(preview.status, preview.text).toBe(200);
        expect(preview.body.tiles.every((tile: any) => tile.status === 'ok')).toBe(true);
        const receipt = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}`, 'PATCH', {
          expectedRevision: draft.revision,
          expectedProposalHash: draft.proposalHash,
          operations: [{ type: 'set_preview_receipt', receipt: { id: preview.body.runId, pageId: 'overview', revision: draft.revision, snapshotId: preview.body.snapshotId, filterFingerprint: preview.body.filterFingerprint, resultFingerprint: preview.body.resultFingerprint, createdAt: new Date().toISOString() } }],
        });
        expect(receipt.status, receipt.text).toBe(200);
        const preflight = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/preflight`, 'POST', { expectedRevision: receipt.body.draft.revision, proposalHash: receipt.body.draft.proposalHash });
        expect(preflight.status, preflight.text).toBe(200);
        const republished = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/publish-to-project`, 'POST', { expectedRevision: preflight.body.draft.revision, proposalHash: preflight.body.draft.proposalHash });
        expect(republished.status, republished.text).toBe(201);
        const after = await request(base, '/api/apps/legacy-sales/dashboards/overview/run', 'POST', { fullRun: true });
        expect(after.status, after.text).toBe(200);
        expect(after.body.tiles[0].result.rows).toEqual(published.body.tiles[0].result.rows);
      };

      // A version-1 tile names its saved query only. Opening it for edit binds
      // it to the project's current record (F07): certified, with no task.
      const openedLegacy = await request(base, '/api/app-builds', 'POST', { baseAppId: 'legacy-sales', name: 'Legacy sales', authoringMode: 'manual', sourcePolicy: 'governed_only' });
      expect(openedLegacy.status, openedLegacy.text).toBe(201);
      expect(openedLegacy.body.draft.reviewTasks).toEqual([]);
      expect(openedLegacy.body.draft.pages[0].layout.items[0]).toMatchObject({ sourceId, sourceRevision, block: { blockId: 'Order lines Dataset' } });
      expect(openedLegacy.body.draft.sources).toEqual([expect.objectContaining({ id: sourceId, lifecycle: 'certified', trustState: 'certified' })]);
      await republish(openedLegacy.body.draft);

      // A Studio-published whole-block tile carries its exact source binding.
      // Open for edit, preview, preflight, republish: no Dataset-era blocker.
      const studioPage = {
        version: 2, id: 'overview',
        metadata: { title: 'Overview', domain: 'commerce', lifecycle: 'certified' },
        layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{
          i: 'order-lines', x: 0, y: 0, w: 12, h: 4, sourceId, sourceRevision,
          block: { blockId: 'Order lines Dataset' }, viz: { type: 'table' }, title: 'Order lines',
          sourceClass: 'certified_block', trustState: 'certified', reviewStatus: 'certified',
          review: { status: 'not_required', sourceFingerprint: sourceRevision },
        }] },
      };
      writeFileSync(pagePath, `${JSON.stringify(studioPage, null, 2)}\n`);
      const opened = await request(base, '/api/app-builds', 'POST', { baseAppId: 'legacy-sales', name: 'Legacy sales', authoringMode: 'manual', sourcePolicy: 'governed_only' });
      expect(opened.status, opened.text).toBe(201);
      expect(opened.body.draft.reviewTasks).toEqual([]);
      await republish(opened.body.draft);
    } finally {
      await pilot.stop();
    }
  }, 120_000);

  duckDbIt('APP-007 runs field tiles when apps.datasets is not set (on by default)', async () => {
    const pilot = await startPilotProject('dql-app-datasets-default-on-');
    try {
      const { projectRoot } = pilot;
      const configPath = join(projectRoot, 'dql.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      delete config.apps.datasets;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await pilot.restart();
      const ran = await request(pilot.base, '/api/apps/commerce-pilot/dashboards/overview/run', 'POST', { fullRun: true });
      expect(findTile(ran.body.tiles, 'Revenue')).toMatchObject({ status: 'ok', result: { rows: [{ revenue: 130 }] } });

      // Already on: the enable action reports it and writes nothing.
      const enabled = await request(pilot.base, '/api/app-datasets/enable', 'POST', {});
      expect(enabled.body).toEqual({ ok: true, datasets: true });
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(config);
    } finally {
      await pilot.stop();
    }
  }, 120_000);

  duckDbIt('APP-079 turns field tiles back on with one action and keeps every other config key', async () => {
    const pilot = await startPilotProject('dql-app-datasets-enable-');
    try {
      const { projectRoot } = pilot;
      const configPath = join(projectRoot, 'dql.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      config.apps.datasets = false;
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      // The runtime reads the flag it loaded; restart onto the edited config.
      await pilot.restart();
      const refused = await request(pilot.base, '/api/apps/commerce-pilot/dashboards/overview/run', 'POST', { fullRun: true });
      expect(findTile(refused.body.tiles, 'Revenue')).toMatchObject({ status: 'error', error: expect.stringContaining('APP_DATASETS_FEATURE_DISABLED') });

      const enabled = await request(pilot.base, '/api/app-datasets/enable', 'POST', {});
      expect(enabled.status, enabled.text).toBe(200);
      expect(enabled.body).toEqual({ ok: true, datasets: true });
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written).toEqual({ ...config, apps: { ...config.apps, datasets: true } });

      const ran = await request(pilot.base, '/api/apps/commerce-pilot/dashboards/overview/run', 'POST', { fullRun: true });
      expect(findTile(ran.body.tiles, 'Revenue')).toMatchObject({ status: 'ok', result: { rows: [{ revenue: 130 }] } });
    } finally {
      await pilot.stop();
    }
  }, 120_000);
});

async function startPilotProject(prefix: string) {
  const connectorRoot = requireConfiguredDuckDbConnectorRoot();
  const projectRoot = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
  const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot] };
  const executor = new QueryExecutor();
  let server: Server | undefined;
  cpSync(fixtureRoot, projectRoot, { recursive: true });
  const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
  mkdirSync(projectConnectorRoot, { recursive: true });
  symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
  execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot, '--out', databasePath], { stdio: 'pipe' });
  const start = async () => `http://127.0.0.1:${await startLocalServer({
    rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0,
    captureServer: (created) => { server = created; },
  })}`;
  const pilot = {
    base: await start(),
    executor,
    connection,
    projectRoot,
    restart: async () => {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      pilot.base = await start();
    },
    stop: async () => {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
  return pilot;
}

describe('Driver tiles over a real DuckDB Dataset (RFC 0008 step 7)', () => {
  duckDbIt('explains a month-over-month change by member, from a saved driver tile and from a reader probe', async () => {
    const connectorRoot = requireConfiguredDuckDbConnectorRoot();
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-app-datasets-drivers-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot, '--out', databasePath], { stdio: 'pipe' });
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const { draft: composed, page } = await composeBlockTiles(base, 'Driver App', [
        ['Revenue by region', 'chart', { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] }],
      ]);
      const trend = page.layout.items[0];
      const driver = { version: 1, measure: 'revenue', timeField: 'order_date', grain: 'month', anchor: '2026-03-01', comparison: 'previous_period', dimensions: ['region', 'customer_id', 'order_date'] };

      // A saved driver tile runs as governed comparisons and folds into one result.
      const added = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}`, 'PATCH', {
        expectedRevision: composed.revision,
        expectedProposalHash: composed.proposalHash,
        operations: [{
          type: 'add_tile',
          pageId: 'overview',
          tile: { i: 'why-march', x: 0, y: 4, w: 12, h: 6, sourceId: trend.sourceId, sourceRevision: trend.sourceRevision, driver, viz: { type: 'waterfall' }, title: 'Why revenue moved in March' },
        }],
      });
      expect(added.status, added.text).toBe(200);
      const run = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}/dashboards/overview/run`, 'POST', { fullRun: true });
      expect(run.status, run.text).toBe(200);
      expect(run.body.tiles.map((tile: any) => tile.tileId)).toEqual([trend.i, 'why-march']);
      const tile = run.body.tiles.find((candidate: any) => candidate.tileId === 'why-march');
      expect(tile).toMatchObject({ status: 'ok', tileType: 'driver' });
      expect(tile.driver.headline).toMatchObject({ current: '40', prior: '30', delta: '10' });
      expect(tile.driver.dimensions.map((dimension: any) => dimension.field)).toEqual(['region', 'customer_id']);
      expect(tile.driver.dimensions[0]).toMatchObject({ reconciles: true, concentration: 1 });
      expect(tile.driver.dimensions[0].members[0]).toMatchObject({ label: 'US', delta: '10', role: 'driver' });
      expect(tile.driver.dimensions[1].reconciles).toBe(true);
      expect(tile.driver.unavailable).toEqual([{ field: 'order_date', reason: 'a time field; the periods already cover time' }]);
      expect(tile.dataset).toMatchObject({ trust: 'certified' });
      expect(tile.driverEvidence.every((entry: any) => entry.status === 'ok' && entry.executedSqlFingerprint)).toBe(true);
      expect(run.body.incomplete).toBeUndefined();

      // A reader's probe runs bounded from a Dataset tile and leaves the App unchanged.
      const probe = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}/dashboards/overview/run`, 'POST', {
        driverProbe: { fromTileId: trend.i, driver: { ...driver, dimensions: ['region'] } },
      });
      expect(probe.status, probe.text).toBe(200);
      expect(probe.body.partial).toBe(true);
      expect(probe.body.tiles).toHaveLength(1);
      expect(probe.body.tiles[0]).toMatchObject({ tileId: `${trend.i}::why`, tileType: 'driver', status: 'ok' });
      expect(probe.body.tiles[0].driver.summary).toBe('Revenue rose by 10. The largest move was US (region): +10, 100% of the change.');
      const stored = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}`, 'GET');
      expect(stored.body.draft.pages[0].layout.items.map((item: any) => item.i)).toEqual([trend.i, 'why-march']);

      // A page filter that lists the tiles it applies to must reach the
      // probe's comparisons too (evaluation E1: with Region CA selected the
      // probe explained the whole business). CA had 30 in both months.
      const current = stored.body.draft;
      const datasetId = current.pages[0].datasets[0].id;
      const filtered = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}`, 'PATCH', {
        expectedRevision: current.revision,
        expectedProposalHash: current.proposalHash,
        operations: [{
          type: 'set_filter',
          pageId: 'overview',
          filter: { id: 'region', type: 'multiselect', label: 'Region', scope: { app: true }, datasetBindings: { [datasetId]: { field: 'region', tileIds: [trend.i] } } },
        }],
      });
      expect(filtered.status, filtered.text).toBe(200);
      const caProbe = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}/dashboards/overview/run`, 'POST', {
        variables: { region: ['CA'] },
        driverProbe: { fromTileId: trend.i, driver: { ...driver, dimensions: ['region'] } },
      });
      expect(caProbe.status, caProbe.text).toBe(200);
      expect(caProbe.body.tiles[0].driver.headline).toMatchObject({ current: '30', prior: '30', delta: '0' });
      expect(caProbe.body.tiles[0].driver.dimensions[0].members.map((member: any) => member.label)).toEqual(['CA']);

      // A probe must start from a Dataset tile on the page.
      const refused = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}/dashboards/overview/run`, 'POST', {
        driverProbe: { fromTileId: 'nope', driver },
      });
      expect(refused.status).toBe(400);
      expect(refused.text).toContain('Dataset tile on this page');

      // RFC 0009 step 6a. An explanation narrowed to what the reader clicked:
      // US alone went from nothing to 10, and region is no longer a breakdown.
      const usProbe = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}/dashboards/overview/run`, 'POST', {
        driverProbe: { fromTileId: trend.i, driver: { ...driver, dimensions: ['region', 'customer_id'], filters: [{ field: 'region', op: 'eq', values: ['US'] }] } },
      });
      expect(usProbe.status, usProbe.text).toBe(200);
      expect(usProbe.body.tiles[0].driver.headline).toMatchObject({ current: '10', delta: '10' });
      expect(usProbe.body.tiles[0].driver.dimensions.map((dimension: any) => dimension.field)).toEqual(['customer_id']);

      // Explore runs inside the page run: the Region filter scoped to this
      // tile reaches the view, so CA's customers only.
      const explore = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}/dashboards/overview/run`, 'POST', {
        variables: { region: ['CA'] },
        exploreProbe: { fromTileId: trend.i, query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] } },
      });
      expect(explore.status, explore.text).toBe(200);
      expect(explore.body.tiles).toHaveLength(1);
      expect(explore.body.tiles[0]).toMatchObject({ tileId: `${trend.i}::explore`, status: 'ok', trustState: 'certified' });
      expect(explore.body.tiles[0].result.rows.map((row: any) => row.region)).toEqual(['CA']);
      expect(explore.body.tiles[0].dataset.explore.fields.map((field: any) => field.name)).toEqual(expect.arrayContaining(['region', 'order_date']));

      // Exclude from a clicked mark on the tile's own Dataset needs no mapping.
      const excluded = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}/dashboards/overview/run`, 'POST', {
        crossFilters: [{ fromTileId: trend.i, fromSourceId: trend.sourceId, fromSourceRevision: trend.sourceRevision, field: 'region', values: ['CA'], exclude: true }],
        exploreProbe: { fromTileId: trend.i, query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] } },
      });
      expect(excluded.status, excluded.text).toBe(200);
      expect(excluded.body.tiles[0].result.rows.map((row: any) => row.region)).toEqual(['US']);

      // A view outside the contract is refused, and a refusal is never certified (evaluation J1).
      const rejected = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}/dashboards/overview/run`, 'POST', {
        exploreProbe: { fromTileId: trend.i, query: { dimensions: [{ field: 'not_a_field' }], measures: [{ measure: 'revenue' }] } },
      });
      expect(rejected.status, rejected.text).toBe(200);
      expect(rejected.body.tiles[0]).toMatchObject({ tileId: `${trend.i}::explore`, status: 'error', trustState: 'review_required' });
      expect(rejected.body.tiles[0].result).toBeUndefined();

      // A driver tile may follow its Dataset's filter, and the page still
      // saves (evaluation J4: publishing refused a filtered driver).
      const withDriver = (await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}`, 'GET')).body.draft;
      const followed = await request(base, `/api/app-builds/${encodeURIComponent(composed.id)}`, 'PATCH', {
        expectedRevision: withDriver.revision,
        expectedProposalHash: withDriver.proposalHash,
        operations: [{
          type: 'set_filter',
          pageId: 'overview',
          filter: { id: 'region', type: 'multiselect', label: 'Region', scope: { app: true }, datasetBindings: { [datasetId]: { field: 'region', tileIds: [trend.i, 'why-march'] } } },
        }],
      });
      expect(followed.status, followed.text).toBe(200);
    } finally {
      await new Promise<void>((done) => server ? server.close(() => done()) : done());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 90_000);
});

async function createDraftAndCandidates(base: string, name: string) {
  const created = await request(base, '/api/app-builds', 'POST', {
    name, goal: 'Check governed Dataset tiles.', domain: 'commerce', authoringMode: 'manual', sourcePolicy: 'governed_only', template: 'blank',
  });
  expect(created.status, created.text).toBe(201);
  const draft = created.body.draft;
  const candidates = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/source-candidates?domain=commerce&limit=50`, 'GET');
  expect(candidates.status, candidates.text).toBe(200);
  return { draft, items: candidates.body.items as any[] };
}

async function composeBlockTiles(base: string, name: string, tiles: Array<[string, 'kpi' | 'chart' | 'table', Record<string, unknown>]>) {
  const { draft, items } = await createDraftAndCandidates(base, name);
  const source = items.find((item: any) => item.kind === 'block' && item.title === 'Order lines Dataset');
  expect(source).toBeTruthy();
  const composed = await request(base, `/api/app-builds/${encodeURIComponent(draft.id)}/compose`, 'POST', {
    mode: 'manual',
    expectedRevision: draft.revision,
    expectedProposalHash: draft.proposalHash,
    selections: tiles.map(([title, view, query]) => blockSelection(source.sourceId, title, view, query)),
  });
  expect(composed.status, composed.text).toBe(200);
  const composedDraft = composed.body.draft;
  return { draft: composedDraft, page: composedDraft.pages.find((candidate: any) => candidate.id === 'overview') };
}

function requireConfiguredDuckDbConnectorRoot(): string {
  if (!configuredDuckDbConnectorRoot) throw new Error('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT is required for this real DuckDB pilot.');
  // An explicitly configured root must load DuckDB.  Do not fall back to an
  // ambient package, which would turn an unavailable real-driver test into a
  // false pass.
  const duckdb = createRequire(join(configuredDuckDbConnectorRoot, 'package.json'))('duckdb') as { Database?: unknown };
  if (typeof duckdb?.Database !== 'function') throw new Error(`DuckDB did not load from ${configuredDuckDbConnectorRoot}.`);
  return configuredDuckDbConnectorRoot;
}

function blockSelection(sourceId: string, title: string, view: 'kpi' | 'chart' | 'table', query: Record<string, unknown>) {
  return { sourceId, pageId: 'overview', view, title, query: { ...query, respectsGlobalFilters: true } };
}

function absoluteMonth(id: string, start: string, end: string) {
  return { id, kind: 'absolute' as const, start, end };
}

function monthComparison(input: {
  basePeriodId: string;
  comparisonPeriodId: string;
  periods: Array<ReturnType<typeof absoluteMonth>>;
  timezone?: string;
}) {
  return {
    version: 1,
    timeField: 'order_date',
    timeRole: 'event_time',
    calendarId: 'calendar:gregorian',
    timezone: input.timezone ?? 'UTC',
    grain: 'month',
    completenessPolicy: 'closed_period',
    periods: input.periods,
    basePeriodId: input.basePeriodId,
    comparisonPeriodIds: [input.comparisonPeriodId],
    alignment: 'calendar_period',
    outputs: ['value', 'absolute_delta', 'percent_delta'],
    zeroDenominatorPolicy: 'null',
  };
}

function findTile(tiles: any[], title: string): any {
  const tile = tiles.find((candidate) => candidate.title === title);
  if (!tile) throw new Error(`Missing tile ${title}.`);
  return tile;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function request(base: string, path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown): Promise<ApiResponse> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text };
}
