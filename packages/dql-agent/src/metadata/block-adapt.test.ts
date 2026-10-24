import { describe, expect, it } from 'vitest';
import { adaptCertifiedSqlWithFilter, planCertifiedAdaptation } from './block-adapt.js';
import type { CertifiedBlockFit } from './block-fit.js';

function contextOnlyFit(partial: Partial<CertifiedBlockFit>): CertifiedBlockFit {
  return {
    kind: 'context_only',
    confidence: 'high',
    reasons: [],
    missingOutputs: [],
    missingDimensions: [],
    unsupportedFilters: [],
    inferredContract: false,
    ...partial,
  };
}

describe('adaptCertifiedSqlWithFilter (W2.2)', () => {
  const certifiedSql = 'SELECT product_type, SUM(product_price) AS revenue FROM order_items GROUP BY product_type';

  it('wraps the certified result and filters on a block output column', () => {
    const adaptation = adaptCertifiedSqlWithFilter({
      certifiedSql,
      filterColumn: 'product_type',
      filterValue: 'food',
      outputColumns: ['product_type', 'revenue'],
      blockName: 'revenue_by_product_type',
    });
    expect(adaptation).not.toBeNull();
    expect(adaptation!.sql).toContain('FROM (');
    expect(adaptation!.sql).toContain('AS certified_derived');
    expect(adaptation!.sql).toContain("WHERE product_type = 'food'");
    expect(adaptation!.trustQualifier).toBe('adapted from certified saved query revenue_by_product_type');
  });

  it('quotes string values and leaves numeric values unquoted', () => {
    const stringAdaptation = adaptCertifiedSqlWithFilter({
      certifiedSql, filterColumn: 'product_type', filterValue: "O'Brien's",
      outputColumns: ['product_type', 'revenue'], blockName: 'b',
    });
    expect(stringAdaptation!.sql).toContain("WHERE product_type = 'O''Brien''s'");
    const numericAdaptation = adaptCertifiedSqlWithFilter({
      certifiedSql: 'SELECT year, revenue FROM annual', filterColumn: 'year', filterValue: '2024',
      outputColumns: ['year', 'revenue'], blockName: 'b',
    });
    expect(numericAdaptation!.sql).toContain('WHERE year = 2024');
  });

  it('returns null when the filter column is NOT a block output (would need re-aggregation)', () => {
    // The block outputs product_type + revenue only; filtering on customer_id would
    // require reaching input rows and re-aggregating — not a safe output wrapper.
    const adaptation = adaptCertifiedSqlWithFilter({
      certifiedSql, filterColumn: 'customer_id', filterValue: 'C1',
      outputColumns: ['product_type', 'revenue'], blockName: 'b',
    });
    expect(adaptation).toBeNull();
  });

  it('returns null on blank inputs or unparseable SQL', () => {
    expect(adaptCertifiedSqlWithFilter({ certifiedSql, filterColumn: 'product_type', filterValue: '', outputColumns: ['product_type'], blockName: 'b' })).toBeNull();
    expect(adaptCertifiedSqlWithFilter({ certifiedSql: 'NOT SQL {{{', filterColumn: 'product_type', filterValue: 'food', outputColumns: ['product_type'], blockName: 'b' })).toBeNull();
  });
});

describe('planCertifiedAdaptation (W2.2)', () => {
  const certifiedSql = 'SELECT product_type, SUM(product_price) AS revenue FROM order_items GROUP BY product_type';
  const base = {
    certifiedSql,
    blockName: 'revenue_by_product_type',
    blockOutputs: ['product_type', 'revenue'],
    resolveFilterColumn: (value: string) => (value === 'food' ? ['product_type'] : []),
  };

  it('adapts a single-filter context-only fit whose value maps to a block output', () => {
    const adaptation = planCertifiedAdaptation({ ...base, blockFit: contextOnlyFit({ unsupportedFilters: ['food'] }) });
    expect(adaptation).not.toBeNull();
    expect(adaptation!.sql).toContain("WHERE product_type = 'food'");
  });

  it('falls through (null) when there is more than one delta', () => {
    expect(planCertifiedAdaptation({ ...base, blockFit: contextOnlyFit({ unsupportedFilters: ['food'], missingDimensions: ['region'] }) })).toBeNull();
    expect(planCertifiedAdaptation({ ...base, blockFit: contextOnlyFit({ unsupportedFilters: ['food', 'drink'] }) })).toBeNull();
    expect(planCertifiedAdaptation({ ...base, blockFit: contextOnlyFit({ unsupportedFilters: ['food'], grainMismatch: 'grain differs' }) })).toBeNull();
  });

  it('falls through when the filter value does not resolve to a block-output column', () => {
    expect(planCertifiedAdaptation({
      ...base,
      resolveFilterColumn: () => ['customer_id'], // resolves, but not a block output
      blockFit: contextOnlyFit({ unsupportedFilters: ['C1'] }),
    })).toBeNull();
  });

  it('falls through for an exact/trim_safe fit (not a context-only near-miss)', () => {
    expect(planCertifiedAdaptation({ ...base, blockFit: contextOnlyFit({ kind: 'exact', unsupportedFilters: ['food'] }) })).toBeNull();
  });
});
