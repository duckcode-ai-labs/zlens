import { readdirSync, type Dirent } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * A folder of data files read as a database (a file connection's
 * `dataFolder`): each CSV, TSV, Parquet or JSON file in it is one view, named
 * after the file. Hidden files and subfolders are not read, nor a name DuckDB
 * would read as a pattern (`sales[1].csv`, `*.csv`). In a ZLens project's own
 * folder, `.json` files are its settings and are left out (JSON Lines stay).
 */

export type DataFileReader = 'read_csv_auto' | 'read_parquet' | 'read_json_auto';

export interface DataFolderTable {
  /** The view's name: the file name without its extension, as an identifier (`daily-sales.csv` → `daily_sales`). */
  name: string;
  /** The file's absolute path. */
  file: string;
  reader: DataFileReader;
}

const READERS: Record<string, DataFileReader> = {
  '.csv': 'read_csv_auto',
  '.tsv': 'read_csv_auto',
  '.parquet': 'read_parquet',
  '.json': 'read_json_auto',
  '.jsonl': 'read_json_auto',
  '.ndjson': 'read_json_auto',
};

/**
 * Tool settings, not data: the data folder is often the project folder, which
 * holds dql.config.json (and package.json once ZLens is installed there).
 */
const SETTINGS_FILES = /^(?:dql\.config|dql-manifest|datalex-manifest|package|package-lock|npm-shrinkwrap|tsconfig(?:\..+)?|jsconfig|.+\.config)\.json$/i;
/** DuckDB reads these characters in a path as a pattern, so such a file could read others. */
const PATTERN_CHARACTERS = /[*?[\]{}]/;

/** Whether ZLens reads this file name as a table in a data folder. */
export function isDataFile(fileName: string): boolean {
  return !fileName.startsWith('.') && extname(fileName).toLowerCase() in READERS && !SETTINGS_FILES.test(fileName) && !PATTERN_CHARACTERS.test(fileName);
}

/** The data files of a folder as views, in file-name order. An unreadable folder has none. */
export function dataFolderTables(folder: string): DataFolderTable[] {
  let names: string[];
  try {
    const entries = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile());
    const projectFolder = entries.some((entry) => entry.name === 'dql.config.json');
    names = entries
      .filter((entry) => isDataFile(entry.name) && !(projectFolder && extname(entry.name).toLowerCase() === '.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const taken = new Set<string>();
  return names.map((fileName) => {
    const extension = extname(fileName).toLowerCase();
    const stem = fileName.slice(0, -extension.length).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'data';
    let name = /^[0-9]/.test(stem) ? `t_${stem}` : stem;
    // orders.csv and orders.parquet side by side: the second is orders_parquet.
    if (taken.has(name)) name = `${name}_${extension.slice(1)}`;
    for (let n = 2; taken.has(name); n += 1) name = `${name}_${n}`;
    taken.add(name);
    return { name, file: join(folder, fileName), reader: READERS[extension] };
  });
}

/** Something in a data folder that ZLens does not read as a table yet, in plain words. */
export interface DataFolderSkip {
  /** The file's name, or the folder's name ending in `/`. */
  name: string;
  /** What it is: `a Delta Lake table`, `a folder of 20 Parquet files, partitioned by year, month`. */
  kind: string;
}

/** Files of open formats ZLens recognises but does not read as a table yet. */
const NOT_READ_FILES: Record<string, string> = {
  '.xlsx': 'an Excel workbook',
  '.xls': 'an Excel workbook',
  '.avro': 'an Avro file',
  '.orc': 'an ORC file',
  '.arrow': 'an Arrow file',
  '.feather': 'an Arrow file',
  '.ducklake': 'a DuckLake catalog',
};

/** Folders a project or a tool keeps beside its data: never data themselves. */
const TOOL_FOLDERS = new Set([
  'node_modules', 'target', 'logs', 'dbt_packages', 'domains', 'notebooks', 'apps', 'skills', 'tests',
  'semantic-layer', 'blocks', 'dashboards', 'workbooks', 'dql', 'reports', 'macros', 'models', 'seeds', 'snapshots', 'analyses',
]);

/** How far, and how much, a folder is looked into to say what it holds: enough to name it, never a crawl. */
const SKIP_SCAN_DEPTH = 4;
const SKIP_SCAN_ENTRIES = 2_000;
/** Subfolders looked into, at most: a folder like Downloads is not crawled. */
const SKIP_SCAN_FOLDERS = 50;

const FORMAT_NAMES: Record<string, string> = {
  '.csv': 'CSV', '.tsv': 'TSV', '.parquet': 'Parquet', '.json': 'JSON', '.jsonl': 'JSON Lines', '.ndjson': 'JSON Lines',
  '.xlsx': 'Excel', '.xls': 'Excel', '.avro': 'Avro', '.orc': 'ORC',
};

/**
 * What a data folder holds that ZLens does not read as a table yet, and what
 * each one is: a Delta Lake or Iceberg table, a folder of (partitioned) data
 * files, an Excel workbook, a DuckLake catalog, or a data file whose name
 * DuckDB would read as a pattern. Hidden entries, a project's own folders and
 * folders with no data in them are not listed. An unreadable folder has none.
 */
export function dataFolderSkipped(folder: string): DataFolderSkip[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const skipped: DataFolderSkip[] = [];
  let foldersLookedInto = 0;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (TOOL_FOLDERS.has(entry.name.toLowerCase()) || foldersLookedInto >= SKIP_SCAN_FOLDERS) continue;
      foldersLookedInto += 1;
      const kind = describeDataSubfolder(join(folder, entry.name));
      if (kind) skipped.push({ name: `${entry.name}/`, kind });
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = extname(entry.name).toLowerCase();
    if (extension in NOT_READ_FILES) {
      skipped.push({ name: entry.name, kind: NOT_READ_FILES[extension] });
    } else if (extension in READERS && PATTERN_CHARACTERS.test(entry.name)) {
      skipped.push({ name: entry.name, kind: 'a data file whose name DuckDB would read as a pattern (it holds * ? [ ] { or })' });
    }
  }
  return skipped;
}

/** What a subfolder of a data folder is, or undefined when it holds no data. */
function describeDataSubfolder(path: string): string | undefined {
  const top = safeEntries(path);
  if (top.some((entry) => entry.isDirectory() && entry.name === '_delta_log')) return 'a Delta Lake table';
  if (top.some((entry) => entry.isDirectory() && entry.name === 'metadata')
    && safeEntries(join(path, 'metadata')).some((entry) => entry.isFile() && /\.metadata\.json(?:\.gz)?$/i.test(entry.name))) {
    return 'an Iceberg table';
  }
  // A folder of data files: count them (bounded) and read partition keys from `key=value` folder names.
  const counts = new Map<string, number>();
  const partitionKeys: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number, entries: Dirent[]): void => {
    for (const entry of entries) {
      if (seen >= SKIP_SCAN_ENTRIES || entry.name.startsWith('.')) continue;
      seen += 1;
      if (entry.isDirectory()) {
        const partition = /^([^=]+)=/.exec(entry.name)?.[1];
        if (partition && !partitionKeys.includes(partition) && depth === partitionKeys.length) partitionKeys.push(partition);
        if (depth < SKIP_SCAN_DEPTH) walk(join(dir, entry.name), depth + 1, safeEntries(join(dir, entry.name)));
      } else if (entry.isFile()) {
        const extension = extname(entry.name).toLowerCase();
        if (extension in FORMAT_NAMES) counts.set(extension, (counts.get(extension) ?? 0) + 1);
      }
    }
  };
  walk(path, 0, top);
  // JSON alone is as often settings as data: a folder of only .json files is not called data.
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0 || (counts.size === 1 && counts.has('.json'))) return undefined;
  const formats = [...new Set([...counts.keys()].map((extension) => FORMAT_NAMES[extension]))];
  const files = `${total}${seen >= SKIP_SCAN_ENTRIES ? '+' : ''} ${formats.length === 1 ? `${formats[0]} ` : 'data '}file${total === 1 ? '' : 's'}`;
  return partitionKeys.length
    ? `a folder of ${files}, partitioned by ${partitionKeys.join(', ')}`
    : `a folder of ${files}`;
}

function safeEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;
const sqlIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;

/**
 * `CREATE OR REPLACE VIEW` for a table, reading its file where it is.
 * `temporary`: the connection's own database is a real file, which the views
 * must not be written into.
 */
export function dataFolderViewStatement(table: DataFolderTable, options: { temporary?: boolean } = {}): string {
  return `CREATE OR REPLACE ${options.temporary ? 'TEMP ' : ''}VIEW ${sqlIdent(table.name)} AS SELECT * FROM ${table.reader}(${sqlText(table.file)})`;
}

export function dataFolderViewStatements(tables: DataFolderTable[], options: { temporary?: boolean } = {}): string[] {
  return tables.map((table) => dataFolderViewStatement(table, options));
}

export function dropDataFolderViewStatement(name: string): string {
  return `DROP VIEW IF EXISTS ${sqlIdent(name)}`;
}
