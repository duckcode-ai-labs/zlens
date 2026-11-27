import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentProvider, AgentRunRequest } from '@zlens/agent';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { createAskPipelineRouteExecutor, keyProbeDeadlineMs, repeatedKeyProbe } from './host.js';
import { askedThings, keyLabels, unlistedAskedThings, unlistedThingFailure, unnamedGroupingKeys, type KeyReference } from './key-labels.js';

/**
 * The V14 Ask fixes on the host, over a small NBA-shaped project (new-user test V13 of the ZLens app for Snowflake):
 * "Which teams did Kevin Durant play for, and in which seasons?" lists the teams by name season by season, never a
 * player id and a count of teams; and a stated year in SQL written from the words is read as the season.
 */
const PLAYER_SEASONS = 'dev.player_season_facts';
const PLAYER_GAMES = 'dev.player_game_facts';
const TEAMS = 'dev.teams';
const TEAM_GAMES = 'dev.team_game_facts';
const JOURNEY = 'dev.player_journey';
const columns: Record<string, string[]> = {
  [PLAYER_SEASONS]: ['player_id', 'player_name', 'season', 'teams_played'],
  [PLAYER_GAMES]: ['game_id', 'game_date', 'season', 'team_id', 'player_id', 'player_name', 'points'],
  [TEAMS]: ['team_id', 'team_nickname', 'city'],
  [TEAM_GAMES]: ['game_id', 'game_date', 'season', 'team_id', 'team_nickname', 'team_won'],
  // Last, so the tables the name checks above look through come first as before.
  [JOURNEY]: ['player_id', 'player_name', 'season', 'team_id'],
};
const tables = Object.keys(columns);
const columnsOf = (relation: string) => columns[tables.find((table) => table.toLowerCase() === relation.toLowerCase()) ?? relation] ?? [];
const label = (keys: KeyReference[]) => keyLabels(keys, { edges: [], relations: tables, columnsOf });

const COUNTS = `SELECT p.player_id, p.season, p.teams_played FROM ${PLAYER_SEASONS} p WHERE p.player_name ILIKE '%Kevin Durant%' ORDER BY p.season`;
const NAMES = `SELECT g.season, t.team_nickname FROM ${PLAYER_GAMES} g JOIN ${TEAMS} t ON g.team_id = t.team_id WHERE g.player_name ILIKE '%Kevin Durant%' GROUP BY g.season, t.team_nickname ORDER BY g.season`;

describe('names for every id an answer shows, and for the things a question asks to list (V13, Q11)', () => {
  it('reads the things a question asks to list', () => {
    expect(askedThings('Which teams did Kevin Durant play for, and in which seasons?')).toEqual(['team', 'season']);
    expect(askedThings('Which 5 teams scored the most points per game?')).toEqual(['team']);
    expect(askedThings('What percentage of games does the home team win?')).toEqual([]);
    expect(askedThings('Which of those had a winning record?')).toEqual([]);
    expect(askedThings('What was the biggest winning margin?')).toEqual([]);
  });

  it('a player id shown beside nothing is named by the player name on its own table', () => {
    const unnamed = unnamedGroupingKeys(COUNTS, 'Which teams did Kevin Durant play for, and in which seasons?', label, columnsOf);
    expect(unnamed.map((item) => [item.key, item.labelRelation, item.label, item.via])).toEqual([['player_id', PLAYER_SEASONS, 'player_name', 'its own table']]);
    // Shown with its name, or asked for by id, it passes.
    expect(unnamedGroupingKeys(`SELECT p.player_id, p.player_name, p.season FROM ${PLAYER_SEASONS} p`, 'Which seasons did Durant play?', label, columnsOf)).toEqual([]);
    expect(unnamedGroupingKeys(COUNTS, 'Which player ids played for the Thunder?', label, columnsOf)).toEqual([]);
  });

  it('teams asked for are listed by name: a count of teams does not answer "which teams"', () => {
    const question = 'Which teams did Kevin Durant play for, and in which seasons?';
    const unlisted = unlistedAskedThings(COUNTS, question, { tables, label, columnsOf });
    expect(unlisted.map((item) => [item.thing, item.label.labelRelation, item.label.label])).toEqual([['team', TEAMS, 'team_nickname']]);
    expect(unlistedThingFailure(unlisted[0]!)).toBe(`the question asks which teams, but the statement shows no team by name: list each team by ${TEAMS}.team_nickname (join ${TEAMS} ON ${PLAYER_GAMES}.team_id = ${TEAMS}.team_id) rather than counting them or showing team_id alone`);
    expect(unlistedAskedThings(NAMES, question, { tables, label, columnsOf })).toEqual([]);
    // The teams are named from the table that shares the statement's columns (the player's games), not the first one.
    const teamGamesFirst = [TEAM_GAMES, PLAYER_GAMES, TEAMS, PLAYER_SEASONS];
    expect(unlistedAskedThings(COUNTS, question, { tables: teamGamesFirst, label: (keys) => keyLabels(keys, { edges: [], relations: teamGamesFirst, columnsOf }), columnsOf })[0]!.label.keyRelation).toBe(PLAYER_GAMES);
    // "How many teams" asks for a count.
    expect(unlistedAskedThings(COUNTS, 'How many teams did Kevin Durant play for in each season?', { tables, label, columnsOf })).toEqual([]);
  });
});

describe('a join key count always has a limit (fast on big tables)', () => {
  it('is 5 s, or what is left of a run that has less, and none is run when too little is left', () => {
    expect(keyProbeDeadlineMs()).toBe(5_000);
    expect(keyProbeDeadlineMs(60_000)).toBe(5_000);
    expect(keyProbeDeadlineMs(4_600)).toBe(4_600);
    expect(keyProbeDeadlineMs(100)).toBeNull();
    expect(keyProbeDeadlineMs(-5)).toBeNull();
  });

  it('a repeat check on Snowflake counts a one-column key against its groups; a key of several columns, or another warehouse, lists the keys that repeat', () => {
    expect(repeatedKeyProbe('DB.S.ORDERS', ['"O_CUSTKEY"'], 'snowflake')).toEqual({
      sql: 'SELECT COUNT(*) AS key_rows, COUNT(DISTINCT "O_CUSTKEY") + CASE WHEN COUNT(*) > COUNT("O_CUSTKEY") THEN 1 ELSE 0 END AS key_groups FROM DB.S.ORDERS',
      counts: true,
    });
    expect(repeatedKeyProbe('DB.S.LINEITEM', ['"L_ORDERKEY"', '"L_LINENUMBER"'], 'snowflake')).toEqual({
      sql: 'SELECT "L_ORDERKEY", "L_LINENUMBER" FROM DB.S.LINEITEM GROUP BY "L_ORDERKEY", "L_LINENUMBER" HAVING COUNT(*) > 1',
      counts: false,
    });
    expect(repeatedKeyProbe('dev.teams', ['"team_id"'], 'duckdb')).toEqual({ sql: 'SELECT "team_id" FROM dev.teams GROUP BY "team_id" HAVING COUNT(*) > 1', counts: false });
  });
});

describe('on the host: the Durant answer lists team names by season', () => {
  const connection = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
  const manifest = { sources: Object.fromEntries(tables.map((table) => {
    const name = table.split('.').pop()!;
    return [name, { name, origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: `model.nba.${name}`, schema: 'dev', columns: Object.fromEntries(columnsOf(table).map((column) => [column, { name: column }])) } }];
  })) };
  const executed: string[] = [];
  // The join key counts: their SQL, the limit each was given, and how many ran at once.
  const keyProbes: Array<{ sql: string; deadlineMs?: number }> = [];
  let probesRunning = 0;
  let mostAtOnce = 0;
  // The repeat checks (GROUP BY ... HAVING COUNT(*) > 1): their SQL and limit, how many ran at once, whether one ran
  // while an empty-key count did, and what each returns (no repeats unless a test says otherwise; a throw is a probe
  // that ran out of time).
  const repeatProbes: Array<{ sql: string; deadlineMs?: number }> = [];
  let repeatsRunning = 0;
  let mostRepeatsAtOnce = 0;
  let repeatBesideCount = false;
  let repeatRows: (sql: string) => Array<Record<string, unknown>> = () => [];
  const routeFor = (reading: string, drafts: string[], prompts: string[], conn: ConnectionConfig = connection) => createAskPipelineRouteExecutor({
    projectRoot: '/tmp/ask-v14',
    executor: { executeQuery: vi.fn(async (sql: string, _params?: unknown, _vars?: unknown, _connection?: unknown, options?: { deadlineMs?: number }) => {
      executed.push(sql);
      if (/HAVING COUNT\(\*\) > 1/.test(sql)) {
        repeatProbes.push({ sql, ...(options?.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}) });
        repeatsRunning += 1;
        mostRepeatsAtOnce = Math.max(mostRepeatsAtOnce, repeatsRunning);
        if (probesRunning > 0) repeatBesideCount = true;
        try {
          await new Promise((resolve) => setTimeout(resolve, 15));
          const rows = repeatRows(sql);
          return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
        } finally {
          repeatsRunning -= 1;
        }
      }
      // How many rows have each join key: the journey's team_id is empty in 93% of its rows, as FCT_PLAYER_JOURNEY's
      // is on the NBA trial; the game facts' team_id in 2%, like an optional key; the teams' never.
      if (/AS key_empty FROM/.test(sql)) {
        keyProbes.push({ sql, ...(options?.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}) });
        probesRunning += 1;
        mostAtOnce = Math.max(mostAtOnce, probesRunning);
        if (repeatsRunning > 0) repeatBesideCount = true;
        await new Promise((resolve) => setTimeout(resolve, 15));
        probesRunning -= 1;
        const counts = sql.includes(JOURNEY) && sql.includes('team_id') ? { KEY_ROWS: 6305, KEY_EMPTY: 5866 } : sql.includes(PLAYER_GAMES) ? { KEY_ROWS: 10000, KEY_EMPTY: 200 } : { KEY_ROWS: 30, KEY_EMPTY: 0 };
        return { columns: ['KEY_ROWS', 'KEY_EMPTY'], rowCount: 1, executionTimeMs: 1, rows: [counts] };
      }
      if (sql.includes(JOURNEY) && sql.includes('team_nickname')) return { columns: ['season', 'team_nickname'], rowCount: 3, executionTimeMs: 1, rows: [{ season: 2007, team_nickname: null }, { season: 2016, team_nickname: null }, { season: 2020, team_nickname: null }] };
      if (sql.includes('information_schema.columns')) {
        const rows = tables.filter((table) => sql.includes(`'${table.split('.').pop()}'`)).flatMap((table) => columnsOf(table).map((column) => ({ table_schema: 'dev', table_name: table.split('.').pop(), column_name: column, data_type: /_id$|season|points|played/.test(column) ? 'BIGINT' : 'VARCHAR' })));
        return { columns: [], rowCount: rows.length, executionTimeMs: 1, rows };
      }
      // Probes: a name that differs from its key, a season that holds the year.
      if (/^SELECT 1 /.test(sql)) return { columns: ['hit'], rowCount: 1, executionTimeMs: 1, rows: [{ hit: 1 }] };
      if (sql.includes('team_nickname') && sql.includes(PLAYER_GAMES)) return { columns: ['season', 'team_nickname'], rowCount: 3, executionTimeMs: 1, rows: [{ season: 2007, team_nickname: 'Thunder' }, { season: 2016, team_nickname: 'Warriors' }, { season: 2020, team_nickname: 'Nets' }] };
      if (sql.includes('teams_played')) return { columns: ['player_id', 'season', 'teams_played'], rowCount: 2, executionTimeMs: 1, rows: [{ player_id: 201142, season: 2007, teams_played: 1 }, { player_id: 201142, season: 2008, teams_played: 1 }] };
      return { columns: ['playoff_wins'], rowCount: 1, executionTimeMs: 1, rows: [{ playoff_wins: 15 }] };
    }) } as unknown as QueryExecutor,
    resolveConnection: async () => conn,
    getSemanticLayer: () => undefined,
    getManifest: () => ({ snapshotId: 'snapshot:v14', manifest: manifest as never }),
    selectProvider: async () => ({
      name: 'ollama', available: async () => true,
      generate: async (messages: AgentMessage[]) => {
        if (!messages[0]!.content.startsWith('You write exactly ONE read-only SQL statement')) return reading;
        prompts.push(messages.map((message) => message.content).join('\n'));
        return drafts[Math.min(prompts.length - 1, drafts.length - 1)]!;
      },
    }) as AgentProvider,
    compileSemantic: async () => { throw new Error('no semantic layer'); },
    priorIntent: () => undefined,
  });
  const ask = (route: ReturnType<typeof createAskPipelineRouteExecutor>, question: string) => route({
    runId: 'run:v14',
    request: { question, requestedMode: 'ask' } as AgentRunRequest,
    route: 'generated_answer', maxRepairAttempts: 0, attempt: 0, emit: () => {},
  });
  const reading = JSON.stringify({ version: 1, kind: 'analytics', reading: 'List the teams Kevin Durant played for in each season.', measures: [], groupBy: [], display: [], filters: [], unresolved: [{ clause: 'teams by season', options: [], material: true }], provenance: {}, expectedShape: 'grouped' });
  const question = 'Which teams did Kevin Durant play for, and in which seasons?';

  it('a count of teams beside a player id is sent back once, and the answer reads the team names', async () => {
    const prompts: string[] = [];
    const result = await ask(routeFor(reading, [COUNTS, NAMES], prompts), question);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('the question asks which teams, but the statement shows no team by name');
    expect(prompts[1]).toContain(`it shows ${PLAYER_SEASONS}.player_id, a key a reader cannot read, and no name for it, although player_name on the same table names those rows`);
    expect(result.status).toBe('completed');
    expect(result.answer).toContain('3 rows, starting with 2007 · Thunder; 2016 · Warriors; 2020 · Nets.');
    expect(result.answer).not.toMatch(/201142|teams played/i);
    const checks = (result.askPipelineReceipt?.checks ?? []).filter((check) => check.id === 'key_labels');
    expect(checks.map((check) => check.passed)).toEqual([false, true]);
  });

  it('a repair that still shows ids and counts is not taken as a fix, and the answer says the teams are not named', async () => {
    const prompts: string[] = [];
    const seasonName = `SELECT p.player_id, p.season, p.season AS season_name, p.teams_played FROM ${PLAYER_SEASONS} p WHERE p.player_name ILIKE '%Kevin Durant%'`;
    const result = await ask(routeFor(reading, [COUNTS, seasonName], prompts), question);
    expect(prompts).toHaveLength(2);
    expect(result.answer).toContain(`It does not list the teams by name; teams.team_nickname names them, and the statement could not be made to show it.`);
    const checks = (result.askPipelineReceipt?.checks ?? []).filter((check) => check.id === 'key_labels');
    expect(checks.map((check) => check.passed)).toEqual([false, false]);
  });

  // Q11 after the setup checks on Snowflake (26 Nov 2026): the AI joined the journey on its mostly empty TEAM_ID.
  const JOURNEY_TEAMS = `SELECT j.season, t.team_nickname FROM ${JOURNEY} j LEFT JOIN ${TEAMS} t ON j.team_id = t.team_id WHERE j.player_name ILIKE '%Kevin Durant%' GROUP BY j.season, t.team_nickname ORDER BY j.season`;

  it('a join on a key empty in most rows is sent back once, and the answer reads the teams from where team_id is filled (Q11)', async () => {
    const prompts: string[] = [];
    const result = await ask(routeFor(reading, [JOURNEY_TEAMS, NAMES], prompts), question);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('its join of player_journey and teams on team_id matches few rows: team_id is empty in 5,866 of 6,305 player_journey rows (93%); take team_id from a table where it is filled, or reach teams another way');
    expect(result.status).toBe('completed');
    expect(result.answer).toContain('3 rows, starting with 2007 · Thunder; 2016 · Warriors; 2020 · Nets.');
    expect(result.answer).not.toMatch(/is empty in/);
    const checks = (result.askPipelineReceipt?.checks ?? []).filter((check) => check.id === 'join_keys_filled');
    expect(checks.map((check) => check.passed)).toEqual([false, true]);
  });

  it('a repair that keeps the mostly empty key is not taken as a fix: the statement runs and the answer says how few rows it matched', async () => {
    const prompts: string[] = [];
    const result = await ask(routeFor(reading, [JOURNEY_TEAMS, JOURNEY_TEAMS.replace('ORDER BY j.season', 'ORDER BY j.season DESC')], prompts), question);
    expect(prompts).toHaveLength(2);
    expect(result.status).toBe('completed');
    expect(result.answer).toContain('Team_id is empty in 93% of player_journey rows (5,866 of 6,305), so the join to teams leaves most of them unmatched; no better way to link them was found.');
  });

  it('an optional key empty in a few rows is not judged (2%: under the half that makes a key mostly empty)', async () => {
    const prompts: string[] = [];
    const result = await ask(routeFor(reading, [NAMES], prompts), question);
    expect(prompts).toHaveLength(1);
    expect(result.status).toBe('completed');
    const checks = (result.askPipelineReceipt?.checks ?? []).filter((check) => check.id === 'join_keys_filled');
    expect(checks.map((check) => check.passed)).toEqual([true]);
  });

  it('counts every join key of an answer at once, within 5 s each, and a one-column key as COUNT(*) - COUNT(key) (fast on big tables)', async () => {
    const prompts: string[] = [];
    keyProbes.length = 0;
    mostAtOnce = 0;
    // Beside the team join counted above: a join on two columns and one on one column, four sides not counted yet.
    const seasons = `SELECT g.season, t.team_nickname FROM ${PLAYER_GAMES} g JOIN ${TEAMS} t ON g.team_id = t.team_id JOIN ${PLAYER_SEASONS} p ON p.player_id = g.player_id AND p.season = g.season JOIN ${JOURNEY} j ON j.player_id = g.player_id WHERE g.player_name ILIKE '%Kevin Durant%' GROUP BY g.season, t.team_nickname ORDER BY g.season`;
    const result = await ask(routeFor(reading, [seasons], prompts), question);
    expect(result.status).toBe('completed');
    const fresh = keyProbes.filter((probe) => !/"team_id"/.test(probe.sql));
    expect(fresh.length).toBeGreaterThanOrEqual(4);
    // Together, not one after another.
    expect(mostAtOnce).toBeGreaterThanOrEqual(2);
    // Every probe has a limit; with no run budget it is the default 5 s.
    expect(fresh.every((probe) => probe.deadlineMs === 5_000)).toBe(true);
    // One column: Snowflake answers it from table metadata. Two columns: empty when either is.
    expect(fresh.some((probe) => probe.sql === `SELECT COUNT(*) AS key_rows, COUNT(*) - COUNT("player_id") AS key_empty FROM ${JOURNEY}`)).toBe(true);
    expect(fresh.some((probe) => probe.sql === `SELECT COUNT(*) AS key_rows, SUM(CASE WHEN "player_id" IS NULL OR "season" IS NULL THEN 1 ELSE 0 END) AS key_empty FROM ${PLAYER_SEASONS}`)).toBe(true);
  });

  // The same tables seen through another role: their empty-key counts are not remembered from the tests above.
  const freshRole = (role: string) => ({ ...connection, role }) as ConnectionConfig;

  it('checks every join key for repeats at once, beside the empty-key counts, within 5 s each and once per key', async () => {
    const prompts: string[] = [];
    repeatProbes.length = 0;
    mostRepeatsAtOnce = 0;
    repeatBesideCount = false;
    const seasons = `SELECT g.season, t.team_nickname FROM ${PLAYER_GAMES} g JOIN ${TEAMS} t ON g.team_id = t.team_id JOIN ${PLAYER_SEASONS} p ON p.player_id = g.player_id AND p.season = g.season JOIN ${JOURNEY} j ON j.player_id = g.player_id WHERE g.player_name ILIKE '%Kevin Durant%' GROUP BY g.season, t.team_nickname ORDER BY g.season`;
    const result = await ask(routeFor(reading, [seasons], prompts, freshRole('repeats-at-once')), question);
    expect(result.status).toBe('completed');
    // Six sides: two one-column joins and one on two columns, each side probed once although the checks ran twice.
    expect(repeatProbes.map((probe) => probe.sql).sort()).toEqual([
      `SELECT "player_id" FROM ${JOURNEY} GROUP BY "player_id" HAVING COUNT(*) > 1`,
      `SELECT "player_id" FROM ${PLAYER_GAMES} GROUP BY "player_id" HAVING COUNT(*) > 1`,
      `SELECT "player_id", "season" FROM ${PLAYER_GAMES} GROUP BY "player_id", "season" HAVING COUNT(*) > 1`,
      `SELECT "player_id", "season" FROM ${PLAYER_SEASONS} GROUP BY "player_id", "season" HAVING COUNT(*) > 1`,
      `SELECT "team_id" FROM ${PLAYER_GAMES} GROUP BY "team_id" HAVING COUNT(*) > 1`,
      `SELECT "team_id" FROM ${TEAMS} GROUP BY "team_id" HAVING COUNT(*) > 1`,
    ].sort());
    // Together, not one after another, and while the empty-key counts run.
    expect(mostRepeatsAtOnce).toBe(6);
    expect(repeatBesideCount).toBe(true);
    // Every one has a limit; with no run budget it is the default 5 s.
    expect(repeatProbes.every((probe) => probe.deadlineMs === 5_000)).toBe(true);
    const fanout = (result.askPipelineReceipt?.checks ?? []).filter((check) => check.id === 'join_fanout');
    expect(fanout.at(-1)).toMatchObject({ passed: true, message: 'no join multiplies the rows it totals' });
  });

  it('a repeat check that runs out of time leaves its join unknown, never a key without repeats', async () => {
    const prompts: string[] = [];
    // The games repeat team_id; the teams' check runs out of time.
    repeatRows = (sql) => {
      if (sql.includes(TEAMS)) throw new Error('statement reached its 5 s limit');
      return sql.includes(PLAYER_GAMES) ? [{ team_id: 1610612760 }] : [];
    };
    try {
      // Counting the teams' rows across their join to the games: wrong whatever the teams' grain, so it is sent back,
      // without saying the teams have one row per team_id.
      const teamRows = `SELECT g.season, COUNT(t.team_id) AS teams FROM ${PLAYER_GAMES} g JOIN ${TEAMS} t ON g.team_id = t.team_id WHERE g.player_name ILIKE '%Kevin Durant%' GROUP BY g.season ORDER BY g.season`;
      const result = await ask(routeFor(reading, [teamRows, NAMES], prompts, freshRole('repeats-timeout')), question);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain(`it aggregates columns of ${TEAMS} across its join to ${PLAYER_GAMES}, which has several rows per team_id, so those totals can count each ${TEAMS} row more than once`);
      expect(prompts[1]).not.toContain('one row per team_id');
      // The names by season aggregate nothing of the teams: the join is not judged, it runs, and the check says which
      // key was not checked rather than that no join repeats rows.
      expect(result.status).toBe('completed');
      expect(result.answer).toContain('3 rows, starting with 2007 · Thunder; 2016 · Warriors; 2020 · Nets.');
      const fanout = (result.askPipelineReceipt?.checks ?? []).filter((check) => check.id === 'join_fanout');
      expect(fanout.map((check) => check.passed)).toEqual([false, true]);
      expect(fanout.at(-1)!.message).toBe('no join it could check multiplies the rows it totals; teams.team_id could not be checked for repeats (too slow, or not readable)');
    } finally {
      repeatRows = () => [];
    }
  });

  it('a repeat check that fails on both sides passes nothing and condemns nothing: the join is not judged', async () => {
    repeatRows = () => { throw new Error('statement reached its 5 s limit'); };
    try {
      const prompts: string[] = [];
      const result = await ask(routeFor(reading, [NAMES], prompts, freshRole('repeats-unknown')), question);
      expect(prompts).toHaveLength(1);
      expect(result.status).toBe('completed');
      const fanout = (result.askPipelineReceipt?.checks ?? []).filter((check) => check.id === 'join_fanout');
      expect(fanout.map((check) => check.passed)).toEqual([true]);
      expect(fanout[0]!.message).toBe('no join it could check multiplies the rows it totals; player_game_facts.team_id, teams.team_id could not be checked for repeats (too slow, or not readable)');
    } finally {
      repeatRows = () => [];
    }
  });

  it('SQL written from the words reads a stated year as the season the tables keep, and says so (V13, PO-2)', async () => {
    executed.length = 0;
    const prompts: string[] = [];
    const calendar = `SELECT COUNT(*) AS playoff_wins FROM ${TEAM_GAMES} f WHERE f.game_id LIKE '4%' AND EXTRACT(YEAR FROM f.game_date) = 2015 AND f.team_won AND f.team_nickname ILIKE '%Warriors%'`;
    const result = await ask(routeFor('I cannot read that.', [calendar], prompts), 'How many playoff games did the Warriors win in 2015?');
    expect(result.status).toBe('completed');
    const statement = executed.find((sql) => sql.includes('playoff_wins'))!;
    expect(statement).toContain('f.season = 2015');
    expect(statement).not.toMatch(/EXTRACT\(YEAR/i);
    expect(result.answer).toContain('Playoff wins: 15.');
    expect(result.answer).toContain('It reads 2015 as the 2015 season (SEASON 2015), not the calendar year of game_date.');
  });

  it('a question that says calendar year keeps the calendar year', async () => {
    executed.length = 0;
    const calendar = `SELECT COUNT(*) AS playoff_wins FROM ${TEAM_GAMES} f WHERE EXTRACT(YEAR FROM f.game_date) = 2015 AND f.team_won AND f.team_nickname ILIKE '%Warriors%'`;
    const result = await ask(routeFor('I cannot read that.', [calendar], []), 'How many games did the Warriors win in calendar year 2015?');
    expect(result.status).toBe('completed');
    expect(executed.find((sql) => sql.includes('playoff_wins'))).toMatch(/EXTRACT\(YEAR FROM f\.game_date\) = 2015/);
    expect(result.answer).not.toContain('2015 season');
  });
});
