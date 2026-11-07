import { describe, expect, it } from 'vitest';
import { defaultLakeSignIns, describeLakeStorage, lakeSignInFailure, lakeStorageSecretStatements } from './lake-storage.js';

const options = (statement: string) => /\((.*)\)$/.exec(statement)![1];

describe('a file connection\'s buckets as DuckDB secrets', () => {
  it('uses the cloud\'s own sign-in by default, held in memory, and never names a key it was not given', () => {
    const [s3, gcs, azure] = lakeStorageSecretStatements({ s3: { region: 'eu-west-1', profile: 'analytics' }, gcs: {}, azure: { accountName: 'acmelake' } });
    expect(s3).toMatch(/^CREATE OR REPLACE SECRET zlens_s3_[0-9a-f]{12} \(/);
    expect(s3).not.toMatch(/PERSISTENT/);
    expect(options(s3)).toBe("TYPE s3, PROVIDER credential_chain, PROFILE 'analytics', REGION 'eu-west-1'");
    expect(options(gcs)).toBe('TYPE gcs, PROVIDER credential_chain');
    expect(options(azure)).toBe("TYPE azure, PROVIDER credential_chain, ACCOUNT_NAME 'acmelake'");
  });

  it('takes keys, another S3 API (MinIO over plain http), HMAC, a connection string and R2', () => {
    const [s3] = lakeStorageSecretStatements({ s3: { accessKeyId: 'AKIA1', secretAccessKey: "it's", endpoint: 'http://127.0.0.1:9000', region: 'us-east-1' } });
    expect(options(s3)).toBe("TYPE s3, KEY_ID 'AKIA1', SECRET 'it''s', REGION 'us-east-1', ENDPOINT '127.0.0.1:9000', URL_STYLE 'path', USE_SSL false");
    const [gcs, azure, r2] = lakeStorageSecretStatements({
      gcs: { auth: 'hmac', keyId: 'GOOG1', secret: 's' },
      azure: { connectionString: 'AccountName=a;AccountKey=k' },
      r2: { accountId: 'acc', keyId: 'k', secret: 's' },
    });
    expect(options(gcs)).toBe("TYPE gcs, KEY_ID 'GOOG1', SECRET 's'");
    expect(options(azure)).toBe("TYPE azure, CONNECTION_STRING 'AccountName=a;AccountKey=k'");
    expect(options(r2)).toBe("TYPE r2, KEY_ID 'k', SECRET 's', ACCOUNT_ID 'acc'");
  });

  it('names a missing value by its setting, and two storages never share a secret name', () => {
    expect(() => lakeStorageSecretStatements({ s3: { auth: 'keys', accessKeyId: 'AKIA1' } })).toThrow('storage.s3.secretAccessKey is missing: keys need a secret access key.');
    expect(() => lakeStorageSecretStatements({ azure: {} })).toThrow('storage.azure.accountName is missing');
    const first = lakeStorageSecretStatements({ s3: { region: 'us-east-1' } })[0].split(' ')[4];
    const second = lakeStorageSecretStatements({ s3: { region: 'eu-west-1' } })[0].split(' ')[4];
    expect(first).not.toBe(second);
  });

  it('describes the storage without a key, a secret or a connection string', () => {
    const lines = describeLakeStorage({
      s3: { accessKeyId: 'AKIASECRET', secretAccessKey: 'shh', endpoint: 'http://minio:9000', region: 'us-east-1' },
      azure: { connectionString: 'AccountKey=shh' },
    });
    expect(lines).toEqual(['S3 at minio:9000 (us-east-1): access keys', 'Azure Storage: a connection string']);
    expect(lines.join(' ')).not.toMatch(/AKIASECRET|shh/);
  });

  it('a bucket read with no storage for its cloud uses that cloud\'s own sign-in; Azure and R2 are never assumed', () => {
    expect(defaultLakeSignIns({ dataFolder: 's3://acme/sales/', sources: [{ path: 'gs://acme/events/' }, { path: 'az://c/x' }, { path: './local.csv' }] }))
      .toEqual({ s3: {}, gcs: {} });
    expect(defaultLakeSignIns({ dataFolder: 'S3://acme/', storage: { s3: { region: 'eu-west-1' } } })).toEqual({});
    expect(defaultLakeSignIns({ dataFolder: './data' })).toEqual({});
  });

  it('says what to do when a cloud sign-in is not found', () => {
    const refusal = new Error('Invalid Configuration Error: Secret Validation Failure: during `create` using the following:\nCredential Chain: config');
    expect(lakeSignInFailure('s3', refusal)).toBe('no AWS sign-in found: sign in (aws sso login, a profile in ~/.aws/config, or AWS_* environment variables) or give storage.s3 keys (DuckDB: Invalid Configuration Error: Secret Validation Failure: during `create` using the following:)');
    expect(lakeSignInFailure('gcs', refusal)).toMatch(/^no Google Cloud sign-in found: sign in \(gcloud auth application-default login\)/);
    expect(lakeSignInFailure('s3', new Error('Catalog Error: something else'))).toBe('storage.s3: Catalog Error: something else');
  });
});
