import { describe, expect, it } from 'vitest';
import { sameTable, tableKey, tableName } from './physical-binding.js';

// One table, spelled the ways a project meets it: dbt's dev target, the
// warehouse the project connects to, and dbt-duckdb's quoted provenance.
const DBT_DEV = 'DEV.S.T';
const WAREHOUSE = 'prod.s.t';
const QUOTED = '"PROD"."S"."T"';

describe('one answer to "is this the same table?" (simplification plan Z1)', () => {
  it('exact: as written, unquoted parts folded to upper case and quote state kept', () => {
    expect(sameTable('PROD.S.T', WAREHOUSE)).toBe(true);
    expect(sameTable(QUOTED, '"PROD"."S"."T"')).toBe(true);
    // A quoted part never merges with an unquoted one here: `object` does that.
    expect(sameTable(QUOTED, 'PROD.S.T')).toBe(false);
    expect(sameTable('"prod"."s"."t"', WAREHOUSE)).toBe(false);
    expect(sameTable(DBT_DEV, WAREHOUSE)).toBe(false);
    expect(tableKey(WAREHOUSE)).toBe('u:PROD.u:S.u:T');
  });

  it('object: every part, ignoring quotes and case', () => {
    expect(sameTable(QUOTED, WAREHOUSE, 'object')).toBe(true);
    expect(sameTable('"prod"."s"."t"', WAREHOUSE, 'object')).toBe(true);
    expect(sameTable(DBT_DEV, WAREHOUSE, 'object')).toBe(false);
    expect(tableKey(QUOTED, 'object')).toBe('prod.s.t');
  });

  it('tail: the same schema and table in any database, for every spelling', () => {
    for (const [left, right] of [[DBT_DEV, WAREHOUSE], [DBT_DEV, QUOTED], [WAREHOUSE, QUOTED]] as const) {
      expect(sameTable(left, right, 'tail')).toBe(true);
      expect(tableKey(left, 'tail')).toBe(tableKey(right, 'tail'));
    }
    expect(tableKey(DBT_DEV, 'tail')).toBe('s.t');
    expect(sameTable('prod.other.t', WAREHOUSE, 'tail')).toBe(false);
    expect(sameTable('s.t', 'x.t', 'tail')).toBe(false);
  });

  it('tail: a bare table name matches on the table alone', () => {
    expect(sameTable('t', WAREHOUSE, 'tail')).toBe(true);
    expect(sameTable('T', QUOTED, 'tail')).toBe(true);
    expect(sameTable('u', WAREHOUSE, 'tail')).toBe(false);
  });

  it('names the table itself, unquoted, for showing and word matching', () => {
    expect(tableName(QUOTED)).toBe('T');
    expect(tableName('"my.db"."S"."player.games"')).toBe('player.games');
    expect(tableName('orders')).toBe('orders');
    expect(tableName('')).toBe('');
  });

  it('reads SQL Server brackets as quotes', () => {
    expect(tableKey('[Sales].[dbo].[Order Lines]', 'object')).toBe('sales.dbo.order lines');
    expect(sameTable('[dbo].[orders]', 'dbo.orders', 'tail')).toBe(true);
    expect(tableName('[dbo].[a]]b]')).toBe('a]b');
  });

  it('keeps a dot inside a quoted part, and never matches an empty name', () => {
    expect(tableKey('"my.db"."S"."T"', 'tail')).toBe('s.t');
    expect(tableKey('"my.db"."S"."T"', 'object')).toBe('my.db.s.t');
    expect(sameTable('', WAREHOUSE, 'tail')).toBe(false);
    expect(sameTable(undefined, WAREHOUSE)).toBe(false);
    expect(sameTable('', '', 'object')).toBe(false);
  });
});
