import { createHash } from 'node:crypto';
import type { LakeStorageConfig } from './connector.js';

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** A value storage needs, or a plain error naming the setting. */
function required(value: string | undefined, setting: string, why: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`storage.${setting} is missing: ${why}.`);
  return text;
}

/** An S3 API endpoint as DuckDB takes it (`host:port`), and whether it said `http://`. */
function endpointParts(endpoint: string): { host: string; plainHttp: boolean } {
  const plainHttp = /^http:\/\//i.test(endpoint);
  return { host: endpoint.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, ''), plainHttp };
}

/**
 * The `CREATE OR REPLACE SECRET` statements for a connection's storage: one
 * per cloud it names, held in memory by DuckDB (never written to disk), named
 * after what they hold so connections sharing a database file never replace
 * each other's. Credentials come from the cloud's own sign-in (the credential
 * chain) unless keys are given. A missing required value is a plain error.
 */
export function lakeStorageSecretStatements(storage: LakeStorageConfig | undefined): string[] {
  if (!storage) return [];
  const statements: string[] = [];
  const secret = (type: string, options: string[]) => {
    const name = `zlens_${type}_${createHash('sha256').update(options.join('\u0000')).digest('hex').slice(0, 12)}`;
    statements.push(`CREATE OR REPLACE SECRET ${name} (${[`TYPE ${type}`, ...options].join(', ')})`);
  };

  const s3 = storage.s3;
  if (s3) {
    const options: string[] = [];
    const keys = s3.auth === 'keys' || (s3.auth === undefined && Boolean(s3.accessKeyId || s3.secretAccessKey));
    if (keys) {
      options.push(`KEY_ID ${sqlText(required(s3.accessKeyId, 's3.accessKeyId', 'keys need an access key id'))}`);
      options.push(`SECRET ${sqlText(required(s3.secretAccessKey, 's3.secretAccessKey', 'keys need a secret access key'))}`);
      if (s3.sessionToken?.trim()) options.push(`SESSION_TOKEN ${sqlText(s3.sessionToken.trim())}`);
    } else {
      options.push('PROVIDER credential_chain');
      if (s3.profile?.trim()) options.push(`PROFILE ${sqlText(s3.profile.trim())}`);
    }
    if (s3.region?.trim()) options.push(`REGION ${sqlText(s3.region.trim())}`);
    if (s3.endpoint?.trim()) {
      const endpoint = endpointParts(s3.endpoint.trim());
      options.push(`ENDPOINT ${sqlText(endpoint.host)}`);
      // Other S3 APIs (MinIO, Ceph) address buckets by path, not by host name.
      options.push(`URL_STYLE ${sqlText(s3.urlStyle ?? 'path')}`);
      options.push(`USE_SSL ${s3.useSsl ?? !endpoint.plainHttp}`);
    } else {
      if (s3.urlStyle) options.push(`URL_STYLE ${sqlText(s3.urlStyle)}`);
      if (s3.useSsl !== undefined) options.push(`USE_SSL ${s3.useSsl}`);
    }
    secret('s3', options);
  }

  const gcs = storage.gcs;
  if (gcs) {
    const hmac = gcs.auth === 'hmac' || (gcs.auth === undefined && Boolean(gcs.keyId || gcs.secret));
    secret('gcs', hmac
      ? [
        `KEY_ID ${sqlText(required(gcs.keyId, 'gcs.keyId', 'HMAC keys need a key id'))}`,
        `SECRET ${sqlText(required(gcs.secret, 'gcs.secret', 'HMAC keys need a secret'))}`,
      ]
      : ['PROVIDER credential_chain']);
  }

  const azure = storage.azure;
  if (azure) {
    const connectionString = azure.auth === 'connection_string' || (azure.auth === undefined && Boolean(azure.connectionString));
    secret('azure', connectionString
      ? [`CONNECTION_STRING ${sqlText(required(azure.connectionString, 'azure.connectionString', 'a connection string sign-in needs it'))}`]
      : ['PROVIDER credential_chain', `ACCOUNT_NAME ${sqlText(required(azure.accountName, 'azure.accountName', 'the Azure sign-in needs the storage account name'))}`]);
  }

  const r2 = storage.r2;
  if (r2) {
    secret('r2', [
      `KEY_ID ${sqlText(required(r2.keyId, 'r2.keyId', 'R2 needs an access key id'))}`,
      `SECRET ${sqlText(required(r2.secret, 'r2.secret', 'R2 needs a secret access key'))}`,
      `ACCOUNT_ID ${sqlText(required(r2.accountId, 'r2.accountId', 'R2 needs the account id'))}`,
    ]);
  }
  return statements;
}

/** What a connection's storage says, with every key, secret and connection string left out (for messages and logs). */
export function describeLakeStorage(storage: LakeStorageConfig | undefined): string[] {
  if (!storage) return [];
  const lines: string[] = [];
  if (storage.s3) {
    const keys = storage.s3.auth === 'keys' || (storage.s3.auth === undefined && Boolean(storage.s3.accessKeyId || storage.s3.secretAccessKey));
    lines.push(`S3${storage.s3.endpoint ? ` at ${endpointParts(storage.s3.endpoint).host}` : ''}${storage.s3.region ? ` (${storage.s3.region})` : ''}: ${keys ? 'access keys' : storage.s3.profile ? `your AWS sign-in, profile ${storage.s3.profile}` : 'your AWS sign-in'}`);
  }
  if (storage.gcs) lines.push(`Google Cloud Storage: ${storage.gcs.auth === 'hmac' || (storage.gcs.auth === undefined && storage.gcs.keyId) ? 'HMAC keys' : 'your Google sign-in'}`);
  if (storage.azure) lines.push(`Azure Storage${storage.azure.accountName ? ` (${storage.azure.accountName})` : ''}: ${storage.azure.auth === 'connection_string' || (storage.azure.auth === undefined && storage.azure.connectionString) ? 'a connection string' : 'your Azure sign-in'}`);
  if (storage.r2) lines.push(`Cloudflare R2${storage.r2.accountId ? ` (${storage.r2.accountId})` : ''}: access keys`);
  return lines;
}
