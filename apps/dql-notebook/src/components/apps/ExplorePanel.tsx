import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Lightbulb, MessageSquare, Plus, X } from 'lucide-react';
import type { TileQuery } from '@zlens/core/apps/tile-query';
import type { DashboardDriverAnalysisV1, DashboardDriverDefinitionV1, DashboardRunResponse } from '../../api/client';
import type { CellChartConfig, QueryResult } from '../../store/types';
import type { ThemeMode } from '../../themes/notebook-theme';
import { ChartOutput } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { DriverView } from './DriverView';
import { driverPeriodLabel, formatDriverNumber } from './driver-probe';
import { drillByFields, exploreByQuery, exploreRowsQuery, rowColumns, type ExploreField, type ExploreStep, type Scalar } from './mark-actions';

type RunTile = DashboardRunResponse['tiles'][number];
export type ExploreMode = 'breakdown' | 'rows' | 'explain';
export type ExplainState =
  | { status: 'loading' }
  | { status: 'ready'; analysis: DashboardDriverAnalysisV1; definition: DashboardDriverDefinitionV1 }
  | { status: 'error'; message: string };

const humanize = (name: string) => name.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

/**
 * The Explore panel (RFC 0009 step 6a): one tile's numbers broken down by
 * any approved field, the rows behind them, and why they changed. The path
 * is a breadcrumb; clicking a bar, a row's value or a contributor goes one
 * level deeper. Every view runs as a transient tile inside the page run, so
 * it has the page's filters and contract checks and changes nothing.
 */
export function ExplorePanel({
  title,
  base,
  fields,
  initialPath,
  initialMode,
  initialBy,
  authoredColumns,
  themeMode,
  run,
  explain,
  onSaveAsTile,
  onAsk,
  onClose,
}: {
  title: string;
  base: TileQuery;
  fields: ExploreField[];
  initialPath: ExploreStep[];
  initialMode: ExploreMode;
  initialBy?: string;
  authoredColumns?: string[];
  themeMode: ThemeMode;
  run: (query: TileQuery) => Promise<{ tile?: RunTile; error?: string }>;
  explain: (path: ExploreStep[], comparison: DashboardDriverDefinitionV1['comparison']) => Promise<ExplainState>;
  onSaveAsTile?: (query: TileQuery, title: string) => void;
  onAsk?: (question: string) => void;
  onClose: () => void;
}): JSX.Element {
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [path, setPath] = useState<ExploreStep[]>(initialPath);
  const [mode, setMode] = useState<ExploreMode>(initialMode);
  const choices = drillByFields(fields, path);
  const [by, setBy] = useState<string | undefined>(initialBy ?? choices[0]?.name);
  const [view, setView] = useState<{ status: 'idle' | 'loading' } | { status: 'ready'; tile: RunTile; query: TileQuery } | { status: 'error'; message: string }>({ status: 'idle' });
  const [explained, setExplained] = useState<ExplainState>({ status: 'loading' });
  const [comparison, setComparison] = useState<DashboardDriverDefinitionV1['comparison']>('previous_period');
  const ticket = useRef(0);
  const byField = fields.find((field) => field.name === by) ?? choices[0];

  useEffect(() => {
    closeRef.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  // A field already held to one value explains nothing; move to the next one.
  useEffect(() => {
    if (!byField || !choices.some((field) => field.name === byField.name)) setBy(choices[0]?.name);
  }, [path]);

  const query = useMemo<TileQuery | null>(() => {
    if (mode === 'rows') {
      const columns = rowColumns(base, path, fields, authoredColumns);
      return columns.length ? exploreRowsQuery(base, path, columns) : null;
    }
    if (mode === 'breakdown') return byField ? exploreByQuery(base, path, byField) : null;
    return null;
  }, [mode, base, path, byField?.name, fields, authoredColumns]);

  useEffect(() => {
    const current = ++ticket.current;
    if (mode === 'explain') {
      setExplained({ status: 'loading' });
      void explain(path, comparison).then((state) => { if (current === ticket.current) setExplained(state); });
      return;
    }
    if (!query) { setView({ status: 'error', message: mode === 'rows' ? 'This data lists no columns a reader may see.' : 'This data lists no fields to break it down by.' }); return; }
    setView({ status: 'loading' });
    void run(query).then((outcome) => {
      if (current !== ticket.current) return;
      if (outcome.tile?.status === 'ok' && outcome.tile.result) setView({ status: 'ready', tile: outcome.tile, query });
      else setView({ status: 'error', message: outcome.tile?.error ?? outcome.error ?? 'This view did not run.' });
    });
  }, [mode, JSON.stringify(query), JSON.stringify(path), comparison]);

  const goInto = (step: ExploreStep) => setPath((current) => [...current, step]);
  const pickRow = (row: Record<string, unknown>) => {
    if (!byField || byField.role === 'time') return;
    const alias = byField.name;
    const value = row[alias];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return;
    goInto({ label: `${humanize(byField.name)} ${String(value)}`, filters: [{ field: byField.name, op: 'eq', values: [value as Scalar] }] });
  };

  const result = view.status === 'ready' ? view.tile.result as QueryResult : undefined;
  const trust = view.status === 'ready' ? view.tile.dataset?.trust : undefined;
  const outcome = view.status === 'ready' ? view.tile.dataset?.validation?.outcome : undefined;
  const suggestion = explained.status === 'ready' ? topContributor(explained.analysis) : null;
  const pathTitle = [title, ...path.map((step) => step.label)].join(' › ');

  // Drawn on top of the whole window, above any App header.
  return createPortal(
    <div className="dql-explore-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <style>{EXPLORE_STYLES}</style>
      <aside className="dql-explore" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <header>
          <div>
            <small>Explore</small>
            <h2 id={headingId}>{title}</h2>
          </div>
          <button ref={closeRef} type="button" className="dql-explore-close" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </header>
        <nav className="dql-explore-path" aria-label="Where you are">
          <button type="button" className={path.length === 0 ? 'on' : ''} onClick={() => setPath([])}>All</button>
          {path.map((step, index) => (
            <span key={`${step.label}-${index}`}>
              <ChevronRight size={12} aria-hidden="true" />
              <button type="button" className={index === path.length - 1 ? 'on' : ''} aria-current={index === path.length - 1 ? 'location' : undefined} onClick={() => setPath((current) => current.slice(0, index + 1))}>{step.label}</button>
            </span>
          ))}
        </nav>
        <div className="dql-explore-tabs" role="tablist" aria-label="View">
          {([['breakdown', 'Breakdown'], ['rows', 'Rows'], ['explain', 'Explain']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={mode === id} className={mode === id ? 'on' : ''} onClick={() => setMode(id)}>{label}</button>
          ))}
          {mode === 'breakdown' && choices.length ? (
            <label className="dql-explore-by">
              By
              <select value={byField?.name ?? ''} onChange={(event) => setBy(event.target.value)}>
                {choices.map((field) => <option key={field.name} value={field.name}>{humanize(field.name)}{field.role === 'time' ? ' (over time)' : ''}</option>)}
              </select>
            </label>
          ) : null}
          {mode === 'explain' ? (
            <label className="dql-explore-by">
              Compared with
              <select value={comparison} onChange={(event) => setComparison(event.target.value as DashboardDriverDefinitionV1['comparison'])}>
                <option value="previous_period">the period before</option>
                <option value="previous_year">the same period last year</option>
              </select>
            </label>
          ) : null}
        </div>
        <div className="dql-explore-body" aria-live="polite">
          {mode === 'explain' ? (
            explained.status === 'loading' ? <div className="dql-explore-loading" role="status" aria-busy="true"><span className="visually-hidden">Comparing periods…</span><i /><i /><i /></div>
              : explained.status === 'error' ? <p className="dql-explore-error" role="alert">{explained.message}</p>
                : <>
                  <p className="dql-explore-note">{driverPeriodLabel(explained.definition.anchor, explained.definition.grain)} compared with {comparison === 'previous_year' ? 'the same period last year' : 'the period before'}{path.length ? `, inside ${path.map((step) => step.label).join(' › ')}` : ''}.</p>
                  {suggestion ? (
                    <button type="button" className="dql-explore-suggest" onClick={() => goInto({ label: `${suggestion.dimension.label} ${suggestion.member.label}`, filters: [{ field: suggestion.dimension.field, op: 'eq', values: [suggestion.member.value!] }] })}>
                      <Lightbulb size={14} aria-hidden="true" />
                      <span>Most of the change is in <b>{suggestion.member.label}</b> ({formatDriverNumber(suggestion.member.delta, true)}{suggestion.member.share ? `, ${Math.round(Number(suggestion.member.share) * 100)}% of it` : ''}). Look inside it</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                  <DriverView
                    analysis={explained.analysis}
                    onMember={(dimension, member) => { if (member.value !== undefined) goInto({ label: `${dimension.label} ${member.label}`, filters: [{ field: dimension.field, op: 'eq', values: [member.value] }] }); }}
                  />
                </>
          ) : view.status === 'loading' || view.status === 'idle' ? (
            <div className="dql-explore-loading" role="status" aria-busy="true"><span className="visually-hidden">Running…</span><i /><i /><i /></div>
          ) : view.status === 'error' ? (
            <p className="dql-explore-error" role="alert">{view.message}</p>
          ) : mode === 'rows' ? (
            <TableOutput result={result!} themeMode={themeMode} maxHeight={560} initialPageSize={25} />
          ) : result && byField ? (
            <>
              <ChartOutput
                result={result}
                themeMode={themeMode}
                chartConfig={{ chart: byField.role === 'time' ? 'line' : 'bar', x: result.columns[0], y: result.columns[1], ...(byField.role === 'time' ? {} : { orientation: 'horizontal' }) } as CellChartConfig}
                availableHeight={Math.min(520, Math.max(220, (result.rows.length || 1) * 26 + 60))}
                {...(byField.role === 'time' ? {} : { onMarkSelect: pickRow })}
              />
              {byField.role !== 'time' ? <p className="dql-explore-note">Click a bar to look inside it.</p> : null}
            </>
          ) : null}
        </div>
        <footer>
          {mode !== 'explain' && trust ? <span className={`dql-explore-trust ${trust === 'certified' && (outcome === 'covered' || outcome === 'adapted') ? 'certified' : 'review'}`}>{trust === 'certified' && (outcome === 'covered' || outcome === 'adapted') ? 'Certified data · checked against its contract' : 'Not certified yet'}</span> : null}
          {mode === 'explain' ? <small>Every number here comes from comparisons on this tile's data, with the page's filters. No AI was used.</small> : null}
          <span className="dql-explore-actions">
            {onAsk ? <button type="button" onClick={() => onAsk(`In "${pathTitle}", what explains these numbers, and what should I look at next?`)}><MessageSquare size={13} aria-hidden="true" /> Ask about this</button> : null}
            {onSaveAsTile && view.status === 'ready' && mode !== 'explain' ? <button type="button" className="primary" onClick={() => onSaveAsTile(view.query, savedTitle(base, path, mode === 'rows' ? undefined : byField?.name))}><Plus size={13} aria-hidden="true" /> Save as tile</button> : null}
          </span>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}

/** A saved view's title: what it measures, by what, inside which path. "Revenue by Order Id · Region US". */
export function savedTitle(base: TileQuery, path: ExploreStep[], by?: string): string {
  const measures = base.measures.map((measure) => humanize(measure.measure));
  const head = by ? `${measures.join(' and ') || 'Values'} by ${humanize(by)}` : 'Rows';
  return path.length ? `${head} · ${path.map((step) => step.label).join(' › ')}` : head;
}

/** The contributor that explains most of the change, when it can be looked inside. */
export function topContributor(analysis: DashboardDriverAnalysisV1): { dimension: { field: string; label: string }; member: DashboardDriverAnalysisV1['dimensions'][number]['members'][number] } | null {
  let best: ReturnType<typeof topContributor> = null;
  let bestSize = 0;
  const change = Math.abs(Number(analysis.headline.delta ?? 0));
  for (const dimension of analysis.dimensions) {
    for (const member of dimension.members) {
      if (member.other || member.value === undefined) continue;
      const size = Math.abs(Number(member.delta ?? 0));
      if (size > bestSize) { bestSize = size; best = { dimension: { field: dimension.field, label: dimension.label }, member }; }
    }
  }
  // Worth pointing at only when one member carries a real part of the change.
  return best && change > 0 && bestSize / change >= 0.25 ? best : null;
}

const EXPLORE_STYLES = `
.dql-explore-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(15, 17, 22, .28); display: flex; justify-content: flex-end; }
.dql-explore { width: min(560px, 100vw); height: 100%; display: grid; grid-template-rows: auto auto auto minmax(0,1fr) auto; background: var(--dql-app-surface, var(--bg-2)); color: var(--dql-app-ink, var(--text-primary)); border-left: 1px solid var(--dql-app-line, var(--border-default)); box-shadow: -12px 0 32px rgba(0,0,0,.14); font: 400 13px/1.45 var(--font-ui, inherit); font-variant-numeric: tabular-nums; }
.dql-explore > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 16px 8px; }
.dql-explore > header small { color: var(--dql-app-muted, var(--text-secondary)); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.dql-explore > header h2 { margin: 2px 0 0; font-size: 16px; font-weight: 600; line-height: 1.3; }
.dql-explore-close { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
.dql-explore-close:hover, .dql-explore-close:focus-visible { background: var(--dql-app-control, var(--bg-1)); outline: none; }
.dql-explore-path { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 0 16px 8px; color: var(--dql-app-muted, var(--text-secondary)); }
.dql-explore-path span { display: inline-flex; align-items: center; gap: 2px; }
.dql-explore-path button { padding: 2px 6px; border: 0; border-radius: 4px; background: transparent; color: var(--dql-app-accent, var(--accent)); font: inherit; cursor: pointer; }
.dql-explore-path button.on { color: var(--dql-app-ink, var(--text-primary)); font-weight: 600; cursor: default; }
.dql-explore-path button:hover:not(.on), .dql-explore-path button:focus-visible { background: var(--dql-app-control, var(--bg-1)); outline: none; }
.dql-explore-tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 16px 10px; border-bottom: 1px solid var(--dql-app-line, var(--border-subtle)); }
.dql-explore-tabs > button { height: 28px; padding: 0 10px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--dql-app-muted, var(--text-secondary)); font: 500 13px/1 var(--font-ui, inherit); cursor: pointer; }
.dql-explore-tabs > button.on { border-color: var(--dql-app-line, var(--border-default)); background: var(--dql-app-control, var(--bg-1)); color: var(--dql-app-ink, var(--text-primary)); font-weight: 600; }
.dql-explore-by { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; color: var(--dql-app-muted, var(--text-secondary)); font-size: 12px; }
.dql-explore-by select { height: 28px; max-width: 220px; border: 1px solid var(--dql-app-line, var(--border-default)); border-radius: 8px; background: var(--dql-app-surface, var(--bg-2)); color: var(--dql-app-ink, var(--text-primary)); font: inherit; font-size: 12px; }
.dql-explore-body { min-height: 0; overflow: auto; padding: 14px 16px; display: grid; align-content: start; gap: 12px; }
.dql-explore-note { margin: 0; color: var(--dql-app-muted, var(--text-secondary)); font-size: 12px; }
.dql-explore-error { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--status-error-bg, rgba(193,69,69,.08)); color: var(--dql-app-ink, var(--text-primary)); }
.dql-explore-loading { display: grid; gap: 10px; }
.dql-explore-loading i { display: block; height: 28px; border-radius: 8px; background: var(--dql-app-control, var(--bg-1)); }
.dql-explore-loading i:nth-child(2) { width: 82%; } .dql-explore-loading i:nth-child(3) { width: 64%; }
.dql-explore-suggest { display: grid; grid-template-columns: 16px minmax(0,1fr) 16px; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--dql-app-accent, var(--accent)) 35%, transparent); border-radius: 12px; background: var(--dql-app-accent-soft, var(--accent-dim)); color: var(--dql-app-ink, var(--text-primary)); font: inherit; text-align: left; cursor: pointer; }
.dql-explore-suggest svg { color: var(--dql-app-accent, var(--accent)); }
.dql-explore-suggest:hover, .dql-explore-suggest:focus-visible { border-color: var(--dql-app-accent, var(--accent)); outline: none; }
.dql-explore > footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 16px 14px; border-top: 1px solid var(--dql-app-line, var(--border-subtle)); color: var(--dql-app-muted, var(--text-secondary)); }
.dql-explore > footer small { font-size: 12px; }
.dql-explore-trust { font-size: 12px; font-weight: 600; }
.dql-explore-trust.certified { color: var(--trust-certified, #0b7a75); }
.dql-explore-trust.review { color: var(--trust-review, #a8641a); }
.dql-explore-actions { margin-left: auto; display: inline-flex; gap: 6px; }
.dql-explore-actions button { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 10px; border: 1px solid var(--dql-app-line, var(--border-default)); border-radius: 8px; background: var(--dql-app-surface, var(--bg-2)); color: var(--dql-app-ink, var(--text-primary)); font: 500 12px/1 var(--font-ui, inherit); cursor: pointer; }
.dql-explore-actions button.primary { border-color: var(--dql-app-accent, var(--accent)); background: var(--dql-app-accent, var(--accent)); color: var(--accent-fg, #fff); }
.dql-explore-actions button:focus-visible { outline: 2px solid var(--dql-app-accent, var(--accent)); outline-offset: 1px; }
@media (prefers-reduced-motion: no-preference) { .dql-explore { animation: dql-explore-in .18s ease-out; } @keyframes dql-explore-in { from { transform: translateX(24px); opacity: .6; } to { transform: none; opacity: 1; } } }
`;
