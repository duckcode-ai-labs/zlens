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
import { matchWords, readMatchRecords, type MatchRecord } from './record.js';
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
 * The record that speaks for a metric or a query, from its records, newest
 * first. One report's newest stands for that report, unless it only looked
 * narrower at a question that had differed. Across reports, the worst stands: a
 * match with one report does not answer a difference with another.
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

/** The record that stands, none when there are no records, or `unreadable` when the file can't be read. */
export function latestMatch(projectRoot: string, kind: 'metric' | 'query', name: string): MatchRecord | 'unreadable' | undefined {
  try {
    return standingRecord(readMatchRecords(projectRoot, kind, name));
  } catch {
    return 'unreadable';
  }
}

export const UNREADABLE_RECORD = 'The record of its comparison with the old report can\'t be read.';

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
  return record.verdict === 'matches' && record.scope === 'all rows' ? { checks: [words], warnings: [] } : { checks: [], warnings: [words] };
}
