import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { startLocalServer } from '../local-runtime.js';

/**
 * Add fields to a saved query (design D1), end to end on real DuckDB: a
 * saved query (a block without a Dataset definition) gets one from its own
 * output columns, checked against its rows, written onto the same block file,
 * and certified only when the same check as "Start from a table" passes.
 * Needs a DuckDB connector root (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');

async function call(base: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

function savedQuery(input: { name: string; status: 'certified' | 'draft'; owner?: string; tests?: string }): string {
  return [
    '// dql-format: 1',
    '',
    `block "${input.name}" {`,
    '  domain = "commerce"',
    '  type = "custom"',
    `  status = "${input.status}"`,
    ...(input.owner ? [`  owner = "${input.owner}"`] : []),
    '  description = "Revenue and lines for each region."',
    '  tags = ["revenue"]',
    '  query = """',
    'SELECT region, SUM(net_amount) AS net_amount, COUNT(*) AS line_count',
    'FROM order_lines',
    'GROUP BY region',
    '"""',
    ...(input.tests ? [`  tests {\n    ${input.tests}\n  }`] : []),
    '}',
    '',
  ].join('\n');
}

describe('add fields to a saved query', () => {
  duckDbIt('writes a checked Dataset definition onto the same block, keeps governance, and refuses what is not a saved query', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-saved-query-fields-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', connectorRoot!, '--out', databasePath], { stdio: 'pipe' });
      const blocksDir = join(projectRoot, 'domains', 'commerce', 'blocks');
      writeFileSync(join(blocksDir, 'region-revenue.dql'), savedQuery({ name: 'Region revenue', status: 'certified', owner: 'commerce@example.test' }));
      writeFileSync(join(blocksDir, 'region-revenue-unowned.dql'), savedQuery({ name: 'Region revenue unowned', status: 'draft' }));
      writeFileSync(join(blocksDir, 'region-revenue-strict.dql'), savedQuery({ name: 'Region revenue strict', status: 'certified', owner: 'commerce@example.test', tests: 'assert row_count > 1000000' }));
      // Field tiles start switched off: Add fields is refused like every Dataset authoring operation.
      const configPath = join(projectRoot, 'dql.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      writeFileSync(configPath, `${JSON.stringify({ ...config, apps: { datasets: false } }, null, 2)}\n`);
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;

      const off = await call(base, '/api/app-datasets/saved-queries/draft', { sourceId: 'anything' });
      expect(off.status, off.text).toBe(409);
      expect(off.body.code).toBe('APP_DATASETS_FEATURE_DISABLED');
      expect((await call(base, '/api/app-datasets/enable', {})).body.datasets).toBe(true);

      const app = await call(base, '/api/app-builds', { name: 'Fields', goal: 'Revenue by region', domain: 'commerce', authoringMode: 'manual', sourcePolicy: 'include_review_required', template: 'blank' });
      expect(app.status, app.text).toBe(201);
      const listed = await call(base, `/api/app-builds/${encodeURIComponent(app.body.draft.id)}/source-candidates?limit=50`);
      const byName = (name: string) => listed.body.items.find((item: { name: string }) => item.name === name);
      const regionRevenue = byName('Region revenue');
      expect(regionRevenue, JSON.stringify(listed.body.items.map((item: { name: string }) => item.name))).toBeDefined();
      expect(regionRevenue.capabilities.dataset).toBeUndefined();

      // Refusals: an unknown source, a Dataset that already has fields, and Metrics.
      expect((await call(base, '/api/app-datasets/saved-queries/draft', { sourceId: 'app:block:missing' })).status).toBe(404);
      const dataset = byName('Order lines Dataset');
      const already = await call(base, '/api/app-datasets/saved-queries/draft', { sourceId: dataset.sourceId });
      expect(already.status).toBe(409);
      expect(already.body.code).toBe('SAVED_QUERY_ALREADY_DATASET');
      const metrics = listed.body.items.find((item: { kind: string }) => item.kind === 'semantic');
      expect(metrics, 'the pilot fixture lists Metrics').toBeDefined();
      {
        const semantic = await call(base, '/api/app-datasets/saved-queries/draft', { sourceId: metrics.sourceId });
        expect(semantic.status).toBe(409);
        expect(semantic.body.code).toBe('SAVED_QUERY_NOT_A_BLOCK');
      }

      // Happy path: the proposal reads the saved query's columns and rows.
      const draft = await call(base, '/api/app-datasets/saved-queries/draft', { sourceId: regionRevenue.sourceId });
      expect(draft.status, draft.text).toBe(200);
      expect(draft.body.sendsBackForReview).toBe(true);
      expect(draft.body.rows).toBeGreaterThan(0);
      expect(draft.body.proposal.key).toEqual({ column: 'region', entity: 'region_revenue' });
      expect(draft.body.proposal.measures.map((measure: { name: string }) => measure.name)).toEqual(expect.arrayContaining(['net_amount', 'line_count']));
      const filesBefore = readdirSync(blocksDir).sort();
      const created = await call(base, '/api/app-datasets/saved-queries/create', {
        sourceId: regionRevenue.sourceId,
        sourceRevision: draft.body.source.sourceRevision,
        measures: [{ name: 'line_count', include: false, format: 'number' }],
      });
      expect(created.status, created.text).toBe(200);
      expect(created.body).toMatchObject({ ok: true, previousStatus: 'certified', status: 'certified', keyChecked: true, path: 'domains/commerce/blocks/region-revenue.dql', sourceId: regionRevenue.sourceId });
      expect(readdirSync(blocksDir).sort()).toEqual(filesBefore);
      const written = readFileSync(join(blocksDir, 'region-revenue.dql'), 'utf-8');
      expect(written).toContain('block "Region revenue" {');
      expect(written).toContain('status = "certified"');
      expect(written).toContain('keys = ["region"]');
      expect(written).toMatch(/net_amount \{ agg = "sum"/);
      expect(written).not.toMatch(/line_count \{ agg/);
      expect(written).toContain('GROUP BY region');
      const relisted = await call(base, `/api/app-builds/${encodeURIComponent(app.body.draft.id)}/source-candidates?limit=50`);
      const withFields = relisted.body.items.find((item: { sourceId: string }) => item.sourceId === regionRevenue.sourceId);
      expect(withFields).toMatchObject({ lifecycle: 'certified', trust: 'certified' });
      expect(withFields.capabilities.dataset.fields.filter((field: { kind: string }) => field.kind === 'measure').map((field: { name: string }) => field.name))
        .toEqual(expect.arrayContaining(['net_amount']));
      const twice = await call(base, '/api/app-datasets/saved-queries/draft', { sourceId: regionRevenue.sourceId });
      expect(twice.body.code).toBe('SAVED_QUERY_ALREADY_DATASET');

      // A saved query that cannot pass its checks (no owner) gets its fields and stays Needs review.
      const unowned = byName('Region revenue unowned');
      const unownedResult = await call(base, '/api/app-datasets/saved-queries/create', { sourceId: unowned.sourceId });
      expect(unownedResult.status, unownedResult.text).toBe(200);
      expect(unownedResult.body).toMatchObject({ ok: true, previousStatus: 'draft', status: 'draft', keyChecked: false });
      expect(unownedResult.body.blockers.length).toBeGreaterThan(0);
      const unownedSource = readFileSync(join(blocksDir, 'region-revenue-unowned.dql'), 'utf-8');
      expect(unownedSource).toContain('status = "draft"');
      expect(unownedSource).toContain('keys = ["region"]');

      // A certified saved query whose check fails is left untouched unless the author sends it for review.
      const strict = byName('Region revenue strict');
      const strictBefore = readFileSync(join(blocksDir, 'region-revenue-strict.dql'), 'utf-8');
      const refused = await call(base, '/api/app-datasets/saved-queries/create', { sourceId: strict.sourceId });
      expect(refused.status, refused.text).toBe(409);
      expect(refused.body.code).toBe('SAVED_QUERY_REVIEW_REQUIRED');
      expect(readFileSync(join(blocksDir, 'region-revenue-strict.dql'), 'utf-8')).toBe(strictBefore);
      const sentForReview = await call(base, '/api/app-datasets/saved-queries/create', { sourceId: strict.sourceId, allowReview: true });
      expect(sentForReview.status, sentForReview.text).toBe(200);
      expect(sentForReview.body).toMatchObject({ previousStatus: 'certified', status: 'review' });
      expect(readFileSync(join(blocksDir, 'region-revenue-strict.dql'), 'utf-8')).toContain('status = "review"');
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
