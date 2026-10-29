import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import { readEnv } from '@zlens/core';

const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/app-datasets-pilot');
const seedWarehouse = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/seed-eval-warehouse.mjs');

/**
 * RFC 0010 key proofs: `POST /api/keys/prove` runs DQL's own grain proof for
 * every certified block Dataset that declares keys (and its relationship
 * validation for certified joins), as the caller, and answers counts and
 * outcomes only — never a row or a key value.
 */
describe('POST /api/keys/prove', () => {
  duckDbIt('proves each certified Dataset\'s declared keys, narrows to the blocks asked for, and fails a key that does not hold', async () => {
    const root = connectorRoot!;
    const duckdb = createRequire(join(root, 'package.json'))('@duckdb/node-api') as { DuckDBInstance?: unknown };
    expect(typeof duckdb.DuckDBInstance).toBe('function');
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-key-proofs-'));
    const databasePath = join(projectRoot, 'app-datasets-pilot.duckdb');
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: databasePath, moduleSearchPaths: [root] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      cpSync(fixtureRoot, projectRoot, { recursive: true });
      mkdirSync(join(projectRoot, '.dql', 'connectors'), { recursive: true });
      symlinkSync(join(root, 'node_modules'), join(projectRoot, '.dql', 'connectors', 'node_modules'), 'dir');
      execFileSync(process.execPath, [seedWarehouse, '--seed', join(projectRoot, 'seeds', 'seed.json'), '--connector-root', root, '--out', databasePath], { stdio: 'pipe' });
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const prove = async (body: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/keys/prove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, text: await response.text() };
      };

      const all = await prove({});
      expect(all.status, all.text).toBe(200);
      const proved = JSON.parse(all.text) as { ok: boolean; proved: number; datasets: Array<Record<string, unknown>>; relationships: unknown[] };
      expect(proved.ok).toBe(true);
      expect(proved.datasets.map((item) => item.name).sort()).toEqual(['Customer daily Dataset', 'Order lines Dataset']);
      const orderLines = proved.datasets.find((item) => item.name === 'Order lines Dataset')!;
      expect(orderLines).toMatchObject({ kind: 'dataset', status: 'passed', keys: ['order_line_id'], filePath: 'domains/commerce/blocks/order-lines-dataset.dql', sourceId: expect.stringMatching(/^app:block:commerce:[0-9a-f]{20}$/) });
      const uniqueness = orderLines.uniqueness as Record<string, number>;
      expect(uniqueness.duplicateKeyCount).toBe(0);
      expect(uniqueness.nullKeyCount).toBe(0);
      expect(uniqueness.rowCount).toBeGreaterThan(0);
      expect(uniqueness.distinctKeyCount).toBe(uniqueness.rowCount);
      // Counts and outcomes only: every field is one of these, never a row.
      for (const item of proved.datasets) expect(Object.keys(item).sort()).toEqual(['filePath', 'keys', 'kind', 'name', 'sourceId', 'status', 'uniqueness']);
      expect(proved.relationships).toEqual([]);

      const narrowed = JSON.parse((await prove({ blocks: ['domains/commerce/blocks/order-lines-dataset.dql'] })).text) as { datasets: Array<{ name: string }> };
      expect(narrowed.datasets.map((item) => item.name)).toEqual(['Order lines Dataset']);

      // A key that does not hold: many order lines share an order.
      const file = join(projectRoot, 'domains/commerce/blocks/order-lines-dataset.dql');
      writeFileSync(file, readFileSync(file, 'utf8').replace('keys = ["order_line_id"]', 'keys = ["order_id"]').replace('order_line_id { role = "key"', 'order_line_id { role = "dimension"').replace('order_id { role = "dimension"', 'order_id { role = "key"'));
      const broken = JSON.parse((await prove({ blocks: ['Order lines Dataset'] })).text) as { ok: boolean; datasets: Array<{ status: string; uniqueness?: Record<string, number> }> };
      expect(broken.ok).toBe(false);
      expect(broken.datasets).toHaveLength(1);
      expect(['failed', 'error']).toContain(broken.datasets[0].status);
      if (broken.datasets[0].status === 'failed') expect(broken.datasets[0].uniqueness!.duplicateKeyCount).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
