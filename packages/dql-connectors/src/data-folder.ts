import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

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
  /** A folder of files: read as one table (by column name); partitioned, its `key=value` folder names are columns. */
  folder?: { partitioned: boolean };
  /**
   * An Iceberg table's newest metadata version (`00003-1b2c…`, from
   * `00003-1b2c….metadata.json`): it is read as of that version, from its own
   * folder even when it was written elsewhere (copied, or synced from a bucket).
   */
  icebergVersion?: { name: string; gzip: boolean };
}

export interface DataFolderTable extends DataFolderViewSource {
  /** The entry of the data folder it comes from: `orders.csv`, `events/`, `targets.xlsx`. */
  source: string;
  /** What it is, in plain words: `CSV file`, `Delta Lake table`, `Iceberg table (version 3)`, `20 Parquet files, partitioned by year, month`. */
  kind: string;
}

/** A database file in the data folder, attached read-only beside the connection's own database. */
export interface DataFolderCatalog {
  /** The catalog's name: the file name as an identifier (`lake.ducklake` → `lake`). Its tables are `lake.main.orders`. */
  name: string;
  /** The file's absolute path. */
  file: string;
  type: 'duckdb' | 'ducklake' | 'sqlite';
  /** The file's name in the data folder. */
  source: string;
  /** `DuckDB database`, `DuckLake catalog`, `SQLite database`. */
  kind: string;
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

const CATALOG_FILES: Record<string, DataFolderCatalog['type']> = {
  '.duckdb': 'duckdb',
  '.ducklake': 'ducklake',
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
};

const CATALOG_KINDS: Record<DataFolderCatalog['type'], string> = {
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
 * Everything a data folder holds: its tables, its database files (attached
 * as catalogs) and what is skipped, each with what it is. An unreadable
 * folder holds nothing.
 */
export function readDataFolder(folder: string, options: DataFolderOptions = {}): DataFolderContents {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return { tables: [], catalogs: [], skipped: [] };
  }
  const projectFolder = entries.some((entry) => entry.isFile() && entry.name === 'dql.config.json');
  const excluded = new Set((options.exclude ?? []).map(realPath));
  const ignored = new Set((options.ignore ?? []).map((name) => name.toLowerCase()));
  // A project folder read as its own data folder: its `data/` is where `zlens init` looks next, never one table.
  if (projectFolder) ignored.add('data');
  const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase()));
  const found: Array<Omit<DataFolderTable, 'name'> & { stem: string; suffix: string }> = [];
  const catalogs: Array<Omit<DataFolderCatalog, 'name'> & { stem: string }> = [];
  const skipped: DataFolderSkip[] = [];
  let foldersLookedInto = 0;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || ignored.has(entry.name.toLowerCase())) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (TOOL_FOLDERS.has(entry.name.toLowerCase()) || foldersLookedInto >= SCAN_FOLDERS) continue;
      // DuckLake keeps a catalog's data files in `<name>.ducklake.files/`: part of that catalog, not a table.
      if (/\.files$/i.test(entry.name) && fileNames.has(entry.name.slice(0, -'.files'.length).toLowerCase())) continue;
      foldersLookedInto += 1;
      const subfolder = describeSubfolder(path);
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
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    const stem = entry.name.slice(0, entry.name.length - extension.length);
    if (extension in READERS) {
      if (SETTINGS_FILES.test(entry.name) || (projectFolder && extension === '.json')) continue;
      if (PATTERN_CHARACTERS.test(entry.name)) {
        skipped.push({ name: entry.name, kind: 'a data file whose name DuckDB would read as a pattern (it holds * ? [ ] { or })' });
        continue;
      }
      found.push({ file: path, reader: READERS[extension], source: entry.name, kind: `${FORMAT_NAMES[extension]} file`, stem, suffix: extension.slice(1) });
    } else if (extension === '.xlsx') {
      if (PATTERN_CHARACTERS.test(entry.name)) {
        skipped.push({ name: entry.name, kind: 'an Excel workbook whose name DuckDB would read as a pattern (it holds * ? [ ] { or })' });
        continue;
      }
      const sheets = excelSheets(path);
      if (!sheets) {
        skipped.push({ name: entry.name, kind: 'an Excel workbook ZLens could not open' });
      } else if (!sheets.length) {
        skipped.push({ name: entry.name, kind: 'an Excel workbook with no visible sheets' });
      } else {
        for (const sheet of sheets) {
          found.push({
            file: path,
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
      if (excluded.has(realPath(path))) continue;
      const type = CATALOG_FILES[extension];
      if (options.catalogs === false) {
        skipped.push({ name: entry.name, kind: `a ${CATALOG_KINDS[type]} (only a file connection's data folder attaches one)` });
      } else if (PATTERN_CHARACTERS.test(entry.name) || entry.name.includes("'")) {
        skipped.push({ name: entry.name, kind: `a ${CATALOG_KINDS[type]} whose name DuckDB would read as a pattern (it holds * ? [ ] { } or ')` });
      } else {
        catalogs.push({ file: path, type, source: entry.name, kind: CATALOG_KINDS[type], stem });
      }
    } else if (extension in NOT_READ_FILES) {
      skipped.push({ name: entry.name, kind: NOT_READ_FILES[extension] });
    }
  }

  const taken = new Set<string>();
  const tables = found.map(({ stem, suffix, ...table }) => {
    let name = identifier(stem);
    // orders.csv and orders.parquet side by side: the second is orders_parquet.
    if (taken.has(name) && suffix) name = `${name}_${suffix}`;
    for (let n = 2; taken.has(name); n += 1) name = `${identifier(stem)}_${n}`;
    taken.add(name);
    return { name, ...table };
  });
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

/** A name as a SQL identifier: lower case letters, digits and `_`, never starting with a digit. */
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

/** What a subfolder of a data folder is, or undefined when it holds no data. */
function describeSubfolder(path: string): Subfolder | undefined {
  const top = safeEntries(path);
  if (top.some((entry) => entry.isDirectory() && entry.name === '_delta_log')) {
    return { file: path, reader: 'delta_scan', kind: 'Delta Lake table' };
  }
  const iceberg = top.some((entry) => entry.isDirectory() && entry.name === 'metadata') ? newestIcebergMetadata(join(path, 'metadata')) : undefined;
  if (iceberg) {
    return {
      file: path,
      reader: 'iceberg_scan',
      icebergVersion: { name: iceberg.name, gzip: iceberg.gzip },
      kind: `Iceberg table (version ${iceberg.version})`,
    };
  }
  const files = scanFolderOfFiles(path, top);
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
    file: `${path.replaceAll('\\', '/')}/**/*${files.extensionAsWritten.get(extension) ?? extension}`,
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

/** Recently scanned folders: a folder's files are counted again when it changes, or after a short while. */
const folderScans = new Map<string, { modified: number; at: number; scan: FolderScan }>();
const FOLDER_SCAN_REUSE_MS = 2_000;

/** A folder of data files: count them (bounded) and read partition keys from `key=value` folder names. */
function scanFolderOfFiles(path: string, top: Dirent[]): FolderScan {
  const modified = modifiedTime(path);
  const cached = folderScans.get(path);
  if (cached && cached.modified === modified && Date.now() - cached.at < FOLDER_SCAN_REUSE_MS) return cached.scan;
  const scan: FolderScan = { counts: new Map(), extensionAsWritten: new Map(), partitionKeys: [], tables: 0, truncated: false };
  const spellings = new Map<string, Set<string>>();
  let seen = 0;
  const walk = (dir: string, depth: number, entries: Dirent[]): void => {
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      if (seen >= SCAN_ENTRIES) {
        scan.truncated = true;
        return;
      }
      seen += 1;
      if (entry.isDirectory()) {
        const inner = safeEntries(join(dir, entry.name));
        if (inner.some((child) => child.isDirectory() && (child.name === '_delta_log'
          || (child.name === 'metadata' && safeEntries(join(dir, entry.name, 'metadata')).some((file) => /\.metadata\.json$/i.test(file.name)))))) {
          scan.tables += 1;
          continue;
        }
        const partition = /^([^=]+)=/.exec(entry.name)?.[1];
        if (partition && !scan.partitionKeys.includes(partition) && depth === scan.partitionKeys.length) scan.partitionKeys.push(partition);
        if (depth < SCAN_DEPTH) walk(join(dir, entry.name), depth + 1, inner);
      } else if (entry.isFile()) {
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
  folderScans.set(path, { modified, at: Date.now(), scan });
  if (folderScans.size > 500) folderScans.delete(folderScans.keys().next().value!);
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
  const files = safeEntries(metadataFolder)
    .filter((entry) => entry.isFile() && /\.metadata\.json$/i.test(entry.name))
    .map((entry) => {
      const version = /^v?(\d+)[-.]/i.exec(entry.name)?.[1];
      return { name: entry.name, version: version === undefined ? -1 : Number(version), modified: modifiedTime(join(metadataFolder, entry.name)) };
    });
  if (!files.length) return undefined;
  let hint: number | undefined;
  try {
    const text = readFileSync(join(metadataFolder, 'version-hint.text'), 'utf8').trim();
    if (/^\d+$/.test(text)) hint = Number(text);
  } catch {
    // No hint: the highest version is the newest.
  }
  const hinted = hint === undefined ? [] : files.filter((file) => file.version === hint);
  const candidates = hinted.length ? hinted : files;
  const newest = candidates.sort((a, b) => b.version - a.version || b.modified - a.modified || b.name.localeCompare(a.name))[0];
  const gzip = /\.gz\.metadata\.json$/i.test(newest.name);
  return {
    file: join(metadataFolder, newest.name),
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
    const workbook = zipEntry(path, 'xl/workbook.xml');
    if (workbook) {
      sheets = [];
      for (const match of workbook.toString('utf8').matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
        const attributes = match[1];
        const name = /\bname="([^"]*)"/.exec(attributes)?.[1];
        const state = /\bstate="([^"]*)"/.exec(attributes)?.[1];
        if (name !== undefined && state !== 'hidden' && state !== 'veryHidden') sheets.push(decodeXml(name));
      }
    }
  } catch {
    sheets = undefined;
  }
  workbookSheets.set(path, { modified, size, sheets });
  if (workbookSheets.size > 500) workbookSheets.delete(workbookSheets.keys().next().value!);
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

/** One file of a zip archive (stored or deflated), or undefined. Zip64 archives are not read. */
function zipEntry(path: string, entryName: string): Buffer | undefined {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLength = Math.min(size, 22 + 0xffff);
    if (tailLength < 22) return undefined;
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, size - tailLength);
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
    const directory = Buffer.alloc(directorySize);
    readSync(fd, directory, 0, directorySize, directoryOffset);
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
      if (compressedSize > ZIP_ENTRY_LIMIT) return undefined;
      const local = Buffer.alloc(30);
      readSync(fd, local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50) return undefined;
      const data = Buffer.alloc(compressedSize);
      readSync(fd, data, 0, compressedSize, localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28));
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: ZIP_ENTRY_LIMIT });
      return undefined;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
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
      return source.folder
        ? `${source.reader}(${sqlText(source.file)}, union_by_name = true${source.folder.partitioned ? ', hive_partitioning = true' : ''})`
        : `${source.reader}(${sqlText(source.file)})`;
  }
}

/**
 * `CREATE OR REPLACE VIEW` for a table, reading its data where it is.
 * `temporary`: the connection's own database is a real file, which the views
 * must not be written into.
 */
export function dataFolderViewStatement(source: DataFolderViewSource, options: { temporary?: boolean } = {}): string {
  return `CREATE OR REPLACE ${options.temporary ? 'TEMP ' : ''}VIEW ${sqlIdent(source.name)} AS SELECT * FROM ${readerCall(source)}`;
}

export function dataFolderViewStatements(sources: DataFolderViewSource[], options: { temporary?: boolean } = {}): string[] {
  return sources.map((source) => dataFolderViewStatement(source, options));
}

/** `temporary`: drop the temporary view, never the database's own view of that name. */
export function dropDataFolderViewStatement(name: string, options: { temporary?: boolean } = {}): string {
  return `DROP VIEW IF EXISTS ${options.temporary ? 'temp.main.' : ''}${sqlIdent(name)}`;
}

/** `ATTACH` a database file of the data folder, read-only, under its catalog name. */
export function dataFolderAttachStatement(catalog: Pick<DataFolderCatalog, 'name' | 'file' | 'type'>): string {
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
