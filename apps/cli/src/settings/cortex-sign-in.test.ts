import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionConfig } from '@zlens/connectors';
import { isCortexClaudeProvider } from '@zlens/agent';
import {
  cortexInProjectAccount,
  cortexSignIn,
  createCortexProvider,
  setProjectConnectionLookup,
} from './cortex-sign-in.js';
import {
  allowedModelProviders,
  getActiveProvider,
  getEffectiveProviderConfig,
  listProviderSettings,
  saveProviderSettings,
} from './provider-settings.js';

/**
 * Snowflake Cortex signs in with the project's own Snowflake connection. The
 * server's connection reader is replaced by a fake here; fetch is faked, so
 * nothing reaches Snowflake.
 */
let root: string;
let connections: Record<string, ConnectionConfig>;
let defaultName: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zlens-cortex-sign-in-'));
  connections = {};
  defaultName = undefined;
  setProjectConnectionLookup((_projectRoot, name) => {
    const id = name ?? defaultName;
    return id ? { name: id, connection: connections[id] ?? null } : { connection: null };
  });
});

afterEach(() => {
  setProjectConnectionLookup(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function keyPairConnection(): { connection: ConnectionConfig; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'] } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const path = join(root, 'rsa_key.p8');
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  return {
    connection: { driver: 'snowflake', account: 'myorg-test_acct', username: 'svc_zlens', authMethod: 'key_pair', privateKeyPath: path },
    publicKey,
  };
}

const okReply = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), { status: 200 });

describe('which connection Cortex signs in with', () => {
  it('signs in with the project\'s default Snowflake connection by key pair, programmatic access token or OAuth token', () => {
    defaultName = 'snowflake';
    connections.snowflake = keyPairConnection().connection;
    expect(cortexSignIn(root)).toEqual({ connection: 'snowflake', method: 'key_pair' });
    connections.snowflake = { driver: 'snowflake', account: 'acct', authMethod: 'programmatic_access_token', token: 'pat' };
    expect(cortexSignIn(root)).toEqual({ connection: 'snowflake', method: 'programmatic_access_token' });
    connections.snowflake = { driver: 'snowflake', account: 'acct', host: 'acct.example.snowflakecomputing.com', authMethod: 'oauth', tokenFilePath: '/snowflake/session/token' };
    expect(cortexSignIn(root)).toEqual({ connection: 'snowflake', method: 'oauth' });
  });

  it('says in one sentence why it cannot sign in with any other connection', () => {
    expect(cortexSignIn(root).problem).toBe('Snowflake Cortex signs in with this project\'s Snowflake connection, and the project has none.');
    defaultName = 'warehouse';
    connections.warehouse = { driver: 'duckdb', filepath: 'w.duckdb' };
    expect(cortexSignIn(root).problem).toBe('Snowflake Cortex signs in with a Snowflake connection; the connection "warehouse" is a duckdb connection.');
    connections.warehouse = { driver: 'snowflake', account: 'acct', username: 'u', password: 'p' };
    expect(cortexSignIn(root)).toEqual({
      connection: 'warehouse',
      method: 'password',
      problem: 'Snowflake Cortex signs in with your Snowflake connection\'s key pair, programmatic access token or OAuth token; this connection uses a password.',
    });
    connections.warehouse = { driver: 'snowflake', account: 'acct', username: 'u', authMethod: 'external_browser' };
    expect(cortexSignIn(root).problem).toMatch(/this connection uses browser single sign-on\.$/);
    connections.warehouse = { driver: 'snowflake', account: '${SNOWFLAKE_ACCOUNT}', authMethod: 'oauth', token: 't' };
    expect(cortexSignIn(root).problem).toBe('Snowflake Cortex cannot sign in yet: the connection "warehouse" reads ${SNOWFLAKE_ACCOUNT}, which is not set on this server.');
    connections.warehouse = { driver: 'snowflake', account: 'acct', authMethod: 'key_pair', privateKey: 'pem' };
    expect(cortexSignIn(root).problem).toMatch(/names none\.$/);
    expect(cortexSignIn(root, 'other').problem).toBe('Snowflake Cortex signs in with the connection "other", which this project does not have.');
  });
});

describe('Snowflake Cortex in provider settings', () => {
  it('is configured when the default connection is Snowflake with a sign-in Cortex accepts, and stays off until chosen', () => {
    defaultName = 'snowflake';
    connections.snowflake = keyPairConnection().connection;
    const cortex = listProviderSettings(root).find((provider) => provider.id === 'cortex')!;
    expect(cortex).toMatchObject({ label: 'Snowflake Cortex', authMode: 'snowflake_connection', configured: true, enabled: false, hasApiKey: false, supportsReasoningEffort: true, connectionSignIn: { connection: 'snowflake', method: 'key_pair' } });
    // It spends Snowflake credits: a Snowflake project does not start using it until someone chooses it.
    expect(getActiveProvider(root)).toBeUndefined();
    saveProviderSettings(root, { id: 'cortex', enabled: true, model: 'claude-opus-5', apiKey: 'never-kept', baseUrl: 'https://never.kept' });
    expect(getActiveProvider(root)).toBe('cortex');
    expect(listProviderSettings(root).find((provider) => provider.id === 'cortex')).toMatchObject({ enabled: true, active: true, model: 'claude-opus-5' });
    expect(getEffectiveProviderConfig(root, 'cortex')).toEqual({ model: 'claude-opus-5', enabled: true, reasoningEffort: undefined });
  });

  it('is not configured, with the reason, when the connection signs in some other way', () => {
    defaultName = 'snowflake';
    connections.snowflake = { driver: 'snowflake', account: 'acct', username: 'u', password: 'p' };
    const cortex = listProviderSettings(root).find((provider) => provider.id === 'cortex')!;
    expect(cortex.configured).toBe(false);
    expect(cortex.connectionSignIn?.problem).toMatch(/this connection uses a password\.$/);
  });

  it('keeps a named connection in its settings, and signs in with it', () => {
    defaultName = 'snowflake';
    connections.snowflake = { driver: 'snowflake', account: 'acct', username: 'u', password: 'p' };
    connections.cortex_pat = { driver: 'snowflake', account: 'acct', authMethod: 'programmatic_access_token', token: 'pat' };
    saveProviderSettings(root, { id: 'cortex', enabled: true, connection: ' cortex_pat ' });
    expect(getEffectiveProviderConfig(root, 'cortex').connection).toBe('cortex_pat');
    expect(listProviderSettings(root).find((provider) => provider.id === 'cortex')).toMatchObject({ configured: true, connection: 'cortex_pat', connectionSignIn: { connection: 'cortex_pat', method: 'programmatic_access_token' } });
    saveProviderSettings(root, { id: 'cortex', connection: '' });
    expect(getEffectiveProviderConfig(root, 'cortex').connection).toBeUndefined();
  });

  it('is the only provider, on by default, when the install allows only Cortex (ZLENS_MODEL_PROVIDERS=cortex)', () => {
    defaultName = 'snowflake';
    connections.snowflake = { driver: 'snowflake', account: 'acct', host: 'acct.snowflakecomputing.com', authMethod: 'oauth', tokenFilePath: '/snowflake/session/token' };
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-not-real');
    vi.stubEnv('ZLENS_MODEL_PROVIDERS', 'cortex');
    expect(allowedModelProviders()).toEqual(['cortex']);
    const listed = listProviderSettings(root);
    expect(listed.filter((provider) => provider.allowed).map((provider) => provider.id)).toEqual(['cortex']);
    expect(listed.find((provider) => provider.id === 'cortex')).toMatchObject({ enabled: true, configured: true });
    expect(listed.find((provider) => provider.id === 'anthropic')).toMatchObject({ enabled: false, configured: false });
  });
});

describe('the Cortex provider built from the connection', () => {
  it('signs in with a key-pair JWT for the connection\'s account and user, at the account\'s Cortex address', async () => {
    const { connection, publicKey } = keyPairConnection();
    defaultName = 'snowflake';
    connections.snowflake = connection;
    const fetch = vi.fn(async () => okReply());
    vi.stubGlobal('fetch', fetch);
    const provider = createCortexProvider(root, {});
    expect(isCortexClaudeProvider(provider)).toBe(true);
    expect((provider as unknown as { baseUrl: string }).baseUrl).toBe('https://myorg-test-acct.snowflakecomputing.com/api/v2/cortex');
    await provider.generate([{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 1 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://myorg-test-acct.snowflakecomputing.com/api/v2/cortex/v1/messages');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 1 });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-snowflake-authorization-token-type']).toBe('KEYPAIR_JWT');
    const [header, payload, signature] = headers.authorization!.replace(/^Bearer /, '').split('.');
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toMatchObject({ sub: 'MYORG-TEST_ACCT.SVC_ZLENS' });
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('reads a token file again for every call, and sends a programmatic access token as one', async () => {
    const tokenPath = join(root, 'token');
    writeFileSync(tokenPath, 'session-one');
    defaultName = 'snowflake';
    connections.snowflake = { driver: 'snowflake', account: 'acct', host: 'acct.region.snowflakecomputing.com', authMethod: 'oauth', tokenFilePath: tokenPath };
    connections.pat = { driver: 'snowflake', account: 'acct', authMethod: 'programmatic_access_token', token: 'pat-secret' };
    const fetch = vi.fn(async () => okReply());
    vi.stubGlobal('fetch', fetch);
    const provider = createCortexProvider(root, { model: 'claude-haiku-4-5' });
    await provider.generate([{ role: 'user', content: 'x' }]);
    writeFileSync(tokenPath, 'session-two');
    await provider.generate([{ role: 'user', content: 'y' }]);
    const sent = fetch.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].headers as Record<string, string>);
    expect(sent.map((headers) => headers.authorization)).toEqual(['Bearer session-one', 'Bearer session-two']);
    expect(sent[0]!['x-snowflake-authorization-token-type']).toBe('OAUTH');
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://acct.region.snowflakecomputing.com/api/v2/cortex/v1/messages');
    await createCortexProvider(root, { connection: 'pat' }).generate([{ role: 'user', content: 'z' }]);
    expect((fetch.mock.calls[2] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: 'Bearer pat-secret', 'x-snowflake-authorization-token-type': 'PROGRAMMATIC_ACCESS_TOKEN' });
  });

  it('is not built for a connection Cortex cannot sign in with', () => {
    defaultName = 'snowflake';
    connections.snowflake = { driver: 'snowflake', account: 'acct', username: 'u', password: 'p' };
    expect(() => createCortexProvider(root)).toThrow(/this connection uses a password/);
  });
});

describe('the Cortex data boundary', () => {
  it('lets result values reach Cortex signed in through the project\'s own Snowflake connection', () => {
    defaultName = 'snowflake';
    connections.snowflake = keyPairConnection().connection;
    expect(cortexInProjectAccount(root)).toBe(true);
    expect(cortexInProjectAccount(root, undefined, 'https://myorg-test-acct.snowflakecomputing.com/api/v2/cortex')).toBe(true);
    // Another connection to the same account (another user or role) is still the project's account.
    connections.same_account = { driver: 'snowflake', account: 'MYORG-TEST_ACCT', authMethod: 'programmatic_access_token', token: 'pat' };
    expect(cortexInProjectAccount(root, 'same_account')).toBe(true);
  });

  it('does not when Cortex signs in through another account, sends elsewhere, or the project\'s data is not in Snowflake', () => {
    defaultName = 'snowflake';
    connections.snowflake = keyPairConnection().connection;
    connections.elsewhere = { driver: 'snowflake', account: 'other-acct', authMethod: 'programmatic_access_token', token: 'pat' };
    expect(cortexInProjectAccount(root, 'elsewhere')).toBe(false);
    expect(cortexInProjectAccount(root, undefined, 'https://other-acct.snowflakecomputing.com/api/v2/cortex')).toBe(false);
    defaultName = 'local';
    connections.local = { driver: 'duckdb', filepath: 'w.duckdb' };
    expect(cortexInProjectAccount(root, 'elsewhere')).toBe(false);
  });
});
