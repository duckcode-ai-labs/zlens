import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import { connectionsLocked, deploymentLockRefusal } from './deployment-locks.js';
import { allowedModelProviders, getActiveProvider, listProviderSettings, modelProviderAllowed, saveProviderSettings } from './settings/provider-settings.js';

/**
 * ZLens installed as a packaged app (inside Snowflake): whoever installed it chose the connection
 * (ZLENS_LOCK_CONNECTIONS) and the model providers (ZLENS_MODEL_PROVIDERS). No host, one user.
 */
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-locks-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'locks', defaultConnectionName: 'app', connections: { app: { driver: 'sqlite', filepath: 'main.sqlite' } } }));
  return projectRoot;
}

async function start(projectRoot = project()) {
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
  };
  return { projectRoot, call };
}

describe('the switches', () => {
  it('reads ZLENS_LOCK_CONNECTIONS and ZLENS_MODEL_PROVIDERS (unset: no lock, every provider; none: no model)', () => {
    expect(connectionsLocked({ ZLENS_LOCK_CONNECTIONS: '1' })).toBe(true);
    expect(connectionsLocked({})).toBe(false);
    expect(allowedModelProviders({})).toBeNull();
    expect(allowedModelProviders({ ZLENS_MODEL_PROVIDERS: 'none' })).toEqual([]);
    expect(allowedModelProviders({ ZLENS_MODEL_PROVIDERS: ' Ollama, anthropic ,made-up' })).toEqual(['ollama', 'anthropic']);
    expect(modelProviderAllowed('openai', { ZLENS_MODEL_PROVIDERS: 'ollama' })).toBe(false);
    expect(modelProviderAllowed('bedrock', { ZLENS_MODEL_PROVIDERS: 'none' })).toBe(true); // a host's own model is the host's call
  });

  it('refuses by path the routes that change a connection or start a sign-in the install does not allow', () => {
    const locked = { ZLENS_LOCK_CONNECTIONS: '1' };
    expect(deploymentLockRefusal('PUT', '/api/connections', locked)).toMatch(/ZLENS_LOCK_CONNECTIONS/);
    expect(deploymentLockRefusal('POST', '/api/connectors/install', locked)).toBeTruthy();
    expect(deploymentLockRefusal('POST', '/api/connections/dbt-profiles/preview', locked)).toBeTruthy();
    expect(deploymentLockRefusal('POST', '/api/test-connection', locked)).toBeUndefined();
    expect(deploymentLockRefusal('GET', '/api/connections', locked)).toBeUndefined();
    expect(deploymentLockRefusal('PUT', '/api/connections', {})).toBeUndefined();
    expect(deploymentLockRefusal('POST', '/api/auth/claude/start', { ZLENS_MODEL_PROVIDERS: 'ollama' })).toMatch(/claude-code/);
    expect(deploymentLockRefusal('POST', '/api/auth/codex/status', { ZLENS_MODEL_PROVIDERS: 'ollama' })).toBeUndefined();
  });
});

describe('a provider the install does not allow is never chosen', () => {
  it('even with a key in the environment or saved as active before the switch was set', () => {
    const projectRoot = project();
    saveProviderSettings(projectRoot, { id: 'anthropic', apiKey: 'sk-ant-test-key-123456' });
    expect(getActiveProvider(projectRoot)).toBe('anthropic');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai-123456');
    vi.stubEnv('ZLENS_MODEL_PROVIDERS', 'ollama');
    expect(getActiveProvider(projectRoot)).toBeUndefined();
    const listed = listProviderSettings(projectRoot);
    expect(listed.filter((provider) => provider.allowed).map((provider) => provider.id)).toEqual(['ollama']);
    expect(listed.filter((provider) => !provider.allowed).every((provider) => !provider.enabled && !provider.configured && !provider.active)).toBe(true);
    expect(() => saveProviderSettings(projectRoot, { id: 'openai', apiKey: 'sk-other' })).toThrow(/ZLENS_MODEL_PROVIDERS/);
  });
});

describe('the server on a locked install', () => {
  it('shows the connection read-only and refuses every change to it; testing is allowed', async () => {
    vi.stubEnv('ZLENS_LOCK_CONNECTIONS', '1');
    const { call, projectRoot } = await start();
    const listed = await call('GET', '/api/connections');
    expect(listed.json).toMatchObject({ locked: true, dbtProfiles: [], connections: { app: { driver: 'sqlite' } } });
    const replaced = await call('PUT', '/api/connections', { connections: { other: { driver: 'duckdb', filepath: ':memory:' } }, defaultConnection: 'other' });
    expect(replaced).toMatchObject({ status: 403, json: { code: 'PERMISSION_DENIED' } });
    expect(JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8')).connections).toEqual({ app: { driver: 'sqlite', filepath: 'main.sqlite' } });
    expect((await call('POST', '/api/connectors/install', { driver: 'postgresql' })).status).toBe(403);
    expect((await call('POST', '/api/connections/dbt-profiles/preview', { path: '/tmp' })).status).toBe(403);
    expect((await call('POST', '/api/test-connection', {})).status).not.toBe(403);
  });

  it('without the switch, the connections list says unlocked, as before', async () => {
    const { call } = await start();
    expect((await call('GET', '/api/connections')).json.locked).toBe(false);
  });

  it('lists and saves only the allowed model providers; with none, there is no model at all', async () => {
    vi.stubEnv('ZLENS_MODEL_PROVIDERS', 'ollama');
    const { call } = await start();
    const providers = (await call('GET', '/api/settings/providers')).json.providers as Array<{ id: string; allowed: boolean }>;
    expect(providers.filter((provider) => provider.allowed).map((provider) => provider.id)).toEqual(['ollama']);
    expect((await call('POST', '/api/settings/providers', { id: 'anthropic', apiKey: 'sk-ant-xyz-1234567' })).status).toBe(403);
    expect((await call('POST', '/api/settings/providers/test', { id: 'openai', apiKey: 'sk-x' })).status).toBe(403);
    expect((await call('POST', '/api/settings/providers', { id: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.6:latest' })).status).toBe(200);
    expect((await call('PUT', '/api/settings/embeddings', { provider: 'openai', model: 'text-embedding-3-small' })).status).toBe(403);
    expect((await call('POST', '/api/auth/claude/start', {})).status).toBe(403);
    expect((await call('GET', '/api/settings/providers/cli-status')).json.status).toEqual({});

    vi.stubEnv('ZLENS_MODEL_PROVIDERS', 'none');
    const off = (await call('GET', '/api/settings/providers')).json;
    expect(off.providers.some((provider: { allowed: boolean }) => provider.allowed)).toBe(false);
    expect(off.assistAvailable).toBe(false);
  });
});

describe('a request on a locked install cannot bring its own connection', () => {
  it('tests the project\'s connection even when the body names another', async () => {
    // A connection naming an environment variable the server lacks answers "… is not set" before connecting.
    const named = { connection: { driver: 'sqlite', filepath: '${ZLENS_LOCKS_TEST_UNSET}/x.sqlite' } };
    const open = await start();
    expect(JSON.stringify((await open.call('POST', '/api/test-connection', named)).json)).toContain('ZLENS_LOCKS_TEST_UNSET is not set');
    vi.stubEnv('ZLENS_LOCK_CONNECTIONS', '1');
    const locked = await start();
    expect(JSON.stringify((await locked.call('POST', '/api/test-connection', named)).json)).not.toContain('ZLENS_LOCKS_TEST_UNSET');
  });
});
