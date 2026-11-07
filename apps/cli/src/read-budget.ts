/**
 * A read budget for the statements ZLens runs on its own (open-formats plan
 * L4, decisions L4-2 to L4-4): the model draft's checks today; dataset
 * import, value profiles and Ask's join check next.
 *
 * Before a statement runs, what it would read is estimated from the sizes
 * `zlens sync warehouse` recorded (`lake-sizes.ts`): for each lake table it
 * names, the bytes of the columns it names (a Parquet file is read column by
 * column; a CSV or JSON file is read whole; `COUNT(*)` alone reads only
 * metadata). Within the budget it runs as written. Over the budget:
 *
 * - a table read from files is read from a sample of whole files spread
 *   across its listing, as many as fit the budget, and the run says so;
 * - a table looked up by a check (any table but the statement's subject, when
 *   it names several) is never sampled, since a sample there would call real
 *   references missing: the check is skipped and says why;
 * - a table that cannot be sampled (a catalog table) is not read.
 *
 * Tables with no recorded size (a warehouse's, a DuckDB file's own) run
 * exactly as before.
 */
import { parsePhysicalIdentifier, type WarehouseCatalogColumnV1, type WarehouseCatalogRelationV1, type WarehouseCatalogSnapshotV1 } from '@zlens/core';
import { formatBytes, formatRows, lakeReaderCall, listLakeFiles, spreadOrder, sqlPathList, type LakeFile, type LakeReaderCall } from './lake-sizes.js';

type Rows = { rows: Array<Record<string, unknown>> };
type Run = (sql: string) => Promise<Rows>;

/** The statement's subject: the tables it may read from a sample (a check's other tables are read whole). */
export interface ReadHint {
  sample?: string[];
}
export type BoundedRun = (sql: string, hint?: ReadHint) => Promise<Rows>;

/** Per table per statement: a table read over the network, and one on this machine's disk. */
export const DEFAULT_READ_BUDGET = { remote: 256e6, local: 4e9 };

/** The budget in force: `ZLENS_READ_BUDGET_MB` sets both (for tests and very large lakes). */
export function readBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): { remote: number; local: number } {
  const mb = Number(env.ZLENS_READ_BUDGET_MB);
  return Number.isFinite(mb) && mb > 0 ? { remote: mb * 1e6, local: mb * 1e6 } : DEFAULT_READ_BUDGET;
}

export class ReadBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadBudgetError';
  }
}

export interface ReadNote {
  relation: string;
  kind: 'sampled' | 'skipped';
  /** Plain words, for a person reading the draft. */
  text: string;
}

/** Bytes a column of this type takes per row when nothing better is known (a catalog table with rows only). */
function typeWidth(type: string | undefined): number {
  const value = (type ?? '').toLowerCase();
  if (/bool|tinyint/.test(value)) return 1;
  if (/smallint/.test(value)) return 2;
  if (/^(int|integer|date|float|real)\b/.test(value)) return 4;
  if (/bigint|double|decimal|numeric|timestamp|time/.test(value)) return 8;
  if (/uuid|hugeint/.test(value)) return 16;
  return 24;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where a relation is named in a statement: each part bare or double-quoted, any case. */
function relationPattern(relation: string): RegExp {
  const parts = parsePhysicalIdentifier(relation).map((part) => part.value);
  const body = parts.map((part) => `(?:"${escapeRegex(part.replace(/"/g, '""'))}"|${escapeRegex(part)})`).join(String.raw`\s*\.\s*`);
  return new RegExp(String.raw`(?<![\w."])${body}(?![\w"])`, 'gi');
}

/** Whether a statement names a column (bare or quoted, any case). */
function namesColumn(sql: string, column: string): boolean {
  return new RegExp(String.raw`(?<![\w"])(?:"${escapeRegex(column.replace(/"/g, '""'))}"|${escapeRegex(column)})(?![\w"])`, 'i').test(sql);
}

interface Sized {
  relation: WarehouseCatalogRelationV1;
  call?: LakeReaderCall;
  remote: boolean;
  pattern: RegExp;
}

/**
 * The columns a statement reads of a table: those it names, or all of them
 * when it selects `*` straight from the table (a `*` over a `WITH` result or a
 * subquery reads only what those name).
 */
function columnsRead(sql: string, item: Pick<Sized, 'relation' | 'pattern'>): WarehouseCatalogColumnV1[] {
  const star = new RegExp(String.raw`select\s+(?:distinct\s+)?\*\s+from\s+${item.pattern.source}`, 'i');
  if (star.test(sql)) return item.relation.columns;
  return item.relation.columns.filter((column) => namesColumn(sql, column.name));
}

/** Bytes a statement reads of a table, from its recorded sizes. */
export function estimateRead(relation: WarehouseCatalogRelationV1, columns: WarehouseCatalogColumnV1[], call?: LakeReaderCall): number {
  if (columns.length === 0) return 0;
  const total = relation.bytesEstimate;
  // A CSV or JSON file is read whole, whichever columns are named.
  if (call && !call.columnar && total !== undefined) return total;
  if (relation.columns.some((column) => column.bytesEstimate !== undefined)) {
    return columns.reduce((sum, column) => sum + (column.bytesEstimate ?? 0), 0);
  }
  if (total !== undefined && relation.columns.length > 0) return total * (columns.length / relation.columns.length);
  if (relation.rowCountEstimate !== undefined) return columns.reduce((sum, column) => sum + relation.rowCountEstimate! * typeWidth(column.type), 0);
  return 0;
}

/**
 * A runner for ZLens's own statements that keeps each table it reads within
 * the budget. `notes()` lists what was read from a sample and what was skipped.
 */
export function boundedReads(input: {
  run: Run;
  snapshot: Pick<WarehouseCatalogSnapshotV1, 'relations'> | undefined;
  budget?: { remote: number; local: number };
}): { run: BoundedRun; notes: () => ReadNote[]; sampled: () => Map<string, string> } {
  const budget = input.budget ?? readBudgetFromEnv();
  const sized: Sized[] = (input.snapshot?.relations ?? [])
    .filter((relation) => relation.sizeFrom !== undefined)
    .map((relation) => {
      const call = lakeReaderCall(relation.viewSql);
      // A catalog table's data is in the catalog's storage: counted as remote.
      return { relation, ...(call ? { call } : {}), remote: call ? call.remote : true, pattern: relationPattern(relation.relation) };
    });
  // Per table: its largest sample, and the checks skipped, by reason.
  const tallies = new Map<string, Tally>();
  const tally = (item: Sized): Tally => {
    const key = item.relation.relation;
    if (!tallies.has(key)) tallies.set(key, { relation: key, name: item.relation.name, remote: item.remote, skipped: new Map() });
    return tallies.get(key)!;
  };
  const listings = new Map<string, Promise<LakeFile[]>>();
  const listing = (item: Sized) => {
    if (!listings.has(item.relation.relation)) {
      listings.set(item.relation.relation, listLakeFiles(item.call!, async (sql) => (await input.run(sql)).rows));
    }
    return listings.get(item.relation.relation)!;
  };

  const skip = (item: Sized, reason: SkipReason, reads: number, what: string, limit: number, message: string): never => {
    const entry = tally(item);
    const previous = entry.skipped.get(reason);
    entry.skipped.set(reason, {
      checks: (previous?.checks ?? 0) + 1,
      largest: Math.max(previous?.largest ?? 0, reads),
      what: !previous || reads > previous.largest ? what : previous.what,
      limit,
    });
    throw new ReadBudgetError(message);
  };

  const run: BoundedRun = async (sql, hint) => {
    if (sized.length === 0) return input.run(sql);
    const named = sized.filter((item) => {
      item.pattern.lastIndex = 0;
      return item.pattern.test(sql);
    });
    if (named.length === 0) return input.run(sql);
    const subjects = new Set((hint?.sample ?? []).map((relation) => relation.toLowerCase()));
    let rewritten = sql;
    for (const item of named) {
      const columns = columnsRead(sql, item);
      const reads = estimateRead(item.relation, columns, item.call);
      const limit = item.remote ? budget.remote : budget.local;
      if (reads <= limit) continue;
      const name = item.relation.name;
      const what = `${columns.slice(0, 4).map((column) => column.name).join(', ')}${columns.length > 4 ? ', …' : ''}`;
      const over = `about ${formatBytes(reads)} of ${name} (${what}); ZLens reads at most ${formatBytes(limit)} of a ${item.remote ? 'remote' : 'local'} table per check`;
      const maySample = named.length === 1 || subjects.has(item.relation.relation.toLowerCase());
      if (!maySample) skip(item, 'lookup', reads, what, limit, `${name} is looked up whole here, and that reads ${over}`);
      if (!item.call?.files) skip(item, 'unsampled', reads, what, limit, `${name} cannot be sampled by file, and reading it reads ${over}`);
      const call = item.call!;
      const files = await listing(item);
      const total = files.reduce((sum, file) => sum + file.size, 0);
      // Each file costs its share of the columns read: all of it for CSV or JSON.
      const share = total > 0 ? Math.min(1, reads / total) : 1;
      const picked: LakeFile[] = [];
      let cost = 0;
      for (const index of spreadOrder(files.length)) {
        const file = files[index]!;
        if (cost + file.size * share > limit) {
          if (picked.length > 0) break;
          continue;
        }
        picked.push(file);
        cost += file.size * share;
      }
      if (picked.length === 0) skip(item, 'no_file_fits', reads, what, limit, `even one file of ${name} holds more than a check may read: reading it reads ${over}`);
      picked.sort((a, b) => a.file.localeCompare(b.file));
      const pickedBytes = picked.reduce((sum, file) => sum + file.size, 0);
      const entry = tally(item);
      if (!entry.sampled || picked.length > entry.sampled.files) {
        const rows = item.relation.rowCountEstimate;
        entry.sampled = { files: picked.length, of: files.length, ...(rows !== undefined && total > 0 ? { rows: rows * (pickedBytes / total), total: rows } : {}) };
      }
      const sample = `(SELECT * FROM ${call.reader}(${sqlPathList(picked.map((file) => file.file))}${call.optionsSql}))`;
      item.pattern.lastIndex = 0;
      rewritten = rewritten.replace(item.pattern, sample);
    }
    return input.run(rewritten);
  };
  return {
    run,
    notes: () => [...tallies.values()].sort((a, b) => a.name.localeCompare(b.name)).flatMap(notesOf),
    sampled: () => new Map([...tallies.values()].filter((entry) => entry.sampled).map((entry) => [entry.relation, sampleWords(entry)])),
  };
}

type SkipReason = 'lookup' | 'unsampled' | 'no_file_fits';
interface Tally {
  relation: string;
  name: string;
  remote: boolean;
  sampled?: { files: number; of: number; rows?: number; total?: number };
  skipped: Map<SkipReason, { checks: number; largest: number; what: string; limit: number }>;
}

/** `a sample of lineitem: 14 of 24 files, about 17 million of 30 million rows`. */
function sampleWords(entry: Tally): string {
  const { files, of, rows, total } = entry.sampled!;
  const count = (value: number) => value.toLocaleString('en-US');
  return `a sample of ${entry.name}: ${count(files)} of ${count(of)} files${rows !== undefined && total !== undefined ? `, about ${formatRows(rows)} of ${formatRows(total)} rows` : ''}`;
}

/** A table's notes in plain words: what was read of it, then each kind of check skipped. */
function notesOf(entry: Tally): ReadNote[] {
  const notes: ReadNote[] = [];
  const count = (value: number) => value.toLocaleString('en-US');
  if (entry.sampled) {
    const { files, of, rows, total } = entry.sampled;
    const rowText = rows !== undefined && total !== undefined ? `, about ${formatRows(rows)} of ${formatRows(total)} rows` : '';
    notes.push({ relation: entry.relation, kind: 'sampled', text: `${entry.name}: checked on ${count(files)} of ${count(of)} files spread across it${rowText}. What the draft says of it holds in that sample.` });
  }
  for (const [reason, item] of entry.skipped) {
    const checks = `${count(item.checks)} check${item.checks === 1 ? '' : 's'}`;
    const limit = `${formatBytes(item.limit)} of a ${entry.remote ? 'remote' : 'local'} table`;
    const reads = `up to about ${formatBytes(item.largest)} (${item.what})`;
    const text = reason === 'lookup'
      ? `${entry.name}: ${checks} that look values up in it skipped: a lookup reads the whole table, ${reads}, and a check reads at most ${limit}.`
      : reason === 'unsampled'
        ? `${entry.name}: ${checks} skipped: its rows cannot be sampled by file yet, and reading it takes ${reads}, more than the ${limit} a check reads.`
        : `${entry.name}: ${checks} skipped: a check reads at most ${limit}, and even one of its files holds more, ${reads}.`;
    notes.push({ relation: entry.relation, kind: 'skipped', text });
  }
  return notes;
}
