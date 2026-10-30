import { analyzeSqlReferences } from '@zlens/core';
import type {
  LocalContextPack,
  MetadataAgentIntent,
  MetadataAllowedSqlRelation,
  RuntimeSchemaTable,
} from './catalog.js';
import { sourceSqlShapeColumns } from './sql-shape.js';
import { shouldClarifyBeforeGeneration } from '../cascade/triage.js';
import { aggregationIntegrityIssuesForSql } from './grain-ledger.js';
import { internalRelationIdsInSql } from './sql-grounding.js';
import { buildAggregationSafetyProof } from '../aggregation-safety-proof.js';
import { parsePhysicalIdentifier, physicalRelationIdentity } from '../ask-pipeline/physical-binding.js';
import type { AggregationSafetyProofV1 } from '@zlens/core';

export type SqlContextValidationCode =
  | 'unknown_relation'
  | 'unknown_column'
  | 'missing_baseline'
  | 'ambiguous_filter'
  | 'misbound_filter'
  | 'unsafe_aggregation'
  | 'unsafe_sql'
  | 'insufficient_context';

export interface SqlContextValidationOffending {
  relation?: string;
  /**
   * EVERY relation the SQL referenced that the context did not cover.
   *
   * Re-grounding gets one attempt per run, so reporting only the first unknown
   * relation meant a query joining two un-retrieved tables could never recover:
   * the expander resolved one, revalidation failed on the next, and the budget
   * was already spent. The user saw "it uses a table that was not part of the
   * metadata retrieved" for SQL that runs perfectly well in a notebook.
   */
  relations?: string[];
  column?: string;
}

export type SqlContextValidationResult =
  | {
      ok: true;
      aggregationSafetyProof: AggregationSafetyProofV1;
      warnings: string[];
      referencedRelations: string[];
      referencedColumns: Array<{ relation?: string; column: string }>;
    }
  | {
      ok: false;
      aggregationSafetyProof: AggregationSafetyProofV1;
      code: SqlContextValidationCode;
      error: string;
      warnings: string[];
      referencedRelations: string[];
      referencedColumns: Array<{ relation?: string; column: string }>;
      offending?: SqlContextValidationOffending;
    };

export interface SqlContextValidationOptions {
  /** Active warehouse driver/dialect (for example snowflake or databricks). */
  dialect?: string;
  question?: string;
  intent?: MetadataAgentIntent | string;
  filterValues?: string[];
  trustedFilterValues?: string[];
  memberBindings?: Array<{
    dimension: string;
    values: string[];
  }>;
  /** Semantic-compiler SQL owns its aggregation contract; model-authored SQL must pass it here. */
  enforceAggregationIntegrity?: boolean;
  /**
   * Runtime schema shown to the model in the prompt. When supplied, validation
   * uses the union of the metadata context pack and this runtime context so the
   * guard does not reject relations it already asked the model to use.
   */
  runtimeSchema?: RuntimeSchemaTable[];
  /** Require a drafted query to spell an inspected runtime relation exactly. */
  runtimeSchemaExact?: boolean;
  /** Reject a runtime binding observed on a different redacted execution target. */
  executionTargetFingerprint?: string;
  /**
   * Number of positional values the host will bind to `?` placeholders.
   *
   * Relational compilation deliberately keeps literal values out of SQL and
   * supplies them separately.  The SQL reference parser does not understand
   * a bare `?`, so validation replaces only verified, code-position
   * placeholders with a neutral literal for parsing.  The submitted SQL and
   * parameter values remain unchanged.
   */
  positionalParameterCount?: number;
  /**
   * Whether the retrieval-time "clarify before generating" gate still applies.
   *
   * That gate asks a pre-generation question: is the context rich enough to
   * choose a safe table, metric and grain, or should the user be asked first?
   * Once a V2 plan is FROZEN it is the wrong question — the analyst has already
   * chosen among admitted identifiers and the host has authorized them, so the
   * gate can only refuse a query it already approved the parts of. Identifier,
   * relation, column, join and aggregation proofs below are unaffected.
   */
  enforceGenerationReadiness?: boolean;
}

const SQL_ALIAS_STOPWORDS = new Set([
  'asc',
  'desc',
  'from',
  'group',
  'having',
  'limit',
  'order',
  'where',
]);

// The core SQL reference parser deliberately handles a broad range of dialects,
// but some SQL parsers normalize a dotted quoted Snowflake identifier into a
// sequence of quote fragments.  That is not safe for a request-local physical
// binding: `"Db.With.Dot"."Public"."Events"` must remain one exact target.
// Keep this deliberately narrow fallback at the validation boundary. It only
// recognizes relation positions (FROM/JOIN) with at least a schema/table pair;
// bare CTE names remain owned by the parser and never become physical bindings.
const SQL_IDENTIFIER_PART = String.raw`(?:"(?:[^"]|"")*"|\`(?:[^\`]|\`\`)*\`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;
const SQL_PHYSICAL_RELATION = new RegExp(
  String.raw`\b(?:from|join)\s+(${SQL_IDENTIFIER_PART}(?:\s*\.\s*${SQL_IDENTIFIER_PART}){1,2})`,
  'gi',
);

/**
 * Produce parser-only SQL for a positional-parameter candidate.  Question
 * marks inside strings, quoted identifiers and comments are data, not bind
 * markers, so they are deliberately preserved.  This is not SQL rewriting:
 * execution always receives the original statement and its original values.
 */
function sqlForReferenceParsing(sql: string): { sql: string; positionalParameters: number } {
  let out = '';
  let positionalParameters = 0;
  type State = 'code' | 'single' | 'double' | 'backtick' | 'bracket' | 'line_comment' | 'block_comment';
  let state: State = 'code';
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (state === 'code') {
      if (char === "'") { state = 'single'; out += char; continue; }
      if (char === '"') { state = 'double'; out += char; continue; }
      if (char === '`') { state = 'backtick'; out += char; continue; }
      if (char === '[') { state = 'bracket'; out += char; continue; }
      if (char === '-' && next === '-') { state = 'line_comment'; out += char + next; index += 1; continue; }
      if (char === '/' && next === '*') { state = 'block_comment'; out += char + next; index += 1; continue; }
      if (char === '?') { out += 'NULL'; positionalParameters += 1; continue; }
      out += char;
      continue;
    }
    if (state === 'single') {
      out += char;
      if (char === "'" && next === "'") { out += next; index += 1; }
      else if (char === "'") state = 'code';
      continue;
    }
    if (state === 'double') {
      out += char;
      if (char === '"' && next === '"') { out += next; index += 1; }
      else if (char === '"') state = 'code';
      continue;
    }
    if (state === 'backtick') {
      out += char;
      if (char === '`' && next === '`') { out += next; index += 1; }
      else if (char === '`') state = 'code';
      continue;
    }
    if (state === 'bracket') {
      out += char;
      if (char === ']' && next === ']') { out += next; index += 1; }
      else if (char === ']') state = 'code';
      continue;
    }
    if (state === 'line_comment') {
      out += char;
      if (char === '\n') state = 'code';
      continue;
    }
    out += char;
    if (char === '*' && next === '/') { out += next; index += 1; state = 'code'; }
  }
  return { sql: out, positionalParameters };
}

/**
 * Extract schema/table or database/schema/table spellings without losing dots
 * and case inside quoted parts. This supplements, never replaces, the general
 * parser for the exact-target check and emitted receipt references.
 */
function physicalRelationsInSql(sql: string): string[] {
  const byIdentity = new Map<string, string>();
  for (const match of sql.matchAll(SQL_PHYSICAL_RELATION)) {
    const relation = match[1]?.trim();
    if (!relation) continue;
    const parts = parsePhysicalIdentifier(relation);
    if (parts.length < 2 || parts.length > 3) continue;
    const identity = physicalRelationIdentity(relation);
    if (identity) byIdentity.set(identity, relation);
  }
  return [...byIdentity.values()];
}

/**
 * Engines whose table names do not depend on quoting or case: there
 * `"main"."Movie"` and `main.Movie` name one table, so a drafted statement
 * quoting an inspected relation is that relation. Snowflake, PostgreSQL and
 * BigQuery keep quote-sensitive identities.
 */
// `file` is DuckDB reading a folder of data files.
const CASE_INSENSITIVE_RELATION_ENGINES = new Set(['duckdb', 'file', 'sqlite', 'mysql', 'mariadb', 'mssql', 'sqlserver', 'fabric', 'trino', 'athena']);

/**
 * Compare an executed relation to the inspected binding using the active
 * warehouse's identifier rules.  Snowflake keeps quote state in the identity:
 * `DB.PUBLIC.EVENTS` and `"DB"."PUBLIC"."EVENTS"` can be different objects.
 * DuckDB, SQLite and the other engines above treat quoted and unquoted
 * identifiers case-insensitively (DuckDB's compiler renders every physical
 * component in double quotes), so requiring the Snowflake spelling there
 * would reject the very inspected object.  Component count remains part of
 * the identity in both cases, so a two-part alias cannot select a database.
 * The Ask host uses the same rule (one rule with the validator).
 */
export function executionRelationIdentity(relation: string, dialect?: string): string {
  if (!CASE_INSENSITIVE_RELATION_ENGINES.has(dialect?.trim().toLowerCase() ?? '')) return physicalRelationIdentity(relation);
  return parsePhysicalIdentifier(relation)
    .map((part) => `d:${part.value.toLocaleLowerCase('en-US')}`)
    .join('.');
}

/**
 * Engines whose connection opens one database and name tables
 * database.schema.table: an omitted database part can only mean that one.
 * (SQLite is not one: its first name part is an attached database.)
 */
const SINGLE_DATABASE_ENGINES = new Set(['duckdb', 'file']);

/**
 * Whether a relation a statement reads is one this request inspected: the
 * same identity by the warehouse's identifier rule, or (on a single-database
 * engine) the same schema and table with the default database left out.
 * Every check that compares a statement's relations with the inspected ones
 * uses this — the drafted-SQL check here and the Ask host's checks on the
 * drafted and the frozen statement — so they agree.
 */
export function inspectedRelationMatches(relation: string, runtimeSchema: Array<{ relation: string }>, dialect?: string): boolean {
  const identity = executionRelationIdentity(relation, dialect);
  return runtimeSchema.some((table) => executionRelationIdentity(table.relation, dialect) === identity)
    || defaultDatabaseMatch(relation, runtimeSchema, dialect);
}

/**
 * THE DEFAULT DATABASE MAY BE LEFT OUT where a connection holds one database.
 * A certified block written as `main.claim` names the same table ZLens
 * inspected as `acme_insurance.main.claim`, and a drafter shown that block
 * copies its spelling; exact mode refused it. On DuckDB a shorter name is
 * accepted when every inspected relation lives in one database and exactly
 * one of them has that schema and table. A bare table name, any other
 * engine (Snowflake, BigQuery, … span databases; SQLite's first part is an
 * attached database) and an ambiguous schema and table stay exact.
 */
function defaultDatabaseMatch(relation: string, runtimeSchema: Array<{ relation: string }>, dialect?: string): boolean {
  if (!SINGLE_DATABASE_ENGINES.has(dialect?.trim().toLowerCase() ?? '')) return false;
  try {
    const lower = (parts: Array<{ value: string }>) => parts.map((part) => part.value.toLocaleLowerCase('en-US'));
    const referenced = lower(parsePhysicalIdentifier(relation));
    // schema.table only: a bare table name resolves through the search path,
    // which need not be the inspected schema, so it stays exact.
    if (referenced.length !== 2) return false;
    const inspected = runtimeSchema.map((table) => lower(parsePhysicalIdentifier(table.relation))).filter((parts) => parts.length >= referenced.length);
    const databases = new Set(inspected.filter((parts) => parts.length === 3).map((parts) => parts[0]));
    if (databases.size > 1) return false;
    const tail = referenced.join('.');
    return inspected.filter((parts) => parts.slice(parts.length - referenced.length).join('.') === tail).length === 1;
  } catch {
    return false;
  }
}

export function validateSqlAgainstLocalContext(
  sql: string,
  contextPack: LocalContextPack | undefined,
  options: SqlContextValidationOptions = {},
): SqlContextValidationResult {
  const aggregationSafetyProof = buildAggregationSafetyProof(sql, contextPack, options.dialect);
  const internalRelationIds = internalRelationIdsInSql(sql);
  if (internalRelationIds.length > 0) {
    return {
      ok: false,
      code: 'unknown_relation',
      error: `Generated SQL contains internal DQL graph relation identifier(s): ${internalRelationIds.join(', ')}. These identifiers are only for retrieval and lineage; use the inspected physical database.schema.table relation instead.`,
      warnings: [],
      referencedRelations: [],
      referencedColumns: [],
      aggregationSafetyProof,
      offending: {
        relation: internalRelationIds[0],
        relations: internalRelationIds,
      },
    };
  }
  const parserSql = sqlForReferenceParsing(sql);
  const quotedPhysicalRelations = physicalRelationsInSql(sql);
  if (options.positionalParameterCount !== undefined && parserSql.positionalParameters !== options.positionalParameterCount) {
    return {
      ok: false,
      code: 'unsafe_sql',
      error: `SQL has ${parserSql.positionalParameters} positional placeholder${parserSql.positionalParameters === 1 ? '' : 's'}, but the prepared candidate carries ${options.positionalParameterCount} bound value${options.positionalParameterCount === 1 ? '' : 's'}.`,
      warnings: [],
      referencedRelations: quotedPhysicalRelations,
      referencedColumns: [],
      aggregationSafetyProof,
    };
  }
  const analysis = analyzeSqlReferences(parserSql.sql, options.dialect);
  // Prefer the quote-aware relation spelling where it is available. The core
  // parser remains the source for aliases, columns and CTE scopes.
  const referencedRelations = quotedPhysicalRelations.length > 0 ? quotedPhysicalRelations : analysis.tables;
  const referencedColumns = analysis.columns.map((column) => ({
    relation: column.relation,
    column: column.column,
  }));
  const outputAliases = extractSelectAliases(sql);
  const base = {
    warnings: [] as string[],
    referencedRelations,
    referencedColumns,
    aggregationSafetyProof,
  };

  if (!analysis.parsed) {
    return {
      ok: false,
      code: 'insufficient_context',
      error: `SQL could not be parsed for context validation: ${analysis.error ?? 'unknown parse error'}`,
      ...base,
    };
  }

  const unsafeType = analysis.statementTypes.find((type) => type !== 'select');
  if (unsafeType) {
    return {
      ok: false,
      code: 'unsafe_sql',
      error: `Tier-2 metadata SQL only supports read-only SELECT or WITH queries; parser found ${unsafeType.toUpperCase()}.`,
      ...base,
    };
  }

  // A DATA answer must read at least one relation. A constant-only / tableless
  // SELECT (`SELECT NULL`, `SELECT 1`) references no relation and cannot answer a
  // data question — the model is dodging a hard ask with a grounded-looking
  // non-answer. Reject so the loop repairs or refuses honestly. (Runs before the
  // advisory early-returns below so it holds even with no context pack.)
  if (referencedRelations.length === 0) {
    return {
      ok: false,
      code: 'insufficient_context',
      error: 'The generated SQL does not read any relation (constant-only/tableless SELECT), so it cannot answer a data question. Query an inspected relation.',
      ...base,
    };
  }

  const allowed = buildAllowedRelationLookup(contextPack, options.runtimeSchema, options.dialect);
  const aggregationIssues = options.enforceAggregationIntegrity === false
    ? []
    : aggregationIntegrityIssuesForSql(sql, contextPack?.objects ?? [], options.dialect);

  if (options.executionTargetFingerprint) {
    const targetMismatch = (options.runtimeSchema ?? []).find((table) => table.executionTargetFingerprint && table.executionTargetFingerprint !== options.executionTargetFingerprint);
    if (targetMismatch) {
      return {
        ok: false,
        code: 'insufficient_context',
        error: `Runtime metadata for ${targetMismatch.relation} belongs to a different execution target. Refresh the inspected binding before drafting SQL.`,
        ...base,
      };
    }
  }
  if (options.runtimeSchemaExact) {
    const exact = new Set((options.runtimeSchema ?? []).map((table) => executionRelationIdentity(table.relation, options.dialect)));
    // Exact mode is deliberately stricter than the general context lookup.
    // `buildAllowedRelationLookup()` retains convenient shortened aliases for
    // legacy stored refs, but a generated/executed statement must not select a
    // database through one of them. In particular, DB.PUBLIC.EVENTS is not an
    // inspected "Db"."Public"."Events" merely because the parser can
    // normalize either spelling or their schema/table tail happens to match.
    const mismatch = referencedRelations.find((relation) => !exact.has(executionRelationIdentity(relation, options.dialect)) && !inspectedRelationMatches(relation, options.runtimeSchema ?? [], options.dialect));
    if (mismatch) {
      const expected = (options.runtimeSchema ?? []).map((table) => table.relation).join(', ');
      return {
        ok: false,
        code: 'unknown_relation',
        error: `SQL references ${mismatch}, but this request inspected ${expected}. Use the exact bound physical relation, including database and quoting.`,
        offending: { relation: mismatch, relations: [mismatch] },
        ...base,
      };
    }
  }

  if (!contextPack && allowed.size === 0) {
    return aggregationIssues.length > 0
      ? aggregationIntegrityFailure(aggregationIssues, base.warnings, referencedRelations, referencedColumns, aggregationSafetyProof)
      : { ok: true, ...base };
  }
  if (options.enforceGenerationReadiness !== false
    && contextPack?.routeDecision?.route === 'clarify' && shouldClarifyBeforeGeneration({
    intent: contextPack.routeDecision.intent,
    routeDecision: contextPack.routeDecision,
    schemaContextCount: options.runtimeSchema?.length ?? 0,
    allowedRelationCount: allowed.size,
    sourceBlockSqlCount: contextPack.allowedSqlContext.sourceBlockSql.length,
    metadataObjectCount: contextPack.objects.length,
  })) {
    const missing = contextPack.missingContext.map((item) => item.message).join(' ');
    // Embed the four gate counts so an INTERMITTENT refusal self-diagnoses
    // from the message alone: schema=0 with relations=0 points at a failed
    // runtime scan / rebuild race, not at the user's question.
    const gateCounts = `[context counts: relations=${allowed.size}, runtimeSchema=${options.runtimeSchema?.length ?? 0}, sourceSql=${contextPack.allowedSqlContext.sourceBlockSql.length}, objects=${contextPack.objects.length}]`;
    return {
      ok: false,
      code: 'insufficient_context',
      error: `Metadata context is insufficient for SQL generation. ${missing || contextPack.routeDecision.reason} ${gateCounts}`,
      ...base,
    };
  }

  if (!contextPack?.allowedSqlContext && allowed.size === 0) {
    if (aggregationIssues.length > 0) {
      return aggregationIntegrityFailure(aggregationIssues, base.warnings, referencedRelations, referencedColumns, aggregationSafetyProof);
    }
    return {
      ok: true,
      ...base,
      warnings: ['No allowed SQL context was available in the context pack, so relation and column validation were advisory only.'],
    };
  }

  if (allowed.size === 0) {
    if (aggregationIssues.length > 0) {
      return aggregationIntegrityFailure(aggregationIssues, base.warnings, referencedRelations, referencedColumns, aggregationSafetyProof);
    }
    return {
      ok: true,
      ...base,
      warnings: ['No allowed SQL relations were available in the context pack, so relation and column validation were advisory only.'],
    };
  }

  const unresolvedPhysicalRelations = quotedPhysicalRelations.filter((relation) =>
    !relationLookupKeys(relation).some((key) => allowed.has(key)));
  if (unresolvedPhysicalRelations.length > 0) {
    return {
      ok: false,
      code: 'unknown_relation',
      error: `SQL references relation(s) outside the inspected metadata context: ${unresolvedPhysicalRelations.join(', ')}. Use inspect_metadata_context and only query allowed relations.`,
      offending: { relation: unresolvedPhysicalRelations[0], relations: unresolvedPhysicalRelations },
      ...base,
    };
  }

  const finding = checkSqlReferences({
    analysis,
    allowed,
    outputAliases,
    usingColumns: usingJoinColumns(sql),
    // The exact physical walk above validates relation admission. Avoid
    // allowing a parser-normalized quoted relation to overwrite that result.
    ...(quotedPhysicalRelations.length > 0 ? { relationsResolved: true } : {}),
  });
  if (finding?.kind === 'unknown_relation') {
    const unknownRelations = finding.relations;
    return {
      ok: false,
      code: 'unknown_relation',
      error: `SQL references relation(s) outside the inspected metadata context: ${unknownRelations.join(', ')}. Use inspect_metadata_context and only query allowed relations.`,
      offending: { relation: unknownRelations[0], relations: unknownRelations },
      ...base,
    };
  }

  const warnings: string[] = [];
  for (const relation of referencedRelations) {
    const allowedRelation = findAllowedRelation(allowed, relation);
    if (allowedRelation && allowedRelation.columns.length === 0) {
      warnings.push(`Column validation was advisory for ${relation} because the context pack did not include column metadata.`);
    }
  }

  const unknownColumn = finding?.kind === 'unknown_column' ? finding : undefined;
  if (unknownColumn) {
    return {
      ok: false,
      code: 'unknown_column',
      error: unknownColumn.relation
        ? `SQL references column "${unknownColumn.column}" outside the inspected columns for ${unknownColumn.relation}.`
        : `SQL references column "${unknownColumn.column}" outside the inspected metadata context.`,
      warnings,
      referencedRelations,
      referencedColumns,
      offending: {
        relation: unknownColumn.relation,
        column: unknownColumn.column,
      },
      aggregationSafetyProof,
    };
  }
  // A partial list is sufficient when every referenced column is present. Only
  // surface the advisory when the query uses a column the partial evidence
  // cannot prove; this keeps certified source shapes quiet while still avoiding
  // a false hard rejection for wide/truncated enterprise tables.
  const advisoryUnknownColumn = findUnknownColumn(analysis.columns, allowed, outputAliases, true);
  if (advisoryUnknownColumn) {
    const relation = advisoryUnknownColumn.relation ?? referencedRelations[0];
    warnings.push(`Column validation was advisory${relation ? ` for ${relation}` : ''} because the inspected column list is partial.`);
  }

  // AGT-015 / E2E-014: validate ambiguity inside every SELECT/CTE scope before
  // the warehouse binder sees it. Scope-local aliases prevent false positives
  // between an inner CTE and its outer consumer.
  // A CTE that shares a name with a real relation must never be treated as that
  // relation's owner — `WITH orders AS (...) ... FROM orders o JOIN dw.customers`
  // would otherwise report a phantom conflict now that partial relations count.
  const ambiguousColumn = finding?.kind === 'ambiguous_column' ? finding : undefined;
  if (ambiguousColumn) {
    return {
      ok: false,
      code: 'unknown_column',
      error: `SQL references unqualified column "${ambiguousColumn.column}", which exists on multiple joined relations: ${ambiguousColumn.owners.join(', ')}. Qualify it with the intended relation alias.`,
      warnings,
      referencedRelations,
      referencedColumns,
      offending: { column: ambiguousColumn.column },
      aggregationSafetyProof,
    };
  }

  if (aggregationIssues.length > 0) {
    return aggregationIntegrityFailure(aggregationIssues, warnings, referencedRelations, referencedColumns, aggregationSafetyProof);
  }

  if (options.intent === 'diagnose_change' && !contextHasTimeLikeColumn(allowed)) {
    return {
      ok: false,
      code: 'missing_baseline',
      error: 'Change-diagnosis SQL needs a comparable time or baseline column in the inspected context.',
      warnings,
      referencedRelations,
      referencedColumns,
      aggregationSafetyProof,
    };
  }

  const ambiguousEntityFilter = options.intent === 'entity_drilldown' && contextPack
    ? findAmbiguousEntityFilter(sql, analysis.aliasToRelation, contextPack, options)
    : undefined;
  if (ambiguousEntityFilter) {
    return {
      ok: false,
      code: 'ambiguous_filter',
      error: ambiguousEntityFilter,
      warnings,
      referencedRelations,
      referencedColumns,
      aggregationSafetyProof,
    };
  }

  const misboundMemberFilter = findMisboundMemberFilter(sql, analysis.aliasToRelation, options.memberBindings ?? []);
  if (misboundMemberFilter) {
    return {
      ok: false,
      code: 'misbound_filter',
      error: misboundMemberFilter.message,
      warnings,
      referencedRelations,
      referencedColumns,
      offending: { relation: misboundMemberFilter.relation, column: misboundMemberFilter.column },
      aggregationSafetyProof,
    };
  }

  return {
    ok: true,
    warnings,
    referencedRelations,
    referencedColumns,
    aggregationSafetyProof,
  };
}

function aggregationIntegrityFailure(
  issues: ReturnType<typeof aggregationIntegrityIssuesForSql>,
  warnings: string[],
  referencedRelations: string[],
  referencedColumns: Array<{ relation?: string; column: string }>,
  aggregationSafetyProof?: AggregationSafetyProofV1,
): SqlContextValidationResult {
  return {
    ok: false,
    code: 'unsafe_aggregation',
    error: `Generated SQL changes the amount/metric aggregation contract: ${issues.map((issue) => issue.message).join(' ')}`,
    warnings,
    referencedRelations,
    referencedColumns,
    aggregationSafetyProof: aggregationSafetyProof ?? buildAggregationSafetyProof('', undefined),
  };
}

function buildAllowedRelationLookup(
  contextPack: LocalContextPack | undefined,
  runtimeSchema: RuntimeSchemaTable[] = [],
  dialect?: string,
): Map<string, MetadataAllowedSqlRelation> {
  const allowed = new Map<string, MetadataAllowedSqlRelation>();
  const putAllowed = (entry: MetadataAllowedSqlRelation, authoritativeColumns = false) => {
    for (const key of relationLookupKeys(entry.relation)) {
      allowed.set(key, authoritativeColumns
        ? mergeAuthoritativeAllowedRelation(allowed.get(key), entry)
        : mergeAllowedRelation(allowed.get(key), entry));
    }
    for (const key of relationLookupKeys(entry.name)) {
      allowed.set(key, authoritativeColumns
        ? mergeAuthoritativeAllowedRelation(allowed.get(key), entry)
        : mergeAllowedRelation(allowed.get(key), entry));
    }
  };
  for (const relation of contextPack?.allowedSqlContext?.relations ?? []) {
    putAllowed(relation);
  }
  for (const source of contextPack?.allowedSqlContext?.sourceBlockSql ?? []) {
    const analysis = analyzeSqlReferences(source.sql, dialect);
    for (const relation of analysis.tables) {
      putAllowed({
        relation,
        name: relation.split('.').at(-1) ?? relation,
        objectKey: source.objectKey,
        source: 'certified source block SQL',
        columnCompleteness: 'partial',
        columns: mergeAllowedColumns(
          sourceSqlShapeColumns(source.sql),
          sourceSqlReferencedColumns(analysis, relation),
        ),
      });
    }
  }
  for (const table of runtimeSchema) {
    // Runtime callers historically provided complete inspected schemas without
    // a marker, so absence still means complete. Only relations explicitly
    // tagged partial (including context-pack cards projected into schemaContext)
    // remain advisory and merge with certified source SQL instead of erasing it.
    const authoritativeColumns = table.columnCompleteness !== 'partial';
    putAllowed({
      relation: table.relation,
      name: table.name ?? table.relation.split('.').at(-1) ?? table.relation,
      source: table.source ?? 'runtime schema context',
      columnCompleteness: authoritativeColumns ? 'complete' : 'partial',
      columns: table.columns,
    }, authoritativeColumns);
  }
  return allowed;
}

/**
 * A complete runtime lookup owns executable column names for this request.
 * Preserve semantic descriptions and samples only for names that still exist;
 * never union stale catalog declarations back into the physical target schema.
 */
function mergeAuthoritativeAllowedRelation(
  existing: MetadataAllowedSqlRelation | undefined,
  incoming: MetadataAllowedSqlRelation,
): MetadataAllowedSqlRelation {
  if (!existing) return incoming;
  const existingColumns = new Map(existing.columns.map((column) => [column.name.toLowerCase(), column] as const));
  return {
    ...incoming,
    objectKey: incoming.objectKey ?? existing.objectKey,
    columnCompleteness: 'complete',
    columns: incoming.columns.map((column) => {
      const metadata = existingColumns.get(column.name.toLowerCase());
      return {
        ...column,
        type: column.type ?? metadata?.type,
        description: column.description ?? metadata?.description,
        sampleValues: Array.from(new Set([...(column.sampleValues ?? []), ...(metadata?.sampleValues ?? [])])).slice(0, 8),
      };
    }),
  };
}

function sourceSqlReferencedColumns(
  analysis: ReturnType<typeof analyzeSqlReferences>,
  relation: string,
): MetadataAllowedSqlRelation['columns'] {
  const relationCount = analysis.tables.length;
  const columns: MetadataAllowedSqlRelation['columns'] = [];
  const seen = new Set<string>();
  for (const column of analysis.columns) {
    const name = cleanIdentifier(column.column);
    if (!name || name === '*') continue;
    if (relationCount > 1 && column.relation && !relationLookupKeys(column.relation).some((key) => relationLookupKeys(relation).includes(key))) {
      continue;
    }
    if (relationCount > 1 && !column.relation) continue;
    const key = normalizeColumnName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    columns.push({
      name,
      description: 'Referenced by certified source SQL.',
    });
  }
  return columns;
}

function mergeAllowedRelation(
  existing: MetadataAllowedSqlRelation | undefined,
  incoming: MetadataAllowedSqlRelation,
): MetadataAllowedSqlRelation {
  if (!existing) return incoming;
  return {
    ...existing,
    objectKey: existing.objectKey ?? incoming.objectKey,
    source: existing.source === incoming.source ? existing.source : 'inspected metadata and certified source SQL',
    columnCompleteness: mergeRelationCompleteness(existing, incoming),
    columns: mergeAllowedColumns(existing.columns, incoming.columns),
  };
}

function mergeRelationCompleteness(
  existing: MetadataAllowedSqlRelation,
  incoming: MetadataAllowedSqlRelation,
): MetadataAllowedSqlRelation['columnCompleteness'] {
  if (relationColumnCompleteness(existing) === 'complete' || relationColumnCompleteness(incoming) === 'complete') {
    return 'complete';
  }
  return 'partial';
}

function mergeAllowedColumns(
  left: MetadataAllowedSqlRelation['columns'],
  right: MetadataAllowedSqlRelation['columns'],
): MetadataAllowedSqlRelation['columns'] {
  const byName = new Map<string, MetadataAllowedSqlRelation['columns'][number]>();
  for (const column of [...left, ...right]) {
    const key = column.name.toLowerCase();
    const existing = byName.get(key);
    byName.set(key, existing
      ? {
          ...existing,
          type: existing.type ?? column.type,
          description: existing.description ?? column.description,
          sampleValues: Array.from(new Set([...(existing.sampleValues ?? []), ...(column.sampleValues ?? [])])).slice(0, 8),
        }
      : column);
  }
  return Array.from(byName.values());
}

function findAllowedRelation(
  allowed: Map<string, MetadataAllowedSqlRelation>,
  relation: string,
): MetadataAllowedSqlRelation | undefined {
  let partialMatch: MetadataAllowedSqlRelation | undefined;
  for (const key of relationLookupKeys(relation)) {
    const match = allowed.get(key);
    if (!match) continue;
    if (relationColumnCompleteness(match) === 'complete') return match;
    partialMatch ??= match;
  }
  return partialMatch;
}

function findUnknownColumn(
  columns: Array<{ column: string; relation?: string; unqualified: boolean }>,
  allowed: Map<string, MetadataAllowedSqlRelation>,
  outputAliases: Set<string>,
  includePartial = false,
): { column: string; relation?: string } | undefined {
  for (const column of columns) {
    if (column.column === '*') continue;
    if (column.unqualified && outputAliases.has(normalizeColumnName(column.column))) continue;
    if (column.relation) {
      const relation = findAllowedRelation(allowed, column.relation);
      if (!relation || relation.columns.length === 0) continue;
      if (!includePartial && relationColumnCompleteness(relation) === 'partial') continue;
      if (!relation.columns.some((allowedColumn) => namesEqual(allowedColumn.name, column.column))) {
        return { column: column.column, relation: relation.relation };
      }
      continue;
    }

    const relationsWithColumns = uniqueAllowedRelations(allowed)
      .filter((relation) => relation.columns.length > 0 && (includePartial || relationColumnCompleteness(relation) === 'complete'));
    if (relationsWithColumns.length === 0) continue;
    if (!relationsWithColumns.some((relation) => relation.columns.some((allowedColumn) => namesEqual(allowedColumn.name, column.column)))) {
      return { column: column.column };
    }
  }
  return undefined;
}

function findAmbiguousUnqualifiedColumn(
  columns: Array<{ column: string; relation?: string; unqualified: boolean; outputAliasReference?: boolean }>,
  aliasToRelation: Record<string, string>,
  allowed: Map<string, MetadataAllowedSqlRelation>,
  cteNames?: Set<string>,
): { column: string; owners: string[] } | undefined {
  for (const column of columns) {
    if (!column.unqualified || column.outputAliasReference || column.column === '*') continue;
    const owners = Object.entries(aliasToRelation)
      // Ambiguity does NOT need complete column knowledge. Truncation can hide a
      // column, never invent one — so two relations that BOTH list the name are
      // genuinely ambiguous whether or not their column lists were capped. This
      // conjunct used to require `complete`, which meant every relation wider
      // than MAX_ALLOWED_SQL_COLUMNS (the enterprise fact tables that carry
      // report_as_of_date) was silently excluded and the guard never fired.
      // Completeness stays load-bearing for findUnknownColumn, where a missing
      // column really is unprovable.
      .filter(([alias, relationName]) => {
        if (cteNames && (relationLookupKeys(relationName).some((key) => cteNames.has(key)) || cteNames.has(alias.toLowerCase()))) return false;
        const relation = findAllowedRelation(allowed, relationName);
        return Boolean(
          relation
          && relation.columns.length > 0
          && relation.columns.some((candidate) => namesEqual(candidate.name, column.column)),
        );
      })
      .map(([alias, relationName]) => `${alias} (${relationName})`)
      .filter((owner, index, values) => values.indexOf(owner) === index);
    if (owners.length > 1) return { column: column.column, owners };
  }
  return undefined;
}

/**
 * THE check of a parsed statement's references against an allowed relation
 * set. The metadata-context validator and the grounding validator used to
 * carry their own copies of the relation/column/ambiguity walk with drifting
 * rules; both now call this and only phrase the finding in their own words.
 */
export type SqlReferenceFinding =
  | { kind: 'unknown_relation'; relations: string[] }
  | { kind: 'unknown_column'; column: string; relation?: string }
  | { kind: 'ambiguous_column'; column: string; owners: string[] };

export function checkSqlReferences(input: {
  analysis: Pick<ReturnType<typeof analyzeSqlReferences>, 'tables' | 'columns' | 'scopes' | 'ctes'>;
  allowed: Map<string, MetadataAllowedSqlRelation>;
  outputAliases: Set<string>;
  /** Skip the relation walk (the caller resolved relations its own way). */
  relationsResolved?: boolean;
  /** Columns merged by `USING (…)` joins: never ambiguous when unqualified. */
  usingColumns?: Set<string>;
}): SqlReferenceFinding | undefined {
  const { analysis, allowed, outputAliases } = input;
  if (!input.relationsResolved) {
    const unknownRelations = analysis.tables.filter((relation) =>
      !relationLookupKeys(relation).some((key) => allowed.has(key)));
    if (unknownRelations.length > 0) return { kind: 'unknown_relation', relations: unknownRelations };
  }
  const unknownColumn = findUnknownColumn(analysis.columns, allowed, outputAliases);
  if (unknownColumn) return { kind: 'unknown_column', ...unknownColumn };
  const merged = input.usingColumns;
  const ambiguousColumn = findScopeAwareAmbiguousColumn(
    (analysis.scopes ?? []).map((scope) => merged?.size
      ? { ...scope, columns: scope.columns.filter((column) => !(column.unqualified && merged.has(normalizeColumnName(column.column)))) }
      : scope),
    allowed,
    new Set((analysis.ctes ?? []).flatMap(relationLookupKeys)),
  );
  if (ambiguousColumn) return { kind: 'ambiguous_column', ...ambiguousColumn };
  return undefined;
}

/** An allowed-relation lookup from plain relation records (live-probed columns are complete). */
export function allowedRelationLookupFromTables(
  tables: ReadonlyArray<{ relation: string; name?: string; columns: ReadonlyArray<{ name: string; type?: string }>; source?: string }>,
): Map<string, MetadataAllowedSqlRelation> {
  const allowed = new Map<string, MetadataAllowedSqlRelation>();
  for (const table of tables) {
    const entry: MetadataAllowedSqlRelation = {
      relation: table.relation,
      name: table.name ?? table.relation.split('.').at(-1) ?? table.relation,
      source: table.source ?? 'grounded schema',
      columnCompleteness: 'complete',
      columns: table.columns.map((column) => ({ name: column.name, ...(column.type ? { type: column.type } : {}) })),
    };
    for (const key of relationLookupKeys(table.relation)) allowed.set(key, entry);
    if (table.name) for (const key of relationLookupKeys(table.name)) if (!allowed.has(key)) allowed.set(key, entry);
  }
  return allowed;
}

function findScopeAwareAmbiguousColumn(
  scopes: Array<{
    columns: Array<{ column: string; relation?: string; unqualified: boolean; outputAliasReference?: boolean }>;
    aliasToRelation: Record<string, string>;
    outputAliases: string[];
  }>,
  allowed: Map<string, MetadataAllowedSqlRelation>,
  cteNames?: Set<string>,
): { column: string; owners: string[] } | undefined {
  if (scopes.length === 0) return undefined;
  for (const scope of scopes) {
    const ambiguous = findAmbiguousUnqualifiedColumn(
      scope.columns,
      scope.aliasToRelation,
      allowed,
      cteNames,
    );
    if (ambiguous) return ambiguous;
  }
  return undefined;
}

function relationColumnCompleteness(relation: MetadataAllowedSqlRelation): 'complete' | 'partial' {
  if (relation.columnCompleteness) return relation.columnCompleteness;
  return relation.columns.length === 0 ? 'partial' : 'complete';
}

/**
 * The select list of every SELECT: from the keyword to the FROM at the same
 * parenthesis depth. A lazy `SELECT … FROM` match stops at the first FROM it
 * meets, which is inside the subquery of `CASE WHEN EXISTS (SELECT 1 FROM …)
 * … END AS category`, so the alias the statement defines was never seen.
 */
function selectLists(sql: string): string[] {
  const text = sql.replace(/--[^\n]*/g, ' ');
  const lists: string[] = [];
  for (const match of text.matchAll(/\bselect\b/gi)) {
    let depth = 0;
    const start = match.index! + match[0].length;
    let index = start;
    for (; index < text.length; index += 1) {
      const char = text[index]!;
      if (char === '(') depth += 1;
      else if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === "'") {
        const close = text.indexOf("'", index + 1);
        if (close < 0) break;
        index = close;
      } else if (depth === 0 && /\bfrom\b/iy.test(text.slice(index, index + 5)) && /[^\w$]/.test(text[index - 1] ?? ' ')) break;
    }
    lists.push(text.slice(start, index));
  }
  return lists;
}

/**
 * Every name the statement itself defines, which is therefore never "outside
 * the inspected metadata": the aliases of every select list (a CTE's outputs
 * are read unqualified by the query after it) and the columns a CTE declares
 * in its own list (`WITH RECURSIVE tree(root_id, node_id) AS (…)`).
 */
export function extractSelectAliases(sql: string): Set<string> {
  const aliases = new Set<string>();
  for (const list of selectLists(sql)) {
    for (const item of splitTopLevelSelectItems(list)) {
      const alias = selectItemAlias(item);
      if (alias) {
        aliases.add(normalizeColumnName(alias));
      }
    }
  }
  for (const match of sql.matchAll(/(?:\bwith\b(?:\s+recursive\b)?|,)\s*(?:"[^"]+"|[A-Za-z_][\w$]*)\s*\(([^()]*)\)\s*as\s*\(/gi)) {
    for (const name of match[1]!.split(',')) {
      const column = cleanIdentifier(name.trim());
      if (column) aliases.add(normalizeColumnName(column));
    }
  }
  return aliases;
}

/**
 * Columns named in a `JOIN … USING (a, b)`: the join merges each into one
 * column, so an unqualified reference to it is not ambiguous between the two
 * tables that both carry it.
 */
export function usingJoinColumns(sql: string): Set<string> {
  const names = new Set<string>();
  for (const match of sql.matchAll(/\busing\s*\(([^()]*)\)/gi)) {
    for (const name of match[1]!.split(',')) {
      const column = cleanIdentifier(name.trim());
      if (column) names.add(normalizeColumnName(column));
    }
  }
  return names;
}

function splitTopLevelSelectItems(section: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  for (let index = 0; index < section.length; index += 1) {
    const char = section[index]!;
    const next = section[index + 1];
    if (quote) {
      current += char;
      if (char === quote) {
        if (quote === "'" && next === "'") {
          current += next;
          index += 1;
          continue;
        }
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function selectItemAlias(item: string): string | undefined {
  const asMatch = /\bAS\s+((?:"[^"]+")|(?:`[^`]+`)|(?:[A-Za-z_][\w$]*))\s*$/i.exec(item);
  if (asMatch?.[1]) return cleanIdentifier(asMatch[1]);

  const implicit = /(?:\bEND|\)|\])\s+((?:"[^"]+")|(?:`[^`]+`)|(?:[A-Za-z_][\w$]*))\s*$/i.exec(item);
  if (!implicit?.[1]) return undefined;
  const alias = cleanIdentifier(implicit[1]);
  if (!alias || SQL_ALIAS_STOPWORDS.has(alias.toLowerCase())) return undefined;
  return alias;
}

function uniqueAllowedRelations(allowed: Map<string, MetadataAllowedSqlRelation>): MetadataAllowedSqlRelation[] {
  return Array.from(new Set(Array.from(allowed.values())));
}

function relationLookupKeys(relation: string): string[] {
  const normalized = normalizeRelation(relation).toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>();
  if (normalized) keys.add(normalized);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  if (parts.length >= 1) keys.add(parts[parts.length - 1]!);
  return Array.from(keys);
}

function normalizeRelation(value: string): string {
  return value
    .replace(/["`]/g, '')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function namesEqual(a: string, b: string): boolean {
  return a.replace(/["`]/g, '').toLowerCase() === b.replace(/["`]/g, '').toLowerCase();
}

function normalizeColumnName(value: string): string {
  return value.replace(/["`]/g, '').toLowerCase();
}

function contextHasTimeLikeColumn(allowed: Map<string, MetadataAllowedSqlRelation>): boolean {
  return uniqueAllowedRelations(allowed).some((relation) =>
    relation.columns.some((column) => isTimeLikeColumn(column.name)),
  );
}

function isTimeLikeColumn(name: string): boolean {
  return /\b(date|time|day|week|month|quarter|year|season|period|created_at|updated_at)\b/i.test(name);
}

interface SampleValueColumnMatch {
  relation: string;
  column: string;
}

interface EntityValuePredicate {
  relation?: string;
  column: string;
  value: string;
  /** True for LIKE/ILIKE-derived predicates (wildcards stripped) — matched by containment, not equality. */
  fuzzy?: boolean;
}

function findAmbiguousEntityFilter(
  sql: string,
  aliasToRelation: Record<string, string>,
  contextPack: LocalContextPack,
  options: SqlContextValidationOptions,
): string | undefined {
  const question = options.question ?? '';
  const explicitValues = uniqueStrings([
    ...(options.filterValues ?? []),
    ...Array.from(question.matchAll(/"([^"]+)"|'([^']+)'/g))
      .map((match) => match[1] ?? match[2])
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...Array.from(question.matchAll(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g)).map((match) => match[0]),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !isTemporalEntityFilter(value)));

  if (explicitValues.length === 0) return undefined;
  const trustedValues = new Set((options.trustedFilterValues ?? []).map(normalizeSampleValue).filter(Boolean));
  const sampleMatches = sampleValueColumnMatches(contextPack);
  if (sampleMatches.size === 0) return undefined;
  const predicates = extractEntityValuePredicates(sql, aliasToRelation);

  for (const value of explicitValues) {
    const valueKey = normalizeSampleValue(value);
    const matchedColumns = sampleMatches.get(valueKey) ?? [];
    const valuePredicates = predicates.filter((predicate) => normalizeSampleValue(predicate.value) === valueKey);
    if (matchedColumns.length === 0) {
      if (trustedValues.has(valueKey) && valuePredicates.length > 0) continue;
      return `Entity drilldown SQL needs an inspected value match for "${value}" before it can apply that filter.`;
    }

    if (valuePredicates.length === 0) {
      return `Entity drilldown SQL does not apply the requested inspected entity filter "${value}".`;
    }

    if (!valuePredicates.some((predicate) => predicateMatchesSampleColumn(predicate, matchedColumns))) {
      const expected = matchedColumns
        .map((match) => `${match.relation}.${match.column}`)
        .sort()
        .join(', ');
      const actual = valuePredicates
        .map((predicate) => `${predicate.relation ? `${predicate.relation}.` : ''}${predicate.column}`)
        .sort()
        .join(', ');
      return `Entity drilldown SQL filters "${value}" on ${actual}, but inspected metadata matched that value on ${expected}.`;
    }
  }

  return undefined;
}

function sampleValueColumnMatches(contextPack: LocalContextPack): Map<string, SampleValueColumnMatch[]> {
  const matches = new Map<string, SampleValueColumnMatch[]>();
  for (const relation of contextPack.allowedSqlContext.relations) {
    for (const column of relation.columns) {
      for (const sampleValue of column.sampleValues ?? []) {
        const key = normalizeSampleValue(sampleValue);
        if (!key) continue;
        const existing = matches.get(key) ?? [];
        existing.push({ relation: relation.relation, column: column.name });
        matches.set(key, existing);
      }
    }
  }
  return matches;
}

function extractEntityValuePredicates(sql: string, aliasToRelation: Record<string, string>): EntityValuePredicate[] {
  const predicates: EntityValuePredicate[] = [];
  // Models commonly normalize text comparisons with LOWER/UPPER. Capture the
  // wrapped column as the predicate owner so member-binding validation applies
  // identically to normalized and direct equality filters.
  const normalizedEqualityPattern = /(?:LOWER|UPPER)\s*\(\s*(?:(["]?[\w]+["]?)\s*\.\s*)?(["]?[\w]+["]?)\s*\)\s*=\s*(?:LOWER|UPPER)\s*\(\s*('(?:''|[^'])*'|"(?:\\"|[^"])*")\s*\)/gi;
  for (const match of sql.matchAll(normalizedEqualityPattern)) {
    predicates.push({
      relation: resolvePredicateRelation(match[1], aliasToRelation),
      column: cleanIdentifier(match[2] ?? ''),
      value: unquoteSqlLiteral(match[3] ?? ''),
    });
  }

  const equalityPattern = /(?:(["`]?[\w]+["`]?)\s*\.\s*)?(["`]?[\w]+["`]?)\s*=\s*('(?:''|[^'])*'|"(?:\\"|[^"])*")/gi;
  for (const match of sql.matchAll(equalityPattern)) {
    predicates.push({
      relation: resolvePredicateRelation(match[1], aliasToRelation),
      column: cleanIdentifier(match[2] ?? ''),
      value: unquoteSqlLiteral(match[3] ?? ''),
    });
  }

  const inPattern = /(?:(["`]?[\w]+["`]?)\s*\.\s*)?(["`]?[\w]+["`]?)\s+IN\s*\(([^)]*)\)/gi;
  for (const match of sql.matchAll(inPattern)) {
    const relation = resolvePredicateRelation(match[1], aliasToRelation);
    const column = cleanIdentifier(match[2] ?? '');
    for (const value of stringLiteralsInList(match[3] ?? '')) {
      predicates.push({ relation, column, value });
    }
  }

  // Models frequently express a typed member as a pattern filter
  // (customer_name ILIKE '%Capital One%'). That still APPLIES the binding —
  // capture it (wildcards stripped) so binding validation doesn't refuse a
  // semantically correct query. NOT LIKE is deliberately excluded.
  const likePattern = /(?:(?:LOWER|UPPER)\s*\(\s*)?(?:(["`]?[\w]+["`]?)\s*\.\s*)?(["`]?[\w]+["`]?)\s*\)?\s+(?<!NOT\s)I?LIKE\s+(?:(?:LOWER|UPPER)\s*\(\s*)?('(?:''|[^'])*')\s*\)?/gi;
  for (const match of sql.matchAll(likePattern)) {
    const value = unquoteSqlLiteral(match[3] ?? '').replace(/[%_]+/g, ' ').trim();
    predicates.push({
      relation: resolvePredicateRelation(match[1], aliasToRelation),
      column: cleanIdentifier(match[2] ?? ''),
      value,
      fuzzy: true,
    });
  }

  return predicates.filter((predicate) => predicate.column.length > 0 && predicate.value.length > 0);
}

function findMisboundMemberFilter(
  sql: string,
  aliasToRelation: Record<string, string>,
  bindings: Array<{ dimension: string; values: string[] }>,
): { message: string; relation?: string; column?: string } | undefined {
  if (bindings.length === 0) return undefined;
  const predicates = extractEntityValuePredicates(sql, aliasToRelation);
  // Equality predicates must match the typed member exactly (normalized);
  // LIKE-derived predicates count when the stripped pattern and the typed
  // member contain each other in either direction ('%Capital One%' or a
  // narrower '%Capital%' both honor the binding "Capital One").
  const predicateAppliesValue = (predicate: EntityValuePredicate, valueKey: string): boolean => {
    const predicateKey = normalizeSampleValue(predicate.value);
    if (!predicateKey || !valueKey) return false;
    if (predicateKey === valueKey) return true;
    return Boolean(predicate.fuzzy) && (predicateKey.includes(valueKey) || valueKey.includes(predicateKey));
  };
  for (const binding of bindings) {
    for (const value of binding.values) {
      const valueKey = normalizeSampleValue(value);
      const matchingValuePredicates = predicates.filter((predicate) => predicateAppliesValue(predicate, valueKey));
      if (matchingValuePredicates.length === 0) {
        return {
          message: `SQL does not apply required member binding ${binding.dimension} = "${value}". Preserve the typed binding in the generated filter.`,
        };
      }
      const correctlyBound = matchingValuePredicates.find((predicate) => columnMatchesBindingDimension(predicate.column, binding.dimension));
      if (!correctlyBound) {
        const actual = matchingValuePredicates
          .map((predicate) => `${predicate.relation ? `${predicate.relation}.` : ''}${predicate.column}`)
          .sort()
          .join(', ');
        const first = matchingValuePredicates[0];
        return {
          message: `SQL applies required member "${value}" to ${actual}, but the resolved binding dimension is ${binding.dimension}. Filter a ${binding.dimension} column instead.`,
          relation: first?.relation,
          column: first?.column,
        };
      }
    }
  }
  return undefined;
}

function columnMatchesBindingDimension(column: string, dimension: string): boolean {
  const columnTokens = normalizedConceptTokens(column);
  const dimensionTokens = normalizedConceptTokens(dimension);
  if (dimensionTokens.length === 0) return false;
  return dimensionTokens.every((token) => columnTokens.includes(token));
}

function normalizedConceptTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && token !== 'name' && token !== 'value' && token !== 'label');
}

function predicateMatchesSampleColumn(predicate: EntityValuePredicate, matches: SampleValueColumnMatch[]): boolean {
  return matches.some((match) => {
    if (!namesEqual(predicate.column, match.column)) return false;
    if (!predicate.relation) return true;
    return relationLookupKeys(predicate.relation).some((key) => relationLookupKeys(match.relation).includes(key));
  });
}

function resolvePredicateRelation(qualifier: string | undefined, aliasToRelation: Record<string, string>): string | undefined {
  if (!qualifier) return undefined;
  const cleaned = cleanIdentifier(qualifier);
  if (!cleaned) return undefined;
  const direct = aliasToRelation[cleaned] ?? aliasToRelation[cleaned.toLowerCase()];
  if (direct) return direct;
  return cleaned;
}

function stringLiteralsInList(raw: string): string[] {
  return Array.from(raw.matchAll(/'(?:''|[^'])*'|"(?:\\"|[^"])*"/g)).map((match) => unquoteSqlLiteral(match[0]));
}

function unquoteSqlLiteral(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"');
  }
  return trimmed;
}

function cleanIdentifier(value: string): string {
  return value.replace(/^["`]|["`]$/g, '').trim();
}

function normalizeSampleValue(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isTemporalEntityFilter(value: string): boolean {
  return /\b(last|this|next|previous|prior|current)\s+(day|week|month|quarter|year)\b/i.test(value)
    || /\b(today|yesterday|tomorrow|ytd|mtd|qtd|wtd)\b/i.test(value)
    || /^\d{4}-\d{2}-\d{2}/.test(value);
}
