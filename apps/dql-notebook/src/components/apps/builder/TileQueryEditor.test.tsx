import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import { TileQueryEditor, datasetEditorFields, parseFilterValues } from './TileQueryEditor';
import { buildDatasetComparison, defaultDatasetComparisonDraft } from '../app-dataset-comparison';

const descriptor = {
  version: 1, id: 'orders', kind: 'block', sourceRevision: 'r1', snapshotId: 's1', label: 'Orders',
  contractRef: { kind: 'block_source', id: 'orders', fingerprint: 'c1' },
  binding: { sourceQualifiedId: 'orders', sourceRevision: 'r1', contractFingerprint: 'c1', state: 'valid' },
  lifecycle: 'certified', trust: 'certified', grain: { entityIds: ['order_line'], keyFields: ['order_line_id'] },
  fields: [
    { kind: 'physical', name: 'region', qualifiedId: 'f.region', type: 'string', role: 'dimension', status: 'approved' },
    { kind: 'physical', name: 'channel', qualifiedId: 'f.channel', type: 'string', role: 'dimension', status: 'suggested' },
    { kind: 'physical', name: 'order_date', qualifiedId: 'f.order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'month'], primary: true } },
    { kind: 'measure', name: 'unit_price', qualifiedId: 'm.unit_price', aggregation: 'sum', from: 'unit_price', dependsOn: ['unit_price'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'suggested' },
    { kind: 'measure', name: 'revenue', qualifiedId: 'm.revenue', aggregation: 'sum', from: 'net_amount', dependsOn: ['net_amount'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' },
  ],
  operations: ['filter', 'group', 'trend', 'rank', 'compare', 'having'], execution: { route: 'certified' },
} as unknown as DatasetDescriptor;

const render = (query: Parameters<typeof TileQueryEditor>[0]['query']) => renderToStaticMarkup(
  <TileQueryEditor descriptor={descriptor} query={query} disabled={false} onChange={() => undefined} idPrefix="test" />,
);

describe('TileQueryEditor', () => {
  it('lists suggested fields as visible but unselectable, with a review badge', () => {
    const markup = render({ dimensions: [], measures: [{ measure: 'revenue' }] });
    expect(markup).toContain('Suggested · not certified yet');
    expect(markup).toMatch(/<label class="is-suggested"[^>]*><input type="checkbox" disabled=""/);
    expect(markup).toContain('Channel (suggested, not certified yet)');
    // Approved entries come first.
    expect(datasetEditorFields(descriptor).measures.map((measure) => measure.name)).toEqual(['revenue', 'unit_price']);
  });

  it('shows sort direction and a Top N control for a ranked grouping', () => {
    const markup = render({ dimensions: [{ field: 'region' }], measures: [{ measure: 'revenue' }], orderBy: [{ alias: 'revenue', direction: 'desc' }], limit: 5 });
    expect(markup).toContain('Sort by');
    expect(markup).toContain('Descending');
    expect(markup).toContain('Show top');
    expect(markup).toContain('value="5"');
  });

  it('keeps comparison governance settings behind a closed Advanced section', () => {
    const built = buildDatasetComparison(descriptor, { ...defaultDatasetComparisonDraft(descriptor), baseStart: '2026-02-01', baseEnd: '2026-03-01', comparisonStart: '2026-01-01', comparisonEnd: '2026-02-01' });
    expect(built.status).toBe('ready');
    if (built.status !== 'ready') return;
    const markup = render({ dimensions: [], measures: [{ measure: 'revenue' }], comparison: built.comparison });
    expect(markup).toContain('Advanced period settings');
    expect(markup).toMatch(/<details class="dataset-comparison-advanced"><summary>/);
    expect(markup).toContain('Applied: ');
    // A comparison aligns whole periods, so ranking controls are hidden.
    expect(markup).not.toContain('Sort by');
  });

  it('parses typed filter input and refuses values that do not fit', () => {
    expect(parseFilterValues('number', 'between', '10, 20')).toEqual([10, 20]);
    expect(parseFilterValues('number', 'between', '10')).toBeNull();
    expect(parseFilterValues('number', 'gt', 'ten')).toBeNull();
    expect(parseFilterValues('boolean', 'eq', 'TRUE')).toEqual([true]);
    expect(parseFilterValues('string', 'in', 'EU, US')).toEqual(['EU', 'US']);
    expect(parseFilterValues('string', 'eq', '  ')).toBeNull();
  });
});
