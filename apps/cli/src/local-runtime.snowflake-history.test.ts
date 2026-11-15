import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { createStoredAppBuildDraft, deleteStoredAppBuildDraft, removeEmptyAppCopies } from './apps-api.js';
import { startLocalServer } from './local-runtime.js';
import type { SnowflakeAppQuery } from './snowflake-app-settings.js';

/**
 * V15 History through the server: in the ZLens app for Snowflake every save is a version by the Snowflake user who
 * signed in, and the History API reads, compares and restores them behind the app's sign-in. Open source keeps the
 * Git program's history and gets no History repository (H10).
 */
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-sf-history-'));
  roots.push(projectRoot);
  writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'sf', connections: { default: { driver: 'sqlite', filepath: 'main.sqlite' } } }));
  return projectRoot;
}

/** The app's settings, as Snowflake answers them: the person is JSMITH and one database is granted. */
const snowflake: SnowflakeAppQuery = async (sql) => {
  if (sql.includes('GET_CONFIGURATION_VALUE')) return [{ V: 'JSMITH' }];
  if (sql.startsWith('SHOW TERSE DATABASES')) return [{ name: 'SALES', kind: 'STANDARD' }];
  if (sql.startsWith('SHOW TERSE SCHEMAS IN DATABASE')) return [{ name: 'PUBLIC' }];
  if (sql.startsWith('SHOW TERSE OBJECTS IN SCHEMA')) return [{ name: 'T' }];
  if (sql.startsWith('SHOW WAREHOUSES')) return [{ state: 'SUSPENDED' }];
  throw new Error(`unexpected SQL: ${sql}`);
};

async function start(projectRoot: string, snowflakeApp: boolean) {
  const port = await startLocalServer({
    rootDir: projectRoot, projectRoot, executor: {} as QueryExecutor, preferredPort: 0, host: '127.0.0.1',
    ...(snowflakeApp ? {
      snowflakeIngress: {},
      snowflakeAppSettings: { userConfiguration: 'ZLENS_USER', appName: 'ZLENS_APP', ttlMs: 60_000 },
      snowflakeAppQuery: snowflake,
    } : {}),
    captureServer: (created) => { servers.push(created); },
  });
  const call = async (method: string, path: string, body?: unknown, user = 'JSMITH') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...(snowflakeApp ? { 'Sf-Context-Current-User': user } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { status: response.status, body: parsed };
  };
  return { call };
}

const source = (sql: string) => `block "wins_by_season" {\n  domain = "nba"\n  type = "custom"\n  description = "Wins by season"\n  owner = "JSMITH"\n  query = """\n    ${sql}\n  """\n}\n`;
const metadata = { name: 'wins_by_season', domain: 'nba', description: 'Wins by season', owner: 'JSMITH', tags: [] };

/** Versions are made just after a request answers: wait for the one expected. */
async function versionsOf(call: Awaited<ReturnType<typeof start>>['call'], path: string, count: number) {
  for (let tries = 0; tries < 100; tries += 1) {
    const item = await call('GET', `/api/history/item?path=${encodeURIComponent(path)}`);
    if (item.status === 200 && item.body.versions.length >= count) return item.body;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`History did not reach ${count} versions of ${path}`);
}

describe('History in the ZLens app for Snowflake', () => {
  it('keeps each save as a version by the signed-in user, compares and restores as a draft, behind the sign-in', async () => {
    const projectRoot = project();
    const { call } = await start(projectRoot, true);
    // The first start made the repository beside the project.
    expect(existsSync(join(projectRoot, '.dql', 'history', 'HEAD'))).toBe(true);
    const first = await call('POST', '/api/block-studio/save', { source: source('SELECT 2018 AS season'), metadata });
    expect(first.status).toBe(200);
    const path = first.body.path as string;
    let item = await versionsOf(call, path, 1);
    expect(item.versions[0]).toMatchObject({ version: 1, change: 'created', state: 'draft', by: { name: 'JSMITH', kind: 'person' } });

    const second = await call('POST', '/api/block-studio/save', { path, source: source('SELECT 2019 AS season'), metadata });
    expect(second.status).toBe(200);
    item = await versionsOf(call, path, 2);
    expect(item.versions[0]).toMatchObject({ version: 2, change: 'edited', detail: 'SQL changed' });

    // Someone else is refused before anything is read or written.
    expect((await call('POST', '/api/block-studio/save', { path, source: source('SELECT 1 AS season'), metadata }, 'OTHER')).status).toBe(403);
    expect((await call('GET', '/api/history/changes', undefined, 'OTHER')).status).toBe(403);

    // The saved query's History tab reads the same versions (the shape the Git history always had).
    const tab = await call('GET', `/api/blocks/history?path=${encodeURIComponent(path)}`);
    expect(tab.body.status).toBe('ok');
    expect(tab.body.entries.map((entry: { author: string; message: string }) => [entry.author, entry.message.split(':')[0]])).toEqual([
      ['JSMITH', 'v2 edited'],
      ['JSMITH', 'v1 created'],
    ]);

    const compared = await call('GET', `/api/history/compare?path=${encodeURIComponent(path)}&from=1&to=2`);
    expect(compared.status).toBe(200);
    expect(compared.body.sql.lines.filter((line: { kind: string }) => line.kind !== 'same').map((line: { kind: string; text: string }) => `${line.kind} ${line.text}`))
      .toEqual(['removed SELECT 2018 AS season', 'added SELECT 2019 AS season']);

    const restored = await call('POST', '/api/history/restore', { path, version: 'v1' });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ ok: true, restored: 1, version: 3, message: 'Restored v1 as v3', status: 'draft' });
    expect(readFileSync(join(projectRoot, path), 'utf-8')).toContain('SELECT 2018 AS season');
    item = await versionsOf(call, path, 3);
    expect(item.versions[0]).toMatchObject({ version: 3, change: 'restored', state: 'draft', by: { name: 'JSMITH' } });

    const feed = await call('GET', '/api/history/changes?kind=saved_query&by=person%3AJSMITH&days=30');
    expect(feed.body.entries.map((entry: { change: string; version: number }) => `${entry.change} v${entry.version}`)).toEqual(['restored v3', 'edited v2', 'created v1']);
    expect(feed.body.people).toEqual(['JSMITH']);

    const status = await call('GET', '/api/history/status');
    expect(status.body).toMatchObject({ enabled: true, warnAtBytes: 1024 ** 3, sizeWarning: false, sqlLog: { table: 'ZLENS_APP.CORE.HISTORY_LOG' } });
    expect(status.body.sizeBytes).toBeGreaterThan(0);

    // Only tracked files, inside the project.
    expect((await call('GET', '/api/history/item?path=dql.config.json')).status).toBe(400);
    expect((await call('GET', `/api/history/item?path=${encodeURIComponent('../outside.dql')}`)).status).toBe(400);
    expect((await call('POST', '/api/history/restore', { path: '.dql/local/x.json', version: 1 })).status).toBe(400);
  });
});

describe('Apps in History (V2)', () => {
  it('keeps creating an App and each tile as a version by the signed-in user; Delete draft is removed and restores as a draft', async () => {
    const projectRoot = project();
    const { call } = await start(projectRoot, true);
    const created = await call('POST', '/api/app-builds', { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    let draft = created.body.draft;
    const key = `apps/${draft.appId}`;
    let item = await versionsOf(call, key, 1);
    expect(item.item).toMatchObject({ key, kind: 'app', name: 'Sales overview' });
    expect(item.versions[0]).toMatchObject({ version: 1, change: 'created', by: { name: 'JSMITH', kind: 'person' }, detail: 'In App Studio, not published yet' });

    for (const [n, title] of ['Revenue', 'Orders', 'Margin'].entries()) {
      const tile = { i: `t${n}`, x: 0, y: n * 3, w: 6, h: 3, title, text: { markdown: title }, viz: { type: 'text' } };
      const patched = await call('PATCH', `/api/app-builds/${draft.id}`, { expectedRevision: draft.revision, operations: [{ type: 'add_tile', pageId: draft.pages[0].id, tile }] });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      draft = patched.body.draft;
      item = await versionsOf(call, key, n + 2);
    }
    const renamed = await call('PATCH', `/api/app-builds/${draft.id}`, { expectedRevision: draft.revision, operations: [{ type: 'set_name', name: 'Sales 2026' }] });
    draft = renamed.body.draft;
    item = await versionsOf(call, key, 5);
    expect(item.versions.map((row: { version: number; change: string; detail?: string; by: { name: string } }) => [row.version, row.change, row.detail, row.by.name])).toEqual([
      [5, 'renamed', 'Was "Sales overview"', 'JSMITH'],
      [4, 'edited', 'Added 1 tile', 'JSMITH'],
      [3, 'edited', 'Added 1 tile', 'JSMITH'],
      [2, 'edited', 'Added 1 tile', 'JSMITH'],
      [1, 'created', 'In App Studio, not published yet', 'JSMITH'],
    ]);
    const apps = await call('GET', '/api/history/changes?kind=app');
    expect(apps.body.entries.map((entry: { change: string; version: number }) => `${entry.change} v${entry.version}`)).toEqual(['renamed v5', 'edited v4', 'edited v3', 'edited v2', 'created v1']);
    // The content-free SQL log has a row waiting for each (written in batches).
    expect((await call('GET', '/api/history/status')).body.sqlLog.pending).toBeGreaterThanOrEqual(5);

    const deleted = await call('DELETE', `/api/app-builds/${draft.id}`, { expectedRevision: draft.revision, proposalHash: draft.proposalHash });
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    item = await versionsOf(call, key, 6);
    expect(item.item).toMatchObject({ removed: true, name: 'Sales 2026' });
    expect(item.versions[0]).toMatchObject({ version: 6, change: 'removed', state: 'removed', by: { name: 'JSMITH' } });
    const feed = await call('GET', '/api/history/changes');
    expect(feed.body.entries[0]).toMatchObject({ change: 'removed', kind: 'app', action: 'delete', canRestore: true });

    const restored = await call('POST', '/api/history/restore', { path: key, version: 5 });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body).toMatchObject({ ok: true, item: key, restored: 5, version: 7, status: 'draft', appDraft: { appId: draft.appId } });
    const drafts = await call('GET', '/api/app-builds');
    const back = drafts.body.drafts.find((candidate: { id: string }) => candidate.id === restored.body.appDraft.id);
    expect(back).toMatchObject({ name: 'Sales 2026', state: 'local_draft' });
    expect(back.pages[0].layout.items.map((tile: { title: string }) => tile.title)).toEqual(['Revenue', 'Orders', 'Margin']);
    item = await versionsOf(call, key, 7);
    expect(item.versions[0]).toMatchObject({ version: 7, change: 'restored', by: { name: 'JSMITH' }, current: true });
  });

  it('lists the empty copy an earlier upgrade moved to the trash as removed, and restores it as a draft', async () => {
    const projectRoot = project();
    // Before this version: an App, and the empty "(3)" copy the upgrade clean-up moved to the trash.
    createStoredAppBuildDraft(projectRoot, { name: 'Sales overview', authoringMode: 'manual', template: 'blank' });
    const shell = createStoredAppBuildDraft(projectRoot, { name: 'Sales overview (3)', authoringMode: 'ai', template: 'operational_dashboard', goal: 'Sales by month' });
    expect(removeEmptyAppCopies(projectRoot)).toEqual(['Sales overview (3)']);
    const gone = createStoredAppBuildDraft(projectRoot, { name: 'Margins', authoringMode: 'manual', template: 'blank' });
    deleteStoredAppBuildDraft(projectRoot, gone);
    await new Promise((done) => setTimeout(done, 5));
    const { call } = await start(projectRoot, true);
    const feed = await call('GET', '/api/history/changes');
    const removed = feed.body.entries.filter((entry: { change: string }) => entry.change === 'removed');
    expect(removed.map((entry: { by: { name: string }; items: Array<{ name: string }>; canRestore: boolean }) => [entry.by.name, entry.items[0]!.name, entry.canRestore])).toEqual([
      ['ZLens', 'Margins', true],
      ['ZLens', 'Sales overview (3)', true],
    ]);
    const restored = await call('POST', '/api/history/restore', { path: `apps/${shell.appId}`, version: 1 });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    const drafts = await call('GET', '/api/app-builds');
    expect(drafts.body.drafts.find((candidate: { id: string }) => candidate.id === restored.body.appDraft.id)).toMatchObject({ name: 'Sales overview (3)', state: 'local_draft' });
  });
});

describe('open source keeps Git', () => {
  it('makes no History repository and answers the History tab from the Git program, as before', async () => {
    const projectRoot = project();
    const { call } = await start(projectRoot, false);
    const saved = await call('POST', '/api/block-studio/save', { source: source('SELECT 2018 AS season'), metadata });
    expect(saved.status).toBe(200);
    await new Promise((done) => setTimeout(done, 50));
    expect(existsSync(join(projectRoot, '.dql', 'history'))).toBe(false);
    // No History routes: whatever answers, it is not History's.
    const changes = await call('GET', '/api/history/changes');
    expect(changes.body?.entries).toBeUndefined();
    const tab = await call('GET', `/api/blocks/history?path=${encodeURIComponent(saved.body.path)}`);
    // The git-binary path: this folder is not a Git repository (or the machine has no Git program).
    expect(['not_a_repo', 'git_unavailable']).toContain(tab.body.status);
    // App Studio saves in open source make no History either.
    expect((await call('POST', '/api/app-builds', { name: 'Sales overview', authoringMode: 'manual', template: 'blank' })).status).toBe(201);
    await new Promise((done) => setTimeout(done, 50));
    expect(existsSync(join(projectRoot, '.dql', 'history'))).toBe(false);
    expect(existsSync(join(projectRoot, 'apps'))).toBe(false);
  });
});
