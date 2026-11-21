import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ConnectorQueryError } from '../result-types.js';
import { withQueryLabels } from '../query-labels.js';
import { SnowflakeConnector, normalizeSnowflakePrivateKeyForAuth, readSnowflakePrivateKey, readSnowflakeTokenFile, snowflakeLogLevel, snowflakeQueryTag } from './snowflake.js';

// A stand-in SDK for connect(): it records the connection settings ZLens hands it.
const fakeSdk = vi.hoisted(() => {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    sdk: {
      configure: () => undefined,
      createConnection: (settings: Record<string, unknown>) => {
        created.push(settings);
        return { connect: (done: (err?: Error) => void) => done() };
      },
    },
  };
});
vi.mock('../optional-dependency.js', () => ({ importConnectorDependency: async () => fakeSdk.sdk }));

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

  it('reads a connection\'s key from its file or the pasted text, decrypted (the driver and Snowflake Cortex share it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zlens-sf-key-'));
    try {
      const path = join(dir, 'rsa_key.p8');
      writeFileSync(path, encryptedKey);
      const fromFile = await readSnowflakePrivateKey({ privateKeyPath: path, privateKeyPassphrase: 'correct-passphrase' });
      expect(fromFile).toContain('-----BEGIN PRIVATE KEY-----');
      expect(await readSnowflakePrivateKey({ privateKey: pkcs1Key })).toBe(fromFile);
      expect(await readSnowflakePrivateKey({})).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('what ZLens tells Snowflake about itself', () => {
  function connectorRecordingStatements(): { connector: SnowflakeConnector; sent: Array<Record<string, any>> } {
    const connector = new SnowflakeConnector();
    const sent: Array<Record<string, any>> = [];
    const statement = {
      getColumns: () => [],
      getStatementId: () => '01tagged',
      streamRows: () => Readable.from([]),
      cancel: (complete: () => void) => complete(),
    };
    (connector as any).connection = {
      execute: (options: Record<string, any>) => {
        sent.push(options);
        queueMicrotask(() => options.complete(undefined, statement));
        return statement;
      },
    };
    return { connector, sent };
  }

  it('names itself ZLens unless the connection names another application', async () => {
    fakeSdk.created.length = 0;
    await new SnowflakeConnector().connect({ driver: 'snowflake', account: 'acct', username: 'svc', password: 'x' });
    await new SnowflakeConnector().connect({ driver: 'snowflake', account: 'acct', username: 'svc', password: 'x', application: 'Acme_BI' });
    expect(fakeSdk.created.map((settings) => settings.application)).toEqual(['ZLens', 'Acme_BI']);
  });

  it('puts the connection\'s own query tag on each statement, not on the session (the session tag would replace ZLens\'s)', async () => {
    fakeSdk.created.length = 0;
    const connector = new SnowflakeConnector();
    await connector.connect({ driver: 'snowflake', account: 'acct', username: 'svc', password: 'x', queryTag: '{"team":"finance"}' });
    expect(fakeSdk.created[0]).not.toHaveProperty('queryTag');
    let sent: Record<string, any> | undefined;
    (connector as any).connection.execute = (options: Record<string, any>) => {
      sent = options;
      const statement = { getColumns: () => [], streamRows: () => Readable.from([]), cancel: (done: () => void) => done() };
      queueMicrotask(() => options.complete(undefined, statement));
      return statement;
    };
    await connector.execute('select 1');
    expect(JSON.parse(sent?.parameters.QUERY_TAG)).toEqual({ team: 'finance', zlens: { purpose: 'data' } });
  });

  it('tags every statement with its purpose and the labels of the work that sent it', async () => {
    const { connector, sent } = connectorRecordingStatements();
    await connector.execute('select 1');
    await connector.execute('select 2', [], { purpose: 'metadata' });
    await withQueryLabels({ action: 'ask', request: 'req-1' }, () =>
      withQueryLabels({ command: 'notebook', empty: '  ' }, () => connector.execute('select 3')));
    expect(sent.map((options) => JSON.parse(options.parameters.QUERY_TAG))).toEqual([
      { zlens: { purpose: 'data' } },
      { zlens: { purpose: 'metadata' } },
      { zlens: { purpose: 'data', action: 'ask', request: 'req-1', command: 'notebook' } },
    ]);
  });
});

describe('statements that share one Snowflake session', () => {
  it('each carry their own tag, as a parameter of the statement: nothing is set on the session, so nothing leaks to the next', async () => {
    const connector = new SnowflakeConnector();
    const sent: Array<Record<string, any>> = [];
    const waiting: Array<() => void> = [];
    const statement = { getColumns: () => [], getStatementId: () => '01shared', streamRows: () => Readable.from([]), cancel: (complete: () => void) => complete() };
    (connector as any).connection = {
      // Each statement answers only when the test lets it: all of them are under way at once.
      execute: (options: Record<string, any>) => { sent.push(options); waiting.push(() => options.complete(undefined, statement)); return statement; },
    };
    const people = ['req-a', 'req-b', 'req-c', 'req-d'];
    const running = people.map((request, n) => withQueryLabels({ action: n % 2 ? 'ask' : 'app', request }, () => connector.execute(`select ${n}`, [], { purpose: n === 3 ? 'metadata' : 'data' })));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toHaveLength(4);
    // Answered in the opposite order to the one they were sent in.
    for (const answer of waiting.reverse()) answer();
    await Promise.all(running);
    expect(sent.map((options) => [options.sqlText, JSON.parse(options.parameters.QUERY_TAG).zlens])).toEqual([
      ['select 0', { purpose: 'data', action: 'app', request: 'req-a' }],
      ['select 1', { purpose: 'data', action: 'ask', request: 'req-b' }],
      ['select 2', { purpose: 'data', action: 'app', request: 'req-c' }],
      ['select 3', { purpose: 'metadata', action: 'ask', request: 'req-d' }],
    ]);
    // Only a statement's own parameters carry anything: no statement changes the session (no ALTER SESSION, no USE).
    expect(sent.map((options) => options.sqlText).filter((sql: string) => /^\s*(alter\s+session|use\s)/i.test(sql))).toEqual([]);
    // After the labelled work, a statement with no labels carries none of them.
    const last = connector.execute('select 4');
    await new Promise((resolve) => setTimeout(resolve, 2));
    sent[4]!.complete(undefined, statement);
    await last;
    expect(JSON.parse(sent[4]!.parameters.QUERY_TAG)).toEqual({ zlens: { purpose: 'data' } });
  });
});

describe('snowflakeQueryTag', () => {
  const labels = { purpose: 'data', action: 'ask' };

  it('is ZLens\'s labels under a zlens key when the connection has no tag', () => {
    expect(JSON.parse(snowflakeQueryTag(undefined, labels))).toEqual({ zlens: labels });
    expect(JSON.parse(snowflakeQueryTag('  ', labels))).toEqual({ zlens: labels });
  });

  it('adds zlens to a customer\'s JSON tag and keeps their keys', () => {
    expect(JSON.parse(snowflakeQueryTag('{"cost_center":"42","team":"bi"}', labels)))
      .toEqual({ cost_center: '42', team: 'bi', zlens: labels });
  });

  it('keeps a customer\'s own tag exactly when it is not a JSON object, or already says zlens', () => {
    expect(snowflakeQueryTag('finance-dashboards', labels)).toBe('finance-dashboards');
    expect(snowflakeQueryTag('["a"]', labels)).toBe('["a"]');
    expect(snowflakeQueryTag('{"zlens":"prod"}', labels)).toBe('{"zlens":"prod"}');
  });

  it('never exceeds Snowflake\'s 2,000 characters: the customer\'s tag alone, or none', () => {
    const long = { purpose: 'data', note: 'x'.repeat(2_100) };
    expect(snowflakeQueryTag(undefined, long)).toBe('');
    expect(snowflakeQueryTag('{"team":"bi"}', long)).toBe('{"team":"bi"}');
  });
});

describe('signing in with a token read from a file (Snowflake\'s container token)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zlens-sf-token-'));
  const tokenFile = join(dir, 'token');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the file at every sign-in, so a reconnect gets the renewed token, and sends no empty user name', async () => {
    fakeSdk.created.length = 0;
    writeFileSync(tokenFile, 'first-token\n');
    await new SnowflakeConnector().connect({ driver: 'snowflake', account: 'acct', host: 'acct.snowflakecomputing.com', authMethod: 'oauth', tokenFilePath: tokenFile });
    writeFileSync(tokenFile, 'renewed-token');
    await new SnowflakeConnector().connect({ driver: 'snowflake', account: 'acct', host: 'acct.snowflakecomputing.com', authMethod: 'oauth', tokenFilePath: tokenFile });
    expect(fakeSdk.created.map((settings) => [settings.authenticator, settings.token])).toEqual([['OAUTH', 'first-token'], ['OAUTH', 'renewed-token']]);
    expect(fakeSdk.created[0]).not.toHaveProperty('username');
    expect(fakeSdk.created[0]).not.toHaveProperty('tokenFilePath');
  });

  it('serves a programmatic access token and workload identity too; a token given directly wins', async () => {
    fakeSdk.created.length = 0;
    writeFileSync(tokenFile, 'from-file');
    await new SnowflakeConnector().connect({ driver: 'snowflake', account: 'acct', username: 'svc', authMethod: 'programmatic_access_token', tokenFilePath: tokenFile });
    await new SnowflakeConnector().connect({ driver: 'snowflake', account: 'acct', username: 'svc', authMethod: 'workload_identity', workloadIdentityProvider: 'OIDC', tokenFilePath: tokenFile });
    await new SnowflakeConnector().connect({ driver: 'snowflake', account: 'acct', username: 'svc', authMethod: 'oauth', token: 'given', tokenFilePath: tokenFile });
    expect(fakeSdk.created.map((settings) => settings.token)).toEqual(['from-file', 'from-file', 'given']);
  });

  it('fails with the path, never the contents, when the file is missing or empty', async () => {
    await expect(readSnowflakeTokenFile(join(dir, 'absent'))).rejects.toThrow(/token file .*absent could not be read \(ENOENT\)/);
    writeFileSync(tokenFile, '  \n');
    await expect(readSnowflakeTokenFile(tokenFile)).rejects.toThrow(/token file .* is empty/);
    expect(await readSnowflakeTokenFile(undefined)).toBeUndefined();
  });
});

/**
 * A session that is not this connection's alone (`sessionRelease: 'abandon'`): letting go of it sends Snowflake no
 * logout, and nothing of the connection keeps running.
 */
describe('a Snowflake session that is abandoned, never ended', () => {
  /** An SDK connection that counts logouts and can carry the SDK's heartbeat timer. */
  const connectionOf = (withHeartbeat = false) => {
    const connection = {
      destroyed: 0,
      keepalive: undefined as ReturnType<typeof setInterval> | undefined,
      connect(done: (err?: Error) => void) {
        if (withHeartbeat) connection.keepalive = setInterval(() => undefined, 3_600_000);
        done();
      },
      destroy(done: (err?: Error) => void) { connection.destroyed += 1; done(); },
    };
    return connection;
  };
  const connect = async (config: Record<string, unknown>, connection = connectionOf()) => {
    const create = fakeSdk.sdk.createConnection;
    fakeSdk.created.length = 0;
    fakeSdk.sdk.createConnection = ((settings: Record<string, unknown>) => { fakeSdk.created.push(settings); return connection; }) as never;
    const connector = new SnowflakeConnector();
    try {
      await connector.connect({ driver: 'snowflake', account: 'acct', authMethod: 'oauth', token: 'a-token', ...config } as never);
    } finally {
      fakeSdk.sdk.createConnection = create;
    }
    return { connector, connection, settings: fakeSdk.created[0]! };
  };

  it('sends no logout when it is let go of, and forgets the connection', async () => {
    const { connector, connection } = await connect({ sessionRelease: 'abandon' });
    await connector.abandon();
    expect(connection.destroyed).toBe(0);
    expect(await connector.ping()).toBe(false);
    // Let go of twice, or then disconnected: still nothing is sent.
    await connector.abandon();
    await connector.disconnect();
    expect(connection.destroyed).toBe(0);
    // Without the setting, disconnect is the logout it always was.
    const ended = await connect({});
    await ended.connector.disconnect();
    expect(ended.connection.destroyed).toBe(1);
  });

  it('signs in with the session keep-alive off by name, whatever the account\'s own setting is', async () => {
    expect((await connect({ sessionRelease: 'abandon' })).settings.clientSessionKeepAlive).toBe(false);
    expect((await connect({ sessionRelease: 'abandon', clientSessionKeepAlive: false })).settings.clientSessionKeepAlive).toBe(false);
    // Asking for both is refused before anything is sent.
    fakeSdk.created.length = 0;
    await expect(new SnowflakeConnector().connect({ driver: 'snowflake', account: 'acct', authMethod: 'oauth', token: 'a-token', sessionRelease: 'abandon', clientSessionKeepAlive: true } as never))
      .rejects.toThrow('cannot keep its session alive (clientSessionKeepAlive)');
    expect(fakeSdk.created).toEqual([]);
    // A connection of its own is left as it was: unset stays unset (the account decides), and a host may still turn it off.
    expect('clientSessionKeepAlive' in (await connect({})).settings).toBe(false);
    expect((await connect({ clientSessionKeepAlive: false })).settings.clientSessionKeepAlive).toBe(false);
    expect((await connect({ clientSessionKeepAlive: true })).settings.clientSessionKeepAlive).toBe(true);
  });

  it('stops a heartbeat timer the SDK started all the same, so nothing keeps the session or the process alive', async () => {
    vi.useFakeTimers();
    try {
      const { connector, connection } = await connect({ sessionRelease: 'abandon' }, connectionOf(true));
      expect(vi.getTimerCount()).toBe(1);
      await connector.abandon();
      expect(vi.getTimerCount()).toBe(0);
      expect(connection.keepalive).toBeUndefined();
      expect(connection.destroyed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
