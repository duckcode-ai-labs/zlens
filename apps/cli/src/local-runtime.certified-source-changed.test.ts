import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildManifest } from '@zlens/core';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import { readCompanionCertification } from './certification-receipt.js';

/**
 * A certification receipt records the fingerprint of the source it certified.
 * A certified block edited by hand afterwards must not stay certified
 * silently: Block Studio says so, the library and the manifest (what Ask
 * reads) list it as pending recertification, and Re-certify clears it.
 */

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

async function withProject(
  rows: Array<Record<string, unknown>>,
  run: (base: string, projectRoot: string) => Promise<void>,
): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-certified-source-changed-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'certified_source_changed' }));
  mkdirSync(join(projectRoot, 'domains/nba/blocks'), { recursive: true });
  const executor = {
    executeQuery: vi.fn(async () => ({
      columns: ['player_name', 'total_points'],
      rows,
      rowCount: rows.length,
      executionTime: 1,
    })),
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
    await run(`http://127.0.0.1:${port}`, projectRoot);
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  }
}

const post = async (base: string, path: string, body: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
};

interface OpenedBlock {
  source: string;
  companionPath: string | null;
  metadata: { reviewStatus: string; certificationSourceChanged?: boolean; sourceFingerprint: string };
}

async function openBlock(base: string, path: string): Promise<OpenedBlock> {
  const response = await fetch(`${base}/api/block-studio/open?path=${encodeURIComponent(path)}`);
  return await response.json() as OpenedBlock;
}

async function libraryStatus(base: string, path: string): Promise<string | undefined> {
  const response = await fetch(`${base}/api/blocks/library`);
  const body = await response.json() as { blocks: Array<{ path: string; status: string }> };
  return body.blocks.find((block) => block.path === path)?.status;
}

async function certify(base: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const started = await post(base, '/api/block-studio/certifications', body);
  expect(started.status, started.text).toBe(202);
  let operation: Record<string, any> = started.body.operation;
  for (let attempt = 0; attempt < 300 && ['queued', 'running'].includes(String(operation.status)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    operation = await fetch(`${base}/api/operations/${encodeURIComponent(operation.id)}`).then((response) => response.json());
  }
  return operation;
}

const metadata = { name: 'Scorers', domain: 'nba', description: 'Top scorers.', owner: 'e2e', tags: [] };
const scorerSource = (tests = '') => `block "Scorers" {\n  status = "draft"\n  domain = "nba"\n  type = "custom"\n  description = "Top scorers."\n  owner = "e2e"\n  query = """SELECT player_name, total_points FROM player_season_facts ORDER BY total_points DESC LIMIT 5"""${tests}\n}`;

describe('A certified block edited after certification', () => {
  it('is flagged in Block Studio, the library and the manifest until it is re-certified', async () => {
    await withProject([{ player_name: 'LeBron James', total_points: 3016 }], async (base, projectRoot) => {
      const certified = await certify(base, { source: scorerSource(), metadata });
      expect(certified.result?.outcome, JSON.stringify(certified)).toBe('certified');
      const path = certified.result.newPath as string;

      const fresh = await openBlock(base, path);
      expect(fresh.metadata.reviewStatus).toBe('certified');
      expect(fresh.metadata.certificationSourceChanged).toBeUndefined();
      expect(await libraryStatus(base, path)).toBe('certified');
      expect(buildManifest({ projectRoot }).blocks.Scorers?.status).toBe('certified');

      // A hand edit outside ZLens: the source still says certified.
      writeFileSync(join(projectRoot, path), fresh.source.replace('LIMIT 5', 'LIMIT 50'));
      const edited = await openBlock(base, path);
      expect(edited.metadata.reviewStatus).toBe('certified');
      expect(edited.metadata.certificationSourceChanged).toBe(true);
      expect(await libraryStatus(base, path)).toBe('pending_recertification');
      const manifest = buildManifest({ projectRoot });
      expect(manifest.blocks.Scorers).toMatchObject({ status: 'pending_recertification', certificationSourceChanged: true });
      expect(manifest.diagnostics?.some((diagnostic) => diagnostic.severity === 'warning'
        && diagnostic.message.includes('"Scorers" was edited after it was certified'))).toBe(true);

      // Re-certify the edited source in place: a new receipt for the new source.
      const recertified = await certify(base, {
        source: edited.source,
        path,
        metadata,
        expectedSourceFingerprint: edited.metadata.sourceFingerprint,
      });
      expect(recertified.result?.outcome, JSON.stringify(recertified)).toBe('certified');
      const after = await openBlock(base, path);
      expect(after.source).toContain('LIMIT 50');
      expect(after.metadata.certificationSourceChanged).toBeUndefined();
      expect(await libraryStatus(base, path)).toBe('certified');
      expect(buildManifest({ projectRoot }).blocks.Scorers?.status).toBe('certified');
    });
  }, 60_000);

  it('leaves a block certified before receipts existed certified', async () => {
    await withProject([], async (base, projectRoot) => {
      const path = 'domains/nba/blocks/legacy.dql';
      writeFileSync(join(projectRoot, path), scorerSource().replace('"Scorers"', '"Legacy"').replace('status = "draft"', 'status = "certified"'));
      mkdirSync(join(projectRoot, 'semantic-layer/blocks/nba'), { recursive: true });
      writeFileSync(join(projectRoot, 'semantic-layer/blocks/nba/legacy.yaml'), 'name: legacy\nreviewStatus: certified\n');
      const opened = await openBlock(base, path);
      expect(opened.metadata.reviewStatus).toBe('certified');
      expect(opened.metadata.certificationSourceChanged).toBeUndefined();
      expect(await libraryStatus(base, path)).toBe('certified');
      expect(buildManifest({ projectRoot }).blocks.Legacy?.status).toBe('certified');
      expect(readCompanionCertification(readFileSync(join(projectRoot, 'semantic-layer/blocks/nba/legacy.yaml'), 'utf-8'))).toBeNull();
    });
  });
});

describe('Block Studio Certify runs column tests on every row', () => {
  const nonNegative = '\n\n  tests {\n    assert total_points >= 0\n  }';
  const tests = '\n\n  tests {\n    assert total_points >= 0\n    assert player_name IN ["LeBron James", "James Harden"]\n  }';

  it('refuses a block whose second row breaks a column test', async () => {
    await withProject([
      { player_name: 'LeBron James', total_points: 3016 },
      { player_name: 'James Harden', total_points: -1 },
    ], async (base) => {
      const operation = await certify(base, { source: scorerSource(nonNegative), metadata });
      expect(operation.result?.outcome, JSON.stringify(operation)).toBe('draft_saved_with_blockers');
      expect(JSON.stringify(operation.result)).toContain('total_points');
    });
  }, 60_000);

  it('certifies when every row passes, including an IN test', async () => {
    await withProject([
      { player_name: 'LeBron James', total_points: 3016 },
      { player_name: 'James Harden', total_points: 2376 },
    ], async (base) => {
      const operation = await certify(base, { source: scorerSource(tests), metadata });
      expect(operation.result?.outcome, JSON.stringify(operation)).toBe('certified');
    });
  }, 60_000);
});
