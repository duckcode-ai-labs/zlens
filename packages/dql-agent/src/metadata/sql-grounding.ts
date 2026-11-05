/**
 * Shared SQL grounding (spec 15) — ONE grounding for BOTH the governed
 * answer-loop and the AI build engine. There is no "weak path".
 *
 * The grounding takes dbt artifacts (+ an optional set of relevant model names)
 * and produces, for each table:
 *   - the REAL qualified warehouse relation (`database.schema.alias`, e.g.
 *     `dev.order_items`) — never a bare model name,
 *   - the `{{ ref('<model>') }}` form for governed BLOCK SQL,
 *   - real columns + types (catalog.json preferred, manifest YAML fallback),
 *   - JOIN KEYS inferred from dbt `depends_on` and shared `*_id` / `*_key`
 *     columns,
 *   - a `certifiedBlock` flag (reserved for callers that pass certified models).
 *
 * On top of the grounding sit two deterministic, offline-safe primitives the
 * build path was missing:
 *   - `resolveRelationsInSql` — rewrites any bare / unqualified table name to
 *     its real qualified relation (model name OR alias → `db.schema.alias`),
 *   - `validateSqlAgainstGrounding` — flags any table or column the generated
 *     SQL references that is not in the grounding.
 *
 * Both are pure string/AST helpers so they work with no provider and never
 * crash the offline path.
 */

import { allowedRelationLookupFromTables, checkSqlReferences, extractSelectAliases, usingJoinColumns } from './sql-context-validation.js';
import { analyzeSqlReferences, tableName } from '@zlens/core';
import type { DbtArtifacts, DbtModelNode, DbtSourceNode } from '../propose/dbt-artifacts.js';

/** A single grounded table the model is allowed to reference. */
export interface GroundedColumn {
  name: string;
  type?: string;
  description?: string;
}

export interface GroundedTable {
  /** Logical model / source name (what `{{ ref() }}` uses). */
  name: string;
  /** Real qualified warehouse relation, e.g. `dev.order_items`. */
  qualifiedRelation: string;
  /** `{{ ref('<model>') }}` (models) or `{{ source(...) }}` (sources) form. */
  refForm?: string;
  /** Resolved columns with types. */
  columns: GroundedColumn[];
  /** 'model' | 'source'. */
  kind: 'model' | 'source';
  /** dbt uniqueId (for join-key inference and citations). */
  uniqueId: string;
  /** True when this table is backed by a certified DQL block. */
  certifiedBlock?: boolean;
}

/** A join key the model can use to connect two grounded relations. */
export interface GroundedJoinKey {
  leftRelation: string;
  leftColumn: string;
  rightRelation: string;
  rightColumn: string;
  reason: string;
}

export interface SchemaGrounding {
  tables: GroundedTable[];
  joinKeys: GroundedJoinKey[];
  /** Lower-cased lookup: bare name / alias / qualified relation → GroundedTable. */
  byKey: Map<string, GroundedTable>;
}

export interface BuildSchemaGroundingOptions {
  /** Cap on tables included in the grounding (top-K from retrieval). */
  limit?: number;
  /** Model/relation names that are backed by certified DQL blocks. */
  certifiedModelNames?: Iterable<string>;
}

function effectiveColumns(model: DbtModelNode, artifacts: DbtArtifacts): GroundedColumn[] {
  const catalog = artifacts.catalogColumns.get(model.uniqueId) ?? [];
  const source = catalog.length > 0 ? catalog : model.columns;
  return source.map((c) => ({ name: c.name, type: c.type, description: c.description }));
}

function sourceColumns(source: DbtSourceNode, artifacts: DbtArtifacts): GroundedColumn[] {
  const catalog = artifacts.catalogColumns.get(source.uniqueId) ?? [];
  return catalog.map((c) => ({ name: c.name, type: c.type, description: c.description }));
}

/** Lower-cased keys a relation can be referenced by (qualified, last 2, bare). */
export function relationKeys(relation: string): string[] {
  const normalized = relation.replace(/["`]/g, '').replace(/\s*\.\s*/g, '.').trim().toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>();
  if (normalized) keys.add(normalized);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  if (parts.length >= 1) keys.add(parts[parts.length - 1]!);
  return Array.from(keys);
}

function isJoinKeyColumn(name: string): boolean {
  return /(^|_)(id|key|sk|pk|fk)$/i.test(name) || /_id$|_key$/i.test(name);
}

/**
 * Build the shared schema grounding for a set of dbt models (+ sources).
 * `relevantModels`, when provided, restricts/orders the grounding to the
 * retrieval-selected relations; otherwise all models are grounded (capped).
 */
export function buildSchemaGrounding(
  artifacts: DbtArtifacts | undefined,
  relevantModels?: Iterable<string> | undefined,
  options: BuildSchemaGroundingOptions = {},
): SchemaGrounding {
  const empty: SchemaGrounding = { tables: [], joinKeys: [], byKey: new Map() };
  if (!artifacts) return empty;

  const limit = Math.max(1, options.limit ?? 24);
  const certified = new Set(
    Array.from(options.certifiedModelNames ?? []).map((name) => name.toLowerCase()),
  );

  // Order models: relevant first (in given order), then the rest, capped.
  const relevant = relevantModels ? Array.from(relevantModels).map((m) => m.toLowerCase()) : undefined;
  const modelByLower = new Map<string, DbtModelNode>();
  for (const model of artifacts.models) {
    modelByLower.set(model.name.toLowerCase(), model);
    if (model.alias) modelByLower.set(model.alias.toLowerCase(), model);
  }

  let ordered: DbtModelNode[];
  if (relevant && relevant.length > 0) {
    const seen = new Set<string>();
    ordered = [];
    for (const key of relevant) {
      const model = modelByLower.get(key);
      if (model && !seen.has(model.uniqueId)) {
        seen.add(model.uniqueId);
        ordered.push(model);
      }
    }
    // Backfill from the rest so a tiny retrieval set still has join partners.
    for (const model of artifacts.models) {
      if (ordered.length >= limit) break;
      if (!seen.has(model.uniqueId)) {
        seen.add(model.uniqueId);
        ordered.push(model);
      }
    }
  } else {
    ordered = artifacts.models.slice();
  }
  ordered = ordered.slice(0, limit);

  const tables: GroundedTable[] = ordered.map((model) => ({
    name: model.name,
    qualifiedRelation: model.qualifiedRelation || model.name,
    refForm: model.refForm,
    columns: effectiveColumns(model, artifacts),
    kind: 'model' as const,
    uniqueId: model.uniqueId,
    certifiedBlock:
      certified.has(model.name.toLowerCase()) ||
      (model.alias ? certified.has(model.alias.toLowerCase()) : false) ||
      certified.has(model.qualifiedRelation.toLowerCase()),
  }));

  // Add sources that have catalog columns (referenced relations may be sources).
  const remaining = Math.max(0, limit - tables.length);
  for (const source of artifacts.sources.slice(0, remaining)) {
    const cols = sourceColumns(source, artifacts);
    if (cols.length === 0) continue;
    tables.push({
      name: source.name,
      qualifiedRelation: source.qualifiedRelation || source.name,
      refForm: source.refForm,
      columns: cols,
      kind: 'source',
      uniqueId: source.uniqueId,
    });
  }

  const byKey = new Map<string, GroundedTable>();
  for (const table of tables) {
    for (const key of [...relationKeys(table.qualifiedRelation), ...relationKeys(table.name)]) {
      if (!byKey.has(key)) byKey.set(key, table);
    }
  }

  const joinKeys = inferJoinKeys(tables, artifacts);
  return { tables, joinKeys, byKey };
}

/**
 * Infer join keys two ways:
 *   1) dbt `depends_on` lineage: a model that depends on another and shares an
 *      `*_id` / `*_key` column joins on that column.
 *   2) shared `*_id` / `*_key` columns between any two grounded relations.
 * Deduped; lineage-derived keys are preferred (listed first).
 */
function inferJoinKeys(tables: GroundedTable[], artifacts: DbtArtifacts): GroundedJoinKey[] {
  const byUniqueId = new Map(tables.map((t) => [t.uniqueId, t] as const));
  const modelByUniqueId = new Map(artifacts.models.map((m) => [m.uniqueId, m] as const));
  const out: GroundedJoinKey[] = [];
  const seen = new Set<string>();

  const push = (key: GroundedJoinKey) => {
    const id = [key.leftRelation, key.leftColumn, key.rightRelation, key.rightColumn]
      .map((p) => p.toLowerCase())
      .sort()
      .join('|');
    if (seen.has(id)) return;
    seen.add(id);
    out.push(key);
  };

  // 1) Lineage-derived: child depends_on parent; shared id/key column.
  for (const table of tables) {
    const model = modelByUniqueId.get(table.uniqueId);
    if (!model) continue;
    for (const upstreamId of model.dependsOn) {
      const upstream = byUniqueId.get(upstreamId);
      if (!upstream) continue;
      for (const col of table.columns) {
        if (!isJoinKeyColumn(col.name)) continue;
        if (upstream.columns.some((u) => u.name.toLowerCase() === col.name.toLowerCase())) {
          push({
            leftRelation: table.qualifiedRelation,
            leftColumn: col.name,
            rightRelation: upstream.qualifiedRelation,
            rightColumn: col.name,
            reason: `dbt lineage: ${table.name} depends_on ${upstream.name}, shared key ${col.name}`,
          });
        }
      }
    }
  }

  // 2) Shared *_id / *_key columns between any two relations.
  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const left = tables[i]!;
      const right = tables[j]!;
      for (const col of left.columns) {
        if (!isJoinKeyColumn(col.name)) continue;
        if (right.columns.some((r) => r.name.toLowerCase() === col.name.toLowerCase())) {
          push({
            leftRelation: left.qualifiedRelation,
            leftColumn: col.name,
            rightRelation: right.qualifiedRelation,
            rightColumn: col.name,
            reason: `shared key column ${col.name}`,
          });
        }
      }
    }
  }

  return out;
}

/** A pre-qualified runtime relation (the answer-loop's schema context shape). */
export interface RuntimeRelationInput {
  /** Already-qualified relation, e.g. `dev.order_items`. */
  relation: string;
  /** Bare table name. */
  name?: string;
  columns: Array<{ name: string; type?: string; description?: string }>;
}

/**
 * Build a `SchemaGrounding` from already-qualified runtime relations (the
 * answer-loop receives these from the host as `schemaContext` /
 * `allowedSqlContext`, so the relations are already real warehouse relations).
 * This lets the governed answer-loop reuse the SAME resolver + validator as the
 * build path without re-reading dbt artifacts. No join-key inference here for
 * relations already in the context pack — the answer-loop renders join paths from
 * that pack. (Since P3, a relation the model DISCOVERS mid-loop via get_table_schema
 * gets its inferred join keys directly from that tool's own result, not from here.)
 */
export function buildGroundingFromRuntimeRelations(relations: RuntimeRelationInput[]): SchemaGrounding {
  const tables: GroundedTable[] = relations.map((rel) => ({
    name: rel.name ?? (tableName(rel.relation) || rel.relation),
    qualifiedRelation: rel.relation,
    columns: rel.columns.map((c) => ({ name: c.name, type: c.type, description: c.description })),
    kind: 'model' as const,
    uniqueId: rel.relation,
  }));
  const byKey = new Map<string, GroundedTable>();
  for (const table of tables) {
    for (const key of [...relationKeys(table.qualifiedRelation), ...relationKeys(table.name)]) {
      if (!byKey.has(key)) byKey.set(key, table);
    }
  }
  return { tables, joinKeys: [], byKey };
}

// ─── Relation resolver ────────────────────────────────────────────────────────

export interface RelationResolution {
  /** SQL with bare / unqualified table names rewritten to qualified relations. */
  sql: string;
  /** Each rewrite applied, e.g. order_items → dev.order_items. */
  rewrites: Array<{ from: string; to: string }>;
}

/**
 * Internal catalog / knowledge-graph identities are retrieval keys, not SQL.
 * They occasionally appear in model output because the same context contains
 * both graph nodes and physical relations. Keep detection shared so generation,
 * validation, and execution surfaces enforce the same boundary.
 */
export function internalRelationIdsInSql(sql: string): string[] {
  const ids = Array.from(
    sql.matchAll(/\b(?:source|dbt|semantic)::[a-zA-Z_][\w$]*(?:\s*\.\s*[a-zA-Z_][\w$]*){0,2}/gi),
    (match) => match[0].replace(/\s*\.\s*/g, '.'),
  );
  return [...new Set(ids)];
}

/**
 * Rewrite internal graph identities (`source::`, `dbt::`, `semantic::`) in
 * FROM/JOIN position to the physical relation they encode.
 *
 * These are retrieval keys, not SQL. Models copy them out of retrieved context
 * despite explicit prompt instructions not to, and the read-only validator then
 * rejects the whole query.
 *
 * The original rule was "rewrite ONLY when the suffix proves a relation in the
 * grounding, otherwise leave it so the validator fails closed". That fails
 * closed on the wrong axis: for a QUALIFIED identity the suffix IS the physical
 * relation by construction, so leaving it does not protect anything — it just
 * guarantees a rejection for any table retrieval happened not to include. The
 * bug therefore looked fixed whenever the table was in context and returned the
 * moment it was not.
 *
 * So: prefer the grounding (it can correct the qualification, and knows the
 * `{{ ref() }}` form), and otherwise strip the prefix from a qualified suffix —
 * decoding, not guessing. A BARE identity such as `source::orders` carries no
 * database or schema, so it is still left alone: there the validator's complaint
 * is genuinely the right outcome.
 */
export function resolveInternalRelationIds(
  sql: string,
  grounding: SchemaGrounding,
  prefer: 'qualified' | 'ref' = 'qualified',
  rewrites: Array<{ from: string; to: string }> = [],
): string {
  const internalPattern = /\b(from|join)\s+((?:source|dbt|semantic)::([a-zA-Z_][\w$]*(?:\s*\.\s*[a-zA-Z_][\w$]*){0,2}))/gi;
  return sql.replace(
    internalPattern,
    (match, keyword: string, internalId: string, relationSuffix: string) => {
      const normalizedSuffix = relationSuffix.replace(/\s*\.\s*/g, '.');
      const table = lookupTable(normalizedSuffix, grounding);
      if (table) {
        const target = prefer === 'ref' && table.refForm ? table.refForm : table.qualifiedRelation;
        rewrites.push({ from: internalId, to: target });
        return `${keyword} ${target}`;
      }
      // Not in the grounding. A qualified suffix still names a real relation;
      // an unqualified one does not, and is left for the validator.
      if (!normalizedSuffix.includes('.')) return match;
      rewrites.push({ from: internalId, to: normalizedSuffix });
      return `${keyword} ${normalizedSuffix}`;
    },
  );
}

/**
 * Relation tokens that are QUERY-INTERNAL — CTE names and subquery aliases —
 * and therefore never physical relations, however much their names look like
 * one. Derived from the parsed statement, with the lexical fallback used when
 * the dialect parser cannot read the SQL (`analyzeSqlReferences` populates
 * `ctes` on both paths, so the exclusion set is always available).
 */
function queryLocalRelationNames(sql: string, dialect?: string): Set<string> {
  const analysis = analyzeSqlReferences(sql, dialect ?? 'duckdb');
  const local = new Set<string>();
  // Defensive spread: this crosses a package boundary, and a qualifier that
  // throws is worse than one that misses an exclusion.
  for (const name of [...(analysis.ctes ?? []), ...(analysis.derivedRelations ?? [])]) {
    const cleaned = name.replace(/["`\[\]]/g, '').trim().toLowerCase();
    if (cleaned) local.add(cleaned);
  }
  return local;
}

/**
 * Deterministically rewrite any bare / unqualified table name in `FROM` /
 * `JOIN` clauses to its real qualified relation from the grounding. Maps both
 * the model name and its alias to `database.schema.alias`. Already-qualified
 * relations that match the grounding are left untouched.
 *
 * A CTE or subquery alias that SHADOWS a real relation name keeps its local
 * meaning. Rewriting `FROM orders` inside
 * `WITH orders AS (SELECT … WHERE region = 'EMEA') SELECT SUM(amt) FROM orders`
 * detaches the CTE: the query still executes, and returns the UNFILTERED total
 * under a passing trust label. A wrong number with a green check is worse than
 * a refusal, so query-local names are never rewritten.
 *
 * For BLOCK SQL the caller may request the `{{ ref() }}` form instead of the
 * qualified relation via `prefer: 'ref'`.
 */
export function resolveRelationsInSql(
  sql: string,
  grounding: SchemaGrounding,
  options: { prefer?: 'qualified' | 'ref'; dialect?: string } = {},
): RelationResolution {
  if (!sql) return { sql, rewrites: [] };
  // An EMPTY grounding is precisely the case where a leaked `source::` identity
  // survives to the validator, so internal ids are decoded before the
  // grounding-dependent work is skipped. Bailing out first is what made this
  // bug reappear whenever retrieval came back thin.
  if (grounding.tables.length === 0) {
    const rewritesWithoutGrounding: Array<{ from: string; to: string }> = [];
    return {
      sql: resolveInternalRelationIds(sql, grounding, options.prefer ?? 'qualified', rewritesWithoutGrounding),
      rewrites: rewritesWithoutGrounding,
    };
  }
  const prefer = options.prefer ?? 'qualified';
  const rewrites: Array<{ from: string; to: string }> = [];

  const withoutInternalIds = resolveInternalRelationIds(sql, grounding, prefer, rewrites);

  const queryLocal = queryLocalRelationNames(withoutInternalIds, options.dialect);

  // Match the relation token after FROM / JOIN (skip subqueries starting with `(`).
  const pattern = /\b(from|join)\s+(?!\()([a-zA-Z_][\w]*(?:\s*\.\s*[a-zA-Z_][\w]*){0,2})/gi;
  const resolved = withoutInternalIds.replace(pattern, (match, keyword: string, relation: string) => {
    const normalized = relation.replace(/\s*\.\s*/g, '.');
    // Already a {{ ref() }} / {{ source() }} macro? Leave it.
    if (/\{\{/.test(normalized)) return match;
    // A CTE / subquery alias owns its name for the length of the statement.
    if (queryLocal.has(normalized.toLowerCase())) return match;
    const table = lookupTable(normalized, grounding);
    if (!table) return match; // unknown relation — validator will flag it.
    const target = prefer === 'ref' && table.refForm ? table.refForm : table.qualifiedRelation;
    if (normalized.toLowerCase() === target.toLowerCase()) return match; // already correct.
    rewrites.push({ from: normalized, to: target });
    return `${keyword} ${target}`;
  });

  return { sql: resolved, rewrites };
}

function lookupTable(relation: string, grounding: SchemaGrounding): GroundedTable | undefined {
  for (const key of relationKeys(relation)) {
    const hit = grounding.byKey.get(key);
    if (hit) return hit;
  }
  return undefined;
}

// ─── Validator ────────────────────────────────────────────────────────────────

export type GroundingValidationCode = 'unknown_relation' | 'unknown_column' | 'unsafe_sql' | 'unparseable';

export type GroundingValidationResult =
  | { ok: true; warnings: string[]; referencedRelations: string[] }
  | {
      ok: false;
      code: GroundingValidationCode;
      error: string;
      warnings: string[];
      referencedRelations: string[];
      /** The specific table/column that failed, for a targeted repair re-prompt. */
      offending?: { relation?: string; column?: string };
    };

/**
 * Validate that generated SQL references ONLY relations and columns present in
 * the shared grounding. Read-only safety is enforced too (no DML/DDL). Returns
 * a precise `offending` token so the build path can re-prompt the model with
 * the exact miss.
 */
export function validateSqlAgainstGrounding(
  sql: string,
  grounding: SchemaGrounding,
  dialect = 'duckdb',
): GroundingValidationResult {
  const analysis = analyzeSqlReferences(sql, dialect);
  const referencedRelations = analysis.tables;
  const warnings: string[] = [];

  if (!analysis.parsed) {
    return {
      ok: false,
      code: 'unparseable',
      error: `SQL could not be parsed for grounding validation: ${analysis.error ?? 'unknown parse error'}`,
      warnings,
      referencedRelations,
    };
  }

  const unsafe = analysis.statementTypes.find((type) => type !== 'select');
  if (unsafe) {
    return {
      ok: false,
      code: 'unsafe_sql',
      error: `Grounded SQL must be a read-only SELECT or WITH query; parser found ${unsafe.toUpperCase()}.`,
      warnings,
      referencedRelations,
    };
  }

  if (grounding.tables.length === 0) {
    return { ok: true, warnings: ['No grounding tables were available, so validation was advisory only.'], referencedRelations };
  }

  // Relation check — every referenced relation must be in the grounding.
  for (const relation of referencedRelations) {
    if (/\{\{/.test(relation)) continue; // `{{ ref() }}` macros resolve at execution.
    if (!lookupTable(relation, grounding)) {
      return {
        ok: false,
        code: 'unknown_relation',
        error: `SQL references table "${relation}" which is not in the grounded schema. Use one of: ${grounding.tables
          .slice(0, 8)
          .map((t) => t.qualifiedRelation)
          .join(', ')}.`,
        warnings,
        referencedRelations,
        offending: { relation },
      };
    }
  }

  // Column check — the one reference checker, over the grounded relations
  // this statement actually reads (live-probed, so their columns are complete).
  const referencedTables = referencedRelations
    .map((relation) => lookupTable(relation, grounding))
    .filter((table): table is GroundedTable => Boolean(table));
  const finding = checkSqlReferences({
    analysis,
    allowed: allowedRelationLookupFromTables(referencedTables.map((table) => ({
      relation: table.qualifiedRelation,
      name: table.name,
      columns: table.columns,
      source: 'grounded schema',
    }))),
    outputAliases: extractSelectAliases(sql),
    usingColumns: usingJoinColumns(sql),
    relationsResolved: true,
  });
  if (finding?.kind === 'unknown_column') {
    return {
      ok: false,
      code: 'unknown_column',
      error: finding.relation
        ? `SQL references column "${finding.column}" which does not exist on ${finding.relation}.`
        : `SQL references column "${finding.column}" which is not present on any grounded relation.`,
      warnings,
      referencedRelations,
      offending: { ...(finding.relation ? { relation: finding.relation } : {}), column: finding.column },
    };
  }
  if (finding?.kind === 'ambiguous_column') {
    return {
      ok: false,
      code: 'unknown_column',
      error: `SQL references unqualified column "${finding.column}", which exists on multiple joined relations: ${finding.owners.join(', ')}. Qualify it with the intended relation alias.`,
      warnings,
      referencedRelations,
      offending: { column: finding.column },
    };
  }

  return { ok: true, warnings, referencedRelations };
}

// ─── Prompt rendering ─────────────────────────────────────────────────────────

/**
 * Render the grounding as a prompt block. Each table is presented as BOTH its
 * qualified relation AND its `{{ ref() }}` form with real columns+types, plus
 * the inferred join keys. The convention line tells the model how to reference
 * relations for the given target (CELL → qualified; BLOCK → `{{ ref() }}`).
 */
export function renderGroundingForPrompt(
  grounding: SchemaGrounding,
  target: 'cell' | 'block' | 'answer' = 'cell',
): string {
  if (grounding.tables.length === 0) return '(no schema available)';
  const convention =
    target === 'block'
      ? 'Reference each table by its {{ ref(\'<model>\') }} form (DQL resolves it at execution). Use ONLY these relations and columns.'
      : 'Reference each table by its fully-qualified relation (database.schema.table). Use ONLY these relations and columns; never a bare model name.';

  const lines: string[] = [`Use ONLY these relations and columns. ${convention}`, ''];
  for (const table of grounding.tables) {
    const cols = table.columns
      .slice(0, 30)
      .map((c) => `${c.name}${c.type ? ` ${c.type}` : ''}`)
      .join(', ');
    const ref = table.refForm ? ` | ref: ${table.refForm}` : '';
    const certified = table.certifiedBlock ? ' [certified block]' : '';
    lines.push(`- ${table.qualifiedRelation}${ref}${certified}`);
    lines.push(`  columns: ${cols || '(no columns available)'}`);
  }
  if (grounding.joinKeys.length > 0) {
    lines.push('', 'Join keys:');
    for (const join of grounding.joinKeys.slice(0, 12)) {
      lines.push(`- ${join.leftRelation}.${join.leftColumn} = ${join.rightRelation}.${join.rightColumn} (${join.reason})`);
    }
  }
  return lines.join('\n');
}
