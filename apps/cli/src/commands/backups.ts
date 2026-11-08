/**
 * `zlens backups` — the copies of a project's local state ZLens made before a
 * new version opened it (see `upgrade-backups.ts`).
 *
 * Usage:
 *   zlens backups [path]                       List backups, newest first
 *   zlens backups restore <name> [path] --yes  Put one back, with ZLens stopped
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CLIFlags } from '../args.js';
import { findProjectRoot } from '../local-runtime.js';
import { readNotebookDescriptor } from '../schedule/notebook-runtime.js';
import { BACKUPS_RELATIVE, listBackups, restoreBackup, type BackupEntry } from '../upgrade-backups.js';

const USAGE = 'Usage: zlens backups [path] | zlens backups restore <name> [path] --yes';

export interface BackupsDeps {
  /** Whether a process is alive; tests replace it. */
  isAlive?: (pid: number) => boolean;
  log?: (line: string) => void;
}

export async function runBackups(arg: string | null, rest: string[], flags: CLIFlags, deps: BackupsDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  if (arg === 'restore') {
    const [name, path] = rest;
    if (!name) throw new Error(USAGE);
    const projectRoot = projectAt(path);
    // A running server holds the stores open: copying files under it would
    // lose its writes or corrupt the databases.
    const descriptor = readNotebookDescriptor(projectRoot);
    if (descriptor && (deps.isAlive ?? processIsAlive)(descriptor.pid)) {
      throw new Error(
        `zlens notebook (pid ${descriptor.pid}) is serving this project. Stop it (and any zlens mcp or zlens agent using the project), then restore. `
        + 'If no ZLens is running, delete .dql/local/notebook.json and run this again.',
      );
    }
    if (!listBackups(projectRoot).some((entry) => entry.name === name)) {
      throw new Error(`No backup named "${name}" in ${BACKUPS_RELATIVE}. zlens backups lists them.`);
    }
    if (!flags.yes) {
      throw new Error(`Restoring replaces this project's local state with the backup "${name}". Run again with --yes to restore it.`);
    }
    const restored = restoreBackup(projectRoot, name);
    if (flags.format === 'json') {
      log(JSON.stringify({ restored: restored.name, from: restored.manifest.from, to: restored.manifest.to, files: restored.manifest.files.length, bytes: restored.bytes }, null, 2));
      return;
    }
    const state = restored.manifest.from ? `the state ZLens ${restored.manifest.from} left` : 'the state from before ZLens recorded its version';
    log(`  ✓ Restored ${restored.manifest.files.length} file${restored.manifest.files.length === 1 ? '' : 's'} from ${restored.name} (${state}).`);
    if (restored.manifest.skipped.length > 0) log(`    Cleared, and rebuilt when needed: ${restored.manifest.skipped.map((file) => file.path).join(', ')}.`);
    return;
  }
  if (arg !== null && arg !== 'list' && !existsSync(resolve(arg))) throw new Error(`Unknown backups command or folder "${arg}". ${USAGE}`);
  const projectRoot = projectAt(arg === 'list' ? rest[0] : arg ?? undefined);
  const backups = listBackups(projectRoot);
  if (flags.format === 'json') {
    log(JSON.stringify({ backups: backups.map(toJson) }, null, 2));
    return;
  }
  if (backups.length === 0) {
    log('  No backups yet. ZLens makes one when a different version of ZLens opens this project.');
    return;
  }
  log(`  Backups in ${BACKUPS_RELATIVE} (newest first):`);
  const rows = backups.map((entry) => [entry.name, `${entry.manifest.from ?? 'unknown'} → ${entry.manifest.to}`, formatWhen(entry.manifest.at), formatBytes(entry.bytes)]);
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) log(`    ${row.map((cell, column) => (column < row.length - 1 ? cell.padEnd(widths[column]) : cell)).join('   ')}`);
  log('  Restore one, with ZLens stopped: zlens backups restore <name> --yes');
}

function projectAt(path: string | undefined): string {
  const projectRoot = findProjectRoot(resolve(path ?? '.'));
  if (!existsSync(join(projectRoot, 'dql.config.json'))) {
    throw new Error('No ZLens project found (missing dql.config.json). Run from a project folder or pass its path.');
  }
  return projectRoot;
}

function toJson(entry: BackupEntry) {
  return {
    name: entry.name,
    from: entry.manifest.from,
    to: entry.manifest.to,
    at: entry.manifest.at,
    reason: entry.manifest.reason,
    bytes: entry.bytes,
    files: entry.manifest.files.length,
    skipped: entry.manifest.skipped,
    failed: entry.manifest.failed,
  };
}

function formatWhen(at: string): string {
  return at.replace('T', ' ').replace(/:\d\d(?:\.\d+)?Z$/, ' UTC');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
