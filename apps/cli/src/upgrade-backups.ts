/**
 * Upgrades that snapshot first.
 *
 * A project's local state lives under `.dql/`: SQLite stores in `.dql/local`
 * and `.dql/cache`, per-person files in `.dql/local/private/`, and the AI
 * settings in `.dql/provider-settings.json`. Each store migrates itself
 * forward the first time a newer ZLens opens it, and there is no way back. So
 * when the server starts on a project with a different ZLens version than the
 * one that last opened it, it copies that state into
 * `.dql/local/backups/<from>-to-<to>-<UTC time>/` before any store opens, then
 * records the running version in `.dql/local/last-version.json`.
 *
 * `zlens backups` lists the copies and `zlens backups restore <name> --yes`
 * puts one back. `.dql/local/` is git-ignored, so backups never reach Git.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { isNewerDqlVersion } from './version-status.js';

export const LAST_VERSION_RELATIVE = '.dql/local/last-version.json';
export const BACKUPS_RELATIVE = '.dql/local/backups';
/** ZLens keeps this many of its own backups; older ones are deleted. */
export const KEEP_BACKUPS = 3;

const MANIFEST_FILE = 'backup.json';
/** Rebuildable: the results of Dataset queries, which run again on demand. It can be large. */
const SKIPPED_STORES: Record<string, string> = {
  '.dql/local/dataset-results.sqlite': 'a rebuildable cache of Dataset query results; ZLens runs the queries again',
};

export interface BackupFile {
  /** Where the file lives in the project, e.g. `.dql/local/apps.sqlite`. */
  path: string;
  bytes: number;
}

export interface BackupManifest {
  createdBy: 'zlens';
  manifestVersion: 1;
  name: string;
  /** The ZLens version that last opened the project; null when none was recorded. */
  from: string | null;
  /** The ZLens version that was starting. */
  to: string;
  at: string;
  reason: 'upgrade' | 'downgrade' | 'unrecorded';
  files: BackupFile[];
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; error: string }>;
}

export interface BackupEntry {
  name: string;
  manifest: BackupManifest;
  bytes: number;
}

export interface VersionCheckResult {
  /**
   * `unchanged`: same version as last time. `recorded`: version recorded, nothing to copy (a new project).
   * `backed-up`. `failed`: the copy failed and startup went on. `skipped`: not a project, or no version to compare.
   */
  action: 'unchanged' | 'recorded' | 'backed-up' | 'failed' | 'skipped';
  previousVersion: string | null;
  runningVersion: string;
  downgrade: boolean;
  backup?: BackupEntry;
  /** On a downgrade: the newest backup of state a version no newer than the running one left. */
  priorBackup?: string;
  error?: string;
}

export interface VersionCheckOptions {
  now?: () => Date;
  /** Free bytes on the project's disk; undefined when unknown. For tests. */
  freeBytes?: (projectRoot: string) => number | undefined;
  /** One line per event. Defaults to stderr, so `--format json` output on stdout stays clean. */
  log?: (line: string) => void;
}

export function backupsDir(projectRoot: string): string {
  return join(projectRoot, BACKUPS_RELATIVE);
}

/** The version that last opened the project, or null when none is recorded or the file is unreadable. */
export function readLastVersion(projectRoot: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(projectRoot, LAST_VERSION_RELATIVE), 'utf-8')) as { version?: unknown };
    return typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : null;
  } catch {
    return null;
  }
}

export function writeLastVersion(projectRoot: string, version: string, at: Date = new Date()): void {
  const path = join(projectRoot, LAST_VERSION_RELATIVE);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version, at: at.toISOString() }, null, 2)}\n`, 'utf-8');
  renameSync(temp, path);
}

/**
 * Run when the server starts, before any store opens. Compares the running
 * version with the recorded one, backs up the project's state when they
 * differ (or when state exists and no version was ever recorded), then
 * records the running version. It never throws: a failed backup is one log
 * line and startup goes on.
 */
export function backUpOnVersionChange(
  projectRoot: string,
  runningVersion: string,
  options: VersionCheckOptions = {},
): VersionCheckResult {
  const log = options.log ?? ((line: string) => console.warn(line));
  const now = options.now ?? (() => new Date());
  const result: VersionCheckResult = { action: 'skipped', previousVersion: null, runningVersion, downgrade: false };
  // Only a ZLens project, and only a version that can be compared.
  if (runningVersion === 'unknown' || !existsSync(join(projectRoot, 'dql.config.json'))) return result;
  try {
    const previous = readLastVersion(projectRoot);
    result.previousVersion = previous;
    if (previous === runningVersion) return { ...result, action: 'unchanged' };
    result.downgrade = previous !== null && isSemver(previous) && isSemver(runningVersion) && isNewerDqlVersion(previous, runningVersion);
    if (result.downgrade) result.priorBackup = newestBackupReadableBy(projectRoot, runningVersion)?.name;
    const sources = collectSources(projectRoot);
    if (sources.length === 0) {
      // A first run on a new project, or nothing a store has written yet.
      writeLastVersion(projectRoot, runningVersion, now());
      return { ...result, action: 'recorded' };
    }
    try {
      // A large project's stores run to hundreds of MB (a 4,000-model catalog: about 400 MB). A backup
      // never fills the disk: it is skipped, with the reason, when it would leave less than 1 GB free.
      const needed = sourcesBytes(projectRoot, sources);
      const free = (options.freeBytes ?? freeDiskBytes)(projectRoot);
      if (free !== undefined && free - needed < MIN_FREE_AFTER_BACKUP) {
        throw new Error(`not enough free disk: it needs ${formatMegabytes(needed)} and ${formatMegabytes(free)} is free; ZLens keeps at least 1 GB free`);
      }
      result.backup = createBackup(projectRoot, {
        from: previous,
        to: runningVersion,
        reason: result.downgrade ? 'downgrade' : previous === null ? 'unrecorded' : 'upgrade',
        at: now(),
        sources,
      });
      result.action = 'backed-up';
      try {
        pruneBackups(projectRoot, KEEP_BACKUPS, new Set([result.backup.name, result.priorBackup ?? '']));
      } catch {
        // An old backup that cannot be deleted now is deleted on a later upgrade.
      }
    } catch (error) {
      result.action = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
    }
    log(versionChangeLine(result));
    // Recorded even when the copy failed: the stores migrate in a moment
    // anyway, and a retry on the next start would copy the migrated state
    // under a name that says it is the old one.
    writeLastVersion(projectRoot, runningVersion, now());
  } catch (error) {
    result.action = 'failed';
    result.error = error instanceof Error ? error.message : String(error);
    log(`[zlens] Could not check this project's last ZLens version (${result.error}); starting anyway.`);
  }
  return result;
}

function versionChangeLine(result: VersionCheckResult): string {
  const where = result.backup ? `${BACKUPS_RELATIVE}/${result.backup.name}` : '';
  const partial = result.backup && result.backup.manifest.failed.length > 0
    ? ` (${result.backup.manifest.failed.length} file${result.backup.manifest.failed.length === 1 ? '' : 's'} could not be copied; see backup.json)`
    : '';
  if (result.downgrade) {
    const saved = result.backup ? ` Saved its state in ${where}${partial}.` : ` Could not back up its state (${result.error}).`;
    const prior = result.priorBackup
      ? ` The backup from before the upgrade is ${result.priorBackup}; to go back to it, stop ZLens and run zlens backups restore ${result.priorBackup} --yes.`
      : ' No backup from before the upgrade was found.';
    return `[zlens] Warning: this project was last opened by ZLens ${result.previousVersion}, newer than this ZLens ${result.runningVersion}; its saved state may not read correctly.${saved}${prior}`;
  }
  if (!result.backup) {
    return `[zlens] Could not back up this project's state before ZLens ${result.runningVersion} opens it (${result.error}); starting anyway.`;
  }
  const last = result.previousVersion ? `last opened by ${result.previousVersion}` : 'no earlier version recorded';
  return `[zlens] Opening this project with ZLens ${result.runningVersion} (${last}): backed up its state first, in ${where}${partial}. zlens backups lists backups.`;
}

/** Free space a backup must leave on the project's disk. */
const MIN_FREE_AFTER_BACKUP = 1024 ** 3;

function freeDiskBytes(projectRoot: string): number | undefined {
  try {
    const stats = statfsSync(projectRoot);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

/** What the sources take on disk now, a database's write-ahead log included. */
function sourcesBytes(projectRoot: string, sources: BackupSource[]): number {
  let total = 0;
  for (const source of sources) {
    for (const path of source.kind === 'sqlite' ? [source.path, `${source.path}-wal`] : [source.path]) {
      try {
        total += statSync(join(projectRoot, path)).size;
      } catch {
        // Not there (no write-ahead log right now): nothing to count.
      }
    }
  }
  return total;
}

function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function isSemver(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+.*)?$/.test(version.trim());
}

interface BackupSource {
  path: string;
  kind: 'sqlite' | 'file';
}

/**
 * What a backup copies: every store at the top of `.dql/local` and
 * `.dql/cache` (sub-folders of the cache hold rebuildable index snapshots),
 * everything in `.dql/local/private/`, and the AI settings.
 */
function collectSources(projectRoot: string): BackupSource[] {
  const sources: BackupSource[] = [];
  for (const folder of ['.dql/local', '.dql/cache']) {
    for (const name of safeList(join(projectRoot, folder))) {
      const path = `${folder}/${name}`;
      if (!name.endsWith('.sqlite') || SKIPPED_STORES[path] || !isFile(join(projectRoot, path))) continue;
      sources.push({ path, kind: 'sqlite' });
    }
  }
  const walk = (relativeDir: string) => {
    for (const name of safeList(join(projectRoot, relativeDir))) {
      const path = `${relativeDir}/${name}`;
      const absolute = join(projectRoot, path);
      if (isDirectory(absolute)) walk(path);
      // SQLite's -wal/-shm/-journal files are folded into the copy of their database.
      else if (isFile(absolute) && !/\.sqlite3?-(?:wal|shm|journal)$/.test(name)) {
        sources.push({ path, kind: /\.sqlite3?$/.test(name) ? 'sqlite' : 'file' });
      }
    }
  };
  walk('.dql/local/private');
  if (isFile(join(projectRoot, '.dql/provider-settings.json'))) sources.push({ path: '.dql/provider-settings.json', kind: 'file' });
  return sources;
}

/** Where a project file sits inside a backup folder: its path without the leading `.dql/`. */
function pathInBackup(path: string): string {
  return path.replace(/^\.dql\//, '');
}

function createBackup(
  projectRoot: string,
  input: { from: string | null; to: string; reason: BackupManifest['reason']; at: Date; sources: BackupSource[] },
): BackupEntry {
  const root = backupsDir(projectRoot);
  // Owner-only, like .dql/local/private: a backup can hold connection secrets.
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stamp = input.at.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  const baseName = `${folderSafe(input.from ?? 'unknown')}-to-${folderSafe(input.to)}-${stamp}`;
  // Written under a temporary name and renamed when complete, so a backup
  // that stops halfway is never listed or restored.
  const temp = join(root, `.tmp-${baseName}-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true, mode: 0o700 });
  const manifest: BackupManifest = {
    createdBy: 'zlens',
    manifestVersion: 1,
    name: baseName,
    from: input.from,
    to: input.to,
    at: input.at.toISOString(),
    reason: input.reason,
    files: [],
    skipped: [],
    failed: [],
  };
  try {
    for (const source of input.sources) {
      const target = join(temp, pathInBackup(source.path));
      try {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        if (source.kind === 'sqlite') copySqlite(join(projectRoot, source.path), target);
        else copyFileSync(join(projectRoot, source.path), target);
        manifest.files.push({ path: source.path, bytes: statSync(target).size });
      } catch (error) {
        rmSync(target, { force: true });
        manifest.failed.push({ path: source.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const [path, reason] of Object.entries(SKIPPED_STORES)) {
      if (isFile(join(projectRoot, path))) manifest.skipped.push({ path, reason });
    }
    if (manifest.files.length === 0 && manifest.failed.length > 0) {
      throw new Error(`no file could be copied: ${manifest.failed[0].error}`);
    }
    let name = baseName;
    for (let attempt = 2; ; attempt += 1) {
      manifest.name = name;
      writeFileSync(join(temp, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
      try {
        if (existsSync(join(root, name))) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        renameSync(temp, join(root, name));
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Two starts in the same second: the second backup takes the next free name.
        if ((code !== 'EEXIST' && code !== 'ENOTEMPTY') || attempt > 20) throw error;
        name = `${baseName}-${attempt}`;
      }
    }
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return { name: manifest.name, manifest, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
}

/**
 * A consistent copy of a SQLite database, safe while it is in WAL mode and
 * even while another process writes to it: VACUUM INTO reads one snapshot,
 * the committed pages in the -wal file included, and writes a single
 * self-contained file. The connection is read-write only so that closing it
 * removes the -wal/-shm files it opened (a read-only one leaves them behind);
 * it changes no data and no schema.
 */
function copySqlite(source: string, target: string): void {
  rmSync(target, { force: true });
  const db = new Database(source, { fileMustExist: true, timeout: 5_000 });
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
}

function folderSafe(version: string): string {
  return version.replace(/[^0-9A-Za-z.+-]/g, '_');
}

/** ZLens's own backups, newest first. A folder without ZLens's backup.json is not one. */
export function listBackups(projectRoot: string): BackupEntry[] {
  const root = backupsDir(projectRoot);
  const entries: BackupEntry[] = [];
  for (const name of safeList(root)) {
    if (name.startsWith('.')) continue;
    const manifest = readManifest(join(root, name));
    if (!manifest) continue;
    entries.push({ name, manifest, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) });
  }
  return entries.sort((a, b) => b.manifest.at.localeCompare(a.manifest.at) || b.name.localeCompare(a.name));
}

function readManifest(folder: string): BackupManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(folder, MANIFEST_FILE), 'utf-8')) as Partial<BackupManifest>;
    if (raw.createdBy !== 'zlens' || raw.manifestVersion !== 1 || typeof raw.to !== 'string' || typeof raw.at !== 'string' || !Array.isArray(raw.files)) return null;
    const files = raw.files.filter((file): file is BackupFile => typeof file?.path === 'string' && typeof file.bytes === 'number');
    return {
      createdBy: 'zlens',
      manifestVersion: 1,
      name: basename(folder),
      from: typeof raw.from === 'string' ? raw.from : null,
      to: raw.to,
      at: raw.at,
      reason: raw.reason === 'downgrade' || raw.reason === 'unrecorded' ? raw.reason : 'upgrade',
      files,
      skipped: Array.isArray(raw.skipped) ? raw.skipped : [],
      failed: Array.isArray(raw.failed) ? raw.failed : [],
    };
  } catch {
    return null;
  }
}

/**
 * On a downgrade, the backup to point at: the newest one holding state that
 * the running version or an older one left, taken before a newer version
 * opened the project. The running version can read it.
 */
function newestBackupReadableBy(projectRoot: string, runningVersion: string): BackupEntry | undefined {
  return listBackups(projectRoot).find(({ manifest }) => manifest.from !== null
    && isSemver(manifest.from)
    && !isNewerDqlVersion(manifest.from, runningVersion));
}

/**
 * Keep the `keep` newest of ZLens's backups (plus any named in `protect`)
 * and delete the rest. Folders ZLens did not make are left alone; a
 * temporary folder from a backup that stopped halfway is removed after a day.
 */
export function pruneBackups(projectRoot: string, keep: number = KEEP_BACKUPS, protect: Set<string> = new Set()): string[] {
  const root = backupsDir(projectRoot);
  const removed: string[] = [];
  listBackups(projectRoot).forEach((entry, index) => {
    if (index < keep || protect.has(entry.name)) return;
    rmSync(join(root, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  });
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of safeList(root)) {
    if (!name.startsWith('.tmp-')) continue;
    try {
      if (statSync(join(root, name)).mtimeMs < dayAgo) rmSync(join(root, name), { recursive: true, force: true });
    } catch {
      /* gone already */
    }
  }
  return removed;
}

/**
 * Put a backup's files back where they came from. The caller makes sure no
 * ZLens process has the project open. Each file is copied next to its target
 * and renamed over it, and a database's old -wal/-shm files are removed first:
 * SQLite would otherwise replay them onto the restored copy. A rebuildable
 * cache the backup left out is cleared, so it does not outlive the state it
 * was built from. Other files ZLens wrote after the backup are left in place.
 * The recorded version goes back to the backup's `from`, so the next start of
 * that version is a plain start.
 */
export function restoreBackup(projectRoot: string, name: string): BackupEntry {
  if (!name || basename(name) !== name || name.startsWith('.')) throw new Error(`"${name}" is not a backup name. zlens backups lists them.`);
  const folder = join(backupsDir(projectRoot), name);
  const manifest = existsSync(folder) ? readManifest(folder) : null;
  if (!manifest) throw new Error(`No backup named "${name}" in ${BACKUPS_RELATIVE}. zlens backups lists them.`);
  const files = manifest.files.filter((file) => file.path.startsWith('.dql/') && !file.path.split('/').includes('..'));
  const missing = files.filter((file) => !isFile(join(folder, pathInBackup(file.path))));
  if (missing.length > 0) throw new Error(`Backup "${name}" is incomplete: ${missing.map((file) => file.path).join(', ')} is missing. Nothing was restored.`);
  for (const file of files) {
    const target = join(projectRoot, file.path);
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.restore-${process.pid}.tmp`;
    copyFileSync(join(folder, pathInBackup(file.path)), temp);
    if (/\.sqlite3?$/.test(file.path)) removeSidecars(target);
    renameSync(temp, target);
  }
  for (const path of Object.keys(SKIPPED_STORES)) {
    removeSidecars(join(projectRoot, path));
    rmSync(join(projectRoot, path), { force: true });
  }
  if (manifest.from) writeLastVersion(projectRoot, manifest.from);
  else rmSync(join(projectRoot, LAST_VERSION_RELATIVE), { force: true });
  return { name, manifest, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

function removeSidecars(database: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      unlinkSync(`${database}${suffix}`);
    } catch {
      /* none */
    }
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
