import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAppPublication } from './apps-api.js';
import { nameDraftEditBesideCertified } from './local-runtime.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const CERTIFIED_PATH = 'domains/claims/blocks/open_claims_by_region.dql';
const COPY_PATH = 'domains/claims/blocks/_drafts/open-claims-by-region-0123456789abcdef.dql';

const certifiedSource = 'block "Open claims by region" {\n  status = "certified"\n  domain = "claims"\n  type = "custom"\n  query = """SELECT 1 AS open_claims"""\n}\n';
const fingerprint = (source: string) => `sha256:${createHash('sha256').update(source).digest('hex')}`;

/** A project with a certified block, a copy saved beside it, and an App page whose one tile names `block`. */
function projectWithCopy(copySource: string, block: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dql-beside-draft-'));
  tempDirs.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'beside' }));
  mkdirSync(join(root, 'domains/claims/blocks/_drafts'), { recursive: true });
  writeFileSync(join(root, CERTIFIED_PATH), certifiedSource);
  writeFileSync(join(root, COPY_PATH), copySource);
  const appDir = join(root, 'apps', 'claims-ops');
  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify({ version: 1, id: 'claims-ops', name: 'Claims Ops', domain: 'claims', owners: ['a@example.com'], members: [{ userId: 'a@example.com', roles: ['owner'] }], roles: [{ id: 'owner' }], policies: [] }));
  writeFileSync(join(appDir, 'dashboards', 'overview.dqld'), JSON.stringify({
    version: 1, id: 'overview', metadata: { title: 'Overview', domain: 'claims' },
    layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [{ i: 'kpi', x: 0, y: 0, w: 3, h: 2, block, sourceRevision: fingerprint(certifiedSource), viz: { type: 'single_value' } }] },
  }));
  return root;
}

// The copy a save makes beside the certified block. The path sorts before the certified file's.
const legacyCopy = certifiedSource.replace('"certified"', '"draft"').replace('SELECT 1', 'SELECT 2');

describe('a draft saved beside a certified block', () => {
  it('gets its own name and never the certified block\'s', () => {
    const renamed = nameDraftEditBesideCertified(legacyCopy);
    expect(renamed).toContain('block "Open claims by region (draft edit)" {');
    expect(renamed).toContain('status = "draft"');
    expect(nameDraftEditBesideCertified(renamed)).toBe(renamed);
  });

  it('does not take over the certified block\'s name, even when an older copy still shares it', () => {
    const root = projectWithCopy(legacyCopy, { blockId: 'Open claims by region' });
    const result = checkAppPublication(root, 'claims-ops')!;
    expect(result.blockers.filter((blocker) => blocker.code === 'block_not_certified')).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  it('keeps an App tile that names the certified block working once the copy has its own name', () => {
    const root = projectWithCopy(nameDraftEditBesideCertified(legacyCopy), { blockId: 'Open claims by region' });
    expect(checkAppPublication(root, 'claims-ops')!.blockers).toEqual([]);
  });

  const requireCertified = (root: string) => writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'beside', apps: { requireCertifiedToPublish: true } }));

  it('can be chosen for a tile by path, and is then not certified: it blocks only when the project requires certified data (T3)', () => {
    const root = projectWithCopy(nameDraftEditBesideCertified(legacyCopy), { ref: COPY_PATH });
    expect(checkAppPublication(root, 'claims-ops')!.blockers.filter((blocker) => blocker.code === 'block_not_certified')).toEqual([]);
    requireCertified(root);
    const result = checkAppPublication(root, 'claims-ops')!;
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'block_not_certified', tileId: 'kpi' }));
  });

  it('can be chosen for a tile by its own name, and is then not certified', () => {
    const root = projectWithCopy(nameDraftEditBesideCertified(legacyCopy), { blockId: 'Open claims by region (draft edit)' });
    requireCertified(root);
    const result = checkAppPublication(root, 'claims-ops')!;
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'block_not_certified', tileId: 'kpi' }));
  });

  it('a tile whose saved query is gone is a blocker whatever the project requires', () => {
    const root = projectWithCopy(legacyCopy, { ref: 'domains/claims/blocks/gone.dql' });
    expect(checkAppPublication(root, 'claims-ops')!.blockers).toContainEqual(expect.objectContaining({ code: 'block_missing', tileId: 'kpi' }));
  });
});
