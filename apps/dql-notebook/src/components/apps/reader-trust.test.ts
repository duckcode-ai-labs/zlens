import { describe, expect, it } from 'vitest';
import { readerTileFreshness, readerTileReceipt, readerTileTrust, readerTrustCounts, relativeAge } from './reader-trust';

const item = (extra: Record<string, unknown> = {}) => ({ i: 't', x: 0, y: 0, w: 4, h: 2, viz: { type: 'bar' }, block: { blockId: 'b' }, ...extra }) as never;
const tile = (extra: Record<string, unknown>) => ({ tileId: 't', status: 'ok', ...extra }) as never;

describe('reader trust (RFC 0008 step 6)', () => {
  it('maps run evidence to one of four states', () => {
    expect(readerTileTrust(item(), tile({ certificationStatus: 'certified' }))?.state).toBe('certified');
    expect(readerTileTrust(item(), tile({ tileType: 'semantic' }))?.state).toBe('governed');
    expect(readerTileTrust(item(), tile({}))?.state).toBe('review');
    expect(readerTileTrust(item(), tile({ status: 'unauthorized' }))?.state).toBe('blocked');
    expect(readerTileTrust(item(), tile({ status: 'error' }))?.state).toBe('blocked');
    expect(readerTileTrust(item(), tile({ status: 'stale', certificationStatus: 'certified' }))?.state).toBe('review');
  });

  it('trusts a Dataset tile only within its contract', () => {
    expect(readerTileTrust(item(), tile({ dataset: { trust: 'certified', validation: { outcome: 'covered', adaptations: [] } } }))?.state).toBe('certified');
    expect(readerTileTrust(item(), tile({ dataset: { trust: 'certified', validation: { outcome: 'needs_review', adaptations: [] } } }))?.state).toBe('review');
    expect(readerTileTrust(item(), tile({ dataset: { trust: 'review_required' } }))?.state).toBe('review');
    expect(readerTileTrust(item(), tile({ dataset: { trust: 'certified', validation: { outcome: 'rejected', adaptations: [] } } }))?.state).toBe('blocked');
  });

  it('labels AI answers by their review, and never labels text', () => {
    expect(readerTileTrust(item({ aiPin: { id: 'p' } }), tile({ aiPin: { certification: 'ai_generated' } }))?.label).toBe('Not certified yet');
    expect(readerTileTrust(item({ aiPin: { id: 'p' } }), tile({ aiPin: { certification: 'certified' } }))?.label).toBe('Certified');
    expect(readerTileTrust(item({ text: { markdown: 'Hi' }, block: undefined }), tile({ tileType: 'text' }))).toBeNull();
  });

  it('counts states in a fixed order for the Trust Lens legend', () => {
    const trusts = [readerTileTrust(item(), tile({})), readerTileTrust(item(), tile({ certificationStatus: 'certified' })), null];
    expect(readerTrustCounts(trusts)).toEqual([
      { state: 'certified', label: 'Certified', count: 1 },
      { state: 'review', label: 'Not certified yet', count: 1 },
    ]);
  });

  it('says how fresh the numbers are', () => {
    const now = Date.parse('2026-09-23T12:00:00Z');
    expect(relativeAge(now - 20_000, now)).toBe('just now');
    expect(relativeAge(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeAge(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(readerTileFreshness(tile({}), now - 60_000, now)).toBe('Updated 1 min ago');
    expect(readerTileFreshness(tile({ dataset: { cacheDelivery: { cachedAt: '2026-09-23T10:00:00Z' } } }), now, now)).toBe('Cached 2 h ago');
    expect(readerTileFreshness(tile({ status: 'error' }), now, now)).toBeNull();
  });

  it('builds a receipt only from evidence the run returned', () => {
    const rows = readerTileReceipt(
      item({ owner: 'Finance' }),
      tile({
        artifact: { name: 'Revenue by region', sourcePath: 'blocks/revenue.dql', sourceKind: 'certified_block' },
        filters: { applied: [{ field: 'region', values: ['EU', 'US'] }] },
        result: { columns: [], rows: [], rowCount: 2, executionTime: 1, resultFingerprint: 'sha256:abcdef0123456789abcdef' },
      }),
      { runId: 'run_1', snapshotId: 'snap_1', filterFingerprint: 'f' },
      undefined,
    );
    expect(rows.map((row) => row.label)).toEqual(['Source', 'Source file', 'Owner', 'Filters', 'Rows', 'Result fingerprint', 'Snapshot', 'Run']);
    expect(rows.find((row) => row.label === 'Filters')?.value).toBe('Region EU, US');
    expect(rows.find((row) => row.label === 'Result fingerprint')).toMatchObject({ value: 'sha256:abcde…', code: true });
    expect(readerTileReceipt(item(), tile({}), null, undefined).find((row) => row.label === 'Filters')?.value).toBe('None applied');
  });

  it('writes applied date filters in words, never as raw operators or JSON', () => {
    const receipt = (applied: unknown[]) => readerTileReceipt(item(), tile({ filters: { applied } } as never), null, undefined)
      .find((row) => row.label === 'Filters')?.value;
    expect(receipt([{ field: 'ordered_at', op: 'between', values: ['2025-01-01', '2025-06-30'] }])).toBe('Ordered At 1 Jan 2025 – 30 Jun 2025');
    expect(receipt([
      { field: 'ordered_at', op: 'gte', values: ['2025-01-01'] },
      { field: 'ordered_at', op: 'lt', values: ['2025-07-01T00:00:00'] },
    ])).toBe('Ordered At from 1 Jan 2025 · Ordered At before 1 Jul 2025');
    expect(receipt([{ field: 'customer_name', op: 'in', values: ['Angela Moyer'] }])).toBe('Customer Name Angela Moyer');
  });
});
