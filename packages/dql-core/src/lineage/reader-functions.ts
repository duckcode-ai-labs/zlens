/**
 * DuckDB table functions that read data where it lies: a file, a pattern of
 * files, a Delta Lake or Iceberg table folder, an Excel workbook. Lineage
 * names each read by what it reads, so `read_parquet('./data/events/**\/*.parquet')`,
 * `delta_scan('s3://lake/customers')` and `read_xlsx('./data/targets.xlsx', sheet = 'Q1')`
 * are the tables `events`, `customers` and `targets`.
 */
export const READER_FUNCTIONS = [
  'read_csv_auto',
  'read_csv',
  'read_parquet',
  'parquet_scan',
  'read_json_auto',
  'read_json',
  'read_ndjson_auto',
  'read_ndjson',
  'read_xlsx',
  'delta_scan',
  'iceberg_scan',
] as const;

const READER_SET = new Set<string>(READER_FUNCTIONS);
const READER_NAMES = READER_FUNCTIONS.join('|');

/** Whether a name is a reader function (never a table). */
export function isReaderFunction(name: string): boolean {
  return READER_SET.has(name.toLowerCase());
}

/**
 * The reads in SQL, one per path, as `reader('path')`: options are left out,
 * and a list of paths (`read_parquet(['a.parquet', 'b.parquet'])`) gives one
 * read per path. Comments must already be removed; string literals not.
 */
export function extractReaderCalls(sql: string): string[] {
  const calls: string[] = [];
  const pattern = new RegExp(`\\b(${READER_NAMES})\\s*\\(\\s*(?:'([^']*)'|"([^"]*)"|\\[([^\\]]*)\\])`, 'gi');
  for (const match of sql.matchAll(pattern)) {
    const reader = match[1].toLowerCase();
    const paths = match[4] !== undefined
      ? [...match[4].matchAll(/'([^']*)'|"([^"]*)"/g)].map((item) => item[1] ?? item[2])
      : [match[2] ?? match[3]];
    for (const path of paths) {
      if (path) calls.push(`${reader}('${path}')`);
    }
  }
  return calls;
}

/**
 * A read's table name: the last named part of its path, without the folders
 * a pattern, a partition (`year=2025`) or an Iceberg metadata file adds, and
 * without the file's extension. Anything that is not a read is returned as it is.
 */
export function readerTableName(name: string): string {
  const match = new RegExp(`^(?:${READER_NAMES})\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)$`, 'i').exec(name);
  return match ? tableNameOfPath(match[1]) : name;
}

function tableNameOfPath(path: string): string {
  const parts = path
    .replace(/\\/g, '/')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..');
  // `events/**/*.parquet` → `events`
  while (parts.length > 1 && /[*?[\]{}]/.test(parts[parts.length - 1])) parts.pop();
  // `orders/metadata/00003-….metadata.json` → `orders`
  if (parts.length > 2 && parts[parts.length - 2].toLowerCase() === 'metadata' && /\.metadata\.json$/i.test(parts[parts.length - 1])) {
    parts.splice(-2, 2);
  }
  // `events/year=2025/month=1` → `events`
  while (parts.length > 1 && /^[^=]+=/.test(parts[parts.length - 1])) parts.pop();
  const last = parts[parts.length - 1] ?? path;
  return last.replace(/\.(?:csv|tsv|parquet|json|jsonl|ndjson|xlsx)(?:\.(?:gz|zst))?$/i, '');
}
