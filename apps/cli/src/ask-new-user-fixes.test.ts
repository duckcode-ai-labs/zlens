import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codeKindsFrom, droppedQuestionWords, holdsCode, joinKindNames, kindFilterOf, kindNamesFrom, kindNamesMessages, kindNoun, kindDatesFrom, kindDatesSql, kindsAnswerLine, kindsContextLine, kindsDeclineNote, kindsLookNote, readingWithoutKindClaims, statedKindFirsts, summaryKindsRead } from './ask-pipeline-host/host.js';
import { activeProviderForDeadline, askTraceReason, deadlineScaleForProvider } from './local-runtime.js';

/**
 * Fixes from the new-user test of the ZLens app for Snowflake on NBA data (2026-11-10): Ask's time budget for
 * Cortex (B3), the trace label for a time-out (B3), and the summary tables that mix every kind of game (B1).
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Ask's time budget follows the provider it runs on (B3)", () => {
  it('reads the provider the install chose when nothing is saved: the Snowflake app allows only Cortex', () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-deadline-'));
    roots.push(root);
    writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'p' }));
    expect(activeProviderForDeadline(root, { ZLENS_MODEL_PROVIDERS: 'cortex' })).toBe('cortex');
    expect(activeProviderForDeadline(root, { ZLENS_MODEL_PROVIDERS: 'cortex,anthropic' })).toBeUndefined();
    expect(activeProviderForDeadline(root, {})).toBeUndefined();
  });

  it('gives Cortex four times the base budget: through SQL each call is a whole statement of 8 to 20 s', () => {
    expect(deadlineScaleForProvider('cortex')).toBe(4);
    expect(deadlineScaleForProvider('ollama')).toBe(6);
    expect(deadlineScaleForProvider('anthropic')).toBe(2);
    expect(deadlineScaleForProvider(undefined)).toBe(1);
  });

  it('labels a time-out as stopped, not refused', () => {
    const base = { status: 'blocked', stopReason: 'blocked', artifacts: [], evaluations: [] } as never as Parameters<typeof askTraceReason>[0];
    expect(askTraceReason({ ...base, summary: 'This question reached its time limit before it finished. Retry it, or ask a narrower question.' })).toBe('Stopped: reached the time limit before an answer.');
    expect(askTraceReason({ ...base, summary: 'No query was run: the table is not modeled.' })).toBe('Refused: no governed answer was available.');
  });
});

describe('a summary table that adds up every kind of game is said in the answer (B1)', () => {
  const rules = {
    'nba.team_season_sums_every_game_id': {
      localId: 'team_season_sums_every_game_id',
      expression: "LOCAL_TEAM_SEASON_FACTS adds up every row of LOCAL_TEAM_GAME_FACTS, every first character of GAME_ID included: TOTAL_POINTS totals 5,412,766, as TEAM_POINTS does in LOCAL_TEAM_GAME_FACTS. For one kind (one first character of GAME_ID), sum LOCAL_TEAM_GAME_FACTS filtered on it: CAST(GAME_ID AS VARCHAR) LIKE '2%' gives 4,759,243.",
      status: 'draft',
    },
    'nba.game_id_first_character': {
      localId: 'game_id_first_character',
      expression: "Every GAME_ID in LOCAL_PLAYER_GAME_FACTS has 8 characters, and the first one takes 4 values: 1 (49,628 rows), 2 (577,985 rows), 4 (40,377 rows), 5 (349 rows). The first character is a code, such as a type: filter on it with CAST(GAME_ID AS VARCHAR) LIKE '2%'.",
      status: 'draft',
    },
    'nba.season_is_start_year': {
      localId: 'season_is_start_year',
      expression: "SEASON is the year a season starts: in LOCAL_PLAYER_GAME_FACTS, SEASON 2012 runs from 2012-10-06 to 2013-06-20 (19 of 20 seasons span two calendar years this way). Rows whose GAME_ID starts with 4 (40,377 rows) or 5 (349 rows) all fall in the calendar year after their SEASON.",
      status: 'draft',
    },
  };

  it('names the summary, the table it adds up and the code, when the statement reads the summary', () => {
    expect(summaryKindsRead(rules, ['NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS', 'NBA.TRANSFORMED.DIM_TEAMS_CLEANSED'])).toEqual([
      { summary: 'LOCAL_TEAM_SEASON_FACTS', detail: 'LOCAL_TEAM_GAME_FACTS', code: 'GAME_ID', rule: 'team_season_sums_every_game_id', expression: rules['nba.team_season_sums_every_game_id'].expression },
    ]);
  });

  it('asks the drafter once more, with the table it totals and the rule: one kind from that table, every kind unchanged', () => {
    const note = kindsLookNote(codeKindsFrom(rules), summaryKindsRead(rules, ['NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS']));
    expect(note).toContain('the statement reads LOCAL_TEAM_SEASON_FACTS, which adds up all of LOCAL_TEAM_GAME_FACTS, every kind of GAME_ID together');
    expect(note).toContain("CAST(GAME_ID AS VARCHAR) LIKE '2%'");
    expect(note).toContain('the first character of GAME_ID codes kinds of game: 1 (49,628 rows), 2 (577,985 rows), 4 (40,377 rows), 5 (349 rows)');
    expect(note).toContain('Rows whose GAME_ID starts with 4');
    expect(note).toContain('If it names one kind');
    expect(note).toContain('answer from LOCAL_TEAM_GAME_FACTS, filtered on that kind');
    expect(note).toContain('If it names no kind, return the same statement unchanged.');
  });

  it('says nothing when the statement reads the detail table, or the rule is retired', () => {
    expect(summaryKindsRead(rules, ['NBA.TRANSFORMED.LOCAL_TEAM_GAME_FACTS'])).toEqual([]);
    expect(summaryKindsRead({ x: { ...rules['nba.team_season_sums_every_game_id'], status: 'deprecated' } }, ['NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS'])).toEqual([]);
    expect(summaryKindsRead(undefined, ['NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS'])).toEqual([]);
  });
});

describe('kinds of game: a kind the question names is applied, and an answer says which kinds it counts (V8 retest)', () => {
  const rules = {
    'nba.game_id_first_character': { expression: "Every GAME_ID in LOCAL_PLAYER_GAME_FACTS has 8 characters, and the first one takes 4 values: 1 (49,628 rows), 2 (577,985 rows), 4 (40,377 rows), 5 (349 rows). The first character is a code, such as a type: filter on it with CAST(GAME_ID AS VARCHAR) LIKE '2%'.", status: 'draft' },
    'nba.season_is_start_year': { expression: 'SEASON is the year a season starts. Rows whose GAME_ID starts with 4 (40,377 rows) or 5 (349 rows) all fall in the calendar year after their SEASON.', status: 'draft' },
    'nba.player_game_participated': { expression: 'In LOCAL_PLAYER_GAME_FACTS, 109,669 of 668,339 rows have PARTICIPATED = false.', status: 'draft' },
  };

  it('reads the coded key, its kinds and the rules that say which kind is which', () => {
    expect(codeKindsFrom(rules)).toEqual([{
      code: 'GAME_ID', table: 'LOCAL_PLAYER_GAME_FACTS',
      values: [{ first: '1', rows: 49628 }, { first: '2', rows: 577985 }, { first: '4', rows: 40377 }, { first: '5', rows: 349 }],
      expressions: [rules['nba.game_id_first_character'].expression, rules['nba.season_is_start_year'].expression],
    }]);
    expect(codeKindsFrom({ x: { ...rules['nba.game_id_first_character'], status: 'deprecated' } })).toEqual([]);
    expect(codeKindsFrom(undefined)).toEqual([]);
  });

  it('finds the kinds a statement keeps, however it writes the first character', () => {
    expect(kindFilterOf("SELECT SUM(POINTS) FROM T WHERE SEASON = 2012 AND CAST(GAME_ID AS VARCHAR) LIKE '4%'", 'GAME_ID')).toEqual({ filtered: true, kinds: ['4'] });
    expect(kindFilterOf("SELECT 1 FROM T tgf WHERE CAST(tgf.GAME_ID AS VARCHAR(20)) LIKE '1%'", 'GAME_ID')).toEqual({ filtered: true, kinds: ['1'] });
    expect(kindFilterOf("SELECT 1 FROM T WHERE GAME_ID::VARCHAR LIKE '2%'", 'GAME_ID')).toEqual({ filtered: true, kinds: ['2'] });
    expect(kindFilterOf("SELECT 1 FROM T WHERE SUBSTR(CAST(GAME_ID AS VARCHAR), 1, 1) IN ('1', '4') AND SEASON = 2015", 'GAME_ID')).toEqual({ filtered: true, kinds: ['1', '4'] });
    expect(kindFilterOf("SELECT 1 FROM T WHERE LEFT(TO_VARCHAR(g.GAME_ID), 1) = '2'", 'GAME_ID')).toEqual({ filtered: true, kinds: ['2'] });
    expect(kindFilterOf('SELECT COUNT(DISTINCT GAME_ID) FROM T WHERE SEASON = 2015', 'GAME_ID')).toEqual({ filtered: false, kinds: [] });
    // A column named for the key with a prefix holds the same key (SRC_GAMES.GAMES_GAME_ID, V9 retest).
    expect(kindFilterOf("SELECT 1 FROM T WHERE GAMES_GAME_ID LIKE '4%'", 'GAME_ID')).toEqual({ filtered: true, kinds: ['4'] });
    expect(kindFilterOf('SELECT COUNT(DISTINCT GAMES_GAME_ID) FROM NBA.TRANSFORMED.SRC_GAMES', 'GAME_ID')).toEqual({ filtered: false, kinds: [] });
    expect(kindFilterOf("SELECT 1 FROM T WHERE PLAYGAME_ID LIKE '4%'", 'GAME_ID')).toEqual({ filtered: false, kinds: [] });
  });

  it('names the kind after the key, and tells the drafter to filter a named kind and count every kind otherwise', () => {
    expect(kindNoun('GAME_ID')).toBe('game');
    expect(kindNoun('ORDER_NUMBER')).toBe('order');
    const line = kindsContextLine(codeKindsFrom(rules)[0]!);
    expect(line).toContain('the first character of GAME_ID says what kind of game a row is (1, 2, 4, 5');
    expect(line).toContain("When the question names one kind (for example one part of a season, or one type), filter on its first character, as CAST(GAME_ID AS VARCHAR) LIKE '5%' keeps the 5 rows");
    expect(line).toContain('When the question names no kind, count every kind: no filter on the first character of GAME_ID.');
  });

  it('measures when each kind falls in the period before the latest, and shows the drafter the dates', () => {
    const sql = kindDatesSql('NBA.TRANSFORMED.LOCAL_TEAM_GAME_FACTS', 'GAME_ID', 'GAME_DATE', 'SEASON', (identifier) => `"${identifier}"`);
    expect(sql).toBe('SELECT SUBSTR(CAST("GAME_ID" AS VARCHAR), 1, 1) AS kind, MIN("SEASON") AS period, MIN("GAME_DATE") AS first_day, MAX("GAME_DATE") AS last_day FROM NBA.TRANSFORMED.LOCAL_TEAM_GAME_FACTS WHERE "SEASON" = (SELECT MAX("SEASON") - 1 FROM NBA.TRANSFORMED.LOCAL_TEAM_GAME_FACTS) GROUP BY SUBSTR(CAST("GAME_ID" AS VARCHAR), 1, 1) ORDER BY 1');
    const dates = kindDatesFrom([
      { KIND: '1', PERIOD: 2021, FIRST_DAY: new Date('2021-10-03T00:00:00Z'), LAST_DAY: '2021-10-15' },
      { KIND: '2', PERIOD: 2021, FIRST_DAY: '2021-10-19', LAST_DAY: '2022-04-10' },
      { KIND: '4', PERIOD: 2021, FIRST_DAY: '2022-04-16', LAST_DAY: '2022-06-16' },
    ], 'SEASON');
    expect(dates).toEqual({ period: 'SEASON', value: '2021', ranges: [{ first: '1', from: '2021-10-03', to: '2021-10-15' }, { first: '2', from: '2021-10-19', to: '2022-04-10' }, { first: '4', from: '2022-04-16', to: '2022-06-16' }] });
    expect(kindDatesFrom([{ team_name: 'Warriors', wins: 73 }], 'SEASON')).toBeUndefined();
    const line = kindsContextLine({ ...codeKindsFrom(rules)[0]!, dates });
    expect(line).toContain('(1, 2, 4, 5; in SEASON 2021 the rows run 1 from 2021-10-03 to 2021-10-15, 2 from 2021-10-19 to 2022-04-10, 4 from 2022-04-16 to 2022-06-16; see the model rules on GAME_ID)');
  });

  it('shows the kinds to a drafter that found no field for a named kind', () => {
    const note = kindsDeclineNote(codeKindsFrom(rules), 'No column identifies playoff games.');
    expect(note).toContain('A first draft found no field for this ("No column identifies playoff games.")');
    expect(note).toContain('the first character of GAME_ID codes kinds of game: 1 (49,628 rows)');
    expect(note).toContain('If what is missing is not a kind, reply NO_SQL as before.');
  });

  it('notices a word of the question the reading dropped that no table or column is named for', () => {
    const known = ['ZLENS_DEV.TRANSFORMED.LOCAL_TEAM_GAME_FACTS', 'GAME_ID', 'SEASON', 'TEAM_WON', 'TEAM_ID', 'TEAM_POINTS'];
    expect(droppedQuestionWords('Which team won the most preseason games in 2018?', 'Which team had the most wins in the 2018 season?', known)).toEqual(['preseason']);
    expect(droppedQuestionWords('How many points did LeBron James score in the 2012 playoffs?', 'Total points scored by LeBron James in the 2012 season, restricted to playoff games.', known)).toEqual([]);
    expect(droppedQuestionWords('How many games are in our data?', 'The number of games.', known)).toEqual([]);
  });
});

describe('game types in plain words, and a reading that agrees with its answer (V9 retest)', () => {
  const rule = "Every GAME_ID in LOCAL_PLAYER_GAME_FACTS has 8 characters, and the first one takes 4 values: 1 (49,628 rows), 2 (577,985 rows), 4 (40,377 rows), 5 (349 rows). The first character is a code, such as a type.";
  const kinds = codeKindsFrom({ r: { expression: rule } })[0]!;
  const names = { '1': 'preseason games', '2': 'regular-season games', '4': 'playoff games', '5': 'play-in games' };
  const named = { ...kinds, names };

  it('finds the key under a prefixed column name, and only there', () => {
    expect(holdsCode('GAME_ID', 'GAME_ID')).toBe(true);
    expect(holdsCode('"GAMES_GAME_ID"', 'GAME_ID')).toBe(true);
    expect(holdsCode('PLAYGAME_ID', 'GAME_ID')).toBe(false);
    expect(holdsCode('GAME_DATE', 'GAME_ID')).toBe(false);
  });

  it('reads the names a rule gives its kinds', () => {
    const withNames = codeKindsFrom({ r: { expression: 'Every GAME_ID in T has 8 characters, and the first one takes 2 values: 2 (regular-season games, 577,985 rows), 4 (playoff games, 40,377 rows).' } })[0]!;
    expect(withNames.values).toEqual([{ first: '2', rows: 577985 }, { first: '4', rows: 40377 }]);
    expect(withNames.names).toEqual({ '2': 'regular-season games', '4': 'playoff games' });
    expect(kinds.names).toBeUndefined();
  });

  it('asks once for the names a reader uses, from the rules and the dates, and keeps only clean, distinct ones', () => {
    const dates = { period: 'SEASON', value: '2021', ranges: [{ first: '1', from: '2021-10-03', to: '2021-10-15' }, { first: '4', from: '2022-04-16', to: '2022-06-16' }] };
    const messages = kindNamesMessages({ ...kinds, dates });
    expect(messages[1]!.content).toContain('KEY: the first character of GAME_ID says what kind of game a row is: 1 (49,628 rows), 2 (577,985 rows)');
    expect(messages[1]!.content).toContain('WHEN EACH KIND FALLS: in SEASON 2021, 1 from 2021-10-03 to 2021-10-15, 4 from 2022-04-16 to 2022-06-16.');
    expect(messages[1]!.content).toContain('Reply as {"1": ["…", "…"], "2": ["…", "…"], "4": ["…", "…"], "5": ["…", "…"]}');
    expect(kindNamesFrom('Here: {"1": ["Preseason games", "exhibition games"], "2": "regular-season games", "4": ["playoff games", "postseason", "the playoffs"], "5": ["play-in games"]}', kinds)).toEqual({ names, words: { '1': ['exhibition games'], '4': ['postseason', 'the playoffs'] } });
    expect(kindNamesFrom('{"1": "preseason games", "2": null, "4": "games; DROP TABLE x", "5": "a very long name of five words"}', kinds)).toEqual({ names: { '1': 'preseason games' } });
    expect(kindNamesFrom('{"1": "games", "2": "games"}', kinds)).toBeUndefined();
    expect(kindNamesFrom('no json', kinds)).toBeUndefined();
  });

  it('finds the kind a stated value names, by its name or its other words (V10 retest)', () => {
    const withWords = { ...named, words: { '4': ['postseason', 'the playoffs'] } };
    expect(statedKindFirsts('Playoffs', withWords)).toEqual(['4']);
    expect(statedKindFirsts('Postseason', withWords)).toEqual(['4']);
    expect(statedKindFirsts('Preseason', withWords)).toEqual(['1']);
    expect(statedKindFirsts('Regular Season', withWords)).toEqual(['2']);
    expect(statedKindFirsts('NBA Playoffs', withWords)).toEqual(['4']);
    expect(statedKindFirsts('Celtics', withWords)).toEqual([]);
    expect(statedKindFirsts('Games', withWords)).toEqual([]);
    expect(statedKindFirsts('Playoffs', kinds)).toEqual([]);
  });

  it('says which games an answer counts in the names a reader uses, with the code beside them', () => {
    expect(joinKindNames(['regular-season games', 'playoff games'])).toBe('regular-season and playoff games');
    expect(joinKindNames(['preseason games', 'regular-season games', 'playoff games', 'play-in games'])).toBe('preseason, regular-season, playoff and play-in games');
    expect(joinKindNames(['returns', 'exchanges'])).toBe('returns and exchanges');
    expect(kindsAnswerLine(named, 'GAME_ID', { filtered: true, kinds: ['4'] })).toBe('it counts only playoff games (GAME_ID starting with 4)');
    expect(kindsAnswerLine(named, 'GAME_ID', { filtered: true, kinds: ['4', '2'] })).toBe('it counts only regular-season and playoff games (GAME_ID starting with 2 or 4)');
    expect(kindsAnswerLine(named, 'GAME_ID', { filtered: false, kinds: [] })).toBe('it counts every kind of game together: preseason, regular-season, playoff and play-in games (GAME_ID starting with 1, 2, 4 or 5); to count one kind, name it in the question');
    // Without names, the code says it, as before.
    expect(kindsAnswerLine(kinds, 'GAME_ID', { filtered: true, kinds: ['4'] })).toBe('it counts only games whose GAME_ID starts with 4, one kind of game');
    expect(kindsAnswerLine(kinds, 'GAME_ID', { filtered: false, kinds: [] })).toBe('it counts every kind of game together (GAME_ID starting with 1, 2, 4 or 5); to count one kind, name it in the question');
    expect(kindsAnswerLine({ ...kinds, names: { '4': 'playoff games' } }, 'GAME_ID', { filtered: false, kinds: [] })).toBe('it counts every kind of game together (GAME_ID starting with 1, 2, 4 or 5); to count one kind, name it in the question');
  });

  const terms = ['preseason games', 'preseason', 'regular-season games', 'regular-season', 'playoff games', 'playoff', 'play-in games', 'play-in', 'game type', 'game-type', 'postseason'];
  it.each([
    ['K1', 'Total points LeBron James scored in the 2012 season (the project has no field distinguishing playoff games from regular-season games, so the playoff restriction cannot be applied).', 'Total points LeBron James scored in the 2012 season'],
    ['K2', "Team with the most wins in 2018; this project's team game data (LOCAL_TEAM_GAME_FACTS) is regular-season only — no preseason/playoff game-type distinction is modeled.", 'Team with the most wins in 2018'],
    ['K4', 'Boston Celtics wins and losses in the 2008 season. No vocabulary entry (metric, dimension, column, or block) distinguishes playoff games from regular-season games, so the record as asked cannot be built from the available refs.', 'Boston Celtics wins and losses in the 2008 season'],
    ['PO-1', "Playoff games the Golden State Warriors won in 2016 — the only certified definition available (nba.warriors_regular_season_wins_2016) explicitly scopes to regular-season games only, and no playoff/game-type flag is present among the vocabulary's columns or relations.", 'Playoff games the Golden State Warriors won in 2016'],
    ['PO-2', "Playoff games the Golden State Warriors won in 2015; this project's game data models only regular-season games (no playoff flag or playoff scope exists in any relation or metric).", 'Playoff games the Golden State Warriors won in 2015'],
    ['G1', 'Postseason games the Miami Heat won in 2012 — this project has no column or dimension distinguishing postseason/playoff games from regular-season games — SEASON and DIM_SEASONS only identify the year, not the game type.', 'Postseason games the Miami Heat won in 2012'],
    ['G3', 'Preseason games the Los Angeles Lakers played and won in 2019; this project has no column or dimension that distinguishes preseason games from regular-season or playoff games.', 'Preseason games the Los Angeles Lakers played and won in 2019'],
    ['G4', "Golden State Warriors points per game in the 2016 regular season and playoffs, but only the regular-season side can be computed because the project does not expose a game-type (regular season vs playoffs) distinction for team game facts.", 'Golden State Warriors points per game in the 2016 regular season and playoffs'],
    ['K2 (V11 check)', 'The question asks which team had the most wins among preseason games played in 2018, but this project has no column or metric distinguishing preseason games (only SEASON as a year, and GAME_TYPE distinguishing regular season vs. playoffs in one certified block) from regular-season or playoff games.', 'The question asks which team had the most wins among preseason games played in 2018'],
  ])('leaves out the claim that game types cannot be told apart (%s)', (_name, reading, expected) => {
    expect(readingWithoutKindClaims(reading, terms)).toBe(expected);
  });

  it.each([
    'Total points LeBron James scored in the 2012 playoffs, playoff games only.',
    'Total points in the 2016 regular season (excluding preseason and playoffs).',
    'Games the Warriors won in 2015, counting every game together: preseason, regular season and playoffs.',
    'Biggest arena by capacity; no game filter applies.',
    'Wins by team in 2018; no other filter applies.',
  ])('keeps a reading that makes no such claim: %s', (reading) => {
    expect(readingWithoutKindClaims(reading, terms)).toBeUndefined();
  });
});
