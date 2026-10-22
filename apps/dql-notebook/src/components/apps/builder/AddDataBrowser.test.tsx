import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WarehouseTableSummary } from '../../../api/client';
import { AddDataBrowser } from './AddDataBrowser';
import { appDataSourceFromCandidate } from './app-data';
import { draftRevenueQuery, draftWith, marginMetrics, monthlyRevenueQuery, orderLinesDataset, ordersTableDataset, topCustomersQuery } from './app-data.fixtures';

const catalog = [ordersTableDataset, orderLinesDataset, monthlyRevenueQuery, marginMetrics, topCustomersQuery, draftRevenueQuery];
const tables = [
  { id: 'dev.customers', name: 'customers', schema: 'dev', relation: 'dev.customers', columnCount: 7, rowCountEstimate: 935 },
] as unknown as WarehouseTableSummary[];

function render(props: Partial<Parameters<typeof AddDataBrowser>[0]> = {}): string {
  return renderToStaticMarkup(<AddDataBrowser
    draftId="build_1"
    draft={draftWith()}
    sourcePolicy="governed_only"
    initialItems={catalog}
    initialTables={tables}
    onAdd={vi.fn(async () => true)}
    onRemove={vi.fn()}
    onChangePolicy={vi.fn()}
    {...props}
  />);
}

describe('Add data browser: one list (design D1)', () => {
  it('shows every kind of data in one list, with its origin, trust and domain, and no tabs', () => {
    const markup = render();
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('Datasets &amp; Metrics');
    expect(markup).toContain('role="group" aria-label="Kind of data"');
    for (const chip of ['>All<', '>Tables<', '>Saved queries<', '>Metrics<']) expect(markup).toContain(chip);
    expect(markup).toContain('Search tables, saved queries and Metrics');
    expect(markup).toContain('Table · Certified · Commerce · analytics@example.com');
    expect(markup).toContain('Saved query · Certified · Commerce · analytics@example.com');
    expect(markup).toContain('Metrics · Certified · Finance');
    expect(markup).toContain('Saved query · Certified · Orders');
    expect(markup).toContain('Saved query · Needs review · Growth');
    // A database table not checked yet is in the same list and goes through the check.
    expect(markup).toContain('Table · Not checked yet · dev · 7 columns · ~935 rows');
    expect(markup).toContain('aria-label="Check customers and add it"');
    expect(markup).toContain('ZLens checks a table once before Apps use it.');
    // In the catalog's trust order, tables not checked yet last.
    const order = ['Orders', 'Order Lines', 'Monthly Revenue', 'Margin', 'Top Customers', 'Draft Revenue', '>customers<'].map((name) => markup.indexOf(name));
    expect(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1]!))).toBe(true);
  });

  it('narrows the list with one chip at a time', () => {
    const queries = render({ initialKind: 'queries' });
    expect(queries).toContain('Monthly Revenue');
    expect(queries).toContain('Top Customers');
    expect(queries).not.toContain('Margin');
    expect(queries).not.toContain('Check customers and add');
    const onlyTables = render({ initialKind: 'tables' });
    expect(onlyTables).toContain('aria-label="Add to App: Orders"');
    expect(onlyTables).toContain('Check customers and add');
    expect(onlyTables).not.toContain('Top Customers');
    expect(render({ initialKind: 'metrics' })).toContain('Margin');
    // A domain chip shows catalog data only: database tables have no domain.
    expect(render({ appDomain: 'commerce' })).not.toContain('Check customers and add');
  });

  it('starts the domain chips on the App domain and shows the data rule with a way to change it', () => {
    const markup = render({ appDomain: 'commerce', domainOptions: [{ value: 'finance', label: 'Finance' }] });
    expect(markup).toMatch(/<button type="button" aria-pressed="false" class="">All domains<\/button>/);
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
    const governed = render();
    expect(governed).toContain('Allow data that needs review &amp; add');
    expect(governed).toContain('aria-label="Allow data that needs review and add: Draft Revenue"');
    expect(governed).toContain('aria-label="Add to App: Top Customers"');
    const allowed = render({ sourcePolicy: 'include_review_required' });
    expect(allowed).not.toContain('Allow data that needs review &amp; add');
    expect(allowed).toContain('aria-label="Add to App: Draft Revenue"');
  });

  it('puts Make row-level under ⋯ on saved queries only, with no Add fields button or no-fields note', () => {
    const markup = render();
    expect(markup).not.toContain('Add fields');
    expect(markup).not.toContain('no fields');
    expect(markup).toContain('aria-label="More for Monthly Revenue"');
    expect(markup).toContain('aria-label="More for Top Customers"');
    expect(markup).not.toContain('aria-label="More for Order Lines"');
    expect(markup).not.toContain('aria-label="More for Margin"');
    expect(render({ fieldsEnabled: false })).not.toContain('aria-label="More for');
  });

  it('says what to do when there is no certified data yet', () => {
    const markup = render({ initialItems: [draftRevenueQuery] });
    expect(markup).toContain('No certified data yet.');
    expect(markup).toContain('Start from a database table, or allow data that needs review.');
    expect(markup).toContain('Start from a database table</button>');
    expect(markup).toContain('>Allow data that needs review</button>');
  });
  it('marks tables setup drafted or Modeling models, lists them first, and links drafts to Modeling (D7)', () => {
    const modeledTables = [
      { id: 'dev.payments', name: 'payments', schema: 'dev', relation: 'dev.payments', columnCount: 4 },
      { id: 'dev.orders', name: 'orders', schema: 'dev', relation: 'dev.orders', columnCount: 9, modeled: { state: 'drafted', entity: 'Orders', domain: 'dev', key: 'order_id', proposalId: 'ctxprop_1' } },
      { id: 'dev.customers', name: 'customers', schema: 'dev', relation: 'dev.customers', columnCount: 7, modeled: { state: 'modeled', entity: 'Customers', domain: 'dev', key: 'customer_id' } },
    ] as unknown as WarehouseTableSummary[];
    const markup = render({ initialItems: [], initialTables: modeledTables, initialKind: 'tables' });
    expect(markup).toContain('Table · Modeled · dev · 7 columns');
    expect(markup).toContain('Table · Drafted — review to use · dev · 9 columns');
    expect(markup).toContain('Drafted in setup with its row key (order_id) and joins.');
    expect(markup).toContain('>Review in Modeling</button>');
    expect(markup).toContain('Table · Not checked yet · dev · 4 columns');
    // Modeled first, then drafted, then the rest; each still goes through Check and add.
    const order = ['>customers<', '>orders<', '>payments<'].map((name) => markup.indexOf(name));
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    expect(markup).toContain('aria-label="Check orders and add it"');
    // Drafts are kept: the list says how many wait for review.
    expect(markup).toContain('1 drafted model waiting for review.');
  });

  it('hides staging copies of a listed table behind Show staging tables (new-user round 2, Q3)', () => {
    const layered = [
      { id: 'dev.customers', name: 'customers', schema: 'dev', relation: 'dev.customers', columnCount: 7 },
      { id: 'dev.stg_customers', name: 'stg_customers', schema: 'dev', relation: 'dev.stg_customers', columnCount: 7 },
      { id: 'raw.orders', name: 'orders', schema: 'raw', relation: 'raw.orders', columnCount: 5 },
      { id: 'dev.orders', name: 'orders', schema: 'dev', relation: 'dev.orders', columnCount: 9 },
      // The only copy of payments stays.
      { id: 'dev.stg_payments', name: 'stg_payments', schema: 'dev', relation: 'dev.stg_payments', columnCount: 4 },
    ] as unknown as WarehouseTableSummary[];
    const markup = render({ initialItems: [], initialTables: layered, initialKind: 'tables' });
    expect(markup).toContain('data-table-id="dev.customers"');
    expect(markup).toContain('data-table-id="dev.orders"');
    expect(markup).toContain('data-table-id="dev.stg_payments"');
    expect(markup).not.toContain('data-table-id="dev.stg_customers"');
    expect(markup).not.toContain('data-table-id="raw.orders"');
    expect(markup).toContain('Show staging tables');
    expect(markup).toContain('2 staging copies of tables listed here hidden');
  });
});
