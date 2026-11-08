import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { writeNotebookDescriptor } from '../schedule/notebook-runtime.js';
import { backUpOnVersionChange, readLastVersion, writeLastVersion } from '../upgrade-backups.js';
import { runBackups } from './backups.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'zlens-backups-command-'));
  roots.push(root);
  writeFileSync(join(root, 'dql.config.json'), JSON.stringify({ project: 'backups_command' }));
  return root;
}

function setRows(path: string, rows: string[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS notes (body TEXT NOT NULL); DELETE FROM notes;');
  const insert = db.prepare('INSERT INTO notes (body) VALUES (?)');
  for (const row of rows) insert.run(row);
  db.close();
}

function rowsIn(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT body FROM notes ORDER BY rowid').all() as Array<{ body: string }>).map((row) => row.body);
  } finally {
    db.close();
  }
}

/** A project upgraded 0.3.0 → 0.3.1, then changed by 0.3.1. */
function upgradedProject(): { root: string; backup: string } {
  const root = project();
  setRows(join(root, '.dql/local/apps.sqlite'), ['before']);
  mkdirSync(join(root, '.dql/local/private/home'), { recursive: true });
  writeFileSync(join(root, '.dql/local/private/home/maya.json'), '{"before":true}');
  writeLastVersion(root, '0.3.0');
  const result = backUpOnVersionChange(root, '0.3.1', { log: () => undefined, now: () => new Date('2026-11-08T10:00:00Z') });
  setRows(join(root, '.dql/local/apps.sqlite'), ['after upgrade']);
  writeFileSync(join(root, '.dql/local/private/home/maya.json'), '{"before":false}');
  writeFileSync(join(root, '.dql/local/private/home/new.json'), '{}');
  return { root, backup: result.backup!.name };
}

const run = async (argv: string[], options: { isAlive?: (pid: number) => boolean } = {}) => {
  const { file, rest, flags } = parseArgs(['backups', ...argv]);
  const lines: string[] = [];
  await runBackups(file, rest, flags, { log: (line) => lines.push(line), isAlive: options.isAlive ?? (() => false) });
  return lines;
};

describe('zlens backups', () => {
  it('lists backups newest first, as text and as JSON', async () => {
    const { root } = upgradedProject();
    backUpOnVersionChange(root, '0.4.0', { log: () => undefined, now: () => new Date('2026-11-09T08:30:00Z') });

    const text = await run([root]);
    expect(text[0]).toBe('  Backups in .dql/local/backups (newest first):');
    expect(text[1]).toMatch(/^ {4}0\.3\.1-to-0\.4\.0-20261109T083000Z {3}0\.3\.1 → 0\.4\.0 {3}2026-11-09 08:30 UTC {3}\d+(\.\d)? (B|KB)$/);
    expect(text[2]).toMatch(/^ {4}0\.3\.0-to-0\.3\.1-20261108T100000Z {3}0\.3\.0 → 0\.3\.1 {3}2026-11-08 10:00 UTC {3}/);
    expect(text.at(-1)).toBe('  Restore one, with ZLens stopped: zlens backups restore <name> --yes');

    const json = JSON.parse((await run(['list', root, '--format', 'json'])).join('\n'));
    expect(json.backups.map((entry: { name: string }) => entry.name)).toEqual([
      '0.3.1-to-0.4.0-20261109T083000Z',
      '0.3.0-to-0.3.1-20261108T100000Z',
    ]);
    expect(json.backups[1]).toMatchObject({ from: '0.3.0', to: '0.3.1', reason: 'upgrade', files: 2 });

    expect(await run([project()])).toEqual(['  No backups yet. ZLens makes one when a different version of ZLens opens this project.']);
  });

  it('refuses to restore without --yes, and changes nothing', async () => {
    const { root, backup } = upgradedProject();

    await expect(run(['restore', backup, root])).rejects.toThrow(`Restoring replaces this project's local state with the backup "${backup}". Run again with --yes`);

    expect(rowsIn(join(root, '.dql/local/apps.sqlite'))).toEqual(['after upgrade']);
    expect(readLastVersion(root)).toBe('0.3.1');
  });

  it('refuses to restore while a notebook serves the project', async () => {
    const { root, backup } = upgradedProject();
    writeNotebookDescriptor(root, {
      version: 1,
      pid: 4242,
      host: '127.0.0.1',
      port: 3474,
      url: 'http://127.0.0.1:3474',
      instanceId: 'running',
      startedAt: '2026-11-08T10:05:00.000Z',
      appSchedules: true,
    });

    await expect(run(['restore', backup, root, '--yes'], { isAlive: (pid) => pid === 4242 }))
      .rejects.toThrow('zlens notebook (pid 4242) is serving this project. Stop it');
    expect(rowsIn(join(root, '.dql/local/apps.sqlite'))).toEqual(['after upgrade']);

    // A descriptor left by a notebook that has exited does not block it.
    await run(['restore', backup, root, '--yes'], { isAlive: () => false });
    expect(rowsIn(join(root, '.dql/local/apps.sqlite'))).toEqual(['before']);
  });

  it('restores the files, drops stale WAL files, and records the version the backup came from', async () => {
    const { root, backup } = upgradedProject();
    // A -wal file the old database left would be replayed onto the restored copy.
    writeFileSync(join(root, '.dql/local/apps.sqlite-wal'), 'stale');
    // The results cache the newer version built is not the restored state's.
    setRows(join(root, '.dql/local/dataset-results.sqlite'), ['cached by 0.3.1']);

    const lines = await run(['restore', backup, root, '--yes']);

    expect(lines).toEqual([`  ✓ Restored 2 files from ${backup} (the state ZLens 0.3.0 left).`]);
    expect(existsSync(join(root, '.dql/local/dataset-results.sqlite'))).toBe(false);
    expect(rowsIn(join(root, '.dql/local/apps.sqlite'))).toEqual(['before']);
    expect(existsSync(join(root, '.dql/local/apps.sqlite-wal'))).toBe(false);
    expect(readFileSync(join(root, '.dql/local/private/home/maya.json'), 'utf-8')).toBe('{"before":true}');
    // A file made after the backup is left in place.
    expect(existsSync(join(root, '.dql/local/private/home/new.json'))).toBe(true);
    expect(readLastVersion(root)).toBe('0.3.0');
  });

  it('names an unknown backup before asking for --yes', async () => {
    const { root } = upgradedProject();
    await expect(run(['restore', 'no-such-backup', root])).rejects.toThrow('No backup named "no-such-backup" in .dql/local/backups.');
    await expect(run(['restore', '../escape', root, '--yes'])).rejects.toThrow('No backup named "../escape"');
    await expect(run(['restore'])).rejects.toThrow('Usage: zlens backups');
  });
});
