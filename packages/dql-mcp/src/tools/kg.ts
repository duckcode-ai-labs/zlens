/**
 * MCP tools wrapping the dql-agent KG.
 *
 * `kg_search` — keyword + filter search over the KG (powers chat retrieval).
 * `feedback_record` — log local answer-quality telemetry for explicit review.
 * It never promotes, suppresses, certifies, or mutates a governed hint.
 *
 * Both tools open the SQLite KG file at `.dql/cache/agent-kg.sqlite` and
 * close it after the turn so file handles never leak. If the KG hasn't
 * been built yet, `kg_search` returns an empty result with a hint.
 */

import { existsSync } from 'node:fs';
import type { DQLContext } from '../context.js';
import {
  KGStore,
  buildLocalContextPack,
  defaultKgPath,
  ensureMetadataCatalogFresh,
  reindexProject,
  type KGNodeKind,
} from '@zlens/agent';
import { zodInputShapeForTool } from '../tool-schema.js';
import { governedAnswerPointer } from './next-step.js';

export const kgSearchInput = zodInputShapeForTool('kg_search');

export async function kgSearch(
  ctx: DQLContext,
  args: { query: string; kinds?: string[]; domain?: string; limit?: number },
) {
  const path = defaultKgPath(ctx.projectRoot);
  const refreshError = await reindexProject(ctx.projectRoot, { kgPath: path })
    .then(() => null)
    .catch((err) => err instanceof Error ? err.message : String(err));
  if (refreshError) {
    return {
      hits: [],
      hint: `KG refresh failed: ${refreshError}`,
    };
  }
  const kg = new KGStore(path);
  try {
    const hits = kg.search({
      query: args.query,
      kinds: args.kinds as KGNodeKind[] | undefined,
      domain: args.domain,
      limit: args.limit ?? 10,
    });
    const pointer = hits.length === 0
      ? governedAnswerPointer(ctx, 'No knowledge-graph nodes match this search text.')
      : undefined;
    return {
      ...(pointer ?? {}),
      hits: hits.map((h) => ({
        nodeId: h.node.nodeId,
        kind: h.node.kind,
        name: h.node.name,
        domain: h.node.domain,
        status: h.node.status,
        owner: h.node.owner,
        description: h.node.description,
        tags: h.node.tags,
        sourceTier: h.node.sourceTier,
        certification: h.node.certification,
        provenance: h.node.provenance,
        businessOutcome: h.node.businessOutcome,
        businessOwner: h.node.businessOwner,
        decisionUse: h.node.decisionUse,
        reviewCadence: h.node.reviewCadence,
        pattern: h.node.pattern,
        grain: h.node.grain,
        entities: h.node.entities,
        outputs: h.node.declaredOutputs,
        dimensions: h.node.dimensions,
        allowedFilters: h.node.allowedFilters,
        parameterPolicy: h.node.parameterPolicy,
        filterBindings: h.node.filterBindings,
        sourceSystems: h.node.sourceSystems,
        replacementFor: h.node.replacementFor,
        datalexContract: h.node.datalexContract,
        boundedContext: h.node.boundedContext,
        primaryTerms: h.node.primaryTerms,
        businessRules: h.node.businessRules,
        caveats: h.node.caveats,
        score: h.score,
        snippet: h.snippet,
        sourcePath: h.node.sourcePath,
      })),
    };
  } finally {
    kg.close();
  }
}

export const inspectMetadataContextInput = zodInputShapeForTool('inspect_metadata_context');

export async function inspectMetadataContext(
  ctx: DQLContext,
  args: {
    question: string;
    focusObjectKey?: string;
    objectTypes?: string[];
    limit?: number;
    strictness?: 'balanced' | 'exploratory';
    includeDiagnostics?: boolean;
  },
) {
  const refresh = await ensureMetadataCatalogFresh(ctx.projectRoot)
    .catch((err) => ({
      path: '',
      refreshed: false,
      objectCount: 0,
      edgeCount: 0,
      diagnostics: [{
        kind: 'metadata',
        severity: 'error' as const,
        message: err instanceof Error ? err.message : String(err),
      }],
      fingerprint: '',
    }));
  const contextPack = await buildLocalContextPack(ctx.projectRoot, {
    question: args.question,
    focusObjectKey: args.focusObjectKey,
    objectTypes: args.objectTypes,
    limit: args.limit ?? (args.strictness === 'exploratory' ? 160 : undefined),
    strictness: args.strictness,
  });
  return {
    catalog: {
      path: refresh.path || '.dql/cache/metadata.sqlite',
      refreshed: refresh.refreshed,
      objectCount: refresh.objectCount,
      edgeCount: refresh.edgeCount,
      diagnostics: refresh.diagnostics,
    },
    contextPack: args.includeDiagnostics ? contextPack : compactContextPack(contextPack),
  };
}

/** Objects returned with their full payload; the rest keep key, type, name and snippet. */
const FULL_PAYLOAD_OBJECTS = 3;
const MAX_OBJECTS = 30;
const MAX_EDGES = 20;
const MAX_LIST = 25;

/**
 * The full pack runs to hundreds of KB on a real project (the retrieval
 * diagnostics alone are most of it), which is more than Claude Code accepts
 * from one tool call (it refuses results over ~25k tokens) and crowds every
 * other client's context. Keep everything an agent needs to write and check
 * SQL — the pack id, question plan, route, trust label, allowed SQL context,
 * evidence, citations, governed join paths, missing context and conflicts —
 * and summarize the rest. `includeDiagnostics: true` returns it all.
 */
export function compactContextPack<T extends object>(input: T): T {
  const pack = input as unknown as Record<string, unknown>;
  const objects = Array.isArray(pack.objects) ? pack.objects as Array<Record<string, unknown>> : [];
  const edges = Array.isArray(pack.edges) ? pack.edges as unknown[] : [];
  const diagnostics = (pack.retrievalDiagnostics ?? {}) as Record<string, unknown>;
  const countOf = (value: unknown) => (Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0);
  return {
    ...pack,
    objects: objects.slice(0, MAX_OBJECTS).map((object, index) => (index < FULL_PAYLOAD_OBJECTS
      ? object
      : { objectKey: object.objectKey, objectType: object.objectType, name: object.name, ...(object.status ? { status: object.status } : {}), ...(object.snippet ? { snippet: object.snippet } : {}) })),
    ...(objects.length > MAX_OBJECTS ? { objectsOmitted: objects.length - MAX_OBJECTS } : {}),
    edges: edges.slice(0, MAX_EDGES),
    ...(Array.isArray(pack.evidenceRoles) ? { evidenceRoles: (pack.evidenceRoles as unknown[]).slice(0, MAX_LIST) } : {}),
    ...(Array.isArray(pack.citations) ? { citations: (pack.citations as unknown[]).slice(0, MAX_LIST) } : {}),
    ...(edges.length > MAX_EDGES ? { edgesOmitted: edges.length - MAX_EDGES } : {}),
    retrievalDiagnostics: {
      ...(diagnostics.strategy !== undefined ? { strategy: diagnostics.strategy } : {}),
      ...(diagnostics.selectedJoinPaths !== undefined ? { selectedJoinPaths: diagnostics.selectedJoinPaths } : {}),
      ...(diagnostics.candidateConflicts !== undefined ? { candidateConflicts: diagnostics.candidateConflicts } : {}),
      ...(diagnostics.certifiedCandidateFits !== undefined ? { certifiedCandidateFits: diagnostics.certifiedCandidateFits } : {}),
      counts: Object.fromEntries(Object.entries(diagnostics)
        .filter(([key]) => !['strategy', 'selectedJoinPaths', 'candidateConflicts', 'certifiedCandidateFits'].includes(key))
        .map(([key, value]) => [key, countOf(value)])),
      note: 'Summarized. Call inspect_metadata_context with includeDiagnostics: true for the full retrieval diagnostics.',
    },
  } as unknown as T;
}

export const feedbackRecordInput = zodInputShapeForTool('feedback_record');

export function feedbackRecord(
  ctx: DQLContext,
  args: {
    user: string;
    question: string;
    answerKind: 'certified' | 'uncertified';
    blockId?: string;
    rating: 'up' | 'down';
    comment?: string;
  },
) {
  const path = defaultKgPath(ctx.projectRoot);
  if (!existsSync(path)) {
    return {
      ok: false,
      error: 'KG not built — run `zlens app reindex` first so feedback can be persisted.',
    };
  }
  const kg = new KGStore(path);
  try {
    kg.recordFeedback({
      id: `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      user: args.user,
      question: args.question,
      answerKind: args.answerKind,
      blockId: args.blockId,
      rating: args.rating,
      comment: args.comment,
    });
    return { ok: true };
  } finally {
    kg.close();
  }
}
