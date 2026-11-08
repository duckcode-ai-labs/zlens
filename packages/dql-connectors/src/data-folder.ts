import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { LakeCatalogConfig, LakeCatalogType, LakeStorageConfig } from './connector.js';
import { lakeCatalogKind, lakeCatalogPlan, lakeCatalogType, needsLakeCatalogPlan, type LakeCatalogPlan } from './lake-catalogs.js';

/**
 * A folder of data read as a database (a file connection's `dataFolder`).
 * Each of these is one table, named after it:
 *
 * - a CSV, TSV, Parquet or JSON file (`orders.csv` → `orders`);
 * - each sheet of an Excel workbook (`targets.xlsx` → `targets`, or
 *   `targets_<sheet>` when it has several);
 * - a subfolder that is a Delta Lake table (it holds `_delta_log/`) or an
 *   Iceberg table (it holds `metadata/*.metadata.json`: read at its newest
 *   metadata file);
 * - a subfolder of data files of one format, partitioned
 *   (`year=2025/month=1/…`, the partition keys become columns) or not: one
 *   table over all of its files.
 *
 * A DuckDB, DuckLake or SQLite file is attached read-only as a catalog named
 * after it, its tables named `catalog.schema.table`.
 *
 * Hidden entries, a project's own folders and a name DuckDB would read as a
 * pattern (`sales[1].csv`) are not read. In a ZLens project's own folder,
 * `.json` files are its settings and are left out (JSON Lines stay).
 * Anything else that holds data is listed as skipped, with what it is.
 */

export type DataFileReader = 'read_csv_auto' | 'read_parquet' | 'read_json_auto' | 'read_xlsx' | 'delta_scan' | 'iceberg_scan';

/** What a view reads, as `dataFolderViewStatement` needs it. */
export interface DataFolderViewSource {
  /** The view's name: the file or folder name as an identifier (`daily-sales.csv` → `daily_sales`). */
  name: string;
  /**
   * What it reads: a file's absolute path; for a folder of files, the pattern
   * of its files (`/data/events/**\/*.parquet`); a Delta or Iceberg table's folder.
   */
  file: string;
  reader: DataFileReader;
  /** An Excel sheet's name. */
  sheet?: string;
  /**
   * A folder of files: read as one table (by column name); partitioned, its
   * `key=value` folder names are columns. `sameColumns`: its files were seen to
   * share their columns (files spread across a folder of many), so it is read
   * with the first file's columns, and a statement opens one footer instead of
   * every file's (open-formats plan L4, decision L4-9).
   */
  folder?: { partitioned: boolean; sameColumns?: boolean };
  /**
   * An Iceberg table's newest metadata version (`00003-1b2c…`, from
   * `00003-1b2c….metadata.json`): it is read as of that version, from its own
   * folder even when it was written elsewhere (copied, or synced from a bucket).
   */
  icebergVersion?: { name: string; gzip: boolean };
  /** Made in an in-memory catalog of ZLens's own: `catalog.schema.name` (a dbt project's external sources). */
  catalog?: string;
  /** The schema in `catalog` (default `main`). */
  schema?: string;
}

/** A view's full name: `name`, or `catalog.schema.name` for one made in a catalog of ZLens's own. */
export function dataFolderViewName(source: Pick<DataFolderViewSource, 'name' | 'catalog' | 'schema'>): string {
  return source.catalog ? `${source.catalog}.${source.schema ?? 'main'}.${source.name}` : source.name;
}

/** The view's name as SQL: `"name"`, or `"catalog"."schema"."name"`. */
function viewTarget(source: Pick<DataFolderViewSource, 'name' | 'catalog' | 'schema'>): string {
  return source.catalog ? `${sqlIdent(source.catalog)}.${sqlIdent(source.schema ?? 'main')}.${sqlIdent(source.name)}` : sqlIdent(source.name);
}

/** The in-memory catalog (and schema) a view of `dataFolderViewName` form is made in: attached once, never written to disk. */
export function dataFolderViewCatalogStatements(source: Pick<DataFolderViewSource, 'catalog' | 'schema'>): string[] {
  if (!source.catalog) return [];
  return [
    `ATTACH IF NOT EXISTS ':memory:' AS ${sqlIdent(source.catalog)}`,
    `CREATE SCHEMA IF NOT EXISTS ${sqlIdent(source.catalog)}.${sqlIdent(source.schema ?? 'main')}`,
  ];
}

export interface DataFolderTable extends DataFolderViewSource {
  /** The entry of the data folder it comes from: `orders.csv`, `events/`, `targets.xlsx`. */
  source: string;
  /** What it is, in plain words: `CSV file`, `Delta Lake table`, `Iceberg table (version 3)`, `20 Parquet files, partitioned by year, month`. */
  kind: string;
}

/**
 * A catalog attached read-only beside the connection's own database: a
 * database file of the data folder, or one of the connection's `catalogs`
 * (a file, or a catalog service such as an Iceberg REST catalog).
 */
export interface DataFolderCatalog {
  /** The catalog's name: the file name as an identifier (`lake.ducklake` → `lake`). Its tables are `lake.main.orders`. */
  name: string;
  /** The file's absolute path (or, for a catalog service, what is attached: the warehouse, account, ARN or catalog). */
  file: string;
  type: LakeCatalogType;
  /** The file's name in the data folder, or where a configured catalog is attached from (never a secret). */
  source: string;
  /** `DuckDB database`, `DuckLake catalog`, `SQLite database`, `Iceberg REST catalog, attached as lake`. */
  kind: string;
  /** How a configured catalog that needs more than its file is attached (a catalog service, a DuckLake catalog in a database). */
  plan?: LakeCatalogPlan;
  /** Why a configured catalog cannot be attached as written (a missing setting). */
  invalid?: string;
}

/** Something in a data folder that ZLens does not read as a table, in plain words. */
export interface DataFolderSkip {
  /** The file's name, or the folder's name ending in `/`. */
  name: string;
  /** What it is, and why it is not read: `an Avro file (not read yet)`. */
  kind: string;
}

export interface DataFolderContents {
  tables: DataFolderTable[];
  catalogs: DataFolderCatalog[];
  skipped: DataFolderSkip[];
}

export interface DataFolderOptions {
  /** Attach DuckDB, DuckLake and SQLite files as catalogs (default true); otherwise they are skipped. */
  catalogs?: boolean;
  /** Files never read: the connection's own database file. */
  exclude?: string[];
  /** Entries of the folder (by name) not looked at: a project folder's `data/` when the project folder itself is read. */
  ignore?: string[];
  /** Table names already given (a connection's `sources`): a table found in the folder gets another. */
  takenNames?: Iterable<string>;
}

const READERS: Record<string, DataFileReader> = {
  '.csv': 'read_csv_auto',
  '.tsv': 'read_csv_auto',
  '.parquet': 'read_parquet',
  '.json': 'read_json_auto',
  '.jsonl': 'read_json_auto',
  '.ndjson': 'read_json_auto',
};

const FORMAT_NAMES: Record<string, string> = {
  '.csv': 'CSV', '.tsv': 'TSV', '.parquet': 'Parquet', '.json': 'JSON', '.jsonl': 'JSON Lines', '.ndjson': 'JSON Lines',
  '.xlsx': 'Excel', '.xls': 'Excel', '.avro': 'Avro', '.orc': 'ORC',
};

const CATALOG_FILES: Record<string, 'duckdb' | 'ducklake' | 'sqlite'> = {
  '.duckdb': 'duckdb',
  '.ducklake': 'ducklake',
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
};

const CATALOG_KINDS: Record<'duckdb' | 'ducklake' | 'sqlite', string> = {
  duckdb: 'DuckDB database',
  ducklake: 'DuckLake catalog',
  sqlite: 'SQLite database',
};

/** Files of open formats ZLens recognises but does not read as a table. */
const NOT_READ_FILES: Record<string, string> = {
  '.xls': 'an Excel 97-2003 workbook (save it as .xlsx to read it)',
  '.avro': 'an Avro file (not read yet)',
  '.orc': 'an ORC file (not read yet)',
  '.arrow': 'an Arrow file (not read yet)',
  '.feather': 'an Arrow file (not read yet)',
};

/**
 * Tool settings, not data: the data folder is often the project folder, which
 * holds dql.config.json (and package.json once ZLens is installed there).
 */
const SETTINGS_FILES = /^(?:dql\.config|dql-manifest|datalex-manifest|package|package-lock|npm-shrinkwrap|tsconfig(?:\..+)?|jsconfig|.+\.config)\.json$/i;
/** DuckDB reads these characters in a path as a pattern, so such a file could read others. */
const PATTERN_CHARACTERS = /[*?[\]{}]/;

/** Folders a project or a tool keeps beside its data: never data themselves. */
const TOOL_FOLDERS = new Set([
  'node_modules', 'target', 'logs', 'dbt_packages', 'domains', 'notebooks', 'apps', 'skills', 'tests',
  'semantic-layer', 'blocks', 'dashboards', 'workbooks', 'dql', 'reports', 'macros', 'models', 'seeds', 'snapshots', 'analyses',
]);

/** Catalog names DuckDB keeps for itself. */
const RESERVED_CATALOGS = new Set(['memory', 'temp', 'system', 'main', 'information_schema', 'pg_catalog']);

/** How far, and how much, a subfolder is looked into to say what it holds: enough to name it, never a crawl. */
const SCAN_DEPTH = 4;
const SCAN_ENTRIES = 2_000;
/** Subfolders looked into, at most: a folder like Downloads is not crawled. */
const SCAN_FOLDERS = 50;

/** Whether ZLens reads this file name as a table in a data folder (a CSV, TSV, Parquet or JSON file). */
export function isDataFile(fileName: string): boolean {
  return !fileName.startsWith('.') && extname(fileName).toLowerCase() in READERS && !SETTINGS_FILES.test(fileName) && !PATTERN_CHARACTERS.test(fileName);
}

/** The tables of a data folder, in the order of the entries they come from. An unreadable folder has none. */
export function dataFolderTables(folder: string, options: DataFolderOptions = {}): DataFolderTable[] {
  return readDataFolder(folder, options).tables;
}

/** What a data folder holds that ZLens does not read as a table, and what each one is. */
export function dataFolderSkipped(folder: string, options: DataFolderOptions = {}): DataFolderSkip[] {
  return readDataFolder(folder, options).skipped;
}

/**
 * A folder to read: on disk, or a bucket prefix listed once. Paths are
 * relative to the folder and `/`-separated; `''` is the folder itself.
 */
export interface FolderTree {
  /** Entries directly in a folder. */
  entries(path: string): Array<{ name: string; directory: boolean }>;
  /** A small text file (an Iceberg version hint), or undefined. */
  text(path: string): string | undefined;
  /** An Excel workbook's visible sheets, or undefined when it cannot be opened. */
  sheets(path: string): string[] | undefined;
  /** Where a reader reads it: an absolute path on disk, or a URL. */
  location(path: string): string;
  /** When it last changed (disk only), for caches; -1 when unknown. */
  modified(path: string): number;
  /** Disk: the real path, to compare with the files never read. A bucket: its URL. */
  identity(path: string): string;
}

/** Whether a path is a URL a DuckDB reader opens (`s3://`, `gs://`, `az://`, `https://`, …), not a path on disk. */
export function isUrlPath(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path);
}

const childPath = (path: string, name: string) => (path ? `${path}/${name}` : name);

/** A folder on disk. */
export function localFolderTree(folder: string): FolderTree {
  const at = (path: string) => (path ? join(folder, ...path.split('/')) : folder);
  return {
    entries: (path) => safeEntries(at(path))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
    text: (path) => {
      try {
        return readFileSync(at(path), 'utf8');
      } catch {
        return undefined;
      }
    },
    sheets: (path) => excelSheets(at(path)),
    location: (path) => at(path),
    modified: (path) => modifiedTime(at(path)),
    identity: (path) => realPath(at(path)),
  };
}

/**
 * A bucket prefix (or any folder) as the list of its files: their paths
 * relative to `root`. `texts` and `sheets` hold what was read ahead (version
 * hints, workbook sheet names), by relative path.
 */
export function listedFolderTree(
  root: string,
  files: string[],
  read: { texts?: Record<string, string>; sheets?: Record<string, string[] | undefined> } = {},
): FolderTree {
  const base = root.replace(/\/+$/, '');
  const children = new Map<string, Map<string, boolean>>();
  const add = (parent: string, name: string, directory: boolean) => {
    if (!children.has(parent)) children.set(parent, new Map());
    const known = children.get(parent)!;
    known.set(name, (known.get(name) ?? false) || directory);
  };
  for (const file of files) {
    const parts = file.split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      add(parts.slice(0, index).join('/'), parts[index], index < parts.length - 1);
    }
  }
  return {
    entries: (path) => [...(children.get(path) ?? new Map<string, boolean>())].map(([name, directory]) => ({ name, directory })),
    text: (path) => read.texts?.[path],
    sheets: (path) => read.sheets?.[path],
    location: (path) => (path ? `${base}/${path}` : base),
    modified: () => -1,
    identity: (path) => (path ? `${base}/${path}` : base),
  };
}

/**
 * Everything a data folder holds: its tables, its database files (attached
 * as catalogs) and what is skipped, each with what it is. An unreadable
 * folder holds nothing. A bucket URL needs its listing: see `readFolderTree`
 * with `listedFolderTree`.
 */
export function readDataFolder(folder: string, options: DataFolderOptions = {}): DataFolderContents {
  if (isUrlPath(folder)) return { tables: [], catalogs: [], skipped: [] };
  try {
    readdirSync(folder);
  } catch {
    return { tables: [], catalogs: [], skipped: [] };
  }
  return readFolderTree(localFolderTree(folder), options);
}

/** What a folder holds (see `readDataFolder`), on disk or listed from a bucket. */
export function readFolderTree(tree: FolderTree, options: DataFolderOptions = {}): DataFolderContents {
  const entries = tree.entries('');
  const projectFolder = entries.some((entry) => !entry.directory && entry.name === 'dql.config.json');
  const excluded = new Set((options.exclude ?? []).map((path) => (isUrlPath(path) ? path.replace(/\/+$/, '') : realPath(path))));
  const ignored = new Set((options.ignore ?? []).map((name) => name.toLowerCase()));
  // A project folder read as its own data folder: its `data/` is where `zlens init` looks next, never one table.
  if (projectFolder) ignored.add('data');
  const fileNames = new Set(entries.filter((entry) => !entry.directory).map((entry) => entry.name.toLowerCase()));
  const found: Array<Omit<DataFolderTable, 'name'> & { stem: string; suffix: string }> = [];
  const catalogs: Array<Omit<DataFolderCatalog, 'name'> & { stem: string }> = [];
  const skipped: DataFolderSkip[] = [];
  let foldersLookedInto = 0;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || ignored.has(entry.name.toLowerCase())) continue;
    const path = entry.name;
    if (entry.directory) {
      if (TOOL_FOLDERS.has(entry.name.toLowerCase()) || foldersLookedInto >= SCAN_FOLDERS) continue;
      // DuckLake keeps a catalog's data files in `<name>.ducklake.files/`: part of that catalog, not a table.
      if (/\.files$/i.test(entry.name) && fileNames.has(entry.name.slice(0, -'.files'.length).toLowerCase())) continue;
      foldersLookedInto += 1;
      const subfolder = describeSubfolder(tree, path);
      if (!subfolder) continue;
      const source = `${entry.name}/`;
      if ('skip' in subfolder) {
        skipped.push({ name: source, kind: subfolder.skip });
      } else if (PATTERN_CHARACTERS.test(entry.name)) {
        skipped.push({ name: source, kind: `${subfolder.kind}, in a folder whose name DuckDB would read as a pattern (it holds * ? [ ] { or })` });
      } else {
        found.push({ ...subfolder, source, stem: entry.name, suffix: '' });
      }
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    const stem = entry.name.slice(0, entry.name.length - extension.length);
    if (extension in READERS) {
      if (SETTINGS_FILES.test(entry.name) || (projectFolder && extension === '.json')) continue;
      if (PATTERN_CHARACTERS.test(entry.name)) {
        skipped.push({ name: entry.name, kind: 'a data file whose name DuckDB would read as a pattern (it holds * ? [ ] { or })' });
        continue;
      }
      found.push({ file: tree.location(path), reader: READERS[extension], source: entry.name, kind: `${FORMAT_NAMES[extension]} file`, stem, suffix: extension.slice(1) });
    } else if (extension === '.xlsx') {
      if (PATTERN_CHARACTERS.test(entry.name)) {
        skipped.push({ name: entry.name, kind: 'an Excel workbook whose name DuckDB would read as a pattern (it holds * ? [ ] { or })' });
        continue;
      }
      const sheets = tree.sheets(path);
      if (!sheets) {
        skipped.push({ name: entry.name, kind: 'an Excel workbook ZLens could not open' });
      } else if (!sheets.length) {
        skipped.push({ name: entry.name, kind: 'an Excel workbook with no visible sheets' });
      } else {
        for (const sheet of sheets) {
          found.push({
            file: tree.location(path),
            reader: 'read_xlsx',
            sheet,
            source: entry.name,
            kind: `Excel sheet "${sheet}"`,
            stem: sheets.length === 1 ? stem : `${stem}_${sheet}`,
            suffix: 'xlsx',
          });
        }
      }
    } else if (extension in CATALOG_FILES) {
      if (excluded.has(tree.identity(path))) continue;
      const type = CATALOG_FILES[extension];
      if (options.catalogs === false) {
        skipped.push({ name: entry.name, kind: `a ${CATALOG_KINDS[type]} (only a file connection's data folder attaches one)` });
      } else if (PATTERN_CHARACTERS.test(entry.name) || entry.name.includes("'")) {
        skipped.push({ name: entry.name, kind: `a ${CATALOG_KINDS[type]} whose name DuckDB would read as a pattern (it holds * ? [ ] { } or ')` });
      } else {
        catalogs.push({ file: tree.location(path), type, source: entry.name, kind: CATALOG_KINDS[type], stem });
      }
    } else if (extension in NOT_READ_FILES) {
      skipped.push({ name: entry.name, kind: NOT_READ_FILES[extension] });
    }
  }

  const tables = nameTables(found, options.takenNames);
  const catalogNames = new Set<string>();
  const attached = catalogs.map(({ stem, ...catalog }) => {
    let name = identifier(stem);
    if (RESERVED_CATALOGS.has(name)) name = `${name}_${catalog.type}`;
    for (let n = 2; catalogNames.has(name); n += 1) name = `${identifier(stem)}_${n}`;
    catalogNames.add(name);
    return { name, ...catalog, kind: `${catalog.kind}, attached as ${name}` };
  });
  return { tables, catalogs: attached, skipped };
}

/** Table names for what was found, in order: `orders.csv` beside `orders.parquet` is `orders_parquet`; a name in `taken` is never given. */
function nameTables(found: Array<Omit<DataFolderTable, 'name'> & { stem: string; suffix: string }>, takenNames: Iterable<string> = []): DataFolderTable[] {
  const taken = new Set([...takenNames].map((name) => name.toLowerCase()));
  return found.map(({ stem, suffix, ...table }) => {
    let name = identifier(stem);
    if (taken.has(name) && suffix) name = `${name}_${suffix}`;
    for (let n = 2; taken.has(name); n += 1) name = `${identifier(stem)}_${n}`;
    taken.add(name);
    return { name, ...table };
  });
}

/** A name as a SQL identifier: lower case letters, digits and `_`, never starting with a digit. */
export function tableIdentifier(text: string): string {
  return identifier(text);
}

function identifier(text: string): string {
  const stem = text.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'data';
  return /^[0-9]/.test(stem) ? `t_${stem}` : stem;
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

type Subfolder = Omit<DataFolderTable, 'name' | 'source'> | { skip: string };

const isIcebergMetadataFolder = (tree: FolderTree, path: string) => tree.entries(path).some((entry) => !entry.directory && /\.metadata\.json$/i.test(entry.name));

/** What a subfolder of a data folder (or, with `''`, the folder itself) is, or undefined when it holds no data. */
export function describeSubfolder(tree: FolderTree, path: string): Subfolder | undefined {
  const top = tree.entries(path);
  if (top.some((entry) => entry.directory && entry.name === '_delta_log')) {
    return { file: tree.location(path), reader: 'delta_scan', kind: 'Delta Lake table' };
  }
  const iceberg = top.some((entry) => entry.directory && entry.name === 'metadata') ? newestIcebergVersion(tree, childPath(path, 'metadata')) : undefined;
  if (iceberg) {
    return {
      file: tree.location(path),
      reader: 'iceberg_scan',
      icebergVersion: { name: iceberg.name, gzip: iceberg.gzip },
      kind: `Iceberg table (version ${iceberg.version})`,
    };
  }
  const files = scanFolderOfFiles(tree, path, top);
  if (files.tables) {
    return { skip: `a folder of ${files.tables} Delta Lake or Iceberg table${files.tables === 1 ? '' : 's'} (ZLens reads a table at the top of the data folder)` };
  }
  // JSON beside other data files is metadata (a schema, a manifest); alone, it is as often settings as data.
  if (counted(files.counts, '.json') && files.counts.size > 1) files.counts.delete('.json');
  const total = [...files.counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0 || (files.counts.size === 1 && files.counts.has('.json'))) return undefined;
  const more = files.truncated ? '+' : '';
  const formats = [...files.counts.keys()].map((extension) => FORMAT_NAMES[extension]);
  if (files.counts.size > 1) {
    return { skip: `a folder of ${total}${more} files in ${listWords([...new Set(formats)])} (ZLens reads a folder of one format as one table)` };
  }
  const [extension] = [...files.counts.keys()];
  const reader = READERS[extension];
  const described = `${total}${more} ${formats[0]} file${total === 1 && !more ? '' : 's'}`;
  if (!reader) {
    return { skip: `a folder of ${described} (ZLens reads a folder of CSV, TSV, Parquet or JSON files)` };
  }
  const partitioned = files.partitionKeys.length > 0;
  return {
    file: `${tree.location(path).replaceAll('\\', '/').replace(/\/+$/, '')}/**/*${files.extensionAsWritten.get(extension) ?? extension}`,
    reader,
    folder: { partitioned },
    kind: partitioned ? `${described}, partitioned by ${files.partitionKeys.join(', ')}` : described,
  };
}

function counted(counts: Map<string, number>, extension: string): boolean {
  return (counts.get(extension) ?? 0) > 0;
}

function listWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

interface FolderScan {
  /** Data files by extension (lower case). */
  counts: Map<string, number>;
  /** An extension as the files spell it (`.CSV`), when they all spell it one way. */
  extensionAsWritten: Map<string, string>;
  partitionKeys: string[];
  /** Delta Lake or Iceberg tables found inside (never read as plain files). */
  tables: number;
  truncated: boolean;
}

/** Recently scanned folders on disk: a folder's files are counted again when it changes, or after a short while. */
const folderScans = new Map<string, { modified: number; at: number; scan: FolderScan }>();
const FOLDER_SCAN_REUSE_MS = 2_000;

/** A folder of data files: count them (bounded) and read partition keys from `key=value` folder names. */
function scanFolderOfFiles(tree: FolderTree, path: string, top: Array<{ name: string; directory: boolean }>): FolderScan {
  const modified = tree.modified(path);
  const cacheKey = tree.location(path);
  const cached = modified >= 0 ? folderScans.get(cacheKey) : undefined;
  if (cached && cached.modified === modified && Date.now() - cached.at < FOLDER_SCAN_REUSE_MS) return cached.scan;
  const scan: FolderScan = { counts: new Map(), extensionAsWritten: new Map(), partitionKeys: [], tables: 0, truncated: false };
  const spellings = new Map<string, Set<string>>();
  let seen = 0;
  const walk = (dir: string, depth: number, entries: Array<{ name: string; directory: boolean }>): void => {
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      if (seen >= SCAN_ENTRIES) {
        scan.truncated = true;
        return;
      }
      seen += 1;
      const inner = childPath(dir, entry.name);
      if (entry.directory) {
        const innerEntries = tree.entries(inner);
        if (innerEntries.some((child) => child.directory && (child.name === '_delta_log' || (child.name === 'metadata' && isIcebergMetadataFolder(tree, childPath(inner, 'metadata')))))) {
          scan.tables += 1;
          continue;
        }
        const partition = /^([^=]+)=/.exec(entry.name)?.[1];
        if (partition && !scan.partitionKeys.includes(partition) && depth === scan.partitionKeys.length) scan.partitionKeys.push(partition);
        if (depth < SCAN_DEPTH) walk(inner, depth + 1, innerEntries);
      } else {
        const written = extname(entry.name);
        const extension = written.toLowerCase();
        if (!(extension in FORMAT_NAMES)) continue;
        scan.counts.set(extension, (scan.counts.get(extension) ?? 0) + 1);
        if (!spellings.has(extension)) spellings.set(extension, new Set());
        spellings.get(extension)!.add(written);
      }
    }
  };
  walk(path, 0, top);
  for (const [extension, written] of spellings) {
    if (written.size === 1) scan.extensionAsWritten.set(extension, [...written][0]);
  }
  if (modified >= 0) {
    folderScans.set(cacheKey, { modified, at: Date.now(), scan });
    if (folderScans.size > 500) folderScans.delete(folderScans.keys().next().value!);
  }
  return scan;
}

/**
 * An Iceberg table's newest metadata file: the one `version-hint.text` names
 * when there is one, else the highest version (`00003-….metadata.json`,
 * `v3.metadata.json`); between equal versions, the most recently written.
 * `name` is the file's name without `.metadata.json` (and `.gz`, when it is
 * gzip-compressed: `00003-….gz.metadata.json`).
 */
export function newestIcebergMetadata(metadataFolder: string): { file: string; name: string; version: number; gzip: boolean } | undefined {
  const newest = newestIcebergVersion(localFolderTree(metadataFolder), '');
  return newest && { ...newest, file: join(metadataFolder, newest.file) };
}

/** As `newestIcebergMetadata`, in a folder tree: `file` is the metadata file's path in the tree. */
function newestIcebergVersion(tree: FolderTree, metadataPath: string): { file: string; name: string; version: number; gzip: boolean } | undefined {
  const files = tree.entries(metadataPath)
    .filter((entry) => !entry.directory && /\.metadata\.json$/i.test(entry.name))
    .map((entry) => {
      const version = /^v?(\d+)[-.]/i.exec(entry.name)?.[1];
      return { name: entry.name, version: version === undefined ? -1 : Number(version), modified: tree.modified(childPath(metadataPath, entry.name)) };
    });
  if (!files.length) return undefined;
  const hintText = tree.text(childPath(metadataPath, 'version-hint.text'))?.trim();
  const hint = hintText && /^\d+$/.test(hintText) ? Number(hintText) : undefined;
  const hinted = hint === undefined ? [] : files.filter((file) => file.version === hint);
  const candidates = hinted.length ? hinted : files;
  const newest = candidates.sort((a, b) => b.version - a.version || b.modified - a.modified || b.name.localeCompare(a.name))[0];
  const gzip = /\.gz\.metadata\.json$/i.test(newest.name);
  return {
    file: childPath(metadataPath, newest.name),
    name: newest.name.replace(gzip ? /\.gz\.metadata\.json$/i : /\.metadata\.json$/i, ''),
    version: Math.max(newest.version, 0),
    gzip,
  };
}

/** Recently read workbooks: a workbook's sheets are read again when it changes. */
const workbookSheets = new Map<string, { modified: number; size: number; sheets: string[] | undefined }>();

/**
 * The visible sheets of an Excel workbook (`.xlsx`), in workbook order, read
 * from its `xl/workbook.xml`; undefined when it is not a workbook ZLens can open.
 */
export function excelSheets(path: string): string[] | undefined {
  let modified = -1;
  let size = -1;
  try {
    const stats = statSync(path);
    modified = stats.mtimeMs;
    size = stats.size;
  } catch {
    return undefined;
  }
  const cached = workbookSheets.get(path);
  if (cached && cached.modified === modified && cached.size === size) return cached.sheets;
  let sheets: string[] | undefined;
  try {
    const fd = openSync(path, 'r');
    try {
      sheets = workbookSheetNames(zipEntry((offset, length) => {
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, offset);
        return buffer;
      }, size, 'xl/workbook.xml'));
    } finally {
      closeSync(fd);
    }
  } catch {
    sheets = undefined;
  }
  workbookSheets.set(path, { modified, size, sheets });
  if (workbookSheets.size > 500) workbookSheets.delete(workbookSheets.keys().next().value!);
  return sheets;
}

/** The visible sheets of an Excel workbook held in memory (read from a bucket), or undefined when it is not a workbook ZLens can open. */
export function excelSheetsFromBytes(bytes: Uint8Array): string[] | undefined {
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return workbookSheetNames(zipEntry((offset, length) => buffer.subarray(offset, offset + length), buffer.length, 'xl/workbook.xml'));
  } catch {
    return undefined;
  }
}

function workbookSheetNames(workbook: Buffer | undefined): string[] | undefined {
  if (!workbook) return undefined;
  const sheets: string[] = [];
  for (const match of workbook.toString('utf8').matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const attributes = match[1];
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1];
    const state = /\bstate="([^"]*)"/.exec(attributes)?.[1];
    if (name !== undefined && state !== 'hidden' && state !== 'veryHidden') sheets.push(decodeXml(name));
  }
  return sheets;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number(lower.slice(1)));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[lower] ?? whole;
  });
}

const ZIP_ENTRY_LIMIT = 8 * 1024 * 1024;

/** One file of a zip archive (stored or deflated), read through `read(offset, length)`, or undefined. Zip64 archives are not read. */
function zipEntry(read: (offset: number, length: number) => Buffer, size: number, entryName: string): Buffer | undefined {
  const tailLength = Math.min(size, 22 + 0xffff);
  if (tailLength < 22) return undefined;
  const tail = read(size - tailLength, tailLength);
  let end = -1;
  for (let at = tailLength - 22; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) return undefined;
  const entries = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (directoryOffset + directorySize > size || directorySize > ZIP_ENTRY_LIMIT) return undefined;
  const directory = read(directoryOffset, directorySize);
  let at = 0;
  for (let index = 0; index < entries && at + 46 <= directory.length; index += 1) {
    if (directory.readUInt32LE(at) !== 0x02014b50) return undefined;
    const method = directory.readUInt16LE(at + 10);
    const compressedSize = directory.readUInt32LE(at + 20);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const localOffset = directory.readUInt32LE(at + 42);
    const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name !== entryName) continue;
    if (compressedSize > ZIP_ENTRY_LIMIT || localOffset + 30 > size) return undefined;
    const local = read(localOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) return undefined;
    const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (dataStart + compressedSize > size) return undefined;
    const data = read(dataStart, compressedSize);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data, { maxOutputLength: ZIP_ENTRY_LIMIT });
    return undefined;
  }
  return undefined;
}

function safeEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function modifiedTime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;
const sqlIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** The reader call for a view: `read_parquet('/data/events/**\/*.parquet', union_by_name = true, hive_partitioning = true)`. */
function readerCall(source: DataFolderViewSource): string {
  switch (source.reader) {
    case 'read_xlsx':
      return `read_xlsx(${sqlText(source.file)}${source.sheet === undefined ? '' : `, sheet = ${sqlText(source.sheet)}`})`;
    case 'iceberg_scan': {
      const version = source.icebergVersion;
      return version
        ? `iceberg_scan(${sqlText(source.file)}, allow_moved_paths = true, version = ${sqlText(version.name)}${version.gzip ? `, metadata_compression_codec = 'gzip'` : ''})`
        : `iceberg_scan(${sqlText(source.file)})`;
    }
    case 'delta_scan':
      return `delta_scan(${sqlText(source.file)})`;
    default:
      if (!source.folder) return `${source.reader}(${sqlText(source.file)})`;
      return source.folder.sameColumns
        ? `${source.reader}(${sqlText(source.file)}${source.folder.partitioned ? ', hive_partitioning = true' : ''})`
        : `${source.reader}(${sqlText(source.file)}, union_by_name = true${source.folder.partitioned ? ', hive_partitioning = true' : ''})`;
  }
}

/**
 * `CREATE OR REPLACE VIEW` for a table, reading its data where it is.
 * `temporary`: the connection's own database is a real file, which the views
 * must not be written into.
 */
export function dataFolderViewStatement(source: DataFolderViewSource, options: { temporary?: boolean } = {}): string {
  // A view in a catalog of ZLens's own is in memory already: never temporary.
  return `CREATE OR REPLACE ${options.temporary && !source.catalog ? 'TEMP ' : ''}VIEW ${viewTarget(source)} AS SELECT * FROM ${readerCall(source)}`;
}

export function dataFolderViewStatements(sources: DataFolderViewSource[], options: { temporary?: boolean } = {}): string[] {
  return sources.map((source) => dataFolderViewStatement(source, options));
}

/** `temporary`: drop the temporary view, never the database's own view of that name. */
export function dropDataFolderViewStatement(view: string | Pick<DataFolderViewSource, 'name' | 'catalog' | 'schema'>, options: { temporary?: boolean } = {}): string {
  const source = typeof view === 'string' ? { name: view } : view;
  if (source.catalog) return `DROP VIEW IF EXISTS ${viewTarget(source)}`;
  return `DROP VIEW IF EXISTS ${options.temporary ? 'temp.main.' : ''}${sqlIdent(source.name)}`;
}

/**
 * A connection's own `catalogs` as catalogs to attach (named as given; the
 * type from the path when left out). A catalog service, or a DuckLake catalog
 * kept in a database, carries its plan (secrets, then a read-only ATTACH); a
 * catalog that cannot be attached as written carries why.
 */
export function configuredCatalogs(catalogs: Array<Partial<LakeCatalogConfig>> | undefined, storage?: LakeStorageConfig): DataFolderCatalog[] {
  const out: DataFolderCatalog[] = [];
  const taken = new Set<string>();
  for (const catalog of catalogs ?? []) {
    if (!catalog || typeof catalog !== 'object') continue;
    const config = { ...catalog, name: String(catalog.name ?? '') } as LakeCatalogConfig;
    const path = String(catalog.path ?? '').trim();
    const type = lakeCatalogType(config);
    const planned = needsLakeCatalogPlan(config);
    if (!path && !planned) continue;
    const fallback = path ? path.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '') : type;
    let name = identifier(String(catalog.name ?? '').trim() || fallback);
    if (RESERVED_CATALOGS.has(name)) name = `${name}_${type}`;
    for (let n = 2; taken.has(name); n += 1) name = `${identifier(String(catalog.name ?? 'catalog'))}_${n}`;
    taken.add(name);
    const kind = `${lakeCatalogKind(config)}, attached as ${name}`;
    if (!planned) {
      out.push({ name, file: path, type, source: path, kind });
      continue;
    }
    try {
      const plan = lakeCatalogPlan(config, name, storage);
      out.push({ name, file: path || plan.source, type, source: plan.source, kind, plan });
    } catch (error) {
      out.push({ name, file: path, type, source: path || lakeCatalogKind(config), kind, invalid: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

/** `ATTACH` a catalog, read-only, under its catalog name (a database file of the data folder, or a configured catalog's plan). */
export function dataFolderAttachStatement(catalog: Pick<DataFolderCatalog, 'name' | 'file' | 'type' | 'plan'>): string {
  if (catalog.plan) return catalog.plan.attach;
  const path = catalog.type === 'ducklake' ? `ducklake:${catalog.file}` : catalog.file;
  const options = catalog.type === 'sqlite' ? 'TYPE sqlite, READ_ONLY' : 'READ_ONLY';
  return `ATTACH IF NOT EXISTS ${sqlText(path)} AS ${sqlIdent(catalog.name)} (${options})`;
}

export function detachDataFolderCatalogStatement(name: string): string {
  return `DETACH DATABASE IF EXISTS ${sqlIdent(name)}`;
}

/** The files a folder table reads, to check they share columns before it is one table (not partitioned folders: their files union by column name). */
export function dataFolderFilesStatement(source: DataFolderViewSource, limit: number): string | undefined {
  if (!source.folder || source.folder.partitioned) return undefined;
  return `SELECT file FROM glob(${sqlText(source.file)}) ORDER BY file LIMIT ${Math.max(1, Math.floor(limit))}`;
}

/** The columns of one file a folder table reads. */
export function dataFolderFileColumnsStatement(source: DataFolderViewSource, file: string): string {
  return `DESCRIBE SELECT * FROM ${source.reader}(${sqlText(file)})`;
}

/** Every file a folder table reads, in order (one listing; no file is opened). */
export function dataFolderAllFilesStatement(source: DataFolderViewSource): string | undefined {
  if (!source.folder) return undefined;
  return `SELECT file FROM glob(${sqlText(source.file)}) ORDER BY file`;
}
