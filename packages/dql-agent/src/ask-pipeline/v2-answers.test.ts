import { describe, expect, it } from 'vitest';
import { runAskPipeline } from './pipeline.js';
import { composeAnsweredText, identifierColumn, readingInLabels } from './outcomes.js';
import { plainDeclineReason } from './prepare/exploratory.js';
import { readingWithoutOtherTables } from './reading-tables.js';
import type { AnalyticalIntentV1 } from './intent.js';
import { buildVocabularyIndex, type VocabularySource } from './vocabulary.js';
import type { AgentProvider } from '../providers/types.js';

/**
 * The V2 Ask fixes, from the tester's V14 retest of the ZLens app for Snowflake (15 Nov 2026) and the listing
 * retake on TPC-H: an answer never reads a key out as a figure, a reading names only the tables the answer read
 * and says columns in words, and "Not in this data" says what is missing in plain words.
 */
const T = 'NBA.TRANSFORMED';
const source: VocabularySource = {
  relations: [
    { schema: 'TRANSFORMED', name: 'LOCAL_TEAM_GAME_FACTS', columnCompleteness: 'complete', columns: [{ name: 'GAME_ID', dataType: 'NUMBER' }, { name: 'SEASON', dataType: 'NUMBER' }, { name: 'TEAM_ID', dataType: 'NUMBER' }, { name: 'HOME_WIN', dataType: 'NUMBER' }] },
    { schema: 'TRANSFORMED', name: 'LOCAL_TEAM_SEASON_FACTS', columnCompleteness: 'complete', columns: [{ name: 'TEAM_ID', dataType: 'NUMBER' }, { name: 'SEASON', dataType: 'NUMBER' }, { name: 'HOME_WINS', dataType: 'NUMBER' }] },
    { schema: 'TRANSFORMED', name: 'LOCAL_PLAYER_SEASON_FACTS', columnCompleteness: 'complete', columns: [{ name: 'PLAYER_ID', dataType: 'NUMBER' }, { name: 'PLAYER_NAME', dataType: 'VARCHAR' }, { name: 'TOTAL_POINTS', dataType: 'NUMBER' }] },
  ],
};
const vocabulary = buildVocabularyIndex(source);
const reading = { version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {}, expectedShape: 'grouped' } as unknown as AnalyticalIntentV1;
const sentence = (columns: string[], rows: Array<Record<string, unknown>>) => composeAnsweredText(reading, { columns, rows, rowCount: rows.length, executionTimeMs: 1 }, vocabulary, 'review_required').split('\n\n')[0];

describe('the answer sentence never reads a key out as a figure (V2, listing retake F3)', () => {
  it('knows a key by its name: *_ID, ID, *_KEY, and one-word keys like N_NATIONKEY', () => {
    for (const column of ['GAME_ID', 'ID', 'TEAM_KEY', 'N_NATIONKEY', 'C_CUSTKEY', 'o_orderkey', 'playerId', '"N_NATIONKEY"']) expect(identifierColumn(column)).toBe(true);
    for (const column of ['TOTAL_ORDER_REVENUE', 'AMOUNT_PAID', 'VALID', 'TURKEY', 'HOCKEY_WINS', 'KEY_ACCOUNTS', 'SEASON']) expect(identifierColumn(column)).toBe(false);
  });

  it('a key beside a name is left out: "UNITED STATES · 1,419,081,800.96", not "n nationkey 24"', () => {
    const rows = [
      { N_NATIONKEY: 24, N_NAME: 'UNITED STATES', TOTAL_ORDER_REVENUE: 1419081800.96 },
      { N_NATIONKEY: 9, N_NAME: 'INDONESIA', TOTAL_ORDER_REVENUE: 1391452391.5 },
    ];
    const text = sentence(['N_NATIONKEY', 'N_NAME', 'TOTAL_ORDER_REVENUE'], rows);
    expect(text).toBe('2 rows, starting with UNITED STATES · 1,419,081,800.96; INDONESIA · 1,391,452,391.50.');
    expect(text).not.toMatch(/nationkey/i);
    // One row with several figures still names each figure, the key left out.
    expect(sentence(['C_CUSTKEY', 'C_NAME', 'ORDER_COUNT', 'REVENUE'], [{ C_CUSTKEY: 123456, C_NAME: 'Customer#000123456', ORDER_COUNT: 41, REVENUE: 6123456.5 }]))
      .toBe('Customer#000123456: order count 41, revenue 6,123,456.50.');
  });

  it('a label\'s own key is left out too, and a key with no name beside it is read without separators', () => {
    expect(sentence(['TEAM', 'TEAM_NAME', 'WINS'], [{ TEAM: 1610612744, TEAM_NAME: 'Warriors', WINS: 73 }, { TEAM: 1610612759, TEAM_NAME: 'Spurs', WINS: 67 }]))
      .toBe('2 rows, starting with Warriors · 73; Spurs · 67.');
    expect(sentence(['C_CUSTKEY', 'REVENUE'], [{ C_CUSTKEY: 123456, REVENUE: 6123456.5 }])).toBe('C custkey: 123456, revenue: 6,123,456.50.');
  });
});

describe('a reading says columns in words and names only the tables read (V2, tester V14 Q12 and Q16)', () => {
  const known = [`${T}.LOCAL_TEAM_GAME_FACTS`, `${T}.LOCAL_TEAM_SEASON_FACTS`, `${T}.LOCAL_PLAYER_SEASON_FACTS`, `${T}.LOCAL_PLAYER_GAME_FACTS`];

  it('a raw column name reads as the answer says it; a table name and an unknown word stay', () => {
    expect(readingInLabels('The player with the most career points, using TOTAL_POINTS as the measure', ['TOTAL_POINTS'])).toBe('The player with the most career points, using total points as the measure');
    expect(readingInLabels('Wins where GAME_ID starts with 2', [])).toBe('Wins where game ID starts with 2');
    expect(readingInLabels('Players ranked by TOTAL_POINTS. Top 5.', ['TOTAL_POINTS'])).toBe('Players ranked by total points. Top 5.');
    expect(readingInLabels('Read from NBA_DB.LOCAL_FACTS', [], [])).toBe('Read from NBA_DB.LOCAL_FACTS');
    expect(readingInLabels('Home wins from LOCAL_TEAM_GAME_FACTS', ['HOME_WIN'], known)).toBe('Home wins from LOCAL_TEAM_GAME_FACTS');
    expect(readingInLabels('Sum of home_win per team', ['HOME_WIN'])).toBe('Sum of home win per team');
    expect(readingInLabels('The Lakers in the warriors_ppg_2016 saved query, t.TOTAL_POINTS and SUM(TOTAL_POINTS)', ['TOTAL_POINTS'])).toBe('The Lakers in the warriors_ppg_2016 saved query, t.TOTAL_POINTS and SUM(total points)');
  });

  it('a mention with several words before its noun is another table: "team-season home win totals" over the games table (Q12)', () => {
    const games = [`${T}.LOCAL_TEAM_GAME_FACTS`];
    expect(readingWithoutOtherTables('How many home games did the Boston Celtics win in the 2008 regular season, based on team-season home win totals?', games, known))
      .toBe('How many home games did the Boston Celtics win in the 2008 regular season?');
    expect(readingWithoutOtherTables('Home wins in 2008 (from the team season regular home win records).', games, known)).toBe('Home wins in 2008.');
    // Small words end the phrase: no table is named here.
    expect(readingWithoutOtherTables('Count the player season wins in the data for 2008.', games, known)).toBe('Count the player season wins in the data for 2008.');
  });

  it('the answer reads the held reading, columns in words', async () => {
    const reply = JSON.stringify({ version: 1, kind: 'analytics', reading: 'Home wins of the Boston Celtics in the 2008 regular season, counting HOME_WIN; based on team-season home win totals', measures: [], groupBy: [], display: [], filters: [], expectedShape: 'scalar', provenance: {},
      unresolved: [{ clause: 'home wins', options: [], material: true }] });
    const provider: AgentProvider = { name: 'ollama', available: async () => true, generate: async () => reply };
    const outcome = await runAskPipeline({
      question: 'How many home games did the Boston Celtics win in the 2008 regular season?', vocabulary, provider, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async () => ({ sql: `SELECT SUM(HOME_WIN) AS HOME_WINS FROM ${T}.LOCAL_TEAM_GAME_FACTS WHERE SEASON = 2008`, relations: [`${T}.LOCAL_TEAM_GAME_FACTS`], proof: [] }) },
      executeDeps: { run: async () => ({ columns: ['HOME_WINS'], rows: [{ HOME_WINS: 35 }], rowCount: 1, executionTimeMs: 1 }) },
    });
    expect(outcome.kind).toBe('answered');
    if (outcome.kind !== 'answered') return;
    expect(outcome.text).toContain('I read this as: Home wins of the Boston Celtics in the 2008 regular season, counting home win.');
    expect(outcome.text).not.toMatch(/team-season|HOME_WIN\b/);
    // The reading kept for the next question names no other table either; its words stay the model's own.
    expect(outcome.receipt.reading).toBe('Home wins of the Boston Celtics in the 2008 regular season, counting HOME_WIN');
  });
});

describe('"Not in this data" says what is missing in plain words (V2, listing retake F9)', () => {
  it('says the drafter\'s decline as a reader would', () => {
    expect(plainDeclineReason('No column in the listed relations holds payroll/employee expense data (Ask looked through every table it can read, and no other table has a column for it)'))
      .toBe('None of the tables Ask can read has payroll or employee expense data');
    expect(plainDeclineReason('No column in the listed relations holds payroll/employee expense data.')).toBe('None of the tables Ask can read has payroll or employee expense data');
    expect(plainDeclineReason('None of the provided tables contain player salaries (Ask looked through the tables it chose, and no other table has a column for it)'))
      .toBe('None of the tables Ask searched has player salaries (Ask looked through the tables it chose, and no other table has a column for it)');
    expect(plainDeclineReason('No column in any listed table captures player salary or payroll data')).toBe('None of the tables Ask can read has player salary or payroll data');
    // A sentence that reads plainly keeps its words; "relations" is said as tables.
    expect(plainDeclineReason('The data ends in 2017, so there are no 2019 games')).toBe('The data ends in 2017, so there are no 2019 games');
    expect(plainDeclineReason('Ticket prices are not in these relations')).toBe('Ticket prices are not in the tables Ask can read');
    expect(plainDeclineReason('Ticket prices are in no relation')).toBe('Ticket prices are in no table');
  });

  it('the answer, its gap and its steps read the plain sentence', async () => {
    const outcome = await runAskPipeline({
      question: 'What was our payroll in 1997?', vocabulary, provider: { name: 'ollama', available: async () => true, generate: async () => 'I think the question is about payroll.' }, clauseCoverage: false, explorationAuto: true,
      prepareDeps: { draftSql: async () => ({ declined: 'No column in the listed relations holds payroll/employee expense data (Ask looked through every table it can read, and no other table has a column for it)' }) },
      executeDeps: { run: async () => ({ columns: [], rows: [], rowCount: 0, executionTimeMs: 1 }) },
    });
    expect(outcome.kind).toBe('gap');
    if (outcome.kind !== 'gap') return;
    expect(outcome.text).toBe('No query was run because the tables Ask searched do not hold it: None of the tables Ask can read has payroll or employee expense data.');
    expect(outcome.message).toBe('None of the tables Ask can read has payroll or employee expense data');
    expect(outcome.receipt.refusals.find((refusal) => refusal.code === 'exploration_declined')?.message).toBe('None of the tables Ask can read has payroll or employee expense data');
    expect(JSON.stringify(outcome)).not.toMatch(/listed relations/);
  });
});
