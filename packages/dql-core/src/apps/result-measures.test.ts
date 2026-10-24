import { describe, expect, it } from 'vitest';
import { detectResultOrdering, nonMeasureColumnRole, resultLeaderRow, selectResultMeasures } from './result-measures.js';

const ranked = [
  { rank: 1, player_name: 'James Harden', points_2016: 2646, points_2017: 2888, total_points_2016_2017: 5534, games_played_2016_2017: 189, player_id_count: 1 },
  { rank: 2, player_name: 'LeBron James', points_2016: 2511, points_2017: 2820, total_points_2016_2017: 5331, games_played_2016_2017: 214, player_id_count: 1 },
  { rank: 3, player_name: 'Russell Westbrook', points_2016: 2610, points_2017: 2642, total_points_2016_2017: 5252, games_played_2016_2017: 198, player_id_count: 1 },
  { rank: 4, player_name: 'Stephen Curry', points_2016: 2863, points_2017: 2388, total_points_2016_2017: 5251, games_played_2016_2017: 201, player_id_count: 1 },
  { rank: 5, player_name: 'Kevin Durant', points_2016: 2850, points_2017: 1985, total_points_2016_2017: 4835, games_played_2016_2017: 188, player_id_count: 1 },
];
const columns = Object.keys(ranked[0]!);

describe('result measures', () => {
  it('reads ranks, positions, ids, codes and calendar parts as dimensions', () => {
    for (const column of ['rank', 'player_rank', 'points_rank', 'rank_in_team', 'position', 'sort_order', 'row_number', 'rn']) {
      expect(nonMeasureColumnRole(column), column).toBe('ordinal');
    }
    for (const column of ['player_id', 'teamId', 'team_key', 'country_code', 'jersey_number', 'sku']) {
      expect(nonMeasureColumnRole(column), column).toBe('identifier');
    }
    for (const column of ['year', 'season', 'game_year', 'fiscal_year', 'month', 'week']) {
      expect(nonMeasureColumnRole(column), column).toBe('calendar');
    }
    for (const column of ['total_points', 'points_2016', 'order_count', 'total_orders', 'rank_points', 'player_id_count', 'days_active', 'tenure_days', 'revenue']) {
      expect(nonMeasureColumnRole(column), column).toBeUndefined();
    }
  });

  it('picks the measure a ranked top-N table is ranked by, and the row ranked first', () => {
    const selection = selectResultMeasures({ columns, rows: ranked });
    expect(selection.rankColumn).toBe('rank');
    expect(selection.labelColumn).toBe('player_name');
    expect(selection.measures).not.toContain('rank');
    expect(selection.primary).toBe('total_points_2016_2017');
    expect(resultLeaderRow({ rows: [...ranked].reverse() }, selection)?.player_name).toBe('James Harden');
  });

  it('finds the ranking measure from the order even without a "total" in its name', () => {
    const rows = ranked.map(({ rank, player_name, games_played_2016_2017, total_points_2016_2017 }) => ({ rank, player_name, games_played_2016_2017, points: total_points_2016_2017 }));
    const selection = selectResultMeasures({ columns: Object.keys(rows[0]!), rows });
    expect(selection.primary).toBe('points');
  });

  it('a rank and a label alone have no measure, and the leader is still the row ranked first', () => {
    const rows = ranked.map(({ rank, player_name }) => ({ rank, player_name }));
    const selection = selectResultMeasures({ columns: ['rank', 'player_name'], rows });
    expect(selection.measures).toEqual([]);
    expect(selection.primary).toBeUndefined();
    expect(resultLeaderRow({ rows }, selection)?.player_name).toBe('James Harden');
  });

  it('a table of ids and years has no measure', () => {
    const rows = [
      { player_id: 201935, season: 2016, game_year: 2017, team_code: 7 },
      { player_id: 2544, season: 2016, game_year: 2017, team_code: 3 },
    ];
    const selection = selectResultMeasures({ columns: Object.keys(rows[0]!), rows });
    expect(selection.measures).toEqual([]);
    expect(selection.primary).toBeUndefined();
    expect(resultLeaderRow({ rows }, selection)).toBeUndefined();
  });

  it('declared measures and column contracts outrank names', () => {
    const declared = selectResultMeasures({ columns, rows: ranked, declaredMeasures: ['games_played_2016_2017'] });
    expect(declared.measures).toEqual(['games_played_2016_2017']);
    expect(declared.primary).toBe('games_played_2016_2017');
    expect(declared.declared).toBe(true);
    const contract = selectResultMeasures({
      columns: ['store', 'store_rank_score', 'store_size'],
      rows: [{ store: 'N', store_rank_score: 4, store_size: 3 }, { store: 'S', store_rank_score: 2, store_size: 9 }],
      columnsMeta: [{ name: 'store_size', kind: 'number', ref: 'dimension:stores.size' }],
    });
    expect(contract.measures).toEqual(['store_rank_score']);
  });

  it('reads numeric strings only when asked to', () => {
    const rows = [{ team: 'A', wins: '60' }, { team: 'B', wins: '45' }];
    expect(selectResultMeasures({ columns: ['team', 'wins'], rows }).measures).toEqual([]);
    const selection = selectResultMeasures({ columns: ['team', 'wins'], rows, numericStrings: true });
    expect(selection.primary).toBe('wins');
    expect(resultLeaderRow({ rows, numericStrings: true }, selection)?.team).toBe('A');
  });
});

/** The certified NBA block: a top 5 with no rank column. */
const TOP5_SQL = `
SELECT
  player_name,
  SUM(COALESCE(pts, 0)) AS total_points,
  COUNT(DISTINCT details_game_id) AS games_played
FROM TRANSFORMED.int_player_stats
WHERE EXTRACT(YEAR FROM game_date_est) BETWEEN \${season_start} AND \${season_end}
  AND player_name IS NOT NULL
GROUP BY player_name
ORDER BY total_points DESC, player_name ASC
LIMIT \${top_n}
`;
const top5 = [
  { player_name: 'James Harden', total_points: 5534, games_played: 189 },
  { player_name: 'LeBron James', total_points: 5331, games_played: 214 },
  { player_name: 'Russell Westbrook', total_points: 5252, games_played: 198 },
  { player_name: 'Stephen Curry', total_points: 5251, games_played: 201 },
  { player_name: 'Kevin Durant', total_points: 4835, games_played: 188 },
];
const TEAMS = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS'];
const pointsByTeam = TEAMS.map((team, index) => ({ team, points: 9000 - index * 37 }));

describe('top-N results without a rank column', () => {
  it('reads ORDER BY … LIMIT n (templated) as a top N ordered on its measure', () => {
    expect(detectResultOrdering({ sql: TOP5_SQL })).toEqual({ kind: 'top_n', reason: 'order_limit', orderColumn: 'total_points', direction: 'desc' });
    expect(detectResultOrdering({ sql: 'select team, sum(pts) as pts from t group by 1 order by 2 desc limit 10' }))
      .toMatchObject({ kind: 'top_n', limit: 10 });
    expect(detectResultOrdering({ sql: 'SELECT TOP 5 name, revenue FROM accounts ORDER BY revenue DESC' }))
      .toMatchObject({ kind: 'top_n', orderColumn: 'revenue', direction: 'desc' });
    expect(detectResultOrdering({ sql: 'SELECT name, revenue FROM accounts ORDER BY revenue ASC FETCH FIRST 3 ROWS ONLY' }))
      .toMatchObject({ kind: 'top_n', orderColumn: 'revenue', direction: 'asc' });
  });

  it('a window ORDER BY or a subquery LIMIT is not the outer ranking', () => {
    expect(detectResultOrdering({ sql: 'SELECT team, SUM(points) AS points, ROW_NUMBER() OVER (ORDER BY SUM(points) DESC) AS r FROM games GROUP BY team' }))
      .toEqual({ kind: 'complete', reason: 'sql' });
    expect(detectResultOrdering({ sql: 'SELECT team, points FROM (SELECT * FROM games ORDER BY points DESC LIMIT 5) g' }))
      .toEqual({ kind: 'complete', reason: 'sql' });
    expect(detectResultOrdering({ sql: 'SELECT team, points FROM games LIMIT 100' })).toEqual({ kind: 'limited', reason: 'limit' });
  });

  it('reads a top_n parameter, a ranking pattern and a "Top N" title', () => {
    expect(detectResultOrdering({ parameters: ['season_start', 'top_n'] })).toMatchObject({ kind: 'top_n', reason: 'top_n_parameter' });
    expect(detectResultOrdering({ pattern: 'ranking' })).toMatchObject({ kind: 'top_n', reason: 'pattern' });
    expect(detectResultOrdering({ title: 'Top 5 scorers' })).toMatchObject({ kind: 'top_n', reason: 'title', limit: 5 });
    expect(detectResultOrdering({ title: 'top_5_players_points_2016_2017' })).toMatchObject({ kind: 'top_n', limit: 5 });
    expect(detectResultOrdering({ title: 'Top Players By Total Points 2016 2017' })).toMatchObject({ kind: 'top_n', reason: 'title' });
    expect(detectResultOrdering({ title: 'Bottom ten teams' })).toMatchObject({ kind: 'top_n', direction: 'asc', limit: 10 });
    expect(detectResultOrdering({ title: 'Points by team' })).toBeUndefined();
    expect(detectResultOrdering({ title: 'Top-line revenue' })).toBeUndefined();
  });

  it('a top 5 with no rank column is ranked: led by its first row, never summed', () => {
    const selection = selectResultMeasures({ columns: ['player_name', 'total_points', 'games_played'], rows: top5, source: { sql: TOP5_SQL } });
    expect(selection.rankColumn).toBeUndefined();
    expect(selection.ranked).toBe(true);
    expect(selection.limited).toBe(true);
    expect(selection.primary).toBe('total_points');
    expect(resultLeaderRow({ rows: top5 }, selection)?.player_name).toBe('James Harden');
  });

  it('the ORDER BY column is the measure the list is about', () => {
    const selection = selectResultMeasures({
      columns: ['player_name', 'total_points', 'games_played'],
      rows: [...top5].sort((a, b) => b.games_played - a.games_played),
      source: { sql: TOP5_SQL.replace('ORDER BY total_points DESC', 'ORDER BY games_played DESC') },
    });
    expect(selection.primary).toBe('games_played');
    expect(resultLeaderRow({ rows: top5 }, selection)?.player_name).toBe('LeBron James');
  });

  it('a bottom N is led by its smallest value; a list ordered by name is a slice, not a ranking', () => {
    const rows = [...top5].reverse();
    const bottom = selectResultMeasures({
      columns: ['player_name', 'total_points'],
      rows,
      source: { sql: 'SELECT player_name, total_points FROM s ORDER BY total_points ASC LIMIT 5' },
    });
    expect(bottom.ranked).toBe(true);
    expect(resultLeaderRow({ rows }, bottom)?.player_name).toBe('Kevin Durant');
    const byName = selectResultMeasures({
      columns: ['player_name', 'total_points'],
      rows: top5,
      source: { sql: 'SELECT player_name, total_points FROM s ORDER BY player_name LIMIT 5' },
    });
    expect(byName.ranked).toBe(false);
    expect(byName.limited).toBe(true);
  });

  it('with no source, five distinct rows sorted by the measure read as a top 5', () => {
    const selection = selectResultMeasures({ columns: ['player_name', 'total_points', 'games_played'], rows: top5 });
    expect(selection.ranked).toBe(true);
    expect(selection.ordering?.reason).toBe('rows_sorted');
  });

  it('a full additive breakdown (points by team, all 30 teams) is not a top N', () => {
    const unsourced = selectResultMeasures({ columns: ['team', 'points'], rows: pointsByTeam });
    expect(unsourced.ranked).toBe(false);
    expect(unsourced.limited).toBe(false);
    const sourced = selectResultMeasures({
      columns: ['team', 'points'],
      rows: pointsByTeam.slice(0, 5),
      source: { sql: 'SELECT team, SUM(pts) AS points FROM games GROUP BY team ORDER BY points DESC', title: 'Points by team' },
    });
    // The SQL says it is the whole population, so five sorted rows are not second-guessed.
    expect(sourced.ordering).toEqual({ kind: 'complete', reason: 'sql', orderColumn: 'points', direction: 'desc' });
    expect(sourced.ranked).toBe(false);
    expect(sourced.limited).toBe(false);
  });

  it('a whole table sorted by one measure is summarised on that measure, not the first numeric column (sample "Customer lifetime profiles")', () => {
    const rows = [
      { customer_name: 'Amy Spend', count_lifetime_orders: 40, lifetime_spend: 900 },
      { customer_name: 'Bo Middle', count_lifetime_orders: 12, lifetime_spend: 500 },
      { customer_name: 'Melissa Lopez', count_lifetime_orders: 231, lifetime_spend: 300 },
    ];
    const selection = selectResultMeasures({
      columns: ['customer_name', 'count_lifetime_orders', 'lifetime_spend'],
      rows,
      source: { sql: 'SELECT customer_name, count_lifetime_orders, lifetime_spend FROM dev.customers ORDER BY lifetime_spend DESC, customer_name' },
    });
    expect(selection.ordering).toMatchObject({ kind: 'complete', orderColumn: 'lifetime_spend', direction: 'desc' });
    expect(selection.primary).toBe('lifetime_spend');
    expect(resultLeaderRow({ rows }, selection)?.customer_name).toBe('Amy Spend');
  });
});
