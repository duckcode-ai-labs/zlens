import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import { readCompanionCertification } from '../certification-receipt.js';
import type { DqlPrincipal } from './request-context.js';

/**
 * RFC 0010 HH-9. Where the host certifies through review (`certification: 'proposes'`), Certify in a draft space
 * must not read as certified. The draft space also inherits blocks that really are certified, and Production is served
 * under the same signal, so what tells them apart is the block's receipt: a certification made on the branch being
 * served has not been reviewed yet; one that arrived by merge has.
 */
const dan: DqlPrincipal = { id: 'u-dan', kind: 'person', email: 'dan@harbor.example', displayName: 'Dan Creator', source: 'host' };
const BLOCK = `block "Open claims" {
  status = "draft"
  domain = "claims"
  type = "custom"
  description = "Open claims by region"
  owner = "claims-team"
  query = """SELECT region, COUNT(*) AS open_claims FROM claims GROUP BY region"""

  tests {
    assert row_count > 0
  }
}
`;
const PATH = 'domains/claims/blocks/open_claims.dql';

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

async function serve(options: { hosted: boolean; branch?: string }) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-certification-proposal-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'proposal', connections: { default: { driver: 'duckdb', filepath: ':memory:' } } }));
  mkdirSync(join(projectRoot, 'domains', 'claims', 'blocks'), { recursive: true });
  writeFileSync(join(projectRoot, PATH), BLOCK);
  git(projectRoot, 'init', '--quiet', '--initial-branch=main');
  git(projectRoot, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'start');
  if (options.branch) git(projectRoot, 'checkout', '--quiet', '-b', options.branch);
  const rows = [{ region: 'West', open_claims: 3 }];
  const executor = { executeQuery: async () => ({ columns: [{ name: 'region', type: 'VARCHAR' }, { name: 'open_claims', type: 'BIGINT' }], rows, rowCount: rows.length, executionTime: 1 }) } as unknown as QueryExecutor;
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor, preferredPort: 0,
    ...(options.hosted ? { hostHooks: { resolvePrincipal: () => dan, ui: () => ({ certification: 'proposes' as const }) } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
  };
  return { call, projectRoot };
}

function companionOf(projectRoot: string): string {
  const dir = join(projectRoot, 'semantic-layer', 'blocks');
  const find = (at: string): string | undefined => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) { const found = find(full); if (found) return found; } else if (entry.name.endsWith('.yaml')) return full;
    }
    return undefined;
  };
  return readFileSync(find(dir)!, 'utf-8');
}

const open = (call: Awaited<ReturnType<typeof serve>>['call']) => call('GET', `/api/block-studio/open?path=${encodeURIComponent(PATH)}`);
const listed = async (call: Awaited<ReturnType<typeof serve>>['call']) => (await call('GET', '/api/blocks/library')).body.blocks.find((block: { path: string }) => block.path === PATH);

describe('Certify under a host that certifies through review', () => {
  it('reads as a proposal on the branch it was made on, in the block and in the list', async () => {
    const { call, projectRoot } = await serve({ hosted: true, branch: 'draft/d-1' });
    const certified = await call('POST', '/api/block-studio/certify', { source: BLOCK, path: PATH });
    expect(certified.status, certified.text.slice(0, 400)).toBe(200);
    expect(readCompanionCertification(companionOf(projectRoot))).toMatchObject({ certifiedBy: 'dan@harbor.example', branch: 'draft/d-1' });

    const opened = await open(call);
    expect(opened.body.metadata).toMatchObject({ reviewStatus: 'certified', certificationProposed: true });
    expect(await listed(call)).toMatchObject({ status: 'certified', certificationProposed: true });
  });

  it('reads as certified once merged: the same receipt on another branch is no proposal', async () => {
    const { call, projectRoot } = await serve({ hosted: true, branch: 'draft/d-1' });
    await call('POST', '/api/block-studio/certify', { source: BLOCK, path: PATH });
    git(projectRoot, 'checkout', '--quiet', '-b', 'main-after-merge');

    expect((await open(call)).body.metadata).toMatchObject({ reviewStatus: 'certified' });
    expect((await open(call)).body.metadata.certificationProposed).toBeUndefined();
    expect((await listed(call)).certificationProposed).toBeUndefined();
  });

  it('keeps a block certified before receipts named a branch certified, in a draft space too', async () => {
    const { call, projectRoot } = await serve({ hosted: true, branch: 'draft/d-1' });
    await call('POST', '/api/block-studio/certify', { source: BLOCK, path: PATH });
    const dir = join(projectRoot, 'semantic-layer', 'blocks');
    const rewrite = (at: string) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const full = join(at, entry.name);
        if (entry.isDirectory()) rewrite(full);
        else writeFileSync(full, readFileSync(full, 'utf-8').replace(/^\s*branch: .*\n/m, ''));
      }
    };
    rewrite(dir);
    expect((await open(call)).body.metadata.certificationProposed).toBeUndefined();
  });

  it('without a host, records no branch and nothing reads as a proposal', async () => {
    const { call, projectRoot } = await serve({ hosted: false, branch: 'draft/d-1' });
    const certified = await call('POST', '/api/block-studio/certify', { source: BLOCK, path: PATH });
    expect(certified.status, certified.text.slice(0, 400)).toBe(200);
    expect(readCompanionCertification(companionOf(projectRoot))).not.toHaveProperty('branch');
    expect((await open(call)).body.metadata.certificationProposed).toBeUndefined();
    expect((await listed(call)).certificationProposed).toBeUndefined();
  });
});
