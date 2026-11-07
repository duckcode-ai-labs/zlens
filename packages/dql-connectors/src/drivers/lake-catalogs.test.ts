import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readEnv } from '../env.js';
import { DuckDBConnector } from './duckdb.js';
import { FileConnector } from './file.js';

/**
 * Catalogs a file connection attaches, against real catalog servers (CI runs
 * them; locally see the open-formats lab):
 *
 *   Iceberg REST (Lakekeeper) with its warehouse in an S3 API:
 *     ZLENS_TEST_ICEBERG_REST_ENDPOINT=http://127.0.0.1:8181/catalog ZLENS_TEST_ICEBERG_REST_WAREHOUSE=lab
 *     ZLENS_TEST_S3_ENDPOINT / ZLENS_TEST_S3_KEY_ID / ZLENS_TEST_S3_SECRET (the warehouse's bucket)
 *   Unity Catalog OSS:  ZLENS_TEST_UNITY_ENDPOINT=http://127.0.0.1:8080
 *   DuckLake on Postgres: ZLENS_TEST_DUCKLAKE_POSTGRES='dbname=ducklake host=127.0.0.1 user=…' (+ ZLENS_TEST_DUCKLAKE_PASSWORD):
 *     each run keeps its catalog in a schema of its own (`metadataSchema`) and drops it.
 *   and ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT for the DuckDB driver.
 */
const driverRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const restEndpoint = readEnv('ZLENS_TEST_ICEBERG_REST_ENDPOINT')?.trim();
const restWarehouse = readEnv('ZLENS_TEST_ICEBERG_REST_WAREHOUSE')?.trim();
const s3Endpoint = readEnv('ZLENS_TEST_S3_ENDPOINT')?.trim();
const s3Key = readEnv('ZLENS_TEST_S3_KEY_ID')?.trim();
const s3Secret = readEnv('ZLENS_TEST_S3_SECRET')?.trim();
const unityEndpoint = readEnv('ZLENS_TEST_UNITY_ENDPOINT')?.trim();
const duckLakePostgres = readEnv('ZLENS_TEST_DUCKLAKE_POSTGRES')?.trim();
const duckLakePassword = readEnv('ZLENS_TEST_DUCKLAKE_PASSWORD')?.trim();

const restIt = driverRoot && restEndpoint && restWarehouse && s3Endpoint && s3Key && s3Secret ? it : it.skip;
const unityIt = driverRoot && unityEndpoint ? it : it.skip;
const duckLakeIt = driverRoot && duckLakePostgres ? it : it.skip;

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../test/fixtures/lake');
const storage = () => ({ s3: { accessKeyId: s3Key!, secretAccessKey: s3Secret!, endpoint: s3Endpoint!, region: 'us-east-1' } });
const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;

describe('catalogs a file connection attaches', () => {
  restIt('an Iceberg REST catalog: its tables by name with their real columns, read-only; a wrong warehouse is a problem in plain words', async () => {
    const namespace = `zl_${randomUUID().slice(0, 8)}`;
    const writer = new DuckDBConnector();
    await writer.connect({ driver: 'duckdb', storage: storage(), moduleSearchPaths: [driverRoot!] });
    const attach = `ATTACH ${sqlText(restWarehouse!)} AS w (TYPE iceberg, ENDPOINT ${sqlText(restEndpoint!)}, AUTHORIZATION_TYPE 'none', ACCESS_DELEGATION_MODE 'none')`;
    try {
      await writer.execute(attach);
      await writer.execute(`CREATE SCHEMA w.${namespace}`);
      await writer.execute(`CREATE TABLE w.${namespace}.orders AS SELECT i AS order_id, i % 3 AS customer_id, 10.0 * i AS amount FROM range(1, 9) t(i)`);
      await writer.execute(`CREATE TABLE w.${namespace}.customers AS SELECT i AS customer_id, 'customer ' || i AS name FROM range(3) t(i)`);
      await writer.execute(`DELETE FROM w.${namespace}.orders WHERE order_id = 1`);
      // A namespace the connection does not name: its table is never looked up.
      await writer.execute(`CREATE SCHEMA w.${namespace}_other`);
      await writer.execute(`CREATE TABLE w.${namespace}_other.skipped AS SELECT 1 AS id`);

      const connector = new FileConnector();
      await connector.connect({
        driver: 'file',
        storage: storage(),
        catalogs: [
          { name: 'lake', type: 'iceberg', endpoint: restEndpoint!, warehouse: restWarehouse!, files: 'storage', namespaces: [namespace] },
          { name: 'nowhere', type: 'iceberg', endpoint: restEndpoint!, warehouse: `no_such_${namespace}`, files: 'storage' },
        ],
        moduleSearchPaths: [driverRoot!],
      });
      try {
        const first = async (sql: string) => (await connector.execute(sql)).rows[0];
        expect(await first(`SELECT COUNT(*) AS n FROM lake.${namespace}.orders`)).toEqual({ n: 7 });
        expect(await first(`SELECT COUNT(*) AS n FROM lake.${namespace}.orders o JOIN lake.${namespace}.customers c USING (customer_id)`)).toEqual({ n: 7 });

        // The catalog lists its tables lazily; ZLens looked each one up, so their real columns are listed.
        const columns = await connector.listColumns(`lake.${namespace}`, 'orders');
        expect(columns.map((column) => column.name)).toEqual(['order_id', 'customer_id', 'amount']);
        const placeholders = await connector.execute(`SELECT COUNT(*) AS n FROM duckdb_columns() WHERE database_name = 'lake' AND schema_name = '${namespace}' AND data_type = 'UNKNOWN'`);
        expect(placeholders.rows[0]).toEqual({ n: 0 });
        // A table not looked up lists no column rather than DuckDB's placeholder.
        expect(await connector.listColumns(`lake.${namespace}_other`, 'skipped')).toEqual([]);
        const tables = await connector.listTables();
        expect(tables.filter((table) => table.catalog === 'lake' && table.schema === namespace).map((table) => `${table.schema}.${table.name}`).sort())
          .toEqual([`${namespace}.customers`, `${namespace}.orders`]);

        const status = await connector.dataFolderStatus();
        expect(status?.catalogs.map(({ name, kind }) => `${name}: ${kind}`)).toEqual(['lake: Iceberg REST catalog, attached as lake']);
        expect(status?.catalogs[0].source).toContain(`(warehouse ${restWarehouse}; no sign-in; files read with this connection's storage)`);
        expect(status?.problems).toHaveLength(1);
        expect(status?.problems[0]).toMatchObject({ name: 'nowhere' });
        expect(status?.problems[0].reason).toMatch(/^the Iceberg REST catalog does not know that warehouse: check its name/);
        expect(JSON.stringify(status)).not.toContain(s3Secret!);

        // Read-only: the catalog is never written through ZLens.
        await expect(connector.execute(`INSERT INTO lake.${namespace}.customers VALUES (9, 'x')`)).rejects.toThrow(/read-only/i);
      } finally {
        await connector.disconnect();
      }
    } finally {
      await writer.execute(`DROP TABLE IF EXISTS w.${namespace}.orders`).catch(() => undefined);
      await writer.execute(`DROP TABLE IF EXISTS w.${namespace}.customers`).catch(() => undefined);
      await writer.execute(`DROP SCHEMA IF EXISTS w.${namespace}`).catch(() => undefined);
      await writer.execute(`DROP TABLE IF EXISTS w.${namespace}_other.skipped`).catch(() => undefined);
      await writer.execute(`DROP SCHEMA IF EXISTS w.${namespace}_other`).catch(() => undefined);
      await writer.disconnect();
    }
  }, 180_000);

  unityIt('Unity Catalog: a Delta table by name; a catalog it does not know is a problem, and the connection still opens', async () => {
    const api = `${unityEndpoint!.replace(/\/+$/, '')}/api/2.1/unity-catalog`;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Unity Catalog ${path}: ${response.status} ${await response.text()}`);
    };
    const catalog = `zl_${randomUUID().slice(0, 8)}`;
    const location = join(fixtures, 'customers_delta');
    const typeNames: Record<string, string> = { BIGINT: 'LONG', INTEGER: 'INT', VARCHAR: 'STRING', DOUBLE: 'DOUBLE', DATE: 'DATE', BOOLEAN: 'BOOLEAN' };

    const describer = new DuckDBConnector();
    await describer.connect({ driver: 'duckdb', moduleSearchPaths: [driverRoot!] });
    let columns: Array<{ column_name: string; column_type: string }>;
    try {
      columns = (await describer.execute(`DESCRIBE SELECT * FROM delta_scan(${sqlText(location)})`)).rows as typeof columns;
    } finally {
      await describer.disconnect();
    }
    await post('/catalogs', { name: catalog });
    try {
      await post('/schemas', { name: 'sales', catalog_name: catalog });
      await post('/tables', {
        name: 'customers', catalog_name: catalog, schema_name: 'sales', table_type: 'EXTERNAL', data_source_format: 'DELTA',
        storage_location: `file://${location}`,
        columns: columns.map((column, position) => {
          const type = typeNames[column.column_type] ?? 'STRING';
          return { name: column.column_name, type_name: type, type_text: type.toLowerCase(), type_json: JSON.stringify({ name: column.column_name, type: type.toLowerCase(), nullable: true, metadata: {} }), position, nullable: true };
        }),
      });

      const connector = new FileConnector();
      await connector.connect({
        driver: 'file',
        catalogs: [
          { name: 'unity', type: 'unity', endpoint: unityEndpoint!, catalog },
          { name: 'missing', type: 'unity', endpoint: unityEndpoint!, catalog: `no_such_${catalog}` },
        ],
        moduleSearchPaths: [driverRoot!],
      });
      try {
        expect((await connector.execute('SELECT COUNT(*) AS n FROM unity.sales.customers')).rows[0]).toEqual({ n: 9 });
        const listed = await connector.listColumns('unity.sales', 'customers');
        expect(listed.map((column) => column.name)).toEqual(columns.map((column) => column.column_name));
        const status = await connector.dataFolderStatus();
        expect(status?.catalogs.map(({ name, kind }) => `${name}: ${kind}`)).toEqual(['unity: Unity Catalog, attached as unity']);
        expect(status?.problems).toHaveLength(1);
        expect(status?.problems[0]).toMatchObject({ name: 'missing' });
        expect(status?.problems[0].reason).toMatch(/^the Unity Catalog does not know that catalog: check its name/);
      } finally {
        await connector.disconnect();
      }
    } finally {
      await fetch(`${api}/catalogs/${catalog}?force=true`, { method: 'DELETE' }).catch(() => undefined);
    }
  }, 180_000);

  duckLakeIt('DuckLake with its catalog in Postgres: read by name, the password kept out of every message', async () => {
    const schema = `zl_${randomUUID().slice(0, 8)}`;
    const data = mkdtempSync(join(tmpdir(), 'zlens-ducklake-'));
    const server = `${duckLakePostgres}${duckLakePassword ? ` password=${duckLakePassword}` : ''}`;
    const writer = new DuckDBConnector();
    await writer.connect({ driver: 'duckdb', moduleSearchPaths: [driverRoot!] });
    try {
      await writer.execute(`ATTACH ${sqlText(`ducklake:postgres:${server}`)} AS dl (DATA_PATH ${sqlText(`${data}/`)}, METADATA_SCHEMA ${sqlText(schema)})`);
      await writer.execute('CREATE TABLE dl.orders AS SELECT i AS order_id, 10.0 * i AS amount FROM range(1, 11) t(i)');
      await writer.execute('DELETE FROM dl.orders WHERE order_id <= 2');

      const connector = new FileConnector();
      await connector.connect({
        driver: 'file',
        catalogs: [{ name: 'lake', path: `postgres:${duckLakePostgres}`, metadataSchema: schema, ...(duckLakePassword ? { password: duckLakePassword } : {}) }],
        moduleSearchPaths: [driverRoot!],
      });
      try {
        expect((await connector.execute('SELECT COUNT(*) AS n, CAST(SUM(amount) AS INTEGER) AS total FROM lake.main.orders')).rows[0]).toEqual({ n: 8, total: 520 });
        const status = await connector.dataFolderStatus();
        expect(status?.catalogs.map(({ name, kind }) => `${name}: ${kind}`)).toEqual(['lake: DuckLake catalog in Postgres, attached as lake']);
        expect(status?.catalogs[0].source).toBe(`postgres:${duckLakePostgres} (schema ${schema})`);
        expect(status?.problems).toEqual([]);
        if (duckLakePassword) expect(JSON.stringify(status)).not.toContain(duckLakePassword);
        await expect(connector.execute('INSERT INTO lake.main.orders VALUES (99, 1.0)')).rejects.toThrow(/read-only/i);
      } finally {
        await connector.disconnect();
      }
    } finally {
      await writer.execute('DETACH dl').catch(() => undefined);
      await writer.execute(`ATTACH ${sqlText(server)} AS pg (TYPE postgres)`).catch(() => undefined);
      await writer.execute(`CALL postgres_execute('pg', 'DROP SCHEMA IF EXISTS ${schema} CASCADE')`).catch(() => undefined);
      await writer.disconnect();
      rmSync(data, { recursive: true, force: true });
    }
  }, 180_000);
});
