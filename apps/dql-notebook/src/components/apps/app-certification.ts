import type { DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import { appTrustSummary, type AppTrustState, type ReaderTrustItem, type ReaderTrustTile } from '@zlens/core/apps/reader-trust';

type DashboardLayoutItem = DashboardDocumentResponse['dashboard']['layout']['items'][number];
type RunTile = DashboardRunResponse['tiles'][number];

export interface AppCertificationRollup {
  certified: number;
  total: number;
  allCertified: boolean;
  state: AppTrustState;
  /** The header badge text. */
  label: string;
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
    label: summary.state === 'certified' || summary.total === 0 || summary.state === 'pending'
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
export function appLifecycleLabel(lifecycle: string | undefined, certified: boolean, draftCount: number): string {
  if (certified) return 'App certified';
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
 * the App itself: when a settled run of one of its pages in this session found
 * tiles that are not certified, the card shows that run's count (the same
 * words the App header shows) instead of "App certified" (B1).
 */
export function appCardSeal(input: {
  lifecycle: string | undefined;
  certification: string | undefined;
  draftCount: number;
  runTrust?: AppRunTrust | null;
}): { certified: boolean; label: string } {
  const lifecycleCertified = input.certification === 'certified' || input.lifecycle === 'certified';
  const run = input.runTrust;
  if (lifecycleCertified && run && run.total > 0 && run.certified < run.total) {
    return { certified: false, label: `${run.certified} of ${run.total} tiles certified` };
  }
  return {
    certified: lifecycleCertified,
    label: appLifecycleLabel(input.lifecycle, lifecycleCertified, input.draftCount),
  };
}

/** One App's run trust across the pages a person has opened, for its card. */
export function appRunTrustAcrossPages(pages: Record<string, AppRunTrust> | undefined): AppRunTrust | null {
  const entries = Object.values(pages ?? {});
  if (entries.length === 0) return null;
  return entries.reduce((sum, page) => ({ certified: sum.certified + page.certified, total: sum.total + page.total }), { certified: 0, total: 0 });
}
