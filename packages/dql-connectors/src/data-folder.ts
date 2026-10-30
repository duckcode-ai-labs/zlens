import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * A folder of data files read as a database (a file connection's
 * `dataFolder`): each CSV, TSV, Parquet or JSON file in it is one view, named
 * after the file. Hidden files and subfolders are not read.
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
const SETTINGS_FILES = /^(?:dql\.config|package|package-lock|npm-shrinkwrap|tsconfig(?:\..+)?|jsconfig|.+\.config)\.json$/i;

/** Whether ZLens reads this file name as a table in a data folder. */
export function isDataFile(fileName: string): boolean {
  return !fileName.startsWith('.') && extname(fileName).toLowerCase() in READERS && !SETTINGS_FILES.test(fileName);
}

/** The data files of a folder as views, in file-name order. An unreadable folder has none. */
export function dataFolderTables(folder: string): DataFolderTable[] {
  let names: string[];
  try {
    names = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile() && isDataFile(entry.name)).map((entry) => entry.name).sort();
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

/** `CREATE OR REPLACE VIEW` for each table, reading its file where it is. */
export function dataFolderViewStatements(tables: DataFolderTable[]): string[] {
  const text = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const ident = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return tables.map((table) => `CREATE OR REPLACE VIEW ${ident(table.name)} AS SELECT * FROM ${table.reader}(${text(table.file)})`);
}
