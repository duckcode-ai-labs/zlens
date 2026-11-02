import type { AnalyticalIntentV1, IntentPredicate } from './intent.js';
import type { PreparedCandidate, SemanticExecutionProgram } from './prepare/types.js';
import { divideDecimal, formatDecimal, parseExactDecimal, subtractDecimal } from '../analytical-execution-graph.js';

/**
 * EXECUTE, then prove the executed query did what the intent said.
 *
 * Two proofs run before rows are trusted: every literal the intent filters
 * on must appear in the executed SQL (a dropped filter is a wrong answer
 * that looks right), and a native multi-relation join must not have
 * multiplied fact rows (the fan-out probe). Failures are typed and carry
 * the warehouse's own message.
 */

/** What a result column IS, from the vocabulary: the units contract every renderer reads. */
export interface ResultColumnMeta {
  name: string;
  kind: 'currency' | 'percent' | 'number' | 'count' | 'duration' | 'date' | 'text' | 'boolean';
  /** `USD` for currency; `fraction` (0.626) or `percentage_points` (10.8) for percent. */
  unit?: string;
  decimals?: number;
  /** The vocabulary ref the column carries, when known. */
  ref?: string;
  /** The time grain of a date column. */
  grain?: string;
}

export interface ExecutedRows {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  executionTimeMs: number;
  truncated?: boolean;
  /** Units per column; absent on legacy results, which render exactly as before. */
  columnsMeta?: ResultColumnMeta[];
}

export interface ExecuteRunOptions {
  maxRows: number;
  /** What this statement is for: the answer itself, or the one-row fan-out probe. */
  purpose?: 'query' | 'fanout_probe';
  /** The tier whose candidate is being executed. */
  tier?: PreparedCandidate['tier'];
  /** The request deadline/cancellation signal reaches every physical branch. */
  signal?: AbortSignal;
  /** Internal receipt hook, invoked immediately before a physical dispatch. */
  onWarehouseAttempt?: () => void;
  /** Internal receipt hook, invoked after that physical dispatch settles. */
  onWarehouseResult?: (outcome: 'succeeded' | 'failed') => void;
}

export interface ExecuteDeps {
  run(sql: string, params: unknown[] | undefined, options: ExecuteRunOptions): Promise<ExecutedRows>;
  maxRows?: number;
  /** Inherited request cancellation for fan-out, semantic branches and SQL. */
  signal?: AbortSignal;
  /** Validate a frozen candidate before any physical statement is submitted. */
  validateCandidate?: (candidate: PreparedCandidate, intent: AnalyticalIntentV1) => Promise<void> | void;
  /** The words a field is called by (name, label, aliases): a literal that is one of them is not a member of it. */
  fieldNames?: (ref: string) => string[];
}

/**
 * Keep the historical numeric surface for ordinary small values, but never
 * lower a warehouse decimal through IEEE-754 before subtracting or dividing.
 * Snowflake commonly returns NUMBER as text specifically so 9007199254740993
 * can survive this boundary. Values whose decimal spelling exceeds the safe
 * compact surface stay strings rather than changing silently.
 */
function compatibleExact(value: string): number | string {
  const digits = value.replace(/^[-+]/, '').replace('.', '').replace(/^0+/, '') || '0';
  const numeric = Number(value);
  return Number.isFinite(numeric) && digits.length <= 15 ? numeric : value;
}

/**
 * Compute ratio columns from two executed columns (semantic candidates carry
 * both metrics and divide here). Null when the denominator is 0 or absent;
 * helper columns are dropped unless the intent asked for them too.
 */
export function applyDerivedColumns(result: ExecutedRows, derived: NonNullable<PreparedCandidate['derived']>): ExecutedRows {
  if (derived.length === 0) return result;
  const find = (row: Record<string, unknown>, name: string): unknown => {
    if (name in row) return row[name];
    const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : row[key];
  };
  const drop = new Set(derived.filter((item) => !item.keepInputs).flatMap((item) => [item.numerator, item.denominator]).map((name) => name.toLowerCase()));
  const rows = result.rows.map((row) => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) if (!drop.has(key.toLowerCase())) next[key] = value;
    for (const item of derived) {
      const rawNumerator = find(row, item.numerator);
      const rawDenominator = find(row, item.denominator);
      const numerator = parseExactDecimal(rawNumerator);
      const denominator = parseExactDecimal(rawDenominator);
      const value = numerator && denominator ? divideDecimal(numerator, denominator) : undefined;
      next[item.alias] = rawNumerator == null || rawDenominator == null || !numerator || !denominator || value === undefined ? null : compatibleExact(value);
    }
    return next;
  });
  const columns = [...result.columns.filter((column) => !drop.has(column.toLowerCase())), ...derived.map((item) => item.alias).filter((alias) => !result.columns.includes(alias))];
  return { ...result, columns, rows };
}

/**
 * Compute a requested comparison after the semantic engine returned the two
 * authored metrics.  This keeps a MetricFlow prior-period offset owned by
 * MetricFlow: Ask performs only the declared subtraction/division of the
 * returned values, with the same null/zero behavior as relational SQL.
 */
export function applyChangeColumns(result: ExecutedRows, changes: NonNullable<PreparedCandidate['changes']>): ExecutedRows {
  if (changes.length === 0) return result;
  const find = (row: Record<string, unknown>, name: string): unknown => {
    if (name in row) return row[name];
    const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : row[key];
  };
  const rows = result.rows.map((row) => {
    const next = { ...row };
    for (const item of changes) {
      const rawBase = find(row, item.base);
      const rawComparison = find(row, item.comparison);
      const base = parseExactDecimal(rawBase);
      const comparison = parseExactDecimal(rawComparison);
      if (rawBase == null || rawComparison == null || !base || !comparison) {
        next[item.alias] = null;
        continue;
      }
      const delta = subtractDecimal(comparison, base);
      const value = item.as === 'percent' ? divideDecimal(delta, base) : formatDecimal(delta);
      next[item.alias] = value === undefined ? null : compatibleExact(value);
    }
    return next;
  });
  const columns = [...result.columns, ...changes.map((item) => item.alias).filter((alias) => !result.columns.some((column) => column.toLowerCase() === alias.toLowerCase()))];
  return { ...result, columns, rows };
}

function sameOutputName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
    || left.replace(/[._ -]+/g, '_').toLowerCase() === right.replace(/[._ -]+/g, '_').toLowerCase();
}

function sourceColumn(columns: string[], source: string): string | undefined {
  return columns.find((column) => sameOutputName(column, source));
}

function valueFor(row: Record<string, unknown>, column: string): unknown {
  if (column in row) return row[column];
  const found = Object.keys(row).find((key) => sameOutputName(key, column));
  return found === undefined ? undefined : row[found];
}

function typedAlignmentKey(row: Record<string, unknown>, columns: string[]): string {
  return JSON.stringify(columns.map((column) => {
    const value = valueFor(row, column);
    return [typeof value, value];
  }));
}

/** Deterministic post-alignment ranking for a semantic comparison program. */
export function applySemanticProgramPostProcess(
  result: ExecutedRows,
  postProcess: SemanticExecutionProgram['postProcess'] | undefined,
): ExecutedRows {
  if (!postProcess || result.rows.length === 0) return result;
  const rows = result.rows.map((row) => ({ ...row }));
  const valueForOrder = (row: Record<string, unknown>): unknown => postProcess.orderBy ? valueFor(row, postProcess.orderBy.column) : undefined;
  if (postProcess.orderBy) {
    if (rows.some((row) => valueForOrder(row) === undefined)) {
      throw new Error(`semantic comparison ranking column ${postProcess.orderBy.column} was not returned after alignment`);
    }
    rows.sort((left, right) => {
      const leftRaw = valueForOrder(left);
      const rightRaw = valueForOrder(right);
      const leftNumber = parseExactDecimal(leftRaw);
      const rightNumber = parseExactDecimal(rightRaw);
      let compared: number;
      if (leftNumber && rightNumber) {
        // Avoid importing a float comparator: exact subtraction tells only
        // ordering and preserves Snowflake NUMBER values beyond 2^53.
        const delta = subtractDecimal(leftNumber, rightNumber);
        compared = delta.coefficient < 0n ? -1 : delta.coefficient > 0n ? 1 : 0;
      } else compared = String(leftRaw ?? '').localeCompare(String(rightRaw ?? ''));
      if (compared !== 0) return postProcess.orderBy!.direction === 'desc' ? -compared : compared;
      return typedAlignmentKey(left, result.columns).localeCompare(typedAlignmentKey(right, result.columns));
    });
  } else {
    rows.sort((left, right) => typedAlignmentKey(left, result.columns).localeCompare(typedAlignmentKey(right, result.columns)));
  }
  if (!postProcess.limit || rows.length <= postProcess.limit) return { ...result, rows, rowCount: rows.length };
  let selected = rows.slice(0, postProcess.limit);
  if (postProcess.includeTies && postProcess.orderBy && postProcess.limit > 0) {
    const cutoff = valueForOrder(rows[postProcess.limit - 1]!);
    const same = (value: unknown) => {
      const left = parseExactDecimal(value);
      const right = parseExactDecimal(cutoff);
      if (left && right) return subtractDecimal(left, right).coefficient === 0n;
      return String(value ?? '') === String(cutoff ?? '');
    };
    selected = rows.filter((row, index) => index < postProcess.limit! || same(valueForOrder(row)));
  }
  return { ...result, rows: selected, rowCount: selected.length };
}

/**
 * Execute at most four independently compiled semantic branches and join their
 * results in memory only at the grain the request declared.  Each branch is
 * still executed through the same target/adapter; this helper never invents a
 * metric formula, join, date offset, or SQL expression.
 */
export async function executeSemanticProgram(
  program: SemanticExecutionProgram,
  deps: ExecuteDeps,
  candidate: PreparedCandidate,
): Promise<ExecutedRows> {
  if (program.branches.length === 0 || program.branches.length > 4) {
    throw new Error(`semantic execution program must contain one to four branches; received ${program.branches.length}`);
  }
  const results: Array<{ branch: SemanticExecutionProgram['branches'][number]; result: ExecutedRows; metricColumns: string[] }> = [];
  for (const branch of program.branches) {
    if (!branch.sql) throw new Error(`semantic branch ${branch.id} was not compiled before execution`);
    const branchMaxRows = deps.maxRows ?? 500;
    const result = await deps.run(branch.sql, undefined, {
      maxRows: branchMaxRows,
      purpose: 'query',
      tier: candidate.tier,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    const metricColumns = branch.outputs.map((output) => sourceColumn(result.columns, output.source)).filter((column): column is string => Boolean(column));
    if (metricColumns.length !== branch.outputs.length) {
      const absent = branch.outputs.filter((output) => !sourceColumn(result.columns, output.source)).map((output) => output.source);
      throw new Error(`semantic branch ${branch.id} did not return its requested metric column${absent.length === 1 ? '' : 's'} ${absent.join(', ')}`);
    }
    if (program.postProcess?.requireCompletePopulation && (result.truncated || result.rowCount >= branchMaxRows)) {
      throw new Error(`semantic branch ${branch.id} reached the bounded ${branchMaxRows}-row candidate population before comparison ranking. Narrow the grouping or filter; Ask will not rank a truncated branch.`);
    }
    results.push({ branch, result, metricColumns });
  }
  const allOutputs = results.flatMap(({ branch }) => branch.outputs.map((output) => output.as));
  const totalMs = results.reduce((sum, item) => sum + item.result.executionTimeMs, 0);
  const truncated = results.some((item) => item.result.truncated);

  if (program.shape === 'scalar') {
    const rows = results.filter((item) => item.result.rows.length > 0);
    for (const item of results) {
      const keyColumns = item.result.columns.filter((column) => !item.metricColumns.some((metric) => sameOutputName(metric, column)));
      // MetricFlow requires `metric_time` for an authored offset metric. A
      // one-row, explicitly bounded compiler support column is not a user
      // requested time series, so remove it while retaining the scalar shape.
      // Any extra key, more than one row, or an implicit compiler addition is
      // a changed result shape and is refused rather than quietly returned as
      // an unrelated trend.
      const supportDimension = item.branch.request.timeDimension
        ? `${item.branch.request.timeDimension.name}__${item.branch.request.timeDimension.granularity}`
        : undefined;
      const compilerMetricTimeOnly = keyColumns.length === 1
        && supportDimension !== undefined
        // MetricFlow renders an explicit month support axis as
        // `metric_time__month`, not the bare `metric_time` request name.
        // Accept only that declared name and one row; any other grouping
        // remains a shape change that a scalar answer must refuse.
        && sameOutputName(keyColumns[0]!, supportDimension)
        && item.result.rows.length <= 1;
      if ((!compilerMetricTimeOnly && keyColumns.length > 0) || item.result.rows.length > 1) {
        throw new Error(`semantic branch ${item.branch.id} returned ${keyColumns.join(', ') || `${item.result.rows.length} rows`} for a scalar request; MetricFlow must not add metric_time or another grouping unless the question asks for it`);
      }
    }
    if (rows.length === 0) return { columns: allOutputs, rows: [], rowCount: 0, executionTimeMs: totalMs, ...(truncated ? { truncated } : {}) };
    const row: Record<string, unknown> = {};
    for (const output of allOutputs) row[output] = null;
    for (const { branch, result } of results) {
      const source = result.rows[0];
      if (!source) continue;
      for (const output of branch.outputs) {
        const column = sourceColumn(result.columns, output.source)!;
        row[output.as] = valueFor(source, column) ?? null;
      }
    }
    return { columns: allOutputs, rows: [row], rowCount: 1, executionTimeMs: totalMs, ...(truncated ? { truncated } : {}) };
  }

  const first = results[0]!;
  const keyColumns = first.result.columns.filter((column) => !first.metricColumns.some((metric) => sameOutputName(metric, column)));
  if (keyColumns.length === 0) {
    throw new Error('semantic program declared a grouped result but its first branch returned no grouping columns');
  }
  const rows = new Map<string, Record<string, unknown>>();
  for (const { branch, result, metricColumns } of results) {
    const branchKeys = result.columns.filter((column) => !metricColumns.some((metric) => sameOutputName(metric, column)));
    if (branchKeys.length !== keyColumns.length || branchKeys.some((column, index) => !sameOutputName(column, keyColumns[index]!))) {
      throw new Error(`semantic branch ${branch.id} changed the declared result grain (${branchKeys.join(', ') || 'none'} vs ${keyColumns.join(', ')})`);
    }
    for (const source of result.rows) {
      const key = typedAlignmentKey(source, branchKeys);
      const row = rows.get(key) ?? Object.fromEntries(keyColumns.map((column, index) => [column, valueFor(source, branchKeys[index]!)]));
      for (const output of branch.outputs) {
        const column = sourceColumn(result.columns, output.source)!;
        row[output.as] = valueFor(source, column) ?? null;
      }
      rows.set(key, row);
    }
  }
  const aligned = [...rows.values()];
  for (const row of aligned) for (const output of allOutputs) if (!(output in row)) row[output] = null;
  return {
    columns: [...keyColumns, ...allOutputs.filter((output, index) => allOutputs.findIndex((candidateOutput) => sameOutputName(candidateOutput, output)) === index)],
    rows: aligned,
    rowCount: aligned.length,
    executionTimeMs: totalMs,
    ...(truncated ? { truncated } : {}),
  };
}

/**
 * A SUPERLATIVE THAT TIES HAS SEVERAL ANSWERS. The query fetched one row more
 * than it shows; when that row carries the same value as the last one kept,
 * every row sharing the top value is kept and the answer says they tie. When
 * it does not, the extra row is dropped and nothing about it is said.
 */
export function resolveTie(result: ExecutedRows, probe: NonNullable<PreparedCandidate['tieProbe']>): { result: ExecutedRows; note?: string } {
  if (result.rows.length <= probe.limit) return { result };
  const valueOf = (row: Record<string, unknown> | undefined): unknown => {
    if (!row) return undefined;
    if (probe.column in row) return row[probe.column];
    const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === probe.column.toLowerCase());
    return key === undefined ? undefined : row[key];
  };
  const last = valueOf(result.rows[probe.limit - 1]);
  const next = valueOf(result.rows[probe.limit]);
  if (last === undefined || next === undefined || String(last) !== String(next)) {
    return { result: { ...result, rows: result.rows.slice(0, probe.limit), rowCount: probe.limit } };
  }
  const tied = result.rows.filter((row) => String(valueOf(row)) === String(last));
  return {
    result: { ...result, rows: tied, rowCount: tied.length },
    note: `${tied.length} rows tie on ${probe.column} at ${String(last)}: all of them are shown, because no rule in this question chooses between them`,
  };
}

export type ExecutionOutcome =
  | { ok: true; result: ExecutedRows; proofs: string[] }
  | {
    ok: false; code: 'filter_not_applied' | 'fanout_detected' | 'execution_failed' | 'preflight_failed' | 'no_rows_matched'; message: string; proofs: string[]; cause?: EmptyAggregateCause; warehouse?: WarehouseFailure;
    /**
     * What a corrective draft is told about the failure, when it differs from
     * `message`: with a host, `message` is a plain sentence and a reference,
     * and the draft still gets the warehouse's diagnosis (never an excerpt of
     * the statement the host sent).
     */
    repair?: string;
  };

/**
 * What the warehouse said, in a class the answer can name. A driver message is
 * the only evidence a host has for why a query did not run, and "could not be
 * completed" reads the same for a suspended warehouse, a table the connection
 * cannot see, a column or function the statement names that the warehouse does
 * not have, and a genuine SQL fault, which are different next actions.
 *
 * `relations` names only tables: with the statement known, only the tables it
 * reads that the warehouse's words mention — never a column, a function, an
 * alias or a literal the driver happened to quote.
 */
export interface WarehouseFailure {
  class: 'warehouse_suspended' | 'relation_missing' | 'relation_denied' | 'catalog_stale' | 'column_missing' | 'function_missing' | 'sql_error';
  relations: string[];
  /** The column the warehouse could not find, when the statement names it. */
  column?: string;
  /** The function the warehouse does not have, when the statement calls it. */
  function?: string;
  /** With a host: where its log keeps the warehouse's own words (RFC 0010 HH-3). */
  reference?: string;
}

const RELATION_TOKEN = /'([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*){0,2})'|"([A-Za-z_][\w$]*(?:"\."[A-Za-z_][\w$]*){0,2})"/g;

/** Relation names a driver mentioned, as written. */
function relationsIn(message: string): string[] {
  const found = new Set<string>();
  for (const match of message.matchAll(RELATION_TOKEN)) {
    const name = (match[1] ?? match[2] ?? '').replace(/"/g, '');
    if (name && /[A-Za-z]/.test(name)) found.add(name);
  }
  return [...found];
}

/**
 * Where a driver message stops saying why and starts quoting the statement:
 * DuckDB's and Postgres's `LINE 1: …` excerpt and its caret, a Spark/Databricks
 * plan, an echoed query. What follows can quote a host's rewrite of the
 * statement (a row rule's predicate and the person's values).
 */
const EXCERPT_LINE = /^\s*(?:LINE \d+:|\^+\s*$|(?:QUERY|STATEMENT|SQL)\s*:|'[A-Z][A-Za-z]+ |[+:]-|:\s+[+:]-)/i;
/** DQL's own DuckDB advice for a single-user project (dql-connectors), not the warehouse's words. */
const LOCAL_HINT = /^\s*Hint: that table isn't in this database/;

/** The lines of a driver message that say why it failed, before any excerpt of the statement. */
export function warehouseDiagnosis(message: string): string {
  const kept: string[] = [];
  for (const line of String(message).split('\n')) {
    if (EXCERPT_LINE.test(line) || LOCAL_HINT.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/** A statement's text without its string literals (which can hold any word) and comments. */
function withoutLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** The tables a statement reads, as it writes them (FROM and JOIN targets). */
function statementRelations(sql: string): string[] {
  const found = new Set<string>();
  const name = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
  const pattern = new RegExp(String.raw`\b(?:FROM|JOIN)\s+(${name}(?:\s*\.\s*${name}){0,2})`, 'gi');
  for (const match of withoutLiterals(sql).matchAll(pattern)) {
    const relation = (match[1] ?? '').replace(/\s+/g, '');
    if (relation) found.add(relation);
  }
  return [...found];
}

/**
 * A table's own name, as a sentence says it: its last part, unquoted
 * (`"warehouse"."main"."claims"` → `claims`, BigQuery's `` `p.warehouse.claims` `` → `claims`).
 */
export function relationName(relation: string): string {
  const parts = relation.match(/"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[^.]+/g) ?? [relation];
  const last = (parts[parts.length - 1] ?? relation).replace(/^["\x60[]|["\x60\]]$/g, '');
  // A backquoted BigQuery path holds its dots inside the quotes.
  return /^\x60/.test(parts[parts.length - 1] ?? '') ? last.split('.').pop() ?? last : last;
}

/** A relation's last part, unquoted and folded, for matching. */
function relationTail(relation: string): string {
  return relationName(relation).toLowerCase();
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a statement (literals aside) names `identifier` as a word, or calls it when `call` is set. */
function statementNames(sql: string, identifier: string, call = false): boolean {
  if (!identifier || !/^[\w$]+$/.test(identifier)) return false;
  const pattern = new RegExp(`(?:^|[^\\w$])"?${escapeRegExp(identifier)}"?${call ? '\\s*\\(' : '(?![\\w$])'}`, 'i');
  return pattern.test(withoutLiterals(sql));
}

/** The last part of a quoted or dotted name a driver printed (`"c".status` → `status`, `'C.STATUS'` → `STATUS`). */
function lastPart(name: string): string {
  const parts = name.split('.').map((part) => part.replace(/^["'`]+|["'`]+$/g, '').trim()).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

const COLUMN_NAMED = [
  /referenced column "?([^"\s]+)"? not found/i,
  /does not have a column named "?([^"\s]+)"?/i,
  /column ((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))*) (?:of relation \S+ )?does not exist/i,
  /invalid identifier '([^']+)'/i,
  /unrecognized name: `?([\w$]+)`?/i,
  /(?:with name|column) `([^`]+)` cannot be resolved/i,
  /no such column: ([\w$."]+)/i,
  /unknown column '([^']+)'/i,
];
const FUNCTION_NAMED = [
  /function with name "?([\w$.]+)"? does not exist/i,
  /function ([\w$."]+)\s*\([^)]*\) does not exist/i,
  /unknown function:? ([\w$.]+)/i,
  /function not found: ([\w$.]+)/i,
  /(?:undefined function|cannot resolve (?:routine|function))[:\s]+`?([\w$.]+)`?/i,
  /no such function: ([\w$.]+)/i,
];

function firstNamed(patterns: RegExp[], text: string): string {
  for (const pattern of patterns) {
    const found = pattern.exec(text)?.[1];
    if (found) return lastPart(found);
  }
  return '';
}

/**
 * Classify a driver error. The order matters: a message that names both a
 * privilege and a missing object is a privilege problem, and Snowflake's
 * "does not exist or not authorized" is reported as missing because the
 * catalog is what disagrees with the connection. A function or a column the
 * warehouse does not have is not a missing table, and an alias the statement
 * mistyped is a fault in the statement.
 *
 * With the `statement` that failed, the failure names only what that
 * statement wrote: its tables, and a column or function it names (never one
 * a host's rewrite added, never a literal).
 */
export function classifyWarehouseError(message: string, statement?: { sql?: string; relations?: string[] }): WarehouseFailure {
  const diagnosis = warehouseDiagnosis(message) || String(message);
  const text = diagnosis.toLowerCase();
  const tokens = relationsIn(diagnosis);
  const sql = statement?.sql ?? '';
  const read = statement ? [...new Set([...(statement.relations ?? []), ...statementRelations(sql)])] : [];
  /** The statement's tables the warehouse's words mention, in the warehouse's spelling when it quoted them. */
  const named = (): string[] => {
    if (!statement) return tokens;
    const tails = new Set(read.map(relationTail));
    const quoted = tokens.filter((token) => tails.has(relationTail(token)));
    if (quoted.length) return quoted;
    return read.filter((relation) => new RegExp(`(?:^|[^\\w$])${escapeRegExp(relationTail(relation))}(?![\\w$])`, 'i').test(diagnosis));
  };
  if (/known to be missing|catalog lists it/.test(text)) return { class: 'catalog_stale', relations: tokens };
  if (/warehouse/.test(text) && /suspend|not running|is stopped|cannot be resumed|no active warehouse|no running warehouse/.test(text)) {
    return { class: 'warehouse_suspended', relations: [] };
  }
  if (/permission denied|access denied|insufficient privileg|not authorized to|access control error|is not allowed to/.test(text)) {
    return { class: 'relation_denied', relations: named() };
  }
  if (/function with name .* does not exist|function [\w$."]+\s*\([^)]*\) does not exist|unknown function|undefined function|function not found|no such function|cannot resolve (?:routine|function)|unresolved_routine|is not a recognized (?:built-in )?function/.test(text)) {
    const called = firstNamed(FUNCTION_NAMED, diagnosis);
    return { class: 'function_missing', relations: [], ...(called && statementNames(sql, called, true) ? { function: called } : {}) };
  }
  if (/referenced column .* not found|does not have a column named|\bcolumn\b[^\n]*\b(?:does not exist|not found|cannot be resolved)|no such column|unknown column|invalid identifier|unrecognized name|unresolved_column/.test(text)) {
    const column = firstNamed(COLUMN_NAMED, diagnosis);
    return { class: 'column_missing', relations: read.length === 1 ? read : [], ...(column && statementNames(sql, column) ? { column } : {}) };
  }
  // DuckDB's "Referenced table "c" not found" is an alias the statement never declared.
  if (/referenced table .* not found/.test(text)) return { class: 'sql_error', relations: [] };
  if (/does not exist|doesn't exist|not found|no such table|unknown table|undefined table|cannot be found/.test(text)) {
    return { class: 'relation_missing', relations: named() };
  }
  return { class: 'sql_error', relations: [] };
}

/**
 * A statement a host ran that the warehouse refused (RFC 0010 HH-3). The
 * host's executor keeps the warehouse's own words in its log under a short
 * reference and hands DQL a diagnosis without any excerpt of the statement it
 * sent (which, after a row policy's rewrite, holds the rule's predicate).
 */
export interface HostedWarehouseError {
  warehouseReference: string;
  warehouseDiagnosis: string;
}

export function hostedWarehouseError(error: unknown): HostedWarehouseError | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { warehouseReference, warehouseDiagnosis: diagnosis } = error as Partial<HostedWarehouseError>;
  return typeof warehouseReference === 'string' && warehouseReference && typeof diagnosis === 'string'
    ? { warehouseReference, warehouseDiagnosis: diagnosis }
    : undefined;
}

/** One plain clause for a warehouse failure, in words a person can read (no driver text). */
export function warehouseFailureClause(failure: WarehouseFailure): string {
  const tables = failure.relations.length ? failure.relations.join(', ') : '';
  switch (failure.class) {
    case 'warehouse_suspended': return 'the warehouse is not running';
    case 'relation_missing': return `the warehouse does not have ${tables || 'a table this statement reads'}`;
    case 'relation_denied': return `this connection is not allowed to read ${tables || 'a table this statement reads'}`;
    case 'catalog_stale': return `${tables || 'a table this statement reads'} is already known to be missing on this connection`;
    case 'column_missing': return `a column this statement reads${failure.column ? ` (${failure.column})` : ''} is not in ${failure.relations.length === 1 ? `the ${relationName(failure.relations[0]!)} table` : 'its table'} on the warehouse`;
    case 'function_missing': return `the statement calls a function${failure.function ? ` (${failure.function})` : ''} that the warehouse does not have`;
    default: return 'the warehouse could not run the statement';
  }
}

/**
 * What a failed statement says from here on (the answer, its steps, its
 * receipt): without a host, the warehouse's words, as before; with one, a
 * plain clause and the host's reference — the warehouse's words stay in the
 * host's log, and a corrective draft gets only the diagnosis (`repair`).
 */
export function statementFailure(error: unknown, statement?: { sql?: string; relations?: string[] }): { message: string; warehouse: WarehouseFailure; repair?: string } {
  const hosted = hostedWarehouseError(error);
  const said = hosted ? hosted.warehouseDiagnosis : error instanceof Error ? error.message : String(error);
  const warehouse = classifyWarehouseError(said, statement);
  if (!hosted) return { message: said, warehouse };
  const failure = { ...warehouse, reference: hosted.warehouseReference };
  return { message: `${warehouseFailureClause(failure)} (reference ${hosted.warehouseReference})`, warehouse: failure, repair: said };
}

/** Why a single all-null aggregate row is empty: the restriction that matched nothing. */
export type EmptyAggregateCause = { kind: 'member'; literals: string[] } | { kind: 'window'; start: string; end: string } | { kind: 'predicate'; refs: string[] };

const plainWord = (word: string): string => word.replace(/ies$/, 'y').replace(/(ses|xes|shes|ches)$/, (m) => m.slice(0, -2)).replace(/s$/, '');
/** Text in one spelling: lower case, one space between words, each word singular. */
export const plainName = (value: string): string => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(plainWord).join(' ');

/**
 * Is a literal one of the words the filtered field itself is called by (its
 * name, label or alias, or the last segment of its ref)? Such a literal is
 * not a member the question named: `product = "product"` names no product.
 */
export function literalIsFieldName(predicate: Pick<IntentPredicate, 'ref'>, literal: string, fieldNames?: (ref: string) => string[]): boolean {
  const own = new Set([...(fieldNames?.(predicate.ref) ?? []), predicate.ref.replace(/^[^:]*:/, '').split('.').pop() ?? ''].map(plainName).filter(Boolean));
  return own.has(plainName(literal));
}

/**
 * A result that holds nothing (no rows, or one row whose every cell is null)
 * did not aggregate anything. Under a restriction (a member literal, a time
 * window, any predicate) that is the absence of matching rows, not a value,
 * and the cause is named. An unrestricted empty result stays an answer: the
 * table is empty, which is what the rows say. A literal that is the field's
 * own name is a restriction, never a member nobody could find.
 */
export function emptyAggregateCause(intent: AnalyticalIntentV1, result: ExecutedRows, fieldNames?: (ref: string) => string[]): EmptyAggregateCause | undefined {
  if (result.rows.length > 1) return undefined;
  if (result.rows.length === 1) {
    // A sum over no rows is NULL; a count over the same no rows is 0. One row
    // that is nothing but nulls, or nulls beside zeros, came from no rows at
    // all. A row of plain zeros with no null is a member who really scored
    // nothing, and is kept.
    const cells = Object.values(result.rows[0] ?? {});
    const isNull = (value: unknown) => value === null || value === undefined;
    const isZero = (value: unknown) => value === 0 || value === 0n || value === '0';
    if (cells.length === 0 || !cells.some(isNull) || !cells.every((value) => isNull(value) || isZero(value))) return undefined;
  }
  const predicates = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])];
  const literals = predicates.flatMap((predicate) => predicate.values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0 && !/^(true|false)$/i.test(value) && !literalIsFieldName(predicate, value, fieldNames)));
  if (literals.length > 0) return { kind: 'member', literals };
  if (intent.time?.window) return { kind: 'window', start: intent.time.window.start, end: intent.time.window.end };
  if (predicates.length > 0) return { kind: 'predicate', refs: [...new Set(predicates.map((predicate) => predicate.ref))] };
  return undefined;
}

function describeEmptyAggregate(cause: EmptyAggregateCause): string {
  if (cause.kind === 'member') return `no rows matched ${cause.literals.map((value) => JSON.stringify(value)).join(', ')} on the warehouse; the aggregate was empty, so nothing about the member was answered`;
  if (cause.kind === 'window') return `no rows fell inside the window ${cause.start}..${cause.end}; the aggregate was empty, so nothing about that period was answered`;
  return `no rows matched the restriction on ${cause.refs.join(', ')}; the aggregate was empty, so nothing under that restriction was answered`;
}

export async function executeCandidate(candidate: PreparedCandidate, intent: AnalyticalIntentV1, deps: ExecuteDeps): Promise<ExecutionOutcome> {
  const proofs: string[] = [];
  try {
    await deps.validateCandidate?.(candidate, intent);
  } catch (error) {
    return { ok: false, code: 'preflight_failed', message: error instanceof Error ? error.message : String(error), proofs };
  }
  // Fail-closed filter proof: the SQL must mention every literal the intent filters on.
  const literals = [...intent.filters, ...intent.measures.flatMap((measure) => measure.scope ?? [])]
    .flatMap((predicate) => predicate.values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0));
  const semanticProgramContext = candidate.semanticProgram
    ? candidate.semanticProgram.branches.map((branch) => `${branch.sql ?? ''}\n${JSON.stringify(branch.request)}`).join('\n')
    : '';
  const haystack = `${candidate.sql}\n${semanticProgramContext}\n${(candidate.params ?? []).map(String).join('\n')}`.toLowerCase();
  const missing = literals.filter((literal) => !haystack.includes(literal.toLowerCase()));
  if (missing.length > 0) {
    return { ok: false, code: 'filter_not_applied', message: `the prepared query does not apply the filter value${missing.length > 1 ? 's' : ''} ${missing.map((value) => JSON.stringify(value)).join(', ')}; nothing was executed`, proofs };
  }
  if (literals.length > 0) proofs.push(`every filter literal (${literals.map((value) => JSON.stringify(value)).join(', ')}) is bound in the executed query`);
  // The time window is a restriction too: both bounds must be bound, as
  // parameters or as date literals, or nothing runs.
  if (intent.time?.window) {
    const bounds = [intent.time.window.start, intent.time.window.end].map((bound) => bound.slice(0, 10).toLowerCase());
    const unbound = bounds.filter((bound) => !haystack.includes(bound));
    const fixed = candidate.tier === 'certified' ? candidate.fixedWindow : undefined;
    if (unbound.length > 0 && fixed && fixed.start.slice(0, 10) === bounds[0] && fixed.end.slice(0, 10) === bounds[1]) {
      proofs.push(`the time window ${bounds[0]}..${bounds[1]} is the period the certified block's own WHERE fixes on ${fixed.column}`);
    } else if (unbound.length > 0) {
      return { ok: false, code: 'filter_not_applied', message: `the prepared query does not apply the time window ${intent.time.window.start}..${intent.time.window.end} (missing ${unbound.join(', ')}); nothing was executed`, proofs };
    } else {
      proofs.push(`the time window ${bounds[0]}..${bounds[1]} is bound in the executed query`);
    }
  }

  if (candidate.fanoutProbeSql) {
    try {
      const probe = await deps.run(candidate.fanoutProbeSql, undefined, { maxRows: 1, purpose: 'fanout_probe', tier: candidate.tier, ...(deps.signal ? { signal: deps.signal } : {}) });
      const row = probe.rows[0] ?? {};
      const base = Number(row.base_rows ?? row.BASE_ROWS ?? NaN);
      const joined = Number(row.joined_rows ?? row.JOINED_ROWS ?? NaN);
      if (Number.isFinite(base) && Number.isFinite(joined) && joined > base) {
        return { ok: false, code: 'fanout_detected', message: `the join multiplies fact rows (${base} base rows became ${joined}); the aggregate would be inflated, so nothing was executed`, proofs };
      }
      proofs.push('the join fan-out probe found no row multiplication');
    } catch (error) {
      proofs.push(`fan-out probe could not run (${statementFailure(error, { sql: candidate.fanoutProbeSql }).message}); aggregation safety unproven`);
    }
  }
  try {
    const executed = candidate.semanticProgram
      ? await executeSemanticProgram(candidate.semanticProgram, deps, candidate)
      : await deps.run(candidate.sql, candidate.params, { maxRows: deps.maxRows ?? 500, purpose: 'query', tier: candidate.tier, ...(deps.signal ? { signal: deps.signal } : {}) });
    const computed = candidate.derived?.length ? applyDerivedColumns(executed, candidate.derived) : executed;
    const compared = candidate.changes?.length ? applyChangeColumns(computed, candidate.changes) : computed;
    const postProcessed = candidate.semanticProgram
      ? applySemanticProgramPostProcess(compared, candidate.semanticProgram.postProcess)
      : compared;
    const tie = candidate.tieProbe ? resolveTie(postProcessed, candidate.tieProbe) : { result: postProcessed };
    const result = tie.result;
    if (tie.note) proofs.push(`tie: ${tie.note}`);
    proofs.push(`executed on the warehouse: ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} in ${Math.round(result.executionTimeMs)} ms`);
    if (candidate.derived?.length) proofs.push(`ratio${candidate.derived.length > 1 ? 's' : ''} ${candidate.derived.map((item) => `${item.alias} = ${item.numerator} / ${item.denominator}`).join('; ')} computed from the executed columns`);
    if (candidate.changes?.length) proofs.push(`comparison${candidate.changes.length > 1 ? 's' : ''} ${candidate.changes.map((item) => `${item.alias} = ${item.comparison} - ${item.base}${item.as === 'percent' ? ` over ${item.base}` : ''}`).join('; ')} computed from the semantic result${candidate.changes.some((item) => item.as === 'percent') ? ' (null when the earlier value is 0)' : ''}`);
    const cause = emptyAggregateCause(intent, result, deps.fieldNames);
    if (cause) return { ok: false, code: 'no_rows_matched', message: describeEmptyAggregate(cause), proofs, cause };
    return { ok: true, result, proofs };
  } catch (error) {
    const failed = statementFailure(error, { sql: candidate.sql, ...(candidate.relations ? { relations: candidate.relations } : {}) });
    return { ok: false, code: 'execution_failed', message: failed.message, proofs, warehouse: failed.warehouse, ...(failed.repair !== undefined ? { repair: failed.repair } : {}) };
  }
}

const GRAIN_STEP: Record<string, (date: Date) => void> = {
  day: (date) => date.setUTCDate(date.getUTCDate() + 1),
  week: (date) => date.setUTCDate(date.getUTCDate() + 7),
  month: (date) => date.setUTCMonth(date.getUTCMonth() + 1),
  quarter: (date) => date.setUTCMonth(date.getUTCMonth() + 3),
  year: (date) => date.setUTCFullYear(date.getUTCFullYear() + 1),
};

const startOfGrain = (date: Date, grain: string): Date => {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (grain === 'week') { start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); return start; }
  if (grain === 'month') return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  if (grain === 'quarter') return new Date(Date.UTC(start.getUTCFullYear(), Math.floor(start.getUTCMonth() / 3) * 3, 1));
  if (grain === 'year') return new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
  return start;
};

/**
 * A SERIES MUST COVER THE PERIOD IT CLAIMS.
 *
 * "Monthly totals during calendar 2017" is twelve months. A warehouse returns
 * only the months that have rows, so a summer with no games silently became a
 * ten-row year: the reader cannot tell a month with nothing in it from a month
 * nobody asked about. The window the intent bound is the authority, so the
 * missing periods are added here, in the order the series runs — additive
 * measures read 0 (nothing happened), anything else stays null (nothing to
 * average). Only a single time grouping over an absolute window with no limit
 * is filled: with another grouping beside it, which member the empty period
 * belongs to is not ours to invent.
 */
export function fillPeriodGaps(intent: AnalyticalIntentV1, result: ExecutedRows): { result: ExecutedRows; added: number } {
  const window = intent.time?.window;
  const groups = intent.groupBy;
  const time = groups.find((group) => group.role === 'time' && group.grain);
  if (!window || !time?.grain || groups.length !== 1 || intent.limit !== undefined || !GRAIN_STEP[time.grain]) return { result, added: 0 };
  if (result.truncated || result.rows.length === 0) return { result, added: 0 };
  const start = new Date(`${window.start.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${window.end.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { result, added: 0 };
  const timeColumn = result.columns.find((column) => result.columnsMeta?.some((meta) => meta.name === column && meta.kind === 'date'))
    ?? result.columns.find((column) => result.rows.every((row) => typeof row[column] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(String(row[column]))));
  if (!timeColumn) return { result, added: 0 };
  const key = (value: unknown): string => String(value ?? '').slice(0, 10);
  const present = new Set(result.rows.map((row) => key(row[timeColumn])));
  // A filled period must look like the periods the warehouse returned: a bare
  // date beside timestamps (or the other way round) reads as a different value
  // to everything downstream.
  const sample = String(result.rows[0]?.[timeColumn] ?? '');
  const asPeriod = (iso: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(sample) ? iso : sample.includes('T') || sample === '' ? `${iso}T00:00:00.000Z` : iso);
  // Which columns read 0 for an empty period: only the measures that ADD up.
  // An average or a ratio of nothing is not zero, it is unknown.
  const additiveRefs = new Set(intent.measures
    .filter((measure) => !measure.derived && (measure.aggregation === undefined || ['sum', 'count', 'count_distinct'].includes(measure.aggregation)))
    .map((measure) => measure.ref));
  const additiveAliases = new Set(intent.measures
    .filter((measure) => !measure.derived && (measure.aggregation === undefined || ['sum', 'count', 'count_distinct'].includes(measure.aggregation)))
    .map((measure) => measure.alias)
    .filter((alias): alias is string => Boolean(alias)));
  const additive = new Set(result.columns.filter((column) => {
    if (additiveAliases.has(column)) return true;
    const meta = result.columnsMeta?.find((item) => item.name === column);
    return Boolean(meta?.ref && additiveRefs.has(meta.ref));
  }));
  const rows = [...result.rows];
  let added = 0;
  for (let at = startOfGrain(start, time.grain); at < end; GRAIN_STEP[time.grain]!(at)) {
    const iso = at.toISOString().slice(0, 10);
    if (present.has(iso)) continue;
    const row: Record<string, unknown> = {};
    for (const column of result.columns) {
      row[column] = column === timeColumn ? asPeriod(iso) : additive.has(column) ? 0 : null;
    }
    rows.push(row);
    added += 1;
    if (added > 400) return { result, added: 0 };
  }
  if (added === 0) return { result, added: 0 };
  rows.sort((left, right) => key(left[timeColumn]).localeCompare(key(right[timeColumn])));
  return { result: { ...result, rows, rowCount: rows.length }, added };
}
