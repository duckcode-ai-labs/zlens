import { extractTablesFromSql } from '../lineage/index.js';
import { contractGroupingColumns } from './select-items.js';
import { groupingIdentityGap, type GroupingIdentityGap, type RelationKeyKnowledge } from './grouping-identity.js';

/**
 * Certification metadata a creator would otherwise type by hand when an answer
 * becomes a draft block. Everything here is derived from what the answer already
 * knows (its SQL or semantic fields, its result column names, its lineage). It
 * never reads or writes data values, and it never overrides a value the draft
 * already declares.
 *
 * Exported so every writer of a draft block (the Block Studio route and the
 * enterprise draft-space worker) can call the same function.
 */

export interface CertificationPrefillHints {
  /** The answer's SQL, used when the draft source has no `query` of its own and is not a semantic block. */
  sql?: string;
  /** Column names of the answer's result (names only, never rows). Ignored for a semantic block. */
  columns?: string[];
  /** The creator the draft is assigned to. */
  owner?: string;
  /** Business entities known from the semantic layer for a semantic draft. */
  entities?: string[];
  /** Maps a table the SQL reads to its dbt model/source id, when lineage knows it. */
  sourceSystemFor?: (table: string) => string | undefined;
  /** Keys and columns known for the tables the SQL reads (from the warehouse catalog or dbt), used to name the key to add. */
  knownRelations?: RelationKeyKnowledge[];
  /**
   * The question the answer was given for (a request's question, an Ask
   * turn). Recorded as the block's first example, so once certified the block
   * answers that question before any model reads it.
   */
  question?: string;
}

export interface CertificationSuggestion {
  field: string;
  value: string | string[];
}

export interface CertificationPrefill {
  source: string;
  /** Every value written, so the creator can review it. */
  suggested: CertificationSuggestion[];
  /** Fields the answer did not tell us enough to suggest. */
  unknown: string[];
  /**
   * Set when the SQL groups by labels only, so Ask could not serve the block as
   * a certified answer. A suggestion for the creator to review: the SQL is
   * never rewritten.
   */
  identityGap?: GroupingIdentityGap;
}

const DEFAULT_PATTERN = 'custom';
const DEFAULT_REVIEW_CADENCE = 'quarterly';
const DEFAULT_TEST = 'assert row_count > 0';

export function prefillCertificationMetadata(source: string, hints: CertificationPrefillHints = {}): CertificationPrefill {
  const open = source.match(/\bblock\s+"[^"]+"\s*\{/i);
  if (!open || open.index === undefined) return { source, suggested: [], unknown: [] };

  const metrics = [...readList(source, 'metrics'), ...readString(source, 'metric')];
  const dimensions = readList(source, 'dimensions');
  // A semantic block runs its own metrics and dimensions. The answer's SQL and columns
  // may describe a different query, so they must not shape its grain, outputs or lineage.
  const isSemantic = metrics.length > 0 || dimensions.length > 0;
  const ownQuery = extractQuery(source);
  const sql = (ownQuery ?? (isSemantic ? '' : hints.sql) ?? '').trim();
  const columns = isSemantic ? undefined : hints.columns;
  const tables = sql ? usedTables(sql) : [];

  const suggested: CertificationSuggestion[] = [];
  const unknown: string[] = [];
  const identityGap = sql ? groupingIdentityGapOfSql(sql, hints.knownRelations, dimensions) : undefined;
  const withGap = (prefill: CertificationPrefill): CertificationPrefill => (identityGap ? { ...prefill, identityGap } : prefill);
  const propose = (field: string, value: string | string[] | undefined) => {
    if (value === undefined || (Array.isArray(value) && value.length === 0) || value === '') {
      unknown.push(field);
      return;
    }
    suggested.push({ field, value });
  };

  if (!hasValue(source, 'pattern')) propose('pattern', DEFAULT_PATTERN);
  if (!hasValue(source, 'grain')) propose('grain', grainFor(sql, dimensions));
  if (!hasValue(source, 'outputs')) propose('outputs', unique(columns?.length ? columns : outputsFor(sql, dimensions, metrics)));
  if (!hasValue(source, 'reviewCadence')) propose('reviewCadence', DEFAULT_REVIEW_CADENCE);
  if (!hasValue(source, 'entities')) {
    propose('entities', unique(hints.entities?.length ? hints.entities : tables.map(lastSegment)));
  }
  if (!hasValue(source, 'sourceSystems')) {
    propose('sourceSystems', unique(tables.map((table) => hints.sourceSystemFor?.(table) ?? table)));
  }
  if (!/\btests\s*\{/i.test(source)) propose('tests', DEFAULT_TEST);
  if (hints.owner?.trim() && !hasValue(source, 'owner')) propose('owner', hints.owner.trim());
  const question = hints.question?.replace(/\s+/g, ' ').trim();
  if (question && !hasExamples(source)) propose('examples', [question]);

  if (suggested.length === 0) return withGap({ source, suggested, unknown });

  const fieldLines = suggested
    .filter((entry) => entry.field !== 'tests')
    .map((entry) => `  ${entry.field} = ${renderField(entry.field, entry.value)}`);
  const marker = `  // Suggested by DQL from this answer. Review each value before you certify: ${suggested.map((entry) => entry.field).join(', ')}.`;

  let next = source;
  // A field the skeleton left empty (`owner = ""`) is filled in place so it appears once.
  for (const entry of suggested) {
    if (entry.field === 'tests') continue;
    const empty = new RegExp(`^([ \\t]*)${entry.field}[ \\t]*=[ \\t]*(?:""|\\[[ \\t]*\\])[ \\t]*$`, 'm');
    if (empty.test(next)) {
      next = next.replace(empty, `$1${entry.field} = ${renderField(entry.field, entry.value)}`);
      const at = fieldLines.indexOf(`  ${entry.field} = ${renderField(entry.field, entry.value)}`);
      if (at >= 0) fieldLines.splice(at, 1);
    }
  }
  const head = next.match(/\bblock\s+"[^"]+"\s*\{/i)!;
  const insertAt = (head.index ?? 0) + head[0].length;
  next = `${next.slice(0, insertAt)}\n${[marker, ...fieldLines].join('\n')}${next.slice(insertAt)}`;

  if (suggested.some((entry) => entry.field === 'tests')) {
    const close = next.lastIndexOf('}');
    if (close > 0) next = `${next.slice(0, close).trimEnd()}\n\n  tests {\n    ${DEFAULT_TEST}\n  }\n}${next.slice(close + 1)}`;
  }
  return withGap({ source: next, suggested, unknown });
}

function render(value: string | string[]): string {
  return Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(', ')}]` : JSON.stringify(value);
}

/** `examples` holds the questions the block answers, each as `{ question = "…" }`; every other field is a string or a list of strings. */
function renderField(field: string, value: string | string[]): string {
  if (field !== 'examples') return render(value);
  const questions = Array.isArray(value) ? value : [value];
  return `[${questions.map((question) => `{ question = ${JSON.stringify(question)} }`).join(', ')}]`;
}

function hasExamples(source: string): boolean {
  return /\bexamples\s*=\s*\[\s*\{/i.test(source);
}

function hasValue(source: string, key: string): boolean {
  if (new RegExp(`\\b${key}\\s*=\\s*"[^"]+"`, 'i').test(source)) return true;
  return new RegExp(`\\b${key}\\s*=\\s*\\[\\s*"`, 'i').test(source);
}

function readList(source: string, key: string): string[] {
  const match = source.match(new RegExp(`\\b${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'i'));
  return match ? (match[1].match(/"([^"]*)"/g) ?? []).map((item) => item.slice(1, -1)) : [];
}

function readString(source: string, key: string): string[] {
  const value = source.match(new RegExp(`\\b${key}\\s*=\\s*"([^"]+)"`, 'i'))?.[1];
  return value ? [value] : [];
}

function extractQuery(source: string): string | undefined {
  return source.match(/\bquery\s*=\s*"""([\s\S]*?)"""/i)?.[1];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function lastSegment(table: string): string {
  return table.split('.').filter(Boolean).pop() ?? table;
}

function usedTables(sql: string): string[] {
  try {
    return unique(extractTablesFromSql(sql).tables.map((table) => table.replace(/^"|"$/g, '')));
  } catch {
    return [];
  }
}

function stripSql(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ');
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Blank everything inside parentheses so CTE bodies, subqueries and function
 * arguments cannot be mistaken for the outermost query. Quoted text is kept.
 */
function outermostQuery(sql: string): string {
  let out = '';
  let depth = 0;
  let quote = '';
  for (const char of stripSql(sql)) {
    if (quote) {
      if (char === quote) quote = '';
      out += depth > 0 ? ' ' : char;
    } else if (char === "'" || char === '"') {
      quote = char;
      out += depth > 0 ? ' ' : char;
    } else if (char === '(') {
      out += depth === 0 ? char : ' ';
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
      out += depth === 0 ? char : ' ';
    } else {
      out += depth > 0 ? ' ' : char;
    }
  }
  return out;
}

/** The outermost SELECT's text, or undefined when a set operation makes its shape ambiguous. */
function outerSelect(sql: string): string | undefined {
  const outer = outermostQuery(sql);
  if (/\b(?:union|intersect|except)\b/i.test(outer)) return undefined;
  const start = outer.search(/\bselect\b/i);
  return start < 0 ? undefined : outer.slice(start);
}

function selectOutputs(sql: string): string[] {
  const match = outerSelect(sql)?.match(/\bselect\b([\s\S]+?)\bfrom\b/i);
  if (!match) return [];
  return splitTopLevel(match[1]).map((expression) =>
    (expression.match(/\bas\s+["`]?([A-Za-z_][A-Za-z0-9_$]*)["`]?\s*$/i)?.[1]
      ?? expression.match(/(?:^|\.)["`]?([A-Za-z_][A-Za-z0-9_$]*)["`]?\s*$/)?.[1]
      ?? ''));
}

function outputsFor(sql: string, dimensions: string[], metrics: string[]): string[] {
  return sql ? selectOutputs(sql).filter(Boolean) : [...dimensions, ...metrics];
}

/** "one row per <cols>" from the GROUP BY (or, for a semantic draft, its dimensions). */
function grainFor(sql: string, dimensions: string[]): string | undefined {
  const fields = sql ? groupByFields(sql) : dimensions;
  const clean = unique(fields);
  return clean.length > 0 ? `one row per ${clean.join(', ')}` : undefined;
}

/** The columns the outermost query groups by, or [] when they cannot all be named. */
export function groupingColumnsOfSql(sql: string): string[] {
  return groupByFields(sql);
}

/**
 * Whether a block's SQL groups by labels only. The grouping columns are the ones
 * Ask's certified matcher reads (plain SELECT outputs, `GROUP BY ALL` included,
 * declared dimensions as the fallback), so the warning and the matcher agree.
 */
export function groupingIdentityGapOfSql(sql: string, known: readonly RelationKeyKnowledge[] = [], declaredDimensions: readonly string[] = []): GroupingIdentityGap | undefined {
  return groupingIdentityGap(contractGroupingColumns(sql, declaredDimensions), usedTables(sql), known);
}

/** The tables a block's SQL reads. */
export function tablesOfSql(sql: string): string[] {
  return usedTables(sql);
}

function groupByFields(sql: string): string[] {
  const match = outerSelect(sql)?.match(/\bgroup\s+by\b([\s\S]+?)(?:\border\s+by\b|\blimit\b|\bqualify\b|\bhaving\b|\bwindow\b|$)/i);
  if (!match) return [];
  const outputs = selectOutputs(sql);
  const fields = splitTopLevel(match[1]).map((item) => {
    const cleaned = item.replace(/["`]/g, '').trim();
    // GROUP BY 2 names the second SELECT column.
    if (/^\d+$/.test(cleaned)) return outputs[Number(cleaned) - 1] ?? '';
    return /^[A-Za-z_][A-Za-z0-9_$.]*$/.test(cleaned) ? lastSegment(cleaned) : '';
  });
  // An expression we cannot name would make a partial grain read as the whole grain.
  return fields.every(Boolean) ? fields : [];
}
