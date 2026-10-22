import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import type { DashboardDriverAnalysisV1, DashboardDriverDefinitionV1 } from '../../api/client';
import { driverPeriodLabel, formatDriverNumber, formatDriverShare } from './driver-probe';

/**
 * "Why did it move?" (RFC 0008 step 7): a change split member by member for
 * each dimension. Increases are blue ▲ and decreases orange ▼ (never red
 * and green), bars are scaled per dimension, and the shares come straight
 * from the governed comparison results.
 */
type DriverMember = DashboardDriverAnalysisV1['dimensions'][number]['members'][number];

export function DriverView({ analysis, compact = false, onMember }: {
  analysis: DashboardDriverAnalysisV1;
  compact?: boolean;
  /** Look inside one contributor: the explanation drills into it (RFC 0009 step 6a). */
  onMember?: (dimension: { field: string; label: string }, member: DriverMember) => void;
}): JSX.Element {
  const period = `${driverPeriodLabel(analysis.periods.current.start, analysis.grain)} vs ${driverPeriodLabel(analysis.periods.prior.start, analysis.grain)}`;
  const delta = Number(analysis.headline.delta ?? NaN);
  const dimensions = compact ? analysis.dimensions.slice(0, 2) : analysis.dimensions;
  return (
    <div className={`dql-driver ${compact ? 'compact' : ''}`}>
      <style>{DRIVER_STYLES}</style>
      <p className="dql-driver-summary">{analysis.summary}</p>
      <dl className="dql-driver-headline">
        <div><dt>{driverPeriodLabel(analysis.periods.current.start, analysis.grain)}</dt><dd>{formatDriverNumber(analysis.headline.current)}</dd></div>
        <div><dt>{driverPeriodLabel(analysis.periods.prior.start, analysis.grain)}</dt><dd>{formatDriverNumber(analysis.headline.prior)}</dd></div>
        <div>
          <dt>Change</dt>
          <dd className={Number.isFinite(delta) && delta !== 0 ? (delta > 0 ? 'up' : 'down') : undefined}>
            {Number.isFinite(delta) && delta !== 0 ? (delta > 0 ? '▲ ' : '▼ ') : ''}{formatDriverNumber(analysis.headline.delta, true)}
            {analysis.headline.percentDelta ? <small> ({formatDriverNumber(analysis.headline.percentDelta, true)}%)</small> : null}
          </dd>
        </div>
      </dl>
      <span className="visually-hidden">{period}</span>
      {dimensions.map((dimension) => {
        const largest = Math.max(...dimension.members.map((member) => Math.abs(Number(member.delta ?? 0))), 0);
        return (
          <section key={dimension.field} className="dql-driver-dimension" aria-label={`Change by ${dimension.label}`}>
            <header>
              <strong>By {dimension.label.toLowerCase()}</strong>
              <span>{dimension.memberCount} {dimension.memberCount === 1 ? 'member' : 'members'}{dimension.reconciles ? ' · adds up to the change' : dimension.residual ? ` · ${formatDriverNumber(dimension.residual, true)} not accounted for` : ''}</span>
            </header>
            <ol>
              {dimension.members.map((member) => {
                const value = Number(member.delta ?? 0);
                const width = largest > 0 ? Math.max(2, (Math.abs(value) / largest) * 100) : 0;
                return (
                  <li key={member.label} className={member.other ? 'other' : undefined}>
                    {onMember && member.value !== undefined && !member.other ? (
                      <button type="button" className="dql-driver-member" title={`Look inside ${member.label}`} onClick={() => onMember({ field: dimension.field, label: dimension.label }, member)}>
                        {member.label}
                        {member.status === 'new' ? <em> new</em> : member.status === 'gone' ? <em> gone</em> : null}
                      </button>
                    ) : (
                      <span className="dql-driver-member" title={member.label}>
                        {member.label}
                        {member.status === 'new' ? <em> new</em> : member.status === 'gone' ? <em> gone</em> : null}
                      </span>
                    )}
                    <span className="dql-driver-track" aria-hidden="true">
                      <i className={value > 0 ? 'up' : value < 0 ? 'down' : 'flat'} style={{ width: `${width / 2}%` }} />
                    </span>
                    <span className={`dql-driver-delta ${value > 0 ? 'up' : value < 0 ? 'down' : ''}`}>{formatDriverNumber(member.delta, true)}</span>
                    {!compact ? <span className="dql-driver-share">{formatDriverShare(member.share)}</span> : null}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
      {analysis.measure.additivity !== 'additive' && !compact ? (
        <p className="dql-driver-note">{analysis.measure.label} does not add up across members, so shares of the change are not shown.</p>
      ) : null}
      {analysis.unavailable.length && !compact ? (
        <p className="dql-driver-note" title={analysis.unavailable.map((entry) => entry.detail).filter(Boolean).join('\n') || undefined}>Not broken down by {analysis.unavailable.map((entry) => `${entry.field.replace(/_/g, ' ')} (${entry.reason})`).join('; ')}.</p>
      ) : null}
    </div>
  );
}

/** The reader's "Why did it move?" dialog for one tile. */
export function DriverPanel({
  title,
  definition,
  state,
  onComparison,
  onClose,
  footer,
}: {
  title: string;
  definition: DashboardDriverDefinitionV1;
  state: { status: 'loading' } | { status: 'ready'; analysis: DashboardDriverAnalysisV1 } | { status: 'error'; message: string };
  onComparison: (comparison: DashboardDriverDefinitionV1['comparison']) => void;
  onClose: () => void;
  footer?: JSX.Element | null;
}): JSX.Element {
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dql-driver-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <style>{DRIVER_STYLES}</style>
      <div className="dql-driver-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <header>
          <div>
            <h2 id={headingId}>Why did {title} move?</h2>
            <p>{driverPeriodLabel(definition.anchor, definition.grain)} compared with{' '}
              <select aria-label="Compare with" value={definition.comparison} onChange={(event) => onComparison(event.target.value as DashboardDriverDefinitionV1['comparison'])}>
                <option value="previous_period">the {definition.grain} before</option>
                <option value="previous_year">the same {definition.grain} last year</option>
              </select>
            </p>
          </div>
          <button ref={closeRef} type="button" className="dql-driver-close" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </header>
        {state.status === 'loading' ? (
          <div className="dql-driver-loading" role="status" aria-busy="true">
            <span className="visually-hidden">Running governed comparisons…</span>
            <i /><i /><i /><i />
          </div>
        ) : state.status === 'error' ? (
          <p className="dql-driver-error" role="alert">{state.message}</p>
        ) : (
          <DriverView analysis={state.analysis} />
        )}
        <footer>
          {footer}
          <small>Every number here comes from governed comparisons on this tile’s data, with the page’s filters. No AI was used.</small>
        </footer>
      </div>
    </div>
  );
}

const DRIVER_STYLES = `
button.dql-driver-member { padding: 0; border: 0; background: none; color: var(--dql-app-accent, var(--accent)); font: inherit; text-align: left; cursor: pointer; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 35%, transparent); text-underline-offset: 3px; }
button.dql-driver-member:hover, button.dql-driver-member:focus-visible { text-decoration-color: currentColor; outline: none; }
.dql-driver { --drv-ink: var(--dql-app-ink, var(--text-primary)); --drv-muted: var(--dql-app-muted, var(--text-secondary)); --drv-line: var(--dql-app-line, var(--border-subtle)); --drv-up: var(--trust-governed, #3659c9); --drv-down: #c2651f; display: grid; gap: 12px; min-width: 0; color: var(--drv-ink); font: 400 13px/1.45 var(--font-ui, inherit); font-variant-numeric: tabular-nums; }
.dql-driver.compact { gap: 8px; font-size: 12px; }
.dql-driver-summary { margin: 0; font-size: 14px; font-weight: 500; text-wrap: pretty; }
.dql-driver.compact .dql-driver-summary { font-size: 13px; }
.dql-driver-headline { margin: 0; display: flex; flex-wrap: wrap; gap: 8px 24px; }
.dql-driver-headline dt { color: var(--drv-muted); font-size: 12px; }
.dql-driver-headline dd { margin: 0; font-size: 16px; font-weight: 600; }
.dql-driver.compact .dql-driver-headline dd { font-size: 14px; }
.dql-driver-headline dd.up, .dql-driver-delta.up { color: var(--drv-up); }
.dql-driver-headline dd.down, .dql-driver-delta.down { color: var(--drv-down); }
.dql-driver-headline small { font-size: 12px; font-weight: 400; color: var(--drv-muted); }
.dql-driver-dimension { display: grid; gap: 6px; padding-top: 8px; border-top: 1px solid var(--drv-line); }
.dql-driver-dimension header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 12px; }
.dql-driver-dimension header strong { font-size: 13px; font-weight: 600; }
.dql-driver-dimension header span { color: var(--drv-muted); font-size: 12px; }
.dql-driver-dimension ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.dql-driver-dimension li { display: grid; grid-template-columns: minmax(64px, 1.1fr) minmax(64px, 2fr) minmax(56px, auto) minmax(40px, auto); align-items: center; gap: 8px; }
.dql-driver.compact .dql-driver-dimension li { grid-template-columns: minmax(56px, 1fr) minmax(48px, 1.6fr) minmax(48px, auto); }
.dql-driver-dimension li.other { color: var(--drv-muted); }
.dql-driver-member { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dql-driver-member em { font-style: normal; font-size: 11px; color: var(--drv-muted); }
.dql-driver-track { position: relative; height: 12px; }
.dql-driver-track::before { content: ''; position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: var(--drv-line); }
.dql-driver-track i { position: absolute; top: 0; bottom: 0; border-radius: 4px; }
.dql-driver-track i.up { left: 50%; background: var(--drv-up); border-radius: 0 4px 4px 0; }
.dql-driver-track i.down { right: 50%; background: var(--drv-down); border-radius: 4px 0 0 4px; }
.dql-driver-track i.flat { display: none; }
.dql-driver-delta, .dql-driver-share { text-align: right; white-space: nowrap; }
.dql-driver-share { color: var(--drv-muted); font-size: 12px; }
.dql-driver-note { margin: 0; color: var(--drv-muted); font-size: 12px; }
.dql-driver-overlay { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 24px 16px; background: color-mix(in srgb, #0b0d12 45%, transparent); }
.dql-driver-dialog { width: min(640px, 100%); max-height: calc(100vh - 48px); overflow: auto; display: grid; gap: 14px; padding: 18px; border: 1px solid var(--dql-app-line-2, var(--border-default)); border-radius: 12px; background: var(--dql-app-surface, var(--bg-2)); color: var(--dql-app-ink, var(--text-primary)); box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28); }
.dql-driver-dialog > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dql-driver-dialog h2 { margin: 0; font-size: 16px; font-weight: 600; }
.dql-driver-dialog header p { margin: 4px 0 0; color: var(--dql-app-muted, var(--text-secondary)); font-size: 13px; }
.dql-driver-dialog select { font: inherit; color: inherit; background: transparent; border: 1px solid var(--dql-app-line-2, var(--border-default)); border-radius: 8px; padding: 2px 6px; }
.dql-driver-close { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--dql-app-muted, var(--text-secondary)); cursor: pointer; }
.dql-driver-close:hover { background: var(--dql-app-control, var(--bg-0)); }
.dql-driver-close:focus-visible, .dql-driver-dialog select:focus-visible { outline: 2px solid var(--dql-app-accent, var(--accent)); outline-offset: 2px; }
.dql-driver-dialog > footer { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--dql-app-line, var(--border-subtle)); }
.dql-driver-dialog > footer small { color: var(--dql-app-muted, var(--text-secondary)); font-size: 12px; }
.dql-driver-loading { display: grid; gap: 8px; }
.dql-driver-loading i { display: block; height: 14px; border-radius: 4px; background: var(--dql-app-control, var(--bg-0)); animation: dql-driver-pulse 1.4s ease-in-out infinite; }
.dql-driver-loading i:first-child { width: 70%; height: 18px; }
.dql-driver-error { margin: 0; color: var(--status-error); }
@keyframes dql-driver-pulse { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .dql-driver-loading i { animation: none; } }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;
