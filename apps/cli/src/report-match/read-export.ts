import { createHash } from 'node:crypto';

/**
 * Reading an export of an old report: what Tableau and Power BI really write.
 *
 * Tableau's crosstabs are UTF-16 with tabs and carry formatted text (`$1,234`,
 * `8.7%`, `($41,000)`), so a number keeps how it was printed: "matches" means
 * equal at the precision the file shows. The file is read once into plain
 * rows; nothing here knows about metrics or databases.
 */

export interface ExportTable {
  fileName: string;
  sha256: string;
  headers: string[];
  /** One text cell per header, after reshaping to one column per measure. */
  rows: string[][];
  /** Rows labelled Total or Grand Total, set aside. */
  totalsSetAside: number;
  /** Only when the file itself shows it (see `toolFromFile`). */
  tool?: 'tableau' | 'powerbi';
  /** Power BI's `Applied filters: …` line, as written. */
  appliedFilters?: string;
  /** The export says it was cut short, as written. */
  cutShort?: string;
  /** Things read in a way the person may want to check. */
  notes: string[];
}

/** Stops reading, saying what to export instead. */
export class ExportRefused extends Error {}

export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
/** Power BI's Excel limit, the largest export either tool writes. */
export const MAX_EXPORT_ROWS = 150_000;

export function readExport(bytes: Buffer, fileName: string): ExportTable {
  if (bytes.length > MAX_EXPORT_BYTES) throw new ExportRefused(`${fileName} is larger than ${MAX_EXPORT_BYTES / 1024 / 1024} MB.`);
  refuseOtherFiles(fileName);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { text, encoding } = decode(bytes);
  const separator = detectSeparator(text);
  const table = parseDelimited(text, separator);
  const notes: string[] = [];
  let appliedFilters: string | undefined;
  let cutShort: string | undefined;

  // Lines Power BI adds around the table.
  const body = table.filter((row) => {
    const first = (row[0] ?? '').trim();
    if (/^applied filters:/i.test(first)) {
      appliedFilters = row.join(' ').replace(/^applied filters:\s*/i, '').trim();
      return false;
    }
    if (/exported data exceeded the allowed volume/i.test(row.join(' '))) {
      cutShort = row.join(' ').trim();
      return false;
    }
    return row.some((cell) => cell.trim() !== '');
  });
  if (!body.length) throw new ExportRefused(`${fileName} has no rows.`);

  const headers = body[0]!.map(cleanHeader);
  refuseShapes(headers, fileName);
  let rows = body.slice(1).map((row) => headers.map((_, index) => cleanCell(row[index] ?? '')));
  if (rows.length > MAX_EXPORT_ROWS) throw new ExportRefused(`${fileName} has ${rows.length.toLocaleString('en-US')} rows; ZLens compares up to ${MAX_EXPORT_ROWS.toLocaleString('en-US')}.`);

  const shaped = reshapeMeasures(headers, rows);
  rows = shaped.rows;
  const measures = new Set(shaped.measures);
  const keyColumns = shaped.headers.map((header, index) => (measures.has(header) ? -1 : index)).filter((index) => index >= 0);
  const kept = rows.filter((row) => !keyColumns.some((index) => isTotalLabel(row[index] ?? '')));

  return {
    fileName,
    sha256,
    headers: shaped.headers,
    rows: kept,
    totalsSetAside: rows.length - kept.length,
    ...(toolFromFile(encoding, separator, headers, appliedFilters) ? { tool: toolFromFile(encoding, separator, headers, appliedFilters) } : {}),
    ...(appliedFilters ? { appliedFilters } : {}),
    ...(cutShort ? { cutShort } : {}),
    notes,
  };
}

function refuseOtherFiles(fileName: string): void {
  const lower = fileName.toLowerCase();
  if (/\.(?:twb|twbx|pbit|pbix|pbip|tds|tdsx)$/.test(lower)) {
    throw new ExportRefused(`${fileName} is the report, not its numbers. In Tableau use Download → Crosstab; in Power BI use a visual's Export data.`);
  }
  if (/\.(?:xlsx|xls|xlsm)$/.test(lower)) throw new ExportRefused(`ZLens does not read Excel exports yet. Save ${fileName} as CSV, or use the CSV download.`);
  if (/\.(?:pdf|png|jpe?g|pptx?|hyper)$/.test(lower)) {
    throw new ExportRefused(`${fileName} is not a table ZLens can read. Export the worksheet or visual as CSV.`);
  }
}

// ── Bytes to text ───────────────────────────────────────────────────────────

function decode(bytes: Buffer): { text: string; encoding: 'utf-8' | 'utf-16le' | 'utf-16be' } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf-8' };
  // UTF-16 with no mark: the high bytes of plain text are all zero.
  const sample = bytes.subarray(0, Math.min(bytes.length, 400));
  let zeroOdd = 0;
  let zeroEven = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0) {
      if (index % 2) zeroOdd += 1;
      else zeroEven += 1;
    }
  }
  if (sample.length >= 4 && zeroOdd > sample.length / 4) return { text: bytes.toString('utf16le'), encoding: 'utf-16le' };
  if (sample.length >= 4 && zeroEven > sample.length / 4) {
    const swapped = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
  }
  return { text: bytes.toString('utf8'), encoding: 'utf-8' };
}

function detectSeparator(text: string): string {
  const candidates = ['\t', ',', ';', '|'];
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 20);
  // Power BI's filter line is not the table.
  const sample = lines.filter((line) => !/^"?applied filters:/i.test(line));
  let best = ',';
  let bestScore = 0;
  for (const candidate of candidates) {
    const counts = sample.map((line) => countOutsideQuotes(line, candidate));
    const first = counts[0] ?? 0;
    if (!first) continue;
    const steady = counts.filter((count) => count === first).length;
    const score = first * steady;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, separator: string): number {
  let quoted = false;
  let count = 0;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === separator && !quoted) count += 1;
  }
  return count;
}

function parseDelimited(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === separator) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cleanHeader(text: string): string {
  return text.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanCell(text: string): string {
  const spaced = text.replace(/[  ]/g, ' ').trim();
  // Power BI guards text that starts like a formula.
  return /^'[=@+-]/.test(spaced) ? spaced.slice(1) : spaced;
}

// ── Shapes ──────────────────────────────────────────────────────────────────

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const PERIOD_HEADER = new RegExp(`^(?:\\d{4}|q[1-4](?:\\s+\\d{4})?|(?:${MONTHS}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\\s+\\d{4})?|\\d{1,2}/\\d{4})$`, 'i');

function refuseShapes(headers: string[], fileName: string): void {
  if (headers.length < 2 && !headers[0]) throw new ExportRefused(`${fileName} has no header row.`);
  if (!headers[0]) {
    throw new ExportRefused(`${fileName} has a blank first header, so it looks like several header rows. Export the Summary data, or put the fields on Rows.`);
  }
  const periods = headers.slice(1).filter((header) => PERIOD_HEADER.test(header));
  if (periods.length >= 2) {
    throw new ExportRefused(`${fileName} has ${periods.slice(0, 2).join(' and ')} across the top. Move that field to Rows and export again, so each row is one period.`);
  }
  const seen = new Set<string>();
  for (const header of headers) {
    if (header && seen.has(header.toLowerCase())) throw new ExportRefused(`${fileName} has the column ${header} twice.`);
    seen.add(header.toLowerCase());
  }
}

/**
 * Tableau's two ways of writing several measures: `Measure Names` and
 * `Measure Values` rows, or `Measure Names` with a column per measure and
 * blanks. Both become one column per measure.
 */
function reshapeMeasures(headers: string[], rows: string[][]): { headers: string[]; rows: string[][]; measures: string[] } {
  const namesAt = headers.findIndex((header) => /^measure names$/i.test(header));
  if (namesAt < 0) return { headers, rows, measures: [] };
  const valuesAt = headers.findIndex((header) => /^measure values$/i.test(header));
  const measureNames = Array.from(new Set(rows.map((row) => row[namesAt] ?? '').filter(Boolean)));
  const isWide = valuesAt < 0;
  const measureColumns = isWide ? headers.map((header, index) => (index !== namesAt && measureNames.some((name) => name.toLowerCase() === header.toLowerCase()) ? index : -1)).filter((index) => index >= 0) : [];
  const keyAt = headers.map((_, index) => index).filter((index) => index !== namesAt && index !== valuesAt && !measureColumns.includes(index));
  const output = [...keyAt.map((index) => headers[index]!), ...measureNames.filter((name) => !isWide || measureColumns.some((index) => headers[index]!.toLowerCase() === name.toLowerCase()))];
  const merged = new Map<string, string[]>();
  for (const row of rows) {
    const key = keyAt.map((index) => row[index] ?? '').join('\u0000');
    const target = merged.get(key) ?? [...keyAt.map((index) => row[index] ?? ''), ...new Array<string>(output.length - keyAt.length).fill('')];
    merged.set(key, target);
    const name = row[namesAt] ?? '';
    const at = output.findIndex((header, index) => index >= keyAt.length && header.toLowerCase() === name.toLowerCase());
    if (at < 0) continue;
    const column = isWide ? measureColumns.find((index) => headers[index]!.toLowerCase() === name.toLowerCase()) : valuesAt;
    target[at] = row[column!] ?? '';
  }
  return { headers: output, rows: Array.from(merged.values()), measures: output.slice(keyAt.length) };
}

function isTotalLabel(cell: string): boolean {
  return /^(?:grand\s+|sub-?\s*)?totals?$/i.test(cell.trim());
}

/** What the file itself shows, never a guess from its name. */
function toolFromFile(encoding: string, separator: string, headers: string[], appliedFilters: string | undefined): 'tableau' | 'powerbi' | undefined {
  if (appliedFilters) return 'powerbi';
  if (headers.some((header) => /^measure (?:names|values)$/i.test(header) || /^(?:AGG|CNTD|ATTR)\(.+\)$/.test(header))) return 'tableau';
  if (encoding === 'utf-16le' && separator === '\t') return 'tableau';
  return undefined;
}

// ── Cells ───────────────────────────────────────────────────────────────────

/** Empty in every way these tools write it. */
export function isEmptyCell(cell: string | null | undefined): boolean {
  if (cell === null || cell === undefined) return true;
  return /^(?:|null|%null%|\(blank\)|n\/a|-|—|–)$/i.test(cell.trim());
}

export interface PrintedNumber {
  value: number;
  /** Decimals printed, for the value as written (`14.9%` has one). Null for a value with no printed form. */
  decimals: number | null;
  /** 1000 for `K`, a million for `M`; 1 otherwise. */
  scale: number;
  percent: boolean;
}

const SCALES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

export type DecimalStyle = 'point' | 'comma';

/** How a number was printed, or null when the text is not a number. */
export function parseNumberCell(cell: string, style: DecimalStyle = 'point'): PrintedNumber | null {
  let text = cell.replace(/[  ]/g, ' ').trim().replace(/−/g, '-');
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  // A currency, before or after: a symbol, or a three-letter code.
  text = text.replace(/^[$€£¥₹₩₽]\s*/, '').replace(/\s*[$€£¥₹₩₽]$/, '').replace(/^[A-Z]{3}\s+/, '').replace(/\s+[A-Z]{3}$/, '');
  if (/^-/.test(text)) {
    negative = !negative;
    text = text.slice(1).trim();
  }
  text = text.replace(/^[$€£¥₹₩₽]\s*/, '');
  if (/-$/.test(text)) {
    negative = !negative;
    text = text.slice(0, -1).trim();
  }
  const percent = text.endsWith('%');
  if (percent) text = text.slice(0, -1).trim();
  const scaleLetter = /[KMBT]$/.exec(text)?.[0];
  if (scaleLetter) text = text.slice(0, -1).trim();
  const thousands = style === 'point' ? ',' : '.';
  const decimal = style === 'point' ? '.' : ',';
  const shape = new RegExp(`^\\d{1,3}(?:[${thousands} ]\\d{3})*(?:\\${decimal}\\d*)?$|^\\d+(?:\\${decimal}\\d*)?$|^\\${decimal}\\d+$`);
  if (!shape.test(text)) return null;
  const plain = text.replace(new RegExp(`[${thousands} ]`, 'g'), '').replace(decimal, '.');
  const decimals = plain.includes('.') ? plain.length - plain.indexOf('.') - 1 : 0;
  const scale = scaleLetter ? SCALES[scaleLetter]! : 1;
  const value = Number(plain) * scale * (percent ? 0.01 : 1) * (negative ? -1 : 1);
  return Number.isFinite(value) ? { value, decimals, scale, percent } : null;
}

/**
 * Whether a column uses a decimal comma, from all its values: `1.234,56` and
 * `12,5` settle it, and so do `1,234.56` and `12.5`. `1,234` alone does not, and
 * is read the common way, with `ambiguous` set so the person can be told.
 */
export function decimalStyleOf(cells: string[]): { style: DecimalStyle; ambiguous: boolean } {
  let point = false;
  let comma = false;
  let thousandsOnly = false;
  for (const cell of cells) {
    const text = cell.replace(/[^\d.,]/g, '');
    if (!text) continue;
    if (/\d,\d{3}\.\d/.test(text) || /^\d+\.\d{1,2}$/.test(text) || /^\d+\.\d{4,}$/.test(text)) point = true;
    else if (/\d\.\d{3},\d/.test(text) || /^\d+,\d{1,2}$/.test(text) || /^\d+,\d{4,}$/.test(text)) comma = true;
    else if (/^\d{1,3}(?:,\d{3})+$/.test(text) || /^\d{1,3}(?:\.\d{3})+$/.test(text)) thousandsOnly = true;
  }
  if (comma && !point) return { style: 'comma', ambiguous: false };
  return { style: 'point', ambiguous: !point && !comma && thousandsOnly };
}

// ── Dates ───────────────────────────────────────────────────────────────────

export type DateGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface ParsedDate {
  /** The first day of the period: `2026-01-01`. */
  date: string;
  grain: DateGrain;
}

const MONTH_NUMBER: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export type DateOrder = 'mdy' | 'dmy';

/** A date or a period as these tools print it, or null. */
export function parseDateCell(cell: string, order: DateOrder = 'mdy'): ParsedDate | null {
  const text = cell.trim();
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = (year: number, month: number, date: number): ParsedDate | null => {
    const made = new Date(Date.UTC(year, month - 1, date));
    if (made.getUTCMonth() !== month - 1 || made.getUTCDate() !== date) return null;
    return { date: `${year}-${pad(month)}-${pad(date)}`, grain: 'day' };
  };
  const fullYear = (year: number) => (year < 100 ? 2000 + year : year);
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text);
  if (match) return day(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T].*)?$/.exec(text);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    return order === 'mdy' ? day(fullYear(Number(match[3])), first, second) : day(fullYear(Number(match[3])), second, first);
  }
  match = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (match && MONTH_NUMBER[match[1]!.toLowerCase()]) return day(Number(match[3]), MONTH_NUMBER[match[1]!.toLowerCase()]!, Number(match[2]));
  match = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(text);
  if (match && MONTH_NUMBER[match[2]!.toLowerCase()]) return day(Number(match[3]), MONTH_NUMBER[match[2]!.toLowerCase()]!, Number(match[1]));
  match = /^([A-Za-z]+)\.?[\s-]+(\d{4}|\d{2})$/.exec(text);
  if (match && MONTH_NUMBER[match[1]!.toLowerCase()]) return { date: `${fullYear(Number(match[2]))}-${pad(MONTH_NUMBER[match[1]!.toLowerCase()]!)}-01`, grain: 'month' };
  match = /^(\d{4})-(\d{2})$/.exec(text);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) return { date: `${match[1]}-${match[2]}-01`, grain: 'month' };
  match = /^q([1-4])[\s-]+(\d{4})$/i.exec(text) ?? /^(\d{4})[\s-]+q([1-4])$/i.exec(text);
  if (match) {
    const yearFirst = match[1]!.length === 4;
    const quarter = Number(yearFirst ? match[2] : match[1]);
    const year = yearFirst ? match[1] : match[2];
    return { date: `${year}-${pad((quarter - 1) * 3 + 1)}-01`, grain: 'quarter' };
  }
  return null;
}

/** The order of a column's numeric dates, from all its values. `ambiguous` when none has a part above 12. */
export function dateOrderOf(cells: string[]): { order: DateOrder; ambiguous: boolean } {
  let monthFirst = false;
  let dayFirst = false;
  let unclear = false;
  for (const cell of cells) {
    const match = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(cell.trim());
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first > 12) dayFirst = true;
    else if (second > 12) monthFirst = true;
    else if (first !== second) unclear = true;
  }
  if (dayFirst && !monthFirst) return { order: 'dmy', ambiguous: false };
  return { order: 'mdy', ambiguous: unclear && !monthFirst && !dayFirst };
}
