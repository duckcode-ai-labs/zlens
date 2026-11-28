import { describe, expect, it } from 'vitest';
import { howItsWorkedOut, howSemanticIsWorkedOut, plainFilter, savedQueryChecks } from './saved-query-review';

/** The trust flow approved 2026-11-27: a saved query's page says how it is worked out, and lists its checks. */
describe('how a saved query is worked out, in one line', () => {
  it('names the tables it reads, the rows it keeps and what one row of the result is', () => {
    expect(howItsWorkedOut(`SELECT T.TEAM_ID, D.TEAM_NICKNAME, SUM(CASE WHEN T.TEAM_WON THEN 1 ELSE 0 END) AS PLAYOFF_WINS
      FROM ZLENS_DEV.TRANSFORMED.LOCAL_TEAM_GAME_FACTS T
      JOIN ZLENS_DEV.TRANSFORMED.DIM_TEAMS_CLEANSED D ON T.TEAM_ID = D.TEAM_ID
      WHERE T.SEASON = 2015 AND CAST(T.GAME_ID AS VARCHAR) LIKE '4%'
      GROUP BY T.TEAM_ID, D.TEAM_NICKNAME
      ORDER BY PLAYOFF_WINS DESC`))
      .toBe('Reads LOCAL_TEAM_GAME_FACTS and DIM_TEAMS_CLEANSED, keeps the rows where SEASON is 2015 and GAME_ID starts with “4”, and gives one row per TEAM_ID and TEAM_NICKNAME.');
  });

  it('says a total is one row, a plain list is a list, and a LIMIT is the first rows', () => {
    expect(howItsWorkedOut('select count(*) as games from games where season = 2016;')).toBe('Reads games, keeps the rows where season is 2016, and adds them up into one row.');
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

describe('a filter in plain words (V18 patch 2 new-user test, P2-4)', () => {
  it('says the playoff filter the tester was asked to review in words a business user can check', () => {
    expect(plainFilter("g.SEASON = 2015 AND CAST(g.GAME_ID AS VARCHAR) LIKE '4%' AND g.TEAM_WON = TRUE AND t.CITY ILIKE '%Golden State%'"))
      .toBe('SEASON is 2015, GAME_ID starts with “4”, TEAM_WON is true and CITY contains “Golden State”');
  });

  it('says lists, ranges, dates, empty values and either-or', () => {
    expect(plainFilter("c.c_mktsegment IN ('BUILDING', 'MACHINERY') AND o.o_orderdate >= DATE '1996-01-01' AND o.o_orderdate < '1997-01-01'"))
      .toBe('c_mktsegment is “BUILDING” or “MACHINERY”, o_orderdate is on or after 1996-01-01 and o_orderdate is before 1997-01-01');
    expect(plainFilter('YEAR(o_orderdate) = 1996 AND o_totalprice BETWEEN 100 AND 500')).toBe('the year of o_orderdate is 1996 and o_totalprice is between 100 and 500');
    expect(plainFilter('EXTRACT(year FROM o.o_orderdate) <> 1995 AND l.l_returnflag IS NOT NULL')).toBe('the year of o_orderdate is not 1995 and l_returnflag is not empty');
    expect(plainFilter("(t.CITY = 'Boston' OR t.CITY = 'Miami') AND NOT g.IS_HOME")).toBe('(CITY is “Boston” or CITY is “Miami”) and IS_HOME is false');
    expect(plainFilter("name NOT LIKE '%test%' AND o.cust_id = c.id")).toBe('name does not contain “test” and cust_id matches id');
    expect(plainFilter('g.SEASON = ${season} AND g.TEAM_ID = ${team_id}')).toBe('SEASON is the season you choose and TEAM_ID is the team id you choose');
  });

  it('keeps the SQL of a condition it cannot say safely, and says nothing new when none can be said', () => {
    expect(plainFilter("season = 2016 AND DATEADD(day, -30, CURRENT_DATE) < played_on")).toBe('season is 2016 and DATEADD(day, -30, CURRENT_DATE) < played_on');
    expect(plainFilter("code LIKE 'A_1%'")).toBeNull();
    expect(plainFilter('a.id IN (SELECT id FROM b)')).toBeNull();
    expect(plainFilter("note = 'it''s and done' AND kind = 'x'")).toBe('note is “it\'s and done” and kind is “x”');
  });

  it('stops a long filter after the first few conditions', () => {
    const many = plainFilter(Array.from({ length: 30 }, (_, index) => `c${index} = ${index}`).join(' AND '))!;
    expect(many).toMatch(/^c0 is 0, c1 is 1, .* and \d+ more conditions$/);
    expect(many.length).toBeLessThan(170);
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
