import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { normalizeWarehouseCatalog, warehouseRelationId, type WarehouseCatalogRelationV1 } from '@zlens/core';
import { draftIdentityJoins } from './model-joins.js';
import { draftTablePicks } from './model-layers.js';
import { discoverWarehouseModel, validateWarehouseDiscovery } from './warehouse-model-discovery.js';

const relation = (name: string, columns: Record<string, string>, extra: Partial<WarehouseCatalogRelationV1> = {}): WarehouseCatalogRelationV1 => ({
  id: warehouseRelationId({ schema: 'main', name }),
  schema: 'main',
  name,
  relation: `main.${name}`,
  kind: 'table',
  columns: Object.entries(columns).map(([column, type]) => ({ name: column, type })),
  ...extra,
});
const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

describe('joins drafted from row identity', () => {
  const build = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE player_games (game_id INTEGER, player_id INTEGER, team_id INTEGER, opponent_team_id INTEGER, season INTEGER, points INTEGER);
      CREATE TABLE team_games (game_id INTEGER, team_id INTEGER, opponent_team_id INTEGER, season INTEGER, team_points INTEGER);
      CREATE TABLE teams (team_id INTEGER, city VARCHAR);
      CREATE TABLE src_teams (team_id INTEGER, city VARCHAR);
      CREATE TABLE seasons (season_id INTEGER, label VARCHAR);
      CREATE TABLE awards (award_id INTEGER, player_id INTEGER, season INTEGER, team_id INTEGER);
    `);
    // Two teams play every game; three players each.
    for (let game = 1; game <= 100; game += 1) {
      const season = 2003 + (game % 5);
      for (const [team, opponent] of [[10, 20], [20, 10]] as const) {
        db.prepare('INSERT INTO team_games VALUES (?, ?, ?, ?, ?)').run(game, team, opponent, season, game);
        for (let player = 1; player <= 3; player += 1) db.prepare('INSERT INTO player_games VALUES (?, ?, ?, ?, ?, ?)').run(game, team + player, team, opponent, season, player);
      }
    }
    for (const team of [10, 20]) {
      db.prepare('INSERT INTO teams VALUES (?, ?)').run(team, `City ${team}`);
      db.prepare('INSERT INTO src_teams VALUES (?, ?)').run(team, `City ${team}`);
    }
    for (let season = 2003; season <= 2007; season += 1) db.prepare('INSERT INTO seasons VALUES (?, ?)').run(season, `${season}-${season + 1}`);
    // Awards name teams that are mostly not in the league: no join.
    for (let award = 1; award <= 20; award += 1) db.prepare('INSERT INTO awards VALUES (?, ?, ?, ?)').run(award, 11, 2004, award < 18 ? 99 : 10);
    const snapshot = normalizeWarehouseCatalog({
      version: 1,
      driver: 'sqlite',
      connectionId: 'default',
      scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }],
      capturedAt: '2026-11-04T00:00:00.000Z',
      relations: [
        relation('player_games', { game_id: 'INTEGER', player_id: 'INTEGER', team_id: 'INTEGER', opponent_team_id: 'INTEGER', season: 'INTEGER', points: 'INTEGER' }),
        relation('team_games', { game_id: 'INTEGER', team_id: 'INTEGER', opponent_team_id: 'INTEGER', season: 'INTEGER', team_points: 'INTEGER' }),
        relation('teams', { team_id: 'INTEGER', city: 'VARCHAR' }),
        relation('src_teams', { team_id: 'INTEGER', city: 'VARCHAR' }),
        relation('seasons', { season_id: 'INTEGER', label: 'VARCHAR' }),
        relation('awards', { award_id: 'INTEGER', player_id: 'INTEGER', season: 'INTEGER', team_id: 'INTEGER' }),
      ],
    });
    return { db, snapshot };
  };

  it('drafts joins on several columns, through roles, to a period table and to itself, each checked on the warehouse', async () => {
    const { db, snapshot } = build();
    const run = async (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>> });
    // The order discovery runs them in: name and key checks, table picks, then identity joins.
    const validated = await validateWarehouseDiscovery(discoverWarehouseModel({ snapshot, projectName: 'League' }), snapshot, run, quote, { dialect: 'sqlite' });
    const picked = await draftTablePicks(validated, snapshot, run, quote);
    const report = await draftIdentityJoins(picked, snapshot, run, quote, { dialect: 'sqlite' });
    const joins = report.relationships.map((item) => `${item.fromRelation.split('.').pop()} → ${item.toRelation.split('.').pop()} on ${item.keys.map((pair) => `${pair.from}=${pair.to}`).join(', ')} · ${item.cardinality}`).sort();

    expect(joins).toContain('player_games → team_games on game_id=game_id, team_id=team_id · many_to_one');
    expect(joins).toContain('player_games → teams on team_id=team_id · many_to_one');
    expect(joins).toContain('player_games → teams on opponent_team_id=team_id · many_to_one');
    expect(joins).toContain('player_games → seasons on season=season_id · many_to_one');
    // The opponent's line of the same game.
    expect(joins).toContain('team_games → team_games on game_id=game_id, opponent_team_id=team_id · one_to_one');
    // A role on a key of several columns elsewhere is a second way to the same rows: not drafted.
    expect(joins).not.toContain('player_games → team_games on game_id=game_id, opponent_team_id=team_id · many_to_one');
    // Most awards name a team that is not there: no join.
    expect(joins.some((join) => join.startsWith('awards → teams'))).toBe(false);
    // The staging copy of teams joins nothing: the pick holds its rows.
    expect(joins.some((join) => join.includes('src_teams'))).toBe(false);

    const opponent = report.relationships.find((item) => item.id === 'team_game_to_opponent_team_game')!;
    expect(opponent).toMatchObject({ fanout: 'safe', validation: { status: 'passed' } });
    expect(opponent.evidence).toEqual([{ source: 'row_identity', reason: 'team_games is one row per game_id, team_id, and 200 of 200 team_games rows find their game_id, opponent_team_id there (as the opponent)' }]);
    expect(report.relationships.find((item) => item.id === 'player_game_to_opponent_teams')).toMatchObject({ keys: [{ from: 'opponent_team_id', to: 'team_id' }] });
  });

  it('leaves out a drafted join that touches a look-alike, and says which pick to use', async () => {
    const { db, snapshot } = build();
    const run = async (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>> });
    const picked = await draftTablePicks(discoverWarehouseModel({ snapshot, projectName: 'League' }), snapshot, run, quote);
    const withStagingJoin = {
      ...picked,
      relationships: [...picked.relationships, {
        id: 'team_game_to_staging_team', domain: 'league', from: 'team_game', to: 'team', fromDomain: 'league', toDomain: 'league',
        fromRelation: 'main.team_games', toRelation: 'main.src_teams', keys: [{ from: 'team_id', to: 'team_id' }],
        evidence: [{ source: 'same_name' as const, reason: 'team_id is named for src_teams' }], cardinality: 'many_to_one' as const, fanout: 'safe' as const,
      }],
    };
    const report = await draftIdentityJoins(withStagingJoin, snapshot, run, quote, { dialect: 'sqlite' });
    expect(report.relationships.some((item) => item.id === 'team_game_to_staging_team')).toBe(false);
    expect(report.lookAlikeJoins).toContainEqual({ from: 'team_game', to: 'team', keys: [{ from: 'team_id', to: 'team_id' }], reason: 'joins src_teams, and the draft says to use teams instead' });
  });
});
