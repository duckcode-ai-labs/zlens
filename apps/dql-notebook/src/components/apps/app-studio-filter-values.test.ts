import { describe, expect, it } from 'vitest';
import type { AppStudioBuildDraft } from '../../api/client';
import { filterLinkedTileIds, studioDateControlHint, studioFilterRunPlan, studioFilterValue } from './app-studio-filter-values';

type Page = AppStudioBuildDraft['pages'][number];

const page = {
  id: 'overview',
  metadata: { title: 'Overview' },
  datasets: [{ id: 'customers', sourceId: 'app:customers', sourceRevision: 'r1' }],
  filters: [
    { id: 'customer_name', type: 'select', label: 'Customer Name', datasetBindings: { customers: { field: 'customer_name' } } },
    { id: 'period', type: 'daterange', label: 'Period' },
    { id: 'region', type: 'select', label: 'Region', scope: { page: 'overview', tileIds: ['saved'] } },
  ],
  layout: {
    kind: 'grid', cols: 12, rowHeight: 80,
    items: [
      { i: 'spend', sourceId: 'app:customers', sourceRevision: 'r1', query: { dimensions: [], measures: [] }, viz: { type: 'bar' } },
      { i: 'saved', block: { blockId: 'top_customers' }, viz: { type: 'table' }, filterBindings: [
        { filter: 'customer_name', capability: 'unsupported', unsupportedReason: 'Does not apply' },
        { filter: 'period', binding: 'month', mode: 'predicate' },
        { filter: 'region', binding: 'region', mode: 'predicate' },
      ] },
      { i: 'insight', aiPin: { id: 'pin' }, viz: { type: 'single_value' }, parameterBindings: [{ param: 'p', source: 'dashboard_filter', filter: 'period' }] },
      { i: 'note', text: 'Notes', viz: { type: 'text' } },
    ],
  },
} as unknown as Page;

describe('which tiles a filter change re-runs (B3)', () => {
  it('names only the tiles linked to the filter', () => {
    expect(filterLinkedTileIds(page, 'customer_name')).toEqual(['spend']);
    expect(filterLinkedTileIds(page, 'period')).toEqual(['saved', 'insight']);
    expect(filterLinkedTileIds(page, 'region')).toEqual(['saved']);
    expect(filterLinkedTileIds(page, 'missing')).toEqual([]);
  });

  it('re-runs the linked tiles once the page has a settled preview, and the whole page before that', () => {
    expect(studioFilterRunPlan({ page, filterId: 'customer_name', hasSettledPreview: true })).toEqual({ kind: 'tiles', tileIds: ['spend'] });
    expect(studioFilterRunPlan({ page, filterId: 'customer_name', hasSettledPreview: false })).toEqual({ kind: 'page' });
    expect(studioFilterRunPlan({ page, filterId: 'missing', hasSettledPreview: true })).toEqual({ kind: 'none' });
  });
});

describe('the value a date range control stores (D8)', () => {
  it('keeps a one-sided range and clears an empty one', () => {
    expect(studioFilterValue({ type: 'daterange' }, { start: '2025-03-01', end: '' })).toEqual({ start: '2025-03-01' });
    expect(studioFilterValue({ type: 'daterange' }, { end: '2025-06-30' })).toEqual({ end: '2025-06-30' });
    expect(studioFilterValue({ type: 'daterange' }, { start: '', end: '' })).toBeUndefined();
    expect(studioFilterValue({ type: 'daterange' }, { start: '2025-03-01', end: '2025-06-30' })).toEqual({ start: '2025-03-01', end: '2025-06-30' });
    expect(studioFilterValue({ type: 'select' }, 'Alice')).toBe('Alice');
  });
});

describe('what a date control says (D8, B4)', () => {
  it('says "From" or "Until" for a one-sided range', () => {
    expect(studioDateControlHint({ type: 'daterange', value: { start: '2025-03-01' } })).toEqual({ text: 'From 1 Mar 2025', empty: false });
    expect(studioDateControlHint({ type: 'daterange', value: { end: '2025-06-30' } })).toEqual({ text: 'Until 30 Jun 2025', empty: false });
    expect(studioDateControlHint({ type: 'date', value: '2025-06-30' })).toEqual({ text: 'On 30 Jun 2025', empty: false });
  });

  it('never claims "no values" when values could not be read', () => {
    expect(studioDateControlHint({ type: 'daterange', value: undefined })).toEqual({ text: 'Any date · set a start, an end, or both', empty: false });
    expect(studioDateControlHint({ type: 'daterange', value: undefined, availability: {} })).toEqual({ text: 'Any date · set a start, an end, or both', empty: false });
    expect(studioDateControlHint({ type: 'date', value: '' })).toEqual({ text: 'Any date', empty: false });
  });

  it('shows the dates a run read, and "no dates" only when a run read the field and found none', () => {
    expect(studioDateControlHint({ type: 'daterange', value: undefined, availability: { valueCount: 4, dateRange: { min: '2024-01-01', max: '2024-01-04' } } }))
      .toEqual({ text: 'Data from 1 Jan 2024 to 4 Jan 2024', empty: false });
    expect(studioDateControlHint({ type: 'daterange', value: undefined, availability: { valueCount: 0 } }))
      .toEqual({ text: 'This field has no dates in the current result', empty: true });
  });
});
