import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

/**
 * Backups for the ZLens app for Snowflake (approved design B1–B6, 2026-11-09).
 *
 * Everything a customer builds lives on the app's block volume, and uninstalling the app deletes it. Two layers:
 *
 * 1. Snapshots of the volume, inside the app: once a day (when ZLens stops for the day, or after 30 hours of
 *    running), the last 7 kept. Fast to restore (`app_public.restore_backup`), but they go with the app.
 * 2. An export of the project to a stage the customer owns and granted to the app, named on the Configurations
 *    tab (ZLENS_BACKUP_STAGE): a plain ZLens project as a .tar.gz, once a day when something changed, the last
 *    14 kept. It survives an uninstall, and a new install with an empty project offers to restore it.
 *
 * Checked live 2026-11-09: the app can snapshot its own volume and restore it; the container can PUT a file
 * into a customer stage granted READ, WRITE to the app, and the file outlives DROP APPLICATION.
 */

export type BackupQuery = (sql: string) => Promise<Array<Record<string, unknown>>>;

export interface SnowflakeBackupSnapshot {
  name: string;
  state: string;
  createdOn: string;
  /** Gigabytes, as Snowflake reports it. */
  size?: number;
}

export interface SnowflakeBackupExport {
  file: string;
  size: number;
  lastModified: string;
}

export interface SnowflakeAppBackupStatus {
  /** The installed app's name, for the restore line an admin runs. */
  app: string;
  snapshots: SnowflakeBackupSnapshot[];
  /** The stage named on the Configurations tab, or null when the admin set none. */
  stage: string | null;
  exports: SnowflakeBackupExport[];
  /** Why the stage could not be read, when it could not. */
  stageError?: string;
  lastSnapshotAt?: string;
  lastExportAt?: string;
}

export interface SnowflakeAppBackupsOptions {
  /** The app's service, `<APP>.CORE.ZLENS`. Snapshots live beside it, in `<APP>.CORE`. */
  service: string;
  /** The project folder on the volume (`/workspace`). */
  workspace: string;
  query: BackupQuery;
  /** The configuration value naming the export stage. */
  stageConfiguration?: string;
  keepSnapshots?: number;
  keepExports?: number;
  now?: () => Date;
  /** Runs a command (tar, sync); replaced in tests. */
  run?: (command: string, args: string[]) => void;
  /** Waits; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const SNAPSHOT_PREFIX = 'ZLENS_BACKUP_';
/** What a project export leaves out: what ZLens rebuilds by itself, and the drivers it installs. */
const EXPORT_EXCLUDES = ['./.dql/cache', './.dql/connectors', './.dql/runtimes', './node_modules', './.git', './.zlens-restore-*'];
/** What a restore keeps: the drivers ZLens installed, which the copy leaves out. */
const KEPT_IN_DQL = new Set(['connectors', 'runtimes']);
const STATE_FILE = join('.dql', 'local', 'snowflake-app-backup.json');
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** A stage name the admin typed: `DB.SCHEMA.STAGE` (or quoted parts), safe to put after `@`. */
export function parseStageName(value: string): string | null {
  const parts = value.trim().replace(/^@/, '').split('.');
  if (parts.length !== 3) return null;
  const clean = parts.map((part) => part.trim());
  if (!clean.every((part) => IDENTIFIER.test(part) || /^"[^"]+"$/.test(part))) return null;
  return clean.join('.');
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
}

function field(row: Record<string, unknown>, name: string): unknown {
  return row[name] ?? row[name.toUpperCase()];
}

export class SnowflakeAppBackups {
  private readonly schema: string;
  private readonly app: string;
  private readonly keepSnapshots: number;
  private readonly keepExports: number;
  private readonly now: () => Date;
  private readonly run: (command: string, args: string[]) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private busy: Promise<unknown> | undefined;

  constructor(private readonly options: SnowflakeAppBackupsOptions) {
    const parts = options.service.split('.');
    if (parts.length !== 3 || !parts.every((part) => IDENTIFIER.test(part))) throw new Error(`Not a service name: ${options.service}`);
    this.app = parts[0]!;
    this.schema = `${parts[0]}.${parts[1]}`;
    this.keepSnapshots = options.keepSnapshots ?? 7;
    this.keepExports = options.keepExports ?? 14;
    this.now = options.now ?? (() => new Date());
    this.run = options.run ?? ((command, args) => { execFileSync(command, args, { stdio: 'ignore' }); });
    this.sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  }

  /** One backup job at a time. */
  private once<T>(job: () => Promise<T>): Promise<T> {
    const next = (this.busy ?? Promise.resolve()).then(job, job);
    this.busy = next.catch(() => undefined);
    return next;
  }

  async snapshots(): Promise<SnowflakeBackupSnapshot[]> {
    const rows = await this.options.query(`SHOW SNAPSHOTS LIKE '${SNAPSHOT_PREFIX}%' IN SCHEMA ${this.schema}`);
    return rows.map((row) => ({
      name: String(field(row, 'name') ?? ''),
      state: String(field(row, 'state') ?? ''),
      createdOn: String(field(row, 'created_on') ?? ''),
      ...(typeof field(row, 'size') === 'number' ? { size: field(row, 'size') as number } : {}),
    })).filter((item) => item.name.startsWith(SNAPSHOT_PREFIX))
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /** Snapshot the volume now, wait until Snowflake can restore from it, and keep the newest `keepSnapshots`. */
  snapshotNow(): Promise<SnowflakeBackupSnapshot> {
    return this.once(async () => {
      try { this.run('sync', []); } catch { /* flushing is best effort; SQLite's journal covers the rest */ }
      const name = `${SNAPSHOT_PREFIX}${stamp(this.now())}`;
      await this.options.query(`CREATE SNAPSHOT IF NOT EXISTS ${this.schema}.${name} FROM SERVICE ${this.options.service} VOLUME "workspace" INSTANCE 0 COMMENT = 'ZLens daily backup'`);
      let snapshot: SnowflakeBackupSnapshot | undefined;
      for (let attempt = 0; attempt < 36; attempt += 1) {
        snapshot = (await this.snapshots()).find((item) => item.name === name);
        if (snapshot && snapshot.state !== 'INITIALIZED') break;
        await this.sleep(5_000);
      }
      if (!snapshot || snapshot.state !== 'CREATED') throw new Error(`Snowflake did not finish the backup ${name} (${snapshot?.state ?? 'not found'}).`);
      const old = (await this.snapshots()).slice(this.keepSnapshots);
      for (const item of old) await this.options.query(`DROP SNAPSHOT IF EXISTS ${this.schema}.${item.name}`);
      this.writeState({ lastSnapshotAt: this.now().toISOString() });
      return snapshot;
    });
  }

  /** The stage named on the Configurations tab, or null when none is set. */
  async stage(): Promise<string | null> {
    const configuration = this.options.stageConfiguration ?? 'ZLENS_BACKUP_STAGE';
    if (!IDENTIFIER.test(configuration)) throw new Error(`Not a configuration name: ${configuration}`);
    try {
      const rows = await this.options.query(`SELECT SYS_CONTEXT('SNOWFLAKE$APPLICATION', 'GET_CONFIGURATION_VALUE', '${configuration.toUpperCase()}') AS V`);
      const value = rows[0] ? Object.values(rows[0])[0] : undefined;
      if (typeof value !== 'string' || !value.trim()) return null;
      const stage = parseStageName(value);
      if (!stage) throw new Error(`The backup stage "${value}" is not a stage name: use DATABASE.SCHEMA.STAGE.`);
      return stage;
    } catch (error) {
      if (/has not been set/i.test(error instanceof Error ? error.message : String(error))) return null;
      throw error;
    }
  }

  async exports(stage: string): Promise<SnowflakeBackupExport[]> {
    const rows = await this.options.query(`LIST @${stage} PATTERN = '.*zlens-${this.app.toLowerCase()}-[0-9_]+\\.tar\\.gz'`);
    return rows.map((row) => ({
      file: String(field(row, 'name') ?? '').split('/').pop() ?? '',
      size: Number(field(row, 'size') ?? 0),
      lastModified: String(field(row, 'last_modified') ?? ''),
    })).filter((item) => item.file).sort((a, b) => b.file.localeCompare(a.file));
  }

  /** Whether any project file changed since the last export (caches and drivers aside). */
  changedSince(iso: string | undefined): boolean {
    if (!iso) return true;
    const since = Date.parse(iso);
    // The backup's own record changes with every backup: it is not a change to the project.
    const skip = new Set([...EXPORT_EXCLUDES.map((path) => path.replace(/^\.\//, '')), STATE_FILE]);
    const walk = (dir: string): boolean => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (skip.has(relative(this.options.workspace, path))) continue;
        const info = statSync(path);
        if (info.isDirectory() ? walk(path) : info.mtimeMs > since) return true;
      }
      return false;
    };
    try { return walk(this.options.workspace); } catch { return true; }
  }

  /** Upload the project to the backup stage (when one is set and something changed), keeping the newest `keepExports`. */
  exportNow(options: { force?: boolean } = {}): Promise<SnowflakeBackupExport | null> {
    return this.once(async () => {
      const stage = await this.stage();
      if (!stage) return null;
      const state = this.readState();
      if (!options.force && !this.changedSince(state.lastExportAt)) return null;
      const dir = mkdtempSync(join(tmpdir(), 'zlens-export-'));
      const file = `zlens-${this.app.toLowerCase()}-${stamp(this.now())}.tar.gz`;
      try {
        this.run('tar', ['-czf', join(dir, file), ...EXPORT_EXCLUDES.map((path) => `--exclude=${path}`), '-C', this.options.workspace, '.']);
        await this.options.query(`PUT 'file://${join(dir, file)}' @${stage} AUTO_COMPRESS = FALSE OVERWRITE = TRUE`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      for (const item of (await this.exports(stage)).slice(this.keepExports)) {
        await this.options.query(`REMOVE @${stage}/${item.file}`);
      }
      this.writeState({ lastExportAt: this.now().toISOString() });
      return (await this.exports(stage)).find((item) => item.file === file) ?? { file, size: 0, lastModified: this.now().toISOString() };
    });
  }

  /** The daily backup: a snapshot when the newest is older than `olderThanHours`, then an export if one is due. */
  async daily(olderThanHours = 20): Promise<{ snapshot?: SnowflakeBackupSnapshot; export?: SnowflakeBackupExport | null; error?: string }> {
    const result: { snapshot?: SnowflakeBackupSnapshot; export?: SnowflakeBackupExport | null; error?: string } = {};
    try {
      const newest = (await this.snapshots())[0];
      const age = newest ? this.now().getTime() - Date.parse(newest.createdOn) : Number.POSITIVE_INFINITY;
      if (!(age < olderThanHours * 3_600_000)) result.snapshot = await this.snapshotNow();
      const lastExport = this.readState().lastExportAt;
      if (!lastExport || this.now().getTime() - Date.parse(lastExport) >= olderThanHours * 3_600_000) result.export = await this.exportNow();
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  async status(): Promise<SnowflakeAppBackupStatus> {
    const state = this.readState();
    const snapshots = await this.snapshots();
    let stage: string | null = null;
    let exports: SnowflakeBackupExport[] = [];
    let stageError: string | undefined;
    try {
      stage = await this.stage();
      if (stage) exports = await this.exports(stage);
    } catch (error) {
      stageError = error instanceof Error ? error.message : String(error);
    }
    return { app: this.app, snapshots, stage, exports, ...(stageError ? { stageError } : {}), ...(state.lastSnapshotAt ? { lastSnapshotAt: state.lastSnapshotAt } : {}), ...(state.lastExportAt ? { lastExportAt: state.lastExportAt } : {}) };
  }

  /** Whether the project holds nothing a person saved (drafts waiting for review do not count). */
  projectIsEmpty(): boolean {
    for (const folder of ['domains', 'semantic-layer', 'blocks', 'notebooks', 'apps', 'dashboards']) {
      const path = join(this.options.workspace, folder);
      if (existsSync(path) && readdirSync(path).some((name) => !name.startsWith('.'))) return false;
    }
    return true;
  }

  /** Replace the project with an export from the backup stage. The server restarts afterwards to load it. */
  restoreExport(file: string): Promise<void> {
    return this.once(async () => {
      const stage = await this.stage();
      if (!stage) throw new Error('No backup stage is set on the Configurations tab.');
      if (!/^zlens-[a-z0-9_$]+-[0-9_]+\.tar\.gz$/.test(file)) throw new Error(`Not a ZLens backup: ${file}`);
      const dir = mkdtempSync(join(tmpdir(), 'zlens-restore-'));
      try {
        await this.options.query(`GET @${stage}/${file} 'file://${dir}/'`);
        const archive = join(dir, file);
        if (!existsSync(archive)) throw new Error(`Snowflake did not return ${file}.`);
        // Unpack beside the project, on the same volume, and swap only once the whole copy is out: a copy that
        // fails to unpack leaves the project as it was. (ZLens runs as a non-root user, so tar must not try to
        // set times on folders it does not own: -m and --no-overwrite-dir.)
        const staging = join(this.options.workspace, `.zlens-restore-${stamp(this.now())}`);
        mkdirSync(staging, { recursive: true });
        try {
          this.run('tar', ['-xzf', archive, '-C', staging, '-m', '--no-same-owner', '--no-overwrite-dir']);
        } catch (error) {
          rmSync(staging, { recursive: true, force: true });
          throw new Error(`The copy ${file} did not unpack; the project is unchanged. ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const name of readdirSync(this.options.workspace)) {
          const path = join(this.options.workspace, name);
          if (path === staging) continue;
          if (name === '.dql') {
            for (const inner of readdirSync(path)) if (!KEPT_IN_DQL.has(inner)) rmSync(join(path, inner), { recursive: true, force: true });
            continue;
          }
          rmSync(path, { recursive: true, force: true });
        }
        for (const name of readdirSync(staging)) {
          if (name === '.dql') {
            mkdirSync(join(this.options.workspace, '.dql'), { recursive: true });
            for (const inner of readdirSync(join(staging, '.dql'))) {
              if (!KEPT_IN_DQL.has(inner)) renameSync(join(staging, '.dql', inner), join(this.options.workspace, '.dql', inner));
            }
            continue;
          }
          renameSync(join(staging, name), join(this.options.workspace, name));
        }
        rmSync(staging, { recursive: true, force: true });
        this.writeState({ restoredFrom: file, restoredAt: this.now().toISOString() });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  private readState(): { lastSnapshotAt?: string; lastExportAt?: string; restoredFrom?: string; restoredAt?: string } {
    const path = join(this.options.workspace, STATE_FILE);
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}; } catch { return {}; }
  }

  private writeState(update: Record<string, string>): void {
    const path = join(this.options.workspace, STATE_FILE);
    mkdirSync(join(this.options.workspace, '.dql', 'local'), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...this.readState(), ...update }, null, 2) + '\n', 'utf-8');
  }
}
