import type { AppStudioBuildDraft, AppStudioDraftOperation, DashboardRunResponse } from '../../api/client';
import { appSourceIdsUsedByTiles } from '@zlens/core/apps/app-data-sources';
import { type AppTileNeedingJoinReview } from '@zlens/core/apps/app-tile-join-trust';
import {
  REQUIRE_CERTIFIED_TO_PUBLISH_CODE,
  appTrustAnswer,
  isTrustReminderTaskId,
  notCertifiedTiles,
  type AppTileTrust,
  type AppTrustAnswer,
  type AppTrustPageLike,
  type AppTrustSourceLike,
} from '@zlens/core/apps/app-trust';
import { removeField } from '@zlens/core/apps/viz-encoding';
import type { DatasetDescriptor, DatasetJoin } from '@zlens/core/datasets/descriptor';
import { sourceKindLabel } from './builder/app-data';

export type AppPublicationStepKind = 'questions' | 'review' | 'preview' | 'sources';

type AppStudioSource = AppStudioBuildDraft['sources'][number];
type AppStudioTile = AppStudioBuildDraft['pages'][number]['layout']['items'][number];

export interface AppPublicationStep {
  id: AppPublicationStepKind;
  title: string;
  detail: string;
  count: number;
}

export type AppPublicationIssueAction = 'sources' | 'refresh_sources' | 'filters' | 'preview' | 'tile_review';

export interface PublicationIssueSummary {
  id: string;
  title: string;
  detail: string;
  action: AppPublicationIssueAction;
  /** The server's own words, ids and all: shown only under Technical details. */
  technical?: string;
}

/** A tile the server named, as `page/tile` or `Dataset tile <tile>`, or a source as `Source <id>`. */
export function publicationIssueSubject(issue: string): { pageId?: string; tileId?: string; sourceId?: string } {
  const stripped = issue.replace(/^[A-Z_]+: /, '');
  const pageTile = stripped.match(/^([^/\s]+)\/(\S+?)(?::|\s)/);
  if (pageTile) return { pageId: pageTile[1], tileId: pageTile[2] };
  const datasetTile = stripped.match(/^Dataset tile (\S+) /);
  if (datasetTile) return { tileId: datasetTile[1] };
  const source = stripped.match(/^(?:Dataset )?[Ss]ource (\S+?) /);
  if (source) return { sourceId: source[1] };
  return {};
}

export function publicationIssueSummaries(issues: string[]): PublicationIssueSummary[] {
  // Tiles not certified yet are listed by the publish dialog itself, once (T2/T3);
  // the project's require-certified message is shown with that list.
  const known = /Required App question is unresolved|Review task is still open|Run a current settled preview|requires snapshot-bound semantic approval|is review-required and cannot be published|is local draft analysis and cannot be published|references app-scoped exploratory DQL|Resolve required Build Frame clarifications|APP_BUILD_DATASET_NOT_CERTIFIED|APP_BUILD_DATASET_PUBLICATION_INELIGIBLE|APP_BUILD_TILE_NEEDS_REVIEW|APP_BUILD_REQUIRES_CERTIFIED/i;
  const summaries = issues.filter((issue) => !known.test(issue)).map((issue): PublicationIssueSummary => {
    const choiceMatch = issue.match(/^[^/]+\/[^ ]+ has no choice for filter (.+?)\. Open the Filters tab/i);
    if (choiceMatch) {
      const label = choiceMatch[1];
      const affected = issues.filter((candidate) => candidate.includes(`has no choice for filter ${label}.`)).length;
      return {
        id: `filters:${label.toLowerCase()}`,
        title: `Choose where ${label} applies`,
        detail: `${affected} ${affected === 1 ? 'tile has' : 'tiles have'} no choice for ${label}. Open Filters, edit ${label}, and set each tile to Applies or Does not apply.`,
        action: 'filters' as const,
      };
    }
    const filterMatch = issue.match(/^[^/]+\/[^ ]+ does not have a preflighted binding for filter (.+)\.$/i);
    if (filterMatch) {
      const label = filterMatch[1];
      return {
        id: `filters-preview:${label.toLowerCase()}`,
        title: `Refresh the preview for ${label}`,
        detail: `${label} is linked to tiles that have not run with it yet. Run the page preview once so ZLens can check the link.`,
        action: 'preview' as const,
      };
    }
    if (/filter|binding/i.test(issue)) return { id: 'filters', title: 'Finish filter wiring', detail: issue, action: 'filters' as const };
    const sourceMatch = issue.match(/^Source (.+?) changed after selection\.$/i);
    if (sourceMatch) {
      const source = publicationHumanize(sourceMatch[1]);
      return { id: `sources:${sourceMatch[1]}`, title: `Review ${source}`, detail: `${source} changed since it was selected. Accept the current certified version; ZLens will then request a fresh preview.`, action: 'refresh_sources' as const };
    }
    if (/does not resolve to (?:a current |a )?certified block|no longer resolves to a certified block/i.test(issue)) return { id: `unavailable:${issue}`, title: 'Replace or remove this source', detail: issue, action: 'sources' as const };
    if (/changed after selection|certified block|source/i.test(issue)) {
      return { id: 'sources', title: 'Check this data', detail: 'Some data on this page changed since it was added. Refresh or replace it, and run the page again.', action: 'sources' as const, technical: issue };
    }
    if (/preview|settled run|receipt|runtime/i.test(issue)) return { id: 'preview', title: 'Run the page once to check it', detail: 'The last run no longer matches the page. Run it once and ZLens checks it again.', action: 'preview' as const };
    // Anything else the server checks: one run of the page settles most of it.
    return { id: `validation:${issue}`, title: 'Run the page once to check it', detail: 'ZLens could not confirm this part of the page yet. Run the page once; if it stays, see Technical details.', action: 'preview' as const, technical: issue };
  });
  return Array.from(new Map(summaries.map((summary) => [summary.id, summary])).values());
}

/** A review task in plain words: older drafts stored "Orders is review and must be certified, …". */
export function plainReviewTaskMessage(message: string): string {
  const old = message.match(/^(.+?) is \w+ and must be certified, replaced, or removed before Project publication\.?$/);
  return old ? `${old[1]} is not certified yet: certify it, replace it, or remove the tiles that use it.` : message;
}

/**
 * Review tasks ZLens used to open for every source nobody certified. Trust is
 * shown per tile now (T3), so they are reminders, never publish blockers.
 */
export function isTrustReminderTask(task: Pick<AppStudioBuildDraft['reviewTasks'][number], 'id'>): boolean {
  return isTrustReminderTaskId(task.id);
}

function publicationHumanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function unresolvedPublicationRequirements(draft: AppStudioBuildDraft): AppStudioBuildDraft['requirements'] {
  return draft.requirements.filter((requirement) => {
    if (!requirement.required) return false;
    if (!appBuildRequirementAppliesToPublication(draft, requirement)) return false;
    const coverage = draft.coverage.find((item) => item.requirementId === requirement.id);
    return coverage?.status !== 'covered';
  });
}

function appBuildRequirementAppliesToPublication(
  draft: AppStudioBuildDraft,
  requirement: AppStudioBuildDraft['requirements'][number],
): boolean {
  // A blank/manual App may later ask AI for layout help. Older planners turned
  // its title into empty-measure placeholder requirements (for example the App
  // name and "primary metric over time"). Manual publication is governed by
  // the sources and components the author actually added; only analytical
  // requirements with a named measure remain coverage gates.
  if (draft.authoringMode === 'manual' && draft.frame.metrics.length === 0 && requirement.measures.length === 0) return false;
  return true;
}

/**
 * Only a review task attached to content that still exists can block
 * publication. Earlier AI plans stored general advice as unscoped open tasks;
 * those reminders are useful context, but are not a publication requirement.
 */
export function blockingPublicationReviewTasks(draft: AppStudioBuildDraft): AppStudioBuildDraft['reviewTasks'] {
  const pageIds = new Set(draft.pages.map((page) => page.id));
  const tileIds = new Set(draft.pages.flatMap((page) => page.layout.items.map((tile) => tile.i)));
  // A source no tile uses is not published (design D4), so its tasks do not block.
  const sourceIds = appSourceIdsUsedByTiles(draft);
  return draft.reviewTasks.filter((task) => {
    if (task.status !== 'open') return false;
    if (isTrustReminderTask(task)) return false;
    if (task.sourceId && sourceIds.has(task.sourceId)) return true;
    if (task.tileId && tileIds.has(task.tileId)) return true;
    if (task.pageId && pageIds.has(task.pageId)) return true;
    return false;
  });
}

export function pagesNeedingSettledPreview(draft: AppStudioBuildDraft): AppStudioBuildDraft['pages'] {
  const receipts = draft.previewReceipts ?? (draft.previewReceipt ? [draft.previewReceipt] : []);
  return draft.pages.filter((page) => {
    const hasData = page.layout.items.some((tile) => !tile.text && !tile.aiPin);
    if (!hasData) return false;
    return !receipts.some((receipt) => receipt.pageId === page.id && receipt.revision === draft.revision);
  });
}

function isSemanticSource(source: AppStudioSource): boolean {
  return source.kind === 'governed_semantic' || source.kind === 'semantic_query';
}

/** A field Dataset is governed by its source lifecycle/contract, rather than
 * the legacy per-result semantic approval flow. */
export function isDatasetBackedAppSource(source: AppStudioSource): boolean {
  return Boolean(source.capabilities?.dataset);
}

export function isLegacySemanticAppSource(source: AppStudioSource): boolean {
  return isSemanticSource(source) && !isDatasetBackedAppSource(source);
}

/** Legacy serialized semantic tiles may not have a source id. A field Dataset
 * tile always has one, and can only be approved through its Dataset contract. */
export function tileUsesLegacySemanticApproval(
  draft: AppStudioBuildDraft,
  tile: AppStudioTile,
): boolean {
  if (!tile.semantic) return false;
  if (!tile.sourceId) return true;
  const source = draft.sources.find((candidate) => candidate.id === tile.sourceId);
  return Boolean(source && isLegacySemanticAppSource(source));
}

/** Resolve a legacy source only through an exact persisted tile binding, or a
 * unique historical semantic reference. Ambiguous legacy records remain
 * unapproved instead of borrowing a receipt from another page. */
export function legacySemanticSourceForTile(
  draft: AppStudioBuildDraft,
  tile: AppStudioTile,
): AppStudioSource | undefined {
  if (!tile.semantic) return undefined;
  if (tile.sourceId) {
    const source = draft.sources.find((candidate) => candidate.id === tile.sourceId);
    return source && isLegacySemanticAppSource(source) ? source : undefined;
  }
  const candidates = draft.sources.filter((source) => isLegacySemanticAppSource(source)
    && (source.id === tile.semantic!.id
      || source.sourceRef === tile.semantic!.id
      || source.executionRef === tile.semantic!.id));
  return candidates.length === 1 ? candidates[0] : undefined;
}

export interface LegacySemanticPendingTile {
  page: AppStudioBuildDraft['pages'][number];
  tile: AppStudioTile;
  source?: AppStudioSource;
}

/**
 * Legacy semantic approval is a tile-level proof. Source metadata is useful
 * provenance, but a source shared by two pages cannot carry Page A's review
 * receipt into Page B. This mirrors the publish gate: each semantic tile
 * needs its own approved review, semantic snapshot, and preflight receipt.
 */
export function legacySemanticTileNeedsApproval(
  draft: AppStudioBuildDraft,
  tile: AppStudioTile,
): boolean {
  if (!tileUsesLegacySemanticApproval(draft, tile)) return false;
  return tile.review?.status !== 'approved'
    || !tile.semantic?.snapshotId
    || !tile.review?.preflightReceiptId;
}

/** The common tile predicate drives readiness, action presentation, and the
 * active-page approval plan. */
export function legacySemanticTilesNeedingApproval(draft: AppStudioBuildDraft): LegacySemanticPendingTile[] {
  return draft.pages.flatMap((page) => page.layout.items.flatMap((tile) => {
    if (!legacySemanticTileNeedsApproval(draft, tile)) return [];
    return [{ page, tile, source: legacySemanticSourceForTile(draft, tile) }];
  }));
}

export function legacySemanticPendingPageIds(draft: AppStudioBuildDraft): string[] {
  return Array.from(new Set(legacySemanticTilesNeedingApproval(draft).map(({ page }) => page.id)));
}

/** Source rows are deduplicated for presentation only. Their mutable approval
 * fields never determine whether another tile remains pending. */
export function legacySemanticSourcesNeedingApproval(draft: AppStudioBuildDraft): AppStudioSource[] {
  const sources = new Map<string, AppStudioSource>();
  for (const { source } of legacySemanticTilesNeedingApproval(draft)) {
    if (source) sources.set(source.id, source);
  }
  return Array.from(sources.values());
}

export interface LegacySemanticApprovalPlan {
  operations: AppStudioDraftOperation[];
  /** Pages that still have a legacy semantic source awaiting a page-local
   * settled preview. The Studio uses this for a direct recovery message. */
  pendingPageIds: string[];
}

/**
 * Create approval mutations only for successful legacy semantic tiles on the
 * page that produced this run. In particular, a Dataset-only run on Page A
 * cannot stamp Page B's legacy source with Page A's snapshot and receipt.
 */
export function planLegacySemanticApproval(
  draft: AppStudioBuildDraft,
  activePage: AppStudioBuildDraft['pages'][number],
  previewRun: DashboardRunResponse,
  reviewedAt = new Date().toISOString(),
): LegacySemanticApprovalPlan {
  const pendingTiles = legacySemanticTilesNeedingApproval(draft);
  const pendingPageIds = legacySemanticPendingPageIds(draft);
  if (previewRun.dashboardId !== activePage.id) return { operations: [], pendingPageIds };

  const successfulTileIds = new Set(previewRun.tiles
    .filter((runTile) => runTile.status === 'ok')
    .map((runTile) => runTile.tileId));
  const approvedTiles = pendingTiles
    .filter(({ page, tile }) => page.id === activePage.id && successfulTileIds.has(tile.i));
  if (approvedTiles.length === 0) return { operations: [], pendingPageIds };

  const sourcesById = new Map(approvedTiles.flatMap(({ source }) => source ? [[source.id, source] as const] : []));
  return {
    pendingPageIds,
    operations: [
      ...Array.from(sourcesById.values()).map((source): AppStudioDraftOperation => ({
        type: 'upsert_source',
        source: {
          ...source,
          snapshotId: previewRun.snapshotId,
          receiptId: previewRun.runId,
          reviewStatus: 'approved',
        },
      })),
      ...approvedTiles.map(({ tile }): AppStudioDraftOperation => ({
        type: 'update_tile',
        pageId: activePage.id,
        tileId: tile.i,
        patch: {
          semantic: { ...tile.semantic!, snapshotId: previewRun.snapshotId },
          review: {
            status: 'approved',
            sourceFingerprint: tile.semantic!.definitionFingerprint,
            preflightReceiptId: previewRun.runId,
            reviewedAt,
            reviewedBy: 'local-author',
          },
        },
      })),
    ],
  };
}

/**
 * Sources that keep an App from publishing whatever the project requires:
 * local draft analysis (it lives only on this machine) and legacy Metrics
 * results that need their own approval. Data nobody certified is not here:
 * its tiles publish as "Not certified yet" (T3), listed by
 * `notCertifiedPublicationTiles`.
 */
export function publicationBlockingSources(draft: AppStudioBuildDraft): AppStudioBuildDraft['sources'] {
  const pendingLegacySourceIds = new Set(legacySemanticSourcesNeedingApproval(draft).map((source) => source.id));
  // Publish writes pages only: a connected source that no tile uses is left
  // out of the App and never blocks publishing (design D4).
  const usedSourceIds = appSourceIdsUsedByTiles(draft);
  return draft.sources.filter((source) => {
    if (!usedSourceIds.has(source.id)) return false;
    if (isSemanticSource(source) && !isDatasetBackedAppSource(source)) return pendingLegacySourceIds.has(source.id);
    return source.kind === 'review_dql' || source.kind === 'exploratory_sql';
  });
}

/**
 * The App's data that nobody certified yet (design Q1): tables (checked or
 * not) and saved queries. Each can be certified from the publish dialog — a
 * table through a short review ("I vouch for this — certify"), a saved query
 * in Block Studio for now (phase 2 brings it inline).
 */
export function uncertifiedPublicationSources(sources: AppStudioBuildDraft['sources']): AppStudioBuildDraft['sources'] {
  return sources.filter((source) => (source.kind === 'block' || source.kind === 'certified_block')
    && source.capabilities?.dataset?.kind !== 'semantic'
    && !source.capabilities?.semanticModelId
    && (source.lifecycle !== 'certified' || source.trustState !== 'certified'));
}

/** "2 tables not certified yet", "1 saved query not certified yet", "1 table and 1 saved query not certified yet". */
export function notCertifiedYetTitle(sources: AppStudioBuildDraft['sources']): string {
  const tables = sources.filter((source) => sourceKindLabel(source.kind, source.capabilities) === 'Table').length;
  const queries = sources.length - tables;
  const parts = [
    tables ? `${tables} ${tables === 1 ? 'table' : 'tables'}` : '',
    queries ? `${queries} ${queries === 1 ? 'saved query' : 'saved queries'}` : '',
  ].filter(Boolean);
  return `${parts.join(' and ')} not certified yet`;
}

/**
 * The App's one trust answer (B6), from the draft: the same function the App
 * header, the Apps card and the published `dql.app.json` use. A settled
 * preview is the current evidence for a join, so a join certified since the
 * source card was stored no longer counts against its tiles.
 */
export function draftTrust(
  draft: AppStudioBuildDraft,
  runsByPage: Readonly<Record<string, DashboardRunResponse | undefined>> = {},
): AppTrustAnswer {
  const sources = new Map(draft.sources.map((source) => [source.id, source]));
  return appTrustAnswer({
    pages: draft.pages as unknown as AppTrustPageLike[],
    sourceFor: (sourceId) => sources.get(sourceId) as AppTrustSourceLike | undefined,
    joinTrust: (pageId, tileId, join) => {
      const ran = runsByPage[pageId]?.tiles.find((tile) => tile.tileId === tileId)?.dataset?.joins;
      if (!ran?.length) return join.trust;
      return (ran.find((entry) => (entry as { id?: string }).id === join.id)?.trust as typeof join.trust | undefined) ?? join.trust;
    },
  });
}

/**
 * Tiles not certified because they read a field through a join nobody
 * certified yet (design D2), including a page filter that reaches them
 * through a related field. They are listed in the publish dialog with their
 * certify actions; they block publishing only when the project requires
 * certified data (T3).
 */
export function publicationTilesNeedingReview(
  draft: AppStudioBuildDraft,
  runsByPage: Readonly<Record<string, DashboardRunResponse | undefined>> = {},
): AppTileNeedingJoinReview[] {
  return draftTrust(draft, runsByPage).tiles.flatMap((tile) => (tile.joinReview ? [tile.joinReview] : []));
}

/**
 * How a tile not certified yet can be certified from the publish dialog.
 * Phase 1: a table (or a saved query with a row-level definition) opens the
 * short certify review; a plain saved query opens in Block Studio; a join
 * opens in Modeling. Phase 2 (T4) handles `saved_query` and `join` inline in
 * the same dialog: only the handlers change, never this shape.
 */
export type CertifyNowAction =
  | { kind: 'source'; source: AppStudioSource }
  | { kind: 'saved_query'; source: AppStudioSource }
  | { kind: 'join'; joins: DatasetJoin[]; review: AppTileNeedingJoinReview }
  | { kind: 'none' };

export interface NotCertifiedPublicationTile {
  pageId: string;
  tileId: string;
  /** "Orders by store" (or the tile id). */
  title: string;
  /** The page's title, when the App has more than one page. */
  pageTitle?: string;
  /** Why it is not certified, from its receipt: "Checked, not certified yet." */
  detail: string;
  /** The data the action certifies, by the name the App's data uses. */
  sourceName?: string;
  action: CertifyNowAction;
}

function isDraftSourceCertified(source: AppStudioSource | undefined): boolean {
  return Boolean(source
    && source.trustState === 'certified'
    && (source.lifecycle === undefined ? source.kind === 'certified_block' : source.lifecycle === 'certified')
    && source.reviewStatus !== 'required');
}

/**
 * The tiles readers will see as "Not certified yet", each with the action
 * that certifies it (T3). The source comes first when nobody certified it;
 * otherwise the join on the tile's path.
 */
export function notCertifiedPublicationTiles(
  draft: AppStudioBuildDraft,
  trust: Pick<AppTrustAnswer, 'tiles'>,
  sourceName?: (source: AppStudioSource) => string,
): NotCertifiedPublicationTile[] {
  const sources = new Map(draft.sources.map((source) => [source.id, source]));
  const multiPage = draft.pages.length > 1;
  return notCertifiedTiles(trust).map((entry: AppTileTrust) => {
    const page = draft.pages.find((candidate) => candidate.id === entry.pageId);
    const tile = page?.layout.items.find((candidate) => candidate.i === entry.tileId);
    const source = tile?.sourceId ? sources.get(tile.sourceId) : undefined;
    let action: CertifyNowAction = { kind: 'none' };
    if (source && !isDraftSourceCertified(source) && (source.kind === 'block' || source.kind === 'certified_block' || (isDatasetBackedAppSource(source) && source.capabilities?.dataset?.kind !== 'semantic'))) {
      const dataset = source.capabilities?.dataset;
      action = dataset && dataset.kind !== 'semantic' && !dataset.result ? { kind: 'source', source } : { kind: 'saved_query', source };
    } else if (entry.joinReview) {
      action = { kind: 'join', joins: entry.joinReview.joins, review: entry.joinReview };
    }
    const name = source ? (sourceName?.(source) ?? source.capabilities?.dataset?.label ?? source.qualifiedIdentity ?? source.sourceRef) : undefined;
    return {
      pageId: entry.pageId,
      tileId: entry.tileId,
      title: entry.tileTitle || tile?.title || entry.tileId,
      ...(multiPage && page?.metadata.title ? { pageTitle: page.metadata.title } : {}),
      detail: entry.trust.detail,
      ...(name ? { sourceName: name } : {}),
      action,
    };
  });
}

/** Whether a server answer says the project requires certified tiles to publish. */
export function serverRequiresCertified(serverIssues: readonly string[]): boolean {
  return serverIssues.some((issue) => issue.startsWith(`${REQUIRE_CERTIFIED_TO_PUBLISH_CODE}:`));
}

/** The one plain sentence when the project requires certified data (T3). */
export const REQUIRE_CERTIFIED_SENTENCE = 'This project requires every tile to be certified before an App is published.';

/** Stable key for a tile in the publish check: `page/tile`. */
export function publicationTileKey(item: Pick<AppTileNeedingJoinReview, 'pageId' | 'tileId'>): string {
  return `${item.pageId}/${item.tileId}`;
}

/**
 * The tile without its fields from related tables that need review: they
 * leave its groupings, filters, detail columns, sort and chart shelves. The
 * tile keeps its measures, so it still runs on its own Dataset.
 */
export function tilePatchWithoutRelatedFields(
  tile: AppStudioTile,
  fields: readonly string[],
): Partial<AppStudioTile> | null {
  if (!tile.query || fields.length === 0) return null;
  const drop = new Set(fields.map((field) => field.toLowerCase()));
  const kept = (field: string) => !drop.has(field.toLowerCase());
  const removedAliases = new Set(tile.query.dimensions
    .filter((dimension) => !kept(dimension.field))
    .flatMap((dimension) => [dimension.alias, dimension.field, dimension.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : undefined])
    .filter((alias): alias is string => Boolean(alias))
    .map((alias) => alias.toLowerCase()));
  const { orderBy, detailColumns, filters, ...rest } = tile.query;
  const nextOrder = orderBy?.filter((order) => !removedAliases.has(order.alias.toLowerCase()));
  const nextDetail = detailColumns?.filter(kept);
  const nextFilters = filters?.filter((filter) => kept(filter.field));
  const query = {
    ...rest,
    dimensions: tile.query.dimensions.filter((dimension) => kept(dimension.field)),
    ...(nextOrder?.length ? { orderBy: nextOrder } : {}),
    ...(nextDetail?.length ? { detailColumns: nextDetail } : {}),
    ...(nextFilters?.length ? { filters: nextFilters } : {}),
  } as NonNullable<AppStudioTile['query']>;
  let encoding = tile.viz.encoding;
  if (encoding) for (const field of fields) encoding = removeField(encoding, { dimension: field });
  // A chart with no category left reads as one number; a table stays a table.
  const type = query.dimensions.length === 0 && !query.detail && tile.viz.type !== 'table' ? 'single_value' : tile.viz.type;
  return { query, viz: { ...tile.viz, type: type as AppStudioTile['viz']['type'], ...(encoding ? { encoding } : {}) } };
}

/**
 * The publish check, as one list (B6): the Publish button's count and the
 * dialog's rows both come from here, so "5 fixes" never opens "9 fixes".
 * One root cause is one row: a review task, a server message or a tile
 * about data already listed (the same source, tile and kind) is not repeated.
 */
export interface PublicationReadiness {
  clarifications: NonNullable<AppStudioBuildDraft['frame']['clarificationQuestions']>;
  requirements: AppStudioBuildDraft['requirements'];
  tasks: AppStudioBuildDraft['reviewTasks'];
  /** Pages Publish runs itself first; listed, but not counted as fixes. */
  previewPages: AppStudioBuildDraft['pages'];
  /** Metrics results to approve: one row. */
  semanticTiles: LegacySemanticPendingTile[];
  /** Tables and saved queries nobody certified yet (what the certify actions certify). */
  uncertifiedSources: AppStudioBuildDraft['sources'];
  /** @deprecated Always empty: a Metrics Dataset nobody certified is a tile not certified yet (T3). */
  datasetSources: AppStudioBuildDraft['sources'];
  /** Tiles on a join nobody certified (they are also in `notCertified`). */
  reviewTiles: AppTileNeedingJoinReview[];
  /** Tiles readers will see as "Not certified yet", with their certify actions (T3). */
  notCertified: NotCertifiedPublicationTile[];
  /** The project requires every tile to be certified (apps.requireCertifiedToPublish). */
  requireCertified: boolean;
  /** Local analysis that cannot publish: one row. */
  localOnlySources: AppStudioBuildDraft['sources'];
  /** What the server found that nothing above already says: one row each. */
  serverIssues: PublicationIssueSummary[];
  /**
   * The number of rows the author must fix: the button and the dialog title
   * both show it. Tiles not certified yet are not fixes unless the project
   * requires certified data, when they are one fix together.
   */
  fixCount: number;
  ready: boolean;
  /** The App's trust answer, for "3 of 4 tiles certified". */
  trust: AppTrustAnswer;
}

export function publicationReadiness(
  draft: AppStudioBuildDraft,
  serverIssues: string[] = [],
  runsByPage: Readonly<Record<string, DashboardRunResponse | undefined>> = {},
  options: {
    /** The project setting `apps.requireCertifiedToPublish` (read from the server). */
    requireCertifiedToPublish?: boolean;
    /** How the App's data names a source ("Orders"). */
    sourceName?: (source: AppStudioSource) => string;
  } = {},
): PublicationReadiness {
  const clarifications = (draft.frame.clarificationQuestions ?? []).filter((question) => question.required && !question.answerId);
  const requirements = unresolvedPublicationRequirements(draft);
  const previewPages = pagesNeedingSettledPreview(draft);
  const sources = publicationBlockingSources(draft);
  const semanticTiles = legacySemanticTilesNeedingApproval(draft);
  const usedSourceIds = appSourceIdsUsedByTiles(draft);
  const uncertifiedSources = uncertifiedPublicationSources(draft.sources.filter((source) => usedSourceIds.has(source.id)));
  const datasetSources: AppStudioBuildDraft['sources'] = [];
  const localOnlySources = sources.filter((source) => source.kind === 'review_dql' || source.kind === 'exploratory_sql');
  const trust = draftTrust(draft, runsByPage);
  const reviewTiles = trust.tiles.flatMap((tile) => (tile.joinReview ? [tile.joinReview] : []));
  const notCertified = notCertifiedPublicationTiles(draft, trust, options.sourceName);
  const requireCertified = Boolean(options.requireCertifiedToPublish) || serverRequiresCertified(serverIssues);
  // Sources already listed above (or listed with the tiles not certified yet), and the tiles that read them.
  const listedSourceIds = new Set([...sources, ...uncertifiedSources].map((source) => source.id));
  const tileSource = new Map(draft.pages.flatMap((page) => page.layout.items.map((tile) => [`${page.id}/${tile.i}`, tile.sourceId] as const)));
  const tileSourceById = new Map(draft.pages.flatMap((page) => page.layout.items.map((tile) => [tile.i, tile.sourceId] as const)));
  const reviewTileKeys = new Set(reviewTiles.map((item) => publicationTileKey(item)));
  const coveredTile = (pageId: string | undefined, tileId: string | undefined): boolean => {
    if (!tileId) return false;
    if (pageId && reviewTileKeys.has(`${pageId}/${tileId}`)) return true;
    const sourceId = pageId ? tileSource.get(`${pageId}/${tileId}`) : tileSourceById.get(tileId);
    return Boolean(sourceId && listedSourceIds.has(sourceId));
  };
  const tasks = blockingPublicationReviewTasks(draft).filter((task) => {
    if (task.sourceId && listedSourceIds.has(task.sourceId)) return false;
    if (task.tileId && coveredTile(task.pageId, task.tileId)) return false;
    return true;
  });
  const remainingIssues = publicationIssueSummaries(serverIssues).filter((issue) => {
    if (issue.id.startsWith('tile-review:')) return !reviewTileKeys.has(issue.id.slice('tile-review:'.length));
    const subject = publicationIssueSubject(issue.technical ?? issue.detail);
    if (subject.sourceId && Array.from(listedSourceIds).some((id) => id === subject.sourceId || draft.sources.find((source) => source.id === id)?.qualifiedIdentity === subject.sourceId)) return false;
    if (coveredTile(subject.pageId, subject.tileId)) return false;
    return true;
  });
  const fixCount = clarifications.length
    + requirements.length
    + tasks.length
    + (semanticTiles.length ? 1 : 0)
    + (requireCertified && notCertified.length ? 1 : 0)
    + (localOnlySources.length ? 1 : 0)
    + remainingIssues.length;
  return {
    clarifications,
    requirements,
    tasks,
    previewPages,
    semanticTiles,
    uncertifiedSources,
    datasetSources,
    reviewTiles,
    notCertified,
    requireCertified,
    localOnlySources,
    serverIssues: remainingIssues,
    fixCount,
    ready: fixCount === 0 && previewPages.length === 0,
    trust,
  };
}

/** The Publish button's count: the same rows the publish dialog lists. */
export function publicationBlockerCount(draft: AppStudioBuildDraft, serverIssues: string[] = [], runsByPage: Readonly<Record<string, DashboardRunResponse | undefined>> = {}, options: { requireCertifiedToPublish?: boolean } = {}): number {
  return publicationReadiness(draft, serverIssues, runsByPage, options).fixCount;
}

export function localPublicationSteps(draft: AppStudioBuildDraft, runsByPage: Readonly<Record<string, DashboardRunResponse | undefined>> = {}): AppPublicationStep[] {
  const unansweredClarifications = (draft.frame.clarificationQuestions ?? [])
    .filter((question) => question.required && !question.answerId);
  const unresolvedRequirements = unresolvedPublicationRequirements(draft);
  const reviewTasks = blockingPublicationReviewTasks(draft);
  const previewPages = pagesNeedingSettledPreview(draft);
  const pendingLegacyTiles = legacySemanticTilesNeedingApproval(draft);
  const pendingLegacySourceIds = new Set(legacySemanticSourcesNeedingApproval(draft).map((source) => source.id));
  const nonLegacyBlockingSources = publicationBlockingSources(draft)
    .filter((source) => !pendingLegacySourceIds.has(source.id));
  const steps: AppPublicationStep[] = [];

  if (unansweredClarifications.length || unresolvedRequirements.length) {
    const count = unansweredClarifications.length + unresolvedRequirements.length;
    steps.push({
      id: 'questions',
      title: 'Confirm the App questions',
      detail: `${count} ${count === 1 ? 'question needs' : 'questions need'} an answer, a tile that covers it, or removal from this publish scope.`,
      count,
    });
  }
  if (reviewTasks.length) {
    steps.push({
      id: 'review',
      title: 'Complete scoped review',
      detail: `${reviewTasks.length} review ${reviewTasks.length === 1 ? 'task is' : 'tasks are'} attached to content still in this App.`,
      count: reviewTasks.length,
    });
  }
  if (previewPages.length) {
    steps.push({
      id: 'preview',
      title: 'Run a current preview',
      detail: `${previewPages.length} data ${previewPages.length === 1 ? 'page needs' : 'pages need'} a settled result before publication.`,
      count: previewPages.length,
    });
  }
  // Tiles not certified yet never block here (T3): readers see "Not certified yet".
  const sourceReviewCount = pendingLegacyTiles.length + nonLegacyBlockingSources.length;
  if (sourceReviewCount) {
    steps.push({
      id: 'sources',
      title: 'Finish source review',
      detail: `${sourceReviewCount} ${sourceReviewCount === 1 ? 'source or tile needs' : 'sources or tiles need'} approval, replacement, or removal.`,
      count: sourceReviewCount,
    });
  }
  void runsByPage;
  return steps;
}
