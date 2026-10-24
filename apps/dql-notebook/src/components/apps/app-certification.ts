import type { DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import { ALL_TILES_CERTIFIED, NOT_CERTIFIED_YET, appTrustSummary, tileTrustCountText, type AppTrustState, type ReaderTrustItem, type ReaderTrustTile } from '@zlens/core/apps/reader-trust';

type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type RunTile = DashboardRunResponse['tiles'][number];

export interface AppCertificationRollup {
  certified: number;
  total: number;
  allCertified: boolean;
  state: AppTrustState;
  /** The header badge text. */
  label: string;
  /** Who certified the page's certified tiles and when: "Certified by Kranthi · 21 Oct" (D5). */
  byline?: string;
}

/**
 * The App header's words when every tile is certified (T2): the same count
 * text the Apps card, the publish dialog and the stored file use — "All
 * tiles certified". Who certified each tile is on the tile itself ("Certified
 * by Kranthi · 21 Oct"), never a separate App-level badge.
 */
export function allDataCertifiedLabel(_byline?: string): string {
  return ALL_TILES_CERTIFIED;
}

/** "1 unpublished change", "3 unpublished changes": an App's pending edits (a lifecycle, not a trust word). */
export function unpublishedChangesText(count: number): string {
  return `${count} unpublished ${count === 1 ? 'change' : 'changes'}`;
}

/**
 * The App header badge. It is the same aggregate the page's Trust Lens line,
 * story and tiles use (`appTrustSummary` in dql-core): derived from the
 * current run's tile evidence, which the server resolves against each tile's
 * source as it is now. A saved dashboard's own fields (a bare block reference,
 * a stamped `trustState`) are never enough to say "certified": the source
 * behind them may have been edited or demoted since. Before a run settles the
 * badge says trust has not been checked yet.
 *
 * A pending App draft is a review state of its own, so it also keeps the App
 * from reading "All data certified".
 */
export function appCertificationRollup(
  items: ReadonlyArray<DashboardLayoutItem> | undefined,
  draftCount = 0,
  runTiles?: ReadonlyArray<RunTile> | null,
): AppCertificationRollup {
  const tileMap = runTiles ? new Map(runTiles.map((tile) => [tile.tileId, tile as unknown as ReaderTrustTile])) : undefined;
  const summary = appTrustSummary(
    (items ?? []) as unknown as ReadonlyArray<ReaderTrustItem & { i: string }>,
    tileMap,
    { pendingDrafts: draftCount },
  );
  return {
    certified: summary.certified,
    total: summary.total,
    allCertified: summary.allCertified,
    state: summary.state,
    ...(summary.byline ? { byline: summary.byline } : {}),
    label: summary.state === 'certified'
      ? ALL_TILES_CERTIFIED
      : summary.total === 0 || summary.state === 'pending'
      ? summary.label
      : draftCount > 0 && summary.certified === summary.total
        ? `${summary.text} · ${unpublishedChangesText(draftCount)}`
        : summary.text,
  };
}

/**
 * The App library card's label when no tile count is known (an App
 * published before tile counts were recorded). Trust lives at the tile (T2),
 * so the card never says "App certified": it says "All tiles certified" for
 * an App published as certified, "Not certified yet" otherwise, and
 * "Retired" for a deprecated App.
 */
export function appLifecycleLabel(
  lifecycle: string | undefined,
  certified: boolean,
  draftCount: number,
  _certifier?: { by?: string; at?: string },
): string {
  const pending = draftCount > 0 ? ` · ${unpublishedChangesText(draftCount)}` : '';
  if (lifecycle === 'deprecated') return `Retired${pending}`;
  return `${certified ? ALL_TILES_CERTIFIED : NOT_CERTIFIED_YET}${pending}`;
}

/** Tile trust from an App page's settled run in this session. */
export interface AppRunTrust {
  certified: number;
  total: number;
}

/**
 * The library card's seal (T2): the App header's own words, from the same
 * count — "All tiles certified" or "3 of 4 tiles certified". The tile trust
 * recorded at publish (`tileTrust` in `dql.app.json`) decides it after a
 * reload; a settled run of one of its pages in this session that found tiles
 * not certified says so too.
 */
export function appCardSeal(input: {
  lifecycle: string | undefined;
  certification: string | undefined;
  draftCount: number;
  runTrust?: AppRunTrust | null;
  /** The tile trust recorded when the App was published. */
  publishedTrust?: AppRunTrust | null;
  /** Who published the App as certified, and when. */
  certifiedBy?: string;
  certifiedAt?: string;
}): { certified: boolean; label: string } {
  const lifecycleCertified = input.certification === 'certified' || input.lifecycle === 'certified';
  const pending = input.draftCount > 0 ? ` · ${unpublishedChangesText(input.draftCount)}` : '';
  const run = input.runTrust;
  if (run && run.total > 0 && run.certified < run.total && (lifecycleCertified || input.publishedTrust)) {
    return { certified: false, label: `${tileTrustCountText(run.certified, run.total)}${pending}` };
  }
  const published = input.publishedTrust;
  if (published && published.total > 0) {
    const all = published.certified >= published.total;
    return { certified: all, label: `${tileTrustCountText(published.certified, published.total)}${pending}` };
  }
  return {
    certified: lifecycleCertified,
    label: appLifecycleLabel(input.lifecycle, lifecycleCertified, input.draftCount, { by: input.certifiedBy, at: input.certifiedAt }),
  };
}

/** One App's run trust across the pages a person has opened, for its card. */
export function appRunTrustAcrossPages(pages: Record<string, AppRunTrust> | undefined): AppRunTrust | null {
  const entries = Object.values(pages ?? {});
  if (entries.length === 0) return null;
  return entries.reduce((sum, page) => ({ certified: sum.certified + page.certified, total: sum.total + page.total }), { certified: 0, total: 0 });
}
