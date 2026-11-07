import { describe, expect, it } from 'vitest';
import { configuredCatalogs } from './data-folder.js';
import { DataFolderViews } from './data-folder-views.js';
import {
  LAKE_CATALOG_DESCRIBE_TABLES,
  lakeCatalogFailure,
  lakeCatalogKind,
  lakeCatalogPlan,
  lakeCatalogType,
  needsLakeCatalogPlan,
  withoutPassword,
} from './lake-catalogs.js';
import { defaultLakeSignIns } from './lake-storage.js';
import type { LakeRun } from './lake-listing.js';
import type { QueryResult } from './result-types.js';

const result = (rows: Record<string, unknown>[]): QueryResult => ({ columns: [], rows, rowCount: rows.length, executionTimeMs: 1 });
const secretName = (statement: string) => /^CREATE OR REPLACE SECRET (zlens_[a-z0-9_]+_[0-9a-f]{12}) /.exec(statement)?.[1];

describe('lakeCatalogPlan', () => {
  it('an Iceberg REST catalog with no sign-in: one read-only ATTACH, files read with the catalog\'s credentials', () => {
    const plan = lakeCatalogPlan({ name: 'lake', type: 'iceberg', endpoint: 'http://127.0.0.1:8181/catalog/', warehouse: 'lab' }, 'lake');
    expect(plan.secrets).toEqual([]);
    expect(plan.attach).toBe(`ATTACH IF NOT EXISTS 'lab' AS "lake" (TYPE iceberg, ENDPOINT 'http://127.0.0.1:8181/catalog', AUTHORIZATION_TYPE 'none', READ_ONLY)`);
    expect(plan.source).toBe('http://127.0.0.1:8181/catalog (warehouse lab; no sign-in; files read with the credentials the catalog hands out)');
    expect(plan).toMatchObject({ service: true, describeTables: true });
  });

  it('OAuth2 (Polaris, Lakekeeper): a secret with the client and its token address; the files read with storage', () => {
    const plan = lakeCatalogPlan({
      name: 'polaris', type: 'iceberg', endpoint: 'https://polaris.example.com/api/catalog', warehouse: 'quickstart',
      clientId: 'zlens', clientSecret: 's3cr3t', scope: 'PRINCIPAL_ROLE:ALL', files: 'storage', namespaces: ['sales'],
    }, 'polaris');
    expect(plan.secrets).toHaveLength(1);
    const name = secretName(plan.secrets[0]);
    expect(plan.secrets[0]).toBe(`CREATE OR REPLACE SECRET ${name} (TYPE iceberg, CLIENT_ID 'zlens', CLIENT_SECRET 's3cr3t', OAUTH2_SERVER_URI 'https://polaris.example.com/api/catalog/v1/oauth/tokens', OAUTH2_SCOPE 'PRINCIPAL_ROLE:ALL')`);
    expect(plan.attach).toBe(`ATTACH IF NOT EXISTS 'quickstart' AS "polaris" (TYPE iceberg, ENDPOINT 'https://polaris.example.com/api/catalog', SECRET ${name}, ACCESS_DELEGATION_MODE 'none', READ_ONLY)`);
    expect(plan.source).toBe('https://polaris.example.com/api/catalog (warehouse quickstart; OAuth2 client zlens; files read with this connection\'s storage)');
    expect(plan.source).not.toContain('s3cr3t');
    expect(plan.namespaces).toEqual(['sales']);
  });

  it('a token (R2 Data Catalog): a token secret; the token is never in the source', () => {
    const plan = lakeCatalogPlan({ name: 'r2', type: 'iceberg', endpoint: 'https://catalog.cloudflarestorage.com/acct/lake', warehouse: 'acct_lake', token: 'tok-123' }, 'r2');
    expect(plan.secrets[0]).toMatch(/^CREATE OR REPLACE SECRET zlens_iceberg_[0-9a-f]{12} \(TYPE iceberg, TOKEN 'tok-123'\)$/);
    expect(plan.attach).toContain(`SECRET ${secretName(plan.secrets[0])}`);
    expect(plan.source).not.toContain('tok-123');
  });

  it('AWS Glue signs with the connection\'s AWS sign-in in the catalog\'s region; S3 Tables takes the region from the ARN', () => {
    const glue = lakeCatalogPlan({ name: 'glue', type: 'glue', account: '123456789012' }, 'glue', { s3: { region: 'eu-west-1', profile: 'analytics' } });
    expect(glue.secrets[0]).toMatch(/^CREATE OR REPLACE SECRET zlens_s3_[0-9a-f]{12} \(TYPE s3, PROVIDER credential_chain, PROFILE 'analytics', REGION 'eu-west-1'\)$/);
    expect(glue.attach).toBe(`ATTACH IF NOT EXISTS '123456789012' AS "glue" (TYPE iceberg, ENDPOINT_TYPE glue, SECRET ${secretName(glue.secrets[0])}, READ_ONLY)`);
    expect(glue.source).toBe('AWS Glue, account 123456789012 (eu-west-1)');

    const tables = lakeCatalogPlan({ name: 'st', type: 's3_tables', arn: 'arn:aws:s3tables:us-east-2:123456789012:bucket/lake' }, 'st');
    expect(tables.secrets[0]).toContain(`REGION 'us-east-2'`);
    expect(tables.attach).toContain(`'arn:aws:s3tables:us-east-2:123456789012:bucket/lake' AS "st" (TYPE iceberg, ENDPOINT_TYPE s3_tables, SECRET zlens_s3_`);
    // An S3 API endpoint (MinIO) of the connection's storage is never used to reach AWS.
    expect(lakeCatalogPlan({ name: 'g', type: 'glue', account: '1', region: 'us-east-1' }, 'g', { s3: { endpoint: 'http://127.0.0.1:9000' } }).secrets[0]).not.toContain('ENDPOINT');
  });

  it('Unity Catalog: a unity_catalog secret with the region of its storage, attached read-only', () => {
    const plan = lakeCatalogPlan({ name: 'unity', type: 'unity', endpoint: 'https://dbc-1.cloud.databricks.com/', catalog: 'main', token: 'dapi-x', region: 'us-west-2' }, 'unity');
    const name = secretName(plan.secrets[0]);
    expect(plan.secrets[0]).toBe(`CREATE OR REPLACE SECRET ${name} (TYPE unity_catalog, TOKEN 'dapi-x', ENDPOINT 'https://dbc-1.cloud.databricks.com', AWS_REGION 'us-west-2')`);
    expect(plan.attach).toBe(`ATTACH IF NOT EXISTS 'main' AS "unity" (TYPE unity_catalog, SECRET ${name}, READ_ONLY)`);
    expect(plan).toMatchObject({ service: true, describeTables: false, source: 'https://dbc-1.cloud.databricks.com (catalog main; a token)' });
  });

  it('DuckLake in Postgres: the password only in the secret, never in the ATTACH text or the source', () => {
    const plan = lakeCatalogPlan({ name: 'lake', path: 'postgres:dbname=lake host=db.internal user=zlens', password: 'pw-9', dataPath: 's3://lake/data/', metadataSchema: 'team_a' }, 'lake');
    const name = secretName(plan.secrets[0]);
    expect(plan.secrets[0]).toBe(`CREATE OR REPLACE SECRET ${name} (TYPE ducklake, METADATA_PATH 'postgres:dbname=lake host=db.internal user=zlens password=pw-9', DATA_PATH 's3://lake/data/', METADATA_SCHEMA 'team_a')`);
    expect(plan.attach).toBe(`ATTACH IF NOT EXISTS 'ducklake:${name}' AS "lake" (READ_ONLY)`);
    expect(plan.source).toBe('postgres:dbname=lake host=db.internal user=zlens (schema team_a)');
    expect(plan.service).toBe(false);
    // A password written into the path is not shown either.
    expect(lakeCatalogPlan({ name: 'l', path: 'postgres:dbname=l password=inline user=z' }, 'l').source).toBe('postgres:dbname=l password=… user=z');
  });

  it('a missing setting is a plain error naming the catalog and the setting', () => {
    expect(() => lakeCatalogPlan({ name: 'lake', type: 'iceberg', warehouse: 'lab' }, 'lake')).toThrow('catalog lake: "endpoint" is missing: an Iceberg REST catalog needs its address');
    expect(() => lakeCatalogPlan({ name: 'lake', type: 'iceberg', endpoint: 'http://x' }, 'lake')).toThrow('"warehouse" is missing');
    expect(() => lakeCatalogPlan({ name: 'p', type: 'iceberg', endpoint: 'http://x', warehouse: 'w', auth: 'oauth2', clientId: 'a' }, 'p')).toThrow('"clientSecret" is missing');
    expect(() => lakeCatalogPlan({ name: 'g', type: 'glue', account: '1' }, 'g')).toThrow('"region" is missing: an AWS Glue catalog needs its region (or storage.s3.region)');
    expect(() => lakeCatalogPlan({ name: 'u', type: 'unity', endpoint: 'http://x' }, 'u')).toThrow('"catalog" is missing');
  });
});

describe('catalog kinds and failures', () => {
  it('a type from the path when not given', () => {
    expect(lakeCatalogType({ path: 'lake.ducklake' })).toBe('ducklake');
    expect(lakeCatalogType({ path: 'postgres:dbname=lake' })).toBe('ducklake');
    expect(lakeCatalogType({ path: 'meta.sqlite' })).toBe('sqlite');
    expect(lakeCatalogType({ path: 'warehouse.duckdb' })).toBe('duckdb');
    expect(lakeCatalogKind({ path: 'mysql:db=lake' })).toBe('DuckLake catalog in MySQL');
    expect(needsLakeCatalogPlan({ name: 'f', path: 'lake.ducklake' })).toBe(false);
    expect(needsLakeCatalogPlan({ name: 'f', path: 'lake.ducklake', dataPath: 's3://x/' })).toBe(true);
  });

  it('says what to check for an address, a name or a sign-in', () => {
    expect(lakeCatalogFailure({ type: 'iceberg' }, new Error("DuckDB query failed: IO Error: Could not connect to server error for HTTP GET to 'http://127.0.0.1:8199/catalog/v1/config?warehouse=lab'")))
      .toBe("the Iceberg REST catalog cannot be reached: check its address (DuckDB: IO Error: Could not connect to server error for HTTP GET to 'http://127.0.0.1:8199/catalog/v1/config?warehouse=lab')");
    expect(lakeCatalogFailure({ type: 'iceberg' }, new Error("Invalid Configuration Error: Request to 'http://x/v1/config?warehouse=nope' returned a non-200 status code (NotFound_404), with reason: Not Found")))
      .toMatch(/^the Iceberg REST catalog does not know that warehouse: check its name/);
    expect(lakeCatalogFailure({ type: 'unity' }, new Error("IO Error: Request to 'http://x/api/2.1/unity-catalog/schemas?catalog_name=nope' failed (HTTP 404): Not Found")))
      .toMatch(/^the Unity Catalog does not know that catalog: check its name/);
    expect(lakeCatalogFailure({ type: 'glue' }, new Error("Request to 'glue.us-east-1.amazonaws.com/iceberg/v1/config?warehouse=1' returned a non-200 status code (Forbidden_403)")))
      .toMatch(/^the AWS Glue catalog refused the sign-in: check its credentials \(your AWS sign-in, or storage\.s3\)/);
    expect(withoutPassword("host=x password='a b' user=y passwd=z")).toBe('host=x password=… user=y passwd=…');
  });

  it('an AWS Glue or S3 Tables catalog uses the AWS sign-in by default', () => {
    expect(defaultLakeSignIns({ catalogs: [{ name: 'g', type: 'glue', account: '1' }] })).toEqual({ s3: {} });
    expect(defaultLakeSignIns({ catalogs: [{ name: 'g', type: 'glue', account: '1' }], storage: { s3: { region: 'x' } } })).toEqual({});
    expect(defaultLakeSignIns({ catalogs: [{ name: 'l', path: 's3://lake/meta.ducklake' }] })).toEqual({ s3: {} });
    expect(defaultLakeSignIns({ catalogs: [{ name: 'i', type: 'iceberg', endpoint: 'http://x', warehouse: 'w' }] })).toEqual({});
  });

  it('configuredCatalogs: a catalog service gets its plan, a file stays a file, a wrong one says why', () => {
    const catalogs = configuredCatalogs([
      { name: 'lake', type: 'iceberg', endpoint: 'http://127.0.0.1:8181/catalog', warehouse: 'lab' },
      { name: 'files', path: '/data/warehouse.duckdb' },
      { name: 'broken', type: 'unity', endpoint: 'http://x' },
      { name: 'memory', type: 'unity', endpoint: 'http://x', catalog: 'main' },
    ]);
    expect(catalogs.map(({ name, type, kind }) => `${name} ${type}: ${kind}`)).toEqual([
      'lake iceberg: Iceberg REST catalog, attached as lake',
      'files duckdb: DuckDB database, attached as files',
      'broken unity: Unity Catalog, attached as broken',
      'memory_unity unity: Unity Catalog, attached as memory_unity',
    ]);
    expect(catalogs[0].plan?.attach).toContain(`AS "lake" (TYPE iceberg`);
    expect(catalogs[1].plan).toBeUndefined();
    expect(catalogs[2].invalid).toBe('catalog broken: "catalog" is missing: Unity Catalog needs the catalog to open');
    expect(catalogs[3].plan?.attach).toContain('AS "memory_unity"');
  });
});

/** A DuckDB engine as a catalog service answers ZLens's statements. */
function engine(options: { schemas?: Error; tables?: number; describeFails?: string[] } = {}): { run: LakeRun; statements: string[] } {
  const statements: string[] = [];
  const described = new Set<string>();
  const tables = Array.from({ length: options.tables ?? 2 }, (_, i) => ({ schema_name: 'sales', table_name: `t${String(i).padStart(4, '0')}` }));
  const run: LakeRun = async (sql) => {
    statements.push(sql);
    if (sql === 'SELECT current_database() AS name') return result([{ name: 'memory' }]);
    if (sql.startsWith('SELECT schema_name FROM information_schema.schemata')) {
      if (options.schemas) throw options.schemas;
      return result([{ schema_name: 'sales' }]);
    }
    const limit = /LIMIT (\d+)$/.exec(sql);
    if (sql.includes("column_name = '__'")) return result(tables.filter((table) => !described.has(table.table_name)).slice(0, Number(limit?.[1] ?? 1e9)));
    const describe = /^DESCRIBE "lake"\."sales"\."(.+)"$/.exec(sql);
    if (describe) {
      if (options.describeFails?.includes(describe[1])) throw new Error('DuckDB query failed: HTTP Error: 403 Forbidden');
      described.add(describe[1]);
      return result([{ column_name: 'id', column_type: 'BIGINT' }]);
    }
    return result([]);
  };
  return { run, statements };
}

const iceberg = { name: 'lake', type: 'iceberg' as const, endpoint: 'http://127.0.0.1:8181/catalog', warehouse: 'lab' };

describe('a catalog service on a connection', () => {
  it('is attached, checked by listing its schemas, and each table looked up once so its columns are known', async () => {
    const { run, statements } = engine();
    const views = new DataFolderViews('', run, { temporary: false, catalogs: true, exclude: [], configuredCatalogs: [iceberg] });
    await views.refresh();
    expect(statements.filter((sql) => /^(ATTACH|SELECT schema_name FROM|DESCRIBE)/.test(sql))).toEqual([
      `ATTACH IF NOT EXISTS 'lab' AS "lake" (TYPE iceberg, ENDPOINT 'http://127.0.0.1:8181/catalog', AUTHORIZATION_TYPE 'none', READ_ONLY)`,
      `SELECT schema_name FROM information_schema.schemata WHERE catalog_name = 'lake' ORDER BY schema_name`,
      'DESCRIBE "lake"."sales"."t0000"',
      'DESCRIBE "lake"."sales"."t0001"',
    ]);
    expect(views.status()).toMatchObject({ catalogs: [{ name: 'lake', kind: 'Iceberg REST catalog, attached as lake' }], problems: [] });
  });

  it('one that cannot answer is detached again and is a problem in plain words; it is tried again after a minute, not on every statement', async () => {
    const { run, statements } = engine({ schemas: new Error("DuckDB query failed: IO Error: Could not connect to server error for HTTP GET to 'http://127.0.0.1:8181/catalog/v1/namespaces'") });
    const views = new DataFolderViews('', run, { temporary: false, catalogs: true, exclude: [], configuredCatalogs: [iceberg] });
    await views.refresh();
    expect(statements).toContain('DETACH DATABASE IF EXISTS "lake"');
    const status = views.status();
    expect(status.catalogs).toEqual([]);
    expect(status.problems).toEqual([{
      source: 'http://127.0.0.1:8181/catalog (warehouse lab; no sign-in; files read with the credentials the catalog hands out)',
      name: 'lake',
      reason: "the Iceberg REST catalog cannot be reached: check its address (DuckDB: IO Error: Could not connect to server error for HTTP GET to 'http://127.0.0.1:8181/catalog/v1/namespaces')",
    }]);
  });

  it('looks up at most a bounded number of tables and says how many are left; a table it cannot look up is named', async () => {
    const { run, statements } = engine({ tables: LAKE_CATALOG_DESCRIBE_TABLES + 5, describeFails: ['t0001'] });
    const views = new DataFolderViews('', run, { temporary: false, catalogs: true, exclude: [], configuredCatalogs: [{ ...iceberg, namespaces: ['sales'] }] });
    await views.refresh();
    expect(statements.filter((sql) => sql.startsWith('DESCRIBE'))).toHaveLength(LAKE_CATALOG_DESCRIBE_TABLES);
    expect(statements.find((sql) => sql.includes("column_name = '__'"))).toContain(`AND schema_name IN ('sales')`);
    const problems = views.status().problems;
    expect(problems.map(({ name }) => name)).toEqual(['lake.sales.t0001', 'lake']);
    expect(problems[0].reason).toMatch(/^the Iceberg REST catalog refused the sign-in/);
    // The listing asks for one more than it looks up, so it knows there are more.
    expect(problems[1].reason).toBe('more than 1 of its tables were not looked up yet (ZLens looks up at most 1000 tables for 60 s at a time): their columns are listed once they are; name the namespaces to read in "namespaces"');
  });

  it('a catalog that cannot be attached as written says why, and the secret is never in what is shown', async () => {
    const { run } = engine();
    const views = new DataFolderViews('', run, {
      temporary: false, catalogs: true, exclude: [],
      configuredCatalogs: [{ name: 'p', type: 'iceberg', endpoint: 'http://x', warehouse: 'w', clientId: 'id', clientSecret: 'never-shown' }, { name: 'u', type: 'unity', endpoint: 'http://x' }],
    });
    await views.refresh();
    const status = views.status();
    expect(status.problems.find((problem) => problem.name === 'u')?.reason).toBe('catalog u: "catalog" is missing: Unity Catalog needs the catalog to open');
    expect(JSON.stringify(status)).not.toContain('never-shown');
  });
});
