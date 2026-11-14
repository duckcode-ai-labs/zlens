import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DimensionDefinition } from '@zlens/core';
import * as yaml from 'js-yaml';
import { keyWords, type Verdict } from './compare.js';
import { maskedFilters, type CompareOutcome } from './run.js';

/**
 * What stays after a comparison. Records are their own tracked files, one per
 * metric or saved query, holding counts and fingerprints and never a value.
 * The differences, with their values, go to a per-person file git ignores: on
 * a server they were computed under that person's row rules.
 */

export interface MatchRecord {
  report: string;
  tool?: string;
  worksheet?: string;
  file: { name: string; sha256: string; rows: number };
  comparedAt: string;
  comparedBy: string;
  via: string;
  connection: { driver: string; database?: string };
  /** A hash of the compiled SQL and filters: when it no longer matches, the record shows Changed since compared. */
  querySha256: string;
  /** A metric's question, to compile it again and check that hash. Its filters hold placeholders, not values. */
  asked?: {
    dimensions: string[];
    timeDimension?: { name: string; granularity: string };
    filters: Array<{ dimension: string; operator: string; values: string[] }>;
    throwaway?: DimensionDefinition[];
  };
  /** A saved query's parameters that were set, by name. */
  parameterNames?: string[];
  mapping: Record<string, string>;
  filters: { stated: string[]; waived: string[] };
  scope: string;
  rows: CompareOutcome['comparison']['rows'];
  values: { compared: number; equal: number };
  precision: string;
  tolerance: string;
  verdict: Verdict;
}

const MAX_RECORDS = 20;
const MAX_DETAILS = 50;

function recordFile(projectRoot: string, kind: 'metric' | 'query', name: string): string {
  const plain = /^[A-Za-z0-9_-]+$/.test(name);
  const file = plain ? name : `${name.replace(/[^A-Za-z0-9_-]+/g, '-')}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
  return join(projectRoot, 'semantic-layer', 'report-matches', kind, `${file}.yaml`);
}

/** Newest first, by when each was compared, not when it was written. Throws on a file it can't read. */
export function readMatchRecords(projectRoot: string, kind: 'metric' | 'query', name: string): MatchRecord[] {
  const file = recordFile(projectRoot, kind, name);
  if (!existsSync(file)) return [];
  const parsed = yaml.load(readFileSync(file, 'utf-8'), { schema: yaml.JSON_SCHEMA }) as { matches?: MatchRecord[] } | null;
  const matches = parsed?.matches;
  if (!Array.isArray(matches) || !matches.every((record) => ['matches', 'differs', 'not-proven'].includes(record?.verdict))) {
    throw new Error(`The record file for ${name} can't be read. Fix it, or delete it and compare again.`);
  }
  return newestFirst(matches);
}

const newestFirst = (records: MatchRecord[]) => [...records].sort((a, b) => String(b.comparedAt).localeCompare(String(a.comparedAt)));

/** One comparison is one record, whichever name's file it was read from. */
const sameComparison = (a: MatchRecord, b: MatchRecord) => a.comparedAt === b.comparedAt && a.file?.sha256 === b.file?.sha256 && a.querySha256 === b.querySha256;

/** Records from several files, each comparison once, newest first. */
export function mergeMatchRecords(...lists: MatchRecord[][]): MatchRecord[] {
  const merged: MatchRecord[] = [];
  for (const record of lists.flat()) if (!merged.some((kept) => sameComparison(kept, record))) merged.push(record);
  return newestFirst(merged);
}

/**
 * A saved query renamed keeps its comparisons: its records move to the new
 * name's file, joining any already there. Nothing happens when the name is the
 * same, or the old name has no records. Throws on a file it can't read, like
 * readMatchRecords, and then moves nothing.
 */
export function moveMatchRecords(projectRoot: string, kind: 'metric' | 'query', from: string, to: string): boolean {
  const fromFile = recordFile(projectRoot, kind, from);
  const toFile = recordFile(projectRoot, kind, to);
  if (!from.trim() || !to.trim() || fromFile === toFile || !existsSync(fromFile)) return false;
  const matches = mergeMatchRecords(readMatchRecords(projectRoot, kind, to), readMatchRecords(projectRoot, kind, from)).slice(0, MAX_RECORDS);
  // Removed first: on a disk that ignores case, `Revenue` and `revenue` are one file.
  rmSync(fromFile, { force: true });
  mkdirSync(dirname(toFile), { recursive: true });
  writeFileSync(toFile, yaml.dump({ matches }, { lineWidth: 200, noRefs: true }), 'utf-8');
  return true;
}

/**
 * Every saved query comparison whose compiled SQL hashes to `querySha256`,
 * whatever name it was filed under: the same SQL gives the same rows, so the
 * comparison speaks for any saved query that runs it. Files it can't read are
 * skipped.
 */
export function queryMatchRecordsFor(projectRoot: string, querySha256: string): MatchRecord[] {
  const dir = join(projectRoot, 'semantic-layer', 'report-matches', 'query');
  if (!querySha256 || !existsSync(dir)) return [];
  const found: MatchRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml')) continue;
    try {
      const parsed = yaml.load(readFileSync(join(dir, entry), 'utf-8'), { schema: yaml.JSON_SCHEMA }) as { matches?: MatchRecord[] } | null;
      for (const record of Array.isArray(parsed?.matches) ? parsed!.matches : []) {
        if (record?.querySha256 === querySha256 && ['matches', 'differs', 'not-proven'].includes(record.verdict)) found.push(record);
      }
    } catch {
      // Another query's unreadable file says nothing about this one.
    }
  }
  return mergeMatchRecords(found);
}

/** One record per metric compared, or one for the saved query. Newest first. */
export function writeMatchRecords(projectRoot: string, outcome: CompareOutcome, who: { comparedBy: string; via: string }): string[] {
  const shared = {
    report: outcome.report,
    ...(outcome.tool ? { tool: outcome.tool } : {}),
    ...(outcome.worksheet ? { worksheet: outcome.worksheet } : {}),
    file: outcome.file,
    comparedAt: outcome.comparedAt,
    comparedBy: who.comparedBy,
    via: who.via,
    connection: outcome.connection,
    mapping: outcome.mapping,
    filters: { stated: outcome.filters.shape, waived: outcome.filters.waived },
    scope: outcome.scope,
    rows: outcome.comparison.rows,
    tolerance: outcome.tolerance ?? 'none',
  };
  const write = (kind: 'metric' | 'query', name: string, record: MatchRecord) => {
    const file = recordFile(projectRoot, kind, name);
    mkdirSync(dirname(file), { recursive: true });
    const matches = newestFirst([record, ...readMatchRecords(projectRoot, kind, name)]).slice(0, MAX_RECORDS);
    writeFileSync(file, yaml.dump({ matches }, { lineWidth: 200, noRefs: true }), 'utf-8');
    return file.slice(projectRoot.length + 1).replaceAll('\\', '/');
  };
  if (outcome.target.kind === 'query') {
    const { compared, equal } = outcome.comparison.values;
    return [write('query', outcome.target.name, {
      ...shared,
      querySha256: outcome.querySha256.query!,
      ...(Object.keys(outcome.target.parameters).length ? { parameterNames: Object.keys(outcome.target.parameters) } : {}),
      values: { compared, equal },
      precision: Array.from(new Set(outcome.comparison.numbers.map((number) => number.precision))).join('; ') || 'nothing compared',
      verdict: outcome.comparison.verdict,
    })];
  }
  // Each metric on its own, so one does not inherit another's difference.
  const { dimensions, timeDimension, filters, throwaway } = outcome.target;
  const asked = { dimensions, ...(timeDimension ? { timeDimension } : {}), filters: maskedFilters(filters), ...(throwaway ? { throwaway } : {}) };
  return outcome.comparison.numbers.map((number) => write('metric', number.name, {
    ...shared,
    querySha256: outcome.querySha256[number.name]!,
    asked,
    values: { compared: number.compared, equal: number.equal },
    precision: number.precision,
    verdict: number.verdict,
  }));
}

/** The day a comparison was made, on this computer's calendar, as a receipt's byline dates it. */
function comparedDay(comparedAt: string): string {
  const date = new Date(comparedAt);
  if (Number.isNaN(date.getTime())) return String(comparedAt).slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const toolWords = (record: MatchRecord) => (record.tool === 'tableau' ? ' (Tableau)' : record.tool === 'powerbi' ? ' (Power BI)' : '');

/**
 * A full match on a receipt: "Matches Sales by Region · every value compared
 * (4 of 4 at 2 decimals, 2026-11-02)". Only when nothing was left out, waived
 * or narrowed; otherwise matchWords says what was.
 */
export function receiptMatchWords(record: MatchRecord): string {
  const { compared, equal } = record.values ?? { compared: 0, equal: 0 };
  const everyValue = record.verdict === 'matches' && record.scope === 'all rows' && compared > 0 && equal === compared
    && !Object.values(record.mapping ?? {}).some((meaning) => /^(left out|not compared)/.test(meaning))
    && !(record.filters?.waived.length);
  if (!everyValue) return matchWords(record);
  return `Matches ${record.report}${toolWords(record)} · every value compared (${equal} of ${compared} at ${record.precision}, ${comparedDay(record.comparedAt)})`;
}

/** A record in words: for a receipt, or beside a draft. */
export function matchWords(record: MatchRecord): string {
  const tool = toolWords(record);
  const verdict = record.verdict === 'matches' ? 'Matches' : record.verdict === 'differs' ? 'Differs from' : 'Not proven against';
  const leftOut = Object.entries(record.mapping ?? {}).filter(([, meaning]) => meaning === 'left out, as asked').map(([column]) => column);
  const waived = record.filters?.waived.length ?? 0;
  const limits = [
    ...(record.scope === 'all rows' ? [] : [`only ${record.scope}`]),
    ...(leftOut.length ? [`left out: ${leftOut.join(', ')}`] : []),
    ...(waived ? [`${waived} filter${waived === 1 ? '' : 's'} waived`] : []),
  ];
  return `${verdict} ${record.report}${tool}, ${comparedDay(record.comparedAt)}: ${record.values.equal} of ${record.values.compared} values at ${record.precision}${limits.map((limit) => `, ${limit}`).join('')}`;
}

// ── Per-person detail ───────────────────────────────────────────────────────

function detailFile(projectRoot: string, person: string, id: string): string {
  if (!/^cmp_[a-f0-9]+$/.test(id)) throw new Error(`Invalid comparison id: ${id}`);
  return join(projectRoot, '.dql', 'local', 'private', 'comparisons', person, `${id}.json`);
}

export function writeComparisonDetail(projectRoot: string, person: string, outcome: CompareOutcome): void {
  const file = detailFile(projectRoot, person, outcome.id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(outcome)}\n`, 'utf-8');
  // Each holds values from the old report, so they don't pile up.
  const kept = readdirSync(dirname(file))
    .map((name) => join(dirname(file), name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const old of kept.slice(MAX_DETAILS)) rmSync(old, { force: true });
}

export function readComparisonDetail(projectRoot: string, person: string, id: string): CompareOutcome | null {
  const file = detailFile(projectRoot, person, id);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) as CompareOutcome : null;
}

// ── The report ──────────────────────────────────────────────────────────────

const VERDICT_WORDS: Record<Verdict, string> = { matches: 'Matches', differs: 'Differs', 'not-proven': 'Not proven' };
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function verdictWords(verdict: Verdict): string {
  return VERDICT_WORDS[verdict];
}

/** What a reader must know to weigh a verdict. */
function limitsOf(outcome: CompareOutcome): string[] {
  const leftOut = Object.entries(outcome.mapping).filter(([, meaning]) => meaning === 'left out, as asked').map(([column]) => column);
  return [
    ...(outcome.scope === 'all rows' ? [] : [`only ${outcome.scope}`]),
    ...(outcome.tolerance ? [`within ${outcome.tolerance}`] : []),
    ...(leftOut.length ? [`left out: ${cell(leftOut.join(', '))}`] : []),
  ];
}

/** The page a migration lead hands over. Unlike a record it holds values, because a person chose to write it. */
export function matchReportMarkdown(outcomes: CompareOutcome[], stopped: Array<{ file: string; reason: string }>, writtenAt: string): string {
  const out: string[] = ['# Old report comparison', ''];
  const count = (verdict: Verdict) => outcomes.filter((outcome) => outcome.comparison.verdict === verdict).length;
  const total = outcomes.length + stopped.length;
  out.push(`Written ${writtenAt.slice(0, 10)} by \`zlens migrate compare\`: ${count('matches')} of ${total} exports match, ${count('differs')} ${count('differs') === 1 ? 'differs' : 'differ'}, ${count('not-proven')} not proven${stopped.length ? `, ${stopped.length} could not be compared` : ''}.`, '');
  out.push('A match says the export and ZLens agree at the precision the file prints, with the filters listed. It says nothing about reports not compared here.', '');
  out.push('| Export | Verdict | Rows | Values | Filters | Compared with |', '|---|---|---:|---:|---|---|');
  for (const outcome of outcomes) {
    const { rows, values, verdict } = outcome.comparison;
    const compared = outcome.target.kind === 'query' ? `saved query ${outcome.target.name}` : outcome.target.metrics.join(', ');
    const filters = [...outcome.filters.stated, ...outcome.filters.waived.map((text) => `waived ${text}`)].join('; ') || 'none stated';
    out.push(`| ${cell(outcome.report)} | ${[VERDICT_WORDS[verdict], ...limitsOf(outcome)].join('; ')} | ${rows.inBoth} of ${rows.inFile} | ${values.equal} of ${values.compared} | ${cell(filters)} | ${cell(compared)} |`);
  }
  for (const item of stopped) out.push(`| ${cell(item.file)} | Could not be compared | | | | ${cell(item.reason)} |`);
  out.push('');
  for (const outcome of outcomes) {
    const { comparison } = outcome;
    if (comparison.verdict === 'matches') continue;
    out.push(`## ${outcome.report}: ${VERDICT_WORDS[comparison.verdict]}`, '');
    for (const missing of comparison.missing) out.push(`- ${missing}`);
    for (const reason of comparison.reasons) out.push(`- Possible reason: ${reason}`);
    if (comparison.missing.length || comparison.reasons.length) out.push('');
    if (comparison.differences.length) {
      out.push('| Row | Column | Old report | ZLens |', '|---|---|---:|---:|');
      for (const item of comparison.differences.slice(0, 200)) out.push(`| ${cell(keyWords(item.key))} | ${cell(item.column)} | ${cell(item.old || '(empty)')} | ${item.zlens ?? '(empty)'} |`);
      if (comparison.differences.length > 200) out.push('', `…and ${comparison.differences.length - 200} more.`);
      out.push('');
    }
    if (comparison.onlyInFile.length) out.push(`Only in the export: ${comparison.onlyInFile.slice(0, 20).map(keyWords).join(', ')}`, '');
    if (comparison.onlyInZLens.length) out.push(`Only in ZLens: ${comparison.onlyInZLens.slice(0, 20).map(keyWords).join(', ')}`, '');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** The report's default file name, beside where the command runs. */
export const DEFAULT_MATCH_REPORT = 'zlens-migration-match.md';
