import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppStudioBuildDraft } from '../../api/client';
import { appTileTrustFor } from '@zlens/core/apps/app-trust';
import { draftCardTrustText, draftTrust, draftWithSourceReceipts } from './app-studio-publish-readiness';
import { CHANGED_IN_ANOTHER_TAB, studioErrorWords } from './app-studio-words';
import { StudioErrorBanner } from './builder/studio-ui';
import { ownerWords } from './builder/app-data';

const CERTIFIED_AT = '2026-10-15T12:00:00.000Z';

/** A published App reopened to edit: two saved queries, one changed since it was certified (F07). */
function editDraft(): AppStudioBuildDraft {
  const source = (id: string, name: string, certified: boolean) => ({
    id,
    kind: 'block',
    sourceRef: `domains/commerce/blocks/${name}.dql`,
    sourcePath: `domains/commerce/blocks/${name}.dql`,
    executionRef: `domains/commerce/blocks/${name}.dql`,
    sourceRevision: `sha256:${name}`,
    lifecycle: certified ? 'certified' : 'pending_recertification',
    trustState: certified ? 'certified' : 'review_required',
    reviewStatus: certified ? 'not_required' : 'required',
    capabilities: { measures: [], dimensions: [], outputs: [], filters: [], allowedVisualizations: ['table'], parameters: [] },
  });
  const tile = (i: string, blockId: string, sourceId: string) => ({ i, x: 0, y: 0, w: 6, h: 4, title: blockId, block: { blockId }, sourceId, sourceRevision: `sha256:${blockId}`, viz: { type: 'table' } });
  return {
    version: 3,
    id: 'build_1',
    appId: 'growth-review',
    name: 'Growth Review',
    baseApp: { appId: 'growth-review', fingerprint: 'sha256:app' },
    revision: 1,
    proposalHash: 'sha256:draft',
    authoringMode: 'manual',
    template: 'blank',
    state: 'local_draft',
    frame: { goal: 'Growth', metrics: [], dimensions: [], filters: [] },
    requirements: [],
    coverage: [],
    sources: [source('app:block:commerce:monthly', 'monthly_revenue', true), source('app:block:commerce:beverage', 'beverage_revenue', false)],
    pages: [{ version: 1, id: 'overview', metadata: { title: 'Growth Review' }, layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [tile('monthly', 'monthly_revenue', 'app:block:commerce:monthly'), tile('beverage', 'beverage_revenue', 'app:block:commerce:beverage')] } }],
    reviewTasks: [],
    createdAt: CERTIFIED_AT,
    updatedAt: CERTIFIED_AT,
  } as unknown as AppStudioBuildDraft;
}

const catalogItems = [
  { id: 'app:block:commerce:monthly', sourceId: 'app:block:commerce:monthly', certification: { by: 'analytics@jaffle.shop', at: CERTIFIED_AT, checks: ['run'] } },
  // A saved query changed since it was certified keeps who certified it and when.
  { id: 'app:block:commerce:beverage', sourceId: 'app:block:commerce:beverage', certification: { by: 'analytics@jaffle.shop', at: CERTIFIED_AT } },
];

describe('Studio tiles say who certified them and when (F03, F07)', () => {
  it('a certified tile reads "Certified by <name> · <date>", never a bare Certified', () => {
    const bare = draftTrust(editDraft());
    expect(appTileTrustFor(bare, 'overview', 'monthly')?.trust.byline).toBe('Certified');
    const trust = draftTrust(draftWithSourceReceipts(editDraft(), catalogItems));
    expect(appTileTrustFor(trust, 'overview', 'monthly')?.trust.byline).toMatch(/^Certified by Analytics \(jaffle\.shop\) · 15 Oct/);
  });

  it('the changed saved query alone is not certified, and says since when', () => {
    const trust = draftTrust(draftWithSourceReceipts(editDraft(), catalogItems));
    expect(trust.text).toBe('1 of 2 tiles certified');
    const changed = appTileTrustFor(trust, 'overview', 'beverage')!.trust;
    expect(changed.label).toBe('Not certified yet');
    expect(changed.detail).toMatch(/^Changed since it was certified on 15 Oct/);
    expect(draftTrust(editDraft()).tiles.find((tile) => tile.tileId === 'beverage')!.trust.detail).toBe('Nobody has certified this saved query yet.');
  });

  it('takes only the receipt from the catalog: trust stays the draft\'s, and nothing changes without receipts', () => {
    const draft = editDraft();
    expect(draftWithSourceReceipts(draft, [])).toBe(draft);
    const merged = draftWithSourceReceipts(draft, catalogItems);
    expect(merged.sources.map((source) => source.trustState)).toEqual(draft.sources.map((source) => source.trustState));
    expect(merged.revision).toBe(draft.revision);
  });

  it('the draft card shows the same count as the editor header (F04)', () => {
    expect(draftCardTrustText(editDraft())).toBe('1 of 2 tiles certified');
    const empty = { ...editDraft(), pages: [{ ...editDraft().pages[0]!, layout: { ...editDraft().pages[0]!.layout, items: [] } }] } as AppStudioBuildDraft;
    expect(draftCardTrustText(empty)).toBe('');
  });

  it('names the owner as the owner, never next to Certified as if they certified it', () => {
    expect(ownerWords({ owner: 'analytics@jaffle.shop' })).toBe('Owner: Analytics (jaffle.shop)');
    expect(ownerWords({ owner: 'maria.lopez@acme.com', ownerName: 'Maria Lopez' })).toBe('Owner: Maria Lopez');
    expect(ownerWords({ owner: null })).toBe('');
  });
});

describe('App Studio errors in plain words (F11)', () => {
  it('an App changed in another tab says so, offers Refresh, and keeps the code under Technical details', () => {
    const raw = 'Project publication needs attention. APP_BUILD_REVISION_CONFLICT: refresh before preflight.';
    expect(studioErrorWords(raw)).toEqual({ message: CHANGED_IN_ANOTHER_TAB, refresh: true, technical: raw });
    expect(studioErrorWords('APP_BUILD_PROPOSAL_CONFLICT: the draft changed.').refresh).toBe(true);
    const markup = renderToStaticMarkup(<StudioErrorBanner error={raw} onRefresh={() => undefined} onDismiss={() => undefined} />);
    expect(markup).toContain('This App changed in another tab. Refresh to review the latest version.');
    expect(markup).toContain('>Refresh</button>');
    expect(markup).toContain('<summary>Technical details</summary>');
    expect(markup.split('APP_BUILD_REVISION_CONFLICT')).toHaveLength(2);
    expect(markup.indexOf('APP_BUILD_REVISION_CONFLICT')).toBeGreaterThan(markup.indexOf('Technical details'));
  });

  it('maps the common App build codes, and moves any other code out of the sentence', () => {
    expect(studioErrorWords('APP_BUILD_SOURCE_DRIFT: these exact App sources no longer resolve: x').message).toBe('Some data in this App changed since it was added. Refresh its data, then run the page again.');
    expect(studioErrorWords('APP_BUILD_DATASET_RETIRED: choose current data instead of Orders.').message).toBe('Some data in this App is no longer available. Replace it with current data.');
    expect(studioErrorWords('APP_BUILD_PREVIEW_RECEIPT_REJECTED: stale').message).toBe('The last run no longer matches the page. Run the page again.');
    expect(studioErrorWords('APP_BUILD_PAGE_NOT_FOUND: page x is not in this App draft').refresh).toBe(true);
    const other = studioErrorWords('DATASET_SOURCE_NOT_FOUND: that data is not in this project any more');
    expect(other).toEqual({ message: 'That data is not in this project any more.', technical: 'DATASET_SOURCE_NOT_FOUND: that data is not in this project any more' });
    expect(studioErrorWords('Network error')).toEqual({ message: 'Network error' });
    for (const raw of ['APP_BUILD_REVISION_CONFLICT: x', 'APP_BUILD_NOT_READY: y', 'SOME_CODE: z']) {
      expect(studioErrorWords(raw).message).not.toMatch(/[A-Z]+_[A-Z_]+/);
    }
  });

  it('without a Refresh handler, the banner offers none', () => {
    const markup = renderToStaticMarkup(<StudioErrorBanner error="APP_BUILD_REVISION_CONFLICT: x" />);
    expect(markup).not.toContain('>Refresh</button>');
  });
});
