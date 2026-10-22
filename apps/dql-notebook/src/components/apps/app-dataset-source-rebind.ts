import {
  datasetPhysicalField,
  type DatasetDescriptor,
} from '@zlens/core/datasets/descriptor';
import {
  datasetTileVisualizationCompatibility,
  tileQueryOutputAliases,
  validateTileQuery,
} from '@zlens/core/apps/tile-query';
import type {
  AppBlockRecommendation,
  AppStudioBuildDraft,
  AppStudioDraftOperation,
} from '../../api/client';

type DatasetPage = AppStudioBuildDraft['pages'][number];
type DatasetTile = DatasetPage['layout']['items'][number];

export type DatasetSourceRebindPlan =
  | {
    ok: true;
    sourceId: string;
    requiresReviewPolicy: boolean;
    operations: AppStudioDraftOperation[];
  }
  | {
    ok: false;
    code: 'REVIEW_POLICY_REQUIRED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_INCOMPATIBLE' | 'NO_APP_BINDING';
    error: string;
  };

export type DatasetSourceRebindActionResult =
  | {
    ok: true;
    draft: AppStudioBuildDraft;
    plan: Extract<DatasetSourceRebindPlan, { ok: true }>;
  }
  | Extract<DatasetSourceRebindPlan, { ok: false }>;

/**
 * Plan a deliberate revision refresh for the current local App only. The
 * browser carries historical source identity and authored page intent; the
 * PATCH boundary replaces the source card with a fresh server-owned catalog
 * record before applying these operations. This does not certify a review
 * source and it does not touch another App or draft.
 */
export function planDatasetSourceRebind(
  draft: AppStudioBuildDraft,
  candidate: AppBlockRecommendation | undefined,
  options: { enableReviewPreview?: boolean } = {},
): DatasetSourceRebindPlan {
  const sourceId = candidate?.sourceId ?? candidate?.id;
  if (!candidate || !sourceId) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', error: 'This data is not available in the current governed catalog. Keep the App on its current data and choose compatible data when it is available.' };
  }
  const stored = draft.sources.find((source) => source.id === sourceId);
  const descriptor = candidate.capabilities?.dataset;
  const sourceRevision = candidate.sourceRevision?.trim();
  const contractFingerprint = descriptor?.contractRef.fingerprint?.trim();
  if (!stored || !descriptor || !sourceRevision || !contractFingerprint
    || descriptor.sourceRevision !== sourceRevision
    || descriptor.binding.sourceRevision !== sourceRevision
    || descriptor.binding.contractFingerprint !== contractFingerprint) {
    return {
      ok: false,
      code: 'SOURCE_INCOMPATIBLE',
      error: `${candidate.name || sourceId} does not expose one complete current data version and contract. Keep the App on its current data and choose compatible data.`,
    };
  }
  const references = referencedPages(draft, sourceId);
  if (references.length === 0) {
    return { ok: false, code: 'NO_APP_BINDING', error: 'This data is not used by a field-based tile in this App.' };
  }
  const reviewRequired = candidate.lifecycle !== 'certified' || candidate.trust !== 'certified';
  if (reviewRequired && draft.sourcePolicy !== 'include_review_required' && !options.enableReviewPreview) {
    return {
      ok: false,
      code: 'REVIEW_POLICY_REQUIRED',
      error: `${candidate.name || sourceId} is review-required. Enable local review preview explicitly before refreshing this data; it will remain blocked from Project publication.`,
    };
  }
  if (!candidate.eligibility?.localPreview && !reviewRequired) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', error: `${candidate.name || sourceId} is not currently eligible for local preview. Check its governed source state before refreshing this App.` };
  }

  const pages: DatasetPage[] = [];
  for (const page of references) {
    const validationError = validateRebindPage(page, sourceId, descriptor);
    if (validationError) return { ok: false, code: 'SOURCE_INCOMPATIBLE', error: validationError };
    pages.push(reboundPage(page, sourceId, candidate, descriptor));
  }
  const operations: AppStudioDraftOperation[] = [];
  if (reviewRequired && draft.sourcePolicy !== 'include_review_required') {
    operations.push({ type: 'set_source_policy', sourcePolicy: 'include_review_required' });
  }
  // The API discards this historic object and re-resolves `sourceId` from the
  // active catalog. Sending no browser-generated descriptor keeps all three
  // authority checks on the server.
  operations.push({ type: 'upsert_source', source: stored });
  operations.push(...pages.map((page) => ({ type: 'upsert_page' as const, page })));
  if (reviewRequired) {
    for (const page of pages) {
      for (const tile of page.layout.items) {
        if (!tile.query || tile.sourceId !== sourceId || hasOpenSourceTileTask(draft, sourceId, page.id, tile.i)) continue;
        operations.push({
          type: 'set_review_task',
          task: {
            id: `dataset-source-rebind:${encodeURIComponent(sourceId)}:${page.id}:${tile.i}`,
            message: `${candidate.name || sourceId} is review-required after this source change. Preview locally if policy permits; certify, replace, or remove it before Project publication.`,
            status: 'open',
            sourceId,
            pageId: page.id,
            tileId: tile.i,
          },
        });
      }
    }
  }
  return { ok: true, sourceId, requiresReviewPolicy: reviewRequired, operations };
}

/**
 * Resolve immediately before each mutation so a proposal accepted before a
 * reload has the same safe rebind path as one accepted seconds ago. Empty or
 * incompatible results never create a PATCH.
 */
export async function runDatasetSourceRebindAction(input: {
  draft: AppStudioBuildDraft;
  sourceId: string;
  enableReviewPreview?: boolean;
  resolveCandidates: (draftId: string, sourceIds: string[], options?: { includeReviewRequired?: boolean }) => Promise<{
    items: AppBlockRecommendation[];
    missingSourceIds: string[];
  }>;
  patchDraft: (
    draftId: string,
    expectedRevision: number,
    operations: AppStudioDraftOperation[],
    expectedProposalHash?: string,
  ) => Promise<{ draft: AppStudioBuildDraft }>;
  onPreviewInvalidated?: () => void;
}): Promise<DatasetSourceRebindActionResult> {
  const resolved = await input.resolveCandidates(input.draft.id, [input.sourceId], { includeReviewRequired: true });
  const candidate = resolved.items.find((item) => (item.sourceId ?? item.id) === input.sourceId);
  const plan = planDatasetSourceRebind(input.draft, candidate, { enableReviewPreview: input.enableReviewPreview });
  if (!plan.ok) return plan;
  const result = await input.patchDraft(
    input.draft.id,
    input.draft.revision,
    plan.operations,
    input.draft.proposalHash,
  );
  input.onPreviewInvalidated?.();
  return { ok: true, draft: result.draft, plan };
}

function referencedPages(draft: AppStudioBuildDraft, sourceId: string): DatasetPage[] {
  return draft.pages.filter((page) => page.layout.items.some((tile) => tile.query && tile.sourceId === sourceId)
    || page.datasets?.some((binding) => binding.sourceId === sourceId));
}

function validateRebindPage(page: DatasetPage, sourceId: string, descriptor: DatasetDescriptor): string | undefined {
  const bindings = page.datasets?.filter((binding) => binding.sourceId === sourceId) ?? [];
  if (bindings.length === 0) return `Page ${page.metadata.title} has a tile for ${sourceId} that is not linked to this data.`;
  const bindingIds = new Set(bindings.map((binding) => binding.id));
  const physical = (field: string) => {
    const resolved = datasetPhysicalField(descriptor, field);
    return resolved?.status === 'approved' ? resolved : undefined;
  };
  for (const tile of page.layout.items) {
    if (!tile.query || tile.sourceId !== sourceId) continue;
    const bound = bindings.some((binding) => binding.sourceRevision === tile.sourceRevision);
    if (!bound) return `${tile.title || `${page.id}/${tile.i}`} is not linked to this data on this page.`;
    const validation = validateTileQuery(descriptor, tile.query);
    if (validation.outcome === 'rejected') {
      return `${tile.title || `${page.id}/${tile.i}`} cannot be refreshed because its selected fields are no longer covered: ${validation.diagnostics.map((diagnostic) => diagnostic.message).join(' ')}`;
    }
    const visualization = datasetTileVisualizationCompatibility(tile.query, tile.viz.type);
    if (!visualization.compatible) return `${tile.title || `${page.id}/${tile.i}`} cannot be refreshed: ${visualization.message}`;
  }
  for (const filter of page.filters ?? []) {
    for (const [bindingId, target] of Object.entries(filter.datasetBindings ?? {})) {
      if (!bindingIds.has(bindingId)) continue;
      if (!physical(target.field)) return `Filter ${filter.label ?? filter.id} targets ${target.field}, which is not an approved physical field in the current data.`;
    }
  }
  for (const mapping of page.interactions?.crossFilter?.mappings ?? []) {
    if (bindingIds.has(mapping.toDataset) && !physical(mapping.toField)) {
      return `Cross-filter ${mapping.fromTileId} → ${mapping.toDataset} targets ${mapping.toField}, which is not an approved physical field in the current data.`;
    }
    const fromTile = page.layout.items.find((tile) => tile.i === mapping.fromTileId);
    if (fromTile?.query && fromTile.sourceId === sourceId) {
      const validOutput = tileQueryOutputAliases(fromTile.query).some((output) => output.kind === 'dimension'
        && output.alias.toLowerCase() === mapping.fromField.toLowerCase());
      if (!validOutput) return `Cross-filter ${mapping.fromTileId} no longer emits the mapped dimension ${mapping.fromField}.`;
    }
  }
  const detail = page.interactions?.detail;
  if (detail && bindingIds.has(detail.dataset)) {
    const invalid = detail.columns.find((column) => !physical(column));
    if (invalid) return `Detail navigation targets ${invalid}, which is not an approved physical field in the current data.`;
  }
  return undefined;
}

function reboundPage(
  page: DatasetPage,
  sourceId: string,
  candidate: AppBlockRecommendation,
  descriptor: DatasetDescriptor,
): DatasetPage {
  const certified = candidate.trust === 'certified' && candidate.lifecycle === 'certified';
  const sourceRevision = candidate.sourceRevision!;
  return {
    ...page,
    datasets: page.datasets?.map((binding) => binding.sourceId === sourceId ? {
      ...binding,
      sourceRevision,
      snapshotId: candidate.snapshotId ?? descriptor.snapshotId,
      contractFingerprint: descriptor.contractRef.fingerprint,
    } : binding),
    layout: {
      ...page.layout,
      items: page.layout.items.map((tile) => !tile.query || tile.sourceId !== sourceId ? tile : {
        ...tile,
        sourceRevision,
        sourceClass: candidate.capabilities?.dataset?.kind === 'semantic'
          ? 'governed_semantic'
          : certified ? 'certified_block' : 'exploratory_analysis',
        trustState: certified ? 'certified' : 'review_required',
        reviewStatus: certified ? 'certified' : 'review_required',
        review: { status: certified ? 'not_required' : 'required', sourceFingerprint: sourceRevision },
      }),
    },
  };
}

function hasOpenSourceTileTask(draft: AppStudioBuildDraft, sourceId: string, pageId: string, tileId: string): boolean {
  return draft.reviewTasks.some((task) => task.status === 'open'
    && task.sourceId === sourceId
    && task.pageId === pageId
    && task.tileId === tileId);
}
