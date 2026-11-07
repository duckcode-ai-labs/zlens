import { existsSync, statSync } from 'node:fs';
import type { LakeSourceConfig } from './connector.js';
import {
  describeSubfolder,
  excelSheets,
  excelSheetsFromBytes,
  isUrlPath,
  listedFolderTree,
  localFolderTree,
  readFolderTree,
  tableIdentifier,
  type DataFileReader,
  type DataFolderContents,
  type DataFolderOptions,
  type DataFolderTable,
} from './data-folder.js';
import type { QueryExecutionOptions, QueryResult } from './result-types.js';

/** A statement on the connection that reads the lake (ZLens's own). */
export type LakeRun = (sql: string, options?: QueryExecutionOptions) => Promise<QueryResult>;

/** A bucket prefix is listed for at most this long: DuckDB lists every object under it. */
export const LAKE_LISTING_DEADLINE_MS = 30_000;
/** A workbook in a bucket is opened to name its sheets only up to this size. */
const WORKBOOK_BYTES = 20 * 1024 * 1024;

const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;
const trimSlash = (path: string) => path.replace(/\/+$/, '');

/** A problem with a source or a listing: what, and why, in plain words. */
export interface LakeProblem {
  source: string;
  name: string;
  reason: string;
}

/** Every object under a bucket prefix, as paths relative to it (`orders/_delta_log/0.json`). */
export async function listBucketPrefix(run: LakeRun, root: string, pattern = '**'): Promise<string[]> {
  const base = trimSlash(root);
  let result: QueryResult;
  try {
    result = await run(`SELECT file FROM glob(${sqlText(`${base}/${pattern}`)})`, { deadlineMs: LAKE_LISTING_DEADLINE_MS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/deadline|interrupt/i.test(message)) {
      throw new Error(`listing ${base}/ took longer than ${LAKE_LISTING_DEADLINE_MS / 1000} s: name its tables in "sources" instead of reading the whole folder`);
    }
    throw error;
  }
  return result.rows
    .map((row) => String(row['file'] ?? ''))
    .filter((file) => file.startsWith(`${base}/`))
    .map((file) => file.slice(base.length + 1));
}

/** The visible sheets of a workbook in a bucket, or undefined when it cannot be opened (or is larger than ZLens opens to name sheets). */
async function bucketWorkbookSheets(run: LakeRun, url: string): Promise<string[] | undefined> {
  try {
    const result = await run(`SELECT size, CASE WHEN size <= ${WORKBOOK_BYTES} THEN to_base64(content) END AS data FROM read_blob(${sqlText(url)})`, { deadlineMs: LAKE_LISTING_DEADLINE_MS });
    const data = result.rows[0]?.['data'];
    return typeof data === 'string' && data ? excelSheetsFromBytes(Buffer.from(data, 'base64')) : undefined;
  } catch {
    return undefined;
  }
}

async function bucketText(run: LakeRun, url: string): Promise<string | undefined> {
  try {
    const result = await run(`SELECT content FROM read_text(${sqlText(url)})`, { deadlineMs: LAKE_LISTING_DEADLINE_MS });
    const content = result.rows[0]?.['content'];
    return typeof content === 'string' ? content : undefined;
  } catch {
    return undefined;
  }
}

/** A bucket folder read like a folder on disk (`readDataFolder`), from one listing of its prefix. */
export async function readBucketFolder(run: LakeRun, root: string, options: DataFolderOptions = {}): Promise<DataFolderContents> {
  const base = trimSlash(root);
  const files = await listBucketPrefix(run, base);
  const texts: Record<string, string> = {};
  for (const file of files.filter((path) => /^[^/]+\/metadata\/version-hint\.text$/.test(path)).slice(0, 50)) {
    const text = await bucketText(run, `${base}/${file}`);
    if (text !== undefined) texts[file] = text;
  }
  const sheets: Record<string, string[] | undefined> = {};
  for (const file of files.filter((path) => !path.includes('/') && /\.xlsx$/i.test(path)).slice(0, 20)) {
    sheets[file] = await bucketWorkbookSheets(run, `${base}/${file}`);
  }
  return readFolderTree(listedFolderTree(base, files, { texts, sheets }), options);
}

const FILE_READERS: Record<string, DataFileReader> = {
  '.csv': 'read_csv_auto', '.tsv': 'read_csv_auto', '.parquet': 'read_parquet',
  '.json': 'read_json_auto', '.jsonl': 'read_json_auto', '.ndjson': 'read_json_auto',
};
const FORMAT_LABELS: Record<string, string> = { '.csv': 'CSV', '.tsv': 'TSV', '.parquet': 'Parquet', '.json': 'JSON', '.jsonl': 'JSON Lines', '.ndjson': 'JSON Lines' };
const FORMAT_READERS: Record<string, { reader: DataFileReader; extension: string; label: string }> = {
  parquet: { reader: 'read_parquet', extension: '.parquet', label: 'Parquet' },
  csv: { reader: 'read_csv_auto', extension: '.csv', label: 'CSV' },
  json: { reader: 'read_json_auto', extension: '.json', label: 'JSON' },
};

/** The last part of a path, without a pattern, an extension or a trailing slash: the default table name. */
function sourceStem(path: string): string {
  const parts = trimSlash(path.replace(/\\/g, '/').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')).split('/').filter(Boolean);
  while (parts.length > 1 && /[*?[\]{}]/.test(parts[parts.length - 1])) parts.pop();
  return (parts[parts.length - 1] ?? 'data').replace(/\.(?:csv|tsv|parquet|json|jsonl|ndjson|xlsx)$/i, '');
}

const extensionOf = (path: string) => /(\.[a-z0-9]+)$/i.exec(path.replace(/[?#].*$/, ''))?.[1]?.toLowerCase() ?? '';

/**
 * A connection's sources as tables, in order: each named (`name`, else the
 * last part of its path), a later one of the same name numbered. What a
 * source is comes from its `format`, or from its path: a data file, a
 * workbook, or a folder holding a Delta or Iceberg table or data files.
 * A source that cannot be read is a problem with the reason; the others work.
 */
export async function resolveLakeSources(
  run: LakeRun,
  sources: LakeSourceConfig[],
): Promise<{ tables: DataFolderTable[]; problems: LakeProblem[] }> {
  const tables: DataFolderTable[] = [];
  const problems: LakeProblem[] = [];
  const taken = new Set<string>();
  for (const source of sources) {
    const path = String(source.path ?? '').trim();
    const shown = path || '(no path)';
    let name = tableIdentifier(source.name?.trim() || sourceStem(path));
    for (let n = 2; taken.has(name); n += 1) name = `${tableIdentifier(source.name?.trim() || sourceStem(path))}_${n}`;
    taken.add(name);
    try {
      if (!path) throw new Error('a source needs a path');
      const table = await sourceTable(run, path, source);
      tables.push({ name, source: path, ...table });
    } catch (error) {
      problems.push({ source: shown, name, reason: (error instanceof Error ? error.message : String(error)).split('\n')[0] });
    }
  }
  return { tables, problems };
}

async function sourceTable(run: LakeRun, path: string, source: LakeSourceConfig): Promise<Omit<DataFolderTable, 'name' | 'source'>> {
  const remote = isUrlPath(path);
  const format = source.format ?? 'auto';
  const location = trimSlash(path) || path;
  const pattern = /[*?[\]{}]/.test(path);
  const extension = extensionOf(pattern ? path.split('/').pop() ?? '' : path);
  if (!remote && !pattern && !existsSync(location)) throw new Error(`${path} does not exist`);
  const isFolder = !pattern && (remote ? !extension : statSync(location).isDirectory());

  if (format === 'delta') return { file: location, reader: 'delta_scan', kind: 'Delta Lake table' };
  if (format === 'excel' || (format === 'auto' && extension === '.xlsx')) {
    const sheets = source.sheet ? undefined : remote ? await bucketWorkbookSheets(run, location) : excelSheets(location);
    const sheet = source.sheet ?? sheets?.[0];
    return { file: location, reader: 'read_xlsx', ...(sheet !== undefined ? { sheet } : {}), kind: sheet !== undefined ? `Excel sheet "${sheet}"` : 'Excel workbook (first sheet)' };
  }
  const named = FORMAT_READERS[format];
  if (named) {
    if (isFolder) return { file: `${location}/**/*${named.extension}`, reader: named.reader, folder: { partitioned: false }, kind: `${named.label} files` };
    return { file: path, reader: named.reader, ...(pattern ? { folder: { partitioned: false } } : {}), kind: pattern ? `${named.label} files` : `${named.label} file` };
  }
  if (format === 'auto' && !isFolder) {
    const reader = FILE_READERS[extension];
    if (!reader) throw new Error(`ZLens cannot tell what ${path} holds: say its "format" (parquet, csv, json, excel, delta or iceberg)`);
    const label = FORMAT_LABELS[extension] ?? extension.slice(1).toUpperCase();
    return { file: path, reader, ...(pattern ? { folder: { partitioned: false } } : {}), kind: pattern ? `${label} files` : `${label} file` };
  }

  // A folder (or format "iceberg"): what it holds, from its listing.
  const tree = remote ? await bucketTree(run, location, format) : localFolderTree(location);
  const found = describeSubfolder(tree, '');
  if (format === 'iceberg' && (!found || !('reader' in found) || found.reader !== 'iceberg_scan')) {
    throw new Error(`no Iceberg metadata in ${location}/metadata/`);
  }
  if (!found) throw new Error(`${path} holds no data ZLens reads`);
  if ('skip' in found) throw new Error(`${path} is ${found.skip}`);
  return found;
}

/** What a bucket folder holds, listed as cheaply as it can be: its Delta log, else its Iceberg metadata, else all of it. */
async function bucketTree(run: LakeRun, location: string, format: string) {
  if (format !== 'iceberg') {
    const log = await listBucketPrefix(run, location, '_delta_log/*.json');
    if (log.length) return listedFolderTree(location, log);
  }
  const metadata = (await listBucketPrefix(run, location, 'metadata/*')).filter((file) => !file.slice('metadata/'.length).includes('/'));
  if (metadata.some((file) => /\.metadata\.json$/i.test(file))) {
    const texts: Record<string, string> = {};
    if (metadata.includes('metadata/version-hint.text')) {
      const hint = await bucketText(run, `${location}/metadata/version-hint.text`);
      if (hint !== undefined) texts['metadata/version-hint.text'] = hint;
    }
    return listedFolderTree(location, metadata, { texts });
  }
  if (format === 'iceberg') return listedFolderTree(location, []);
  return listedFolderTree(location, await listBucketPrefix(run, location));
}
