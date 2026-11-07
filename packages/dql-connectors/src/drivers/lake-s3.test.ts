import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readEnv } from '../env.js';
import { DuckDBConnector } from './duckdb.js';
import { FileConnector } from './file.js';

/**
 * A lake in a bucket, against a real S3 API (MinIO in CI). The bucket holds
 * `test/fixtures/lake` under `lake/` (CI copies it there first):
 *
 *   ZLENS_TEST_S3_ENDPOINT=http://127.0.0.1:9000 ZLENS_TEST_S3_BUCKET=zlens-test
 *   ZLENS_TEST_S3_KEY_ID=… ZLENS_TEST_S3_SECRET=… ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT=…
 *   ZLENS_TEST_S3_CHECKS_KEYS=1 (only against a server that checks keys)
 */
const driverRoot = readEnv('ZLENS_APP_DATASETS_DUCKDB_CONNECTOR_ROOT')?.trim();
const endpoint = readEnv('ZLENS_TEST_S3_ENDPOINT')?.trim();
const bucket = readEnv('ZLENS_TEST_S3_BUCKET')?.trim();
const keyId = readEnv('ZLENS_TEST_S3_KEY_ID')?.trim();
const secret = readEnv('ZLENS_TEST_S3_SECRET')?.trim();
const s3It = driverRoot && endpoint && bucket && keyId && secret ? it : it.skip;
/** A server that checks keys (MinIO, AWS): `ZLENS_TEST_S3_CHECKS_KEYS=1`. Test servers such as moto accept any. */
const keysIt = driverRoot && endpoint && bucket && keyId && secret && readEnv('ZLENS_TEST_S3_CHECKS_KEYS') === '1' ? it : it.skip;

const storage = () => ({ s3: { accessKeyId: keyId!, secretAccessKey: secret!, endpoint: endpoint!, region: 'us-east-1' } });

describe('a lake in a bucket (S3 API)', () => {
  s3It('reads a bucket folder by name: Delta and Iceberg tables written elsewhere, and named sources', async () => {
    // A partitioned folder and a CSV written into the bucket by DuckDB itself, in a folder of this run's own.
    const run = `s3://${bucket}/run-${randomUUID().slice(0, 8)}`;
    const writer = new DuckDBConnector();
    await writer.connect({ driver: 'duckdb', storage: storage(), moduleSearchPaths: [driverRoot!] });
    try {
      await writer.execute(`COPY (SELECT i AS id, 2024 + i % 2 AS year FROM range(6) t(i)) TO '${run}/events' (FORMAT parquet, PARTITION_BY (year))`);
      await writer.execute(`COPY (SELECT 'north' AS region, 100 AS target) TO '${run}/targets.csv' (HEADER)`);
    } finally {
      await writer.disconnect();
    }

    const connector = new FileConnector();
    await connector.connect({
      driver: 'file',
      dataFolder: `s3://${bucket}/lake/`,
      storage: storage(),
      sources: [
        { name: 'events', path: `${run}/events/` },
        { path: `${run}/targets.csv` },
        { name: 'nothing', path: `${run}/missing/` },
      ],
      moduleSearchPaths: [driverRoot!],
    });
    try {
      const first = async (sql: string) => (await connector.execute(sql)).rows[0];
      expect(await first('SELECT COUNT(*) AS n FROM orders_iceberg')).toEqual({ n: 8 });
      expect(await first('SELECT COUNT(*) AS n FROM customers_delta')).toEqual({ n: 9 });
      expect(await first('SELECT COUNT(*) AS n, COUNT(DISTINCT year) AS years FROM events')).toEqual({ n: 6, years: 2 });
      expect(await first('SELECT CAST(SUM(target) AS INTEGER) AS total FROM targets')).toEqual({ total: 100 });
      const status = await connector.dataFolderStatus();
      expect(status?.tables.map(({ name, kind }) => `${name}: ${kind}`)).toEqual([
        'events: 2 Parquet files, partitioned by year',
        'targets: CSV file',
        'customers_delta: Delta Lake table',
        'orders_iceberg: Iceberg table (version 3)',
      ]);
      expect(status?.problems).toEqual([{ source: `${run}/missing/`, name: 'nothing', reason: `${run}/missing/ holds no data ZLens reads` }]);
    } finally {
      await connector.disconnect();
    }
  }, 120_000);

  keysIt('wrong keys: the folder is a problem with the bucket\'s reason, and the connection still opens', async () => {
    const connector = new FileConnector();
    await connector.connect({
      driver: 'file',
      dataFolder: `s3://${bucket}/lake/`,
      storage: { s3: { ...storage().s3, secretAccessKey: 'not-the-secret' } },
      moduleSearchPaths: [driverRoot!],
    });
    try {
      const status = await connector.dataFolderStatus();
      expect(status?.tables).toEqual([]);
      expect(status?.problems).toHaveLength(1);
      expect(status?.problems[0]).toMatchObject({ source: `s3://${bucket}/lake/` });
      expect(status?.problems[0].reason).toMatch(/403|Forbidden|Signature|denied/i);
      // The reason never repeats the secret.
      expect(JSON.stringify(status)).not.toContain('not-the-secret');
    } finally {
      await connector.disconnect();
    }
  }, 120_000);
});
