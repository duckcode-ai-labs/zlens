import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { readEnv } from '@zlens/core';
import { datasetFieldValueSearchText, startLocalServer } from '../local-runtime.js';

/**
 * A filter's value list searches every value of the field (phase-2 new-user
 * review, problem 3): the first page browses 200 values and says how many
 * exist; typed text is searched on the server with a bound, escaped ILIKE on
 * the governed field, so a customer past the first 200 is found. Real DuckDB;
 * needs ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT.
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

describe('filter value search', () => {
  it('reads search text trimmed and bounded', () => {
    expect(datasetFieldValueSearchText('  Lori ')).toBe('Lori');
    expect(datasetFieldValueSearchText(42)).toBe('');
    expect(datasetFieldValueSearchText('x'.repeat(300))).toHaveLength(200);
  });

  duckDbIt('browses the first 200 values with a count, and searches every value on the server', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-field-values-'));
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
      // 261 contacts: 259 "Contact NNN", one past the first page alphabetically,
      // and one whose name holds LIKE wildcards.
      await executor.executePositional([
        'CREATE TABLE main.crm_contacts AS',
        "SELECT 'K-' || lpad(CAST(i AS VARCHAR), 3, '0') AS contact_id, 'Contact ' || lpad(CAST(i AS VARCHAR), 3, '0') AS contact_name, TIMESTAMP '2025-01-01 00:00:00' + i * INTERVAL 1 DAY AS signed_up_on, CAST(i AS DOUBLE) AS spend",
        'FROM range(1, 260) AS t(i)',
        "UNION ALL SELECT 'K-900', 'Zelda Zimmer', TIMESTAMP '2025-12-01 00:00:00', 10.0",
        "UNION ALL SELECT 'K-901', 'Ann 100%_Real', TIMESTAMP '2025-12-02 00:00:00', 20.0",
      ].join('\n'), [], connection);
      // 930 leads: more values than one run returns (its 500-row screen cap).
      await executor.executePositional("CREATE TABLE main.crm_leads AS SELECT 'L-' || lpad(CAST(i AS VARCHAR), 4, '0') AS lead_id, 'Lead ' || lpad(CAST(i AS VARCHAR), 4, '0') AS lead_name, CAST(i AS DOUBLE) AS score FROM range(1, 931) AS t(i)", [], connection);
      const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection, preferredPort: 0, captureServer: (created) => { server = created; } });
      const base = `http://127.0.0.1:${port}`;
      const tables = await call(base, '/api/app-datasets/tables');
      expect(tables.status, tables.text).toBe(200);
      const contacts = tables.body.tables.find((table: { name: string }) => table.name === 'crm_contacts');
      const created = await call(base, '/api/app-datasets/tables/create', { tableId: contacts.id, name: 'Contacts', domain: 'commerce' });
      expect(created.status, created.text).toBe(201);
      const sourceId = created.body.sourceId as string;

      // Browsing: the first page, and how many values exist.
      const browse = await call(base, '/api/app-datasets/field-values', { sourceId, field: 'contact_name' });
      expect(browse.status, browse.text).toBe(200);
      expect(browse.body).toMatchObject({ ok: true, truncated: true, valueCount: 261 });
      expect(browse.body.values).toHaveLength(200);
      expect(browse.body.values).not.toContain('Zelda Zimmer');

      // Searching finds a value past the first page, ignoring case.
      const zelda = await call(base, '/api/app-datasets/field-values', { sourceId, field: 'contact_name', search: 'zELDa' });
      expect(zelda.status, zelda.text).toBe(200);
      expect(zelda.body).toMatchObject({ ok: true, values: ['Zelda Zimmer'], truncated: false, search: 'zELDa' });
      expect(zelda.body.valueCount).toBeUndefined();

      // Typed text is literal: % and _ are not wildcards.
      const literal = await call(base, '/api/app-datasets/field-values', { sourceId, field: 'contact_name', search: '100%_' });
      expect(literal.body).toMatchObject({ ok: true, values: ['Ann 100%_Real'], truncated: false });
      const wildcard = await call(base, '/api/app-datasets/field-values', { sourceId, field: 'contact_name', search: '%' });
      expect(wildcard.body.values).toEqual(['Ann 100%_Real']);

      // A broad search returns one page of matches and says more exist.
      const broad = await call(base, '/api/app-datasets/field-values', { sourceId, field: 'contact_name', search: 'contact' });
      expect(broad.body).toMatchObject({ ok: true, truncated: true });
      expect(broad.body.values).toHaveLength(200);

      // A search with no match is an empty list, not an error.
      const none = await call(base, '/api/app-datasets/field-values', { sourceId, field: 'contact_name', search: 'Lori Butler' });
      expect(none.body).toMatchObject({ ok: true, values: [], truncated: false });

      // More values than one run returns: the count is the field's, not the run's 500 rows.
      const leads = tables.body.tables.find((table: { name: string }) => table.name === 'crm_leads');
      const leadSource = (await call(base, '/api/app-datasets/tables/create', { tableId: leads.id, name: 'Leads', domain: 'commerce' })).body.sourceId as string;
      const leadValues = await call(base, '/api/app-datasets/field-values', { sourceId: leadSource, field: 'lead_name' });
      expect(leadValues.status, leadValues.text).toBe(200);
      expect(leadValues.body).toMatchObject({ ok: true, truncated: true, valueCount: 930 });
      expect(leadValues.body.valueCountCapped).toBeUndefined();

      // The search is a governed field query: only approved groupable fields.
      const unknown = await call(base, '/api/app-datasets/field-values', { sourceId, field: 'not_a_field', search: 'x' });
      expect(unknown.status).toBe(400);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      await executor.disconnect();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
