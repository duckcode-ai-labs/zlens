import { describe, expect, it } from 'vitest';
import { missingFieldReason, plainSourceText, readableFieldLabel } from './source-names';

describe('missing-field reasons', () => {
  it('names a related-table field once, never "Location Location Name"', () => {
    expect(missingFieldReason('monthly_revenue', 'location__location_name')).toBe('Monthly Revenue has no Location Name field.');
    expect(missingFieldReason('Monthly Revenue', 'location_location_name')).toBe('Monthly Revenue has no Location Name field.');
    expect(plainSourceText('location__location_name is not exposed by monthly_revenue.')).toBe('Monthly Revenue has no Location Name field.');
  });

  it('keeps the table name when the column does not repeat it', () => {
    expect(missingFieldReason('Monthly Revenue', 'customer__name')).toBe('Monthly Revenue has no Customer Name field.');
    expect(missingFieldReason('Monthly Revenue', 'customer_name')).toBe('Monthly Revenue has no Customer Name field.');
  });

  it('reads field ids as words', () => {
    expect(readableFieldLabel('order_item__order_item_id')).toBe('Order Item Id');
    expect(readableFieldLabel('ordered-at')).toBe('Ordered At');
    expect(readableFieldLabel('Location Name')).toBe('Location Name');
  });
});
