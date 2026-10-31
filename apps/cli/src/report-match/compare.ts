import { dateOrderOf, decimalStyleOf, isEmptyCell, parseDateCell, parseNumberCell, type DateGrain, type DateOrder, type DecimalStyle, type ExportTable, type PrintedNumber } from './read-export.js';

/**
 * Comparing an export with ZLens's result, value by value.
 *
 * Rows are matched by their keys, never by position. A number is equal when
 * ZLens's value lies within half a printed unit of the file's, so `14.93%`
 * equals a printed `14.9%`. Each metric gets its own verdict; the file's is the
 * worst of them. There are three verdicts, because "nothing disagreed" is not
 * the same as "it matches": zero values compared, a column left out or an
 * export cut short is Not proven.
 */

export type Verdict = 'matches' | 'differs' | 'not-proven';

export interface KeyColumn {
  header: string;
  /** The result's column. */
  output: string;
  kind: 'text' | 'date';
  /** For a date key: the period each row stands for. */
  grain?: DateGrain;
}

export interface NumberColumn {
  header: string;
  /** The result's column. */
  output: string;
  /** The metric, or the saved query's column, it is compared with. */
  name: string;
}

export interface ComparisonPlan {
  keys: KeyColumn[];
  numbers: NumberColumn[];
  /** Number columns with nothing to compare with. */
  notCompared: string[];
}

export interface CompareOptions {
  /** Compare only the rows in the file; ZLens rows beyond them are ignored. */
  fileRowsOnly?: boolean;
  /** A share of the value, recorded: 0.005 for 0.5%. */
  tolerance?: number;
  /** ZLens's result was cut by a row limit. */
  resultIncomplete?: boolean;
  /** Filters ZLens can see that nobody stated or waived. */
  unansweredFilters?: string[];
  /** Filters were stated or waived. */
  filtersStated?: boolean;
  /** Read the file's dates as day first, when the person said so. */
  dateOrder?: DateOrder;
  /** Notes on the metrics compared, shown as possible reasons. */
  metricNotes?: string[];
}

export interface ValueDifference {
  key: string[];
  column: string;
  old: string;
  zlens: number | null;
  kind: 'value' | 'empty-vs-zero' | 'unreadable';
}

export interface NumberResult {
  column: string;
  name: string;
  verdict: Verdict;
  compared: number;
  equal: number;
  /** How exactly it was compared, in words: `2 decimals`. */
  precision: string;
  /** Compared at a precision coarser than whole units, which the result must say. */
  coarse: boolean;
  /** `14.9%` matched a value holding 14.9. */
  percentPoints: boolean;
}

export interface RowCounts {
  inFile: number;
  inBoth: number;
  onlyInFile: number;
  onlyInZLens: number;
  /** Rows on one side whose compared values are all empty: not a difference. */
  emptySetAside: number;
  totalsSetAside: number;
}

export interface Comparison {
  verdict: Verdict;
  rows: RowCounts;
  values: { compared: number; equal: number };
  numbers: NumberResult[];
  differences: ValueDifference[];
  onlyInFile: string[][];
  onlyInZLens: string[][];
  notCompared: string[];
  /** What keeps this from being Matches even though nothing disagreed. */
  missing: string[];
  reasons: string[];
  notes: string[];
}

/** Stops the comparison: the rows cannot be matched at all. */
export class ComparisonStopped extends Error {}

const EMPTY_KEY = '\u0000empty';
const ONE_DAY = 86_400_000;

export function compareExport(table: ExportTable, plan: ComparisonPlan, rows: Array<Record<string, unknown>>, options: CompareOptions = {}): Comparison {
  const notes = [...table.notes];
  const headerAt = new Map(table.headers.map((header, index) => [header, index]));
  const columnOf = (header: string) => table.rows.map((row) => row[headerAt.get(header)!] ?? '');

  const dateOrders = new Map<string, DateOrder>();
  for (const key of plan.keys) {
    if (key.kind !== 'date') continue;
    const found = dateOrderOf(columnOf(key.header));
    dateOrders.set(key.header, options.dateOrder ?? found.order);
    if (found.ambiguous && !options.dateOrder) notes.push(`Dates in ${key.header} could be month first or day first; they were read as month first. If that is wrong, use --dates dmy.`);
  }
  const styles = new Map<string, DecimalStyle>();
  for (const number of plan.numbers) {
    const found = decimalStyleOf(columnOf(number.header));
    styles.set(number.header, found.style);
    if (found.ambiguous) {
      const sample = columnOf(number.header).find((cell) => /\d[.,]\d{3}\b/.test(cell));
      notes.push(`Numbers in ${number.header} such as ${sample} have one separator, so a comma was read as thousands and a point as decimals.`);
    }
  }

  if (!plan.keys.length && table.rows.length > 1) throw new ComparisonStopped(`The file has ${table.rows.length} rows and no column to tell them apart. With no keys it must have one row, the total.`);

  // Rows on each side, by key.
  const fileRows = new Map<string, { key: string[]; cells: string[] }>();
  for (const row of table.rows) {
    const key = plan.keys.map((column) => fileKey(row[headerAt.get(column.header)!] ?? '', column, dateOrders.get(column.header)));
    const id = key.join('\u0001');
    if (fileRows.has(id)) throw new ComparisonStopped(`The key ${describeKey(key)} repeats in the file, so the view has a field the export does not show. Add that field to the view, or compare a saved query at that grain.`);
    fileRows.set(id, { key, cells: row });
  }
  const resultRows = new Map<string, { key: string[]; row: Record<string, unknown> }>();
  for (const row of rows) {
    const key = plan.keys.map((column) => resultKey(pick(row, column.output), column));
    const id = key.join('\u0001');
    if (resultRows.has(id)) throw new ComparisonStopped(`The key ${describeKey(key)} repeats in ZLens's result, so its grain is finer than the file's.`);
    resultRows.set(id, { key, row });
  }

  const counts: RowCounts = { inFile: fileRows.size, inBoth: 0, onlyInFile: 0, onlyInZLens: 0, emptySetAside: 0, totalsSetAside: table.totalsSetAside };
  const onlyInFile: string[][] = [];
  const onlyInZLens: string[][] = [];
  const pairs: Array<{ key: string[]; cells: string[]; row: Record<string, unknown> }> = [];
  for (const [id, entry] of fileRows) {
    const other = resultRows.get(id);
    if (other) {
      counts.inBoth += 1;
      pairs.push({ key: entry.key, cells: entry.cells, row: other.row });
    } else if (plan.numbers.every((number) => isEmptyCell(entry.cells[headerAt.get(number.header)!]))) {
      // A filtered metric drops rows the report shows blank.
      counts.emptySetAside += 1;
    } else {
      counts.onlyInFile += 1;
      onlyInFile.push(entry.key);
    }
  }
  if (!options.fileRowsOnly) {
    for (const [id, entry] of resultRows) {
      if (fileRows.has(id)) continue;
      // Power BI drops rows whose measures are all blank; SQL keeps them.
      if (plan.numbers.every((number) => toNumber(pick(entry.row, number.output)) === null)) {
        counts.emptySetAside += 1;
      } else {
        counts.onlyInZLens += 1;
        onlyInZLens.push(entry.key);
      }
    }
  }

  const differences: ValueDifference[] = [];
  const shared = sharedMissing(table, options);
  const rowsDiffer = counts.onlyInFile > 0 || counts.onlyInZLens > 0;
  const numbers = plan.numbers.map((number) => compareColumn(number, pairs, headerAt.get(number.header)!, styles.get(number.header)!, options, differences, rowsDiffer, shared));

  const missing = [...shared, ...plan.notCompared.map((column) => `${column} was not compared.`)];
  if (!plan.numbers.length) missing.push('No number column was compared.');
  const anyDiffers = rowsDiffer || numbers.some((number) => number.verdict === 'differs');
  const anyUnproven = missing.length > 0 || numbers.some((number) => number.verdict === 'not-proven');
  const verdict: Verdict = anyDiffers ? 'differs' : anyUnproven ? 'not-proven' : 'matches';
  const compared = numbers.reduce((sum, number) => sum + number.compared, 0);
  const equal = numbers.reduce((sum, number) => sum + number.equal, 0);

  return {
    verdict,
    rows: counts,
    values: { compared, equal },
    numbers,
    differences,
    onlyInFile,
    onlyInZLens,
    notCompared: plan.notCompared,
    missing,
    reasons: possibleReasons({ table, plan, pairs, differences, onlyInFile, onlyInZLens, options, headerAt, styles, verdict }),
    notes,
  };
}

function sharedMissing(table: ExportTable, options: CompareOptions): string[] {
  return [
    ...(table.cutShort ? ['The export was cut short.'] : []),
    ...(options.resultIncomplete ? ["ZLens's result was cut by a row limit."] : []),
    ...(options.unansweredFilters ?? []).map((filter) => `Nobody stated or waived the filter on ${filter}.`),
  ];
}

function compareColumn(
  number: NumberColumn,
  pairs: Array<{ key: string[]; cells: string[]; row: Record<string, unknown> }>,
  at: number,
  style: DecimalStyle,
  options: CompareOptions,
  differences: ValueDifference[],
  rowsDiffer: boolean,
  shared: string[],
): NumberResult {
  const printed = pairs.map((pair) => {
    const cell = pair.cells[at] ?? '';
    return { pair, cell, parsed: isEmptyCell(cell) ? null : parseNumberCell(cell, style), ours: toNumber(pick(pair.row, number.output)) };
  });
  const decimals = Math.max(0, ...printed.map((item) => item.parsed?.decimals ?? 0));
  const tolerance = options.tolerance ?? 0;
  const equalAt = (shift: number) => printed.filter((item) => item.parsed && item.ours !== null && isEqual(item.parsed, item.ours / shift, decimals, tolerance)).length;
  // `14.9%` against a metric that holds 14.9.
  const percentCells = printed.filter((item) => item.parsed?.percent).length;
  const percentPoints = percentCells > 0 && equalAt(100) > equalAt(1);
  const shift = percentPoints ? 100 : 1;

  let compared = 0;
  let equal = 0;
  for (const { pair, cell, parsed, ours } of printed) {
    const empty = isEmptyCell(cell);
    if (empty && ours === null) continue;
    compared += 1;
    if (!empty && !parsed) {
      differences.push({ key: pair.key, column: number.header, old: cell, zlens: ours, kind: 'unreadable' });
    } else if (empty || ours === null) {
      const zero = empty ? ours === 0 : parsed!.value === 0;
      differences.push({ key: pair.key, column: number.header, old: cell, zlens: ours, kind: zero ? 'empty-vs-zero' : 'value' });
    } else if (isEqual(parsed!, ours / shift, decimals, tolerance)) {
      equal += 1;
    } else {
      differences.push({ key: pair.key, column: number.header, old: cell, zlens: ours, kind: 'value' });
    }
  }
  const sample = printed.find((item) => item.parsed)?.parsed;
  const verdict: Verdict = compared > equal || rowsDiffer ? 'differs' : shared.length > 0 || compared === 0 ? 'not-proven' : 'matches';
  return {
    column: number.header,
    name: number.name,
    verdict,
    compared,
    equal,
    precision: precisionWords(sample ?? undefined, decimals, tolerance),
    coarse: (sample?.scale ?? 1) > 1,
    percentPoints,
  };
}

/** Within half a printed unit. Both ends count, so rounding half up and half to even agree. */
function isEqual(printed: PrintedNumber, ours: number, columnDecimals: number, tolerance: number): boolean {
  const places = printed.decimals === null ? null : columnDecimals;
  const unit = places === null ? 0 : 10 ** -places * printed.scale * (printed.percent ? 0.01 : 1);
  const limit = Math.max(unit / 2, Math.abs(ours) * 1e-9, Math.abs(printed.value) * tolerance) * (1 + 1e-9);
  return Math.abs(ours - printed.value) <= limit;
}

function precisionWords(sample: PrintedNumber | undefined, decimals: number, tolerance: number): string {
  const within = tolerance ? `, within ${(tolerance * 100).toLocaleString('en-US')}%` : '';
  if (!sample) return `nothing compared${within}`;
  if (sample.decimals === null) return `the full value${within}`;
  if (sample.percent) return `${10 ** -decimals}%${within}`;
  if (sample.scale > 1) return `the nearest ${(10 ** -decimals * sample.scale).toLocaleString('en-US')}${within}`;
  return `${decimals === 0 ? 'whole numbers' : `${decimals} decimal${decimals === 1 ? '' : 's'}`}${within}`;
}

function pick(row: Record<string, unknown>, column: string): unknown {
  if (column in row) return row[column];
  // Snowflake and Oracle give column names in capitals.
  const lower = column.toLowerCase();
  const found = Object.keys(row).find((name) => name.toLowerCase() === lower);
  return found === undefined ? undefined : row[found];
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(number) ? number : null;
}

function fileKey(cell: string, key: KeyColumn, order: DateOrder | undefined): string {
  if (isEmptyCell(cell)) return EMPTY_KEY;
  if (key.kind === 'date') {
    if (key.grain === 'year' && /^\d{4}$/.test(cell.trim())) return `${cell.trim()}-01-01`;
    const parsed = parseDateCell(cell, order);
    if (!parsed) throw new ComparisonStopped(`${key.header} holds "${cell}", which ZLens cannot read as a date.`);
    return parsed.date;
  }
  return textKey(cell);
}

function resultKey(value: unknown, key: KeyColumn): string {
  if (value === null || value === undefined || value === '') return EMPTY_KEY;
  if (key.kind === 'date') return dayOf(value);
  return textKey(String(value));
}

function textKey(text: string): string {
  const trimmed = text.trim();
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase();
  // An id written with thousands separators is still that id. `02134` keeps its zero.
  if (/^-?\d{1,3}(?:,\d{3})+$/.test(trimmed)) return trimmed.replace(/,/g, '');
  return trimmed;
}

/**
 * The day a result's date stands for. A truncated date can come back as a
 * timestamp at local midnight, which in UTC falls on either side of the day,
 * so it is taken to the nearest midnight.
 */
function dayOf(value: unknown): string {
  if (value instanceof Date) return new Date(Math.round(value.getTime() / ONE_DAY) * ONE_DAY).toISOString().slice(0, 10);
  const text = String(value).trim();
  const zoned = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}.*(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(text);
  if (zoned && Number.isFinite(Date.parse(text.replace(' ', 'T')))) return dayOf(new Date(Date.parse(text.replace(' ', 'T'))));
  return text.slice(0, 10);
}

function describeKey(key: string[]): string {
  return key.map((part) => (part === EMPTY_KEY ? '(empty)' : part)).join(' / ') || '(no key)';
}

/** A key as a person reads it. */
export function keyWords(key: string[]): string {
  return describeKey(key);
}

/** Why it might differ: only from evidence. */
function possibleReasons(input: {
  table: ExportTable;
  plan: ComparisonPlan;
  pairs: Array<{ key: string[]; cells: string[]; row: Record<string, unknown> }>;
  differences: ValueDifference[];
  onlyInFile: string[][];
  onlyInZLens: string[][];
  options: CompareOptions;
  headerAt: Map<string, number>;
  styles: Map<string, DecimalStyle>;
  verdict: Verdict;
}): string[] {
  const { table, plan, pairs, differences, onlyInFile, onlyInZLens, options, headerAt, styles, verdict } = input;
  const reasons: string[] = [];
  for (const filter of options.unansweredFilters ?? []) {
    reasons.push(`The report filters ${filter}, and no filter was stated. Filters are not in an export, so this run read every row.`);
  }
  if (table.cutShort) reasons.push('The export says it was cut short, so some rows are missing from it.');
  if (verdict !== 'differs') return reasons;

  const ratios: number[] = [];
  for (const pair of pairs) {
    for (const number of plan.numbers) {
      const parsed = parseNumberCell(pair.cells[headerAt.get(number.header)!] ?? '', styles.get(number.header));
      const ours = toNumber(pick(pair.row, number.output));
      if (parsed?.value && ours) ratios.push(ours / parsed.value);
    }
  }
  if (ratios.length >= 2) {
    const first = ratios[0]!;
    if (Math.abs(first - 1) > 0.01 && ratios.every((ratio) => Math.abs(ratio / first - 1) < 0.005)) {
      reasons.push(`Every ZLens value is ${first.toLocaleString('en-US', { maximumFractionDigits: 2 })}× the old report's: a join or a filter.`);
    }
  }

  const dateKey = plan.keys.findIndex((key) => key.kind === 'date');
  if (dateKey >= 0) {
    const fileDates = pairs.map((pair) => pair.key[dateKey]!).concat(onlyInFile.map((key) => key[dateKey]!)).filter((date) => date !== EMPTY_KEY).sort();
    const last = fileDates[fileDates.length - 1];
    const later = onlyInZLens.some((key) => last && key[dateKey]! > last);
    const onlyLatest = differences.length > 0 && differences.every((difference) => difference.key[dateKey] === last);
    if (last && (later || onlyLatest)) reasons.push(`The old report's data stops at ${last}; an extract's refresh may be behind, or the database has moved on.`);
  }

  const lowered = new Set(onlyInFile.map((key) => key.join('\u0001').toLowerCase()));
  const caseOnly = onlyInZLens.filter((key) => lowered.has(key.join('\u0001').toLowerCase()));
  if (caseOnly.length) reasons.push(`Keys differ only in case (${describeKey(caseOnly[0]!)}): the old tool may group them as one.`);

  reasons.push(...(options.metricNotes ?? []));
  if (!options.filtersStated && !(options.unansweredFilters ?? []).length) {
    reasons.push('No filter was stated. A filter on a field the report does not show is not in the export.');
  }
  return Array.from(new Set(reasons));
}
