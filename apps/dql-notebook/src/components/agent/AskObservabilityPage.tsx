/**
 * Ask Observability catalog — a local, redacted index of Ask/Research traces.
 *
 * The trace SQLite store keeps only typed evidence.  The API joins a small,
 * redacted question preview from the local AgentRun store at read time; this
 * page deliberately keeps neither the full question nor a trace payload in
 * Notebook state.  Detail remains addressable by run id at /ask/traces/:runId.
 *
 * Acceptance: OBS-013, UI-012.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Filter,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { api, type AskTraceEnvelopeV1, type AskTraceListEntryV1, type AskTraceListQueryV1, type AskTraceStoreStatusV1 } from '../../api/client';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';

const PAGE_SIZE = 25;

export type AskObservabilityFilters = {
  status: 'all' | AskTraceEnvelopeV1['status'];
  mode: 'all' | AskTraceEnvelopeV1['mode'];
  selectedTier: 'all' | 'certified' | 'semantic' | 'governed_relational' | 'exploratory_sql' | 'clarify_or_gap';
  trustState: 'all' | 'certified' | 'governed' | 'review_required' | 'blocked';
};

const DEFAULT_FILTERS: AskObservabilityFilters = {
  status: 'all',
  mode: 'all',
  selectedTier: 'all',
  trustState: 'all',
};

/** A typed API query; it never uses preview text as a trace-store filter. */
export function askObservabilityQuery(filters: AskObservabilityFilters, cursor?: string): AskTraceListQueryV1 {
  return {
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    ...(filters.status !== 'all' ? { status: filters.status } : {}),
    ...(filters.mode !== 'all' ? { mode: filters.mode } : {}),
    ...(filters.selectedTier !== 'all' ? { selectedTier: filters.selectedTier } : {}),
    ...(filters.trustState !== 'all' ? { trustState: filters.trustState } : {}),
  };
}

/** A safe local label: all trace-detail evidence stays behind an explicit click. */
export function traceCatalogTitle(trace: AskTraceListEntryV1): string {
  return trace.questionPreview?.trim()
    || trace.scenarioLabel?.trim()
    || `Ask run ${shortId(trace.runId)}`;
}

export function AskObservabilityPage(): JSX.Element {
  const themeMode = useNotebookStore((state) => state.themeMode);
  const t = themes[themeMode];
  const dispatch = useDispatch();
  const [filters, setFilters] = useState<AskObservabilityFilters>(DEFAULT_FILTERS);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [traces, setTraces] = useState<AskTraceListEntryV1[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [total, setTotal] = useState<number | undefined>();
  const [storeStatus, setStoreStatus] = useState<AskTraceStoreStatusV1 | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [reloadKey, setReloadKey] = useState(0);

  const query = useMemo(
    () => askObservabilityQuery(filters, cursors[pageIndex]),
    [cursors, filters, pageIndex],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void Promise.all([api.getAskTraceStatus(), api.listAskTraces(query)])
      .then(([statusResponse, list]) => {
        if (!active) return;
        setStoreStatus(statusResponse.status);
        setTraces(list.traces);
        setNextCursor(list.nextCursor);
        setTotal(list.total);
        setLoading(false);
      })
      .catch((cause) => {
        if (!active) return;
        setError(errorMessage(cause));
        setLoading(false);
      });
    return () => { active = false; };
  }, [query, reloadKey]);

  const updateFilters = (updates: Partial<AskObservabilityFilters>) => {
    setFilters((current) => ({ ...current, ...updates }));
    setCursors([undefined]);
    setPageIndex(0);
  };
  const openTrace = (runId: string) => dispatch({ type: 'OPEN_ASK_TRACE', runId });
  const goNext = () => {
    if (!nextCursor) return;
    setCursors((current) => {
      const next = current.slice(0, pageIndex + 1);
      next.push(nextCursor);
      return next;
    });
    setPageIndex((current) => current + 1);
  };
  const goPrevious = () => setPageIndex((current) => Math.max(0, current - 1));
  const hasFilters = Object.values(filters).some((value) => value !== 'all');

  return (
    <main style={{ flex: 1, minWidth: 0, overflow: 'auto', background: t.appBg, color: t.textPrimary, fontFamily: t.font }}>
      <div style={{ maxWidth: 1_280, margin: '0 auto', padding: '22px 24px 36px' }}>
        <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap', marginBottom: 18 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 8, background: `${t.accent}16`, color: t.accent }}><Search size={15} /></span>
              <h1 style={{ margin: 0, fontSize: 22, letterSpacing: '-0.02em' }}>Ask observability</h1>
            </div>
            <p style={{ margin: '7px 0 0', color: t.textSecondary, fontSize: 13, lineHeight: 1.5, maxWidth: 720 }}>
              Review what Ask tried, where it stopped, and the safe next action. Open a run for its redacted trace tree, cascade decisions, provider phase, and repair guidance.
            </p>
          </div>
          <button type="button" onClick={() => setReloadKey((current) => current + 1)} disabled={loading} style={secondaryButtonStyle(t)}>
            <RefreshCw size={13} className={loading ? 'ask-trace-recording' : undefined} /> Refresh
          </button>
        </header>

        <StoreStatusCard status={storeStatus} loading={loading} error={error} t={t} />

        <section aria-label="Ask trace filters" style={{ marginTop: 16, padding: '12px 14px', border: `1px solid ${t.cellBorder}`, borderRadius: 10, background: t.cellBg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 9, color: t.textSecondary, fontSize: 12, fontWeight: 700 }}>
            <Filter size={13} /> Filter trace catalog
            {hasFilters ? <button type="button" onClick={() => updateFilters(DEFAULT_FILTERS)} style={textButtonStyle(t)}>Clear filters</button> : null}
          </div>
          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
            <FilterSelect label="Outcome" value={filters.status} onChange={(status) => updateFilters({ status: status as AskObservabilityFilters['status'] })} t={t}>
              <option value="all">All outcomes</option>
              <option value="completed">Completed</option>
              <option value="blocked">Blocked</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
              <option value="interrupted">Interrupted</option>
              <option value="running">Running</option>
            </FilterSelect>
            <FilterSelect label="Mode" value={filters.mode} onChange={(mode) => updateFilters({ mode: mode as AskObservabilityFilters['mode'] })} t={t}>
              <option value="all">Ask + Research</option>
              <option value="ask">Ask</option>
              <option value="research">Research</option>
            </FilterSelect>
            <FilterSelect label="Selected tier" value={filters.selectedTier} onChange={(selectedTier) => updateFilters({ selectedTier: selectedTier as AskObservabilityFilters['selectedTier'] })} t={t}>
              <option value="all">All tiers</option>
              <option value="certified">Certified</option>
              <option value="semantic">Semantic</option>
              <option value="governed_relational">Governed relational</option>
              <option value="exploratory_sql">Exploratory SQL</option>
              <option value="clarify_or_gap">Clarify or gap</option>
            </FilterSelect>
            <FilterSelect label="Trust" value={filters.trustState} onChange={(trustState) => updateFilters({ trustState: trustState as AskObservabilityFilters['trustState'] })} t={t}>
              <option value="all">All trust states</option>
              <option value="certified">Certified</option>
              <option value="governed">From Metrics</option>
              <option value="review_required">Review required</option>
              <option value="blocked">Blocked</option>
            </FilterSelect>
          </div>
        </section>

        <section aria-live="polite" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8, color: t.textMuted, fontSize: 11.5 }}>
            <span>{total === undefined ? 'Loading trace count…' : `${total} local trace${total === 1 ? '' : 's'}`}</span>
            <span>Page {pageIndex + 1}</span>
          </div>
          {loading ? <CatalogLoading t={t} /> : error ? <CatalogFailure message={error} onRetry={() => setReloadKey((current) => current + 1)} t={t} /> : traces.length === 0 ? <CatalogEmpty filtered={hasFilters} t={t} /> : (
            <div style={{ display: 'grid', gap: 8 }}>
              {traces.map((trace) => <TraceCatalogCard key={trace.traceId} trace={trace} t={t} onOpen={() => openTrace(trace.runId)} />)}
            </div>
          )}
        </section>

        <nav aria-label="Trace catalog pagination" style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <button type="button" onClick={goPrevious} disabled={pageIndex === 0 || loading} style={secondaryButtonStyle(t)}><ChevronLeft size={13} /> Previous</button>
          <button type="button" onClick={goNext} disabled={!nextCursor || loading} style={secondaryButtonStyle(t)}>Next <ChevronRight size={13} /></button>
        </nav>
      </div>
    </main>
  );
}

function StoreStatusCard({ status, loading, error, t }: { status?: AskTraceStoreStatusV1; loading: boolean; error?: string; t: Theme }): JSX.Element {
  const unavailable = Boolean(error) || (status && (!status.available || !status.recordingEnabled));
  const Icon = unavailable ? AlertTriangle : status?.recordingEnabled ? CheckCircle2 : LoaderCircle;
  const title = error
    ? 'The local trace catalog could not be loaded.'
    : status?.available && status.recordingEnabled
      ? 'Local trace recording is ready.'
      : loading
        ? 'Checking local trace recording…'
        : 'Local trace recording is unavailable.';
  const detail = error
    ? 'Check that the local ZLens runtime is running, then refresh. Existing Ask results remain available.'
    : status?.available && status.recordingEnabled
      ? 'Traces are local and redacted. Full prompts, SQL, rows, provider responses, credentials, and file paths are not retained here.'
      : status?.reason === 'disabled'
        ? 'Enable local Ask trace recording in the project runtime, then run a new Ask.'
        : status?.reason === 'unsupported_schema'
          ? 'Rebuild the local runtime or trace index to match this ZLens version, then retry.'
          : 'The runtime did not report a usable local trace store.';
  return (
    <section role={unavailable ? 'alert' : 'status'} style={{ display: 'flex', gap: 10, padding: '11px 13px', borderRadius: 10, border: `1px solid ${unavailable ? `${t.warning}55` : `${t.accent}33`}`, background: unavailable ? `${t.warning}0d` : `${t.accent}09` }}>
      <Icon size={16} color={unavailable ? t.warning : t.accent} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        <strong style={{ display: 'block', fontSize: 12.5, color: t.textPrimary }}>{title}</strong>
        <span style={{ display: 'block', marginTop: 3, fontSize: 11.5, lineHeight: 1.45, color: t.textSecondary }}>{detail}</span>
      </div>
    </section>
  );
}

function TraceCatalogCard({ trace, t, onOpen }: { trace: AskTraceListEntryV1; t: Theme; onOpen: () => void }): JSX.Element {
  const blocked = trace.status === 'blocked' || trace.status === 'failed' || trace.status === 'interrupted';
  const statusColor = blocked ? t.error : trace.status === 'completed' ? t.success : t.warning;
  const statusIcon = blocked ? <ShieldAlert size={13} /> : trace.status === 'completed' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />;
  return (
    <article style={{ display: 'grid', gap: 10, padding: '13px 14px', border: `1px solid ${t.cellBorder}`, borderRadius: 10, background: t.cellBg }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: statusColor, fontSize: 11.5, fontWeight: 750 }}>
            {statusIcon} {displayStatus(trace.status)}
            <span style={{ color: t.textMuted, fontWeight: 500 }}>· {trace.mode === 'research' ? 'Research' : 'Ask'} · {trace.surface}</span>
          </div>
          <h2 style={{ margin: '5px 0 0', color: t.textPrimary, fontSize: 14, lineHeight: 1.4, fontWeight: 700 }}>{traceCatalogTitle(trace)}</h2>
          {trace.reason ? <p style={{ margin: '4px 0 0', color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>{trace.reason}</p> : null}
        </div>
        <button type="button" onClick={onOpen} style={primaryButtonStyle(t)}>
          Open trace <ArrowRight size={13} />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', color: t.textSecondary, fontSize: 11 }}>
        <TracePill label={trace.trustState ?? 'Trust not recorded'} t={t} />
        <TracePill label={trace.selectedTier ?? 'No selected tier'} t={t} />
        <TracePill label={trace.terminalOutcome?.replace(/_/g, ' ') ?? trace.recordingStatus} t={t} />
        <TracePill label={`${trace.spanCount} stage${trace.spanCount === 1 ? '' : 's'}`} t={t} />
        <TracePill label={formatStartedAt(trace.startedAt)} t={t} />
        {!trace.detailAvailable ? <TracePill label="Detail no longer available" t={t} warning /> : null}
      </div>
    </article>
  );
}

function TracePill({ label, t, warning = false }: { label: string; t: Theme; warning?: boolean }): JSX.Element {
  return <span style={{ padding: '3px 6px', border: `1px solid ${warning ? `${t.warning}55` : t.cellBorder}`, borderRadius: 999, background: warning ? `${t.warning}0d` : t.pillBg, color: warning ? t.warning : t.textSecondary, whiteSpace: 'nowrap' }}>{label}</span>;
}

function FilterSelect({ label, value, onChange, t, children }: { label: string; value: string; onChange: (value: string) => void; t: Theme; children: ReactNode }): JSX.Element {
  return (
    <label style={{ display: 'grid', gap: 3, minWidth: 142, fontSize: 10.5, color: t.textMuted }}>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} style={{ minHeight: 31, padding: '4px 8px', border: `1px solid ${t.inputBorder}`, borderRadius: 6, background: t.inputBg, color: t.textPrimary, font: `12px ${t.font}` }}>
        {children}
      </select>
    </label>
  );
}

function CatalogLoading({ t }: { t: Theme }): JSX.Element {
  return <div role="status" style={emptyStyle(t)}><LoaderCircle size={16} className="ask-trace-recording" /> Loading local Ask traces…</div>;
}

function CatalogFailure({ message, onRetry, t }: { message: string; onRetry: () => void; t: Theme }): JSX.Element {
  return <div role="alert" style={emptyStyle(t)}><XCircle size={16} color={t.error} /><span style={{ flex: 1 }}>{message}</span><button type="button" onClick={onRetry} style={secondaryButtonStyle(t)}><RefreshCw size={12} /> Retry</button></div>;
}

function CatalogEmpty({ filtered, t }: { filtered: boolean; t: Theme }): JSX.Element {
  return <div style={emptyStyle(t)}><Search size={16} color={t.textMuted} />{filtered ? 'No local traces match these filters.' : 'No local Ask traces have been recorded yet. Run an Ask, then return here to inspect its typed execution evidence.'}</div>;
}

function displayStatus(status: AskTraceEnvelopeV1['status']): string {
  return status === 'completed' ? 'Completed' : status.charAt(0).toUpperCase() + status.slice(1);
}

function formatStartedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : 'The local trace catalog did not return a response.';
}

function secondaryButtonStyle(t: Theme) {
  return { display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 30, padding: '5px 9px', border: `1px solid ${t.btnBorder}`, borderRadius: 6, background: t.btnBg, color: t.textSecondary, cursor: 'pointer', font: `650 11.5px ${t.font}` };
}

function primaryButtonStyle(t: Theme) {
  return { display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 30, padding: '5px 9px', border: `1px solid ${t.accent}`, borderRadius: 6, background: t.accent, color: 'var(--accent-fg)', cursor: 'pointer', font: `700 11.5px ${t.font}`, whiteSpace: 'nowrap' };
}

function textButtonStyle(t: Theme) {
  return { marginLeft: 4, padding: 0, border: 'none', background: 'transparent', color: t.accent, cursor: 'pointer', font: `650 11px ${t.font}` };
}

function emptyStyle(t: Theme) {
  return { display: 'flex', alignItems: 'center', gap: 8, minHeight: 76, padding: '14px', border: `1px dashed ${t.cellBorder}`, borderRadius: 10, color: t.textSecondary, fontSize: 12, lineHeight: 1.45, background: t.cellBg };
}
