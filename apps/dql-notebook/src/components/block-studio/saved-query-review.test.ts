import { describe, expect, it } from 'vitest';
import { howItsWorkedOut, howSemanticIsWorkedOut, savedQueryChecks } from './saved-query-review';

/** The trust flow approved 2026-11-27: a saved query's page says how it is worked out, and lists its checks. */
describe('how a saved query is worked out, in one line', () => {
  it('names the tables it reads, the rows it keeps and what one row of the result is', () => {
    expect(howItsWorkedOut(`SELECT T.TEAM_ID, D.TEAM_NICKNAME, SUM(CASE WHEN T.TEAM_WON THEN 1 ELSE 0 END) AS PLAYOFF_WINS
      FROM ZLENS_DEV.TRANSFORMED.LOCAL_TEAM_GAME_FACTS T
      JOIN ZLENS_DEV.TRANSFORMED.DIM_TEAMS_CLEANSED D ON T.TEAM_ID = D.TEAM_ID
      WHERE T.SEASON = 2015 AND CAST(T.GAME_ID AS VARCHAR) LIKE '4%'
      GROUP BY T.TEAM_ID, D.TEAM_NICKNAME
      ORDER BY PLAYOFF_WINS DESC`))
      .toBe("Reads LOCAL_TEAM_GAME_FACTS and DIM_TEAMS_CLEANSED, keeps the rows where T.SEASON = 2015 AND CAST(T.GAME_ID AS VARCHAR) LIKE '4%', and gives one row per TEAM_ID and TEAM_NICKNAME.");
  });

  it('says a total is one row, a plain list is a list, and a LIMIT is the first rows', () => {
    expect(howItsWorkedOut('select count(*) as games from games where season = 2016;')).toBe('Reads games, keeps the rows where season = 2016, and adds them up into one row.');
    expect(howItsWorkedOut('SELECT name FROM players ORDER BY points DESC LIMIT 5')).toBe('Reads players, and lists those rows (the first 5).');
    expect(howItsWorkedOut('SELECT season, COUNT(*) FROM games GROUP BY 1')).toBe('Reads games, and gives one row for each value of its first column.');
  });

  it('keeps a WHERE inside brackets with its own query, and cuts a long filter', () => {
    expect(howItsWorkedOut('SELECT * FROM a WHERE a.id IN (SELECT id FROM b WHERE x = 1 GROUP BY id) ORDER BY 1'))
      .toBe('Reads a and b, keeps the rows where a.id IN (SELECT id FROM b WHERE x = 1 GROUP BY id), and lists those rows.');
    expect(howItsWorkedOut(`SELECT * FROM t WHERE ${Array.from({ length: 30 }, (_, index) => `c${index} = ${index}`).join(' AND ')}`)!.length).toBeLessThan(230);
  });

  it('says a query built in steps reads its tables in those steps', () => {
    expect(howItsWorkedOut('WITH totals AS (SELECT team_id, SUM(points) AS pts FROM games GROUP BY team_id), ranked AS (SELECT * FROM totals) SELECT * FROM ranked LIMIT 3'))
      .toBe("Reads games, in 2 steps (totals, ranked), then gives the last step's rows.");
  });

  it('has nothing to say without SQL, and says a metrics query in the same words', () => {
    expect(howItsWorkedOut('  -- nothing\n ')).toBeNull();
    expect(howSemanticIsWorkedOut({ metrics: ['revenue', 'orders'], dimensions: ['store'], timeDimension: 'month' }))
      .toBe('Works out revenue and orders from the certified metrics, one row per store and month.');
  });
});

describe('a saved query\'s checks, as a list', () => {
  it('says what passed and what is left before certifying', () => {
    expect(savedQueryChecks({ ran: false, problems: 0, owner: 'TEST_ADMIN', parameters: [{ name: 'season', default: 2015, required: true }], tests: ['assert row_count > 0'] })).toEqual([
      { label: 'Runs without errors', state: 'not_yet', detail: 'press Run' },
      { label: 'No problems in the query', state: 'passed' },
      { label: 'Has an owner: TEST_ADMIN', state: 'passed' },
      { label: 'Its parameter has a default', state: 'passed' },
      { label: 'Test: row_count > 0', state: 'not_yet', detail: 'checked when you certify' },
    ]);
    expect(savedQueryChecks({ ran: true, runFailed: true, problems: 2, owner: '', parameters: [{ name: 'season', required: true }, { name: 'team', default: 'GSW', required: true }], tests: [] })).toEqual([
      { label: 'Runs without errors', state: 'failed', detail: 'the last run failed' },
      { label: 'No problems in the query', state: 'failed', detail: '2 to fix' },
      { label: 'Has an owner', state: 'failed', detail: 'add one in the builder' },
      { label: 'Each parameter has a default', state: 'failed', detail: 'no default for season' },
    ]);
  });

  it('shows what the receipt says was checked once it is certified', () => {
    expect(savedQueryChecks({ ran: false, problems: 0, parameters: [], tests: [], certifiedChecks: ['Runs', 'Has an owner'] }))
      .toEqual([{ label: 'Runs', state: 'passed' }, { label: 'Has an owner', state: 'passed' }]);
  });
});
