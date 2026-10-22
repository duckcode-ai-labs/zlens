import { applyRerank, type RerankOutcome } from '../agentic/rerank.js';
/**
 * Project-local metadata catalog for OSS agentic analytics.
 *
 * Git/DQL/dbt files remain the source of truth. This SQLite database is a
 * rebuildable local catalog at `.dql/cache/metadata.sqlite` used by agents,
 * MCP tools, app builder, and notebook/block AI to retrieve one consistent
 * context pack before answering.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import type Database from 'better-sqlite3';
import {
  buildManifest,
  buildManifestKnowledgeGraph,
  loadDomainPackageRegistry,
  loadManifestKnowledgeSkills,
  loadProjectConfig,
  parseContractRef,
  resolveDataLexManifestPath,
  resolveDbtManifestPath,
  resolveSemanticLayerWithDiagnostics,
  extractColumnLineage,
  type DataLexManifest,
  type DQLManifest,
  type ManifestConflictDetail,
  type ManifestDiagnostic,
  type ManifestDomainCapsule,
  type ManifestCrossDomainRoute,
  type ManifestKnowledgeObject,
  type ManifestKnowledgeEdge,
  type ManifestKnowledgeObjectKind,
  type ManifestBlock,
  type SemanticLayer,
  type ColumnLineageEntry,
  type ColumnSource,
  normalizeDqlArtifactReference,
  composeEffectiveTrust,
  type DqlArtifactReference,
  type ResolvedTrustLabel,
  type AnalyticalPolicyContract,
  type DatasetDescriptor,
  normalizeMetricCapabilityContract,
  type MetricCapabilityContract,
  currentBlockFileCheck,
} from "@zlens/core";
import { buildKGFromManifest, buildKGFromSemanticLayer, declaredDomainIds } from "../kg/build.js";
import type { KGEdge, KGNode } from "../kg/types.js";
import {
  domainContextSearchDomains,
  type DomainContextEnvelope,
  type KnowledgeLens,
} from "../domain-context.js";
import {
  buildBlockBusinessFingerprint,
  buildBlockSqlFingerprints,
} from "./block-fingerprints.js";
import {
  buildAnalysisQuestionPlan,
  certifiedApplicabilityForObject,
  scoreAllowedSqlRelationWithAnalysisPlan,
  scoreMetadataObjectWithAnalysisPlan,
  sortAllowedSqlContextForAnalysisPlan,
  type AnalysisQuestionPlan,
  type CertifiedBlockApplicability,
} from './analysis-planner.js';
import { extractSimpleSelectShape, sourceSqlShapeColumns } from './sql-shape.js';
import {
  normalizeValueIndexText,
  type RuntimeValueIndexEntry,
} from '../grounding/value-index.js';
import {
  grainMatches,
  requestedGrainFromPlan,
  type GrainGateResult,
} from './grain-gate.js';
import {
  certifiedFitAllowsTier1,
  certifiedTerminationVerdict,
  evaluateCertifiedBlockFit,
  type CertifiedBlockFit,
} from './block-fit.js';
import { retrieveScopedHints } from '../hints/retrieval.js';
import { currentHintDependencyFingerprints } from '../hints/dependencies.js';
import type { QuestionScope } from '../hints/types.js';
import { buildFtsMatch, sanitizeFtsQuery } from '../memory/fts-query.js';
import {
  cosineSimilarity,
  embeddingProviderFromIndexedId,
  envEmbeddingProvider,
  HashedTokenEmbeddingProvider,
  type EmbeddingProvider,
} from '../embeddings/provider.js';
import { projectEmbeddingProvider } from '../embeddings/project-embeddings.js';
import { matchExampleParaphrase } from './example-match.js';
import { loadSkills, selectRelevantSkills, type Skill } from '../skills/loader.js';
import {
  buildMeaningEvidencePackage,
  type MetadataMeaningEvidencePackage,
} from './meaning-evidence.js';
import { fuseContextCandidates, retrieveContextLanes, type ContextCandidateCardV1 } from '../analytical-orchestration.js';
import {
  hasGeneratedAppSourceOrigin,
  isExplicitlyReusableAppSource,
} from '../app-source-policy.js';
import {
  datasetDescriptorFromSemanticMetrics,
  datasetDescriptorFromManifestBlock,
  loadDatasetGrainProofs,
  loadSavedQueryResultColumns,
  savedQueryResultDescriptorFromManifestBlock,
  type SemanticDatasetFieldProjection,
  type SemanticDatasetMeasureProjection,
} from '../datasets/index.js';
import { readEnv } from '@zlens/core';

export { applyContextPackCompatibility, toAgentRetrievalEvidence } from './meaning-evidence.js';

export type {
  AgentRetrievalEvidenceAdapterOptions,
  MetadataEvidenceClass,
  MetadataEvidenceTrust,
  MetadataMeaningCandidate,
  MetadataMeaningEvidencePackage,
} from './meaning-evidence.js';

/** An approved scoped hint folded into a context pack (after certified routing). */
export interface AppliedContextHint {
  hintId: string;
  title: string;
  guidance: string;
  lesson: import('../hints/types.js').HintLesson;
  scopeReason: string;
  /** Matching domain/model/relation/column graph connections. */
  graphReason?: string;
  score: number;
  matchSignals?: {
    lexicalScore: number;
    graphScore: number;
    lexicalRank?: number;
  };
  correctedSql?: string;
  traceId?: string;
}

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

export type MetadataTrustLabel = 'certified' | 'mixed' | 'draft' | 'unknown' | 'conflict';

export interface MetadataObject {
  objectKey: string;
  objectType: string;
  name: string;
  fullName?: string;
  domain?: string;
  owner?: string;
  status?: string;
  description?: string;
  sourcePath?: string;
  sourceSystem?: string;
  payload?: Record<string, unknown>;
  updatedAt?: string;
  score?: number;
  snippet?: string;
}

export interface MetadataIdentityResolution {
  identity: string;
  status: 'resolved' | 'ambiguous' | 'missing';
  matchedBy?: 'object_key' | 'qualified_id' | 'source_native_id' | 'alias';
  object?: MetadataObject;
  candidates: MetadataObject[];
}

export interface MetadataVectorSearchResult {
  providerId: string;
  dimensions: number;
  candidates: MetadataObject[];
  unavailableReason?: string;
}

export type MetadataRetrievalLaneName = 'exact' | 'lexical' | 'vector' | 'graph';

export interface MetadataRetrievalLaneCandidate {
  objectKey: string;
  objectType: string;
  name: string;
  rank: number;
  score: number;
  reason: string;
}

export interface MetadataRetrievalLaneResult {
  lane: MetadataRetrievalLaneName;
  provider?: string;
  unavailableReason?: string;
  candidates: MetadataRetrievalLaneCandidate[];
}

export interface MetadataSnapshotRetrievalResult {
  snapshotId: string;
  selected: MetadataObject[];
  lanes: MetadataRetrievalLaneResult[];
  /** Stable-key fusion diagnostics for the bounded Ask context pack. */
  fusion?: {
    selectedKeys: string[];
    truncated: boolean;
    lanes?: Record<string, {
      returned: number;
      durationMs?: number;
      status?: 'ok' | 'empty' | 'error' | 'skipped';
      error?: string;
      skippedReason?: string;
    }>;
  };
}

export interface MetadataEdge {
  edgeType: string;
  fromKey: string;
  toKey: string;
  confidence?: number;
  payload?: Record<string, unknown>;
}

export interface MetadataDiagnostic {
  kind: string;
  severity: 'error' | 'warning';
  message: string;
  objectKey?: string;
  filePath?: string;
}

export interface MetadataSnapshot {
  projectRoot: string;
  manifest: DQLManifest;
  objects: MetadataObject[];
  edges: MetadataEdge[];
  diagnostics: MetadataDiagnostic[];
  /**
   * Structured compile-time trust conflicts (two certified terms/blocks that
   * claim the same concept but disagree). Carried separately from
   * `diagnostics` because they retain the both-sides + owners payload the
   * `conflict` route needs; persisted as a JSON state blob.
   */
  compileConflicts: ManifestConflictDetail[];
  /** Optional for callers constructing legacy/in-memory snapshots directly. */
  skillBodies?: Array<{ bodyHash: string; body: string }>;
  fingerprint: string;
  generatedAt: string;
}

export interface MetadataSourceFingerprint {
  sourcePath: string;
  fingerprint: string;
  objectCount: number;
  updatedAt: string;
}

export interface MetadataDomainShard {
  domain: string;
  objectCount: number;
  blockCount: number;
  certifiedBlockCount: number;
  semanticMetricCount: number;
  dbtObjectCount: number;
  updatedAt: string;
}

export interface EnsureMetadataCatalogOptions {
  manifest?: DQLManifest;
  semanticLayer?: SemanticLayer | null;
  /** Parsed skills from the same project read used to prepare the KG. */
  skills?: Skill[];
  /** The knowledge graphs the caller already built from the same manifest and layer; the snapshot reuses them instead of building the KG a second time per reindex. */
  graphs?: MetadataSnapshotGraphs;
  force?: boolean;
  /** Optional explicit real embedding provider for the snapshot vector lane. */
  embeddingProvider?: EmbeddingProvider;
}

export interface EnsureMetadataCatalogResult {
  path: string;
  snapshotPath?: string;
  refreshed: boolean;
  objectCount: number;
  edgeCount: number;
  diagnostics: MetadataDiagnostic[];
  fingerprint: string;
}

export interface BuildLocalContextPackRequest {
  question: string;
  focusObjectKey?: string;
  mode?: 'question' | 'build' | 'debug' | 'certify' | 'impact' | 'explain';
  limit?: number;
  objectTypes?: string[];
  intent?: MetadataAgentIntent;
  surface?: 'cli' | 'notebook' | 'block' | 'app' | 'research' | 'mcp' | string;
  /**
   * Draft blocks are authoring material, never normal Ask evidence. Hosts may
   * opt in only for an explicit Block Studio/review workflow.
   */
  includeDraftBlocks?: boolean;
  followUp?: MetadataFollowUpContext | unknown;
  selectedContext?: unknown;
  runtimeSchemaSnapshot?: RuntimeSchemaSnapshot;
  strictness?: 'safe' | 'balanced' | 'exploratory';
  confirmCertifiedFit?: CertifiedFitConfirmation;
  /**
   * Optional cross-encoder pass over the fused candidates. Absent, or on any
   * failure, retrieval's own ordering is used unchanged — so this can improve
   * the pack but never break it.
   */
  rerankCandidates?: (
    question: string,
    candidates: ReadonlyArray<{ id: string; summary: string }>,
  ) => Promise<RerankOutcome | undefined>;
  /** Prior turn's context pack — reuse fuel for same-topic follow-ups. */
  priorContextPackId?: string;
  /**
   * 'reuse_on_refinement' — filter/limit-only follow-ups re-stamp the prior pack
   * (skips retrieval + route planning + the fit-confirm LLM call);
   * 'seed' (default) — prior pack objects only COMPETE in ranking;
   * 'off' — ignore the prior pack entirely.
   */
  reusePolicy?: 'off' | 'seed' | 'reuse_on_refinement';
  /** How the conversation layer classified this question vs the ongoing topic. */
  conversationTopicRelation?: 'continuation' | 'refinement' | 'shift' | 'return';
  /** Server-resolved domain scope applied before retrieval and graph expansion. */
  domainContext?: DomainContextEnvelope;
  /**
   * Fingerprint returned by `ensureAgentProjectReady` for this same immutable
   * project snapshot. When it still matches the catalog, retrieval skips the
   * expensive snapshot reconstruction and performs zero dbt artifact reads.
   */
  preparedMetadataFingerprint?: string;
  /**
   * `complete_eligible` (CTX-010) admits EVERY governed object the resolved
   * envelope allows into `pack.eligible`, so a vocabulary built from the pack
   * can be whole; ranking still orders the seeds. `ranked` (default) is the
   * bounded pack the planners have always read.
   */
  admission?: 'ranked' | 'complete_eligible';
}

/** A governed object the envelope admitted, compact: identity, and payload only for the small authored kinds. */
export interface EligibleObjectRef {
  objectKey: string;
  objectType: string;
  name: string;
  domain?: string;
  status?: string;
  description?: string;
  payload?: Record<string, unknown>;
}

/** The complete eligible set for a request's envelope (CTX-010). Transient: never persisted with the pack. */
export interface EligibleContextSet {
  objects: EligibleObjectRef[];
  counts: Record<string, number>;
  /** The domains the envelope admitted; empty means every object was eligible. */
  domains: string[];
  fingerprint: string;
}

/** Object types whose complete eligible set a vocabulary view is built from. */
export const ELIGIBLE_CONTEXT_OBJECT_TYPES = [
  'semantic_metric', 'semantic_measure', 'semantic_dimension', 'semantic_entity', 'semantic_model',
  'dql_block', 'dql_term', 'dbt_model', 'dbt_source', 'warehouse_table',
  'relationship', 'dql_entity', 'domain_capsule', 'business_view', 'concept',
] as const;
/** The authored kinds whose payload the eligible set carries (few, and needed to render them). */
const ELIGIBLE_PAYLOAD_TYPES = new Set(['relationship', 'dql_entity', 'domain_capsule', 'concept']);

export interface CertifiedFitConfirmationRequest {
  question: string;
  questionPlan: AnalysisQuestionPlan;
  block: MetadataObject;
  fit: CertifiedBlockFit;
}

export interface CertifiedFitConfirmationResult {
  allow: boolean;
  reason?: string;
  confidence?: 'high' | 'medium' | 'low';
}

export type CertifiedFitConfirmation = (
  request: CertifiedFitConfirmationRequest,
) => Promise<CertifiedFitConfirmationResult>;

export interface MetadataFollowUpContext {
  kind: 'generic' | 'drilldown' | 'contextual';
  sourceBlockName?: string;
  sourceQuestion?: string;
  sourceAnswer?: string;
  filters?: string[];
  dimensions?: string[];
  priorResultColumns?: string[];
  priorResultValues?: Record<string, string[]>;
  priorResultRef?: {
    id: string;
    question?: string;
    columns: string[];
    rowCount?: number;
    sourceSql?: string;
  };
  priorDqlArtifact?: MetadataDqlArtifactReference;
  priorLimit?: number;
  priorMeasures?: string[];
  memberBindings?: Array<{
    dimension: string;
    values: string[];
    source: 'prior_result' | 'question' | 'clarification';
    confidence: 'exact' | 'unique_partial' | 'deictic';
    sourceTurnId?: string;
  }>;
}

export type MetadataDqlArtifactReference = DqlArtifactReference;

export type MetadataAgentIntent =
  | 'exact_certified_lookup'
  | 'definition_lookup'
  | 'ad_hoc_ranking'
  | 'driver_breakdown'
  | 'diagnose_change'
  | 'segment_compare'
  | 'entity_drilldown'
  | 'anomaly_investigation'
  | 'trust_gap_review'
  | 'clarify';

export type MetadataAnswerRoute = 'certified' | 'generated_sql' | 'research' | 'clarify' | 'conflict';

export type MetadataEvidenceRole =
  | 'exact_certified_answer'
  | 'certified_context'
  | 'semantic_metric'
  | 'business_context'
  | 'dbt_model'
  | 'warehouse_schema'
  | 'runtime_schema'
  | 'value_match'
  | 'prior_query_run'
  | 'selected_context'
  | 'skill_guidance'
  | 'other';

export interface RuntimeSchemaColumn {
  name: string;
  type?: string;
  description?: string;
  sampleValues?: string[];
}

export interface RuntimeSchemaTable {
  relation: string;
  catalogOrDatabase?: string;
  schema?: string;
  name?: string;
  /** Redacted target identity carried from the binding that inspected it. */
  executionTargetFingerprint?: string;
  description?: string;
  columns: RuntimeSchemaColumn[];
  source?: string;
  /** Complete means this request inspected every physical column on the target. */
  columnCompleteness?: 'complete' | 'partial';
}

export interface RuntimeSchemaScope {
  catalogOrDatabase: string;
  schemas: string[];
}

export interface RuntimeSchemaObservedTarget {
  driver: string;
  accountOrWorkspace?: string;
  role?: string;
  warehouse?: string;
  defaultCatalogOrDatabase?: string;
  defaultSchema?: string;
}

export interface RuntimeSchemaSnapshot {
  version?: 1;
  generationId?: string;
  scopeFingerprint?: string;
  connectionId?: string;
  status?: 'ready' | 'partial' | 'stale';
  source?: string;
  capturedAt?: string;
  observedTarget?: RuntimeSchemaObservedTarget;
  scopes?: RuntimeSchemaScope[];
  queryCount?: number;
  durationMs?: number;
  truncated?: boolean;
  tables: RuntimeSchemaTable[];
}

export interface RuntimeValueMatch extends RuntimeValueIndexEntry {
  score: number;
}

export interface MetadataMissingContext {
  kind: 'metric' | 'table' | 'baseline' | 'dimension' | 'filter' | 'semantic' | 'value' | 'metadata';
  message: string;
  severity: 'warning' | 'blocking';
}

export interface MetadataAllowedSqlRelation {
  relation: string;
  name: string;
  objectKey?: string;
  source: string;
  columns: RuntimeSchemaColumn[];
  /** Whether `columns` is the whole relation; a sliced list must say `partial`. */
  columnCompleteness: 'complete' | 'partial';
}

export interface MetadataAllowedSqlContext {
  relations: MetadataAllowedSqlRelation[];
  sourceBlockSql: Array<{
    objectKey: string;
    name: string;
    status?: string;
    sql: string;
    /** NL anchor for few-shot example-retrieval (DAIL-SQL): what this block answers. */
    description?: string;
    exampleQuestion?: string;
    grain?: string;
  }>;
}

export interface GrainGateRouteInfo {
  /** Block the gate evaluated. */
  blockObjectKey: string;
  blockName: string;
  /** Whether the block was allowed to serve as a Tier-1 certified answer. */
  allow: boolean;
  kind: GrainGateResult['kind'];
  requestedGrain: string;
  blockGrain: string;
  reason: string;
}

export interface MetadataRouteDecision {
  route: MetadataAnswerRoute;
  intent: MetadataAgentIntent;
  reason: string;
  /**
   * Short machine/agent-facing explanation of a routing *decision* that demoted
   * or held a candidate — distinct from `reason`, which describes the chosen
   * route. Currently set by the grain gate, e.g.
   * `"certified block grain=account_id ≠ requested grain=region → Tier 2"`.
   */
  routeReason?: string;
  /** Structured grain-gate verdict for the best-matching certified candidate, when evaluated. */
  grainGate?: GrainGateRouteInfo;
  /** Structured full answer-shape fit verdict for the best-matching certified candidate, when evaluated. */
  blockFit?: CertifiedBlockFit;
  trustLabel: MetadataTrustLabel;
  /** Canonical shared trust vocabulary; additive companion to legacy `trustLabel`. */
  trustLabelInfo?: ResolvedTrustLabel;
  reviewStatus: 'certified' | 'draft_ready' | 'needs_review' | 'none' | 'conflict';
  exactObjectKey?: string;
  certifiedApplicability?: CertifiedBlockApplicability;
  selectedEvidence: Array<{
    objectKey: string;
    objectType: string;
    name: string;
    role: MetadataEvidenceRole;
    reason: string;
  }>;
  missingContext: MetadataMissingContext[];
  followUps: string[];
  /**
   * Present only on the `conflict` route. Two certified governance artifacts
   * claim the same concept/grain but disagree; the agent must surface BOTH
   * sides + owners and a disambiguation prompt instead of silently picking one.
   */
  routeConflict?: MetadataRouteConflict;
}

/** Route-time conflict surfaced when top candidates include a conflicting pair. */
export interface MetadataRouteConflict {
  objectType: 'term' | 'block';
  concept: string;
  reason: string;
  prompt: string;
  sides: Array<{
    name: string;
    owner?: string;
    domain?: string;
    filePath?: string;
    definition?: string;
    businessRules?: string[];
  }>;
}

export interface PlanAgentAnswerResult {
  contextPackId: string;
  contextPack: LocalContextPack;
  routeDecision: MetadataRouteDecision;
  evidenceRoles: LocalContextPack['evidenceRoles'];
  allowedSqlContext: MetadataAllowedSqlContext;
  missingContext: MetadataMissingContext[];
  warnings: string[];
  freshness: LocalContextPack['freshness'];
}

/** Compact skill payload selected for one context-pack snapshot. */
export interface LocalContextSkill {
  objectKey: string;
  id: string;
  qualifiedId?: string;
  domain?: string;
  domains: string[];
  modelAreaRefs: string[];
  kind?: Skill['kind'];
  status?: Skill['status'];
  owner?: string;
  description?: string;
  triggers: string[];
  exclusions: string[];
  preferredMetrics: string[];
  preferredBlocks: string[];
  preferredDimensions: string[];
  requiredFilters: string[];
  clarifyWhen: string[];
  vocabulary: Record<string, string>;
  /** Eligible structured defaults, bound to this exact Skill fingerprint. */
  analyticalPolicy?: AnalyticalPolicyContract;
  /** Bounded prompt-safe guidance; the full source remains fingerprinted in the catalog. */
  guidance: string;
  guidanceTruncated: boolean;
  sourceRefs: string[];
  provenance: string;
  sourcePath?: string;
}

export interface LocalContextPack {
  id: string;
  question: string;
  followUp?: MetadataFollowUpContext;
  focusObjectKey: string | null;
  mode: 'question' | 'build' | 'debug' | 'certify' | 'impact' | 'explain';
  questionPlan: AnalysisQuestionPlan;
  trustLabel: MetadataTrustLabel;
  /** Canonical shared trust vocabulary; additive companion to legacy `trustLabel`. */
  trustLabelInfo?: ResolvedTrustLabel;
  objects: MetadataObject[];
  /**
   * Bounded, in-scope guidance selected from the immutable catalog snapshot.
   * This is separate from generic retrieved objects so hosts can render the
   * exact skill provenance without re-reading mutable files mid-run.
   */
  skills: LocalContextSkill[];
  /** Exact domain capsule and skills used for this immutable context pack. */
  knowledgeLens: KnowledgeLens;
  /**
   * The pinned domain's compiled business context, resolved to text.
   *
   * The capsule stores REFS (term ids, metric ids) and was previously read only
   * to compute a fingerprint, so everything a user authored about their domain —
   * its glossary, what questions it answers, the filters it always applies —
   * never reached the model.
   */
  domainBriefing?: DomainBriefing;
  edges: MetadataEdge[];
  queryRuns: QueryRunSummary[];
  citations: Array<{
    objectKey: string;
    objectType: string;
    name: string;
    reason: string;
  }>;
  evidenceSummaries: Array<{
    title: string;
    detail: string;
    objectKey?: string;
    objectType?: string;
    reason: string;
  }>;
  warnings: string[];
  routeDecision: MetadataRouteDecision;
  evidenceRoles: Array<{
    objectKey: string;
    objectType: string;
    name: string;
    role: MetadataEvidenceRole;
    reason: string;
  }>;
  allowedSqlContext: MetadataAllowedSqlContext;
  missingContext: MetadataMissingContext[];
  conflicts: MetadataCandidateConflict[];
  /**
   * Approved, scoped correction hints folded into the context AFTER certified
   * routing (never overriding it). Empty when no hints exist or none are in
   * scope. Each hint is cited so the agent can attribute the guidance.
   */
  appliedHints: AppliedContextHint[];
  /** The complete eligible set, when the request asked for `complete_eligible` admission. Transient. */
  eligible?: EligibleContextSet;
  /** Conflicting approved hints surfaced for review (advisory). */
  hintConflicts: Array<{ hintIds: [string, string]; titles: [string, string]; reason: string }>;
  /** Approved hints withheld because they are stale, superseded, or conflicting. */
  hintExclusions?: Array<{
    hintId: string;
    title: string;
    reason: 'stale' | 'superseded' | 'conflict';
    detail: string;
  }>;
  retrievalDiagnostics: {
    strategy: 'sqlite_fts' | 'reused_pack_refinement' | 'expanded_context' | 'full_catalog';
    /** Independent snapshot-bound candidate lanes; vector is not a BM25 reranker. */
    lanes?: MetadataRetrievalLaneResult[];
    /** Stable qualified-key fusion trace for bounded multi-lane retrieval. */
    fusion?: {
      selectedKeys: string[];
      truncated: boolean;
      lanes?: Record<string, {
        returned: number;
        durationMs?: number;
        status?: 'ok' | 'empty' | 'error' | 'skipped';
        error?: string;
        skippedReason?: string;
      }>;
    };
    /** Qualified focused Model Area selected explicitly or inferred inside the active domain. */
    focusedModelAreaId?: string;
    modelAreaSource?: 'explicit' | 'inferred';
    /** How many times this pack lineage has been widened by expand_context. */
    regroundAttempts?: number;
    selectedObjects: number;
    selectedEvidence: Array<{
      objectKey: string;
      objectType: string;
      name: string;
      reason: string;
      rank: number;
      score: number;
      priorityTier: string;
    }>;
    selectedRelations?: Array<{
      relation: string;
      name: string;
      source: string;
      score: number;
      reason: string;
      columns: string[];
      rank: number;
    }>;
    selectedJoinPaths?: Array<{
      leftRelation: string;
      leftColumn: string;
      rightRelation: string;
      rightColumn: string;
      reason: string;
      confidence: number;
      /** `dql_relationship` is an authored, reviewed DQL join — the strongest source. */
      source?: 'dql_relationship' | 'dbt_lineage' | 'metadata_guess' | 'kg_path' | 'datalex';
    }>;
    schemaShapeCandidates?: Array<{
      objectKey: string;
      relation: string;
      score: number;
      reason: string;
      columns: string[];
    }>;
    topRejected: Array<{
      objectKey: string;
      objectType: string;
      name: string;
      reason: string;
      score: number;
      rejectedRank: number;
    }>;
    certifiedCandidateFits: Array<{
      objectKey: string;
      name: string;
      applicabilityKind: CertifiedBlockApplicability['kind'];
      applicabilityScore: number;
      action: 'certified_answer' | 'context_only' | 'eligible_not_selected' | 'rejected_for_fit';
      /**
       * This candidate's own captured output/grain/filter contract proves the
       * complete requested tuple, independently of which catalog route won.
       * The V2 runtime uses the full set to reject ambiguous zero-provider
       * certified shortcuts instead of mistaking a route winner for unique
       * business meaning.
       */
      completeForRequest?: boolean;
      /**
       * Direct, snapshot-local authored question evidence. This remains
       * distinct from a complete tuple fit so an omitted ranking metric never
       * gains fast-path authority from broad relevance alone.
       */
      directQuestionContract?: 'exact_example' | 'title_or_alias';
      fit: CertifiedBlockFit;
    }>;
    candidateConflicts: MetadataCandidateConflict[];
    /** Compact, trust-separated candidate cards for bounded AI meaning resolution. */
    meaningEvidence?: MetadataMeaningEvidencePackage;
  };
  freshness: {
    catalogPath: string;
    builtAt: string | null;
    fingerprint: string | null;
    /** Runtime metadata identity used by this pack; prevents cross-connection reuse. */
    runtimeSchemaConnectionId?: string;
    runtimeSchemaScopeFingerprint?: string;
    runtimeSchemaGenerationId?: string;
    runtimeSchemaCapturedAt?: string;
  };
}

/**
 * Enterprise-facing name for the shared ranked-evidence envelope used by
 * AI Import, Ask AI, Build AI, MCP, and app-builder flows. `LocalContextPack`
 * remains the historical OSS type name; both names describe the same contract.
 */
export type DqlContextPack = LocalContextPack;

export interface QueryRunSummary {
  id: string;
  objectKey?: string;
  source: 'sql_cell' | 'dql_block_cell' | 'semantic_metric_cell' | 'certified_block' | 'app_widget' | 'ai_draft' | string;
  status: string;
  rowCount?: number;
  durationMs?: number;
  errorCode?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
}

export interface MetadataCandidateConflict {
  objectType: string;
  objectKeys: string[];
  reason: string;
  prompt: string;
  candidates: Array<{
    objectKey: string;
    objectType: string;
    name: string;
    domain: string | null;
    status: string | null;
    rank: number;
    score: number;
    reason: string;
  }>;
}

interface RankedMetadataObject {
  row: MetadataObject;
  rank: number;
  score: number;
  reason: string;
  priorityTier: string;
}

interface SchemaShapeCandidate {
  object: MetadataObject;
  relation: MetadataAllowedSqlRelation;
  score: number;
  reasons: string[];
}

const SCHEMA_SHAPE_CACHE_LIMIT = 64;
const schemaShapeCandidateCache = new Map<string, SchemaShapeCandidate[]>();

interface RawDbtCatalogEntry {
  uniqueId: string;
  name: string;
  node: Record<string, unknown>;
  objectKey: string;
  objectType: 'dbt_model' | 'dbt_source';
  relation: string;
  database?: string;
  schema?: string;
  catalogColumns?: RuntimeSchemaColumn[];
  /** Single-column `unique` dbt tests on this model → grain-ledger keys (W5.3). */
  uniqueColumns?: string[];
}

/**
 * Extract single-column `unique` dbt tests, keyed by model name (W5.3). A column
 * a `unique` test guards is a grain key, which feeds the grain ledger's fan-out
 * detection — the common way real dbt repos declare keys. Handles both the
 * `attached_node` (newer dbt) and `depends_on` shapes, and top-level or kwargs
 * column names.
 */
export function extractDbtUniqueColumns(nodes: Record<string, Record<string, unknown>>): Map<string, string[]> {
  const byModel = new Map<string, string[]>();
  for (const node of Object.values(nodes)) {
    if (node.resource_type !== 'test') continue;
    const testMetadata = node.test_metadata as { name?: unknown; kwargs?: Record<string, unknown> } | undefined;
    if (stringValue(testMetadata?.name) !== 'unique') continue;
    const column = stringValue(node.column_name) ?? stringValue(testMetadata?.kwargs?.column_name);
    if (!column) continue;
    const dependsOn = (node.depends_on as { nodes?: unknown } | undefined)?.nodes;
    const attached = stringValue(node.attached_node)
      ?? (Array.isArray(dependsOn) ? dependsOn.map(String).find((ref) => ref.startsWith('model.')) : undefined);
    if (!attached) continue;
    const modelName = attached.split('.').at(-1);
    if (!modelName) continue;
    const existing = byModel.get(modelName) ?? [];
    if (!existing.includes(column)) existing.push(column);
    byModel.set(modelName, existing);
  }
  return byModel;
}

const OBJECT_PRIORITY: Record<string, number> = {
  dql_block: 1,
  dql_block_output: 1.5,
  semantic_metric: 2,
  dql_term: 3,
  business_view: 4,
  semantic_dimension: 5,
  semantic_measure: 6,
  semantic_entity: 7,
  dql_entity: 7,
  relationship: 7.2,
  contract: 7.4,
  model_area: 7.6,
  // Was absent entirely, so a capsule scored 0 and could never win a slot in
  // the retrieval window -- the compiled domain context was unreachable.
  domain_capsule: 7.7,
  semantic_model: 8,
  dbt_model: 9,
  dbt_source: 10,
  dbt_column: 11,
  warehouse_table: 12,
  warehouse_column: 12.5,
  runtime_value: 12.2,
  notebook: 13,
  dashboard: 14,
  app: 15,
  domain: 16,
};

const COLUMN_OBJECT_TYPES = new Set(['dbt_column', 'warehouse_column', 'runtime_column', 'runtime_value']);
// v3 removes the legacy persisted plaintext runtime-value cache (SEC-003).
// v6 expands the bounded relation-level FTS projection for embedded dbt
// columns.  This must invalidate older snapshots: enterprise imports above
// the individual-column object threshold otherwise retain the old first-500
// column projection and cannot discover a relevant later column.
const METADATA_INDEX_VERSION = 'metadata-index-v7-qualified-vector-lanes-relation-columns';
const DEFAULT_VECTOR_PROVIDER = new HashedTokenEmbeddingProvider();

export function defaultMetadataPath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'cache', 'metadata.sqlite');
}

/**
 * Snapshots are immutable and addressed by content fingerprint, so
 * `exportSnapshot` refuses to overwrite an existing file. The embedded VECTORS
 * are part of what a snapshot contains but are NOT part of the content
 * fingerprint, so two different encodings of identical content would otherwise
 * collide on one path — and switching `ai.embeddings` would silently keep
 * serving the hashed vectors forever. Qualify the filename with the provider so
 * they are the distinct artifacts they actually are.
 */
export function metadataSnapshotPath(
  projectRoot: string,
  fingerprint: string,
  vectorProviderId?: string,
): string {
  const suffix = vectorProviderId && !vectorProviderId.startsWith('hashed-token')
    ? `-${vectorProviderId.replace(/[^a-z0-9]+/gi, '_').slice(0, 48)}`
    : '';
  return join(projectRoot, '.dql', 'cache', 'snapshots', `${METADATA_INDEX_VERSION}-${fingerprint}${suffix}.sqlite`);
}

interface ActiveMetadataSnapshotPointer {
  snapshotId: string;
  snapshotPath: string;
  indexSchemaVersion?: string;
}

function readActiveMetadataSnapshotPointer(projectRoot: string): ActiveMetadataSnapshotPointer | null {
  const pointerPath = join(projectRoot, '.dql', 'cache', 'active-snapshot.json');
  if (!existsSync(pointerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pointerPath, 'utf8')) as Record<string, unknown>;
    const snapshotId = typeof parsed.snapshotId === 'string' ? parsed.snapshotId : '';
    const snapshotPath = typeof parsed.snapshotPath === 'string' ? parsed.snapshotPath : '';
    const indexSchemaVersion = typeof parsed.indexSchemaVersion === 'string'
      ? parsed.indexSchemaVersion
      : undefined;
    if (!snapshotId || !snapshotPath || !existsSync(snapshotPath)) return null;
    return { snapshotId, snapshotPath, indexSchemaVersion };
  } catch {
    return null;
  }
}

export function activeMetadataSnapshotPath(projectRoot: string): string | null {
  return readActiveMetadataSnapshotPointer(projectRoot)?.snapshotPath ?? null;
}

/** Read the prepared catalog identity without rebuilding the metadata snapshot. */
export function currentMetadataFingerprint(projectRoot: string): string | undefined {
  if (!existsSync(defaultMetadataPath(projectRoot))) return undefined;
  const catalog = openMetadataCatalog(projectRoot);
  try {
    return catalog.state('fingerprint') ?? undefined;
  } finally {
    catalog.close();
  }
}

function activateMetadataSnapshot(projectRoot: string, fingerprint: string, catalog: MetadataCatalog): string {
  const snapshotPath = metadataSnapshotPath(projectRoot, fingerprint, catalog.state('vector_provider') ?? undefined);
  catalog.exportSnapshot(snapshotPath);
  const cacheDir = join(projectRoot, '.dql', 'cache');
  const pointerPath = join(cacheDir, 'active-snapshot.json');
  const candidate = `${pointerPath}.candidate`;
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(candidate, JSON.stringify({
    snapshotId: fingerprint,
    indexSchemaVersion: METADATA_INDEX_VERSION,
    snapshotPath,
  }, null, 2), 'utf8');
  renameSync(candidate, pointerPath);
  // Do not delete older immutable files here: a request that acquired the old
  // pointer may still hold it open. Cache cleanup is an explicit maintenance
  // concern until the snapshot service owns reference-counted leases.
  return snapshotPath;
}

export function openMetadataCatalog(projectRoot: string, dbPath = defaultMetadataPath(projectRoot)): MetadataCatalog {
  return new MetadataCatalog(dbPath);
}

export function openActiveKnowledgeSnapshot(projectRoot: string): MetadataCatalog {
  const path = activeMetadataSnapshotPath(projectRoot) ?? defaultMetadataPath(projectRoot);
  return new MetadataCatalog(path, { readOnly: path !== defaultMetadataPath(projectRoot) });
}

export interface ActiveKnowledgeSnapshotLease {
  readonly snapshotId: string;
  readonly path: string;
  readonly catalog: MetadataCatalog;
  release(): void;
}

const activeKnowledgeSnapshotLeases = new Map<string, number>();

/**
 * Acquire one exact immutable SQLite file for a request lifetime. The active
 * pointer is read once; later activations cannot redirect this lease to a
 * different catalog. Callers must release in `finally`.
 *
 * Acceptance: CTX-002, CTX-005.
 */
export function acquireActiveKnowledgeSnapshot(projectRoot: string): ActiveKnowledgeSnapshotLease {
  const pointer = readActiveMetadataSnapshotPointer(projectRoot);
  const path = pointer?.snapshotPath ?? defaultMetadataPath(projectRoot);
  const catalog = new MetadataCatalog(path, { readOnly: Boolean(pointer) });
  const catalogFingerprint = catalog.state('fingerprint') ?? 'metadata-unavailable';
  if (pointer && pointer.snapshotId !== catalogFingerprint) {
    catalog.close();
    throw new Error(`Active metadata snapshot pointer mismatch (pointer ${pointer.snapshotId}, catalog ${catalogFingerprint}).`);
  }
  activeKnowledgeSnapshotLeases.set(path, (activeKnowledgeSnapshotLeases.get(path) ?? 0) + 1);
  let released = false;
  return Object.freeze({
    snapshotId: catalogFingerprint,
    path,
    catalog,
    release(): void {
      if (released) return;
      released = true;
      catalog.close();
      const remaining = (activeKnowledgeSnapshotLeases.get(path) ?? 1) - 1;
      if (remaining > 0) activeKnowledgeSnapshotLeases.set(path, remaining);
      else activeKnowledgeSnapshotLeases.delete(path);
    },
  });
}

export function activeKnowledgeSnapshotLeaseCount(path?: string): number {
  if (path) return activeKnowledgeSnapshotLeases.get(path) ?? 0;
  return Array.from(activeKnowledgeSnapshotLeases.values()).reduce((sum, count) => sum + count, 0);
}

export interface IndexedDomainKnowledge {
  schemaVersion: 2;
  snapshotId: string;
  sourceFingerprint: string;
  domainId: string;
  capsule?: ManifestDomainCapsule;
  counts: { objects: number; edges: number; routes: number; routeStates: Record<string, number> };
  objects: ManifestKnowledgeObject[];
  edges: ManifestKnowledgeEdge[];
  routes: ManifestCrossDomainRoute[];
  truncated: boolean;
}

export function readIndexedDomainKnowledge(projectRoot: string, domainId: string): IndexedDomainKnowledge | null {
  const catalog = openActiveKnowledgeSnapshot(projectRoot);
  try {
    const snapshotId = catalog.state('fingerprint') ?? 'metadata-unavailable';
    const capsuleObject = catalog.listAllObjects({ objectTypes: ['domain_capsule'], domain: domainId })
      .find((item) => !stringValue(item.payload?.modelAreaId));
    const capsule = capsuleObject?.payload as ManifestDomainCapsule | undefined;
    if (!capsule) return null;
    const rows = catalog.listAllObjects({ domain: domainId })
      .filter((item) => item.objectType !== 'domain_capsule' && item.objectType !== 'cross_domain_route');
    const selectedRows = rows.slice(0, 750);
    const byKey = new Map(selectedRows.map((row) => [row.objectKey, metadataObjectToKnowledge(row)]));
    const edgeRows = catalog.edgesForKeys(selectedRows.map((row) => row.objectKey), 1).slice(0, 1_500);
    for (const edge of edgeRows) {
      if (!byKey.has(edge.fromKey)) {
        const item = catalog.getObject(edge.fromKey);
        if (item) byKey.set(edge.fromKey, metadataObjectToKnowledge(item));
      }
      if (!byKey.has(edge.toKey)) {
        const item = catalog.getObject(edge.toKey);
        if (item) byKey.set(edge.toKey, metadataObjectToKnowledge(item));
      }
    }
    const routes = catalog.listAllObjects({ objectTypes: ['cross_domain_route'] })
      .flatMap((item) => metadataRoute(item) ? [metadataRoute(item)!] : [])
      .filter((route) => route.providerDomainId === domainId || route.consumerDomainId === domainId);
    const routeStates = routes.reduce<Record<string, number>>((counts, route) => {
      counts[route.state] = (counts[route.state] ?? 0) + 1;
      return counts;
    }, {});
    return {
      schemaVersion: 2,
      snapshotId,
      sourceFingerprint: stringValue(capsuleObject?.payload?.sourceFingerprint) ?? snapshotId,
      domainId,
      capsule,
      counts: { objects: rows.length, edges: edgeRows.length, routes: routes.length, routeStates },
      objects: selectedRows.map(metadataObjectToKnowledge),
      edges: edgeRows.map((edge) => metadataEdgeToKnowledge(edge, byKey)),
      routes,
      truncated: rows.length > selectedRows.length || edgeRows.length >= 1_500,
    };
  } finally {
    catalog.close();
  }
}

export function readIndexedKnowledge360(projectRoot: string, identity: string) {
  const catalog = openActiveKnowledgeSnapshot(projectRoot);
  try {
    const focusRow = catalog.findObjectByIdentity(identity);
    if (!focusRow) return null;
    const edgeRows = catalog.edgesForKeys([focusRow.objectKey], 2).slice(0, 500);
    const keys = [...new Set([focusRow.objectKey, ...edgeRows.flatMap((edge) => [edge.fromKey, edge.toKey])])].slice(0, 160);
    const rows = catalog.getObjectsByKeys(keys);
    const byKey = new Map(rows.map((row) => [row.objectKey, metadataObjectToKnowledge(row)]));
    const objects = rows.map(metadataObjectToKnowledge);
    const domains = new Set(objects.flatMap((item) => item.domainId ? [item.domainId] : []));
    const routes = catalog.listAllObjects({ objectTypes: ['cross_domain_route'] })
      .flatMap((item) => metadataRoute(item) ? [metadataRoute(item)!] : [])
      .filter((route) => domains.has(route.providerDomainId) && domains.has(route.consumerDomainId));
    return {
      snapshotId: catalog.state('fingerprint') ?? 'metadata-unavailable',
      sourceFingerprint: catalog.state('fingerprint') ?? 'metadata-unavailable',
      focus: metadataObjectToKnowledge(focusRow),
      objects,
      edges: edgeRows.filter((edge) => byKey.has(edge.fromKey) && byKey.has(edge.toKey)).map((edge) => metadataEdgeToKnowledge(edge, byKey)),
      routes,
      truncated: keys.length >= 160 || edgeRows.length >= 500,
    };
  } finally {
    catalog.close();
  }
}

/**
 * In-flight vector upgrades, so a caller that needs semantic retrieval right
 * away (tests, `zlens compile`) can await one instead of racing it.
 */
const pendingVectorUpgrades = new Map<string, Promise<void>>();

/** Await any vector-index upgrade started by the last catalog refresh. */
export async function awaitVectorIndexUpgrade(projectRoot: string): Promise<void> {
  const pending = pendingVectorUpgrades.get(projectRoot);
  if (!pending) return;
  await pending;
  pendingVectorUpgrades.delete(projectRoot);
}

/**
 * Re-embed the vector index with the project's configured provider.
 *
 * The snapshot write is synchronous — vectors are produced inside a
 * better-sqlite3 transaction — so it can only use the hashed provider, whose
 * `embedOne` is sync. Remote providers (Ollama, OpenAI) are async-only, so a
 * real embedder could never participate and the "vector" lane stayed a
 * bag-of-words hash no matter what was configured.
 *
 * This runs AFTER the transaction, where awaiting is fine. The hashed index is
 * already in place by then, so the vector lane is never empty while the upgrade
 * runs or if it fails. Best-effort by design: an unreachable Ollama must not
 * break indexing or answering.
 */
/** How long a cold re-embed may hold up indexing before we ship the hashed index. */
const VECTOR_UPGRADE_BUDGET_MS = 8_000;

/**
 * Re-embed an ALREADY-OPEN catalog. Split out from `upgradeVectorIndexForProject`
 * so `ensureMetadataCatalogFresh` can upgrade the same catalog handle it is about
 * to export — the vectors have to be in place BEFORE `activateMetadataSnapshot`,
 * because retrieval reads the exported snapshot, not this working database.
 */
async function upgradeVectorIndexOnCatalog(
  catalog: MetadataCatalog,
  provider: EmbeddingProvider,
): Promise<{ upgraded: boolean; providerId: string; reason?: string }> {
  if (provider.id.startsWith('hashed-token')) {
    return { upgraded: false, providerId: provider.id, reason: 'project uses the offline hashed embedder' };
  }
  if (catalog.state('vector_provider') === provider.id) {
    return { upgraded: false, providerId: provider.id, reason: 'index already embedded with this provider' };
  }
  try {
    await catalog.rebuildVectorIndex(provider);
    return { upgraded: true, providerId: provider.id };
  } catch (error) {
    return {
      upgraded: false,
      providerId: catalog.state('vector_provider') ?? DEFAULT_VECTOR_PROVIDER.id,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function upgradeVectorIndexForProject(
  projectRoot: string,
  provider: EmbeddingProvider,
): Promise<{ upgraded: boolean; providerId: string; reason?: string }> {
  const catalog = openMetadataCatalog(projectRoot);
  try {
    const result = await upgradeVectorIndexOnCatalog(catalog, provider);
    // Re-export so the ACTIVE snapshot carries the new vectors. Without this the
    // upgrade only ever touched the mutable working database, which the answer
    // path never reads — so `POST /api/settings/embeddings/reindex` reported
    // success while retrieval kept serving the hashed index.
    if (result.upgraded) {
      const fingerprint = catalog.state('fingerprint');
      if (fingerprint) activateMetadataSnapshot(projectRoot, fingerprint, catalog);
    }
    return result;
  } finally {
    catalog.close();
  }
}

export async function ensureMetadataCatalogFresh(
  projectRoot: string,
  options: EnsureMetadataCatalogOptions = {},
): Promise<EnsureMetadataCatalogResult> {
  const semanticLayer = options.semanticLayer !== undefined
    ? options.semanticLayer ?? undefined
    : loadAgentSemanticLayer(projectRoot);
  const manifest = options.manifest ?? loadAgentManifest(projectRoot);
  const skills = options.skills ?? loadSkills(projectRoot).skills;
  const snapshot = buildMetadataSnapshot(projectRoot, manifest, semanticLayer, skills, options.graphs);
  const catalog = openMetadataCatalog(projectRoot);
  try {
    const existing = catalog.state('fingerprint');
    const compatibleIndex = catalog.state('index_version') === METADATA_INDEX_VERSION;
    // The snapshot write embeds with the sync hashed provider (better-sqlite3
    // transactions cannot await), so a configured Ollama/OpenAI embedder can only
    // be applied afterwards — and it must land BEFORE the export, since retrieval
    // reads the exported snapshot. `searchVectorObjects` returns ZERO candidates
    // when the requested provider id does not match the indexed one, so skipping
    // this makes configuring a real embedder strictly worse than not configuring
    // one: an empty vector lane instead of a weak one.
    const vectorProvider = options.embeddingProvider ?? projectEmbeddingProvider(projectRoot);
    const upgradeVectors = async (): Promise<void> => {
      const upgrade = upgradeVectorIndexOnCatalog(catalog, vectorProvider);
      pendingVectorUpgrades.set(projectRoot, upgrade.then(() => undefined, () => undefined));
      // Never let a cold or unreachable embedder block indexing: the hashed index
      // is already in place, so timing out simply ships it and the next refresh
      // retries.
      await Promise.race([
        upgrade,
        new Promise((resolve) => setTimeout(resolve, VECTOR_UPGRADE_BUDGET_MS)),
      ]);
    };
    if (!options.force && compatibleIndex && existing === snapshot.fingerprint) {
      // The project content is unchanged but the CONFIGURED EMBEDDER may not be.
      // Without this, switching `ai.embeddings` never takes effect until an
      // unrelated dbt change happens to move the fingerprint.
      await upgradeVectors();
      const snapshotPath = activateMetadataSnapshot(projectRoot, snapshot.fingerprint, catalog);
      return {
        path: defaultMetadataPath(projectRoot),
        snapshotPath,
        refreshed: false,
        objectCount: catalog.objectCount(),
        edgeCount: catalog.edgeCount(),
        diagnostics: catalog.diagnostics(),
        fingerprint: snapshot.fingerprint,
      };
    }
    // W3.4 — incremental reindex when prior state exists (only re-tokenizes changed
    // sources' FTS); `force` does a clean full rebuild. Proven equal to a full
    // rebuild by incremental-reindex.test.ts.
    if (options.force || !compatibleIndex) {
      catalog.rebuild(snapshot);
    } else {
      catalog.rebuildIncremental(snapshot);
    }
    await upgradeVectors();
    const snapshotPath = activateMetadataSnapshot(projectRoot, snapshot.fingerprint, catalog);
    return {
      path: defaultMetadataPath(projectRoot),
      snapshotPath,
      refreshed: true,
      objectCount: snapshot.objects.length,
      edgeCount: snapshot.edges.length,
      diagnostics: snapshot.diagnostics,
      fingerprint: snapshot.fingerprint,
    };
  } finally {
    catalog.close();
  }
}

export function upsertMetadataSnapshot(projectRoot: string, snapshot: MetadataSnapshot): EnsureMetadataCatalogResult {
  const catalog = openMetadataCatalog(projectRoot);
  try {
    catalog.rebuild(snapshot);
    const snapshotPath = activateMetadataSnapshot(projectRoot, snapshot.fingerprint, catalog);
    return {
      path: defaultMetadataPath(projectRoot),
      snapshotPath,
      refreshed: true,
      objectCount: snapshot.objects.length,
      edgeCount: snapshot.edges.length,
      diagnostics: snapshot.diagnostics,
      fingerprint: snapshot.fingerprint,
    };
  } finally {
    catalog.close();
  }
}

/**
 * Run exact, BM25/lexical, vector, and graph candidate generation as
 * independent lanes over one acquired snapshot. Domain/import eligibility is
 * applied in SQL or before graph admission, never as a post-ranking boost.
 *
 * Acceptance: CTX-005, AGT-009, AGT-010.
 */
export async function retrieveMetadataSnapshotCandidates(
  catalog: MetadataCatalog,
  input: {
    question: string;
    searchQueries?: string[];
    objectTypes?: string[];
    domainContext?: DomainContextEnvelope;
    embeddingProvider?: EmbeddingProvider;
    /** Needed to resolve the project's configured embedder for the vector lane. */
    projectRoot?: string;
    limit?: number;
  },
): Promise<MetadataSnapshotRetrievalResult> {
  const limit = Math.max(1, input.limit ?? 80);
  const domains = domainContextSearchDomains(input.domainContext);
  const isEligible = (object: MetadataObject): boolean => (
    object.objectType !== 'skill'
    && !isAppOnlySemanticDatasetSource(object)
    && (!input.objectTypes?.length || input.objectTypes.includes(object.objectType))
    && (domains.length === 0 || !object.domain || domains.includes(object.domain))
  );
  const explicitIdentities = explicitMetadataIdentities(input.question);
  const queries = uniqueMetadataSearchQueries(input.searchQueries?.length
    ? input.searchQueries
    : [input.question]);
  // Context lanes are genuinely independent and bounded. Their fan-out is
  // deliberately before graph expansion: graph admission depends on the
  // successful seed lanes, while an embedding failure must not block lexical
  // or exact retrieval (CTX-007/PERF-003).
  let vector: Awaited<ReturnType<MetadataCatalog['searchVectorObjects']>> | undefined;
  let exactObjects: MetadataObject[] = [];
  let lexicalObjects: MetadataObject[] = [];
  let vectorObjects: MetadataObject[] = [];
  const laneCards = await retrieveContextLanes({
    exact: async () => {
      exactObjects = explicitIdentities.flatMap((identity) => {
        const resolution = catalog.resolveIdentity(identity);
        return resolution.status === 'resolved' && resolution.object && isEligible(resolution.object)
          ? [resolution.object]
          : [];
      });
      return exactObjects.map((object) => ({
        id: object.objectKey,
        lane: 'exact' as const,
        relevance: 1,
        summary: object.name,
      }));
    },
    lexical: async () => {
      lexicalObjects = mergeObjects(queries.flatMap((query) => catalog.searchObjects({
        query,
        objectTypes: input.objectTypes,
        domains: domains.length > 0 ? domains : undefined,
        limit,
      }))).filter(isEligible).slice(0, limit);
      return lexicalObjects.map((object) => ({
        id: object.objectKey,
        lane: 'lexical' as const,
        relevance: object.score ?? 0,
        summary: object.name,
      }));
    },
    vector: async () => {
      vector = await catalog.searchVectorObjects({
        query: input.question,
        objectTypes: input.objectTypes,
        domains: domains.length > 0 ? domains : undefined,
        limit: Math.min(limit, 24),
        provider: input.embeddingProvider
          ?? (input.projectRoot ? projectEmbeddingProvider(input.projectRoot) : undefined),
        resolveIndexedProvider: (indexedProviderId) => embeddingProviderFromIndexedId(indexedProviderId),
      });
      vectorObjects = vector.candidates.filter(isEligible);
      return vectorObjects.map((object) => ({
        id: object.objectKey,
        lane: 'vector' as const,
        relevance: object.score ?? 0,
        summary: object.name,
      }));
    },
  }, Math.min(limit * 2, 100));
  const seedKeys = mergeObjects([...exactObjects, ...lexicalObjects.slice(0, 12), ...vectorObjects.slice(0, 12)])
    .map((object) => object.objectKey);
  const graphStartedAt = Date.now();
  let graphError: string | undefined;
  let graphEdges: MetadataEdge[] = [];
  try {
    graphEdges = catalog.edgesForKeys(seedKeys, 1);
  } catch (error) {
    graphError = error instanceof Error ? error.message : String(error);
  }
  let graphObjects: MetadataObject[] = [];
  if (!graphError) {
    try {
      graphObjects = catalog.getObjectsByKeys(
        Array.from(new Set(graphEdges.flatMap((edge) => [edge.fromKey, edge.toKey]))),
      ).filter((object) => isEligible(object) && !seedKeys.includes(object.objectKey)).slice(0, Math.min(limit, 24));
    } catch (error) {
      // Graph expansion is advisory. Preserve exact/lexical/vector candidates
      // and expose the typed graph failure in the lane diagnostics.
      graphError = error instanceof Error ? error.message : String(error);
      graphObjects = [];
    }
  }
  const lanes: MetadataRetrievalLaneResult[] = [
    retrievalLane('exact', exactObjects, (object) => explicitIdentities.includes(object.objectKey)
      ? 'exact object-key reference'
      : 'resolved qualified/native/alias reference'),
    retrievalLane('lexical', lexicalObjects, () => 'BM25/lexical candidate from the immutable snapshot'),
    {
      ...retrievalLane('vector', vectorObjects, () => `independent vector candidate from ${vector?.providerId ?? 'unavailable'}`),
      ...(vector?.providerId ? { provider: vector.providerId } : {}),
      ...(vector?.unavailableReason ? { unavailableReason: vector.unavailableReason } : {}),
    },
    retrievalLane('graph', graphObjects, () => 'one-hop neighbor of an eligible exact/lexical/vector seed'),
  ];
  const allLaneCards = {
    exact: exactObjects.map((object): ContextCandidateCardV1 => ({
      id: object.objectKey,
      lane: 'exact',
      relevance: 1,
      summary: object.name,
    })),
    lexical: lexicalObjects.map((object): ContextCandidateCardV1 => ({
      id: object.objectKey,
      lane: 'lexical',
      relevance: object.score ?? 0,
      summary: object.name,
    })),
    vector: vectorObjects.map((object): ContextCandidateCardV1 => ({
      id: object.objectKey,
      lane: 'vector',
      relevance: object.score ?? 0,
      summary: object.name,
    })),
    graph: graphObjects.map((object): ContextCandidateCardV1 => ({
      id: object.objectKey,
      lane: 'graph',
      relevance: object.score ?? 0,
      summary: object.name,
    })),
  } satisfies Record<string, ContextCandidateCardV1[]>;
  const fused = fuseContextCandidates(allLaneCards, Math.min(limit * 2, 100));
  const objectsByKey = new Map(
    mergeObjects([...exactObjects, ...lexicalObjects, ...vectorObjects, ...graphObjects])
      .map((object) => [object.objectKey, object] as const),
  );
  const selected = fused.candidates
    .map((candidate) => objectsByKey.get(candidate.id))
    .filter((object): object is MetadataObject => Boolean(object));
  return {
    snapshotId: catalog.state('fingerprint') ?? 'metadata-unavailable',
    selected,
    lanes,
    fusion: {
      selectedKeys: fused.diagnostics.selectedIds,
      truncated: fused.diagnostics.truncated,
      lanes: {
        ...laneCards.diagnostics.lanes,
        graph: {
          returned: graphObjects.length,
          durationMs: Date.now() - graphStartedAt,
          status: graphError ? 'error' : graphObjects.length > 0 ? 'ok' : 'empty',
          ...(graphError ? { error: graphError } : {}),
        },
      },
    },
  };
}

function retrievalLane(
  lane: MetadataRetrievalLaneName,
  objects: MetadataObject[],
  reason: (object: MetadataObject) => string,
): MetadataRetrievalLaneResult {
  return {
    lane,
    candidates: objects.map((object, index) => ({
      objectKey: object.objectKey,
      objectType: object.objectType,
      name: object.name,
      rank: index + 1,
      score: Number((object.score ?? (1 / (index + 1))).toFixed(6)),
      reason: reason(object),
    })),
  };
}

function explicitMetadataIdentities(question: string): string[] {
  const identities: string[] = [];
  for (const match of question.matchAll(/@(metric|dimension|measure|entity|model|block|term)\(([^)]+)\)/gi)) {
    const identity = match[2]?.trim();
    if (identity) identities.push(identity);
  }
  for (const match of question.matchAll(/\b(?:semantic|dql|dbt|skill):[a-z0-9_.:-]+/gi)) {
    identities.push(match[0]);
  }
  return Array.from(new Set(identities));
}

export async function buildLocalContextPack(
  projectRoot: string,
  request: BuildLocalContextPackRequest,
): Promise<LocalContextPack> {
  let prepared = false;
  if (request.preparedMetadataFingerprint) {
    const catalog = openMetadataCatalog(projectRoot);
    try {
      prepared = catalog.state('fingerprint') === request.preparedMetadataFingerprint;
    } finally {
      catalog.close();
    }
  }
  if (!prepared) await ensureMetadataCatalogFresh(projectRoot);
  // Static governed knowledge is read from the immutable content-addressed
  // snapshot selected at request start. Mutable run history, runtime schema,
  // and context packs stay in the working catalog and never alter that view.
  const snapshotLease = acquireActiveKnowledgeSnapshot(projectRoot);
  const snapshotPath = snapshotLease.path;
  const catalog = snapshotLease.catalog;
  const runtimeCatalog = openMetadataCatalog(projectRoot);
  try {
    const mode = request.mode ?? 'question';
    const includeDraftBlocks = allowsDraftBlockRetrieval(request);
    const followUp = normalizeFollowUpContext(request.followUp);
    const questionPlan = buildAnalysisQuestionPlan(request.question, followUp ?? undefined);
    if (questionPlan.requestedShape.filters.length > 0) {
      // Title-cased governed names ("Previous Day BCM") must not survive as
      // member filters — see reclassifyGovernedNameMentions.
      try {
        reclassifyGovernedNameMentions(
          questionPlan,
          buildGovernedTermIndex(runtimeCatalog.listObjects({
            objectTypes: ['semantic_metric', 'semantic_measure', 'semantic_dimension', 'dql_block'],
            limit: 2000,
          })),
          request.question,
        );
      } catch { /* reclassification is best-effort; the plan stays usable */ }
    }

    // ── Conversation-aware context reuse ──────────────────────────────────
    // The prior turn's pack is fuel: a filter/limit-only REFINEMENT re-stamps it
    // (skipping FTS fan-out, both ranking passes, route planning, and the
    // fit-confirm LLM); CONTINUATION/RETURN seed its objects into ranking as
    // candidates only; a SHIFT ignores it. A metadata fingerprint mismatch
    // always disqualifies reuse.
    const reusePolicy = request.reusePolicy ?? 'seed';
    const priorPack = !request.domainContext && reusePolicy !== 'off'
      && request.priorContextPackId
      && request.conversationTopicRelation
      && request.conversationTopicRelation !== 'shift'
      ? runtimeCatalog.getContextPack(request.priorContextPackId)
      : null;
    const runtimeSchemaIdentityMatches = Boolean(
      (priorPack?.freshness.runtimeSchemaConnectionId ?? undefined)
        === (request.runtimeSchemaSnapshot?.connectionId ?? undefined)
      && (priorPack?.freshness.runtimeSchemaScopeFingerprint ?? undefined)
        === (request.runtimeSchemaSnapshot?.scopeFingerprint ?? undefined)
      && (priorPack?.freshness.runtimeSchemaGenerationId ?? undefined)
        === (request.runtimeSchemaSnapshot?.generationId ?? undefined)
      && (priorPack?.freshness.runtimeSchemaCapturedAt ?? undefined)
        === (request.runtimeSchemaSnapshot?.capturedAt ?? undefined),
    );
    const priorPackFresh = Boolean(
      priorPack
      && priorPack.freshness.fingerprint === catalog.state('fingerprint')
      && runtimeSchemaIdentityMatches
      && (includeDraftBlocks || !priorPack.objects.some(isUncertifiedDqlBlock)),
    );
    if (
      priorPack
      && priorPackFresh
      && request.conversationTopicRelation === 'refinement'
      && isFilterOnlyRefinement(priorPack.questionPlan, questionPlan)
    ) {
      // Route commitment: the prior route decision was already fit-validated for
      // this grain/measures/dimensions; only filters/limit/timeframe changed.
      const reusedPayload: Omit<LocalContextPack, 'id'> = {
        ...priorPack,
        question: request.question,
        questionPlan,
        followUp: followUp ?? undefined,
        retrievalDiagnostics: {
          ...priorPack.retrievalDiagnostics,
          strategy: 'reused_pack_refinement',
        },
        freshness: {
          catalogPath: snapshotPath,
          builtAt: catalog.state('built_at'),
          fingerprint: catalog.state('fingerprint'),
          ...(request.runtimeSchemaSnapshot?.connectionId
            ? { runtimeSchemaConnectionId: request.runtimeSchemaSnapshot.connectionId }
            : {}),
          ...(request.runtimeSchemaSnapshot?.scopeFingerprint
            ? { runtimeSchemaScopeFingerprint: request.runtimeSchemaSnapshot.scopeFingerprint }
            : {}),
          ...(request.runtimeSchemaSnapshot?.generationId
            ? { runtimeSchemaGenerationId: request.runtimeSchemaSnapshot.generationId }
            : {}),
          ...(request.runtimeSchemaSnapshot?.capturedAt
            ? { runtimeSchemaCapturedAt: request.runtimeSchemaSnapshot.capturedAt }
            : {}),
        },
      };
      delete (reusedPayload as Partial<LocalContextPack>).id;
      const reusedId = runtimeCatalog.insertContextPack(reusedPayload);
      return { ...reusedPayload, id: reusedId };
    }
    const priorSeedObjects = priorPack && priorPackFresh
      && (
        request.conversationTopicRelation === 'continuation'
        || request.conversationTopicRelation === 'refinement'
        || request.conversationTopicRelation === 'return'
      )
      ? priorPack.objects.slice(0, 24)
      : [];

    const searchQueries = uniqueMetadataSearchQueries([
      buildFollowUpSearchQuery(request.question, followUp),
      ...questionPlan.searchQueries,
    ]);
    // Runtime database schemas live in a separate persisted FTS lane. Normal Ask
    // requests hydrate only relevant tables, so thousands of tables and hundreds
    // of thousands of columns never become a request-path full-catalog scan.
    // Explicit snapshots remain supported for callers that already hold a small,
    // question-scoped schema payload.
    const runtimeObjects = request.runtimeSchemaSnapshot
      ? runtimeSchemaObjects(request.runtimeSchemaSnapshot)
      : runtimeCatalog.searchRuntimeSchemaObjects(searchQueries.join(' '), Math.max(request.limit ?? 80, 20));
    const runtimeValueObjects = runtimeValueMatchObjects(runtimeCatalog.searchRuntimeValues(
      metadataValueSearchTerms(request.question, questionPlan, followUp),
      32,
    ));
    const selectedObjects = selectedContextObjects(request.selectedContext);
    const followUpObjects = followUpContextObjects(followUp);
    let graphError: string | undefined;
    let followUpSourceObjects: MetadataObject[] = [];
    try {
      followUpSourceObjects = catalog.getObjectsByKeys(followUpSourceObjectKeys(followUp));
    } catch (error) {
      // A stale follow-up source reference is advisory context. Keep the
      // successful exact/lexical/vector lanes and surface a typed graph lane
      // diagnostic instead of failing the entire context pack (CTX-007).
      graphError = error instanceof Error ? error.message : String(error);
    }
    const areaObjects = filterMetadataObjectsByDomainContext(
      catalog.listAllObjects({ objectTypes: ['model_area'] }),
      request.domainContext,
    );
    const focusedArea = resolveFocusedModelArea(request.domainContext, request.question, areaObjects);
    const effectiveDomainContext = focusedArea && request.domainContext
      ? { ...request.domainContext, modelAreaId: focusedArea.id }
      : request.domainContext;
    const scopeObjects = (rows: MetadataObject[]) => filterMetadataObjectsByDomainContext(rows, effectiveDomainContext);
    // Skill guidance is injected only through selectContextPackSkills below.
    // Leaving it in generic FTS results would bypass status/domain/area/exclusion
    // eligibility simply because a word in its body matched the question.
    const retrievalObjects = (rows: MetadataObject[]) => scopeObjects(rows).filter((row) =>
      row.objectType !== 'skill'
      && !isAppOnlySemanticDatasetSource(row)
      && (includeDraftBlocks || !isUncertifiedDqlBlock(row))
    );
    const snapshotRetrieval = await retrieveMetadataSnapshotCandidates(catalog, {
      question: request.question,
      searchQueries,
      objectTypes: request.objectTypes,
      domainContext: effectiveDomainContext,
      projectRoot,
      limit: Math.max(request.limit ?? 80, 20),
    });
    const searchRows = retrievalObjects(snapshotRetrieval.selected);
    const schemaShapeCandidates = schemaShapeCandidateObjects(catalog, questionPlan, request, mergeObjects([...runtimeObjects, ...runtimeValueObjects]));
    const schemaShapeObjects = schemaShapeCandidates.map((candidate) => candidate.object);
    const exactCandidate = request.focusObjectKey ? catalog.getObject(request.focusObjectKey) : null;
    const exact = exactCandidate && retrievalObjects([exactCandidate]).length > 0 ? exactCandidate : null;
    const ranked = rankMetadataObjects({
      rows: retrievalObjects(mergeObjects(exact
        ? [exact, ...(focusedArea ? [focusedArea.object] : []), ...followUpSourceObjects, ...followUpObjects, ...searchRows, ...schemaShapeObjects, ...runtimeObjects, ...runtimeValueObjects, ...selectedObjects, ...priorSeedObjects]
        : [...(focusedArea ? [focusedArea.object] : []), ...followUpSourceObjects, ...followUpObjects, ...searchRows, ...schemaShapeObjects, ...runtimeObjects, ...runtimeValueObjects, ...selectedObjects, ...priorSeedObjects])),
      question: searchQueries.join(' '),
      questionPlan,
      modelAreaId: focusedArea?.id,
      limit: request.limit ?? 80,
    });
    // Advisory 'contextual' carry: the prior turn's block competes on rank (it is
    // already in the candidate rows above) but is never FORCED into selection or
    // allowed to become the derived focus of a possibly-new-topic question.
    const selected = followUp?.kind === 'contextual'
      ? ranked.selected
      : mergeObjects([...followUpSourceObjects, ...followUpObjects, ...ranked.selected]);
    const focusObjectKey = request.focusObjectKey ?? selected[0]?.objectKey ?? null;
    let edgeWalk: MetadataEdge[] = [];
    let graphObjects: MetadataObject[] = [];
    try {
      edgeWalk = catalog.edgesForKeys(selected.map((row) => row.objectKey), 3);
      const edgeObjectKeys = Array.from(new Set(edgeWalk.flatMap((edge) => [edge.fromKey, edge.toKey])));
      graphObjects = retrievalObjects(catalog.getObjectsByKeys(edgeObjectKeys));
    } catch (error) {
      // The graph is an enrichment lane. A stale/corrupt graph must not discard
      // successful snapshot, runtime, or semantic candidates (CTX-007).
      graphError = error instanceof Error ? error.message : String(error);
      edgeWalk = [];
      graphObjects = [];
    }
    const rankedObjects = rankMetadataObjects({
      rows: retrievalObjects(mergeObjects([...followUpSourceObjects, ...followUpObjects, ...selected, ...graphObjects, ...schemaShapeObjects, ...runtimeObjects, ...runtimeValueObjects, ...selectedObjects])),
      question: searchQueries.join(' '),
      questionPlan,
      modelAreaId: focusedArea?.id,
      limit: request.limit ?? 120,
    }).selected;
    // Reorder by what the QUESTION needs. RRF and the additive score rank by
    // overlap, distance, and type weight — none of which read the question — so
    // the object that answers it can sit behind ten near-synonyms and be cut by
    // a top-N that never considered the ask. Advisory: the reranker may only
    // reorder ids retrieval already returned, and any failure leaves this list
    // exactly as it was.
    const rerankedObjects = request.rerankCandidates
      ? applyRerank(
        rankedObjects,
        (object) => object.objectKey,
        await request.rerankCandidates(
          searchQueries.join(' '),
          rankedObjects.slice(0, 40).map((object) => ({
            id: object.objectKey,
            summary: [
              object.name,
              object.objectType,
              object.description?.slice(0, 160),
            ].filter(Boolean).join(' — '),
          })),
        ).catch(() => undefined),
      )
      : rankedObjects;
    if (readEnv('ZLENS_ORCHESTRATOR_TRACE') && request.rerankCandidates) {
      const moved = rerankedObjects.findIndex((object, position) =>
        object.objectKey !== rankedObjects[position]?.objectKey);
      console.warn(`[zlens] rerank: ${moved < 0 ? 'no change' : `reordered from position ${moved}`} over ${Math.min(40, rankedObjects.length)} candidates`);
    }
    const sqlParentObjects = sqlParentObjectsForSelectedColumns(
      rerankedObjects,
      mergeObjects([...graphObjects, ...runtimeObjects]),
      questionPlan,
    );
    // Deep-research over a SMALL catalog: skip top-k pruning and hand the model the
    // entire relation set ("send everything, let the agent decide"). Only when the
    // whole catalog fits comfortably in context — otherwise we keep ranked selection.
    const fullCatalogObjects = request.strictness === 'exploratory'
      ? retrievalObjects(collectFullCatalogObjects(catalog) ?? [])
      : undefined;
    const usedFullCatalog = Boolean(fullCatalogObjects);
    // Skills are selected from the catalog snapshot with the same hard domain,
    // area, status, and exclusion gates as the loader. They are not left to FTS
    // chance or re-read from disk after the snapshot has been fingerprinted.
    const selectedSkills = selectContextPackSkills(
      catalog,
      catalog.listAllObjects({ objectTypes: ['skill'] }),
      request.question,
      effectiveDomainContext,
    );
    const selectedSkillObjects = selectedSkills.map((item) => item.object);
    const routeCandidates = effectiveDomainContext?.activeDomain
      ? catalog.crossDomainRouteObjects(effectiveDomainContext.activeDomain, 100)
      : [];
    const routeObjects = rankMetadataObjects({
      rows: retrievalObjects(routeCandidates),
      question: `${request.question} ${effectiveDomainContext?.purpose ?? ''}`,
      questionPlan,
      modelAreaId: focusedArea?.id,
      limit: 8,
    }).selected;
    const objects = fullCatalogObjects
      ? mergeObjects([...rerankedObjects, ...sqlParentObjects, ...fullCatalogObjects, ...selectedSkillObjects, ...routeObjects])
      : mergeObjects([...rerankedObjects, ...sqlParentObjects, ...selectedSkillObjects, ...routeObjects]);
    const objectKeys = objects.map((row) => row.objectKey);
    const allowedObjectKeys = new Set(objectKeys);
    let contextEdges = mergeMetadataEdges(edgeWalk)
      .filter((edge) => allowedObjectKeys.has(edge.fromKey) && allowedObjectKeys.has(edge.toKey));
    try {
      contextEdges = mergeMetadataEdges([
        ...contextEdges,
        ...catalog.edgesForKeys(objectKeys, 2),
      ]).filter((edge) => allowedObjectKeys.has(edge.fromKey) && allowedObjectKeys.has(edge.toKey));
    } catch (error) {
      graphError ??= error instanceof Error ? error.message : String(error);
    }
    const queryRuns = runtimeCatalog.queryRunsForObjectKeys(objectKeys, 20);
    const diagnostics = catalog.diagnostics();
    const warnings = [
      ...buildWarnings(diagnostics, objects),
      ...(graphError ? [`Graph/context enrichment lane unavailable: ${graphError}`] : []),
    ];
    const trustLabel = deriveTrust(objects);
    const citations = buildCitations(objects, contextEdges);
    const evidenceSummaries = buildEvidenceSummaries(objects, contextEdges, queryRuns, diagnostics);
    const allowedSqlContext = sortAllowedSqlContextForAnalysisPlan(buildAllowedSqlContext(objects, contextEdges, tokenizeQuestionForColumns(request.question)), questionPlan);
    const selectedRelations = allowedSqlContext.relations.slice(0, 24).map((relation, index) => {
      const scored = scoreAllowedSqlRelationWithAnalysisPlan(relation, questionPlan);
      return {
        relation: relation.relation,
        name: relation.name,
        source: relation.source,
        score: scored.score,
        reason: scored.reasons.join('; ') || 'relation retained as inspected SQL context',
        columns: relation.columns.slice(0, 24).map((column) => column.name),
        rank: index + 1,
      };
    });
    const selectedJoinPaths = buildSelectedJoinPaths(allowedSqlContext, contextEdges, objects);
    const evidenceRoles = buildEvidenceRoles(objects, queryRuns);
    const reranked = rankMetadataObjects({
      rows: retrievalObjects(mergeObjects([...searchRows, ...schemaShapeObjects, ...objects])),
      question: searchQueries.join(' '),
      questionPlan,
      modelAreaId: focusedArea?.id,
      limit: request.limit ?? 120,
    });
    const conflicts = buildCandidateConflicts(reranked.ranked);
    const meaningEvidence = buildMeaningEvidencePackage(
      request.question,
      questionPlan,
      reranked.ranked,
      snapshotRetrieval.lanes,
    );
    const compileConflicts = catalog.compileConflicts();
    const routeDecision = withMetadataTrustLabelInfo(await planContextPackRoute({
      request,
      objects,
      allowedSqlContext,
      evidenceRoles,
      diagnostics,
      trustLabel,
      questionPlan,
      compileConflicts,
      rankedObjects: reranked.ranked,
    }));
    const certifiedCandidateFits = buildCertifiedCandidateFitDiagnostics({
      request,
      objects,
      questionPlan,
      routeDecision,
    });

    // Approved scoped correction hints — folded in AFTER certified routing so
    // they never override a certified answer. On the `certified` route we still
    // surface in-scope hints as advisory context, but never to change the route.
    const questionScope = deriveQuestionScope(
      request,
      questionPlan,
      objects,
      routeDecision,
      allowedSqlContext,
    );
    const hintResult = await retrieveScopedHints(projectRoot, {
      questionScope,
      limit: 6,
      currentSnapshotId: catalog.state('fingerprint'),
      currentDependencies: currentHintDependencyFingerprints({
        objects,
        relations: allowedSqlContext.relations,
      }),
    }).catch(() => ({ applied: [], conflicts: [], excluded: [] }));

    const knowledgeLens = buildKnowledgeLens(catalog, effectiveDomainContext, selectedSkills);
    // CTX-001 allows an inferred domain when the evidence is unambiguous. The
    // briefing previously required an explicitly pinned one, so the glossary,
    // intent examples, required filters, and caveats were silently absent from
    // every ordinary un-pinned Ask. Infer only from an unambiguous single
    // domain across the retrieved objects; ambiguity still yields no briefing,
    // and this grants no imports or joins.
    const domainBriefing = buildDomainBriefing(catalog, effectiveDomainContext)
      ?? buildDomainBriefing(catalog, inferredDomainContextForBriefing(effectiveDomainContext, objects));

    // CTX-010: complete admission before ranking. The envelope decides who is
    // eligible; the lanes above only decided who came first.
    const eligible: EligibleContextSet | undefined = request.admission === 'complete_eligible' ? (() => {
      const domains = domainContextSearchDomains(effectiveDomainContext);
      const eligibleObjects = catalog.listEligibleObjects({ objectTypes: ELIGIBLE_CONTEXT_OBJECT_TYPES, domains, payloadTypes: ELIGIBLE_PAYLOAD_TYPES });
      const counts: Record<string, number> = {};
      for (const object of eligibleObjects) counts[object.objectType] = (counts[object.objectType] ?? 0) + 1;
      const fingerprint = createHash('sha256').update(`${catalog.state('fingerprint') ?? ''}|${domains.join(',')}|${eligibleObjects.map((object) => object.objectKey).join('\n')}`).digest('hex').slice(0, 24);
      return { objects: eligibleObjects, counts, domains, fingerprint: `sha256:${fingerprint}` };
    })() : undefined;
    const payload: LocalContextPack = {
      id: '',
      question: request.question,
      followUp: followUp ?? undefined,
      focusObjectKey,
      mode,
      questionPlan,
      trustLabel,
      trustLabelInfo: metadataTrustLabelInfo(trustLabel),
      objects,
      skills: selectedSkills.map((item) => item.skill),
      knowledgeLens,
      ...(domainBriefing ? { domainBriefing } : {}),
      edges: contextEdges,
      queryRuns,
      citations,
      evidenceSummaries,
      warnings,
      routeDecision,
      evidenceRoles,
      allowedSqlContext,
      missingContext: routeDecision.missingContext,
      conflicts,
      appliedHints: hintResult.applied,
      ...(eligible ? { eligible } : {}),
      hintConflicts: hintResult.conflicts,
      hintExclusions: hintResult.excluded,
      retrievalDiagnostics: {
        strategy: usedFullCatalog ? 'full_catalog' : 'sqlite_fts',
        lanes: snapshotRetrieval.lanes,
        ...(snapshotRetrieval.fusion ? {
          fusion: {
            ...snapshotRetrieval.fusion,
            ...(graphError ? {
              lanes: {
                ...(snapshotRetrieval.fusion.lanes ?? {}),
                graph: {
                  ...(snapshotRetrieval.fusion.lanes?.graph ?? { returned: 0 }),
                  status: 'error' as const,
                  error: graphError,
                },
              },
            } : {}),
          },
        } : graphError ? {
          fusion: {
            selectedKeys: selected.map((object) => object.objectKey),
            truncated: false,
            lanes: {
              graph: { returned: 0, status: 'error' as const, error: graphError },
            },
          },
        } : {}),
        focusedModelAreaId: focusedArea?.id,
        modelAreaSource: focusedArea?.source,
        selectedObjects: objects.length,
        selectedEvidence: reranked.ranked.slice(0, 20).map((item) => ({
          objectKey: item.row.objectKey,
          objectType: item.row.objectType,
          name: item.row.name,
          reason: item.reason,
          rank: item.rank,
          score: item.score,
          priorityTier: item.priorityTier,
        })),
        selectedRelations,
        selectedJoinPaths,
        schemaShapeCandidates: schemaShapeCandidates.slice(0, 16).map((candidate) => ({
          objectKey: candidate.object.objectKey,
          relation: candidate.relation.relation,
          score: candidate.score,
          reason: candidate.reasons.join('; '),
          columns: candidate.relation.columns.slice(0, 16).map((column) => column.name),
        })),
        topRejected: reranked.rejected,
        certifiedCandidateFits,
        candidateConflicts: conflicts,
        meaningEvidence,
      },
      freshness: {
        catalogPath: snapshotPath,
        builtAt: catalog.state('built_at'),
        fingerprint: catalog.state('fingerprint'),
        ...(request.runtimeSchemaSnapshot?.connectionId
          ? { runtimeSchemaConnectionId: request.runtimeSchemaSnapshot.connectionId }
          : {}),
        ...(request.runtimeSchemaSnapshot?.scopeFingerprint
          ? { runtimeSchemaScopeFingerprint: request.runtimeSchemaSnapshot.scopeFingerprint }
          : {}),
        ...(request.runtimeSchemaSnapshot?.generationId
          ? { runtimeSchemaGenerationId: request.runtimeSchemaSnapshot.generationId }
          : {}),
        ...(request.runtimeSchemaSnapshot?.capturedAt
          ? { runtimeSchemaCapturedAt: request.runtimeSchemaSnapshot.capturedAt }
          : {}),
      },
    };
    const packPayload = { ...payload };
    delete (packPayload as Partial<LocalContextPack>).id;
    // The eligible set is a request-time view, not history: it can be tens of
    // thousands of rows on a large project and is rebuilt from the snapshot.
    delete (packPayload as Partial<LocalContextPack>).eligible;
    const id = runtimeCatalog.insertContextPack(packPayload);
    return { ...payload, id };
  } finally {
    snapshotLease.release();
    runtimeCatalog.close();
  }
}

/** A pinned domain's authored context, resolved from capsule refs into text. */
export interface DomainBriefing {
  domainId: string;
  name: string;
  description?: string;
  modelArea?: string;
  purpose?: string;
  intentExamples: string[];
  terms: Array<{ name: string; description?: string; synonyms: string[] }>;
  caveats: string[];
  requiredFilters: string[];
}

/**
 * Resolve the pinned domain's capsule into the text the model can actually read.
 *
 * Bounded at every list: a large domain must degrade gracefully rather than
 * crowd relation cards out of the prompt.
 */
/**
 * Derive a low-confidence, briefing-only domain context when the caller pinned
 * none. Returns `undefined` unless the retrieved objects agree on exactly one
 * domain, so an ambiguous question keeps its whole-project view.
 *
 * The envelope is deliberately marked `inferred`/`low` and carries no
 * `allowedImports`: it may supply reading context, never authorization.
 */
function inferredDomainContextForBriefing(
  context: DomainContextEnvelope | undefined,
  objects: MetadataObject[],
): DomainContextEnvelope | undefined {
  if (context?.activeDomain) return undefined;
  const domains = new Set(objects.map((object) => object.domain).filter((domain): domain is string => Boolean(domain) && domain !== 'uncategorized'));
  if (domains.size !== 1) return undefined;
  return {
    activeDomain: [...domains][0]!,
    ancestors: [],
    descendants: [],
    allowedImports: [],
    source: 'inferred',
    confidence: 'low',
    snapshotId: context?.snapshotId ?? '',
  };
}

function buildDomainBriefing(
  catalog: MetadataCatalog,
  context: DomainContextEnvelope | undefined,
): DomainBriefing | undefined {
  const activeDomainId = context?.activeDomain;
  if (!activeDomainId) return undefined;
  const capsules = catalog.listAllObjects({ objectTypes: ['domain_capsule'] })
    .filter((object) => object.domain === activeDomainId);
  // A focused Model Area has its own capsule; prefer it so pinning a sub-area
  // narrows the briefing rather than restating the whole domain.
  const capsule = (context.modelAreaId
    ? capsules.find((object) => stringValue(object.payload?.modelAreaId) === context.modelAreaId)
    : undefined)
    ?? capsules.find((object) => !stringValue(object.payload?.modelAreaId))
    ?? capsules[0];
  if (!capsule) return undefined;

  const payload = (capsule.payload ?? {}) as Record<string, unknown>;
  const list = (value: unknown, limit: number): string[] =>
    (Array.isArray(value) ? value : []).map((item) => stringValue(item)).filter((item): item is string => Boolean(item)).slice(0, limit);

  const termRefs = list(payload.termRefs, 24);
  const terms = termRefs.flatMap((ref) => {
    const leaf = ref.split('::').pop() ?? ref;
    // Capsule refs are qualified (`<domain>::term::<name>`) while a term object
    // is keyed by bare name, so try the leaf segment before falling back to
    // identity resolution.
    const object = catalog.getObject(`dql:term:${ref}`)
      ?? catalog.getObject(`dql:term:${leaf}`)
      ?? catalog.findObjectByIdentity(leaf);
    if (!object || object.objectType !== 'dql_term') return [];
    return [{
      name: object.name,
      description: object.description,
      synonyms: list((object.payload as Record<string, unknown> | undefined)?.synonyms, 8),
    }];
  }).slice(0, 16);

  return {
    domainId: activeDomainId,
    name: capsule.name || activeDomainId,
    description: capsule.description,
    modelArea: context.modelAreaId,
    purpose: context.purpose,
    intentExamples: list(payload.intentExamples, 6),
    terms,
    caveats: list(payload.caveats, 6),
    requiredFilters: list(payload.requiredFilters, 8),
  };
}

function buildKnowledgeLens(
  catalog: MetadataCatalog,
  context: DomainContextEnvelope | undefined,
  selectedSkills: Array<{ object: MetadataObject; skill: LocalContextSkill }>,
): KnowledgeLens {
  const activeDomainId = context?.activeDomain ?? undefined;
  const capsule = activeDomainId
    ? catalog.listAllObjects({ objectTypes: ['domain_capsule'] })
      .find((object) => object.domain === activeDomainId && !stringValue(object.payload?.modelAreaId))
    : undefined;
  const skillRefs = selectedSkills
    .map(({ skill }) => skill.qualifiedId ?? skill.id)
    .sort();
  const skillFingerprints = Object.fromEntries(selectedSkills.flatMap(({ object, skill }) => {
    const fingerprint = stringValue(object.payload?.sourceFingerprint);
    return fingerprint ? [[skill.qualifiedId ?? skill.id, fingerprint]] : [];
  }));
  return {
    mode: context?.source === 'explicit_api' || context?.source === 'explicit_ui' ? 'pinned' : 'auto',
    activeDomainId,
    modelAreaId: context?.modelAreaId,
    purpose: context?.purpose,
    skillRefs,
    // The immutable search snapshot is authoritative. A caller-provided
    // envelope may have been resolved against an earlier manifest signature;
    // it cannot relabel the catalog that actually supplied evidence.
    snapshotId: catalog.state('fingerprint') ?? 'metadata-unavailable',
    capsuleFingerprint: stringValue(capsule?.payload?.fingerprint)
      ?? stringValue(capsule?.payload?.sourceFingerprint),
    skillFingerprints: Object.keys(skillFingerprints).length > 0 ? skillFingerprints : undefined,
  };
}

export async function planAgentAnswer(
  projectRoot: string,
  request: BuildLocalContextPackRequest,
): Promise<PlanAgentAnswerResult> {
  const contextPack = await buildLocalContextPack(projectRoot, request);
  return {
    contextPackId: contextPack.id,
    contextPack,
    routeDecision: contextPack.routeDecision,
    evidenceRoles: contextPack.evidenceRoles,
    allowedSqlContext: contextPack.allowedSqlContext,
    missingContext: contextPack.missingContext,
    warnings: contextPack.warnings,
    freshness: contextPack.freshness,
  };
}

export function recordQueryRun(projectRoot: string, run: Omit<QueryRunSummary, 'id'> & { id?: string }): QueryRunSummary {
  const catalog = openMetadataCatalog(projectRoot);
  try {
    return catalog.recordQueryRun(run);
  } finally {
    catalog.close();
  }
}

export function recordRuntimeSchemaSnapshot(projectRoot: string, snapshot: RuntimeSchemaSnapshot): RuntimeSchemaSnapshot {
  const catalog = openMetadataCatalog(projectRoot);
  try {
    return catalog.recordRuntimeSchemaSnapshot(snapshot);
  } finally {
    catalog.close();
  }
}

/**
 * The most-recent stored live-warehouse schema snapshot for a project.
 *
 * When a connection id is supplied, never fall back to a snapshot captured for
 * another connection. Ask may target a different warehouse connection than the
 * project default, so a project-global "latest" snapshot is not safe evidence
 * for planning or semantic table resolution.
 */
export function latestRuntimeSchemaSnapshotForProject(
  projectRoot: string,
  connectionId?: string,
): RuntimeSchemaSnapshot | null {
  const catalog = openMetadataCatalog(projectRoot);
  try {
    return catalog.latestRuntimeSchemaSnapshot(connectionId);
  } finally {
    catalog.close();
  }
}

/** The two graphs a snapshot is built from; a reindex that already built them passes them in (built once, not twice). */
export interface MetadataSnapshotGraphs {
  manifestGraph: ReturnType<typeof buildKGFromManifest>;
  semanticGraph: ReturnType<typeof buildKGFromSemanticLayer>;
}

export function buildMetadataSnapshot(
  projectRoot: string,
  manifest: DQLManifest,
  semanticLayer?: SemanticLayer,
  skills: Skill[] = loadSkills(projectRoot).skills,
  graphs?: MetadataSnapshotGraphs,
): MetadataSnapshot {
  const manifestGraph = graphs?.manifestGraph ?? buildKGFromManifest(manifest);
  const semanticGraph = graphs?.semanticGraph ?? buildKGFromSemanticLayer(semanticLayer, declaredDomainIds(manifest));
  const objects = new Map<string, MetadataObject>();
  const edges = new Map<string, MetadataEdge>();
  const diagnostics: MetadataDiagnostic[] = [
    ...(manifest.diagnostics ?? []).map(manifestDiagnosticToMetadataDiagnostic),
  ];

  for (const node of [...manifestGraph.nodes, ...semanticGraph.nodes]) {
    const object = objectFromKGNode(node);
    const existing = objects.get(object.objectKey);
    if (existing) {
      diagnostics.push({
        kind: 'metadata',
        severity: 'warning',
        objectKey: object.objectKey,
        message: `duplicate metadata object key "${object.objectKey}" from ${existing.sourcePath ?? existing.sourceSystem ?? 'unknown'} and ${object.sourcePath ?? object.sourceSystem ?? 'unknown'}`,
      });
      objects.set(object.objectKey, mergeObject(existing, object));
    } else {
      objects.set(object.objectKey, object);
    }
  }

  addManifestBlockDetails(manifest, objects);
  addManifestBlockSourceObjects(projectRoot, manifest, objects);
  addSemanticMetricDatasetSourceObjects(semanticLayer, objects);
  addManifestKnowledgeGraph(materializeIndexedKnowledgeGraph(projectRoot, manifest), objects, edges);
  addSkillObjects(skills, objects, edges);
  addDbtDagObjects(manifest, objects, edges, diagnostics);
  addRawDbtManifestCatalogObjects(projectRoot, manifest, objects, edges, diagnostics);
  addBlockDependencyEdges(manifest, edges);
  addBlockOutputLineageObjects(manifest, objects, edges);
  addCertifiedBlockAnalyticalCapabilities(objects);
  // Manifest v3 is the unified ZLens runtime. DataLex is migration input only;
  // retaining it here would reintroduce a second analytical source of truth.
  if (manifest.manifestVersion !== 3) {
    addDataLexManifestObjects(projectRoot, manifest, objects, edges, diagnostics);
  }

  const nodeKeyMap = new Map<string, string>();
  for (const node of [...manifestGraph.nodes, ...semanticGraph.nodes]) {
    nodeKeyMap.set(node.nodeId, objectKeyFromKGNode(node));
  }
  for (const edge of [...manifestGraph.edges, ...semanticGraph.edges]) {
    const fromKey = nodeKeyMap.get(edge.src) ?? edge.src;
    const toKey = nodeKeyMap.get(edge.dst) ?? edge.dst;
    const normalized = normalizeEdge(edge, fromKey, toKey);
    const key = `${normalized.edgeType}\u0000${normalized.fromKey}\u0000${normalized.toKey}`;
    if (!edges.has(key)) edges.set(key, normalized);
  }

  addProjectDiagnostics(manifest, semanticLayer, diagnostics);

  const compileConflicts = (manifest.diagnostics ?? [])
    .filter((diagnostic): diagnostic is ManifestDiagnostic & { conflict: ManifestConflictDetail } =>
      diagnostic.kind === 'conflict' && Boolean(diagnostic.conflict))
    .map((diagnostic) => diagnostic.conflict);

  const snapshot = {
    projectRoot,
    manifest,
    objects: Array.from(objects.values()).sort((a, b) => a.objectKey.localeCompare(b.objectKey)),
    edges: Array.from(edges.values()).sort((a, b) => `${a.edgeType}|${a.fromKey}|${a.toKey}`.localeCompare(`${b.edgeType}|${b.fromKey}|${b.toKey}`)),
    // Diagnostics are stored under a content-hash PRIMARY KEY, so two
    // byte-identical entries (e.g. the duplicate-object-key warning emitted for
    // a key that collides three or more times with the same source labels)
    // would crash the rebuild INSERT with SQLITE_CONSTRAINT_PRIMARYKEY.
    // Identical diagnostics carry no extra signal — keep exactly one of each.
    diagnostics: [...new Map(diagnostics.map((diagnostic) => [diagnosticId(diagnostic), diagnostic])).values()],
    compileConflicts,
    skillBodies: [...new Map(skills.map((skill) => {
      const bodyHash = sha256(skill.body);
      return [bodyHash, { bodyHash, body: skill.body }] as const;
    })).values()].sort((a, b) => a.bodyHash.localeCompare(b.bodyHash)),
    generatedAt: new Date().toISOString(),
    fingerprint: '',
  };
  snapshot.fingerprint = fingerprintSnapshot(snapshot);
  return snapshot;
}

/**
 * Upgrade only fully declared certified blocks into RFC 0005 capabilities.
 * Local/display-name matching is intentionally insufficient: every reusable
 * metric, grain, dimension/filter, and output role must bind exactly to the
 * already-normalized semantic capability in this immutable snapshot.
 *
 * Acceptance: CONTRACT-002, AGT-018.
 */
function addCertifiedBlockAnalyticalCapabilities(
  objects: Map<string, MetadataObject>,
): void {
  // Existing certified blocks can carry the pre-ID-001 domain-scoped member
  // identities. Canonicalize those aliases only when exactly one semantic
  // object owns them; repeated leaf aliases intentionally fail closed.
  const semanticIdentityTargets = new Map<string, Set<string>>();
  for (const object of objects.values()) {
    if (!object.objectType.startsWith('semantic_')) continue;
    const payload = object.payload ?? {};
    const canonicalIdentity = object.fullName ?? object.name;
    for (const identity of uniqueNonBlank([
      canonicalIdentity,
      stringValue(payload.qualifiedId),
      stringValue(payload.registryQualifiedId),
      stringValue(payload.sourceNativeId),
      ...metadataStringArray(payload.aliases),
    ])) {
      const targets = semanticIdentityTargets.get(identity) ?? new Set<string>();
      targets.add(canonicalIdentity);
      semanticIdentityTargets.set(identity, targets);
    }
  }
  const canonicalizeSemanticRef = (identity: string): string | undefined => {
    const targets = semanticIdentityTargets.get(identity);
    if (!targets) return identity;
    return targets.size === 1 ? [...targets][0] : undefined;
  };

  const semanticCapabilities = [...objects.values()].flatMap((object) => {
    if (object.objectType !== "semantic_metric") return [];
    const capability = normalizeMetricCapabilityContract(
      object.payload?.analyticalCapability,
    );
    if (!capability) return [];
    const payload = object.payload ?? {};
    return [
      {
        object,
        capability,
        exactRefs: new Set(
          uniqueNonBlank([
            capability.metricId,
            object.objectKey,
            object.fullName,
            stringValue(payload.qualifiedId),
            stringValue(payload.sourceNativeId),
            ...metadataStringArray(payload.aliases),
          ]),
        ),
      },
    ];
  });
  for (const block of objects.values()) {
    if (block.objectType !== "dql_block" || block.status !== "certified")
      continue;
    const payload = block.payload ?? {};
    const metricRefs = uniqueNonBlank([
      ...metadataStringArray(payload.metricRefs),
    ]);
    if (metricRefs.length !== 1) continue;
    const metrics = semanticCapabilities.filter((candidate) =>
      candidate.exactRefs.has(metricRefs[0]!),
    );
    if (metrics.length !== 1) continue;
    const semantic = metrics[0]!;
    const authoredGrain = stringValue(payload.grain);
    const grain = authoredGrain ? canonicalizeSemanticRef(authoredGrain) : undefined;
    if (!grain || !semantic.capability.resultGrainIds.includes(grain)) continue;

    const authoredGroupedRefs = uniqueNonBlank([
      ...metadataStringArray(payload.dimensions),
      ...metadataStringArray(payload.dimensionsRef),
    ]);
    const authoredFilterRefs = uniqueNonBlank(
      metadataStringArray(payload.allowedFilters),
    );
    const groupedRefs = authoredGroupedRefs.map(canonicalizeSemanticRef);
    const filterRefs = authoredFilterRefs.map(canonicalizeSemanticRef);
    if (groupedRefs.some((ref) => !ref) || filterRefs.some((ref) => !ref)) continue;
    const canonicalGroupedRefs = groupedRefs.filter((ref): ref is string => Boolean(ref));
    const canonicalFilterRefs = filterRefs.filter((ref): ref is string => Boolean(ref));
    const declaredRefs = new Set([...canonicalGroupedRefs, ...canonicalFilterRefs]);
    const capabilityDimensionIds = new Set(
      semantic.capability.dimensions.map((item) => item.dimensionId),
    );
    const capabilityTimeIds = new Set(
      semantic.capability.timeDimensions.map((item) => item.dimensionId),
    );
    if (
      [...declaredRefs].some(
        (id) => !capabilityDimensionIds.has(id) && !capabilityTimeIds.has(id),
      )
    )
      continue;

    const dimensions: MetricCapabilityContract["dimensions"] =
      semantic.capability.dimensions.flatMap((dimension) => {
        if (!declaredRefs.has(dimension.dimensionId)) return [];
        const roles = dimension.supportedRoles.filter(
          (role) =>
            (role === "filter" && canonicalFilterRefs.includes(dimension.dimensionId)) ||
            (role === "group_by" &&
              canonicalGroupedRefs.includes(dimension.dimensionId)) ||
            (role === "display" &&
              canonicalGroupedRefs.includes(dimension.dimensionId)) ||
            (role === "rank_entity" &&
              payload.pattern === "ranking" &&
              canonicalGroupedRefs.includes(dimension.dimensionId)),
        );
        return roles.length > 0
          ? [{ ...dimension, supportedRoles: roles }]
          : [];
      });
    if (
      [...declaredRefs].some(
        (id) =>
          capabilityDimensionIds.has(id) &&
          !dimensions.some((dimension) => dimension.dimensionId === id),
      )
    )
      continue;

    const timeDimensions = semantic.capability.timeDimensions.filter(
      (dimension) => declaredRefs.has(dimension.dimensionId),
    );
    const outputs = analyticalBlockOutputs(payload.outputContract);
    if (
      !outputs ||
      outputs.ids.length === 0 ||
      !outputs.kinds.includes("metric_value")
    )
      continue;
    const operations: MetricCapabilityContract["operations"] = [];
    if (canonicalFilterRefs.length > 0) operations.push("filter");
    if (canonicalGroupedRefs.some((id) => capabilityDimensionIds.has(id)))
      operations.push("group");
    if (payload.pattern === "trend") operations.push("trend");
    if (payload.pattern === "ranking" && outputs.kinds.includes("rank"))
      operations.push("rank");
    if (
      outputs.kinds.includes("delta") ||
      outputs.kinds.includes("percent_delta")
    )
      operations.push("compare");
    const blockId = stringValue(payload.qualifiedId) ?? block.objectKey;
    const fingerprint =
      stringValue(recordPayload(payload.businessFingerprint)?.hash) ??
      sha256(
        stableStringify({
          blockId,
          metricRefs,
          grain,
          groupedRefs: canonicalGroupedRefs,
          filterRefs: canonicalFilterRefs,
          outputs,
        }),
      );
    const capability: MetricCapabilityContract = {
      ...semantic.capability,
      defaultResultGrainId: grain,
      resultGrainIds: uniqueNonBlank([
        grain,
        ...dimensions.map((dimension) => dimension.entityId),
      ]),
      dimensions,
      timeDimensions,
      operations: [...new Set(operations)],
      supportedOutputKinds: outputs.kinds,
      declaredOutputIds: outputs.ids,
      executionCapabilities: [
        { route: "certified", adapterId: block.objectKey },
      ],
      sourceFingerprint: fingerprint.startsWith("sha256:")
        ? fingerprint
        : `sha256:${fingerprint}`,
    };
    const normalized = normalizeMetricCapabilityContract(capability);
    if (!normalized) continue;
    objects.set(block.objectKey, {
      ...block,
      payload: { ...payload, analyticalCapability: normalized },
    });
  }
}

function analyticalBlockOutputs(value: unknown):
  | {
      ids: string[];
      kinds: MetricCapabilityContract["supportedOutputKinds"];
    }
  | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const ids: string[] = [];
  const kinds: MetricCapabilityContract["supportedOutputKinds"] = [];
  for (const item of value) {
    const output = recordPayload(item);
    const id = stringValue(output?.name);
    const role = stringValue(output?.role)?.toLowerCase();
    if (!id || !role) return undefined;
    const kind:
      | MetricCapabilityContract["supportedOutputKinds"][number]
      | undefined =
      role === "metric" || role === "measure" || role === "value"
        ? "metric_value"
        : role === "dimension" || role === "grain"
          ? "dimension"
          : role === "rank"
            ? "rank"
            : role === "delta"
              ? "delta"
              : role === "percent_delta"
                ? "percent_delta"
                : undefined;
    if (!kind) return undefined;
    ids.push(id);
    kinds.push(kind);
  }
  return { ids: uniqueNonBlank(ids), kinds: [...new Set(kinds)] };
}

function recordPayload(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Manifest graph v2 intentionally omits verbose objects and edges. Snapshot
 * construction rematerializes that compiler graph once, then persists the
 * detail in immutable SQLite. Normal Ask/API reads never repeat this work.
 */
function materializeIndexedKnowledgeGraph(projectRoot: string, manifest: DQLManifest): DQLManifest {
  const compact = manifest.knowledgeGraph;
  if (!compact || compact.storageMode !== 'indexed') return manifest;
  const { knowledgeGraph: _compactGraph, ...baseManifest } = manifest;
  const registry = loadDomainPackageRegistry(projectRoot);
  const skillCatalog = loadManifestKnowledgeSkills(projectRoot, registry);
  const inline = buildManifestKnowledgeGraph({ manifest: baseManifest, skills: skillCatalog.skills });
  const objects = { ...(inline.objects ?? {}) };
  for (const ref of compact.objectRefs ?? []) {
    objects[ref.id] ??= { ...ref };
  }
  return {
    ...manifest,
    knowledgeGraph: {
      ...inline,
      sourceFingerprint: compact.sourceFingerprint,
      objects,
      domainCapsules: compact.domainCapsules,
      crossDomainRoutes: compact.crossDomainRoutes,
      diagnostics: compact.diagnostics,
    },
  };
}

/**
 * CTX-006: project search is a projection of the compiler-owned qualified
 * policy graph. Legacy KG records are enriched in place so existing route keys
 * remain compatible while identity, capsules, and governed route state come
 * from one source.
 */
function addManifestKnowledgeGraph(
  manifest: DQLManifest,
  objects: Map<string, MetadataObject>,
  edges: Map<string, MetadataEdge>,
): void {
  const graph = manifest.knowledgeGraph;
  if (!graph) return;
  const keyByGraphId = new Map<string, string>();
  const graphObjects = Object.values(graph.objects ?? {});
  const indexedObjects = graphObjects.length > 0 ? graphObjects : (graph.objectRefs ?? []);
  for (const item of indexedObjects) {
    const itemPayload = ('payload' in item ? item.payload : undefined) as Record<string, unknown> | undefined;
    const itemAliases = ('aliases' in item ? item.aliases : undefined) as string[] | undefined;
    const displayName = knowledgeDisplayName(item.kind, item.localId, itemPayload);
    // A term's legacy key follows the manifest's key for THAT term: the first
    // "Revenue" is `dql:term:Revenue`, a same-named term of another domain is
    // `dql:term:<domain>::Revenue` — so two domains' definitions enrich two
    // objects instead of the second overwriting the first's domain.
    const objectKey = item.kind === 'term'
      ? `dql:term:${termManifestKey(manifest, displayName, item.domainId) ?? displayName}`
      : knowledgeMetadataKey(item.kind, displayName, item.id, item.source.system);
    keyByGraphId.set(item.id, objectKey);
    // The registry emits an UNRESOLVED ALIAS beside the entity-qualified node
    // for the same semantic member: `semantic::metric.jaffle_shop.revenue`
    // (note the empty entity segment) beside `semantic:order_item:revenue`.
    // The alias carries no aggregation, grain, or prose — its description is
    // the raw dbt unique_id — so it can never be proven compatible, yet it
    // competes for bounded retrieval and clarification slots with the node that
    // can. 18 of 37 metrics in the commerce fixture were these.
    //
    // Skipping it is a no-op for meaning: it holds nothing the qualified node
    // does not. The graph-id mapping above is still recorded so edges keep
    // resolving. Anything carrying real payload is indexed as before.
    if (isUnresolvedSemanticAlias(item.kind, item.id, itemPayload)) continue;
    const description = stringValue(itemPayload?.description)
      ?? stringValue(itemPayload?.businessContext)
      ?? itemAliases?.find((alias) => alias !== item.localId);
    const compiled: MetadataObject = {
      objectKey,
      objectType: knowledgeMetadataType(item.kind),
      name: displayName,
      fullName: item.id,
      domain: item.domainId,
      owner: item.owner,
      status: item.status,
      description,
      sourcePath: item.source.path,
      sourceSystem: `DQL canonical knowledge graph (${item.source.system})`,
      payload: compactObject({
        ...(itemPayload ?? {}),
        qualifiedId: item.id,
        aliases: itemAliases ?? [],
        modelAreaIds: item.modelAreaIds ?? [],
        sourceFingerprint: item.source.fingerprint,
        sourceNativeId: item.source.nativeId,
        knowledgeGraphSchemaVersion: graph.schemaVersion,
      }),
    };
    const existing = objects.get(objectKey);
    objects.set(objectKey, existing ? mergeObject(existing, compiled) : compiled);
  }

  for (const capsule of Object.values(graph.domainCapsules)) {
    const objectKey = `dql:domain_capsule:${capsule.id}`;
    objects.set(objectKey, {
      objectKey,
      objectType: 'domain_capsule',
      name: capsule.name,
      fullName: capsule.id,
      domain: capsule.domainId,
      description: capsule.description,
      sourceSystem: 'DQL compiled Domain Knowledge Capsule',
      payload: compactObject({ ...capsule, sourceFingerprint: graph.sourceFingerprint }),
    });
    addMetadataEdge(edges, 'contains', keyByGraphId.get(`domain::${capsule.domainId}`) ?? `domain:${capsule.domainId}`, objectKey, { source: 'knowledge_graph' });
    for (const skill of capsule.skillRefs) addMetadataEdge(edges, 'guided_by', objectKey, `skill:${skill}`, { source: 'knowledge_graph' });
  }

  for (const route of graph.crossDomainRoutes) {
    const objectKey = `dql:cross_domain_route:${route.id}`;
    objects.set(objectKey, {
      objectKey,
      objectType: 'cross_domain_route',
      name: `${route.providerDomainId} → ${route.consumerDomainId}`,
      fullName: route.id,
      domain: route.consumerDomainId,
      status: route.state,
      description: route.purpose ? `Approved purpose: ${route.purpose}` : 'Observed cross-domain dependency',
      sourceSystem: 'DQL compiled cross-domain policy',
      payload: compactObject(route as unknown as Record<string, unknown>),
    });
    addMetadataEdge(
      edges,
      "cross_domain_route",
      keyByGraphId.get(`domain::${route.providerDomainId}`) ??
        `domain:${route.providerDomainId}`,
      objectKey,
      {
        state: route.state,
        reasonCodes: route.reasonCodes,
      },
    );
    addMetadataEdge(
      edges,
      "cross_domain_route",
      objectKey,
      keyByGraphId.get(`domain::${route.consumerDomainId}`) ??
        `domain:${route.consumerDomainId}`,
      {
        state: route.state,
        reasonCodes: route.reasonCodes,
      },
    );
  }

  for (const edge of graph.edges ?? []) {
    const fromKey = keyByGraphId.get(edge.from) ?? edge.from;
    const toKey = keyByGraphId.get(edge.to) ?? edge.to;
    addMetadataEdge(edges, edge.kind, fromKey, toKey, {
      state: edge.state,
      domainPair: edge.domainPair,
      evidenceRefs: edge.evidenceRefs ?? [],
      reasonCodes: edge.reasonCodes ?? [],
      fingerprint: edge.fingerprint,
      source: 'knowledge_graph',
    });
  }
}

function addMetadataEdge(
  edges: Map<string, MetadataEdge>,
  edgeType: string,
  fromKey: string,
  toKey: string,
  payload: Record<string, unknown>,
): void {
  const key = `${edgeType}\u0000${fromKey}\u0000${toKey}`;
  if (!edges.has(key)) edges.set(key, { edgeType, fromKey, toKey, confidence: 1, payload: compactObject(payload) });
}

/**
 * True for the registry's payload-less alias of a semantic member.
 *
 * A qualified semantic identity is `semantic:<entity>:<member>`. When the
 * owning entity could not be resolved the registry still emits the node with an
 * EMPTY entity segment — `semantic::metric.jaffle_shop.revenue` — carrying only
 * the source's native id. Requiring an entity segment is the same
 * entity-qualified identity rule the semantic catalog is built on.
 *
 * Anything holding real meaning (an aggregation, a label, an expression, or
 * LLM context) is NOT an alias and is kept, even unqualified.
 */
function isUnresolvedSemanticAlias(
  kind: string,
  qualifiedId: string,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (!['metric', 'measure', 'dimension'].includes(kind)) return false;
  if (!/^semantic::/.test(qualifiedId)) return false;
  const record = payload ?? {};
  return !record.aggregation
    && !record.llmContext
    && !record.label
    && !record.expression
    && !record.formula
    && !record.dimensions
    && !record.entities;
}

/** The key under which the manifest holds a term of this name in this domain (`<name>`, or `<domain>::<name>` for a same-named term of another domain). */
function termManifestKey(manifest: DQLManifest, name: string, domainId: string | undefined): string | undefined {
  const entries = Object.entries(manifest.terms ?? {}).filter(([, term]) => term.name === name);
  if (entries.length <= 1) return entries[0]?.[0];
  return entries.find(([, term]) => (term.domain ?? undefined) === domainId)?.[0] ?? entries[0]?.[0];
}

function knowledgeMetadataKey(kind: string, localId: string, qualifiedId: string, sourceSystem: string): string {
  switch (kind) {
    case 'block': return `dql:block:${localId}`;
    case 'term': return `dql:term:${localId}`;
    case 'business_view': return `dql:business_view:${localId}`;
    case 'metric': return `semantic:metric:${localId}`;
    case 'dimension': return `semantic:dimension:${localId}`;
    case 'entity': return `dql:entity:${qualifiedId}`;
    case 'model_area': return `dql:model_area:${qualifiedId}`;
    case 'relationship': return `dql:relationship:${qualifiedId}`;
    case 'contract': return `dql:contract:${qualifiedId}`;
    case 'domain_export': return `dql:domain_export:${qualifiedId}`;
    case 'domain_import': return `dql:domain_import:${qualifiedId}`;
    case 'conformance': return `dql:conformance:${qualifiedId}`;
    case 'policy': return `dql:policy:${qualifiedId}`;
    case 'evaluation': return `dql:evaluation:${qualifiedId}`;
    case 'skill': return `skill:${qualifiedId}`;
    case 'domain': return `domain:${localId}`;
    case 'dbt_model': return `dbt:model:${localId}`;
    case 'dbt_source': return `dbt:source:${localId}`;
    case 'source_table': return `warehouse:table:${localId}`;
    case 'notebook': return `notebook:${localId}`;
    case 'dashboard': return `dashboard:${localId}`;
    case 'app': return `app:${localId}`;
    default: return `${sourceSystem}:${kind}:${qualifiedId}`;
  }
}

function knowledgeDisplayName(kind: string, localId: string, payload: Record<string, unknown> | undefined): string {
  if (kind === 'domain' || kind === 'app') return stringValue(payload?.name) ?? localId;
  if (kind === 'dashboard' || kind === 'notebook') return stringValue(payload?.title) ?? localId;
  return localId;
}

function knowledgeMetadataType(kind: string): string {
  switch (kind) {
    case 'block': return 'dql_block';
    case 'term': return 'dql_term';
    case 'metric': return 'semantic_metric';
    case 'dimension': return 'semantic_dimension';
    case 'entity': return 'dql_entity';
    case 'model_area': return 'model_area';
    case 'dbt_model': return 'dbt_model';
    case 'dbt_source': return 'dbt_source';
    case 'source_table': return 'warehouse_table';
    default: return kind;
  }
}

function metadataKnowledgeKind(objectType: string): ManifestKnowledgeObjectKind {
  switch (objectType) {
    case 'dql_block': return 'block';
    case 'dql_term': return 'term';
    case 'business_view': return 'business_view';
    case 'semantic_metric': return 'metric';
    case 'semantic_dimension': return 'dimension';
    case 'semantic_model': return 'semantic_model';
    case 'dql_entity': return 'entity';
    case 'model_area': return 'model_area';
    case 'dbt_model': return 'dbt_model';
    case 'dbt_source': return 'dbt_source';
    case 'warehouse_table': return 'source_table';
    case 'domain_capsule': return 'domain';
    default: return objectType as ManifestKnowledgeObjectKind;
  }
}

function metadataObjectToKnowledge(item: MetadataObject): ManifestKnowledgeObject {
  const payload = item.payload ?? {};
  const id = stringValue(payload.qualifiedId) ?? item.fullName ?? item.objectKey;
  const system = item.sourceSystem?.toLowerCase().includes('dbt')
    ? 'dbt'
    : item.sourceSystem?.toLowerCase().includes('semantic')
      ? 'semantic'
      : 'dql';
  return {
    id,
    kind: metadataKnowledgeKind(item.objectType),
    localId: item.name,
    domainId: item.domain,
    modelAreaIds: metadataStringArray(payload.modelAreaIds),
    aliases: metadataStringArray(payload.aliases),
    status: item.status,
    owner: item.owner,
    source: {
      system,
      path: item.sourcePath,
      nativeId: stringValue(payload.sourceNativeId),
      fingerprint: stringValue(payload.sourceFingerprint) ?? sha256(stableStringify({ id, sourcePath: item.sourcePath, payload })),
    },
    payload,
  };
}

function metadataEdgeToKnowledge(edge: MetadataEdge, byKey: Map<string, ManifestKnowledgeObject>): ManifestKnowledgeEdge {
  const payload = edge.payload ?? {};
  const from = byKey.get(edge.fromKey)?.id ?? edge.fromKey;
  const to = byKey.get(edge.toKey)?.id ?? edge.toKey;
  const fingerprint = stringValue(payload.fingerprint) ?? sha256(stableStringify({ kind: edge.edgeType, from, to, payload }));
  return {
    id: `edge::${fingerprint.slice(0, 20)}`,
    kind: edge.edgeType as ManifestKnowledgeEdge['kind'],
    from,
    to,
    state: payload.state as ManifestKnowledgeEdge['state'],
    domainPair: payload.domainPair as ManifestKnowledgeEdge['domainPair'],
    evidenceRefs: metadataStringArray(payload.evidenceRefs),
    reasonCodes: metadataStringArray(payload.reasonCodes),
    fingerprint,
  };
}

function metadataRoute(item: MetadataObject): ManifestCrossDomainRoute | null {
  const payload = item.payload ?? {};
  const providerDomainId = stringValue(payload.providerDomainId);
  const consumerDomainId = stringValue(payload.consumerDomainId);
  const relationshipId = stringValue(payload.relationshipId);
  const state = stringValue(payload.state);
  if (!providerDomainId || !consumerDomainId || !relationshipId || !state || !['observed', 'authorized', 'blocked', 'stale'].includes(state)) return null;
  return {
    id: stringValue(payload.id) ?? item.fullName ?? item.objectKey,
    providerDomainId,
    consumerDomainId,
    purpose: stringValue(payload.purpose) ?? '',
    relationshipId,
    exportId: stringValue(payload.exportId),
    importId: stringValue(payload.importId),
    contractId: stringValue(payload.contractId),
    state: state as ManifestCrossDomainRoute['state'],
    reasonCodes: metadataStringArray(payload.reasonCodes),
    path: metadataStringArray(payload.path),
    fingerprint: stringValue(payload.fingerprint) ?? sha256(stableStringify(payload)),
  };
}

/**
 * How many Ask context packs the metadata cache keeps. A pack (the question,
 * the vocabulary and evidence the answer was built from) serves a follow-up
 * and the run's trace, not history: without a bound, every question added
 * hundreds of kilobytes to `.dql/cache/metadata.sqlite` for good. Newest
 * first, the cache keeps packs younger than `days`, at most `max` of them,
 * and at most `bytes` of payload (the newest is always kept).
 * ZLENS_CONTEXT_PACK_DAYS, ZLENS_CONTEXT_PACK_MAX and ZLENS_CONTEXT_PACK_MAX_MB
 * change the defaults (7 days, 200 packs, 64 MB).
 */
export interface ContextPackRetention { days: number; max: number; bytes: number }

export const CONTEXT_PACK_RETENTION: Readonly<ContextPackRetention> = { days: 7, max: 200, bytes: 64 * 1024 * 1024 };

export function contextPackRetention(env: NodeJS.ProcessEnv = process.env): ContextPackRetention {
  const positive = (value: string | undefined, fallback: number) => {
    const parsed = Number(value?.trim());
    return value?.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    days: positive(readEnv('ZLENS_CONTEXT_PACK_DAYS', env), CONTEXT_PACK_RETENTION.days),
    max: Math.floor(positive(readEnv('ZLENS_CONTEXT_PACK_MAX', env), CONTEXT_PACK_RETENTION.max)),
    bytes: Math.floor(positive(readEnv('ZLENS_CONTEXT_PACK_MAX_MB', env), CONTEXT_PACK_RETENTION.bytes / (1024 * 1024)) * 1024 * 1024),
  };
}

/**
 * Pruning is housekeeping: after every 20 packs written to a cache file, or
 * the first written 30 s after the last prune, per process (the catalog is
 * opened per request, so it is not done on open). It reads only sizes and
 * dates, never a payload.
 */
const CONTEXT_PACK_PRUNE_EVERY = 20;
const CONTEXT_PACK_PRUNE_EVERY_MS = 30_000;
const contextPackPrunes = new Map<string, { at: number; inserts: number }>();

export class MetadataCatalog {
  private readonly db: Database.Database;

  constructor(private readonly dbPath: string, options: { readOnly?: boolean } = {}) {
    if (!options.readOnly) mkdirSync(dirname(dbPath), { recursive: true });
    const Database = loadDatabase();
    this.db = new Database(dbPath, options.readOnly ? { readonly: true, fileMustExist: true } : undefined);
    if (options.readOnly) {
      this.db.pragma('query_only = ON');
      return;
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  /** Drop context packs beyond the retention (see ContextPackRetention); returns how many went. */
  pruneContextPacks(retention: ContextPackRetention = contextPackRetention(), now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - retention.days * 86_400_000).toISOString();
    let removed = this.db.prepare(
      'DELETE FROM context_packs WHERE created_at < ? AND id <> (SELECT id FROM context_packs ORDER BY created_at DESC, rowid DESC LIMIT 1)',
    ).run(cutoff).changes;
    removed += this.db.prepare(
      'DELETE FROM context_packs WHERE id IN (SELECT id FROM context_packs ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)',
    ).run(Math.max(1, retention.max)).changes;
    removed += this.db.prepare(`
      DELETE FROM context_packs WHERE id IN (
        SELECT id FROM (
          SELECT id, size, SUM(size) OVER (ORDER BY created_at DESC, rowid DESC ROWS UNBOUNDED PRECEDING) AS running
            FROM (SELECT id, created_at, rowid, coalesce(payload_bytes, LENGTH(payload_json)) AS size FROM context_packs)
        ) WHERE running - size >= ?
      )
    `).run(retention.bytes).changes;
    return removed;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata_objects (
        object_key    TEXT PRIMARY KEY,
        object_type   TEXT NOT NULL,
        name          TEXT NOT NULL,
        full_name     TEXT,
        domain        TEXT,
        owner         TEXT,
        status        TEXT,
        description   TEXT,
        source_path   TEXT,
        source_system TEXT,
        payload_json  TEXT NOT NULL DEFAULT '{}',
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_objects_type ON metadata_objects(object_type);
      CREATE INDEX IF NOT EXISTS idx_metadata_objects_domain ON metadata_objects(domain);
      CREATE INDEX IF NOT EXISTS idx_metadata_objects_status ON metadata_objects(status);

      CREATE VIRTUAL TABLE IF NOT EXISTS metadata_fts USING fts5(
        object_key UNINDEXED,
        name,
        full_name,
        description,
        domain,
        owner,
        payload,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS metadata_vector_index (
        object_key    TEXT PRIMARY KEY,
        provider_id  TEXT NOT NULL,
        dimensions   INTEGER NOT NULL,
        vector       BLOB NOT NULL,
        text_hash    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_vector_provider ON metadata_vector_index(provider_id);

      CREATE TABLE IF NOT EXISTS metadata_edges (
        edge_type    TEXT NOT NULL,
        from_key     TEXT NOT NULL,
        to_key       TEXT NOT NULL,
        confidence   REAL NOT NULL DEFAULT 1.0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL,
        PRIMARY KEY (edge_type, from_key, to_key)
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_edges_from ON metadata_edges(from_key, edge_type);
      CREATE INDEX IF NOT EXISTS idx_metadata_edges_to ON metadata_edges(to_key, edge_type);

      CREATE TABLE IF NOT EXISTS context_packs (
        id               TEXT PRIMARY KEY,
        question         TEXT NOT NULL,
        focus_object_key TEXT,
        mode             TEXT NOT NULL,
        trust_label      TEXT NOT NULL,
        payload_json     TEXT NOT NULL DEFAULT '{}',
        created_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_packs_created ON context_packs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_context_packs_focus ON context_packs(focus_object_key);

      CREATE TABLE IF NOT EXISTS query_runs (
        id           TEXT PRIMARY KEY,
        object_key   TEXT,
        source       TEXT NOT NULL,
        status       TEXT NOT NULL,
        row_count    INTEGER,
        duration_ms  INTEGER,
        error_code   TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_query_runs_object ON query_runs(object_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_query_runs_created ON query_runs(created_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_schema_snapshots (
        id           TEXT PRIMARY KEY,
        source       TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        captured_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_schema_snapshots_captured ON runtime_schema_snapshots(captured_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_schema_objects (
        object_key    TEXT PRIMARY KEY,
        object_type   TEXT NOT NULL,
        name          TEXT NOT NULL,
        full_name     TEXT,
        domain        TEXT,
        owner         TEXT,
        status        TEXT,
        description   TEXT,
        source_path   TEXT,
        source_system TEXT,
        payload_json  TEXT NOT NULL DEFAULT '{}',
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_schema_objects_type ON runtime_schema_objects(object_type);

      CREATE VIRTUAL TABLE IF NOT EXISTS runtime_schema_fts USING fts5(
        object_key UNINDEXED,
        name,
        full_name,
        description,
        payload,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS runtime_value_index (
        value_key        TEXT PRIMARY KEY,
        relation         TEXT NOT NULL,
        schema_name      TEXT,
        table_name       TEXT,
        column_name      TEXT NOT NULL,
        column_type      TEXT,
        value            TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        source           TEXT,
        captured_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runtime_value_index_relation ON runtime_value_index(relation, column_name);
      CREATE INDEX IF NOT EXISTS idx_runtime_value_index_captured ON runtime_value_index(captured_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS runtime_value_fts USING fts5(
        value_key UNINDEXED,
        relation,
        column_name,
        value,
        normalized_value,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS metadata_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata_diagnostics (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        severity   TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
        message    TEXT NOT NULL,
        object_key TEXT,
        file_path  TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metadata_diagnostics_severity ON metadata_diagnostics(severity);

      CREATE TABLE IF NOT EXISTS metadata_source_fingerprints (
        source_path  TEXT PRIMARY KEY,
        fingerprint  TEXT NOT NULL,
        object_count INTEGER NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata_domain_shards (
        domain                TEXT PRIMARY KEY,
        object_count          INTEGER NOT NULL,
        block_count           INTEGER NOT NULL,
        certified_block_count INTEGER NOT NULL,
        semantic_metric_count INTEGER NOT NULL,
        dbt_object_count      INTEGER NOT NULL,
        updated_at            TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_bodies (
        body_hash       TEXT PRIMARY KEY,
        encoding        TEXT NOT NULL,
        compressed_body TEXT NOT NULL,
        original_length INTEGER NOT NULL
      );
    `);
    // Runtime values may be used transiently inside one governed Ask, but they
    // must never survive in the rebuildable metadata database. Clear legacy v2
    // rows on open so an upgrade removes old plaintext without a migration.
    this.db.prepare('DELETE FROM runtime_value_fts').run();
    this.db.prepare('DELETE FROM runtime_value_index').run();
    this.db.prepare(`
      INSERT OR REPLACE INTO metadata_state (key, value)
      VALUES ('runtime_value_index_count', '0')
    `).run();
    // Each context pack's size, so keeping them under a byte bound reads no payload (older caches: added here).
    const packColumns = this.db.prepare('PRAGMA table_info(context_packs)').all() as Array<{ name: string }>;
    if (!packColumns.some((column) => column.name === 'payload_bytes')) this.db.exec('ALTER TABLE context_packs ADD COLUMN payload_bytes INTEGER');
  }

  rebuild(snapshot: MetadataSnapshot): void {
    const now = new Date().toISOString();
    const insertObject = this.db.prepare(`
      INSERT INTO metadata_objects (
        object_key, object_type, name, full_name, domain, owner, status,
        description, source_path, source_system, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO metadata_fts (object_key, name, full_name, description, domain, owner, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVector = this.db.prepare(`
      INSERT INTO metadata_vector_index (object_key, provider_id, dimensions, vector, text_hash)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO metadata_edges (
        edge_type, from_key, to_key, confidence, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertDiagnostic = this.db.prepare(`
      INSERT OR IGNORE INTO metadata_diagnostics (
        id, kind, severity, message, object_key, file_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const setState = this.db.prepare(`
      INSERT OR REPLACE INTO metadata_state (key, value) VALUES (?, ?)
    `);
    const insertSourceFingerprint = this.db.prepare(`
      INSERT OR REPLACE INTO metadata_source_fingerprints (
        source_path, fingerprint, object_count, updated_at
      ) VALUES (?, ?, ?, ?)
    `);
    const insertDomainShard = this.db.prepare(`
      INSERT OR REPLACE INTO metadata_domain_shards (
        domain, object_count, block_count, certified_block_count,
        semantic_metric_count, dbt_object_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSkillBody = this.db.prepare(`
      INSERT OR REPLACE INTO skill_bodies (body_hash, encoding, compressed_body, original_length)
      VALUES (?, 'br', ?, ?)
    `);
    const sourceFingerprints = buildSourceFingerprints(snapshot.objects, now);
    const domainShards = buildDomainShards(snapshot.objects, now);

    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM metadata_edges').run();
      this.db.prepare('DELETE FROM metadata_fts').run();
      this.db.prepare('DELETE FROM metadata_vector_index').run();
      this.db.prepare('DELETE FROM metadata_objects').run();
      this.db.prepare('DELETE FROM metadata_diagnostics').run();
      this.db.prepare('DELETE FROM metadata_source_fingerprints').run();
      this.db.prepare('DELETE FROM metadata_domain_shards').run();
      this.db.prepare('DELETE FROM skill_bodies').run();

      for (const object of snapshot.objects) {
        const payload = object.payload ?? {};
        insertObject.run(
          object.objectKey,
          object.objectType,
          object.name,
          object.fullName ?? null,
          object.domain ?? null,
          object.owner ?? null,
          object.status ?? null,
          object.description ?? null,
          object.sourcePath ?? null,
          object.sourceSystem ?? null,
          JSON.stringify(payload),
          object.updatedAt ?? now,
        );
        insertFts.run(
          object.objectKey,
          object.name,
          object.fullName ?? '',
          object.description ?? '',
          object.domain ?? '',
          object.owner ?? '',
          searchableMetadataPayload(payload),
        );
        if (isVectorIndexObject(object)) {
          const vectorText = metadataVectorText(object);
          const vector = DEFAULT_VECTOR_PROVIDER.embedOne(vectorText);
          insertVector.run(
            object.objectKey,
            DEFAULT_VECTOR_PROVIDER.id,
            vector.length,
            encodeFloat32Vector(vector),
            sha256(vectorText),
          );
        }
      }

      for (const edge of snapshot.edges) {
        insertEdge.run(
          edge.edgeType,
          edge.fromKey,
          edge.toKey,
          edge.confidence ?? 1,
          JSON.stringify(edge.payload ?? {}),
          now,
        );
      }

      for (const diagnostic of snapshot.diagnostics) {
        insertDiagnostic.run(
          diagnosticId(diagnostic),
          diagnostic.kind,
          diagnostic.severity,
          diagnostic.message,
          diagnostic.objectKey ?? null,
          diagnostic.filePath ?? null,
          now,
        );
      }

      for (const item of sourceFingerprints) {
        insertSourceFingerprint.run(item.sourcePath, item.fingerprint, item.objectCount, item.updatedAt);
      }
      for (const item of domainShards) {
        insertDomainShard.run(
          item.domain,
          item.objectCount,
          item.blockCount,
          item.certifiedBlockCount,
          item.semanticMetricCount,
          item.dbtObjectCount,
          item.updatedAt,
        );
      }
      for (const item of snapshot.skillBodies ?? []) {
        insertSkillBody.run(
          item.bodyHash,
          brotliCompressSync(item.body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }).toString('base64'),
          Buffer.byteLength(item.body, 'utf8'),
        );
      }

      setState.run('built_at', now);
      setState.run('fingerprint', snapshot.fingerprint);
      setState.run('project_root', snapshot.projectRoot);
      setState.run('object_count', String(snapshot.objects.length));
      setState.run('edge_count', String(snapshot.edges.length));
      setState.run('source_fingerprint_count', String(sourceFingerprints.length));
      setState.run('domain_shard_count', String(domainShards.length));
      setState.run('diagnostics_json', JSON.stringify(snapshot.diagnostics));
      setState.run('compile_conflicts_json', JSON.stringify(snapshot.compileConflicts ?? []));
      setState.run('manifest_generated_at', snapshot.manifest.generatedAt);
      setState.run('index_version', METADATA_INDEX_VERSION);
      setState.run('vector_provider', DEFAULT_VECTOR_PROVIDER.id);
      setState.run('vector_dimensions', String(DEFAULT_VECTOR_PROVIDER.dimensions));
    });
    txn();
  }

  /**
   * Incremental reindex (W3.4). Only re-inserts objects + FTS rows for sources
   * whose per-source fingerprint changed (or vanished); unchanged sources' rows are
   * left in place (skipping the expensive FTS re-tokenization at scale). Edges,
   * diagnostics, domain shards, and sourceless objects are always rebuilt because
   * they cross source boundaries. Provably equal to a full rebuild for the semantic
   * content (object keys/types/names/domains/payloads + FTS + edges); only the
   * `updated_at`/`built_at` timestamps of untouched rows differ. Falls back to a
   * full rebuild when there is no prior fingerprint state.
   */
  rebuildIncremental(snapshot: MetadataSnapshot): { mode: 'full' | 'incremental'; changedSources: number } {
    const stored = new Map<string, string>();
    for (const row of this.db.prepare('SELECT source_path, fingerprint FROM metadata_source_fingerprints').all() as Array<{ source_path: string; fingerprint: string }>) {
      stored.set(row.source_path, row.fingerprint);
    }
    if (stored.size === 0) {
      this.rebuild(snapshot);
      return { mode: 'full', changedSources: 0 };
    }

    const now = new Date().toISOString();
    const incoming = buildSourceFingerprints(snapshot.objects, now);
    const incomingSources = new Set(incoming.map((f) => f.sourcePath));
    const changedSources = new Set<string>();
    for (const fingerprint of incoming) {
      if (stored.get(fingerprint.sourcePath) !== fingerprint.fingerprint) changedSources.add(fingerprint.sourcePath);
    }
    const removedSources = [...stored.keys()].filter((source) => !incomingSources.has(source));
    const sourceOf = (object: MetadataObject): string | null => object.sourcePath ?? object.sourceSystem ?? null;
    const domainShards = buildDomainShards(snapshot.objects, now);

    const insertObject = this.db.prepare(`
      INSERT INTO metadata_objects (
        object_key, object_type, name, full_name, domain, owner, status,
        description, source_path, source_system, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = this.db.prepare(`
      INSERT INTO metadata_fts (object_key, name, full_name, description, domain, owner, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertVector = this.db.prepare(`
      INSERT INTO metadata_vector_index (object_key, provider_id, dimensions, vector, text_hash)
      VALUES (?, ?, ?, ?, ?)`);
    const insertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO metadata_edges (edge_type, from_key, to_key, confidence, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    // OR IGNORE: the id is a content hash, so a colliding row is byte-identical
    // — dropping the duplicate is lossless and keeps the rebuild transactional.
    const insertDiagnostic = this.db.prepare(`
      INSERT OR IGNORE INTO metadata_diagnostics (id, kind, severity, message, object_key, file_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertSourceFingerprint = this.db.prepare(`
      INSERT OR REPLACE INTO metadata_source_fingerprints (source_path, fingerprint, object_count, updated_at)
      VALUES (?, ?, ?, ?)`);
    const insertDomainShard = this.db.prepare(`
      INSERT OR REPLACE INTO metadata_domain_shards (
        domain, object_count, block_count, certified_block_count,
        semantic_metric_count, dbt_object_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const setState = this.db.prepare('INSERT OR REPLACE INTO metadata_state (key, value) VALUES (?, ?)');
    const insertSkillBody = this.db.prepare(`
      INSERT OR REPLACE INTO skill_bodies (body_hash, encoding, compressed_body, original_length)
      VALUES (?, 'br', ?, ?)`);
    const deleteFtsForSource = this.db.prepare('DELETE FROM metadata_fts WHERE object_key IN (SELECT object_key FROM metadata_objects WHERE COALESCE(source_path, source_system) = ?)');
    const deleteVectorsForSource = this.db.prepare('DELETE FROM metadata_vector_index WHERE object_key IN (SELECT object_key FROM metadata_objects WHERE COALESCE(source_path, source_system) = ?)');
    const deleteObjectsForSource = this.db.prepare('DELETE FROM metadata_objects WHERE COALESCE(source_path, source_system) = ?');

    const txn = this.db.transaction(() => {
      // Drop changed + removed sources' rows, and ALL sourceless rows (never
      // fingerprinted, so always refreshed).
      for (const source of [...changedSources, ...removedSources]) {
        deleteFtsForSource.run(source);
        deleteVectorsForSource.run(source);
        deleteObjectsForSource.run(source);
      }
      this.db.prepare('DELETE FROM metadata_fts WHERE object_key IN (SELECT object_key FROM metadata_objects WHERE source_path IS NULL AND source_system IS NULL)').run();
      this.db.prepare('DELETE FROM metadata_vector_index WHERE object_key IN (SELECT object_key FROM metadata_objects WHERE source_path IS NULL AND source_system IS NULL)').run();
      this.db.prepare('DELETE FROM metadata_objects WHERE source_path IS NULL AND source_system IS NULL').run();

      // Re-insert only objects from changed sources or sourceless; unchanged
      // sources' rows are left untouched.
      for (const object of snapshot.objects) {
        const source = sourceOf(object);
        if (source !== null && !changedSources.has(source)) continue;
        const payload = object.payload ?? {};
        insertObject.run(
          object.objectKey, object.objectType, object.name, object.fullName ?? null,
          object.domain ?? null, object.owner ?? null, object.status ?? null,
          object.description ?? null, object.sourcePath ?? null, object.sourceSystem ?? null,
          JSON.stringify(payload), object.updatedAt ?? now,
        );
        insertFts.run(object.objectKey, object.name, object.fullName ?? '', object.description ?? '', object.domain ?? '', object.owner ?? '', searchableMetadataPayload(payload));
        if (isVectorIndexObject(object)) {
          const vectorText = metadataVectorText(object);
          const vector = DEFAULT_VECTOR_PROVIDER.embedOne(vectorText);
          insertVector.run(
            object.objectKey,
            DEFAULT_VECTOR_PROVIDER.id,
            vector.length,
            encodeFloat32Vector(vector),
            sha256(vectorText),
          );
        }
      }

      // Cross-source tables: rebuild fully.
      this.db.prepare('DELETE FROM metadata_edges').run();
      for (const edge of snapshot.edges) {
        insertEdge.run(edge.edgeType, edge.fromKey, edge.toKey, edge.confidence ?? 1, JSON.stringify(edge.payload ?? {}), now);
      }
      this.db.prepare('DELETE FROM metadata_diagnostics').run();
      for (const diagnostic of snapshot.diagnostics) {
        insertDiagnostic.run(diagnosticId(diagnostic), diagnostic.kind, diagnostic.severity, diagnostic.message, diagnostic.objectKey ?? null, diagnostic.filePath ?? null, now);
      }
      this.db.prepare('DELETE FROM metadata_domain_shards').run();
      for (const shard of domainShards) {
        insertDomainShard.run(shard.domain, shard.objectCount, shard.blockCount, shard.certifiedBlockCount, shard.semanticMetricCount, shard.dbtObjectCount, shard.updatedAt);
      }
      this.db.prepare('DELETE FROM skill_bodies').run();
      for (const item of snapshot.skillBodies ?? []) {
        insertSkillBody.run(
          item.bodyHash,
          brotliCompressSync(item.body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }).toString('base64'),
          Buffer.byteLength(item.body, 'utf8'),
        );
      }

      for (const source of removedSources) {
        this.db.prepare('DELETE FROM metadata_source_fingerprints WHERE source_path = ?').run(source);
      }
      for (const fingerprint of incoming) {
        insertSourceFingerprint.run(fingerprint.sourcePath, fingerprint.fingerprint, fingerprint.objectCount, fingerprint.updatedAt);
      }

      setState.run('built_at', now);
      setState.run('fingerprint', snapshot.fingerprint);
      setState.run('project_root', snapshot.projectRoot);
      setState.run('object_count', String(snapshot.objects.length));
      setState.run('edge_count', String(snapshot.edges.length));
      setState.run('source_fingerprint_count', String(incoming.length));
      setState.run('domain_shard_count', String(domainShards.length));
      setState.run('diagnostics_json', JSON.stringify(snapshot.diagnostics));
      setState.run('compile_conflicts_json', JSON.stringify(snapshot.compileConflicts ?? []));
      setState.run('manifest_generated_at', snapshot.manifest.generatedAt);
      setState.run('index_version', METADATA_INDEX_VERSION);
      setState.run('vector_provider', DEFAULT_VECTOR_PROVIDER.id);
      setState.run('vector_dimensions', String(DEFAULT_VECTOR_PROVIDER.dimensions));
    });
    txn();
    return { mode: 'incremental', changedSources: changedSources.size };
  }

  searchObjects(options: {
    query: string;
    objectTypes?: string[];
    domain?: string;
    domains?: string[];
    limit?: number;
  }): MetadataObject[] {
    const { query, objectTypes, domain, domains, limit = 40 } = options;
    const match = buildFtsMatch(query, { prefix: true });
    if (!match.or) return this.listObjects({ objectTypes, domain, limit });

    const filters: string[] = [];
    const extraParams: unknown[] = [];
    if (objectTypes && objectTypes.length > 0) {
      filters.push(`o.object_type IN (${objectTypes.map(() => '?').join(', ')})`);
      extraParams.push(...objectTypes);
    }
    if (domain) {
      filters.push('o.domain = ?');
      extraParams.push(domain);
    } else if (domains?.length) {
      filters.push(`(o.domain IS NULL OR o.domain IN (${domains.map(() => '?').join(', ')}))`);
      extraParams.push(...domains);
    }
    const whereExtra = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
    const runMatch = (matchExpr: string): MetadataObjectRow[] => this.db.prepare(`
      SELECT o.*,
             bm25(metadata_fts) AS rank,
             snippet(metadata_fts, -1, '<mark>', '</mark>', '...', 12) AS snip
      FROM metadata_fts
      JOIN metadata_objects AS o ON o.object_key = metadata_fts.object_key
      WHERE metadata_fts MATCH ?${whereExtra}
      ORDER BY rank
      LIMIT ?
    `).all(matchExpr, ...extraParams, limit) as MetadataObjectRow[];

    // Precision-first, recall-preserving UNION: all-terms-co-occur (AND) matches
    // lead, then OR-of-terms matches fill the remaining budget. A doc mentioning
    // only one term (a relevant context column) still surfaces, while a doc
    // containing every term ranks ahead of it. Dedup by object_key.
    const andRows = match.and ? runMatch(match.and) : [];
    const seen = new Set(andRows.map((row) => row.object_key));
    const orRows = runMatch(match.or).filter((row) => !seen.has(row.object_key));
    const rows = [...andRows, ...orRows].slice(0, limit);
    const andKeys = new Set(andRows.map((row) => row.object_key));
    const maxAndMagnitude = strongestBm25Magnitude(andRows);
    const maxOrMagnitude = strongestBm25Magnitude(orRows);

    return rows.map((row) => ({
      ...rowToObject(row),
      // FTS5 bm25() is negative and more-negative means stronger. The old
      // max(0, rank) conversion flattened virtually every hit to 1. Preserve
      // within-tier separation and keep all-terms (AND) evidence ahead of a
      // partial OR-only match without pretending BM25 is an absolute confidence.
      score: normalizedBm25Score(
        row.rank,
        andKeys.has(row.object_key) ? 'and' : 'or',
        andKeys.has(row.object_key) ? maxAndMagnitude : maxOrMagnitude,
      ),
      snippet: row.snip ?? undefined,
    }));
  }

  /**
   * Bounded, index-only catalog query for inventory surfaces such as App
   * Studio. Unlike `searchObjects`, this contract owns pagination and a total
   * count so browsers never have to download an arbitrary top-N subset and
   * pretend it is the complete catalog.
   */
  queryObjectsPage(options: {
    query?: string;
    objectTypes?: string[];
    domains?: string[];
    statuses?: string[];
    offset?: number;
    limit?: number;
  }): { items: MetadataObject[]; total: number } {
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.objectTypes?.length) {
      filters.push(`o.object_type IN (${options.objectTypes.map(() => '?').join(', ')})`);
      params.push(...options.objectTypes);
    }
    if (options.domains?.length) {
      filters.push(`COALESCE(o.domain, '') IN (${options.domains.map(() => '?').join(', ')})`);
      params.push(...options.domains);
    }
    if (options.statuses?.length) {
      filters.push(`COALESCE(o.status, 'unknown') IN (${options.statuses.map(() => '?').join(', ')})`);
      params.push(...options.statuses);
    }
    const match = buildFtsMatch(options.query ?? '', { prefix: true });
    const useFts = Boolean(match.or);
    const from = useFts
      ? 'FROM metadata_fts JOIN metadata_objects AS o ON o.object_key = metadata_fts.object_key'
      : 'FROM metadata_objects AS o';
    const where = [
      ...(useFts ? ['metadata_fts MATCH ?'] : []),
      ...filters,
    ];
    const queryParams = [...(useFts ? [match.or] : []), ...params];
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count ${from} ${whereSql}`).get(...queryParams) as { count: number }).count);
    const rankSql = useFts ? ', bm25(metadata_fts) AS rank' : '';
    const orderSql = useFts ? 'ORDER BY rank, o.object_key' : 'ORDER BY o.object_key';
    const rows = this.db.prepare(`
      SELECT o.*${rankSql}
      ${from}
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `).all(...queryParams, limit, offset) as MetadataObjectRow[];
    const items = rows.map((row) => {
      const item = rowToObject(row);
      if (!useFts || row.rank === undefined || row.rank === null) return item;
      return { ...item, score: Number((1 / (1 + Math.abs(row.rank))).toFixed(6)) };
    });
    return { items, total };
  }

  /** Replace the snapshot vector lane with an explicitly configured provider. */
  async rebuildVectorIndex(provider: EmbeddingProvider, batchSize = 96): Promise<void> {
    const objects: MetadataObject[] = [];
    this.scanObjects({ batchSize: 500 }, (rows) => {
      objects.push(...rows.filter(isVectorIndexObject));
    });
    const encoded: Array<{ objectKey: string; dimensions: number; vector: Buffer; textHash: string }> = [];
    let dimensions = 0;
    for (let offset = 0; offset < objects.length; offset += Math.max(1, batchSize)) {
      const batch = objects.slice(offset, offset + Math.max(1, batchSize));
      const texts = batch.map(metadataVectorText);
      const vectors = await provider.embed(texts);
      if (vectors.length !== batch.length) {
        throw new Error(`Embedding provider ${provider.id} returned ${vectors.length} vectors for ${batch.length} objects.`);
      }
      for (let index = 0; index < batch.length; index += 1) {
        const vector = vectors[index] ?? [];
        if (vector.length === 0) throw new Error(`Embedding provider ${provider.id} returned an empty vector.`);
        if (dimensions === 0) dimensions = vector.length;
        if (vector.length !== dimensions) {
          throw new Error(`Embedding provider ${provider.id} changed dimensions from ${dimensions} to ${vector.length}.`);
        }
        encoded.push({
          objectKey: batch[index]!.objectKey,
          dimensions,
          vector: encodeFloat32Vector(vector),
          textHash: sha256(texts[index]!),
        });
      }
    }
    const insert = this.db.prepare(`
      INSERT INTO metadata_vector_index (object_key, provider_id, dimensions, vector, text_hash)
      VALUES (?, ?, ?, ?, ?)
    `);
    const setState = this.db.prepare('INSERT OR REPLACE INTO metadata_state (key, value) VALUES (?, ?)');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM metadata_vector_index').run();
      for (const item of encoded) {
        insert.run(item.objectKey, provider.id, item.dimensions, item.vector, item.textHash);
      }
      setState.run('vector_provider', provider.id);
      setState.run('vector_dimensions', String(dimensions));
    })();
  }

  /** Independent vector candidate generation over all eligible snapshot cards. */
  async searchVectorObjects(options: {
    query: string;
    objectTypes?: string[];
    domains?: string[];
    limit?: number;
    provider?: EmbeddingProvider;
    /**
     * Rebuild the embedder an index was written with, when the caller only had
     * the offline default to offer. Injected so this module stays free of
     * provider construction.
     */
    resolveIndexedProvider?: (indexedProviderId: string) => EmbeddingProvider | undefined;
  }): Promise<MetadataVectorSearchResult> {
    const indexedProviderId = this.state('vector_provider') ?? DEFAULT_VECTOR_PROVIDER.id;
    const indexedDimensions = Number(this.state('vector_dimensions') ?? DEFAULT_VECTOR_PROVIDER.dimensions);
    // An index knows which embedder built it, and only that embedder can read
    // it. When the caller asks with the offline hashed default — which is what
    // an unconfigured project resolves to — while the index was built by a real
    // model, honouring the request returns ZERO candidates and the vector lane
    // silently disappears. That is exactly what happened after a background
    // upgrade re-embedded the index in one process: every later process asked
    // for hashed and got nothing. Prefer the index's own embedder, and let a
    // caller that deliberately named a real provider still disagree loudly.
    const requested = options.provider ?? DEFAULT_VECTOR_PROVIDER;
    const provider = requested.id !== indexedProviderId
      && requested.id === DEFAULT_VECTOR_PROVIDER.id
      && options.resolveIndexedProvider
      ? options.resolveIndexedProvider(indexedProviderId) ?? requested
      : requested;
    if (provider.id !== indexedProviderId) {
      return {
        providerId: indexedProviderId,
        dimensions: indexedDimensions,
        candidates: [],
        unavailableReason: `requested provider ${provider.id} does not match snapshot vector provider ${indexedProviderId}`,
      };
    }
    const [queryVector] = provider === DEFAULT_VECTOR_PROVIDER
      ? [DEFAULT_VECTOR_PROVIDER.embedOne(options.query)]
      : await provider.embed([options.query]);
    if (!queryVector || queryVector.length !== indexedDimensions) {
      return {
        providerId: indexedProviderId,
        dimensions: indexedDimensions,
        candidates: [],
        unavailableReason: `query vector dimensions do not match snapshot index (${queryVector?.length ?? 0} vs ${indexedDimensions})`,
      };
    }
    const filters: string[] = ['v.provider_id = ?'];
    const params: unknown[] = [indexedProviderId];
    if (options.objectTypes?.length) {
      filters.push(`o.object_type IN (${options.objectTypes.map(() => '?').join(', ')})`);
      params.push(...options.objectTypes);
    }
    if (options.domains?.length) {
      filters.push(`(o.domain IS NULL OR o.domain IN (${options.domains.map(() => '?').join(', ')}))`);
      params.push(...options.domains);
    }
    const rows = this.db.prepare(`
      SELECT o.*, v.vector AS vector_blob
      FROM metadata_vector_index AS v
      JOIN metadata_objects AS o ON o.object_key = v.object_key
      WHERE ${filters.join(' AND ')}
      ORDER BY o.object_key
    `).all(...params) as Array<MetadataObjectRow & { vector_blob: Buffer }>;
    const candidates = rows
      .map((row) => {
        const cosine = cosineSimilarity(queryVector, decodeFloat32Vector(row.vector_blob));
        return { ...rowToObject(row), score: Number(((cosine + 1) / 2).toFixed(6)) };
      })
      // A cosine of zero maps to 0.5 and is not evidence. Requiring positive
      // separation prevents hash collisions/unrelated cards from flooding the
      // downstream bounded context while retaining independent vector recall.
      .filter((row) => (row.score ?? 0) > 0.55)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.objectKey.localeCompare(right.objectKey))
      .slice(0, Math.max(1, options.limit ?? 40));
    return { providerId: indexedProviderId, dimensions: indexedDimensions, candidates };
  }

  listObjects(options: {
    objectTypes?: string[];
    domain?: string;
    limit?: number;
  } = {}): MetadataObject[] {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.objectTypes && options.objectTypes.length > 0) {
      filters.push(`object_type IN (${options.objectTypes.map(() => '?').join(', ')})`);
      params.push(...options.objectTypes);
    }
    if (options.domain) {
      filters.push('domain = ?');
      params.push(options.domain);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM metadata_objects
      ${where}
      ORDER BY updated_at DESC, name
      LIMIT ?
    `).all(...params, options.limit ?? 100) as MetadataObjectRow[];
    return rows.map(rowToObject);
  }

  /** Complete typed inventory; callers must apply their own bounded ranking. */
  listAllObjects(options: { objectTypes?: string[]; domain?: string } = {}): MetadataObject[] {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.objectTypes && options.objectTypes.length > 0) {
      filters.push(`object_type IN (${options.objectTypes.map(() => '?').join(', ')})`);
      params.push(...options.objectTypes);
    }
    if (options.domain) {
      filters.push('domain = ?');
      params.push(options.domain);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT * FROM metadata_objects
      ${where}
      ORDER BY object_key
    `).all(...params) as MetadataObjectRow[];
    return rows.map(rowToObject);
  }

  /**
   * Every object of the given types the envelope admits: an undomained object
   * is always eligible, a domained one only inside the admitted domains, and
   * an empty domain list admits everything. Compact rows; payload only for the
   * small authored kinds. This is admission, not retrieval: nothing is ranked
   * and nothing is cut.
   */
  listEligibleObjects(options: { objectTypes: readonly string[]; domains: string[]; payloadTypes?: Set<string> }): EligibleObjectRef[] {
    if (options.objectTypes.length === 0) return [];
    const filters: string[] = [`object_type IN (${options.objectTypes.map(() => '?').join(', ')})`];
    const params: unknown[] = [...options.objectTypes];
    if (options.domains.length > 0) {
      filters.push(`(domain IS NULL OR domain IN (${options.domains.map(() => '?').join(', ')}))`);
      params.push(...options.domains);
    }
    const rows = this.db.prepare(`
      SELECT object_key, object_type, name, domain, status, description, payload_json FROM metadata_objects
      WHERE ${filters.join(' AND ')}
      ORDER BY object_type, object_key
    `).all(...params) as Array<{ object_key: string; object_type: string; name: string; domain: string | null; status: string | null; description: string | null; payload_json: string | null }>;
    return rows.map((row) => {
      const wantPayload = options.payloadTypes?.has(row.object_type) ?? false;
      let payload: Record<string, unknown> | undefined;
      if (wantPayload && row.payload_json) {
        try { payload = JSON.parse(row.payload_json) as Record<string, unknown>; } catch { payload = undefined; }
      }
      return {
        objectKey: row.object_key, objectType: row.object_type, name: row.name,
        ...(row.domain ? { domain: row.domain } : {}), ...(row.status ? { status: row.status } : {}),
        ...(wantPayload && row.description ? { description: row.description } : {}),
        ...(payload ? { payload } : {}),
      };
    });
  }

  crossDomainRouteObjects(domainId: string, limit = 100): MetadataObject[] {
    const rows = this.db.prepare(`
      SELECT * FROM metadata_objects
      WHERE object_type = 'cross_domain_route'
        AND (domain = ? OR json_extract(payload_json, '$.providerDomainId') = ?)
      ORDER BY status, name, object_key
      LIMIT ?
    `).all(domainId, domainId, Math.max(1, Math.min(limit, 500))) as MetadataObjectRow[];
    return rows.map(rowToObject);
  }

  scanObjects(options: {
    objectTypes?: string[];
    domain?: string;
    batchSize?: number;
  }, visit: (objects: MetadataObject[]) => void): void {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.objectTypes && options.objectTypes.length > 0) {
      filters.push(`object_type IN (${options.objectTypes.map(() => '?').join(', ')})`);
      params.push(...options.objectTypes);
    }
    if (options.domain) {
      filters.push('domain = ?');
      params.push(options.domain);
    }
    const batchSize = Math.max(1, options.batchSize ?? 500);
    let lastObjectKey = '';
    while (true) {
      const pageFilters = [...filters];
      const pageParams = [...params];
      if (lastObjectKey) {
        pageFilters.push('object_key > ?');
        pageParams.push(lastObjectKey);
      }
      const where = pageFilters.length > 0 ? `WHERE ${pageFilters.join(' AND ')}` : '';
      const rows = this.db.prepare(`
        SELECT * FROM metadata_objects
        ${where}
        ORDER BY object_key
        LIMIT ?
      `).all(...pageParams, batchSize) as MetadataObjectRow[];
      if (rows.length === 0) break;
      visit(rows.map(rowToObject));
      lastObjectKey = rows[rows.length - 1]?.object_key ?? lastObjectKey;
      if (rows.length < batchSize) break;
    }
  }

  getObject(objectKey: string): MetadataObject | null {
    const row = this.db.prepare('SELECT * FROM metadata_objects WHERE object_key = ?').get(objectKey) as MetadataObjectRow | undefined;
    if (row) return rowToObject(row);
    const legacy = legacyQualifiedAlias(objectKey);
    if (!legacy) return null;
    const matches = this.db.prepare(`
      SELECT * FROM metadata_objects
      WHERE object_type = ? AND name = ?
      ORDER BY object_key
      LIMIT 2
    `).all(legacy.objectType, legacy.name) as MetadataObjectRow[];
    // A legacy local-name lookup is safe only while it resolves uniquely. When
    // two domains define the same local ID, callers must use the qualified key.
    return matches.length === 1 ? rowToObject(matches[0]!) : null;
  }

  getObjectsByKeys(keys: string[]): MetadataObject[] {
    const unique = Array.from(new Set(keys.filter(Boolean)));
    if (unique.length === 0) return [];
    const rows: MetadataObject[] = [];
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const fetched = this.db.prepare(`
        SELECT * FROM metadata_objects
        WHERE object_key IN (${chunk.map(() => '?').join(', ')})
        ORDER BY name
      `).all(...chunk) as MetadataObjectRow[];
      rows.push(...fetched.map(rowToObject));
    }
    const found = new Set(rows.map((row) => row.objectKey));
    for (const key of unique) {
      if (found.has(key)) continue;
      const resolved = this.getObject(key);
      if (resolved && !rows.some((row) => row.objectKey === resolved.objectKey)) rows.push(resolved);
    }
    return rows;
  }

  findObjectByIdentity(identity: string): MetadataObject | null {
    return this.resolveIdentity(identity).object ?? null;
  }

  /** Resolve exact/qualified/native/alias identities without first-match wins. */
  resolveIdentity(identity: string): MetadataIdentityResolution {
    const normalized = identity.trim();
    if (!normalized) return { identity, status: 'missing', candidates: [] };
    const exact = this.db.prepare(`
      SELECT * FROM metadata_objects WHERE object_key = ?
    `).get(normalized) as MetadataObjectRow | undefined;
    if (exact) {
      const object = rowToObject(exact);
      return { identity, status: 'resolved', matchedBy: 'object_key', object, candidates: [object] };
    }
    const rows = this.db.prepare(`
      SELECT DISTINCT o.*
      FROM metadata_objects AS o
      WHERE o.full_name = ?
         OR json_extract(o.payload_json, '$.sourceNativeId') = ?
         OR EXISTS (
           SELECT 1
           FROM json_each(COALESCE(json_extract(o.payload_json, '$.aliases'), '[]')) AS alias
           WHERE alias.value = ?
         )
      ORDER BY o.object_key
      LIMIT 21
    `).all(normalized, normalized, normalized) as MetadataObjectRow[];
    const candidates = rows.map(rowToObject);
    if (candidates.length === 0) return { identity, status: 'missing', candidates: [] };
    if (candidates.length > 1) return { identity, status: 'ambiguous', candidates };
    const object = candidates[0]!;
    const payload = object.payload ?? {};
    const aliases = metadataStringArray(payload.aliases);
    const matchedBy = object.fullName === normalized
      ? 'qualified_id'
      : stringValue(payload.sourceNativeId) === normalized
        ? 'source_native_id'
        : aliases.includes(normalized)
          ? 'alias'
          : 'qualified_id';
    return { identity, status: 'resolved', matchedBy, object, candidates };
  }

  edgesForKeys(keys: string[], hops = 1): MetadataEdge[] {
    let frontier = new Set(keys.filter(Boolean));
    const seenKeys = new Set(frontier);
    const edges = new Map<string, MetadataEdge>();
    for (let hop = 0; hop < hops && frontier.size > 0; hop += 1) {
      const current = Array.from(frontier).sort();
      frontier = new Set();
      const rows: MetadataEdgeRow[] = [];
      for (let offset = 0; offset < current.length; offset += 100) {
        const chunk = current.slice(offset, offset + 100);
        rows.push(...this.db.prepare(`
          SELECT * FROM metadata_edges
          WHERE from_key IN (${chunk.map(() => '?').join(', ')})
             OR to_key IN (${chunk.map(() => '?').join(', ')})
          ORDER BY confidence DESC, edge_type, from_key, to_key
          LIMIT 500
        `).all(...chunk, ...chunk) as MetadataEdgeRow[]);
      }
      rows.sort((left, right) =>
        right.confidence - left.confidence
        || `${left.edge_type}|${left.from_key}|${left.to_key}`.localeCompare(`${right.edge_type}|${right.from_key}|${right.to_key}`));
      for (const row of rows) {
        const edge = rowToEdge(row);
        const edgeKey = `${edge.edgeType}\u0000${edge.fromKey}\u0000${edge.toKey}`;
        if (!edges.has(edgeKey)) edges.set(edgeKey, edge);
        for (const key of [edge.fromKey, edge.toKey]) {
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            frontier.add(key);
          }
        }
      }
    }
    return Array.from(edges.values());
  }

  insertContextPack(pack: Omit<LocalContextPack, 'id'>): string {
    const id = `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const payload = JSON.stringify(pack);
    this.db.prepare(`
      INSERT INTO context_packs (
        id, question, focus_object_key, mode, trust_label, payload_json, created_at, payload_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      pack.question,
      pack.focusObjectKey,
      pack.mode,
      pack.trustLabel,
      payload,
      now,
      payload.length,
    );
    const last = contextPackPrunes.get(this.dbPath) ?? { at: 0, inserts: 0 };
    last.inserts += 1;
    contextPackPrunes.set(this.dbPath, last);
    if (last.inserts >= CONTEXT_PACK_PRUNE_EVERY || Date.now() - last.at >= CONTEXT_PACK_PRUNE_EVERY_MS) {
      contextPackPrunes.set(this.dbPath, { at: Date.now(), inserts: 0 });
      try {
        this.pruneContextPacks();
      } catch {
        // Pruning is housekeeping: it never fails an answer.
      }
    }
    return id;
  }

  recordQueryRun(run: Omit<QueryRunSummary, 'id'> & { id?: string }): QueryRunSummary {
    const id = run.id ?? `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = run.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO query_runs (
        id, object_key, source, status, row_count, duration_ms, error_code, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      run.objectKey ?? null,
      run.source,
      run.status,
      run.rowCount ?? null,
      run.durationMs ?? null,
      run.errorCode ?? null,
      JSON.stringify(run.payload ?? {}),
      createdAt,
    );
    return { ...run, id, createdAt };
  }

  queryRunsForObjectKeys(keys: string[], limit = 20): QueryRunSummary[] {
    const unique = Array.from(new Set(keys.filter(Boolean)));
    if (unique.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT * FROM query_runs
      WHERE object_key IN (${unique.slice(0, 80).map(() => '?').join(', ')})
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...unique.slice(0, 80), limit) as QueryRunRow[];
    return rows.map(rowToQueryRun);
  }

  recordRuntimeSchemaSnapshot(snapshot: RuntimeSchemaSnapshot): RuntimeSchemaSnapshot {
    const capturedAt = snapshot.capturedAt ?? new Date().toISOString();
    const normalizedTables = normalizeRuntimeSchemaTables(snapshot.tables).slice(0, 10_000);
    const cleanSnapshot: RuntimeSchemaSnapshot = {
      version: 1,
      generationId: snapshot.generationId,
      scopeFingerprint: snapshot.scopeFingerprint,
      connectionId: snapshot.connectionId,
      status: snapshot.status ?? 'ready',
      source: snapshot.source,
      capturedAt,
      observedTarget: normalizeRuntimeSchemaObservedTarget(snapshot.observedTarget),
      scopes: normalizeRuntimeSchemaScopes(snapshot.scopes),
      queryCount: boundedRuntimeSchemaNumber(snapshot.queryCount),
      durationMs: boundedRuntimeSchemaNumber(snapshot.durationMs),
      truncated: snapshot.truncated === true || undefined,
      tables: normalizedTables,
    };
    const id = snapshot.generationId?.trim() || `schema_${Date.parse(capturedAt) || Date.now()}`;
    const insertSnapshot = this.db.prepare(`
      INSERT OR REPLACE INTO runtime_schema_snapshots (
        id, source, payload_json, captured_at
      ) VALUES (?, ?, ?, ?)
    `);
    const insertSchemaObject = this.db.prepare(`
      INSERT INTO runtime_schema_objects (
        object_key, object_type, name, full_name, domain, owner, status,
        description, source_path, source_system, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSchemaFts = this.db.prepare(`
      INSERT INTO runtime_schema_fts (object_key, name, full_name, description, payload)
      VALUES (?, ?, ?, ?, ?)
    `);
    const setState = this.db.prepare(`
      INSERT OR REPLACE INTO metadata_state (key, value) VALUES (?, ?)
    `);
    const txn = this.db.transaction(() => {
      insertSnapshot.run(
        id,
        cleanSnapshot.source ?? null,
        JSON.stringify(cleanSnapshot),
        capturedAt,
      );
      // Preserve a bounded history across multiple named connections. Ask
      // resolves the latest snapshot for its selected connection, so retaining
      // only five project-global rows could evict a valid but less-recent
      // warehouse as soon as another connection was refreshed repeatedly.
      this.db.prepare(`
        DELETE FROM runtime_schema_snapshots
        WHERE id NOT IN (
          SELECT id FROM runtime_schema_snapshots ORDER BY captured_at DESC LIMIT 50
        )
      `).run();
      this.db.prepare('DELETE FROM runtime_value_fts').run();
      this.db.prepare('DELETE FROM runtime_value_index').run();
      this.db.prepare('DELETE FROM runtime_schema_fts').run();
      this.db.prepare('DELETE FROM runtime_schema_objects').run();
      for (const table of normalizedTables) {
        const object = runtimeSchemaTableObject(table, cleanSnapshot.source, capturedAt);
        const payload = object.payload ?? {};
        insertSchemaObject.run(
          object.objectKey,
          object.objectType,
          object.name,
          object.fullName ?? null,
          null,
          null,
          object.status ?? null,
          object.description ?? null,
          null,
          object.sourceSystem ?? null,
          JSON.stringify(payload),
          capturedAt,
        );
        insertSchemaFts.run(
          object.objectKey,
          object.name,
          object.fullName ?? '',
          object.description ?? '',
          searchableMetadataPayload(payload),
        );
      }
      setState.run('runtime_value_index_count', '0');
      setState.run('runtime_value_index_captured_at', capturedAt);
      setState.run('runtime_schema_table_count', String(normalizedTables.length));
      setState.run('runtime_schema_index_captured_at', capturedAt);
      setState.run('runtime_schema_generation_id', id);
      if (cleanSnapshot.scopeFingerprint) {
        setState.run('runtime_schema_scope_fingerprint', cleanSnapshot.scopeFingerprint);
      }
    });
    txn();
    return cleanSnapshot;
  }

  searchRuntimeValues(terms: string[], limit = 40): RuntimeValueMatch[] {
    // Deliberately non-persistent. Approved live probes are attached to the
    // current in-memory schema context by the CLI and discarded after the Ask.
    void terms;
    void limit;
    return [];
  }

  searchRuntimeSchemaObjects(query: string, limit = 40): MetadataObject[] {
    const match = buildFtsMatch(query, { prefix: true });
    if (!match.or) return [];
    const runMatch = (matchExpr: string): MetadataObjectRow[] => this.db.prepare(`
      SELECT o.*,
             bm25(runtime_schema_fts) AS rank,
             snippet(runtime_schema_fts, -1, '<mark>', '</mark>', '...', 12) AS snip
      FROM runtime_schema_fts
      JOIN runtime_schema_objects AS o ON o.object_key = runtime_schema_fts.object_key
      WHERE runtime_schema_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(matchExpr, Math.max(1, limit)) as MetadataObjectRow[];
    const andRows = match.and ? runMatch(match.and) : [];
    const seen = new Set(andRows.map((row) => row.object_key));
    const rows = [...andRows, ...runMatch(match.or).filter((row) => !seen.has(row.object_key))].slice(0, limit);
    return rows.map(rowToObject);
  }

  latestRuntimeSchemaSnapshot(connectionId?: string): RuntimeSchemaSnapshot | null {
    const rows = this.db.prepare(`
      SELECT payload_json
      FROM runtime_schema_snapshots
      ORDER BY captured_at DESC
      LIMIT 50
    `).all() as Array<{ payload_json: string }>;
    for (const row of rows) {
      const snapshot = safeRuntimeSchemaSnapshot(safeJson(row.payload_json, null));
      if (!snapshot) continue;
      if (!connectionId || snapshot.connectionId === connectionId) return snapshot;
    }
    return null;
  }

  getContextPack(id: string): LocalContextPack | null {
    const row = this.db.prepare('SELECT payload_json FROM context_packs WHERE id = ?').get(id) as { payload_json: string } | undefined;
    if (!row) return null;
    const payload = safeJson<Omit<LocalContextPack, 'id'> | null>(row.payload_json, null);
    return payload ? { ...payload, id } : null;
  }

  objectCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM metadata_objects').get() as { n: number };
    return row.n;
  }

  edgeCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM metadata_edges').get() as { n: number };
    return row.n;
  }

  diagnostics(): MetadataDiagnostic[] {
    const rows = this.db.prepare(`
      SELECT kind, severity, message, object_key, file_path
      FROM metadata_diagnostics
      ORDER BY severity, kind, message
    `).all() as Array<{
      kind: string;
      severity: 'error' | 'warning';
      message: string;
      object_key: string | null;
      file_path: string | null;
    }>;
    return rows.map((row) => ({
      kind: row.kind,
      severity: row.severity,
      message: row.message,
      objectKey: row.object_key ?? undefined,
      filePath: row.file_path ?? undefined,
    }));
  }

  /** Structured compile-time trust conflicts persisted with the last rebuild. */
  compileConflicts(): ManifestConflictDetail[] {
    const raw = this.state('compile_conflicts_json');
    if (!raw) return [];
    const parsed = safeJson<ManifestConflictDetail[] | null>(raw, null);
    return Array.isArray(parsed) ? parsed : [];
  }

  sourceFingerprints(limit = 500): MetadataSourceFingerprint[] {
    const rows = this.db.prepare(`
      SELECT source_path, fingerprint, object_count, updated_at
      FROM metadata_source_fingerprints
      ORDER BY object_count DESC, source_path
      LIMIT ?
    `).all(limit) as Array<{
      source_path: string;
      fingerprint: string;
      object_count: number;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      sourcePath: row.source_path,
      fingerprint: row.fingerprint,
      objectCount: row.object_count,
      updatedAt: row.updated_at,
    }));
  }

  domainShards(limit = 100): MetadataDomainShard[] {
    const rows = this.db.prepare(`
      SELECT domain, object_count, block_count, certified_block_count,
        semantic_metric_count, dbt_object_count, updated_at
      FROM metadata_domain_shards
      ORDER BY object_count DESC, domain
      LIMIT ?
    `).all(limit) as Array<{
      domain: string;
      object_count: number;
      block_count: number;
      certified_block_count: number;
      semantic_metric_count: number;
      dbt_object_count: number;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      domain: row.domain,
      objectCount: row.object_count,
      blockCount: row.block_count,
      certifiedBlockCount: row.certified_block_count,
      semanticMetricCount: row.semantic_metric_count,
      dbtObjectCount: row.dbt_object_count,
      updatedAt: row.updated_at,
    }));
  }

  skillBody(bodyHash: string): string | null {
    const row = this.db.prepare(`
      SELECT encoding, compressed_body
      FROM skill_bodies
      WHERE body_hash = ?
    `).get(bodyHash) as { encoding: string; compressed_body: string } | undefined;
    if (!row) return null;
    if (row.encoding !== 'br') return row.compressed_body;
    const compressed = Uint8Array.from(Buffer.from(row.compressed_body, 'base64'));
    return brotliDecompressSync(compressed).toString('utf8');
  }

  exportSnapshot(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true });
    if (existsSync(destination)) return;
    const candidate = `${destination}.candidate`;
    rmSync(candidate, { force: true });
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.prepare('VACUUM INTO ?').run(candidate);
    const Database = loadDatabase();
    const sealed = new Database(candidate);
    try {
      sealed.exec(`
        DELETE FROM context_packs;
        DELETE FROM query_runs;
        DELETE FROM runtime_schema_snapshots;
        DELETE FROM runtime_schema_fts;
        DELETE FROM runtime_schema_objects;
        DELETE FROM runtime_value_fts;
        DELETE FROM runtime_value_index;
        VACUUM;
      `);
      sealed.pragma('journal_mode = DELETE');
    } finally {
      sealed.close();
    }
    renameSync(candidate, destination);
  }

  state(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM metadata_state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO metadata_state (key, value) VALUES (?, ?)').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

interface MetadataObjectRow {
  object_key: string;
  object_type: string;
  name: string;
  full_name: string | null;
  domain: string | null;
  owner: string | null;
  status: string | null;
  description: string | null;
  source_path: string | null;
  source_system: string | null;
  payload_json: string;
  updated_at: string;
  rank?: number;
  snip?: string | null;
}

interface MetadataEdgeRow {
  edge_type: string;
  from_key: string;
  to_key: string;
  confidence: number;
  payload_json: string;
}

interface QueryRunRow {
  id: string;
  object_key: string | null;
  source: string;
  status: string;
  row_count: number | null;
  duration_ms: number | null;
  error_code: string | null;
  payload_json: string;
  created_at: string;
}

interface RuntimeValueIndexRow {
  value_key: string;
  relation: string;
  schema_name: string | null;
  table_name: string | null;
  column_name: string;
  column_type: string | null;
  value: string;
  normalized_value: string;
  source: string | null;
  captured_at: string;
  rank?: number;
}

function strongestBm25Magnitude(rows: Array<{ rank?: number }>): number {
  return rows.reduce((strongest, row) => Math.max(strongest, bm25Magnitude(row.rank)), 0);
}

function bm25Magnitude(rank: number | undefined): number {
  return typeof rank === 'number' && Number.isFinite(rank) ? Math.max(0, -rank) : 0;
}

function normalizedBm25Score(rank: number | undefined, tier: 'and' | 'or', strongest: number): number {
  const relative = strongest > 0 ? bm25Magnitude(rank) / strongest : 0;
  const score = tier === 'and'
    ? 0.55 + relative * 0.45
    : 0.05 + relative * 0.45;
  return Number(score.toFixed(6));
}

function legacyQualifiedAlias(objectKey: string): { objectType: string; name: string } | undefined {
  const mappings: Array<[string, string]> = [
    ['semantic:entity:', 'dql_entity'],
    ['model_area:', 'model_area'],
    ['relationship:', 'relationship'],
    ['contract:', 'contract'],
    ['domain_export:', 'domain_export'],
    ['domain_import:', 'domain_import'],
    ['conformance:', 'conformance'],
    ['policy:', 'policy'],
    ['evaluation:', 'evaluation'],
  ];
  for (const [prefix, objectType] of mappings) {
    if (!objectKey.startsWith(prefix)) continue;
    const name = objectKey.slice(prefix.length);
    return name ? { objectType, name } : undefined;
  }
  return undefined;
}

function loadAgentManifest(projectRoot: string): DQLManifest {
  return buildManifest({
    projectRoot,
    dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined,
  });
}

function loadAgentSemanticLayer(projectRoot: string): SemanticLayer | undefined {
  try {
    const config = loadProjectConfig(projectRoot);
    const semanticConfig = config.semanticLayer?.provider
      ? (config.semanticLayer as Parameters<typeof resolveSemanticLayerWithDiagnostics>[0])
      : config.semanticLayer?.path
        ? { provider: 'dql' as const, path: config.semanticLayer.path }
        : undefined;
    const configured = resolveSemanticLayerWithDiagnostics(semanticConfig, projectRoot).layer;
    // An EMPTY configured layer (e.g. `provider: 'dql'` pointing at a folder
    // with no definitions — the scaffold default) must not shadow a real dbt
    // MetricFlow semantic layer: that starves the catalog of every
    // semantic_metric object and the governed-metric answer tier can never
    // fire. Mirror the runtime's resolveProjectSemanticConfig preference:
    // substance wins over configuration.
    if (configured && semanticLayerHasContent(configured)) return configured;

    if (config.dbt?.projectDir) {
      const dbtLayer = resolveSemanticLayerWithDiagnostics({
        provider: 'dbt',
        projectPath: config.dbt.projectDir,
      }, projectRoot).layer;
      if (dbtLayer && semanticLayerHasContent(dbtLayer)) return dbtLayer;
    }
    return configured ?? undefined;
  } catch {
    return undefined;
  }
  return undefined;
}

/** True when the layer defines ANY semantics — metrics, dimensions, or measures. */
function semanticLayerHasContent(layer: SemanticLayer): boolean {
  return layer.listMetrics().length > 0
    || layer.listDimensions().length > 0
    || layer.listMeasures().length > 0;
}

function manifestDiagnosticToMetadataDiagnostic(diagnostic: ManifestDiagnostic): MetadataDiagnostic {
  return {
    kind: diagnostic.kind,
    severity: diagnostic.severity,
    message: diagnostic.message,
    filePath: diagnostic.filePath,
  };
}

function objectFromKGNode(node: KGNode): MetadataObject {
  const qualifiedIdentity = qualifiedIdentityFromKGNode(node);
  const payload: Record<string, unknown> = {
    ...(node.payload ?? {}),
    kgNodeId: node.nodeId,
    tags: node.tags ?? [],
    examples: node.examples ?? [],
    // The dbt-derived domain, kept out of the indexed `domain` column so it can
    // never gate retrieval, but preserved for ranking and workspace grouping.
    sourceDomain: node.sourceDomain,
    sourceTier: node.sourceTier,
    certification: node.certification,
    provenance: node.provenance,
    freshness: node.freshness,
    businessOutcome: node.businessOutcome,
    businessOwner: node.businessOwner,
    decisionUse: node.decisionUse,
    reviewCadence: node.reviewCadence,
    pattern: node.pattern,
    grain: node.grain,
    entities: node.entities ?? node.payload?.entities ?? [],
    declaredOutputs: node.declaredOutputs ?? [],
    outputs: node.outputs ?? [],
    outputContract: node.outputContract ?? [],
    dimensions: node.dimensions ?? node.payload?.dimensions ?? [],
    allowedFilters: node.allowedFilters ?? [],
    parameterPolicy: node.parameterPolicy ?? [],
    parameters: node.parameters ?? [],
    filterBindings: node.filterBindings ?? [],
    sourceSystems: node.sourceSystems ?? [],
    replacementFor: node.replacementFor ?? [],
    sqlFingerprints: node.sqlFingerprints,
    businessFingerprint: node.businessFingerprint,
    datalexContract: node.datalexContract,
    boundedContext: node.boundedContext,
    primaryTerms: node.primaryTerms ?? [],
    businessRules: node.businessRules ?? [],
    caveats: node.caveats ?? [],
    llmContext: node.llmContext,
    label: kgContextField(node.llmContext, 'label'),
    metricType: kgContextField(node.llmContext, 'metric type'),
    aggregation: kgContextField(node.llmContext, 'aggregation'),
    table: kgContextField(node.llmContext, 'table'),
    formula: node.kind === 'metric' ? kgContextField(node.llmContext, 'sql') : undefined,
    semanticModel: ['metric', 'dimension', 'measure', 'entity'].includes(node.kind) && node.name.includes('.')
      ? node.name.split('.')[0]
      : undefined,
    referencedBy: node.referencedBy ?? [],
  };
  return {
    objectKey: objectKeyFromKGNode(node),
    objectType: objectTypeFromKGNode(node),
    name: node.name,
    fullName: qualifiedIdentity ?? node.name,
    domain: node.domain,
    owner: node.owner,
    status: node.status ?? node.certification,
    // CTX-008: a relationship's `llmContext` carries the facts that make it
    // usable — keys, cardinality, fanout — so falling back to it meant writing
    // a human description silently deleted all of them from the prompt. Keep
    // both for relationships: prose leads, facts follow. Every other node type
    // keeps the original fallback, where `llmContext` is only a longer restatement.
    description: node.kind === 'relationship'
      ? joinNodeDescription(node.description, node.llmContext)
      : node.description ?? node.llmContext,
    sourcePath: node.sourcePath,
    sourceSystem: node.provenance ?? node.sourceTier,
    payload: compactObject(payload),
  };
}

/** Prose first, then the machine facts, without repeating either. */
function joinNodeDescription(description?: string, llmContext?: string): string | undefined {
  const prose = description?.trim();
  const facts = llmContext?.trim();
  if (!prose) return facts || undefined;
  if (!facts || prose.includes(facts)) return prose;
  return `${prose} — ${facts}`;
}

function kgContextField(context: string | undefined, field: string): string | undefined {
  if (!context) return undefined;
  const prefix = `${field.toLowerCase()}:`;
  const line = context.split(/\r?\n/).find((candidate) => candidate.trim().toLowerCase().startsWith(prefix));
  return line?.trim().slice(prefix.length).trim() || undefined;
}

function objectKeyFromKGNode(node: KGNode): string {
  const qualifiedIdentity = qualifiedIdentityFromKGNode(node);
  if (qualifiedIdentity && isQualifiedDqlModelingNode(node)) {
    return `dql:${node.kind}:${qualifiedIdentity}`;
  }
  switch (node.kind) {
    case 'block': return `dql:block:${node.name}`;
    case 'term': return `dql:term:${node.nodeId.startsWith('term:') ? node.nodeId.slice('term:'.length) : node.name}`;
    case 'business_view': return `dql:business_view:${node.name}`;
    case 'metric': return `semantic:metric:${node.name}`;
    case 'dimension': return `semantic:dimension:${node.name}`;
    case 'measure': return `semantic:measure:${node.name}`;
    case 'entity': return `semantic:entity:${node.name}`;
    case 'semantic_model': return `semantic:model:${node.name}`;
    case 'saved_query': return `semantic:saved_query:${node.name}`;
    case 'dbt_model': return `dbt:model:${node.name}`;
    case 'dbt_source':
      return node.sourceTier === 'dbt_manifest'
        ? `dbt:source:${node.name}`
        : `warehouse:table:${node.name}`;
    case 'notebook': return `notebook:${node.name}`;
    case 'dashboard': return `dashboard:${node.name}`;
    case 'app': return `app:${node.name}`;
    case 'domain': return `domain:${node.name}`;
    default: return `${node.kind}:${node.name}`;
  }
}

function isQualifiedDqlModelingNode(node: KGNode): boolean {
  return node.sourceTier === 'business_context' && [
    'model_area',
    'entity',
    'relationship',
    'contract',
    'domain_export',
    'domain_import',
    'conformance',
    'policy',
    'evaluation',
  ].includes(node.kind);
}

function qualifiedIdentityFromKGNode(node: KGNode): string | undefined {
  const payload = node.payload ?? {};
  const registryIdentity = stringValue(payload.registryQualifiedId);
  if (registryIdentity) return registryIdentity;
  const explicit = stringValue(payload.qualifiedId);
  if (explicit) return explicit;
  if (!isQualifiedDqlModelingNode(node)) return undefined;
  const prefix = `${node.kind}:`;
  return node.nodeId.startsWith(prefix) ? node.nodeId.slice(prefix.length) : undefined;
}

function objectTypeFromKGNode(node: KGNode): string {
  switch (node.kind) {
    case 'block': return 'dql_block';
    case 'term': return 'dql_term';
    case 'business_view': return 'business_view';
    case 'metric': return 'semantic_metric';
    case 'dimension': return 'semantic_dimension';
    case 'measure': return 'semantic_measure';
    case 'entity': return isQualifiedDqlModelingNode(node) ? 'dql_entity' : 'semantic_entity';
    case 'semantic_model': return 'semantic_model';
    case 'saved_query': return 'semantic_saved_query';
    case 'dbt_model': return 'dbt_model';
    case 'dbt_source': return node.sourceTier === 'dbt_manifest' ? 'dbt_source' : 'warehouse_table';
    case 'notebook': return 'notebook';
    case 'dashboard': return 'dashboard';
    case 'app': return 'app';
    case 'domain': return 'domain';
    default: return node.kind;
  }
}

function normalizeEdge(edge: KGEdge, fromKey: string, toKey: string): MetadataEdge {
  return {
    edgeType: edge.kind,
    fromKey,
    toKey,
    confidence: edge.weight ?? 1,
    payload: { kgSource: edge.src, kgTarget: edge.dst },
  };
}

/**
 * Skills are source-owned context, not a prompt-only side channel. Persist their
 * parsed fields in the catalog snapshot so selection, provenance, and
 * fingerprinting all observe the same immutable project state.
 */
function addSkillObjects(
  skills: Skill[],
  objects: Map<string, MetadataObject>,
  edges: Map<string, MetadataEdge>,
): void {
  for (const skill of skills) {
    const identity = skill.qualifiedId ?? skill.id;
    const bodyHash = sha256(skill.body);
    const sourceFingerprint = sha256(
      stableStringify({
        identity,
        domain: skill.domain,
        domains: skill.domains ?? [],
        modelAreaRefs: skill.modelAreaRefs ?? [],
        status: skill.status ?? "active",
        analyticalPolicy: skill.analyticalPolicy,
        bodyHash,
      }),
    );
    const objectKey = `skill:${identity}`;
    const domains = uniqueNonBlank([skill.domain, ...(skill.domains ?? [])]);
    const object: MetadataObject = {
      objectKey,
      objectType: 'skill',
      name: skill.id,
      fullName: skill.qualifiedId ?? skill.id,
      domain: skill.domain,
      owner: skill.owner,
      status: skill.status ?? 'active',
      description: skill.description ?? compactSkillDescription(skill.body),
      sourcePath: skill.sourcePath,
      sourceSystem: 'DQL domain skill',
      payload: compactObject({
        skillId: skill.id,
        localId: skill.localId ?? skill.id,
        qualifiedId: skill.qualifiedId,
        scope: skill.scope,
        user: skill.user,
        domains,
        modelAreaRefs: skill.modelAreaRefs ?? [],
        kind: skill.kind,
        triggers: skill.triggers ?? [],
        exclusions: skill.exclusions ?? [],
        preferredMetrics: skill.preferredMetrics,
        preferredBlocks: skill.preferredBlocks,
        preferredDimensions: skill.preferredDimensions ?? [],
        requiredFilters: skill.requiredFilters ?? [],
        clarifyWhen: skill.clarifyWhen ?? [],
        examples: skill.examples ?? [],
        sourceRefs: skill.sourceRefs ?? [],
        vocabulary: skill.vocabulary,
        analyticalPolicy: skill.analyticalPolicy,
        bodyHash,
        sourceFingerprint,
        isStarter: skill.isStarter,
        provenance: 'DQL domain skill',
      }),
    };
    objects.set(objectKey, mergeObject(objects.get(objectKey), object));
    for (const domain of domains) {
      const edge: MetadataEdge = {
        edgeType: 'contains',
        fromKey: `domain:${domain}`,
        toKey: objectKey,
        confidence: 1,
        payload: { provenance: 'DQL domain skill' },
      };
      edges.set(`${edge.edgeType}\u0000${edge.fromKey}\u0000${edge.toKey}`, edge);
    }
  }
}

function compactSkillDescription(body: string): string | undefined {
  const normalized = body.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 480) : undefined;
}

function uniqueNonBlank(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function addDbtDagObjects(
  manifest: DQLManifest,
  objects: Map<string, MetadataObject>,
  edges: Map<string, MetadataEdge>,
  diagnostics: MetadataDiagnostic[],
): void {
  const models = manifest.dbtImport?.dbtDag?.models ?? [];
  for (const model of models) {
    const objectType = model.type === 'source' ? 'dbt_source' : 'dbt_model';
    const objectKey = `dbt:${model.type}:${model.name}`;
    const relation = [model.database, model.schema, model.name].filter(Boolean).join('.');
    const object: MetadataObject = {
      objectKey,
      objectType,
      name: model.name,
      fullName: relation || model.name,
      description: model.description,
      status: 'dbt_imported',
      sourceSystem: 'dbt manifest.json',
      payload: compactObject({
        uniqueId: model.uniqueId,
        relation,
        database: model.database,
        schema: model.schema,
        materialized: model.materialized,
        dependsOn: model.dependsOn,
        columns: model.columns ?? [],
        columnCompleteness: 'partial',
      }),
    };
    objects.set(objectKey, mergeObject(objects.get(objectKey), object));
    for (const column of model.columns ?? []) {
      const columnKey = `dbt:column:${model.name}.${column.name}`;
      objects.set(columnKey, mergeObject(objects.get(columnKey), {
        objectKey: columnKey,
        objectType: 'dbt_column',
        name: column.name,
        fullName: `${model.name}.${column.name}`,
        description: column.description,
        status: 'dbt_imported',
        sourceSystem: 'dbt manifest.json',
        payload: compactObject({
          model: model.name,
          uniqueId: model.uniqueId,
          type: column.type,
          relation,
          columnCompleteness: 'partial',
        }),
      }));
      const edge = {
        edgeType: 'contains',
        fromKey: objectKey,
        toKey: columnKey,
        confidence: 1,
        payload: { source: 'dbt manifest column' },
      };
      edges.set(`${edge.edgeType}\u0000${edge.fromKey}\u0000${edge.toKey}`, edge);
    }
    for (const dep of model.dependsOn ?? []) {
      const edge = {
        edgeType: 'depends_on',
        fromKey: objectKey,
        toKey: dbtDependencyKey(dep),
        confidence: 1,
        payload: { source: 'dbt manifest depends_on', uniqueId: dep },
      };
      edges.set(`${edge.edgeType}\u0000${edge.fromKey}\u0000${edge.toKey}`, edge);
    }
  }

  if (manifest.dbtImport && (manifest.dbtImport.totalDbtModels ?? 0) > 0 && manifest.dbtImport.modelsImported === 0) {
    diagnostics.push({
      kind: 'dbt',
      severity: 'warning',
      message: `dbt manifest loaded from ${manifest.dbtImport.manifestPath}, but 0 of ${manifest.dbtImport.totalDbtModels} models matched DQL table references. Check database/schema aliases or dbtImport anchors.`,
    });
  }
}

function addRawDbtManifestCatalogObjects(
  projectRoot: string,
  manifest: DQLManifest,
  objects: Map<string, MetadataObject>,
  edges: Map<string, MetadataEdge>,
  diagnostics: MetadataDiagnostic[],
): void {
  const manifestPath = manifest.dbtImport?.manifestPath ?? resolveDbtManifestPath(projectRoot);
  if (!manifestPath) return;
  let raw: {
    nodes?: Record<string, Record<string, unknown>>;
    sources?: Record<string, Record<string, unknown>>;
  };
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as typeof raw;
  } catch (error) {
    diagnostics.push({
      kind: 'dbt',
      severity: 'warning',
      message: `Could not read dbt manifest catalog metadata from ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath: manifestPath,
    });
    return;
  }

  const catalogColumns = loadRawDbtCatalogColumns(join(dirname(manifestPath), 'catalog.json'));
  const uniqueColumnsByModel = extractDbtUniqueColumns(raw.nodes ?? {});
  const entries: RawDbtCatalogEntry[] = [];
  // PERF-001: at enterprise scale, keep columns in their model payload and
  // load full node detail lazily from the immutable dbt artifact cache. A
  // separate FTS row + graph edge for every column makes a 300k-column project
  // consume gigabytes without improving the bounded model-first route.
  const rawEntries = [...Object.values(raw.nodes ?? {}), ...Object.values(raw.sources ?? {})];
  const totalColumnCount = rawEntries.reduce((sum, node) => {
    const columns = node.columns;
    return sum + (columns && typeof columns === 'object' && !Array.isArray(columns)
      ? Object.keys(columns as Record<string, unknown>).length
      : 0);
  }, 0);
  const includeColumnObjects = totalColumnCount <= 50_000;
  for (const [uniqueId, node] of Object.entries(raw.nodes ?? {})) {
    if (node.resource_type !== 'model') continue;
    const name = rawDbtName(node);
    if (!name) continue;
    const database = stringValue(node.database);
    const schema = stringValue(node.schema);
    const entry: RawDbtCatalogEntry = {
      uniqueId,
      name,
      node,
      objectKey: `dbt:model:${name}`,
      objectType: 'dbt_model',
      relation: stringValue(node.relation_name) ?? [database, schema, name].filter(Boolean).join('.'),
      database,
      schema,
      catalogColumns: catalogColumns.get(uniqueId),
      uniqueColumns: uniqueColumnsByModel.get(name),
    };
    entries.push(entry);
    addRawDbtCatalogObject({
      ...entry,
      objects,
      edges,
      includeColumnObjects,
    });
  }

  for (const [uniqueId, source] of Object.entries(raw.sources ?? {})) {
    const name = rawDbtName(source);
    if (!name) continue;
    const database = stringValue(source.database);
    const schema = stringValue(source.schema);
    const entry: RawDbtCatalogEntry = {
      uniqueId,
      name,
      node: source,
      objectKey: `dbt:source:${name}`,
      objectType: 'dbt_source',
      relation: stringValue(source.relation_name) ?? [database, schema, name].filter(Boolean).join('.'),
      database,
      schema,
      catalogColumns: catalogColumns.get(uniqueId),
    };
    entries.push(entry);
    addRawDbtCatalogObject({
      ...entry,
      objects,
      edges,
      includeColumnObjects,
    });
  }

  const relationLookup = buildRawDbtRelationLookup(entries);
  for (const entry of entries) {
    if (entry.objectType !== 'dbt_model') continue;
    addRawDbtCompiledColumnLineage(entry, relationLookup, objects, edges);
  }
}

function addRawDbtCatalogObject(input: RawDbtCatalogEntry & {
  objects: Map<string, MetadataObject>;
  edges: Map<string, MetadataEdge>;
  includeColumnObjects: boolean;
}): void {
  const existing = input.objects.get(input.objectKey);
  const database = input.database ?? stringValue(input.node.database);
  const schema = input.schema ?? stringValue(input.node.schema);
  const relation = input.relation || [database, schema, input.name].filter(Boolean).join('.');
  const columns = input.catalogColumns && input.catalogColumns.length > 0
    ? input.catalogColumns
    : rawDbtColumns(input.node.columns);
  const columnCompleteness = input.catalogColumns && input.catalogColumns.length > 0 ? 'complete' : 'partial';
  input.objects.set(input.objectKey, mergeObject(existing, {
    objectKey: input.objectKey,
    objectType: input.objectType,
    name: input.name,
    fullName: relation || input.name,
    description: stringValue(input.node.description),
    status: existing?.status ?? 'dbt_catalog',
    sourcePath: stringValue(input.node.original_file_path) ?? stringValue(input.node.path),
    sourceSystem: existing?.sourceSystem ?? 'dbt manifest.json catalog',
    payload: compactObject({
      ...(existing?.payload ?? {}),
      uniqueId: input.uniqueId,
      relation,
      database,
      schema,
      materialized: rawDbtMaterialization(input.node),
      dependsOn: rawDbtDependsOn(input.node),
      // dbt's checksum changes with the model/source definition. Persist it in
      // the governed object so Hint Graph dependency fingerprints detect SQL
      // edits even when relation names and columns stay the same.
      checksum: input.node.checksum,
      tags: metadataStringArray(input.node.tags),
      catalogOnly: existing ? undefined : true,
      columnCompleteness,
      columns,
      // W5.3 — single-column `unique` dbt tests become grain-ledger keys.
      uniqueColumns: input.uniqueColumns && input.uniqueColumns.length > 0 ? input.uniqueColumns : undefined,
    }),
  }));

  if (input.includeColumnObjects) for (const column of columns) {
    const columnKey = `dbt:column:${input.name}.${column.name}`;
    const existingColumn = input.objects.get(columnKey);
    input.objects.set(columnKey, mergeObject(existingColumn, {
      objectKey: columnKey,
      objectType: 'dbt_column',
      name: column.name,
      fullName: `${input.name}.${column.name}`,
      description: column.description,
      status: existingColumn?.status ?? 'dbt_catalog',
      sourcePath: stringValue(input.node.original_file_path) ?? stringValue(input.node.path),
      sourceSystem: existingColumn?.sourceSystem ?? 'dbt manifest.json catalog',
      payload: compactObject({
        ...(existingColumn?.payload ?? {}),
        model: input.name,
        uniqueId: input.uniqueId,
        type: column.type,
        relation,
        columnCompleteness: 'partial',
        catalogOnly: existingColumn ? undefined : true,
      }),
    }));
    putEdge(input.edges, {
      edgeType: 'contains',
      fromKey: input.objectKey,
      toKey: columnKey,
      confidence: 1,
      payload: { source: 'raw dbt manifest column catalog' },
    });
  }

  for (const dep of rawDbtDependsOn(input.node)) {
    putEdge(input.edges, {
      edgeType: 'depends_on',
      fromKey: input.objectKey,
      toKey: dbtDependencyKey(dep),
      confidence: 1,
      payload: { source: 'raw dbt manifest depends_on catalog', uniqueId: dep },
    });
  }
}

function addRawDbtCompiledColumnLineage(
  entry: RawDbtCatalogEntry,
  relationLookup: Map<string, Set<RawDbtCatalogEntry>>,
  objects: Map<string, MetadataObject>,
  edges: Map<string, MetadataEdge>,
): void {
  const sql = rawDbtCompiledSql(entry.node);
  if (!sql) return;
  const lineage = extractColumnLineage(sql);
  if (!lineage.parsed || lineage.columns.length === 0) return;

  for (const column of lineage.columns) {
    if (!column.name || column.name === '*' || column.name.endsWith('.*')) continue;
    const outputKey = ensureDbtLineageOutputColumnObject(entry, column, objects);
    for (const source of column.sources) {
      if (!source.column || source.column === '*') continue;
      const targetKey = ensureDbtLineageSourceColumnObject(source, relationLookup, objects);
      putEdge(edges, {
        edgeType: 'derives_from',
        fromKey: outputKey,
        toKey: targetKey,
        confidence: column.unresolved ? 0.55 : 0.88,
        payload: compactObject({
          source: 'dbt compiled SQL column lineage',
          model: entry.name,
          output: column.name,
          table: source.table,
          column: source.column,
          isAggregate: column.isAggregate,
          aggregateFn: column.aggregateFn,
        }),
      });
    }
  }
}

function ensureDbtLineageOutputColumnObject(
  entry: RawDbtCatalogEntry,
  column: ColumnLineageEntry,
  objects: Map<string, MetadataObject>,
): string {
  const columnKey = `dbt:column:${entry.name}.${column.name}`;
  const existing = objects.get(columnKey);
  objects.set(columnKey, mergeObject(existing, {
    objectKey: columnKey,
    objectType: 'dbt_column',
    name: column.name,
    fullName: `${entry.name}.${column.name}`,
    status: existing?.status ?? 'dbt_compiled_lineage',
    sourcePath: existing?.sourcePath ?? stringValue(entry.node.original_file_path) ?? stringValue(entry.node.path),
    sourceSystem: existing?.sourceSystem ?? 'dbt compiled SQL lineage',
    payload: compactObject({
      ...(existing?.payload ?? {}),
      model: entry.name,
      uniqueId: entry.uniqueId,
      relation: entry.relation,
      compiledSqlLineage: true,
      isAggregate: column.isAggregate,
      aggregateFn: column.aggregateFn,
      lineageSources: column.sources,
    }),
  }));
  return columnKey;
}

function ensureDbtLineageSourceColumnObject(
  source: ColumnSource,
  relationLookup: Map<string, Set<RawDbtCatalogEntry>>,
  objects: Map<string, MetadataObject>,
): string {
  const dbtSource = resolveRawDbtRelationForTable(source.table, relationLookup);
  if (dbtSource) {
    const columnKey = `dbt:column:${dbtSource.name}.${source.column}`;
    const existing = objects.get(columnKey);
    if (existing) return columnKey;
    objects.set(columnKey, {
      objectKey: columnKey,
      objectType: 'dbt_column',
      name: source.column,
      fullName: `${dbtSource.name}.${source.column}`,
      status: 'dbt_compiled_lineage',
      sourceSystem: 'dbt compiled SQL lineage',
      payload: compactObject({
        model: dbtSource.name,
        uniqueId: dbtSource.uniqueId,
        relation: dbtSource.relation,
        inferredFromCompiledSql: true,
      }),
    });
    return columnKey;
  }
  return ensureWarehouseLineageSourceColumnObject(source, objects, 'dbt compiled SQL lineage');
}

function buildRawDbtRelationLookup(entries: RawDbtCatalogEntry[]): Map<string, Set<RawDbtCatalogEntry>> {
  const lookup = new Map<string, Set<RawDbtCatalogEntry>>();
  const add = (key: string | undefined, entry: RawDbtCatalogEntry) => {
    if (!key) return;
    const normalized = normalizeRelationKey(key);
    if (!normalized) return;
    const existing = lookup.get(normalized);
    if (existing) existing.add(entry);
    else lookup.set(normalized, new Set([entry]));
  };
  for (const entry of entries) {
    add(entry.uniqueId, entry);
    add(entry.name, entry);
    add(entry.relation, entry);
    for (const key of dbtModelLookupKeys(entry.name, entry.schema, entry.database)) {
      add(key, entry);
    }
  }
  return lookup;
}

function resolveRawDbtRelationForTable(
  tableRef: string,
  relationLookup: Map<string, Set<RawDbtCatalogEntry>>,
): RawDbtCatalogEntry | undefined {
  for (const key of tableReferenceLookupKeys(tableRef)) {
    const matches = relationLookup.get(key);
    if (matches?.size === 1) return [...matches][0];
  }
  return undefined;
}

function rawDbtCompiledSql(node: Record<string, unknown>): string | undefined {
  return stringValue(node.compiled_code)
    ?? stringValue(node.compiled_sql);
}

function rawDbtName(node: Record<string, unknown>): string | undefined {
  return stringValue(node.alias) ?? stringValue(node.identifier) ?? stringValue(node.name);
}

function rawDbtMaterialization(node: Record<string, unknown>): string | undefined {
  const config = node.config && typeof node.config === 'object' ? node.config as Record<string, unknown> : null;
  return stringValue(config?.materialized);
}

function rawDbtDependsOn(node: Record<string, unknown>): string[] {
  const dependsOn = node.depends_on && typeof node.depends_on === 'object'
    ? node.depends_on as Record<string, unknown>
    : null;
  return metadataStringArray(dependsOn?.nodes);
}

function loadRawDbtCatalogColumns(catalogPath: string): Map<string, RuntimeSchemaColumn[]> {
  const out = new Map<string, RuntimeSchemaColumn[]>();
  let raw: { nodes?: Record<string, Record<string, unknown>>; sources?: Record<string, Record<string, unknown>> };
  try {
    raw = JSON.parse(readFileSync(catalogPath, 'utf-8')) as typeof raw;
  } catch {
    return out;
  }
  for (const entries of [raw.nodes ?? {}, raw.sources ?? {}]) {
    for (const [uniqueId, node] of Object.entries(entries)) {
      const columns = rawDbtCatalogColumns(node.columns);
      if (columns.length > 0) out.set(uniqueId, columns);
    }
  }
  return out;
}

function rawDbtCatalogColumns(value: unknown): RuntimeSchemaColumn[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const name = stringValue(record.name) ?? stringValue(record.column_name) ?? key;
    if (!name) return [];
    return [{
      name,
      type: stringValue(record.type) ?? stringValue(record.data_type),
      description: stringValue(record.comment) ?? stringValue(record.description),
    }];
  });
}

function rawDbtColumns(value: unknown): RuntimeSchemaColumn[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value as Record<string, unknown>).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const name = stringValue(record.name) ?? stringValue(record.column_name);
    if (!name) return [];
    return [{
      name,
      type: stringValue(record.data_type) ?? stringValue(record.type),
      description: stringValue(record.description),
    }];
  });
}

function addManifestBlockDetails(manifest: DQLManifest, objects: Map<string, MetadataObject>): void {
  for (const block of Object.values(manifest.blocks ?? {})) {
    const objectKey = `dql:block:${block.name}`;
    const existing = objects.get(objectKey);
    if (!existing) continue;
    const contractOutputNames = block.declaredOutputs
      ?? block.outputContract?.map((output) => output.name).filter(Boolean)
      ?? block.outputs?.map((output) => output.name).filter(Boolean);
    objects.set(objectKey, mergeObject(existing, {
      ...existing,
      payload: compactObject({
        ...(existing.payload ?? {}),
        sql: block.sql,
        tableDependencies: block.tableDependencies,
        rawTableRefs: block.rawTableRefs,
        refDependencies: block.refDependencies,
        metricRefs: block.metricRefs,
        dimensionRefs: block.dimensionRefs,
        declaredOutputs: block.declaredOutputs,
        outputs: block.outputs,
        outputContract: block.outputContract,
        dimensions: block.dimensions,
        chartType: block.chartType,
        blockType: block.blockType,
        tests: block.tests,
        parameterPolicy: block.parameterPolicy,
        parameters: block.parameters,
        filterBindings: block.filterBindings,
        sqlFingerprints: buildBlockSqlFingerprints(block.sql),
        businessFingerprint: buildBlockBusinessFingerprint({
          name: block.name,
          domain: block.domain,
          pattern: block.pattern,
          grain: block.grain,
          entities: block.entities,
          terms: block.termRefs,
          outputs: contractOutputNames,
          dimensions: block.dimensions,
          filters: block.allowedFilters,
          sources: [...(block.tableDependencies ?? []), ...(block.rawTableRefs ?? [])],
          sourceSystems: block.sourceSystems,
        }),
        draftMetadata: block.draftMetadata,
      }),
    }));
  }
}

/**
 * App Studio needs an inventory, not the legacy name-keyed execution
 * projection in `manifest.blocks`. Keep every executable declaration and give
 * it a path-qualified immutable identity. This object class is additive so Ask
 * AI's certified block routing continues to use `dql_block` unchanged.
 */
function addManifestBlockSourceObjects(
  projectRoot: string,
  manifest: DQLManifest,
  objects: Map<string, MetadataObject>,
): void {
  const declarations = manifest.blockDeclarations ?? Object.values(manifest.blocks ?? {});
  const datasetProofs = loadDatasetGrainProofs(projectRoot);
  const resultColumns = loadSavedQueryResultColumns(projectRoot);
  for (const block of declarations) {
    // A legacy semantic block has no SQL and is not an App source: semantic
    // Datasets are projected below from exact metric capability contracts.
    // Listing the block as well would add an App-only object to the shared
    // catalog index and shift Ask retrieval for every question.
    if (!block.sql?.trim() || !block.filePath) continue;
    // Migration rule: certified declarations remain available. Existing
    // hand-authored review/draft declarations have no generated provenance and
    // remain discoverable. Legacy Ask/research/generated drafts participate
    // only after an explicit Block Studio action stamps the reusable tag into
    // canonical DQL source. Names, folders, and prose are deliberately ignored.
    const explicitlyReusable = isExplicitlyReusableAppSource(block);
    if (block.status !== 'certified' && hasGeneratedAppSourceOrigin(block) && !explicitlyReusable) continue;
    const sourceRevision = manifestBlockSourceRevision(projectRoot, block);
    const domain = block.domain?.trim() || undefined;
    const pathIdentity = sha256(`${block.filePath}\u0000${block.name}`).slice(0, 20);
    const sourceKind = 'block';
    const sourceId = `app:${sourceKind}:${domain ?? 'global'}:${pathIdentity}`;
    const dataset = block.blockType === 'semantic'
      ? { proofState: 'not_a_dataset' as const }
      : datasetDescriptorFromManifestBlock({ block, sourceId, sourceRevision, proofs: datasetProofs });
    const lifecycle = dataset.descriptor?.lifecycle ?? normalizeBlockSourceLifecycle(block.status);
    // "Check and use" (design Q1): a row-level Dataset ZLens checked that
    // nobody certified yet carries its check record, while its source is the
    // one that was checked. It previews under "Only certified data"; it never
    // publishes until someone certifies it.
    const check = dataset.descriptor && lifecycle !== 'certified' && lifecycle !== 'deprecated'
      ? currentBlockFileCheck(projectRoot, block.filePath)
      : null;
    // A saved query (no Dataset definition) offers its result columns as
    // fields once their types are known (design D1). Its trust is its own.
    const resultDescriptor = dataset.descriptor || block.blockType === 'semantic'
      ? undefined
      : savedQueryResultDescriptorFromManifestBlock({
        block,
        sourceId,
        sourceRevision,
        lifecycle: lifecycle as NonNullable<typeof dataset.descriptor>['lifecycle'],
        observed: resultColumns.get(sourceId),
      });
    const outputs = block.declaredOutputs
      ?? block.outputContract?.map((output) => output.name).filter(Boolean)
      ?? block.outputs?.map((output) => output.name).filter(Boolean)
      ?? [];
    const measures = dataset.descriptor
      ? dataset.descriptor.fields.filter((field) => field.kind === 'measure').map((field) => field.name).sort()
      : Array.from(new Set([
      ...(block.metricRefs ?? []),
      ...(block.metricsRef ?? []),
      ...(block.metricRef ? [block.metricRef] : []),
      ...((block.outputContract ?? []).filter((output) => output.role === 'metric').map((output) => output.name)),
    ])).sort();
    const dimensions = dataset.descriptor
      ? dataset.descriptor.fields.filter((field) => field.kind === 'physical' && ['dimension', 'key', 'time', 'attribute'].includes(field.role)).map((field) => field.name).sort()
      : Array.from(new Set([
      ...(block.dimensions ?? []),
      ...(block.dimensionRefs ?? []),
      ...(block.dimensionsRef ?? []),
      ...((block.outputContract ?? []).filter((output) => output.role === 'dimension').map((output) => output.name)),
    ])).sort();
    const allowedVisualizations = Array.from(new Set([
      ...(block.displayHints?.allowedVisualizations ?? []),
      ...(block.displayHints?.defaultVisualization ? [block.displayHints.defaultVisualization] : []),
      ...(block.chartType ? [block.chartType] : []),
    ])).sort();
    objects.set(sourceId, {
      objectKey: sourceId,
      objectType: 'dql_block_source',
      name: block.name,
      fullName: `${domain ?? 'global'}::${sourceKind}::${block.name}`,
      domain,
      owner: block.owner,
      status: lifecycle,
      description: block.description,
      sourcePath: block.filePath,
      sourceSystem: 'dql',
      payload: compactObject({
        sourceId,
        qualifiedId: `${domain ?? 'global'}::${sourceKind}::${block.name}::${pathIdentity}`,
        kind: sourceKind,
        lifecycle,
        trust: dataset.descriptor?.trust ?? (lifecycle === 'certified' ? 'certified' : 'review_required'),
        executionRef: block.filePath,
        sourceRevision,
        fingerprint: sourceRevision,
        dataset: dataset.descriptor ?? resultDescriptor,
        datasetProofState: dataset.proofState,
        datasetProofReason: dataset.reason,
        tags: block.tags,
        blockType: block.blockType,
        chartType: block.chartType,
        allowedVisualizations,
        measures,
        dimensions,
        declaredOutputs: outputs,
        allowedFilters: block.allowedFilters,
        filterBindings: block.filterBindings,
        grain: block.grain,
        parameters: (block.parameters ?? []).map((parameter) => ({
          name: parameter.name,
          type: parameter.type,
          required: parameter.required,
          hasDefault: parameter.default !== undefined,
        })),
        dataState: block.dataState,
        dataStateDetail: block.dataStateDetail,
        check: check
          ? compactObject({
            by: check.checkedBy,
            name: check.checkedByName,
            at: check.checkedAt,
            checks: check.checks,
            hiddenColumns: check.hiddenColumns,
          })
          : undefined,
      }),
    });
  }
}

/**
 * Semantic datasets are not DQL blocks with a different label. They are a
 * narrow projection of the semantic layer's provider inventory and the exact,
 * immutable metric capability object produced for each metric. If either side
 * is ambiguous or incomplete we omit the dataset instead of guessing an
 * adapter field, aggregation, or relationship path.
 */
function addSemanticMetricDatasetSourceObjects(
  semanticLayer: SemanticLayer | undefined,
  objects: Map<string, MetadataObject>,
): void {
  if (!semanticLayer) return;
  const metricObjects = [...objects.values()].filter((object) => object.objectType === 'semantic_metric');
  const dimensionObjects = [...objects.values()].filter((object) => object.objectType === 'semantic_dimension');
  const modelsByName = new Map(semanticLayer.listSemanticModels().map((model) => [model.name, model]));
  // Index once, look up per object: a scan of every metric for every metric
  // object is quadratic and took minutes on a 10,000-metric catalog.
  const metricsByIdentity = new Map<string, Set<SemanticMetricListing>>();
  for (const metric of semanticLayer.listMetrics(undefined, { includeMeasures: false, includeVariants: true })) {
    for (const identity of semanticMetricIdentities(metric)) {
      const bucket = metricsByIdentity.get(identity) ?? new Set<SemanticMetricListing>();
      bucket.add(metric);
      metricsByIdentity.set(identity, bucket);
    }
  }
  const dimensionsByIdentity = indexMetadataObjectsByIdentity(dimensionObjects);
  const candidates: SemanticDatasetSourceCandidate[] = [];
  for (const metricObject of metricObjects) {
    const capability = normalizeMetricCapabilityContract(metricObject.payload?.analyticalCapability);
    if (!capability || !metricIdentityMatchesObject(capability.metricId, metricObject)) continue;
    const layerMetrics = new Set<SemanticMetricListing>();
    for (const identity of metadataObjectIdentities(metricObject)) {
      for (const metric of metricsByIdentity.get(identity) ?? []) layerMetrics.add(metric);
    }
    if (layerMetrics.size !== 1) continue;
    const metric = [...layerMetrics][0]!;
    const model = metric.cube ? modelsByName.get(metric.cube) : undefined;
    // A semantic metric without one exact model cannot be represented as a
    // field dataset. It remains available to Ask through its existing path.
    if (!model) continue;
    const fields = semanticDatasetFieldsForCapability(capability, dimensionsByIdentity);
    const domain = metricObject.domain ?? metric.domain;
    const lifecycle = semanticSourceLifecycle(metricObject);
    const semanticRoute = capability.executionCapabilities.find((route) => route.route === 'semantic');
    if (!semanticRoute) continue;
    const semanticModelId = capability.semanticModelId ?? `semantic:model:${model.name}`;
    candidates.push({
      metricObject,
      metric,
      modelName: model.name,
      semanticModelId,
      capability,
      fields,
      domain,
      lifecycle,
      adapterId: semanticRoute.adapterId,
    });
  }

  // A source is a semantic model projection, never one source per metric.
  // Lifecycle, native adapter, and primary result grain form the minimum safe
  // compatibility boundary.  A review-required metric therefore cannot ride
  // along with a certified metric into a publishable source.
  const groups = new Map<string, SemanticDatasetSourceCandidate[]>();
  for (const candidate of candidates) {
    const key = semanticDatasetGroupKey(candidate);
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  for (const group of groups.values()) {
    for (const compatible of splitCompatibleSemanticCandidates(group)) {
      addSemanticDatasetSourceObject(compatible, objects);
    }
  }
}

interface SemanticDatasetSourceCandidate {
  metricObject: MetadataObject;
  metric: { name: string; label?: string; domain?: string; displayFormat?: { kind: string; currency?: string; decimals?: number } };
  modelName: string;
  semanticModelId: string;
  capability: MetricCapabilityContract;
  fields: SemanticDatasetFieldProjection[];
  domain?: string;
  lifecycle: DatasetDescriptor['lifecycle'];
  adapterId?: string;
}

function semanticDatasetGroupKey(candidate: SemanticDatasetSourceCandidate): string {
  return [
    candidate.semanticModelId,
    candidate.domain ?? '',
    candidate.lifecycle,
    candidate.adapterId ?? '',
    candidate.capability.primaryEntityId,
    candidate.capability.defaultResultGrainId,
  ].join('\u0000');
}

/**
 * An ambiguous physical name must not be resolved by discovery order. Split a
 * model into the smallest compatible projections instead; each still uses the
 * canonical model identity and retains all of its selected metric contracts.
 */
function splitCompatibleSemanticCandidates(
  candidates: SemanticDatasetSourceCandidate[],
): SemanticDatasetSourceCandidate[][] {
  const sorted = [...candidates].sort((left, right) => left.capability.metricId.localeCompare(right.capability.metricId));
  // Every member of a group agrees on each field name it has, so the first
  // field seen per name stands for the whole group. Checking a candidate
  // against that merged map is the same test as checking it against every
  // member, without the quadratic cost.
  const groups: Array<{ members: SemanticDatasetSourceCandidate[]; fields: SemanticDatasetFieldProjection[] }> = [];
  for (const candidate of sorted) {
    const compatible = groups.find((group) => semanticFieldsCompatible(group.fields, candidate.fields));
    if (compatible) {
      compatible.members.push(candidate);
      const known = new Set(compatible.fields.map((field) => field.name.trim().toLowerCase()));
      for (const field of candidate.fields) if (!known.has(field.name.trim().toLowerCase())) compatible.fields.push(field);
    } else {
      groups.push({ members: [candidate], fields: [...candidate.fields] });
    }
  }
  return groups.map((group) => group.members);
}

function semanticFieldsCompatible(
  left: SemanticDatasetFieldProjection[],
  right: SemanticDatasetFieldProjection[],
): boolean {
  const byName = new Map(left.map((field) => [field.name.trim().toLowerCase(), field]));
  return right.every((field) => {
    const existing = byName.get(field.name.trim().toLowerCase());
    return !existing || (existing.qualifiedId === field.qualifiedId
      && existing.semanticReference === field.semanticReference
      && existing.type === field.type
      && existing.role === field.role
      && sameSemanticDatasetTimeContract(existing.time, field.time));
  });
}

function sameSemanticDatasetTimeContract(
  left: SemanticDatasetFieldProjection['time'],
  right: SemanticDatasetFieldProjection['time'],
): boolean {
  const leftGrains = [...(left?.grains ?? [])].sort();
  const rightGrains = [...(right?.grains ?? [])].sort();
  return left?.primary === right?.primary
    && leftGrains.length === rightGrains.length
    && leftGrains.every((grain, index) => grain === rightGrains[index]);
}

/**
 * A semantic Dataset source is an App Studio projection of metrics Ask already
 * retrieves as `semantic_metric`. Admitting the projection to Ask evidence
 * would duplicate those metrics and, because it spans a model rather than a
 * Domain, make an otherwise unambiguous Domain briefing ambiguous.
 */
export function isAppOnlySemanticDatasetSource(object: Pick<MetadataObject, 'objectType' | 'payload'>): boolean {
  return object.objectType === 'dql_block_source' && object.payload?.kind === 'semantic';
}

function addSemanticDatasetSourceObject(
  candidates: SemanticDatasetSourceCandidate[],
  objects: Map<string, MetadataObject>,
): void {
  const first = candidates[0];
  if (!first) return;
  const projectionFingerprint = sha256(stableStringify(candidates.map((candidate) => ({
    metricId: candidate.capability.metricId,
    metricName: candidate.metric.name,
    displayFormat: candidate.metric.displayFormat,
    sourceFingerprint: candidate.capability.sourceFingerprint,
    fields: candidate.fields,
  })).sort((left, right) => left.metricId.localeCompare(right.metricId))));
  const sourceRevision = `sha256:${projectionFingerprint}`;
  const sourceIdentity = [
    first.semanticModelId,
    first.domain ?? '',
    first.lifecycle,
    first.adapterId ?? '',
    first.capability.primaryEntityId,
    first.capability.defaultResultGrainId,
    // A compatible field namespace is part of the persistent source identity.
    stableStringify(candidates.flatMap((candidate) => candidate.fields).map((field) => ({
      name: field.name,
      qualifiedId: field.qualifiedId,
      type: field.type,
      role: field.role,
    })).sort((left, right) => left.name.localeCompare(right.name))),
  ].join('\u0000');
  const sourceId = `app:semantic:${first.domain ?? 'global'}:${sha256(sourceIdentity).slice(0, 20)}`;
  const measures: SemanticDatasetMeasureProjection[] = candidates.map((candidate) => ({
    measureName: candidate.metric.name,
    // The model name came from the same exact provider object that supplied
    // this metric capability. It prevents a same-named metric on a different
    // semantic model from being selected by a global bare-name lookup.
    semanticReference: `${candidate.modelName}.${candidate.metric.name}`,
    format: datasetFormatForSemanticMetric(candidate.metric.displayFormat),
    capability: candidate.capability,
    fields: candidate.fields,
  }));
  const dataset = datasetDescriptorFromSemanticMetrics({
    sourceId,
    sourceRevision,
    semanticModelId: first.semanticModelId,
    label: first.modelName,
    domain: first.domain,
    lifecycle: first.lifecycle,
    measures,
  });
  if (!dataset.descriptor) return;
  const descriptor = dataset.descriptor;
  const dimensions = descriptor.fields
    .filter((field) => field.kind === 'physical')
    .map((field) => field.name)
    .sort();
  const measureNames = descriptor.fields
    .filter((field) => field.kind === 'measure')
    .map((field) => field.name)
    .sort();
  const metricCapabilities = Object.fromEntries(candidates.map((candidate) => [candidate.metric.name, candidate.capability]));
  const metricCapabilitiesById = Object.fromEntries(candidates.map((candidate) => [candidate.capability.metricId, candidate.capability]));
  const tags = Array.from(new Set(candidates.flatMap((candidate) => stringArrayFromPayload(candidate.metricObject.payload?.tags)))).sort();
  const owner = candidates.every((candidate) => candidate.metricObject.owner === first.metricObject.owner)
    ? first.metricObject.owner
    : undefined;
  objects.set(sourceId, {
      objectKey: sourceId,
      objectType: 'dql_block_source',
      name: descriptor.label,
      fullName: `${first.domain ?? 'global'}::semantic::${first.semanticModelId}`,
      domain: first.domain,
      owner,
      status: first.lifecycle,
      description: first.metricObject.description,
      sourcePath: `semantic:${first.semanticModelId}`,
      sourceSystem: first.metricObject.sourceSystem ?? 'semantic layer',
      payload: compactObject({
        sourceId,
        qualifiedId: first.semanticModelId,
        kind: 'semantic',
        lifecycle: first.lifecycle,
        trust: descriptor.trust,
        executionRef: first.semanticModelId,
        sourceRevision,
        fingerprint: sourceRevision,
        semanticModel: first.modelName,
        semanticModelId: first.semanticModelId,
        semanticMetricNames: measureNames,
        metricCapabilities,
        metricCapabilitiesById,
        dataset: descriptor,
        datasetProofState: dataset.proofState,
        datasetProofReason: 'connect_source',
        tags,
        blockType: 'semantic',
        measures: measureNames,
        dimensions,
        declaredOutputs: [...dimensions, ...measureNames],
        allowedFilters: descriptor.operations.includes('filter') ? dimensions : [],
        allowedVisualizations: [],
        parameters: [],
      }),
  });
}

/** DQL semantic providers may declare richer display kinds; Dataset M1 carries the safely renderable subset. */
function datasetFormatForSemanticMetric(
  value: { kind: string; currency?: string; decimals?: number } | undefined,
): import('@zlens/core').DatasetMeasureField['format'] | undefined {
  if (!value || !['number', 'currency', 'percent'].includes(value.kind)) return undefined;
  return {
    kind: value.kind as 'number' | 'currency' | 'percent',
    ...(typeof value.currency === 'string' && value.currency.trim() ? { currency: value.currency.trim().toUpperCase() } : {}),
    ...(typeof value.decimals === 'number' && Number.isInteger(value.decimals) && value.decimals >= 0 && value.decimals <= 6
      ? { decimals: value.decimals }
      : {}),
  };
}

function semanticDatasetFieldsForCapability(
  capability: MetricCapabilityContract,
  dimensionsByIdentity: ReadonlyMap<string, MetadataObject[]>,
): SemanticDatasetFieldProjection[] {
  const fields: SemanticDatasetFieldProjection[] = [];
  const seenNames = new Set<string>();
  const timeById = new Map(capability.timeDimensions.map((dimension) => [dimension.dimensionId, dimension]));
  const dimensionsById = new Map(capability.dimensions.map((dimension) => [dimension.dimensionId, dimension]));
  const dimensions = [
    ...capability.dimensions.map((dimension) => ({ id: dimension.dimensionId, time: undefined })),
    ...capability.timeDimensions.map((dimension) => ({ id: dimension.dimensionId, time: dimension })),
  ];
  for (const required of dimensions) {
    const matches = dimensionsByIdentity.get(required.id.trim().toLowerCase()) ?? [];
    if (matches.length !== 1) continue;
    const object = matches[0]!;
    const payload = object.payload ?? {};
    const name = stringValue(payload.localId) ?? object.name.split('.').at(-1)?.trim();
    if (!name || seenNames.has(name.toLowerCase())) continue;
    const time = timeById.get(required.id);
    const type = semanticDatasetFieldType(payload.dimensionType, Boolean(time));
    if (!type) continue;
    // This is the explicit bridge between the immutable catalog identity and
    // the provider-native member syntax. Do not derive it by trimming a
    // qualified ID: a cross-model capability can require an entity path that
    // the final segment cannot represent.
    const semanticReference = time
      ? stringValue(payload.localId)
      : dimensionsById.get(required.id)?.nativeGroupingReference ?? stringValue(payload.localId);
    if (!semanticReference) continue;
    seenNames.add(name.toLowerCase());
    fields.push({
      name,
      qualifiedId: required.id,
      semanticReference,
      type,
      role: time ? 'time' : 'dimension',
      status: 'approved',
      ...(time ? { time: { grains: [...time.supportedGrains] } } : {}),
    });
  }
  return fields.sort((left, right) => left.name.localeCompare(right.name));
}

function metadataObjectMatchesSemanticMetric(
  object: MetadataObject,
  metric: { name: string; cube?: string; source?: { objectId?: string } },
): boolean {
  const candidates = [metric.name, metric.cube ? `${metric.cube}.${metric.name}` : undefined, metric.source?.objectId]
    .filter((value): value is string => Boolean(value?.trim()));
  return candidates.some((candidate) => metricIdentityMatchesObject(candidate, object));
}

type SemanticMetricListing = ReturnType<SemanticLayer['listMetrics']>[number];

/** Lower-cased identities a semantic layer metric answers to (see metadataObjectMatchesSemanticMetric). */
function semanticMetricIdentities(metric: SemanticMetricListing): string[] {
  return [metric.name, metric.cube ? `${metric.cube}.${metric.name}` : undefined, metric.source?.objectId]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
}

/** Lower-cased identities a catalog object answers to (see metricIdentityMatchesObject). */
function metadataObjectIdentities(object: MetadataObject): string[] {
  const payload = object.payload ?? {};
  return [
    object.objectKey,
    object.fullName,
    object.name,
    stringValue(payload.qualifiedId),
    stringValue(payload.registryQualifiedId),
    stringValue(payload.registryReference),
    stringValue(payload.sourceNativeId),
    stringValue(payload.localId),
    ...stringArrayFromPayload(payload.aliases),
  ].map((value) => value?.trim().toLowerCase()).filter((value): value is string => Boolean(value));
}

function indexMetadataObjectsByIdentity(objects: MetadataObject[]): Map<string, MetadataObject[]> {
  const index = new Map<string, MetadataObject[]>();
  for (const object of objects) {
    for (const identity of new Set(metadataObjectIdentities(object))) {
      const bucket = index.get(identity);
      if (bucket) bucket.push(object);
      else index.set(identity, [object]);
    }
  }
  return index;
}

function metricIdentityMatchesObject(identity: string, object: MetadataObject): boolean {
  const target = identity.trim().toLowerCase();
  if (!target) return false;
  const payload = object.payload ?? {};
  const candidates = [
    object.objectKey,
    object.fullName,
    object.name,
    stringValue(payload.qualifiedId),
    stringValue(payload.registryQualifiedId),
    stringValue(payload.registryReference),
    stringValue(payload.sourceNativeId),
    stringValue(payload.localId),
    ...stringArrayFromPayload(payload.aliases),
  ];
  return candidates.some((candidate) => candidate?.trim().toLowerCase() === target);
}

function semanticDatasetFieldType(value: unknown, time: boolean): SemanticDatasetFieldProjection['type'] | undefined {
  if (value === 'string' || value === 'number' || value === 'boolean' || value === 'date' || value === 'timestamp') return value;
  return time ? 'timestamp' : undefined;
}

function semanticSourceLifecycle(object: MetadataObject): DatasetDescriptor['lifecycle'] {
  const status = stringValue(object.status) ?? stringValue(object.payload?.certification);
  if (status === 'certified') return 'certified';
  if (status === 'review' || status === 'review_required') return 'review';
  if (status === 'pending_recertification') return 'pending_recertification';
  if (status === 'deprecated') return 'deprecated';
  if (status === 'draft') return 'draft';
  return 'unknown';
}

function stringArrayFromPayload(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())
    : [];
}

function normalizeBlockSourceLifecycle(status: string | undefined): string {
  const normalized = status?.trim().toLowerCase();
  if (normalized === 'certified') return 'certified';
  if (normalized === 'review' || normalized === 'review_required') return 'review';
  if (normalized === 'pending_recertification') return 'pending_recertification';
  if (normalized === 'deprecated') return 'deprecated';
  return 'draft';
}

function manifestBlockSourceRevision(projectRoot: string, block: ManifestBlock): string {
  const path = join(projectRoot, block.filePath);
  try {
    if (existsSync(path)) return `sha256:${sha256(readFileSync(path, 'utf8'))}`;
  } catch {
    // The manifest object remains enough for a deterministic snapshot identity.
  }
  return `sha256:${sha256(stableStringify(block))}`;
}

function addDataLexManifestObjects(
  projectRoot: string,
  manifest: DQLManifest,
  objects: Map<string, MetadataObject>,
  edges: Map<string, MetadataEdge>,
  diagnostics: MetadataDiagnostic[],
): void {
  const manifestPath = resolveDataLexManifestPath(projectRoot);
  if (!manifestPath) return;

  let raw: DataLexManifest;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as DataLexManifest;
  } catch (error) {
    diagnostics.push({
      kind: 'datalex',
      severity: 'warning',
      message: `Could not read DataLex manifest context from ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath: manifestPath,
    });
    return;
  }
  if (!Array.isArray(raw.domains)) {
    diagnostics.push({
      kind: 'datalex',
      severity: 'warning',
      message: `DataLex manifest at ${manifestPath} does not contain a domains array.`,
      filePath: manifestPath,
    });
    return;
  }

  const latestContractKeyById = new Map<string, string>();
  const contractKeyByVersionedRef = new Map<string, string>();
  // entity (by name and domain.entity) -> physical binding ref, so relationships
  // can be resolved to concrete relations for grain-safe join hints.
  const entityBindingRef = new Map<string, string>();
  for (const domain of raw.domains) {
    if (!domain?.name) continue;
    const domainKey = `datalex:domain:${domain.name}`;
    objects.set(domainKey, mergeObject(objects.get(domainKey), {
      objectKey: domainKey,
      objectType: 'datalex_domain',
      name: domain.name,
      fullName: domain.name,
      domain: domain.name,
      owner: domain.owners?.[0],
      status: 'contract_evidence',
      description: domain.description,
      sourcePath: manifestPath,
      sourceSystem: 'DataLex manifest',
      payload: compactObject({
        project: raw.project?.name,
        owners: domain.owners ?? [],
        tags: [],
        generatedAt: raw.generatedAt,
      }),
    }));

    for (const term of domain.glossary ?? []) {
      if (!term?.term) continue;
      const termKey = `datalex:term:${domain.name}.${term.term}`;
      objects.set(termKey, mergeObject(objects.get(termKey), {
        objectKey: termKey,
        objectType: 'datalex_term',
        name: term.term,
        fullName: `${domain.name}.${term.term}`,
        domain: domain.name,
        status: 'contract_evidence',
        description: term.definition,
        sourcePath: manifestPath,
        sourceSystem: 'DataLex manifest',
        payload: compactObject({
          tags: term.tags ?? [],
          relatedFields: term.related_fields ?? [],
        }),
      }));
      putEdge(edges, {
        edgeType: 'contains',
        fromKey: domainKey,
        toKey: termKey,
        confidence: 1,
        payload: { source: 'datalex manifest glossary' },
      });
    }

    for (const entity of domain.entities ?? []) {
      if (!entity?.name) continue;
      const entityKey = `datalex:entity:${domain.name}.${entity.name}`;
      if (entity.binding?.ref) {
        const boundKey = objectKeyForDataLexBinding(entity.binding);
        entityBindingRef.set(entity.name.toLowerCase(), boundKey);
        entityBindingRef.set(`${domain.name}.${entity.name}`.toLowerCase(), boundKey);
      }
      objects.set(entityKey, mergeObject(objects.get(entityKey), {
        objectKey: entityKey,
        objectType: 'datalex_entity',
        name: entity.name,
        fullName: `${domain.name}.${entity.name}`,
        domain: domain.name,
        status: 'contract_evidence',
        description: entity.description,
        sourcePath: manifestPath,
        sourceSystem: 'DataLex manifest',
        payload: compactObject({
          tags: entity.tags ?? [],
          binding: entity.binding,
          // Entity-level grain + keys (W5.2) feed the grain ledger for fan-out safety.
          grain: entity.grain,
          candidateKeys: entity.candidate_keys,
          businessKeys: entity.business_keys,
          fields: (entity.fields ?? []).slice(0, 100).map((field) => compactObject({
            name: field.name,
            type: field.type,
            description: field.description,
            primaryKey: field.primary_key,
            classification: field.classification,
            tags: field.tags ?? [],
          })),
        }),
      }));
      putEdge(edges, {
        edgeType: 'contains',
        fromKey: domainKey,
        toKey: entityKey,
        confidence: 1,
        payload: { source: 'datalex manifest entity' },
      });

      for (const contract of entity.contracts ?? []) {
        if (!contract?.id) continue;
        const version = Number(contract.version);
        if (!Number.isFinite(version)) continue;
        const contractKey = `datalex:contract:${contract.id}@${version}`;
        contractKeyByVersionedRef.set(`${contract.id}@${version}`, contractKey);
        const latest = latestContractKeyById.get(contract.id);
        if (!latest || Number(latest.split('@').at(-1) ?? 0) < version) {
          latestContractKeyById.set(contract.id, contractKey);
        }
        objects.set(contractKey, mergeObject(objects.get(contractKey), {
          objectKey: contractKey,
          objectType: 'datalex_contract',
          name: contract.name || contract.id,
          fullName: `${contract.id}@${contract.version}`,
          domain: domain.name,
          owner: contract.owner ?? domain.owners?.[0],
          status: 'contract_evidence',
          description: contract.description,
          sourcePath: manifestPath,
          sourceSystem: 'DataLex manifest',
          payload: compactObject({
            contractId: contract.id,
            version,
            entity: entity.name,
            tags: contract.tags ?? [],
            signature: contract.signature,
          }),
        }));
        putEdge(edges, {
          edgeType: 'contains',
          fromKey: entityKey,
          toKey: contractKey,
          confidence: 1,
          payload: { source: 'datalex manifest contract' },
        });
      }
    }
  }

  // Typed cross-entity relationships → grain-safe join edges between the entities'
  // physical relations. buildSelectedJoinPaths turns these into `datalex`-sourced
  // join paths that outrank name-heuristic guesses.
  const resolveEntityRef = (endpoint: { domain?: string; entity: string }): string | undefined =>
    entityBindingRef.get(`${endpoint.domain ?? ''}.${endpoint.entity}`.toLowerCase())
    ?? entityBindingRef.get(endpoint.entity.toLowerCase());
  for (const relationship of raw.relationships ?? []) {
    if (!relationship?.from?.entity || !relationship?.to?.entity) continue;
    const fromRef = resolveEntityRef(relationship.from);
    const toRef = resolveEntityRef(relationship.to);
    if (!fromRef || !toRef || fromRef.toLowerCase() === toRef.toLowerCase()) continue;
    putEdge(edges, {
      edgeType: 'datalex_join',
      fromKey: fromRef,
      toKey: toRef,
      confidence: relationship.identifying ? 0.97 : 0.9,
      payload: compactObject({
        source: 'datalex relationship',
        name: relationship.name,
        fromColumn: relationship.from.column,
        toColumn: relationship.to.column,
        cardinality: relationship.cardinality,
        verb: relationship.verb,
      }),
    });
  }

  // Concept-to-physical conformance (W5.1) → searchable `datalex_concept` nodes
  // carrying the canonical key + the physical relations that realize the concept,
  // plus `datalex_conforms` edges so retrieval can collapse several physical tables
  // into one business concept ("Customer" → dim_customer, stg_customers) and reason
  // at the concept grain. Modeling metadata only — no certification coupling.
  for (const conformance of raw.conformance ?? []) {
    if (!conformance?.concept) continue;
    const conceptDomain = conformance.domain ?? '';
    const conceptKey = `datalex:concept:${conceptDomain}.${conformance.concept}`;
    const physicalRefs = (conformance.physical ?? [])
      .map((physical) => (physical.binding ? objectKeyForDataLexBinding(physical.binding) : undefined))
      .filter((key): key is string => Boolean(key));
    const canonicalKey = conformance.canonical_key ?? [];
    objects.set(conceptKey, mergeObject(objects.get(conceptKey), {
      objectKey: conceptKey,
      objectType: 'datalex_concept',
      name: conformance.concept,
      fullName: `${conceptDomain}.${conformance.concept}`,
      domain: conceptDomain || undefined,
      status: 'contract_evidence',
      description: `Business concept ${conformance.concept}`
        + (canonicalKey.length ? ` (canonical key: ${canonicalKey.join(', ')})` : '')
        + (physicalRefs.length ? `, realized by ${physicalRefs.length} physical relation(s).` : '.'),
      sourcePath: manifestPath,
      sourceSystem: 'DataLex manifest',
      payload: compactObject({
        canonicalKey,
        businessKey: conformance.business_key ?? [],
        implements: conformance.implements ?? [],
        physicalRefs,
      }),
    }));
    if (conceptDomain) {
      putEdge(edges, {
        edgeType: 'contains',
        fromKey: `datalex:domain:${conceptDomain}`,
        toKey: conceptKey,
        confidence: 1,
        payload: { source: 'datalex conformance' },
      });
    }
    for (const ref of physicalRefs) {
      putEdge(edges, {
        edgeType: 'datalex_conforms',
        fromKey: conceptKey,
        toKey: ref,
        confidence: 0.95,
        payload: compactObject({ source: 'datalex conformance', concept: conformance.concept, canonicalKey }),
      });
    }
  }

  for (const block of Object.values(manifest.blocks ?? {})) {
    if (!block.datalexContract) continue;
    const parsed = parseContractRef(block.datalexContract);
    if (!parsed.ok || !parsed.id) continue;
    const contractKey = parsed.version
      ? contractKeyByVersionedRef.get(`${parsed.id}@${parsed.version}`)
      : latestContractKeyById.get(parsed.id);
    if (!contractKey) continue;
    putEdge(edges, {
      edgeType: 'resolves_contract',
      fromKey: `dql:block:${block.name}`,
      toKey: contractKey,
      confidence: 1,
      payload: {
        source: 'dql datalex_contract',
        reference: block.datalexContract,
      },
    });
  }
}

function addBlockDependencyEdges(manifest: DQLManifest, edges: Map<string, MetadataEdge>): void {
  const dbtLookup = buildDbtModelLookup(manifest);
  for (const block of Object.values(manifest.blocks ?? {})) {
    const blockKey = `dql:block:${block.name}`;
    for (const table of block.tableDependencies ?? []) {
      const tableKey = `warehouse:table:${table}`;
      putEdge(edges, {
        edgeType: 'uses_table',
        fromKey: blockKey,
        toKey: tableKey,
        confidence: 1,
        payload: { source: 'dql block table dependency', tableReference: table },
      });

      const dbtKey = resolveDbtModelKeyForTable(table, dbtLookup);
      if (!dbtKey) continue;
      putEdge(edges, {
        edgeType: 'uses_dbt_model',
        fromKey: blockKey,
        toKey: dbtKey,
        confidence: 0.86,
        payload: { source: 'dql table dependency matched to dbt model', tableReference: table },
      });
      putEdge(edges, {
        edgeType: 'maps_to_dbt_model',
        fromKey: tableKey,
        toKey: dbtKey,
        confidence: 0.86,
        payload: { source: 'warehouse table name matched to dbt model', tableReference: table },
      });
    }
  }
}

function addBlockOutputLineageObjects(
  manifest: DQLManifest,
  objects: Map<string, MetadataObject>,
  edges: Map<string, MetadataEdge>,
): void {
  const dbtLookup = buildDbtModelLookup(manifest);
  for (const block of Object.values(manifest.blocks ?? {})) {
    if (!isCertifiedManifestBlock(block)) continue;
    if (!Array.isArray(block.outputs) || block.outputs.length === 0) continue;
    const blockKey = `dql:block:${block.name}`;
    for (const output of block.outputs) {
      const outputName = typeof output.name === 'string' ? output.name.trim() : '';
      if (!outputName) continue;
      const outputKey = blockOutputObjectKey(block.name, outputName);
      objects.set(outputKey, mergeObject(objects.get(outputKey), {
        objectKey: outputKey,
        objectType: 'dql_block_output',
        name: outputName,
        fullName: `${block.name}.${outputName}`,
        domain: block.domain,
        owner: block.owner,
        status: block.status,
        description: `${outputName} output column from DQL block ${block.name}.`,
        sourcePath: block.filePath,
        sourceSystem: 'DQL block column lineage',
        payload: compactObject({
          block: block.name,
          output: outputName,
          isAggregate: output.isAggregate,
          aggregateFn: output.aggregateFn,
          unresolved: output.unresolved,
          sources: output.sources ?? [],
        }),
      }));
      putEdge(edges, {
        edgeType: 'contains',
        fromKey: blockKey,
        toKey: outputKey,
        confidence: 1,
        payload: { source: 'dql block output lineage', output: outputName },
      });
      for (const source of output.sources ?? []) {
        const targetKey = ensureLineageSourceColumnObject(source, dbtLookup, objects);
        putEdge(edges, {
          edgeType: 'derives_from',
          fromKey: outputKey,
          toKey: targetKey,
          confidence: output.unresolved ? 0.55 : 0.92,
          payload: {
            source: 'dql block output column lineage',
            block: block.name,
            output: outputName,
            table: source.table,
            column: source.column,
            aggregateFn: output.aggregateFn,
          },
        });
      }
    }
  }
}

function isCertifiedManifestBlock(block: DQLManifest['blocks'][string]): boolean {
  return block.status === 'certified'
    || block.status === 'approved';
}

function ensureLineageSourceColumnObject(
  source: { table: string; column: string },
  dbtLookup: Map<string, Set<string>>,
  objects: Map<string, MetadataObject>,
): string {
  const dbtModelKey = resolveDbtModelKeyForTable(source.table, dbtLookup);
  if (dbtModelKey) {
    const modelName = dbtModelKey.split(':').at(-1) ?? source.table;
    const columnKey = `dbt:column:${modelName}.${source.column}`;
    if (objects.has(columnKey)) return columnKey;
  }

  return ensureWarehouseLineageSourceColumnObject(source, objects, 'DQL block column lineage');
}

function ensureWarehouseLineageSourceColumnObject(
  source: { table: string; column: string },
  objects: Map<string, MetadataObject>,
  sourceSystem: string,
): string {
  const tableKey = `warehouse:table:${source.table}`;
  if (!objects.has(tableKey)) {
    objects.set(tableKey, {
      objectKey: tableKey,
      objectType: 'warehouse_table',
      name: source.table.split('.').at(-1) ?? source.table,
      fullName: source.table,
      status: 'referenced',
      sourceSystem,
      payload: compactObject({ relation: source.table }),
    });
  }

  const columnKey = `warehouse:column:${source.table}.${source.column}`;
  objects.set(columnKey, mergeObject(objects.get(columnKey), {
    objectKey: columnKey,
    objectType: 'warehouse_column',
    name: source.column,
    fullName: `${source.table}.${source.column}`,
    status: 'referenced',
    sourceSystem,
    payload: compactObject({
      relation: source.table,
      table: source.table,
      column: source.column,
    }),
  }));
  return columnKey;
}

function blockOutputObjectKey(blockName: string, outputName: string): string {
  return `dql:block_output:${blockName}.${outputName}`;
}

function putEdge(edges: Map<string, MetadataEdge>, edge: MetadataEdge): void {
  edges.set(`${edge.edgeType}\u0000${edge.fromKey}\u0000${edge.toKey}`, edge);
}

function buildDbtModelLookup(manifest: DQLManifest): Map<string, Set<string>> {
  const lookup = new Map<string, Set<string>>();
  const add = (key: string, objectKey: string) => {
    const normalized = key.toLowerCase();
    const existing = lookup.get(normalized);
    if (existing) existing.add(objectKey);
    else lookup.set(normalized, new Set([objectKey]));
  };
  for (const model of manifest.dbtImport?.dbtDag?.models ?? []) {
    if (model.type !== 'model') continue;
    const objectKey = `dbt:model:${model.name}`;
    for (const key of dbtModelLookupKeys(model.name, model.schema, model.database)) {
      add(key, objectKey);
    }
  }
  return lookup;
}

function resolveDbtModelKeyForTable(tableRef: string, lookup: Map<string, Set<string>>): string | undefined {
  for (const key of tableReferenceLookupKeys(tableRef)) {
    const matches = lookup.get(key);
    if (matches?.size === 1) return [...matches][0];
  }
  return undefined;
}

function dbtModelLookupKeys(name: string, schema?: string, database?: string): string[] {
  const aliases = new Set([name.toLowerCase()]);
  const stripped = stripCommonDbtPrefix(name);
  if (stripped) aliases.add(stripped);
  const keys = new Set<string>();
  for (const alias of aliases) {
    keys.add(alias);
    if (schema) keys.add(`${schema}.${alias}`.toLowerCase());
    if (schema && database) keys.add(`${database}.${schema}.${alias}`.toLowerCase());
  }
  return [...keys];
}

function tableReferenceLookupKeys(tableRef: string): string[] {
  const normalized = tableRef.replace(/["`]/g, '').toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>([normalized]);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  const last = parts.at(-1);
  if (last) keys.add(last);
  return [...keys];
}

function stripCommonDbtPrefix(name: string): string | undefined {
  const match = /^(?:src|stg|int|dim|fct)_(.+)$/i.exec(name);
  return match?.[1]?.toLowerCase();
}

function dbtDependencyKey(uniqueId: string): string {
  const parts = uniqueId.split('.');
  const kind = parts[0] === 'source' ? 'source' : 'model';
  const name = parts.at(-1) ?? uniqueId;
  return `dbt:${kind}:${name}`;
}

function addProjectDiagnostics(
  manifest: DQLManifest,
  semanticLayer: SemanticLayer | undefined,
  diagnostics: MetadataDiagnostic[],
): void {
  const semanticCount =
    Object.keys(manifest.metrics ?? {}).length +
    Object.keys(manifest.dimensions ?? {}).length +
    (semanticLayer?.listMetrics().length ?? 0) +
    (semanticLayer?.listDimensions().length ?? 0) +
    (semanticLayer?.listSemanticModels().length ?? 0);
  if (semanticCount === 0) {
    diagnostics.push({
      kind: 'semantic',
      severity: 'warning',
      message: 'No semantic metrics or dimensions were found. Agents can use DQL/dbt/warehouse metadata, but semantic metric answers require metric definitions.',
    });
  }
}

/**
 * Resolve the question's scope (metric / dbt model / domain / term / block) for
 * scoped-hint matching. Drawn from the route's chosen objects + question plan so
 * a hint only applies inside the same metric/model/domain it was approved for.
 * Dialect is intentionally left undefined here (unknown at this layer); the hint
 * scope matcher tolerates an unknown question dialect.
 */
function deriveQuestionScope(
  request: BuildLocalContextPackRequest,
  questionPlan: AnalysisQuestionPlan,
  objects: MetadataObject[],
  routeDecision: MetadataRouteDecision,
  allowedSqlContext: MetadataAllowedSqlContext,
): QuestionScope {
  const focusKey = routeDecision.exactObjectKey ?? request.focusObjectKey;
  const focus = focusKey ? objects.find((object) => object.objectKey === focusKey) : undefined;
  const topByType = (type: string): MetadataObject | undefined =>
    objects.find((object) => object.objectType === type);

  const metricObject =
    (focus && (focus.objectType === 'semantic_metric' || focus.objectType === 'dql_block') ? focus : undefined) ??
    topByType('semantic_metric');
  const dbtObject = topByType('dbt_model');

  const metric = firstNonEmpty(
    metricObject?.objectType === 'semantic_metric' ? metricObject.name : undefined,
    questionPlan.metricTerms[0],
  );
  const domain = firstNonEmpty(focus?.domain, metricObject?.domain, dbtObject?.domain, ...objects.map((o) => o.domain));
  const dbtModel = dbtObject?.name;
  const block = focus?.objectType === 'dql_block' ? focus.name : undefined;
  const term = focus?.objectType === 'dql_term' ? focus.name : topByType('dql_term')?.name;

  return {
    metric: lowerOrUndef(metric),
    dbtModel: lowerOrUndef(dbtModel),
    // Carry every retrieved model/metric so a hint scoped to any of them fires,
    // instead of only the one that happened to rank first.
    dbtModels: objects.filter((o) => o.objectType === 'dbt_model').map((o) => o.name.toLowerCase()).slice(0, 40),
    metrics: objects.filter((o) => o.objectType === 'semantic_metric').map((o) => o.name.toLowerCase()).slice(0, 40),
    domain: lowerOrUndef(domain),
    term: lowerOrUndef(term),
    block,
    relations: allowedSqlContext.relations
      .map((relation) => relation.relation)
      .filter(Boolean)
      .slice(0, 80),
    columns: allowedSqlContext.relations
      .flatMap((relation) => relation.columns.map((column) => `${relation.relation}.${column.name}`))
      .slice(0, 320),
    text: request.question,
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value && value.trim().length > 0) return value;
  }
  return undefined;
}

function lowerOrUndef(value: string | undefined): string | undefined {
  return value ? value.trim().toLowerCase() : undefined;
}

async function planContextPackRoute(input: {
  request: BuildLocalContextPackRequest;
  objects: MetadataObject[];
  allowedSqlContext: MetadataAllowedSqlContext;
  evidenceRoles: LocalContextPack['evidenceRoles'];
  diagnostics: MetadataDiagnostic[];
  trustLabel: MetadataTrustLabel;
  questionPlan: AnalysisQuestionPlan;
  compileConflicts?: ManifestConflictDetail[];
  rankedObjects?: RankedMetadataObject[];
}): Promise<MetadataRouteDecision> {
  const intent = input.request.intent ?? input.questionPlan.routeIntent ?? classifyMetadataIntent(input.request.question, input.request.followUp);

  // Conflict route (additive, evaluated first): if the question's top governed
  // candidates include BOTH sides of a compile-time trust conflict, refuse to
  // silently pick one. Surface both definitions + owners + a disambiguation
  // prompt. Only fires when both conflicting sides are actually among the
  // selected candidates for THIS question, so non-conflicting asks are
  // unaffected even when a conflict exists elsewhere in the project.
  const routeConflict = pickRouteConflict(input.compileConflicts ?? [], input.rankedObjects ?? [], input.objects, input.request.question);
  if (routeConflict) {
    const selectedEvidenceForConflict = input.evidenceRoles.slice(0, 16);
    return {
      route: 'conflict',
      intent,
      reason: `Two certified ${routeConflict.objectType}s claim "${routeConflict.concept}" but disagree (${routeConflict.reason}). ZLens refuses to guess which is authoritative.`,
      trustLabel: 'conflict',
      reviewStatus: 'conflict',
      selectedEvidence: selectedEvidenceForConflict,
      missingContext: [{
        kind: 'metadata',
        severity: 'blocking',
        message: routeConflict.prompt,
      }],
      followUps: [routeConflict.prompt],
      routeConflict,
    };
  }

  const applicabilityByKey = certifiedApplicabilities(input.objects, input.questionPlan);
  const exactByApplicability = [...applicabilityByKey.values()]
    .filter((item) => item.kind === 'exact_answer' || item.kind === 'safe_parameterized')
    .sort((a, b) => b.score - a.score)[0];
  // Analytical questions intentionally keep certified applicability conservative:
  // a lexical/content match alone must not terminate the cascade. A certified
  // block whose declared/inferred output contract fully covers the requested
  // answer shape is different, however — that is a proven Tier 1 answer even
  // when the planner also knows how to generate SQL. Promote only exact/trim-safe
  // contract fits here; near matches remain context for Tier 2.
  const exactByContract = input.objects
    .filter((object) =>
      object.objectType === 'dql_block'
      && isCertifiedMetadataObject(object)
      && hasCompatibleMetadataRankingDirection(input.request.question, object)
    )
    .map((object) => ({
      object,
      fit: evaluateCertifiedBlockFit({
        question: input.request.question,
        plan: input.questionPlan,
        block: object,
        exactExampleMatch: hasExactExampleQuestion(input.request.question, object),
        uniqueExactExampleContract: hasUniqueExactCertifiedExample(input.request.question, input.objects, object),
        definitionLookup: intent === 'definition_lookup' && objectNameInQuestion(input.request.question, object),
      }),
      applicabilityScore: applicabilityByKey.get(object.objectKey)?.score ?? 0,
    }))
    .filter(({ fit }) =>
      (fit.kind === 'exact' || fit.kind === 'trim_safe')
      && (fit.confidence === 'high' || fit.confidence === 'medium')
    )
    .sort((a, b) =>
      (b.fit.confidence === 'high' ? 1 : 0) - (a.fit.confidence === 'high' ? 1 : 0)
      || b.applicabilityScore - a.applicabilityScore
    )[0]?.object;
  const directlyNamedCertified = findExactCertifiedObject(input.request.question, intent, input.objects);
  const applicabilityCertified = exactByApplicability
    ? input.objects.find((object) => object.objectKey === exactByApplicability.objectKey)
    : undefined;
  // Selection order is governance-significant (AGT-009/AGT-010): an explicit
  // block/example reference wins, then a complete answer-shape fit, and only then
  // the older lexical applicability heuristic. This prevents a broad customer
  // block containing the word "spend" from displacing an exact beverage-scoped
  // customer ranking whose measure is named "beverage_revenue".
  let exact: MetadataObject | undefined = directlyNamedCertified ?? exactByContract ?? applicabilityCertified;
  const contextApplicability = [...applicabilityByKey.values()]
    .filter((item) => item.kind === 'context_only')
    .sort((a, b) => b.score - a.score)[0];
  // W2.1 — paraphrase promotion. When no block string/lexically matched, promote a
  // top context-only certified candidate whose example QUESTION the user paraphrased
  // (semantic cosine + direction) to the certified candidate. It still runs the full
  // shape/grain fit below (paraphraseExampleMatch is kept OUT of directCertifiedBypass,
  // the fit's exactExampleMatch, and the grain-gate skip) — so paraphrase never bypasses
  // grain the way a user naming the block directly does.
  let paraphraseExampleMatch = false;
  if (!exact && contextApplicability) {
    const candidate = input.objects.find((object) => object.objectKey === contextApplicability.objectKey);
    if (candidate && isCertifiedMetadataObject(candidate)
      && await matchExampleParaphrase(input.request.question, candidate, envEmbeddingProvider())) {
      exact = candidate;
      paraphraseExampleMatch = true;
    }
  }
  // Keep the strongest context-only certified candidate attached to the route
  // so the contract and grain gates can explain exactly why it is demoted.
  // This does not promote a loose match: both gates still have to pass before
  // Tier 1 is possible.
  if (!exact && contextApplicability) {
    exact = input.objects.find((object) => object.objectKey === contextApplicability.objectKey);
  }
  const certifiedApplicability = exact
    ? applicabilityByKey.get(exact.objectKey) ?? certifiedApplicabilityForObject(exact, input.questionPlan)
    : undefined;
  const exactExampleMatch = exact ? hasExactExampleQuestion(input.request.question, exact) : false;
  const directCertifiedBypass = Boolean(exact && (
    exactExampleMatch
    || (intent === 'definition_lookup' && objectNameInQuestion(input.request.question, exact))
    || objectNameInQuestion(input.request.question, exact)
  ));
  const blockFitObject = exact
    ?? (contextApplicability ? input.objects.find((object) => object.objectKey === contextApplicability.objectKey) : undefined);
  const rawBlockFit = blockFitObject
    ? evaluateCertifiedBlockFit({
        question: input.request.question,
        plan: input.questionPlan,
        block: blockFitObject,
        exactExampleMatch: exact ? exactExampleMatch : false,
        uniqueExactExampleContract: Boolean(exact && hasUniqueExactCertifiedExample(
          input.request.question,
          input.objects,
          blockFitObject,
        )),
        definitionLookup: Boolean(exact && intent === 'definition_lookup'
          && objectNameInQuestion(input.request.question, blockFitObject)),
      })
    : undefined;
  const blockFit = rawBlockFit && blockFitObject
    ? await confirmMediumCertifiedFit({
        request: input.request,
        questionPlan: input.questionPlan,
        block: blockFitObject,
        fit: rawBlockFit,
        directCertifiedBypass,
      })
    : rawBlockFit;
  const missingContext = buildMissingContext(input.request, intent, input.objects, input.allowedSqlContext);
  const selectedEvidence = input.evidenceRoles.slice(0, 16);

  // A blocking context gap belongs to the question, not to whichever
  // certified artifact happened to rank first.  Evaluate it before a
  // wrong-grain/block-fit demotion can send a diagnose request into generated
  // SQL.  In particular, a current-only tile plus a nearby raw table with a
  // date column must ask for a baseline rather than invent one.
  if (intent === 'clarify' || missingContext.some((item) => item.severity === 'blocking')) {
    return clarifyDecision(intent, input.trustLabel, selectedEvidence, missingContext);
  }

  // Grain / contract gate (refinement of the existing certified→generated
  // demotion). The candidate certified block is only served at Tier 1 when its
  // declared grain actually satisfies the question's requested grain. An
  // explicit example/name match bypasses the gate — the user is naming the
  // block directly, so grain is implicitly accepted.
  const requestedGrain = requestedGrainFromPlan(input.questionPlan);
  const grainGate = exact && !exactExampleMatch && intent !== 'definition_lookup'
    ? grainMatches(exact, requestedGrain)
    : undefined;
  const grainGateInfo: GrainGateRouteInfo | undefined = exact && grainGate
    ? {
      blockObjectKey: exact.objectKey,
      blockName: exact.name,
      allow: grainGate.allow,
      kind: grainGate.kind,
      requestedGrain: grainGate.requestedGrainLabel,
      blockGrain: grainGate.blockGrainLabel,
      reason: grainGate.reason,
    }
    : undefined;
  // A genuine grain/entity mismatch demotes the candidate to Tier 2 — but only
  // when generated SQL is actually possible. If nothing else can answer, we do
  // not strand the user; the existing certified fallback still applies (and
  // query_via_block enforces the gate defensively at execution time).
  const canGenerateFromContext =
    input.allowedSqlContext.relations.length > 0 ||
    input.allowedSqlContext.sourceBlockSql.length > 0 ||
    input.objects.some((object) => object.objectType.startsWith('semantic_'));
  const grainGateDemotes = Boolean(grainGate && !grainGate.allow && canGenerateFromContext);
  // ONE authority decides certified termination (see certifiedTerminationVerdict):
  // the direct-request bypass rides inside the verdict, and a typed member
  // binding the block cannot apply is never bypassable — even a directly named
  // block must not answer a member-scoped question with unfiltered rows.
  const terminationVerdict = blockFit
    ? certifiedTerminationVerdict({
        fit: blockFit,
        bypass: directCertifiedBypass
          ? (exactExampleMatch ? 'exact_example' : intent === 'definition_lookup' ? 'definition_lookup' : 'named_block')
          : undefined,
      })
    : undefined;
  const blockFitDemotes = Boolean(terminationVerdict && !terminationVerdict.allow && canGenerateFromContext);
  const certifiedFitPassed = !terminationVerdict || terminationVerdict.allow;

  if (!grainGateDemotes && !blockFitDemotes && certifiedFitPassed && exact && (
    certifiedApplicability?.kind === 'exact_answer'
    || certifiedApplicability?.kind === 'safe_parameterized'
    || intent === 'exact_certified_lookup'
    || intent === 'definition_lookup'
    || exactExampleMatch
    || paraphraseExampleMatch
    || (blockFit && certifiedFitAllowsTier1(blockFit) && hasCompatibleMetadataRankingDirection(input.request.question, exact))
    || (intent === 'ad_hoc_ranking' && objectNameInQuestion(input.request.question, exact))
  )) {
    return {
      route: 'certified',
      intent: input.questionPlan.outputShape === 'value' && input.questionPlan.requestedShape.dimensions.length === 0
        ? 'exact_certified_lookup'
        : intent,
      reason: `Certified ${exact.objectType.replace(/_/g, ' ')} "${exact.name}" exactly matches the requested artifact, definition, or direct KPI grain.`,
      routeReason: grainGateInfo?.reason,
      grainGate: grainGateInfo,
      blockFit,
      trustLabel: 'certified',
      reviewStatus: 'certified',
      exactObjectKey: exact.objectKey,
      certifiedApplicability,
      selectedEvidence,
      missingContext: [],
      followUps: buildMetadataFollowUps(intent, input.allowedSqlContext),
    };
  }

  // Grain-gated demotion: the best certified candidate is close but answers a
  // different grain. Serve Tier 2 (generated from context) with the block kept
  // as context only, instead of a confidently-wrong governed answer.
  if (grainGateDemotes && exact && grainGate) {
    return {
      route: 'generated_sql',
      intent: isGeneratedMetadataIntent(intent) ? intent : 'ad_hoc_ranking',
      reason: `Certified block "${exact.name}" is close but answers a different grain than the question, so it is context only and SQL is generated for the requested grain.`,
      routeReason: `${grainGate.reason}; routed to Tier 2 generated SQL`,
      grainGate: grainGateInfo,
      blockFit,
      trustLabel: input.trustLabel === 'certified' ? 'mixed' : input.trustLabel,
      reviewStatus: 'draft_ready',
      certifiedApplicability: certifiedApplicability
        ? { ...certifiedApplicability, kind: 'context_only' }
        : contextApplicability,
      selectedEvidence,
      missingContext,
      followUps: buildMetadataFollowUps(isGeneratedMetadataIntent(intent) ? intent : 'ad_hoc_ranking', input.allowedSqlContext),
    };
  }

  if (blockFitDemotes && exact && blockFit) {
    return {
      route: 'generated_sql',
      intent: isGeneratedMetadataIntent(intent) ? intent : 'ad_hoc_ranking',
      reason: `Certified block "${exact.name}" is relevant but does not satisfy the requested answer shape, so it is context only and SQL is generated for the requested result.`,
      routeReason: `${blockFit.reasons.join('; ')}; routed to Tier 2 generated SQL`,
      grainGate: grainGateInfo,
      blockFit,
      trustLabel: input.trustLabel === 'certified' ? 'mixed' : input.trustLabel,
      reviewStatus: 'draft_ready',
      certifiedApplicability: certifiedApplicability
        ? { ...certifiedApplicability, kind: 'context_only' }
        : contextApplicability,
      selectedEvidence,
      missingContext,
      followUps: buildMetadataFollowUps(isGeneratedMetadataIntent(intent) ? intent : 'ad_hoc_ranking', input.allowedSqlContext),
    };
  }

  if (intent === 'trust_gap_review') {
    if (input.objects.length === 0) {
      return clarifyDecision(intent, input.trustLabel, selectedEvidence, [{
        kind: 'metadata',
        severity: 'blocking',
        message: 'No local metadata matched this trust question. Re-run zlens compile or connect the relevant DQL/dbt project before reviewing trust.',
      }]);
    }
    return {
      route: 'research',
      intent,
      reason: 'Trust questions need a certification, lineage, owner, caveat, and diagnostic review rather than a metric SQL preview.',
      trustLabel: input.trustLabel,
      reviewStatus: 'needs_review',
      certifiedApplicability: contextApplicability,
      selectedEvidence,
      missingContext,
      followUps: buildMetadataFollowUps(intent, input.allowedSqlContext),
    };
  }

  const canGenerate =
    input.allowedSqlContext.relations.length > 0 ||
    input.allowedSqlContext.sourceBlockSql.length > 0 ||
    input.objects.some((object) => object.objectType.startsWith('semantic_'));

  if (canGenerate && isGeneratedMetadataIntent(intent)) {
    return {
      route: 'generated_sql',
      intent,
      reason: 'The question asks for a different grain, ranking, breakdown, comparison, entity drilldown, or diagnostic analysis, so certified artifacts are context only.',
      routeReason: blockFit && !certifiedFitAllowsTier1(blockFit) ? blockFit.reasons.join('; ') : undefined,
      trustLabel: input.trustLabel === 'certified' ? 'mixed' : input.trustLabel,
      reviewStatus: 'draft_ready',
      certifiedApplicability: contextApplicability,
      blockFit,
      selectedEvidence,
      missingContext,
      followUps: buildMetadataFollowUps(intent, input.allowedSqlContext),
    };
  }

  if (exact && certifiedFitPassed) {
    return {
      route: 'certified',
      intent: 'exact_certified_lookup',
      reason: `Certified artifact "${exact.name}" is the closest safe direct answer.`,
      trustLabel: 'certified',
      reviewStatus: 'certified',
      exactObjectKey: exact.objectKey,
      certifiedApplicability,
      blockFit,
      selectedEvidence,
      missingContext: [],
      followUps: buildMetadataFollowUps('exact_certified_lookup', input.allowedSqlContext),
    };
  }

  if (exact && blockFit && !certifiedFitAllowsTier1(blockFit)) {
    return clarifyDecision(intent, input.trustLabel === 'certified' ? 'mixed' : input.trustLabel, selectedEvidence, [{
      kind: 'metadata',
      severity: 'blocking',
      message: `The closest certified block "${exact.name}" does not exactly answer this question (${blockFit.reasons.join('; ')}), and there is not enough SQL context to safely generate the requested answer.`,
    }]);
  }

  return clarifyDecision(intent, input.trustLabel, selectedEvidence, missingContext.length > 0 ? missingContext : [{
    kind: 'metadata',
    severity: 'blocking',
    message: 'The local metadata matched some context, but not enough to choose a safe metric, table, or grain.',
  }]);
}

const CERTIFIED_FIT_CONFIRM_TIMEOUT_MS = 2500;

async function confirmMediumCertifiedFit(input: {
  request: BuildLocalContextPackRequest;
  questionPlan: AnalysisQuestionPlan;
  block: MetadataObject;
  fit: CertifiedBlockFit;
  directCertifiedBypass: boolean;
}): Promise<CertifiedBlockFit> {
  const confirmer = input.request.confirmCertifiedFit;
  if (!confirmer || input.directCertifiedBypass) return input.fit;
  if (input.fit.confidence !== 'medium') return input.fit;
  if (input.fit.kind !== 'exact' && input.fit.kind !== 'trim_safe') return input.fit;

  try {
    const result = await withTimeout(
      confirmer({
        question: input.request.question,
        questionPlan: input.questionPlan,
        block: input.block,
        fit: input.fit,
      }),
      CERTIFIED_FIT_CONFIRM_TIMEOUT_MS,
      'certified fit confirmation timed out',
    );
    const reason = cleanConfirmationReason(result.reason);
    if (result.allow && result.confidence !== 'low') {
      return {
        ...input.fit,
        confidence: 'high',
        reasons: [
          ...input.fit.reasons,
          `fit confirmation accepted this certified block${reason ? `: ${reason}` : ''}`,
        ],
      };
    }
    return {
      ...input.fit,
      kind: 'context_only',
      confidence: 'high',
      reasons: [
        ...input.fit.reasons,
        `fit confirmation rejected this certified block as a direct answer${reason ? `: ${reason}` : ''}`,
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...input.fit,
      reasons: [
        ...input.fit.reasons,
        `fit confirmation unavailable; kept review-required (${message})`,
      ],
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function cleanConfirmationReason(value: string | undefined): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, 240)
    : '';
}

function certifiedApplicabilities(
  objects: MetadataObject[],
  questionPlan: AnalysisQuestionPlan,
): Map<string, CertifiedBlockApplicability> {
  const items = objects
    .filter((object) => object.objectType === 'dql_block' && isCertifiedMetadataObject(object))
    .map((object) => certifiedApplicabilityForObject(object, questionPlan))
    .filter((item) => item.kind !== 'not_applicable')
    .sort((a, b) => b.score - a.score);
  return new Map(items.map((item) => [item.objectKey, item]));
}

function buildCertifiedCandidateFitDiagnostics(input: {
  request: BuildLocalContextPackRequest;
  objects: MetadataObject[];
  questionPlan: AnalysisQuestionPlan;
  routeDecision: MetadataRouteDecision;
}): LocalContextPack['retrievalDiagnostics']['certifiedCandidateFits'] {
  return input.objects
    .filter((object) => object.objectType === 'dql_block' && isCertifiedMetadataObject(object))
    .map((object) => {
      const applicability = certifiedApplicabilityForObject(object, input.questionPlan);
      const exactExampleContract = hasUniqueExactCertifiedExample(input.request.question, input.objects, object);
      const titleOrAliasContract = hasExactCertifiedTitleOrAliasQuestion(input.request.question, object);
      const fit = evaluateCertifiedBlockFit({
        question: input.request.question,
        plan: input.questionPlan,
        block: object,
        exactExampleMatch: hasExactExampleQuestion(input.request.question, object),
        uniqueExactExampleContract: exactExampleContract,
        definitionLookup: input.routeDecision.intent === 'definition_lookup',
      });
      return {
        objectKey: object.objectKey,
        name: object.name,
        applicabilityKind: applicability.kind,
        applicabilityScore: applicability.score,
        action: certifiedCandidateFitAction(object.objectKey, applicability, fit, input.routeDecision),
        // Applicability is a retrieval/routing score, not an independent
        // statement about the block's output tuple. The fit is the authority
        // here: a real certified artifact may be retrieved as context-only
        // while still proving every requested output, grain, filter and
        // ranking shape. V2 retains all such fits, then requires that exactly
        // one snapshot-bound candidate remains before the zero-provider lane.
        completeForRequest: certifiedFitAllowsTier1(fit)
          && (fit.missingMeasures?.length ?? 0) === 0,
        ...(exactExampleContract
          ? { directQuestionContract: 'exact_example' as const }
          : titleOrAliasContract
            ? { directQuestionContract: 'title_or_alias' as const }
            : {}),
        fit,
      };
    })
    .filter((item) =>
      item.applicabilityKind !== 'not_applicable' ||
      item.fit.kind !== 'not_applicable' ||
      item.action === 'certified_answer'
    )
    .sort((a, b) =>
      certifiedCandidateActionRank(a.action) - certifiedCandidateActionRank(b.action) ||
      b.applicabilityScore - a.applicabilityScore ||
      a.name.localeCompare(b.name)
    )
    .slice(0, 12);
}

function certifiedCandidateFitAction(
  objectKey: string,
  applicability: CertifiedBlockApplicability,
  fit: CertifiedBlockFit,
  routeDecision: MetadataRouteDecision,
): LocalContextPack['retrievalDiagnostics']['certifiedCandidateFits'][number]['action'] {
  // A catalog route is useful retrieval guidance, not independent evidence
  // that the selected block exposes every requested metric.  Do not stamp a
  // candidate as a certified answer when its own output-contract fit contains
  // a missing measure: doing so let a `lifetime_spend` ranking inherit the
  // generic `revenue` tag and freeze as a false certified result.
  if (routeDecision.route === 'certified'
    && routeDecision.exactObjectKey === objectKey
    && certifiedFitAllowsTier1(fit)
    && (fit.missingMeasures?.length ?? 0) === 0) return 'certified_answer';
  if (routeDecision.certifiedApplicability?.objectKey === objectKey && routeDecision.route !== 'certified') return 'context_only';
  if (!certifiedFitAllowsTier1(fit) || applicability.kind === 'context_only') return 'rejected_for_fit';
  return 'eligible_not_selected';
}

function certifiedCandidateActionRank(action: LocalContextPack['retrievalDiagnostics']['certifiedCandidateFits'][number]['action']): number {
  switch (action) {
    case 'certified_answer':
      return 0;
    case 'context_only':
      return 1;
    case 'rejected_for_fit':
      return 2;
    case 'eligible_not_selected':
      return 3;
  }
}

function clarifyDecision(
  intent: MetadataAgentIntent,
  trustLabel: MetadataTrustLabel,
  selectedEvidence: MetadataRouteDecision['selectedEvidence'],
  missingContext: MetadataMissingContext[],
): MetadataRouteDecision {
  return {
    route: 'clarify',
    intent,
    reason: 'ZLens needs one more business or metadata detail before it can safely generate SQL.',
    trustLabel,
    reviewStatus: 'none',
    selectedEvidence,
    missingContext: missingContext.length > 0 ? missingContext : [{
      kind: 'metadata',
      severity: 'blocking',
      message: 'No certified block, semantic metric, dbt model, or runtime schema matched strongly enough to answer safely.',
    }],
    followUps: [
      'Which metric should define the answer?',
      'Which table or certified block should be used as the source?',
      'What filter or time period should apply?',
    ],
  };
}

export function classifyMetadataIntent(question: string, followUp?: unknown): MetadataAgentIntent {
  const follow = followUp && typeof followUp === 'object' ? followUp as Record<string, unknown> : null;
  if (follow?.kind === 'drilldown') return 'entity_drilldown';
  const lower = question.toLowerCase();
  if (/\b(trust|rely|certif|lineage|owner|caveat|gap|governance)\b/.test(lower)) return 'trust_gap_review';
  if (/\b(define|definition|meaning of|what is|what are|what does .+ mean)\b/.test(lower)) return 'definition_lookup';
  if (/\b(anomal|exception|outlier|spike|dip)\b/.test(lower)) return 'anomaly_investigation';
  if (/\b(compare|versus|vs\.?|segment|cohort)\b/.test(lower)) return 'segment_compare';
  // Ranking / superlative asks ("top N", "who performed most", "best/worst by X") are
  // lookups, not change-diagnosis — classify them as ranking so they don't wrongly hit
  // the diagnose "baseline period" gate. Skip this when the ask is genuinely about a
  // change over time, or is a driver/breakdown question (which owns "top movers").
  {
    const asksAboutChange = /\b(why|what happened|changed?|dropp|declin|increas|decreas|delta|variance|month over month|year over year|over time|trend)\b/.test(lower);
    const asksDriver = /\b(driver|drivers|drove|break\s*down|breakdown|contribut|movers?)\b/.test(lower);
    if (!asksAboutChange && !asksDriver && /\b(top|bottom|best|worst|highest|lowest|least|fewest|rank|ranking|most)\b/.test(lower)) {
      return 'ad_hoc_ranking';
    }
  }
  if (/\b(why|changed?|change|drop|dropped|decline|declined|increase|increased|decrease|decreased|delta|variance|what happened)\b/.test(lower)) return 'diagnose_change';
  if (/\b(driver|drivers|drove|break\s*down|breakdown|contribute|contribution|top movers?)\b/.test(lower)) return 'driver_breakdown';
  if (isEntityQuestion(question)) return 'entity_drilldown';
  if (/\b(top|bottom|best|worst|highest|lowest|least|fewest|minimum|min|maximum|max|rank|ranking|most)\b/.test(lower)) return 'ad_hoc_ranking';
  if (/\b(block|certified|saved|existing|approved|governed)\b/.test(lower)) return 'exact_certified_lookup';
  if (isDirectKpiValueQuestion(question)) return 'exact_certified_lookup';
  if (/\b(show|list|find|which|who|how many|how much|metric|kpi|dashboard|performance|revenue|sales|points|goals|orders|customers|users)\b/.test(lower)) return 'ad_hoc_ranking';
  return 'clarify';
}

function isGeneratedMetadataIntent(intent: MetadataAgentIntent): boolean {
  return intent === 'ad_hoc_ranking'
    || intent === 'driver_breakdown'
    || intent === 'diagnose_change'
    || intent === 'segment_compare'
    || intent === 'entity_drilldown'
    || intent === 'anomaly_investigation';
}

function findExactCertifiedObject(question: string, intent: MetadataAgentIntent, objects: MetadataObject[]): MetadataObject | undefined {
  const candidates = objects.filter((object) => isCertifiedMetadataObject(object));
  if (intent === 'definition_lookup') {
    // A definition-shaped sentence is not itself evidence of a match. Small
    // catalogs often return every certified term; selecting the first one made
    // unrelated questions (for example weather) look governed. Prefer an
    // explicitly named/example block, then require the term/view name itself.
    return candidates.find((object) => object.objectType === 'dql_block'
      && (hasExactExampleQuestion(question, object) || objectNameInQuestion(question, object)))
      ?? candidates.find((object) => (object.objectType === 'dql_term' || object.objectType === 'business_view')
        && objectNameInQuestion(question, object));
  }
  const namedExact = candidates.find((object) =>
    object.objectType === 'dql_block' &&
    objectNameInQuestion(question, object) &&
    hasCompatibleMetadataRankingDirection(question, object)
  );
  if (namedExact) return namedExact;
  const exampleExact = candidates.find((object) =>
    object.objectType === 'dql_block' &&
    hasExactExampleQuestion(question, object) &&
    hasCompatibleMetadataRankingDirection(question, object)
  );
  if (exampleExact) return exampleExact;
  if (isGeneratedMetadataIntent(intent)) return undefined;
  return candidates.find((object) =>
    object.objectType === 'dql_block' &&
    objectNameInQuestion(question, object) &&
    hasCompatibleMetadataRankingDirection(question, object),
  ) ?? candidates.find((object) =>
    object.objectType === 'dql_block' &&
    hasMeaningfulObjectOverlap(question, object) &&
    hasCompatibleMetadataRankingDirection(question, object) &&
    !looksLikeDifferentGrainQuestion(question),
  );
}

function isCertifiedMetadataObject(object: MetadataObject): boolean {
  return object.status === 'certified' || object.status === 'approved' || object.payload?.certification === 'certified';
}

function isUncertifiedDqlBlock(object: MetadataObject): boolean {
  return object.objectType === 'dql_block' && !isCertifiedMetadataObject(object);
}

function allowsDraftBlockRetrieval(request: BuildLocalContextPackRequest): boolean {
  if (request.includeDraftBlocks === true) return true;
  if (request.surface === 'block') return true;
  if (request.mode && request.mode !== 'question') return true;
  return /\b(?:draft|review|edit|certif(?:y|ied|ication)|block studio|this block)\b/i.test(request.question);
}

function objectNameInQuestion(question: string, object: MetadataObject): boolean {
  const q = normalizeSearchText(question);
  const name = normalizeSearchText(object.name);
  const fullName = normalizeSearchText(object.fullName ?? '');
  return Boolean(name && q.includes(name)) || Boolean(fullName && q.includes(fullName));
}

function hasExactExampleQuestion(question: string, object: MetadataObject): boolean {
  const q = normalizeSearchText(question);
  if (!q) return false;
  const examples = Array.isArray(object.payload?.examples) ? object.payload.examples : [];
  return examples.some((example) =>
    example &&
    typeof example === 'object' &&
    normalizeSearchText(String((example as { question?: unknown }).question ?? '')) === q,
  );
}

function hasExactCertifiedTitleOrAliasQuestion(question: string, object: MetadataObject): boolean {
  const normalizedQuestion = normalizeSearchText(question);
  if (!normalizedQuestion) return false;
  const aliases = Array.isArray(object.payload?.aliases)
    ? object.payload.aliases.filter((value): value is string => typeof value === 'string')
    : [];
  return [object.name, object.fullName ?? '', ...aliases]
    .map(normalizeSearchText)
    .filter(Boolean)
    .some((candidate) => candidate === normalizedQuestion);
}

/**
 * An authored example is a block-local contract only when it identifies one
 * certified block in this snapshot.  Shared examples are ambiguous evidence:
 * neither block may reinterpret parser member tokens through its own shape.
 */
function hasUniqueExactCertifiedExample(
  question: string,
  objects: MetadataObject[],
  object: MetadataObject,
): boolean {
  if (!hasExactExampleQuestion(question, object)) return false;
  const matches = objects.filter((candidate) =>
    candidate.objectType === 'dql_block'
    && isCertifiedMetadataObject(candidate)
    && hasExactExampleQuestion(question, candidate),
  );
  return matches.length === 1 && matches[0]?.objectKey === object.objectKey;
}

function hasMeaningfulObjectOverlap(question: string, object: MetadataObject): boolean {
  const terms = new Set(tokenize(question));
  if (terms.size === 0) return false;
  const haystack = tokenize([
    object.name,
    object.fullName ?? '',
    object.domain ?? '',
    object.description ?? '',
    JSON.stringify(object.payload ?? {}),
  ].join(' '));
  return haystack.some((term) => terms.has(term));
}

function looksLikeDifferentGrainQuestion(question: string): boolean {
  return /\b(for|where|only|specific|single|individual|named|called|by|break\s*down|breakdown|drill|compare|versus|vs\.?|segment|least|lowest|fewest|bottom|why|changed?|driver|anomal|exception)\b/i.test(question);
}

function isDirectKpiValueQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  if (/\b(by|break\s*down|breakdown|drill|compare|versus|vs\.?|segment|cohort|top|bottom|best|worst|highest|lowest|least|fewest|rank|ranking|most|why|changed?|driver|anomal|exception)\b/.test(lower)) {
    return false;
  }
  if (isEntityQuestion(question)) return false;
  const asksForValue = /\b(what\s+(?:is|was|were|are)|how\s+(?:much|many)|show|report|calculate|give\s+me|tell\s+me)\b/.test(lower);
  const metricLanguage = /\b(revenue|sales|arr|mrr|bookings|orders|customers|users|churn|retention|conversion|rate|count|total|points|goals|kpi|metric)\b/.test(lower);
  return asksForValue && metricLanguage;
}

function hasCompatibleMetadataRankingDirection(question: string, object: MetadataObject): boolean {
  const questionDirection = rankingDirection(question);
  if (!questionDirection) return true;
  const objectDirection = rankingDirection([
    object.name,
    object.description ?? '',
    Array.isArray(object.payload?.tags) ? object.payload.tags.join(' ') : '',
    typeof object.payload?.sql === 'string' ? object.payload.sql : '',
  ].join(' '));
  if (!objectDirection) return true;
  return questionDirection === objectDirection;
}

function rankingDirection(text: string): 'top' | 'bottom' | undefined {
  const lower = text.toLowerCase();
  const bottom = /\b(bottom|least|fewest|lowest|minimum|min|smallest|worst|underperform(?:ing|ed|er|ers)?)\b/.test(lower);
  const top = /\b(top|most|highest|maximum|max|greatest|best|leader|leaders|leading)\b/.test(lower);
  if (bottom && !top) return 'bottom';
  if (top && !bottom) return 'top';
  return undefined;
}

function buildMissingContext(
  request: BuildLocalContextPackRequest,
  intent: MetadataAgentIntent,
  objects: MetadataObject[],
  allowedSqlContext: MetadataAllowedSqlContext,
): MetadataMissingContext[] {
  const missing: MetadataMissingContext[] = [];
  const hasSqlContext = allowedSqlContext.relations.length > 0 || allowedSqlContext.sourceBlockSql.length > 0;
  if (isGeneratedMetadataIntent(intent) && !hasSqlContext && !objects.some((object) => object.objectType.startsWith('semantic_'))) {
    missing.push({
      kind: 'table',
      severity: 'blocking',
      message: 'No dbt model, warehouse/runtime table, semantic metric, or certified block SQL was available for this generated answer.',
    });
  }
  if (intent === 'diagnose_change' && !hasComparableBaselineContext(request, objects, allowedSqlContext)) {
    missing.push({
      kind: 'baseline',
      severity: 'blocking',
      message: 'No comparable time/baseline field or selected tile history was found, so ZLens needs the baseline period before explaining what changed.',
    });
  }
  if ((intent === 'definition_lookup' || intent === 'trust_gap_review') && objects.length === 0) {
    missing.push({
      kind: 'metadata',
      severity: 'blocking',
      message: 'No certified term, business view, block, dashboard, app, or lineage metadata matched this question.',
    });
  }
  return missing;
}

function hasComparableBaselineContext(
  request: BuildLocalContextPackRequest,
  objects: MetadataObject[],
  allowedSqlContext: MetadataAllowedSqlContext,
): boolean {
  const observedBaseline = hasObservedBaselineRows(request.selectedContext);
  if (request.focusObjectKey) {
    const focus = objects.find((object) => object.objectKey === request.focusObjectKey);
    if (focus) {
      const dependencyKeys = new Set([
        ...metadataStringArray(focus.payload?.tableDependencies),
        ...metadataStringArray(focus.payload?.rawTableRefs),
      ].flatMap((relation) => relationLookupKeysForCatalog(relation)));
      const focusedRelations = dependencyKeys.size > 0
        ? allowedSqlContext.relations.filter((relation) => relationLookupKeysForCatalog(relation.relation).some((key) => dependencyKeys.has(key)))
        : [];
      // A time-like column somewhere in the dependency graph is potential
      // exploration context, not proof that the focused artifact contains a
      // comparable baseline.  Treating it as proof made a current-only
      // availability tile answer “what changed?” from an unrelated raw table.
      // Require either observed selected rows spanning two values, or an
      // authored comparison expression that uses a declared focused time
      // column.  Names/descriptions/LLM prose remain retrieval context only.
      if (observedBaseline) return true;
      const focusSql = String(focus.payload?.sql ?? focus.payload?.query ?? '');
      const timeColumns = focusedRelations.flatMap((relation) => relation.columns
        .map((column) => column.name)
        .filter(isTimeLikeColumn));
      const usesFocusedTimeColumn = timeColumns.some((column) =>
        new RegExp(`\\b${escapeRegExp(column)}\\b`, 'i').test(focusSql));
      const declaresComparison = /\b(?:baseline|history|prior|previous|compare|comparison|versus|\bvs\.?|lag|lead)\b/i.test(focusSql);
      return usesFocusedTimeColumn && declaresComparison;
    }
  }
  if (allowedSqlContext.relations.some((relation) => relation.columns.some((column) => isTimeLikeColumn(column.name)))) return true;
  return observedBaseline;
}

function hasObservedBaselineRows(value: unknown): boolean {
  const rows = selectedRows(value);
  if (rows.length < 2) return false;
  const columns = new Set(rows.flatMap((row) => Object.keys(row)));
  for (const column of columns) {
    if (!isTimeLikeColumn(column)) continue;
    const values = new Set(rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined).map(String));
    if (values.size >= 2) return true;
  }
  return false;
}

function relationLookupKeysForCatalog(relation: string): string[] {
  const normalized = normalizeRelationKey(relation);
  const parts = normalized.split('.').filter(Boolean);
  const keys = new Set<string>();
  if (normalized) keys.add(normalized);
  if (parts.length >= 2) keys.add(parts.slice(-2).join('.'));
  if (parts.length >= 1) keys.add(parts[parts.length - 1]!);
  return Array.from(keys);
}

function isTimeLikeColumn(name: string): boolean {
  return /\b(date|time|day|week|month|quarter|year|season|period|created_at|updated_at)\b/i.test(name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function selectedRows(value: unknown): Array<Record<string, unknown>> {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const selected = root?.selectedBlock && typeof root.selectedBlock === 'object' ? root.selectedBlock as Record<string, unknown> : root;
  const candidates = [
    selected?.resultSample,
    selected?.rows,
    selected?.sampleRows,
    root?.resultSample,
    root?.rows,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
  }
  return [];
}

function buildMetadataFollowUps(intent: MetadataAgentIntent, allowedSqlContext: MetadataAllowedSqlContext): string[] {
  if (intent === 'clarify') return ['Pick the metric', 'Pick the source table', 'Pick the time window'];
  if (intent === 'trust_gap_review') return ['Show lineage', 'List caveats', 'Create a certified replacement block'];
  const relation = allowedSqlContext.relations[0];
  const dimension = relation?.columns.find((column) => /(segment|type|name|team|player|customer|product|region)/i.test(column.name))?.name ?? 'segment';
  return [
    `Break down by ${dimension}`,
    'Show the trend over time',
    'Save as a draft block for review',
  ];
}

function buildEvidenceRoles(objects: MetadataObject[], queryRuns: QueryRunSummary[]): LocalContextPack['evidenceRoles'] {
  const roles = objects.slice(0, 40).map((object) => ({
    objectKey: object.objectKey,
    objectType: object.objectType,
    name: object.name,
    role: evidenceRoleForObject(object),
    reason: evidenceReasonForObject(object),
  }));
  for (const run of queryRuns.slice(0, 8)) {
    if (!run.objectKey) continue;
    roles.push({
      objectKey: run.objectKey,
      objectType: 'query_run',
      name: run.payload?.question && typeof run.payload.question === 'string' ? run.payload.question : run.id,
      role: 'prior_query_run',
      reason: `Prior query run status: ${run.status}`,
    });
  }
  return roles;
}

function evidenceRoleForObject(object: MetadataObject): MetadataEvidenceRole {
  if (object.objectType === 'dql_block' && isCertifiedMetadataObject(object)) return 'certified_context';
  if (object.objectType === 'dql_block_output') return 'certified_context';
  if (object.objectType === 'semantic_metric') return 'semantic_metric';
  if (object.objectType === 'dql_term' || object.objectType === 'business_view') return 'business_context';
  if (object.objectType === 'dbt_model' || object.objectType === 'dbt_source' || object.objectType === 'dbt_column') return 'dbt_model';
  if (object.objectType === 'warehouse_table' || object.objectType === 'warehouse_column') return 'warehouse_schema';
  if (object.objectType === 'runtime_value') return 'value_match';
  if (object.objectType === 'runtime_table' || object.objectType === 'runtime_column') return 'runtime_schema';
  if (object.objectType === 'selected_context') return 'selected_context';
  if (object.objectType === 'skill') return 'skill_guidance';
  return 'other';
}

function evidenceReasonForObject(object: MetadataObject): string {
  if (object.objectType === 'dql_block' && isCertifiedMetadataObject(object)) return 'Certified block can be exact answer only when grain matches; otherwise it is context.';
  if (object.objectType.startsWith('semantic_')) return 'Semantic definition can ground metric and dimension meaning.';
  if (object.objectType.startsWith('dbt_')) return 'dbt metadata supplies physical model and column context.';
  if (object.objectType === 'runtime_value') return 'Observed runtime value matched a literal in the question.';
  if (object.objectType === 'runtime_table' || object.objectType === 'runtime_column') return 'Runtime schema supplies executable table and column context.';
  return reasonForObject(object);
}

function sqlParentObjectsForSelectedColumns(
  selectedObjects: MetadataObject[],
  candidateObjects: MetadataObject[],
  questionPlan: AnalysisQuestionPlan,
): MetadataObject[] {
  const selectedKeys = new Set(selectedObjects.map((object) => object.objectKey));
  const parentByRelation = new Map<string, Array<{ object: MetadataObject; relation: MetadataAllowedSqlRelation }>>();
  for (const object of candidateObjects) {
    if (!isSqlParentObject(object) || selectedKeys.has(object.objectKey)) continue;
    const relation = metadataObjectToAllowedSqlRelation(object);
    const key = relation ? normalizeRelationKey(relation.relation) : '';
    if (!relation || !key) continue;
    const existing = parentByRelation.get(key) ?? [];
    existing.push({ object, relation });
    parentByRelation.set(key, existing);
  }

  const scoredParents = new Map<string, { object: MetadataObject; score: number }>();
  for (const object of selectedObjects) {
    if (!isSqlColumnObject(object)) continue;
    const relation = metadataObjectToAllowedSqlRelation(object);
    const key = relation ? normalizeRelationKey(relation.relation) : '';
    if (!key) continue;
    for (const parent of parentByRelation.get(key) ?? []) {
      const relationScore = scoreAllowedSqlRelationWithAnalysisPlan(parent.relation, questionPlan).score;
      const columnScore = scoreMetadataObjectWithAnalysisPlan(object, questionPlan).score;
      const score = relationScore + columnScore;
      const existing = scoredParents.get(parent.object.objectKey);
      if (!existing || score > existing.score) {
        scoredParents.set(parent.object.objectKey, { object: parent.object, score });
      }
    }
  }

  return Array.from(scoredParents.values())
    .sort((a, b) => b.score - a.score || a.object.name.localeCompare(b.object.name))
    .slice(0, 24)
    .map((item) => item.object);
}

function schemaShapeCandidateObjects(
  catalog: MetadataCatalog,
  questionPlan: AnalysisQuestionPlan,
  request: BuildLocalContextPackRequest,
  runtimeObjects: MetadataObject[],
): SchemaShapeCandidate[] {
  if (!questionPlan.needsGeneratedSql) return [];
  const candidates = new Map<string, SchemaShapeCandidate>();
  for (const candidate of cachedCatalogSchemaShapeCandidates(catalog, questionPlan, request)) {
    candidates.set(candidate.object.objectKey, candidate);
  }
  const considerObject = (object: MetadataObject): void => {
    const relation = metadataObjectToAllowedSqlRelation(object);
    if (!relation || relation.columns.length === 0) return;
    const shape = schemaShapeMatchForQuestion(relation, questionPlan);
    if (shape.score <= 0) return;
    const relationScore = scoreAllowedSqlRelationWithAnalysisPlan(relation, questionPlan);
    const objectScore = scoreMetadataObjectWithAnalysisPlan(object, questionPlan);
    const score = Number((shape.score + relationScore.score + objectScore.score).toFixed(3));
    if (score < schemaShapeMinimumScore(questionPlan)) return;
    candidates.set(object.objectKey, {
      object,
      relation,
      score,
      reasons: [
        ...shape.reasons,
        ...relationScore.reasons.filter((reason) =>
          /analysis terms|metric terms|dimension terms|columns match|inspected\/projected columns/i.test(reason)
        ).slice(0, 3),
      ],
    });
    trimSchemaShapeCandidateMap(candidates, 64);
  };
  for (const object of mergeObjects(runtimeObjects.filter(isSqlParentObject))) {
    considerObject(object);
  }
  return Array.from(candidates.values())
    .sort((a, b) => b.score - a.score || a.relation.relation.localeCompare(b.relation.relation))
    .slice(0, 24);
}

function cachedCatalogSchemaShapeCandidates(
  catalog: MetadataCatalog,
  questionPlan: AnalysisQuestionPlan,
  request: BuildLocalContextPackRequest,
): SchemaShapeCandidate[] {
  const cacheKey = schemaShapeCacheKey(catalog, questionPlan);
  if (cacheKey) {
    const cached = schemaShapeCandidateCache.get(cacheKey);
    if (cached) {
      schemaShapeCandidateCache.delete(cacheKey);
      schemaShapeCandidateCache.set(cacheKey, cached);
      return cached;
    }
  }
  const candidates = new Map<string, SchemaShapeCandidate>();
  const considerObject = (object: MetadataObject): void => {
    const relation = metadataObjectToAllowedSqlRelation(object);
    if (!relation || relation.columns.length === 0) return;
    const shape = schemaShapeMatchForQuestion(relation, questionPlan);
    if (shape.score <= 0) return;
    const relationScore = scoreAllowedSqlRelationWithAnalysisPlan(relation, questionPlan);
    const objectScore = scoreMetadataObjectWithAnalysisPlan(object, questionPlan);
    const score = Number((shape.score + relationScore.score + objectScore.score).toFixed(3));
    if (score < schemaShapeMinimumScore(questionPlan)) return;
    candidates.set(object.objectKey, {
      object,
      relation,
      score,
      reasons: [
        ...shape.reasons,
        ...relationScore.reasons.filter((reason) =>
          /analysis terms|metric terms|dimension terms|columns match|inspected\/projected columns/i.test(reason)
        ).slice(0, 3),
      ],
    });
    trimSchemaShapeCandidateMap(candidates, 64);
  };
  catalog.scanObjects({
    objectTypes: ['dbt_model', 'dbt_source', 'warehouse_table'],
    batchSize: schemaShapeScanBatchSize(request),
  }, (objects) => {
    for (const object of objects) considerObject(object);
  });
  const result = Array.from(candidates.values())
    .sort((a, b) => b.score - a.score || a.relation.relation.localeCompare(b.relation.relation))
    .slice(0, 24);
  if (cacheKey) {
    schemaShapeCandidateCache.set(cacheKey, result);
    while (schemaShapeCandidateCache.size > SCHEMA_SHAPE_CACHE_LIMIT) {
      const oldest = schemaShapeCandidateCache.keys().next().value;
      if (!oldest) break;
      schemaShapeCandidateCache.delete(oldest);
    }
  }
  return result;
}

function schemaShapeCacheKey(catalog: MetadataCatalog, questionPlan: AnalysisQuestionPlan): string | null {
  const fingerprint = catalog.state('fingerprint');
  if (!fingerprint) return null;
  return `${fingerprint}:${sha256(stableStringify(questionPlan))}`;
}

function schemaShapeScanBatchSize(request: BuildLocalContextPackRequest): number {
  if (request.strictness === 'exploratory') return 1000;
  return 500;
}

function trimSchemaShapeCandidateMap(candidates: Map<string, SchemaShapeCandidate>, maxCandidates: number): void {
  if (candidates.size <= maxCandidates) return;
  const topCandidates = Array.from(candidates.values())
    .sort((a, b) => b.score - a.score || a.relation.relation.localeCompare(b.relation.relation))
    .slice(0, maxCandidates);
  candidates.clear();
  for (const candidate of topCandidates) {
    candidates.set(candidate.object.objectKey, candidate);
  }
}

function schemaShapeMinimumScore(questionPlan: AnalysisQuestionPlan): number {
  switch (questionPlan.mode) {
    case 'entity_profile':
    case 'entity_drilldown':
      return 40;
    case 'trend':
    case 'diagnose_change':
    case 'driver_breakdown':
    case 'comparison':
      return 42;
    case 'ranking':
    case 'general_analysis':
      return 38;
    default:
      return 44;
  }
}

function schemaShapeMatchForQuestion(
  relation: MetadataAllowedSqlRelation,
  questionPlan: AnalysisQuestionPlan,
): { score: number; reasons: string[] } {
  const columns = relation.columns;
  const entityColumns = columns.filter((column) => isEntityIdentifyingColumn(column.name));
  const measureColumns = columns.filter(isMeasureLikeColumn);
  const timeColumns = columns.filter((column) => isTimeLikeColumn(column.name));
  const dimensionColumns = columns.filter((column) => isDimensionLikeColumn(column.name));
  const relationText = normalizeSearchText(relationSearchTextForCatalog(relation));
  const termHits = informativeSchemaTerms(questionPlan)
    .filter((term) => term.length >= 3 && relationText.includes(term))
    .slice(0, 8);
  let score = termHits.length * 5;
  const reasons: string[] = [];

  if (termHits.length > 0) reasons.push(`schema terms matched: ${termHits.join(', ')}`);
  switch (questionPlan.mode) {
    case 'entity_profile':
    case 'entity_drilldown':
      if (entityColumns.length > 0 && measureColumns.length > 0) {
        score += 34;
        reasons.push(`entity identifiers: ${entityColumns.slice(0, 3).map((column) => column.name).join(', ')}`);
        reasons.push(`measures: ${measureColumns.slice(0, 4).map((column) => column.name).join(', ')}`);
      } else if (entityColumns.length > 0 && (dimensionColumns.length > 0 || relationLooksEntityCentric(relation))) {
        score += 24;
        reasons.push(`entity/profile columns: ${entityColumns.slice(0, 4).map((column) => column.name).join(', ')}`);
      }
      if (timeColumns.length > 0 && (entityColumns.length > 0 || measureColumns.length > 0)) {
        score += 6;
        reasons.push(`time columns: ${timeColumns.slice(0, 3).map((column) => column.name).join(', ')}`);
      }
      break;
    case 'trend':
    case 'diagnose_change':
      if (measureColumns.length > 0 && timeColumns.length > 0) {
        score += 34;
        reasons.push(`trend-ready measures: ${measureColumns.slice(0, 4).map((column) => column.name).join(', ')}`);
        reasons.push(`time columns: ${timeColumns.slice(0, 3).map((column) => column.name).join(', ')}`);
      }
      break;
    case 'driver_breakdown':
    case 'comparison':
      if (measureColumns.length > 0 && (dimensionColumns.length > 0 || entityColumns.length > 0)) {
        score += 32;
        reasons.push(`breakdown dimensions: ${[...dimensionColumns, ...entityColumns].slice(0, 4).map((column) => column.name).join(', ')}`);
        reasons.push(`measures: ${measureColumns.slice(0, 4).map((column) => column.name).join(', ')}`);
      }
      break;
    case 'ranking':
    case 'general_analysis':
      if (measureColumns.length > 0 && (dimensionColumns.length > 0 || entityColumns.length > 0)) {
        score += 28;
        reasons.push(`rankable dimensions: ${[...dimensionColumns, ...entityColumns].slice(0, 4).map((column) => column.name).join(', ')}`);
        reasons.push(`measures: ${measureColumns.slice(0, 4).map((column) => column.name).join(', ')}`);
      }
      break;
    default:
      break;
  }

  if (score === 0 && termHits.length >= 2 && (measureColumns.length > 0 || entityColumns.length > 0)) {
    score += 18;
  }

  return {
    score,
    reasons: reasons.length > 0 ? reasons : ['relation has analytical schema shape for generated SQL'],
  };
}

function informativeSchemaTerms(questionPlan: AnalysisQuestionPlan): string[] {
  const entityTerms = new Set(questionPlan.entities.flatMap((entity) => normalizeSearchText(entity.text).split(/\s+/)));
  const generic = new Set([
    'complete', 'detail', 'details', 'full', 'history', 'overview', 'profile', 'research',
    'reserach', 'stat', 'stats', 'statistics', 'summary',
  ]);
  return uniqueStringValues([
    ...questionPlan.metricTerms,
    ...questionPlan.dimensionTerms,
    ...questionPlan.timeTerms,
    ...questionPlan.searchTerms,
  ].flatMap((value) => normalizeSearchText(value).split(/\s+/)))
    .filter((term) => term.length >= 3 && !entityTerms.has(term) && !generic.has(term));
}

function relationSearchTextForCatalog(relation: MetadataAllowedSqlRelation): string {
  return [
    relation.relation,
    relation.name,
    relation.source,
    relation.columns.map((column) => `${column.name} ${column.type ?? ''} ${column.description ?? ''}`).join(' '),
  ].join(' ');
}

function relationLooksEntityCentric(relation: MetadataAllowedSqlRelation): boolean {
  return /\b(dim|dimension|entity|profile|customer|account|user|person|member|player|athlete|product|vendor|supplier|employee|merchant|team)\b/i
    .test(`${relation.name} ${relation.relation}`);
}

function isEntityIdentifyingColumn(name: string): boolean {
  const normalized = normalizeColumnToken(name);
  if (/(^|_)(name|full_name|display_name|title|email|username)$/.test(normalized)) return true;
  if (/(^|_)(customer|account|user|member|person|player|athlete|product|sku|vendor|supplier|employee|merchant|team|organization|company|store|location)_(id|key|uuid|sk|name|email)$/.test(normalized)) {
    return true;
  }
  return /(^|_)(customer|account|user|member|person|player|athlete|product|vendor|supplier|employee|merchant|team|organization|company|store|location)$/.test(normalized);
}

function isDimensionLikeColumn(name: string): boolean {
  const normalized = normalizeColumnToken(name);
  if (isTimeLikeColumn(normalized) || isMeasureColumnName(normalized)) return false;
  return /(^|_)(category|channel|class|cohort|country|department|division|group|market|name|position|region|segment|status|team|territory|type|zone)$/.test(normalized) ||
    /(customer|account|user|member|person|player|athlete|product|sku|vendor|supplier|employee|merchant|team|organization|company|store|location)_(name|type|segment|category|status|group|region)$/.test(normalized);
}

function isMeasureLikeColumn(column: RuntimeSchemaColumn): boolean {
  const normalized = normalizeColumnToken(column.name);
  if (isJoinKeyColumnForCatalog(normalized) || isTimeLikeColumn(normalized)) return false;
  if (/^(?:season|year|month|week|quarter|rank|row_number)$/.test(normalized)) return false;
  return isMeasureColumnName(normalized) || isNumericColumnType(column.type);
}

function isMeasureColumnName(normalizedName: string): boolean {
  return /(^|_)(amount|arr|ast|assist|assists|avg|average|balance|bookings|count|cost|duration|expense|goal|goals|margin|minutes|mrr|orders|points|profit|pts|quantity|rate|reb|rebound|rebounds|revenue|sales|score|scores|spend|stat|stats|total|usage|value|volume)$/.test(normalizedName);
}

function isNumericColumnType(type: string | undefined): boolean {
  return Boolean(type && /\b(bigint|decimal|double|float|int|integer|number|numeric|real)\b/i.test(type));
}

function normalizeColumnToken(value: string): string {
  return value.replace(/["`]/g, '').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function uniqueStringValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isSqlColumnObject(object: MetadataObject): boolean {
  return object.objectType === 'dbt_column' || object.objectType === 'runtime_column';
}

function isSqlParentObject(object: MetadataObject): boolean {
  return object.objectType === 'dbt_model' ||
    object.objectType === 'dbt_source' ||
    object.objectType === 'warehouse_table' ||
    object.objectType === 'runtime_table';
}

/** Column budget for a single relation in the prompt's allowed-SQL context. */
const MAX_ALLOWED_SQL_COLUMNS = 120;

/**
 * Relevance score for keeping a column when a wide relation must be truncated (W3.3).
 * Structural columns (join keys, time/grain) always score so joins and grain survive;
 * a column whose name overlaps the question scores highest so the needed column on a
 * 300-column table is not dropped just because it sits past the budget cut.
 */
function columnBudgetScore(name: string, questionTokens?: string[]): number {
  const lower = name.toLowerCase();
  let score = 0;
  if (/(^|_)(id|key)$/.test(lower) || lower === 'id') score += 3;
  if (/(date|time|_at$|_ts$|day|month|year|week|quarter)/.test(lower)) score += 2;
  if (questionTokens) {
    for (const token of questionTokens) {
      if (token.length > 2 && lower.includes(token)) { score += 5; break; }
    }
  }
  return score;
}

/**
 * Cap a relation's column list to the prompt budget and downgrade completeness to
 * 'partial' when columns are dropped. Keeping a truncated relation 'complete' would
 * let column validation false-positive a valid column past the cut as unknown_column
 * (the >120-column latent bug, W1.4). When truncating, keep the columns most relevant
 * to the question + structural keys (W3.3) rather than the arbitrary first-N, then
 * restore original order among the survivors so prompt ordering is unchanged.
 */
function capAllowedSqlColumns(
  columns: MetadataAllowedSqlRelation['columns'],
  completeness: MetadataAllowedSqlRelation['columnCompleteness'],
  questionTokens?: string[],
): { columns: MetadataAllowedSqlRelation['columns']; columnCompleteness: MetadataAllowedSqlRelation['columnCompleteness'] } {
  if (columns.length <= MAX_ALLOWED_SQL_COLUMNS) {
    return { columns, columnCompleteness: completeness };
  }
  const kept = columns
    .map((column, index) => ({ column, index, score: columnBudgetScore(column.name, questionTokens) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, MAX_ALLOWED_SQL_COLUMNS)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.column);
  return { columns: kept, columnCompleteness: 'partial' };
}

/** Lowercased word tokens from the question, for column-relevance ranking. */
function tokenizeQuestionForColumns(question: string): string[] {
  return (question.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((token) => token.length > 2);
}

const FULL_CATALOG_RELATION_TYPES = ['dbt_model', 'dbt_source', 'warehouse_table', 'runtime_table'];
const FULL_CATALOG_COLUMN_TYPES = ['dbt_column', 'warehouse_column', 'runtime_column'];
/** Deep mode over a catalog this small hands the model everything instead of top-k. */
const FULL_CATALOG_MAX_RELATIONS = 40;
const FULL_CATALOG_MAX_COLUMNS = 2000;

/**
 * When the whole catalog is small enough to fit in context, return every relation
 * and column object so deep-research mode can reason over the complete schema.
 * Returns undefined when the catalog exceeds the small-catalog budget, so ranked
 * top-k selection stays in force for large warehouses.
 */
function collectFullCatalogObjects(catalog: MetadataCatalog): MetadataObject[] | undefined {
  const relations = catalog.listObjects({
    objectTypes: FULL_CATALOG_RELATION_TYPES,
    limit: FULL_CATALOG_MAX_RELATIONS + 1,
  });
  if (relations.length === 0 || relations.length > FULL_CATALOG_MAX_RELATIONS) return undefined;
  const columns = catalog.listObjects({
    objectTypes: FULL_CATALOG_COLUMN_TYPES,
    limit: FULL_CATALOG_MAX_COLUMNS + 1,
  });
  if (columns.length > FULL_CATALOG_MAX_COLUMNS) return undefined;
  return mergeObjects([...relations, ...columns]);
}

export function buildAllowedSqlContext(objects: MetadataObject[], edges: MetadataEdge[], questionTokens?: string[]): MetadataAllowedSqlContext {
  const byRelation = new Map<string, MetadataAllowedSqlRelation>();
  const objectsByKey = new Map(objects.map((object) => [object.objectKey, object]));
  const addRelation = (relation: MetadataAllowedSqlRelation) => {
    const key = normalizeRelationKey(relation.relation);
    if (!key) return;
    const existing = byRelation.get(key);
    if (!existing) {
      const capped = capAllowedSqlColumns(dedupeRuntimeColumns(relation.columns), relation.columnCompleteness, questionTokens);
      byRelation.set(key, { ...relation, columns: capped.columns, columnCompleteness: capped.columnCompleteness });
      return;
    }
    const capped = capAllowedSqlColumns(mergeRelationColumns(existing, relation), mergeRelationCompletenessForCatalog(existing, relation), questionTokens);
    byRelation.set(key, {
      ...existing,
      objectKey: existing.objectKey ?? relation.objectKey,
      source: mergeRelationSources(existing.source, relation.source),
      columnCompleteness: capped.columnCompleteness,
      columns: capped.columns,
    });
  };

  for (const object of objects) {
    if (object.objectType === 'warehouse_table' && !warehouseTableHasTrustedReference(object, objectsByKey)) {
      continue;
    }
    const relation = metadataObjectToAllowedSqlRelation(object);
    if (relation) addRelation(relation);
    // Semantic metrics and members carry their governed physical binding in
    // payload.table. Once one of those objects is selected, that relation must
    // be part of the inspected SQL context; otherwise preview validation can
    // reject the exact table the semantic layer instructed the agent to use.
    // Keep completeness partial until a dbt/runtime object contributes columns.
    if (['semantic_metric', 'semantic_member', 'semantic_measure', 'semantic_dimension', 'semantic_entity', 'semantic_model'].includes(object.objectType)) {
      const semanticTable = metadataPayloadString(object, 'table');
      if (semanticTable) {
        addRelation({
          relation: semanticTable,
          name: semanticTable.split('.').at(-1) ?? semanticTable,
          objectKey: object.objectKey,
          source: 'semantic layer backing relation',
          columnCompleteness: 'partial',
          columns: [],
        });
      }
    }
    if (object.objectType === 'dql_block' && !isCertifiedMetadataObject(object)) {
      continue;
    }
    for (const table of metadataStringArray(object.payload?.tableDependencies)) {
      addRelation({
        relation: table,
        name: table.split('.').at(-1) ?? table,
        objectKey: object.objectKey,
        source: 'certified block dependency',
        columnCompleteness: 'partial',
        columns: [],
      });
    }
    for (const table of metadataStringArray(object.payload?.rawTableRefs)) {
      addRelation({
        relation: table,
        name: table.split('.').at(-1) ?? table,
        objectKey: object.objectKey,
        source: 'certified block SQL reference',
        columnCompleteness: 'partial',
        columns: [],
      });
    }
    const sourceSql = typeof object.payload?.sql === 'string' ? object.payload.sql.trim() : '';
    const shape = sourceSql ? extractSimpleSelectShape(sourceSql) : undefined;
    if (shape) {
      addRelation({
        relation: shape.relation,
        name: shape.relation.split('.').at(-1) ?? shape.relation,
        objectKey: object.objectKey,
        source: 'certified source SQL shape',
        columnCompleteness: 'partial',
        columns: sourceSqlShapeColumns(sourceSql),
      });
    }
  }

  for (const edge of edges) {
    if (edge.edgeType !== 'maps_to_dbt_model' && edge.edgeType !== 'uses_dbt_model') continue;
    const from = objectsByKey.get(edge.fromKey);
    const to = objectsByKey.get(edge.toKey);
    const fromRelation = from ? metadataObjectToAllowedSqlRelation(from) : null;
    const toRelation = to ? metadataObjectToAllowedSqlRelation(to) : null;
    if (fromRelation && toRelation) addRelation({ ...fromRelation, columns: toRelation.columns, columnCompleteness: toRelation.columnCompleteness, source: 'dbt mapped warehouse table' });
  }

  applyLineageColumnAliases(byRelation, objectsByKey, edges);

  return {
    relations: coalesceRelationAliases(Array.from(byRelation.values()))
      .sort((a, b) => a.relation.localeCompare(b.relation)),
    sourceBlockSql: objects
      .filter((object) =>
        object.objectType === 'dql_block' &&
        isCertifiedMetadataObject(object) &&
        typeof object.payload?.sql === 'string' &&
        object.payload.sql.trim())
      .slice(0, 8)
      .map((object) => ({
        objectKey: object.objectKey,
        name: object.name,
        status: object.status,
        sql: String(object.payload?.sql ?? ''),
        description: typeof object.payload?.description === 'string' ? object.payload.description : undefined,
        exampleQuestion: firstExampleQuestion(object.payload?.examples),
        grain: typeof object.payload?.grain === 'string' ? object.payload.grain : undefined,
      })),
  };
}

function applyLineageColumnAliases(
  byRelation: Map<string, MetadataAllowedSqlRelation>,
  objectsByKey: Map<string, MetadataObject>,
  edges: MetadataEdge[],
): void {
  const aliasesByRelationAndColumn = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.edgeType !== 'derives_from') continue;
    const from = objectsByKey.get(edge.fromKey);
    const to = objectsByKey.get(edge.toKey);
    if (!from || !to) continue;
    const targetRelation = metadataObjectToAllowedSqlRelation(to);
    if (!targetRelation) continue;
    const alias = semanticAliasFromLineageOutput(from);
    if (!alias || namesEqualForCatalog(alias, to.name)) continue;
    const relationKey = normalizeRelationKey(targetRelation.relation);
    const columnKey = normalizeColumnKeyForCatalog(to.name);
    if (!relationKey || !columnKey) continue;
    const mapKey = `${relationKey}\u0000${columnKey}`;
    const existing = aliasesByRelationAndColumn.get(mapKey) ?? new Set<string>();
    existing.add(alias);
    aliasesByRelationAndColumn.set(mapKey, existing);
  }
  if (aliasesByRelationAndColumn.size === 0) return;

  for (const [relationKey, relation] of byRelation) {
    const columns = relation.columns.map((column) => {
      const aliases = aliasesByRelationAndColumn.get(`${relationKey}\u0000${normalizeColumnKeyForCatalog(column.name)}`);
      if (!aliases?.size) return column;
      const aliasText = Array.from(aliases).sort().slice(0, 8).join(', ');
      const suffix = `Governed aliases from lineage: ${aliasText}.`;
      const description = column.description
        ? column.description.includes(suffix)
          ? column.description
          : `${column.description} ${suffix}`
        : suffix;
      return { ...column, description };
    });
    byRelation.set(relationKey, { ...relation, columns });
  }
}

function semanticAliasFromLineageOutput(object: MetadataObject): string | undefined {
  const candidates = [
    typeof object.payload?.output === 'string' ? object.payload.output : undefined,
    object.name,
    object.fullName?.split('.').at(-1),
  ];
  for (const candidate of candidates) {
    const alias = normalizeLineageAlias(candidate);
    if (alias) return alias;
  }
  return undefined;
}

function normalizeLineageAlias(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/["`]/g, '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === '*' || normalized === '?') return undefined;
  if (normalized.length > 64) return undefined;
  return normalized;
}

function normalizeColumnKeyForCatalog(value: string): string {
  return value.replace(/["`]/g, '').trim().toLowerCase();
}

function namesEqualForCatalog(left: string, right: string): boolean {
  return normalizeColumnKeyForCatalog(left).replace(/[_\s]+/g, '') ===
    normalizeColumnKeyForCatalog(right).replace(/[_\s]+/g, '');
}

// Pull the first natural-language example question off a block payload so the
// certified block can serve as a question→SQL few-shot exemplar.
function firstExampleQuestion(examples: unknown): string | undefined {
  if (!Array.isArray(examples)) return undefined;
  for (const example of examples) {
    if (typeof example === 'string' && example.trim()) return example.trim();
    if (example && typeof example === 'object') {
      const question = (example as { question?: unknown }).question;
      if (typeof question === 'string' && question.trim()) return question.trim();
    }
  }
  return undefined;
}

function buildSelectedJoinPaths(
  allowedSqlContext: MetadataAllowedSqlContext,
  edges: MetadataEdge[],
  objects: MetadataObject[] = [],
): NonNullable<LocalContextPack['retrievalDiagnostics']['selectedJoinPaths']> {
  const relations = allowedSqlContext.relations
    .filter((relation) => relation.columns.some((column) => isJoinKeyColumnForCatalog(column.name)))
    .slice(0, 16);
  const joins: NonNullable<LocalContextPack['retrievalDiagnostics']['selectedJoinPaths']> = [];
  const seen = new Set<string>();
  const lookup = buildSelectedRelationLookup(relations);
  const pushJoin = (join: NonNullable<LocalContextPack['retrievalDiagnostics']['selectedJoinPaths']>[number]) => {
    const key = catalogJoinDedupeKey(join.leftRelation, join.leftColumn, join.rightRelation, join.rightColumn);
    if (seen.has(key)) return;
    seen.add(key);
    joins.push(join);
  };

  // CTX-008: authored DQL relationships come first. `pushJoin` keeps the first
  // writer of a relation pair, so running this pass ahead of dbt lineage and
  // the shared-column heuristic means a relationship the user certified always
  // outranks a column-name guess. This is a ranking change only — REL-002 still
  // decides whether the join may actually execute.
  const modeledLookup = buildSelectedRelationLookup(allowedSqlContext.relations);
  for (const object of objects) {
    if (object.objectType !== 'relationship') continue;
    const payload = (object.payload ?? {}) as {
      from?: string; to?: string; keys?: Array<{ from: string; to: string }>;
      cardinality?: string; fanout?: string; automaticJoinAllowed?: boolean; verb?: string;
    };
    const keys = payload.keys ?? [];
    if (!payload.from || !payload.to || keys.length === 0) continue;
    const left = lookupRelationForCatalogEdge(`entity:${payload.from}`, modeledLookup)
      ?? lookupRelationForCatalogEdge(payload.from, modeledLookup);
    const right = lookupRelationForCatalogEdge(`entity:${payload.to}`, modeledLookup)
      ?? lookupRelationForCatalogEdge(payload.to, modeledLookup);
    if (!left || !right || normalizeRelationKey(left.relation) === normalizeRelationKey(right.relation)) continue;
    for (const key of keys) {
      if (!relationHasColumn(left, key.from) || !relationHasColumn(right, key.to)) continue;
      const trust = payload.automaticJoinAllowed ? 'certified' : `${object.status ?? 'draft'} (review required)`;
      pushJoin({
        leftRelation: left.relation,
        leftColumn: key.from,
        rightRelation: right.relation,
        rightColumn: key.to,
        reason: `DQL relationship ${object.name}${payload.verb ? ` (${payload.verb})` : ''}: ${payload.cardinality ?? 'unknown'} cardinality, ${payload.fanout ?? 'unknown'} fanout, ${trust}`,
        confidence: payload.automaticJoinAllowed ? 1 : 0.95,
        source: 'dql_relationship',
      });
    }
  }

  for (const edge of edges) {
    if (edge.edgeType !== 'depends_on') continue;
    const left = lookupRelationForCatalogEdge(edge.fromKey, lookup);
    const right = lookupRelationForCatalogEdge(edge.toKey, lookup);
    if (!left || !right || normalizeRelationKey(left.relation) === normalizeRelationKey(right.relation)) continue;
    const join = pickCatalogJoinColumns(left, right);
    if (!join) continue;
    pushJoin({
      leftRelation: left.relation,
      leftColumn: join.leftColumn,
      rightRelation: right.relation,
      rightColumn: join.rightColumn,
      reason: `dbt lineage: ${left.name} depends_on ${right.name}; ${catalogJoinReason(join.leftColumn, join.rightColumn, join.confidence)}`,
      confidence: Math.max(join.confidence, 0.98),
      source: 'dbt_lineage',
    });
  }

  // DataLex modeled relationships: grain-safe joins on the declared canonical
  // columns (verified to exist on both relations), ranked above name heuristics.
  const datalexLookup = buildSelectedRelationLookup(allowedSqlContext.relations);
  for (const edge of edges) {
    if (edge.edgeType !== 'datalex_join') continue;
    const left = lookupRelationForCatalogEdge(edge.fromKey, datalexLookup);
    const right = lookupRelationForCatalogEdge(edge.toKey, datalexLookup);
    if (!left || !right || normalizeRelationKey(left.relation) === normalizeRelationKey(right.relation)) continue;
    const payload = (edge.payload ?? {}) as { fromColumn?: string; toColumn?: string; cardinality?: string; name?: string };
    const guessed = pickCatalogJoinColumns(left, right);
    const leftColumn = relationHasColumn(left, payload.fromColumn) ? payload.fromColumn! : guessed?.leftColumn;
    const rightColumn = relationHasColumn(right, payload.toColumn) ? payload.toColumn! : guessed?.rightColumn;
    if (!leftColumn || !rightColumn) continue;
    pushJoin({
      leftRelation: left.relation,
      leftColumn,
      rightRelation: right.relation,
      rightColumn,
      reason: `DataLex relationship${payload.name ? ` ${payload.name}` : ''}${payload.cardinality ? ` (${payload.cardinality})` : ''}`,
      confidence: edge.confidence ?? 0.9,
      source: 'datalex',
    });
  }

  for (let leftIndex = 0; leftIndex < relations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < relations.length; rightIndex += 1) {
      const left = relations[leftIndex]!;
      const right = relations[rightIndex]!;
      const join = pickCatalogJoinColumns(left, right);
      if (!join) continue;
      const oriented = orientCatalogJoinPath(left, right, join);
      pushJoin({
        leftRelation: oriented.leftRelation.relation,
        leftColumn: oriented.leftColumn,
        rightRelation: oriented.rightRelation.relation,
        rightColumn: oriented.rightColumn,
        reason: catalogJoinReason(join.leftColumn, join.rightColumn, join.confidence),
        confidence: join.confidence,
        source: 'metadata_guess',
      });
    }
  }
  return joins
    .sort((a, b) => joinSourceRank(a.source) - joinSourceRank(b.source) || b.confidence - a.confidence || a.leftRelation.localeCompare(b.leftRelation))
    .slice(0, 12);
}

function buildSelectedRelationLookup(relations: MetadataAllowedSqlRelation[]): {
  byObjectKey: Map<string, MetadataAllowedSqlRelation>;
  byLookupKey: Map<string, MetadataAllowedSqlRelation[]>;
} {
  const byObjectKey = new Map<string, MetadataAllowedSqlRelation>();
  const byLookupKey = new Map<string, MetadataAllowedSqlRelation[]>();
  const addLookup = (key: string | undefined, relation: MetadataAllowedSqlRelation) => {
    const normalized = normalizeRelationKey(key ?? '');
    if (!normalized) return;
    const existing = byLookupKey.get(normalized) ?? [];
    if (!existing.some((candidate) => normalizeRelationKey(candidate.relation) === normalizeRelationKey(relation.relation))) {
      existing.push(relation);
    }
    byLookupKey.set(normalized, existing);
  };
  for (const relation of relations) {
    if (relation.objectKey) byObjectKey.set(relation.objectKey, relation);
    addLookup(relation.relation, relation);
    addLookup(relation.name, relation);
    addLookup(relationTailKey(relation.relation), relation);
  }
  return { byObjectKey, byLookupKey };
}

function lookupRelationForCatalogEdge(
  edgeKey: string,
  lookup: ReturnType<typeof buildSelectedRelationLookup>,
): MetadataAllowedSqlRelation | undefined {
  const exact = lookup.byObjectKey.get(edgeKey);
  if (exact) return exact;
  const tail = edgeKey.split(':').at(-1);
  const candidates = [
    edgeKey,
    tail,
    tail ? relationTailKey(tail) : undefined,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeRelationKey(candidate ?? '');
    if (!normalized) continue;
    const matches = lookup.byLookupKey.get(normalized);
    if (matches?.length === 1) return matches[0];
  }
  return undefined;
}

function catalogJoinDedupeKey(
  leftRelation: string,
  leftColumn: string,
  rightRelation: string,
  rightColumn: string,
): string {
  return [
    `${normalizeRelationKey(leftRelation)}.${normalizeColumnKeyForCatalog(leftColumn)}`,
    `${normalizeRelationKey(rightRelation)}.${normalizeColumnKeyForCatalog(rightColumn)}`,
  ].sort().join('|');
}

/** Map a DataLex physical binding to the metadata object key of its relation. */
function objectKeyForDataLexBinding(binding: { kind: string; ref: string }): string {
  switch (binding.kind) {
    case 'dbt_model': return `dbt:model:${binding.ref}`;
    case 'dbt_source': return `dbt:source:${binding.ref}`;
    default: return `warehouse:table:${binding.ref}`;
  }
}

function relationHasColumn(relation: MetadataAllowedSqlRelation, column: string | undefined): boolean {
  if (!column) return false;
  const target = normalizeColumnKeyForCatalog(column);
  return relation.columns.some((entry) => normalizeColumnKeyForCatalog(entry.name) === target);
}

function joinSourceRank(source: NonNullable<LocalContextPack['retrievalDiagnostics']['selectedJoinPaths']>[number]['source']): number {
  switch (source) {
    // An authored DQL relationship states the key pair; everything below it
    // infers one. Meaning-bearing evidence outranks inference.
    case 'dql_relationship': return 0;
    case 'dbt_lineage': return 1;
    case 'datalex': return 2;
    case 'kg_path': return 3;
    case 'metadata_guess': return 4;
    default: return 5;
  }
}

function orientCatalogJoinPath(
  left: MetadataAllowedSqlRelation,
  right: MetadataAllowedSqlRelation,
  join: { leftColumn: string; rightColumn: string; confidence: number },
): {
  leftRelation: MetadataAllowedSqlRelation;
  leftColumn: string;
  rightRelation: MetadataAllowedSqlRelation;
  rightColumn: string;
} {
  if (catalogRelationFactScore(right) > catalogRelationFactScore(left)) {
    return {
      leftRelation: right,
      leftColumn: join.rightColumn,
      rightRelation: left,
      rightColumn: join.leftColumn,
    };
  }
  return {
    leftRelation: left,
    leftColumn: join.leftColumn,
    rightRelation: right,
    rightColumn: join.rightColumn,
  };
}

function catalogRelationFactScore(relation: MetadataAllowedSqlRelation): number {
  const text = normalizeRelationKey([relation.name, relation.relation].join(' ')).replace(/[._-]+/g, ' ');
  let score = 0;
  if (/\b(fct|fact)\b/i.test(text)) score += 20;
  if (/\b(order items?|orders?|events?|transactions?|performance|activity|usage|revenue|sales|payments?|line items?|stats?)\b/i.test(text)) score += 8;
  if (/\b(dim|dimension)\b/i.test(text)) score -= 18;
  if (/\b(customers?|products?|players?|accounts?|users?|segments?|regions?)\b/i.test(text)) score -= 4;
  return score;
}

function pickCatalogJoinColumns(
  left: MetadataAllowedSqlRelation,
  right: MetadataAllowedSqlRelation,
): { leftColumn: string; rightColumn: string; confidence: number } | undefined {
  const candidates: Array<{ leftColumn: string; rightColumn: string; confidence: number }> = [];
  const leftColumns = left.columns.filter((column) => isJoinKeyColumnForCatalog(column.name)).slice(0, 32);
  const rightColumns = right.columns.filter((column) => isJoinKeyColumnForCatalog(column.name)).slice(0, 32);
  for (const leftColumn of leftColumns) {
    for (const rightColumn of rightColumns) {
      const confidence = catalogJoinConfidence(leftColumn.name, rightColumn.name, left, right);
      if (confidence <= 0) continue;
      candidates.push({ leftColumn: leftColumn.name, rightColumn: rightColumn.name, confidence });
    }
  }
  return candidates.sort((a, b) => b.confidence - a.confidence || a.leftColumn.localeCompare(b.leftColumn))[0];
}

function catalogJoinConfidence(
  leftColumn: string,
  rightColumn: string,
  leftRelation: MetadataAllowedSqlRelation,
  rightRelation: MetadataAllowedSqlRelation,
): number {
  const left = normalizeJoinColumnName(leftColumn);
  const right = normalizeJoinColumnName(rightColumn);
  if (!isJoinKeyColumnForCatalog(left) || !isJoinKeyColumnForCatalog(right)) return 0;
  if (left === right) return 0.92;
  const leftSubject = joinSubjectForCatalog(left);
  const rightSubject = joinSubjectForCatalog(right);
  if (leftSubject && rightSubject && leftSubject === rightSubject) return 0.86;
  const leftRelationTokens = relationEntityTokensForCatalog(leftRelation);
  const rightRelationTokens = relationEntityTokensForCatalog(rightRelation);
  if (leftSubject && right === 'id' && rightRelationTokens.has(leftSubject)) return 0.78;
  if (rightSubject && left === 'id' && leftRelationTokens.has(rightSubject)) return 0.78;
  return 0;
}

function catalogJoinReason(leftColumn: string, rightColumn: string, confidence: number): string {
  if (leftColumn.toLowerCase() === rightColumn.toLowerCase()) return `shared key ${leftColumn}`;
  const leftSubject = joinSubjectForCatalog(leftColumn);
  const rightSubject = joinSubjectForCatalog(rightColumn);
  if (leftSubject && rightSubject && leftSubject === rightSubject) return `matching ${leftSubject} key`;
  if (confidence >= 0.75) return 'foreign-key style id match';
  return 'join-key style column match';
}

function isJoinKeyColumnForCatalog(column: string): boolean {
  const normalized = normalizeJoinColumnName(column);
  return normalized === 'id' ||
    /(^|_)(id|key|uuid|sk)$/.test(normalized) ||
    /_(id|key|uuid|sk)$/.test(normalized);
}

function joinSubjectForCatalog(column: string): string | undefined {
  const normalized = normalizeJoinColumnName(column);
  const subject = normalized.replace(/_(id|key|uuid|sk)$/i, '');
  if (!subject || subject === normalized || subject === 'id' || subject === 'key') return undefined;
  return normalizeSingularToken(subject.split('_').at(-1) ?? subject);
}

function relationEntityTokensForCatalog(relation: MetadataAllowedSqlRelation): Set<string> {
  const tokens = new Set<string>();
  for (const raw of [relation.name, relation.relation.split('.').at(-1) ?? relation.relation].join(' ').toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    for (const part of raw.split('_')) {
      const token = normalizeSingularToken(part);
      if (!token || token.length < 2 || ['dim', 'fct', 'fact', 'stg', 'stage', 'model', 'table'].includes(token)) continue;
      tokens.add(token);
    }
  }
  return tokens;
}

function normalizeJoinColumnName(column: string): string {
  return column.replace(/["`]/g, '').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function normalizeSingularToken(token: string): string {
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}

function coalesceRelationAliases(relations: MetadataAllowedSqlRelation[]): MetadataAllowedSqlRelation[] {
  const qualifiedByTail = new Map<string, MetadataAllowedSqlRelation[]>();
  for (const relation of relations) {
    const tailKey = relationTailKey(relation.relation);
    if (!tailKey || !relation.relation.includes('.')) continue;
    const existing = qualifiedByTail.get(tailKey) ?? [];
    existing.push(relation);
    qualifiedByTail.set(tailKey, existing);
  }

  const mergedByRelation = new Map(relations.map((relation) => [normalizeRelationKey(relation.relation), relation]));
  const skipped = new Set<string>();
  for (const relation of relations) {
    const relationKey = normalizeRelationKey(relation.relation);
    const tailKey = relationTailKey(relation.relation);
    if (!tailKey || relation.relation.includes('.')) continue;
    const targets = qualifiedByTail.get(tailKey) ?? [];
    if (targets.length !== 1) continue;
    const target = targets[0]!;
    const targetKey = normalizeRelationKey(target.relation);
    const capped = capAllowedSqlColumns(mergeRelationColumns(target, relation), mergeRelationCompletenessForCatalog(target, relation));
    mergedByRelation.set(targetKey, {
      ...target,
      objectKey: target.objectKey ?? relation.objectKey,
      source: mergeRelationSources(target.source, relation.source),
      columnCompleteness: capped.columnCompleteness,
      columns: capped.columns,
    });
    skipped.add(relationKey);
  }

  return Array.from(mergedByRelation.entries())
    .filter(([key]) => !skipped.has(key))
    .map(([, relation]) => relation);
}

function mergeRelationColumns(
  existing: Pick<MetadataAllowedSqlRelation, 'source' | 'columns'>,
  incoming: Pick<MetadataAllowedSqlRelation, 'source' | 'columns'>,
): RuntimeSchemaColumn[] {
  const existingIsSourceShape = relationSourceIncludes(existing.source, 'certified source SQL shape');
  const incomingIsSourceShape = relationSourceIncludes(incoming.source, 'certified source SQL shape');
  if (existingIsSourceShape && !incomingIsSourceShape) {
    return dedupeRuntimeColumns([...incoming.columns, ...existing.columns]);
  }
  if (!existingIsSourceShape && incomingIsSourceShape) {
    return dedupeRuntimeColumns([...existing.columns, ...incoming.columns]);
  }
  return dedupeRuntimeColumns([...existing.columns, ...incoming.columns]);
}

function mergeRelationCompletenessForCatalog(
  existing: Pick<MetadataAllowedSqlRelation, 'columnCompleteness' | 'columns'>,
  incoming: Pick<MetadataAllowedSqlRelation, 'columnCompleteness' | 'columns'>,
): MetadataAllowedSqlRelation['columnCompleteness'] {
  if (relationCompletenessValue(existing) === 'complete' || relationCompletenessValue(incoming) === 'complete') {
    return 'complete';
  }
  return 'partial';
}

function relationCompletenessValue(relation: Pick<MetadataAllowedSqlRelation, 'columnCompleteness' | 'columns'>): 'complete' | 'partial' {
  if (relation.columnCompleteness) return relation.columnCompleteness;
  return relation.columns.length === 0 ? 'partial' : 'complete';
}

function relationSourceIncludes(source: string | undefined, value: string): boolean {
  return Boolean(source && source.split(/\s+\+\s+/).some((part) => part.trim() === value));
}

function relationTailKey(relation: string): string {
  const parts = normalizeRelationKey(relation).split('.').filter(Boolean);
  return parts.at(-1) ?? '';
}

function mergeRelationSources(left: string, right: string): string {
  if (left === right) return left;
  const parts = [...left.split(/\s+\+\s+/), ...right.split(/\s+\+\s+/)]
    .map((part) => part.trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).join(' + ');
}

function warehouseTableHasTrustedReference(
  object: MetadataObject,
  objectsByKey: Map<string, MetadataObject>,
): boolean {
  const refs = metadataStringArray(object.payload?.referencedBy);
  if (refs.length === 0) return true;
  if (refs.some((ref) => !ref.startsWith('block:'))) return true;
  return refs.some((ref) => {
    const blockName = ref.slice('block:'.length);
    const block = objectsByKey.get(`dql:block:${blockName}`);
    return block ? isCertifiedMetadataObject(block) : false;
  });
}

export function metadataObjectToAllowedSqlRelation(object: MetadataObject): MetadataAllowedSqlRelation | null {
  if (object.objectType === 'runtime_value') {
    const relation = metadataPayloadString(object, 'relation');
    const columnName = metadataPayloadString(object, 'column');
    if (!relation || !columnName) return null;
    return {
      relation,
      name: relation.split('.').at(-1) ?? relation,
      objectKey: object.objectKey,
      source: 'runtime value index',
      columnCompleteness: 'partial',
      columns: [{
        name: columnName,
        type: metadataPayloadString(object, 'type'),
        sampleValues: metadataStringArray(object.payload?.sampleValues),
      }],
    };
  }
  if (object.objectType === 'dbt_column' || object.objectType === 'runtime_column' || object.objectType === 'warehouse_column') {
    const relation = metadataPayloadString(object, 'relation');
    if (!relation) return null;
    return {
      relation,
      name: relation.split('.').at(-1) ?? relation,
      objectKey: object.objectKey,
	      source: object.objectType === 'runtime_column'
	        ? 'runtime schema snapshot'
	        : object.objectType === 'warehouse_column'
	          ? 'DQL block column lineage'
	          : 'dbt manifest',
	      columnCompleteness: 'partial',
	      columns: [{
        name: object.name,
        type: metadataPayloadString(object, 'type') ?? metadataPayloadString(object, 'data_type'),
        description: object.description,
        sampleValues: metadataStringArray(object.payload?.sampleValues),
      }],
    };
  }
  if (!['dbt_model', 'dbt_source', 'warehouse_table', 'runtime_table'].includes(object.objectType)) return null;
  const relation = metadataPayloadString(object, 'relation') ?? object.fullName ?? object.name;
  return {
    relation,
    name: relation.split('.').at(-1) ?? object.name,
    objectKey: object.objectKey,
    source: object.objectType === 'runtime_table' ? 'runtime schema snapshot' : object.sourceSystem ?? 'local metadata catalog',
    columnCompleteness: relationColumnCompletenessFromObject(object),
    columns: metadataRuntimeColumns(object.payload?.columns),
  };
}

function relationColumnCompletenessFromObject(object: MetadataObject): MetadataAllowedSqlRelation['columnCompleteness'] {
  if (object.objectType === 'runtime_table') return 'complete';
  if (object.payload?.columnCompleteness === 'complete' || object.payload?.catalogColumnCompleteness === 'complete') return 'complete';
  if (object.payload?.columnCompleteness === 'partial' || object.payload?.catalogColumnCompleteness === 'partial') return 'partial';
  if (object.objectType === 'warehouse_table') return 'partial';
  return 'partial';
}

function runtimeSchemaObjects(snapshot: RuntimeSchemaSnapshot): MetadataObject[] {
  const capturedAt = snapshot.capturedAt ?? new Date().toISOString();
  return normalizeRuntimeSchemaTables(snapshot.tables).flatMap((table) => {
    const relation = table.relation;
    const tableObject = runtimeSchemaTableObject(table, snapshot.source, capturedAt);
    const columns = table.columns.map((column) => ({
      objectKey: `runtime:column:${relation}.${column.name}`,
      objectType: 'runtime_column',
      name: column.name,
      fullName: `${relation}.${column.name}`,
      description: column.description,
      status: 'runtime_observed',
      sourceSystem: snapshot.source ?? table.source ?? 'runtime schema snapshot',
      payload: compactObject({
        relation,
        type: column.type,
        columnCompleteness: 'partial',
        sampleValues: column.sampleValues,
      }),
      updatedAt: capturedAt,
    }));
    return [tableObject, ...columns];
  });
}

function runtimeSchemaTableObject(
  table: RuntimeSchemaTable,
  snapshotSource: string | undefined,
  capturedAt: string,
): MetadataObject {
  const relation = table.relation;
  return {
    objectKey: `runtime:table:${relation}`,
    objectType: 'runtime_table',
    name: table.name ?? relation.split('.').at(-1) ?? relation,
    fullName: relation,
    description: table.description,
    status: 'runtime_observed',
    sourceSystem: snapshotSource ?? table.source ?? 'runtime schema snapshot',
    payload: compactObject({
      relation,
      catalogOrDatabase: table.catalogOrDatabase,
      schema: table.schema,
      columnCompleteness: 'complete',
      columns: table.columns,
    }),
    updatedAt: capturedAt,
  };
}

function runtimeValueMatchObjects(matches: RuntimeValueMatch[]): MetadataObject[] {
  return matches.map((match) => ({
    objectKey: match.valueKey,
    objectType: 'runtime_value',
    name: `${match.columnName} = ${match.value}`,
    fullName: `${match.relation}.${match.columnName}:${match.value}`,
    description: `Observed value "${match.value}" in ${match.relation}.${match.columnName}.`,
    status: 'runtime_observed',
    sourceSystem: match.source ?? 'runtime value index',
    score: match.score,
    payload: compactObject({
      relation: match.relation,
      schema: match.schema,
      table: match.tableName,
      column: match.columnName,
      type: match.columnType,
      value: match.value,
      normalizedValue: match.normalizedValue,
      sampleValues: [match.value],
      capturedAt: match.capturedAt,
    }),
    updatedAt: match.capturedAt,
  }));
}

function selectedContextObjects(value: unknown): MetadataObject[] {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!root) return [];
  const selected = root.selectedBlock && typeof root.selectedBlock === 'object' ? root.selectedBlock as Record<string, unknown> : root;
  const title = stringValue(selected.title) ?? stringValue(root.dashboardTitle) ?? stringValue(root.title) ?? 'Selected app context';
  const objectKey = `selected:context:${sha256(stableStringify(selected)).slice(0, 16)}`;
  return [{
    objectKey,
    objectType: 'selected_context',
    name: title,
    description: stringValue(selected.description) ?? stringValue(root.question),
    status: stringValue(selected.certificationStatus) ?? stringValue(selected.reviewStatus),
    sourceSystem: 'selected app/notebook context',
    payload: compactObject({
      tileId: selected.tileId,
      blockId: selected.blockId,
      blockPath: selected.blockPath,
      dashboardTitle: root.dashboardTitle,
      rowCount: selected.rowCount,
      columns: selected.columns,
      rows: selectedRows(root).slice(0, 20),
    }),
  }];
}

function normalizeFollowUpContext(value: unknown): MetadataFollowUpContext | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const kind = record.kind === 'drilldown'
    ? 'drilldown'
    : record.kind === 'generic'
      ? 'generic'
      : record.kind === 'contextual'
        ? 'contextual'
        : null;
  if (!kind) return null;
  return {
    kind,
    sourceBlockName: stringValue(record.sourceBlockName),
    sourceQuestion: stringValue(record.sourceQuestion),
    sourceAnswer: stringValue(record.sourceAnswer),
    filters: metadataStringArray(record.filters),
    dimensions: metadataStringArray(record.dimensions),
    priorResultColumns: metadataStringArray(record.priorResultColumns),
    priorResultValues: metadataStringRecordArray(record.priorResultValues),
    priorResultRef: normalizePriorResultRef(record.priorResultRef),
    priorDqlArtifact: normalizePriorDqlArtifact(record.priorDqlArtifact),
    priorLimit: typeof record.priorLimit === 'number' ? record.priorLimit : undefined,
    priorMeasures: metadataStringArray(record.priorMeasures),
    memberBindings: normalizeMemberBindings(record.memberBindings),
  };
}

function normalizeMemberBindings(value: unknown): MetadataFollowUpContext['memberBindings'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const bindings = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const dimension = stringValue(record.dimension);
    const values = metadataStringArray(record.values) ?? [];
    const source: NonNullable<MetadataFollowUpContext['memberBindings']>[number]['source'] =
      record.source === 'question' || record.source === 'clarification' ? record.source : 'prior_result';
    const confidence: NonNullable<MetadataFollowUpContext['memberBindings']>[number]['confidence'] = record.confidence === 'unique_partial' || record.confidence === 'deictic'
      ? record.confidence
      : 'exact';
    if (!dimension || values.length === 0) return [];
    return [{
      dimension,
      values: values.slice(0, 24),
      source,
      confidence,
      sourceTurnId: stringValue(record.sourceTurnId),
    }];
  });
  return bindings.length > 0 ? bindings.slice(0, 12) : undefined;
}

function normalizePriorResultRef(value: unknown): MetadataFollowUpContext['priorResultRef'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = stringValue(record.id);
  const columns = metadataStringArray(record.columns) ?? [];
  if (!id || columns.length === 0) return undefined;
  const rowCount = typeof record.rowCount === 'number' && Number.isFinite(record.rowCount)
    ? record.rowCount
    : undefined;
  const sourceSql = stringValue(record.sourceSql);
  return {
    id,
    question: stringValue(record.question),
    columns: columns.slice(0, 32),
    rowCount,
    sourceSql: sourceSql ? sourceSql.slice(0, 1200) : undefined,
  };
}

function normalizePriorDqlArtifact(value: unknown): MetadataDqlArtifactReference | undefined {
  const artifact = normalizeDqlArtifactReference(value);
  if (!artifact) return undefined;
  return {
    ...artifact,
    source: artifact.source.slice(0, 3000),
    metrics: artifact.metrics?.slice(0, 32),
    dimensions: artifact.dimensions?.slice(0, 32),
    filters: artifact.filters
      ?.filter((filter) => filter.values.length > 0)
      .slice(0, 12)
      .map((filter) => ({ ...filter, values: filter.values.slice(0, 12) })),
    orderBy: artifact.orderBy?.slice(0, 12),
  };
}

/**
 * Deterministic route-commitment gate: true only when the new plan differs from
 * the prior one in FILTERS / TOP-N / TIMEFRAME alone. Any change to measures,
 * dimensions, grain, required outputs, or mode disqualifies reuse — those change
 * which artifacts/relations can answer, so the full pipeline must re-run.
 */
export function isFilterOnlyRefinement(prior: AnalysisQuestionPlan, next: AnalysisQuestionPlan): boolean {
  if (prior.mode !== next.mode) return false;
  const priorShape = prior.requestedShape;
  const nextShape = next.requestedShape;
  // Every check below is a set comparison, so two plans the planner extracted
  // NOTHING from compared equal and were declared "the same query with
  // different filters". Two unrelated questions the vocabulary does not cover
  // then reused the earlier context pack wholesale — including its committed
  // route decision. Reuse requires actual evidence of sameness on both sides.
  if (!hasPlanSignal(prior) || !hasPlanSignal(next)) return false;
  return setEqual(priorShape.measures, nextShape.measures)
    && setEqual(priorShape.dimensions, nextShape.dimensions)
    && setEqual(priorShape.requiredOutputs, nextShape.requiredOutputs)
    && (priorShape.grain ?? '') === (nextShape.grain ?? '')
    && setEqual(prior.entities.map((entity) => entity.text.toLowerCase()), next.entities.map((entity) => entity.text.toLowerCase()));
}

/** Did the planner actually read anything out of this question? */
function hasPlanSignal(plan: AnalysisQuestionPlan): boolean {
  return plan.requestedShape.measures.length > 0
    || plan.requestedShape.dimensions.length > 0
    || plan.requestedShape.requiredOutputs.length > 0
    || plan.entities.length > 0;
}

function setEqual(a: string[], b: string[]): boolean {
  const setA = new Set(a.map((value) => value.toLowerCase()));
  const setB = new Set(b.map((value) => value.toLowerCase()));
  if (setA.size !== setB.size) return false;
  for (const value of setA) if (!setB.has(value)) return false;
  return true;
}

function followUpSourceObjectKeys(followUp: MetadataFollowUpContext | null): string[] {
  if (!followUp?.sourceBlockName) return [];
  return [`dql:block:${followUp.sourceBlockName}`];
}

function followUpContextObjects(followUp: MetadataFollowUpContext | null): MetadataObject[] {
  if (!followUp) return [];
  const text = [
    followUp.kind,
    followUp.sourceBlockName ?? '',
    followUp.sourceQuestion ?? '',
    followUp.sourceAnswer ?? '',
    ...(followUp.filters ?? []),
    ...(followUp.dimensions ?? []),
    ...(followUp.priorResultColumns ?? []),
    followUp.priorResultRef?.id ? `result:${followUp.priorResultRef.id}` : '',
    followUp.priorResultRef?.question ?? '',
    ...(followUp.priorResultRef?.columns ?? []),
    followUp.priorResultRef?.sourceSql ? followUp.priorResultRef.sourceSql.slice(0, 600) : '',
    ...dqlArtifactSearchTerms(followUp.priorDqlArtifact, { includeSource: true }),
    ...Object.entries(followUp.priorResultValues ?? {}).flatMap(([key, values]) => [key, ...values]),
    ...(followUp.memberBindings ?? []).flatMap((binding) => [binding.dimension, ...binding.values]),
  ].join(' ');
  return [{
    objectKey: `selected:followup:${sha256(stableStringify(followUp)).slice(0, 16)}`,
    objectType: 'selected_context',
    name: followUp.kind === 'drilldown'
      ? 'Follow-up drilldown request'
      : followUp.kind === 'contextual'
        ? 'Conversation context (advisory)'
        : 'Follow-up request',
    description: text.trim() || undefined,
    status: 'transient_context',
    sourceSystem: 'agent follow-up context',
    payload: compactObject({
      kind: followUp.kind,
      sourceBlockName: followUp.sourceBlockName,
      sourceQuestion: followUp.sourceQuestion,
      sourceAnswer: followUp.sourceAnswer,
      filters: followUp.filters,
      dimensions: followUp.dimensions,
      priorResultColumns: followUp.priorResultColumns,
      priorResultValues: followUp.priorResultValues,
      priorResultRef: followUp.priorResultRef,
      priorDqlArtifact: followUp.priorDqlArtifact,
      priorLimit: followUp.priorLimit,
      priorMeasures: followUp.priorMeasures,
      memberBindings: followUp.memberBindings,
    }),
  }];
}

function metadataValueSearchTerms(
  question: string,
  questionPlan: AnalysisQuestionPlan,
  followUp: MetadataFollowUpContext | null,
): string[] {
  const terms: string[] = [
    ...questionPlan.entities.map((entity) => entity.text),
    ...questionPlan.filterTerms,
    ...(followUp?.filters ?? []),
    ...Object.values(followUp?.priorResultValues ?? {}).flat(),
    ...(followUp?.memberBindings ?? []).flatMap((binding) => binding.values),
  ];
  for (const match of question.matchAll(/["']([^"']{2,120})["']/g)) terms.push(match[1]);
  for (const match of question.matchAll(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g)) terms.push(match[0]);
  for (const match of question.matchAll(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){1,4}\b/g)) terms.push(match[0]);
  for (const match of question.matchAll(/\b(?:for|named|called|only|where|customer|user|account|product|region|segment|category|status)\s+([A-Za-z0-9@._-]+(?:\s+[A-Za-z0-9@._-]+){0,4})/gi)) {
    terms.push(match[1]);
  }
  return uniqueStrings(terms
    .map(cleanMetadataValueSearchTerm)
    .filter((term) => term.length >= 2 && !METADATA_VALUE_STOP_TERMS.has(term.toLowerCase()))
  ).slice(0, 10);
}

function cleanMetadataValueSearchTerm(term: string): string {
  return term
    .replace(/[?.,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:account|category|customer|member|named|called|only|product|region|segment|sku|status|subscriber|user|where)\s+/i, '')
    .replace(/\s+\b(?:last|next|this)\b.*$/i, '')
    .replace(/\s+\b(?:daily|weekly|monthly|quarterly|yearly)\b.*$/i, '')
    .trim();
}

const METADATA_VALUE_STOP_TERMS = new Set([
  'account',
  'category',
  'customer',
  'last month',
  'last quarter',
  'last week',
  'last year',
  'member',
  'product',
  'region',
  'segment',
  'sku',
  'status',
  'this month',
  'this quarter',
  'this week',
  'this year',
  'user',
]);

export function buildFollowUpSearchQuery(question: string, followUp: MetadataFollowUpContext | null): string {
  if (!followUp) return question;
  // Contextual carry is advisory: enrich retrieval softly (prior question, columns,
  // measures) but never with concrete dimension VALUES or the block name — those pull
  // ranking hard toward the old topic when the user may be switching subjects. The
  // question-plan's own raw queries still run alongside this one either way.
  if (followUp.kind === 'contextual') {
    return [
      question,
      followUp.sourceQuestion ?? '',
      ...(followUp.priorResultColumns ?? []),
      followUp.priorResultRef?.question ?? '',
      ...(followUp.priorResultRef?.columns ?? []),
      ...(followUp.priorMeasures ?? []),
      ...dqlArtifactSearchTerms(followUp.priorDqlArtifact, { includeSource: false }),
    ].filter(Boolean).join(' ');
  }
  return [
    question,
    followUp.sourceBlockName ?? '',
    followUp.sourceQuestion ?? '',
    ...(followUp.dimensions ?? []),
    ...(followUp.priorResultColumns ?? []),
    followUp.priorResultRef?.question ?? '',
    ...(followUp.priorResultRef?.columns ?? []),
    ...(followUp.priorMeasures ?? []),
    // Retrieval searches object meaning, not executable payloads or warehouse
    // members. The source block is loaded directly by key and the typed follow-up
    // object retains SQL + values for execution. Injecting 600-1500 characters of
    // SQL and every prior row value into FTS made an eight-customer drilldown spend
    // ~11 seconds tokenizing metadata before the provider even started.
    ...(followUp.priorDqlArtifact?.metrics ?? []),
    ...(followUp.priorDqlArtifact?.dimensions ?? []),
    ...(followUp.priorDqlArtifact?.filters ?? []).map((filter) => filter.dimension),
  ].filter(Boolean).join(' ');
}

function dqlArtifactSearchTerms(
  artifact: MetadataDqlArtifactReference | undefined,
  options: { includeSource: boolean },
): string[] {
  if (!artifact) return [];
  return [
    artifact.name ?? '',
    artifact.sourcePath ?? '',
    ...(artifact.metrics ?? []),
    ...(artifact.dimensions ?? []),
    ...(artifact.filters ?? []).flatMap((filter) => [filter.dimension, filter.operator, ...filter.values]),
    artifact.timeDimension ? `${artifact.timeDimension.name} ${artifact.timeDimension.granularity}` : '',
    ...(artifact.orderBy ?? []).map((order) => `${order.name} ${order.direction}`),
    typeof artifact.limit === 'number' ? `limit ${artifact.limit}` : '',
    options.includeSource ? artifact.source.slice(0, 900) : '',
  ].filter(Boolean);
}

function uniqueMetadataSearchQueries(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = normalizeSearchText(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.slice(0, 5);
}

function normalizeRuntimeSchemaTables(tables: RuntimeSchemaTable[]): RuntimeSchemaTable[] {
  const byRelation = new Map<string, RuntimeSchemaTable>();
  for (const table of tables ?? []) {
    if (!table?.relation) continue;
    const relation = table.relation.trim();
    if (!relation) continue;
    const key = normalizeRelationKey(relation);
    const current = byRelation.get(key);
    const normalized: RuntimeSchemaTable = {
      relation,
      catalogOrDatabase: table.catalogOrDatabase,
      schema: table.schema,
      name: table.name ?? relation.split('.').at(-1) ?? relation,
      description: table.description,
      source: table.source,
      // Persist structural schema only. Live sample values can contain PII and
      // are scoped to a single request by the CLI (SEC-003).
      columns: dedupeRuntimeColumns(table.columns ?? [])
        .slice(0, 160)
        .map((column) => ({
          name: column.name,
          type: column.type,
          description: column.description,
        })),
    };
    if (!current) byRelation.set(key, normalized);
    else byRelation.set(key, {
      ...current,
      description: current.description ?? normalized.description,
      columns: dedupeRuntimeColumns([...current.columns, ...normalized.columns]).slice(0, 160),
    });
  }
  return Array.from(byRelation.values());
}

function safeRuntimeSchemaSnapshot(value: unknown): RuntimeSchemaSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tables)) return null;
  return {
    version: 1,
    generationId: stringValue(record.generationId),
    scopeFingerprint: stringValue(record.scopeFingerprint),
    connectionId: stringValue(record.connectionId),
    status: record.status === 'partial' || record.status === 'stale' ? record.status : 'ready',
    source: stringValue(record.source),
    capturedAt: stringValue(record.capturedAt),
    observedTarget: normalizeRuntimeSchemaObservedTarget(record.observedTarget),
    scopes: normalizeRuntimeSchemaScopes(record.scopes),
    queryCount: boundedRuntimeSchemaNumber(record.queryCount),
    durationMs: boundedRuntimeSchemaNumber(record.durationMs),
    truncated: record.truncated === true || undefined,
    tables: normalizeRuntimeSchemaTables(record.tables as RuntimeSchemaTable[]),
  };
}

function normalizeRuntimeSchemaObservedTarget(value: unknown): RuntimeSchemaObservedTarget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const driver = stringValue(record.driver);
  if (!driver) return undefined;
  return {
    driver,
    accountOrWorkspace: stringValue(record.accountOrWorkspace),
    role: stringValue(record.role),
    warehouse: stringValue(record.warehouse),
    defaultCatalogOrDatabase: stringValue(record.defaultCatalogOrDatabase),
    defaultSchema: stringValue(record.defaultSchema),
  };
}

function normalizeRuntimeSchemaScopes(value: unknown): RuntimeSchemaScope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes = value.flatMap((entry): RuntimeSchemaScope[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const catalogOrDatabase = stringValue(record.catalogOrDatabase);
    if (!catalogOrDatabase) return [];
    const schemas = Array.isArray(record.schemas)
      ? Array.from(new Set(record.schemas.map(stringValue).filter((item): item is string => Boolean(item))))
      : [];
    return [{ catalogOrDatabase, schemas }];
  });
  return scopes.length > 0 ? scopes : undefined;
}

function boundedRuntimeSchemaNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function metadataRuntimeColumns(value: unknown): RuntimeSchemaColumn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const name = stringValue(record.name) ?? stringValue(record.column_name);
    if (!name) return [];
    return [{
      name,
      type: stringValue(record.type) ?? stringValue(record.data_type),
      description: stringValue(record.description),
      sampleValues: metadataStringArray(record.sampleValues),
    }];
  });
}

function dedupeRuntimeColumns(columns: RuntimeSchemaColumn[]): RuntimeSchemaColumn[] {
  const byName = new Map<string, RuntimeSchemaColumn>();
  for (const column of columns) {
    if (!column?.name) continue;
    const key = column.name.toLowerCase();
    const existing = byName.get(key);
    byName.set(key, existing ? {
      ...existing,
      type: existing.type ?? column.type,
      description: existing.description ?? column.description,
      sampleValues: Array.from(new Set([...(existing.sampleValues ?? []), ...(column.sampleValues ?? [])])).slice(0, 8),
    } : {
      ...column,
      sampleValues: column.sampleValues?.slice(0, 8),
    });
  }
  return Array.from(byName.values());
}

function metadataStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
}

function metadataStringRecordArray(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const values = metadataStringArray(raw).slice(0, 24);
    if (key.trim() && values.length > 0) out[key.trim()] = values;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function metadataPayloadString(object: MetadataObject, key: string): string | undefined {
  return stringValue(object.payload?.[key]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeRelationKey(relation: string): string {
  return relation.replace(/["`]/g, '').trim().toLowerCase();
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isEntityQuestion(question: string): boolean {
  const lower = question.toLowerCase();
  if (/\b(for|where|only|specific|single|individual|named|called)\b.+\b(account|accounts|customer|customers|player|players|product|products|sku|user|users|team|teams)\b/i.test(lower)) return true;
  if (/\b(account|customer|player|product|sku|user|team)\s+(?:id|name|email)\b/i.test(lower)) return true;
  return /[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}/.test(question)
    && /\b(revenue|sales|order|orders|spend|value|churn|usage|activity|performance|performed|metric|kpi|points|goals|assists|scoring)\b/i.test(lower);
}

function mergeObject(a: MetadataObject | undefined, b: MetadataObject): MetadataObject {
  if (!a) return b;
  return {
    ...a,
    ...b,
    description: b.description || a.description,
    payload: compactObject({ ...(a.payload ?? {}), ...(b.payload ?? {}) }),
  };
}

function buildSourceFingerprints(objects: MetadataObject[], updatedAt: string): MetadataSourceFingerprint[] {
  const bySource = new Map<string, MetadataObject[]>();
  for (const object of objects) {
    const sourcePath = object.sourcePath ?? object.sourceSystem;
    if (!sourcePath) continue;
    const list = bySource.get(sourcePath) ?? [];
    list.push(object);
    bySource.set(sourcePath, list);
  }
  return Array.from(bySource.entries()).map(([sourcePath, rows]) => ({
    sourcePath,
    fingerprint: sha256(stableStringify(rows.map((row) => ({
      objectKey: row.objectKey,
      objectType: row.objectType,
      name: row.name,
      domain: row.domain,
      status: row.status,
      payload: row.payload,
    })))),
    objectCount: rows.length,
    updatedAt,
  })).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function buildDomainShards(objects: MetadataObject[], updatedAt: string): MetadataDomainShard[] {
  const byDomain = new Map<string, MetadataObject[]>();
  for (const object of objects) {
    // Fall back to the dbt-derived origin so an unreconciled metric still
    // groups under a recognisable heading in the domain workspace instead of
    // collapsing into _uncategorized — it lost filtering authority, not identity.
    const domain = object.domain?.trim()
      || stringValue((object.payload as Record<string, unknown> | undefined)?.sourceDomain)?.trim()
      || '_uncategorized';
    const list = byDomain.get(domain) ?? [];
    list.push(object);
    byDomain.set(domain, list);
  }
  return Array.from(byDomain.entries()).map(([domain, rows]) => ({
    domain,
    objectCount: rows.length,
    blockCount: rows.filter((row) => row.objectType === 'dql_block').length,
    certifiedBlockCount: rows.filter((row) => row.objectType === 'dql_block' && row.status === 'certified').length,
    semanticMetricCount: rows.filter((row) => row.objectType === 'semantic_metric').length,
    dbtObjectCount: rows.filter((row) => row.objectType === 'dbt_model' || row.objectType === 'dbt_source' || row.objectType === 'dbt_column').length,
    updatedAt,
  })).sort((a, b) => a.domain.localeCompare(b.domain));
}

function fingerprintSnapshot(snapshot: Omit<MetadataSnapshot, 'fingerprint'>): string {
  return sha256(stableStringify({
    projectRoot: snapshot.projectRoot,
    manifest: sanitizeManifestForFingerprint(snapshot.manifest),
    objects: snapshot.objects.map((object) => ({
      ...object,
      score: undefined,
      snippet: undefined,
    })),
    edges: snapshot.edges,
    diagnostics: snapshot.diagnostics,
  }));
}

function sanitizeManifestForFingerprint(manifest: DQLManifest): Record<string, unknown> {
  return {
    ...manifest,
    generatedAt: undefined,
    dbtImport: manifest.dbtImport
      ? { ...manifest.dbtImport, importedAt: undefined }
      : undefined,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function diagnosticId(diagnostic: MetadataDiagnostic): string {
  return sha256(stableStringify(diagnostic)).slice(0, 24);
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value)) {
    const out = `[${value.map((item) => stableStringify(item, seen)).join(',')}]`;
    seen.delete(value);
    return out;
  }
  const record = value as Record<string, unknown>;
  const out = `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return out;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) continue;
    out[key] = raw;
  }
  return out;
}

const SEARCHABLE_METADATA_KEYS = new Set([
  'aliases', 'synonyms', 'tags', 'label', 'metricType', 'aggregation', 'semanticModel',
  'localId', 'qualifiedId', 'uniqueId',
  'description', 'businessOutcome', 'decisionUse', 'grain', 'entities',
  'dimensions', 'allowedFilters', 'declaredOutputs', 'outputContract', 'outputs',
  'parameters', 'parameterPolicy', 'tableDependencies', 'sourceSystems', 'relation',
  'table', 'database', 'schema', 'materialized', 'columns', 'intentExamples',
  'examples', 'primaryTerms', 'businessRules', 'caveats', 'triggers', 'vocabulary',
]);
const SEARCHABLE_NESTED_METADATA_KEYS = new Set([
  'name', 'id', 'label', 'description', 'type', 'role', 'filter', 'binding',
  'question', 'entity', 'column', 'relation', 'table', 'domain', 'term', 'alias',
  'synonym', 'localId', 'qualifiedId', 'grain',
]);

/**
 * FTS indexes business/schema evidence, not the complete payload. In particular,
 * raw SQL and provider/runtime fields add large amounts of noise and can contain
 * literals that should never become general retrieval context.
 */
function searchableMetadataPayload(payload: Record<string, unknown>): string {
  const tokens: string[] = [];
  // Above the individual-column-object threshold, a dbt model is the only
  // searchable representation of many physical fields. Index all of the
  // *names* on that relation (with a hard bound) rather than only the first
  // manifest-order slice. A name-only lane is compact compared with one FTS
  // row + graph edge per column and lets a field late in a wide table trigger
  // relation-first hydration. Descriptions remain bounded because they are
  // comparatively large and are not needed for exact physical discovery.
  const relationColumnTokens = searchableRelationColumnTokens(payload.columns);
  const visit = (value: unknown, depth: number): void => {
    if (tokens.length >= 2_000 || depth > 3 || value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).replace(/\s+/g, ' ').trim();
      if (text) tokens.push(text.slice(0, 500));
      return;
    }
    if (Array.isArray(value)) {
      // Enterprise dbt imports intentionally omit individual dbt_column
      // objects above 50k columns. Their parent model still carries embedded
      // column metadata, so give that relation-level search path a larger,
      // bounded budget than ordinary payload arrays. This is metadata names
      // and descriptions only; it does not change catalog storage or prompt
      // rendering limits.
      const limit = depth === 1 ? 2_000 : 500;
      for (const item of value.slice(0, limit)) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (depth === 0 ? !SEARCHABLE_METADATA_KEYS.has(key) : !SEARCHABLE_NESTED_METADATA_KEYS.has(key)) continue;
      if (/sql|secret|password|token|credential|api.?key/i.test(key)) continue;
      // `searchableRelationColumnTokens` above owns the relation-level column
      // lane. Visiting it here would reintroduce the old manifest-order cap.
      if (depth === 0 && key === 'columns') continue;
      visit(item, depth + 1);
    }
  };
  visit(payload, 0);
  return [...tokens, ...relationColumnTokens].join(' ');
}

const MAX_RELATION_COLUMN_SEARCH_NAMES = 60_000;
const MAX_RELATION_COLUMN_SEARCH_DESCRIPTIONS = 2_000;

/**
 * Return a compact, relation-level FTS lane for embedded dbt column metadata.
 * This is intentionally not exported as a general payload renderer: it is a
 * bounded retrieval aid, and callers still hydrate the selected relation
 * before treating a missing field as absent.
 */
function searchableRelationColumnTokens(columns: unknown): string[] {
  const candidates = Array.isArray(columns)
    ? columns
    : columns && typeof columns === 'object'
      ? Object.values(columns as Record<string, unknown>)
      : [];
  const tokens: string[] = [];
  let descriptions = 0;
  for (const candidate of candidates.slice(0, MAX_RELATION_COLUMN_SEARCH_NAMES)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const name = stringValue(record.name) ?? stringValue(record.column) ?? stringValue(record.id);
    if (!name) continue;
    tokens.push(`column ${name}`);
    const description = stringValue(record.description);
    if (description && descriptions < MAX_RELATION_COLUMN_SEARCH_DESCRIPTIONS) {
      tokens.push(description.replace(/\s+/g, ' ').trim().slice(0, 240));
      descriptions += 1;
    }
  }
  return tokens;
}

const VECTOR_EXCLUDED_OBJECT_TYPES = new Set([
  ...COLUMN_OBJECT_TYPES,
  'skill',
  'runtime_value',
]);

/**
 * A DOCUMENTED column earns a vector, even though columns are excluded as a class.
 *
 * Excluding every column left a question phrased in column vocabulary ("which
 * field holds the customer's tier?") with no semantic recall path at all — the
 * lexical lane is the only thing that could ever find it, and that is exactly
 * the case where the user's words and the schema's words differ.
 *
 * The exclusion existed for volume, and that concern is real: columns outnumber
 * models by 10-50x and `searchVectorObjects` is an O(n) scan in JS. A DESCRIPTION
 * is the natural bound — it means someone documented the column on purpose, which
 * is both a quality signal and a small fraction of any real warehouse. An
 * undocumented column has nothing to embed but its name, which the lexical lane
 * already matches better than a vector would.
 */
function isDocumentedColumnObject(object: MetadataObject): boolean {
  return COLUMN_OBJECT_TYPES.has(object.objectType)
    && object.objectType !== 'runtime_value'
    && (object.description?.trim().length ?? 0) > 0;
}

/**
 * A skill is written vocabulary — the words a team uses for a task — which is
 * exactly what a vector is for. Excluding the type wholesale meant a question
 * phrased in the team's language could only ever be found by keyword. Bounded
 * the same way as columns: it must actually be documented, so an empty skill
 * stub does not earn an embedding.
 */
function isDocumentedSkillObject(object: MetadataObject): boolean {
  return object.objectType === 'skill' && (object.description?.trim().length ?? 0) > 0;
}

function isVectorIndexObject(object: MetadataObject): boolean {
  if (isDocumentedColumnObject(object)) return true;
  if (isDocumentedSkillObject(object)) return true;
  return !VECTOR_EXCLUDED_OBJECT_TYPES.has(object.objectType);
}

function metadataVectorText(object: MetadataObject): string {
  // A bare column name is a naked token: `status` on its own is equally close to
  // every status-ish thing in the warehouse. Lead with the parent-qualified name
  // and the type so the vector carries WHICH table's status this is.
  const columnPrefix = isDocumentedColumnObject(object)
    ? [
        `${object.fullName ?? object.name} column`,
        stringValue((object.payload ?? {}).type) ?? '',
        stringValue((object.payload ?? {}).relation) ?? '',
      ].filter(Boolean).join(' ')
    : '';
  return [
    columnPrefix,
    object.name,
    object.fullName ?? '',
    object.description ?? '',
    object.domain ?? '',
    object.owner ?? '',
    searchableMetadataPayload(object.payload ?? {}),
  ].filter(Boolean).join('\n').slice(0, 16_000);
}

function encodeFloat32Vector(vector: ArrayLike<number>): Buffer {
  const values = Float32Array.from(vector);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function decodeFloat32Vector(blob: Buffer): Float32Array {
  const bytes = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(bytes);
}

function rowToObject(row: MetadataObjectRow): MetadataObject {
  return {
    objectKey: row.object_key,
    objectType: row.object_type,
    name: row.name,
    fullName: row.full_name ?? undefined,
    domain: row.domain ?? undefined,
    owner: row.owner ?? undefined,
    status: row.status ?? undefined,
    description: row.description ?? undefined,
    sourcePath: row.source_path ?? undefined,
    sourceSystem: row.source_system ?? undefined,
    payload: safeJson(row.payload_json, {}),
    updatedAt: row.updated_at,
  };
}

function rowToEdge(row: MetadataEdgeRow): MetadataEdge {
  return {
    edgeType: row.edge_type,
    fromKey: row.from_key,
    toKey: row.to_key,
    confidence: row.confidence,
    payload: safeJson(row.payload_json, {}),
  };
}

function rowToQueryRun(row: QueryRunRow): QueryRunSummary {
  return {
    id: row.id,
    objectKey: row.object_key ?? undefined,
    source: row.source,
    status: row.status,
    rowCount: row.row_count ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    errorCode: row.error_code ?? undefined,
    payload: safeJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

function rowToRuntimeValueMatch(row: RuntimeValueIndexRow, terms: string[]): RuntimeValueMatch {
  const normalized = row.normalized_value;
  const exactBoost = terms.some((term) => term === normalized) ? 1 : 0;
  const containsBoost = terms.some((term) => normalized.includes(term) || term.includes(normalized)) ? 0.5 : 0;
  const rankScore = row.rank ? 1 / (1 + Math.max(0, row.rank)) : 1;
  return {
    valueKey: row.value_key,
    relation: row.relation,
    schema: row.schema_name ?? undefined,
    tableName: row.table_name ?? undefined,
    columnName: row.column_name,
    columnType: row.column_type ?? undefined,
    value: row.value,
    normalizedValue: row.normalized_value,
    source: row.source ?? undefined,
    capturedAt: row.captured_at,
    score: Number((rankScore + exactBoost + containsBoost).toFixed(3)),
  };
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * W3.2 — domain-affinity ranking boost for MULTI-DOMAIN catalogs. At scale
 * (thousands of models across domains), a question about one domain can be crowded
 * out of the top-k by lexically-similar objects from other domains. This infers the
 * dominant domain from the highest-scoring candidates and gives same-domain objects
 * a small additive bonus. It is RECALL-PRESERVING — it only reorders; every
 * candidate stays in the ranking, and the bonus (10% of the top score) is small
 * enough that a much stronger cross-domain signal still wins. No-op for single-domain
 * catalogs (fewer than 2 domains carry positive score).
 */
export function applyDomainAffinityBoost(
  scored: Array<{ row: MetadataObject; score: number }>,
): string | undefined {
  const domainScore = new Map<string, number>();
  for (const item of scored) {
    const domain = item.row.domain;
    if (domain && item.score > 0) domainScore.set(domain, (domainScore.get(domain) ?? 0) + item.score);
  }
  if (domainScore.size < 2) return undefined;
  const [dominant] = [...domainScore.entries()].sort((a, b) => b[1] - a[1])[0];
  const maxScore = Math.max(0, ...scored.map((item) => item.score));
  const bonus = Number((0.1 * maxScore).toFixed(3));
  if (bonus <= 0) return undefined;
  for (const item of scored) {
    if (item.row.domain === dominant) item.score = Number((item.score + bonus).toFixed(3));
  }
  return dominant;
}

function rankMetadataObjects(args: {
  rows: MetadataObject[];
  question: string;
  questionPlan?: AnalysisQuestionPlan;
  modelAreaId?: string;
  limit: number;
}): {
  selected: MetadataObject[];
  ranked: RankedMetadataObject[];
  rejected: LocalContextPack['retrievalDiagnostics']['topRejected'];
} {
  const terms = tokenize(args.question).slice(0, 12);
  const scored = mergeObjects(args.rows).map((row) => {
    const baseScore = scoreMetadataObject(row, terms);
    const planScore = args.questionPlan ? scoreMetadataObjectWithAnalysisPlan(row, args.questionPlan) : { score: 0, reasons: [] };
    const areaScore = modelAreaAffinityScore(row, args.modelAreaId);
    const score = Number((baseScore + planScore.score + areaScore).toFixed(3));
    return {
      row,
      rank: 0,
      score,
      reason: selectionReason(row, score, areaScore > 0 ? [...planScore.reasons, 'focused Model Area match'] : planScore.reasons),
      priorityTier: priorityTier(row),
    };
  });
  applyDomainAffinityBoost(scored);
  const ranked = scored
    .sort((a, b) => b.score - a.score || objectPriority(a.row) - objectPriority(b.row) || a.row.name.localeCompare(b.row.name))
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const selectedRanked = selectRankedMetadataObjects(ranked, args.limit);
  const selectedKeys = new Set(selectedRanked.map((item) => item.row.objectKey));
  const rejectedRanked = ranked.filter((item) => !selectedKeys.has(item.row.objectKey));
  const cutoff = selectedRanked.at(-1);
  return {
    selected: selectedRanked.map((item) => item.row),
    ranked,
    rejected: rejectedRanked.slice(0, 24).map((item) => ({
      objectKey: item.row.objectKey,
      objectType: item.row.objectType,
      name: item.row.name,
      reason: cutoff
        ? `Outside balanced context window (cutoff ${cutoff.score.toFixed(1)}); ${item.reason}`
        : item.reason,
      score: item.score,
      rejectedRank: item.rank,
    })),
  };
}

function modelAreaAffinityScore(row: MetadataObject, modelAreaId: string | undefined): number {
  if (!modelAreaId) return 0;
  const qualifiedId = stringValue(row.payload?.qualifiedId);
  const areaId = stringValue(row.payload?.areaId);
  if (row.objectType === 'model_area' && qualifiedId === modelAreaId) return 48;
  if (areaId === modelAreaId) return 30;
  return 0;
}

function selectRankedMetadataObjects(ranked: RankedMetadataObject[], limit: number): RankedMetadataObject[] {
  if (ranked.length <= limit) return ranked;
  const columnCount = ranked.filter((item) => COLUMN_OBJECT_TYPES.has(item.row.objectType)).length;
  const nonColumnCount = ranked.length - columnCount;
  if (columnCount === 0 || nonColumnCount === 0) return ranked.slice(0, limit);

  const columnCap = Math.max(4, Math.floor(limit * 0.35));
  const selected: RankedMetadataObject[] = [];
  const deferredColumns: RankedMetadataObject[] = [];
  let selectedColumns = 0;
  for (const item of ranked) {
    if (selected.length >= limit) break;
    if (COLUMN_OBJECT_TYPES.has(item.row.objectType)) {
      if (selectedColumns >= columnCap) {
        deferredColumns.push(item);
        continue;
      }
      selectedColumns += 1;
    }
    selected.push(item);
  }

  if (selected.length < limit) {
    const selectedKeys = new Set(selected.map((item) => item.row.objectKey));
    for (const item of [...deferredColumns, ...ranked]) {
      if (selected.length >= limit) break;
      if (selectedKeys.has(item.row.objectKey)) continue;
      selected.push(item);
      selectedKeys.add(item.row.objectKey);
    }
  }
  return selected.sort((a, b) => a.rank - b.rank);
}

/**
 * A semantic dimension the semantic layer SYNTHESIZED from a physical column,
 * rather than one an author declared in a semantic model.
 *
 * When a dbt project has no top-level metrics, the provider falls back to a
 * per-model column inventory and every documented column becomes a
 * `semantic_dimension`. On a 3,000-model warehouse that is tens of thousands
 * of objects which are, factually, duplicates of the `dbt_column` objects
 * beside them — but they outrank the real dbt model and column rows, so a
 * question about ARR retrieved a wall of synthesized `*_arr` dimensions and
 * pushed the actual ARR mart out of the window. They are still legitimate
 * evidence; they are simply not better evidence than the thing they were
 * copied from. Authored dimensions (from a real semantic model) are untouched.
 */
function isSynthesizedColumnDimension(row: MetadataObject): boolean {
  if (row.objectType !== 'semantic_dimension') return false;
  const payload = row.payload as { provenance?: unknown; certification?: unknown } | undefined;
  return payload?.provenance === 'dbt dbt_column' && payload?.certification === 'ai_generated';
}

function scoreMetadataObject(row: MetadataObject, terms: string[]): number {
  let score = row.score ? row.score * 10 : 0;
  score += Math.max(0, 44 - objectPriority(row) * 2);
  // Rank a synthesized column-dimension below the dbt model and column it was
  // derived from, so real relations keep their place in the retrieval window.
  if (isSynthesizedColumnDimension(row)) score -= 18;
  if (row.status === 'certified') score += 36;
  if (row.status === 'approved') score += 24;
  if (row.status === 'draft') score -= 8;
  if (row.objectType === 'dql_block' && row.status !== 'certified') score -= 16;
  if (row.objectType === 'semantic_metric') score += 10;
  if (row.objectType === 'runtime_value') score += 14;
  if (row.objectType === 'dbt_model' || row.objectType === 'dbt_column') score += 4;
  score += scoreText([
    row.objectType,
    row.objectKey,
    row.name,
    row.fullName ?? '',
    row.domain ?? '',
    row.owner ?? '',
    row.description ?? '',
    JSON.stringify(row.payload ?? {}),
  ].join(' '), terms) * 8;
  return Number(score.toFixed(3));
}

function objectPriority(row: MetadataObject): number {
  return OBJECT_PRIORITY[row.objectType] ?? 99;
}

function priorityTier(row: MetadataObject): string {
  if (row.objectType === 'dql_block' && row.status === 'certified') return 'certified_block';
  if (row.objectType === 'semantic_metric') return 'semantic_metric';
  if (row.objectType === 'runtime_value') return 'value_match';
  if (row.objectType === 'dql_term' || row.objectType === 'business_view') return 'business_context';
  if (row.objectType.startsWith('dbt_') || row.objectType === 'warehouse_table') return 'dbt_warehouse_context';
  if (row.objectType === 'notebook') return 'notebook_evidence';
  if (row.objectType === 'app' || row.objectType === 'dashboard') return 'consumption_evidence';
  return 'metadata';
}

function selectionReason(row: MetadataObject, score: number, plannerReasons: string[] = []): string {
  const reasons = [reasonForObject(row), `priority tier: ${priorityTier(row)}`];
  if (row.status === 'certified') reasons.push('certified status');
  reasons.push(...plannerReasons.slice(0, 3));
  reasons.push(`score ${score.toFixed(1)}`);
  return reasons.join('; ');
}

function reasonForObject(row: MetadataObject): string {
  if (row.objectType === 'dql_block' && row.status === 'certified') return 'Certified reusable answer candidate';
  if (row.objectType === 'dql_block_output') return 'Certified block output column lineage';
  if (row.objectType === 'semantic_metric') return 'Semantic metric matched the question';
  if (row.objectType === 'runtime_value') return 'Observed runtime value matched the question literal';
  if (row.objectType === 'dql_term' || row.objectType === 'business_view') return 'DQL business context';
  if (row.objectType.startsWith('dbt_') || row.objectType === 'warehouse_table' || row.objectType === 'warehouse_column') return 'dbt or warehouse metadata supplies physical context';
  if (row.objectType === 'app' || row.objectType === 'dashboard') return 'Published consumption context';
  return 'Relevant project metadata';
}

function resolveFocusedModelArea(
  context: DomainContextEnvelope | undefined,
  question: string,
  areaObjects: MetadataObject[],
): { id: string; object: MetadataObject; source: 'explicit' | 'inferred' } | undefined {
  if (!context?.activeDomain) return undefined;
  const candidates = areaObjects.filter((object) => object.objectType === 'model_area' && object.domain === context.activeDomain);
  if (context.modelAreaId) {
    const object = candidates.find((candidate) => stringValue(candidate.payload?.qualifiedId) === context.modelAreaId);
    return object ? { id: context.modelAreaId, object, source: 'explicit' } : undefined;
  }
  const terms = tokenize(question);
  if (terms.length === 0) return undefined;
  const ranked = candidates.map((object) => {
    const searchable = [
      object.name,
      object.description ?? '',
      ...metadataStringArray(object.payload?.intentExamples),
    ].join(' ');
    return { object, score: scoreText(searchable, terms) };
  }).sort((a, b) => b.score - a.score || a.object.name.localeCompare(b.object.name));
  const first = ranked[0];
  const second = ranked[1];
  if (!first || first.score < 1 || (second && first.score === second.score)) return undefined;
  const id = stringValue(first.object.payload?.qualifiedId);
  return id ? { id, object: first.object, source: 'inferred' } : undefined;
}

/**
 * The authorization gate: a row survives only if it belongs to the pinned
 * domain boundary. This is the single place that decides what an agent is
 * *allowed* to see; a model area may narrow the result further but is applied
 * separately, and afterwards, so it can only ever shrink an authorized set.
 *
 * Uses `domainContextSearchDomains` so descendants are included. The FTS lane
 * already retrieves sub-domain rows; filtering them out here contradicted
 * CTX-008 and made a question answerable only from a sub-domain fail whenever
 * its parent was pinned.
 */
function filterMetadataObjectsByDomainContext(rows: MetadataObject[], context?: DomainContextEnvelope): MetadataObject[] {
  if (!context?.activeDomain) return rows;
  const domains = new Set(domainContextSearchDomains(context));
  return rows.filter((row) => !row.domain || domains.has(row.domain));
}

function selectContextPackSkills(
  catalog: MetadataCatalog,
  objects: MetadataObject[],
  question: string,
  context?: DomainContextEnvelope,
): Array<{ object: MetadataObject; skill: LocalContextSkill }> {
  const byIdentity = new Map<string, MetadataObject>();
  const parsed = objects.flatMap((object) => {
    const skill = skillFromMetadataObject(object);
    if (!skill) return [];
    const identity = skill.qualifiedId ?? skill.id;
    byIdentity.set(identity, object);
    return [skill];
  });
  const domains = context?.activeDomain
    ? [context.activeDomain, ...context.ancestors, ...context.allowedImports.map((item) => item.providerDomain)]
    : [];
  const selected = selectRelevantSkills(parsed, question, {
    domains,
    modelAreaIds: context?.modelAreaId ? [context.modelAreaId] : [],
    pinnedIds: context?.skillRefs ? ['sql-conventions', ...context.skillRefs] : undefined,
  });
  return selected.flatMap((skill) => {
    const object = byIdentity.get(skill.qualifiedId ?? skill.id);
    if (!object) return [];
    const bodyHash = stringPayload(object.payload?.bodyHash);
    const hydrated = bodyHash ? { ...skill, body: catalog.skillBody(bodyHash) ?? '' } : skill;
    return [{ object, skill: localContextSkillFromParsed(hydrated, object) }];
  });
}

function skillFromMetadataObject(object: MetadataObject): Skill | null {
  if (object.objectType !== 'skill') return null;
  const payload = object.payload ?? {};
  const scope = payload.scope === 'personal' ? 'personal' : 'project';
  const status = payload.status === 'draft' || payload.status === 'deprecated' || payload.status === 'active'
    ? payload.status
    : object.status === 'draft' || object.status === 'deprecated' || object.status === 'active'
      ? object.status
      : 'active';
  return {
    id: stringPayload(payload.skillId) ?? object.name,
    localId: stringPayload(payload.localId) ?? object.name,
    qualifiedId: stringPayload(payload.qualifiedId) ?? object.fullName,
    scope,
    user: stringPayload(payload.user),
    domain: object.domain,
    domains: stringArrayPayload(payload.domains),
    modelAreaRefs: stringArrayPayload(payload.modelAreaRefs),
    kind: skillKindPayload(payload.kind),
    status,
    owner: object.owner,
    triggers: stringArrayPayload(payload.triggers),
    exclusions: stringArrayPayload(payload.exclusions),
    description: object.description,
    preferredMetrics: stringArrayPayload(payload.preferredMetrics),
    preferredBlocks: stringArrayPayload(payload.preferredBlocks),
    preferredDimensions: stringArrayPayload(payload.preferredDimensions),
    requiredFilters: stringArrayPayload(payload.requiredFilters),
    clarifyWhen: stringArrayPayload(payload.clarifyWhen),
    examples: stringArrayPayload(payload.examples),
    sourceRefs: stringArrayPayload(payload.sourceRefs),
    vocabulary: stringRecordPayload(payload.vocabulary),
    analyticalPolicy: skillAnalyticalPolicyPayload(payload.analyticalPolicy),
    body: "",
    sourcePath: object.sourcePath ?? "",
    isStarter: payload.isStarter === true,
  };
}

function localContextSkillFromParsed(skill: Skill, object: MetadataObject): LocalContextSkill {
  const guidance = skill.body.slice(0, 4_000);
  const sourceHash = stringPayload(object.payload?.sourceFingerprint);
  const policy =
    skill.analyticalPolicy && sourceHash
      ? ({
          policyId: `${skill.qualifiedId ?? skill.id}#analytical`,
          sourceHash,
          ...skill.analyticalPolicy,
        } satisfies AnalyticalPolicyContract)
      : undefined;
  return {
    objectKey: object.objectKey,
    id: skill.id,
    qualifiedId: skill.qualifiedId,
    domain: skill.domain,
    domains: [...(skill.domains ?? [])],
    modelAreaRefs: [...(skill.modelAreaRefs ?? [])],
    kind: skill.kind,
    status: skill.status,
    owner: skill.owner,
    description: skill.description,
    triggers: [...(skill.triggers ?? [])],
    exclusions: [...(skill.exclusions ?? [])],
    preferredMetrics: [...skill.preferredMetrics],
    preferredBlocks: [...skill.preferredBlocks],
    preferredDimensions: [...(skill.preferredDimensions ?? [])],
    requiredFilters: [...(skill.requiredFilters ?? [])],
    clarifyWhen: [...(skill.clarifyWhen ?? [])],
    vocabulary: { ...skill.vocabulary },
    ...(policy ? { analyticalPolicy: policy } : {}),
    guidance,
    guidanceTruncated: guidance.length < skill.body.length,
    sourceRefs: [...(skill.sourceRefs ?? [])],
    provenance: stringPayload(object.payload?.provenance) ?? object.sourceSystem ?? 'DQL domain skill',
    sourcePath: object.sourcePath,
  };
}

function skillAnalyticalPolicyPayload(
  value: unknown,
): Skill["analyticalPolicy"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const completenessPolicy = stringPayload(record.completenessPolicy);
  const comparisonAlignment = stringPayload(record.comparisonAlignment);
  const defaultRankingPeriod = stringPayload(record.defaultRankingPeriod);
  const policy: NonNullable<Skill["analyticalPolicy"]> = {
    metricIds: stringArrayPayload(record.metricIds),
    timeRole: stringPayload(record.timeRole),
    calendarId: stringPayload(record.calendarId),
    timezone: stringPayload(record.timezone),
    completenessPolicy:
      completenessPolicy === "partial_current" ||
      completenessPolicy === "latest_complete" ||
      completenessPolicy === "closed_period"
        ? completenessPolicy
        : undefined,
    comparisonAlignment:
      comparisonAlignment === "elapsed_period" ||
      comparisonAlignment === "calendar_period" ||
      comparisonAlignment === "fiscal_period"
        ? comparisonAlignment
        : undefined,
    defaultRankingPeriod:
      defaultRankingPeriod === "current" ||
      defaultRankingPeriod === "comparison"
        ? defaultRankingPeriod
        : undefined,
    narrativeGuidance: stringArrayPayload(record.narrativeGuidance),
  };
  return Object.values(policy).some((item) =>
    Array.isArray(item) ? item.length > 0 : Boolean(item),
  )
    ? policy
    : undefined;
}

function stringPayload(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArrayPayload(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

function stringRecordPayload(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function skillKindPayload(value: unknown): Skill['kind'] | undefined {
  return value === 'domain_reference' || value === 'metric_policy' || value === 'glossary'
    || value === 'analysis_pattern' || value === 'sql_policy' || value === 'custom'
    ? value
    : undefined;
}

function mergeObjects(rows: MetadataObject[]): MetadataObject[] {
  const byKey = new Map<string, MetadataObject>();
  for (const row of rows) {
    const existing = byKey.get(row.objectKey);
    byKey.set(row.objectKey, existing ? mergeObject(existing, row) : row);
  }
  return Array.from(byKey.values());
}

function mergeMetadataEdges(rows: MetadataEdge[]): MetadataEdge[] {
  const byKey = new Map<string, MetadataEdge>();
  for (const row of rows) {
    putEdge(byKey, row);
  }
  return Array.from(byKey.values());
}

function deriveTrust(objects: MetadataObject[]): MetadataTrustLabel {
  if (objects.length === 0) return 'unknown';
  const statuses = objects.map((row) => row.status ?? '');
  if (statuses.length > 0 && statuses.every((status) => status === 'certified')) return 'certified';
  if (statuses.some((status) => status === 'certified') && statuses.some((status) => status && status !== 'certified')) return 'mixed';
  if (statuses.some((status) => status === 'draft' || status === 'ai_generated' || status === 'analyst_review_required')) return 'draft';
  return statuses.some((status) => status === 'certified') ? 'mixed' : 'unknown';
}

function withMetadataTrustLabelInfo(decision: MetadataRouteDecision): MetadataRouteDecision {
  return {
    ...decision,
    trustLabelInfo: metadataTrustLabelInfo(decision.trustLabel),
  };
}

function metadataTrustLabelInfo(label: MetadataTrustLabel): ResolvedTrustLabel {
  switch (label) {
    case 'certified':
      return composeEffectiveTrust({ id: 'certified' });
    case 'conflict':
      return composeEffectiveTrust({ id: 'conflict' });
    case 'draft':
      return composeEffectiveTrust({ id: 'ai_generated' });
    case 'mixed':
      return composeEffectiveTrust({ id: 'ai_generated', existingQualifier: 'mixed context' });
    case 'unknown':
      return composeEffectiveTrust({ id: 'insufficient_context' });
  }
}

function buildCitations(objects: MetadataObject[], edges: MetadataEdge[]): LocalContextPack['citations'] {
  const citations = objects.slice(0, 24).map((row) => ({
    objectKey: row.objectKey,
    objectType: row.objectType,
    name: row.name,
    reason: row.objectType === 'dql_block' && row.status === 'certified'
      ? 'Certified block candidate'
      : reasonForObject(row),
  }));
  for (const edge of edges.slice(0, 8)) {
    citations.push({
      objectKey: edge.fromKey,
      objectType: 'metadata_edge',
      name: `${edge.fromKey} -> ${edge.toKey}`,
      reason: `${edge.edgeType} relationship evidence`,
    });
  }
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.objectType}|${citation.objectKey}|${citation.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 32);
}

function buildEvidenceSummaries(
  objects: MetadataObject[],
  edges: MetadataEdge[],
  queryRuns: QueryRunSummary[],
  diagnostics: MetadataDiagnostic[],
): LocalContextPack['evidenceSummaries'] {
  const summaries: LocalContextPack['evidenceSummaries'] = objects.slice(0, 10).map((row) => ({
    title: row.name || row.objectKey,
    detail: row.objectType.replace(/_/g, ' '),
    objectKey: row.objectKey,
    objectType: row.objectType,
    reason: reasonForObject(row),
  }));
  if (edges.length > 0) {
    summaries.push({
      title: `${edges.length} metadata relationship${edges.length === 1 ? '' : 's'}`,
      detail: 'Object relationships were used to connect business, semantic, and physical context.',
      reason: 'Graph evidence',
    });
  }
  if (queryRuns.length > 0) {
    summaries.push({
      title: 'Recent execution history',
      detail: `Latest run status: ${queryRuns[0]?.status ?? 'unknown'}.`,
      reason: 'Runtime evidence',
    });
  }
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  if (warnings || errors) {
    summaries.push({
      title: 'Metadata diagnostics',
      detail: `${errors} error(s), ${warnings} warning(s).`,
      reason: 'Freshness and completeness checks',
    });
  }
  return summaries.slice(0, 16);
}

function buildWarnings(diagnostics: MetadataDiagnostic[], objects: MetadataObject[]): string[] {
  const warnings = diagnostics
    .filter((diagnostic) => diagnostic.severity === 'warning')
    .map((diagnostic) => diagnostic.message)
    .slice(0, 12);
  if (!objects.some((object) => object.objectType === 'semantic_metric')) {
    warnings.push('No semantic metric was selected for this context pack.');
  }
  return Array.from(new Set(warnings));
}

function buildCandidateConflicts(ranked: RankedMetadataObject[]): MetadataCandidateConflict[] {
  const conflicts: MetadataCandidateConflict[] = [];
  for (const type of ['dql_block', 'semantic_metric', 'dql_term', 'business_view']) {
    const candidates = ranked
      .filter((item) => item.row.objectType === type && isGovernedCandidate(item.row))
      .slice(0, 4);
    if (candidates.length < 2) continue;
    const delta = candidates[0]!.score - candidates[1]!.score;
    if (delta <= 12) {
      const details = candidates.map((item) => ({
        objectKey: item.row.objectKey,
        objectType: item.row.objectType,
        name: item.row.name,
        domain: item.row.domain ?? null,
        status: item.row.status ?? null,
        rank: item.rank,
        score: item.score,
        reason: item.reason,
      }));
      conflicts.push({
        objectType: type,
        objectKeys: candidates.map((item) => item.row.objectKey),
        reason: `Multiple high-scoring governed ${type.replace(/_/g, ' ')} candidates may need disambiguation.`,
        prompt: `Which ${type.replace(/_/g, ' ')} should I use: ${details.map((item) => item.name).join(', ')}?`,
        candidates: details,
      });
    }
  }
  return conflicts;
}

function isGovernedCandidate(row: MetadataObject): boolean {
  return row.status === 'certified' || row.status === 'approved';
}

/**
 * Select a compile-time trust conflict to route on, but only when BOTH of its
 * sides appear among the question's top candidates. This keeps the conflict
 * route scoped to questions the conflicting pair actually answers — a conflict
 * elsewhere in the project never hijacks an unrelated question.
 */
function pickRouteConflict(
  compileConflicts: ManifestConflictDetail[],
  rankedObjects: RankedMetadataObject[],
  fallbackObjects: MetadataObject[],
  question: string,
): MetadataRouteConflict | undefined {
  if (compileConflicts.length === 0) return undefined;

  // Names of the top candidate objects for this question (bounded — only the
  // strongest matches count as "top candidates").
  const topNames = new Set<string>();
  const ordered = rankedObjects.length > 0
    ? rankedObjects.slice(0, 12).map((item) => item.row)
    : fallbackObjects.slice(0, 12);
  for (const row of ordered) {
    const norm = normalizeConflictName(row.name);
    if (norm) topNames.add(norm);
  }

  for (const conflict of compileConflicts) {
    if (!conflictMatchesQuestion(conflict, question)) continue;
    const sideNames = conflict.sides.map((side) => normalizeConflictName(side.name)).filter(Boolean);
    if (sideNames.length < 2) continue;
    const presentSides = sideNames.filter((name) => topNames.has(name));
    if (presentSides.length < 2) continue;
    return {
      objectType: conflict.objectType,
      concept: conflict.concept,
      reason: conflict.reason,
      prompt: conflict.prompt,
      sides: conflict.sides.map((side) => ({
        name: side.name,
        owner: side.owner,
        domain: side.domain,
        filePath: side.filePath,
        definition: side.definition,
        businessRules: side.businessRules,
      })),
    };
  }
  return undefined;
}

function conflictMatchesQuestion(conflict: ManifestConflictDetail, question: string): boolean {
  const questionTokens = new Set(tokenize(question.replace(/_/g, ' ')));
  const conceptTokens = tokenize(conflict.concept.replace(/_/g, ' '));
  if (conceptTokens.length > 0 && conceptTokens.every((token) => questionTokens.has(token))) return true;
  const sideHits = conflict.sides.filter((side) =>
    tokenize(side.name).some((token) => questionTokens.has(token))
  ).length;
  return sideHits >= 2;
}

function normalizeConflictName(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  return Array.from(new Set(text.toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ').split(/\s+/).filter((term) => term.length >= 3))).slice(0, 24);
}

function scoreText(value: string, terms: string[]): number {
  const lower = value.toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

/** Normalized lookup of governed metric/measure/dimension/block names AND labels. */
export function buildGovernedTermIndex(
  objects: Array<Pick<MetadataObject, 'objectType' | 'name' | 'payload'>>,
): Map<string, 'metric' | 'dimension'> {
  const index = new Map<string, 'metric' | 'dimension'>();
  const put = (text: unknown, kind: 'metric' | 'dimension') => {
    if (typeof text !== 'string') return;
    const key = normalizeGovernedTerm(text);
    if (key.length >= 3 && !index.has(key)) index.set(key, kind);
  };
  for (const object of objects) {
    const kind = object.objectType === 'semantic_dimension' ? 'dimension' : 'metric';
    put(object.name, kind);
    put((object.payload as Record<string, unknown> | undefined)?.label, kind);
  }
  return index;
}

function normalizeGovernedTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * A "filter" phrase that is really a governed metric/dimension NAME or LABEL
 * must never be treated as a member value. Metric labels render in Title Case
 * ("Previous Day BCM"), so users naturally type them capitalized — and the
 * planner's proper-noun heuristic then extracted "Previous Day" as a
 * named-entity filter, which failed to bind and surfaced as "not enough to
 * choose a safe metric" (while the lowercase phrasing worked). Reclassify:
 * drop the phrase from filters and feed the matched governed name into
 * metricTerms so ranking sees the actual intent. Case-insensitive by
 * construction. Returns audit notes (empty when nothing matched).
 */
export function reclassifyGovernedNameMentions(
  plan: AnalysisQuestionPlan,
  index: Map<string, 'metric' | 'dimension'>,
  question: string,
): string[] {
  if (index.size === 0 || plan.requestedShape.filters.length === 0) return [];
  const questionNorm = ` ${normalizeGovernedTerm(question)} `;
  const notes: string[] = [];
  const keptFilters: string[] = [];
  for (const filter of plan.requestedShape.filters) {
    const filterNorm = normalizeGovernedTerm(filter);
    let matched: { key: string; kind: 'metric' | 'dimension' } | undefined;
    if (filterNorm.length >= 3) {
      const direct = index.get(filterNorm);
      if (direct) {
        matched = { key: filterNorm, kind: direct };
      } else {
        for (const [key, kind] of index) {
          const isSubPhrase = key === filterNorm
            || key.startsWith(`${filterNorm} `)
            || key.endsWith(` ${filterNorm}`)
            || key.includes(` ${filterNorm} `);
          if (!isSubPhrase) continue;
          // Every token of the governed name must appear in the question —
          // "Previous Day" only reclassifies when "bcm" is also present.
          const tokens = key.split(' ');
          if (tokens.every((token) => questionNorm.includes(` ${token} `))) {
            matched = { key, kind };
            break;
          }
        }
      }
    }
    if (!matched) {
      keptFilters.push(filter);
      continue;
    }
    notes.push(`Reclassified "${filter}" from member filter to governed ${matched.kind} reference ("${matched.key}").`);
    if (matched.kind === 'metric' && !plan.metricTerms.includes(matched.key)) {
      plan.metricTerms.push(matched.key);
    }
  }
  if (notes.length > 0) plan.requestedShape.filters = keptFilters;
  return notes;
}
