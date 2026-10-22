import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const SKELETON = `block "Claims by adjuster" {
  domain = "claims"
  type = "custom"
  status = "draft"
}`;

const CATALOG = {
  version: 1,
  driver: 'duckdb',
  connectionId: 'local',
  scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }],
  capturedAt: '2026-10-11T00:00:00.000Z',
  fingerprint: 'test',
  relations: [{
    id: 'warehouse.main.main.claims',
    database: 'main',
    schema: 'main',
    name: 'claims',
    relation: 'main.claims',
    kind: 'table',
    columns: [{ name: 'claim_id' }, { name: 'adjuster_id' }, { name: 'adjuster_name' }],
    primaryKey: ['adjuster_id'],
  }],
};

async function saveDraft(sql: string): Promise<{ path: string; source: string; prefill?: { identityGap?: { key?: string; message: string } } }> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-agent-draft-identity-'));
  tempDirs.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), '{}\n');
  mkdirSync(join(projectRoot, '.dql'), { recursive: true });
  writeFileSync(join(projectRoot, '.dql/warehouse-catalog.json'), JSON.stringify(CATALOG));
  let server: Server | undefined;
  try {
    const port = await startLocalServer({
      rootDir: projectRoot,
      projectRoot,
      executor: {} as QueryExecutor,
      connection: { driver: 'file' },
      preferredPort: 0,
      captureServer: (created) => { server = created; },
    });
    const saved = await fetch(`http://127.0.0.1:${port}/api/block-studio/agent-drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: SKELETON, name: 'Claims by adjuster', domain: 'claims', sql }),
    }).then((response) => response.json()) as { path: string; prefill?: { identityGap?: { key?: string; message: string } } };
    return { ...saved, source: readFileSync(join(projectRoot, saved.path), 'utf-8') };
  } finally {
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  }
}

describe('POST /api/block-studio/agent-drafts tells the creator about a labels-only grouping', () => {
  it('names the key from the warehouse catalog when the answer groups by a name only', async () => {
    const saved = await saveDraft('SELECT adjuster_name, COUNT(*) AS n FROM claims GROUP BY ALL');
    expect(saved.prefill?.identityGap?.key).toBe('adjuster_id');
    // A suggestion for the creator to review: the draft is not rewritten to add the key.
    expect(saved.source).not.toContain('adjuster_id');
    expect(saved.prefill?.identityGap?.message).toBe(
      "Ask can't use this saved query as a certified answer: it groups by adjuster_name only. Add adjuster_id (the key) to SELECT and GROUP BY.",
    );
  });

  it('says nothing when the answer already groups by the key', async () => {
    const saved = await saveDraft('SELECT adjuster_id, adjuster_name, COUNT(*) AS n FROM claims GROUP BY adjuster_id, adjuster_name');
    expect(saved.prefill?.identityGap).toBeUndefined();
  });
});
