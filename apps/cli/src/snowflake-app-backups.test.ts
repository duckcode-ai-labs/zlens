import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import tarStream from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';
import { entryPath } from './project-archive.js';
import { excludedFromExport, SnowflakeAppBackups, parseStageName } from './snowflake-app-backups.js';
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
  const files = new Map<string, number>((options.files ?? []).map((file) => [file, 100]));
  // What PUT uploaded (or a test placed), byte for byte; GET returns it. A listed file with no bytes is not an archive.
  const bytes = new Map<string, Buffer>();
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
      const name = match[1]!.split('/').pop()!;
      bytes.set(name, readFileSync(match[1]!));
      files.set(name, bytes.get(name)!.length);
      return [{ status: 'UPLOADED' }];
    }
    if (sql.startsWith('LIST @')) return [...files.entries()].map(([file, size]) => ({ name: `zlens_backups/${file}`, size, last_modified: 'Mon, 9 Nov 2026 22:00:00 GMT' }));
    if ((match = sql.match(/^REMOVE @\S+\/(\S+)$/))) { files.delete(match[1]!); return []; }
    if ((match = sql.match(/^GET @\S+\/(\S+) 'file:\/\/(.+)\/'$/))) {
      if (files.has(match[1]!)) writeFileSync(join(match[2]!, match[1]!), bytes.get(match[1]!) ?? 'archive');
      return [];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { query, calls, snapshots, files, bytes };
}

/** The entries of a .tar.gz, by name, with their type and bytes. */
async function entries(archive: Buffer): Promise<Map<string, { type: string; body: Buffer; mode: number }>> {
  const found = new Map<string, { type: string; body: Buffer; mode: number }>();
  const extract = tarStream.extract();
  extract.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      found.set(header.name, { type: header.type ?? 'file', body: Buffer.concat(chunks), mode: header.mode ?? 0 });
      next();
    });
    stream.resume();
  });
  await new Promise<void>((done, fail) => {
    extract.on('finish', done);
    extract.on('error', fail);
    extract.end(gunzipSync(archive));
  });
  return found;
}

/** A .tar.gz with exactly these entries, for archives ZLens itself would never write. */
async function archiveOf(items: Array<{ name: string; type?: 'file' | 'directory' | 'symlink' | 'link' | 'character-device' | 'fifo'; body?: string; linkname?: string }>): Promise<Buffer> {
  const pack = tarStream.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((done) => pack.on('end', done));
  for (const item of items) {
    await new Promise<void>((done, fail) => {
      const type = item.type ?? 'file';
      const header = { name: item.name, type, mode: type === 'directory' ? 0o755 : 0o644, ...(item.linkname ? { linkname: item.linkname } : {}), ...(type === 'character-device' ? { devmajor: 1, devminor: 3 } : {}) };
      if (type === 'file') pack.entry(header, item.body ?? '', (error) => (error ? fail(error) : done()));
      else pack.entry(header, (error) => (error ? fail(error) : done()));
    });
  }
  pack.finalize();
  await ended;
  return gzipSync(Buffer.concat(chunks));
}

/** Run `job` with no external program on PATH: the app's image has no tar, gzip, sync or shell. */
async function withoutPrograms<T>(job: () => Promise<T>): Promise<T> {
  const empty = mkdtempSync(join(tmpdir(), 'zlens-empty-path-'));
  roots.push(empty);
  const before = process.env.PATH;
  process.env.PATH = empty;
  try {
    // The proof that PATH is empty: tar cannot be found.
    expect(spawnSync('tar', ['--version']).error).toMatchObject({ code: 'ENOENT' });
    return await job();
  } finally {
    process.env.PATH = before;
  }
}

const hasTar = spawnSync('tar', ['--version']).status === 0;

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
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query, now: at('2026-11-09T22:00:00Z'), sleep: async () => undefined });
    writeFileSync(join(root, 'dql.config.json'), '{}');
    // The files are flushed with fsync, not the sync program the image does not have.
    const snapshot = await withoutPrograms(() => backups.snapshotNow());
    expect(snapshot).toMatchObject({ name: 'ZLENS_BACKUP_20261109_220000', state: 'CREATED' });
    expect([...snowflake.snapshots.keys()].sort()).toEqual([...old.slice(1).map((item) => item.name), 'ZLENS_BACKUP_20261109_220000'].sort());
    expect(snowflake.calls).toContain('DROP SNAPSHOT IF EXISTS ZLENS_APP.CORE.ZLENS_BACKUP_20261101_220000');
    expect(JSON.parse(readFileSync(join(root, '.dql', 'local', 'snowflake-app-backup.json'), 'utf8'))).toMatchObject({ lastSnapshotAt: '2026-11-09T22:00:00.000Z' });
  });

  it('backs up once a day: nothing when the newest snapshot is recent, a snapshot and an export when it is old', async () => {
    const root = workspace();
    writeFileSync(join(root, 'dql.config.json'), '{}');
    const recent = fakeSnowflake({ snapshots: [{ name: 'ZLENS_BACKUP_20261109_200000', created_on: '2026-11-09T20:00:00Z' }] });
    const quiet = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: recent.query, now: at('2026-11-09T22:00:00Z'), sleep: async () => undefined });
    expect(await quiet.daily(20)).toEqual({ export: null });
    expect(recent.calls.some((sql) => sql.startsWith('CREATE SNAPSHOT'))).toBe(false);

    const due = fakeSnowflake({ stage: 'MY_DB.TOOLS.ZLENS_BACKUPS', snapshots: [{ name: 'ZLENS_BACKUP_20261108_200000', created_on: '2026-11-08T20:00:00Z' }] });
    mkdirSync(join(root, '.dql', 'cache'), { recursive: true });
    writeFileSync(join(root, '.dql', 'cache', 'metadata.sqlite'), 'rebuilt');
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: due.query, now: at('2026-11-09T22:00:00Z'), sleep: async () => undefined });
    const result = await withoutPrograms(() => backups.daily(20));
    expect(result.error).toBeUndefined();
    expect(result.snapshot?.name).toBe('ZLENS_BACKUP_20261109_220000');
    expect(result.export?.file).toBe('zlens-zlens_app-20261109_220000.tar.gz');
    // The project as a .tar.gz, without what ZLens rebuilds or installs.
    const names = [...(await entries(due.bytes.get('zlens-zlens_app-20261109_220000.tar.gz')!)).keys()];
    expect(names).toContain('./dql.config.json');
    expect(names.some((name) => name.startsWith('./.dql/cache'))).toBe(false);
    expect(due.calls.find((sql) => sql.startsWith('PUT'))).toMatch(/^PUT 'file:\/\/.+\/zlens-zlens_app-20261109_220000\.tar\.gz' @MY_DB\.TOOLS\.ZLENS_BACKUPS AUTO_COMPRESS = FALSE OVERWRITE = TRUE$/);
  });

  it('exports only when the project changed since the last export, and keeps the newest fourteen', async () => {
    const root = workspace();
    mkdirSync(join(root, 'domains'));
    writeFileSync(join(root, 'domains', 'sales.dql'), 'x');
    const files = Array.from({ length: 14 }, (_, i) => `zlens-zlens_app-202611${String(i + 1).padStart(2, '0')}_220000.tar.gz`);
    const snowflake = fakeSnowflake({ stage: 'MY_DB.TOOLS.ZLENS_BACKUPS', files });
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query, now: at('2026-11-20T22:00:00Z') });
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
    snowflake.bytes.set('zlens-zlens_app-20261108_220000.tar.gz', await archiveOf([
      { name: './', type: 'directory' },
      { name: './domains/', type: 'directory' },
      { name: './domains/restored.dql', body: 'restored' },
      { name: './.dql/local/agent-runs.sqlite', body: 'history' },
      // A copy's own drivers never replace the installed ones.
      { name: './.dql/connectors/driver.js', body: 'from the copy' },
    ]));
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query });
    expect(backups.projectIsEmpty()).toBe(true);
    await expect(backups.restoreExport('../../etc/passwd')).rejects.toThrow('Not a ZLens backup');
    await withoutPrograms(() => backups.restoreExport('zlens-zlens_app-20261108_220000.tar.gz'));
    expect(readFileSync(join(root, '.dql', 'connectors', 'driver.js'), 'utf8')).toBe('driver');
    expect(existsSync(join(root, '.dql', 'local', 'drafts.json'))).toBe(false);
    expect(readFileSync(join(root, '.dql', 'local', 'agent-runs.sqlite'), 'utf8')).toBe('history');
    expect(existsSync(join(root, 'dql.config.json'))).toBe(false);
    expect(readFileSync(join(root, 'domains', 'restored.dql'), 'utf8')).toBe('restored');
    expect(readdirSync(root).filter((name) => name.startsWith('.zlens-restore-'))).toEqual([]);
    expect(backups.projectIsEmpty()).toBe(false);
  });

  it('leaves the project as it was when the copy does not unpack', async () => {
    const root = workspace();
    mkdirSync(join(root, 'domains'), { recursive: true });
    writeFileSync(join(root, 'domains', 'sales.dql'), 'mine');
    writeFileSync(join(root, 'dql.config.json'), '{}');
    // Listed in the stage, but its bytes are not a .tar.gz.
    const snowflake = fakeSnowflake({ stage: 'MY_DB.TOOLS.ZLENS_BACKUPS', files: ['zlens-zlens_app-20261108_220000.tar.gz'] });
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query });
    await expect(withoutPrograms(() => backups.restoreExport('zlens-zlens_app-20261108_220000.tar.gz'))).rejects.toThrow('the project is unchanged');
    expect(readFileSync(join(root, 'domains', 'sales.dql'), 'utf8')).toBe('mine');
    expect(existsSync(join(root, 'dql.config.json'))).toBe(true);
    expect(readdirSync(root).filter((name) => name.startsWith('.zlens-restore-'))).toEqual([]);
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

/** A project with everything an export meets: kept files, left-out folders, a link, a big file, odd names. */
function richProject(): { root: string; big: Buffer } {
  const root = workspace();
  const write = (path: string, body: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  write('dql.config.json', '{"project":"nba"}');
  write('domains/nba/blocks/warriors_wins.dql', 'block "warriors_wins" {}');
  write('notebooks/nba/Warriors été.dqlnb', '{"cells":[]}');
  // Longer than tar's 100-character name field.
  write(`domains/nba/blocks/${'a_very_long_folder_name_'.repeat(4)}/${'and_a_long_saved_query_name_'.repeat(3)}.dql`, 'long');
  write('apps/empty.json', '');
  write('.dql/history/blocks/warriors_wins/2026-11-14T22-00-00Z.dql', 'an earlier version');
  write('.dql/local/agent-runs.sqlite', 'runs');
  // Left out: rebuilt by ZLens, installed by ZLens, a restore in progress, git, node_modules.
  write('.dql/cache/metadata.sqlite', 'cache');
  write('.dql/connectors/snowflake/driver.js', 'driver');
  write('.dql/runtimes/python/bin', 'runtime');
  write('.zlens-restore-20261101_000000/domains/x.dql', 'half a restore');
  write('.git/HEAD', 'ref: refs/heads/main');
  write('node_modules/x/index.js', 'x');
  // Not left out: the same names deeper down.
  write('domains/node_modules/kept.dql', 'kept');
  // Bigger than one read (1 MiB), so it is streamed in pieces.
  const big = Buffer.alloc(2.5 * 1024 * 1024 + 7);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 31) % 251;
  write('.dql/local/metadata.sqlite', big);
  symlinkSync(join(root, 'domains'), join(root, 'domains-link'));
  return { root, big };
}

describe('V14: the copy in the backup stage needs no tar, gzip or sync (the image has none)', () => {
  it('leaves out what ZLens rebuilds or installs, and keeps .dql/history', () => {
    for (const path of ['.dql/cache', '.dql/cache/metadata.sqlite', '.dql/connectors/x', '.dql/runtimes', 'node_modules', 'node_modules/a/b.js', '.git/HEAD', '.zlens-restore-20261101_000000', '.zlens-restore-x/domains/a.dql', './node_modules']) {
      expect(excludedFromExport(path)).toBe(true);
    }
    for (const path of ['.dql', '.dql/history', '.dql/history/blocks/x.dql', '.dql/local/agent-runs.sqlite', 'domains/node_modules/kept.dql', 'domains/.zlens-restore-x', '.dql/cachex', 'node_modules_old']) {
      expect(excludedFromExport(path)).toBe(false);
    }
  });

  it('exports the project and restores it, byte for byte, with no program on PATH', async () => {
    const { root, big } = richProject();
    const snowflake = fakeSnowflake({ stage: 'MY_DB.TOOLS.ZLENS_BACKUPS' });
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query, now: at('2026-11-14T22:00:00Z') });
    const exported = await withoutPrograms(() => backups.exportNow({ force: true }));
    expect(exported?.file).toBe('zlens-zlens_app-20261114_220000.tar.gz');
    const archive = snowflake.bytes.get('zlens-zlens_app-20261114_220000.tar.gz')!;
    expect(archive.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    // Named as `tar -czf FILE -C ROOT .` named them.
    const listed = await entries(archive);
    const names = [...listed.keys()];
    expect(names[0]).toBe('./');
    expect(names).toEqual(expect.arrayContaining(['./domains/', './domains/nba/blocks/warriors_wins.dql', './.dql/history/blocks/warriors_wins/2026-11-14T22-00-00Z.dql', './notebooks/nba/Warriors été.dqlnb', './apps/empty.json', './domains/node_modules/kept.dql']));
    expect(names.some((name) => name.length > 100)).toBe(true);
    for (const left of ['./.dql/cache', './.dql/connectors', './.dql/runtimes', './.zlens-restore-', './.git', './node_modules', './domains-link']) {
      expect(names.filter((name) => name.startsWith(left))).toEqual([]);
    }
    expect([...listed.values()].every((entry) => entry.type === 'file' || entry.type === 'directory')).toBe(true);
    expect(listed.get('./.dql/local/metadata.sqlite')!.body.equals(big)).toBe(true);

    // A new install: an empty project with the driver it installed.
    const fresh = workspace();
    mkdirSync(join(fresh, '.dql', 'connectors', 'snowflake'), { recursive: true });
    writeFileSync(join(fresh, '.dql', 'connectors', 'snowflake', 'driver.js'), 'installed here');
    const restore = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: fresh, query: snowflake.query, now: at('2026-11-15T09:00:00Z') });
    await withoutPrograms(() => restore.restoreExport('zlens-zlens_app-20261114_220000.tar.gz'));
    const kept = ['dql.config.json', 'domains/nba/blocks/warriors_wins.dql', 'notebooks/nba/Warriors été.dqlnb', 'apps/empty.json', '.dql/history/blocks/warriors_wins/2026-11-14T22-00-00Z.dql', '.dql/local/agent-runs.sqlite', '.dql/local/metadata.sqlite', 'domains/node_modules/kept.dql'];
    for (const path of kept) expect(readFileSync(join(fresh, path)).equals(readFileSync(join(root, path))), path).toBe(true);
    const long = readdirSync(join(fresh, 'domains', 'nba', 'blocks')).find((name) => name.startsWith('a_very_long'))!;
    expect(readdirSync(join(fresh, 'domains', 'nba', 'blocks', long))).toHaveLength(1);
    expect(readFileSync(join(fresh, '.dql', 'connectors', 'snowflake', 'driver.js'), 'utf8')).toBe('installed here');
    for (const gone of ['.dql/cache', '.dql/runtimes', '.git', 'node_modules', 'domains-link', '.zlens-restore-20261101_000000']) expect(existsSync(join(fresh, gone)), gone).toBe(false);
    expect(readdirSync(fresh).filter((name) => name.startsWith('.zlens-restore-'))).toEqual([]);
    // No group or other write, no set-id bits, owned by whoever restored it.
    const mode = statSync(join(fresh, 'dql.config.json')).mode & 0o7777;
    expect(mode & 0o7022).toBe(0);
    expect(statSync(join(fresh, 'dql.config.json')).uid).toBe(process.getuid?.() ?? statSync(join(fresh, 'dql.config.json')).uid);
  });

  it.skipIf(!hasTar)('writes an archive tar reads, and restores a copy tar wrote (copies made before V14)', async () => {
    const { root } = richProject();
    const snowflake = fakeSnowflake({ stage: 'MY_DB.TOOLS.ZLENS_BACKUPS', files: ['zlens-zlens_app-20261101_220000.tar.gz'] });
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query, now: at('2026-11-14T22:00:00Z') });
    await withoutPrograms(() => backups.exportNow({ force: true }));
    const ours = join(workspace(), 'ours.tar.gz');
    writeFileSync(ours, snowflake.bytes.get('zlens-zlens_app-20261114_220000.tar.gz')!);
    const listing = spawnSync('tar', ['-tzf', ours], { encoding: 'utf8' });
    expect(listing.status).toBe(0);
    expect(listing.stdout.split('\n')).toEqual(expect.arrayContaining(['./', './dql.config.json', './.dql/history/blocks/warriors_wins/2026-11-14T22-00-00Z.dql']));

    // What V13 and before ran: tar -czf with the same excludes.
    const theirs = join(workspace(), 'theirs.tar.gz');
    const made = spawnSync('tar', ['-czf', theirs, '--exclude=./.dql/cache', '--exclude=./.dql/connectors', '--exclude=./.dql/runtimes', '--exclude=./node_modules', '--exclude=./.git', '--exclude=./.zlens-restore-*', '--exclude=./domains-link', '-C', root, '.']);
    expect(made.status).toBe(0);
    snowflake.bytes.set('zlens-zlens_app-20261101_220000.tar.gz', readFileSync(theirs));
    const fresh = workspace();
    const restore = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: fresh, query: snowflake.query });
    await withoutPrograms(() => restore.restoreExport('zlens-zlens_app-20261101_220000.tar.gz'));
    expect(readFileSync(join(fresh, 'domains', 'nba', 'blocks', 'warriors_wins.dql'), 'utf8')).toBe('block "warriors_wins" {}');
    expect(readFileSync(join(fresh, '.dql', 'history', 'blocks', 'warriors_wins', '2026-11-14T22-00-00Z.dql'), 'utf8')).toBe('an earlier version');
    expect(readFileSync(join(fresh, 'notebooks', 'nba', 'Warriors été.dqlnb'), 'utf8')).toBe('{"cells":[]}');
  });

  const hostile: Array<[string, Parameters<typeof archiveOf>[0], RegExp]> = [
    ['a path out of the project', [{ name: './', type: 'directory' }, { name: '../evil.txt', body: 'out' }], /outside the project \(\.\.\/evil\.txt\)/],
    ['a path out of the project, two levels up', [{ name: './domains/../../evil.txt', body: 'out' }], /outside the project/],
    ['an absolute path', [{ name: '/tmp/zlens-evil.txt', body: 'out' }], /absolute path/],
    ['a symbolic link', [{ name: './domains/', type: 'directory' }, { name: './domains/link', type: 'symlink', linkname: '/etc' }, { name: './domains/link/passwd', body: 'out' }], /symbolic link \(\.\/domains\/link\)/],
    ['a hard link', [{ name: './dql.config.json', body: '{}' }, { name: './copy', type: 'link', linkname: '/etc/passwd' }], /hard link/],
    ['a device', [{ name: './null', type: 'character-device' }], /character-device/],
    ['a FIFO', [{ name: './pipe', type: 'fifo' }], /fifo/],
  ];
  for (const [what, items, reason] of hostile) {
    it(`refuses a copy with ${what}, and leaves the project as it was`, async () => {
      const root = workspace();
      mkdirSync(join(root, 'domains'), { recursive: true });
      writeFileSync(join(root, 'domains', 'sales.dql'), 'mine');
      const snowflake = fakeSnowflake({ stage: 'MY_DB.TOOLS.ZLENS_BACKUPS', files: ['zlens-zlens_app-20261108_220000.tar.gz'] });
      snowflake.bytes.set('zlens-zlens_app-20261108_220000.tar.gz', await archiveOf(items));
      const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query });
      const refused = withoutPrograms(() => backups.restoreExport('zlens-zlens_app-20261108_220000.tar.gz'));
      await expect(refused).rejects.toThrow(/did not unpack; the project is unchanged/);
      await expect(refused).rejects.toThrow(reason);
      expect(readdirSync(root).sort()).toEqual(['domains']);
      expect(readFileSync(join(root, 'domains', 'sales.dql'), 'utf8')).toBe('mine');
      expect(existsSync(join(root, 'evil.txt'))).toBe(false);
      expect(existsSync(join(dirname(root), 'evil.txt'))).toBe(false);
      expect(existsSync('/tmp/zlens-evil.txt')).toBe(false);
    });
  }

  it('refuses an entry of a kind it does not know, rather than writing it as a file', async () => {
    // A one-file archive whose type flag is changed to V (a volume header), with its checksum fixed.
    const tar = gunzipSync(await archiveOf([{ name: './dql.config.json', body: '{}' }]));
    tar[156] = 'V'.charCodeAt(0);
    tar.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += tar[i]!;
    tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    const root = workspace();
    mkdirSync(join(root, 'domains'));
    const snowflake = fakeSnowflake({ stage: 'MY_DB.TOOLS.ZLENS_BACKUPS', files: ['zlens-zlens_app-20261108_220000.tar.gz'] });
    snowflake.bytes.set('zlens-zlens_app-20261108_220000.tar.gz', gzipSync(tar));
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query });
    await expect(withoutPrograms(() => backups.restoreExport('zlens-zlens_app-20261108_220000.tar.gz'))).rejects.toThrow(/the project is unchanged.*unknown kind of entry/);
    expect(readdirSync(root)).toEqual(['domains']);
  });

  it('reads entry names the way the restore must: inside the folder or refused', () => {
    expect(entryPath('./')).toBe('');
    expect(entryPath('./domains/x.dql')).toBe('domains/x.dql');
    expect(entryPath('domains//x.dql')).toBe('domains/x.dql');
    expect(entryPath('./a/./b/')).toBe('a/b');
    for (const bad of ['../x', 'a/../../x', 'a/..', '/etc/passwd', 'C:/x', 'a\\..\\x', 'a\0b']) expect(() => entryPath(bad), bad).toThrow();
  });

  it('flushes the project with fsync before a snapshot, and never follows a link out of it', async () => {
    const { root } = richProject();
    const outside = workspace();
    writeFileSync(join(outside, 'secret'), 'not ours');
    symlinkSync(outside, join(root, 'outside-link'));
    const snowflake = fakeSnowflake();
    const backups = new SnowflakeAppBackups({ service: 'ZLENS_APP.CORE.ZLENS', workspace: root, query: snowflake.query, now: at('2026-11-14T22:00:00Z'), sleep: async () => undefined });
    expect((await withoutPrograms(() => backups.snapshotNow())).state).toBe('CREATED');
    expect(lstatSync(join(root, 'outside-link')).isSymbolicLink()).toBe(true);
  });
});
