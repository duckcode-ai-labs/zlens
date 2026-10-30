import { describe, expect, it } from 'vitest';
import { importFailureKind, plainImportFailure } from './import-runtime.js';

describe('the reason a draft did not run or certify', () => {
  it('says the kind of fix first and drops the SQL the database echoes back', () => {
    const cases: Array<[string, string]> = [
      ['Provide required parameters: start_date, end_date.', 'Needs a default value: start_date, end_date.'],
      ['DuckDB query failed: Catalog Error: Table with name big_customers does not exist! Did you mean "customers"?', 'Reads a table this connection does not have: big_customers.'],
      ['One or more declared tests did not pass. DuckDB query failed: Parser Error: syntax error at or near "10" LINE 2: SELECT TOP 10 [o].[order_id]', 'Does not parse on this connection: syntax error at or near "10".'],
      ['DuckDB query failed: Binder Error: Ambiguous reference to column name "product_price" (use: "oi.product_price" or "p.product_price") LINE 1: select', 'Column problem: Ambiguous reference to column name "product_price" (use: "oi.product_price" or "p.product_price").'],
      ['Saved query preview only supports read-only SELECT or WITH queries.', 'Not one read-only SELECT or WITH query.'],
      ['Owner is required before certification.', 'Owner is required before certification.'],
    ];
    for (const [message, reason] of cases) expect(plainImportFailure(message), message).toBe(reason);
  });

  it('counts reasons by the kind of fix', () => {
    expect(importFailureKind('Needs a default value: start_date.')).toBe('Needs a default value');
    expect(importFailureKind('Owner is required before certification.')).toBe('Owner is required before certification.');
  });
});
