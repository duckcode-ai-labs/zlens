import { basename, join } from 'node:path';
import type { LakeSourceConfig } from './connector.js';
import {
  isUrlPath,
  dataFolderAttachStatement,
  dataFolderFileColumnsStatement,
  dataFolderFilesStatement,
  dataFolderViewStatement,
  detachDataFolderCatalogStatement,
  dropDataFolderViewStatement,
  modifiedTime,
  readDataFolder,
  type DataFolderContents,
  type DataFolderSkip,
  type DataFolderTable,
} from './data-folder.js';
import { readBucketFolder, resolveLakeSources, type LakeProblem, type LakeRun } from './lake-listing.js';

/** A table or catalog of a data folder that DuckDB could not read, and why. */
export interface DataFolderProblem {
  /** The entry of the data folder: `orders.csv`, `events/`, `lake.ducklake`. */
  source: string;
  /** The table or catalog name it would have. */
  name: string;
  /** Why it is not read, in DuckDB's words or ZLens's. */
  reason: string;
}

/** What a connection reads from its data folder right now. */
export interface DataFolderStatus {
  /** The data folder (a path or a bucket URL), or `''` with sources only. */
  folder: string;
  /** Tables that read: one line each, as `zlens init` and Setup list them. */
  tables: Array<{ name: string; source: string; kind: string }>;
  /** Database files attached read-only as catalogs. */
  catalogs: Array<{ name: string; source: string; kind: string }>;
  /** What is not read as a table, and what it is. */
  skipped: DataFolderSkip[];
  /** What should be a table or catalog but could not be read. */
  problems: DataFolderProblem[];
}

export interface DataFolderViewsOptions {
  /** The connection's own database is a real file: the views are temporary, never written into it. */
  temporary: boolean;
  /** Attach DuckDB, DuckLake and SQLite files of the folder as catalogs. */
  catalogs: boolean;
  /** Files never read (the connection's own database file). */
  exclude: string[];
  /** Named tables at any path or bucket URL (paths already absolute). */
  sources?: LakeSourceConfig[];
}

/** A folder table is one table only when its first files (at most this many) share their columns. */
const SAME_COLUMNS_FILES = 50;
/** An unchanged folder is looked at again after this long (a new Iceberg commit, a new sheet). */
const RESCAN_MS = 2_000;
/** A bucket is listed again after this long: each listing reads every object name under the prefix, and costs requests. */
const BUCKET_RESCAN_MS = 60_000;
const REASON_LENGTH = 400;

/**
 * Keeps a DuckDB connection's views (and read-only catalogs) in step with a
 * data folder: a table added to the folder gets its view, a removed one loses
 * it, a changed one (a new Iceberg commit) is made again. What DuckDB cannot
 * read is kept with its reason, and tried again once it changes.
 *
 * In a real database file the views are temporary, so they are never written
 * into it, and a name the database already has is left to the database.
 * Temporary views belong to one connection: `temporaryViewStatements` makes
 * them on another (a consistent read scope).
 */
export class DataFolderViews {
  /** View name → the statement that made it. */
  private readonly views = new Map<string, string>();
  /** Catalog name → the statement that attached it. */
  private readonly catalogs = new Map<string, string>();
  /** `view:name` / `catalog:name` → what was tried (tried again once it changes) and why it failed. */
  private readonly failed = new Map<string, { attempt: string } & DataFolderProblem>();
  private contents: DataFolderContents = { tables: [], catalogs: [], skipped: [] };
  private scanned = { at: 0, modified: Number.NaN };
  private refreshing: Promise<void> | null = null;
  private databaseName: string | undefined;
  /** A bucket folder's last listing, reused for a minute. */
  private bucket: { at: number; contents: DataFolderContents; problems: LakeProblem[] } | undefined;
  /** The sources as last resolved (a bucket source's for a minute, else for two seconds). */
  private sourced: { at: number; tables: DataFolderTable[]; problems: LakeProblem[] } | undefined;
  /** Problems that are not one table's: a source that cannot be read, a bucket that cannot be listed. */
  private listingProblems: LakeProblem[] = [];
  /** Extra problems the connection reports (storage it could not use). */
  private readonly notes: LakeProblem[] = [];

  constructor(
    /** A folder on disk, a bucket URL, or `''` for sources only. */
    readonly folder: string,
    private readonly run: LakeRun,
    private readonly options: DataFolderViewsOptions,
  ) {}

  /** A problem the connection itself reports (storage it could not set up), shown with the folder's. */
  note(problem: LakeProblem): void {
    this.notes.push(problem);
  }

  /** Make the views match the folder now (at once when the folder changed, else at most every two seconds). */
  refresh(): Promise<void> {
    this.refreshing ??= this.sync().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** The temporary views as made, to make them on another connection of the same database. */
  temporaryViewStatements(): string[] {
    return this.options.temporary ? [...this.views.values()] : [];
  }

  status(): DataFolderStatus {
    const tables = this.contents.tables.filter((table) => this.views.has(table.name));
    const catalogs = this.contents.catalogs.filter((catalog) => this.catalogs.has(catalog.name));
    const problems = [
      ...this.contents.tables.filter((table) => !this.views.has(table.name)).map((table) => this.failed.get(`view:${table.name}`)),
      ...this.contents.catalogs.filter((catalog) => !this.catalogs.has(catalog.name)).map((catalog) => this.failed.get(`catalog:${catalog.name}`)),
    ].filter((problem): problem is NonNullable<typeof problem> => Boolean(problem))
      .map(({ source, name, reason }) => ({ source, name, reason }));
    problems.unshift(...this.notes, ...this.listingProblems);
    return {
      folder: this.folder,
      tables: tables.map(({ name, source, kind }) => ({ name, source, kind })),
      catalogs: catalogs.map(({ name, source, kind }) => ({ name, source, kind })),
      skipped: this.contents.skipped,
      problems,
    };
  }

  private async sync(): Promise<void> {
    const local = this.folder !== '' && !isUrlPath(this.folder);
    const modified = local ? modifiedTime(this.folder) : -1;
    if (modified === this.scanned.modified && Date.now() - this.scanned.at < RESCAN_MS) return;
    this.scanned = { at: Date.now(), modified };
    const now = Date.now();

    const sources = this.options.sources ?? [];
    if (sources.length) {
      const reuse = sources.some((source) => isUrlPath(source.path)) ? BUCKET_RESCAN_MS : RESCAN_MS;
      if (!this.sourced || now - this.sourced.at >= reuse) {
        this.sourced = { at: now, ...(await resolveLakeSources(this.run, sources)) };
      }
    }
    const sourceTables = this.sourced?.tables ?? [];
    const takenNames = sourceTables.map((table) => table.name);
    const folderOptions = { catalogs: this.options.catalogs, exclude: this.options.exclude, takenNames };

    let folder: DataFolderContents = { tables: [], catalogs: [], skipped: [] };
    if (local) {
      folder = readDataFolder(this.folder, folderOptions);
    } else if (this.folder) {
      if (!this.bucket || now - this.bucket.at >= BUCKET_RESCAN_MS) {
        try {
          this.bucket = { at: now, contents: await readBucketFolder(this.run, this.folder, folderOptions), problems: [] };
        } catch (error) {
          this.bucket = { at: now, contents: { tables: [], catalogs: [], skipped: [] }, problems: [{ source: this.folder, name: '', reason: reasonOf(error) }] };
        }
      }
      folder = this.bucket.contents;
    }
    this.sourceNames = new Set(takenNames);
    this.listingProblems = [...(this.sourced?.problems ?? []), ...(this.bucket && !local && this.folder ? this.bucket.problems : [])];
    this.contents = { tables: [...sourceTables, ...folder.tables], catalogs: folder.catalogs, skipped: folder.skipped };
    if (this.contents.catalogs.length || this.catalogs.size) await this.syncCatalogs();
    await this.syncViews();
  }

  /** Source tables, by name: they are retried with each new resolution of the sources, not by a file's time. */
  private sourceNames = new Set<string>();

  /** What a failed table or catalog was tried against: tried again once this changes. */
  private stamp(source: string, name: string): string {
    if (this.sourceNames.has(name)) return `sources@${this.sourced?.at ?? 0}`;
    if (this.folder === '' || isUrlPath(this.folder)) return `bucket@${this.bucket?.at ?? 0}`;
    return String(modifiedTime(join(this.folder, source)));
  }

  private async syncCatalogs(): Promise<void> {
    // A catalog named like the connection's own database would be that database: it gets its type as a suffix.
    this.databaseName ??= String((await this.run('SELECT current_database() AS name')).rows[0]?.['name'] ?? '').toLowerCase();
    const catalogs = this.contents.catalogs.map((catalog) => (catalog.name === this.databaseName
      ? { ...catalog, name: `${catalog.name}_${catalog.type}`, kind: catalog.kind.replace(/attached as .*$/, `attached as ${catalog.name}_${catalog.type}`) }
      : catalog));
    this.contents = { ...this.contents, catalogs };
    const wanted = new Map(catalogs.map((catalog) => [catalog.name, dataFolderAttachStatement(catalog)]));
    for (const [name, statement] of [...this.catalogs]) {
      if (wanted.get(name) === statement) continue;
      await this.run(detachDataFolderCatalogStatement(name)).catch(() => undefined);
      this.catalogs.delete(name);
    }
    for (const catalog of catalogs) {
      if (this.catalogs.has(catalog.name)) continue;
      const statement = wanted.get(catalog.name)!;
      const key = `catalog:${catalog.name}`;
      const attempt = `${statement}\u0000${isUrlPath(catalog.file) ? `bucket@${this.bucket?.at ?? 0}` : modifiedTime(catalog.file)}`;
      if (this.failed.get(key)?.attempt === attempt) continue;
      try {
        await this.run(statement);
        this.catalogs.set(catalog.name, statement);
        this.failed.delete(key);
      } catch (error) {
        this.failed.set(key, { attempt, source: catalog.source, name: catalog.name, reason: reasonOf(error) });
      }
    }
  }

  private async syncViews(): Promise<void> {
    const temporary = this.options.temporary;
    const wanted = new Map(this.contents.tables.map((table) => [table.name, dataFolderViewStatement(table, { temporary })]));
    for (const [name, statement] of [...this.views]) {
      if (wanted.get(name) === statement) continue;
      await this.run(dropDataFolderViewStatement(name, { temporary })).catch(() => undefined);
      this.views.delete(name);
    }
    const missing = this.contents.tables.filter((table) => !this.views.has(table.name));
    if (!missing.length) return;
    // A real database's own table or view of the same name is the one read: the file's view is not made over it.
    const owned = temporary ? await this.namesInDatabase() : new Set<string>();
    for (const table of missing) {
      const statement = wanted.get(table.name)!;
      const key = `view:${table.name}`;
      const attempt = `${statement}\u0000${this.stamp(table.source, table.name)}`;
      if (this.failed.get(key)?.attempt === attempt) continue;
      try {
        if (owned.has(table.name.toLowerCase())) {
          throw new Error(`the database already has a table or view named ${table.name}, and that one is read`);
        }
        // A source is one table because the connection says so; a folder found in the data folder must earn it.
        const mismatch = this.sourceNames.has(table.name) ? undefined : await this.differentColumns(table);
        if (mismatch) throw new Error(mismatch);
        await this.run(statement);
        this.views.set(table.name, statement);
        this.failed.delete(key);
      } catch (error) {
        this.failed.set(key, { attempt, source: table.source, name: table.name, reason: reasonOf(error) });
      }
    }
  }

  private async namesInDatabase(): Promise<Set<string>> {
    try {
      const result = await this.run(`SELECT lower(table_name) AS name FROM information_schema.tables WHERE table_catalog = current_database()`);
      return new Set(result.rows.map((row) => String(row['name'] ?? '')));
    } catch {
      return new Set();
    }
  }

  /** For a folder of files that is not partitioned: why its files are not one table, when their columns differ. */
  private async differentColumns(table: DataFolderTable): Promise<string | undefined> {
    const filesStatement = dataFolderFilesStatement(table, SAME_COLUMNS_FILES);
    if (!filesStatement) return undefined;
    const files = (await this.run(filesStatement)).rows.map((row) => String(row['file'] ?? ''));
    if (files.length < 2) return undefined;
    let first: { file: string; columns: string[] } | undefined;
    for (const file of files) {
      const described = await this.run(dataFolderFileColumnsStatement(table, file));
      const columns = described.rows.map((row) => String(row['column_name'] ?? '').toLowerCase()).sort();
      if (!first) {
        first = { file, columns };
        continue;
      }
      if (columns.join('\u0000') !== first.columns.join('\u0000')) {
        return `its files have different columns: ${basename(first.file)} has ${listColumns(first.columns)}, ${basename(file)} has ${listColumns(columns)} (ZLens reads a folder as one table when its files share their columns)`;
      }
    }
    return undefined;
  }
}

function listColumns(columns: string[]): string {
  return columns.length > 6 ? `${columns.slice(0, 6).join(', ')} and ${columns.length - 6} more` : columns.join(', ');
}

function reasonOf(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0].trim();
  return message.length > REASON_LENGTH ? `${message.slice(0, REASON_LENGTH - 1)}…` : message;
}
