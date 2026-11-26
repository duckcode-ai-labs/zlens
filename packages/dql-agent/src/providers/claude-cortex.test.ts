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
  cortexFailureInWords,
  cortexFailureKind,
  cortexModelChoice,
  cortexSqlComplete,
  CORTEX_CLAUDE_FALLBACK_MODELS,
  isCortexRestRefusal,
  messagesRequestAsPrompt,
  resetCortexModelChoice,
  resetCortexRoute,
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

describe('when Snowflake refuses the Cortex REST API', () => {
  const refused = () => new Response(JSON.stringify({ code: '003001', message: 'This account is not allowed to access this endpoint. Please contact Snowflake support.', request_id: 'r1', error_code: '003001' }), { status: 403 });
  const answer = (text: string) => [{ R: JSON.stringify({ choices: [{ messages: text }], usage: { prompt_tokens: 40, completion_tokens: 6 } }) }];
  afterEach(() => resetCortexRoute());

  it('tells a refusal of the endpoint from any other 403', () => {
    expect(isCortexRestRefusal(403, '{"code":"003001","message":"This account is not allowed to access this endpoint."}')).toBe(true);
    expect(isCortexRestRefusal(403, '{"message":"Insufficient privileges"}')).toBe(false);
    expect(isCortexRestRefusal(400, '003001')).toBe(false);
  });

  it('turns a Messages request into the one text AI_COMPLETE takes', () => {
    expect(messagesRequestAsPrompt({ system: 'Answer in JSON.', messages: [{ role: 'user', content: 'What is 17 + 25?' }] })).toBe('Answer in JSON.\n\nWhat is 17 + 25?');
    expect(messagesRequestAsPrompt({ messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }, { role: 'user', content: 'Total?' }] }))
      .toBe('User:\nHi\n\nAssistant:\nHello\n\nUser:\nTotal?');
  });

  it('answers through AI_COMPLETE on the same connection, then stays on SQL until it tries REST again', async () => {
    const fetch = vi.fn(async () => refused());
    vi.stubGlobal('fetch', fetch);
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const sql = async (statement: string, binds: unknown[]) => { calls.push({ sql: statement, binds }); return answer('{"answer": 42}'); };
    const provider = new CortexClaudeProvider({ host: 'myorg-acct.snowflakecomputing.com', token: staticToken('t'), sql });
    expect(provider.route()).toBe('rest');
    expect(await provider.generate([{ role: 'system', content: 'JSON only.' }, { role: 'user', content: 'What is 17 + 25?' }], { maxTokens: 50 })).toBe('{"answer": 42}');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls[0]!.sql).toContain('AI_COMPLETE');
    expect(calls[0]!.binds).toEqual([CORTEX_DEFAULT_MODEL, 'JSON only.\n\nWhat is 17 + 25?', JSON.stringify({ max_tokens: 50 })]);
    expect(provider.route()).toBe('sql');
    // Remembered: the next request does not try the refused endpoint first.
    expect(await provider.generate([{ role: 'user', content: 'Again?' }], { maxTokens: 5 })).toBe('{"answer": 42}');
    expect(fetch).toHaveBeenCalledTimes(1);
    resetCortexRoute('myorg-acct.snowflakecomputing.com');
    expect(provider.route()).toBe('rest');
  });

  it('streams the SQL answer as Anthropic server-sent events, and refuses tool calls with a plain reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refused()));
    const provider = new CortexClaudeProvider({ host: 'h.snowflakecomputing.com', token: staticToken('t'), sql: async () => answer('Revenue rose 8%.') });
    const deltas: string[] = [];
    expect(await provider.generateStream([{ role: 'user', content: 'Why?' }], { maxTokens: 20 }, (delta) => deltas.push(delta))).toBe('Revenue rose 8%.');
    expect(deltas.join('')).toBe('Revenue rose 8%.');
    const tools = await cortexSqlComplete(async () => answer('x'), JSON.stringify({ model: 'm', tools: [{ name: 't' }], messages: [] }));
    expect(tools.status).toBe(503);
    expect(await tools.text()).toContain('tool calls have no route through Cortex SQL');
  });

  it('keeps other errors as they are, and reports a failed SQL call plainly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Insufficient privileges"}', { status: 403 })));
    const provider = new CortexClaudeProvider({ host: 'h2.snowflakecomputing.com', token: staticToken('t'), sql: async () => answer('never') });
    await expect(provider.generate([{ role: 'user', content: 'Q' }], { maxTokens: 5 })).rejects.toThrow('403');
    expect(provider.route()).toBe('rest');
    const failed = await cortexSqlComplete(async () => { throw new Error('Unknown function AI_COMPLETE'); }, JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'Q' }] }));
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain('Cortex through SQL failed: Unknown function AI_COMPLETE');
  });

  it('says what went wrong in plain words, keeping the HTTP status the diagnostics read', async () => {
    const restOnly = 'claude: 403 {"code":"003001","message":"This account is not allowed to access this endpoint. Please contact Snowflake support."}';
    // REST off (003001) is the usual case, never told as a step to take: only that SQL, the usual route, is missing here.
    expect(cortexFailureInWords(restOnly)).toBe('Snowflake keeps the Cortex REST API off for this account (HTTP 403, error 003001), as it does for most accounts, and here ZLens has no Snowflake connection to ask Cortex through SQL (AI_COMPLETE) instead, the usual route. Ask from the ZLens server or app.');
    expect(cortexFailureInWords('claude: 403 {"code":"003001","message":"not allowed"}')).toContain('error 003001');
    const sqlToo = 'claude: 502 {"type":"error","error":{"type":"api_error","message":"Cortex through SQL failed: Warehouse is suspended."}}';
    expect(cortexFailureInWords(sqlToo)).toBe('Cortex through SQL (AI_COMPLETE) failed: Warehouse is suspended (HTTP 502).');
    const noGrant = 'claude: 502 {"type":"error","error":{"type":"api_error","message":"Cortex through SQL failed: SQL compilation error: Unknown function AI_COMPLETE"}}';
    expect(cortexFailureInWords(noGrant)).toContain('grant it the SNOWFLAKE.CORTEX_USER database role');
    expect(cortexFailureInWords(noGrant)).toContain('(HTTP 502)');
    expect(cortexFailureInWords('claude: 400 {"message":"Model claude-x is not available in your region."}')).toContain('CORTEX_ENABLED_CROSS_REGION');
    expect(cortexFailureInWords('claude: 503 {"type":"error","error":{"message":"Snowflake refuses the Cortex REST API for this account, and tool calls have no route through Cortex SQL."}}'))
      .toContain('needs tool calls');
    // Anything else stays as Snowflake said it.
    expect(cortexFailureInWords('claude: 429 {"message":"Too many requests"}')).toBeUndefined();

    // The provider throws the plain words, and a missing grant is named.
    vi.stubGlobal('fetch', vi.fn(async () => refused()));
    const provider = new CortexClaudeProvider({ host: 'h3.snowflakecomputing.com', token: staticToken('t'), sql: async () => { throw new Error('SQL compilation error: Unknown function AI_COMPLETE'); } });
    await expect(provider.generate([{ role: 'user', content: 'Q' }], { maxTokens: 5 })).rejects.toThrow(/cannot use Cortex.*CORTEX_USER.*HTTP 502/);
  });
});

/**
 * Snowflake's error shapes, as its docs give them (Cortex REST API status codes, 25 Nov 2026) and as seen live:
 * - REST, CORTEX_USER missing: 403 "Not Authorized" ("the default role ... does not have the snowflake.cortex_user
 *   database role"); the 003001 refusal is the account, not the role (live, 9 Nov 2026).
 * - REST, a model Cortex does not offer: 400 "unknown model <name>".
 * - SQL, CORTEX_USER missing: "SQL compilation error: Unknown function AI_COMPLETE".
 */
const restNoGrant = () => new Response(JSON.stringify({ message: 'Not Authorized. The default role for the calling user does not have the snowflake.cortex_user database role.' }), { status: 403 });
const restUnknownModel = (model: string) => new Response(JSON.stringify({ message: `unknown model "${model}"` }), { status: 400 });
const restNotInRegion = (model: string) => new Response(JSON.stringify({ message: `Model ${model} is not available in your region.` }), { status: 400 });
const ok = (text = 'OK') => new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
const bodyModel = (init: RequestInit | undefined) => JSON.parse(String(init?.body)).model as string;

describe('what kind of Cortex failure it is', () => {
  it('names the missing grant, the region, an unknown model and the refused REST API apart', () => {
    expect(cortexFailureKind('claude: 403 {"message":"Not Authorized. The default role does not have the snowflake.cortex_user database role."}')?.kind).toBe('grant');
    expect(cortexFailureKind('claude: 403 {"message":"Insufficient privileges"}')?.kind).toBe('grant');
    expect(cortexFailureKind('claude: 502 {"error":{"message":"Cortex through SQL failed: SQL compilation error: Unknown function AI_COMPLETE"}}')?.kind).toBe('grant');
    expect(cortexFailureKind('claude: 400 {"message":"Model claude-sonnet-5-5 is not available in your region."}')?.kind).toBe('region');
    expect(cortexFailureKind('claude: 400 {"message":"unknown model \\"claude-sonnet-5-5\\""}')?.kind).toBe('model');
    expect(cortexFailureKind('claude: 403 {"code":"003001","message":"This account is not allowed to access this endpoint."}')?.kind).toBe('rest_refused');
    expect(cortexFailureKind('claude: 502 {"error":{"message":"Cortex through SQL failed: Warehouse is suspended."}}')?.kind).toBe('sql_failed');
    expect(cortexFailureKind('claude: 429 {"message":"Too many requests"}')).toBeUndefined();
  });

  it('names the installed app in the grant, so the admin can run the line as it is', () => {
    const words = cortexFailureInWords('claude: 403 {"message":"Not Authorized"}', { appName: 'ZLENS_APP' });
    expect(words).toContain('GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP');
    expect(words).toContain('(HTTP 403)');
    expect(cortexFailureInWords('claude: 403 {"message":"Not Authorized"}', { role: 'ANALYST' })).toContain('(for this role: GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE ANALYST)');
    // Without a name, the placeholder stays as before.
    expect(cortexFailureInWords('claude: 403 {"message":"Not Authorized"}')).toContain('TO APPLICATION <app name>');
    expect(cortexFailureInWords('claude: 400 {"message":"unknown model \\"claude-x\\""}')).toContain('Pick another Claude model in Settings » AI');
  });
});

describe('cancel on give-up: the AI_COMPLETE statement is cancelled when Ask stops waiting', () => {
  afterEach(() => resetCortexRoute());
  const refused = () => new Response(JSON.stringify({ code: '003001', message: 'This account is not allowed to access this endpoint.' }), { status: 403 });

  it('hands the run\'s signal to the SQL runner, which cancels the statement, and stops waiting at once', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refused()));
    let seen: AbortSignal | undefined;
    let cancelled = 0;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    // A runner like the CLI's: it passes the signal to the Snowflake driver, which cancels the running statement.
    const sql = (statement: string, _binds: unknown[], options?: { signal?: AbortSignal }) => new Promise<Array<Record<string, unknown>>>((_resolve, reject) => {
      expect(statement).toContain('AI_COMPLETE');
      seen = options?.signal;
      options?.signal?.addEventListener('abort', () => { cancelled += 1; setTimeout(() => reject(new Error('SQL execution canceled')), 50); });
      started();
    });
    const provider = new CortexClaudeProvider({ host: 'cancel.snowflakecomputing.com', token: staticToken('t'), sql });
    const controller = new AbortController();
    const asked = provider.generate([{ role: 'user', content: 'Q' }], { maxTokens: 5, signal: controller.signal });
    await running;
    const gaveUpAt = Date.now();
    controller.abort(new Error('Ask stopped waiting'));
    await expect(asked).rejects.toThrow('Ask stopped waiting');
    expect(Date.now() - gaveUpAt).toBeLessThan(50);
    expect(seen?.aborted).toBe(true);
    expect(cancelled).toBe(1);
  });

  it('cancels when a long request is abandoned (the second signal), and never starts once it is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refused()));
    const abandon = new AbortController();
    const signals: AbortSignal[] = [];
    const sql = (_statement: string, _binds: unknown[], options?: { signal?: AbortSignal }) => new Promise<Array<Record<string, unknown>>>(() => {
      if (options?.signal) signals.push(options.signal);
    });
    const provider = new CortexClaudeProvider({ host: 'abandon.snowflakecomputing.com', token: staticToken('t'), sql, abandoned: () => abandon.signal });
    const asked = provider.generate([{ role: 'user', content: 'Q' }], { maxTokens: 5 });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    abandon.abort(new Error('no one polls this long request'));
    await expect(asked).rejects.toThrow('no one polls');
    expect(signals[0]!.aborted).toBe(true);
    const runner = vi.fn(async () => [] as Array<Record<string, unknown>>);
    await expect(cortexSqlComplete(runner, JSON.stringify({ model: 'm', messages: [] }), { signal: abandon.signal })).rejects.toThrow('no one polls');
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('model fallback by region', () => {
  afterEach(() => { resetCortexModelChoice(); resetCortexRoute(); });

  it('lists the Claude models in the order Snowflake\'s availability table supports', () => {
    expect(CORTEX_CLAUDE_FALLBACK_MODELS[0]).toBe(CORTEX_DEFAULT_MODEL);
    expect(CORTEX_CLAUDE_FALLBACK_MODELS).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5']);
  });

  it('asks the next Claude model when the default is not offered in the region, remembers it, and says which model Ask uses', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => (bodyModel(init) === 'claude-sonnet-5-5' ? restNotInRegion('claude-sonnet-5-5') : ok('Fine.')));
    vi.stubGlobal('fetch', fetch);
    const provider = new CortexClaudeProvider({ host: 'jp.snowflakecomputing.com', token: staticToken('t') });
    expect(provider.automaticModel).toBe(true);
    expect(await provider.generate([{ role: 'user', content: 'Q' }], { maxTokens: 5 })).toBe('Fine.');
    expect(fetch.mock.calls.map(([, init]) => bodyModel(init))).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
    expect(cortexModelChoice('jp.snowflakecomputing.com')).toEqual({ model: 'claude-opus-5-5', instead: 'claude-sonnet-5-5' });
    // Per route: Cortex SQL is not assumed to take the same model ids as the REST Messages endpoint.
    expect(cortexModelChoice('jp.snowflakecomputing.com', 'sql')).toBeUndefined();
    expect(provider.modelInUse()).toEqual({ model: 'claude-opus-5-5', instead: 'claude-sonnet-5-5' });
    // Remembered: a provider built for the next request goes straight to it.
    const next = new CortexClaudeProvider({ host: 'jp.snowflakecomputing.com', token: staticToken('t') });
    await next.generate([{ role: 'user', content: 'Q2' }], { maxTokens: 5 });
    expect(fetch.mock.calls.slice(2).map(([, init]) => bodyModel(init))).toEqual(['claude-opus-5-5']);
  });

  it('keeps a model a person named, and returns the first refusal when no Claude model is offered', async () => {
    const named = vi.fn(async (_url: string, init?: RequestInit) => restUnknownModel(bodyModel(init)));
    vi.stubGlobal('fetch', named);
    const chosen = new CortexClaudeProvider({ host: 'named.snowflakecomputing.com', model: 'claude-opus-5', token: staticToken('t') });
    expect(chosen.automaticModel).toBe(false);
    await expect(chosen.generate([{ role: 'user', content: 'Q' }], { maxTokens: 5 })).rejects.toThrow('Pick another Claude model');
    expect(named).toHaveBeenCalledTimes(1);

    const none = vi.fn(async (_url: string, init?: RequestInit) => restNotInRegion(bodyModel(init)));
    vi.stubGlobal('fetch', none);
    const azure = new CortexClaudeProvider({ host: 'azure.snowflakecomputing.com', token: staticToken('t') });
    await expect(azure.generate([{ role: 'user', content: 'Q' }], { maxTokens: 5 })).rejects.toThrow("CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION'");
    expect(none.mock.calls.map(([, init]) => bodyModel(init))).toEqual([...CORTEX_CLAUDE_FALLBACK_MODELS]);
    expect(cortexModelChoice('azure.snowflakecomputing.com')).toBeUndefined();
  });

  it('falls back through Cortex SQL too, and never on a missing grant', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: '003001', message: 'This account is not allowed to access this endpoint.' }), { status: 403 })));
    const models: unknown[] = [];
    const sql = async (_statement: string, binds: unknown[]) => {
      models.push(binds[0]);
      if (binds[0] !== 'claude-sonnet-4-6') throw new Error(`Model ${String(binds[0])} is not available in your region.`);
      return [{ R: JSON.stringify({ choices: [{ messages: 'OK' }], usage: {} }) }];
    };
    const london = new CortexClaudeProvider({ host: 'london.snowflakecomputing.com', token: staticToken('t'), sql });
    expect(await london.generate([{ role: 'user', content: 'Q' }], { maxTokens: 1 })).toBe('OK');
    expect(models).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-6']);
    expect(london.modelInUse()).toEqual({ model: 'claude-sonnet-4-6', instead: 'claude-sonnet-5-5' });
    expect(cortexModelChoice('london.snowflakecomputing.com', 'sql')?.model).toBe('claude-sonnet-4-6');
    expect(cortexModelChoice('london.snowflakecomputing.com', 'rest')).toBeUndefined();

    const noGrant = vi.fn(async () => restNoGrant());
    vi.stubGlobal('fetch', noGrant);
    const app = new CortexClaudeProvider({ host: 'nogrant.snowflakecomputing.com', token: staticToken('t'), grantee: { appName: 'ZLENS_APP' } });
    await expect(app.generate([{ role: 'user', content: 'Q' }], { maxTokens: 1 })).rejects.toThrow('GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION ZLENS_APP');
    expect(noGrant).toHaveBeenCalledTimes(1);
  });
});
