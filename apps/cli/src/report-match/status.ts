import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSemanticDimensionDraftsFromDir,
  loadSemanticLayerFromDir,
  loadSemanticMetricDraftsFromDir,
  type CubeDefinition,
  type DimensionDefinition,
  type MetricDefinition,
  type SemanticLayer,
} from '@zlens/core';
import type { Verdict } from './compare.js';
import { matchWords, mergeMatchRecords, queryMatchRecordsFor, readMatchRecords, receiptLineNames, receiptMatchWords, type MatchRecord } from './record.js';
import { comparisonLayer, queryFingerprint } from './run.js';

/**
 * Whether a comparison still speaks for what it compared. A record holds a hash
 * of the compiled SQL, so approving or certifying does not disturb it, and
 * changing a ratio's part does.
 */

export interface MatchStatus {
  verdict: Verdict;
  words: string;
  /** Changed since compared: the same question no longer compiles to the same SQL. */
  changed: boolean;
  /** The record file can't be read, so a Differs could be hiding in it. */
  unreadable?: boolean;
}

export interface MatchCatalog {
  metrics: MetricDefinition[];
  dimensions: DimensionDefinition[];
  cubes?: CubeDefinition[];
}

/** Approved metrics and dimensions, and the drafts none of them has replaced. */
export function catalogWithDrafts(projectRoot: string, approved?: MatchCatalog): MatchCatalog {
  const semanticDir = join(projectRoot, 'semantic-layer');
  if (!existsSync(semanticDir)) return approved ?? { metrics: [], dimensions: [] };
  const layer = approved ? null : loadSemanticLayerFromDir(semanticDir);
  const metrics = approved?.metrics ?? layer!.listMetrics();
  const dimensions = approved?.dimensions ?? layer!.listDimensions();
  const cubes = approved?.cubes ?? layer?.listCubes() ?? [];
  const metricNames = new Set(metrics.map((metric) => metric.name.toLowerCase()));
  const dimensionNames = new Set(dimensions.map((dimension) => dimension.name.toLowerCase()));
  return {
    cubes,
    // A draft a metric has replaced is not a second meaning of its name.
    metrics: [...metrics, ...loadSemanticMetricDraftsFromDir(semanticDir).filter((draft) => !metricNames.has(draft.name.toLowerCase()))],
    dimensions: [...dimensions, ...loadSemanticDimensionDraftsFromDir(semanticDir).filter((draft) => !dimensionNames.has(draft.name.toLowerCase()))],
  };
}

const SEVERITY: Record<Verdict, number> = { matches: 0, 'not-proven': 1, differs: 2 };

/** A narrower look at the same question: fewer rows, or only the file's own. */
function isNarrower(record: MatchRecord, than: MatchRecord): boolean {
  if (record.querySha256 !== than.querySha256) return false;
  return (record.rows?.inFile ?? 0) < (than.rows?.inFile ?? 0) || (record.scope !== 'all rows' && than.scope === 'all rows');
}

/**
 * The record that speaks for a metric, from its records, newest first. One
 * report's newest stands for that report, unless it only looked narrower at a
 * question that had differed. Across reports, the worst stands: a metric is in
 * several reports, each a different question (by region, by month), and a match
 * with one does not answer a difference with another. A saved query is one
 * question whatever file it is compared with: queryStandingRecord.
 */
export function standingRecord(records: MatchRecord[]): MatchRecord | undefined {
  const reports = new Set(records.map((record) => record.report));
  let standing: MatchRecord | undefined;
  for (const report of reports) {
    const sameReport = records.filter((record) => record.report === report);
    const newest = sameReport[0]!;
    const held = newest.verdict === 'differs' ? newest : sameReport.find((older) => older.verdict === 'differs' && isNarrower(newest, older)) ?? newest;
    if (!standing || SEVERITY[held.verdict] > SEVERITY[standing.verdict]) standing = held;
  }
  return standing;
}

/**
 * The comparison in effect for a saved query, from its records, newest first:
 * the last one made, whichever file it was with. Earlier ones are history. A
 * query compared with the old report (Matches), with an edited copy (Differs),
 * then with the old report again (Matches) is in effect Matches with the old
 * report (V2 retest, 11 Nov: the worst per file stood, so the receipt named the
 * edited copy). One exception keeps a difference from being hidden: a later look
 * at fewer rows of the same SQL does not replace a Differs it may not have seen.
 */
export function queryStandingRecord(records: MatchRecord[]): MatchRecord | undefined {
  let standing: MatchRecord | undefined;
  for (const record of [...records].reverse()) {
    const hidesDifference = standing?.verdict === 'differs' && record.verdict !== 'differs' && isNarrower(record, standing);
    if (!hidesDifference) standing = record;
  }
  return standing;
}

/** The record that stands, none when there are no records, or `unreadable` when the file can't be read. */
export function latestMatch(projectRoot: string, kind: 'metric' | 'query', name: string): MatchRecord | 'unreadable' | undefined {
  try {
    const records = readMatchRecords(projectRoot, kind, name);
    return kind === 'query' ? queryStandingRecord(records) : standingRecord(records);
  } catch {
    return 'unreadable';
  }
}

export const UNREADABLE_RECORD = 'The record of its comparison with the old report can\'t be read.';

/**
 * The record that speaks for a saved query, wherever it was filed. A query is
 * compared under the name it has then, and may be renamed before it is
 * certified, so its own records are those under each name it has had. When the
 * query's compiled SQL is known (`querySha256`), its records of exactly this SQL
 * stand; with none, a comparison of exactly this SQL filed under another name
 * speaks for it, because the same SQL gives the same rows. Otherwise its own
 * newest stands, and the receipt says it was for another version.
 */
export function queryMatchFor(projectRoot: string, names: Array<string | undefined>, querySha256?: string): MatchRecord | 'unreadable' | undefined {
  const own: MatchRecord[][] = [];
  for (const name of Array.from(new Set(names.map((item) => item?.trim()).filter((item): item is string => Boolean(item))))) {
    try {
      own.push(readMatchRecords(projectRoot, 'query', name));
    } catch {
      return 'unreadable';
    }
  }
  const records = mergeMatchRecords(...own);
  if (querySha256) {
    const current = records.filter((record) => record.querySha256 === querySha256);
    if (current.length) return queryStandingRecord(current);
    const elsewhere = queryMatchRecordsFor(projectRoot, querySha256);
    if (elsewhere.length) return queryStandingRecord(elsewhere);
  }
  return queryStandingRecord(records);
}

export function metricMatchStatus(projectRoot: string, name: string, catalog: MatchCatalog): MatchStatus | undefined {
  const record = latestMatch(projectRoot, 'metric', name);
  if (!record) return undefined;
  if (record === 'unreadable') return { verdict: 'not-proven', words: UNREADABLE_RECORD, changed: false, unreadable: true };
  return { verdict: record.verdict, words: matchWords(record), changed: metricChanged(record, name, catalog) };
}

function metricChanged(record: MatchRecord, name: string, catalog: MatchCatalog): boolean {
  if (!record.asked) return false;
  const { dimensions, timeDimension, filters, throwaway } = record.asked;
  try {
    const composed = comparisonLayer(catalog, throwaway).composeQuery({
      metrics: [name],
      dimensions,
      ...(timeDimension ? { timeDimension } : {}),
      filters,
      // The driver it was compared on: another connection does not change the definition.
      driver: record.connection.driver,
    } as Parameters<SemanticLayer['composeQuery']>[0]);
    return queryFingerprint(composed?.sql ?? '', filters) !== record.querySha256;
  } catch {
    return true;
  }
}

export function queryChanged(record: MatchRecord, sql: string, variables: unknown): boolean {
  return queryFingerprint(sql, variables) !== record.querySha256;
}

/**
 * What a certification receipt says about a comparison. Only a current match of
 * every row counts as a passed check. Anything else is a warning, and so is a
 * match that could not be checked (`changed` undefined) or came from elsewhere.
 */
export function receiptLines(record: MatchRecord, changed: boolean | undefined, sameConnection = true): { checks: string[]; warnings: string[] } {
  const words = matchWords(record);
  if (changed === undefined) return { checks: [], warnings: [`${words}. Not checked against this version of the query.`] };
  if (changed) return { checks: [], warnings: [`${words}. Changed since compared.`] };
  if (!sameConnection) return { checks: [], warnings: [`${words}. Compared on another connection.`] };
  return record.verdict === 'matches' && record.scope === 'all rows' ? { checks: [receiptMatchWords(record)], warnings: [] } : { checks: [], warnings: [words] };
}

/** A receipt line that adds why its comparison could not count as passed. */
const QUALIFIED_LINE = /\. (Changed since compared|Not checked against this version of the query|Compared on another connection)\.$/;

/**
 * How a receipt said a Differs or a Not proven before V2: the count of equal values, straight after the day
 * ("Differs from X, 2026-11-11: 4 of 5 values at whole numbers"). Lines written since say what they count
 * ("1 of 5 values differs", "3 of 5 values equal", "4 of 5 rows found"), so they never look like this. The page
 * says such a line in today's count (SavedQueryReportCheck.tsx, receiptLineWords).
 */
const OLD_RECEIPT_COUNT = /^(Differs from |Not proven against ).*, \d{4}-\d{2}-\d{2}: \d+ of \d+ values at /;

/** What a receipt says about the old report, rebuilt from the records: the lines it replaces, and the lines in their place. */
export interface ReceiptCorrection {
  replaces: string[];
  checks: string[];
  warnings: string[];
}

/**
 * A receipt written before queryStandingRecord can name the wrong comparison: certifying took the worst newest
 * comparison per file, so a query compared with the old report, with an edited copy, and with the old report
 * again was certified as "Differs from <the edited copy>" (V2 retest, 11 Nov). This rebuilds that line as
 * certifying would write it now: from the comparisons made before it was certified, of the same SQL as the one
 * the line names (the line says nothing changed, so that was the SQL then), on the same connection. Undefined
 * when the receipt's line stands, was written since, or can't be traced to a record.
 */
export function receiptCorrection(records: MatchRecord[], receipt: { certifiedAt?: string; checks?: string[]; warnings?: string[] }): ReceiptCorrection | undefined {
  const certifiedAt = Date.parse(receipt.certifiedAt ?? '');
  if (!Number.isFinite(certifiedAt)) return undefined;
  const old = [...(receipt.checks ?? []), ...(receipt.warnings ?? [])].filter((line) => OLD_RECEIPT_COUNT.test(line));
  // A receipt names one comparison; a line that says why it did not count is kept as written.
  if (old.length !== 1 || QUALIFIED_LINE.test(old[0]!)) return undefined;
  const line = old[0]!;
  const before = records.filter((record) => Date.parse(record.comparedAt) <= certifiedAt);
  const named = before.find((record) => receiptLineNames(line, record));
  if (!named) return undefined;
  const inEffect = queryStandingRecord(before.filter((record) => record.querySha256 === named.querySha256));
  if (!inEffect || inEffect === named) return undefined;
  const sameConnection = inEffect.connection?.driver === named.connection?.driver && (inEffect.connection?.database ?? '') === (named.connection?.database ?? '');
  return { replaces: [line], ...receiptLines(inEffect, false, sameConnection) };
}
