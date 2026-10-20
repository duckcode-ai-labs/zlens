import type {
  AppBlockRecommendation,
  AppStudioBuildDraft,
  AppStudioDraftOperation,
} from '../../../api/client';
import type { DatasetDescriptor } from '@zlens/core/datasets/descriptor';
import { datasetPhysicalField } from '@zlens/core/datasets/descriptor';
import { tileQueryValidationRuns, validateTileQuery, type TileQuery } from '@zlens/core/apps/tile-query';
import { appSourceIdsUsedByTiles, appSourcesNotUsedByTiles } from '@zlens/core/apps/app-data-sources';

/**
 * The App's data (design D1, D3, D4): one list of data sources per App, kept
 * as the draft's `sources`. These helpers are shared by the Data step, the
 * **+ Add data** browser and the canvas Data pane, so all three use the same
 * words and the same draft operations.
 */

type DraftSource = AppStudioBuildDraft['sources'][number];
type DraftTile = AppStudioBuildDraft['pages'][number]['layout']['items'][number];

/** Shown only when a project sets `apps.datasets: false`; field-based tiles are on by default. */
export const FIELD_TILES_OFF_MESSAGE = 'Field-based tiles are turned off for this project (apps.datasets is false in dql.config.json).';

export const TABLE_BECOMES_DATASET_HINT = 'A table becomes a Dataset after ZLens checks it once.';

export const SAVED_QUERY_NO_FIELDS = 'Saved queries have no fields. Add fields to build tiles by Measures and Dimensions.';

// ── One glossary (docs/apps/index.md "Words used in App Studio") ─────────────

/** A Dataset has fields, Metrics come from a semantic model, a saved query is a plain block. */
export function sourceCatalogKindLabel(source: Pick<AppBlockRecommendation, 'capabilities' | 'kind'>): 'Dataset' | 'Metrics' | 'Saved query' {
  if (source.capabilities?.dataset?.kind === 'semantic') return 'Metrics';
  if (source.capabilities?.dataset) return 'Dataset';
  if (source.capabilities?.semanticModelId || source.kind === 'semantic') return 'Metrics';
  return 'Saved query';
}

/** Source type in the App glossary; rows append the trust word (Certified or Needs review). */
export function sourceKindLabel(
  kind: DraftSource['kind'],
  capabilities?: DraftSource['capabilities'],
): string {
  if (kind === 'text') return 'Page content';
  if (kind === 'review_dql') return 'Draft DQL';
  if (kind === 'exploratory_sql') return 'Draft SQL';
  if (kind === 'governed_semantic' || kind === 'semantic_query') return 'Metrics';
  if (capabilities?.dataset?.kind === 'semantic' || capabilities?.semanticModelId) return 'Metrics';
  if (capabilities?.dataset) return 'Dataset';
  return 'Saved query';
}

/** Visible trust uses two words only. */
export function trustLabel(trust: string | undefined): 'Certified' | 'Needs review' {
  return trust === 'certified' ? 'Certified' : 'Needs review';
}

// ── The Add data browser ─────────────────────────────────────────────────────

export type AddDataTab = 'datasets' | 'queries' | 'tables';

/** Datasets and Metrics have fields; a saved query is a block without them. */
export function addDataTabFor(item: Pick<AppBlockRecommendation, 'capabilities' | 'kind'>): 'datasets' | 'queries' {
  return sourceCatalogKindLabel(item) === 'Saved query' ? 'queries' : 'datasets';
}

/** Split one trust-ordered catalog page into the two source tabs, keeping its order. */
export function splitAddDataCatalog(items: AppBlockRecommendation[]): { datasets: AppBlockRecommendation[]; queries: AppBlockRecommendation[] } {
  const datasets: AppBlockRecommendation[] = [];
  const queries: AppBlockRecommendation[] = [];
  for (const item of items) (addDataTabFor(item) === 'datasets' ? datasets : queries).push(item);
  return { datasets, queries };
}

/** The catalog request for one search and domain chip. "All domains" sends no domain. */
export function addDataCatalogRequest(input: { query: string; domain: string; cursor?: string }): {
  query: string;
  limit: number;
  domains?: string[];
  cursor?: string;
} {
  const domain = input.domain.trim();
  return {
    query: input.query.trim(),
    limit: 100,
    ...(domain ? { domains: [domain] } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}

export interface DomainChip { value: string; label: string }

/**
 * Domain chips: the project's domains (from the Domains page), then any other
 * domain the catalog uses, and always the App's own domain.
 */
export function addDataDomainChips(
  projectDomains: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>,
  catalogDomains: Record<string, number> = {},
  appDomain?: string,
): DomainChip[] {
  const chips: DomainChip[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string) => {
    const clean = value.trim();
    if (!clean || seen.has(clean.toLowerCase())) return;
    seen.add(clean.toLowerCase());
    chips.push({ value: clean, label });
  };
  for (const option of projectDomains) if (!option.disabled) add(option.value, option.label);
  if (appDomain) add(appDomain, appDomain);
  for (const domain of Object.keys(catalogDomains).sort((left, right) => left.localeCompare(right))) {
    if (domain === 'Unassigned' || domain.toLowerCase() === 'general') continue;
    add(domain, domain);
  }
  return chips;
}

/** Catalog data nobody has certified yet. */
export function needsReview(item: Pick<AppBlockRecommendation, 'trust' | 'status' | 'lifecycle'>): boolean {
  const trust = item.trust ?? (item.status === 'certified' ? 'certified' : 'review_required');
  return trust !== 'certified' || (item.lifecycle !== undefined && item.lifecycle !== 'certified');
}

/** Needs review while the App allows only certified data: adding it also changes the data rule. */
export function addNeedsReviewChoice(item: AppBlockRecommendation, sourcePolicy: AppStudioBuildDraft['sourcePolicy']): boolean {
  return sourcePolicy === 'governed_only' && needsReview(item);
}

export function isAddedToApp(sources: readonly DraftSource[], item: Pick<AppBlockRecommendation, 'id' | 'sourceId'>): boolean {
  const sourceId = item.sourceId ?? item.id;
  return sources.some((source) => source.id === sourceId);
}

/**
 * The draft source for a current catalog record, built exactly as the App API
 * does when a tile is composed (`appDraftSourceFromCatalog`). For a Dataset the
 * API replaces it with its own server-resolved card on save.
 */
export function appDataSourceFromCandidate(candidate: AppBlockRecommendation): DraftSource {
  const certified = !needsReview(candidate);
  const semantic = candidate.kind === 'semantic'
    || candidate.capabilities?.dataset?.kind === 'semantic'
    || (candidate.kind === undefined && Boolean(candidate.capabilities?.semanticModelId));
  const revision = candidate.sourceRevision ?? candidate.fingerprint;
  return {
    id: candidate.sourceId ?? candidate.id,
    kind: semantic ? 'governed_semantic' : 'block',
    sourceRef: candidate.path,
    ...(candidate.qualifiedIdentity ? { qualifiedIdentity: candidate.qualifiedIdentity } : {}),
    sourcePath: candidate.sourcePath ?? candidate.path,
    executionRef: candidate.path,
    ...(candidate.snapshotId ? { snapshotId: candidate.snapshotId } : {}),
    ...(revision ? { sourceRevision: revision, sourceFingerprint: revision } : {}),
    ...(candidate.lifecycle ? { lifecycle: candidate.lifecycle } : {}),
    ...(candidate.capabilities ? { capabilities: candidate.capabilities } : {}),
    trustState: certified ? 'certified' : 'review_required',
    reviewStatus: certified ? 'not_required' : 'required',
  };
}

export type AddDataPlan =
  | { ok: true; operations: AppStudioDraftOperation[] }
  | { ok: false; code: 'SOURCE_UNAVAILABLE' | 'REVIEW_POLICY_REQUIRED'; error: string };

/**
 * Connect one source to the App with the existing `upsert_source` operation.
 * Data that needs review is added only with an explicit choice, which also
 * switches the data rule in the same saved change.
 */
export function planAddDataSource(
  draft: Pick<AppStudioBuildDraft, 'sourcePolicy'>,
  candidate: AppBlockRecommendation | undefined,
  options: { allowReview?: boolean } = {},
): AddDataPlan {
  if (!candidate) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', error: 'This data is no longer in the project catalog. Refresh the list and choose it again.' };
  }
  const operations: AppStudioDraftOperation[] = [];
  if (addNeedsReviewChoice(candidate, draft.sourcePolicy)) {
    if (!options.allowReview) {
      return { ok: false, code: 'REVIEW_POLICY_REQUIRED', error: `${candidate.name} needs review. Allow data that needs review to add it.` };
    }
    operations.push({ type: 'set_source_policy', sourcePolicy: 'include_review_required' });
  }
  operations.push({ type: 'upsert_source', source: appDataSourceFromCandidate(candidate) });
  return { ok: true, operations };
}

function tileUsesSource(tile: DraftTile, source: DraftSource): boolean {
  return appSourceIdsUsedByTiles({ sources: [source], pages: [{ layout: { items: [tile] } }] }).has(source.id);
}

/** The tiles that use one App data source, on every page. */
export function tilesUsingSource(draft: Pick<AppStudioBuildDraft, 'sources' | 'pages'>, sourceId: string): Array<{ pageId: string; tileId: string; title: string }> {
  const source = draft.sources.find((candidate) => candidate.id === sourceId);
  if (!source) return [];
  return draft.pages.flatMap((page) => page.layout.items
    .filter((tile) => tileUsesSource(tile, source))
    .map((tile) => ({ pageId: page.id, tileId: tile.i, title: tile.title || tile.i })));
}

/**
 * Remove one source from the App. Tiles that use it go with it (the author
 * confirmed that first), and so do the review tasks that belonged to them.
 */
export function planRemoveDataSource(draft: Pick<AppStudioBuildDraft, 'sources' | 'pages' | 'reviewTasks'>, sourceId: string): AppStudioDraftOperation[] {
  const tiles = tilesUsingSource(draft, sourceId);
  const tileIds = new Set(tiles.map((tile) => tile.tileId));
  return [
    ...tiles.map((tile): AppStudioDraftOperation => ({ type: 'remove_tile', pageId: tile.pageId, tileId: tile.tileId })),
    { type: 'remove_source', sourceId },
    ...draft.reviewTasks
      .filter((task) => task.sourceId === sourceId || (task.tileId !== undefined && tileIds.has(task.tileId)))
      .map((task): AppStudioDraftOperation => ({ type: 'remove_review_task', taskId: task.id })),
  ];
}

// ── The App's data list ──────────────────────────────────────────────────────

/** The App's data: its sources, without page text. */
export function appDataSources(sources: readonly DraftSource[]): DraftSource[] {
  return sources.filter((source) => source.kind !== 'text');
}

/** Connected sources that no tile uses yet; Publish does not save them. */
export function unusedAppDataSources(draft: Pick<AppStudioBuildDraft, 'sources' | 'pages'>): DraftSource[] {
  return appSourcesNotUsedByTiles(draft);
}

export function unusedSourcesPublishNote(count: number): string | null {
  if (count <= 0) return null;
  return `${count} data ${count === 1 ? 'source' : 'sources'} not used by any tile will not be saved with the App.`;
}

/**
 * One row per App data source, as the Data pane and Data step list it: the
 * current catalog record when one is known, otherwise the card saved on the
 * draft (it carries the same fields and trust).
 */
export function appDataItems(sources: readonly DraftSource[], known: readonly AppBlockRecommendation[]): AppBlockRecommendation[] {
  const byId = new Map<string, AppBlockRecommendation>();
  for (const item of known) {
    const id = item.sourceId ?? item.id;
    if (!byId.has(id)) byId.set(id, item);
  }
  return appDataSources(sources).map((source) => byId.get(source.id) ?? {
    id: source.id,
    sourceId: source.id,
    name: source.capabilities?.dataset?.label || source.qualifiedIdentity || source.sourceRef,
    domain: '',
    status: source.lifecycle ?? (source.trustState === 'certified' ? 'certified' : 'review'),
    trust: source.trustState === 'certified' ? 'certified' as const : 'review_required' as const,
    ...(source.lifecycle ? { lifecycle: source.lifecycle } : {}),
    owner: null,
    tags: [],
    path: source.executionRef ?? source.sourceRef,
    ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
    fingerprint: source.sourceRevision ?? source.sourceFingerprint ?? '',
    ...(source.sourceRevision ? { sourceRevision: source.sourceRevision } : {}),
    ...(source.snapshotId ? { snapshotId: source.snapshotId } : {}),
    ...(source.kind === 'governed_semantic' || source.kind === 'semantic_query' ? { kind: 'semantic' as const } : {}),
    lastModified: '',
    description: '',
    ...(source.capabilities ? { capabilities: source.capabilities, chartType: source.capabilities.chartType } : {}),
    score: 0,
    reasons: [],
  });
}

export function openCanvasLabel(count: number): string {
  if (count === 0) return 'Open canvas';
  return `Open canvas with ${count} ${count === 1 ? 'source' : 'sources'}`;
}

export type StudioStage = 'data' | 'canvas';

/**
 * A new App starts at the Data step: a manual App picks its data there, and an
 * AI App shows the data AI picked before pages are built. Drafts and published
 * Apps opened for edit go to the canvas.
 */
export function initialStudioStage(input: { mode: 'ai' | 'manual'; resumingDraft: boolean; editingPublishedApp: boolean }): StudioStage {
  return !input.resumingDraft && !input.editingPublishedApp ? 'data' : 'canvas';
}

/**
 * Up to ten example rows through the ordinary bounded row-detail Dataset
 * query, when the Dataset allows row detail. Undefined when it does not.
 */
export function datasetSampleQuery(descriptor: DatasetDescriptor | undefined, limit = 10): TileQuery | undefined {
  if (!descriptor || !descriptor.operations.includes('detail')) return undefined;
  const columns = descriptor.fields
    .filter((field) => field.kind === 'physical' && field.status === 'approved')
    .map((field) => field.name)
    .filter((name) => datasetPhysicalField(descriptor, name)?.status === 'approved')
    .slice(0, 8);
  if (!columns.length) return undefined;
  const query: TileQuery = { dimensions: [], measures: [], detail: true, detailColumns: columns, limit };
  try {
    return tileQueryValidationRuns(validateTileQuery(descriptor, query)) ? query : undefined;
  } catch {
    return undefined;
  }
}
