import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilterTileChoice } from './GlobalFilterBar';
import { studioTileFilterBindings, type StudioFilterTileMapping } from '../app-studio-filter-candidates';

const linkedMapping: StudioFilterTileMapping = {
  key: 'overview:top-customers', pageId: 'overview', pageTitle: 'Overview', tileId: 'top-customers', tileTitle: 'Top customers',
  sourceName: 'top_customers', supported: true, binding: 'customer_name', mode: 'predicate',
};
const cannotTake: StudioFilterTileMapping = {
  key: 'overview:revenue', pageId: 'overview', pageTitle: 'Overview', tileId: 'revenue', tileTitle: 'Revenue trend',
  sourceName: 'revenue_trend', supported: false, reason: 'customer name is not exposed by revenue_trend.',
};

describe('Filters tab: each tile says Applies or Does not apply', () => {
  it('shows the chosen state on every tile row', () => {
    const applies = renderToStaticMarkup(<FilterTileChoice mapping={linkedMapping} applies onChoose={() => undefined} />);
    expect(applies).toContain('filter-mapping-row applies');
    expect(applies).toMatch(/role="radio" aria-checked="true" class="on"[^>]*>.*Applies/);
    expect(applies).toMatch(/aria-checked="false" class=""[^>]*>.*Does not apply/);

    const doesNotApply = renderToStaticMarkup(<FilterTileChoice mapping={linkedMapping} applies={false} onChoose={() => undefined} />);
    expect(doesNotApply).toContain('filter-mapping-row does-not-apply');
    expect(doesNotApply).toMatch(/aria-checked="true" class="on"[^>]*>.*Does not apply/);
  });

  it('lets a tile that cannot take the field only be "Does not apply", with why', () => {
    const markup = renderToStaticMarkup(<FilterTileChoice mapping={cannotTake} applies={false} onChoose={() => undefined} />);
    expect(markup).toContain('unsupported');
    expect(markup).toContain('customer name is not exposed by revenue_trend.');
    expect(markup).toMatch(/aria-checked="false" class="" disabled=""[^>]*>.*Applies/);
  });
});

describe('studioTileFilterBindings stores the choice', () => {
  const base = { filterId: 'customer_name', fieldId: 'customer_name', required: false, filterOnPage: true };

  it('stores "Applies" as a link the next preview checks', () => {
    expect(studioTileFilterBindings({ ...base, tile: {}, applies: true, mapping: linkedMapping })).toEqual([
      { filter: 'customer_name', binding: 'customer_name', mode: 'predicate', required: false, capability: 'preflight_required' },
    ]);
  });

  it('stores "Does not apply" as an explicit exclusion instead of removing the binding', () => {
    const tile = { filterBindings: [{ filter: 'customer_name', binding: 'customer_name', mode: 'predicate' as const, capability: 'preflight_required' as const }, { filter: 'region', binding: 'region' }] };
    expect(studioTileFilterBindings({ ...base, tile, applies: false, mapping: linkedMapping })).toEqual([
      { filter: 'region', binding: 'region' },
      { filter: 'customer_name', capability: 'unsupported', unsupportedReason: 'Author: does not apply' },
    ]);
  });

  it('defaults a tile that cannot take an App-scope filter to "Does not apply" with the reason', () => {
    expect(studioTileFilterBindings({ ...base, tile: {}, applies: false, mapping: cannotTake })).toEqual([
      { filter: 'customer_name', capability: 'unsupported', unsupportedReason: 'customer name is not exposed by revenue_trend.' },
    ]);
  });

  it('drops every entry for the filter when the filter is not on the page', () => {
    const tile = { filterBindings: [{ filter: 'customer_name', capability: 'unsupported' as const, unsupportedReason: 'Author: does not apply' }] };
    expect(studioTileFilterBindings({ ...base, tile, filterOnPage: false, applies: false, mapping: linkedMapping })).toEqual([]);
  });
});
