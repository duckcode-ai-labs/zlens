import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

/** "Fix with AI & run" on a missing certification field: filled from the query and its result, in the editor only. */
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function serve(columns: string[], hosted = false) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-certification-prefill-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'prefill', connections: { default: { driver: 'duckdb', filepath: ':memory:' } } }));
  mkdirSync(join(projectRoot, 'blocks'), { recursive: true });
  const executor = { executeQuery: async () => ({ columns: columns.map((name) => ({ name, type: 'VARCHAR' })), rows: [Object.fromEntries(columns.map((name) => [name, 'x']))], rowCount: 1, executionTime: 1 }) } as unknown as QueryExecutor;
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor, preferredPort: 0,
    ...(hosted ? { hostHooks: { enterpriseCertification: true, resolvePrincipal: () => ({ id: 'u-dan', kind: 'person' as const, email: 'dan@harbor.example', source: 'host' as const }) } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  return async (body: unknown, path = '/api/block-studio/certification-prefill') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
  };
}

const block = (query: string) => `block "West claims" {\n  status = "draft"\n  domain = "claims"\n  type = "custom"\n  owner = "claims-team"\n  query = """${query}"""\n}\n`;

describe('POST /api/block-studio/certification-prefill', () => {
  it('fills outputs from the result, grain from the GROUP BY, source systems from the SQL, and a safe test', async () => {
    const post = await serve(['region', 'open_claims']);
    const { status, body, text } = await post({ source: block('SELECT region, COUNT(*) AS open_claims FROM claims GROUP BY region') });
    expect(status, text.slice(0, 300)).toBe(200);
    expect(body.source).toContain('grain = "one row per region"');
    expect(body.source).toContain('outputs = ["region", "open_claims"]');
    expect(body.source).toContain('reviewCadence = "quarterly"');
    expect(body.source).toContain('sourceSystems = ["claims"]');
    expect(body.source).toMatch(/tests \{\s+assert row_count > 0\s+\}/);
    expect(body.unknown).toEqual([]);
    expect(body.preview.result.columns).toEqual(['region', 'open_claims']);
  });

  it('reads outputs from the run when the SQL cannot name them, and says what it could not fill', async () => {
    const post = await serve(['claim_id', 'region']);
    const { body } = await post({ source: block('SELECT * FROM claims') });
    expect(body.source).toContain('outputs = ["claim_id", "region"]');
    expect(body.unknown).toEqual(['grain']);
    expect(body.source).not.toContain('grain =');
  });

  it('turns every missing field into a fix the builder can do, under every gate', async () => {
    const post = await serve(['region', 'open_claims'], true);
    const draft = block('SELECT region, COUNT(*) AS open_claims FROM claims GROUP BY region');
    const before = await post({ source: draft }, '/api/block-studio/certification-check');
    expect(before.status, before.text.slice(0, 300)).toBe(200);
    const fields = before.body.checklist.issues.filter((issue: { action?: string }) => issue.action === 'fill_certification_fields');
    expect(fields.map((issue: { code: string }) => issue.code).sort()).toEqual([
      'certification_field_grain', 'certification_field_outputs', 'certification_field_reviewCadence', 'certification_field_sourceSystems', 'certification_field_tests',
    ]);
    expect(fields.find((issue: { code: string }) => issue.code === 'certification_field_reviewCadence').title).toBe('Add the review cadence');
    expect(fields.find((issue: { code: string }) => issue.code === 'certification_field_tests').title).toBe('Add a test');

    const filled = await post({ source: draft });
    const after = await post({ source: filled.body.source }, '/api/block-studio/certification-check');
    expect(after.body.checklist.issues.filter((issue: { action?: string }) => issue.action === 'fill_certification_fields')).toEqual([]);
  });

  it('refuses an empty source', async () => {
    const post = await serve([]);
    expect((await post({ source: ' ' })).status).toBe(400);
  });
});
