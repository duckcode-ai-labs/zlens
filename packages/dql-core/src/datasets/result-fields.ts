/**
 * Fields from a saved query's result (design D1, "everything you add has
 * fields").
 *
 * A saved query is a block with no Dataset definition. Its output columns are
 * offered on the same shelves as a Dataset's, with no review step just to
 * read them: numbers become measures, text and true/false columns become
 * dimensions, and dates become time fields grouped by day, week or month.
 * Tiles compile as one query over the saved query's complete result, through
 * the same tile-query compiler and governed wrapper as any Dataset tile.
 *
 * The roll-up rules:
 *   - A tile that groups by every grouping column of the saved query reads one
 *     result row per output row: values show as they are.
 *   - Any other tile rolls rows up. Numbers default to Sum. A column named
 *     like an average or a ratio (`avg_`, `pct`, `rate`, `ratio`, `_share`,
 *     `margin`…) can't be summed: it shows as it is only at the saved query's
 *     own grouping, and offers Min and Max otherwise. Count of rows is always
 *     available.
 *   - Trust is the saved query's own; a rolled-up tile's receipt says it was
 *     rolled up from the saved query's result.
 *
 * Pure and browser-safe: no SQL runs here. The server reads the column types
 * (the block's declared contract, a run's result, or a one-row read through
 * the ordinary execution path) and calls `savedQueryResultDescriptor`.
 */
import type {
  DatasetDescriptor,
  DatasetField,
  DatasetLifecycle,
  DatasetMeasureField,
  DatasetOperation,
  DatasetPhysicalField,
  DatasetResultOrigin,
} from './descriptor.js';
import { minorUnitOf, nativeTimeGrain, tableColumnKind, wordsFor, type TableColumnKind } from './table-draft.js';
import { sha256Hex } from '../apps/sha256-sync.js';

export interface SavedQueryResultColumn {
  name: string;
  /** A warehouse type (`DOUBLE`, `TIMESTAMP`…) or a column kind (`number`, `date`…). */
  type?: string;
}

/** The reason shown wherever an average or ratio column is kept from being summed. */
export const NON_ADDITIVE_REASON = "Averages can't be added up";

/** The measure that counts the saved query's result rows. */
export const SAVED_QUERY_ROW_COUNT = 'count_of_rows';

const TIME_GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID_NAME = /(^id$|_id$|_key$|_code$|_uuid$|^uuid$|_number$|_no$|^sku$)/i;
const NOT_A_MEASURE = /(^id$|_id$|_key$|_code$|^year$|^month$|^day$|^week$|^quarter$|_year$|_month$|_week$|_quarter$|zip|postal|phone|^lat$|^lon$|^lng$|latitude|longitude|_no$|_number$|^rank$|_rank$|^version$|age$)/i;
const MONEY = /(amount|revenue|sales|price|cost|spend|fee|total|value|income|profit|budget|premium|payment|paid|balance|salary|charge)/i;
const NON_ADDITIVE_WORDS = new Set(['avg', 'average', 'mean', 'median', 'pct', 'percent', 'percentage', 'rate', 'ratio', 'share', 'margin']);

/**
 * True for a column whose values can't be added up across rows: an average,
 * a percentage, a rate, a ratio, a share or a margin, by its name. The names
 * catch common cases, not all of them; the receipt always says a value was
 * rolled up, and "Make row-level" stays available for row-safe measures.
 */
export function isNonAdditiveColumnName(name: string): boolean {
  const words = wordsFor(name).toLowerCase().split(/\s+/).filter(Boolean);
  return words.some((word) => NON_ADDITIVE_WORDS.has(word));
}

/** A column's kind, from a warehouse type or an already-normalised kind. */
export function savedQueryColumnKind(type: string | undefined): TableColumnKind {
  const value = (type ?? '').trim().toLowerCase();
  if (value === 'datetime') return 'timestamp';
  if (value === 'number' || value === 'string' || value === 'boolean' || value === 'date' || value === 'timestamp') return value;
  return tableColumnKind(type);
}

/**
 * The grouping columns of a saved query from its column lineage: the
 * non-aggregate outputs of a query that has aggregate outputs. A query with
 * no aggregate output (plain rows) has none, so no tile reads it "as is".
 */
export function savedQueryGroupByFromOutputs(outputs: ReadonlyArray<{ name: string; isAggregate?: boolean; unresolved?: boolean }> | undefined): string[] {
  if (!outputs?.length || outputs.some((output) => output.unresolved || output.name === '*' || output.name.endsWith('.*'))) return [];
  if (!outputs.some((output) => output.isAggregate)) return [];
  return outputs.filter((output) => !output.isAggregate).map((output) => output.name);
}

/** The time grains a period column can be grouped by: its own period and longer ones. */
function grainsFrom(native: string | undefined): string[] {
  const start = native ? TIME_GRAINS.indexOf(native as typeof TIME_GRAINS[number]) : 0;
  return TIME_GRAINS.slice(Math.max(0, start));
}

/**
 * The fields of a saved query's result. Columns whose names are not plain
 * identifiers are left out (they are returned in `skipped`).
 */
export function savedQueryResultFields(input: {
  sourceId: string;
  columns: ReadonlyArray<SavedQueryResultColumn>;
  groupBy?: ReadonlyArray<string>;
}): { fields: DatasetField[]; asIs: string[]; groupBy: string[]; skipped: string[] } {
  const seen = new Set<string>();
  const columns: Array<{ name: string; kind: TableColumnKind }> = [];
  const skipped: string[] = [];
  for (const column of input.columns) {
    const name = column.name?.trim() ?? '';
    if (!IDENTIFIER.test(name)) {
      if (name) skipped.push(name);
      continue;
    }
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    columns.push({ name, kind: savedQueryColumnKind(column.type) });
  }
  const byName = new Map(columns.map((column) => [column.name.toLowerCase(), column.name]));
  const groupBy = Array.from(new Set((input.groupBy ?? []).flatMap((name) => byName.get(name.trim().toLowerCase()) ?? [])));
  const groupKeys = new Set(groupBy.map((name) => name.toLowerCase()));
  const taken = new Set(columns.map((column) => column.name.toLowerCase()));
  const physical: DatasetPhysicalField[] = [];
  const measures: DatasetMeasureField[] = [];
  const asIs: string[] = [];
  let primaryTime = true;
  const fieldId = (name: string) => `${input.sourceId}::field::${name}`;
  const measureId = (name: string) => `${input.sourceId}::measure::${name}`;
  const measure = (name: string, from: string, aggregation: 'sum' | 'min' | 'max', additive: boolean, format: DatasetMeasureField['format']): DatasetMeasureField => ({
    kind: 'measure',
    name,
    qualifiedId: measureId(name),
    aggregation,
    from,
    dependsOn: [from],
    additivity: additive ? { entities: 'additive', time: 'additive' } : { entities: 'non_additive', time: 'non_additive' },
    allowedAggs: [aggregation],
    ...(format ? { format } : {}),
    status: 'approved',
  });
  for (const column of columns) {
    if (column.kind === 'date' || column.kind === 'timestamp') {
      const native = nativeTimeGrain({ name: column.name, type: column.kind, role: 'time' });
      physical.push({
        kind: 'physical',
        name: column.name,
        qualifiedId: fieldId(column.name),
        type: column.kind,
        role: 'time',
        status: 'approved',
        time: { grains: grainsFrom(native), ...(native ? { baseGrain: native } : {}), ...(primaryTime ? { primary: true } : {}) },
      });
      primaryTime = false;
      continue;
    }
    if (column.kind !== 'number' || groupKeys.has(column.name.toLowerCase()) || NOT_A_MEASURE.test(column.name)) {
      physical.push({
        kind: 'physical',
        name: column.name,
        qualifiedId: fieldId(column.name),
        type: column.kind,
        role: ID_NAME.test(column.name) && column.kind !== 'boolean' ? 'key' : 'dimension',
        status: 'approved',
      });
      continue;
    }
    // A number: kept as a physical column (filters, row detail) and offered as a measure.
    physical.push({ kind: 'physical', name: column.name, qualifiedId: fieldId(column.name), type: 'number', role: 'attribute', status: 'approved' });
    const format: DatasetMeasureField['format'] = MONEY.test(column.name) && !minorUnitOf(column.name)
      ? { kind: 'currency', currency: 'USD' }
      : { kind: 'number' };
    if (!isNonAdditiveColumnName(column.name)) {
      measures.push(measure(column.name, column.name, 'sum', true, format));
      continue;
    }
    // An average or a ratio: as it is at the saved query's own grouping, Min or Max when rolled up.
    measures.push(measure(column.name, column.name, 'max', false, format));
    asIs.push(column.name);
    for (const aggregation of ['min', 'max'] as const) {
      const name = `${aggregation}_${column.name}`;
      if (taken.has(name.toLowerCase())) continue;
      taken.add(name.toLowerCase());
      measures.push(measure(name, column.name, aggregation, true, format));
    }
  }
  const rowCount = taken.has(SAVED_QUERY_ROW_COUNT) ? 'result_row_count' : SAVED_QUERY_ROW_COUNT;
  if (!taken.has(rowCount)) {
    measures.push({
      kind: 'measure',
      name: rowCount,
      qualifiedId: measureId(rowCount),
      aggregation: 'count',
      expression: { kind: 'aggregate', function: 'count', countStar: true },
      expressionFingerprint: 'saved_query_result_count_star_v1',
      dependsOn: [],
      additivity: { entities: 'additive', time: 'additive' },
      allowedAggs: ['count'],
      format: { kind: 'number', decimals: 0 },
      status: 'approved',
    });
  }
  return { fields: [...measures, ...physical], asIs, groupBy, skipped };
}

/**
 * The field contract of a saved query's result, or undefined when no column
 * could be read. The contract fingerprint covers the saved query's revision,
 * its column names and kinds, and its grouping, so a tile authored against
 * one shape never runs silently against another.
 */
export function savedQueryResultDescriptor(input: {
  sourceId: string;
  sourceRevision: string;
  /** The block name. */
  savedQuery: string;
  /** `<domain>::block::<name>`, as the block's Dataset contract would name it. */
  qualifiedId: string;
  domain?: string;
  lifecycle: DatasetLifecycle;
  certified: boolean;
  columns: ReadonlyArray<SavedQueryResultColumn>;
  groupBy?: ReadonlyArray<string>;
  typesFrom: DatasetResultOrigin['typesFrom'];
  /** The saved query's outer `LIMIT`, from {@link savedQueryKeepsFirstRows}. */
  keepsFirstRows?: number;
}): DatasetDescriptor | undefined {
  const derived = savedQueryResultFields({ sourceId: input.sourceId, columns: input.columns, groupBy: input.groupBy });
  if (!derived.fields.some((field) => field.kind === 'physical')) return undefined;
  const fingerprint = `sha256:${sha256Hex(JSON.stringify({
    version: 'saved-query-result-v1',
    sourceRevision: input.sourceRevision,
    columns: derived.fields.filter((field): field is DatasetPhysicalField => field.kind === 'physical').map((field) => [field.name, field.type]),
    groupBy: derived.groupBy,
  }))}`;
  const operations: DatasetOperation[] = ['filter', 'group', 'trend', 'rank', 'having', ...(derived.groupBy.length ? ['detail' as const] : [])];
  return {
    version: 1,
    id: input.sourceId,
    kind: 'block',
    sourceRevision: input.sourceRevision,
    snapshotId: 'target-required',
    contractRef: { kind: 'block_source', id: input.qualifiedId, fingerprint },
    binding: {
      sourceQualifiedId: input.qualifiedId,
      sourceRevision: input.sourceRevision,
      contractFingerprint: fingerprint,
      state: 'target_required',
    },
    label: input.savedQuery,
    ...(input.domain ? { domain: input.domain } : {}),
    lifecycle: input.lifecycle,
    trust: input.certified ? 'certified' : 'review_required',
    grain: {
      entityIds: [`result:${input.qualifiedId}`],
      keyFields: derived.groupBy,
      description: derived.groupBy.length
        ? `One row of ${input.savedQuery} for each ${derived.groupBy.map((name) => wordsFor(name).toLowerCase()).join(' and ')}.`
        : `The rows of ${input.savedQuery}.`,
    },
    fields: derived.fields,
    operations,
    execution: { route: input.certified ? 'certified' : 'governed_sql' },
    result: {
      savedQuery: input.savedQuery,
      groupBy: derived.groupBy,
      asIs: derived.asIs,
      typesFrom: input.typesFrom,
      ...(input.keepsFirstRows ? { keepsFirstRows: input.keepsFirstRows } : {}),
    },
  };
}

export interface SavedQueryRollupCheck {
  /** The tile rolls the saved query's rows up (it does not group by all of its grouping columns). */
  rollsUp: boolean;
  /** Average or ratio measures the tile would have to sum. */
  blocked: Array<{ measure: string; message: string }>;
  /** What the receipt says when the tile rolls rows up. */
  adaptation?: { kind: 'saved_query_rollup'; message: string; topRowsOnly?: number };
}

/**
 * Whether a tile over a saved query's result shows its rows as they are or
 * rolls them up. `measureNames` are every measure the tile reads, including
 * the ones its calculations use. As is: the tile groups by every grouping
 * column of the saved query, each at its own period (a `month` column by
 * month), and asks for no totals.
 */
export function savedQueryResultRollup(
  descriptor: Pick<DatasetDescriptor, 'result' | 'fields' | 'trust'>,
  query: { dimensions: ReadonlyArray<{ field: string; timeGrain?: string }>; detail?: boolean; rollups?: ReadonlyArray<ReadonlyArray<string>> },
  measureNames: ReadonlyArray<string>,
): SavedQueryRollupCheck {
  const result = descriptor.result;
  if (!result || query.detail || measureNames.length === 0) return { rollsUp: false, blocked: [] };
  const physical = (name: string) => descriptor.fields.find((field): field is DatasetPhysicalField => field.kind === 'physical' && field.name.toLowerCase() === name.toLowerCase());
  const asItIs = result.groupBy.length > 0
    && !query.rollups?.length
    && result.groupBy.every((column) => query.dimensions.some((dimension) => {
      if (dimension.field.toLowerCase() !== column.toLowerCase()) return false;
      if (!dimension.timeGrain) return true;
      const base = physical(column)?.time?.baseGrain;
      return Boolean(base) && dimension.timeGrain === base;
    }));
  if (asItIs) return { rollsUp: false, blocked: [] };
  const asIs = new Set(result.asIs.map((name) => name.toLowerCase()));
  const grouping = result.groupBy.map((name) => wordsFor(name).toLowerCase());
  const blocked = Array.from(new Set(measureNames.map((name) => name.toLowerCase())))
    .filter((name) => asIs.has(name))
    .map((name) => {
      const label = wordsFor(result.asIs.find((candidate) => candidate.toLowerCase() === name) ?? name);
      return {
        measure: name,
        message: `${NON_ADDITIVE_REASON}: ${label} is worked out on each row of ${result.savedQuery}, so it can't be summed. Use Min ${label.toLowerCase()} or Max ${label.toLowerCase()}${grouping.length ? `, or group by ${grouping.join(' and ')} to show it as it is` : ''}.`,
      };
    });
  // A Top N keeps its first N rows: a total over them is not a total of
  // everything, and nobody certified it as one. Without declared grouping
  // columns only a grand total is known to add rows up (a bar per row of a
  // Top N still shows those rows).
  const totalsTopRows = Boolean(result.keepsFirstRows)
    && (result.groupBy.length > 0 || query.dimensions.length === 0 || Boolean(query.rollups?.length));
  if (result.keepsFirstRows && totalsTopRows) {
    return {
      rollsUp: true,
      blocked,
      adaptation: {
        kind: 'saved_query_rollup',
        message: topRowsOnlyMessage(result.savedQuery, result.keepsFirstRows),
        topRowsOnly: result.keepsFirstRows,
      },
    };
  }
  return {
    rollsUp: true,
    blocked,
    adaptation: {
      kind: 'saved_query_rollup',
      message: descriptor.trust === 'certified'
        ? `Rolled up from the certified result of ${result.savedQuery}.`
        : `Rolled up from the result of ${result.savedQuery}, which needs review.`,
    },
  };
}

/** The receipt line for a roll-up over a Top N saved query's rows. */
export function topRowsOnlyMessage(savedQuery: string, rows: number): string {
  return `Totals only the ${rows} rows ${savedQuery} keeps (it is a Top ${rows}), not all of the data, so it is not a certified total.`;
}

/**
 * N when a saved query keeps only its first N rows: an outermost `LIMIT N`
 * or `FETCH FIRST N ROWS ONLY`. A limit inside a subquery or CTE is not the
 * result's limit and is ignored.
 */
export function savedQueryKeepsFirstRows(sql: string | undefined): number | undefined {
  if (!sql?.trim()) return undefined;
  const scan = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  let depth = 0;
  let outer = '';
  for (const char of scan) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) outer += char;
  }
  const match = outer.match(/\blimit\s+(\d+)\b/i) ?? outer.match(/\bfetch\s+(?:first|next)\s+(\d+)\s+rows?\s+only\b/i);
  const rows = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(rows) && rows > 0 ? rows : undefined;
}
