/**
 * Lake table sizes from metadata (open-formats plan L4, decision L4-1).
 *
 * `zlens sync warehouse` records how large each lake table is: its rows, its
 * bytes where it is stored, and each column's bytes, so that ZLens's own
 * checks can tell what a statement would read before reading it (see
 * `read-budget.ts`). Nothing here reads table data:
 *
 * - a view over files (a data folder, a bucket, a named source) from its
 *   listing and the footers of at most 16 files spread across it (every
 *   footer when it has 64 files or fewer, so its rows are exact);
 * - an Iceberg table's rows from its manifests; a DuckLake table's bytes from
 *   its catalog; a Delta or Unity Catalog table's rows from `COUNT(*)`, which
 *   DuckDB answers from the table's log.
 *
 * Tables in the DuckDB file itself, or in an attached DuckDB or SQLite file,
 * are not sized: reading them costs no download, and they run as before.
 */
import type { WarehouseCatalogRelationV1 } from '@zlens/core';

type Row = Record<string, unknown>;
export type LakeSizeRun = (sql: string) => Promise<Row[]>;

/** Readers whose files are read column by column; any other reads whole files. */
const COLUMNAR_READERS = new Set(['read_parquet', 'parquet_scan']);
/** Readers over plain files, which a sample of files can stand in for. */
const FILE_READERS = new Set([
  'read_parquet', 'parquet_scan',
  'read_csv', 'read_csv_auto',
  'read_json', 'read_json_auto', 'read_ndjson', 'read_ndjson_auto', 'read_json_objects',
]);
/** Footers read when a view has more files than `ALL_FOOTERS_UP_TO`. */
export const SIZE_FOOTER_SAMPLE = 16;
/** Up to this many files, every footer is read and the row count is exact. */
export const ALL_FOOTERS_UP_TO = 64;
/** How long sizing may take, all tables together, before the rest are left unsized. */
export const SIZE_TIME_LIMIT_MS = 120_000;

/** A data view's reader call, as the view's SQL writes it. */
export interface LakeReaderCall {
  /** `read_parquet`, `read_csv`, `iceberg_scan`, … (lower case). */
  reader: string;
  /** The first argument as written: a quoted path or pattern, or a list of them. */
  pathSql: string;
  /** Every argument after the first, as written, with its leading comma (`, (hive_partitioning = …)`), or ''. */
  optionsSql: string;
  /** Reads files column by column (Parquet): a statement reads only the columns it names. */
  columnar: boolean;
  /** Reads plain files, so whole files can stand in for the table in a sample. */
  files: boolean;
  /** Its data is reached over the network (a bucket or a URL), not on this machine's disk. */
  remote: boolean;
}

const QUOTED = String.raw`'(?:[^']|'')*'`;
const LIST = String.raw`\[(?:[^\]']|${QUOTED})*\]`;
const READER_VIEW = new RegExp(String.raw`\bAS\s+SELECT\s+\*\s+FROM\s+([a-z_][a-z0-9_]*)\s*\(\s*(${QUOTED}|${LIST})\s*((?:,[\s\S]*)?)\)\s*;?\s*$`, 'i');

/** Whether a path is reached over the network: `s3://`, `gs://`, `az://`, `https://`, `hf://`, … */
export function isRemotePath(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(path.trim()) && !/^file:\/\//i.test(path.trim());
}

/** The paths an argument names: one quoted path, or each in a list. */
export function pathsOf(pathSql: string): string[] {
  return [...pathSql.matchAll(new RegExp(QUOTED, 'g'))].map((match) => match[0].slice(1, -1).replace(/''/g, "'"));
}

/** The reader call of a view that only reads files or a table format (`SELECT * FROM read_parquet(…)`), else undefined. */
export function lakeReaderCall(viewSql: string | undefined): LakeReaderCall | undefined {
  if (!viewSql) return undefined;
  const match = READER_VIEW.exec(viewSql.trim());
  if (!match) return undefined;
  const reader = match[1]!.toLowerCase();
  if (!FILE_READERS.has(reader) && !['iceberg_scan', 'delta_scan', 'read_xlsx'].includes(reader)) return undefined;
  const pathSql = match[2]!;
  return {
    reader,
    pathSql,
    optionsSql: match[3]?.trim() ?? '',
    columnar: COLUMNAR_READERS.has(reader),
    files: FILE_READERS.has(reader),
    remote: pathsOf(pathSql).some(isRemotePath),
  };
}

/** A SQL string literal. */
export const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
/** A list of paths as a DuckDB list literal. */
export const sqlPathList = (paths: string[]) => `[${paths.map(sqlLiteral).join(', ')}]`;

/**
 * Indices `0 … n-1` in an order that spreads out: every prefix is spread across
 * the whole range (van der Corput), so a smaller sample is the start of a
 * larger one and both reach from the first files to the last.
 */
export function spreadOrder(n: number): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; order.length < n && i < n * 64; i += 1) {
    let x = 0;
    let denominator = 1;
    for (let k = i; k > 0; k = Math.floor(k / 2)) {
      denominator *= 2;
      x += (k % 2) / denominator;
    }
    const index = Math.min(n - 1, Math.floor(x * n));
    if (!seen.has(index)) {
      seen.add(index);
      order.push(index);
    }
  }
  for (let index = 0; index < n; index += 1) if (!seen.has(index)) order.push(index);
  return order;
}

export interface LakeFile { file: string; size: number }

/** The files a reader call reads, with their sizes, from one listing (no file is opened). */
export async function listLakeFiles(call: Pick<LakeReaderCall, 'pathSql'>, run: LakeSizeRun): Promise<LakeFile[]> {
  const rows = await run(`SELECT filename AS file, size FROM read_blob(${call.pathSql}) ORDER BY filename`);
  return rows.map((row) => ({ file: String(row.file ?? row.FILE), size: Number(row.size ?? row.SIZE) || 0 }));
}

export interface LakeSize {
  rows?: number;
  bytes?: number;
  /** Bytes per column, by the column's name as the files spell it. */
  columns?: Record<string, number>;
  from: string;
}

const count = (value: number) => value.toLocaleString('en-US');

/** A view over files: its listing, and the footers of all its files or of 16 spread across them. */
export async function fileViewSize(call: LakeReaderCall, run: LakeSizeRun): Promise<LakeSize | undefined> {
  const files = await listLakeFiles(call, run);
  if (files.length === 0) return undefined;
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (!call.columnar) {
    return { bytes, from: `listing of ${count(files.length)} file${files.length === 1 ? '' : 's'}` };
  }
  const every = files.length <= ALL_FOOTERS_UP_TO;
  const picked = every ? files : spreadOrder(files.length).slice(0, SIZE_FOOTER_SAMPLE).sort((a, b) => a - b).map((index) => files[index]!);
  const pickedBytes = picked.reduce((sum, file) => sum + file.size, 0);
  const list = sqlPathList(picked.map((file) => file.file));
  const [rowsRow] = await run(`SELECT sum(num_rows) AS row_count FROM parquet_file_metadata(${list})`);
  const columnRows = await run(`SELECT split_part(path_in_schema, ', ', 1) AS column_name, sum(total_compressed_size) AS bytes FROM parquet_metadata(${list}) GROUP BY 1`);
  // A sample stands for the whole by bytes: rows and column bytes scale with the files' sizes.
  const scale = every || pickedBytes <= 0 ? 1 : bytes / pickedBytes;
  const sampledRows = Number(rowsRow?.row_count ?? rowsRow?.ROW_COUNT);
  const columns: Record<string, number> = {};
  for (const row of columnRows) {
    const name = String(row.column_name ?? row.COLUMN_NAME ?? '');
    const value = Number(row.bytes ?? row.BYTES);
    if (name && Number.isFinite(value)) columns[name] = Math.round(value * scale);
  }
  return {
    ...(Number.isFinite(sampledRows) ? { rows: Math.round(sampledRows * scale) } : {}),
    bytes,
    columns,
    from: every
      ? `footers of all ${count(files.length)} file${files.length === 1 ? '' : 's'}`
      : `footers of ${picked.length} of ${count(files.length)} files (estimated)`,
  };
}

/** An Iceberg table's rows from its manifests: data files' rows less position deletes. */
async function icebergRows(target: string, run: LakeSizeRun): Promise<LakeSize | undefined> {
  const rows = await run(`SELECT manifest_content, sum(record_count) AS row_count FROM iceberg_metadata(${target}) WHERE status <> 'DELETED' GROUP BY 1`);
  let data = 0;
  let deleted = 0;
  for (const row of rows) {
    const content = String(row.manifest_content ?? row.MANIFEST_CONTENT ?? '').toUpperCase();
    const value = Number(row.row_count ?? row.ROW_COUNT) || 0;
    if (content === 'DATA') data += value;
    else deleted += value;
  }
  return { rows: Math.max(0, data - deleted), from: deleted ? 'Iceberg manifests (rows less deletes, estimated)' : 'Iceberg manifests' };
}

async function countRows(target: string, run: LakeSizeRun, from: string): Promise<LakeSize | undefined> {
  const [row] = await run(`SELECT count(*) AS row_count FROM ${target}`);
  const rows = Number(row?.row_count ?? row?.ROW_COUNT);
  return Number.isFinite(rows) ? { rows, from } : undefined;
}

/** The kind of each attached database (`iceberg`, `ducklake`, `unity_catalog`, `duckdb`, …), by name. */
export async function attachedDatabaseTypes(run: LakeSizeRun): Promise<Map<string, string>> {
  const rows = await run('SELECT database_name, type FROM duckdb_databases()');
  return new Map(rows.map((row) => [String(row.database_name ?? row.DATABASE_NAME).toLowerCase(), String(row.type ?? row.TYPE ?? '').toLowerCase()]));
}

const ident = (value: string) => `"${value.replace(/"/g, '""')}"`;

/**
 * The size of one relation from metadata, or undefined when it is not a lake
 * table (a table in a DuckDB or SQLite file) or its metadata cannot say.
 */
export async function lakeRelationSize(
  relation: WarehouseCatalogRelationV1,
  run: LakeSizeRun,
  databaseTypes: Map<string, string>,
  ducklakeBytes?: (database: string) => Promise<Map<string, number>>,
): Promise<LakeSize | undefined> {
  const call = lakeReaderCall(relation.viewSql);
  if (call) {
    if (call.files) return fileViewSize(call, run);
    if (call.reader === 'iceberg_scan') return icebergRows(`${call.pathSql}${call.optionsSql}`, run);
    if (call.reader === 'delta_scan') return countRows(`delta_scan(${call.pathSql})`, run, 'the Delta log');
    return undefined;
  }
  if (relation.kind !== 'table' || !relation.database) return undefined;
  const type = databaseTypes.get(relation.database.toLowerCase());
  const target = [relation.database, relation.schema, relation.name].filter((part): part is string => Boolean(part)).map(ident).join('.');
  if (type === 'iceberg') return icebergRows(target, run);
  if (type === 'unity_catalog' || type === 'uc_catalog' || type === 'delta') return countRows(target, run, 'the Delta log');
  if (type === 'ducklake') {
    const bytes = (await ducklakeBytes?.(relation.database))?.get(relation.name.toLowerCase());
    if (relation.rowCountEstimate === undefined && bytes === undefined) return undefined;
    return { ...(relation.rowCountEstimate !== undefined ? { rows: relation.rowCountEstimate } : {}), ...(bytes !== undefined ? { bytes } : {}), from: 'the DuckLake catalog' };
  }
  return undefined;
}

/** Write a size onto a relation: rows, bytes, each column's bytes, and where they came from. */
export function applyLakeSize(relation: WarehouseCatalogRelationV1, size: LakeSize): void {
  if (size.rows !== undefined) relation.rowCountEstimate = size.rows;
  if (size.bytes !== undefined) relation.bytesEstimate = size.bytes;
  relation.sizeFrom = size.from;
  if (!size.columns) return;
  const byName = new Map(Object.entries(size.columns).map(([name, bytes]) => [name.toLowerCase(), bytes]));
  for (const column of relation.columns) {
    const bytes = byName.get(column.name.toLowerCase());
    if (bytes !== undefined) column.bytesEstimate = bytes;
  }
}

/**
 * Size every lake relation of a DuckDB (or file) connection's catalog, in
 * place. Each relation that cannot be sized is left as it was; past the time
 * limit the rest are left unsized and named.
 */
export async function addLakeSizes(
  relations: WarehouseCatalogRelationV1[],
  run: LakeSizeRun,
  options: { timeLimitMs?: number; now?: () => number } = {},
): Promise<{ sized: number; notSized: string[]; timedOut: number }> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeLimitMs ?? SIZE_TIME_LIMIT_MS);
  let databaseTypes = new Map<string, string>();
  try { databaseTypes = await attachedDatabaseTypes(run); } catch { /* no attached catalogs to size */ }
  const ducklake = new Map<string, Promise<Map<string, number>>>();
  const ducklakeBytes = (database: string) => {
    if (!ducklake.has(database)) {
      ducklake.set(database, run(`SELECT table_name, sum(file_size_bytes) AS bytes FROM ducklake_table_info(${sqlLiteral(database)}) GROUP BY 1`)
        .then((rows) => new Map(rows.map((row) => [String(row.table_name ?? row.TABLE_NAME).toLowerCase(), Number(row.bytes ?? row.BYTES) || 0])))
        .catch(() => new Map()));
    }
    return ducklake.get(database)!;
  };
  let sized = 0;
  let timedOut = 0;
  const notSized: string[] = [];
  for (const relation of relations) {
    const lake = Boolean(lakeReaderCall(relation.viewSql)) || (relation.kind === 'table' && Boolean(relation.database) && ['iceberg', 'ducklake', 'unity_catalog', 'uc_catalog', 'delta'].includes(databaseTypes.get(relation.database!.toLowerCase()) ?? ''));
    if (!lake) continue;
    if (now() > deadline) {
      timedOut += 1;
      continue;
    }
    try {
      const size = await lakeRelationSize(relation, run, databaseTypes, ducklakeBytes);
      if (size) {
        applyLakeSize(relation, size);
        sized += 1;
      } else {
        notSized.push(relation.relation);
      }
    } catch {
      notSized.push(relation.relation);
    }
  }
  return { sized, notSized, timedOut };
}

/** Bytes in words: `about 1.5 TB`, `239 GB`, `48 MB`. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** Rows in words: `3.7 billion`, `14 million`, `5,000`. */
export function formatRows(rows: number): string {
  if (rows >= 1e9) return `${(rows / 1e9).toFixed(rows >= 1e10 ? 0 : 1)} billion`;
  if (rows >= 1e6) return `${(rows / 1e6).toFixed(rows >= 1e7 ? 0 : 1)} million`;
  return count(Math.round(rows));
}
