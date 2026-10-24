import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { SemanticLayer } from '@zlens/core';
import { exactSemanticImportMatch, startLocalServer } from './local-runtime.js';

/**
 * Import SQL turns a query into a draft block that runs that query. It becomes
 * a semantic block only when the SQL is exactly a metric query; an output named
 * like a metric (`order_count`) is not enough: the import's GROUP BY, joins and
 * filters would be lost (a two-row ranking previewed as one total of every order).
 */

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const ORDERS_BY_LOCATION = `select l.location_name, count(*) as order_count
from dev.orders o
join dev.locations l on o.location_id = l.location_id
group by 1
order by 2 desc`;

const post = async (base: string, path: string, body: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
};

describe('Import SQL keeps the imported query', () => {
  it('previews the imported SQL even when an output is named like a semantic metric', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-import-keeps-sql-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({
      project: 'import_keeps_sql',
      semanticLayer: { provider: 'dql', path: 'semantic-layer' },
    }));
    mkdirSync(join(projectRoot, 'semantic-layer', 'metrics'), { recursive: true });
    writeFileSync(join(projectRoot, 'semantic-layer', 'metrics', 'order_count.yaml'), [
      'name: order_count',
      'label: Order count',
      'description: Number of orders',
      'domain: commerce',
      'sql: "1"',
      'type: sum',
      'table: orders',
      '',
    ].join('\n'));
    mkdirSync(join(projectRoot, 'domains/commerce/blocks'), { recursive: true });
    const executed: string[] = [];
    const executor = {
      executeQuery: vi.fn(async (sql: string) => {
        executed.push(sql);
        return {
          columns: ['location_name', 'order_count'],
          rows: [{ location_name: 'Philadelphia', order_count: 40000 }, { location_name: 'Brooklyn', order_count: 21948 }],
          rowCount: 2,
          executionTime: 1,
        };
      }),
    } as unknown as QueryExecutor;
    let server: Server | undefined;
    try {
      const port = await startLocalServer({
        rootDir: projectRoot,
        projectRoot,
        executor,
        connection: { driver: 'file' },
        preferredPort: 0,
        captureServer: (created) => { server = created; },
      });
      const base = `http://127.0.0.1:${port}`;
      const session = await post(base, '/api/block-studio/ai-imports', {
        inputMode: 'paste',
        sources: [{ path: 'pasted.sql', content: ORDERS_BY_LOCATION }],
        domain: 'commerce',
        owner: 'analytics@jaffle.shop',
      });
      expect(session.status, session.text).toBe(200);
      const candidate = session.body.candidates[0];
      expect(candidate.dqlSource).toContain('type = "custom"');
      expect(candidate.dqlSource).toMatch(/join dev\.locations/i);
      expect(candidate.dqlSource).not.toMatch(/metrics?\s*=\s*\[?\s*"order_count"/);
      // The draft says its output shares the metric's name, so a reviewer can choose.
      expect(candidate.conversionNotes).toContainEqual(expect.stringContaining('semantic metric order_count'));

      executed.length = 0;
      const preview = await post(base, `/api/block-studio/ai-imports/${encodeURIComponent(session.body.id)}/candidates/${encodeURIComponent(candidate.id)}/preview`, {});
      expect(preview.status, preview.text).toBe(200);
      expect(executed.join('\n')).toMatch(/join dev\.locations/i);
      expect(executed.join('\n')).toMatch(/group by 1/i);
      expect(preview.body.preview.result.rowCount).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    }
  }, 60_000);
});

describe('exactSemanticImportMatch', () => {
  const layer = new SemanticLayer({
    metrics: [
      { name: 'total_revenue', label: 'Total Revenue', description: '', domain: 'finance', sql: 'SUM(revenue)', type: 'sum', table: 'orders' },
      { name: 'order_count', label: 'Order count', description: '', domain: 'finance', sql: '1', type: 'sum', table: 'orders' },
    ],
    dimensions: [{ name: 'region', label: 'Region', description: '', domain: 'finance', sql: 'region', type: 'string', table: 'orders' }],
    hierarchies: [], segments: [], preAggregations: [], measures: [], entities: [], semanticModels: [], savedQueries: [],
  });

  it('matches a query that is exactly a metric by a dimension, by name or position', () => {
    expect(exactSemanticImportMatch('SELECT region, SUM(revenue) AS total_revenue FROM orders GROUP BY region;', layer))
      .toEqual({ metrics: ['total_revenue'], dimensions: ['region'] });
    expect(exactSemanticImportMatch('select o.region, sum(o.revenue) as total_revenue from analytics.orders o group by 1', layer))
      .toEqual({ metrics: ['total_revenue'], dimensions: ['region'] });
    expect(exactSemanticImportMatch('select sum(revenue) as total_revenue from orders', layer))
      .toEqual({ metrics: ['total_revenue'], dimensions: [] });
  });

  it.each([
    ['a join', 'select l.region, sum(o.revenue) as total_revenue from orders o join locations l on o.id = l.id group by 1'],
    ['a filter', "select region, sum(revenue) as total_revenue from orders where region <> 'test' group by 1"],
    ['an ungrouped column (GROUP BY 1 dropped)', 'select region, sum(revenue) as total_revenue from orders'],
    ['a different aggregate under the metric name', 'select region, count(*) as order_count from orders group by 1'],
    ['another table', 'select region, sum(revenue) as total_revenue from refunds group by 1'],
    ['an ORDER BY or LIMIT', 'select region, sum(revenue) as total_revenue from orders group by 1 order by 2 desc limit 5'],
    ['a renamed column', 'select region as area, sum(revenue) as total_revenue from orders group by 1'],
    ['an unknown output', 'select region, sum(revenue) as total_revenue, max(ordered_at) as last_order from orders group by 1'],
  ])('keeps the SQL for %s', (_label, sql) => {
    expect(exactSemanticImportMatch(sql, layer)).toBeNull();
  });
});
