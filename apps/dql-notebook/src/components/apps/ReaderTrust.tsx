import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AlertTriangle, Ban, ShieldCheck, X } from 'lucide-react';
import { splitTechnicalRows, type ReaderTrust, type ReaderTrustState, type ReceiptRow } from './reader-trust';
import { tileTrustCountText } from '@zlens/core/apps/reader-trust';

const ICONS: Record<ReaderTrustState, typeof ShieldCheck> = {
  certified: ShieldCheck,
  // A legacy semantic-model result reads "Not certified yet" like `review` (T1).
  governed: AlertTriangle,
  review: AlertTriangle,
  blocked: Ban,
};

export function TrustStateIcon({ state, size = 12 }: { state: ReaderTrustState; size?: number }): JSX.Element {
  const Icon = ICONS[state];
  return <Icon size={size} strokeWidth={2.2} aria-hidden="true" />;
}

/** Receipt rows as a definition list. */
function ReceiptRows({ rows }: { rows: ReceiptRow[] }): JSX.Element {
  return (
    <dl>
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.code ? 'code' : undefined}>{row.list ? <ul className="dql-receipt-list">{row.list.map((entry) => <li key={entry}>{entry}</li>)}</ul> : row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Plain rows first; ids, hashes, file paths and fingerprints under a
 * **Technical details** toggle that starts collapsed (D6).
 */
export function ReceiptBody({ rows }: { rows: ReceiptRow[] }): JSX.Element {
  const { plain, technical } = splitTechnicalRows(rows);
  return (
    <>
      <ReceiptRows rows={plain} />
      {technical.length ? (
        <details className="dql-technical-details">
          <summary>Technical details</summary>
          <ReceiptRows rows={technical} />
        </details>
      ) : null}
    </>
  );
}

/**
 * The trust label on a reader tile. It is a button: it opens the tile's
 * receipt, the evidence behind its numbers. A certified tile says who
 * certified it and when: "Certified by Kranthi · 21 Oct" (D5).
 */
export function ReaderTrustBadge({
  trust,
  freshness,
  receipt,
  open,
  onOpenChange,
  onShowEvidence,
}: {
  trust: ReaderTrust;
  freshness: string | null;
  receipt: ReceiptRow[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the full "how this was computed" panel with the query and SQL. */
  onShowEvidence?: () => void;
}): JSX.Element {
  const popoverId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onOpenChange(false); };
    const onDown = (event: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open, onOpenChange]);
  return (
    <span ref={anchorRef} className="dql-trust-anchor" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`dql-trust-badge ${trust.state}`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={`${trust.byline ?? trust.label}: ${trust.detail}${freshness ? ` ${freshness}.` : ''} Click for the receipt.`}
        onClick={() => onOpenChange(!open)}
      >
        <TrustStateIcon state={trust.state} size={11} />
        <span>{trust.byline ?? trust.label}</span>
        {/* Who and when already date a certified tile; its freshness is in the receipt and the tooltip. */}
        {freshness && !(trust.byline && trust.byline !== trust.label) ? <span className="dql-trust-age">· {freshness}</span> : null}
      </button>
      {open ? (
        <div id={popoverId} className="dql-receipt" role="dialog" aria-label="Receipt for this tile">
          <header>
            <span className={`dql-receipt-state ${trust.state}`}><TrustStateIcon state={trust.state} size={13} /> {trust.byline ?? trust.label}</span>
            <button type="button" className="dql-receipt-close" aria-label="Close receipt" onClick={() => onOpenChange(false)}><X size={13} /></button>
          </header>
          <p>{trust.detail}</p>
          <ReceiptBody rows={receipt.filter((row) => row.label !== 'Certified')} />
          {onShowEvidence ? (
            <button type="button" className="dql-receipt-more" onClick={() => { onOpenChange(false); onShowEvidence(); }}>
              Show the query and SQL
            </button>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

/**
 * Page-level trust summary for readers, with the Trust Lens switch. With the
 * lens on, every tile is outlined in its trust colour, so anything not
 * certified stands out at a glance.
 */
export function TrustLensBar({
  counts,
  summary,
  on,
  onToggle,
  actions,
}: {
  counts: Array<{ state: ReaderTrustState; label: string; count: number }>;
  /** The page's aggregate trust sentence (`appTrustSummary().text`); derived from counts when absent. */
  summary?: string;
  on: boolean;
  onToggle: () => void;
  /** Page actions shown at the end of the bar, such as Export. */
  actions?: ReactNode;
}): JSX.Element | null {
  if (!counts.length) return null;
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const certified = counts.find((entry) => entry.state === 'certified')?.count ?? 0;
  return (
    <div className="dql-trust-lens-bar" role="group" aria-label="Trust on this page">
      <span className="dql-trust-summary">
        {summary || tileTrustCountText(certified, total)}
      </span>
      {on ? counts.map((entry) => (
        <span key={entry.state} className={`dql-trust-count ${entry.state}`}>
          <TrustStateIcon state={entry.state} size={11} /> {entry.count} {entry.label.toLowerCase()}
        </span>
      )) : null}
      <button type="button" className={`dql-trust-lens-toggle ${on ? 'on' : ''}`} aria-pressed={on} onClick={onToggle}>
        Trust lens
      </button>
      {actions}
    </div>
  );
}

/** A tile description is short markdown; readers get it as plain text. */
export function plainDescription(markdown: string): string {
  return markdown
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/\*([^*]+)\*|_([^_]+)_/g, '$1$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
