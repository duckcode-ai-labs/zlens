import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CORTEX_DEFAULT_MODEL,
  CortexClaudeProvider,
  cortexBaseUrl,
  cortexClaudeTransport,
  isCortexClaudeProvider,
  snowflakeHost,
  snowflakeJwtAccount,
  snowflakeKeyPairJwt,
  snowflakeKeyPairToken,
  snowflakeTokenFileToken,
} from './claude-cortex.js';
import { retiresSampling } from './claude.js';
import { supportsReasoningEffort } from './reasoning-effort.js';

/**
 * Claude through Snowflake Cortex, checked against a fake fetch: the Messages
 * request ZLens sends, at the account's Cortex address, signed in with a
 * Snowflake token instead of an Anthropic key. Never calls Snowflake.
 */
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
  };
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')) as Record<string, unknown>;
}

const staticToken = (token: string) => async () => ({ token, type: 'PROGRAMMATIC_ACCESS_TOKEN' as const });

describe('the Snowflake account address', () => {
  it('uses the connection host when set, else <account>.snowflakecomputing.com with hyphens for underscores', () => {
    expect(snowflakeHost({ account: 'MyOrg-My_Account' })).toBe('myorg-my-account.snowflakecomputing.com');
    expect(snowflakeHost({ account: 'xy12345.us-east-1' })).toBe('xy12345.us-east-1.snowflakecomputing.com');
    expect(snowflakeHost({ account: 'myorg-acct.snowflakecomputing.com' })).toBe('myorg-acct.snowflakecomputing.com');
    expect(snowflakeHost({ account: 'ignored', host: 'https://Acct.privatelink.snowflakecomputing.com/' })).toBe('acct.privatelink.snowflakecomputing.com');
    expect(snowflakeHost({})).toBeUndefined();
    expect(cortexBaseUrl('acct.snowflakecomputing.com')).toBe('https://acct.snowflakecomputing.com/api/v2/cortex');
  });

  it('names the account in a JWT upper case, without region or domain', () => {
    expect(snowflakeJwtAccount('myorg-my_account')).toBe('MYORG-MY_ACCOUNT');
    expect(snowflakeJwtAccount('xy12345.us-east-1')).toBe('XY12345');
    expect(snowflakeJwtAccount('https://myorg-acct.snowflakecomputing.com')).toBe('MYORG-ACCT');
  });
});

describe('the Cortex transport', () => {
  it('keeps the URL, body and model, drops the Anthropic key, and adds the Snowflake token and its type', async () => {
    const transport = cortexClaudeTransport({ token: async () => ({ token: 'jwt-abc', type: 'KEYPAIR_JWT' }) });
    const prepared = await transport.prepare({
      url: 'https://acct.snowflakecomputing.com/api/v2/cortex/v1/messages',
      body: { model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'x-api-key': 'never-sent', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    });
    expect(prepared.url).toBe('https://acct.snowflakecomputing.com/api/v2/cortex/v1/messages');
    expect(JSON.parse(prepared.body)).toEqual({ model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(prepared.headers['x-api-key']).toBeUndefined();
    expect(prepared.headers).toMatchObject({
      authorization: 'Bearer jwt-abc',
      'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    });
    const streamed = await transport.prepare({ url: 'u', body: { model: 'm', stream: true }, headers: { Authorization: 'Bearer other' } });
    expect(JSON.parse(streamed.body).stream).toBe(true);
    expect(streamed.headers).toMatchObject({ accept: 'text/event-stream', authorization: 'Bearer jwt-abc' });
    await expect(transport.prepare({ url: 'u', body: { max_tokens: 1 }, headers: {} })).rejects.toThrow('model');
  });

  it('answers through the provider at the account\'s Cortex address, with the model in the body', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Revenue rose 8%.' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const provider = new CortexClaudeProvider({ host: snowflakeHost({ account: 'myorg-acct' })!, token: staticToken('pat-1') });
    expect(provider.name).toBe('claude');
    expect(isCortexClaudeProvider(provider)).toBe(true);
    expect(isCortexClaudeProvider({ name: 'claude' })).toBe(false);
    expect((provider as unknown as { baseUrl: string }).baseUrl).toBe('https://myorg-acct.snowflakecomputing.com/api/v2/cortex');
    expect(await provider.available()).toBe(true);
    expect(await provider.generate([{ role: 'user', content: 'Why?' }], { maxTokens: 1 })).toBe('Revenue rose 8%.');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://myorg-acct.snowflakecomputing.com/api/v2/cortex/v1/messages');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: CORTEX_DEFAULT_MODEL, max_tokens: 1 });
    // claude-sonnet-5 has retired temperature: none is sent.
    expect(body.temperature).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers).toMatchObject({ authorization: 'Bearer pat-1', 'x-snowflake-authorization-token-type': 'PROGRAMMATIC_ACCESS_TOKEN' });
  });

  it('streams Anthropic server-sent events from Cortex', async () => {
    const sse = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claims "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"fell."}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const fetch = vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const provider = new CortexClaudeProvider({ host: 'acct.snowflakecomputing.com', model: 'claude-opus-5', token: staticToken('t') });
    const deltas: string[] = [];
    expect(await provider.generateStream!([{ role: 'user', content: 'x' }], {}, (delta) => deltas.push(delta))).toBe('Claims fell.');
    expect(deltas).toEqual(['Claims ', 'fell.']);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://acct.snowflakecomputing.com/api/v2/cortex/v1/messages');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'claude-opus-5', stream: true });
  });

  it('recognises Cortex model ids for reasoning effort and retired sampling', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-4-8']) {
      expect(supportsReasoningEffort('claude', model)).toBe(true);
      expect(retiresSampling(model)).toBe(true);
    }
    // Haiku 4.5 rejects an effort and still takes a temperature.
    expect(supportsReasoningEffort('claude', 'claude-haiku-4-5')).toBe(false);
    expect(retiresSampling('claude-haiku-4-5')).toBe(false);
  });
});

describe('Snowflake sign-in tokens', () => {
  it('mints a key-pair JWT whose claims name the account, user and public key, signed RS256', () => {
    const { privateKey, publicKey } = keyPair();
    const now = new Date('2026-11-08T12:00:00Z');
    const { token, expiresAt } = snowflakeKeyPairJwt({ account: 'myorg-acct.snowflakecomputing.com', user: 'svc_zlens', privateKey, now });
    const [header, payload, signature] = token.split('.');
    expect(decode(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const claims = decode(payload!);
    expect(claims).toEqual({
      iss: `MYORG-ACCT.SVC_ZLENS.SHA256:${fingerprint}`,
      sub: 'MYORG-ACCT.SVC_ZLENS',
      iat: now.getTime() / 1000,
      exp: now.getTime() / 1000 + 59 * 60,
    });
    expect(expiresAt.getTime() - now.getTime()).toBeLessThanOrEqual(3600 * 1000);
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}x`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(false);
    // Never longer than Snowflake's hour.
    const long = snowflakeKeyPairJwt({ account: 'a', user: 'u', privateKey, now, lifetimeSeconds: 7200 });
    expect(long.expiresAt.getTime() - now.getTime()).toBe(3600 * 1000);
  });

  it('reuses a JWT until five minutes before it expires, then mints a new one; the key is read only for a new one', async () => {
    const { privateKey } = keyPair();
    let clock = new Date('2026-11-08T12:00:00Z');
    const read = vi.fn(async () => privateKey);
    const source = snowflakeKeyPairToken({ account: 'acct', user: 'svc', privateKey: read, now: () => clock });
    const first = await source();
    expect(first.type).toBe('KEYPAIR_JWT');
    clock = new Date('2026-11-08T12:50:00Z');
    expect((await source()).token).toBe(first.token);
    // A provider built for the next request shares the process's JWT.
    expect((await snowflakeKeyPairToken({ account: 'acct', user: 'svc', privateKey, now: () => clock })()).token).toBe(first.token);
    clock = new Date('2026-11-08T12:55:00Z');
    const renewed = await source();
    expect(renewed.token).not.toBe(first.token);
    expect(decode(renewed.token.split('.')[1]!).iat).toBe(clock.getTime() / 1000);
  });

  it('reads a token file again on every call (Snowflake rewrites a container\'s token every few minutes)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zlens-cortex-token-'));
    roots.push(dir);
    const path = join(dir, 'token');
    writeFileSync(path, 'oauth-one\n');
    const source = snowflakeTokenFileToken({ type: 'OAUTH', path });
    expect(await source()).toEqual({ token: 'oauth-one', type: 'OAUTH' });
    writeFileSync(path, 'oauth-two');
    expect(await source()).toEqual({ token: 'oauth-two', type: 'OAUTH' });
    writeFileSync(path, '  ');
    await expect(source()).rejects.toThrow(/is empty/);
    await expect(snowflakeTokenFileToken({ type: 'OAUTH', path: join(dir, 'missing') })()).rejects.toThrow(/could not be read \(ENOENT\)/);
  });

  it('sends a programmatic access token from a file with its own token type', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const read = vi.fn(async () => 'pat-from-file');
    const provider = new CortexClaudeProvider({ host: 'acct.snowflakecomputing.com', token: snowflakeTokenFileToken({ type: 'PROGRAMMATIC_ACCESS_TOKEN', path: '/run/pat', read }) });
    await provider.generate([{ role: 'user', content: 'x' }]);
    await provider.generate([{ role: 'user', content: 'y' }]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith('/run/pat');
    const headers = (fetch.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers).toMatchObject({ authorization: 'Bearer pat-from-file', 'x-snowflake-authorization-token-type': 'PROGRAMMATIC_ACCESS_TOKEN' });
  });
});
