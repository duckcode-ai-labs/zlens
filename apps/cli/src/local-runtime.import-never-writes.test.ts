import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

/**
 * Import SQL previews every statement of a pasted file or folder as soon as
 * the drafts are made. Legacy SQL folders hold cleanup and load steps next to
 * the reports, so a DROP, CREATE or DELETE among them must be refused, never
 * run against the warehouse. Certify runs the same check.
 */

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

const LEGACY_FILE = `-- name: Weekly orders
select date_trunc('week', ordered_at) as week, count(*) as orders from dev.orders group by 1;
-- cleanup step from the old nightly job
drop table dev.orders;
create table dev.order_snapshot as select * from dev.orders;
delete from dev.orders where ordered_at < '2020-01-01'`;

const WRITES = /\b(drop|create|delete|insert|update|truncate|alter)\b/i;

const post = async (base: string, path: string, body: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
};

async function withServer(run: (base: string, executed: string[]) => Promise<void>): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-import-never-writes-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'import_never_writes' }));
  const executed: string[] = [];
  const executor = {
    executeQuery: vi.fn(async (sql: string) => {
      executed.push(sql);
      return { columns: ['week', 'orders'], rows: [{ week: '2024-01-01', orders: 3 }], rowCount: 1, executionTime: 1 };
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
    await run(`http://127.0.0.1:${port}`, executed);
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  }
}

describe('Import SQL never runs a statement that writes', () => {
  it('makes a draft of the SELECT only, lists the DROP, CREATE and DELETE as skipped, and runs none of them', async () => {
    await withServer(async (base, executed) => {
      const session = await post(base, '/api/block-studio/ai-imports', {
        inputMode: 'paste',
        sources: [{ path: 'nightly.sql', content: LEGACY_FILE }],
        domain: 'commerce',
        owner: 'analytics@jaffle.shop',
        persistence: 'session-only',
      });
      expect(session.status, session.text).toBe(200);
      const candidates = session.body.candidates as Array<{ id: string; sql: string }>;
      expect(candidates).toHaveLength(1);
      expect(session.body.skippedStatements.map((item: { kind: string; reason: string }) => [item.kind, item.reason])).toEqual([
        ['writes', 'Changes data (DROP). ZLens imports only queries that read.'],
        ['writes', 'Creates table dev.order_snapshot. ZLens imports queries that read; if this is a report, import its SELECT.'],
        ['writes', 'Changes data (DELETE). ZLens imports only queries that read.'],
      ]);

      const preview = await post(base, `/api/block-studio/ai-imports/${encodeURIComponent(session.body.id)}/candidates/${encodeURIComponent(candidates[0].id)}/preview`, {});
      expect(preview.status, preview.text).toBe(200);
      expect(executed.some((sql) => /date_trunc\('week'/i.test(sql))).toBe(true);
      expect(executed.filter((sql) => WRITES.test(sql))).toEqual([]);
    });
  }, 60_000);

  it('refuses to preview a draft someone edited into a statement that writes', async () => {
    await withServer(async (base, executed) => {
      const session = await post(base, '/api/block-studio/ai-imports', {
        inputMode: 'paste',
        sources: [{ path: 'weekly.sql', content: "select date_trunc('week', ordered_at) as week, count(*) as orders from dev.orders group by 1" }],
        domain: 'commerce',
        owner: 'analytics@jaffle.shop',
        persistence: 'session-only',
      });
      const candidate = session.body.candidates[0] as { id: string };
      const path = `/api/block-studio/ai-imports/${encodeURIComponent(session.body.id)}/candidates/${encodeURIComponent(candidate.id)}`;
      const edited = await fetch(`${base}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: 'drop table dev.orders' }),
      });
      expect(edited.status, await edited.text()).toBe(200);
      const preview = await post(base, `${path}/preview`, {});
      expect(preview.status, preview.text).not.toBe(200);
      expect(preview.text).toContain('Saved query preview only supports read-only SELECT or WITH queries.');
      expect(executed.filter((sql) => WRITES.test(sql))).toEqual([]);
    });
  }, 60_000);

  it('does not run a saved query that writes when Certify checks it', async () => {
    await withServer(async (base, executed) => {
      const source = `block "Nightly cleanup" {
    status = "draft"
    domain = "commerce"
    type = "custom"
    description = "Old cleanup step."
    owner = "analytics@jaffle.shop"

    query = """
drop table dev.orders
    """

    tests {
        assert row_count > 0
    }
}
`;
      const check = await post(base, '/api/block-studio/certification-check', { source });
      expect(check.body?.ok, check.text).not.toBe(true);
      expect(executed.filter((sql) => WRITES.test(sql))).toEqual([]);
    });
  }, 60_000);
});
