import type { AppBlockRecommendation, AppStudioAiProposal, AppStudioBuildDraft, AppStudioDraftOperation } from '../../api/client';

export interface AppStudioAiPlanSummary {
  frame?: AppStudioBuildDraft['frame'];
  pages: Array<{ id: string; title: string }>;
  components: Array<{ id: string; title: string; visualization: string; source: string; sourceId?: string; rationale?: string }>;
  sources: Array<{
    id: string;
    label: string;
    sourceRef: string;
    kind: AppStudioBuildDraft['sources'][number]['kind'];
    trustState: AppStudioBuildDraft['sources'][number]['trustState'];
    reviewStatus: AppStudioBuildDraft['sources'][number]['reviewStatus'];
    componentIds: string[];
    /** Source capabilities, so the review can tell a Dataset from a saved query. */
    capabilities?: AppStudioBuildDraft['sources'][number]['capabilities'];
    rationale?: string;
  }>;
}

export type AppStudioProposalSourceAddMode = 'select_existing' | 'enable_review_and_replan' | 'replan';

/**
 * Render only server-issued direct-planner provenance. In particular, never
 * turn a configured provider setting into a claim that the planner ran.
 */
export function appStudioPlannerProvenanceLabel(
  proposal: Pick<AppStudioAiProposal, 'plannerProvenance'>,
): string | undefined {
  const provenance = proposal.plannerProvenance;
  if (!provenance) return undefined;
  if (provenance.mode === 'ai' && provenance.providerInvocation === 'succeeded') {
    return provenance.providerId
      ? `AI planner response · ${provenance.providerId}`
      : 'AI planner response';
  }
  if (provenance.mode === 'deterministic' && provenance.providerInvocation === 'not_attempted') {
    return 'Deterministic planner fallback';
  }
  return undefined;
}

export function appStudioProposalRequiredSourceIds(
  selectedSourceIds: ReadonlySet<string>,
  addedSourceId?: string,
): string[] {
  return Array.from(new Set([...selectedSourceIds, addedSourceId ?? ''].map((sourceId) => sourceId.trim()).filter(Boolean)));
}

export function appStudioProposalRequestSourceIds(
  selectedBlockIds: readonly string[] | undefined,
  fallbackSourceId?: string,
): string[] | undefined {
  const sourceIds = selectedBlockIds === undefined
    ? (fallbackSourceId ? [fallbackSourceId] : undefined)
    : selectedBlockIds;
  if (sourceIds === undefined) return undefined;
  return Array.from(new Set(sourceIds.map((sourceId) => sourceId.trim()).filter(Boolean)));
}

export function appStudioProposalSourceAddMode(input: {
  alreadyProposed: boolean;
  reviewRequired: boolean;
  sourcePolicy: AppStudioBuildDraft['sourcePolicy'];
}): AppStudioProposalSourceAddMode {
  if (input.reviewRequired && input.sourcePolicy === 'governed_only') return 'enable_review_and_replan';
  return input.alreadyProposed ? 'select_existing' : 'replan';
}

/** The exact, reviewable wiring an AI proposal will apply to the local draft. */
export function summarizeAppStudioAiPlan(proposal: AppStudioAiProposal): AppStudioAiPlanSummary {
  let frame: AppStudioBuildDraft['frame'] | undefined;
  const pages = new Map<string, { id: string; title: string }>();
  const components = new Map<string, AppStudioAiPlanSummary['components'][number]>();
  const sources = new Map<string, AppStudioAiPlanSummary['sources'][number]>();
  const sourceOperations = proposal.operations
    .filter((operation): operation is Extract<AppStudioDraftOperation, { type: 'upsert_source' }> => operation.type === 'upsert_source')
    .map((operation) => operation.source);
  const addTile = (tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]) => {
    const blockRef = tile.block
      ? ('blockId' in tile.block ? tile.block.blockId : tile.block.ref)
      : undefined;
    const semanticRef = tile.semantic?.qualifiedMetricIds?.join(', ') || tile.semantic?.id;
    const draftRef = tile.draftAnalysis?.ref;
    const sourceId = sourceIdForTile(tile, sourceOperations);
    const rationale = tile.display?.rationale || tile.sourceEvidence?.map((evidence) => evidence.reason).filter(Boolean).join(' ');
    components.set(tile.i, {
      id: tile.i,
      title: tile.title || businessLabel(tile.i),
      visualization: businessLabel(tile.viz.type),
      source: blockRef || semanticRef || draftRef || (tile.text ? 'Page content' : 'Governed source'),
      ...(sourceId ? { sourceId } : {}),
      ...(rationale ? { rationale } : {}),
    });
  };
  for (const operation of proposal.operations) {
    if (operation.type === 'set_frame') {
      frame = operation.frame;
    } else if (operation.type === 'upsert_source') {
      sources.set(operation.source.id, {
        id: operation.source.id,
        label: businessLabel(operation.source.qualifiedIdentity || operation.source.sourceRef),
        sourceRef: operation.source.sourceRef,
        kind: operation.source.kind,
        trustState: operation.source.trustState,
        reviewStatus: operation.source.reviewStatus,
        componentIds: [],
        ...(operation.source.capabilities ? { capabilities: operation.source.capabilities } : {}),
      });
    } else if (operation.type === 'upsert_page') {
      pages.set(operation.page.id, { id: operation.page.id, title: operation.page.metadata.title });
      operation.page.layout.items.forEach(addTile);
    } else if (operation.type === 'add_tile') {
      addTile(operation.tile);
    }
  }
  for (const component of components.values()) {
    if (!component.sourceId) continue;
    const source = sources.get(component.sourceId);
    source?.componentIds.push(component.id);
    if (source && !source.rationale && component.rationale) source.rationale = component.rationale;
  }
  return { frame, pages: Array.from(pages.values()), components: Array.from(components.values()), sources: Array.from(sources.values()) };
}

/** Keep the proposal typed and reviewable while allowing users to exclude data sources before apply. */
export function operationsForSelectedAppStudioSources(
  proposal: AppStudioAiProposal,
  selectedSourceIds: ReadonlySet<string>,
): AppStudioDraftOperation[] {
  const proposedSources = proposal.operations
    .filter((operation): operation is Extract<AppStudioDraftOperation, { type: 'upsert_source' }> => operation.type === 'upsert_source')
    .map((operation) => operation.source);
  // Only tiles the proposal adds can be left out by source selection, the
  // same rule the server applies: an add-mode proposal carries the page's
  // existing tiles, and those must never show as "will be removed". Proposals
  // without `proposedTileIds` rebuilt the whole page.
  const proposedTileIds = proposal.proposedTileIds ? new Set(proposal.proposedTileIds) : undefined;
  const keepTile = (tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number]) => {
    if (proposedTileIds && !proposedTileIds.has(tile.i)) return true;
    const sourceId = sourceIdForTile(tile, proposedSources);
    return !sourceId || selectedSourceIds.has(sourceId);
  };
  const keptComponentIds = new Set<string>();
  for (const operation of proposal.operations) {
    if (operation.type === 'upsert_page') {
      operation.page.layout.items.filter(keepTile).forEach((tile) => keptComponentIds.add(tile.i));
    } else if (operation.type === 'add_tile' && keepTile(operation.tile)) {
      keptComponentIds.add(operation.tile.i);
    }
  }
  const filterCoverage = (coverage: AppStudioBuildDraft['coverage']) => coverage.map((item) => {
    const sourceIds = item.sourceIds.filter((id) => selectedSourceIds.has(id));
    const componentIds = item.componentIds.filter((id) => keptComponentIds.has(id));
    if (sourceIds.length || componentIds.length) return { ...item, sourceIds, componentIds };
    return {
      ...item,
      status: 'gap' as const,
      sourceIds,
      componentIds,
      reasons: Array.from(new Set([...item.reasons, 'The proposed source was excluded during App review.'])),
    };
  });
  return proposal.operations.flatMap((operation): AppStudioDraftOperation[] => {
    if (operation.type === 'upsert_source') return selectedSourceIds.has(operation.source.id) ? [operation] : [];
    if (operation.type === 'upsert_page') {
      const items = operation.page.layout.items.filter(keepTile);
      const dropped = operation.page.layout.items.filter((tile) => !keepTile(tile));
      // A filter goes only when every tile bound to it was left out; filters
      // bound to kept tiles, or to no tile, stay.
      const bound = (filterId: string, tiles: typeof items) => tiles.some((tile) => tile.filterBindings?.some((binding) => binding.filter === filterId));
      const filters = operation.page.filters?.filter((filter) => bound(filter.id, items) || !bound(filter.id, dropped));
      const responsive = operation.page.layout.responsive
        ? Object.fromEntries(Object.entries(operation.page.layout.responsive).map(([breakpoint, layout]) => [breakpoint, layout ? { ...layout, items: layout.items.filter(keepTile) } : layout])) as typeof operation.page.layout.responsive
        : undefined;
      return [{
        ...operation,
        page: {
          ...operation.page,
          ...(operation.page.filters ? { filters: filters ?? [] } : {}),
          layout: { ...operation.page.layout, items, ...(responsive ? { responsive } : {}) },
        },
      }];
    }
    if (operation.type === 'add_tile') return keepTile(operation.tile) ? [operation] : [];
    if (operation.type === 'set_requirements') {
      return [{ ...operation, ...(operation.coverage ? { coverage: filterCoverage(operation.coverage) } : {}) }];
    }
    if (operation.type === 'set_coverage') return [{ ...operation, coverage: filterCoverage(operation.coverage) }];
    if (operation.type === 'set_review_task') {
      if (operation.task.sourceId && !selectedSourceIds.has(operation.task.sourceId)) return [];
      if (operation.task.tileId && !keptComponentIds.has(operation.task.tileId)) return [];
    }
    return [operation];
  });
}

/** Keep source discovery inside the proposal gate and avoid showing duplicate proposed blocks. */
export function availableAppStudioProposalSources(
  summary: AppStudioAiPlanSummary,
  catalog: AppBlockRecommendation[],
  query: string,
): AppBlockRecommendation[] {
  const proposedReferences = new Set(summary.sources.flatMap((source) => [source.sourceRef, source.label])
    .map((value) => normalizeSourceReference(value)));
  const needle = query.trim().toLowerCase();
  return catalog.filter((source) => {
    if ([source.id, source.name, source.path].some((value) => proposedReferences.has(normalizeSourceReference(value)))) return false;
    if (!needle) return true;
    return [source.name, source.domain, source.description, source.owner ?? '', ...source.tags]
      .join(' ')
      .toLowerCase()
      .includes(needle);
  });
}

function sourceIdForTile(
  tile: AppStudioBuildDraft['pages'][number]['layout']['items'][number],
  sources: AppStudioBuildDraft['sources'],
): string | undefined {
  if (tile.sourceId) return tile.sourceId;
  if (tile.block) {
    const blockRef = 'blockId' in tile.block ? tile.block.blockId : tile.block.ref;
    return sources.find((source) => ['block', 'certified_block', 'review_block'].includes(source.kind) && source.sourceRef === blockRef)?.id
      ?? `block:${blockRef}`;
  }
  if (tile.semantic) {
    return sources.find((source) => ['governed_semantic', 'semantic_query'].includes(source.kind) && source.sourceRef === tile.semantic?.id)?.id
      ?? `semantic:${tile.semantic.id}`;
  }
  if (tile.draftAnalysis) {
    return sources.find((source) => ['review_block', 'review_dql', 'exploratory_sql'].includes(source.kind) && source.sourceRef === tile.draftAnalysis?.ref)?.id;
  }
  return undefined;
}

function businessLabel(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase()).trim();
}

function normalizeSourceReference(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}
