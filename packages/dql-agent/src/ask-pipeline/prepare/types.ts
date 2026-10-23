import type { ManifestRelationshipValidationEvidence, SemanticJoinStep } from '@zlens/core';
import type { AnalyticalIntentV1 } from '../intent.js';
import type { VocabularyIndex } from '../vocabulary.js';

/**
 * PREPARE: every tier, before anything is committed.
 *
 * A prepared candidate is an executable the host can freeze: the SQL, its
 * parameters, the trust it will carry, and the proof of why it answers the
 * intent. A refusal is typed and carries the compiler's own words, never a
 * substitute sentence. Nothing here talks to a warehouse or a model.
 */

export type PrepareTier = 'certified' | 'semantic' | 'relational' | 'exploratory';
export type PrepareTrust = 'certified' | 'governed' | 'review_required';

export type PreparedBlock =
  | { sql: string; params: unknown[]; parameters: Array<{ name: string; position: number; value: unknown; source: string }>; outputs?: string[]; /** The block's DQL declaration, shown as the DQL the answer ran. */ source?: string; sourcePath?: string }
  | { error: string; unresolved?: string[] };

export interface PreparedCandidate {
  /** Every physical relation the executable reads (islands and joined relations), for the context ledger. */
  relations?: string[];
  tier: PrepareTier;
  trust: PrepareTrust;
  sql: string;
  /** Positional parameters, when the composer bound literals as parameters. */
  params?: unknown[];
  /** Why this candidate answers the intent, in the host's words. */
  proof: string[];
  /** The block ref for a certified candidate; the engine for a semantic one. */
  sourceRef?: string;
  /**
   * A certified block whose own WHERE fixes exactly the period asked for
   * (read from its contract): the window is applied by the block itself, so
   * the window proof reads it there instead of looking for the dates.
   */
  fixedWindow?: { column: string; start: string; end: string };
  /** The certified block's recorded `owner`; absent when the block names none. */
  sourceOwner?: string;
  engine?: string;
  /** Certified block outputs matched by meaning to the question's refs: the rows are described under those refs, not the block's own column names. */
  outputRefs?: Array<{ output: string; ref: string }>;
  /** Output columns the composer expects, when known before execution. */
  columns?: string[];
  /** A one-row probe (base_rows, joined_rows) that must not show fan-out before rows are trusted. */
  fanoutProbeSql?: string;
  /** The request handed to the compiler, for the receipt. */
  compileRequest?: unknown;
  /** Host artifact (a DQL source) rendered for the answer, when available. */
  artifact?: unknown;
  /**
   * Ratio columns to compute after execution from two executed columns
   * (`alias = numerator / denominator`, null on a zero denominator); the
   * helper columns are dropped unless the intent asked for them.
   */
  derived?: Array<{ alias: string; numerator: string; denominator: string; keepInputs?: boolean }>;
  /** Deterministic comparison columns computed from already executed semantic metrics. */
  changes?: Array<{ alias: string; base: string; comparison: string; as: 'absolute' | 'percent'; keepInputs?: boolean }>;
  /**
   * A bounded set of semantic statements for mutually different periods.
   * These branches are compiled by the selected semantic adapter and aligned
   * only after they return; relational/generated SQL never recreates an
   * engine-owned metric formula.
   */
  semanticProgram?: SemanticExecutionProgram;
  /** The join steps this candidate's SQL takes, with their authority (relational tier). */
  joins?: RelationalJoinStep[];
  /** Why the candidate carries less trust than its tier would (a semantic compile joining through an uncertified relationship); said in the answer. */
  trustCaveat?: string;
  /**
   * A superlative fetched ONE MORE ROW than it will show, so that a tie at the
   * boundary can be seen rather than silently resolved by whatever order the
   * warehouse happened to return. Execution trims to `limit`, or keeps the
   * rows that tie and says so.
   */
  tieProbe?: { column: string; limit: number };
}

export type PrepareRefusalCode =
  | 'join_requires_domain_contract'
  | 'relationship_domain_unknown'
  | 'policy_filter_unbindable' | 'policy_conflict' | 'exploration_unavailable' | 'exploration_tables_unavailable' | 'exploration_failed' | 'exploration_declined' | 'exploration_check_failed' | 'exploration_not_read_only'
  | 'no_certified_block'
  | 'block_not_applicable'
  | 'not_semantic'
  | 'measure_scope_not_expressible'
  | 'semantic_compile_failed'
  | 'semantic_runtime_unavailable'
  | 'semantic_engine_required'
  | 'not_relational'
  | 'join_path_required'
  | 'relational_compose_failed'
  | 'exploration_not_opted_in'
  | 'policy_denied';

export interface PreparedRefusal {
  /** The two relations a `join_path_required` refusal could not connect. */
  relations?: [string, string];
  /** Declared but unauthorized relationships between them: what a reader could validate to make the join possible. */
  unproven?: UnprovenJoin[];
  tier: PrepareTier;
  code: PrepareRefusalCode;
  /** Verbatim: what the compiler, composer or entailment check actually said. */
  message: string;
  /** True when a corrected intent could plausibly prepare (unknown ref, wrong path). */
  repairable: boolean;
  detail?: unknown;
}

export interface SemanticCompileRequest {
  metrics: string[];
  dimensions: string[];
  filters?: Array<{ dimension?: string; operator?: string; values?: string[] }>;
  timeDimension?: { name: string; granularity: string };
  orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  /** Run-bound cancellation for a local semantic compiler process. */
  signal?: AbortSignal;
}

/**
 * A bounded semantic plan for genuinely distinct periods.  The semantic
 * adapter owns every branch; Ask only aligns declared outputs and applies the
 * already-defined comparison arithmetic after execution.  It never turns an
 * engine-owned offset metric into generated SQL.
 */
export interface SemanticExecutionProgram {
  version: 1;
  /**
   * At most four independently compiled semantic requests. `sql` is absent
   * while the program is handed to an adapter and present only after that
   * adapter compiled the exact same request against its selected target.
   */
  branches: Array<{
    id: string;
    request: SemanticCompileRequest;
    role?: 'base' | 'comparison';
    /** Semantic source columns returned by the branch and their stable Ask names. */
    outputs: Array<{ source: string; as: string }>;
    sql?: string;
    engine?: string;
  }>;
  shape: 'scalar' | 'grouped';
  /**
   * Branches deliberately fetch the complete bounded candidate population.
   * Comparisons/ratios do not exist until branch alignment, so a branch-local
   * ORDER BY/LIMIT would rank the wrong measure and can drop a member that is
   * top-ranked after the declared arithmetic.
   */
  postProcess?: {
    orderBy?: { column: string; direction: 'asc' | 'desc' };
    limit?: number;
    includeTies?: boolean;
    requireCompletePopulation?: boolean;
  };
}

export interface SemanticCompileOutput {
  sql: string;
  engine: string;
  columns?: string[];
  fanoutProbeSql?: string;
  strategy?: string;
  artifact?: unknown;
  /** Optional adapter-native compilation of up to four semantic branches. */
  program?: SemanticExecutionProgram;
  /** What the engine noted while compiling (a profile target it could not verify, a clamped grain); recorded on the candidate's proof. */
  warnings?: string[];
  /** The cube-to-cube joins the compile took, when the engine reports them (native). */
  joinPath?: SemanticJoinStep[];
  /**
   * Whether every join the compile took is a certified DQL relationship
   * (`assessSemanticJoinTrust`), set by the host that holds the manifest.
   * Absent: the host could not tell, and the compile keeps its governed trust.
   */
  joinTrust?: { certified: boolean; caveat?: string };
}

export interface RelationalJoinStep {
  /** Relation being joined in (`schema.table`). */
  relation: string;
  /** ON clause using fully qualified relation names. */
  on: string;
  /** Why this join may run (REL-002 amendment A-003). Absent only for a semantic-layer path the compiler owns. */
  authority?: JoinAuthorityV1;
}

/**
 * ONE PROOF RECORD FOR A JOIN. Every generated join carries exactly one
 * authority: the semantic layer (compiler-owned), a certified DQL relationship
 * (`certified`), or a within-domain warehouse proof (`proven_default`) whose
 * promise is structural safety only — never business identity, never
 * cross-domain permission.
 */
export interface JoinAuthorityV1 {
  version: 1;
  from: string;
  to: string;
  keys: Array<{ from: string; to: string }>;
  source: 'semantic_layer' | 'dql_relationship' | 'warehouse_proof';
  relationshipId?: string;
  authority: 'certified' | 'proven_default';
  scope: 'no_domains' | 'within_domain' | 'cross_domain_certified';
  domains: { from: string[]; to: string[] };
  evidence?: ManifestRelationshipValidationEvidence;
  /** When the evidence was gathered and how long it authorizes execution. */
  freshness?: { checkedAt: string; expiresAt: string; target: string; generationToken?: string };
  snapshotId?: string;
}

/** A declared relationship the host will not join on declaration alone: an offer to validate it. */
export interface UnprovenJoin {
  relationshipId: string;
  from: string;
  to: string;
  keys: Array<{ from: string; to: string }>;
  status: string;
  cardinality?: string;
  fanout?: string;
  reason: string;
}

export interface SqlDialectLike {
  /** Quotes an ALIAS or any name the program itself mints: always quoted, case kept. */
  quoteIdentifier(name: string): string;
  /** Renders a PHYSICAL relation segment or column as the warehouse knows it (Snowflake: plain lower/upper-case names unquoted, explicit quotes kept); defaults to `quoteIdentifier`. */
  quotePhysical?(name: string): string;
  /** Renders a whole physical relation (`schema.table`) as the warehouse addresses it — with its database on warehouses that need it; defaults to quoting each segment with `quotePhysical`. */
  qualifyRelation?(relation: string): string;
  dateTrunc(grain: string, expr: string): string;
  limitClause(limit: number): string;
}

export interface PrepareDeps {
  /** Compile a semantic request on the project's active engine. Throws with the engine's message. */
  compileSemantic?: (request: SemanticCompileRequest) => Promise<SemanticCompileOutput>;
  /** Optional adapter-native program compiler for a bounded multi-period plan. */
  compileSemanticProgram?: (program: SemanticExecutionProgram) => Promise<SemanticCompileOutput>;
  /** Join steps from one physical relation to another, or undefined when no governed path exists. */
  joinPath?: (fromRelation: string, toRelation: string) => RelationalJoinStep[] | undefined;
  /**
   * Ask the WAREHOUSE whether a relationship holds that nobody declared: the
   * key is unique in the label relation, and every key the facts carry appears
   * there. A proof admits the join as a governed default and is remembered for
   * the snapshot; anything short of both proofs admits nothing.
   */
  proveJoinPath?: (fromRelation: string, toRelation: string) => Promise<RelationalJoinStep[] | { refusal: PreparedRefusal } | undefined>;
  /** Declared relationships between two relations that are NOT authorized to join: the offers a refusal names. */
  unprovenJoinPath?: (fromRelation: string, toRelation: string) => UnprovenJoin[];
  /**
   * Draft one read-only SQL statement from the question, the reading and the
   * admitted vocabulary, validated by the host against the catalog (only
   * admitted relations and columns). Returns the referenced relations and
   * the host's proof lines, or the reason it could not.
   */
  /**
   * Draft one read-only statement from the schema. `intent` is absent when no
   * governed reading could be built; `reason` says why no governed tier
   * answered; `previous` carries a draft the warehouse rejected, with its
   * error, for one correction. `declined` means the tables cannot answer.
   */
  draftSql?: (input: { question: string; intent?: AnalyticalIntentV1; vocabulary: VocabularyIndex; reason?: string; previous?: { sql: string; error: string } }) => Promise<{ sql: string; relations: string[]; proof: string[]; engine?: string } | { error: string; /** The tables could not be read at all (none in the catalog, or the connection could not describe them): a setup problem, never evidence about the data. */ unavailable?: boolean } | { declined: string } | { refused: string } | undefined>;
  /** Dialect for relational composition. */
  dialect?: SqlDialectLike;
  /** Certified block source text by block ref. */
  /** @deprecated Raw block query text; a block with template parameters is refused on this path. Prefer `prepareBlock`. */
  blockSql?: (blockRef: string) => string | undefined;
  /**
   * The block compiled and bound the way every other surface runs it: SQL with
   * positional placeholders (`$1..$n`), the bound values in order, and the
   * declared parameters with the value each received. Unresolved required
   * parameters are an error, not a guess.
   */
  prepareBlock?: (blockRef: string, context: { question?: string; /** Values the reading fixes for declared parameters (a ranking's row count). */ parameters?: Record<string, unknown> }) => PreparedBlock | undefined;
  /** Host-side policy check on a relation or column ref; a denial is terminal. */
  policyDenies?: (refs: string[]) => string | undefined;
  /** The semantic engine that will compile this run's semantic candidate, when the host knows it beforehand. */
  engine?: 'native' | 'metricflow-cli' | 'dbt-cloud';
}

export interface PrepareInput {
  intent: AnalyticalIntentV1;
  vocabulary: VocabularyIndex;
  deps: PrepareDeps;
  explorationOptIn?: boolean;
  /** Tiers whose candidate already failed an execution proof for this intent. */
  excludeTiers?: PrepareTier[];
  /** The question as asked, for the drafting tier. */
  question?: string;
  /** Run the review-required SQL tier automatically when nothing governed prepares (the default); false keeps it opt-in. */
  explorationAuto?: boolean;
}

export interface PrepareResult {
  candidates: PreparedCandidate[];
  refusals: PreparedRefusal[];
  chosen?: PreparedCandidate;
  /** Certified blocks refused only for label-only identity: served as published when a repair produced nothing better. */
  fallbacks: PreparedCandidate[];
  /** Every tier that was tried, in order, and how it ended. */
  attempts: Array<{ tier: PrepareTier; outcome: 'prepared' | 'refused' | 'skipped'; detail?: string }>;
}
