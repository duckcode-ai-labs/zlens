/**
 * HTTP handlers for `/api/apps`, `/api/apps/:id`, `/api/apps/:id/dashboards/:did`,
 * `/api/persona`. Designed to be invoked from `local-runtime.ts`'s request
 * dispatcher — returns `true` if the request was handled, `false` otherwise.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync, type Dirent, type Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, relative, basename, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostActor, hostActorDisplayName } from './host/request-context.js';
import { blockCertificationByline, blockPreviousCertificationByline, bylineForViewer, gitUserName, localPersonAliases, localPersonSelf, personDisplayName, type CertificationByline } from './certification-receipt.js';
import { currentRecordOwner, ownedBy } from './host/record-owner.js';
import { pinForReader, previewWithoutFigures, WITHHELD_ANSWER } from './host/answer-figures.js';
import type {
  AgentAnswer,
  AgentResultPayload,
  AppBuilderPlannerCompletion,
  AppBuilderPlannerProvenance,
  AppPlan,
  AppBuildHandoffSourceSummary,
  AppSourceCatalogRecord,
  ContextAuthoringProposalV1,
  NarrateInput,
  NarrateItem,
  NarrateResult,
  ResearchPlan as AppResearchPlan,
} from '@zlens/agent';
import {
  dashboardTileFilterChoice,
  loadAppDocument,
  findAppDocuments,
  loadDashboardDocument,
  findDashboardsForApp,
  parseAppDocument,
  parseDashboardDocument,
  normalizeDqlArtifactReference,
  suggestAppId,
  appNameFromGoal,
  createAppBuildDraft,
  createBlankAppBuildPage,
  newAppBuildDraftId,
  appBuildDraftHash,
  appBuildPreviewIntentFingerprint,
  applyAppBuildDraftOperations,
  packDashboardLayoutItems,
  appSourceIdsUsedByTiles,
  appTrustAnswer,
  appsPublishSettings,
  isTrustReminderTaskId,
  notCertifiedTiles,
  publishedAppTileTrust,
  requireCertifiedToPublishMessage,
  APP_SOURCE_POLICY,
  type AppsPublishSettings,
  type AppDocument,
  type BlockParameterDefinition,
  type DashboardDisplayMetadata,
  type DashboardDatasetBinding,
  type DashboardDocument,
  type DashboardFilter,
  type DashboardGridItem,
  type DashboardInteractions,
  type DatasetDescriptor,
  type DatasetPhysicalField,
  type SemanticTileConversionProvenanceV1,
  type TileQuery,
  type AppBuildDraft,
  type AppBuildRequirement,
  type AppBuildDraftOperation,
  type AppBuildDraftSource,
  type AppBuildSourceLifecycle,
  type AppBuildSourcePolicy,
  type AppAnalyticalContextV1,
  datasetPhysicalField,
  normalizeTileQuery,
  datasetTileVisualizationCompatibility,
  showMeFactsFromDescriptor,
  showMeFirstChoice,
  showMeInputFromQuery,
  tileQueryOutputAliases,
  tileQueryValidationRuns,
  validateTileQuery,
  resolveBlockReplacement,
} from '@zlens/core';
import {
  defaultPersonaRegistry,
  defaultLocalAppsDbPath,
  LocalAppStorage,
  personaFromMember,
  type ActivePersona,
  type LocalAiPin,
  type LocalAppConversationContext,
  type LocalAppInvestigation,
  type LocalAppInvestigationIntent,
  type LocalAppInvestigationReportSection,
} from '@zlens/project';
import type { LocalOperation, LocalOperationProgress } from './local-operation-coordinator.js';
import { readEnv } from '@zlens/core';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  projectRoot: string;
  /** Dataset field-query authoring; on unless explicitly `false` (`apps.datasets: false`). */
  datasetsEnabled?: boolean;
  /** Read saved queries' result columns as fields, once per revision (design D1). */
  readSavedQueryFields?: (sourceIds: string[]) => Promise<void>;
  /** With a host (RFC 0010): whether the person may open this App; the list shows only those. */
  mayViewApp?: (appId: string) => Promise<boolean>;
  /** HH-14: whether the host keeps needs-review figures from the person asking (the runtime's one decision). */
  answerFiguresRule?: () => Promise<'show' | 'withhold_review'>;
  /**
   * With a host: whether figures read from these tables could differ for another reader (a row rule, column
   * policy or tag protection applies). Absent without a host, where an answer's text is saved as before.
   */
  figuresDependOnReader?: (relations: string[] | undefined) => Promise<boolean>;
  /**
   * With a host: whether this reader may keep reading an earlier static answer tile's text on this App (those who
   * replace such tiles: the App's authors and stewards). Others read a placeholder (pageForReader).
   */
  mayKeepAnswerText?: (appId: string) => Promise<boolean>;
  /**
   * One of the signed-in person's own Ask answers (never anyone else's): the tables its SQL read (absent when
   * ZLens cannot list them all), and that SQL, for a live tile.
   */
  askRunReads?: (runId: string) => Promise<{ relations?: string[]; sql?: string; question?: string } | null>;
  executeSql?: (sql: string) => Promise<unknown>;
  generateInvestigationSql?: (input: AppInvestigationGenerationRequest) => Promise<AppInvestigationGenerationResult>;
  runNotebook?: (appId: string, notebookPath: string) => Promise<void>;
  /** Grounded ReAct research planner (P4) — supplied by the runtime, which holds the
   *  metric/block catalog. Lets the App ask lane decide + offer real follow-ups. */
  planResearch?: (input: { question: string; isFollowUp?: boolean }) => Promise<AppResearchPlan>;
  /** Governed answer generator — supplied by the runtime. Lets the two-phase app
   *  build fill coverage gaps with bounded, review-required generated SQL. */
  generateGovernedAnswer?: (question: string, context?: AppContextEnvelopeV1) => Promise<AppBuildGeneratedAnswer>;
  /** App-specific planning call. The runtime supplies the same configured
   * provider adapter as Ask, but App Builder owns the structured state machine. */
  planAppBuild?: AppBuilderPlannerCompletion;
  /**
   * The runtime owns the immutable Context Authoring store and the current
   * project snapshot.  App gaps call this narrow hook so they create a typed
   * Domain Dataset draft instead of an app-local free-SQL artifact.
   */
  createDatasetGapProposal?: (input: {
    appBuildId: string;
    requirement: AppBuildRequirement;
    domain?: string;
    sourceRelation?: string;
  }) => Promise<ContextAuthoringProposalV1>;
  /** Story narrator — supplied by the runtime (LLM-backed with a deterministic
   *  fallback). Commit uses it to write the app's narrated story sections. */
  narrate?: (input: NarrateInput) => Promise<NarrateResult>;
  verifyDashboardRun?: (input: { runId: string; appId: string; dashboardId: string; tileIds: string[] }) =>
    | { ok: true; snapshotId: string; resultFingerprint: string }
    | { ok: false; error: string };
  verifyAppBuildPreview?: (input: {
    runId: string;
    draftId: string;
    dashboardId: string;
    tileIds: string[];
    datasetTileIds?: string[];
    intentFingerprint: string;
    /** Local review preview and Project publication have different authority gates. */
    purpose: 'local_preview' | 'project_publish';
  }) =>
    | Promise<
      | { ok: true; snapshotId: string; filterFingerprint: string; resultFingerprint: string; intentFingerprint: string }
      | { ok: false; error: string }
    >
    | { ok: true; snapshotId: string; filterFingerprint: string; resultFingerprint: string; intentFingerprint: string }
    | { ok: false; error: string };
  /**
   * The local runtime owns the only authoritative Dataset chart-run evidence.
   * Apps API deliberately receives a narrow answer port instead of accepting
   * rows, source contracts, or receipts from the browser.
   */
  answerDatasetChart?: (input: {
    appId: string;
    dashboardId: string;
    tileId: string;
    runId: string;
    question: string;
  }) => Promise<
    | {
      ok: true;
      answer: string;
      answerMode?: 'provider' | 'deterministic_context_summary' | 'out_of_context';
      trustState: 'certified' | 'review_required' | 'draft_ready';
      reviewStatus: 'certified' | 'review_required' | 'draft_ready';
      citations: Array<{ kind: string; name: string; path?: string }>;
      followUps: string[];
      context: AppAnalyticalContextV1;
    }
    | { ok: false; error: string }
  >;
  /**
   * The runtime owns current Dataset execution evidence and the existing
   * review-draft block writer.  This port deliberately receives only route
   * identifiers and optimistic content guards; SQL, result rows, source
   * contracts, and receipts are never accepted from the browser.
   */
  saveDatasetTileAsBlock?: (input: DatasetTileSaveAsBlockRequest) => Promise<DatasetTileSaveAsBlockResponse>;
  /**
   * Replacing an App Dataset tile is a separate, proof-gated action. The
   * browser may name only an already-saved review-draft path and optimistic
   * guards; the runtime reloads the current App, source, and block authority
   * and performs the fresh same-scope equivalence check.
   */
  replaceDatasetTileWithReviewBlock?: (input: DatasetTileReplaceWithBlockRequest) => Promise<DatasetTileReplaceWithBlockResponse>;
  /**
   * M4-CONV-01: the browser names a legacy tile and optimistic guards only.
   * The runtime resolves semantic/Dataset identity and runs the proof itself.
   */
  previewSemanticTileConversion?: (input: SemanticTileConversionPreviewRequest) => Promise<SemanticTileConversionPreviewResponse>;
  acceptSemanticTileConversion?: (input: SemanticTileConversionAcceptRequest) => Promise<SemanticTileConversionAcceptResponse>;
  /** Internal test seam for a current immutable source catalog. The local
   * runtime leaves this unset and always resolves the real project catalog. */
  resolveDatasetSourceAuthority?: (sourceIds: string[]) => Promise<AppSourceCatalogRecord[]> | AppSourceCatalogRecord[];
  queueOperation?: <TResult>(
    input: { type: string; scope: string; resourceRevision?: string; message?: string; cancellable?: boolean },
    task: (signal: AbortSignal, report: (progress: Partial<LocalOperationProgress>) => void) => Promise<TResult>,
  ) => LocalOperation<TResult>;
  scheduleProjectRefresh?: (reason: string) => void;
}

export interface DatasetTileSaveAsBlockRequest {
  draftId: string;
  dashboardId: string;
  tileId: string;
  runId: string;
  expectedRevision: number;
  expectedProposalHash: string;
  name?: string;
  domain?: string;
  description?: string;
}

export type DatasetTileSaveAsBlockResponse =
  | {
    ok: true;
    path: string;
    status: 'draft';
    provenanceFingerprint: string;
    replacementEligible: boolean;
    replacementMessage?: string;
  }
  | { ok: false; code: string; error: string; status?: number };

export interface DatasetTileReplaceWithBlockRequest {
  draftId: string;
  dashboardId: string;
  tileId: string;
  runId: string;
  expectedRevision: number;
  expectedProposalHash: string;
  /** Relative path of a server-created `_drafts` block. */
  blockPath: string;
  /** Explicitly acknowledges that the replacement remains review-required. */
  enableReviewRequired?: boolean;
}

export type DatasetTileReplaceWithBlockResponse =
  | {
    ok: true;
    draft: AppBuildDraft;
    blockPath: string;
    equivalenceProofFingerprint: string;
  }
  | { ok: false; code: string; error: string; status?: number };

export interface SemanticTileConversionPreviewRequest {
  draftId: string;
  dashboardId: string;
  tileId: string;
  expectedRevision: number;
  expectedProposalHash: string;
}

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
  | { ok: false; code: string; error: string; status?: number };

export interface SemanticTileConversionAcceptRequest {
  draftId: string;
  dashboardId: string;
  tileId: string;
  proposalId: string;
  expectedRevision: number;
  expectedProposalHash: string;
}

export type SemanticTileConversionAcceptResponse =
  | { ok: true; draft: AppBuildDraft; equivalenceProofFingerprint: string }
  | { ok: false; code: string; error: string; status?: number };

/** Runtime hooks the two-phase app build can use during propose (all optional —
 *  without them, gaps stay listed as uncovered research questions). */
export interface AppBuildHooks {
  generateGovernedAnswer?: (question: string, context?: AppContextEnvelopeV1) => Promise<AppBuildGeneratedAnswer>;
  planAppBuild?: AppBuilderPlannerCompletion;
  /** The App feature gate also applies to AI-authored field-query tiles. */
  datasetsEnabled?: boolean;
  /**
   * Read the result columns of these saved queries as fields, once per
   * revision (design D1), so the planner builds field tiles from them.
   * Failures are not errors: such a saved query shows its result as it is.
   */
  readSavedQueryFields?: (sourceIds: string[]) => Promise<void>;
}

/**
 * One bounded repair trace shared by App proposal and dashboard execution.
 * Repaired SQL never inherits semantic certification: the trace is evidence that
 * the result is useful for review, not permission to publish it as governed.
 */
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

export type AppBuildGeneratedAnswer = AgentAnswer & {
  appBuilderRepair?: AppExecutionRepairTrace;
};

export interface AppContextEnvelopeV1 {
  version: 1;
  app: {
    id: string;
    name: string;
    domain: string;
    audience?: string;
    lifecycle: string;
    visibility: string;
    publicationIntent: 'personal' | 'shared_project';
    businessOutcome?: string;
    caveats: string[];
  };
  dashboards: Array<{
    id: string;
    title: string;
    filters: DashboardDocument['filters'];
    story?: DashboardDocument['story'];
    tiles: Array<Record<string, unknown>>;
  }>;
  /**
   * The app's own review-required draft analyses (`apps/<id>/drafts/*.dql`).
   *
   * These never enter `manifest.blocks` — the manifest's block scan set is
   * blocks/domains/dashboards/workbooks — so they have no KG node and no
   * catalog row, and retrieval could not see them at any tier. They are carried
   * on this envelope instead of being indexed globally on purpose: they are
   * AI-generated exploratory SQL scoped to one app, and indexing them
   * project-wide would leak one app's drafts into every other app's context and
   * into every Ask question.
   */
  drafts: Array<{
    name: string;
    path: string;
    status: string;
    description?: string;
    question?: string;
    sql?: string;
  }>;
  focus?: { dashboardId?: string; tileId?: string; blockId?: string };
}

/**
 * The App storage for this request: analysis memos, App conversations and AI pins are each person's with a host (they
 * hold questions, answers and results computed under that person's row rules), read and kept only for them; Apps
 * and their files are the App's.
 */
/** HH-14: whether this request's person is kept from needs-review figures (an analysis memo is always review-required). */
async function memoFiguresWithheld(ctx: Ctx): Promise<boolean> {
  return (await ctx.answerFiguresRule?.()) === 'withhold_review';
}

/**
 * HH-14: an analysis memo as a person the host keeps needs-review figures from reads it, until it is certified: its
 * question, SQL and result shape, never a value or a sentence written from one.
 */
function investigationForReader(investigation: LocalAppInvestigation, withheld: boolean): LocalAppInvestigation & { figuresWithheld?: true } {
  if (!withheld || investigation.reviewStatus === 'certified') return investigation;
  const { summary: _summary, recommendation: _recommendation, metrics: _metrics, driverCards: _cards, evidence: _evidence, reportSections: _sections, ...rest } = investigation;
  const previews = (investigation.resultPreviews ?? []).map((preview) => {
    const record = preview && typeof preview === 'object' ? preview as Record<string, unknown> : {};
    const { result: _result, rows: _rows, ...kept } = record;
    return { ...kept, result: previewWithoutFigures(preview) ?? { columns: [], rowCount: 0, rows: [] } };
  });
  return { ...rest, resultPreviews: previews, driverCards: [], reportSections: [], summary: WITHHELD_ANSWER, figuresWithheld: true };
}

function openAppStorage(projectRoot: string): LocalAppStorage {
  return new LocalAppStorage(defaultLocalAppsDbPath(projectRoot), { owner: currentRecordOwner() });
}

export async function handleAppsApi(ctx: Ctx): Promise<boolean> {
  const { req, res, path, projectRoot } = ctx;

  if (req.method === 'POST' && path === '/api/visualizations/recommend') {
    try {
      const body = await readJson<VisualizationRecommendationRequest>(req);
      const result = recommendVisualization(projectRoot, body);
      if (!result.ok) {
        sendJson(res, 400, result);
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  // ── Apps ────────────────────────────────────────────────────────────────

  // Project settings that decide publishing (T3), read fresh from
  // dql.config.json so a change applies to the next publish.
  if (req.method === 'GET' && path === '/api/apps/settings') {
    sendJson(res, 200, { ok: true, ...readAppsPublishSettings(projectRoot) });
    return true;
  }

  if (req.method === 'POST' && path === '/api/app-builds') {
    try {
      const body = await readJson<{
        appId?: string; baseAppId?: string; name?: string; goal?: string; audience?: string; domain?: string;
        authoringMode?: 'ai' | 'manual'; sourcePolicy?: 'governed_only' | 'include_review_required';
        template?: 'executive_brief' | 'operational_dashboard' | 'investigation' | 'blank';
        entrypoint?: 'studio' | 'ask';
      }>(req);
      // Opening a published v3 Dataset App creates a new local draft.  The
      // page binding is immutable authored provenance; the source cards must
      // come from the *current* governed catalog so Studio cannot resurrect a
      // serialized capability/trust claim from the published document.
      let datasetCatalogError: string | undefined;
      let resolvePublishedDatasetSources: CreateStoredAppBuildDraftOptions['resolvePublishedDatasetSources'];
      if (body.baseAppId) {
        try {
          const { ensureAgentProjectReady, resolveAppSourceCatalogRecords } = await import('@zlens/agent');
          await ensureAgentProjectReady(projectRoot);
          resolvePublishedDatasetSources = (sourceIds, sourcePolicy) => resolveAppSourceCatalogRecords(
            projectRoot,
            sourceIds,
            sourcePolicy,
          );
        } catch (error) {
          datasetCatalogError = error instanceof Error ? error.message : String(error);
        }
      }
      const draft = createStoredAppBuildDraft(projectRoot, body, {
        ...(resolvePublishedDatasetSources ? { resolvePublishedDatasetSources } : {}),
        ...(datasetCatalogError ? { datasetCatalogError } : {}),
      });
      sendJson(res, 201, { ok: true, draft });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (req.method === 'GET' && path === '/api/app-builds') {
    const storage = openAppStorage(projectRoot);
    try {
      const drafts = storage.listAppBuildDrafts().flatMap((stored) => {
        const migrated = migrateLegacyAppBuildDraft(projectRoot, stored);
        if (!migrated) return [];
        if (stored.version !== migrated.version) storage.saveAppBuildDraft(migrated);
        return [migrated];
      });
      sendJson(res, 200, { ok: true, drafts });
    } finally {
      storage.close();
    }
    return true;
  }

  const sourceCandidatesMatch = path.match(/^\/api\/app-builds\/([^/]+)\/source-candidates$/);
  if (sourceCandidatesMatch && req.method === 'GET') {
    try {
      const id = decodeURIComponent(sourceCandidatesMatch[1]);
      const current = loadStoredAppBuildDraft(projectRoot, id);
      if (!current) {
        sendJson(res, 404, { ok: false, error: 'App Build Draft not found.' });
        return true;
      }
      const { ensureAgentProjectReady, queryAppSourceCatalog } = await import('@zlens/agent');
      await ensureAgentProjectReady(projectRoot);
      const lifecycles = splitQueryValues(ctx.url.searchParams.getAll('lifecycle')) as AppBuildSourceLifecycle[];
      const domains = splitQueryValues(ctx.url.searchParams.getAll('domain'));
      const page = queryAppSourceCatalog(projectRoot, {
        query: ctx.url.searchParams.get('q') ?? undefined,
        cursor: ctx.url.searchParams.get('cursor') ?? undefined,
        limit: Number(ctx.url.searchParams.get('limit')) || 50,
        lifecycles: lifecycles.length ? lifecycles : undefined,
        domains: domains.length ? domains : undefined,
        // No per-App data rule (T3): certified and not-certified data are both listed, certified first.
        sourcePolicy: APP_SOURCE_POLICY,
        includeDeprecated: ctx.url.searchParams.get('includeDeprecated') === 'true',
      });
      sendJson(res, 200, {
        ok: true,
        features: { datasets: ctx.datasetsEnabled !== false },
        ...page,
        items: withCertificationBylines(projectRoot, page.items),
      });
    } catch (err) {
      const error = err as Error & { code?: string };
      sendJson(res, error.code?.includes('CURSOR') ? 409 : 400, { ok: false, code: error.code, error: error.message });
    }
    return true;
  }

  if (sourceCandidatesMatch && req.method === 'POST') {
    try {
      const id = decodeURIComponent(sourceCandidatesMatch[1]);
      const current = loadStoredAppBuildDraft(projectRoot, id);
      if (!current) {
        sendJson(res, 404, { ok: false, error: 'App Build Draft not found.' });
        return true;
      }
      const body = await readJson<{ sourceIds?: string[]; includeReviewRequired?: boolean }>(req);
      if (body.includeReviewRequired !== undefined && body.includeReviewRequired !== true) {
        throw new Error('APP_BUILD_SOURCE_RESOLVE_INVALID: includeReviewRequired must be true when supplied.');
      }
      if (body.sourceIds !== undefined && (!Array.isArray(body.sourceIds) || body.sourceIds.some((sourceId) => typeof sourceId !== 'string' || !sourceId.trim()))) {
        throw new Error('APP_BUILD_SOURCE_RESOLVE_INVALID: sourceIds must be a non-empty string array when supplied.');
      }
      const { ensureAgentProjectReady, resolveAppSourceCatalogRecords } = await import('@zlens/agent');
      await ensureAgentProjectReady(projectRoot);
      // No per-App data rule (T3): every source resolves; trust is shown per tile.
      const result = resolveAppSourceCatalogRecords(
        projectRoot,
        body.sourceIds ?? [],
        APP_SOURCE_POLICY,
      );
      sendJson(res, 200, { ok: true, ...result, items: withCertificationBylines(projectRoot, result.items) });
    } catch (err) {
      const error = err as Error & { code?: string };
      sendJson(res, 400, { ok: false, code: error.code, error: error.message });
    }
    return true;
  }

  let buildMatch = path.match(/^\/api\/app-builds\/([^/]+)$/);
  if (buildMatch && req.method === 'GET') {
    const draft = loadStoredAppBuildDraft(projectRoot, decodeURIComponent(buildMatch[1]));
    sendJson(res, draft ? 200 : 404, draft ? { ok: true, draft } : { ok: false, error: 'App Build Draft not found.' });
    return true;
  }
  if (buildMatch && req.method === 'PATCH') {
    try {
      const id = decodeURIComponent(buildMatch[1]);
      const current = loadStoredAppBuildDraft(projectRoot, id);
      if (!current) {
        sendJson(res, 404, { ok: false, error: 'App Build Draft not found.' });
        return true;
      }
      const body = await readJson<{ expectedRevision?: number; expectedProposalHash?: string; operations?: AppBuildDraftOperation[] }>(req);
      if (body.expectedProposalHash && body.expectedProposalHash !== current.proposalHash) {
        sendJson(res, 409, { ok: false, error: 'APP_BUILD_PROPOSAL_CONFLICT: refresh the local draft before applying changes.' });
        return true;
      }
      // Dataset source cards are server-resolved authority, never browser
      // assertions. Bind/canonicalize them before a preview receipt is
      // evaluated so a client cannot claim certification or remove a review
      // task around a stale semantic capability.
      const authorityBoundOperations = await bindServerResolvedDatasetSourceOperations(
        projectRoot,
        current,
        body.operations ?? [],
        ctx.resolveDatasetSourceAuthority,
      );
      const operations = await bindServerIssuedPreviewReceipts(current, authorityBoundOperations, ctx.verifyAppBuildPreview);
      const next = applyAppBuildDraftOperations(current, body.expectedRevision ?? -1, operations);
      // An Ask answer's text added by an edit is held to the same rule as one added from Ask.
      const added = await addedStaticAnswerTilesInDraft(current, next, ctx.figuresDependOnReader);
      if (added.length) {
        sendJson(res, 409, { ok: false, code: 'ANSWER_FIGURES_DEPEND_ON_READER', error: ANSWER_FIGURES_DEPEND_ON_READER, tiles: added.map((tile) => tile.tileId) });
        return true;
      }
      writeStoredAppBuildDraft(projectRoot, next, {
        expectedRevision: current.revision,
        operations,
      });
      sendJson(res, 200, { ok: true, draft: next });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, message.includes('APP_BUILD_REVISION_CONFLICT') ? 409 : 400, { ok: false, error: message });
    }
    return true;
  }

  const saveDatasetTileMatch = path.match(/^\/api\/app-builds\/([^/]+)\/dashboards\/([^/]+)\/tiles\/([^/]+)\/save-as-block$/);
  if (saveDatasetTileMatch && req.method === 'POST') {
    try {
      if (!ctx.saveDatasetTileAsBlock) {
        sendJson(res, 409, {
          ok: false,
          code: 'DATASET_TILE_SAVE_UNAVAILABLE',
          error: 'This local runtime cannot save a Dataset tile as a review draft. Update the local ZLens runtime and run the tile again.',
        });
        return true;
      }
      const body = await readJson<{
        runId?: unknown;
        expectedRevision?: unknown;
        expectedProposalHash?: unknown;
        name?: unknown;
        domain?: unknown;
        description?: unknown;
      }>(req);
      const runId = cleanString(body.runId);
      const expectedProposalHash = cleanString(body.expectedProposalHash);
      const expectedRevision = typeof body.expectedRevision === 'number' && Number.isInteger(body.expectedRevision)
        ? body.expectedRevision
        : undefined;
      if (!runId || expectedRevision === undefined || !expectedProposalHash) {
        sendJson(res, 400, {
          ok: false,
          code: 'DATASET_TILE_SAVE_INVALID_REQUEST',
          error: 'Saving a Dataset tile requires the current run id, draft revision, and content hash.',
        });
        return true;
      }
      for (const [label, value] of [
        ['name', body.name],
        ['domain', body.domain],
        ['description', body.description],
      ] as const) {
        if (value !== undefined && typeof value !== 'string') {
          sendJson(res, 400, {
            ok: false,
            code: 'DATASET_TILE_SAVE_INVALID_REQUEST',
            error: `Dataset tile ${label} must be text when supplied.`,
          });
          return true;
        }
      }
      const result = await ctx.saveDatasetTileAsBlock({
        draftId: decodeURIComponent(saveDatasetTileMatch[1]),
        dashboardId: decodeURIComponent(saveDatasetTileMatch[2]),
        tileId: decodeURIComponent(saveDatasetTileMatch[3]),
        runId,
        expectedRevision,
        expectedProposalHash,
        ...(cleanString(body.name) ? { name: cleanString(body.name) } : {}),
        ...(cleanString(body.domain) ? { domain: cleanString(body.domain) } : {}),
        ...(cleanString(body.description) ? { description: cleanString(body.description) } : {}),
      });
      sendJson(res, result.ok ? 201 : (result.status ?? 409), result);
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        code: 'DATASET_TILE_SAVE_INVALID_REQUEST',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  const replaceDatasetTileMatch = path.match(/^\/api\/app-builds\/([^/]+)\/dashboards\/([^/]+)\/tiles\/([^/]+)\/replace-with-block$/);
  if (replaceDatasetTileMatch && req.method === 'POST') {
    try {
      if (!ctx.replaceDatasetTileWithReviewBlock) {
        sendJson(res, 409, {
          ok: false,
          code: 'DATASET_TILE_REPLACE_UNAVAILABLE',
          error: 'This local runtime cannot replace a Dataset tile with a review draft. Update the local ZLens runtime and run a fresh preview.',
        });
        return true;
      }
      const body = await readJson<{
        runId?: unknown;
        expectedRevision?: unknown;
        expectedProposalHash?: unknown;
        blockPath?: unknown;
        enableReviewRequired?: unknown;
      }>(req);
      const runId = cleanString(body.runId);
      const expectedProposalHash = cleanString(body.expectedProposalHash);
      const blockPath = cleanString(body.blockPath);
      const expectedRevision = typeof body.expectedRevision === 'number' && Number.isInteger(body.expectedRevision)
        ? body.expectedRevision
        : undefined;
      if (!runId || expectedRevision === undefined || !expectedProposalHash || !blockPath) {
        sendJson(res, 400, {
          ok: false,
          code: 'DATASET_TILE_REPLACE_INVALID_REQUEST',
          error: 'Replacing a Dataset tile requires the current run id, draft revision, content hash, and saved review-draft path.',
        });
        return true;
      }
      if (body.enableReviewRequired !== undefined && typeof body.enableReviewRequired !== 'boolean') {
        sendJson(res, 400, {
          ok: false,
          code: 'DATASET_TILE_REPLACE_INVALID_REQUEST',
          error: 'The review-required acknowledgement must be true or false when supplied.',
        });
        return true;
      }
      const result = await ctx.replaceDatasetTileWithReviewBlock({
        draftId: decodeURIComponent(replaceDatasetTileMatch[1]),
        dashboardId: decodeURIComponent(replaceDatasetTileMatch[2]),
        tileId: decodeURIComponent(replaceDatasetTileMatch[3]),
        runId,
        expectedRevision,
        expectedProposalHash,
        blockPath,
        ...(body.enableReviewRequired === true ? { enableReviewRequired: true } : {}),
      });
      sendJson(res, result.ok ? 200 : (result.status ?? 409), result);
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        code: 'DATASET_TILE_REPLACE_INVALID_REQUEST',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  const semanticConversionPreviewMatch = path.match(/^\/api\/app-builds\/([^/]+)\/dashboards\/([^/]+)\/tiles\/([^/]+)\/preview-semantic-conversion$/);
  if (semanticConversionPreviewMatch && req.method === 'POST') {
    try {
      if (!ctx.previewSemanticTileConversion) {
        sendJson(res, 409, {
          ok: false,
          code: 'SEMANTIC_TILE_CONVERSION_UNAVAILABLE',
          error: 'This local runtime cannot preview a legacy semantic-to-Dataset conversion. Update ZLens and run a fresh legacy semantic tile.',
        });
        return true;
      }
      const body = await readJson<{ expectedRevision?: unknown; expectedProposalHash?: unknown }>(req);
      const expectedProposalHash = cleanString(body.expectedProposalHash);
      const expectedRevision = typeof body.expectedRevision === 'number' && Number.isInteger(body.expectedRevision)
        ? body.expectedRevision
        : undefined;
      if (expectedRevision === undefined || !expectedProposalHash) {
        sendJson(res, 400, {
          ok: false,
          code: 'SEMANTIC_TILE_CONVERSION_INVALID_REQUEST',
          error: 'Previewing a conversion requires the current App draft revision and content hash.',
        });
        return true;
      }
      const result = await ctx.previewSemanticTileConversion({
        draftId: decodeURIComponent(semanticConversionPreviewMatch[1]),
        dashboardId: decodeURIComponent(semanticConversionPreviewMatch[2]),
        tileId: decodeURIComponent(semanticConversionPreviewMatch[3]),
        expectedRevision,
        expectedProposalHash,
      });
      sendJson(res, result.ok ? 200 : (result.status ?? 409), result);
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        code: 'SEMANTIC_TILE_CONVERSION_INVALID_REQUEST',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  const semanticConversionAcceptMatch = path.match(/^\/api\/app-builds\/([^/]+)\/dashboards\/([^/]+)\/tiles\/([^/]+)\/semantic-conversions\/([^/]+)\/accept$/);
  if (semanticConversionAcceptMatch && req.method === 'POST') {
    try {
      if (!ctx.acceptSemanticTileConversion) {
        sendJson(res, 409, {
          ok: false,
          code: 'SEMANTIC_TILE_CONVERSION_UNAVAILABLE',
          error: 'This local runtime cannot accept a legacy semantic-to-Dataset conversion. Update ZLens and preview the tile again.',
        });
        return true;
      }
      const body = await readJson<{ expectedRevision?: unknown; expectedProposalHash?: unknown }>(req);
      const expectedProposalHash = cleanString(body.expectedProposalHash);
      const expectedRevision = typeof body.expectedRevision === 'number' && Number.isInteger(body.expectedRevision)
        ? body.expectedRevision
        : undefined;
      if (expectedRevision === undefined || !expectedProposalHash) {
        sendJson(res, 400, {
          ok: false,
          code: 'SEMANTIC_TILE_CONVERSION_INVALID_REQUEST',
          error: 'Accepting a conversion requires the current App draft revision and content hash.',
        });
        return true;
      }
      const result = await ctx.acceptSemanticTileConversion({
        draftId: decodeURIComponent(semanticConversionAcceptMatch[1]),
        dashboardId: decodeURIComponent(semanticConversionAcceptMatch[2]),
        tileId: decodeURIComponent(semanticConversionAcceptMatch[3]),
        proposalId: decodeURIComponent(semanticConversionAcceptMatch[4]),
        expectedRevision,
        expectedProposalHash,
      });
      sendJson(res, result.ok ? 200 : (result.status ?? 409), result);
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        code: 'SEMANTIC_TILE_CONVERSION_INVALID_REQUEST',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  if (buildMatch && req.method === 'DELETE') {
    try {
      const id = decodeURIComponent(buildMatch[1]);
      const current = loadStoredAppBuildDraft(projectRoot, id);
      if (!current) {
        sendJson(res, 404, { ok: false, error: 'App Build Draft not found.' });
        return true;
      }
      const body = await readJson<{ expectedRevision?: number; proposalHash?: string }>(req);
      if (body.expectedRevision !== current.revision || body.proposalHash !== current.proposalHash) {
        sendJson(res, 409, { ok: false, error: 'APP_BUILD_REVISION_CONFLICT: refresh before deleting this local draft.' });
        return true;
      }
      sendJson(res, 200, deleteStoredAppBuildDraft(projectRoot, current));
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const askResultMatch = path.match(/^\/api\/app-builds\/([^/]+)\/ask-results$/);
  if (askResultMatch && req.method === 'POST') {
    try {
      const id = decodeURIComponent(askResultMatch[1]);
      let body = await readJson<AppBuildAskResultInput>(req);
      // With a host, the answer is the person's own run: what it read decides whether its text may be shown to others.
      const runId = cleanString(body.runId);
      const reads = runId && ctx.askRunReads ? await ctx.askRunReads(runId) : null;
      const hosted = Boolean(ctx.figuresDependOnReader);
      if (body.mode === 'live') {
        if (!reads?.sql) {
          sendJson(res, 400, { ok: false, code: 'ANSWER_HAS_NO_LIVE_FORM', error: 'ZLens has no SQL for this answer that it could run for each reader, so it cannot add it as a live tile.' });
          return true;
        }
        // A live tile runs the answer's SQL for each reader; it carries no figures of its own.
        body = { ...body, sql: reads.sql, dqlSource: undefined, certifiedBlockId: undefined };
      } else if (hosted && isStaticAnswerResult(body) && await ctx.figuresDependOnReader!(reads?.relations)) {
        sendJson(res, 409, {
          ok: false,
          code: 'ANSWER_FIGURES_DEPEND_ON_READER',
          error: ANSWER_FIGURES_DEPEND_ON_READER,
          // The way forward: a live tile, which runs the answer's SQL for each reader.
          ways: reads?.sql ? [{ id: 'live', label: 'Add as a live tile' }] : [],
          details: { ways: reads?.sql ? [{ id: 'live', label: 'Add as a live tile' }] : [] },
        });
        return true;
      }
      const result = addAskResultToAppBuildDraft(projectRoot, id, body, { hosted, ...(reads?.relations ? { relations: reads.relations } : {}) });
      sendJson(res, result.deduped ? 200 : 201, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, message.includes('APP_BUILD_') ? 409 : 400, { ok: false, error: message });
    }
    return true;
  }

  const draftAiProposalMatch = path.match(/^\/api\/app-builds\/([^/]+)\/ai-proposals$/);
  if (draftAiProposalMatch && req.method === 'POST') {
    try {
      const id = decodeURIComponent(draftAiProposalMatch[1]);
      const current = loadStoredAppBuildDraft(projectRoot, id);
      if (!current) {
        sendJson(res, 404, { ok: false, error: 'App Build Draft not found.' });
        return true;
      }
      const body = await readJson<{
        prompt?: string;
        expectedRevision?: number;
        proposalHash?: string;
        selectedBlockIds?: string[];
        pageId?: string;
        mode?: AppBuildProposalMode;
      }>(req);
      if (body.expectedRevision !== current.revision || body.proposalHash !== current.proposalHash) {
        sendJson(res, 409, { ok: false, error: 'APP_BUILD_REVISION_CONFLICT: refresh before asking AI to change this draft.' });
        return true;
      }
      const proposal = await proposeAppBuildDraftOperations(projectRoot, current, {
        prompt: cleanString(body.prompt) || current.frame.goal,
        selectedBlockIds: body.selectedBlockIds,
        pageId: body.pageId,
        mode: body.mode,
      }, { generateGovernedAnswer: ctx.generateGovernedAnswer, planAppBuild: ctx.planAppBuild, datasetsEnabled: ctx.datasetsEnabled, ...(ctx.readSavedQueryFields ? { readSavedQueryFields: ctx.readSavedQueryFields } : {}) });
      writeAppBuildDraftAiProposal(projectRoot, proposal);
      sendJson(res, 201, { ok: true, proposal });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const composeBuildMatch = path.match(/^\/api\/app-builds\/([^/]+)\/compose$/);
  if (composeBuildMatch && req.method === 'POST') {
    try {
      const id = decodeURIComponent(composeBuildMatch[1]);
      const current = loadStoredAppBuildDraft(projectRoot, id);
      if (!current) {
        sendJson(res, 404, { ok: false, error: 'App Build Draft not found.' });
        return true;
      }
      const body = await readJson<AppBuildComposeRequest>(req);
      if (body.expectedRevision !== current.revision || body.expectedProposalHash !== current.proposalHash) {
        sendJson(res, 409, { ok: false, error: 'APP_BUILD_REVISION_CONFLICT: refresh before composing this App.' });
        return true;
      }
      if (ctx.datasetsEnabled === false && body.mode === 'manual' && body.selections.some((selection) => selection.query !== undefined)) {
        sendJson(res, 409, {
          ok: false,
          error: 'APP_DATASETS_FEATURE_DISABLED: field-based Dataset tiles are turned off for this project (apps.datasets is false in dql.config.json). Remove it or set it to true before composing them.',
        });
        return true;
      }
      const result = await composeStoredAppBuildDraft(projectRoot, current, body, ctx.resolveDatasetSourceAuthority);
      sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, message.includes('APP_BUILD_') ? 409 : 400, { ok: false, error: message });
    }
    return true;
  }

  const reviseProposalMatch = path.match(/^\/api\/app-builds\/([^/]+)\/ai-proposals\/([^/]+)\/revisions$/);
  if (reviseProposalMatch && req.method === 'POST') {
    try {
      const id = decodeURIComponent(reviseProposalMatch[1]);
      const proposalId = decodeURIComponent(reviseProposalMatch[2]);
      const current = loadStoredAppBuildDraft(projectRoot, id);
      const previous = current ? loadAppBuildDraftAiProposal(projectRoot, id, proposalId) : null;
      if (!current || !previous) {
        sendJson(res, 404, { ok: false, error: 'App Build proposal not found.' });
        return true;
      }
      const body = await readJson<{
        expectedRevision?: number;
        expectedProposalHash?: string;
        answers?: Record<string, string>;
        selectedSourceIds?: string[];
        additionalSourceIds?: string[];
      }>(req);
      if (body.expectedRevision !== current.revision || body.expectedProposalHash !== current.proposalHash
        || previous.baseRevision !== current.revision || previous.baseProposalHash !== current.proposalHash) {
        sendJson(res, 409, { ok: false, error: 'APP_BUILD_PROPOSAL_CONFLICT: refresh before revising this proposal.' });
        return true;
      }
      const answers = body.answers ?? {};
      const answerText = previous.clarifications.flatMap((question) => {
        const answerId = answers[question.id];
        const choice = question.choices.find((candidate) => candidate.id === answerId);
        return choice ? [`${question.question}: ${choice.label}`] : [];
      });
      const selectedSourceIds = unique([
        ...(body.selectedSourceIds ?? previous.defaultSelectedSourceIds ?? []),
        ...(body.additionalSourceIds ?? []),
      ].map(cleanString).filter(Boolean));
      const proposal = await proposeAppBuildDraftOperations(projectRoot, current, {
        prompt: [previous.prompt || current.frame.goal, answerText.length ? `Clarification decisions: ${answerText.join('; ')}` : ''].filter(Boolean).join('\n'),
        selectedBlockIds: selectedSourceIds,
        // A revision answers the same request: same page, same add/replace choice.
        pageId: previous.targetPageId,
        mode: previous.mode ?? 'replace',
      }, { generateGovernedAnswer: ctx.generateGovernedAnswer, planAppBuild: ctx.planAppBuild, datasetsEnabled: ctx.datasetsEnabled, ...(ctx.readSavedQueryFields ? { readSavedQueryFields: ctx.readSavedQueryFields } : {}) });
      proposal.defaultSelectedSourceIds = selectedSourceIds.filter((sourceId) => proposal.operations.some((operation) => (
        operation.type === 'upsert_source' && operation.source.id === sourceId
      )));
      writeAppBuildDraftAiProposal(projectRoot, proposal);
      sendJson(res, 201, { ok: true, proposal });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  const generateGapMatch = path.match(/^\/api\/app-builds\/([^/]+)\/ai-proposals\/([^/]+)\/gaps$/);
  if (generateGapMatch && req.method === 'POST') {
    try {
      const id = decodeURIComponent(generateGapMatch[1]);
      const proposalId = decodeURIComponent(generateGapMatch[2]);
      const current = loadStoredAppBuildDraft(projectRoot, id);
      const previous = current ? loadAppBuildDraftAiProposal(projectRoot, id, proposalId) : null;
      if (!current || !previous) {
        sendJson(res, 404, { ok: false, error: 'App Build proposal not found.' });
        return true;
      }
      const body = await readJson<{ expectedRevision?: number; expectedProposalHash?: string; requirementId?: string; domain?: string; sourceRelation?: string }>(req);
      if (body.expectedRevision !== current.revision || body.expectedProposalHash !== current.proposalHash
        || previous.baseRevision !== current.revision || previous.baseProposalHash !== current.proposalHash) {
        sendJson(res, 409, { ok: false, error: 'APP_BUILD_PROPOSAL_CONFLICT: refresh before generating a gap.' });
        return true;
      }
      const requirementOperation = previous.operations.find((operation) => operation.type === 'set_requirements');
      const requirement = requirementOperation?.type === 'set_requirements'
        ? requirementOperation.requirements.find((candidate) => candidate.id === cleanString(body.requirementId))
        : undefined;
      const coverage = requirementOperation?.type === 'set_requirements'
        ? requirementOperation.coverage?.find((candidate) => candidate.requirementId === requirement?.id)
        : undefined;
      if (!requirement || coverage?.status === 'covered') {
        sendJson(res, 404, { ok: false, error: 'APP_BUILD_GAP_NOT_FOUND: choose an uncovered App requirement.' });
        return true;
      }
      if (!ctx.createDatasetGapProposal) {
        throw new Error('APP_BUILD_DATASET_GAP_UNAVAILABLE: this runtime cannot prepare a typed Dataset review draft.');
      }
      const sourceRelation = typeof body.sourceRelation === 'string' ? cleanString(body.sourceRelation) : undefined;
      const domain = typeof body.domain === 'string' ? cleanString(body.domain) : undefined;
      const contextProposal = await ctx.createDatasetGapProposal({
        appBuildId: current.id,
        requirement,
        ...(domain ? { domain } : {}),
        ...(sourceRelation ? { sourceRelation } : {}),
      });
      sendJson(res, 201, { ok: true, contextProposal, requirementId: requirement.id });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  buildMatch = path.match(/^\/api\/app-builds\/([^/]+)\/preflight$/);
  if (buildMatch && req.method === 'POST') {
    const current = loadStoredAppBuildDraft(projectRoot, decodeURIComponent(buildMatch[1]));
    if (!current) {
      sendJson(res, 404, { ok: false, error: 'App Build Draft not found.' });
      return true;
    }
    const body = await readJson<{ expectedRevision?: number; proposalHash?: string }>(req);
    if ((body.expectedRevision !== undefined && body.expectedRevision !== current.revision)
      || (body.proposalHash && body.proposalHash !== current.proposalHash)) {
      sendJson(res, 409, { ok: false, error: 'APP_BUILD_REVISION_CONFLICT: refresh before preflight.' });
      return true;
    }
    const errors = await preflightAppBuildRequestErrors(projectRoot, current, ctx.verifyAppBuildPreview, ctx.resolveDatasetSourceAuthority, ctx.figuresDependOnReader);
    if (errors.length) {
      sendJson(res, 400, {
        ok: false,
        code: 'APP_BUILD_NOT_READY',
        message: 'This App is not ready to publish yet.',
        draft: current,
        errors,
        details: { draft: current, errors },
      });
      return true;
    }
    // The request check above already judged tile trust against the current catalog.
    const next = markStoredAppBuildDraftPreflighted(projectRoot, current, { trust: false });
    sendJson(res, 200, { ok: true, draft: next, errors: [] });
    return true;
  }

  buildMatch = path.match(/^\/api\/app-builds\/([^/]+)\/(publish-to-project|commit)$/);
  if (buildMatch && req.method === 'POST') {
    try {
      const current = loadStoredAppBuildDraft(projectRoot, decodeURIComponent(buildMatch[1]));
      if (!current) {
        sendJson(res, 404, { ok: false, error: 'App Build Draft not found.' });
        return true;
      }
      const body = await readJson<{ expectedRevision?: number; proposalHash?: string }>(req);
      if (body.expectedRevision !== current.revision || body.proposalHash !== current.proposalHash) {
        sendJson(res, 409, { ok: false, error: 'APP_BUILD_REVISION_CONFLICT: refresh the Build Frame before committing.' });
        return true;
      }
      const errors = await preflightAppBuildRequestErrors(projectRoot, current, ctx.verifyAppBuildPreview, ctx.resolveDatasetSourceAuthority, ctx.figuresDependOnReader);
      if (errors.length) {
        sendJson(res, 400, {
          ok: false,
          code: 'APP_BUILD_NOT_READY',
          message: 'This App is not ready to publish yet.',
          draft: current,
          errors,
          details: { draft: current, errors },
        });
        return true;
      }
      // The final confirmation consumes the exact receipt the user reviewed.
      // Compatibility callers that arrive without one are preflighted once in
      // this same request so they cannot enter a client-side recheck loop.
      const prepared = hasCurrentAppBuildPreflightReceipt(current)
        ? current
        : markStoredAppBuildDraftPreflighted(projectRoot, current, { trust: false });
      // The App's trust is worked out against the current model's joins.
      const records = await resolveCurrentDatasetSourceRecords(projectRoot, datasetDraftSourceIds(prepared), ctx.resolveDatasetSourceAuthority).catch(() => new Map<string, AppSourceCatalogRecord>());
      const result = publishStoredAppBuildDraft(projectRoot, prepared, {
        descriptorFor: (sourceId) => records.get(sourceId)?.capabilities.dataset ?? undefined,
        recordFor: (sourceId) => records.get(sourceId),
      });
      await refreshGeneratedMetadata(projectRoot);
      sendJson(res, 201, { ...result, compatibilityRoute: buildMatch[2] === 'commit' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, message.includes('already exists') ? 409 : 400, { ok: false, error: message });
    }
    return true;
  }

  // With a host: published tiles that show an Ask answer's text with its author's figures, where those figures
  // depend on who is looking. Ids and titles only, for the stewards who replace them with live tiles.
  if (req.method === 'GET' && path === '/api/app-answer-tiles') {
    const depends = ctx.figuresDependOnReader;
    if (!depends) {
      sendJson(res, 200, { tiles: [] });
      return true;
    }
    const tiles: Array<{ appId: string; appName: string; pageId: string; pageTitle: string; tileId: string; title?: string; notice: string }> = [];
    for (const app of collectAppsList(projectRoot)) {
      if (ctx.mayViewApp && !(await ctx.mayViewApp(app.id).catch(() => false))) continue;
      const loaded = loadAppById(projectRoot, app.id);
      for (const page of loaded?.dashboards ?? []) {
        const dashboard = loadDashboardForApp(projectRoot, app.id, page.id)?.dashboard;
        if (!dashboard) continue;
        for (const tile of await staticAnswerTilesShownToOthers([{ id: dashboard.id, layout: dashboard.layout }], depends)) {
          tiles.push({ appId: app.id, appName: app.name, pageId: dashboard.id, pageTitle: dashboard.metadata.title, tileId: tile.tileId, ...(tile.title ? { title: tile.title } : {}), notice: STATIC_ANSWER_TILE_NOTICE });
        }
      }
    }
    sendJson(res, 200, { tiles });
    return true;
  }

  if (req.method === 'GET' && path === '/api/apps') {
    const all = collectAppsList(projectRoot);
    // App files that don't load, and why (an App with a bad policy would otherwise just disappear).
    const problems = ctx.mayViewApp ? [] : findAppDocuments(projectRoot).flatMap((file) => {
      const { document, errors } = loadAppDocument(file);
      return document ? [] : [{ path: relative(projectRoot, file), problems: errors.map((error) => error.message) }];
    });
    // A host's reader sees only the Apps they may open, not ones that refuse them on click.
    const may = ctx.mayViewApp;
    const apps = may ? (await Promise.all(all.map(async (app) => ((await may(app.id).catch(() => false)) ? app : null)))).filter((app): app is (typeof all)[number] => app !== null) : all;
    sendJson(res, 200, { apps, ...(problems.length ? { problems } : {}) });
    return true;
  }

  if (req.method === 'POST' && path === '/api/apps/recommend-blocks') {
    try {
      const body = await readJson<AppRecommendationRequest>(req);
      const { ensureAgentProjectReady, queryAppSourceCatalog } = await import('@zlens/agent');
      await ensureAgentProjectReady(projectRoot);
      const page = queryAppSourceCatalog(projectRoot, {
        query: [body.purpose, body.audience, ...(body.tags ?? [])].filter(Boolean).join(' '),
        domains: body.domain && body.domain !== 'general' ? [body.domain] : undefined,
        lifecycles: body.certifiedOnly ? ['certified'] : undefined,
        sourcePolicy: body.certifiedOnly ? 'governed_only' : 'include_review_required',
        limit: 50,
      });
      sendJson(res, 200, { blocks: page.items.map(appSourceCatalogRecordToLegacyRecommendation) });
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === 'POST' && path === '/api/apps/generate') {
    try {
      const body = await readJson<AppGenerateRequest>(req);
      const result = await generateAppPackage(projectRoot, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 201, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  if (req.method === 'POST' && path === '/api/apps/ai-builds') {
    try {
      const body = await readJson<AppGenerateRequest>(req);
      const result = await createAppAiBuildSession(projectRoot, body);
      if (result.status === 'error') {
        sendJson(res, 400, { ok: false, session: result, error: result.error });
        return true;
      }
      sendJson(res, 201, { ok: true, session: result });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  // Two-phase AI build: propose (plan + confirmable content list, no files) …
  if (req.method === 'POST' && path === '/api/apps/ai-builds/propose-background') {
    try {
      const body = await readJson<AppGenerateRequest>(req);
      if (!ctx.queueOperation) {
        sendJson(res, 501, { ok: false, error: 'Background App builds are unavailable in this runtime.' });
        return true;
      }
      const sessionId = appAiBuildSessionId(body.sessionId);
      const operation = ctx.queueOperation(
        {
          type: 'app_ai_build',
          scope: `app-build:${sessionId}`,
          resourceRevision: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
          message: body.existingAppId ? 'App page proposal queued.' : 'App proposal queued.',
          cancellable: true,
        },
        async (signal, report) => {
          report({ phase: 'planning', progress: 8, message: 'Planning the governed App proposal.' });
          if (signal.aborted) throw Object.assign(new Error('App build cancelled.'), { code: 'OPERATION_CANCELLED' });
          const session = await proposeAppAiBuild(projectRoot, { ...body, sessionId }, {
            generateGovernedAnswer: ctx.generateGovernedAnswer,
          });
          if (signal.aborted) throw Object.assign(new Error('App build cancelled.'), { code: 'OPERATION_CANCELLED' });
          if (session.status === 'error') throw Object.assign(new Error(session.error ?? 'App proposal failed.'), { code: 'APP_BUILD_FAILED' });
          report({ phase: 'review_ready', progress: 96, message: 'Build Brief ready for review.' });
          return { sessionId: session.id, status: session.status, appId: session.appId, dashboardId: session.dashboardId };
        },
      );
      sendJson(res, 202, { ok: true, operation, sessionId });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  if (req.method === 'POST' && path === '/api/apps/ai-builds/propose') {
    try {
      const body = await readJson<AppGenerateRequest>(req);
      const result = await proposeAppAiBuild(projectRoot, body, {
        generateGovernedAnswer: ctx.generateGovernedAnswer,
      });
      if (result.status === 'error') {
        sendJson(res, 400, { ok: false, session: result, error: result.error });
        return true;
      }
      sendJson(res, 201, { ok: true, session: result });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  // … then open it in App Studio (the author kept a selection → a local App
  // Studio draft that opens at the AI Data step; no App files are written).
  const openInStudioMatch = path.match(/^\/api\/apps\/ai-builds\/([^/]+)\/open-in-studio$/);
  if (openInStudioMatch && req.method === 'POST') {
    try {
      const body = await readJson<OpenAppAiBuildInStudioInput>(req);
      const result = await openAppAiBuildInStudio(projectRoot, decodeURIComponent(openInStudioMatch[1]), body, {
        datasetsEnabled: ctx.datasetsEnabled,
        ...(ctx.readSavedQueryFields ? { readSavedQueryFields: ctx.readSavedQueryFields } : {}),
      });
      if (!result.ok) {
        sendJson(res, result.status, { ok: false, error: result.error });
        return true;
      }
      sendJson(res, result.reused ? 200 : 201, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  let m = path.match(/^\/api\/apps\/ai-builds\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const session = getAppAiBuildSession(projectRoot, decodeURIComponent(m[1]));
    if (!session) {
      sendJson(res, 404, { ok: false, error: `AI build session "${decodeURIComponent(m[1])}" not found` });
      return true;
    }
    sendJson(res, 200, { ok: true, session });
    return true;
  }

  if (req.method === 'POST' && path === '/api/apps') {
    try {
      const body = await readJson<AppCreateRequest>(req);
      // Compatibility adapter: the legacy manual endpoint now traverses the
      // same versioned draft, preflight, and private commit service as Studio.
      const result = createAppPackageViaBuildDraft(projectRoot, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      await refreshGeneratedMetadata(projectRoot);
      sendJson(res, 201, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/ask$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<AppAskRequest>(req);
      const result = await askAppQuestion(ctx, appId, body);
      if (!result.ok) {
        sendJson(res, 400, result);
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/promote$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<AppPromoteRequest>(req);
      const result = promoteAppForStakeholders(projectRoot, appId, body);
      if (!result.ok) {
        sendJson(res, 400, result);
        return true;
      }
      await refreshGeneratedMetadata(projectRoot);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/publish-to-project$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<AppPromoteRequest>(req);
      const result = promoteAppForStakeholders(projectRoot, appId, body);
      if (!result.ok) {
        sendJson(res, 409, result);
        return true;
      }
      await refreshGeneratedMetadata(projectRoot);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards\/([^/]+)\/approve-semantic$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    const dashboardId = decodeURIComponent(m[2]);
    try {
      const body = await readJson<AppSemanticApprovalRequest>(req);
      const runId = cleanString(body.runId);
      const tileIds = unique((body.tileIds ?? []).map(cleanString).filter(Boolean));
      if (!runId || tileIds.length === 0 || !ctx.verifyDashboardRun) {
        sendJson(res, 400, { ok: false, error: 'A successful dashboard run and semantic tile selection are required.' });
        return true;
      }
      const verified = ctx.verifyDashboardRun({ runId, appId, dashboardId, tileIds });
      if (!verified.ok) {
        sendJson(res, 409, { ok: false, error: verified.error });
        return true;
      }
      const result = approveAppSemanticTiles(projectRoot, appId, dashboardId, {
        tileIds,
        runId,
        snapshotId: verified.snapshotId,
        expectedDashboardFingerprint: cleanString(body.expectedDashboardFingerprint),
        reviewer: hostActor() ?? (cleanString(body.reviewer) || 'local-reviewer'),
      });
      sendJson(res, result.ok ? 200 : 409, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/editor\/catalog$/);
  if (m && req.method === 'GET') {
    const appId = decodeURIComponent(m[1]);
    const app = loadAppById(projectRoot, appId)?.app;
    if (!app) {
      sendJson(res, 404, { error: `App "${appId}" not found` });
      return true;
    }
    const domain = ctx.url.searchParams.get('domain') ?? app.domain;
    const certifiedOnly = ctx.url.searchParams.get('certifiedOnly') !== 'false';
    const blocks = collectBlockCandidates(projectRoot)
      .filter((block) => !certifiedOnly || block.status === 'certified')
      .filter((block) => !domain || block.domain === domain || appAllowsExecute(app, block.domain))
      .sort((a, b) => {
        const aDomain = a.domain === app.domain ? 0 : 1;
        const bDomain = b.domain === app.domain ? 0 : 1;
        return aDomain - bDomain || a.name.localeCompare(b.name);
      });
    sendJson(res, 200, {
      appId,
      defaultDomain: app.domain,
      domains: unique(blocks.map((block) => block.domain)),
      blocks,
    });
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<{ id?: string; title?: string; description?: string }>(req);
      const result = createDashboardForApp(projectRoot, appId, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 201, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/notebook-candidates$/);
  if (m && req.method === 'GET') {
    const appId = decodeURIComponent(m[1]);
    const loaded = loadAppById(projectRoot, appId);
    if (!loaded) {
      sendJson(res, 404, { error: `App "${appId}" not found` });
      return true;
    }
    sendJson(res, 200, { notebooks: listNotebookCandidates(projectRoot, loaded.app, loaded.appDir) });
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/notebooks\/create$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<{ name?: string; title?: string; role?: string; visibility?: string; template?: string }>(req);
      const result = createNotebookForApp(projectRoot, appId, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 201, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/notebooks\/preview$/);
  if (m && req.method === 'GET') {
    const appId = decodeURIComponent(m[1]);
    const notebookPath = ctx.url.searchParams.get('path') ?? '';
    const result = previewNotebookForApp(projectRoot, appId, notebookPath);
    if (!result.ok) {
      sendJson(res, result.status, { error: result.error });
      return true;
    }
    sendJson(res, 200, result.preview);
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/notebooks\/run$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<{ path?: string }>(req);
      const notebookPath = cleanString(body.path);
      if (!notebookPath) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      if (!ctx.runNotebook) {
        sendJson(res, 400, { error: 'Notebook run is unavailable in this host.' });
        return true;
      }
      await ctx.runNotebook(appId, notebookPath);
      const preview = previewNotebookForApp(projectRoot, appId, notebookPath);
      if (!preview.ok) {
        sendJson(res, preview.status, { error: preview.error });
        return true;
      }
      sendJson(res, 200, { ok: true, preview: preview.preview });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/notebooks$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    try {
      const body = await readJson<{ path?: string; title?: string; role?: string; visibility?: string }>(req);
      const result = attachNotebookToApp(projectRoot, appId, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 200, loadAppById(projectRoot, appId) ?? result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/conversations$/);
  if (m) {
    const appId = decodeURIComponent(m[1]);
    if (!loadAppById(projectRoot, appId)) {
      sendJson(res, 404, { error: `App "${appId}" not found` });
      return true;
    }
    const storage = openAppStorage(projectRoot);
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, { conversations: storage.listAppConversations(appId) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson<{
          title?: string;
          dashboardId?: string;
          notebookPath?: string;
          context?: unknown;
          messages?: AppConversationMessageRequest[];
        }>(req);
        const conversation = storage.createAppConversation({
          appId,
          title: body.title,
          dashboardId: body.dashboardId,
          notebookPath: body.notebookPath,
          context: normalizeConversationContext(body.context),
          messages: normalizeConversationMessages(body.messages),
        });
        sendJson(res, 201, { ok: true, conversation });
        return true;
      }
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
      return true;
    } finally {
      storage.close();
    }
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/conversations\/([^/]+)$/);
  if (m) {
    const appId = decodeURIComponent(m[1]);
    const conversationId = decodeURIComponent(m[2]);
    const storage = openAppStorage(projectRoot);
    try {
      const conversation = storage.getAppConversation(conversationId);
      if (!conversation || conversation.appId !== appId) {
        sendJson(res, 404, { error: `Conversation "${conversationId}" not found` });
        return true;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { conversation });
        return true;
      }
      if (req.method === 'PATCH') {
        const body = await readJson<{
          title?: string;
          dashboardId?: string;
          notebookPath?: string;
          context?: unknown;
          messages?: AppConversationMessageRequest[];
        }>(req);
        const updated = storage.updateAppConversation(conversationId, {
          title: body.title,
          dashboardId: body.dashboardId,
          notebookPath: body.notebookPath,
          context: body.context === undefined ? undefined : normalizeConversationContext(body.context) ?? null,
          messages: body.messages ? normalizeConversationMessages(body.messages) : undefined,
        });
        sendJson(res, 200, { ok: true, conversation: updated });
        return true;
      }
      if (req.method === 'DELETE') {
        sendJson(res, 200, { ok: storage.deleteAppConversation(conversationId) });
        return true;
      }
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
      return true;
    } finally {
      storage.close();
    }
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/investigations$/);
  if (m) {
    const appId = decodeURIComponent(m[1]);
    if (!loadAppById(projectRoot, appId)) {
      sendJson(res, 404, { error: `App "${appId}" not found` });
      return true;
    }
    const storage = openAppStorage(projectRoot);
    try {
      if (req.method === 'GET') {
        const dashboardId = ctx.url.searchParams.get('dashboardId') ?? undefined;
        const withheld = await memoFiguresWithheld(ctx);
        sendJson(res, 200, { investigations: dedupeAppInvestigationsForDisplay(storage.listAppInvestigations(appId, dashboardId)).map((item) => investigationForReader(item, withheld)) });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJson<AppInvestigationCreateRequest>(req);
        const question = cleanString(body.question);
        if (!question) {
          sendJson(res, 400, { error: 'question is required' });
          return true;
        }
        let investigation = createOrReuseAppInvestigation(storage, {
          appId,
          dashboardId: body.dashboardId,
          sourceTileId: body.sourceTileId ?? selectedContextString(body.context, 'tileId'),
          sourceBlockId: body.sourceBlockId ?? selectedContextString(body.context, 'blockId'),
          title: body.title,
          question,
          intent: normalizeInvestigationIntent(body.intent, question, body.context),
          context: body.context,
          generatedSql: body.generatedSql,
        });
        const withheld = await memoFiguresWithheld(ctx);
        if (body.run !== false && !withheld) {
          investigation = storage.updateAppInvestigation(investigation.id, {
            status: 'running',
            reviewStatus: 'needs_review',
            error: '',
          }) ?? investigation;
          scheduleAppInvestigationRun(ctx, appId, investigation.id, body);
        }
        sendJson(res, 201, { ok: true, investigation: investigationForReader(investigation, withheld) });
        return true;
      }
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    } finally {
      storage.close();
    }
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/investigations\/([^/]+)$/);
  if (m) {
    const appId = decodeURIComponent(m[1]);
    const investigationId = decodeURIComponent(m[2]);
    const storage = openAppStorage(projectRoot);
    try {
      const investigation = storage.getAppInvestigation(investigationId);
      if (!investigation || investigation.appId !== appId) {
        sendJson(res, 404, { error: `Investigation "${investigationId}" not found` });
        return true;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, { investigation: investigationForReader(investigation, await memoFiguresWithheld(ctx)) });
        return true;
      }
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    } finally {
      storage.close();
    }
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/investigations\/([^/]+)\/run$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    const investigationId = decodeURIComponent(m[2]);
    const storage = openAppStorage(projectRoot);
    try {
      const investigation = storage.getAppInvestigation(investigationId);
      if (!investigation || investigation.appId !== appId) {
        sendJson(res, 404, { error: `Investigation "${investigationId}" not found` });
        return true;
      }
      const body = await readJson<AppInvestigationRunRequest>(req);
      // HH-14: a memo whose figures would be withheld from this person is not run for them.
      const withheld = await memoFiguresWithheld(ctx);
      const updated = withheld ? investigation : await runAppInvestigation(ctx, storage, investigation, body);
      sendJson(res, 200, { ok: true, investigation: investigationForReader(updated, withheld) });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      storage.close();
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/investigations\/([^/]+)\/pin$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    const investigationId = decodeURIComponent(m[2]);
    const storage = openAppStorage(projectRoot);
    try {
      const investigation = storage.getAppInvestigation(investigationId);
      if (!investigation || investigation.appId !== appId) {
        sendJson(res, 404, { error: `Investigation "${investigationId}" not found` });
        return true;
      }
      const body = await readJson<AppInvestigationPinRequest>(req);
      const appInfo = loadAppById(projectRoot, appId);
      const dashboardId = cleanString(body.dashboardId) || investigation.dashboardId || appInfo?.dashboards[0]?.id;
      if (!dashboardId) {
        sendJson(res, 400, { error: 'No dashboard is available for this investigation.' });
        return true;
      }
      const created = createAiPinTile(projectRoot, appId, {
        dashboardId,
        title: cleanString(body.title) || investigation.title,
        answer: investigationNarrativeAnswer(investigation),
        question: investigation.question,
        sql: investigation.generatedSql,
        sourceTier: 'metadata_research',
        certification: 'ai_generated',
        reviewStatus: 'needs_review',
        refreshCadence: body.refreshCadence === 'daily' ? 'daily' : 'none',
        chartConfig: { chart: 'table' },
        result: investigationPreviewResult(investigation),
        citations: investigationCitations(investigation),
        analysisPlan: {
          intent: investigation.intent,
          reviewRequired: true,
          uncertified: true,
          sourceTileId: investigation.sourceTileId,
          sourceBlockId: investigation.sourceBlockId,
        },
        evidence: investigation.evidence,
        followUps: nextResearchFollowUps(investigation),
      });
      if (!created.ok) {
        sendJson(res, 400, { error: created.error });
        return true;
      }
      const pinId = typeof created.pin === 'object' && created.pin && 'id' in created.pin ? String((created.pin as { id: unknown }).id) : '';
      const updated = pinId ? storage.markAppInvestigationPinned(investigationId, pinId) : investigation;
      // HH-14: the new pin and its memo as this person may read them.
      const withheld = await memoFiguresWithheld(ctx);
      sendJson(res, 200, { ...created, ...(created.pin ? { pin: pinForReader(created.pin as LocalAiPin, withheld) } : {}), investigation: updated ? investigationForReader(updated, withheld) : updated });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      storage.close();
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/ai-pins$/);
  if (m) {
    const appId = decodeURIComponent(m[1]);
    if (req.method === 'GET') {
      const dashboardId = ctx.url.searchParams.get('dashboardId') ?? undefined;
      const storage = openAppStorage(projectRoot);
      try {
        const withheld = await memoFiguresWithheld(ctx);
        sendJson(res, 200, { pins: storage.listAiPins(appId, dashboardId).map((pin) => pinForReader(pin, withheld)) });
      } finally {
        storage.close();
      }
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = await readJson<AiPinCreateRequest>(req);
        const created = createAiPinTile(projectRoot, appId, body);
        if (!created.ok) {
          sendJson(res, 400, { error: created.error });
          return true;
        }
        // With a host, a pin is its pinner's own, not the App's; HH-14 decides what of it the pinner reads.
        const withheld = await memoFiguresWithheld(ctx);
        const shown = withheld && created.pin ? { ...created, pin: pinForReader(created.pin as LocalAiPin, true) } : created;
        sendJson(res, 201, currentRecordOwner() !== undefined ? { ...shown, notice: AI_PIN_ONLY_YOU } : shown);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return true;
    }
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/ai-pins\/([^/]+)\/refresh$/);
  if (m && req.method === 'POST') {
    const pinId = decodeURIComponent(m[2]);
    const storage = openAppStorage(projectRoot);
    try {
      const pin = storage.getAiPin(pinId);
      if (!pin || pin.appId !== decodeURIComponent(m[1])) {
        sendJson(res, 404, { error: `AI pin "${pinId}" not found` });
        return true;
      }
      if (!pin.sql) {
        const updated = storage.updateAiPinResult(pinId, pin.result, 'Pin has no SQL to refresh.');
        sendJson(res, 400, { error: 'Pin has no SQL to refresh.', pin: updated });
        return true;
      }
      if (!ctx.executeSql) {
        const updated = storage.updateAiPinResult(pinId, pin.result, 'This host cannot execute AI pin SQL.');
        sendJson(res, 400, { error: 'This host cannot execute AI pin SQL.', pin: updated });
        return true;
      }
      const result = await ctx.executeSql(pin.sql);
      const updated = storage.updateAiPinResult(pinId, result);
      // HH-14: a refreshed AI-written pin carries needs-review figures; the person reads it as they may.
      const withheld = await memoFiguresWithheld(ctx);
      sendJson(res, 200, { ok: true, pin: updated ? pinForReader(updated, withheld) : updated });
    } catch (err) {
      const pin = storage.updateAiPinResult(pinId, undefined, err instanceof Error ? err.message : String(err));
      const withheld = await memoFiguresWithheld(ctx).catch(() => true);
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err), pin: pin ? pinForReader(pin, withheld) : pin });
    } finally {
      storage.close();
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/ai-pins\/([^/]+)\/promote$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    const pinId = decodeURIComponent(m[2]);
    try {
      const result = promoteAiPinToDraftBlock(projectRoot, appId, pinId);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards\/([^/]+)\/layout$/);
  if (m && req.method === 'PATCH') {
    const appId = decodeURIComponent(m[1]);
    const dashboardId = decodeURIComponent(m[2]);
    try {
      const body = await readJson<{ layout?: DashboardDocument['layout']; items?: DashboardGridItem[] }>(req);
      const refusal = await addedStaticAnswerTilesRefusal(projectRoot, appId, dashboardId, body, ctx.figuresDependOnReader);
      if (refusal) {
        sendJson(res, 409, refusal);
        return true;
      }
      const result = patchDashboardLayout(projectRoot, appId, dashboardId, body);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return true;
  }

  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards\/([^/]+)\/tiles\/recommend$/);
  if (m && req.method === 'POST') {
    const appId = decodeURIComponent(m[1]);
    const dashboardId = decodeURIComponent(m[2]);
    try {
      const body = await readJson<DashboardTileRecommendationRequest>(req);
      const result = recommendDashboardTile(projectRoot, appId, dashboardId, body);
      if (!result.ok) {
        sendJson(res, 400, result);
        return true;
      }
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  // /api/apps/:id  — single App with dashboards summary
  m = path.match(/^\/api\/apps\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    const id = decodeURIComponent(m[1]);
    try {
      const body = await readJson<{ expectedFingerprint?: string }>(req);
      const result = deleteAppPackage(projectRoot, id, body);
      if (!result.ok) {
        sendJson(res, result.status, { ok: false, error: result.error });
        return true;
      }
      ctx.scheduleProjectRefresh?.('app-deleted');
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  if (m && req.method === 'PATCH') {
    const id = decodeURIComponent(m[1]);
    try {
      const body = await readJson<{ name?: string; pageTitle?: string; dashboardId?: string; expectedFingerprint?: string }>(req);
      const result = renameApp(projectRoot, id, body);
      if (!result.ok) {
        sendJson(res, result.code === 'APP_NOT_FOUND' ? 404 : result.code === 'APP_CHANGED' ? 409 : 400, result);
        return true;
      }
      ctx.scheduleProjectRefresh?.('app-renamed');
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  if (m && req.method === 'GET') {
    const id = decodeURIComponent(m[1]);
    const result = loadAppById(projectRoot, id);
    if (!result) {
      sendJson(res, 404, { error: `App "${id}" not found` });
      return true;
    }
    const withheld = await memoFiguresWithheld(ctx);
    sendJson(res, 200, withheld ? { ...result, investigations: (result.investigations as LocalAppInvestigation[]).map((item) => investigationForReader(item, true)), aiPins: (result.aiPins as LocalAiPin[]).map((pin) => pinForReader(pin, true)) } : result);
    return true;
  }

  m = path.match(/^\/api\/app-recoveries\/([^/]+)\/restore$/);
  if (m && req.method === 'POST') {
    try {
      const result = restoreAppRecovery(projectRoot, decodeURIComponent(m[1]));
      if (!result.ok) {
        sendJson(res, result.status, result);
        return true;
      }
      ctx.scheduleProjectRefresh?.('app-restored');
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
    return true;
  }

  // /api/apps/:id/dashboards
  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards$/);
  if (m && req.method === 'GET') {
    const id = m[1];
    const dashboards = listDashboardsFor(projectRoot, id);
    if (dashboards === null) {
      sendJson(res, 404, { error: `App "${id}" not found` });
      return true;
    }
    sendJson(res, 200, { dashboards });
    return true;
  }

  // /api/apps/:id/dashboards/:did
  m = path.match(/^\/api\/apps\/([^/]+)\/dashboards\/([^/]+)$/);
  if (m) {
    const id = m[1];
    const did = m[2];
    if (req.method === 'GET') {
      const result = loadDashboardForApp(projectRoot, id, did);
      if (!result) {
        sendJson(res, 404, { error: `Dashboard "${did}" not found in app "${id}"` });
        return true;
      }
      const dashboard = await pageForReader(result.dashboard, ctx.figuresDependOnReader, ctx.mayKeepAnswerText ? () => ctx.mayKeepAnswerText!(decodeURIComponent(id)) : undefined);
      sendJson(res, 200, dashboard === result.dashboard ? result : { ...result, dashboard });
      return true;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        const body = await readJson(req);
        const refusal = await addedStaticAnswerTilesRefusal(projectRoot, id, did, body, ctx.figuresDependOnReader);
        if (refusal) {
          sendJson(res, 409, refusal);
          return true;
        }
        const written = await writeDashboard(projectRoot, id, did, body);
        if (!written.ok) {
          sendJson(res, 400, { error: written.error });
          return true;
        }
        sendJson(res, 200, { ok: true, path: written.path });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return true;
    }
  }

  // ── Persona ────────────────────────────────────────────────────────────

  if (path === '/api/persona') {
    if (req.method === 'GET') {
      sendJson(res, 200, { persona: defaultPersonaRegistry.active });
      return true;
    }
    if (req.method === 'DELETE') {
      defaultPersonaRegistry.clear();
      sendJson(res, 200, { persona: null });
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = await readJson(req);
        const userId = typeof body.userId === 'string' ? body.userId : null;
        const appId = typeof body.appId === 'string' ? body.appId : null;
        if (!userId) {
          sendJson(res, 400, { error: 'userId is required' });
          return true;
        }
        const persona = activatePersona(projectRoot, userId, appId);
        if (!persona) {
          sendJson(res, 404, { error: 'No App member matches this userId' });
          return true;
        }
        sendJson(res, 200, { persona });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return true;
    }
  }

  return false;
}

// ---- Helpers ----

type AppListEntry = {
  id: string;
  name: string;
  fingerprint: string;
  filePath: string;
  domain: string;
  ownerDomain?: string;
  usesDomains: string[];
  purpose?: string;
  requiredExports: string[];
  classification?: string;
  subdomain?: string;
  groups: string[];
  description?: string;
  audience?: string;
  lifecycle: NonNullable<AppDocument['lifecycle']>;
  certification: 'certified' | 'uncertified';
  /** Who published the App as certified, and when (D5). */
  certifiedBy?: string;
  certifiedAt?: string;
  /** How many data tiles were certified at publish (B6): the card never says "App certified" over them. */
  tileTrust?: { certified: number; total: number };
  /** When the App's document or pages last changed. */
  updatedAt?: string;
  status?: 'ready' | 'empty' | 'review';
  storage: 'shared' | 'mine' | 'template';
  visibility: NonNullable<AppDocument['visibility']>;
  publicationIntent: NonNullable<AppDocument['publicationIntent']>;
  owners: string[];
  tags: string[];
  members: number;
  roles: number;
  policies: number;
  schedules: number;
  dashboards: Array<{ id: string; title: string }>;
  notebooks: Array<{ path: string; title?: string; role: 'source' | 'analysis' | 'supporting'; visibility: NonNullable<AppDocument['visibility']> }>;
  drafts: Array<{ path: string; name: string; reviewStatus?: string }>;
  aiPins: number;
  investigations: number;
  homepage?: AppDocument['homepage'];
};

/**
 * Catalog items with who certified each certified block and when (D5), read
 * from its receipt, so the Data list says "Certified by <name> · <date>".
 */
function withCertificationBylines<Item extends { trust?: string; kind?: string; sourcePath?: string; owner?: string | null; check?: { by: string; name?: string; at: string; checks?: string[] } }>(
  projectRoot: string,
  items: Item[],
): Array<Item & { certification?: CertificationByline; ownerName?: string }> {
  const person = thisPerson(projectRoot);
  return items.map((item) => {
    // The owner as one person reads everywhere ("DuckCode AI Labs", not their noreply email).
    const ownerName = personDisplayName(item.owner, person);
    let named = ownerName && ownerName !== item.owner ? { ...item, ownerName } : item;
    // "Checked by you · 22 Oct" for data ZLens checked that nobody certified yet (design Q1).
    if (item.check) named = { ...named, check: bylineForViewer(item.check, person) };
    if (item.kind === 'semantic' || !item.sourcePath) return named;
    if (item.trust !== 'certified') {
      // Certified once, changed since (T4): keep who certified it and when,
      // so the Data list says "Changed since it was certified on 22 Oct".
      const previous = blockPreviousCertificationByline(projectRoot, item.sourcePath);
      return previous ? { ...named, certification: previous } : named;
    }
    const certification = blockCertificationByline(projectRoot, item.sourcePath);
    // "Certified by you" when the person reading certified it (design Q1).
    return certification ? { ...named, certification: bylineForViewer(certification, person) } : named;
  });
}

/**
 * The person using ZLens here, for showing names: the host's signed-in
 * person, else git user.name with every local spelling of their identity.
 * Read once a minute (git is asked at most that often).
 */
const localPersonCache = new Map<string, { at: number; person: { name?: string; aliases: ReadonlySet<string>; self: ReadonlySet<string> } }>();
export function thisPerson(projectRoot: string): { name?: string; aliases: ReadonlySet<string>; self: ReadonlySet<string> } {
  const actor = hostActor();
  if (actor) {
    const own = new Set([actor.toLowerCase()]);
    return { name: hostActorDisplayName() ?? actor, aliases: own, self: own };
  }
  const cached = localPersonCache.get(projectRoot);
  if (cached && Date.now() - cached.at < 60_000) return cached.person;
  // `aliases` name this person by one display name; only `self` (their own
  // git email and $USER@local) makes a certification "by you" (B6).
  const person = { name: gitUserName(projectRoot), aliases: localPersonAliases(projectRoot), self: localPersonSelf(projectRoot) };
  localPersonCache.set(projectRoot, { at: Date.now(), person });
  return person;
}

/** An identity as a person reads it: this machine's person by their display name, anyone else as recorded. */
export function appOwnerDisplayName(projectRoot: string, identity: string | null | undefined): string | undefined {
  return personDisplayName(identity, thisPerson(projectRoot));
}

/**
 * The name recorded when an App is published as certified: the host's
 * signed-in person, else git `user.name`, else the publishing owner.
 */
function appCertifierName(projectRoot: string, owner: string): string {
  return (hostActor() ? hostActorDisplayName() ?? hostActor() : gitUserName(projectRoot)) ?? owner;
}

/** When an App's files last changed: its document and its pages. */
function appUpdatedAt(appDir: string, dashboardPaths: string[]): string | undefined {
  let latest = 0;
  for (const path of [join(appDir, 'dql.app.json'), ...dashboardPaths]) {
    try {
      latest = Math.max(latest, statSync(path).mtimeMs);
    } catch {
      // A file that vanished mid-listing just doesn't count.
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : undefined;
}

function collectAppsList(projectRoot: string): AppListEntry[] {
  const out: AppListEntry[] = [];
  for (const p of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(p);
    if (!document) continue;
    const appDir = p.slice(0, -'/dql.app.json'.length);
    const dashboards: Array<{ id: string; title: string }> = [];
    const dashboardPaths = findDashboardsForApp(appDir);
    for (const d of dashboardPaths) {
      const { document: dd } = loadDashboardDocument(d);
      if (dd) dashboards.push({ id: dd.id, title: dd.metadata.title });
    }
    const updatedAt = appUpdatedAt(appDir, dashboardPaths);
    out.push({
      id: document.id,
      name: document.name,
      fingerprint: fingerprintAppDirectory(appDir),
      filePath: relative(projectRoot, appDir),
      domain: document.domain,
      ownerDomain: document.ownerDomain,
      usesDomains: document.usesDomains,
      purpose: document.purpose,
      requiredExports: document.requiredExports,
      classification: document.classification,
      subdomain: document.subdomain,
      groups: document.groups ?? [],
      description: document.description,
      audience: document.audience ?? audienceFromTags(document.tags ?? []),
      lifecycle: document.lifecycle ?? 'draft',
      certification: document.lifecycle === 'certified' ? 'certified' : 'uncertified',
      ...(document.certifiedBy ? { certifiedBy: document.certifiedBy } : {}),
      ...(document.certifiedAt ? { certifiedAt: document.certifiedAt } : {}),
      ...(document.tileTrust ? { tileTrust: document.tileTrust } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      status: document.lifecycle === 'review' ? 'review' : dashboards.length > 0 ? 'ready' : 'empty',
      storage: document.visibility === 'private' ? 'mine' : document.visibility === 'template' ? 'template' : 'shared',
      visibility: document.visibility ?? 'shared',
      publicationIntent: document.publicationIntent ?? (document.visibility === 'private' ? 'personal' : 'shared_project'),
      owners: document.owners,
      ...(() => { const ownerName = appOwnerDisplayName(projectRoot, document.owners[0]); return ownerName && ownerName !== document.owners[0] ? { ownerName } : {}; })(),
      tags: document.tags ?? [],
      members: document.members.length,
      roles: document.roles.length,
      policies: document.policies.length,
      schedules: (document.schedules ?? []).length,
      dashboards,
      notebooks: listAppNotebookRefs(projectRoot, document, appDir),
      drafts: listAppDrafts(projectRoot, appDir),
      aiPins: countAiPins(projectRoot, document.id),
      investigations: countAppInvestigations(projectRoot, document.id),
      homepage: document.homepage,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

interface AppRecommendationRequest {
  domain?: string;
  tags?: string[];
  purpose?: string;
  audience?: string;
  certifiedOnly?: boolean;
}

interface VisualizationRecommendationRequest {
  blockRef?: string;
  resultSchema?: unknown;
  rowSample?: Array<Record<string, unknown>>;
  rows?: Array<Record<string, unknown>>;
  appAudience?: string;
  audience?: string;
  prompt?: string;
  filters?: unknown;
  allowedVisualizations?: string[];
  component?: DashboardDisplayMetadata['component'];
  defaultVisualization?: string;
}

interface AppCreateRequest {
  name?: string;
  domain?: string;
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
  lifecycle?: AppDocument['lifecycle'];
  tags?: string[];
  owners?: string[];
  selectedBlockIds?: string[];
}

interface AppGenerateRequest {
  /** Client-generated durable identity used to resume a background proposal. */
  sessionId?: string;
  prompt?: string;
  domain?: string;
  owner?: string;
  force?: boolean;
  selectedBlockIds?: string[];
  plannerMode?: 'deterministic' | 'ai_assisted';
  audience?: string;
  notebookPath?: string;
  existingAppId?: string;
  mode?: 'personal' | 'stakeholder';
  /** Explicit opt-in to analyze uncovered questions as app-scoped review drafts. */
  exploreGaps?: boolean;
  /** Gap-fill budget: how many uncovered questions may get generated SQL (default 3, hard cap 5). */
  maxGeneratedTiles?: number;
}

interface AppAiBuildSession {
  id: string;
  /** 'proposed' = plan + proposal saved, NO app files written yet (awaiting confirm). */
  status: 'building' | 'proposed' | 'ready' | 'error';
  createdAt: string;
  updatedAt: string;
  prompt: string;
  appId?: string;
  dashboardId?: string | null;
  generatedPaths: string[];
  plan?: unknown;
  validation?: unknown;
  /** The reviewable content list shown to the user before commit. */
  proposal?: AppBuildProposal;
  snapshotId?: string;
  /** Existing-App builds also bind to the exact App package reviewed at propose time. */
  existingAppFingerprint?: string;
  proposalHash?: string;
  /** Tile ids the user confirmed at commit time (audit trail). */
  committedTileIds?: string[];
  /** The App Studio draft this proposal was opened as (Ask builds open in App Studio). */
  studioDraftId?: string;
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

/** One confirmable entry in the pre-create proposal list. */
export interface AppBuildProposalTile {
  id: string;
  source: 'certified_block' | 'semantic_query' | 'ai_generated';
  title: string;
  description?: string;
  /** Certified tiles reference an existing block. */
  blockId?: string;
  /** Governed semantic candidates carry canonical semantic intent, never raw SQL. */
  question?: string;
  semantic?: DashboardGridItem['semantic'];
  /** Legacy proposal fields remain readable; v2 planning never creates them. */
  sql?: string;
  answer?: string;
  viz: string;
  allowedVisualizations?: string[];
  certification: 'certified' | 'reviewed_semantic' | 'ai_generated';
  sourceClass: 'certified_block' | 'governed_semantic' | 'exploratory_analysis';
  reviewStatus: 'not_required' | 'required' | 'approved';
  requirementIds?: string[];
  sourceEvidence?: DashboardGridItem['sourceEvidence'];
  preflight: {
    status: 'passed' | 'review_required' | 'blocked';
    snapshotId?: string;
    sourceFingerprint?: string;
    receiptId?: string;
    message: string;
  };
  /** Bounded preview rows from executing the generated SQL (Phase 2). */
  preview?: { columns: string[]; rows: Array<Record<string, unknown>>; rowCount?: number };
  /** Immutable evidence from the shared one-attempt Ask/Notebook repair boundary. */
  repair?: AppExecutionRepairTrace;
  /** Generation failed — listed for transparency, not selectable. */
  error?: string;
  selectedByDefault: boolean;
  followUps?: string[];
}

/** Questions the plan could not cover; Phase 2 upgrades these into generated tiles. */
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

interface AppAskRequest {
  question?: string;
  dashboardId?: string;
  tileId?: string;
  blockId?: string;
  variables?: Record<string, unknown>;
  context?: unknown;
  runInvestigation?: boolean;
  /** Server-issued current dashboard run; required for Dataset chart grounding. */
  runId?: string;
}

interface AppAskDecision {
  mode: 'answer' | 'analysis' | 'app_change' | 'metadata';
  reason: string;
  nextAction: string;
  requiresContext: boolean;
  usesCertifiedResult: boolean;
  confidence: number;
}

interface AppPromoteRequest {
  lifecycle?: AppDocument['lifecycle'];
}

interface AppSemanticApprovalRequest {
  runId?: string;
  tileIds?: string[];
  expectedDashboardFingerprint?: string;
  reviewer?: string;
}

interface DashboardTileRecommendationRequest extends VisualizationRecommendationRequest {
  tileId?: string;
}

interface AiPinCreateRequest {
  dashboardId?: string;
  tileId?: string;
  title?: string;
  answer?: string;
  question?: string;
  sql?: string;
  sourceTier?: string;
  certification?: 'certified' | 'ai_generated';
  reviewStatus?: 'needs_review' | 'draft_created' | 'certified' | 'rejected';
  refreshCadence?: 'none' | 'daily';
  chartConfig?: Record<string, unknown>;
  result?: unknown;
  citations?: unknown[];
  analysisPlan?: unknown;
  evidence?: unknown;
  followUps?: string[];
}

interface AppConversationMessageRequest {
  id?: string;
  role?: 'user' | 'assistant';
  content?: string;
  events?: unknown[];
  createdAt?: string;
}

function normalizeConversationContext(value: unknown): LocalAppConversationContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    activeSurface: cleanString(record.activeSurface) || undefined,
    sourceCertifiedBlock: cleanString(record.sourceCertifiedBlock) || undefined,
    sourceQuestion: cleanString(record.sourceQuestion) || undefined,
    sourceAnswerSummary: cleanString(record.sourceAnswerSummary) || undefined,
    followupKind: record.followupKind === 'generic' || record.followupKind === 'drilldown' || record.followupKind === 'contextual'
      ? record.followupKind
      : undefined,
    requestedFilters: stringArray(record.requestedFilters),
    requestedDimensions: stringArray(record.requestedDimensions),
    outputColumns: stringArray(record.outputColumns),
    trustLabel: cleanString(record.trustLabel) || undefined,
    reviewStatus: cleanString(record.reviewStatus) || undefined,
    certification: cleanString(record.certification) || undefined,
    route: cleanString(record.route) || undefined,
    contextPackId: cleanString(record.contextPackId) || undefined,
    draftBlockPath: cleanString(record.draftBlockPath) || undefined,
    selectedEvidence: Array.isArray(record.selectedEvidence) ? record.selectedEvidence.slice(0, 16) : undefined,
    updatedAt: cleanString(record.updatedAt) || undefined,
  };
}

interface AppInvestigationCreateRequest {
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  title?: string;
  question?: string;
  intent?: LocalAppInvestigationIntent;
  context?: unknown;
  generatedSql?: string;
  run?: boolean;
}

interface AppInvestigationRunRequest {
  question?: string;
  intent?: LocalAppInvestigationIntent;
  context?: unknown;
  generatedSql?: string;
  repairMode?: 'rebuild_from_certified';
}

interface AppInvestigationPinRequest {
  dashboardId?: string;
  title?: string;
  refreshCadence?: 'none' | 'daily';
}

interface AppInvestigationGenerationRequest {
  appId: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  title?: string;
  question: string;
  intent: LocalAppInvestigationIntent;
  context?: unknown;
  mode?: 'sql_and_memo' | 'memo_only';
  generatedSql?: string;
  metrics?: Record<string, unknown>;
  drivers?: Array<Record<string, unknown>>;
  resultPreviews?: unknown[];
  summaryHint?: string;
  recommendationHint?: string;
  sqlError?: string;
  sqlErrorKind?: SqlPreviewErrorKind;
  hasReportEvidence?: boolean;
}

interface AppInvestigationGenerationResult {
  sql?: string;
  answer?: string;
  result?: unknown;
  analysisPlan?: unknown;
  evidence?: unknown;
  citations?: unknown[];
  suggestedViz?: string;
  executionError?: string;
  providerUsed?: string;
}

interface BlockCandidate {
  id: string;
  name: string;
  domain: string;
  status: string;
  owner: string | null;
  tags: string[];
  path: string;
  fingerprint: string;
  lastModified: string;
  description: string;
  llmContext: string | null;
  /** Retired blocks: the replacement as written in source. */
  replacedBy?: string;
  chartType?: string;
  /** Stable App-filter ids declared by block filter/parameter bindings. */
  filterIds: string[];
  /** Declared governed result dimensions that may be linked as App filters. */
  dimensionIds: string[];
  score: number;
  reasons: string[];
}

export function recommendBlocks(projectRoot: string, input: AppRecommendationRequest): BlockCandidate[] {
  const domain = cleanString(input.domain).toLowerCase();
  const tags = normalizeTags(input.tags ?? []);
  const terms = appRecommendationTerms([input.purpose, input.audience, ...(input.tags ?? [])]);
  const certifiedOnly = input.certifiedOnly !== false;
  const hasCriteria = Boolean(domain || tags.length > 0 || terms.length > 0);

  return collectBlockCandidates(projectRoot)
    .map((block) => {
      let score = 0;
      let criteriaScore = 0;
      const reasons: string[] = [];
      if (domain && block.domain.toLowerCase() === domain) {
        score += 100;
        criteriaScore += 100;
        reasons.push('domain match');
      }
      if (certifiedOnly && block.status !== 'certified') return null;
      if (block.status === 'certified') {
        score += 30;
        reasons.push('certified');
      }
      const overlap = block.tags.filter((tag) => tags.includes(tag.toLowerCase()));
      if (overlap.length > 0) {
        score += overlap.length * 12;
        criteriaScore += overlap.length * 12;
        reasons.push(`tag match: ${overlap.join(', ')}`);
      }
      const haystack = [block.name, block.description, block.owner ?? '', block.llmContext ?? '', ...block.tags]
        .join(' ')
        .toLowerCase();
      const textHits = terms.filter((term) => term && haystack.includes(term));
      if (textHits.length > 0) {
        score += textHits.length * 6;
        criteriaScore += textHits.length * 6;
        reasons.push('context match');
      }
      if (!hasCriteria && block.status === 'certified') {
        criteriaScore += 1;
        reasons.push('generic prompt fallback');
      }
      if (score === 0 && !domain && tags.length === 0 && !certifiedOnly) score = 1;
      if (hasCriteria && criteriaScore === 0) return null;
      if (score === 0) return null;
      return { ...block, score, reasons };
    })
    .filter((block): block is BlockCandidate => Boolean(block))
    .sort((a, b) => b.score - a.score || new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime())
    .slice(0, 50);
}

function appRecommendationTerms(values: Array<unknown>): string[] {
  const stop = new Set([
    'a', 'an', 'and', 'app', 'apps', 'analytics', 'available', 'block', 'blocks', 'build', 'certified',
    'dashboard', 'dashboards', 'data', 'dql', 'from', 'for', 'governed', 'my', 'of', 'on', 'stakeholder',
    'stakeholders', 'table', 'tables', 'the', 'to', 'using', 'view', 'warehouse', 'with',
  ]);
  const terms = values
    .flatMap((value) => cleanString(value).toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? [])
    .filter((term) => !stop.has(term))
    .slice(0, 40);
  return unique(terms);
}

export function recommendVisualization(
  projectRoot: string,
  input: VisualizationRecommendationRequest,
): { ok: true; display: DashboardDisplayMetadata; evidence: Array<{ source: string; reason: string }>; warnings: string[] } | { ok: false; error: string } {
  const blockRef = cleanString(input.blockRef);
  const prompt = cleanString(input.prompt).toLowerCase();
  const audience = cleanString(input.appAudience) || cleanString(input.audience);
  const rows = Array.isArray(input.rowSample) ? input.rowSample : Array.isArray(input.rows) ? input.rows : [];
  const columns = extractRecommendationColumns(input.resultSchema, rows);
  const block = blockRef
    ? collectBlockCandidates(projectRoot).find((candidate) =>
        candidate.id === blockRef ||
        candidate.name === blockRef ||
        candidate.path === blockRef ||
        candidate.path.endsWith(`/${blockRef}`),
      )
    : undefined;
  const evidence: Array<{ source: string; reason: string }> = [];
  const warnings: string[] = [];
  if (block) {
    evidence.push({ source: block.path, reason: `Block hint: ${block.chartType ?? 'table'}; status: ${block.status}; domain: ${block.domain}` });
  } else if (blockRef) {
    warnings.push(`Block reference was not found locally: ${blockRef}`);
  }
  if (columns.length > 0) {
    evidence.push({ source: 'result_schema', reason: `${columns.length} result column(s) were inspected.` });
  } else {
    warnings.push('No result schema or row sample was provided, so recommendation used block metadata and prompt only.');
  }
  if (audience) {
    evidence.push({ source: 'audience', reason: `Audience: ${audience}` });
  }

  const requestedViz = cleanString(input.defaultVisualization);
  if (requestedViz && !isSupportedVizType(requestedViz)) {
    return { ok: false, error: `Unsupported visualization: ${requestedViz}` };
  }
  const requestedVisualization = requestedViz ? normalizeVizType(requestedViz) : undefined;
  // An explicit component is an authored product contract, so reject an invalid
  // pairing rather than silently changing it. A model/default visualization is a
  // preference: validate it against the returned rows before displaying it.
  if (input.component && requestedVisualization && !componentVizCompatible(input.component, requestedVisualization)) {
    return {
      ok: false,
      error: `${input.component} cannot use ${requestedVisualization}. Choose one of ${allowedVisualizationsForComponent(input.component, requestedVisualization).join(', ')}.`,
    };
  }
  const dataRecommendation = recommendVizType({ columns, rows, prompt, blockChartType: block?.chartType });
  const defaultVisualization = requestedVisualization && visualizationFitsResult(requestedVisualization, columns, rows)
    ? requestedVisualization
    : dataRecommendation;
  if (requestedVisualization && requestedVisualization !== defaultVisualization) {
    warnings.push(`Preferred visualization ${requestedVisualization} did not fit the returned result shape; using ${defaultVisualization} instead.`);
  }
  const component = input.component ?? componentForViz(defaultVisualization, prompt);
  if (!componentVizCompatible(component, defaultVisualization)) {
    return {
      ok: false,
      error: `${component} cannot use ${defaultVisualization}. Choose one of ${allowedVisualizationsForComponent(component, defaultVisualization).join(', ')}.`,
    };
  }
  const unsupportedAllowed = (input.allowedVisualizations ?? []).filter((value) => !isSupportedVizType(value));
  if (unsupportedAllowed.length > 0) {
    return { ok: false, error: `Unsupported allowed visualization(s): ${unsupportedAllowed.join(', ')}` };
  }
  const supportedAllowed = (input.allowedVisualizations ?? [])
    .map((value) => normalizeVizType(value))
    .filter((value, index, arr) => arr.indexOf(value) === index);
  if (supportedAllowed.length > 0 && !supportedAllowed.includes(defaultVisualization)) {
    return {
      ok: false,
      error: `Requested visualization ${defaultVisualization} is outside allowed visualizations: ${supportedAllowed.join(', ')}.`,
    };
  }
  const allowedVisualizations = supportedAllowed.length > 0
    ? supportedAllowed
    : allowedVisualizationsForComponent(component, defaultVisualization);
  const fieldHints = fieldHintsForColumns(columns, rows, prompt);
  const display: DashboardDisplayMetadata = {
    mode: block ? 'block_hint' : 'ai_generated',
    component,
    defaultVisualization,
    allowedVisualizations,
    ...(Object.keys(fieldHints).length > 0 ? { fieldHints } : {}),
    layoutIntent: layoutIntentForComponent(component),
    rationale: recommendationRationale(component, defaultVisualization, block, columns, prompt),
    trustState: block?.status === 'certified' ? 'certified' : 'review_required',
    reviewStatus: block?.status === 'certified' ? 'certified' : 'review_required',
  };
  return { ok: true, display, evidence, warnings };
}

export async function generateAppPackage(
  projectRoot: string,
  input: AppGenerateRequest,
): Promise<
  | {
      ok: true;
      plan: unknown;
      validation: unknown;
      generated: { paths: string[] };
      app: ReturnType<typeof collectAppsList>[number] | null;
      dashboardId: string | null;
    }
  | { ok: false; error: string }
> {
  const prompt = cleanString(input.prompt);
  if (!prompt) return { ok: false, error: 'prompt is required' };
  const selectedBlockIds = unique((input.selectedBlockIds ?? []).map(cleanString).filter(Boolean));

  const {
    KGStore,
    defaultKgPath,
    generateAppFromPlan,
    ensureMetadataCatalogFresh,
    planAppFromPrompt,
    reindexProject,
    validateAppPlan,
  } = await import('@zlens/agent');

  const kgPath = defaultKgPath(projectRoot);
  await reindexProject(projectRoot, { kgPath });
  const kg = new KGStore(kgPath);
  try {
    const plan = planAppFromPrompt({
      prompt,
      kg,
      domain: cleanString(input.domain) || undefined,
      audience: cleanString(input.audience) || undefined,
      owner: cleanString(input.owner) || undefined,
      preferredBlockIds: selectedBlockIds,
      plannerMode: input.plannerMode === 'ai_assisted' ? 'ai_assisted' : 'deterministic',
      mode: input.mode === 'personal' ? 'personal' : 'stakeholder',
    });
    const validation = validateAppPlan(plan, kg);
    const governedTiles = plan.pages.flatMap((page) => page.tiles)
      .filter((tile) => tile.kind === 'certified_block' || tile.kind === 'semantic_query').length;
    if (governedTiles === 0) {
      return {
        ok: false,
        error: appBuildBlockedMessage(validation, plan as unknown as Record<string, unknown>),
      };
    }
    const generated = generateAppFromPlan(projectRoot, plan, kg, {
      overwrite: Boolean(input.force),
    });
    await ensureMetadataCatalogFresh(projectRoot, { force: true });
    const app = collectAppsList(projectRoot).find((entry) => entry.id === plan.appId) ?? null;
    return {
      ok: true,
      plan,
      validation,
      generated: { paths: generated.paths },
      app,
      dashboardId: plan.pages[0]?.id ?? app?.dashboards[0]?.id ?? null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    kg.close();
  }
}

export async function createAppAiBuildSession(
  projectRoot: string,
  input: AppGenerateRequest,
): Promise<AppAiBuildSession> {
  const now = new Date().toISOString();
  const id = appAiBuildSessionId(input.sessionId);
  const selectedBlockIds = unique((input.selectedBlockIds ?? []).map(cleanString).filter(Boolean));
  const base: AppAiBuildSession = {
    id,
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    prompt: cleanString(input.prompt),
    generatedPaths: [],
    warnings: [],
    reviewTasks: [],
    inputs: {
      domain: cleanString(input.domain) || undefined,
      owner: cleanString(input.owner) || undefined,
      audience: cleanString(input.audience) || undefined,
      notebookPath: cleanString(input.notebookPath) || undefined,
      existingAppId: cleanString(input.existingAppId) || undefined,
      mode: input.mode === 'personal' ? 'personal' : 'stakeholder',
      exploreGaps: input.mode === 'personal' && input.exploreGaps === true,
      selectedBlockIds,
    },
  };
  if (!base.prompt) {
    const session = { ...base, status: 'error' as const, error: 'prompt is required' };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  }

  const result = await generateAppPackage(projectRoot, {
    ...input,
    selectedBlockIds,
  });
  if (!result.ok) {
    const session = {
      ...base,
      status: 'error' as const,
      error: result.error,
      warnings: [result.error],
    };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  }

  const plan = result.plan as Record<string, unknown>;
  const session: AppAiBuildSession = {
    ...base,
    appId: typeof plan.appId === 'string' ? plan.appId : result.app?.id,
    dashboardId: result.dashboardId,
    generatedPaths: result.generated.paths,
    plan: result.plan,
    validation: result.validation,
    warnings: appBuildWarnings(result.validation, plan),
    reviewTasks: reviewTasksFromPlan(plan),
  };
  writeAppAiBuildSession(projectRoot, session);
  return session;
}

export function getAppAiBuildSession(projectRoot: string, id: string): AppAiBuildSession | null {
  const clean = cleanString(id);
  if (!clean || !/^[a-z0-9_:-]+$/i.test(clean)) return null;
  const path = join(appAiBuildSessionDir(projectRoot), `${clean}.json`);
  if (!existsSync(path)) return null;
  try {
    const session = JSON.parse(readFileSync(path, 'utf-8')) as AppAiBuildSession & { ownerId?: string };
    // With a host, a build session (its prompt, plan, preview rows and answer) is the person's who started it.
    return ownedBy(session.ownerId, currentRecordOwner()) ? session : null;
  } catch {
    return null;
  }
}

/** Derive the confirmable proposal list from a plan: certified tiles are selectable
 *  (default on); uncovered questions are listed as gaps (Phase 2 fills them with
 *  bounded AI-generated candidates). Narrative/placeholder tiles are structural and
 *  not part of the confirm list. */
function buildAppProposal(plan: AppPlan): AppBuildProposal {
  const tiles: AppBuildProposalTile[] = [];
  for (const page of plan.pages) {
    for (const tile of page.tiles) {
      if (tile.kind === 'certified_block') {
        tiles.push({
          id: tile.id,
          source: 'certified_block',
          title: tile.title,
          description: tile.description,
          blockId: tile.blockId,
          viz: tile.viz,
          allowedVisualizations: tile.display?.genUi.allowedVisualizations ?? [tile.viz, 'table'],
          certification: 'certified',
          sourceClass: 'certified_block',
          reviewStatus: 'not_required',
          requirementIds: tile.requirementIds,
          sourceEvidence: tile.sourceEvidence,
          preflight: {
            status: 'passed',
            snapshotId: plan.snapshotId,
            sourceFingerprint: tile.sourceNodeId,
            message: 'Certified source and requirement compatibility were validated against this project snapshot.',
          },
          selectedByDefault: true,
        });
      } else if (tile.kind === 'semantic_query' && tile.semantic) {
        tiles.push({
          id: tile.id,
          source: 'semantic_query',
          title: tile.title,
          description: tile.description ?? tile.rationale,
          question: tile.title,
          semantic: tile.semantic,
          viz: tile.viz,
          allowedVisualizations: tile.display?.genUi.allowedVisualizations ?? [tile.viz, 'table'],
          certification: 'reviewed_semantic',
          sourceClass: 'governed_semantic',
          reviewStatus: 'required',
          requirementIds: tile.requirementIds,
          sourceEvidence: tile.sourceEvidence,
          preflight: {
            status: 'review_required',
            snapshotId: plan.snapshotId,
            sourceFingerprint: tile.semantic.definitionFingerprint,
            message: 'Semantic identities are resolved; run and review the result before shared publication.',
          },
          selectedByDefault: true,
        });
      }
    }
  }
  const gaps: AppBuildProposalGap[] = [];
  const seenGap = new Set<string>();
  for (const item of plan.requirementCoverage.filter((item) => item.status === 'gap')) {
    const requirement = plan.requirements.find((candidate) => candidate.id === item.requirementId);
    const question = requirement?.question ?? item.requirementId;
    if (seenGap.has(question.toLowerCase())) continue;
    seenGap.add(question.toLowerCase());
    gaps.push({ id: `gap_${item.requirementId}`, question, reason: item.reasons.join(' ') });
  }
  for (const report of plan.scopedReports) {
    const question = cleanString(report.question) || report.title;
    if (!question || seenGap.has(question.toLowerCase())) continue;
    seenGap.add(question.toLowerCase());
    gaps.push({ id: report.id, question, reason: report.description || 'No certified saved query covers this question.' });
  }
  for (const evidence of plan.missingEvidence) {
    const question = cleanString(evidence);
    if (!question || seenGap.has(question.toLowerCase())) continue;
    seenGap.add(question.toLowerCase());
    gaps.push({ id: `gap_${gaps.length + 1}`, question, reason: 'No certified saved query covers this question.' });
  }
  const metrics = Array.from(new Set(plan.requirements.flatMap((requirement) => requirement.measures)));
  const dimensions = Array.from(new Set(plan.requirements.flatMap((requirement) => requirement.dimensions)));
  const filters = Array.from(new Set(plan.requirements.flatMap((requirement) => requirement.filters)));
  const clarifications: AppBuildClarification[] = [];
  if (metrics.length === 0) {
    clarifications.push({
      id: 'metric',
      question: 'Which governed business metric should lead this App?',
      choices: ['Choose a certified saved query', 'Choose a semantic metric', 'Describe the calculation as review-required analysis'],
      required: true,
    });
  }
  if (tiles.length === 0 || gaps.length > 0) {
    clarifications.push({
      id: 'coverage',
      question: 'How should ZLens handle requirements without governed coverage?',
      choices: ['Refine metrics or dimensions', 'Use governed semantic coverage', 'Include review-required analysis', 'Keep visible gaps'],
      required: tiles.length === 0,
    });
  }
  if (!plan.prompt.match(/\b(day|week|month|quarter|year|today|yesterday|current|previous|over time)\b/i)) {
    clarifications.push({
      id: 'time',
      question: 'What time window and comparison should the App use?',
      choices: ['Current period vs previous period', 'Trailing 30 days', 'Year to date', 'No time comparison'],
      required: false,
    });
  }
  return {
    intent: {
      target: plan.publicationIntent,
      initialVisibility: 'private',
    },
    buildFrame: {
      goal: plan.businessGoal,
      audience: plan.audience,
      metrics,
      dimensions,
      grain: plan.requirements.find((requirement) => requirement.grain)?.grain,
      filters,
      desiredOutput: plan.planning.displayStrategy,
    },
    tiles,
    gaps,
    clarifications,
    followUps: gaps.map((gap) => gap.question).slice(0, 4),
    coverage: {
      certifiedTiles: tiles.filter((tile) => tile.certification === 'certified').length,
      semanticTiles: tiles.filter((tile) => tile.certification === 'reviewed_semantic').length,
      generatedTiles: tiles.filter((tile) => tile.certification === 'ai_generated').length,
      gaps: gaps.length,
    },
  };
}

/** Bounded preview rows stored in the session file (the UI shows fewer). */
const PROPOSAL_PREVIEW_ROW_CAP = 50;
const GENERATED_TILE_DEFAULT = 3;
const GENERATED_TILE_HARD_CAP = 5;

const GENERATED_VIZ_TYPES = new Set([
  'single_value', 'grouped_bar', 'stacked_bar', 'line', 'bar', 'area', 'pie', 'donut',
  'scatter', 'heatmap', 'histogram', 'waterfall', 'gauge', 'table', 'pivot', 'map', 'funnel', 'kpi',
]);

function normalizeGeneratedViz(viz: unknown): string {
  const clean = typeof viz === 'string' ? viz.trim().toLowerCase() : '';
  return GENERATED_VIZ_TYPES.has(clean) ? clean : 'table';
}

function titleForGapQuestion(question: string): string {
  const clean = question.trim().replace(/[?.!]+$/, '');
  const title = clean.charAt(0).toUpperCase() + clean.slice(1);
  return title.length > 72 ? `${title.slice(0, 69)}…` : title;
}

/** Normalize an executed agent result into the proposal's bounded preview shape.
 *  Columns may arrive as strings or {name} objects; rows as objects or arrays. */
function previewFromAgentResult(result: AgentResultPayload | undefined): AppBuildProposalTile['preview'] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return undefined;
  const columns = result.columns.map((column) => {
    if (typeof column === 'string') return column;
    const record = column as Record<string, unknown> | null;
    return typeof record?.name === 'string' ? record.name : String(column);
  });
  if (columns.length === 0) return undefined;
  const rows = result.rows.slice(0, PROPOSAL_PREVIEW_ROW_CAP).map((row) => {
    if (Array.isArray(row)) {
      const entry: Record<string, unknown> = {};
      columns.forEach((column, index) => { entry[column] = row[index]; });
      return entry;
    }
    return (row ?? {}) as Record<string, unknown>;
  });
  return { columns, rows, rowCount: typeof result.rowCount === 'number' ? result.rowCount : rows.length };
}

/**
 * Fill coverage gaps with bounded, review-required generated answers. Sequential
 * on purpose (provider rate limits); every failure is listed for transparency, not
 * thrown; and nothing here can certify — pass-through of a certified block match is
 * the only way a candidate keeps a 'certified' label.
 */
async function fillProposalGaps(
  proposal: AppBuildProposal,
  hooks: AppBuildHooks | undefined,
  maxGeneratedTiles: number | undefined,
): Promise<void> {
  if (!hooks?.generateGovernedAnswer || proposal.gaps.length === 0) return;
  const cap = Math.min(Math.max(1, maxGeneratedTiles ?? GENERATED_TILE_DEFAULT), GENERATED_TILE_HARD_CAP);
  const toFill = proposal.gaps.slice(0, cap);
  const remaining = proposal.gaps.slice(cap);
  let providerUnavailable = false;
  for (const gap of toFill) {
    if (providerUnavailable) {
      remaining.push(gap);
      continue;
    }
    try {
      const answer = await hooks.generateGovernedAnswer(gap.question);
      const sql = cleanString(answer.sql ?? answer.proposedSql ?? answer.result?.sql ?? '');
      if (!sql) {
        remaining.push(gap);
        continue;
      }
      const preview = previewFromAgentResult(answer.result);
      const repair = answer.appBuilderRepair;
      const unresolvedExecutionError = !preview
        ? cleanString(answer.executionError ?? answer.warehouseFailure?.redactedMessage ?? '')
        : '';
      // Gap-fill tiles are AI-generated by definition (they answer questions the
      // certified blocks did NOT cover). They are ALWAYS ai_generated / review-
      // required — never auto-certified, even if the governed loop happened to
      // touch a certified block. The AI never certifies its own output.
      proposal.tiles.push({
        id: `gen_${gap.id}`,
        source: 'ai_generated',
        title: titleForGapQuestion(gap.question),
        question: gap.question,
        sql,
        answer: cleanString(answer.answer ?? answer.text ?? '') || undefined,
        viz: normalizeGeneratedViz(answer.suggestedViz),
        certification: 'ai_generated',
        sourceClass: 'exploratory_analysis',
        reviewStatus: 'required',
        requirementIds: gap.id.startsWith('gap_') ? [gap.id.slice('gap_'.length)] : undefined,
        preflight: {
          status: preview ? 'passed' : unresolvedExecutionError ? 'blocked' : 'review_required',
          sourceFingerprint: `sha256:${createHash('sha256').update(sql).digest('hex')}`,
          receiptId: preview
            ? `preview:${createHash('sha256').update(JSON.stringify(preview)).digest('hex')}`
            : undefined,
          message: preview
            ? repair?.status === 'repaired'
              ? 'The shared bounded repair produced a successful preview; the query remains review-required.'
              : 'A bounded preview ran successfully; business review is still required.'
            : repair?.status === 'failed'
              ? repair.message
              : unresolvedExecutionError
                ? 'The generated query failed its bounded preview and could not be selected.'
                : 'SQL was generated but has no successful preview receipt yet.',
        },
        preview,
        ...(repair ? { repair } : {}),
        ...(unresolvedExecutionError ? { error: unresolvedExecutionError } : {}),
        selectedByDefault: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Offline degradation: without a configured provider, keep everything as
      // plain research gaps instead of listing one error tile per question.
      if (/no ai provider/i.test(message)) {
        providerUnavailable = true;
        remaining.push(gap);
        continue;
      }
      proposal.tiles.push({
        id: `gen_${gap.id}`,
        source: 'ai_generated',
        title: titleForGapQuestion(gap.question),
        question: gap.question,
        viz: 'table',
        certification: 'ai_generated',
        sourceClass: 'exploratory_analysis',
        reviewStatus: 'required',
        requirementIds: gap.id.startsWith('gap_') ? [gap.id.slice('gap_'.length)] : undefined,
        preflight: {
          status: 'blocked',
          message: 'Exploratory analysis generation failed.',
        },
        error: message,
        selectedByDefault: false,
      });
    }
  }
  proposal.gaps = remaining;
  proposal.followUps = remaining.map((gap) => gap.question).slice(0, 4);
  proposal.coverage = {
    certifiedTiles: proposal.tiles.filter((tile) => tile.certification === 'certified' && !tile.error).length,
    semanticTiles: proposal.tiles.filter((tile) => tile.certification === 'reviewed_semantic' && !tile.error).length,
    generatedTiles: proposal.tiles.filter((tile) => tile.certification === 'ai_generated' && !tile.error).length,
    gaps: remaining.length,
  };
}

/**
 * Phase 1 of the two-phase app build: plan + validate + build the confirmable
 * proposal, persist the session with status 'proposed'. Writes NO app files —
 * `openAppAiBuildInStudio` turns the confirmed selection into an App Studio draft.
 */
export async function proposeAppAiBuild(
  projectRoot: string,
  input: AppGenerateRequest,
  hooks?: AppBuildHooks,
): Promise<AppAiBuildSession> {
  const now = new Date().toISOString();
  const id = appAiBuildSessionId(input.sessionId);
  const selectedBlockIds = unique((input.selectedBlockIds ?? []).map(cleanString).filter(Boolean));
  const base: AppAiBuildSession = {
    id,
    status: 'building',
    createdAt: now,
    updatedAt: now,
    prompt: cleanString(input.prompt),
    generatedPaths: [],
    warnings: [],
    reviewTasks: [],
    inputs: {
      domain: cleanString(input.domain) || undefined,
      owner: cleanString(input.owner) || undefined,
      audience: cleanString(input.audience) || undefined,
      notebookPath: cleanString(input.notebookPath) || undefined,
      existingAppId: cleanString(input.existingAppId) || undefined,
      mode: input.mode === 'personal' ? 'personal' : 'stakeholder',
      exploreGaps: input.mode === 'personal' && input.exploreGaps === true,
      selectedBlockIds,
    },
  };
  if (!base.prompt) {
    const session = { ...base, status: 'error' as const, error: 'prompt is required' };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  }
  // Persist the durable identity before planning or provider work begins. The
  // browser can leave this page immediately and recover the same session later.
  writeAppAiBuildSession(projectRoot, base);
  const existingApp = base.inputs.existingAppId ? loadAppById(projectRoot, base.inputs.existingAppId) : null;
  if (base.inputs.existingAppId && !existingApp) {
    const session = { ...base, status: 'error' as const, error: `App "${base.inputs.existingAppId}" not found.` };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  }
  if (existingApp) {
    // Existing-App page generation inherits server-owned App context. The prompt
    // controls the new page, never the identity or governance boundary of the App.
    base.inputs.domain = existingApp.app.domain;
    base.inputs.audience = existingApp.app.audience;
    base.inputs.owner = existingApp.app.businessOwner ?? existingApp.app.owners[0];
    const publicationIntent = existingApp.app.publicationIntent
      ?? (existingApp.app.visibility === 'private' ? 'personal' : 'shared_project');
    base.inputs.mode = publicationIntent === 'personal' ? 'personal' : 'stakeholder';
    base.inputs.exploreGaps = base.inputs.mode === 'personal' && input.exploreGaps === true;
  }

  const {
    KGStore,
    defaultKgPath,
    planAppFromPrompt,
    reindexProject,
    validateAppPlan,
  } = await import('@zlens/agent');
  const kgPath = defaultKgPath(projectRoot);
  const index = await reindexProject(projectRoot, { kgPath });
  const kg = new KGStore(kgPath);
  try {
    const planned = planAppFromPrompt({
      prompt: base.prompt,
      kg,
      domain: base.inputs.domain,
      audience: base.inputs.audience,
      owner: base.inputs.owner,
      preferredBlockIds: selectedBlockIds,
      plannerMode: input.plannerMode === 'ai_assisted' ? 'ai_assisted' : 'deterministic',
      mode: base.inputs.mode === 'personal' ? 'personal' : 'stakeholder',
      snapshotId: index.kgFingerprint,
    });
    const firstPage = planned.pages[0];
    if (!firstPage) throw new Error('The App planner did not return a page.');
    const existingDashboardIds = new Set(existingApp?.dashboards.map((dashboard) => dashboard.id) ?? []);
    const pageId = existingApp
      ? uniqueAppPageId(slugify(firstPage.title) || 'page', existingDashboardIds)
      : firstPage.id;
    const plan: AppPlan = existingApp ? {
      ...planned,
      appId: existingApp.app.id,
      name: existingApp.app.name,
      domain: existingApp.app.domain,
      audience: existingApp.app.audience ?? planned.audience,
      owner: existingApp.app.businessOwner ?? existingApp.app.owners[0] ?? planned.owner,
      publicationIntent: existingApp.app.publicationIntent
        ?? (existingApp.app.visibility === 'private' ? 'personal' : 'shared_project'),
      pages: [{ ...firstPage, id: pageId }],
    } : planned;
    const validation = validateAppPlan(plan, kg);
    const proposal = buildAppProposal(plan);
    // Raw SQL exploration is opt-in, personal-only, preview-bounded, and remains
    // unselected until the user explicitly accepts it in the Build Brief.
    if (base.inputs.exploreGaps) {
      await fillProposalGaps(proposal, hooks, input.maxGeneratedTiles);
    }
    const existingAppFingerprint = existingApp ? fingerprintAppDirectory(existingApp.appDir) : undefined;
    const proposalHash = createHash('sha256')
      .update(JSON.stringify({ plan, proposal, existingAppFingerprint }))
      .digest('hex');
    const session: AppAiBuildSession = {
      ...base,
      status: 'proposed',
      appId: plan.appId,
      dashboardId: plan.pages[0]?.id ?? null,
      plan,
      validation,
      proposal,
      snapshotId: index.kgFingerprint,
      ...(existingAppFingerprint ? { existingAppFingerprint } : {}),
      proposalHash,
      warnings: appBuildWarnings(validation, plan as unknown as Record<string, unknown>),
      reviewTasks: reviewTasksFromPlan(plan as unknown as Record<string, unknown>),
    };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  } catch (err) {
    const session = {
      ...base,
      status: 'error' as const,
      error: err instanceof Error ? err.message : String(err),
    };
    writeAppAiBuildSession(projectRoot, session);
    return session;
  } finally {
    kg.close();
  }
}

export type AppBuildProposalMode = 'add' | 'replace';

export interface AppBuildDraftAiProposal {
  id: string;
  draftId: string;
  baseRevision: number;
  baseProposalHash: string;
  /**
   * Server-owned provenance for the dedicated initial App generator. This is
   * intentionally separate from universal App Autopilot AgentRun receipts.
   */
  plannerProvenance: AppBuilderPlannerProvenance;
  operations: AppBuildDraftOperation[];
  /**
   * `add` keeps the target page's tiles, title, sections and story and only
   * proposes new tiles; `replace` rebuilds the page from the plan. Stored
   * proposals written before this field existed behave as `replace`.
   */
  mode?: AppBuildProposalMode;
  /** The page the author asked about; the first planned page lands here. */
  targetPageId?: string;
  /** The author's request, reused when clarifications revise the proposal. */
  prompt?: string;
  /** Tiles this proposal adds. Only these can be deselected at compose. */
  proposedTileIds?: string[];
  /** Governed sources start selected; generated review DQL is always opt-in. */
  defaultSelectedSourceIds?: string[];
  /** Complete bounded candidate set used by the App-specific planning call. */
  candidateSourceIds?: string[];
  warnings?: string[];
  clarifications: Array<{
    id: string;
    question: string;
    choices: Array<{ id: string; label: string }>;
    required: boolean;
  }>;
  summary: {
    requirements: number;
    covered: number;
    gaps: number;
    certifiedSources: number;
    semanticSources: number;
  };
}

/**
 * A bounded, immutable App Autopilot change for one existing Dataset tile.
 *
 * The universal AgentRunEngine owns the conversation, provider transport,
 * lifecycle, and artifact delivery. This App-only object is the reviewed,
 * server-compiled mutation it carries. It is deliberately an
 * AppBuildDraft-operation list rather than SQL or a browser-supplied model
 * payload, so the same Dataset authority checks apply before every apply.
 */
export interface AppAutopilotChangeProposal {
  version: 1;
  id: string;
  /** Immutable link back to the universal AgentRun artifact allowed to apply it. */
  runId: string;
  artifactId: string;
  draftId: string;
  baseRevision: number;
  baseProposalHash: string;
  pageId: string;
  tileId: string;
  request: string;
  /** Server-normalized provider intent. It is data for the bounded compiler,
   * never a browser supplied AppBuildDraftOperation. */
  intent: AppAutopilotIntent;
  /** Server-issued source identity captured when this typed change was
   * previewed. Acceptance compares it with the live catalog; it never
   * upgrades a proposal to a newer Dataset contract on the user's behalf. */
  source: {
    sourceId: string;
    sourceRevision: string;
    contractFingerprint: string;
  };
  planningMode: 'universal_agent';
  operations: AppBuildDraftOperation[];
  diagnostics: Array<{ code: string; severity: 'info' | 'blocking'; message: string }>;
  createdAt: string;
  proposalHash: string;
  /** Set only after a successful local-draft write. Repeated Apply is idempotent. */
  appliedAt?: string;
  appliedRevision?: number;
}

/** The bounded App changes App Autopilot may prepare for human review. */
export type AppAutopilotAction =
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

/**
 * This is the narrow provider-to-compiler contract. Every optional identifier
 * is resolved against server-owned App/Dataset state before an operation is
 * emitted, so it cannot introduce raw SQL, a source, a join, or a lifecycle
 * claim.
 */
export interface AppAutopilotIntent {
  action: AppAutopilotAction;
  request: string;
  summary?: string;
  field?: string;
  measure?: string;
  visualization?: DashboardGridItem['viz']['type'];
  title?: string;
  /** Exact approved physical target field for an explicit cross-filter mapping. */
  targetField?: string;
  targetPageId?: string;
  targetTileId?: string;
  filterId?: string;
  scope?: 'page' | 'app';
}

export type AppBuildComposeRequest = {
  expectedRevision: number;
  expectedProposalHash: string;
} & (
  | {
    mode: 'ai';
    proposalId: string;
    selectedSourceIds: string[];
    /** Proposed tiles the author declined; existing tiles are never removed here. */
    rejectedTileIds?: string[];
  }
  | {
    mode: 'manual';
    enableReviewRequired?: boolean;
    selections: Array<{
      sourceId: string;
      pageId?: string;
      view: 'kpi' | 'chart' | 'table';
      /** A field-builder query. It is validated against the resolved Dataset
       * before the complete page revision is stored. */
      query?: TileQuery;
      /** Presentation-only title; source and query identities remain explicit. */
      title?: string;
    }>;
  }
);

function appDraftSourceFromCatalog(source: AppSourceCatalogRecord): AppBuildDraftSource {
  const certified = source.trust === 'certified';
  return {
    id: source.sourceId,
    kind: source.kind === 'semantic' ? 'governed_semantic' : 'block',
    sourceRef: source.executionRef,
    qualifiedIdentity: source.qualifiedIdentity,
    sourcePath: source.sourcePath,
    executionRef: source.executionRef,
    snapshotId: source.snapshotId,
    sourceRevision: source.sourceRevision,
    sourceFingerprint: source.sourceRevision,
    lifecycle: source.lifecycle,
    capabilities: source.capabilities,
    trustState: certified ? 'certified' : 'review_required',
    reviewStatus: certified ? 'not_required' : 'required',
    // Checked · Needs certifying (design Q1): from the catalog, never the browser.
    ...(!certified && source.check ? { checked: true } : {}),
  };
}

type DatasetDraftReference = {
  page: DashboardDocument;
  tile: DashboardGridItem;
  sourceId: string;
  pageBinding?: DashboardDatasetBinding;
};

type DatasetDraftAuthorityPurpose = 'local_preview' | 'project_publish';

/**
 * A field tile is owned by a source id plus an exact page binding. Keeping
 * this extraction at the App API boundary makes every mutation and preflight
 * use the same provenance contract instead of trusting a source card copied
 * through a browser PATCH body.
 */
function datasetDraftReferences(draft: AppBuildDraft): DatasetDraftReference[] {
  return draft.pages.flatMap((page) => page.layout.items.flatMap((tile) => {
    if (!tile.query || !tile.sourceId) return [];
    const sourceId = tile.sourceId.trim();
    if (!sourceId) return [];
    const pageBinding = tile.sourceRevision
      ? page.datasets?.find((binding) => binding.sourceId === sourceId && binding.sourceRevision === tile.sourceRevision)
      : undefined;
    return [{ page, tile, sourceId, ...(pageBinding ? { pageBinding } : {}) }];
  }));
}

function datasetDraftSourceIds(
  draft: AppBuildDraft,
  additionalIds: Iterable<string> = [],
): string[] {
  const ids = new Set(datasetDraftReferences(draft).map((reference) => reference.sourceId));
  for (const sourceId of additionalIds) {
    const clean = cleanString(sourceId);
    if (clean) ids.add(clean);
  }
  return Array.from(ids);
}

function expectedDatasetDraftSourceKind(source: AppSourceCatalogRecord): AppBuildDraftSource['kind'] {
  return source.kind === 'semantic' ? 'governed_semantic' : 'block';
}

function datasetDraftAuthorityIssue(
  reference: DatasetDraftReference,
  stored: AppBuildDraftSource | undefined,
  current: AppSourceCatalogRecord | undefined,
): string | undefined {
  const title = reference.tile.title || `${reference.page.id}/${reference.tile.i}`;
  if (!stored || !stored.capabilities?.dataset) {
    return `APP_BUILD_DATASET_SOURCE_REPAIR_REQUIRED: ${title} has no stored approved Dataset capability. Refresh or reselect this Dataset before continuing.`;
  }
  if (!current || !current.capabilities.dataset) {
    return `APP_BUILD_DATASET_SOURCE_DRIFT: ${title} no longer resolves to a current approved Dataset contract. Refresh or reselect this Dataset before continuing.`;
  }
  const descriptor = stored.capabilities.dataset;
  const currentDescriptor = current.capabilities.dataset;
  const expectedKind = expectedDatasetDraftSourceKind(current);
  const storedKindMatches = stored.kind === expectedKind
    || (expectedKind === 'block' && stored.kind === 'certified_block');
  const expectedTrustState = current.trust === 'certified' ? 'certified' : 'review_required';
  const expectedReviewStatus = current.trust === 'certified' ? 'not_required' : 'required';
  if (!storedKindMatches
    || stored.sourceRevision !== current.sourceRevision
    || (stored.sourceFingerprint !== undefined && stored.sourceFingerprint !== current.sourceRevision)
    || descriptor.sourceRevision !== current.sourceRevision
    || descriptor.binding.sourceRevision !== current.sourceRevision
    || descriptor.contractRef.fingerprint !== currentDescriptor.contractRef.fingerprint
    || descriptor.binding.contractFingerprint !== currentDescriptor.binding.contractFingerprint
    || stored.lifecycle !== current.lifecycle
    || stored.trustState !== expectedTrustState
    || stored.reviewStatus !== expectedReviewStatus) {
    return `APP_BUILD_DATASET_SOURCE_AUTHORITY_STALE: ${title} does not match the current governed Dataset source authority. Refresh or reselect this Dataset before continuing.`;
  }
  if (!reference.tile.sourceRevision || !reference.pageBinding
    || reference.tile.sourceRevision !== current.sourceRevision
    || reference.pageBinding.sourceRevision !== current.sourceRevision
    || reference.pageBinding.contractFingerprint !== currentDescriptor.contractRef.fingerprint) {
    return `APP_BUILD_DATASET_SOURCE_REPAIR_REQUIRED: ${title} is missing its exact current Dataset revision and contract binding. Refresh or reselect this Dataset before continuing.`;
  }
  return undefined;
}

async function resolveCurrentDatasetSourceRecords(
  projectRoot: string,
  sourceIds: string[],
  resolver?: Ctx['resolveDatasetSourceAuthority'],
): Promise<Map<string, AppSourceCatalogRecord>> {
  if (sourceIds.length === 0) return new Map();
  if (resolver) {
    const records = await resolver(sourceIds);
    const byId = new Map(records.map((source) => [source.sourceId, source]));
    const missingSourceIds = sourceIds.filter((sourceId) => !byId.has(sourceId));
    if (missingSourceIds.length > 0) {
      throw new Error(`APP_BUILD_DATASET_SOURCE_DRIFT: these Dataset sources no longer resolve in the current governed catalog: ${missingSourceIds.join(', ')}`);
    }
    return byId;
  }
  const { ensureAgentProjectReady, resolveAppSourceCatalogRecords } = await import('@zlens/agent');
  await ensureAgentProjectReady(projectRoot);
  // Discovery includes review-required sources so local draft preview can
  // honour an explicit source-policy opt-in. Eligibility is enforced below;
  // this call alone never grants execution or publication permission.
  const resolved = resolveAppSourceCatalogRecords(projectRoot, sourceIds, 'include_review_required');
  if (resolved.missingSourceIds.length > 0) {
    throw new Error(`APP_BUILD_DATASET_SOURCE_DRIFT: these Dataset sources no longer resolve in the current governed catalog: ${resolved.missingSourceIds.join(', ')}`);
  }
  return new Map(resolved.items.map((source) => [source.sourceId, source]));
}

async function datasetDraftCurrentAuthorityErrors(
  projectRoot: string,
  draft: AppBuildDraft,
  purpose: DatasetDraftAuthorityPurpose,
  resolver?: Ctx['resolveDatasetSourceAuthority'],
): Promise<string[]> {
  const references = datasetDraftReferences(draft);
  if (references.length === 0) return [];
  let records: Map<string, AppSourceCatalogRecord>;
  try {
    records = await resolveCurrentDatasetSourceRecords(projectRoot, datasetDraftSourceIds(draft), resolver);
  } catch (error) {
    return [`APP_BUILD_DATASET_AUTHORITY_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`];
  }
  const storedById = new Map(draft.sources.map((source) => [source.id, source]));
  const errors: string[] = [];
  for (const reference of references) {
    const source = records.get(reference.sourceId);
    const authorityIssue = datasetDraftAuthorityIssue(reference, storedById.get(reference.sourceId), source);
    if (authorityIssue) {
      errors.push(authorityIssue);
      continue;
    }
    // There is no per-App data rule (T3): certified and not-certified data
    // both preview and publish, and readers see "Not certified yet" on the
    // tiles nobody certified. Only a retired (deprecated) source is refused.
    if (!source!.eligibility.localPreview) {
      errors.push(`APP_BUILD_DATASET_RETIRED: ${reference.tile.title || reference.tile.i} uses ${source!.title}, which is ${source!.lifecycle}. Replace it with current data.`);
      continue;
    }
  }
  return Array.from(new Set(errors));
}

/**
 * Canonicalize Dataset source mutations against the current server catalog.
 * This rejects a browser attempt to manufacture a trusted semantic source and
 * leaves legacy whole-block / non-Dataset source operations untouched.
 */
async function bindServerResolvedDatasetSourceOperations(
  projectRoot: string,
  draft: AppBuildDraft,
  operations: AppBuildDraftOperation[],
  resolver?: Ctx['resolveDatasetSourceAuthority'],
): Promise<AppBuildDraftOperation[]> {
  // Resolve potentially field-based source ids *before* applying browser
  // source objects. A repair request intentionally replaces an unknown
  // placeholder with a catalog card, so applying the untrusted replacement
  // first would let core draft policy reject the very repair we need to
  // canonicalize.
  const sourceIds = datasetDraftOperationSourceIds(draft, operations);
  if (sourceIds.length === 0) return operations;
  const records = await resolveCurrentDatasetSourceRecords(projectRoot, sourceIds, resolver);
  let canonicalOperations = operations.map((operation) => {
    if (operation.type !== 'upsert_source' || !sourceIds.includes(operation.source.id)) return operation;
    const source = records.get(operation.source.id);
    if (!source || !source.capabilities.dataset) {
      throw new Error(`APP_BUILD_DATASET_SOURCE_DRIFT: ${operation.source.id} no longer resolves to a current approved Dataset source.`);
    }
    return { type: 'upsert_source' as const, source: appDraftSourceFromCatalog(source) };
  });
  const candidate = canonicalOperations.length > 0
    ? applyAppBuildDraftOperations(draft, draft.revision, canonicalOperations)
    : draft;
  // Tile trust is a denormalized presentation field, never a browser
  // authority assertion. Once the resulting graph has a current Dataset
  // source, project the same lifecycle into its field tiles before it is
  // stored. This also keeps a refreshed review Dataset visibly review-required
  // instead of letting an old certified tile label survive the rebind.
  const presentationUpdates = candidate.pages.flatMap((page) => {
    const canonical = canonicalizeDatasetTilePresentation(page, records);
    return canonical === page ? [] : [{ type: 'upsert_page' as const, page: canonical }];
  });
  if (presentationUpdates.length > 0) {
    canonicalOperations = [...canonicalOperations, ...presentationUpdates];
  }
  const authoritativeCandidate = presentationUpdates.length > 0
    ? applyAppBuildDraftOperations(draft, draft.revision, canonicalOperations)
    : candidate;
  const contractErrors = datasetDraftContractErrors(authoritativeCandidate, records);
  if (contractErrors.length > 0) throw new Error(contractErrors[0]!);
  const authorityErrors = await datasetDraftCurrentAuthorityErrors(projectRoot, authoritativeCandidate, 'local_preview', resolver);
  if (authorityErrors.length > 0) throw new Error(authorityErrors[0]!);

  // A review task is evidence of an unresolved Dataset lifecycle. It can only
  // be removed after the same canonical source has become certified; hiding
  // it through a PATCH must not make a review source publishable.
  const candidateReferences = new Set(datasetDraftReferences(authoritativeCandidate).map((reference) => reference.sourceId));
  for (const operation of canonicalOperations) {
    if (operation.type !== 'remove_review_task') continue;
    const task = draft.reviewTasks.find((candidateTask) => candidateTask.id === operation.taskId);
    if (!task?.sourceId || !candidateReferences.has(task.sourceId)) continue;
    const source = records.get(task.sourceId);
    if (!source || source.lifecycle !== 'certified' || source.trust !== 'certified' || !source.eligibility.projectPublish) {
      throw new Error(`APP_BUILD_DATASET_REVIEW_TASK_REQUIRED: ${task.sourceId} remains review-required in the current governed catalog and cannot be cleared before certification.`);
    }
  }
  return canonicalOperations;
}

/**
 * Recompute only denormalized Dataset tile presentation fields from the
 * current catalog record. Source revision and binding identities are left
 * untouched here and validated separately; a stale page still fails closed.
 */
function canonicalizeDatasetTilePresentation(
  page: DashboardDocument,
  records: Map<string, AppSourceCatalogRecord>,
): DashboardDocument {
  let changed = false;
  const items = page.layout.items.map((tile) => {
    if (!tile.query || !tile.sourceId) return tile;
    const source = records.get(tile.sourceId);
    if (!source?.capabilities.dataset) return tile;
    const certified = source.lifecycle === 'certified' && source.trust === 'certified';
    const next: DashboardGridItem = {
      ...tile,
      sourceClass: source.kind === 'semantic'
        ? 'governed_semantic'
        : certified ? 'certified_block' : 'exploratory_analysis',
      trustState: certified ? 'certified' : 'review_required',
      reviewStatus: certified ? 'certified' : 'review_required',
      review: {
        status: certified ? 'not_required' : 'required',
        sourceFingerprint: source.sourceRevision,
      },
    };
    if (next.sourceClass !== tile.sourceClass
      || next.trustState !== tile.trustState
      || next.reviewStatus !== tile.reviewStatus
      || next.review?.status !== tile.review?.status
      || next.review?.sourceFingerprint !== tile.review?.sourceFingerprint) {
      changed = true;
      return next;
    }
    return tile;
  });
  return changed ? { ...page, layout: { ...page.layout, items } } : page;
}

/**
 * A source card is only capability authority after the whole resulting page
 * graph still binds every field query, filter mapping, and detail action to
 * that card's current descriptor. This closes the browser-PATCH bypass while
 * retaining legacy pages that do not use v3 Dataset bindings.
 */
function datasetDraftContractErrors(
  draft: AppBuildDraft,
  records: Map<string, AppSourceCatalogRecord>,
): string[] {
  const errors: string[] = [];
  for (const page of draft.pages) {
    const bindingById = new Map((page.datasets ?? []).map((binding) => [binding.id, binding]));
    for (const tile of page.layout.items) {
      if (!tile.query || !tile.sourceId) continue;
      const source = records.get(tile.sourceId);
      const descriptor = source?.capabilities.dataset;
      if (!descriptor) continue;
      const binding = Array.from(bindingById.values()).find((candidate) => candidate.sourceId === tile.sourceId
        && candidate.sourceRevision === tile.sourceRevision);
      if (!binding) {
        errors.push(`APP_BUILD_DATASET_BINDING_REQUIRED: ${page.id}/${tile.i} requires an exact current Dataset page binding.`);
        continue;
      }
      const validation = validateTileQuery(descriptor, tile.query);
      if (!tileQueryValidationRuns(validation)) {
        const detail = validation.diagnostics.map((diagnostic) => diagnostic.message).join(' ');
        errors.push(`APP_BUILD_DATASET_QUERY_${validation.outcome.toUpperCase()}: ${page.id}/${tile.i} is not fully covered by the current Dataset contract. ${detail}`.trim());
      }
      const visualization = datasetTileVisualizationCompatibility(tile.query, tile.viz.type);
      if (!visualization.compatible) {
        errors.push(`APP_BUILD_DATASET_VISUALIZATION_INVALID: ${page.id}/${tile.i}: ${visualization.message}`);
      }
    }
    for (const filter of page.filters ?? []) {
      for (const [bindingId, target] of Object.entries(filter.datasetBindings ?? {})) {
        const binding = bindingById.get(bindingId);
        const descriptor = binding ? records.get(binding.sourceId)?.capabilities.dataset : undefined;
        if (!binding || !descriptor) continue;
        const field = datasetPhysicalField(descriptor, target.field);
        if (!field || field.status !== 'approved') {
          errors.push(`APP_BUILD_DATASET_FILTER_INVALID: ${page.id}/${filter.id} targets ${target.field}, which is not an approved physical field for ${binding.sourceId}.`);
        }
      }
    }
    for (const mapping of page.interactions?.crossFilter?.mappings ?? []) {
      const targetBinding = bindingById.get(mapping.toDataset);
      const targetDescriptor = targetBinding ? records.get(targetBinding.sourceId)?.capabilities.dataset : undefined;
      if (targetBinding && targetDescriptor) {
        const targetField = datasetPhysicalField(targetDescriptor, mapping.toField);
        if (!targetField || targetField.status !== 'approved') {
          errors.push(`APP_BUILD_DATASET_CROSS_FILTER_INVALID: ${page.id}/${mapping.fromTileId} targets ${mapping.toField}, which is not an approved physical field for ${targetBinding.sourceId}.`);
        }
      }
      const fromTile = page.layout.items.find((tile) => tile.i === mapping.fromTileId);
      if (fromTile?.query && fromTile.sourceId) {
        const sourceDescriptor = records.get(fromTile.sourceId)?.capabilities.dataset;
        if (sourceDescriptor && !tileQueryOutputAliases(fromTile.query).some((output) => output.kind === 'dimension'
          && output.alias.toLowerCase() === mapping.fromField.toLowerCase())) {
          errors.push(`APP_BUILD_DATASET_CROSS_FILTER_INVALID: ${page.id}/${mapping.fromTileId} no longer emits ${mapping.fromField}.`);
        }
      }
    }
    const detail = page.interactions?.detail;
    const detailBinding = detail ? bindingById.get(detail.dataset) : undefined;
    const detailDescriptor = detailBinding ? records.get(detailBinding.sourceId)?.capabilities.dataset : undefined;
    if (detail && detailBinding && detailDescriptor) {
      for (const column of detail.columns) {
        const field = datasetPhysicalField(detailDescriptor, column);
        if (!field || field.status !== 'approved') {
          errors.push(`APP_BUILD_DATASET_DETAIL_INVALID: ${page.id} detail column ${column} is not an approved physical field for ${detailBinding.sourceId}.`);
        }
      }
    }
  }
  return Array.from(new Set(errors));
}

function datasetDraftOperationSourceIds(
  draft: AppBuildDraft,
  operations: AppBuildDraftOperation[],
): string[] {
  // Resolve only the Dataset authority that remains in the ordered authored
  // graph. A repair may remove an unavailable placeholder A and atomically
  // replace every page binding with B. Resolving A before that replacement
  // would make a valid repair impossible; leaving a tile or binding on A
  // keeps A in this projection and fails closed instead.
  const projectedSources = new Map(draft.sources.map((source) => [source.id, source]));
  const projectedPages = new Map(draft.pages.map((page) => [page.id, page]));
  for (const operation of operations) {
    if (operation.type === 'upsert_source') {
      projectedSources.set(operation.source.id, operation.source);
      continue;
    }
    if (operation.type === 'remove_source') {
      projectedSources.delete(operation.sourceId);
      continue;
    }
    if (operation.type === 'upsert_page') {
      projectedPages.set(operation.page.id, operation.page);
      continue;
    }
    if (operation.type === 'remove_page') {
      projectedPages.delete(operation.pageId);
      continue;
    }
    if (operation.type === 'add_tile' || operation.type === 'update_tile' || operation.type === 'remove_tile' || operation.type === 'set_layout') {
      const page = projectedPages.get(operation.pageId);
      if (!page) continue;
      if (operation.type === 'add_tile') {
        projectedPages.set(page.id, {
          ...page,
          layout: { ...page.layout, items: [...page.layout.items, operation.tile] },
        });
        continue;
      }
      if (operation.type === 'update_tile') {
        projectedPages.set(page.id, {
          ...page,
          layout: {
            ...page.layout,
            items: page.layout.items.map((tile) => tile.i === operation.tileId
              ? { ...tile, ...operation.patch, i: tile.i }
              : tile),
          },
        });
        continue;
      }
      if (operation.type === 'remove_tile') {
        projectedPages.set(page.id, {
          ...page,
          layout: { ...page.layout, items: page.layout.items.filter((tile) => tile.i !== operation.tileId) },
        });
        continue;
      }
      projectedPages.set(page.id, { ...page, layout: operation.layout });
      continue;
    }

    // Source identities are unchanged by the remaining operations.
  }

  const ids = new Set<string>();
  // A persisted Dataset card is still a governed authority assertion even if
  // a tile is not yet attached. Canonicalize it before it can be used later.
  for (const source of projectedSources.values()) {
    if (!source.capabilities?.dataset) continue;
    const sourceId = cleanString(source.id);
    if (sourceId) ids.add(sourceId);
  }
  for (const page of projectedPages.values()) {
    // A Dataset binding carries its own source/revision/contract authority.
    // Include it even when no tile currently selects it, so a dangling old
    // binding cannot survive a source replacement.
    for (const binding of page.datasets ?? []) {
      const sourceId = cleanString(binding.sourceId);
      if (sourceId) ids.add(sourceId);
    }
    for (const tile of page.layout.items) {
      if (!tile.query) continue;
      const sourceId = cleanString(tile.sourceId);
      if (sourceId) ids.add(sourceId);
    }
  }
  return Array.from(ids);
}

type AiProposalDatasetSourcePin = {
  sourceId: string;
  sourceRevision: string;
  contractFingerprint: string;
  locations: string[];
};

/**
 * An AI proposal stores server-issued Dataset identities as reviewed intent.
 * They are deliberately separate from the source card capability resolver:
 * canonicalizing a card after the source changed would otherwise make an old
 * proposal appear current.  The source may be re-resolved for authority, but
 * its exact revision and contract must still match the proposal before an App
 * can be composed from it.
 */
function aiProposalDatasetSourcePins(
  operations: AppBuildDraftOperation[],
): AiProposalDatasetSourcePin[] {
  const pins = new Map<string, AiProposalDatasetSourcePin>();
  const add = (input: { sourceId: string; sourceRevision?: string; contractFingerprint?: string; location: string }) => {
    const sourceId = cleanString(input.sourceId);
    const sourceRevision = cleanString(input.sourceRevision);
    const contractFingerprint = cleanString(input.contractFingerprint);
    if (!sourceId || !sourceRevision || !contractFingerprint) {
      throw new Error(`APP_BUILD_DATASET_PROPOSAL_INVALID: ${input.location} is missing its server-issued Dataset revision or contract.`);
    }
    const existing = pins.get(sourceId);
    if (existing && (existing.sourceRevision !== sourceRevision || existing.contractFingerprint !== contractFingerprint)) {
      throw new Error(`APP_BUILD_DATASET_PROPOSAL_INVALID: ${sourceId} has conflicting Dataset authority pins in one proposal.`);
    }
    if (existing) {
      existing.locations.push(input.location);
      return;
    }
    pins.set(sourceId, { sourceId, sourceRevision, contractFingerprint, locations: [input.location] });
  };
  for (const operation of operations) {
    if (operation.type === 'upsert_source' && operation.source.capabilities?.dataset) {
      add({
        sourceId: operation.source.id,
        sourceRevision: operation.source.sourceRevision,
        contractFingerprint: operation.source.capabilities.dataset.contractRef.fingerprint,
        location: `source ${operation.source.id}`,
      });
      continue;
    }
    if (operation.type !== 'upsert_page') continue;
    for (const binding of operation.page.datasets ?? []) {
      add({
        sourceId: binding.sourceId,
        sourceRevision: binding.sourceRevision,
        contractFingerprint: binding.contractFingerprint,
        location: `page ${operation.page.id} binding ${binding.id}`,
      });
    }
  }
  return Array.from(pins.values());
}

async function assertAiProposalDatasetSourcePinsCurrent(
  projectRoot: string,
  operations: AppBuildDraftOperation[],
  resolver?: Ctx['resolveDatasetSourceAuthority'],
): Promise<void> {
  const pins = aiProposalDatasetSourcePins(operations);
  if (pins.length === 0) return;
  const records = await resolveCurrentDatasetSourceRecords(projectRoot, pins.map((pin) => pin.sourceId), resolver);
  for (const pin of pins) {
    const current = records.get(pin.sourceId);
    const dataset = current?.capabilities.dataset;
    if (!current || !dataset
      || current.sourceRevision !== pin.sourceRevision
      || dataset.contractRef.fingerprint !== pin.contractFingerprint
      || dataset.binding.sourceRevision !== pin.sourceRevision
      || dataset.binding.contractFingerprint !== pin.contractFingerprint) {
      throw new Error(`APP_BUILD_DATASET_PROPOSAL_STALE: ${pin.sourceId} changed revision or contract after this App proposal was generated. Refresh the proposal before composing.`);
    }
  }
}

/** A deliberate, editable first tile for the field-builder primary flow. */
function defaultTileQueryForDataset(
  dataset: DatasetDescriptor,
  view: 'kpi' | 'chart' | 'table',
): DashboardGridItem['query'] | undefined {
  const measure = dataset.fields.find((field) => field.kind === 'measure' && field.status === 'approved');
  if (!measure) return undefined;
  const groupField = dataset.fields.find((field): field is DatasetPhysicalField => field.kind === 'physical'
    && field.status === 'approved'
    && (field.role === 'time' || field.role === 'dimension' || field.role === 'attribute'));
  const dimensions = view === 'kpi' || !groupField
    ? []
    : [{
      field: groupField.name,
      ...(groupField.role === 'time' && groupField.time?.grains.length
        ? { timeGrain: groupField.time.grains[0] }
        : {}),
    }];
  return {
    dimensions,
    measures: [{ measure: measure.name }],
    ...(view === 'chart' && dimensions.length > 0 ? { orderBy: [{ alias: measure.name, direction: 'desc' as const }] } : {}),
    ...(view === 'table' ? { limit: 100 } : {}),
    respectsGlobalFilters: true,
  };
}

function appSourceCatalogRecordToLegacyRecommendation(source: AppSourceCatalogRecord): BlockCandidate {
  return {
    id: source.sourceId,
    name: source.name,
    domain: source.domain ?? 'uncategorized',
    status: source.lifecycle,
    owner: source.owner ?? null,
    tags: source.tags,
    path: source.executionRef,
    fingerprint: source.sourceRevision,
    lastModified: new Date(0).toISOString(),
    description: source.description ?? '',
    llmContext: null,
    chartType: source.capabilities.chartType,
    filterIds: source.capabilities.filters,
    dimensionIds: source.capabilities.dimensions,
    score: source.score ?? 0,
    reasons: source.reasons,
  };
}

function uniqueAppSourceRecords(sources: AppSourceCatalogRecord[]): AppSourceCatalogRecord[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (seen.has(source.sourceId)) return false;
    seen.add(source.sourceId);
    return true;
  });
}

/**
 * What a tile shows, for spotting a proposed tile the page already has: the
 * same source with the same fields (dimensions, measures, calculations,
 * filters) as the same kind of visual, or the same saved query shown as it
 * is. Sort, Top N and styling are left out: two tiles that differ only there
 * show the same thing. A table and a chart of the same fields are different.
 */
function plannedTileContentKey(item: Pick<DashboardGridItem, 'sourceId' | 'query' | 'block' | 'viz'>): string | undefined {
  const blockRef = item.block ? ('blockId' in item.block ? item.block.blockId : item.block.ref) : undefined;
  const kind = item.viz?.type === 'single_value' ? 'kpi' : item.viz?.type ?? '';
  if (item.query) {
    const query = normalizeTileQuery(item.query);
    if (!query || !item.sourceId) return undefined;
    const { orderBy: _orderBy, limit: _limit, ...content } = query;
    return `query:${item.sourceId}:${kind}:${stableTileJson(content)}`;
  }
  if (blockRef) return `block:${item.sourceId ?? ''}:${kind}:${blockRef}`;
  return undefined;
}

function stableTileJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTileJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableTileJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function uniqueTileId(existing: DashboardGridItem[], preferred: string): string {
  const base = slugify(preferred) || 'component';
  const ids = new Set(existing.map((item) => item.i));
  if (!ids.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

const APP_REQUIREMENT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'app', 'application', 'build', 'by', 'create', 'dashboard',
  'for', 'from', 'in', 'last', 'me', 'of', 'on', 'report', 'show', 'showing',
  'the', 'to', 'using', 'view', 'with',
]);

function appRequirementTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/)
    .map((token) => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token)
    .filter((token) => token.length > 1 && !APP_REQUIREMENT_STOP_WORDS.has(token)));
}

function catalogSourceSatisfiesRequirement(
  source: AppSourceCatalogRecord,
  requirement: AppBuildDraft['requirements'][number],
): boolean {
  const normalized = (values: string[]) => new Set(values.flatMap((value) => Array.from(appRequirementTokens(value))));
  const sourceMeasures = normalized(source.capabilities.measures);
  const sourceDimensions = normalized(source.capabilities.dimensions);
  const sourceFilters = normalized(source.capabilities.filters);
  const requires = [
    [normalized(requirement.measures), sourceMeasures],
    [normalized(requirement.dimensions), sourceDimensions],
    [normalized(requirement.filters), sourceFilters],
  ] as const;
  const declaredCompatible = requires.every(([required, available]) => (
    required.size === 0 || (available.size > 0 && Array.from(required).every((field) => available.has(field)))
  ));
  const hasDeclaredRequirement = requires.some(([required]) => required.size > 0);
  if (declaredCompatible && hasDeclaredRequirement) return true;

  const requirementTerms = appRequirementTokens(requirement.question);
  if (requirementTerms.size === 0) return false;
  const sourceTerms = appRequirementTokens([
    source.title,
    source.name,
    source.description ?? '',
    source.qualifiedIdentity,
    ...source.tags,
    ...source.capabilities.measures,
    ...source.capabilities.dimensions,
  ].join(' '));
  const overlap = Array.from(requirementTerms).filter((term) => sourceTerms.has(term)).length;
  return overlap >= Math.min(2, requirementTerms.size);
}

function splitQueryValues(values: string[]): string[] {
  return unique(values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean));
}

function materializeAppBuildProposalReviewAnalyses(
  projectRoot: string,
  draft: AppBuildDraft,
  plan: AppPlan,
  proposalId: string,
  candidates: AppBuildProposalTile[],
  inputDashboards: DashboardDocument[],
): {
  dashboards: DashboardDocument[];
  sourceOperations: AppBuildDraftOperation[];
  reviewTasks: AppBuildDraftOperation[];
  coverageByRequirement: Map<string, { sourceIds: string[]; componentIds: string[] }>;
} {
  const eligible = candidates.filter((candidate) => (
    candidate.source === 'ai_generated'
    && Boolean(candidate.sql)
    && !candidate.error
    && candidate.preflight.status === 'passed'
  ));
  if (eligible.length === 0 || inputDashboards.length === 0) {
    return { dashboards: inputDashboards, sourceOperations: [], reviewTasks: [], coverageByRequirement: new Map() };
  }
  const proposalKey = slugify(proposalId) || `proposal-${Date.now()}`;
  const relativeDraftDir = `proposals/${proposalKey}/drafts`;
  const absoluteDraftDir = join(projectRoot, '.dql', 'local', 'app-builds', draft.id, relativeDraftDir);
  mkdirSync(absoluteDraftDir, { recursive: true });
  const sourceOperations: AppBuildDraftOperation[] = [];
  const reviewTasks: AppBuildDraftOperation[] = [];
  const coverageByRequirement = new Map<string, { sourceIds: string[]; componentIds: string[] }>();
  const generatedItems: DashboardGridItem[] = [];
  const normalizeQuestion = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [index, candidate] of eligible.entries()) {
    const sql = candidate.sql!;
    if (sql.includes('"""')) throw new Error(`Exploratory SQL for "${candidate.title}" contains an unsupported triple-quote delimiter.`);
    const candidateKey = slugify(candidate.id) || `analysis-${index + 1}`;
    const blockName = `app_${slugify(draft.appId)}_${candidateKey}`;
    const sourceRef = `${relativeDraftDir}/${candidateKey}.dql`;
    const source = [
      `block "${escapeDqlString(blockName)}" {`,
      `  domain = "${escapeDqlString(plan.domain)}"`,
      '  type = "custom"',
      '  status = "review"',
      `  owner = "${escapeDqlString(plan.owner)}"`,
      `  description = "${escapeDqlString((candidate.answer ?? candidate.question ?? candidate.title).slice(0, 240))}"`,
      candidate.question ? `  llmContext = "${escapeDqlString(`App-scoped exploratory analysis. Question: ${candidate.question}`)}"` : '',
      '  caveats = ["AI-generated App analysis. Validate joins, filters, grain, and business interpretation before promotion."]',
      '  tags = ["app-scoped", "ai-generated", "needs-review"]',
      '',
      '  query = """',
      sql,
      '  """',
      '',
      '  visualization {',
      `    chart = "${escapeDqlString(normalizeGeneratedViz(candidate.viz))}"`,
      '  }',
      '}',
      '',
    ].filter(Boolean).join('\n');
    const fingerprint = `sha256:${createHash('sha256').update(source).digest('hex')}`;
    writeFileSync(join(absoluteDraftDir, `${candidateKey}.dql`), source, 'utf-8');
    const sourceId = `review-dql:${candidate.id}`;
    const componentId = `review_${candidateKey}`;
    sourceOperations.push({
      type: 'upsert_source',
      source: {
        id: sourceId,
        kind: 'review_dql',
        sourceRef,
        qualifiedIdentity: candidate.title,
        snapshotId: candidate.preflight.snapshotId ?? plan.snapshotId,
        sourceFingerprint: fingerprint,
        receiptId: candidate.preflight.receiptId,
        trustState: 'review_required',
        reviewStatus: 'required',
      },
    });
    reviewTasks.push({
      type: 'set_review_task',
      task: {
        id: `review-generated-${candidateKey}`,
        message: `Validate the joins, grain, filters, and business interpretation for ${candidate.title}.`,
        status: 'open',
        sourceId,
        pageId: inputDashboards[0].id,
        tileId: componentId,
      },
    });
    const requirementIds = candidate.requirementIds?.length
      ? candidate.requirementIds
      : plan.requirements.filter((requirement) => normalizeQuestion(requirement.question) === normalizeQuestion(candidate.question ?? '')).map((requirement) => requirement.id);
    for (const requirementId of requirementIds) {
      const current = coverageByRequirement.get(requirementId) ?? { sourceIds: [], componentIds: [] };
      current.sourceIds.push(sourceId);
      current.componentIds.push(componentId);
      coverageByRequirement.set(requirementId, current);
    }
    generatedItems.push({
      i: componentId,
      x: (index % 2) * 6,
      y: Math.floor(index / 2) * 4,
      w: 6,
      h: 4,
      draftAnalysis: {
        ref: sourceRef,
        artifactFingerprint: fingerprint,
        ...(candidate.preflight.snapshotId ?? plan.snapshotId ? { snapshotId: candidate.preflight.snapshotId ?? plan.snapshotId } : {}),
        ...(candidate.preflight.receiptId ? { executionReceiptId: candidate.preflight.receiptId } : {}),
      },
      viz: { type: normalizeGeneratedViz(candidate.viz) as DashboardGridItem['viz']['type'] },
      title: candidate.title,
      sourceClass: 'exploratory_analysis',
      sourceEvidence: [
        ...(candidate.sourceEvidence ?? []),
        {
          source: sourceRef,
          reason: candidate.question
            ? `AI generated this private analysis for: ${candidate.question}`
            : 'AI generated this private analysis for a requirement without governed coverage.',
          kind: 'review_dql',
          trustState: 'review_required',
        },
      ],
      review: { status: 'required', sourceFingerprint: fingerprint, ...(candidate.preflight.receiptId ? { preflightReceiptId: candidate.preflight.receiptId } : {}) },
      trustState: 'review_required',
      reviewStatus: 'review_required',
    });
  }
  const first = inputDashboards[0];
  const baseY = first.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  const items = [...first.layout.items, ...generatedItems.map((item) => ({ ...item, y: item.y + baseY }))];
  const sections = first.sections
    ? first.sections.some((section) => section.kind === 'appendix')
      ? first.sections
      : [...first.sections, { id: 'review-appendix', title: 'Review-required analysis', kind: 'appendix' as const, order: first.sections.length }]
    : undefined;
  const appendixId = sections?.find((section) => section.kind === 'appendix')?.id;
  const finalItems = appendixId
    ? items.map((item) => generatedItems.some((generated) => generated.i === item.i) ? { ...item, sectionId: appendixId } : item)
    : items;
  const page: DashboardDocument = {
    ...first,
    ...(sections ? { sections } : {}),
    layout: {
      ...first.layout,
      items: finalItems,
      responsive: responsiveLayoutsForDashboardItems(finalItems),
    },
  };
  return {
    dashboards: [page, ...inputDashboards.slice(1)],
    sourceOperations,
    reviewTasks,
    coverageByRequirement,
  };
}

/** A tile or source name in a planner note: "top_customers" reads "Top Customers". */
function plannerNoteTitle(title: string): string {
  const trimmed = title.trim();
  return /\s/.test(trimmed) ? trimmed : trimmed.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Give the plain saved queries among these catalog records their result
 * fields (design D1) through the runtime's once-per-revision read, then
 * return the records as the catalog now has them. Bounded by the caller's
 * candidate list; a read that fails leaves that saved query as it was.
 */
async function withSavedQueryResultFields(
  projectRoot: string,
  records: AppSourceCatalogRecord[],
  sourcePolicy: AppBuildSourcePolicy,
  read: AppBuildHooks['readSavedQueryFields'],
): Promise<AppSourceCatalogRecord[]> {
  if (!read) return records;
  const plain = records.filter((record) => record.kind === 'block' && !record.capabilities.dataset && !record.capabilities.semanticModelId);
  if (plain.length === 0) return records;
  try {
    await read(plain.map((record) => record.sourceId));
  } catch {
    return records;
  }
  const { resolveAppSourceCatalogRecords } = await import('@zlens/agent');
  const refreshed = new Map(resolveAppSourceCatalogRecords(projectRoot, plain.map((record) => record.sourceId), sourcePolicy).items.map((record) => [record.sourceId, record]));
  return records.map((record) => refreshed.get(record.sourceId) ?? record);
}

/**
 * AI is a coauthor of the same local AppBuildDraft used by manual authoring.
 * This adapter reuses the governed planner, compiles its result outside the
 * project, and returns typed operations. It does not mutate the draft or write
 * any canonical App source.
 */
export async function proposeAppBuildDraftOperations(
  projectRoot: string,
  draft: AppBuildDraft,
  input: { prompt: string; selectedBlockIds?: string[]; pageId?: string; mode?: AppBuildProposalMode },
  hooks?: AppBuildHooks,
): Promise<AppBuildDraftAiProposal> {
  const prompt = cleanString(input.prompt) || draft.frame.goal;
  const mode: AppBuildProposalMode = input.mode === 'replace' ? 'replace' : 'add';
  const requestedPageId = cleanString(input.pageId);
  const initialPage = requestedPageId
    ? draft.pages.find((candidate) => candidate.id === requestedPageId)
    : draft.pages[0];
  if (requestedPageId && !initialPage) {
    throw new Error(`APP_BUILD_PAGE_NOT_FOUND: page ${requestedPageId} is not in this App draft; refresh and try again.`);
  }
  if (!initialPage) throw new Error('The App draft needs a page before AI can compose it.');
  const {
    datasetPlannedQueryCoversRequirement,
    ensureAgentProjectReady,
    planAppBuildBrief,
    resolveAppSourceCatalogRecords,
    shortlistAppSources,
  } = await import('@zlens/agent');
  await ensureAgentProjectReady(projectRoot);
  const requestedIds = unique((input.selectedBlockIds ?? []).map(cleanString).filter(Boolean));
  if (requestedIds.length > 12) {
    throw new Error('APP_BUILD_SOURCE_LIMIT: at most 12 required App sources can be planned at once.');
  }
  const resolvedRequired = requestedIds.length
    ? resolveAppSourceCatalogRecords(projectRoot, requestedIds, APP_SOURCE_POLICY)
    : { items: [] as AppSourceCatalogRecord[], missingSourceIds: [] as string[] };
  if (resolvedRequired.missingSourceIds.length) {
    throw new Error(`APP_BUILD_SOURCE_DRIFT: these exact App sources no longer resolve: ${resolvedRequired.missingSourceIds.join(', ')}`);
  }
  const policyBlocked = resolvedRequired.items.filter((source) => !source.eligibility.localPreview);
  if (policyBlocked.length) {
    throw new Error(`APP_BUILD_DATASET_RETIRED: choose current data instead of ${policyBlocked.map((source) => source.title).join(', ')}.`);
  }
  let candidates = uniqueAppSourceRecords([
    ...resolvedRequired.items,
    // Certified data first, never only certified data (T3).
    ...shortlistAppSources(projectRoot, prompt, {
    sourcePolicy: APP_SOURCE_POLICY,
    domains: initialPage.metadata.domain && initialPage.metadata.domain !== 'general'
      ? [initialPage.metadata.domain]
      : undefined,
    }).items,
  ]).slice(0, 12);
  // Saved queries in the (at most 12) candidates get their result fields
  // first (design D1), so the planner composes field tiles from them.
  if (hooks?.datasetsEnabled !== false) {
    candidates = await withSavedQueryResultFields(projectRoot, candidates, APP_SOURCE_POLICY, hooks?.readSavedQueryFields);
  }
  const brief = await planAppBuildBrief({
    prompt,
    candidates,
    requiredSourceIds: resolvedRequired.items.map((source) => source.sourceId),
    sourcePolicy: APP_SOURCE_POLICY,
    domain: initialPage.metadata.domain,
    audience: draft.frame.audience,
    complete: hooks?.planAppBuild,
  });
  const byId = new Map(candidates.map((candidate) => [candidate.sourceId, candidate]));
  if (hooks?.datasetsEnabled === false && brief.components.some((component) => byId.get(component.sourceId)?.capabilities.dataset)) {
    throw new Error('APP_DATASETS_FEATURE_DISABLED: field-based Dataset tiles are turned off for this project (apps.datasets is false in dql.config.json). Remove it or set it to true before asking AI to author them.');
  }
  type PlannedPageState = {
    planId: string;
    pageId: string;
    page: DashboardDocument;
    keepMetadata: boolean;
    structuralItems: DashboardGridItem[];
    plannedItems: DashboardGridItem[];
    reservedItems: DashboardGridItem[];
    datasetBindings: DashboardDatasetBinding[];
    datasetBindingBySource: Map<string, DashboardDatasetBinding>;
  };
  const existingPageIds = new Set(draft.pages.map((candidate) => candidate.id));
  const assignedExistingPageIds = new Set<string>();
  const pageIdForPlan = (preferred: string, index: number): string => {
    const direct = draft.pages.find((candidate) => candidate.id === preferred && !assignedExistingPageIds.has(candidate.id));
    const first = index === 0 && !assignedExistingPageIds.has(initialPage.id) ? initialPage : undefined;
    // The author asked about one page: the plan's first page lands there even
    // when the planner named it after a different existing page.
    const existing = requestedPageId ? first ?? direct : direct ?? first;
    if (existing) {
      assignedExistingPageIds.add(existing.id);
      return existing.id;
    }
    const base = slugify(preferred) || `page-${index + 1}`;
    if (!existingPageIds.has(base)) {
      existingPageIds.add(base);
      return base;
    }
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!existingPageIds.has(candidate)) {
        existingPageIds.add(candidate);
        return candidate;
      }
    }
    throw new Error('APP_BUILD_PAGE_LIMIT: the App Builder could not allocate a unique page id.');
  };
  const pageStates = brief.pages.map((plannedPage, index): PlannedPageState => {
    const pageId = pageIdForPlan(plannedPage.id, index);
    const existing = draft.pages.find((candidate) => candidate.id === pageId);
    const base: DashboardDocument = existing ?? {
      version: 3,
      id: pageId,
      metadata: {
        title: plannedPage.title,
        description: brief.frame.decision || brief.frame.goal,
        ...(initialPage.metadata.domain ? { domain: initialPage.metadata.domain } : {}),
        ...(brief.frame.audience ? { audience: brief.frame.audience } : {}),
      },
      datasets: [],
      layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
    };
    // Add mode keeps every existing tile; replace mode keeps only text tiles.
    const structuralItems = mode === 'add'
      ? [...base.layout.items]
      : base.layout.items.filter((item) => Boolean(item.text));
    const keepMetadata = mode === 'add' && Boolean(existing);
    const datasetBindings = [...(base.datasets ?? [])];
    return {
      planId: plannedPage.id,
      pageId,
      page: {
        ...base,
        ...(datasetBindings.length > 0 ? { version: 3 as const, datasets: datasetBindings } : {}),
        metadata: keepMetadata
          ? base.metadata
          : { ...base.metadata, title: plannedPage.title, description: brief.frame.decision || brief.frame.goal },
      },
      keepMetadata,
      structuralItems,
      plannedItems: [],
      reservedItems: [...structuralItems],
      datasetBindings,
      datasetBindingBySource: new Map(datasetBindings.map((binding) => [binding.sourceId, binding])),
    };
  });
  const pageStateByPlanId = new Map(pageStates.map((state) => [state.planId, state]));
  const plannedPageForComponent = new Map(brief.pages.flatMap((plannedPage) => plannedPage.componentIds.map((componentId) => [componentId, plannedPage.id] as const)));
  const componentTileIdById = new Map<string, string>();
  const componentPageIdById = new Map<string, string>();
  const emittedComponents: typeof brief.components = [];
  const warnings = [...brief.warnings];
  for (const component of brief.components) {
    const source = byId.get(component.sourceId);
    const pageState = pageStateByPlanId.get(plannedPageForComponent.get(component.id) ?? brief.pages[0]?.id ?? '');
    if (!source || !pageState) continue;
    const certified = source.lifecycle === 'certified';
    const descriptor = source.capabilities.dataset;
    let query: TileQuery | undefined;
    let viz: DashboardGridItem['viz'] = { type: component.view };
    // A saved query's result fields (design D1) without a field query show its result as it is.
    if (descriptor && (component.query !== undefined || !descriptor.result)) {
      const normalized = normalizeTileQuery(component.query);
      const validation = normalized ? validateTileQuery(descriptor, normalized) : undefined;
      if (!normalized || !tileQueryValidationRuns(validation)) {
        // A plain note for the author; the field-level diagnostics stay out of it.
        warnings.push(`${plannerNoteTitle(component.title)} wasn't added: it uses fields ${plannerNoteTitle(source.title)} doesn't have approved.`);
        continue;
      }
      // Show Me (RFC 0009) picks the chart for the fields and lays them on
      // shelves: a distinct count is never stacked or sliced, and two units
      // never share an axis. A detail or evidence component stays a table.
      const choice = component.role === 'detail' || component.role === 'evidence'
        ? undefined
        : showMeFirstChoice(showMeInputFromQuery(normalized, showMeFactsFromDescriptor(descriptor)));
      viz = { type: choice?.viz ?? 'table', ...(choice?.encoding ? { encoding: choice.encoding } : {}) };
      const visualization = datasetTileVisualizationCompatibility(normalized, viz.type);
      if (!visualization.compatible) {
        warnings.push(`${plannerNoteTitle(component.title)} wasn't added. ${visualization.message}`);
        continue;
      }
      query = normalized;
      const existing = pageState.datasetBindingBySource.get(source.sourceId);
      if (existing && (existing.sourceRevision !== source.sourceRevision || existing.contractFingerprint !== descriptor.contractRef.fingerprint)) {
        throw new Error(`APP_BUILD_SOURCE_DRIFT: ${source.title} changed revision or contract; refresh or replace the existing Dataset binding before adding an AI tile.`);
      }
      if (!existing) {
        const binding: DashboardDatasetBinding = {
          id: `dataset_${createHash('sha256').update(source.sourceId).digest('hex').slice(0, 16)}`,
          sourceId: source.sourceId,
          sourceRevision: source.sourceRevision,
          snapshotId: source.snapshotId,
          contractFingerprint: descriptor.contractRef.fingerprint,
        };
        pageState.datasetBindings.push(binding);
        pageState.datasetBindingBySource.set(source.sourceId, binding);
      }
    }
    // A proposal never adds a tile the page already shows (design D4: "Revise"
    // duplicated tiles). The component points at the existing tile instead, so
    // its question still counts as covered and filters still reach it; its
    // source stays in the proposal (already the App's) so that coverage holds.
    // Only tiles already on the page count; a plan that repeats itself is left as planned.
    const contentKey = plannedTileContentKey({ sourceId: source.sourceId, viz, ...(query ? { query } : { block: { ref: source.executionRef } }) });
    const alreadyShown = contentKey
      ? pageState.structuralItems.find((item) => plannedTileContentKey(item) === contentKey)
      : undefined;
    if (alreadyShown) {
      componentTileIdById.set(component.id, alreadyShown.i);
      componentPageIdById.set(component.id, pageState.pageId);
      emittedComponents.push({ ...component, ...(query ? { query } : {}) });
      warnings.push(`${plannerNoteTitle(alreadyShown.title || component.title)} is already on this page, so it wasn't added again.`);
      continue;
    }
    const itemIndex = pageState.plannedItems.length;
    const tileId = uniqueTileId(pageState.reservedItems, component.id || `component-${itemIndex + 1}`);
    componentTileIdById.set(component.id, tileId);
    componentPageIdById.set(component.id, pageState.pageId);
    const plannedPage = brief.pages.find((candidate) => candidate.id === pageState.planId);
    const sectionId = plannedPage?.sections.find((section) => section.componentIds.includes(component.id))?.id;
    // The planner's one-line reason travels with the tile so the review can say why.
    const rationale = cleanString(component.rationale).slice(0, 500);
    const tile: DashboardGridItem = {
      i: tileId,
      x: (itemIndex % 2) * 6,
      y: pageState.structuralItems.reduce((max, item) => Math.max(max, item.y + item.h), 0) + Math.floor(itemIndex / 2) * 4,
      w: viz.type === 'kpi' || viz.type === 'single_value' ? 3 : 6,
      h: viz.type === 'kpi' || viz.type === 'single_value' ? 2 : 4,
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      ...(query ? { query } : { block: { ref: source.executionRef } }),
      viz: { ...viz, ...(component.style ? { style: component.style } : {}) },
      title: component.title,
      sourceClass: source.kind === 'semantic' ? 'governed_semantic' : certified ? 'certified_block' : 'exploratory_analysis',
      filterBindings: source.capabilities.filters.map((filter) => ({
        filter,
        binding: filter,
        mode: 'predicate',
        capability: 'preflight_required',
      })),
      review: { status: certified ? 'not_required' : 'required', sourceFingerprint: source.sourceRevision },
      trustState: certified ? 'certified' : 'review_required',
      reviewStatus: certified ? 'certified' : 'review_required',
      ...(rationale ? {
        sourceEvidence: [{
          source: source.sourceId,
          reason: rationale,
          kind: 'planner_rationale',
          trustState: certified ? 'certified' as const : 'review_required' as const,
        }],
      } : {}),
      ...(sectionId ? { sectionId } : {}),
    };
    pageState.reservedItems.push(tile);
    pageState.plannedItems.push(tile);
    emittedComponents.push({ ...component, ...(query ? { query } : {}) });
  }
  const plannedSources = Array.from(new Set(emittedComponents.map((component) => component.sourceId))).flatMap((sourceId) => {
    const source = byId.get(sourceId);
    return source ? [source] : [];
  });
  const sourceOperations: AppBuildDraftOperation[] = plannedSources.map((source) => ({
    type: 'upsert_source',
    source: appDraftSourceFromCatalog(source),
  }));
  const nextPages = pageStates.map((state) => {
    const items = [...state.structuralItems, ...state.plannedItems];
    const plannedPage = brief.pages.find((candidate) => candidate.id === state.planId)!;
    const plannedSections = plannedPage.sections.map((section, index) => ({
      id: section.id,
      title: section.title,
      kind: section.kind,
      order: index,
    }));
    const existingSections = state.keepMetadata ? state.page.sections ?? [] : [];
    const sections = [
      ...existingSections,
      ...plannedSections
        .filter((section) => !existingSections.some((existingSection) => existingSection.id === section.id))
        .map((section, index) => ({ ...section, order: existingSections.length + index })),
    ];
    const plannedTileIds = state.plannedItems.map((item) => item.i);
    const story = state.keepMetadata && state.page.story
      ? { ...state.page.story, eligibleTileIds: unique([...(state.page.story.eligibleTileIds ?? []), ...plannedTileIds]) }
      : {
        version: 1 as const,
        goal: brief.frame.goal,
        ...(brief.frame.audience ? { audience: brief.frame.audience } : {}),
        eligibleTileIds: plannedTileIds,
      };
    return {
      ...state.page,
      ...(state.datasetBindings.length > 0 ? { version: 3 as const, datasets: state.datasetBindings } : {}),
      metadata: state.keepMetadata
        ? state.page.metadata
        : { ...state.page.metadata, title: plannedPage.title, description: brief.frame.decision || brief.frame.goal },
      sections,
      story,
      layout: {
        ...state.page.layout,
        items,
        responsive: responsiveLayoutsForDashboardItems(items),
      },
    };
  });
  const allPageIds = Array.from(new Set([...draft.pages.map((page) => page.id), ...nextPages.map((page) => page.id)]));
  const filterIdsByPage = new Map(allPageIds.map((pageId) => [pageId, new Set(draft.pages.find((page) => page.id === pageId)?.filters?.map((filter) => filter.id) ?? [])]));
  const filterOperations: AppBuildDraftOperation[] = [];
  for (const filterPlan of brief.filters) {
    const targetPages = filterPlan.scope === 'app'
      ? allPageIds
      : filterPlan.pageId ? [pageStateByPlanId.get(filterPlan.pageId)?.pageId].filter((id): id is string => Boolean(id)) : [];
    for (const targetPageId of targetPages) {
      const bindings: NonNullable<DashboardFilter['datasetBindings']> = {};
      const tileIds: string[] = [];
      for (const componentId of filterPlan.componentIds) {
        if (componentPageIdById.get(componentId) !== targetPageId) continue;
        const component = emittedComponents.find((candidate) => candidate.id === componentId);
        const source = component ? byId.get(component.sourceId) : undefined;
        const state = pageStates.find((candidate) => candidate.pageId === targetPageId);
        const binding = source ? state?.datasetBindingBySource.get(source.sourceId) : undefined;
        const field = source?.capabilities.dataset ? datasetPhysicalField(source.capabilities.dataset, filterPlan.field) : undefined;
        const tileId = componentTileIdById.get(componentId);
        if (!binding || !field || field.status !== 'approved' || !tileId) continue;
        const current = bindings[binding.id] ?? { field: field.name, tileIds: [] };
        current.tileIds = Array.from(new Set([...(current.tileIds ?? []), tileId]));
        bindings[binding.id] = current;
        tileIds.push(tileId);
      }
      const field = filterPlan.componentIds.flatMap((componentId) => {
        const component = emittedComponents.find((candidate) => candidate.id === componentId);
        const source = component ? byId.get(component.sourceId) : undefined;
        const exact = source?.capabilities.dataset ? datasetPhysicalField(source.capabilities.dataset, filterPlan.field) : undefined;
        return exact && exact.status === 'approved' ? [exact] : [];
      })[0];
      if (!field && filterPlan.scope !== 'app') continue;
      const finalField = field?.name ?? filterPlan.field;
      filterOperations.push({
        type: 'set_filter',
        pageId: targetPageId,
        filter: {
          id: filterPlan.id,
          type: field ? datasetFieldFilterType(field) : 'select',
          label: filterPlan.label,
          field: { name: finalField },
          scope: filterPlan.scope === 'app' ? { app: true } : { page: targetPageId, tileIds: Array.from(new Set(tileIds)) },
          datasetBindings: bindings,
        },
      });
      filterIdsByPage.get(targetPageId)?.add(filterPlan.id);
    }
  }
  const interactionOperations: AppBuildDraftOperation[] = [];
  for (const state of pageStates) {
    let interactions = state.page.interactions ? structuredClone(state.page.interactions) : undefined;
    let changed = false;
    const pageCrossFilters = brief.crossFilters.filter((plan) => componentPageIdById.get(plan.fromComponentId) === state.pageId);
    if (pageCrossFilters.length > 0) {
      const mappings = [...(interactions?.crossFilter?.mappings ?? [])];
      for (const plan of pageCrossFilters) {
        const fromTileId = componentTileIdById.get(plan.fromComponentId);
        const toTileId = componentTileIdById.get(plan.toComponentId);
        const targetComponent = emittedComponents.find((component) => component.id === plan.toComponentId);
        const targetSource = targetComponent ? byId.get(targetComponent.sourceId) : undefined;
        const targetBinding = targetSource ? state.datasetBindingBySource.get(targetSource.sourceId) : undefined;
        const targetField = targetSource?.capabilities.dataset ? datasetPhysicalField(targetSource.capabilities.dataset, plan.toField) : undefined;
        if (!fromTileId || !toTileId || !targetBinding || !targetField || targetField.status !== 'approved') continue;
        if (!mappings.some((mapping) => mapping.fromTileId === fromTileId && mapping.fromField === plan.fromField && mapping.toDataset === targetBinding.id && mapping.toField === targetField.name)) {
          mappings.push({ fromTileId, fromField: plan.fromField, toDataset: targetBinding.id, toField: targetField.name });
          changed = true;
        }
      }
      if (changed) interactions = { ...interactions, crossFilter: { enabled: true, mappings } };
    }
    const pageNavigation = brief.navigation.filter((plan) => componentPageIdById.get(plan.fromComponentId) === state.pageId);
    if (pageNavigation.length > 0) {
      const navigate = [...(interactions?.navigate ?? [])];
      for (const plan of pageNavigation) {
        const fromTile = componentTileIdById.get(plan.fromComponentId);
        const targetPage = pageStateByPlanId.get(plan.toPageId)?.pageId;
        if (!fromTile || !targetPage) continue;
        const carryFilters = Array.from(filterIdsByPage.get(state.pageId) ?? []).filter((id) => filterIdsByPage.get(targetPage)?.has(id));
        const index = navigate.findIndex((candidate) => candidate.fromTile === fromTile);
        const next = { fromTile, toPage: targetPage, carryFilters };
        if (index >= 0) navigate[index] = next;
        else navigate.push(next);
        changed = true;
      }
      interactions = { ...interactions, navigate };
    }
    const detail = brief.detailDrills.find((plan) => pageStateByPlanId.get(plan.pageId)?.pageId === state.pageId);
    if (detail) {
      const component = emittedComponents.find((candidate) => candidate.id === detail.componentId);
      const source = component ? byId.get(component.sourceId) : undefined;
      const binding = source ? state.datasetBindingBySource.get(source.sourceId) : undefined;
      const columns = source?.capabilities.dataset ? detail.fields.flatMap((field) => {
        const exact = datasetPhysicalField(source.capabilities.dataset!, field);
        return exact?.status === 'approved' ? [exact.name] : [];
      }) : [];
      if (binding && columns.length > 0) {
        interactions = { ...interactions, detail: { dataset: binding.id, columns: Array.from(new Set(columns)) } };
        changed = true;
      }
    }
    if (changed) interactionOperations.push({ type: 'set_interactions', pageId: state.pageId, interactions });
  }
  const coverage = brief.requirements.map((requirement) => {
    const components = emittedComponents.filter((component) => {
      if (!component.requirementIds.includes(requirement.id)) return false;
      const source = byId.get(component.sourceId);
      if (!source) return false;
      return source.capabilities.dataset
        ? Boolean(component.query && datasetPlannedQueryCoversRequirement(component.query, requirement, source.capabilities.dataset))
        : catalogSourceSatisfiesRequirement(source, requirement);
    });
    return {
      requirementId: requirement.id,
      status: components.length ? 'covered' as const : 'gap' as const,
      sourceIds: Array.from(new Set(components.map((component) => component.sourceId))),
      componentIds: components.map((component) => componentTileIdById.get(component.id) ?? component.id),
      reasons: components.length
        ? ['Covered by a source-bound App component from the validated Build Brief.']
        : ['No supplied source candidate covered this requirement.'],
    };
  });
  const clarifications = brief.frame.clarificationQuestions ?? [];
  // Data nobody certified yet opens no review task (T3): its tiles read
  // "Not certified yet", and the publish dialog offers to certify it.
  const reviewTasks: AppBuildDraftOperation[] = [];
  // Add mode keeps the App's goal and earlier requirements; new requirement
  // ids that collide with existing ones are renamed rather than overwriting.
  const { frame: proposedFrame, requirements: proposedRequirements, coverage: proposedCoverage } = mode === 'add'
    ? mergeAddModeRequirements(draft, brief.frame, brief.requirements, coverage)
    : { frame: brief.frame, requirements: brief.requirements, coverage };
  const operations: AppBuildDraftOperation[] = [
    {
      type: 'set_frame',
      frame: proposedFrame,
    },
    {
      type: 'set_requirements',
      requirements: proposedRequirements,
      coverage: proposedCoverage,
    },
    ...sourceOperations,
    ...nextPages.map((page) => ({ type: 'upsert_page' as const, page })),
    ...filterOperations,
    ...interactionOperations,
    ...reviewTasks,
  ];
  return {
    id: `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    draftId: draft.id,
    baseRevision: draft.revision,
    baseProposalHash: draft.proposalHash,
    plannerProvenance: brief.plannerProvenance,
    operations,
    mode,
    targetPageId: initialPage.id,
    prompt,
    proposedTileIds: pageStates.flatMap((state) => state.plannedItems.map((item) => item.i)),
    defaultSelectedSourceIds: plannedSources
      .filter((source) => source.eligibility.localPreview)
      .map((source) => source.sourceId),
    clarifications,
    candidateSourceIds: brief.candidateSourceIds,
    warnings,
    summary: {
      requirements: brief.requirements.length,
      covered: coverage.filter((item) => item.status === 'covered').length,
      gaps: coverage.filter((item) => item.status === 'gap').length,
      certifiedSources: plannedSources.filter((source) => source.lifecycle === 'certified').length,
      semanticSources: plannedSources.filter((source) => (
        source.kind === 'semantic'
        || source.capabilities.dataset?.kind === 'semantic'
        || Boolean(source.capabilities.semanticModelId)
      )).length,
    },
  };
}

export interface OpenAppAiBuildInStudioInput {
  /** Proposal tile ids the author kept; omitted = the ones selected by default. */
  selectedTileIds?: string[];
  expectedProposalHash?: string;
  appName?: string;
  audience?: string;
}

export type OpenAppAiBuildInStudioResult =
  | {
    ok: true;
    draft: AppBuildDraft;
    /** The data the draft starts with, in the App Studio words. */
    sources: AppBuildHandoffSourceSummary[];
    /** Questions App Studio lists under "Not covered yet". */
    notCoveredYet: string[];
    /** True when this proposal was already opened and the same draft is returned. */
    reused: boolean;
  }
  | { ok: false; error: string; status: number };

/**
 * Open an Ask `app_build` proposal in App Studio (design D9). The proposal
 * becomes a local App Studio draft, never App files: the brief is the App's
 * goal, the certified blocks and Metrics the author kept become the App's data
 * (App Studio requires them when it plans pages), and the question behind any
 * kept AI-written SQL tile is listed under "Not covered yet". App Studio
 * plans again from the goal, so it finds the other gaps itself.
 * App Studio then opens it at the AI Data step and publishing goes through
 * the publish checks; data nobody certified reads "Not certified yet".
 */
export async function openAppAiBuildInStudio(
  projectRoot: string,
  sessionId: string,
  input: OpenAppAiBuildInStudioInput = {},
  hooks: Pick<AppBuildHooks, 'readSavedQueryFields' | 'datasetsEnabled'> = {},
): Promise<OpenAppAiBuildInStudioResult> {
  const session = getAppAiBuildSession(projectRoot, sessionId);
  if (!session) return { ok: false, error: `AI build session "${sessionId}" not found`, status: 404 };
  if (session.studioDraftId) {
    const existing = loadStoredAppBuildDraft(projectRoot, session.studioDraftId);
    if (existing && existing.state !== 'project_published') {
      return { ok: true, draft: existing, sources: [], notCoveredYet: handoffGapQuestions(existing), reused: true };
    }
  }
  if (session.status !== 'proposed' || !session.proposal) {
    return { ok: false, error: session.error ?? 'This App build has no proposal to open.', status: 400 };
  }
  if (!input.expectedProposalHash || input.expectedProposalHash !== session.proposalHash) {
    return { ok: false, error: 'The App proposal changed or is stale. Ask again before opening it in App Studio.', status: 409 };
  }
  if (session.inputs.existingAppId) {
    return { ok: false, error: 'To add a page to an existing App, open that App in App Studio and describe the page with AI.', status: 400 };
  }
  const proposal = session.proposal;
  const selected = new Set(input.selectedTileIds
    ?? proposal.tiles.filter((tile) => tile.selectedByDefault && !tile.error).map((tile) => tile.id));
  const kept = proposal.tiles.filter((tile) => !tile.error && selected.has(tile.id));
  const semanticTiles = kept.filter((tile) => tile.source === 'semantic_query' && tile.semantic);
  // AI-written SQL is never written as an App tile: the question goes to
  // "Not covered yet", where App Studio can generate draft DQL on request.
  const draftSqlTiles = kept.filter((tile) => tile.source === 'ai_generated');
  const {
    appBuildHandoffSourceSummary,
    createAppBuildHandoffDraft,
    ensureAgentProjectReady,
    matchAppSourceCatalogRecords,
  } = await import('@zlens/agent');
  await ensureAgentProjectReady(projectRoot);
  const matchedRecords = matchAppSourceCatalogRecords(projectRoot, {
    blockNames: kept.flatMap((tile) => tile.source === 'certified_block' && tile.blockId ? [tile.blockId] : []),
    semanticModels: semanticTiles.flatMap((tile) => tile.semantic!.semanticModelRefs ?? []),
    metrics: semanticTiles.flatMap((tile) => tile.semantic!.metrics ?? []),
  }, 'include_review_required');
  // The saved queries Ask picked carry their result fields into App Studio (design D1).
  const matched = hooks.datasetsEnabled === false ? matchedRecords : {
    ...matchedRecords,
    items: await withSavedQueryResultFields(projectRoot, matchedRecords.items, 'include_review_required', hooks.readSavedQueryFields),
  };
  const plan = (session.plan ?? {}) as Partial<AppPlan>;
  // Only the questions behind kept Draft SQL are carried. App Studio plans
  // again from the same goal over its own catalog and finds the other gaps.
  const gaps = draftSqlTiles.map((tile) => ({
    question: cleanString(tile.question) || tile.title,
    reason: 'Ask wrote SQL for this question. Draft SQL is not added to an App; generate draft DQL for it in App Studio instead.',
  }));
  let draft: AppBuildDraft;
  try {
    draft = createAppBuildHandoffDraft({
      goal: session.prompt || proposal.buildFrame.goal,
      name: cleanString(input.appName) || cleanString(plan.name) || undefined,
      domain: session.inputs.domain || cleanString(plan.domain) || undefined,
      audience: cleanString(input.audience) || session.inputs.audience || proposal.buildFrame.audience,
      sources: matched.items,
      gaps,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), status: 400 };
  }
  writeStoredAppBuildDraft(projectRoot, draft);
  writeAppAiBuildSession(projectRoot, {
    ...session,
    status: 'ready',
    updatedAt: new Date().toISOString(),
    committedTileIds: kept.map((tile) => tile.id),
    studioDraftId: draft.id,
  });
  const reasonFor = (source: AppSourceCatalogRecord) => {
    const tile = kept.find((candidate) => candidate.blockId?.toLowerCase() === source.name.toLowerCase())
      ?? semanticTiles.find((candidate) => candidate.semantic!.metrics.some((metric) => source.capabilities.measures.includes(metric)));
    return tile ? `Ask picked it for ${tile.title}.` : 'Ask picked it for this App.';
  };
  return {
    ok: true,
    draft,
    sources: draft.sources.flatMap((draftSource) => {
      const source = matched.items.find((item) => item.sourceId === draftSource.id);
      return source ? [appBuildHandoffSourceSummary(source, reasonFor(source))] : [];
    }),
    notCoveredYet: handoffGapQuestions(draft),
    reused: false,
  };
}

function handoffGapQuestions(draft: AppBuildDraft): string[] {
  return draft.requirements
    .filter((requirement) => draft.coverage.some((coverage) => coverage.requirementId === requirement.id && coverage.status === 'gap'))
    .map((requirement) => requirement.question);
}

interface AppAskSuccess {
  ok: true;
  route: 'certified_answer' | 'dataset_chart_answer' | 'generated_answer' | 'investigation' | 'app_change_proposal' | 'metadata_answer';
  answer: string;
  /** Chart answers disclose deterministic fallback rather than claiming live AI. */
  answerMode?: 'provider' | 'deterministic_context_summary' | 'out_of_context';
  trustState: 'certified' | 'review_required' | 'draft_ready';
  reviewStatus: 'certified' | 'review_required' | 'draft_ready';
  citations: Array<{ kind: string; name: string; path?: string }>;
  followUps: string[];
  decision: AppAskDecision;
  investigation?: LocalAppInvestigation;
  proposal?: unknown;
  /** Grounded ReAct research plan (P4): the decision, steps, and follow-up options. */
  researchPlan?: AppResearchPlan;
  /** Server-owned chart context. It carries no browser-authored authority. */
  analyticalContext?: AppAnalyticalContextV1;
}

type AppAskResult = AppAskSuccess | { ok: false; error: string };

/**
 * Ask the App a question. Routes to the right lane (certified answer / investigation /
 * app change / metadata) and — when the runtime supplies a research planner — enriches
 * the result with a grounded ReAct plan + smart follow-up options (the P4 loop), so the
 * panel can DECIDE and offer real next steps instead of generic strings.
 */
async function askAppQuestion(ctx: Ctx, appId: string, input: AppAskRequest): Promise<AppAskResult> {
  const routed = await routeAppAskQuestion(ctx, appId, input);
  if (!routed.ok) return routed;
  // A chart answer is already grounded in an exact current local runtime
  // receipt. Do not send it through the broader research planner, which could
  // retrieve a different source or change the question's execution scope.
  if (routed.route === 'dataset_chart_answer') return routed;
  // Blend in the app's own suggested questions (uncovered analysis gaps captured
  // at AI-build time) so follow-ups point at what the app can't answer yet.
  const appCopilotQuestions = loadAppById(ctx.projectRoot, appId)?.app.copilot?.suggestedQuestions ?? [];
  const result: AppAskSuccess = appCopilotQuestions.length > 0
    ? { ...routed, followUps: unique([...routed.followUps, ...appCopilotQuestions]).slice(0, 5) }
    : routed;
  if (!ctx.planResearch) return result;
  try {
    const research = await ctx.planResearch({
      question: cleanString(input.question),
      isFollowUp: result.route === 'investigation' || result.route === 'app_change_proposal',
    });
    // A clarify decision means "ask before researching" — surface the real options.
    const followUps = research.decision === 'clarify' && research.followUp
      ? [research.followUp.question, ...research.followUp.options].slice(0, 5)
      : result.followUps;
    return { ...result, researchPlan: research, followUps };
  } catch {
    return result; // best-effort: research enrichment never blocks the answer
  }
}

async function routeAppAskQuestion(
  ctx: Ctx,
  appId: string,
  input: AppAskRequest,
): Promise<AppAskResult> {
  const loaded = loadAppById(ctx.projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const activePersona = defaultPersonaRegistry.active;
  if (activePersona?.appId && activePersona.appId !== appId) {
    return { ok: false, error: `The active persona belongs to App "${activePersona.appId}", not "${appId}".` };
  }
  const question = cleanString(input.question);
  if (!question) return { ok: false, error: 'question is required' };

  const dashboardId = cleanString(input.dashboardId)
    || (loaded.app.homepage?.type === 'dashboard' ? loaded.app.homepage.id : undefined)
    || loaded.dashboards[0]?.id;
  const dashboard = dashboardId ? loadDashboardForApp(ctx.projectRoot, appId, dashboardId)?.dashboard : null;
  const tile = dashboard?.layout.items.find((item) =>
    item.i === input.tileId ||
    (input.blockId && item.block && 'blockId' in item.block && item.block.blockId === input.blockId),
  );
  const blockId = cleanString(input.blockId) || (tile?.block && 'blockId' in tile.block ? tile.block.blockId : undefined);
  const appContext = buildAppContextEnvelope(ctx.projectRoot, loaded.app, loaded.appDir, {
    dashboardId,
    tileId: cleanString(input.tileId) || undefined,
    blockId,
  });
  const citations = [
    { kind: 'app', name: loaded.app.name, path: loaded.appPath },
    ...(dashboard ? [{ kind: 'dashboard', name: dashboard.metadata.title, path: `${loaded.appPath}/dashboards/${dashboard.id}.dqld` }] : []),
    ...(blockId ? [{ kind: 'block', name: blockId }] : []),
  ];

  const runId = cleanString(input.runId);
  const tileId = cleanString(input.tileId);
  if (runId && tileId && dashboardId && ctx.answerDatasetChart) {
    const chartAnswer = await ctx.answerDatasetChart({
      appId,
      dashboardId,
      tileId,
      runId,
      question,
    });
    if (!chartAnswer.ok) return chartAnswer;
    return {
      ok: true,
      route: 'dataset_chart_answer',
      answer: chartAnswer.answer,
      answerMode: chartAnswer.answerMode,
      trustState: chartAnswer.trustState,
      reviewStatus: chartAnswer.reviewStatus,
      citations: chartAnswer.citations,
      followUps: chartAnswer.followUps,
      analyticalContext: chartAnswer.context,
      decision: buildAppAskDecision('dataset_chart_answer', {
        question,
        selected: tile ? appAskTileContext(tile) : null,
        appName: loaded.app.name,
      }),
    };
  }

  if (isAppChangeQuestion(question)) {
    const decision = buildAppAskDecision('app_change_proposal', {
      question,
      blockId,
      selected: selectedBlockContext(input.context),
      appName: loaded.app.name,
    });
    return {
      ok: true,
      route: 'app_change_proposal',
      answer: `I can update the app presentation, but this should remain a reviewed app change. Suggested action: ${appChangeSuggestion(question)}.`,
      trustState: 'review_required',
      reviewStatus: 'review_required',
      citations,
      followUps: ['Review this app change', 'Open Build mode', 'Create analysis before changing logic'],
      decision,
      proposal: {
        type: 'app_change',
        version: 1,
        dashboardId,
        tileId: input.tileId,
        blockId,
        question,
        reviewRequired: true,
        expectedDashboardFingerprint: dashboard
          ? `sha256:${createHash('sha256').update(JSON.stringify(dashboard)).digest('hex')}`
          : undefined,
        operations: [{
          op: 'review_in_build_mode',
          target: cleanString(input.tileId) || dashboardId || appId,
          suggestion: appChangeSuggestion(question),
        }],
      },
    };
  }

  if (shouldRouteAppQuestionToInvestigation(question)) {
    const decision = buildAppAskDecision('investigation', {
      question,
      blockId,
      selected: selectedBlockContext(input.context),
      appName: loaded.app.name,
    });
    const investigationProposal = {
      type: 'research_investigation',
      dashboardId,
      tileId: cleanString(input.tileId) || undefined,
      blockId,
      question,
      intent: normalizeInvestigationIntent(undefined, question, input.context),
      title: titleFromInvestigation(question, selectedBlockContext(input.context)),
      requiredContext: true,
      reviewRequired: true,
      suggestedContext: {
        appId,
        appName: loaded.app.name,
        dashboardId,
        tileId: input.tileId,
        blockId,
        variables: input.variables,
        selectedTile: tile ? appAskTileContext(tile) : undefined,
        userContext: input.context,
        appContext,
      },
    };

    if (input.runInvestigation === false) {
      return {
        ok: true,
        route: 'investigation',
        answer: 'This needs a scoped analysis memo. Add the comparison, filters, timeframe, and decision context before ZLens writes SQL or runs a preview.',
        trustState: 'draft_ready',
        reviewStatus: 'draft_ready',
        citations,
        followUps: ['Add analysis context', 'Check proof', 'Create saved query draft'],
        decision,
        proposal: investigationProposal,
      };
    }

    const storage = openAppStorage(ctx.projectRoot);
    try {
      let investigation = createOrReuseAppInvestigation(storage, {
        appId,
        dashboardId,
        sourceTileId: cleanString(input.tileId) || undefined,
        sourceBlockId: blockId,
        title: titleFromInvestigation(question, selectedBlockContext(input.context)),
        question,
        intent: normalizeInvestigationIntent(undefined, question, input.context),
        context: {
          appId,
          appName: loaded.app.name,
          dashboardId,
          tileId: input.tileId,
          blockId,
          variables: input.variables,
          selectedTile: tile ? appAskTileContext(tile) : undefined,
          userContext: input.context,
          appContext,
          routeDecision: decision,
        },
      });
      // HH-14: a memo whose figures would be withheld from this person is opened, not run, for them.
      const withheld = await memoFiguresWithheld(ctx);
      if (!withheld) investigation = await runAppInvestigation(ctx, storage, investigation, { context: investigation.context });
      return {
        ok: true,
        route: 'investigation',
        answer: 'I opened a review-required analysis memo for this follow-up. Review the numbers, caveats, SQL appendix, and source proof before adding it to the app or drafting reusable logic.',
        trustState: 'draft_ready',
        reviewStatus: 'draft_ready',
        citations,
        followUps: ['Review the memo', 'Add reviewed result to this app', 'Create a draft saved query'],
        decision,
        investigation: investigationForReader(investigation, withheld),
      };
    } finally {
      storage.close();
    }
  }

  // The focused tile narrates ONLY questions that are actually about it ("explain this",
  // "what does this chart show"). Everything else routes through the shared governed loop.
  const focusTileAnswer = (): AppAskSuccess => {
    const selected = selectedBlockContext(input.context);
    const answer = buildCertifiedAppAnswer({
      app: loaded.app,
      dashboard: dashboard ?? null,
      blockId: blockId!,
      question,
      selected,
      variables: input.variables,
    });
    return {
      ok: true,
      route: 'certified_answer',
      answer,
      trustState: tile?.trustState === 'certified' || tile?.display?.trustState === 'certified' ? 'certified' : 'review_required',
      reviewStatus: tile?.reviewStatus === 'certified' || tile?.display?.reviewStatus === 'certified' ? 'certified' : 'review_required',
      citations,
      followUps: ['Explain the visible result', 'Investigate drivers', 'Create saved query draft from this result'],
      decision: buildAppAskDecision('certified_answer', { question, blockId, selected, appName: loaded.app.name }),
    };
  };

  if (blockId && questionIsAboutFocusedTile(question)) {
    return focusTileAnswer();
  }

  // Route the QUESTION through the same governed answer loop the Notebook and Ask
  // surfaces use: question-first retrieval finds the best-matching certified block
  // across the app, generates review-required SQL, or digs deeper — instead of
  // narrating whichever tile happens to be focused.
  const governed = await tryGovernedAppAnswer(ctx, question, { blockId, appName: loaded.app.name, citations, appContext });
  if (governed) return governed;

  // Offline / no AI provider: keep the focused tile as a graceful fallback.
  if (blockId) return focusTileAnswer();

  return {
    ok: true,
    route: 'metadata_answer',
    answer: `${loaded.app.name} is a ${loaded.app.domain} app for ${loaded.app.audience ?? 'stakeholders'}. It has ${loaded.dashboards.length} dashboard page${loaded.dashboards.length === 1 ? '' : 's'}, ${loaded.aiPins.length} pinned insight${loaded.aiPins.length === 1 ? '' : 's'}, and ${loaded.investigations.length} analysis item${loaded.investigations.length === 1 ? '' : 's'}. Ask about a tile for a certified answer, or ask a why/change/drilldown question to create analysis.`,
    trustState: 'draft_ready',
    reviewStatus: 'draft_ready',
    citations,
    followUps: ['Ask about a specific tile', 'Find trust gaps', 'Start driver analysis'],
    decision: buildAppAskDecision('metadata_answer', {
      question,
      appName: loaded.app.name,
    }),
  };
}

function buildAppAskDecision(
  route: 'certified_answer' | 'dataset_chart_answer' | 'generated_answer' | 'investigation' | 'app_change_proposal' | 'metadata_answer',
  input: {
    question: string;
    blockId?: string;
    selected?: Record<string, unknown> | null;
    appName?: string;
  },
): AppAskDecision {
  const selected = input.selected ?? null;
  const sourceName = selectedString(selected, 'title')
    || cleanString(input.blockId)
    || cleanString(input.appName)
    || 'this app';
  if (route === 'certified_answer') {
    return {
      mode: 'answer',
      reason: `The question can be answered from the selected certified result: ${sourceName}.`,
      nextAction: 'Use the answer directly, or request deeper analysis when you need a new comparison, grain, or reusable logic.',
      requiresContext: false,
      usesCertifiedResult: true,
      confidence: hasSelectedRows(selected) ? 0.9 : 0.74,
    };
  }
  if (route === 'dataset_chart_answer') {
    return {
      mode: 'answer',
      reason: `The question can be answered from the selected current Dataset result: ${sourceName}.`,
      nextAction: 'Use the current chart answer directly, or rerun the chart before asking again after its source, query, filters, or persona changes.',
      requiresContext: false,
      usesCertifiedResult: false,
      confidence: hasSelectedRows(selected) ? 0.9 : 0.74,
    };
  }
  if (route === 'generated_answer') {
    return {
      mode: 'answer',
      reason: 'Answered by routing the question through the governed answer loop (best-matching certified saved query, or review-required generated SQL).',
      nextAction: 'Review the result; promote to a certified saved query when it should be reused.',
      requiresContext: false,
      usesCertifiedResult: false,
      confidence: 0.7,
    };
  }
  if (route === 'investigation') {
    const intent = normalizeInvestigationIntent(undefined, input.question, selected);
    return {
      mode: 'analysis',
      reason: appAskInvestigationReason(intent),
      nextAction: 'Add the exact comparison, filters, and proof focus before ZLens writes SQL or opens the main-canvas analysis.',
      requiresContext: true,
      usesCertifiedResult: Boolean(input.blockId || input.selected),
      confidence: 0.82,
    };
  }
  if (route === 'app_change_proposal') {
    return {
      mode: 'app_change',
      reason: 'The question asks to change presentation or layout, not business logic.',
      nextAction: 'Review the proposed app change in Build mode and keep certified saved query logic unchanged.',
      requiresContext: false,
      usesCertifiedResult: Boolean(input.blockId || input.selected),
      confidence: 0.78,
    };
  }
  return {
    mode: 'metadata',
    reason: 'No specific certified tile was selected, so ZLens answered from app metadata.',
    nextAction: 'Select a tile for a trusted answer, or ask for deeper analysis with a clear comparison and filter scope.',
    requiresContext: false,
    usesCertifiedResult: false,
    confidence: 0.62,
  };
}

/**
 * True only when the question is genuinely ABOUT the focused tile ("explain this",
 * "what does this chart show") — deictic/explanatory and not asking for other data.
 * Any other question (rankings, other entities, drilldowns, "why") must route through
 * the shared governed loop instead of narrating the focused tile.
 */
function questionIsAboutFocusedTile(question: string): boolean {
  const lower = question.toLowerCase();
  if (!/\b(this|that|it|these|those|the (?:chart|graph|result|tile|number|value|visual|figure)|visible|current (?:tile|block|metric|result)|selected (?:tile|block|metric)|explain)\b/.test(lower)) {
    return false;
  }
  if (/\b(top|bottom|best|worst|highest|lowest|least|fewest|most|rank|ranking|customers?|products?|orders?|revenue|sales|spend|by\s+[a-z]|compare|versus|vs\.?|break\s*down|drill|why|driver|segment|cohort|trend|forecast|list|who|where|which)\b/.test(lower)) {
    return false;
  }
  return true;
}

/** Map a governed AgentAnswer into the App Copilot's response shape. */
/** Overlap needed before a draft is offered as covering the question. */
const APP_DRAFT_MATCH_MIN_OVERLAP = 2;

const APP_DRAFT_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'what', 'which', 'who', 'how', 'why', 'is', 'are',
  'do', 'does', 'can', 'you', 'me', 'my', 'our', 'this', 'that', 'show', 'give', 'get', 'by', 'of',
  'in', 'on', 'to', 'from', 'all', 'complete', 'view',
]);

function appDraftTokens(value: string): Set<string> {
  return new Set(
    value.toLowerCase().split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !APP_DRAFT_STOPWORDS.has(word)),
  );
}

/**
 * The app's own draft that best covers a question the governed loop could not answer.
 *
 * Drafts are review-required exploratory analyses saved in the app. They are not
 * indexed into the manifest, so retrieval cannot find them — but when the loop
 * has just refused for want of a certified path, the app frequently already
 * contains a draft that does exactly the thing. Offering it is strictly better
 * than explaining the gap and stopping, and it never launders trust: the answer
 * stays review-required and says the source is an unreviewed draft.
 */
export function matchAppDraftForQuestion(
  drafts: AppContextEnvelopeV1['drafts'],
  question: string,
): AppContextEnvelopeV1['drafts'][number] | undefined {
  const asked = appDraftTokens(question);
  if (asked.size === 0) return undefined;
  let best: { draft: AppContextEnvelopeV1['drafts'][number]; score: number } | undefined;
  for (const draft of drafts ?? []) {
    const candidate = appDraftTokens([draft.name, draft.question ?? '', draft.description ?? ''].join(' '));
    let score = 0;
    for (const token of asked) if (candidate.has(token)) score += 1;
    if (score >= APP_DRAFT_MATCH_MIN_OVERLAP && (!best || score > best.score)) best = { draft, score };
  }
  return best?.draft;
}

function mapGovernedToAppAsk(
  governed: AgentAnswer,
  input: { question: string; blockId?: string; appName: string; citations: Array<{ kind: string; name: string; path?: string }>; appContext?: AppContextEnvelopeV1 },
): AppAskSuccess {
  const isCertified = governed.certification === 'certified' || governed.kind === 'certified';
  const noAnswer = governed.kind === 'no_answer';
  const governedText = cleanString(governed.answer) || cleanString(governed.text) || 'No governed answer was available for this question.';
  // The loop just declined for want of certified evidence. Before returning only
  // the gap, check whether this app already saved a draft that covers it.
  const draft = noAnswer ? matchAppDraftForQuestion(input.appContext?.drafts ?? [], input.question) : undefined;
  // App drafts are often generated FROM a refusal like this one, so their
  // description can be the same paragraph the loop just returned. Only add it
  // when it actually says something new.
  const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const draftAdds = draft?.description && !normalize(governedText).includes(normalize(draft.description).slice(0, 80))
    ? draft.description
    : '';
  const answer = draft
    ? [
        governedText,
        '',
        `This app already has a saved draft for it: "${draft.name}" (${draft.status}).`,
        draftAdds,
        'It is an unreviewed draft, not a certified answer — open it under Drafts, check the join, grain, and filters, then certify it to make it governed.',
      ].filter(Boolean).join('\n')
    : governedText;
  const route: AppAskSuccess['route'] = noAnswer ? 'metadata_answer' : isCertified ? 'certified_answer' : 'generated_answer';
  // Offering a draft is actionable but unreviewed, so it is review_required
  // rather than the bare draft_ready used when there is nothing to offer.
  const trustState: AppAskSuccess['trustState'] = draft ? 'review_required' : noAnswer ? 'draft_ready' : isCertified ? 'certified' : 'review_required';
  const govCitations = Array.isArray(governed.citations)
    ? governed.citations.map((c) => ({ kind: String((c as { kind?: unknown }).kind ?? 'source'), name: String((c as { name?: unknown }).name ?? '') })).filter((c) => c.name)
    : [];
  const seen = new Set<string>();
  const citations = [
    ...input.citations,
    ...govCitations,
    // Cite the draft so the user can open the exact file being offered.
    ...(draft ? [{ kind: 'draft', name: draft.name, path: draft.path }] : []),
  ].filter((c) => {
    const key = `${c.kind}:${c.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
  return {
    ok: true,
    route,
    answer,
    trustState,
    reviewStatus: trustState,
    citations,
    followUps: draft
      ? [`Open the "${draft.name}" draft`, 'Review its join and grain', 'Certify it to make it governed']
      : noAnswer
        ? ['Name the metric and grain', 'Pick a certified tile', 'Start driver analysis']
        : ['Investigate drivers', 'Break this down further', 'Create a draft saved query'],
    decision: buildAppAskDecision(route, { question: input.question, blockId: input.blockId, appName: input.appName }),
  };
}

/** Route the question through the shared governed answer loop; null if unavailable. */
async function tryGovernedAppAnswer(
  ctx: Ctx,
  question: string,
  input: { blockId?: string; appName: string; citations: Array<{ kind: string; name: string; path?: string }>; appContext: AppContextEnvelopeV1 },
): Promise<AppAskSuccess | null> {
  if (!ctx.generateGovernedAnswer) return null;
  try {
    const governed = await ctx.generateGovernedAnswer(question, input.appContext);
    return governed ? mapGovernedToAppAsk(governed, { question, ...input }) : null;
  } catch {
    return null; // no provider / transient — caller falls back to tile or metadata
  }
}

function appAskInvestigationReason(intent: LocalAppInvestigationIntent): string {
  if (intent === 'diagnose_change') return 'The question asks why something changed, which needs a comparison window or baseline beyond the visible certified result.';
  if (intent === 'segment_compare') return 'The question asks for a comparison across segments, cohorts, or groups, which needs scoped analysis before promotion.';
  if (intent === 'entity_drilldown') return 'The question asks for entity-level drilldown, which needs reviewed grain, joins, and identifiers.';
  if (intent === 'anomaly_investigation') return 'The question asks about an exception or outlier, which needs baseline proof before stakeholder use.';
  if (intent === 'trust_gap_review') return 'The question asks about proof, caveats, lineage, or trust gaps, which should be reviewed as an evidence brief.';
  return 'The question asks for drivers or decomposition, which needs scoped analysis before creating or changing reusable logic.';
}

function appAnalysisRouteDecisionFromContext(
  context: unknown,
  intent: LocalAppInvestigationIntent,
  selected: Record<string, unknown> | null,
  question: string,
): AppAskDecision {
  const root = asRecord(context);
  const rawDecision = asRecord(root?.routeDecision) ?? asRecord(asRecord(root?.originatingAnswer)?.decision);
  if (rawDecision) {
    return normalizeAppAskDecision(rawDecision, intent, selected, question);
  }
  return buildAppAskDecision('investigation', {
    question,
    blockId: selectedString(selected, 'blockId'),
    selected,
    appName: cleanString(root?.appName),
  });
}

function normalizeAppAskDecision(
  value: Record<string, unknown>,
  intent: LocalAppInvestigationIntent,
  selected: Record<string, unknown> | null,
  question: string,
): AppAskDecision {
  const mode = value.mode === 'answer' || value.mode === 'analysis' || value.mode === 'app_change' || value.mode === 'metadata'
    ? value.mode
    : 'analysis';
  const reason = cleanString(value.reason) || appAskInvestigationReason(intent);
  const nextAction = cleanString(value.nextAction)
    || 'Review the generated analysis, validate proof, then pin or promote only after approval.';
  const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : hasSelectedRows(selected) ? 0.82 : 0.68;
  return {
    mode,
    reason,
    nextAction,
    requiresContext: typeof value.requiresContext === 'boolean' ? value.requiresContext : mode === 'analysis',
    usesCertifiedResult: typeof value.usesCertifiedResult === 'boolean'
      ? value.usesCertifiedResult
      : Boolean(selectedString(selected, 'blockId') || selectedString(selected, 'certificationStatus')),
    confidence,
  };
}

function buildCertifiedAppAnswer(input: {
  app: AppDocument;
  dashboard: DashboardDocument | null;
  blockId: string;
  question: string;
  selected: Record<string, unknown> | null;
  variables?: Record<string, unknown>;
}): string {
  const rows = selectedRows(input.selected);
  const columns = selectedColumns(input.selected, rows);
  const metrics = buildMetricSnapshot(input.selected);
  const currentValue = typeofNumber(metrics.currentValue);
  const baselineValue = typeofNumber(metrics.baselineValue);
  const deltaValue = typeofNumber(metrics.delta);
  const metricName = cleanString(metrics.metric) || preferredMeasureColumn(columns, rows) || 'selected metric';
  const firstRow = rows[0];
  const labelColumn = preferredLabelColumn(columns, rows);
  const label = labelColumn && firstRow ? cleanString(firstRow[labelColumn]) : '';
  const filterSummary = formatAppAskVariables(input.variables);
  const resultTitle = cleanString(input.selected?.title)
    || cleanString(input.dashboard?.metadata.title)
    || input.app.name;
  const currentLine = currentValue !== null
    ? `${label ? `${label} is the leading visible row and ` : 'The current visible result '}shows ${formatMetricValue(currentValue)} for ${formatBusinessColumn(metricName)}${baselineValue !== null ? ` versus ${formatMetricValue(baselineValue)} for the next comparison` : ''}${deltaValue !== null ? `, a gap of ${formatMetricValue(deltaValue)}` : ''}.`
    : rows.length > 0
      ? `The certified result is loaded with ${rows.length} sampled row${rows.length === 1 ? '' : 's'} across ${columns.length} field${columns.length === 1 ? '' : 's'}.`
      : 'The certified saved query is selected, but this request did not include result rows for a numeric summary.';
  const rowDetails = firstRow && columns.length
    ? columns
      .slice(0, 5)
      .map((column) => `${formatBusinessColumn(column)}: ${formatAskValue(firstRow[column])}`)
      .join('; ')
    : '';
  const nextStep = /\bwhy|driver|change|changed|compare|segment|drill|root cause|because\b/i.test(input.question)
    ? 'This question asks for explanation beyond the current certified result. Use the copilot analysis flow with the exact comparison, timeframe, and segment so ZLens can create review-required analysis.'
    : 'Use deeper analysis only when you need a new grain, driver breakdown, segment comparison, or reusable saved query that this certified tile does not already cover.';

  return [
    `## Answer`,
    `For **${resultTitle}**${filterSummary ? ` with ${filterSummary}` : ''}, ${currentLine}`,
    rowDetails ? `Visible row detail: ${rowDetails}.` : '',
    `## Trusted source`,
    `This answer is grounded in certified saved query **${input.blockId}**. The app can present this result directly; new SQL or new business logic still needs review before promotion.`,
    `## Next step`,
    nextStep,
  ].filter(Boolean).join('\n\n');
}

function preferredLabelColumn(columns: string[], rows: Array<Record<string, unknown>>): string | undefined {
  return columns.find((column) => /\b(name|player|customer|account|team|segment|category|label)\b/i.test(column) && rows.some((row) => cleanString(row[column])))
    ?? columns.find((column) => rows.some((row) => typeof row[column] === 'string' && cleanString(row[column])));
}

function preferredMeasureColumn(columns: string[], rows: Array<Record<string, unknown>>): string | undefined {
  return columns.find((column) => /\b(total|points?|revenue|score|amount|count|games?|orders?|value|delta|change)\b/i.test(column) && rows.some((row) => typeofNumber(row[column]) !== null))
    ?? columns.find((column) => rows.some((row) => typeofNumber(row[column]) !== null));
}

function formatAppAskVariables(variables?: Record<string, unknown>): string {
  if (!variables) return '';
  return Object.entries(variables)
    .filter(([key, value]) => key !== 'smartView' && value !== undefined && value !== null && String(value).trim() !== '')
    .slice(0, 6)
    .map(([key, value]) => `${formatBusinessColumn(key)} ${formatAskVariableValue(key, value)}`)
    .join(', ');
}

function formatBusinessColumn(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatAskValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatAskValue).join(', ');
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString() : Number(value.toFixed(2)).toLocaleString();
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatAskVariableValue(key: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => formatAskVariableValue(key, item)).join(', ');
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : null;
  if (numeric !== null && /(season|year)/i.test(key) && Number.isInteger(numeric) && numeric >= 1900 && numeric <= 2200) {
    return String(numeric);
  }
  return formatAskValue(value);
}

export function recommendDashboardTile(
  projectRoot: string,
  appId: string,
  dashboardId: string,
  input: DashboardTileRecommendationRequest,
): { ok: true; display: DashboardDisplayMetadata; filterBindings: DashboardGridItem['filterBindings']; parameterBindings: DashboardGridItem['parameterBindings']; sourceEvidence: DashboardGridItem['sourceEvidence']; trustState: NonNullable<DashboardGridItem['trustState']>; reviewStatus: NonNullable<DashboardGridItem['reviewStatus']>; evidence: Array<{ source: string; reason: string }>; warnings: string[] } | { ok: false; error: string } {
  const loaded = loadDashboardForApp(projectRoot, appId, dashboardId);
  if (!loaded) return { ok: false, error: `Dashboard "${dashboardId}" not found in app "${appId}"` };
  const recommendation = recommendVisualization(projectRoot, input);
  if (!recommendation.ok) return recommendation;
  const block = input.blockRef
    ? collectBlockCandidates(projectRoot).find((candidate) =>
        candidate.id === input.blockRef ||
        candidate.name === input.blockRef ||
        candidate.path === input.blockRef ||
        candidate.path.endsWith(`/${input.blockRef}`),
      )
    : undefined;
  const filterBindings = block ? filterBindingsForBlockSource(projectRoot, block) : [];
  const parameterBindings = filterBindings
    .filter((entry) => entry.mode === 'parameter' && entry.paramNames?.length)
    .flatMap((entry) => (entry.paramNames ?? []).map((param) => ({ param, source: 'dashboard_filter' as const, filter: entry.filter, field: entry.binding })));
  const sourceEvidence = [
    ...recommendation.evidence.map((entry) => ({
      source: entry.source,
      reason: entry.reason,
      kind: entry.source === 'result_schema' ? 'result_schema' : 'metadata',
      trustState: recommendation.display.trustState,
    })),
    ...(block ? [{
      source: `block:${block.name}`,
      reason: block.status === 'certified' ? 'Certified saved query can back this app tile.' : 'Saved query is not certified; keep review-required.',
      kind: 'block',
      path: block.path,
      trustState: block.status === 'certified' ? 'certified' as const : 'review_required' as const,
    }] : []),
  ];
  return {
    ok: true,
    display: recommendation.display,
    filterBindings,
    parameterBindings,
    sourceEvidence,
    trustState: recommendation.display.trustState,
    reviewStatus: recommendation.display.reviewStatus,
    evidence: recommendation.evidence,
    warnings: recommendation.warnings,
  };
}

/**
 * Rename an App, and optionally a page inside it.
 *
 * `dql.app.json` previously had exactly two writers — create and publish — so
 * an App could never be renamed after it was built. Only the display `name`
 * changes here: the App **id** is also its folder name and is referenced by
 * notebooks, product context, and deep links, so renaming must not move it.
 *
 * The write is staged and swapped like the publish path, and guarded by the
 * caller-supplied fingerprint so a concurrent edit cannot be clobbered.
 */
export function renameApp(
  projectRoot: string,
  appId: string,
  input: { name?: string; pageTitle?: string; dashboardId?: string; expectedFingerprint?: string },
): { ok: true; app: AppDocument; paths: string[] } | { ok: false; error: string; code?: string } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found`, code: 'APP_NOT_FOUND' };
  if (input.expectedFingerprint && fingerprintAppDirectory(loaded.appDir) !== input.expectedFingerprint) {
    return { ok: false, error: 'This App changed since it was loaded. Refresh and rename again.', code: 'APP_CHANGED' };
  }

  const name = cleanString(input.name);
  const pageTitle = cleanString(input.pageTitle);
  if (!name && !pageTitle) return { ok: false, error: 'Provide a name or a pageTitle.', code: 'INVALID_REQUEST' };

  const appPath = join(loaded.appDir, 'dql.app.json');
  const parsedApp = parseAppDocument(JSON.stringify({ ...loaded.app, ...(name ? { name } : {}) }), appPath);
  if (!parsedApp.document) return { ok: false, error: parsedApp.errors.map((err) => err.message).join('; ') };

  const renamedDashboards: Array<{ sourcePath: string; document: DashboardDocument }> = [];
  if (pageTitle) {
    const homepage = loaded.app.homepage;
    const dashboardId = cleanString(input.dashboardId)
      || (homepage?.type === 'dashboard' ? homepage.id : undefined);
    const source = findDashboardsForApp(loaded.appDir)
      .map((path) => ({ path, document: loadDashboardDocument(path).document }))
      .find((item) => item.document && (!dashboardId || item.document.id === dashboardId));
    if (!source?.document) return { ok: false, error: `Dashboard "${dashboardId ?? ''}" not found in app "${appId}"`, code: 'DASHBOARD_NOT_FOUND' };
    const next = { ...source.document, metadata: { ...source.document.metadata, title: pageTitle } };
    const parsed = parseDashboardDocument(JSON.stringify(next), source.path);
    if (!parsed.document) return { ok: false, error: parsed.errors.map((err) => err.message).join('; ') };
    renamedDashboards.push({ sourcePath: source.path, document: parsed.document });
  }

  const stagingBase = join(projectRoot, '.dql', 'local', 'app-rename-staging');
  const stagedAppDir = join(stagingBase, `${appId}-next`);
  const backupAppDir = join(stagingBase, `${appId}-backup`);
  rmSync(stagedAppDir, { recursive: true, force: true });
  rmSync(backupAppDir, { recursive: true, force: true });
  mkdirSync(stagingBase, { recursive: true });
  cpSync(loaded.appDir, stagedAppDir, { recursive: true });
  writeFileSync(join(stagedAppDir, 'dql.app.json'), JSON.stringify(parsedApp.document, null, 2) + '\n', 'utf-8');
  for (const dashboard of renamedDashboards) {
    writeFileSync(
      join(stagedAppDir, relative(loaded.appDir, dashboard.sourcePath)),
      JSON.stringify(dashboard.document, null, 2) + '\n',
      'utf-8',
    );
  }
  try {
    renameSync(loaded.appDir, backupAppDir);
    renameSync(stagedAppDir, loaded.appDir);
    rmSync(backupAppDir, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(backupAppDir) && !existsSync(loaded.appDir)) renameSync(backupAppDir, loaded.appDir);
    throw error;
  }
  return {
    ok: true,
    app: parsedApp.document,
    paths: [relative(projectRoot, appPath), ...renamedDashboards.map((item) => relative(projectRoot, item.sourcePath))],
  };
}

/**
 * Set who an App is for (RFC 0010, HH-16): the identity-provider groups in
 * `audienceGroups`, and optionally the audience in words. Only those two
 * fields of `dql.app.json` change; everything else is kept as written. With a
 * host that follows git, this runs in a private workspace and reaches Production
 * through review like any other change.
 */
export function setAppAudience(
  projectRoot: string,
  appId: string,
  input: { groups?: unknown; text?: unknown; allowedGroups?: ReadonlySet<string> },
): { ok: true; app: AppDocument; path: string } | { ok: false; error: string; code?: string } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found`, code: 'APP_NOT_FOUND' };
  if (!Array.isArray(input.groups) || input.groups.some((group) => typeof group !== 'string')) return { ok: false, error: 'groups must be a list of group names.', code: 'INVALID_REQUEST' };
  const groups = [...new Set((input.groups as string[]).map((group) => group.trim()).filter(Boolean))];
  if (groups.length > 20) return { ok: false, error: 'An App can name at most 20 audience groups.', code: 'INVALID_REQUEST' };
  const bad = groups.find((group) => group.length > 120 || /[\u0000-\u001f]/.test(group));
  if (bad !== undefined) return { ok: false, error: 'A group name is too long or has control characters.', code: 'INVALID_REQUEST' };
  if (input.allowedGroups) {
    const unknown = groups.filter((group) => !input.allowedGroups!.has(group));
    if (unknown.length) return { ok: false, error: `Not a group in your directory: ${unknown.join(', ')}.`, code: 'UNKNOWN_GROUP' };
  }
  const text = input.text === undefined ? undefined : typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ').trim().slice(0, 120) : null;
  if (text === null) return { ok: false, error: 'text must be words.', code: 'INVALID_REQUEST' };
  const appPath = join(loaded.appDir, 'dql.app.json');
  const raw = JSON.parse(readFileSync(appPath, 'utf-8')) as Record<string, unknown>;
  if (groups.length) raw.audienceGroups = groups;
  else delete raw.audienceGroups;
  if (text !== undefined) {
    if (text) raw.audience = text;
    else delete raw.audience;
  }
  const next = `${JSON.stringify(raw, null, 2)}\n`;
  const parsed = parseAppDocument(next, appPath);
  if (!parsed.document) return { ok: false, error: parsed.errors.map((error) => error.message).join('; ') };
  const temp = `${appPath}.${process.pid}.tmp`;
  writeFileSync(temp, next, 'utf-8');
  renameSync(temp, appPath);
  return { ok: true, app: parsed.document, path: relative(projectRoot, appPath) };
}

export function promoteAppForStakeholders(
  projectRoot: string,
  appId: string,
  input: AppPromoteRequest = {},
): { ok: true; app: AppDocument; paths: string[]; removedLocalTiles: number; readiness: AppPublicationReadiness } | { ok: false; error: string; readiness?: AppPublicationReadiness } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const dashboardSources = findDashboardsForApp(loaded.appDir)
    .map((path) => ({ path, document: loadDashboardDocument(path).document }))
    .filter((item): item is { path: string; document: DashboardDocument } => Boolean(item.document));
  const readiness = appPublicationReadiness(projectRoot, dashboardSources.map((item) => item.document));
  if (!readiness.ready) {
    return {
      ok: false,
      error: `App is not ready for shared publication: ${readiness.blockers.map((blocker) => blocker.message).join('; ')}`,
      readiness,
    };
  }
  const lifecycle = input.lifecycle === 'certified' || input.lifecycle === 'deprecated' ? input.lifecycle : 'review';
  const { certifiedBy: _priorCertifiedBy, certifiedAt: _priorCertifiedAt, ...withoutCertifier } = loaded.app;
  const app: AppDocument = {
    ...withoutCertifier,
    visibility: 'shared',
    publicationIntent: 'shared_project',
    lifecycle,
    // Certifying records who did it and when; any other lifecycle drops the record.
    ...(lifecycle === 'certified'
      ? { certifiedBy: appCertifierName(projectRoot, hostActor() ?? loaded.app.owners[0] ?? 'local'), certifiedAt: new Date().toISOString() }
      : {}),
  };
  const appPath = join(loaded.appDir, 'dql.app.json');
  const parsedApp = parseAppDocument(JSON.stringify(app), appPath);
  if (!parsedApp.document) return { ok: false, error: parsedApp.errors.map((err) => err.message).join('; ') };

  let removedLocalTiles = 0;
  const dashboards: Array<{ sourcePath: string; document: DashboardDocument }> = [];
  for (const source of dashboardSources) {
    const items = source.document.layout.items
      .filter((item) => {
        if (item.aiPin) {
          removedLocalTiles += 1;
          return false;
        }
        return true;
      })
      .map((item) => promoteSharedDashboardItem(item));
    const dashboard: DashboardDocument = {
      ...source.document,
      metadata: {
        ...source.document.metadata,
        visibility: 'shared',
        lifecycle,
      },
      layout: {
        ...source.document.layout,
        items,
      },
    };
    const parsed = parseDashboardDocument(JSON.stringify(dashboard), source.path);
    if (!parsed.document) return { ok: false, error: parsed.errors.map((err) => err.message).join('; ') };
    dashboards.push({ sourcePath: source.path, document: parsed.document });
  }

  // Stage and swap the whole App directory so validation or write failures do
  // not leave a partially published manifest/dashboard set.
  const stagingBase = join(projectRoot, '.dql', 'local', 'app-publish-staging');
  const stagedAppDir = join(stagingBase, `${appId}-next`);
  const backupAppDir = join(stagingBase, `${appId}-backup`);
  rmSync(stagedAppDir, { recursive: true, force: true });
  rmSync(backupAppDir, { recursive: true, force: true });
  mkdirSync(stagingBase, { recursive: true });
  cpSync(loaded.appDir, stagedAppDir, { recursive: true });
  writeFileSync(join(stagedAppDir, 'dql.app.json'), JSON.stringify(parsedApp.document, null, 2) + '\n', 'utf-8');
  for (const dashboard of dashboards) {
    const stagedPath = join(stagedAppDir, relative(loaded.appDir, dashboard.sourcePath));
    writeFileSync(stagedPath, JSON.stringify(dashboard.document, null, 2) + '\n', 'utf-8');
  }
  try {
    renameSync(loaded.appDir, backupAppDir);
    renameSync(stagedAppDir, loaded.appDir);
    rmSync(backupAppDir, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(backupAppDir) && !existsSync(loaded.appDir)) renameSync(backupAppDir, loaded.appDir);
    throw error;
  }
  const paths = [relative(projectRoot, appPath), ...dashboards.map((dashboard) => relative(projectRoot, dashboard.sourcePath))];
  return { ok: true, app: parsedApp.document, paths, removedLocalTiles, readiness };
}

export interface AppPublicationReadiness {
  ready: boolean;
  governedTiles: number;
  blockers: Array<{ dashboardId: string; tileId: string; code: 'exploratory_source' | 'semantic_review' | 'semantic_preflight' | 'block_not_certified' | 'block_missing' | 'block_source_unversioned' | 'block_source_changed' | 'filter_not_preflighted' | 'dataset_binding_missing'; message: string }>;
}

export function approveAppSemanticTiles(
  projectRoot: string,
  appId: string,
  dashboardId: string,
  input: {
    tileIds: string[];
    runId: string;
    snapshotId: string;
    expectedDashboardFingerprint: string;
    reviewer: string;
  },
): { ok: true; dashboard: DashboardDocument; path: string } | { ok: false; error: string } {
  const loaded = loadDashboardForApp(projectRoot, appId, dashboardId);
  if (!loaded) return { ok: false, error: `Dashboard "${dashboardId}" not found in App "${appId}".` };
  const currentFingerprint = `sha256:${createHash('sha256').update(JSON.stringify(loaded.dashboard)).digest('hex')}`;
  if (!input.expectedDashboardFingerprint || input.expectedDashboardFingerprint !== currentFingerprint) {
    return { ok: false, error: 'The dashboard changed after the reviewed run. Run it again before approval.' };
  }
  const selected = new Set(input.tileIds);
  const semanticIds = new Set(loaded.dashboard.layout.items.filter((item) => item.semantic).map((item) => item.i));
  const invalid = input.tileIds.filter((tileId) => !semanticIds.has(tileId));
  if (invalid.length > 0) return { ok: false, error: `Only semantic tiles can be approved here: ${invalid.join(', ')}` };
  const reviewedAt = new Date().toISOString();
  const dashboard: DashboardDocument = {
    ...loaded.dashboard,
    layout: {
      ...loaded.dashboard.layout,
      items: loaded.dashboard.layout.items.map((item) => {
        if (!selected.has(item.i) || !item.semantic) return item;
        return {
          ...item,
          semantic: { ...item.semantic, snapshotId: input.snapshotId },
          review: {
            status: 'approved',
            sourceFingerprint: item.semantic.definitionFingerprint,
            preflightReceiptId: input.runId,
            reviewedAt,
            reviewedBy: input.reviewer,
          },
          trustState: 'review_required',
          reviewStatus: 'review_required',
        };
      }),
    },
  };
  const parsed = parseDashboardDocument(JSON.stringify(dashboard), loaded.path);
  if (!parsed.document) return { ok: false, error: parsed.errors.map((error) => error.message).join('; ') };
  writeFileSync(loaded.path, JSON.stringify(parsed.document, null, 2) + '\n', 'utf-8');
  return { ok: true, dashboard: parsed.document, path: relative(projectRoot, loaded.path) };
}

function appPublicationReadiness(
  projectRoot: string,
  dashboards: DashboardDocument[],
  options: { settledPageIds?: Set<string>; settings?: AppsPublishSettings } = {},
): AppPublicationReadiness {
  const blockers: AppPublicationReadiness['blockers'] = [];
  // A saved query nobody certified blocks only when the project requires certified data (T3).
  const requireCertified = (options.settings ?? readAppsPublishSettings(projectRoot)).requireCertifiedToPublish;
  let governedTiles = 0;
  const blocks = collectBlockCandidates(projectRoot, { preserveDuplicates: true });
  for (const dashboard of dashboards) {
    for (const item of dashboard.layout.items) {
      if (item.block) {
        governedTiles += 1;
        const blockRef = item.block;
        const boundRevision = item.sourceRevision ?? item.review?.sourceFingerprint;
        // A name can be declared by more than one file (a draft saved beside a
        // certified block, or an older copy that kept the same name). A name
        // resolves to the certified declaration first; a path names exactly one file.
        const block = 'blockId' in blockRef
          ? (() => {
              const named = blocks.filter((candidate) => candidate.id === blockRef.blockId || candidate.name === blockRef.blockId);
              return named.find((candidate) => candidate.status === 'certified') ?? named[0];
            })()
          : blocks.find((candidate) => candidate.path === blockRef.ref);
        if (block?.status === 'deprecated') {
          // A retired block is never certified for a new publish; name what replaces it.
          const replacement = resolveBlockReplacement(blocks.map((candidate) => ({ ...candidate, filePath: candidate.path })), { ...block, filePath: block.path })?.replacement;
          blockers.push({
            dashboardId: dashboard.id,
            tileId: item.i,
            code: 'block_not_certified',
            message: `${dashboard.id}/${item.i} uses retired saved query ${block.name}${replacement ? `, replaced by ${replacement.name}` : ''}; it no longer resolves to a certified saved query.`,
          });
        } else if (!block) {
          blockers.push({
            dashboardId: dashboard.id,
            tileId: item.i,
            code: 'block_missing',
            message: `${dashboard.id}/${item.i} no longer resolves to a saved query in the project.`,
          });
        } else if (block.status !== 'certified' && requireCertified) {
          blockers.push({
            dashboardId: dashboard.id,
            tileId: item.i,
            code: 'block_not_certified',
            message: `${dashboard.id}/${item.i} uses a saved query that is not certified yet, and this project requires certified data to publish.`,
          });
        } else if (!boundRevision) {
          blockers.push({
            dashboardId: dashboard.id,
            tileId: item.i,
            code: 'block_source_unversioned',
            message: `${dashboard.id}/${item.i} has no bound source revision; refresh the saved query before publication.`,
          });
        } else if (boundRevision !== block.fingerprint) {
          blockers.push({
            dashboardId: dashboard.id,
            tileId: item.i,
            code: 'block_source_changed',
            message: `${dashboard.id}/${item.i} changed after it was selected; refresh the saved query before publication.`,
          });
        }
      }
      if (item.draftAnalysis) {
        blockers.push({
          dashboardId: dashboard.id,
          tileId: item.i,
          code: 'exploratory_source',
          message: `${dashboard.id}/${item.i} references app-scoped exploratory DQL; promote it to governed semantic logic or a certified saved query first.`,
        });
      }
      if (item.semantic) {
        governedTiles += 1;
        if (item.review?.status !== 'approved') {
          blockers.push({
            dashboardId: dashboard.id,
            tileId: item.i,
            code: 'semantic_review',
            message: `${dashboard.id}/${item.i} semantic result has not been explicitly approved.`,
          });
        }
        if (!item.semantic.snapshotId || !item.review?.preflightReceiptId) {
          blockers.push({
            dashboardId: dashboard.id,
            tileId: item.i,
            code: 'semantic_preflight',
            message: `${dashboard.id}/${item.i} needs a snapshot-bound semantic preflight receipt.`,
          });
        }
      }
      if (item.query) {
        governedTiles += 1;
        const datasetBinding = dashboard.datasets?.find((binding) => binding.sourceId === item.sourceId
          && binding.sourceRevision === item.sourceRevision);
        if (!datasetBinding) {
          blockers.push({
            dashboardId: dashboard.id,
            tileId: item.i,
            code: 'dataset_binding_missing',
            message: `${dashboard.id}/${item.i} has no matching Dataset binding for its field query.`,
          });
        }
      }
      if ((dashboard.version === 2 || dashboard.version === 3) && (item.block || item.semantic || item.draftAnalysis)) {
        for (const filter of dashboard.filters ?? []) {
          // Each tile needs an author choice for each page filter: "Applies"
          // (a link) or "Does not apply" (an explicit, stored exclusion such
          // as a filterBinding with capability 'unsupported'). "Does not
          // apply" is resolved: readers see "Not filtered by …" on the tile.
          // Only a tile with neither blocks publication.
          const { choice } = dashboardTileFilterChoice(dashboard, item, filter);
          if (choice === 'does_not_apply' || choice === 'not_applicable') continue;
          const label = filter.label ?? filter.id;
          if (choice === 'unlinked') {
            blockers.push({
              dashboardId: dashboard.id,
              tileId: item.i,
              code: 'filter_not_preflighted',
              message: `${dashboard.id}/${item.i} has no choice for filter ${label}. Open the Filters tab and set this tile to Applies or Does not apply.`,
            });
            continue;
          }
          const binding = item.filterBindings?.find((candidate) => candidate.filter === filter.id);
          const settled = options.settledPageIds?.has(dashboard.id) ?? false;
          if (binding?.capability === 'preflight_required' && !settled) {
            blockers.push({
              dashboardId: dashboard.id,
              tileId: item.i,
              code: 'filter_not_preflighted',
              message: `${dashboard.id}/${item.i} does not have a preflighted binding for filter ${label}.`,
            });
          }
        }
      }
    }
  }
  return { ready: blockers.length === 0, governedTiles, blockers };
}

/** One published App's tiles as `zlens app check` reports them: what each reads and whether it can publish. */
export interface AppPublicationCheck {
  app: { id: string; title: string; domain: string };
  ready: boolean;
  governedTiles: number;
  pages: Array<{
    id: string;
    title: string;
    tiles: Array<{ id: string; title: string | null; source: 'block' | 'semantic' | 'dataset' | 'exploratory' | 'content'; check: 'passes' | 'fails' | 'none'; problems: string[] }>;
  }>;
  /** Publication's blockers, plus a page file that doesn't load (`page_invalid`). */
  blockers: Array<Omit<AppPublicationReadiness['blockers'][number], 'code'> & { code: AppPublicationReadiness['blockers'][number]['code'] | 'page_invalid' }>;
}

/** The same checks publication runs, for an App already in the project (RFC 0010 hosts and CI). */
export function checkAppPublication(projectRoot: string, appId: string): AppPublicationCheck | null {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return null;
  const dashboards: DashboardDocument[] = [];
  const unreadable: AppPublicationCheck['blockers'] = [];
  for (const path of findDashboardsForApp(loaded.appDir)) {
    const { document, errors } = loadDashboardDocument(path);
    if (document) dashboards.push(document);
    else {
      // A page that doesn't load would not publish either; never skip it silently.
      const file = relative(projectRoot, path);
      const pageId = basename(path).replace(/\.dqld$/, '');
      unreadable.push({ dashboardId: pageId, tileId: '', code: 'page_invalid', message: `${file} does not load: ${(errors ?? []).map((error) => error.message).slice(0, 3).join('; ') || 'unknown error'}` });
    }
  }
  const readiness = appPublicationReadiness(projectRoot, dashboards);
  return {
    app: { id: loaded.app.id, title: loaded.app.name ?? loaded.app.id, domain: loaded.app.domain },
    ready: readiness.ready && unreadable.length === 0,
    governedTiles: readiness.governedTiles,
    pages: dashboards.map((dashboard) => ({
      id: dashboard.id,
      title: dashboard.metadata.title,
      tiles: dashboard.layout.items.map((item) => {
        const problems = readiness.blockers.filter((blocker) => blocker.dashboardId === dashboard.id && blocker.tileId === item.i).map((blocker) => blocker.message);
        const source = item.draftAnalysis ? 'exploratory' : item.block ? 'block' : item.semantic ? 'semantic' : item.query ? 'dataset' : 'content';
        return {
          id: item.i,
          title: typeof item.title === 'string' ? item.title : null,
          source,
          check: source === 'content' ? 'none' : problems.length ? 'fails' : 'passes',
          problems,
        } as AppPublicationCheck['pages'][number]['tiles'][number];
      }),
    })),
    blockers: [...unreadable, ...readiness.blockers],
  };
}

function appAiBuildSessionDir(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'app-ai-builds');
}

function appBuildDraftDir(projectRoot: string): string {
  // Read-only migration location for AppBuildDraft v1 JSON files. New drafts
  // are persisted transactionally in .dql/local/apps.sqlite.
  return join(projectRoot, '.dql', 'local', 'app-builds');
}

function appBuildProposalDir(projectRoot: string, draftId: string): string {
  return join(appBuildDraftDir(projectRoot), draftId, 'proposals');
}

function writeAppBuildDraftAiProposal(projectRoot: string, proposal: AppBuildDraftAiProposal): void {
  if (!/^[a-z0-9_:-]+$/i.test(proposal.draftId) || !/^[a-z0-9_:-]+$/i.test(proposal.id)) {
    throw new Error('APP_BUILD_PROPOSAL_INVALID: proposal identity is invalid.');
  }
  const dir = appBuildProposalDir(projectRoot, proposal.draftId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${proposal.id}.json`);
  const candidate = `${path}.candidate`;
  writeFileSync(candidate, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  renameSync(candidate, path);
}

function loadAppBuildDraftAiProposal(
  projectRoot: string,
  draftId: string,
  proposalId: string,
): AppBuildDraftAiProposal | null {
  if (!/^[a-z0-9_:-]+$/i.test(draftId) || !/^[a-z0-9_:-]+$/i.test(proposalId)) return null;
  const path = join(appBuildProposalDir(projectRoot, draftId), `${proposalId}.json`);
  if (!existsSync(path)) return null;
  try {
    const proposal = JSON.parse(readFileSync(path, 'utf8')) as AppBuildDraftAiProposal;
    return proposal.draftId === draftId && proposal.id === proposalId ? proposal : null;
  } catch {
    return null;
  }
}

const APP_AUTOPILOT_ACTIONS = new Set<AppAutopilotAction>([
  'group_tile', 'change_visualization', 'rename_tile', 'add_tile', 'remove_tile',
  'add_page', 'remove_page', 'add_filter', 'remove_filter', 'map_filter',
  'add_cross_filter', 'add_navigation', 'add_detail_drill', 'arrange_layout',
]);

function appAutopilotKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '');
}

function appAutopilotText(value: unknown, label: string, maximum = 160): string | undefined {
  if (value === undefined) return undefined;
  const text = cleanString(value);
  if (!text || text.length > maximum
    || /(?:;|--|\/\*|\*\/)|^\s*(?:select|with|insert|update|delete|drop|alter|create)\b/i.test(text)) {
    throw new Error(`APP_AUTOPILOT_INTENT_INVALID: ${label} must be a short App identifier or presentation label, never SQL.`);
  }
  return text;
}

function normalizeAppAutopilotIntent(input: AppAutopilotIntent): AppAutopilotIntent {
  const action = input?.action;
  if (!APP_AUTOPILOT_ACTIONS.has(action)) {
    throw new Error('APP_AUTOPILOT_INTENT_INVALID: the provider requested an unsupported App action.');
  }
  const request = appAutopilotText(input.request, 'request', 600);
  if (!request) throw new Error('APP_AUTOPILOT_INTENT_INVALID: the App request is required.');
  const visualization = input.visualization;
  const allowedVisualizations: DashboardGridItem['viz']['type'][] = [
    'single_value', 'grouped_bar', 'stacked_bar', 'line', 'bar', 'area', 'pie', 'donut',
    'scatter', 'heatmap', 'histogram', 'waterfall', 'gauge', 'table', 'pivot', 'map',
    'funnel', 'sankey', 'kpi',
  ];
  if (visualization !== undefined && !allowedVisualizations.includes(visualization)) {
    throw new Error('APP_AUTOPILOT_INTENT_INVALID: choose one supported Dataset visualization.');
  }
  if (input.scope !== undefined && input.scope !== 'page' && input.scope !== 'app') {
    throw new Error('APP_AUTOPILOT_INTENT_INVALID: filter scope must be page or app.');
  }
  return {
    action,
    request,
    ...(appAutopilotText(input.summary, 'summary', 600) ? { summary: appAutopilotText(input.summary, 'summary', 600) } : {}),
    ...(appAutopilotText(input.field, 'field') ? { field: appAutopilotText(input.field, 'field') } : {}),
    ...(appAutopilotText(input.measure, 'measure') ? { measure: appAutopilotText(input.measure, 'measure') } : {}),
    ...(visualization ? { visualization } : {}),
    ...(appAutopilotText(input.title, 'title', 120) ? { title: appAutopilotText(input.title, 'title', 120) } : {}),
    ...(appAutopilotText(input.targetField, 'target field') ? { targetField: appAutopilotText(input.targetField, 'target field') } : {}),
    ...(appAutopilotText(input.targetPageId, 'target page') ? { targetPageId: appAutopilotText(input.targetPageId, 'target page') } : {}),
    ...(appAutopilotText(input.targetTileId, 'target tile') ? { targetTileId: appAutopilotText(input.targetTileId, 'target tile') } : {}),
    ...(appAutopilotText(input.filterId, 'filter') ? { filterId: appAutopilotText(input.filterId, 'filter') } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
  };
}

function appAutopilotExactPhysicalField(
  descriptor: DatasetDescriptor,
  requested: string | undefined,
  roles?: DatasetPhysicalField['role'][],
): DatasetPhysicalField {
  const value = appAutopilotText(requested, 'field');
  if (!value) throw new Error('APP_AUTOPILOT_FIELD_REQUIRED: choose one exact approved Dataset field.');
  const requestedKey = appAutopilotKey(value);
  const matches = descriptor.fields.filter((field): field is DatasetPhysicalField => field.kind === 'physical'
    && field.status === 'approved'
    && (!roles || roles.includes(field.role)))
    .filter((field) => {
      const qualifiedTail = field.qualifiedId.split(/[.:/]/).at(-1) ?? field.qualifiedId;
      return [field.name, field.qualifiedId, qualifiedTail].some((candidate) => appAutopilotKey(candidate) === requestedKey);
    });
  if (matches.length !== 1) {
    throw new Error(`APP_AUTOPILOT_FIELD_UNAVAILABLE: ${value} is not one exact approved field for this Dataset tile.`);
  }
  return matches[0]!;
}

function appAutopilotExactMeasure(descriptor: DatasetDescriptor, requested: string | undefined) {
  const value = appAutopilotText(requested, 'measure');
  if (!value) throw new Error('APP_AUTOPILOT_MEASURE_REQUIRED: choose one exact approved Dataset measure.');
  const requestedKey = appAutopilotKey(value);
  const matches = descriptor.fields.filter((field) => field.kind === 'measure' && field.status === 'approved')
    .filter((field) => {
      const qualifiedTail = field.qualifiedId.split(/[.:/]/).at(-1) ?? field.qualifiedId;
      return [field.name, field.qualifiedId, qualifiedTail].some((candidate) => appAutopilotKey(candidate) === requestedKey);
    });
  if (matches.length !== 1) {
    throw new Error(`APP_AUTOPILOT_MEASURE_UNAVAILABLE: ${value} is not one exact approved Dataset measure for this tile.`);
  }
  return matches[0]!;
}

function appAutopilotRequestedDatasetDimension(
  descriptor: DatasetDescriptor,
  requested: string | undefined,
): { field: DatasetPhysicalField; timeGrain?: string } {
  const field = appAutopilotExactPhysicalField(descriptor, requested, ['dimension', 'attribute', 'time']);
  const timeGrain = field.role === 'time'
    ? field.time?.baseGrain ?? field.time?.grains[0]
    : undefined;
  return { field, ...(timeGrain ? { timeGrain } : {}) };
}

function appAutopilotDisplayName(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function appAutopilotProposalHash(
  proposal: Omit<AppAutopilotChangeProposal, 'proposalHash' | 'appliedAt' | 'appliedRevision'>,
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(proposal)).digest('hex')}`;
}

function assertStoredAppAutopilotChange(proposal: AppAutopilotChangeProposal): void {
  if (proposal.version !== 1
    || !/^[a-z0-9_:-]+$/i.test(proposal.id)
    || !/^[a-z0-9_:-]+$/i.test(proposal.runId)
    || !/^[a-z0-9_:-]+$/i.test(proposal.artifactId)
    || !/^[a-z0-9_:-]+$/i.test(proposal.draftId)
    || !cleanString(proposal.pageId)
    || !cleanString(proposal.tileId)
    || !cleanString(proposal.request)
    || !proposal.source
    || !cleanString(proposal.source.sourceId)
    || !cleanString(proposal.source.sourceRevision)
    || !cleanString(proposal.source.contractFingerprint)
    || proposal.planningMode !== 'universal_agent'
    || !Array.isArray(proposal.operations)
    || proposal.operations.length === 0
    || proposal.operations.length > 12) {
    throw new Error('APP_AUTOPILOT_CHANGE_INVALID: the stored App Autopilot change is malformed. Ask App Autopilot to prepare it again.');
  }
  const intent = normalizeAppAutopilotIntent(proposal.intent);
  if (intent.action !== proposal.intent.action) {
    throw new Error('APP_AUTOPILOT_CHANGE_INVALID: the stored App Autopilot intent is not normalized.');
  }
  const allowedTypes = new Set<AppBuildDraftOperation['type']>([
    'update_tile', 'add_tile', 'remove_tile', 'upsert_page', 'remove_page',
    'set_filter', 'remove_filter', 'set_interactions', 'set_layout',
  ]);
  for (const operation of proposal.operations) {
    if (!operation || !allowedTypes.has(operation.type)) {
      throw new Error('APP_AUTOPILOT_CHANGE_INVALID: the stored App Autopilot change includes an operation outside the bounded App editing lane.');
    }
    if (operation.type === 'update_tile') {
      const allowedPatch = new Set(['query', 'viz', 'title', 'x', 'y', 'w', 'h', 'sectionId']);
      if (Object.keys(operation.patch).some((key) => !allowedPatch.has(key))) {
        throw new Error('APP_AUTOPILOT_CHANGE_INVALID: an App Autopilot tile update includes a forbidden source or execution field.');
      }
    }
    if (operation.type === 'add_tile' && (!operation.tile.query || operation.tile.sourceId !== proposal.source.sourceId)) {
      throw new Error('APP_AUTOPILOT_CHANGE_INVALID: an App Autopilot tile must be a field query over the selected Dataset source.');
    }
  }
  const { proposalHash: _proposalHash, appliedAt: _appliedAt, appliedRevision: _appliedRevision, ...withoutHash } = proposal;
  if (proposal.proposalHash !== appAutopilotProposalHash(withoutHash)) {
    throw new Error('APP_AUTOPILOT_CHANGE_INVALID: the stored App Autopilot change no longer matches its immutable hash.');
  }
}

async function assertAppAutopilotChangeDatasetSourceCurrent(
  projectRoot: string,
  current: AppBuildDraft,
  proposal: AppAutopilotChangeProposal,
  resolver?: Ctx['resolveDatasetSourceAuthority'],
): Promise<{ tile: DashboardGridItem; descriptor: DatasetDescriptor }> {
  assertStoredAppAutopilotChange(proposal);
  const page = current.pages.find((candidate) => candidate.id === proposal.pageId);
  const tile = page?.layout.items.find((candidate) => candidate.i === proposal.tileId);
  if (!page || !tile || !tile.query || !tile.sourceId || tile.sourceId !== proposal.source.sourceId) {
    throw new Error('APP_AUTOPILOT_CHANGE_STALE: the selected Dataset tile changed or was removed. Ask App Autopilot to prepare it again.');
  }
  const stored = current.sources.find((source) => source.id === proposal.source.sourceId);
  const records = await resolveCurrentDatasetSourceRecords(projectRoot, [proposal.source.sourceId], resolver);
  const source = records.get(proposal.source.sourceId);
  const descriptor = source?.capabilities.dataset;
  const reference = datasetDraftReferences(current).find((candidate) => candidate.page.id === page.id && candidate.tile.i === tile.i);
  const authorityIssue = reference ? datasetDraftAuthorityIssue(reference, stored, source) : 'APP_BUILD_DATASET_SOURCE_REPAIR_REQUIRED: this Dataset tile no longer has an exact page binding.';
  if (authorityIssue || !descriptor
    || source!.sourceRevision !== proposal.source.sourceRevision
    || descriptor.contractRef.fingerprint !== proposal.source.contractFingerprint
    || descriptor.binding.sourceRevision !== proposal.source.sourceRevision
    || descriptor.binding.contractFingerprint !== proposal.source.contractFingerprint) {
    throw new Error(`APP_AUTOPILOT_CHANGE_STALE: ${authorityIssue ?? 'the Dataset revision or contract changed after this App Autopilot review.'} Ask App Autopilot to prepare it again.`);
  }
  return { tile, descriptor };
}

function appAutopilotDatasetBinding(page: DashboardDocument, tile: DashboardGridItem): DashboardDatasetBinding {
  const binding = page.datasets?.find((candidate) => candidate.sourceId === tile.sourceId
    && candidate.sourceRevision === tile.sourceRevision);
  if (!binding) {
    throw new Error('APP_AUTOPILOT_DATASET_BINDING_REQUIRED: the selected tile no longer has an exact current Dataset page binding.');
  }
  return binding;
}

function datasetFieldFilterType(field: DatasetPhysicalField): DashboardFilter['type'] {
  if (field.type === 'date' || field.type === 'timestamp') return 'daterange';
  if (field.type === 'number') return 'number_range';
  if (field.type === 'boolean') return 'boolean';
  return 'select';
}

function appAutopilotPageId(title: string, pages: DashboardDocument[]): string {
  const base = slugify(title) || 'page';
  if (!pages.some((page) => page.id === base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!pages.some((page) => page.id === candidate)) return candidate;
  }
  throw new Error('APP_AUTOPILOT_PAGE_LIMIT: App Autopilot could not allocate a unique page id.');
}

function appAutopilotTargetPage(draft: AppBuildDraft, requested: string | undefined): DashboardDocument {
  const target = appAutopilotText(requested, 'target page');
  if (!target) throw new Error('APP_AUTOPILOT_TARGET_PAGE_REQUIRED: choose one exact existing App page id.');
  const matches = draft.pages.filter((page) => page.id === target);
  if (matches.length !== 1) {
    throw new Error(`APP_AUTOPILOT_TARGET_PAGE_UNAVAILABLE: ${target} is not one exact existing App page id.`);
  }
  return matches[0]!;
}

function appAutopilotTargetTile(page: DashboardDocument, requested: string | undefined): DashboardGridItem {
  const target = appAutopilotText(requested, 'target tile');
  if (!target) throw new Error('APP_AUTOPILOT_TARGET_TILE_REQUIRED: choose one exact current-page Dataset tile id.');
  const matches = page.layout.items.filter((tile) => tile.i === target);
  if (matches.length !== 1 || !matches[0]!.query || !matches[0]!.sourceId) {
    throw new Error(`APP_AUTOPILOT_TARGET_TILE_UNAVAILABLE: ${target} is not one exact current-page Dataset tile id.`);
  }
  return matches[0]!;
}

function appAutopilotCleanInteractions(interactions: DashboardInteractions): DashboardInteractions | undefined {
  const crossFilter = interactions.crossFilter && interactions.crossFilter.mappings.length > 0
    ? interactions.crossFilter
    : undefined;
  const detail = interactions.detail;
  const navigate = interactions.navigate?.filter((candidate) => candidate.fromTile && candidate.toPage);
  return crossFilter || detail || (navigate && navigate.length > 0)
    ? {
      ...(crossFilter ? { crossFilter } : {}),
      ...(detail ? { detail } : {}),
      ...(navigate && navigate.length > 0 ? { navigate } : {}),
    }
    : undefined;
}

function appAutopilotOutputDimension(tile: DashboardGridItem, requested: string | undefined): string {
  const value = appAutopilotText(requested, 'field');
  if (!value || !tile.query) throw new Error('APP_AUTOPILOT_FIELD_REQUIRED: choose one exact selected Dataset output field.');
  const key = appAutopilotKey(value);
  const matches = tileQueryOutputAliases(tile.query)
    .filter((output) => output.kind === 'dimension' && appAutopilotKey(output.alias) === key);
  if (matches.length !== 1) {
    throw new Error(`APP_AUTOPILOT_OUTPUT_UNAVAILABLE: ${value} is not one exact dimension output on the selected tile.`);
  }
  return matches[0]!.alias;
}

function appAutopilotUniqueFilterId(page: DashboardDocument, requested: string | undefined, field: DatasetPhysicalField): string {
  const raw = appAutopilotText(requested, 'filter id') ?? `filter-${slugify(field.name)}`;
  const id = slugify(raw) || `filter-${slugify(field.name)}`;
  if (page.filters?.some((filter) => filter.id === id)) {
    throw new Error(`APP_AUTOPILOT_FILTER_EXISTS: ${id} already exists on this page. Choose its exact id to map or remove it.`);
  }
  return id;
}

/**
 * Compile a provider-interpreted but untrusted App intent into a small set of
 * server-owned AppBuildDraft operations. This is intentionally the only
 * mutation boundary for the universal sidebar: the provider never writes SQL,
 * a Dataset contract, a source, or arbitrary browser JSON.
 */
async function compileAppAutopilotChange(
  projectRoot: string,
  draft: AppBuildDraft,
  input: { pageId: string; tileId: string; intent: AppAutopilotIntent; runId: string; artifactId: string },
  resolver?: Ctx['resolveDatasetSourceAuthority'],
): Promise<AppAutopilotChangeProposal> {
  const pageId = cleanString(input.pageId);
  const tileId = cleanString(input.tileId);
  const intent = normalizeAppAutopilotIntent(input.intent);
  const runId = cleanString(input.runId);
  const artifactId = cleanString(input.artifactId);
  if (!/^[a-z0-9_:-]+$/i.test(runId) || !/^[a-z0-9_:-]+$/i.test(artifactId)) {
    throw new Error('APP_AUTOPILOT_ARTIFACT_INVALID: the universal App Autopilot run is missing a durable artifact identity.');
  }
  const page = draft.pages.find((candidate) => candidate.id === pageId);
  const tile = page?.layout.items.find((candidate) => candidate.i === tileId);
  if (!page || !tile || !tile.query || !tile.sourceId) {
    throw new Error('APP_AUTOPILOT_DATASET_TILE_REQUIRED: select one saved Dataset tile before asking App Autopilot to prepare a change.');
  }
  const stored = draft.sources.find((source) => source.id === tile.sourceId);
  const records = await resolveCurrentDatasetSourceRecords(projectRoot, [tile.sourceId], resolver);
  const source = records.get(tile.sourceId);
  const descriptor = source?.capabilities.dataset;
  const reference = datasetDraftReferences(draft).find((candidate) => candidate.page.id === page.id && candidate.tile.i === tile.i);
  const authorityIssue = reference ? datasetDraftAuthorityIssue(reference, stored, source) : 'APP_BUILD_DATASET_SOURCE_REPAIR_REQUIRED: this Dataset tile has no exact page binding.';
  if (authorityIssue || !descriptor || !source) {
    throw new Error(authorityIssue ?? 'APP_AUTOPILOT_DATASET_TILE_REQUIRED: this tile no longer resolves to an approved Dataset contract.');
  }
  const currentAuthorityErrors = await datasetDraftCurrentAuthorityErrors(projectRoot, draft, 'local_preview', resolver);
  if (currentAuthorityErrors.length > 0) throw new Error(currentAuthorityErrors[0]!);
  const currentValidation = validateTileQuery(descriptor, tile.query);
  if (!tileQueryValidationRuns(currentValidation)) {
    throw new Error(`APP_AUTOPILOT_DATASET_TILE_INVALID: the saved Dataset query is no longer covered. ${currentValidation.diagnostics.map((diagnostic) => diagnostic.message).join(' ')}`);
  }
  const selectedBinding = appAutopilotDatasetBinding(page, tile);
  const operations: AppBuildDraftOperation[] = [];
  let summary = intent.summary ?? 'App Autopilot prepared a typed App change from the current governed Dataset contract.';

  const validateQueryAndVisualization = (query: TileQuery, visualization: DashboardGridItem['viz']['type']): void => {
    const validation = validateTileQuery(descriptor, query);
    if (!tileQueryValidationRuns(validation)) {
      throw new Error(`APP_AUTOPILOT_QUERY_INVALID: ${validation.diagnostics.map((diagnostic) => diagnostic.message).join(' ')}`);
    }
    const compatibility = datasetTileVisualizationCompatibility(query, visualization);
    if (!compatibility.compatible) {
      throw new Error(`APP_AUTOPILOT_VISUALIZATION_INVALID: ${compatibility.message ?? 'the proposed visualization cannot show this Dataset query.'}`);
    }
  };

  switch (intent.action) {
    case 'group_tile': {
      if (tile.query.detail) {
        throw new Error('APP_AUTOPILOT_REQUEST_UNSUPPORTED: bounded detail tiles cannot be regrouped. Create a chart or table tile first.');
      }
      const requestedDimension = appAutopilotRequestedDatasetDimension(descriptor, intent.field);
      if (tile.query.dimensions.some((dimension) => dimension.field.toLocaleLowerCase() === requestedDimension.field.name.toLocaleLowerCase())) {
        throw new Error(`APP_AUTOPILOT_NO_CHANGE: ${appAutopilotDisplayName(requestedDimension.field.name)} is already selected on this tile.`);
      }
      const query = normalizeTileQuery({
        ...tile.query,
        dimensions: [...tile.query.dimensions, {
          field: requestedDimension.field.name,
          ...(requestedDimension.timeGrain ? { timeGrain: requestedDimension.timeGrain } : {}),
        }],
      });
      if (!query) throw new Error('APP_AUTOPILOT_QUERY_INVALID: App Autopilot could not form a valid bounded Dataset query.');
      const visualization = intent.visualization ?? 'bar';
      validateQueryAndVisualization(query, visualization);
      const measureLabel = tile.query.measures.length === 1
        ? appAutopilotDisplayName(tile.query.measures[0]!.alias ?? tile.query.measures[0]!.measure)
        : tile.title || 'Dataset result';
      const fieldLabel = appAutopilotDisplayName(requestedDimension.field.name);
      const title = intent.title ?? `${measureLabel} by ${fieldLabel}`;
      operations.push({ type: 'update_tile', pageId, tileId, patch: { query, viz: { type: visualization }, ...(title !== tile.title ? { title } : {}) } });
      summary = intent.summary ?? `Group ${measureLabel} by the approved ${fieldLabel} Dataset field.`;
      break;
    }
    case 'change_visualization': {
      if (!intent.visualization) throw new Error('APP_AUTOPILOT_VISUALIZATION_REQUIRED: choose one supported visualization.');
      validateQueryAndVisualization(tile.query, intent.visualization);
      const title = intent.title ? appAutopilotText(intent.title, 'tile title', 120) : undefined;
      const visualizationChanged = tile.viz.type !== intent.visualization;
      const titleChanged = Boolean(title && title !== tile.title);
      if (!visualizationChanged && !titleChanged) {
        throw new Error('APP_AUTOPILOT_NO_CHANGE: the selected tile already uses that visualization and title.');
      }
      operations.push({
        type: 'update_tile',
        pageId,
        tileId,
        patch: {
          ...(visualizationChanged ? { viz: { type: intent.visualization } } : {}),
          ...(titleChanged ? { title } : {}),
        },
      });
      summary = intent.summary ?? (titleChanged && visualizationChanged
        ? `Rename ${tile.title || tile.i} to ${title} and change its visualization to ${appAutopilotDisplayName(intent.visualization)}.`
        : titleChanged
          ? `Rename ${tile.title || tile.i} to ${title}.`
          : `Change ${tile.title || tile.i} to ${appAutopilotDisplayName(intent.visualization)}.`);
      break;
    }
    case 'rename_tile': {
      const title = appAutopilotText(intent.title, 'tile title', 120);
      if (!title) throw new Error('APP_AUTOPILOT_TITLE_REQUIRED: provide a short presentation title for the selected tile.');
      const visualization = intent.visualization;
      if (visualization) validateQueryAndVisualization(tile.query, visualization);
      const titleChanged = title !== tile.title;
      const visualizationChanged = Boolean(visualization && tile.viz.type !== visualization);
      if (!titleChanged && !visualizationChanged) {
        throw new Error('APP_AUTOPILOT_NO_CHANGE: the selected tile already has that title and visualization.');
      }
      operations.push({
        type: 'update_tile',
        pageId,
        tileId,
        patch: {
          ...(titleChanged ? { title } : {}),
          ...(visualizationChanged && visualization ? { viz: { type: visualization } } : {}),
        },
      });
      summary = intent.summary ?? (visualizationChanged && visualization
        ? `Rename ${tile.i} to ${title} and change its visualization to ${appAutopilotDisplayName(visualization)}.`
        : `Rename ${tile.i} to ${title}.`);
      break;
    }
    case 'add_tile': {
      const measure = appAutopilotExactMeasure(descriptor, intent.measure);
      const dimension = intent.field ? appAutopilotRequestedDatasetDimension(descriptor, intent.field) : undefined;
      const query = normalizeTileQuery({
        dimensions: dimension ? [{ field: dimension.field.name, ...(dimension.timeGrain ? { timeGrain: dimension.timeGrain } : {}) }] : [],
        measures: [{ measure: measure.name }],
        respectsGlobalFilters: true,
      });
      if (!query) throw new Error('APP_AUTOPILOT_QUERY_INVALID: App Autopilot could not form a new Dataset tile query.');
      const visualization = intent.visualization ?? (dimension ? 'bar' : 'kpi');
      validateQueryAndVisualization(query, visualization);
      const tileIdForAdd = uniqueTileId(page.layout.items, intent.title ?? `${measure.name}-${dimension?.field.name ?? 'kpi'}`);
      const y = page.layout.items.reduce((maximum, item) => Math.max(maximum, item.y + item.h), 0);
      const title = intent.title ?? (dimension
        ? `${appAutopilotDisplayName(measure.name)} by ${appAutopilotDisplayName(dimension.field.name)}`
        : appAutopilotDisplayName(measure.name));
      operations.push({
        type: 'add_tile',
        pageId,
        tile: {
          i: tileIdForAdd,
          x: 0,
          y,
          w: visualization === 'kpi' || visualization === 'single_value' ? 3 : 6,
          h: visualization === 'kpi' || visualization === 'single_value' ? 2 : 4,
          sourceId: source.sourceId,
          sourceRevision: source.sourceRevision,
          query,
          viz: { type: visualization },
          title,
        },
      });
      summary = intent.summary ?? `Add ${title} from the selected approved Dataset source.`;
      break;
    }
    case 'remove_tile': {
      if (page.layout.items.length <= 1) {
        throw new Error('APP_AUTOPILOT_LAST_TILE_DENIED: keep at least one tile on the page; add a replacement before removing the selected tile.');
      }
      operations.push({ type: 'remove_tile', pageId, tileId });
      summary = intent.summary ?? `Remove ${tile.title || tile.i} from this local App draft.`;
      break;
    }
    case 'add_page': {
      const title = appAutopilotText(intent.title, 'page title', 120) ?? 'New page';
      const newPage: DashboardDocument = {
        version: 3,
        id: appAutopilotPageId(title, draft.pages),
        metadata: {
          title,
          description: draft.frame.goal,
          ...(page.metadata.domain ? { domain: page.metadata.domain } : {}),
          ...(draft.frame.audience ? { audience: draft.frame.audience } : {}),
        },
        datasets: [],
        layout: { kind: 'grid', cols: 12, rowHeight: 80, items: [] },
      };
      operations.push({ type: 'upsert_page', page: newPage });
      summary = intent.summary ?? `Add the ${title} App page. App-scoped controls will be inherited as explicit unbound controls.`;
      break;
    }
    case 'remove_page': {
      if (draft.pages.length <= 1) throw new Error('APP_AUTOPILOT_LAST_PAGE_DENIED: keep at least one App page.');
      const target = intent.targetPageId ? appAutopilotTargetPage(draft, intent.targetPageId) : page;
      const cleanup = draft.pages.filter((candidate) => candidate.id !== target.id).flatMap((candidate) => {
        const navigate = candidate.interactions?.navigate?.filter((item) => item.toPage !== target.id) ?? [];
        if ((candidate.interactions?.navigate?.length ?? 0) === navigate.length) return [];
        return [{
          type: 'set_interactions' as const,
          pageId: candidate.id,
          interactions: appAutopilotCleanInteractions({ ...candidate.interactions, navigate }),
        }];
      });
      if (cleanup.length > 11) throw new Error('APP_AUTOPILOT_PAGE_CHANGE_LIMIT: remove page navigation in smaller reviewable changes.');
      operations.push(...cleanup, { type: 'remove_page', pageId: target.id });
      summary = intent.summary ?? `Remove ${target.metadata.title} and its incoming App navigation links.`;
      break;
    }
    case 'add_filter': {
      const field = appAutopilotExactPhysicalField(descriptor, intent.field);
      const id = appAutopilotUniqueFilterId(page, intent.filterId, field);
      if (intent.scope === 'app' && draft.pages.some((candidate) => candidate.filters?.some((filter) => filter.id === id))) {
        throw new Error(`APP_AUTOPILOT_FILTER_EXISTS: ${id} already exists in this App. Choose the existing filter to map or remove it.`);
      }
      const filter: DashboardFilter = {
        id,
        type: datasetFieldFilterType(field),
        label: appAutopilotDisplayName(field.name),
        field: { name: field.name },
        scope: intent.scope === 'app' ? { app: true } : { page: pageId, tileIds: [tileId] },
        datasetBindings: { [selectedBinding.id]: { field: field.name, tileIds: [tileId] } },
      };
      if (intent.scope === 'app') {
        for (const candidate of draft.pages) {
          operations.push({
            type: 'set_filter',
            pageId: candidate.id,
            filter: candidate.id === pageId ? filter : { ...filter, datasetBindings: {} },
          });
        }
      } else {
        operations.push({ type: 'set_filter', pageId, filter });
      }
      summary = intent.summary ?? `Add an explicit ${intent.scope === 'app' ? 'App-wide' : 'page'} ${appAutopilotDisplayName(field.name)} filter mapped only to the selected Dataset tile.`;
      break;
    }
    case 'remove_filter': {
      const filterId = appAutopilotText(intent.filterId, 'filter id');
      if (!filterId) throw new Error('APP_AUTOPILOT_FILTER_REQUIRED: choose one exact existing filter id.');
      const filter = page.filters?.find((candidate) => candidate.id === filterId);
      if (!filter) throw new Error(`APP_AUTOPILOT_FILTER_UNAVAILABLE: ${filterId} is not on the selected page.`);
      const targets = filter.scope?.app === true
        ? draft.pages.filter((candidate) => candidate.filters?.some((item) => item.id === filterId))
        : [page];
      operations.push(...targets.map((candidate) => ({ type: 'remove_filter' as const, pageId: candidate.id, filterId })));
      summary = intent.summary ?? `Remove the ${filter.label ?? filter.id} filter from ${filter.scope?.app === true ? 'every App page' : 'this page'}.`;
      break;
    }
    case 'map_filter': {
      const filterId = appAutopilotText(intent.filterId, 'filter id');
      if (!filterId) throw new Error('APP_AUTOPILOT_FILTER_REQUIRED: choose one exact existing filter id.');
      const filter = page.filters?.find((candidate) => candidate.id === filterId);
      if (!filter) throw new Error(`APP_AUTOPILOT_FILTER_UNAVAILABLE: ${filterId} is not on the selected page.`);
      const field = appAutopilotExactPhysicalField(descriptor, intent.field);
      const current = filter.datasetBindings?.[selectedBinding.id];
      const tileIds = Array.from(new Set([...(current?.tileIds ?? []), tileId]));
      operations.push({
        type: 'set_filter',
        pageId,
        filter: { ...filter, datasetBindings: { ...(filter.datasetBindings ?? {}), [selectedBinding.id]: { field: field.name, tileIds } } },
      });
      summary = intent.summary ?? `Map ${filter.label ?? filter.id} to the approved ${appAutopilotDisplayName(field.name)} field on ${tile.title || tile.i}.`;
      break;
    }
    case 'add_cross_filter': {
      const fromField = appAutopilotOutputDimension(tile, intent.field);
      const targetTile = appAutopilotTargetTile(page, intent.targetTileId);
      if (targetTile.i === tile.i) throw new Error('APP_AUTOPILOT_TARGET_TILE_UNAVAILABLE: choose a different target tile for a cross-filter.');
      const targetBinding = appAutopilotDatasetBinding(page, targetTile);
      const targetSource = targetTile.sourceId ? records.get(targetTile.sourceId) : undefined;
      // The selected page may include a second Dataset source. Resolve it only
      // now, and require its current binding before its field can be targeted.
      const targetRecords = targetSource ? records : await resolveCurrentDatasetSourceRecords(projectRoot, [targetTile.sourceId!], resolver);
      const targetDescriptor = targetSource?.capabilities.dataset ?? targetRecords.get(targetTile.sourceId!)?.capabilities.dataset;
      if (!targetDescriptor) throw new Error('APP_AUTOPILOT_TARGET_TILE_UNAVAILABLE: the target tile no longer resolves to a current Dataset contract.');
      const targetField = appAutopilotExactPhysicalField(targetDescriptor, intent.targetField ?? intent.field);
      const mappings = page.interactions?.crossFilter?.mappings ?? [];
      if (mappings.some((mapping) => mapping.fromTileId === tileId && mapping.fromField === fromField && mapping.toDataset === targetBinding.id && mapping.toField === targetField.name)) {
        throw new Error('APP_AUTOPILOT_NO_CHANGE: that explicit cross-filter mapping already exists.');
      }
      operations.push({
        type: 'set_interactions',
        pageId,
        interactions: {
          ...page.interactions,
          crossFilter: { enabled: true, mappings: [...mappings, { fromTileId: tileId, fromField, toDataset: targetBinding.id, toField: targetField.name }] },
        },
      });
      summary = intent.summary ?? `Connect ${tile.title || tile.i}.${fromField} to ${targetTile.title || targetTile.i}.${targetField.name} with an explicit Dataset mapping.`;
      break;
    }
    case 'add_navigation': {
      const target = appAutopilotTargetPage(draft, intent.targetPageId);
      if (target.id === pageId) throw new Error('APP_AUTOPILOT_TARGET_PAGE_UNAVAILABLE: choose a different page for tile navigation.');
      const carryFilters = (page.filters ?? []).filter((filter) => target.filters?.some((candidate) => candidate.id === filter.id)).map((filter) => filter.id);
      const navigate = [...(page.interactions?.navigate ?? []).filter((candidate) => candidate.fromTile !== tileId), {
        fromTile: tileId,
        toPage: target.id,
        carryFilters,
      }];
      operations.push({ type: 'set_interactions', pageId, interactions: { ...page.interactions, navigate } });
      summary = intent.summary ?? `Navigate from ${tile.title || tile.i} to ${target.metadata.title} and carry only the controls both pages explicitly own.`;
      break;
    }
    case 'add_detail_drill': {
      const field = appAutopilotExactPhysicalField(descriptor, intent.field);
      const columns = Array.from(new Set([
        ...descriptor.grain.keyFields.flatMap((key) => {
          const keyField = datasetPhysicalField(descriptor, key);
          return keyField?.status === 'approved' ? [keyField.name] : [];
        }),
        field.name,
      ])).slice(0, 8);
      if (columns.length === 0) throw new Error('APP_AUTOPILOT_DETAIL_UNAVAILABLE: this Dataset contract has no approved detail column.');
      operations.push({ type: 'set_interactions', pageId, interactions: { ...page.interactions, detail: { dataset: selectedBinding.id, columns } } });
      summary = intent.summary ?? `Add a bounded detail drill using the approved Dataset grain keys and ${appAutopilotDisplayName(field.name)}.`;
      break;
    }
    case 'arrange_layout': {
      const items = packDashboardLayoutItems(page.layout.items, page.layout.cols);
      const unchanged = JSON.stringify(items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })))
        === JSON.stringify(page.layout.items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })));
      if (unchanged) throw new Error('APP_AUTOPILOT_NO_CHANGE: the current page already has a compact non-overlapping layout.');
      operations.push({ type: 'set_layout', pageId, layout: { ...page.layout, items } });
      summary = intent.summary ?? 'Pack the current page into a compact non-overlapping layout while preserving reading order.';
      break;
    }
  }
  if (operations.length === 0 || operations.length > 12) {
    throw new Error('APP_AUTOPILOT_CHANGE_LIMIT: App Autopilot must prepare between one and twelve bounded operations for review.');
  }
  const base: Omit<AppAutopilotChangeProposal, 'proposalHash' | 'appliedAt' | 'appliedRevision'> = {
    version: 1,
    id: `autopilot_${randomUUID().replace(/-/g, '')}`,
    runId,
    artifactId,
    draftId: draft.id,
    baseRevision: draft.revision,
    baseProposalHash: draft.proposalHash,
    pageId,
    tileId,
    request: intent.request,
    intent,
    source: { sourceId: source.sourceId, sourceRevision: source.sourceRevision, contractFingerprint: descriptor.contractRef.fingerprint },
    planningMode: 'universal_agent',
    operations,
    diagnostics: [{ code: 'APP_AUTOPILOT_SERVER_COMPILED', severity: 'info', message: `${summary} Review it before applying the local App draft change.` }],
    createdAt: new Date().toISOString(),
  };
  return { ...base, proposalHash: appAutopilotProposalHash(base) };
}

function appAutopilotProposalDir(projectRoot: string, draftId: string): string {
  return join(appBuildProposalDir(projectRoot, draftId), 'autopilot');
}

function writeAppAutopilotChange(projectRoot: string, proposal: AppAutopilotChangeProposal): void {
  assertStoredAppAutopilotChange(proposal);
  const { appliedAt: _appliedAt, appliedRevision: _appliedRevision, ...immutableProposal } = proposal;
  const storage = openAppStorage(projectRoot);
  try {
    storage.saveAppAutopilotChange({
      id: immutableProposal.id,
      draftId: immutableProposal.draftId,
      proposalHash: immutableProposal.proposalHash,
      runId: immutableProposal.runId,
      artifactId: immutableProposal.artifactId,
      payload: immutableProposal,
      createdAt: immutableProposal.createdAt,
    });
  } finally {
    storage.close();
  }
}

function loadAppAutopilotChange(
  projectRoot: string,
  draftId: string,
  proposalId: string,
): AppAutopilotChangeProposal | null {
  if (!/^[a-z0-9_:-]+$/i.test(draftId) || !/^[a-z0-9_:-]+$/i.test(proposalId)) return null;
  const storage = openAppStorage(projectRoot);
  try {
    const stored = storage.getAppAutopilotChange(draftId, proposalId);
    if (stored) {
      const proposal = stored.payload as AppAutopilotChangeProposal;
      assertStoredAppAutopilotChange(proposal);
      if (proposal.draftId !== draftId || proposal.id !== proposalId
        || proposal.proposalHash !== stored.proposalHash
        || proposal.runId !== stored.runId
        || proposal.artifactId !== stored.artifactId) {
        return null;
      }
      return {
        ...proposal,
        ...(stored.appliedAt ? { appliedAt: stored.appliedAt } : {}),
        ...(stored.appliedRevision !== undefined ? { appliedRevision: stored.appliedRevision } : {}),
      };
    }
  } finally {
    storage.close();
  }
  // Compatibility migration for a proposal prepared by an earlier local
  // runtime. New proposals live in SQLite so the draft and Apply decision can
  // commit in one transaction; a legacy file is accepted once and immediately
  // copied into that durable record.
  const path = join(appAutopilotProposalDir(projectRoot, draftId), `${proposalId}.json`);
  if (!existsSync(path)) return null;
  try {
    const proposal = JSON.parse(readFileSync(path, 'utf8')) as AppAutopilotChangeProposal;
    assertStoredAppAutopilotChange(proposal);
    if (proposal.draftId !== draftId || proposal.id !== proposalId) return null;
    writeAppAutopilotChange(projectRoot, proposal);
    return proposal;
  } catch {
    return null;
  }
}

/**
 * Server-only entry for the universal App Autopilot executor. It loads the
 * current draft itself, so browser context is limited to opaque ids and the
 * actual App mutation cannot be smuggled through the agent request.
 */
export async function prepareAppAutopilotChange(
  projectRoot: string,
  input: {
    draftId: string;
    pageId: string;
    tileId: string;
    intent: AppAutopilotIntent;
    runId: string;
    artifactId: string;
  },
  resolver?: Ctx['resolveDatasetSourceAuthority'],
): Promise<AppAutopilotChangeProposal> {
  const draftId = cleanString(input.draftId);
  const draft = loadStoredAppBuildDraft(projectRoot, draftId);
  if (!draft) {
    throw new Error('APP_AUTOPILOT_DRAFT_NOT_FOUND: the App draft is no longer available. Reopen App Studio and try again.');
  }
  const proposal = await compileAppAutopilotChange(projectRoot, draft, {
    pageId: cleanString(input.pageId),
    tileId: cleanString(input.tileId),
    intent: input.intent,
    runId: cleanString(input.runId),
    artifactId: cleanString(input.artifactId),
  }, resolver);
  writeAppAutopilotChange(projectRoot, proposal);
  return proposal;
}

/**
 * Apply is intentionally separate from preparation and validates the
 * immutable AgentRun artifact link, draft revision, current Dataset identity,
 * query coverage, and visualization again. The stored applied marker makes a
 * repeated Apply safe after a lost browser response.
 */
export async function applyAppAutopilotChange(
  projectRoot: string,
  input: {
    draftId: string;
    proposalId: string;
    runId: string;
    artifactId: string;
    expectedRevision: number;
    expectedProposalHash: string;
    proposalHash: string;
  },
  resolver?: Ctx['resolveDatasetSourceAuthority'],
): Promise<{ draft: AppBuildDraft; proposalId: string; deduped: boolean }> {
  const draftId = cleanString(input.draftId);
  const proposalId = cleanString(input.proposalId);
  const current = loadStoredAppBuildDraft(projectRoot, draftId);
  const proposal = current ? loadAppAutopilotChange(projectRoot, draftId, proposalId) : null;
  if (!current || !proposal) {
    throw new Error('APP_AUTOPILOT_CHANGE_NOT_FOUND: the App Autopilot review artifact is unavailable. Ask App Autopilot to prepare it again.');
  }
  if (proposal.runId !== cleanString(input.runId) || proposal.artifactId !== cleanString(input.artifactId)) {
    throw new Error('APP_AUTOPILOT_ARTIFACT_MISMATCH: this change does not belong to the selected universal App Autopilot run.');
  }
  if (proposal.proposalHash !== cleanString(input.proposalHash)) {
    throw new Error('APP_AUTOPILOT_CHANGE_INVALID: the reviewed change hash does not match the stored artifact.');
  }
  if (proposal.appliedRevision !== undefined) {
    return { draft: current, proposalId: proposal.id, deduped: true };
  }
  if (input.expectedRevision !== current.revision
    || cleanString(input.expectedProposalHash) !== current.proposalHash
    || proposal.baseRevision !== current.revision
    || proposal.baseProposalHash !== current.proposalHash) {
    throw new Error('APP_AUTOPILOT_CHANGE_STALE: the App draft changed after review. Ask App Autopilot to prepare a new change.');
  }
  await assertAppAutopilotChangeDatasetSourceCurrent(projectRoot, current, proposal, resolver);
  const operations = await bindServerResolvedDatasetSourceOperations(projectRoot, current, proposal.operations, resolver);
  const next = applyAppBuildDraftOperations(current, current.revision, operations);
  try {
    const storage = openAppStorage(projectRoot);
    try {
      const applied = storage.applyAppBuildDraftWithAutopilotChange(next, {
        expectedRevision: current.revision,
        operations,
        proposal: {
          id: proposal.id,
          draftId: proposal.draftId,
          proposalHash: proposal.proposalHash,
          runId: proposal.runId,
          artifactId: proposal.artifactId,
        },
        appliedAt: new Date().toISOString(),
      });
      return { draft: applied.draft, proposalId: proposal.id, deduped: applied.deduped };
    } finally {
      storage.close();
    }
  } catch (error) {
    // If a concurrent Apply won and marked this exact immutable proposal, the
    // caller gets the durable result rather than a misleading conflict.
    const applied = loadAppAutopilotChange(projectRoot, draftId, proposalId);
    const reloaded = loadStoredAppBuildDraft(projectRoot, draftId);
    if (applied?.appliedRevision !== undefined && reloaded) {
      return { draft: reloaded, proposalId: applied.id, deduped: true };
    }
    throw error;
  }
}

async function composeStoredAppBuildDraft(
  projectRoot: string,
  current: AppBuildDraft,
  request: AppBuildComposeRequest,
  resolver?: Ctx['resolveDatasetSourceAuthority'],
): Promise<{ draft: AppBuildDraft; pageIds: string[]; tileIds: string[] }> {
  if (request.mode === 'ai') {
    const proposal = loadAppBuildDraftAiProposal(projectRoot, current.id, cleanString(request.proposalId));
    if (!proposal) throw new Error('APP_BUILD_PROPOSAL_NOT_FOUND: ask AI to rebuild the proposal.');
    if (proposal.baseRevision !== current.revision || proposal.baseProposalHash !== current.proposalHash) {
      throw new Error('APP_BUILD_PROPOSAL_CONFLICT: the proposal is based on an older draft revision.');
    }
    const selected = new Set(unique((request.selectedSourceIds ?? []).map(cleanString).filter(Boolean)));
    const available = new Map(proposal.operations.flatMap((operation) => (
      operation.type === 'upsert_source' ? [[operation.source.id, operation.source] as const] : []
    )));
    const missing = Array.from(selected).filter((sourceId) => !available.has(sourceId));
    if (missing.length) throw new Error(`APP_BUILD_SOURCE_NOT_IN_PROPOSAL: ${missing.join(', ')}`);
    const rejected = new Set(unique((request.rejectedTileIds ?? []).map(cleanString).filter(Boolean)));
    if (proposal.proposedTileIds) {
      const unknown = Array.from(rejected).filter((tileId) => !proposal.proposedTileIds!.includes(tileId));
      if (unknown.length) throw new Error(`APP_BUILD_TILE_NOT_IN_PROPOSAL: ${unknown.join(', ')}`);
    }
    const selectedOperations = operationsForSelectedAppBuildSources(proposal.operations, selected, {
      proposedTileIds: proposal.proposedTileIds,
      rejectedTileIds: rejected,
    });
    // The plan is immutable intent, not source authority. Re-resolving a
    // source protects against provider-supplied capabilities, but it must not
    // silently upgrade a server-issued proposal to a newer Dataset revision or
    // contract. Require a fresh proposal when the source changed after the
    // author reviewed this one.
    await assertAiProposalDatasetSourcePinsCurrent(projectRoot, selectedOperations, resolver);
    const operations = await bindServerResolvedDatasetSourceOperations(
      projectRoot,
      current,
      selectedOperations,
      resolver,
    );
    const next = applyAppBuildDraftOperations(current, current.revision, operations);
    writeStoredAppBuildDraft(projectRoot, next, { expectedRevision: current.revision, operations });
    const pages = operations.flatMap((operation) => operation.type === 'upsert_page' ? [operation.page] : []);
    return {
      draft: next,
      pageIds: pages.map((page) => page.id),
      tileIds: pages.flatMap((page) => page.layout.items
        .filter((item) => (proposal.proposedTileIds
          ? proposal.proposedTileIds.includes(item.i)
          : Boolean(item.sourceId && selected.has(item.sourceId))))
        .map((item) => item.i)),
    };
  }

  const selections = request.selections ?? [];
  if (selections.length === 0) throw new Error('APP_BUILD_SOURCE_REQUIRED: choose at least one source.');
  if (selections.length > 100) throw new Error('APP_BUILD_SOURCE_LIMIT: at most 100 components can be composed at once.');
  const { ensureAgentProjectReady, resolveAppSourceCatalogRecords } = await import('@zlens/agent');
  await ensureAgentProjectReady(projectRoot);
  // No per-App data rule (T3): certified and not-certified data are both addable.
  const resolved = resolveAppSourceCatalogRecords(
    projectRoot,
    selections.map((selection) => selection.sourceId),
    APP_SOURCE_POLICY,
  );
  if (resolved.missingSourceIds.length) {
    throw new Error(`APP_BUILD_SOURCE_DRIFT: these sources no longer resolve: ${resolved.missingSourceIds.join(', ')}`);
  }
  const byId = new Map(resolved.items.map((source) => [source.sourceId, source]));
  // Field-based composition edits a complete v3 page in memory, then persists
  // it through one existing `upsert_page` operation. This keeps the dataset
  // registry and its query tiles atomic inside the local draft revision.
  const workingPages = new Map(current.pages.map((page) => [page.id, structuredClone(page)]));
  const operations: AppBuildDraftOperation[] = [];
  const pageIds = new Set<string>();
  const tileIds: string[] = [];
  const coverageAdditions = new Map<string, { sourceIds: string[]; componentIds: string[] }>();
  for (const [index, selection] of selections.entries()) {
    const source = byId.get(selection.sourceId);
    if (!source) throw new Error(`APP_BUILD_SOURCE_DRIFT: ${selection.sourceId} no longer resolves.`);
    if (!source.eligibility.localPreview) {
      throw new Error(`APP_BUILD_DATASET_RETIRED: ${source.title} is ${source.lifecycle}; choose current data instead.`);
    }
    const selectedPage = current.pages.find((candidate) => candidate.id === cleanString(selection.pageId)) ?? current.pages[0];
    const page = selectedPage ? workingPages.get(selectedPage.id) : undefined;
    if (!page) throw new Error('APP_BUILD_PAGE_REQUIRED: add a page before adding a source.');
    const pageItems = page.layout.items;
    const tileId = uniqueTileId(pageItems, `${source.name}-${selection.view}`);
    const y = pageItems.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    const certified = source.trust === 'certified';
    const view = selection.view === 'chart'
      ? normalizeVizType(source.capabilities.chartType ?? source.capabilities.allowedVisualizations?.[0] ?? 'bar')
      : selection.view === 'kpi' ? 'kpi' : 'table';
    const dataset = source.capabilities.dataset;
    const datasetId = dataset ? `dataset_${createHash('sha256').update(source.sourceId).digest('hex').slice(0, 16)}` : undefined;
    const existingDatasetBinding = page.datasets?.find((binding) => binding.sourceId === source.sourceId);
    if (existingDatasetBinding && existingDatasetBinding.sourceRevision !== source.sourceRevision) {
      throw new Error(`APP_BUILD_SOURCE_DRIFT: ${source.title} changed revision; refresh or replace the existing Dataset binding before adding another tile.`);
    }
    if (dataset && !existingDatasetBinding) {
      page.version = 3;
      page.datasets = [
        ...(page.datasets ?? []),
        {
          id: datasetId!,
          sourceId: source.sourceId,
          sourceRevision: source.sourceRevision,
          snapshotId: source.snapshotId,
          contractFingerprint: dataset.contractRef.fingerprint,
        },
      ];
    }
    if (!dataset && selection.query !== undefined) {
      throw new Error(`APP_BUILD_DATASET_QUERY_SOURCE_REQUIRED: ${source.title} does not expose a field-based Dataset.`);
    }
    const requestedQuery = selection.query === undefined ? undefined : normalizeTileQuery(selection.query);
    if (selection.query !== undefined && !requestedQuery) {
      throw new Error(`APP_BUILD_DATASET_QUERY_INVALID: ${source.title} has an unsupported or malformed field query.`);
    }
    const defaultQuery = dataset ? requestedQuery ?? defaultTileQueryForDataset(dataset, selection.view) : undefined;
    if (dataset && !defaultQuery) {
      throw new Error(`APP_BUILD_DATASET_NO_APPROVED_MEASURE: ${source.title} has no approved measure for a field-based tile.`);
    }
    if (dataset && defaultQuery) {
      const validation = validateTileQuery(dataset, defaultQuery);
      if (!tileQueryValidationRuns(validation)) {
        const detail = validation.diagnostics.map((diagnostic) => diagnostic.message).join(' ') || 'The selected Dataset operations are not covered.';
        throw new Error(`APP_BUILD_DATASET_QUERY_${validation.outcome.toUpperCase()}: ${detail}`);
      }
      const visualization = datasetTileVisualizationCompatibility(defaultQuery, view);
      if (!visualization.compatible) {
        throw new Error(`APP_BUILD_DATASET_VISUALIZATION_INVALID: ${visualization.message}`);
      }
    }
    const tile: DashboardGridItem = {
      i: tileId,
      x: (index % 2) * 6,
      y,
      w: selection.view === 'kpi' ? 3 : 6,
      h: selection.view === 'kpi' ? 2 : 4,
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
      ...(defaultQuery ? { query: defaultQuery } : { block: { ref: source.executionRef } }),
      viz: { type: view },
      title: cleanString(selection.title) || source.title,
      sourceClass: source.kind === 'semantic' ? 'governed_semantic' : certified ? 'certified_block' : 'exploratory_analysis',
      filterBindings: source.capabilities.filters.map((filter) => ({ filter, binding: filter, mode: 'predicate', capability: 'preflight_required' })),
      review: { status: certified ? 'not_required' : 'required', sourceFingerprint: source.sourceRevision },
      trustState: certified ? 'certified' : 'review_required',
      reviewStatus: certified ? 'certified' : 'review_required',
    };
    pageItems.push(tile);
    workingPages.set(page.id, page);
    operations.push({ type: 'upsert_source', source: appDraftSourceFromCatalog(source) });
    pageIds.add(page.id);
    tileIds.push(tileId);
    for (const requirement of current.requirements) {
      if (!catalogSourceSatisfiesRequirement(source, requirement)) continue;
      const addition = coverageAdditions.get(requirement.id) ?? { sourceIds: [], componentIds: [] };
      addition.sourceIds.push(source.sourceId);
      addition.componentIds.push(tileId);
      coverageAdditions.set(requirement.id, addition);
    }
  }
  for (const pageId of pageIds) {
    const page = workingPages.get(pageId);
    if (page) operations.push({ type: 'upsert_page', page });
  }
  if (current.requirements.length > 0) {
    const existingByRequirement = new Map(current.coverage.map((item) => [item.requirementId, item]));
    operations.push({
      type: 'set_coverage',
      coverage: current.requirements.map((requirement) => {
        const existing = existingByRequirement.get(requirement.id);
        const addition = coverageAdditions.get(requirement.id);
        const sourceIds = unique([...(existing?.sourceIds ?? []), ...(addition?.sourceIds ?? [])]);
        const componentIds = unique([...(existing?.componentIds ?? []), ...(addition?.componentIds ?? [])]);
        const newlyCovered = Boolean(addition?.sourceIds.length && addition.componentIds.length);
        return {
          requirementId: requirement.id,
          status: newlyCovered ? 'covered' : existing?.status ?? 'gap',
          sourceIds,
          componentIds,
          reasons: newlyCovered
            ? unique([...(existing?.reasons ?? []), 'Covered by a server-resolved source added during manual composition.'])
            : existing?.reasons ?? ['No selected App source covers this requirement.'],
        };
      }),
    });
  }
  const next = applyAppBuildDraftOperations(current, current.revision, operations);
  writeStoredAppBuildDraft(projectRoot, next, { expectedRevision: current.revision, operations });
  return { draft: next, pageIds: Array.from(pageIds), tileIds };
}

/**
 * Add-mode proposals extend an App rather than re-plan it: the author's goal
 * and earlier requirements stay, the plan only contributes what is new, and a
 * planner requirement id that already exists is renamed so it cannot replace
 * the earlier requirement or its coverage.
 */
function mergeAddModeRequirements(
  draft: AppBuildDraft,
  plannedFrame: AppBuildDraft['frame'],
  plannedRequirements: AppBuildDraft['requirements'],
  plannedCoverage: AppBuildDraft['coverage'],
): { frame: AppBuildDraft['frame']; requirements: AppBuildDraft['requirements']; coverage: AppBuildDraft['coverage'] } {
  const current = draft.frame;
  const frame: AppBuildDraft['frame'] = {
    ...plannedFrame,
    goal: cleanString(current.goal) || plannedFrame.goal,
    ...(cleanString(current.decision) ? { decision: current.decision } : {}),
    ...(cleanString(current.audience) ? { audience: current.audience } : {}),
    metrics: unique([...(current.metrics ?? []), ...plannedFrame.metrics]),
    dimensions: unique([...(current.dimensions ?? []), ...plannedFrame.dimensions]),
    filters: unique([...(current.filters ?? []), ...plannedFrame.filters]),
  };
  const taken = new Set(draft.requirements.map((requirement) => requirement.id));
  const renamed = new Map<string, string>();
  const added = plannedRequirements.map((requirement) => {
    let id = requirement.id;
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${requirement.id}-${suffix}`;
    taken.add(id);
    renamed.set(requirement.id, id);
    return id === requirement.id ? requirement : { ...requirement, id };
  });
  const addedCoverage = plannedCoverage.map((item) => ({ ...item, requirementId: renamed.get(item.requirementId) ?? item.requirementId }));
  return {
    frame,
    requirements: [...draft.requirements, ...added],
    coverage: [...draft.coverage, ...addedCoverage],
  };
}

function operationsForSelectedAppBuildSources(
  operations: AppBuildDraftOperation[],
  selected: Set<string>,
  options: { proposedTileIds?: string[]; rejectedTileIds?: Set<string> } = {},
): AppBuildDraftOperation[] {
  const proposed = options.proposedTileIds ? new Set(options.proposedTileIds) : undefined;
  const rejected = options.rejectedTileIds ?? new Set<string>();
  // Only tiles the proposal added can be dropped here. Proposals stored
  // before `proposedTileIds` existed rebuilt the whole page, so every tile on
  // it was proposed.
  const removesTile = (item: DashboardGridItem): boolean => {
    if (proposed && !proposed.has(item.i)) return false;
    return rejected.has(item.i) || Boolean(item.sourceId && !selected.has(item.sourceId));
  };
  const removedTileIds = new Set(operations.flatMap((operation) => {
    if (operation.type === 'upsert_page') return operation.page.layout.items.filter(removesTile).map((item) => item.i);
    if (operation.type === 'add_tile' && removesTile(operation.tile)) return [operation.tile.i];
    return [];
  }));
  const keptComponentIds = new Set(operations.flatMap((operation) => {
    if (operation.type === 'upsert_page') return operation.page.layout.items.filter((item) => !removedTileIds.has(item.i)).map((item) => item.i);
    if (operation.type === 'add_tile' && !removedTileIds.has(operation.tile.i)) return [operation.tile.i];
    return [];
  }));
  const keptCoverage = (item: AppBuildDraft['coverage'][number]) => {
    const sourceIds = item.sourceIds.filter((sourceId) => selected.has(sourceId));
    const componentIds = item.componentIds.filter((componentId) => keptComponentIds.has(componentId));
    return { ...item, sourceIds, componentIds, status: sourceIds.length && componentIds.length ? item.status : 'gap' as const };
  };
  return operations.flatMap((operation): AppBuildDraftOperation[] => {
    if (operation.type === 'upsert_source') return selected.has(operation.source.id) ? [operation] : [];
    if (operation.type === 'add_tile') return removedTileIds.has(operation.tile.i) ? [] : [operation];
    if (operation.type === 'set_review_task') {
      if (operation.task.tileId && removedTileIds.has(operation.task.tileId)) return [];
      return !operation.task.sourceId || selected.has(operation.task.sourceId) ? [operation] : [];
    }
    if (operation.type === 'upsert_page') {
      const items = operation.page.layout.items.filter((item) => !removedTileIds.has(item.i));
      const story = operation.page.story
        ? { ...operation.page.story, eligibleTileIds: (operation.page.story.eligibleTileIds ?? []).filter((id) => !removedTileIds.has(id)) }
        : undefined;
      return [{
        ...operation,
        page: {
          ...operation.page,
          ...(story ? { story } : {}),
          layout: {
            ...operation.page.layout,
            items,
            responsive: responsiveLayoutsForDashboardItems(items),
          },
        },
      }];
    }
    if (operation.type === 'set_filter') {
      const filter = operation.filter;
      const scopedTileIds = filter.scope && 'tileIds' in filter.scope ? filter.scope.tileIds : undefined;
      const keptScope = scopedTileIds?.filter((id) => !removedTileIds.has(id));
      const bindings = filter.datasetBindings
        ? Object.fromEntries(Object.entries(filter.datasetBindings).flatMap(([datasetId, binding]) => {
          if (!binding.tileIds) return [[datasetId, binding]];
          const tileIds = binding.tileIds.filter((id) => !removedTileIds.has(id));
          return tileIds.length > 0 ? [[datasetId, { ...binding, tileIds }]] : [];
        }))
        : undefined;
      // A page filter that only served declined tiles has nothing left to filter.
      if (scopedTileIds && scopedTileIds.length > 0 && keptScope?.length === 0) return [];
      return [{
        ...operation,
        filter: {
          ...filter,
          ...(keptScope && filter.scope ? { scope: { ...filter.scope, tileIds: keptScope } } : {}),
          ...(bindings ? { datasetBindings: bindings } : {}),
        },
      }];
    }
    if (operation.type === 'set_interactions') {
      const interactions = operation.interactions ? structuredClone(operation.interactions) : operation.interactions;
      if (interactions?.crossFilter) {
        interactions.crossFilter = {
          ...interactions.crossFilter,
          mappings: interactions.crossFilter.mappings.filter((mapping) => !removedTileIds.has(mapping.fromTileId)),
        };
      }
      if (interactions?.navigate) {
        interactions.navigate = interactions.navigate.filter((entry) => !removedTileIds.has(entry.fromTile));
      }
      return [{ ...operation, interactions }];
    }
    if (operation.type === 'set_requirements') {
      return [{ ...operation, coverage: (operation.coverage ?? []).map(keptCoverage) }];
    }
    if (operation.type === 'set_coverage') {
      return [{ ...operation, coverage: operation.coverage.map(keptCoverage) }];
    }
    return [operation];
  });
}

type PublishedDatasetSourceResolution = {
  snapshotId: string;
  items: AppSourceCatalogRecord[];
  missingSourceIds: string[];
};

/**
 * Supplied only by the HTTP App-edit route after it has refreshed the active
 * immutable metadata snapshot. Keeping the resolver synchronous preserves the
 * existing direct/local draft API, while preventing the published document
 * from being used as an authority for Dataset capabilities or trust.
 */
export type CreateStoredAppBuildDraftOptions = {
  resolvePublishedDatasetSources?: (
    sourceIds: string[],
    sourcePolicy: AppBuildSourcePolicy,
  ) => PublishedDatasetSourceResolution;
  /** A catalog refresh failed before rehydration. Persist a repairable source
   * placeholder instead of treating stale published metadata as current. */
  datasetCatalogError?: string;
};

type PublishedDatasetSourceReference = {
  pageId: string;
  tileId: string;
  title: string;
  sourceId: string;
  sourceRevision?: string;
  binding?: DashboardDatasetBinding;
  bindingMatchesTile: boolean;
};

function publishedDatasetSourceReferences(pages: DashboardDocument[]): PublishedDatasetSourceReference[] {
  return pages.flatMap((page) => page.layout.items.flatMap((tile) => {
    if (!tile.query || !tile.sourceId) return [];
    const sourceId = tile.sourceId.trim();
    const sourceRevision = tile.sourceRevision?.trim();
    if (!sourceId) return [];
    const exactBinding = sourceRevision
      ? page.datasets?.find((binding) => binding.sourceId === sourceId && binding.sourceRevision === sourceRevision)
      : undefined;
    const sourceBinding = exactBinding ?? page.datasets?.find((binding) => binding.sourceId === sourceId);
    return [{
      pageId: page.id,
      tileId: tile.i,
      title: tile.title || tile.i,
      sourceId,
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(sourceBinding ? { binding: sourceBinding } : {}),
      bindingMatchesTile: Boolean(exactBinding),
    }];
  }));
}

function publishedDatasetPlaceholder(
  reference: PublishedDatasetSourceReference,
): AppBuildDraftSource {
  const sourceRevision = reference.sourceRevision;
  return {
    id: reference.sourceId,
    kind: reference.sourceId.startsWith('app:semantic:') ? 'governed_semantic' : 'block',
    // This is an opaque persisted identity for repair only. It is deliberately
    // not an executionRef/sourcePath and carries no inferred Dataset contract.
    sourceRef: reference.sourceId,
    qualifiedIdentity: reference.title || reference.sourceId,
    ...(sourceRevision ? { sourceRevision, sourceFingerprint: sourceRevision } : {}),
    lifecycle: 'unknown',
    trustState: 'review_required',
    reviewStatus: 'required',
  };
}

function publishedDatasetReviewTask(
  reference: PublishedDatasetSourceReference,
  message: string,
): AppBuildDraft['reviewTasks'][number] {
  return {
    id: `published-dataset-${createHash('sha256')
      .update(`${reference.sourceId}\0${reference.pageId}\0${reference.tileId}\0${message}`)
      .digest('hex')
      .slice(0, 12)}`,
    message,
    status: 'open',
    sourceId: reference.sourceId,
    pageId: reference.pageId,
    tileId: reference.tileId,
  };
}

function publishedDatasetRestoreIssue(
  references: PublishedDatasetSourceReference[],
  source: AppSourceCatalogRecord | undefined,
  catalogError: string | undefined,
): string | undefined {
  const first = references[0];
  const binding = first.binding;
  if (!binding || !first.bindingMatchesTile) {
    return `${first.title} is missing its exact published Dataset binding. Select a current Dataset before previewing or publishing.`;
  }
  if (!first.sourceRevision) {
    return `${first.title} has no published Dataset source revision. Select a current Dataset before previewing or publishing.`;
  }
  const signatures = new Set(references.map((reference) => reference.bindingMatchesTile && reference.binding
    ? `${reference.binding.sourceRevision}\0${reference.binding.contractFingerprint}`
    : 'missing'));
  if (signatures.size > 1) {
    return `${first.title} has conflicting published Dataset bindings. Refresh or reselect the Dataset before previewing or publishing.`;
  }
  if (catalogError) {
    return `${first.title} could not be verified against the current governed source catalog. Refresh or reselect the Dataset before previewing or publishing.`;
  }
  if (!source) {
    return `${first.title} no longer resolves in the current governed source catalog. Select a replacement Dataset before previewing or publishing.`;
  }
  if (source.sourceRevision !== binding.sourceRevision) {
    return `${first.title} changed Dataset source revision after publication. Refresh or reselect the Dataset before previewing or publishing.`;
  }
  const dataset = source.capabilities.dataset;
  if (!dataset) {
    return `${first.title} no longer exposes a field-based Dataset contract. Select a replacement Dataset before previewing or publishing.`;
  }
  if (dataset.sourceRevision !== binding.sourceRevision
    || dataset.binding.sourceRevision !== binding.sourceRevision) {
    return `${first.title} has an inconsistent current Dataset source revision. Refresh or reselect the Dataset before previewing or publishing.`;
  }
  if (dataset.contractRef.fingerprint !== binding.contractFingerprint) {
    return `${first.title} changed its approved Dataset field contract after publication. Refresh or reselect the Dataset before previewing or publishing.`;
  }
  if (dataset.binding.contractFingerprint !== binding.contractFingerprint) {
    return `${first.title} has an inconsistent current Dataset field contract. Refresh or reselect the Dataset before previewing or publishing.`;
  }
  return undefined;
}

/**
 * Rehydrate the canonical source registry when a Git-owned App is opened in
 * Studio. Page Dataset bindings are historical intent/provenance. Current
 * catalog records are the only authority for source capabilities and trust.
 * A missing, stale, or unreachable current record becomes a non-executable
 * review placeholder so the local draft remains repairable without silently
 * changing its selected source revision or field contract.
 */
function rehydratePublishedAppSources(
  pages: DashboardDocument[],
  sourcePolicy: AppBuildSourcePolicy,
  options: CreateStoredAppBuildDraftOptions = {},
): {
  pages: DashboardDocument[];
  sources: AppBuildDraftSource[];
  reviewTasks: AppBuildDraft['reviewTasks'];
  requiresReviewPolicy: boolean;
} {
  const sources = new Map<string, AppBuildDraftSource>();
  const reviewTasks = new Map<string, AppBuildDraft['reviewTasks'][number]>();
  let requiresReviewPolicy = false;
  const datasetReferences = publishedDatasetSourceReferences(pages);
  const datasetReferencesBySourceId = new Map<string, PublishedDatasetSourceReference[]>();
  for (const reference of datasetReferences) {
    const values = datasetReferencesBySourceId.get(reference.sourceId) ?? [];
    values.push(reference);
    datasetReferencesBySourceId.set(reference.sourceId, values);
  }
  let resolution: PublishedDatasetSourceResolution | undefined;
  let catalogError = options.datasetCatalogError;
  if (datasetReferencesBySourceId.size > 0 && options.resolvePublishedDatasetSources && !catalogError) {
    try {
      resolution = options.resolvePublishedDatasetSources(Array.from(datasetReferencesBySourceId.keys()), APP_SOURCE_POLICY);
    } catch (error) {
      catalogError = error instanceof Error ? error.message : String(error);
    }
  }
  const recordsBySourceId = new Map((resolution?.items ?? []).map((source) => [source.sourceId, source]));
  for (const [sourceId, references] of datasetReferencesBySourceId) {
    const source = recordsBySourceId.get(sourceId);
    const issue = publishedDatasetRestoreIssue(references, source, catalogError);
    const restored = issue ? publishedDatasetPlaceholder(references[0]) : appDraftSourceFromCatalog(source!);
    sources.set(sourceId, restored);
    if (issue) {
      requiresReviewPolicy = true;
      for (const reference of references) {
        const task = publishedDatasetReviewTask(reference, issue);
        reviewTasks.set(task.id, task);
      }
      continue;
    }
    // Data nobody certified reopens as it is (T3): its tiles read "Not
    // certified yet" and the App can be published again without a task.
  }
  const normalizedPages = pages.map((page) => ({
    ...page,
    layout: {
      ...page.layout,
      items: page.layout.items.map((tile) => {
        // Field-based tiles use the page Dataset binding above. Never rebuild
        // a Dataset source from serialized tile display metadata.
        if (tile.query) return tile;
        const hasDataSource = Boolean(tile.block || tile.semantic || tile.draftAnalysis || tile.aiPin);
        if (!hasDataSource) return tile;
        const blockRef = tile.block ? ('ref' in tile.block ? tile.block.ref : tile.block.blockId) : undefined;
        const sourceRef = blockRef
          ?? tile.draftAnalysis?.ref
          ?? tile.semantic?.id
          ?? tile.aiPin?.id
          ?? `${page.id}/${tile.i}`;
        const sourceRevision = tile.sourceRevision
          ?? tile.review?.sourceFingerprint
          ?? tile.draftAnalysis?.artifactFingerprint
          ?? tile.semantic?.definitionFingerprint;
        const sourceId = tile.sourceId
          ?? `published:${createHash('sha256').update(`${page.id}\0${tile.i}\0${sourceRef}`).digest('hex').slice(0, 20)}`;
        const certified = Boolean(
          tile.block
          && sourceRevision
          && tile.trustState === 'certified'
          && tile.review?.status !== 'required',
        );
        const kind: AppBuildDraftSource['kind'] = tile.semantic
          ? 'governed_semantic'
          : tile.draftAnalysis
            ? 'review_dql'
            : tile.block
              ? 'block'
              : 'text';
        const nextSource: AppBuildDraftSource = {
          id: sourceId,
          kind,
          sourceRef,
          qualifiedIdentity: tile.title || sourceRef,
          ...(tile.block ? { sourcePath: sourceRef, executionRef: sourceRef } : {}),
          ...(sourceRevision ? { sourceRevision, sourceFingerprint: sourceRevision } : {}),
          lifecycle: certified ? 'certified' : tile.draftAnalysis ? 'review' : 'unknown',
          capabilities: {
            measures: [],
            dimensions: [],
            outputs: [],
            filters: Array.from(new Set((tile.filterBindings ?? [])
              .filter((binding) => binding.capability !== 'unsupported')
              .map((binding) => binding.filter))),
            allowedVisualizations: Array.from(new Set([
              tile.viz.type,
              ...(tile.display?.allowedVisualizations ?? []),
            ])),
            parameters: [],
          },
          trustState: certified ? 'certified' : 'review_required',
          reviewStatus: certified ? 'not_required' : 'required',
        };
        const previous = sources.get(sourceId);
        if (!previous) {
          sources.set(sourceId, nextSource);
        } else if (
          previous.sourceRef !== nextSource.sourceRef
          || previous.sourceRevision !== nextSource.sourceRevision
          || previous.trustState !== nextSource.trustState
        ) {
          requiresReviewPolicy = true;
          sources.set(sourceId, {
            ...previous,
            lifecycle: 'unknown',
            trustState: 'review_required',
            reviewStatus: 'required',
          });
          reviewTasks.set(`published-source-${sourceId}`, {
            id: `published-source-${createHash('sha256').update(sourceId).digest('hex').slice(0, 12)}`,
            message: `${tile.title || sourceRef} has conflicting published source bindings. Refresh or replace it before publication.`,
            status: 'open',
            sourceId,
            pageId: page.id,
            tileId: tile.i,
          });
        }
        // A saved query nobody certified is not a task (T3); one with no
        // published revision cannot be checked and must be refreshed.
        if (tile.block && !sourceRevision) {
          requiresReviewPolicy = true;
          reviewTasks.set(`published-source-${sourceId}`, {
            id: `published-source-${createHash('sha256').update(sourceId).digest('hex').slice(0, 12)}`,
            message: sourceRevision
              ? `${tile.title || sourceRef} must be refreshed against the current project source before publication.`
              : `${tile.title || sourceRef} has no published source revision. Replace or refresh it before publication.`,
            status: 'open',
            sourceId,
            pageId: page.id,
            tileId: tile.i,
          });
        }
        return tile.sourceId === sourceId ? tile : { ...tile, sourceId, ...(sourceRevision ? { sourceRevision } : {}) };
      }),
    },
  }));
  return {
    pages: normalizedPages,
    sources: Array.from(sources.values()),
    reviewTasks: Array.from(reviewTasks.values()),
    requiresReviewPolicy,
  };
}

export function createStoredAppBuildDraft(
  projectRoot: string,
  input: {
    appId?: string; baseAppId?: string; name?: string; goal?: string; audience?: string; domain?: string;
    authoringMode?: 'ai' | 'manual'; sourcePolicy?: 'governed_only' | 'include_review_required';
    template?: 'executive_brief' | 'operational_dashboard' | 'investigation' | 'blank';
    entrypoint?: 'studio' | 'ask';
  },
  options: CreateStoredAppBuildDraftOptions = {},
): AppBuildDraft {
  const baseAppId = cleanString(input.baseAppId);
  const base = baseAppId ? loadAppById(projectRoot, baseAppId) : null;
  if (baseAppId && !base) throw new Error(`App "${baseAppId}" not found.`);
  // A described App is named from the first line of its description.
  const name = cleanString(input.name) || base?.app.name || appNameFromGoal(cleanString(input.goal)) || 'Untitled App';
  const appId = base?.app.id || cleanString(input.appId) || suggestAppId(name);
  const id = newAppBuildDraftId();
  const blankPage = createBlankAppBuildPage({
    name,
    goal: cleanString(input.goal),
    domain: cleanString(input.domain) || base?.app.domain,
    audience: cleanString(input.audience) || base?.app.audience,
  });
  const basePages = base
    ? findDashboardsForApp(base.appDir)
      .map((path) => loadDashboardDocument(path).document)
      .filter((page): page is DashboardDocument => Boolean(page))
    : [];
  const template = input.template ?? 'blank';
  // An older client's data rule is ignored (T3).
  const published = rehydratePublishedAppSources(
    basePages,
    APP_SOURCE_POLICY,
    options,
  );
  const pages = published.pages.length ? published.pages : [applyAppStudioTemplate(blankPage, template, name)];
  const draft = createAppBuildDraft({
    id,
    appId,
    name,
    ...(base ? { baseApp: { appId: base.app.id, fingerprint: fingerprintAppDirectory(base.appDir) } } : {}),
    authoringMode: input.authoringMode === 'manual' ? 'manual' : 'ai',
    template,
    frame: {
      goal: cleanString(input.goal) || `Create ${name}`,
      audience: cleanString(input.audience) || base?.app.audience || 'stakeholders',
      metrics: [], dimensions: [], filters: [], desiredOutput: 'One responsive analytical page',
      // Clarifications are returned only when the App-specific planner finds a
      // material ambiguity. A synthetic unanswered question here used to make
      // every new AI draft enter a UI dead-end before planning even ran.
      clarificationQuestions: [],
    },
    sources: published.sources,
    pages,
    reviewTasks: published.reviewTasks,
  });
  writeStoredAppBuildDraft(projectRoot, draft);
  return draft;
}

export interface AppBuildAskResultInput {
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
  /** The Ask answer (the person's own run): what it read, and its SQL for a live tile. */
  runId?: string;
  /** `live`: a tile that runs the answer's SQL for each reader, instead of its text. */
  mode?: 'text' | 'live';
}

/** With a host, an AI pin is per person and not shared App content. */
export const AI_PIN_ONLY_YOU = 'Only you see this pin; keep it as a live tile to share it.';

/** Refused where an answer's figures depend on who is looking (with a host). */
export const ANSWER_FIGURES_DEPEND_ON_READER = 'This answer\'s figures depend on who is looking. Add it as a live tile instead.';
/** What other readers read in place of such a tile until a steward replaces it. */
export const STATIC_ANSWER_TILE_PLACEHOLDER = 'This answer\'s figures depend on who is looking. A steward needs to replace it with a live tile.';

/**
 * With a host: a page as this reader may see it. An Ask answer published as text before the rule (its author's
 * figures, where figures depend on who is looking) shows the placeholder instead, wherever the page goes (the
 * reader, page runs and what is made from them: stories, snapshots, digests, agents), unless the reader may
 * replace it (mayKeep). Without a host the page is unchanged.
 */
export async function pageForReader<T extends { layout: { items: unknown[] } }>(
  page: T,
  depends: Ctx['figuresDependOnReader'],
  mayKeep?: () => Promise<boolean>,
): Promise<T> {
  if (!depends) return page;
  const shown = await staticAnswerTilesShownToOthers([{ id: '', layout: page.layout }], depends);
  if (!shown.length) return page;
  if (mayKeep && await mayKeep().catch(() => false)) return page;
  const withheld = new Set(shown.map((tile) => tile.tileId));
  return {
    ...page,
    layout: {
      ...page.layout,
      items: page.layout.items.map((tile) => (withheld.has(String((tile as { i?: unknown }).i ?? ''))
        ? { ...(tile as Record<string, unknown>), text: { markdown: STATIC_ANSWER_TILE_PLACEHOLDER }, figuresWithheld: 'depends_on_reader' }
        : tile)),
    },
  };
}

/** What stewards read beside such a tile already published. */
export const STATIC_ANSWER_TILE_NOTICE = 'This tile shows an Ask answer\'s text with the figures its author saw, and those figures depend on who is looking. Replace it with a live tile, which runs for each reader.';
const ANSWER_RELATION = 'answer_relation';

/** An Ask answer added as its text: no certified block, DQL or SQL that could run for each reader. */
function isStaticAnswerResult(input: AppBuildAskResultInput): boolean {
  return !cleanString(input.certifiedBlockId) && !cleanString(input.dqlSource) && !cleanString(input.sql);
}

/** A tile that shows an Ask answer's written text (the figures its author saw), not a query run for each reader. */
export function isStaticAnswerTile(tile: unknown): boolean {
  if (!tile || typeof tile !== 'object') return false;
  const record = tile as { text?: unknown; sourceEvidence?: unknown };
  if (!record.text || typeof record.text !== 'object') return false;
  return Array.isArray(record.sourceEvidence) && record.sourceEvidence.some((evidence) => typeof (evidence as { source?: unknown })?.source === 'string'
    && ((evidence as { source: string }).source.startsWith('ask:')));
}

/** The tables the answer behind such a tile read, as recorded when it was added; undefined when not known. */
function staticAnswerTileRelations(tile: unknown): string[] | undefined {
  const evidence = Array.isArray((tile as { sourceEvidence?: unknown })?.sourceEvidence) ? (tile as { sourceEvidence: unknown[] }).sourceEvidence : [];
  const relations = evidence
    .filter((entry) => (entry as { kind?: unknown })?.kind === ANSWER_RELATION && typeof (entry as { source?: unknown }).source === 'string')
    .map((entry) => (entry as { source: string }).source);
  return relations.length ? relations : undefined;
}

/** The static answer tiles on these pages whose figures would differ for another reader. */
async function staticAnswerTilesShownToOthers(
  pages: Array<{ id: string; layout: { items: unknown[] } }>,
  depends: Ctx['figuresDependOnReader'],
): Promise<Array<{ pageId: string; tileId: string; title?: string }>> {
  if (!depends) return [];
  const found: Array<{ pageId: string; tileId: string; title?: string }> = [];
  for (const page of pages) {
    for (const tile of page.layout?.items ?? []) {
      if (!isStaticAnswerTile(tile)) continue;
      if (!(await depends(staticAnswerTileRelations(tile)))) continue;
      const record = tile as { i?: unknown; title?: unknown };
      found.push({ pageId: page.id, tileId: String(record.i ?? ''), ...(typeof record.title === 'string' ? { title: record.title } : {}) });
    }
  }
  return found;
}

const staticAnswerKey = (tile: unknown) => `${String((tile as { i?: unknown }).i ?? '')}\u0000${String((tile as { text?: { markdown?: unknown } }).text?.markdown ?? '')}`;

/** Static answer tiles a draft edit adds (ones already in the draft, unchanged, may stay or move). */
async function addedStaticAnswerTilesInDraft(
  current: AppBuildDraft,
  next: AppBuildDraft,
  depends: Ctx['figuresDependOnReader'],
): Promise<Array<{ pageId: string; tileId: string }>> {
  if (!depends) return [];
  const kept = new Set(current.pages.flatMap((page) => page.layout.items).filter(isStaticAnswerTile).map(staticAnswerKey));
  return staticAnswerTilesShownToOthers(next.pages.map((page) => ({
    id: page.id,
    layout: { items: page.layout.items.filter((tile) => isStaticAnswerTile(tile) && !kept.has(staticAnswerKey(tile))) },
  })), depends);
}

/** A page write that adds such a tile (one already on the page, unchanged, may stay). */
async function addedStaticAnswerTilesRefusal(
  projectRoot: string,
  appId: string,
  dashboardId: string,
  payload: unknown,
  depends: Ctx['figuresDependOnReader'],
): Promise<{ ok: false; code: string; error: string; tiles: string[] } | null> {
  if (!depends || !payload || typeof payload !== 'object') return null;
  const body = payload as { layout?: { items?: unknown }; items?: unknown };
  const items = Array.isArray(body.layout?.items) ? body.layout!.items as unknown[] : Array.isArray(body.items) ? body.items : [];
  const key = staticAnswerKey;
  const current = loadDashboardForApp(projectRoot, decodeURIComponent(appId), decodeURIComponent(dashboardId))?.dashboard.layout.items ?? [];
  const kept = new Set(current.filter(isStaticAnswerTile).map(key));
  const added = items.filter((tile) => isStaticAnswerTile(tile) && !kept.has(key(tile)));
  const refused = await staticAnswerTilesShownToOthers([{ id: dashboardId, layout: { items: added } }], depends);
  return refused.length ? { ok: false, code: 'ANSWER_FIGURES_DEPEND_ON_READER', error: ANSWER_FIGURES_DEPEND_ON_READER, tiles: refused.map((tile) => tile.tileId) } : null;
}

/**
 * Adds an Ask result to the same local AppBuildDraft used by manual and AI
 * authoring. Certified answers retain their block identity. Exploratory DQL is
 * materialized as an app-scoped local artifact and remains review-required;
 * SQL is never embedded in the dashboard JSON or written to Project source.
 */
export function addAskResultToAppBuildDraft(
  projectRoot: string,
  draftId: string,
  input: AppBuildAskResultInput,
  options: { hosted?: boolean; relations?: string[] } = {},
): { ok: true; draft: AppBuildDraft; pageId: string; tileId: string; deduped: boolean } {
  const draft = loadStoredAppBuildDraft(projectRoot, draftId);
  if (!draft) throw new Error('App Build Draft not found.');
  if (input.expectedRevision !== draft.revision || input.expectedProposalHash !== draft.proposalHash) {
    throw new Error('APP_BUILD_REVISION_CONFLICT: refresh the local draft before adding this Ask result.');
  }
  const page = draft.pages.find((candidate) => candidate.id === cleanString(input.pageId)) ?? draft.pages[0];
  if (!page) throw new Error('The local App draft needs a page before adding an Ask result.');

  const question = cleanString(input.question).slice(0, 500);
  const answer = cleanString(input.answer).slice(0, 40_000);
  const title = (cleanString(input.title) || titleForGapQuestion(question || 'Ask result')).slice(0, 120);
  const requestedBlockId = cleanString(input.certifiedBlockId);
  const dqlSource = cleanString(input.dqlSource);
  const sql = cleanString(input.sql);
  if (dqlSource.length > 400_000 || sql.length > 200_000) throw new Error('Ask result source exceeds the local App artifact limit.');
  const sourceIdentity = requestedBlockId || dqlSource || sql || `${question}\n${answer}`;
  if (!sourceIdentity) throw new Error('The Ask result did not include reusable evidence.');
  const identity = createHash('sha256').update(sourceIdentity).digest('hex').slice(0, 16);
  const tileId = `ask-${identity}`;
  if (draft.pages.some((candidate) => candidate.layout.items.some((tile) => tile.i === tileId))) {
    return { ok: true, draft, pageId: page.id, tileId, deduped: true };
  }

  const nextY = page.layout.items.reduce((max, tile) => Math.max(max, tile.y + tile.h), 0);
  const viz = normalizeGeneratedViz(input.visualization) as DashboardGridItem['viz']['type'];
  const operations: AppBuildDraftOperation[] = [];
  let artifactPath: string | undefined;
  let artifactWasCreated = false;
  let tile: DashboardGridItem;

  if (requestedBlockId) {
    const block = collectBlockCandidates(projectRoot).find((candidate) => candidate.status === 'certified'
      && (candidate.id === requestedBlockId || candidate.name === requestedBlockId || candidate.path === requestedBlockId));
    if (!block) throw new Error(`Certified saved query "${requestedBlockId}" is no longer available.`);
    const sourceId = `block:${block.id}`;
    operations.push({
      type: 'upsert_source',
      source: {
        id: sourceId,
        kind: 'certified_block',
        sourceRef: block.id,
        sourceFingerprint: block.fingerprint,
        trustState: 'certified',
        reviewStatus: 'not_required',
      },
    });
    tile = {
      i: tileId, x: 0, y: nextY, w: 6, h: 4,
      block: { blockId: block.id },
      viz: { type: viz === 'table' ? normalizeVizType(block.chartType) : viz },
      title,
      sourceClass: 'certified_block',
      filterBindings: block.filterIds.map((filter) => ({ filter, binding: filter, mode: 'predicate', capability: 'preflight_required' })),
      sourceEvidence: [{ source: block.id, reason: question ? `Ask answer for: ${question}` : 'Added from a certified Ask answer.', kind: 'certified_block', trustState: 'certified' }],
      review: { status: 'not_required', sourceFingerprint: block.fingerprint },
      trustState: 'certified',
      reviewStatus: 'certified',
    };
  } else if (dqlSource || sql) {
    const sourceId = `review-dql:ask-${identity}`;
    const sourceRef = `analysis/ask-${identity}.dql`;
    const source = dqlSource || [
      `block "ask_${identity}" {`,
      `  domain = "${escapeDqlString(page.metadata.domain ?? 'general')}"`,
      '  type = "custom"',
      '  status = "review"',
      '  owner = "local-ask"',
      // With a host, a live tile's source says what it answers, not the figures its author saw.
      `  description = "${escapeDqlString((options.hosted ? question || title : answer || question || title).slice(0, 2_000))}"`,
      question ? `  llmContext = "${escapeDqlString(`Ask result: ${question}`)}"` : '',
      '  caveats = ["Ask-generated local analysis. Validate joins, grain, filters, and interpretation before promotion."]',
      '  tags = ["app-scoped", "ask-generated", "needs-review"]',
      '',
      '  query = """',
      sql,
      '  """',
      '',
      '  visualization {',
      `    chart = "${escapeDqlString(normalizeGeneratedViz(input.visualization))}"`,
      '  }',
      '}',
      '',
    ].filter(Boolean).join('\n');
    const fingerprint = `sha256:${createHash('sha256').update(source).digest('hex')}`;
    artifactPath = join(projectRoot, '.dql', 'local', 'app-builds', draft.id, sourceRef);
    operations.push(
      {
        type: 'upsert_source',
        source: {
          id: sourceId,
          kind: 'review_dql',
          sourceRef,
          qualifiedIdentity: title,
          sourceFingerprint: fingerprint,
          trustState: 'review_required',
          reviewStatus: 'required',
        },
      },
      {
        type: 'set_review_task',
        task: {
          id: `review-ask-${identity}`,
          message: `Validate the joins, grain, filters, and business interpretation for ${title}.`,
          status: 'open',
          sourceId,
          pageId: page.id,
          tileId,
        },
      },
    );
    tile = {
      i: tileId, x: 0, y: nextY, w: 6, h: 4,
      draftAnalysis: { ref: sourceRef, artifactFingerprint: fingerprint },
      viz: { type: viz },
      title,
      sourceClass: 'exploratory_analysis',
      sourceEvidence: [{ source: sourceRef, reason: question ? `Ask generated this private analysis for: ${question}` : 'Ask generated this private analysis.', kind: 'review_dql', trustState: 'review_required' }],
      review: { status: 'required', sourceFingerprint: fingerprint },
      trustState: 'review_required',
      reviewStatus: 'review_required',
    };
    if (!existsSync(artifactPath)) {
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, source, 'utf-8');
      artifactWasCreated = true;
    }
  } else {
    const sourceId = `text:ask-${identity}`;
    operations.push(
      { type: 'upsert_source', source: { id: sourceId, kind: 'text', sourceRef: `ask:${identity}`, trustState: 'review_required', reviewStatus: 'required' } },
      { type: 'set_review_task', task: { id: `review-ask-${identity}`, message: `Review the Ask narrative ${title} before publication.`, status: 'open', sourceId, pageId: page.id, tileId } },
    );
    tile = {
      i: tileId, x: 0, y: nextY, w: 12, h: 2,
      text: { markdown: answer || question },
      viz: { type: 'text' },
      title,
      sourceClass: 'narrative',
      sourceEvidence: [
        { source: `ask:${identity}`, reason: 'Saved from Ask as an editable review-required narrative.', kind: 'text', trustState: 'review_required' },
        // The tables the answer read, so ZLens can tell later whether its figures depend on who is looking.
        ...(options.relations ?? []).map((relation) => ({ source: relation, reason: 'A table the answer read.', kind: ANSWER_RELATION })),
      ],
      review: { status: 'required' },
      trustState: 'review_required',
      reviewStatus: 'review_required',
    };
  }

  operations.push({ type: 'add_tile', pageId: page.id, tile });
  try {
    const next = applyAppBuildDraftOperations(draft, draft.revision, operations);
    writeStoredAppBuildDraft(projectRoot, next, { expectedRevision: draft.revision, operations });
    return { ok: true, draft: next, pageId: page.id, tileId, deduped: false };
  } catch (error) {
    if (artifactWasCreated && artifactPath) rmSync(artifactPath, { force: true });
    throw error;
  }
}

function applyAppStudioTemplate(
  page: DashboardDocument,
  template: 'executive_brief' | 'operational_dashboard' | 'investigation' | 'blank',
  appName: string,
): DashboardDocument {
  if (template === 'blank') return page;
  const intro = template === 'executive_brief'
    ? `# ${appName}\n\nState the decision this brief supports, then add governed evidence below.`
    : template === 'operational_dashboard'
      ? `# ${appName}\n\nMonitor current performance, changes, and the details that require action.`
      : `# ${appName}\n\nDocument the question, findings, caveats, and evidence for this investigation.`;
  const items: DashboardGridItem[] = [{
    i: 'template-introduction', x: 0, y: 0, w: 12, h: 2,
    title: template === 'investigation' ? 'Investigation question' : 'Intro',
    sectionId: 'exec_summary',
    text: { markdown: intro },
    viz: { type: 'text' },
    sourceClass: 'narrative',
    trustState: 'draft_ready',
    reviewStatus: 'draft_ready',
  }];
  const sections = template === 'investigation'
    ? [
      { id: 'exec_summary', title: 'Question', kind: 'exec_summary' as const, order: 0 },
      { id: 'insight', title: 'Findings and comparisons', kind: 'insight' as const, order: 1 },
      { id: 'appendix', title: 'Caveats and evidence', kind: 'appendix' as const, order: 2 },
    ]
    : [
      { id: 'exec_summary', title: 'Executive summary', kind: 'exec_summary' as const, order: 0 },
      { id: 'kpi_band', title: 'Key metrics', kind: 'kpi_band' as const, order: 1 },
      { id: 'insight', title: template === 'executive_brief' ? 'Decision evidence' : 'Trends and drivers', kind: 'insight' as const, order: 2 },
      { id: 'appendix', title: 'Detail and evidence', kind: 'appendix' as const, order: 3 },
    ];
  return {
    ...page,
    sections,
    layout: {
      ...page.layout,
      items,
      responsive: responsiveLayoutsForDashboardItems(items),
    },
  };
}

export function loadStoredAppBuildDraft(projectRoot: string, id: string): AppBuildDraft | null {
  const clean = cleanString(id);
  if (!clean || !/^[a-z0-9_:-]+$/i.test(clean)) return null;
  const storage = openAppStorage(projectRoot);
  try {
    const stored = storage.getAppBuildDraft(clean);
    if (stored) {
      const migrated = migrateLegacyAppBuildDraft(projectRoot, stored);
      if (migrated && stored.version !== migrated.version) storage.saveAppBuildDraft(migrated);
      return migrated;
    }
    const legacyPath = join(appBuildDraftDir(projectRoot), `${clean}.json`);
    if (!existsSync(legacyPath)) return null;
    const migrated = migrateLegacyAppBuildDraft(projectRoot, JSON.parse(readFileSync(legacyPath, 'utf-8')));
    if (!migrated) return null;
    storage.saveAppBuildDraft(migrated);
    return migrated;
  } catch {
    return null;
  } finally {
    storage.close();
  }
}

export function writeStoredAppBuildDraft(
  projectRoot: string,
  draft: AppBuildDraft,
  input: { expectedRevision?: number; operations?: AppBuildDraftOperation[] } = {},
): void {
  const storage = openAppStorage(projectRoot);
  try {
    storage.saveAppBuildDraft(draft, input);
  } finally {
    storage.close();
  }
}

function migrateLegacyAppBuildDraft(projectRoot: string, value: unknown): AppBuildDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const legacy = value as Record<string, unknown>;
  if (legacy.version === 3) return legacy as unknown as AppBuildDraft;
  if (legacy.version === 2) return migrateV2AppBuildDraft(projectRoot, legacy);
  if (legacy.version !== 1 || typeof legacy.id !== 'string' || typeof legacy.appId !== 'string') return null;
  const frame = (legacy.frame && typeof legacy.frame === 'object' ? legacy.frame : {}) as Record<string, unknown>;
  const clarificationQuestions = Array.isArray(frame.clarificationQuestions)
    ? frame.clarificationQuestions.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const question = raw as Record<string, unknown>;
      if (typeof question.id !== 'string' || typeof question.question !== 'string') return [];
      const choices = Array.isArray(question.choices)
        ? question.choices.map((choice, index) => typeof choice === 'string'
          ? { id: slugify(choice) || `choice-${index + 1}`, label: choice }
          : choice).filter((choice): choice is { id: string; label: string } => Boolean(choice && typeof choice === 'object' && 'id' in choice && 'label' in choice))
        : [];
      return [{ id: question.id, question: question.question, choices, required: question.required !== false }];
    })
    : [];
  const migrated = createAppBuildDraft({
    id: legacy.id,
    appId: legacy.appId,
    name: typeof legacy.name === 'string' ? legacy.name : (typeof frame.goal === 'string' ? frame.goal : legacy.appId),
    authoringMode: legacy.authoringMode === 'manual' ? 'manual' : 'ai',
    sourcePolicy: legacy.sourcePolicy === 'include_review_required' ? 'include_review_required' : 'governed_only',
    frame: {
      goal: typeof frame.goal === 'string' ? frame.goal : `Create ${legacy.appId}`,
      decision: typeof frame.decision === 'string' ? frame.decision : undefined,
      audience: typeof frame.audience === 'string' ? frame.audience : undefined,
      metrics: Array.isArray(frame.metrics) ? frame.metrics.filter((item): item is string => typeof item === 'string') : [],
      dimensions: Array.isArray(frame.dimensions) ? frame.dimensions.filter((item): item is string => typeof item === 'string') : [],
      filters: Array.isArray(frame.filters) ? frame.filters.filter((item): item is string => typeof item === 'string') : [],
      desiredOutput: typeof frame.desiredOutput === 'string' ? frame.desiredOutput : undefined,
      clarificationQuestions,
    },
    sources: Array.isArray(legacy.sources) ? legacy.sources as AppBuildDraft['sources'] : [],
    pages: Array.isArray(legacy.pages) ? legacy.pages as DashboardDocument[] : [],
    reviewTasks: Array.isArray(legacy.reviewTasks) ? legacy.reviewTasks as AppBuildDraft['reviewTasks'] : [],
    now: typeof legacy.createdAt === 'string' ? legacy.createdAt : undefined,
  });
  return {
    ...migrated,
    revision: typeof legacy.revision === 'number' ? legacy.revision : migrated.revision,
    updatedAt: typeof legacy.updatedAt === 'string' ? legacy.updatedAt : migrated.updatedAt,
  };
}

function migrateV2AppBuildDraft(projectRoot: string, legacy: Record<string, unknown>): AppBuildDraft | null {
  if (typeof legacy.id !== 'string' || typeof legacy.appId !== 'string') return null;
  const declarations = collectBlockCandidates(projectRoot, { preserveDuplicates: true });
  const oldSources = Array.isArray(legacy.sources) ? legacy.sources as Array<Record<string, unknown>> : [];
  const idMap = new Map<string, string>();
  const revisionById = new Map<string, string>();
  const pathById = new Map<string, string>();
  const migrationTasks: AppBuildDraft['reviewTasks'] = [];
  const sources: AppBuildDraftSource[] = oldSources.flatMap((raw, index) => {
    const oldId = cleanString(raw.id) || `legacy-source-${index + 1}`;
    const kind = cleanString(raw.kind);
    if (!['block', 'certified_block', 'review_block'].includes(kind)) {
      idMap.set(oldId, oldId);
      return [{ ...raw, id: oldId } as unknown as AppBuildDraftSource];
    }
    const sourceRef = cleanString(raw.sourceRef);
    const fingerprint = cleanString(raw.sourceFingerprint);
    const matches = declarations.filter((candidate) => (
      candidate.path === sourceRef
      || candidate.id === sourceRef
      || candidate.name === sourceRef
      || candidate.path.endsWith(`/${sourceRef}`)
    ) && (!fingerprint || candidate.fingerprint === fingerprint));
    if (matches.length === 1) {
      const candidate = matches[0];
      const id = canonicalAppBlockSourceId(candidate);
      idMap.set(oldId, id);
      revisionById.set(id, candidate.fingerprint);
      pathById.set(id, candidate.path);
      const certified = candidate.status === 'certified';
      return [{
        id,
        kind: 'block',
        sourceRef: candidate.path,
        qualifiedIdentity: `${candidate.domain || 'global'}::block::${candidate.name}`,
        sourcePath: candidate.path,
        executionRef: candidate.path,
        sourceRevision: candidate.fingerprint,
        sourceFingerprint: candidate.fingerprint,
        lifecycle: certified ? 'certified' : candidate.status === 'review' ? 'review' : 'draft',
        capabilities: {
          measures: [],
          dimensions: candidate.dimensionIds,
          outputs: [],
          filters: candidate.filterIds,
          chartType: candidate.chartType,
          allowedVisualizations: candidate.chartType ? [candidate.chartType] : [],
          parameters: [],
        },
        trustState: certified ? 'certified' : 'review_required',
        reviewStatus: certified ? 'not_required' : 'required',
      }];
    }
    idMap.set(oldId, oldId);
    migrationTasks.push({
      id: `legacy-source-${createHash('sha256').update(oldId).digest('hex').slice(0, 12)}`,
      message: matches.length > 1
        ? `Legacy source ${sourceRef || oldId} is ambiguous. Select the exact path and revision before previewing or publishing.`
        : `Legacy source ${sourceRef || oldId} no longer resolves. Replace or remove it before previewing or publishing.`,
      status: 'open',
      sourceId: oldId,
    });
    return [{
      id: oldId,
      kind: 'block',
      sourceRef: sourceRef || oldId,
      qualifiedIdentity: cleanString(raw.qualifiedIdentity) || sourceRef || oldId,
      sourceRevision: fingerprint || undefined,
      sourceFingerprint: fingerprint || undefined,
      lifecycle: 'unknown',
      capabilities: { measures: [], dimensions: [], outputs: [], filters: [], allowedVisualizations: [], parameters: [] },
      trustState: 'review_required',
      reviewStatus: 'required',
    }];
  });
  const pages = (Array.isArray(legacy.pages) ? legacy.pages as DashboardDocument[] : []).map((page) => ({
    ...page,
    layout: {
      ...page.layout,
      items: page.layout.items.map((item) => {
        if (item.sourceId) return item;
        const blockRef = item.block
          ? ('ref' in item.block ? item.block.ref : item.block.blockId)
          : undefined;
        if (!blockRef) return item;
        const oldSource = oldSources.find((source) => {
          const ref = cleanString(source.sourceRef);
          return ref === blockRef || cleanString(source.id) === `block:${blockRef}` || cleanString(source.id) === `review-block:${blockRef}`;
        });
        const sourceId = oldSource ? idMap.get(cleanString(oldSource.id)) : undefined;
        if (!sourceId) return item;
        return {
          ...item,
          sourceId,
          sourceRevision: revisionById.get(sourceId) ?? (cleanString(oldSource?.sourceFingerprint) || undefined),
          ...(pathById.get(sourceId) ? { block: { ref: pathById.get(sourceId)! } } : {}),
        };
      }),
    },
  }));
  const coverage = (Array.isArray(legacy.coverage) ? legacy.coverage as AppBuildDraft['coverage'] : []).map((item) => ({
    ...item,
    sourceIds: item.sourceIds.map((id) => idMap.get(id) ?? id),
  }));
  const migratedWithoutHash = {
    ...(legacy as unknown as AppBuildDraft),
    version: 3 as const,
    sources,
    pages,
    coverage,
    reviewTasks: [
      ...(Array.isArray(legacy.reviewTasks) ? legacy.reviewTasks as AppBuildDraft['reviewTasks'] : []),
      ...migrationTasks,
    ],
  };
  return {
    ...migratedWithoutHash,
    proposalHash: appBuildDraftHash({ ...migratedWithoutHash, proposalHash: undefined }),
  };
}

export function deleteStoredAppBuildDraft(
  projectRoot: string,
  draft: AppBuildDraft,
): { ok: true; id: string; recoveryId: string; recoverableUntilRestart: false } {
  const storage = openAppStorage(projectRoot);
  let deleted: ReturnType<LocalAppStorage['deleteAppBuildDraft']>;
  try {
    deleted = storage.deleteAppBuildDraft(draft.id);
  } finally {
    storage.close();
  }
  if (!deleted) throw new Error(`App Build Draft not found: ${draft.id}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recoveryId = `draft-${stamp}-${draft.id}`;
  const recoveryDir = join(projectRoot, '.dql', 'local', 'trash', 'app-drafts', recoveryId);
  const localArtifactsDir = join(projectRoot, '.dql', 'local', 'app-builds', draft.id);
  const recoveryArtifactsDir = join(recoveryDir, 'artifacts');
  let artifactsMoved = false;
  try {
    mkdirSync(recoveryDir, { recursive: true });
    if (existsSync(localArtifactsDir)) {
      renameSync(localArtifactsDir, recoveryArtifactsDir);
      artifactsMoved = true;
    }
    writeFileSync(join(recoveryDir, 'recovery.json'), JSON.stringify({
      version: 1,
      kind: 'app_build_draft',
      recoveryId,
      deletedAt: new Date().toISOString(),
      draft: deleted.draft,
      operations: deleted.operations,
    }, null, 2) + '\n', 'utf-8');
  } catch (error) {
    if (artifactsMoved && existsSync(recoveryArtifactsDir)) {
      mkdirSync(dirname(localArtifactsDir), { recursive: true });
      renameSync(recoveryArtifactsDir, localArtifactsDir);
    }
    const restore = openAppStorage(projectRoot);
    try { restore.restoreAppBuildDraft(deleted.draft, deleted.operations); } finally { restore.close(); }
    rmSync(recoveryDir, { recursive: true, force: true });
    throw error;
  }
  return { ok: true, id: draft.id, recoveryId, recoverableUntilRestart: false };
}

function restoreStoredAppBuildDraft(
  projectRoot: string,
  recoveryId: string,
): { ok: true; id: string; restoredPath: string; draft: AppBuildDraft } | { ok: false; status: 400 | 404 | 409; error: string } {
  const recoveryDir = join(projectRoot, '.dql', 'local', 'trash', 'app-drafts', recoveryId);
  const recoveryPath = join(recoveryDir, 'recovery.json');
  if (!existsSync(recoveryPath)) return { ok: false, status: 404, error: 'App recovery bundle not found.' };
  let payload: { kind?: string; draft?: AppBuildDraft; operations?: Array<{ id: number; draftId: string; revision: number; operations: AppBuildDraftOperation[]; createdAt: string }> };
  try { payload = JSON.parse(readFileSync(recoveryPath, 'utf-8')); } catch { return { ok: false, status: 400, error: 'App draft recovery bundle is invalid.' }; }
  if (payload.kind !== 'app_build_draft' || !payload.draft) return { ok: false, status: 400, error: 'App draft recovery bundle is invalid.' };
  const recoveredArtifactsDir = join(recoveryDir, 'artifacts');
  const localArtifactsDir = join(projectRoot, '.dql', 'local', 'app-builds', payload.draft.id);
  const storage = openAppStorage(projectRoot);
  let artifactsRestored = false;
  try {
    if (storage.getAppBuildDraft(payload.draft.id)) return { ok: false, status: 409, error: `App Build Draft already exists: ${payload.draft.id}` };
    if (existsSync(localArtifactsDir)) return { ok: false, status: 409, error: `App Build Draft artifacts already exist: ${payload.draft.id}` };
    if (existsSync(recoveredArtifactsDir)) {
      mkdirSync(dirname(localArtifactsDir), { recursive: true });
      renameSync(recoveredArtifactsDir, localArtifactsDir);
      artifactsRestored = true;
    }
    storage.restoreAppBuildDraft(payload.draft, payload.operations ?? []);
  } catch (error) {
    if (artifactsRestored && existsSync(localArtifactsDir)) renameSync(localArtifactsDir, recoveredArtifactsDir);
    throw error;
  } finally {
    storage.close();
  }
  rmSync(recoveryDir, { recursive: true, force: true });
  return { ok: true, id: payload.draft.id, restoredPath: '.dql/local/apps.sqlite', draft: payload.draft };
}

/** Current evidence for the tile trust check: the current catalog and model, when the caller resolved them. */
type AppBuildTrustEvidence = {
  descriptorFor?: (sourceId: string) => DatasetDescriptor | undefined;
  recordFor?: (sourceId: string) => AppSourceCatalogRecord | undefined;
};

export function preflightStoredAppBuildDraft(
  projectRoot: string,
  draft: AppBuildDraft,
  options: {
    /** Current evidence for the project's require-certified check; `false` when the caller runs it against the current catalog itself. */
    trust?: AppBuildTrustEvidence | false;
  } = {},
): string[] {
  const errors: string[] = [];
  const blocks = collectBlockCandidates(projectRoot);
  if (draft.state === 'clarification_required') errors.push('Resolve required Build Frame clarifications before publication.');
  if (draft.pages.length === 0) errors.push('App Build Draft needs at least one page.');
  for (const requirement of draft.requirements.filter((item) => appBuildRequirementBlocksPublication(draft, item))) {
    const coverage = draft.coverage.find((item) => item.requirementId === requirement.id);
    if (!coverage || coverage.status !== 'covered') errors.push(`Required App question is unresolved: ${requirement.question}`);
  }
  for (const task of draft.reviewTasks.filter((item) => appBuildReviewTaskBlocksPublication(draft, item))) {
    errors.push(`Review task is still open: ${task.message}`);
  }
  if (draft.baseApp) {
    const base = loadAppById(projectRoot, draft.baseApp.appId);
    if (!base || fingerprintAppDirectory(base.appDir) !== draft.baseApp.fingerprint) {
      errors.push('The published App changed after this local draft was created. Refresh the draft before publishing.');
    }
  }
  for (const page of draft.pages) {
    const parsed = parseDashboardDocument(JSON.stringify(page), `<app-build:${draft.id}/${page.id}>`);
    if (!parsed.document) errors.push(...parsed.errors.map((error) => error.message));
  }
  const analysisPages = draft.pages.filter((page) => page.layout.items.some((tile) => !tile.text && !tile.aiPin));
  const receipts = draft.previewReceipts ?? (draft.previewReceipt ? [draft.previewReceipt] : []);
  for (const page of analysisPages) {
    const receipt = receipts.find((candidate) => candidate.pageId === page.id);
    if (!receipt || receipt.revision !== draft.revision) errors.push(`Run a current settled preview for page ${page.metadata.title || page.id} before Project publication.`);
  }
  // Publication writes pages only. A source connected from the Data step that
  // no tile uses is not published, so it cannot block publishing (design D4).
  for (const source of appBuildSourcesUsedByTiles(draft)) {
    if (source.kind === 'block' || source.kind === 'certified_block') {
      const block = blocks.find((candidate) => candidate.id === source.sourceRef || candidate.name === source.sourceRef || candidate.path === source.sourceRef);
      const lifecycle = source.lifecycle ?? (source.kind === 'certified_block' ? 'certified' : block?.status);
      const boundRevision = source.sourceRevision ?? source.sourceFingerprint;
      if (!block) errors.push(`Source ${source.id} no longer resolves at ${source.sourceRef}.`);
      if (block && canonicalAppBlockSourceId(block) !== source.id && source.kind === 'block') errors.push(`Source ${source.id} no longer matches its qualified path identity.`);
      // A saved query nobody certified publishes (T3); one that is gone cannot.
      if (block?.status === 'deprecated') {
        errors.push(`Source ${source.qualifiedIdentity ?? source.id} is retired and cannot be published to the Project. Replace it with current data.`);
      }
      if (block && !boundRevision) {
        errors.push(`Source ${source.qualifiedIdentity ?? source.id} has no bound source revision; refresh it before Project publication.`);
      } else if (block && boundRevision !== block.fingerprint) {
        errors.push(`Source ${source.qualifiedIdentity ?? source.id} changed after selection.`);
      }
    }
    if (source.kind === 'governed_semantic' || source.kind === 'semantic_query') {
      if (source.capabilities?.dataset) {
        if (source.lifecycle === 'deprecated') {
          errors.push(`Dataset source ${source.qualifiedIdentity ?? source.id} is retired and cannot be published to the Project.`);
        }
        if (!source.sourceRevision) {
          errors.push(`Dataset source ${source.qualifiedIdentity ?? source.id} has no bound semantic source revision; refresh it before Project publication.`);
        }
      } else if (source.reviewStatus !== 'approved' || !source.snapshotId || !source.receiptId) {
        errors.push(`Source ${source.id} requires snapshot-bound semantic approval before Project publication.`);
      }
    }
    // App-scoped draft DQL lives only on this machine, so it cannot publish
    // (it is not a trust rule: a saved query nobody certified publishes).
    if (source.kind === 'review_dql' || source.kind === 'exploratory_sql') {
      errors.push(`Source ${source.id} is local draft analysis and cannot be published to the Project.`);
    }
  }
  for (const page of draft.pages) {
    for (const tile of page.layout.items) {
      if (!tile.query) continue;
      const source = tile.sourceId ? draft.sources.find((candidate) => candidate.id === tile.sourceId) : undefined;
      if (!source || !tile.sourceRevision) {
        errors.push(`${page.id}/${tile.i} has no exact Dataset source binding.`);
        continue;
      }
      const dataset = source.capabilities?.dataset;
      if (!dataset) {
        errors.push(`${page.id}/${tile.i} points to ${source.id}, which no longer exposes a field-based Dataset contract.`);
        continue;
      }
      const pageDataset = page.datasets?.find((binding) => binding.sourceId === tile.sourceId
        && binding.sourceRevision === tile.sourceRevision);
      if (!pageDataset) {
        errors.push(`${page.id}/${tile.i} is missing the matching page Dataset binding.`);
      } else if (pageDataset.contractFingerprint !== dataset.contractRef.fingerprint) {
        errors.push(`${page.id}/${tile.i} was authored against an older Dataset field contract.`);
      }
      if (source.sourceRevision !== tile.sourceRevision) {
        errors.push(`${page.id}/${tile.i} changed Dataset source revision after the tile was authored.`);
      }
      if (source.lifecycle === 'deprecated') {
        errors.push(`${page.id}/${tile.i} uses a retired Dataset source and cannot be published to the Project.`);
      }
      const validation = validateTileQuery(dataset, tile.query);
      if (!tileQueryValidationRuns(validation)) {
        errors.push(`${page.id}/${tile.i} has a Dataset field selection that is not fully covered by its approved contract.`);
      }
      const visualization = datasetTileVisualizationCompatibility(tile.query, tile.viz.type);
      if (!visualization.compatible) {
        errors.push(`${page.id}/${tile.i} has an incompatible Dataset visualization: ${visualization.message}`);
      }
      if (source.kind === 'block' || source.kind === 'certified_block') {
        const block = blocks.find((candidate) => candidate.path === source.executionRef || candidate.path === source.sourceRef);
        if (!block || block.fingerprint !== source.sourceRevision) {
          errors.push(`${page.id}/${tile.i} does not resolve to its current saved query.`);
        }
      } else if (source.kind === 'governed_semantic' || source.kind === 'semantic_query') {
        if (dataset.kind !== 'semantic' || Object.keys(source.capabilities?.metricCapabilities ?? {}).length === 0) {
          errors.push(`${page.id}/${tile.i} no longer has exact per-measure semantic authority.`);
        }
      } else {
        errors.push(`${page.id}/${tile.i} uses a non-governed Dataset source kind.`);
      }
    }
  }
  const settledPageIds = new Set(receipts.filter((receipt) => receipt.revision === draft.revision).map((receipt) => receipt.pageId));
  const settings = readAppsPublishSettings(projectRoot);
  // Trust is reported once, per tile, below; readiness reports the rest.
  const readiness = appPublicationReadiness(projectRoot, draft.pages, { settledPageIds, settings: { requireCertifiedToPublish: false } });
  errors.push(...readiness.blockers.map((blocker) => blocker.message));
  // The project may require every tile to be certified (T3). The HTTP route
  // repeats this against the current model; this keeps direct callers honest.
  if (settings.requireCertifiedToPublish && options.trust !== false) {
    const tiles = notCertifiedTiles(appBuildDraftTrust(draft, { ...(options.trust || {}), blocks }));
    if (tiles.length) errors.push(requireCertifiedToPublishMessage(tiles));
  }
  return Array.from(new Set(errors));
}

async function preflightAppBuildRequestErrors(
  projectRoot: string,
  draft: AppBuildDraft,
  verifyPreview: Ctx['verifyAppBuildPreview'],
  resolver?: Ctx['resolveDatasetSourceAuthority'],
  figuresDependOnReader?: Ctx['figuresDependOnReader'],
): Promise<string[]> {
  // The tile trust check runs once, below, against the current catalog.
  const errors = preflightStoredAppBuildDraft(projectRoot, draft, { trust: false });
  // An Ask answer's text with its author's figures is not published where they depend on who is looking.
  for (const tile of await staticAnswerTilesShownToOthers(draft.pages, figuresDependOnReader)) {
    errors.push(`${tile.pageId}/${tile.tileId}: ${ANSWER_FIGURES_DEPEND_ON_READER}`);
  }
  // Local draft state is not authority for Dataset lifecycle. Re-resolve the
  // active catalog before a preflight or publish request so a source that was
  // downgraded after an earlier run cannot publish through a forged source
  // card, a removed review task, or an otherwise matching old receipt.
  errors.push(...await datasetDraftCurrentAuthorityErrors(projectRoot, draft, 'project_publish', resolver));
  // When the project requires certified data (apps.requireCertifiedToPublish),
  // every tile — its data, every join it can reach, its calculations' inputs —
  // must be certified, judged against the current catalog, model and saved
  // queries. One plain message, whatever kind of tile.
  if (readAppsPublishSettings(projectRoot).requireCertifiedToPublish) {
    const records = await resolveCurrentDatasetSourceRecords(projectRoot, datasetDraftSourceIds(draft), resolver)
      .catch(() => new Map<string, AppSourceCatalogRecord>());
    const tiles = notCertifiedTiles(appBuildDraftTrust(draft, {
      descriptorFor: (sourceId) => records.get(sourceId)?.capabilities.dataset ?? undefined,
      recordFor: (sourceId) => records.get(sourceId),
      blocks: collectBlockCandidates(projectRoot),
    }));
    if (tiles.length) errors.push(requireCertifiedToPublishMessage(tiles));
  }
  const analysisPages = draft.pages
    .map((page) => ({
      pageId: page.id,
      tileIds: page.layout.items.filter((tile) => !tile.text && !tile.aiPin).map((tile) => tile.i),
      datasetTileIds: page.layout.items.filter((tile) => Boolean(tile.query)).map((tile) => tile.i),
    }))
    .filter((page) => page.tileIds.length > 0);
  const receipts = draft.previewReceipts ?? (draft.previewReceipt ? [draft.previewReceipt] : []);
  if (analysisPages.length > 0 && !verifyPreview) {
    errors.push('The runtime cannot verify the settled App preview receipts.');
  }
  for (const page of analysisPages) {
    const receipt = receipts.find((candidate) => candidate.pageId === page.pageId);
    if (!receipt || !verifyPreview) continue;
    const intentFingerprint = appBuildPreviewIntentFingerprint(draft, page.pageId);
    if (!receipt.intentFingerprint || receipt.intentFingerprint !== intentFingerprint) {
      errors.push(`The saved preview receipt for ${page.pageId} was produced by different App content. Run the current draft again before publication.`);
      continue;
    }
    const verified = await verifyPreview({
      runId: receipt.id,
      draftId: draft.id,
      dashboardId: page.pageId,
      tileIds: page.tileIds,
      ...(page.datasetTileIds.length ? { datasetTileIds: page.datasetTileIds } : {}),
      intentFingerprint,
      purpose: 'project_publish',
    });
    if (!verified.ok
      || verified.snapshotId !== receipt.snapshotId
      || verified.filterFingerprint !== receipt.filterFingerprint
      || verified.intentFingerprint !== receipt.intentFingerprint
      || verified.resultFingerprint !== receipt.resultFingerprint) {
      errors.push(verified.ok
        ? `The saved preview receipt for ${page.pageId} no longer matches the settled run.`
        : verified.error);
    }
  }
  return Array.from(new Set(errors));
}

/**
 * Preview receipts are server evidence, never a browser assertion. Before a
 * client can attach a run to its local draft, bind it to the exact current
 * page content and verify every result/fingerprint against the server's local
 * evidence registry. This rejects the dangerous A-run -> edit-to-B -> save-A
 * replay even when source IDs and the project filesystem snapshot match.
 */
async function bindServerIssuedPreviewReceipts(
  draft: AppBuildDraft,
  operations: AppBuildDraftOperation[],
  verifyPreview: Ctx['verifyAppBuildPreview'],
): Promise<AppBuildDraftOperation[]> {
  if (operations.some((operation) => operation.type === 'clear_preview_receipt')) {
    throw new Error('APP_BUILD_PREVIEW_RECEIPT_INVALID: receipt invalidation is issued only by the active App runtime.');
  }
  // A PATCH may try to edit query A into query B and attach A's run in the
  // same request.  Bind against the resulting authored content, not merely
  // the stored draft that existed before this PATCH.
  const contentOperations = operations.filter((operation) => operation.type !== 'set_preview_receipt');
  const receiptBindingDraft = contentOperations.length > 0
    ? applyAppBuildDraftOperations(draft, draft.revision, contentOperations)
    : draft;
  return Promise.all(operations.map(async (operation) => {
    if (operation.type !== 'set_preview_receipt') return operation;
    const receipt = operation.receipt;
    if (!receipt || typeof receipt.id !== 'string' || !receipt.id.trim() || typeof receipt.pageId !== 'string' || !receipt.pageId.trim()) {
      throw new Error('APP_BUILD_PREVIEW_RECEIPT_INVALID: a preview receipt needs a run ID and page ID.');
    }
    const page = receiptBindingDraft.pages.find((candidate) => candidate.id === receipt.pageId);
    if (!page) throw new Error(`APP_BUILD_PREVIEW_RECEIPT_INVALID: page ${receipt.pageId} is not in this local draft.`);
    if (!verifyPreview) throw new Error('APP_BUILD_PREVIEW_UNVERIFIABLE: run the current local draft from an active ZLens runtime before saving its receipt.');
    const tileIds = page.layout.items.filter((tile) => !tile.text && !tile.aiPin).map((tile) => tile.i);
    const datasetTileIds = page.layout.items.filter((tile) => Boolean(tile.query)).map((tile) => tile.i);
    const intentFingerprint = appBuildPreviewIntentFingerprint(receiptBindingDraft, page.id);
    const verified = await verifyPreview({
      runId: receipt.id,
      draftId: receiptBindingDraft.id,
      dashboardId: page.id,
      tileIds,
      ...(datasetTileIds.length ? { datasetTileIds } : {}),
      intentFingerprint,
      purpose: 'local_preview',
    });
    if (!verified.ok) throw new Error(`APP_BUILD_PREVIEW_RECEIPT_REJECTED: ${verified.error}`);
    if (receipt.snapshotId !== verified.snapshotId
      || receipt.filterFingerprint !== verified.filterFingerprint
      || receipt.resultFingerprint !== verified.resultFingerprint) {
      throw new Error('APP_BUILD_PREVIEW_RECEIPT_REJECTED: the submitted receipt does not match the server-owned settled run.');
    }
    return {
      ...operation,
      receipt: { ...receipt, intentFingerprint: verified.intentFingerprint },
    };
  }));
}

function appBuildRequirementBlocksPublication(draft: AppBuildDraft, requirement: AppBuildDraft['requirements'][number]): boolean {
  if (!requirement.required) return false;
  if (draft.authoringMode === 'manual' && draft.frame.metrics.length === 0 && requirement.measures.length === 0) return false;
  return true;
}

function appBuildReviewTaskBlocksPublication(draft: AppBuildDraft, task: AppBuildDraft['reviewTasks'][number]): boolean {
  if (task.status !== 'open') return false;
  // "X needs certifying" reminders from older drafts: trust is per tile now (T3).
  if (isTrustReminderTaskId(task.id)) return false;
  if (task.sourceId && appSourceIdsUsedByTiles(draft).has(task.sourceId)) return true;
  if (task.tileId && draft.pages.some((page) => page.layout.items.some((tile) => tile.i === task.tileId))) return true;
  if (task.pageId && draft.pages.some((page) => page.id === task.pageId)) return true;
  // v2 AI plans previously persisted general guidance as open tasks without an
  // attached source, page, or tile. Keep those reminders readable, but do not
  // turn them into an unexplained hard publication gate.
  return false;
}

/** The draft sources a tile uses; only these are part of what Publish writes. */
function appBuildSourcesUsedByTiles(draft: AppBuildDraft): AppBuildDraftSource[] {
  const used = appSourceIdsUsedByTiles(draft);
  return draft.sources.filter((source) => used.has(source.id));
}

function hasCurrentAppBuildPreflightReceipt(draft: AppBuildDraft): boolean {
  return Boolean(draft.preflightReceipt
    && draft.preflightReceipt.revision === draft.revision
    && draft.preflightReceipt.proposalHash === draft.proposalHash
    && draft.preflightReceipt.sourceFingerprint === appBuildSourceFingerprint(draft));
}

export function markStoredAppBuildDraftPreflighted(
  projectRoot: string,
  draft: AppBuildDraft,
  options: Parameters<typeof preflightStoredAppBuildDraft>[2] = {},
): AppBuildDraft {
  const errors = preflightStoredAppBuildDraft(projectRoot, draft, options);
  if (errors.length) throw new Error(`App Build preflight failed: ${errors.join(' ')}`);
  const now = new Date().toISOString();
  const next: AppBuildDraft = {
    ...draft,
    state: 'preflight_ready',
    preflightReceipt: {
      id: `app_preflight_${createHash('sha256').update(`${draft.id}:${draft.revision}:${draft.proposalHash}`).digest('hex').slice(0, 16)}`,
      revision: draft.revision,
      proposalHash: draft.proposalHash,
      sourceFingerprint: appBuildSourceFingerprint(draft),
      createdAt: now,
    },
    updatedAt: now,
  };
  writeStoredAppBuildDraft(projectRoot, next, { expectedRevision: draft.revision });
  return next;
}

function appBuildSourceFingerprint(draft: AppBuildDraft): string {
  const sources = [...draft.sources]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((source) => ({
      id: source.id,
      kind: source.kind,
      sourceRef: source.sourceRef,
      snapshotId: source.snapshotId,
      sourceFingerprint: source.sourceFingerprint,
      receiptId: source.receiptId,
      reviewStatus: source.reviewStatus,
      datasetContractFingerprint: source.capabilities?.dataset?.contractRef.fingerprint,
    }));
  return `sha256:${createHash('sha256').update(JSON.stringify(sources)).digest('hex')}`;
}

/** App fields a Studio draft owns; every other field of a published App survives a republish. */
const DRAFT_OWNED_APP_FIELDS = new Set([
  'version', 'id', 'name', 'description', 'visibility', 'publicationIntent', 'ownerDomain',
  'usesDomains', 'requiredExports', 'domain', 'audience', 'lifecycle', 'homepage',
  // Recorded on every publish as certified, and dropped when it is not.
  'certifiedBy', 'certifiedAt',
  // The tile trust worked out at this publish (B6).
  'tileTrust',
]);

function mergeRepublishedAppDocument(appDir: string, generated: AppDocument): AppDocument {
  const path = join(appDir, 'dql.app.json');
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return generated;
  }
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) if (!DRAFT_OWNED_APP_FIELDS.has(key)) merged[key] = value;
  for (const [key, value] of Object.entries(generated)) {
    if (value !== undefined && (DRAFT_OWNED_APP_FIELDS.has(key) || !(key in existing))) merged[key] = value;
  }
  const parsed = parseAppDocument(JSON.stringify(merged), path);
  if (!parsed.document || parsed.errors.length) {
    throw new Error(`The published App's dql.app.json could not be kept on republish: ${parsed.errors.map((error) => error.message).join('; ')}`);
  }
  return merged as unknown as AppDocument;
}

/** Goals ZLens writes itself when the author typed none: never a description. */
const GENERATED_APP_GOALS = /^(create .+|edit this governed app|a dashboard of live, checked numbers|build a governed analytics app)$/i;

/**
 * The App's description on publish (new-user round 2, problem 10): what the
 * author wrote (the decision it supports, or the request they typed), else
 * the description the published App already has, else a plain default only
 * because there is nothing else. Never "Governed analytical App for …".
 */
export function appDescriptionFor(projectRoot: string, draft: Pick<AppBuildDraft, 'appId' | 'baseApp' | 'frame'>, name: string, domain: string): string {
  const typed = cleanString(draft.frame.decision) || cleanString(draft.frame.goal);
  if (typed && !GENERATED_APP_GOALS.test(typed) && typed.toLowerCase() !== name.trim().toLowerCase()) return typed;
  if (draft.baseApp) {
    const existing = cleanString(loadAppById(projectRoot, draft.appId)?.app.description);
    if (existing && !/^Governed analytical App for /i.test(existing)) return existing;
  }
  const words = domain.replace(/[_-]+/g, ' ').trim();
  const area = words && !['general', 'unassigned'].includes(words.toLowerCase()) ? ` for ${words.charAt(0).toUpperCase()}${words.slice(1)}` : '';
  return `A dashboard of live numbers${area}.`;
}

/**
 * The App's trust at publish (B6, T2): the same answer the publish check, the
 * editor, the App header and the Apps card give — every tile's source, every
 * join it can run through (filters included) and its calculations' inputs.
 * `descriptorFor` gives the current model's Dataset (joins certified since
 * the draft stored its card count); `recordFor` the current catalog record
 * (data certified since the card was stored); `blocks` the project's saved
 * queries as they are now.
 */
export function appBuildDraftTrust(
  draft: AppBuildDraft,
  current: {
    descriptorFor?: (sourceId: string) => DatasetDescriptor | undefined;
    recordFor?: (sourceId: string) => AppSourceCatalogRecord | undefined;
    blocks?: ReadonlyArray<{ id?: string; name?: string; path?: string; status?: string; fingerprint?: string }>;
  } | ((sourceId: string) => DatasetDescriptor | undefined) = {},
): ReturnType<typeof appTrustAnswer> {
  const options = typeof current === 'function' ? { descriptorFor: current } : current;
  const sources = new Map(draft.sources.map((source) => [source.id, source]));
  return appTrustAnswer({
    pages: draft.pages,
    sourceFor: (sourceId) => {
      const source = sources.get(sourceId);
      if (!source) return undefined;
      let next: AppBuildDraftSource = source;
      const record = options.recordFor?.(sourceId);
      if (record) {
        const certified = record.lifecycle === 'certified' && record.trust === 'certified';
        next = {
          ...next,
          lifecycle: record.lifecycle,
          trustState: certified ? 'certified' : 'review_required',
          reviewStatus: certified ? 'not_required' : next.reviewStatus === 'approved' ? 'approved' : 'required',
          checked: Boolean(record.check),
        };
      } else if (options.blocks && (source.kind === 'block' || source.kind === 'certified_block') && !source.capabilities?.dataset) {
        const block = options.blocks.find((candidate) => candidate.path === source.sourceRef || candidate.path === source.executionRef || candidate.id === source.sourceRef || candidate.name === source.sourceRef);
        if (block) {
          const revision = source.sourceRevision ?? source.sourceFingerprint;
          const certified = block.status === 'certified' && (!revision || revision === block.fingerprint);
          next = { ...next, lifecycle: certified ? 'certified' : next.lifecycle === 'certified' ? 'review' : next.lifecycle, trustState: certified ? 'certified' : 'review_required' };
        }
      }
      const dataset = options.descriptorFor?.(sourceId);
      return dataset ? { ...next, capabilities: { ...(next.capabilities ?? {}), dataset } } : next;
    },
  });
}

export function publishStoredAppBuildDraft(
  projectRoot: string,
  draft: AppBuildDraft,
  options: {
    descriptorFor?: (sourceId: string) => DatasetDescriptor | undefined;
    recordFor?: (sourceId: string) => AppSourceCatalogRecord | undefined;
  } = {},
): { ok: true; app: ReturnType<typeof collectAppsList>[number]; draft: AppBuildDraft; paths: string[] } {
  const errors = preflightStoredAppBuildDraft(projectRoot, draft, { trust: { descriptorFor: options.descriptorFor, recordFor: options.recordFor } });
  if (errors.length) throw new Error(`App Build preflight failed: ${errors.join(' ')}`);
  if (!hasCurrentAppBuildPreflightReceipt(draft)) {
    throw new Error('App Build Draft needs a current preflight receipt before publication.');
  }
  const destination = resolveAppPackageDir(projectRoot, draft.appId);
  if (!draft.baseApp && existsSync(destination)) throw new Error(`App already exists: ${draft.appId}`);
  if (draft.baseApp && (!existsSync(destination) || draft.baseApp.appId !== draft.appId)) {
    throw new Error('Published App base no longer exists at the expected path.');
  }

  const stage = join(projectRoot, '.dql', 'local', 'app-build-staging', `${draft.id}-${Date.now()}`);
  const dashboardDir = join(stage, 'dashboards');
  // With a host, the person publishing owns it; otherwise this machine's user.
  const owner = hostActor() ?? `${process.env.USER ?? 'owner'}@local`;
  const domain = draft.pages[0]?.metadata.domain || 'general';
  const name = draft.name.trim() || draft.appId;
  const publishedSources = appBuildSourcesUsedByTiles(draft);
  const hasCertifiedAnalysis = publishedSources.some((source) => (
    (source.kind === 'block' || source.kind === 'certified_block')
    || ((source.kind === 'governed_semantic' || source.kind === 'semantic_query') && Boolean(source.capabilities?.dataset))
  ) && source.trustState === 'certified' && source.lifecycle === 'certified');
  const hasReviewRequiredSource = publishedSources.some((source) => source.trustState !== 'certified'
    || ((source.kind === 'governed_semantic' || source.kind === 'semantic_query')
      && !source.capabilities?.dataset
      && source.reviewStatus !== 'approved'));
  // Certified only when every data tile is certified (B6, T2): a tile on a
  // join nobody certified keeps the App from reading certified while its
  // header says "3 of 4 tiles certified".
  const trust = appBuildDraftTrust(draft, { descriptorFor: options.descriptorFor, recordFor: options.recordFor, blocks: collectBlockCandidates(projectRoot) });
  const lifecycle = hasCertifiedAnalysis && !hasReviewRequiredSource && trust.allCertified ? 'certified' as const : 'review' as const;
  const app: AppDocument = {
    version: 1,
    id: draft.appId,
    name,
    description: appDescriptionFor(projectRoot, draft, name, domain),
    visibility: 'shared',
    publicationIntent: 'shared_project',
    ownerDomain: domain,
    usesDomains: [domain],
    requiredExports: [],
    domain,
    audience: draft.frame.audience,
    lifecycle,
    // Who published it as certified, and when: the card says "App certified by <name> · <date>".
    ...(lifecycle === 'certified' ? { certifiedBy: appCertifierName(projectRoot, owner), certifiedAt: new Date().toISOString() } : {}),
    ...(trust.total > 0 ? { tileTrust: publishedAppTileTrust(trust) } : {}),
    owners: [owner],
    members: [{ userId: owner, displayName: owner, roles: ['owner', 'analyst'] }],
    roles: [
      { id: 'owner', displayName: 'Owner' },
      { id: 'analyst', displayName: 'Analyst' },
      { id: 'viewer', displayName: 'Viewer' },
    ],
    policies: [
      { id: 'viewers-read', domain, minClassification: 'internal', allowedRoles: ['viewer', 'analyst', 'owner'], accessLevel: 'read', enabled: true },
      { id: 'analyst-execute', domain, minClassification: 'internal', allowedRoles: ['analyst', 'owner'], accessLevel: 'execute', enabled: true },
      { id: 'owner-admin', domain, minClassification: 'restricted', allowedRoles: ['owner'], accessLevel: 'admin', enabled: true },
    ],
    rlsBindings: [],
    schedules: [],
    homepage: { type: 'dashboard', id: draft.pages[0].id },
  };
  const committedPages = draft.pages.map((page) => ({
    ...page,
    // Dataset field tiles are a v3 document feature. Preserve their grammar
    // version on publication so the generated App remains readable without a
    // lossy conversion to the legacy dashboard shape.
    version: page.version === 3 ? 3 as const : 2 as const,
    metadata: { ...page.metadata, visibility: 'shared' as const, lifecycle },
  }));
  // Republishing replaces only what the draft owns: its pages and the App's
  // identity and lifecycle. Everything else in the App folder (schedules and
  // alerts, members, roles, policies, RLS bindings, notebooks, drafts, other
  // files) is kept as it was.
  const published = draft.baseApp ? mergeRepublishedAppDocument(destination, app) : app;
  try {
    if (draft.baseApp) {
      cpSync(destination, stage, { recursive: true });
      rmSync(dashboardDir, { recursive: true, force: true });
    }
    mkdirSync(dashboardDir, { recursive: true });
    mkdirSync(join(stage, 'notebooks'), { recursive: true });
    mkdirSync(join(stage, 'drafts'), { recursive: true });
    writeFileSync(join(stage, 'dql.app.json'), JSON.stringify(published, null, 2) + '\n', 'utf-8');
    for (const page of committedPages) {
      writeFileSync(join(dashboardDir, `${page.id}.dqld`), JSON.stringify(page, null, 2) + '\n', 'utf-8');
    }
    writeFileSync(join(stage, 'README.md'), appReadme(app, draft.frame.audience ?? '', [], committedPages[0].id), 'utf-8');
    mkdirSync(dirname(destination), { recursive: true });
    if (draft.baseApp) {
      const backup = join(projectRoot, '.dql', 'local', 'app-build-staging', `${draft.id}-backup-${Date.now()}`);
      renameSync(destination, backup);
      try {
        renameSync(stage, destination);
        rmSync(backup, { recursive: true, force: true });
      } catch (error) {
        if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
        throw error;
      }
    } else {
      renameSync(stage, destination);
    }
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }

  const next: AppBuildDraft = {
    ...draft,
    revision: draft.revision + 1,
    state: 'project_published',
    publishedFingerprint: fingerprintAppDirectory(destination),
    updatedAt: new Date().toISOString(),
    proposalHash: draft.proposalHash,
  };
  writeStoredAppBuildDraft(projectRoot, next, { expectedRevision: draft.revision });
  const created = collectAppsList(projectRoot).find((entry) => entry.id === draft.appId);
  if (!created) throw new Error(`App was committed but could not be reloaded: ${draft.appId}`);
  return {
    ok: true,
    app: created,
    draft: next,
    paths: ['dql.app.json', 'README.md', ...committedPages.map((page) => `dashboards/${page.id}.dqld`)].map((path) => `apps/${draft.appId}/${path}`),
  };
}

/** @deprecated Compatibility adapter for callers that still use the old name. */
export function commitStoredAppBuildDraft(
  projectRoot: string,
  draft: AppBuildDraft,
): ReturnType<typeof publishStoredAppBuildDraft> {
  return publishStoredAppBuildDraft(projectRoot, draft);
}

function writeAppAiBuildSession(projectRoot: string, session: AppAiBuildSession): void {
  const dir = appAiBuildSessionDir(projectRoot);
  const owner = currentRecordOwner();
  const path = join(dir, `${session.id}.json`);
  // With a host, a session id someone else holds (or one from before the host) is not written over.
  if (owner !== undefined && existsSync(path) && !getAppAiBuildSession(projectRoot, session.id)) {
    throw new Error('APP_AI_BUILD_NOT_FOUND: that App build session was not found.');
  }
  if (owner === null) throw new Error('APP_AI_BUILD_NOT_FOUND: sign in to build an App.');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ ...session, ...(owner ? { ownerId: owner } : {}) }, null, 2) + '\n', 'utf-8');
}

function appBuildWarnings(validation: unknown, plan: Record<string, unknown>): string[] {
  const issues = Array.isArray((validation as { issues?: unknown[] } | undefined)?.issues)
    ? (validation as { issues: Array<{ level?: string; message?: string }> }).issues
    : [];
  const warnings = issues
    .filter((issue) => issue.level === 'warning')
    .map((issue) => cleanString(issue.message))
    .filter(Boolean);
  const missing = Array.isArray(plan.missingEvidence) ? plan.missingEvidence.map(cleanString).filter(Boolean) : [];
  return unique([...warnings, ...missing]);
}

function appBuildBlockedMessage(validation: unknown, plan: Record<string, unknown>): string {
  const warnings = appBuildWarnings(validation, plan).slice(0, 4);
  const reviewTasks = reviewTasksFromPlan(plan).slice(0, 4);
  return [
    'No certified saved queries matched strongly enough to create a stakeholder app.',
    'ZLens did not write an empty dashboard. Create or certify reusable saved queries first, or select certified saved queries explicitly.',
    warnings.length ? `Missing proof: ${warnings.join(' | ')}` : '',
    reviewTasks.length ? `Next review tasks: ${reviewTasks.join(' | ')}` : '',
  ].filter(Boolean).join(' ');
}

function reviewTasksFromPlan(plan: Record<string, unknown>): string[] {
  const tasks = Array.isArray(plan.reviewTasks) ? plan.reviewTasks.map(cleanString).filter(Boolean) : [];
  const scopedReports = Array.isArray(plan.scopedReports) ? plan.scopedReports : [];
  const planning = plan.planning && typeof plan.planning === 'object' ? plan.planning as { scopedReports?: unknown[] } : {};
  const planningReports = Array.isArray(planning.scopedReports) ? planning.scopedReports : [];
  const reportTasks = [...scopedReports, ...planningReports].flatMap((report) => {
    if (!report || typeof report !== 'object') return [];
    const record = report as { title?: unknown; question?: unknown; evidenceNeeded?: unknown[] };
    const title = cleanString(record.title) || 'Scoped analysis';
    const question = cleanString(record.question);
    const evidence = Array.isArray(record.evidenceNeeded)
      ? record.evidenceNeeded.map(cleanString).filter(Boolean).join(', ')
      : '';
    return [
      `Scoped analysis "${title}": ${question || 'Review the analysis question before running it.'}`,
      evidence ? `Scoped analysis "${title}" evidence needed: ${evidence}` : '',
    ].filter(Boolean);
  });
  const pages = Array.isArray(plan.pages) ? plan.pages : [];
  const tileTasks = pages.flatMap((page) => {
    if (!page || typeof page !== 'object') return [];
    const tiles = Array.isArray((page as { tiles?: unknown[] }).tiles) ? (page as { tiles: unknown[] }).tiles : [];
    return tiles.flatMap((tile) => {
      if (!tile || typeof tile !== 'object') return [];
      const record = tile as { title?: unknown; reviewTasks?: unknown[] };
      const title = cleanString(record.title) || 'Tile';
      return Array.isArray(record.reviewTasks)
        ? record.reviewTasks.map((task) => `${title}: ${cleanString(task)}`).filter((task) => !task.endsWith(': '))
        : [];
    });
  });
  return unique([...tasks, ...reportTasks, ...tileTasks]).slice(0, 20);
}

function shouldRouteAppQuestionToInvestigation(question: string): boolean {
  return /\b(why|changed|change|drop|decline|increase|decrease|driver|drill|break\s*down|segment|cohort|compare|versus| vs |anomal|outlier|spike|dip|root cause)\b/i.test(question);
}

function isAppChangeQuestion(question: string): boolean {
  return /\b(add|remove|change|update|replace|resize|move|create|build|show|switch)\b.*\b(tile|chart|page|dashboard|app|layout|visual|view)\b/i.test(question);
}

function appChangeSuggestion(question: string): string {
  if (/\b(chart|visual|bar|line|table|pivot|kpi)\b/i.test(question)) return 'recommend a governed tile display change and save it in Build mode';
  if (/\b(page|dashboard)\b/i.test(question)) return 'create or update a dashboard page as a reviewed app artifact';
  if (/\b(filter|parameter|param)\b/i.test(question)) return 'bind the filter to compatible certified block parameters only';
  return 'prepare a reviewed app layout change';
}

function appAskTileContext(tile: DashboardGridItem): Record<string, unknown> {
  return {
    tileId: tile.i,
    title: tile.title,
    blockId: tile.block && 'blockId' in tile.block ? tile.block.blockId : undefined,
    semantic: tile.semantic,
    draftAnalysis: tile.draftAnalysis,
    sourceClass: tile.sourceClass ?? (tile.block ? 'certified_block' : tile.semantic ? 'governed_semantic' : tile.draftAnalysis ? 'exploratory_analysis' : 'narrative'),
    review: tile.review,
    viz: tile.viz.type,
    trustState: tile.trustState ?? tile.display?.trustState,
    reviewStatus: tile.reviewStatus ?? tile.display?.reviewStatus,
    filterBindings: tile.filterBindings,
    parameterBindings: tile.parameterBindings,
        sourceEvidence: tile.sourceEvidence,
  };
}

function buildAppContextEnvelope(
  projectRoot: string,
  app: AppDocument,
  appDir: string,
  focus: { dashboardId?: string; tileId?: string; blockId?: string },
): AppContextEnvelopeV1 {
  const dashboards = findDashboardsForApp(appDir)
    .map((path) => loadDashboardDocument(path).document)
    .filter((document): document is DashboardDocument => Boolean(document))
    .map((document) => ({
      id: document.id,
      title: document.metadata.title,
      filters: document.filters,
      story: document.story,
      tiles: document.layout.items.map(appAskTileContext),
    }));
  return {
    version: 1,
    app: {
      id: app.id,
      name: app.name,
      domain: app.domain,
      audience: app.audience,
      lifecycle: app.lifecycle ?? 'draft',
      visibility: app.visibility ?? 'shared',
      publicationIntent: app.publicationIntent ?? (app.visibility === 'private' ? 'personal' : 'shared_project'),
      businessOutcome: app.businessOutcome,
      caveats: app.caveats ?? [],
    },
    dashboards,
    drafts: loadAppDraftContext(projectRoot, appDir),
    focus,
  };
}

function filterBindingsForBlockSource(projectRoot: string, block: BlockCandidate): NonNullable<DashboardGridItem['filterBindings']> {
  const absPath = join(projectRoot, block.path);
  if (!existsSync(absPath)) return [];
  const source = readFileSync(absPath, 'utf-8');
  const filterSection = sectionBody(source, 'filterBindings');
  const parameterSection = sectionBody(source, 'parameterPolicy');
  const bindings = Array.from(filterSection.matchAll(/^\s*([A-Za-z_][\w-]*)\s*=\s*"([^"]+)"/gm))
    .map((match) => ({ filter: match[1], binding: match[2], mode: 'predicate' as const }));
  const allowedFilterBindings = matchArray(source, /allowedFilters\s*=\s*\[([^\]]*)\]/)
    .filter((filter) => !bindings.some((binding) => binding.filter === filter))
    .map((filter) => ({ filter, binding: filter, mode: 'predicate' as const }));
  const parameterNames = Array.from(parameterSection.matchAll(/^\s*([A-Za-z_][\w-]*)\s*=\s*"dynamic"/gm))
    .map((match) => match[1]);
  const parameterBindings = parameterNames.map((param) => ({
    filter: param,
    binding: param,
    mode: 'parameter' as const,
    paramNames: [param],
  }));
  return uniqueFilterBindings([...bindings, ...allowedFilterBindings, ...parameterBindings]);
}

function sectionBody(source: string, sectionName: string): string {
  const match = new RegExp(`${sectionName}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm').exec(source);
  return match?.[1] ?? '';
}

function buildInvestigationSqlTemplateValues(
  projectRoot: string,
  context: unknown,
  selected: Record<string, unknown> | null,
  sourceBlockId?: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const block = resolveSelectedBlock(projectRoot, selected, sourceBlockId);
  if (block) {
    const absPath = join(projectRoot, block.path);
    if (existsSync(absPath)) {
      Object.assign(values, parseDqlParams(readFileSync(absPath, 'utf-8')));
    }
  }

  const root = asRecord(context);
  const selectedRecord = asRecord(selected);
  mergeTemplateRecord(values, root?.activeFilters);
  mergeTemplateRecord(values, root?.filters);
  mergeTemplateRecord(values, root?.variables);
  mergeTemplateRecord(values, root?.parameters);
  mergeTemplateRecord(values, root?.parameterValues);
  mergeTemplateRecord(values, selectedRecord?.activeFilters);
  mergeTemplateRecord(values, selectedRecord?.variables);
  mergeTemplateRecord(values, selectedRecord?.parameters);
  return values;
}

function mergeTemplateRecord(target: Record<string, unknown>, value: unknown): void {
  const record = asRecord(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (entry === undefined || entry === null || entry === '') continue;
    target[key] = entry;
  }
}

function parseDqlParams(source: string): Record<string, unknown> {
  const body = sectionBody(source, 'params');
  const values: Record<string, unknown> = {};
  for (const match of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/gm)) {
    const name = match[1];
    const value = parseDqlLiteral(match[2]);
    if (value !== undefined) values[name] = value;
  }
  return values;
}

function parseDqlLiteral(raw: string): unknown {
  const trimmed = raw
    .replace(/\s+#.*$/g, '')
    .replace(/\s+\/\/.*$/g, '')
    .replace(/,\s*$/g, '')
    .trim();
  if (!trimmed) return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^(true|false)$/i.test(trimmed)) return /^true$/i.test(trimmed);
  const quoted = /^"((?:[^"\\]|\\.)*)"$/s.exec(trimmed) ?? /^'((?:[^'\\]|\\.)*)'$/s.exec(trimmed);
  if (quoted) return quoted[1].replace(/\\(["'\\])/g, '$1');
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const items = splitDqlArrayValues(trimmed.slice(1, -1))
      .map(parseDqlLiteral)
      .filter((item) => item !== undefined);
    return items;
  }
  return trimmed;
}

function splitDqlArrayValues(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      current += char;
      if (char === quote && value[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function renderSqlTemplateParams(
  sql: string,
  values: Record<string, unknown>,
): { sql: string; unresolved: string[] } {
  const rendered = sql.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return match;
    const literal = sqlTemplateLiteral(values[name]);
    return literal ?? match;
  });
  return { sql: rendered, unresolved: unresolvedSqlTemplateParams(rendered) };
}

function sqlTemplateLiteral(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) {
    const rendered = value.map(sqlTemplateLiteral).filter((item): item is string => Boolean(item));
    return rendered.length > 0 ? rendered.join(', ') : undefined;
  }
  const stringValue = String(value).trim();
  if (!stringValue) return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(stringValue)) return stringValue;
  if (/^(true|false)$/i.test(stringValue)) return /^true$/i.test(stringValue) ? 'TRUE' : 'FALSE';
  return sqlStringLiteral(stringValue);
}

function unresolvedSqlTemplateParams(sql: string): string[] {
  const names = Array.from(sql.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g), (match) => match[1]);
  if (/\{\{[\s\S]*?\}\}/.test(sql)) names.push('jinja_template');
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

function uniqueFilterBindings(bindings: NonNullable<DashboardGridItem['filterBindings']>): NonNullable<DashboardGridItem['filterBindings']> {
  const seen = new Set<string>();
  const out: NonNullable<DashboardGridItem['filterBindings']> = [];
  for (const binding of bindings) {
    const key = `${binding.filter}:${binding.binding ?? ''}:${binding.mode ?? ''}:${(binding.paramNames ?? []).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(binding);
  }
  return out;
}

function promoteSharedDashboardItem(item: DashboardGridItem): DashboardGridItem {
  const trustState = item.trustState ?? item.display?.trustState ?? (item.block ? 'certified' : 'review_required');
  const reviewStatus = item.reviewStatus ?? item.display?.reviewStatus ?? (trustState === 'certified' ? 'certified' : 'review_required');
  const display = item.display
    ? {
        ...item.display,
        trustState,
        reviewStatus,
      }
    : undefined;
  return {
    ...item,
    ...(display ? { display } : {}),
    trustState,
    reviewStatus,
  };
}

export function deleteAppPackage(
  projectRoot: string,
  id: string,
  input: { expectedFingerprint?: string } = {},
):
  | { ok: true; id: string; deletedPath: string; trashPath: string; recoveryId: string; localRowsArchived: number; sourceControlImpact: 'delete' }
  | { ok: false; status: 400 | 404 | 409; error: string } {
  const cleanId = cleanString(id);
  if (!cleanId || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(cleanId)) {
    return { ok: false, status: 400, error: 'A valid App id is required.' };
  }
  const loaded = loadAppById(projectRoot, cleanId);
  if (!loaded) return { ok: false, status: 404, error: `App "${cleanId}" not found.` };
  const currentFingerprint = fingerprintAppDirectory(loaded.appDir);
  if (!input.expectedFingerprint) {
    return { ok: false, status: 409, error: 'App deletion requires the fingerprint shown during confirmation.' };
  }
  if (input.expectedFingerprint !== currentFingerprint) {
    return { ok: false, status: 409, error: 'This App changed since deletion was requested. Refresh and review it again.' };
  }

  const relativeAppDir = relative(projectRoot, loaded.appDir).replaceAll('\\', '/');
  const isProjectApp = /^apps\/[^/]+$/.test(relativeAppDir);
  const isDomainApp = /^domains\/(?:[^/]+\/)*apps\/[^/]+$/.test(relativeAppDir);
  if ((!isProjectApp && !isDomainApp) || relativeAppDir.startsWith('../')) {
    return { ok: false, status: 400, error: 'ZLens refused to delete an App outside this project.' };
  }

  const trashRoot = join(projectRoot, '.dql', 'local', 'trash', 'apps');
  mkdirSync(trashRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let recoveryId = `${stamp}-${cleanId}`;
  let trashDir = join(trashRoot, recoveryId);
  let suffix = 2;
  while (existsSync(trashDir)) {
    recoveryId = `${stamp}-${cleanId}-${suffix++}`;
    trashDir = join(trashRoot, recoveryId);
  }
  mkdirSync(trashDir, { recursive: true });
  const packageDir = join(trashDir, 'package');
  renameSync(loaded.appDir, packageDir);
  let localArchive: ReturnType<LocalAppStorage['archiveAndDeleteAppState']> | undefined;
  try {
    const dbPath = defaultLocalAppsDbPath(projectRoot);
    if (existsSync(dbPath)) {
      const storage = new LocalAppStorage(dbPath);
      try {
        localArchive = storage.archiveAndDeleteAppState(cleanId);
      } finally {
        storage.close();
      }
      writeFileSync(join(trashDir, 'local-state.json'), JSON.stringify(localArchive, null, 2) + '\n', 'utf-8');
    }
    writeFileSync(join(trashDir, 'recovery.json'), JSON.stringify({
      version: 1,
      recoveryId,
      appId: cleanId,
      originalPath: relativeAppDir,
      appFingerprint: currentFingerprint,
      deletedAt: new Date().toISOString(),
    }, null, 2) + '\n', 'utf-8');
  } catch (error) {
    if (localArchive) {
      const storage = openAppStorage(projectRoot);
      try { storage.restoreAppState(localArchive); } finally { storage.close(); }
    }
    if (!existsSync(loaded.appDir) && existsSync(packageDir)) renameSync(packageDir, loaded.appDir);
    rmSync(trashDir, { recursive: true, force: true });
    throw error;
  }
  const localRowsArchived = localArchive
    ? Object.values(localArchive.rows).reduce((count, rows) => count + rows.length, 0)
    : 0;
  return {
    ok: true,
    id: cleanId,
    deletedPath: relativeAppDir,
    trashPath: relative(projectRoot, trashDir).replaceAll('\\', '/'),
    recoveryId,
    localRowsArchived,
    sourceControlImpact: 'delete',
  };
}

export function restoreAppPackage(
  projectRoot: string,
  recoveryId: string,
): { ok: true; id: string; restoredPath: string } | { ok: false; status: 400 | 404 | 409; error: string } {
  const cleanRecoveryId = cleanString(recoveryId);
  if (!cleanRecoveryId || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(cleanRecoveryId)) {
    return { ok: false, status: 400, error: 'A valid recovery id is required.' };
  }
  const recoveryDir = join(projectRoot, '.dql', 'local', 'trash', 'apps', cleanRecoveryId);
  const manifestPath = join(recoveryDir, 'recovery.json');
  const packageDir = join(recoveryDir, 'package');
  if (!existsSync(manifestPath) || !existsSync(packageDir)) return { ok: false, status: 404, error: 'App recovery bundle not found.' };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { appId?: string; originalPath?: string };
  if (!manifest.appId || !manifest.originalPath || manifest.originalPath.startsWith('../')) {
    return { ok: false, status: 400, error: 'App recovery bundle is invalid.' };
  }
  const destination = join(projectRoot, manifest.originalPath);
  if (existsSync(destination)) return { ok: false, status: 409, error: `Cannot restore because ${manifest.originalPath} already exists.` };
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(packageDir, destination);
  try {
    const localStatePath = join(recoveryDir, 'local-state.json');
    if (existsSync(localStatePath)) {
      const storage = openAppStorage(projectRoot);
      try {
        storage.restoreAppState(JSON.parse(readFileSync(localStatePath, 'utf-8')));
      } finally {
        storage.close();
      }
    }
  } catch (error) {
    renameSync(destination, packageDir);
    throw error;
  }
  rmSync(recoveryDir, { recursive: true, force: true });
  return { ok: true, id: manifest.appId, restoredPath: manifest.originalPath };
}

export function restoreAppRecovery(
  projectRoot: string,
  recoveryId: string,
): ReturnType<typeof restoreAppPackage> | ReturnType<typeof restoreStoredAppBuildDraft> {
  const cleanRecoveryId = cleanString(recoveryId);
  if (!cleanRecoveryId || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(cleanRecoveryId)) {
    return { ok: false, status: 400, error: 'A valid recovery id is required.' };
  }
  const draftRecovery = join(projectRoot, '.dql', 'local', 'trash', 'app-drafts', cleanRecoveryId, 'recovery.json');
  return existsSync(draftRecovery)
    ? restoreStoredAppBuildDraft(projectRoot, cleanRecoveryId)
    : restoreAppPackage(projectRoot, cleanRecoveryId);
}

export function createAppPackage(
  projectRoot: string,
  input: AppCreateRequest,
): { ok: true; app: ReturnType<typeof collectAppsList>[number]; paths: string[]; dashboardId: string } | { ok: false; error: string } {
  const name = cleanString(input.name);
  const domain = cleanString(input.ownerDomain) || cleanString(input.domain);
  if (!name) return { ok: false, error: 'name is required' };
  if (!domain) return { ok: false, error: 'domain is required' };

  const id = suggestAppId(name);
  const appDir = resolveAppPackageDir(projectRoot, id);
  if (existsSync(appDir)) return { ok: false, error: `App already exists: ${id}` };
  const dashboardTitle = cleanString(input.dashboardTitle) || 'Overview';
  const dashboardId = slugify(dashboardTitle) || 'overview';

  const owner = cleanString(input.owners?.[0]) || hostActor() || `${process.env.USER ?? 'owner'}@local`;
  const audience = cleanString(input.audience);
  const subdomain = cleanString(input.subdomain);
  const groups = normalizeTags(input.groups ?? []);
  // API-013: authoring always starts as a private draft. Project visibility is
  // available only through the publication endpoint and its live trust checks.
  const visibility = 'private' as const;
  const lifecycle = 'draft' as const;
  const tags = normalizeTags([...(input.tags ?? []), audience ? `audience:${slugify(audience)}` : '']);
  const selectedIds = Array.from(new Set((input.selectedBlockIds ?? []).map(cleanString).filter(Boolean)));
  const blocks = collectBlockCandidates(projectRoot);
  const selectedBlocks = selectedIds
    .map((blockId) => blocks.find((block) => block.id === blockId || block.name === blockId))
    .filter((block): block is BlockCandidate => Boolean(block));
  const missingBlocks = selectedIds.filter((blockId) => !selectedBlocks.some((block) => block.id === blockId || block.name === blockId));
  if (missingBlocks.length) return { ok: false, error: `Unknown saved query selection: ${missingBlocks.join(', ')}` };
  const uncertifiedBlocks = selectedBlocks.filter((block) => block.status !== 'certified');
  if (uncertifiedBlocks.length) {
    return { ok: false, error: `Manual App creation accepts certified saved queries only: ${uncertifiedBlocks.map((block) => block.name).join(', ')}` };
  }

  const app: AppDocument = {
    version: 1,
    id,
    name,
    description: cleanString(input.purpose) || `${name} consumption surface for ${domain}`,
    visibility,
    ownerDomain: domain,
    usesDomains: normalizeTags(input.usesDomains ?? [domain]),
    purpose: cleanString(input.purpose) || undefined,
    requiredExports: normalizeTags(input.requiredExports ?? []),
    classification: cleanString(input.classification) || undefined,
    domain,
    subdomain: subdomain || undefined,
    groups,
    audience: audience || undefined,
    lifecycle,
    owners: [owner],
    tags,
    members: [
      { userId: owner, displayName: owner, roles: ['owner', 'analyst'] },
    ],
    roles: [
      { id: 'owner', displayName: 'Owner', description: 'Full access to dashboards and App configuration.' },
      { id: 'analyst', displayName: 'Analyst', description: 'Can execute dashboards and review generated drafts.' },
      { id: 'viewer', displayName: 'Viewer', description: 'Read-only access to certified dashboard consumption.' },
    ],
    policies: [
      {
        id: 'viewers-read',
        domain,
        minClassification: 'internal',
        allowedRoles: ['viewer', 'analyst', 'owner'],
        accessLevel: 'read',
        enabled: true,
      },
      {
        id: 'analyst-execute',
        domain,
        minClassification: 'internal',
        allowedRoles: ['analyst', 'owner'],
        accessLevel: 'execute',
        enabled: true,
      },
      {
        id: 'owner-admin',
        domain,
        minClassification: 'restricted',
        allowedRoles: ['owner'],
        accessLevel: 'admin',
        enabled: true,
      },
    ],
    rlsBindings: [],
    schedules: [],
    homepage: { type: 'dashboard', id: dashboardId },
  };

  const dashboard: DashboardDocument = {
    version: 2,
    id: dashboardId,
    metadata: {
      title: dashboardTitle,
      description: cleanString(input.purpose) || `Starter dashboard for ${name}`,
      domain,
      subdomain: subdomain || undefined,
      groups,
      audience: audience || undefined,
      visibility,
      lifecycle,
      tags,
    },
    filters: dashboardFiltersForBlocks(selectedBlocks),
    layout: {
      kind: 'grid',
      cols: 12,
      rowHeight: 80,
      items: buildDashboardItems(projectRoot, selectedBlocks),
      responsive: responsiveLayoutsForDashboardItems(buildDashboardItems(projectRoot, selectedBlocks)),
    },
  };

  const paths = [
    join(appDir, 'dql.app.json'),
    join(appDir, 'README.md'),
    join(appDir, 'dashboards', `${dashboardId}.dqld`),
    join(appDir, 'notebooks'),
    join(appDir, 'drafts'),
  ];
  mkdirSync(join(appDir, 'dashboards'), { recursive: true });
  mkdirSync(join(appDir, 'notebooks'), { recursive: true });
  mkdirSync(join(appDir, 'drafts'), { recursive: true });
  writeFileSync(join(appDir, 'dql.app.json'), JSON.stringify(app, null, 2) + '\n', 'utf-8');
  writeFileSync(join(appDir, 'dashboards', `${dashboardId}.dqld`), JSON.stringify(dashboard, null, 2) + '\n', 'utf-8');
  writeFileSync(join(appDir, 'README.md'), appReadme(app, audience, selectedBlocks, dashboardId), 'utf-8');

  const created = collectAppsList(projectRoot).find((entry) => entry.id === id);
  if (!created) return { ok: false, error: `App was written but could not be reloaded: ${id}` };
  return {
    ok: true,
    app: created,
    paths: paths.map((path) => path.startsWith(projectRoot) ? path.slice(projectRoot.length + 1) : path),
    dashboardId,
  };
}

function createAppPackageViaBuildDraft(
  projectRoot: string,
  input: AppCreateRequest,
): ReturnType<typeof createAppPackage> {
  const name = cleanString(input.name);
  const domain = cleanString(input.ownerDomain) || cleanString(input.domain);
  if (!name) return { ok: false, error: 'name is required' };
  if (!domain) return { ok: false, error: 'domain is required' };
  const appId = suggestAppId(name);
  if (existsSync(resolveAppPackageDir(projectRoot, appId))) return { ok: false, error: `App already exists: ${appId}` };

  const selectedIds = unique((input.selectedBlockIds ?? []).map(cleanString).filter(Boolean));
  const blocks = collectBlockCandidates(projectRoot);
  const selectedBlocks = selectedIds
    .map((id) => blocks.find((block) => block.id === id || block.name === id))
    .filter((block): block is BlockCandidate => Boolean(block));
  const missing = selectedIds.filter((id) => !selectedBlocks.some((block) => block.id === id || block.name === id));
  if (missing.length) return { ok: false, error: `Unknown saved query selection: ${missing.join(', ')}` };
  const uncertified = selectedBlocks.filter((block) => block.status !== 'certified');
  if (uncertified.length) return { ok: false, error: `Manual App creation accepts certified saved queries only: ${uncertified.map((block) => block.name).join(', ')}` };

  const draft = createStoredAppBuildDraft(projectRoot, {
    appId,
    name,
    goal: name,
    audience: cleanString(input.audience),
    domain,
    authoringMode: 'manual',
  });
  const items = buildDashboardItems(projectRoot, selectedBlocks);
  const page = {
    ...draft.pages[0],
    id: slugify(cleanString(input.dashboardTitle) || 'Overview') || 'overview',
    metadata: {
      ...draft.pages[0].metadata,
      title: cleanString(input.dashboardTitle) || 'Overview',
      description: cleanString(input.purpose) || `Starter dashboard for ${name}`,
      domain,
      audience: cleanString(input.audience) || undefined,
    },
    filters: dashboardFiltersForBlocks(selectedBlocks),
    layout: {
      ...draft.pages[0].layout,
      items,
      responsive: responsiveLayoutsForDashboardItems(items),
    },
  } satisfies DashboardDocument;
  const operations: AppBuildDraftOperation[] = [
    ...(page.id === draft.pages[0].id ? [] : [{ type: 'remove_page' as const, pageId: draft.pages[0].id }]),
    { type: 'upsert_page', page },
    ...selectedBlocks.map((block): AppBuildDraftOperation => ({
      type: 'upsert_source',
      source: {
        id: `block:${block.id}`,
        kind: 'certified_block',
        sourceRef: block.id,
        sourceFingerprint: block.fingerprint,
        trustState: 'certified',
        reviewStatus: 'not_required',
      },
    })),
  ];
  const revised = applyAppBuildDraftOperations(draft, draft.revision, operations);
  writeStoredAppBuildDraft(projectRoot, revised, { expectedRevision: draft.revision, operations });
  try {
    const preflighted = markStoredAppBuildDraftPreflighted(projectRoot, revised);
    const committed = publishStoredAppBuildDraft(projectRoot, preflighted);
    return { ok: true, app: committed.app, paths: committed.paths, dashboardId: page.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildDashboardItems(projectRoot: string, blocks: BlockCandidate[]): DashboardDocument['layout']['items'] {
  let x = 0;
  let y = 0;
  let rowH = 0;
  return [...blocks]
    .sort((a, b) => vizRank(a.chartType) - vizRank(b.chartType))
    .map((block, index) => {
      const chartType = normalizeVizType(block.chartType);
      const size = tileSize(chartType);
      if (x + size.w > 12) {
        x = 0;
        y += rowH || size.h;
        rowH = 0;
      }
      const item = dashboardItemForBlock(
        block,
        chartType,
        x,
        y,
        size,
        index,
        filterBindingsForBlockSource(projectRoot, block),
      );
      x += size.w;
      rowH = Math.max(rowH, size.h);
      return item;
    });
}

function dashboardFiltersForBlocks(blocks: BlockCandidate[]): DashboardFilter[] {
  return unique(blocks.flatMap((block) => block.filterIds)).map((id) => ({
    id,
    label: id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase()),
    type: /(?:^|_)(?:top_n|limit|count|amount|number|minimum|maximum)(?:_|$)/i.test(id)
      ? 'number'
      : /(?:date|time|period|month|quarter|year)/i.test(id)
        ? 'date'
        : /(?:^|_)(?:name|id|search|email)(?:_|$)/i.test(id)
          ? 'search'
        : 'select',
    bindsTo: id,
  }));
}

function responsiveLayoutsForDashboardItems(items: DashboardGridItem[]): NonNullable<DashboardDocument['layout']['responsive']> {
  const project = (cols: number): DashboardGridItem[] => {
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    return [...items].sort((left, right) => left.y - right.y || left.x - right.x).map((item) => {
      const width = cols === 1 ? 1 : Math.min(cols, Math.max(2, Math.ceil(item.w / 2)));
      if (x + width > cols) {
        x = 0;
        y += rowHeight || item.h;
        rowHeight = 0;
      }
      const next = { ...item, x, y, w: width };
      x += width;
      rowHeight = Math.max(rowHeight, item.h);
      return next;
    });
  };
  return {
    wide: { kind: 'grid', cols: 12, rowHeight: 80, items },
    medium: { kind: 'grid', cols: 6, rowHeight: 80, items: project(6) },
    narrow: { kind: 'grid', cols: 1, rowHeight: 80, items: project(1) },
  };
}

function dashboardItemForBlock(
  block: BlockCandidate,
  chartType: ReturnType<typeof normalizeVizType>,
  x: number,
  y: number,
  size: { w: number; h: number },
  index: number,
  filterBindings: NonNullable<DashboardGridItem['filterBindings']> = [],
): DashboardDocument['layout']['items'][number] {
  return {
    i: slugify(block.name) || `tile-${index + 1}`,
    x,
    y,
    w: size.w,
    h: size.h,
    block: { blockId: block.name },
    viz: { type: chartType },
    display: displayForBlockHint(block, chartType),
    sourceClass: 'certified_block',
    review: { status: 'not_required', sourceFingerprint: block.fingerprint },
    trustState: 'certified',
    reviewStatus: 'certified',
    title: block.name,
    ...(filterBindings.length ? { filterBindings } : {}),
  };
}

function vizRank(chartType?: string): number {
  const normalized = normalizeVizType(chartType);
  if (normalized === 'single_value' || normalized === 'kpi') return 0;
  if (normalized === 'line' || normalized === 'area') return 1;
  if (normalized === 'bar' || normalized === 'pie' || normalized === 'funnel' || normalized === 'map') return 2;
  return 3;
}

function tileSize(chartType: string): { w: number; h: number } {
  if (chartType === 'single_value' || chartType === 'kpi') return { w: 3, h: 2 };
  if (chartType === 'table' || chartType === 'pivot') return { w: 6, h: 4 };
  return { w: 6, h: 3 };
}

function normalizeVizType(chartType?: string): DashboardGridItem['viz']['type'] {
  const normalized = (chartType ?? 'table').toLowerCase().replace(/-/g, '_');
  if (normalized === 'single' || normalized === 'single_value') return 'single_value';
  if (normalized === 'kpi') return 'kpi';
  if (normalized === 'line') return 'line';
  if (normalized === 'bar') return 'bar';
  if (normalized === 'grouped_bar') return 'grouped_bar';
  if (normalized === 'stacked_bar') return 'stacked_bar';
  if (normalized === 'area') return 'area';
  if (normalized === 'pie') return 'pie';
  if (normalized === 'donut') return 'donut';
  if (normalized === 'scatter') return 'scatter';
  if (normalized === 'heatmap') return 'heatmap';
  if (normalized === 'histogram') return 'histogram';
  if (normalized === 'waterfall') return 'waterfall';
  if (normalized === 'gauge') return 'gauge';
  if (normalized === 'pivot') return 'pivot';
  if (normalized === 'map') return 'map';
  if (normalized === 'funnel') return 'funnel';
  if (normalized === 'sankey' || normalized === 'flow') return 'sankey';
  if (normalized === 'text') return 'text';
  if (normalized === 'heading') return 'heading';
  return 'table';
}

function isSupportedVizType(chartType?: string): boolean {
  const normalized = (chartType ?? '').toLowerCase().replace(/-/g, '_');
  return [
    'single', 'single_value', 'kpi', 'line', 'bar', 'grouped_bar', 'stacked_bar',
    'area', 'pie', 'donut', 'scatter', 'heatmap', 'histogram', 'waterfall',
    'gauge', 'pivot', 'map', 'funnel', 'sankey', 'flow', 'table', 'text', 'heading',
  ].includes(normalized);
}

function displayForBlockHint(
  block: BlockCandidate,
  chartType: DashboardGridItem['viz']['type'],
): DashboardDisplayMetadata {
  const component = componentForViz(chartType, `${block.name} ${block.description} ${block.tags.join(' ')}`.toLowerCase());
  return {
    mode: 'block_hint',
    component,
    defaultVisualization: chartType,
    allowedVisualizations: allowedVisualizationsForComponent(component, chartType),
    layoutIntent: layoutIntentForComponent(component),
    rationale: `Block-level visualization is treated as a display hint for ${block.name}; apps and notebooks may override it.`,
    trustState: block.status === 'certified' ? 'certified' : 'draft_ready',
    reviewStatus: block.status === 'certified' ? 'certified' : 'draft_ready',
  };
}

function displayForAiPin(
  title: string,
  chartType: DashboardGridItem['viz']['type'],
  input: AiPinCreateRequest,
): DashboardDisplayMetadata {
  const text = `${title} ${cleanString(input.question)} ${cleanString(input.answer)}`.toLowerCase();
  const component = componentForViz(chartType, text);
  const certified = input.certification === 'certified' || input.reviewStatus === 'certified';
  return {
    mode: 'ai_generated',
    component,
    defaultVisualization: chartType,
    allowedVisualizations: allowedVisualizationsForComponent(component, chartType),
    layoutIntent: layoutIntentForComponent(component),
    rationale: 'AI-generated analysis pin saved as governed presentation metadata; promote the SQL to a draft saved query before treating it as reusable logic.',
    trustState: certified ? 'certified' : 'review_required',
    reviewStatus: certified ? 'certified' : 'review_required',
  };
}

function extractRecommendationColumns(
  schema: unknown,
  rows: Array<Record<string, unknown>>,
): Array<{ name: string; type?: string }> {
  const rawColumns = Array.isArray(schema)
    ? schema
    : schema && typeof schema === 'object' && Array.isArray((schema as { columns?: unknown }).columns)
      ? (schema as { columns: unknown[] }).columns
      : [];
  const columns = rawColumns.flatMap((column): Array<{ name: string; type?: string }> => {
    if (typeof column === 'string') return [{ name: column }];
    if (column && typeof column === 'object') {
      const record = column as Record<string, unknown>;
      const name = cleanString(record.name) || cleanString(record.field) || cleanString(record.id);
      if (!name) return [];
      const type = cleanString(record.type) || cleanString(record.dataType);
      return [{ name, ...(type ? { type } : {}) }];
    }
    return [];
  });
  if (columns.length > 0) return columns;
  const first = rows.find((row) => row && typeof row === 'object');
  return first ? Object.keys(first).map((name) => ({ name, type: typeof first[name] })) : [];
}

function recommendVizType(input: {
  columns: Array<{ name: string; type?: string }>;
  rows: Array<Record<string, unknown>>;
  prompt: string;
  blockChartType?: string;
}): DashboardGridItem['viz']['type'] {
  const names = input.columns.map((column) => column.name.toLowerCase());
  const hasTime = names.some((name) => /\b(date|time|week|month|quarter|year|season|period)\b/.test(name));
  const measures = input.columns.filter((column) => isMeasureColumn(column, input.rows));
  const dimensions = input.columns.filter((column) => !isMeasureColumn(column, input.rows));
  if (/\bpivot|matrix|cross.?tab\b/.test(input.prompt)) return 'pivot';
  if (/\bsankey|flow|flows|movement|journey|path|paths|supply.?chain|source.?to.?target|from .+ to\b/.test(input.prompt)
    && dimensions.length >= 2 && measures.length >= 1) return 'sankey';
  if (/\btrend|over time|weekly|monthly|daily|quarterly\b/.test(input.prompt) || (hasTime && measures.length > 0)) return 'line';
  if (/\bcorrelat|relationship between|versus|vs\.?\b/.test(input.prompt) && measures.length >= 2) return 'scatter';
  if (/\bdistribution|histogram|frequency|spread|bucket|bins?\b/.test(input.prompt) && measures.length >= 1) return 'histogram';
  if (/\bfunnel|conversion stages?|drop.?off|pipeline stages?\b/.test(input.prompt) && dimensions.length >= 1 && measures.length >= 1) return 'funnel';
  if (/\bwaterfall|bridge|contribution|change drivers?|variance drivers?\b/.test(input.prompt) && dimensions.length >= 1 && measures.length >= 1) return 'waterfall';
  if (/\bshare|composition|mix|proportion|percent of (?:the )?total\b/.test(input.prompt)
    && dimensions.length >= 1 && measures.length >= 1 && input.rows.length >= 2 && input.rows.length <= 8) return 'donut';
  if (/\btop|bottom|rank|ranking|leader|leaderboard|players?|scorers?\b/.test(input.prompt)) return 'bar';
  if (measures.length === 1 && dimensions.length === 0) return 'single_value';
  if (/\bcomplete|profile|details?|list|records?|rows?\b/.test(input.prompt) && input.columns.length >= 4) return 'table';
  if (dimensions.length > 0 && measures.length >= 2) return 'grouped_bar';
  if (dimensions.length > 0 && measures.length > 0) return 'bar';
  return normalizeVizType(input.blockChartType);
}

/** Whether an AI/default preference can actually be represented by the result. */
function visualizationFitsResult(
  viz: DashboardGridItem['viz']['type'],
  columns: Array<{ name: string; type?: string }>,
  rows: Array<Record<string, unknown>>,
): boolean {
  const measures = columns.filter((column) => isMeasureColumn(column, rows));
  const dimensions = columns.filter((column) => !isMeasureColumn(column, rows));
  const hasTime = columns.some((column) => /\b(date|time|week|month|quarter|year|season|period)\b/i.test(column.name));
  if (viz === 'table' || viz === 'pivot' || viz === 'text' || viz === 'heading') return true;
  // An empty row sample means "cannot judge", not "does not fit". Returning
  // false here silently rewrote every requested visualization to `table`
  // whenever no rows were supplied — which is the normal case when a tile is
  // configured before its first run, so authored and AI-chosen charts were
  // routinely discarded. Keep the request; the renderer copes with the shape.
  if (rows.length === 0) return true;
  if (viz === 'single_value' || viz === 'kpi' || viz === 'gauge') return rows.length === 1 && measures.length >= 1;
  if (viz === 'line' || viz === 'area') return hasTime && measures.length >= 1;
  if (viz === 'scatter') return measures.length >= 2;
  if (viz === 'sankey') return dimensions.length >= 2 && measures.length >= 1;
  if (viz === 'grouped_bar' || viz === 'stacked_bar') return dimensions.length >= 1 && measures.length >= 2;
  if (viz === 'pie' || viz === 'donut') return dimensions.length >= 1 && measures.length >= 1 && rows.length >= 2 && rows.length <= 8;
  if (viz === 'heatmap') return columns.length >= 3 && measures.length >= 1;
  if (viz === 'histogram') return measures.length >= 1;
  // Treat a model/default bar as a soft preference on a time series. The data
  // has an ordered axis, for which the deterministic recommendation is line.
  if (viz === 'bar') return dimensions.length >= 1 && measures.length >= 1 && !hasTime;
  return dimensions.length >= 1 && measures.length >= 1;
}

function isMeasureColumn(column: { name: string; type?: string }, rows: Array<Record<string, unknown>>): boolean {
  const type = (column.type ?? '').toLowerCase();
  if (/\b(number|numeric|decimal|double|float|integer|int|bigint|real)\b/.test(type)) return true;
  const name = column.name.toLowerCase();
  if (/(?:^|_)(?:count|sum|avg|average|total|revenue|sales|spend|arr|mrr|amount|balance|price|cost|profit|quantity|percent|percentage|pct|margin|ratio|share|rate|score|points?|goals?|rank|value)(?:_|$)/.test(name)) return true;
  const sample = rows.map((row) => row[column.name]).find((value) => value !== null && value !== undefined);
  return typeof sample === 'number';
}

function fieldHintsForColumns(
  columns: Array<{ name: string; type?: string }>,
  rows: Array<Record<string, unknown>>,
  prompt: string,
): Record<string, string> {
  const hints: Record<string, string> = {};
  const measures = columns.filter((column) => isMeasureColumn(column, rows));
  const questionTerms = new Set(prompt.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
  const measure = [...measures].sort((left, right) => {
    const score = (column: { name: string }) => column.name.toLowerCase().split(/[_-]+/).filter((term) => questionTerms.has(term)).length;
    return score(right) - score(left);
  })[0];
  const dimensions = columns.filter((column) => !isMeasureColumn(column, rows));
  const time = columns.find((column) => /\b(date|time|week|month|quarter|year|season|period)\b/i.test(column.name));
  const rank = columns.find((column) => /\b(rank|position)\b/i.test(column.name));
  const label = columns.find((column) =>
    !isMeasureColumn(column, rows) && /\b(name|player|customer|account|team|segment|region|category|label)\b/i.test(column.name),
  ) ?? columns.find((column) => !isMeasureColumn(column, rows));
  const asksForFlow = /\bsankey|flow|flows|movement|journey|path|paths|supply.?chain|source.?to.?target|from .+ to\b/i.test(prompt);
  const promptOrderedDimensions = asksForFlow
    ? dimensions
        .map((column) => ({ column, position: promptFieldPosition(prompt, column.name) }))
        .filter((item) => item.position >= 0)
        .sort((left, right) => left.position - right.position)
        .map((item) => item.column)
    : [];
  const source = promptOrderedDimensions[0]
    ?? dimensions.find((column) => /(?:^|_)(?:source|from|origin|upstream|supplier|producer|category)(?:_|$)/i.test(column.name))
    ?? dimensions[0];
  const target = promptOrderedDimensions.find((column) => column !== source)
    ?? dimensions.find((column) => column !== source && /(?:^|_)(?:target|to|destination|downstream|consumer|customer|product)(?:_|$)/i.test(column.name))
    ?? dimensions.find((column) => column !== source);
  if (label) hints.label = label.name;
  if (measure) hints.value = measure.name;
  if (time) hints.time = time.name;
  if (rank || /\brank|top|bottom\b/i.test(prompt)) hints.rank = rank?.name ?? 'rank';
  if (time && measure) {
    hints.x = time.name;
    hints.y = measure.name;
  } else if (label && measure) {
    hints.x = label.name;
    hints.y = measure.name;
  }
  if (source && target && measure) {
    hints.source = source.name;
    hints.target = target.name;
    hints.color = target.name;
    if (asksForFlow) {
      hints.x = source.name;
      hints.y = measure.name;
    }
  }
  if (measure) hints.format = displayFormatForColumn(measure.name);
  return hints;
}

function promptFieldPosition(prompt: string, field: string): number {
  const normalizedPrompt = prompt.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizedField = field.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalizedField ? normalizedPrompt.indexOf(normalizedField) : -1;
}

function displayFormatForColumn(column: string): 'currency' | 'percent' | 'number' {
  if (/(?:^|_)(?:percent|percentage|pct|ratio|share|conversion|churn|retention|utilization)(?:_|$)|(?:^|_)margin(?:_|$)/i.test(column)) return 'percent';
  if (/(?:^|_)(?:revenue|sales|spend|amount|price|cost|profit|income|expense|balance|budget|bookings|arr|mrr|gmv|fee|fees|charge|charges|tax|value)(?:_|$)/i.test(column)) return 'currency';
  return 'number';
}

function componentForViz(
  viz: DashboardGridItem['viz']['type'],
  text: string,
): DashboardDisplayMetadata['component'] {
  if (viz === 'single_value' || viz === 'kpi' || viz === 'gauge') return 'KpiMetric';
  if (viz === 'line' || viz === 'area') return 'TrendPanel';
  if (viz === 'pivot') return 'PivotTable';
  if (viz === 'text' || viz === 'heading') return /\btrust|evidence|caveat|quality\b/.test(text) ? 'TrustCallout' : 'NarrativePanel';
  if (/\btop|bottom|rank|ranking|leader|leaderboard|scorer|player\b/.test(text)) return 'RankingPanel';
  if (viz === 'bar' || viz === 'grouped_bar' || viz === 'stacked_bar' || viz === 'pie' || viz === 'donut') return 'RankingPanel';
  return 'EvidenceTable';
}

function allowedVisualizationsForComponent(
  component: DashboardDisplayMetadata['component'],
  primary: DashboardGridItem['viz']['type'],
): DashboardGridItem['viz']['type'][] {
  const base = new Set<DashboardGridItem['viz']['type']>([primary]);
  for (const viz of compatibleVisualizationsForComponent(component)) base.add(viz);
  return Array.from(base);
}

function compatibleVisualizationsForComponent(
  component: DashboardDisplayMetadata['component'],
): DashboardGridItem['viz']['type'][] {
  if (component === 'KpiMetric') {
    return ['single_value', 'kpi', 'gauge', 'table'];
  }
  if (component === 'TrendPanel') return ['line', 'area', 'bar', 'table'];
  if (component === 'RankingPanel') return ['bar', 'grouped_bar', 'stacked_bar', 'pie', 'donut', 'table'];
  if (component === 'PivotTable') return ['pivot', 'table', 'bar'];
  if (component === 'EvidenceTable') return ['table', 'bar', 'scatter', 'heatmap', 'histogram', 'waterfall', 'map', 'funnel', 'sankey'];
  return ['text', 'heading'];
}

function componentVizCompatible(
  component: DashboardDisplayMetadata['component'],
  viz: DashboardGridItem['viz']['type'],
): boolean {
  return compatibleVisualizationsForComponent(component).includes(viz);
}

function layoutIntentForComponent(component: DashboardDisplayMetadata['component']): DashboardDisplayMetadata['layoutIntent'] {
  if (component === 'KpiMetric' || component === 'TrustCallout' || component === 'ResearchActions') return 'compact';
  if (component === 'TrendPanel' || component === 'RankingPanel') return 'wide';
  if (component === 'PivotTable' || component === 'EvidenceTable') return 'standard';
  if (component === 'BusinessBrief') return 'wide';
  return 'standard';
}

function recommendationRationale(
  component: DashboardDisplayMetadata['component'],
  viz: DashboardGridItem['viz']['type'],
  block: BlockCandidate | undefined,
  columns: Array<{ name: string; type?: string }>,
  prompt: string,
): string {
  if (block) {
    return `Recommended ${component} with ${viz} from the saved query display hint and result shape. The certified saved query remains the business logic source.`;
  }
  if (columns.length > 0) {
    return `Recommended ${component} with ${viz} from ${columns.length} output column(s) and the app prompt. This is consumer-level metadata pending review.`;
  }
  return prompt
    ? `Recommended ${component} with ${viz} from the app prompt. Review against previewed fields before sharing.`
    : `Recommended ${component} with ${viz} as a safe table-first presentation fallback.`;
}

function appReadme(app: AppDocument, audience: string, blocks: BlockCandidate[], dashboardId = 'overview'): string {
  return [
    `# ${app.name}`,
    '',
    app.description ?? '',
    '',
    `- Domain: ${app.domain}`,
    ...(app.subdomain ? [`- Subdomain: ${app.subdomain}`] : []),
    ...(app.groups?.length ? [`- Groups: ${app.groups.join(', ')}`] : []),
    `- Audience: ${audience || 'not specified'}`,
    `- Visibility: ${app.visibility}`,
    `- Lifecycle: ${app.lifecycle}`,
    `- Owners: ${app.owners.join(', ')}`,
    `- Starter dashboard: dashboards/${dashboardId}.dqld`,
    `- Supporting notebooks: notebooks/`,
    `- Draft blocks: drafts/`,
    '',
    '## Selected Certified Blocks',
    '',
    ...(blocks.length > 0
      ? blocks.map((block) => `- ${block.name} (${block.domain}, ${block.status}) - ${block.path}`)
      : ['No blocks selected yet. Add certified blocks from the Apps Command Center.']),
    '',
    '## Governance',
    '',
    'This OSS App uses local persona switching with owner, analyst, and viewer roles. Real authentication and SSO are intentionally outside OSS scope.',
    '',
  ].join('\n');
}

function collectBlockCandidates(projectRoot: string, options: { preserveDuplicates?: boolean } = {}): BlockCandidate[] {
  const blocks: BlockCandidate[] = [];
  const seen = new Set<string>();
  const scanDir = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSyncSafe(dir)) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(filePath);
      } else if (entry.isFile() && entry.name.endsWith('.dql') && !seen.has(filePath)) {
        try {
          seen.add(filePath);
          const source = readFileSync(filePath, 'utf-8');
          const stat = statSyncSafe(filePath);
          const name = matchString(source, /block\s+"([^"]+)"/);
          // The App source picker is an executable-block catalog. Domain terms,
          // skills, and other .dql context remain available to planning, but they
          // must not appear as addable dashboard data sources.
          if (!name) continue;
          const tags = matchArray(source, /tags\s*=\s*\[([^\]]*)\]/);
          blocks.push({
            id: name,
            name,
            domain: matchString(source, /domain\s*=\s*"([^"]+)"/) ?? 'uncategorized',
            status: matchString(source, /status\s*=\s*"([^"]+)"/) ?? 'draft',
            owner: matchString(source, /owner\s*=\s*"([^"]+)"/),
            tags,
            path: relative(projectRoot, filePath).replaceAll('\\', '/'),
            fingerprint: `sha256:${createHash('sha256').update(source).digest('hex')}`,
            lastModified: stat?.mtime.toISOString() ?? new Date(0).toISOString(),
            description: matchString(source, /description\s*=\s*"((?:[^"\\]|\\.)*)"/) ?? '',
            llmContext: matchString(source, /llmContext\s*=\s*"((?:[^"\\]|\\.)*)"/),
            ...(matchString(source, /^\s*replacedBy\s*=\s*"([^"]+)"/m) ? { replacedBy: matchString(source, /^\s*replacedBy\s*=\s*"([^"]+)"/m)! } : {}),
            chartType: matchString(source, /chart\s*=\s*"([^"]+)"/) ?? matchString(source, /chart\.(\w+)\s*\(/) ?? undefined,
            filterIds: declaredAppFilterIds(source),
            dimensionIds: declaredAppDimensionIds(source),
            score: 0,
            reasons: [],
          });
        } catch {
          // skip unreadable block
        }
      }
    }
  };
  scanDir(join(projectRoot, 'blocks'));
  scanDir(join(projectRoot, 'domains'));
  if (options.preserveDuplicates) return blocks.sort((left, right) => left.path.localeCompare(right.path));
  const byId = new Map<string, BlockCandidate>();
  for (const block of blocks) {
    const current = byId.get(block.id);
    if (!current) {
      byId.set(block.id, block);
      continue;
    }
    const blockRank = (block.status === 'certified' ? 4 : 0) + (block.path.startsWith('domains/') ? 2 : 0);
    const currentRank = (current.status === 'certified' ? 4 : 0) + (current.path.startsWith('domains/') ? 2 : 0);
    if (blockRank > currentRank || (blockRank === currentRank && block.lastModified > current.lastModified)) byId.set(block.id, block);
  }
  return Array.from(byId.values());
}

function canonicalAppBlockSourceId(block: Pick<BlockCandidate, 'domain' | 'path' | 'name'>): string {
  const pathIdentity = createHash('sha256').update(`${block.path}\u0000${block.name}`).digest('hex').slice(0, 20);
  return `app:block:${block.domain || 'global'}:${pathIdentity}`;
}

function declaredAppFilterIds(source: string): string[] {
  const filterSection = sectionBody(source, 'filterBindings');
  const parameterSection = sectionBody(source, 'parameterPolicy');
  return unique([
    ...matchArray(source, /allowedFilters\s*=\s*\[([^\]]*)\]/),
    ...Array.from(filterSection.matchAll(/^\s*([A-Za-z_][\w-]*)\s*=\s*"[^"]+"/gm)).map((match) => match[1]),
    ...Array.from(parameterSection.matchAll(/^\s*([A-Za-z_][\w-]*)\s*=\s*"(?:dynamic|optional|business)"/gm)).map((match) => match[1]),
  ]);
}

function declaredAppDimensionIds(source: string): string[] {
  return unique(matchArray(source, /dimensions\s*=\s*\[([^\]]*)\]/));
}

function readdirSyncSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statSyncSafe(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function matchString(source: string, regex: RegExp): string | null {
  const match = regex.exec(source);
  return match?.[1]?.replace(/\\"/g, '"').trim() || null;
}

function matchArray(source: string, regex: RegExp): string[] {
  const match = regex.exec(source);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function normalizeConversationMessages(messages: AppConversationMessageRequest[] | undefined): Array<{
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  events?: unknown[];
  createdAt?: string;
}> {
  return (messages ?? [])
    .map((message) => ({
      id: cleanString(message.id) || undefined,
      role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
      content: cleanString(message.content),
      events: Array.isArray(message.events) ? message.events : [],
      createdAt: cleanString(message.createdAt) || undefined,
    }))
    .filter((message) => message.content.length > 0);
}

async function runAppInvestigation(
  ctx: Ctx,
  storage: LocalAppStorage,
  investigation: LocalAppInvestigation,
  input: AppInvestigationRunRequest | AppInvestigationCreateRequest = {},
): Promise<LocalAppInvestigation> {
  const question = cleanString(input.question) || investigation.question;
  const context = input.context === undefined ? investigation.context : input.context;
  const intent = normalizeInvestigationIntent('intent' in input ? input.intent : investigation.intent, question, context);
  const title = cleanString('title' in input ? input.title : undefined)
    || cleanString(investigation.title)
    || titleFromInvestigation(question, selectedBlockContext(context));
  const rebuildFromCertified = 'repairMode' in input && input.repairMode === 'rebuild_from_certified';
  let generatedSql = cleanString(input.generatedSql) || (rebuildFromCertified ? undefined : investigation.generatedSql);
  const lastRunAt = new Date().toISOString();
  storage.updateAppInvestigation(investigation.id, {
    question,
    intent,
    context,
    generatedSql,
    status: 'running',
    reviewStatus: 'needs_review',
    error: '',
  });

  try {
    const selected = selectedBlockContext(context);
    const appInfo = ctx.path.includes('/api/apps/') ? loadAppById(ctx.projectRoot, investigation.appId) : null;
    const previews = buildContextPreviews(selected);
    let metricSnapshot = buildMetricSnapshot(selected);
    let driverCards = buildDriverCards(selected, intent);
    const baselineGap = intent === 'diagnose_change' && hasSelectedRows(selected) && !hasComparableTimeBaseline(selected);
    const sourceTileId = investigation.sourceTileId ?? selectedContextString(context, 'tileId');
    const sourceBlockId = investigation.sourceBlockId ?? selectedContextString(context, 'blockId');
    const routeDecision = appAnalysisRouteDecisionFromContext(context, intent, selected, question);
    const sqlTemplateValues = buildInvestigationSqlTemplateValues(ctx.projectRoot, context, selected, sourceBlockId);
    if (generatedSql) {
      generatedSql = renderSqlTemplateParams(generatedSql, sqlTemplateValues).sql;
    }
    const deterministicGeneration = generatedSql || baselineGap
      ? undefined
      : buildDeterministicInvestigationSql(ctx.projectRoot, {
          question,
          intent,
          selected,
          sourceBlockId,
          context,
        });
    generatedSql = generatedSql || deterministicGeneration?.sql;
    let agentGeneration: AppInvestigationGenerationResult | undefined;
    if (!generatedSql && !baselineGap) {
      agentGeneration = await generateInvestigationSql(ctx, {
          appId: investigation.appId,
          dashboardId: investigation.dashboardId ?? selectedString(context, 'dashboardId'),
          sourceTileId,
          sourceBlockId,
          title: investigation.title,
          question,
          intent,
          context,
          mode: 'sql_and_memo',
        });
    }
    generatedSql = generatedSql || cleanString(agentGeneration?.sql);
    const generationError = cleanString(agentGeneration?.executionError);
    const sqlEvidence = agentGeneration?.result
      ? { preview: buildGeneratedSqlPreview(agentGeneration.result, generatedSql), error: generationError || undefined }
      : await runGeneratedSqlPreview(ctx, generatedSql);
    const sqlError = sqlEvidence.error ?? generationError;
    const sqlErrorKind = classifySqlPreviewError(sqlError);
    if (sqlEvidence.preview) {
      previews.unshift(sqlEvidence.preview);
      metricSnapshot = buildPreviewMetricSnapshot(sqlEvidence.preview, selectedString(selected, 'title'));
      driverCards = buildPreviewDriverCards(sqlEvidence.preview, intent);
    }
    const hasReportEvidence = previews.length > 0 || driverCards.length > 0 || Object.keys(metricSnapshot).length > 0;
    const reportSqlError = shouldSurfaceSqlPreviewIssue({
      sqlError,
      sqlErrorKind,
      generatedSql,
      hasReportEvidence,
    }) ? sqlError : undefined;
    const fallbackSummary = baselineGap
      ? buildMissingBaselineSummary(question, selected)
      : buildInvestigationSummary(intent, question, selected, metricSnapshot, driverCards);
    const recommendation = baselineGap
      ? buildMissingBaselineRecommendation(selected)
      : buildInvestigationRecommendation(intent, selected, reportSqlError, sqlErrorKind);
    const memoGeneration = !baselineGap && shouldRequestProviderMemo({
      ctx,
      generatedSql,
      agentGeneration,
      hasReportEvidence,
    })
      ? await generateInvestigationSql(ctx, {
          appId: investigation.appId,
          dashboardId: investigation.dashboardId ?? selectedString(context, 'dashboardId'),
          sourceTileId,
          sourceBlockId,
          title: investigation.title,
          question,
          intent,
          context,
          mode: 'memo_only',
          generatedSql,
          metrics: metricSnapshot,
          drivers: driverCards,
          resultPreviews: previews.slice(0, 4),
          summaryHint: fallbackSummary,
          recommendationHint: recommendation,
          sqlError: reportSqlError,
          sqlErrorKind,
          hasReportEvidence,
        })
      : undefined;
    const narrativeGeneration = cleanString(memoGeneration?.answer) ? memoGeneration : agentGeneration;
    const evidence = {
      trustStatus: buildInvestigationTrust(investigation, selected, sqlError),
      planner: {
        intent,
        steps: investigationSteps(intent),
        reviewRequired: true,
        generatedSql: generatedSql || undefined,
        sqlExecuted: Boolean(sqlEvidence.preview),
        sqlError,
        sqlErrorKind,
        generationSource: baselineGap ? 'missing_baseline' : deterministicGeneration ? 'selected_block_metadata' : agentGeneration?.providerUsed ? 'ai_provider' : generatedSql ? 'provided_sql' : 'context_only',
        repairMode: rebuildFromCertified ? 'rebuild_from_certified' : undefined,
        baselineGap,
        sourceBlockPath: deterministicGeneration?.sourceBlockPath,
        sourceBlockName: deterministicGeneration?.sourceBlockName,
        providerUsed: agentGeneration?.providerUsed,
        memoProviderUsed: memoGeneration?.providerUsed,
        memoSource: cleanString(narrativeGeneration?.answer) ? 'ai_provider' : 'deterministic_template',
        routeDecision,
      },
      certifiedContext: {
        appId: investigation.appId,
        appName: appInfo?.app.name,
        dashboardId: investigation.dashboardId,
        dashboardTitle: selectedString(context, 'dashboardTitle'),
        sourceTileId,
        sourceBlockId,
        sourceBlockPath: deterministicGeneration?.sourceBlockPath ?? selectedString(selected, 'blockPath'),
        certificationStatus: selectedString(selected, 'certificationStatus'),
      },
      routeDecision,
      assumptions: [
        ...investigationAssumptions(intent, selected, generatedSql, sqlError),
        ...(baselineGap ? ['The selected tile sample does not include at least two comparable time values, so ZLens did not invent a change query from an unrelated table.'] : []),
      ],
      context,
      agentEvidence: narrativeGeneration?.evidence ?? agentGeneration?.evidence,
      analysisPlan: narrativeGeneration?.analysisPlan ?? agentGeneration?.analysisPlan,
      citations: narrativeGeneration?.citations ?? agentGeneration?.citations,
    };
    const summary = cleanString(narrativeGeneration?.answer) || fallbackSummary;
    const reportSections = buildInvestigationReportSections({
      intent,
      question,
      context,
      selected,
      metrics: metricSnapshot,
      drivers: driverCards,
      summary,
      recommendation,
      agentAnswer: narrativeGeneration?.answer,
      hasReportEvidence,
      sqlError: reportSqlError,
      sqlErrorKind,
      baselineGap,
    });
    return storage.updateAppInvestigation(investigation.id, {
      title,
      question,
      intent,
      context,
      status: sqlEvidence.fatal && !hasReportEvidence ? 'error' : 'ready',
      summary,
      recommendation,
      metrics: metricSnapshot,
      driverCards,
      resultPreviews: previews,
      evidence,
      reportSections,
      generatedSql,
      reviewStatus: 'needs_review',
      error: reportSqlError ?? '',
      lastRunAt,
    }) ?? investigation;
  } catch (err) {
    return storage.updateAppInvestigation(investigation.id, {
      status: 'error',
      reviewStatus: 'needs_review',
      error: err instanceof Error ? err.message : String(err),
      lastRunAt,
    }) ?? investigation;
  }
}

function scheduleAppInvestigationRun(
  ctx: Ctx,
  appId: string,
  investigationId: string,
  input: AppInvestigationRunRequest | AppInvestigationCreateRequest,
): void {
  const runContext: Ctx = { ...ctx };
  setTimeout(() => {
    void (async () => {
      const storage = openAppStorage(runContext.projectRoot);
      try {
        const current = storage.getAppInvestigation(investigationId);
        if (!current || current.appId !== appId) return;
        await runAppInvestigation(runContext, storage, current, input);
      } finally {
        storage.close();
      }
    })();
  }, 0);
}

function createOrReuseAppInvestigation(
  storage: LocalAppStorage,
  input: AppInvestigationCreateRequest & {
    appId: string;
    question: string;
    sourceTileId?: string;
    sourceBlockId?: string;
    intent?: LocalAppInvestigationIntent;
  },
): LocalAppInvestigation {
  if (!cleanString(input.generatedSql)) {
    const reusable = findReusableAppInvestigation(storage, {
      appId: input.appId,
      dashboardId: input.dashboardId,
      sourceTileId: input.sourceTileId,
      sourceBlockId: input.sourceBlockId,
      question: input.question,
      intent: input.intent,
      context: input.context,
    });
    if (reusable) {
      return storage.updateAppInvestigation(reusable.id, {
        title: input.title ?? reusable.title,
        question: input.question,
        intent: input.intent ?? reusable.intent,
        context: input.context,
        dashboardId: input.dashboardId,
        sourceTileId: input.sourceTileId,
        sourceBlockId: input.sourceBlockId,
      }) ?? reusable;
    }
  }
  return storage.createAppInvestigation(input);
}

function findReusableAppInvestigation(
  storage: LocalAppStorage,
  input: {
    appId: string;
    dashboardId?: string;
    sourceTileId?: string;
    sourceBlockId?: string;
    question: string;
    intent?: LocalAppInvestigationIntent;
    context?: unknown;
  },
): LocalAppInvestigation | null {
  const storageWithMethod = storage as LocalAppStorage & {
    findReusableAppInvestigation?: (value: typeof input) => LocalAppInvestigation | null;
  };
  if (typeof storageWithMethod.findReusableAppInvestigation === 'function') {
    return storageWithMethod.findReusableAppInvestigation(input);
  }
  const target = appInvestigationReuseFingerprint(input);
  return storage.listAppInvestigations(input.appId, input.dashboardId).find((item) => {
    if (item.reviewStatus === 'rejected') return false;
    return appInvestigationReuseFingerprint(item) === target;
  }) ?? null;
}

function appInvestigationReuseFingerprint(input: {
  appId: string;
  dashboardId?: string;
  sourceTileId?: string;
  sourceBlockId?: string;
  question: string;
  intent?: LocalAppInvestigationIntent;
  context?: unknown;
}): string {
  return [
    normalizeFingerprintString(input.appId),
    normalizeFingerprintString(input.dashboardId),
    normalizeFingerprintString(input.sourceTileId),
    normalizeFingerprintString(input.sourceBlockId),
    normalizeFingerprintString(input.question),
    normalizeFingerprintString(input.intent ?? 'driver_breakdown'),
    stableInvestigationFingerprintValue(input.context),
  ].join('|');
}

function normalizeFingerprintString(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function stableInvestigationFingerprintValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return JSON.stringify(stableInvestigationFingerprintObject(value));
}

function stableInvestigationFingerprintObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableInvestigationFingerprintObject);
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (/^(nonce|timestamp|createdAt|updatedAt|lastRunAt)$/i.test(key)) continue;
    out[key] = stableInvestigationFingerprintObject(record[key]);
  }
  return out;
}

function normalizeInvestigationIntent(
  value: unknown,
  question: string,
  context: unknown,
): LocalAppInvestigationIntent {
  if (
    value === 'diagnose_change'
    || value === 'driver_breakdown'
    || value === 'segment_compare'
    || value === 'entity_drilldown'
    || value === 'anomaly_investigation'
    || value === 'trust_gap_review'
  ) return value;
  const text = `${question} ${JSON.stringify(safeIntentContext(context)).slice(0, 500)}`.toLowerCase();
  if (/\b(trust|rely|certif|lineage|owner|caveat|gap)\b/.test(text)) return 'trust_gap_review';
  if (/\b(anomal|exception|outlier|spike|dip)\b/.test(text)) return 'anomaly_investigation';
  if (/\b(compare|versus| vs |segment|cohort)\b/.test(text)) return 'segment_compare';
  if (/\b(why|changed|change|drop|decline|increase|decrease|february|month|week|quarter)\b/.test(text)) return 'diagnose_change';
  if (/\b(driver|drove|break down|breakdown|contribute|top mover|movers)\b/.test(text)) return 'driver_breakdown';
  if (/\b(customer|account|user|client|merchant|product|sku|alice|johnson)\b/.test(text)) return 'entity_drilldown';
  return 'driver_breakdown';
}

function safeIntentContext(context: unknown): Record<string, unknown> {
  const root = asRecord(context);
  return {
    selectedBlock: root ? root.selectedBlock ?? root.focusBlock : undefined,
    dashboardTitle: root ? root.dashboardTitle : undefined,
    availableBlocks: root ? root.availableBlocks : undefined,
  };
}

function selectedBlockContext(context: unknown): Record<string, unknown> | null {
  const root = asRecord(context);
  const selected = asRecord(root?.selectedBlock) ?? asRecord(root?.focusBlock);
  if (selected) return selected;
  if (!root) return null;
  const hasSelectedTileContext = ['blockId', 'blockPath', 'tileId', 'certificationStatus', 'resultSample', 'rowCount']
    .some((key) => root[key] !== undefined && root[key] !== null);
  return hasSelectedTileContext ? root : null;
}

function selectedContextString(context: unknown, key: string): string | undefined {
  return selectedString(selectedBlockContext(context), key);
}

function selectedString(context: unknown, key: string): string | undefined {
  const record = asRecord(context);
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildContextPreviews(selected: Record<string, unknown> | null): unknown[] {
  const rows = selectedRows(selected);
  if (rows.length === 0) return [];
  const columns = selectedColumns(selected, rows);
  return [{
    id: 'selected-tile-sample',
    title: 'Selected tile evidence',
    kind: 'table',
    reviewRequired: true,
    result: {
      columns,
      rows,
      rowCount: typeof selected?.rowCount === 'number' ? selected.rowCount : rows.length,
    },
  }];
}

function buildMetricSnapshot(selected: Record<string, unknown> | null): Record<string, unknown> {
  const rows = selectedRows(selected);
  const columns = selectedColumns(selected, rows);
  const numericColumns = columns.filter((column) => rows.some((row) => typeofNumber(row[column]) !== null));
  const metricColumn = numericColumns[0];
  if (!metricColumn || rows.length === 0) {
    return {
      currentValue: undefined,
      baselineValue: undefined,
      delta: undefined,
      context: 'Metric values were not available in the selected tile sample.',
    };
  }
  const topRow = rows.find((row) => typeofNumber(row[metricColumn]) !== null);
  const comparisonRow = rows.slice(1).find((row) => typeofNumber(row[metricColumn]) !== null);
  const dimensionColumn = columns.find((column) => column !== metricColumn && rows.some((row) => typeof row[column] === 'string'));
  const currentValue = typeofNumber(topRow?.[metricColumn]);
  const baselineValue = typeofNumber(comparisonRow?.[metricColumn]);
  const delta = currentValue !== null && baselineValue !== null ? currentValue - baselineValue : undefined;
  const topLabel = dimensionColumn && topRow ? cleanString(topRow[dimensionColumn]) : '';
  const comparisonLabel = dimensionColumn && comparisonRow ? cleanString(comparisonRow[dimensionColumn]) : '';
  return {
    metric: metricColumn,
    currentValue,
    baselineValue,
    delta,
    currentLabel: 'Top value',
    baselineLabel: 'Next comparison',
    deltaLabel: 'Top gap',
    currentDetail: topLabel ? `${topLabel} / ${metricColumn}` : 'highest ranked evidence row',
    baselineDetail: comparisonLabel ? `${comparisonLabel} / ${metricColumn}` : 'next comparable evidence row',
    deltaDetail: comparisonLabel ? `difference between ${topLabel || 'top row'} and ${comparisonLabel}` : 'difference to next comparison',
    rowsReviewed: rows.length,
    context: selectedString(selected, 'title') ?? 'Selected dashboard tile',
  };
}

function hasSelectedRows(selected: Record<string, unknown> | null): boolean {
  return selectedRows(selected).length > 0;
}

function hasComparableTimeBaseline(selected: Record<string, unknown> | null): boolean {
  const rows = selectedRows(selected);
  if (rows.length < 2) return false;
  const columns = selectedColumns(selected, rows);
  const profile = profileResultColumns(columns, rows);
  const timeDimension = chooseTimeDimension(profile);
  if (!timeDimension) return false;
  const values = new Set(
    rows
      .map((row) => row[timeDimension.name])
      .filter((value) => value !== null && value !== undefined && String(value).trim())
      .map((value) => String(value)),
  );
  return values.size >= 2;
}

function buildDriverCards(
  selected: Record<string, unknown> | null,
  intent: LocalAppInvestigationIntent,
): Array<Record<string, unknown>> {
  const rows = selectedRows(selected);
  const columns = selectedColumns(selected, rows);
  if (rows.length === 0) {
    return [{
      title: 'Runtime context needed',
      contribution: 'Needs SQL preview',
      explanation: 'The selected tile did not include sample rows, so ZLens captured the question and review path for a deeper SQL run.',
      intent,
    }];
  }
  const numericColumn = columns.find((column) => rows.some((row) => typeofNumber(row[column]) !== null));
  const dimensionColumn = columns.find((column) => column !== numericColumn && rows.some((row) => typeof row[column] === 'string'));
  if (!numericColumn) {
    return rows.slice(0, 5).map((row, index) => ({
      title: String(row[dimensionColumn ?? columns[0]] ?? `Row ${index + 1}`),
      contribution: 'Context row',
      explanation: 'This row is part of the tile evidence for the investigation.',
    }));
  }
  return rows
    .map((row, index) => {
      const value = typeofNumber(row[numericColumn]) ?? 0;
      const label = String(row[dimensionColumn ?? columns[0]] ?? `Row ${index + 1}`);
      return {
        title: label,
        value,
        contribution: formatContribution(value),
        explanation: `${label} is one of the highest-signal rows in the selected tile sample for ${numericColumn}.`,
        evidenceLabel: numericColumn,
      };
    })
    .sort((a, b) => Math.abs(Number(b.value ?? 0)) - Math.abs(Number(a.value ?? 0)))
    .slice(0, 5);
}

function buildPreviewMetricSnapshot(preview: Record<string, unknown>, fallbackTitle?: string): Record<string, unknown> {
  const rows = previewResultRows(preview);
  const columns = previewResultColumns(preview, rows);
  const numericColumns = columns.filter((column) => rows.some((row) => typeofNumber(row[column]) !== null));
  if (rows.length === 0 || numericColumns.length === 0) {
    return {
      currentValue: undefined,
      baselineValue: undefined,
      delta: undefined,
      context: 'Generated SQL preview did not return numeric metric rows.',
    };
  }
  const currentColumn = pickColumn(numericColumns, [/^current_/i, /current.*(revenue|value|amount|total|orders?)/i])
    ?? pickColumn(numericColumns, [/^total_/i, /(revenue|value|amount|total|orders?|points?|goals?|assists?|rebounds?|score|games_played)$/i])
    ?? pickColumn(numericColumns, [/(count|row_count)$/i])
    ?? numericColumns[0];
  const baselineColumn = pickColumn(numericColumns, [/^baseline_/i, /baseline.*(revenue|value|amount|total|orders?)/i]);
  const deltaColumn = pickColumn(numericColumns, [/(delta|change|variance|diff|contribution)/i]);
  const currentValue = sumNumericRows(rows, currentColumn);
  const baselineValue = baselineColumn ? sumNumericRows(rows, baselineColumn) : typeofNumber(rows[0]?.[currentColumn]);
  const delta = deltaColumn
    ? sumNumericRows(rows, deltaColumn)
    : currentValue !== null && baselineValue !== null
      ? currentValue - baselineValue
      : undefined;
  return {
    metric: deltaColumn ?? currentColumn,
    currentValue,
    baselineValue,
    delta,
    rowsReviewed: rows.length,
    context: fallbackTitle ?? selectedString(preview, 'title') ?? 'Generated SQL preview',
  };
}

function buildPreviewDriverCards(
  preview: Record<string, unknown>,
  intent: LocalAppInvestigationIntent,
): Array<Record<string, unknown>> {
  const rows = previewResultRows(preview);
  const columns = previewResultColumns(preview, rows);
  if (rows.length === 0) {
    return buildDriverCards(null, intent);
  }
  const numericColumns = columns.filter((column) => rows.some((row) => typeofNumber(row[column]) !== null));
  const contributionColumn = pickColumn(numericColumns, [/(delta|change|variance|diff|contribution)/i])
    ?? pickColumn(numericColumns, [/^current_/i, /^total_/i, /(revenue|value|amount|total|orders?|points?|goals?|assists?|rebounds?|score|games_played)$/i])
    ?? pickColumn(numericColumns, [/(count|row_count)$/i])
    ?? numericColumns[0];
  const dimensionColumn = columns.find((column) => column !== contributionColumn && rows.some((row) => typeof row[column] === 'string'));
  if (!contributionColumn) {
    return rows.slice(0, 5).map((row, index) => ({
      title: String(row[dimensionColumn ?? columns[0]] ?? `Row ${index + 1}`),
      contribution: 'Preview row',
      explanation: 'This row came from the generated SQL preview and needs analyst review.',
      intent,
    }));
  }
  return rows
    .map((row, index) => {
      const value = typeofNumber(row[contributionColumn]) ?? 0;
      const label = String(row[dimensionColumn ?? columns[0]] ?? `Row ${index + 1}`);
      return {
        title: label,
        value,
        contribution: formatContribution(value),
        explanation: `${label} is ranked by ${contributionColumn} from the generated SQL preview.`,
        evidenceLabel: contributionColumn,
        reviewRequired: true,
        intent,
      };
    })
    .sort((a, b) => Math.abs(Number(b.value ?? 0)) - Math.abs(Number(a.value ?? 0)))
    .slice(0, 5);
}

function previewResultRows(preview: Record<string, unknown>): Array<Record<string, unknown>> {
  const result = asRecord(preview.result);
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  return rows.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row)).slice(0, 100);
}

function previewResultColumns(preview: Record<string, unknown>, rows: Array<Record<string, unknown>>): string[] {
  const result = asRecord(preview.result);
  const columns = Array.isArray(result?.columns) ? result.columns.map(String).filter(Boolean) : [];
  return columns.length > 0 ? columns.slice(0, 20) : Object.keys(rows[0] ?? {}).slice(0, 20);
}

function pickColumn(columns: string[], patterns: RegExp[]): string | undefined {
  return columns.find((column) => patterns.some((pattern) => pattern.test(column)));
}

function sumNumericRows(rows: Array<Record<string, unknown>>, column: string): number | null {
  let total = 0;
  let found = false;
  for (const row of rows) {
    const value = typeofNumber(row[column]);
    if (value === null) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

function buildDeterministicInvestigationSql(
  projectRoot: string,
  input: {
    question: string;
    intent: LocalAppInvestigationIntent;
    selected: Record<string, unknown> | null;
    sourceBlockId?: string;
    context?: unknown;
  },
): { sql: string; sourceBlockPath: string; sourceBlockName: string } | undefined {
  if (input.intent === 'trust_gap_review') return undefined;
  const block = resolveSelectedBlock(projectRoot, input.selected, input.sourceBlockId);
  if (!block) return undefined;
  const source = readFileSync(join(projectRoot, block.path), 'utf-8');
  const rawBlockSql = extractDqlQuery(source);
  if (!rawBlockSql) return undefined;
  const rendered = renderSqlTemplateParams(
    rawBlockSql,
    buildInvestigationSqlTemplateValues(projectRoot, input.context, input.selected, input.sourceBlockId),
  );
  const blockSql = rendered.sql;
  if (rendered.unresolved.length > 0 || /\{\{/.test(blockSql) || !isReadOnlySql(blockSql)) return undefined;
  const rows = selectedRows(input.selected);
  const columns = selectedColumns(input.selected, rows);
  const sourceSql = stripTopLevelOrderAndLimit(blockSql);
  const profile = profileResultColumns(columns, rows);
  const measure = chooseMeasureColumn(profile);
  if (!measure) return undefined;
  const dimension = chooseDimensionColumn(input.question, profile, input.intent);
  const sourceCte = `WITH dql_source AS (\n${sourceSql}\n)`;

  if (input.intent === 'entity_drilldown') {
    const entity = inferEntityFilter(input.question, profile, rows);
    const orderBy = `ORDER BY ${quoteSqlIdentifier(measure.name)} DESC`;
    const where = entity ? `\nWHERE ${quoteSqlIdentifier(entity.column)} IS NOT NULL AND LOWER(CAST(${quoteSqlIdentifier(entity.column)} AS VARCHAR)) LIKE ${sqlStringLiteral(`%${entity.value.toLowerCase()}%`)}` : '';
    return {
      sql: `${sourceCte}\nSELECT *\nFROM dql_source${where}\n${orderBy}\nLIMIT 100`,
      sourceBlockPath: block.path,
      sourceBlockName: block.name,
    };
  }

  if (input.intent === 'anomaly_investigation' || input.intent === 'diagnose_change') {
    const timeDimension = chooseTimeDimension(profile) ?? dimension;
    const rankExpr = `${measureAgg(measure)}(${quoteSqlIdentifier(measure.name)})`;
    if (timeDimension) {
      return {
        sql: [
          sourceCte,
          ', dql_trend AS (',
          `  SELECT ${quoteSqlIdentifier(timeDimension.name)} AS ${quoteSqlIdentifier(timeDimension.name)}, ${rankExpr} AS ${quoteSqlIdentifier(measure.name)}`,
          '  FROM dql_source',
          `  GROUP BY ${quoteSqlIdentifier(timeDimension.name)}`,
          '), dql_deltas AS (',
          `  SELECT ${quoteSqlIdentifier(timeDimension.name)}, ${quoteSqlIdentifier(measure.name)}, LAG(${quoteSqlIdentifier(measure.name)}) OVER (ORDER BY ${quoteSqlIdentifier(timeDimension.name)}) AS baseline_${safeAlias(measure.name)}`,
          '  FROM dql_trend',
          ')',
          `SELECT *, ${quoteSqlIdentifier(measure.name)} - baseline_${safeAlias(measure.name)} AS delta_${safeAlias(measure.name)}`,
          'FROM dql_deltas',
          `ORDER BY ABS(COALESCE(delta_${safeAlias(measure.name)}, 0)) DESC`,
          'LIMIT 20',
        ].join('\n'),
        sourceBlockPath: block.path,
        sourceBlockName: block.name,
      };
    }
  }

  if (!dimension) return undefined;
  const aggregate = `${measureAgg(measure)}(${quoteSqlIdentifier(measure.name)})`;
  const label = quoteSqlIdentifier(dimension.name);
  return {
    sql: [
      sourceCte,
      `SELECT ${label} AS ${label}, ${aggregate} AS ${quoteSqlIdentifier(measure.name)}, COUNT(*) AS ${quoteSqlIdentifier('row_count')}`,
      'FROM dql_source',
      `GROUP BY ${label}`,
      `ORDER BY ABS(COALESCE(${quoteSqlIdentifier(measure.name)}, 0)) DESC`,
      'LIMIT 20',
    ].join('\n'),
    sourceBlockPath: block.path,
    sourceBlockName: block.name,
  };
}

function resolveSelectedBlock(
  projectRoot: string,
  selected: Record<string, unknown> | null,
  sourceBlockId?: string,
): BlockCandidate | undefined {
  const selectedPath = selectedString(selected, 'blockPath');
  const candidates = collectBlockCandidates(projectRoot);
  if (selectedPath) {
    const normalizedPath = selectedPath.replace(/^\/+/, '');
    const found = candidates.find((block) => block.path === normalizedPath);
    if (found) return found;
    if (normalizedPath.startsWith('blocks/') && existsSync(join(projectRoot, normalizedPath))) {
      const source = readFileSync(join(projectRoot, normalizedPath), 'utf-8');
      const name = matchString(source, /block\s+"([^"]+)"/) ?? titleFromPath(normalizedPath);
      return {
        id: name,
        name,
        domain: matchString(source, /domain\s*=\s*"([^"]+)"/) ?? 'uncategorized',
        status: matchString(source, /status\s*=\s*"([^"]+)"/) ?? 'draft',
        owner: matchString(source, /owner\s*=\s*"([^"]+)"/),
        tags: matchArray(source, /tags\s*=\s*\[([^\]]*)\]/),
        path: normalizedPath,
        fingerprint: `sha256:${createHash('sha256').update(source).digest('hex')}`,
        lastModified: statSyncSafe(join(projectRoot, normalizedPath))?.mtime.toISOString() ?? new Date(0).toISOString(),
        description: matchString(source, /description\s*=\s*"((?:[^"\\]|\\.)*)"/) ?? '',
        llmContext: matchString(source, /llmContext\s*=\s*"((?:[^"\\]|\\.)*)"/),
        chartType: matchString(source, /chart\s*=\s*"([^"]+)"/) ?? undefined,
        filterIds: declaredAppFilterIds(source),
        dimensionIds: declaredAppDimensionIds(source),
        score: 0,
        reasons: [],
      };
    }
  }
  const id = cleanString(sourceBlockId) || selectedString(selected, 'blockId');
  if (!id) return undefined;
  return candidates.find((block) => block.id === id || block.name === id || block.path === id);
}

type ResultColumnProfile = {
  name: string;
  lower: string;
  numeric: boolean;
  text: boolean;
  dimension: boolean;
  measure: boolean;
  time: boolean;
};

function profileResultColumns(columns: string[], rows: Array<Record<string, unknown>>): ResultColumnProfile[] {
  return columns.map((name) => {
    const lower = name.toLowerCase();
    const numeric = rows.length === 0 ? !isLikelyTextColumn(lower) : rows.some((row) => typeofNumber(row[name]) !== null);
    const text = rows.some((row) => typeof row[name] === 'string' && String(row[name]).trim().length > 0);
    const time = /\b(season|year|month|week|quarter|date|day)\b/i.test(lower);
    const identifier = /\b(id|key|uuid|number)\b/i.test(lower) && !time;
    const measureName = /\b(total|sum|amount|revenue|sales|points?|goals?|assists?|rebounds?|count|avg|average|rate|pct|percent|score|value|delta|change|variance)\b/i.test(lower);
    const dimensionName = /\b(name|type|segment|region|market|category|status|player|customer|account|team|season|year|month|week|quarter|date)\b/i.test(lower);
    const measure = numeric && measureName && !identifier && !time;
    const dimension = !measure && (text || time || dimensionName || !numeric);
    return { name, lower, numeric, text, dimension, measure, time };
  });
}

function chooseMeasureColumn(columns: ResultColumnProfile[]): ResultColumnProfile | undefined {
  const candidates = columns.filter((column) => column.measure);
  return candidates.find((column) => /\b(delta|change|variance|contribution)\b/i.test(column.lower))
    ?? candidates.find((column) => /\b(total_points|total_revenue|total_amount|total|revenue|amount|sales|points|goals)\b/i.test(column.lower))
    ?? candidates.find((column) => /\b(count|value|score|avg|average|rate|pct|percent)\b/i.test(column.lower))
    ?? columns.find((column) => column.numeric && !column.dimension);
}

function chooseDimensionColumn(
  question: string,
  columns: ResultColumnProfile[],
  intent: LocalAppInvestigationIntent,
): ResultColumnProfile | undefined {
  const dimensions = columns.filter((column) => column.dimension);
  const questionTokens = new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const mentioned = dimensions.find((column) => column.lower.split(/[^a-z0-9]+/).some((token) => questionTokens.has(token)));
  if (mentioned) return mentioned;
  const timeDimension = chooseTimeDimension(columns);
  if ((intent === 'diagnose_change' || intent === 'segment_compare' || intent === 'anomaly_investigation') && timeDimension) return timeDimension;
  return dimensions.find((column) => column.text && !column.time)
    ?? timeDimension
    ?? dimensions[0];
}

function chooseTimeDimension(columns: ResultColumnProfile[]): ResultColumnProfile | undefined {
  return columns.find((column) => column.time);
}

function inferEntityFilter(
  question: string,
  columns: ResultColumnProfile[],
  rows: Array<Record<string, unknown>>,
): { column: string; value: string } | undefined {
  const textDimensions = columns.filter((column) => column.dimension && (column.text || /\b(name|player|customer|account|team)\b/i.test(column.lower)));
  const lowerQuestion = question.toLowerCase();
  for (const column of textDimensions) {
    for (const row of rows) {
      const value = cleanString(row[column.name]);
      if (value && lowerQuestion.includes(value.toLowerCase())) return { column: column.name, value };
    }
  }
  const named = question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/);
  const value = named?.[1]?.trim();
  const column = textDimensions[0];
  return value && column ? { column: column.name, value } : undefined;
}

function measureAgg(column: ResultColumnProfile): 'AVG' | 'SUM' {
  return /\b(avg|average|rate|pct|percent|per_)\b/i.test(column.lower) ? 'AVG' : 'SUM';
}

function extractDqlQuery(source: string): string | null {
  const tripleQuoteMatch = source.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  if (tripleQuoteMatch) return tripleQuoteMatch[1].trim() || null;
  const singleQuoteMatch = source.match(/query\s*=\s*"((?:[^"\\]|\\.)*)"/i);
  if (singleQuoteMatch) return singleQuoteMatch[1].replace(/\\"/g, '"').trim() || null;
  return null;
}

function stripTopLevelOrderAndLimit(sql: string): string {
  let next = sql.trim().replace(/;+\s*$/g, '');
  const limitIndex = findLastTopLevelKeyword(next, 'limit');
  if (limitIndex >= 0 && /^\s+limit\s+\d+\s*$/i.test(next.slice(limitIndex))) {
    next = next.slice(0, limitIndex).trim();
  }
  const orderIndex = findLastTopLevelKeyword(next, 'order by');
  if (orderIndex >= 0) next = next.slice(0, orderIndex).trim();
  return next;
}

function findLastTopLevelKeyword(sql: string, keyword: string): number {
  const lower = sql.toLowerCase();
  const target = keyword.toLowerCase();
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let last = -1;
  for (let i = 0; i < lower.length; i += 1) {
    const char = lower[i];
    if (quote) {
      if (char === quote && lower[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && lower.startsWith(target, i) && isKeywordBoundary(lower, i - 1) && isKeywordBoundary(lower, i + target.length)) {
      last = i;
    }
  }
  return last;
}

function isKeywordBoundary(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) return true;
  return /[^a-z0-9_]/i.test(value[index]);
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function safeAlias(identifier: string): string {
  return identifier.replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '') || 'value';
}

function isLikelyTextColumn(value: string): boolean {
  return /\b(name|type|segment|region|market|category|status|player|customer|account|team)\b/i.test(value);
}

async function generateInvestigationSql(
  ctx: Ctx,
  input: AppInvestigationGenerationRequest,
): Promise<AppInvestigationGenerationResult | undefined> {
  if (!ctx.generateInvestigationSql) return undefined;
  try {
    const timeoutMs = appResearchAiTimeoutMs();
    const result = await boundedPromise(ctx.generateInvestigationSql(input), timeoutMs);
    if (result.timedOut) {
      return {
        executionError: `AI SQL generation timed out after ${Math.round(timeoutMs / 1000)}s. ZLens continued with deterministic app evidence and kept the analysis review-required.`,
      };
    }
    return result.value;
  } catch (err) {
    return {
      executionError: err instanceof Error ? err.message : String(err),
    };
  }
}

function shouldRequestProviderMemo(input: {
  ctx: Ctx;
  generatedSql?: string;
  agentGeneration?: AppInvestigationGenerationResult;
  hasReportEvidence: boolean;
}): boolean {
  if (!input.ctx.generateInvestigationSql) return false;
  if (cleanString(input.agentGeneration?.answer)) return false;
  return input.hasReportEvidence || Boolean(cleanString(input.generatedSql));
}

async function runGeneratedSqlPreview(
  ctx: Ctx,
  generatedSql?: string,
): Promise<{ preview?: Record<string, unknown>; error?: string; fatal?: boolean }> {
  const sql = cleanString(generatedSql);
  if (!sql) return {};
  const unresolved = unresolvedSqlTemplateParams(sql);
  if (unresolved.length > 0) {
    return {
      error: `Generated SQL was not run because unresolved DQL parameters remain: ${unresolved.join(', ')}.`,
      fatal: false,
    };
  }
  if (!isReadOnlySql(sql)) {
    return {
      error: 'Generated SQL was not run because it was not a read-only SELECT or WITH query.',
      fatal: true,
    };
  }
  if (!ctx.executeSql) {
    return {
      error: 'This host cannot execute investigation SQL.',
      fatal: false,
    };
  }
  try {
    const timeoutMs = appResearchPreviewTimeoutMs();
    const result = await boundedPromise(
      ctx.executeSql(boundedPreviewSql(sql)),
      timeoutMs,
    );
    if (result.timedOut) {
      return {
        error: `Generated SQL preview timed out after ${Math.round(timeoutMs / 1000)}s. The analysis was created from selected app evidence; review or simplify the SQL before promotion.`,
        fatal: false,
      };
    }
    return {
      preview: {
        id: 'generated-sql-preview',
        title: 'Generated SQL preview',
        kind: 'table',
        reviewRequired: true,
        result: result.value,
      },
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      fatal: true,
    };
  }
}

async function boundedPromise<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function appResearchPreviewTimeoutMs(): number {
  const raw = Number(readEnv('ZLENS_APP_RESEARCH_PREVIEW_TIMEOUT_MS'));
  if (Number.isFinite(raw) && raw >= 500) return Math.min(raw, 120000);
  return 12000;
}

function appResearchAiTimeoutMs(): number {
  const raw = Number(readEnv('ZLENS_APP_RESEARCH_AI_TIMEOUT_MS'));
  if (Number.isFinite(raw) && raw >= 500) return Math.min(raw, 120000);
  return 12000;
}

function buildGeneratedSqlPreview(result: unknown, generatedSql?: string): Record<string, unknown> {
  const record = asRecord(result);
  const rawRows = Array.isArray(record?.rows) ? record.rows : [];
  const rows = rawRows.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row)).slice(0, 100);
  const rawColumns = Array.isArray(record?.columns) ? record.columns : [];
  const columns = rawColumns.length
    ? rawColumns.map((column) => {
        const columnRecord = asRecord(column);
        return typeof column === 'string'
          ? column
          : typeof columnRecord?.name === 'string'
            ? columnRecord.name
            : String(column);
      })
    : Object.keys(rows[0] ?? {});
  return {
    id: 'generated-sql-preview',
    title: 'Generated SQL preview',
    kind: 'table',
    reviewRequired: true,
    sql: generatedSql,
    result: {
      columns,
      rows,
      rowCount: typeof record?.rowCount === 'number' ? record.rowCount : rows.length,
      executionTime: typeof record?.executionTime === 'number' ? record.executionTime : undefined,
    },
  };
}

type SqlPreviewErrorKind = 'runtime_unavailable' | 'ai_generation_timeout' | 'timeout' | 'sql_repair' | 'safety' | 'unknown';

function classifySqlPreviewError(error?: string): SqlPreviewErrorKind | undefined {
  const value = cleanString(error);
  if (!value) return undefined;
  if (/\bAI SQL generation timed out\b/i.test(value)) return 'ai_generation_timeout';
  if (/\b(warehouse|suspended|resume|authenticat|permission|privilege|network|connection|connect|host cannot execute|cannot execute|not configured)\b/i.test(value)) {
    return 'runtime_unavailable';
  }
  if (/\b(timed out|timeout)\b/i.test(value)) return 'timeout';
  if (/\b(not a read-only|not read-only|insert|update|delete|drop|alter|create|merge|truncate|grant|revoke)\b/i.test(value)) {
    return 'safety';
  }
  if (/\b(unresolved|parameter|invalid identifier|syntax|compilation|parse|unknown column|does not exist|ambiguous|not found)\b/i.test(value)) {
    return 'sql_repair';
  }
  return 'unknown';
}

function shouldSurfaceSqlPreviewIssue(input: {
  sqlError?: string;
  sqlErrorKind?: SqlPreviewErrorKind;
  generatedSql?: string;
  hasReportEvidence: boolean;
}): boolean {
  const error = cleanString(input.sqlError);
  if (!error) return false;
  if (
    input.hasReportEvidence &&
    !cleanString(input.generatedSql) &&
    (input.sqlErrorKind === 'unknown' || /\bAI provider did not return a governed answer\b/i.test(error))
  ) {
    return false;
  }
  return true;
}

function isReadOnlySql(sql: string): boolean {
  const trimmed = stripLeadingSqlComments(sql).replace(/;+\s*$/g, '');
  if (!/^(select|with)\b/i.test(trimmed)) return false;
  if (/;\s*\S/.test(trimmed)) return false;
  return !/\b(insert|update|delete|merge|drop|alter|create|truncate|copy|grant|revoke|call|execute|attach|detach)\b/i.test(trimmed);
}

function stripLeadingSqlComments(sql: string): string {
  let next = sql.trim();
  while (next.startsWith('--') || next.startsWith('/*')) {
    if (next.startsWith('--')) {
      const lineEnd = next.indexOf('\n');
      next = lineEnd >= 0 ? next.slice(lineEnd + 1).trimStart() : '';
      continue;
    }
    const blockEnd = next.indexOf('*/');
    next = blockEnd >= 0 ? next.slice(blockEnd + 2).trimStart() : '';
  }
  return next;
}

function boundedPreviewSql(sql: string): string {
  return `SELECT * FROM (${sql.trim().replace(/;+\s*$/g, '')}) AS dql_research_preview LIMIT 100`;
}

function buildInvestigationTrust(
  investigation: LocalAppInvestigation,
  selected: Record<string, unknown> | null,
  sqlError?: string,
): Record<string, unknown> {
  return {
    label: 'AI-generated analysis',
    uncertified: true,
    reviewStatus: 'needs_review',
    certifiedContext: selectedString(selected, 'certificationStatus') === 'certified' ? 'selected tile is certified' : 'selected tile certification needs review',
    sourceBlockId: investigation.sourceBlockId ?? selectedString(selected, 'blockId'),
    sourceTileId: investigation.sourceTileId ?? selectedString(selected, 'tileId'),
    caveats: [
      'Analysis output is not certified until a reviewer promotes or certifies the generated saved query.',
      ...(sqlError ? [`SQL preview caveat: ${sqlError}`] : []),
    ],
  };
}

function investigationSteps(intent: LocalAppInvestigationIntent): string[] {
  const common = ['trust check', 'proof capture'];
  if (intent === 'trust_gap_review') return ['certification review', 'lineage review', 'owner and caveat check', ...common];
  if (intent === 'entity_drilldown') return ['entity value match', 'metric trend', 'exception rows', ...common];
  if (intent === 'segment_compare') return ['segment grouping', 'baseline comparison', 'top movers', ...common];
  if (intent === 'anomaly_investigation') return ['baseline comparison', 'trend check', 'exception rows', 'top movers', ...common];
  if (intent === 'diagnose_change') return ['baseline comparison', 'trend check', 'top movers', 'segment contribution', ...common];
  return ['top movers', 'segment contribution', 'exception rows', ...common];
}

function investigationAssumptions(
  intent: LocalAppInvestigationIntent,
  selected: Record<string, unknown> | null,
  generatedSql?: string,
  sqlError?: string,
): string[] {
  return [
    `Intent classified as ${intent}.`,
    selected ? 'The selected dashboard tile is the starting context.' : 'No selected tile context was provided.',
    generatedSql ? 'A generated SQL preview was requested and bounded to 100 rows.' : 'No generated SQL was supplied, so the first pass used dashboard result samples and metadata.',
    sqlError ? `SQL preview needs review: ${sqlError}` : 'The result remains uncertified until reviewed.',
  ];
}

function buildInvestigationSummary(
  intent: LocalAppInvestigationIntent,
  question: string,
  selected: Record<string, unknown> | null,
  metrics: Record<string, unknown>,
  drivers: Array<Record<string, unknown>>,
): string {
  const target = selectedString(selected, 'title') ?? 'this dashboard question';
  const cleanQuestion = cleanInvestigationQuestion(question);
  const metricName = cleanString(metrics.metric) || 'selected metric';
  const currentValue = typeofNumber(metrics.currentValue);
  const baselineValue = typeofNumber(metrics.baselineValue);
  const deltaValue = typeofNumber(metrics.delta);
  const currentDetail = cleanString(metrics.currentDetail);
  const baselineDetail = cleanString(metrics.baselineDetail);
  const currentLabel = currentDetail ? currentDetail.replace(/\s*\/\s*[^/]+$/, '') : cleanString(metrics.currentLabel) || 'Current result';
  const baselineLabel = baselineDetail ? baselineDetail.replace(/\s*\/\s*[^/]+$/, '') : cleanString(metrics.baselineLabel) || 'comparison';
  const valueSentence = currentValue !== null
    ? `${currentLabel} leads on ${metricName} with ${formatMetricValue(currentValue)}${baselineValue !== null ? ` versus ${formatMetricValue(baselineValue)} for ${baselineLabel}` : ''}${deltaValue !== null ? `, a gap of ${formatMetricValue(deltaValue)}` : ''}.`
    : '';
  if (intent === 'trust_gap_review') {
    return `This tile can be used as certified context only where its source saved query and lineage are certified. ${valueSentence || 'The deeper answer is AI-generated analysis and needs review before leaders rely on it.'}`;
  }
  const driverTitle = cleanString(drivers[0]?.title);
  const driver = driverTitle && driverTitle !== currentLabel
    ? ` ${driverTitle} is the strongest visible driver in the bounded preview.`
    : '';
  const reviewBoundary = ' This remains review-required until SQL, grain, filters, and lineage are confirmed.';
  if (valueSentence) {
    return `${valueSentence}${driver}${reviewBoundary}`.trim();
  }
  const fallbackSubject = cleanQuestion || target;
  return `This analysis investigates ${fallbackSubject}. The preview is bounded to the selected app context and needs analyst review before it becomes governed business logic.`;
}

function cleanInvestigationQuestion(value: string): string {
  return cleanString(value)
    .replace(/^\/(ask|research|report|analy[sz]e|analysis|proof|evidence|validate|verify|add\s+block|create\s+block|draft\s+block|block)\b/i, '')
    .replace(/^(Analysis goal|Analysis question|Research question|Evidence question|Validation question|Reusable block goal|Business question|Question):\s*/i, '')
    .replace(/\bCurrent app filters:\s*[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[.?!]+$/, '')
    .trim();
}

function buildMissingBaselineSummary(
  question: string,
  selected: Record<string, unknown> | null,
): string {
  const target = selectedString(selected, 'title') ?? 'the selected tile';
  return `ZLens opened review-required analysis for ${target}: ${question}. The selected tile shows the current certified result, but its sample does not include a comparable prior period or historical snapshot, so ZLens cannot calculate what changed without guessing.`;
}

function buildMissingBaselineRecommendation(selected: Record<string, unknown> | null): string {
  const target = selectedString(selected, 'title') ?? 'this tile';
  return `Use ${target} as current-state evidence. To explain change, add or select a saved query with a time grain, snapshot date, or prior-period baseline, then rerun the analysis.`;
}

function buildInvestigationRecommendation(
  intent: LocalAppInvestigationIntent,
  selected: Record<string, unknown> | null,
  sqlError?: string,
  sqlErrorKind?: SqlPreviewErrorKind,
): string {
  if (sqlErrorKind === 'runtime_unavailable') return 'Resume or choose an active warehouse, then refresh the analysis. Keep the generated SQL review-required until a preview runs successfully.';
  if (sqlErrorKind === 'ai_generation_timeout') return 'Use the certified app result as the current answer, then retry AI SQL generation or draft the scoped SQL manually before promotion.';
  if (sqlErrorKind === 'timeout') return 'Simplify the generated SQL or narrow the app filters, then refresh the bounded preview before promotion.';
  if (sqlErrorKind === 'safety') return 'Rewrite the SQL as a read-only SELECT/WITH query before any preview or promotion.';
  if (sqlError) return 'Review the generated SQL or add a certified drilldown saved query before promoting this result.';
  if (intent === 'trust_gap_review') return 'Use the certified tile for stakeholder reporting, and promote only the reviewed gaps into a draft saved query.';
  if (!selected) return 'Select a dashboard tile or provide SQL so ZLens can rank drivers with stronger evidence.';
  return 'Review the driver evidence, then pin the useful answer or promote the SQL path into a draft saved query.';
}

function buildInvestigationReportSections(input: {
  intent: LocalAppInvestigationIntent;
  question: string;
  context: unknown;
  selected: Record<string, unknown> | null;
  metrics: Record<string, unknown>;
  drivers: Array<Record<string, unknown>>;
  summary: string;
  recommendation: string;
  agentAnswer?: string;
  hasReportEvidence?: boolean;
  sqlError?: string;
  sqlErrorKind?: SqlPreviewErrorKind;
  baselineGap?: boolean;
}): LocalAppInvestigationReportSection[] {
  const actionMode = cleanString(asRecord(input.context)?.actionMode);
  const sourceName = selectedString(input.selected, 'title') ?? selectedString(input.selected, 'blockId') ?? 'selected app result';
  const topNumber = reportMetricBullet(input.metrics, 'current');
  const comparison = reportMetricBullet(input.metrics, 'baseline');
  const delta = reportMetricBullet(input.metrics, 'delta');
  const keyBullets = [topNumber, comparison, delta].filter((item): item is string => Boolean(item));
  const driver = cleanString(input.drivers[0]?.title);
  const driverValue = cleanString(input.drivers[0]?.contribution ?? input.drivers[0]?.value ?? input.drivers[0]?.metric);
  const nextDriver = cleanString(input.drivers[1]?.title);
  const interpretation = reportInterpretationForIntent({
    intent: input.intent,
    actionMode,
    sourceName,
    driver,
    driverValue,
    nextDriver,
    baselineGap: input.baselineGap,
  });
  const interpretationMeta = reportInterpretationMeta(input.intent, actionMode);
  const providerSections = extractProviderReportSections(input.agentAnswer);
  if (providerSections.length >= 2) {
    const sections = [...providerSections];
    if (keyBullets.length > 0 && !hasReportSection(sections, /\b(number|metric|kpi|value)\b/i)) {
      sections.push({
        id: 'key-numbers',
        kind: 'key_numbers',
        title: keyNumbersTitleForIntent(input.intent),
        body: keyNumbersBodyForIntent(input.intent),
        tone: 'insight',
        bullets: keyBullets,
        evidenceRefs: reportEvidenceRefs(input.selected),
      });
    }
    if (input.baselineGap && !hasReportSection(sections, /\b(missing|baseline|comparison)\b/i)) {
      sections.push({
        id: 'missing-comparison',
        kind: 'custom',
        title: 'Missing comparison',
        body: 'The selected dashboard sample does not contain a second comparable period or baseline. DQL preserved the current certified result and stopped short of inventing a change explanation from unrelated data.',
        tone: 'warning',
        evidenceRefs: reportEvidenceRefs(input.selected),
      });
    }
    const previewIssue = input.hasReportEvidence && input.sqlErrorKind === 'runtime_unavailable'
      ? undefined
      : reportPreviewIssue(input.sqlError, input.sqlErrorKind);
    if (previewIssue && !hasReportSection(sections, /\b(sql|preview|repair|warehouse|runtime)\b/i)) {
      sections.push({
        id: previewIssue.id,
        kind: 'custom',
        title: previewIssue.title,
        body: previewIssue.body,
        tone: previewIssue.tone,
      });
    }
    if (!hasReportSection(sections, /\b(next|recommend|action)\b/i)) {
      sections.push({
        id: 'recommended-next-step',
        kind: 'recommended_next_step',
        title: 'Recommended next step',
        body: input.recommendation,
        tone: input.sqlError ? 'warning' : 'neutral',
      });
    }
    if (!hasReportSection(sections, /\b(review boundary|review-required|governed boundary|trust boundary)\b/i)) {
      sections.push({
        id: 'review-boundary',
        kind: 'review_boundary',
        title: 'Review boundary',
        body: 'This analysis is AI-generated and review-required. Use it to guide decisions, then validate SQL, grain, filters, joins, and source proof before pinning it to the app or turning it into a reusable saved query.',
        tone: 'review',
      });
    }
    return sections.filter((section) => cleanString(section.body));
  }
  const sections: LocalAppInvestigationReportSection[] = [
    {
      id: 'executive-answer',
      kind: 'executive_answer',
      title: 'Executive answer',
      body: input.summary,
      tone: 'answer',
      evidenceRefs: reportEvidenceRefs(input.selected),
    },
    {
      id: interpretationMeta.id,
      kind: interpretationMeta.kind,
      title: interpretationMeta.title,
      body: interpretation,
      tone: interpretationMeta.tone,
      evidenceRefs: reportEvidenceRefs(input.selected),
    },
  ];

  if (keyBullets.length > 0) {
    sections.push({
      id: 'key-numbers',
      kind: 'key_numbers',
      title: keyNumbersTitleForIntent(input.intent),
      body: keyNumbersBodyForIntent(input.intent),
      tone: 'insight',
      bullets: keyBullets,
      evidenceRefs: reportEvidenceRefs(input.selected),
    });
  }

  if (input.baselineGap) {
    sections.push({
      id: 'missing-comparison',
      kind: 'custom',
      title: 'Missing comparison',
      body: 'The selected dashboard sample does not contain a second comparable period or baseline. DQL preserved the current certified result and stopped short of inventing a change explanation from unrelated data.',
      tone: 'warning',
      evidenceRefs: reportEvidenceRefs(input.selected),
    });
  }

  const previewIssue = input.hasReportEvidence && input.sqlErrorKind === 'runtime_unavailable'
    ? undefined
    : reportPreviewIssue(input.sqlError, input.sqlErrorKind);
  if (previewIssue) {
    sections.push({
      id: previewIssue.id,
      kind: 'custom',
      title: previewIssue.title,
      body: previewIssue.body,
      tone: previewIssue.tone,
    });
  }

  sections.push(
    {
      id: 'recommended-next-step',
      kind: 'recommended_next_step',
      title: 'Recommended next step',
      body: input.recommendation,
      tone: input.sqlError ? 'warning' : 'neutral',
    },
    {
      id: 'review-boundary',
      kind: 'review_boundary',
      title: 'Review boundary',
      body: 'This analysis is AI-generated and review-required. Use it to guide decisions, then validate SQL, grain, filters, joins, and source proof before pinning it to the app or turning it into a reusable saved query.',
      tone: 'review',
    },
  );

  return sections.filter((section) => cleanString(section.body));
}

function extractProviderReportSections(answer?: string): LocalAppInvestigationReportSection[] {
  const raw = cleanString(answer);
  if (!raw) return [];
  const text = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*(SQL|Query)\s*:.*$/gim, '')
    .trim();
  const matches = Array.from(text.matchAll(/^#{2,4}\s+(.+)$/gm));
  if (matches.length < 2) return [];
  const sections: LocalAppInvestigationReportSection[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const title = cleanProviderReportTitle(match[1]);
    const next = matches[index + 1];
    const bodyText = text.slice((match.index ?? 0) + match[0].length, next?.index ?? text.length).trim();
    if (!title || !bodyText || isTraceOnlyProviderSection(title)) continue;
    const id = slugify(title) || `section-${index + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const parsed = parseProviderSectionBody(bodyText);
    if (!parsed.body) continue;
    sections.push({
      id,
      kind: providerReportKind(title),
      title,
      body: parsed.body,
      bullets: parsed.bullets,
      tone: providerReportTone(title),
    });
  }
  return sections.slice(0, 8);
}

function cleanProviderReportTitle(value: string): string {
  return cleanString(value)
    .replace(/\*\*/g, '')
    .replace(/[:：]\s*$/, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim()
    .slice(0, 90);
}

function isTraceOnlyProviderSection(title: string): boolean {
  return /\b(sql|query|raw trace|appendix|implementation detail)\b/i.test(title);
}

function parseProviderSectionBody(value: string): { body: string; bullets?: string[] } {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+/.test(line));
  const bullets: string[] = [];
  const prose: string[] = [];
  for (const line of lines) {
    const bullet = /^[-*]\s+(.+)$/.exec(line)?.[1]?.trim();
    if (bullet) {
      bullets.push(bullet);
      continue;
    }
    prose.push(line);
  }
  const body = prose.join('\n\n') || bullets.slice(0, 3).join(' ');
  return {
    body: cleanString(body),
    bullets: bullets.length ? bullets.slice(0, 8) : undefined,
  };
}

function providerReportKind(title: string): LocalAppInvestigationReportSection['kind'] {
  if (/\b(executive|answer|summary|decision)\b/i.test(title)) return 'executive_answer';
  if (/\b(number|metric|kpi|value)\b/i.test(title)) return 'key_numbers';
  if (/\b(driver|why|interpret|segment|movement|trend|entity|anomaly)\b/i.test(title)) return 'business_interpretation';
  if (/\b(proof|validate|evidence|trust)\b/i.test(title)) return 'validation';
  if (/\b(block|logic|reuse|contract)\b/i.test(title)) return 'reusable_logic';
  if (/\b(next|recommend|action)\b/i.test(title)) return 'recommended_next_step';
  if (/\b(caveat|review|boundary|risk|assumption)\b/i.test(title)) return 'review_boundary';
  return 'custom';
}

function providerReportTone(title: string): LocalAppInvestigationReportSection['tone'] {
  if (/\b(executive|answer|summary|decision)\b/i.test(title)) return 'answer';
  if (/\b(driver|why|interpret|segment|movement|trend|number|metric|kpi|value)\b/i.test(title)) return 'insight';
  if (/\b(caveat|warning|risk|missing|error|unavailable|anomaly)\b/i.test(title)) return 'warning';
  if (/\b(proof|validate|evidence|trust|review|boundary|block|logic|reuse)\b/i.test(title)) return 'review';
  return 'neutral';
}

function hasReportSection(
  sections: LocalAppInvestigationReportSection[],
  pattern: RegExp,
): boolean {
  return sections.some((section) => pattern.test(section.title) || pattern.test(section.kind));
}

function reportPreviewIssue(
  sqlError?: string,
  sqlErrorKind?: SqlPreviewErrorKind,
): Pick<LocalAppInvestigationReportSection, 'id' | 'title' | 'body' | 'tone'> | undefined {
  if (!sqlError) return undefined;
  if (sqlErrorKind === 'runtime_unavailable') {
    return {
      id: 'preview-unavailable',
      title: 'Preview unavailable',
      body: 'The generated SQL was not proven because the warehouse or execution runtime is unavailable. Resume or choose an active warehouse, then refresh the analysis. Do not edit business logic just to fix an infrastructure issue.',
      tone: 'warning',
    };
  }
  if (sqlErrorKind === 'ai_generation_timeout') {
    return {
      id: 'ai-generation-timeout',
      title: 'AI SQL generation timed out',
      body: 'ZLens did not receive generated SQL inside the bounded AI window. The memo uses certified app evidence only; retry AI generation, provide reviewed SQL, or draft reusable logic manually before promoting this analysis.',
      tone: 'warning',
    };
  }
  if (sqlErrorKind === 'timeout') {
    return {
      id: 'preview-timeout',
      title: 'Preview timed out',
      body: 'The generated SQL did not finish inside the bounded preview window. Narrow the filters, simplify the SQL, or rerun when the warehouse is responsive before promoting this analysis.',
      tone: 'warning',
    };
  }
  if (sqlErrorKind === 'safety') {
    return {
      id: 'sql-safety-check',
      title: 'SQL safety check',
      body: 'DQL blocked the preview because the SQL was not a read-only SELECT/WITH statement. Rewrite it as safe analytical SQL before running, pinning, or promoting.',
      tone: 'warning',
    };
  }
  return {
    id: 'sql-repair-path',
    title: 'SQL repair path',
    body: 'The generated SQL preview needs review before this analysis can be promoted. Open the trace appendix, edit the SQL against the selected saved query context, rerun the preview, then pin or draft reusable logic only after the row sample matches the business question.',
    tone: 'warning',
  };
}

function reportInterpretationMeta(
  intent: LocalAppInvestigationIntent,
  actionMode?: string,
): Pick<LocalAppInvestigationReportSection, 'id' | 'kind' | 'title' | 'tone'> {
  if (actionMode === 'block') {
    return { id: 'reusable-logic', kind: 'reusable_logic', title: 'Reusable logic decision', tone: 'review' };
  }
  if (actionMode === 'evidence' || intent === 'trust_gap_review') {
    return { id: 'validation-result', kind: 'validation', title: 'Validation result', tone: 'review' };
  }
  if (intent === 'diagnose_change') {
    return { id: 'change-explanation', kind: 'business_interpretation', title: 'Change explanation', tone: 'insight' };
  }
  if (intent === 'segment_compare') {
    return { id: 'segment-readout', kind: 'business_interpretation', title: 'Segment readout', tone: 'insight' };
  }
  if (intent === 'entity_drilldown') {
    return { id: 'entity-drilldown', kind: 'business_interpretation', title: 'Entity drilldown', tone: 'insight' };
  }
  if (intent === 'anomaly_investigation') {
    return { id: 'anomaly-readout', kind: 'business_interpretation', title: 'Anomaly readout', tone: 'warning' };
  }
  return { id: 'driver-readout', kind: 'business_interpretation', title: 'Driver readout', tone: 'insight' };
}

function reportInterpretationForIntent(input: {
  intent: LocalAppInvestigationIntent;
  actionMode?: string;
  sourceName: string;
  driver?: string;
  driverValue?: string;
  nextDriver?: string;
  baselineGap?: boolean;
}): string {
  if (input.baselineGap) {
    return 'This is a current-state answer, not a completed change explanation. The analysis has enough proof to show the selected result, but it does not have a comparable prior period or baseline needed to explain movement responsibly.';
  }
  if (input.actionMode === 'block') {
    return 'This is a reusable-logic candidate. Preserve the business question, parameters, allowed filters, output grain, source proof, and review path before certification.';
  }
  if (input.actionMode === 'evidence' || input.intent === 'trust_gap_review') {
    return `This validation is bounded to ${input.sourceName}. Treat the claim as trusted only after source saved query, lineage, filters, and preview rows are reviewed.`;
  }
  if (input.driver) {
    const driverSentence = `${input.driver} is the strongest visible driver${input.driverValue ? ` (${input.driverValue})` : ''}.`;
    const comparisonSentence = input.nextDriver ? ` The next visible comparison is ${input.nextDriver}.` : '';
    const reviewSentence = ' Treat the interpretation as directional until a reviewer confirms SQL, grain, filters, joins, and lineage.';
    if (input.intent === 'segment_compare') return `${driverSentence}${comparisonSentence} Use this as a segment readout only after confirming the grouping field and filter bindings.${reviewSentence}`;
    if (input.intent === 'entity_drilldown') return `${driverSentence}${comparisonSentence} Use this as an entity drilldown only after confirming the entity identifier and output grain.${reviewSentence}`;
    if (input.intent === 'anomaly_investigation') return `${driverSentence}${comparisonSentence} Review the baseline, outlier rows, and time grain before treating this as an anomaly narrative.${reviewSentence}`;
    if (input.intent === 'diagnose_change') return `${driverSentence}${comparisonSentence} Confirm a comparable baseline or prior period before treating this as a causal change explanation.${reviewSentence}`;
    return `${driverSentence}${comparisonSentence}${reviewSentence}`;
  }
  if (input.intent === 'diagnose_change') {
    return 'The analysis does not yet have a comparable baseline or ranked drivers. Add a time grain, prior-period saved query, or segment field before treating the change explanation as complete.';
  }
  if (input.intent === 'segment_compare') {
    return 'The analysis does not yet have a clear segment grouping. Add a segment field or certified breakdown saved query before using this as a stakeholder segment comparison.';
  }
  if (input.intent === 'entity_drilldown') {
    return 'The analysis does not yet have a stable entity identifier. Add the entity key and output grain before using this as a stakeholder drilldown.';
  }
  return 'The analysis does not yet have ranked drivers. Add a clearer metric, time grain, or segment field before treating it as complete.';
}

function keyNumbersTitleForIntent(intent: LocalAppInvestigationIntent): string {
  if (intent === 'diagnose_change') return 'Movement numbers';
  if (intent === 'segment_compare') return 'Segment numbers';
  if (intent === 'entity_drilldown') return 'Entity numbers';
  if (intent === 'anomaly_investigation') return 'Anomaly numbers';
  if (intent === 'trust_gap_review') return 'Validation numbers';
  return 'Key numbers';
}

function keyNumbersBodyForIntent(intent: LocalAppInvestigationIntent): string {
  if (intent === 'diagnose_change') return 'The bounded preview includes the values ZLens can prove for this movement question. Use them for stakeholder framing, but validate the baseline and time grain before promotion.';
  if (intent === 'segment_compare') return 'The bounded preview includes the segment values ZLens can compare from the selected context. Confirm the grouping field and filters before promotion.';
  if (intent === 'entity_drilldown') return 'The bounded preview includes entity-level values from the selected context. Confirm the entity key and grain before promotion.';
  if (intent === 'anomaly_investigation') return 'The bounded preview includes values that may explain the exception. Confirm the baseline, threshold, and time grain before promotion.';
  if (intent === 'trust_gap_review') return 'The bounded preview includes values available for validation. Confirm source proof, lineage, and owner review before promotion.';
  return 'The bounded preview includes the following decision-relevant values. These are useful for stakeholder framing but still require source validation before promotion.';
}

function investigationNarrativeAnswer(investigation: LocalAppInvestigation): string {
  const sections = Array.isArray(investigation.reportSections)
    ? investigation.reportSections
      .filter((section) => cleanString(section?.title) && cleanString(section?.body))
      .slice(0, 8)
    : [];
  if (!sections.length) {
    return cleanString(investigation.summary)
      || cleanString(investigation.recommendation)
      || cleanString(investigation.title)
      || 'Review-required app analysis.';
  }

  const stakeholderSections = sections
    .filter((section) => {
      if (section.kind === 'review_boundary') return false;
      return !/\b(sql|query|appendix|technical|repair|preview error)\b/i.test(section.title);
    })
    .slice(0, 5);

  return (stakeholderSections.length ? stakeholderSections : sections.slice(0, 3)).map((section) => {
    const bullets = Array.isArray(section.bullets) && section.bullets.length
      ? `\n${section.bullets.filter(Boolean).slice(0, 8).map((bullet) => `- ${bullet}`).join('\n')}`
      : '';
    return `## ${section.title.trim()}\n${section.body.trim()}${bullets}`;
  }).join('\n\n');
}

function reportMetricBullet(metrics: Record<string, unknown>, role: 'current' | 'baseline' | 'delta'): string | undefined {
  const prefix = role === 'current' ? 'current' : role === 'baseline' ? 'baseline' : 'delta';
  const label = cleanString(metrics[`${prefix}Label`])
    || (role === 'current' ? 'Top value' : role === 'baseline' ? 'Next comparison' : 'Gap');
  const value = typeofNumber(metrics[role === 'current' ? 'currentValue' : role === 'baseline' ? 'baselineValue' : 'delta']);
  if (value === null) return undefined;
  const detail = cleanString(metrics[`${prefix}Detail`]);
  return `${label}: ${formatMetricValue(value)}${detail ? ` (${detail})` : ''}`;
}

function reportEvidenceRefs(selected: Record<string, unknown> | null): string[] {
  return [
    selectedString(selected, 'blockId') ? `block:${selectedString(selected, 'blockId')}` : '',
    selectedString(selected, 'tileId') ? `tile:${selectedString(selected, 'tileId')}` : '',
    selectedString(selected, 'blockPath') ?? '',
  ].filter(Boolean);
}

function investigationPreviewResult(investigation: LocalAppInvestigation): unknown {
  const previews = Array.isArray(investigation.resultPreviews) ? investigation.resultPreviews : [];
  const first = previews.find((preview) => asRecord(preview)?.result);
  return asRecord(first)?.result;
}

function investigationCitations(investigation: LocalAppInvestigation): unknown[] {
  return [{
    kind: 'app_investigation',
    name: investigation.title,
    reviewStatus: investigation.reviewStatus,
    uncertified: true,
    sourceBlockId: investigation.sourceBlockId,
    sourceTileId: investigation.sourceTileId,
  }];
}

function nextResearchFollowUps(investigation: LocalAppInvestigation): string[] {
  const target = investigation.sourceBlockId ?? investigation.sourceTileId ?? 'this result';
  return [
    `Break ${target} down by the strongest segment`,
    `Show exception rows for ${target}`,
    `What would need review before certifying this answer?`,
  ];
}

function titleFromInvestigation(question: string, selected: Record<string, unknown> | null): string {
  const selectedTitle = selectedString(selected, 'title');
  const base = selectedTitle ? `${selectedTitle}: ${question}` : question;
  return base.replace(/\s+/g, ' ').slice(0, 90);
}

function selectedRows(selected: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const rows = Array.isArray(selected?.sampleRows)
    ? selected?.sampleRows
    : Array.isArray(selected?.resultSample)
      ? selected?.resultSample
      : selected?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map(asRecord).filter((row): row is Record<string, unknown> => Boolean(row)).slice(0, 100);
}

function selectedColumns(selected: Record<string, unknown> | null, rows: Array<Record<string, unknown>>): string[] {
  const columns = selected?.columns;
  if (Array.isArray(columns) && columns.length > 0) {
    return columns.map(String).filter(Boolean).slice(0, 20);
  }
  return Object.keys(rows[0] ?? {}).slice(0, 20);
}

function typeofNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function formatContribution(value: number): string {
  const rounded = Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : Number(value.toFixed(2)).toLocaleString();
  return value >= 0 ? `+${rounded}` : `-${rounded.replace(/^-/, '')}`;
}

function formatMetricValue(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 100) return Math.round(value).toLocaleString();
  return Number(value.toFixed(2)).toLocaleString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function appAiBuildSessionId(requested?: string): string {
  const clean = cleanString(requested);
  if (clean) {
    if (!/^app_build_[a-z0-9_:-]+$/i.test(clean)) throw new Error('Invalid App build session id.');
    return clean;
  }
  return `app_build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => cleanString(item))
    .filter(Boolean)
    .slice(0, 24);
  return items.length > 0 ? items : undefined;
}

function normalizeTags(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => cleanString(value)).filter(Boolean)));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueAppPageId(base: string, existingIds: Set<string>): string {
  if (!existingIds.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * API-009: bind an existing-App proposal to every Git-owned byte in the package. This is
 * deliberately stricter than the metadata snapshot: page, notebook, draft, and
 * App-document edits all invalidate approval before the atomic directory swap.
 */
/**
 * Fingerprint the parts of an App package a write can actually conflict with:
 * the manifest and the dashboard documents.
 *
 * Hashing every byte under the App directory made the guard far too sensitive —
 * a notebook run output, a README edit, or an attached notebook would
 * invalidate a page proposal that could not possibly conflict with them, and
 * the commit failed with an unexplained 409.
 */
function fingerprintAppDirectory(appDir: string): string {
  const files: Array<{ path: string; symbolicLink: boolean }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        // Only `dashboards/` participates; notebooks, drafts and generated prose do not.
        if (directory === appDir && entry.name !== 'dashboards') continue;
        visit(absolutePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (directory === appDir && entry.name !== 'dql.app.json') continue;
        files.push({ path: absolutePath, symbolicLink: entry.isSymbolicLink() });
      }
    }
  };
  visit(appDir);
  const hash = createHash('sha256');
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(relative(appDir, file.path));
    hash.update('\0');
    hash.update(file.symbolicLink ? `link:${readlinkSync(file.path)}` : readFileSync(file.path));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function resolveAppPackageDir(projectRoot: string, id: string): string {
  return join(projectRoot, 'apps', id);
}

function titleFromPath(path: string): string {
  return basename(path)
    .replace(/\.(dqlnb|dql)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || path;
}

function audienceFromTags(tags: string[]): string | undefined {
  const tag = tags.find((value) => value.startsWith('audience:'));
  if (!tag) return undefined;
  return tag.slice('audience:'.length).replace(/-/g, ' ');
}

function appAllowsExecute(app: AppDocument, domain: string): boolean {
  return (app.policies ?? []).some((policy) => {
    if (policy.enabled === false) return false;
    if (policy.domain !== '*' && policy.domain !== domain) return false;
    return policy.accessLevel === 'execute' || policy.accessLevel === 'admin';
  });
}

export function createDashboardForApp(
  projectRoot: string,
  appId: string,
  input: { id?: string; title?: string; description?: string },
): { ok: true; dashboard: DashboardDocument; path: string } | { ok: false; error: string } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const title = cleanString(input.title) || 'New page';
  const id = slugify(cleanString(input.id) || title) || `page-${Date.now()}`;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return { ok: false, error: 'dashboard id must be folder-safe' };
  const appDir = loaded.appDir;
  const dashboardPath = join(appDir, 'dashboards', `${id}.dqld`);
  if (existsSync(dashboardPath)) return { ok: false, error: `Dashboard already exists: ${id}` };
  const dashboard: DashboardDocument = {
    version: 1,
    id,
    metadata: {
      title,
      description: cleanString(input.description) || `${title} dashboard page`,
      domain: loaded.app.domain,
      subdomain: loaded.app.subdomain,
      groups: loaded.app.groups ?? [],
      audience: loaded.app.audience,
      visibility: loaded.app.visibility ?? 'shared',
      lifecycle: loaded.app.lifecycle ?? 'draft',
      tags: loaded.app.tags ?? [],
    },
    layout: {
      kind: 'grid',
      cols: 12,
      rowHeight: 80,
      items: [],
    },
  };
  mkdirSync(dirname(dashboardPath), { recursive: true });
  writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2) + '\n', 'utf-8');
  return { ok: true, dashboard, path: relative(projectRoot, dashboardPath) };
}

function patchDashboardLayout(
  projectRoot: string,
  appId: string,
  dashboardId: string,
  input: { layout?: DashboardDocument['layout']; items?: DashboardGridItem[] },
): { ok: true; dashboard: DashboardDocument; path: string } | { ok: false; error: string } {
  const loaded = loadDashboardForApp(projectRoot, appId, dashboardId);
  if (!loaded) return { ok: false, error: `Dashboard "${dashboardId}" not found in app "${appId}"` };
  const next: DashboardDocument = {
    ...loaded.dashboard,
    layout: input.layout
      ? input.layout
      : {
          ...loaded.dashboard.layout,
          items: input.items ?? loaded.dashboard.layout.items,
        },
  };
  const written = writeDashboard(projectRoot, appId, dashboardId, next);
  if (!written.ok) return written;
  return { ok: true, dashboard: next, path: relative(projectRoot, written.path) };
}

function createAiPinTile(
  projectRoot: string,
  appId: string,
  input: AiPinCreateRequest,
): { ok: true; pin: unknown; dashboard?: DashboardDocument; tile?: DashboardGridItem; deduped?: boolean } | { ok: false; error: string } {
  const dashboardId = cleanString(input.dashboardId);
  if (!dashboardId) return { ok: false, error: 'dashboardId is required' };
  const loaded = loadDashboardForApp(projectRoot, appId, dashboardId);
  if (!loaded) return { ok: false, error: `Dashboard "${dashboardId}" not found in app "${appId}"` };
  const title = cleanString(input.title) || 'AI result';
  const tileId = cleanString(input.tileId) || nextTileId(loaded.dashboard, slugify(title) || 'ai-pin');
  const storage = openAppStorage(projectRoot);
  try {
    const existing = findExistingAiPinTile(storage, loaded.dashboard, appId, dashboardId, title, input);
    if (existing) {
      return { ok: true, pin: existing.pin, dashboard: loaded.dashboard, tile: existing.tile, deduped: true };
    }
    const pin = storage.createAiPin({
      appId,
      dashboardId,
      tileId,
      title,
      answer: cleanString(input.answer) || title,
      question: cleanString(input.question) || undefined,
      sql: cleanString(input.sql) || undefined,
      sourceTier: cleanString(input.sourceTier) || undefined,
      certification: input.certification === 'certified' ? 'certified' : 'ai_generated',
      reviewStatus: input.reviewStatus,
      refreshCadence: input.refreshCadence === 'daily' ? 'daily' : 'none',
      chartConfig: input.chartConfig,
      result: input.result,
      citations: Array.isArray(input.citations) ? input.citations : [],
      analysisPlan: input.analysisPlan,
      evidence: input.evidence,
      followUps: Array.isArray(input.followUps) ? input.followUps.filter((item): item is string => typeof item === 'string') : [],
    });
    const vizType = normalizeVizTypeFromChart(input.chartConfig);
    const dqlArtifact = normalizeDqlArtifactReference(
      input.analysisPlan && typeof input.analysisPlan === 'object' && !Array.isArray(input.analysisPlan)
        ? (input.analysisPlan as Record<string, unknown>).dqlArtifact
        : undefined,
    );
    const runtimeParameters = (dqlArtifact?.parameters ?? []).filter((parameter) => parameter.policy === 'dynamic' || parameter.policy === 'optional');
    const tile: DashboardGridItem = {
      i: tileId,
      ...nextTilePosition(loaded.dashboard),
      aiPin: { id: pin.id },
      viz: { type: vizType },
      display: displayForAiPin(title, vizType, input),
      title,
      ...(runtimeParameters.length > 0 ? {
        parameterBindings: runtimeParameters.map((parameter) => ({
          param: parameter.name,
          source: 'dashboard_filter' as const,
          filter: parameter.name,
          field: parameter.binding?.kind === 'semantic_filter' ? parameter.binding.field : parameter.name,
          parameterType: parameter.type,
          required: parameter.required,
          ...(parameter.default === undefined ? {} : { default: parameter.default }),
          policy: parameter.policy,
        })),
        trustState: dqlArtifact?.trustState === 'certified' ? 'certified' as const : 'review_required' as const,
        reviewStatus: dqlArtifact?.trustState === 'certified' ? 'certified' as const : 'review_required' as const,
      } : {}),
    };
    const artifactFilters = runtimeParameters.map(dashboardFilterForArtifactParameter);
    const existingFilterIds = new Set((loaded.dashboard.filters ?? []).map((filter) => filter.id));
    const dashboard: DashboardDocument = {
      ...loaded.dashboard,
      ...(artifactFilters.length > 0 ? {
        filters: [
          ...(loaded.dashboard.filters ?? []),
          ...artifactFilters.filter((filter) => !existingFilterIds.has(filter.id)),
        ],
      } : {}),
      layout: {
        ...loaded.dashboard.layout,
        items: [...loaded.dashboard.layout.items, tile],
      },
    };
    const written = writeDashboard(projectRoot, appId, dashboardId, dashboard);
    if (!written.ok) {
      return { ok: false, error: written.error };
    }
    return { ok: true, pin, dashboard, tile };
  } finally {
    storage.close();
  }
}

function dashboardFilterForArtifactParameter(
  parameter: BlockParameterDefinition,
): DashboardFilter {
  const type: DashboardFilter['type'] = parameter.type === 'number'
    ? 'number'
    : parameter.type === 'boolean'
      ? 'boolean'
      : parameter.type === 'date'
        ? 'date'
        : parameter.type.endsWith('[]')
          ? 'select'
          : 'string';
  const options = Array.isArray(parameter.default) ? parameter.default.map(String) : undefined;
  return {
    id: parameter.name,
    type,
    ...(parameter.default === undefined ? {} : { default: parameter.default }),
    ...(options?.length ? { options } : {}),
    ...(parameter.binding?.kind === 'semantic_filter' ? { bindsTo: parameter.binding.field } : {}),
  };
}

function findExistingAiPinTile(
  storage: LocalAppStorage,
  dashboard: DashboardDocument,
  appId: string,
  dashboardId: string,
  title: string,
  input: AiPinCreateRequest,
): { pin: LocalAiPin; tile: DashboardGridItem } | null {
  const requested = aiPinDedupeFingerprint(title, input.question, input.analysisPlan, input.result);
  if (!requested) return null;
  const pins = storage.listAiPins(appId, dashboardId);
  for (const pin of pins) {
    const existing = aiPinDedupeFingerprint(pin.title, pin.question, pin.analysisPlan, pin.result);
    if (!existing || existing !== requested) continue;
    const tile = dashboard.layout.items.find((item) => item.aiPin?.id === pin.id || (pin.tileId && item.i === pin.tileId));
    if (tile) return { pin, tile };
  }
  return null;
}

function aiPinDedupeFingerprint(
  title: string | undefined,
  question: unknown,
  analysisPlan: unknown,
  result: unknown,
): string {
  const plan = asRecord(analysisPlan);
  const sourceBlock = cleanString(plan?.sourceBlockId);
  const sourceTile = cleanString(plan?.sourceTileId);
  const questionKey = normalizeAiPinDedupeText(question) || normalizeAiPinDedupeText(title);
  if (!questionKey && !sourceBlock && !sourceTile) return '';
  return [
    questionKey,
    sourceBlock,
    sourceTile,
    aiPinResultFingerprint(result),
  ].filter(Boolean).join('|');
}

function normalizeAiPinDedupeText(value: unknown): string {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aiPinResultFingerprint(result: unknown): string {
  const record = asRecord(result);
  if (!record) return '';
  const columns = Array.isArray(record.columns) ? record.columns.map((column) => String(column).toLowerCase()).join(',') : '';
  const rows = Array.isArray(record.rows) ? record.rows.slice(0, 8).map((row) => stableFingerprintValue(row)).join(';') : '';
  return columns || rows ? `${columns}:${rows}` : '';
}

function stableFingerprintValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableFingerprintValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${key}:${stableFingerprintValue(record[key])}`).join(',')}}`;
}

function promoteAiPinToDraftBlock(
  projectRoot: string,
  appId: string,
  pinId: string,
): { ok: true; pin: unknown; blockPath: string } | { ok: false; error: string } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const storage = openAppStorage(projectRoot);
  try {
    const pin = storage.getAiPin(pinId);
    if (!pin || pin.appId !== appId) return { ok: false, error: `AI pin "${pinId}" not found` };
    if (!pin.sql) return { ok: false, error: 'AI pin has no SQL to promote' };
    const blockName = slugify(pin.title) || pin.id;
    const analysisPlan = pin.analysisPlan && typeof pin.analysisPlan === 'object'
      ? pin.analysisPlan as { candidateTables?: Array<{ relation?: string }>; dimensions?: string[]; measures?: string[] }
      : null;
    const sourceContext = [
      pin.question ? `Question: ${pin.question}` : '',
      analysisPlan?.candidateTables?.length
        ? `Candidate tables: ${analysisPlan.candidateTables.map((table) => table.relation).filter(Boolean).join(', ')}`
        : '',
      analysisPlan?.dimensions?.length ? `Dimensions: ${analysisPlan.dimensions.join(', ')}` : '',
      analysisPlan?.measures?.length ? `Measures: ${analysisPlan.measures.join(', ')}` : '',
    ].filter(Boolean).join(' | ');
    const draftDir = join(loaded.appDir, 'drafts');
    const blockPath = join(draftDir, `${blockName}.dql`);
    mkdirSync(draftDir, { recursive: true });
    const source = [
      `block "${blockName}" {`,
      `  domain = "${escapeDqlString(loaded.app.domain)}"`,
      '  type = "custom"',
      '  status = "review"',
      `  owner = "${escapeDqlString(loaded.app.owners[0] ?? `${process.env.USER ?? 'analyst'}@local`)}"`,
      // With a host, a draft block is project content: it says what it answers, not the pinner's figures.
      `  description = "${escapeDqlString((currentRecordOwner() !== undefined ? pin.question || pin.title : pin.answer).slice(0, 240))}"`,
      sourceContext ? `  llmContext = "${escapeDqlString(sourceContext.slice(0, 800))}"` : '',
      pin.question ? `  examples = [{ question = "${escapeDqlString(pin.question)}" }]` : '',
      '  caveats = ["AI-generated draft. Validate joins, filters, grain, and business interpretation before certification."]',
      '  tags = ["ai-generated", "needs-review"]',
      '',
      '  query = """',
      pin.sql,
      '  """',
      '',
      '  visualization {',
      `    chart = "${escapeDqlString(String((pin.chartConfig as { chart?: unknown } | undefined)?.chart ?? 'table'))}"`,
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(blockPath, source, 'utf-8');
    // The draft's place in the project, as every other route names files: relative to the project, with `/`.
    const projectPath = relative(projectRoot, blockPath).split(sep).join('/');
    const updated = storage.markAiPinPromoted(pinId, projectPath);
    return { ok: true, pin: updated, blockPath: projectPath };
  } finally {
    storage.close();
  }
}

function nextTilePosition(dashboard: DashboardDocument): { x: number; y: number; w: number; h: number } {
  const maxY = dashboard.layout.items.reduce((value, item) => Math.max(value, item.y + item.h), 0);
  return { x: 0, y: maxY, w: 6, h: 3 };
}

function nextTileId(dashboard: DashboardDocument, base: string): string {
  const used = new Set(dashboard.layout.items.map((item) => item.i));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function normalizeVizTypeFromChart(chartConfig: Record<string, unknown> | undefined): DashboardGridItem['viz']['type'] {
  const chart = String(chartConfig?.chart ?? '').toLowerCase().replace(/-/g, '_');
  if (chart === 'single_value' || chart === 'kpi' || chart === 'line' || chart === 'bar' || chart === 'area'
    || chart === 'grouped_bar' || chart === 'stacked_bar' || chart === 'pie' || chart === 'donut'
    || chart === 'scatter' || chart === 'heatmap' || chart === 'histogram' || chart === 'waterfall'
    || chart === 'gauge' || chart === 'pivot' || chart === 'map' || chart === 'funnel') {
    return chart;
  }
  return 'table';
}

function escapeDqlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

function loadAppById(
  projectRoot: string,
  id: string,
): {
  app: AppDocument;
  appDir: string;
  appPath: string;
  dashboards: Array<{ id: string; title: string; description?: string; itemCount: number }>;
  notebooks: AppListEntry['notebooks'];
  drafts: AppListEntry['drafts'];
  aiPins: unknown[];
  investigations: unknown[];
} | null {
  for (const p of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(p);
    if (!document || document.id !== id) continue;
    const appDir = p.slice(0, -'/dql.app.json'.length);
    const dashboards: Array<{ id: string; title: string; description?: string; itemCount: number }> = [];
    for (const d of findDashboardsForApp(appDir)) {
      const { document: dd } = loadDashboardDocument(d);
      if (dd) {
        dashboards.push({
          id: dd.id,
          title: dd.metadata.title,
          description: dd.metadata.description,
          itemCount: dd.layout.items.length,
        });
      }
    }
    return {
      app: document,
      appDir,
      appPath: relative(projectRoot, appDir),
      dashboards,
      notebooks: listAppNotebookRefs(projectRoot, document, appDir),
      drafts: listAppDrafts(projectRoot, appDir),
      aiPins: listAiPins(projectRoot, document.id),
      investigations: listAppInvestigations(projectRoot, document.id),
    };
  }
  return null;
}

export function listNotebookCandidates(projectRoot: string, app: AppDocument, appDir: string): Array<{
  path: string;
  title: string;
  attached: boolean;
  role?: 'source' | 'analysis' | 'supporting';
  visibility?: NonNullable<AppDocument['visibility']>;
  lastModified?: string;
}> {
  const attached = new Map(listAppNotebookRefs(projectRoot, app, appDir).map((notebook) => [notebook.path, notebook]));
  const files = new Map<string, string>();
  for (const root of ['notebooks', 'workbooks', 'apps']) {
    for (const file of scanFiles(join(projectRoot, root), '.dqlnb')) {
      const rel = relative(projectRoot, file).replaceAll('\\', '/');
      files.set(rel, file);
    }
  }
  for (const notebook of attached.values()) {
    const abs = join(projectRoot, notebook.path);
    if (existsSync(abs)) files.set(notebook.path, abs);
  }
  return Array.from(files.entries())
    .map(([path, abs]) => {
      const ref = attached.get(path);
      const stat = statSyncSafe(abs);
      return {
        path,
        title: ref?.title ?? notebookTitleFromFile(abs) ?? titleFromPath(path),
        attached: Boolean(ref),
        role: ref?.role,
        visibility: ref?.visibility,
        lastModified: stat?.mtime.toISOString(),
      };
    })
    .sort((a, b) => Number(b.attached) - Number(a.attached) || a.title.localeCompare(b.title));
}

export function createNotebookForApp(
  projectRoot: string,
  appId: string,
  input: { name?: string; title?: string; role?: string; visibility?: string; template?: string },
): { ok: true; path: string; app: ReturnType<typeof loadAppById>; preview: unknown } | { ok: false; error: string } {
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const title = cleanString(input.title) || cleanString(input.name) || 'App analysis';
  const slug = slugify(cleanString(input.name) || title) || `notebook-${Date.now()}`;
  const appDir = loaded.appDir;
  const relPath = relative(projectRoot, join(appDir, 'notebooks', `${slug}.dqlnb`)).replaceAll('\\', '/');
  const absPath = join(projectRoot, relPath);
  if (existsSync(absPath)) return { ok: false, error: `Notebook already exists: ${relPath}` };
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buildAppNotebookTemplate(title, loaded.app, input.template), 'utf-8');
  const attached = attachNotebookToApp(projectRoot, appId, {
    path: relPath,
    title,
    role: normalizeNotebookRole(input.role),
    visibility: input.visibility,
  });
  if (!attached.ok) return { ok: false, error: attached.error };
  const preview = previewNotebookForApp(projectRoot, appId, relPath);
  return {
    ok: true,
    path: relPath,
    app: loadAppById(projectRoot, appId),
    preview: preview.ok ? preview.preview : null,
  };
}

export function previewNotebookForApp(
  projectRoot: string,
  appId: string,
  notebookPath: string,
): { ok: true; preview: unknown } | { ok: false; status: number; error: string } {
  if (!loadAppById(projectRoot, appId)) return { ok: false, status: 404, error: `App "${appId}" not found` };
  const rel = cleanString(notebookPath).replaceAll('\\', '/');
  if (!rel || rel.startsWith('/') || rel.includes('..') || !rel.endsWith('.dqlnb')) {
    return { ok: false, status: 400, error: 'notebook path must be a project-relative .dqlnb path' };
  }
  const abs = join(projectRoot, rel);
  if (!existsSync(abs)) return { ok: false, status: 404, error: `Notebook not found: ${rel}` };
  try {
    const raw = readFileSync(abs, 'utf-8');
    const parsed = JSON.parse(raw) as {
      title?: string;
      metadata?: { title?: string; description?: string; status?: string; categories?: string[] };
      cells?: Array<Record<string, unknown>>;
    };
    const snapshot = readNotebookRunSnapshot(abs);
    const snapshotByCell = new Map<string, Record<string, unknown>>();
    for (const entry of snapshot?.cells ?? []) {
      if (entry && typeof entry === 'object' && typeof (entry as { cellId?: unknown }).cellId === 'string') {
        snapshotByCell.set(String((entry as { cellId: unknown }).cellId), entry as Record<string, unknown>);
      }
    }
    const cells = (parsed.cells ?? []).map((cell, index) => {
      const id = typeof cell.id === 'string' ? cell.id : `cell-${index + 1}`;
      const snap = snapshotByCell.get(id);
      return {
        id,
        type: typeof cell.type === 'string' ? cell.type : 'sql',
        name: typeof cell.name === 'string' ? cell.name : typeof cell.title === 'string' ? cell.title : undefined,
        content: typeof cell.content === 'string' ? cell.content : typeof cell.source === 'string' ? cell.source : '',
        upstream: typeof cell.upstream === 'string' ? cell.upstream : undefined,
        chartConfig: cell.chartConfig ?? cell.config,
        tableConfig: cell.tableConfig,
        singleValueConfig: cell.singleValueConfig,
        pivotConfig: cell.pivotConfig,
        status: snap?.status ?? 'idle',
        result: snap?.result,
        error: snap?.error,
        executionCount: snap?.executionCount,
        executedAt: snap?.executedAt,
      };
    });
    return {
      ok: true,
      preview: {
        path: rel,
        title: parsed.title ?? parsed.metadata?.title ?? titleFromPath(rel),
        metadata: parsed.metadata ?? {},
        cells,
        snapshotFound: Boolean(snapshot),
        capturedAt: typeof snapshot?.capturedAt === 'string' ? snapshot.capturedAt : undefined,
      },
    };
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) };
  }
}

function attachNotebookToApp(
  projectRoot: string,
  appId: string,
  input: { path?: string; title?: string; role?: string; visibility?: string },
): { ok: true; path: string } | { ok: false; error: string } {
  const notebookPath = cleanString(input.path).replaceAll('\\', '/');
  if (!notebookPath) return { ok: false, error: 'path is required' };
  if (notebookPath.startsWith('/') || notebookPath.includes('..')) {
    return { ok: false, error: 'notebook path must be project-relative' };
  }
  if (!existsSync(join(projectRoot, notebookPath))) {
    return { ok: false, error: `Notebook not found: ${notebookPath}` };
  }
  for (const appJsonPath of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(appJsonPath);
    if (!document || document.id !== appId) continue;
    const role = input.role === 'source' || input.role === 'analysis' ? input.role : 'supporting';
    const visibility = input.visibility === 'private' || input.visibility === 'template' ? input.visibility : 'shared';
    const next: AppDocument = {
      ...document,
      notebooks: [
        ...(document.notebooks ?? []).filter((notebook) => notebook.path !== notebookPath),
        {
          path: notebookPath,
          title: cleanString(input.title) || titleFromPath(notebookPath),
          role,
          visibility,
        },
      ],
    };
    const { document: validated, errors } = parseAppDocument(JSON.stringify(next), appJsonPath);
    if (!validated) return { ok: false, error: errors.map((e) => e.message).join('; ') };
    writeFileSync(appJsonPath, JSON.stringify(validated, null, 2) + '\n', 'utf-8');
    return { ok: true, path: relative(projectRoot, appJsonPath) };
  }
  return { ok: false, error: `App "${appId}" not found` };
}

function listAppNotebookRefs(
  projectRoot: string,
  app: AppDocument,
  appDir: string,
): AppListEntry['notebooks'] {
  const byPath = new Map<string, AppListEntry['notebooks'][number]>();
  for (const notebook of app.notebooks ?? []) {
    byPath.set(notebook.path, {
      path: notebook.path,
      title: notebook.title,
      role: notebook.role,
      visibility: notebook.visibility ?? 'shared',
    });
  }
  const notebooksDir = join(appDir, 'notebooks');
  for (const file of scanFiles(notebooksDir, '.dqlnb')) {
    const rel = relative(projectRoot, file).replaceAll('\\', '/');
    if (byPath.has(rel)) continue;
    byPath.set(rel, {
      path: rel,
      title: titleFromPath(rel),
      role: 'supporting',
      visibility: app.visibility ?? 'shared',
    });
  }
  return Array.from(byPath.values()).sort((a, b) => (a.title ?? a.path).localeCompare(b.title ?? b.path));
}

function buildAppNotebookTemplate(title: string, app: AppDocument, template?: string): string {
  const normalizedTemplate = cleanString(template) || 'blank';
  const cellId = (base: string) => `${slugify(base) || 'cell'}_${Math.random().toString(36).slice(2, 8)}`;
  const intro = [
    `# ${title}`,
    '',
    `App: ${app.name}`,
    `Domain: ${[app.domain, app.subdomain, ...(app.groups ?? [])].filter(Boolean).join(' / ')}`,
    '',
    'Use this notebook for analysis that supports the App dashboard pages.',
  ].join('\n');
  const cells = [
    {
      id: cellId('intro'),
      type: 'markdown',
      content: intro,
    },
    {
      id: cellId('starter-sql'),
      type: 'sql',
      name: 'starter_query',
      content: '-- Write supporting SQL for this App here\nSELECT 1 AS value;',
    },
  ];
  if (normalizedTemplate === 'summary') {
    cells.push({
      id: cellId('summary'),
      type: 'markdown',
      content: '## Notes\n\nAdd observations, assumptions, and follow-up questions here.',
    });
  }
  return JSON.stringify({
    dqlnbVersion: 2,
    version: 1,
    title,
    metadata: {
      description: `Supporting notebook for ${app.name}`,
      status: 'draft',
      categories: [app.domain, app.subdomain, ...(app.groups ?? [])].filter(Boolean),
      ownerDomain: app.ownerDomain,
      usesDomains: app.usesDomains,
      purpose: app.purpose,
      requiredExports: app.requiredExports,
      classification: app.classification,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    },
    cells,
  }, null, 2) + '\n';
}

function notebookTitleFromFile(absPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(absPath, 'utf-8')) as { title?: unknown; metadata?: { title?: unknown } };
    if (typeof parsed.title === 'string' && parsed.title.trim()) return parsed.title.trim();
    if (typeof parsed.metadata?.title === 'string' && parsed.metadata.title.trim()) return parsed.metadata.title.trim();
  } catch {
    // fall back to path-derived title
  }
  return null;
}

function readNotebookRunSnapshot(absNotebookPath: string): { cells?: unknown[]; capturedAt?: unknown } | null {
  const snapshotPath = absNotebookPath.replace(/\.dqlnb$/i, '.run.json');
  if (!existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf-8')) as { cells?: unknown[] };
  } catch {
    return null;
  }
}

function normalizeNotebookRole(value: unknown): 'source' | 'analysis' | 'supporting' {
  return value === 'source' || value === 'analysis' ? value : 'supporting';
}

/** Longest draft SQL carried into a prompt; drafts are context, not the answer. */
const APP_DRAFT_SQL_PROMPT_LIMIT = 1200;

/**
 * The app's drafts, with enough of each to be usable as context.
 *
 * `listAppDrafts` reads the same files for the Drafts panel but keeps only a
 * name and review status, which is why the drafts were visible in the UI and
 * invisible to the copilot even once the envelope carried them.
 */
function loadAppDraftContext(projectRoot: string, appDir: string): AppContextEnvelopeV1['drafts'] {
  return scanFiles(join(appDir, 'drafts'), '.dql').map((file) => {
    const source = readFileSync(file, 'utf-8');
    const path = relative(projectRoot, file).replaceAll('\\', '/');
    const query = matchString(source, /query\s*=\s*"""([\s\S]*?)"""/)?.trim();
    return {
      name: matchString(source, /block\s+"([^"]+)"/) ?? titleFromPath(path),
      path,
      status: matchString(source, /status\s*=\s*"([^"]+)"/) ?? 'review',
      description: matchString(source, /description\s*=\s*"([^"]*)"/) ?? undefined,
      question: matchString(source, /question\s*=\s*"([^"]*)"/) ?? undefined,
      sql: query
        ? query.length > APP_DRAFT_SQL_PROMPT_LIMIT ? `${query.slice(0, APP_DRAFT_SQL_PROMPT_LIMIT)}\n-- …truncated` : query
        : undefined,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function listAppDrafts(projectRoot: string, appDir: string): AppListEntry['drafts'] {
  return scanFiles(join(appDir, 'drafts'), '.dql').map((file) => {
    const source = readFileSync(file, 'utf-8');
    const path = relative(projectRoot, file).replaceAll('\\', '/');
    return {
      path,
      name: matchString(source, /block\s+"([^"]+)"/) ?? titleFromPath(path),
      reviewStatus: matchString(source, /status\s*=\s*"([^"]+)"/) ?? 'review',
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function scanFiles(root: string, extension: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSyncSafe(root)) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...scanFiles(full, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) out.push(full);
  }
  return out.sort();
}

function countAiPins(projectRoot: string, appId: string): number {
  return listAiPins(projectRoot, appId).length;
}

function countAppInvestigations(projectRoot: string, appId: string): number {
  return listAppInvestigations(projectRoot, appId).length;
}

function listAiPins(projectRoot: string, appId: string): unknown[] {
  const dbPath = defaultLocalAppsDbPath(projectRoot);
  if (!existsSync(dbPath)) return [];
  try {
    const storage = openAppStorage(projectRoot);
    try {
      return dedupeLocalAiPins(storage.listAiPins(appId));
    } finally {
      storage.close();
    }
  } catch {
    // AI pins are optional local overlays. Do not hide file-backed Apps when
    // the native SQLite module is unavailable for the current Node runtime.
    return [];
  }
}

function dedupeLocalAiPins(pins: LocalAiPin[]): LocalAiPin[] {
  const seen = new Set<string>();
  const out: LocalAiPin[] = [];
  for (const pin of pins) {
    const fingerprint = aiPinDedupeFingerprint(pin.title, pin.question, pin.analysisPlan, pin.result) || pin.id;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(pin);
  }
  return out;
}

function listAppInvestigations(projectRoot: string, appId: string): unknown[] {
  const dbPath = defaultLocalAppsDbPath(projectRoot);
  if (!existsSync(dbPath)) return [];
  try {
    const storage = openAppStorage(projectRoot);
    try {
      return dedupeAppInvestigationsForDisplay(storage.listAppInvestigations(appId));
    } finally {
      storage.close();
    }
  } catch {
    return [];
  }
}

function dedupeAppInvestigationsForDisplay(investigations: LocalAppInvestigation[]): LocalAppInvestigation[] {
  const seen = new Set<string>();
  const out: LocalAppInvestigation[] = [];
  for (const investigation of investigations) {
    const fingerprint = appInvestigationReuseFingerprint(investigation);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(investigation);
  }
  return out;
}

function listDashboardsFor(projectRoot: string, id: string) {
  const result = loadAppById(projectRoot, id);
  return result?.dashboards ?? null;
}

function loadDashboardForApp(
  projectRoot: string,
  appId: string,
  dashboardId: string,
): { app: AppDocument; dashboard: DashboardDocument; path: string } | null {
  for (const p of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(p);
    if (!document || document.id !== appId) continue;
    const appDir = p.slice(0, -'/dql.app.json'.length);
    for (const d of findDashboardsForApp(appDir)) {
      const { document: dd } = loadDashboardDocument(d);
      if (dd && dd.id === dashboardId) {
        return { app: document, dashboard: dd, path: d };
      }
    }
  }
  return null;
}

export { writeDashboard as writeDashboardForTest };

function writeDashboard(
  projectRoot: string,
  appId: string,
  dashboardId: string,
  payload: unknown,
): { ok: true; path: string } | { ok: false; error: string } {
  // Validate against the dashboard schema before touching disk.
  const { document, errors } = parseDashboardDocument(JSON.stringify(payload), '<incoming>');
  if (!document) {
    return { ok: false, error: errors.map((e) => e.message).join('; ') };
  }
  if (document.id !== dashboardId) {
    return { ok: false, error: `dashboard.id (${document.id}) does not match URL :did (${dashboardId})` };
  }

  // Confirm the App exists.
  const loaded = loadAppById(projectRoot, appId);
  if (!loaded) return { ok: false, error: `App "${appId}" not found` };
  const appDir = loaded.appDir;
  const dashboardPath = join(appDir, 'dashboards', `${dashboardId}.dqld`);
  // Dashboard ids are unique only within an App — `overview` is a common name —
  // so a caller holding one App's document and another App's id would silently
  // overwrite the wrong file. Only accept a title change to an existing page,
  // never a wholesale replacement of a different App's page of the same name.
  if (existsSync(dashboardPath)) {
    const existing = loadDashboardDocument(dashboardPath).document;
    const incomingBlocks = new Set(document.layout.items.map((item) => item.i));
    const existingBlocks = new Set((existing?.layout.items ?? []).map((item) => item.i));
    const overlap = [...incomingBlocks].filter((tileId) => existingBlocks.has(tileId)).length;
    if (existingBlocks.size > 0 && incomingBlocks.size > 0 && overlap === 0) {
      return {
        ok: false,
        error: `Refusing to overwrite "${appId}/${dashboardId}": the incoming page shares no tiles with the one on disk, so it is very likely a different App's page of the same name.`,
      };
    }
  }
  mkdirSync(dirname(dashboardPath), { recursive: true });
  writeFileSync(dashboardPath, JSON.stringify(document, null, 2) + '\n', 'utf-8');
  return { ok: true, path: dashboardPath };
}

function activatePersona(
  projectRoot: string,
  userId: string,
  appId: string | null,
): ActivePersona | null {
  // If an App id is provided, scope the persona to it.
  if (appId) {
    for (const p of findAppDocuments(projectRoot)) {
      const { document } = loadAppDocument(p);
      if (!document || document.id !== appId) continue;
      return defaultPersonaRegistry.setFromApp(document, userId);
    }
    return null;
  }
  // Otherwise pick the first App that contains the user.
  for (const p of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(p);
    if (!document) continue;
    const member = document.members.find((m) => m.userId === userId);
    if (member) {
      const persona = personaFromMember(document, member);
      defaultPersonaRegistry.set(persona);
      return persona;
    }
  }
  return null;
}

// ---- IO utilities ----

async function refreshGeneratedMetadata(projectRoot: string): Promise<void> {
  try {
    const { ensureMetadataCatalogFresh } = await import('@zlens/agent');
    await ensureMetadataCatalogFresh(projectRoot, { force: true });
  } catch {
    // App files remain the source of truth; the local catalog refreshes again
    // on the next agent/MCP call if this best-effort update fails.
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({} as T);
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export const __test__ = {
  buildMetricSnapshot,
  buildPreviewDriverCards,
  buildPreviewMetricSnapshot,
  buildDeterministicInvestigationSql,
  buildInvestigationSummary,
  buildInvestigationReportSections,
  classifySqlPreviewError,
  investigationNarrativeAnswer,
  createAiPinTile,
  runGeneratedSqlPreview,
  renderSqlTemplateParams,
  unresolvedSqlTemplateParams,
  selectedBlockContext,
  runAppInvestigation,
  askAppQuestion,
  collectAppsList,
  loadAppById,
};

// reference unused parseAppDocument/readFileSync to keep import stable for forward use
void parseAppDocument;
void readFileSync;

/**
 * The project's App publish settings (T3), read fresh from `dql.config.json`
 * on every call so a change applies to the next publish without a restart.
 * Open source: off unless `apps.requireCertifiedToPublish` is `true`. An
 * Enterprise host turns it on by writing that setting through its admin policy
 * (or by overriding this read); there is no per-App rule.
 */
export function readAppsPublishSettings(projectRoot: string): AppsPublishSettings {
  try {
    return appsPublishSettings(JSON.parse(readFileSync(join(projectRoot, 'dql.config.json'), 'utf-8')));
  } catch {
    return appsPublishSettings(undefined);
  }
}
