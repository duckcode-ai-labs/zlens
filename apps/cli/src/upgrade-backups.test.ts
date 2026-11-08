import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUPS_RELATIVE,
  KEEP_BACKUPS,
  LAST_VERSION_RELATIVE,
  backUpOnVersionChange,
  listBackups,
  readLastVersion,
  writeLastVersion,
} from './upgrade-backups.js';

const roots: string[] = [];
const open: Database.Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-upgrade-backups-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'upgrade_backups' }));
  return root;
}

/** A store the way ZLens keeps one: WAL mode, rows written. */
function walStore(path: string, rows: string[], options: { keepOpen?: boolean } = {}): Database.Database | undefined {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Leave committed rows in the -wal file, as a running server does.
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE IF NOT EXISTS notes (body TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO notes (body) VALUES (?)');
  for (const row of rows) insert.run(row);
  if (options.keepOpen) {
    open.push(db);
    return db;
  }
  db.close();
  return undefined;
}

function rowsIn(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT body FROM notes ORDER BY rowid').all() as Array<{ body: string }>).map((row) => row.body);
  } finally {
    db.close();
  }
}

const at = (iso: string) => () => new Date(iso);

describe('upgrades that snapshot first', () => {
  it('records the version on the first run of an empty project, with no backup', () => {
    const root = project();
    const log: string[] = [];

    const result = backUpOnVersionChange(root, '0.3.1', { log: (line) => log.push(line), now: at('2026-11-08T10:00:00Z') });

    expect(result.action).toBe('recorded');
    expect(readLastVersion(root)).toBe('0.3.1');
    expect(JSON.parse(readFileSync(join(root, LAST_VERSION_RELATIVE), 'utf-8'))).toEqual({ version: '0.3.1', at: '2026-11-08T10:00:00.000Z' });
    expect(existsSync(join(root, BACKUPS_RELATIVE))).toBe(false);
    expect(log).toEqual([]);

    // The same version again is a plain start.
    expect(backUpOnVersionChange(root, '0.3.1', { log: (line) => log.push(line) }).action).toBe('unchanged');
    expect(log).toEqual([]);
  });

  it('leaves a folder that is not a ZLens project alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'zlens-upgrade-backups-bare-'));
    roots.push(root);
    expect(backUpOnVersionChange(root, '0.3.1', { log: () => undefined }).action).toBe('skipped');
    expect(existsSync(join(root, '.dql'))).toBe(false);
  });

  it('backs up the stores before an upgrade: WAL copies that open and hold every row', () => {
    const root = project();
    writeLastVersion(root, '0.3.0');
    // One store a running server still holds open, with rows only in its -wal file.
    walStore(join(root, '.dql/local/apps.sqlite'), ['app one', 'app two'], { keepOpen: true });
    expect(existsSync(join(root, '.dql/local/apps.sqlite-wal'))).toBe(true);
    // One closed cleanly.
    walStore(join(root, '.dql/cache/operations.sqlite'), ['op one']);
    walStore(join(root, '.dql/local/dataset-results.sqlite'), ['big cached result']);
    mkdirSync(join(root, '.dql/local/private/home'), { recursive: true });
    writeFileSync(join(root, '.dql/local/private/home/maya.json'), '{"cards":[1]}');
    walStore(join(root, '.dql/local/private/research/maya.sqlite'), ['research note']);
    writeFileSync(join(root, '.dql/provider-settings.json'), '{"active":"anthropic"}');
    const log: string[] = [];

    const result = backUpOnVersionChange(root, '0.3.1', { log: (line) => log.push(line), now: at('2026-11-08T10:15:30Z') });

    expect(result.action).toBe('backed-up');
    expect(result.backup?.name).toBe('0.3.0-to-0.3.1-20261108T101530Z');
    const folder = join(root, BACKUPS_RELATIVE, '0.3.0-to-0.3.1-20261108T101530Z');
    expect(rowsIn(join(folder, 'local/apps.sqlite'))).toEqual(['app one', 'app two']);
    expect(rowsIn(join(folder, 'cache/operations.sqlite'))).toEqual(['op one']);
    expect(rowsIn(join(folder, 'local/private/research/maya.sqlite'))).toEqual(['research note']);
    expect(readFileSync(join(folder, 'local/private/home/maya.json'), 'utf-8')).toBe('{"cards":[1]}');
    expect(readFileSync(join(folder, 'provider-settings.json'), 'utf-8')).toBe('{"active":"anthropic"}');
    // Each copy is one self-contained file.
    expect(readdirSync(join(folder, 'local')).sort()).toEqual(['apps.sqlite', 'private']);
    // The Dataset results cache is left out, and the manifest says so.
    expect(existsSync(join(folder, 'local/dataset-results.sqlite'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(folder, 'backup.json'), 'utf-8'));
    expect(manifest).toMatchObject({ createdBy: 'zlens', from: '0.3.0', to: '0.3.1', at: '2026-11-08T10:15:30.000Z', reason: 'upgrade', failed: [] });
    expect(manifest.files.map((file: { path: string }) => file.path).sort()).toEqual([
      '.dql/cache/operations.sqlite',
      '.dql/local/apps.sqlite',
      '.dql/local/private/home/maya.json',
      '.dql/local/private/research/maya.sqlite',
      '.dql/provider-settings.json',
    ]);
    for (const file of manifest.files) expect(file.bytes).toBeGreaterThan(0);
    expect(manifest.skipped).toEqual([{ path: '.dql/local/dataset-results.sqlite', reason: expect.stringContaining('rebuildable') }]);
    // Backing up a closed store leaves no -wal/-shm files beside it.
    expect(readdirSync(join(root, '.dql/cache'))).toEqual(['operations.sqlite']);

    expect(readLastVersion(root)).toBe('0.3.1');
    expect(log).toEqual([
      `[zlens] Opening this project with ZLens 0.3.1 (last opened by 0.3.0): backed up its state first, in ${BACKUPS_RELATIVE}/0.3.0-to-0.3.1-20261108T101530Z. zlens backups lists backups.`,
    ]);
    expect(listBackups(root).map((entry) => entry.name)).toEqual(['0.3.0-to-0.3.1-20261108T101530Z']);
  });

  it('backs up existing stores when no version was ever recorded', () => {
    const root = project();
    walStore(join(root, '.dql/local/agent-runs.sqlite'), ['run']);
    const log: string[] = [];

    const result = backUpOnVersionChange(root, '0.3.1', { log: (line) => log.push(line), now: at('2026-11-08T11:00:00Z') });

    expect(result).toMatchObject({ action: 'backed-up', previousVersion: null, backup: { name: 'unknown-to-0.3.1-20261108T110000Z' } });
    expect(result.backup?.manifest).toMatchObject({ from: null, reason: 'unrecorded' });
    expect(log[0]).toContain('no earlier version recorded');
    expect(readLastVersion(root)).toBe('0.3.1');
  });

  it(`keeps only the ${KEEP_BACKUPS} newest of its own backups`, () => {
    const root = project();
    walStore(join(root, '.dql/local/apps.sqlite'), ['app']);
    // A folder someone else put there is not ZLens's to delete.
    mkdirSync(join(root, BACKUPS_RELATIVE, 'my-own-copy'), { recursive: true });
    const versions = ['0.3.0', '0.3.1', '0.3.2', '0.3.3', '0.3.4'];
    writeLastVersion(root, versions[0]);
    versions.slice(1).forEach((version, index) => {
      backUpOnVersionChange(root, version, { log: () => undefined, now: at(`2026-11-0${index + 1}T09:00:00Z`) });
    });

    expect(listBackups(root).map((entry) => entry.name)).toEqual([
      '0.3.3-to-0.3.4-20261104T090000Z',
      '0.3.2-to-0.3.3-20261103T090000Z',
      '0.3.1-to-0.3.2-20261102T090000Z',
    ]);
    expect(readdirSync(join(root, BACKUPS_RELATIVE)).sort()).toEqual([
      '0.3.1-to-0.3.2-20261102T090000Z',
      '0.3.2-to-0.3.3-20261103T090000Z',
      '0.3.3-to-0.3.4-20261104T090000Z',
      'my-own-copy',
    ]);
  });

  it('warns on a downgrade, backs up anyway, and points at the backup from before the upgrade', () => {
    const root = project();
    walStore(join(root, '.dql/local/apps.sqlite'), ['written by 0.3.0']);
    writeLastVersion(root, '0.3.0');
    backUpOnVersionChange(root, '0.4.0', { log: () => undefined, now: at('2026-11-01T09:00:00Z') });
    walStore(join(root, '.dql/local/apps.sqlite'), ['written by 0.4.0']);
    const log: string[] = [];

    // 0.3.0 opens the project again.
    const result = backUpOnVersionChange(root, '0.3.0', { log: (line) => log.push(line), now: at('2026-11-02T09:00:00Z') });

    expect(result).toMatchObject({ action: 'backed-up', downgrade: true, previousVersion: '0.4.0', priorBackup: '0.3.0-to-0.4.0-20261101T090000Z' });
    expect(result.backup?.manifest).toMatchObject({ from: '0.4.0', to: '0.3.0', reason: 'downgrade' });
    expect(log).toEqual([
      '[zlens] Warning: this project was last opened by ZLens 0.4.0, newer than this ZLens 0.3.0; its saved state may not read correctly.'
      + ` Saved its state in ${BACKUPS_RELATIVE}/0.4.0-to-0.3.0-20261102T090000Z.`
      + ' The backup from before the upgrade is 0.3.0-to-0.4.0-20261101T090000Z; to go back to it, stop ZLens and run zlens backups restore 0.3.0-to-0.4.0-20261101T090000Z --yes.',
    ]);
    expect(rowsIn(join(root, BACKUPS_RELATIVE, '0.3.0-to-0.4.0-20261101T090000Z/local/apps.sqlite'))).toEqual(['written by 0.3.0']);
    expect(rowsIn(join(root, BACKUPS_RELATIVE, '0.4.0-to-0.3.0-20261102T090000Z/local/apps.sqlite'))).toEqual(['written by 0.3.0', 'written by 0.4.0']);
    expect(readLastVersion(root)).toBe('0.3.0');
    // Recorded now: the next start of 0.3.0 is a plain one.
    expect(backUpOnVersionChange(root, '0.3.0', { log: (line) => log.push(line) }).action).toBe('unchanged');
    expect(log).toHaveLength(1);
  });

  it('says so on a downgrade with no backup from before the upgrade, and never prunes the one it names', () => {
    const root = project();
    walStore(join(root, '.dql/local/apps.sqlite'), ['app']);
    writeLastVersion(root, '0.5.0');
    const log: string[] = [];
    backUpOnVersionChange(root, '0.4.9', { log: (line) => log.push(line), now: at('2026-11-01T09:00:00Z') });
    expect(log[0]).toContain('No backup from before the upgrade was found.');

    // A backup of 0.3.0's state, then three newer ones: on the downgrade to 0.3.0, keeping
    // the newest three would drop the one the warning names.
    writeLastVersion(root, '0.3.0');
    backUpOnVersionChange(root, '0.4.0', { log: () => undefined, now: at('2026-11-02T09:00:00Z') });
    backUpOnVersionChange(root, '0.5.0', { log: () => undefined, now: at('2026-11-03T09:00:00Z') });
    backUpOnVersionChange(root, '0.6.0', { log: () => undefined, now: at('2026-11-04T09:00:00Z') });
    const result = backUpOnVersionChange(root, '0.3.0', { log: () => undefined, now: at('2026-11-05T09:00:00Z') });

    expect(result.priorBackup).toBe('0.3.0-to-0.4.0-20261102T090000Z');
    expect(listBackups(root).map((entry) => entry.name)).toEqual([
      '0.6.0-to-0.3.0-20261105T090000Z',
      '0.5.0-to-0.6.0-20261104T090000Z',
      '0.4.0-to-0.5.0-20261103T090000Z',
      '0.3.0-to-0.4.0-20261102T090000Z',
    ]);
  });

  it('does not throw when the backup fails, and startup goes on', () => {
    const root = project();
    walStore(join(root, '.dql/local/apps.sqlite'), ['app']);
    writeLastVersion(root, '0.3.0');
    // Where the backups go is a file, so no backup folder can be made.
    writeFileSync(join(root, BACKUPS_RELATIVE), 'not a folder');
    const log: string[] = [];

    let result: ReturnType<typeof backUpOnVersionChange> | undefined;
    expect(() => { result = backUpOnVersionChange(root, '0.3.1', { log: (line) => log.push(line) }); }).not.toThrow();

    expect(result?.action).toBe('failed');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^\[zlens\] Could not back up this project's state before ZLens 0\.3\.1 opens it \(.+\); starting anyway\.$/);
    expect(readLastVersion(root)).toBe('0.3.1');
    expect(rowsIn(join(root, '.dql/local/apps.sqlite'))).toEqual(['app']);
  });

  it('never fills the disk: skips the backup, saying why, when less than 1 GB would stay free', () => {
    const root = project();
    walStore(join(root, '.dql/local/apps.sqlite'), ['app']);
    writeLastVersion(root, '0.3.0');
    const log: string[] = [];
    const tight = backUpOnVersionChange(root, '0.3.1', { log: (line) => log.push(line), freeBytes: () => 1024 ** 3 + 1024 });
    expect(tight.action).toBe('failed');
    expect(log[0]).toMatch(/not enough free disk: it needs \d+ MB and 1024 MB is free; ZLens keeps at least 1 GB free/);
    expect(existsSync(join(root, BACKUPS_RELATIVE))).toBe(false);
    expect(readLastVersion(root)).toBe('0.3.1');

    writeLastVersion(root, '0.3.0');
    expect(backUpOnVersionChange(root, '0.3.1', { log: () => undefined, freeBytes: () => 5 * 1024 ** 3 }).action).toBe('backed-up');
    expect(backUpOnVersionChange(project(), '0.3.1', { log: () => undefined, freeBytes: () => undefined }).action).toBe('recorded');
  });

  it('records a store it cannot read as failed in the manifest and copies the rest', () => {
    const root = project();
    walStore(join(root, '.dql/local/apps.sqlite'), ['app']);
    mkdirSync(join(root, '.dql/cache'), { recursive: true });
    writeFileSync(join(root, '.dql/cache/metadata.sqlite'), 'this is not a SQLite database, only text long enough');
    writeLastVersion(root, '0.3.0');
    const log: string[] = [];

    const result = backUpOnVersionChange(root, '0.3.1', { log: (line) => log.push(line), now: at('2026-11-08T12:00:00Z') });

    expect(result.action).toBe('backed-up');
    expect(result.backup?.manifest.files.map((file) => file.path)).toEqual(['.dql/local/apps.sqlite']);
    expect(result.backup?.manifest.failed).toEqual([{ path: '.dql/cache/metadata.sqlite', error: expect.any(String) }]);
    expect(log[0]).toContain('(1 file could not be copied; see backup.json)');
  });
});
