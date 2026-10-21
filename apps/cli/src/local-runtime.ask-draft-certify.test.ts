import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@zlens/agent';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer, withoutAskOriginReuseTag } from './local-runtime.js';
import { captureReviewRequiredDraft } from './review-draft-capture.js';

/**
 * Recording "Ask and trust" on 0.2.2: an AI answer's review draft was saved with
 * no domain and the AI's sentence-slug name, so certifying it unedited put
 * `for_each_jaffle_shop_location_store_the_average_` in "uncategorized" with an
 * `app-source` tag. The draft now carries its own id as its name, the one
 * Domain its tables belong to, and certifies without the App-source marker.
 */

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const question = 'What is the average order value at each store?';
const sql = 'SELECT l.location_id, l.location_name, SUM(o.order_total) / COUNT(*) AS average_order_value FROM "jaffle_shop"."dev"."orders" AS o JOIN "jaffle_shop"."dev"."locations" AS l ON o.location_id = l.location_id GROUP BY l.location_id, l.location_name';
const aiName = 'for_each_jaffle_shop_location_store_the_average_';

function project(sourceSystems: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-ask-draft-certify-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), '{}\n');
  for (const [id, systems] of Object.entries(sourceSystems)) {
    mkdirSync(join(root, 'domains', id), { recursive: true });
    writeFileSync(join(root, 'domains', id, 'domain.dql'), `domain "${id}" {\n  id = "${id}"\n  owner = "analytics@jaffle.shop"\n  sourceSystems = [${systems.map((system) => `"${system}"`).join(', ')}]\n}\n`);
  }
  return root;
}

function askRun(): AgentRun {
  return {
    id: 'run-aov',
    question,
    requestedMode: 'ask',
    route: 'answer',
    status: 'completed',
    trustState: 'review_required',
    stopReason: 'completed',
    startedAt: '2026-10-21T00:00:00Z',
    completedAt: '2026-10-21T00:00:01Z',
    steps: [],
    summary: 'Philadelphia leads.',
    artifacts: [{
      id: 'answer',
      kind: 'answer',
      title: 'Answer',
      trustState: 'review_required',
      payload: {
        kind: 'uncertified',
        reviewStatus: 'review_required',
        sql,
        result: { columns: ['location_id', 'location_name', 'average_order_value'], rows: [], rowCount: 2 },
        dqlArtifact: {
          kind: 'sql_block',
          name: aiName,
          persistence: 'transient',
          compiledSql: sql,
          source: `block "${aiName}" {\n  type = "custom"\n  status = "draft"\n  description = "For each Jaffle Shop location (store), the average order value"\n  query = """\n    ${sql}\n  """\n}`,
        },
      },
    }],
    evaluations: [],
    events: [],
    nextActions: [],
    repairAttempts: 0,
  } as unknown as AgentRun;
}

const executor = {
  executeQuery: vi.fn(async () => ({
    columns: ['location_id', 'location_name', 'average_order_value'],
    rows: [{ location_id: 1, location_name: 'Philadelphia', average_order_value: 21.4 }, { location_id: 2, location_name: 'Brooklyn', average_order_value: 19.8 }],
    rowCount: 2,
    executionTime: 1,
  })),
} as unknown as QueryExecutor;

async function withServer(projectRoot: string, run: (base: string) => Promise<void>): Promise<void> {
  let server: Server | undefined;
  try {
    const port = await startLocalServer({ rootDir: projectRoot, projectRoot, executor, connection: { driver: 'file' }, preferredPort: 0, captureServer: (created) => { server = created; } });
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  }
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function certify(base: string, source: string, path: string, metadata: Record<string, unknown>): Promise<Record<string, any>> {
  const started = await call(base, 'POST', '/api/block-studio/certifications', { source, path, metadata });
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  let operation: Record<string, any> = started.body.operation;
  for (let attempt = 0; attempt < 500 && ['queued', 'running'].includes(String(operation.status)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    operation = (await call(base, 'GET', `/api/operations/${encodeURIComponent(operation.id)}`)).body;
  }
  return operation.result;
}

describe('an Ask review draft certified without edits', () => {
  it('keeps its own name, lands in the Domain its tables belong to, and has no app-source tag', async () => {
    const root = project({ commerce: ['dbt:orders', 'dbt:order_items', 'dbt:locations'] });
    const draft = captureReviewRequiredDraft(root, askRun(), { owner: 'analytics@jaffle.shop' })!;
    expect(draft.path).toBe('domains/commerce/blocks/_drafts/average_order_value_each_store.dql');
    await withServer(root, async (base) => {
      const opened = await call(base, 'GET', `/api/block-studio/open?path=${encodeURIComponent(draft.path)}`);
      expect(opened.body.metadata).toMatchObject({ name: 'average_order_value_each_store', domain: 'commerce' });

      // Block Studio's builder saves the draft first, which marks it reusable for Apps.
      const saved = await call(base, 'POST', '/api/block-studio/save', { path: draft.path, source: opened.body.source, metadata: opened.body.metadata });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.source).toContain('"app-source"');

      const certified = await certify(base, saved.body.source, saved.body.path, saved.body.metadata);
      expect(certified.outcome, JSON.stringify(certified.blockers ?? certified)).toBe('certified');
      expect(certified.newPath).toBe('domains/commerce/blocks/average_order_value_each_store.dql');
      const onDisk = readFileSync(join(root, certified.newPath), 'utf-8');
      expect(onDisk).toMatch(/^block "average_order_value_each_store" \{/m);
      expect(onDisk).toContain('status = "certified"');
      expect(onDisk).not.toContain('app-source');
      expect(onDisk).not.toContain(aiName);
      expect(existsSync(join(root, 'blocks', 'uncategorized'))).toBe(false);
    });
  }, 60_000);

  it('opens with no Domain when its tables span Domains, so the reviewer picks one', async () => {
    const root = project({ commerce: ['dbt:orders'], stores: ['dbt:locations'] });
    const draft = captureReviewRequiredDraft(root, askRun(), { owner: 'analytics@jaffle.shop' })!;
    expect(draft.path).toBe('blocks/_drafts/average_order_value_each_store.dql');
    await withServer(root, async (base) => {
      const opened = await call(base, 'GET', `/api/block-studio/open?path=${encodeURIComponent(draft.path)}`);
      // Not "_drafts": a drafts folder is not a Domain.
      expect(opened.body.metadata).toMatchObject({ name: 'average_order_value_each_store', domain: '' });
    });
  }, 60_000);
});

describe('withoutAskOriginReuseTag', () => {
  it('drops app-source only from a block with Ask or AI origin', () => {
    const ask = 'block "a" {\n  tags = ["app-source"]\n  status = "draft"\n  source_question = "Why?"\n  query = """SELECT 1"""\n}';
    expect(withoutAskOriginReuseTag(ask)).toBe('block "a" {\n  status = "draft"\n  source_question = "Why?"\n  query = """SELECT 1"""\n}');
    const tagged = 'block "b" {\n  tags = ["ai-generated", "app-source"]\n  query = """SELECT 1"""\n}';
    expect(withoutAskOriginReuseTag(tagged)).toContain('tags = ["ai-generated"]');
    const handMade = 'block "c" {\n  tags = ["finance", "app-source"]\n  query = """SELECT 1"""\n}';
    expect(withoutAskOriginReuseTag(handMade)).toBe(handMade);
  });
});
