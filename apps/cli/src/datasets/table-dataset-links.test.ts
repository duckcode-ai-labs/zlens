import { describe, expect, it } from 'vitest';
import { tableDatasetLinks } from './table-dataset.js';

/** New-user round 3, problem 7: a table already made into a Dataset says so. */
describe('Datasets made from a table', () => {
  const block = (relation: string) => [
    'block "Orders" {',
    '  tags = ["app-datasets", "from-table"]',
    '  query = """',
    '/* Hidden duplicate columns: order_total (order_total_cents is used) */',
    `SELECT "order_id", "order_total_cents" / 100.0 AS "order_total"`,
    `FROM ${relation}`,
    '"""',
    '}',
  ].join('\n');

  it('links a from-table block to its table by the relation it reads, with its trust', () => {
    const files: Record<string, string> = {
      'blocks/orders.dql': block('"dev"."orders"'),
      'blocks/customers.dql': block('dev.customers'),
      'blocks/hand.dql': block('dev.orders'),
    };
    const links = tableDatasetLinks({
      tables: [{ id: 't-orders', relation: '"dev"."orders"' }, { id: 't-customers', relation: '"dev"."customers"' }, { id: 't-items', relation: '"dev"."order_items"' }],
      sources: [
        { sourceId: 's-orders', name: 'Orders', tags: ['app-datasets', 'from-table'], trust: 'review_required', lifecycle: 'review', check: { by: 'me' }, sourcePath: 'blocks/orders.dql' },
        { sourceId: 's-customers', name: 'Customers', tags: ['from-table'], trust: 'certified', lifecycle: 'certified', sourcePath: 'blocks/customers.dql' },
        // A hand-written saved query over the same table is not a table Dataset.
        { sourceId: 's-hand', name: 'Hand', tags: [], trust: 'certified', lifecycle: 'certified', sourcePath: 'blocks/hand.dql' },
      ],
      readSource: (path) => files[path],
    });
    expect(links.get('t-orders')).toEqual([{ sourceId: 's-orders', name: 'Orders', state: 'checked' }]);
    expect(links.get('t-customers')).toEqual([{ sourceId: 's-customers', name: 'Customers', state: 'certified' }]);
    expect(links.has('t-items')).toBe(false);
  });
});
