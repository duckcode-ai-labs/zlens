import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AddDataBrowser } from './AddDataBrowser';
import { appDataSourceFromCandidate } from './app-data';
import { draftRevenueQuery, draftWith, marginMetrics, orderLinesDataset, topCustomersQuery } from './app-data.fixtures';

const catalog = [orderLinesDataset, marginMetrics, topCustomersQuery, draftRevenueQuery];

function render(props: Partial<Parameters<typeof AddDataBrowser>[0]> = {}): string {
  return renderToStaticMarkup(<AddDataBrowser
    draftId="build_1"
    draft={draftWith()}
    sourcePolicy="governed_only"
    initialItems={catalog}
    onAdd={vi.fn(async () => true)}
    onRemove={vi.fn()}
    onChangePolicy={vi.fn()}
    {...props}
  />);
}

describe('Add data browser (design D3)', () => {
  it('shows three tabs and lists Datasets and Metrics apart from saved queries', () => {
    const markup = render();
    expect(markup).toContain('Datasets &amp; Metrics');
    expect(markup).toContain('Saved queries');
    expect(markup).toContain('Database tables');
    expect(markup).toContain('Search Datasets, Metrics and saved queries');
    expect(markup).toContain('Order Lines');
    expect(markup).toContain('Dataset · Certified · Commerce · analytics@example.com');
    expect(markup).toContain('Metrics · Certified · Finance');
    expect(markup).not.toContain('Top Customers');

    const queries = render({ initialTab: 'queries' });
    expect(queries).toContain('Top Customers');
    expect(queries).toContain('Saved query · Certified · Orders');
    expect(queries).toContain('Saved query · Needs review · Growth');
    expect(queries).not.toContain('Order Lines');
  });

  it('starts the domain chips on the App domain and shows the data rule with a way to change it', () => {
    const markup = render({ appDomain: 'commerce', domainOptions: [{ value: 'finance', label: 'Finance' }] });
    expect(markup).toMatch(/<button type="button" aria-pressed="false" class="">All<\/button>/);
    expect(markup).toMatch(/aria-pressed="true" class="on">commerce<\/button>/);
    expect(markup).toContain('>Finance</button>');
    expect(markup).toContain('Data rule: <strong>Only certified data</strong>');
    expect(markup).toContain('>Change</button>');
    expect(render({ sourcePolicy: 'include_review_required' })).toContain('Also allow data that needs review');
  });

  it('marks data already in the App Added with Remove, and offers Add to App on the rest', () => {
    const markup = render({ draft: draftWith({ sources: [appDataSourceFromCandidate(orderLinesDataset)] }) });
    expect(markup).toContain('Added');
    expect(markup).toContain('aria-label="Remove Order Lines from this App"');
    expect(markup).toContain('aria-label="Add to App: Margin"');
  });

  it('asks before adding data that needs review while only certified data is allowed', () => {
    const governed = render({ initialTab: 'queries' });
    expect(governed).toContain('Allow data that needs review &amp; add');
    expect(governed).toContain('aria-label="Allow data that needs review and add: Draft Revenue"');
    expect(governed).toContain('aria-label="Add to App: Top Customers"');
    const allowed = render({ initialTab: 'queries', sourcePolicy: 'include_review_required' });
    expect(allowed).not.toContain('Allow data that needs review &amp; add');
    expect(allowed).toContain('aria-label="Add to App: Draft Revenue"');
  });

  it('says what to do when there is no certified data yet', () => {
    const markup = render({ initialItems: [draftRevenueQuery] });
    expect(markup).toContain('No certified data yet.');
    expect(markup).toContain('Start from a database table, or allow data that needs review.');
    expect(markup).toContain('Start from a database table</button>');
    expect(markup).toContain('>Allow data that needs review</button>');
  });

  it('turns a database table into a Dataset after one check', () => {
    const markup = render({ initialTab: 'tables' });
    expect(markup).toContain('A table becomes a Dataset after ZLens checks it once.');
    expect(markup).toContain('Search tables');
    expect(markup).not.toContain('role="group" aria-label="Domain"');
  });
});
