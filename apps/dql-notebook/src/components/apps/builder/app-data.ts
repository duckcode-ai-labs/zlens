import type {
  AppBlockRecommendation,
  AppStudioBuildDraft,
  AppStudioDraftOperation,
} from '../../../api/client';
import type { DatasetDescriptor, DatasetJoin } from '@zlens/core/datasets/descriptor';
import { datasetPhysicalField } from '@zlens/core/datasets/descriptor';
import { tileQueryValidationRuns, validateTileQuery, type TileQuery } from '@zlens/core/apps/tile-query';
import { appSourceIdsUsedByTiles, appSourcesNotUsedByTiles } from '@zlens/core/apps/app-data-sources';
import { NOT_CERTIFIED_YET, certifiedByLabel, certifiedDateLabel, certifierDisplayName, checkedNotCertifiedDetail } from '@zlens/core/apps/reader-trust';

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

/** Said once, where Domain first appears (the Start form; a tooltip in Add data). */
export const DOMAIN_EXPLANATION = 'A Domain groups data by business area, like Sales or Finance.';

export const TABLE_BECOMES_DATASET_HINT = 'ZLens checks a table once before Apps use it. Certify it when you are ready; until then readers see “Not certified yet” on its tiles.';

/**
 * Data ZLens checked that nobody certified yet (design Q1) reads like any
 * other data nobody certified (T1): "Not certified yet". That it was checked
 * is detail, in the row's tooltip and receipt ("Checked by you, not certified yet").
 */
export const CHECKED_NEEDS_CERTIFYING = NOT_CERTIFIED_YET;

/** What "Make row-level" is for, next to the action (design D1). */
export const MAKE_ROW_LEVEL_HINT = 'Only needed for row-safe measures, like distinct counts or averages over rows. ZLens checks what one row is; the saved query is not certified again until someone certifies it.';

/** How a saved query's result fields add up, under its fields (design D1). */
export const SAVED_QUERY_FIELDS_NOTE = 'Fields from its result. Grouped by its own columns, values show as they are; rolled up, numbers add up (Sum). Averages and rates are never added up.';

// ── One glossary (docs/apps/index.md "Words used in App Studio") ─────────────

/** A checked table has fields, Metrics come from a semantic model, a saved query is a plain block. Files and the API call a checked table a Dataset. */
export function sourceCatalogKindLabel(source: Pick<AppBlockRecommendation, 'capabilities' | 'kind'>): 'Table' | 'Metrics' | 'Saved query' {
  if (source.capabilities?.dataset?.kind === 'semantic') return 'Metrics';
  // Fields read from a saved query's result keep it a saved query (design D1).
  if (source.capabilities?.dataset?.result) return 'Saved query';
  if (source.capabilities?.dataset) return 'Table';
  if (source.capabilities?.semanticModelId || source.kind === 'semantic') return 'Metrics';
  return 'Saved query';
}

/** Source type in the App glossary; rows append the trust words (Certified or Not certified yet). */
export function sourceKindLabel(
  kind: DraftSource['kind'],
  capabilities?: DraftSource['capabilities'],
): string {
  if (kind === 'text') return 'Page content';
  if (kind === 'review_dql') return 'Draft DQL';
  if (kind === 'exploratory_sql') return 'Draft SQL';
  if (kind === 'governed_semantic' || kind === 'semantic_query') return 'Metrics';
  if (capabilities?.dataset?.kind === 'semantic' || capabilities?.semanticModelId) return 'Metrics';
  if (capabilities?.dataset && !capabilities.dataset.result) return 'Table';
  return 'Saved query';
}

/**
 * Where an item came from, as the one Add data list labels it (design D1):
 * a database table (a Dataset made from one, or a table not checked yet), a
 * saved query (a block, with fields from its result or made row-level), or
 * Metrics from a semantic model.
 */
export function sourceOriginLabel(source: Pick<AppBlockRecommendation, 'capabilities' | 'kind'> & { tags?: string[] }): 'Table' | 'Saved query' | 'Metrics' {
  if (sourceCatalogKindLabel(source) === 'Metrics') return 'Metrics';
  if (source.capabilities?.dataset && !source.capabilities.dataset.result && (source.tags ?? []).includes('from-table')) return 'Table';
  return 'Saved query';
}

/** A saved query (a block) whose result columns ZLens has not read yet. */
export function savedQueryNeedsFields(source: Pick<AppBlockRecommendation, 'capabilities' | 'kind'>): boolean {
  return sourceCatalogKindLabel(source) === 'Saved query' && !source.capabilities?.dataset && source.kind !== 'semantic';
}

/** A saved query that "Make row-level" applies to: no row-level Dataset definition yet. */
export function canMakeRowLevel(source: Pick<AppBlockRecommendation, 'capabilities' | 'kind'>): boolean {
  return sourceCatalogKindLabel(source) === 'Saved query' && source.kind !== 'semantic';
}

/** Visible trust uses two words only (T1): Certified or Not certified yet. */
export function trustLabel(trust: string | undefined): 'Certified' | 'Not certified yet' {
  return trust === 'certified' ? 'Certified' : NOT_CERTIFIED_YET;
}

// ── The Add data browser ─────────────────────────────────────────────────────

/** The filter chips over the one Add data list (design D1). */
export type AddDataKind = 'all' | 'tables' | 'queries' | 'metrics';

export const ADD_DATA_KINDS: ReadonlyArray<[AddDataKind, string]> = [
  ['all', 'All'], ['tables', 'Tables'], ['queries', 'Saved queries'], ['metrics', 'Metrics'],
];

/** The chip a catalog item belongs to. Database tables not checked yet are always `tables`. */
export function addDataKindOf(item: Pick<AppBlockRecommendation, 'capabilities' | 'kind'> & { tags?: string[] }): Exclude<AddDataKind, 'all'> {
  const origin = sourceOriginLabel(item);
  return origin === 'Metrics' ? 'metrics' : origin === 'Table' ? 'tables' : 'queries';
}

/**
 * The catalog items one chip shows, certified first (T3): data nobody
 * certified is still listed and addable, after the certified data, in the
 * catalog's order within each group.
 */
export function filterAddDataCatalog(items: AppBlockRecommendation[], kind: AddDataKind): AppBlockRecommendation[] {
  const shown = kind === 'all' ? items : items.filter((item) => addDataKindOf(item) === kind);
  return shown
    .map((item, index) => ({ item, index, rank: needsReview(item) ? 1 : 0 }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.item);
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

/**
 * Checked, not certified yet (design Q1): ZLens checked it ("Check and use")
 * and nobody certified it yet. It reads "Not certified yet" like other data
 * nobody certified; being checked is detail in its tooltip and receipt.
 */
export function isCheckedNeedsCertifying(item: Pick<AppBlockRecommendation, 'trust' | 'status' | 'lifecycle' | 'check'>): boolean {
  return needsReview(item) && Boolean(item.check);
}

/** "Checked by you · 22 Oct", "Checked by Maria · 22 Oct". */
export function checkedByLabel(check: AppBlockRecommendation['check'], now: Date = new Date()): string {
  const who = check?.byYou ? 'you' : certifierDisplayName(check?.by, check?.name);
  const when = certifiedDateLabel(check?.at, now);
  return [who ? `Checked by ${who}` : 'Checked', when].filter(Boolean).join(' · ');
}

/** The one trust phrase a Data row shows (T1): "Certified by <name> · <date>" or "Not certified yet". */
export function dataTrustLabel(item: Pick<AppBlockRecommendation, 'trust' | 'status' | 'lifecycle' | 'check' | 'certification'>): string {
  if (!needsReview(item)) return certifiedByLabel(item.certification);
  return NOT_CERTIFIED_YET;
}

/**
 * The detail behind "Not certified yet", for a tooltip or receipt: "Checked by
 * you, not certified yet", "Changed since it was certified on 22 Oct", or
 * "Nobody has certified it yet". Undefined for certified data.
 */
export function dataTrustDetail(item: Pick<AppBlockRecommendation, 'trust' | 'status' | 'lifecycle' | 'check' | 'certification'>, now: Date = new Date()): string | undefined {
  if (!needsReview(item)) return undefined;
  if (isCheckedNeedsCertifying(item)) return checkedNotCertifiedDetail(item.check);
  const changed = certifiedDateLabel(item.certification?.at, now);
  return changed ? `Changed since it was certified on ${changed}.` : 'Nobody has certified it yet.';
}

/**
 * Data "I vouch for this — certify" applies to (design Q1, T4): a row-level
 * Dataset (from a table, or a saved query made row-level) or a saved query
 * nobody certified yet. Metrics are certified in the semantic model.
 */
export function canCertifyAppData(item: Pick<AppBlockRecommendation, 'trust' | 'status' | 'lifecycle' | 'capabilities' | 'kind'>): boolean {
  const dataset = item.capabilities?.dataset;
  return needsReview(item)
    && item.lifecycle !== 'deprecated'
    && item.kind !== 'semantic'
    && dataset?.kind !== 'semantic';
}

/** The joins of a Dataset nobody certified yet: each one certifies from the Data list's ⋯ menu (T4). */
export function joinsToCertify(item: Pick<AppBlockRecommendation, 'capabilities'> | null | undefined): DatasetJoin[] {
  const joins = (item?.capabilities?.dataset as { joins?: DatasetJoin[] } | undefined)?.joins ?? [];
  return joins.filter((join) => join.trust !== 'certified');
}

/**
 * @deprecated There is no per-App data rule (T3): data nobody certified is
 * added like any other, with no extra step. Always false.
 */
export function addNeedsReviewChoice(_item: AppBlockRecommendation, _sourcePolicy?: AppStudioBuildDraft['sourcePolicy']): boolean {
  return false;
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
    ...(isCheckedNeedsCertifying(candidate) ? { checked: true } : {}),
  };
}

export type AddDataPlan =
  | { ok: true; operations: AppStudioDraftOperation[] }
  | { ok: false; code: 'SOURCE_UNAVAILABLE'; error: string };

/**
 * Connect one source to the App with the existing `upsert_source` operation.
 * Certified or not, data is added the same way (T3): there is no per-App
 * data rule, and tiles on data nobody certified read "Not certified yet".
 * `draft` and `options` are kept for older callers and ignored.
 */
export function planAddDataSource(
  _draft: Partial<Pick<AppStudioBuildDraft, 'sourcePolicy'>>,
  candidate: AppBlockRecommendation | undefined,
  _options: { allowReview?: boolean } = {},
): AddDataPlan {
  if (!candidate) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', error: 'This data is no longer in the project catalog. Refresh the list and choose it again.' };
  }
  return { ok: true, operations: [{ type: 'upsert_source', source: appDataSourceFromCandidate(candidate) }] };
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
    ...(source.checked && source.trustState !== 'certified' ? { check: {} } : {}),
    score: 0,
    reasons: [],
  });
}

export function openCanvasLabel(count: number): string {
  if (count === 0) return 'Open blank Studio';
  return `Open Studio with ${count} ${count === 1 ? 'source' : 'sources'}`;
}

/** `quick`: the three quick choices after the Data step, for a new App with no AI provider (round-2 Q2). */
export type StudioStage = 'data' | 'quick' | 'canvas';

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
