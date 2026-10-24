import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { startLocalServer } from './local-runtime.js';

/**
 * Codex end-to-end report F02, on real DuckDB through the local runtime: a
 * saved query column's values for the reader's "Filter by…" picker list a
 * first page with the column's count, and typed text finds a value past that
 * page (customer 501), as literal text. Needs a DuckDB connector root
 * (ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT).
 */
const connectorRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const duckDbIt = connectorRoot ? it : it.skip;

describe('saved query filter values on DuckDB (Codex F02)', () => {
  duckDbIt('lists a first page with a count and searches every value', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-saved-query-values-'));
    const connection: ConnectionConfig = { driver: 'duckdb', filepath: join(projectRoot, 'shop.duckdb'), moduleSearchPaths: [connectorRoot!] };
    const executor = new QueryExecutor();
    let server: Server | undefined;
    try {
      const projectConnectorRoot = join(projectRoot, '.dql', 'connectors');
      mkdirSync(projectConnectorRoot, { recursive: true });
      symlinkSync(join(connectorRoot!, 'node_modules'), join(projectConnectorRoot, 'node_modules'), 'dir');
      writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
        project: 'shop', connections: { default: { driver: 'duckdb', filepath: './shop.duckdb' } },
      }));
      const blockDir = join(projectRoot, 'domains', 'commerce', 'blocks');
      mkdirSync(blockDir, { recursive: true });
      writeFileSync(join(blockDir, 'customer_profile.dql'), `block "customer_profile" {
  domain = "commerce"
  type = "custom"
  status = "certified"
  owner = "analytics@example.com"
  outputs = ["customer_name", "lifetime_spend"]
  query = """SELECT customer_name, lifetime_spend FROM main.customers"""
}`);
      await executor.executePositional('CREATE TABLE main.customers (customer_name VARCHAR, lifetime_spend DOUBLE)', [], connection);
      await executor.executePositional(
        `INSERT INTO main.customers SELECT 'Customer ' || lpad(CAST(i AS VARCHAR), 4, '0'), i FROM range(1, 931) t(i)`,
        [], connection,
      );
      await executor.executePositional("INSERT INTO main.customers VALUES ('Keith Cook', 1764.68), ('100% _Literal', 1), ('O''Brien', 2), ('Zed', 3), ('Zed', 4)", [], connection);
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const values = async (query: string) => {
        const response = await fetch(`${base}/api/dashboard/filter-options?block=customer_profile&column=customer_name&${query}`);
        const text = await response.text();
        expect(response.status, text).toBe(200);
        return JSON.parse(text) as { options: string[]; truncated: boolean; valueCount?: number; valueCountCapped?: boolean; search?: string };
      };

      // Browsing: the first 200 values and how many there are (934 distinct names).
      const browse = await values('limit=200');
      expect(browse.options).toHaveLength(200);
      expect(browse.truncated).toBe(true);
      expect(browse.valueCount).toBe(934);
      expect(browse.options).not.toContain('Keith Cook');

      // Typed text searches every value, ignoring case.
      const keith = await values('limit=200&search=kEITH');
      expect(keith).toMatchObject({ options: ['Keith Cook'], truncated: false, search: 'kEITH' });
      expect(keith.valueCount).toBeUndefined();

      // The search is literal text: % and _ are data, quotes stay data.
      expect((await values(`limit=200&search=${encodeURIComponent('100%')}`)).options).toEqual(['100% _Literal']);
      expect((await values(`limit=200&search=${encodeURIComponent('%')}`)).options).toEqual(['100% _Literal']);
      expect((await values(`limit=200&search=${encodeURIComponent("O'Bri")}`)).options).toEqual(["O'Brien"]);
      expect((await values('limit=200&search=nobody-here')).options).toEqual([]);

      // A short list is complete: no count needed.
      const zed = await values('limit=200&search=zed');
      expect(zed).toMatchObject({ options: ['Zed'], truncated: false });
    } finally {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
