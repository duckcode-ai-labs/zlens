import { describe, expect, it } from 'vitest';
import { runAskPipeline } from './pipeline.js';
import { composeAnsweredText, describeResultColumns, formatValue, percentDifferenceColumn, repeatedColumns, scaledPercentUnit, withThousands, withoutRepeatedColumns } from './outcomes.js';
import { asksCalendarYear, calendarYearFilters, seasonColumnOf, selectedColumns, shownInSelect, withSeasonForCalendarYear } from './prepare/sql-checks.js';
import { clarificationForOpenQuestion, distinctOptions, measureExamples, openPartsOfQuestion, openPartsOfReason } from './vague-question.js';
import { readingWithoutOtherTables, tableWords } from './reading-tables.js';
import type { AnalyticalIntentV1 } from './intent.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';
import type { AgentProvider } from '../providers/types.js';
import type { ExecutedRows } from './execute.js';

/**
 * The V14 Ask fixes, from the V13 retest of the ZLens app for Snowflake (new-user test, 14 Nov 2026): names for
 * every id an answer shows, a vague question asked back, a stated year read as a season, a share said as a percent,
 * numbers read with separators and labels, one button per choice, and readings that name only the tables read.
 */
const T = 'NBA.TRANSFORMED';
const source: VocabularySource = {
  metrics: [
    { name: 'efficiency_rating', model: 'player_performance', label: 'EFFICIENCY RATING', aggregation: 'sum' },
    { name: 'efficiency_rating', model: 'player_journey', label: 'EFFICIENCY RATING', aggregation: 'sum' },
    { name: 'total_points', model: 'player_performance', label: 'TOTAL POINTS', aggregation: 'sum' },
  ],
  relations: [
    { schema: 'TRANSFORMED', name: 'LOCAL_TEAM_GAME_FACTS', columnCompleteness: 'complete', columns: [{ name: 'GAME_ID', dataType: 'NUMBER' }, { name: 'GAME_DATE', dataType: 'DATE' }, { name: 'SEASON', dataType: 'NUMBER' }, { name: 'TEAM_ID', dataType: 'NUMBER' }, { name: 'TEAM_WON', dataType: 'BOOLEAN' }] },
    { schema: 'TRANSFORMED', name: 'LOCAL_PLAYER_SEASON_FACTS', columnCompleteness: 'complete', columns: [{ name: 'PLAYER_ID', dataType: 'NUMBER' }, { name: 'PLAYER_NAME', dataType: 'VARCHAR' }, { name: 'SEASON', dataType: 'NUMBER' }, { name: 'TEAMS_PLAYED', dataType: 'NUMBER' }] },
    { schema: 'TRANSFORMED', name: 'LOCAL_PLAYER_GAME_FACTS', columnCompleteness: 'complete', columns: [{ name: 'PLAYER_ID', dataType: 'NUMBER' }, { name: 'PLAYER_NAME', dataType: 'VARCHAR' }, { name: 'POINTS', dataType: 'NUMBER' }] },
    { schema: 'TRANSFORMED', name: 'DIM_SEASONS', columnCompleteness: 'complete', columns: [{ name: 'SEASON_ID', dataType: 'NUMBER' }, { name: 'SEASON_NAME', dataType: 'VARCHAR' }] },
  ],
};
const vocabulary = buildVocabularyIndex(source);

/** A model whose readings never parse: the SQL is written from the words. */
const unreadable: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => 'I think the question is about games.' };

const ask = (question: string, draft: { sql?: string; declined?: string; relations?: string[] }, result?: Omit<ExecutedRows, 'executionTimeMs'>, provider: AgentProvider = unreadable) => runAskPipeline({
  question, vocabulary, provider, clauseCoverage: false, explorationAuto: true,
  prepareDeps: {
    draftSql: async () => (draft.declined !== undefined ? { declined: draft.declined } : draft.sql ? { sql: draft.sql, relations: draft.relations ?? [`${T}.LOCAL_TEAM_GAME_FACTS`], proof: [] } : { error: 'the provider returned no SQL' }),
  },
  executeDeps: { run: async () => ({ executionTimeMs: 1, ...(result ?? { columns: ['n'], rows: [{ n: 1 }], rowCount: 1 }) }) },
});

describe('B1: a column that only repeats another is not shown (V13, Q8 and Q11)', () => {
  it('drops a season name equal to the season, and keeps two figures that happen to agree', () => {
    const rows = [{ SEASON: 2003, SEASON_NAME: '2003', PPG: 93 }, { SEASON: 2004, SEASON_NAME: '2004', PPG: 96.99 }];
    expect(repeatedColumns(['SEASON', 'SEASON_NAME', 'PPG'], rows)).toEqual(['SEASON_NAME']);
    expect(repeatedColumns(['SEASON_NAME', 'SEASON'], [{ SEASON: 2003, SEASON_NAME: '2003' }])).toEqual(['SEASON_NAME']);
    expect(repeatedColumns(['WINS', 'HOME_WINS'], [{ WINS: 5, HOME_WINS: 5 }])).toEqual([]);
    expect(repeatedColumns(['PLAYER_ID', 'PLAYER_NAME'], [{ PLAYER_ID: 201142, PLAYER_NAME: 'Kevin Durant' }])).toEqual([]);
    expect(repeatedColumns(['SEASON', 'SEASON_NAME'], [{ SEASON: 2003, SEASON_NAME: '2003-04' }])).toEqual([]);
    const kept = withoutRepeatedColumns({ columns: ['SEASON', 'SEASON_NAME', 'PPG'], rows, rowCount: 2, executionTimeMs: 1 });
    expect(kept.columns).toEqual(['SEASON', 'PPG']);
    expect(kept.rows[0]).toEqual({ SEASON: 2003, PPG: 93 });
  });

  it('an AI-written answer reads "2003 · 93", never "2003 · 2003 · 93"', async () => {
    const outcome = await ask('What was the average points per game in each season?', { sql: `SELECT f.SEASON, s.SEASON_NAME, AVG(f.POINTS) AS PPG FROM ${T}.LOCAL_TEAM_GAME_FACTS f JOIN ${T}.DIM_SEASONS s ON f.SEASON = s.SEASON_ID GROUP BY 1, 2` },
      { columns: ['SEASON', 'SEASON_NAME', 'PPG'], rows: [{ SEASON: 2003, SEASON_NAME: '2003', PPG: 93 }, { SEASON: 2004, SEASON_NAME: '2004', PPG: 96.99 }], rowCount: 2 });
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.result.columns).toEqual(['SEASON', 'PPG']);
    expect(outcome.text).toContain('2 rows, starting with 2003 · 93; 2004 · 96.99.');
    expect(outcome.text).not.toContain('2003 · 2003');
  });

  it('reads the columns a statement shows, with their tables, for the names check', () => {
    const sql = `WITH t AS (SELECT * FROM ${T}.DIM_SEASONS) SELECT p.PLAYER_ID, p.SEASON AS season_year, COUNT(*) AS games, t.SEASON_NAME FROM ${T}.LOCAL_PLAYER_SEASON_FACTS p JOIN t ON t.SEASON_ID = p.SEASON WHERE p.PLAYER_NAME ILIKE '%Durant%' GROUP BY 1, 2, 4`;
    expect(selectedColumns(sql).map((item) => [item.column, item.relation ?? '', item.shownAs])).toEqual([
      ['PLAYER_ID', `${T}.LOCAL_PLAYER_SEASON_FACTS`, 'PLAYER_ID'],
      ['SEASON', `${T}.LOCAL_PLAYER_SEASON_FACTS`, 'season_year'],
    ]);
    expect(selectedColumns(`SELECT TEAM_ID, (SELECT MAX(x) FROM y) AS m FROM ${T}.LOCAL_TEAM_GAME_FACTS`).map((item) => item.column)).toEqual(['TEAM_ID']);
  });

  it('a name only filtered on is not shown: the answer still lists the id (Q11)', () => {
    const filtered = `SELECT p.PLAYER_ID, p.SEASON, p.TEAMS_PLAYED FROM ${T}.LOCAL_PLAYER_SEASON_FACTS p WHERE p.PLAYER_NAME ILIKE '%Kevin Durant%'`;
    expect(shownInSelect(filtered, 'PLAYER_NAME')).toBe(false);
    expect(shownInSelect(filtered, 'PLAYER_ID')).toBe(true);
    expect(shownInSelect(`SELECT MAX(t.TEAM_NICKNAME) AS team, f.SEASON FROM ${T}.LOCAL_TEAM_GAME_FACTS f JOIN t ON 1 = 1 GROUP BY 2`, 'TEAM_NICKNAME')).toBe(true);
    expect(shownInSelect(`WITH x AS (SELECT PLAYER_NAME FROM ${T}.LOCAL_PLAYER_GAME_FACTS) SELECT * FROM x`, 'PLAYER_NAME')).toBe(true);
  });
});

describe('B2: a vague question is asked back, never reported as missing data (V13, Q17)', () => {
  const declined = 'No measure of "how the Warriors are doing" (wins, points, efficiency, etc.) or defined time period for "lately" is specified in the question (Ask also looked in the tables that have a column named for it)';

  it('reads what the words leave open, and what the AI said the question left open', () => {
    expect(openPartsOfQuestion('How are the Warriors doing lately?')).toEqual({ measure: true, period: true });
    expect(openPartsOfQuestion('How is the team performing?')).toEqual({ measure: true, period: false });
    // A trend of a named measure names its measure.
    expect(openPartsOfQuestion('How is revenue trending by month?')).toBeUndefined();
    // "Ambiguous" about a name is not a vague question.
    expect(openPartsOfReason('Two players share the name "Marcus Morris"; the reading is ambiguous between them')).toBeUndefined();
    expect(openPartsOfReason('The question is too vague to choose a measure')).toEqual({ measure: true, period: false });
    expect(openPartsOfQuestion('How many wins did the Warriors have recently?')).toEqual({ measure: false, period: true });
    expect(openPartsOfQuestion("What was the Golden State Warriors' player payroll in 2016?")).toBeUndefined();
    expect(openPartsOfReason(declined)).toEqual({ measure: true, period: true });
    expect(openPartsOfReason('No column in any listed table captures player salary or payroll data')).toBeUndefined();
    expect(measureExamples(declined)).toEqual(['wins', 'points', 'efficiency']);
    expect(measureExamples('nothing holds it (TEAM_WON, WIN_PCT)')).toEqual([]);
    expect(clarificationForOpenQuestion('How are the Warriors doing lately?', declined)).toBe('Which measure do you mean, and over which period (a year or a date range)? For example wins, points or efficiency.');
    expect(clarificationForOpenQuestion("What was the Golden State Warriors' player payroll in 2016?", 'No column captures payroll')).toBeUndefined();
  });

  it('a decline for a vague question becomes a clarification, never "Not in this data"', async () => {
    const outcome = await ask('How are the Warriors doing lately?', { declined });
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind !== 'clarify') return;
    expect(outcome.question).toBe('Which measure do you mean, and over which period (a year or a date range)? For example wins, points or efficiency.');
    expect(outcome.text).not.toMatch(/do not hold|not in this data|tables Ask searched|"How are the Warriors/i);
    expect(outcome.receipt.failure).toBeUndefined();
    expect(outcome.receipt.story?.some((step) => /names no measure or no period/.test(step.title))).toBe(true);
  });

  it('no SQL written for a vague question also asks back (the V13 gate: "blocked")', async () => {
    // The reading leaves the clause open with nothing to choose between, and the drafter writes nothing.
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'How the Warriors are doing lately', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', provenance: {},
      unresolved: [{ clause: 'doing lately', options: [], material: true, question: 'Which measure and which recent period?' }] });
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reply };
    const outcome = await ask('How are the Warriors doing lately?', {}, undefined, provider);
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind !== 'clarify') return;
    expect(outcome.question).toBe('Which measure do you mean, and over which period (a year or a date range)?');
  });

  it('what the data truly lacks stays "not in this data"', async () => {
    const outcome = await ask("What was the Golden State Warriors' player payroll in 2016?", { declined: 'No column in any listed table captures player salary or payroll data' });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.text).toContain('the tables Ask searched do not hold it');
  });
});

describe('B3: a stated year is a season where the tables keep one (V13, PO-2)', () => {
  const PO2 = `SELECT COUNT(*) AS playoff_wins FROM ${T}.LOCAL_TEAM_GAME_FACTS f WHERE f.GAME_ID LIKE '4%' AND EXTRACT(YEAR FROM f.GAME_DATE) = 2015 AND f.TEAM_WON`;

  it('finds a year read as a calendar year, however it is written', () => {
    expect(calendarYearFilters(PO2, '2015')).toEqual([{ text: 'EXTRACT(YEAR FROM f.GAME_DATE) = 2015', expression: 'f.GAME_DATE', qualifier: 'f', column: 'GAME_DATE', year: '2015', relation: `${T}.LOCAL_TEAM_GAME_FACTS` }]);
    const forms = [
      'YEAR(GAME_DATE) = 2015',
      "DATE_PART('year', GAME_DATE) = 2015",
      "DATE_TRUNC('year', GAME_DATE) = '2015-01-01'",
      "TO_CHAR(GAME_DATE, 'YYYY') = '2015'",
      "GAME_DATE BETWEEN '2015-01-01' AND '2015-12-31'",
      "GAME_DATE >= '2015-01-01' AND GAME_DATE < '2016-01-01'",
    ];
    for (const form of forms) expect(calendarYearFilters(`SELECT COUNT(*) FROM ${T}.LOCAL_TEAM_GAME_FACTS WHERE ${form}`, '2015').map((item) => [item.column, item.relation])).toEqual([['GAME_DATE', `${T}.LOCAL_TEAM_GAME_FACTS`]]);
    expect(calendarYearFilters(`SELECT COUNT(*) FROM x WHERE SEASON = 2015`, '2015')).toEqual([]);
    expect(calendarYearFilters(`SELECT COUNT(*) FROM x WHERE EXTRACT(YEAR FROM d) = 2016`, '2015')).toEqual([]);
  });

  it('rewrites it as the season, unless the question means the calendar year', () => {
    expect(withSeasonForCalendarYear(PO2, '2015', () => 'SEASON').sql).toBe(`SELECT COUNT(*) AS playoff_wins FROM ${T}.LOCAL_TEAM_GAME_FACTS f WHERE f.GAME_ID LIKE '4%' AND f.SEASON = 2015 AND f.TEAM_WON`);
    expect(withSeasonForCalendarYear(PO2, '2015', () => undefined).sql).toBe(PO2);
    expect(seasonColumnOf(['GAME_ID', 'GAME_DATE', 'SEASON'])).toBe('SEASON');
    expect(seasonColumnOf(['SEASON_ID', 'SEASON_NAME'])).toBe('SEASON_ID');
    expect(seasonColumnOf(['GAME_DATE'])).toBeUndefined();
    expect(asksCalendarYear('How many playoff games did the Golden State Warriors win in 2015?', '2015')).toBe(false);
    expect(asksCalendarYear('How many games were played in calendar year 2015?', '2015')).toBe(true);
    expect(asksCalendarYear('How many games were played in March 2015?', '2015')).toBe(true);
  });
});

describe('a share is a percent; percentage points only for a difference of two percentages (V13, Q14)', () => {
  it('says 58.8%, and pp only for a difference', () => {
    expect(scaledPercentUnit('HOME_WIN_PCT')).toBe('percent');
    expect(scaledPercentUnit('home win percent')).toBe('percent');
    expect(scaledPercentUnit('growth_pct')).toBe('percent');
    expect(percentDifferenceColumn('WIN_PCT_DIFF')).toBe(true);
    expect(percentDifferenceColumn('pct_points_change')).toBe(true);
    expect(percentDifferenceColumn('difference_in_win_rate')).toBe(false);
    expect(percentDifferenceColumn('difference_in_rate')).toBe(true);
    expect(formatValue(58.8, { name: 'x', kind: 'percent', unit: 'percent' })).toBe('58.8%');
    expect(formatValue(5.2, { name: 'x', kind: 'percent', unit: 'percentage_points' })).toBe('5.2 pp');
    expect(formatValue(0.588, { name: 'x', kind: 'percent', unit: 'fraction' })).toBe('58.8%');
  });

  it('"What percentage of games does the home team win?" reads "58.8%", not "58.8 pp"', async () => {
    const outcome = await ask('What percentage of games does the home team win?', { sql: `SELECT ROUND(100.0 * SUM(HOME_TEAM_WINS) / COUNT(DISTINCT GAME_ID), 1) AS HOME_WIN_PERCENT FROM ${T}.LOCAL_TEAM_GAME_FACTS` },
      { columns: ['HOME_WIN_PERCENT'], rows: [{ HOME_WIN_PERCENT: 58.8 }], rowCount: 1 });
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.text).toContain('Home win percent: 58.8%.');
    expect(outcome.text).not.toContain('pp');
    expect(outcome.result.columnsMeta?.[0]).toMatchObject({ kind: 'percent', unit: 'percent' });
  });

  it('a reading that averages a yes/no flag, or names its measure a percent, says 58.8%, never 0.59 (V14 gate, Q14)', () => {
    const won = 'column:TRANSFORMED.LOCAL_TEAM_GAME_FACTS.TEAM_WON';
    expect(vocabulary.get(won)).toBeDefined();
    const reading = (alias: string, ref: string) => ({ version: 1, kind: 'analytics', reading: 'share of games won', measures: [{ ref, aggregation: 'avg', alias }], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'scalar' }) as unknown as AnalyticalIntentV1;
    // As the pipeline does: the column types come from the reading (describeResultColumns), then the sentence.
    const sentence = (alias: string, ref: string, value: number) => {
      const rows = [{ [alias]: value }];
      const columnsMeta = describeResultColumns(reading(alias, ref), { columns: [alias], rows }, vocabulary);
      return composeAnsweredText(reading(alias, ref), { columns: [alias], rows, rowCount: 1, executionTimeMs: 1, columnsMeta }, vocabulary, 'review_required').split('\n\n')[0];
    };
    expect(sentence('WIN_SHARE', won, 0.588)).toContain('58.8%');
    expect(sentence('HOME_WIN_PERCENT', 'column:TRANSFORMED.LOCAL_TEAM_GAME_FACTS.GAME_ID', 0.588)).toContain('58.8%');
    expect(sentence('HOME_WIN_PERCENT', 'column:TRANSFORMED.LOCAL_TEAM_GAME_FACTS.GAME_ID', 0.588)).not.toContain('0.59');
    expect(sentence('HOME_WIN_PERCENT', 'column:TRANSFORMED.LOCAL_TEAM_GAME_FACTS.GAME_ID', 58.8)).toContain('58.8%');
  });
});

describe('answer sentences read numbers with separators and name each figure (V13)', () => {
  const reading = { version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' } as unknown as AnalyticalIntentV1;
  const first = (columns: string[], rows: Array<Record<string, unknown>>) => composeAnsweredText(reading, { columns, rows, rowCount: rows.length, executionTimeMs: 1 }, vocabulary, 'review_required').split('\n\n')[0];

  it('groups thousands in amounts, never in ids, years or seasons', () => {
    expect(withThousands('26622')).toBe('26,622');
    expect(withThousands('2735.70')).toBe('2,735.70');
    expect(withThousands('-1234567.5%')).toBe('-1,234,567.5%');
    expect(withThousands('118.67')).toBe('118.67');
    expect(withThousands('Thunder')).toBe('Thunder');
    expect(first(['GAME_COUNT'], [{ GAME_COUNT: 26622 }])).toBe('Game count: 26,622.');
    expect(first(['GAME_ID', 'MARGIN'], [{ GAME_ID: 22100330, MARGIN: 73 }])).toBe('Game ID: 22100330, margin: 73.');
    expect(first(['SEASON', 'TOTAL_POINTS'], [{ SEASON: 2015, TOTAL_POINTS: 2375 }])).toBe('2015: total points 2,375.');
    expect(first(['SEASON_START', 'TOTAL_POINTS'], [{ SEASON_START: 2003, TOTAL_POINTS: 1250 }])).toBe('2003: total points 1,250.');
    expect(first(['SEASON_POINTS'], [{ SEASON_POINTS: 2375 }])).toBe('Season points: 2,375.');
    expect(first(['PLAYER_NAME', 'TOTAL_POINTS'], [{ PLAYER_NAME: 'LeBron James', TOTAL_POINTS: 46612 }, { PLAYER_NAME: 'Kevin Durant', TOTAL_POINTS: 32272 }])).toBe('2 rows, starting with LeBron James · 46,612; Kevin Durant · 32,272.');
  });

  it('a row with several figures names each one, never a string of bare numbers', () => {
    const rows = [
      { TEAM_ID: 1610612749, TEAM_NICKNAME: 'Bucks', POINTS_PER_GAME: 118.67, WINS: 56, GAMES_PLAYED: 73, WIN_PCT: 0.767 },
      { TEAM_ID: 1610612745, TEAM_NICKNAME: 'Rockets', POINTS_PER_GAME: 117.81, WINS: 44, GAMES_PLAYED: 72, WIN_PCT: 0.611 },
    ];
    const text = composeAnsweredText(reading, { columns: Object.keys(rows[0]!), rows, rowCount: 2, executionTimeMs: 1, columnsMeta: [{ name: 'WIN_PCT', kind: 'percent', unit: 'fraction' }] }, vocabulary, 'review_required').split('\n\n')[0];
    expect(text).toBe('2 rows, starting with Bucks: points per game 118.67, wins 56, games played 73, win percent 76.7%; Rockets: points per game 117.81, wins 44, games played 72, win percent 61.1%.');
    expect(text).not.toMatch(/Bucks · 118\.67 · 56/);
    expect(first(['SEASON', 'TEAM_NICKNAME'], [{ SEASON: 2007, TEAM_NICKNAME: 'Thunder' }, { SEASON: 2016, TEAM_NICKNAME: 'Warriors' }])).toBe('2 rows, starting with 2007 · Thunder; 2016 · Warriors.');
  });
});

describe('a clarification offers each choice once (V13, Q16)', () => {
  it('drops a second button with the same label', () => {
    expect(distinctOptions([{ ref: 'a', label: 'EFFICIENCY RATING' }, { ref: 'b', label: 'efficiency_rating' }, { ref: 'c', label: 'TOTAL POINTS' }]).map((option) => option.ref)).toEqual(['a', 'c']);
  });

  it('"Who is the best player?" shows one EFFICIENCY RATING button', async () => {
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'The best player', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', provenance: {},
      unresolved: [{ clause: 'best player', options: ['metric:player_performance.efficiency_rating', 'metric:player_journey.efficiency_rating', 'metric:player_performance.total_points'], material: true, question: 'Which measure should define best?' }] });
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reply };
    const outcome = await ask('Who is the best player?', {}, undefined, provider);
    expect(outcome.kind).toBe('clarify');
    if (outcome.kind !== 'clarify') return;
    expect(outcome.options.map((option) => option.label)).toEqual(['EFFICIENCY RATING', 'TOTAL POINTS']);
  });
});

describe('a reading names only the tables the answer read (V13, K3 and the Raptors)', () => {
  const known = [`${T}.LOCAL_PLAYER_SEASON_FACTS`, `${T}.LOCAL_PLAYER_GAME_FACTS`, `${T}.LOCAL_TEAM_SEASON_FACTS`, `${T}.LOCAL_TEAM_GAME_FACTS`, `${T}.DIM_SEASONS`, `${T}.SRC_GAMES`];

  it('reads a table name as words', () => {
    expect(tableWords('LOCAL_PLAYER_SEASON_FACTS')).toEqual(['player', 'season']);
    expect(tableWords(`${T}.DIM_TEAMS_CLEANSED`)).toEqual(['teams']);
  });

  it('takes out the clause that names another table, and keeps one that names a table read', () => {
    const playerGame = [`${T}.LOCAL_PLAYER_GAME_FACTS`];
    expect(readingWithoutOtherTables('Count the 2015 regular season games and total points for Stephen Curry, per the player season facts.', playerGame, known))
      .toBe('Count the 2015 regular season games and total points for Stephen Curry.');
    expect(readingWithoutOtherTables('How many games did the Raptors win in the 2018 regular season, based on the team-season win totals?', [`${T}.LOCAL_TEAM_GAME_FACTS`], known))
      .toBe('How many games did the Raptors win in the 2018 regular season?');
    expect(readingWithoutOtherTables('Total points in the 2016 regular season (the team-season facts table already reflects regular-season totals).', playerGame, known))
      .toBe('Total points in the 2016 regular season.');
    expect(readingWithoutOtherTables('List the teams Kevin Durant played for in each season, from his player-season records', playerGame, known))
      .toBe('List the teams Kevin Durant played for in each season');
    expect(readingWithoutOtherTables('Games per season, using the games relation and its SEASON field.', playerGame, known))
      .toBe('Games per season.');
    // A table the answer read is named as it is; ordinary words are not tables.
    expect(readingWithoutOtherTables('Points per game, per the player game facts.', playerGame, known)).toBe('Points per game, per the player game facts.');
    expect(readingWithoutOtherTables('Wins in the 2015 regular season totals for each team.', playerGame, known)).toBe('Wins in the 2015 regular season totals for each team.');
    expect(readingWithoutOtherTables('Counted from LOCAL_TEAM_SEASON_FACTS.', playerGame, known)).toBe('Counted.');
    // A table named with one plain word is an ordinary word in a reading.
    expect(readingWithoutOtherTables('Rank players by their summed points across all games in 2016.', ['dev.player_game_stats'], ['dev.players', 'dev.games', 'dev.player_game_stats']))
      .toBe('Rank players by their summed points across all games in 2016.');
  });

  it('the answer reads the cleaned reading', async () => {
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Total points for Stephen Curry in 2015, per the player season facts', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', provenance: {},
      unresolved: [{ clause: 'points', options: [], material: true }] });
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reply };
    const outcome = await runAskPipeline({
      question: 'How many points did Stephen Curry score in 2015?', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async () => ({ sql: `SELECT SUM(POINTS) AS TOTAL_POINTS FROM ${T}.LOCAL_PLAYER_GAME_FACTS WHERE PLAYER_NAME = 'Stephen Curry'`, relations: [`${T}.LOCAL_PLAYER_GAME_FACTS`], proof: ['reading: Total points for Stephen Curry in 2015, per the player season facts'] }) },
      executeDeps: { run: async () => ({ columns: ['TOTAL_POINTS'], rows: [{ TOTAL_POINTS: 2375 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.text).toContain('I read this as: Total points for Stephen Curry in 2015.');
    expect(outcome.text).toContain('Total points: 2,375.');
    expect(outcome.text).not.toContain('player season facts');
  });
});
