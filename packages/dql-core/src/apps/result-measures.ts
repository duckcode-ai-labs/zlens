/**
 * WHICH COLUMNS OF A RESULT ARE MEASURES.
 *
 * A rank, an id, a year or a code is a number at runtime and a label in
 * meaning. Summed, it is nonsense ("rank is 15"); treated as the value a row
 * leads on, it inverts a ranking ("Kevin Durant leads Rank at 5" when he is
 * fifth). Every caption, story and summary that picks "the measure" of a
 * result picks it here, so they agree with each other and with the table.
 *
 * Order of authority:
 *  1. What the result or its source declares: a column contract that says
 *     metric/measure/dimension (`columnsMeta.ref`, `kind`), or the measures a
 *     block declares (metric mappings, an output contract role).
 *  2. Otherwise the column's name: ranks, positions, orders, ids, keys,
 *     codes, years and other calendar parts are dimensions.
 *  3. Otherwise the values: a column of numbers is a measure.
 *
 * The same module decides whether a result is the WHOLE of something (its
 * rows may be summed) or a top-N / ordered-and-limited list (they may not:
 * the five best scorers' points are not "total points"). A rank column says
 * so; so does the source's `ORDER BY … LIMIT n`, a `top_n` parameter, a
 * ranking pattern or a "Top N" title, and, failing any source, rows that are
 * one per entity sorted by the measure in a typical top-N count.
 *
 * Pure: no DOM, no I/O, safe in the browser and on the server.
 */
import { compareResultMembers } from './result-ranking.js';

export interface ResultColumnContract {
  name?: unknown;
  kind?: unknown;
  ref?: unknown;
  role?: unknown;
}

export interface ResultMeasureInput {
  columns: readonly string[];
  rows: ReadonlyArray<Record<string, unknown>>;
  columnsMeta?: ReadonlyArray<ResultColumnContract | null | undefined>;
  /** Columns the source declares as measures (block metric mappings, output contract). */
  declaredMeasures?: readonly string[];
  /** Columns the source declares as dimensions, keys or grain. */
  declaredDimensions?: readonly string[];
  /** Accept numeric strings ("1,234", "$5") as numbers. Off by default: a code such as "0042" is text. */
  numericStrings?: boolean;
  /**
   * What produced the rows (its SQL, title, parameters, pattern), used to
   * tell a top-N list from a whole population. See `detectResultOrdering`.
   */
  source?: ResultSourceHint;
  /** A precomputed `detectResultOrdering` result (wins over `source`). */
  ordering?: ResultOrdering | null;
}

/** What is known about the query or block that produced a result. */
export interface ResultSourceHint {
  /** The SQL that produced the rows (templated `${param}` placeholders are fine). */
  sql?: string;
  /** The tile, block or question title. */
  title?: string;
  /** Parameter names the source accepts (e.g. `top_n`). */
  parameters?: readonly string[];
  /** A declared block pattern (`ranking`, `trend`, …). */
  pattern?: string;
}

/**
 * Whether a result is the whole population or a slice of it.
 *  - `top_n`: ordered and limited, a ranking: lead with the first row, never sum.
 *  - `limited`: limited without an order (a sample): never sum.
 *  - `complete`: the source SQL has no row limit, so its rows may be summed.
 */
export interface ResultOrdering {
  kind: 'top_n' | 'limited' | 'complete';
  reason: 'rank_column' | 'order_limit' | 'top_n_parameter' | 'pattern' | 'title' | 'rows_sorted' | 'limit' | 'sql';
  /** The literal limit, when the SQL states one. */
  limit?: number;
  /** The first ORDER BY expression when it is a bare column (`total_points`). */
  orderColumn?: string;
  /** Its direction: `desc` is a top N, `asc` a bottom N. */
  direction?: 'asc' | 'desc';
}

export interface ResultMeasureSelection {
  /** Every measure column, in result order. */
  measures: string[];
  /** The measure a one-line summary should talk about, when there is one. */
  primary?: string;
  /** A rank/position column, when the result is a ranking. */
  rankColumn?: string;
  /** The column naming each row (player, team, region), when there is one. */
  labelColumn?: string;
  /** Whether the measures came from a declaration rather than names and values. */
  declared: boolean;
  /**
   * The rows are a ranking or a top-N list (a rank column, or the source /
   * rows say so): lead with the first row and never sum them.
   */
  ranked: boolean;
  /** The rows are not the whole population (ranked, or limited): never sum them. */
  limited: boolean;
  /** How the ordering was decided, when it was. */
  ordering?: ResultOrdering;
}

/** Ordinal words: a column whose own word is one of these numbers rows by position. */
const ORDINAL_TOKENS = new Set(['rank', 'ranking', 'rnk', 'position', 'pos', 'ordinal', 'order', 'seq', 'sequence', 'index', 'idx', 'rn', 'place', 'standing', 'row', 'rownum', 'row_number', 'row_num']);
/** Identity words: the number names a thing, it does not measure it. */
const IDENTIFIER_TOKENS = new Set(['id', 'ids', 'key', 'uuid', 'guid', 'code', 'sk', 'pk', 'fk', 'number', 'no', 'num', 'zip', 'zipcode', 'postcode', 'postal', 'phone', 'fips', 'isbn', 'sku']);
/** Calendar parts: a year or a month number is a time label. */
const CALENDAR_TOKENS = new Set(['year', 'yr', 'yyyy', 'season', 'month', 'mon', 'mm', 'quarter', 'qtr', 'week', 'wk', 'day', 'dd', 'date', 'hour', 'minute', 'period', 'fiscal_year', 'fy']);
/** Measure words: `rank_points` is points, not a rank. */
const MEASURE_SUFFIX_TOKENS = new Set(['count', 'total', 'sum', 'avg', 'average', 'mean', 'amount', 'value', 'pct', 'percent', 'rate', 'ratio', 'share', 'score', 'points', 'pts', 'revenue', 'sales', 'cost', 'spend', 'margin']);

/** Split a column name into lowercase words: `totalPoints_2016` → ["total", "points", "2016"]. */
export function columnNameTokens(column: string): string[] {
  return column
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The word a column is about: its last non-numeric word. `points_2016` is
 * about points, `games_played_2016_2017` about played, `player_rank` about
 * rank, `order_count` about count.
 */
function headToken(column: string): string | undefined {
  const tokens = columnNameTokens(column).filter((token) => !/^\d+$/.test(token));
  return tokens[tokens.length - 1];
}

export type ColumnNameRole = 'ordinal' | 'identifier' | 'calendar';

/**
 * Whether a column's name says it is a rank/position, an identifier or a
 * calendar part, i.e. a dimension however numeric its values are.
 */
export function nonMeasureColumnRole(column: string): ColumnNameRole | undefined {
  const tokens = columnNameTokens(column).filter((token) => !/^\d+$/.test(token));
  if (tokens.length === 0) return undefined;
  const head = tokens[tokens.length - 1]!;
  const joined = tokens.join('_');
  if (ORDINAL_TOKENS.has(head) || ORDINAL_TOKENS.has(joined)) return 'ordinal';
  // `rank_in_team`, `position_overall`: a leading rank word, with no measure word after it.
  if ((tokens[0] === 'rank' || tokens[0] === 'ranking' || tokens[0] === 'position')
    && !tokens.slice(1).some((token) => MEASURE_SUFFIX_TOKENS.has(token))) return 'ordinal';
  if (IDENTIFIER_TOKENS.has(head)) return 'identifier';
  if (CALENDAR_TOKENS.has(head) || CALENDAR_TOKENS.has(joined)) return 'calendar';
  return undefined;
}

/** A rank/position column, by name. */
export function isRankColumnName(column: string): boolean {
  return nonMeasureColumnRole(column) === 'ordinal';
}

function contractRole(meta: ResultColumnContract | undefined): 'measure' | 'dimension' | undefined {
  if (!meta) return undefined;
  const ref = typeof meta.ref === 'string' ? meta.ref : '';
  if (/^(metric|measure|calculation):/.test(ref)) return 'measure';
  if (/^(dimension|entity|grain|key):/.test(ref)) return 'dimension';
  const role = typeof meta.role === 'string' ? meta.role.toLowerCase() : '';
  if (role === 'metric' || role === 'measure') return 'measure';
  if (role === 'dimension' || role === 'grain' || role === 'entity' || role === 'key' || role === 'identifier') return 'dimension';
  const kind = typeof meta.kind === 'string' ? meta.kind : '';
  if (kind === 'text' || kind === 'date' || kind === 'boolean') return 'dimension';
  if (kind === 'currency' || kind === 'percent' || kind === 'count' || kind === 'duration') return 'measure';
  return undefined;
}

function toNumber(value: unknown, numericStrings: boolean): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (numericStrings && typeof value === 'string' && value.trim()) {
    const parsed = Number(value.replace(/[$,%\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A column is numeric when at least half its present values are numbers and none is text. */
function isNumericColumn(column: string, rows: ReadonlyArray<Record<string, unknown>>, numericStrings: boolean): boolean {
  let present = 0;
  let numeric = 0;
  for (const row of rows.slice(0, 500)) {
    const value = row?.[column];
    if (value === null || value === undefined || value === '') continue;
    present += 1;
    if (toNumber(value, numericStrings) !== undefined) numeric += 1;
  }
  return present > 0 && numeric === present;
}

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Whether ordering rows by `rankColumn` ascending orders `measure` the same
 * way every time (all non-increasing, or all non-decreasing): the measure the
 * ranking was computed on.
 */
function rankAgreesWith(rows: ReadonlyArray<Record<string, unknown>>, rankColumn: string, measure: string, numericStrings: boolean): boolean {
  const pairs = rows
    .map((row) => ({ rank: toNumber(row?.[rankColumn], numericStrings), value: toNumber(row?.[measure], numericStrings) }))
    .filter((pair): pair is { rank: number; value: number } => pair.rank !== undefined && pair.value !== undefined)
    .sort((a, b) => a.rank - b.rank);
  if (pairs.length < 2) return false;
  // A constant column agrees with every ordering, so it says nothing about this one.
  if (pairs.every((pair) => pair.value === pairs[0]!.value)) return false;
  let down = true;
  let up = true;
  for (let index = 1; index < pairs.length; index += 1) {
    if (pairs[index]!.value > pairs[index - 1]!.value) down = false;
    if (pairs[index]!.value < pairs[index - 1]!.value) up = false;
  }
  return down || up;
}

function labelColumnOf(input: ResultMeasureInput, exclude: Set<string>): string | undefined {
  const textColumns = input.columns.filter((column) => !exclude.has(column)
    && input.rows.some((row) => typeof row?.[column] === 'string' && String(row[column]).trim())
    && !input.rows.some((row) => typeof row?.[column] === 'number'));
  const named = textColumns.find((column) => /(?:^|_)(?:name|label|title|player|customer|account|team|region|segment|category|product|country|city|state|channel)(?:_|$)/i.test(column));
  return named
    ?? textColumns.find((column) => nonMeasureColumnRole(column) !== 'identifier' && nonMeasureColumnRole(column) !== 'calendar')
    ?? textColumns[0];
}

/** Pick the measures, the summary measure, the rank column and the label column of a result. */
export function selectResultMeasures(input: ResultMeasureInput): ResultMeasureSelection {
  const numericStrings = input.numericStrings ?? false;
  const meta = new Map<string, ResultColumnContract>();
  for (const entry of input.columnsMeta ?? []) {
    if (entry && typeof entry.name === 'string') meta.set(normalize(entry.name), entry);
  }
  const declaredMeasures = new Set((input.declaredMeasures ?? []).map(normalize));
  const declaredDimensions = new Set((input.declaredDimensions ?? []).map(normalize));
  const numeric = input.columns.filter((column) => isNumericColumn(column, input.rows, numericStrings));
  const rankColumn = numeric.find((column) => isRankColumnName(column) && contractRole(meta.get(normalize(column))) !== 'measure' && !declaredMeasures.has(normalize(column)));

  const declared = numeric.filter((column) => declaredMeasures.has(normalize(column)) || contractRole(meta.get(normalize(column))) === 'measure');
  let measures: string[];
  let isDeclared = false;
  if (declared.length > 0 && declaredMeasures.size > 0) {
    // A source that names its measures is the authority on all of them.
    measures = numeric.filter((column) => declaredMeasures.has(normalize(column)));
    if (measures.length === 0) measures = declared;
    isDeclared = true;
  } else {
    measures = numeric.filter((column) => {
      const key = normalize(column);
      if (declaredDimensions.has(key)) return false;
      const role = contractRole(meta.get(key));
      if (role === 'measure') return true;
      if (role === 'dimension') return false;
      return nonMeasureColumnRole(column) === undefined;
    });
    isDeclared = declared.length > 0 && declared.length === measures.length;
  }

  let primary: string | undefined;
  if (measures.length > 0) {
    const candidates = rankColumn
      ? measures.filter((column) => rankAgreesWith(input.rows, rankColumn, column, numericStrings))
      : [];
    const pool = candidates.length > 0 ? candidates : measures;
    // A total is what a ranking or a summary is usually about; then the first declared or remaining measure.
    primary = pool.find((column) => columnNameTokens(column).includes('total')) ?? pool[0];
  }
  const labelColumn = labelColumnOf(input, new Set([...measures, ...(rankColumn ? [rankColumn] : [])]));

  let ordering: ResultOrdering | undefined = input.ordering
    ?? (input.source ? detectResultOrdering(input.source) : undefined);
  if (rankColumn) {
    ordering = { ...(ordering?.kind === 'top_n' ? ordering : {}), kind: 'top_n', reason: ordering?.kind === 'top_n' ? ordering.reason : 'rank_column' };
  } else if (!ordering && primary && labelColumn && rowsLookLikeTopN(input.rows, labelColumn, primary, numericStrings)) {
    // No source to ask: rows that are one per entity, sorted by the measure,
    // in a typical top-N count, are a ranking. A source that states its SQL
    // has no limit (`complete`) is never second-guessed this way.
    ordering = { kind: 'top_n', reason: 'rows_sorted', orderColumn: primary, direction: 'desc' };
  }
  if (!rankColumn && ordering?.kind === 'top_n' && ordering.orderColumn) {
    const orderKey = normalize(ordering.orderColumn);
    const orderMeasure = measures.find((column) => normalize(column) === orderKey);
    if (orderMeasure) {
      // The ranking's own measure is what a ranked summary talks about.
      primary = orderMeasure;
    } else if (input.columns.some((column) => normalize(column) === orderKey)) {
      // Ordered on a label (`ORDER BY player_name LIMIT 5`): a slice, not a
      // ranking. Nothing is summed and nobody "leads".
      ordering = { ...ordering, kind: 'limited' };
    }
  }
  if (!rankColumn && ordering?.kind === 'complete' && ordering.orderColumn) {
    // Every row, sorted on a measure: that measure is the one shown first, so a
    // caption names it (and its leader), never another numeric column.
    const orderMeasure = measures.find((column) => normalize(column) === normalize(ordering!.orderColumn!));
    if (orderMeasure) primary = orderMeasure;
  }
  const ranked = ordering?.kind === 'top_n';
  return {
    measures,
    ...(primary ? { primary } : {}),
    ...(rankColumn ? { rankColumn } : {}),
    ...(labelColumn ? { labelColumn } : {}),
    declared: isDeclared,
    ranked,
    limited: ranked || ordering?.kind === 'limited',
    ...(ordering ? { ordering } : {}),
  };
}

/** Row counts a top-N list is usually asked for. */
const TYPICAL_TOP_N_COUNTS = new Set([3, 5, 10, 15, 20, 25]);

function rowsLookLikeTopN(
  rows: ReadonlyArray<Record<string, unknown>>,
  labelColumn: string,
  measure: string,
  numericStrings: boolean,
): boolean {
  if (!TYPICAL_TOP_N_COUNTS.has(rows.length)) return false;
  const labels = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  let strictlyLower = 0;
  for (const row of rows) {
    const label = row?.[labelColumn];
    if (label === null || label === undefined || label === '') return false;
    const key = String(label).trim().toLowerCase();
    if (labels.has(key)) return false;
    labels.add(key);
    const value = toNumber(row?.[measure], numericStrings);
    if (value === undefined || value > previous) return false;
    if (value < previous) strictlyLower += 1;
    previous = value;
  }
  // Sorted by the measure, not a constant column.
  return strictlyLower > 1;
}

const NUMBER_WORDS: Record<string, number> = { three: 3, five: 5, ten: 10, twenty: 20 };

/**
 * Whether the source that produced a result is a top-N list, a limited
 * sample or the whole population. Undefined when nothing is known.
 *
 *  - `ORDER BY <expr> [DESC] LIMIT n` (or `FETCH FIRST n ROWS`, `SELECT TOP n`)
 *    at the outer level of the SQL: top N, ordered on that expression.
 *  - a `top_n` / `bottom_n` parameter, a `ranking` pattern, or a title such
 *    as "Top 5 …", "Top Players …", "Bottom 10 …", "Leaderboard": top N.
 *  - `LIMIT n` without an ORDER BY: a limited sample.
 *  - SQL with neither: the whole population (`complete`).
 */
export function detectResultOrdering(source: ResultSourceHint): ResultOrdering | undefined {
  const sql = typeof source.sql === 'string' ? stripSqlNoise(source.sql) : '';
  if (sql) {
    const order = outerOrderLimit(sql);
    if (order) return order;
  }
  const parameters = (source.parameters ?? []).map((name) => String(name).toLowerCase());
  if (parameters.some((name) => /^(?:top|bottom)[_-]?(?:n|k|count|limit|rows)$/.test(name))) {
    return { kind: 'top_n', reason: 'top_n_parameter' };
  }
  if (typeof source.pattern === 'string' && /^(?:ranking|top_n|leaderboard)$/i.test(source.pattern.trim())) {
    return { kind: 'top_n', reason: 'pattern' };
  }
  const title = typeof source.title === 'string' ? source.title : '';
  if (title) {
    const spaced = title.replace(/[_-]+/g, ' ');
    const numbered = spaced.match(/\b(top|bottom)\s*(\d+|n|three|five|ten|twenty)\b/i);
    if (numbered) {
      const count = /^\d+$/.test(numbered[2]!) ? Number(numbered[2]) : NUMBER_WORDS[numbered[2]!.toLowerCase()];
      return {
        kind: 'top_n',
        reason: 'title',
        ...(count ? { limit: count } : {}),
        direction: numbered[1]!.toLowerCase() === 'bottom' ? 'asc' : 'desc',
      };
    }
    // "Top Players By …", "Bottom Teams", "Leaderboard".
    const plural = spaced.match(/\b(top|bottom)\s+[a-z]+s\b/i);
    if (plural) return { kind: 'top_n', reason: 'title', direction: plural[1]!.toLowerCase() === 'bottom' ? 'asc' : 'desc' };
    if (/\bleaderboard\b/i.test(spaced)) return { kind: 'top_n', reason: 'title', direction: 'desc' };
  }
  if (sql) {
    if (/\blimit\b/i.test(sql) && hasOuterLimit(sql)) return { kind: 'limited', reason: 'limit' };
    // Every row, sorted: the column it is sorted by is what a caption talks about
    // (a table "ORDER BY lifetime_spend DESC" is led by the biggest spender).
    const sorted = outerOrderItem(sql);
    return { kind: 'complete', reason: 'sql', ...(sorted?.column ? { orderColumn: sorted.column } : {}), ...(sorted?.direction ? { direction: sorted.direction } : {}) };
  }
  return undefined;
}

/** Comments and string literals removed; `${param}` placeholders kept. */
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}

/** The SQL with every parenthesised group blanked, so only the outer query is left. */
function outerLevel(sql: string): string {
  let depth = 0;
  let out = '';
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    if (char === '(') { depth += 1; out += ' '; continue; }
    if (char === ')') { depth = Math.max(0, depth - 1); out += ' '; continue; }
    out += depth === 0 ? char : ' ';
  }
  return out;
}

const LIMIT_VALUE = String.raw`(\d+|\$\{[^}]+\}|\$\d+|\?|:[A-Za-z_]\w*|@[A-Za-z_]\w*)`;

function hasOuterLimit(sql: string): boolean {
  const outer = outerLevel(sql.replace(/\$\{[^}]*\}/g, (match) => match.replace(/[()]/g, ' ')));
  return new RegExp(String.raw`\blimit\s+${LIMIT_VALUE}`, 'i').test(outer)
    || /\bfetch\s+(?:first|next)\b/i.test(outer)
    || /^\s*select\s+(?:distinct\s+)?top\s+/i.test(outer);
}

/** The outer query's first ORDER BY item, when it is a bare column, with its direction. */
function outerOrderItem(sql: string): { column?: string; direction?: 'asc' | 'desc' } | undefined {
  const outer = outerLevel(sql.replace(/\$\{[^}]*\}/g, (match) => match.replace(/[()]/g, ' ')));
  const orderAt = outer.search(/\border\s+by\b/i);
  if (orderAt < 0) return undefined;
  const firstItem = sql.slice(orderAt).replace(/^order\s+by\s+/i, '').split(/,|\blimit\b|\bfetch\b|\boffset\b|;/i)[0]!.trim();
  const itemMatch = firstItem.match(/^("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)\s*(asc|desc)?\s*(?:nulls\s+(?:first|last))?$/i);
  if (!itemMatch) return undefined;
  return { column: itemMatch[1]!.replace(/^["`]|["`]$/g, '').split('.').pop(), direction: itemMatch[2]?.toLowerCase() === 'desc' ? 'desc' : 'asc' };
}

function outerOrderLimit(sql: string): ResultOrdering | undefined {
  // Placeholders may hold parentheses-free text only; keep them intact.
  const outer = outerLevel(sql.replace(/\$\{[^}]*\}/g, (match) => match.replace(/[()]/g, ' ')));
  const orderAt = outer.search(/\border\s+by\b/i);
  if (orderAt < 0) return undefined;
  const afterOrder = outer.slice(orderAt).replace(/^order\s+by\s+/i, '');
  const limitMatch = afterOrder.match(new RegExp(String.raw`\blimit\s+${LIMIT_VALUE}`, 'i'))
    ?? afterOrder.match(/\bfetch\s+(?:first|next)\s+(\d+|\$\{[^}]+\})?/i);
  const topMatch = outer.match(/^\s*select\s+(?:distinct\s+)?top\s+(\d+)/i);
  if (!limitMatch && !topMatch) return undefined;
  const limitText = limitMatch?.[1] ?? topMatch?.[1];
  // The first ORDER BY item, read from the real SQL (the outer view blanks calls).
  const orderText = sql.slice(orderAt).replace(/^order\s+by\s+/i, '');
  const firstItem = orderText.split(/,|\blimit\b|\bfetch\b|\boffset\b|;/i)[0]!.trim();
  const itemMatch = firstItem.match(/^("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*)\s*(asc|desc)?\s*(?:nulls\s+(?:first|last))?$/i);
  const column = itemMatch ? itemMatch[1]!.replace(/^["`]|["`]$/g, '').split('.').pop() : undefined;
  const direction = itemMatch?.[2]?.toLowerCase() === 'desc'
    ? 'desc'
    : itemMatch ? 'asc' : (/\bdesc\b/i.test(firstItem) ? 'desc' : undefined);
  return {
    kind: 'top_n',
    reason: 'order_limit',
    ...(limitText && /^\d+$/.test(limitText) ? { limit: Number(limitText) } : {}),
    ...(column ? { orderColumn: column } : {}),
    ...(direction ? { direction } : {}),
  };
}

/**
 * The row a ranked or measured result is led by.
 *
 * With a rank column, the leader is the row ranked first (the lowest rank),
 * whatever the order of the rows. A top-N list ordered on another column is
 * led by its first row, and a bottom N by its smallest value. Otherwise it is
 * the row with the largest value of the summary measure. Undefined when the
 * result has neither.
 */
export function resultLeaderRow(
  input: Pick<ResultMeasureInput, 'rows' | 'numericStrings'>,
  selection: Pick<ResultMeasureSelection, 'primary' | 'rankColumn'> & Partial<Pick<ResultMeasureSelection, 'ordering' | 'labelColumn'>>,
): Record<string, unknown> | undefined {
  const numericStrings = input.numericStrings ?? false;
  let best: { row: Record<string, unknown>; key: number } | undefined;
  if (selection.rankColumn) {
    for (const row of input.rows) {
      const rank = toNumber(row?.[selection.rankColumn], numericStrings);
      if (rank === undefined) continue;
      if (!best || rank < best.key) best = { row, key: rank };
    }
    if (best) return best.row;
  }
  const ordering = selection.ordering;
  if (ordering?.kind === 'top_n' && !selection.rankColumn) {
    const orderedOnPrimary = Boolean(selection.primary && ordering.orderColumn
      && normalize(ordering.orderColumn) === normalize(selection.primary));
    // Ordered on something other than the summary measure: the list's own
    // first row leads it.
    if (!orderedOnPrimary && ordering.orderColumn) return input.rows[0];
    // A bottom N is led by its smallest value.
    if (orderedOnPrimary && ordering.direction === 'asc') {
      for (const row of input.rows) {
        const value = toNumber(row?.[selection.primary!], numericStrings);
        if (value === undefined) continue;
        if (!best || value < best.key) best = { row, key: value };
      }
      return best?.row;
    }
  }
  if (!selection.primary) return undefined;
  // The highest value leads; an equal value is settled by the row's label,
  // never by the order the warehouse returned the rows in.
  const label = selection.labelColumn;
  for (const row of input.rows) {
    const value = toNumber(row?.[selection.primary], numericStrings);
    if (value === undefined) continue;
    if (!best || value > best.key || (value === best.key && label && compareResultMembers(row?.[label], best.row[label]) < 0)) best = { row, key: value };
  }
  return best?.row;
}
