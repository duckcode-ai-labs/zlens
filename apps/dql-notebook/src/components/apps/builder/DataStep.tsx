import { ArrowLeft, ArrowRight, Database, FileText, ShieldCheck } from 'lucide-react';
import type { AppBlockRecommendation, AppStudioBuildDraft } from '../../../api/client';
import { AddDataBrowser, RemoveDataButton, type AddDataBrowserProps } from './AddDataBrowser';
import { humanize } from './studio-ui';
import { appDataItems, openCanvasLabel, sourceCatalogKindLabel, tilesUsingSource, trustLabel } from './app-data';

/**
 * The Data step (design D3): a new manual App picks its data before the
 * canvas opens, like a Tableau data source page. Left: the App's data (its
 * draft sources). Right: the Add data browser. Nothing new is stored beyond
 * the draft's sources.
 */
export function DataStep({
  draft,
  known,
  error,
  onBack,
  onDismissError,
  onOpenCanvas,
  onSkip,
  browser,
}: {
  draft: AppStudioBuildDraft;
  /** Catalog records already seen, so each row can show its domain and owner. */
  known: AppBlockRecommendation[];
  error?: string | null;
  onBack: () => void;
  onDismissError?: () => void;
  onOpenCanvas: () => void;
  onSkip: () => void;
  browser: Omit<AddDataBrowserProps, 'draft' | 'sourcePolicy' | 'draftId'>;
}): JSX.Element {
  const items = appDataItems(draft.sources, known);
  return <section className="studio-data-step" aria-labelledby="studio-data-step-title">
    <header className="data-step-header">
      <button type="button" className="ghost-icon" onClick={onBack} aria-label="Back to Apps" title="Back to Apps"><ArrowLeft size={16} /></button>
      <div>
        <small>{draft.name}</small>
        <h1 id="studio-data-step-title">Data for this App</h1>
        <p>Pick the data this App will use. You can add more later from the Data panel.</p>
      </div>
    </header>
    {error ? <div className="studio-error" role="alert">{error}{onDismissError ? <button type="button" onClick={onDismissError} aria-label="Dismiss">×</button> : null}</div> : null}
    <div className="data-step-body">
      <aside className="data-step-list" aria-labelledby="data-step-list-title">
        <div className="data-step-list-head"><h2 id="data-step-list-title">This App's data</h2><small>{items.length} {items.length === 1 ? 'source' : 'sources'}</small></div>
        {items.length ? <ul>
          {items.map((item) => {
            const certified = item.trust ? item.trust === 'certified' : item.status === 'certified';
            const sourceId = item.sourceId ?? item.id;
            return <li key={sourceId}>
              <span className={`add-data-mark ${certified ? 'certified' : 'review'}`}>{certified ? <ShieldCheck size={14} /> : <FileText size={14} />}</span>
              <p><strong title={item.name}>{humanize(item.name)}</strong><small>{[sourceCatalogKindLabel(item), trustLabel(certified ? 'certified' : 'review'), item.domain && item.domain !== 'Unassigned' ? humanize(item.domain) : ''].filter(Boolean).join(' · ')}</small></p>
              <RemoveDataButton name={humanize(item.name)} tileCount={tilesUsingSource(draft, sourceId).length} disabled={browser.disabled} onRemove={() => browser.onRemove(sourceId)} />
            </li>;
          })}
        </ul> : <div className="data-step-empty"><Database size={18} aria-hidden="true" /><p><strong>No data yet</strong><small>Add a Dataset, Metrics or a saved query from the list, or start from a database table.</small></p></div>}
      </aside>
      <div className="data-step-browser">
        <AddDataBrowser {...browser} draftId={draft.id} draft={draft} sourcePolicy={draft.sourcePolicy} />
      </div>
    </div>
    <footer className="data-step-footer">
      <button type="button" onClick={onSkip}>Skip, start empty</button>
      <button type="button" className="primary" onClick={onOpenCanvas}>{openCanvasLabel(items.length)} <ArrowRight size={14} /></button>
    </footer>
  </section>;
}
