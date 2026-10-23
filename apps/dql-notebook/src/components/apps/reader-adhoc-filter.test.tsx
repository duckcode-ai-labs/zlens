import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { dashboardFilterCandidates } from './dashboard-filters';
import { filterValueCapHint, filterValueSearchRequest, loadBlockFilterValues, searchFilterValues } from './filter-value-search';
import { SearchableFilterSelect } from './app-dashboard-filters';
import { filterControlOptions, filterControlTypeLabel } from './builder/GlobalFilterBar';
import { TableOutput } from '../output/TableOutput';

/**
 * Codex end-to-end report, 23 Oct 2026: the reader's ad-hoc "Filter this page
 * by" picker offered 24 names sampled from the tiles' rows, so Keith Cook
 * (customer 501 alphabetically) could not be chosen (F02); and a few plain
 * words (F05, G2).
 */
describe("the reader's Filter by… picker searches every value (Codex F02)", () => {
  const customers = Array.from({ length: 500 }, (_, index) => ({ customer_name: `Customer ${String(index).padStart(3, '0')}` }));
  const run = {
    tiles: [
      { blockId: 'top_beverage_customers', filterableColumns: [{ column: 'customer_name', predicateTarget: 'customer_name' }], result: { columns: ['customer_name', 'beverage_revenue'], rows: customers.slice(0, 10), rowCount: 10 } },
      { blockId: 'customer_profile', filterableColumns: [{ column: 'customer_name', predicateTarget: 'customer_name' }], result: { columns: ['customer_name'], rows: customers, rowCount: 935 } },
    ],
  };

  it('names the saved query with the most rows as the value source', () => {
    const [candidate] = dashboardFilterCandidates(null, run);
    expect(candidate).toMatchObject({ column: 'customer_name', tiles: 2, valueSource: { blockId: 'customer_profile', column: 'customer_name' } });
    // The sampled values stay as the fallback, still at most 24.
    expect(candidate!.sampleValues.length).toBeLessThanOrEqual(24);
  });

  it('loads the first page with its count and searches the server past it', async () => {
    const fetchBlock = vi.fn(async (_block: string, _column: string, options: { search?: string; limit?: number } = {}) => options.search
      ? { options: ['Keith Cook'], truncated: false }
      : { options: customers.slice(0, 200).map((row) => row.customer_name), truncated: true, valueCount: 930 });
    const list = await loadBlockFilterValues({ blockId: 'customer_profile', column: 'customer_name' }, fetchBlock);
    expect(list).toMatchObject({ truncated: true, valueCount: 930 });
    expect(filterValueCapHint(list!)).toBe('Type to search all 930 values');
    const request = filterValueSearchRequest({ blockId: 'customer_profile', column: 'customer_name' }, list!, ' Keith ');
    expect(request).toEqual({ blockId: 'customer_profile', column: 'customer_name', search: 'Keith' });
    await expect(searchFilterValues(request!, undefined, fetchBlock)).resolves.toEqual({ values: ['Keith Cook'], truncated: false, failed: false });
    expect(fetchBlock).toHaveBeenLastCalledWith('customer_profile', 'customer_name', { search: 'Keith', limit: 200 });
  });

  it('a column the server cannot list falls back to the sampled values', async () => {
    await expect(loadBlockFilterValues({ blockId: 'x', column: 'y' }, async () => null)).resolves.toBeNull();
  });

  it('the picker control has no "All" and asks for a value', () => {
    const markup = renderToStaticMarkup(<SearchableFilterSelect icon={null} label="Customer Name" value="" list={{ values: ['Aaron Gardner'], truncated: true, valueCount: 930 }} source={{ blockId: 'customer_profile', column: 'customer_name' }} allowAll={false} onChange={() => undefined} />);
    expect(markup).toContain('Choose a value…');
    expect(markup).toContain('aria-label="Customer Name: choose a value"');
  });
});

describe('plain words (Codex F05, G2)', () => {
  it('names filter controls in words', () => {
    expect(filterControlTypeLabel('daterange')).toBe('Date range');
    expect(filterControlTypeLabel('multiselect')).toBe('Multi-select');
    expect(filterControlTypeLabel('relative_date')).toBe('Relative date');
    // A one-value list searches every value, so it says so: never "Dropdown" (Codex rerun words).
    expect(filterControlTypeLabel('select')).toBe('Searchable list');
    expect(filterControlOptions('customer_name').map((option) => option.label)).toContain('Searchable list');
    expect(filterControlOptions('customer_name').map((option) => option.label).join(' ')).not.toMatch(/dropdown/i);
  });

  it('an empty App tile says why', () => {
    const markup = renderToStaticMarkup(<TableOutput result={{ columns: [], rows: [] } as never} themeMode="paper" emptyMessage="No matching rows for these filters." />);
    expect(markup).toContain('No matching rows for these filters.');
    expect(markup).not.toContain('No columns to display');
  });
});
