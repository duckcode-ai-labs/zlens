import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAppStorage, defaultLocalAppsDbPath } from '@zlens/project';
import { DQLContext } from '../../context.js';
import { buildDqlApp } from '../workflows.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeBlock(root: string, file: string, name: string, description: string, status = 'certified'): void {
  mkdirSync(join(root, 'blocks', 'revenue'), { recursive: true });
  writeFileSync(join(root, 'blocks', 'revenue', file), `block "${name}" {
  domain = "revenue"
  status = "${status}"
  type = "custom"
  description = "${description}"
  owner = "analytics@local"
  tags = ["revenue"]

  query = """
SELECT 1 AS value
"""

  visualization {
    chart = "single_value"
  }
}
`);
}

function project(): DQLContext {
  const root = mkdtempSync(join(tmpdir(), 'zlens-mcp-build-app-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), '{}\n');
  writeBlock(root, 'total_revenue.dql', 'Total Revenue', 'Executive revenue KPI');
  writeBlock(root, 'revenue_by_region.dql', 'Revenue by Region', 'Revenue split by region');
  writeBlock(root, 'draft_margin.dql', 'Draft Margin', 'Unreviewed margin', 'draft');
  return new DQLContext({ projectRoot: root });
}

function storedDraft(root: string, id: string) {
  const storage = new LocalAppStorage(defaultLocalAppsDbPath(root));
  try {
    return storage.getAppBuildDraft(id);
  } finally {
    storage.close();
  }
}

describe('build_dql_app (design D9: AI builds open in App Studio)', () => {
  it('creates an App Studio draft with the named certified blocks as its data and writes no App files', async () => {
    const ctx = project();
    const out = await buildDqlApp(ctx, {
      prompt: 'Revenue performance for leadership',
      name: 'Revenue Performance',
      domain: 'revenue',
      blocks: ['Total Revenue', 'Revenue by Region'],
      overwrite: true,
    });
    expect(out.ok).toBe(true);
    if (!out.ok || !('draftId' in out)) throw new Error(JSON.stringify(out));
    expect(out).toMatchObject({
      saved: true,
      appId: 'revenue-performance',
      name: 'Revenue Performance',
      sourcePolicy: 'Only certified data',
      openPath: `/?appDraft=${out.draftId}`,
    });
    expect(out.sources).toEqual([
      expect.objectContaining({ title: 'Total Revenue', kind: 'Saved query', trust: 'Certified', reason: 'You named this block.' }),
      expect.objectContaining({ title: 'Revenue by Region', kind: 'Saved query', trust: 'Certified' }),
    ]);
    // No App files: the draft lives in the local App Studio store only.
    expect(existsSync(join(ctx.projectRoot, 'apps'))).toBe(false);
    const draft = storedDraft(ctx.projectRoot, out.draftId);
    expect(draft).toMatchObject({
      authoringMode: 'ai',
      sourcePolicy: 'governed_only',
      frame: expect.objectContaining({ goal: 'Revenue performance for leadership' }),
    });
    expect(draft?.pages[0]?.metadata.domain).toBe('revenue');
    expect(draft?.pages.every((page) => page.layout.items.length === 0)).toBe(true);
    expect(draft?.sources.map((source) => source.trustState)).toEqual(['certified', 'certified']);
  });

  it('picks certified data for the request with a reason for each pick, and never data that needs review', async () => {
    const ctx = project();
    const out = await buildDqlApp(ctx, { prompt: 'revenue and margin for leadership' });
    expect(out.ok).toBe(true);
    if (!out.ok || !('draftId' in out)) throw new Error(JSON.stringify(out));
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.sources.every((source) => source.trust === 'Certified' && source.reason.length > 0)).toBe(true);
    expect(out.sources.some((source) => source.title === 'Draft Margin')).toBe(false);
    expect(storedDraft(ctx.projectRoot, out.draftId)?.sources.length).toBe(out.sources.length);
    expect(existsSync(join(ctx.projectRoot, 'apps'))).toBe(false);
  });

  it('returns the picks only when saveDraft is false, and refuses blocks that are not certified', async () => {
    const ctx = project();
    const planOnly = await buildDqlApp(ctx, { prompt: 'revenue', blocks: ['Total Revenue'], saveDraft: false });
    expect(planOnly).toMatchObject({ ok: true, saved: false, sources: [expect.objectContaining({ title: 'Total Revenue' })] });
    expect('draftId' in planOnly).toBe(false);
    const storage = new LocalAppStorage(defaultLocalAppsDbPath(ctx.projectRoot));
    try {
      expect(storage.listAppBuildDrafts()).toEqual([]);
    } finally {
      storage.close();
    }

    const refused = await buildDqlApp(ctx, { prompt: 'margin', blocks: ['Draft Margin'] });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('Only certified blocks') });
  });
});
