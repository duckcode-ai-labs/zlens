import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { certifiedSourceSha256 } from '@zlens/core';
import { applyCompanionCertification } from '../certification-receipt.js';
import { HistoryService, alignResults } from './history-service.js';
import { mergeStatement, sqlString } from './history-sql-log.js';
import type { HistoryStore } from './history-store.js';
import { diffLines } from './line-diff.js';
import { besideSuffix, isTrackedPath } from './tracked-files.js';

/**
 * V15 History in the ZLens app for Snowflake (decisions H1–H10): every save through ZLens is a version, by the
 * Snowflake user who made it; restore always makes a draft; certified versions and their receipts never change;
 * removed items can be restored; nothing reaches outside.
 */
const roots: string[] = [];
const services: HistoryService[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-history-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'history', connections: { app: { driver: 'snowflake' } } }));
  return root;
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, 'utf-8');
}

function block(name: string, sql: string, status = 'draft', extra = ''): string {
  return `block "${name}" {\n  domain = "nba"\n  type = "custom"\n  status = "${status}"\n  description = "Wins by season"\n  owner = "JSMITH"${extra}\n  query = """\n    ${sql}\n  """\n  visualization {\n    chart = "bar"\n  }\n}\n`;
}

/** A certified saved query: its source says certified and its companion's receipt is for exactly that source. */
function certify(root: string, path: string, companionPath: string, source: string, by = 'JSMITH'): void {
  put(root, path, source);
  const base = `name: wins\nblock: wins\ndomain: nba\ndescription: Wins by season\n`;
  put(root, companionPath, applyCompanionCertification(base, 'certified', {
    certifiedBy: by,
    certifiedAt: '2026-11-11T14:20:00.000Z',
    via: 'block-studio',
    rules: 'oss',
    sourceSha256: certifiedSourceSha256(source),
    checks: ['Matches warriors_wins.xlsx · every value compared (5 of 5 at 0.01, 11 Nov)'],
  }));
}

async function open(root: string, options: Partial<ConstructorParameters<typeof HistoryService>[0]> = {}): Promise<HistoryService> {
  const service = new HistoryService({ projectRoot: root, sweepDelayMs: 0, log: { info: () => undefined, warn: () => undefined }, ...options });
  services.push(service);
  await service.start();
  return service;
}

const save = async (service: HistoryService, user = 'JSMITH', path = '/api/block-studio/save', method = 'POST') => {
  const made = await service.afterRequest({ user, method, path, status: 200 });
  return made ?? [];
};

const WINS = 'blocks/nba/wins.dql';
const WINS_COMPANION = 'semantic-layer/blocks/nba/wins.yaml';
const SQL_2018 = 'SELECT season, wins FROM team_seasons WHERE season BETWEEN 2014 AND 2018';
const SQL_2019 = 'SELECT season, wins FROM team_seasons WHERE season BETWEEN 2014 AND 2019';

describe('what History keeps', () => {
  it('keeps saved queries, receipts, Apps, notebooks and model files, never caches, settings, data or secrets', () => {
    for (const path of [WINS, WINS_COMPANION, 'apps/sales/dql.app.json', 'apps/sales/dashboards/main.dqld', 'notebooks/welcome.dqlnb', 'semantic-layer/metrics/revenue.yaml', 'domains/nba/domain.yaml', 'domains/nba/blocks/x.dql']) {
      expect(isTrackedPath(path), path).toBe(true);
    }
    for (const path of ['.dql/local/apps.sqlite', '.dql/cache/x.json', 'dql.config.json', 'blocks/x.run.json', 'data/sales.csv', 'blocks/data/x.dql', 'semantic-layer/report-matches/query/x.yaml',
      'notebooks/secret-notes.dqlnb', 'apps/a/token.json', 'apps/.hidden/dql.app.json', '../etc/passwd', 'blocks/../../x.dql', '/blocks/x.dql', 'skills/x.md', 'profiles.yml', 'blocks/x.duckdb']) {
      expect(isTrackedPath(path), path).toBe(false);
    }
  });
});

describe('the first start', () => {
  it('creates its own repository beside the project with one version, "History starts here" by ZLens, and never touches the project\'s .git', async () => {
    const root = project();
    put(root, WINS, block('wins', SQL_2018));
    put(root, 'notebooks/welcome.dqlnb', '{"title":"Welcome","cells":[]}');
    put(root, '.dql/local/state.json', '{"secret":true}');
    put(root, 'data/raw.csv', 'a,b\n1,2\n');
    put(root, '.git/HEAD', 'ref: refs/heads/main\n');
    const before = readdirSync(join(root, '.git'));
    const history = await open(root);

    expect(existsSync(join(root, '.dql', 'history', 'HEAD'))).toBe(true);
    expect(readFileSync(join(root, '.dql', 'history', '.gitignore'), 'utf-8')).toBe('*\n');
    expect(readdirSync(join(root, '.git'))).toEqual(before);
    expect(history.index.commits).toHaveLength(1);
    const [first] = history.index.commits;
    expect(first).toMatchObject({ message: 'History starts here', action: 'start', author: { name: 'ZLens', kind: 'zlens' } });
    expect(first!.changes.map((change) => change.item).sort()).toEqual([WINS, 'notebooks/welcome.dqlnb']);
    const files = await history.store.files();
    expect([...files.keys()].sort()).toEqual([WINS, 'notebooks/welcome.dqlnb']);
    expect(history.feed().entries).toEqual([expect.objectContaining({ change: 'started', count: 2, canRestore: false, canCompare: false })]);
  });

  it('starts an empty project too, and on a later start commits what changed while ZLens was stopped, as ZLens', async () => {
    const root = project();
    const first = await open(root);
    expect(first.index.commits).toHaveLength(1);
    first.stop();
    put(root, WINS, block('wins', SQL_2018));
    const again = await open(root);
    expect(again.index.commits.map((commit) => commit.message)).toEqual(['History starts here', 'Changes found when ZLens started']);
    expect(again.index.commits[1]!.author).toEqual({ name: 'ZLens', kind: 'zlens' });
    // Nothing changed: no version.
    const third = await open(root);
    expect(third.index.commits).toHaveLength(2);
  });

  it('rebuilds its item index from the repository when the index is gone', async () => {
    const root = project();
    put(root, WINS, block('wins', SQL_2018));
    const history = await open(root);
    put(root, WINS, block('wins', SQL_2019));
    await save(history);
    const versions = history.item(WINS).versions.map((row) => [row.version, row.change, row.by.name]);
    history.stop();
    unlinkSync(join(root, '.dql', 'history', 'zlens-index.json'));
    const rebuilt = await open(root);
    expect(rebuilt.item(WINS).versions.map((row) => [row.version, row.change, row.by.name])).toEqual(versions);
  });
});

describe('every save is a version', () => {
  it('makes one version per request that changed tracked files, by the Snowflake user, and none otherwise', async () => {
    const root = project();
    const history = await open(root);
    put(root, WINS, block('wins', SQL_2018));
    put(root, '.dql/local/run.json', '{}');
    const made = await save(history, 'JSMITH');
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ author: { name: 'JSMITH', kind: 'person' }, action: 'save', changes: [expect.objectContaining({ item: WINS, version: 1, change: 'created', certified: false })] });
    // The same request again, nothing changed: no version. A read, a refusal or a failure: no version.
    expect(await save(history)).toEqual([]);
    put(root, WINS, block('wins', SQL_2019));
    expect(history.afterRequest({ user: 'JSMITH', method: 'GET', path: '/api/blocks/library', status: 200 })).toBeUndefined();
    expect(history.afterRequest({ user: 'JSMITH', method: 'POST', path: '/api/block-studio/save', status: 403 })).toBeUndefined();
    expect(history.afterRequest({ user: 'JSMITH', method: 'POST', path: '/api/block-studio/save', status: 500 })).toBeUndefined();
    const second = await save(history, 'JSMITH');
    expect(second).toHaveLength(1);
    expect(second[0]!.changes[0]).toMatchObject({ item: WINS, version: 2, change: 'edited', detail: 'SQL changed' });
    expect(history.index.commits).toHaveLength(3);
  });

  it('runs one job at a time, in the order asked', async () => {
    const root = project();
    put(root, WINS, block('wins', SQL_2018));
    const history = await open(root);
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const store = history.store as HistoryStore;
    const commit = store.commit.bind(store);
    vi.spyOn(store, 'commit').mockImplementation(async (input) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((done) => setTimeout(done, 15));
      order.push(input.message);
      running -= 1;
      return commit(input);
    });
    put(root, 'notebooks/a.dqlnb', '{"title":"A"}');
    const first = history.commitPending({ name: 'ZLens', kind: 'zlens' }, 'upgrade', 'first');
    const second = history.commitPending({ name: 'ZLens', kind: 'zlens' }, 'upgrade', 'second');
    const third = history.afterRequest({ user: 'JSMITH', method: 'POST', path: '/api/notebooks', status: 200 });
    await Promise.all([first, second, third]);
    // The first job took the change; the jobs after it found nothing left, and none ran beside another.
    expect(order).toEqual(['first']);
    expect(most).toBe(1);
    put(root, 'notebooks/b.dqlnb', '{"title":"B"}');
    put(root, 'notebooks/c.dqlnb', '{"title":"C"}');
    const a = history.commitPending({ name: 'ZLens', kind: 'zlens' }, 'upgrade', 'one');
    const b = history.restore({ item: 'notebooks/a.dqlnb', version: 1, user: 'JSMITH' }).catch((error: Error) => error.message);
    await Promise.all([a, b]);
    expect(order).toEqual(['first', 'one']);
    expect(await b).toMatch(/already the current version/);
    expect(most).toBe(1);
  });

  it('names an automatic Ask draft "AI (Ask)" with the person who asked, apart from their own changes', async () => {
    const root = project();
    const history = await open(root);
    const draft = 'block "raptors_wins_2018" {\n  status = "draft"\n  source_question = "How many games did the Raptors win in 2018?"\n  answer_fingerprint = "abc"\n  asked_times = 1\n  last_asked = "2026-11-13T08:47:00.000Z"\n  query = """SELECT 1"""\n}\n';
    put(root, 'blocks/_drafts/raptors_wins_2018.dql', draft);
    // Written before marks existed, an Ask draft is recognised by the time Ask stamped it.
    const stamped = new Date('2026-11-13T08:47:00.000Z');
    const { utimesSync } = await import('node:fs');
    utimesSync(join(root, 'blocks/_drafts/raptors_wins_2018.dql'), stamped, stamped);
    put(root, 'notebooks/mine.dqlnb', '{"title":"Mine"}');
    const made = await save(history, 'JSMITH', '/api/agent-runs');
    expect(made.map((commit) => commit.author)).toEqual([
      { name: 'AI (Ask)', kind: 'ai', askedBy: 'JSMITH' },
      { name: 'JSMITH', kind: 'person' },
    ]);
    expect(made[0]!.changes[0]).toMatchObject({ change: 'drafted', detail: 'From Ask: "How many games did the Raptors win in 2018?"' });
    expect(history.feed({ by: 'ai' }).entries).toHaveLength(1);
    expect(history.feed({ by: 'person:jsmith' }).entries).toHaveLength(2);
  });
});

describe('certified versions, draft edits and restore', () => {
  it('shows an edit of a certified saved query as its next version, a draft, with the banner; certified v1 never changes', async () => {
    const root = project();
    const certified = block('wins', SQL_2018, 'certified');
    certify(root, WINS, WINS_COMPANION, certified);
    const history = await open(root);
    const v1 = history.index.commits[0]!.oid;
    expect(history.item(WINS).versions[0]).toMatchObject({ version: 1, state: 'certified' });

    // Saving an edit of a certified saved query writes it beside the certified one, as a draft (local-runtime).
    const beside = `blocks/_drafts/nba/wins-${besideSuffix(WINS)}.dql`;
    put(root, beside, block('wins (draft edit)', SQL_2019));
    await save(history);
    const item = history.item(WINS);
    expect(item.versions.map((row) => [row.version, row.state, row.current])).toEqual([[2, 'draft', true], [1, 'certified', false]]);
    expect(item.versions[0]!.detail).toBe('Draft edit of certified v1. SQL changed. Not certified yet');
    expect(item.banner).toEqual({ draft: 2, certified: 1 });
    expect(item.item.name).toBe('wins');

    const compared = await history.compare(WINS, 1, 2);
    expect(compared.from).toMatchObject({ version: 1, state: 'certified', certifiedBy: 'JSMITH', oldReport: expect.stringMatching(/^Matches warriors_wins/) });
    expect(compared.to).toMatchObject({ version: 2, state: 'draft', path: beside });
    expect(item.versions.map((row) => row.path)).toEqual([beside, WINS]);
    expect(compared.sql!.lines.filter((line) => line.kind !== 'same')).toEqual([
      { kind: 'removed', text: SQL_2018, oldNumber: 1 },
      { kind: 'added', text: SQL_2019, newNumber: 1 },
    ]);
    expect(compared.sql!.changed).toBe(1);
    expect(compared.fields!.find((field) => field.field === 'chart')).toMatchObject({ changed: false, before: 'bar' });
    // A draft edit's copy is named "<name> (draft edit)": the name it keeps is the same.
    expect(compared.fields!.find((field) => field.field === 'name')).toMatchObject({ changed: false, before: 'wins', after: 'wins' });

    // Restore the certified v1: the certified file stays exactly as certified (still in use); v1's content comes
    // back as the draft edit, v3. Never certified.
    const restored = await history.restore({ item: WINS, version: 1, user: 'JSMITH' });
    expect(restored).toMatchObject({ item: WINS, restored: 1, version: 3, message: 'Restored v1 as v3' });
    expect(readFileSync(join(root, WINS), 'utf-8')).toBe(certified);
    const draftNow = readFileSync(join(root, beside), 'utf-8');
    expect(draftNow).toContain('status = "draft"');
    expect(draftNow).toContain('block "wins (draft edit)"');
    expect(draftNow).toContain(SQL_2018);
    const after = history.item(WINS);
    expect(after.versions[0]).toMatchObject({ version: 3, change: 'restored', state: 'draft', by: { name: 'JSMITH' } });
    expect(history.index.commits.at(-1)!.message).toBe('Restored v1 as v3');
    // v1, with its receipt, is exactly as it was.
    expect(new TextDecoder().decode((await history.store.readFile(v1, WINS))!)).toBe(certified);
    expect(new TextDecoder().decode((await history.store.readFile(v1, WINS_COMPANION))!)).toContain(`sourceSha256: ${certifiedSourceSha256(certified)}`);
    expect((await history.versionFiles(WINS, 1)).files.map((file) => file.path)).toEqual([WINS, WINS_COMPANION]);
  });

  it('restores an old version of a saved query that is not certified as a draft, with no receipt', async () => {
    const root = project();
    const certified = block('wins', SQL_2018, 'certified');
    certify(root, WINS, WINS_COMPANION, certified);
    const history = await open(root);
    // Moved back to draft and edited in place.
    put(root, WINS, block('wins', SQL_2019, 'draft'));
    put(root, WINS_COMPANION, applyCompanionCertification(readFileSync(join(root, WINS_COMPANION), 'utf-8'), 'draft', null));
    await save(history);
    expect(history.item(WINS).versions[0]).toMatchObject({ version: 2, state: 'draft' });

    await history.restore({ item: WINS, version: 1, user: 'JSMITH' });
    const source = readFileSync(join(root, WINS), 'utf-8');
    expect(source).toContain('status = "draft"');
    expect(source).toContain(SQL_2018);
    const companion = readFileSync(join(root, WINS_COMPANION), 'utf-8');
    expect(companion).toContain('reviewStatus: draft');
    expect(companion).not.toMatch(/^certification:/m);
    const item = history.item(WINS);
    expect(item.versions[0]).toMatchObject({ version: 3, change: 'restored', state: 'draft' });
    expect(item.versions.find((row) => row.version === 1)).toMatchObject({ state: 'certified' });
    expect(item.banner).toEqual({ draft: 3, certified: 1 });
  });

  it('keeps a removed item and restores it', async () => {
    const root = project();
    put(root, 'apps/sales/dql.app.json', JSON.stringify({ title: 'Sales by month' }));
    put(root, 'apps/sales/dashboards/main.dqld', '{"id":"main"}');
    put(root, WINS, block('wins', SQL_2018));
    const history = await open(root);
    rmSync(join(root, 'apps', 'sales'), { recursive: true });
    unlinkSync(join(root, WINS));
    const removed = await save(history, 'JSMITH', '/api/apps/sales', 'DELETE');
    expect(removed[0]!.changes.map((change) => [change.item, change.change])).toEqual([['apps/sales', 'removed'], [WINS, 'removed']]);
    const app = history.item('apps/sales');
    expect(app.item).toMatchObject({ removed: true, name: 'Sales by month' });
    expect(app.versions.map((row) => [row.version, row.state, row.canRestore])).toEqual([[2, 'removed', false], [1, 'saved', true]]);
    expect(history.feed().entries[0]).toMatchObject({ change: 'removed', canRestore: true });

    await history.restore({ item: 'apps/sales', version: 1, user: 'JSMITH' });
    expect(JSON.parse(readFileSync(join(root, 'apps/sales/dql.app.json'), 'utf-8'))).toEqual({ title: 'Sales by month' });
    expect(readFileSync(join(root, 'apps/sales/dashboards/main.dqld'), 'utf-8')).toBe('{"id":"main"}');
    await history.restore({ item: WINS, version: 1, user: 'JSMITH' });
    expect(readFileSync(join(root, WINS), 'utf-8')).toContain('status = "draft"');
    expect(history.item(WINS).versions[0]).toMatchObject({ version: 3, change: 'restored' });
  });

  it('refuses paths it does not keep, versions that do not exist, and restoring the current version', async () => {
    const root = project();
    put(root, WINS, block('wins', SQL_2018));
    const history = await open(root);
    expect(() => history.item('dql.config.json')).toThrow(/keeps saved queries/);
    expect(() => history.item('../outside.dql')).toThrow(/keeps saved queries/);
    expect(() => history.item('blocks/nba/other.dql')).toThrow(/no versions/);
    await expect(history.restore({ item: WINS, version: 9 })).rejects.toThrow(/no v9/);
    await expect(history.restore({ item: WINS, version: 1 })).rejects.toThrow(/already the current version/);
  });
});

describe('Compare: the result, run now', () => {
  it('lines rows up by their text columns and marks new rows', () => {
    const aligned = alignResults(
      { columns: ['SEASON', 'WINS'], rows: [2014, 2015, 2016, 2017, 2018].map((season, i) => ({ SEASON: season, WINS: [67, 73, 67, 58, 57][i] })) },
      { columns: ['SEASON', 'WINS'], rows: [2014, 2015, 2016, 2017, 2018, 2019].map((season, i) => ({ SEASON: season, WINS: [67, 73, 67, 58, 57, 15][i] })) },
    );
    expect(aligned.keyColumns).toEqual(['SEASON']);
    expect(aligned.summary).toEqual({ same: 5, changed: 0, new: 1, removed: 0 });
    expect(aligned.rows.at(-1)).toEqual({ key: [2019], from: null, to: [15], state: 'new' });
  });

  it('runs both versions\' SQL through the runner it is given', async () => {
    const root = project();
    put(root, WINS, block('wins', SQL_2018));
    const history = await open(root);
    put(root, WINS, block('wins', SQL_2019));
    await save(history);
    const ran: string[] = [];
    const result = await history.runBoth(WINS, 1, 2, async (source) => {
      ran.push(source);
      return { columns: ['SEASON'], rows: source.includes('2019') ? [{ SEASON: 2018 }, { SEASON: 2019 }] : [{ SEASON: 2018 }] };
    });
    expect(ran).toHaveLength(2);
    expect(result.summary).toMatchObject({ same: 1, new: 1 });
  });
});

describe('the SQL log (best effort)', () => {
  it('writes content-free rows in a batch only while the warehouse is running, and skips with one warning when it cannot', async () => {
    const root = project();
    put(root, WINS, block('wins', SQL_2018));
    const calls: string[] = [];
    let running = false;
    let refuse = false;
    const warnings: string[] = [];
    const history = await open(root, {
      log: { info: () => undefined, warn: (message) => warnings.push(message) },
      sqlLog: {
        appName: 'ZLENS_APP',
        warehouse: () => 'ZLENS_APP_WH',
        query: async (sql) => {
          calls.push(sql);
          if (sql.startsWith('SHOW WAREHOUSES')) return [{ name: 'ZLENS_APP_WH', state: running ? 'STARTED' : 'SUSPENDED' }];
          if (refuse) throw new Error('Insufficient privileges to operate on table HISTORY_LOG');
          return [];
        },
      },
    });
    expect(history.pendingSqlRows()).toEqual([expect.objectContaining({ item: 'wins', kind: 'saved_query', version: 1, change: 'started', certified: false, changedBy: 'ZLens' })]);
    expect(await history.flushSqlLog()).toBe('waiting');
    expect(calls.filter((sql) => sql.startsWith('MERGE'))).toHaveLength(0);
    running = true;
    expect(await history.flushSqlLog()).toBe('written');
    const merge = calls.find((sql) => sql.startsWith('MERGE'))!;
    expect(merge).toContain('MERGE INTO ZLENS_APP.CORE.HISTORY_LOG t');
    // Content-free: the name and the facts, never the SQL.
    expect(merge).not.toContain('team_seasons');
    expect(history.pendingSqlRows()).toEqual([]);

    put(root, WINS, block('wins', SQL_2019));
    await save(history);
    refuse = true;
    expect(await history.flushSqlLog()).toBe('skipped');
    expect(await history.flushSqlLog()).toBe('skipped');
    expect(warnings.filter((warning) => warning.includes('HISTORY_LOG'))).toHaveLength(1);
    // History itself is unaffected.
    put(root, WINS, block('wins', 'SELECT 3'));
    expect(await save(history)).toHaveLength(1);
    expect(history.item(WINS).versions[0]!.version).toBe(3);
    expect((await history.status()).sqlLog.state).toBe('skipped');
  });

  it('writes at the daily stop without a running warehouse, and quotes what it writes', async () => {
    const root = project();
    put(root, WINS, block('it\'s \\ wins', SQL_2018));
    const calls: string[] = [];
    const history = await open(root, { sqlLog: { appName: 'ZLENS_APP', warehouse: () => 'ZLENS_APP_WH', query: async (sql) => { calls.push(sql); return sql.startsWith('SHOW') ? [{ state: 'SUSPENDED' }] : []; } } });
    expect(await history.flushSqlLog({ atStop: true })).toBe('written');
    expect(calls.find((sql) => sql.startsWith('MERGE'))).toContain("'it''s \\\\ wins'");
    expect(sqlString("a'b\nc")).toBe("'a''b c'");
    expect(mergeStatement('A.CORE.HISTORY_LOG', [])).toContain('WHEN NOT MATCHED THEN INSERT');
  });
});

describe('no outside connection', () => {
  it('makes no network call while starting, saving, comparing and restoring', async () => {
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const request = vi.spyOn(http, 'request');
    const secure = vi.spyOn(https, 'request');
    const fetched = vi.spyOn(globalThis, 'fetch');
    const root = project();
    put(root, WINS, block('wins', SQL_2018));
    const history = await open(root);
    put(root, WINS, block('wins', SQL_2019));
    await save(history);
    await history.compare(WINS, 1, 2);
    await history.restore({ item: WINS, version: 1, user: 'JSMITH' });
    for (const spy of [connect, request, secure, fetched]) expect(spy).not.toHaveBeenCalled();
  });

  it('never imports isomorphic-git\'s network client or any HTTP client', () => {
    const dir = __dirname;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const text = readFileSync(join(dir, file), 'utf-8');
      expect(text, file).not.toMatch(/(from|import\(|require\()\s*'isomorphic-git\/http/);
      expect(text, file).not.toMatch(/from 'node:(https|net|tls|dgram)'/);
      expect(text, file).not.toMatch(/\bfetch\(/);
      expect(text.replace(/import type [^;]+;/g, ''), file).not.toMatch(/from 'node:http'/);
    }
  });
});

describe('line diff', () => {
  it('marks removed and added lines with their numbers', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { kind: 'same', text: 'a', oldNumber: 1, newNumber: 1 },
      { kind: 'removed', text: 'b', oldNumber: 2 },
      { kind: 'added', text: 'B', newNumber: 2 },
      { kind: 'same', text: 'c', oldNumber: 3, newNumber: 3 },
      { kind: 'added', text: 'd', newNumber: 4 },
    ]);
    expect(diffLines('', 'x')).toEqual([{ kind: 'added', text: 'x', newNumber: 1 }]);
    expect(diffLines('same', 'same')).toEqual([{ kind: 'same', text: 'same', oldNumber: 1, newNumber: 1 }]);
  });
});
