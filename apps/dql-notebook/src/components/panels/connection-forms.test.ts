import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_SCHEMAS,
  connectionFromFormFields,
  fieldApplies,
  formFieldsFromConnection,
} from './connection-forms';

const REQUESTED = ['postgresql', 'redshift', 'bigquery', 'mysql', 'mssql', 'trino', 'clickhouse', 'athena'];

describe('connection forms', () => {
  it('offers every requested warehouse, with a label, unique fields and a sign-in choice where one exists', () => {
    const drivers = CONNECTOR_SCHEMAS.map((schema) => schema.driver);
    for (const driver of REQUESTED) expect(drivers).toContain(driver);
    for (const schema of CONNECTOR_SCHEMAS) {
      const keys = schema.fields.map((field) => field.key);
      expect(new Set(keys).size, schema.driver).toBe(keys.length);
      // Every primary field is a real field of the form, for every sign-in method.
      const methods = ['', ...(schema.fields.find((field) => field.key === 'authMethod')?.options ?? []).map((option) => option.value)];
      for (const method of methods) {
        for (const key of schema.primary?.(method) ?? []) expect(keys, `${schema.driver}/${method}: ${key}`).toContain(key);
      }
    }
  });

  it('shows only the fields of the chosen sign-in method', () => {
    const redshift = CONNECTOR_SCHEMAS.find((schema) => schema.driver === 'redshift')!;
    const visible = (fields: Record<string, string>) => redshift.fields.filter((field) => fieldApplies(field, fields)).map((field) => field.key);
    expect(visible({ authMethod: 'password' })).toContain('password');
    expect(visible({ authMethod: 'password' })).not.toContain('clusterId');
    expect(visible({ authMethod: 'aws_profile' })).toEqual(expect.arrayContaining(['clusterId', 'workgroup', 'profile', 'region']));
    expect(visible({ authMethod: 'aws_profile' })).not.toContain('password');
    expect(visible({ authMethod: 'aws_profile' })).not.toContain('secretAccessKey');
  });

  it('saves typed values and leaves out a stale secret from another sign-in method', () => {
    const connection = connectionFromFormFields('postgresql', {
      host: 'db', port: '5432', database: 'analytics', username: 'reader',
      authMethod: 'aws_default', region: 'us-east-1', password: 'left-over', sslMode: 'verify-full',
    });
    expect(connection).toEqual({ driver: 'postgresql', host: 'db', port: 5432, database: 'analytics', username: 'reader', authMethod: 'aws_default', region: 'us-east-1', sslMode: 'verify-full' });
  });

  it('folds the SSH tunnel fields into one object and back', () => {
    const fields = {
      host: '10.0.3.17', database: 'analytics', username: 'reader', password: 'p',
      useSshTunnel: 'true', 'sshTunnel.host': 'bastion', 'sshTunnel.port': '2222', 'sshTunnel.username': 'ec2-user', 'sshTunnel.privateKeyPath': '~/.ssh/id',
    };
    const connection = connectionFromFormFields('postgresql', fields);
    expect(connection.sshTunnel).toEqual({ host: 'bastion', port: 2222, username: 'ec2-user', privateKeyPath: '~/.ssh/id' });
    expect(formFieldsFromConnection(connection)).toMatchObject({ useSshTunnel: 'true', 'sshTunnel.host': 'bastion', 'sshTunnel.port': '2222' });
  });

  it('drops the tunnel when it is switched off', () => {
    const connection = connectionFromFormFields('mysql', { host: 'db', useSshTunnel: 'false', 'sshTunnel.host': 'bastion' });
    expect(connection).toEqual({ driver: 'mysql', host: 'db' });
  });

  it('keeps a checkbox the user turned off', () => {
    expect(connectionFromFormFields('trino', { host: 't', catalog: 'hive', username: 'u', ssl: 'false' })).toMatchObject({ ssl: false });
  });
});

describe('a file connection with buckets, through the form', () => {
  it('keeps storage and sources when the form saves it, with secrets left as the page sent them', () => {
    const stored = {
      driver: 'file',
      dataFolder: 's3://acme-lake/sales/',
      storage: { s3: { region: 'us-east-1', accessKeyId: 'AKIA1', secretAccessKey: '••••••••', endpoint: 'http://minio:9000', useSsl: false } },
      sources: [{ name: 'orders', path: 's3://acme-lake/orders/', format: 'iceberg' }],
    };
    const fields = formFieldsFromConnection(stored);
    expect(fields).toMatchObject({
      dataFolder: 's3://acme-lake/sales/',
      'storage.s3.region': 'us-east-1',
      'storage.s3.secretAccessKey': '••••••••',
      'storage.s3.useSsl': 'false',
    });
    expect(Object.values(fields)).not.toContain('[object Object]');
    expect(connectionFromFormFields('file', fields)).toEqual(stored);
  });
});
