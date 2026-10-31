import type { DashboardVizStyle } from '@zlens/core/apps/viz-style';
// v1.3.2 — three Luna themes (obsidian dark, paper warm light, white plain light).
// `dark`/`light`/`midnight`/`arctic` kept as aliases so persisted state from
// earlier v1.3 releases still loads; normalize in the reducer / App effect.
import type { AgentRun, MixedSourceNotebookPlan } from '../api/client';

export type ThemeMode = 'obsidian' | 'paper' | 'white' | 'dark' | 'light' | 'midnight' | 'arctic';

/**
 * v1.3 Track 5 — shell-level audience split.
 * - `studio`: full authoring surface (activity bar, sidebar, cell toolbars, all cell types visible)
 * - `app`: stakeholder read-mostly view (output-only cells + interactive filters; SQL/param/writeback/chat collapse)
 * - `reader`: presentation view — narrative-only, no run controls, no studio chrome.
 *   v1.3.3 Hex-handoff alignment; reader visibility behaves like `app` for now.
 */
export type AppMode = 'studio' | 'app' | 'reader';

export interface NotebookDocMetadata {
  status?: string;
  categories?: string[];
  description?: string;
  projectFilter?: string;
  author?: string;
  createdAt?: string;
  modifiedAt?: string;
  ownerDomain?: string;
  usesDomains?: string[];
  purpose?: string;
  requiredExports?: string[];
  classification?: string;
}

export type CellType =
  | 'sql'
  | 'markdown'
  | 'dql'
  | 'param'
  | 'chart'
  | 'pivot'
  | 'single_value'
  | 'filter'
  | 'table'
  | 'map'
  | 'writeback'
  | 'python'
  | 'chat';

export type CellStatus = 'idle' | 'running' | 'success' | 'error';

export interface CellChartConfig {
  /** Typed styling from a dashboard tile's `viz.style` (RFC 0008): labels, stacking, reference lines, bands, notes. */
  style?: DashboardVizStyle;
  chart?: string;   // bar | line | area | pie | donut | scatter | heatmap | funnel | sankey | waterfall | histogram | gauge | stacked-bar | grouped-bar | kpi | table
  /** Who selected the chart. Agent suggestions are validated against returned data; authored/user choices are retained. */
  decisionSource?: 'authored' | 'agent' | 'data' | 'user';
  /** Short, user-facing explanation for a smart recommendation. */
  rationale?: string;
  x?: string;       // X-axis column
  y?: string;       // Y-axis column
  /** Ordered measures retained by a multi-metric table/result contract. */
  metrics?: string[];
  color?: string;   // Color-by column; target/destination column for Sankey
  facet?: string;   // Faceting column (horizontal/vertical split)
  size?: string;    // Size-by column (scatter/bubble)
  title?: string;
  xLabel?: string;
  yLabel?: string;
  legendPosition?: 'top' | 'bottom' | 'left' | 'right' | 'none';
  colorPalette?: 'dql' | 'default' | 'warm' | 'cool' | 'mono' | 'pastel' | 'corporate';
  maxItems?: number;
  format?: 'number' | 'currency' | 'percent' | 'duration';  // KPI/single-value display format
  /** Bars run along x (vertical) or y (horizontal); from the tile's shelves (RFC 0009). */
  orientation?: 'vertical' | 'horizontal';
  /** Measures whose values are drawn as labels on their marks. */
  labelColumns?: string[];
  /** Extra measures shown in the tooltip. */
  tooltipColumns?: string[];
  /** A quiet last line in every tooltip, e.g. "Certified · Orders Dataset". */
  tooltipFooter?: string;
}

export type FilterOperation =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'is_null' | 'is_not_null' | 'in' | 'not_in' | 'between';

export interface FilterRule {
  id: string;
  column: string;
  operation: FilterOperation;
  value: string;
}

export interface FilterGroup {
  id: string;
  combinator: 'and' | 'or';
  rules: FilterRule[];
}

export interface FilterCellConfig {
  mode: 'keep' | 'drop';
  groups: FilterGroup[];
  upstream?: string;   // dataframe handle
}

export interface PivotCellConfig {
  rows: string[];
  columns: string[];
  values: Array<{ column: string; aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct' }>;
  upstream?: string;
}

export interface SingleValueCellConfig {
  metric?: string;       // column name to aggregate
  aggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'last';
  format?: 'number' | 'currency' | 'percent' | 'duration';
  label?: string;
  comparison?: { column?: string; mode?: 'previous' | 'baseline' };
  upstream?: string;
}

export interface TableCellConfig {
  upstream?: string;       // dataframe handle to render
  visibleColumns?: string[];
  pinnedColumns?: string[];
}

export type ChatProviderId = 'anthropic' | 'claude-agent-sdk' | 'claude-code' | 'openai' | 'gemini' | 'ollama' | 'custom-openai';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  events?: Array<{ kind: string; payload: unknown }>;
}

export interface ChatBlockProposalSnapshot {
  name: string;
  path?: string;
  domain: string;
  owner: string;
  description: string;
  sql: string;
  tags?: string[];
  chartType?: string;
  certified: boolean;
  errors: string[];
  warnings: string[];
}

export interface ChatCellConfig {
  provider?: ChatProviderId;
  history: ChatMessage[];
  upstream?: string;
  lastProposal?: ChatBlockProposalSnapshot;
  /**
   * Unified-panel thread (ThreadItem[]) for chat cells running on the governed
   * agent-run panel. Typed as `unknown[]` so `store/types` stays free of any
   * component import; `ChatCell` casts it to `ThreadItem[]`. The legacy
   * `history` field is retained for backward-compatible reads of older cells.
   */
  thread?: unknown[];
  /** Server-side conversation thread id, so reloads resume the same thread. */
  threadId?: string;
}

export type ParamType = 'text' | 'select' | 'date' | 'number';

export interface ParamConfig {
  paramType: ParamType;
  label: string;
  defaultValue: string;
  options?: string[];
}
export type SidebarPanel = 'files' | 'schema' | 'block_library' | 'connection' | 'lineage' | 'git' | 'apps' | 'readiness' | 'skills' | 'domains' | 'settings' | null;
export type DevPanelTab = 'logs' | 'errors';
export type MainView = 'home' | 'ask' | 'notebook' | 'business_artifact' | 'lineage' | 'lineage_detail' | 'block_studio' | 'imports' | 'connection' | 'git' | 'apps' | 'readiness' | 'skills' | 'domains' | 'modeling' | 'settings' | 'agent_log' | 'ask_trace' | 'ask_observability' | 'help' | 'host_page';

export type GlobalAiAudience = 'stakeholder' | 'analyst';

export interface GlobalAiSelectedObject {
  kind: 'notebook' | 'cell' | 'block' | 'app' | 'dashboard' | 'research' | 'workspace';
  id?: string;
  title?: string;
  path?: string;
}

export interface GlobalAiContext {
  selectedObject?: GlobalAiSelectedObject;
  workspaceContext?: Record<string, unknown>;
  scopeHint?: string;
  title?: string;
  /** Contextual suggested questions (e.g. the app's uncovered analysis gaps). */
  suggestedQuestions?: string[];
}

export interface GlobalAiState {
  open: boolean;
  audience: GlobalAiAudience;
  context: GlobalAiContext;
  autoRun?: { text: string; mode?: string; nonce: number };
}
export type AppWorkspaceExperience = 'view' | 'build';
export type AppWorkspaceSection = 'dashboards' | 'notebooks' | 'research' | 'ai' | 'drafts' | 'settings';
export type LineageReturnTarget =
  | {
      view: 'apps';
      appId: string;
      dashboardId?: string | null;
      label?: string;
      experience?: AppWorkspaceExperience;
      section?: AppWorkspaceSection;
    };

/**
 * Apps consumption-layer surface — list of Apps + currently-open App.
 * Source of truth lives on disk (`apps/<id>/dql.app.json`). The store caches
 * a summarised view for the UI; full documents are lazy-loaded.
 */
export interface AppSummary {
  id: string;
  name: string;
  fingerprint: string;
  filePath?: string;
  domain: string;
  ownerDomain?: string;
  usesDomains: string[];
  purpose?: string;
  requiredExports: string[];
  classification?: string;
  subdomain?: string;
  groups?: string[];
  description?: string;
  audience?: string;
  lifecycle?: 'draft' | 'review' | 'certified' | 'deprecated';
  certification?: 'certified' | 'uncertified';
  /** Who published the App as certified, and when (D5). */
  certifiedBy?: string;
  certifiedAt?: string;
  /** How many data tiles were certified when the App was published (B6). */
  tileTrust?: { certified: number; total: number };
  /** When the App's document or pages last changed. */
  updatedAt?: string;
  status?: 'ready' | 'empty' | 'review';
  storage?: 'shared' | 'mine' | 'template';
  visibility?: 'shared' | 'private' | 'template';
  publicationIntent?: 'personal' | 'shared_project';
  owners: string[];
  /** The first owner as a person reads it (this machine's person by their display name). */
  ownerName?: string;
  tags: string[];
  members: number;
  roles: number;
  policies: number;
  schedules: number;
  dashboards: Array<{ id: string; title: string }>;
  notebooks?: Array<{ path: string; title?: string; role: 'source' | 'analysis' | 'supporting'; visibility: 'shared' | 'private' | 'template' }>;
  drafts?: Array<{ path: string; name: string; reviewStatus?: string }>;
  aiPins?: number;
  investigations?: number;
  homepage?: { type: 'dashboard'; id: string } | { type: 'notebook'; path: string };
}

// ── Readiness / Propose backbone ("AI drafts, humans certify") ─────────────
// Mirrors the `/api/propose` (buildProposeReadiness) response from the CLI
// local runtime. Each proposal is a DRAFT block with a stored Certifier verdict;
// nothing here is ever certified — promotion is a separate human action.

export interface ProposalCertifierNote {
  rule: string;
  message: string;
}

export interface ProposalCertification {
  certified: false;
  errors: ProposalCertifierNote[];
  warnings: ProposalCertifierNote[];
}

export interface ProposalRanking {
  fanOut: number;
  exposureLinked: boolean;
  runCount: number;
  score: number;
}

export type ProposeClassification = 'business' | 'plumbing' | 'niche';

export interface ReadinessProposal {
  model: string;
  slug: string;
  domain: string;
  classification?: ProposeClassification;
  evidence?: string[];
  owner?: string;
  inference: {
    pattern: string;
    grain?: string;
    declaredOutputs: string[];
    entities: string[];
    invariants: string[];
    tags: string[];
  };
  ranking: ProposalRanking;
  /** Path of an already-written draft, when one exists. */
  path?: string;
  /** Why a draft was skipped on a previous run (already exists, etc.). */
  skipped?: string;
  certification: ProposalCertification;
}

export interface ProposeReadinessSummary {
  projectName?: string;
  modelsScanned: number;
  businessModels: number;
  plumbingExcluded: number;
  metricsFound: number;
  proposalsRanked: number;
  draftsExisting: number;
  readyForReview: number;
  blockingTotal: number;
  warningTotal: number;
  /** Review-latency / conversion telemetry for the draft queue (R2.2). */
  reviewTelemetry?: {
    existingDrafts: number;
    medianReviewAgeHours: number | null;
    readyForReviewRate: number | null;
    estimatedReviewMinutes: number;
  };
}

// ── Deterministic PLAN (classify → plan → approve) ─────────────────────────

/** Plain-language Certifier verdict shared by the propose preview and AI Build. */
export interface AiBuildCertifierVerdict {
  blocking: string[];
  warnings: string[];
  ready: boolean;
}

/** Snapshot-bound provenance for a direct AI Build proposal; never a certification. */
export interface AiBuildTrustDiagnostics {
  sourceTrust: 'governed_semantic_source' | 'exploratory_dbt_grounded';
  reviewRequired: true;
  contextPackId?: string;
  snapshotId?: string;
  activeDomain?: string;
  selectedSkillIds: string[];
  selectedSkillProvenance: Array<{ id: string; qualifiedId?: string; provenance?: string }>;
  allowedRelations: string[];
  joinPolicy: 'semantic_definition' | 'dbt_hints_are_not_governed_proof';
  warnings: string[];
}

export interface ProposePlanCandidate {
  model: string;
  slug: string;
  score: number;
  classification: ProposeClassification;
  owner?: string;
  evidence: string[];
  grain?: string;
  pattern?: string;
  // ── Spec 14 (part A) — OPTIONAL transparent-proposal preview fields.
  // Lazily fetched per-row via GET /api/propose/preview?slug=… so the Get
  // Started rows can show the artifact (SQL + outputs + examples + verdict)
  // instead of bare counts. All optional: a row renders fine without them.
  sqlPreview?: string;
  description?: string;
  llmContext?: string;
  examples?: string[];
  outputs?: string[];
  certifierVerdict?: AiBuildCertifierVerdict;
}

// ── Spec 14 (part B) — Unified AI Build result ─────────────────────────────
// The clean ARTIFACT returned by POST /api/ai/build. Build is split from Ask:
// it never routes through the Q&A answer-loop, so the result is a discriminated
// union over the target the user picked — a notebook CELL or a draft BLOCK.
export type AiBuildResult =
  | {
      target: 'cell';
      sql: string;
      explanation?: string;
      // Spec 16 — skills that guided this build (backend-populated).
      appliedSkills?: Array<{ id: string; description?: string }>;
      diagnostics?: AiBuildTrustDiagnostics;
      // Spec 17 (part C) — how the answer was reached (backend-populated).
      route?: AiRoute;
    }
  | {
      target: 'block';
      path: string;
      name: string;
      sqlPreview: string;
      description: string;
      grain?: string;
      outputs: string[];
      examples: string[];
      certifierVerdict: AiBuildCertifierVerdict;
      // Spec 16 — skills that guided this build (backend-populated).
      appliedSkills?: Array<{ id: string; description?: string }>;
      diagnostics?: AiBuildTrustDiagnostics;
      // Spec 17 (part A) — the block's SQL before an edit-mode build, for a
      // before/after diff. Present only when mode:'edit' was requested.
      previousSql?: string;
      // Spec 17 (part C) — how the answer was reached (backend-populated).
      route?: AiRoute;
    };

export type AiBuildTarget = AiBuildResult['target'];

// ── Spec 17 (part A) — Flexible authoring: create vs edit an existing block ───
export type AiBuildMode = 'create' | 'edit';

// ── Spec 17 (part C) — Smart routing: how an AI answer was reached ───────────
// A subtle, consumer-facing badge on AI results. `tier` is the route the
// backend took; `label` is a ready-to-render sentence; `ref` is the metric or
// block name the answer came from (when applicable).
export interface AiRoute {
  tier: 'certified_block' | 'semantic_metric' | 'generated_sql' | 'business_context' | 'no_answer';
  label: string;
  ref?: string;
}

// ── Spec 17 (part B) — Domains: the top of the domain→term→block hierarchy ────
// A first-class domain authored on the Domains page. Counts are backend-
// populated rollups; everything but id/name is optional so a freshly-created
// domain renders cleanly.
export interface Domain {
  id: string;
  name: string;
  parent?: string;
  owner?: string;
  businessOwner?: string;
  boundedContext?: string;
  sourceSystems?: string[];
  description?: string;
  primaryTerms?: string[];
  tags?: string[];
  businessOutcome?: string;
  reviewCadence?: string;
  inScope?: string[];
  outOfScope?: string[];
  dbtGroups?: string[];
  dbtPaths?: string[];
  dbtTags?: string[];
  semanticDomains?: string[];
  semanticTags?: string[];
  sourcePath?: string;
  blockCount?: number;
  skillCount?: number;
  termCount?: number;
}

// ── Spec 16 — Skills authoring & management ─────────────────────────────────
// A "skill" is a shared business-context file (`skills/*.skill.md`) the agent
// applies per question: definitions, rules, vocabulary, and preferred
// metrics/blocks. Project skills are shared across everyone's AI; personal
// skills are bound to one user. Three dbt-seeded starters ship editable
// (Metrics glossary, SQL conventions, Domain rules) — flagged via `isStarter`.
export interface Skill {
  id: string;
  localId?: string;
  qualifiedId?: string;
  scope: 'project' | 'personal';
  user?: string;
  description?: string;
  /** Business-context guidance prose the agent follows. */
  body: string;
  /** Metric names the AI should prefer when answering. */
  preferredMetrics: string[];
  /** Block names the AI should prefer when answering. */
  preferredBlocks: string[];
  /** Term → target map, e.g. `arr` → `metric:arr`, `revenue` → `block:revenue_by_region`. */
  vocabulary: Record<string, string>;
  /** On-disk source, e.g. `skills/metrics-glossary.skill.md`. */
  sourcePath: string;
  /** A dbt-seeded editable starter ("starter — edit me"). */
  isStarter?: boolean;
  /**
   * `private` lives under `.dql/local/`, outside Git, and shapes no answer
   * until it is published. `shared` (the default) is team guidance in Git.
   */
  visibility?: 'private' | 'shared';
  /** Spec 17 (part B) — the domain this skill belongs to (domain id). */
  domain?: string;
  domains?: string[];
  /** Optional focused Model Areas; narrows ranking inside the selected domain only. */
  modelAreaRefs?: string[];
  kind?: 'domain_reference' | 'metric_policy' | 'glossary' | 'analysis_pattern' | 'sql_policy' | 'custom';
  status?: 'draft' | 'active' | 'deprecated';
  owner?: string;
  triggers?: string[];
  exclusions?: string[];
  preferredDimensions?: string[];
  requiredFilters?: string[];
  clarifyWhen?: string[];
  examples?: string[];
  sourceRefs?: string[];
  analyticalPolicy?: {
    metricIds?: string[];
    timeRole?: string;
    calendarId?: string;
    timezone?: string;
    completenessPolicy?: 'partial_current' | 'latest_complete' | 'closed_period';
    comparisonAlignment?: 'elapsed_period' | 'calendar_period' | 'fiscal_period';
    defaultRankingPeriod?: 'current' | 'comparison';
    narrativeGuidance?: string[];
  };
}

export interface SkillPathSettings {
  /** Value stored in dql.config.json; relative paths resolve from the ZLens project root. */
  path: string;
  resolvedPath: string;
  exists: boolean;
  skillCount: number;
  errorCount: number;
}

/** Skills that shaped an AI answer — surfaced as the "guided by" line. */
export interface AppliedSkill {
  id: string;
  description?: string;
}

export interface ProposePlanDomain {
  name: string;
  owner?: string;
  modelCount: number;
  candidates: ProposePlanCandidate[];
}

export interface ProposePlanConfig {
  businessLayers: string[];
  excludeLayers: string[];
  maxPerDomain: number;
  minScore: number;
  aiEnrichment: 'auto' | 'on' | 'off';
}

export interface ProposePlan {
  totals: {
    modelsScanned: number;
    businessModels: number;
    plumbingExcluded: number;
    metricsFound: number;
  };
  willGenerate: number;
  willSkip: number;
  domains: ProposePlanDomain[];
  config: ProposePlanConfig;
}

export interface ProposeReadiness {
  ready: boolean;
  reason?: string;
  summary: ProposeReadinessSummary;
  plan: ProposePlan;
  proposals: ReadinessProposal[];
}

/** Result of materializing approved drafts via POST /api/propose/generate. */
export interface ProposeGenerateResult {
  ready: boolean;
  reason?: string;
  draftsWritten: number;
  draftsSkipped: number;
  proposals: ReadinessProposal[];
}

export interface ActivePersona {
  userId: string;
  displayName?: string;
  roles: string[];
  attributes: Record<string, string | number | boolean>;
  rlsContext: Record<string, string | number | boolean>;
  appId?: string;
}

/** What a result column is, from the governed vocabulary; the units every renderer reads. */
export interface ResultColumnMeta {
  name: string;
  kind: 'currency' | 'percent' | 'number' | 'count' | 'duration' | 'date' | 'text' | 'boolean';
  unit?: string;
  decimals?: number;
  ref?: string;
  grain?: string;
  /** The name readers see, set by the author on the tile's shelves (RFC 0009). */
  label?: string;
  /** Short numbers (1.2K), chosen by the author for this field. */
  notation?: 'compact';
  /** Exact decimals chosen by the author for this field. */
  fixedDecimals?: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Units per column; absent on legacy results, which render exactly as before. */
  columnsMeta?: ResultColumnMeta[];
  resultFingerprint?: string;
  executionReceipt?: Record<string, unknown>;
  trustState?: string;
  answerTier?: string;
  executionTime?: number;
  rowCount?: number;
  semanticRefs?: {
    metrics: string[];
    dimensions: string[];
  };
}

export interface NotebookCellExecutionEvidence {
  version: 1;
  runId: string;
  cellId: string;
  route: "notebook_sql_cell" | "notebook_dql_cell";
  status: "success" | "error" | "cancelled" | "blocked";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  executionTarget?: ExecutionTarget;
  engine?: "native" | "metricflow-cli" | "dbt-cloud";
  compiledSql?: string;
  executedSql?: string;
  semanticTrace?: {
    version?: number;
    adapter?: string;
    status?: string;
    authoringRequest?: Record<string, unknown>;
    runtimeRequest?: Record<string, unknown>;
    bindings?: Array<Record<string, unknown>>;
    warnings?: string[];
    steps?: Array<{ id?: string; label?: string; status?: string; detail?: string }>;
    failure?: Record<string, unknown>;
  };
  targetBinding?: Record<string, unknown>;
  executionReceipt?: Record<string, unknown>;
  /** Immutable failure provenance retained when a one-click repair succeeds. */
  repair?: {
    mode: "deterministic" | "ai";
    sourceRunId?: string;
    originalSource: string;
    originalCompiledSql?: string;
    originalExecutedSql?: string;
    originalError: {
      code?: string;
      phase?: string;
      message: string;
      details?: unknown;
    };
  };
  error?: {
    code?: string;
    phase?: string;
    message: string;
    details?: unknown;
  };
}

export interface RunSnapshotCell {
  cellId: string;
  status: CellStatus;
  result?: QueryResult;
  error?: string;
  executionCount?: number;
  executedAt?: string;
  execution?: NotebookCellExecutionEvidence;
}

export interface RunSnapshot {
  version: 1;
  notebookPath: string;
  capturedAt: string;
  cells: RunSnapshotCell[];
}

/**
 * A bound cell is a live reference to a `.dql` block file.
 * - `bound`: content matches the block file
 * - `forked`: user edited locally, diverged from file
 *
 * `originalContent` is the canonical cell body derived from the block on bind/revert;
 * divergence is detected by comparing `cell.content` to this.
 */
export interface BlockBinding {
  path: string;
  commitSha?: string;
  version?: string;
  /** Ephemeral values for the bound block's typed runtime parameters. */
  parameterValues?: Record<string, unknown>;
  state: 'bound' | 'forked';
  originalContent?: string;
}

/**
 * Governed DQL provenance attached to an AI-generated (or Explore-scaffolded) query
 * cell. The cell executes via its compiled SQL body, while this preserves the
 * governed DQL so the cell can display it and be saved as a reusable block.
 */
export interface CellDqlArtifact {
  source: string;          // the governed DQL source (block DSL or @metric/@dim form)
  sql?: string;            // compiled SQL preview the cell executes
  name?: string;           // display name / suggested block name
  sourcePath?: string;     // set when already backed by a saved block file
  kind?: string;           // artifact kind (e.g. semantic_block, sql_block)
  metrics?: string[];
  dimensions?: string[];
  parameters?: BlockParameterDefinition[];
  parameterValues?: Record<string, unknown>;
  persistence?: "transient" | "saved";
  trustState?: "certified" | "governed" | "review_required";
  compiledSql?: string;
  routeEvidence?: Array<Record<string, unknown>>;
  lineage?: Record<string, unknown>;
  reviewState?: "certified" | "draft" | "review_required";
  /** The question this artifact answered — lets an edit be captured as a correction. */
  question?: string;
}

/**
 * Immutable origin evidence for an AI draft that may later become a governed
 * correction candidate. This is deliberately separate from `dqlArtifact`:
 * generated SQL can be taught without pretending it is a DQL block, while
 * saved/certified DQL remains on its normal draft/review/recertify path.
 */
export interface CellCorrectionProvenance {
  version: 1;
  source: "agent_run";
  question: string;
  generatedSql?: string;
  generatedDql?: string;
  sourceRunId?: string;
}

export interface ExecutionTarget {
  target: "connection" | "local";
  /** Named project connection. Credentials remain in project connection storage. */
  connectionName?: string;
}

export interface DatasetReference {
  id: string;
  alias?: string;
  role?: "source" | "staged" | "output";
  fingerprint?: string;
}

export interface CellDependency {
  cellId: string;
  /** Named result handle consumed by this cell. Defaults to the source cell name. */
  output?: string;
}

export interface CellAnnotation {
  id: string;
  body: string;
  kind?: "note" | "assumption" | "finding" | "decision" | "caveat";
  createdAt: string;
  updatedAt?: string;
  author?: string;
}

export interface CellKernelMetadata {
  language?: "python";
  environment?: string;
  requirements?: string[];
  resourcePolicy?: Record<string, unknown>;
}

export interface Cell {
  id: string;
  type: CellType;
  content: string;
  name?: string;
  status: CellStatus;
  result?: QueryResult;
  error?: string;
  execution?: NotebookCellExecutionEvidence; // Per-cell run identity, compiler/target proof, and stable failure evidence
  executionCount?: number;
  paramConfig?: ParamConfig;
  paramValue?: string;
  chartConfig?: CellChartConfig; // Chart cell binding (also used for SQL-cell chart view)
  filterConfig?: FilterCellConfig; // Filter cell
  pivotConfig?: PivotCellConfig; // Pivot cell
  singleValueConfig?: SingleValueCellConfig; // Single-value cell
  tableConfig?: TableCellConfig; // Table cell
  chatConfig?: ChatCellConfig; // Chat cell (v1.2 Track C)
  upstream?: string; // Dataframe handle this cell consumes
  blockBinding?: BlockBinding; // Present when cell references a .dql block file
  dqlParameterValues?: Record<string, unknown>; // Ephemeral values for an inline DQL cell
  dqlArtifact?: CellDqlArtifact; // Governed DQL provenance for AI/Explore-generated cells
  correctionProvenance?: CellCorrectionProvenance; // Original AI draft/question for explicit Teach DQL
  executionTarget?: ExecutionTarget; // Named warehouse connection or local DuckDB workspace
  datasetRefs?: DatasetReference[]; // Imported or staged datasets used by the cell
  dependencies?: CellDependency[]; // Explicit, stable cell dependency graph
  annotations?: CellAnnotation[]; // OSS cell notes (not collaborative threads)
  mixedSourcePlan?: MixedSourceNotebookPlan; // AI-authored warehouse -> local dataset handoff
  kernel?: CellKernelMetadata; // Reserved until a supportable Python runtime ships
  stale?: boolean; // A dependency changed after this result was produced
  /** Unrecognised v2+ fields retained verbatim during read-edit-save. */
  preservedFields?: Record<string, unknown>;
  fromSnapshot?: boolean; // Result was hydrated from .run.json, not executed this session
}

export interface NotebookFile {
  name: string;
  path: string;
  type: 'notebook' | 'workbook' | 'block' | 'dashboard' | 'term' | 'business_view';
  folder: string;
  /** Canonical ProductDomainContext for virtual Domain folders in the UI. */
  ownerDomain?: string;
  usesDomains?: string[];
  isNew?: boolean;
  /**
   * `private` lives under `.dql/local/` and is invisible to git until it is
   * published; `shared` (the default) is a tracked path the team reviews.
   */
  visibility?: 'private' | 'shared';
}

export interface SchemaColumn {
  name: string;
  type: string;
}

export type GovernanceStatus = 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification';

export interface SchemaTable {
  name: string;
  path: string;
  columns: SchemaColumn[];
  expanded?: boolean;
  source?: 'file' | 'database';
  objectType?: string;
  /** dbt identity for a relation loaded from the bounded dbt catalog. */
  dbtUniqueId?: string;
  dbtResourceType?: 'model' | 'source' | 'warehouse';
  dbtSourcePath?: string;
  datasetId?: string;
  fileFingerprint?: string;
  storageMode?: 'local' | 'project' | 'staged';
  refreshedAt?: string;
  trustState?: string;
  governance?: {
    status?: GovernanceStatus;
    owner?: string;
    domain?: string;
  };
}

export interface SemanticMetric {
  name: string;
  label: string;
  description: string;
  domain: string;
  sql: string;
  type: string;
  table: string;
  tags: string[];
  owner: string | null;
  /** Owning semantic model when the metric resolves to exactly one model. */
  cube?: string | null;
  /** Exact owners for derived and cross-model metrics. */
  semanticModelIds?: string[];
  canonicalId?: string;
  metricType?: string | null;
  typeParams?: Record<string, unknown> | null;
  filter?: unknown;
  source?: Record<string, unknown> | null;
  execution?: {
    status: 'ready' | 'requires_setup' | 'unsupported';
    engine: 'native' | 'metricflow-cli' | 'dbt-cloud' | null;
    reason: string | null;
    reasonCode?: 'SEMANTIC_SOURCE_DRIFT';
    semanticCatalogFingerprint?: string;
  };
}

export interface SemanticMeasure {
  name: string;
  label: string;
  description: string;
  domain?: string;
  agg: string;
  expr?: string | null;
  table: string;
  cube?: string | null;
  aggTimeDimension?: string | null;
  tags: string[];
  owner: string | null;
}

export interface SemanticDimension {
  name: string;
  /** Provider-neutral model-scoped identity persisted in DQL. */
  reference?: string;
  /** Stable snapshot/search identity. */
  canonicalId?: string;
  label: string;
  description: string;
  domain?: string;
  sql: string;
  type: string;
  table: string;
  tags: string[];
  owner: string | null;
  cube?: string | null;
  isTimeDimension?: boolean;
  /** MetricFlow-qualified group-by name (`<entity>__<name>`), when known. */
  qualifiedName?: string | null;
  /** Owning MetricFlow entity, used to explain adapter qualification. */
  entityLink?: string | null;
  /** Real queryable grains for a time dimension. */
  granularities?: string[] | null;
  typeParams?: Record<string, unknown> | null;
}

/** The full compatibility answer: which dimensions a metric set can be grouped
 *  by, which cannot (with reasons), and which engine produced the answer. */
export interface SemanticCompatibility {
  dimensions: SemanticDimension[];
  engine: 'native' | 'metricflow-cli' | 'dbt-cloud';
  incompatible: Array<{ name: string; qualifiedName?: string | null; reason: string }>;
  degraded?: string | null;
}

export interface SemanticEntity {
  name: string;
  label: string;
  description: string;
  domain?: string;
  type: string;
  expr?: string | null;
  table: string;
  cube?: string | null;
  role?: string | null;
  tags: string[];
  owner: string | null;
}

export interface SemanticModel {
  name: string;
  label: string;
  description: string;
  domain?: string;
  model?: string | null;
  table: string;
  entities: string[];
  measures: string[];
  dimensions: string[];
  timeDimensions: string[];
  tags: string[];
  owner: string | null;
}

export interface SemanticSavedQuery {
  name: string;
  label: string;
  description: string;
  domain?: string;
  metrics: string[];
  dimensions: string[];
  timeDimension?: string | null;
  granularity?: string | null;
  filters?: unknown;
  tags: string[];
  owner: string | null;
}

export interface SemanticHierarchy {
  name: string;
  label: string;
  description: string;
  domain?: string;
  levels: Array<{ name: string; label: string }>;
}

export interface SemanticTreeNode {
  id: string;
  label: string;
  kind: 'provider' | 'domain' | 'cube' | 'group' | 'metric' | 'measure' | 'dimension' | 'time_dimension' | 'entity' | 'hierarchy' | 'segment' | 'pre_aggregation' | 'semantic_model' | 'saved_query';
  count?: number;
  meta?: Record<string, string | number | boolean | null | undefined>;
  children?: SemanticTreeNode[];
}

export interface SemanticObjectDetail {
  id: string;
  kind: 'cube' | 'metric' | 'measure' | 'dimension' | 'time_dimension' | 'entity' | 'hierarchy' | 'segment' | 'pre_aggregation' | 'semantic_model' | 'saved_query';
  name: string;
  label: string;
  description: string;
  domain: string;
  cube?: string;
  table?: string;
  sql?: string;
  type?: string;
  reference?: string;
  qualifiedName?: string;
  entityLink?: string;
  tags: string[];
  owner: string | null;
  source: {
    provider: string;
    objectType: string;
    objectId: string;
    objectName?: string;
    importedAt?: string;
    extra?: Record<string, unknown>;
  } | null;
  filePath: string | null;
  importedAt: string | null;
  joins?: Array<{ name: string; left: string; right: string; type: string; sql: string }>;
  levels?: Array<{ name: string; label: string; description: string; dimension: string; order: number }>;
  measures?: string[];
  dimensions?: string[];
  timeDimension?: string;
  granularity?: string;
  refreshKey?: string;
  agg?: string;
  expr?: string;
  metricType?: string;
  typeParams?: Record<string, unknown>;
  filter?: unknown;
  entities?: string[];
  savedQueryMetrics?: string[];
  exports?: Array<Record<string, unknown>>;
}

export interface SemanticLayerState {
  available: boolean;
  provider: string | null;
  execution?: {
    engine: 'native' | 'metricflow-cli' | 'dbt-cloud';
    ready: boolean;
    setup: string | null;
    adapters?: Array<{
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
  metrics: SemanticMetric[];
  measures: SemanticMeasure[];
  dimensions: SemanticDimension[];
  timeDimensions: SemanticDimension[];
  entities: SemanticEntity[];
  hierarchies: SemanticHierarchy[];
  semanticModels: SemanticModel[];
  savedQueries: SemanticSavedQuery[];
  /** Semantic-catalog grouping only; never use as artifact ownership options. */
  domains: string[];
  tags: string[];
  favorites: string[];
  recentlyUsed: string[];
  loading: boolean;
  lastSyncTime: string | null;
}

export interface QueryLogEntry {
  id: string;
  cellName: string;
  rows: number;
  time: number;
  ts: Date;
  error?: string;
}

export interface BlockStudioDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  /** Short, user-facing label. The full compiler output belongs in technicalDetails. */
  title?: string;
  /** Form area that owns the problem, such as Metrics, Parameters, or DQL source. */
  field?: string;
  /** Exact semantic references or fields affected by this diagnostic. */
  references?: string[];
  /** Concrete next step that can resolve the problem. */
  correction?: string;
  /** Raw parser/compiler text, rendered only in a collapsed technical-details control. */
  technicalDetails?: string;
  /** Stable UI intent; the browser still decides how to perform the action. */
  action?: 'edit_source' | 'review_metrics' | 'configure_runtime' | 'edit_parameters' | 'run_again' | 'fix_description';
  /** For `fix_description`: the description the one-click fix writes before certifying. */
  suggestedDescription?: string;
  location?: { line?: number; column?: number };
}

export interface BlockStudioValidation {
  valid: boolean;
  /** Whether the draft may be persisted even when its execution runtime is unavailable. */
  saveable?: boolean;
  diagnostics: BlockStudioDiagnostic[];
  semanticRefs: {
    metrics: string[];
    dimensions: string[];
    segments: string[];
  };
  chartConfig?: CellChartConfig;
  executableSql?: string | null;
  parameters?: BlockParameterDefinition[];
}

export type BlockParameterDefinition = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'string[]' | 'number[]' | 'date[]';
  required: boolean;
  default?: unknown;
  policy: 'dynamic' | 'static' | 'business' | 'derived' | 'optional' | 'ambiguous_review_required';
  binding?: { kind: 'sql_value' | 'semantic_filter' | 'limit'; field?: string; operator?: 'equals' | 'in' | 'gte' | 'lte' };
};

export interface BlockStudioPreview {
  sql: string;
  result: QueryResult;
  chartConfig?: CellChartConfig;
  /** Runtime-aware validation produced by the same compile used for this result. */
  validation?: BlockStudioValidation;
  invocation?: {
    resolvedParameters: Array<{ name: string; value: unknown; source: 'policy' | 'explicit' | 'question' | 'prior_result' | 'surface' | 'default' }>;
    unresolvedParameters: string[];
    auditId: string;
  };
}

export interface BlockStudioRunSummary {
  rowCount: number;
  executionTime?: number;
  columns: string[];
  ranAt: string;
}

export interface BlockStudioMetadata {
  name: string;
  path: string | null;
  domain: string;
  /** Optional nested location below the domain's blocks root. */
  folderPath?: string;
  description: string;
  owner: string;
  tags: string[];
  reviewStatus?: string;
  /**
   * The receipt the explicit Certify action wrote into the companion YAML:
   * who certified this exact source, when, from which surface, under which
   * rules. Absent for drafts and for blocks certified before receipts existed.
   */
  certification?: {
    certifiedBy: string;
    /** The certifier's display name, when one was recorded. */
    certifiedByName?: string;
    certifiedAt: string;
    via: string;
    rules: 'oss' | 'enterprise';
    sourceSha256: string;
    checks?: string[];
    warnings?: string[];
  };
  /**
   * The source says certified but was edited after its receipt was written
   * (the receipt's sourceSha256 no longer matches). Ask treats it as pending
   * recertification until it is certified again.
   */
  certificationSourceChanged?: boolean;
  /** Fingerprint of the source that was opened; used for save/certify conflict checks. */
  sourceFingerprint?: string;
  sourceKind?: string;
  sourcePath?: string;
  importId?: string;
  candidateId?: string;
  lineage?: string[];
  /** Retired blocks: the replacement as written, the date, and the active block it resolves to. */
  replacedBy?: string;
  deprecatedOn?: string;
  replacement?: { name: string; path: string } | null;
}

export interface BlockStudioImportCandidate {
  id: string;
  sourceKind: 'raw-sql-file' | 'raw-sql-folder' | 'tableau-workbook' | 'powerbi-project';
  sourcePath: string;
  name: string;
  domain: string;
  description: string;
  owner: string;
  tags: string[];
  terms?: string[];
  pattern?: string;
  grain?: string;
  entities?: string[];
  outputs?: string[];
  dimensions?: string[];
  allowedFilters?: string[];
  parameterPolicy?: Array<{ name: string; policy: string }>;
  filterBindings?: BlockFilterBinding[];
  sourceSystems?: string[];
  replacementFor?: string[];
  reviewCadence?: string;
  parameterDecisions?: DqlParameterDecision[];
  similarityMatches?: BlockSimilarityMatch[];
  recommendedAction?: DqlCandidateRecommendedAction;
  sql: string;
  dqlSource: string;
  validation: BlockStudioValidation | null;
  preview: BlockStudioPreview | null;
  lineage: {
    sourceTables: string[];
    parameters: string[];
    warnings: string[];
    statementIndex: number;
    totalStatements: number;
  };
  confidence: number;
  splitStrategy?: 'semicolon-go' | 'metadata-comment' | 'statement-start' | 'manual';
  warnings?: string[];
  conversionNotes?: string[];
  aiAssistance?: Array<{
    action: string;
    summary: string;
    createdAt: string;
    status: 'suggested' | 'accepted' | 'rejected';
    provider?: string;
    patch?: Partial<Pick<BlockStudioImportCandidate, 'name' | 'domain' | 'description' | 'owner' | 'tags' | 'terms' | 'pattern' | 'grain' | 'entities' | 'outputs' | 'dimensions' | 'allowedFilters' | 'parameterPolicy' | 'filterBindings' | 'sourceSystems' | 'replacementFor' | 'reviewCadence' | 'sql' | 'dqlSource'>>;
  }>;
  certificationChecklist?: {
    metadata: boolean;
    validation: boolean;
    run: boolean;
    tests: boolean;
    chart: boolean;
    lineage: boolean;
    aiReviewed: boolean;
    blockers: string[];
    checkedAt?: string;
    };
    reviewStatus: 'draft' | 'review' | 'saved' | 'rejected';
    savedPath?: string;
    generationMode?: 'ai' | 'deterministic';
    generationProvider?: string;
    llmContext?: string;
    evidence?: DqlGenerationEvidence[];
    draftSave?: BlockDraftSaveState;
    analysisStatus?: 'queued' | 'retrieving' | 'reviewing' | 'previewing' | 'ready' | 'needs_attention';
  }

export interface DqlGenerationEvidence {
  kind: 'dql_block' | 'dql_term' | 'business_view' | 'domain' | 'semantic_metric' | 'semantic_model' | 'dbt_model' | 'warehouse_table' | 'datalex_contract' | 'datalex_entity' | 'datalex_domain' | 'datalex_term' | 'metadata' | 'lineage';
  name: string;
  description?: string;
  objectKey?: string;
  source?: string;
  reason?: string;
  confidence?: number;
}

export interface BlockDraftSaveState {
  status: 'pending' | 'saved' | 'error' | 'skipped';
  path?: string;
  savedAt?: string;
  error?: string;
  reason?: string;
}

export type DqlParameterPolicyKind = 'dynamic' | 'static' | 'business' | 'derived' | 'optional' | 'ambiguous_review_required';
export type DqlParameterValue = string | number | boolean | Array<string | number | boolean>;

export interface DqlParameterDecision {
  name: string;
  policy: DqlParameterPolicyKind;
  value: DqlParameterValue;
  valueType: 'string' | 'number' | 'boolean' | 'date' | 'year' | 'set';
  sourceExpression: string;
  reason: string;
  confidence: number;
}

export interface BlockFilterBinding {
  filter: string;
  binding: string;
}

export type BlockSimilarityMatchKind =
  | 'exact_sql_match'
  | 'parameterized_duplicate'
  | 'business_duplicate'
  | 'near_variant'
  | 'source_variant'
  | 'new_logic';

export type DqlCandidateRecommendedAction =
  | 'reuse_existing'
  | 'extend_existing'
  | 'create_replacement'
  | 'create_new'
  | 'review_required';

export interface BlockSimilarityMatch {
  kind: BlockSimilarityMatchKind;
  objectKey?: string;
  name: string;
  status?: string;
  source?: string;
  score: number;
  reason: string;
  recommendedAction: DqlCandidateRecommendedAction;
}

export type DqlGenerationCandidate = BlockStudioImportCandidate & {
  generationMode: 'ai' | 'deterministic';
  generationProvider: string;
  llmContext: string;
  evidence: DqlGenerationEvidence[];
  draftSave: BlockDraftSaveState;
};

export interface BlockStudioImportSession {
  id: string;
  sourceKind: BlockStudioImportCandidate['sourceKind'];
  inputPath: string;
  inputMode?: 'path' | 'paste' | 'upload';
  sourceFiles?: string[];
  createdAt: string;
  updatedAt: string;
  defaults: {
    domain: string;
    owner: string;
    tags: string[];
  };
  candidateIds: string[];
  /** Statements that got no draft: they change data, run a procedure, or repeat a query already in this import. */
  skippedStatements?: BlockStudioImportSkippedStatement[];
  candidates: BlockStudioImportCandidate[];
}

/** What an import made of one Tableau or Power BI calculation (D3): a metric draft, an existing metric, or why not. */
export interface ImportMetricDraftItem {
  calculation: string;
  formula: string;
  language: 'tableau' | 'dax';
  sourcePath: string;
  owner?: string;
  kind: 'simple' | 'filtered' | 'ratio' | 'row-level' | 'advanced';
  outcome: 'drafted' | 'reused' | 'failed' | 'left-out' | 'row-level' | 'advanced';
  metric?: string;
  path?: string;
  inWords?: string;
  value?: number | null;
  reason?: string;
  notes: string[];
  parts?: string[];
}

export interface ImportMetricDrafts {
  importId: string;
  domain: string;
  ranAt: string;
  written: boolean;
  notWrittenReason?: string;
  checked: boolean;
  items: ImportMetricDraftItem[];
  /** Columns of the drafts' tables written as dimension drafts: what the metrics can group by once approved. */
  dimensions: Array<{ name: string; label: string; table: string; path: string }>;
}

export interface BlockStudioImportSkippedStatement {
  sourcePath: string;
  kind: 'writes' | 'duplicate' | 'runs-procedure' | 'not-a-query' | 'no-sql' | 'calculations' | 'unreadable';
  reason: string;
  sql: string;
}

export interface DqlGenerationSession extends Omit<BlockStudioImportSession, 'candidates'> {
  mode: 'ai-import';
  persistence?: 'session-only' | 'draft-files';
  generation: {
    provider: string;
    aiEnabled: boolean;
    contextObjectCount: number;
    createdDrafts: number;
    warnings: string[];
  };
  candidates: DqlGenerationCandidate[];
}

export interface BlockStudioImportSessionSummary {
  id: string;
  sourceKind: BlockStudioImportCandidate['sourceKind'];
  inputMode: 'path' | 'paste' | 'upload';
  inputPath: string;
  sourceFiles: string[];
  createdAt: string;
  updatedAt: string;
  defaults: {
    domain: string;
    owner: string;
    tags: string[];
  };
  candidateCount: number;
  savedCount: number;
  rejectedCount: number;
  warningCount: number;
}

export interface DatabaseSchemaNode {
  id: string;
  label: string;
  kind: 'schema' | 'table' | 'column';
  path?: string;
  type?: string;
  children?: DatabaseSchemaNode[];
}

export interface BlockStudioCatalog {
  semanticTree: SemanticTreeNode | null;
  databaseTree: DatabaseSchemaNode[];
  connection: {
    default: string;
    current: string;
    connections: Record<string, unknown>;
  };
  favorites: string[];
  recentlyUsed: string[];
}

export interface DbtArtifactStatus {
  path: string;
  exists: boolean;
  count?: number;
  generatedAt?: string | null;
}

export interface BlockStudioDbtStatus {
  configured: boolean;
  provider: string | null;
  projectPath: string | null;
  projectName?: string | null;
  artifacts: {
    manifest: DbtArtifactStatus;
    catalog: DbtArtifactStatus;
    semanticManifest: DbtArtifactStatus;
    runResults: DbtArtifactStatus;
  };
  counts: {
    models: number;
    sources: number;
    metrics: number;
    semanticModels: number;
    savedQueries: number;
  };
  lastSyncTime?: string | null;
  setupHint: string;
}

export interface SemanticLayerDiagnostics {
  available: boolean;
  provider: string | null;
  errors: string[];
  lastSyncTime?: string | null;
  counts: {
    domains: number;
    metrics: number;
    measures: number;
    dimensions: number;
    timeDimensions?: number;
    entities?: number;
    hierarchies?: number;
    semanticModels: number;
    savedQueries: number;
  };
  dbt: BlockStudioDbtStatus;
  sourceOfTruth?: string;
  issues?: Array<{
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
    action?: string;
    path?: string;
  }>;
  warnings: string[];
}

export interface BlockStudioOpenPayload {
  path: string;
  source: string;
  metadata: BlockStudioMetadata;
  companionPath: string | null;
  validation: BlockStudioValidation;
  /** Compact, source-fingerprint-bound local receipt. Result rows are never persisted here. */
  lastRun?: BlockStudioRunSummary;
  /** Redacted save-time compiler outcome; the block may still be safely saved when this fails. */
  lineageRefresh?: {
    status: 'queued' | 'ready' | 'failed';
    operationId?: string;
    compiledAt?: string;
    message?: string;
  };
}

export type SettingsTab = 'overview' | 'project' | 'database' | 'ai' | 'memory' | 'advanced';

export interface NotebookState {
  mainView: MainView;
  /** Active section in the canonical Settings hub. */
  settingsTab: SettingsTab;
  themeMode: ThemeMode;
  appMode: AppMode;
  sidebarPanel: SidebarPanel;
  sidebarOpen: boolean;
  files: NotebookFile[];
  filesLoading: boolean;
  activeFile: NotebookFile | null;
  cells: Cell[];
  notebookTitle: string;
  notebookMetadata: NotebookDocMetadata;
  notebookDirty: boolean;
  schemaTables: SchemaTable[];
  schemaLoading: boolean;
  /** First-class human-authored Domain page declarations from `/api/domains`. */
  authoredDomains: Domain[];
  semanticLayer: SemanticLayerState;
  devPanelOpen: boolean;
  devPanelTab: DevPanelTab;
  queryLog: QueryLogEntry[];
  newNotebookModalOpen: boolean;
  newBlockModalOpen: boolean;
  newBlockModalDefaultType: 'custom' | 'semantic';
  autoSave: boolean;
  executionCounter: number;
  savingFile: boolean;
  lineageFullscreen: boolean;
  lineageFocusNodeId: string | null;
  lineageReturnTarget: LineageReturnTarget | null;
  lineageDrawerOpen: boolean;
  lineageDrawerNodeId: string | null;
  dashboardMode: boolean;
  activeBlockPath: string | null;
  blockStudioDraft: string;
  blockStudioDirty: boolean;
  blockStudioPreview: BlockStudioPreview | null;
  blockStudioLastRun: BlockStudioRunSummary | null;
  blockStudioValidation: BlockStudioValidation | null;
  blockStudioMetadata: BlockStudioMetadata | null;
  blockStudioCatalog: BlockStudioCatalog | null;
  blockStudioCatalogLoading: boolean;
  blockStudioImportOpen: boolean;
  blockStudioDbtStatus: BlockStudioDbtStatus | null;
  /** Full-screen Setup Onboarding wizard overlay (5-step workspace setup). */
  setupOpen: boolean;
  /** The Welcome screen's answer to "Where does your data model live?", preselected in Guided Setup. */
  setupModelSource: 'dbt' | 'warehouse' | 'both' | 'existing' | null;
  inspectorOpen: boolean;
  inspectorContext: InspectorContext | null;
  // Apps surface (Phase 1)
  apps: AppSummary[];
  appsLoading: boolean;
  activeAppId: string | null;
  /** Local AppBuildDraft to open directly in the unified Studio. */
  activeAppDraftId: string | null;
  activeDashboardId: string | null;
  activeAppExperience: AppWorkspaceExperience;
  activeAppSection: AppWorkspaceSection;
  activePersona: ActivePersona | null;
  // Global, context-aware AI right rail (stakeholder copilot across surfaces).
  globalAi: GlobalAiState;
  // The agent run currently open in the Agent Steps (agent_log) page, if any.
  agentLogRun?: AgentRun;
  /** OBS-009: only the requested run id is durable navigation state. */
  askTraceRunId?: string;
}

export type InspectorContext =
  | { kind: 'cell'; cellId: string }
  | { kind: 'lineage-node'; nodeId: string }
  | { kind: 'metric'; name: string };

export type NotebookAction =
  | { type: 'SET_MAIN_VIEW'; view: MainView }
  | { type: 'OPEN_AGENT_LOG'; run: AgentRun }
  | { type: 'OPEN_ASK_TRACE'; runId: string }
  /** OBS-013: local Ask trace catalog. Only a route is stored, never trace payloads. */
  | { type: 'OPEN_ASK_OBSERVABILITY' }
  | { type: 'SET_SETTINGS_TAB'; tab: SettingsTab }
  | { type: 'SET_THEME'; mode: ThemeMode }
  | { type: 'SET_APP_MODE'; mode: AppMode }
  | { type: 'SET_SIDEBAR_PANEL'; panel: SidebarPanel }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_FILES'; files: NotebookFile[] }
  | { type: 'SET_FILES_LOADING'; loading: boolean }
  | { type: 'OPEN_BUSINESS_ARTIFACT'; file: NotebookFile }
  | { type: 'OPEN_FILE'; file: NotebookFile; cells: Cell[]; title: string; metadata?: NotebookDocMetadata }
  | { type: 'UPDATE_NOTEBOOK_METADATA'; updates: Partial<NotebookDocMetadata> }
  | { type: 'SET_CELLS'; cells: Cell[] }
  | { type: 'ADD_CELL'; cell: Cell; afterId?: string }
  | { type: 'UPDATE_CELL'; id: string; updates: Partial<Cell> }
  | { type: 'DELETE_CELL'; id: string }
  | { type: 'MOVE_CELL'; id: string; direction: 'up' | 'down' }
  | { type: 'SET_SCHEMA'; tables: SchemaTable[] }
  | { type: 'MERGE_SCHEMA_TABLES'; tables: SchemaTable[] }
  | { type: 'SET_SCHEMA_LOADING'; loading: boolean }
  | { type: 'SET_AUTHORED_DOMAINS'; domains: Domain[] }
  | { type: 'TOGGLE_SCHEMA_TABLE'; tableName: string }
  | { type: 'TOGGLE_DEV_PANEL' }
  | { type: 'SET_DEV_PANEL_TAB'; tab: DevPanelTab }
  | { type: 'APPEND_QUERY_LOG'; entry: QueryLogEntry }
  | { type: 'OPEN_NEW_NOTEBOOK_MODAL' }
  | { type: 'CLOSE_NEW_NOTEBOOK_MODAL' }
  | { type: 'OPEN_NEW_BLOCK_MODAL'; blockType?: 'custom' | 'semantic' }
  | { type: 'CLOSE_NEW_BLOCK_MODAL' }
  | { type: 'SET_AUTO_SAVE'; enabled: boolean }
  | { type: 'SET_NOTEBOOK_DIRTY'; dirty: boolean }
  | { type: 'SET_SAVING'; saving: boolean }
  | { type: 'FILE_ADDED'; file: NotebookFile }
  | { type: 'FILE_REMOVED'; path: string }
  | { type: 'SET_TABLE_COLUMNS'; tableName: string; columns: SchemaColumn[] }
  | { type: 'SET_PARAM_VALUE'; id: string; value: string }
  | { type: 'SET_SEMANTIC_LAYER'; layer: Omit<SemanticLayerState, 'loading'> }
  | { type: 'SET_SEMANTIC_LOADING'; loading: boolean }
  | { type: 'SET_SEMANTIC_FAVORITES'; favorites: string[] }
  | { type: 'ADD_SEMANTIC_RECENT'; name: string }
  | { type: 'SET_SEMANTIC_DOMAINS'; domains: string[]; tags: string[]; lastSyncTime?: string | null }
  | { type: 'TOGGLE_LINEAGE_FULLSCREEN' }
  | { type: 'SET_LINEAGE_FOCUS'; nodeId: string | null }
  | { type: 'OPEN_LINEAGE_DETAIL'; nodeId: string; returnTo?: LineageReturnTarget | null }
  | { type: 'OPEN_LINEAGE_DRAWER'; nodeId: string }
  | { type: 'CLOSE_LINEAGE_DRAWER' }
  | { type: 'REORDER_CELL'; fromIndex: number; toIndex: number }
  | { type: 'TOGGLE_DASHBOARD_MODE' }
  | { type: 'OPEN_BLOCK_STUDIO'; file: NotebookFile; payload: BlockStudioOpenPayload }
  | { type: 'BLOCK_CERTIFICATION_ACCEPTED'; source: string; draft?: BlockStudioOpenPayload }
  | {
      type: 'RECONCILE_BLOCK_CERTIFICATION';
      outcome: 'certified' | 'draft_saved_with_blockers' | 'certified_unchanged_with_blockers';
      oldPath: string;
      draftPath: string;
      newPath?: string;
      payload: BlockStudioOpenPayload;
    }
  | { type: 'START_NEW_BLOCK_WORKSPACE'; blockType?: 'custom' | 'semantic' }
  | { type: 'SET_BLOCK_STUDIO_DRAFT'; draft: string }
  | { type: 'SET_BLOCK_STUDIO_DIRTY'; dirty: boolean }
  | { type: 'SET_BLOCK_STUDIO_PREVIEW'; preview: BlockStudioPreview | null }
  | { type: 'SET_BLOCK_STUDIO_VALIDATION'; validation: BlockStudioValidation | null }
  | { type: 'SET_BLOCK_STUDIO_METADATA'; metadata: BlockStudioMetadata }
  | { type: 'SET_BLOCK_STUDIO_CATALOG'; catalog: BlockStudioCatalog | null }
  | { type: 'SET_BLOCK_STUDIO_CATALOG_LOADING'; loading: boolean }
  | { type: 'OPEN_BLOCK_IMPORT' }
  | { type: 'CLOSE_BLOCK_IMPORT' }
  | { type: 'SET_BLOCK_STUDIO_DBT_STATUS'; status: BlockStudioDbtStatus | null }
  | { type: 'TOGGLE_INSPECTOR' }
  | { type: 'SET_INSPECTOR'; open: boolean; context?: InspectorContext | null }
  | { type: 'SET_INSPECTOR_CONTEXT'; context: InspectorContext | null }
  // Apps surface (Phase 1)
  | { type: 'SET_APPS'; apps: AppSummary[] }
  | { type: 'SET_APPS_LOADING'; loading: boolean }
  | {
      type: 'OPEN_APP';
      appId: string;
      dashboardId?: string | null;
      experience?: AppWorkspaceExperience;
      section?: AppWorkspaceSection;
    }
  | { type: 'OPEN_APP_DRAFT'; draftId: string; appId?: string; dashboardId?: string | null }
  | { type: 'CLOSE_APP' }
  | { type: 'OPEN_DASHBOARD'; dashboardId: string }
  | { type: 'SET_APP_WORKSPACE_STATE'; experience?: AppWorkspaceExperience; section?: AppWorkspaceSection }
  | { type: 'SET_ACTIVE_PERSONA'; persona: ActivePersona | null }
  // Global AI right rail
  | { type: 'OPEN_GLOBAL_AI'; context?: GlobalAiContext; audience?: GlobalAiAudience; autoRun?: { text: string; mode?: string } }
  | { type: 'CLOSE_GLOBAL_AI' }
  | { type: 'OPEN_SETUP'; modelSource?: 'dbt' | 'warehouse' | 'both' | 'existing' }
  | { type: 'CLOSE_SETUP' }
  | { type: 'TOGGLE_GLOBAL_AI'; context?: GlobalAiContext; audience?: GlobalAiAudience }
  | { type: 'SET_GLOBAL_AI_CONTEXT'; context: GlobalAiContext; audience?: GlobalAiAudience };
