import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from '../local-runtime.js';
import type { DqlHostHooks, DqlPrincipal } from './request-context.js';

/**
 * With a host, the server's own configuration (which provider keys its
 * environment holds, its dbt profiles, where drivers are installed, its
 * folders) is for whoever may manage connections or settings; everyone else
 * sees each connection's name and kind. Without a host the one user sees it all.
 */
const priya: DqlPrincipal = { id: 'u-priya', kind: 'person', email: 'priya@harbor.example', source: 'host' };
const servers: Server[] = [];
const roots: string[] = [];
const saved = process.env.OPENAI_API_KEY;
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
});

async function start(hooks?: Partial<DqlHostHooks>) {
  process.env.OPENAI_API_KEY = 'sk-CANARY-CONFIG-READS-7f3a';
  const projectRoot = mkdtempSync(join(tmpdir(), 'dql-config-reads-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'config', connections: { default: { driver: 'sqlite', filepath: 'main.sqlite', password: 'x' } } }));
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0,
    ...(hooks ? { hostHooks: { resolvePrincipal: () => priya, ...hooks } } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  return { projectRoot, get: async (path: string) => (await fetch(`http://127.0.0.1:${port}${path}`)).text() };
}

describe('with a host, the server\'s configuration is for those who manage it', () => {
  it('shows connection names and kinds, no key presence, no profiles, install paths or folders', async () => {
    const { get, projectRoot } = await start({ authorize: (_principal, action) => ({ allow: action !== 'connection.manage' && action !== 'settings.manage' }) });
    const connections = await get('/api/connections');
    expect(JSON.parse(connections)).toMatchObject({ connections: { default: { driver: 'sqlite' } }, dbtProfiles: [] });
    expect(connections).not.toMatch(/installPath|filepath|main\.sqlite/);
    const providers = await get('/api/settings/providers');
    expect(providers).not.toMatch(/"hasApiKey":true|OPENAI_API_KEY=set|sk-CANARY/);
    expect(await get('/api/settings/env-status')).not.toContain('"present":true');
    expect(await get('/api/skills/settings')).not.toContain(projectRoot);
  });

  it('shows it to someone who manages connections and settings', async () => {
    const { get } = await start({ authorize: () => ({ allow: true }) });
    expect(await get('/api/settings/providers')).toContain('"hasApiKey":true');
    expect(await get('/api/connections')).toContain('main.sqlite');
  });
});

describe('without a host', () => {
  it('the one user sees it all, as before', async () => {
    const { get, projectRoot } = await start();
    expect(await get('/api/settings/providers')).toContain('"hasApiKey":true');
    expect(await get('/api/skills/settings')).toContain(projectRoot);
  });
});

/**
 * App Studio reads `assistAvailable` to be honest when no AI is connected
 * (design D4): Start manually by default, keyword suggestions labelled. It says
 * whether a model can be asked, never which key the server holds.
 */
describe('whether a model can be asked (assistAvailable)', () => {
  const PROVIDER_ENV = [
    'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'ZLENS_OPENAI_COMPAT_API_KEY', 'ZLENS_OPENAI_COMPAT_BASE_URL', 'ZLENS_OPENAI_COMPAT_MODEL',
    'OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'ZLENS_EVAL_CASSETTE_DIR', 'ZLENS_EVAL_CASSETTE_MODE', 'DQL_EVAL_CASSETTE_DIR', 'DQL_EVAL_CASSETTE_MODE',
  ];
  const savedEnv = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [key, value] of savedEnv) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    savedEnv.clear();
  });
  const clearOtherProviders = () => {
    for (const key of PROVIDER_ENV) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  };

  it('is true with a configured provider, also for someone who may not see the key', async () => {
    clearOtherProviders();
    const local = await start();
    expect(JSON.parse(await local.get('/api/settings/providers')).assistAvailable).toBe(true);
    const hosted = await start({ authorize: (_principal, action) => ({ allow: action !== 'settings.manage' }) });
    const providers = await hosted.get('/api/settings/providers');
    expect(JSON.parse(providers).assistAvailable).toBe(true);
    expect(providers).not.toMatch(/"hasApiKey":true|sk-CANARY/);
  });

  it('is false when no provider is configured', async () => {
    clearOtherProviders();
    const { get } = await start();
    delete process.env.OPENAI_API_KEY;
    expect(JSON.parse(await get('/api/settings/providers')).assistAvailable).toBe(false);
  });
});
