import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestRuntimeSchemaSnapshotForProject } from '@zlens/agent';
import type {
  ConnectionConfig,
  QueryExecutor,
  QueryResult,
} from '@zlens/connectors';
import {
  buildWarehouseMetadataQueries,
  discoverWarehouseMetadataScopes,
  normalizeConnectionMetadataScope,
  syncWarehouseMetadata,
} from './warehouse-metadata.js';

const snowflakeConnection: ConnectionConfig = {
  driver: 'snowflake',
  account: 'acme-prod',
  database: 'ANALYTICS_PROD',
  schema: 'SALES',
  role: 'ANALYST',
  warehouse: 'REPORTING_WH',
  username: 'service_user',
  password: 'secret-one',
};

describe('warehouse metadata scope', () => {
  it('defaults to exact dbt relations instead of scanning every schema', () => {
    const scope = normalizeConnectionMetadataScope(
      'primary',
      snowflakeConnection,
      { mode: 'dbt_relations' },
      {
        relations: [
          'ANALYTICS_PROD.SALES.ORDERS',
          'REFERENCE_DATA.SHARED.CALENDAR',
        ],
        dbtFingerprint: 'manifest-a',
      },
    );

    expect(scope.scopes).toEqual([
      { catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] },
      { catalogOrDatabase: 'REFERENCE_DATA', schemas: ['SHARED'] },
    ]);
    const queries = buildWarehouseMetadataQueries(snowflakeConnection, scope);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain('"ANALYTICS_PROD".INFORMATION_SCHEMA.COLUMNS');
    expect(queries[0]?.sql).toContain("UPPER(table_name) IN (UPPER('ORDERS'))");
    expect(queries[0]?.sql).not.toContain('FROM INFORMATION_SCHEMA.COLUMNS');
  });

  it('combines exact dbt relations with explicitly selected schemas', () => {
    const scope = normalizeConnectionMetadataScope(
      'primary',
      snowflakeConnection,
      {
        mode: 'dbt_plus_selected',
        scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['FINANCE'] }],
      },
      { relations: ['ANALYTICS_PROD.SALES.ORDERS'] },
    );

    const query = buildWarehouseMetadataQueries(snowflakeConnection, scope)[0]?.sql ?? '';
    expect(query).toContain("UPPER(table_name) IN (UPPER('ORDERS'))");
    expect(query).toContain("UPPER(table_schema) IN (UPPER('FINANCE'))");
    expect(query).not.toContain("UPPER(table_schema) IN (UPPER('FINANCE'), UPPER('SALES'))");
    expect(query).toContain(' OR ');
  });

  it('never adds unselected databases to a selected-scope query plan', () => {
    const scope = normalizeConnectionMetadataScope('primary', snowflakeConnection, {
      mode: 'selected_scopes',
      scopes: [
        { catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES', 'FINANCE'] },
        { catalogOrDatabase: 'REFERENCE_DATA', schemas: ['SHARED'] },
      ],
    });
    const queries = buildWarehouseMetadataQueries(snowflakeConnection, scope);

    expect(queries.map((query) => query.catalogOrDatabase)).toEqual([
      'ANALYTICS_PROD',
      'REFERENCE_DATA',
    ]);
    expect(queries.every((query) => query.sql.includes('LIMIT 50000'))).toBe(true);
  });

  it('does not fingerprint credentials but does fingerprint scope and role changes', () => {
    const base = normalizeConnectionMetadataScope('primary', snowflakeConnection, {
      mode: 'selected_scopes',
      scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
    });
    const credentialChange = normalizeConnectionMetadataScope('primary', {
      ...snowflakeConnection,
      password: 'secret-two',
      privateKey: 'private-material',
      token: 'oauth-token',
    }, {
      mode: 'selected_scopes',
      scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
    });
    const roleChange = normalizeConnectionMetadataScope('primary', {
      ...snowflakeConnection,
      role: 'FINANCE_ANALYST',
    }, {
      mode: 'selected_scopes',
      scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
    });

    expect(credentialChange.scopeFingerprint).toBe(base.scopeFingerprint);
    expect(roleChange.scopeFingerprint).not.toBe(base.scopeFingerprint);
  });

  it('replaces persisted dbt-derived relations when the current manifest changes', () => {
    const scope = normalizeConnectionMetadataScope(
      'primary',
      snowflakeConnection,
      {
        mode: 'dbt_relations',
        relations: ['ANALYTICS_PROD.SALES.REMOVED_MODEL'],
        dbtFingerprint: 'old-manifest',
      },
      {
        relations: ['ANALYTICS_PROD.SALES.CURRENT_MODEL'],
        dbtFingerprint: 'current-manifest',
      },
    );

    expect(scope.relations).toEqual(['ANALYTICS_PROD.SALES.CURRENT_MODEL']);
    expect(scope.dbtFingerprint).toBe('current-manifest');
  });

  it('discovers visible Snowflake schemas and labels dbt-covered scopes without selecting them', async () => {
    const executePositional = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql.includes('CURRENT_ACCOUNT')) {
        return {
          columns: [],
          rows: [{
            DQL_ACCOUNT: 'ACME-PROD',
            DQL_ACCOUNT_LOCATOR: 'XY123',
            DQL_ACCOUNT_NAME: 'PROD',
            DQL_ORGANIZATION: 'ACME',
            DQL_DATABASE: 'ANALYTICS_PROD',
            DQL_SCHEMA: 'SALES',
            DQL_ROLE: 'ANALYST',
            DQL_WAREHOUSE: 'REPORTING_WH',
          }],
          rowCount: 1,
          executionTimeMs: 1,
        };
      }
      return {
        columns: [],
        rows: [
          { database_name: 'ANALYTICS_PROD', name: 'SALES' },
          { database_name: 'ANALYTICS_PROD', name: 'GOLD' },
          { database_name: 'REFERENCE_DATA', name: 'SHARED' },
          { database_name: 'ANALYTICS_PROD', name: 'INFORMATION_SCHEMA' },
        ],
        rowCount: 4,
        executionTimeMs: 1,
      };
    });

    const discovery = await discoverWarehouseMetadataScopes({
      connectionId: 'primary',
      executor: { executePositional } as unknown as QueryExecutor,
      connection: snowflakeConnection,
      dbtRelations: ['ANALYTICS_PROD.SALES.ORDERS'],
    });

    expect(discovery).toMatchObject({
      supported: true,
      dbtScopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
      scopes: [
        {
          catalogOrDatabase: 'ANALYTICS_PROD',
          schemas: [
            { name: 'GOLD', inDbtProject: false, dbtRelationCount: 0 },
            { name: 'SALES', inDbtProject: true, dbtRelationCount: 1 },
          ],
        },
        {
          catalogOrDatabase: 'REFERENCE_DATA',
          schemas: [{ name: 'SHARED', inDbtProject: false, dbtRelationCount: 0 }],
        },
      ],
    });
    expect(discovery.message).toContain('2 additional schemas outside the dbt project');
    expect(executePositional).toHaveBeenCalledTimes(2);
  });

  it('never says "outside the dbt project" in a project without dbt (D7)', async () => {
    const executePositional = vi.fn(async (sql: string): Promise<QueryResult> => (sql.includes('CURRENT_ACCOUNT')
      ? { columns: [], rows: [{ DQL_ACCOUNT: 'ACME-PROD', DQL_ACCOUNT_LOCATOR: 'XY123', DQL_ACCOUNT_NAME: 'PROD', DQL_ORGANIZATION: 'ACME', DQL_DATABASE: 'ANALYTICS_PROD', DQL_SCHEMA: 'SALES', DQL_ROLE: 'ANALYST', DQL_WAREHOUSE: 'REPORTING_WH' }], rowCount: 1, executionTimeMs: 1 }
      : { columns: [], rows: [{ database_name: 'ANALYTICS_PROD', name: 'SALES' }, { database_name: 'ANALYTICS_PROD', name: 'GOLD' }], rowCount: 2, executionTimeMs: 1 }));
    const discovery = await discoverWarehouseMetadataScopes({
      connectionId: 'primary',
      executor: { executePositional } as unknown as QueryExecutor,
      connection: snowflakeConnection,
      dbtRelations: [],
    });
    expect(discovery.message).toBe('Found 2 schemas. Choose the ones ZLens should read, then Apply and synchronize.');
    expect(discovery.message).not.toContain('dbt');
  });

  it('discovers Databricks catalogs and schemas only during explicit discovery', async () => {
    const connection: ConnectionConfig = {
      driver: 'databricks',
      host: 'adb.example.test',
      token: 'secret',
      warehouse: 'warehouse-1',
      catalog: 'analytics_prod',
      schema: 'sales',
    };
    const executePositional = vi.fn(async (sql: string): Promise<QueryResult> => {
      if (sql === 'SHOW CATALOGS') {
        return {
          columns: [],
          rows: [{ catalog: 'analytics_prod' }, { catalog: 'reference_data' }],
          rowCount: 2,
          executionTimeMs: 1,
        };
      }
      return {
        columns: [],
        rows: sql.includes('analytics_prod')
          ? [{ databaseName: 'sales' }, { databaseName: 'gold' }]
          : [{ databaseName: 'shared' }],
        rowCount: sql.includes('analytics_prod') ? 2 : 1,
        executionTimeMs: 1,
      };
    });

    const discovery = await discoverWarehouseMetadataScopes({
      connectionId: 'default',
      executor: { executePositional } as unknown as QueryExecutor,
      connection,
      dbtRelations: ['analytics_prod.sales.orders'],
    });

    expect(discovery.scopes).toEqual([
      {
        catalogOrDatabase: 'analytics_prod',
        schemas: [
          { name: 'gold', inDbtProject: false, dbtRelationCount: 0 },
          { name: 'sales', inDbtProject: true, dbtRelationCount: 1 },
        ],
      },
      {
        catalogOrDatabase: 'reference_data',
        schemas: [{ name: 'shared', inDbtProject: false, dbtRelationCount: 0 }],
      },
    ]);
    expect(discovery.queryCount).toBe(3);
  });

  it('activates one bounded generation after identity and scoped metadata checks pass', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-metadata-'));
    const calls: Array<{ sql: string; options: Record<string, unknown> }> = [];
    const executor = {
      executePositional: async (
        sql: string,
        _params: unknown[],
        _connection: ConnectionConfig,
        options: Record<string, unknown> = {},
      ) => {
        calls.push({ sql, options });
        if (sql.includes('CURRENT_ACCOUNT')) {
          return {
            columns: [],
            rows: [{
              DQL_ACCOUNT: 'ACME-PROD',
              DQL_ACCOUNT_LOCATOR: 'XY123',
              DQL_ACCOUNT_NAME: 'PROD',
              DQL_ORGANIZATION: 'ACME',
              DQL_DATABASE: 'ANALYTICS_PROD',
              DQL_SCHEMA: 'SALES',
              DQL_ROLE: 'ANALYST',
              DQL_WAREHOUSE: 'REPORTING_WH',
            }],
            rowCount: 1,
            executionTimeMs: 1,
          };
        }
        return {
          columns: [],
          rows: [{
            TABLE_CATALOG: 'ANALYTICS_PROD',
            TABLE_SCHEMA: 'SALES',
            TABLE_NAME: 'ORDERS',
            COLUMN_NAME: 'CUSTOMER_ID',
            DATA_TYPE: 'NUMBER',
            ORDINAL_POSITION: 1,
          }],
          rowCount: 1,
          executionTimeMs: 2,
          truncated: false,
        };
      },
    };
    try {
      const scope = normalizeConnectionMetadataScope('primary', snowflakeConnection, {
        mode: 'selected_scopes',
        scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
      });
      const synced = await syncWarehouseMetadata({
        projectRoot,
        executor: executor as never,
        connection: snowflakeConnection,
        scope,
      });
      const active = latestRuntimeSchemaSnapshotForProject(projectRoot);

      expect(synced.snapshot.generationId).toMatch(/^warehouse_/);
      expect(active).toMatchObject({
        generationId: synced.snapshot.generationId,
        scopeFingerprint: scope.scopeFingerprint,
        connectionId: 'primary',
        status: 'ready',
        tables: [{
          relation: 'ANALYTICS_PROD.SALES.ORDERS',
          catalogOrDatabase: 'ANALYTICS_PROD',
          schema: 'SALES',
          name: 'ORDERS',
          columns: [{ name: 'CUSTOMER_ID', type: 'NUMBER' }],
        }],
      });
      expect(calls[1]?.options).toMatchObject({
        maxRows: 50_000,
        maxBytes: 24 * 1024 * 1024,
        deadlineMs: 60_000,
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when observed target identity differs from configuration', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dql-warehouse-metadata-mismatch-'));
    const executor = {
      executePositional: async () => ({
        columns: [],
        rows: [{
          DQL_ACCOUNT: 'ACME-PROD',
          DQL_ACCOUNT_LOCATOR: 'XY123',
          DQL_ACCOUNT_NAME: 'PROD',
          DQL_ORGANIZATION: 'ACME',
          DQL_DATABASE: 'UNEXPECTED_DEV',
          DQL_SCHEMA: 'SALES',
          DQL_ROLE: 'ANALYST',
          DQL_WAREHOUSE: 'REPORTING_WH',
        }],
        rowCount: 1,
        executionTimeMs: 1,
      }),
    };
    try {
      const scope = normalizeConnectionMetadataScope('primary', snowflakeConnection, {
        mode: 'selected_scopes',
        scopes: [{ catalogOrDatabase: 'ANALYTICS_PROD', schemas: ['SALES'] }],
      });
      await expect(syncWarehouseMetadata({
        projectRoot,
        executor: executor as never,
        connection: snowflakeConnection,
        scope,
      })).rejects.toThrow('does not match the active target');
      expect(latestRuntimeSchemaSnapshotForProject(projectRoot)).toBeNull();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
