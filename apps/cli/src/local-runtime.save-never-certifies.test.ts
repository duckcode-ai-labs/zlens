import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { setBlockStudioStatus, startLocalServer } from './local-runtime.js';
import { applyCompanionCertification, blockSourceStatus, readCompanionCertification, readCompanionDeprecation } from './certification-receipt.js';

/**
 * The trust promise (graduated-trust.md): nothing becomes certified
 * implicitly. Saving AI-generated, imported, or hand-written work writes a
 * draft whose `.dql` status and companion YAML agree; only an explicit
 * Certify action certifies, after the certification rules pass, and it
 * leaves a receipt naming who certified.
 */

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

async function withProject(run: (base: string, projectRoot: string) => Promise<void>): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-save-never-certifies-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'save_never_certifies' }));
  mkdirSync(join(projectRoot, 'domains/nba/blocks'), { recursive: true });
  const executor = {
    executeQuery: vi.fn(async () => ({
      columns: ['player_name', 'total_points'],
      rows: [{ player_name: 'LeBron James', total_points: 3016 }],
      rowCount: 1,
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

/** The companion YAML of a saved block, read through the API that opens it. */
async function openBlock(base: string, path: string) {
  const response = await fetch(`${base}/api/block-studio/open?path=${encodeURIComponent(path)}`);
  return await response.json() as {
    source: string;
    companionPath: string | null;
    metadata: { reviewStatus: string; certification?: { certifiedBy: string; via: string; rules: string; sourceSha256: string } };
  };
}

function companionStatus(projectRoot: string, companionPath: string | null): string | undefined {
  if (!companionPath) return undefined;
  return /^reviewStatus:\s*(\S+)/m.exec(readFileSync(join(projectRoot, companionPath), 'utf-8'))?.[1];
}

const scorerSql = 'SELECT player_name, total_points FROM player_season_facts WHERE season = 2017 ORDER BY total_points DESC LIMIT 5';

describe('Saving never certifies; certifying is explicit and leaves a receipt', () => {
  it('Import SQL → Save block writes a draft whose .dql and YAML agree; Certify then certifies with a receipt', async () => {
    await withProject(async (base, projectRoot) => {
      const session = await post(base, '/api/block-studio/ai-imports', {
        inputMode: 'paste',
        sources: [{ path: 'pasted.sql', content: scorerSql }],
        domain: 'nba',
        owner: 'e2e',
      });
      expect(session.status, session.text).toBe(200);
      const candidate = session.body.candidates[0];
      expect(candidate).toBeDefined();

      // The UI's "Save block" (save-selected) — clicked once, with an owner.
      const saved = await post(base, `/api/block-studio/ai-imports/${encodeURIComponent(session.body.id)}/save-selected`, {
        candidateIds: [candidate.id],
        owner: 'e2e',
      });
      expect(saved.status, saved.text).toBe(200);
      const result = saved.body.results[0];
      expect(result.status).toBe('draft');
      expect(result.path).toMatch(/\/_drafts\//);
      expect(result.candidate.reviewStatus).not.toBe('saved');

      const draft = await openBlock(base, result.path);
      expect(blockSourceStatus(draft.source)).toBe('draft');
      expect(draft.metadata.reviewStatus).toBe('draft');
      expect(draft.metadata.certification).toBeUndefined();
      expect(companionStatus(projectRoot, draft.companionPath)).toBe('draft');
      // Saving again is idempotent and still never certifies.
      const again = await post(base, `/api/block-studio/ai-imports/${encodeURIComponent(session.body.id)}/save-selected`, {
        candidateIds: [candidate.id],
        owner: 'e2e',
      });
      expect(again.body.results[0].status).toBe('draft');
      expect(blockSourceStatus(readFileSync(join(projectRoot, result.path), 'utf-8'))).toBe('draft');

      // The explicit Certify action runs the rules and records who certified.
      const certified = await post(base, `/api/block-studio/ai-imports/${encodeURIComponent(session.body.id)}/candidates/${encodeURIComponent(candidate.id)}/certify`, {});
      expect(certified.status, certified.text).toBe(200);
      const certifiedPath = certified.body.candidate.savedPath as string;
      expect(certifiedPath).not.toMatch(/\/_drafts\//);
      const block = await openBlock(base, certifiedPath);
      expect(blockSourceStatus(block.source)).toBe('certified');
      expect(block.metadata.reviewStatus).toBe('certified');
      expect(companionStatus(projectRoot, block.companionPath)).toBe('certified');
      expect(block.metadata.certification).toMatchObject({ via: 'sql-import', rules: 'oss' });
      expect(block.metadata.certification?.certifiedBy).toEqual(expect.any(String));
      expect(block.metadata.certification?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(projectRoot, result.path))).toBe(false);
    });
  }, 60_000);

  it('Save as block from a notebook cell or an Ask answer writes a draft even when every gate would pass', async () => {
    await withProject(async (base, projectRoot) => {
      const saved = await post(base, '/api/blocks/save-from-cell', {
        cellId: 'answer-1',
        name: 'Top scorers 2017',
        domain: 'nba',
        owner: 'e2e',
        // A source that claims to be certified is still saved as a draft.
        content: `block "Top scorers 2017" {\n  status = "certified"\n  query = """\n    ${scorerSql}\n  """\n}`,
      });
      expect(saved.status, saved.text).toBe(201);
      expect(saved.body.status).toBe('draft');
      expect(saved.body.certification?.certified).toBe(false);
      expect(typeof saved.body.certification?.readyToCertify).toBe('boolean');
      const onDisk = readFileSync(join(projectRoot, saved.body.path), 'utf-8');
      expect(blockSourceStatus(onDisk)).toBe('draft');
      const block = await openBlock(base, saved.body.path);
      expect(companionStatus(projectRoot, block.companionPath)).toBe('draft');
      expect(block.metadata.certification).toBeUndefined();
    });
  }, 60_000);

  it('creating a block with a certified status writes a draft', async () => {
    await withProject(async (base, projectRoot) => {
      const created = await post(base, '/api/blocks', {
        name: 'Claimed certified',
        domain: 'nba',
        content: `block "Claimed certified" {\n  status = "certified"\n  owner = "e2e"\n  query = """SELECT 1 AS value"""\n}`,
      });
      expect(created.status, created.text).toBe(201);
      expect(blockSourceStatus(readFileSync(join(projectRoot, created.body.path), 'utf-8'))).toBe('draft');
    });
  });

  it('Block Studio Certify writes the receipt beside reviewStatus: certified', async () => {
    await withProject(async (base, projectRoot) => {
      const source = `block "Scorers" {\n  status = "draft"\n  domain = "nba"\n  type = "custom"\n  description = "Top scorers."\n  owner = "e2e"\n  query = """${scorerSql}"""\n}`;
      const started = await post(base, '/api/block-studio/certifications', {
        source,
        metadata: { name: 'Scorers', domain: 'nba', description: 'Top scorers.', owner: 'e2e', tags: [] },
      });
      expect(started.status, started.text).toBe(202);
      let operation: Record<string, any> = started.body.operation;
      for (let attempt = 0; attempt < 300 && ['queued', 'running'].includes(String(operation.status)); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        operation = await fetch(`${base}/api/operations/${encodeURIComponent(operation.id)}`).then((response) => response.json());
      }
      expect(operation.result?.outcome, JSON.stringify(operation)).toBe('certified');
      const block = await openBlock(base, operation.result.newPath);
      expect(blockSourceStatus(block.source)).toBe('certified');
      expect(companionStatus(projectRoot, block.companionPath)).toBe('certified');
      expect(block.metadata.certification).toMatchObject({ via: 'block-studio', rules: 'oss' });
      const receipt = readCompanionCertification(readFileSync(join(projectRoot, block.companionPath!), 'utf-8'));
      expect(receipt?.certifiedBy).toEqual(expect.any(String));

      // Deprecate (the Block Studio button) keeps the receipt as history and
      // records who deprecated the block beside it; reviewStatus says it no longer holds.
      const deprecated = await post(base, '/api/blocks/status', { path: operation.result.newPath, newStatus: 'deprecated' });
      expect(deprecated.status, deprecated.text).toBe(200);
      const companion = readFileSync(join(projectRoot, block.companionPath!), 'utf-8');
      expect(companion).toContain('reviewStatus: deprecated');
      expect(readCompanionCertification(companion)).toEqual(receipt);
      expect(readCompanionDeprecation(companion)).toMatchObject({
        deprecatedBy: expect.any(String),
        deprecatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        via: 'block-studio',
        previousStatus: 'certified',
      });
      const reopened = await openBlock(base, operation.result.newPath);
      expect(reopened.metadata.reviewStatus).toBe('deprecated');
      // Readers trust a receipt only on a certified block.
      expect(reopened.metadata.certification).toBeUndefined();

      // Saving the deprecated block from Block Studio keeps both records.
      const resaved = await post(base, '/api/block-studio/save', {
        path: operation.result.newPath,
        source: reopened.source,
        metadata: { name: 'Scorers', domain: 'nba', description: 'Top scorers.', owner: 'e2e', tags: [] },
      });
      expect(resaved.status, resaved.text).toBe(200);
      const afterSave = readFileSync(join(projectRoot, resaved.body.companionPath ?? block.companionPath!), 'utf-8');
      expect(afterSave).toContain('reviewStatus: deprecated');
      expect(readCompanionCertification(afterSave)).toEqual(receipt);
      expect(readCompanionDeprecation(afterSave)?.previousStatus).toBe('certified');

      // Moving it back to draft drops both: a draft claims neither.
      setBlockStudioStatus(projectRoot, operation.result.newPath, 'draft');
      const draft = readFileSync(join(projectRoot, block.companionPath!), 'utf-8');
      expect(draft).toContain('reviewStatus: draft');
      expect(draft).not.toContain('certification:');
      expect(draft).not.toContain('deprecation:');
    });
  }, 60_000);

  it('Deprecate records who deprecated the block, once, and keeps the receipt', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-deprecate-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, 'blocks/nba'), { recursive: true });
    mkdirSync(join(projectRoot, 'semantic-layer/blocks/nba'), { recursive: true });
    const source = 'block "x" {\n  status = "certified"\n  query = """SELECT 1"""\n}\n';
    writeFileSync(join(projectRoot, 'blocks/nba/x.dql'), source);
    const receipt = { certifiedBy: 'analytics', certifiedAt: '2026-10-01T00:00:00.000Z', via: 'block-studio' as const, rules: 'oss' as const, sourceSha256: 'a'.repeat(64) };
    writeFileSync(join(projectRoot, 'semantic-layer/blocks/nba/x.yaml'), applyCompanionCertification('name: x\nblock: x\ndomain: nba\n', 'certified', receipt));

    setBlockStudioStatus(projectRoot, 'blocks/nba/x.dql', 'deprecated', undefined, 'retirer@example.com');
    const companionPath = join(projectRoot, 'semantic-layer/blocks/nba/x.yaml');
    const first = readCompanionDeprecation(readFileSync(companionPath, 'utf-8'));
    expect(first).toMatchObject({ deprecatedBy: 'retirer@example.com', previousStatus: 'certified' });
    expect(readCompanionCertification(readFileSync(companionPath, 'utf-8'))).toEqual(receipt);

    // Deprecating again keeps the first record.
    setBlockStudioStatus(projectRoot, 'blocks/nba/x.dql', 'deprecated', undefined, 'someone-else');
    expect(readCompanionDeprecation(readFileSync(companionPath, 'utf-8'))).toEqual(first);
    expect(readCompanionCertification(readFileSync(companionPath, 'utf-8'))).toEqual(receipt);
  });

  it('Certify writes the companion and its receipt for a block that has none (0.2.4)', () => {
    // The Jaffle sample's hand-written blocks had no companion YAML: Certify
    // passed and recorded nothing, so their tiles never read "Certified by …".
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-certify-no-companion-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, 'domains/commerce/blocks'), { recursive: true });
    const source = 'block "monthly_revenue" {\n  domain = "commerce"\n  status = "certified"\n  description = "Monthly gross order revenue."\n  owner = "analytics@jaffle.shop"\n  query = """SELECT 1 AS month"""\n}\n';
    writeFileSync(join(projectRoot, 'domains/commerce/blocks/monthly_revenue.dql'), source);
    const receipt = { certifiedBy: 'analytics@jaffle.shop', certifiedAt: '2026-10-23T00:00:00.000Z', via: 'block-studio' as const, rules: 'oss' as const, sourceSha256: 'stale' };

    setBlockStudioStatus(projectRoot, 'domains/commerce/blocks/monthly_revenue.dql', 'certified', receipt);

    const companion = readFileSync(join(projectRoot, 'semantic-layer/blocks/commerce/monthly_revenue.yaml'), 'utf-8');
    expect(companion).toContain('name: monthly_revenue');
    expect(companion).toContain('owner: "analytics@jaffle.shop"');
    expect(companion).toContain('reviewStatus: certified');
    const written = readCompanionCertification(companion);
    expect(written).toMatchObject({ certifiedBy: 'analytics@jaffle.shop', via: 'block-studio', rules: 'oss' });
    // The receipt is for exactly the source on disk, so a later edit shows.
    expect(written?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(written?.sourceSha256).not.toBe('stale');
  });

  it('a status flip to certified without a Certify receipt is refused', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-status-flip-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, 'blocks/nba'), { recursive: true });
    writeFileSync(join(projectRoot, 'blocks/nba/x.dql'), 'block "x" {\n  status = "draft"\n  query = """SELECT 1"""\n}\n');
    expect(() => setBlockStudioStatus(projectRoot, 'blocks/nba/x.dql', 'certified')).toThrow(/certification receipt/);
    expect(readFileSync(join(projectRoot, 'blocks/nba/x.dql'), 'utf-8')).toContain('status = "draft"');
  });
});
