import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryExecutor } from '@zlens/connectors';
import { readDqlRuntimeVersion, startLocalServer } from './local-runtime.js';
import { BACKUPS_RELATIVE, listBackups, readLastVersion, writeLastVersion } from './upgrade-backups.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function columnsOf(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('PRAGMA table_info(local_operations)').all() as Array<{ name: string }>).map((column) => column.name);
  } finally {
    db.close();
  }
}

async function startAndStop(projectRoot: string): Promise<void> {
  let server: Server | undefined;
  await startLocalServer({
    rootDir: projectRoot,
    projectRoot,
    executor: {} as QueryExecutor,
    connection: { driver: 'file' },
    preferredPort: 0,
    captureServer: (created) => { server = created; },
  });
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

describe('the server backs up a project before a new version migrates its stores', () => {
  it('copies the operations store as the older version left it, then lets it migrate', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'zlens-upgrade-backup-server-'));
    roots.push(projectRoot);
    writeFileSync(join(projectRoot, 'dql.config.json'), JSON.stringify({ project: 'upgrade_backup_server' }));
    // The operations table as ZLens kept it before operations had owners.
    const store = join(projectRoot, '.dql', 'cache', 'operations.sqlite');
    mkdirSync(join(projectRoot, '.dql', 'cache'), { recursive: true });
    const old = new Database(store);
    old.pragma('journal_mode = WAL');
    old.exec(`CREATE TABLE local_operations (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, scope TEXT NOT NULL, resource_revision TEXT,
      status TEXT NOT NULL, phase TEXT NOT NULL, progress INTEGER NOT NULL, message TEXT NOT NULL,
      cancellable INTEGER NOT NULL, result_json TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    old.prepare(`INSERT INTO local_operations VALUES ('op-1', 'refresh', 'project', NULL, 'succeeded', 'done', 100, 'Done', 0, NULL, NULL, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`).run();
    old.close();
    writeLastVersion(projectRoot, '0.0.1');
    const warn = vi.spyOn(console, 'warn');

    await startAndStop(projectRoot);

    const running = readDqlRuntimeVersion();
    const [backup] = listBackups(projectRoot);
    expect(backup?.manifest).toMatchObject({ from: '0.0.1', to: running, reason: 'upgrade' });
    const copy = join(projectRoot, BACKUPS_RELATIVE, backup!.name, 'cache', 'operations.sqlite');
    // Taken before the store opened: the copy has no owner columns, the live store now does.
    expect(columnsOf(copy)).not.toContain('owner_id');
    expect(columnsOf(store)).toContain('owner_id');
    const db = new Database(copy, { readonly: true });
    expect(db.prepare('SELECT id, status FROM local_operations').all()).toEqual([{ id: 'op-1', status: 'succeeded' }]);
    db.close();
    expect(readLastVersion(projectRoot)).toBe(running);
    expect(warn.mock.calls.flat().filter((line) => String(line).includes('backed up its state first'))).toHaveLength(1);

    // The next start of the same version is a plain one.
    await startAndStop(projectRoot);
    expect(listBackups(projectRoot)).toHaveLength(1);
  });
});
