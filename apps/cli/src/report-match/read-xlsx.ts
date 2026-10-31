import { listZipEntries, readZipEntry, type ZipEntry } from '../bi-import/zip.js';
import { child, descendants, parseXml, type XmlElement } from '../bi-import/xml.js';

/**
 * Reading the first sheet of an `.xlsx` export as rows of text.
 *
 * A sheet is scanned byte by byte, row by row, never built into a tree: a small
 * crafted file can expand to millions of elements, and a real 150,000-row export
 * is tens of megabytes of XML. Each scan moves forward only and stays inside its
 * row, so the time taken grows with the file. What a file may inflate to and how
 * many rows and cells it may hold are capped before anything is kept.
 */

/** An Excel number cell: its full value, with no printed precision to read. */
export type FullValue = 'number' | 'percent';

export interface XlsxSheet {
  rows: string[][];
  /** Per cell, set when it is an Excel number. */
  full: Array<Array<FullValue | undefined>>;
  notes: string[];
  /** The lines of Power BI's ExportHeaders sheet: what the export says about itself. */
  details: string[];
  /** Hidden sheets, which were not read and could hold anything. */
  hiddenSheets: string[];
}

/** A stop from a file ZLens will not read, with the reason. */
export class XlsxRefused extends Error {}

/** About 150,000 rows of 30 columns. */
const MAX_SHEET_BYTES = 256 * 1024 * 1024;
/** The workbook, its links and its styles are read as a tree, so they stay small. */
const MAX_SMALL_PART_BYTES = 2 * 1024 * 1024;
/** Power BI's limit, and the lines it adds around the table. */
const MAX_ROWS = 150_010;
const MAX_COLUMNS = 1_024;
const MAX_CELLS = 5_000_000;
const MAX_SHARED_STRINGS = 2_000_000;
/** All the text kept: one long string may be referenced by every cell. */
const MAX_TEXT_CHARS = 128 * 1024 * 1024;
/** 9999-12-31. */
const LAST_EXCEL_DATE = 2_958_465;

export function readXlsx(bytes: Buffer, fileName: string): XlsxSheet {
  let entries: ZipEntry[];
  try {
    entries = listZipEntries(bytes);
  } catch {
    throw new XlsxRefused(`${fileName} is not an Excel workbook ZLens can read. Save it as .xlsx, or export CSV.`);
  }
  const entry = (name: string) => entries.find((item) => item.name.replace(/^\//, '').toLowerCase() === name.toLowerCase());
  const part = (name: string, maxBytes: number) => {
    const found = entry(name);
    if (!found) return null;
    try {
      return readZipEntry(bytes, found, maxBytes);
    } catch (error) {
      throw new XlsxRefused(`${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const relationships = (path: string) => {
    const rels = part(path, MAX_SMALL_PART_BYTES);
    return rels ? descendants(parseXml(withoutPrefixes(rels)), 'Relationship') : [];
  };

  const officeDocument = relationships('_rels/.rels').find((item) => /\/officeDocument$/.test(item.attributes.Type ?? ''))?.attributes.Target;
  const workbookPath = officeDocument ? partPath(officeDocument, '') : 'xl/workbook.xml';
  const workbook = part(workbookPath, MAX_SMALL_PART_BYTES);
  if (!workbook) throw new XlsxRefused(`${fileName} has no workbook inside. Save it as .xlsx, or export CSV.`);
  const folder = workbookPath.includes('/') ? workbookPath.slice(0, workbookPath.lastIndexOf('/')) : '';
  const targets = relationships(`${folder ? `${folder}/` : ''}_rels/${workbookPath.slice(folder.length ? folder.length + 1 : 0)}.rels`);
  const targetOfType = (type: RegExp) => targets.find((item) => type.test(item.attributes.Type ?? ''))?.attributes.Target;
  const relationOf = (sheet: XmlElement) => {
    const relId = sheet.attributes['r:id'] ?? Object.entries(sheet.attributes).find(([name]) => /:id$/.test(name))?.[1];
    return targets.find((relationship) => relationship.attributes.Id === relId);
  };

  const book = parseXml(withoutPrefixes(workbook));
  const root = book.children.find((element) => element.name === 'workbook') ?? book;
  const date1904 = /^(?:1|true)$/i.test(child(root, 'workbookPr')?.attributes.date1904 ?? '');
  // A chart sheet comes first in some workbooks, and holds no rows.
  const listed = (child(root, 'sheets')?.children ?? []).filter((sheet) => sheet.name === 'sheet' && !/chartsheet/i.test(`${relationOf(sheet)?.attributes.Type ?? ''} ${relationOf(sheet)?.attributes.Target ?? ''}`));
  // A live Power BI export keeps details of the export on a sheet of their own.
  const details = listed.find((sheet) => sheet.attributes.name === 'ExportHeaders');
  const others = listed.filter((sheet) => sheet !== details);
  const isVisible = (sheet: XmlElement) => (sheet.attributes.state ?? 'visible') === 'visible';
  const visible = others.filter(isVisible);
  const sheet = visible[0];
  if (!sheet) throw new XlsxRefused(`${fileName} has no sheet to read.`);

  const sheetData = (item: XmlElement) => {
    const target = relationOf(item)?.attributes.Target;
    if (!target) throw new XlsxRefused(`${fileName} does not say where the sheet ${item.attributes.name ?? ''} is.`);
    const data = part(partPath(target, folder), MAX_SHEET_BYTES);
    if (!data) throw new XlsxRefused(`${fileName} is missing the sheet ${item.attributes.name ?? ''}.`);
    return data;
  };
  const strings = part(partPath(targetOfType(/\/sharedStrings$/) ?? 'sharedStrings.xml', folder), MAX_SHEET_BYTES);
  const styles = part(partPath(targetOfType(/\/styles$/) ?? 'styles.xml', folder), MAX_SMALL_PART_BYTES);
  const budget: ScanBudget = { textChars: 0 };
  const context: ScanContext = { strings: strings ? scanSharedStrings(strings, fileName, budget) : [], kinds: styles ? styleKinds(withoutPrefixes(styles)) : new Map(), date1904, fileName, budget };

  const read = scanSheet(sheetData(sheet), context);
  return {
    ...read,
    notes: visible.length > 1 ? [`This workbook has ${visible.length} sheets. ZLens read the first, ${sheet.attributes.name}.`] : [],
    details: details ? scanSheet(sheetData(details), context).rows.map((row) => row.filter((cell) => cell.trim() !== '').join(' ')).filter(Boolean) : [],
    hiddenSheets: others.filter((item) => !isVisible(item)).map((item) => item.attributes.name ?? 'unnamed'),
  };
}

/** A relationship's target, from the folder of the part that names it. */
function partPath(target: string, folder: string): string {
  const parts: string[] = target.startsWith('/') ? [] : folder.split('/').filter(Boolean);
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

interface ScanBudget {
  textChars: number;
}

interface ScanContext {
  strings: string[];
  kinds: Map<number, StyleKind>;
  date1904: boolean;
  fileName: string;
  budget: ScanBudget;
}

function spendText(budget: ScanBudget, chars: number, fileName: string): void {
  budget.textChars += chars;
  if (budget.textChars > MAX_TEXT_CHARS) throw new XlsxRefused(`${fileName} holds more text than ZLens compares.`);
}

/** Some writers give every tag a prefix, `<x:row>`. */
function tagPrefix(xml: Buffer, root: string): string {
  return new RegExp(`<([\\w.-]+:)?${root}[\\s>]`).exec(xml.toString('latin1', 0, 4096))?.[1] ?? '';
}

function withoutPrefixes(xml: Buffer): string {
  return xml.toString('utf8').replace(/<(\/?)[\w.-]+:/g, '<$1');
}

const endsName = (code: number | undefined) => code === 0x20 || code === 0x3e || code === 0x2f || code === 0x0a || code === 0x0d || code === 0x09;

function scanSheet(xml: Buffer, context: ScanContext): Pick<XlsxSheet, 'rows' | 'full'> {
  const { fileName, budget } = context;
  const rows: string[][] = [];
  const full: XlsxSheet['full'] = [];
  const prefix = tagPrefix(xml, 'worksheet');
  const [rowOpen, rowClose, cellOpen, cellClose] = [`<${prefix}row`, `</${prefix}row>`, `<${prefix}c`, `</${prefix}c>`];
  const start = xml.indexOf(`<${prefix}sheetData`);
  if (start < 0) return { rows, full };
  const end = xml.indexOf(`</${prefix}sheetData>`, start);
  const stop = end < 0 ? xml.length : end;
  const body = xml.subarray(start, stop);
  const damaged = () => new XlsxRefused(`${fileName} is damaged: a row or cell in it never closes. Save it again, or export CSV.`);
  let at = 0;
  let cells = 0;
  const rowNumbers: number[] = [];
  for (;;) {
    const rowAt = body.indexOf(rowOpen, at);
    if (rowAt < 0) break;
    const headEnd = body.indexOf('>', rowAt);
    if (headEnd < 0) throw damaged();
    if (body[headEnd - 1] === 0x2f) {
      at = headEnd + 1;
      continue;
    }
    if (rows.length >= MAX_ROWS) throw new XlsxRefused(`${fileName} has more rows than ZLens compares.`);
    const rowEnd = body.indexOf(rowClose, headEnd);
    if (rowEnd < 0) throw damaged();
    const rowNumber = Number(/\br=["'](\d+)["']/.exec(body.toString('latin1', rowAt, headEnd))?.[1] ?? rows.length + 1);
    const inRow = body.subarray(headEnd + 1, rowEnd);
    const row: string[] = [];
    const fullRow: Array<FullValue | undefined> = [];
    let cursor = 0;
    let column = 0;
    for (;;) {
      const cellAt = inRow.indexOf(cellOpen, cursor);
      if (cellAt < 0) break;
      if (!endsName(inRow[cellAt + cellOpen.length])) {
        cursor = cellAt + cellOpen.length;
        continue;
      }
      const cellHeadEnd = inRow.indexOf('>', cellAt);
      if (cellHeadEnd < 0) throw damaged();
      const head = inRow.toString('latin1', cellAt + cellOpen.length, cellHeadEnd);
      const reference = /\br=["']([A-Z]+)\d+["']/.exec(head)?.[1];
      column = reference ? columnIndex(reference) : column;
      if (column >= MAX_COLUMNS) throw new XlsxRefused(`${fileName} has more columns than ZLens compares.`);
      cells += 1;
      if (cells > MAX_CELLS) throw new XlsxRefused(`${fileName} has more cells than ZLens compares.`);
      const selfClosed = inRow[cellHeadEnd - 1] === 0x2f;
      const cellEnd = selfClosed ? cellHeadEnd : inRow.indexOf(cellClose, cellHeadEnd);
      if (cellEnd < 0) throw damaged();
      if (!selfClosed) {
        const inner = inRow.toString('utf8', cellHeadEnd + 1, cellEnd);
        const type = /\bt=["'](\w+)["']/.exec(head)?.[1] ?? 'n';
        const style = Number(/\bs=["'](\d+)["']/.exec(head)?.[1] ?? -1);
        const value = cellValue(inner, type, style, prefix, context);
        spendText(budget, value.text.length, fileName);
        // A gap takes memory like any cell.
        cells += Math.max(0, column - row.length);
        if (cells > MAX_CELLS) throw new XlsxRefused(`${fileName} has more cells than ZLens compares.`);
        while (row.length < column) {
          row.push('');
          fullRow.push(undefined);
        }
        row[column] = value.text;
        fullRow[column] = value.full;
      }
      column += 1;
      cursor = cellEnd + 1;
    }
    rows.push(row);
    full.push(fullRow);
    rowNumbers.push(rowNumber);
    at = rowEnd + rowClose.length;
  }
  fillMerges(xml, stop, prefix, rows, full, rowNumbers, context);
  return { rows, full };
}

/** The text of the next `<name>`, forward from `from`. A regular expression here would let a crafted cell take minutes. */
function nextElement(xml: string, name: string, from: number): { text: string; end: number } | null {
  const open = `<${name}`;
  const close = `</${name}>`;
  let at = from;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return null;
    if (!endsName(xml.charCodeAt(start + open.length))) {
      at = start + open.length;
      continue;
    }
    const headEnd = xml.indexOf('>', start);
    if (headEnd < 0) return null;
    if (xml.charCodeAt(headEnd - 1) === 0x2f) {
      at = headEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, headEnd);
    return end < 0 ? null : { text: xml.slice(headEnd + 1, end), end: end + close.length };
  }
}

function withoutElement(xml: string, name: string): string {
  const open = `<${name}`;
  const close = `</${name}>`;
  const kept: string[] = [];
  let at = 0;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) break;
    kept.push(xml.slice(at, start));
    const end = xml.indexOf(close, start);
    if (end < 0) return kept.join('');
    at = end + close.length;
  }
  return kept.length ? kept.join('') + xml.slice(at) : xml;
}

function cellValue(inner: string, type: string, style: number, prefix: string, context: ScanContext): { text: string; full?: FullValue } {
  if (type === 'inlineStr') return { text: textOfRuns(inner, prefix) };
  const raw = nextElement(inner, `${prefix}v`, 0)?.text ?? '';
  if (type === 's') return { text: context.strings[Number(raw)] ?? '' };
  if (type === 'b') return { text: raw === '1' ? 'true' : 'false' };
  if (type === 'd') return { text: plainText(raw).replace(/T00:00:00(?:\.0+)?Z?$/, '') };
  if (type === 'str' || type === 'e') return { text: plainText(raw) };
  const value = Number(raw);
  if (raw === '' || !Number.isFinite(value)) return { text: plainText(raw) };
  const kind = context.kinds.get(style);
  if (typeof kind === 'number') {
    // `00000`: a code printed with its zeros, which is what the old report shows.
    if (Number.isInteger(value) && value >= 0) return { text: digits(value).padStart(kind, '0') };
  } else if (kind && kind !== 'percent' && value >= 0 && value <= LAST_EXCEL_DATE) {
    return { text: dateFromSerial(value, context.date1904, kind) };
  }
  return { text: digits(value), full: kind === 'percent' ? 'percent' : 'number' };
}

/** A number as a person writes it: `0.1` for Excel's `0.10000000000000001`, digits for `1.2E-5`. */
function digits(value: number): string {
  const text = String(value);
  if (!text.includes('e')) return text;
  return Math.abs(value) >= 1e21 ? BigInt(value).toString() : value.toFixed(100).replace(/\.?0+$/, '');
}

/** Every `<t>` of a string, but not the phonetic guides in `<rPh>`. */
function textOfRuns(inner: string, prefix: string): string {
  const visible = withoutElement(inner, `${prefix}rPh`);
  const runs: string[] = [];
  let at = 0;
  for (;;) {
    const run = nextElement(visible, `${prefix}t`, at);
    if (!run) return runs.join('');
    runs.push(plainText(run.text));
    at = run.end;
  }
}

function scanSharedStrings(xml: Buffer, fileName: string, budget: ScanBudget): string[] {
  const strings: string[] = [];
  const prefix = tagPrefix(xml, 'sst');
  const [itemOpen, itemClose] = [`<${prefix}si`, `</${prefix}si>`];
  let at = 0;
  for (;;) {
    const open = xml.indexOf(itemOpen, at);
    if (open < 0) break;
    const headEnd = xml.indexOf('>', open);
    if (headEnd < 0) break;
    if (xml[headEnd - 1] === 0x2f) {
      strings.push('');
      at = headEnd + 1;
    } else {
      const close = xml.indexOf(itemClose, headEnd);
      if (close < 0) break;
      const text = textOfRuns(xml.toString('utf8', headEnd + 1, close), prefix);
      spendText(budget, text.length, fileName);
      strings.push(text);
      at = close + itemClose.length;
    }
    if (strings.length > MAX_SHARED_STRINGS) throw new XlsxRefused(`${fileName} has more text values than ZLens compares.`);
  }
  return strings;
}

/** A date's grain, a percent, or how many digits a `00000` format prints. */
type StyleKind = 'day' | 'month' | 'year' | 'percent' | number;

const BUILT_IN_FORMATS = new Map<number, StyleKind>([
  [9, 'percent'], [10, 'percent'],
  [14, 'day'], [15, 'day'], [16, 'day'], [17, 'month'], [18, 'day'], [19, 'day'], [20, 'day'], [21, 'day'], [22, 'day'],
  [45, 'day'], [46, 'day'], [47, 'day'],
  // East Asian dates.
  ...[27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58].map((id): [number, StyleKind] => [id, 'day']),
]);

/** What each cell style's number format says the value is. A date's format says its grain: `mmm yyyy` is a month. */
function styleKinds(xml: string): Map<number, StyleKind> {
  const root = parseXml(xml);
  const sheet = child(root, 'styleSheet') ?? root;
  // Only the styleSheet's own: a conditional format can reuse an id for something else.
  const custom = new Map((child(sheet, 'numFmts')?.children ?? []).filter((format) => format.name === 'numFmt').map((format) => [Number(format.attributes.numFmtId), format.attributes.formatCode ?? '']));
  const kinds = new Map<number, StyleKind>();
  (child(sheet, 'cellXfs')?.children ?? []).filter((xf) => xf.name === 'xf').forEach((xf, index) => {
    const id = Number(xf.attributes.numFmtId ?? 0);
    const kind = custom.has(id) ? kindOfFormat(custom.get(id)!) : BUILT_IN_FORMATS.get(id);
    if (kind !== undefined) kinds.set(index, kind);
  });
  return kinds;
}

function kindOfFormat(code: string): StyleKind | undefined {
  // `[h]:mm` counts elapsed time: a number, not a date.
  if (/\[(?:h+|m+|s+)\]/i.test(code)) return undefined;
  // Quoted text, [colours and locales], and \escaped or _spaced characters are not part of the format.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\.|[_*]./g, '');
  if (bare.includes('%')) return 'percent';
  if (/^0{2,}$/.test(bare)) return bare.length;
  if (/[dhs]/i.test(bare)) return 'day';
  if (/m/i.test(bare)) return 'month';
  return /y/i.test(bare) ? 'year' : undefined;
}

/** Excel counts days from 1899-12-30 (it believes 1900 was a leap year), or from 1904-01-01 with that flag. */
function dateFromSerial(serial: number, date1904: boolean, kind: StyleKind): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const iso = new Date(epoch + Math.round(serial * 86_400) * 1_000).toISOString();
  if (kind === 'month') return iso.slice(0, 7);
  if (kind === 'year') return iso.slice(0, 4);
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

const MERGE_REF = /\bref=["']([A-Z]+)(\d+):([A-Z]+)(\d+)["']/;

/**
 * A key merged down several rows holds its value only in the first: each row
 * gets it back. A number is left alone, since it would count as a value twice.
 */
function fillMerges(xml: Buffer, from: number, prefix: string, rows: string[][], full: XlsxSheet['full'], rowNumbers: number[], context: ScanContext): void {
  const tail = xml.toString('latin1', from, Math.min(xml.length, from + 8 * 1024 * 1024));
  const open = `<${prefix}mergeCell`;
  const rowAt = new Map(rowNumbers.map((number, index) => [number, index]));
  const lastRow = rowNumbers.reduce((most, number) => Math.max(most, number), 0);
  let filled = 0;
  const spend = (cells: number) => {
    filled += cells;
    if (filled > MAX_CELLS) throw new XlsxRefused(`${context.fileName} has more merged cells than ZLens compares.`);
  };
  let at = 0;
  for (;;) {
    const start = tail.indexOf(open, at);
    if (start < 0) return;
    const headEnd = tail.indexOf('>', start);
    if (headEnd < 0) return;
    at = headEnd + 1;
    const match = MERGE_REF.exec(tail.slice(start, headEnd));
    if (!match) continue;
    const [top, bottom] = [Number(match[2]), Number(match[4])];
    // Across one row it is a title or a heading, not a key.
    if (top === bottom) continue;
    const [left, right] = [columnIndex(match[1]!), Math.min(columnIndex(match[3]!), MAX_COLUMNS - 1)];
    const first = rowAt.get(top);
    if (first === undefined || left >= MAX_COLUMNS) continue;
    const value = rows[first]?.[left] ?? '';
    if (!value || full[first]?.[left]) continue;
    for (let number = top; number <= Math.min(bottom, lastRow); number += 1) {
      spend(1);
      const index = rowAt.get(number);
      if (index === undefined) continue;
      for (let column = left; column <= right; column += 1) {
        spend(Math.max(1, column + 1 - rows[index]!.length));
        while (rows[index]!.length <= column) {
          rows[index]!.push('');
          full[index]!.push(undefined);
        }
        if (!rows[index]![column]) rows[index]![column] = value;
      }
    }
  }
}

/** Element text as it reads: CDATA as written, and everything else decoded. */
function plainText(text: string): string {
  if (!text.includes('<![CDATA[')) return decodeXml(text);
  let out = '';
  let at = 0;
  for (;;) {
    const start = text.indexOf('<![CDATA[', at);
    const end = start < 0 ? -1 : text.indexOf(']]>', start);
    if (end < 0) return out + decodeXml(text.slice(at));
    out += decodeXml(text.slice(at, start)) + text.slice(start + 9, end);
    at = end + 3;
  }
}

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_whole, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    // Excel's own escape for control characters.
    .replace(/_x([0-9A-F]{4})_/g, (_whole, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}
