/**
 * One trust answer for an App (B6). Every surface that says how trusted an
 * App's data is — the publish check, the editor's tile dots, the App header,
 * the Apps card and the `dql.app.json` written at publish — reads it from
 * here, so they can never disagree.
 *
 * Trust is decided from what the page is built from, not from the reader's
 * current filter values: each tile's source, every join it can run through
 * (its own fields, and every page filter mapped to it through a related
 * field, whether or not a value is picked), its calculations, and whether
 * the author allowed data that needs review. Each tile is then labelled by
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
  /** Data tiles labelled Needs review. */
  needsReview: number;
  allCertified: boolean;
  /**
   * Tiles that need review and are published only because the author chose
   * "Allow data that needs review" (0 under "Only certified data").
   */
  reviewAllowed: number;
  /** "All data certified", "3 of 4 tiles certified", "No data tiles". */
  label: string;
  /** "All 4 tiles certified", "3 of 4 tiles certified"; empty with no data tiles. */
  text: string;
}

export interface AppTrustInput {
  pages: readonly AppTrustPageLike[];
  sourceFor: (sourceId: string) => AppTrustSourceLike | undefined;
  /** `include_review_required` when the author allowed data that needs review. */
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
    const joins = tileJoinsReachable(page, tile, descriptor).joins.map((join) => ({
      id: join.id,
      trust: input.joinTrust?.(page.id, tile.i, join) ?? join.trust,
    }));
    return {
      status: 'ok',
      tileType: 'dataset',
      dataset: { trust: certified ? 'certified' : 'review_required', checked: source.checked ?? null, joins },
      ...(source.certification ? { certification: source.certification } : {}),
    };
  }
  if (tile.semantic && !tile.block) {
    // A governed semantic query: Governed, never Certified on its own.
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
    allCertified: summary.allCertified,
    reviewAllowed: input.sourcePolicy === 'include_review_required' ? needsReview : 0,
    label: summary.label,
    text: summary.text,
  };
}

/** One tile's answer, or undefined for a tile that carries no data. */
export function appTileTrustFor(answer: AppTrustAnswer, pageId: string, tileId: string): AppTileTrust | undefined {
  return answer.tiles.find((tile) => tile.pageId === pageId && tile.tileId === tileId);
}

/** "1 tile needs review", "3 tiles need review". */
export function tilesNeedReviewText(count: number): string {
  return `${count} ${count === 1 ? 'tile needs' : 'tiles need'} review`;
}

/**
 * What the publish check says once nothing is left to fix. It never says
 * "Every check passed" while a tile needs review: data that needs review
 * that the author allowed is named — "1 tile needs review (allowed)".
 */
export function publishReadyLine(answer: Pick<AppTrustAnswer, 'needsReview' | 'allCertified' | 'certified' | 'total'>): {
  /** "Every check passed." or "1 tile needs review (allowed)". */
  detail: string;
  allPassed: boolean;
} {
  if (answer.needsReview > 0) return { detail: `${tilesNeedReviewText(answer.needsReview)} (allowed)`, allPassed: false };
  return { detail: 'Every check passed.', allPassed: true };
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
