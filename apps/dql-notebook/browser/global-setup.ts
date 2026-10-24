import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCli, installDuckdbConnector, repoRoot, run, startNotebookServer } from './support/server';

/**
 * Prepare and start the product the journeys test:
 *   1. build the CLI (it bundles the notebook app) unless E2E_SKIP_BUILD=1;
 *   2. copy the jaffle-supply-chain fixture to a temp dir and seed a DuckDB file;
 *   3. add one notebook and one App (the fixture has none);
 *   4. start `node apps/cli/dist/index.js notebook` on a free port, with
 *      cassette replay, and wait for /api/health.
 * The server URL is passed to the journeys in ZLENS_E2E_BASE_URL. The returned
 * function stops the server and deletes the temp dir.
 */

const fixtureDir = join(repoRoot, 'apps/cli/test/fixtures/jaffle-supply-chain');

/**
 * Copy the fixture and seed its warehouse. A journey that runs its own server
 * (app-data-step.journey.ts) passes the connector install global setup made,
 * so DuckDB is not installed twice.
 */
export function seedProject(projectDir: string, options: { connectorRoot?: string } = {}): void {
  cpSync(fixtureDir, projectDir, { recursive: true });

  let connectorRoot: string;
  if (options.connectorRoot && existsSync(options.connectorRoot)) {
    connectorRoot = join(projectDir, '.dql', 'connectors');
    cpSync(options.connectorRoot, connectorRoot, { recursive: true });
  } else {
    connectorRoot = installDuckdbConnector(projectDir);
    // Journeys that build their own project (database-only.journey.ts) reuse this install.
    process.env.ZLENS_E2E_DUCKDB_CONNECTORS = connectorRoot;
  }
  const warehouse = join(projectDir, 'jaffle_shop.duckdb');
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--out', warehouse, '--schema', 'dev']);
  // The fixture's certified blocks read unqualified tables (top_customers:
  // `FROM dim_customers`), so the smoke App's tile only returns rows when the
  // same tables also exist in the default schema. The App filter journey needs
  // real rows to show a filter narrowing them.
  run('node', [join(repoRoot, 'scripts/seed-eval-warehouse.mjs'), '--connector-root', connectorRoot, '--out', warehouse]);
  if (!existsSync(warehouse) || statSync(warehouse).size < 1000) {
    throw new Error(`Seeded warehouse missing or empty: ${warehouse}`);
  }

  const configPath = join(projectDir, 'dql.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.connections = { ...(config.connections ?? {}), default: { driver: 'duckdb', filepath: warehouse } };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  // Journey content the fixture lacks. The notebook's cells print values that
  // do not appear in their own source, so a journey can tell "ran" from "shown".
  mkdirSync(join(projectDir, 'notebooks'), { recursive: true });
  writeFileSync(join(projectDir, 'notebooks', 'smoke.dqlnb'), `${JSON.stringify({
    dqlnbVersion: 1,
    version: 1,
    title: 'Smoke notebook',
    metadata: { title: 'Smoke notebook', description: 'Browser smoke journey.' },
    cells: [
      { id: 'intro', type: 'markdown', title: 'Intro', source: '# Smoke notebook' },
      {
        id: 'seeded_check',
        type: 'sql',
        title: 'Seeded check',
        source: "select 'smoke-' || cast(count(*) > 0 as varchar) as marker from dev.dim_customers",
      },
    ],
  }, null, 2)}\n`);

  const appDir = join(projectDir, 'apps', 'smoke-orders');
  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  writeFileSync(join(appDir, 'dql.app.json'), `${JSON.stringify({
    version: 1,
    id: 'smoke-orders',
    name: 'Smoke Orders',
    description: 'App used by the browser smoke journeys.',
    visibility: 'shared',
    domain: 'orders',
    lifecycle: 'review',
    owners: ['analytics@example.com'],
    tags: ['smoke'],
  }, null, 2)}\n`);
  writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), `${JSON.stringify({
    version: 1,
    id: 'overview',
    metadata: {
      title: 'Orders overview',
      description: 'One certified block.',
      domain: 'orders',
      visibility: 'shared',
      lifecycle: 'review',
      tags: ['smoke'],
    },
    layout: {
      kind: 'grid',
      cols: 12,
      rowHeight: 80,
      items: [{ i: 'top-customers', x: 0, y: 0, w: 6, h: 4, block: { blockId: 'top_customers' }, viz: { type: 'table' }, title: 'Top customers' }],
    },
  }, null, 2)}\n`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  buildCli();

  const workDir = mkdtempSync(join(tmpdir(), 'dql-browser-e2e-'));
  const projectDir = join(workDir, 'project');
  let server: Awaited<ReturnType<typeof startNotebookServer>>;
  try {
    seedProject(projectDir);
    server = await startNotebookServer({
      projectDir,
      workDir,
      env: {
        // Replay recorded model responses; a miss is an error and never reaches a live model.
        ZLENS_EVAL_CASSETTE_DIR: join(projectDir, 'test-cassettes', 'answerability'),
        ZLENS_EVAL_CASSETTE_MODE: 'replay',
      },
    });
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
  process.env.ZLENS_E2E_BASE_URL = server.baseUrl;
  return async () => {
    await server.stop();
    rmSync(workDir, { recursive: true, force: true });
  };
}
