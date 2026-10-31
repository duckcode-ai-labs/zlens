import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as yaml from 'js-yaml';
import { keyWords, type Verdict } from './compare.js';
import type { CompareOutcome } from './run.js';

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

export function readMatchRecords(projectRoot: string, kind: 'metric' | 'query', name: string): MatchRecord[] {
  const file = recordFile(projectRoot, kind, name);
  if (!existsSync(file)) return [];
  const parsed = yaml.load(readFileSync(file, 'utf-8'), { schema: yaml.JSON_SCHEMA }) as { matches?: MatchRecord[] } | null;
  return Array.isArray(parsed?.matches) ? parsed.matches : [];
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
    filters: { stated: outcome.filters.stated, waived: outcome.filters.waived },
    scope: outcome.scope,
    rows: outcome.comparison.rows,
    tolerance: outcome.tolerance ?? 'none',
  };
  const write = (kind: 'metric' | 'query', name: string, record: MatchRecord) => {
    const file = recordFile(projectRoot, kind, name);
    mkdirSync(dirname(file), { recursive: true });
    const matches = [record, ...readMatchRecords(projectRoot, kind, name)].slice(0, MAX_RECORDS);
    writeFileSync(file, yaml.dump({ matches }, { lineWidth: 200, noRefs: true }), 'utf-8');
    return file.slice(projectRoot.length + 1).replaceAll('\\', '/');
  };
  if (outcome.target.kind === 'query') {
    const { compared, equal } = outcome.comparison.values;
    return [write('query', outcome.target.name, {
      ...shared,
      querySha256: outcome.querySha256.query!,
      values: { compared, equal },
      precision: Array.from(new Set(outcome.comparison.numbers.map((number) => number.precision))).join('; ') || 'nothing compared',
      verdict: outcome.comparison.verdict,
    })];
  }
  // Each metric on its own, so one does not inherit another's difference.
  return outcome.comparison.numbers.map((number) => write('metric', number.name, {
    ...shared,
    querySha256: outcome.querySha256[number.name]!,
    values: { compared: number.compared, equal: number.equal },
    precision: number.precision,
    verdict: number.verdict,
  }));
}

/** A record in words: for a receipt, or beside a draft. */
export function matchWords(record: MatchRecord): string {
  const tool = record.tool === 'tableau' ? ' (Tableau)' : record.tool === 'powerbi' ? ' (Power BI)' : '';
  const verdict = record.verdict === 'matches' ? 'Matches' : record.verdict === 'differs' ? 'Differs from' : 'Not proven against';
  return `${verdict} ${record.report}${tool}, ${record.comparedAt.slice(0, 10)}: ${record.values.equal} of ${record.values.compared} values at ${record.precision}${record.scope === 'all rows' ? '' : `, ${record.scope}`}`;
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
