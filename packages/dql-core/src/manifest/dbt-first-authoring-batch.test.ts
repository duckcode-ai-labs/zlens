import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyModelingChanges, previewModelingChanges, previewModelingChangesAsync } from './dbt-first-authoring.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('batch modeling authoring', () => {
  it('composes multiple entity bindings in one write-free preview', () => {
    const root = mkdtempSync(join(tmpdir(), 'dql-modeling-batch-'));
    roots.push(root);
    mkdirSync(join(root, 'domains', 'commerce'), { recursive: true });
    writeFileSync(join(root, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n  reviewCadence = "quarterly"\n}\n');
    const changes = ['orders', 'customers'].map((id) => ({
      operation: 'upsert_entity' as const,
      value: { id, domain: 'commerce', dbtModel: `model.shop.${id}`, status: 'draft' as const },
    }));

    const preview = previewModelingChanges(root, changes);
    const target = join(root, preview.patches[0]!.path);
    expect(existsSync(target)).toBe(false);
    expect(preview.patches).toHaveLength(1);
    expect(preview.patches[0]?.after).toContain('model.shop.orders');
    expect(preview.patches[0]?.after).toContain('model.shop.customers');

    applyModelingChanges(root, changes, preview.fingerprint);
    expect(readFileSync(target, 'utf8')).toContain('model.shop.customers');
  });

  const commerce = (count: number) => {
    const root = mkdtempSync(join(tmpdir(), 'dql-modeling-batch-'));
    roots.push(root);
    mkdirSync(join(root, 'domains', 'commerce'), { recursive: true });
    writeFileSync(join(root, 'domains', 'commerce', 'domain.dql'), 'domain "Commerce" {\n  id = "commerce"\n  reviewCadence = "quarterly"\n}\n');
    const changes = Array.from({ length: count }, (_, index) => ({
      operation: 'upsert_entity' as const,
      value: { id: `table_${index}`, domain: 'commerce', dbtModel: `model.shop.table_${index}`, status: 'draft' as const },
    }));
    return { root, changes };
  };

  it('composed in turns, gives the same preview, gives the event loop back and counts the changes (onboarding large test, 26 Nov 2026)', async () => {
    const { root, changes } = commerce(12);
    const progress: Array<[number, number]> = [];
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 0);
    const turns = await previewModelingChangesAsync(root, changes, { yieldEveryMs: 0, onProgress: (done, total) => progress.push([done, total]) });
    clearInterval(ticker);
    const whole = previewModelingChanges(root, changes);
    expect(turns.fingerprint).toBe(whole.fingerprint);
    expect(turns.patches).toEqual(whole.patches);
    expect(turns.patchPathsByChange).toEqual(whole.patchPathsByChange);
    // Other work ran while the batch was composed: a server answers meanwhile.
    expect(ticks).toBeGreaterThan(0);
    expect(progress[0]).toEqual([0, 12]);
    expect(progress.at(-1)).toEqual([12, 12]);
    expect(progress.map(([done]) => done)).toEqual([...progress.map(([done]) => done)].sort((a, b) => a - b));
    expect(progress.length).toBeGreaterThan(3);
  });

  it('composed in turns, is stale when a file it changes was changed meanwhile, and stops when asked', async () => {
    const { root, changes } = commerce(4);
    const target = join(root, previewModelingChanges(root, changes).patches[0]!.path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'entities: []\n');
    const stale = await previewModelingChangesAsync(root, changes, {
      yieldEveryMs: 0,
      onProgress: (done) => { if (done === 2) writeFileSync(target, '# a person saved this meanwhile\nentities: []\n'); },
    }).catch((caught) => caught);
    expect(stale).toMatchObject({ code: 'PROPOSAL_STALE' });
    const controller = new AbortController();
    const stopped = await previewModelingChangesAsync(root, changes, {
      yieldEveryMs: 0,
      signal: controller.signal,
      onProgress: (done) => { if (done === 1) controller.abort(); },
    }).catch((caught) => caught);
    expect(stopped).toBeInstanceOf(Error);
    expect((stopped as Error).name).toBe('AbortError');
  });

  it('composed in turns, other work runs at least every 3 s however large the batch (target: counts every 3 s)', async () => {
    const { root, changes } = commerce(400);
    const progressAt: number[] = [];
    let lastTick = Date.now();
    let longestTick = 0;
    const ticker = setInterval(() => {
      const now = Date.now();
      longestTick = Math.max(longestTick, now - lastTick);
      lastTick = now;
    }, 10);
    const started = Date.now();
    await previewModelingChangesAsync(root, changes, { onProgress: () => progressAt.push(Date.now()) });
    clearInterval(ticker);
    const gaps = progressAt.slice(1).map((at, index) => at - progressAt[index]!);
    // The default turn is 200 ms: a server answers and the counts move far inside the 3 s target.
    expect(Math.max(0, ...gaps)).toBeLessThan(3_000);
    expect(longestTick).toBeLessThan(3_000);
    // A batch longer than one turn did give the event loop back.
    if (Date.now() - started > 400) expect(progressAt.length).toBeGreaterThan(2);
  }, 60_000);
});

