import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { bindingCaption, type StoryBinding, type StoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import type { ReaderTrust } from '@zlens/core/apps/reader-trust';
import type { DashboardDocumentResponse, DashboardRunResponse } from '../../api/client';
import { readerTileReceipt, readerTileTrust, type ReceiptRow } from './reader-trust';

/** Everything a reader should know about one number in a Report or Custom layout. */
export interface NumberReceiptInfo {
  /** What the number is, in plain words: "Revenue for OL-001". */
  label: string;
  value: string;
  /** The tile it comes from. */
  tileTitle?: string;
  trust?: ReaderTrust | null;
  /** Where it came from and under which filters; fingerprints are left to the tile's own receipt. */
  rows: ReceiptRow[];
}

/** "Revenue by region — revenue for US" reads as "Revenue for US" under its tile's title. */
export function plainBindingLabel(binding: Pick<StoryBinding, 'label'> & Partial<Pick<StoryBinding, 'key' | 'tileId'>>, catalog?: StoryBindingCatalog): string {
  return bindingCaption(binding, catalog);
}

const READER_ROWS = new Set(['Source', 'Certified', 'Owner', 'Joined', 'Calculations', 'Filters', 'Last refreshed', 'Cached at']);

/** The receipt for one bound number: its words, value, tile, trust and the rows a reader needs. */
export function numberReceiptInfo(
  binding: StoryBinding | undefined,
  items: DashboardDocumentResponse['dashboard']['layout']['items'],
  run: Pick<DashboardRunResponse, 'runId' | 'snapshotId' | 'filterFingerprint' | 'tiles'> | null | undefined,
  ranAtMs?: number,
  catalog?: StoryBindingCatalog,
): NumberReceiptInfo | null {
  const item = binding ? items.find((candidate) => candidate.i === binding.tileId) : undefined;
  if (!binding || !item) return null;
  const tile = run?.tiles.find((candidate) => candidate.tileId === item.i);
  return {
    label: plainBindingLabel(binding, catalog),
    value: binding.display,
    ...(item.title ? { tileTitle: item.title } : {}),
    trust: readerTileTrust(item, tile),
    rows: readerReceiptRows(readerTileReceipt(item, tile, run ? { runId: run.runId, snapshotId: run.snapshotId, filterFingerprint: run.filterFingerprint } : null, ranAtMs)),
  };
}

/** The rows a reader needs, without the fingerprints the tile's own receipt already shows. */
export function readerReceiptRows(rows: ReceiptRow[]): ReceiptRow[] {
  return rows.filter((row) => READER_ROWS.has(row.label));
}

export function NumberReceiptCard({ info }: { info: NumberReceiptInfo }): JSX.Element {
  return (
    <div className="dql-number-receipt-card">
      <header>
        <span>{info.label}</span>
        <strong>{info.value}</strong>
      </header>
      {info.trust ? <p className={`dql-number-receipt-trust ${info.trust.state}`}><b>{info.trust.byline ?? info.trust.label}</b> · {info.trust.detail}</p> : null}
      <dl>
        {info.tileTitle ? <div><dt>Tile</dt><dd>{info.tileTitle}</dd></div> : null}
        {info.rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
      </dl>
    </div>
  );
}

/** The receipt beside a number, drawn on top of the page. */
export function NumberReceiptPopover({
  info,
  at,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  info: NumberReceiptInfo;
  /** The number's box, in window pixels. */
  at: { left: number; top: number; bottom: number };
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: at.left, top: at.bottom + 6 });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(8, Math.min(at.left, window.innerWidth - box.width - 8));
    const below = at.bottom + 6;
    const top = below + box.height > window.innerHeight - 8 ? Math.max(8, at.top - box.height - 6) : below;
    setPosition({ left, top });
  }, [at.left, at.top, at.bottom]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} className="dql-number-receipt" role="dialog" aria-label={`About ${info.label}`} style={{ left: position.left, top: position.top }} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <style>{NUMBER_RECEIPT_STYLES}</style>
      <NumberReceiptCard info={info} />
    </div>,
    document.body,
  );
}

/**
 * A bound number in text that explains itself: hover, focus or tap shows
 * its receipt; a tap keeps it open until Esc or a tap elsewhere.
 */
export function ReceiptValue({ className, children, info, fallbackTitle }: { className: string; children: ReactNode; info: NumberReceiptInfo | null; fallbackTitle: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState<null | 'hover' | 'pinned'>(null);
  const timer = useRef<number | null>(null);
  const clear = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };
  const show = (mode: 'hover' | 'pinned') => { clear(); setOpen((current) => (current === 'pinned' ? current : mode)); };
  const hide = () => { clear(); timer.current = window.setTimeout(() => setOpen((current) => (current === 'hover' ? null : current)), 160); };
  useEffect(() => {
    if (open !== 'pinned') return undefined;
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node) && !(event.target as Element | null)?.closest?.('.dql-number-receipt')) setOpen(null);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => clear, []);
  if (!info) return <span className={className} tabIndex={0} title={fallbackTitle}>{children}</span>;
  const box = open ? ref.current?.getBoundingClientRect() : undefined;
  return (
    <>
      <span
        ref={ref}
        className={`${className} has-receipt`}
        tabIndex={0}
        role="button"
        aria-expanded={Boolean(open)}
        aria-label={`${info.label}: ${info.value}. Show where this number comes from`}
        onPointerEnter={() => show('hover')}
        onPointerLeave={hide}
        onFocus={() => show('hover')}
        onBlur={hide}
        onClick={() => setOpen((current) => (current === 'pinned' ? null : 'pinned'))}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((current) => (current === 'pinned' ? null : 'pinned')); } }}
      >
        {children}
      </span>
      {open && box ? <NumberReceiptPopover info={info} at={{ left: box.left, top: box.top, bottom: box.bottom }} onClose={() => setOpen(null)} onPointerEnter={clear} onPointerLeave={hide} /> : null}
    </>
  );
}

export const NUMBER_RECEIPT_STYLES = `
.dql-number-receipt { position: fixed; z-index: 1000; width: 300px; padding: 12px; border: 1px solid var(--dql-app-line, var(--border-default)); border-radius: 12px; background: var(--dql-app-surface, var(--bg-2)); color: var(--dql-app-ink, var(--text-primary)); box-shadow: 0 12px 32px rgba(0,0,0,.16); font: 400 12px/1.45 var(--font-ui, inherit); font-variant-numeric: tabular-nums; }
.dql-number-receipt-card { display: grid; gap: 8px; }
.dql-number-receipt-card header { display: grid; gap: 2px; }
.dql-number-receipt-card header span { color: var(--dql-app-muted, var(--text-secondary)); font-size: 12px; }
.dql-number-receipt-card header strong { font-size: 20px; font-weight: 600; line-height: 1.2; }
.dql-number-receipt-trust { margin: 0; padding: 6px 8px; border-radius: 8px; background: var(--dql-app-control, var(--bg-1)); color: var(--dql-app-muted, var(--text-secondary)); }
.dql-number-receipt-trust b { font-weight: 600; }
.dql-number-receipt-trust.certified b { color: var(--trust-certified, #0b7a75); }
.dql-number-receipt-trust.governed b { color: var(--trust-governed, #3659c9); }
.dql-number-receipt-trust.review b { color: var(--trust-review, #a8641a); }
.dql-number-receipt-trust.blocked b { color: var(--trust-blocked, #c14545); }
.dql-number-receipt-card dl { margin: 0; display: grid; gap: 4px; }
.dql-number-receipt-card dl div { display: grid; grid-template-columns: 72px minmax(0,1fr); gap: 8px; }
.dql-number-receipt-card dt { color: var(--dql-app-muted, var(--text-secondary)); }
.dql-number-receipt-card dd { margin: 0; overflow-wrap: anywhere; }
.dql-story-value.has-receipt { cursor: help; text-decoration: underline dotted; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); text-underline-offset: 3px; }
.dql-story-value.has-receipt:focus-visible { outline: 2px solid var(--dql-app-accent, var(--accent)); outline-offset: 2px; border-radius: 2px; }
`;
