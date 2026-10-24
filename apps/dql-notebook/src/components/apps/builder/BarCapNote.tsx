import { BAR_CATEGORY_CAP, barCapNote, type BarCategoryCap } from './sort-top-n';

/** "Showing top 25 of 935 · Show all", or "Showing all 935 · Top 25" after the reader asked. */
export function BarCapNote({ cap, showAll, onShowAll }: { cap: BarCategoryCap | null; showAll: boolean; onShowAll: (value: boolean) => void }): JSX.Element | null {
  if (!cap?.cappable) return null;
  return (
    <p className="bar-cap-note" role="note" style={{ margin: '2px 0 4px', fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span>{showAll ? (cap.loaded < cap.total ? `Showing the first ${cap.loaded.toLocaleString('en-US')} of ${cap.total.toLocaleString('en-US')}` : `Showing all ${cap.total.toLocaleString('en-US')}`) : barCapNote(cap)}</span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onShowAll(!showAll); }}
        style={{ border: 0, padding: 0, background: 'none', color: 'var(--accent)', font: 'inherit', fontWeight: 600, cursor: 'pointer' }}
      >{showAll ? `Top ${BAR_CATEGORY_CAP}` : 'Show all'}</button>
    </p>
  );
}
