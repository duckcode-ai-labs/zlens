import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { SnowflakeSemanticProvider } from '@zlens/core';
import { profileRelationshipOnWarehouse } from '@zlens/agent';
import { readWarehouseCatalogRelations } from './warehouse-catalog-sync.js';

/**
 * ZLens on a real Snowflake account: the NBA benchmark as dql-benchmarks
 * nba/snowflake sets it up (database NBA: RAW, TRANSFORMED, DEV, and the
 * semantic view NBA_TEAM_SEASONS), read as the read-only key-pair user a
 * customer would create. Skipped unless ZLENS_TEST_SNOWFLAKE_ACCOUNT and
 * ZLENS_TEST_SNOWFLAKE_KEY_PATH are set; ZLENS_TEST_SNOWFLAKE_CONNECTOR_ROOT
 * names a folder with snowflake-sdk installed. Each case is a bug found on the
 * first live run (2026-11-07).
 */
const account = process.env.ZLENS_TEST_SNOWFLAKE_ACCOUNT?.trim();
const keyPath = process.env.ZLENS_TEST_SNOWFLAKE_KEY_PATH?.trim();
const connectorRoot = process.env.ZLENS_TEST_SNOWFLAKE_CONNECTOR_ROOT?.trim();
const live = account && keyPath ? it : it.skip;

const connection: ConnectionConfig = {
  driver: 'snowflake',
  account: account ?? '',
  username: process.env.ZLENS_TEST_SNOWFLAKE_USER?.trim() || 'ZLENS_APP_SVC',
  authMethod: 'key_pair',
  privateKeyPath: keyPath ?? '',
  warehouse: process.env.ZLENS_TEST_SNOWFLAKE_WAREHOUSE?.trim() || 'ZLENS_BENCH_WH',
  database: 'NBA',
  schema: 'TRANSFORMED',
  role: process.env.ZLENS_TEST_SNOWFLAKE_ROLE?.trim() || 'ZLENS_READER',
  ...(connectorRoot ? { moduleSearchPaths: [connectorRoot] } : {}),
} as ConnectionConfig;

const executor = new QueryExecutor();
const rows = async (sql: string) => (await executor.executePositional(sql, [], connection)).rows as Array<Record<string, unknown>>;
afterAll(async () => { await executor.disconnect(); });

describe('ZLens on a live Snowflake account (NBA)', () => {
  live('reads the catalog as a read-only role, every view with its SQL (SHOW VIEWS, not INFORMATION_SCHEMA.VIEWS)', async () => {
    const { relations, warnings } = await readWarehouseCatalogRelations({ executor, connection, scopes: [{ catalogOrDatabase: 'NBA', schemas: ['RAW', 'TRANSFORMED', 'DEV'] }] });
    expect(warnings).toEqual([]);
    expect(relations.length).toBeGreaterThanOrEqual(26);
    const views = relations.filter((relation) => relation.kind === 'view');
    expect(views.length).toBeGreaterThanOrEqual(10);
    expect(views.every((relation) => Boolean(relation.viewSql))).toBe(true);
    expect(relations.find((relation) => relation.relation === 'NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS')?.rowCountEstimate).toBe(599);
  }, 120_000);

  live('checks a join: the validation statement runs (`rows` is reserved on Snowflake)', async () => {
    const profile = await profileRelationshipOnWarehouse(
      { fromRelation: 'NBA.TRANSFORMED.LOCAL_PLAYER_GAME_FACTS', toRelation: 'NBA.TRANSFORMED.LOCAL_TEAM_GAME_FACTS', keys: [{ from: 'GAME_ID', to: 'GAME_ID' }, { from: 'TEAM_ID', to: 'TEAM_ID' }] },
      async (sql) => ({ rows: await rows(sql) }),
      (identifier) => `"${identifier}"`,
      new Date(),
      'snowflake',
    );
    expect(profile.proposed.cardinality).toBe('many_to_one');
    expect(profile.evidence.status).toBe('passed');
    expect(profile.evidence.fromRows).toBe(668_339);
  }, 120_000);

  live('a Snowflake error keeps its reason on the first line', async () => {
    const error = await rows('SELECT 1 AS rows').catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.split('\n')[0]).toMatch(/SQL compilation error: syntax error .*unexpected 'rows'/);
  }, 60_000);

  live('imports the NBA semantic view from DESC SEMANTIC VIEW, and its metrics run on the base tables', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-snowflake-semantic-'));
    try {
      const provider = new SnowflakeSemanticProvider(async (sql) => ({ rows: await rows(sql) }));
      const layer = await provider.loadAsync({ provider: 'snowflake', projectPath: 'NBA' } as never, projectRoot);
      expect(layer.getMetric('total_wins')).toMatchObject({ type: 'sum', sql: 'WINS', table: 'NBA.TRANSFORMED.LOCAL_TEAM_SEASON_FACTS' });
      expect(layer.getMetric('win_rate')).toMatchObject({ metricType: 'ratio' });
      expect(layer.getDimension('team_name')).toMatchObject({ sql: 'NICKNAME' });
      const composed = layer.composeQuery({ metrics: ['total_wins', 'win_rate'], dimensions: ['team_name'], driver: 'snowflake' });
      expect(composed?.sql).toBeTruthy();
      const result = await rows(composed!.sql);
      expect(result).toHaveLength(30);
      const read = (row: Record<string, unknown>, name: string) => row[name] ?? row[name.toUpperCase()];
      const warriors = result.find((row) => read(row, 'team_name') === 'Warriors')!;
      expect(Number(read(warriors, 'total_wins'))).toBeGreaterThan(500);
      expect(Number(read(warriors, 'win_rate'))).toBeGreaterThan(0.3);
      expect(Number(read(warriors, 'win_rate'))).toBeLessThan(0.8);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
