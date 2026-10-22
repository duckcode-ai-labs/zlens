import { describe, expect, it } from 'vitest';
import { DQL_CELL_EXAMPLE, dqlCellHoldsPlainSql, queryCellKindLabel } from './dql-cell-content';

describe('dqlCellHoldsPlainSql', () => {
  it('recognizes plain SQL in a DQL cell', () => {
    expect(dqlCellHoldsPlainSql('SELECT player_name, total_points FROM TRANSFORMED.local_player_season_facts WHERE season = 2017 ORDER BY total_points DESC LIMIT 5')).toBe(true);
    expect(dqlCellHoldsPlainSql('-- top scorers\nwith t as (select 1) select * from t')).toBe(true);
  });

  it('never flags DQL', () => {
    expect(dqlCellHoldsPlainSql(DQL_CELL_EXAMPLE)).toBe(false);
    expect(dqlCellHoldsPlainSql('@block("Top Scorers")')).toBe(false);
    expect(dqlCellHoldsPlainSql('@deprecated\nblock "x" { query = """SELECT 1""" }')).toBe(false);
    expect(dqlCellHoldsPlainSql('term "Customer" { domain = "sales" }')).toBe(false);
    expect(dqlCellHoldsPlainSql('')).toBe(false);
  });
});

describe('queryCellKindLabel', () => {
  it('labels a DQL cell as DQL and a SQL cell as SQL', () => {
    expect(queryCellKindLabel({ type: 'dql', content: '' })).toBe('DQL query');
    expect(queryCellKindLabel({ type: 'sql', content: 'select 1' })).toBe('Warehouse SQL');
    expect(queryCellKindLabel({ type: 'sql', content: 'select 1', executionTarget: { target: 'local' } })).toBe('Local dataset SQL');
    expect(queryCellKindLabel({ type: 'dql', content: 'block "x" { query = """SELECT @metric(revenue)""" }' })).toBe('Semantic query');
  });
});
