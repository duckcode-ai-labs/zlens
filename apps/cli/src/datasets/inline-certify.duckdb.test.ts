import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { load as loadYaml } from 'js-yaml';
import { startLocalServer } from '../local-runtime.js';

/**
 * Certify where you are (T4), on real DuckDB through the local runtime:
 *
 * - a saved query certifies through `/api/app-datasets/certify`: a missing
 *   owner is required (and then written), a failing test refuses with
 *   nothing written, a passing one leaves a receipt with who, when and what
 *   was checked; an edit afterwards keeps the date ("Changed since it was
 *   certified on …");
 * - a join certifies through `/api/app-datasets/joins/certify`: a fresh check
 *   that passes certifies it in the model, filling each side's grain and keys
 *   from the checks; a check that fails refuses and writes nothing; a setup
 *   draft's join leaves the draft; a later change keeps the date.
 *
 * Needs a DuckDB connector root (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');

type Json = any;

async function request(base: string, path: string, body?: unknown): Promise<{ status: number; body: Json; text: string }> {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

function savedQuery(input: { name: string; owner?: string; tests?: string }): string {
  return [
    '// dql-format: 1',
    '',
    `block "${input.name}" {`,
    '  domain = "commerce"',
    '  type = "custom"',
    '  status = "draft"',
    ...(input.owner ? [`  owner = "${input.owner}"`] : []),
    '  description = "Revenue and lines for each region."',
    '  dimensions = ["region"]',
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

/** Every modeling YAML file in the project with its contents, to show what was (or was not) written. */
function modelFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      if (name === '.dql' || name === 'node_modules') continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.dql\.ya?ml$/.test(name)) out[relative(root, path)] = readFileSync(path, 'utf-8');
    }
  };
  walk(root);
  return out;
}

describe('certify a saved query where you are (T4)', () => {
  duckDbIt('requires an owner, refuses a failing test, certifies with a receipt, and keeps the date after an edit', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-inline-certify-sq-'));
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
      writeFileSync(join(blocksDir, 'region-revenue.dql'), savedQuery({ name: 'Region revenue', tests: 'assert row_count > 0' }));
      writeFileSync(join(blocksDir, 'region-revenue-strict.dql'), savedQuery({ name: 'Region revenue strict', owner: 'commerce@example.test', tests: 'assert row_count > 1000000' }));
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const call = (path: string, body?: unknown) => request(base, path, body);

      const app = await call('/api/app-builds', { name: 'Regions', goal: 'Revenue by region', domain: 'commerce', authoringMode: 'manual', template: 'blank' });
      expect(app.status, app.text).toBe(201);
      const listed = await call(`/api/app-builds/${encodeURIComponent(app.body.draft.id)}/source-candidates?limit=50`);
      const byName = (name: string) => listed.body.items.find((item: Json) => item.name === name);
      const regionRevenue = byName('Region revenue');
      const strict = byName('Region revenue strict');
      expect(regionRevenue, JSON.stringify(listed.body.items.map((item: Json) => item.name))).toBeDefined();

      // The review runs it now and lists its tests; nobody owns it, so it asks.
      const review = await call(`/api/app-datasets/certify-review?sourceId=${encodeURIComponent(regionRevenue.sourceId)}`);
      expect(review.status, review.text).toBe(200);
      expect(review.body.review).toMatchObject({
        kind: 'saved_query',
        canVouch: true,
        savedQuery: { runs: { ok: true }, ownerRequired: true, row: 'One row for each region.', blockers: [] },
      });
      expect(review.body.review.savedQuery.tests).toEqual([expect.objectContaining({ passed: true })]);
      expect(review.body.review.savedQuery.runs.sentence).toMatch(/^Ran just now: \d+ rows?\.$/);

      // Owner missing: required, and nothing is written.
      const before = readFileSync(join(blocksDir, 'region-revenue.dql'), 'utf-8');
      const noOwner = await call('/api/app-datasets/certify', { sourceId: regionRevenue.sourceId });
      expect(noOwner.status, noOwner.text).toBe(422);
      expect(noOwner.body.code).toBe('OWNER_REQUIRED');
      expect(readFileSync(join(blocksDir, 'region-revenue.dql'), 'utf-8')).toBe(before);

      // A failing test refuses, and nothing is written.
      const strictBefore = readFileSync(join(blocksDir, 'region-revenue-strict.dql'), 'utf-8');
      const strictReview = await call(`/api/app-datasets/certify-review?sourceId=${encodeURIComponent(strict.sourceId)}`);
      expect(strictReview.body.review.canVouch).toBe(false);
      expect(strictReview.body.review.savedQuery.testsSentence).toBe('1 of 1 test failed.');
      const refused = await call('/api/app-datasets/certify', { sourceId: strict.sourceId });
      expect(refused.status, refused.text).toBe(422);
      expect(refused.body.code).toBe('CERTIFICATION_CHECKS_FAILED');
      expect(readFileSync(join(blocksDir, 'region-revenue-strict.dql'), 'utf-8')).toBe(strictBefore);

      // With an owner: certified, the owner written, and a receipt with who, when and what was checked.
      const certified = await call('/api/app-datasets/certify', { sourceId: regionRevenue.sourceId, owner: 'Maria Lopez' });
      expect(certified.status, certified.text).toBe(200);
      expect(certified.body).toMatchObject({ ok: true, status: 'certified', ownerWritten: 'Maria Lopez', certification: { byYou: true } });
      const written = readFileSync(join(blocksDir, 'region-revenue.dql'), 'utf-8');
      expect(written).toContain('owner = "Maria Lopez"');
      expect(written).toContain('status = "certified"');
      const companion = loadYaml(readFileSync(join(projectRoot, 'semantic-layer', 'blocks', 'commerce', 'region-revenue.yaml'), 'utf-8')) as Json;
      expect(companion.reviewStatus).toBe('certified');
      expect(companion.certification).toMatchObject({ via: 'app-dataset', rules: 'oss' });
      expect(typeof companion.certification.certifiedBy).toBe('string');
      expect(Date.parse(companion.certification.certifiedAt)).not.toBeNaN();
      expect(companion.certification.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(companion.certification.checks).toEqual(expect.arrayContaining(['Tests: Its one test passes.', 'Owner: Maria Lopez', 'One row: One row for each region.']));
      expect(companion.certification.checks.some((check: string) => /^Runs: ran on certification, \d+ rows?\.$/.test(check))).toBe(true);
      expect((await call('/api/app-datasets/certify', { sourceId: regionRevenue.sourceId })).body.code).toBe('ALREADY_CERTIFIED');

      // Edited afterwards (outside ZLens): not certified any more, and the date it was certified is kept.
      writeFileSync(join(blocksDir, 'region-revenue.dql'), written.replace('GROUP BY region', 'GROUP BY region -- edited'));
      const afterEdit = await call(`/api/app-builds/${encodeURIComponent(app.body.draft.id)}/source-candidates?limit=50`);
      const edited = afterEdit.body.items.find((item: Json) => item.name === 'Region revenue');
      expect(edited.trust).not.toBe('certified');
      expect(edited.certification?.at).toBe(companion.certification.certifiedAt);
      const editedReview = await call(`/api/app-datasets/certify-review?sourceId=${encodeURIComponent(edited.sourceId)}`);
      expect(editedReview.body.review.previousCertification?.at).toBe(companion.certification.certifiedAt);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 240_000);
});

const LOCATIONS = {
  philadelphia: '4b6c2304-2b9e-41a3-8f1e-6c9a1d2f0001',
  brooklyn: '9a1e77d0-5c3b-4e2a-b7d4-0e5f6a7b0002',
};

describe('certify a join where you are (T4)', () => {
  duckDbIt('certifies a checked join in the model with grain and keys filled from the checks, refuses a failing check, and keeps the date after a change', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-inline-certify-join-'));
    const databasePath = join(projectRoot, 'shop.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    const start = async () => {
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      return `http://127.0.0.1:${port}`;
    };
    const stop = () => new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    let base = '';
    const call = (path: string, body?: unknown) => request(base, path, body);
    try {
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
        project: 'shop', manifestVersion: 3, modeling: { mode: 'warehouse-first' }, apps: { datasets: true },
        connections: { default: { driver: 'duckdb', filepath: './shop.duckdb' } },
      }));
      for (const statement of [
        'CREATE TABLE main.customers (customer_id VARCHAR, customer_name VARCHAR)',
        "INSERT INTO main.customers VALUES ('C1', 'Ann'), ('C2', 'Bob'), ('C3', 'Cy')",
        'CREATE TABLE main.locations (location_id VARCHAR, location_name VARCHAR)',
        `INSERT INTO main.locations VALUES ('${LOCATIONS.philadelphia}', 'Philadelphia'), ('${LOCATIONS.brooklyn}', 'Brooklyn')`,
        'CREATE TABLE main.orders (order_id VARCHAR, customer_id VARCHAR, location_id VARCHAR, ordered_at TIMESTAMP, order_total DOUBLE)',
        [
          'INSERT INTO main.orders VALUES',
          `('O1', 'C1', '${LOCATIONS.philadelphia}', TIMESTAMP '2026-01-05 10:00:00', 100),`,
          `('O2', 'C1', '${LOCATIONS.brooklyn}', TIMESTAMP '2026-01-20 10:00:00', 50),`,
          `('O3', 'C2', '${LOCATIONS.philadelphia}', TIMESTAMP '2026-02-02 10:00:00', 25),`,
          `('O4', 'C3', '${LOCATIONS.philadelphia}', TIMESTAMP '2026-02-10 10:00:00', 10),`,
          `('O5', 'C2', '${LOCATIONS.brooklyn}', TIMESTAMP '2026-02-11 10:00:00', 5)`,
        ].join(' '),
      ]) await executor.executePositional(statement, [], connection);
      base = await start();
      expect((await call('/api/connections/default/metadata-sync', {})).status).toBe(200);

      // The model has orders and customers without grain or keys, and a drafted orders → customers relationship.
      const discovered = await call('/api/modeling/warehouse/discover', { validate: false });
      expect(discovered.status, discovered.text).toBe(200);
      const relationIdOf = (table: string) => discovered.body.report.entities.find((entity: Json) => String(entity.relation ?? entity.relationId).endsWith(table)).relationId as string;
      const manual = await call('/api/context-proposals', {
        origin: 'manual',
        operations: [
          { id: 'entity:orders', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'orders', domain: 'shop', dbtModel: relationIdOf('orders'), businessName: 'Orders' } } },
          { id: 'entity:customers', kind: 'modeling_change', change: { operation: 'upsert_entity', value: { id: 'customers', domain: 'shop', dbtModel: relationIdOf('customers'), businessName: 'Customers' } } },
          { id: 'rel:orders_to_customers', kind: 'modeling_change', dependsOn: ['entity:orders', 'entity:customers'], change: { operation: 'upsert_relationship', value: { id: 'orders_to_customers', domain: 'shop', from: 'orders', to: 'customers', keys: [{ from: 'customer_id', to: 'customer_id' }], cardinality: 'many_to_one', fanout: 'safe', status: 'draft' } } },
        ],
      });
      expect(manual.status, manual.text).toBe(201);
      const committed = await call(`/api/context-proposals/${encodeURIComponent(manual.body.proposal.id)}/commit`, { expectedProposalHash: manual.body.proposal.proposalHash, idempotencyKey: 'test-manual' });
      expect(committed.status, committed.text).toBe(200);
      // Setup's Draft my models drafts orders → locations (locations is new to the model).
      const drafted = await call('/api/modeling/warehouse/discover/proposal', { validate: true });
      expect(drafted.status, drafted.text).toBe(201);

      // Orders, from its table, checked and certified as data.
      const tables = await call('/api/app-datasets/tables');
      const ordersTable = tables.body.tables.find((table: Json) => table.name === 'orders');
      const created = await call('/api/app-datasets/tables/create', { tableId: ordersTable.id, name: 'Orders', domain: 'shop' });
      expect(created.status, created.text).toBe(201);
      expect((await call('/api/app-datasets/certify', { sourceId: created.body.sourceId })).body.status).toBe('certified');
      const app = await call('/api/app-builds', { name: 'Stores', goal: 'Sales by store', domain: 'shop', authoringMode: 'manual', template: 'blank' });
      const descriptorOf = async () => {
        const candidates = await call(`/api/app-builds/${encodeURIComponent(app.body.draft.id)}/source-candidates?limit=50`);
        return candidates.body.items.find((item: Json) => item.sourceId === created.body.sourceId).capabilities.dataset;
      };
      const joins = (await descriptorOf()).joins as Json[];
      expect(joins.map((join) => [join.id, join.origin, join.trust])).toEqual([
        ['customer', 'model', 'review_required'],
        ['location', 'drafted', 'review_required'],
      ]);

      // The review of the model's join: its keys, the fresh check, what would double-count, and what it fills.
      const review = await call(`/api/app-datasets/joins/certify-review?sourceId=${encodeURIComponent(created.body.sourceId)}&joinId=customer`);
      expect(review.status, review.text).toBe(200);
      expect(review.body.review).toMatchObject({
        name: 'Orders → Customer',
        keysSentence: 'orders.customer_id = customers.customer_id',
        checkedSentence: 'each order has one customer — checked on 5 rows',
        canVouch: true,
        blockers: [],
      });
      expect(review.body.review.doubleCount).toContain('would be counted more than once');
      expect(review.body.review.fills.map((fill: Json) => [fill.side, fill.table, fill.grain, fill.keys])).toEqual([
        ['from', 'orders', 'order_id', ['order_id']],
        ['to', 'customers', 'customer_id', ['customer_id']],
      ]);

      // I vouch for this join — certify: the model has it certified, with grain and keys filled.
      const certified = await call('/api/app-datasets/joins/certify', { sourceId: created.body.sourceId, joinId: 'customer' });
      expect(certified.status, certified.text).toBe(200);
      expect(certified.body).toMatchObject({ ok: true, status: 'certified', relationshipId: 'shop::relationship::orders_to_customers', certification: { byYou: true } });
      const written = modelFiles(projectRoot);
      const entityYaml = Object.values(written).map((text) => loadYaml(text) as Json).flatMap((document) => document.entities ?? []);
      expect(entityYaml.find((entity: Json) => entity.id === 'orders')).toMatchObject({ grain: 'order_id', keys: ['order_id'] });
      expect(entityYaml.find((entity: Json) => entity.id === 'customers')).toMatchObject({ grain: 'customer_id', keys: ['customer_id'] });
      const relationshipYaml = Object.values(written).map((text) => loadYaml(text) as Json).flatMap((document) => document.relationships ?? []);
      const toCustomers = relationshipYaml.find((relationship: Json) => relationship.id === 'orders_to_customers');
      expect(toCustomers).toMatchObject({ status: 'certified', validation: { status: 'passed' }, certifiedAgainst: { from: { grain: 'order_id', keys: ['order_id'] }, to: { grain: 'customer_id', keys: ['customer_id'] } } });
      expect(Date.parse(toCustomers.certifiedAgainst.certifiedAt)).not.toBeNaN();
      expect((await descriptorOf()).joins.find((join: Json) => join.id === 'customer').trust).toBe('certified');

      // A check that fails refuses, says why, and writes nothing: locations now repeats a key.
      await stop();
      await executor.executePositional(`INSERT INTO main.locations VALUES ('${LOCATIONS.brooklyn}', 'Brooklyn (old)')`, [], connection);
      base = await start();
      const beforeFailure = modelFiles(projectRoot);
      const failingReview = await call(`/api/app-datasets/joins/certify-review?sourceId=${encodeURIComponent(created.body.sourceId)}&joinId=location`);
      expect(failingReview.status, failingReview.text).toBe(200);
      expect(failingReview.body.review.canVouch).toBe(false);
      expect(failingReview.body.review.blockers[0]).toMatch(/^The check did not pass: .*locations holds up to 2 rows for one key/);
      const failed = await call('/api/app-datasets/joins/certify', { sourceId: created.body.sourceId, joinId: 'location' });
      expect(failed.status, failed.text).toBe(422);
      expect(failed.body.code).toBe('JOIN_CHECK_FAILED');
      expect(modelFiles(projectRoot)).toEqual(beforeFailure);

      // Fixed in the data: the setup draft's join certifies, and leaves the draft.
      await stop();
      await executor.executePositional("DELETE FROM main.locations WHERE location_name = 'Brooklyn (old)'", [], connection);
      base = await start();
      const draftedCertified = await call('/api/app-datasets/joins/certify', { sourceId: created.body.sourceId, joinId: 'location' });
      expect(draftedCertified.status, draftedCertified.text).toBe(200);
      const afterDrafted = await descriptorOf();
      expect(afterDrafted.joins.map((join: Json) => [join.id, join.origin, join.trust])).toEqual([
        ['customer', 'model', 'certified'],
        ['location', 'model', 'certified'],
      ]);
      const draftedProposal = await call(`/api/context-proposals/${encodeURIComponent(drafted.body.proposal.id)}`);
      expect(draftedProposal.body.proposal.status).toBe('discarded');

      // The model changes under the certification (a side's grain moved): the join is not certified any
      // more, and the date it was certified is kept for "Changed since it was certified on …".
      const entitiesPath = Object.keys(modelFiles(projectRoot)).find((path) => readFileSync(join(projectRoot, path), 'utf-8').includes('grain: customer_id'))!;
      writeFileSync(join(projectRoot, entitiesPath), readFileSync(join(projectRoot, entitiesPath), 'utf-8').replace('grain: customer_id', 'grain: customer'));
      // The project notices the edit on its own (file watching), as it does for any hand edit.
      await expect.poll(async () => (await descriptorOf()).joins.find((join: Json) => join.id === 'customer').trust, { timeout: 20_000, interval: 500 }).toBe('review_required');
      const stale = (await descriptorOf()).joins.find((join: Json) => join.id === 'customer');
      expect(stale.changedSinceCertified?.at).toBe(toCustomers.certifiedAgainst.certifiedAt);
      const staleReview = await call(`/api/app-datasets/joins/certify-review?sourceId=${encodeURIComponent(created.body.sourceId)}&joinId=customer`);
      expect(staleReview.body.review.previousCertification?.at).toBe(toCustomers.certifiedAgainst.certifiedAt);
    } finally {
      await stop();
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
