import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { normalizeWarehouseCatalog, warehouseRelationId, type WarehouseCatalogRelationV1 } from '@zlens/core';
import { draftIdentityJoins } from './model-joins.js';
import { draftTablePicks } from './model-layers.js';
import { draftWordsAndRules } from './model-profile.js';
import { discoverWarehouseModel, validateWarehouseDiscovery, warehouseDiscoveryChanges } from './warehouse-model-discovery.js';

const relation = (name: string, columns: Record<string, string>): WarehouseCatalogRelationV1 => ({
  id: warehouseRelationId({ schema: 'main', name }),
  schema: 'main',
  name,
  relation: `main.${name}`,
  kind: 'table',
  columns: Object.entries(columns).map(([column, type]) => ({ name: column, type })),
});
const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** A league shaped like the NBA project: the traps its hand-built model wrote down, at a small size. */
function league() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE local_player_game_facts (game_id INTEGER, player_id INTEGER, team_id INTEGER, season INTEGER, game_date DATE, participated BOOLEAN, points INTEGER);
    CREATE TABLE local_team_game_facts (game_id INTEGER, team_id INTEGER, season INTEGER, game_date DATE, is_home BOOLEAN, team_points INTEGER);
    CREATE TABLE local_player_season_facts (player_id INTEGER, season INTEGER, total_points INTEGER);
    CREATE TABLE int_season_stats (player_id INTEGER, season INTEGER, total_points INTEGER);
    CREATE TABLE src_games (game_id INTEGER, season INTEGER, home_team_id INTEGER);
  `);
  const insert = {
    playerGame: db.prepare('INSERT INTO local_player_game_facts VALUES (?, ?, ?, ?, ?, ?, ?)'),
    teamGame: db.prepare('INSERT INTO local_team_game_facts VALUES (?, ?, ?, ?, ?, ?)'),
    game: db.prepare('INSERT INTO src_games VALUES (?, ?, ?)'),
  };
  let gameNumber = 0;
  for (let season = 2003; season <= 2010; season += 1) {
    // The latest season is partial.
    const games = season === 2010 ? 20 : 60;
    for (let game = 1; game <= games; game += 1) {
      gameNumber += 1;
      // The first digit is the game type: 1 preseason, 2 regular season, 4 playoffs.
      const type = game <= 5 ? 1 : game > 55 ? 4 : 2;
      const gameId = Number(`${type}0${String(season).slice(2)}${String(game).padStart(4, '0')}`);
      const date = game <= 40 ? `${season}-11-${String((game % 28) + 1).padStart(2, '0')}` : `${season + 1}-03-${String((game % 28) + 1).padStart(2, '0')}`;
      for (const [team, home] of [[10, 1], [20, 0]] as const) {
        insert.teamGame.run(gameId, team, season, date, home, 100);
        for (let seat = 1; seat <= 3; seat += 1) insert.playerGame.run(gameId, team + seat, team, season, date, (gameNumber + seat) % 10 === 0 ? 0 : 1, 10);
      }
      insert.game.run(gameId, season, 10);
    }
  }
  // Two games appear twice in the raw games.
  db.exec('INSERT INTO src_games SELECT * FROM src_games WHERE rowid <= 2');
  // Season totals add up every game, every game type included.
  db.exec(`
    INSERT INTO local_player_season_facts SELECT player_id, season, SUM(points) FROM local_player_game_facts GROUP BY player_id, season;
    INSERT INTO int_season_stats SELECT player_id, season, total_points FROM local_player_season_facts WHERE season BETWEEN 2006 AND 2008;
  `);
  const snapshot = normalizeWarehouseCatalog({
    version: 1,
    driver: 'sqlite',
    connectionId: 'default',
    scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }],
    capturedAt: '2026-11-04T00:00:00.000Z',
    relations: [
      relation('local_player_game_facts', { game_id: 'INTEGER', player_id: 'INTEGER', team_id: 'INTEGER', season: 'INTEGER', game_date: 'DATE', participated: 'BOOLEAN', points: 'INTEGER' }),
      relation('local_team_game_facts', { game_id: 'INTEGER', team_id: 'INTEGER', season: 'INTEGER', game_date: 'DATE', is_home: 'BOOLEAN', team_points: 'INTEGER' }),
      relation('local_player_season_facts', { player_id: 'INTEGER', season: 'INTEGER', total_points: 'INTEGER' }),
      relation('int_season_stats', { player_id: 'INTEGER', season: 'INTEGER', total_points: 'INTEGER' }),
      relation('src_games', { game_id: 'INTEGER', season: 'INTEGER', home_team_id: 'INTEGER' }),
    ],
  });
  return { db, snapshot };
}

describe('names, concepts and rules drafted from measured facts (RFC 0012, P3 and P4)', () => {
  const draft = async () => {
    const { db, snapshot } = league();
    const run = async (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>> });
    let report = await validateWarehouseDiscovery(discoverWarehouseModel({ snapshot, projectName: 'League' }), snapshot, run, quote, { dialect: 'sqlite' });
    report = await draftTablePicks(report, snapshot, run, quote);
    report = await draftIdentityJoins(report, snapshot, run, quote, { dialect: 'sqlite' });
    return draftWordsAndRules(report, snapshot, run, quote, { checkedAt: new Date('2026-11-04T12:00:00.000Z') });
  };

  it('names the picked tables for what a row is, and describes each from what was measured', async () => {
    const report = await draft();
    const entity = (table: string) => report.entities.find((item) => item.relation === `main.${table}`)!;
    // The layer prefix several tables share, and the `_facts` suffix, are not the name.
    expect(entity('local_player_game_facts')).toMatchObject({ id: 'player_game', businessName: 'Player game' });
    expect(entity('local_player_season_facts')).toMatchObject({ id: 'player_season', businessName: 'Player season' });
    expect(entity('local_team_game_facts')).toMatchObject({ id: 'team_game', businessName: 'Team game' });
    // A look-alike keeps its table's name and points at the pick by its new id.
    expect(entity('int_season_stats')).toMatchObject({ id: 'int_season_stats', useInstead: { entity: 'player_season' } });
    expect(entity('local_player_season_facts').description).toBe('One row per player_id, season: 48 rows; season 2003–2010; answer from this table rather than int_season_stats.');
    expect(entity('src_games').description).toMatch(/^One row per game_id, except 2 repeated rows: 442 rows; season 2003–2010\.$/);
    expect(report.relationships.map((item) => item.id)).toContain('player_game_to_team_game');
    // A key two tables share with no table of its own is a concept; game has its own table.
    expect(report.concepts).toEqual([{
      id: 'player', domain: 'league', name: 'Player',
      description: 'A player, identified by player_id in local_player_season_facts and local_player_game_facts. No table holds one row per player: list them from local_player_season_facts, one row per player_id, season.',
      bindings: [{ entity: 'player_season', role: 'canonical', grain: 'player_id, season' }, { entity: 'player_game', role: 'conformed', grain: 'game_id, player_id' }],
    }]);
  });

  it('writes the traps as rules whose numbers are what the saved queries returned', async () => {
    const report = await draft();
    const rule = (id: string) => report.rules!.find((item) => item.id === id)!;
    expect(report.rules!.map((item) => item.id).sort()).toEqual(['game_id_first_character', 'game_repeats', 'player_game_participated', 'player_season_sums_every_game_id', 'season_is_start_year', 'season_short_periods', 'team_game_rows_per_game_id']);

    expect(rule('player_game_participated')).toMatchObject({
      kind: 'custom',
      entities: ['player_game'],
      expression: 'In local_player_game_facts, 264 of 2,640 rows (10%) have participated = false and 2,376 have participated = true: filter on participated when a count or average should cover only one side.',
      evidence: { measured: { rows: 2640, participated_true: 2376, participated_false: 264 }, checkedAt: '2026-11-04T12:00:00.000Z' },
    });
    expect(rule('player_game_participated').evidence.query).toContain('FROM "main"."local_player_game_facts"');
    expect(rule('team_game_rows_per_game_id')).toMatchObject({
      kind: 'fanout',
      expression: 'local_team_game_facts has exactly 2 rows for every game_id (440 values), one per team_id: join it on game_id and team_id together, never on game_id alone; is_home = true picks one row per game_id.',
    });
    expect(rule('game_repeats').expression).toBe('src_games holds 442 rows for 440 distinct game_id: 2 rows repeat. Count with COUNT(DISTINCT game_id), or answer from a table that holds one row per key.');
    expect(rule('game_id_first_character').expression).toBe('Every game_id in local_player_game_facts has 8 characters, and the first one takes 3 values: 1 (240 rows), 2 (2,190 rows), 4 (210 rows). The first character is a code, such as a type: filter on it with CAST(game_id AS VARCHAR) LIKE \'2%\'.');
    expect(rule('season_is_start_year').expression).toMatch(/^season is the year a season starts: in local_player_game_facts, season \d{4} runs from \d{4}-11-\d\d to \d{4}-03-\d\d \(7 of 8 seasons span two calendar years this way\)\./);
    // The playoff rows (game id 4…) all fall in the next calendar year (RFC 0012, F2).
    expect(rule('season_is_start_year').expression).toContain('Rows whose game_id starts with 4 (210 rows) all fall in the calendar year after their season (season 2006\'s 4 rows run 2007-03-01 to 2007-03-05): for those rows, calendar year Y is season Y − 1, so the 4 rows of 2007 are season 2006.');
    // Season totals add up every game type: for one, sum the game rows (F2).
    expect(rule('player_season_sums_every_game_id')).toMatchObject({
      entities: ['player_season', 'player_game'],
      expression: 'local_player_season_facts adds up every row of local_player_game_facts, every first character of game_id included: total_points totals 26,400, as points does in local_player_game_facts. For one kind (one first character of game_id), sum local_player_game_facts filtered on it: CAST(game_id AS VARCHAR) LIKE \'2%\' gives 21,900.',
      evidence: { measured: { summary_total: 26400, detail_total: 26400, first_2_total: 21900 } },
    });
    expect(rule('season_short_periods').expression).toBe('In local_player_game_facts, a typical season holds 360 rows (8 seasons, 2003–2010); 2010 holds 33% (the latest, through 2010-11-21). Compare those seasons with care.');
  });

  it('applies concepts and rules as drafts a person reviews, and never redrafts one already in the model', async () => {
    const report = await draft();
    const changes = warehouseDiscoveryChanges(report);
    expect(changes.find((change) => change.operation === 'upsert_concept')?.value).toMatchObject({ id: 'player', status: 'draft', origin: 'ai_draft' });
    expect(changes.find((change) => change.operation === 'upsert_rule' && change.value.id === 'game_repeats')?.value).toMatchObject({ status: 'draft', kind: 'custom', entities: ['game'], evidence: { measured: { repeated_rows: 2 } } });

    const { db, snapshot } = league();
    const run = async (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>> });
    const again = await draftWordsAndRules(await draftIdentityJoins(await draftTablePicks(await validateWarehouseDiscovery(discoverWarehouseModel({ snapshot, projectName: 'League' }), snapshot, run, quote), snapshot, run, quote), snapshot, run, quote), snapshot, run, quote, {
      existing: { rules: new Set(['league::rule::game_repeats']), concepts: new Set(['league::concept::player']) },
    });
    expect(again.rules?.some((item) => item.id === 'game_repeats')).toBe(false);
    expect(again.concepts).toBeUndefined();
  });
});
