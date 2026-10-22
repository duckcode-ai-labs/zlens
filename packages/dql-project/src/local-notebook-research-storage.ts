import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { normalizeDqlArtifactReference, type DqlArtifactReference } from '@zlens/core';

const require = createRequire(import.meta.url);
let databaseCtor: typeof Database | null = null;

const HAS_REVIEWED_SQL = "(NULLIF(TRIM(reviewed_sql), '') IS NOT NULL)";
const HAS_GENERATED_SQL = "(NULLIF(TRIM(generated_sql), '') IS NOT NULL)";
const HAS_DQL_ARTIFACT_SQL = "(dql_artifact IS NOT NULL AND TRIM(dql_artifact) <> '' AND TRIM(dql_artifact) <> 'null')";
const HAS_SQL_SQL = `(${HAS_REVIEWED_SQL} OR ${HAS_GENERATED_SQL} OR ${HAS_DQL_ARTIFACT_SQL})`;
const HAS_PROMOTABLE_SOURCE_SQL = `(${HAS_REVIEWED_SQL} OR ${HAS_DQL_ARTIFACT_SQL})`;
const HAS_PREVIEW_SQL = "(result_preview IS NOT NULL AND TRIM(result_preview) <> '')";
const HAS_DRAFT_SQL = "(draft_block_path IS NOT NULL AND TRIM(draft_block_path) <> '')";
const HAS_EVIDENCE_SQL = "((evidence IS NOT NULL AND TRIM(evidence) <> '' AND TRIM(evidence) <> 'null') OR (context_pack_id IS NOT NULL AND TRIM(context_pack_id) <> ''))";
const OPEN_REVIEW_SQL = "(review_status NOT IN ('completed', 'certified', 'rejected'))";
const REUSE_RECOMMENDED_SQL = "(COALESCE(dql_promotion_action, '') = 'reuse_existing')";
const DRAFT_READY_SQL = `(${OPEN_REVIEW_SQL} AND TRIM(question) <> '' AND ${HAS_PROMOTABLE_SOURCE_SQL} AND ${HAS_EVIDENCE_SQL} AND status <> 'error')`;
const CERTIFICATION_READY_SQL = `(${DRAFT_READY_SQL} AND ${HAS_PREVIEW_SQL} AND ${HAS_DRAFT_SQL} AND COALESCE(dql_promotion_action, '') NOT IN ('reuse_existing', 'review_required'))`;
const BLOCKED_SQL = `(${OPEN_REVIEW_SQL} AND (status = 'error' OR TRIM(question) = '' OR (NOT ${REUSE_RECOMMENDED_SQL} AND NOT ${HAS_SQL_SQL})))`;
const NEXT_ACTION_SQL = `CASE
  WHEN review_status IN ('completed', 'rejected', 'certified') THEN 'continue_review'
  WHEN ${BLOCKED_SQL} THEN 'fix_blockers'
  WHEN ${REUSE_RECOMMENDED_SQL} THEN 'reuse_existing'
  WHEN NOT ${HAS_DQL_ARTIFACT_SQL} AND NOT ${HAS_REVIEWED_SQL} AND ${HAS_GENERATED_SQL} THEN 'review_sql'
  WHEN NOT ${HAS_EVIDENCE_SQL} THEN 'review_context'
  WHEN NOT ${HAS_PREVIEW_SQL} THEN 'run_preview'
  WHEN NOT ${HAS_DRAFT_SQL} AND ${DRAFT_READY_SQL} THEN 'create_dql_draft'
  WHEN ${CERTIFICATION_READY_SQL} THEN 'open_certification'
  WHEN ${HAS_DRAFT_SQL} THEN 'complete_review'
  ELSE 'continue_review'
END`;
const NEXT_ACTION_PRIORITY_SQL = `CASE (${NEXT_ACTION_SQL})
  WHEN 'fix_blockers' THEN 0
  WHEN 'review_sql' THEN 1
  WHEN 'review_context' THEN 2
  WHEN 'run_preview' THEN 3
  WHEN 'reuse_existing' THEN 4
  WHEN 'create_dql_draft' THEN 5
  WHEN 'open_certification' THEN 6
  WHEN 'complete_review' THEN 7
  WHEN 'continue_review' THEN 8
  ELSE 9
END`;
const SEARCH_INDEX_VERSION = '4';
const RESEARCH_DOMAIN_GROUP_LIMIT = 100;
const RESEARCH_INTENT_GROUP_LIMIT = 50;
const RESEARCH_NOTEBOOK_GROUP_LIMIT = 100;
const RESEARCH_OWNER_GROUP_LIMIT = 100;

function loadDatabase(): typeof Database {
  databaseCtor ??= require('better-sqlite3') as typeof Database;
  return databaseCtor;
}

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
export type NotebookResearchDqlPromotionAction =
  | 'reuse_existing'
  | 'extend_existing'
  | 'create_replacement'
  | 'create_new'
  | 'review_required';
export type NotebookResearchReadinessFilter = 'draft_ready' | 'certification_ready' | 'blocked';
export type NotebookResearchAgeFilter = 'stale_open' | 'expired_open';
export type NotebookResearchSort = 'priority' | 'updated_desc';
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

export interface NotebookResearchReviewMetrics {
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
}

const NOTEBOOK_NEXT_ACTION_PRIORITY: NotebookResearchNextActionFilter[] = [
  'fix_blockers',
  'review_sql',
  'review_context',
  'run_preview',
  'reuse_existing',
  'create_dql_draft',
  'open_certification',
  'complete_review',
  'continue_review',
];

export interface NotebookResearchDqlPromotionMatch {
  kind: string;
  objectKey?: string;
  name: string;
  status?: string;
  source?: string;
  score: number;
  reason: string;
  recommendedAction: string;
}

export interface NotebookResearchDqlPromotionCandidate {
  id: string;
  name: string;
  domain?: string;
  draftPath?: string;
  savedPath?: string;
  reviewStatus?: string;
  recommendedAction?: string;
  similarityMatches: NotebookResearchDqlPromotionMatch[];
  parameterPolicy: Array<{ name: string; policy: string }>;
  allowedFilters: string[];
  warnings: string[];
}

export interface NotebookResearchDqlPromotion {
  importId: string;
  candidateIds: string[];
  draftBlockPath?: string;
  recommendedAction?: string;
  similarityMatches: NotebookResearchDqlPromotionMatch[];
  candidates: NotebookResearchDqlPromotionCandidate[];
  createdAt: string;
}

export type NotebookResearchDqlArtifact = DqlArtifactReference;

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
  resultPreview?: unknown;
  evidence?: unknown;
  researchPlan?: NotebookResearchPlan;
  generatedSql?: string;
  reviewedSql?: string;
  dqlArtifact?: NotebookResearchDqlArtifact;
  display?: unknown;
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
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface NotebookResearchSourceCellInput {
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

export interface CreateNotebookResearchRunInput {
  id?: string;
  notebookPath: string;
  domain?: string;
  owner?: string;
  sourceCell?: NotebookResearchSourceCellInput;
  sourceCellId?: string;
  sourceCellName?: string;
  sourceCellFingerprint?: string;
  title?: string;
  question: string;
  intent?: NotebookResearchIntent;
  context?: unknown;
  generatedSql?: string;
  reviewedSql?: string;
  dqlArtifact?: NotebookResearchDqlArtifact;
}

export interface UpdateNotebookResearchRunInput {
  domain?: string;
  owner?: string;
  sourceCellId?: string | null;
  sourceCellName?: string | null;
  sourceCellFingerprint?: string | null;
  title?: string;
  question?: string;
  intent?: NotebookResearchIntent;
  context?: unknown;
  status?: NotebookResearchStatus;
  summary?: string;
  recommendation?: string;
  resultPreview?: unknown;
  evidence?: unknown;
  researchPlan?: NotebookResearchPlan;
  generatedSql?: string;
  reviewedSql?: string;
  dqlArtifact?: NotebookResearchDqlArtifact;
  display?: unknown;
  contextPackId?: string;
  routeDecision?: unknown;
  warnings?: string[];
  reviewStatus?: NotebookResearchReviewStatus;
  error?: string;
  draftBlockPath?: string;
  dqlImportId?: string;
  dqlCandidateIds?: string[];
  dqlPromotionAction?: NotebookResearchDqlPromotionAction;
  dqlPromotion?: NotebookResearchDqlPromotion;
  lastRunAt?: string;
}

export interface ListNotebookResearchRunsQuery {
  notebookPath?: string;
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
}

export interface NotebookResearchRunListResult {
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
  reviewMetrics: NotebookResearchReviewMetrics;
	  limit?: number;
	  offset: number;
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

export interface NotebookResearchSeedCellInput {
  sourceCell?: NotebookResearchSourceCellInput;
  id?: string;
  sourceCellId?: string;
  name?: string;
  sourceCellName?: string;
  sourceCellFingerprint?: string;
  title?: string;
  type?: string;
  sql?: string;
  content?: string;
  source?: string;
  question?: string;
  intent?: NotebookResearchIntent;
}

export interface NotebookResearchSeedCellsInput {
  notebookPath: string;
  domain?: string;
  owner?: string;
  notebookTitle?: string;
  cells: NotebookResearchSeedCellInput[];
  limit?: number;
}

export interface NotebookResearchSeedCellsResult {
  created: NotebookResearchRun[];
  createdCount: number;
  skippedCount: number;
  limitApplied: boolean;
}

type NotebookResearchNextActionCountRow = {
  nextFixBlockers?: number;
  nextReviewSql?: number;
  nextReviewContext?: number;
  nextRunPreview?: number;
  nextReuseExisting?: number;
  nextCreateDqlDraft?: number;
  nextOpenCertification?: number;
  nextCompleteReview?: number;
  nextContinueReview?: number;
};

type NotebookResearchReviewMetricRow = {
  reviewStatus?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

function notebookSummaryNextAction(
  counts: Record<NotebookResearchNextActionFilter, number>,
): { action: NotebookResearchNextActionFilter; count: number } | undefined {
  for (const action of NOTEBOOK_NEXT_ACTION_PRIORITY) {
    const count = counts[action];
    if (count > 0) return { action, count };
  }
  return undefined;
}

function actionCountsFromRow(row: NotebookResearchNextActionCountRow): Record<NotebookResearchNextActionFilter, number> {
  return {
    fix_blockers: row.nextFixBlockers ?? 0,
    review_sql: row.nextReviewSql ?? 0,
    review_context: row.nextReviewContext ?? 0,
    run_preview: row.nextRunPreview ?? 0,
    reuse_existing: row.nextReuseExisting ?? 0,
    create_dql_draft: row.nextCreateDqlDraft ?? 0,
    open_certification: row.nextOpenCertification ?? 0,
    complete_review: row.nextCompleteReview ?? 0,
    continue_review: row.nextContinueReview ?? 0,
  };
}

function computeNotebookResearchReviewMetrics(
  rows: NotebookResearchReviewMetricRow[],
  nowMs = Date.now(),
): NotebookResearchReviewMetrics {
  const openAges: number[] = [];
  const draftTimes: number[] = [];
  const certificationTimes: number[] = [];
  const terminalTimes: number[] = [];
  let draftCreatedCount = 0;
  let certifiedCount = 0;
  let completedCount = 0;
  let rejectedCount = 0;

  for (const row of rows) {
    const status = parseReviewStatus(row.reviewStatus);
    const createdAt = timestampMs(row.createdAt);
    const updatedAt = timestampMs(row.updatedAt);
    if (status === 'draft_created') draftCreatedCount += 1;
    if (status === 'certified') certifiedCount += 1;
    if (status === 'completed') completedCount += 1;
    if (status === 'rejected') rejectedCount += 1;

    if (createdAt === null) continue;
    if (status === 'needs_review' || status === 'draft_created') {
      openAges.push(Math.max(0, nowMs - createdAt));
    }
    if (status === 'draft_created' && updatedAt !== null) {
      draftTimes.push(Math.max(0, updatedAt - createdAt));
    }
    if (status === 'certified' && updatedAt !== null) {
      certificationTimes.push(Math.max(0, updatedAt - createdAt));
    }
    if ((status === 'completed' || status === 'certified' || status === 'rejected') && updatedAt !== null) {
      terminalTimes.push(Math.max(0, updatedAt - createdAt));
    }
  }

  const terminalReviewCount = certifiedCount + completedCount + rejectedCount;
  return {
    totalReviewCount: rows.length,
    openReviewCount: rows.length - terminalReviewCount,
    terminalReviewCount,
    draftCreatedCount,
    certifiedCount,
    completedCount,
    rejectedCount,
    draftCreationRate: ratioNumber(draftCreatedCount, rows.length),
    certifyConversionRate: ratioNumber(certifiedCount, terminalReviewCount),
    medianOpenReviewAgeMs: medianNumber(openAges),
    medianTimeToDraftMs: medianNumber(draftTimes),
    medianTimeToCertificationMs: medianNumber(certificationTimes),
    medianTimeToTerminalMs: medianNumber(terminalTimes),
  };
}

function ratioNumber(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(4));
}

function medianNumber(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Math.round(sorted[mid]!);
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function timestampMs(value: unknown): number | null {
  const raw = optionalString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface NotebookResearchSourceCoverageQuery {
  notebookPath: string;
  sourceCellIds: string[];
  sourceCells?: NotebookResearchSourceCellInput[];
  limit?: number;
}

export function defaultNotebookResearchDbPath(projectRoot: string): string {
  return `${projectRoot}/.dql/local/notebook-research.sqlite`;
}

export class LocalNotebookResearchStorage {
  private db: Database.Database;
  private searchIndexAvailable = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const Database = loadDatabase();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  createRun(input: CreateNotebookResearchRunInput): NotebookResearchRun {
    const now = new Date().toISOString();
    const question = cleanOptionalString(input.question) ?? 'Notebook research';
    const sourceCell = normalizeSourceCellInput(input.sourceCell);
    const sourceSql = sourceCell?.sql ?? sourceCell?.content ?? sourceCell?.source;
    const run: NotebookResearchRun = {
      id: input.id ?? `nbr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      notebookPath: input.notebookPath,
      domain: cleanOptionalString(input.domain) ?? inferResearchDomain({
        context: input.context,
        notebookPath: input.notebookPath,
      }),
      owner: cleanOptionalString(input.owner),
      sourceCellId: cleanOptionalString(input.sourceCellId) ?? sourceCell?.id,
      sourceCellName: cleanOptionalString(input.sourceCellName) ?? sourceCell?.name,
      sourceCellFingerprint: cleanOptionalString(input.sourceCellFingerprint)
        ?? sourceCell?.fingerprint
        ?? fingerprintSql(cleanOptionalString(input.reviewedSql) ?? cleanOptionalString(input.generatedSql) ?? sourceSql),
      title: cleanOptionalString(input.title) ?? titleFromQuestion(question),
      question,
      intent: input.intent ?? inferIntent(question),
      context: input.context,
      status: 'draft',
      generatedSql: cleanOptionalString(input.generatedSql),
      reviewedSql: cleanOptionalString(input.reviewedSql),
      dqlArtifact: normalizeDqlArtifactReference(input.dqlArtifact),
      warnings: [],
      reviewStatus: 'needs_review',
      dqlCandidateIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO notebook_research_runs (
        id, notebook_path, domain, owner, source_cell_id, source_cell_name, source_cell_fingerprint, title, question,
        intent, context, status, summary, recommendation, result_preview,
        evidence, research_plan, generated_sql, reviewed_sql, dql_artifact, display, context_pack_id,
        route_decision, warnings, review_status, error, draft_block_path,
        dql_import_id, dql_candidate_ids, dql_promotion_action, dql_promotion, created_at, updated_at, last_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.notebookPath,
      run.domain ?? null,
      run.owner ?? null,
      run.sourceCellId ?? null,
      run.sourceCellName ?? null,
      run.sourceCellFingerprint ?? null,
      run.title,
      run.question,
      run.intent,
      json(run.context),
      run.status,
      null,
      null,
      null,
      null,
      null,
      run.generatedSql ?? null,
      run.reviewedSql ?? null,
      json(run.dqlArtifact),
      null,
      null,
      null,
      json(run.warnings),
      run.reviewStatus,
      null,
      null,
      null,
      json(run.dqlCandidateIds),
      null,
      null,
      run.createdAt,
      run.updatedAt,
      null,
    );
    this.upsertSearchIndex(run);
    return run;
  }

  listRuns(query?: string | ListNotebookResearchRunsQuery): NotebookResearchRun[] {
    return this.listRunsPage(query).runs;
  }

  listRunsPage(query?: string | ListNotebookResearchRunsQuery): NotebookResearchRunListResult {
    const normalized = normalizeListQuery(query);
    const { whereSql, params } = researchListWhere(normalized, { useSearchIndex: this.searchIndexAvailable });
    const countScope = { ...normalized, status: undefined, reviewStatus: undefined, promotionAction: undefined, readiness: undefined, age: undefined, nextAction: undefined };
    const { whereSql: countWhereSql, params: countParams } = researchListWhere(countScope, { useSearchIndex: this.searchIndexAvailable });
    const domainScope = { ...countScope, domain: undefined };
    const { whereSql: domainWhereSql, params: domainParams } = researchListWhere(domainScope, { useSearchIndex: this.searchIndexAvailable });
    const ownerScope = { ...countScope, owner: undefined };
    const { whereSql: ownerWhereSql, params: ownerParams } = researchListWhere(ownerScope, { useSearchIndex: this.searchIndexAvailable });
    const intentScope = { ...countScope, intent: undefined };
    const { whereSql: intentWhereSql, params: intentParams } = researchListWhere(intentScope, { useSearchIndex: this.searchIndexAvailable });
    const notebookScope = { ...countScope, notebookPath: undefined };
    const { whereSql: notebookWhereSql, params: notebookParams } = researchListWhere(notebookScope, { useSearchIndex: this.searchIndexAvailable });
    const groupCounts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM (
          SELECT COALESCE(NULLIF(TRIM(domain), ''), 'uncategorized') AS domain
          FROM notebook_research_runs
          ${domainWhereSql}
          GROUP BY COALESCE(NULLIF(TRIM(domain), ''), 'uncategorized')
        )) AS domains,
        (SELECT COUNT(*) FROM (
          SELECT intent
          FROM notebook_research_runs
          ${intentWhereSql}
          GROUP BY intent
        )) AS intents,
        (SELECT COUNT(*) FROM (
          SELECT COALESCE(NULLIF(TRIM(owner), ''), 'unassigned') AS owner
          FROM notebook_research_runs
          ${ownerWhereSql}
          GROUP BY COALESCE(NULLIF(TRIM(owner), ''), 'unassigned')
        )) AS owners,
        (SELECT COUNT(*) FROM (
          SELECT notebook_path
          FROM notebook_research_runs
          ${notebookWhereSql}
          GROUP BY notebook_path
        )) AS notebooks
    `).get(...domainParams, ...intentParams, ...ownerParams, ...notebookParams) as {
      domains?: number;
      intents?: number;
      owners?: number;
      notebooks?: number;
    } | undefined;
    const total = (this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM notebook_research_runs
      ${whereSql}
    `).get(...params) as { count?: number } | undefined)?.count ?? 0;
    const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const expiredCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN review_status = 'needs_review' THEN 1 ELSE 0 END) AS needsReview,
        SUM(CASE WHEN review_status = 'draft_created' THEN 1 ELSE 0 END) AS dqlDrafts,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN dql_promotion_action = 'reuse_existing' THEN 1 ELSE 0 END) AS reuseExisting,
        SUM(CASE WHEN dql_promotion_action = 'extend_existing' THEN 1 ELSE 0 END) AS extendExisting,
        SUM(CASE WHEN dql_promotion_action = 'create_replacement' THEN 1 ELSE 0 END) AS replacements,
        SUM(CASE WHEN dql_promotion_action = 'create_new' THEN 1 ELSE 0 END) AS createNew,
        SUM(CASE WHEN ${DRAFT_READY_SQL} THEN 1 ELSE 0 END) AS draftReady,
        SUM(CASE WHEN ${CERTIFICATION_READY_SQL} THEN 1 ELSE 0 END) AS certificationReady,
        SUM(CASE WHEN ${BLOCKED_SQL} THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS staleOpen,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS expiredOpen,
        COUNT(DISTINCT CASE WHEN source_cell_id IS NOT NULL AND TRIM(source_cell_id) <> '' THEN source_cell_id END) AS sourceLinked,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'fix_blockers' THEN 1 ELSE 0 END) AS nextFixBlockers,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'review_sql' THEN 1 ELSE 0 END) AS nextReviewSql,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'review_context' THEN 1 ELSE 0 END) AS nextReviewContext,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'run_preview' THEN 1 ELSE 0 END) AS nextRunPreview,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'reuse_existing' THEN 1 ELSE 0 END) AS nextReuseExisting,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'create_dql_draft' THEN 1 ELSE 0 END) AS nextCreateDqlDraft,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'open_certification' THEN 1 ELSE 0 END) AS nextOpenCertification,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'complete_review' THEN 1 ELSE 0 END) AS nextCompleteReview,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'continue_review' THEN 1 ELSE 0 END) AS nextContinueReview
      FROM notebook_research_runs
      ${countWhereSql}
    `).get(staleCutoff, expiredCutoff, ...countParams) as {
      total?: number;
      ready?: number;
      needsReview?: number;
      dqlDrafts?: number;
      errors?: number;
      reuseExisting?: number;
      extendExisting?: number;
      replacements?: number;
      createNew?: number;
      draftReady?: number;
      certificationReady?: number;
      blocked?: number;
      staleOpen?: number;
      expiredOpen?: number;
      sourceLinked?: number;
      nextFixBlockers?: number;
      nextReviewSql?: number;
      nextReviewContext?: number;
      nextRunPreview?: number;
      nextReuseExisting?: number;
      nextCreateDqlDraft?: number;
      nextOpenCertification?: number;
      nextCompleteReview?: number;
      nextContinueReview?: number;
    } | undefined;
    const reviewMetricRows = this.db.prepare(`
      SELECT review_status AS reviewStatus, created_at AS createdAt, updated_at AS updatedAt
      FROM notebook_research_runs
      ${countWhereSql}
    `).all(...countParams) as NotebookResearchReviewMetricRow[];
    const reviewMetrics = computeNotebookResearchReviewMetrics(reviewMetricRows);
    const domains = this.db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(domain), ''), 'uncategorized') AS domain,
        COUNT(*) AS total,
        SUM(CASE WHEN ${DRAFT_READY_SQL} THEN 1 ELSE 0 END) AS draftReady,
        SUM(CASE WHEN ${CERTIFICATION_READY_SQL} THEN 1 ELSE 0 END) AS certificationReady,
        SUM(CASE WHEN ${BLOCKED_SQL} THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS staleOpen,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS expiredOpen,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'fix_blockers' THEN 1 ELSE 0 END) AS nextFixBlockers,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'review_sql' THEN 1 ELSE 0 END) AS nextReviewSql,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'review_context' THEN 1 ELSE 0 END) AS nextReviewContext,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'run_preview' THEN 1 ELSE 0 END) AS nextRunPreview,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'reuse_existing' THEN 1 ELSE 0 END) AS nextReuseExisting,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'create_dql_draft' THEN 1 ELSE 0 END) AS nextCreateDqlDraft,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'open_certification' THEN 1 ELSE 0 END) AS nextOpenCertification,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'complete_review' THEN 1 ELSE 0 END) AS nextCompleteReview,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'continue_review' THEN 1 ELSE 0 END) AS nextContinueReview,
        MIN(${NEXT_ACTION_PRIORITY_SQL}) AS nextActionPriority
      FROM notebook_research_runs
      ${domainWhereSql}
      GROUP BY COALESCE(NULLIF(TRIM(domain), ''), 'uncategorized')
      ORDER BY nextActionPriority ASC, blocked DESC, certificationReady DESC, draftReady DESC, total DESC, domain ASC
      LIMIT ${RESEARCH_DOMAIN_GROUP_LIMIT}
    `).all(staleCutoff, expiredCutoff, ...domainParams) as Array<{
      domain?: string;
      total?: number;
      draftReady?: number;
      certificationReady?: number;
      blocked?: number;
      staleOpen?: number;
      expiredOpen?: number;
    } & NotebookResearchNextActionCountRow>;
    const owners = this.db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(owner), ''), 'unassigned') AS owner,
        COUNT(*) AS total,
        SUM(CASE WHEN ${DRAFT_READY_SQL} THEN 1 ELSE 0 END) AS draftReady,
        SUM(CASE WHEN ${CERTIFICATION_READY_SQL} THEN 1 ELSE 0 END) AS certificationReady,
        SUM(CASE WHEN ${BLOCKED_SQL} THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS staleOpen,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS expiredOpen,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'fix_blockers' THEN 1 ELSE 0 END) AS nextFixBlockers,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'review_sql' THEN 1 ELSE 0 END) AS nextReviewSql,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'review_context' THEN 1 ELSE 0 END) AS nextReviewContext,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'run_preview' THEN 1 ELSE 0 END) AS nextRunPreview,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'reuse_existing' THEN 1 ELSE 0 END) AS nextReuseExisting,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'create_dql_draft' THEN 1 ELSE 0 END) AS nextCreateDqlDraft,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'open_certification' THEN 1 ELSE 0 END) AS nextOpenCertification,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'complete_review' THEN 1 ELSE 0 END) AS nextCompleteReview,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'continue_review' THEN 1 ELSE 0 END) AS nextContinueReview,
        MIN(${NEXT_ACTION_PRIORITY_SQL}) AS nextActionPriority
      FROM notebook_research_runs
      ${ownerWhereSql}
      GROUP BY COALESCE(NULLIF(TRIM(owner), ''), 'unassigned')
      ORDER BY nextActionPriority ASC, blocked DESC, certificationReady DESC, draftReady DESC, total DESC, owner ASC
      LIMIT ${RESEARCH_OWNER_GROUP_LIMIT}
    `).all(staleCutoff, expiredCutoff, ...ownerParams) as Array<{
      owner?: string;
      total?: number;
      draftReady?: number;
      certificationReady?: number;
      blocked?: number;
      staleOpen?: number;
      expiredOpen?: number;
    } & NotebookResearchNextActionCountRow>;
    const intents = this.db.prepare(`
      SELECT
        intent,
        COUNT(*) AS total,
        SUM(CASE WHEN ${DRAFT_READY_SQL} THEN 1 ELSE 0 END) AS draftReady,
        SUM(CASE WHEN ${CERTIFICATION_READY_SQL} THEN 1 ELSE 0 END) AS certificationReady,
        SUM(CASE WHEN ${BLOCKED_SQL} THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS staleOpen,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS expiredOpen,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'fix_blockers' THEN 1 ELSE 0 END) AS nextFixBlockers,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'review_sql' THEN 1 ELSE 0 END) AS nextReviewSql,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'review_context' THEN 1 ELSE 0 END) AS nextReviewContext,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'run_preview' THEN 1 ELSE 0 END) AS nextRunPreview,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'reuse_existing' THEN 1 ELSE 0 END) AS nextReuseExisting,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'create_dql_draft' THEN 1 ELSE 0 END) AS nextCreateDqlDraft,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'open_certification' THEN 1 ELSE 0 END) AS nextOpenCertification,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'complete_review' THEN 1 ELSE 0 END) AS nextCompleteReview,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'continue_review' THEN 1 ELSE 0 END) AS nextContinueReview,
        MIN(${NEXT_ACTION_PRIORITY_SQL}) AS nextActionPriority
      FROM notebook_research_runs
      ${intentWhereSql}
      GROUP BY intent
      ORDER BY nextActionPriority ASC, blocked DESC, certificationReady DESC, draftReady DESC, total DESC, intent ASC
      LIMIT ${RESEARCH_INTENT_GROUP_LIMIT}
    `).all(staleCutoff, expiredCutoff, ...intentParams) as Array<{
      intent?: unknown;
      total?: number;
      draftReady?: number;
      certificationReady?: number;
      blocked?: number;
      staleOpen?: number;
      expiredOpen?: number;
    } & NotebookResearchNextActionCountRow>;
    const notebooks = this.db.prepare(`
      SELECT
        notebook_path AS path,
        COUNT(*) AS total,
        SUM(CASE WHEN ${DRAFT_READY_SQL} THEN 1 ELSE 0 END) AS draftReady,
        SUM(CASE WHEN ${CERTIFICATION_READY_SQL} THEN 1 ELSE 0 END) AS certificationReady,
        SUM(CASE WHEN ${BLOCKED_SQL} THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS staleOpen,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS expiredOpen,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'fix_blockers' THEN 1 ELSE 0 END) AS nextFixBlockers,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'review_sql' THEN 1 ELSE 0 END) AS nextReviewSql,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'review_context' THEN 1 ELSE 0 END) AS nextReviewContext,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'run_preview' THEN 1 ELSE 0 END) AS nextRunPreview,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'reuse_existing' THEN 1 ELSE 0 END) AS nextReuseExisting,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'create_dql_draft' THEN 1 ELSE 0 END) AS nextCreateDqlDraft,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'open_certification' THEN 1 ELSE 0 END) AS nextOpenCertification,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'complete_review' THEN 1 ELSE 0 END) AS nextCompleteReview,
        SUM(CASE WHEN (${NEXT_ACTION_SQL}) = 'continue_review' THEN 1 ELSE 0 END) AS nextContinueReview,
        MIN(${NEXT_ACTION_PRIORITY_SQL}) AS nextActionPriority
      FROM notebook_research_runs
      ${notebookWhereSql}
      GROUP BY notebook_path
      ORDER BY nextActionPriority ASC, blocked DESC, certificationReady DESC, draftReady DESC, total DESC, path ASC
      LIMIT ${RESEARCH_NOTEBOOK_GROUP_LIMIT}
    `).all(staleCutoff, expiredCutoff, ...notebookParams) as Array<{
      path?: string;
      total?: number;
      draftReady?: number;
      certificationReady?: number;
      blocked?: number;
      staleOpen?: number;
      expiredOpen?: number;
      nextFixBlockers?: number;
      nextReviewSql?: number;
      nextReviewContext?: number;
      nextRunPreview?: number;
      nextReuseExisting?: number;
      nextCreateDqlDraft?: number;
      nextOpenCertification?: number;
      nextCompleteReview?: number;
      nextContinueReview?: number;
    } & NotebookResearchNextActionCountRow>;
    const orderSql = normalized.sort === 'priority'
      ? `ORDER BY
          ${NEXT_ACTION_PRIORITY_SQL} ASC,
          updated_at DESC`
      : 'ORDER BY updated_at DESC';
    const pageSql = normalized.limit === undefined ? '' : 'LIMIT ? OFFSET ?';
    const pageParams = normalized.limit === undefined ? [] : [normalized.limit, normalized.offset];
    const rows = this.db.prepare(`
      SELECT * FROM notebook_research_runs
      ${whereSql}
      ${orderSql}
      ${pageSql}
    `).all(...params, ...pageParams) as Record<string, unknown>[];
    return {
      runs: rows.map(rowToRun),
      total,
      domains: domains.map((row) => {
        const nextAction = notebookSummaryNextAction(actionCountsFromRow(row));
        return {
          domain: row.domain ?? 'uncategorized',
          total: row.total ?? 0,
          draftReady: row.draftReady ?? 0,
          certificationReady: row.certificationReady ?? 0,
          blocked: row.blocked ?? 0,
          staleOpen: row.staleOpen ?? 0,
          expiredOpen: row.expiredOpen ?? 0,
          ...(nextAction ? { nextAction: nextAction.action, nextActionCount: nextAction.count } : {}),
        };
      }),
      owners: owners.map((row) => {
        const nextAction = notebookSummaryNextAction(actionCountsFromRow(row));
        return {
          owner: row.owner ?? 'unassigned',
          total: row.total ?? 0,
          draftReady: row.draftReady ?? 0,
          certificationReady: row.certificationReady ?? 0,
          blocked: row.blocked ?? 0,
          staleOpen: row.staleOpen ?? 0,
          expiredOpen: row.expiredOpen ?? 0,
          ...(nextAction ? { nextAction: nextAction.action, nextActionCount: nextAction.count } : {}),
        };
      }),
      intents: intents.map((row) => {
        const nextAction = notebookSummaryNextAction(actionCountsFromRow(row));
        return {
          intent: parseIntent(row.intent),
          total: row.total ?? 0,
          draftReady: row.draftReady ?? 0,
          certificationReady: row.certificationReady ?? 0,
          blocked: row.blocked ?? 0,
          staleOpen: row.staleOpen ?? 0,
          expiredOpen: row.expiredOpen ?? 0,
          ...(nextAction ? { nextAction: nextAction.action, nextActionCount: nextAction.count } : {}),
        };
      }),
      notebooks: notebooks.map((row) => {
        const path = row.path ?? 'notebooks/untitled.dqlnb';
        const nextAction = notebookSummaryNextAction(actionCountsFromRow(row));
        return {
          path,
          title: notebookTitleFromPath(path),
          total: row.total ?? 0,
          draftReady: row.draftReady ?? 0,
          certificationReady: row.certificationReady ?? 0,
          blocked: row.blocked ?? 0,
          staleOpen: row.staleOpen ?? 0,
          expiredOpen: row.expiredOpen ?? 0,
          ...(nextAction ? { nextAction: nextAction.action, nextActionCount: nextAction.count } : {}),
        };
      }),
      counts: {
        total: counts?.total ?? 0,
        ready: counts?.ready ?? 0,
        needsReview: counts?.needsReview ?? 0,
        dqlDrafts: counts?.dqlDrafts ?? 0,
        errors: counts?.errors ?? 0,
        reuseExisting: counts?.reuseExisting ?? 0,
        extendExisting: counts?.extendExisting ?? 0,
        replacements: counts?.replacements ?? 0,
        createNew: counts?.createNew ?? 0,
        draftReady: counts?.draftReady ?? 0,
        certificationReady: counts?.certificationReady ?? 0,
        blocked: counts?.blocked ?? 0,
        staleOpen: counts?.staleOpen ?? 0,
        expiredOpen: counts?.expiredOpen ?? 0,
        sourceLinked: counts?.sourceLinked ?? 0,
        nextActions: {
          fix_blockers: counts?.nextFixBlockers ?? 0,
          review_sql: counts?.nextReviewSql ?? 0,
          review_context: counts?.nextReviewContext ?? 0,
          run_preview: counts?.nextRunPreview ?? 0,
          reuse_existing: counts?.nextReuseExisting ?? 0,
          create_dql_draft: counts?.nextCreateDqlDraft ?? 0,
          open_certification: counts?.nextOpenCertification ?? 0,
          complete_review: counts?.nextCompleteReview ?? 0,
	          continue_review: counts?.nextContinueReview ?? 0,
	        },
	      },
      groupCounts: {
        domains: groupCounts?.domains ?? domains.length,
        owners: groupCounts?.owners ?? owners.length,
        intents: groupCounts?.intents ?? intents.length,
        notebooks: groupCounts?.notebooks ?? notebooks.length,
      },
      reviewMetrics,
	      limit: normalized.limit,
	      offset: normalized.offset,
	    };
  }

  listLatestRunsBySourceCell(query: NotebookResearchSourceCoverageQuery): NotebookResearchRun[] {
    const notebookPath = cleanOptionalString(query.notebookPath);
    if (!notebookPath) return [];
    const limit = typeof query.limit === 'number' && Number.isFinite(query.limit)
      ? Math.max(1, Math.min(10_000, Math.floor(query.limit)))
      : 10_000;
	    const sourceCells = normalizeSourceCoverageCells(query, limit);
	    const sourceCellIds = sourceCells.map((cell) => cell.id);
	    if (sourceCellIds.length === 0) return [];

	    const bySourceCell = new Map<string, NotebookResearchRun>();
    const chunkSize = 400;
    for (let index = 0; index < sourceCellIds.length; index += chunkSize) {
      const chunk = sourceCellIds.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db.prepare(`
        SELECT *
        FROM notebook_research_runs
        WHERE notebook_path = ?
          AND source_cell_id IN (${placeholders})
        ORDER BY source_cell_id ASC, updated_at DESC, rowid DESC
      `).all(notebookPath, ...chunk) as Record<string, unknown>[];
      for (const row of rows) {
        const sourceCellId = optionalString(row.source_cell_id);
	        if (!sourceCellId || bySourceCell.has(sourceCellId)) continue;
	        bySourceCell.set(sourceCellId, rowToRun(row));
	      }
	    }

	    const unmatchedByFingerprint = new Map<string, Array<{ id: string; name?: string; fingerprint: string }>>();
	    for (const sourceCell of sourceCells) {
	      if (bySourceCell.has(sourceCell.id) || !sourceCell.fingerprint) continue;
	      const list = unmatchedByFingerprint.get(sourceCell.fingerprint) ?? [];
	      list.push(sourceCell as { id: string; name?: string; fingerprint: string });
	      unmatchedByFingerprint.set(sourceCell.fingerprint, list);
	    }
	    const fingerprints = Array.from(unmatchedByFingerprint.keys());
	    for (let index = 0; index < fingerprints.length; index += chunkSize) {
	      const chunk = fingerprints.slice(index, index + chunkSize);
	      const placeholders = chunk.map(() => '?').join(', ');
	      const rows = this.db.prepare(`
	        SELECT *
	        FROM notebook_research_runs
	        WHERE notebook_path = ?
	          AND source_cell_fingerprint IN (${placeholders})
	          AND (source_cell_id IS NULL OR TRIM(source_cell_id) = '')
	        ORDER BY source_cell_fingerprint ASC, updated_at DESC, rowid DESC
	      `).all(notebookPath, ...chunk) as Record<string, unknown>[];
	      const byFingerprint = new Set<string>();
	      for (const row of rows) {
	        const fingerprint = optionalString(row.source_cell_fingerprint);
	        if (!fingerprint || byFingerprint.has(fingerprint)) continue;
	        byFingerprint.add(fingerprint);
	        const sourceCellMatches = unmatchedByFingerprint.get(fingerprint) ?? [];
	        const run = rowToRun(row);
	        for (const sourceCell of sourceCellMatches) {
	          if (bySourceCell.has(sourceCell.id)) continue;
	          bySourceCell.set(sourceCell.id, {
	            ...run,
	            sourceCellId: sourceCell.id,
	            sourceCellName: run.sourceCellName ?? sourceCell.name,
	            sourceCellFingerprint: run.sourceCellFingerprint ?? sourceCell.fingerprint,
	          });
	        }
	      }
	    }

	    return sourceCellIds
	      .map((sourceCellId) => bySourceCell.get(sourceCellId))
      .filter((run): run is NotebookResearchRun => Boolean(run));
  }

  listLatestRunsForMissingSourceCells(query: NotebookResearchSourceCoverageQuery): NotebookResearchRun[] {
    const notebookPath = cleanOptionalString(query.notebookPath);
    if (!notebookPath) return [];
    const limit = typeof query.limit === 'number' && Number.isFinite(query.limit)
      ? Math.max(1, Math.min(10_000, Math.floor(query.limit)))
      : 10_000;
	    const currentSourceIds = new Set(normalizeSourceCoverageCells(query, Number.POSITIVE_INFINITY).map((cell) => cell.id));
    const rows = this.db.prepare(`
      SELECT *
      FROM notebook_research_runs
      WHERE notebook_path = ?
        AND source_cell_id IS NOT NULL
        AND TRIM(source_cell_id) <> ''
      ORDER BY source_cell_id ASC, updated_at DESC, rowid DESC
    `).all(notebookPath) as Record<string, unknown>[];
    const byMissingSource = new Map<string, NotebookResearchRun>();
    for (const row of rows) {
      const sourceCellId = optionalString(row.source_cell_id);
      if (!sourceCellId || currentSourceIds.has(sourceCellId) || byMissingSource.has(sourceCellId)) continue;
      byMissingSource.set(sourceCellId, rowToRun(row));
      if (byMissingSource.size >= limit) break;
    }
    return Array.from(byMissingSource.values());
  }

  getRun(id: string): NotebookResearchRun | null {
    const row = this.db.prepare('SELECT * FROM notebook_research_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  }

  updateRun(id: string, input: UpdateNotebookResearchRunInput): NotebookResearchRun | null {
    const current = this.getRun(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const nextPromotion = input.dqlPromotion === undefined ? current.dqlPromotion : input.dqlPromotion;
    const nextContext = input.context === undefined ? current.context : input.context;
    const nextDraftBlockPath = input.draftBlockPath === undefined ? current.draftBlockPath : cleanOptionalString(input.draftBlockPath);
    const nextDomain = cleanOptionalString(input.domain)
      ?? inferResearchDomain({
        context: nextContext,
        dqlPromotion: nextPromotion,
        draftBlockPath: nextDraftBlockPath,
        notebookPath: current.notebookPath,
      })
      ?? current.domain;
    const nextPromotionAction = input.dqlPromotionAction
      ?? normalizePromotionAction(nextPromotion?.recommendedAction)
      ?? current.dqlPromotionAction
      ?? normalizePromotionAction(current.dqlPromotion?.recommendedAction);
    this.db.prepare(`
      UPDATE notebook_research_runs
      SET domain = ?, owner = ?, source_cell_id = ?, source_cell_name = ?, source_cell_fingerprint = ?, title = ?, question = ?,
          intent = ?, context = ?, status = ?, summary = ?, recommendation = ?,
          result_preview = ?, evidence = ?, research_plan = ?, generated_sql = ?, reviewed_sql = ?, dql_artifact = ?,
          display = ?, context_pack_id = ?, route_decision = ?, warnings = ?,
          review_status = ?, error = ?, draft_block_path = ?, dql_import_id = ?,
          dql_candidate_ids = ?, dql_promotion_action = ?, dql_promotion = ?, updated_at = ?, last_run_at = ?
      WHERE id = ?
    `).run(
      nextDomain ?? null,
      input.owner === undefined ? (current.owner ?? null) : (cleanOptionalString(input.owner) ?? null),
      input.sourceCellId === undefined ? (current.sourceCellId ?? null) : (cleanOptionalString(input.sourceCellId) ?? null),
      input.sourceCellName === undefined ? (current.sourceCellName ?? null) : (cleanOptionalString(input.sourceCellName) ?? null),
      input.sourceCellFingerprint === undefined ? (current.sourceCellFingerprint ?? null) : (cleanOptionalString(input.sourceCellFingerprint) ?? null),
      cleanOptionalString(input.title) ?? current.title,
      cleanOptionalString(input.question) ?? current.question,
      input.intent ?? current.intent,
      json(nextContext),
      input.status ?? current.status,
      input.summary === undefined ? (current.summary ?? null) : (cleanOptionalString(input.summary) ?? null),
      input.recommendation === undefined ? (current.recommendation ?? null) : (cleanOptionalString(input.recommendation) ?? null),
      input.resultPreview === undefined ? json(current.resultPreview) : json(input.resultPreview),
      input.evidence === undefined ? json(current.evidence) : json(input.evidence),
      input.researchPlan === undefined ? json(current.researchPlan) : json(input.researchPlan),
      input.generatedSql === undefined ? (current.generatedSql ?? null) : (cleanOptionalString(input.generatedSql) ?? null),
      input.reviewedSql === undefined ? (current.reviewedSql ?? null) : (cleanOptionalString(input.reviewedSql) ?? null),
      input.dqlArtifact === undefined ? json(current.dqlArtifact) : json(normalizeDqlArtifactReference(input.dqlArtifact)),
      input.display === undefined ? json(current.display) : json(input.display),
      input.contextPackId === undefined ? (current.contextPackId ?? null) : (cleanOptionalString(input.contextPackId) ?? null),
      input.routeDecision === undefined ? json(current.routeDecision) : json(input.routeDecision),
      input.warnings === undefined ? json(current.warnings) : json(input.warnings),
      input.reviewStatus ?? current.reviewStatus,
      input.error === undefined ? (current.error ?? null) : (cleanOptionalString(input.error) ?? null),
      nextDraftBlockPath ?? null,
      input.dqlImportId === undefined ? (current.dqlImportId ?? null) : (cleanOptionalString(input.dqlImportId) ?? null),
      input.dqlCandidateIds === undefined ? json(current.dqlCandidateIds) : json(input.dqlCandidateIds),
      nextPromotionAction ?? null,
      json(nextPromotion),
      now,
      input.lastRunAt === undefined ? (current.lastRunAt ?? null) : (cleanOptionalString(input.lastRunAt) ?? null),
      id,
    );
    const updated = this.getRun(id);
    if (updated) this.upsertSearchIndex(updated);
    return updated;
  }

  markPromoted(id: string, input: { draftBlockPath?: string; dqlImportId?: string; dqlCandidateIds?: string[]; dqlPromotion?: NotebookResearchDqlPromotion }): NotebookResearchRun | null {
    return this.updateRun(id, {
      reviewStatus: 'draft_created',
      draftBlockPath: input.draftBlockPath,
      dqlImportId: input.dqlImportId,
      dqlCandidateIds: input.dqlCandidateIds,
      dqlPromotionAction: normalizePromotionAction(input.dqlPromotion?.recommendedAction),
      dqlPromotion: input.dqlPromotion,
    });
  }

  seedRunsFromCells(input: NotebookResearchSeedCellsInput): NotebookResearchSeedCellsResult {
    const notebookPath = cleanOptionalString(input.notebookPath);
    if (!notebookPath) return { created: [], createdCount: 0, skippedCount: input.cells.length, limitApplied: false };
    const limit = typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.max(1, Math.min(1000, Math.floor(input.limit)))
      : 1000;
    const cells = Array.isArray(input.cells) ? input.cells : [];
	    const existingSourceIds = new Set(
	      (this.db.prepare(`
	        SELECT source_cell_id AS sourceCellId
	        FROM notebook_research_runs
	        WHERE notebook_path = ? AND source_cell_id IS NOT NULL AND TRIM(source_cell_id) <> ''
      `).all(notebookPath) as Array<{ sourceCellId?: unknown }>)
	        .map((row) => cleanOptionalString(row.sourceCellId))
	        .filter((id): id is string => Boolean(id)),
	    );
	    const existingSourceFingerprints = new Set(
	      (this.db.prepare(`
	        SELECT source_cell_fingerprint AS sourceCellFingerprint
	        FROM notebook_research_runs
	        WHERE notebook_path = ? AND source_cell_fingerprint IS NOT NULL AND TRIM(source_cell_fingerprint) <> ''
	      `).all(notebookPath) as Array<{ sourceCellFingerprint?: unknown }>)
	        .map((row) => cleanOptionalString(row.sourceCellFingerprint))
	        .filter((fingerprint): fingerprint is string => Boolean(fingerprint)),
	    );
	    const created: NotebookResearchRun[] = [];
	    let skippedCount = Math.max(0, cells.length - limit);
	    for (const cell of cells.slice(0, limit)) {
	      const sourceCell = normalizeSourceCellInput(cell.sourceCell);
	      const sourceCellId = cleanOptionalString(cell.id) ?? cleanOptionalString(cell.sourceCellId) ?? sourceCell?.id;
	      const sql = cleanOptionalString(cell.sql) ?? cleanOptionalString(cell.content) ?? cleanOptionalString(cell.source) ?? sourceCell?.sql ?? sourceCell?.content ?? sourceCell?.source;
	      const sourceCellFingerprint = cleanOptionalString(cell.sourceCellFingerprint) ?? sourceCell?.fingerprint ?? fingerprintSql(sql);
	      if (
	        !sourceCellId
	        || !sql
	        || existingSourceIds.has(sourceCellId)
	        || Boolean(sourceCellFingerprint && existingSourceFingerprints.has(sourceCellFingerprint))
	      ) {
	        skippedCount += 1;
	        continue;
	      }
      const sourceCellName = cleanOptionalString(cell.name) ?? cleanOptionalString(cell.sourceCellName) ?? cleanOptionalString(cell.title) ?? sourceCell?.name ?? sourceCellId;
      const question = cleanOptionalString(cell.question) ?? seedQuestionForCell(sourceCellName);
      const run = this.createRun({
        notebookPath,
        domain: cleanOptionalString(input.domain),
        owner: cleanOptionalString(input.owner),
        sourceCellId,
        sourceCellName,
        title: cleanOptionalString(cell.title) ?? sourceCellName,
        question,
        intent: parseOptionalIntent(cell.intent),
        context: {
	          notebookTitle: cleanOptionalString(input.notebookTitle),
	          sourceCell: {
	            id: sourceCellId,
	            name: sourceCellName,
	            type: cleanOptionalString(cell.type) ?? sourceCell?.type,
	          },
	          selectedDomain: cleanOptionalString(input.domain),
	          selectedOwner: cleanOptionalString(input.owner),
	          seededFromNotebook: true,
	        },
	        sourceCellFingerprint,
	        generatedSql: sql,
	        reviewedSql: sql,
	      });
	      existingSourceIds.add(sourceCellId);
	      if (sourceCellFingerprint) existingSourceFingerprints.add(sourceCellFingerprint);
	      created.push(run);
	    }
    return {
      created,
      createdCount: created.length,
      skippedCount,
      limitApplied: cells.length > limit,
    };
  }

  getDiagnostics(): NotebookResearchDiagnostics {
    const staleThresholdDays = 7;
    const expiredThresholdDays = 30;
    const staleCutoff = new Date(Date.now() - staleThresholdDays * 24 * 60 * 60 * 1000).toISOString();
    const expiredCutoff = new Date(Date.now() - expiredThresholdDays * 24 * 60 * 60 * 1000).toISOString();
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS totalRuns,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') THEN 1 ELSE 0 END) AS activeRuns,
        SUM(CASE WHEN review_status IN ('completed', 'certified', 'rejected') THEN 1 ELSE 0 END) AS closedRuns,
        COUNT(DISTINCT notebook_path) AS notebooks,
        COUNT(DISTINCT COALESCE(NULLIF(TRIM(domain), ''), 'uncategorized')) AS domains,
        COUNT(DISTINCT COALESCE(NULLIF(TRIM(owner), ''), 'unassigned')) AS owners,
        COUNT(CASE WHEN source_cell_id IS NOT NULL AND TRIM(source_cell_id) <> '' THEN 1 END) AS sourceLinkedRuns,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS staleOpenRuns,
        SUM(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') AND updated_at <= ? THEN 1 ELSE 0 END) AS expiredOpenRuns,
        MIN(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') THEN updated_at END) AS oldestOpenUpdatedAt,
        MAX(CASE WHEN review_status NOT IN ('completed', 'certified', 'rejected') THEN updated_at END) AS newestOpenUpdatedAt,
        MIN(updated_at) AS oldestUpdatedAt,
        MAX(updated_at) AS newestUpdatedAt
      FROM notebook_research_runs
    `).get(staleCutoff, expiredCutoff) as {
      totalRuns?: number;
      activeRuns?: number;
      closedRuns?: number;
      notebooks?: number;
      domains?: number;
      owners?: number;
      sourceLinkedRuns?: number;
      staleOpenRuns?: number;
      expiredOpenRuns?: number;
      oldestOpenUpdatedAt?: string;
      newestOpenUpdatedAt?: string;
      oldestUpdatedAt?: string;
      newestUpdatedAt?: string;
    } | undefined;
    const totalRuns = counts?.totalRuns ?? 0;
    const indexRows = this.searchIndexAvailable
      ? this.scalarCount('SELECT COUNT(*) AS count FROM notebook_research_runs_fts')
      : 0;
    const indexVersion = this.searchIndexAvailable
      ? this.getMeta('notebook_research_search_index_version')
      : undefined;
    const stale = this.searchIndexAvailable
      ? indexRows !== totalRuns || indexVersion !== SEARCH_INDEX_VERSION
      : false;
    const warnings: string[] = [];
    if (!this.searchIndexAvailable) {
      warnings.push('Full-text search index is unavailable; research search falls back to local text scanning.');
    } else if (stale) {
      warnings.push('Research search index is stale and will rebuild on the next storage initialization.');
    }
    if (totalRuns > 10_000) {
      warnings.push('Research backlog is above 10,000 runs; use project, domain, next-action, and search filters before reviewing.');
    }
    if ((counts?.activeRuns ?? 0) > 500) {
      warnings.push('Open research backlog is large; use Open next, next-action filters, and register snapshots for review handoff.');
    }
    if ((counts?.expiredOpenRuns ?? 0) > 0) {
      warnings.push(`${counts?.expiredOpenRuns ?? 0} open research run(s) have not changed in ${expiredThresholdDays}+ days; revalidate or close stale investigations.`);
    } else if ((counts?.staleOpenRuns ?? 0) > 0) {
      warnings.push(`${counts?.staleOpenRuns ?? 0} open research run(s) have not changed in ${staleThresholdDays}+ days; confirm they are still relevant.`);
    }
    return {
      counts: {
        totalRuns,
        activeRuns: counts?.activeRuns ?? 0,
        closedRuns: counts?.closedRuns ?? 0,
        notebooks: counts?.notebooks ?? 0,
        domains: counts?.domains ?? 0,
        owners: counts?.owners ?? 0,
        sourceLinkedRuns: counts?.sourceLinkedRuns ?? 0,
      },
      health: {
        staleOpenRuns: counts?.staleOpenRuns ?? 0,
        expiredOpenRuns: counts?.expiredOpenRuns ?? 0,
        staleThresholdDays,
        expiredThresholdDays,
        oldestOpenUpdatedAt: optionalString(counts?.oldestOpenUpdatedAt),
        newestOpenUpdatedAt: optionalString(counts?.newestOpenUpdatedAt),
      },
      search: {
        indexed: this.searchIndexAvailable,
        indexRows,
        indexVersion,
        stale,
      },
      updatedAt: {
        oldest: optionalString(counts?.oldestUpdatedAt),
        newest: optionalString(counts?.newestUpdatedAt),
      },
      limits: {
        pageSize: 25,
        maxPageSize: 500,
        sourceCoverageLimit: 10_000,
        seedCellLimit: 1_000,
      },
      warnings,
    };
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notebook_research_runs (
        id TEXT PRIMARY KEY,
        notebook_path TEXT NOT NULL,
        domain TEXT,
        owner TEXT,
        source_cell_id TEXT,
        source_cell_name TEXT,
        source_cell_fingerprint TEXT,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        intent TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        recommendation TEXT,
        result_preview TEXT,
        evidence TEXT,
        research_plan TEXT,
        generated_sql TEXT,
        reviewed_sql TEXT,
        dql_artifact TEXT,
        display TEXT,
        context_pack_id TEXT,
        route_decision TEXT,
        warnings TEXT,
        review_status TEXT NOT NULL,
        error TEXT,
        draft_block_path TEXT,
        dql_import_id TEXT,
        dql_candidate_ids TEXT,
        dql_promotion_action TEXT,
        dql_promotion TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_notebook_research_path ON notebook_research_runs(notebook_path, updated_at);
      CREATE INDEX IF NOT EXISTS idx_notebook_research_review ON notebook_research_runs(review_status);
	      CREATE INDEX IF NOT EXISTS idx_notebook_research_status ON notebook_research_runs(status);
	      CREATE INDEX IF NOT EXISTS idx_notebook_research_intent ON notebook_research_runs(intent, updated_at);
	      CREATE INDEX IF NOT EXISTS idx_notebook_research_source_cell ON notebook_research_runs(notebook_path, source_cell_id, updated_at);
	      CREATE INDEX IF NOT EXISTS idx_notebook_research_source_fingerprint ON notebook_research_runs(notebook_path, source_cell_fingerprint, updated_at);

      CREATE TABLE IF NOT EXISTS notebook_research_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.ensureColumn('notebook_research_runs', 'dql_promotion_action', 'TEXT');
    this.ensureColumn('notebook_research_runs', 'dql_promotion', 'TEXT');
    this.ensureColumn('notebook_research_runs', 'domain', 'TEXT');
    this.ensureColumn('notebook_research_runs', 'owner', 'TEXT');
    this.ensureColumn('notebook_research_runs', 'source_cell_fingerprint', 'TEXT');
    this.ensureColumn('notebook_research_runs', 'research_plan', 'TEXT');
    this.ensureColumn('notebook_research_runs', 'dql_artifact', 'TEXT');
    this.backfillDomains();
	    this.db.exec('CREATE INDEX IF NOT EXISTS idx_notebook_research_promotion_action ON notebook_research_runs(dql_promotion_action)');
	    this.db.exec('CREATE INDEX IF NOT EXISTS idx_notebook_research_domain ON notebook_research_runs(domain, updated_at)');
	    this.db.exec('CREATE INDEX IF NOT EXISTS idx_notebook_research_source_fingerprint ON notebook_research_runs(notebook_path, source_cell_fingerprint, updated_at)');
	    this.initSearchIndex();
	  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }

  private backfillDomains(): void {
    const rows = this.db.prepare(`
      SELECT id, notebook_path, context, draft_block_path, dql_promotion
      FROM notebook_research_runs
      WHERE domain IS NULL OR TRIM(domain) = ''
    `).all() as Array<Record<string, unknown>>;
    const update = this.db.prepare('UPDATE notebook_research_runs SET domain = ? WHERE id = ?');
    for (const row of rows) {
      const domain = inferResearchDomain({
        context: parseJson(row.context),
        dqlPromotion: parseDqlPromotion(parseJson(row.dql_promotion)),
        draftBlockPath: optionalString(row.draft_block_path),
        notebookPath: optionalString(row.notebook_path),
      });
      if (domain) update.run(domain, row.id);
    }
  }

  private initSearchIndex(): void {
    try {
      this.dropSearchIndexIfMissingColumn('owner');
      this.dropSearchIndexIfMissingColumn('dql_artifact_text');
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS notebook_research_runs_fts USING fts5(
          id UNINDEXED,
          notebook_path,
          domain,
          owner,
          source_cell_name,
          title,
          question,
          intent,
          summary,
          recommendation,
          warnings,
          draft_block_path,
          dql_promotion_action,
          generated_sql,
          reviewed_sql,
          dql_artifact_text,
          context_text,
          evidence_text,
          research_plan_text,
          promotion_text,
          tokenize = 'unicode61'
        );
      `);
      this.searchIndexAvailable = true;
      this.ensureSearchIndexFresh();
    } catch {
      this.searchIndexAvailable = false;
    }
  }

  private ensureSearchIndexFresh(): void {
    if (!this.searchIndexAvailable) return;
    const version = this.getMeta('notebook_research_search_index_version');
    const runCount = this.scalarCount('SELECT COUNT(*) AS count FROM notebook_research_runs');
    const indexCount = this.scalarCount('SELECT COUNT(*) AS count FROM notebook_research_runs_fts');
    if (version === SEARCH_INDEX_VERSION && runCount === indexCount) return;
    this.rebuildSearchIndex();
  }

  private rebuildSearchIndex(): void {
    if (!this.searchIndexAvailable) return;
    this.db.prepare('DELETE FROM notebook_research_runs_fts').run();
    const rows = this.db.prepare('SELECT * FROM notebook_research_runs ORDER BY rowid ASC').all() as Record<string, unknown>[];
    const insert = this.searchIndexInsertStatement();
    const transaction = this.db.transaction((items: Record<string, unknown>[]) => {
      for (const row of items) {
        insert.run(...searchIndexValues(rowToRun(row)));
      }
    });
    transaction(rows);
    this.setMeta('notebook_research_search_index_version', SEARCH_INDEX_VERSION);
  }

  private upsertSearchIndex(run: NotebookResearchRun): void {
    if (!this.searchIndexAvailable) return;
    try {
      this.db.prepare('DELETE FROM notebook_research_runs_fts WHERE id = ?').run(run.id);
      this.searchIndexInsertStatement().run(...searchIndexValues(run));
      this.setMeta('notebook_research_search_index_version', SEARCH_INDEX_VERSION);
    } catch {
      this.searchIndexAvailable = false;
    }
  }

  private searchIndexInsertStatement(): Database.Statement {
    return this.db.prepare(`
      INSERT INTO notebook_research_runs_fts (
        id, notebook_path, domain, owner, source_cell_name, title, question, intent, summary, recommendation,
        warnings, draft_block_path, dql_promotion_action, generated_sql, reviewed_sql,
        dql_artifact_text, context_text, evidence_text, research_plan_text, promotion_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  private dropSearchIndexIfMissingColumn(column: string): void {
    const exists = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'notebook_research_runs_fts'
    `).get() as { name?: string } | undefined;
    if (!exists) return;
    const rows = this.db.prepare('PRAGMA table_info(notebook_research_runs_fts)').all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.prepare('DROP TABLE notebook_research_runs_fts').run();
  }

  private scalarCount(sql: string): number {
    return (this.db.prepare(sql).get() as { count?: number } | undefined)?.count ?? 0;
  }

  private getMeta(key: string): string | undefined {
    return optionalString((this.db.prepare('SELECT value FROM notebook_research_meta WHERE key = ?').get(key) as { value?: unknown } | undefined)?.value);
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO notebook_research_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
}

function rowToRun(row: Record<string, unknown>): NotebookResearchRun {
  return {
    id: String(row.id),
    notebookPath: String(row.notebook_path),
    domain: optionalString(row.domain) ?? inferResearchDomain({
      context: parseJson(row.context),
      dqlPromotion: parseDqlPromotion(parseJson(row.dql_promotion)),
      draftBlockPath: optionalString(row.draft_block_path),
      notebookPath: optionalString(row.notebook_path),
    }),
    owner: optionalString(row.owner),
    sourceCellId: optionalString(row.source_cell_id),
    sourceCellName: optionalString(row.source_cell_name),
    sourceCellFingerprint: optionalString(row.source_cell_fingerprint),
    title: String(row.title),
    question: String(row.question),
    intent: parseIntent(row.intent),
    context: parseJson(row.context),
    status: parseStatus(row.status),
    summary: optionalString(row.summary),
    recommendation: optionalString(row.recommendation),
    resultPreview: parseJson(row.result_preview),
    evidence: parseJson(row.evidence),
    researchPlan: parseResearchPlan(parseJson(row.research_plan)),
    generatedSql: optionalString(row.generated_sql),
    reviewedSql: optionalString(row.reviewed_sql),
    dqlArtifact: normalizeDqlArtifactReference(parseJson(row.dql_artifact)),
    display: parseJson(row.display),
    contextPackId: optionalString(row.context_pack_id),
    routeDecision: parseJson(row.route_decision),
    warnings: stringArray(parseJson(row.warnings)),
    reviewStatus: parseReviewStatus(row.review_status),
    error: optionalString(row.error),
    draftBlockPath: optionalString(row.draft_block_path),
    dqlImportId: optionalString(row.dql_import_id),
    dqlCandidateIds: stringArray(parseJson(row.dql_candidate_ids)),
    dqlPromotionAction: normalizePromotionAction(row.dql_promotion_action),
    dqlPromotion: parseDqlPromotion(parseJson(row.dql_promotion)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastRunAt: optionalString(row.last_run_at),
  };
}

function inferIntent(question: string): NotebookResearchIntent {
  const lower = question.toLowerCase();
  if (/\b(trust|rely|certif|lineage|owner|caveat|gap)\b/.test(lower)) return 'trust_gap_review';
  if (/\b(anomal|exception|outlier|spike|dip)\b/.test(lower)) return 'anomaly_investigation';
  if (/\b(compare|versus| vs |segment|cohort)\b/.test(lower)) return 'segment_compare';
  if (/\b(why|changed|change|drop|decline|increase|decrease|month|week|quarter)\b/.test(lower)) return 'diagnose_change';
  if (/\b(driver|drove|break down|breakdown|contribute|top mover|movers)\b/.test(lower)) return 'driver_breakdown';
  if (/\b(profile|detail|drill|customer|account|user|client|merchant|product|player|team)\b/.test(lower)) return 'entity_drilldown';
  return 'ad_hoc_analysis';
}

function parseIntent(value: unknown): NotebookResearchIntent {
  if (
    value === 'ad_hoc_analysis'
    || value === 'diagnose_change'
    || value === 'driver_breakdown'
    || value === 'segment_compare'
    || value === 'entity_drilldown'
    || value === 'anomaly_investigation'
    || value === 'trust_gap_review'
  ) return value;
  return 'ad_hoc_analysis';
}

function notebookTitleFromPath(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file
    .replace(/\.dqlnb$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    || 'Untitled notebook';
}

function parseOptionalIntent(value: unknown): NotebookResearchIntent | undefined {
  if (
    value === 'ad_hoc_analysis'
    || value === 'diagnose_change'
    || value === 'driver_breakdown'
    || value === 'segment_compare'
    || value === 'entity_drilldown'
    || value === 'anomaly_investigation'
    || value === 'trust_gap_review'
  ) return value;
  return undefined;
}

function parseStatus(value: unknown): NotebookResearchStatus {
  return value === 'running' || value === 'ready' || value === 'error' ? value : 'draft';
}

function parseReviewStatus(value: unknown): NotebookResearchReviewStatus {
  return value === 'draft_created' || value === 'completed' || value === 'certified' || value === 'rejected' ? value : 'needs_review';
}

function normalizePromotionAction(value: unknown): NotebookResearchDqlPromotionAction | undefined {
  return value === 'reuse_existing'
    || value === 'extend_existing'
    || value === 'create_replacement'
    || value === 'create_new'
    || value === 'review_required'
    ? value
    : undefined;
}

function normalizeReadinessFilter(value: unknown): NotebookResearchReadinessFilter | undefined {
  return value === 'draft_ready' || value === 'certification_ready' || value === 'blocked' ? value : undefined;
}

function normalizeAgeFilter(value: unknown): NotebookResearchAgeFilter | undefined {
  return value === 'stale_open' || value === 'expired_open' ? value : undefined;
}

function normalizeNextActionFilter(value: unknown): NotebookResearchNextActionFilter | undefined {
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

function normalizeSort(value: unknown): NotebookResearchSort {
  return value === 'updated_desc' ? 'updated_desc' : 'priority';
}

function titleFromQuestion(question: string): string {
  const clean = question.replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean || 'Notebook research';
}

function seedQuestionForCell(sourceCellName: string): string {
  const cleanName = sourceCellName.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `What reusable business logic does ${cleanName || 'this query'} represent, and should it become a saved query?`;
}

function normalizeSourceCellInput(value: unknown): {
  id?: string;
  name?: string;
  fingerprint?: string;
  type?: string;
  sql?: string;
  content?: string;
  source?: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as NotebookResearchSourceCellInput;
  const id = cleanOptionalString(source.id)
    ?? cleanOptionalString(source.sourceCellId)
    ?? cleanOptionalString(source.cellId);
  const name = cleanOptionalString(source.name)
    ?? cleanOptionalString(source.sourceCellName)
    ?? cleanOptionalString(source.title);
  const fingerprint = cleanOptionalString(source.fingerprint)
    ?? cleanOptionalString(source.sourceCellFingerprint)
    ?? cleanOptionalString(source.sqlFingerprint);
  const type = cleanOptionalString(source.type);
  const sql = cleanOptionalString(source.sql);
  const content = cleanOptionalString(source.content);
  const sourceText = cleanOptionalString(source.source);
  if (!id && !name && !fingerprint && !type && !sql && !content && !sourceText) return null;
  return { id, name, fingerprint, type, sql, content, source: sourceText };
}

function normalizeSourceCoverageCells(
  query: NotebookResearchSourceCoverageQuery,
  limit: number,
): Array<{ id: string; name?: string; fingerprint?: string }> {
  const byId = new Map<string, { id: string; name?: string; fingerprint?: string }>();
  for (const id of Array.isArray(query.sourceCellIds) ? query.sourceCellIds : []) {
    const cleanId = cleanOptionalString(id);
    if (cleanId && !byId.has(cleanId)) byId.set(cleanId, { id: cleanId });
  }
  for (const rawCell of Array.isArray(query.sourceCells) ? query.sourceCells : []) {
    const sourceCell = normalizeSourceCellInput(rawCell);
    const id = sourceCell?.id;
    if (!id) continue;
    const current = byId.get(id) ?? { id };
    byId.set(id, {
      id,
      name: current.name ?? sourceCell.name,
      fingerprint: current.fingerprint ?? sourceCell.fingerprint,
    });
  }
  return Array.from(byId.values()).slice(0, limit);
}

function fingerprintSql(sql?: string): string | undefined {
  const normalized = sql?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeListQuery(query?: string | ListNotebookResearchRunsQuery): Required<Pick<ListNotebookResearchRunsQuery, 'offset'>> & Omit<ListNotebookResearchRunsQuery, 'offset'> {
  if (typeof query === 'string') {
    return { notebookPath: cleanOptionalString(query), offset: 0 };
  }
  const limit = typeof query?.limit === 'number' && Number.isFinite(query.limit)
    ? Math.max(1, Math.min(500, Math.floor(query.limit)))
    : undefined;
  const offset = typeof query?.offset === 'number' && Number.isFinite(query.offset)
    ? Math.max(0, Math.floor(query.offset))
    : 0;
  return {
    notebookPath: cleanOptionalString(query?.notebookPath),
    sourceCellId: cleanOptionalString(query?.sourceCellId),
    domain: cleanOptionalString(query?.domain),
    owner: cleanOptionalString(query?.owner),
    intent: parseOptionalIntent(query?.intent),
    search: cleanOptionalString(query?.search),
    status: query?.status,
    reviewStatus: query?.reviewStatus,
    promotionAction: normalizePromotionAction(query?.promotionAction),
    readiness: normalizeReadinessFilter(query?.readiness),
    age: normalizeAgeFilter(query?.age),
    nextAction: normalizeNextActionFilter(query?.nextAction),
    activeOnly: query?.activeOnly === true,
    sort: normalizeSort(query?.sort),
    limit,
    offset,
  };
}

function researchListWhere(
  query: ReturnType<typeof normalizeListQuery>,
  options: { useSearchIndex?: boolean } = {},
): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.notebookPath) {
    clauses.push('notebook_path = ?');
    params.push(query.notebookPath);
  }
  if (query.sourceCellId) {
    clauses.push('source_cell_id = ?');
    params.push(query.sourceCellId);
  }
  if (query.domain) {
    if (query.domain.toLowerCase() === 'uncategorized') {
      clauses.push("(domain IS NULL OR TRIM(domain) = '')");
    } else {
      clauses.push('LOWER(domain) = ?');
      params.push(query.domain.toLowerCase());
    }
  }
  if (query.owner) {
    clauses.push('LOWER(owner) = ?');
    params.push(query.owner.toLowerCase());
  }
  if (query.intent) {
    clauses.push('intent = ?');
    params.push(query.intent);
  }
  if (query.status) {
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.reviewStatus) {
    clauses.push('review_status = ?');
    params.push(query.reviewStatus);
  }
  if (query.activeOnly) {
    clauses.push("review_status NOT IN ('completed', 'certified', 'rejected')");
  }
  if (query.promotionAction) {
    clauses.push('dql_promotion_action = ?');
    params.push(query.promotionAction);
  }
  if (query.readiness === 'draft_ready') {
    clauses.push(`(${DRAFT_READY_SQL})`);
  } else if (query.readiness === 'certification_ready') {
    clauses.push(`(${CERTIFICATION_READY_SQL})`);
  } else if (query.readiness === 'blocked') {
    clauses.push(`(${BLOCKED_SQL})`);
  }
  if (query.age === 'stale_open' || query.age === 'expired_open') {
    const thresholdDays = query.age === 'expired_open' ? 30 : 7;
    const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000).toISOString();
    clauses.push("review_status NOT IN ('completed', 'certified', 'rejected')");
    clauses.push('updated_at <= ?');
    params.push(cutoff);
  }
  if (query.nextAction) {
    clauses.push(`(${NEXT_ACTION_SQL}) = ?`);
    params.push(query.nextAction);
  }
  if (query.search) {
    const ftsQuery = options.useSearchIndex ? searchIndexQuery(query.search) : undefined;
    if (ftsQuery) {
      clauses.push(`id IN (
        SELECT id
        FROM notebook_research_runs_fts
        WHERE notebook_research_runs_fts MATCH ?
      )`);
      params.push(ftsQuery);
    } else {
      const fallback = researchSearchFallback(query.search);
      clauses.push(fallback.sql);
      params.push(...fallback.params);
    }
  }
  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function searchIndexQuery(search: string): string | undefined {
  const tokens = researchSearchTokens(search);
  if (!tokens?.length) return undefined;
  return tokens.map((token) => `${token}*`).join(' AND ');
}

function researchSearchTokens(search: string): string[] {
  const tokens = search
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((token) => token.length >= 2)
    .slice(0, 12) ?? [];
  return Array.from(new Set(tokens));
}

const RESEARCH_SEARCH_FALLBACK_FIELDS = [
  'LOWER(title)',
  'LOWER(question)',
  "LOWER(COALESCE(domain, ''))",
  "LOWER(COALESCE(owner, ''))",
  'LOWER(intent)',
  "LOWER(COALESCE(source_cell_id, ''))",
  "LOWER(COALESCE(source_cell_name, ''))",
  "LOWER(COALESCE(source_cell_fingerprint, ''))",
  'LOWER(notebook_path)',
  "LOWER(COALESCE(summary, ''))",
  "LOWER(COALESCE(recommendation, ''))",
  "LOWER(COALESCE(warnings, ''))",
  "LOWER(COALESCE(draft_block_path, ''))",
  "LOWER(COALESCE(dql_promotion_action, ''))",
  "LOWER(COALESCE(generated_sql, ''))",
  "LOWER(COALESCE(reviewed_sql, ''))",
  "LOWER(COALESCE(dql_artifact, ''))",
  "LOWER(COALESCE(context, ''))",
  "LOWER(COALESCE(result_preview, ''))",
  "LOWER(COALESCE(evidence, ''))",
  "LOWER(COALESCE(research_plan, ''))",
  "LOWER(COALESCE(context_pack_id, ''))",
  "LOWER(COALESCE(route_decision, ''))",
  "LOWER(COALESCE(display, ''))",
  "LOWER(COALESCE(dql_import_id, ''))",
  "LOWER(COALESCE(dql_candidate_ids, ''))",
  "LOWER(COALESCE(dql_promotion, ''))",
  "LOWER(COALESCE(error, ''))",
] as const;

function researchSearchFallback(search: string): { sql: string; params: string[] } {
  const terms = researchSearchTokens(search);
  const needles = terms.length ? terms : [search.trim().toLowerCase()].filter(Boolean);
  const clauses = needles.map(() => `(${RESEARCH_SEARCH_FALLBACK_FIELDS.map((field) => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
  return {
    sql: `(${clauses.join(' AND ')})`,
    params: needles.flatMap((term) => RESEARCH_SEARCH_FALLBACK_FIELDS.map(() => `%${escapeLike(term)}%`)),
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function searchIndexValues(run: NotebookResearchRun): unknown[] {
  return [
    run.id,
    run.notebookPath,
    run.domain ?? '',
    run.owner ?? '',
    run.sourceCellName ?? '',
    run.title,
    run.question,
    run.intent,
    run.summary ?? '',
    run.recommendation ?? '',
    run.warnings.join(' '),
    run.draftBlockPath ?? '',
    run.dqlPromotionAction ?? '',
    run.generatedSql ?? '',
    run.reviewedSql ?? '',
    searchTextFromValue(run.dqlArtifact),
    searchTextFromValue({
      sourceCellId: run.sourceCellId,
      sourceCellFingerprint: run.sourceCellFingerprint,
      context: run.context,
      resultPreview: run.resultPreview,
      display: run.display,
    }),
    searchTextFromValue({
      evidence: run.evidence,
      contextPackId: run.contextPackId,
      routeDecision: run.routeDecision,
      error: run.error,
    }),
    searchTextFromValue(run.researchPlan),
    searchTextFromValue(run.dqlPromotion),
  ];
}

function searchTextFromValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.slice(0, 20_000);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value).slice(0, 20_000);
  } catch {
    return '';
  }
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function inferResearchDomain(input: {
  context?: unknown;
  dqlPromotion?: NotebookResearchDqlPromotion;
  draftBlockPath?: string;
  notebookPath?: string;
}): string | undefined {
  const contextDomain = domainFromContext(input.context);
  if (contextDomain) return contextDomain;
  const promotedDomain = input.dqlPromotion?.candidates.find((candidate) => candidate.domain)?.domain;
  if (promotedDomain) return cleanOptionalString(promotedDomain);
  const draftDomain = domainFromPath(input.draftBlockPath);
  if (draftDomain) return draftDomain;
  return domainFromPath(input.notebookPath);
}

function domainFromContext(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return cleanOptionalString(record.selectedDomain)
    ?? cleanOptionalString(record.domain)
    ?? domainFromContext(record.block)
    ?? domainFromContext(record.notebook)
    ?? domainFromContext(record.metadata);
}

function domainFromPath(path?: string): string | undefined {
  if (!path) return undefined;
  const domainLayout = path.match(/(?:^|\/)domains\/([^/]+)/);
  if (domainLayout?.[1]) return cleanOptionalString(domainLayout[1]);
  const draftLayout = path.match(/(?:^|\/)_drafts\/([^/]+)/);
  if (draftLayout?.[1]) return cleanOptionalString(draftLayout[1]);
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseDqlPromotion(value: unknown): NotebookResearchDqlPromotion | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const importId = optionalString(record.importId);
  if (!importId) return undefined;
  return {
    importId,
    candidateIds: stringArray(record.candidateIds),
    draftBlockPath: optionalString(record.draftBlockPath),
    recommendedAction: optionalString(record.recommendedAction),
    similarityMatches: parsePromotionMatches(record.similarityMatches),
    candidates: parsePromotionCandidates(record.candidates),
    createdAt: optionalString(record.createdAt) ?? new Date(0).toISOString(),
  };
}

function parsePromotionCandidates(value: unknown): NotebookResearchDqlPromotionCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): NotebookResearchDqlPromotionCandidate[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id = optionalString(record.id);
    const name = optionalString(record.name);
    if (!id || !name) return [];
    return [{
      id,
      name,
      domain: optionalString(record.domain),
      draftPath: optionalString(record.draftPath),
      savedPath: optionalString(record.savedPath),
      reviewStatus: optionalString(record.reviewStatus),
      recommendedAction: optionalString(record.recommendedAction),
      similarityMatches: parsePromotionMatches(record.similarityMatches),
      parameterPolicy: parseParameterPolicy(record.parameterPolicy),
      allowedFilters: stringArray(record.allowedFilters),
      warnings: stringArray(record.warnings),
    }];
  });
}

function parsePromotionMatches(value: unknown): NotebookResearchDqlPromotionMatch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): NotebookResearchDqlPromotionMatch[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = optionalString(record.name);
    const reason = optionalString(record.reason);
    if (!name || !reason) return [];
    const score = typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : 0;
    return [{
      kind: optionalString(record.kind) ?? 'near_variant',
      objectKey: optionalString(record.objectKey),
      name,
      status: optionalString(record.status),
      source: optionalString(record.source),
      score,
      reason,
      recommendedAction: optionalString(record.recommendedAction) ?? 'review_required',
    }];
  });
}

function parseParameterPolicy(value: unknown): Array<{ name: string; policy: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Array<{ name: string; policy: string }> => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = optionalString(record.name);
    const policy = optionalString(record.policy);
    return name && policy ? [{ name, policy }] : [];
  });
}

function parseResearchPlan(value: unknown): NotebookResearchPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
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
  const promotionPath = parseResearchPlanPromotionPath(promotion.path);
  const rowCount = typeof preview.rowCount === 'number' && Number.isFinite(preview.rowCount) ? preview.rowCount : undefined;
  return {
    sqlState,
    grain: optionalString(record.grain),
    parameterPolicy: parseParameterPolicy(record.parameterPolicy),
    allowedFilters: stringArray(record.allowedFilters),
    evidence: {
      trustLabel: optionalString(evidence.trustLabel),
      contextPackId: optionalString(evidence.contextPackId),
      evidenceCount: finiteNumber(evidence.evidenceCount),
      relationCount: finiteNumber(evidence.relationCount),
      missingContextCount: finiteNumber(evidence.missingContextCount),
    },
    preview: {
      status: previewStatus,
      ...(rowCount === undefined ? {} : { rowCount }),
    },
    promotion: {
      path: promotionPath,
      duplicateDecision: optionalString(promotion.duplicateDecision),
    },
    reviewFocus: stringArray(record.reviewFocus),
    generatedAt: optionalString(record.generatedAt) ?? new Date(0).toISOString(),
  };
}

function parseResearchPlanPromotionPath(value: unknown): NotebookResearchPlan['promotion']['path'] {
  return value === 'review_context'
    || value === 'run_preview'
    || value === 'reuse_existing'
    || value === 'create_dql_draft'
    || value === 'open_certification'
    || value === 'complete_review'
    ? value
    : 'needs_sql';
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
