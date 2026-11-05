/**
 * Grain ledger + static fan-out detection (W1.3).
 *
 * The class-B (wrong-number) failure mode is a VALID query over real columns that
 * returns an inflated total because an additive aggregate is computed after a
 * one-to-many join — every row of the aggregated relation is multiplied by the
 * number of matching rows on the "many" side. `validateSql` proves identifiers
 * exist; it says nothing about join grain. This module adds a deterministic,
 * zero-LLM check: given per-relation unique keys (the ledger) and the parsed join
 * graph, flag an additive aggregate over relation R when R is joined to a relation
 * S on a column that is NOT a unique key of S (so S contributes multiple rows per
 * R row). It is intentionally conservative — no key data for a relation ⇒ no flag —
 * so it never demotes a correct answer; it is wired warn-only.
 */
import { analyzeSqlReferences, type SqlReferenceAnalysis, tableName } from '@zlens/core';
import type { MetadataObject } from './catalog.js';

export interface RelationGrain {
  /** Normalized relation tail token (e.g. `fct_orders`). */
  relation: string;
  /** Columns that ALONE uniquely identify a row (single-column keys only). */
  uniqueKeys: Set<string>;
  source: string;
}

export type GrainLedger = Map<string, RelationGrain>;

export interface FanoutRisk {
  aggregate: string;
  aggregatedRelation: string;
  fanoutRelation: string;
  joinColumn: string;
  message: string;
}

export type AggregationIntegrityIssueKind =
  | 'premature_rounding'
  | 'lossy_numeric_cast'
  | 'fanout'
  | 'non_additive_measure';

export interface AggregationIntegrityIssue {
  kind: AggregationIntegrityIssueKind;
  message: string;
}

/** Additive aggregates whose value changes when rows are duplicated. MIN/MAX are safe. */
const ADDITIVE_AGGREGATES = new Set(['SUM', 'AVG', 'COUNT']);

function normalizeColumn(column: string): string {
  return column.replace(/["`]/g, '').trim().toLowerCase();
}

function addUniqueKey(ledger: GrainLedger, relation: string | undefined, column: string, source: string): void {
  const key = tableName(relation ?? '').toLowerCase() || undefined;
  if (!key) return;
  const existing = ledger.get(key);
  if (existing) {
    existing.uniqueKeys.add(normalizeColumn(column));
    return;
  }
  ledger.set(key, { relation: key, uniqueKeys: new Set([normalizeColumn(column)]), source });
}

/**
 * Build a grain ledger from catalog objects. v0 sources single-column unique keys
 * from DataLex entity primary-key fields and any dbt/catalog object that carries a
 * `primaryKey` / `uniqueColumns` payload (the hook dbt unique-test extraction fills
 * in W5.3). Composite keys are intentionally skipped — a single column of a
 * composite key is not unique on its own, so treating it as one would miss fan-out.
 */
export function buildGrainLedger(objects: MetadataObject[]): GrainLedger {
  const ledger: GrainLedger = new Map();
  for (const object of objects) {
    if (object.objectType === 'datalex_entity') {
      const binding = object.payload?.binding as { ref?: string } | undefined;
      const relation = binding?.ref ?? object.fullName ?? object.name;
      const fields = Array.isArray(object.payload?.fields) ? object.payload!.fields as Array<Record<string, unknown>> : [];
      const primaryKeys = fields.filter((field) => field?.primaryKey === true && typeof field.name === 'string');
      // Only a lone primary key column is a single-column unique key.
      if (primaryKeys.length === 1) {
        addUniqueKey(ledger, relation, String(primaryKeys[0].name), 'datalex primary key');
      }
      // Entity-level candidate/business keys (W5.2). Conservatively use only entries
      // that are a SINGLE simple column token — a composite key (e.g. "a, b") is not
      // a single-column unique key, and over-claiming uniqueness would MISS a real
      // fan-out (a silent wrong number), so we skip anything non-atomic.
      for (const keyList of [object.payload?.candidateKeys, object.payload?.businessKeys]) {
        if (!Array.isArray(keyList)) continue;
        for (const key of keyList) {
          if (typeof key === 'string' && /^[A-Za-z_][\w]*$/.test(key.trim())) {
            addUniqueKey(ledger, relation, key.trim(), 'datalex candidate/business key');
          }
        }
      }
      continue;
    }
    // Generic hook: an object may declare its own key columns (dbt constraints /
    // unique tests once extracted, or explicit metadata). uniqueColumns lists
    // single-column unique keys; primaryKey is a single-column PK.
    const uniqueColumns = object.payload?.uniqueColumns;
    if (Array.isArray(uniqueColumns)) {
      const relation = metadataRelationName(object);
      for (const column of uniqueColumns) {
        if (typeof column === 'string') addUniqueKey(ledger, relation, column, 'declared unique column');
      }
    }
    const primaryKey = object.payload?.primaryKey;
    if (typeof primaryKey === 'string') {
      addUniqueKey(ledger, metadataRelationName(object), primaryKey, 'declared primary key');
    }
  }
  return ledger;
}

function metadataRelationName(object: MetadataObject): string | undefined {
  const relation = object.payload?.relation;
  if (typeof relation === 'string' && relation.trim()) return relation;
  return object.fullName ?? object.name;
}

/**
 * Detect additive aggregates that risk fan-out double-counting given the ledger.
 * An aggregate over relation R is flagged when R is joined to a relation S on a
 * column that is NOT a known unique key of S (S can contribute many rows per R row).
 */
export function detectFanoutRisks(analysis: SqlReferenceAnalysis, ledger: GrainLedger): FanoutRisk[] {
  if (!analysis.parsed || analysis.joins.length === 0) return [];
  const risks: FanoutRisk[] = [];
  const seen = new Set<string>();
  for (const aggregate of analysis.aggregates) {
    if (aggregate.distinct) continue;
    if (!ADDITIVE_AGGREGATES.has(aggregate.func)) continue;
    const aggregatedRelation = tableName(aggregate.relation ?? '').toLowerCase() || undefined;
    if (!aggregatedRelation) continue; // COUNT(*) / unattributed — out of scope for v0
    for (const join of analysis.joins) {
      const left = tableName(join.leftRelation ?? '').toLowerCase() || undefined;
      const right = tableName(join.rightRelation ?? '').toLowerCase() || undefined;
      let counterpart: string | undefined;
      let counterpartColumn: string | undefined;
      if (left === aggregatedRelation) {
        counterpart = right;
        counterpartColumn = normalizeColumn(join.rightColumn);
      } else if (right === aggregatedRelation) {
        counterpart = left;
        counterpartColumn = normalizeColumn(join.leftColumn);
      } else {
        continue;
      }
      if (!counterpart || !counterpartColumn) continue;
      const counterpartGrain = ledger.get(counterpart);
      if (!counterpartGrain) continue; // unknown counterpart grain → conservative, no flag
      if (counterpartGrain.uniqueKeys.has(counterpartColumn)) continue; // N:1 — safe
      const aggregateLabel = `${aggregate.func}(${aggregate.column ?? '*'})`;
      const dedupeKey = `${aggregateLabel}|${aggregatedRelation}|${counterpart}|${counterpartColumn}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      risks.push({
        aggregate: aggregateLabel,
        aggregatedRelation,
        fanoutRelation: counterpart,
        joinColumn: counterpartColumn,
        message:
          `Possible fan-out: ${aggregateLabel} aggregates ${aggregatedRelation}, which is joined one-to-many to ` +
          `${counterpart} on ${counterpartColumn} (not a unique key of ${counterpart}). This can double-count. ` +
          `Pre-aggregate ${aggregatedRelation} in a CTE before joining, or use COUNT(DISTINCT ...).`,
      });
    }
  }
  return risks;
}

/**
 * Convenience wrapper: parse the SQL, build the ledger from the objects, and return
 * fan-out warning strings. Best-effort — any parse failure yields no warnings.
 */
export function fanoutWarningsForSql(sql: string, objects: MetadataObject[], dialect = 'duckdb'): string[] {
  try {
    const analysis = analyzeSqlReferences(sql, dialect);
    if (!analysis.parsed) return [];
    const ledger = buildGrainLedger(objects);
    if (ledger.size === 0) return [];
    return detectFanoutRisks(analysis, ledger).map((risk) => risk.message);
  } catch {
    return [];
  }
}

/**
 * AGT-005 / AGT-010 numeric contract for model-authored SQL.
 *
 * SQL parsing proves syntax and identifiers, not whether a number still means
 * the governed metric. This guard rejects four high-confidence wrong-number
 * shapes before execution:
 *   - rounding inside SUM/AVG (precision is lost before aggregation),
 *   - explicit conversion of aggregate inputs to approximate floating types,
 *   - a ledger-proven one-to-many fan-out, and
 *   - hand aggregation of a semantic measure that declares a non-additive
 *     dimension and therefore must be compiled by its semantic runtime.
 *
 * COALESCE is intentionally not rejected: SUM(COALESCE(x, 0)) is valid for a
 * raw additive measure. The system prompt prefers COALESCE(SUM(x), 0), while
 * the deterministic guards focus on changes that can alter the metric meaning.
 */
export function aggregationIntegrityIssuesForSql(
  sql: string,
  objects: MetadataObject[],
  dialect = 'duckdb',
): AggregationIntegrityIssue[] {
  const issues: AggregationIntegrityIssue[] = [];
  for (const call of additiveAggregateCalls(sql)) {
    if (/\bround\s*\(/i.test(call.body)) {
      issues.push({
        kind: 'premature_rounding',
        message:
          `${call.func} rounds an input before aggregation. Preserve the source DECIMAL/NUMERIC precision, ` +
          `aggregate at the proven native grain, then apply ROUND only to the outer final result (for example ROUND(COALESCE(SUM(amount), 0), 2)).`,
      });
    }
    // SQLite stores no DECIMAL: a NUMERIC-declared column already holds an
    // INTEGER or a REAL, so casting to REAL loses nothing, and it is the
    // standard guard against SQLite's integer division.
    if (dialect.trim().toLowerCase() !== 'sqlite' && hasLossyNumericCast(call.body)) {
      issues.push({
        kind: 'lossy_numeric_cast',
        message:
          `${call.func} converts an input to FLOAT/DOUBLE/REAL before aggregation. Amount calculations must retain the warehouse DECIMAL/NUMERIC type until final presentation.`,
      });
    }
  }

  let analysis: SqlReferenceAnalysis;
  try {
    analysis = analyzeSqlReferences(sql, dialect);
  } catch {
    return dedupeAggregationIssues(issues);
  }
  if (!analysis.parsed) return dedupeAggregationIssues(issues);

  const ledger = buildGrainLedger(objects);
  // The shared parser intentionally flattens aliases across CTE scopes. A join
  // in one CTE must not be used as proof that an aggregate in another CTE fans
  // out. Until scope ids are retained by SqlReferenceAnalysis, only a single
  // SELECT scope is high-confidence enough to fail closed; multi-CTE findings
  // remain visible through fanoutWarningsForSql's advisory path.
  if (ledger.size > 0 && analysis.ctes.length === 0) {
    for (const risk of detectFanoutRisks(analysis, ledger)) {
      issues.push({ kind: 'fanout', message: risk.message });
    }
  }

  const contracts = semanticNonAdditiveContracts(objects);
  for (const aggregate of analysis.aggregates) {
    if (!['SUM', 'AVG'].includes(aggregate.func) || !aggregate.column) continue;
    for (const contract of contracts) {
      if (!contract.columns.has(normalizeColumn(aggregate.column))) continue;
      const aggregateRelation = tableName(aggregate.relation ?? '').toLowerCase() || undefined;
      const contractRelation = tableName(contract.table ?? '').toLowerCase() || undefined;
      if (aggregateRelation && contractRelation && aggregateRelation !== contractRelation) continue;
      issues.push({
        kind: 'non_additive_measure',
        message:
          `${aggregate.func}(${aggregate.column}) bypasses the non-additive contract for semantic measure ${contract.name}. ` +
          `Compile the governed metric through the semantic runtime so its ${contract.dimensionLabel} rule and native grain are preserved; do not hand-sum it.`,
      });
    }
  }

  return dedupeAggregationIssues(issues);
}

interface AdditiveAggregateCall {
  func: 'SUM' | 'AVG';
  body: string;
}

function additiveAggregateCalls(sql: string): AdditiveAggregateCall[] {
  const masked = maskSqlLiteralsAndComments(sql);
  const calls: AdditiveAggregateCall[] = [];
  const pattern = /\b(SUM|AVG)\s*\(/gi;
  for (const match of masked.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(');
    const close = matchingSqlParen(masked, open);
    if (close < 0) continue;
    calls.push({
      func: match[1]!.toUpperCase() as 'SUM' | 'AVG',
      body: masked.slice(open + 1, close),
    });
  }
  return calls;
}

function matchingSqlParen(sql: string, open: number): number {
  let depth = 0;
  for (let index = open; index < sql.length; index += 1) {
    if (sql[index] === '(') depth += 1;
    else if (sql[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Mask literals/comments while preserving indices and structural parentheses. */
function maskSqlLiteralsAndComments(sql: string): string {
  const chars = [...sql];
  let index = 0;
  const blank = (position: number) => {
    if (chars[position] !== '\n' && chars[position] !== '\r') chars[position] = ' ';
  };
  while (index < chars.length) {
    if (chars[index] === '-' && chars[index + 1] === '-') {
      blank(index++);
      blank(index++);
      while (index < chars.length && chars[index] !== '\n') blank(index++);
      continue;
    }
    if (chars[index] === '/' && chars[index + 1] === '*') {
      blank(index++);
      blank(index++);
      while (index < chars.length) {
        const closes = chars[index] === '*' && chars[index + 1] === '/';
        blank(index++);
        if (closes) {
          blank(index++);
          break;
        }
      }
      continue;
    }
    const quote = chars[index];
    if (quote === "'" || quote === '"' || quote === '`' || quote === '[') {
      const closeQuote = quote === '[' ? ']' : quote;
      blank(index++);
      while (index < chars.length) {
        const closes = chars[index] === closeQuote;
        blank(index++);
        if (!closes) continue;
        if (quote !== '[' && chars[index] === closeQuote) {
          blank(index++);
          continue;
        }
        break;
      }
      continue;
    }
    index += 1;
  }
  return chars.join('');
}

function hasLossyNumericCast(body: string): boolean {
  return /::\s*(?:float(?:4|8)?|double(?:\s+precision)?|real)\b/i.test(body)
    || /\bcast\s*\([\s\S]*?\bas\s+(?:float(?:4|8)?|double(?:\s+precision)?|real)\b/i.test(body);
}

interface SemanticNonAdditiveContract {
  name: string;
  table?: string;
  columns: Set<string>;
  dimensionLabel: string;
}

function semanticNonAdditiveContracts(objects: MetadataObject[]): SemanticNonAdditiveContract[] {
  const contracts: SemanticNonAdditiveContract[] = [];
  for (const object of objects) {
    if (object.objectType !== 'semantic_measure' && object.objectType !== 'semantic_metric') continue;
    const payload = object.payload ?? {};
    if (object.objectType === 'semantic_metric' && Array.isArray(payload.nonAdditiveMeasures)) {
      for (const entry of payload.nonAdditiveMeasures) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const measure = entry as Record<string, unknown>;
        const name = typeof measure.name === 'string' ? measure.name : object.name;
        const expression = typeof measure.expression === 'string' ? measure.expression.trim() : '';
        const column = expression.replace(/^([A-Za-z_][\w$]*\.)/, '');
        if (!/^[A-Za-z_][\w$]*$/.test(column)) continue;
        contracts.push({
          name,
          table: typeof measure.table === 'string' ? measure.table : undefined,
          columns: new Set([normalizeColumn(column)]),
          dimensionLabel: describeNonAdditiveDimension(measure.nonAdditiveDimension),
        });
      }
    }
    const nonAdditive = payload.nonAdditiveDimension
      ?? payload.non_additive_dimension
      ?? payload.nonAdditiveDimensions;
    if (!nonAdditive || (Array.isArray(nonAdditive) && nonAdditive.length === 0)) continue;
    const columns = new Set<string>();
    const nameTail = object.name.split('.').at(-1);
    if (nameTail) columns.add(normalizeColumn(nameTail));
    for (const value of [payload.expression, payload.expr, payload.formula]) {
      if (typeof value !== 'string') continue;
      const simpleColumn = value.trim().replace(/^([A-Za-z_][\w$]*\.)/, '');
      if (/^[A-Za-z_][\w$]*$/.test(simpleColumn)) columns.add(normalizeColumn(simpleColumn));
    }
    if (columns.size === 0) continue;
    contracts.push({
      name: object.name,
      table: typeof payload.table === 'string' ? payload.table : undefined,
      columns,
      dimensionLabel: describeNonAdditiveDimension(nonAdditive),
    });
  }
  return contracts;
}

function describeNonAdditiveDimension(value: unknown): string {
  if (Array.isArray(value)) return 'declared non-additive dimension';
  if (!value || typeof value !== 'object') return 'declared non-additive dimension';
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : undefined;
  return name ? `${name} non-additive` : 'declared non-additive dimension';
}

function dedupeAggregationIssues(issues: AggregationIntegrityIssue[]): AggregationIntegrityIssue[] {
  return [...new Map(issues.map((issue) => [`${issue.kind}:${issue.message}`, issue])).values()];
}
