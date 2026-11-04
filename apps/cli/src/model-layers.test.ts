import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { normalizeWarehouseCatalog, warehouseRelationId, type WarehouseCatalogRelationV1 } from '@zlens/core';
import { canonicalColumn, columnVocabulary, draftTablePicks, findRowIdentity, projectionSource, tableLayer } from './model-layers.js';
import { discoverWarehouseModel, warehouseDiscoveryChanges } from './warehouse-model-discovery.js';

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
const runOn = (db: Database.Database) => async (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>> });

describe('a table’s layer', () => {
  const plain = relation('orders', { order_id: 'INTEGER' });
  it('reads dbt first, then snapshot columns, the dbt folder, the name prefix and the schema', () => {
    const dbt = { uniqueId: 'source.shop.raw.orders', dependsOn: [], uniqueTests: [], tests: 0, exposures: 0 };
    expect(tableLayer(plain, { dbt: { ...dbt, resourceType: 'source' } })).toEqual({ layer: 'raw', evidence: 'a dbt source' });
    expect(tableLayer(relation('customers_history', { id: 'INTEGER', dbt_valid_from: 'TIMESTAMP', dbt_valid_to: 'TIMESTAMP' })).layer).toBe('snapshot');
    expect(tableLayer(plain, { dbt: { ...dbt, resourceType: 'model', path: 'models/staging/shop/orders.sql' } })).toEqual({ layer: 'staging', evidence: 'in the dbt folder staging/' });
    expect(tableLayer(plain, { dbt: { ...dbt, resourceType: 'model', path: 'models/marts/finance/orders.sql' } }).layer).toBe('final');
    expect(tableLayer(relation('int_orders_joined', { order_id: 'INTEGER' }))).toEqual({ layer: 'intermediate', evidence: 'named int_…' });
    expect(tableLayer({ ...plain, schema: 'raw' })).toEqual({ layer: 'raw', evidence: 'in the raw schema' });
    expect(tableLayer(plain, { copyOf: { name: 'raw_orders', layer: 'raw' } })).toEqual({ layer: 'staging', evidence: 'a view that renames raw_orders' });
    expect(tableLayer(plain)).toEqual({ layer: 'final', evidence: 'nothing marks it as raw, staging or intermediate' });
  });
});

describe('a view that only renames one table', () => {
  it('follows common table expressions to the table read, and gives up on joins and aggregates', () => {
    expect(projectionSource('CREATE VIEW t.dim_players AS WITH players AS (SELECT * FROM db.t.src_players) SELECT PLAYER_ID, CAST(SEASON AS INTEGER) AS SEASON FROM players;')).toBe('db.t.src_players');
    expect(projectionSource("SELECT a, CASE WHEN regexp_matches(b, '^[0-9]+$') THEN 1 END AS b FROM raw.teams WHERE a IS NOT NULL")).toBe('raw.teams');
    expect(projectionSource('SELECT DISTINCT season FROM games')).toBeUndefined();
    expect(projectionSource('SELECT season, min(d) FROM games GROUP BY season')).toBeUndefined();
    expect(projectionSource('SELECT * FROM a JOIN b ON a.id = b.id')).toBeUndefined();
  });
});

describe('canonical column names', () => {
  const vocabulary = columnVocabulary([
    relation('player_games', { game_id: 'INTEGER', player_id: 'INTEGER', team_id: 'INTEGER', season: 'INTEGER' }),
    relation('src_games_details', { details_game_id: 'INTEGER', player_id: 'INTEGER', home_team_id: 'INTEGER' }),
    relation('games', { game_id: 'INTEGER', season: 'INTEGER', home_team_id: 'INTEGER' }),
    relation('seasons', { season_id: 'INTEGER' }),
    relation('customers', { customer_id: 'INTEGER' }),
    relation('orders', { customer_id: 'INTEGER' }),
  ]);
  it('drops a prefix that names a table, keeps a role, and reads a bare id as the table’s own', () => {
    expect(canonicalColumn('DETAILS_GAME_ID', vocabulary)).toBe('game_id');
    expect(canonicalColumn('home_team_id', vocabulary)).toBe('home_team_id');
    expect(canonicalColumn('season_id', vocabulary)).toBe('season');
    expect(canonicalColumn('id', vocabulary, 'raw_customers')).toBe('customer_id');
    expect(canonicalColumn('id', vocabulary, 'raw_orders')).toBe('order_id');
  });
});

describe('what one row is, found on the data', () => {
  it('finds the fewest unique columns, keys before dates, and reports near keys with their repeats', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE lines (game_id INTEGER, player_id INTEGER, game_date DATE, points INTEGER)');
    const insert = db.prepare('INSERT INTO lines VALUES (?, ?, ?, ?)');
    for (let game = 1; game <= 300; game += 1) for (let player = 1; player <= 2; player += 1) insert.run(game, player, `2020-01-${String((game % 28) + 1).padStart(2, '0')}`, game);
    const lines = relation('lines', { game_id: 'INTEGER', player_id: 'INTEGER', game_date: 'DATE', points: 'INTEGER' });
    expect(await findRowIdentity(lines, runOn(db), quote)).toEqual({ columns: ['game_id', 'player_id'], rows: 600, duplicates: 0, source: 'searched' });
    insert.run(5, 1, '2020-01-06', 5);
    insert.run(6, 2, '2020-01-07', 6);
    expect(await findRowIdentity(lines, runOn(db), quote)).toMatchObject({ columns: ['game_id', 'player_id'], rows: 602, duplicates: 2 });
  });

  it('checks a declared key first, and falls back to a text label only when nothing else identifies a row', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE standings (season_id INTEGER, standings_date DATE, team VARCHAR, w INTEGER)');
    const insert = db.prepare('INSERT INTO standings VALUES (?, ?, ?, ?)');
    for (let day = 1; day <= 20; day += 1) for (const team of ['Hawks', 'Celtics', 'Nets']) insert.run(2020, `2020-02-${String(day).padStart(2, '0')}`, team, day);
    const standings = relation('standings', { season_id: 'INTEGER', standings_date: 'DATE', team: 'VARCHAR', w: 'INTEGER' });
    expect(await findRowIdentity(standings, runOn(db), quote)).toMatchObject({ columns: ['standings_date', 'team'], duplicates: 0 });
    expect(await findRowIdentity(standings, runOn(db), quote, { hints: [{ columns: ['standings_date', 'team'], source: 'dbt_test' }] })).toMatchObject({ source: 'dbt_test' });
  });
});

describe('one table per business thing', () => {
  const build = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE player_game_facts (game_id INTEGER, player_id INTEGER, team_id INTEGER, season INTEGER, player_name VARCHAR, points INTEGER);
      CREATE TABLE raw_box (game_id INTEGER, player_id INTEGER, pts INTEGER);
      CREATE VIEW stg_box AS SELECT game_id, player_id, pts AS points FROM raw_box;
      CREATE TABLE player_season_facts (player_id INTEGER, season INTEGER, total_points INTEGER);
      CREATE TABLE old_season_stats (player_id INTEGER, season INTEGER, total_points INTEGER);
      CREATE TABLE roster (player_id INTEGER, team_id INTEGER, season INTEGER, player_name VARCHAR);
      CREATE TABLE customers (customer_id INTEGER, name VARCHAR);
      CREATE TABLE customer_metrics (customer_id INTEGER, lifetime_value INTEGER);
      CREATE TABLE scd_customers (customer_id INTEGER, name VARCHAR, dbt_valid_from TIMESTAMP, dbt_valid_to TIMESTAMP);
      CREATE TABLE daily_revenue (day DATE, revenue INTEGER);
      CREATE TABLE daily_signups (day DATE, signups INTEGER);
    `);
    const team = (player: number) => (player === 3 ? 20 : 10);
    for (let game = 1; game <= 200; game += 1) {
      for (let player = 1; player <= 3; player += 1) {
        db.prepare('INSERT INTO player_game_facts VALUES (?, ?, ?, ?, ?, ?)').run(game, player, team(player), 2003 + (game % 8), `P${player}`, game);
        db.prepare('INSERT INTO raw_box VALUES (?, ?, ?)').run(game, player, game);
      }
    }
    db.prepare('INSERT INTO raw_box VALUES (?, ?, ?)').run(7, 1, 7);
    for (let season = 2003; season <= 2010; season += 1) {
      for (let player = 1; player <= 3; player += 1) {
        db.prepare('INSERT INTO player_season_facts VALUES (?, ?, ?)').run(player, season, 100);
        if (season >= 2006 && season <= 2008) {
          db.prepare('INSERT INTO old_season_stats VALUES (?, ?, ?)').run(player, season, 100);
          db.prepare('INSERT INTO roster VALUES (?, ?, ?, ?)').run(player, team(player), season, `P${player}`);
        }
      }
    }
    // A traded player: two rows for one season.
    db.prepare('INSERT INTO roster VALUES (?, ?, ?, ?)').run(3, 10, 2007, 'P3');
    for (let customer = 1; customer <= 10; customer += 1) {
      db.prepare('INSERT INTO customers VALUES (?, ?)').run(customer, `C${customer}`);
      if (customer <= 6) db.prepare('INSERT INTO customer_metrics VALUES (?, ?)').run(customer, customer * 10);
      db.prepare('INSERT INTO scd_customers VALUES (?, ?, ?, NULL)').run(customer, `C${customer}`, '2024-01-01');
    }
    db.prepare('INSERT INTO scd_customers VALUES (?, ?, ?, ?)').run(1, 'Old name', '2023-01-01', '2024-01-01');
    for (let day = 1; day <= 20; day += 1) {
      db.prepare('INSERT INTO daily_revenue VALUES (?, ?)').run(`2024-03-${String(day).padStart(2, '0')}`, day);
      if (day <= 10) db.prepare('INSERT INTO daily_signups VALUES (?, ?)').run(`2024-03-${String(day).padStart(2, '0')}`, day);
    }
    const snapshot = normalizeWarehouseCatalog({
      version: 1,
      driver: 'sqlite',
      connectionId: 'default',
      scopes: [{ catalogOrDatabase: 'main', schemas: ['main'] }],
      capturedAt: '2026-11-04T00:00:00.000Z',
      relations: [
        relation('player_game_facts', { game_id: 'INTEGER', player_id: 'INTEGER', team_id: 'INTEGER', season: 'INTEGER', player_name: 'VARCHAR', points: 'INTEGER' }),
        relation('raw_box', { game_id: 'INTEGER', player_id: 'INTEGER', pts: 'INTEGER' }),
        relation('stg_box', { game_id: 'INTEGER', player_id: 'INTEGER', points: 'INTEGER' }, { kind: 'view', viewSql: 'CREATE VIEW stg_box AS SELECT game_id, player_id, pts AS points FROM raw_box' }),
        relation('player_season_facts', { player_id: 'INTEGER', season: 'INTEGER', total_points: 'INTEGER' }),
        relation('old_season_stats', { player_id: 'INTEGER', season: 'INTEGER', total_points: 'INTEGER' }),
        relation('roster', { player_id: 'INTEGER', team_id: 'INTEGER', season: 'INTEGER', player_name: 'VARCHAR' }),
        relation('customers', { customer_id: 'INTEGER', name: 'VARCHAR' }),
        relation('customer_metrics', { customer_id: 'INTEGER', lifetime_value: 'INTEGER' }),
        relation('scd_customers', { customer_id: 'INTEGER', name: 'VARCHAR', dbt_valid_from: 'TIMESTAMP', dbt_valid_to: 'TIMESTAMP' }),
        relation('daily_revenue', { day: 'DATE', revenue: 'INTEGER' }),
        relation('daily_signups', { day: 'DATE', signups: 'INTEGER' }),
      ],
    });
    return { db, snapshot };
  };

  it('proposes one table per group, with a measured reason for every other one', async () => {
    const { db, snapshot } = build();
    const report = await draftTablePicks(discoverWarehouseModel({ snapshot, projectName: 'League' }), snapshot, runOn(db), quote);
    const entity = (name: string) => report.entities.find((item) => item.relation === `main.${name}`)!;

    expect(entity('player_game_facts')).toMatchObject({ layer: 'final', grain: 'game_id, player_id', identity: { duplicates: 0 } });
    expect(entity('player_game_facts').useInstead).toBeUndefined();
    expect(entity('raw_box')).toMatchObject({ layer: 'raw', identity: { columns: ['game_id', 'player_id'], duplicates: 1 } });
    expect(entity('raw_box').grain).toBeUndefined();
    expect(entity('raw_box').useInstead).toMatchObject({ relation: 'main.player_game_facts', reason: '1 row repeat on game_id, player_id; player_game_facts has none' });
    expect(entity('stg_box')).toMatchObject({ layer: 'staging', useInstead: { relation: 'main.player_game_facts' } });

    // An older table covering fewer seasons.
    expect(entity('old_season_stats').useInstead).toEqual({ entity: 'player_season_fact', domain: 'league', relation: 'main.player_season_facts', reason: 'covers season 2006–2008; player_season_facts covers season 2003–2010' });
    // A roster for three seasons, where player games hold the same players and teams for eight.
    expect(entity('roster')).toMatchObject({ identity: { columns: ['player_id', 'team_id', 'season'] } });
    expect(entity('roster').useInstead).toMatchObject({ relation: 'main.player_game_facts', reason: 'covers season 2006–2008; player_game_facts holds the same player_id, team_id, season for 2003–2010' });

    // Fewer rows alone is not a worse copy: metrics for some customers stay beside all customers.
    expect(entity('customers').useInstead).toBeUndefined();
    expect(entity('customer_metrics').useInstead).toBeUndefined();
    // History is read on its current rows, and points at the current table.
    expect(entity('scd_customers')).toMatchObject({ layer: 'snapshot', identity: { columns: ['customer_id'], rows: 10 } });
    expect(entity('scd_customers').useInstead).toMatchObject({ relation: 'main.customers', reason: 'a history table (has dbt_valid_from and dbt_valid_to); customers holds the current rows' });
    // Two daily tables are not the same thing because both are daily.
    expect(entity('daily_signups').useInstead).toBeUndefined();
    expect(report.lookAlikes?.some((group) => group.members.some((member) => member.relation === 'main.daily_signups'))).toBe(false);

    const customers = report.lookAlikes!.find((group) => group.members.some((member) => member.relation === 'main.customer_metrics'))!;
    expect(customers.members.filter((member) => member.verdict === 'pick').map((member) => member.relation).sort()).toEqual(['main.customer_metrics', 'main.customers']);

    // Applying the draft writes each pick on the entity, still a draft.
    const changes = warehouseDiscoveryChanges(report);
    const old = changes.find((change) => change.operation === 'upsert_entity' && change.value.id === 'old_season_stat');
    expect(old?.value).toMatchObject({ status: 'draft', useInstead: { entity: 'player_season_fact', reason: 'covers season 2006–2008; player_season_facts covers season 2003–2010' } });
  });
});
