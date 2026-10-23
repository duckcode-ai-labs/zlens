import { describe, expect, it, vi } from 'vitest';
import type { DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import { datasetTileNotices } from './dataset-tile-evidence';

type Item = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type Tile = DashboardRunResponse['tiles'][number];

const notices = async () => {
  vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
  return (await import('./DashboardRenderer')).dashboardTileFilterNotices;
};

const savedQuery = {
  i: 'top-customers', x: 0, y: 0, w: 6, h: 4, title: 'Top customers',
  block: { blockId: 'top_customers' }, viz: { type: 'table' },
  // The document says the tile is linked; the server's report is what readers see.
  filterBindings: [{ filter: 'region', binding: 'region', mode: 'predicate', capability: 'preflight_required' }],
} as unknown as Item;

describe('reader filter pills come from what the server applied', () => {
  it('uses the run result for a Saved query tile, not the document', async () => {
    const dashboardTileFilterNotices = await notices();
    const tile = {
      tileId: 'top-customers', status: 'ok', tileType: 'block',
      filterReport: { applied: [], notApplied: [{ filter: 'region', code: 'invalid_value', reason: 'The value could not become a condition.' }] },
    } as unknown as Tile;
    expect(dashboardTileFilterNotices({ item: savedQuery, tile, activeVariables: { region: 'East' } }).unfilteredNotice)
      .toEqual({ label: 'Not filtered by Region', detail: 'Region: The value could not become a condition.' });
    expect(dashboardTileFilterNotices({ item: savedQuery, tile, activeVariables: { region: 'East' }, filterLabels: { region: 'Region' } }).unfilteredNotice)
      .toMatchObject({ label: 'Not filtered by Region' });
    const applied = { ...tile, filterReport: { applied: ['region'], notApplied: [] } } as unknown as Tile;
    expect(dashboardTileFilterNotices({ item: { ...savedQuery, filterBindings: [] } as Item, tile: applied, activeVariables: { region: 'East' } }).unfilteredNotice).toBeNull();
  });

  it('falls back to the document before a run and honours "Does not apply"', async () => {
    const dashboardTileFilterNotices = await notices();
    expect(dashboardTileFilterNotices({ item: savedQuery, activeVariables: { region: 'East' } }).unfilteredNotice).toBeNull();
    const excluded = { ...savedQuery, filterBindings: [{ filter: 'region', capability: 'unsupported', unsupportedReason: 'Author: does not apply' }] } as unknown as Item;
    expect(dashboardTileFilterNotices({ item: excluded, activeVariables: { region: 'East' } }).unfilteredNotice)
      .toMatchObject({ label: 'Not filtered by Region' });
  });

  it('never shows filter pills on text tiles', async () => {
    const dashboardTileFilterNotices = await notices();
    const text = { i: 'note', x: 0, y: 0, w: 12, h: 1, text: { markdown: 'Context' }, viz: { type: 'text' } } as unknown as Item;
    const tile = { tileId: 'note', status: 'ok', tileType: 'text', filterReport: { applied: [], notApplied: [{ filter: 'region', code: 'not_linked', reason: 'x' }] } } as unknown as Tile;
    expect(dashboardTileFilterNotices({ item: text, tile, activeVariables: { region: 'East' }, viewerFilterIds: ['customer_name'] }))
      .toEqual({ unfilteredNotice: null, datasetUnboundNotices: [] });
    expect(datasetTileNotices(tile)).toEqual([]);
  });

  it('lists not-applied filters for Metrics and draft tiles in the shared notices Studio shows', () => {
    for (const tileType of ['semantic', 'draftAnalysis'] as const) {
      const tile = {
        tileId: 'kpi', status: 'ok', tileType,
        filterReport: { applied: ['period'], notApplied: [{ filter: 'region', code: 'does_not_apply', reason: 'Author: does not apply' }] },
      } as unknown as Tile;
      expect(datasetTileNotices(tile, { filterLabels: { region: 'Region' } })).toEqual([
        { key: 'region:does_not_apply', kind: 'not_linked', label: 'Not filtered by Region', detail: 'Author: does not apply' },
      ]);
    }
  });
});
