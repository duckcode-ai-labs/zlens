import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import type { AppBlockRecommendation } from '../../../api/client';
import { DataPanel } from './DataPanel';
import { datasetJoinPath, groupDatasetFields, toggleFieldInQuery, EMPTY_TILE_QUERY } from './field-query';
import { humanize } from './studio-ui';
import { readerTileReceipt } from '../reader-trust';
import { readerReceiptRows } from '../NumberReceipt';

const field = (name: string, extra: Record<string, unknown> = {}) => ({ kind: 'physical', name, qualifiedId: name, type: 'string', role: 'dimension', status: 'approved', ...extra });
const join = (id: string, label: string, trust: 'certified' | 'review_required', parent?: string) => ({
  id, label, table: `${label.toLowerCase()}s`, relation: `"main"."${label.toLowerCase()}s"`, keys: [{ from: `${label.toLowerCase()}_id`, to: `${label.toLowerCase()}_id` }],
  cardinality: 'many_to_one', trust, origin: trust === 'certified' ? 'model' : 'drafted', relationshipId: id, uniqueness: 'current',
  sentence: `each ${parent ? 'customer' : 'order'} has one ${label.toLowerCase()}`, ...(parent ? { parent } : {}),
});

const orders = {
  id: 'dataset.orders', kind: 'block', label: 'Orders', operations: ['group', 'trend'],
  grain: { entityIds: ['order'], keyFields: ['order_id'] },
  fields: [
    { kind: 'measure', name: 'order_total', qualifiedId: 'order_total', aggregation: 'sum', dependsOn: ['order_total'], status: 'approved' },
    field('order_id', { role: 'key' }),
    field('location_id'),
    field('customer__customer_name', { related: { join: 'customer', column: 'customer_name' } }),
    field('customer__signed_up_at', { type: 'timestamp', role: 'time', time: { grains: ['day', 'week', 'month'] }, related: { join: 'customer', column: 'signed_up_at' } }),
    field('location__location_name', { related: { join: 'location', column: 'location_name' } }),
    field('customer__region__region_name', { related: { join: 'customer__region', column: 'region_name' } }),
  ],
  joins: [join('customer', 'Customer', 'certified'), join('location', 'Location', 'review_required'), join('customer__region', 'Region', 'certified', 'customer')],
  joinNotes: ['Order items per order: add it from Order items. One order has many order items, so following that join here would count each order more than once.'],
} as unknown as DatasetDescriptor;

describe('fields from related tables in the Data pane (D2)', () => {
  it('groups related fields under their join path and keeps them out of the Dataset\'s own dimensions', () => {
    const groups = groupDatasetFields(orders);
    expect(groups.dimensions.map((item) => item.name)).toEqual(['order_id', 'location_id']);
    expect(groups.related.map((group) => [group.path, group.review, group.fields.map((item) => item.name)])).toEqual([
      ['Customer', false, ['customer__customer_name', 'customer__signed_up_at']],
      ['Location', true, ['location__location_name']],
      ['Customer → Region', false, ['customer__region__region_name']],
    ]);
    expect(datasetJoinPath(orders, 'customer__region')).toEqual({ path: 'Customer → Region', review: false });
    // Search finds a related field by its words or its table.
    expect(groupDatasetFields(orders, 'location name').related.map((group) => group.path)).toEqual(['Location']);
    expect(groupDatasetFields(orders, 'region').related.flatMap((group) => group.fields.map((item) => item.name))).toEqual(['customer__region__region_name']);
  });

  it('names related fields in words, and a click groups by them like any field', () => {
    expect(humanize('location__location_name')).toBe('Location Name');
    expect(humanize('customer__city')).toBe('Customer City');
    expect(humanize('order_total')).toBe('Order Total');
    const query = toggleFieldInQuery(toggleFieldInQuery(EMPTY_TILE_QUERY, orders.fields[0]!), orders.fields.find((item) => item.name === 'location__location_name')!);
    expect(query.dimensions).toEqual([{ field: 'location__location_name' }]);
  });

  it('shows "Orders → Customer" groups, Needs review on a drafted join, and why one-to-many is not there', () => {
    const active = { id: 'orders', name: 'Orders', domain: 'shop', status: 'certified', lifecycle: 'certified', trust: 'certified', tags: [], path: 'p', fingerprint: 'f', lastModified: '', description: '', score: 0, reasons: [], owner: null, kind: 'block', capabilities: { measures: [], dimensions: [], outputs: [], filters: [], parameters: [], dataset: orders } } as unknown as AppBlockRecommendation;
    const markup = renderToStaticMarkup(<DataPanel appData={[active]} active={active} target={{ kind: 'none' }} disabled={false} onChoose={vi.fn()} onPickField={vi.fn()} onAddData={vi.fn()} onAddSavedQuery={vi.fn()} onAddContent={vi.fn()} />);
    expect(markup).toContain('Orders → Customer');
    expect(markup).toContain('Orders → Customer → Region');
    expect(markup).toContain('Location Name');
    expect(markup).toMatch(/Orders → Location<span class="badge">Needs review<\/span>/);
    expect(markup).toContain('Order items per order: add it from Order items.');
    // A related field of a drafted join is usable (not locked); its tile is marked Needs review.
    expect(markup).not.toMatch(/disabled=""[^>]*>[^<]*<span class="glyph"><span class="aa">Aa<\/span><\/span><span class="name">Location Name/);
  });

  it('puts the joins a tile used on its receipt, in plain words', () => {
    const sentence = 'Joined to customers on customer_id (each order has one customer — checked)';
    const rows = readerTileReceipt({ i: 't', query: { dimensions: [], measures: [] } } as never, { tileId: 't', status: 'ok', dataset: { trust: 'certified', joins: [{ id: 'customer', table: 'customers', trust: 'certified', sentence }] } } as never, null, undefined);
    expect(rows.find((row) => row.label === 'Joined')).toMatchObject({ value: sentence, list: [sentence] });
    expect(readerReceiptRows(rows).map((row) => row.label)).toContain('Joined');
  });
});
