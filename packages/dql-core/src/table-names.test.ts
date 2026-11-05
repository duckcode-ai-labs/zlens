import { describe, expect, it } from 'vitest';
import { bareRelation } from './datasets/related-fields.js';
import { parsePhysicalIdentifier, sameTable, tableKey, tableName, tableTail } from './table-names.js';

describe('one answer to "is this the same table?" (simplification plan Z1)', () => {
  it('compares at shared on the parts both names have, so a database never stands in for another', () => {
    expect(sameTable('s.t', 'prod.s.t', 'shared')).toBe(true);
    expect(sameTable('"PROD"."S"."T"', 'prod.s.t', 'shared')).toBe(true);
    expect(sameTable('t', 'prod.s.t', 'shared')).toBe(true);
    expect(sameTable('dev.s.t', 'prod.s.t', 'shared')).toBe(false);
    expect(sameTable('other.t', 'prod.s.t', 'shared')).toBe(false);
  });

  it('keeps tail database-blind and object whole', () => {
    expect(sameTable('dev.s.t', 'prod.s.t', 'tail')).toBe(true);
    expect(sameTable('dev.s.t', 'prod.s.t', 'object')).toBe(false);
    expect(sameTable('s.t', 'prod.s.t', 'object')).toBe(false);
    expect(tableKey('"PROD"."S"."T"', 'shared')).toBe('prod.s.t');
  });

  it('writes the schema and table as written, and the table alone', () => {
    expect(tableTail('"nba"."dev"."T"')).toBe('dev.T');
    expect(tableTail('t')).toBe('t');
    expect(tableName('[db].[s].[T]')).toBe('T');
    expect(parsePhysicalIdentifier('"a.b".c').map((part) => part.value)).toEqual(['a.b', 'c']);
  });

  it('answers the deprecated bareRelation from the same place', () => {
    expect(bareRelation('"Main" . "Orders"')).toBe(tableKey('main.orders', 'object'));
    expect(bareRelation('[dbo].[Orders]')).toBe('dbo.orders');
  });
});
