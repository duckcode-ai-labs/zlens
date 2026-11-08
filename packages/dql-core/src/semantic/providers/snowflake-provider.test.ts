import { describe, expect, it } from 'vitest';
import { SemanticLayer } from '../semantic-layer.js';
import { addSnowflakeSemanticView, semanticViewObjects } from './snowflake-provider.js';

/** `DESC SEMANTIC VIEW NBA.TRANSFORMED.NBA_TEAM_SEASONS`, as Snowflake returned it (live, 2026-11-07). */
const row = (object_kind: string | null, object_name: string | null, parent_entity: string | null, property: string, property_value: string) => ({ object_kind, object_name, parent_entity, property, property_value });
const DESC = [
  row(null, null, null, 'COMMENT', 'NBA team seasons: wins and points by team and season'),
  row('TABLE', 'SEASONS', null, 'BASE_TABLE_DATABASE_NAME', 'NBA'),
  row('TABLE', 'SEASONS', null, 'BASE_TABLE_SCHEMA_NAME', 'TRANSFORMED'),
  row('TABLE', 'SEASONS', null, 'BASE_TABLE_NAME', 'LOCAL_TEAM_SEASON_FACTS'),
  row('TABLE', 'SEASONS', null, 'PRIMARY_KEY', '["TEAM_ID","SEASON"]'),
  row('TABLE', 'SEASONS', null, 'COMMENT', 'One row per team per season (regular season and playoffs)'),
  row('RELATIONSHIP', 'SEASON_TEAM', 'SEASONS', 'TABLE', 'SEASONS'),
  row('RELATIONSHIP', 'SEASON_TEAM', 'SEASONS', 'REF_TABLE', 'TEAMS'),
  row('RELATIONSHIP', 'SEASON_TEAM', 'SEASONS', 'FOREIGN_KEY', '["TEAM_ID"]'),
  row('RELATIONSHIP', 'SEASON_TEAM', 'SEASONS', 'REF_KEY', '["TEAM_ID"]'),
  row('METRIC', 'GAMES_PLAYED', 'SEASONS', 'TABLE', 'SEASONS'),
  row('METRIC', 'GAMES_PLAYED', 'SEASONS', 'EXPRESSION', 'SUM(GAMES_PLAYED)'),
  row('METRIC', 'GAMES_PLAYED', 'SEASONS', 'DATA_TYPE', 'NUMBER(30,0)'),
  row('METRIC', 'GAMES_PLAYED', 'SEASONS', 'ACCESS_MODIFIER', 'PUBLIC'),
  row('FACT', 'POINTS_SCORED', 'SEASONS', 'TABLE', 'SEASONS'),
  row('FACT', 'POINTS_SCORED', 'SEASONS', 'EXPRESSION', 'TOTAL_POINTS'),
  row('FACT', 'POINTS_SCORED', 'SEASONS', 'DATA_TYPE', 'FLOAT'),
  row('METRIC', 'POINTS_TOTAL', 'SEASONS', 'EXPRESSION', 'SUM(seasons.points_scored)'),
  row('METRIC', 'POINTS_TOTAL', 'SEASONS', 'COMMENT', 'Points scored'),
  row('DIMENSION', 'SEASON', 'SEASONS', 'EXPRESSION', 'SEASON'),
  row('DIMENSION', 'SEASON', 'SEASONS', 'DATA_TYPE', 'NUMBER(38,0)'),
  row('DIMENSION', 'SEASON', 'SEASONS', 'COMMENT', 'The year the season starts'),
  row('METRIC', 'TOTAL_WINS', 'SEASONS', 'EXPRESSION', 'SUM(WINS)'),
  row('METRIC', 'TOTAL_WINS', 'SEASONS', 'COMMENT', 'Games won'),
  row('METRIC', 'WIN_RATE', 'SEASONS', 'EXPRESSION', 'seasons.total_wins / NULLIF(seasons.games_played, 0)'),
  row('METRIC', 'WIN_RATE', 'SEASONS', 'COMMENT', 'Share of games won'),
  row('TABLE', 'TEAMS', null, 'BASE_TABLE_DATABASE_NAME', 'NBA'),
  row('TABLE', 'TEAMS', null, 'BASE_TABLE_SCHEMA_NAME', 'RAW'),
  row('TABLE', 'TEAMS', null, 'BASE_TABLE_NAME', 'RAW_TEAMS'),
  row('TABLE', 'TEAMS', null, 'PRIMARY_KEY', '["TEAM_ID"]'),
  row('DIMENSION', 'CITY', 'TEAMS', 'EXPRESSION', 'CITY'),
  row('DIMENSION', 'CITY', 'TEAMS', 'DATA_TYPE', 'VARCHAR(16777216)'),
  row('DIMENSION', 'TEAM_NAME', 'TEAMS', 'EXPRESSION', 'NICKNAME'),
  row('DIMENSION', 'TEAM_NAME', 'TEAMS', 'DATA_TYPE', 'VARCHAR(16777216)'),
  row('DIMENSION', 'TEAM_NAME', 'TEAMS', 'COMMENT', 'Team nickname, e.g. Warriors'),
  row('METRIC', 'EVERY_TEAM_POINTS', 'SEASONS', 'EXPRESSION', 'SUM(teams.ARENACAPACITY) + SUM(seasons.points_scored)'),
];
const view = { name: 'NBA_TEAM_SEASONS', databaseName: 'NBA', schemaName: 'TRANSFORMED' };

describe('Snowflake semantic views (DESC SEMANTIC VIEW, live format)', () => {
  it('groups the property rows back into objects', () => {
    const { comment, objects } = semanticViewObjects(DESC);
    expect(comment).toBe('NBA team seasons: wins and points by team and season');
    expect(objects.filter((object) => object.kind === 'TABLE').map((object) => object.name)).toEqual(['SEASONS', 'TEAMS']);
    expect(objects.find((object) => object.name === 'WIN_RATE')).toMatchObject({ kind: 'METRIC', parent: 'SEASONS', props: { EXPRESSION: 'seasons.total_wins / NULLIF(seasons.games_played, 0)' } });
  });

  it('imports tables over their base tables, the relationship as a join, dimensions, and runnable metrics', () => {
    const layer = new SemanticLayer();
    const notes = addSnowflakeSemanticView(layer, view, DESC);
    expect(layer.getCube('nba_team_seasons_seasons')).toMatchObject({ table: 'NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS', joins: [{ right: 'nba_team_seasons_teams', sql: '${left}.TEAM_ID = ${right}.TEAM_ID' }] });
    expect(layer.getSemanticModel('nba_team_seasons_seasons')?.entities).toEqual(['nba_team_seasons_seasons.team_id', 'nba_team_seasons_seasons.season']);
    expect(layer.getMetric('total_wins')).toMatchObject({ sql: 'WINS', type: 'sum', table: 'NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS', description: 'Games won' });
    // A fact is expanded into its expression.
    expect(layer.getMetric('points_total')).toMatchObject({ sql: '(TOTAL_POINTS)', type: 'sum' });
    expect(layer.getMetric('win_rate')).toMatchObject({
      metricType: 'ratio', typeParams: { numerator: { name: 'total_wins' }, denominator: { name: 'games_played' } },
    });
    expect(layer.getDimension('team_name')).toMatchObject({ sql: 'NICKNAME', cube: 'nba_team_seasons_teams', description: 'Team nickname, e.g. Warriors' });
    expect(layer.getDimension('season')).toMatchObject({ sql: 'SEASON', type: 'number' });
    expect(notes).toEqual(['metric EVERY_TEAM_POINTS (SUM(teams.ARENACAPACITY) + SUM(seasons.points_scored)) is not an aggregate of one table or arithmetic over metrics: left out']);
  });

  it('a metric by a dimension of the related table compiles to SQL over the base tables, joined on the relationship', () => {
    const layer = new SemanticLayer();
    addSnowflakeSemanticView(layer, view, DESC);
    const composed = layer.composeQuery({ metrics: ['total_wins'], dimensions: ['team_name'], driver: 'snowflake' });
    expect(composed?.sql).toMatch(/SUM\(.*WINS.*\)/i);
    expect(composed?.sql).toContain('NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS');
    expect(composed?.sql).toContain('NBA.RAW.RAW_TEAMS');
    expect(composed?.sql).toMatch(/TEAM_ID\s*=\s*.*TEAM_ID/);
    const ratio = layer.composeQuery({ metrics: ['win_rate'], dimensions: ['team_name'], driver: 'snowflake' });
    expect(ratio?.sql).toMatch(/NULLIF/i);
    if (process.env.PRINT_SQL) console.log(`${composed?.sql}\n---\n${ratio?.sql}`);
  });

  it('a top-N by a metric ranks the largest value first on Snowflake, never an empty one', () => {
    const layer = new SemanticLayer();
    addSnowflakeSemanticView(layer, view, DESC);
    const top = layer.composeQuery({ metrics: ['total_wins'], dimensions: ['team_name'], orderBy: [{ name: 'total_wins', direction: 'desc' }], limit: 5, driver: 'snowflake' });
    expect(top?.sql).toMatch(/ORDER BY total_wins DESC NULLS LAST\s+LIMIT 5$/);
    const onDuckDb = layer.composeQuery({ metrics: ['total_wins'], dimensions: ['team_name'], orderBy: [{ name: 'total_wins', direction: 'desc' }], limit: 5, driver: 'duckdb' });
    expect(onDuckDb?.sql).toMatch(/ORDER BY total_wins DESC\s+LIMIT 5$/);
  });
});
