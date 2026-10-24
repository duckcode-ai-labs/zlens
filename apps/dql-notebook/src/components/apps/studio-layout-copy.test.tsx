import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AppStudioV2Module from './AppStudioV2';
import type * as AppsViewModule from './AppsView';
import { showTileSourceRef } from './DashboardRenderer';
import { filterValueCapHint } from './filter-value-search';
import { measureSortChip } from './builder/sort-top-n';

/**
 * Phase-4 new-user review, problems 9 and 10: steadier layout and plainer
 * copy in App Studio and the reader.
 */
let studio: typeof AppStudioV2Module;
let appsView: typeof AppsViewModule;

beforeAll(async () => {
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3000' } });
  studio = await import('./AppStudioV2');
  appsView = await import('./AppsView');
});

describe('App Studio layout and copy (phase-4 review)', () => {
  it('a published App with unpublished changes is one card; a new App\'s draft keeps its own', () => {
    const drafts = [
      { id: 'd-old', appId: 'sales', updatedAt: '2026-10-20T10:00:00Z' },
      { id: 'd-new', appId: 'sales', updatedAt: '2026-10-21T10:00:00Z' },
      { id: 'd-fresh', appId: 'brand-new', updatedAt: '2026-10-21T09:00:00Z' },
    ];
    const merged = appsView.mergeDraftsIntoAppCards(drafts, [{ id: 'sales' }]);
    expect(merged.standaloneDrafts.map((draft) => draft.id)).toEqual(['d-fresh']);
    expect(merged.draftByAppId.get('sales')?.id).toBe('d-new');
  });

  it('Publish mentions git only in a git repository', () => {
    expect(studio.publishSavesAsFilesSentence(true)).toContain('review in git');
    expect(studio.publishSavesAsFilesSentence(false)).toBe('Publishing saves the App as files in your project folder.');
    expect(studio.publishSavesAsFilesSentence(undefined)).not.toContain('git');
  });

  it('a starting layout says what it opens, and an intro keeps its title on its own line', () => {
    expect(studio.manualLaunchLabel('blank')).toBe('Continue to data');
    expect(studio.manualLaunchLabel('operational_dashboard')).toBe('Continue to data (with an intro)');
    expect(studio.studioTextTileLines('# Sales Manager Overview\n\nMonitor current performance.')).toEqual([
      { text: 'Sales Manager Overview', heading: true },
      { text: 'Monitor current performance.', heading: false },
    ]);
    expect(studio.studioTextTileLines('## New section')).toEqual([{ text: 'New section', heading: true }]);
  });

  it('readers never see a tile\'s source id or "text"; authors see the source id', () => {
    expect(showTileSourceRef({ editable: false, compact: false, blockRef: 'text' })).toBe(false);
    expect(showTileSourceRef({ editable: false, compact: false, blockRef: 'block:customer_profile' })).toBe(false);
    expect(showTileSourceRef({ editable: true, compact: false, blockRef: 'text' })).toBe(false);
    expect(showTileSourceRef({ editable: true, compact: false, blockRef: 'block:customer_profile' })).toBe(true);
  });

  it('a measure pill shows its Top N or sort', () => {
    const query = { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }] };
    expect(measureSortChip({ ...query, orderBy: [{ alias: 'lifetime_spend', direction: 'desc' as const }], limit: 10 }, { measure: 'lifetime_spend' })).toEqual({ label: 'Top 10' });
    expect(measureSortChip({ ...query, orderBy: [{ alias: 'lifetime_spend', direction: 'asc' as const }] }, { measure: 'lifetime_spend' })).toEqual({ label: 'Sorted ↑' });
    expect(measureSortChip(query, { measure: 'lifetime_spend' })).toBeNull();
    expect(measureSortChip(query, { dimension: 'customer_name' })).toBeNull();
  });

  it('a value list counts the field\'s values, not the first run\'s 500 rows', () => {
    expect(filterValueCapHint({ values: Array.from({ length: 200 }, (_, index) => `v${index}`), truncated: true, valueCount: 930 })).toBe('Type to search all 930 values');
    expect(filterValueCapHint({ values: ['a'], truncated: true, valueCount: 5000, valueCountCapped: true })).toBe('Type to search all 5,000+ values');
  });
});
