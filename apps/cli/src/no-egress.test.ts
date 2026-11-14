import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import { deploymentLockRefusal } from './deployment-locks.js';
import { testDbtCloudSemanticConnection } from './dbt-cloud-semantic.js';
import { dispatchNotifications } from './schedule/notifiers/index.js';

/**
 * ZLENS_NO_EGRESS=1, as in the ZLens app for Snowflake: nothing reaches the internet. Nothing installs at run
 * time (MetricFlow, Ollama embedding models) and nothing talks to an outside service (dbt Cloud; Slack, email,
 * webhooks). Snowflake's security review asks that an app load no code or models from outside its package.
 */
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-no-egress-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'offline', defaultConnectionName: 'app', connections: { app: { driver: 'sqlite', filepath: 'main.sqlite' } } }));
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

const payload = { block: 'revenue', path: 'blocks/revenue.dql', startedAt: '2026-11-13T00:00:00.000Z', alerts: [], queries: [], trigger: 'manual' as const };

describe('an install with no internet access', () => {
  it('refuses by path the routes that would install something or call an outside service', () => {
    const offline = { ZLENS_NO_EGRESS: '1' };
    expect(deploymentLockRefusal('POST', '/api/semantic-runtime/metricflow/install', offline)).toMatch(/no internet access.*MetricFlow/);
    expect(deploymentLockRefusal('POST', '/api/semantic-runtime/dbt-cloud/test', offline)).toMatch(/dbt Cloud/);
    expect(deploymentLockRefusal('POST', '/api/semantic-runtime/dbt-cloud/apply', offline)).toMatch(/dbt Cloud/);
    expect(deploymentLockRefusal('POST', '/api/settings/embeddings/install', offline)).toMatch(/embedding models/);
    // Reading the settings is fine; so is every route on an install with internet access.
    expect(deploymentLockRefusal('GET', '/api/semantic-runtime/metricflow/installer', offline)).toBeUndefined();
    expect(deploymentLockRefusal('POST', '/api/semantic-runtime/metricflow/install', {})).toBeUndefined();
    expect(deploymentLockRefusal('POST', '/api/settings/embeddings/install', { ZLENS_NO_EGRESS: '0' })).toBeUndefined();
  });

  it('the server offers neither dbt Cloud nor a MetricFlow install or model download, and refuses them', async () => {
    vi.stubEnv('ZLENS_NO_EGRESS', '1');
    const { call } = await start();

    const runtime = await call('GET', '/api/semantic-runtime');
    expect(runtime.status).toBe(200);
    expect(runtime.json.noEgress).toBe(true);
    const installer = await call('GET', '/api/semantic-runtime/metricflow/installer');
    expect(installer.json).toMatchObject({ installable: false });
    expect(installer.json.reason).toMatch(/no internet access/);

    const install = await call('POST', '/api/semantic-runtime/metricflow/install', { adapter: 'snowflake' });
    expect(install.status).toBe(403);
    expect(install.json.error).toMatch(/MetricFlow cannot be installed here/);
    const cloud = await call('POST', '/api/semantic-runtime/dbt-cloud/test', { dbtCloud: { host: 'semantic-layer.cloud.getdbt.com', environmentId: '1', serviceToken: 'x' } });
    expect(cloud.status).toBe(403);
    const preference = await call('POST', '/api/semantic-runtime/preference', { preference: 'dbt-cloud' });
    expect(preference.status).toBe(403);
    expect(preference.json.error).toMatch(/dbt Cloud/);
    // The engine that needs nothing from outside can still be chosen.
    expect((await call('POST', '/api/semantic-runtime/preference', { preference: 'native' })).status).toBe(200);

    expect((await call('GET', '/api/settings/embeddings/models')).json.installable).toBe(false);
    expect((await call('POST', '/api/settings/embeddings/install', { model: 'nomic-embed-text' })).status).toBe(403);
  });

  it('with internet access, the same server offers them as before', async () => {
    const { call } = await start();
    expect((await call('GET', '/api/semantic-runtime')).json.noEgress).toBeUndefined();
    expect((await call('GET', '/api/semantic-runtime/metricflow/installer')).json.installable).toBeUndefined();
  });

  it('never calls dbt Cloud, even with settings that were saved elsewhere', async () => {
    vi.stubEnv('ZLENS_NO_EGRESS', '1');
    const fetchImpl = vi.fn();
    await expect(testDbtCloudSemanticConnection({
      host: 'semantic-layer.cloud.getdbt.com', endpoint: 'https://semantic-layer.cloud.getdbt.com/api/graphql',
      environmentId: '1', serviceToken: 'token', source: 'local', configured: true, testState: 'configured',
    }, fetchImpl as never)).rejects.toThrow(/no internet access/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends no Slack, email or webhook message; the project log is still written', async () => {
    vi.stubEnv('ZLENS_NO_EGRESS', '1');
    const projectRoot = project();
    const results = await dispatchNotifications([
      { type: 'slack', recipients: ['#metrics'] },
      { type: 'webhook', recipients: ['https://example.com/hook'] },
      { type: 'email', recipients: ['team@example.com'] },
    ] as never, payload, projectRoot);
    // The audit line in the project's log is written as always (the last entry).
    expect(results.map((result) => [result.type, result.delivered])).toEqual([['slack', false], ['webhook', false], ['email', false], ['file', true]]);
    for (const result of results.slice(0, 3)) expect(result.error).toMatch(/no internet access .* results stay in ZLens/);
    const log = join(projectRoot, '.dql/runs/notifications.log');
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf-8')).toContain('revenue');
  });
});
