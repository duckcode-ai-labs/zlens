import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NumberReceiptCard, ReceiptValue, numberReceiptInfo, plainBindingLabel } from './NumberReceipt';
import { StoryText } from './StoryView';

const binding = { key: 'regions.revenue[US]', tileId: 'regions', label: 'Revenue by region — revenue for US', kind: 'number' as const, value: 85, display: '$85' };
const items = [{ i: 'regions', x: 0, y: 0, w: 6, h: 4, title: 'Revenue by region', owner: 'Finance', query: { dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }] }, viz: { type: 'bar' } }] as never;
const run = {
  runId: 'run-1', snapshotId: 'snap-1', filterFingerprint: 'f1',
  tiles: [{ tileId: 'regions', status: 'ok', result: { columns: ['region', 'revenue'], rows: [{ region: 'US', revenue: 85 }], rowCount: 1 }, filters: { applied: [{ field: 'channel', op: 'in', values: ['Web'] }] }, dataset: { trust: 'certified', validation: { outcome: 'covered', adaptations: [] } } }],
} as never;

describe('numbers that explain themselves (RFC 0009 step 6a)', () => {
  it('says what the number is, its tile, trust and filters, without fingerprints', () => {
    expect(plainBindingLabel(binding)).toBe('Revenue for US');
    const leader = { key: 'regions.leader', tileId: 'regions', label: 'Revenue by region — highest region by revenue', kind: 'text' as const, value: 'US', display: 'US' };
    const leaderValue = { key: 'regions.leader_value', tileId: 'regions', label: 'Revenue by region — revenue of that leader', kind: 'number' as const, value: 85, display: '$85' };
    expect(plainBindingLabel(leaderValue, { [leader.key]: leader, [leaderValue.key]: leaderValue })).toBe('Revenue of the top region (US)');
    const info = numberReceiptInfo(binding, items, run, Date.UTC(2026, 8, 24, 9, 30))!;
    expect(info).toMatchObject({ label: 'Revenue for US', value: '$85', tileTitle: 'Revenue by region', trust: { state: 'certified' } });
    expect(info.rows.map((row) => row.label)).toEqual(['Owner', 'Filters', 'Last refreshed']);
    expect(info.rows.find((row) => row.label === 'Filters')?.value).toBe('Channel Web');
    const card = renderToStaticMarkup(<NumberReceiptCard info={info} />);
    expect(card).toContain('<strong>$85</strong>');
    expect(card).toContain('<b>Certified</b>');
    expect(card).not.toContain('fingerprint');
    expect(numberReceiptInfo(undefined, items, run)).toBeNull();
  });

  it('makes a bound number in a report focusable and labelled, and keeps the plain title when there is no receipt', () => {
    const info = numberReceiptInfo(binding, items, run)!;
    const withReceipt = renderToStaticMarkup(<ReceiptValue className="dql-story-value" info={info} fallbackTitle="x">$85</ReceiptValue>);
    expect(withReceipt).toContain('role="button"');
    expect(withReceipt).toContain('aria-label="Revenue for US: $85. Show where this number comes from"');
    const text = renderToStaticMarkup(<StoryText markdown="Revenue in the US is {{regions.revenue[US]}}." catalog={{ [binding.key]: binding }} receiptFor={() => info} />);
    expect(text).toContain('has-receipt');
    const plain = renderToStaticMarkup(<StoryText markdown="Revenue in the US is {{regions.revenue[US]}}." catalog={{ [binding.key]: binding }} />);
    expect(plain).toContain('title="Revenue by region — revenue for US"');
  });
});
