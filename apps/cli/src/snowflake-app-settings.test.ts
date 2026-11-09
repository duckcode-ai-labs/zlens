import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { startLocalServer } from './local-runtime.js';
import {
  IdleSuspender,
  SnowflakeAppSettings,
  chooseDatabase,
  idleSuspendFromEnv,
  readAppUser,
  readGrantedDatabases,
  snowflakeAppSettingsFromEnv,
  snowflakeAppSetupPage,
  type SnowflakeAppQuery,
} from './snowflake-app-settings.js';

/**
 * The ZLens app for Snowflake set up from Snowsight: the admin names the person on the app's
 * Configurations tab and grants it a database; ZLens reads both while running, and stops itself
 * when idle (Snowflake wakes it when it is opened again).
 */
const NOT_SET = new Error("Uncaught exception: Value of Application Configuration 'ZLENS_USER' has not been set.");

function fakeSnowflake(state: { user?: string; databases: string[] }): SnowflakeAppQuery & { calls: string[] } {
  const calls: string[] = [];
  const query = (async (sql: string) => {
    calls.push(sql);
    if (sql.includes('GET_CONFIGURATION_VALUE')) {
      if (!state.user) throw NOT_SET;
      return [{ V: state.user }];
    }
    if (sql.startsWith('SHOW TERSE DATABASES')) {
      return [...state.databases.map((name) => ({ name, kind: 'STANDARD' })), { name: 'ZLENS_PACKAGE', kind: 'APPLICATION PACKAGE' }, { name: 'IMAGES_ONLY', kind: 'STANDARD' }];
    }
    if (sql.startsWith('SHOW TERSE SCHEMAS IN DATABASE')) return [{ name: 'INFORMATION_SCHEMA' }, { name: sql.includes('"IMAGES_ONLY"') ? 'APP' : 'SALES' }];
    if (sql.startsWith('SHOW TERSE OBJECTS IN SCHEMA')) {
      if (sql.includes('INFORMATION_SCHEMA')) throw new Error('INFORMATION_SCHEMA is never asked about');
      return sql.includes('"IMAGES_ONLY"') ? [] : [{ name: 'T' }];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }) as unknown as SnowflakeAppQuery & { calls: string[] };
  query.calls = calls;
  return query;
}

describe('reading the app settings', () => {
  it('reads the person from the configuration value; unset is "not yet", other failures are errors', async () => {
    expect(await readAppUser(fakeSnowflake({ user: 'jsmith', databases: [] }), 'ZLENS_USER')).toBe('JSMITH');
    expect(await readAppUser(fakeSnowflake({ databases: [] }), 'ZLENS_USER')).toBeNull();
    await expect(readAppUser(async () => { throw new Error('network down'); }, 'ZLENS_USER')).rejects.toThrow('network down');
    // The name goes into the statement's text, so only a plain identifier is accepted.
    await expect(readAppUser(fakeSnowflake({ databases: [] }), "X') OR ('1")).rejects.toThrow('Not a configuration name');
  });

  it('lists the databases granted to the app: ordinary ones it can see a table in, not its own, a package or Snowflake\'s', async () => {
    const query = fakeSnowflake({ databases: ['ZLENS_APP', 'SALES', 'SNOWFLAKE', 'SNOWFLAKE_SAMPLE_DATA', 'FINANCE'] });
    expect(await readGrantedDatabases(query, 'zlens_app')).toEqual(['FINANCE', 'SALES']);
  });

  it('reuses a read for a while, and keeps the last good one when a read fails', async () => {
    let now = 0;
    const state: { user?: string; databases: string[] } = { user: 'A', databases: ['SALES'] };
    let failing = false;
    const base = fakeSnowflake(state);
    const query: SnowflakeAppQuery = async (sql) => { if (failing) throw new Error('down'); return base(sql); };
    const settings = new SnowflakeAppSettings({ userConfiguration: 'ZLENS_USER', ttlMs: 1000 }, query, () => now);
    expect(await settings.current()).toEqual({ user: 'A', databases: ['SALES'] });
    state.user = 'B';
    expect((await settings.current()).user).toBe('A');
    now = 2000;
    expect((await settings.current()).user).toBe('B');
    failing = true;
    now = 4000;
    expect((await settings.current()).user).toBe('B');
  });

  it('picks the database: the current one while still granted, else the only one granted', () => {
    expect(chooseDatabase(['SALES'], undefined)).toBe('SALES');
    expect(chooseDatabase(['FINANCE', 'SALES'], 'sales')).toBe('sales');
    expect(chooseDatabase(['FINANCE', 'SALES'], undefined)).toBeUndefined();
    expect(chooseDatabase([], 'SALES')).toBeUndefined();
  });

  it('turns on only when asked, and the idle stop only with a minute count and a full service name', () => {
    expect(snowflakeAppSettingsFromEnv({})).toBeUndefined();
    expect(snowflakeAppSettingsFromEnv({ ZLENS_SNOWFLAKE_APP_SETTINGS: '1', ZLENS_SNOWFLAKE_APP_NAME: 'ZLENS_APP' })).toEqual({ userConfiguration: 'ZLENS_USER', appName: 'ZLENS_APP' });
    expect(idleSuspendFromEnv({ ZLENS_SNOWFLAKE_IDLE_SUSPEND_MINUTES: '30', ZLENS_SNOWFLAKE_SERVICE: 'ZLENS_APP.CORE.ZLENS' })).toEqual({ minutes: 30, service: 'ZLENS_APP.CORE.ZLENS' });
    expect(idleSuspendFromEnv({ ZLENS_SNOWFLAKE_IDLE_SUSPEND_MINUTES: '30', ZLENS_SNOWFLAKE_SERVICE: 'x; DROP TABLE y' })).toBeUndefined();
    expect(idleSuspendFromEnv({ ZLENS_SNOWFLAKE_IDLE_SUSPEND_MINUTES: '0', ZLENS_SNOWFLAKE_SERVICE: 'A.B.C' })).toBeUndefined();
  });

  it('shows the admin only the steps still missing, with the app\'s name filled in', () => {
    const both = snowflakeAppSetupPage({ appName: 'ZLENS_APP', needsUser: true, databases: [] });
    expect(both).toContain('Configurations');
    expect(both).toContain('Pick a warehouse at the top of the page first');
    expect(both).toContain('GRANT USAGE ON DATABASE MY_DB TO APPLICATION ZLENS_APP;');
    const onlyData = snowflakeAppSetupPage({ appName: 'ZLENS_APP', needsUser: false, databases: [] });
    expect(onlyData).not.toContain('Configurations');
    expect(snowflakeAppSetupPage({ appName: 'ZLENS_APP', needsUser: false, databases: ['A', 'B'] })).toContain('reads one');
  });
});

describe('stopping when idle', () => {
  it('stops after the quiet spell, never while a request is running, and tries again if stopping failed', async () => {
    let now = 0;
    let stops = 0;
    let fail = false;
    const idle = new IdleSuspender(1000, async () => { if (fail) throw new Error('no'); stops += 1; }, () => now);
    now = 500;
    expect(await idle.check()).toBe(false);
    const done = idle.touch();
    now = 5000;
    expect(await idle.check()).toBe(false);
    done();
    now = 5500;
    expect(await idle.check()).toBe(false);
    now = 6100;
    fail = true;
    expect(await idle.check()).toBe(false);
    fail = false;
    now = 7200;
    expect(await idle.check()).toBe(true);
    expect(stops).toBe(1);
    expect(await idle.check()).toBe(false);
  });
});

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the server, set up from Snowsight', () => {
  it('shows the steps until the person is named and a database granted, then serves only that person on it', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-sf-app-settings-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'sf', connections: { default: { driver: 'sqlite', filepath: 'main.sqlite' } } }));
    const state: { user?: string; databases: string[] } = { databases: ['ZLENS_APP'] };
    const port = await startLocalServer({
      rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, host: '127.0.0.1',
      snowflakeIngress: {},
      snowflakeAppSettings: { userConfiguration: 'ZLENS_USER', appName: 'ZLENS_APP', ttlMs: 0 },
      snowflakeAppQuery: fakeSnowflake(state),
      captureServer: (created) => { servers.push(created); },
    });
    const call = (path: string, user: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'Sf-Context-Current-User': user } });

    const page = await call('/', 'ANYONE');
    expect(page.status).toBe(503);
    const html = await page.text();
    expect(html).toContain('Configurations');
    expect(html).toContain('GRANT USAGE ON DATABASE MY_DB TO APPLICATION ZLENS_APP;');
    const api = await call('/api/connections', 'ANYONE');
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ code: 'SNOWFLAKE_APP_SETUP_NEEDED' });

    state.user = 'jsmith';
    // Named, but nothing granted yet: the person sees the grant step; anyone else is refused.
    expect((await call('/api/connections', 'OTHER')).status).toBe(403);
    expect((await call('/api/connections', 'JSMITH')).status).toBe(503);

    state.databases = ['ZLENS_APP', 'SALES'];
    expect((await call('/api/connections', 'jsmith')).status).toBe(200);
    expect((await call('/api/connections', 'OTHER')).status).toBe(403);
    const saved = JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf8'));
    expect(saved.connections.default.database).toBe('SALES');
    // The app set up its own project: the installer's first-run questions never open there.
    const launch = await (await call('/api/onboarding/launch', 'JSMITH')).json();
    expect(launch).toMatchObject({ shouldOpen: false, snowflakeAppManaged: true });
    // Snowflake's readiness probe is never held up by the setup.
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
  });
});
