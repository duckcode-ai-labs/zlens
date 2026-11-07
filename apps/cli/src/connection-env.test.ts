import { describe, expect, it } from 'vitest';
import { connectionEnvironmentReferences } from './connection-env.js';

describe('connectionEnvironmentReferences', () => {
  it('lists the ${NAME} references a connection reads and whether each is set', () => {
    const connection = {
      driver: 'postgres',
      host: '${PG_HOST}',
      user: 'analyst',
      password: '${PG_PASSWORD}',
      sshTunnel: { privateKeyPath: '${HOME_KEY}/id_rsa' },
    };
    expect(connectionEnvironmentReferences(connection, { PG_HOST: 'db.internal', HOME_KEY: '' })).toEqual([
      { name: 'HOME_KEY', set: false },
      { name: 'PG_HOST', set: true },
      { name: 'PG_PASSWORD', set: false },
    ]);
  });

  it('reads the lists of a file connection too: its catalogs and sources', () => {
    const lake = {
      driver: 'file',
      storage: { s3: { secretAccessKey: '${LAKE_S3_SECRET}' } },
      catalogs: [{ name: 'shared', path: 'postgres:dbname=lake', password: '${LAKE_PG_PASSWORD}' }, { name: 'r2', type: 'iceberg', token: '${secret:lake.catalogs.r2.token}' }],
      sources: [{ path: '${LAKE_ROOT}/orders.parquet' }],
    };
    expect(connectionEnvironmentReferences(lake, { LAKE_PG_PASSWORD: 'x' }).map(({ name, set }) => `${name}:${set}`))
      .toEqual(['LAKE_PG_PASSWORD:true', 'LAKE_ROOT:false', 'LAKE_S3_SECRET:false']);
  });

  it('skips secret-store references and literal values', () => {
    expect(connectionEnvironmentReferences({ driver: 'snowflake', password: '${secret:default.password}', account: 'acme' }, {})).toEqual([]);
    expect(connectionEnvironmentReferences(undefined, {})).toEqual([]);
  });
});
