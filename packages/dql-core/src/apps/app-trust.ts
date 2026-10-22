/**
 * One trust answer for an App (B6). Every surface that says how trusted an
 * App's data is — the publish check, the editor's tile dots, the App header,
 * the Apps card and the `dql.app.json` written at publish — reads it from
 * here, so they can never disagree.
 *
 * Trust is decided from what the page is built from, not from the reader's
 * current filter values: each tile's source, every join it can run through
 * (its own fields, and every page filter mapped to it through a related
 * field, whether or not a value is picked) and its calculations' inputs.
 * Trust lives at one level, the tile (T2): each tile is labelled by
 * the same rule the reader uses (`readerTileTrust`), and the page by the same
 * aggregate (`appTrustSummary`).
 *
 * Pure: no I/O, so the browser and the server share it.
 */
import type { DatasetDescriptor, DatasetJoin } from '../datasets/descriptor.js';
import {
  appTilesNeedingJoinReview,
  tileJoinsReachable,
  type AppTileNeedingJoinReview,
  type JoinTrustPageLike,
  type JoinTrustTileLike,
} from './app-tile-join-trust.js';
import {
  appTrustSummary,
  isDataTileForTrust,
  readerTileTrust,
  tileTrustCountText,
  type AppTrustState,
  type CertificationByline,
  type ReaderTrust,
  type ReaderTrustItem,
  type ReaderTrustTile,
} from './reader-trust.js';

/** The parts of an App data source trust depends on (a Studio draft source card). */
export interface AppTrustSourceLike {
  id: string;
  kind?: string;
  lifecycle?: string;
  trustState?: string;
  reviewStatus?: string;
  /** ZLens checked the data and someone added it, but nobody certified it yet. */
  checked?: boolean;
  capabilities?: { dataset?: unknown } | null;
  certification?: CertificationByline | null;
}

export type AppTrustTileLike = JoinTrustTileLike & ReaderTrustItem & { trustState?: string };

export interface AppTrustPageLike extends JoinTrustPageLike {
  layout: { items: readonly AppTrustTileLike[] };
}

export interface AppTileTrust {
  pageId: string;
  tileId: string;
  tileTitle?: string;
  trust: ReaderTrust;
  /** The joins on the tile's path nobody certified yet, when that is why it needs review. */
  joinReview?: AppTileNeedingJoinReview;
}

export interface AppTrustAnswer {
  tiles: AppTileTrust[];
  state: AppTrustState;
  certified: number;
  total: number;
  /** Data tiles in the `review` state (code name; people read "Not certified yet"). */
  needsReview: number;
  /** Data tiles that are not certified, whatever the reason: readers see "Not certified yet" on each. */
  notCertified: number;
  allCertified: boolean;
  /** "All tiles certified", "3 of 4 tiles certified", "No data tiles". */
  label: string;
  /** "All tiles certified", "3 of 4 tiles certified"; empty with no data tiles. */
  text: string;
}

export interface AppTrustInput {
  pages: readonly AppTrustPageLike[];
  sourceFor: (sourceId: string) => AppTrustSourceLike | undefined;
  /**
   * @deprecated The per-App data rule is gone (T3). An old App's stored
   * `sourcePolicy` is read and ignored: it never changes a tile's trust.
   */
  sourcePolicy?: string;
  /**
   * Current evidence of a join's trust (a settled run of the page): a join
   * certified since the source card was stored no longer counts against a tile.
   */
  joinTrust?: (pageId: string, tileId: string, join: DatasetJoin) => DatasetJoin['trust'];
}

const isCertifiedSource = (source: AppTrustSourceLike | undefined): boolean => Boolean(source
  && source.trustState === 'certified'
  && (source.lifecycle === undefined ? source.kind === 'certified_block' : source.lifecycle === 'certified')
  && source.reviewStatus !== 'required');

function datasetOf(source: AppTrustSourceLike | undefined): DatasetDescriptor | undefined {
  const dataset = source?.capabilities?.dataset as DatasetDescriptor | undefined;
  return dataset && typeof dataset === 'object' && Array.isArray((dataset as DatasetDescriptor).fields) ? dataset : undefined;
}

/**
 * The evidence a run of this tile would carry, worked out from the page
 * itself: the reader's rule then labels it.
 */
function staticRunTile(page: AppTrustPageLike, tile: AppTrustTileLike, input: AppTrustInput): ReaderTrustTile {
  if (tile.aiPin) return { status: 'ok', aiPin: tile.aiPin as ReaderTrustTile['aiPin'] };
  if (tile.draftAnalysis) return { status: 'ok' };
  const source = tile.sourceId ? input.sourceFor(tile.sourceId) : undefined;
  const certified = isCertifiedSource(source);
  if (tile.query) {
    const descriptor = datasetOf(source);
    if (!source || !descriptor) return { status: 'ok', trustState: 'review_required' };
    const joins = tileJoinsReachable(page, tile, descriptor).joins.map((join) => {
      const trust = input.joinTrust?.(page.id, tile.i, join) ?? join.trust;
      return {
        id: join.id,
        trust,
        ...(trust !== 'certified' && join.changedSinceCertified ? { changedSinceCertified: join.changedSinceCertified } : {}),
      };
    });
    return {
      status: 'ok',
      tileType: 'dataset',
      dataset: { trust: certified ? 'certified' : 'review_required', checked: source.checked ?? null, joins },
      ...(source.certification ? { certification: source.certification } : {}),
    };
  }
  if (tile.semantic && !tile.block) {
    // A legacy semantic-model result: not certified on its own.
    return { status: 'ok', tileType: 'semantic' };
  }
  // A saved query shown as it was reviewed.
  const sourceCertified = source ? certified : tile.trustState === 'certified';
  return {
    status: 'ok',
    trustState: sourceCertified ? 'certified' : 'review_required',
    ...(source?.certification ? { certification: source.certification } : {}),
  };
}

/** The App's trust: every data tile on every page, and the page aggregate. */
export function appTrustAnswer(input: AppTrustInput): AppTrustAnswer {
  const joinReviews = new Map(appTilesNeedingJoinReview({
    pages: input.pages,
    descriptorFor: (sourceId) => datasetOf(input.sourceFor(sourceId)),
    joinTrust: input.joinTrust,
  }).map((item) => [`${item.pageId}/${item.tileId}`, item]));
  const items: Array<AppTrustTileLike & { i: string }> = [];
  const runTiles = new Map<string, ReaderTrustTile>();
  const tiles: AppTileTrust[] = [];
  for (const page of input.pages) {
    for (const tile of page.layout.items) {
      if (!isDataTileForTrust(tile)) continue;
      const key = `${page.id}/${tile.i}`;
      const run = staticRunTile(page, tile, input);
      const trust = readerTileTrust(tile, run);
      if (!trust) continue;
      items.push({ ...tile, i: key });
      runTiles.set(key, run);
      const joinReview = joinReviews.get(key);
      tiles.push({
        pageId: page.id,
        tileId: tile.i,
        ...(tile.title ? { tileTitle: tile.title } : {}),
        trust,
        ...(joinReview && trust.state === 'review' ? { joinReview } : {}),
      });
    }
  }
  const summary = appTrustSummary(items, runTiles);
  const needsReview = tiles.filter((tile) => tile.trust.state === 'review').length;
  return {
    tiles,
    state: summary.state,
    certified: summary.certified,
    total: summary.total,
    needsReview,
    notCertified: summary.total - summary.certified,
    allCertified: summary.allCertified,
    label: summary.label,
    text: summary.text,
  };
}

/** One tile's answer, or undefined for a tile that carries no data. */
export function appTileTrustFor(answer: AppTrustAnswer, pageId: string, tileId: string): AppTileTrust | undefined {
  return answer.tiles.find((tile) => tile.pageId === pageId && tile.tileId === tileId);
}

/** "1 tile not certified yet", "3 tiles not certified yet". */
export function tilesNotCertifiedText(count: number): string {
  return `${count} ${count === 1 ? 'tile' : 'tiles'} not certified yet`;
}

/** @deprecated Use `tilesNotCertifiedText` (T1: no "needs review" on App screens). */
export const tilesNeedReviewText = tilesNotCertifiedText;

/**
 * What readers will see, said next to the Publish button (T3): publishing is
 * never blocked by trust unless the project requires it, so the dialog says
 * plainly how many tiles readers will see marked "Not certified yet".
 */
export function readersWillSeeText(notCertified: number): string {
  if (notCertified <= 0) return 'Readers will see every tile certified.';
  return `Readers will see ‘Not certified yet’ on ${notCertified} ${notCertified === 1 ? 'tile' : 'tiles'}.`;
}

/**
 * What the publish check says once nothing is left to fix. It never says
 * "Every check passed" while a tile is not certified: the count is named —
 * "3 of 4 tiles certified".
 */
export function publishReadyLine(answer: Pick<AppTrustAnswer, 'allCertified' | 'certified' | 'total'> & { notCertified?: number; needsReview?: number }): {
  /** "Every check passed." or "3 of 4 tiles certified". */
  detail: string;
  allPassed: boolean;
} {
  const notCertified = answer.notCertified ?? Math.max(0, answer.total - answer.certified);
  if (notCertified > 0) return { detail: tileTrustCountText(answer.certified, answer.total), allPassed: false };
  return { detail: 'Every check passed.', allPassed: true };
}

/**
 * Project settings for Apps that decide publishing (T3). The open-source
 * default never blocks publishing on trust: tiles nobody certified carry
 * "Not certified yet" for readers. `apps.requireCertifiedToPublish: true` in
 * `dql.config.json` turns the gate back on for the whole project; an
 * Enterprise host sets it on by default through its admin policy. There is no
 * per-App rule.
 */
export interface AppsPublishSettings {
  requireCertifiedToPublish: boolean;
}

export const DEFAULT_APPS_PUBLISH_SETTINGS: AppsPublishSettings = { requireCertifiedToPublish: false };

/** The publish settings from a parsed `dql.config.json`; anything but `true` is off. */
export function appsPublishSettings(config: unknown): AppsPublishSettings {
  const apps = config && typeof config === 'object' ? (config as { apps?: unknown }).apps : undefined;
  const value = apps && typeof apps === 'object' ? (apps as { requireCertifiedToPublish?: unknown }).requireCertifiedToPublish : undefined;
  return { requireCertifiedToPublish: value === true };
}

/** Problems with the `apps` publish settings in a parsed `dql.config.json` (for `zlens doctor`). */
export function appsPublishSettingsProblems(config: unknown): string[] {
  const apps = config && typeof config === 'object' ? (config as { apps?: unknown }).apps : undefined;
  if (apps === undefined || apps === null) return [];
  if (typeof apps !== 'object' || Array.isArray(apps)) return ['apps must be an object.'];
  const value = (apps as { requireCertifiedToPublish?: unknown }).requireCertifiedToPublish;
  if (value !== undefined && typeof value !== 'boolean') return ['apps.requireCertifiedToPublish must be true or false.'];
  return [];
}

/** The code of the one message publishing gives when the project requires certified tiles. */
export const REQUIRE_CERTIFIED_TO_PUBLISH_CODE = 'APP_BUILD_REQUIRES_CERTIFIED';

/**
 * The one plain message when the project requires certified data and some
 * tiles are not certified yet. It names the tiles; the publish dialog shows
 * the certify actions next to it.
 */
export function requireCertifiedToPublishMessage(tiles: ReadonlyArray<Pick<AppTileTrust, 'tileId' | 'tileTitle'>>): string {
  const names = tiles.map((tile) => tile.tileTitle || tile.tileId);
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
  return `${REQUIRE_CERTIFIED_TO_PUBLISH_CODE}: This project requires every tile to be certified before an App is published. Not certified yet: ${shown}.`;
}

/** Tiles that are not certified, in page order. */
export function notCertifiedTiles(answer: Pick<AppTrustAnswer, 'tiles'>): AppTileTrust[] {
  return answer.tiles.filter((tile) => tile.trust.state !== 'certified');
}

/**
 * Review tasks ZLens used to open for every source nobody certified ("X needs
 * certifying before this App is published"). Trust is shown per tile now
 * (T3), so these stored reminders never block publishing.
 */
export function isTrustReminderTaskId(id: string | undefined | null): boolean {
  return typeof id === 'string' && (id.startsWith('review-source-') || id.startsWith('dataset-source-rebind:'));
}

/**
 * The trust a published App records in `dql.app.json` (and its Apps card
 * reads after a reload): how many data tiles were certified at publish.
 */
export interface PublishedAppTileTrust {
  certified: number;
  total: number;
}

export function publishedAppTileTrust(answer: Pick<AppTrustAnswer, 'certified' | 'total'>): PublishedAppTileTrust {
  return { certified: answer.certified, total: answer.total };
}

/** "3 of 4 tiles certified" from stored counts; empty for no data tiles. */
export function publishedTileTrustText(trust: PublishedAppTileTrust | null | undefined): string {
  return trust ? tileTrustCountText(trust.certified, trust.total) : '';
}
