import { useState } from 'react';
import { FileText } from 'lucide-react';
import { appTrustSummary, type ReaderTrustItem, type ReaderTrustTile } from '@zlens/core/apps/reader-trust';
import type { DashboardRunResponse } from '../../api/client';
import { AskAboutApp } from './AskAboutApp';
import { BusinessStoryPanel, dashboardRunIsSettled } from './DashboardRenderer';
import { TrustLensBar } from './ReaderTrust';
import { readerTileTrust, readerTrustCounts } from './reader-trust';
import type { ReaderPagePart } from './reader-page-structure';

type LayoutItem = Parameters<typeof readerTileTrust>[0];

/**
 * The parts of a reader's page above its tiles, drawn in App Studio's Preview
 * in the order `readerPageParts` gives (D6): the Ask box, the trust line and,
 * when the author added it, the Summary. The published App draws the same
 * parts, so Preview shows what readers will see.
 */
export function ReaderPreviewParts({
  parts,
  appName,
  items,
  run,
  onRemoveSummary,
  onAskInPreview,
  aiConnected,
}: {
  parts: ReaderPagePart[];
  appName: string;
  items: LayoutItem[];
  run: DashboardRunResponse | null;
  /** The author's Remove action on the Summary (edit mode). */
  onRemoveSummary?: () => void;
  /** A question typed in Preview is not sent; say where readers ask. */
  onAskInPreview?: () => void;
  /** `false` without an AI provider: the Ask box says Ask needs one. */
  aiConnected?: boolean;
}): JSX.Element | null {
  const [trustLens, setTrustLens] = useState(false);
  const shown = parts.filter((part) => part !== 'tiles');
  if (!shown.length) return null;
  const tileFor = (id: string) => run?.tiles.find((tile) => tile.tileId === id);
  const trusts = items.map((item) => readerTileTrust(item, tileFor(item.i)));
  const summary = appTrustSummary(
    items as unknown as ReadonlyArray<ReaderTrustItem & { i: string }>,
    run ? (run.tiles as unknown as ReadonlyArray<ReaderTrustTile & { tileId: string }>) : undefined,
  );
  return (
    <div className="studio-reader-parts" data-reader-parts={shown.join(' ')}>
      {shown.map((part) => {
        if (part === 'ask') {
          return (
            <AskAboutApp
              key="ask"
              scope={{ appId: 'preview', appName, filters: [], resultsReady: Boolean(run && dashboardRunIsSettled(run)) }}
              onAsk={() => onAskInPreview?.()}
              {...(aiConnected !== undefined ? { aiConnected } : {})}
            />
          );
        }
        if (part === 'trust') {
          return (
            <TrustLensBar
              key="trust"
              counts={readerTrustCounts(trusts)}
              summary={summary.text}
              on={trustLens}
              onToggle={() => setTrustLens((current) => !current)}
            />
          );
        }
        // The Summary: the same panel readers get, from this page's settled run.
        return run && dashboardRunIsSettled(run) && run.story
          ? <BusinessStoryPanel key="summary" story={run.story} onRemove={onRemoveSummary} />
          : (
            <section key="summary" className="studio-summary-pending" aria-label="Summary">
              <FileText size={14} aria-hidden="true" />
              <span><strong>Summary (auto-written)</strong> · written from this page's numbers once every tile is up to date.</span>
              {onRemoveSummary ? <button type="button" onClick={onRemoveSummary}>Remove Summary</button> : null}
            </section>
          );
      })}
    </div>
  );
}
