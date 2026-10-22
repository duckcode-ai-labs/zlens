import type { DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import { appTrustSummary, certifiedByLabel, tileTrustCountText, type AppTrustState, type ReaderTrustItem, type ReaderTrustTile } from '@zlens/core/apps/reader-trust';

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
 * "All data certified" with who and when (D5): "All data certified by
 * Kranthi · 21 Oct", or "All data certified · 21 Oct" with no person recorded.
 */
export function allDataCertifiedLabel(byline: string | undefined): string {
  if (!byline || byline === 'Certified') return 'All data certified';
  return `All data ${byline.charAt(0).toLowerCase()}${byline.slice(1)}`;
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
      ? allDataCertifiedLabel(summary.byline)
      : summary.total === 0 || summary.state === 'pending'
      ? summary.label
      : draftCount > 0 && summary.certified === summary.total
        ? `${summary.text} · ${draftCount} draft pending`
        : summary.text,
  };
}

/**
 * The App library card's label. It is the App's lifecycle (draft, in review,
 * certified), worded so it cannot be read as data trust, which is shown per
 * tile inside the App.
 */
export function appLifecycleLabel(
  lifecycle: string | undefined,
  certified: boolean,
  draftCount: number,
  certifier?: { by?: string; at?: string },
): string {
  if (certified) {
    // "App certified by Kranthi · 21 Oct" when ZLens recorded who and when (D5).
    const byline = certifier && (certifier.by || certifier.at) ? certifiedByLabel({ name: certifier.by, at: certifier.at }) : '';
    return byline && byline !== 'Certified' ? `App ${byline.charAt(0).toLowerCase()}${byline.slice(1)}` : 'App certified';
  }
  const stage = lifecycle === 'review' ? 'App in review' : lifecycle === 'deprecated' ? 'App deprecated' : 'App draft';
  return draftCount > 0 ? `${stage} · ${draftCount} change${draftCount === 1 ? '' : 's'} pending` : stage;
}

/** Tile trust from an App page's settled run in this session. */
export interface AppRunTrust {
  certified: number;
  total: number;
}

/**
 * The library card's seal. It reads the App's lifecycle, but never contradicts
 * the App itself (B6): it says "App certified" only when every data tile was
 * certified. The tile trust recorded at publish (`tileTrust` in
 * `dql.app.json`, the same answer the App header gives) decides it after a
 * reload; a settled run of one of its pages in this session that found tiles
 * not certified says so too. Either way the card shows the App header's own
 * words: "3 of 4 tiles certified".
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
  const pending = input.draftCount > 0 ? ` · ${input.draftCount} change${input.draftCount === 1 ? '' : 's'} pending` : '';
  const run = input.runTrust;
  if (run && run.total > 0 && run.certified < run.total && (lifecycleCertified || input.publishedTrust)) {
    return { certified: false, label: `${tileTrustCountText(run.certified, run.total)}${pending}` };
  }
  const published = input.publishedTrust;
  if (published && published.total > 0 && published.certified < published.total) {
    return { certified: false, label: `${tileTrustCountText(published.certified, published.total)}${pending}` };
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
