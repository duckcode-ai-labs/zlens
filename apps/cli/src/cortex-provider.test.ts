import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { isCortexClaudeProvider, resetCortexRoute } from '@zlens/agent';
import { meaningDraftProvider, startLocalServer } from './local-runtime.js';
import { listProviderSettings, saveProviderSettings } from './settings/provider-settings.js';

/**
 * Snowflake Cortex as the model a single user picks, through the server's own
 * reading of dql.config.json: chosen, it is Claude at the account's Cortex
 * address, and it never fails over to a model outside Snowflake. Fetch is faked
 * for every address but this machine, so nothing reaches Snowflake.
 */
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  // A refusal is remembered per account host: each test starts on the REST API.
  resetCortexRoute();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections?.(); server.close(() => done()); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function project(connection: Record<string, unknown>): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-cortex-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'cortex', defaultConnectionName: 'snowflake', connections: { snowflake: connection } }));
  return projectRoot;
}

function keyPairProject(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const root = project({ driver: 'snowflake', account: '${ZLENS_TEST_CORTEX_ACCOUNT}', username: 'svc_zlens', authMethod: 'key_pair', privateKeyPath: '${ZLENS_TEST_CORTEX_KEY}' });
  const keyPath = join(root, 'rsa_key.p8');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  // The connection's `${VAR}`s are filled in the way the server fills them for queries.
  vi.stubEnv('ZLENS_TEST_CORTEX_ACCOUNT', 'myorg-test_acct');
  vi.stubEnv('ZLENS_TEST_CORTEX_KEY', keyPath);
  return root;
}

/** Records every request that would leave this machine and answers it as Cortex would. */
function fakeSnowflake(): Array<{ url: string; init?: RequestInit }> {
  const nativeFetch = globalThis.fetch;
  const sent: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (LOOPBACK.has(new URL(url).hostname)) return nativeFetch(input, init);
    sent.push({ url, ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return sent;
}

async function start(projectRoot: string) {
  // As inside Snowflake: the server installs no driver from the internet at start (the test has none).
  vi.stubEnv('ZLENS_NO_EGRESS', '1');
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
    captureServer: (created) => { servers.push(created); },
  });
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
  };
}

describe('Snowflake Cortex chosen as the model', () => {
  it('is Claude at the account\'s Cortex address, with no failover out of Snowflake even when another provider is configured', async () => {
    const projectRoot = keyPairProject();
    saveProviderSettings(projectRoot, { id: 'openai', enabled: true, apiKey: 'test-key-not-real', model: 'gpt-test' });
    saveProviderSettings(projectRoot, { id: 'cortex', enabled: true });
    expect(listProviderSettings(projectRoot).find((provider) => provider.id === 'cortex')).toMatchObject({ active: true, configured: true, connectionSignIn: { connection: 'snowflake', method: 'key_pair' } });

    const selected = await meaningDraftProvider(projectRoot);
    // The provider itself, not a failover wrapper: there is nothing to fail over to.
    expect(isCortexClaudeProvider(selected?.provider)).toBe(true);
    expect((selected!.provider as unknown as { baseUrl: string }).baseUrl).toBe('https://myorg-test-acct.snowflakecomputing.com/api/v2/cortex');

    // A failing Cortex call stays failed: it is never retried on OpenAI.
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return new Response('{"code":"003001","message":"not allowed"}', { status: 403 });
    }));
    await expect(selected!.provider.generate([{ role: 'user', content: 'Why did revenue rise?' }])).rejects.toThrow('Snowflake refuses the Cortex REST API for this account (HTTP 403, error 003001)');
    expect(sent.every((url) => url.startsWith('https://myorg-test-acct.snowflakecomputing.com/'))).toBe(true);
  });

  it('is never chosen without a connection Cortex can sign in with', async () => {
    const projectRoot = project({ driver: 'snowflake', account: 'acct', username: 'u', password: 'p' });
    saveProviderSettings(projectRoot, { id: 'cortex', enabled: true });
    expect(await meaningDraftProvider(projectRoot)).toBeNull();
  });
});

describe('the provider test route for Snowflake Cortex', () => {
  it('sends a one-token request through the project\'s Snowflake connection', async () => {
    const projectRoot = keyPairProject();
    const sent = fakeSnowflake();
    const call = await start(projectRoot);
    const listed = (await call('GET', '/api/settings/providers')).json.providers as Array<Record<string, any>>;
    expect(listed.find((provider) => provider.id === 'cortex')).toMatchObject({ label: 'Snowflake Cortex', configured: true, connectionSignIn: { connection: 'snowflake', method: 'key_pair' } });
    const tested = await call('POST', '/api/settings/providers/test', { id: 'cortex', model: 'claude-opus-5' });
    expect(tested.status).toBe(200);
    expect(tested.json.message).toMatch(/^Snowflake Cortex responded through the governed runtime \(model claude-opus-5, Snowflake connection snowflake\): OK/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://myorg-test-acct.snowflakecomputing.com/api/v2/cortex/v1/messages');
    expect(JSON.parse(String(sent[0]!.init!.body))).toMatchObject({ model: 'claude-opus-5', max_tokens: 1 });
    const headers = sent[0]!.init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['x-snowflake-authorization-token-type']).toBe('KEYPAIR_JWT');
  });

  it('says why in one sentence, and sends nothing, when the connection signs in with a password', async () => {
    const projectRoot = project({ driver: 'snowflake', account: 'acct', username: 'u', password: 'p' });
    const sent = fakeSnowflake();
    const call = await start(projectRoot);
    const tested = await call('POST', '/api/settings/providers/test', { id: 'cortex' });
    expect(tested.status).toBe(400);
    expect(tested.json.message).toBe('Snowflake Cortex signs in with your Snowflake connection\'s key pair, programmatic access token or OAuth token; this connection uses a password.');
    expect(sent).toEqual([]);
  });

  it('is the only provider an install that allows only Cortex lists', async () => {
    vi.stubEnv('ZLENS_MODEL_PROVIDERS', 'cortex');
    const projectRoot = keyPairProject();
    const call = await start(projectRoot);
    const providers = (await call('GET', '/api/settings/providers')).json.providers as Array<{ id: string; allowed: boolean; enabled: boolean }>;
    expect(providers.filter((provider) => provider.allowed).map((provider) => provider.id)).toEqual(['cortex']);
    expect(providers.find((provider) => provider.id === 'cortex')?.enabled).toBe(true);
    expect((await call('POST', '/api/settings/providers', { id: 'anthropic', apiKey: 'sk-ant-xyz-1234567' })).status).toBe(403);
  });
});

describe('meaning search through Snowflake Cortex (Settings » AI » Search)', () => {
  async function startWith(projectRoot: string, executor: unknown) {
    vi.stubEnv('ZLENS_NO_EGRESS', '1');
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: executor as QueryExecutor, preferredPort: 0,
      captureServer: (created) => { servers.push(created); },
    });
    return async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
    };
  }

  it('is offered only on a Snowflake connection, and embeds through the server\'s query path there', async () => {
    const elsewhere = await startWith(project({ driver: 'duckdb', filepath: ':memory:' }), {});
    expect((await elsewhere('GET', '/api/settings/embeddings')).json.cortex).toEqual({ available: false, reason: 'Snowflake Cortex search needs the project connection to be Snowflake.' });
    expect((await elsewhere('PUT', '/api/settings/embeddings', { provider: 'cortex' })).status).toBe(400);

    // Any Snowflake sign-in works: AI_EMBED is SQL, not the REST API.
    const statements: Array<{ sql: string; driver?: string }> = [];
    const executor = {
      executePositional: async (sql: string, binds: unknown[], connection: { driver?: string }) => {
        statements.push({ sql, driver: connection.driver });
        const texts = JSON.parse(String(binds[0])) as string[];
        return { rows: texts.map((_, index) => ({ I: index, V: JSON.stringify(Array.from({ length: 768 }, () => 0.01)) })) };
      },
    };
    const call = await startWith(project({ driver: 'snowflake', account: 'acct', username: 'u', password: 'p' }), executor);
    expect((await call('GET', '/api/settings/embeddings')).json.cortex).toEqual({ available: true });
    // The ZLens app for Snowflake starts with Cortex search: Settings shows it on, with the default model.
    vi.stubEnv('ZLENS_EMBEDDINGS', 'cortex');
    expect((await call('GET', '/api/settings/embeddings')).json).toMatchObject({
      settings: { provider: 'cortex', model: 'snowflake-arctic-embed-l-v2.0' },
      cortex: { available: true, installDefault: true },
    });
    vi.stubEnv('ZLENS_EMBEDDINGS', '');
    expect((await call('GET', '/api/settings/embeddings/models')).json.catalog.cortex.map((option: { model: string }) => option.model))
      .toEqual(['snowflake-arctic-embed-l-v2.0', 'snowflake-arctic-embed-m-v1.5']);
    expect((await call('PUT', '/api/settings/embeddings', { provider: 'cortex', model: 'text-embedding-3-small' })).status).toBe(400);
    const saved = await call('PUT', '/api/settings/embeddings', { provider: 'cortex', model: 'snowflake-arctic-embed-m-v1.5' });
    expect(saved.json).toMatchObject({ ok: true, activeProviderId: 'cached:resilient:cortex:snowflake-arctic-embed-m-v1.5', semantic: true });
    const tested = await call('POST', '/api/settings/embeddings/test');
    expect(tested.json).toMatchObject({ ok: true, dimensions: 768, semantic: true });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ driver: 'snowflake' });
    expect(statements[0]!.sql).toContain("AI_EMBED('snowflake-arctic-embed-m-v1.5'");
  });
});
