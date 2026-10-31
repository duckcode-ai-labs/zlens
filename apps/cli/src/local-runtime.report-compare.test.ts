import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

/**
 * Comparing with an old report on a server. The comparison reads as the person
 * asking, so it must not reach what the host keeps from them, and a result
 * their row rules narrowed can't be written down as everyone's.
 */

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-report-compare-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'report_compare' }));
  mkdirSync(join(root, 'semantic-layer/metrics/_drafts/sales'), { recursive: true });
  mkdirSync(join(root, 'semantic-layer/dimensions/_drafts/sales'), { recursive: true });
  mkdirSync(join(root, 'blocks/sales'), { recursive: true });
  writeFileSync(join(root, 'semantic-layer/metrics/_drafts/sales/total_sales.yaml'), 'name: total_sales\nlabel: Total Sales\ndescription: x\ndomain: sales\nsql: sales\ntype: sum\ntable: orders\ntags: []\nowner: x\n');
  writeFileSync(join(root, 'semantic-layer/dimensions/_drafts/sales/region.yaml'), 'name: region\nlabel: Region\ndescription: x\nsql: region\ntype: string\ntable: orders\ntags: []\n');
  writeFileSync(join(root, 'blocks/sales/revenue.dql'), 'block "Revenue" {\n  domain = "sales"\n  type = "custom"\n  owner = "x"\n  description = "Revenue by region."\n  query = """select region, sum(sales) as revenue from orders group by 1"""\n}\n');
  return root;
}

const person = { id: 'u-p', kind: 'person', email: 'p@example.test', source: 'host' };

async function serve(root: string, hostHooks?: Record<string, unknown>) {
  const executeQuery = vi.fn(async () => ({ columns: ['region', 'total_sales'], rows: [{ region: 'East', total_sales: 10.5 }], rowCount: 1, executionTime: 1 }));
  const executor = { executeQuery } as unknown as QueryExecutor;
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor,
    connection: { driver: 'file' },
    preferredPort: 0,
    ...(hostHooks ? { hostHooks: { resolvePrincipal: () => person, ...hostHooks } } : {}),
    captureServer: (created: Server) => { servers.push(created); },
  } as Parameters<typeof startLocalServer>[0]);
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, text: await response.text() };
  };
  return { post, get, executeQuery };
}

/** Listing the tables is not reading them. */
const readsOfTheData = (executeQuery: ReturnType<typeof vi.fn>) => executeQuery.mock.calls.map((call) => String(call[0])).filter((sql) => /\borders\b/i.test(sql));

const file = (text: string) => ({ name: 'Sales.csv', base64: Buffer.from(text).toString('base64') });
const byRegion = file('Region,Total Sales\nEast,$10.50\n');
const recordPath = 'semantic-layer/report-matches/metric/total_sales.yaml';

describe('comparing on a person\'s own computer', () => {
  it('compares, and says the record comes with it', async () => {
    const root = newProject();
    const { post } = await serve(root);
    const compared = await post('/api/report-match/compare', { file: byRegion });
    expect(compared.status, JSON.stringify(compared.body)).toBe(200);
    expect(compared.body).toMatchObject({ recording: 'with-compare', comparison: { comparison: { verdict: 'matches' } } });
    expect((await post('/api/report-match/record', { id: compared.body.comparison.id, via: 'screen' })).body.recorded).toEqual([recordPath]);
    expect(existsSync(join(root, recordPath))).toBe(true);
  });

  it('refuses an option of the wrong type rather than dropping a filter', async () => {
    const { post, executeQuery } = await serve(newProject());
    const refused = await post('/api/report-match/compare', { file: byRegion, filters: 'region = East' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain('filters must be a list');
    expect(executeQuery).not.toHaveBeenCalled();
  });
});

describe('comparing on a server', () => {
  it('does not run a metric the host keeps from this person', async () => {
    const { post, executeQuery } = await serve(newProject(), {
      sourceAccess: async (_person: unknown, sources: Array<{ id: string; name: string }>) => sources.filter((source) => source.name !== 'total_sales').map((source) => source.id),
    });
    const compared = await post('/api/report-match/compare', { file: byRegion });
    expect(compared.body.comparison.target.metrics).toEqual([]);
    expect(compared.body.comparison.mapping['Total Sales']).toContain('not compared');
    expect(compared.body.comparison.comparison.verdict).not.toBe('matches');
    expect(readsOfTheData(executeQuery)).toEqual([]);
  });

  it('does not run a saved query the host keeps from this person', async () => {
    const { post, executeQuery } = await serve(newProject(), {
      sourceAccess: async (_person: unknown, sources: Array<{ id: string; name: string }>) => sources.filter((source) => source.name !== 'Revenue').map((source) => source.id),
    });
    const refused = await post('/api/report-match/compare', { file: file('region,revenue\nEast,1\n'), query: 'Revenue' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("don't have access");
    expect(readsOfTheData(executeQuery)).toEqual([]);
  });

  it('keeps a result row rules narrowed to the person, unrecorded', async () => {
    const root = newProject();
    const { post } = await serve(root, { rowPolicy: ({ sql }: { sql: string }) => ({ sql }) });
    const compared = await post('/api/report-match/compare', { file: byRegion });
    expect(compared.body.recording).toBe('refused');
    const refused = await post('/api/report-match/record', { id: compared.body.comparison.id, via: 'screen' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ROW_RULES_NARROWED');
    expect(existsSync(join(root, recordPath))).toBe(false);
  });

  it('records as a second step, for someone who may author', async () => {
    const root = newProject();
    const { post } = await serve(root, { figuresDependOnReader: () => false });
    const compared = await post('/api/report-match/compare', { file: byRegion });
    expect(compared.body.recording).toBe('separate');
    expect(existsSync(join(root, recordPath))).toBe(false);
    expect((await post('/api/report-match/record', { id: compared.body.comparison.id, via: 'screen' })).status).toBe(200);
    expect(existsSync(join(root, recordPath))).toBe(true);
  });

  it('keeps a record from a person the host keeps its metric from', async () => {
    const root = newProject();
    mkdirSync(join(root, 'semantic-layer/report-matches/metric'), { recursive: true });
    writeFileSync(join(root, recordPath), "matches:\n  - report: ACME renewal Q3\n    comparedBy: alice@example.test\n    comparedAt: '2026-11-02T10:14:03Z'\n    connection: { driver: file }\n    querySha256: x\n    values: { compared: 1, equal: 1 }\n    precision: 2 decimals\n    scope: all rows\n    verdict: matches\n");
    const { get } = await serve(root, {
      figuresDependOnReader: () => false,
      sourceAccess: async (_person: unknown, sources: Array<{ id: string; name: string }>) => sources.filter((source) => source.name !== 'total_sales').map((source) => source.id),
    });
    const file = await get(`/api/notebook/file?path=${encodeURIComponent(recordPath)}`);
    expect(file.status).toBe(403);
    expect(file.text).not.toContain('ACME');
    const drafts = await get('/api/semantic-layer/metric-drafts');
    expect(drafts.status).toBe(200);
    expect(drafts.text).not.toContain('ACME');
    expect(drafts.text).not.toContain('total_sales');
  });

  it('refuses the record to someone who may run but not author', async () => {
    const root = newProject();
    const { post } = await serve(root, { figuresDependOnReader: () => false, authorize: (_person: unknown, action: string) => ({ allow: action !== 'dataset.author' }) });
    const compared = await post('/api/report-match/compare', { file: byRegion });
    expect(compared.status).toBe(200);
    expect((await post('/api/report-match/record', { id: compared.body.comparison.id, via: 'screen' })).status).toBe(403);
    expect(existsSync(join(root, recordPath))).toBe(false);
  });
});
