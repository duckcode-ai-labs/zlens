import { describe, expect, it } from 'vitest';
import type { DatasetDescriptor, DatasetField } from '@zlens/core/datasets/descriptor';
import {
  EMPTY_TILE_QUERY,
  autoTileView,
  defaultTileTitle,
  groupDatasetFields,
  queryFieldNames,
  tileVisualization,
  toggleFieldInQuery,
} from './field-query';

const revenue = { kind: 'measure', name: 'revenue', qualifiedId: 'ds.revenue', aggregation: 'sum', from: 'net_amount', dependsOn: [], additivity: { entities: 'additive', time: 'additive' }, allowedAggs: ['sum'], status: 'approved' } as unknown as DatasetField;
const orders = { ...revenue, name: 'order_count', qualifiedId: 'ds.order_count', aggregation: 'count_distinct' } as unknown as DatasetField;
const cost = { ...revenue, name: 'cost', qualifiedId: 'ds.cost', status: 'suggested' } as unknown as DatasetField;
const region = { kind: 'physical', name: 'region', qualifiedId: 'ds.region', type: 'string', role: 'dimension', status: 'approved' } as DatasetField;
const orderDate = { kind: 'physical', name: 'order_date', qualifiedId: 'ds.order_date', type: 'date', role: 'time', status: 'approved', time: { grains: ['day', 'week', 'month'], baseGrain: 'day' } } as DatasetField;
const descriptor = { fields: [revenue, orders, cost, region, orderDate] } as unknown as DatasetDescriptor;
const label = (name: string) => name.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

describe('click-a-field tile building', () => {
  it('lists approved measures, time, and dimensions, and keeps suggested fields apart', () => {
    const groups = groupDatasetFields(descriptor);
    expect(groups.measures.map((field) => field.name)).toEqual(['revenue', 'order_count']);
    expect(groups.time.map((field) => field.name)).toEqual(['order_date']);
    expect(groups.dimensions.map((field) => field.name)).toEqual(['region']);
    expect(groups.review.map((field) => field.name)).toEqual(['cost']);
    expect(groupDatasetFields(descriptor, 'order ').measures.map((field) => field.name)).toEqual(['order_count']);
  });

  it('one measure is a KPI; adding a category makes a bar chart sorted biggest first', () => {
    const kpi = toggleFieldInQuery(EMPTY_TILE_QUERY, revenue);
    expect(kpi.measures).toEqual([{ measure: 'revenue' }]);
    expect(autoTileView(kpi)).toBe('kpi');
    expect(tileVisualization(kpi, 'kpi')).toBe('single_value');

    const byRegion = toggleFieldInQuery(kpi, region);
    expect(byRegion.dimensions).toEqual([{ field: 'region' }]);
    expect(byRegion.orderBy).toEqual([{ alias: 'revenue', direction: 'desc' }]);
    expect(autoTileView(byRegion)).toBe('chart');
    expect(tileVisualization(byRegion, 'chart')).toBe('bar');
    expect(defaultTileTitle(byRegion, label)).toBe('Revenue by region');
  });

  it('a date groups by month, draws a line, and keeps time order', () => {
    const byMonth = toggleFieldInQuery(toggleFieldInQuery(EMPTY_TILE_QUERY, revenue), orderDate);
    expect(byMonth.dimensions).toEqual([{ field: 'order_date', timeGrain: 'month' }]);
    expect(byMonth.orderBy).toBeUndefined();
    expect(tileVisualization(byMonth, autoTileView(byMonth))).toBe('line');
    expect(defaultTileTitle(byMonth, label)).toBe('Revenue by month');
  });

  it('clicking a used field removes it, and two values without a grouping become a table', () => {
    const both = toggleFieldInQuery(toggleFieldInQuery(EMPTY_TILE_QUERY, revenue), orders);
    expect(autoTileView(both)).toBe('table');
    expect(queryFieldNames(both)).toEqual(new Set(['revenue', 'order_count']));
    const back = toggleFieldInQuery(both, orders);
    expect(back.measures).toEqual([{ measure: 'revenue' }]);
    expect(autoTileView(back)).toBe('kpi');
  });

  it('a bar of names starts as an explicit Top 10, and keeps a Top N the author chose (new-user round 3)', () => {
    const customerName = { kind: 'physical', name: 'customer__customer_name', qualifiedId: 'ds.customer_name', type: 'string', role: 'dimension', status: 'approved', related: { join: 'customer', column: 'customer_name' } } as DatasetField;
    const top = toggleFieldInQuery(toggleFieldInQuery(EMPTY_TILE_QUERY, revenue), customerName);
    expect(top).toMatchObject({ orderBy: [{ alias: 'revenue', direction: 'desc' }], limit: 10 });
    // Name first, measure second: the same Top 10.
    expect(toggleFieldInQuery(toggleFieldInQuery(EMPTY_TILE_QUERY, customerName), revenue).limit).toBe(10);
    // The author's Top 25 survives adding a second measure.
    expect(toggleFieldInQuery({ ...top, limit: 25 }, orders).limit).toBe(25);
    // A short list of categories (Region) shows every bar.
    expect(toggleFieldInQuery(toggleFieldInQuery(EMPTY_TILE_QUERY, revenue), region).limit).toBeUndefined();
  });

  it('drops stale sort, limit, and row-detail settings when fields change', () => {
    const next = toggleFieldInQuery({ ...EMPTY_TILE_QUERY, measures: [{ measure: 'revenue' }], orderBy: [{ alias: 'gone', direction: 'asc' }], limit: 5, detail: true, detailColumns: ['region'] }, orderDate);
    expect(next.orderBy).toBeUndefined();
    expect(next.limit).toBeUndefined();
    expect(next.detail).toBeUndefined();
    expect(next.detailColumns).toBeUndefined();
  });
});

// New-user round 2, problem 5: two identical "Order Items → Product" groups.
describe('related field groups never read the same', () => {
  it('names two joins to one table by their keys when an older descriptor still carries both', () => {
    const join = (id: string, from: string) => ({ id, label: 'Product', table: 'products', relation: 'main.products', keys: [{ from, to: from }], cardinality: 'many_to_one', trust: 'review_required', origin: 'drafted', relationshipId: id, uniqueness: 'recheck', sentence: 'each order item has one product' });
    const related = (name: string, joinId: string, column: string) => ({ kind: 'physical', name, qualifiedId: `ds.${name}`, type: 'string', role: 'dimension', status: 'approved', related: { join: joinId, column } });
    const items = {
      fields: [region, related('product__product_type', 'product', 'product_type'), related('product_2__product_type', 'product_2', 'product_type')],
      joins: [join('product', 'product_id'), join('product_2', 'product_name')],
    } as unknown as DatasetDescriptor;
    const paths = groupDatasetFields(items).related.map((group) => group.path);
    expect(paths).toEqual(['Product (by product id)', 'Product (by product name)']);
    expect(new Set(paths).size).toBe(paths.length);
    // One join keeps its plain name.
    const one = { ...items, fields: items.fields.slice(0, 2), joins: items.joins!.slice(0, 1) } as DatasetDescriptor;
    expect(groupDatasetFields(one).related.map((group) => group.path)).toEqual(['Product']);
  });
});
