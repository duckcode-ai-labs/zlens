import { describe, expect, it } from 'vitest';
import { publishedAppTileTrust, publishedTileTrustText, readersWillSeeText } from '@zlens/core/apps/app-trust';
import type { AppStudioBuildDraft } from '../../api/client';
import { appCardSeal, appCertificationRollup } from './app-certification';
import { draftTrust, publicationReadiness } from './app-studio-publish-readiness';

/**
 * One trust model (T1–T3): a tile is Certified or Not certified yet, and the
 * App says one count — the same words in the publish dialog, the stored
 * `dql.app.json`, the Apps card and the App header.
 */
const sourceId = 'app:block:commerce:orders';
const savedQueryId = 'app:block:commerce:top';

function salesReview(): AppStudioBuildDraft {
  const query = (dimensions: Array<{ field: string }>) => ({ dimensions, measures: [{ measure: 'revenue' }], respectsGlobalFilters: true });
  return {
    version: 3, id: 'build_1', appId: 'sales-review', name: 'Sales review', revision: 2, proposalHash: 'hash',
    authoringMode: 'manual', template: 'blank', state: 'local_draft',
    frame: { goal: 'Sales', metrics: [], dimensions: [], filters: [] }, requirements: [], coverage: [], reviewTasks: [],
    sources: [
      {
        id: sourceId, kind: 'block', sourceRef: 'orders', lifecycle: 'certified', trustState: 'certified', reviewStatus: 'not_required',
        capabilities: { dataset: {
          kind: 'block', label: 'Orders', trust: 'certified',
          fields: [{ kind: 'physical', name: 'location__location_name', qualifiedId: 'o:l', type: 'string', role: 'dimension', status: 'approved', related: { join: 'location', column: 'location_name' } }],
          joins: [{ id: 'location', label: 'Location', table: 'locations', relation: 'main.locations', keys: [{ from: 'location_id', to: 'location_id' }], cardinality: 'many_to_one', trust: 'review_required', origin: 'drafted', relationshipId: 'p:rel', uniqueness: 'current', sentence: 'each order has one location' }],
        } },
      },
      { id: savedQueryId, kind: 'block', sourceRef: 'domains/commerce/blocks/top.dql', lifecycle: 'certified', trustState: 'certified', reviewStatus: 'not_required' },
    ],
    pages: [{
      version: 3, id: 'overview', metadata: { title: 'Overview' },
      datasets: [{ id: 'orders_ds', sourceId, sourceRevision: 'r', snapshotId: 's', contractFingerprint: 'c' }],
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [
        { i: 'revenue', x: 0, y: 0, w: 3, h: 2, title: 'Revenue', sourceId, sourceRevision: 'r', query: query([]), viz: { type: 'single_value' } },
        { i: 'aov', x: 3, y: 0, w: 3, h: 2, title: 'Average order', sourceId, sourceRevision: 'r', query: { ...query([]), calculations: [{ id: 'aov', label: 'AOV', expr: { op: 'div' } }] }, viz: { type: 'single_value' } },
        { i: 'by_store', x: 6, y: 0, w: 6, h: 4, title: 'Orders by store', sourceId, sourceRevision: 'r', query: query([{ field: 'location__location_name' }]), viz: { type: 'bar' } },
        { i: 'top', x: 0, y: 2, w: 6, h: 4, title: 'Top customers', sourceId: savedQueryId, block: { ref: 'domains/commerce/blocks/top.dql' }, trustState: 'certified', viz: { type: 'table' } },
      ] },
    }],
    previewReceipts: [{ id: 'run', pageId: 'overview', revision: 2, snapshotId: 's', filterFingerprint: 'f', resultFingerprint: 'x', createdAt: '' }],
    createdAt: '', updatedAt: '',
  } as unknown as AppStudioBuildDraft;
}

describe('one trust model: one count everywhere (T2)', () => {
  it('the publish dialog, the stored file, the Apps card and the App header say "3 of 4 tiles certified"', () => {
    const draft = salesReview();
    const dialog = publicationReadiness(draft);
    expect(dialog.trust.text).toBe('3 of 4 tiles certified');
    // The calculation over certified data is certified (no separate word for it).
    expect(dialog.trust.tiles.find((tile) => tile.tileId === 'aov')?.trust.label).toBe('Certified');
    // Only the tile on the join nobody certified is not certified yet.
    expect(dialog.notCertified.map((tile) => tile.title)).toEqual(['Orders by store']);
    // Publishing is not blocked by trust (T3).
    expect(dialog.ready).toBe(true);
    expect(readersWillSeeText(dialog.trust.notCertified)).toBe('Readers will see ‘Not certified yet’ on 1 tile.');

    const stored = publishedAppTileTrust(dialog.trust);
    expect(stored).toEqual({ certified: 3, total: 4 });
    expect(publishedTileTrustText(stored)).toBe(dialog.trust.text);

    const card = appCardSeal({ lifecycle: 'review', certification: 'uncertified', draftCount: 0, publishedTrust: stored });
    expect(card.label).toBe(dialog.trust.text);

    // The reader's run of the same page carries the same evidence.
    const items = draft.pages[0]!.layout.items;
    const runTiles = [
      { tileId: 'revenue', status: 'ok', dataset: { trust: 'certified', joins: [] } },
      { tileId: 'aov', status: 'ok', dataset: { trust: 'certified', joins: [] } },
      { tileId: 'by_store', status: 'ok', dataset: { trust: 'certified', joins: [{ trust: 'review_required' }] } },
      { tileId: 'top', status: 'ok', certificationStatus: 'certified' },
    ];
    const header = appCertificationRollup(items as never, 0, runTiles as never);
    expect(header.label).toBe(dialog.trust.text);
  });

  it('an old App\'s stored data rule changes nothing', () => {
    for (const sourcePolicy of ['governed_only', 'include_review_required'] as const) {
      const old = { ...salesReview(), sourcePolicy };
      expect(draftTrust(old).text).toBe('3 of 4 tiles certified');
      expect(publicationReadiness(old).fixCount).toBe(0);
    }
  });
});
