import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import { ConnectorQueryError } from '../result-types.js';
import { SnowflakeConnector, normalizeSnowflakePrivateKeyForAuth, snowflakeLogLevel } from './snowflake.js';

describe('normalizeSnowflakePrivateKeyForAuth', () => {
  // RSA key generation is the slow step (it timed out on the Node 20 CI runner),
  // so generate one key per file and export it in each format the tests need.
  let pkcs1Key: string;
  let pkcs8Key: string;
  let encryptedKey: string;

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    pkcs1Key = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    pkcs8Key = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    encryptedKey = privateKey.export({
      type: 'pkcs8',
      format: 'pem',
      cipher: 'aes-256-cbc',
      passphrase: 'correct-passphrase',
    }) as string;
  }, 30_000);

  it('normalizes RSA private keys to PKCS8 PEM', () => {
    const normalized = normalizeSnowflakePrivateKeyForAuth(pkcs1Key);

    expect(normalized).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('accepts pasted keys with escaped newlines', () => {
    const normalized = normalizeSnowflakePrivateKeyForAuth(pkcs8Key.replace(/\n/g, '\\n'));

    expect(normalized).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('decrypts encrypted private keys with the matching passphrase', () => {
    const normalized = normalizeSnowflakePrivateKeyForAuth(encryptedKey, 'correct-passphrase');

    expect(normalized).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('returns an actionable error when an encrypted key has the wrong passphrase', () => {
    expect(() => normalizeSnowflakePrivateKeyForAuth(encryptedKey, 'wrong-passphrase'))
      .toThrow(/Snowflake private key could not be parsed or decrypted/);
  });
});

describe('SnowflakeConnector bounded streaming', () => {
  it('uses streamResult, stops at the row bound, and preserves the query id', async () => {
    const connector = new SnowflakeConnector();
    let executeOptions: Record<string, unknown> | undefined;
    let cancelled = false;
    const statement = {
      getColumns: () => [{
        getName: () => 'VALUE',
        getType: () => 'FIXED',
      }],
      getStatementId: () => '01abc-query',
      streamRows: () => Readable.from([{ VALUE: 1 }, { VALUE: 2 }, { VALUE: 3 }]),
      cancel: (complete: () => void) => {
        cancelled = true;
        complete();
      },
    };
    (connector as any).connection = {
      execute: (options: Record<string, any>) => {
        executeOptions = options;
        queueMicrotask(() => options.complete(undefined, statement));
        return statement;
      },
    };

    const result = await connector.execute('select value', [], {
      maxRows: 2,
      batchSize: 1,
      maxBytes: 1024,
    });

    expect(executeOptions?.streamResult).toBe(true);
    expect(result.rows).toEqual([{ VALUE: 1 }, { VALUE: 2 }]);
    expect(result.truncated).toBe(true);
    expect(result.queryId).toBe('01abc-query');
    expect(cancelled).toBe(true);
  });

  it('preserves Snowflake SQLSTATE, vendor code, query id, line, and position', async () => {
    const connector = new SnowflakeConnector();
    const statement = {
      getStatementId: () => '01failure-query',
      cancel: (complete: () => void) => complete(),
    };
    (connector as any).connection = {
      execute: (options: Record<string, any>) => {
        queueMicrotask(() => options.complete(Object.assign(
          new Error("SQL compilation error: error line 406 at position 8 invalid identifier 'CDM.BCM_ADJUSTMENT_TYPE'"),
          { code: '000904', sqlState: '42000' },
        ), statement));
        return statement;
      },
    };

    const error = await connector.execute('select bad_identifier').catch((caught) => caught);
    expect(error).toBeInstanceOf(ConnectorQueryError);
    expect(error).toMatchObject({
      vendorCode: '000904',
      sqlState: '42000',
      queryId: '01failure-query',
      line: 406,
      position: 8,
    });
  });

  it('keeps the reason Snowflake puts after "SQL compilation error:" on the same line (live, 2026-11-07)', async () => {
    const connector = new SnowflakeConnector();
    const statement = { getStatementId: () => '01multi-line', cancel: (complete: () => void) => complete() };
    (connector as any).connection = {
      execute: (options: Record<string, any>) => {
        queueMicrotask(() => options.complete(Object.assign(
          new Error("SQL compilation error:\nsyntax error line 2 at position 35 unexpected 'rows'.\nsyntax error line 3 at position 33 unexpected 'rows'."),
          { code: '001003', sqlState: '42000' },
        ), statement));
        return statement;
      },
    };
    const error = await connector.execute('select 1 as rows').catch((caught) => caught);
    expect(error.message.split('\n')[0]).toBe("Snowflake query failed: SQL compilation error: syntax error line 2 at position 35 unexpected 'rows'. syntax error line 3 at position 33 unexpected 'rows'.");
    expect(error).toMatchObject({ line: 2, position: 35 });
  });
});

describe('the Snowflake SDK\'s own logging', () => {
  it('is off unless ZLENS_SNOWFLAKE_LOG_LEVEL asks for a level (it printed JSON into ZLens output)', () => {
    expect(snowflakeLogLevel({})).toBe('OFF');
    expect(snowflakeLogLevel({ ZLENS_SNOWFLAKE_LOG_LEVEL: 'debug' })).toBe('DEBUG');
    expect(snowflakeLogLevel({ ZLENS_SNOWFLAKE_LOG_LEVEL: 'loud' })).toBe('OFF');
  });
});
