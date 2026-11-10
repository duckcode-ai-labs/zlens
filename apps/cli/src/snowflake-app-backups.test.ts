import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SnowflakeAppBackups, parseStageName } from './snowflake-app-backups.js';
import { IdleSuspender } from './snowflake-app-settings.js';

/**
 * Backups for the ZLens app for Snowflake (approved design B1–B6): a daily snapshot of the volume inside the app,
 * and a copy of the project in a stage the customer owns, which outlives an uninstall.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-backups-'));
  roots.push(root);
  return root;
}

/** Snowflake as the app sees it: snapshots in its CORE schema, a configuration value, a stage. */
function fakeSnowflake(options: { stage?: string; snapshots?: Array<{ name: string; created_on: string }>; files?: string[] } = {}) {
  const calls: string[] = [];
  const snapshots = new Map((options.snapshots ?? []).map((item) => [item.name, { ...item, state: 'CREATED' }]));
  const files = new Map((options.files ?? []).map((file) => [file, 100]));
  const query = async (sql: string): Promise<Array<Record<string, unknown>>> => {
    calls.push(sql);
    let match: RegExpMatchArray | null;
    if ((match = sql.match(/^CREATE SNAPSHOT IF NOT EXISTS ZLENS_APP\.CORE\.(\S+) FROM SERVICE ZLENS_APP\.CORE\.ZLENS VOLUME "workspace" INSTANCE 0/))) {
      snapshots.set(match[1]!, { name: match[1]!, created_on: new Date('2026-11-09T22:00:00Z').toISOString(), state: 'INITIALIZED' });
      return [{ status: 'ok' }];
    }
    if (sql.startsWith("SHOW SNAPSHOTS LIKE 'ZLENS_BACKUP_%' IN SCHEMA ZLENS_APP.CORE")) {
      const rows = [...snapshots.values()].map((item) => ({ ...item }));
      for (const item of snapshots.values()) item.state = 'CREATED';
      return rows;
    }
    if ((match = sql.match(/^DROP SNAPSHOT IF EXISTS ZLENS_APP\.CORE\.(\S+)$/))) { snapshots.delete(match[1]!); return []; }
    if (sql.includes("GET_CONFIGURATION_VALUE', 'ZLENS_BACKUP_STAGE'")) {
      if (options.stage === undefined) throw new Error("Uncaught exception: Value of Application Configuration 'ZLENS_BACKUP_STAGE' has not been set.");
      return [{ V: options.stage }];
    }
    if ((match = sql.match(/^PUT 'file:\/\/(.+)' @(\S+) AUTO_COMPRESS = FALSE OVERWRITE = TRUE$/))) {
      files.set(match[1]!.split('/').pop()!, readFileSync(match[1]!).length);
      return [{ status: 'UPLOADED' }];
    }
    if (sql.startsWith('LIST @')) return [...files.entries()].map(([file, size]) => ({ name: `zlens_backups/${file}`, size, last_modified: 'Mon, 9 Nov 2026 22:00:00 GMT' }));
    if ((match = sql.match(/^REMOVE @\S+\/(\S+)$/))) { files.delete(match[1]!); return []; }
    if ((match = sql.match(/^GET @\S+\/(\S+) 'file:\/\/(.+)\/'$/))) {
      if (files.has(match[1]!)) writeFileSync(join(match[2]!, match[1]!), 'archive');
      return [];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { query, calls, snapshots, files };
}

/** tar as a list of what it was asked to do: -czf writes the archive, -xzf puts a restored project down. */
function fakeTar() {
  const runs: string[][] = [];
  const run = (command: string, args: string[]) => {
    runs.push([command, ...args]);
    if (command === 'tar' && args[0] === '-czf') writeFileSync(args[1]!, 'tarball');
    if (command === 'tar' && args[0] === '-xzf') {
      const into = args[args.indexOf('-C') + 1]!;
      mkdirSync(join(into, 'domains'), { recursive: true });
      writeFileSync(join(into, 'domains', 'restored.dql'), 'restored');
    }
  };
  return { run, runs };
}

const at = (iso: string) => () => new Date(iso);

describe('backups of the ZLens app for Snowflake', () => {
  it('reads the backup stage from the Configurations tab: unset is none, and only DATABASE.SCHEMA.STAGE is accepted', async () => {
    expect(parseStageName('MY_DB.TOOLS.ZLENS_BACKUPS')).toBe('MY_DB.TOOLS.ZLENS_BACKUPS');
    expect(parseStageName('@my_db.tools."Backups"')).toBe('my_db.tools."Backups"');
    expect(parseStageName("x.y.z; DROP TABLE t")).toBeNull();
    expect(parseStageName('ZLENS_BACKUPS')).toBeNull();
    const root = workspace();
    expect(await new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: fakeSnowflake().query }).stage()).toBeNull();
    await expect(new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: fakeSnowflake({ stage: 'backups' }).query }).stage())
      .rejects.toThrow('use DATABASE.SCHEMA.STAGE');
  });

  it('snapshots the volume, waits until Snowflake can restore from it, and keeps the newest seven', async () => {
    const root = workspace();
    const old = Array.from({ length: 7 }, (_, i) => ({ name: `ZLENS_BACKUP_2026110${i + 1}_220000`, created_on: `2026-11-0${i + 1}T22:00:00Z` }));
    const snowflake = fakeSnowflake({ snapshots: old });
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query, now: at('2026-11-09T22:00:00Z'), run: fakeTar().run, sleep: async () => undefined });
    const snapshot = await backups.snapshotNow();
    expect(snapshot).toMatchObject({ name: 'ZLENS_BACKUP_20261109_220000', state: 'CREATED' });
    expect([...snowflake.snapshots.keys()].sort()).toEqual([...old.slice(1).map((item) => item.name), 'ZLENS_BACKUP_20261109_220000'].sort());
    expect(snowflake.calls).toContain('DROP SNAPSHOT IF EXISTS ZLENS_APP.CORE.ZLENS_BACKUP_20261101_220000');
    expect(JSON.parse(readFileSync(join(root, '.dql', 'local', 'snowflake-app-backup.json'), 'utf8'))).toMatchObject({ lastSnapshotAt: '2026-11-09T22:00:00.000Z' });
  });

  it('backs up once a day: nothing when the newest snapshot is recent, a snapshot and an export when it is old', async () => {
    const root = workspace();
    writeFileSync(join(root, 'dql.config.json'), '{}');
    const recent = fakeSnowflake({ snapshots: [{ name: 'ZLENS_BACKUP_20261109_200000', created_on: '2026-11-09T20:00:00Z' }] });
    const tar = fakeTar();
    const quiet = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: recent.query, now: at('2026-11-09T22:00:00Z'), run: tar.run, sleep: async () => undefined });
    expect(await quiet.daily(20)).toEqual({ export: null });
    expect(recent.calls.some((sql) => sql.startsWith('CREATE SNAPSHOT'))).toBe(false);

    const due = fakeSnowflake({ stage: 'MY_DB.TOOLS.ZLENS_BACKUPS', snapshots: [{ name: 'ZLENS_BACKUP_20261108_200000', created_on: '2026-11-08T20:00:00Z' }] });
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: due.query, now: at('2026-11-09T22:00:00Z'), run: tar.run, sleep: async () => undefined });
    const result = await backups.daily(20);
    expect(result.snapshot?.name).toBe('ZLENS_BACKUP_20261109_220000');
    expect(result.export?.file).toBe('zlens-zlens_app-20261109_220000.tar.gz');
    // The project as a .tar.gz, without what ZLens rebuilds or installs.
    const tarCall = tar.runs.find((call) => call[1] === '-czf')!;
    expect(tarCall).toEqual(expect.arrayContaining(['--exclude=./.dql/cache', '--exclude=./.dql/connectors', '-C', root, '.']));
    expect(due.calls.find((sql) => sql.startsWith('PUT'))).toMatch(/^PUT 'file:\/\/.+\/zlens-zlens_app-20261109_220000\.tar\.gz' @MY_DB\.TOOLS\.ZLENS_BACKUPS AUTO_COMPRESS = FALSE OVERWRITE = TRUE$/);
  });

  it('exports only when the project changed since the last export, and keeps the newest fourteen', async () => {
    const root = workspace();
    mkdirSync(join(root, 'domains'));
    writeFileSync(join(root, 'domains', 'sales.dql'), 'x');
    const files = Array.from({ length: 14 }, (_, i) => `zlens-zlens_app-202611${String(i + 1).padStart(2, '0')}_220000.tar.gz`);
    const snowflake = fakeSnowflake({ stage: 'MY_DB.TOOLS.ZLENS_BACKUPS', files });
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query, now: at('2026-11-20T22:00:00Z'), run: fakeTar().run });
    expect((await backups.exportNow())?.file).toBe('zlens-zlens_app-20261120_220000.tar.gz');
    expect(snowflake.files.size).toBe(14);
    expect(snowflake.files.has('zlens-zlens_app-20261101_220000.tar.gz')).toBe(false);
    // Unchanged since (the backup's own record and the caches do not count): nothing to copy.
    const past = new Date('2026-11-01T00:00:00Z');
    utimesSync(join(root, 'domains', 'sales.dql'), past, past);
    mkdirSync(join(root, '.dql', 'cache'), { recursive: true });
    writeFileSync(join(root, '.dql', 'cache', 'metadata.sqlite'), 'rebuilt');
    expect(await backups.exportNow()).toBeNull();
    writeFileSync(join(root, 'domains', 'sales.dql'), 'changed');
    const later = new Date('2026-11-20T23:00:00Z');
    utimesSync(join(root, 'domains', 'sales.dql'), later, later);
    expect(await backups.exportNow()).not.toBeNull();
  });

  it('restores an export over an empty project, keeping the installed drivers, and refuses anything but a ZLens backup', async () => {
    const root = workspace();
    mkdirSync(join(root, '.dql', 'connectors'), { recursive: true });
    writeFileSync(join(root, '.dql', 'connectors', 'driver.js'), 'driver');
    mkdirSync(join(root, '.dql', 'local'), { recursive: true });
    writeFileSync(join(root, '.dql', 'local', 'drafts.json'), 'old drafts');
    writeFileSync(join(root, 'dql.config.json'), '{}');
    const snowflake = fakeSnowflake({ stage: 'MY_DB.TOOLS.ZLENS_BACKUPS', files: ['zlens-zlens_app-20261108_220000.tar.gz'] });
    const tar = fakeTar();
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query, run: tar.run });
    expect(backups.projectIsEmpty()).toBe(true);
    await expect(backups.restoreExport('../../etc/passwd')).rejects.toThrow('Not a ZLens backup');
    await backups.restoreExport('zlens-zlens_app-20261108_220000.tar.gz');
    // The archive is checked before anything is removed.
    expect(tar.runs.map((call) => call[1])).toEqual(['-tzf', '-xzf']);
    expect(existsSync(join(root, '.dql', 'connectors', 'driver.js'))).toBe(true);
    expect(existsSync(join(root, '.dql', 'local', 'drafts.json'))).toBe(false);
    expect(existsSync(join(root, 'dql.config.json'))).toBe(false);
    expect(readFileSync(join(root, 'domains', 'restored.dql'), 'utf8')).toBe('restored');
    expect(backups.projectIsEmpty()).toBe(false);
  });

  it('stays up when someone comes back while the backup before stopping runs', async () => {
    let now = 0;
    let stops = 0;
    const idle = new IdleSuspender(1000, async () => { stops += 1; }, () => now);
    let release: (() => void) | undefined;
    idle.onBeforeSuspend(async () => {
      now = 1500;
      release = idle.touch();
    });
    now = 1200;
    expect(await idle.check()).toBe(false);
    expect(stops).toBe(0);
    release?.();
    now = 3000;
    idle.onBeforeSuspend(async () => undefined);
    expect(await idle.check()).toBe(true);
    expect(stops).toBe(1);
  });
});
