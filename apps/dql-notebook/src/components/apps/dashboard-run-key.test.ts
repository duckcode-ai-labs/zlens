import { describe, expect, it } from 'vitest';
import type { DashboardDocumentResponse } from '../../api/client';
import {
  dashboardPageRevision,
  dashboardRunKey,
  effectiveDashboardRunVariables,
  MAX_STALE_RERUNS,
  shouldRerunStaleDashboardRun,
  stableStringify,
} from './dashboard-run-key';
import { valuesForDashboardPage } from './app-dashboard-filter-scope';
import { defaultDashboardFilterValue } from './app-dashboard-filters';
import { appCardSeal, appRunTrustAcrossPages } from './app-certification';

type Page = DashboardDocumentResponse['dashboard'];

function page(overrides: Partial<Page> = {}): Page {
  return {
    version: 3,
    id: 'overview',
    metadata: { title: 'Overview' },
    filters: [{ id: 'customer_name', type: 'select', label: 'Customer Name' }],
    layout: {
      kind: 'grid',
      cols: 12,
      rowHeight: 80,
      items: [
        { i: 'spend', x: 0, y: 0, w: 6, h: 4, title: 'Spend by customer', viz: { type: 'bar' } },
        { i: 'total', x: 6, y: 0, w: 3, h: 2, title: 'Total spend', viz: { type: 'kpi' } },
      ],
    },
    ...overrides,
  } as Page;
}

const key = (input: Partial<Parameters<typeof dashboardRunKey>[0]> = {}) => dashboardRunKey({
  appId: 'sales-review',
  page: page(),
  variables: {},
  ...input,
});

describe('a viewer runs its page when what the run reads changes (B1)', () => {
  it('a re-fetched copy of the same page is the same run', () => {
    const first = page();
    const copy = JSON.parse(JSON.stringify(first)) as Page;
    expect(copy).not.toBe(first);
    expect(dashboardPageRevision(copy)).toBe(dashboardPageRevision(first));
    expect(key({ page: copy })).toBe(key({ page: first }));
  });

  it('key order inside the page does not change its revision', () => {
    const first = page();
    const reordered = { layout: first.layout, metadata: first.metadata, id: first.id, filters: first.filters, version: first.version } as Page;
    expect(dashboardPageRevision(reordered)).toBe(dashboardPageRevision(first));
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
  });

  it('a changed page is a new run', () => {
    const edited = page();
    edited.layout.items[1] = { ...edited.layout.items[1]!, title: 'Lifetime spend' };
    expect(key({ page: edited })).not.toBe(key());
  });

  it('`{}` before the filter defaults load and the defaults themselves are the same run', () => {
    // What the reader sends once AppsView has seeded the page's filters.
    const seeded = valuesForDashboardPage({
      filters: page().filters as never,
      pageValues: {},
      appValues: {},
      defaultValue: defaultDashboardFilterValue as never,
    });
    expect(seeded).toEqual({ customer_name: '' });
    expect(key({ variables: seeded })).toBe(key({ variables: {} }));
    expect(key({ variables: { customer_name: [] } })).toBe(key({ variables: {} }));
    expect(key({ variables: { customer_name: null } })).toBe(key({ variables: {} }));
  });

  it('a filter value that selects rows is a new run', () => {
    expect(key({ variables: { customer_name: 'Alice' } })).not.toBe(key({ variables: {} }));
    expect(key({ variables: { customer_name: 'Alice' } })).not.toBe(key({ variables: { customer_name: 'Bob' } }));
  });

  it('a filter default counts, so clearing a defaulted filter is a new run', () => {
    const defaulted = page({ filters: [{ id: 'region', type: 'select', default: 'West' }] as Page['filters'] });
    expect(effectiveDashboardRunVariables(defaulted, {})).toEqual({ region: 'West' });
    expect(key({ page: defaulted, variables: {} })).toBe(key({ page: defaulted, variables: { region: 'West' } }));
    expect(key({ page: defaulted, variables: { region: '' } })).not.toBe(key({ page: defaulted, variables: {} }));
  });

  it('viewer filters, marks, drills and persona each make a new run', () => {
    const base = key();
    expect(key({ viewerFilters: [{ column: 'customer_name', values: ['Alice'], tileIds: ['spend'] }] })).not.toBe(base);
    expect(key({ crossFilters: [{ tileId: 'spend', field: 'customer_name', values: ['Alice'] }] })).not.toBe(base);
    expect(key({ hierarchyDrills: [{ tileId: 'spend', path: ['region'] }] })).not.toBe(base);
    expect(key({ persona: 'sales-manager' })).not.toBe(base);
    expect(key({ appId: 'other-app' })).not.toBe(base);
  });
});

describe('a reader is never left on a stale page', () => {
  it('re-runs a stale result, a bounded number of times', () => {
    expect(shouldRerunStaleDashboardRun({ stale: true }, 0)).toBe(true);
    expect(shouldRerunStaleDashboardRun({ stale: true }, MAX_STALE_RERUNS - 1)).toBe(true);
    expect(shouldRerunStaleDashboardRun({ stale: true }, MAX_STALE_RERUNS)).toBe(false);
  });

  it('keeps a settled result', () => {
    expect(shouldRerunStaleDashboardRun({ stale: false }, 0)).toBe(false);
    expect(shouldRerunStaleDashboardRun({}, 0)).toBe(false);
    expect(shouldRerunStaleDashboardRun(null, 0)).toBe(false);
  });
});

describe('the Apps card and the App read trust from the same result', () => {
  it('a certified App whose run found every tile certified says "App certified"', () => {
    expect(appCardSeal({ lifecycle: 'certified', certification: 'certified', draftCount: 0, runTrust: { certified: 3, total: 3 } }))
      .toEqual({ certified: true, label: 'App certified' });
  });

  it('never says "App certified" while the App\'s run says otherwise', () => {
    expect(appCardSeal({ lifecycle: 'certified', certification: 'certified', draftCount: 0, runTrust: { certified: 0, total: 3 } }))
      .toEqual({ certified: false, label: '0 of 3 tiles certified' });
  });

  it('with no run yet, it shows the lifecycle', () => {
    expect(appCardSeal({ lifecycle: 'certified', certification: undefined, draftCount: 0, runTrust: null }))
      .toEqual({ certified: true, label: 'App certified' });
    expect(appCardSeal({ lifecycle: 'review', certification: undefined, draftCount: 1 }))
      .toEqual({ certified: false, label: 'App in review · 1 change pending' });
  });

  it('adds up the pages a person opened', () => {
    expect(appRunTrustAcrossPages(undefined)).toBeNull();
    expect(appRunTrustAcrossPages({ overview: { certified: 3, total: 3 }, detail: { certified: 1, total: 2 } }))
      .toEqual({ certified: 4, total: 5 });
  });
});
