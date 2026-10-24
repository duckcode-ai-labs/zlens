import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import type { AppBlockRecommendation } from '../../../api/client';
import { QuickChoices, QuickStartStep, QuickTilesPanel } from './QuickChoices';
import {
  QUICK_CHOICE_LIMIT,
  defaultQuickChoices,
  newQuickChoice,
  quickChoiceData,
  quickChoiceTiles,
  quickChoiceTitle,
  quickDimensionNoun,
  quickFieldKey,
  quickKpiTitle,
  quickMeasureTier,
  quickStartAppName,
  quickTileLayout,
  quickTopTitle,
  quickTrendTitle,
  updateQuickChoice,
  type QuickChoice,
} from './quick-choices';

/** Quick start without AI (round-2 design Q2): quick choices → exactly those tiles. */

function descriptor(id: string, overrides: Partial<DatasetDescriptor>): DatasetDescriptor {
  return {
    version: 1,
    id,
    kind: 'block',
    sourceRevision: 'rev-1',
    snapshotId: 'snap-1',
    contractRef: { kind: 'block_source', id, fingerprint: 'contract-1' },
    binding: { sourceQualifiedId: id, sourceRevision: 'rev-1', contractFingerprint: 'contract-1', state: 'valid', activeSnapshotId: 'snap-1', activeTargetFingerprint: 'warehouse' },
    label: id,
    domain: 'shop',
    lifecycle: 'certified',
    trust: 'certified',
    grain: { entityIds: ['row'], keyFields: ['id'], keyEvidence: 'proof' },
    fields: [],
    operations: ['filter', 'group', 'trend', 'rank', 'having', 'detail'],
    execution: { route: 'certified' },
    ...overrides,
  };
}

const physical = (name: string, extra: Record<string, unknown> = {}) => ({ kind: 'physical', name, qualifiedId: `f::${name}`, type: 'string', role: 'dimension', status: 'approved', ...extra });
const sum = (name: string) => ({ kind: 'measure', name, qualifiedId: `m::${name}`, aggregation: 'sum', from: name, dependsOn: [name], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' });

const ordersDescriptor = descriptor('shop::orders', {
  label: 'Orders',
  grain: { entityIds: ['order'], keyFields: ['order_id'], keyEvidence: 'proof.orders' },
  fields: [
    physical('order_id', { role: 'key' }),
    physical('customer_id', { role: 'key' }),
    physical('status'),
    physical('placed_at', { type: 'date', role: 'time', time: { grains: ['day', 'month'] } }),
    physical('ordered_at', { type: 'timestamp', role: 'time', time: { grains: ['day', 'week', 'month', 'quarter', 'year'], primary: true } }),
    physical('order_total', { type: 'number', role: 'attribute' }),
    sum('order_total'),
    { kind: 'measure', name: 'order_count', qualifiedId: 'm::order_count', aggregation: 'count_distinct', from: 'order_id', dependsOn: ['order_id'], additivity: { entities: 'non_additive', time: 'non_additive' }, allowedAggs: ['count_distinct'], status: 'approved' },
    physical('customer__customer_name', { related: { join: 'customer', column: 'customer_name' } }),
  ],
  joins: [{
    id: 'customer', label: 'Customer', table: 'customers', relation: '"main"."customers"', keys: [{ from: 'customer_id', to: 'customer_id' }],
    cardinality: 'many_to_one', trust: 'certified', origin: 'model', relationshipId: 'orders_customer', uniqueness: 'current', sentence: 'each order has one customer',
  }],
} as unknown as Partial<DatasetDescriptor>);

const customersDescriptor = descriptor('shop::customers', {
  label: 'Customers',
  grain: { entityIds: ['customer'], keyFields: ['customer_id'], keyEvidence: 'proof.customers' },
  fields: [
    physical('customer_id', { role: 'key' }),
    physical('customer_name'),
    physical('lifetime_spend', { type: 'number', role: 'attribute' }),
    sum('lifetime_spend'),
  ],
} as unknown as Partial<DatasetDescriptor>);

const item = (id: string, name: string, dataset: DatasetDescriptor | undefined, extra: Partial<AppBlockRecommendation> = {}) => ({
  id, sourceId: id, name, domain: 'shop', status: 'certified', lifecycle: 'certified', trust: 'certified', owner: null, tags: ['from-table'],
  path: `${name}.dql`, fingerprint: 'rev-1', lastModified: '', description: '', score: 0, reasons: [], kind: 'block',
  capabilities: { measures: [], dimensions: [], outputs: [], filters: [], parameters: [], ...(dataset ? { dataset } : {}) },
  ...extra,
}) as unknown as AppBlockRecommendation;

const orders = item('src:orders', 'Orders', ordersDescriptor);
const customers = item('src:customers', 'Customers', customersDescriptor);
const savedQuery = item('src:query', 'Top customers', undefined);
const data = quickChoiceData([orders, customers, savedQuery], 'shop');
const key = quickFieldKey;

describe('the pickers list the App\'s data the way the Data pane does', () => {
  it('names fields in words, keeps keys last, adds related fields under "Orders → Customer", and finds the main date', () => {
    expect(data.map((entry) => entry.label)).toEqual(['Orders', 'Customers']);
    const [ordersData] = data;
    expect(ordersData!.measures.map((measure) => [measure.label, measure.aggregation])).toEqual([['Order Total', 'sum'], ['Order Count', 'count_distinct']]);
    expect(ordersData!.dimensions.map((field) => [field.label, field.group])).toEqual([
      ['Status', 'Orders'], ['Order Id', 'Orders'], ['Customer Id', 'Orders'], ['Customer Name', 'Orders → Customer'],
    ]);
    // The primary date, not the first one.
    expect(ordersData!.time).toEqual({ name: 'ordered_at', label: 'Ordered At', grains: ['day', 'week', 'month', 'quarter', 'year'], defaultGrain: 'month' });
    expect(data[1]!.time).toBeUndefined();
  });

  it('lists data in the App\'s Domain first, then certified data first', () => {
    const review = item('src:returns', 'Returns', descriptor('shop::returns', { label: 'Returns', fields: [sum('refund') as never] }), { trust: 'review_required', status: 'review', lifecycle: 'review' } as never);
    const elsewhere = item('src:ledger', 'Ledger', descriptor('finance::ledger', { label: 'Ledger', domain: 'finance', fields: [sum('amount') as never] }), { domain: 'finance' } as never);
    expect(quickChoiceData([elsewhere, review, customers], 'shop').map((entry) => [entry.label, entry.inDomain, entry.certified])).toEqual([
      ['Customers', true, true], ['Returns', true, false], ['Ledger', false, true],
    ]);
    // With no Domain (All domains), certified first in the App's order.
    expect(quickChoiceData([review, elsewhere, customers], 'general').map((entry) => entry.label)).toEqual(['Ledger', 'Customers', 'Returns']);
  });
});

describe('the three quick choices a new App opens with', () => {
  it('picks a total of a summed measure, its trend by month, and the top 10 of a name', () => {
    const [kpi, trend, top] = defaultQuickChoices(data);
    expect(kpi).toMatchObject({ kind: 'kpi', measure: key('src:orders', 'order_total') });
    expect(trend).toMatchObject({ kind: 'trend', measure: key('src:orders', 'order_total'), grain: 'month' });
    // "Customer Name" (a related field of Orders) beats keys, and the KPI's data wins a tie.
    expect(top).toMatchObject({ kind: 'top', dimension: key('src:orders', 'customer__customer_name'), measure: key('src:orders', 'order_total'), n: 10 });
    expect(quickChoiceTitle(data, kpi!)).toBe('Order Total');
    expect(quickChoiceTitle(data, trend!)).toBe('Order Total by month');
    expect(quickChoiceTitle(data, top!)).toBe('Top 10 customers by Order Total');
  });

  // New-user round 2, problem 8: every default was "Count Drink Items", the first summed measure.
  it('leads with money, not the first sum: revenue for the KPI, its trend by month, and top customers by name', () => {
    const money = (name: string, extra: Record<string, unknown> = {}) => ({ ...sum(name), format: { kind: 'currency', currency: 'USD' }, ...extra });
    const sales = descriptor('shop::order_items', {
      label: 'Order Items',
      grain: { entityIds: ['order_item'], keyFields: ['order_item_id'], keyEvidence: 'proof' },
      fields: [
        physical('order_item_id', { role: 'key' }),
        physical('customer_id', { role: 'key' }),
        physical('customer_type'),
        physical('ordered_at', { type: 'timestamp', role: 'time', time: { grains: ['day', 'week', 'month', 'quarter', 'year'], primary: true } }),
        sum('count_drink_items'),
        sum('count_food_items'),
        { kind: 'measure', name: 'order_item_count', qualifiedId: 'm::order_item_count', aggregation: 'count', from: 'order_item_id', dependsOn: ['order_item_id'], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['count'], status: 'approved' },
        sum('tax_paid'),
        sum('quantity'),
        money('product_price'),
        money('revenue'),
        physical('customer__customer_name', { related: { join: 'customer', column: 'customer_name' } }),
      ],
      joins: [{
        id: 'customer', label: 'Customer', table: 'customers', relation: '"main"."customers"', keys: [{ from: 'customer_id', to: 'customer_id' }],
        cardinality: 'many_to_one', trust: 'certified', origin: 'model', relationshipId: 'items_customer', uniqueness: 'current', sentence: 'each order item has one customer',
      }],
    } as unknown as Partial<DatasetDescriptor>);
    const itemsData = quickChoiceData([item('src:items', 'Order Items', sales)], 'shop');
    const [kpi, trend, top] = defaultQuickChoices(itemsData);
    expect(kpi).toMatchObject({ kind: 'kpi', measure: key('src:items', 'revenue') });
    expect(trend).toMatchObject({ kind: 'trend', measure: key('src:items', 'revenue'), grain: 'month' });
    expect(top).toMatchObject({ kind: 'top', measure: key('src:items', 'revenue'), dimension: key('src:items', 'customer__customer_name') });
    expect(quickChoiceTitle(itemsData, top!)).toBe('Top 10 customers by Revenue');
    // The order: Money, then money words, then other sums, then counts, then yes/no counts.
    const tiers = Object.fromEntries(itemsData[0]!.measures.map((measure) => [measure.name, quickMeasureTier(measure)]));
    expect(tiers).toEqual({ revenue: 5, product_price: 5, tax_paid: 4, quantity: 1, order_item_count: 1, count_food_items: 0, count_drink_items: 0 });
    // Without Money formats, names decide: "Order Total" before "Order Cost", both before a count.
    const plain = descriptor('shop::plain', { label: 'Plain', fields: [sum('count_drink_items'), sum('order_cost'), sum('order_total'), sum('units')] as never });
    expect(defaultQuickChoices(quickChoiceData([item('src:plain', 'Plain', plain)]))[0]).toMatchObject({ measure: key('src:plain', 'order_total') });
  });

  it('offers only what the data can make', () => {
    const noDate = quickChoiceData([customers]);
    expect(newQuickChoice(noDate, 'trend')).toBeUndefined();
    expect(defaultQuickChoices(noDate).map((choice) => choice.kind)).toEqual(['kpi', 'top']);
    expect(defaultQuickChoices(quickChoiceData([savedQuery]))).toEqual([]);
  });

  it('keeps a changed choice sensible: a grain its date offers, a measure from the same data as what it ranks', () => {
    const trend = newQuickChoice(data, 'trend')!;
    expect(updateQuickChoice(data, trend, { grain: 'quarter' }).grain).toBe('quarter');
    expect(updateQuickChoice(data, trend, { grain: 'hour' }).grain).toBe('month');
    const top = newQuickChoice(data, 'top')!;
    const byCustomer = updateQuickChoice(data, top, { dimension: key('src:customers', 'customer_name') });
    expect(byCustomer.measure).toBe(key('src:customers', 'lifetime_spend'));
    expect(quickChoiceTitle(data, { ...byCustomer, n: 25 })).toBe('Top 25 customers by Lifetime Spend');
  });
});

describe('titles in words', () => {
  it('says "Total <measure>" only where a total reads right', () => {
    expect(quickKpiTitle({ label: 'Lifetime Spend', aggregation: 'sum' })).toBe('Total Lifetime Spend');
    expect(quickKpiTitle({ label: 'Order Total', aggregation: 'sum' })).toBe('Order Total');
    expect(quickKpiTitle({ label: 'Total Revenue', aggregation: 'sum' })).toBe('Total Revenue');
    expect(quickKpiTitle({ label: 'Order Count', aggregation: 'count_distinct' })).toBe('Order Count');
    expect(quickKpiTitle({ label: 'Average Basket', aggregation: 'avg' })).toBe('Average Basket');
  });

  it('names a trend by its grain and a top list by what one row is', () => {
    expect(quickTrendTitle({ label: 'Order Total' }, 'month')).toBe('Order Total by month');
    expect(quickTopTitle(10, { label: 'Customer Name' }, { label: 'Lifetime Spend' })).toBe('Top 10 customers by Lifetime Spend');
    expect(quickTopTitle(1, { label: 'Customer Name' }, { label: 'Lifetime Spend' })).toBe('Top 1 customer by Lifetime Spend');
    expect(quickDimensionNoun('Product Category')).toBe('product categories');
    expect(quickDimensionNoun('Status')).toBe('statuses');
    expect(quickDimensionNoun('Region')).toBe('regions');
    expect(quickDimensionNoun('Name')).toBe('names');
    for (const title of [quickTopTitle(5, { label: 'Store Id' }, { label: 'Order Total' }), quickTrendTitle({ label: 'Order Total' }, 'week')]) {
      expect(title).not.toMatch(/_/);
    }
  });

  it('names the App by what was typed, else "<Domain> overview", never a sentence', () => {
    expect(quickStartAppName({ name: '  Weekly sales ', domainLabel: 'Sales' })).toBe('Weekly sales');
    expect(quickStartAppName({ name: '', domainLabel: 'Sales' })).toBe('Sales overview');
    expect(quickStartAppName({ domainLabel: 'general', data })).toBe('Shop overview');
    expect(quickStartAppName({ data: [{ label: 'Orders', descriptor: { ...ordersDescriptor, domain: undefined } }] })).toBe('Orders overview');
    expect(quickStartAppName({})).toBe('New App');
  });
});

describe('quick choices become exactly the chosen field tiles', () => {
  const choices: QuickChoice[] = [
    { id: 'a', kind: 'kpi', measure: key('src:orders', 'order_total') },
    { id: 'b', kind: 'trend', measure: key('src:orders', 'order_total'), grain: 'week' },
    { id: 'c', kind: 'top', measure: key('src:customers', 'lifetime_spend'), dimension: key('src:customers', 'customer_name'), n: 10 },
  ];

  it('composes a KPI as a single value, a trend as a line on the main date, Top N through sort and limit', () => {
    const plan = quickChoiceTiles(data, choices);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.tiles).toEqual([
      { choiceId: 'a', sourceId: 'src:orders', view: 'kpi', visualization: 'single_value', title: 'Order Total', query: { dimensions: [], measures: [{ measure: 'order_total' }], respectsGlobalFilters: true } },
      { choiceId: 'b', sourceId: 'src:orders', view: 'chart', visualization: 'line', title: 'Order Total by week', query: { dimensions: [{ field: 'ordered_at', timeGrain: 'week' }], measures: [{ measure: 'order_total' }], respectsGlobalFilters: true } },
      {
        choiceId: 'c', sourceId: 'src:customers', view: 'chart', visualization: 'bar', title: 'Top 10 customers by Lifetime Spend',
        query: { dimensions: [{ field: 'customer_name' }], measures: [{ measure: 'lifetime_spend' }], respectsGlobalFilters: true, orderBy: [{ alias: 'lifetime_spend', direction: 'desc' }], limit: 10 },
      },
    ]);
  });

  it('ranks by a related field of the same data', () => {
    const plan = quickChoiceTiles(data, [{ id: 'r', kind: 'top', measure: key('src:orders', 'order_total'), dimension: key('src:orders', 'customer__customer_name'), n: 5 }]);
    expect(plan.ok && plan.tiles[0]).toMatchObject({ sourceId: 'src:orders', title: 'Top 5 customers by Order Total', query: { dimensions: [{ field: 'customer__customer_name' }], limit: 5 } });
  });

  it('refuses what it can\'t build, in words', () => {
    expect(quickChoiceTiles(data, [])).toEqual({ ok: false, error: 'Choose at least one tile.' });
    const many = Array.from({ length: QUICK_CHOICE_LIMIT + 1 }, (_, index) => ({ ...choices[0]!, id: `k${index}` }));
    expect(quickChoiceTiles(data, many)).toEqual({ ok: false, error: `Choose at most ${QUICK_CHOICE_LIMIT} tiles at once.` });
    expect(quickChoiceTiles(data, [{ id: 'x', kind: 'top', measure: key('src:orders', 'order_total'), dimension: key('src:customers', 'customer_name') }]))
      .toEqual({ ok: false, error: 'Tile 1: Customer Name and Order Total come from different data. Pick both from Orders.' });
    expect(quickChoiceTiles(data, [{ id: 'y', kind: 'trend', measure: key('src:customers', 'lifetime_spend'), grain: 'month' }]))
      .toEqual({ ok: false, error: 'Tile 1: Customers has no date to show a trend over.' });
    expect(quickChoiceTiles(data, [{ id: 'z', kind: 'kpi', measure: 'gone|x' }])).toEqual({ ok: false, error: 'Tile 1: choose a measure.' });
  });

  it('places KPIs side by side under the page, then charts two to a row', () => {
    expect(quickTileLayout([{ y: 0, h: 2 }], [{ view: 'kpi' }, { view: 'chart' }, { view: 'chart' }, { view: 'kpi' }, { view: 'chart' }])).toEqual([
      { x: 0, y: 2, w: 3, h: 2 },
      { x: 0, y: 4, w: 6, h: 4 },
      { x: 6, y: 4, w: 6, h: 4 },
      { x: 3, y: 2, w: 3, h: 2 },
      { x: 0, y: 8, w: 6, h: 4 },
    ]);
  });
});

describe('the quick choices on screen', () => {
  it('shows KPI, Trend and Top rows with field pickers, their titles, another tile and Build App', () => {
    const markup = renderToStaticMarkup(<QuickChoices data={data} submitLabel={() => 'Build App'} onSubmit={vi.fn()} />);
    expect(markup).toContain('aria-label="Tile 1: KPI"');
    expect(markup).toContain('aria-label="Tile 2: Trend"');
    expect(markup).toContain('aria-label="Tile 3: Top"');
    expect(markup).toContain('Total of');
    expect(markup).toContain('aria-label="Tile 2: time grain"');
    expect(markup).toContain('aria-label="Tile 3: how many"');
    expect(markup).toContain('aria-label="Tile 3: rank"');
    expect(markup).toContain('<optgroup label="Orders → Customer"><option value="src:orders|customer__customer_name" selected="">Customer Name</option>');
    expect(markup).toContain('Title: <strong>Top 10 customers by Order Total</strong>');
    expect(markup).toContain('Add another tile');
    expect(markup).toContain('aria-label="Add a Trend tile"');
    expect(markup).toContain('>Build App</button>');
    expect(markup).not.toMatch(/order_total<|customer_name</);
  });

  it('says no AI is used, links to connect one, and asks for data with numbers when there is none', () => {
    const step = renderToStaticMarkup(<QuickStartStep appName="Shop overview" data={data} busy={false} onBack={vi.fn()} onBackToData={vi.fn()} onBuild={vi.fn()} onConnectAi={vi.fn()} />);
    expect(step).toContain('What should this App show?');
    expect(step).toContain('No AI is used');
    expect(step).toContain('Connect an AI provider to describe an App in your own words');
    expect(step).toContain('Back to data');
    const empty = renderToStaticMarkup(<QuickStartStep appName="New App" data={quickChoiceData([savedQuery])} busy={false} onBack={vi.fn()} onBackToData={vi.fn()} onBuild={vi.fn()} />);
    expect(empty).toContain('No numbers to add up yet');
    expect(empty).not.toContain('Build App');
  });

  it('adds to the open page from the canvas', () => {
    const panel = renderToStaticMarkup(<QuickTilesPanel pageTitle="Overview" data={data} busy={false} onAdd={vi.fn()} onAddData={vi.fn()} onClose={vi.fn()} />);
    expect(panel).toContain('aria-label="Quick tiles"');
    expect(panel).toContain('Add tiles to Overview');
    expect(panel).toContain('>Add 3 tiles to page</button>');
  });
});
