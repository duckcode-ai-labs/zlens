import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildExecutionPlan } from '@zlens/notebook';
import { prepareBlockInvocation } from '../block-invocation.js';
import { writeFileSync } from 'node:fs';
import type { ConnectionConfig, QueryExecutor } from '@zlens/connectors';
import { getDialect, type DQLManifest, type SemanticLayer } from '@zlens/core';
import {
  type ProjectionScope,
  type PreparedRefusal,
  askScopeFromWorkspace,
  buildVocabularyIndex,
  classifyWarehouseError,
  hostedWarehouseError,
  assessAnalyticalRelationship,
  parseMemberOption,
  projectVocabularySource,
  rankedRefsFromPack,
  resolveDomainContextEnvelope,
  runAskPipeline,
  type DomainContextEnvelope,
  type LocalContextPack,
  type ContextLedgerV1,
  type JoinAuthorityV1,
  type UnprovenJoin,
  catalogKeyTypes,
  validateRelationshipOnWarehouse,
  type AgentProvider,
  type AgentRouteExecutor,
  type AgentRouteExecutorResult,
  type AgentRunArtifact,
  type AgentRunNextAction,
  type AgentRunRequest,
  type AnalyticalIntentV1,
  type PipelineOutcome,
  type PreparedCandidate,
  type PrepareDeps,
  type RelationalJoinStep,
  type ProviderRunOptions,
  type SemanticCompileOutput,
  type SemanticCompileRequest,
  type VocabularyIndex,
  type AskStoryStepV1,
  type PipelineReceipt,
  type VocabularySource,
  type PreparedBlock,
  type VocabularyEntry,
  type PhysicalRelationBindingV1,
  parsePhysicalIdentifier,
  physicalRelationBinding,
  physicalRelationIdentity,
  physicalRelationTailIdentity,
  renderPhysicalIdentifier,
  renderPhysicalRelation,
  mergeDiscoveredRelations,
  aggregatesRows,
  appliedConditions,
  joinKeyPairs,
  joinKeyGroups,
  type JoinKeyGroup,
  unusedJoins,
  aggregatesColumnOf,
  missingRequiredFilters,
  missingStatedValues,
  requiredFilterFromText,
  statedValues,
  blocksNamedByQuestion,
  withRowGuard,
  physicalRelationText,
  type PhysicalIdentifierPartV1,
  renderCard,
  validateSqlAgainstLocalContext,
  inspectedRelationMatches,
  type AgentMessage,
  type RuntimeSchemaTable,
  priorWithoutValues,
  sqlStringValues,
} from '@zlens/agent';
import { buildProjectVocabulary, buildVocabularySource, embeddedManifestRelations, namedBlockNotServed, normalizeRelationName, warehouseFirstCatalog, type VocabularySourceInput } from './vocabulary-source.js';
import { groupingKeyLabels, keyLabelLine, keyLabels, unnamedGroupingKeys, unnamedKeyFailure, type EntityKey, type KeyLabel, type KeyReference } from './key-labels.js';
import { businessIdentifierLine, businessIdentifiers, modelingEntityTexts, certifiedJoinViolations, classifySqlJoins, ledgerJoins, markerTableLine, markerTables, modeledJoinPaths, modelingRelationshipEdges, sameRelation, sharedParentShortcuts, type LedgerJoin } from './join-relationships.js';
import { readEnv } from '@zlens/core';
import { readValueProfile, renderColumnProfile } from '../value-profile.js';
import { resultReviewEnabled } from '../result-review-setting.js';

/**
 * THE ASK PIPELINE HOST.
 *
 * Everything the host-neutral pipeline needs from the running server:
 * the vocabulary of the current snapshot, the configured provider, the
 * semantic compiler, the governed join graph, the warehouse, and the
 * conversation store. It returns an `AgentRouteExecutor`, so the engine
 * keeps owning the run lifecycle, artifacts, persistence and the UI shape.
 */

/**
 * Request-local physical evidence handed from Ask to the semantic runtime.
 *
 * This deliberately travels beside the semantic request rather than being
 * reconstructed from a project-default runtime snapshot.  A Snowflake
 * project can legitimately contain DB_A.PUBLIC.EVENTS and DB_B.PUBLIC.EVENTS;
 * the selected Ask vocabulary is the only authority for which one this run
 * has inspected and may compile against.
 */
export interface AskSemanticCompileContext {
  snapshotId: string;
  executionTargetFingerprint: string;
  vocabulary: VocabularyIndex;
  /** Exact, target-bound bindings relevant to this semantic request. */
  physicalBindings: PhysicalRelationBindingV1[];
}

type PriorIntent = { intent: AnalyticalIntentV1; summary?: string; executed?: boolean; sql?: string; drafted?: boolean };
type ConversationMemory = { summary?: string; pendingClarification?: string };

export interface AskPipelineHostDeps {
  projectRoot: string;
  /**
   * RFC 0010 HH-13: leave out the certified sources this person may not use,
   * before any of them reaches the model. `key` names the person's access so
   * a cached view is never another person's.
   */
  admitSources?: { key(): string; admit(source: VocabularySource): Promise<VocabularySource> };
  executor: QueryExecutor;
  resolveConnection(request: AgentRunRequest): Promise<ConnectionConfig>;
  getSemanticLayer(): SemanticLayer | undefined;
  getManifest(): { manifest: DQLManifest | undefined; snapshotId: string };
  selectProvider(request: AgentRunRequest): Promise<AgentProvider | undefined>;
  /**
   * RFC 0010 HH-5: whether result values (an earlier answer's text, the thread's memory) may reach this model.
   * Without it, they may (single-user, the person's chosen model).
   */
  valuesMayReachModel?(request: AgentRunRequest, provider: AgentProvider): boolean | Promise<boolean>;
  /**
   * Whether the project's column value profile (`agent.valueProfile`, example
   * values and ranges) may reach the SQL drafter. Absent: it may not; the
   * profile is opt-in because its values reach the provider with the prompt.
   */
  valueProfileAllowed?(): boolean;
  /**
   * Whether the project turned the result review on (`agent.resultReview`),
   * asked at every question. Absent: off. `ZLENS_ASK_RESULT_REVIEW=1|0`
   * overrides it either way.
   */
  resultReviewConfigured?(): boolean;
  /** Compile on the project's active semantic engine; throws with the engine's message. */
  compileSemantic(request: SemanticCompileRequest, connection: ConnectionConfig, context?: AskSemanticCompileContext): Promise<SemanticCompileOutput>;
  /** The engine `compileSemantic` will use, known before preparation so the binder can speak its dialect. */
  semanticEngine?(): Promise<'native' | 'metricflow-cli' | 'dbt-cloud'>;
  /** Wrap one physical provider call in the run's dispatch ledger. */
  dispatchOptions?(purpose: 'resolve' | 'correct' | 'repair' | 'draft' | 'research_select' | 'research_narrate' | 'knowledge', request: AgentRunRequest): { options: ProviderRunOptions; settle(outcome: 'ok' | 'error' | 'cancelled', error?: unknown): void };
  /** The executed intent of the last usable turn in this thread, when there is one. */
  /** The previous turn's typed reading. `executed: false` means it was blocked: its question stands, its result does not exist. */
  /**
   * The thread's previous turn: its typed reading, a summary of its answer,
   * whether it executed, and — for an answer whose SQL the AI drafted — that
   * statement, so a follow-up edits it instead of starting over.
   */
  /** The thread's last typed reading; may answer with a Promise (a host's conversation store, RFC 0010 HH-6). */
  priorIntent(request: AgentRunRequest): PriorIntent | undefined | Promise<PriorIntent | undefined>;
  guidance?(request: AgentRunRequest): string | undefined;
  /**
   * The request-bound context pack for this envelope (CTX-010): complete
   * eligible admission, the selected skills, the approved hints, the domain
   * briefing. The vocabulary the interpreter reads is a view over it.
   */
  buildContextPack?(request: AgentRunRequest, envelope: DomainContextEnvelope): Promise<LocalContextPack | undefined>;
  /** The thread's compacted memory for a follow-up. */
  conversation?(request: AgentRunRequest): ConversationMemory | undefined | Promise<ConversationMemory | undefined>;
  /**
   * The catalog's own search (full text over names, descriptions and documented
   * columns), held to the request's domains. The SQL drafter finds the tables a
   * question or a missing field names with it; a hit is kept only when the
   * request's projected source admits its relation.
   */
  searchCatalog?(request: AgentRunRequest, envelope: DomainContextEnvelope, query: string, options: { objectTypes: string[]; limit: number }): Array<{ objectType: string; name: string; relation?: string; description?: string }>;
  buildIdentity?(): Record<string, string>;
  maxRows?: number;
  /** Run the review-required SQL tier on its own when nothing governed prepares (default true); `agent.askAutoExploration: false` keeps it opt-in. */
  autoExploration?: boolean;
  /** Whether the project allowlists this physical column for an exact literal probe (`agent.runtimeValueGrounding`). */
  literalProbeAllowed?(relation: string, column: string): boolean;
  /** Distinct stored values equal to the literal ignoring case, on an allowlisted column; bounded, equality-predicated. */
  probeLiteral?(relation: string, column: string, value: string, connection: ConnectionConfig): Promise<string[]>;
  /** The entity keys behind a label value on an allowlisted label column (`SELECT DISTINCT key, label ... LIMIT 6`). */
  probeLabelKeys?(relation: string, keyColumn: string, labelColumn: string, value: string, connection: ConnectionConfig): Promise<Array<{ key: string; label: string }>>;
  /**
   * Open a physical trace span for a warehouse statement or a value probe;
   * the host never records SQL or values, only fingerprints and outcomes.
   */
  traceExecution?(request: AgentRunRequest, span: AskHostTraceSpan): { finish(outcome: 'ok' | 'error', extra?: { rowCount?: number; resultFingerprint?: string; safeErrorCode?: string }): void } | undefined;
}

export type AskHostTraceSpan =
  | { name: 'sql.execute'; sqlFingerprint: string; purpose: 'query' | 'fanout_probe'; tier?: 'certified' | 'semantic' | 'relational' | 'exploratory' }
  | { name: 'tool.call'; toolKind: 'search_values'; inputFingerprint: string };

const fingerprintText = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 24);

interface VocabularyCacheEntry { key: string; source: VocabularySource }

type ProbedRelation = NonNullable<VocabularySourceInput['relations']>[number];
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const METADATA_PAGE_SIZE = 800;

type ProbeIdentifier = { database?: PhysicalIdentifierPartV1; schema?: PhysicalIdentifierPartV1; table: PhysicalIdentifierPartV1; raw: string };

/** Only simple dbt/Snowflake identifiers enter a metadata predicate. */
function probeIdentifier(raw: string): ProbeIdentifier | undefined {
  const parts = parsePhysicalIdentifier(raw);
  const table = parts.at(-1);
  const schema = parts.length >= 2 ? parts.at(-2) : undefined;
  const database = parts.length >= 3 ? parts.at(-3) : undefined;
  if (parts.length > 3 || !table || (!table.quoted && !IDENTIFIER.test(table.value)) || (schema && !schema.quoted && !IDENTIFIER.test(schema.value)) || (database && !database.quoted && !IDENTIFIER.test(database.value))) return undefined;
  return { ...(database ? { database } : {}), ...(schema ? { schema } : {}), table, raw };
}

const sqlLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
const probeSegment = (part: PhysicalIdentifierPartV1) => part.quoted ? `"${part.value.replace(/"/g, '""')}"` : part.value;
const probeMatch = (column: string, part: PhysicalIdentifierPartV1) => part.quoted
  ? `${column} = ${sqlLiteral(part.value)}`
  : `LOWER(${column}) = ${sqlLiteral(part.value.toLowerCase())}`;

function probePredicate(relation: ProbeIdentifier): string {
  return relation.schema
    ? `(${probeMatch('table_schema', relation.schema)} AND ${probeMatch('table_name', relation.table)})`
    : `(${probeMatch('table_name', relation.table)})`;
}

/**
 * The information_schema lookup for a handful of NAMED relations: identifiers
 * only, a bounded predicate list, a row cap. It reads column names and types,
 * never row values, so it is a metadata point lookup rather than discovery.
 */
export function relationColumnsProbeSql(relations: string[], maxRelations = 8, offset = 0, driver = 'snowflake', location?: string): string | undefined {
  const groups = new Map<string, ProbeIdentifier[]>();
  const seen = new Set<string>();
  for (const raw of relations) {
    const relation = probeIdentifier(raw);
    if (!relation) continue;
    const partKey = (part: PhysicalIdentifierPartV1 | undefined) => part ? `${part.quoted ? 'q' : 'u'}:${part.quoted ? part.value : part.value.toLowerCase()}` : '';
    const key = [relation.database, relation.schema, relation.table].map(partKey).join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    const group = relation.database ? `${relation.database.quoted ? 'q' : 'u'}:${relation.database.value}` : '';
    const list = groups.get(group) ?? [];
    list.push(relation);
    groups.set(group, list);
    if (seen.size >= maxRelations) break;
  }
  if (groups.size === 0) return undefined;
  // Snowflake's INFORMATION_SCHEMA is per database.  A database-qualified
  // dbt relation therefore MUST NOT be collapsed into the session database.
  // Every branch retains table_catalog so rows merge only back into the exact
  // binding that asked for them. `ROW_NUMBER` makes a bounded page explicit;
  // callers mark an exact-page result partial rather than treating it absent.
  const databaseScopedInformationSchema = driver.toLowerCase() === 'snowflake';
  const branches = [...groups.entries()].map(([, group]) => {
    const database = group[0]?.database;
    // Snowflake's information schema is per database. DuckDB (and most
    // other local engines) exposes the current connection's information
    // schema directly; prefixing it with the dbt catalog produces a relation
    // that does not exist. Keep exact database identity for Snowflake while
    // retaining a valid local-MetricFlow discovery path.
    // SQLite has no information_schema: the same rows come from its catalog
    // pragmas (every attached schema), as the warehouse catalog sync reads them.
    const source = driver.toLowerCase() === 'sqlite'
      ? "(SELECT t.schema AS table_schema, t.name AS table_name, p.name AS column_name, p.type AS data_type, p.cid + 1 AS ordinal_position FROM pragma_table_list t JOIN pragma_table_info(t.name, t.schema) p WHERE t.type IN ('table', 'view') AND t.schema NOT IN ('temp', 'information_schema') AND t.name NOT LIKE 'sqlite_%') sqlite_columns"
      : driver.toLowerCase() === 'bigquery'
      // BigQuery has no session information_schema: read the project's
      // columns in the connection's location.
      ? `${database ? `\`${database.value.replace(/`/g, '')}\`.` : ''}\`region-${(location ?? 'US').toLowerCase()}\`.INFORMATION_SCHEMA.COLUMNS`
      : database && databaseScopedInformationSchema ? `${probeSegment(database)}.information_schema.columns` : 'information_schema.columns';
    const catalog = database ? sqlLiteral(database.value) : currentCatalogExpression(driver);
    const predicate = group.map(probePredicate).join(' OR ');
    return [
      'SELECT table_catalog, table_schema, table_name, column_name, data_type, ordinal_position, dql_column_total',
      'FROM (',
      `  SELECT ${catalog} AS table_catalog, table_schema, table_name, column_name, data_type, ordinal_position,`,
      '    ROW_NUMBER() OVER (PARTITION BY table_schema, table_name ORDER BY ordinal_position) AS dql_column_page,',
      '    COUNT(*) OVER (PARTITION BY table_schema, table_name) AS dql_column_total',
      `  FROM ${source}`,
      "  WHERE UPPER(table_schema) NOT IN ('INFORMATION_SCHEMA', 'PG_CATALOG')",
      `    AND (${predicate})`,
      ') dql_columns',
      `WHERE dql_column_page > ${Math.max(0, offset)} AND dql_column_page <= ${Math.max(0, offset) + METADATA_PAGE_SIZE}`,
    ].join('\n');
  });
  return `${branches.join('\nUNION ALL\n')}\nORDER BY table_catalog, table_schema, table_name, ordinal_position`;
}

/**
 * The session's database, as each engine spells it. MySQL, ClickHouse and
 * Athena name tables `database.table` (schema.table): no third part is
 * recorded, so their relations keep the two-part name users write.
 */
function currentCatalogExpression(driver: string): string {
  switch (driver.toLowerCase()) {
    case 'mssql':
    case 'fabric':
      return 'DB_NAME()';
    case 'trino':
      return 'current_catalog';
    case 'mysql':
    case 'clickhouse':
    case 'athena':
      return 'NULL';
    case 'sqlite':
      // SQLite has no CURRENT_DATABASE() and no catalog above the `main` schema.
      return 'NULL';
    default:
      return 'CURRENT_DATABASE()';
  }
}

/**
 * A probed relation under the name the probe ASKED for: the warehouse spells
 * CONSUMPTION_METRICS.HEADER where the manifest says consumption_metrics.header,
 * and the vocabulary must merge the columns into the manifest's relation, not
 * add a second one. A relation nobody asked for keeps the warehouse's spelling.
 */
export function underAskedNames(found: ProbedRelation[], wanted: string[]): ProbedRelation[] {
  const asked = wanted.map(probeIdentifier).filter((item): item is ProbeIdentifier => Boolean(item));
  const samePart = (actual: string | undefined, wantedPart: PhysicalIdentifierPartV1 | undefined) => {
    if (!wantedPart) return true;
    if (!actual) return false;
    return wantedPart.quoted ? actual === wantedPart.value : actual.toLowerCase() === wantedPart.value.toLowerCase();
  };
  const rawPart = (part: PhysicalIdentifierPartV1) => probeSegment(part);
  const bindingFor = (relation: ProbedRelation, requested?: ProbeIdentifier) => {
    const physical = requested?.database
      ? requested.raw
      : [relation.database, requested?.schema ? rawPart(requested.schema) : relation.schema, requested ? rawPart(requested.table) : relation.name].filter(Boolean).join('.');
    const logical = requested?.schema ? `${requested.schema.value}.${requested.table.value}` : requested?.table.value ?? (relation.schema ? `${relation.schema}.${relation.name}` : relation.name);
    return physicalRelationBinding({
      logicalRelation: logical,
      physicalRelation: physical,
      source: 'warehouse_probe',
      columns: relation.columns.map((column) => ({ name: column.name, ...(column.dataType ? { type: column.dataType } : {}), ...(column.description ? { description: column.description } : {}) })),
      columnCompleteness: relation.columnCompleteness ?? 'partial',
      ...(relation.observedAt ? { observedAt: relation.observedAt } : {}),
      ...(relation.truncated ? { truncated: true } : {}),
    });
  };
  return found.map((relation) => {
    const matching = asked.filter((candidate) => samePart(relation.database, candidate.database) && samePart(relation.schema, candidate.schema) && samePart(relation.name, candidate.table));
    // A short alias is safe only when this request identifies one exact
    // physical object. Keep a warehouse spelling otherwise, rather than
    // mapping DB_A.PUBLIC.EVENTS onto DB_B.PUBLIC.EVENTS by tail name.
    const requested = matching.length === 1 ? matching[0] : undefined;
    const binding = bindingFor(relation, requested);
    return {
      ...relation,
      ...(requested ? { name: requested.table.value, ...(requested.schema ? { schema: requested.schema.value } : {}), ...(requested.database ? { database: requested.database.value } : {}) } : {}),
      binding,
    };
  });
}

/** Probe rows grouped into relations the vocabulary can merge. */
export function relationsFromProbeRows(rows: Array<Record<string, unknown>>, complete = true, offset = 0): ProbedRelation[] {
  const byRelation = new Map<string, ProbedRelation & { dqlColumnTotal?: number }>();
  for (const row of rows) {
    const record = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
    const schema = typeof record.table_schema === 'string' ? record.table_schema : undefined;
    const database = typeof record.table_catalog === 'string' ? record.table_catalog : undefined;
    const name = typeof record.table_name === 'string' ? record.table_name : undefined;
    const column = typeof record.column_name === 'string' ? record.column_name : undefined;
    if (!name || !column) continue;
    const key = [database, schema, name].filter(Boolean).join('.');
    const total = typeof record.dql_column_total === 'number'
      ? record.dql_column_total
      : typeof record.dql_column_total === 'string' && /^\d+$/.test(record.dql_column_total) ? Number(record.dql_column_total) : undefined;
    const relation = byRelation.get(key) ?? { ...(database ? { database } : {}), ...(schema ? { schema } : {}), name, columns: [], columnCompleteness: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(), ...(total !== undefined ? { dqlColumnTotal: total } : {}) };
    relation.columns.push({ name: column, ...(typeof record.data_type === 'string' && record.data_type ? { dataType: record.data_type } : {}) });
    if (total !== undefined) relation.dqlColumnTotal = total;
    byRelation.set(key, relation);
  }
  return [...byRelation.values()].map(({ dqlColumnTotal, ...relation }) => {
    // A page boundary belongs to each relation.  A batch with A=800 and B=1
    // is not one 801-column relation: only the relation whose own page is
    // incomplete stays partial.  Count windows give a definitive answer when
    // the driver exposes them; mocks/older engines remain conservative.
    const fullyLoaded = dqlColumnTotal !== undefined
      ? offset + relation.columns.length >= dqlColumnTotal
      : relation.columns.length < METADATA_PAGE_SIZE;
    return {
      ...relation,
      columnCompleteness: complete && fullyLoaded ? 'complete' : 'partial',
      ...(!fullyLoaded ? { truncated: true } : {}),
    };
  });
}

/**
 * Relations the vocabulary knows by name but not by column: a table the
 * semantic layer or a dbt source references that no manifest documented, or
 * one documented without types. A partial description is not evidence that
 * the other columns are absent.
 */
/**
 * Rows of Snowflake's `SHOW COLUMNS IN <table>` in the shape of the
 * information_schema probe (`table_catalog … dql_column_total`), so one
 * grouping routine serves both. `data_type` arrives as JSON
 * (`{"type":"FIXED","precision":38,"scale":0,…}`); the type name is kept and
 * FIXED/TEXT/REAL are spelled as the column roles expect.
 */
export function snowflakeShowColumnsRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const record = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
    const name = typeof record.column_name === 'string' ? record.column_name : undefined;
    const table = typeof record.table_name === 'string' ? record.table_name : undefined;
    if (!name || !table) continue;
    let type: string | undefined = typeof record.data_type === 'string' ? record.data_type : undefined;
    if (type && type.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(type) as { type?: string; precision?: number; scale?: number; length?: number };
        const kind = typeof parsed.type === 'string' ? parsed.type.toUpperCase() : undefined;
        type = kind === 'FIXED' ? `NUMBER(${parsed.precision ?? 38},${parsed.scale ?? 0})`
          : kind === 'TEXT' ? `VARCHAR${parsed.length ? `(${parsed.length})` : ''}`
            : kind === 'REAL' ? 'FLOAT'
              : kind;
      } catch { /* keep the raw spelling */ }
    }
    out.push({
      ...(typeof record.database_name === 'string' ? { table_catalog: record.database_name } : {}),
      ...(typeof record.schema_name === 'string' ? { table_schema: record.schema_name } : {}),
      table_name: table,
      column_name: name,
      ...(type ? { data_type: type } : {}),
      ordinal_position: out.length + 1,
    });
  }
  for (const row of out) row.dql_column_total = out.filter((other) => other.table_name === row.table_name && other.table_schema === row.table_schema).length;
  return out;
}

/**
 * The database each dbt relation lives in, from the manifest's provenance
 * (`"DB"."SCHEMA"."TABLE"`), keyed by `schema.table` in lower case. The
 * vocabulary identifies a relation by schema and table; a warehouse that
 * addresses objects across databases (Snowflake) is written the full name.
 */
export function relationDatabases(manifest: { dbtProvenance?: { nodes: Record<string, { relation?: string }> } } | undefined): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  const legacyAliases = new Map<string, string>();
  for (const node of Object.values(manifest?.dbtProvenance?.nodes ?? {})) {
    const parts = parsePhysicalIdentifier(node.relation ?? '');
    if (parts.length === 3) {
      // The key encodes quote state.  `PUBLIC.EVENTS` and
      // `"Public"."Events"` are different Snowflake identities.
      const key = physicalRelationIdentity([parts[1], parts[2]].map((part) => part.quoted ? `"${part.value.replace(/"/g, '""')}"` : part.value).join('.'));
      const seen = candidates.get(key) ?? new Set<string>();
      const database = parts[0]!;
      seen.add(database.quoted ? `"${database.value.replace(/"/g, '""')}"` : database.value);
      candidates.set(key, seen);
      // Keep stored schema.table references working only when the exact-tail
      // provenance resolves to one database. The physical identity remains the
      // authoritative lookup; this alias is a compatibility convenience.
      legacyAliases.set(key, [parts[1], parts[2]].map((part) => part.value.toLowerCase()).join('.'));
    }
  }
  const out = new Map<string, string>();
  for (const [key, databases] of candidates) if (databases.size === 1) {
    const database = [...databases][0]!;
    out.set(key, database);
    const legacy = legacyAliases.get(key);
    if (legacy) out.set(legacy, database);
  }
  return out;
}

/** `schema.table` as the warehouse addresses it: with its database on Snowflake when provenance knows it; unchanged elsewhere. */
export function physicalRelationName(relation: string, databases: Map<string, string>, driver: string | undefined): string {
  if (driver?.toLowerCase() !== 'snowflake') return relation;
  const parts = parsePhysicalIdentifier(relation);
  if (parts.length !== 2) return relation;
  const database = databases.get(physicalRelationIdentity(relation))
    ?? databases.get(parts.map((part) => part.value.toLowerCase()).join('.'));
  return database ? `${database}.${relation}` : relation;
}

/** The wall-clock budget of the column probe per snapshot and connection; `ZLENS_ASK_COLUMN_PROBE_MS` overrides (default 12 s). */
export function columnProbeBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(readEnv('ZLENS_ASK_COLUMN_PROBE_MS', env));
  return Number.isFinite(configured) && configured > 0 ? configured : 12_000;
}

export function relationsNeedingColumns(source: ReturnType<typeof buildVocabularySource>, max = 48): string[] {
  // A relation the warehouse has not described yet: no columns at all, or a
  // handful a cube or a binding happened to name (one exposed key does not
  // make "the team directory only exposes team_id" true — the relation has
  // its columns, the vocabulary just has not asked for them).
  const sparse = (relation: { columns: Array<{ name: string; dataType?: string }>; columnCompleteness?: string }) => relation.columnCompleteness !== 'complete' || relation.columns.length < 4 || relation.columns.some((column) => !column.dataType);
  return (source.relations ?? [])
    .filter((relation) => sparse(relation))
    .map((relation) => relation.binding ? physicalRelationText(relation.binding) : [relation.schema, relation.name].filter(Boolean).join('.'))
    .slice(0, max);
}

/**
 * Relation-first discovery.  A manifest-only project may have tens of
 * thousands of documented columns, but ordinary questions need a handful of
 * tables.  Score embedded column metadata too, which keeps the enterprise
 * catalog storage bound without making the columns invisible to retrieval.
 */
type RelevanceIndex = {
  relations: Array<{ name: string; words: Set<string>; tail: string; partial: number }>;
  semanticByTail: Map<string, Array<{ words: Set<string>; isTime: boolean }>>;
};
// The word sets of every relation and semantic entry, computed ONCE per base
// source (the source object is cached per snapshot and connection). Scoring
// per question is then an intersection with the question's few words. The
// first shape recomputed every description's words and walked every semantic
// entry for every relation on each question: 95 s on a 4,700-model project.
const relevanceIndexCache = new WeakMap<object, RelevanceIndex>();
const splitRelevanceIndexCache = new WeakMap<object, RelevanceIndex>();
const relevanceStem = (value: string) => {
  const lower = value.toLowerCase();
  if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith('ing') && lower.length > 5) return lower.slice(0, -3);
  if (lower.endsWith('ed') && lower.length > 4) return lower.slice(0, -2);
  if (lower.endsWith('s') && lower.length > 3 && !lower.endsWith('ss')) return lower.slice(0, -1);
  return lower;
};
const relevanceWords = (values: Array<string | undefined>, splitNames = false): Set<string> => {
  const words = new Set<string>();
  for (const text of values) {
    if (!text) continue;
    for (const word of text.toLowerCase().split(/[^a-z0-9_]+/)) {
      if (word.length > 2) words.add(relevanceStem(word));
      // COMPETITOR_C, PRIMARY_COMPETITOR: a column name is words joined by
      // underscores, and a question names the words, not the spelling.
      // The governed context keeps whole names (its cards, and the recorded
      // prompts, depend on the relations it hydrates); the SQL drafter splits.
      if (splitNames && word.includes('_')) for (const part of word.split('_')) if (part.length > 2) words.add(relevanceStem(part));
    }
  }
  return words;
};
const relevanceTail = (value: string | undefined) => {
  const parts = parsePhysicalIdentifier(value ?? '');
  if (parts.length === 0) return '';
  return parts.slice(-2).map((part) => `${part.quoted ? 'q' : 'u'}:${part.quoted ? part.value : part.value.toLowerCase()}`).join('.');
};
function relevanceIndexFor(source: ReturnType<typeof buildVocabularySource>, splitNames = false): RelevanceIndex {
  const cache = splitNames ? splitRelevanceIndexCache : relevanceIndexCache;
  const cached = cache.get(source);
  if (cached) return cached;
  type SemanticSource = NonNullable<VocabularySource['metrics']>[number]
    | NonNullable<VocabularySource['measures']>[number]
    | NonNullable<VocabularySource['dimensions']>[number]
    | NonNullable<VocabularySource['entities']>[number];
  const semanticEntries: SemanticSource[] = [...(source.metrics ?? []), ...(source.measures ?? []), ...(source.dimensions ?? []), ...(source.entities ?? [])];
  const semanticByTail = new Map<string, Array<{ words: Set<string>; isTime: boolean }>>();
  for (const entry of semanticEntries) {
    const physical = entry.physical?.relation;
    if (!physical) continue;
    const tail = relevanceTail(physical);
    const list = semanticByTail.get(tail) ?? [];
    list.push({
      words: relevanceWords([entry.name, 'label' in entry ? entry.label : undefined, entry.description, 'aliases' in entry ? entry.aliases?.join(' ') : undefined, entry.physical?.column], splitNames),
      isTime: ('isTime' in entry && Boolean(entry.isTime)) || ('dataType' in entry && /(?:date|time|timestamp)/i.test(entry.dataType ?? '')),
    });
    semanticByTail.set(tail, list);
  }
  const relations = (source.relations ?? []).map((relation) => {
    const name = relation.binding ? physicalRelationText(relation.binding) : [relation.schema, relation.name].filter(Boolean).join('.');
    return {
      name,
      // Large dbt manifests keep column data embedded on the relation rather
      // than as catalog objects; that relation-level lane is only for
      // selection: physical columns are still hydrated and validated before
      // an Ask run can use them.
      words: relevanceWords([relation.name, relation.schema, relation.description, ...relation.columns.flatMap((column) => [column.name, column.description]), ...(relation.embeddedColumns ?? []).flatMap((column) => [column.name, column.description])], splitNames),
      tail: relevanceTail(name),
      partial: relation.columnCompleteness !== 'complete' ? 1 : 0,
    };
  });
  const index = { relations, semanticByTail };
  cache.set(source, index);
  return index;
}

/**
 * Relation-first discovery.  A manifest-only project may have tens of
 * thousands of documented columns, but ordinary questions need a handful of
 * tables.  Score embedded column metadata too, which keeps the enterprise
 * catalog storage bound without making the columns invisible to retrieval.
 *
 * Compare distinct terms (a relation description repeated on every column
 * must not outrank the narrow fact table), then give the physical home of a
 * matching semantic field a bounded boost. The boost selects metadata to
 * inspect; it is never a binding or evidence that two fields compose.
 */
/**
 * THE WIDER LOOK. A draft over the tables first chosen found no field for
 * something the question asks: every relation in the source is searched for a
 * column whose name or description carries those words. Words the question,
 * the reading's open clauses or the conversation used weigh more than words
 * only the drafter's sentence used, so "competitor" outranks "primary".
 */
export function relationsWithColumnWords(
  source: Pick<VocabularySource, 'relations'>,
  words: string[],
  emphasis: string,
  exclude: string[],
  max = 3,
  /** What else is written about a table (its Modeling entity's context): a word found only there counts once, below any column match. */
  tableText: (relation: string) => string | undefined = () => undefined,
): string[] {
  const wanted = [...relevanceWords(words, true)];
  if (wanted.length === 0) return [];
  const emphasized = relevanceWords([emphasis], true);
  const excluded = new Set(exclude.map((name) => physicalRelationIdentity(name)));
  return (source.relations ?? [])
    .map((relation) => {
      const name = relation.binding ? physicalRelationText(relation.binding) : [relation.schema, relation.name].filter(Boolean).join('.');
      const columnWords = [...relation.columns, ...(relation.embeddedColumns ?? [])].map((column) => relevanceWords([column.name, column.description], true));
      const described = relevanceWords([relation.description, tableText(name)], true);
      let score = 0;
      for (const word of wanted) {
        if (columnWords.some((set) => set.has(word))) score += emphasized.has(word) ? 3 : 1;
        else if (described.has(word)) score += emphasized.has(word) ? 1 : 0.5;
      }
      return { name, score };
    })
    .filter((item) => item.score > 0 && !excluded.has(physicalRelationIdentity(item.name)))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, max)
    .map((item) => item.name);
}

/**
 * Catalog hits (a documented column, a model) named as the relations the
 * request's projected source admits, in hit order. A hit whose relation is
 * outside the source is outside the envelope and is dropped.
 */
export function relationsFromCatalogHits(
  hits: Array<{ objectType: string; name: string; relation?: string }>,
  scoped: Pick<VocabularySource, 'relations'> | undefined,
  exclude: string[],
  max = 3,
): string[] {
  const tail = (value: string) => parsePhysicalIdentifier(value).slice(-2).map((part) => part.value.toLowerCase()).join('.');
  const admitted = new Map<string, string>();
  for (const relation of scoped?.relations ?? []) {
    const name = relation.binding ? physicalRelationText(relation.binding) : [relation.schema, relation.name].filter(Boolean).join('.');
    admitted.set(tail(name), name);
    if (!admitted.has(relation.name.toLowerCase())) admitted.set(relation.name.toLowerCase(), name);
  }
  const excluded = new Set(exclude.map((name) => physicalRelationIdentity(name)));
  const picked: string[] = [];
  for (const hit of hits) {
    const raw = hit.relation ?? (hit.objectType === 'dbt_column' ? undefined : hit.name);
    if (!raw) continue;
    const name = admitted.get(tail(raw)) ?? admitted.get(raw.toLowerCase());
    if (!name || excluded.has(physicalRelationIdentity(name)) || picked.includes(name)) continue;
    picked.push(name);
    if (picked.length >= max) break;
  }
  return picked;
}

/**
 * A RESTRICTION HAS TO REACH THE FACTS. A table can hold what a question asks
 * about only if it joins the tables the reading measures: it is one of them, or
 * it shares a key with one (same name, or <table>_id against that table's ID).
 * A table whose columns are not documented is not ruled out; the warehouse
 * description and the checks decide later.
 */
export function joinsAnyRelation(candidate: string, anchors: string[], columnsOf: (relation: string) => string[]): boolean {
  if (anchors.length === 0) return true;
  if (anchors.some((anchor) => physicalRelationIdentity(anchor) === physicalRelationIdentity(candidate))) return true;
  const candidateColumns = columnsOf(candidate);
  if (candidateColumns.length === 0) return true;
  return anchors.some((anchor) => {
    const anchorColumns = columnsOf(anchor);
    if (anchorColumns.length === 0) return true;
    return Boolean(sharedKeyPair(anchorColumns, candidateColumns, candidate) ?? sharedKeyPair(candidateColumns, anchorColumns, anchor));
  });
}

/**
 * AN APPROVED HINT ABOUT ONE THING STAYS WITH THAT THING. A hint that names a
 * specific value ("Capital One", a quoted code) is a correction for questions
 * about that value; it is not a rule for every question in its scope. A hint
 * naming no value applies as retrieved.
 */
/**
 * Whether text mentions a table name as words: `loss_reserve` is mentioned by
 * "loss reserve" and "loss reserves" as well as by its own spelling. Names
 * shorter than four letters are matched only as written.
 */
export function mentionsName(text: string, name: string): boolean {
  const lower = ` ${text.toLowerCase()} `;
  const plain = name.toLowerCase();
  if (lower.includes(` ${plain} `)) return true;
  if (plain.replace(/[^a-z]/g, '').length < 4) return false;
  const words = plain.split(/[_\s]+/).filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return false;
  return new RegExp(`(^|[^a-z0-9])${words.join('[\\s_-]+')}(e?s)?([^a-z0-9]|$)`).test(lower);
}

const SKILL_WORD = /[a-z][a-z0-9]{2,}/g;
const SKILL_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'what', 'which', 'each', 'all', 'are', 'from', 'that', 'this', 'how', 'many', 'much', 'our', 'have', 'has', 'jaffle', 'main', 'dev']);

/**
 * THE SKILLS AN AI-WRITTEN STATEMENT READS: at most two selected skills with
 * written guidance, ranked by the distinct words (and table names, split on
 * underscores) they share with the question and the chosen tables. A skill
 * that shares nothing is not shown.
 */
export function skillsForDraft(entries: VocabularyEntry[], text: string, max = 2): VocabularyEntry[] {
  const words = (value: string) => new Set((value.toLowerCase().replace(/[_."]/g, ' ').match(SKILL_WORD) ?? []).filter((word) => !SKILL_STOPWORDS.has(word)));
  const wanted = words(text);
  return entries
    .filter((entry) => entry.kind === 'skill' && Boolean(entry.skill?.guidance))
    .map((entry, index) => {
      const own = words(`${entry.name} ${entry.label ?? ''} ${entry.description ?? ''} ${entry.skill!.guidance}`);
      let shared = 0;
      for (const word of wanted) if (own.has(word)) shared += 1;
      return { entry, shared, index };
    })
    .filter((item) => item.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.index - b.index)
    .slice(0, max)
    .map((item) => item.entry);
}

/**
 * THE CERTIFIED BLOCKS AN AI-WRITTEN STATEMENT READS. A certified block that
 * does not answer the question exactly is still how the team computes a
 * report near it: its joins, filters and definitions were approved. At most
 * two, ranked by the words they share with the question and its reading, and
 * by the chosen tables their SQL reads; a block that shares no word is not
 * shown, and a draft block never is.
 */
export function certifiedBlocksForDraft(entries: VocabularyEntry[], text: string, relations: string[], max = 2): VocabularyEntry[] {
  const words = (value: string) => new Set((value.toLowerCase().replace(/[_."]/g, ' ').match(SKILL_WORD) ?? []).filter((word) => !SKILL_STOPWORDS.has(word)));
  const tail = (relation: string) => relation.replace(/["`\[\]]/g, '').split('.').pop()!.toLowerCase();
  const wanted = words(text);
  const chosen = new Set(relations.map(tail));
  return entries
    .filter((entry) => entry.kind === 'block' && entry.certified === true && Boolean(entry.sql))
    .map((entry, index) => {
      const own = words(`${entry.name} ${entry.label ?? ''} ${entry.description ?? ''} ${(entry.contract?.outputs ?? []).join(' ')}`);
      let shared = 0;
      for (const word of wanted) if (own.has(word)) shared += 1;
      const reads = new Set([...entry.sql!.matchAll(/\b(?:from|join)\s+((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)){0,2})/gi)].map((match) => tail(match[1]!)));
      let tables = 0;
      for (const name of reads) if (chosen.has(name)) tables += 1;
      return { entry, shared, tables, index };
    })
    .filter((item) => item.shared > 0 && (item.tables > 0 || item.shared >= 2))
    .sort((a, b) => (b.shared + b.tables) - (a.shared + a.tables) || a.index - b.index)
    .slice(0, max)
    .map((item) => item.entry);
}

/** A declared relationship two tables of an AI-written statement both carry the keys of. */
export type PreferredJoin = { name: string; certified: boolean; from: string; to: string; keys: Array<{ from: string; to: string }>; cardinality?: string };

/**
 * PREFERRED JOINS FOR AI-WRITTEN SQL. A relationship the team declared in
 * Domain Studio becomes a hint when two chosen tables carry its key columns.
 * A certified one is preferred; a draft is named as not validated. Neither is
 * a gate: the AI may join differently when the question needs it.
 */
export function preferredJoinHints(entries: VocabularyEntry[], relations: string[], columnsOf: (relation: string) => string[]): PreferredJoin[] {
  const carries = (relation: string, name: string) => columnsOf(relation).some((column) => column.toLowerCase() === name.toLowerCase());
  return entries
    .filter((entry) => entry.kind === 'relationship' && Boolean(entry.relationship?.keys.length))
    .flatMap((entry) => {
      const keys = entry.relationship!.keys;
      const from = relations.find((relation) => keys.every((key) => carries(relation, key.from)));
      const to = relations.find((relation) => relation !== from && keys.every((key) => carries(relation, key.to)));
      return from && to ? [{ name: entry.name, certified: entry.joinAuthority === 'certified', from, to, keys, ...(entry.relationship!.cardinality ? { cardinality: entry.relationship!.cardinality } : {}) }] : [];
    })
    .slice(0, 4);
}

export function preferredJoinLine(hint: PreferredJoin): string {
  return `- preferred join (${hint.certified ? `certified in Domain Studio: ${hint.name}` : `declared, not validated: ${hint.name}`}): ${hint.keys.map((key) => `${hint.from}.${key.from} = ${hint.to}.${key.to}`).join(' AND ')}${hint.cardinality ? ` [${hint.cardinality}]` : ''}`;
}

/** Whether a statement joins on every key pair of a hint (either side of the equality). */
export function joinHintUsed(sql: string, keys: PreferredJoin['keys']): boolean {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return keys.every((key) => new RegExp(`\\b${escape(key.from)}\\b"?\\s*=\\s*[\\w."]*\\b${escape(key.to)}\\b|\\b${escape(key.to)}\\b"?\\s*=\\s*[\\w."]*\\b${escape(key.from)}\\b`, 'i').test(sql));
}

export function hintsForQuestion<T extends { title?: string; guidance?: string; lesson?: { rule?: string } }>(hints: T[], question: string): T[] {
  const asked = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const mentioned = (value: string) => {
    const words = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return !words || asked.includes(` ${words} `);
  };
  return hints.filter((hint) => {
    const text = [hint.title, hint.guidance, hint.lesson?.rule].filter(Boolean).join('. ');
    // What makes a hint about ONE thing: a quoted literal it filters on
    // ('CAPITAL ONE') or a multi-word proper name (Capital One). A single
    // capitalised word (NetSuite, Revenue) is how sentences and systems are
    // written, not a member.
    const literals = [...text.matchAll(/'([^']{2,60})'|"([^"]{2,60})"/g)]
      .map((match) => (match[1] ?? match[2])!.replace(/%/g, '').trim())
      .filter((value) => /[a-z]{2}/i.test(value) && !/^(true|false|null)$/i.test(value));
    const names = [...text.matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)].map((match) => match[1]!);
    return [...literals, ...names].every(mentioned);
  });
}

const MISSING_WORD_STOP = new Set(['column', 'columns', 'table', 'tables', 'relation', 'relations', 'field', 'fields', 'listed', 'available', 'such', 'that', 'this', 'which', 'with', 'from', 'there', 'none', 'into', 'filter', 'value', 'values', 'named', 'name', 'holds', 'hold', 'question', 'asked', 'data', 'these', 'those', 'what', 'where', 'records', 'record', 'cannot', 'answer', 'nothing', 'missing', 'only', 'contain', 'contains']);
/** The words of a decline and of the reading's open clauses that could name a column. */
export function missingFieldWords(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !/^\d+$/.test(word) && !MISSING_WORD_STOP.has(word)))].slice(0, 10);
}

export function relevantRelationsForQuestion(
  source: ReturnType<typeof buildVocabularySource>,
  question: string,
  max = 3,
  options: { splitNames?: boolean } = {},
): string[] {
  const index = relevanceIndexFor(source, options.splitNames);
  const words = relevanceWords([question], options.splitNames);
  if (words.size === 0) return [];
  const requestsTime = [...words].some((word) => ['date', 'day', 'week', 'month', 'quarter', 'year', 'calendar', 'fiscal', 'period'].includes(word));
  const overlap = (set: Set<string>) => { let count = 0; for (const word of words) if (set.has(word)) count += 1; return count; };
  const scored = index.relations.map((relation) => {
    const matched = overlap(relation.words);
    // A requested time grain must hydrate the fact relation that owns a
    // compatible time field even when its manifest lists only keys. A direct
    // semantic-name hit is stronger than a repeated word in an unrelated
    // model's column descriptions.
    const semanticAffinity = (index.semanticByTail.get(relation.tail) ?? []).reduce((sum, entry) => sum + overlap(entry.words) * 12 + (requestsTime && entry.isTime ? 12 : 0), 0);
    return { name: relation.name, matched, semanticAffinity, score: matched * 10 + semanticAffinity + relation.partial };
  });
  // A question that matches nothing hydrates nothing: probing three
  // alphabetically-first partial relations costs warehouse round trips and
  // tells the interpreter nothing about this question.
  return scored
    .filter((item) => item.matched > 0 || item.semanticAffinity > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, max)
    .map((item) => item.name);
}

/** Request-local extension used by both the drafter and SQL validator. */
export function runtimeSchemaForVocabulary(vocabulary: VocabularyIndex): RuntimeSchemaTable[] {
  return vocabulary.entries
    .filter((entry) => entry.kind === 'relation')
    .map((entry) => {
      const binding = entry.physical?.binding;
      const logical = entry.model ?? entry.name;
      const relation = binding ? physicalRelationText(binding) : logical;
      const columns = columnsForPhysicalEntry(vocabulary, entry);
      return {
        relation,
        ...(binding?.database ? { catalogOrDatabase: binding.database.value } : {}),
        ...(binding?.schema ? { schema: binding.schema.value } : {}),
        name: binding?.table.value ?? entry.name,
        ...(binding?.executionTargetFingerprint ? { executionTargetFingerprint: binding.executionTargetFingerprint } : {}),
        ...(entry.description ? { description: entry.description } : {}),
        columns,
        source: binding?.source ?? 'vocabulary relation',
        columnCompleteness: binding?.columnCompleteness === 'unknown' ? 'partial' : binding?.columnCompleteness ?? 'partial',
      };
    });
}

function entryPhysicalRelation(entry: VocabularyEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.physical?.binding ? physicalRelationText(entry.physical.binding) : entry.physical?.relation ?? (entry.kind === 'relation' ? entry.model ?? entry.name : undefined);
}

/** Exact physical identity whenever a binding exists; legacy unbound entries
 * retain their one stored relation identity. This is intentionally not the
 * logical schema.table alias used to keep old references readable. */
function physicalEntryIdentity(entry: VocabularyEntry | undefined): string | undefined {
  const relation = entryPhysicalRelation(entry);
  return relation ? physicalRelationIdentity(relation) : undefined;
}

function samePhysicalEntry(left: VocabularyEntry | undefined, right: VocabularyEntry | undefined): boolean {
  const leftIdentity = physicalEntryIdentity(left);
  const rightIdentity = physicalEntryIdentity(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

/** The one column admission path for runtime validation and draft cards. */
export function columnsForPhysicalEntry(vocabulary: VocabularyIndex, relation: VocabularyEntry | undefined): Array<{ name: string; type?: string; description?: string }> {
  return vocabulary.entries
    // A logical dbt name is a compatibility alias, not a physical join key.
    // Two Snowflake databases may both expose PUBLIC.EVENTS; columns admitted
    // for DB_A must never appear in DB_B's draft/validator card.
    .filter((candidate) => candidate.kind === 'column' && samePhysicalEntry(candidate, relation))
    .map((column) => ({ name: column.physical?.column ?? column.name, ...(column.dataType ? { type: column.dataType } : {}), ...(column.description ? { description: column.description } : {}) }));
}

/**
 * GROUND MEMBER LITERALS. A question says "Ryan byrd"; the warehouse holds
 * "Ryan Byrd". The relational tier compares case-insensitively, the semantic
 * compilers do not, so the literal is looked up once, on columns the project
 * explicitly allowlists, and replaced by the stored value. One stored value
 * is a correction; several are left to the query; none is recorded so the
 * reader learns the member is absent rather than seeing an empty aggregate.
 */
export async function groundIntentLiterals(
  intent: AnalyticalIntentV1,
  vocabulary: VocabularyIndex,
  connection: ConnectionConfig,
  deps: Pick<AskPipelineHostDeps, 'literalProbeAllowed' | 'probeLiteral' | 'probeLabelKeys'>,
): Promise<{ intent: AnalyticalIntentV1; notes: string[] }> {
  const notes: string[] = [];
  const ground = async <T extends { ref: string; op: string; values: unknown[] }>(predicate: T): Promise<T> => {
    if (!(predicate.op === 'eq' || predicate.op === 'in') || !predicate.values.some((value) => typeof value === 'string')) return predicate;
    const entry = vocabulary.get(predicate.ref);
    const relation = entryPhysicalRelation(entry);
    const column = entry?.physical?.column;
    if (!relation || !column || !deps.literalProbeAllowed!(relation, column)) return predicate;
    const values: unknown[] = [];
    for (const value of predicate.values) {
      if (typeof value !== 'string' || !value.trim()) { values.push(value); continue; }
      let stored: string[];
      try { stored = await deps.probeLiteral!(relation, column, value, connection); } catch (error) { notes.push(`${column}: probe failed (${error instanceof Error ? error.message : String(error)})`); values.push(value); continue; }
      if (stored.length === 1 && stored[0] !== value) { notes.push(`${column}: ${JSON.stringify(value)} is stored as ${JSON.stringify(stored[0])}`); values.push(stored[0]); }
      else if (stored.length === 0) { notes.push(`${column}: no stored value matches ${JSON.stringify(value)}`); values.push(value); }
      else values.push(value);
    }
    return { ...predicate, values };
  };
  const filters = [] as AnalyticalIntentV1['filters'];
  for (const predicate of intent.filters) filters.push(await ground(predicate));
  const measures = [] as AnalyticalIntentV1['measures'];
  for (const measure of intent.measures) {
    if (!measure.scope?.length) { measures.push(measure); continue; }
    const scope = [] as NonNullable<AnalyticalIntentV1['measures'][number]['scope']>;
    for (const predicate of measure.scope) scope.push(await ground(predicate));
    measures.push({ ...measure, scope });
  }
  let next: AnalyticalIntentV1 = { ...intent, filters, measures };
  // IDENTITY. A singular label ("Ryan Byrd") can name several members. The
  // keys behind the label are looked up on the same allowlist; several keys
  // make the answer one row per member, keyed, with the label displayed,
  // never one merged number.
  if (deps.probeLabelKeys) {
    for (const predicate of next.filters) {
      if (!(predicate.op === 'eq' || predicate.op === 'in') || predicate.values.length !== 1 || typeof predicate.values[0] !== 'string') continue;
      const entry = vocabulary.get(predicate.ref);
      const relation = entryPhysicalRelation(entry);
      const column = entry?.physical?.column;
      if (!entry || !relation || !column || !entry.roles.includes('label') || !deps.literalProbeAllowed!(relation, column)) continue;
      const owner = vocabulary.entries.find((candidate) => candidate.kind === 'entity' && candidate.model === entry.model && candidate.entityType === 'primary' && entryPhysicalRelation(candidate) === relation && candidate.physical?.column);
      if (!owner?.physical?.column) continue;
      let members: Array<{ key: string; label: string }>;
      try { members = await deps.probeLabelKeys(relation, owner.physical.column, column, predicate.values[0], connection); } catch (error) { notes.push(`${column}: key probe failed (${error instanceof Error ? error.message : String(error)})`); continue; }
      const keys = [...new Set(members.map((member) => member.key))];
      if (keys.length <= 1) { if (keys.length === 1) notes.push(`identity: ${JSON.stringify(predicate.values[0])} identifies one ${owner.name}`); continue; }
      const keyed = next.groupBy.some((group) => group.ref === owner.ref);
      next = {
        ...next,
        groupBy: keyed ? next.groupBy : [{ ref: owner.ref, role: 'key' }, ...next.groupBy],
        display: next.display.includes(predicate.ref) ? next.display : [...next.display, predicate.ref],
        expectedShape: next.expectedShape === 'scalar' || next.expectedShape === 'comparison' || next.expectedShape === 'lookup' ? 'grouped' : next.expectedShape,
        provenance: { ...next.provenance, [owner.ref]: next.provenance[owner.ref] ?? `host:${keys.length} ${owner.name}s share ${JSON.stringify(predicate.values[0])}; one row per ${owner.name}` },
      };
      notes.push(`identity: ${keys.length} ${owner.name}s share the name ${JSON.stringify(predicate.values[0])}; one row per ${owner.name}, keyed by ${owner.physical.column}`);
    }
  }
  return { intent: next, notes };
}

/** Value probes are tool calls in the physical trace: one `search_values` span each, fingerprints only. */
export function tracedProbes(deps: Pick<AskPipelineHostDeps, 'literalProbeAllowed' | 'probeLiteral' | 'probeLabelKeys' | 'traceExecution'>, request: AgentRunRequest): Pick<AskPipelineHostDeps, 'literalProbeAllowed' | 'probeLiteral' | 'probeLabelKeys'> {
  if (!deps.traceExecution) return deps;
  const traced = async <T>(input: string, work: () => Promise<T>): Promise<T> => {
    const span = deps.traceExecution!(request, { name: 'tool.call', toolKind: 'search_values', inputFingerprint: fingerprintText(input) });
    try { const value = await work(); span?.finish('ok'); return value; } catch (error) { span?.finish('error', { safeErrorCode: 'probe_failure' }); throw error; }
  };
  return {
    literalProbeAllowed: deps.literalProbeAllowed,
    ...(deps.probeLiteral ? { probeLiteral: (relation, column, value, connection) => traced(`${relation}.${column}=${value}`, () => deps.probeLiteral!(relation, column, value, connection)) } : {}),
    ...(deps.probeLabelKeys ? { probeLabelKeys: (relation, key, label, value, connection) => traced(`${relation}.${key}/${label}=${value}`, () => deps.probeLabelKeys!(relation, key, label, value, connection)) } : {}),
  };
}

/**
 * Join paths over the relationships the team declared in Domain Studio.
 * Each relationship names two modeling entities bound to dbt models, with
 * the key pairs; a breadth-first walk over the undirected graph finds the
 * shortest declared path between two physical relations. Deprecated or
 * rejected relationships never join; a draft one does, and the proof says so.
 */
/**
 * JOIN AUTHORITY (REL-002, amendment A-003). Two graphs over the declared
 * relationships: the AUTHORIZED one, whose edges pass the complete executable
 * invariant (`assessAnalyticalRelationship`: certified, fresh proof, safe
 * fanout, cross-domain chain), and the DECLARED-UNPROVEN one, whose edges are
 * offers — a draft says a join exists, and the host may prove or refuse it,
 * never take it on the author's word. Each authorized step carries its
 * authority so the receipt can name it.
 */
export interface ModelingJoinGraph {
  path(fromRelation: string, toRelation: string): RelationalJoinStep[] | undefined;
  unproven(fromRelation: string, toRelation: string): UnprovenJoin[];
  /** Every domain a relation is bound to through a modeled entity; empty when none. */
  domainsOf(relation: string): string[];
  /** The declared relationship between two relations, when exactly one exists, for a proof to honour its keys and direction. */
  declared(fromRelation: string, toRelation: string): { id: string; keys: Array<{ from: string; to: string }>; cardinality: string; fanout: string; reversed: boolean } | undefined;
  hasDomains: boolean;
}

export function modelingJoinGraph(manifest: DQLManifest | undefined, quoteRelation: (relation: string) => string): ModelingJoinGraph {
  const modeling = manifest?.modeling;
  const empty: ModelingJoinGraph = { path: () => undefined, unproven: () => [], domainsOf: () => [], declared: () => undefined, hasDomains: false };
  if (!modeling) return empty;
  const relationOfEntity = new Map<string, string>();
  const domainsOfRelation = new Map<string, Set<string>>();
  for (const entity of Object.values(modeling.entities ?? {})) {
    const relation = normalizeRelationName(manifest?.dbtProvenance?.nodes[entity.dbtUniqueId]?.relation);
    if (!relation) continue;
    for (const key of [entity.id, entity.localId, entity.qualifiedId]) if (key) relationOfEntity.set(key, relation);
    if (entity.domain) { if (!domainsOfRelation.has(relation)) domainsOfRelation.set(relation, new Set()); domainsOfRelation.get(relation)!.add(entity.domain); }
  }
  const authorized = new Map<string, Array<{ relation: string; on: string; authority: JoinAuthorityV1 }>>();
  const declared = new Map<string, Array<{ id: string; keys: Array<{ from: string; to: string }>; cardinality: string; fanout: string; status: string; reason: string; reversed: boolean }>>();
  const addAuthorized = (from: string, to: string, on: string, authority: JoinAuthorityV1) => {
    if (!authorized.has(from)) authorized.set(from, []);
    authorized.get(from)!.push({ relation: to, on, authority });
  };
  const addDeclared = (from: string, to: string, edge: { id: string; keys: Array<{ from: string; to: string }>; cardinality: string; fanout: string; status: string; reason: string; reversed: boolean }) => {
    const key = `${from}->${to}`;
    if (!declared.has(key)) declared.set(key, []);
    declared.get(key)!.push(edge);
  };
  const hasDomains = Object.keys(modeling.packages ?? {}).length > 0;
  for (const relationship of Object.values(modeling.relationships ?? {})) {
    if (relationship.status === 'deprecated') continue;
    const from = relationOfEntity.get(relationship.from);
    const to = relationOfEntity.get(relationship.to);
    if (!from || !to || from === to || relationship.keys.length === 0) continue;
    const decision = assessAnalyticalRelationship(relationship, manifest);
    const on = relationship.keys.map((key) => `${quoteRelation(from)}.${key.from} = ${quoteRelation(to)}.${key.to}`).join(' AND ');
    if (decision.executable) {
      const fromDomains = [...(domainsOfRelation.get(from) ?? [])];
      const toDomains = [...(domainsOfRelation.get(to) ?? [])];
      const crossDomain = Boolean(relationship.crossDomain) || (fromDomains.length > 0 && toDomains.length > 0 && !fromDomains.some((domain) => toDomains.includes(domain)));
      const authority: JoinAuthorityV1 = {
        version: 1, from, to, keys: relationship.keys, source: 'dql_relationship', relationshipId: relationship.qualifiedId ?? relationship.id, authority: 'certified',
        scope: crossDomain ? 'cross_domain_certified' : hasDomains ? 'within_domain' : 'no_domains', domains: { from: fromDomains, to: toDomains },
        ...(relationship.validation ? { evidence: relationship.validation } : {}),
      };
      addAuthorized(from, to, on, authority);
      addAuthorized(to, from, on, { ...authority, from: to, to: from, keys: relationship.keys.map((key) => ({ from: key.to, to: key.from })), domains: { from: toDomains, to: fromDomains } });
    } else {
      const edge = { id: relationship.qualifiedId ?? relationship.id, keys: relationship.keys, cardinality: relationship.cardinality, fanout: relationship.fanout, status: relationship.status, reason: decision.message, reversed: false };
      addDeclared(from, to, edge);
      addDeclared(to, from, { ...edge, keys: relationship.keys.map((key) => ({ from: key.to, to: key.from })), reversed: true });
    }
  }
  return {
    hasDomains,
    domainsOf: (relation) => [...(domainsOfRelation.get(relation) ?? [])],
    declared: (fromRelation, toRelation) => {
      const edges = declared.get(`${fromRelation}->${toRelation}`) ?? [];
      return edges.length === 1 ? edges[0] : undefined;
    },
    unproven: (fromRelation, toRelation) => (declared.get(`${fromRelation}->${toRelation}`) ?? []).map((edge) => ({ relationshipId: edge.id, from: fromRelation, to: toRelation, keys: edge.keys, status: edge.status, cardinality: edge.cardinality, fanout: edge.fanout, reason: edge.reason })),
    path: (fromRelation, toRelation) => {
      if (fromRelation === toRelation) return [];
      const previous = new Map<string, { relation: string; on: string; authority: JoinAuthorityV1 }>();
      const queue = [fromRelation];
      const seen = new Set([fromRelation]);
      while (queue.length) {
        const current = queue.shift()!;
        for (const edge of authorized.get(current) ?? []) {
          if (seen.has(edge.relation)) continue;
          seen.add(edge.relation);
          previous.set(edge.relation, { relation: current, on: edge.on, authority: edge.authority });
          if (edge.relation === toRelation) {
            const steps: RelationalJoinStep[] = [];
            for (let at = toRelation; at !== fromRelation;) {
              const step = previous.get(at)!;
              steps.unshift({ relation: at, on: step.on, authority: step.authority });
              at = step.relation;
            }
            return steps;
          }
          queue.push(edge.relation);
        }
      }
      return undefined;
    },
  };
}

/**
 * DOMAIN BOUNDARIES DECIDE BEFORE ANY PROBE (A-003). A project with no
 * domains may prove a join anywhere; two relations bound to one domain may be
 * proven within it; an endpoint nobody modeled, or one bound to several
 * domains, is a modeling gap; endpoints in different domains need the
 * governed interface chain and are never probed. Missing domain information
 * never widens eligibility.
 */
export function joinScopeDecision(
  fromRelation: string,
  toRelation: string,
  fromDomains: string[],
  toDomains: string[],
  hasDomains: boolean,
): { scope: JoinAuthorityV1['scope'] } | { refusal: PreparedRefusal } {
  if (!hasDomains) return { scope: 'no_domains' };
  if (fromDomains.length === 1 && toDomains.length === 1 && fromDomains[0] === toDomains[0]) return { scope: 'within_domain' };
  if (fromDomains.length === 0 || toDomains.length === 0 || fromDomains.length > 1 || toDomains.length > 1) {
    const which = [fromDomains.length !== 1 ? fromRelation : '', toDomains.length !== 1 ? toRelation : ''].filter(Boolean).join(' and ');
    return { refusal: { tier: 'relational', code: 'relationship_domain_unknown', message: `no certified relationship reaches ${toRelation} from ${fromRelation}, and ${which} ${which.includes(' and ') ? 'are' : 'is'} not bound to exactly one domain, so the warehouse was not asked to prove one; bind the relation to an entity in one domain, or declare and validate the relationship in Domain Studio`, repairable: false, relations: [fromRelation, toRelation] } };
  }
  return { refusal: { tier: 'relational', code: 'join_requires_domain_contract', message: `${fromRelation} (${fromDomains[0]}) and ${toRelation} (${toDomains[0]}) belong to different domains: a join across them needs a certified export from ${toDomains[0]}, a matching import in ${fromDomains[0]} with an allowed purpose, and a certified relationship; the warehouse is not asked to prove a cross-domain join`, repairable: false, relations: [fromRelation, toRelation] } };
}

/**
 * What a pinned envelope owns physically, and what each import carries: the
 * pinned domain with its ancestors and descendants, plus, per import
 * provider, the relations of the entities its matching exports name.
 */
/** The coverage evaluations of a receipt: UNSATISFIED words (a restriction the reading did not apply) warn; UNCERTAIN words (a lexical miss) inform. Neither is a passed check. */
/**
 * WHY A SEMANTIC ANSWER MAY NOT BE LABELLED GOVERNED. A question word the
 * reading left unused that names a thing, a field or a business term
 * ("premium" in "the total amount of premium", with a premium table on the
 * map), or a restriction the reading did not apply, means the governed
 * definitions answered a question near the one asked; so does a requested
 * identity label the answer could not carry. A word that names only a measure
 * is a choice between measures ("revenue including tax" is the order total, not
 * the pre-tax revenue metric), and the listed-facets check compares words
 * only, so neither decides the label.
 */
export function governedCoverageDoubt(receipt: Pick<PipelineReceipt, 'coverage' | 'unmet'>): { reasons: string[] } {
  const measureKinds = new Set(['metric', 'measure']);
  const words = (receipt.coverage ?? []).filter((item) => item.state === 'unsatisfied' || (item.names ?? []).some((kind) => !measureKinds.has(kind))).map((item) => `"${item.word}"`);
  const labels = (receipt.unmet ?? []).filter((unmet) => unmet.obligation === 'display_label').map((unmet) => unmet.message);
  return { reasons: [...words, ...labels] };
}

/**
 * The answer payload, the durable run and the UI badge carry ONE effective
 * trust decision. Route provenance (route, sourceTier, resolvedRoute) still
 * says where the answer came from when coverage downgrades a semantic
 * result, but no trust field may go on calling that result governed.
 */
export function effectiveAnsweredTrust(input: {
  certified: boolean;
  reviewRequired: boolean;
  coverageDoubt: boolean;
}): {
  trustState: 'certified' | 'governed' | 'review_required';
  certification: 'certified' | 'governed' | 'review_required';
  reviewStatus: 'certified' | 'governed' | 'review_required';
  stopReason: 'certified_answer_found' | 'governed_semantic_answer' | 'generated_review_required';
} {
  if (input.certified) return { trustState: 'certified', certification: 'certified', reviewStatus: 'certified', stopReason: 'certified_answer_found' };
  if (input.reviewRequired || input.coverageDoubt) return { trustState: 'review_required', certification: 'review_required', reviewStatus: 'review_required', stopReason: 'generated_review_required' };
  return { trustState: 'governed', certification: 'governed', reviewStatus: 'governed', stopReason: 'governed_semantic_answer' };
}

/**
 * The answer card's title, from the ONE trust decision and the source of the
 * figures. A certified block served as evidence is never headed "certified"
 * unless the run is, and nothing but SQL the AI wrote is headed AI-drafted:
 * the heading, the card, the run and the badge must say the same thing.
 */
export function answeredArtifactTitle(
  trustState: 'certified' | 'governed' | 'review_required',
  source: 'certified_block' | 'block_as_evidence' | 'governed_definitions' | 'ai_sql',
): string {
  if (trustState === 'certified') return 'Certified answer';
  if (source === 'ai_sql') return 'AI-drafted answer';
  if (source === 'block_as_evidence') return trustState === 'governed' ? 'Governed answer from a certified saved query' : 'Answer to review, from a certified saved query';
  return trustState === 'governed' ? 'Semantic answer' : 'Answer to review, from governed definitions';
}

export function coverageEvaluations(receipt: Pick<PipelineReceipt, 'uncovered' | 'coverage'>): Array<{ id: string; label: string; passed: boolean; severity: 'warning' | 'info'; message: string }> {
  if (!receipt.uncovered?.length) return [];
  const states = new Map((receipt.coverage ?? []).map((item) => [item.word, item.state]));
  const unsatisfied = receipt.uncovered.filter((word) => states.get(word) === 'unsatisfied');
  const uncertain = receipt.uncovered.filter((word) => states.get(word) !== 'unsatisfied');
  const quoted = (words: string[]) => words.map((word) => `"${word}"`).join(', ');
  return [
    ...(unsatisfied.length ? [{ id: 'pipeline-coverage', label: 'Question coverage', passed: false, severity: 'warning' as const, message: `The question restricts on ${quoted(unsatisfied)}, which this reading does not apply. Say the condition explicitly, or name the field it lives on.` }] : []),
    ...(uncertain.length ? [{ id: 'pipeline-coverage-uncertain', label: 'Question coverage', passed: false, severity: 'info' as const, message: `The question mentioned ${quoted(uncertain)}; this reading uses no field of that name, though it may cover it under another. If it was a condition or an output, say so explicitly.` }] : []),
  ];
}

const SCOPE_WORD_STOPWORDS = new Set(['what', 'which', 'show', 'give', 'list', 'have', 'with', 'from', 'that', 'this', 'each', 'many', 'much', 'total', 'both', 'need', 'please', 'could', 'would', 'should', 'about', 'their', 'there', 'than', 'then', 'into', 'over', 'using', 'calendar', 'season', 'year', 'top', 'five', 'rows', 'row', 'count', 'name', 'names', 'label', 'key', 'directory', 'facts', 'fact', 'table', 'column', 'dimension', 'defined', 'expected', 'specific', 'used', 'instead', 'grouping', 'vocabulary', 'exposes', 'only', 'more', 'than', 'one', 'way', 'read', 'governed', 'query', 'run', 'because', 'nearest']);

/**
 * Words of a question (or of the gap that answered it) that name an object
 * the whole inventory holds but this envelope does not — by exact name, and
 * only objects with a known owner. The explanation names the owner and what
 * admits it; nothing outside the scope is read.
 */
export function explainOutOfScopeWords(text: string, inventory: VocabularyIndex, scoped: VocabularyIndex, envelope: Pick<DomainContextEnvelope, 'activeDomain' | 'purpose'>): { message: string; refs: Array<{ ref: string; domain?: string }> } | undefined {
  const refs = new Map<string, { ref: string; domain?: string; word: string }>();
  for (const word of new Set(text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? [])) {
    if (SCOPE_WORD_STOPWORDS.has(word)) continue;
    for (const hit of inventory.lookup(word, { limit: 4, minScore: 0.97 })) {
      if (hit.matchedOn !== 'name' && hit.matchedOn !== 'alias') continue;
      if (scoped.get(hit.entry.ref)) continue; // in scope: not this explanation's business
      const entry = hit.entry;
      const relation = entry.physical?.relation ?? (entry.kind === 'column' ? entry.ref.slice(entry.ref.indexOf(':') + 1).split('.').slice(0, -1).join('.') : entry.kind === 'relation' ? entry.model : undefined);
      const owner = entry.domain ?? (relation ? inventory.get(`relation:${relation}`)?.domain : undefined);
      if (!owner || owner === envelope.activeDomain) continue;
      if (!refs.has(entry.ref)) refs.set(entry.ref, { ref: entry.ref, domain: owner, word });
      if (refs.size >= 3) break;
    }
    if (refs.size >= 3) break;
  }
  if (refs.size === 0) return undefined;
  const where = envelope.activeDomain ? `the ${envelope.activeDomain} scope${envelope.purpose ? ` for purpose ${envelope.purpose}` : ' (no purpose given)'}` : 'this scope';
  const named = [...refs.values()].map((item) => `"${item.word}" (${item.ref}, owned by ${item.domain})`).join(', ');
  return { message: `${named} ${refs.size === 1 ? 'is' : 'are'} modeled in the project but not in ${where}: ask with a purpose whose import carries it, or declare the import in Domain Studio. Nothing outside the scope was read.`, refs: [...refs.values()].map(({ ref, domain }) => ({ ref, ...(domain ? { domain } : {}) })) };
}

/**
 * A ref the interpreter named that the whole inventory holds but this
 * envelope does not: the explanation names the owning domain and what would
 * admit it (a purpose whose import carries it, or a declared import) — and
 * never the object's data. Returns nothing when the ref is truly unknown.
 */
export function explainOutOfScope(problems: Array<{ path: string; message: string }>, inventory: VocabularyIndex, envelope: Pick<DomainContextEnvelope, 'activeDomain' | 'purpose'>): { message: string; refs: Array<{ ref: string; domain?: string }> } | undefined {
  const refs: Array<{ ref: string; domain?: string }> = [];
  for (const problem of problems) {
    const match = /^(\S+) is not in the vocabulary/.exec(problem.message);
    if (!match) continue;
    const ref = match[1]!;
    // The model may spell an entry the inventory holds with the wrong kind and
    // a schema in front (`column:TRANSFORMED.team_directory.city` for
    // `dimension:team_directory.city`). Drop the kind, then try shorter dotted
    // tails down to two parts; a bare field name alone is never guessed.
    const suffixMatch = (): VocabularyEntry | undefined => {
      const path = ref.replace(/^[a-z_]+:/i, '').split('.');
      for (let start = 0; path.length - start >= 2; start += 1) {
        const found = inventory.resolve(path.slice(start).join('.'));
        if (found) return found;
      }
      return undefined;
    };
    const entry = inventory.get(ref) ?? inventory.resolve(ref) ?? suffixMatch();
    if (!entry) continue;
    const relation = entry.physical?.relation ?? (entry.kind === 'column' ? ref.slice(ref.indexOf(':') + 1).split('.').slice(0, -1).join('.') : undefined);
    const owner = entry.domain ?? (relation ? inventory.get(`relation:${relation}`)?.domain : undefined);
    refs.push({ ref, ...(owner ? { domain: owner } : {}) });
  }
  if (!refs.length) return undefined;
  const where = envelope.activeDomain ? `the ${envelope.activeDomain} scope${envelope.purpose ? ` for purpose ${envelope.purpose}` : ' (no purpose given)'}` : 'this scope';
  const named = refs.map((item) => `${item.ref}${item.domain ? ` (owned by ${item.domain})` : ''}`).join(', ');
  return { message: `${named} ${refs.length === 1 ? 'is' : 'are'} modeled in the project but not in ${where}: ask with a purpose whose import carries it, or declare the import in Domain Studio. Nothing outside the scope was read.`, refs };
}

/**
 * The projected vocabulary is a function of the base source AND of the whole
 * envelope selection. The purpose chooses which exports are imported, and a
 * different export is different physical context; a key that ignored it
 * served the previous purpose's provider relations to the next request.
 */
export function vocabularyViewKey(baseKey: string, envelope: Pick<DomainContextEnvelope, 'activeDomain' | 'purpose' | 'modelAreaId' | 'allowedImports' | 'descendants'>, pack: Pick<LocalContextPack, 'skills' | 'appliedHints' | 'eligible' | 'domainBriefing'>): string {
  const skillRefs = pack.skills.map((skill) => skill.qualifiedId ?? skill.id).sort().join(',');
  const hintIds = pack.appliedHints.map((hint) => hint.hintId).sort().join(',');
  const imports = envelope.allowedImports.map((item) => `${item.providerDomain}:${item.exportRef}@${item.purpose}`).sort().join(',');
  return [baseKey, pack.eligible?.fingerprint ?? 'ranked', skillRefs, hintIds, pack.domainBriefing?.domainId ?? '', envelope.activeDomain ?? '', envelope.purpose ?? '', envelope.modelAreaId ?? '', (envelope.descendants ?? []).join(','), imports].join('|');
}

export function projectionScopeFor(envelope: DomainContextEnvelope, manifest: DQLManifest | undefined): ProjectionScope | undefined {
  if (!envelope.activeDomain) return undefined;
  const own = [envelope.activeDomain, ...envelope.ancestors, ...(envelope.descendants ?? [])];
  const entities = manifest?.modeling?.entities ?? {};
  const relationOf = (entityRef: string, domain: string): string | undefined => {
    const entity = entities[entityRef] ?? Object.values(entities).find((item) => item.domain === domain && (item.localId === entityRef || item.id === entityRef || item.qualifiedId === entityRef));
    return entity ? normalizeRelationName(manifest?.dbtProvenance?.nodes[entity.dbtUniqueId]?.relation) : undefined;
  };
  const imports = envelope.allowedImports.map((item) => {
    const relations = Object.values(manifest?.modeling?.interfaces?.exports ?? {})
      .filter((exported) => exported.domain === item.providerDomain && [`${exported.domain}.${exported.localId}@${exported.version}`, `${exported.domain}.${exported.localId}`, exported.qualifiedId, exported.id].includes(item.exportRef))
      .flatMap((exported) => exported.entity ? [relationOf(exported.entity, exported.domain)] : [])
      .filter((relation): relation is string => Boolean(relation));
    return { providerDomain: item.providerDomain, relations };
  });
  return { own, imports };
}

/** Compatibility: the authorized path function alone. */
export function modelingJoinPaths(manifest: DQLManifest | undefined, quoteRelation: (relation: string) => string): (fromRelation: string, toRelation: string) => RelationalJoinStep[] | undefined {
  return modelingJoinGraph(manifest, quoteRelation).path;
}

/** Date cells become ISO instants so every consumer reads one calendar value. */
export function normalizeExecutedRow(row: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = Number.isFinite(value.getTime()) ? value.toISOString() : null;
      changed = true;
    } else out[key] = value;
  }
  return changed ? out : row;
}

type AskRouteContext = Parameters<AgentRouteExecutor>[0];
type AskEmittedRoute = Parameters<AskRouteContext['emit']>[0]['route'];
type AskPipelineRunInput = Parameters<typeof runAskPipeline>[0];

/** What one pipeline run keeps for its own receipt: drafting calls, checks and host steps. */
interface AskRunState {
  draftDispatches: Array<{ purpose: string; ms: number; reply?: string; promptChars?: number; at?: number; attempt?: number; /** Certified blocks the drafter was given as the team's approved computations. */ blocks?: string[]; label?: 'draft' | 'redraft' | 'fix' | 'retry_empty' | 'widen' | 'review' | 'revise'; outcome?: 'sql' | 'declined' | 'rejected' | 'error' | 'accepted' | 'revise' }>;
  // The checks drafted SQL was held to, recorded for the run views (the
  // notes sent back to the model are built separately and never from these).
  hostChecks: Array<{ id: 'stated_values' | 'required_filters' | 'join_fanout' | 'certified_joins' | 'catalog_columns' | 'read_only' | 'key_labels'; label: string; passed: boolean; message: string; attempt: number }>;
  /** The joins the last checked AI-written statement made, each with the Modeling relationship behind it (or none). */
  hostJoins?: LedgerJoin[];
  checkRound: number;
  steps: AskStoryStepV1[];
  onStep(step: AskStoryStepV1): void;
}

export interface AskScopeRunOptions {
  deadlineMs?: number;
  onStep?(step: AskStoryStepV1): void;
  /** An instruction for the reader, after the project's own guidance (Research reads a why-question for what it can measure). */
  guidance?: string;
}

/**
 * ONE REQUEST'S CONTEXT, OPENED ONCE. Ask reads a question and answers it in
 * one pipeline run. Research reads once and then runs several settled readings
 * over the same connection, vocabulary, engine and caches, each with its own
 * receipt.
 */
export interface AskRequestScope {
  request: AgentRunRequest;
  route: AskEmittedRoute;
  contextMs: number;
  /** What the project search found, for the caller's own story. */
  contextSteps: AskStoryStepV1[];
  vocabulary(): VocabularyIndex;
  semanticLayer(): SemanticLayer | undefined;
  /** The compiled project manifest the request was opened against. */
  manifest(): DQLManifest | undefined;
  hasConnection: boolean;
  /** The proven, policed reading of a question; nothing is prepared or executed. */
  read(question: string, options?: AskScopeRunOptions & { allowAiSql?: boolean }): Promise<PipelineOutcome>;
  /** A settled reading through every later stage of the pipeline. */
  runIntent(intent: AnalyticalIntentV1, options: AskScopeRunOptions & { allowAiSql: boolean; origin?: 'research_program' | 'source_run' }): Promise<PipelineOutcome>;
  /** One provider call on the run's ledger, for Research's own small prompts. */
  dispatch(purpose: 'research_select' | 'research_narrate', messages: AgentMessage[]): Promise<string>;
}

export interface AskPipelineHost {
  execute: AgentRouteExecutor;
  /** Open one request's context; a request without an AI model gets the blocked result instead. */
  openScope(context: AskRouteContext, options?: { route?: AskEmittedRoute }): Promise<{ scope: AskRequestScope } | { blocked: AgentRouteExecutorResult }>;
  /**
   * Every name the project itself uses (lower case): relations and their parts, their columns (from the manifest and
   * from the warehouse columns probed so far), metrics, measures, dimensions, entities, models and block outputs. A
   * trace read by someone other than the asker keeps an identifier only when it is one of these (host/trace-review.ts).
   */
  catalogNames(): Set<string>;
}

export function createAskPipelineRouteExecutor(deps: AskPipelineHostDeps): AgentRouteExecutor {
  return createAskPipelineHost(deps).execute;
}

export function createAskPipelineHost(deps: AskPipelineHostDeps): AskPipelineHost {
  let vocabularyCache: VocabularyCacheEntry | undefined;
  const preparationCache = new Map<string, PreparedCandidate>();

  // The warehouse completes only the relations this question is about.  Cache
  // entries are target-specific and short lived for partial/negative evidence:
  // a failed or bounded metadata page never becomes a permanent "missing"
  // claim after a role/catalog/configuration change.
  type ProbeCacheState = 'complete' | 'partial' | 'negative';
  type ProbeCacheEntry = { relation?: ProbedRelation; state: ProbeCacheState; expiresAt: number };
  // Cache one exact physical relation at a time. A wide table must not make
  // a narrow sibling partial (or vice versa), and negative warehouse evidence
  // must expire quickly because Snowflake deliberately conflates unavailable
  // and unauthorized objects in its error text.
  const probedColumns = new Map<string, ProbeCacheEntry>();
  const probeColumns = async (
    connection: ConnectionConfig | undefined,
    base: ReturnType<typeof buildVocabularySource>,
    snapshotId: string,
    requested?: string[],
    remainingMs?: number,
    signal?: AbortSignal,
  ): Promise<ProbedRelation[]> => {
    if (!connection) return [];
    // An explicit empty list probes nothing; only an absent list falls back to
    // the relations the metadata left without columns.
    const wanted = requested ?? relationsNeedingColumns(base);
    if (wanted.length === 0) return [];
    const cacheKey = (relation: string) => `${snapshotId}|${connectionKey(connection)}|${physicalRelationIdentity(relation)}`;
    const found: ProbedRelation[] = [];
    // BOUNDED: an information_schema lookup on a large warehouse can take
    // seconds per statement; the probe stops issuing statements once its
    // budget is spent and the metadata stands as it was for the rest. What
    // it did not describe is asked for by name, never assumed absent.
    const started = Date.now();
    const budgetMs = Math.max(0, Math.min(columnProbeBudgetMs(), remainingMs ?? columnProbeBudgetMs()));
    const budgetLeft = () => Math.max(0, budgetMs - (Date.now() - started));
    const remember = (raw: string, aggregate: ProbedRelation | undefined, state: ProbeCacheState) => {
      if (aggregate) {
        aggregate.columnCompleteness = state === 'complete' ? 'complete' : 'partial';
        if (state !== 'complete') aggregate.truncated = true;
        found.push(aggregate);
      }
      probedColumns.set(cacheKey(raw), {
        ...(aggregate ? { relation: aggregate } : {}),
        state,
        expiresAt: Date.now() + (state === 'complete' ? 15 * 60_000 : 60_000),
      });
    };
    const mergePage = (aggregate: ProbedRelation | undefined, page: ProbedRelation): ProbedRelation => {
      if (!aggregate) return { ...page, columns: [...page.columns] };
      const seenColumns = new Set(aggregate.columns.map((column) => column.name.toLowerCase()));
      for (const column of page.columns) if (!seenColumns.has(column.name.toLowerCase())) {
        aggregate.columns.push(column);
        seenColumns.add(column.name.toLowerCase());
      }
      aggregate.binding = page.binding ?? aggregate.binding;
      aggregate.observedAt = page.observedAt ?? aggregate.observedAt;
      return aggregate;
    };
    // Which requested spelling a returned page answers (the batch may hold several).
    // Names only, case-insensitive, quote state ignored: the warehouse answered
    // for the object this request named, whether provenance spelled it
    // `"db"."schema"."table"` or the request said `DB.SCHEMA.TABLE`.
    const loose = (parts: Array<string | undefined>) => parts.filter(Boolean).map((part) => part!.toLowerCase()).join('.');
    const pageOwner = (page: ProbedRelation, candidates: string[]): string | undefined => {
      const named = loose([page.database, page.schema, page.name]);
      const tail = loose([page.schema, page.name]);
      const values = (raw: string) => parsePhysicalIdentifier(raw).map((part) => part.value);
      return candidates.find((raw) => loose(values(raw)) === named)
        ?? candidates.find((raw) => loose(values(raw).slice(-2)) === tail);
    };
    const pending: string[] = [];
    for (const raw of wanted) {
      if (!probeIdentifier(raw)) continue;
      const cached = probedColumns.get(cacheKey(raw));
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.relation) found.push(cached.relation);
        continue;
      }
      pending.push(raw);
    }
    if (pending.length === 0) return found;
    // ONE statement for every relation this question needs (they are a
    // handful), then further pages only for a relation wider than a page. The
    // earlier shape issued one round trip per relation, and each metadata
    // statement on a large warehouse is seconds.
    const aggregates = new Map<string, ProbedRelation>();
    const settled = new Set<string>();
    const runPage = async (relations: string[], offset: number): Promise<ProbedRelation[] | undefined> => {
      if (signal?.aborted || budgetLeft() <= 0) return undefined;
      const sql = relationColumnsProbeSql(relations, Math.max(relations.length, 1), offset, connection.driver, connection.location);
      if (!sql) return [];
      const result = await deps.executor.executeQuery(sql, [], {}, connection, {
        ...(signal ? { signal } : {}),
        deadlineMs: budgetLeft(),
      });
      const rows = (result.rows ?? []) as Array<Record<string, unknown>>;
      return underAskedNames(relationsFromProbeRows(rows, true, offset), relations);
    };
    // SNOWFLAKE FAST PATH: `SHOW COLUMNS IN <table>` is a metadata command
    // answered in milliseconds, where `information_schema.columns` scans every
    // column of the database and is the statement that spent the whole probe
    // budget on the office warehouse. It answers one relation completely; a
    // relation it cannot describe falls through to the information_schema
    // batch below, so nothing is lost when the command is refused.
    if (connection.driver.toLowerCase() === 'snowflake') {
      for (const raw of [...pending]) {
        if (signal?.aborted || budgetLeft() <= 0) break;
        const identifier = probeIdentifier(raw);
        if (!identifier) continue;
        try {
          const target = [identifier.database, identifier.schema, identifier.table].filter((part): part is PhysicalIdentifierPartV1 => Boolean(part)).map(probeSegment).join('.');
          const result = await deps.executor.executeQuery(`SHOW COLUMNS IN ${target}`, [], {}, connection, { ...(signal ? { signal } : {}), deadlineMs: budgetLeft() });
          const rows = snowflakeShowColumnsRows((result.rows ?? []) as Array<Record<string, unknown>>);
          if (rows.length === 0) continue;
          const page = underAskedNames(relationsFromProbeRows(rows, true, 0), [raw])[0];
          if (!page) continue;
          remember(raw, mergePage(undefined, page), 'complete');
          settled.add(raw);
          pending.splice(pending.indexOf(raw), 1);
        } catch { /* described by the batch below */ }
      }
      if (pending.length === 0) return found;
    }
    let firstPage: ProbedRelation[] | undefined;
    try {
      firstPage = await runPage(pending.slice(0, 8), 0);
    } catch {
      // Stale catalog metadata, a different current database or a role
      // change: keep the negative evidence short-lived and never turn it into
      // proof that the object is absent.
      firstPage = undefined;
    }
    if (firstPage === undefined) {
      for (const raw of pending) remember(raw, undefined, 'negative');
      return found;
    }
    for (const page of firstPage) {
      const owner = pageOwner(page, pending);
      if (!owner) continue;
      aggregates.set(owner, mergePage(aggregates.get(owner), page));
      if (page.columnCompleteness === 'complete') { remember(owner, aggregates.get(owner), 'complete'); settled.add(owner); }
    }
    for (const raw of pending) {
      if (settled.has(raw)) continue;
      let aggregate = aggregates.get(raw);
      if (!aggregate) { remember(raw, undefined, 'negative'); continue; }
      let offset = aggregate.columns.length;
      let state: ProbeCacheState = 'partial';
      // A relation wider than one page: keep paging this one alone while the budget lasts.
      while (true) {
        let page: ProbedRelation[] | undefined;
        try { page = await runPage([raw], offset); } catch { page = undefined; }
        if (page === undefined) { state = 'partial'; break; }
        const own = page[0];
        if (!own || own.columns.length === 0) { state = 'partial'; break; }
        aggregate = mergePage(aggregate, own);
        if (own.columnCompleteness === 'complete') { state = 'complete'; break; }
        offset += own.columns.length;
      }
      remember(raw, aggregate, state);
    }
    return found;
  };
  type VocabularyView = { vocabulary: VocabularyIndex; context?: NonNullable<Parameters<typeof runAskPipeline>[0]['context']>; envelope: DomainContextEnvelope; pack?: LocalContextPack; /** The request's projected source: the relations this envelope admits. Table choice for drafted SQL reads this, never the whole project. */ source?: VocabularySource };
  let viewCache: { key: string; view: VocabularyView } | undefined;

  /** The request's scope, resolved server-side from what the surface sent; never from client-supplied ancestors or imports. */
  const resolveAskEnvelope = (request: AgentRunRequest): DomainContextEnvelope => {
    const { manifest, snapshotId } = deps.getManifest();
    // The four selections every surface carries (CTX-001), read the one way.
    const scope = askScopeFromWorkspace(request.workspaceContext);
    const empty: DomainContextEnvelope = { activeDomain: null, ancestors: [], descendants: [], allowedImports: [], source: 'inferred', confidence: 'low', snapshotId };
    if (!manifest) return empty;
    try {
      return resolveDomainContextEnvelope({
        manifest, activeDomain: scope.domain ?? null, purpose: scope.purpose, modelAreaId: scope.modelAreaId, skillRefs: scope.skillRefs,
        source: scope.domain ? 'explicit_ui' : 'inferred', snapshotId,
      });
    } catch {
      // An unknown domain or area is not a reason to answer unscoped: the
      // request keeps no-domain scope and the envelope says so.
      return empty;
    }
  };

  /** The whole inventory as an index, for explaining a ref outside this envelope. Cached with the base source. */
  let baseIndexCache: { key: string; index: VocabularyIndex } | undefined;
  const baseIndexFor = async (connection?: ConnectionConfig): Promise<VocabularyIndex> => {
    const { key, source } = await baseSourceFor(connection);
    if (baseIndexCache?.key !== key) baseIndexCache = { key, index: buildVocabularyIndex(source) };
    return baseIndexCache.index;
  };
  const sourceInputFor = (connection: ConnectionConfig | undefined, relations?: ProbedRelation[]): VocabularySourceInput => {
    const { manifest, snapshotId } = deps.getManifest();
    const layer = deps.getSemanticLayer();
    return {
      ...(layer ? { semanticLayer: layer } : {}),
      ...(manifest ? { manifest } : {}),
      ...(connection?.driver ? { driver: connection.driver } : {}),
      ...(connection?.database ?? connection?.catalog ? { defaultDatabase: connection?.database ?? connection?.catalog } : {}),
      snapshotId,
      ...(connection ? { executionTargetFingerprint: fingerprintText(connectionKey(connection)) } : {}),
      relations: [...embeddedManifestRelations(manifest, deps.projectRoot), ...(relations ?? [])],
    };
  };
  /** The base source: everything the host can bind physically, per snapshot and connection. Cached; the pack projects it per request. */
  const baseSourceFor = async (connection?: ConnectionConfig): Promise<{ key: string; source: VocabularySource }> => {
    const { snapshotId } = deps.getManifest();
    const layer = deps.getSemanticLayer();
    const key = `${snapshotId}|${layer ? layer.listCubes().map((cube) => cube.name).join(',') : 'no-semantic'}|${connection ? connectionKey(connection) : 'no-connection'}`;
    if (vocabularyCache?.key === key) return { key, source: vocabularyCache.source };
    const source = buildVocabularySource(sourceInputFor(connection));
    vocabularyCache = { key, source };
    return { key, source };
  };

  /**
   * THE VOCABULARY IS A VIEW OVER THE PACK (CTX-010). The envelope decides
   * eligibility, the pack admits the complete eligible set and selects the
   * skills and hints for this question, and the host's base source supplies
   * the physical bindings; the view is their projection. Without a pack (no
   * host builder, or a snapshot that could not be opened) the base source is
   * served whole and the ledger says no envelope was applied.
   */
  // A source rebuilt with this question's discovered columns, kept for the
  // next question about the same relations (the base is cached above; a
  // rebuild is a few hundred milliseconds at 5,000 relations, but not free).
  const discoveredSourceCache = new Map<string, VocabularySource>();
  const vocabularyFor = async (request: AgentRunRequest, connection?: ConnectionConfig): Promise<VocabularyView> => {
    // Where the context time goes, phase by phase: the office trace reads it.
    const phases: Record<string, number> = {};
    const timed = async <T>(phase: string, work: () => Promise<T> | T): Promise<T> => {
      const started = Date.now();
      try { return await work(); } finally { phases[phase] = (phases[phase] ?? 0) + (Date.now() - started); }
    };
    const envelope = resolveAskEnvelope(request);
    const { key: baseKey, source: base } = await timed('base', () => baseSourceFor(connection));
    const remaining = request.runBudget?.remainingMs();
    const relevant = await timed('relevance', () => relevantRelationsForQuestion(base, request.question, 3));
    const discovered = await timed('probe', () => probeColumns(connection, base, envelope.snapshotId, relevant, remaining, request.signal));
    const key = `${baseKey}|discovery:${discovered.map((relation) => `${relation.database ?? ''}.${relation.schema ?? ''}.${relation.name}:${relation.columns.length}:${relation.columnCompleteness ?? 'unknown'}`).join(',')}`;
    const source = discovered.length
      ? await timed('source', () => {
        const cached = discoveredSourceCache.get(key);
        if (cached) return cached;
        const rebuilt = buildVocabularySource(sourceInputFor(connection, discovered));
        if (discoveredSourceCache.size >= 8) discoveredSourceCache.delete(discoveredSourceCache.keys().next().value!);
        discoveredSourceCache.set(key, rebuilt);
        return rebuilt;
      })
      : base;
    let pack: LocalContextPack | undefined;
    try { pack = await timed('pack', () => deps.buildContextPack?.(request, envelope)); } catch { pack = undefined; }
    if (pack?.appliedHints?.length) {
      const relevant = hintsForQuestion(pack.appliedHints, request.question);
      if (relevant.length !== pack.appliedHints.length) pack = { ...pack, appliedHints: relevant };
    }
    const admitted = deps.admitSources;
    if (!pack) {
      const allowedSource = admitted ? await timed('access', () => admitted.admit(source)) : source;
      const vocabulary = await timed('index', () => buildVocabularyIndex(allowedSource));
      return { vocabulary, envelope, source: allowedSource, context: { envelope: ledgerEnvelope(envelope), admitted: { byKind: countKinds(vocabulary) }, timings: phases } };
    }
    const viewKey = `${vocabularyViewKey(key, envelope, pack)}${admitted ? `|access:${admitted.key()}` : ''}`;
    const unfiltered = await timed('projection', () => projectVocabularySource(source, pack!, projectionScopeFor(envelope, deps.getManifest().manifest)));
    const projected = admitted ? { ...unfiltered, source: await timed('access', () => admitted.admit(unfiltered.source)) } : unfiltered;
    const vocabulary = viewCache?.key === viewKey ? viewCache.view.vocabulary : await timed('index', () => buildVocabularyIndex(projected.source));
    const rankedRefs = rankedRefsFromPack(pack.objects);
    const lanes: Record<string, number> = {};
    for (const [lane, result] of Object.entries(pack.retrievalDiagnostics.fusion?.lanes ?? {})) lanes[lane] = result.returned;
    const relationsTotal = pack.eligible ? Object.entries(pack.eligible.counts).filter(([type]) => type === 'dbt_model' || type === 'dbt_source' || type === 'warehouse_table').reduce((sum, [, count]) => sum + count, 0) : (projected.source.relations?.length ?? 0);
    const relationsWithColumns = (projected.source.relations ?? []).filter((relation) => relation.columns.length > 0).length;
    const view: VocabularyView = {
      vocabulary, envelope, pack, source: projected.source,
      context: {
        packId: pack.id, snapshotId: envelope.snapshotId, envelope: ledgerEnvelope(envelope),
        retrieved: { lanes, fused: pack.retrievalDiagnostics.fusion?.selectedKeys.length ?? pack.objects.length },
        // Counted on the built index, so columns and the request overlay (skills, hints) are in the number the answer quotes.
        admitted: { byKind: countKinds(vocabulary), ...(Object.keys(projected.dropped).length ? { dropped: projected.dropped } : {}), ...(Object.keys(projected.unindexed).length ? { unindexed: projected.unindexed } : {}), ...(pack.eligible ? { eligibleFingerprint: pack.eligible.fingerprint } : {}) },
        rankedRefs, ...(projected.source.domain ? { header: projected.source.domain } : {}),
        columnsFor: { shown: relationsWithColumns, total: Math.max(relationsTotal, relationsWithColumns) },
        timings: phases,
      },
    };
    viewCache = { key: viewKey, view };
    const vocabularyDumpPath = readEnv('ZLENS_ASK_PIPELINE_DUMP_VOCABULARY');
    if (vocabularyDumpPath) {
      try { writeFileSync(vocabularyDumpPath, `${vocabulary.renderCards({ maxChars: 1_000_000 })}\n`); } catch { /* debug only */ }
    }
    return view;
  };
  const ledgerEnvelope = (envelope: DomainContextEnvelope): NonNullable<ContextLedgerV1['envelope']> => ({
    activeDomain: envelope.activeDomain, ancestors: envelope.ancestors, descendants: envelope.descendants ?? [], allowedImports: envelope.allowedImports.length,
    ...(envelope.purpose ? { purpose: envelope.purpose } : {}), ...(envelope.modelAreaId ? { modelAreaId: envelope.modelAreaId } : {}), ...(envelope.skillRefs ? { skillRefs: envelope.skillRefs } : {}),
    source: envelope.source, confidence: envelope.confidence,
  });
  const countKinds = (vocabulary: VocabularyIndex): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const entry of vocabulary.entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    return counts;
  };

  // A relationship the warehouse proved holds for as long as the snapshot and
  // the connection do; proving it twice would ask the same question twice.
  const provenJoins = new Map<string, Map<string, { steps: RelationalJoinStep[]; expiresAt: number; generationToken?: string }>>();
  const prepareDeps = (connection: ConnectionConfig, vocabulary: VocabularyIndex | (() => VocabularyIndex), engine?: PrepareDeps['engine'], signal?: AbortSignal): PrepareDeps => {
    const currentVocabulary = () => typeof vocabulary === 'function' ? vocabulary() : vocabulary;
    const layer = deps.getSemanticLayer();
    /**
     * The semantic runtime must compile against the exact relation Ask has
     * admitted for this request.  Do not hand it the project-default runtime
     * snapshot: that snapshot can describe DB_A while this Ask run discovered
     * DB_B.  Where one logical semantic table has multiple physical bindings,
     * select only a single complete target-bound observation; otherwise leave
     * the table unmapped and let the semantic engine report the ambiguity.
     */
    const semanticCompileContext = (semanticRequest: SemanticCompileRequest): AskSemanticCompileContext => {
      const current = currentVocabulary();
      const target = fingerprintText(connectionKey(connection));
      const relationBindings = current.entries
        .filter((entry) => entry.kind === 'relation' && entry.physical?.binding)
        .map((entry) => entry.physical!.binding!)
        .filter((binding, index, all) => all.findIndex((candidate) => physicalRelationIdentity(physicalRelationText(candidate)) === physicalRelationIdentity(physicalRelationText(binding))) === index)
        // A binding acquired for another execution identity is not evidence
        // for this connection, even if its table tail looks identical.
        .filter((binding) => binding.executionTargetFingerprint === target);
      const requestedNames = new Set([
        ...semanticRequest.metrics,
        ...semanticRequest.dimensions,
        ...(semanticRequest.filters?.flatMap((filter) => filter.dimension ? [filter.dimension] : []) ?? []),
        ...(semanticRequest.timeDimension ? [semanticRequest.timeDimension.name] : []),
      ].map((name) => name.toLowerCase()));
      const namesDefinition = (name: string, table?: string) => requestedNames.has(name.toLowerCase())
        || (table ? requestedNames.has(`${table}.${name}`.toLowerCase()) : false)
        || [...requestedNames].some((requested) => requested.endsWith(`.${name.toLowerCase()}`));
      const semanticTables = new Set<string>();
      for (const metric of layer?.listMetrics() ?? []) {
        if (!namesDefinition(metric.name, metric.table)) continue;
        if (metric.table) semanticTables.add(metric.table);
        else {
          const measureName = (metric as { typeParams?: { measure?: { name?: string } } }).typeParams?.measure?.name;
          const measure = measureName ? layer?.listMeasures().find((candidate) => candidate.name === measureName) : undefined;
          if (measure?.table) semanticTables.add(measure.table);
        }
      }
      for (const measure of layer?.listMeasures() ?? []) if (namesDefinition(measure.name, measure.table) && measure.table) semanticTables.add(measure.table);
      for (const dimension of layer?.listDimensions(undefined, { includeVariants: true }) ?? []) if (namesDefinition(dimension.name, dimension.table) && dimension.table) semanticTables.add(dimension.table);

      const suffixMatches = (logical: string, semanticTable: string): boolean => {
        const logicalParts = parsePhysicalIdentifier(logical);
        const semanticParts = parsePhysicalIdentifier(semanticTable);
        if (logicalParts.length === 0 || semanticParts.length === 0 || logicalParts.length < semanticParts.length) return false;
        return semanticParts.every((part, index) => {
          const candidate = logicalParts[logicalParts.length - semanticParts.length + index]!;
          const render = (value: PhysicalIdentifierPartV1) => value.quoted ? `"${value.value.replace(/"/g, '""')}"` : value.value;
          return physicalRelationIdentity(render(candidate)) === physicalRelationIdentity(render(part));
        });
      };
      const selected = new Map<string, PhysicalRelationBindingV1>();
      // Bindings already attached to an admitted semantic entry are the most
      // specific proof. They take precedence over logical-name inference.
      for (const entry of current.entries) {
        if (!entry.physical?.binding || !['metric', 'measure', 'dimension', 'entity'].includes(entry.kind)) continue;
        const table = entry.model;
        if (!namesDefinition(entry.sourceId ?? entry.name, table)) continue;
        const binding = entry.physical.binding;
        if (binding.executionTargetFingerprint === target) selected.set(physicalRelationIdentity(physicalRelationText(binding)), binding);
      }
      for (const semanticTable of semanticTables) {
        const candidates = relationBindings.filter((binding) => suffixMatches(binding.logicalRelation, semanticTable));
        const complete = candidates.filter((binding) => binding.columnCompleteness === 'complete');
        const choice = complete.length === 1 ? complete[0] : candidates.length === 1 ? candidates[0] : undefined;
        // More than one complete DB/schema/table is an actual ambiguity. Do
        // not turn a suffix match into a default-database selection.
        if (choice) selected.set(physicalRelationIdentity(physicalRelationText(choice)), choice);
      }
      return {
        snapshotId: deps.getManifest().snapshotId,
        executionTargetFingerprint: target,
        vocabulary: current,
        physicalBindings: [...selected.values()],
      };
    };
    const provenScope = `${deps.getManifest().snapshotId}|${connectionKey(connection)}`;
    if (!provenJoins.has(provenScope)) provenJoins.set(provenScope, new Map());
    const provenJoinPath = provenJoins.get(provenScope)!;
    const dialect = getDialect(connection.driver);
    const relationOfCube = new Map<string, string>();
    const cubeOfRelation = new Map<string, string>();
    for (const cube of layer?.listCubes() ?? []) {
      const relation = normalizeRelationName(cube.table) ?? cube.name;
      relationOfCube.set(cube.name, relation);
      cubeOfRelation.set(relation, cube.name);
    }
    // A physical name as the warehouse knows it (Snowflake folds unquoted
    // names; dbt creates them unquoted), an alias as this program mints it.
    const quotePhysical = (name: string) => renderPhysicalIdentifier(name, connection.driver, (value) => dialect.quoteIdentifier(value));
    const databases = relationDatabases(deps.getManifest().manifest);
    const bindingForRelation = (relation: string) => {
      const candidates = currentVocabulary().entries
        .filter((entry) => entry.kind === 'relation' && (entry.model === relation || entry.physical?.binding?.logicalRelation === relation || entry.physical?.binding?.aliases?.includes(relation)))
        .map((entry) => entry.physical?.binding)
        .filter((binding): binding is NonNullable<typeof binding> => Boolean(binding));
      const exact = new Map(candidates.map((binding) => [physicalRelationText(binding), binding]));
      return exact.size === 1 ? [...exact.values()][0] : undefined;
    };
    const quoteRelation = (relation: string) => {
      const binding = bindingForRelation(relation);
      const physical = binding ? physicalRelationText(binding) : physicalRelationName(relation, databases, connection.driver);
      return renderPhysicalRelation(physical, connection.driver, (value) => dialect.quoteIdentifier(value));
    };
    const joinGraph = modelingJoinGraph(deps.getManifest().manifest, quoteRelation);
    const semanticJoinPath = (fromRelation: string, toRelation: string): RelationalJoinStep[] | undefined => {
      if (!layer) return undefined;
      const from = cubeOfRelation.get(fromRelation);
      const to = cubeOfRelation.get(toRelation);
      if (!from || !to) return undefined;
      const path = layer.findJoinPath(from, to);
      if (path.length === 0) return undefined;
      return path.map((join) => {
        const left = relationOfCube.get(join.left) ?? join.left;
        const right = relationOfCube.get(join.right) ?? join.right;
        // The compiler owns this join (REL-002 source one): the ledger says so
        // instead of calling it a declared edge of unknown authority.
        const domains = { from: joinGraph.domainsOf(left), to: joinGraph.domainsOf(right) };
        const authority: JoinAuthorityV1 = {
          version: 1, from: left, to: right, keys: [], source: 'semantic_layer', authority: 'certified',
          scope: !joinGraph.hasDomains ? 'no_domains' : domains.from.length === 1 && domains.to.length === 1 && domains.from[0] === domains.to[0] ? 'within_domain' : 'cross_domain_certified',
          domains, snapshotId: deps.getManifest().snapshotId,
        };
        return { relation: right, on: join.sql.replace(/\$\{left\}/g, quoteRelation(left)).replace(/\$\{right\}/g, quoteRelation(right)), authority };
      });
    };
    const declaredJoinPath = joinGraph.path;
    const sessionProvenPath = (fromRelation: string, toRelation: string): RelationalJoinStep[] | undefined => {
      const prefix = `${fromRelation}->${toRelation}|`;
      const now = Date.now();
      for (const [key, entry] of provenJoinPath) if (key.startsWith(prefix) && entry.expiresAt > now) return entry.steps;
      return undefined;
    };
    return {
      ...(layer ? {
        compileSemantic: (request) => deps.compileSemantic({ ...request, ...(signal ? { signal } : {}) }, connection, semanticCompileContext(request)),
        // Different periods are separate MetricFlow/dbt semantic requests, but
        // every branch retains the same selected adapter, connection and
        // cancellation signal.  The host returns executable SQL per branch;
        // the pipeline aligns rows only after the engine has produced them.
        compileSemanticProgram: async (program) => {
          let selectedEngine: string | undefined;
          const branches: typeof program.branches = [];
          for (const branch of program.branches) {
            if (signal?.aborted) throw new Error('the semantic execution program was cancelled before every period compiled');
            const branchRequest = { ...branch.request, ...(signal ? { signal } : {}) };
            const compiled = await deps.compileSemantic(branchRequest, connection, semanticCompileContext(branchRequest));
            if (selectedEngine && selectedEngine !== compiled.engine) {
              throw new Error(`semantic execution program selected more than one adapter (${selectedEngine}, ${compiled.engine}); all periods must compile on one target`);
            }
            selectedEngine = compiled.engine;
            branches.push({ ...branch, sql: compiled.sql, engine: compiled.engine });
          }
          if (!selectedEngine) throw new Error('the semantic execution program had no compiled branches');
          return {
            // `executeCandidate` executes branches, not this marker. Keeping a
            // deterministic SQL fingerprint retains existing receipts/caches.
            sql: branches.map((branch) => `-- ${branch.id}\n${branch.sql ?? ''}`).join('\n'),
            engine: selectedEngine,
            program: { ...program, branches },
            strategy: `${branches.length} bounded semantic period branches`,
          };
        },
      } : {}),
      // Joins over raw tables are the AI's to write (preferred joins are hints
      // in its context); no tier here composes, proves or authorizes a join.
      dialect: { quoteIdentifier: (name) => dialect.quoteIdentifier(name), quotePhysical, qualifyRelation: quoteRelation, dateTrunc: (grain, expr) => dialect.dateTrunc(grain, expr), limitClause: (limit) => dialect.limitClause(limit) },
      blockSql: (ref) => currentVocabulary().get(ref)?.sql,
      prepareBlock: (ref, context) => prepareBlockForAsk(deps.projectRoot, currentVocabulary().get(ref), context, connection?.driver),
      ...(engine ? { engine } : {}),
    };
  };

  const openRequest = async (
    { runId, request, emit }: AskRouteContext,
    options: { route?: AskEmittedRoute } = {},
  ): Promise<{ blocked: AgentRouteExecutorResult } | { scope: AskRequestScope; answer: () => Promise<AgentRouteExecutorResult> }> => {
    const route: AskEmittedRoute = options.route ?? 'generated_answer';
    const startedAt = Date.now();
    const provider = await deps.selectProvider(request);
    if (!provider) {
      // No model ran: the run says so (`providerMissing`), so nothing labels it AI-generated (round 3).
      return { blocked: failure(runId, 'No AI model is configured for this project, so the question could not be interpreted.', 'provider_error', startedAt, { providerMissing: true }) };
    }
    const scopeMessage = askScopeProblem(deps.getManifest().manifest, request.workspaceContext, deps.getManifest().snapshotId);
    if (scopeMessage) return { blocked: scopeFailure(runId, scopeMessage, startedAt) };
    // A question that names a block Ask does not answer from (a draft, a
    // retired block, a certified block whose metadata contradicts itself) is
    // told so at once, by name, with what to do. It is never sent on to
    // AI-written SQL that treats the block's name as values to filter on.
    // Where the host restricts which sources a person may see, a block's
    // existence is not disclosed here.
    const notServed = deps.admitSources ? undefined : namedBlockNotServed(request.question, deps.getManifest().manifest);
    if (notServed) return { blocked: namedBlockFailure(runId, notServed, startedAt) };
    // Interpretation never needs a warehouse: a greeting, a definition, a
    // clarification or a modeling gap is answered without one. A missing
    // connection surfaces verbatim at the first execution instead.
    let connection: ConnectionConfig | undefined;
    let connectionError: unknown;
    emit({ type: 'executor.started', message: 'Assembling the governed context for this question.', route });
    const contextStarted = Date.now();
    try {
      connection = await deps.resolveConnection(request);
    } catch (error) {
      connectionError = error;
    }
    const view = await vocabularyFor(request, connection);
    const contextMs = Date.now() - contextStarted;
    const vocabulary = view.vocabulary;
    // Discovery may hydrate a relation after the first interpretation. Keep
    // one request-local pointer so every later consumer (prepare, final SQL
    // validation, execution evidence and receipt) reads the same bindings.
    let requestVocabulary = vocabulary;
    const currentVocabulary = () => requestVocabulary;
    const priorTurn = request.threadId ? await deps.priorIntent(request) : undefined;
    // The thread's compacted memory, read once for this run (a host store answers with a Promise).
    const threadMemory = await deps.conversation?.(request);
    // RFC 0010 HH-5: an earlier answer's text and the thread's memory carry its figures. They reach this model only
    // inside the privacy boundary; otherwise the reading and the drafter get the earlier reading and its SQL (what
    // was asked and how it was answered), never what it found.
    const valuesAllowed = deps.valuesMayReachModel
      ? await Promise.resolve().then(() => deps.valuesMayReachModel!(request, provider)).then((allowed) => allowed === true, () => false)
      : true;
    const prior = valuesAllowed || !priorTurn ? priorTurn : { ...priorTurn, summary: undefined };
    const conversationMemory = valuesAllowed ? threadMemory : undefined;
    // Outside the boundary, the earlier reading's values (a member as typed, or as the warehouse stores it) and its
    // SQL's literals are values too: the model reads them named by position, and gets them back in what it writes.
    const priorMask = !valuesAllowed && priorTurn ? priorWithoutValues(priorTurn.intent, priorTurn.sql ? sqlStringValues(priorTurn.sql) : []) : undefined;
    const shownToModel = (text: string): string => (priorMask ? priorMask.maskText(text) : text);
    let engine: PrepareDeps['engine'];
    try { engine = await deps.semanticEngine?.(); } catch { engine = undefined; }
    // The context is assembled BEFORE the first model call; a run that ends
    // in this phase must show where its time went, so the assembly is an event.
    const phaseSummary = Object.entries(view.context?.timings ?? {}).filter(([, ms]) => ms >= 50).map(([phase, ms]) => `${phase} ${ms} ms`).join(' · ');
    // THE RUN'S STORY. Steps the host takes (the search, the tables the
    // drafter chose) stream beside the pipeline's own and are kept on the
    // receipt in order, so a finished answer can replay how it was reached.
    const liveStep = (step: AskStoryStepV1) => emit({ type: 'executor.started', message: step.title, route, payload: { askStep: step } });
    const stepFor = (state: AskRunState) => (entry: Omit<AskStoryStepV1, 'version' | 'at'>) => {
      const full: AskStoryStepV1 = { version: 1, at: Date.now(), ...entry };
      state.steps.push(full);
      state.onStep(full);
    };
    const newRunState = (onStep: (step: AskStoryStepV1) => void = liveStep): AskRunState => ({ draftDispatches: [], hostChecks: [], checkRound: 0, steps: [], onStep });
    // Ask's one run shares the request's state: its story starts with the context step.
    const requestState = newRunState();
    const hostSteps = requestState.steps;
    const hostStep = stepFor(requestState);
    {
      const counts = new Map<string, number>();
      for (const entry of vocabulary.entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
      const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
      const found = [
        counts.get('block') ? plural(counts.get('block')!, 'certified saved query', 'certified saved queries') : '',
        (counts.get('metric') ?? 0) + (counts.get('measure') ?? 0) ? plural((counts.get('metric') ?? 0) + (counts.get('measure') ?? 0), 'metric', 'metrics') : '',
        counts.get('dimension') ? plural(counts.get('dimension')!, 'dimension', 'dimensions') : '',
        counts.get('relation') ? plural(counts.get('relation')!, 'table', 'tables') : '',
        counts.get('column') ? plural(counts.get('column')!, 'column', 'columns') : '',
        counts.get('term') ? plural(counts.get('term')!, 'business term', 'business terms') : '',
      ].filter(Boolean).join(', ');
      hostStep({ phase: 'context', title: `Searched the project: ${found || 'no governed objects in scope'}`, state: found ? 'done' : 'missed', ms: contextMs, ...(phaseSummary ? { detail: phaseSummary } : {}) });
    }
    emit({ type: 'executor.started', message: `Context assembled in ${contextMs} ms: ${vocabulary.entries.length} governed objects${engine ? ` · semantic engine ${engine}` : ''}${phaseSummary ? ` (${phaseSummary})` : ''}.`, route });
    emit({ type: 'executor.started', message: prior ? 'Reading the question as an edit of the previous analysis.' : 'Reading the question against the governed vocabulary.', route });
    const ledgered = withLedger(provider, deps, request);
    // ON-DEMAND DESCRIPTION: a relation the reading names whose columns the
    // bounded probe never reached is described now, for this one run.
    const describeRelations = async (relations: string[]) => {
      if (!connection) return [];
      const { source } = await baseSourceFor(connection);
      const remaining = request.runBudget?.remainingMs();
      // Up to five: the drafter may choose tables from the reading, the question
      // and the conversation, and a table it cannot describe cannot be drafted over.
      return probeColumns(connection, source, deps.getManifest().snapshotId, relations.slice(0, 5), remaining, request.signal);
    };
    // THE LAST TIER'S DRAFT: one read-only statement from the reading and the
    // admitted relations and columns, validated against the catalog before
    // the tier may even consider it. Review-required by construction.
    const makeDraftSql = (state: AskRunState): NonNullable<PrepareDeps['draftSql']> => async ({ question, intent, vocabulary: initial, reason, previous }) => {
      const hostStep = stepFor(state);
      let current = initial;
      const refs = intent ? [...intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]), ...intent.groupBy.map((group) => group.ref), ...intent.display, ...intent.filters.map((filter) => filter.ref), ...(intent.time?.ref ? [intent.time.ref] : [])] : [];
      const relationOf = (ref: string): string | undefined => {
        const entry = current.get(ref) ?? current.resolve(ref);
        if (entry) return entryPhysicalRelation(entry);
        // A ref the governed vocabulary rejected still names a table: the part
        // before the column, matched on its last two parts.
        const path = ref.replace(/^[a-z_]+:/i, '').split('.');
        if (path.length < 3) return undefined;
        const tail = path.slice(-3, -1).join('.').toLowerCase();
        const relation = current.entries.find((item) => item.kind === 'relation' && [item.model ?? '', ...item.aliases, ...(item.physical?.binding?.aliases ?? [])].some((name) => name.toLowerCase() === tail || name.toLowerCase().endsWith(`.${tail}`)));
        return relation ? entryPhysicalRelation(relation) : undefined;
      };
      const text = ` ${question} ${intent?.reading ?? ''} `.toLowerCase();
      const named = current.entries
        .filter((entry) => entry.kind === 'relation' && [entry.name, entry.model ?? '', ...(entry.physical?.binding?.aliases ?? [])].some((name) => name && mentionsName(text, name)))
        .map((entry) => entryPhysicalRelation(entry))
        .filter((relation): relation is string => Boolean(relation));
      const mentioned = [...`${reason ?? ''} ${previous?.error ?? ''}`.matchAll(/\b(?:column|relation|dimension|metric|measure):[A-Za-z0-9_.$"]+/g)].map((match) => match[0]);
      // A FOLLOW-UP TO AN AI-DRAFTED ANSWER starts from the tables that statement read.
      const priorDraftRelations = prior?.drafted && prior.sql
        ? relationsInSql(prior.sql).filter((relation) => (view.source?.relations ?? []).some((admitted) => physicalRelationIdentity(admitted.binding ? physicalRelationText(admitted.binding) : [admitted.schema, admitted.name].filter(Boolean).join('.')) === physicalRelationIdentity(relation)))
        : [];
      // A metric the reading uses may be defined over more tables than its own
      // (a flag joined in from another model): the tables its definition
      // names are part of what the draft needs.
      const definitionRelations = refs.flatMap((ref) => {
        const entry = current.get(ref) ?? current.resolve(ref);
        if (!entry || (entry.kind !== 'metric' && entry.kind !== 'measure')) return [];
        const definition = ` ${[entry.expr, entry.engineOnly, entry.description, entry.derived?.expr].filter(Boolean).join(' ')} `.toLowerCase();
        return current.entries
          .filter((item) => item.kind === 'relation' && [item.name, item.model ?? ''].some((name) => name && mentionsName(definition, name.split('.').pop()!)))
          .map((item) => entryPhysicalRelation(item))
          .filter((relation): relation is string => Boolean(relation));
      });
      let relations = [...new Set([...refs, ...mentioned].map(relationOf).filter((relation): relation is string => Boolean(relation)).concat(named, definitionRelations, priorDraftRelations))].slice(0, 8);
      // THE TABLES THE QUESTION IS ABOUT. With no reading to name them, the
      // question's own words choose them, the same relation-first discovery
      // context assembly uses; they are described before any SQL is written.
      // WHAT THE USER HAS SAID counts as much as what the reading named: the
      // conversation so far and the clauses the reading could not govern
      // choose tables too ("the competitor is in the deal notes").
      const conversation = conversationMemory;
      const contextText = [conversation?.summary, conversation?.pendingClarification].filter(Boolean).join(' ');
      const open = intent?.unresolved.map((item) => `${item.clause} ${item.question ?? ''}`).join(' ') ?? '';
      // THE CATALOG'S OWN SEARCH first: names, descriptions and documented
      // columns, held to the request's domains, kept only when admitted.
      const sourceColumns = (relation: string): string[] => {
        const found = (view.source?.relations ?? []).find((item) => physicalRelationIdentity(item.binding ? physicalRelationText(item.binding) : [item.schema, item.name].filter(Boolean).join('.')) === physicalRelationIdentity(relation));
        return found ? [...found.columns, ...(found.embeddedColumns ?? [])].map((column) => column.name) : [];
      };
      const readingRelations = [...new Set(refs.map(relationOf).filter((relation): relation is string => Boolean(relation)))];
      const reachesReading = (candidate: string) => joinsAnyRelation(candidate, readingRelations, sourceColumns);
      // Tables that share a key with the reading's tables come first; the rest
      // stay available. Whether a table is "right" is the AI's call, disclosed.
      // On a modeled project the Modeling map decides reach: a table on the map
      // reaches the reading only through modeled relationships (two hops at
      // most), so a table that merely shares a column name ranks last.
      const modeledEdges = readingRelations.length > 0 ? modelingRelationshipEdges(deps.getManifest().manifest) : [];
      const onMap = (name: string) => modeledEdges.some((edge) => sameRelation(edge.fromRelation, name) || sameRelation(edge.toRelation, name));
      const reachOf = (name: string): number => {
        if (modeledEdges.length > 0 && onMap(name)) {
          return readingRelations.some((relation) => sameRelation(relation, name) || modeledJoinPaths([name, relation], modeledEdges, { maxHops: 2, maxAdded: 2 }).paths.length > 0) ? 2 : 0;
        }
        return reachesReading(name) ? 1 : 0;
      };
      const rankByReach = (names: string[]): string[] => names.map((name, index) => ({ name, index, reach: reachOf(name) })).sort((left, right) => right.reach - left.reach || left.index - right.index).map((item) => item.name);
      const catalogPick = (text: string, exclude: string[], max: number, objectTypes: string[] = ['dbt_column', 'dbt_model', 'dbt_source', 'warehouse_table']): string[] => {
        if (!deps.searchCatalog || !text.trim()) return [];
        try {
          // Tables that reach the reading's facts are ranked first.
          const hits = deps.searchCatalog(request, view.envelope, text, { objectTypes, limit: 40 });
          return rankByReach(relationsFromCatalogHits(hits, view.source, exclude, 12)).slice(0, max);
        } catch { return []; }
      };
      const catalogPicked = catalogPick(`${question} ${open} ${contextText}`, relations, 3);
      for (const relation of catalogPicked) if (relations.length < 5) relations.push(relation);
      if (relations.length < 4) {
        try {
          // THE ENVELOPE HOLDS: drafted SQL chooses among the relations this
          // request admits, not every relation in the project.
          const source = view.source ?? (await baseSourceFor(connection)).source;
          for (const relation of rankByReach(relevantRelationsForQuestion(source, `${question} ${open} ${contextText}`, 5, { splitNames: true }))) {
            if (relations.length >= 5) break;
            if (!relations.some((known) => physicalRelationIdentity(known) === physicalRelationIdentity(relation))) relations.push(relation);
          }
        } catch { /* the relations named so far stand */ }
      }
      if (relations.length === 0) {
        // NO TABLES AT ALL is a setup problem, said as one: "nothing matches"
        // would read as an answer about the data (ZLens 0.1.0 e2e, F3).
        const readable = (view.source ?? (await baseSourceFor(connection).catch(() => undefined))?.source)?.relations?.length ?? 0;
        if (readable === 0) {
          const builtManifest = deps.getManifest().manifest;
          const modelingMode = builtManifest?.modeling?.mode;
          const warehouseModeling = modelingMode === 'warehouse-first' || modelingMode === 'hybrid' || Boolean(builtManifest?.dbtProvenance?.warehouseCatalogPath);
          return {
            unavailable: true,
            error: warehouseModeling
              ? 'this project lists no tables Ask may read: warehouse modeling is on (modeling.mode in dql.config.json) and no warehouse catalog has been synced yet. Sync the schema from Settings, run `zlens sync warehouse`, or apply the dbt project from Settings → Project & dbt'
              : 'this project lists no tables Ask may read for this request. Check that the dbt manifest is readable (target/manifest.json) or sync the warehouse schema from Settings',
          };
        }
        return { error: 'no table in this project matches the question' };
      }
      // THE TABLES BETWEEN: when the team modeled how the chosen tables
      // connect, the tables on that route are drafted over too, and each hop
      // is shown as a preferred join. Only relations this request admits are added.
      const modeledRoutes: Array<{ name: string; certified: boolean; from: string; to: string; keys: Array<{ from: string; to: string }>; cardinality?: string }> = [];
      const bridged: string[] = [];
      const draftSource = view.source ?? (await baseSourceFor(connection).catch(() => undefined))?.source;
      const admitted = (name: string): string | undefined => {
        const found = (draftSource?.relations ?? []).find((item) => sameRelation(item.binding ? physicalRelationText(item.binding) : [item.schema, item.name].filter(Boolean).join('.'), name));
        return found ? (found.binding ? physicalRelationText(found.binding) : [found.schema, found.name].filter(Boolean).join('.')) : undefined;
      };
      const mapEdges = modelingRelationshipEdges(deps.getManifest().manifest);
      // A MARKER TABLE brings the table its values live on.
      for (const item of markerTables(relations, mapEdges, sourceColumns)) {
        const base = relations.find((relation) => sameRelation(relation, item.base)) ?? admitted(item.base);
        if (base && !relations.some((relation) => physicalRelationIdentity(relation) === physicalRelationIdentity(base))) { relations.push(base); bridged.push(base); }
      }
      if (relations.length >= 2) {
        try {
          const physicalOf = (name: string) => relations.find((relation) => sameRelation(relation, name)) ?? admitted(name);
          const { paths } = modeledJoinPaths(relations, mapEdges);
          for (const path of paths) {
            const through = path.through.map(admitted);
            if (through.some((relation) => !relation)) continue;
            for (const relation of through as string[]) {
              if (!relations.some((known) => physicalRelationIdentity(known) === physicalRelationIdentity(relation))) { relations.push(relation); bridged.push(relation); }
            }
            for (const edge of path.edges) {
              const from = physicalOf(edge.fromRelation);
              const to = physicalOf(edge.toRelation);
              if (from && to) modeledRoutes.push({ name: edge.name, certified: edge.level === 'certified', from, to, keys: edge.keys, cardinality: edge.cardinality });
            }
          }
        } catch { /* the tables chosen so far stand */ }
      }
      // NAMES, NOT KEYS (key-labels.ts). The reading groups by a thing's key
      // (a store's location_id on the orders); the table that names those rows
      // is found from the Modeling map, the semantic entities or the column
      // names, read as the warehouse table, never a semantic model's bare name
      // (`locations` is not a table the warehouse has). When the chosen tables
      // do not already include it, it is added and the join is spelled out, so
      // the draft can show names. A statement that still groups by a bare key
      // is sent back once (finalize below).
      const qualifiedText = (item: NonNullable<VocabularySource['relations']>[number]) => item.binding ? physicalRelationText(item.binding) : [item.schema, item.name].filter(Boolean).join('.');
      const physicalTables = (draftSource?.relations ?? []).map(qualifiedText).filter((name) => parsePhysicalIdentifier(name).length >= 2);
      const warehouseTable = (name: string): string | undefined => {
        if (parsePhysicalIdentifier(name).length >= 2) {
          const exact = physicalTables.find((table) => physicalRelationIdentity(table) === physicalRelationIdentity(name));
          if (exact) return exact;
        }
        const matches = physicalTables.filter((table) => sameRelation(table, name));
        return matches.length === 1 ? matches[0] : undefined;
      };
      const knownColumns = (relation: string): string[] => {
        const fromEntries = current.entries
          .filter((item) => item.kind === 'column' && (() => { const physical = entryPhysicalRelation(item); return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation); })())
          .map((item) => item.physical?.column ?? item.name.split('.').pop()!);
        return [...new Set([...sourceColumns(relation), ...fromEntries])];
      };
      const entityKeys: EntityKey[] = current.entries
        .filter((entry) => entry.kind === 'entity' && entry.physical?.relation && entry.physical.column)
        .map((entry) => ({ name: entry.ref.split('.').pop()!, type: entry.entityType ?? '', relation: entry.physical!.relation, column: entry.physical!.column! }));
      const labelsFor = (keys: KeyReference[]): KeyLabel[] => keyLabels(keys, { edges: mapEdges, entities: entityKeys, relations: physicalTables, columnsOf: knownColumns, resolve: warehouseTable });
      const readingKeys: KeyReference[] = (intent?.groupBy ?? []).flatMap((group) => {
        const entry = current.get(group.ref) ?? current.resolve(group.ref);
        const keyLike = group.role === 'key' || entry?.kind === 'entity' || entry?.roles.includes('key');
        if (!entry || !keyLike || !entry.physical?.column) return [];
        const table = warehouseTable(entry.physical.relation) ?? entryPhysicalRelation(entry);
        return table ? [{ relation: table, column: entry.physical.column }] : [];
      });
      const keyLines: string[] = [];
      const namingTables: string[] = [];
      for (const item of labelsFor(readingKeys)) {
        const missing = [item.keyRelation, item.labelRelation].filter((relation) => !relations.some((known) => physicalRelationIdentity(known) === physicalRelationIdentity(relation)));
        if (missing.length === 0) continue;
        for (const relation of missing) { relations.push(relation); namingTables.push(relation); }
        keyLines.push(keyLabelLine(item));
      }
      // THE WHOLE SCHEMA WHEN IT FITS. On a warehouse-first project the synced
      // catalog is the entire account of the data, and a plain text-to-SQL
      // prompt reads every table of it. Choosing five by word overlap meant a
      // needed table was simply never shown. When every described table fits
      // the budget, the drafter sees all of them, the chosen ones first (with
      // the tables that name a grouped key, added above, among them), with the
      // keys the warehouse declares. Above the budget it chooses as before.
      const warehouseKeys = warehouseFirstCatalog(deps.getManifest().manifest, deps.projectRoot);
      // WHAT THE COLUMNS HOLD, when the project opted in (agent.valueProfile)
      // and the profile describes this catalog: a few stored values or the
      // range beside each column. The values reach the provider with this
      // prompt, which is why it is opt-in and never under a host.
      const valueProfile = warehouseKeys && deps.valueProfileAllowed?.() === true
        ? readValueProfile(deps.projectRoot, deps.getManifest().manifest?.dbtProvenance?.warehouseCatalogFingerprint)
        : undefined;
      const profiled = new Map(Object.entries(valueProfile?.relations ?? {}).map(([relation, columns]) => [physicalRelationIdentity(relation), new Map(Object.entries(columns).map(([column, profile]) => [column.toLowerCase(), profile]))]));
      const columnCard = (item: VocabularyEntry): string => {
        const card = renderCard(item);
        const relation = entryPhysicalRelation(item);
        if (!profiled.size || !relation) return card;
        const column = (item.physical?.column ?? item.name.split('.').pop() ?? '').toLowerCase();
        return `${card}${renderColumnProfile(profiled.get(physicalRelationIdentity(relation))?.get(column))}`;
      };
      // The values take room: the whole schema may be larger when they are shown.
      const wholeSchemaChars = profiled.size ? WHOLE_SCHEMA_WITH_VALUES_CHARS : WHOLE_SCHEMA_CHARS;
      let wholeSchema = false;
      if (warehouseKeys) {
        const described = current.entries
          .filter((item) => item.kind === 'relation' && entryPhysicalRelation(item) !== undefined && current.entries.some((column) => column.kind === 'column' && samePhysicalEntry(column, item)))
          .map((item) => entryPhysicalRelation(item)!);
        const size = current.entries.filter((item) => item.kind === 'column').reduce((total, item) => total + columnCard(item).length + 1, 0) + described.length * 160;
        const unseen = described.filter((relation) => !relations.some((known) => physicalRelationIdentity(known) === physicalRelationIdentity(relation)));
        if (unseen.length > 0 && size <= wholeSchemaChars) {
          relations.push(...unseen);
          wholeSchema = true;
        }
      }
      const needsColumns = relations.filter((relation) => {
        const entry = current.entries.find((item) => item.kind === 'relation' && entryPhysicalRelation(item) !== undefined && physicalRelationIdentity(entryPhysicalRelation(item)!) === physicalRelationIdentity(relation));
        return !entry || entry.physical?.binding?.columnCompleteness !== 'complete' || !current.entries.some((item) => item.kind === 'column' && samePhysicalEntry(item, entry));
      });
      if (needsColumns.length > 0) {
        // Tables the Modeling map added come first: they are how the others
        // join, and a table without described columns is dropped below. The
        // number described stays as it was — describing more tables leaves
        // more columns in the request's vocabulary, and a later question then
        // reads wider than the certified block that answers it.
        const ordered = [...needsColumns.filter((relation) => bridged.includes(relation) || namingTables.includes(relation)), ...needsColumns.filter((relation) => !bridged.includes(relation) && !namingTables.includes(relation))];
        try {
          const found = await describeRelations(ordered);
          if (found.length > 0) {
            current = mergeDiscoveredRelations(current, found);
            requestVocabulary = current;
          }
        } catch { /* draft over what is already described */ }
      }
      // Only tables whose columns are known can be drafted over.
      relations = relations.filter((relation) => current.entries.some((item) => item.kind === 'column' && (() => { const physical = entryPhysicalRelation(item); return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation); })()));
      if (relations.length === 0) return { unavailable: true, error: 'the tables that match the question could not be described on this connection' };
      hostStep({ phase: 'schema', title: wholeSchema ? `Showed the whole schema: all ${relations.length} tables${relations.some((relation) => { const keys = warehouseKeys?.keysOf(relation); return Boolean(keys?.primaryKey || keys?.foreignKeys.length); }) ? ', with the keys the warehouse declares' : ''}` : `Chose ${relations.length === 1 ? 'the table' : 'the tables'} ${relations.join(', ')}`, state: 'done', detail: `picked from ${refs.length ? 'the fields the reading named' : 'the words of the question'}${catalogPicked.length ? `; found by the catalog search: ${catalogPicked.join(', ')}` : ''}${bridged.length ? `; added to connect them over modeled relationships: ${bridged.join(', ')}` : ''}${namingTables.length ? `; added because they name what the answer groups by: ${namingTables.join(', ')}` : ''}${needsColumns.length ? `; columns of ${needsColumns.slice(0, 4).join(', ')} read from the warehouse` : ''}` });
      // THE CONTEXT THE DRAFT READS: what the user said, the previous reading,
      // and what the project says about this data (domain notes, business
      // terms the question uses, approved hints).
      const spoken = ` ${question} ${contextText} `.toLowerCase();
      const termLines = current.entries
        .filter((entry) => entry.kind === 'term' && [entry.name, entry.label ?? '', ...entry.aliases].some((name) => name.length > 2 && spoken.includes(name.toLowerCase())))
        .slice(0, 5)
        .map((entry) => `- business term ${entry.label ?? entry.name}: ${[entry.description, ...(entry.rules ?? [])].filter(Boolean).join(' ').slice(0, 300)}`);
      const briefing = view.pack?.domainBriefing;
      const hintLines = (view.pack?.appliedHints ?? []).slice(0, 5)
        .map((hint) => hint.lesson?.rule || hint.guidance)
        .filter((rule): rule is string => Boolean(rule))
        .map((rule) => `- approved hint: ${rule.slice(0, 300)}`);
      // A GOVERNED METRIC the question or the reading names is computed the
      // governed way: its definition is part of the context, never re-invented.
      const measureRefs = new Set(intent ? intent.measures.flatMap((measure) => measure.derived ? [measure.derived.numerator, measure.derived.denominator] : [measure.ref]) : []);
      const metricLines = current.entries
        .filter((entry) => (entry.kind === 'metric' || entry.kind === 'measure') && (measureRefs.has(entry.ref) || [entry.name.replace(/_/g, ' '), entry.label ?? '', ...entry.aliases].some((name) => name.length > 3 && spoken.includes(name.toLowerCase()))))
        .slice(0, 5)
        .map((entry) => {
          // An authored semantic metric the engine did not run is rebuilt from
          // its definition as written, never re-invented from its name.
          if (entry.engineOnly) return `- semantic ${entry.kind} ${entry.label ?? entry.name} (semantic engine only: ${entry.engineOnly}; rebuild it exactly from this definition): ${entry.expr ?? 'as described'}${entry.timeRef ? `, time ${entry.timeRef}` : ''}${entry.description ? ` (${entry.description.slice(0, 300)})` : ''}`;
          const physical = entry.physical;
          const definition = entry.derived
            ? `${entry.derived.expr} over ${entry.derived.inputs.map((input) => `${input.alias} = ${input.ref}`).join(', ')}`
            : physical?.expr
              ? physical.expr
              : physical?.column
                ? `${(physical.aggregate ?? entry.aggregation ?? 'sum').toUpperCase()}(${physical.column})`
                : entry.expr ?? 'as described';
          return `- semantic ${entry.kind} ${entry.label ?? entry.name}: ${definition}${physical?.relation ? ` on ${physical.relation}` : ''}${entry.timeRef ? `, time ${entry.timeRef}` : ''}${entry.description ? ` (${entry.description.slice(0, 120)})` : ''}`;
        });
      // PREFERRED JOINS: hints for how two of these tables join, never a gate.
      const joinHints = preferredJoinHints(current.entries, relations, sourceColumns);
      // A modeled hop is shown unless a hint above already covers that pair of
      // tables, so a draft that already had its joins reads the same as before.
      const pairKey = (a: string, b: string) => [physicalRelationIdentity(a), physicalRelationIdentity(b)].sort().join(' ~ ');
      const hinted = new Set(joinHints.map((hint) => pairKey(hint.from, hint.to)));
      const routeLines = modeledRoutes
        .filter((route) => relations.some((relation) => physicalRelationIdentity(relation) === physicalRelationIdentity(route.from)) && relations.some((relation) => physicalRelationIdentity(relation) === physicalRelationIdentity(route.to)))
        .filter((route) => !hinted.has(pairKey(route.from, route.to)))
        .map(preferredJoinLine);
      const joinLines = [...new Set([...routeLines, ...joinHints.map(preferredJoinLine)])];
      const markerLines = markerTables(relations, mapEdges, sourceColumns)
        .map((item) => ({ ...item, base: relations.find((relation) => sameRelation(relation, item.base)) ?? item.base }))
        .map(markerTableLine);
      // The number people know a table's rows by, beside its internal key.
      const identifierLines = businessIdentifiers(relations, sourceColumns).map(businessIdentifierLine);
      // THE TEAM'S CERTIFIED REPORTS NEAR THE QUESTION: their SQL is how the
      // team joins and defines these tables, reused where the question
      // overlaps. Draft blocks are never shown; the answer stays review-required.
      const draftBlocks = certifiedBlocksForDraft(current.entries, `${question} ${intent?.reading ?? ''}`, relations);
      const blockLines = draftBlocks
        .map((entry) => `- certified block ${entry.label ?? entry.name} (how the team joins these tables and defines its measures, for a report near this question: reuse its joins and definitions where the question overlaps it; which rows to keep, the grouping and the output come from the question, not the block; write the SQL for ${connection?.driver ?? 'duckdb'} even where the block's syntax differs)${entry.description ? `: ${entry.description.replace(/\s+/g, ' ').slice(0, 300)}` : ''}. Its certified SQL: ${entry.sql!.replace(/\s+/g, ' ').slice(0, 1500)}`);
      // THE PROJECT'S WRITTEN RULES: the skills selected for this request whose
      // text shares the most words with the question and the chosen tables,
      // long enough to carry a definition (the reading step sees a short card).
      const skillLines = skillsForDraft(current.entries, `${question} ${intent?.reading ?? ''} ${relations.join(' ')}`)
        .map((entry) => `- project skill ${entry.label ?? entry.name}: ${(entry.skill?.guidance ?? entry.description ?? '').replace(/\s+/g, ' ').slice(0, 1500)}`);
      const contextLines = [
        ...(contextText ? [`- conversation so far: ${contextText.slice(0, 600)}`] : []),
        ...(prior?.intent.reading ? [`- previous reading: ${shownToModel(prior.intent.reading).slice(0, 300)}${prior.summary ? `; its answer: ${prior.summary.slice(0, 300)}` : ''}`] : []),
        ...(prior?.drafted && prior.sql ? [`- previous AI-drafted SQL in this conversation (this question follows up on it: edit it, and keep every restriction it applies unless the question changes it): ${shownToModel(prior.sql.replace(/\s+/g, ' ')).slice(0, 1500)}`] : []),
        ...(briefing ? [`- domain ${briefing.name}${briefing.description ? `: ${briefing.description.slice(0, 300)}` : ''}${briefing.caveats.length ? `; caveats: ${briefing.caveats.slice(0, 3).join('; ')}` : ''}${briefing.requiredFilters.length ? `; required filters: ${briefing.requiredFilters.slice(0, 3).join('; ')}` : ''}`] : []),
        ...termLines,
        ...metricLines,
        ...joinLines,
        ...keyLines,
        ...blockLines,
        ...markerLines,
        ...identifierLines,
        ...skillLines,
        ...hintLines,
      ];
      const attemptDraft = async (note?: string, label?: 'fix' | 'widen'): Promise<Awaited<ReturnType<NonNullable<PrepareDeps['draftSql']>>>> => {
        const unresolvedPhysical = current.entries
          .filter((entry) => entry.kind === 'relation' && relations.some((relation) => {
            const physical = entryPhysicalRelation(entry);
            return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation);
          }))
          .filter((entry) => !entry.physical?.binding || (connection?.driver.toLowerCase() === 'snowflake' && !entry.physical.binding.database));
        if (unresolvedPhysical.length > 0) {
          return { error: `the relation ${unresolvedPhysical.map((entry) => entry.model ?? entry.name).join(', ')} does not have one exact physical database binding for this target; refresh metadata or resolve the duplicate database identity before drafting SQL` };
        }
        const cards: string[] = [];
        let chars = 0;
        for (const relation of relations) {
          const entry = current.entries.find((item) => {
            if (item.kind !== 'relation') return false;
            const physical = entryPhysicalRelation(item);
            return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation);
          });
          const declared = warehouseKeys?.keysOf(relation);
          // A foreign key names the table it points at as the cards spell it.
          const shownAs = (target: string) => { const table = warehouseKeys?.keysOf(target); return (table && relations.find((known) => warehouseKeys?.keysOf(known) === table)) ?? target; };
          const lines = [
            entry ? `- executable relation:${relation} [${entry.physical?.binding?.columnCompleteness ?? 'partial'} columns; logical ${entry.physical?.binding?.logicalRelation ?? entry.model ?? relation}]` : `- executable relation:${relation}`,
            ...current.entries.filter((item) => item.kind === 'column' && samePhysicalEntry(item, entry)).map((item) => columnCard(item)),
            // What one row is, and how this table points at others, as the
            // warehouse declares them (warehouse-first projects only).
            ...(declared?.primaryKey ? [`  primary key (${declared.primaryKey.join(', ')}): one row per ${declared.primaryKey.join(', ')}`] : []),
            ...(declared?.foreignKeys ?? []).map((key) => `  foreign key (${key.columns.join(', ')}) references ${shownAs(key.references.relation)} (${key.references.columns.join(', ')})`),
          ];
          const cap = wholeSchema ? wholeSchemaChars : 18_000;
          for (const line of lines) { if (chars + line.length > cap) break; cards.push(line); chars += line.length + 1; }
        }
        const dialect = connection?.driver ?? 'duckdb';
        const messages: AgentMessage[] = [
          { role: 'system', content: `You write exactly ONE read-only SQL statement for ${dialect} that answers the question from the tables below. No certified block or semantic metric answers it, so you choose the tables, columns, joins and filters. Use ONLY the executable physical relations and columns listed below, spelled exactly as listed (including database and quoting where shown). Join two relations only on columns that exist in both. Apply every restriction the question states; when unsure how a text value is stored, match it case-insensitively; aggregate at the grain the question asks for; when the answer lists people or things, select and group by their id column beside the name (two can share a name); a term with a standard definition (a double-double, a win rate, a repeat customer) is computed from the listed columns that define it, and the definition is not a missing field; order and limit as it asks; never return more than 500 rows. No DDL or DML, no comments, no explanation. The CONTEXT lines are what the user and the project have said about this data (definitions, rules, where values are kept): follow them, and use a table or field the user names as named. A semantic metric listed in CONTEXT is computed exactly as it is defined there. A preferred join listed in CONTEXT is how those tables join unless the question needs another. When no column is dedicated to a restriction the question states, apply it to the text, tag, category or custom field that most plausibly holds that value, matched case-insensitively (a partial match is allowed). Reply exactly NO_SQL: followed by one sentence naming what is missing only when no listed column could hold a measure or a restriction the question asks for, and never substitute a different measure for the one asked. Otherwise return the SQL only.` },
          { role: 'user', content: `QUESTION: ${question}\n${reason ? `WHY NO GOVERNED ANSWER: ${reason.slice(0, 600)}\n` : ''}${intent && !(warehouseKeys && readEnv('ZLENS_ASK_DRAFT_WITHOUT_READING') === '1') ? `READING: ${shownToModel(intent.reading)}\nINTENT: ${shownToModel(JSON.stringify({ measures: intent.measures, groupBy: intent.groupBy, display: intent.display, filters: intent.filters, time: intent.time ?? null, ordering: intent.ordering ?? null, limit: intent.limit ?? null }))}\n` : ''}${contextLines.length ? `CONTEXT:\n${contextLines.join('\n')}\n` : ''}${warehouseKeys && DIALECT_NOTES[dialect.toLowerCase()] ? `DIALECT NOTES (${dialect}): ${DIALECT_NOTES[dialect.toLowerCase()]}\n` : ''}${note ? `NOTE: ${note}\n` : ''}${previous ? (ranWithoutError(previous.error, Boolean(warehouseKeys)) ? `PREVIOUS SQL (it ran; this is why it needs another look):\n${shownToModel(previous.sql)}\nWHAT TO CHANGE: ${shownToModel(previous.error.slice(0, 800))}\n` : `PREVIOUS SQL (the warehouse rejected it; fix it):\n${shownToModel(previous.sql)}\nWAREHOUSE ERROR: ${shownToModel(previous.error.slice(0, 600))}\n`) : ''}RELATIONS AND COLUMNS:\n${cards.join('\n')}` },
        ];
        const draftStarted = Date.now();
        const trace = deps.dispatchOptions?.('draft', request);
        // What this call was for and what it returned, kept for the run views.
        const dispatch: AskRunState['draftDispatches'][number] = {
          purpose: 'intent:draft', ms: 0, attempt: state.draftDispatches.length + 1,
          ...(draftBlocks.length ? { blocks: draftBlocks.map((entry) => entry.ref) } : {}),
          label: label ?? (note ? 'fix' : undefined) ?? (previous ? (/^the statement ran and returned no rows/.test(previous.error) ? 'retry_empty' : REVIEW_REVISION.test(previous.error) ? 'revise' : 'redraft') : 'draft'),
        };
        let raw: string;
        let replied: string | undefined;
        let failed: string | undefined;
        try {
          if (request.signal?.aborted) throw new Error('the request was cancelled before SQL drafting started');
          raw = await provider.generate(messages, { temperature: 0, ...(trace?.options ?? {}), ...(request.signal ? { signal: request.signal } : {}) });
          replied = raw;
          trace?.settle('ok');
        } catch (error) {
          failed = error instanceof Error ? error.message : String(error);
          trace?.settle(request.signal?.aborted ? 'cancelled' : 'error', error);
          throw error;
        } finally {
          Object.assign(dispatch, {
            ms: Date.now() - draftStarted, at: Date.now(), promptChars: messages.reduce((sum, message) => sum + message.content.length, 0),
            ...(replied !== undefined ? { reply: replied.slice(0, 1500) } : failed !== undefined ? { reply: failed.slice(0, 300), outcome: 'error' as const } : {}),
          });
          state.draftDispatches.push(dispatch);
        }
        const declined = /^\s*NO_SQL\s*:?\s*([\s\S]*)$/i.exec(raw.trim());
        if (declined) { dispatch.outcome = 'declined'; return { declined: declined[1]!.trim() || 'the available tables do not hold what the question asks for' }; }
        const fenced = /```(?:sql)?\s*([\s\S]*?)```/i.exec(raw);
        // The earlier values the model read by position are the real ones again in what it drafted.
        const drafted = (fenced ? fenced[1]! : raw).trim();
        const sql = priorMask ? priorMask.restoreText(drafted) : drafted;
        if (!sql) { dispatch.outcome = 'error'; return { error: 'the provider returned no SQL' }; }
        dispatch.outcome = 'sql';
        const runtimeSchema = runtimeSchemaForVocabulary(current)
          .filter((table) => relations.some((relation) => physicalRelationIdentity(relation) === physicalRelationIdentity(table.relation)));
        const validation = validateSqlAgainstLocalContext(sql, view.pack, {
          dialect,
          question,
          runtimeSchema,
          runtimeSchemaExact: true,
          ...(connection ? { executionTargetFingerprint: fingerprintText(connectionKey(connection)) } : {}),
          enforceGenerationReadiness: false,
        });
        if (!validation.ok) {
          // A parser that cannot read this dialect is not evidence against the
          // draft: prove it by the relations it reads, exactly as the frozen
          // statement is proven before execution. Read-only-ness is proven by
          // the tier itself.
          if (!/could not be parsed/i.test(validation.error)) return { error: `the drafted SQL was not accepted: ${validation.error}` };
          // One matcher with the validator: on DuckDB `main.claim` is the inspected `acme.main.claim`.
          const read = relationsInSql(sql).filter((relation) => parsePhysicalIdentifier(relation).length >= 2);
          const foreign = read.find((relation) => !inspectedRelationMatches(relation, runtimeSchema, dialect));
          if (foreign) return { error: `the drafted SQL reads ${foreign}, which this request did not inspect` };
          if (read.length === 0) return { error: 'the drafted SQL names no inspected relation' };
          return { sql, relations: read, proof: [`reads only the inspected physical bindings: ${read.join(', ')} (the SQL parser could not read this dialect; relations proven by name)`], engine: dialect };
        }
        return { sql, relations: validation.referencedRelations, proof: [`validated against the inspected physical bindings: it reads ${validation.referencedRelations.join(', ') || 'admitted relations only'}`, ...validation.warnings.slice(0, 3)], engine: dialect };
      };
      // THE CHECKS BEFORE ANYTHING RUNS. Every value the question states and
      // every required filter of the project must be in the statement, and a
      // join that repeats its key on both sides must not feed an aggregate.
      // One redraft names the failure; a failure that survives it is refused,
      // never run. What passes is row-guarded and says what it filters on.
      // A block the question names as a block is a project object, not a
      // value: "Using the certified block Eligible Top Players" never asks the
      // SQL to filter on "Eligible" or "Players".
      const namedBlocks = blocksNamedByQuestion(question, Object.values(deps.getManifest().manifest?.blocks ?? {}).map((block) => block.name));
      const stated = statedValues(question, intent, { namedBlocks });
      const requiredTexts = [...new Set([
        ...current.entries.filter((entry) => entry.kind === 'skill').flatMap((entry) => entry.skill?.requiredFilters ?? []),
        ...(view.pack?.domainBriefing?.requiredFilters ?? []),
      ])];
      const required = requiredTexts.map((text) => requiredFilterFromText(text)).filter((item): item is NonNullable<typeof item> => Boolean(item));
      // The relationships on the Modeling map, as edges between the warehouse
      // relations a statement names.
      const relationshipEdges = modelingRelationshipEdges(deps.getManifest().manifest);
      // Key columns in a probe are quoted the warehouse's way: a double-quoted
      // name is a string literal on MySQL, where GROUP BY "id" groups every
      // row into one and reports a repeating key that is not there.
      const keyDialect = connection ? getDialect(connection.driver) : undefined;
      const quoteKey = (column: string) => {
        const bare = column.replace(/^["`\[]|["`\]]$/g, '');
        return keyDialect ? keyDialect.quoteIdentifier(bare) : `"${bare.replace(/"/g, '')}"`;
      };
      const probeOne = async (sql: string): Promise<boolean> => {
        if (!connection) return false;
        const options = { maxRows: 1, ...(request.signal ? { signal: request.signal } : {}), ...(request.runBudget ? { deadlineMs: Math.min(8_000, request.runBudget.remainingMs()) } : {}) };
        const result = deps.executor.executePositional
          ? await deps.executor.executePositional(sql, [], connection, options)
          : await deps.executor.executeQuery(sql, [], {}, connection, options);
        return (result.rows?.length ?? 0) > 0;
      };
      const failedChecks = async (sql: string): Promise<string[]> => {
        const failures: string[] = [];
        const missing = missingStatedValues(sql, stated);
        if (missing.length) failures.push(`it does not apply ${missing.map((item) => item.kind === 'fiscal_year' ? `"${item.value}" (fiscal year ${item.value.replace(/^FY/i, '').length === 2 ? `20${item.value.replace(/^FY/i, '')}` : item.value.replace(/^FY/i, '')}: restrict a fiscal-year field, or the dates that fiscal year spans)` : `"${item.value}"`).join(', ')} from the question`);
        const missingRequired = missingRequiredFilters(sql, required);
        if (missingRequired.length) failures.push(`it does not apply the required filter ${missingRequired.map((item) => item.text).join(', ')}`);
        // CERTIFIED RELATIONSHIPS BIND AI-WRITTEN JOINS. Two tables a person
        // certified a relationship between are joined on exactly its keys; a
        // draft or validated relationship stays a hint, and every join is
        // recorded with the relationship behind it.
        const joinUses = classifySqlJoins(joinKeyPairs(sql), relationshipEdges);
        const certifiedFailures = certifiedJoinViolations(sql, joinUses);
        failures.push(...certifiedFailures);
        // Two tables linked only by a parent they both reference are not
        // linked by it when the team modeled how they connect.
        failures.push(...sharedParentShortcuts(joinUses, relationshipEdges));
        // A LEFT JOIN whose table is used nowhere else restricts nothing: the
        // restriction it stood for was not applied. Judged only with the
        // table's complete column list, so a bare column is never misread.
        const completeColumnsOf = (relation: string): string[] | undefined => {
          const entry = current.entries.find((item) => item.kind === 'relation' && entryPhysicalRelation(item) !== undefined && sameRelation(entryPhysicalRelation(item)!, relation));
          const listed = entry && entry.physical?.binding?.columnCompleteness === 'complete'
            ? current.entries.filter((item) => item.kind === 'column' && samePhysicalEntry(item, entry)).map((item) => item.physical?.column ?? item.name.split('.').pop()!)
            : [];
          const read = sourceColumns(relation);
          return read.length ? read : listed.length ? listed : undefined;
        };
        // An inner join used nowhere else only restricts, which is harmless
        // when it matches one row per row; when its key repeats, every total
        // of the other tables is counted once per match.
        const totals = /\b(sum|avg|count)\s*\(\s*(?!distinct\b)/i.test(sql);
        for (const join of unusedJoins(sql, completeColumnsOf)) {
          const name = join.relation.split('.').pop()!.replace(/"/g, '');
          if (join.left) {
            failures.push(`it LEFT JOINs ${name} but uses none of its columns, so the join restricts nothing (a LEFT JOIN keeps every row) and can only repeat rows; if ${name} marks which rows count, join it with an inner join, otherwise leave it out`);
            continue;
          }
          if (!totals || join.keys.length === 0) continue;
          const key = join.keys.map(quoteKey).join(', ');
          let repeats = false;
          try { repeats = await probeOne(`SELECT ${key} FROM ${join.relation} GROUP BY ${key} HAVING COUNT(*) > 1`); } catch { repeats = false; }
          if (repeats) failures.push(`it joins ${name} but uses none of its columns, and ${name} has several rows per ${join.keys.join(', ')}, so every total is counted once per matching ${name} row; leave the join out, or aggregate ${name} at its own grain first if it restricts which rows count`);
        }
        state.hostJoins = ledgerJoins(joinUses);
        const certifiedUses = joinUses.filter((use) => use.relationship?.level === 'certified');
        if (aggregatesRows(sql)) {
          // A join repeats rows when its WHOLE key repeats: the tuple of
          // columns it matches on together, probed as one GROUP BY. A column
          // of a composite key repeats on its own by design (a ball number
          // recurs in every over), so probing it alone condemned correct
          // joins on the full key.
          for (const group of joinKeyGroups(sql).slice(0, 3)) {
            const repeats = async (side: JoinKeyGroup['left']) => {
              const key = side.columns.map(quoteKey).join(', ');
              try { return await probeOne(`SELECT ${key} FROM ${side.relation} GROUP BY ${key} HAVING COUNT(*) > 1`); } catch { return false; }
            };
            const leftRepeats = await repeats(group.left);
            const rightRepeats = await repeats(group.right);
            const on = group.left.columns.map((column, index) => `${column} = ${group.right.columns[index]}`).join(' and ');
            if (leftRepeats && rightRepeats) failures.push(`its join of ${group.left.relation} and ${group.right.relation} on ${on} repeats the key on both sides, so totals would count rows more than once`);
            else if (leftRepeats !== rightRepeats) {
              // ONE ROW PER KEY ON ONE SIDE, SEVERAL ON THE OTHER: a total of the
              // one side's columns (an order's cost) is counted once per matching
              // row of the other (each order item). It is aggregated at its own
              // grain before the join, or the number is wrong.
              const one = leftRepeats ? group.right : group.left;
              const many = leftRepeats ? group.left : group.right;
              if (one.qualifier && aggregatesColumnOf(sql, one.qualifier)) failures.push(`it aggregates columns of ${one.relation} (one row per ${one.columns.join(', ')}) across its join to ${many.relation}, which has several rows per ${many.columns.join(', ')}, so those totals count each ${one.relation} row once per ${many.relation} row; aggregate ${one.relation} at its own grain (a subquery or CTE) before joining`);
            }
          }
        }
        // The same verdicts, recorded as checks for the run views.
        const attempt = ++state.checkRound;
        const joinFailure = failures.find((message) => /repeats the key on both sides|across its join to|which both only reference|uses none of its columns/.test(message));
        const statedFailure = failures.find((message) => /from the question$/.test(message));
        state.hostChecks.push(
          { id: 'catalog_columns', label: 'Uses only tables and columns the project lists', passed: true, message: 'every table and column it reads was inspected', attempt },
          { id: 'stated_values', label: 'Applies every value the question states', passed: !statedFailure, message: statedFailure ?? (stated.length ? `applies ${stated.map((item) => item.value).join(', ')}` : 'the question states no specific values'), attempt },
          ...(required.length ? [{ id: 'required_filters' as const, label: 'Applies the required filters', passed: missingRequired.length === 0, message: missingRequired.length ? `does not apply ${missingRequired.map((item) => item.text).join(', ')}` : `applies ${required.map((item) => item.text).join(', ')}`, attempt }] : []),
          { id: 'join_fanout', label: 'Joins do not count rows more than once', passed: !joinFailure, message: joinFailure ?? 'no join multiplies the rows it totals', attempt },
          // Only a statement that joins certified tables carries this check.
          ...(certifiedUses.length ? [{ id: 'certified_joins' as const, label: 'Joins certified tables on their certified keys', passed: certifiedFailures.length === 0, message: certifiedFailures[0] ?? `joins on the keys of ${certifiedUses.map((use) => use.relationship!.name).join(', ')}`, attempt }] : []),
        );
        return failures;
      };
      // A statement that groups by a key whose rows have a reachable name it
      // does not show (key-labels.ts), recorded as a check for the run views.
      const unnamedKeysOf = (sql: string): KeyLabel[] => {
        const grouped = groupingKeyLabels(sql, question, labelsFor, knownColumns);
        const found = unnamedGroupingKeys(sql, question, labelsFor, knownColumns);
        if (grouped.length > 0) {
          state.hostChecks.push({ id: 'key_labels', label: 'Shows names, not bare keys', passed: found.length === 0, message: found.length ? unnamedKeyFailure(found[0]!) : `shows ${[...new Set(grouped.map((item) => item.label))].join(', ')} for what it groups by`, attempt: state.checkRound });
        }
        return found;
      };
      const includeRelations = async (wanted: string[]): Promise<void> => {
        const fresh = [...new Set(wanted)].filter((relation) => !relations.some((known) => physicalRelationIdentity(known) === physicalRelationIdentity(relation)));
        if (fresh.length === 0) return;
        const undescribed = fresh.filter((relation) => !current.entries.some((item) => item.kind === 'column' && (() => { const physical = entryPhysicalRelation(item); return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation); })()));
        if (undescribed.length > 0) {
          try {
            const described = await describeRelations(undescribed);
            if (described.length > 0) { current = mergeDiscoveredRelations(current, described); requestVocabulary = current; }
          } catch { /* drafted over what is described */ }
        }
        for (const relation of fresh) {
          if (current.entries.some((item) => item.kind === 'column' && (() => { const physical = entryPhysicalRelation(item); return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation); })())) relations.push(relation);
        }
      };
      type Drafted = Awaited<ReturnType<typeof attemptDraft>>;
      const finalize = async (drafted: Drafted): Promise<Drafted> => {
        // A statement rejected before running (a column the tables do not have,
        // a table nobody inspected) gets the same one correction a failed check
        // gets, with the reason, before anything is given up.
        if (drafted && 'error' in drafted && /^the drafted SQL /.test(drafted.error)) {
          state.hostChecks.push({ id: 'catalog_columns', label: 'Uses only tables and columns the project lists', passed: false, message: drafted.error, attempt: ++state.checkRound });
          hostStep({ phase: 'schema', title: 'The drafted SQL named something the tables do not have: asking the AI to fix it', state: 'failed', detail: drafted.error });
          const retried = await attemptDraft(`The previous statement was rejected before running: ${drafted.error}. Use only the columns listed under each relation, spelled as listed, and join only on columns both relations list.`);
          if (!retried || !('sql' in retried)) return retried;
          drafted = retried;
        }
        if (!drafted || !('sql' in drafted)) return drafted;
        let chosen = drafted;
        let failures = await failedChecks(chosen.sql);
        let unnamed = unnamedKeysOf(chosen.sql);
        if (failures.length > 0 || unnamed.length > 0) {
          const problems = [...failures, ...unnamed.map(unnamedKeyFailure)];
          hostStep({ phase: 'schema', title: 'The drafted SQL failed a check: asking the AI to fix it', state: 'failed', detail: problems.join('; ') });
          // The tables that name those keys are drafted over the second time.
          await includeRelations(unnamed.flatMap((item) => [item.keyRelation, item.labelRelation]));
          const repaired = await attemptDraft(`The previous statement was not run because ${problems.join('; ')}. Fix exactly that and keep everything else the question asks.`);
          // Bare keys alone never refuse a statement that is otherwise right:
          // when the fix fails, the first statement runs and the answer says
          // what identifies its rows.
          const keysOnly = failures.length === 0;
          if (!repaired || !('sql' in repaired)) {
            if (!keysOnly) return repaired;
          } else {
            const repairedFailures = await failedChecks(repaired.sql);
            if (repairedFailures.length === 0) chosen = repaired;
            else if (!keysOnly) return { refused: repairedFailures.join('; ') };
            // The first statement stands; its own checks are the ones recorded last.
            else await failedChecks(chosen.sql);
          }
          failures = [];
          unnamed = unnamedKeysOf(chosen.sql);
        }
        const applied = appliedConditions(chosen.sql);
        hostStep({ phase: 'schema', title: 'Checked the drafted SQL', state: 'done', detail: [stated.length ? `applies ${stated.map((item) => item.value).join(', ')}` : '', required.length ? `required filters present: ${required.map((item) => item.text).join(', ')}` : '', applied ? `filters on ${applied}` : ''].filter(Boolean).join('; ') || 'read-only and in scope' });
        return {
          ...chosen,
          sql: withRowGuard(chosen.sql, (deps.maxRows ?? 500) + 1),
          proof: [
            ...chosen.proof,
            ...(applied ? [`applied on the data: ${applied}`] : []),
            ...(stated.length ? [`stated values applied: ${stated.map((item) => item.value).join(', ')}`] : []),
            ...(required.length ? [`required filters present: ${required.map((item) => item.text).join(', ')}`] : []),
            ...joinHints.filter((hint) => joinHintUsed(chosen.sql, hint.keys)).map((hint) => `joined as the ${hint.certified ? 'certified' : 'declared (not validated)'} relationship ${hint.name} says`),
            ...unnamed.map((item) => `caveat: the rows are grouped by ${item.key}, an internal key; ${item.labelRelation.split('.').pop()!.replace(/"/g, '')}.${item.label} names them, and the statement could not be made to show it`),
          ],
        };
      };
      // WHERE A STATED VALUE LIVES. A name the question states ("Splunk") is
      // looked for in the stored values of text columns the project allows to
      // be searched (agent.runtimeValueGrounding.searchSafeColumns). The probe
      // answers only whether the value occurs, never what else is stored, and
      // a column nobody allowlisted is never read.
      const textValues = stated.filter((item) => item.kind === 'text').slice(0, 3);
      if (textValues.length > 0 && connection) {
        const allowed = deps.literalProbeAllowed;
        const chosen = new Set(relations.map((relation) => physicalRelationIdentity(relation)));
        const asked = relevanceWords([`${question} ${open} ${contextText}`], true);
        const candidates: Array<{ relation: string; column: string; rank: number }> = [];
        if (allowed) {
          for (const relation of view.source?.relations ?? []) {
            const name = relation.binding ? physicalRelationText(relation.binding) : [relation.schema, relation.name].filter(Boolean).join('.');
            for (const column of [...relation.columns, ...(relation.embeddedColumns ?? [])]) {
              if (column.dataType && !/char|text|string|variant|array|json|object/i.test(column.dataType)) continue;
              if (!allowed(name, column.name)) continue;
              const overlap = [...relevanceWords([column.name, column.description], true)].filter((word) => asked.has(word)).length;
              candidates.push({ relation: name, column: column.name, rank: (chosen.has(physicalRelationIdentity(name)) ? 10 : 0) + (reachesReading(name) ? 5 : 0) + overlap });
            }
          }
        }
        const probes = candidates.sort((left, right) => right.rank - left.rank || left.relation.localeCompare(right.relation)).slice(0, 6);
        const probeDialect = getDialect(connection.driver);
        const quoteName = (value: string) => renderPhysicalIdentifier(value, connection.driver, (part) => probeDialect.quoteIdentifier(part));
        for (const item of textValues) {
          if (probes.length === 0) {
            hostStep({ phase: 'search', title: `Did not look for "${item.value}" in stored values`, state: 'missed', detail: 'no text column of these tables is allowlisted for value search (agent.runtimeValueGrounding.searchSafeColumns); the AI chooses the field from names and descriptions' });
            continue;
          }
          let found: { relation: string; column: string } | undefined;
          for (const probe of probes) {
            const relationSql = parsePhysicalIdentifier(probe.relation).map((part) => part.quoted ? `"${part.value.replace(/"/g, '""')}"` : quoteName(part.value)).join('.');
            // The value is the question's own text: quotes are escaped and a
            // wildcard in it is dropped, so it can neither break nor widen the probe.
            const pattern = item.value.toLowerCase().replace(/[%_]/g, '').replace(/'/g, "''");
            try {
              if (await probeOne(`SELECT 1 AS hit FROM ${relationSql} WHERE LOWER(CAST(${quoteName(probe.column)} AS VARCHAR)) LIKE '%${pattern}%'`)) { found = probe; break; }
            } catch { /* a column that cannot be read is not where the value lives */ }
          }
          if (!found) {
            hostStep({ phase: 'search', title: `Looked for "${item.value}" in stored values: not found`, state: 'missed', detail: `searched ${probes.map((probe) => `${probe.relation}.${probe.column}`).join(', ')}` });
            continue;
          }
          contextLines.push(`- the value "${item.value}" occurs in ${found.relation}.${found.column}`);
          hostStep({ phase: 'search', title: `Found where "${item.value}" is stored: ${found.relation}.${found.column}`, state: 'done' });
          if (!relations.some((relation) => physicalRelationIdentity(relation) === physicalRelationIdentity(found!.relation)) && relations.length < 6) {
            relations.push(found.relation);
            const hasColumns = current.entries.some((entry) => entry.kind === 'column' && (() => { const physical = entryPhysicalRelation(entry); return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(found!.relation); })());
            if (!hasColumns) {
              try {
                const described = await describeRelations([found.relation]);
                if (described.length > 0) { current = mergeDiscoveredRelations(current, described); requestVocabulary = current; }
              } catch { /* drafted over what is described */ }
            }
          }
        }
      }
      const shown = [...relations];
      const first = await attemptDraft();
      if (!first || !('declined' in first)) return finalize(first);
      // THE WIDER LOOK: a decline over the tables first chosen is not a
      // decline over the project. Search every table for a column the missing
      // words name, add what is found, and draft once more.
      const words = missingFieldWords(`${first.declined} ${open}`);
      const entityTexts = modelingEntityTexts(deps.getManifest().manifest);
      let wider: string[] = [];
      try {
        const source = view.source ?? (await baseSourceFor(connection)).source;
        // A missing FIELD is found by its column, not by a table's name.
        const fromCatalog = catalogPick(words.join(' '), relations, 3, ['dbt_column']);
        wider = rankByReach([...fromCatalog, ...relationsWithColumnWords(source, words, `${question} ${open} ${contextText}`, [...relations, ...fromCatalog], 6, (name) => entityTexts.filter((item) => sameRelation(item.relation, name)).map((item) => item.text).join(' ') || undefined)]).slice(0, 3);
      } catch { wider = []; }
      if (wider.length > 0) {
        try {
          const found = await describeRelations(wider);
          if (found.length > 0) {
            current = mergeDiscoveredRelations(current, found);
            requestVocabulary = current;
          }
        } catch { /* only tables already described can be added */ }
        wider = wider.filter((relation) => current.entries.some((item) => item.kind === 'column' && (() => { const physical = entryPhysicalRelation(item); return physical !== undefined && physicalRelationIdentity(physical) === physicalRelationIdentity(relation); })()));
      }
      if (wider.length === 0) {
        hostStep({ phase: 'search', title: 'Searched every table for the missing field: none has it', state: 'missed', detail: `looked for ${words.slice(0, 4).join(', ') || 'the missing field'} beyond ${shown.join(', ')}` });
        return { declined: `${first.declined.replace(/[.\s]+$/, '')} (searched ${shown.join(', ')}, and no other table has a column for ${words.slice(0, 3).join(', ') || 'it'})` };
      }
      relations = [...relations, ...wider];
      hostStep({ phase: 'search', title: `Searched every table for the missing field: found ${wider.join(', ')}`, state: 'done', detail: `looked for ${words.slice(0, 4).join(', ')}; the first draft over ${shown.join(', ')} found none` });
      const second = await attemptDraft(`A first draft over ${shown.join(', ')} found no field for this ("${first.declined.slice(0, 240)}"). The tables ${wider.join(', ')} have columns named for it and were added; use them, joining on a key both tables carry.`, 'widen');
      if (second && 'declined' in second) return { declined: `${second.declined.replace(/[.\s]+$/, '')} (searched ${relations.join(', ')})` };
      return finalize(second);
    };
    // THE SECOND LOOK at an AI-drafted result, where the project turns it on
    // (agent.resultReview; off by default): one small call that sees the
    // question, the SQL and the result's SHAPE (row count, each column's
    // distinct and NULL counts, repeated rows), never a value from it, and
    // names one defect or none. Certified and governed answers are not
    // reviewed: their SQL was compiled from definitions, not drafted.
    const makeResultReview = (state: AskRunState): NonNullable<AskPipelineRunInput['reviewResult']> => async ({ question, sql, result }) => {
      const messages: AgentMessage[] = [
        { role: 'system', content: RESULT_REVIEW_SYSTEM },
        { role: 'user', content: `QUESTION: ${question}\nSQL:\n${shownToModel(sql)}\nRESULT:\n${resultShapeForReview(result)}` },
      ];
      const started = Date.now();
      const trace = deps.dispatchOptions?.('draft', request);
      const dispatch: AskRunState['draftDispatches'][number] = { purpose: 'intent:review', ms: 0, attempt: state.draftDispatches.length + 1, label: 'review' };
      try {
        if (request.signal?.aborted) return undefined;
        const raw = await provider.generate(messages, { temperature: 0, ...(trace?.options ?? {}), ...(request.signal ? { signal: request.signal } : {}) });
        trace?.settle('ok');
        dispatch.reply = raw.slice(0, 600);
        const json = /\{[\s\S]*\}/.exec(raw);
        const verdict = json ? JSON.parse(json[0]) as { answers?: boolean; problem?: string } : undefined;
        const problem = verdict?.answers === false && typeof verdict.problem === 'string' && verdict.problem.trim() ? verdict.problem.trim().slice(0, 400) : undefined;
        dispatch.outcome = problem ? 'revise' : 'accepted';
        return problem ? { revise: problem } : undefined;
      } catch (error) {
        // A review that fails or cannot be read leaves the answer as it is.
        trace?.settle(request.signal?.aborted ? 'cancelled' : 'error', error);
        dispatch.outcome = 'error';
        return undefined;
      } finally {
        Object.assign(dispatch, { ms: Date.now() - started, at: Date.now(), promptChars: messages.reduce((sum, message) => sum + message.content.length, 0) });
        state.draftDispatches.push(dispatch);
      }
    };
    // THE PIPELINE AS ASK RUNS IT. A caller running a settled reading (Research)
    // overrides only what differs: the reading, the lane and where steps go.
    const runPipeline = (state: AskRunState, overrides: Partial<AskPipelineRunInput> = {}) => runAskPipeline({
      question: request.question,
      vocabulary: currentVocabulary(),
      provider: ledgered,
      describeRelations,
      explorationAuto: deps.autoExploration !== false,
      // Nothing governed at all (a warehouse-first project with no certified
      // block, metric or measure in scope): draft from the question itself.
      // ZLENS_ASK_DRAFT_FIRST=0 keeps the reading step first, for comparison.
      ...(readEnv('ZLENS_ASK_DRAFT_FIRST') !== '0' && warehouseFirstCatalog(deps.getManifest().manifest, deps.projectRoot) && !currentVocabulary().entries.some((entry) => entry.kind === 'block' || entry.kind === 'metric' || entry.kind === 'measure') ? { draftFirst: true } : {}),
      prepareDeps: { ...prepareDeps(connection ?? { driver: 'duckdb' } as ConnectionConfig, currentVocabulary, engine, request.signal), draftSql: makeDraftSql(state) },
      ...(resultReviewEnabled(deps.resultReviewConfigured?.() === true) ? { reviewResult: makeResultReview(state) } : {}),
      executeDeps: {
        maxRows: deps.maxRows ?? 500,
        ...(request.signal ? { signal: request.signal } : {}),
        validateCandidate: (candidate) => {
          // MetricFlow owns the physical SQL it compiles against its target.
          // Relational and review-required SQL are admitted only when their
          // statement names the same inspected bindings the drafter saw.
          if (!connection || (candidate.tier !== 'relational' && candidate.tier !== 'exploratory')) return;
          const runtimeSchema = runtimeSchemaForVocabulary(currentVocabulary());
          const unbound = currentVocabulary().entries.filter((entry) => entry.kind === 'relation' && !entry.physical?.binding);
          const usesUnbound = relationsInSql(candidate.sql).find((relation) => unbound.some((entry) => {
            const logical = entry.model ?? entry.name;
            return physicalRelationIdentity(relation) === physicalRelationIdentity(logical)
              || relation.toLowerCase().endsWith(`.${logical.toLowerCase()}`);
          }));
          if (usesUnbound) throw new Error(`SQL references ${usesUnbound}, whose physical database binding is ambiguous for this target. Refresh the relation metadata before executing.`);
          // The composer's own SQL is proven by what it READS: every qualified
          // relation it names must be one this request inspected, compared by
          // the warehouse's identifier rule. That proof needs no SQL parser; a
          // third-party parser that cannot read a dialect (three-part names on
          // SQLite, a window clause) must never veto a governed statement.
          // A DuckDB statement may leave the default database out
          // (`main.claim` for the inspected `acme_insurance.main.claim`),
          // exactly as the drafted-SQL check accepts it: one matcher for both.
          const foreign = relationsInSql(candidate.sql)
            .filter((relation) => parsePhysicalIdentifier(relation).length >= 2)
            .find((relation) => !inspectedRelationMatches(relation, runtimeSchema, connection.driver));
          if (foreign) throw new Error(`the frozen SQL reads ${foreign}, which this request did not inspect (it inspected ${runtimeSchema.map((table) => table.relation).join(', ')}). Use the exact bound physical relation.`);
          if (candidate.tier !== 'exploratory') return;
          // Drafted SQL was parsed and validated when it was drafted; the same
          // check is repeated on the frozen statement, and a parser limitation
          // falls back to the relation proof above rather than refusing.
          const validation = validateSqlAgainstLocalContext(candidate.sql, view.pack, {
            dialect: connection.driver,
            runtimeSchema,
            runtimeSchemaExact: true,
            executionTargetFingerprint: fingerprintText(connectionKey(connection)),
            enforceGenerationReadiness: false,
            positionalParameterCount: candidate.params?.length ?? 0,
          });
          if (!validation.ok && !/could not be parsed/i.test(validation.error)) throw new Error(`the frozen SQL is not bound to this execution target: ${validation.error}`);
        },
        run: async (sql, params, options) => {
          if (request.signal?.aborted) throw new Error('the request was cancelled before warehouse execution started');
          if (!connection) throw connectionError instanceof Error ? connectionError : new Error(String(connectionError ?? 'No database connection is configured.'));
          // A relation this connection has already proven it cannot see is
          // refused before SQL: the catalog lists it, the warehouse does not
          // have it, and a second round trip would say the same thing.
          const cacheKey = connectionKey(connection);
          const known = knownMissingRelation(cacheKey, sql);
          if (known) throw new Error(`'${known}' is known to be missing on this connection: the catalog lists it, the warehouse does not have it`);
          const started = Date.now();
          const executor = deps.executor as QueryExecutor & { executePositional?: QueryExecutor['executePositional'] };
          const span = deps.traceExecution?.(request, { name: 'sql.execute', sqlFingerprint: fingerprintText(`${sql}\n${JSON.stringify(params ?? [])}`), purpose: options.purpose ?? 'query', ...(options.tier ? { tier: options.tier } : {}) });
          let result: Awaited<ReturnType<QueryExecutor['executeQuery']>>;
          try {
            options.onWarehouseAttempt?.();
            result = typeof executor.executePositional === 'function'
              ? await executor.executePositional(sql, params ?? [], connection, { maxRows: options.maxRows, ...(options.signal ?? request.signal ? { signal: options.signal ?? request.signal } : {}), ...(request.runBudget ? { deadlineMs: request.runBudget.remainingMs() } : {}) })
              : await (async () => {
                if (params?.length) throw new Error('this warehouse executor cannot bind positional parameters');
                return executor.executeQuery(sql, [], {}, connection, { maxRows: options.maxRows, ...(options.signal ?? request.signal ? { signal: options.signal ?? request.signal } : {}), ...(request.runBudget ? { deadlineMs: request.runBudget.remainingMs() } : {}) });
              })();
          } catch (error) {
            options.onWarehouseResult?.('failed');
            span?.finish('error', { safeErrorCode: 'sql_failure' });
            // With a host, the warehouse's diagnosis (its own words stay in the host's log).
            const message = hostedWarehouseError(error)?.warehouseDiagnosis ?? (error instanceof Error ? error.message : String(error));
            recordRelationEvidence(cacheKey, sql, classifyWarehouseError(message, { sql }), message);
            throw error;
          }
          options.onWarehouseResult?.('succeeded');
          recordRelationEvidence(cacheKey, sql);
          span?.finish('ok', { rowCount: result.rowCount, resultFingerprint: createHash('sha256').update(JSON.stringify({ columns: result.columns, rows: result.rows })).digest('hex') });
          // An executor may describe columns as objects or as bare names.
          const columns = result.columns.length
            ? (result.columns as Array<string | { name?: string }>).map((column, index) => typeof column === 'string' ? column : column?.name ?? Object.keys(result.rows[0] ?? {})[index] ?? `column_${index + 1}`)
            : Object.keys(result.rows[0] ?? {});
          // Calendar cells leave the warehouse as JS Dates; every consumer
          // (narration, persistence, the table) must read the same instant,
          // never a host-timezone rendering of it.
          const rows = (result.rows as Array<Record<string, unknown>>).map((row) => normalizeExecutedRow(row));
          return { columns, rows, rowCount: result.rowCount, executionTimeMs: result.executionTimeMs ?? Date.now() - started, ...(result.truncated ? { truncated: true } : {}) };
        },
      },
      ...(prior ? { prior: prior.intent, ...(prior.executed === false ? { priorExecuted: false } : {}), ...(prior.summary ? { priorAnswerSummary: prior.summary } : {}), ...(priorMask ? { hidePriorValues: true } : {}) } : {}),
      ...(deps.guidance?.(request) ? { guidance: deps.guidance(request) } : {}),
      // Member spellings the warehouse holds are values: looked up only where values may reach this model.
      ...(valuesAllowed && connection && deps.probeLiteral && deps.literalProbeAllowed ? { groundLiterals: (intent: AnalyticalIntentV1) => groundIntentLiterals(intent, currentVocabulary(), connection, tracedProbes(deps, request)) } : {}),
      // A name that matched nothing exactly may still name members of the same
      // column the query already read.
      suggestMembers: async (ref: string, literal: string) => {
        if (!valuesAllowed) return [];
        const entry = currentVocabulary().get(ref);
        const relation = entryPhysicalRelation(entry);
        const column = entry?.physical?.column;
        if (!connection || !relation || !column || !entry || entry.roles.includes('time') || entry.roles.includes('numeric') || entry.roles.includes('boolean')) return [];
        const executor = deps.executor as QueryExecutor & { executePositional?: QueryExecutor['executePositional'] };
        if (typeof executor.executePositional !== 'function') return [];
        const sql = memberCandidatesSql(relation, column, (name) => renderPhysicalIdentifier(name, connection?.driver, (value) => `"${value.replace(/"/g, '""')}"`));
        const found = await executor.executePositional(sql, [`%${literal.toLowerCase()}%`], connection, { maxRows: 8, ...(request.signal ? { signal: request.signal } : {}), ...(request.runBudget ? { deadlineMs: request.runBudget.remainingMs() } : {}) });
        return (found.rows as Array<Record<string, unknown>>)
          .map((row) => row.member)
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      },
      // The option the user clicked is a governed ref, and the turn that
      // follows must carry it: a selection that only reaches the prompt can be
      // ignored, and the question then comes back a second time.
      ...(selectedMeaning(request, vocabulary) ? { selection: selectedMeaning(request, vocabulary)! } : {}),
      // An identity the user settled is carried the same way: the option names
      // the dimension and the member, so the next turn reads that person.
      ...(selectedMember(request) ? { memberSelection: selectedMember(request)! } : {}),
      ...(view.context ? { context: view.context } : {}),
      ...(conversationMemory ? { conversation: conversationMemory } : {}),
      explorationOptIn: explorationOptIn(request),
      // Research branches phrase hypotheses ("because", "drivers"); the
      // full-question clause check is for questions a person asked.
      clauseCoverage: request.requestedMode !== 'research',
      ...(request.signal ? { signal: request.signal } : {}),
      onVocabularyUpdate: (next) => { requestVocabulary = next; },
      // Room for one interpreter retry after a 90 s provider timeout plus the
      // rest of the turn; the engine's own hard deadline still wins.
      deadlineMs: request.runBudget ? Math.max(1, request.runBudget.remainingMs()) : 240_000,
      preparationCache,
      cacheScope: `${deps.getManifest().snapshotId}|${connection ? connectionKey(connection) : 'none'}|${vocabulary.fingerprint}`,
      ...(deps.buildIdentity ? { build: deps.buildIdentity() } : {}),
      trace: (event) => emit({ type: 'executor.started', message: `${event.stage}${typeof event.detail === 'number' ? ` ${event.detail} ms` : ''}`, route }),
      onStep: (entry) => emit({ type: 'executor.started', message: entry.title, route, payload: { askStep: entry } }),
      ...overrides,
    });
    // How long the context took to assemble, beside the stages the pipeline
    // timed itself: the receipt is the only place a latency claim can be read from.
    const keepRunEvidence = (outcome: PipelineOutcome, state: AskRunState, withContext: boolean) => {
      if (!('receipt' in outcome) || !outcome.receipt) return;
      if (withContext) outcome.receipt.timings.context = contextMs;
      outcome.receipt.story = [...state.steps, ...(outcome.receipt.story ?? [])].sort((left, right) => left.at - right.at);
      outcome.receipt.dispatches.push(...state.draftDispatches);
      if (state.hostChecks.length) outcome.receipt.checks = [...(outcome.receipt.checks ?? []), ...state.hostChecks];
      // The joins an AI-written answer made, each with the relationship it followed.
      if (outcome.kind === 'answered' && outcome.candidate.tier === 'exploratory' && state.hostJoins?.length && outcome.receipt.context?.used && outcome.receipt.context.used.joins.length === 0) {
        outcome.receipt.context.used.joins = state.hostJoins;
      }
      outcome.receipt.physicalBindings = runtimeSchemaForVocabulary(currentVocabulary()).map((table) => ({ relation: table.relation, completeness: table.columnCompleteness ?? 'partial', columns: table.columns.length, targetFingerprint: connection ? fingerprintText(connectionKey(connection)) : undefined }));
    };
    // Settled readings run side by side each extend the request vocabulary;
    // neither may drop the relations the other described.
    const mergeVocabulary = (next: VocabularyIndex) => {
      const kept = requestVocabulary.entries.filter((entry) => !next.get(entry.ref));
      requestVocabulary = kept.length ? next.withEntries(kept) : next;
    };
    const scope: AskRequestScope = {
      request, route, contextMs, contextSteps: hostSteps,
      manifest: () => deps.getManifest().manifest,
      vocabulary: currentVocabulary,
      semanticLayer: () => deps.getSemanticLayer(),
      hasConnection: Boolean(connection),
      read: async (question, runOptions = {}) => {
        const onStep = runOptions.onStep ?? liveStep;
        const state = newRunState(onStep);
        const outcome = await runPipeline(state, {
          // A clarification the user picked for this question applies to its reading.
          question, stopAfter: 'reading', clauseCoverage: false,
          ...(runOptions.guidance ? { guidance: [deps.guidance?.(request), runOptions.guidance].filter(Boolean).join('\n\n') } : {}),
          explorationAuto: (runOptions.allowAiSql ?? true) && deps.autoExploration !== false,
          ...(runOptions.deadlineMs ? { deadlineMs: runOptions.deadlineMs } : {}),
          trace: undefined, onStep, onVocabularyUpdate: mergeVocabulary,
        });
        keepRunEvidence(outcome, state, false);
        return outcome;
      },
      runIntent: async (intent, runOptions) => {
        const onStep = runOptions.onStep ?? (() => undefined);
        const state = newRunState(onStep);
        const outcome = await runPipeline(state, {
          question: intent.reading, resolvedIntent: { intent, origin: runOptions.origin ?? 'research_program' },
          prior: undefined, priorExecuted: undefined, priorAnswerSummary: undefined, selection: undefined, memberSelection: undefined, conversation: undefined,
          explorationOptIn: false, explorationAuto: runOptions.allowAiSql && deps.autoExploration !== false, clauseCoverage: false,
          ...(runOptions.deadlineMs ? { deadlineMs: runOptions.deadlineMs } : {}),
          trace: undefined, onStep, onVocabularyUpdate: mergeVocabulary,
        });
        keepRunEvidence(outcome, state, false);
        return outcome;
      },
      dispatch: async (purpose, messages) => {
        const trace = deps.dispatchOptions?.(purpose, request);
        try {
          if (request.signal?.aborted) throw new Error('the request was cancelled before the AI call started');
          const text = await provider.generate(messages, { temperature: 0, ...(trace?.options ?? {}), ...(request.signal ? { signal: request.signal } : {}) });
          trace?.settle('ok');
          return text;
        } catch (error) {
          trace?.settle(request.signal?.aborted ? 'cancelled' : 'error', error);
          throw error;
        }
      },
    };
    const answer = async (): Promise<AgentRouteExecutorResult> => {
      const outcome = await runPipeline(requestState);
      keepRunEvidence(outcome, requestState, true);
      // An unscoped question whose context all came from one domain: Ask offers
      // to scope to it, and never narrows on that guess by itself.
      if ('receipt' in outcome && outcome.receipt?.context && !view.envelope.activeDomain && view.pack?.domainBriefing?.domainId) {
        outcome.receipt.context.suggestedDomain = view.pack.domainBriefing.domainId;
      }
      // A ref the interpreter named that the whole inventory holds but this
      // envelope does not is OUT OF SCOPE, not "does not exist": the reader is
      // told which domain owns it and what admits it — never its data.
      if (outcome.kind === 'failed' && outcome.stage === 'resolve' && outcome.receipt.failure?.reason === 'invalid' && outcome.receipt.failure.problems?.length) {
        const explained = explainOutOfScope(outcome.receipt.failure.problems, await baseIndexFor(connection), view.envelope);
        if (explained) {
          outcome.message = explained.message;
          outcome.text = `This could not be completed while reading the question: ${explained.message}`;
          outcome.receipt.failure = { ...outcome.receipt.failure, reason: 'out_of_scope', message: explained.message };
          outcome.receipt.outOfScope = explained.refs;
        }
      }
      // The same for a gap: a clause the reading could not place may name an
      // object another domain owns; the gap says so beside what it already says.
      if (outcome.kind === 'gap' && (outcome.gap === 'not_modeled' || outcome.gap === 'ambiguous' || outcome.gap === 'not_retrieved')) {
        const explained = explainOutOfScopeWords(`${request.question} ${outcome.message}`, await baseIndexFor(connection), currentVocabulary(), view.envelope);
        if (explained) {
          outcome.text = `${outcome.text} ${explained.message}`;
          outcome.receipt.outOfScope = explained.refs;
        }
      }
      return toExecutorResult(runId, outcome, startedAt);
    };
    return { scope, answer };
  };

  const execute: AgentRouteExecutor = async (context) => {
    const opened = await openRequest(context);
    return 'blocked' in opened ? opened.blocked : opened.answer();
  };
  const catalogNames = (): Set<string> => {
    const names = new Set<string>();
    const add = (name: unknown) => { if (typeof name === 'string' && name.trim()) names.add(name.trim().replace(/^["`[]|["`\]]$/g, '').toLowerCase()); };
    let source = vocabularyCache?.source;
    if (!source) {
      try { source = buildVocabularySource(sourceInputFor(undefined)); } catch { source = undefined; }
    }
    const relations = [...(source?.relations ?? []), ...[...probedColumns.values()].map((entry) => entry.relation).filter((relation): relation is ProbedRelation => Boolean(relation))];
    for (const relation of relations) {
      for (const part of [relation.database, relation.schema, relation.name]) add(part);
      for (const column of [...(relation.columns ?? []), ...((relation as { embeddedColumns?: Array<{ name: string }> }).embeddedColumns ?? [])]) add(column.name);
    }
    for (const list of [source?.metrics, source?.measures, source?.dimensions, source?.entities]) {
      for (const item of (list ?? []) as Array<{ name: string; model?: string; physical?: { column?: string } }>) { add(item.name); add(item.model); add(item.physical?.column); }
    }
    for (const model of source?.models ?? []) { add(model.name); for (const part of (model.relation ?? '').split('.')) add(part); }
    for (const block of source?.blocks ?? []) { add(block.name); for (const output of block.contract?.outputs ?? []) add(output); }
    return names;
  };

  return {
    execute,
    catalogNames,
    openScope: async (context, options) => {
      const opened = await openRequest(context, options);
      return 'blocked' in opened ? opened : { scope: opened.scope };
    },
  };
}

function explorationOptIn(request: AgentRunRequest): boolean {
  const workspace = request.workspaceContext && typeof request.workspaceContext === 'object' ? request.workspaceContext as Record<string, unknown> : {};
  return workspace.explorationOptIn === true || request.requestedMode === 'sql';
}

/** Every physical call, corrective ones included, passes through the run's ledger. */
function withLedger(provider: AgentProvider, deps: AskPipelineHostDeps, request: AgentRunRequest): AgentProvider {
  if (!deps.dispatchOptions) return provider;
  let calls = 0;
  return {
    name: provider.name,
    available: () => provider.available(),
    generate: async (messages, options) => {
      calls += 1;
      const trace = deps.dispatchOptions!(calls === 1 ? 'resolve' : 'correct', request);
      try {
        // The host ledger contributes egress accounting only. It may not
        // replace the inherited cancellation signal carried by Ask.
        const text = await provider.generate(messages, { ...options, ...trace.options, ...(options?.signal ? { signal: options.signal } : {}) });
        trace.settle('ok');
        return text;
      } catch (error) {
        trace.settle('error', error);
        throw error;
      }
    },
  };
}

const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

/**
 * A saved Ask scope that names a domain, subject area or skill the project no
 * longer has. Answering unscoped under a "Scoped to X" chip misleads, so the
 * run stops and says what to clear. Undefined when the scope resolves or is empty.
 */
export function askScopeProblem(manifest: DQLManifest | undefined, workspaceContext: unknown, snapshotId = ''): string | undefined {
  const scope = askScopeFromWorkspace(workspaceContext);
  if (!manifest || (!scope.domain && !scope.modelAreaId && !scope.skillRefs?.length)) return undefined;
  try {
    resolveDomainContextEnvelope({ manifest, activeDomain: scope.domain ?? null, purpose: scope.purpose, modelAreaId: scope.modelAreaId, skillRefs: scope.skillRefs, source: scope.domain ? 'explicit_ui' : 'inferred', snapshotId });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^Unknown domain:/.test(message)) return `Ask is scoped to the domain "${scope.domain}", which no longer exists. Clear the scope or pick another domain, then ask again.`;
    if (/model area/i.test(message)) return `Ask is scoped to a subject area that no longer exists${scope.domain ? ` in ${scope.domain}` : ''}. Clear the scope or pick another subject area, then ask again.`;
    if (/skill/i.test(message)) return 'Ask is pinned to a skill that no longer exists. Clear the scope, then ask again.';
    return undefined;
  }
}

function scopeFailure(runId: string, message: string, startedAt: number): AgentRouteExecutorResult {
  const result = failure(runId, message, 'execution_error', startedAt);
  const receipt = result.askPipelineReceipt as PipelineReceipt;
  receipt.story = [{ version: 1, phase: 'read', title: 'The Ask scope no longer exists', detail: message, state: 'failed', at: Date.now() }];
  return {
    ...result,
    answerRefusalCode: 'modeling_gap',
    artifacts: (result.artifacts ?? []).map((artifact) => ({ ...artifact, title: 'The Ask scope no longer exists' })),
    nextActions: [{ id: 'clear-scope', label: 'Clear the Ask scope', route: 'generated_answer' }],
  };
}

function namedBlockFailure(runId: string, message: string, startedAt: number): AgentRouteExecutorResult {
  const result = failure(runId, message, 'execution_error', startedAt);
  const receipt = result.askPipelineReceipt as PipelineReceipt;
  receipt.failure = { stage: 'prepare', reason: 'named_block_not_served', message };
  receipt.tiers = [{ round: 0, tier: 'certified', outcome: 'refused', detail: message.slice(0, 580) }];
  receipt.story = [{ version: 1, phase: 'tier', title: 'The saved query the question names is not one Ask answers from', detail: message, state: 'missed', at: Date.now() }];
  return {
    ...result,
    answerRefusalCode: 'modeling_gap',
    artifacts: (result.artifacts ?? []).map((artifact) => ({ ...artifact, title: 'The named saved query was not used' })),
    nextActions: [],
  };
}

function failure(runId: string, message: string, code: 'provider_error' | 'execution_error', startedAt: number, options: { providerMissing?: boolean } = {}): AgentRouteExecutorResult {
  // Even a run that stops before reading the question tells the reader where
  // it stopped and why, in its own words, never a generic "not worked out".
  const receipt: PipelineReceipt = {
    version: 1, vocabularyFingerprint: '', dispatches: [], candidates: [], refusals: [], tiers: [],
    timings: { total: Date.now() - startedAt },
    failure: { stage: 'resolve', reason: code, message },
    story: [{ version: 1, phase: 'read', title: options.providerMissing ? 'No AI provider is connected' : code === 'provider_error' ? 'Could not reach an AI model' : 'Could not run the query', detail: message, state: 'failed', at: Date.now() }],
  };
  return {
    askPipelineReceipt: receipt,
    summary: message, answer: message, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: code,
    artifacts: [{ id: `${runId}:diagnostic`, kind: 'answer', title: options.providerMissing ? 'Ask needs an AI provider' : 'Could not answer', trustState: 'blocked', payload: options.providerMissing
      ? { kind: 'no_answer', text: message, answer: message, refusalCode: 'provider_error', providerMissing: true }
      : { kind: 'no_answer', text: message, answer: message, executionError: message } }],
    evaluations: [], nextActions: [{ id: 'retry-after-provider', label: options.providerMissing ? 'Ask again after connecting an AI provider' : 'Retry after fixing the AI model settings', route: 'generated_answer' }],
    telemetry: { version: 1, stageDurationsMs: { total: Date.now() - startedAt }, providerRoundTrips: 0, toolCalls: 0, sqlExecutions: 0, repairs: 0, egressReceipts: 0 },
  };
}

/** How a gap is headed: no matching data is not a modeling gap. */
/**
 * The clarification option the user picked, when it names something this
 * vocabulary holds. A selection the vocabulary cannot resolve is ignored here
 * (the router validates the id separately); it is never turned into SQL.
 */
export function selectedMember(request: AgentRunRequest): { ref: string; values: string[] } | undefined {
  const id = request.selectedEvidenceId?.trim();
  return id ? parseMemberOption(id) : undefined;
}

/**
 * The clarification option the user picked, when it names something this
 * vocabulary holds.
 */
export function selectedMeaning(request: AgentRunRequest, vocabulary: VocabularyIndex): { ref: string; label?: string } | undefined {
  const id = request.selectedEvidenceId?.trim();
  if (!id) return undefined;
  const entry = vocabulary.get(id) ?? vocabulary.resolve(id);
  return entry ? { ref: entry.ref, ...(entry.label ? { label: entry.label } : {}) } : undefined;
}

/**
 * The members of one column whose stored value CONTAINS a literal. Asked only
 * after a query that already filtered that column came back empty, so it opens
 * nothing new: it reads the column the answer was about, bounded to a handful
 * of values, and text columns only. "Curry" is not missing from the data — it
 * names two players.
 */
export function memberCandidatesSql(relation: string, column: string, quote: (name: string) => string, limit = 7): string {
  // `split('.')` turns "Db.With.Dot" into three names. Reuse the physical
  // parser used by probing and drafting; quoted components remain one exact
  // warehouse identifier while unquoted components use the connector dialect.
  const qualified = parsePhysicalIdentifier(relation)
    .map((part) => part.quoted ? `"${part.value.replace(/"/g, '""')}"` : quote(part.value))
    .join('.');
  // Shortest first: a member spelled exactly like the name, whatever its
  // capitals, is the shortest value containing it and is never cut by LIMIT.
  return `SELECT DISTINCT ${quote(column)} AS member FROM ${qualified} WHERE ${quote(column)} IS NOT NULL AND LOWER(CAST(${quote(column)} AS VARCHAR)) LIKE ? ORDER BY LENGTH(CAST(${quote(column)} AS VARCHAR)), 1 LIMIT ${limit}`;
}

/**
 * THE TWO THINGS A RELATIONSHIP MUST PROVE. A key that repeats in the relation
 * carrying the label multiplies the facts joined to it, and a key the label
 * relation does not hold drops rows silently — so a join nobody declared is
 * admitted only when the warehouse says the key is unique there AND every key
 * the facts carry appears there. One statement answers both.
 */


/** A key both relations spell the same way, and that reads like an identifier. */
export function sharedKeyColumn(factColumns: Iterable<string>, labelColumns: Iterable<string>): string | undefined {
  const label = new Map([...labelColumns].map((column) => [column.toLowerCase(), column]));
  const shared = [...factColumns].filter((column) => label.has(column.toLowerCase()));
  return shared.find((column) => /(^|_)(id|key)$/i.test(column)) ?? undefined;
}

/**
 * The key a warehouse proof tests between two relations: a key column both
 * carry under one name, or a key named for the table it points at
 * (OPPORTUNITY_ID on the facts, ID on SFDC.OPPORTUNITY). A candidate is only a
 * candidate; the proof of uniqueness and coverage decides.
 */
export function sharedKeyPair(factColumns: Iterable<string>, labelColumns: Iterable<string>, labelRelation?: string): { from: string; to: string } | undefined {
  const facts = [...factColumns];
  const labels = [...labelColumns];
  const same = sharedKeyColumn(facts, labels);
  if (same) return { from: same, to: same };
  const table = labelRelation ? parsePhysicalIdentifier(labelRelation).pop()?.value.toLowerCase() : undefined;
  const labelId = labels.find((column) => /^id$/i.test(column));
  if (!table || !labelId) return undefined;
  const singular = table.endsWith('ies') ? `${table.slice(0, -3)}y` : table.endsWith('s') && !table.endsWith('ss') ? table.slice(0, -1) : table;
  const from = facts.find((column) => [`${singular}_id`, `${table}_id`].includes(column.toLowerCase()));
  return from ? { from, to: labelId } : undefined;
}

/**
 * The context ledger, in one line the reader can check: how many governed
 * objects the question was read against and in which domain, how many were
 * shown, which skills and hints were selected, and what the answer used.
 */
export function contextEvaluation(receipt: { context?: ContextLedgerV1 }): Array<{ id: string; label: string; passed: boolean; severity: 'info'; message: string }> {
  const ledger = receipt.context;
  if (!ledger?.admitted) return [];
  const admitted = Object.values(ledger.admitted.byKind).reduce((sum, count) => sum + count, 0);
  const shown = Object.values(ledger.rendered?.byKind ?? {}).reduce((sum, count) => sum + count, 0);
  const where = ledger.envelope?.activeDomain ? ` in ${ledger.envelope.activeDomain}` : '';
  const shortName = (ref: string) => ref.replace(/^(skill|hint):/, '').split('::').pop() ?? ref;
  const skills = ledger.rendered?.skills.length ? `; skill${ledger.rendered.skills.length === 1 ? '' : 's'} ${ledger.rendered.skills.map(shortName).join(', ')}` : '';
  const hints = ledger.rendered?.hints.length ? `; approved correction${ledger.rendered.hints.length === 1 ? '' : 's'} ${ledger.rendered.hints.map(shortName).join(', ')}` : '';
  const unrendered = ledger.selected?.unrendered.length ? `; ${ledger.selected.unrendered.length} of the refs the reading used were found beyond the cards shown` : '';
  const used = ledger.used?.tier ? `; answered on the ${ledger.used.tier} tier${ledger.used.engine ? ` (${ledger.used.engine})` : ''}` : '';
  const joins = (ledger.used?.joins ?? []).map((join) => join.authority === 'proven_default'
    ? 'a join proven on the warehouse (structurally safe on this snapshot and connection; not a certified business relationship)'
    : join.source === 'semantic_layer' ? 'a semantic-layer join' : `a certified relationship${join.relationshipId ? ` (${shortName(join.relationshipId)})` : ''}`);
  const joined = joins.length ? `; joins: ${[...new Set(joins)].join(', ')}` : '';
  return [{ id: 'pipeline-context', label: 'Context read', passed: true, severity: 'info', message: `Read against ${admitted} governed objects${where} (${shown} shown)${skills}${hints}${unrendered}${used}${joined}.` }];
}

export function gapPresentation(gap: Extract<PipelineOutcome, { kind: 'gap' }>['gap'], message?: string): { title: string; code: 'policy_blocked' | 'ambiguous' | 'no_data' | 'modeling_gap' } {
  if (gap === 'denied') return { title: 'Blocked by policy', code: 'policy_blocked' };
  if (gap === 'ambiguous') return { title: 'One detail is missing', code: 'ambiguous' };
  // The heading names what actually came back empty. A card titled "for that
  // period" over a body about a member nobody could find contradicts itself,
  // and the reader believes the heading.
  if (gap === 'not_retrieved') {
    if (message && /no rows matched\s+"/.test(message)) return { title: 'No matching data for that name', code: 'no_data' };
    if (message && /no rows matched the restriction/.test(message)) return { title: 'No matching data under those filters', code: 'no_data' };
    return { title: 'No matching data for that period', code: 'no_data' };
  }
  return { title: 'No answer', code: 'modeling_gap' };
}

/**
 * A certified block, compiled and bound the way Block Studio, Apps and the
 * Notebook run it: values from the shared invocation contract (declared
 * defaults, values the question states outright, explicit inputs), SQL
 * lowered by the DQL compiler to positional placeholders, and the bound
 * values in placeholder order. No template placeholder survives.
 */
export function prepareBlockForAsk(projectRoot: string, entry: VocabularyEntry | undefined, context: { question?: string; parameters?: Record<string, unknown> }, driver?: string): PreparedBlock | undefined {
  if (!entry || entry.kind !== 'block') return undefined;
  if (!entry.sourcePath) {
    // No declaration on disk: the raw query is only usable without parameters.
    return entry.sql && !/\$\{/.test(entry.sql) ? { sql: entry.sql, params: [], parameters: [] } : { error: 'the block declaration is not available to bind its parameters' };
  }
  let source: string;
  try {
    source = readFileSync(join(projectRoot, entry.sourcePath), 'utf8');
  } catch (error) {
    return { error: `the block source could not be read (${entry.sourcePath}): ${error instanceof Error ? error.message : String(error)}` };
  }
  const invocation = prepareBlockInvocation({ block: entry.name, source, question: context.question, surface: 'ask_ai', ...(context.parameters ? { parameters: context.parameters, parameterSources: Object.fromEntries(Object.keys(context.parameters).map((name) => [name, 'question' as const])) } : {}) });
  if (invocation.errors.length) return { error: invocation.errors.join(' '), unresolved: invocation.unresolvedParameters };
  if (invocation.unresolvedParameters.length) return { error: `it still needs values for ${invocation.unresolvedParameters.join(', ')}`, unresolved: invocation.unresolvedParameters };
  let plan: ReturnType<typeof buildExecutionPlan>;
  try {
    plan = buildExecutionPlan({ id: `ask-${entry.name}`, type: 'dql', source, title: entry.name }, { ...(driver ? { driver } : {}), parameters: invocation.values });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!plan?.sql) return { error: 'the block produced no executable SQL' };
  const specs = [...plan.sqlParams].sort((left, right) => left.position - right.position);
  // The invocation's resolved values win (a question's "top 3" over the declared default); the plan's variables are the declared defaults.
  const params = specs.map((spec) => (invocation.values[spec.name] !== undefined ? invocation.values[spec.name] : plan.variables[spec.name] !== undefined ? plan.variables[spec.name] : spec.literalValue));
  const missing = specs.filter((spec, index) => params[index] === undefined).map((spec) => spec.name);
  if (missing.length) return { error: `no value bound for ${missing.join(', ')}`, unresolved: missing };
  if (/\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}/.test(plan.sql)) return { error: 'a template placeholder survived compilation' };
  const sources = new Map(invocation.resolvedParameters.map((parameter) => [parameter.name, parameter.source]));
  return {
    sql: plan.sql,
    params,
    parameters: specs.map((spec, index) => ({ name: spec.name, position: spec.position, value: params[index], source: sources.get(spec.name) ?? 'default' })),
    ...(entry.contract?.outputs?.length ? { outputs: entry.contract.outputs } : {}),
    source,
    sourcePath: entry.sourcePath,
  };
}

/**
 * What a connection has proven it cannot see. The catalog is a snapshot of the
 * project's models; the connection is the warehouse as it is right now. When
 * the two disagree the disagreement is durable for the session: asking the
 * same missing table again costs another failed round trip and tells the
 * reader nothing new, so the second question is refused before SQL.
 */
interface MissingRelationEvidence {
  expiresAt: number;
  /** Original warehouse spelling for an actionable, non-quoted diagnostic. */
  relation: string;
}

const MISSING_RELATION_TTL_MS = 60_000;
const missingByConnection = new Map<string, Map<string, MissingRelationEvidence>>();

/** A stable key for a connection: the account and database, never a credential. */
export function connectionKey(connection: ConnectionConfig): string {
  // Keep cache reuse scoped to the execution identity, never a credential.
  // Snowflake role/warehouse/database changes can alter INFORMATION_SCHEMA
  // visibility without changing account or host, so omitting them turns a
  // short-lived observation into the wrong target's metadata.
  const candidate = connection as ConnectionConfig & Record<string, unknown>;
  const fields: Array<[string, unknown]> = [
    ['driver', connection.driver], ['account', connection.account], ['host', connection.host], ['port', connection.port],
    ['database', connection.database ?? connection.catalog], ['schema', connection.schema], ['warehouse', connection.warehouse], ['role', connection.role],
    ['user', connection.username ?? candidate.user], ['filepath', connection.filepath], ['project', connection.projectId],
    ['runtimeGeneration', candidate.runtimeGeneration ?? candidate.runtime_generation ?? candidate.generationId],
    ['currentDatabase', candidate.currentDatabase], ['currentSchema', candidate.currentSchema],
  ];
  return fields
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => `${name}=${String(value)}`)
    .join('|');
}

/** The schema a warehouse-first draft may read whole: about ten thousand tokens. */
const WHOLE_SCHEMA_CHARS = 40_000;
/** The same with the column value profile beside each column: about fifteen thousand tokens. */
const WHOLE_SCHEMA_WITH_VALUES_CHARS = 60_000;

/** The reason the result review sent a statement back (pipeline.ts words it). */
const REVIEW_REVISION = /^the statement ran and returned \d+ rows?, but the result does not answer the question as asked/;

/**
 * Whether the previous statement RAN and comes back for another look (the
 * result review's revision on every project; an empty result too on a
 * warehouse-first project) rather than being rejected by the warehouse. A dbt
 * project's empty-result redraft keeps its recorded wording.
 */
function ranWithoutError(error: string, warehouseFirst: boolean): boolean {
  return REVIEW_REVISION.test(error) || (warehouseFirst && /^the statement ran\b/.test(error));
}

/**
 * WHAT A RESULT LOOKS LIKE, without what it says. Row count, each column's
 * distinct and NULL counts, repeated rows: enough to see a date that did not
 * parse (a column entirely NULL), four rows where one number was asked, or a
 * name the question asked for and the result lacks. No value from the result
 * is included: an ordinary Ask run releases no result rows to the provider
 * (provider-egress.ts), whatever the project configures.
 */
export function resultShapeForReview(result: { columns?: Array<string | { name: string }>; rows: Array<Record<string, unknown>>; rowCount: number }): string {
  const rows = result.rows.slice(0, 500);
  const names = (result.columns ?? []).map((column) => typeof column === 'string' ? column : column.name);
  const columns = names.length ? names : Object.keys(rows[0] ?? {});
  const lines = [`rows: ${result.rowCount}${result.rowCount > rows.length ? ` (shape read from the first ${rows.length})` : ''}`];
  for (const column of columns) {
    const values = rows.map((row) => row[column]);
    const nulls = values.filter((value) => value === null || value === undefined).length;
    const distinct = new Set(values.filter((value) => value !== null && value !== undefined).map((value) => typeof value === 'bigint' ? value.toString() : JSON.stringify(value) ?? String(value))).size;
    lines.push(`- ${column}: ${nulls === values.length && values.length > 0 ? 'every value NULL' : `${distinct} distinct${nulls ? `, ${nulls} NULL` : ''}`}`);
  }
  const seen = new Set<string>();
  let repeated = 0;
  for (const row of rows) {
    const key = columns.map((column) => { const value = row[column]; return typeof value === 'bigint' ? value.toString() : JSON.stringify(value ?? null); }).join('\u0001');
    if (seen.has(key)) repeated += 1; else seen.add(key);
  }
  if (repeated) lines.push(`repeated rows: ${repeated}`);
  return lines.join('\n');
}

const RESULT_REVIEW_SYSTEM = 'You check one query result against the question it should answer. You see the question, the SQL and the shape of what it returned. Reply with JSON only: {"answers": true} when the result can answer the question as asked, or {"answers": false, "problem": "<one sentence: the concrete defect and what to change>"}. Report a defect only when the shape shows it: a column that is entirely NULL (a date that did not parse, a join that matched nothing), a row count that contradicts a number the question itself states (it asks for one number, a top 5 or the single best, and the result has another count), a column the question asks for that is missing (a name, a count), repeated rows, or a total at another level than asked (per invoice where the question asks per country). You cannot see the data, so never assume how many rows it holds: a breakdown "by X" lists the X that have data, and fewer rows than you would expect is not a defect. Never question a definition, filter or formula the question leaves open; when in doubt, it answers.';

/**
 * What a draft for an engine must know that the model gets wrong by default.
 * Facts about the engine, not about any question. Shown on warehouse-first
 * projects, where they were measured; a dbt project's prompts are recorded
 * provider evidence (the golden replays) and change only with a re-record.
 * Engines without an entry get no line.
 */
const DIALECT_NOTES: Record<string, string> = {
  sqlite: [
    'there is no MEDIAN, PERCENTILE_CONT or STDDEV function: compute a median by ordering the values and averaging the middle one or two (ROW_NUMBER() and COUNT(*) OVER ()), and a standard deviation from AVG(x*x) - AVG(x)*AVG(x)',
    'integer divided by integer truncates: multiply by 1.0 first for a ratio or average of counts',
    'dates and timestamps are stored as TEXT: use date(), strftime(\'%Y\', col), strftime(\'%Y-%m\', col) and julianday(); check the stored format before comparing',
    'concatenate with ||; there is no LEFT() or RIGHT(): use substr()',
    'window functions (ROW_NUMBER, RANK, LAG, SUM() OVER) and WITH RECURSIVE are supported',
  ].join('; '),
};

/** Relation names as SQL writes them, lowercased and unquoted. */
function relationsInSql(sql: string): string[] {
  const found = new Set<string>();
  for (const match of sql.matchAll(/(?:FROM|JOIN)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)){0,2})/gi)) {
    const name = (match[1] ?? '').trim();
    if (name) found.add(name);
  }
  return [...found];
}

/** Exact Snowflake-aware identity for a relation already written in SQL. */
function relationKey(name: string): string {
  return physicalRelationIdentity(name);
}

/** A legacy two-part alias is safe only for an unqualified SQL reference. */
function relationTailKey(name: string): string | undefined {
  const parts = parsePhysicalIdentifier(name);
  if (parts.length < 2) return undefined;
  return `tail:${parts.slice(-2).map((part) => part.value.toLowerCase()).join('.')}`;
}

/** The relation this query reads that the connection is already known to lack. */
export function knownMissingRelation(key: string, sql: string): string | undefined {
  const missing = missingByConnection.get(key);
  if (!missing || missing.size === 0) return undefined;
  const now = Date.now();
  for (const [relation, evidence] of missing) if (evidence.expiresAt <= now) missing.delete(relation);
  for (const relation of relationsInSql(sql)) {
    const evidence = missing.get(relationKey(relation));
    if (evidence) return evidence.relation;
    // The current connection's database is part of its cache key, so a legacy
    // schema.table statement can reuse a definite failure learned from the
    // fully qualified version. A different fully-qualified database never
    // consults this alias.
    if (parsePhysicalIdentifier(relation).length === 2) {
      const tailEvidence = relationTailKey(relation) ? missing.get(relationTailKey(relation)!) : undefined;
      if (tailEvidence) return tailEvidence.relation;
    }
  }
  return undefined;
}

/** Record what a failed query proved about the connection, and what a successful one disproved. */
export function recordRelationEvidence(key: string, sql: string, failure?: { class: string; relations: string[] }, rawMessage?: string): void {
  if (!failure) {
    const missing = missingByConnection.get(key);
    if (!missing) return;
    for (const relation of relationsInSql(sql)) {
      missing.delete(relationKey(relation));
      const tail = relationTailKey(relation);
      if (tail) {
        // A success on a legacy schema.table reference disproves the bounded
        // negative observation recorded from its fully-qualified spelling on
        // this same target. Remove both forms together.
        for (const [cacheKey, evidence] of missing) {
          if (cacheKey === tail || relationTailKey(evidence.relation) === tail) missing.delete(cacheKey);
        }
      }
    }
    return;
  }
  if (failure.class !== 'relation_missing') return;
  // Snowflake intentionally combines a missing object and an access denial in
  // one message. Caching that message as absence would survive a role change
  // and turn a permission/configuration problem into a false catalog claim.
  if (/does not exist\s+or\s+not authorized|not exist\s+or\s+not authorized/i.test(rawMessage ?? '')) return;
  const named = failure.relations.length ? failure.relations : relationsInSql(sql);
  if (named.length !== 1) return;
  const missing = missingByConnection.get(key) ?? new Map<string, MissingRelationEvidence>();
  const namedRelation = named[0]!;
  const sourceRelation = relationsInSql(sql).find((relation) => relationTailKey(relation) === relationTailKey(namedRelation)) ?? namedRelation;
  const evidence = { expiresAt: Date.now() + MISSING_RELATION_TTL_MS, relation: namedRelation };
  // Use the exact relation that was actually submitted, since Snowflake error
  // text drops quote state. The original error spelling remains the user-facing
  // diagnostic.
  missing.set(relationKey(sourceRelation), evidence);
  const tail = relationTailKey(namedRelation);
  if (tail) missing.set(tail, evidence);
  missingByConnection.set(key, missing);
}

/** Test seam: forget everything learned about connections. */
export function resetRelationEvidence(): void {
  missingByConnection.clear();
}

export function toExecutorResult(runId: string, outcome: PipelineOutcome, startedAt: number): AgentRouteExecutorResult {
  const receipt = outcome.receipt;
  const telemetry: AgentRouteExecutorResult['telemetry'] = {
    version: 1,
    stageDurationsMs: {
      ...(receipt.timings.context !== undefined ? { context: receipt.timings.context } : {}),
      ...(receipt.timings.resolve !== undefined ? { meaning: receipt.timings.resolve } : {}),
      ...(receipt.timings.execute !== undefined ? { execution: receipt.timings.execute } : {}),
      total: Date.now() - startedAt,
    },
    providerRoundTrips: receipt.dispatches.length,
    toolCalls: receipt.candidates.length + receipt.refusals.length,
    sqlExecutions: receipt.warehouse?.executions ?? (receipt.executed ? 1 : 0),
    ...(receipt.warehouse ? { sqlAttempts: receipt.warehouse.attempts, sqlFailures: receipt.warehouse.failures } : {}),
    repairs: receipt.dispatches.filter((dispatch) => dispatch.purpose.includes('repair')).length,
    egressReceipts: receipt.dispatches.length,
  };
  const common = { askIntentV1: outcome.intent, askPipeline: receipt };
  const withReceipt = <T extends AgentRouteExecutorResult>(result: T): T => ({ ...result, askPipelineReceipt: receipt });
  if (outcome.kind === 'conversation' || outcome.kind === 'definition') {
    return withReceipt({ summary: outcome.kind === 'definition' ? 'Explained a governed definition.' : 'Replied conversationally.', answer: outcome.reply, answerKind: 'conversational', status: 'completed', trustState: 'not_applicable', stopReason: 'conversational_reply', resolvedRoute: 'conversation', artifacts: [], evaluations: [], nextActions: [], telemetry });
  }
  if (outcome.kind === 'clarify') {
    const clarificationOptions: NonNullable<AgentRouteExecutorResult['clarificationOptions']> = outcome.options.map((option) => ({ id: option.ref, label: option.label, ...(option.description ? { description: option.description } : {}), kind: option.ref.startsWith('member:') ? 'member' : 'vocabulary' }));
    return withReceipt({ summary: outcome.question, answer: outcome.question, status: 'needs_clarification', trustState: 'not_applicable', stopReason: 'needs_clarification', resolvedRoute: 'clarify', answerRefusalCode: 'ambiguous', clarificationOptions, artifacts: [{ id: `${runId}:clarify`, kind: 'answer', title: 'One question before running this', trustState: 'not_applicable', payload: { kind: 'no_answer', text: outcome.question, answer: outcome.question, ...common } }], evaluations: [], nextActions: [{ id: 'clarify', label: 'Clarify question', route: 'generated_answer' }], telemetry });
  }
  if (outcome.kind === 'gap') {
    // A why-question Ask declined is the question Research investigates.
    const asksWhy = (outcome.intent?.unresolved ?? []).some((clause) => clause.kind === 'unsupported' && /\b(why|drivers?|reasons?|because)\b/i.test(clause.clause));
    const nextActions: AgentRunNextAction[] = [
      ...(asksWhy ? [{ id: 'investigate-drivers', label: 'Investigate the drivers', route: 'research' as const }] : []),
      ...(outcome.receipt.context?.suggestedDomain ? [{ id: 'scope-to-domain', label: `Scope Ask to ${outcome.receipt.context.suggestedDomain}`, route: 'generated_answer' as const }] : []),
      ...(receipt.outOfScope?.length ? [{ id: 'widen-scope', label: 'Ask with a purpose that imports it, or declare the import in Domain Studio', route: 'modeling_draft' as const }] : []),
      { id: 'review-metadata-gap', label: 'Review what the project models', route: 'blocked' },
      ...(outcome.offerExploration ? [{ id: 'explore-review-required', label: 'Explore the physical tables (review-required)', route: 'generated_answer' as const }] : []),
    ];
    const presentation = gapPresentation(outcome.gap, outcome.message);
    return withReceipt({ summary: outcome.text, answer: outcome.text, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: presentation.code, artifacts: [{ id: `${runId}:gap`, kind: 'answer', title: presentation.title, trustState: 'blocked', payload: { kind: 'no_answer', text: outcome.text, answer: outcome.text, gap: { kind: outcome.gap, message: outcome.message, nearest: outcome.nearest }, ...common } }], evaluations: [], nextActions, telemetry });
  }
  if (outcome.kind === 'failed') {
    const outOfScope = receipt.failure?.reason === 'out_of_scope';
    const invalid = receipt.failure?.reason === 'invalid';
    return withReceipt({ summary: outcome.text, answer: outcome.text, status: 'blocked', trustState: 'blocked', stopReason: 'blocked', resolvedRoute: 'generated_answer', answerRefusalCode: outOfScope || invalid ? 'modeling_gap' : outcome.stage === 'resolve' ? 'provider_error' : 'execution_error', artifacts: [{ id: `${runId}:failed`, kind: 'answer', title: outcome.stage === 'execute' ? 'The query failed on the warehouse' : outOfScope ? 'Outside this question\'s scope' : 'Could not prepare the query', trustState: 'blocked', payload: { kind: 'no_answer', text: outcome.text, answer: outcome.text, executionError: outcome.message, failedStage: outcome.stage, ...common } }], evaluations: [], nextActions: outOfScope
      ? [{ id: 'widen-scope', label: 'Ask with a purpose that imports it, or declare the import in Domain Studio', route: 'modeling_draft' }]
      : [{ id: 'review-analytical-failure', label: 'Review the interpretation and the engine message', route: 'blocked' }], telemetry });
  }
  if (outcome.kind !== 'answered') throw new Error(`unreachable pipeline outcome ${String((outcome as { kind: string }).kind)}`);
  const { candidate, result } = outcome;
  const certified = candidate.trust === 'certified';
  const reviewRequired = candidate.trust === 'review_required';
  // A certified block served as published for a question it cannot answer
  // with identity is evidence: governed trust, the block as its source.
  const blockAsEvidence = candidate.tier === 'certified' && !certified;
  const route = certified ? { tier: 'certified_block', label: 'Certified saved query' } : blockAsEvidence ? { tier: 'certified_block', label: 'Certified saved query, served as evidence' } : reviewRequired ? { tier: 'generated_sql', label: 'AI-drafted SQL (review required)' } : { tier: 'semantic_metric', label: 'Semantic metric' };
  // GOVERNED MEANS THE WHOLE QUESTION. A semantic answer is labelled governed
  // only when its reading uses everything the question names and meets every
  // obligation it recorded. A word the reading left unused ("premium" in "the
  // total amount of premium") or an output it could not carry means the
  // governed definitions answered a question near the one asked: the numbers
  // are shown, labelled for review, with the reason.
  const doubt = governedCoverageDoubt(receipt);
  const coverageDoubt = !certified && !reviewRequired && doubt.reasons.length > 0;
  const effectiveTrust = effectiveAnsweredTrust({ certified, reviewRequired, coverageDoubt });
  const trustState = effectiveTrust.trustState;
  const payload = {
    kind: certified ? 'certified' : 'uncertified',
    route,
    sourceTier: certified || blockAsEvidence ? 'certified_artifact' : candidate.tier === 'semantic' ? 'semantic_layer' : 'dbt_manifest',
    trustState,
    certification: effectiveTrust.certification,
    reviewStatus: effectiveTrust.reviewStatus,
    text: outcome.text,
    answer: outcome.text,
    sql: candidate.sql,
    ...(candidate.params?.length ? { sqlParams: candidate.params } : {}),
    result: {
      columns: result.columns, rows: result.rows, rowCount: result.rowCount, executionTime: result.executionTimeMs, sql: candidate.sql,
      // Canonical result identity is a bare sha256 hex: every reader of
      // execution proof (Research branches, result follow-ups) validates that shape.
      resultFingerprint: createHash('sha256').update(JSON.stringify({ columns: result.columns, rows: result.rows })).digest('hex'), trustState, answerTier: route.tier, ...(result.truncated ? { truncated: true } : {}),
      // The units contract; absent on legacy results, which render exactly as before.
      ...(result.columnsMeta?.length ? { columnsMeta: result.columnsMeta } : {}),
    },
    ...(candidate.sourceRef ? { certifiedBlockRef: candidate.sourceRef } : {}),
    ...(candidate.sourceRef && candidate.sourceOwner ? { certifiedBlockOwner: candidate.sourceOwner } : {}),
    ...(candidate.artifact !== undefined ? { dqlArtifact: candidate.artifact } : {}),
    proof: [...candidate.proof, ...(receipt.executed?.proofs ?? [])],
    ...common,
  };
  // A join the AI wrote with no relationship behind it can be saved as one.
  const undeclaredJoin = (receipt.context?.used?.joins ?? []).find((join) => join.authority === 'none' && join.relations?.length === 2 && (join.keys?.length ?? 0) > 0);
  const tableName = (relation: string) => relation.replace(/"/g, '').split('.').pop() ?? relation;
  // An answer whose SQL the AI wrote from the schema is never headed as governed.
  // The card's title comes from the same trust decision as the run, the badge
  // and the payload, and names the source the figures came from.
  const artifact: AgentRunArtifact ={ id: `${runId}:answer`, kind: 'answer', title: answeredArtifactTitle(trustState, certified ? 'certified_block' : reviewRequired ? 'ai_sql' : blockAsEvidence ? 'block_as_evidence' : 'governed_definitions'), trustState, payload };
  return withReceipt({
    summary: outcome.text, answer: outcome.text, status: 'completed', trustState,
    stopReason: effectiveTrust.stopReason,
    resolvedRoute: certified ? 'certified_answer' : candidate.tier === 'semantic' ? 'semantic_answer' : 'generated_answer',
    answerTier: route.tier, result: payload.result, artifacts: [artifact],
    evaluations: [
      ...contextEvaluation(receipt),
      { id: 'pipeline-interpretation', label: 'Interpretation', passed: true, severity: 'info', message: `Read as: ${outcome.intent.reading || 'the intent below'}` },
      { id: 'pipeline-preparation', label: certified ? 'Certified entailment' : candidate.tier === 'semantic' ? 'Semantic compilation' : reviewRequired ? 'AI-drafted SQL checks' : 'Certified saved query', passed: true, severity: 'info', message: candidate.proof.join(' ') },
      ...(receipt.executed?.proofs ?? []).map((proof, index) => ({ id: `pipeline-execution-${index + 1}`, label: 'Execution proof', passed: true, severity: 'info' as const, message: proof })),
      // Words the reading does not use are never a passed check; the
      // evaluation carries no repair action, so it informs and does not loop.
      // A restriction the reading did not apply is a warning; a word it may
      // cover under another name is a question, never a claim of omission.
      ...coverageEvaluations(receipt),
      ...(coverageDoubt ? [{ id: 'pipeline-governed-coverage', label: 'Governed label', passed: false, severity: 'warning' as const, message: `Computed from governed definitions, but labelled for review: the reading does not account for ${doubt.reasons.join('; ')}.` }] : []),
      ...(receipt.grounding ?? []).filter((note) => note.startsWith('identity:') && /share the name/.test(note)).map((note, index) => ({ id: `pipeline-identity-${index + 1}`, label: 'Identity', passed: true, severity: 'warning' as const, message: note.slice('identity:'.length).trim() })),
      // A certified block served as published with a label-only grouping
      // says so: the answer cannot keep two same-named entities apart.
      ...(candidate.tier === 'certified' ? candidate.proof.filter((line) => /no identity key/.test(line)).map((line, index) => ({ id: `pipeline-certified-caveat-${index + 1}`, label: 'Certified saved query identity', passed: false, severity: 'warning' as const, message: `${line.replace(/^the block/, 'The block')}. Recertify it with the entity key to keep same-named members apart.` })) : []),
      // A certified answer always names who owns its block; a block with no
      // recorded owner is listed here and the answer says "Owner: not set".
      ...(certified && candidate.sourceRef && !candidate.sourceOwner ? [{ id: 'pipeline-certified-owner', label: 'Certified saved query owner', passed: false, severity: 'warning' as const, message: `${candidate.sourceRef} has no owner recorded. Set owner in the block declaration.` }] : []),
      // An answer that could not carry a requested output says so, and the
      // check does not pass: a ranking whose only identity is a numeric key
      // has not answered "which teams".
      ...(receipt.unmet ?? []).map((unmet, index) => ({ id: `pipeline-unmet-${index + 1}`, label: unmet.obligation === 'display_label' ? 'Requested identity' : 'Requested coverage', passed: false, severity: 'warning' as const, message: `${unmet.message.charAt(0).toUpperCase()}${unmet.message.slice(1)}.` })),
      // A certified block refused for identity is shown as source evidence
      // beside the keyed governed answer that replaced it.
      ...receipt.refusals.filter((refusal) => refusal.tier === 'certified' && /no identity key/.test(refusal.message)).map((refusal, index) => ({ id: `pipeline-certified-identity-${index + 1}`, label: 'Certified source, not applicable', passed: false, severity: 'warning' as const, message: `${refusal.message.replace(/^block:/, 'Block ')}. The answer is composed by entity key; recertify the block with the key column to serve it as certified.` })),
    ],
    nextActions: [
      ...((receipt.unmet ?? []).some((unmet) => unmet.obligation === 'display_label') ? [
        { id: 'declare-relationship', label: 'Declare the relationship that carries the label', route: 'modeling_draft' as const },
        // The label lives on another entity of the same thing: a concept draft can name that (A-005), for review, never certified by asking.
        { id: 'draft-concept', label: 'Draft a business concept for this identity', route: 'modeling_draft' as const },
      ] : []),
      ...(receipt.refusals.some((refusal) => refusal.tier === 'certified' && /no identity key/.test(refusal.message)) || (candidate.tier === 'certified' && candidate.proof.some((line) => /no identity key/.test(line))) ? [{ id: 'recertify-with-key', label: 'Recertify this saved query with the entity key', route: 'dql_block_draft' as const, artifactKind: 'dql_block_draft' as const }] : []),
      ...(receipt.context?.suggestedDomain ? [{ id: 'scope-to-domain', label: `Scope Ask to ${receipt.context.suggestedDomain}`, route: 'generated_answer' as const }] : []),
      ...(undeclaredJoin ? [{ id: 'create-relationship', label: `Save the ${undeclaredJoin.relations!.map(tableName).join(' → ')} join as a relationship`, route: 'modeling_draft' as const }] : []),
      { id: 'create-block', label: 'Save as saved query', route: 'dql_block_draft', artifactKind: 'dql_block_draft' }, { id: 'research-gap', label: 'Research deeper', route: 'research' },
    ],
    telemetry,
  });
}
