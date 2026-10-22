import type { DashboardVizEncoding } from '@zlens/core/apps/viz-encoding';
import type { DashboardVizStyle } from '@zlens/core/apps/viz-style';
import type { ResultOrdering } from '@zlens/core/apps/result-measures';
import type { TableDatasetProposal } from '@zlens/core/datasets/table-draft';
import type { CertificationByline } from '@zlens/core/apps/reader-trust';

export type { CertificationByline };

export interface SavedQueryDatasetDraft {
  ok: boolean;
  source?: { sourceId: string; name: string; sourceRevision: string; status: 'certified' | 'review' | 'draft' | 'deprecated' };
  rows?: number;
  proposal?: TableDatasetProposal;
  /** The saved query is certified: adding fields sends it back for review until its check passes. */
  sendsBackForReview?: boolean;
  code?: string;
  error?: string;
}

export interface SavedQueryDatasetResult {
  ok: boolean;
  status?: 'certified' | 'review' | 'draft';
  previousStatus?: 'certified' | 'review' | 'draft';
  sourceId?: string;
  path?: string;
  blockers?: string[];
  keyChecked?: boolean;
  /** Who certified it and the checks that passed, when it was certified. */
  certification?: CertificationByline;
  code?: string;
  error?: string;
}

/** Guided Setup progress (design D7), saved by the server in `.dql/local/setup-progress.json`. */
export interface SetupProgress {
  version: 1;
  step: 1 | 2 | 3 | 4;
  source?: 'dbt' | 'warehouse' | 'both' | 'existing';
  aiSkipped?: boolean;
  draft?: { ok: boolean; message: string; proposalId?: string };
  updatedAt: string;
}

export interface WarehouseTableSummary {
  id: string;
  name: string;
  schema?: string;
  relation: string;
  kind: string;
  columnCount: number;
  rowCountEstimate?: number;
  /**
   * The table is modeled (an entity in the project's model binds it) or was
   * drafted by "Draft my models" and waits for review (design D7). Its
   * checked row key is reused by "Check and add".
   */
  modeled?: { state: 'modeled' | 'drafted'; entity: string; domain: string; key?: string; proposalId?: string };
  /** Tables its rows point to through a many-to-one join; their fields come with it (design D2). */
  joins?: string[];
}
import type { DiffReport } from '@zlens/core/format';
import { normalizeDqlArtifactReference, type DqlArtifactReference } from '@zlens/core/artifacts';
import type { Business360ResultV2 } from '@zlens/core/lineage';
import type { DatasetDescriptor, MetricCapabilityContract, SemanticTileConversionProvenanceV1, TileQuery } from '@zlens/core';
import type {
  ManifestDbtFirstModeling,
  ManifestModelRelationship,
  ManifestDbtProvenance,
  ManifestDiagnostic,
  ManifestLineage,
  ModelingAuthoringChange,
  ModelingChangePreview,
  DbtNodeAuthoringDetail,
  DbtSourceAuthoringInput,
  DbtSourcePatchPreview,
  DbtMetricAuthoringInput,
  DbtMetricPatchPreview,
  RelationshipAuthoringInput,
  ManifestRelationshipValidationEvidence,
  ManifestDomainCapsule,
  ManifestKnowledgeEdge,
  ManifestKnowledgeObject,
  ManifestCrossDomainRoute,
} from '@zlens/core';
import type { AgentAnswerCascade, AgentConversationContext, AgentConversationDqlArtifact } from '../llm/types';
import type {
  Cell,
  ExecutionTarget,
  NotebookFile,
  QueryResult,
  RunSnapshot,
  SchemaTable,
  SchemaColumn,
  SemanticLayerState,
  SemanticDimension,
  SemanticCompatibility,
  SemanticEntity,
  SemanticMeasure,
  SemanticMetric,
  SemanticModel,
  SemanticSavedQuery,
  SemanticHierarchy,
  SemanticTreeNode,
  SemanticObjectDetail,
  BlockStudioCatalog,
  BlockStudioOpenPayload,
  BlockStudioPreview,
  BlockStudioRunSummary,
  BlockStudioValidation,
  BlockStudioDiagnostic,
  BlockStudioImportSession,
  BlockStudioImportSessionSummary,
  BlockStudioImportCandidate,
  DqlGenerationSession,
  DqlGenerationCandidate,
  BlockSimilarityMatch,
  DqlCandidateRecommendedAction,
  BlockStudioDbtStatus,
  BlockParameterDefinition,
  SemanticLayerDiagnostics,
  AppSummary,
  ActivePersona,
  ProposeReadiness,
  ProposeGenerateResult,
  ProposePlanCandidate,
  AiBuildResult,
  AiBuildTarget,
  AiBuildMode,
  Skill,
  SkillPathSettings,
  Domain,
} from '../store/types';
import { reportHostRefusal, reportServerAuthRejected, withServerAuthorization } from './server-auth';

const EMPTY_PLAN = {
  totals: { modelsScanned: 0, businessModels: 0, plumbingExcluded: 0, metricsFound: 0 },
  willGenerate: 0,
  willSkip: 0,
  domains: [],
  config: {
    businessLayers: [],
    excludeLayers: [],
    maxPerDomain: 0,
    minScore: 0,
    aiEnrichment: 'auto' as const,
  },
};

export interface SemanticRuntimeSettingsResponse {
  preference: 'auto' | 'native' | 'metricflow-cli' | 'dbt-cloud';
  dbtCloud: {
    host?: string;
    environmentId?: string;
    hasServiceToken: boolean;
    serviceTokenPreview?: string;
    source: 'local' | 'env' | 'none';
    configured: boolean;
    testState: 'missing' | 'configured' | 'passed' | 'failed';
    testedAt?: string;
    testMessage?: string;
    dialect?: string;
    metricCount?: number;
    semanticCatalogFingerprint?: string;
    metricInventoryState: 'missing' | 'partial' | 'complete';
    executionTargetFingerprint?: string;
    executionTargetContext?: Record<string, string>;
    targetBindingState: 'missing' | 'bound';
    envVars: string[];
  };
  runtime: {
    preference: 'auto' | 'native' | 'metricflow-cli' | 'dbt-cloud';
    active: 'native' | 'metricflow-cli' | 'dbt-cloud';
    setup: string | null;
    adapters: Array<{
      id: 'native' | 'metricflow-cli' | 'dbt-cloud';
      label: string;
      bundled: boolean;
      configured: boolean;
      tested: boolean;
      ready: boolean;
      source: 'bundled' | 'local' | 'env' | 'none';
      detail: string;
    }>;
  };
}

export interface SemanticRuntimeSettingsInput {
  preference?: 'auto' | 'native' | 'metricflow-cli' | 'dbt-cloud';
  dbtCloud?: { host?: string; environmentId?: string; serviceToken?: string };
}

export interface SemanticRuntimePathCandidate {
  id: string;
  label: string;
  description: string;
  authoringReference: string;
  runtimeReference: string;
  entityPath: string[];
  selectionReference: string;
}

export interface SemanticRuntimeTrace {
  version: 1;
  adapter: 'native' | 'metricflow-cli' | 'dbt-cloud';
  status: 'compiled' | 'ambiguous' | 'failed';
  authoringRequest: Record<string, unknown>;
  runtimeRequest?: Record<string, unknown>;
  bindings: Array<{
    role: string;
    authoringReference: string;
    runtimeReference: string;
    entityPath: string[];
    status: 'resolved' | 'ambiguous';
  }>;
  warnings: string[];
  steps: Array<{ id: string; label: string; status: string; detail: string }>;
  targetBinding?: Record<string, unknown>;
  executionReceipt?: Record<string, unknown>;
  failure?: {
    code: string;
    phase: string;
    message: string;
    candidates?: SemanticRuntimePathCandidate[];
  };
}

export type MetricFlowWarehouseAdapter = 'duckdb' | 'snowflake' | 'bigquery' | 'databricks' | 'redshift' | 'postgres' | 'trino';

export interface MetricFlowInstallJob {
  id: string;
  state: 'idle' | 'queued' | 'running' | 'completed' | 'failed';
  stage: 'detecting_python' | 'creating_environment' | 'installing' | 'parsing' | 'testing' | 'ready';
  progress: number;
  adapter: MetricFlowWarehouseAdapter;
  packageSpec: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  runtimePath: string;
  runtimeVersion?: string;
  logs: string[];
  error?: string;
}

export interface MetricFlowInstallerStatus {
  job: MetricFlowInstallJob | null;
  recommendedAdapter: MetricFlowWarehouseAdapter | null;
  supportedAdapters: MetricFlowWarehouseAdapter[];
  projectConfigured: boolean;
  semanticManifestFound: boolean;
}

export interface EmbeddingSettingsResponse {
  settings: { provider: 'hashed' | 'ollama' | 'openai'; endpoint: string; model: string; apiKeySet: boolean };
  activeProviderId: string;
  semantic: boolean;
  indexedProviderId?: string;
  reindexRequired: boolean;
}

export interface EmbeddingReindexResult {
  upgraded: boolean;
  providerId: string;
  reason?: string;
}

export interface GitGovernedContextGroup {
  total: number;
  tracked: number;
  changed: number;
  untracked: number;
  ignored: number;
  paths: Array<{ path: string; state: 'tracked' | 'changed' | 'untracked' | 'ignored' }>;
}

function emptyGitGovernedContextGroup(): GitGovernedContextGroup {
  return { total: 0, tracked: 0, changed: 0, untracked: 0, ignored: 0, paths: [] };
}

export type BlockHistoryStatus = 'ok' | 'not_a_repo' | 'git_unavailable' | 'error';

export interface BlockHistoryResult {
  entries: Array<{ hash: string; date: string; author: string; message: string }>;
  status: BlockHistoryStatus;
  message?: string;
}

/** Result of a Git write. `code` is the server's machine-readable reason (e.g. `no_remote`, `already_a_repo`, `invalid_url`). */
/** Get updates mid-way (D1/D2): an operation stopped on conflicts, or a finished update that can be undone. */
export interface GitUpdateState {
  inProgress: boolean;
  operation?: 'rebase' | 'merge';
  target?: string;
  conflicts: Array<{ path: string; mine: boolean; theirs: boolean }>;
  unresolved: string[];
  undoAvailable: boolean;
}

export interface GitUpdateResult extends GitWriteResult {
  output?: string;
  state?: GitUpdateState;
  files?: string[];
  undoAvailable?: boolean;
}

export interface GitWriteResult {
  ok: boolean;
  error?: string;
  code?: string;
  /** Raw git output behind a plain-language `error`. */
  detail?: string;
}

function gitWriteFailure(error: unknown): GitWriteResult {
  const code = error instanceof DqlApiError && typeof error.code === 'string' ? error.code : undefined;
  return { ok: false, error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) };
}

// ── Apps API types ───────────────────────────────────────────────────────

export interface AppDocumentSummary {
  app: {
    id: string;
    name: string;
    description?: string;
    domain: string;
    subdomain?: string;
    groups?: string[];
    visibility?: 'shared' | 'private' | 'template';
    publicationIntent?: 'personal' | 'shared_project';
    audience?: string;
    /** Identity-provider groups the App is for (RFC 0010 HH-16). */
    audienceGroups?: string[];
    lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
    owners: string[];
    tags?: string[];
    notebooks?: Array<{
      path: string;
      title?: string;
      role: 'source' | 'analysis' | 'supporting';
      visibility: 'shared' | 'private' | 'template';
    }>;
    members: Array<{
      userId: string;
      displayName?: string;
      roles: string[];
      attributes?: Record<string, string | number | boolean>;
    }>;
    roles: Array<{ id: string; displayName?: string; description?: string }>;
    policies: Array<{
      id: string;
      domain: string;
      minClassification: 'public' | 'internal' | 'confidential' | 'restricted';
      allowedRoles: string[];
      allowedUsers?: string[];
      accessLevel: 'read' | 'write' | 'execute' | 'admin';
      enabled?: boolean;
    }>;
    rlsBindings?: Array<{ role: string; variable: string; from: string }>;
    schedules?: Array<{
      id: string;
      cron: string;
      dashboard: string;
      deliver: Array<
        | { kind: 'slack'; channel: string }
        | { kind: 'email'; to: string[] }
        | { kind: 'webhook'; url: string }
      >;
      enabled?: boolean;
    }>;
    homepage?: { type: 'dashboard'; id: string } | { type: 'notebook'; path: string };
  };
  dashboards: Array<{ id: string; title: string; description?: string; itemCount: number }>;
  notebooks?: Array<{ path: string; title?: string; role: 'source' | 'analysis' | 'supporting'; visibility: 'shared' | 'private' | 'template' }>;
  drafts?: Array<{ path: string; name: string; reviewStatus?: string }>;
  aiPins?: LocalAiPin[];
  investigations?: LocalAppInvestigation[];
}

export type DashboardDisplayMetadata = {
  mode: 'manual' | 'ai_generated' | 'block_hint';
  component:
    | 'BusinessBrief'
    | 'KpiMetric'
    | 'TrendPanel'
    | 'RankingPanel'
    | 'EvidenceTable'
    | 'PivotTable'
    | 'TrustCallout'
    | 'NarrativePanel'
    | 'ResearchActions';
  defaultVisualization: string;
  allowedVisualizations: string[];
  fieldHints?: Record<string, string>;
  layoutIntent: 'auto' | 'compact' | 'standard' | 'wide' | 'tall' | 'full';
  rationale: string;
  trustState: 'certified' | 'review_required' | 'draft_ready';
  reviewStatus: 'certified' | 'draft_ready' | 'review_required';
};

export interface DbtFirstModelingResponse {
  requestId?: string;
  snapshotId: string;
  manifestVersion: 3;
  dbtProvenance: ManifestDbtProvenance;
  modeling: ManifestDbtFirstModeling;
  domainAssets?: Record<string, Record<string, string[]>>;
  lineage: ManifestLineage;
  diagnostics: ManifestDiagnostic[];
  snapshot?: { id: string; stale: boolean; error?: string };
}

/** A business term as the manifest compiles it (`term "Name" { … }`). */
export interface BusinessTerm {
  name: string;
  filePath: string;
  domain?: string;
  owner?: string;
  status?: string;
  termType?: string;
  tags?: string[];
  description?: string;
  identifiers?: string[];
  synonyms?: string[];
  metricRefs?: string[];
  businessOutcome?: string;
  businessOwner?: string;
  decisionUse?: string;
  reviewCadence?: string;
  businessRules?: string[];
  caveats?: string[];
}

export type BusinessTermInput = Omit<BusinessTerm, 'filePath'>;

/** A domain Ask can be scoped to, with its subject areas and the purposes its imports are approved for. */
export interface AskScopeOption {
  id: string;
  label: string;
  parent?: string;
  areas: Array<{ id: string; name: string }>;
  purposes: string[];
}

/** What Ask will do for questions scoped to a domain (and subject area). */
export interface AskImpactResponse {
  domain: string;
  area?: string;
  skills: Array<{ id: string; description?: string; scope: 'domain' | 'project'; triggers: string[]; vocabularyCount: number; requiredFilters: string[]; policy: string[]; status: string; findable: boolean }>;
  requiredFilters: Array<{ text: string; skill: string }>;
  relationships: Array<{ name: string; from: string; to: string; keys: string; level: 'certified' | 'validated' | 'draft' | 'stale' }>;
  imports: Array<{ id: string; exportRef: string; purpose: string; status: string; usable: boolean }>;
  terms: number;
  concepts: number;
  certifiedBlocks: number;
}

/** A warehouse profile of a join before its cardinality is chosen. */
export interface RelationshipProfileResponse {
  proposed: { cardinality: ManifestModelRelationship['cardinality']; fanout: ManifestModelRelationship['fanout'] };
  evidence: NonNullable<ManifestModelRelationship['validation']>;
}

export interface RelationshipKeySuggestion {
  keys: Array<{ from: string; to: string }>;
  source: 'dbt_test' | 'same_name' | 'named_for_table';
  reason: string;
}

export interface DbtModelInventoryItem {
  uniqueId: string;
  /** `warehouse` is a table or view read from the warehouse catalog (warehouse-first and hybrid modeling). */
  resourceType: 'model' | 'source' | 'warehouse';
  name: string;
  packageName?: string;
  relation?: string;
  sourcePath?: string;
  identityFingerprint: string;
  available: {
    description: boolean;
    columns: boolean;
    tests: boolean;
    catalogTypes: boolean;
    dqlMeta: boolean;
  };
  binding?: {
    domain?: string;
    businessName?: string;
    owner?: string;
    status?: string;
  };
}

export interface DbtModelInventoryResponse {
  items: DbtModelInventoryItem[];
  nextCursor: number | null;
  total: number;
  snapshotId: string;
  manifestPath?: string;
  projectName?: string;
  scope?: 'dbt_relations' | 'warehouse_relations';
}

/** The warehouse catalog snapshot's state, as Settings and Modeling show it (RFC 0007). */
export interface WarehouseCatalogSummary {
  path: string;
  relations?: number;
  fingerprint?: string;
  capturedAt?: string;
  connectionId?: string;
  warnings?: string[];
  skipped?: string;
  error?: string;
  /** What changed since the previous sync, and the modeled objects it touches. */
  drift?: {
    addedRelations: string[];
    removedRelations: string[];
    addedColumns: string[];
    removedColumns: string[];
    changedColumnTypes: string[];
    affected: string[];
  };
}

/** What `Draft from warehouse` found, before anything is written. */
export interface WarehouseDiscoveryReport {
  catalogFingerprint: string;
  capturedAt: string;
  relations: number;
  domains: Array<{ id: string; name: string; existing: boolean }>;
  entities: Array<{ id: string; domain: string; relation: string; grain?: string; existing?: string }>;
  relationships: Array<{ id: string; domain: string; from: string; to: string; keys: Array<{ from: string; to: string }>; cardinality: string; evidence: Array<{ source: string; reason: string }> }>;
  existingRelationships: number;
  validated: boolean;
  queryHistory?: { statements: number; joins: number } | { error: string };
}

export interface DomainWorkspaceSummary {
  id: string;
  parent?: string;
  owner?: string;
  filePath?: string;
  readiness: 'ready' | 'attention' | 'setup';
  counts: Record<string, number>;
}

export interface RelatedDomainProducts {
  domain: string | null;
  apps: Array<{ id: string; name: string; filePath: string; ownerDomain?: string; usesDomains: string[]; purpose?: string; requiredExports: string[]; classification?: string; lifecycle?: string }>;
  notebooks: Array<{ id: string; title: string; filePath: string; ownerDomain?: string; usesDomains: string[]; purpose?: string; requiredExports: string[]; classification?: string }>;
  snapshotId: string;
}

export interface DomainKnowledgeResponse {
  schemaVersion: number;
  snapshotId: string;
  sourceFingerprint: string;
  domainId: string;
  capsule?: ManifestDomainCapsule;
  counts: {
    objects: number;
    edges: number;
    routes: number;
    routeStates: Record<string, number>;
  };
  objects: ManifestKnowledgeObject[];
  edges: ManifestKnowledgeEdge[];
  routes: ManifestCrossDomainRoute[];
  truncated: boolean;
}

// ── dbt-first onboarding API contracts ──────────────────────────────────

export type OnboardingCapability = {
  available: boolean;
  optional?: boolean;
  message?: string;
};

export type OnboardingCapabilities = {
  dbt?: OnboardingCapability | boolean;
  warehouse?: OnboardingCapability | boolean;
  ai?: OnboardingCapability | boolean;
};

export interface SetupLaunchResponse {
  requestId: string;
  version: string;
  acknowledgedVersion: string | null;
  dbtAppliedVersion: string | null;
  requiresDbtReapply: boolean;
  shouldOpen: boolean;
  reason: 'first_install' | 'version_upgrade' | null;
}

export type DbtOnboardingErrorCode =
  | 'DBT_PROJECT_NOT_FOUND'
  | 'DBT_MANIFEST_MISSING'
  | 'DBT_ARTIFACT_INVALID'
  | 'DBT_PARSE_FAILED'
  | 'DBT_REAPPLY_REQUIRED'
  | 'SOURCE_CHANGED'
  | 'SNAPSHOT_BUILD_FAILED'
  | 'DOMAIN_COLLISION'
  | 'DOMAIN_MEMBERSHIP_AMBIGUOUS'
  | 'WAREHOUSE_UNAVAILABLE'
  | 'AI_PROVIDER_UNAVAILABLE';

export interface DbtOnboardingStatusResponse {
  requestId?: string;
  snapshotId?: string;
  dbt?: {
    configured?: boolean;
    projectDir?: string;
    manifestPath?: string;
    profilesDir?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    projectFound?: boolean;
    manifestFound?: boolean;
    artifactState?: 'missing' | 'ready' | 'stale' | 'invalid' | 'building';
  };
  modeling?: {
    enabled?: boolean;
    manifestVersion?: number;
    mode?: string;
    snapshotState?: 'missing' | 'building' | 'ready' | 'stale' | 'failed';
  };
  domains?: {
    count?: number;
    draftCount?: number;
    state?: 'none' | 'draft' | 'ready';
  };
  capabilities?: OnboardingCapabilities;
  preparation?: DbtOnboardingJob;
  snapshot?: { id?: string; error?: string };
  readiness?: Record<string, unknown>;
}

export interface DbtOnboardingPreviewRequest {
  projectDir?: string;
  manifestPath?: string;
  profilesDir?: string;
  repoUrl?: string;
  branch?: string;
  subPath?: string;
  catalogPath?: string;
  semanticManifestPath?: string;
}

export interface DbtOnboardingPreviewResponse {
  requestId?: string;
  snapshotId?: string;
  projectDir: string;
  manifestPath: string;
  profilesDir?: string;
  repoUrl?: string;
  branch?: string;
  subPath?: string;
  warnings?: string[];
  fingerprint: string;
  projectName?: string;
  counts: { models: number; sources: number; metrics: number; [key: string]: number };
  artifacts: {
    manifest: string | null;
    catalog?: string | null;
    semanticManifest?: string | null;
  };
  commands?: string[];
  capabilities?: OnboardingCapabilities;
}

export interface DbtOnboardingApplyResponse {
  requestId?: string;
  snapshotId?: string;
  jobId?: string;
  id?: string;
  kind?: string;
  status?: string;
  stage?: string;
  progress?: number;
  message?: string;
  phases?: DbtOnboardingPhase[];
  result?: Record<string, unknown>;
  error?: string;
  applied?: boolean;
  fingerprint?: string;
  config?: Record<string, unknown>;
}

export interface DbtOnboardingPhase {
  id: 'artifact_validation' | 'snapshot_compile' | 'search_index';
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  durationMs?: number;
}

export interface DbtOnboardingJob {
  id: string;
  kind?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage?: string;
  progress?: number;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
  snapshotId?: string;
  phases?: DbtOnboardingPhase[];
  diagnostics?: Array<{ code?: string; message: string; level?: string }>;
  result?: Record<string, unknown>;
  error?: string;
}

export interface DbtOnboardingJobResponse {
  requestId?: string;
  snapshotId?: string;
  job?: DbtOnboardingJob;
  id?: string;
  kind?: string;
  status?: DbtOnboardingJob['status'];
  stage?: string;
  progress?: number;
  message?: string;
  phases?: DbtOnboardingPhase[];
  diagnostics?: DbtOnboardingJob['diagnostics'];
  result?: Record<string, unknown>;
  error?: string;
}

export interface DomainDiscoveryEvidence {
  kind: string;
  value: string;
  source?: string;
  dbtUniqueId?: string;
}

export interface DomainDiscoveryProposal {
  id: string;
  name: string;
  description?: string;
  parent?: string;
  confidence: 'high' | 'medium' | 'low' | number;
  score?: number;
  evidence: DomainDiscoveryEvidence[];
  conflicts?: string[];
  requiresHumanDecision?: boolean;
  members?: Array<{ dbtUniqueId: string; evidence?: DomainDiscoveryEvidence[] }>;
  lifecycle?: 'draft';
  targetFile?: string;
}

export interface DomainDiscoveryResponse {
  requestId?: string;
  snapshotId?: string;
  sourceFingerprint?: string;
  proposals: DomainDiscoveryProposal[];
  capabilities?: OnboardingCapabilities;
  warnings?: string[];
}

export interface DomainDiscoveryApplyResponse {
  requestId?: string;
  snapshotId?: string;
  jobId?: string;
  applied?: boolean;
  domains?: Array<{ id: string; filePath?: string; lifecycle?: string }>;
  preview?: Array<{ path: string; operation: string; summary?: string }>;
}

export interface ModelingApplyResponse {
  requestId?: string;
  snapshotId: string;
  applied: ModelingChangePreview;
  modeling: ManifestDbtFirstModeling;
  diagnostics: ManifestDiagnostic[];
}

export type DashboardTileFilterBinding = {
  filter: string;
  binding?: string;
  mode?: 'parameter' | 'predicate' | 'semantic';
  paramNames?: string[];
  required?: boolean;
  unsupportedReason?: string;
  capability?: 'supported' | 'unsupported' | 'preflight_required';
};

export type DashboardTileParameterBinding = {
  param: string;
  source: 'dashboard_filter' | 'constant' | 'persona' | 'variable';
  filter?: string;
  field?: string;
  value?: unknown;
  parameterType?: BlockParameterDefinition['type'];
  required?: boolean;
  default?: unknown;
  policy?: BlockParameterDefinition['policy'];
};

export type DashboardTileSourceEvidence = {
  source: string;
  reason: string;
  kind?: string;
  nodeId?: string;
  path?: string;
  trustState?: DashboardDisplayMetadata['trustState'];
};

export type VisualizationRecommendationResponse =
  | {
      ok: true;
      display: DashboardDisplayMetadata;
      evidence: Array<{ source: string; reason: string }>;
      warnings: string[];
    }
  | { ok: false; error: string };

export type NotebookResearchIntent =
  | 'ad_hoc_analysis'
  | 'diagnose_change'
  | 'driver_breakdown'
  | 'segment_compare'
  | 'entity_drilldown'
  | 'anomaly_investigation'
  | 'trust_gap_review';

export type NotebookResearchStatus = 'draft' | 'running' | 'ready' | 'error';
export type NotebookResearchReviewStatus = 'needs_review' | 'draft_created' | 'completed' | 'certified' | 'rejected';
export type NotebookResearchDqlPromotionAction = 'reuse_existing' | 'extend_existing' | 'create_replacement' | 'create_new' | 'review_required';
export type NotebookResearchReadinessFilter = 'draft_ready' | 'certification_ready' | 'blocked';
export type NotebookResearchAgeFilter = 'stale_open' | 'expired_open';
export type NotebookResearchSort = 'priority' | 'updated_desc';
export interface NotebookResearchSourceCellPayload {
  id?: string;
  sourceCellId?: string;
  cellId?: string;
  name?: string;
  sourceCellName?: string;
  title?: string;
  fingerprint?: string;
  sourceCellFingerprint?: string;
  sqlFingerprint?: string;
  type?: string;
  sql?: string;
  content?: string;
  source?: string;
}
export type NotebookResearchNextActionFilter =
  | 'fix_blockers'
  | 'review_sql'
  | 'review_context'
  | 'run_preview'
  | 'reuse_existing'
  | 'create_dql_draft'
  | 'open_certification'
  | 'complete_review'
  | 'continue_review';

export interface NotebookResearchDqlPromotionCandidate {
  id: string;
  name: string;
  domain?: string;
  draftPath?: string;
  savedPath?: string;
  reviewStatus?: string;
  recommendedAction?: DqlCandidateRecommendedAction | string;
  similarityMatches: BlockSimilarityMatch[];
  parameterPolicy: Array<{ name: string; policy: string }>;
  allowedFilters: string[];
  warnings: string[];
}

export interface NotebookResearchDqlPromotion {
  importId: string;
  candidateIds: string[];
  draftBlockPath?: string;
  recommendedAction?: DqlCandidateRecommendedAction | string;
  similarityMatches: BlockSimilarityMatch[];
  candidates: NotebookResearchDqlPromotionCandidate[];
  createdAt: string;
}

export interface NotebookResearchReuseCheckResponse {
  run: NotebookResearchRun;
  promotion: NotebookResearchDqlPromotion;
  match: {
    parameterDecisions: DqlGenerationCandidate['parameterDecisions'];
    parameterPolicy: DqlGenerationCandidate['parameterPolicy'];
    filterBindings: DqlGenerationCandidate['filterBindings'];
    allowedFilters: string[];
    parameterizedSql: string;
    similarityMatches: DqlGenerationCandidate['similarityMatches'];
    recommendedAction: DqlGenerationCandidate['recommendedAction'];
  };
}

export interface NotebookResearchReviewChecklist {
  readyForDqlDraft: boolean;
  readyForCertificationReview: boolean;
  blockers: string[];
  warnings: string[];
  items: Array<{
    id: string;
    label: string;
    status: 'passed' | 'pending' | 'warning' | 'blocked';
    detail: string;
  }>;
}

export interface NotebookResearchPlan {
  sqlState: 'missing' | 'generated' | 'reviewed';
  grain?: string;
  parameterPolicy: Array<{ name: string; policy: string }>;
  allowedFilters: string[];
  evidence: {
    trustLabel?: string;
    contextPackId?: string;
    evidenceCount: number;
    relationCount: number;
    missingContextCount: number;
  };
  preview: {
    status: 'not_run' | 'ready' | 'error';
    rowCount?: number;
  };
  promotion: {
    path: 'needs_sql' | 'review_context' | 'run_preview' | 'reuse_existing' | 'create_dql_draft' | 'open_certification' | 'complete_review';
    duplicateDecision?: string;
  };
  reviewFocus: string[];
  generatedAt: string;
}

export interface NotebookResearchRun {
  id: string;
  notebookPath: string;
  domain?: string;
  owner?: string;
  sourceCellId?: string;
  sourceCellName?: string;
  sourceCellFingerprint?: string;
  title: string;
  question: string;
  intent: NotebookResearchIntent;
  context?: unknown;
  status: NotebookResearchStatus;
  summary?: string;
  recommendation?: string;
  resultPreview?: QueryResult;
  evidence?: unknown;
  researchPlan?: NotebookResearchPlan;
  generatedSql?: string;
  reviewedSql?: string;
  dqlArtifact?: AgentConversationDqlArtifact;
  display?: DashboardDisplayMetadata;
  contextPackId?: string;
  routeDecision?: unknown;
  warnings: string[];
  reviewStatus: NotebookResearchReviewStatus;
  error?: string;
  draftBlockPath?: string;
  dqlImportId?: string;
  dqlCandidateIds: string[];
  dqlPromotionAction?: NotebookResearchDqlPromotionAction;
  dqlPromotion?: NotebookResearchDqlPromotion;
  reviewChecklist?: NotebookResearchReviewChecklist;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface NotebookResearchListResponse {
  runs: NotebookResearchRun[];
  total: number;
  domains: Array<{
    domain: string;
    total: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    nextAction?: NotebookResearchNextActionFilter;
    nextActionCount?: number;
  }>;
  owners: Array<{
    owner: string;
    total: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    nextAction?: NotebookResearchNextActionFilter;
    nextActionCount?: number;
  }>;
  intents: Array<{
    intent: NotebookResearchIntent;
    total: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    nextAction?: NotebookResearchNextActionFilter;
    nextActionCount?: number;
  }>;
  notebooks: Array<{
    path: string;
    title: string;
    total: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    nextAction?: NotebookResearchNextActionFilter;
    nextActionCount?: number;
  }>;
  counts: {
    total: number;
    ready: number;
    needsReview: number;
    dqlDrafts: number;
    errors: number;
    reuseExisting: number;
    extendExisting: number;
    replacements: number;
    createNew: number;
    draftReady: number;
    certificationReady: number;
    blocked: number;
    staleOpen: number;
    expiredOpen: number;
    sourceLinked: number;
    nextActions: Record<NotebookResearchNextActionFilter, number>;
  };
  groupCounts: {
    domains: number;
    owners: number;
    intents: number;
    notebooks: number;
  };
  reviewMetrics: {
    totalReviewCount: number;
    openReviewCount: number;
    terminalReviewCount: number;
    draftCreatedCount: number;
    certifiedCount: number;
    completedCount: number;
    rejectedCount: number;
    draftCreationRate: number | null;
    certifyConversionRate: number | null;
    medianOpenReviewAgeMs: number | null;
    medianTimeToDraftMs: number | null;
    medianTimeToCertificationMs: number | null;
    medianTimeToTerminalMs: number | null;
  };
  limit?: number;
  offset: number;
}

export type AgentRunRequestedMode = 'auto' | 'ask' | 'research' | 'sql' | 'block' | 'app' | 'modeling' | 'skill';
export type AgentRunRoute =
  | 'conversation'
  | 'certified_answer'
  | 'semantic_answer'
  | 'generated_answer'
  | 'research'
  | 'sql_cell'
  | 'dql_block_draft'
  | 'modeling_draft'
  | 'skill_draft'
  | 'app_build'
  | 'clarify'
  | 'cancelled'
  | 'blocked';
export type AgentRunAnswerKind = 'governed' | 'conversational' | 'general_knowledge';
export type AgentRunStatus = 'completed' | 'needs_review' | 'needs_clarification' | 'cancelled' | 'blocked';
export type AgentRunTrustState = 'certified' | 'governed' | 'grounded' | 'review_required' | 'blocked' | 'not_applicable';
export type AgentRunLifecycleState = 'queued' | 'running' | 'cancelling' | 'terminal';
export type AgentRunStopReason =
  | 'conversational_reply'
  | 'certified_answer_found'
  | 'governed_semantic_answer'
  | 'governed_compound_answer'
  | 'generated_review_required'
  | 'artifact_created'
  | 'needs_clarification'
  | 'human_review_required'
  | 'cancelled'
  | 'blocked';
export type AgentRunArtifactKind = 'answer' | 'research_run' | 'sql_cell' | 'dql_block_draft' | 'app_draft' | 'app_proposal' | 'app_autopilot_change' | 'modeling_change_proposal' | 'skill_change_proposal';

export interface MixedSourceNotebookPlan {
  datasetId?: string;
  datasetName?: string;
  localDataset: string;
  localAlias: string;
  localKey: string;
  warehouseKey: string;
  warehouseExpression: string;
  warehouseSql: string;
  warehouseRelations?: string[];
}
export type AgentRunEvaluationSeverity = 'info' | 'warning' | 'blocking';

export interface AgentRunSelectedObject {
  kind: 'notebook' | 'cell' | 'block' | 'app' | 'dashboard' | 'research' | 'workspace' | 'domain' | 'model_area' | 'model' | 'relationship' | 'skill';
  id?: string;
  title?: string;
  path?: string;
}

export interface AgentRunRepairAction {
  kind: 'retry' | 'escalate';
  route?: AgentRunRoute;
  hint?: string;
}

export interface AgentRunEvaluation {
  id: string;
  label: string;
  passed: boolean;
  severity: AgentRunEvaluationSeverity;
  message: string;
  evidence?: unknown;
  suggestedRepair?: string;
  repairAction?: AgentRunRepairAction;
}

export type AgentRunStepStatus =
  | 'passed'
  | 'repaired'
  | 'needs_review'
  | 'escalated'
  | 'clarify'
  | 'blocked';

export interface AgentRunPlannedStep {
  id: string;
  route: AgentRunRoute;
  goal: string;
  successCriteria: string[];
}

export interface AgentRunPlan {
  source: 'llm' | 'deterministic';
  rationale: string;
  steps: AgentRunPlannedStep[];
}

export interface AgentRunStep {
  id: string;
  index: number;
  route: AgentRunRoute;
  goal: string;
  successCriteria: string[];
  status: AgentRunStepStatus;
  attempts: number;
  summary?: string;
  evaluations: AgentRunEvaluation[];
  artifacts: AgentRunArtifact[];
}

export interface AgentRunArtifact {
  id: string;
  kind: AgentRunArtifactKind;
  title: string;
  trustState: AgentRunTrustState;
  ref?: string;
  payload?: unknown;
}

export interface AgentRunNextAction {
  id: string;
  label: string;
  route?: AgentRunRoute;
  artifactKind?: AgentRunArtifactKind;
}

export interface AgentRunClarificationOption {
  id: string;
  label: string;
  description?: string;
  kind?: string;
  question?: string;
}

export interface AgentRunEvent {
  id: string;
  runId: string;
  type:
    | 'run.started'
    | 'plan.created'
    | 'step.started'
    | 'route.decided'
    | 'executor.started'
    | 'evaluation.recorded'
    | 'replan.decided'
    | 'repair.attempted'
    | 'escalated'
    | 'artifact.created'
    | 'step.completed'
    | 'run.completed'
    | 'run.cancelled'
    | 'run.failed';
  at: string;
  message: string;
  route?: AgentRunRoute;
  status?: AgentRunStatus;
  trustState?: AgentRunTrustState;
  payload?: unknown;
}

export interface AgentRunLifecycleV1 {
  version: 1;
  state: AgentRunLifecycleState;
  phase: AgentRunEvent['type'] | 'queued';
  revision: number;
  eventCursor: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface AgentRunDiagnosticReceiptV1 {
  version: 1;
  runId: string;
  phase: string;
  route?: AgentRunRoute;
  plan?: AgentRunPlan;
  steps: AgentRunStep[];
  artifacts: AgentRunArtifact[];
  evaluations: AgentRunEvaluation[];
  failure?: {
    code: string;
    phase: string;
    message: string;
    recoverable: boolean;
    safeActions: string[];
  };
  repairCapability?: AnalyticalRepairCapabilityV1;
  providerEgressReceipts?: ProviderEgressReceiptV1[];
}

export interface AnalyticalRepairCapabilityV1 {
  version: 1;
  automatic: {
    eligible: boolean;
    action: 'repair_embedded_sql' | 'none';
    correctionCode: 'SQL_EXECUTION_REPAIR' | 'MANUAL_REVIEW_REQUIRED';
    attemptsRemaining: number;
  };
  failureFingerprint: string;
  sourceFingerprint: string;
  planFingerprint: string;
  dqlFingerprint: string;
  sqlFingerprint: string;
  targetFingerprint: string;
  routeLocked: true;
  targetLocked: true;
  sourceImmutable: true;
  manualActions: Array<'edit_dql' | 'open_sql_notebook' | 'refresh_snapshot' | 'retry_same_plan' | 'change_authorized_connection' | 'request_access'>;
  ineligibilityReason?: string;
}

export interface ProviderEgressReceiptV1 {
  version: 1;
  // `classification` is the legacy/no-evidence category-only router call; it
  // is distinct from candidate-ID `meaning_resolution` receipts.
  // `answer_narration` is retained for older local receipts. New ordinary Ask
  // runs do not dispatch it and it never authorizes result-row egress.
  purpose: 'classification' | 'answer_generation' | 'answer_narration' | 'research_narration' | 'research_tool' | 'repair_sql';
  dispatchPhase?: 'classification' | 'meaning_resolution' | 'planning' | 'generation' | 'narration' | 'repair';
  provider: string;
  model?: string;
  operation?: 'generate' | 'generate_with_tools' | 'generate_stream';
  attemptIndex?: number;
  options?: { maxTokens?: number; temperature?: number; reasoningEffort?: 'low' | 'medium' | 'high' };
  permittedCategories: string[];
  resultRowCount: number;
  cumulativeResultRowCount?: number;
  columnCount: number;
  redactionPolicyId: string;
  optIn: boolean;
  payloadFingerprint: string;
  /** Historical V1/V2 ordinary narration evidence; read-only, never a new egress grant. */
  legacyReadOnly?: true;
}

export interface AgentRunTelemetryV1 {
  version: 1;
  stageDurationsMs: Partial<Record<'snapshot' | 'retrieval' | 'schema' | 'meaning' | 'provider' | 'tools' | 'validation' | 'repair' | 'execution' | 'narration' | 'persistence' | 'total', number>>;
  providerRoundTrips: number;
  toolCalls: number;
  sqlExecutions: number;
  repairs: number;
  egressReceipts: number;
  warehouseDurationMs?: number;
  fallbackReason?: string;
}

export interface AgentRunDiagnosticReceiptV2 {
  version: 2;
  runId: string;
  route?: AgentRunRoute;
  status: AgentRunStatus;
  telemetry: AgentRunTelemetryV1;
  providerEgressReceiptFingerprints: string[];
  repairCapabilityFingerprint?: string;
}

export interface AgentRunDiagnosticReceiptV3 {
  version: 3;
  runId: string;
  sourceCoverage: Array<{
    version: 1;
    source: 'certified' | 'semantic' | 'governed_relational' | 'exploratory' | 'dbt_manifest' | 'runtime_schema' | 'vector' | 'conversation';
    status: 'available' | 'empty' | 'stale' | 'unavailable' | 'errored' | 'skipped';
    candidateIds: string[];
    reason?: string;
  }>;
  cascade?: {
    version: 1;
    planFrozen: boolean;
    selectedTier?: 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql';
    stopReason: 'selected' | 'ambiguous' | 'coverage_gap' | 'denied' | 'post_freeze_failure';
    terminalGap?: {
      version: 1;
      code: 'MISSING_RELATIONSHIP';
      requirement: 'certified_relationship_or_allocation_proof';
      witnessCandidateIds: string[];
    };
    attempts: Array<{
      version: 1;
      tier: 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql' | 'clarify_or_gap';
      outcome: 'executable' | 'ineligible' | 'unavailable' | 'ambiguous' | 'denied';
      candidateIds: string[];
      reason: string;
      planFrozen: boolean;
    }>;
  };
  terminalGap?: {
    version: 1;
    code: 'MISSING_RELATIONSHIP';
    requirement: 'certified_relationship_or_allocation_proof';
    witnessCandidateIds: string[];
  };
  planFrozen: boolean;
  orchestrationMode?: 'legacy' | 'shadow' | 'agentic';
  provider?: {
    version: 1;
    cause: 'authentication' | 'model_not_found' | 'rate_limited' | 'gateway' | 'network' | 'provider_timeout' | 'run_deadline' | 'admission_denied' | 'dispatch_budget' | 'cancelled' | 'unknown';
    phase: 'preflight' | 'classification' | 'meaning_resolution' | 'planning' | 'generation' | 'repair' | 'narration' | 'unknown';
    retryable: boolean;
    safeAction: 'retry_same_provider' | 'fix_provider_configuration' | 'wait_and_retry' | 'inspect_run' | 'none';
  };
  finalStopReason: string;
}

/** Canonical content-safe Ask story produced by the server once per run. */
export interface AskDecisionSummaryV1 {
  version: 1;
  summaryFingerprint: string;
  understoodRequest: {
    measures: number;
    dimensions: number;
    entityRequested: boolean;
    outputCount: number;
    ranking?: { direction: 'top' | 'bottom'; limit: number; defaultedLimit: boolean };
    conversationBinding: 'none' | 'structured_clarification' | 'prior_result' | 'task_dependency';
  };
  evidenceByRole: Array<{ role: 'metric' | 'entity_key' | 'entity_label' | 'categorical_dimension' | 'time_dimension' | 'member' | 'relationship' | 'context'; candidateCount: number }>;
  tierDecisions: Array<{ tier: 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql' | 'clarify_or_gap'; outcome: 'executable' | 'ineligible' | 'unavailable' | 'ambiguous' | 'denied'; planFrozen: boolean }>;
  selectedPlan?: { tier: 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql'; planFrozen: boolean; reviewRequired: boolean };
  terminalIncident?: AskTerminalIncidentV1;
  /** Stored branch-level limitation evidence for a root-successful Research run. */
  researchBranchSummary?: AskResearchBranchSummaryV1;
  safeNextAction: AskTerminalIncidentV1['safeAction'] | 'none';
}

/** Additive V4 Research evidence. Branch prompts, rows, SQL, and provider content are never retained here. */
export interface AskResearchBranchSummaryV1 {
  version: 1;
  totalBranches: number;
  completedBranches: number;
  receiptBackedBranches: number;
  failedBranches: number;
  timedOutBranches: number;
  skippedBranches: number;
  partialSuccess: boolean;
  failureReasons: Array<{
    code: 'execution_failed' | 'research_branch_timeout' | 'budget_exhausted' | 'run_deadline' | 'cancelled';
    branchCount: number;
  }>;
  availableChildPlans: Array<{
    tier: 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql';
    frozenPlanCount: number;
    branchCount: number;
    reviewRequired: boolean;
  }>;
  linkedChildRunCount: number;
  safeAction: 'inspect_research_failures';
}

export interface AskTerminalIncidentV1 {
  version: 1;
  code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH' | 'CONNECTION_NOT_CONFIGURED' | 'COMPILATION_FAILED' | 'RESULT_CONTRACT_MISMATCH' | 'ANALYTICAL_EXECUTION_FAILED' | 'ANALYTICAL_COVERAGE_GAP' | 'PROVIDER_FAILURE' | 'RESEARCH_BRANCH_TIMEOUT' | 'RESEARCH_RUN_DEADLINE' | 'CANCELLED';
  boundary: 'plan.compile' | 'semantic.compile' | 'sql.authorize' | 'sql.execute' | 'result.validate' | 'provider' | 'cascade' | 'run';
  origin: 'internal_invariant' | 'governance_gate' | 'semantic_compiler' | 'plan_compiler' | 'result_validator' | 'provider' | 'warehouse' | 'unknown';
  impact: 'execution_not_attempted' | 'execution_failed' | 'answer_not_produced' | 'run_cancelled';
  safeAction:
    | 'export_redacted_trace'
    | 'configure_connection'
    | 'change_authorized_connection'
    | 'inspect_failure'
    | 'retry_same_plan'
    | 'refresh_snapshot'
    | 'edit_dql'
    | 'open_sql_notebook'
    | 'request_access'
    | 'reapply_semantic_runtime'
    | 'review_analytical_failure'
    | 'inspect_research_failures'
    | 'none';
}

export interface AgentRunDiagnosticReceiptV4 {
  version: 4;
  runId: string;
  summary: AskDecisionSummaryV1;
  terminalIncident?: AskTerminalIncidentV1;
  finalStopReason: string;
}

/** V1.15 default Ask trace story. Detailed spans remain in the local trace page. */
export interface AskDecisionSummaryV2 {
  version: 2;
  summaryFingerprint: string;
  runtimeMode: 'legacy' | 'shadow' | 'authoritative';
  whatHappened: string;
  why: string;
  impact: string;
  nextAction: AskTerminalIncidentV1['safeAction'] | 'none';
  selectedCompiler?: 'certified' | 'metricflow' | 'governed_relational' | 'exploratory_sql' | 'none';
  programTaskCount: number;
  admittedCandidateCount: number;
  toolCallCount: number;
  executionAttempts: number;
}

export interface AgentRunDiagnosticReceiptV5 {
  version: 5;
  runId: string;
  summary: AskDecisionSummaryV2;
  finalStopReason: string;
  state?: Record<string, unknown>;
  businessAnswer?: {
    version: 1;
    mode: 'facts_only' | 'deterministic_fallback';
    trustState: AgentRunTrustState;
    factIds: string[];
    resultFingerprint?: string;
    limitationCount: number;
  };
  provider?: {
    version: 1;
    cause: string;
    phase: string;
    retryable: boolean;
    safeAction: string;
    httpStatusClass?: '4xx' | '5xx';
    providerFingerprint?: string;
    modelFingerprint?: string;
    baseOriginFingerprint?: string;
  };
}

/** Concise default Ask story. Raw trace spans remain available only in Advanced. */
export interface AgentRunDiagnosticReceiptV6 extends Omit<AgentRunDiagnosticReceiptV5, 'version'> {
  version: 6;
  planning?: {
    version: 1;
    mode: string;
    plannerCalls: number;
    revisionCalls: number;
    verification: { status: string; missingRoles: string[]; candidateIds: string[]; reasonCode: string };
  };
  roleCoverage: Array<{ role: string; candidateCount: number }>;
  cascade: {
    attempts: Array<{ tier: string; outcome: string; planFrozen: boolean }>;
    selectedTier?: string;
    stopReason?: string;
    planFrozen: boolean;
  };
  origin?: { boundary: string; origin: string; impact: string };
  connection: { attempted: boolean };
  execution: { attempts: number };
  facts: { factCount: number; resultFingerprint?: string };
  safeNextAction: AgentRunDiagnosticReceiptV5['summary']['nextAction'];
  story: Array<{
    stage: 'retrieval' | 'role_coverage' | 'planner' | 'verification' | 'targeted_recovery' | 'cascade' | 'freeze' | 'connection' | 'execution' | 'facts';
    status: 'completed' | 'skipped' | 'blocked' | 'unavailable';
    reasonCode: string;
  }>;
}


/**
 * Additive V2 Ask-tool receipt.  This intentionally mirrors only the
 * redacted local API projection: no question text, prompt, SQL, rows,
 * credentials, provider response, or hidden reasoning is browser-readable.
 */
export interface AskContextCoverageV2 {
  version: 2;
  source: string;
  status: 'available' | 'empty' | 'stale' | 'unavailable' | 'errored' | 'skipped';
  admittedCandidateCount: number;
  excludedCandidateCount: number;
  reasonCodes: string[];
}

export interface AskToolObservationV1 {
  version: 1;
  tool: string;
  outcome: 'eligible' | 'executed' | 'ineligible' | 'unavailable' | 'ambiguous' | 'needs_input' | 'denied' | 'error';
  tier?: string;
  reasonCode: string;
  candidateIds: string[];
  planId?: string;
  frozen?: boolean;
  retryable?: boolean;
  safeAction?: string;
  durationMs?: number;
  inputFingerprint?: string;
  outputFingerprint?: string;
  origin?: string;
  provider?: { phase: string; cause: string; retryable: boolean; safeAction: string };
}

export interface AskCascadeTierAttemptV2 {
  version: 2;
  tier: string;
  outcome: AskToolObservationV1['outcome'];
  reasonCode: string;
  candidateIds: string[];
  frozen: boolean;
  durationMs?: number;
}

export interface AgentRunDiagnosticReceiptV8 {
  version: 8;
  mode: 'authoritative_v2';
  turnClass: 'analytics' | 'definition' | 'business_context' | 'prior_result' | 'general' | 'clarification_response' | 'research';
  snapshotId?: string;
  retainedCandidateCount: number;
  initialCandidateCount: number;
  expansionCount: number;
  objective: 'analytics' | 'definition' | 'business_context' | 'prior_result' | 'general' | 'clarification_response' | 'research';
  contextCoverage: AskContextCoverageV2[];
  excludedCandidateCount: number;
  exclusionReasonCodes: string[];
  observations: AskToolObservationV1[];
  tierAttempts: AskCascadeTierAttemptV2[];
  /** Current authoritative controller progression when no plan is frozen. */
  controllerTier?: string;
  planFrozen: boolean;
  terminalOutcome?: { version: 2; kind: string; reasonCode: string; safeAction?: string; origin: string };
  outcome: {
    connectionAttempted: boolean;
    executionAttempts: number;
    factCount: number;
    narration: 'fact_bound' | 'deterministic_fallback' | 'not_retained' | 'not_applicable';
  };
  /** Canonical V8 counts; server egress owns provider dispatches. */
  activity?: {
    providerDispatches: number;
    toolCalls: number;
    executionAttempts: number;
    repairs: number;
  };
  toolDurationMs: number;
  finalStopReason: string;
}

/**
 * Narrow persisted Ask envelope used by reader-facing surfaces. The complete
 * local continuation is server-owned; the browser only needs this stable
 * runtime identity to select the fact-bound BusinessAnswer presentation.
 */
export interface AskAnalystRuntimeStateV1 {
  version: 1;
  mode: 'legacy' | 'shadow' | 'authoritative';
  phase: 'framed' | 'evidence_ready' | 'program_ready' | 'compiled' | 'executed' | 'clarify' | 'blocked';
  frame?: {
    version: 3;
    questionFingerprint: string;
    kind: string;
  };
  program?: {
    version: 1;
    id: string;
    taskIds?: string[];
  };
  counters?: {
    planningContinuations: number;
    toolCalls: number;
    executionAttempts: number;
    repairAttempts: number;
  };
}

/** Reader-facing fact-bound answer; raw executor prose is not a UI authority. */
export interface AgentRunBusinessAnswerV1 {
  version: 1;
  mode: 'facts_only' | 'deterministic_fallback';
  trustState: AgentRunTrustState;
  factIds: string[];
  resultFingerprint?: string;
  /** Additive ordinary-Ask task receipt; absent on older persisted runs. */
  taskOutcomeSummary?: AnalyticalTaskOutcomeSummaryV1;
  answer?: string;
  limitations: string[];
}

/** Additive V2 ordinary-Ask task receipts. Older run JSON deliberately omits these. */
export type AnalyticalTaskOutcomeTrustStateV1 = 'certified' | 'governed' | 'review_required' | 'blocked' | 'not_applicable';
export type AnalyticalTaskOutcomeStatusV1 = 'completed' | 'partial' | 'gap' | 'blocked' | 'dependency_blocked';

export interface AnalyticalTaskFailureV1 {
  version: 1;
  code: string;
  message: string;
  phase: 'planning' | 'execution' | 'dependency';
}

export interface AnalyticalTaskOutcomeV1 {
  version: 1;
  taskId: string;
  status: AnalyticalTaskOutcomeStatusV1;
  trustState?: AnalyticalTaskOutcomeTrustStateV1;
  summary?: string;
  resultFingerprint?: string;
  gap?: Record<string, unknown>;
  failure?: AnalyticalTaskFailureV1;
  dependencyTaskIds?: string[];
}

export interface AnalyticalTaskOutcomeSummaryV1 {
  version: 1;
  status: 'completed' | 'partial' | 'blocked';
  trustState: AnalyticalTaskOutcomeTrustStateV1;
  taskCount: number;
  successfulTaskIds: string[];
  failedTaskIds: string[];
  dependencyBlockedTaskIds: string[];
}

/** Content-free persisted outcome of the answer narration stage. */
export interface NarrationIntegrityReceiptV1 {
  version: 1;
  mode: 'skip' | 'verified_facts' | 'preview_grounded';
  outcome: 'skipped' | 'success' | 'deterministic_fallback' | 'error';
  attempted: boolean;
  factCount: number;
  maxRows: number;
  validationFailures: string[];
  skipReason?: 'no_answer' | 'no_provider' | 'nothing_to_narrate' | 'ordinary_ask';
  errorCode?: 'narration_error';
}

export interface AgentRunProgressV1 {
  version: 1;
  id: string;
  question: string;
  requestedMode: AgentRunRequestedMode;
  selectedObject?: AgentRunSelectedObject;
  executionTarget?: ExecutionTarget;
  route?: AgentRunRoute;
  trustState?: AgentRunTrustState;
  plan?: AgentRunPlan;
  steps: AgentRunStep[];
  artifacts: AgentRunArtifact[];
  evaluations: AgentRunEvaluation[];
  events: AgentRunEvent[];
  lifecycle: AgentRunLifecycleV1;
  analyticalTurnPlan?: Record<string, unknown>;
  analyticalTaskOutcomes?: AnalyticalTaskOutcomeV1[];
  analyticalTaskOutcomeSummary?: AnalyticalTaskOutcomeSummaryV1;
  /** OBS-001: compact pointer only; full trace detail is fetched by run id. */
  traceReference?: AgentRunTraceReferenceV1;
}

/**
 * Local Ask observability is intentionally not part of an AgentRun body. This
 * additive reference lets the UI navigate to typed, redacted evidence without
 * copying a prompt, SQL text, result rows, or provider payload into a run.
 */
export interface AgentRunTraceReferenceV1 {
  version: 1;
  traceId: string;
  recordingStatus: 'recording' | 'complete' | 'partial' | 'unavailable' | 'detail_expired';
  storeSchemaVersion: 1;
  traceFingerprint?: string;
}

export type AskTraceSpanOutcomeV1 = 'ok' | 'error' | 'denied' | 'cancelled' | 'skipped' | 'unavailable' | 'interrupted';
export type AskTraceRecordingStatusV1 = AgentRunTraceReferenceV1['recordingStatus'];

/** A bounded, redacted observation returned by the local-only trace API. */
export interface AskTraceSpanV1 {
  version: 1;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  ordinal: number;
  name: string;
  stage: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  outcome: AskTraceSpanOutcomeV1;
  reasonCode: string;
  payload: {
    kind: 'stage' | 'snapshot' | 'retrieval' | 'meaning' | 'cascade' | 'provider' | 'tool' | 'sql' | 'result' | 'conversation' | 'research' | 'persistence';
    [key: string]: unknown;
  };
}

export interface AskTraceCandidateDecisionV1 {
  version: 1;
  traceId: string;
  sequence: number;
  candidateId: string;
  displayLabel?: string;
  role: string;
  source: string;
  lane?: string;
  laneRank?: number;
  fusedRank?: number;
  decision: 'retrieved' | 'reserved' | 'admitted' | 'extended' | 'model_selected' | 'model_rejected' | 'excluded';
  reasonCode: string;
  compatibilityCode?: string;
}

export interface AskTraceLinkV1 {
  version: 1;
  kind: 'research_branch' | 'clarification_continuation' | 'derived_repair' | 'prior_result';
  sourceTraceId: string;
  sourceRunId: string;
  targetTraceId?: string;
  targetRunId?: string;
  hypothesisFingerprint?: string;
  choiceFingerprint?: string;
  verdictFingerprint?: string;
  createdAt: string;
}

export interface AskTraceEnvelopeV1 {
  version: 1;
  traceId: string;
  rootSpanId: string;
  runId: string;
  surface: 'browser' | 'cli' | 'mcp' | 'chat';
  mode: 'ask' | 'research';
  threadId?: string;
  snapshotId?: string;
  questionFingerprint: string;
  status: 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'interrupted';
  terminalOutcome?: 'completed' | 'needs_review' | 'needs_clarification' | 'cancelled' | 'blocked';
  recordingStatus: AskTraceRecordingStatusV1;
  trustState?: string;
  selectedTier?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  firstIssueSpanId?: string;
  traceFingerprint?: string;
  spanCount: number;
  candidateDecisionCount: number;
  droppedRecordCount: number;
  parentTraceId?: string;
  parentRunId?: string;
}

export interface AskTraceAnswerV1 {
  sql?: string;
  sqlParams?: unknown[];
  /** In place of sqlParams when someone other than the asker reads the trace (a steward reviewing hints): no values. */
  sqlParamCount?: number;
  /** The SQL's literals (strings, numbers, comments) are masked as `?`: the trace is read by someone other than the asker. */
  sqlLiteralsMasked?: boolean;
  /** The warehouse said why it failed, in words that can quote a value: withheld from someone other than the asker. */
  executionErrorWithheld?: boolean;
  dqlArtifact?: { kind?: string; name?: string; source?: string; metrics?: string[]; dimensions?: string[] };
  columns?: Array<string | { name: string }>;
  rowsSample?: Array<Record<string, unknown> | unknown[]>;
  rowCount?: number;
  /** In place of rowCount for someone other than the asker: a range ('none', '1', '2-10', '11-100', '101-1000', 'more than 1000'). */
  rowCountBucket?: string;
  evaluations?: Array<{ id?: string; label?: string; passed?: boolean; message?: string }>;
  status?: string;
  gap?: { kind?: string; message?: string };
  executionError?: string;
  failedStage?: string;
  certifiedBlockRef?: string;
  proof?: string[];
}

export interface AskTraceDataV1 {
  envelope: AskTraceEnvelopeV1;
  spans: AskTraceSpanV1[];
  candidateDecisions: AskTraceCandidateDecisionV1[];
  links: AskTraceLinkV1[];
  /** Joined at read time from the durable run receipt; old traces omit it. */
  decisionSummary?: AskDecisionSummaryV1;
  runtimeDecisionSummary?: AskDecisionSummaryV2;
  /** Same redacted V5 projection returned by the full trace API. */
  runtimeReceiptV5?: AgentRunDiagnosticReceiptV5;
  /** Same redacted V6 decision story returned by the full trace API. */
  runtimeReceiptV6?: AgentRunDiagnosticReceiptV6;
  /** Same redacted V8 tool-runtime receipt returned by the full trace API. */
  runtimeReceiptV8?: AgentRunDiagnosticReceiptV8;
  /** The Ask pipeline's receipt (`diagnosticReceiptV9` on the run), when the run carries one. */
  runtimeReceiptV9?: Record<string, unknown>;
  /** The answer a pipeline trace explains, read from the saved run: SQL, DQL, a row sample and how the turn ended. */
  runtimeAnswerV1?: AskTraceAnswerV1;
  /** Server-owned Ask rollout mode joined from the durable run; old traces omit it. */
  runtimeMode?: 'authoritative_v2' | 'pipeline_v3';
  /**
   * Someone other than the asker (a steward reviewing hints) is reading this trace: it was rebuilt to carry how the
   * question was answered and none of its values (no rows, AI replies, check messages, question words; SQL masked).
   */
  valuesWithheld?: boolean;
}

export interface AskTraceStoreStatusV1 {
  available: boolean;
  schemaVersion: number;
  recordingEnabled: boolean;
  readOnly?: boolean;
  reason?: 'unsupported_schema' | 'store_error' | 'disabled';
}

export interface AskTraceListEntryV1 extends AskTraceEnvelopeV1 {
  detailAvailable: boolean;
  /** Joined at API read time from the local run store; never persisted in the trace store. */
  questionPreview?: string;
  scenarioLabel?: string;
  /** One plain sentence on why the run was answered, held or refused; joined with the question preview. */
  reason?: string;
  runtimeMode?: 'authoritative_v2' | 'pipeline_v3';
}

export interface AskTraceListQueryV1 {
  limit?: number;
  cursor?: string;
  status?: AskTraceEnvelopeV1['status'];
  mode?: AskTraceEnvelopeV1['mode'];
  trustState?: string;
  selectedTier?: string;
  surface?: AskTraceEnvelopeV1['surface'];
  recordingStatus?: AskTraceRecordingStatusV1;
}

export interface AskTraceListResponseV1 {
  traces: AskTraceListEntryV1[];
  nextCursor?: string;
  total?: number;
}

export interface AgentRunKnowledge {
  version: 1;
  note?: string;
  citations: Array<{ sourceId: string; sourceLabel: string; docId: string; title: string; url?: string }>;
  contextOnly: true;
  figuresRemoved?: number;
}

export interface AgentRun {
  id: string;
  question: string;
  requestedMode: AgentRunRequestedMode;
  route: AgentRunRoute;
  status: AgentRunStatus;
  trustState: AgentRunTrustState;
  stopReason: AgentRunStopReason;
  startedAt: string;
  completedAt: string;
  selectedObject?: AgentRunSelectedObject;
  executionTarget?: ExecutionTarget;
  routeDecision?: unknown;
  plan?: AgentRunPlan;
  steps: AgentRunStep[];
  summary: string;
  answer?: string;
  answerKind?: AgentRunAnswerKind;
  /** Team documents the answer read (knowledge sources): cited context, never a figure source or part of trust. */
  knowledge?: AgentRunKnowledge;
  artifacts: AgentRunArtifact[];
  evaluations: AgentRunEvaluation[];
  events: AgentRunEvent[];
  nextActions: AgentRunNextAction[];
  clarificationOptions?: AgentRunClarificationOption[];
  repairAttempts: number;
  lifecycle?: AgentRunLifecycleV1;
  diagnosticReceipt?: AgentRunDiagnosticReceiptV1;
  diagnosticReceiptV2?: AgentRunDiagnosticReceiptV2;
  diagnosticReceiptV3?: AgentRunDiagnosticReceiptV3;
  diagnosticReceiptV4?: AgentRunDiagnosticReceiptV4;
  diagnosticReceiptV5?: AgentRunDiagnosticReceiptV5;
  diagnosticReceiptV6?: AgentRunDiagnosticReceiptV6;
  diagnosticReceiptV8?: AgentRunDiagnosticReceiptV8;
  /** Additive Ask-pipeline receipt (intent, candidates, refusals, executed SQL fingerprint, verbatim failures). */
  diagnosticReceiptV9?: Record<string, unknown>;
  /** Server-owned rollout mode; this is never client-controlled. */
  askAgentRuntimeMode?: 'authoritative_v2' | 'pipeline_v3';
  businessAnswer?: AgentRunBusinessAnswerV1;
  /** Persisted server-owned runtime checkpoint; client consumes the narrow stable shape only. */
  askAnalystState?: AskAnalystRuntimeStateV1;
  narrationIntegrityReceipt?: NarrationIntegrityReceiptV1;
  telemetry?: AgentRunTelemetryV1;
  /** OBS-001: compact local trace reference; trace detail is never embedded here. */
  traceReference?: AgentRunTraceReferenceV1;
  /** A run rebuilt from a thread turn: the saved run it came from, so its record can still be read. */
  agentRunId?: string;
  /**
   * Graduated trust, Tier 2: the draft block a review-required answer left for
   * review (never certified). The executed DQL artifact itself stays transient.
   */
  reviewDraft?: { version: 1; path: string; status: 'draft'; askedTimes: number; created: boolean; fingerprint: string };
  repairCapability?: AnalyticalRepairCapabilityV1;
  providerEgressReceipts?: ProviderEgressReceiptV1[];
  derivation?: {
    version: 1 | 2 | 3;
    kind: 'analytical_repair' | 'authoring_revision';
    sourceRunId: string;
    sourceFailureId?: string;
    sourceArtifactId?: string;
    attempt: number;
    revision?: number;
  };
  analyticalTurnPlan?: Record<string, unknown>;
  analyticalTaskOutcomes?: AnalyticalTaskOutcomeV1[];
  analyticalTaskOutcomeSummary?: AnalyticalTaskOutcomeSummaryV1;
}

export type AgentRunStateResponse =
  | { lifecycleState: 'terminal'; run: AgentRun }
  | { lifecycleState: Exclude<AgentRunLifecycleState, 'terminal'>; progress: AgentRunProgressV1 };

export interface AnalyticalRepairRequest {
  version: 1;
  action:
    | 'retry_same_plan'
    | 'parameter_rerun'
    | 'refresh_snapshot'
    | 'edit_dql'
    | 'open_sql_notebook'
    | 'change_authorized_connection'
    | 'request_access'
    | 'save_draft_block';
  parameterValues?: Record<string, unknown>;
  dqlSource?: string;
  sqlText?: string;
  refreshedSnapshotId?: string;
  authorizedConnectionFingerprint?: string;
  governedValidationPassed?: boolean;
}

export interface AnalyticalRepairDerivationResponse {
  status: 'ready';
  derivation: {
    version: 1;
    derivationId: string;
    sourceRunId: string;
    derivedRunId: string;
    action: AnalyticalRepairRequest['action'];
    snapshotId: string;
    planFingerprint: string;
    routeLocked: true;
    permissionsExpanded: false;
    trustTransition: {
      previous: 'certified' | 'governed' | 'review_required';
      next: 'certified' | 'governed' | 'review_required';
      requiresNewReceipt: boolean;
      requiresReview: boolean;
      preservesCertifiedAssetIdentity: boolean;
    };
  };
}

export interface CertifiedBlockInvocationResponse {
  result: QueryResult & {
    sql?: string;
    blockName?: string;
    blockPath?: string;
    chartConfig?: unknown;
    parameters?: Array<{ name: string; value: unknown; source: string }>;
    auditId?: string;
  };
  parameters: BlockParameterDefinition[];
}

export interface DqlArtifactInvocationResponse extends CertifiedBlockInvocationResponse {
  artifact: DqlArtifactReference;
}

export type AgentRunAudience = 'stakeholder' | 'analyst';

/**
 * A reader-selected result cell. This is a stable reference to a persisted
 * server result, not conversational prose. The local host validates all six
 * fields before it may affect an Ask follow-up after reload or restart.
 */
export interface AgentSelectedResultBinding {
  version: 1;
  sourceRunId: string;
  sourceArtifactId: string;
  canonicalColumn: string;
  value: string;
  rowFingerprint: string;
  resultFingerprint: string;
}

/**
 * The chat-composer "thinking" selection. `auto` (default) lets the engine adapt
 * effort + verification depth to the question shape; the manual modes trade speed
 * against rigor for the whole thread. Sent per run as `thinkingMode`.
 */
export type AgentThinkingMode = 'auto' | 'low' | 'medium' | 'high';

export interface CreateAgentRunInput {
  question: string;
  /**
   * The submission's identity, minted by the caller once per explicit submit
   * and sent as `Idempotency-Key`. It never travels in the body: a retry of
   * the same submission attaches to the run the first attempt started.
   */
  requestId?: string;
  selectedEvidenceId?: string;
  selectedResultBinding?: AgentSelectedResultBinding;
  /** Original analytical question for an identifier-bound clarification choice. */
  clarificationSourceQuestion?: string;
  requestedMode?: AgentRunRequestedMode;
  mode?: AgentRunRequestedMode;
  audience?: AgentRunAudience;
  intent?: string;
  signals?: Record<string, unknown>;
  selectedObject?: AgentRunSelectedObject;
  executionTarget?: ExecutionTarget;
  workspaceContext?: Record<string, unknown>;
  conversationContext?: AgentConversationContext;
  context?: Record<string, unknown>;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /**
   * Server-side conversation thread. When present the server injects prior turns
   * into the conversation context and persists this run as a new turn — the
   * client-built conversationContext stays the no-threadId fallback.
   */
  threadId?: string;
  /** The composer's thinking selection for this run (auto/low/medium/high). */
  thinkingMode?: AgentThinkingMode;
  /** Explicit consent for this Research run only; defaults false and is never inherited. */
  researchResultRowsOptIn?: boolean;
}

export interface RequestCertificationInput {
  question: string;
  generatedSql?: string;
  dqlArtifact?: AgentConversationDqlArtifact;
  notebookPath?: string;
  domain?: string;
  owner?: string;
  context?: Record<string, unknown>;
}

export interface RequestCertificationResult {
  ok: boolean;
  researchRunId?: string;
  notebookPath?: string;
  error?: string;
}

export type AgentHintStatus = 'candidate' | 'approved' | 'rejected' | 'retired';

export interface AgentHintDependency {
  id: string;
  kind: 'relation' | 'dbt_model' | 'metric' | 'domain' | 'term' | 'block' | 'semantic';
  name: string;
  fingerprint: string;
  sourcePath?: string;
}

export interface AgentHintCheck {
  name: string;
  passed: boolean;
  evidence?: string;
}

export interface AgentHintGraphEdge {
  hintId: string;
  kind:
    | 'belongs_to_domain'
    | 'refines_metric'
    | 'uses_dbt_model'
    | 'uses_relation'
    | 'uses_column'
    | 'refines_term'
    | 'relates_to_block'
    | 'uses_dialect'
    | 'depends_on'
    | 'derived_from'
    | 'validated_by'
    | 'supersedes';
  targetId: string;
  targetKind: string;
  targetName: string;
  fingerprint?: string;
  source: 'scope' | 'dependency' | 'corrected_sql' | 'lifecycle';
}

export interface AgentHintLesson {
  version: 1;
  category:
    | 'semantic_rule'
    | 'filter_rule'
    | 'join_rule'
    | 'aggregation_rule'
    | 'grain_rule'
    | 'time_rule'
    | 'relation_rule'
    | 'dialect_rule';
  rule: string;
  intentExamples: string[];
  avoid: string[];
  expectedOutcome?: string;
}

export interface AgentHint {
  id: string;
  title: string;
  guidance: string;
  lesson?: AgentHintLesson;
  status: AgentHintStatus;
  scope: { metric?: string; dbtModel?: string; domain?: string; dialect?: string; term?: string; block?: string };
  correctedSql?: string;
  tags?: string[];
  author?: string;
  reviewer?: string;
  snapshotId?: string;
  requiredEvaluation?: string;
  evaluationId?: string;
  evaluationStatus?: 'passed' | 'failed';
  dependencies?: AgentHintDependency[];
  graphEdges?: AgentHintGraphEdge[];
  lifecycleErrors?: Array<{ code: string; message: string; at: string }>;
  supersedes?: string;
  trace?: {
    id: string;
    question: string;
    wrongAnswer: string;
    correction: string;
    rationale?: string;
    evidence?: string[];
  };
  evaluation?: {
    id: string;
    status: 'passed' | 'failed';
    evaluation: string;
    evaluator: string;
    checks: AgentHintCheck[];
    evidence: string[];
    note?: string;
    createdAt: string;
  };
  inspection?: {
    currentSnapshotId: string;
    snapshotCurrent: boolean;
    dependenciesCurrent: boolean;
    driftedDependencies: AgentHintDependency[];
    checks: AgentHintCheck[];
    state: 'current' | 'stale' | 'invalid' | 'unverified';
  };
  exclusions?: Array<{ reason: string; detail: string; relatedHintId?: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentHintListResponse {
  hints: AgentHint[];
  counts: { candidate: number; approved: number; rejected: number; retired: number };
  error?: string;
}

export interface AgentRunListResponse {
  runs: AgentRun[];
  total: number;
  limit: number;
}

export type AgentRunStreamMessage =
  /**
   * The runtime has accepted the request and minted the only run identity that
   * may be used for cancellation, reload, or capability-scoped execution.
   */
  | { kind: 'accepted'; runId: string; operationId?: string; replayed?: boolean }
  | { kind: 'event'; event: AgentRunEvent }
  | { kind: 'answer-delta'; delta: string }
  | { kind: 'complete'; run: AgentRun };

// ── Conversation threads (server-side session persistence) ──────────────

export interface AgentConversationThread {
  id: string;
  surface: string;
  title?: string;
  notebookPath?: string;
  rollingSummary?: string;
  structuredSummary?: {
    version: 1;
    entries: Array<{
      sourceTurnId: string;
      state: 'confirmed' | 'provisional' | 'unresolved' | 'blocked' | 'context';
      question: string;
      answerSummary?: string;
      evidenceRefs?: string[];
    }>;
  };
  archived: boolean;
  /** User-pinned conversation, surfaced ahead of the rest in the sidebar. */
  favorite?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Server-owned project identity for reconciling the browser's temporary Ask
 * rendering cache. It is an opaque fingerprint, never a local path or user
 * identity, and is only returned by the local thread-list endpoint.
 */
export interface AgentConversationThreadListResponse {
  threads: AgentConversationThread[];
  projectIdentity?: string;
}

export interface AgentConversationTurnResult {
  columns?: string[];
  rowsSample?: unknown[][];
  /** Units per column, so a thread restored from the server renders by contract. */
  columnsMeta?: Array<{ name: string; kind: 'currency' | 'percent' | 'number' | 'count' | 'duration' | 'date' | 'text' | 'boolean'; unit?: string; decimals?: number; ref?: string; grain?: string }>;
  dimensionValues?: Record<string, string[]>;
  measureColumns?: string[];
  rowCount?: number;
}

/** One persisted question/answer pair in a conversation thread (seq-ordered). */
export interface AgentConversationTurn {
  id: string;
  threadId: string;
  agentRunId?: string;
  seq: number;
  question: string;
  answerSummary?: string;
  answerText?: string;
  route?: string;
  trustLabel?: string;
  runStatus?: string;
  stopReason?: string;
  certification?: string;
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  sql?: string;
  dqlArtifact?: AgentConversationDqlArtifact;
  cascade?: AgentAnswerCascade;
  narrationIntegrityReceipt?: NarrationIntegrityReceiptV1;
  result?: AgentConversationTurnResult;
  contract?: Record<string, unknown>;
  createdAt: string;
}

export interface NotebookResearchDiagnostics {
  counts: {
    totalRuns: number;
    activeRuns: number;
    closedRuns: number;
    notebooks: number;
    domains: number;
    owners: number;
    sourceLinkedRuns: number;
  };
  health: {
    staleOpenRuns: number;
    expiredOpenRuns: number;
    staleThresholdDays: number;
    expiredThresholdDays: number;
    oldestOpenUpdatedAt?: string;
    newestOpenUpdatedAt?: string;
  };
  search: {
    indexed: boolean;
    indexRows: number;
    indexVersion?: string;
    stale: boolean;
  };
  updatedAt: {
    oldest?: string;
    newest?: string;
  };
  limits: {
    pageSize: number;
    maxPageSize: number;
    sourceCoverageLimit: number;
    seedCellLimit: number;
  };
  warnings: string[];
}

export interface NotebookResearchSeedCellsResponse {
  created: NotebookResearchRun[];
  createdCount: number;
  skippedCount: number;
  limitApplied?: boolean;
}

export interface NotebookResearchSourceCoverageResponse {
  runs: NotebookResearchRun[];
  requestedCount: number;
  matchedCount: number;
  limitApplied?: boolean;
}

export interface NotebookResearchContextPreview {
  contextPackId: string;
  trustLabel?: string;
  routeDecision?: {
    route?: string;
    intent?: string;
    reason?: string;
  };
  evidence: Array<{
    objectKey?: string;
    objectType?: string;
    name: string;
    role?: string;
    reason: string;
  }>;
  summaries: Array<{
    title: string;
    detail: string;
    objectType?: string;
    reason?: string;
  }>;
  relations: Array<{
    relation: string;
    name: string;
    source: string;
    columns: string[];
  }>;
  missingContext: Array<{
    kind: string;
    message: string;
    severity: string;
  }>;
  warnings: string[];
  topRejected: Array<{
    name: string;
    objectType?: string;
    reason: string;
    score?: number;
  }>;
  counts: {
    objects: number;
    evidence: number;
    relations: number;
    warnings: number;
  };
}

export type NotebookResearchUpdateInput =
  Partial<Pick<
    NotebookResearchRun,
    'domain' | 'owner' | 'title' | 'question' | 'intent' | 'context' | 'evidence' | 'contextPackId' | 'routeDecision' | 'generatedSql' | 'reviewedSql' | 'dqlArtifact' | 'warnings' | 'reviewStatus' | 'recommendation' | 'dqlPromotionAction'
  >> & {
    sourceCell?: NotebookResearchSourceCellPayload;
    sourceCellId?: string | null;
    sourceCellName?: string | null;
    sourceCellFingerprint?: string | null;
  };

export interface NotebookExecutionContext {
  notebookPath?: string;
  cellId?: string;
  cellName?: string;
  researchRunId?: string;
  source?: string;
  runId?: string;
}

export interface DashboardDocumentResponse {
  app: AppDocumentSummary['app'];
  dashboard: {
    version: 1 | 2 | 3;
    id: string;
    metadata: {
      title: string;
      description?: string;
      domain?: string;
      subdomain?: string;
      groups?: string[];
      audience?: string;
      visibility?: 'shared' | 'private' | 'template';
      lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
      tags?: string[];
      businessOutcome?: string;
      businessOwner?: string;
      decisionUse?: string;
      reviewCadence?: string;
      businessRules?: string[];
      caveats?: string[];
      /** The author added the auto-written Summary to this page (D6). */
      summary?: boolean;
    };
    params?: Array<{ id: string; type: string; default?: unknown; description?: string }>;
    filters?: Array<{
      id: string;
      type: string;
      label?: string;
      default?: unknown;
      options?: string[];
      bindsTo?: string;
      field?: { name: string; relation?: string; semanticModel?: string; provider?: string };
      required?: boolean;
      multiple?: boolean;
      scope?: { app?: boolean; page?: string; tileIds?: string[] };
      /** v3 maps a global field explicitly to each Dataset; matching names
       * across unrelated sources never create a binding. `tileIds` keeps an
       * author-selected component subset when tiles share one Dataset;
       * omitted retains legacy all-tile behavior while [] excludes all. */
      datasetBindings?: Record<string, { field: string; tileIds?: string[] }>;
      optionSource?: { mode: 'static' | 'distinct_query'; sourceRef?: string; field?: string; snapshotId?: string; limit?: number };
      dependsOn?: string[];
    }>;
    /** Story layout sections (optional) — narrated flow for AI-built apps. */
    sections?: Array<{
      id: string;
      title: string;
      kind: 'exec_summary' | 'kpi_band' | 'insight' | 'appendix';
      narrative?: string;
      order: number;
    }>;
    story?: {
      version: 1;
      goal: string;
      audience?: string;
      eligibleTileIds?: string[];
      driverTileIds?: string[];
      vocabulary?: string[];
    };
    /** Story layout (RFC 0008 step 8): prose with bound figures and embedded tiles. */
    narrative?: DashboardNarrativeV1;
    /** Governed HTML page (RFC 0008 step 9). */
    canvas?: DashboardCanvasV1;
    /** v3 field-builder source registry retained with the Git-owned page. */
    datasets?: Array<{
      id: string;
      sourceId: string;
      sourceRevision: string;
      snapshotId: string;
      contractFingerprint: string;
    }>;
    /** Field-bound, source-qualified interactions. They are authored in the
     * Studio and interpreted by the local runtime; result display names never
     * create a mapping by themselves. */
    interactions?: {
      crossFilter?: {
        enabled?: boolean;
        mappings: Array<{ fromTileId: string; fromField: string; toDataset: string; toField: string }>;
      };
      detail?: { dataset: string; columns: string[] };
      navigate?: Array<{ fromTile: string; toPage: string; carryFilters: string[] }>;
    };
    layout: {
      kind: 'grid';
      cols: number;
      rowHeight: number;
      items: Array<{
        i: string;
        x: number; y: number; w: number; h: number;
        /** Markdown note readers see under the title. */
        description?: string;
        /** Who answers for this tile's numbers. */
        owner?: string;
        /** A "Why did it move?" driver tile (RFC 0008 step 7). */
        driver?: DashboardDriverDefinitionV1;
        sourceId?: string;
        sourceRevision?: string;
        block?: { blockId?: string; ref?: string; version?: string };
        text?: { markdown: string };
        aiPin?: { id: string };
        semantic?: {
          id: string;
          provider: 'metricflow' | 'native';
          metrics: string[];
          dimensions?: string[];
          filters?: Array<{ field: string; operator: string; value: unknown }>;
          timeDimension?: string;
          orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
          limit?: number;
          semanticModelRefs: string[];
          qualifiedMetricIds?: string[];
          qualifiedModelIds?: string[];
          resolvedPlanFingerprint?: string;
          definitionFingerprint: string;
          snapshotId?: string;
        };
        draftAnalysis?: {
          ref: string;
          artifactFingerprint: string;
          snapshotId?: string;
          executionReceiptId?: string;
        };
        /** Declarative, server-validated Dataset field selection. */
        query?: TileQuery;
        viz: { type: string; options?: Record<string, unknown>; style?: DashboardVizStyle; encoding?: DashboardVizEncoding };
        display?: DashboardDisplayMetadata;
        filterBindings?: DashboardTileFilterBinding[];
        parameterBindings?: DashboardTileParameterBinding[];
        sourceEvidence?: DashboardTileSourceEvidence[];
        sourceClass?: 'certified_block' | 'governed_semantic' | 'exploratory_analysis' | 'narrative';
        review?: {
          status: 'not_required' | 'required' | 'approved';
          sourceFingerprint?: string;
          preflightReceiptId?: string;
          reviewedAt?: string;
          reviewedBy?: string;
        };
        trustState?: DashboardDisplayMetadata['trustState'];
        reviewStatus?: DashboardDisplayMetadata['reviewStatus'];
        title?: string;
        /** Story layout: section membership (optional). */
        sectionId?: string;
      }>;
      responsive?: {
        wide?: {
          kind: 'grid'; cols: number; rowHeight: number;
          items: DashboardDocumentResponse['dashboard']['layout']['items'];
        };
        medium?: {
          kind: 'grid'; cols: number; rowHeight: number;
          items: DashboardDocumentResponse['dashboard']['layout']['items'];
        };
        narrow?: {
          kind: 'grid'; cols: number; rowHeight: number;
          items: DashboardDocumentResponse['dashboard']['layout']['items'];
        };
      };
    };
  };
}

export interface AppExecutionRepairTrace {
  version: 1;
  status: 'repaired' | 'failed';
  source: 'query_generator' | 'semantic_query' | 'draft_analysis' | 'certified_block' | 'review_block';
  mode?: 'deterministic' | 'ai';
  attemptedAt: string;
  originalFailure: string;
  originalSqlFingerprint?: string;
  repairedSqlFingerprint?: string;
  approvalEligible: false;
  message: string;
}

export interface DashboardTileArtifact {
  version: 1;
  sourceKind: 'certified_block' | 'review_block' | 'semantic_query' | 'dataset_query' | 'draft_analysis' | 'ai_pin';
  name: string;
  sourcePath?: string;
  /**
   * A redacted, declarative Dataset TileQuery specification for inspection.
   * It is not DQL source and it never carries bound parameter values.
   */
  authoredQuerySpec?: string;
  dql?: string;
  sql?: string;
  trustState: 'certified' | 'review_required';
  explanation?: string[];
  executionTarget?: { target: 'local' } | { target: 'connection'; connectionName?: string };
}

/**
 * Complete-source declared-grain evidence returned by the App runtime. The
 * counts remain nested under `uniqueness`, matching the server-side receipt.
 * Tile result rows must never be used to infer this proof.
 */
export interface DashboardDatasetGrainRuntimeEvidence {
  status?: 'passed' | 'failed';
  uniqueness?: {
    rowCount: number;
    distinctKeyCount: number;
    nullKeyCount: number;
    duplicateKeyCount: number;
  };
  /** Transitional fields for a previously serialized receipt shape. */
  rowCount?: number;
  distinctKeyCount?: number;
  duplicateKeyGroups?: number;
  nullKeyRows?: number;
  targetFingerprint?: string;
  parameterFingerprint?: string;
  checkedAt?: string;
}

/** Safe parameter-binding evidence. Values remain server-side and are never serialized to an App viewer. */
export interface DashboardDatasetParameterEvidence {
  name: string;
  kind: 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object';
  valueCount?: number;
  valueFingerprint: string;
}

/**
 * Server-derived execution lineage for a Dataset tile. This is useful evidence
 * for a block-backed Dataset, but is deliberately distinct from a provider
 * execution receipt. Semantic Dataset runs may additionally expose
 * `semanticReceipt` below.
 */
export interface DashboardDatasetExecutionProvenance {
  version: 1;
  kind: 'block_runtime' | 'semantic_runtime';
  sourceId: string;
  sourceRevision: string;
  contractFingerprint: string;
  queryFingerprint: string;
  filterFingerprint: string;
  executionFingerprint: string;
  parameterFingerprint: string;
  compiledSqlFingerprint?: string;
  executedSqlFingerprint?: string;
  resultFingerprint?: string;
  targetFingerprint?: string;
}

/**
 * A local cache delivery is distinct from fresh execution provenance. It
 * preserves the original receipt reference without exposing SQL or result
 * rows, and cannot become App publication or replacement authority.
 */
export interface DashboardDatasetCacheDeliveryReceipt {
  version: 1;
  kind: 'dataset_cache_delivery';
  cacheKey: string;
  originalReceiptId: string;
  sourceRevision: string;
  contractFingerprint: string;
  targetFingerprint: string;
  cachedAt: string;
  expiresAt: string;
}

/**
 * A server-applied dashboard filter. Legacy block executions identify the
 * dashboard filter by `filter`; Dataset executions identify the approved
 * physical field and operator instead. Raw values are never displayed by the
 * App evidence UI.
 */
export interface DashboardRunAppliedFilter {
  filter?: string;
  field?: string;
  op?: string;
  values?: unknown[];
  placement?: 'where' | 'having';
  binding?: string;
  mode?: 'parameter' | 'predicate';
  paramNames?: string[];
}

/** A legacy skipped filter or a Dataset mapping issue returned by the runtime. */
export interface DashboardRunFilterIssue {
  filter?: string;
  filterId?: string;
  reason?: string;
  code?: string;
  message?: string;
}

/** One page of a Dataset field's distinct values (see `api.datasetFieldValues`). */
export type DatasetFieldValuesResponse = {
  ok: boolean;
  values: string[];
  /** More values exist than were returned. */
  truncated?: boolean;
  /** How many values the field has (browsing only), up to the server's count limit. */
  valueCount?: number;
  /** The field has more values than the server counts. */
  valueCountCapped?: boolean;
  /** The search text these values match, when searching. */
  search?: string;
  error?: string;
};

/** What one tile did with the page's filters (see `filterReport`). */
export interface DashboardTileFilterReport {
  applied: string[];
  notApplied: Array<{ filter: string; code: 'does_not_apply' | 'not_linked' | 'unsupported' | 'invalid_value'; reason: string }>;
}

export interface DashboardRunResponse {
  appId: string;
  dashboardId: string;
  persona: unknown;
  runId: string;
  snapshotId: string;
  filterFingerprint: string;
  /** The page's effective filters as one stable id: story editions compare within it. */
  editionScope?: string;
  resultFingerprint: string;
  personaFingerprint: string;
  /** A bounded visible/affected-tile refresh has no reusable dashboard receipt. */
  partial?: boolean;
  executedTileIds?: string[];
  /** The runtime discarded this response before it could become current evidence. */
  stale?: boolean;
  /** Why the run went stale: a newer interaction overtook it, or the project changed while it ran. */
  staleCause?: 'superseded' | 'project_changed';
  staleReason?: string;
  /**
   * A full run can return current safe component results alongside failures.
   * It is deliberately not a receipt candidate: no combined story or Project
   * publication may use it until every authored executable component settles.
   */
  incomplete?: {
    failedTileIds: string[];
    message: string;
    /** The server cleared only the receipt captured when this run began. */
    priorPreviewReceiptInvalidated?: boolean;
  };
  facts: DashboardStoryFact[];
  story: DashboardStoryBrief;
  /**
   * Bounded, ephemeral choices derived server-side from safe result columns in
   * this settled run. They are never persisted into the App document.
   */
  filterOptions?: Array<{
    filterId: string;
    values: string[];
    truncated: boolean;
    sourceTileIds: string[];
    valueCount?: number;
    dateRange?: { min: string; max: string };
  }>;
  tiles: Array<{
    tileId: string;
    status: 'ok' | 'unauthorized' | 'error' | 'unresolved' | 'stale';
    tileType?: 'block' | 'text' | 'aiPin' | 'semantic' | 'dataset' | 'draftAnalysis' | 'driver';
    /** A driver tile's analysis: the change, split by member for each dimension. */
    driver?: DashboardDriverAnalysisV1;
    /** Per-dimension evidence for a driver tile's governed comparison queries. */
    driverEvidence?: Array<{ field: string; status: string; resultFingerprint?: string; executedSqlFingerprint?: string }>;
    blockId?: string;
    blockPath?: string;
    certificationStatus?: string | null;
    /** Who certified this tile's source and when, with the checks that passed (D5). */
    certification?: CertificationByline | null;
    /** Bound to a retired block: what replaces it, for App Studio authors only. */
    retirement?: { replacedBy?: string; replacementPath?: string; deprecatedOn?: string };
    title?: string;
    viz?: { type: string; options?: Record<string, unknown> };
    chartConfig?: Record<string, unknown>;
    result?: QueryResult;
    /**
     * Result columns the tile's source block declares as measures (its metric
     * mappings or output contract). Captions and stories talk about these
     * before guessing from names and values.
     */
    declaredMeasures?: string[];
    /**
     * Whether the tile's source block returns a top-N list (ORDER BY … LIMIT,
     * a top_n parameter, a "Top N" title) or a whole population. A top-N list
     * is led by its first row and never summed.
     */
    ordering?: ResultOrdering;
    text?: { markdown: string };
    aiPin?: LocalAiPin;
    /**
     * Result columns a viewer may safely filter on, decided server-side from a
     * real dialect parse of the SQL that ran. Aggregate outputs are excluded:
     * they would need HAVING, and filtering one in WHERE changes the measure.
     * Never re-derive this in the browser.
     */
    filterableColumns?: Array<{ column: string; predicateTarget: string }>;
    filters?: {
      /** Present for both legacy and Dataset executions, with source-specific identity fields. */
      applied?: DashboardRunAppliedFilter[];
      /** Legacy block filter application issues. */
      skipped?: DashboardRunFilterIssue[];
      /** Dataset filters intentionally unmapped from this tile's source. */
      unbound?: DashboardRunFilterIssue[];
    };
    /**
     * Server truth for every tile type: which page filters (with a value)
     * narrowed this tile and which did not, with why. Readers' "Not filtered
     * by …" pills come from this once a run exists.
     */
    filterReport?: DashboardTileFilterReport;
    invocation?: {
      resolvedParameters: Array<{
        name: string;
        value: unknown;
        source: 'policy' | 'explicit' | 'question' | 'prior_result' | 'surface' | 'default';
      }>;
      unresolvedParameters: string[];
      auditId: string;
    };
    citation?: { kind: string; name: string; path?: string };
    repair?: AppExecutionRepairTrace;
    artifact?: DashboardTileArtifact;
    /** Field-builder receipt. The browser displays it; it does not infer trust. */
    executionFingerprint?: string;
    dataset?: {
      sourceId?: string;
      sourceRevision?: string;
      contractFingerprint?: string;
      trust?: 'certified' | 'review_required';
      lifecycle?: string;
      binding?: DatasetDescriptor['binding'];
      proofState?: string;
      /** Hash of the authored TileQuery that this evidence executed. */
      authoredQueryFingerprint?: string;
      /** Effective ephemeral hierarchy interaction query, when one ran. */
      interactionQueryFingerprint?: string;
      queryFingerprint?: string;
      filterFingerprint?: string;
      executionFingerprint?: string;
      parameterEvidence?: DashboardDatasetParameterEvidence[];
      executionProvenance?: DashboardDatasetExecutionProvenance;
      cacheDelivery?: DashboardDatasetCacheDeliveryReceipt;
      appliedFilters?: Array<unknown>;
      unboundFilters?: Array<{ filterId: string; code: string; message: string }>;
      /** C8 outcome the tile ran under; adaptations are disclosed with the result. */
      validation?: { outcome: 'covered' | 'adapted' | 'needs_review' | 'rejected'; adaptations: Array<{ kind: string; message: string }> };
      grainRuntimeEvidence?: DashboardDatasetGrainRuntimeEvidence;
      /** Joins to related tables the tile used (design D2): who certified each, in plain words. */
      joins?: Array<{ id: string; table: string; trust: 'certified' | 'review_required'; sentence: string }>;
      semanticTargetBinding?: unknown;
      semanticReceipt?: unknown;
      /** Server-derived choices for a declared hierarchy on this effective query. */
      hierarchy?: {
        activeSteps: DashboardDatasetHierarchyDrill['steps'];
        candidates: Array<{
          hierarchyId: string;
          fromField: string;
          fromAlias: string;
          toField: string;
        }>;
        interactionQueryFingerprint?: string;
      };
      /** Approved fields a reader may drill by or read in rows (RFC 0009 step 6a). */
      explore?: { fields: Array<{ name: string; role: string; type: string; grains?: string[]; primary?: boolean }> };
      errors?: string[];
    };
    error?: string;
  }>;
}

/** Live, evidence-free preview of one Dataset field query (App Studio builder). */
export type DatasetTileQueryPreview =
  | {
    ok: true;
    result?: { columns?: unknown[]; rows?: Array<Record<string, unknown>>; rowCount?: number; truncated?: boolean };
    validation?: { outcome: string; adaptations?: Array<{ kind: string; message: string }> };
    trustState?: string;
    /** Joins to related tables the query used (design D2). */
    joins?: Array<{ id: string; table: string; trust: 'certified' | 'review_required'; sentence: string }>;
  }
  | { ok: false; error?: string; validation?: { outcome: string } };

/** Response from the server-owned review-draft save path. SQL and rows never
 * cross this App Studio boundary. */
export type DatasetTileSaveAsBlockResponse =
  | {
    ok: true;
    path: string;
    status: 'draft';
    provenanceFingerprint: string;
    replacementEligible: boolean;
    replacementMessage?: string;
  }
  | { ok: false; code: string; error: string };

/** Server-issued only after a fresh same-read-scope equivalence proof. */
export type DatasetTileReplaceWithBlockResponse =
  | {
    ok: true;
    draft: AppStudioBuildDraft;
    blockPath: string;
    equivalenceProofFingerprint: string;
  }
  | { ok: false; code: string; error: string };

/**
 * M4-CONV-01 is deliberately a server-owned review proposal.  The browser
 * receives the mapped field query and durable lineage for review, but never
 * sends SQL, rows, source capabilities, or an equivalence receipt back.
 */
export type SemanticTileConversionPreviewResponse =
  | {
    ok: true;
    proposalId: string;
    candidate: {
      sourceId: string;
      sourceRevision: string;
      contractFingerprint: string;
      query: TileQuery;
      queryFingerprint: string;
      provenance: SemanticTileConversionProvenanceV1;
    };
    equivalenceProofFingerprint: string;
  }
  | { ok: false; code: string; error: string };

export type SemanticTileConversionAcceptResponse =
  | { ok: true; draft: AppStudioBuildDraft; equivalenceProofFingerprint: string }
  | { ok: false; code: string; error: string };

/**
 * A result-mark selection is source-qualified before it leaves the browser.
 * The runtime resolves it only through an authored Dashboard v3 mapping; a
 * rendered label or matching field name is never sufficient authority.
 */
export interface DashboardDatasetCrossFilter {
  fromTileId: string;
  fromSourceId: string;
  fromSourceRevision: string;
  field: string;
  values: unknown[];
  /** Leave these values out instead of keeping only them. */
  exclude?: boolean;
}

/**
 * Ephemeral execution controls. `runScope` is generated per mounted viewer so
 * a newer interaction only supersedes work from that viewer, never another
 * browser tab. Tile lists are advisory scheduling bounds; server-side source,
 * filter, and receipt validation remains authoritative.
 */
/** Mirrors dql-core DashboardNarrative. */
export interface DashboardNarrativeV1 {
  version: 1;
  presentation: 'story' | 'dashboard' | 'canvas';
  blocks: Array<{ id: string; kind: 'text'; markdown: string } | { id: string; kind: 'tile'; tileId: string }>;
  generatedBy?: 'author' | 'ai' | 'deterministic';
  model?: string;
}

/** Mirrors dql-core DashboardCanvas: checked markup with <dql-value>/<dql-tile>. */
export interface DashboardCanvasV1 {
  version: 1;
  html: string;
  generatedBy?: 'author' | 'ai' | 'deterministic';
  model?: string;
}

export interface CanvasDraftResponseV1 extends Omit<StoryDraftResponseV1, 'narrative'> {
  canvas: DashboardCanvasV1;
}

export type AppMonitorConditionV1 =
  | { kind: 'threshold'; op: '<' | '<=' | '>' | '>='; value: number }
  | { kind: 'change'; direction: 'up' | 'down' | 'either'; percent: number };

export type AppScheduleDeliveryV1 = { kind: 'slack'; channel: string } | { kind: 'email'; to: string[] } | { kind: 'webhook'; url: string };

export interface AppMonitorV1 {
  id: string;
  binding: string;
  when: AppMonitorConditionV1;
  label?: string;
}

/** A schedule that runs a page, with the alerts it checks (RFC 0008 step 10). */
export interface PageMonitorScheduleV1 {
  id: string;
  cron: string;
  digest: boolean;
  enabled: boolean;
  deliver: AppScheduleDeliveryV1[];
  monitors: AppMonitorV1[];
  lastRunAt?: string;
  firingSince: Record<string, string>;
}

export interface PageMonitorsResponseV1 {
  ok: boolean;
  schedules: PageMonitorScheduleV1[];
  /** Where the change was saved, relative to the project. */
  path?: string;
  createdSchedule?: boolean;
  error?: string;
}

export interface AppSnapshotExportV1 {
  ok: boolean;
  html: string;
  fileName: string;
  keyId: string;
  contentSha256: string;
  figures: number;
  error?: string;
}

export interface StoryEditionV1 {
  runId: string;
  createdAt: string;
  resultFingerprint: string;
  filterFingerprint: string;
  /** Present on editions recorded since the evaluation fix; see DashboardRunResponse.editionScope. */
  scope?: string;
  values: Record<string, { display: string; value: number | string | null; label: string }>;
}

export interface StoryDraftResponseV1 {
  ok: boolean;
  error?: string;
  narrative: DashboardNarrativeV1;
  generatedBy: 'ai' | 'deterministic';
  attempts: number;
  issues: string[];
  provider: string | null;
  model: string | null;
  /** True when a model on this machine saw current values. */
  sawValues: boolean;
  elapsedMs: number;
}

/** Mirrors dql-core DashboardDriverDefinition. */
export interface DashboardDriverDefinitionV1 {
  version: 1;
  measure: string;
  timeField: string;
  grain: 'day' | 'week' | 'month' | 'quarter' | 'year';
  anchor: string;
  comparison: 'previous_period' | 'previous_year';
  dimensions: string[];
  timezone?: string;
  /** What the reader is looking at: drills and the clicked mark, as filters on approved fields. */
  filters?: Array<{ field: string; op: 'eq' | 'neq' | 'in' | 'not_in'; values: Array<string | number | boolean> }>;
}

/** Mirrors dql-agent DriverAnalysisV1; numbers are exact decimals as text. */
export interface DashboardDriverAnalysisV1 {
  version: 1;
  measure: { field: string; label: string; additivity: 'additive' | 'ratio' | 'non_additive' };
  grain: string;
  periods: { current: { start: string; end: string }; prior: { start: string; end: string } };
  headline: { current?: string; prior?: string; delta?: string; percentDelta?: string };
  dimensions: Array<{
    field: string;
    label: string;
    members: Array<{ label: string; value?: string | number | boolean; current?: string; prior?: string; delta?: string; share?: string; role: 'driver' | 'offset' | 'flat'; status: 'both' | 'new' | 'gone'; other?: boolean }>;
    memberCount: number;
    reconciles: boolean;
    residual?: string;
    concentration: number;
  }>;
  unavailable: Array<{ field: string; reason: string; detail?: string }>;
  missingPeriod?: 'current' | 'prior';
  summary: string;
}

export interface DashboardRunOptions {
  runScope?: string;
  /**
   * This viewer's request number, increasing per mounted viewer. The server
   * uses it so a request that arrives late never cancels a newer one.
   */
  runSequence?: number;
  /** Bypass the optional local Dataset delivery cache for a fresh live run. */
  refresh?: boolean;
  /** A preview/publish candidate must execute every authored tile. */
  fullRun?: boolean;
  tileId?: string;
  visibleTileIds?: string[];
  affectedTileIds?: string[];
  /**
   * Ephemeral, server-validated Dataset hierarchy exploration. The saved page
   * query is never replaced by these steps; a full preview/publication receipt
   * cannot be created from an interaction run.
   */
  datasetDrills?: DashboardDatasetHierarchyDrill[];
  /** "Why did it move?" for one Dataset tile; runs bounded and changes nothing (RFC 0008 step 7). */
  driverProbe?: { fromTileId: string; driver: DashboardDriverDefinitionV1 };
  /** A drill view of one Dataset tile by any approved field, or its rows; runs bounded and changes nothing (RFC 0009 step 6a). */
  exploreProbe?: { fromTileId: string; query: TileQuery };
  /**
   * A viewer's own "Filter by…" choices: session-only, never saved to the
   * page. The server re-proves each named tile can take the column.
   */
  viewerFilters?: DashboardViewerFilter[];
}

/** One "Filter by…" choice: a result column, its value(s), and the tiles it was shown to narrow. */
export interface DashboardViewerFilter {
  column: string;
  values: string[];
  tileIds: string[];
}

/**
 * A browser carries only a value selected from a settled result and a declared
 * hierarchy transition. The server reloads the authored TileQuery and current
 * Dataset descriptor before applying every step.
 */
export interface DashboardDatasetHierarchyDrill {
  tileId: string;
  steps: Array<{
    hierarchyId: string;
    fromField: string;
    values: unknown[];
  }>;
}

export interface DashboardStoryFact {
  id: string;
  tileId: string;
  kind: 'value' | 'rank' | 'share' | 'delta' | 'trend' | 'driver' | 'scope' | 'freshness';
  label: string;
  value: string | number | boolean | null;
  evidenceRef: string;
  trustState: 'certified' | 'review_required' | 'draft_ready';
}

export interface DashboardStoryBrief {
  headline: string;
  paragraphs: string[];
  implication?: string;
  caveat?: string;
  claims: Array<{ text: string; factIds: string[]; kind: string }>;
  evidenceRefs: string[];
  trustState: 'certified' | 'review_required' | 'draft_ready';
  generatedBy: 'deterministic' | 'ai';
}

export interface AppBlockRecommendation {
  id: string;
  name: string;
  domain: string;
  status: string;
  owner: string | null;
  /** The owner as a person reads it, when it is this machine's person (their display name). */
  ownerName?: string;
  tags: string[];
  path: string;
  fingerprint: string;
  lastModified: string;
  description: string;
  llmContext?: string | null;
  chartType?: string;
  filterIds?: string[];
  /** Governed result dimensions that may be linked to App dashboard filters. */
  dimensionIds?: string[];
  score: number;
  reasons: string[];
  /** Canonical AppSourceCatalog identity. Legacy recommend-blocks rows omit it. */
  sourceId?: string;
  /** Catalog source kind: a DQL block or a semantic model. Legacy rows omit it. */
  kind?: 'block' | 'semantic';
  /** Project-relative source file. Legacy rows omit it. */
  sourcePath?: string;
  qualifiedIdentity?: string;
  sourceRevision?: string;
  snapshotId?: string;
  lifecycle?: 'certified' | 'review' | 'draft' | 'pending_recertification' | 'deprecated' | 'unknown';
  trust?: 'certified' | 'review_required';
  capabilities?: {
    measures: string[];
    dimensions: string[];
    outputs: string[];
    filters: string[];
    grain?: string;
    chartType?: string;
    allowedVisualizations?: string[];
    dataset?: DatasetDescriptor;
    metricCapabilities?: Record<string, MetricCapabilityContract>;
    semanticModelId?: string;
    parameters: Array<{ name: string; type?: string; required: boolean; hasDefault: boolean }>;
  };
  eligibility?: {
    discoverable: boolean;
    localPreview: boolean;
    projectPublish: boolean;
    reasonCodes: string[];
  };
  /** Who certified it and when, for a certified block (D5). */
  certification?: CertificationByline;
}

export interface AppSourceCandidatePage {
  version: 1;
  snapshotId: string;
  /** Server-owned App feature availability for this local project. */
  features?: {
    datasets: boolean;
  };
  items: AppBlockRecommendation[];
  nextCursor?: string;
  total: number;
  pageSize: number;
  facets: {
    lifecycles: Record<string, number>;
    domains: Record<string, number>;
    kinds: Record<string, number>;
  };
}

interface AppSourceCandidateWire {
  sourceId: string;
  qualifiedIdentity: string;
  sourceRevision: string;
  snapshotId: string;
  kind: 'block' | 'semantic';
  lifecycle: NonNullable<AppBlockRecommendation['lifecycle']>;
  trust: NonNullable<AppBlockRecommendation['trust']>;
  executable: boolean;
  name: string;
  title: string;
  description?: string;
  domain?: string;
  owner?: string;
  sourcePath: string;
  executionRef: string;
  tags: string[];
  capabilities: NonNullable<AppBlockRecommendation['capabilities']>;
  eligibility: NonNullable<AppBlockRecommendation['eligibility']>;
  score?: number;
  reasons: string[];
  certification?: CertificationByline;
}

export interface CreateAppRequest {
  name: string;
  domain: string;
  ownerDomain?: string;
  usesDomains?: string[];
  requiredExports?: string[];
  classification?: string;
  dashboardTitle?: string;
  subdomain?: string;
  groups?: string[];
  purpose?: string;
  audience?: string;
  visibility?: 'shared' | 'private' | 'template';
  lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
  tags: string[];
  owners: string[];
  selectedBlockIds: string[];
}

export interface CreateAppResponse {
  ok: true;
  app: AppSummary;
  paths: string[];
  dashboardId: string;
}

export interface GenerateAppRequest {
  /** Durable client-generated identity used to resume a background proposal. */
  sessionId?: string;
  prompt: string;
  domain?: string;
  owner?: string;
  force?: boolean;
  selectedBlockIds?: string[];
  plannerMode?: 'deterministic' | 'ai_assisted';
  mode?: 'personal' | 'stakeholder';
  exploreGaps?: boolean;
  maxGeneratedTiles?: number;
  /** Add exactly one reviewed page to this App instead of creating a new App. */
  existingAppId?: string;
}

export interface GeneratedAppPlan {
  version: 2;
  mode: 'personal' | 'stakeholder';
  publicationIntent: 'personal' | 'shared_project';
  snapshotId?: string;
  requirements: Array<{ id: string; question: string; role: string; measures: string[]; dimensions: string[]; filters: string[] }>;
  requirementCoverage: Array<{ requirementId: string; status: 'covered' | 'gap'; source: 'certified_block' | 'semantic_query' | 'gap'; tileId?: string; sourceId?: string; trustState: string; reasons: string[] }>;
  storyEvidencePlan: NonNullable<DashboardDocumentResponse['dashboard']['story']>;
  appId: string;
  name: string;
  prompt: string;
  planning?: {
    plannerMode: 'deterministic' | 'ai_assisted';
    normalizedGoal: string;
    analysisIntent: string;
    audience: string;
    domain: string;
    certifiedContext: Array<{ nodeId: string; name: string; kind: string; reason: string }>;
    missingEvidence: string[];
    scopedReports?: GeneratedAppScopedReport[];
    displayStrategy: string;
    layoutRationale: string;
    handoffPlan: string[];
  };
  skills: Array<{ id: string; title: string; description: string }>;
  domain: string;
  audience: string;
  businessGoal: string;
  stakeholderSummary?: string;
  owner: string;
  lifecycle: 'draft' | 'review';
  tags: string[];
  appSections?: Array<{ id: string; title: string; purpose: string; reviewStatus: 'certified' | 'draft_ready' | 'review_required' }>;
  globalFilters?: Array<{ id: string; label: string; type: string; default?: unknown; bindsTo?: string }>;
  selectedEvidence?: Array<{ source: string; reason: string; kind?: string; nodeId?: string; trustState: string }>;
  missingEvidence?: string[];
  scopedReports?: GeneratedAppScopedReport[];
  /** Plan-preview coverage: how much of the app is certified vs. left as gaps. */
  coverage?: { certifiedTiles: number; gaps: number; ratio: number };
  pages: Array<{
    id: string;
    title: string;
    description?: string;
    filters: Array<{ id: string; label: string; type: string; default?: unknown; bindsTo?: string }>;
    tiles: Array<{
      id: string;
      title: string;
      kind: 'certified_block' | 'semantic_query' | 'draft_placeholder' | 'narrative';
      description?: string;
      blockId?: string;
      semantic?: DashboardDocumentResponse['dashboard']['layout']['items'][number]['semantic'];
      sourceNodeId?: string;
      viz: string;
      certification: 'certified' | 'uncertified';
      reviewStatus: 'certified' | 'draft_ready' | 'review_required';
      trustState?: 'certified' | 'draft_ready' | 'review_required';
      filterBindings?: DashboardTileFilterBinding[];
      parameterBindings?: DashboardTileParameterBinding[];
      sourceEvidence?: DashboardTileSourceEvidence[];
      rationale?: string;
      caveats?: string[];
      reviewTasks?: string[];
      display?: {
        role: string;
        recommendedDisplayType: string;
        layoutPriority: number;
        expectedGrain?: string;
        trustState: string;
        followUpActions: string[];
        rationale: string;
        genUi?: {
          version: 1;
          component: string;
          role: string;
          layoutIntent: string;
          defaultVisualization: string;
          allowedVisualizations: string[];
          fieldHints?: Record<string, string>;
          insightTitle: string;
          trustState: string;
          reviewStatus: string;
          sourceNodeId?: string;
          followUpActions: string[];
          rationale: string;
        };
      };
    }>;
  }>;
  caveats: string[];
  reviewTasks: string[];
}

export interface GeneratedAppScopedReport {
  id: string;
  title: string;
  question: string;
  description: string;
  intent: string;
  reviewStatus: 'draft_ready' | 'review_required';
  source: string;
  evidenceNeeded: string[];
  suggestedActions: string[];
}

export interface GenerateAppResponse {
  ok: true;
  plan: GeneratedAppPlan;
  validation: {
    ok: boolean;
    issues: Array<{ level: 'error' | 'warning'; path: string; message: string }>;
    certifiedTiles: number;
    draftTiles: number;
  };
  generated: { paths: string[] };
  app: AppSummary | null;
  dashboardId: string | null;
}

/** One confirmable entry in the pre-create app proposal list. */
export interface AppBuildProposalTile {
  id: string;
  source: 'certified_block' | 'semantic_query' | 'ai_generated';
  title: string;
  description?: string;
  blockId?: string;
  question?: string;
  sql?: string;
  answer?: string;
  semantic?: DashboardDocumentResponse['dashboard']['layout']['items'][number]['semantic'];
  viz: string;
  allowedVisualizations?: string[];
  certification: 'certified' | 'reviewed_semantic' | 'ai_generated';
  sourceClass: 'certified_block' | 'governed_semantic' | 'exploratory_analysis';
  reviewStatus: 'not_required' | 'required' | 'approved';
  requirementIds?: string[];
  sourceEvidence?: DashboardTileSourceEvidence[];
  preflight: {
    status: 'passed' | 'review_required' | 'blocked';
    snapshotId?: string;
    sourceFingerprint?: string;
    receiptId?: string;
    message: string;
  };
  preview?: { columns: string[]; rows: Array<Record<string, unknown>>; rowCount?: number };
  repair?: AppExecutionRepairTrace;
  error?: string;
  selectedByDefault: boolean;
  followUps?: string[];
}

export interface AppBuildProposalGap {
  id: string;
  question: string;
  reason: string;
}

export interface AppBuildFrame {
  goal: string;
  audience: string;
  metrics: string[];
  dimensions: string[];
  grain?: string;
  timeRange?: string;
  comparison?: string;
  filters: string[];
  desiredOutput: string;
}

export interface AppBuildClarification {
  id: string;
  question: string;
  choices: string[];
  required: boolean;
}

export interface AppBuildProposal {
  intent: { target: 'personal' | 'shared_project'; initialVisibility: 'private' };
  buildFrame: AppBuildFrame;
  tiles: AppBuildProposalTile[];
  gaps: AppBuildProposalGap[];
  clarifications: AppBuildClarification[];
  followUps: string[];
  coverage: { certifiedTiles: number; semanticTiles: number; generatedTiles: number; gaps: number };
}

export interface AppStudioBuildDraft {
  version: 3;
  id: string;
  appId: string;
  name: string;
  baseApp?: { appId: string; fingerprint: string };
  revision: number;
  proposalHash: string;
  authoringMode: 'ai' | 'manual';
  template: 'executive_brief' | 'operational_dashboard' | 'investigation' | 'blank';
  sourcePolicy: 'governed_only' | 'include_review_required';
  state: 'local_draft' | 'clarification_required' | 'preflight_ready' | 'project_published';
  frame: Omit<AppBuildFrame, 'clarificationQuestions'> & {
    decision?: string;
    clarificationQuestions?: Array<{
      id: string;
      question: string;
      choices: Array<{ id: string; label: string; description?: string }>;
      required: boolean;
      answerId?: string;
    }>;
  };
  requirements: Array<{
    id: string;
    question: string;
    role: 'kpi' | 'trend' | 'breakdown' | 'detail' | 'narrative' | 'evidence';
    required: boolean;
    measures: string[];
    dimensions: string[];
    filters: string[];
    grain?: string;
  }>;
  coverage: Array<{
    requirementId: string;
    status: 'covered' | 'partial' | 'gap';
    sourceIds: string[];
    componentIds: string[];
    reasons: string[];
  }>;
  sources: Array<{
    id: string;
    kind: 'block' | 'certified_block' | 'governed_semantic' | 'review_block' | 'review_dql' | 'text' | 'semantic_query' | 'exploratory_sql';
    sourceRef: string;
    qualifiedIdentity?: string;
    sourcePath?: string;
    executionRef?: string;
    snapshotId?: string;
    sourceRevision?: string;
    sourceFingerprint?: string;
    receiptId?: string;
    lifecycle?: 'certified' | 'review' | 'draft' | 'pending_recertification' | 'deprecated' | 'unknown';
    capabilities?: NonNullable<AppBlockRecommendation['capabilities']>;
    trustState: 'certified' | 'review_required' | 'draft_ready';
    reviewStatus: 'not_required' | 'required' | 'approved';
  }>;
  pages: DashboardDocumentResponse['dashboard'][];
  reviewTasks: Array<{ id: string; message: string; status: 'open' | 'resolved'; sourceId?: string; pageId?: string; tileId?: string }>;
  previewReceipts?: Array<{ id: string; pageId: string; revision: number; snapshotId: string; filterFingerprint: string; resultFingerprint: string; createdAt: string }>;
  previewReceipt?: { id: string; pageId: string; revision: number; snapshotId: string; filterFingerprint: string; resultFingerprint: string; createdAt: string };
  preflightReceipt?: { id: string; revision: number; proposalHash: string; sourceFingerprint: string; createdAt: string };
  publishedFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export type AppStudioDraftOperation =
  | { type: 'set_name'; name: string }
  | { type: 'set_template'; template: AppStudioBuildDraft['template'] }
  | { type: 'set_frame'; frame: AppStudioBuildDraft['frame'] }
  | { type: 'set_source_policy'; sourcePolicy: AppStudioBuildDraft['sourcePolicy'] }
  | { type: 'set_requirements'; requirements: AppStudioBuildDraft['requirements']; coverage?: AppStudioBuildDraft['coverage'] }
  | { type: 'set_coverage'; coverage: AppStudioBuildDraft['coverage'] }
  | { type: 'upsert_source'; source: AppStudioBuildDraft['sources'][number] }
  | { type: 'remove_source'; sourceId: string }
  | { type: 'upsert_page'; page: AppStudioBuildDraft['pages'][number] }
  | { type: 'remove_page'; pageId: string }
  | { type: 'add_tile'; pageId: string; tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number] }
  | { type: 'update_tile'; pageId: string; tileId: string; patch: Partial<AppStudioBuildDraft['pages'][number]['layout']['items'][number]> }
  | { type: 'remove_tile'; pageId: string; tileId: string }
  | { type: 'set_filter'; pageId: string; filter: NonNullable<AppStudioBuildDraft['pages'][number]['filters']>[number] }
  | { type: 'remove_filter'; pageId: string; filterId: string }
  | { type: 'set_interactions'; pageId: string; interactions?: AppStudioBuildDraft['pages'][number]['interactions'] }
  | { type: 'set_layout'; pageId: string; layout: AppStudioBuildDraft['pages'][number]['layout'] }
  | { type: 'set_narrative'; pageId: string; narrative: DashboardNarrativeV1 | null }
  | { type: 'set_canvas'; pageId: string; canvas: DashboardCanvasV1 | null }
  | { type: 'set_review_task'; task: AppStudioBuildDraft['reviewTasks'][number] }
  | { type: 'remove_review_task'; taskId: string }
  | { type: 'set_preview_receipt'; receipt: NonNullable<AppStudioBuildDraft['previewReceipt']> };

export interface AppStudioAiProposal {
  id: string;
  draftId: string;
  baseRevision: number;
  baseProposalHash: string;
  /**
   * Server-owned provenance for the dedicated initial App generator. It is
   * absent only on proposals persisted before this local schema was added.
   */
  plannerProvenance?: {
    version: 1;
    mode: 'ai' | 'deterministic';
    providerInvocation: 'succeeded' | 'not_attempted';
    providerId?: string;
  };
  operations: AppStudioDraftOperation[];
  /** `add` keeps the page's tiles; absent on proposals stored before it existed. */
  mode?: 'add' | 'replace';
  targetPageId?: string;
  prompt?: string;
  /** Tiles this proposal adds; the author can decline any of them. */
  proposedTileIds?: string[];
  defaultSelectedSourceIds?: string[];
  candidateSourceIds?: string[];
  warnings?: string[];
  clarifications: NonNullable<AppStudioBuildDraft['frame']['clarificationQuestions']>;
  summary: {
    requirements: number;
    covered: number;
    gaps: number;
    certifiedSources: number;
    semanticSources: number;
  };
}

/**
 * A server-issued, immutable App Autopilot change carried by a universal
 * AgentRun artifact. The browser may only present it and invoke the guarded
 * artifact Apply endpoint; it never supplies operations, SQL, source
 * revisions, or Dataset capabilities.
 */
export interface AppAutopilotChangeProposal {
  version: 1;
  id: string;
  runId: string;
  artifactId: string;
  draftId: string;
  baseRevision: number;
  baseProposalHash: string;
  pageId: string;
  tileId: string;
  request: string;
  intent: {
    action:
      | 'group_tile'
      | 'change_visualization'
      | 'rename_tile'
      | 'add_tile'
      | 'remove_tile'
      | 'add_page'
      | 'remove_page'
      | 'add_filter'
      | 'remove_filter'
      | 'map_filter'
      | 'add_cross_filter'
      | 'add_navigation'
      | 'add_detail_drill'
      | 'arrange_layout';
    request: string;
    summary?: string;
    field?: string;
    measure?: string;
    visualization?: AppStudioBuildDraft['pages'][number]['layout']['items'][number]['viz']['type'];
    title?: string;
    targetField?: string;
    targetPageId?: string;
    targetTileId?: string;
    filterId?: string;
    scope?: 'page' | 'app';
  };
  source: {
    sourceId: string;
    sourceRevision: string;
    contractFingerprint: string;
  };
  planningMode: 'universal_agent';
  operations: AppStudioDraftOperation[];
  diagnostics: Array<{ code: string; severity: 'info' | 'blocking'; message: string }>;
  createdAt: string;
  proposalHash: string;
  appliedAt?: string;
  appliedRevision?: number;
}

export interface AppAiBuildSession {
  id: string;
  /** 'proposed' = plan + proposal saved, no app files yet (awaiting confirm). */
  status: 'building' | 'proposed' | 'ready' | 'error';
  createdAt: string;
  updatedAt: string;
  prompt: string;
  appId?: string;
  dashboardId?: string | null;
  generatedPaths: string[];
  plan?: GeneratedAppPlan;
  validation?: GenerateAppResponse['validation'];
  proposal?: AppBuildProposal;
  snapshotId?: string;
  existingAppFingerprint?: string;
  proposalHash?: string;
  committedTileIds?: string[];
  committedBrief?: {
    appName?: string;
    pageTitle?: string;
    audience: string;
    filterIds: string[];
    tileOverrides: Record<string, { title?: string; viz?: string }>;
  };
  warnings: string[];
  reviewTasks: string[];
  inputs: {
    domain?: string;
    owner?: string;
    audience?: string;
    notebookPath?: string;
    existingAppId?: string;
    mode?: 'personal' | 'stakeholder';
    exploreGaps?: boolean;
    selectedBlockIds: string[];
  };
  error?: string;
}

export type AppAskResponse =
  | {
      ok: true;
      route: 'certified_answer' | 'dataset_chart_answer' | 'generated_answer' | 'investigation' | 'app_change_proposal' | 'metadata_answer';
      answer: string;
      /** The chart lane discloses when its exact-result summary did not use an AI provider. */
      answerMode?: 'provider' | 'deterministic_context_summary' | 'out_of_context';
      trustState: DashboardDisplayMetadata['trustState'];
      reviewStatus: DashboardDisplayMetadata['reviewStatus'];
      citations: Array<{ kind: string; name: string; path?: string }>;
      followUps: string[];
      decision: {
        mode: 'answer' | 'analysis' | 'app_change' | 'metadata';
        reason: string;
        nextAction: string;
        requiresContext: boolean;
        usesCertifiedResult: boolean;
        confidence: number;
      };
      investigation?: LocalAppInvestigation;
      proposal?: unknown;
      /** Server-owned, exact current Dataset chart context. */
      analyticalContext?: {
        version: 1;
        appId: string;
        dashboardId: string;
        tileId: string;
        runId: string;
        evidenceScope: 'full_dashboard' | 'interaction' | 'incomplete';
        snapshotId: string;
        dashboardFingerprint: string;
        source: {
          sourceId: string;
          sourceRevision: string;
          contractFingerprint: string;
          lifecycle: string;
          trust: string;
          targetFingerprint?: string;
          label?: string;
          path?: string;
        };
        authoredQueryFingerprint: string;
        interactionQueryFingerprint?: string;
        executionQueryFingerprint: string;
        filterFingerprint: string;
        parameterFingerprint: string;
        interactionFingerprint: string;
        executionFingerprint: string;
        resultFingerprint: string;
        schemaFingerprint: string;
        personaPolicyFingerprint: string;
      };
      /** Grounded ReAct research plan (P4): the decision, steps, and follow-up options. */
      researchPlan?: {
        decision: 'answer' | 'clarify' | 'investigate' | 'compose_app';
        confidence: number;
        rationale: string;
        steps: Array<{ thought: string; action: { kind: string; target: string }; expectation: string }>;
        followUp?: { question: string; options: string[] };
        sources: string[];
        done: boolean;
      };
    }
  | { ok: false; error: string };

export interface AppEditorCatalogResponse {
  appId: string;
  defaultDomain: string;
  domains: string[];
  blocks: AppBlockRecommendation[];
}

export interface LocalAiPin {
  id: string;
  appId: string;
  dashboardId: string;
  tileId?: string;
  title: string;
  answer: string;
  question?: string;
  sql?: string;
  sourceTier?: string;
  certification: 'certified' | 'ai_generated';
  reviewStatus: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
  refreshCadence: 'none' | 'daily';
  chartConfig?: Record<string, unknown>;
  result?: QueryResult;
  citations?: unknown[];
  analysisPlan?: unknown;
  evidence?: unknown;
  followUps?: string[];
  createdAt: string;
  updatedAt: string;
  lastRefreshedAt?: string;
  lastRefreshError?: string;
  promotedBlockPath?: string;
}

export interface LocalAppInvestigation {
  id: string;
  appId: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  title: string;
  question: string;
  intent: 'diagnose_change' | 'driver_breakdown' | 'segment_compare' | 'entity_drilldown' | 'anomaly_investigation' | 'trust_gap_review';
  context?: unknown;
  status: 'draft' | 'running' | 'ready' | 'error';
  summary?: string;
  recommendation?: string;
  metrics?: unknown;
  driverCards?: unknown[];
  resultPreviews?: unknown[];
  evidence?: unknown;
  reportSections?: Array<{
    id: string;
    kind: 'executive_answer' | 'business_interpretation' | 'key_numbers' | 'recommended_next_step' | 'review_boundary' | 'validation' | 'reusable_logic' | 'custom';
    title: string;
    body: string;
    tone?: 'answer' | 'insight' | 'warning' | 'review' | 'neutral';
    bullets?: string[];
    evidenceRefs?: string[];
  }>;
  generatedSql?: string;
  reviewStatus: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
  error?: string;
  pinnedAiPinId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface AppNotebookCandidate {
  path: string;
  title: string;
  attached: boolean;
  role?: 'source' | 'analysis' | 'supporting';
  visibility?: 'shared' | 'private' | 'template';
  lastModified?: string;
}

export interface AppNotebookPreviewCell {
  id: string;
  type: string;
  name?: string;
  content: string;
  upstream?: string;
  chartConfig?: Record<string, unknown>;
  tableConfig?: Record<string, unknown>;
  singleValueConfig?: Record<string, unknown>;
  pivotConfig?: Record<string, unknown>;
  status?: string;
  result?: QueryResult;
  error?: string;
  executionCount?: number;
  executedAt?: string;
}

export interface AppNotebookPreview {
  path: string;
  title: string;
  metadata?: Record<string, unknown>;
  cells: AppNotebookPreviewCell[];
  snapshotFound?: boolean;
  capturedAt?: string;
}

export interface AppConversationMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  events?: unknown[];
  createdAt?: string;
}

export interface AppConversation {
  id: string;
  appId: string;
  dashboardId?: string;
  notebookPath?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage?: string;
  context?: AgentConversationContext;
  messages?: AppConversationMessage[];
}

export interface SettingsEnvVar {
  key: string;
  label: string;
  present: boolean;
  optional: boolean;
  description: string;
}

export interface SettingsEnvGroup {
  id: string;
  title: string;
  description: string;
  vars: SettingsEnvVar[];
}

export type ProviderSettingsId = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom-openai' | 'claude-code' | 'codex';
export type ProviderAuthMode = 'api_key' | 'local' | 'subscription_cli';

/** Reasoning-effort ceiling. `'auto'` = agent picks per task up to high; a level caps it. */
export type ReasoningEffortSetting = 'auto' | 'low' | 'medium' | 'high';

export interface ProviderSettings {
  id: ProviderSettingsId;
  label: string;
  enabled: boolean;
  active: boolean;
  hasApiKey: boolean;
  /** Required non-secret configuration is present; reachability still requires an explicit test. */
  configured: boolean;
  apiKeyPreview?: string;
  baseUrl?: string;
  model?: string;
  source: 'local' | 'env' | 'none';
  envVars: string[];
  /** How the provider authenticates (drives the settings card). */
  authMode?: ProviderAuthMode;
  /** For subscription_cli providers: the CLI binary to install + log into. */
  command?: string;
  /** Reasoning-effort ceiling (`'auto'` when unset). */
  reasoningEffort?: ReasoningEffortSetting;
  /** Whether the configured model exposes a reasoning surface (drives showing the control). */
  supportsReasoningEffort?: boolean;
}

/** Subscription providers that support browser OAuth sign-in. */
export type OAuthProviderId = 'claude' | 'codex';

/** Connection state for a subscription OAuth provider (Claude Pro/Max, ChatGPT Plus/Pro). */
export interface OAuthStatus {
  provider: OAuthProviderId;
  connected: boolean;
  email: string | null;
  models: string[];
  defaultModel: string;
  pending: boolean;
}

/** Live detection for a subscription-CLI provider. */
export interface ProviderCliStatus {
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
  detail?: string;
}

export interface RemoteMcpEntry {
  kind: 'server' | 'connector';
  name: string;
  url?: string;
  connectorId?: string;
  description?: string;
  authorizationTokenEnv?: string;
  authorizationToken?: string;
  allowedTools?: string[];
  enabled: boolean;
  trusted: boolean;
  deferLoading?: boolean;
  providers?: Array<'openai' | 'anthropic'>;
  hasAuthorizationToken?: boolean;
  authorizationTokenPreview?: string;
}

export interface RemoteMcpSettings {
  path: string;
  entries: RemoteMcpEntry[];
  warnings: string[];
}

export interface AgentMemory {
  id: string;
  scope: 'thread' | 'notebook' | 'project' | 'user' | 'artifact';
  scopeId?: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  importance: number;
  validFrom?: string;
  validTo?: string;
  supersedes?: string;
  lastUsed?: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
}

const BASE = typeof window === 'undefined' ? '' : window.location.origin;

export type LocalOperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface LocalOperation<TResult = unknown> {
  id: string;
  type: string;
  scope: string;
  resourceRevision?: string;
  status: LocalOperationStatus;
  phase: string;
  progress: number;
  message: string;
  cancellable: boolean;
  result?: TResult;
  error?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface BlockCertificationOperationResult {
  /** `certified_unchanged_with_blockers`: a re-check of an unchanged certified block failed; nothing was written and it is still certified. */
  outcome: 'certified' | 'draft_saved_with_blockers' | 'certified_unchanged_with_blockers';
  oldPath: string;
  draftPath: string;
  newPath?: string;
  blockers?: string[];
  checklist?: {
    metadata: boolean;
    validation: boolean;
    run: boolean;
    tests: boolean;
    chart: boolean;
    lineage: boolean;
    aiReviewed: boolean;
    blockers: string[];
    issues?: BlockStudioDiagnostic[];
    checkedAt?: string;
  };
  block: BlockStudioOpenPayload;
  runSummary?: BlockStudioRunSummary;
  indexRefresh?: { status: 'queued'; operationId: string };
}

export interface BlockStudioCertificationAssessment {
  ok: boolean;
  validation?: BlockStudioValidation;
  certification: {
    certified: boolean;
    errors: Array<{ rule: string; message: string }>;
    warnings: Array<{ rule: string; message: string }>;
  };
  checklist: {
    metadata: boolean;
    validation: boolean;
    run: boolean;
    tests: boolean;
    chart: boolean;
    lineage: boolean;
    aiReviewed: boolean;
    blockers: string[];
    issues?: BlockStudioDiagnostic[];
    checkedAt?: string;
  };
  blockers: string[];
}

export class DqlApiError extends Error {
  readonly status: number;
  readonly code?: DbtOnboardingErrorCode | string;
  readonly recoverable?: boolean;
  readonly details?: unknown;
  readonly nextActions?: string[];
  readonly requestId?: string;
  readonly snapshotId?: string;
  /** The run an idempotency conflict or unknown-outcome response refers to. */
  readonly runId?: string;
  /** HH-12: where a host sends someone it refused, e.g. to ask for access (a same-origin path). */
  readonly next?: { label: string; href: string };

  constructor(input: {
    message: string;
    status: number;
    code?: DbtOnboardingErrorCode | string;
    recoverable?: boolean;
    details?: unknown;
    nextActions?: string[];
    requestId?: string;
    snapshotId?: string;
    runId?: string;
    next?: { label: string; href: string };
  }) {
    super(input.message);
    this.name = 'DqlApiError';
    this.status = input.status;
    this.code = input.code;
    this.recoverable = input.recoverable;
    this.details = input.details;
    this.runId = input.runId;
    this.nextActions = input.nextActions;
    this.requestId = input.requestId;
    this.snapshotId = input.snapshotId;
    if (input.next) this.next = input.next;
  }
}

function formatRequestError(res: Response, text: string): DqlApiError {
  const fallback = text.trim() || res.statusText || `HTTP ${res.status}`;
  if (!text.trim()) return new DqlApiError({ message: fallback, status: res.status });
  try {
    const payload = JSON.parse(text);
    const validationErrors = Array.isArray(payload?.errors)
      ? payload.errors.filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    const message = typeof payload?.friendlyMessage === 'string' && payload.friendlyMessage.trim()
      ? payload.friendlyMessage
      : typeof payload?.message === 'string' && payload.message.trim()
        ? payload.message
        : typeof payload?.error === 'string' && payload.error.trim()
        ? payload.error
        : validationErrors.length > 0
          ? `${validationErrors.slice(0, 3).join(' ')}${validationErrors.length > 3 ? ` ${validationErrors.length - 3} more blockers.` : ''}`
          : fallback;
    return new DqlApiError({
      message,
      status: res.status,
      code: typeof payload?.code === 'string' ? payload.code : undefined,
      recoverable: typeof payload?.recoverable === 'boolean' ? payload.recoverable : undefined,
      details: payload?.details
        ?? (typeof payload?.error === 'string' && payload.error.trim() && payload.error !== message
          ? { technicalDetails: payload.error }
          : validationErrors.length > 0
            ? { errors: validationErrors, draft: payload?.draft }
            : undefined),
      nextActions: Array.isArray(payload?.nextActions)
        ? payload.nextActions.filter((item: unknown): item is string => typeof item === 'string')
        : undefined,
      requestId: typeof payload?.requestId === 'string' ? payload.requestId : undefined,
      snapshotId: typeof payload?.snapshotId === 'string' ? payload.snapshotId : undefined,
      ...(typeof payload?.runId === 'string' && payload.runId ? { runId: payload.runId } : {}),
      ...(typeof payload?.next?.label === 'string' && typeof payload?.next?.href === 'string' && payload.next.href.startsWith('/') && !payload.next.href.startsWith('//')
        ? { next: { label: payload.next.label, href: payload.next.href } }
        : {}),
    });
  } catch {
    return new DqlApiError({ message: fallback, status: res.status });
  }
}

/**
 * Collapse CONCURRENT identical GETs into one network round trip.
 *
 * Several independent panels fetch the same status on mount — the workbench
 * loaded `/api/onboarding/status` and `/api/block-studio/dbt-status` twice each
 * on every boot, and more as panels open. Each owns its own effect, so the
 * duplication is structural rather than a bug in any one of them.
 *
 * Deliberately in-flight only, with no TTL: a later call still hits the network,
 * so nothing can read stale data. This only merges requests that overlap in
 * time, which is exactly the mount storm.
 */
const inFlightGets = new Map<string, Promise<unknown>>();

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase();
  // Only idempotent, unaborted, bodyless reads are safe to share.
  const shareable = method === 'GET' && !options?.signal && !options?.body;
  if (shareable) {
    const pending = inFlightGets.get(path);
    if (pending) return pending as Promise<T>;
    const started = requestUncached<T>(path, options).finally(() => {
      inFlightGets.delete(path);
    });
    inFlightGets.set(path, started);
    return started;
  }
  return requestUncached<T>(path, options);
}

async function requestUncached<T>(path: string, options?: RequestInit): Promise<T> {
  let res: Response;
  try {
    const headers = withServerAuthorization(options?.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
    });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
    throw new Error(`Unable to reach the local ZLens notebook server. Check that it is still running, then retry.${detail}`);
  }
  if (!res.ok) {
    reportServerAuthRejected(res.status, res.headers.get('x-dql-sign-in'));
    const text = await res.text().catch(() => '');
    const failure = formatRequestError(res, text);
    // A refused change shows the host's sentence and its next step, never a blank error.
    reportHostRefusal(res.status, options?.method ?? 'GET', {
      message: failure.message || 'The host did not allow this change.',
      ...(failure instanceof DqlApiError && failure.next ? { next: failure.next } : {}),
    });
    throw failure;
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function streamAgentRunResponse(
  res: Response,
  onMessage: (message: AgentRunStreamMessage) => void,
): Promise<AgentRun> {
  if (!res.body) throw new Error('Agent run stream is not available in this browser.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: AgentRun | undefined;

  const consumeBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const payload = JSON.parse(dataLines.join('\n'));
    if (eventName === 'agent-run-accepted') {
      // A browser has no authority to select a run identity.  The accepted
      // SSE frame is the first safe point at which the UI may persist, reload,
      // or cancel a background run.
      const runId = typeof payload?.runId === 'string' ? payload.runId : undefined;
      const operationId = typeof payload?.operationId === 'string' ? payload.operationId : undefined;
      // `replayed` means this submission identity was already claimed: the
      // stream is attached to the run that claim started, not a second run.
      const replayed = payload?.replayed === true;
      if (runId) onMessage({ kind: 'accepted', runId, ...(operationId ? { operationId } : {}), ...(replayed ? { replayed } : {}) });
    } else if (eventName === 'agent-run-event') {
      onMessage({ kind: 'event', event: payload as AgentRunEvent });
    } else if (eventName === 'agent-run-answer-delta') {
      const delta = typeof payload?.delta === 'string' ? payload.delta : '';
      if (delta) onMessage({ kind: 'answer-delta', delta });
    } else if (eventName === 'agent-run-complete') {
      completed = payload as AgentRun;
      onMessage({ kind: 'complete', run: completed });
    } else if (eventName === 'agent-run-error') {
      throw new Error(typeof payload?.error === 'string' ? payload.error : 'Agent run failed.');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let separator = buffer.search(/\r?\n\r?\n/);
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(buffer[separator] === '\r' ? separator + 4 : separator + 2);
        consumeBlock(block);
        separator = buffer.search(/\r?\n\r?\n/);
      }
    }
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  if (!completed) throw new Error('Agent run stream ended before completion.');
  return completed;
}

/**
 * `runId` used to be a browser-generated correlation field.  It now scopes
 * server capabilities and is intentionally server-owned, so retain no
 * compatibility path that can place an arbitrary value on the public wire.
 * The runtime also rejects it at ingress; this client-side omission protects
 * callers that construct an untyped payload.
 */
function serializeCreateAgentRunInput(input: CreateAgentRunInput): string {
  const { runId: _discardedRunId, requestId: _discardedRequestId, ...safeInput } = input as CreateAgentRunInput & { runId?: unknown; requestId?: unknown };
  return JSON.stringify(safeInput);
}

/** A fresh submission identity: a UUID when the platform has one, else time plus entropy. */
export function mintAgentRunSubmissionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * One identity per submission, sent as `Idempotency-Key`. The caller mints it
 * once per explicit submit (so a retry of THAT submit attaches to the run it
 * started); a call without one gets a fresh identity. Identity is never
 * derived from the question text: asking the same thing twice is two
 * submissions and must start two runs.
 */
function agentRunRequestIdentity(input: CreateAgentRunInput): string {
  const explicit = input.requestId;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return mintAgentRunSubmissionId();
}

/**
 * Canonicalize connector/MetricFlow result rows at the API boundary.  A few
 * drivers return positional arrays while the notebook renderer is keyed by
 * column name; retaining the arrays is what produced the visible em-dash rows
 * in Ask.  Every downstream surface receives object rows with all declared
 * columns, including empty-result metadata.
 */
export function normalizeQueryResultPayload(raw: any): QueryResult {
  const columns: string[] = Array.isArray(raw?.columns)
    ? raw.columns.map((c: unknown) =>
        typeof c === 'string' ? c : typeof (c as any)?.name === 'string' ? (c as any).name : String(c)
      )
    : [];
  const semanticRefs = raw?.semanticRefs && typeof raw.semanticRefs === 'object'
    ? {
        metrics: Array.isArray(raw.semanticRefs.metrics) ? raw.semanticRefs.metrics.map(String) : [],
        dimensions: Array.isArray(raw.semanticRefs.dimensions) ? raw.semanticRefs.dimensions.map(String) : [],
      }
    : undefined;
  const rawRows = Array.isArray(raw?.rows) ? raw.rows : [];
  const inferredColumns = columns.length > 0
    ? columns
    : rawRows.find((row: unknown) => row && typeof row === 'object' && !Array.isArray(row))
      ? Object.keys(rawRows.find((row: unknown) => row && typeof row === 'object' && !Array.isArray(row)) as Record<string, unknown>)
      : rawRows.find((row: unknown) => Array.isArray(row))
        ? (rawRows.find((row: unknown) => Array.isArray(row)) as unknown[]).map((_, index) => `column_${index + 1}`)
        : [];
  const rows = rawRows.map((row: unknown): Record<string, unknown> => {
    if (Array.isArray(row)) return Object.fromEntries(inferredColumns.map((column, index) => [column, row[index]]));
    if (row && typeof row === 'object') {
      const record = row as Record<string, unknown>;
      return Object.fromEntries(inferredColumns.map((column) => [column, record[column]]));
    }
    return Object.fromEntries(inferredColumns.map((column) => [column, undefined]));
  });
  return {
    columns: inferredColumns,
    rows,
    ...(typeof raw?.resultFingerprint === 'string' ? { resultFingerprint: raw.resultFingerprint } : {}),
    ...(Array.isArray(raw?.columnsMeta) ? { columnsMeta: raw.columnsMeta.filter((meta: unknown) => meta && typeof meta === 'object' && typeof (meta as { name?: unknown }).name === 'string' && typeof (meta as { kind?: unknown }).kind === 'string') } : {}),
    ...(raw?.executionReceipt && typeof raw.executionReceipt === 'object' ? { executionReceipt: raw.executionReceipt as Record<string, unknown> } : {}),
    ...(typeof raw?.trustState === 'string' ? { trustState: raw.trustState } : {}),
    ...(typeof raw?.answerTier === 'string' ? { answerTier: raw.answerTier } : {}),
    rowCount: typeof raw?.rowCount === 'number' ? raw.rowCount : rows.length,
    executionTime: raw?.executionTime ?? raw?.executionTimeMs ?? 0,
    ...(semanticRefs ? { semanticRefs } : {}),
  };
}

function normalizeNotebookResearchRun(raw: NotebookResearchRun): NotebookResearchRun {
  const resultPreview = raw?.resultPreview && typeof raw.resultPreview === 'object'
    ? normalizeQueryResultPayload(raw.resultPreview)
    : undefined;
  return {
    ...raw,
    domain: typeof raw?.domain === 'string' && raw.domain.trim() ? raw.domain : undefined,
    owner: typeof raw?.owner === 'string' && raw.owner.trim() ? raw.owner : undefined,
    warnings: Array.isArray(raw?.warnings) ? raw.warnings : [],
    dqlCandidateIds: Array.isArray(raw?.dqlCandidateIds) ? raw.dqlCandidateIds : [],
    dqlArtifact: normalizeDqlArtifactReference(raw?.dqlArtifact),
    dqlPromotionAction: normalizeNotebookPromotionAction(raw?.dqlPromotionAction ?? raw?.dqlPromotion?.recommendedAction),
    dqlPromotion: normalizeNotebookDqlPromotion(raw?.dqlPromotion),
    researchPlan: normalizeNotebookResearchPlan(raw?.researchPlan),
    reviewChecklist: normalizeNotebookResearchChecklist(raw?.reviewChecklist, raw),
    ...(resultPreview ? { resultPreview } : { resultPreview: undefined }),
  };
}

function normalizeNotebookResearchPlan(raw: unknown): NotebookResearchPlan | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const evidence = record.evidence && typeof record.evidence === 'object' && !Array.isArray(record.evidence)
    ? record.evidence as Record<string, unknown>
    : {};
  const preview = record.preview && typeof record.preview === 'object' && !Array.isArray(record.preview)
    ? record.preview as Record<string, unknown>
    : {};
  const promotion = record.promotion && typeof record.promotion === 'object' && !Array.isArray(record.promotion)
    ? record.promotion as Record<string, unknown>
    : {};
  const sqlState = record.sqlState === 'generated' || record.sqlState === 'reviewed' ? record.sqlState : 'missing';
  const previewStatus = preview.status === 'ready' || preview.status === 'error' ? preview.status : 'not_run';
  const promotionPath = promotion.path === 'review_context'
    || promotion.path === 'run_preview'
    || promotion.path === 'reuse_existing'
    || promotion.path === 'create_dql_draft'
    || promotion.path === 'open_certification'
    || promotion.path === 'complete_review'
    ? promotion.path
    : 'needs_sql';
  const rowCount = typeof preview.rowCount === 'number' && Number.isFinite(preview.rowCount) ? preview.rowCount : undefined;
  return {
    sqlState,
    grain: typeof record.grain === 'string' && record.grain.trim() ? record.grain : undefined,
    parameterPolicy: normalizeParameterPolicy(record.parameterPolicy),
    allowedFilters: Array.isArray(record.allowedFilters) ? record.allowedFilters.map(String).filter(Boolean) : [],
    evidence: {
      trustLabel: typeof evidence.trustLabel === 'string' && evidence.trustLabel.trim() ? evidence.trustLabel : undefined,
      contextPackId: typeof evidence.contextPackId === 'string' && evidence.contextPackId.trim() ? evidence.contextPackId : undefined,
      evidenceCount: finiteCount(evidence.evidenceCount),
      relationCount: finiteCount(evidence.relationCount),
      missingContextCount: finiteCount(evidence.missingContextCount),
    },
    preview: {
      status: previewStatus,
      ...(rowCount === undefined ? {} : { rowCount }),
    },
    promotion: {
      path: promotionPath,
      duplicateDecision: typeof promotion.duplicateDecision === 'string' && promotion.duplicateDecision.trim() ? promotion.duplicateDecision : undefined,
    },
    reviewFocus: Array.isArray(record.reviewFocus) ? record.reviewFocus.map(String).filter(Boolean) : [],
    generatedAt: typeof record.generatedAt === 'string' && record.generatedAt.trim() ? record.generatedAt : new Date(0).toISOString(),
  };
}

function normalizeParameterPolicy(value: unknown): Array<{ name: string; policy: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Array<{ name: string; policy: string }> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' && record.name.trim() ? record.name : undefined;
    const policy = typeof record.policy === 'string' && record.policy.trim() ? record.policy : undefined;
    return name && policy ? [{ name, policy }] : [];
  });
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeNotebookResearchReviewMetrics(value: unknown): NotebookResearchListResponse['reviewMetrics'] {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    totalReviewCount: finiteCount(raw.totalReviewCount),
    openReviewCount: finiteCount(raw.openReviewCount),
    terminalReviewCount: finiteCount(raw.terminalReviewCount),
    draftCreatedCount: finiteCount(raw.draftCreatedCount),
    certifiedCount: finiteCount(raw.certifiedCount),
    completedCount: finiteCount(raw.completedCount),
    rejectedCount: finiteCount(raw.rejectedCount),
    draftCreationRate: nullableFiniteNumber(raw.draftCreationRate),
    certifyConversionRate: nullableFiniteNumber(raw.certifyConversionRate),
    medianOpenReviewAgeMs: nullableFiniteNumber(raw.medianOpenReviewAgeMs),
    medianTimeToDraftMs: nullableFiniteNumber(raw.medianTimeToDraftMs),
    medianTimeToCertificationMs: nullableFiniteNumber(raw.medianTimeToCertificationMs),
    medianTimeToTerminalMs: nullableFiniteNumber(raw.medianTimeToTerminalMs),
  };
}

function normalizeNotebookResearchDiagnostics(raw: NotebookResearchDiagnostics): NotebookResearchDiagnostics {
  const record = raw && typeof raw === 'object' ? raw : {} as NotebookResearchDiagnostics;
  const counts = record.counts && typeof record.counts === 'object' ? record.counts : {} as NotebookResearchDiagnostics['counts'];
  const health = record.health && typeof record.health === 'object' ? record.health as Record<string, unknown> : {};
  const search = record.search && typeof record.search === 'object' ? record.search : {} as NotebookResearchDiagnostics['search'];
  const updatedAt = record.updatedAt && typeof record.updatedAt === 'object' ? record.updatedAt as Record<string, unknown> : {};
  const limits = record.limits && typeof record.limits === 'object' ? record.limits : {} as NotebookResearchDiagnostics['limits'];
  return {
    counts: {
      totalRuns: finiteCount(counts.totalRuns),
      activeRuns: finiteCount(counts.activeRuns),
      closedRuns: finiteCount(counts.closedRuns),
      notebooks: finiteCount(counts.notebooks),
      domains: finiteCount(counts.domains),
      owners: finiteCount(counts.owners),
      sourceLinkedRuns: finiteCount(counts.sourceLinkedRuns),
    },
    health: {
      staleOpenRuns: finiteCount(health.staleOpenRuns),
      expiredOpenRuns: finiteCount(health.expiredOpenRuns),
      staleThresholdDays: finiteCount(health.staleThresholdDays) || 7,
      expiredThresholdDays: finiteCount(health.expiredThresholdDays) || 30,
      oldestOpenUpdatedAt: typeof health.oldestOpenUpdatedAt === 'string' && health.oldestOpenUpdatedAt.trim() ? health.oldestOpenUpdatedAt : undefined,
      newestOpenUpdatedAt: typeof health.newestOpenUpdatedAt === 'string' && health.newestOpenUpdatedAt.trim() ? health.newestOpenUpdatedAt : undefined,
    },
    search: {
      indexed: search.indexed === true,
      indexRows: finiteCount(search.indexRows),
      indexVersion: typeof search.indexVersion === 'string' && search.indexVersion.trim() ? search.indexVersion : undefined,
      stale: search.stale === true,
    },
    updatedAt: {
      oldest: typeof updatedAt.oldest === 'string' && updatedAt.oldest.trim() ? updatedAt.oldest : undefined,
      newest: typeof updatedAt.newest === 'string' && updatedAt.newest.trim() ? updatedAt.newest : undefined,
    },
    limits: {
      pageSize: finiteCount(limits.pageSize) || 25,
      maxPageSize: finiteCount(limits.maxPageSize) || 500,
      sourceCoverageLimit: finiteCount(limits.sourceCoverageLimit) || 10_000,
      seedCellLimit: finiteCount(limits.seedCellLimit) || 1_000,
    },
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === 'string') : [],
  };
}

function normalizeNotebookResearchIntent(value: unknown): NotebookResearchIntent {
  return value === 'diagnose_change'
    || value === 'driver_breakdown'
    || value === 'segment_compare'
    || value === 'entity_drilldown'
    || value === 'anomaly_investigation'
    || value === 'trust_gap_review'
    ? value
    : 'ad_hoc_analysis';
}

function notebookTitleFromPath(value: unknown): string {
  const path = typeof value === 'string' ? value : '';
  const file = path.split(/[\\/]/).pop() ?? path;
  return file
    .replace(/\.dqlnb$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    || 'Untitled notebook';
}

function normalizeNotebookResearchNextActionCounts(value: unknown): Record<NotebookResearchNextActionFilter, number> {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const read = (key: NotebookResearchNextActionFilter) => typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? raw[key] as number : 0;
  return {
    fix_blockers: read('fix_blockers'),
    review_sql: read('review_sql'),
    review_context: read('review_context'),
    run_preview: read('run_preview'),
    reuse_existing: read('reuse_existing'),
    create_dql_draft: read('create_dql_draft'),
    open_certification: read('open_certification'),
    complete_review: read('complete_review'),
    continue_review: read('continue_review'),
  };
}

function normalizeNotebookResearchNextAction(value: unknown): NotebookResearchNextActionFilter | undefined {
  return value === 'fix_blockers'
    || value === 'review_sql'
    || value === 'review_context'
    || value === 'run_preview'
    || value === 'reuse_existing'
    || value === 'create_dql_draft'
    || value === 'open_certification'
    || value === 'complete_review'
    || value === 'continue_review'
    ? value
    : undefined;
}

function normalizeNotebookResearchChecklist(raw: NotebookResearchReviewChecklist | undefined, run: NotebookResearchRun): NotebookResearchReviewChecklist {
  if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
    return {
      readyForDqlDraft: raw.readyForDqlDraft === true,
      readyForCertificationReview: raw.readyForCertificationReview === true,
      blockers: Array.isArray(raw.blockers) ? raw.blockers.filter((item): item is string => typeof item === 'string') : [],
      warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((item): item is string => typeof item === 'string') : [],
      items: raw.items.map((item) => ({
        id: typeof item.id === 'string' ? item.id : 'item',
        label: typeof item.label === 'string' ? item.label : 'Review item',
        status: item.status === 'passed' || item.status === 'pending' || item.status === 'warning' || item.status === 'blocked' ? item.status : 'pending',
        detail: typeof item.detail === 'string' ? item.detail : '',
      })),
    };
  }
  const hasReviewedSql = Boolean(run.reviewedSql);
  const hasSql = hasReviewedSql || Boolean(run.generatedSql);
  const previewRowCount = run.resultPreview?.rowCount ?? run.resultPreview?.rows.length ?? 0;
  const hasPreview = Boolean(run.resultPreview && (run.resultPreview.columns.length > 0 || previewRowCount > 0));
  const hasDraft = Boolean(run.draftBlockPath);
  const hasEvidence = Boolean(run.contextPackId || run.evidence);
  const reuseExisting = run.dqlPromotionAction === 'reuse_existing';
  return {
    readyForDqlDraft: Boolean(!reuseExisting && run.question && hasReviewedSql && hasEvidence && run.status !== 'error'),
    readyForCertificationReview: Boolean(!reuseExisting && run.question && hasReviewedSql && hasEvidence && hasPreview && hasDraft),
    blockers: run.status === 'error' ? [run.error ?? 'Preview failed.'] : [],
    warnings: hasPreview || reuseExisting ? [] : ['Run a bounded preview before certification review.'],
    items: [
      { id: 'question', label: 'Question', status: run.question ? 'passed' : 'blocked', detail: run.question ? 'Business question is captured.' : 'Add a business question.' },
      {
        id: 'sql',
        label: 'Reviewed SQL',
        status: hasSql || reuseExisting ? 'passed' : 'blocked',
        detail: reuseExisting && !hasSql ? 'Existing DQL should be reused; no new SQL is required.' : hasSql ? 'SQL is available.' : 'Add SQL before promotion.',
      },
      {
        id: 'evidence',
        label: 'Evidence',
        status: hasEvidence || reuseExisting ? 'passed' : 'warning',
        detail: hasEvidence ? 'Context evidence is saved.' : reuseExisting ? 'Reuse evidence is captured in the recommendation.' : 'Preview and save metadata context.',
      },
      {
        id: 'preview',
        label: 'Preview',
        status: hasPreview || reuseExisting ? 'passed' : 'pending',
        detail: hasPreview ? 'Preview result is available.' : reuseExisting ? 'Certified block reuse does not require a new raw SQL preview.' : 'Run a bounded preview.',
      },
      {
        id: 'dql_draft',
        label: 'DQL draft',
        status: hasDraft || reuseExisting ? 'passed' : 'pending',
        detail: hasDraft ? `Draft saved at ${run.draftBlockPath}.` : reuseExisting ? 'No new DQL draft is required.' : 'Create a DQL draft after review.',
      },
    ],
  };
}

function normalizeNotebookResearchContextPreview(raw: NotebookResearchContextPreview): NotebookResearchContextPreview {
  const record = raw && typeof raw === 'object' ? raw : {} as NotebookResearchContextPreview;
  const routeDecision = record.routeDecision && typeof record.routeDecision === 'object'
    ? {
        route: typeof record.routeDecision.route === 'string' ? record.routeDecision.route : undefined,
        intent: typeof record.routeDecision.intent === 'string' ? record.routeDecision.intent : undefined,
        reason: typeof record.routeDecision.reason === 'string' ? record.routeDecision.reason : undefined,
      }
    : undefined;
  return {
    contextPackId: typeof record.contextPackId === 'string' ? record.contextPackId : '',
    trustLabel: typeof record.trustLabel === 'string' ? record.trustLabel : undefined,
    routeDecision,
    evidence: Array.isArray(record.evidence)
      ? record.evidence.map((item) => ({
          objectKey: typeof item.objectKey === 'string' ? item.objectKey : undefined,
          objectType: typeof item.objectType === 'string' ? item.objectType : undefined,
          name: typeof item.name === 'string' ? item.name : 'Evidence',
          role: typeof item.role === 'string' ? item.role : undefined,
          reason: typeof item.reason === 'string' ? item.reason : '',
        }))
      : [],
    summaries: Array.isArray(record.summaries)
      ? record.summaries.map((item) => ({
          title: typeof item.title === 'string' ? item.title : 'Context',
          detail: typeof item.detail === 'string' ? item.detail : '',
          objectType: typeof item.objectType === 'string' ? item.objectType : undefined,
          reason: typeof item.reason === 'string' ? item.reason : undefined,
        }))
      : [],
    relations: Array.isArray(record.relations)
      ? record.relations.map((item) => ({
          relation: typeof item.relation === 'string' ? item.relation : '',
          name: typeof item.name === 'string' ? item.name : 'Relation',
          source: typeof item.source === 'string' ? item.source : '',
          columns: Array.isArray(item.columns) ? item.columns.map(String) : [],
        })).filter((item) => item.relation || item.name)
      : [],
    missingContext: Array.isArray(record.missingContext)
      ? record.missingContext.map((item) => ({
          kind: typeof item.kind === 'string' ? item.kind : 'metadata',
          message: typeof item.message === 'string' ? item.message : '',
          severity: typeof item.severity === 'string' ? item.severity : 'warning',
        })).filter((item) => item.message)
      : [],
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === 'string') : [],
    topRejected: Array.isArray(record.topRejected)
      ? record.topRejected.map((item) => ({
          name: typeof item.name === 'string' ? item.name : 'Rejected context',
          objectType: typeof item.objectType === 'string' ? item.objectType : undefined,
          reason: typeof item.reason === 'string' ? item.reason : '',
          score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : undefined,
        })).filter((item) => item.reason)
      : [],
    counts: {
      objects: typeof record.counts?.objects === 'number' ? record.counts.objects : 0,
      evidence: typeof record.counts?.evidence === 'number' ? record.counts.evidence : 0,
      relations: typeof record.counts?.relations === 'number' ? record.counts.relations : 0,
      warnings: typeof record.counts?.warnings === 'number' ? record.counts.warnings : 0,
    },
  };
}

function normalizeNotebookPromotionAction(value: unknown): NotebookResearchDqlPromotionAction | undefined {
  return value === 'reuse_existing'
    || value === 'extend_existing'
    || value === 'create_replacement'
    || value === 'create_new'
    || value === 'review_required'
    ? value
    : undefined;
}

function normalizeNotebookDqlPromotion(raw: NotebookResearchDqlPromotion | undefined): NotebookResearchDqlPromotion | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  return {
    importId: typeof raw.importId === 'string' ? raw.importId : '',
    candidateIds: Array.isArray(raw.candidateIds) ? raw.candidateIds.filter((item): item is string => typeof item === 'string') : [],
    draftBlockPath: typeof raw.draftBlockPath === 'string' ? raw.draftBlockPath : undefined,
    recommendedAction: typeof raw.recommendedAction === 'string' ? raw.recommendedAction : undefined,
    similarityMatches: Array.isArray(raw.similarityMatches) ? raw.similarityMatches : [],
    candidates: Array.isArray(raw.candidates)
      ? raw.candidates.map((candidate) => ({
          ...candidate,
          similarityMatches: Array.isArray(candidate.similarityMatches) ? candidate.similarityMatches : [],
          parameterPolicy: Array.isArray(candidate.parameterPolicy) ? candidate.parameterPolicy : [],
          allowedFilters: Array.isArray(candidate.allowedFilters) ? candidate.allowedFilters : [],
          warnings: Array.isArray(candidate.warnings) ? candidate.warnings : [],
        }))
      : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

export interface NotebookCellExecutionResponse {
  cellType: string;
  cellId?: string;
  runId?: string;
  title?: string;
  blockName?: string;
  blockPath?: string;
  chartConfig?: Record<string, unknown>;
  tests?: Array<{ field: string; operator: string; expected: unknown }>;
  result: QueryResult | null;
  executionTarget?: ExecutionTarget;
  engine?: 'native' | 'metricflow-cli' | 'dbt-cloud';
  semanticTrace?: SemanticRuntimeTrace;
  compiledSql?: string;
  executedSql?: string;
  targetBinding?: Record<string, unknown>;
  executionReceipt?: Record<string, unknown>;
}

export interface NotebookQueryExecutionResult extends QueryResult {
  executionTarget?: ExecutionTarget;
  compiledSql?: string;
  executedSql?: string;
  targetBinding?: Record<string, unknown>;
  executionReceipt?: Record<string, unknown>;
}

export interface NotebookRepairExecutionResponse {
  ok: true;
  source: string;
  repairedSql: string;
  repairMode: 'deterministic' | 'ai';
  result: QueryResult;
  executionTarget?: ExecutionTarget;
  compiledSql?: string;
  executedSql?: string;
  executionReceipt?: Record<string, unknown>;
}

export interface BlockStudioRepairExecutionResponse {
  source: string;
  repairedSql: string;
  repairMode: 'deterministic' | 'ai';
  preview: BlockStudioPreview;
}

export interface DatasetColumn {
  name: string;
  type: string;
  nullable?: boolean;
  nullCount?: number;
  distinctCount?: number;
  sampleValues?: unknown[];
  flags?: string[];
}

export interface DatasetSource {
  id: string;
  name: string;
  alias: string;
  description?: string;
  owner?: string;
  tags: string[];
  sourcePath: string;
  storageMode: "local" | "project" | "staged";
  format: "csv" | "parquet" | "json";
  fileFingerprint: string;
  sizeBytes: number;
  modifiedAt: string;
  importedAt: string;
  refreshedAt: string;
  trustState:
    | "local_ad_hoc"
    | "project_controlled"
    | "governed_snapshot"
    | "review_required";
  profile: {
    rowCount: number;
    sampledRows: number;
    columns: DatasetColumn[];
    warnings: string[];
    preview: Array<Record<string, unknown>>;
  };
  linked?: boolean;
  pinned?: boolean;
  expiresAt?: string;
  lineage?: Record<string, unknown>;
  schemaDrift?: {
    detectedAt: string;
    added: string[];
    removed: string[];
    changed: Array<{ column: string; before: string; after: string }>;
  };
  schemaOverrides?: Record<string, string>;
}

export interface DbtProfileConnectionCandidate {
  id: string;
  profileName: string;
  targetName: string;
  adapter: string;
  path: string;
  connection: Record<string, unknown>;
  missingFields: string[];
  warnings: string[];
}

export interface ConnectionsResponse {
  default: string;
  connections: Record<string, unknown>;
  activeConnection?: { source: 'dql_config' | 'dbt_profile' | 'runtime'; driver: string; profileId?: string } | null;
  connectorStatus?: Array<{
    driver: 'duckdb' | 'snowflake' | 'databricks';
    label: string;
    packageName?: string;
    packageSpec?: string;
    installed: boolean;
    builtIn: boolean;
    installPath: string;
    installCommand?: string;
  }>;
  dbtProfiles?: DbtProfileConnectionCandidate[];
  metadataScope?: ConnectionMetadataScopeV1 | null;
  metadataStatus?: WarehouseMetadataStatus;
  /** The environment variables the default connection reads (`${NAME}`), by name, and whether each is set. */
  environmentReferences?: Array<{ name: string; set: boolean }>;
}

export interface ConnectionMetadataScopeV1 {
  version: 1;
  connectionId: string;
  driver: string;
  mode: 'dbt_relations' | 'selected_scopes' | 'dbt_plus_selected';
  scopes: Array<{ catalogOrDatabase: string; schemas: string[] }>;
  selectedScopes?: Array<{ catalogOrDatabase: string; schemas: string[] }>;
  relations: string[];
  dbtFingerprint?: string;
  scopeFingerprint: string;
}

export interface WarehouseMetadataStatus {
  state: 'missing' | 'ready' | 'stale';
  scopeFingerprint?: string;
  generationId?: string;
  capturedAt?: string;
  relationCount: number;
  columnCount: number;
  queryCount?: number;
  durationMs?: number;
  truncated?: boolean;
  source?: string;
  scopes: Array<{ catalogOrDatabase: string; schemas: string[] }>;
  observedTarget?: {
    driver: string;
    accountOrWorkspace?: string;
    role?: string;
    warehouse?: string;
    defaultCatalogOrDatabase?: string;
    defaultSchema?: string;
  };
}

export interface ConnectionMetadataScopeInput {
  mode?: ConnectionMetadataScopeV1['mode'];
  scopes?: Array<{ catalogOrDatabase: string; schemas: string[] }>;
  relations?: string[];
  dbtFingerprint?: string;
}

export interface WarehouseMetadataDiscovery {
  version: 1;
  connectionId: string;
  driver: string;
  discoveredAt: string;
  supported: boolean;
  scopes: Array<{
    catalogOrDatabase: string;
    schemas: Array<{
      name: string;
      inDbtProject: boolean;
      dbtRelationCount: number;
    }>;
  }>;
  dbtScopes: Array<{ catalogOrDatabase: string; schemas: string[] }>;
  queryCount: number;
  truncated: boolean;
  message: string;
}

export type ContextAuthoringOrigin = 'manual' | 'yaml_import' | 'dbt_discovery' | 'warehouse_discovery' | 'ai' | 'correction';
export interface ContextAuthoringPatchV1 { path: string; before: string; after: string; changed: boolean; owner: 'dql' | 'dbt'; operationId: string }
export interface ContextAuthoringDiagnosticV1 { code: string; severity: 'info' | 'warning' | 'blocking'; message: string; operationId?: string }
/** Browser transport shape for a source-owned Dataset declaration patch. */
export interface DatasetAuthoringChange {
  targetQualifiedId: string;
  targetPath: string;
  expectedSourceHash: string;
  patch: {
    grain?: Record<string, unknown>;
    fields?: Array<Record<string, unknown>>;
    measures?: Array<Record<string, unknown>>;
  };
}
/** Typed, review-required new Dataset declaration. The server owns its path,
 * DQL rendering, lifecycle, and compile gate; this transport shape never
 * carries free SQL or proof/certification authority. */
export interface DatasetDraftAuthoringChange {
  domain: string;
  slug: string;
  sourceRelation: string;
  name: string;
  description: string;
  grain: Record<string, unknown>;
  fields: Array<Record<string, unknown>>;
  measures: Array<Record<string, unknown>>;
  sourceEvidence: string[];
}
export type ContextAuthoringOperation =
  | { id: string; kind: 'modeling_change'; change: ModelingAuthoringChange; dependsOn?: string[]; evidence?: string[] }
  | { id: string; kind: 'skill_change'; operation: 'create' | 'update' | 'move'; value: Skill; targetQualifiedId?: string; expectedSourceHash?: string; dependsOn?: string[]; evidence?: string[] }
  | { id: string; kind: 'dbt_source_change'; change: DbtSourceAuthoringInput; dependsOn?: string[]; evidence?: string[] }
  | { id: string; kind: 'dataset_change'; change: DatasetAuthoringChange; dependsOn?: string[]; evidence?: string[] }
  | { id: string; kind: 'dataset_draft'; change: DatasetDraftAuthoringChange; dependsOn?: string[]; evidence?: string[] };
export interface ContextAuthoringProposalV1 {
  version: 1;
  id: string;
  origin: ContextAuthoringOrigin;
  status: 'proposed' | 'committed' | 'conflicted';
  trustState: 'review_required';
  createdAt: string;
  baseSnapshotId: string;
  dependencyFingerprints: Record<string, string>;
  operations: ContextAuthoringOperation[];
  patches: ContextAuthoringPatchV1[];
  diagnostics: ContextAuthoringDiagnosticV1[];
  impact: { files: number; modelingChanges: number; skillChanges: number; dbtSourceChanges: number; datasetChanges: number };
  proposalHash: string;
  sourceRunId?: string;
  sourceArtifactId?: string;
  revision?: number;
  committedAt?: string;
  committedSnapshotId?: string;
}
export interface ModelingImportCandidate {
  id: string;
  name: string;
  path?: string;
  dialect: 'dql_modeling' | 'dbt_resource' | 'dbt_semantic' | 'unsupported';
  action: 'import' | 'open_existing' | 'unsupported';
  summary: string;
  warnings: string[];
}
export interface ModelingImportSession {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  source: { mode: 'current_project' | 'path' | 'upload' | 'paste'; label: string };
  candidates: ModelingImportCandidate[];
  proposalId?: string;
}

function appSourceCandidateToRecommendation(source: AppSourceCandidateWire): AppBlockRecommendation {
  return {
    id: source.sourceId,
    sourceId: source.sourceId,
    kind: source.kind,
    sourcePath: source.sourcePath,
    qualifiedIdentity: source.qualifiedIdentity,
    sourceRevision: source.sourceRevision,
    snapshotId: source.snapshotId,
    lifecycle: source.lifecycle,
    trust: source.trust,
    name: source.name,
    domain: source.domain ?? 'Unassigned',
    status: source.lifecycle,
    owner: source.owner ?? null,
    tags: source.tags,
    path: source.executionRef,
    fingerprint: source.sourceRevision,
    lastModified: '',
    description: source.description ?? '',
    chartType: source.capabilities.chartType,
    filterIds: source.capabilities.filters,
    dimensionIds: source.capabilities.dimensions,
    capabilities: source.capabilities,
    eligibility: source.eligibility,
    score: source.score ?? 0,
    reasons: source.reasons,
    ...(source.certification ? { certification: source.certification } : {}),
  };
}

export const api = {
  async listOperations(limit = 50): Promise<{ operations: LocalOperation[] }> {
    return request(`/api/operations?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`);
  },

  async getOperation(operationId: string): Promise<LocalOperation> {
    return request(`/api/operations/${encodeURIComponent(operationId)}`);
  },

  async cancelOperation(operationId: string): Promise<LocalOperation> {
    return request(`/api/operations/${encodeURIComponent(operationId)}`, { method: 'DELETE' });
  },

  async requestBlockStudioCertification(payload: {
    source: string;
    path?: string | null;
    metadata: BlockStudioOpenPayload['metadata'];
    expectedSourceFingerprint?: string;
    clientRevision: string;
    idempotencyKey: string;
  }): Promise<{
    operation: LocalOperation<BlockCertificationOperationResult>;
    draft: BlockStudioOpenPayload;
    deduplicated?: boolean;
  }> {
    return request('/api/block-studio/certifications', {
      method: 'POST',
      headers: { 'Idempotency-Key': payload.idempotencyKey },
      body: JSON.stringify({
        source: payload.source,
        path: payload.path,
        metadata: payload.metadata,
        expectedSourceFingerprint: payload.expectedSourceFingerprint,
        clientRevision: payload.clientRevision,
      }),
    });
  },

  /** Read the compiled dbt-first overlay. dbt-owned details stay in dbt artifacts. */
  async getDbtFirstModeling(): Promise<DbtFirstModelingResponse> {
    return request<DbtFirstModelingResponse>('/api/modeling/dbt-first');
  },

  /** Turn on warehouse modeling: warehouse-first, or hybrid for a dbt project (RFC 0007). */
  async enableWarehouseModeling(mode: 'warehouse-first' | 'hybrid' = 'warehouse-first'): Promise<{ mode: string; changed: boolean; connectionId: string; warehouseCatalog?: WarehouseCatalogSummary }> {
    return request('/api/modeling/warehouse/enable', { method: 'POST', body: JSON.stringify({ mode }) });
  },

  /**
   * Draft domains, models and joins from the warehouse catalog, checked on the
   * warehouse, as a reviewable proposal. `proposal` is null when there is
   * nothing new to draft.
   */
  async draftWarehouseModel(input: { expectedSnapshotId?: string; domain?: string; validate?: boolean; queryHistory?: boolean } = {}): Promise<{ report: WarehouseDiscoveryReport; proposal: ContextAuthoringProposalV1 | null }> {
    return request('/api/modeling/warehouse/discover/proposal', { method: 'POST', body: JSON.stringify({ validate: true, ...input }) });
  },

  async getDbtModelingNode(uniqueId: string): Promise<DbtNodeAuthoringDetail> {
    return request<DbtNodeAuthoringDetail>(`/api/modeling/dbt-first/nodes/${encodeURIComponent(uniqueId)}`);
  },

  async getDbtModelingNodes(uniqueIds: string[]): Promise<{ details: DbtNodeAuthoringDetail[]; snapshotId: string }> {
    return request('/api/modeling/dbt-first/nodes/batch', { method: 'POST', body: JSON.stringify({ uniqueIds }) });
  },

  async getDbtModelInventory(options: { q?: string; domain?: string; cursor?: number; limit?: number; physicalOnly?: boolean } = {}): Promise<DbtModelInventoryResponse> {
    const query = new URLSearchParams();
    if (options.q) query.set('q', options.q);
    if (options.domain) query.set('domain', options.domain);
    if (options.cursor !== undefined) query.set('cursor', String(options.cursor));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.physicalOnly) query.set('physicalOnly', 'true');
    return request<DbtModelInventoryResponse>(`/api/modeling/dbt-first/inventory?${query.toString()}`);
  },

  async getDomainWorkspaces(): Promise<{ domains: DomainWorkspaceSummary[]; unassignedModels: number; snapshot: { id: string; stale: boolean; error?: string } }> {
    return request('/api/domain-workspaces');
  },

  async getRelatedDomainProducts(domain: string): Promise<RelatedDomainProducts> {
    return request(`/api/domain-workspaces/${encodeURIComponent(domain)}/related-products`);
  },

  async getAllRelatedDomainProducts(): Promise<RelatedDomainProducts> {
    return request('/api/domain-workspaces/related-products');
  },

  async getDomainKnowledge(domain: string): Promise<DomainKnowledgeResponse> {
    return request(`/api/domain-workspaces/${encodeURIComponent(domain)}/knowledge`);
  },

  async createContextProposal(input: {
    origin: ContextAuthoringOrigin;
    expectedSnapshotId?: string;
    operations: ContextAuthoringOperation[];
    sourceRunId?: string;
    sourceArtifactId?: string;
    revision?: number;
  }): Promise<ContextAuthoringProposalV1> {
    const result = await request<{ proposal: ContextAuthoringProposalV1 }>('/api/context-proposals', { method: 'POST', body: JSON.stringify(input) });
    return result.proposal;
  },

  async getContextProposal(id: string): Promise<ContextAuthoringProposalV1> {
    const result = await request<{ proposal: ContextAuthoringProposalV1 }>(`/api/context-proposals/${encodeURIComponent(id)}`);
    return result.proposal;
  },

  /** Check a join in the warehouse and propose its cardinality. → POST /api/modeling/dbt-first/relationships/profile */
  async profileModelingRelationship(relationship: { from: string; to: string; keys: Array<{ from: string; to: string }> }, expectedSnapshotId: string): Promise<RelationshipProfileResponse> {
    return request<RelationshipProfileResponse>('/api/modeling/dbt-first/relationships/profile', { method: 'POST', body: JSON.stringify({ relationship, expectedSnapshotId }) });
  },

  /** Join keys worth trying between two models. → GET /api/modeling/dbt-first/relationships/suggestions */
  async getRelationshipKeySuggestions(from: string, to: string): Promise<{ suggestions: RelationshipKeySuggestion[] }> {
    return request<{ suggestions: RelationshipKeySuggestion[] }>(`/api/modeling/dbt-first/relationships/suggestions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  },

  async repreviewContextProposal(id: string, selectedOperationIds: string[], options?: { rebase?: boolean }): Promise<ContextAuthoringProposalV1> {
    const result = await request<{ proposal: ContextAuthoringProposalV1 }>(`/api/context-proposals/${encodeURIComponent(id)}/repreview`, { method: 'POST', body: JSON.stringify({ selectedOperationIds, rebase: options?.rebase === true }) });
    return result.proposal;
  },

  async commitContextProposal(id: string, expectedProposalHash: string, idempotencyKey: string): Promise<{ proposal: ContextAuthoringProposalV1; snapshotId: string }> {
    return request(`/api/context-proposals/${encodeURIComponent(id)}/commit`, { method: 'POST', body: JSON.stringify({ expectedProposalHash, idempotencyKey }) });
  },

  async createModelingImport(source: { mode: ModelingImportSession['source']['mode']; path?: string; content?: string; filename?: string }): Promise<ModelingImportSession> {
    const result = await request<{ session: ModelingImportSession }>('/api/modeling/dbt-first/imports', { method: 'POST', body: JSON.stringify({ source }) });
    return result.session;
  },

  async previewModelingImport(id: string, input: { selectedCandidateIds: string[]; domain: string; areaId: string; expectedSnapshotId: string }): Promise<{ session: ModelingImportSession; proposal: ContextAuthoringProposalV1 }> {
    return request(`/api/modeling/dbt-first/imports/${encodeURIComponent(id)}/preview`, { method: 'POST', body: JSON.stringify(input) });
  },

  async previewModelingChange(change: ModelingAuthoringChange, expectedSnapshotId: string): Promise<ModelingChangePreview> {
    return request<ModelingChangePreview>('/api/modeling/dbt-first/preview', {
      method: 'POST', body: JSON.stringify({ change, expectedSnapshotId }),
    });
  },

  async applyModelingChange(change: ModelingAuthoringChange, fingerprint: string, expectedSnapshotId: string): Promise<ModelingApplyResponse> {
    return request<ModelingApplyResponse>('/api/modeling/dbt-first/apply', {
      method: 'POST', body: JSON.stringify({ change, fingerprint, expectedSnapshotId }),
    });
  },

  async validateModelingRelationship(relationship: RelationshipAuthoringInput, expectedSnapshotId: string): Promise<ManifestRelationshipValidationEvidence> {
    const result = await request<{ evidence: ManifestRelationshipValidationEvidence }>('/api/modeling/dbt-first/relationships/validate', {
      method: 'POST', body: JSON.stringify({ relationship, expectedSnapshotId }),
    });
    return result.evidence;
  },

  async previewDbtSourcePatch(change: DbtSourceAuthoringInput, expectedSnapshotId: string): Promise<DbtSourcePatchPreview & { requestId?: string; snapshotId: string }> {
    return request('/api/modeling/dbt-first/dbt-source/preview', {
      method: 'POST', body: JSON.stringify({ change, expectedSnapshotId }),
    });
  },

  async applyDbtSourcePatch(change: DbtSourceAuthoringInput, expectedFingerprint: string, expectedSnapshotId: string): Promise<{ requestId?: string; snapshotId: string; applied: DbtSourcePatchPreview }> {
    return request('/api/modeling/dbt-first/dbt-source/apply', {
      method: 'POST', body: JSON.stringify({ change, expectedFingerprint, expectedSnapshotId }),
    });
  },

  async previewDbtMetricPatch(change: DbtMetricAuthoringInput, expectedSnapshotId: string): Promise<DbtMetricPatchPreview & { requestId?: string; snapshotId: string }> {
    return request('/api/modeling/dbt-first/dbt-metric/preview', {
      method: 'POST', body: JSON.stringify({ change, expectedSnapshotId }),
    });
  },

  async applyDbtMetricPatch(change: DbtMetricAuthoringInput, expectedFingerprint: string, expectedSnapshotId: string): Promise<{ requestId?: string; snapshotId: string; applied: DbtMetricPatchPreview; manifestRefresh: { refreshed: boolean; reason?: string } }> {
    return request('/api/modeling/dbt-first/dbt-metric/apply', {
      method: 'POST', body: JSON.stringify({ change, expectedFingerprint, expectedSnapshotId }),
    });
  },

  async getSettingsEnvStatus(): Promise<{ groups: SettingsEnvGroup[] }> {
    try {
      return await request<{ groups: SettingsEnvGroup[] }>('/api/settings/env-status');
    } catch {
      return { groups: [] };
    }
  },

  /**
   * Fetch the readiness summary + ranked DRAFT proposals from the propose
   * engine. Read-only preview: the server does not write or certify anything.
   */
  async getProposeReadiness(input?: { owner?: string; limit?: number }): Promise<ProposeReadiness> {
    try {
      return await request<ProposeReadiness>('/api/propose', {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      });
    } catch {
      return {
        ready: false,
        reason: 'Unable to reach the propose engine. Is the local ZLens server running?',
        summary: {
          modelsScanned: 0,
          businessModels: 0,
          plumbingExcluded: 0,
          metricsFound: 0,
          proposalsRanked: 0,
          draftsExisting: 0,
          readyForReview: 0,
          blockingTotal: 0,
          warningTotal: 0,
        },
        plan: EMPTY_PLAN,
        proposals: [],
      };
    }
  },

  /**
   * Materialize DRAFT blocks for an APPROVED scope (selected slugs / domains).
   * The only propose call that writes — and only for the business-only selection
   * the human approved. Nothing is ever certified.
   */
  async generateProposeDrafts(input: {
    slugs?: string[];
    domains?: string[];
    owner?: string;
  }): Promise<ProposeGenerateResult> {
    try {
      return await request<ProposeGenerateResult>('/api/propose/generate', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof Error ? error.message : 'Unable to reach the propose engine.',
        draftsWritten: 0,
        draftsSkipped: 0,
        proposals: [],
      };
    }
  },

  /**
   * Spec 14 (part A) — lazily fetch the transparent preview for a single
   * planned proposal slug: the SQL the draft would run, declared outputs,
   * example questions, and a plain-language Certifier verdict. Read-only;
   * generates/writes nothing. Used by the expandable Get Started rows.
   */
  async proposePreview(slug: string): Promise<{ candidate: ProposePlanCandidate }> {
    return request<{ candidate: ProposePlanCandidate }>(
      `/api/propose/preview?slug=${encodeURIComponent(slug)}`,
    );
  },

  /**
   * Spec 14 (part B) — unified AI Build. Generates SQL/DQL for the user's
   * prompt and returns a clean ARTIFACT, never the Q&A answer loop's internals.
   * The result is discriminated on `target`: a notebook CELL (SQL) or a draft
   * BLOCK (saved at `path`, with metadata + Certifier verdict). Nothing is
   * certified — drafts await a human.
   */
  async aiBuild(input: {
    prompt: string;
    context?: { cellSql?: string; selection?: string };
    target: AiBuildTarget;
    owner?: string;
    // Spec 17 (part A) — 'edit' rewrites an existing block at `blockPath`
    // (so the result can show a before/after diff); 'create' (default) makes a
    // new one. `domain` scopes the build to a first-class domain (part B).
    mode?: AiBuildMode;
    blockPath?: string;
    domain?: string;
    modelAreaId?: string;
  }): Promise<AiBuildResult> {
    // A cell only returns SQL (asking); a block is written (authoring): two routes, so a host can tell them apart.
    return request<AiBuildResult>(input.target === 'cell' ? '/api/ai/build/cell' : '/api/ai/build', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
    const raw = await request<{ run: AgentRun }>('/api/agent-runs', {
      method: 'POST',
      headers: { 'Idempotency-Key': agentRunRequestIdentity(input) },
      body: serializeCreateAgentRunInput(input),
    });
    return raw.run;
  },

  async createAgentRunStream(
    input: CreateAgentRunInput,
    onMessage: (message: AgentRunStreamMessage) => void,
    signal?: AbortSignal,
  ): Promise<AgentRun> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/agent-runs?stream=1`, {
        method: 'POST',
        headers: withServerAuthorization({ 'Content-Type': 'application/json', 'Idempotency-Key': agentRunRequestIdentity(input) }),
        body: serializeCreateAgentRunInput(input),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
      throw new Error(`Unable to reach the local ZLens notebook server. Check that it is still running, then retry.${detail}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw formatRequestError(res, text);
    }
    return streamAgentRunResponse(res, onMessage);
  },

  async listAgentRuns(input?: { limit?: number }): Promise<AgentRunListResponse> {
    const params = new URLSearchParams();
    if (typeof input?.limit === 'number' && Number.isFinite(input.limit)) {
      params.set('limit', String(input.limit));
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<AgentRunListResponse>(`/api/agent-runs${suffix}`);
  },

  async getAgentRun(id: string): Promise<AgentRun> {
    const state = await this.getAgentRunState(id);
    if (state.lifecycleState !== 'terminal') {
      throw new Error(`Agent run ${id} is still ${state.lifecycleState}.`);
    }
    return state.run;
  },

  async getAgentRunState(id: string): Promise<AgentRunStateResponse> {
    return request<AgentRunStateResponse>(`/api/agent-runs/${encodeURIComponent(id)}`);
  },

  /** OBS-005: compact local-only trace status. No trace payload is cached in the notebook store. */
  async getAskTraceStatus(): Promise<{ status: AskTraceStoreStatusV1 }> {
    return request<{ status: AskTraceStoreStatusV1 }>('/api/ask-traces/status');
  },

  async listAskTraces(input: AskTraceListQueryV1 = {}): Promise<AskTraceListResponseV1> {
    const params = new URLSearchParams();
    if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
      params.set('limit', String(Math.max(1, Math.min(100, Math.floor(input.limit)))));
    }
    if (input.cursor) params.set('cursor', input.cursor);
    if (input.status) params.set('status', input.status);
    if (input.mode) params.set('mode', input.mode);
    if (input.trustState) params.set('trustState', input.trustState);
    if (input.selectedTier) params.set('selectedTier', input.selectedTier);
    if (input.surface) params.set('surface', input.surface);
    if (input.recordingStatus) params.set('recordingStatus', input.recordingStatus);
    const suffix = params.size ? `?${params.toString()}` : '';
    return request<AskTraceListResponseV1>(`/api/ask-traces${suffix}`);
  },

  async getAskTraceByRun(runId: string): Promise<AskTraceDataV1> {
    return request<AskTraceDataV1>(`/api/ask-traces/by-run/${encodeURIComponent(runId)}`);
  },

  async getAskTrace(traceId: string): Promise<AskTraceDataV1> {
    return request<AskTraceDataV1>(`/api/ask-traces/${encodeURIComponent(traceId)}`);
  },

  async exportAskTrace(traceId: string): Promise<unknown> {
    return request<unknown>(`/api/ask-traces/${encodeURIComponent(traceId)}/export?profile=strict`);
  },

  async deriveAnalyticalRepair(id: string, repair: AnalyticalRepairRequest): Promise<AnalyticalRepairDerivationResponse> {
    return request<AnalyticalRepairDerivationResponse>(`/api/agent-runs/${encodeURIComponent(id)}/analytical-repair`, {
      method: 'POST',
      body: JSON.stringify({ repair }),
    });
  },

  async repairAgentRunExecution(id: string, threadId?: string): Promise<{ run: AgentRun }> {
    return request<{ run: AgentRun }>(`/api/agent-runs/${encodeURIComponent(id)}/repair-execution`, {
      method: 'POST',
      body: JSON.stringify({ threadId }),
    });
  },

  async repairNotebookCellExecution(
    cell: Cell,
    error: string,
    executionContext?: NotebookExecutionContext,
  ): Promise<NotebookRepairExecutionResponse> {
    const raw = await request<any>('/api/notebook/repair-execution', {
      method: 'POST',
      body: JSON.stringify({
        cell: {
          id: cell.id,
          type: cell.type,
          source: cell.content,
          title: cell.name,
          config: cell.chartConfig,
        },
        error,
        failure: cell.execution?.error,
        attemptedSql: cell.execution?.compiledSql ?? cell.content,
        executionTarget: cell.executionTarget,
        parameters: cell.blockBinding?.state === 'bound'
          ? cell.blockBinding.parameterValues
          : cell.dqlParameterValues,
        executionContext,
      }),
    });
    if (
      executionContext?.runId
      && typeof raw?.executionContext?.runId === 'string'
      && raw.executionContext.runId !== executionContext.runId
    ) {
      throw new DqlApiError({
        message: 'The notebook server returned a repair for a different cell run. The stale result was rejected.',
        status: 409,
        code: 'STALE_CELL_EXECUTION',
        details: { expected: executionContext, received: raw.executionContext },
      });
    }
    return {
      ok: true,
      source: String(raw.source ?? cell.content),
      repairedSql: String(raw.repairedSql ?? ''),
      repairMode: raw.repairMode === 'ai' ? 'ai' : 'deterministic',
      result: normalizeQueryResultPayload(raw.result),
      executionTarget: raw?.executionTarget?.target === 'local'
        ? { target: 'local' }
        : raw?.executionTarget?.target === 'connection'
          ? {
              target: 'connection',
              ...(typeof raw.executionTarget.connectionName === 'string'
                ? { connectionName: raw.executionTarget.connectionName }
                : {}),
            }
          : undefined,
      compiledSql: typeof raw?.compiledSql === 'string' ? raw.compiledSql : undefined,
      executedSql: typeof raw?.executedSql === 'string' ? raw.executedSql : undefined,
      executionReceipt: raw?.executionReceipt && typeof raw.executionReceipt === 'object'
        ? raw.executionReceipt as Record<string, unknown>
        : undefined,
    };
  },

  async cancelAgentRun(id: string): Promise<{ ok: boolean; id?: string }> {
    return request<{ ok: boolean; id?: string }>(`/api/agent-runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
  },

  async listAgentThreads(input?: { limit?: number; archived?: boolean; notebookPath?: string }): Promise<AgentConversationThreadListResponse> {
    const params = new URLSearchParams();
    if (typeof input?.limit === 'number' && Number.isFinite(input.limit)) {
      params.set('limit', String(input.limit));
    }
    if (input?.archived) params.set('archived', '1');
    if (input?.notebookPath) params.set('notebookPath', input.notebookPath);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return request<AgentConversationThreadListResponse>(`/api/agent/threads${suffix}`);
  },

  async createAgentThread(input: { surface?: string; title?: string; notebookPath?: string } = {}): Promise<AgentConversationThread> {
    const raw = await request<{ thread: AgentConversationThread }>('/api/agent/threads', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return raw.thread;
  },

  async getAgentThread(id: string): Promise<{
    thread: AgentConversationThread;
    turns: AgentConversationTurn[];
    runs: AgentRun[];
  }> {
    return request<{
      thread: AgentConversationThread;
      turns: AgentConversationTurn[];
      runs: AgentRun[];
    }>(`/api/agent/threads/${encodeURIComponent(id)}`);
  },

  /** Rename and/or pin a conversation. Neither changes its recency. */
  async updateAgentThread(
    id: string,
    patch: { title?: string; favorite?: boolean },
  ): Promise<{ thread: AgentConversationThread }> {
    return request<{ thread: AgentConversationThread }>(
      `/api/agent/threads/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
  },

  async archiveAgentThread(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/agent/threads/${encodeURIComponent(id)}/archive`, { method: 'POST' });
  },

  async deleteAgentThread(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/api/agent/threads/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /**
   * Stakeholder → analyst handoff: drop a review-required output into the analyst
   * notebook queue as a draft research run for them to build/certify.
   */
  async requestCertification(input: RequestCertificationInput): Promise<RequestCertificationResult> {
    return request<RequestCertificationResult>('/api/agent-runs/request-certification', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  /**
   * Spec 14 (part D) — who is drafting. Best-effort identity used to show
   * "drafting as <owner>" where drafts are created. Callers should not block
   * on it (fall back to nothing on failure).
   */
  async getIdentity(): Promise<{ owner: string }> {
    return request<{ owner: string }>('/api/identity');
  },

  /**
   * `assistAvailable` is the server's own answer to "can a model be asked?"
   * (a host's model or a usable provider), without revealing which keys it holds.
   */
  async getProviderSettings(): Promise<{ providers: ProviderSettings[]; assistAvailable?: boolean }> {
    try {
      return await request<{ providers: ProviderSettings[]; assistAvailable?: boolean }>('/api/settings/providers');
    } catch {
      return { providers: [] };
    }
  },

  /** Live install/login detection for subscription-CLI providers (Claude Code / Codex). */
  async getProviderCliStatus(): Promise<{ status: Partial<Record<ProviderSettingsId, ProviderCliStatus>> }> {
    try {
      return await request<{ status: Partial<Record<ProviderSettingsId, ProviderCliStatus>> }>('/api/settings/providers/cli-status');
    } catch {
      return { status: {} };
    }
  },

  async saveProviderSettings(input: {
    id: ProviderSettingsId;
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    reasoningEffort?: ReasoningEffortSetting;
  }): Promise<{ ok: boolean; providers: ProviderSettings[] }> {
    return request('/api/settings/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async startOAuth(provider: OAuthProviderId): Promise<OAuthStatus & { url: string }> {
    return request(`/api/auth/${provider}/start`, { method: 'POST' });
  },

  async getOAuthStatus(provider: OAuthProviderId): Promise<OAuthStatus> {
    return request(`/api/auth/${provider}/status`);
  },

  async signOutOAuth(provider: OAuthProviderId): Promise<OAuthStatus> {
    return request(`/api/auth/${provider}/signout`, { method: 'POST' });
  },

  async testProviderSettings(
    id: ProviderSettingsId,
    overrides?: { apiKey?: string; baseUrl?: string; model?: string },
  ): Promise<{ ok: boolean; message: string }> {
    // Never throw: a failed test is a normal result the UI shows inline.
    try {
      return await request<{ ok: boolean; message: string }>('/api/settings/providers/test', {
        method: 'POST',
        body: JSON.stringify({ id, ...overrides }),
      });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  async getRemoteMcpSettings(): Promise<{ settings: RemoteMcpSettings }> {
    try {
      return await request<{ settings: RemoteMcpSettings }>('/api/settings/mcp');
    } catch {
      return { settings: { path: '', entries: [], warnings: [] } };
    }
  },

  async saveRemoteMcpSettings(entries: RemoteMcpEntry[]): Promise<{ ok: boolean; settings: RemoteMcpSettings }> {
    return request('/api/settings/mcp', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    });
  },

  /**
   * Teach DQL from a wrong -> right SQL edit. Recorded as a git trace plus a
   * CANDIDATE hint; it only shapes other people's answers once approved in
   * Settings -> Agent learning.
   */
  async recordAgentCorrection(input: {
    question: string;
    correctedSql: string;
    wrongSql?: string;
    title?: string;
    guidance?: string;
    lesson?: Partial<AgentHintLesson>;
    rationale?: string;
    scope?: { metric?: string; dbtModel?: string; domain?: string; dialect?: string; term?: string; block?: string };
    tags?: string[];
    failedRoute?: string;
  }): Promise<{ ok: boolean; hint?: AgentHint; error?: string }> {
    return request('/api/agent/learnings/correction', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async listAgentHints(status?: AgentHintStatus): Promise<AgentHintListResponse> {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : '';
    return request<AgentHintListResponse>(`/api/agent/hints${suffix}`);
  },

  async reviewAgentHint(hintId: string, decision: 'approved' | 'rejected', note?: string): Promise<{ ok: boolean; hint?: AgentHint; error?: string }> {
    return request(`/api/agent/hints/${encodeURIComponent(hintId)}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    });
  },

  async updateAgentHint(
    hintId: string,
    input: Pick<AgentHint, 'title' | 'guidance' | 'correctedSql' | 'scope' | 'lesson'>,
  ): Promise<{ ok: boolean; hint?: AgentHint; error?: string }> {
    return request(`/api/agent/hints/${encodeURIComponent(hintId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  async transitionAgentHint(
    hintId: string,
    input: { action: 'retire' | 'reopen' | 'supersede'; targetHintId?: string; note?: string },
  ): Promise<{ ok: boolean; hint?: AgentHint; error?: string }> {
    return request(`/api/agent/hints/${encodeURIComponent(hintId)}/lifecycle`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async listAgentMemory(scope?: AgentMemory['scope']): Promise<{ memories: AgentMemory[] }> {
    const suffix = scope ? `?scope=${encodeURIComponent(scope)}` : '';
    try {
      return await request<{ memories: AgentMemory[] }>(`/api/agent/memory${suffix}`);
    } catch {
      return { memories: [] };
    }
  },

  async saveAgentMemory(input: Partial<AgentMemory> & Pick<AgentMemory, 'scope' | 'title' | 'content'>): Promise<{ ok: boolean; memory: AgentMemory }> {
    return request('/api/agent/memory', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async deleteAgentMemory(id: string): Promise<{ ok: boolean }> {
    return request(`/api/agent/memory?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async ensureAgentMemoryFiles(): Promise<{ ok: boolean; files: string[] }> {
    return request('/api/agent/memory/default-files', { method: 'POST' });
  },

  async listNotebooks(): Promise<NotebookFile[]> {
    try {
      return await request<NotebookFile[]>('/api/notebooks');
    } catch {
      // Return empty list gracefully when server is not running
      return [];
    }
  },

  async readNotebook(path: string): Promise<{ content: string }> {
    return request<{ content: string }>(
      `/api/notebook-content?path=${encodeURIComponent(path)}`
    );
  },

  /**
   * Deleting does not erase: the file moves to a recovery bundle the response
   * names, because a private draft or an uncommitted notebook exists nowhere
   * else.
   */
  async deleteNotebook(path: string): Promise<{
    ok: boolean;
    path?: string;
    error?: string;
    recovered?: { recoveryId: string; trashPath: string; files: string[] };
  }> {
    return request(`/api/notebooks?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  },

  /** Move a private draft into `notebooks/`, where git and the team can see it. */
  async publishNotebook(path: string): Promise<{
    ok: boolean;
    path?: string;
    previousPath?: string;
    visibility?: 'shared';
    error?: string;
  }> {
    return request('/api/notebooks/publish', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async createNotebook(
    name: string,
    template: string,
    context: {
      ownerDomain?: string;
      usesDomains?: string[];
      visibility?: 'private' | 'shared';
    } = {},
  ): Promise<{ path: string; content: string; visibility?: 'private' | 'shared' }> {
    return request<{ path: string; content: string; visibility?: 'private' | 'shared' }>('/api/notebooks', {
      method: 'POST',
      body: JSON.stringify({ name, template, ...context }),
    });
  },

  async createBlock(
    name: string,
    options?: {
      blockType?: 'custom' | 'semantic';
      domain?: string;
      description?: string;
      owner?: string;
      tags?: string[];
      folderPath?: string;
      visibility?: 'private' | 'shared';
    },
  ): Promise<{ path: string; content: string; visibility?: 'private' | 'shared' }> {
    return request<{ path: string; content: string; visibility?: 'private' | 'shared' }>('/api/blocks', {
      method: 'POST',
      body: JSON.stringify({ name, ...options }),
    });
  },

  /** Move a private block, and the companion YAML with it, into tracked source. */
  async publishBlock(path: string): Promise<{
    ok: boolean;
    path?: string;
    previousPath?: string;
    companionPath?: string | null;
    error?: string;
  }> {
    return request('/api/blocks/publish', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async getBlockLibrary(): Promise<{
    blocks: Array<{
      name: string; domain: string; status: string;
      owner: string | null; tags: string[]; path: string;
      lastModified: string; description: string;
      llmContext?: string | null;
      visibility?: 'private' | 'shared';
      replacedBy?: string;
      deprecatedOn?: string;
      replacement?: { name: string; path: string } | null;
    }>;
    /** Why the library could not be read; an empty library is not the same as a failed one. */
    error?: string;
  }> {
    try {
      return await request('/api/blocks/library');
    } catch (error) {
      return { blocks: [], error: error instanceof Error ? error.message : 'The block library could not be loaded.' };
    }
  },

  async getApps(): Promise<{
    apps: Array<{
      path: string;
      manifest: {
        name: string;
        domain: string;
        owner?: string;
        description?: string;
        cadence?: string;
        consumers?: string[];
        entryPoints?: string[];
      };
      notebooks: string[];
      dashboards: string[];
      hasDigest: boolean;
    }>;
  }> {
    try {
      return await request('/api/apps');
    } catch {
      return { apps: [] };
    }
  },

  async updateBlockStatus(path: string, newStatus: string): Promise<{ ok: boolean; status?: string; error?: string }> {
    return request('/api/blocks/status', {
      method: 'POST',
      body: JSON.stringify({ path, newStatus }),
    });
  },

  async getBlockHistory(path: string): Promise<BlockHistoryResult> {
    try {
      const result = await request<Partial<BlockHistoryResult>>(`/api/blocks/history?path=${encodeURIComponent(path)}`);
      return {
        entries: Array.isArray(result?.entries) ? result.entries : [],
        // An older server returned only `{ entries }`.
        status: result?.status ?? 'ok',
        ...(result?.message ? { message: result.message } : {}),
      };
    } catch (e) {
      return { entries: [], status: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  },

  async runBlockTests(source: string, path: string | null): Promise<{
    assertions: Array<{ field: string; operator: string; expected: string; passed: boolean; actual?: string }>;
    passed: number;
    failed: number;
    duration: number;
  }> {
    return request('/api/blocks/run-tests', {
      method: 'POST',
      body: JSON.stringify({ source, path }),
    });
  },

  async getBlockStudioCatalog(options: { includeSemantic?: boolean } = {}): Promise<BlockStudioCatalog> {
    const params = new URLSearchParams();
    if (options.includeSemantic === false) params.set('includeSemantic', 'false');
    const query = params.toString();
    return request<BlockStudioCatalog>(`/api/block-studio/catalog${query ? `?${query}` : ''}`);
  },

  async getBlockStudioDbtStatus(): Promise<BlockStudioDbtStatus> {
    return request<BlockStudioDbtStatus>('/api/block-studio/dbt-status');
  },

  async openBlockStudio(path: string): Promise<BlockStudioOpenPayload> {
    return request<BlockStudioOpenPayload>(`/api/block-studio/open?path=${encodeURIComponent(path)}`);
  },

  async getBlockBody(path: string): Promise<{ path: string; body: string; commitSha: string | null }> {
    return request<{ path: string; body: string; commitSha: string | null }>(
      `/api/blocks/body?path=${encodeURIComponent(path)}`,
    );
  },

  async validateBlockStudio(source: string, path?: string | null, signal?: AbortSignal): Promise<BlockStudioValidation> {
    return request<BlockStudioValidation>('/api/block-studio/validate', {
      method: 'POST',
      body: JSON.stringify({ source, path }),
      signal,
    });
  },

  async runBlockStudio(source: string, path?: string | null, parameters?: Record<string, unknown>): Promise<BlockStudioPreview> {
    return request<BlockStudioPreview>('/api/block-studio/run', {
      method: 'POST',
      body: JSON.stringify({ source, path, parameters }),
    });
  },

  async repairAndRunBlockStudio(
    source: string,
    error: string,
    parameters: Record<string, unknown> = {},
    title?: string,
  ): Promise<BlockStudioRepairExecutionResponse> {
    const raw = await request<any>('/api/block-studio/repair-and-run', {
      method: 'POST',
      body: JSON.stringify({
        cell: {
          id: 'block-studio-draft',
          type: 'dql',
          source,
          title: title || 'Block Studio draft',
        },
        error,
        attemptedSql: source,
        parameters,
      }),
    });
    const repairedSql = String(raw.repairedSql ?? '');
    return {
      source: String(raw.source ?? source),
      repairedSql,
      repairMode: raw.repairMode === 'ai' ? 'ai' : 'deterministic',
      preview: {
        sql: repairedSql,
        result: normalizeQueryResultPayload(raw.result),
      },
    };
  },

  async getCertifiedBlockParameters(blockName: string): Promise<{
    blockName: string;
    blockPath: string;
    parameters: BlockParameterDefinition[];
  }> {
    return request(`/api/blocks/parameters?name=${encodeURIComponent(blockName)}`);
  },

  async invokeCertifiedBlock(blockName: string, parameters: Record<string, unknown>, question?: string): Promise<CertifiedBlockInvocationResponse> {
    const raw = await request<any>('/api/blocks/invoke', {
      method: 'POST',
      body: JSON.stringify({ blockName, parameters, question }),
    });
    return {
      parameters: Array.isArray(raw?.parameters) ? raw.parameters : [],
      result: {
        ...normalizeQueryResultPayload(raw?.result),
        ...(typeof raw?.result?.sql === 'string' ? { sql: raw.result.sql } : {}),
        ...(typeof raw?.result?.blockName === 'string' ? { blockName: raw.result.blockName } : {}),
        ...(typeof raw?.result?.blockPath === 'string' ? { blockPath: raw.result.blockPath } : {}),
        ...(raw?.result?.chartConfig ? { chartConfig: raw.result.chartConfig } : {}),
        ...(Array.isArray(raw?.result?.parameters) ? { parameters: raw.result.parameters } : {}),
        ...(typeof raw?.result?.auditId === 'string' ? { auditId: raw.result.auditId } : {}),
      },
    };
  },

  /**
   * Promote a result column into a runtime filter input. The SQL edit is done
   * on the server, where a real dialect parser can decide where the predicate
   * may safely go.
   */
  async addDqlArtifactResultFilter(
    artifact: DqlArtifactReference,
    resultColumns: string[],
    column: string,
    value: unknown,
    executionTarget?: ExecutionTarget,
  ): Promise<{ artifact: DqlArtifactReference; parameterName: string }> {
    const raw = await request<any>('/api/dql/artifacts/add-filter', {
      method: 'POST',
      body: JSON.stringify({ artifact, resultColumns, column, value, executionTarget }),
    });
    const normalized = normalizeDqlArtifactReference(raw?.artifact);
    if (!normalized) throw new Error('Adding the filter input returned an invalid artifact contract.');
    return { artifact: normalized, parameterName: String(raw?.parameterName ?? column) };
  },

  async invokeDqlArtifact(
    artifact: DqlArtifactReference,
    parameters: Record<string, unknown>,
    question?: string,
    blockName?: string,
    executionTarget?: ExecutionTarget,
  ): Promise<DqlArtifactInvocationResponse> {
    const raw = await request<any>('/api/dql/artifacts/execute', {
      method: 'POST',
      body: JSON.stringify({ artifact, parameters, question, blockName, executionTarget }),
    });
    const normalizedArtifact = normalizeDqlArtifactReference(raw?.artifact);
    if (!normalizedArtifact) throw new Error('DQL artifact execution returned an invalid artifact contract.');
    return {
      artifact: normalizedArtifact,
      parameters: normalizedArtifact.parameters ?? [],
      result: {
        ...normalizeQueryResultPayload(raw?.result),
        ...(typeof raw?.result?.sql === 'string' ? { sql: raw.result.sql } : {}),
        ...(typeof raw?.result?.blockName === 'string' ? { blockName: raw.result.blockName } : {}),
        ...(typeof raw?.result?.blockPath === 'string' ? { blockPath: raw.result.blockPath } : {}),
        ...(raw?.result?.chartConfig ? { chartConfig: raw.result.chartConfig } : {}),
        ...(Array.isArray(raw?.result?.parameters) ? { parameters: raw.result.parameters } : {}),
        ...(typeof raw?.result?.auditId === 'string' ? { auditId: raw.result.auditId } : {}),
      },
    };
  },

  /**
   * Compose the SEMANTIC block form for a question, when the governed catalog can
   * express it as {metrics} x {dimensions}. Returns ok:false when it cannot, so
   * the caller falls back to the answer's own SQL-backed artifact.
   */
  async composeSemanticBlock(question: string): Promise<
    | { ok: true; source: string; sql?: string; metrics: string[]; dimensions: string[] }
    | { ok: false; reason?: string }
  > {
    return request('/api/block-studio/compose-semantic', {
      method: 'POST',
      body: JSON.stringify({ question }),
    });
  },

  async saveBlockStudio(payload: {
    path?: string | null;
    source: string;
    metadata: {
      name: string;
      domain: string;
      folderPath?: string;
      description: string;
      owner: string;
      tags: string[];
      sourceKind?: string;
      sourcePath?: string;
      importId?: string;
      candidateId?: string;
      lineage?: string[];
    };
  }): Promise<BlockStudioOpenPayload> {
    return request<BlockStudioOpenPayload>('/api/block-studio/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async saveAgentBlockDraft(payload: {
    source: string;
    name: string;
    domain?: string;
    description?: string;
    tags?: string[];
    runId?: string;
    /** The answer's SQL and result column names (never rows), so the server can pre-fill certification metadata. */
    sql?: string;
    columns?: string[];
  }): Promise<BlockStudioOpenPayload & { prefill?: { suggested: unknown[]; unknown: string[]; identityGap?: { labels: string[]; key?: string; message: string } } }> {
    return request('/api/block-studio/agent-drafts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async deleteBlockStudio(path: string): Promise<{
    ok: boolean;
    path: string;
    companionPath: string | null;
    lineageRefresh?: { status: 'queued' | 'ready' | 'failed'; operationId?: string; compiledAt?: string; message?: string };
  }> {
    return request(`/api/block-studio/block?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
  },

  async previewBlockStudioImport(payload: {
    path: string;
    sourceKind?: 'raw-sql' | BlockStudioImportCandidate['sourceKind'];
    inputMode?: 'path' | 'paste' | 'upload';
    sources?: Array<{ path: string; content: string }>;
    domain?: string;
    owner?: string;
    tags?: string[];
  }): Promise<BlockStudioImportSession> {
    return request<BlockStudioImportSession>('/api/block-studio/import/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async listBlockStudioImports(): Promise<{ sessions: BlockStudioImportSessionSummary[] }> {
    return request<{ sessions: BlockStudioImportSessionSummary[] }>('/api/block-studio/imports');
  },

    async createBlockStudioImport(payload: {
      path?: string;
      sourceKind?: 'raw-sql' | BlockStudioImportCandidate['sourceKind'];
    inputMode?: 'path' | 'paste' | 'upload';
    sources?: Array<{ path: string; content: string }>;
    domain?: string;
    owner?: string;
    tags?: string[];
  }): Promise<BlockStudioImportSession> {
    return request<BlockStudioImportSession>('/api/block-studio/imports', {
      method: 'POST',
      body: JSON.stringify(payload),
      });
    },

    async createDqlGenerationSession(payload: {
      path?: string;
      sourceKind?: 'raw-sql' | BlockStudioImportCandidate['sourceKind'];
      inputMode?: 'path' | 'paste' | 'upload';
      sources?: Array<{ path: string; content: string }>;
      domain?: string;
      owner?: string;
      tags?: string[];
      provider?: string;
      async?: boolean;
      persistence?: 'session-only' | 'draft-files';
    }): Promise<DqlGenerationSession> {
      return request<DqlGenerationSession>('/api/block-studio/ai-imports', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    async getDqlGenerationSession(importId: string): Promise<DqlGenerationSession> {
      return request<DqlGenerationSession>(`/api/block-studio/ai-imports/${encodeURIComponent(importId)}`);
    },

  async getBlockStudioImport(importId: string): Promise<BlockStudioImportSession> {
    return request<BlockStudioImportSession>(`/api/block-studio/imports/${encodeURIComponent(importId)}`);
  },

  async deleteBlockStudioImport(importId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}`,
      { method: 'DELETE' },
    );
  },

  async clearBlockStudioImports(): Promise<{ ok: boolean; removed: number }> {
    return request<{ ok: boolean; removed: number }>('/api/block-studio/imports', { method: 'DELETE' });
  },

    async updateBlockStudioImportCandidate(
      importId: string,
      candidateId: string,
      patch: Partial<Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'terms' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'dimensions' | 'allowedFilters' | 'parameterPolicy' | 'filterBindings' | 'sourceSystems' | 'replacementFor' | 'reviewCadence' | 'sql' | 'reviewStatus' | 'llmContext'>>,
    ): Promise<BlockStudioImportCandidate> {
    return request<BlockStudioImportCandidate>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
    },

    async updateDqlGenerationCandidate(
      importId: string,
      candidateId: string,
      patch: Partial<Pick<DqlGenerationCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'terms' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'dimensions' | 'allowedFilters' | 'parameterPolicy' | 'filterBindings' | 'sourceSystems' | 'replacementFor' | 'reviewCadence' | 'sql' | 'llmContext'>>,
    ): Promise<DqlGenerationCandidate> {
      return request<DqlGenerationCandidate>(
        `/api/block-studio/ai-imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      );
    },

    async matchSqlForBlockReuse(sql: string, options?: { sourcePath?: string; name?: string; domain?: string; owner?: string }): Promise<{
      parameterDecisions: DqlGenerationCandidate['parameterDecisions'];
      parameterPolicy: DqlGenerationCandidate['parameterPolicy'];
      filterBindings: DqlGenerationCandidate['filterBindings'];
      allowedFilters: string[];
      parameterizedSql: string;
      similarityMatches: DqlGenerationCandidate['similarityMatches'];
      recommendedAction: DqlGenerationCandidate['recommendedAction'];
    }> {
      return request('/api/block-studio/match-sql', {
        method: 'POST',
        body: JSON.stringify({ sql, ...(options ?? {}) }),
      });
    },

    async previewDqlGenerationCandidate(importId: string, candidateId: string): Promise<DqlGenerationCandidate> {
      return request<DqlGenerationCandidate>(
        `/api/block-studio/ai-imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/preview`,
        { method: 'POST' },
      );
    },

    async certifyDqlGenerationCandidate(importId: string, candidateId: string): Promise<{ candidate: DqlGenerationCandidate; block: BlockStudioOpenPayload }> {
      return request<{ candidate: DqlGenerationCandidate; block: BlockStudioOpenPayload }>(
        `/api/block-studio/ai-imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/certify`,
        { method: 'POST' },
      );
    },

    async saveSelectedDqlGenerationCandidates(
      importId: string,
      payload: { candidateIds: string[]; owner: string },
    ): Promise<{
      ok: boolean;
      session: DqlGenerationSession;
      results: Array<{
        candidateId: string;
        path?: string;
        status: 'certified' | 'draft' | 'error';
        blockers: string[];
        candidate?: DqlGenerationCandidate;
        block?: BlockStudioOpenPayload;
        error?: string;
      }>;
    }> {
      return request(
        `/api/block-studio/ai-imports/${encodeURIComponent(importId)}/save-selected`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
    },

  async runBlockStudioImportCandidate(importId: string, candidateId: string): Promise<BlockStudioImportCandidate> {
    return request<BlockStudioImportCandidate>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/run`,
      { method: 'POST' },
    );
  },

  async saveBlockStudioImportCandidate(importId: string, candidateId: string): Promise<{ candidate: BlockStudioImportCandidate; block: BlockStudioOpenPayload }> {
    return request<{ candidate: BlockStudioImportCandidate; block: BlockStudioOpenPayload }>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/save`,
      { method: 'POST' },
    );
  },

  async saveAllBlockStudioImportCandidates(importId: string): Promise<{
    ok: boolean;
    session: BlockStudioImportSession;
    saved: Array<{ candidateId: string; path: string }>;
    errors: Array<{ candidateId: string; error: string }>;
  }> {
    return request(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/save-all`,
      { method: 'POST' },
    );
  },

    async assistBlockStudioImportCandidate(importId: string, candidateId: string, action: string): Promise<BlockStudioImportCandidate> {
    return request<BlockStudioImportCandidate>(
      `/api/block-studio/imports/${encodeURIComponent(importId)}/candidates/${encodeURIComponent(candidateId)}/ai-assist`,
      { method: 'POST', body: JSON.stringify({ action }) },
    );
    },

    async getSemanticLayerDiagnostics(): Promise<SemanticLayerDiagnostics> {
      return request<SemanticLayerDiagnostics>('/api/semantic-layer/diagnostics');
    },

  async reloadSemanticLayer(): Promise<{ ok: boolean; available: boolean; provider: string | null; errors: string[]; lastSyncTime?: string | null; dbt: BlockStudioDbtStatus }> {
    return request('/api/semantic-layer/reload', { method: 'POST' });
  },

  async assessBlockStudioCertification(source: string): Promise<BlockStudioCertificationAssessment> {
    return request<BlockStudioCertificationAssessment>('/api/block-studio/certification-check', {
      method: 'POST',
      body: JSON.stringify({ source }),
    });
  },

  async certifyBlockStudio(payload: { source: string; path?: string | null }): Promise<{
    ok: boolean;
    status?: string;
    path?: string | null;
    source?: string;
    metadata?: BlockStudioOpenPayload['metadata'];
    companionPath?: string | null;
    validation?: BlockStudioValidation;
    certification: {
      certified: boolean;
      errors: Array<{ rule: string; message: string }>;
      warnings: Array<{ rule: string; message: string }>;
    };
    checklist: {
      metadata: boolean;
      validation: boolean;
      run: boolean;
      tests: boolean;
      chart: boolean;
      lineage: boolean;
      aiReviewed: boolean;
      blockers: string[];
      issues?: BlockStudioDiagnostic[];
      checkedAt?: string;
    };
    blockers?: string[];
  }> {
    const res = await fetch(`${BASE}/api/block-studio/certify`, {
      headers: withServerAuthorization({ 'Content-Type': 'application/json' }),
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({ ok: false, error: res.statusText }));
    if (!res.ok && res.status !== 422) {
      throw new Error(JSON.stringify(body));
    }
    return body;
  },

  async saveAsBlock(payload: {
    cellId: string;
    notebookPath?: string | null;
    name: string;
    domain?: string;
    owner?: string;
    content: string;
    description?: string;
    tags?: string[];
    metricRefs?: string[];
    template?: string;
    llmContext?: string;
    examples?: Array<{ question: string; sql?: string }>;
    invariants?: string[];
    reviewRequired?: boolean;
    datasetRefs?: Cell["datasetRefs"];
    lineage?: Record<string, unknown>;
  }): Promise<{
    path: string;
    content: string;
    status: 'certified' | 'draft';
    blockers: string[];
    certification?: { certified: boolean; errors: unknown[]; warnings: unknown[] };
  }> {
    return request<{
      path: string;
      content: string;
      status: 'certified' | 'draft';
      blockers: string[];
      certification?: { certified: boolean; errors: unknown[]; warnings: unknown[] };
    }>('/api/blocks/save-from-cell', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getBlockTemplates(): Promise<Array<{ id: string; name: string; description: string; content: string }>> {
    try {
      const response = await request<{ templates: Array<{ id: string; name: string; description: string; content: string }> }>(
        '/api/blocks/templates',
      );
      return response.templates;
    } catch {
      return [];
    }
  },

  async listBlocks(domain?: string): Promise<NotebookFile[]> {
    try {
      const files = await request<NotebookFile[]>('/api/notebooks');
      return files.filter((file) => file.type === 'block' && (!domain || file.path.startsWith(`blocks/${domain}/`)));
    } catch {
      return [];
    }
  },

  async saveNotebook(path: string, content: string): Promise<void> {
    return request<void>('/api/notebook-content', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    });
  },

  async executeQuery(
    sql: string,
    signal?: AbortSignal,
    executionContext?: NotebookExecutionContext,
    executionTarget?: Cell["executionTarget"],
  ): Promise<NotebookQueryExecutionResult> {
    const raw = await request<any>("/api/query", {
      method: "POST",
      body: JSON.stringify({ sql, executionContext, executionTarget }),
      signal,
    });
    if (
      executionContext?.runId
      && typeof raw?.executionContext?.runId === 'string'
      && raw.executionContext.runId !== executionContext.runId
    ) {
      throw new DqlApiError({
        message: 'The notebook server returned a result for a different cell run. The stale result was rejected.',
        status: 409,
        code: 'STALE_CELL_EXECUTION',
        details: { expected: executionContext, received: raw.executionContext },
      });
    }
    return {
      ...normalizeQueryResultPayload(raw),
      executionTarget: raw?.executionTarget?.target === 'local'
        ? { target: 'local' }
        : raw?.executionTarget?.target === 'connection'
          ? {
              target: 'connection',
              ...(typeof raw.executionTarget.connectionName === 'string'
                ? { connectionName: raw.executionTarget.connectionName }
                : {}),
            }
          : undefined,
      compiledSql: typeof raw?.compiledSql === 'string' ? raw.compiledSql : undefined,
      executedSql: typeof raw?.executedSql === 'string' ? raw.executedSql : undefined,
      targetBinding: raw?.targetBinding && typeof raw.targetBinding === 'object' ? raw.targetBinding : undefined,
      executionReceipt: raw?.executionReceipt && typeof raw.executionReceipt === 'object' ? raw.executionReceipt : undefined,
    };
  },

  async previewGeneratedSql(sql: string, signal?: AbortSignal): Promise<{ ok: true; result: QueryResult } | { ok: false; error: string }> {
    try {
      const raw = await request<any>('/api/ai/sql-draft/preview', {
        method: 'POST',
        body: JSON.stringify({ sql }),
        signal,
      });
      return { ok: true, result: normalizeQueryResultPayload(raw.result) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async executeNotebookCell(cell: Cell, signal?: AbortSignal, executionContext?: NotebookExecutionContext): Promise<NotebookCellExecutionResponse> {
    const raw = await request<any>('/api/notebook/execute', {
      method: 'POST',
      body: JSON.stringify({
        cell: {
          id: cell.id,
          type: cell.type,
          source: cell.content,
          title: cell.name,
          config: cell.chartConfig,
        },
        executionTarget: cell.executionTarget,
      parameters: cell.blockBinding?.state === 'bound'
        ? cell.blockBinding.parameterValues
        : cell.dqlParameterValues,
        executionContext,
      }),
      signal,
    });
    if (
      executionContext?.runId
      && typeof raw?.executionContext?.runId === 'string'
      && raw.executionContext.runId !== executionContext.runId
    ) {
      throw new DqlApiError({
        message: 'The notebook server returned a result for a different semantic cell run. The stale result was rejected.',
        status: 409,
        code: 'STALE_CELL_EXECUTION',
        details: { expected: executionContext, received: raw.executionContext },
      });
    }
    return {
      cellType: String(raw?.cellType ?? cell.type),
      cellId: typeof raw?.executionContext?.cellId === 'string' ? raw.executionContext.cellId : undefined,
      runId: typeof raw?.executionContext?.runId === 'string' ? raw.executionContext.runId : undefined,
      title: typeof raw?.title === 'string' ? raw.title : undefined,
      blockName: typeof raw?.blockName === 'string' ? raw.blockName : undefined,
      blockPath: typeof raw?.blockPath === 'string' ? raw.blockPath : undefined,
      chartConfig: raw?.chartConfig && typeof raw.chartConfig === 'object' ? raw.chartConfig : undefined,
      tests: Array.isArray(raw?.tests) ? raw.tests : undefined,
      result: raw?.result ? normalizeQueryResultPayload(raw.result) : null,
      executionTarget: raw?.executionTarget?.target === 'local'
        ? { target: 'local' }
        : raw?.executionTarget?.target === 'connection'
          ? {
              target: 'connection',
              ...(typeof raw.executionTarget.connectionName === 'string'
                ? { connectionName: raw.executionTarget.connectionName }
                : {}),
            }
          : undefined,
      engine: raw?.engine === 'native' || raw?.engine === 'metricflow-cli' || raw?.engine === 'dbt-cloud'
        ? raw.engine
        : undefined,
      semanticTrace: raw?.semanticTrace && typeof raw.semanticTrace === 'object'
        ? raw.semanticTrace as SemanticRuntimeTrace
        : undefined,
      compiledSql: typeof raw?.compiledSql === 'string' ? raw.compiledSql : undefined,
      executedSql: typeof raw?.executedSql === 'string' ? raw.executedSql : undefined,
      targetBinding: raw?.targetBinding && typeof raw.targetBinding === 'object' ? raw.targetBinding : undefined,
      executionReceipt: raw?.executionReceipt && typeof raw.executionReceipt === 'object' ? raw.executionReceipt : undefined,
    };
  },

  async getDatasets(): Promise<{
    datasets: DatasetSource[];
    workspace?: { target: "local"; databasePath: string };
  }> {
    return request("/api/datasets");
  },

  async importDataset(input: {
    filename?: string;
    sourcePath?: string;
    contentBase64?: string;
    file?: File;
    storageMode?: "local" | "project";
    link?: boolean;
    name?: string;
    alias?: string;
    description?: string;
    owner?: string;
    tags?: string[];
  }): Promise<{ dataset: DatasetSource; duplicate: boolean }> {
    if (input.file) {
      const form = new FormData();
      form.set("file", input.file, input.file.name);
      for (const [key, value] of Object.entries(input)) {
        if (key === "file" || value === undefined) continue;
        form.set(key, Array.isArray(value) ? value.join(",") : String(value));
      }
      const response = await fetch(`${BASE}/api/datasets/import`, {
        method: "POST",
        headers: withServerAuthorization(),
        body: form,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw formatRequestError(response, text);
      }
      return response.json() as Promise<{
        dataset: DatasetSource;
        duplicate: boolean;
      }>;
    }
    return request("/api/datasets/import", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async refreshDataset(id: string): Promise<{ dataset: DatasetSource }> {
    return request(`/api/datasets/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
    });
  },

  async updateDatasetSchema(
    id: string,
    overrides: Record<string, string>,
  ): Promise<{ dataset: DatasetSource }> {
    return request(`/api/datasets/${encodeURIComponent(id)}/schema`, {
      method: "POST",
      body: JSON.stringify({ overrides }),
    });
  },

  async renameDataset(
    id: string,
    name: string,
    alias?: string,
  ): Promise<{ dataset: DatasetSource }> {
    return request(`/api/datasets/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      body: JSON.stringify({ name, alias }),
    });
  },

  async pinDataset(
    id: string,
    pinned = true,
  ): Promise<{ dataset: DatasetSource }> {
    return request(`/api/datasets/${encodeURIComponent(id)}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned }),
    });
  },

  async removeDataset(id: string): Promise<void> {
    await request(`/api/datasets/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  async stageDataset(input: {
    sql: string;
    connectionName?: string;
    name?: string;
    confirmed: boolean;
    blockPath?: string;
    filters?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  }): Promise<{
    dataset: DatasetSource;
    trustLabel: "review_required";
    limits: Record<string, number>;
  }> {
    return request("/api/datasets/stage", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  async listNotebookResearch(
    input?:
      | string
      | {
          path?: string;
          sourceCellId?: string;
          domain?: string;
          owner?: string;
          intent?: NotebookResearchIntent;
          search?: string;
          status?: NotebookResearchStatus;
          reviewStatus?: NotebookResearchReviewStatus;
          promotionAction?: NotebookResearchDqlPromotionAction;
          readiness?: NotebookResearchReadinessFilter;
          age?: NotebookResearchAgeFilter;
          nextAction?: NotebookResearchNextActionFilter;
          activeOnly?: boolean;
          sort?: NotebookResearchSort;
          limit?: number;
          offset?: number;
        },
  ): Promise<NotebookResearchListResponse> {
    const params = new URLSearchParams();
    if (typeof input === 'string') {
      if (input) params.set('path', input);
    } else if (input) {
      if (input.path) params.set('path', input.path);
      if (input.sourceCellId) params.set('sourceCellId', input.sourceCellId);
      if (input.domain) params.set('domain', input.domain);
      if (input.owner) params.set('owner', input.owner);
      if (input.intent) params.set('intent', input.intent);
      if (input.search) params.set('q', input.search);
      if (input.status) params.set('status', input.status);
      if (input.reviewStatus) params.set('reviewStatus', input.reviewStatus);
      if (input.promotionAction) params.set('promotionAction', input.promotionAction);
      if (input.readiness) params.set('readiness', input.readiness);
      if (input.age) params.set('age', input.age);
      if (input.nextAction) params.set('nextAction', input.nextAction);
      if (input.activeOnly) params.set('activeOnly', 'true');
      if (input.sort) params.set('sort', input.sort);
      if (typeof input.limit === 'number') params.set('limit', String(input.limit));
      if (typeof input.offset === 'number') params.set('offset', String(input.offset));
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const raw = await request<NotebookResearchListResponse>(`/api/notebook/research${suffix}`);
    return {
      runs: raw.runs.map(normalizeNotebookResearchRun),
      total: typeof raw.total === 'number' ? raw.total : raw.runs.length,
      domains: Array.isArray(raw.domains)
        ? raw.domains.map((item) => ({
            domain: typeof item.domain === 'string' && item.domain.trim() ? item.domain : 'uncategorized',
            total: typeof item.total === 'number' ? item.total : 0,
            draftReady: typeof item.draftReady === 'number' ? item.draftReady : 0,
            certificationReady: typeof item.certificationReady === 'number' ? item.certificationReady : 0,
            blocked: typeof item.blocked === 'number' ? item.blocked : 0,
            staleOpen: typeof item.staleOpen === 'number' ? item.staleOpen : 0,
            expiredOpen: typeof item.expiredOpen === 'number' ? item.expiredOpen : 0,
            nextAction: normalizeNotebookResearchNextAction(item.nextAction),
            nextActionCount: typeof item.nextActionCount === 'number' && Number.isFinite(item.nextActionCount)
              ? Math.max(0, Math.floor(item.nextActionCount))
              : undefined,
          }))
        : [],
      owners: Array.isArray(raw.owners)
        ? raw.owners.map((item) => ({
            owner: typeof item.owner === 'string' && item.owner.trim() ? item.owner : 'unassigned',
            total: typeof item.total === 'number' ? item.total : 0,
            draftReady: typeof item.draftReady === 'number' ? item.draftReady : 0,
            certificationReady: typeof item.certificationReady === 'number' ? item.certificationReady : 0,
            blocked: typeof item.blocked === 'number' ? item.blocked : 0,
            staleOpen: typeof item.staleOpen === 'number' ? item.staleOpen : 0,
            expiredOpen: typeof item.expiredOpen === 'number' ? item.expiredOpen : 0,
            nextAction: normalizeNotebookResearchNextAction(item.nextAction),
            nextActionCount: typeof item.nextActionCount === 'number' && Number.isFinite(item.nextActionCount)
              ? Math.max(0, Math.floor(item.nextActionCount))
              : undefined,
          }))
        : [],
      intents: Array.isArray(raw.intents)
        ? raw.intents.map((item) => ({
            intent: normalizeNotebookResearchIntent(item.intent),
            total: typeof item.total === 'number' ? item.total : 0,
            draftReady: typeof item.draftReady === 'number' ? item.draftReady : 0,
            certificationReady: typeof item.certificationReady === 'number' ? item.certificationReady : 0,
            blocked: typeof item.blocked === 'number' ? item.blocked : 0,
            staleOpen: typeof item.staleOpen === 'number' ? item.staleOpen : 0,
            expiredOpen: typeof item.expiredOpen === 'number' ? item.expiredOpen : 0,
            nextAction: normalizeNotebookResearchNextAction(item.nextAction),
            nextActionCount: typeof item.nextActionCount === 'number' && Number.isFinite(item.nextActionCount)
              ? Math.max(0, Math.floor(item.nextActionCount))
              : undefined,
          }))
        : [],
      notebooks: Array.isArray(raw.notebooks)
        ? raw.notebooks.map((item) => ({
            path: typeof item.path === 'string' && item.path.trim() ? item.path : 'notebooks/untitled.dqlnb',
            title: typeof item.title === 'string' && item.title.trim() ? item.title : notebookTitleFromPath(item.path),
            total: typeof item.total === 'number' ? item.total : 0,
            draftReady: typeof item.draftReady === 'number' ? item.draftReady : 0,
            certificationReady: typeof item.certificationReady === 'number' ? item.certificationReady : 0,
            blocked: typeof item.blocked === 'number' ? item.blocked : 0,
            staleOpen: typeof item.staleOpen === 'number' ? item.staleOpen : 0,
            expiredOpen: typeof item.expiredOpen === 'number' ? item.expiredOpen : 0,
            nextAction: normalizeNotebookResearchNextAction(item.nextAction),
            nextActionCount: typeof item.nextActionCount === 'number' && Number.isFinite(item.nextActionCount)
              ? Math.max(0, Math.floor(item.nextActionCount))
              : undefined,
          }))
        : [],
      counts: {
        total: typeof raw.counts?.total === 'number' ? raw.counts.total : raw.runs.length,
        ready: typeof raw.counts?.ready === 'number' ? raw.counts.ready : 0,
        needsReview: typeof raw.counts?.needsReview === 'number' ? raw.counts.needsReview : 0,
        dqlDrafts: typeof raw.counts?.dqlDrafts === 'number' ? raw.counts.dqlDrafts : 0,
        errors: typeof raw.counts?.errors === 'number' ? raw.counts.errors : 0,
        reuseExisting: typeof raw.counts?.reuseExisting === 'number' ? raw.counts.reuseExisting : 0,
        extendExisting: typeof raw.counts?.extendExisting === 'number' ? raw.counts.extendExisting : 0,
        replacements: typeof raw.counts?.replacements === 'number' ? raw.counts.replacements : 0,
        createNew: typeof raw.counts?.createNew === 'number' ? raw.counts.createNew : 0,
        draftReady: typeof raw.counts?.draftReady === 'number' ? raw.counts.draftReady : 0,
        certificationReady: typeof raw.counts?.certificationReady === 'number' ? raw.counts.certificationReady : 0,
        blocked: typeof raw.counts?.blocked === 'number' ? raw.counts.blocked : 0,
        staleOpen: typeof raw.counts?.staleOpen === 'number' ? raw.counts.staleOpen : 0,
        expiredOpen: typeof raw.counts?.expiredOpen === 'number' ? raw.counts.expiredOpen : 0,
        sourceLinked: typeof raw.counts?.sourceLinked === 'number' ? raw.counts.sourceLinked : 0,
        nextActions: normalizeNotebookResearchNextActionCounts(raw.counts?.nextActions),
      },
      groupCounts: {
        domains: typeof raw.groupCounts?.domains === 'number' && Number.isFinite(raw.groupCounts.domains)
          ? Math.max(0, Math.floor(raw.groupCounts.domains))
          : (Array.isArray(raw.domains) ? raw.domains.length : 0),
        owners: typeof raw.groupCounts?.owners === 'number' && Number.isFinite(raw.groupCounts.owners)
          ? Math.max(0, Math.floor(raw.groupCounts.owners))
          : (Array.isArray(raw.owners) ? raw.owners.length : 0),
        intents: typeof raw.groupCounts?.intents === 'number' && Number.isFinite(raw.groupCounts.intents)
          ? Math.max(0, Math.floor(raw.groupCounts.intents))
          : (Array.isArray(raw.intents) ? raw.intents.length : 0),
        notebooks: typeof raw.groupCounts?.notebooks === 'number' && Number.isFinite(raw.groupCounts.notebooks)
          ? Math.max(0, Math.floor(raw.groupCounts.notebooks))
          : (Array.isArray(raw.notebooks) ? raw.notebooks.length : 0),
      },
      reviewMetrics: normalizeNotebookResearchReviewMetrics(raw.reviewMetrics),
      limit: raw.limit,
      offset: typeof raw.offset === 'number' ? raw.offset : 0,
    };
  },

  async getNotebookResearchDiagnostics(): Promise<NotebookResearchDiagnostics> {
    const raw = await request<NotebookResearchDiagnostics>('/api/notebook/research/diagnostics');
    return normalizeNotebookResearchDiagnostics(raw);
  },

  async createNotebookResearch(input: {
    notebookPath: string;
    domain?: string;
    owner?: string;
    sourceCell?: NotebookResearchSourceCellPayload;
    sourceCellId?: string;
    sourceCellName?: string;
    sourceCellFingerprint?: string;
    title?: string;
    question: string;
    intent?: NotebookResearchIntent;
    context?: unknown;
    generatedSql?: string;
    reviewedSql?: string;
    dqlArtifact?: AgentConversationDqlArtifact;
    run?: boolean;
  }): Promise<NotebookResearchRun> {
    const raw = await request<{ run: NotebookResearchRun }>('/api/notebook/research', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return normalizeNotebookResearchRun(raw.run);
  },

  async seedNotebookResearchFromCells(input: {
    notebookPath: string;
    domain?: string;
    owner?: string;
    notebookTitle?: string;
	    cells: Array<{
	      sourceCell?: NotebookResearchSourceCellPayload;
	      id?: string;
	      sourceCellId?: string;
	      name?: string;
	      sourceCellName?: string;
	      type?: string;
	      sql?: string;
	      content?: string;
	      source?: string;
	      sourceCellFingerprint?: string;
      question?: string;
      intent?: NotebookResearchIntent;
    }>;
  }): Promise<NotebookResearchSeedCellsResponse> {
    const raw = await request<NotebookResearchSeedCellsResponse>('/api/notebook/research/seed-cells', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return {
      created: Array.isArray(raw.created) ? raw.created.map(normalizeNotebookResearchRun) : [],
      createdCount: typeof raw.createdCount === 'number' ? raw.createdCount : Array.isArray(raw.created) ? raw.created.length : 0,
      skippedCount: typeof raw.skippedCount === 'number' ? raw.skippedCount : 0,
      limitApplied: raw.limitApplied === true,
    };
  },

  async listNotebookResearchSourceCoverage(input: {
    path: string;
    sourceCellIds: string[];
    sourceCells?: NotebookResearchSourceCellPayload[];
    limit?: number;
  }): Promise<NotebookResearchSourceCoverageResponse> {
    const raw = await request<NotebookResearchSourceCoverageResponse>('/api/notebook/research/source-coverage', {
      method: 'POST',
      body: JSON.stringify({
        path: input.path,
        sourceCellIds: input.sourceCellIds,
        sourceCells: input.sourceCells,
        limit: input.limit,
      }),
    });
    return {
      runs: Array.isArray(raw.runs) ? raw.runs.map(normalizeNotebookResearchRun) : [],
      requestedCount: typeof raw.requestedCount === 'number' ? raw.requestedCount : input.sourceCellIds.length,
      matchedCount: typeof raw.matchedCount === 'number' ? raw.matchedCount : Array.isArray(raw.runs) ? raw.runs.length : 0,
      limitApplied: raw.limitApplied === true,
    };
  },

  async previewNotebookResearchContext(input: {
    notebookPath: string;
    domain?: string;
    sourceCell?: NotebookResearchSourceCellPayload;
    sourceCellId?: string;
    sourceCellName?: string;
    question: string;
    intent?: NotebookResearchIntent;
    context?: unknown;
  }): Promise<NotebookResearchContextPreview> {
    const raw = await request<NotebookResearchContextPreview>('/api/notebook/research/context-preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return normalizeNotebookResearchContextPreview(raw);
  },

  async getNotebookResearch(id: string): Promise<NotebookResearchRun> {
    const raw = await request<{ run: NotebookResearchRun }>(`/api/notebook/research/${encodeURIComponent(id)}`);
    return normalizeNotebookResearchRun(raw.run);
  },

  async updateNotebookResearch(id: string, input: NotebookResearchUpdateInput): Promise<NotebookResearchRun> {
    const raw = await request<{ run: NotebookResearchRun }>(`/api/notebook/research/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    return normalizeNotebookResearchRun(raw.run);
  },

  async runNotebookResearch(id: string, input?: Partial<Pick<
    NotebookResearchRun,
    'domain' | 'owner' | 'sourceCellFingerprint' | 'question' | 'intent' | 'context' | 'generatedSql' | 'reviewedSql' | 'dqlArtifact'
  >>): Promise<NotebookResearchRun> {
    const raw = await request<{ run: NotebookResearchRun }>(`/api/notebook/research/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    });
    return normalizeNotebookResearchRun(raw.run);
  },

  async checkNotebookResearchReuse(id: string, input?: { domain?: string; owner?: string }): Promise<NotebookResearchReuseCheckResponse> {
    const raw = await request<NotebookResearchReuseCheckResponse>(
      `/api/notebook/research/${encodeURIComponent(id)}/reuse-check`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    );
    return {
      ...raw,
      run: normalizeNotebookResearchRun(raw.run),
      promotion: normalizeNotebookDqlPromotion(raw.promotion) ?? raw.promotion,
    };
  },

  async promoteNotebookResearchToDql(id: string, input?: { domain?: string; owner?: string; tags?: string[]; provider?: string }): Promise<{
    run: NotebookResearchRun;
    session: DqlGenerationSession;
  }> {
    const raw = await request<{ run: NotebookResearchRun; session: DqlGenerationSession }>(
      `/api/notebook/research/${encodeURIComponent(id)}/promote-dql`,
      {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      },
    );
    return { ...raw, run: normalizeNotebookResearchRun(raw.run) };
  },

  async getSchema(): Promise<SchemaTable[]> {
    try {
      const res = await fetch(`${BASE}/api/schema`, {
        headers: withServerAuthorization(),
      });
      if (res.ok) {
        return (await res.json()) as SchemaTable[];
      }
      // Server returns 500 with { error, fallback } when introspection fails.
      const body = (await res.json().catch(() => null)) as
        | { error?: string; fallback?: SchemaTable[] }
        | null;
      if (body?.error) {
        console.warn(`[zlens] schema introspection failed: ${body.error}`);
      }
      return body?.fallback ?? [];
    } catch (err) {
      console.warn('[zlens] getSchema request failed', err);
      return [];
    }
  },

  async getConnections(): Promise<ConnectionsResponse> {
    try {
      return await request<ConnectionsResponse>('/api/connections');
    } catch {
      return { default: 'unknown', connections: {} };
    }
  },

  async previewDbtProfiles(path: string): Promise<{ dbtProfiles: DbtProfileConnectionCandidate[] }> {
    return request<{ dbtProfiles: DbtProfileConnectionCandidate[] }>('/api/connections/dbt-profiles/preview', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async saveConnections(
    connections: Record<string, unknown>,
    defaultConnectionName?: string,
    /** New name → old name, so a renamed connection keeps its saved secrets. */
    renames?: Record<string, string>,
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/connections', {
      method: 'PUT',
      body: JSON.stringify({ connections, defaultConnectionName, ...(renames ? { renames } : {}) }),
    });
  },

  async previewConnectionMetadataScope(
    connectionId: string,
    input: ConnectionMetadataScopeInput = {},
  ): Promise<{ scope: ConnectionMetadataScopeV1; status: WarehouseMetadataStatus; warehouseCatalog?: WarehouseCatalogSummary }> {
    return request(`/api/connections/${encodeURIComponent(connectionId)}/metadata-scope/preview`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async discoverConnectionMetadataScopes(
    connectionId: string,
  ): Promise<WarehouseMetadataDiscovery> {
    return request(`/api/connections/${encodeURIComponent(connectionId)}/metadata-scope/discovery`, {
      method: 'POST',
    });
  },

  async getConnectionMetadataScope(
    connectionId: string,
  ): Promise<{ scope: ConnectionMetadataScopeV1; status: WarehouseMetadataStatus; warehouseCatalog?: WarehouseCatalogSummary }> {
    return request(`/api/connections/${encodeURIComponent(connectionId)}/metadata-scope`);
  },

  async applyConnectionMetadataScope(
    connectionId: string,
    input: ConnectionMetadataScopeInput,
  ): Promise<{ scope: ConnectionMetadataScopeV1; status: WarehouseMetadataStatus; warehouseCatalog?: WarehouseCatalogSummary }> {
    return request(`/api/connections/${encodeURIComponent(connectionId)}/metadata-scope`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  async refreshConnectionMetadata(
    connectionId: string,
  ): Promise<{ scope: ConnectionMetadataScopeV1; status: WarehouseMetadataStatus; warehouseCatalog?: WarehouseCatalogSummary }> {
    return request(`/api/connections/${encodeURIComponent(connectionId)}/metadata-sync`, {
      method: 'POST',
    });
  },

  async installConnector(driver: string): Promise<{
    ok: boolean;
    status?: {
      driver: 'duckdb' | 'snowflake' | 'databricks';
      label: string;
      packageName?: string;
      packageSpec?: string;
      installed: boolean;
      builtIn: boolean;
      installPath: string;
      installCommand?: string;
    };
    connectorStatus?: Array<{
      driver: 'duckdb' | 'snowflake' | 'databricks';
      label: string;
      packageName?: string;
      packageSpec?: string;
      installed: boolean;
      builtIn: boolean;
      installPath: string;
      installCommand?: string;
    }>;
    error?: string;
  }> {
    return request('/api/connectors/install', {
      method: 'POST',
      body: JSON.stringify({ driver }),
    });
  },

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      return await request<{ ok: boolean; message: string }>('/api/test-connection', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    } catch (e: any) {
      return { ok: false, message: e.message ?? 'Connection failed' };
    }
  },

  async getSemanticRuntimeSettings(): Promise<SemanticRuntimeSettingsResponse> {
    return request<SemanticRuntimeSettingsResponse>('/api/semantic-runtime');
  },

  async getMetricFlowInstallerStatus(): Promise<MetricFlowInstallerStatus> {
    return request<MetricFlowInstallerStatus>('/api/semantic-runtime/metricflow/installer');
  },

  async installMetricFlow(adapter?: MetricFlowWarehouseAdapter): Promise<{ ok: boolean; job: MetricFlowInstallJob }> {
    return request<{ ok: boolean; job: MetricFlowInstallJob }>('/api/semantic-runtime/metricflow/install', {
      method: 'POST',
      body: JSON.stringify(adapter ? { adapter } : {}),
    });
  },

  async testDbtCloudSemanticRuntime(payload: SemanticRuntimeSettingsInput): Promise<{ ok: boolean; message?: string; dialect?: string; metricCount?: number; error?: string }> {
    try {
      return await request<{ ok: boolean; message?: string; dialect?: string; metricCount?: number; error?: string }>('/api/semantic-runtime/dbt-cloud/test', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (error: any) {
      return { ok: false, error: error?.message ?? 'dbt Cloud Semantic Layer test failed.' };
    }
  },

  async applyDbtCloudSemanticRuntime(payload: SemanticRuntimeSettingsInput): Promise<SemanticRuntimeSettingsResponse & { ok: boolean }> {
    return request<SemanticRuntimeSettingsResponse & { ok: boolean }>('/api/semantic-runtime/dbt-cloud/apply', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  /** Persist the runtime preference alone (no dbt Cloud test needed). */
  async setSemanticRuntimePreference(preference: 'auto' | 'native' | 'metricflow-cli' | 'dbt-cloud'): Promise<SemanticRuntimeSettingsResponse & { ok: boolean }> {
    return request<SemanticRuntimeSettingsResponse & { ok: boolean }>('/api/semantic-runtime/preference', {
      method: 'POST',
      body: JSON.stringify({ preference }),
    });
  },

  async getSemanticLayer(): Promise<Omit<SemanticLayerState, 'loading'>> {
    try {
      return await request<Omit<SemanticLayerState, 'loading'>>('/api/semantic-layer');
    } catch {
      return {
        available: false,
        provider: null,
        metrics: [],
        measures: [],
        dimensions: [],
        timeDimensions: [],
        entities: [],
        hierarchies: [],
        semanticModels: [],
        savedQueries: [],
        domains: [],
        tags: [],
        favorites: [],
        recentlyUsed: [],
        lastSyncTime: null,
      };
    }
  },

  async getSemanticTree(): Promise<SemanticTreeNode> {
    const result = await request<{ tree: SemanticTreeNode }>('/api/semantic-layer/tree');
    return result.tree;
  },

  async getSemanticObject(id: string): Promise<SemanticObjectDetail> {
    return request<SemanticObjectDetail>(`/api/semantic-layer/object/${encodeURIComponent(id)}`);
  },

  async getSetupLaunch(): Promise<SetupLaunchResponse> {
    return request<SetupLaunchResponse>('/api/onboarding/launch');
  },

  async acknowledgeSetupLaunch(): Promise<{ requestId: string; version: string; acknowledged: true }> {
    return request('/api/onboarding/acknowledge', { method: 'POST', body: '{}' });
  },

  async getOnboardingStatus(): Promise<DbtOnboardingStatusResponse> {
    return request<DbtOnboardingStatusResponse>('/api/onboarding/status');
  },

  /** Guided Setup progress (design D7): where a restart resumes. Null when setup has not started or was finished. */
  async getSetupProgress(): Promise<SetupProgress | null> {
    const response = await request<{ progress: SetupProgress | null }>('/api/onboarding/progress');
    return response.progress ?? null;
  },

  async saveSetupProgress(progress: Omit<SetupProgress, 'version' | 'updatedAt'>): Promise<SetupProgress> {
    const response = await request<{ progress: SetupProgress }>('/api/onboarding/progress', { method: 'PUT', body: JSON.stringify(progress) });
    return response.progress;
  },

  async previewDbtOnboarding(payload: DbtOnboardingPreviewRequest): Promise<DbtOnboardingPreviewResponse> {
    return request<DbtOnboardingPreviewResponse>('/api/onboarding/dbt/preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async applyDbtOnboarding(payload: DbtOnboardingPreviewRequest & {
    expectedFingerprint?: string;
    buildArtifacts?: boolean;
  }): Promise<DbtOnboardingApplyResponse> {
    return request<DbtOnboardingApplyResponse>('/api/onboarding/dbt/apply', {
      method: 'POST',
      // `fingerprint` keeps compatibility with the first local-runtime
      // implementation; `expectedFingerprint` is the normative API name.
      body: JSON.stringify({ ...payload, fingerprint: payload.expectedFingerprint }),
    });
  },

  async refreshDbtOnboarding(payload: {
    expectedFingerprint?: string;
    buildArtifacts?: boolean;
  } = {}): Promise<DbtOnboardingApplyResponse> {
    return request<DbtOnboardingApplyResponse>('/api/onboarding/refresh', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async getOnboardingJob(jobId: string): Promise<DbtOnboardingJobResponse> {
    return request<DbtOnboardingJobResponse>(`/api/onboarding/jobs/${encodeURIComponent(jobId)}`);
  },

  async cancelOnboardingJob(jobId: string): Promise<void> {
    return request<void>(`/api/onboarding/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  },

  async discoverOnboardingDomains(payload: {
    snapshotId?: string;
    useAi?: boolean;
  } = {}): Promise<DomainDiscoveryResponse> {
    return request<DomainDiscoveryResponse>('/api/onboarding/domains/discover', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async applyOnboardingDomains(payload: {
    proposals: DomainDiscoveryProposal[];
    expectedSourceFingerprint?: string;
    mode?: 'preview' | 'apply';
  }): Promise<DomainDiscoveryApplyResponse> {
    return request<DomainDiscoveryApplyResponse>('/api/onboarding/domains/apply', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async importSemanticLayer(payload: {
    provider: 'dbt' | 'cubejs' | 'snowflake';
    projectPath?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    connection?: string;
  }): Promise<any> {
    return request<any>('/api/semantic-layer/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async syncSemanticLayer(): Promise<any> {
    return request<any>('/api/semantic-layer/sync', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async previewSemanticImport(payload: {
    provider: 'dbt' | 'cubejs' | 'snowflake';
    projectPath?: string;
    repoUrl?: string;
    branch?: string;
    subPath?: string;
    connection?: string;
  }): Promise<{
    provider: string;
    counts: Record<string, number>;
    domains: string[];
    warnings: string[];
    objects: Array<{ kind: string; name: string; label: string; domain: string }>;
  }> {
    return request('/api/semantic-layer/import-preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async previewSyncDiff(): Promise<{
    added: Array<{ kind: string; name: string; label: string; domain: string }>;
    removed: Array<{ kind: string; name: string; label: string; domain: string }>;
    changed: Array<{ kind: string; name: string; label: string; domain: string }>;
    unchanged: number;
  }> {
    return request('/api/semantic-layer/sync-preview', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  async searchSemanticLayer(params: {
    query?: string;
    domain?: string;
    tag?: string;
    type?: 'metric' | 'measure' | 'dimension' | 'time_dimension' | 'entity' | 'hierarchy' | 'semantic_model' | 'saved_query';
  }): Promise<{
    metrics: SemanticMetric[];
    measures: SemanticMeasure[];
    dimensions: SemanticDimension[];
    timeDimensions: SemanticDimension[];
    entities: SemanticEntity[];
    hierarchies: SemanticHierarchy[];
    semanticModels: SemanticModel[];
    savedQueries: SemanticSavedQuery[];
  }> {
    const search = new URLSearchParams();
    if (params.query) search.set('q', params.query);
    if (params.domain) search.set('domain', params.domain);
    if (params.tag) search.set('tag', params.tag);
    if (params.type) search.set('type', params.type);
    try {
      return await request<{
        metrics: SemanticMetric[];
        measures: SemanticMeasure[];
        dimensions: SemanticDimension[];
        timeDimensions: SemanticDimension[];
        entities: SemanticEntity[];
        hierarchies: SemanticHierarchy[];
        semanticModels: SemanticModel[];
        savedQueries: SemanticSavedQuery[];
      }>(
        `/api/semantic-layer/search?${search.toString()}`,
      );
    } catch {
      return { metrics: [], measures: [], dimensions: [], timeDimensions: [], entities: [], hierarchies: [], semanticModels: [], savedQueries: [] };
    }
  },

  async getFavorites(): Promise<string[]> {
    try {
      const result = await request<{ favorites: string[] }>('/api/user-prefs/favorites');
      return result.favorites;
    } catch {
      return [];
    }
  },

  async toggleFavorite(name: string): Promise<string[]> {
    const result = await request<{ favorites: string[] }>('/api/user-prefs/favorites', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return result.favorites;
  },

  async getRecentlyUsed(): Promise<string[]> {
    try {
      const result = await request<{ recentlyUsed: string[] }>('/api/user-prefs/recent');
      return result.recentlyUsed;
    } catch {
      return [];
    }
  },

  async trackUsage(name: string): Promise<string[]> {
    try {
      const result = await request<{ recentlyUsed: string[] }>('/api/user-prefs/recent', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      return result.recentlyUsed;
    } catch {
      return [];
    }
  },

  async getCompatibleDimensions(metrics: string[]): Promise<SemanticDimension[]> {
    const search = new URLSearchParams();
    if (metrics.length > 0) search.set('metrics', metrics.join(','));
    try {
      const result = await request<{ dimensions: SemanticDimension[] }>(
        `/api/semantic-layer/compatible-dims?${search.toString()}`,
      );
      return result.dimensions;
    } catch {
      return [];
    }
  },

  /**
   * Full compatibility result including engine, qualified names, real grains,
   * and incompatibility reasons. Unlike getCompatibleDimensions, this THROWS on
   * failure so the UI can render an explicit error state instead of graying
   * every dimension with no explanation.
   */
  async getCompatibility(metrics: string[]): Promise<SemanticCompatibility> {
    const search = new URLSearchParams();
    if (metrics.length > 0) search.set('metrics', metrics.join(','));
    const result = await request<SemanticCompatibility>(
      `/api/semantic-layer/compatible-dims?${search.toString()}`,
    );
    return {
      dimensions: result.dimensions ?? [],
      engine: result.engine ?? 'native',
      incompatible: result.incompatible ?? [],
      degraded: result.degraded ?? null,
    };
  },

  async composeQuery(
    metrics: string[],
    dimensions: string[],
    timeDimension?: { name: string; granularity: string },
  ): Promise<{ sql: string } | { error: string }> {
    try {
      return await request<{ sql: string }>('/api/semantic-query', {
        method: 'POST',
        body: JSON.stringify({ metrics, dimensions, timeDimension }),
      });
    } catch (e: any) {
      return { error: e.message ?? 'Failed to compose query' };
    }
  },

  async previewSemanticBuilder(payload: {
    metrics: string[];
    dimensions: string[];
    executionTarget?: ExecutionTarget;
    filters?: Array<{ dimension: string; operator: string; values: string[] }>;
    timeDimension?: { name: string; granularity: string };
    orderBy?: Array<{ name: string; direction: 'asc' | 'desc' }>;
    limit?: number;
  }): Promise<{
    sql: string;
    joins: string[];
    tables: string[];
    result: QueryResult;
    engine?: 'native' | 'metricflow-cli' | 'dbt-cloud';
    effectiveRequest?: Record<string, unknown>;
    runtimeRequest?: Record<string, unknown>;
    semanticTrace?: SemanticRuntimeTrace;
    executedSql?: string;
    targetBinding?: Record<string, unknown>;
    executionReceipt?: Record<string, unknown>;
  } | {
    error: string;
    code?: string;
    details?: {
      authoringReference?: string;
      runtimeReference?: string;
      candidates?: SemanticRuntimePathCandidate[];
      semanticTrace?: SemanticRuntimeTrace;
    };
  }> {
    try {
      return await request<{
        sql: string;
        joins: string[];
        tables: string[];
        result: QueryResult;
        engine?: 'native' | 'metricflow-cli' | 'dbt-cloud';
        effectiveRequest?: Record<string, unknown>;
        runtimeRequest?: Record<string, unknown>;
        semanticTrace?: SemanticRuntimeTrace;
        executedSql?: string;
        targetBinding?: Record<string, unknown>;
        executionReceipt?: Record<string, unknown>;
      }>('/api/semantic-builder/preview', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (error instanceof DqlApiError) {
        return {
          error: error.message,
          code: error.code,
          details: error.details as {
            authoringReference?: string;
            runtimeReference?: string;
            candidates?: SemanticRuntimePathCandidate[];
            semanticTrace?: SemanticRuntimeTrace;
          } | undefined,
        };
      }
      return { error: error instanceof Error ? error.message : 'Failed to preview semantic block' };
    }
  },

  async saveSemanticBuilder(payload: {
    name: string;
    domain?: string;
    description?: string;
    owner?: string;
    tags?: string[];
    metrics: string[];
    dimensions: string[];
    filters?: Array<{ dimension: string; operator: string; values: string[] }>;
    timeDimension?: { name: string; granularity: string };
    chart?: string;
    blockType?: 'semantic' | 'custom';
  }): Promise<{ path: string; content: string; companionPath: string }> {
    return request<{ path: string; content: string; companionPath: string }>('/api/semantic-builder/save', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async createMetric(metric: {
    name: string;
    label: string;
    description: string;
    domain: string;
    sql: string;
    type: string;
    table: string;
    tags?: string[];
    /** Refuse to replace an existing metric of the same name. */
    ifAbsent?: boolean;
  }): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      return await request<{ ok: boolean; path: string }>('/api/semantic-layer/metric', {
        method: 'POST',
        body: JSON.stringify(metric),
      });
    } catch (e: any) {
      return { ok: false, error: e.message ?? 'Failed to create metric' };
    }
  },

  async describeTable(tablePath: string): Promise<SchemaColumn[]> {
    // Preserve the dbt relation exactly. The server parses quoted three-part
    // identifiers safely and performs one relation-level column lookup.
    const params = new URLSearchParams({ relation: tablePath });
    try {
      return await request<SchemaColumn[]>(`/api/describe-table?${params.toString()}`);
    } catch {
      return [];
    }
  },

  async fetchLineage(): Promise<{ nodes: any[]; edges: any[] }> {
    try {
      return await request<{ nodes: any[]; edges: any[] }>('/api/lineage');
    } catch {
      return { nodes: [], edges: [] };
    }
  },

  async searchLineage(query: string): Promise<{ matches: Array<{ node: any; score: number }> }> {
    try {
      return await request<{ matches: Array<{ node: any; score: number }> }>(
        `/api/lineage/search?q=${encodeURIComponent(query)}`,
      );
    } catch {
      return { matches: [] };
    }
  },

  async queryLineage(params: {
    focus?: string;
    search?: string;
    types?: string[];
    domain?: string;
    upstreamDepth?: number;
    downstreamDepth?: number;
  }): Promise<{ graph: { nodes: any[]; edges: any[] }; focalNode?: any; matches?: Array<{ node: any; score: number }> }> {
    const searchParams = new URLSearchParams();
    if (params.focus) searchParams.set('focus', params.focus);
    if (params.search) searchParams.set('search', params.search);
    if (params.types?.length) searchParams.set('types', params.types.join(','));
    if (params.domain) searchParams.set('domain', params.domain);
    if (params.upstreamDepth !== undefined) searchParams.set('upstreamDepth', String(params.upstreamDepth));
    if (params.downstreamDepth !== undefined) searchParams.set('downstreamDepth', String(params.downstreamDepth));
    try {
      return await request<{ graph: { nodes: any[]; edges: any[] }; focalNode?: any; matches?: Array<{ node: any; score: number }> }>(
        `/api/lineage/query?${searchParams.toString()}`,
      );
    } catch {
      return { graph: { nodes: [], edges: [] }, matches: [] };
    }
  },

  async fetchLineageNode(nodeId: string): Promise<{ node: any; incoming: any[]; outgoing: any[] } | null> {
    try {
      return await request<{ node: any; incoming: any[]; outgoing: any[] }>(
        `/api/lineage/node/${encodeURIComponent(nodeId)}`,
      );
    } catch {
      return null;
    }
  },

  async fetchBusiness360(nodeId: string): Promise<Business360ResultV2 | null> {
    try {
      return await request<Business360ResultV2>(
        `/api/lineage/business-360/${encodeURIComponent(nodeId)}`,
      );
    } catch {
      return null;
    }
  },

  async fetchBlockLineage(blockName: string): Promise<{ node: any; ancestors: any[]; descendants: any[] } | null> {
    try {
      return await request<{ node: any; ancestors: any[]; descendants: any[] }>(
        `/api/lineage/block/${encodeURIComponent(blockName)}`,
      );
    } catch {
      return null;
    }
  },

  async fetchImpactAnalysis(blockName: string): Promise<any> {
    try {
      return await request<any>(`/api/lineage/impact/${encodeURIComponent(blockName)}`);
    } catch {
      return null;
    }
  },

  async fetchLineagePaths(
    nodeId: string,
    options?: { maxDepth?: number; maxPaths?: number },
  ): Promise<{
    focalNode: any;
    upstreamPaths: Array<{ nodes: any[]; edges: any[]; layers: string[] }>;
    downstreamPaths: Array<{ nodes: any[]; edges: any[]; layers: string[] }>;
    layerSummary: Record<string, number>;
  } | null> {
    try {
      const params = new URLSearchParams();
      if (options?.maxDepth) params.set('maxDepth', String(options.maxDepth));
      if (options?.maxPaths) params.set('maxPaths', String(options.maxPaths));
      const qs = params.toString();
      const url = `/api/lineage/paths/${encodeURIComponent(nodeId)}${qs ? `?${qs}` : ''}`;
      return await request<any>(url);
    } catch {
      return null;
    }
  },

  /**
   * Throws on transport/server errors. `inRepo: false` only ever comes from the
   * server's own not-a-repository answer, so a 500 or auth failure is never
   * shown as "Not a git repository".
   */
  async fetchGitStatus(): Promise<{
    inRepo: boolean;
    branch: string | null;
    ahead: number;
    behind: number;
    changes: Array<{ path: string; status: string }>;
    projectPrefix?: string;
    /** The branch reviews merge into: the remote's default branch. */
    baseBranch?: string;
    /** Whether the remote already has the base branch (an empty repository has none). */
    baseOnRemote?: boolean;
    /** The remote branch ahead/behind are counted against. */
    upstream?: string | null;
    /** origin is a ZLens sample repository. */
    sampleRemote?: boolean;
  }> {
    return request<any>('/api/git/status');
  },

  async fetchGitLog(limit = 20): Promise<{
    inRepo: boolean;
    commits: Array<{ hash: string; author: string; date: string; subject: string }>;
  }> {
    try {
      return await request<any>(`/api/git/log?limit=${limit}`);
    } catch {
      return { inRepo: false, commits: [] };
    }
  },

  async fetchRunSnapshot(path: string): Promise<{ found: boolean; snapshot: RunSnapshot | null }> {
    try {
      return await request<any>(`/api/run-snapshot?path=${encodeURIComponent(path)}`);
    } catch {
      return { found: false, snapshot: null };
    }
  },

  async saveRunSnapshot(path: string, snapshot: RunSnapshot): Promise<void> {
    await request<void>('/api/run-snapshot', {
      method: 'PUT',
      body: JSON.stringify({ path, snapshot }),
    });
  },

  async fetchGitDiff(path?: string, staged?: boolean): Promise<{
    inRepo: boolean;
    diff: string;
    before: string | null;
    after: string | null;
    diffReport: DiffReport | null;
  }> {
    try {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      if (staged) params.set('staged', 'true');
      const qs = params.toString();
      return await request<any>(`/api/git/diff${qs ? `?${qs}` : ''}`);
    } catch {
      return { inRepo: false, diff: '', before: null, after: null, diffReport: null };
    }
  },

  async fetchGitBranches(): Promise<{ inRepo: boolean; current: string | null; branches: string[] }> {
    try {
      return await request<any>('/api/git/branches');
    } catch {
      return { inRepo: false, current: null, branches: [] };
    }
  },

  /** Throws on transport/server errors (see fetchGitStatus). */
  async fetchGitRemote(): Promise<{ inRepo: boolean; url: string | null; name: string | null }> {
    return request<any>('/api/git/remote');
  },

  /** `git init` for a project that is not inside a repository yet. The server refuses an existing repository. */
  async gitInit(): Promise<GitWriteResult & { status?: { inRepo: boolean; branch: string | null } }> {
    try {
      return await request<any>('/api/git/init', { method: 'POST', body: '{}' });
    } catch (e) {
      return gitWriteFailure(e);
    }
  },

  /** Save a remote URL (`git remote add`, or `set-url` with `replace`). Never contacts the remote. */
  async gitAddRemote(payload: { url: string; name?: string; replace?: boolean }): Promise<GitWriteResult & {
    name?: string; url?: string | null; replaced?: boolean;
  }> {
    try {
      return await request<any>('/api/git/remote', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      return gitWriteFailure(e);
    }
  },

  async fetchGitGovernedContext(): Promise<{
    inRepo: boolean;
    trackingReady: boolean;
    legacyBroadIgnore: boolean;
    domains: GitGovernedContextGroup;
    skills: GitGovernedContextGroup;
    artifacts: GitGovernedContextGroup;
    learning: GitGovernedContextGroup;
  }> {
    try {
      return await request('/api/git/governed-context');
    } catch {
      return {
        inRepo: false,
        trackingReady: false,
        legacyBroadIgnore: false,
        domains: emptyGitGovernedContextGroup(),
        skills: emptyGitGovernedContextGroup(),
        artifacts: emptyGitGovernedContextGroup(),
        learning: emptyGitGovernedContextGroup(),
      };
    }
  },

  async enableGitGovernedContextTracking(): Promise<{ ok: boolean; changed?: boolean; error?: string }> {
    try {
      return await request('/api/git/governed-context/enable', { method: 'POST', body: '{}' });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitStage(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/stage', { method: 'POST', body: JSON.stringify({ paths }) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitUnstage(paths: string[]): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/unstage', { method: 'POST', body: JSON.stringify({ paths }) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** Untracked files are moved to a recovery bundle rather than deleted. */
  async gitDiscard(paths: string[]): Promise<{
    ok: boolean;
    error?: string;
    reverted?: string[];
    recovered?: { recoveryId: string; trashPath: string; files: string[] };
    skipped?: string[];
  }> {
    try {
      return await request<any>('/api/git/discard', { method: 'POST', body: JSON.stringify({ paths }) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** Pass the exact paths to keep. `stageAll` stages this project's folder only. */
  async gitCommit(
    message: string,
    options: { stageAll?: boolean; paths?: string[] } = {},
  ): Promise<{ ok: boolean; error?: string; hash?: string }> {
    try {
      return await request<any>('/api/git/commit', {
        method: 'POST',
        body: JSON.stringify({ message, ...options }),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** `code: 'no_remote'` means the project needs a remote before anything can be sent. */
  async gitPush(): Promise<GitWriteResult & { output?: string }> {
    try {
      return await request<any>('/api/git/push', { method: 'POST', body: '{}' });
    } catch (e) {
      return gitWriteFailure(e);
    }
  },

  /** Background check: fetch only. Never touches branches or files. */
  async gitFetch(): Promise<GitWriteResult> {
    try {
      return await request<any>('/api/git/fetch', { method: 'POST', body: '{}' });
    } catch (e) {
      return gitWriteFailure(e);
    }
  },

  /** Send unsent commits from the base branch to a new branch, leaving the base branch as the remote has it. */
  async gitSendAsBranch(name?: string): Promise<GitWriteResult & { branch?: string; base?: string; sent?: number; subject?: string; prUrl?: string }> {
    try {
      return await request<any>('/api/git/send-as-branch', { method: 'POST', body: JSON.stringify(name ? { name } : {}) });
    } catch (e) {
      return gitWriteFailure(e);
    }
  },

  /** Keep the current origin (the ZLens sample) as upstream and make your repository origin. */
  async gitConnectOwnRemote(url: string): Promise<GitWriteResult & { url?: string; previous?: string }> {
    try {
      return await request<any>('/api/git/remote/connect-own', { method: 'POST', body: JSON.stringify({ url }) });
    } catch (e) {
      return gitWriteFailure(e);
    }
  },

  async fetchGitUpdateState(): Promise<GitUpdateState> {
    return request<GitUpdateState>('/api/git/update/state');
  },

  async fetchGitConflictVersions(path: string): Promise<{ ok: boolean; error?: string; mine?: string | null; theirs?: string | null }> {
    try {
      return await request<any>(`/api/git/update/versions?path=${encodeURIComponent(path)}`);
    } catch (e) {
      return gitWriteFailure(e);
    }
  },

  async gitUpdateStep(step: 'resolve' | 'continue' | 'cancel' | 'undo', body: { path?: string; keep?: 'mine' | 'theirs' } = {}): Promise<GitUpdateResult> {
    try {
      return await request<any>(`/api/git/update/${step}`, { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      return gitWriteFailure(e);
    }
  },

  async gitPull(): Promise<GitUpdateResult> {
    try {
      return await request<any>('/api/git/pull', { method: 'POST', body: '{}' });
    } catch (e) {
      return gitWriteFailure(e);
    }
  },

  async gitCreateBranch(name: string, checkout = true): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/branch', {
        method: 'POST',
        body: JSON.stringify({ name, checkout }),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** Create a review branch, commit only the selected files, push it, and open a PR. Never merges. */
  async gitCreateReview(payload: { paths: string[]; title: string; body?: string; base?: string }): Promise<{
    ok: boolean; error?: string; base?: string; branch?: string; hash?: string; prUrl?: string; warning?: string;
  }> {
    try {
      return await request<any>('/api/git/review', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** Open a PR after the guided flow has already committed and pushed its review branch. */
  async gitOpenReview(payload: { title: string; body?: string; base?: string }): Promise<{
    ok: boolean; error?: string; base?: string; branch?: string; prUrl?: string; warning?: string;
  }> {
    try {
      return await request<any>('/api/git/review/open', { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async gitCheckout(name: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request<any>('/api/git/checkout', {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  // ── Apps & Dashboards ───────────────────────────────────────────────────

  async listApps(): Promise<AppSummary[]> {
    try {
      const { apps } = await request<{ apps: AppSummary[] }>('/api/apps');
      return apps;
    } catch {
      return [];
    }
  },

  /** Like listApps but throws on failure, so callers can tell "no apps" from "load failed". */
  async listAppsStrict(): Promise<AppSummary[]> {
    const { apps } = await request<{ apps: AppSummary[] }>('/api/apps');
    return apps;
  },

  async recommendAppBlocks(input: {
    domain?: string;
    tags?: string[];
    purpose?: string;
    audience?: string;
    certifiedOnly?: boolean;
  }, signal?: AbortSignal): Promise<AppBlockRecommendation[]> {
    const { blocks } = await request<{ blocks: AppBlockRecommendation[] }>('/api/apps/recommend-blocks', {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    });
    return blocks;
  },

  async listAppSourceCandidates(id: string, input: {
    query?: string;
    cursor?: string;
    limit?: number;
    lifecycles?: string[];
    domains?: string[];
    includeDeprecated?: boolean;
  } = {}, signal?: AbortSignal): Promise<AppSourceCandidatePage> {
    const params = new URLSearchParams();
    if (input.query?.trim()) params.set('q', input.query.trim());
    if (input.cursor) params.set('cursor', input.cursor);
    params.set('limit', String(input.limit ?? 50));
    for (const lifecycle of input.lifecycles ?? []) params.append('lifecycle', lifecycle);
    for (const domain of input.domains ?? []) params.append('domain', domain);
    if (input.includeDeprecated) params.set('includeDeprecated', 'true');
    const response = await request<Omit<AppSourceCandidatePage, 'items'> & { ok: true; items: AppSourceCandidateWire[] }>(
      `/api/app-builds/${encodeURIComponent(id)}/source-candidates?${params.toString()}`,
      { signal },
    );
    return { ...response, items: response.items.map(appSourceCandidateToRecommendation) };
  },

  /**
   * Exact, current catalog resolution for an already-pinned App source. A
   * review-required card may be read so Studio can show an explicit policy
   * choice; read access alone never grants preview or publication authority.
   */
  async resolveAppSourceCandidates(id: string, sourceIds: string[], options: { includeReviewRequired?: boolean } = {}): Promise<{
    ok: true;
    snapshotId: string;
    items: AppBlockRecommendation[];
    missingSourceIds: string[];
  }> {
    const response = await request<{ ok: true; snapshotId: string; items: AppSourceCandidateWire[]; missingSourceIds: string[] }>(
      `/api/app-builds/${encodeURIComponent(id)}/source-candidates`,
      { method: 'POST', body: JSON.stringify({ sourceIds, ...(options.includeReviewRequired ? { includeReviewRequired: true } : {}) }) },
    );
    return { ...response, items: response.items.map(appSourceCandidateToRecommendation) };
  },

  async createApp(input: CreateAppRequest): Promise<CreateAppResponse> {
    return request<CreateAppResponse>('/api/apps', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async createAppBuild(input: {
    appId?: string;
    baseAppId?: string;
    name?: string;
    goal?: string;
    audience?: string;
    domain?: string;
    authoringMode: 'ai' | 'manual';
    sourcePolicy?: 'governed_only' | 'include_review_required';
    template?: AppStudioBuildDraft['template'];
    entrypoint?: 'studio' | 'ask';
  }): Promise<{ ok: true; draft: AppStudioBuildDraft }> {
    return request('/api/app-builds', { method: 'POST', body: JSON.stringify(input) });
  },

  async listAppBuilds(): Promise<{ ok: true; drafts: AppStudioBuildDraft[] }> {
    return request('/api/app-builds');
  },

  async proposeAppBuildChanges(
    id: string,
    input: {
      prompt: string;
      expectedRevision: number;
      proposalHash: string;
      selectedBlockIds?: string[];
      /** The page the author has open; the plan lands there. */
      pageId?: string;
      /** `add` (default) keeps existing tiles; `replace` rebuilds the page. */
      mode?: 'add' | 'replace';
    },
  ): Promise<{ ok: true; proposal: AppStudioAiProposal }> {
    return request(`/api/app-builds/${encodeURIComponent(id)}/ai-proposals`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async reviseAppBuildProposal(id: string, proposalId: string, input: {
    expectedRevision: number;
    expectedProposalHash: string;
    answers?: Record<string, string>;
    selectedSourceIds?: string[];
    additionalSourceIds?: string[];
  }): Promise<{ ok: true; proposal: AppStudioAiProposal }> {
    return request(`/api/app-builds/${encodeURIComponent(id)}/ai-proposals/${encodeURIComponent(proposalId)}/revisions`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async generateAppBuildGap(id: string, proposalId: string, input: {
    expectedRevision: number;
    expectedProposalHash: string;
    requirementId: string;
    /** Optional relation selected by the author; the server still owns DQL rendering. */
    sourceRelation?: string;
    /** Optional existing Domain id for the review draft. */
    domain?: string;
  }): Promise<{ ok: true; contextProposal: ContextAuthoringProposalV1; requirementId: string }> {
    return request(`/api/app-builds/${encodeURIComponent(id)}/ai-proposals/${encodeURIComponent(proposalId)}/gaps`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async applyAppAutopilotChange(runId: string, proposalId: string, input: {
    expectedRevision: number;
    expectedProposalHash: string;
    proposalHash: string;
  }): Promise<{ ok: true; draft: AppStudioBuildDraft; proposalId: string; deduped: boolean }> {
    return request(`/api/agent-runs/${encodeURIComponent(runId)}/app-autopilot-changes/${encodeURIComponent(proposalId)}/apply`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async patchAppBuild(id: string, expectedRevision: number, operations: AppStudioDraftOperation[], expectedProposalHash?: string): Promise<{ ok: true; draft: AppStudioBuildDraft }> {
    return request(`/api/app-builds/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedRevision, expectedProposalHash, operations }),
    });
  },

  /**
   * Create a separate Domain review draft from a settled, representable
   * Dataset result. The server reloads all Dataset, policy, target, and
   * execution authority; the browser never sends SQL, result rows, or a
   * source contract.
   */
  async saveDatasetTileAsBlock(
    draftId: string,
    dashboardId: string,
    tileId: string,
    input: {
      runId: string;
      expectedRevision: number;
      expectedProposalHash: string;
      name?: string;
      domain?: string;
      description?: string;
    },
  ): Promise<DatasetTileSaveAsBlockResponse> {
    return request<DatasetTileSaveAsBlockResponse>(
      `/api/app-builds/${encodeURIComponent(draftId)}/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}/save-as-block`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },

  /**
   * Replace only a current static Dataset tile with its separately saved
   * review draft. The route owns SQL, source authority, and equivalence; this
   * client sends identifiers and optimistic guards only.
   */
  async replaceDatasetTileWithBlock(
    draftId: string,
    dashboardId: string,
    tileId: string,
    input: {
      runId: string;
      expectedRevision: number;
      expectedProposalHash: string;
      blockPath: string;
      enableReviewRequired?: boolean;
    },
  ): Promise<DatasetTileReplaceWithBlockResponse> {
    return request<DatasetTileReplaceWithBlockResponse>(
      `/api/app-builds/${encodeURIComponent(draftId)}/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}/replace-with-block`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },

  /** Preview one explicit, bounded legacy semantic-to-Dataset conversion. */
  async previewSemanticTileConversion(
    draftId: string,
    dashboardId: string,
    tileId: string,
    input: { expectedRevision: number; expectedProposalHash: string },
  ): Promise<SemanticTileConversionPreviewResponse> {
    return request<SemanticTileConversionPreviewResponse>(
      `/api/app-builds/${encodeURIComponent(draftId)}/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}/preview-semantic-conversion`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },

  /** Accept only a still-current server-issued conversion proposal. */
  async acceptSemanticTileConversion(
    draftId: string,
    dashboardId: string,
    tileId: string,
    proposalId: string,
    input: { expectedRevision: number; expectedProposalHash: string },
  ): Promise<SemanticTileConversionAcceptResponse> {
    return request<SemanticTileConversionAcceptResponse>(
      `/api/app-builds/${encodeURIComponent(draftId)}/dashboards/${encodeURIComponent(dashboardId)}/tiles/${encodeURIComponent(tileId)}/semantic-conversions/${encodeURIComponent(proposalId)}/accept`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },

  async composeAppBuild(id: string, input: {
    expectedRevision: number;
    expectedProposalHash: string;
  } & (
    | { mode: 'ai'; proposalId: string; selectedSourceIds: string[]; rejectedTileIds?: string[] }
    | { mode: 'manual'; enableReviewRequired?: boolean; selections: Array<{ sourceId: string; pageId?: string; view: 'kpi' | 'chart' | 'table'; query?: TileQuery; title?: string }> }
  )): Promise<{ ok: true; draft: AppStudioBuildDraft; pageIds: string[]; tileIds: string[] }> {
    return request(`/api/app-builds/${encodeURIComponent(id)}/compose`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async addAskResultToAppBuild(id: string, input: {
    expectedRevision: number;
    expectedProposalHash: string;
    pageId?: string;
    title?: string;
    question?: string;
    answer?: string;
    certifiedBlockId?: string;
    dqlSource?: string;
    sql?: string;
    visualization?: string;
    /** The Ask answer itself: with a host, what it read decides whether its text may be shown to others. */
    runId?: string;
    /** `live`: a tile that runs the answer for each reader instead of showing its text. */
    mode?: 'text' | 'live';
  }): Promise<{ ok: true; draft: AppStudioBuildDraft; pageId: string; tileId: string; deduped: boolean }> {
    return request(`/api/app-builds/${encodeURIComponent(id)}/ask-results`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async preflightAppBuild(id: string, expectedRevision: number, proposalHash: string): Promise<{ ok: boolean; draft: AppStudioBuildDraft; errors: string[] }> {
    return request(`/api/app-builds/${encodeURIComponent(id)}/preflight`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision, proposalHash }),
    });
  },

  async publishAppBuild(id: string, expectedRevision: number, proposalHash: string): Promise<{ ok: true; draft: AppStudioBuildDraft; app: AppSummary; paths: string[] }> {
    return request(`/api/app-builds/${encodeURIComponent(id)}/publish-to-project`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision, proposalHash }),
    });
  },

  async deleteAppBuild(id: string, expectedRevision: number, proposalHash: string): Promise<{ ok: true; id: string; recoveryId: string }> {
    return request(`/api/app-builds/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision, proposalHash }),
    });
  },

  /** @deprecated Use publishAppBuild. */
  async commitAppBuild(id: string, expectedRevision: number, proposalHash: string): Promise<{ ok: true; draft: AppStudioBuildDraft; app: AppSummary; paths: string[] }> {
    return this.publishAppBuild(id, expectedRevision, proposalHash);
  },

  async generateApp(input: GenerateAppRequest): Promise<GenerateAppResponse | { ok: false; error: string }> {
    try {
      return await request<GenerateAppResponse>('/api/apps/generate', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async createAppAiBuild(input: GenerateAppRequest): Promise<{ ok: true; session: AppAiBuildSession } | { ok: false; error: string; session?: AppAiBuildSession }> {
    try {
      return await request(
        '/api/apps/ai-builds',
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getAppAiBuild(id: string): Promise<AppAiBuildSession | null> {
    try {
      const { session } = await request<{ ok: true; session: AppAiBuildSession }>(
        `/api/apps/ai-builds/${encodeURIComponent(id)}`,
      );
      return session;
    } catch {
      return null;
    }
  },

  /** Two-phase build, step 1: plan + confirmable content list. Writes no app files. */
  async proposeAppAiBuild(input: GenerateAppRequest): Promise<{ ok: true; session: AppAiBuildSession } | { ok: false; error: string; session?: AppAiBuildSession }> {
    try {
      return await request(
        '/api/apps/ai-builds/propose',
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** Durable proposal request. The accepted operation continues across page navigation. */
  async proposeAppAiBuildInBackground(input: GenerateAppRequest): Promise<{
    ok: true;
    sessionId: string;
    operation: LocalOperation<{ sessionId: string; status: AppAiBuildSession['status']; appId?: string; dashboardId?: string | null }>;
  }> {
    return request('/api/apps/ai-builds/propose-background', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  /** Two-phase build, step 2: the user confirmed — create the app from the selection. */
  /**
   * Open an Ask App proposal in App Studio: the server makes a local App
   * Studio draft (no App files) that opens at the AI Data step.
   */
  async openAppAiBuildInStudio(sessionId: string, input: {
    selectedTileIds?: string[];
    expectedProposalHash?: string;
    appName?: string;
    audience?: string;
  } = {}): Promise<
    | {
      ok: true;
      draft: AppStudioBuildDraft;
      sources: Array<{ sourceId: string; title: string; kind: 'Dataset' | 'Metrics' | 'Saved query'; trust: 'Certified' | 'Needs review'; domain?: string; reason: string }>;
      notCoveredYet: string[];
      reused: boolean;
    }
    | { ok: false; error: string }
  > {
    try {
      return await request(
        `/api/apps/ai-builds/${encodeURIComponent(sessionId)}/open-in-studio`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getApp(id: string): Promise<AppDocumentSummary | null> {
    try {
      return await request<AppDocumentSummary>(`/api/apps/${encodeURIComponent(id)}`);
    } catch (error) {
      // A refusal says why and where to ask (HH-12); anything else reads as missing.
      if (error instanceof DqlApiError && error.status === 403) throw error;
      return null;
    }
  },

  async deleteApp(id: string, expectedFingerprint: string): Promise<{ ok: true; id: string; deletedPath: string; trashPath: string; recoveryId: string; localRowsArchived: number; sourceControlImpact: 'delete' }> {
    return request(`/api/apps/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedFingerprint }) });
  },

  async restoreApp(recoveryId: string): Promise<{ ok: true; id: string; restoredPath: string }> {
    return request(`/api/app-recoveries/${encodeURIComponent(recoveryId)}/restore`, { method: 'POST', body: '{}' });
  },

  /**
   * Rename an App and/or one of its pages. The App id (and therefore its folder
   * and every deep link to it) is deliberately unchanged.
   */
  async renameApp(id: string, input: { name?: string; pageTitle?: string; dashboardId?: string; expectedFingerprint?: string }): Promise<
    { ok: true; app: AppDocumentSummary['app']; paths: string[] } | { ok: false; error: string; code?: string }
  > {
    try {
      return await request(`/api/apps/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async attachAppNotebook(appId: string, input: {
    path: string;
    title?: string;
    role?: 'source' | 'analysis' | 'supporting';
    visibility?: 'shared' | 'private' | 'template';
  }): Promise<AppDocumentSummary | { ok: false; error: string }> {
    try {
      return await request<AppDocumentSummary>(
        `/api/apps/${encodeURIComponent(appId)}/notebooks`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAppNotebookCandidates(appId: string): Promise<AppNotebookCandidate[]> {
    try {
      const { notebooks } = await request<{ notebooks: AppNotebookCandidate[] }>(
        `/api/apps/${encodeURIComponent(appId)}/notebook-candidates`,
      );
      return notebooks;
    } catch {
      return [];
    }
  },

  async createAppNotebook(appId: string, input: {
    name: string;
    title?: string;
    role?: 'source' | 'analysis' | 'supporting';
    visibility?: 'shared' | 'private' | 'template';
    template?: string;
  }): Promise<{ ok: true; path: string; app: AppDocumentSummary; preview?: AppNotebookPreview } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/notebooks/create`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async previewAppNotebook(appId: string, path: string): Promise<AppNotebookPreview | null> {
    try {
      return await request<AppNotebookPreview>(
        `/api/apps/${encodeURIComponent(appId)}/notebooks/preview?path=${encodeURIComponent(path)}`,
      );
    } catch {
      return null;
    }
  },

  async runAppNotebook(appId: string, path: string): Promise<{ ok: true; preview: AppNotebookPreview } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/notebooks/run`,
        { method: 'POST', body: JSON.stringify({ path }) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAppConversations(appId: string): Promise<AppConversation[]> {
    try {
      const { conversations } = await request<{ conversations: AppConversation[] }>(
        `/api/apps/${encodeURIComponent(appId)}/conversations`,
      );
      return conversations;
    } catch {
      return [];
    }
  },

  async createAppConversation(appId: string, input: {
    title?: string;
    dashboardId?: string;
    notebookPath?: string;
    context?: AgentConversationContext;
    messages?: AppConversationMessage[];
  }): Promise<{ ok: true; conversation: AppConversation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/conversations`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getAppConversation(appId: string, conversationId: string): Promise<AppConversation | null> {
    try {
      const { conversation } = await request<{ conversation: AppConversation }>(
        `/api/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}`,
      );
      return conversation;
    } catch {
      return null;
    }
  },

  async updateAppConversation(appId: string, conversationId: string, input: {
    title?: string;
    dashboardId?: string;
    notebookPath?: string;
    context?: AgentConversationContext | null;
    messages?: AppConversationMessage[];
  }): Promise<{ ok: true; conversation: AppConversation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}`,
        { method: 'PATCH', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async deleteAppConversation(appId: string, conversationId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/conversations/${encodeURIComponent(conversationId)}`,
        { method: 'DELETE' },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAppInvestigations(appId: string, dashboardId?: string): Promise<LocalAppInvestigation[]> {
    try {
      const search = new URLSearchParams();
      if (dashboardId) search.set('dashboardId', dashboardId);
      const qs = search.toString();
      const { investigations } = await request<{ investigations: LocalAppInvestigation[] }>(
        `/api/apps/${encodeURIComponent(appId)}/investigations${qs ? `?${qs}` : ''}`,
      );
      return investigations;
    } catch {
      return [];
    }
  },

  async createAppInvestigation(appId: string, input: {
    dashboardId?: string;
    sourceTileId?: string;
    sourceBlockId?: string;
    title?: string;
    question: string;
    intent?: LocalAppInvestigation['intent'];
    context?: unknown;
    generatedSql?: string;
    run?: boolean;
  }): Promise<{ ok: true; investigation: LocalAppInvestigation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/investigations`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async getAppInvestigation(appId: string, investigationId: string): Promise<LocalAppInvestigation | null> {
    try {
      const { investigation } = await request<{ investigation: LocalAppInvestigation }>(
        `/api/apps/${encodeURIComponent(appId)}/investigations/${encodeURIComponent(investigationId)}`,
      );
      return investigation;
    } catch {
      return null;
    }
  },

  async runAppInvestigation(appId: string, investigationId: string, input?: {
    question?: string;
    intent?: LocalAppInvestigation['intent'];
    context?: unknown;
    generatedSql?: string;
    repairMode?: 'rebuild_from_certified';
  }): Promise<{ ok: true; investigation: LocalAppInvestigation } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/investigations/${encodeURIComponent(investigationId)}/run`,
        { method: 'POST', body: JSON.stringify(input ?? {}) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async pinAppInvestigation(appId: string, investigationId: string, input?: {
    dashboardId?: string;
    title?: string;
    refreshCadence?: 'none' | 'daily';
  }): Promise<{ ok: true; investigation: LocalAppInvestigation; pin: LocalAiPin; dashboard?: DashboardDocumentResponse['dashboard']; tile?: DashboardDocumentResponse['dashboard']['layout']['items'][number] } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/investigations/${encodeURIComponent(investigationId)}/pin`,
        { method: 'POST', body: JSON.stringify(input ?? {}) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** `throwNotFound`: a page this project does not have throws its 404 (the App reader says so) instead of null. */
  async getDashboard(appId: string, dashboardId: string, options: { throwNotFound?: boolean } = {}): Promise<DashboardDocumentResponse | null> {
    try {
      return await request<DashboardDocumentResponse>(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}`,
      );
    } catch (error) {
      if (error instanceof DqlApiError && (error.status === 403 || (options.throwNotFound && error.status === 404))) throw error;
      return null;
    }
  },

  /** Distinct values for a block column → categorical dashboard-filter dropdowns. */
  async dashboardFilterOptions(block: string, column: string): Promise<{ options: string[]; truncated: boolean } | null> {
    try {
      const search = new URLSearchParams({ block, column });
      return await request<{ options: string[]; truncated: boolean }>(`/api/dashboard/filter-options?${search.toString()}`);
    } catch {
      return null;
    }
  },

  async getAppEditorCatalog(appId: string, params?: { domain?: string; certifiedOnly?: boolean }): Promise<AppEditorCatalogResponse | null> {
    try {
      const search = new URLSearchParams();
      if (params?.domain) search.set('domain', params.domain);
      if (params?.certifiedOnly === false) search.set('certifiedOnly', 'false');
      const qs = search.toString();
      return await request<AppEditorCatalogResponse>(
        `/api/apps/${encodeURIComponent(appId)}/editor/catalog${qs ? `?${qs}` : ''}`,
      );
    } catch {
      return null;
    }
  },

  async createAppDashboard(appId: string, input: { id?: string; title: string; description?: string }): Promise<{ ok: true; dashboard: DashboardDocumentResponse['dashboard']; path: string } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/dashboards`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async patchDashboardLayout(
    appId: string,
    dashboardId: string,
    layout: DashboardDocumentResponse['dashboard']['layout'],
  ): Promise<{ ok: true; dashboard: DashboardDocumentResponse['dashboard']; path: string } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/layout`,
        { method: 'PATCH', body: JSON.stringify({ layout }) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async askApp(appId: string, input: {
    question: string;
    dashboardId?: string;
    tileId?: string;
    blockId?: string;
    variables?: Record<string, unknown>;
    context?: unknown;
    runInvestigation?: boolean;
    /** Required for the server-grounded Dataset chart answer lane. */
    runId?: string;
  }): Promise<AppAskResponse> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ask`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async publishAppToProject(appId: string, input?: { lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated' }): Promise<
    | { ok: true; app: AppDocumentSummary['app']; paths: string[]; removedLocalTiles: number; readiness: { ready: true; governedTiles: number; blockers: [] } }
    | { ok: false; error: string; readiness?: { ready: false; governedTiles: number; blockers: Array<{ dashboardId: string; tileId: string; code: string; message: string }> } }
  > {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/publish-to-project`,
        { method: 'POST', body: JSON.stringify(input ?? {}) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  /** @deprecated Compatibility alias. New UI should say Publish to Project. */
  async promoteApp(appId: string, input?: { lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated' }) {
    return api.publishAppToProject(appId, input);
  },

  async approveAppSemanticTiles(
    appId: string,
    dashboardId: string,
    input: { runId: string; tileIds: string[]; expectedDashboardFingerprint: string; reviewer?: string },
  ): Promise<{ ok: true; dashboard: DashboardDocumentResponse['dashboard']; path: string } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/approve-semantic`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async recommendVisualization(input: {
    blockRef?: string;
    resultSchema?: unknown;
    rowSample?: Array<Record<string, unknown>>;
    appAudience?: string;
    prompt?: string;
    allowedVisualizations?: string[];
    component?: DashboardDisplayMetadata['component'];
    defaultVisualization?: string;
  }): Promise<VisualizationRecommendationResponse> {
    try {
      return await request(
        '/api/visualizations/recommend',
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async recommendDashboardTile(appId: string, dashboardId: string, input: {
    tileId?: string;
    blockRef?: string;
    resultSchema?: unknown;
    rowSample?: Array<Record<string, unknown>>;
    appAudience?: string;
    prompt?: string;
    allowedVisualizations?: string[];
    component?: DashboardDisplayMetadata['component'];
    defaultVisualization?: string;
  }): Promise<VisualizationRecommendationResponse | {
    ok: true;
    display: DashboardDisplayMetadata;
    filterBindings?: DashboardTileFilterBinding[];
    parameterBindings?: DashboardTileParameterBinding[];
    sourceEvidence?: DashboardTileSourceEvidence[];
    trustState: DashboardDisplayMetadata['trustState'];
    reviewStatus: DashboardDisplayMetadata['reviewStatus'];
    evidence: Array<{ source: string; reason: string }>;
    warnings: string[];
  }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/tiles/recommend`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

 async createAiPin(appId: string, input: {
    dashboardId: string;
    title: string;
    answer: string;
    question?: string;
    sql?: string;
    sourceTier?: string;
    certification?: 'certified' | 'ai_generated';
    reviewStatus?: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
    refreshCadence?: 'none' | 'daily';
    chartConfig?: Record<string, unknown>;
    result?: QueryResult;
    citations?: unknown[];
    analysisPlan?: unknown;
    evidence?: unknown;
    followUps?: string[];
  }): Promise<{
    ok: true;
    pin: LocalAiPin;
    dashboard?: DashboardDocumentResponse['dashboard'];
    tile?: DashboardDocumentResponse['dashboard']['layout']['items'][number];
    /**
     * The server dedupes on the question and returns the existing pin without
     * writing. Callers must not report that as a new tile.
     */
    deduped?: boolean;
  } | { ok: false; error: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins`,
        { method: 'POST', body: JSON.stringify(input) },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listAiPins(appId: string, dashboardId?: string): Promise<LocalAiPin[]> {
    try {
      const search = new URLSearchParams();
      if (dashboardId) search.set('dashboardId', dashboardId);
      const qs = search.toString();
      const { pins } = await request<{ pins: LocalAiPin[] }>(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins${qs ? `?${qs}` : ''}`,
      );
      return pins;
    } catch {
      return [];
    }
  },

  async refreshAiPin(appId: string, pinId: string): Promise<{ ok: boolean; pin?: LocalAiPin; error?: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins/${encodeURIComponent(pinId)}/refresh`,
        { method: 'POST' },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async promoteAiPin(appId: string, pinId: string): Promise<{ ok: boolean; pin?: LocalAiPin; blockPath?: string; error?: string }> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/ai-pins/${encodeURIComponent(pinId)}/promote`,
        { method: 'POST' },
      );
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async fetchScopedLineage(params: { domain?: string; appId?: string; dashboardId?: string; blockId?: string }): Promise<any | null> {
    try {
      const search = new URLSearchParams();
      if (params.domain) search.set('domain', params.domain);
      if (params.appId) search.set('appId', params.appId);
      if (params.dashboardId) search.set('dashboardId', params.dashboardId);
      if (params.blockId) search.set('blockId', params.blockId);
      return await request<any>(`/api/lineage/scope?${search.toString()}`);
    } catch {
      return null;
    }
  },

  async runDashboard(
    appId: string,
    dashboardId: string,
    variables?: Record<string, unknown>,
    crossFilters?: DashboardDatasetCrossFilter[],
    options?: DashboardRunOptions,
  ): Promise<DashboardRunResponse> {
    // Throw the server's typed refusal (access, source drift, feature off)
    // so the viewer shows why a page did not run, not a generic failure.
    return request<DashboardRunResponse>(
      `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/run`,
      { method: 'POST', body: JSON.stringify({ variables: variables ?? {}, ...(crossFilters?.length ? { crossFilters } : {}), ...(options?.runScope ? { runScope: options.runScope } : {}), ...(options?.runSequence !== undefined ? { runSequence: options.runSequence } : {}), ...(options?.refresh ? { refresh: true } : {}), ...(options?.fullRun ? { fullRun: true } : {}), ...(options?.tileId ? { tileId: options.tileId } : {}), ...(options?.visibleTileIds !== undefined ? { visibleTileIds: options.visibleTileIds } : {}), ...(options?.affectedTileIds !== undefined ? { affectedTileIds: options.affectedTileIds } : {}), ...(options?.datasetDrills?.length ? { datasetDrills: options.datasetDrills } : {}), ...(options?.driverProbe ? { driverProbe: options.driverProbe } : {}), ...(options?.exploreProbe ? { exploreProbe: options.exploreProbe } : {}), ...(options?.viewerFilters?.length ? { viewerFilters: options.viewerFilters } : {}) }) },
    );
  },

  async runAppBuildPreview(
    draftId: string,
    dashboardId: string,
    variables?: Record<string, unknown>,
    crossFilters?: DashboardDatasetCrossFilter[],
    options?: DashboardRunOptions,
  ): Promise<DashboardRunResponse> {
    return request<DashboardRunResponse>(
      `/api/app-builds/${encodeURIComponent(draftId)}/dashboards/${encodeURIComponent(dashboardId)}/run`,
      { method: 'POST', body: JSON.stringify({ variables: variables ?? {}, ...(crossFilters?.length ? { crossFilters } : {}), ...(options?.runScope ? { runScope: options.runScope } : {}), ...(options?.refresh ? { refresh: true } : {}), ...(options?.fullRun ? { fullRun: true } : {}), ...(options?.tileId ? { tileId: options.tileId } : {}), ...(options?.visibleTileIds !== undefined ? { visibleTileIds: options.visibleTileIds } : {}), ...(options?.affectedTileIds !== undefined ? { affectedTileIds: options.affectedTileIds } : {}), ...(options?.datasetDrills?.length ? { datasetDrills: options.datasetDrills } : {}), ...(options?.driverProbe ? { driverProbe: options.driverProbe } : {}), ...(options?.exploreProbe ? { exploreProbe: options.exploreProbe } : {}), ...(options?.viewerFilters?.length ? { viewerFilters: options.viewerFilters } : {}) }) },
    );
  },

  /** Validate a Dataset's declared physical grain against the active local target.
   * The receipt stays under `.dql/local`; this never changes source trust. */
  async validateDatasetGrain(input: {
    sourceId: string;
    sourceRevision?: string;
    parameters?: Record<string, unknown>;
  }): Promise<{
    ok: boolean;
    eligible?: boolean;
    localPath?: string;
    error?: string;
    evidence?: { status?: 'passed' | 'failed'; uniqueness?: { rowCount: number; distinctKeyCount: number; nullKeyCount: number; duplicateKeyCount: number } };
  }> {
    try {
      return await request('/api/datasets/validate-grain', { method: 'POST', body: JSON.stringify(input) });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * Distinct values of one approved Dataset field, for a Dataset-bound page
   * filter's options. Runs as a governed field query; nothing is App evidence.
   */
  /**
   * Distinct values of one Dataset field for a filter control: the first page
   * for browsing (with how many values exist), or, with `search`, the values
   * that contain the typed text, searched on the server over every value.
   */
  async datasetFieldValues(sourceId: string, field: string, options: { search?: string } = {}): Promise<DatasetFieldValuesResponse> {
    try {
      const search = options.search?.trim();
      return await request('/api/app-datasets/field-values', { method: 'POST', body: JSON.stringify({ sourceId, field, ...(search ? { search } : {}) }) });
    } catch (error) {
      return { ok: false, values: [], error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** Start from a table: the database's tables (RFC 0009, first page). */
  async listWarehouseTables(): Promise<{ ok: boolean; source?: 'catalog' | 'live'; tables: WarehouseTableSummary[]; error?: string; code?: string }> {
    try {
      return await request('/api/app-datasets/tables');
    } catch (error) {
      return { ok: false, tables: [], error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** What DQL proposes for one table, checked against its rows. */
  async draftTableDataset(tableId: string): Promise<{ ok: boolean; rows?: number; proposal?: TableDatasetProposal; table?: { id: string; name: string; relation: string }; error?: string }> {
    try {
      return await request('/api/app-datasets/tables/draft', { method: 'POST', body: JSON.stringify({ tableId }) });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /** Save the author's choice as a Dataset they own. */
  async createTableDataset(input: { tableId: string; name: string; domain?: string; measures: Array<{ name: string; include: boolean; format: string; currency?: string }> }): Promise<{ ok: boolean; status?: 'certified' | 'draft'; sourceId?: string; path?: string; blockers?: string[]; keyChecked?: boolean; certification?: CertificationByline; error?: string }> {
    try {
      return await request('/api/app-datasets/tables/create', { method: 'POST', body: JSON.stringify(input) });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * Read a saved query's result columns as fields (design D1): no review
   * step, nothing written to the block, its trust unchanged. Afterwards the
   * catalog lists the saved query with its fields.
   */
  async readSavedQueryFields(sourceId: string): Promise<{ ok: boolean; sourceId?: string; sourceRevision?: string; read?: boolean; descriptor?: DatasetDescriptor; error?: string; code?: string }> {
    try {
      return await request('/api/app-datasets/saved-queries/fields', { method: 'POST', body: JSON.stringify({ sourceId }) });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), ...(error instanceof DqlApiError && error.code ? { code: error.code } : {}) };
    }
  },

  /** Make a saved query row-level (design D1, formerly "Add fields"): what DQL proposes from its output columns, checked against its rows. */
  async draftSavedQueryDataset(sourceId: string): Promise<SavedQueryDatasetDraft> {
    try {
      return await request('/api/app-datasets/saved-queries/draft', { method: 'POST', body: JSON.stringify({ sourceId }) });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), ...(error instanceof DqlApiError && error.code ? { code: error.code } : {}) };
    }
  },

  /** Write the author's choice onto the same saved query block, then run its certification check. */
  async createSavedQueryDataset(input: { sourceId: string; sourceRevision?: string; measures: Array<{ name: string; include: boolean; format: string; currency?: string }>; allowReview?: boolean }): Promise<SavedQueryDatasetResult> {
    try {
      return await request('/api/app-datasets/saved-queries/create', { method: 'POST', body: JSON.stringify(input) });
    } catch (error) {
      const details = error instanceof DqlApiError && error.details && typeof error.details === 'object' ? error.details as { blockers?: unknown } : undefined;
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof DqlApiError && error.code ? { code: error.code } : {}),
        ...(Array.isArray(details?.blockers) ? { blockers: details.blockers.filter((item): item is string => typeof item === 'string') } : {}),
      };
    }
  },

  /** Turn field-based Dataset tiles back on for a project that set `apps.datasets: false` (they are on by default). */
  async enableDatasetTiles(): Promise<{ ok: boolean; datasets?: boolean; error?: string }> {
    try {
      return await request('/api/app-datasets/enable', { method: 'POST', body: '{}' });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  /**
   * Live preview of one field query while it is being built. The server runs
   * it through the ordinary governed Dataset runtime in an ephemeral one-tile
   * page: same validation, proofs, and execution, but no App receipt, story,
   * or publication evidence. Pass a signal so a newer edit cancels this one.
   */
  async previewDatasetTileQuery(
    input: { sourceId: string; query: TileQuery },
    signal?: AbortSignal,
  ): Promise<DatasetTileQueryPreview> {
    try {
      return await request<DatasetTileQueryPreview>('/api/app-datasets/run', {
        method: 'POST',
        body: JSON.stringify({ sourceId: input.sourceId, query: input.query }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },


  /**
   * A signed, self-contained HTML snapshot of a page run (RFC 0008 step 10).
   * The server records the figures, filters and trust from its own run and
   * signs them with the project key; the browser supplies only the drawing.
   */
  async exportAppSnapshot(appId: string, dashboardId: string, input: { runId: string; body: string; tileIds: string[] }): Promise<AppSnapshotExportV1> {
    return request<AppSnapshotExportV1>(`/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  },

  /** Where page links can be opened: this computer only, or the network origins and token. */
  /** Where a page can be opened, and a read-only link token for its App when shared on the network. */
  async getShareOrigins(appId?: string): Promise<{ network: boolean; origins: string[]; viewer?: { token: string; expiresAt: string }; viewerBlocked?: string }> {
    try {
      return await request<{ network: boolean; origins: string[]; viewer?: { token: string; expiresAt: string }; viewerBlocked?: string }>(`/api/server/share${appId ? `?app=${encodeURIComponent(appId)}` : ''}`);
    } catch {
      return { network: false, origins: [] };
    }
  },

  /** The alerts on a page and the schedules that check them. */
  async getPageMonitors(appId: string, dashboardId: string): Promise<PageMonitorsResponseV1> {
    return request<PageMonitorsResponseV1>(`/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/monitors`);
  },

  /** Add an alert on one of the page's figures; it is saved in the App's dql.app.json. */
  async addPageMonitor(appId: string, dashboardId: string, input: { runId: string; binding: string; when: AppMonitorConditionV1; label?: string; deliver?: AppScheduleDeliveryV1[] }): Promise<PageMonitorsResponseV1> {
    return request<PageMonitorsResponseV1>(`/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/monitors`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async removePageMonitor(appId: string, dashboardId: string, scheduleId: string, monitorId: string): Promise<PageMonitorsResponseV1> {
    return request<PageMonitorsResponseV1>(`/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/monitors/${encodeURIComponent(scheduleId)}/${encodeURIComponent(monitorId)}`, { method: 'DELETE' });
  },

  /** Story editions of a published page, newest first. */
  async getStoryEditions(appId: string, dashboardId: string): Promise<StoryEditionV1[]> {
    try {
      const result = await request<{ editions: StoryEditionV1[] }>(`/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/story-editions`);
      return Array.isArray(result.editions) ? result.editions : [];
    } catch {
      return [];
    }
  },

  /** Draft a story for a local App page from its latest complete preview run. */
  async draftAppBuildStory(draftId: string, dashboardId: string, runId: string, instruction?: string): Promise<StoryDraftResponseV1> {
    return request<StoryDraftResponseV1>(
      `/api/app-builds/${encodeURIComponent(draftId)}/dashboards/${encodeURIComponent(dashboardId)}/story-draft`,
      { method: 'POST', body: JSON.stringify({ runId, ...(instruction ? { instruction } : {}) }) },
    );
  },

  /** Draft a governed HTML page for a local App page from its latest complete preview run. */
  async draftAppBuildCanvas(draftId: string, dashboardId: string, runId: string, instruction?: string): Promise<CanvasDraftResponseV1> {
    return request<CanvasDraftResponseV1>(
      `/api/app-builds/${encodeURIComponent(draftId)}/dashboards/${encodeURIComponent(dashboardId)}/canvas-draft`,
      { method: 'POST', body: JSON.stringify({ runId, ...(instruction ? { instruction } : {}) }) },
    );
  },

  async getDashboardStory(appId: string, dashboardId: string, runId: string): Promise<Pick<DashboardRunResponse, 'runId' | 'snapshotId' | 'filterFingerprint' | 'resultFingerprint' | 'personaFingerprint' | 'facts' | 'story'> | null> {
    try {
      return await request(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}/story`,
        { method: 'POST', body: JSON.stringify({ runId }) },
      );
    } catch {
      return null;
    }
  },

  async saveDashboard(
    appId: string,
    dashboardId: string,
    body: DashboardDocumentResponse['dashboard'],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const result = await request<{ ok: true; path: string }>(
        `/api/apps/${encodeURIComponent(appId)}/dashboards/${encodeURIComponent(dashboardId)}`,
        { method: 'PUT', body: JSON.stringify(body) },
      );
      return { ok: !!result.ok };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  // ── Persona ─────────────────────────────────────────────────────────────

  async getPersona(): Promise<ActivePersona | null> {
    try {
      const { persona } = await request<{ persona: ActivePersona | null }>('/api/persona');
      return persona;
    } catch {
      return null;
    }
  },

  async setPersona(userId: string, appId?: string): Promise<ActivePersona | null> {
    try {
      const { persona } = await request<{ persona: ActivePersona | null }>('/api/persona', {
        method: 'POST',
        body: JSON.stringify({ userId, appId }),
      });
      return persona;
    } catch {
      return null;
    }
  },

  async clearPersona(): Promise<void> {
    try {
      await request('/api/persona', { method: 'DELETE' });
    } catch {
      // best-effort; UI restores owner default on next refresh
    }
  },

  // ── Spec 16 — Skills authoring & management ───────────────────────────────
  // Business-context "skills" the agent applies per question. Project skills are
  // shared; personal skills are bound to one user. These methods are coded to
  // the shared contract — the backend implements the same endpoints. Errors
  // surface to the page (which renders graceful empty/error states), so we do
  // NOT swallow them here.

  /** List all skills (project + personal). → GET /api/skills */
  async getSkills(): Promise<{ skills: Skill[] }> {
    return request<{ skills: Skill[] }>('/api/skills');
  },

  /** Read the configured Git-backed Skills folder. */
  async getSkillPathSettings(): Promise<SkillPathSettings> {
    return request<SkillPathSettings>('/api/skills/settings');
  },

  /** Point Skills at an existing folder in this or the surrounding dbt repo. */
  async updateSkillPath(path: string): Promise<SkillPathSettings> {
    return request<SkillPathSettings>('/api/skills/settings', {
      method: 'PUT',
      body: JSON.stringify({ path }),
    });
  },

  /** Multi-select options for the preferred metrics/blocks fields. → GET /api/skills/options */
  async getSkillOptions(query = ''): Promise<{ metrics: string[]; blocks: string[]; modelingRefs: string[] }> {
    const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    return request<{ metrics: string[]; blocks: string[]; modelingRefs: string[] }>(`/api/skills/options${suffix}`);
  },

  /** Create a new skill. → POST /api/skills  body { skill } */
  async createSkill(skill: Skill): Promise<{ skill: Skill }> {
    return request<{ skill: Skill }>('/api/skills', {
      method: 'POST',
      body: JSON.stringify({ skill }),
    });
  },

  /** Update an existing skill. → PUT /api/skills/:id  body { skill } */
  async updateSkill(id: string, skill: Skill): Promise<{ skill: Skill }> {
    return request<{ skill: Skill }>(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ skill }),
    });
  },

  /** Delete a skill. → DELETE /api/skills/:id */
// --- Embeddings ------------------------------------------------------
  // Whether retrieval can match MEANING or only shared words.
  async getEmbeddingSettings(): Promise<EmbeddingSettingsResponse> {
    return request('/api/settings/embeddings');
  },

  async saveEmbeddingSettings(input: {
    provider: 'hashed' | 'ollama' | 'openai';
    endpoint?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ ok: true; activeProviderId: string; semantic: boolean; reindexRequired: boolean }> {
    return request('/api/settings/embeddings', { method: 'PUT', body: JSON.stringify(input) });
  },

  async listEmbeddingModels(endpoint?: string): Promise<{
    catalog: {
      ollama: Array<{ model: string; label: string; dimensions: number; size: string; recommended: boolean; description: string }>;
      openai: Array<{ model: string; label: string; dimensions: number; size: string; recommended: boolean; description: string }>;
    };
    ollamaReachable: boolean;
    installed: string[];
  }> {
    const query = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
    return request(`/api/settings/embeddings/models${query}`);
  },

  async installEmbeddingModel(model: string, endpoint?: string): Promise<{ ok: true; model: string }> {
    return request('/api/settings/embeddings/install', { method: 'POST', body: JSON.stringify({ model, endpoint }) });
  },

  async testEmbeddingProvider(): Promise<{ ok: boolean; providerId: string; dimensions: number; elapsedMs: number; semantic: boolean }> {
    return request('/api/settings/embeddings/test', { method: 'POST' });
  },

  async reindexEmbeddings(): Promise<EmbeddingReindexResult> {
    return request('/api/settings/embeddings/reindex', { method: 'POST' });
  },

  /** Deleting moves the skill file to a recovery bundle rather than erasing it. */
  async deleteSkill(id: string): Promise<{
    ok: true;
    recovered?: { recoveryId: string; trashPath: string; files: string[] };
  }> {
    return request(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  /** Move a private skill into the shared Skills folder, where it starts shaping answers. */
  async publishSkill(id: string): Promise<{
    ok: boolean;
    previousId?: string;
    path?: string;
    skill?: Skill;
    error?: string;
  }> {
    return request('/api/skills/publish', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
  },

  // ── Spec 17 (part B) — Domains CRUD ────────────────────────────────────────
  // A domain is the top of the domain→term→block hierarchy. These are coded to
  // the shared contract — the backend implements the same endpoints. Errors
  // surface to the page (which renders graceful empty/error states), so we do
  // NOT swallow them on create/update/delete. The list call is best-effort so
  // pickers that read it never block their host form.

  /** List all domains with rollup counts. → GET /api/domains */
  async getDomains(): Promise<{ domains: Domain[] }> {
    try {
      return await request<{ domains: Domain[] }>('/api/domains');
    } catch {
      return { domains: [] };
    }
  },

  /** Create a new domain. → POST /api/domains  body { domain } */
  async createDomain(domain: Domain): Promise<{ domain: Domain }> {
    return request<{ domain: Domain }>('/api/domains', {
      method: 'POST',
      body: JSON.stringify({ domain }),
    });
  },

  /** Update an existing domain. → PUT /api/domains/:id  body { domain } */
  async updateDomain(id: string, domain: Domain): Promise<{ domain: Domain }> {
    return request<{ domain: Domain }>(`/api/domains/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ domain }),
    });
  },

  /** Domains, subject areas and purposes Ask can be scoped to. → GET /api/ask/scopes */
  async getAskScopes(): Promise<{ domains: AskScopeOption[] }> {
    return request<{ domains: AskScopeOption[] }>('/api/ask/scopes');
  },

  /** What Ask will use and enforce for a domain or subject area. → GET /api/modeling/ask-impact */
  async getAskImpact(domain: string, area?: string | null): Promise<AskImpactResponse> {
    return request<AskImpactResponse>(`/api/modeling/ask-impact?domain=${encodeURIComponent(domain)}${area ? `&area=${encodeURIComponent(area)}` : ''}`);
  },

  /** Business terms Ask maps words through. → GET /api/terms */
  async getTerms(): Promise<{ terms: BusinessTerm[] }> {
    return request<{ terms: BusinessTerm[] }>('/api/terms');
  },

  /** Create a term file. → POST /api/terms  body { term } */
  async createTerm(term: BusinessTermInput): Promise<{ term: BusinessTerm }> {
    return request<{ term: BusinessTerm }>('/api/terms', { method: 'POST', body: JSON.stringify({ term }) });
  },

  /** Rewrite the term declared in `filePath`. → PUT /api/terms  body { term, filePath } */
  async updateTerm(filePath: string, term: BusinessTermInput): Promise<{ term: BusinessTerm }> {
    return request<{ term: BusinessTerm }>('/api/terms', { method: 'PUT', body: JSON.stringify({ term, filePath }) });
  },

  /** Delete a term's file. → DELETE /api/terms?filePath= */
  async deleteTerm(filePath: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/terms?filePath=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
  },

  /** Delete a domain. → DELETE /api/domains/:id */
  async deleteDomain(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`/api/domains/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async startContextBootstrap(options: { ai?: boolean } = {}): Promise<ContextBootstrapSession> {
    return request<ContextBootstrapSession>('/api/context-bootstrap', {
      method: 'POST',
      body: JSON.stringify(options),
    });
  },

  async getContextBootstrap(id: string): Promise<ContextBootstrapSession> {
    return request<ContextBootstrapSession>(`/api/context-bootstrap/${encodeURIComponent(id)}`);
  },

  async getLatestContextBootstrap(): Promise<ContextBootstrapSession | null> {
    const result = await request<{ session: ContextBootstrapSession | null }>('/api/context-bootstrap/latest');
    return result.session ?? null;
  },

  async saveContextBootstrapSelected(id: string, candidateIds: string[]): Promise<{ id: string; saved: Array<{ id: string; path?: string; status: 'saved' | 'skipped' | 'blocked'; blockers?: string[] }> }> {
    return request(`/api/context-bootstrap/${encodeURIComponent(id)}/save-selected`, {
      method: 'POST',
      body: JSON.stringify({ candidateIds }),
    });
  },
};

export interface ContextBootstrapCandidate {
  id: string;
  kind: 'domain' | 'skill';
  action: 'create' | 'update' | 'unchanged' | 'needs_attention';
  confidence: number;
  evidence: string[];
  notes?: string[];
  domain?: Partial<Domain>;
  skill?: Partial<Skill>;
}

export interface ContextBootstrapSession {
  id: string;
  createdAt: string;
  persistence: 'session-only';
  candidates: ContextBootstrapCandidate[];
  status: 'queued' | 'inventory' | 'grounding' | 'generating' | 'validating' | 'ready' | 'needs_attention';
  ai: { requested: boolean; mode: 'pending' | 'provider' | 'evidence_only'; provider?: string };
  progress: {
    percent: number;
    message: string;
    domains: { total: number; ready: number };
    skills: { total: number; ready: number };
    events: string[];
  };
  warnings?: string[];
}
