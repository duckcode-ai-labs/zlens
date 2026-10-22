import { describe, expect, it } from 'vitest';
import {
  acceptRememberedAppFilterValues,
  dashboardFilterFingerprint,
  dashboardFilterValueFits,
  hydrateAppScopedDashboardFilterValues,
  pagesForDashboardFilterValue,
  readPersistedAppFilterValues,
  valuesForDashboardPage,
  writePersistedAppFilterValues,
} from './app-dashboard-filter-scope';

const pages = [
  { id: 'overview', filters: [
    { id: 'region', scope: { app: true } },
    { id: 'status', scope: { page: 'overview' } },
  ] },
  { id: 'details', filters: [
    { id: 'region', scope: { app: true } },
    // A deliberate id collision with a page-local control must not create an
    // implicit App-wide filter.
    { id: 'status', scope: { page: 'details' } },
  ] },
];

describe('App dashboard filter scope', () => {
  it('moves only explicitly App-scoped values across pages', () => {
    expect(pagesForDashboardFilterValue(pages, 'overview', pages[0]!.filters[0]!)).toEqual(['overview', 'details']);
    expect(pagesForDashboardFilterValue(pages, 'overview', pages[0]!.filters[1]!)).toEqual(['overview']);

    expect(valuesForDashboardPage({
      filters: pages[1]!.filters,
      pageValues: { status: 'open' },
      appValues: { region: 'CA', status: 'wrong-page' },
      defaultValue: () => '',
    })).toEqual({ region: 'CA', status: 'open' });
  });

  it('hydrates a newly added App page without changing a same-id page-local value', () => {
    const page = {
      id: 'page-3',
      filters: [
        { id: 'region', scope: { app: true } },
        { id: 'status', scope: { page: 'page-3' } },
      ],
    };

    expect(hydrateAppScopedDashboardFilterValues({
      filters: page.filters,
      pageValues: { status: 'open' },
      appValues: { region: 'CA', status: 'must-not-leak' },
    })).toEqual({ region: 'CA', status: 'open' });

    // Clearing a shared control is still an intentional App selection. A
    // later page must show All values rather than reviving an old page value.
    expect(hydrateAppScopedDashboardFilterValues({
      filters: page.filters,
      pageValues: { region: 'CA', status: 'open' },
      appValues: { region: '' },
    })).toEqual({ region: '', status: 'open' });
  });

  it('persists only a validated object envelope for an App session', () => {
    const writes = new Map<string, string>();
    const storage: Pick<Storage, 'getItem' | 'setItem'> = {
      getItem: (key: string) => writes.get(key) ?? null,
      setItem: (key: string, value: string) => { writes.set(key, value); },
    };
    writePersistedAppFilterValues(storage, 'app:commerce', {
      draft: { region: 'CA' },
      applied: { region: 'CA' },
      fingerprints: { region: 'fp' },
    });
    expect(readPersistedAppFilterValues(storage, 'app:commerce')).toEqual({
      draft: { region: 'CA' },
      applied: { region: 'CA' },
      fingerprints: { region: 'fp' },
    });
    writes.set('bad', JSON.stringify({ draft: ['CA'], applied: 'CA', fingerprints: { region: 3 } }));
    expect(readPersistedAppFilterValues(storage, 'bad')).toEqual({ draft: {}, applied: {}, fingerprints: {} });
  });
});

describe('remembered App filter values', () => {
  const customerSingle = {
    id: 'customer_name',
    type: 'select',
    scope: { app: true },
    field: { name: 'customer_name' },
    datasetBindings: { orders: { field: 'customer_name' } },
  };
  const customerMulti = { ...customerSingle, type: 'multiselect', multiple: true };

  function storageWith(value: unknown) {
    const writes = new Map<string, string>([['app:sales', JSON.stringify(value)]]);
    return { getItem: (key: string) => writes.get(key) ?? null };
  }

  it('ignores a value left from an earlier filter re-created with the same id (the reader saw "All" while a customer applied)', () => {
    // An earlier session on the same port and App id chose one customer in a
    // single-select filter. The App was rebuilt and the filter re-created as a
    // multi-select with the same id.
    const legacy = readPersistedAppFilterValues(storageWith({
      draft: { customer_name: 'Angela Moyer' },
      applied: { customer_name: 'Angela Moyer' },
    }), 'app:sales');
    const fromLegacy = acceptRememberedAppFilterValues({ filters: [customerMulti], values: legacy.applied, fingerprints: legacy.fingerprints });
    expect(fromLegacy).toEqual({ values: {}, rejected: ['customer_name'] });
    // The page therefore applies exactly what the control shows: nothing.
    expect(valuesForDashboardPage({
      filters: [customerMulti],
      pageValues: {},
      appValues: fromLegacy.values,
      defaultValue: () => [],
    })).toEqual({ customer_name: [] });

    // Same story when the earlier value carried the old filter's fingerprint.
    const fingerprinted = readPersistedAppFilterValues(storageWith({
      draft: { customer_name: 'Angela Moyer' },
      applied: { customer_name: 'Angela Moyer' },
      fingerprints: { customer_name: dashboardFilterFingerprint(customerSingle) },
    }), 'app:sales');
    expect(acceptRememberedAppFilterValues({
      filters: [customerMulti],
      values: fingerprinted.applied,
      fingerprints: fingerprinted.fingerprints,
    })).toEqual({ values: {}, rejected: ['customer_name'] });
  });

  it('ignores a value whose filter now reads a different field', () => {
    const moved = { ...customerSingle, field: { name: 'customer_id' }, datasetBindings: { orders: { field: 'customer_id' } } };
    expect(dashboardFilterFingerprint(moved)).not.toBe(dashboardFilterFingerprint(customerSingle));
    expect(acceptRememberedAppFilterValues({
      filters: [moved],
      values: { customer_name: 'Angela Moyer' },
      fingerprints: { customer_name: dashboardFilterFingerprint(customerSingle) },
    })).toEqual({ values: {}, rejected: ['customer_name'] });
    // A Dataset mapping that moved to another field also counts.
    const remapped = { ...customerSingle, datasetBindings: { orders: { field: 'buyer_name' } } };
    expect(acceptRememberedAppFilterValues({
      filters: [remapped],
      values: { customer_name: 'Angela Moyer' },
      fingerprints: { customer_name: dashboardFilterFingerprint(customerSingle) },
    }).rejected).toEqual(['customer_name']);
  });

  it('restores a value chosen for the same filter, and keeps values for filters this page does not declare', () => {
    const relabelled = { ...customerMulti, label: 'Customer' };
    expect(acceptRememberedAppFilterValues({
      filters: [relabelled],
      values: { customer_name: ['Angela Moyer'], region: 'CA' },
      fingerprints: { customer_name: dashboardFilterFingerprint(customerMulti) },
    })).toEqual({ values: { customer_name: ['Angela Moyer'], region: 'CA' }, rejected: [] });
  });

  it('never applies a value its control cannot show', () => {
    expect(dashboardFilterValueFits(customerMulti, 'Angela Moyer')).toBe(false);
    expect(dashboardFilterValueFits(customerMulti, ['Angela Moyer'])).toBe(true);
    const range = { id: 'ordered_at', type: 'daterange' };
    expect(dashboardFilterValueFits(range, { start: '2025-01-01', end: '2025-06-30' })).toBe(true);
    expect(dashboardFilterValueFits(range, '')).toBe(true);
    expect(dashboardFilterValueFits(range, 'last_30_days')).toBe(false);
    expect(dashboardFilterValueFits({ id: 'active', type: 'boolean' }, 'true')).toBe(false);
    // Same fingerprint, wrong shape: still refused when it came from storage.
    expect(acceptRememberedAppFilterValues({
      filters: [customerMulti],
      values: { customer_name: 'Angela Moyer' },
      fingerprints: { customer_name: dashboardFilterFingerprint(customerMulti) },
      remembered: new Set(['customer_name']),
    }).rejected).toEqual(['customer_name']);
    // A value being typed now is the control's own: "-" on its way to "-5" stays.
    const amount = { id: 'amount', type: 'number', scope: { app: true } };
    expect(acceptRememberedAppFilterValues({
      filters: [amount],
      values: { amount: '-' },
      fingerprints: { amount: dashboardFilterFingerprint(amount) },
      remembered: new Set(),
    })).toEqual({ values: { amount: '-' }, rejected: [] });
  });
});
