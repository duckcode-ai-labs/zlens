import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage, AgentProvider, AgentRunRequest } from '@zlens/agent';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { createAskPipelineRouteExecutor } from './host.js';
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
const columns: Record<string, string[]> = {
  [PLAYER_SEASONS]: ['player_id', 'player_name', 'season', 'teams_played'],
  [PLAYER_GAMES]: ['game_id', 'game_date', 'season', 'team_id', 'player_id', 'player_name', 'points'],
  [TEAMS]: ['team_id', 'team_nickname', 'city'],
  [TEAM_GAMES]: ['game_id', 'game_date', 'season', 'team_id', 'team_nickname', 'team_won'],
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

describe('on the host: the Durant answer lists team names by season', () => {
  const connection = { driver: 'duckdb', path: ':memory:' } as ConnectionConfig;
  const manifest = { sources: Object.fromEntries(tables.map((table) => {
    const name = table.split('.').pop()!;
    return [name, { name, origin: 'dbt', referencedBy: [], dbtModel: { uniqueId: `model.nba.${name}`, schema: 'dev', columns: Object.fromEntries(columnsOf(table).map((column) => [column, { name: column }])) } }];
  })) };
  const executed: string[] = [];
  const routeFor = (reading: string, drafts: string[], prompts: string[]) => createAskPipelineRouteExecutor({
    projectRoot: '/tmp/ask-v14',
    executor: { executeQuery: vi.fn(async (sql: string) => {
      executed.push(sql);
      if (/HAVING COUNT\(\*\) > 1/.test(sql)) return { columns: [], rowCount: 0, executionTimeMs: 1, rows: [] };
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
    resolveConnection: async () => connection,
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
