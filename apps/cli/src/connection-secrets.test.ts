import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SECRET_MASK,
  connectionSecretsPath,
  redactConnections,
  resolveSecretReferences,
  storeConnectionSecrets,
} from './connection-secrets.js';

function project(): string {
  return mkdtempSync(join(tmpdir(), 'dql-secrets-'));
}

describe('connection secrets', () => {
  it('moves a typed password out of the config into the private file', () => {
    const root = project();
    const saved = storeConnectionSecrets(root, {
      warehouse: { driver: 'postgresql', host: 'db', username: 'reader', password: 'hunter22' },
    }, {});
    expect(saved.warehouse).toEqual({ driver: 'postgresql', host: 'db', username: 'reader', password: '${secret:warehouse.password}' });
    const file = connectionSecretsPath(root);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ warehouse: { password: 'hunter22' } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveSecretReferences(saved.warehouse as object, root)).toMatchObject({ password: 'hunter22' });
  });

  it('a bucket key in a file connection\'s storage moves to the private file, shows as the mask, and is read back', () => {
    const root = project();
    const lake = {
      driver: 'file',
      dataFolder: 's3://acme-lake/sales/',
      storage: { s3: { region: 'us-east-1', accessKeyId: 'AKIA1', secretAccessKey: 'wJalr', sessionToken: 'tok' }, azure: { connectionString: 'AccountKey=k' } },
      sources: [{ name: 'orders', path: 's3://acme-lake/sales/orders/' }],
    };
    const saved = storeConnectionSecrets(root, { lake }, {});
    expect(saved.lake).toEqual({
      ...lake,
      storage: {
        s3: { region: 'us-east-1', accessKeyId: 'AKIA1', secretAccessKey: '${secret:lake.storage.s3.secretAccessKey}', sessionToken: '${secret:lake.storage.s3.sessionToken}' },
        azure: { connectionString: '${secret:lake.storage.azure.connectionString}' },
      },
    });
    expect(JSON.parse(readFileSync(connectionSecretsPath(root), 'utf-8'))).toEqual({
      lake: { 'storage.s3.secretAccessKey': 'wJalr', 'storage.s3.sessionToken': 'tok', 'storage.azure.connectionString': 'AccountKey=k' },
    });
    const shown = redactConnections(saved) as { lake: { storage: { s3: Record<string, unknown> } } };
    expect(shown.lake.storage.s3.secretAccessKey).toBe(SECRET_MASK);
    expect(shown.lake.storage.s3.accessKeyId).toBe('AKIA1');
    // The original is never changed by showing it.
    expect((saved.lake as typeof lake).storage.s3.secretAccessKey).toBe('${secret:lake.storage.s3.secretAccessKey}');
    const again = storeConnectionSecrets(root, shown, saved);
    expect(resolveSecretReferences(again.lake as object, root)).toMatchObject({
      storage: { s3: { secretAccessKey: 'wJalr', sessionToken: 'tok' }, azure: { connectionString: 'AccountKey=k' } },
      sources: [{ name: 'orders', path: 's3://acme-lake/sales/orders/' }],
    });
  });

  it('never shows a saved secret, and saving the mask keeps it', () => {
    const root = project();
    const first = storeConnectionSecrets(root, { w: { driver: 'mysql', password: 'hunter22' } }, {});
    const shown = redactConnections(first);
    expect((shown.w as Record<string, unknown>).password).toBe(SECRET_MASK);
    const second = storeConnectionSecrets(root, { w: { ...(shown.w as object), host: 'db2' } }, first);
    expect(resolveSecretReferences(second.w as object, root)).toMatchObject({ password: 'hunter22', host: 'db2' });
  });

  it('keeps a secret across a rename', () => {
    const root = project();
    const first = storeConnectionSecrets(root, { old: { driver: 'mysql', password: 'hunter22' } }, {});
    const shown = redactConnections(first);
    const renamed = storeConnectionSecrets(root, { prod: shown.old }, first, { renames: { prod: 'old' } });
    expect(renamed.prod).toMatchObject({ password: '${secret:prod.password}' });
    expect(resolveSecretReferences(renamed.prod as object, root)).toMatchObject({ password: 'hunter22' });
    expect(JSON.parse(readFileSync(connectionSecretsPath(root), 'utf-8'))).toEqual({ prod: { password: 'hunter22' } });
  });

  it('moves a literal secret already in the config on the next save', () => {
    const root = project();
    const previous = { w: { driver: 'postgresql', password: 'legacy-pass' } };
    const shown = redactConnections(previous);
    expect((shown.w as Record<string, unknown>).password).toBe(SECRET_MASK);
    const saved = storeConnectionSecrets(root, shown, previous);
    expect(saved.w).toMatchObject({ password: '${secret:w.password}' });
    expect(resolveSecretReferences(saved.w as object, root)).toMatchObject({ password: 'legacy-pass' });
  });

  it('leaves an environment reference as written and visible', () => {
    const root = project();
    const saved = storeConnectionSecrets(root, { w: { driver: 'postgresql', password: '${PG_PASSWORD}' } }, {});
    expect(saved.w).toMatchObject({ password: '${PG_PASSWORD}' });
    expect((redactConnections(saved).w as Record<string, unknown>).password).toBe('${PG_PASSWORD}');
  });

  it('stores nested SSH tunnel secrets', () => {
    const root = project();
    const saved = storeConnectionSecrets(root, {
      w: { driver: 'postgresql', sshTunnel: { host: 'bastion', username: 'ec2-user', password: 'ssh-pass' } },
    }, {});
    expect(saved.w).toMatchObject({ sshTunnel: { host: 'bastion', password: '${secret:w.sshTunnel.password}' } });
    expect(resolveSecretReferences(saved.w as object, root)).toMatchObject({ sshTunnel: { password: 'ssh-pass' } });
    expect((redactConnections(saved).w as { sshTunnel: Record<string, unknown> }).sshTunnel.password).toBe(SECRET_MASK);
  });

  it('removes a cleared secret and the secrets of deleted connections', () => {
    const root = project();
    const first = storeConnectionSecrets(root, {
      a: { driver: 'mysql', password: 'one' },
      b: { driver: 'mysql', password: 'two' },
    }, {});
    const second = storeConnectionSecrets(root, { a: { driver: 'mysql', password: '' } }, first);
    expect(second.a).toEqual({ driver: 'mysql' });
    expect(JSON.parse(readFileSync(connectionSecretsPath(root), 'utf-8'))).toEqual({});
  });

  it('takes a secret the page could not send from the fallback (a dbt profile)', () => {
    const root = project();
    const saved = storeConnectionSecrets(root, { dev: { driver: 'postgresql', password: SECRET_MASK } }, {}, {
      fallback: (name, field) => (name === 'dev' && field === 'password' ? 'from-profile' : undefined),
    });
    expect(resolveSecretReferences(saved.dev as object, root)).toMatchObject({ password: 'from-profile' });
  });

  it('refuses to sign in with a reference whose secret is gone', () => {
    const root = project();
    expect(() => resolveSecretReferences({ password: '${secret:w.password}' }, root)).toThrow(/Re-enter it on the Connections page/);
  });

  it('masks inline key objects and moves them out as JSON', () => {
    const root = project();
    const saved = storeConnectionSecrets(root, { bq: { driver: 'bigquery', credentials: { client_email: 'x@y', private_key: 'k' } } }, {});
    expect(saved.bq).toEqual({ driver: 'bigquery', serviceAccountJson: '${secret:bq.serviceAccountJson}' });
    expect(JSON.parse((resolveSecretReferences(saved.bq as object, root) as { serviceAccountJson: string }).serviceAccountJson)).toEqual({ client_email: 'x@y', private_key: 'k' });
  });
});
