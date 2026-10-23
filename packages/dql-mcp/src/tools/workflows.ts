import type { DQLContext } from '../context.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_BUILD_HANDOFF_SOURCE_LIMIT,
  appBuildHandoffSourceSummary,
  buildAnalysisQuestionPlan,
  composeSemanticQueryForQuestion,
  appStudioDraftPath,
  askScopeFromWorkspace,
  createAppBuildHandoffDraft,
  defaultKgPath,
  ensureAgentProjectReady,
  ensureMetadataCatalogFresh,
  matchAppSourceCatalogRecords,
  planAgentAnswer,
  planAppBuildBrief,
  reindexProject,
  resolveDomainContextEnvelope,
  shortlistAppSources,
  type AppSourceCatalogRecord,
  type DomainContextEnvelope,
  type MetadataAllowedSqlContext,
  type MetadataObject,
  type ReindexProjectResult,
} from '@zlens/agent';
import { resolveTrustLabel, trustLabelIdForRoute } from '@zlens/core';
import { LocalAppStorage, defaultLocalAppsDbPath } from '@zlens/project';
import { suggestBlock } from './suggest-block.js';
import { zodInputShapeForTool } from '../tool-schema.js';

export const askDqlInput = zodInputShapeForTool('ask_dql');

export async function askDql(
  ctx: DQLContext,
  args: { question: string; focusObjectKey?: string; limit?: number; domain?: string; purpose?: string; modelAreaId?: string; skillRefs?: string[] },
) {
  // The plan-only path reads the same envelope the executing path does
  // (CTX-001): a pinned domain admits its descendants and certified imports
  // and excludes its siblings, here as everywhere.
  const scope = askScopeFromWorkspace(args);
  let domainContext: DomainContextEnvelope | undefined;
  if (scope.domain || scope.purpose || scope.modelAreaId || scope.skillRefs) {
    try {
      domainContext = resolveDomainContextEnvelope({ manifest: ctx.manifest, activeDomain: scope.domain ?? null, purpose: scope.purpose, modelAreaId: scope.modelAreaId, skillRefs: scope.skillRefs, source: 'explicit_api' });
    } catch (error) {
      return { ok: false as const, error: `The requested scope could not be resolved: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const catalog = await ensureMetadataCatalogFresh(ctx.projectRoot).catch((error) => ({
    path: '',
    refreshed: false,
    objectCount: 0,
    edgeCount: 0,
    diagnostics: [{
      kind: 'metadata',
      severity: 'error' as const,
      message: error instanceof Error ? error.message : String(error),
    }],
    fingerprint: '',
  }));
  const planned = await planAgentAnswer(ctx.projectRoot, {
    question: args.question,
    focusObjectKey: args.focusObjectKey,
    limit: args.limit ?? 100,
    surface: 'mcp',
    ...(domainContext ? { domainContext, selectedContext: { domain: scope.domain, purpose: scope.purpose, modelAreaId: scope.modelAreaId } } : {}),
  });
  const route = planned.routeDecision;
  const exact = route.exactObjectKey
    ? planned.contextPack.objects.find((object) => object.objectKey === route.exactObjectKey)
    : undefined;
  const certifiedCandidates = planned.contextPack.objects
    .filter((object) => object.objectType === 'dql_block' && isCertified(object))
    .slice(0, 8)
    .map(summarizeObject);

  // Canonical trust label (base + optional qualifier) — one vocabulary shared
  // with the agent answer-loop and the UI badge. Derived from the route so MCP
  // clients always see the same label set.
  const trustLabel = resolveTrustLabel(trustLabelIdForRoute(route.route));
  const semanticCandidate = route.route === 'generated_sql' ? semanticCandidateFor(ctx, args.question) : undefined;

  return {
    question: args.question,
    contextPackId: planned.contextPackId,
    knowledgeLens: planned.contextPack.knowledgeLens,
    route: route.route,
    intent: route.intent,
    /** Legacy field retained for backward compatibility. */
    trustStatus: route.trustLabel,
    /** Canonical trust label: { id, base, qualifier?, severity, color, display }. */
    trustLabel,
    reviewStatus: route.reviewStatus,
    reason: route.reason,
    routeReason: route.routeReason,
    grainGate: route.grainGate,
    recommendedAction: semanticCandidate
      ? `The semantic metric "${semanticCandidate.metric}" answers this. Call query_semantic_model with { question }; its answer is labelled From Metrics. Write SQL for query_via_metadata only if it returns matched: false.`
      : recommendedAction(route.route),
    ...(semanticCandidate
      ? { nextTool: 'query_semantic_model', semanticCandidate }
      : nextTool(route.route) ? { nextTool: nextTool(route.route) } : {}),
    exactCertifiedBlock: exact && exact.objectType === 'dql_block' ? summarizeObject(exact) : undefined,
    certifiedCandidates,
    // Conflict route: surface BOTH sides + owners + the disambiguation prompt.
    conflict: route.routeConflict,
    selectedEvidence: route.selectedEvidence,
    allowedSqlContext: summarizeAllowedSqlContext(planned.allowedSqlContext),
    missingContext: planned.missingContext,
    followUps: route.followUps,
    warnings: [
      ...planned.warnings,
      ...catalog.diagnostics.map((diagnostic) => diagnostic.message),
    ],
    answerContract: {
      requiredFields: [
        'answer',
        'tableOrResultSummary',
        'sqlWhenGenerated',
        'trustStatus',
        'citations',
        'draftPathWhenGenerated',
        'nextReviewAction',
      ],
      // Canonical vocabulary the answer must report under `trustStatus`.
      trustLabels: ['Certified', 'From Metrics', 'Reviewed', 'AI-Generated', 'Insufficient-Context', 'Conflict'],
      rule: 'Never present generated SQL or Tier-2 preview rows as certified. From Metrics is the label query_semantic_model returns for a compile from semantic metrics and dimensions; it is not Certified. On a Conflict route, present BOTH conflicting definitions with their owners and ask the user to choose — never silently pick one.',
    },
  };
}

export const buildDqlAppInput = zodInputShapeForTool('build_dql_app');

export async function buildDqlApp(
  ctx: DQLContext,
  args: {
    prompt: string;
    name?: string;
    blocks?: string[];
    domain?: string;
    owner?: string;
    aiLayout?: boolean;
    saveDraft?: boolean;
    overwrite?: boolean;
  },
) {
  try {
    return await buildDqlAppOnce(ctx, args);
  } catch (error) {
    // The workbench and this server share the index; a rebuild in the other
    // process can leave this connection read-only or locked for a moment.
    if (!isTransientIndexError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      return await buildDqlAppOnce(ctx, args);
    } catch (retryError) {
      if (!isTransientIndexError(retryError)) throw retryError;
      return {
        ok: false as const,
        error: 'The ZLens index was being rebuilt by another process (usually the workbench), so the App could not be planned. Retry in a moment.',
      };
    }
  }
}

function isTransientIndexError(error: unknown): boolean {
  return /readonly database|database is locked|SQLITE_BUSY|SQLITE_READONLY/i.test(error instanceof Error ? error.message : String(error));
}

async function buildDqlAppOnce(
  ctx: DQLContext,
  args: Parameters<typeof buildDqlApp>[1],
) {
  const prompt = args.prompt?.trim() ?? '';
  if (!prompt) return { ok: false as const, error: 'prompt is required: describe what the App is for.' };
  const unknownBlocks = (args.blocks ?? []).filter((name) => ctx.manifest.blocks[name]?.status !== 'certified');
  if (unknownBlocks.length > 0) {
    return {
      ok: false as const,
      error: `Only certified blocks can be App data; not certified or not found: ${unknownBlocks.join(', ')}. Use search_blocks with status "certified".`,
    };
  }
  await ensureAgentProjectReady(ctx.projectRoot);
  const domain = cleanOptional(args.domain);
  // The App's data: the blocks the caller named exactly, or what the App
  // Studio planner picks from certified data for the request.
  let picks: Array<{ source: AppSourceCatalogRecord; reason: string }>;
  let notCoveredYet: Array<{ question: string; reason?: string }> = [];
  if (args.blocks?.length) {
    const matched = matchAppSourceCatalogRecords(ctx.projectRoot, { blockNames: args.blocks }, 'governed_only');
    if (matched.unmatched.length) {
      return {
        ok: false as const,
        error: `These certified blocks are not in the App data catalog yet: ${matched.unmatched.join(', ')}. Run inspect_dql_project with refresh, then retry.`,
      };
    }
    picks = matched.items.map((source) => ({ source, reason: 'You named this block.' }));
  } else {
    // Certified data first, never only certified data (T3): readers see
    // "Not certified yet" on tiles nobody certified.
    const candidates = shortlistAppSources(ctx.projectRoot, prompt, {
      sourcePolicy: 'include_review_required',
      ...(domain ? { domains: [domain] } : {}),
    }).items;
    const brief = await planAppBuildBrief({
      prompt,
      candidates,
      requiredSourceIds: [],
      sourcePolicy: 'include_review_required',
      ...(domain ? { domain } : {}),
    });
    const byId = new Map(candidates.map((candidate) => [candidate.sourceId, candidate]));
    picks = brief.selectedSourceIds.flatMap((sourceId) => {
      const source = byId.get(sourceId);
      const component = brief.components.find((candidate) => candidate.sourceId === sourceId);
      return source ? [{ source, reason: component?.rationale || `Matched ${source.title} for this request.` }] : [];
    });
    const covered = new Set(brief.components.flatMap((component) => component.requirementIds));
    notCoveredYet = brief.requirements
      .filter((requirement) => !covered.has(requirement.id))
      .map((requirement) => ({ question: requirement.question, reason: 'No certified data covers this question yet.' }));
  }
  picks = picks.slice(0, APP_BUILD_HANDOFF_SOURCE_LIMIT);
  const name = cleanOptional(args.name) ?? appNameFromPrompt(prompt);
  const sources = picks.map((pick) => appBuildHandoffSourceSummary(pick.source, pick.reason));
  // The gaps are reported, not stored: App Studio plans again from the same
  // goal and lists them under "Not covered yet" itself.
  const draft = createAppBuildHandoffDraft({
    goal: prompt,
    name,
    ...(domain ? { domain } : {}),
    sources: picks.map((pick) => pick.source),
  });
  const nothingPicked = sources.length === 0
    ? ['No certified data matched this request. App Studio suggests data again and lists what is not covered yet.']
    : [];
  if (args.saveDraft === false) {
    return {
      ok: true as const,
      saved: false,
      appId: draft.appId,
      name: draft.name,
      domain: domain ?? null,
      sourcePolicy: 'Certified data first',
      sources,
      notCoveredYet: notCoveredYet.map((gap) => gap.question),
      warnings: nothingPicked,
      nextActions: ['Call build_dql_app again without saveDraft:false to create the App Studio draft.'],
    };
  }
  const storage = new LocalAppStorage(defaultLocalAppsDbPath(ctx.projectRoot));
  try {
    storage.saveAppBuildDraft(draft);
  } finally {
    storage.close();
  }
  const openPath = appStudioDraftPath(draft.id);
  const notebook = runningNotebookUrl(ctx.projectRoot);
  return {
    ok: true as const,
    saved: true,
    draftId: draft.id,
    appId: draft.appId,
    name: draft.name,
    domain: domain ?? null,
    sourcePolicy: 'Certified data first',
    openPath,
    ...(notebook ? { openUrl: `${notebook}${openPath}` } : {}),
    sources,
    notCoveredYet: notCoveredYet.map((gap) => gap.question),
    warnings: nothingPicked,
    nextActions: [
      notebook
        ? `Open ${notebook}${openPath} to review the App in App Studio. It opens at the Data step.`
        : `Start the workbench (zlens notebook) and open ${openPath} to review the App in App Studio. It opens at the Data step.`,
      // Honest about who chose the data (F09): this tool plans from keywords, never with an AI provider.
      `${args.blocks?.length ? 'Check the data you named' : 'Check the suggested data'}, build the pages, then publish. Nothing is written to the project until you publish.`,
    ],
  };
}

/** A short App name from the request when the caller gives none. */
function appNameFromPrompt(prompt: string): string {
  const words = prompt.replace(/^(?:please\s+)?(?:build|create|make|draft|design)\s+(?:me\s+)?(?:an?\s+)?(?:app\s+(?:for|about|on)\s+)?/i, '').trim() || prompt;
  const name = words.charAt(0).toUpperCase() + words.slice(1);
  return name.length > 80 ? `${name.slice(0, 77).trimEnd()}…` : name;
}

/** The address of the `zlens notebook` running on this project, when there is one. */
function runningNotebookUrl(projectRoot: string): string | undefined {
  try {
    const descriptor = JSON.parse(readFileSync(join(projectRoot, '.dql', 'local', 'notebook.json'), 'utf-8')) as { pid?: unknown; url?: unknown };
    if (typeof descriptor.url !== 'string' || !/^https?:\/\//.test(descriptor.url)) return undefined;
    if (typeof descriptor.pid === 'number') process.kill(descriptor.pid, 0);
    return descriptor.url.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export const inspectDqlProjectInput = zodInputShapeForTool('inspect_dql_project');

export async function inspectDqlProject(
  ctx: DQLContext,
  args: { refresh?: boolean },
) {
  let index: ReindexProjectResult | undefined;
  let catalog: { path: string; refreshed: boolean; objectCount: number; edgeCount: number; diagnostics: unknown[] } | undefined;
  if (args.refresh !== false) {
    index = await reindexProject(ctx.projectRoot, { kgPath: defaultKgPath(ctx.projectRoot) });
    catalog = await ensureMetadataCatalogFresh(ctx.projectRoot);
    ctx.refresh();
  }
  const manifest = ctx.manifest;
  const blocks = Object.values(manifest.blocks ?? {});
  const dashboards = Object.values(manifest.dashboards ?? {});
  const apps = Object.values(manifest.apps ?? {});
  const knowledgeGraph = manifest.knowledgeGraph;
  const certifiedBlocks = blocks.filter((block) => block.status === 'certified');
  return {
    projectRoot: ctx.projectRoot,
    blocks: {
      total: blocks.length,
      certified: certifiedBlocks.length,
      draft: blocks.length - certifiedBlocks.length,
    },
    // The certified answers come first: a client with no agent guide file
    // (Claude Desktop) sees them before the semantic layer or the warehouse.
    certifiedBlocks: certifiedBlocks.slice(0, INSPECT_CERTIFIED_BLOCK_LIMIT).map((block) => ({
      name: block.name,
      domain: block.domain ?? null,
      grain: block.grain ?? null,
      description: block.description ?? null,
    })),
    ...(certifiedBlocks.length > INSPECT_CERTIFIED_BLOCK_LIMIT
      ? { certifiedBlocksTruncated: `${certifiedBlocks.length - INSPECT_CERTIFIED_BLOCK_LIMIT} more; search_blocks finds them.` }
      : {}),
    nextTool: 'ask_dql',
    apps: apps.length,
    dashboards: dashboards.length,
    semantic: {
      metrics: ctx.semanticLayer.listMetrics().length,
      dimensions: ctx.semanticLayer.listDimensions().length,
    },
    knowledge: knowledgeGraph ? {
      schemaVersion: knowledgeGraph.schemaVersion,
      sourceFingerprint: knowledgeGraph.sourceFingerprint,
      objects: knowledgeGraph.counts?.objects ?? Object.keys(knowledgeGraph.objects ?? {}).length,
      edges: knowledgeGraph.counts?.edges ?? knowledgeGraph.edges?.length ?? 0,
      domainCapsules: Object.values(knowledgeGraph.domainCapsules).map((capsule) => ({
        id: capsule.id,
        domainId: capsule.domainId,
        modelAreaId: capsule.modelAreaId,
        fingerprint: capsule.fingerprint,
        skills: capsule.skillRefs.length,
      })),
      routeStates: knowledgeGraph.crossDomainRoutes.reduce<Record<string, number>>((counts, route) => {
        counts[route.state] = (counts[route.state] ?? 0) + 1;
        return counts;
      }, {}),
    } : undefined,
    index,
    catalog,
    recommendedNextStep: certifiedBlocks.length > 0
      ? 'Call ask_dql with the user\'s question next, before query_semantic_model, list_datasets or any SQL. When one of the certifiedBlocks answers it at its grain, ask_dql returns route "certified" and nextTool query_via_block; answer from that block.'
      : 'Call ask_dql with the user\'s question next, before writing SQL, then query_via_block or query_via_metadata based on the returned route.',
  };
}

const INSPECT_CERTIFIED_BLOCK_LIMIT = 50;

export const buildDqlBlockInput = zodInputShapeForTool('build_dql_block');

export function buildDqlBlock(
  ctx: DQLContext,
  args: Parameters<typeof suggestBlock>[1],
) {
  return suggestBlock(ctx, args);
}

/**
 * The semantic compile a generated-route question would get, when the
 * semantic layer has the metric it names. Sends the agent to
 * query_semantic_model (From Metrics) before it writes its own SQL (AI-Generated),
 * the order the Ask page follows.
 */
function semanticCandidateFor(ctx: DQLContext, question: string) {
  try {
    const result = composeSemanticQueryForQuestion({
      semanticLayer: ctx.semanticLayer,
      question,
      questionPlan: buildAnalysisQuestionPlan(question),
    });
    if (!result) return undefined;
    return {
      metric: result.metric,
      metrics: result.metrics,
      dimensions: result.dimensions,
      ...(result.timeDimension ? { timeDimension: result.timeDimension } : {}),
      trustLabel: resolveTrustLabel('governed'),
    };
  } catch {
    return undefined;
  }
}

function recommendedAction(route: string): string {
  if (route === 'certified') return 'Use query_via_block only if the certified grain exactly answers the question.';
  if (route === 'generated_sql') return 'Generate one read-only SELECT/WITH query from the allowed SQL context, then call query_via_metadata.';
  if (route === 'research') return 'Use lineage, proposals, and metadata evidence before creating or promoting any app tile.';
  if (route === 'conflict') return 'Do not answer. Present both conflicting definitions with their owners and ask the user which one is authoritative.';
  return 'Ask for the missing business object, metric, table, filter, or grain before writing SQL.';
}

/**
 * Advisory next REGISTERED tool for the route. Conflict/missing-context routes
 * have no tool to call — the agent must ask the USER — so this returns
 * undefined instead of a phantom tool name a model would try to invoke.
 */
function nextTool(route: string): string | undefined {
  if (route === 'certified') return 'query_via_block';
  if (route === 'generated_sql') return 'query_via_metadata';
  if (route === 'research') return 'inspect_metadata_context';
  return undefined;
}

function summarizeAllowedSqlContext(context: MetadataAllowedSqlContext): MetadataAllowedSqlContext {
  return {
    relations: context.relations.slice(0, 12).map((relation) => ({
      ...relation,
      columns: relation.columns.slice(0, 40),
    })),
    sourceBlockSql: context.sourceBlockSql.slice(0, 8),
  };
}

function summarizeObject(object: MetadataObject) {
  return {
    objectKey: object.objectKey,
    objectType: object.objectType,
    name: object.name,
    fullName: object.fullName,
    domain: object.domain,
    owner: object.owner,
    status: object.status,
    description: object.description,
    sourcePath: object.sourcePath,
  };
}

function isCertified(object: MetadataObject): boolean {
  return object.status === 'certified' || object.payload?.certification === 'certified';
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
