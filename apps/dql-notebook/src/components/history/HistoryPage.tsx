import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ArrowLeft, Database, RotateCcw, Search, ShieldCheck } from 'lucide-react';
import { historyApi, type HistoryFeed, type HistoryFeedEntry, type HistoryFeedItem, type HistoryStatus, type HistoryVersionCard } from '../../api/history';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { CompareVersions } from './CompareVersions';
import { ItemHistory, button, linkButton, muted, smallButton } from './ItemHistory';
import { openHistory, openHistoryItem } from './history-navigation';
import { setHistoryRoute, useHistoryRoute, type HistoryRoute } from './history-route';
import { actionLabel, authorLabel, groupByDay, groupRestoreLabel, historySql, initials, itemLabel, kindLabel, kindsLabel, restorableVersion, restoredNotice, timeLabel } from './history-words';

/**
 * History (V15, the ZLens app for Snowflake; left bar, Govern): every change to saved queries, Apps and notebooks
 * in the project, grouped by day, with who made it. From a line, open the item's versions, compare a version with
 * the one before it, or restore it. Nothing to commit: each save is kept on its own, inside the app.
 */
type KindFilter = 'all' | 'saved_query' | 'app' | 'notebook';

export function HistoryPage(): JSX.Element {
  const themeMode = useNotebookStore((state) => state.themeMode);
  const t = themes[themeMode];
  const route = useHistoryRoute();
  return (
    <main style={{ flex: 1, minWidth: 0, overflow: 'auto', background: t.appBg, color: t.textPrimary, fontFamily: t.font }}>
      <div style={{ maxWidth: 1_100, margin: '0 auto', padding: '26px 28px 40px' }}>
        {route.page === 'feed' ? <HistoryFeedView t={t} /> : route.page === 'item' ? <ItemPage route={route} t={t} /> : <ComparePage route={route} t={t} />}
      </div>
    </main>
  );
}

function ItemPage({ route, t }: { route: Extract<HistoryRoute, { page: 'item' }>; t: Theme }): JSX.Element {
  const dispatch = useDispatch();
  const files = useNotebookStore((state) => state.files);
  const apps = useNotebookStore((state) => state.apps);
  const [name, setName] = useState<string | null>(null);
  const [kind, setKind] = useState<HistoryFeedItem['kind'] | null>(null);
  useEffect(() => {
    let active = true;
    historyApi.item(route.path).then((item) => { if (active) { setName(item.item.name); setKind(item.item.kind); } }).catch(() => undefined);
    return () => { active = false; };
  }, [route.path]);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
      <BackLink t={t} onClick={() => setHistoryRoute({ page: 'feed' })} label="All changes" />
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' }}>
        {kind ? <span style={kindChip(t)}>{kindLabel(kind).toUpperCase()}</span> : null}
        <h1 style={{ margin: 0, fontFamily: t.fontMono, fontSize: 19, fontWeight: 500, overflowWrap: 'anywhere' }}>{name ?? route.path}</h1>
        <div style={{ flex: 1 }} />
        {kind && kind !== 'semantic' && kind !== 'model' ? (
          <button type="button" style={button(t)} onClick={() => void openHistoryItem(dispatch, { kind, path: route.path, files, apps })}>
            Open {kindLabel(kind).toLowerCase()}
          </button>
        ) : null}
      </header>
      <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg }}>
        <ItemHistory
          path={route.path}
          t={t}
          onCompare={(from, to) => setHistoryRoute({ page: 'compare', path: route.path, from, to, back: 'item' })}
        />
      </div>
    </div>
  );
}

function ComparePage({ route, t }: { route: Extract<HistoryRoute, { page: 'compare' }>; t: Theme }): JSX.Element {
  const dispatch = useDispatch();
  const files = useNotebookStore((state) => state.files);
  const back = () => setHistoryRoute(route.back === 'item' ? { page: 'item', path: route.path } : { page: 'feed' });
  const certify = (card: HistoryVersionCard) => {
    void openHistoryItem(dispatch, { kind: 'saved_query', path: card.path ?? route.path, files });
  };
  // One column that never grows past the page (V3: a long line in an App's file made Compare scroll sideways and
  // pushed Restore off screen at 1315 px): what is wider scrolls inside its own box.
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
      <BackLink t={t} onClick={back} label={route.back === 'item' ? 'Versions' : 'All changes'} />
      <CompareVersions key={`${route.path}:${route.from}:${route.to}`} path={route.path} from={route.from} to={route.to} t={t} onBack={back} onCertify={certify} />
    </div>
  );
}

function HistoryFeedView({ t }: { t: Theme }): JSX.Element {
  const dispatch = useDispatch();
  const [kind, setKind] = useState<KindFilter>('all');
  const [by, setBy] = useState('anyone');
  const [days, setDays] = useState<number>(30);
  const [certifiedOnly, setCertifiedOnly] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [feed, setFeed] = useState<HistoryFeed | null>(null);
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let active = true;
    setError(null);
    historyApi.changes({ kind, by, days: days || undefined, certifiedOnly, q: debounced, limit: 300 })
      .then((loaded) => { if (active) setFeed(loaded); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [kind, by, days, certifiedOnly, debounced, reload]);

  useEffect(() => {
    let active = true;
    historyApi.status().then((loaded) => { if (active) setStatus(loaded); }).catch(() => undefined);
    return () => { active = false; };
  }, [reload]);

  const restore = useCallback(async (item: HistoryFeedItem, version: number) => {
    setError(null);
    setNotice(null);
    try {
      const result = await historyApi.restore(item.current, version);
      setNotice(restoredNotice(result.message, item.name));
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const groups = useMemo(() => groupByDay(feed?.entries ?? []), [feed]);
  const appName = status?.sqlLog.table?.split('.')[0] ?? '<app>';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px 24px' }}>
        <div style={{ flex: '1 1 360px', minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 650, letterSpacing: '-0.01em' }}>History</h1>
          <p style={muted(t, { margin: '6px 0 0', fontSize: 13.5 })}>
            Every change to saved queries, Apps and notebooks in this project: who made it, when, and what changed. Each save is kept on its own; there is nothing to commit.
          </p>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 12px', borderRadius: 999, border: `1px solid ${t.cellBorder}`, background: t.cellBg, fontSize: 12.5 }}>
          <Database size={13} color={t.accent} aria-hidden="true" /> Kept in your Snowflake account
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 14px' }}>
        <div role="group" aria-label="What changed" style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: 3, border: `1px solid ${t.cellBorder}`, borderRadius: 9, background: t.cellBg }}>
          {([['all', 'All'], ['saved_query', 'Saved queries'], ['app', 'Apps'], ['notebook', 'Notebooks']] as Array<[KindFilter, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
              style={{ height: 28, padding: '0 11px', border: 'none', borderRadius: 6, cursor: 'pointer', background: kind === value ? t.accent : 'transparent', color: kind === value ? 'var(--accent-fg, #fff)' : t.textPrimary, font: `${kind === value ? 600 : 400} 12.5px ${t.font}` }}
            >
              {label}
            </button>
          ))}
        </div>
        <label style={filterLabel(t)}>
          By
          <select value={by} onChange={(event) => setBy(event.target.value)} style={selectStyle(t)}>
            <option value="anyone">Anyone</option>
            {(feed?.people ?? []).map((person) => <option key={person} value={`person:${person}`}>{person}</option>)}
            <option value="ai">AI drafts</option>
            <option value="zlens">ZLens upgrades</option>
          </select>
        </label>
        <label style={filterLabel(t)}>
          When
          <select value={String(days)} onChange={(event) => setDays(Number(event.target.value))} style={selectStyle(t)}>
            <option value="30">Last 30 days</option>
            <option value="7">Last 7 days</option>
            <option value="0">All time</option>
          </select>
        </label>
        <label style={{ ...filterLabel(t), color: t.textPrimary }}>
          <input type="checkbox" checked={certifiedOnly} onChange={(event) => setCertifiedOnly(event.target.checked)} style={{ width: 15, height: 15, accentColor: t.accent }} />
          Certifications only
        </label>
        <div style={{ flex: '1 1 200px', minWidth: 180, display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', border: `1px solid ${t.inputBorder}`, borderRadius: 8, background: t.inputBg }}>
          <Search size={13} color={t.textMuted} aria-hidden="true" />
          <input type="search" aria-label="Search changes" placeholder="Search changes" value={query} onChange={(event) => setQuery(event.target.value)} style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: t.textPrimary, font: `12.5px ${t.font}` }} />
        </div>
      </div>

      {notice ? <p role="status" style={{ margin: 0, fontSize: 12.5, color: t.success }}>{notice}</p> : null}
      {error ? <p role="alert" style={{ margin: 0, fontSize: 12.5, color: t.error }}>{error}</p> : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 20 }}>
        <section aria-label="Changes" style={{ flex: '999 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {!feed ? <p role="status" style={muted(t)}>Loading History…</p> : groups.length === 0 ? (
            <p style={{ ...muted(t), padding: 16, border: `1px dashed ${t.cellBorder}`, borderRadius: 12 }}>
              {feed.total === 0 && kind === 'all' && by === 'anyone' && !certifiedOnly && !debounced ? 'No changes yet. Each save in ZLens will show here.' : 'No changes match these filters.'}
            </p>
          ) : groups.map((group) => (
            <div key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 11.5, fontWeight: 650, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.textSecondary }}>{group.label}</h2>
              <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg, overflow: 'hidden' }}>
                {group.entries.map((entry, index) => (
                  <ChangeLine
                    key={entry.id}
                    entry={entry}
                    first={index === 0}
                    t={t}
                    expanded={expanded === entry.id}
                    onExpand={() => setExpanded((current) => (current === entry.id ? null : entry.id))}
                    onOpen={(item) => openHistory(dispatch, { page: 'item', path: item.current })}
                    onCompare={(item) => openHistory(dispatch, { page: 'compare', path: item.current, from: item.version - 1, to: item.version, back: 'feed' })}
                    onRestore={restore}
                  />
                ))}
              </div>
            </div>
          ))}
          {feed && feed.total > feed.entries.length ? <p style={muted(t, { margin: 0 })}>Showing the newest {feed.entries.length} of {feed.total} changes. Narrow the filters to see older ones.</p> : null}
        </section>

        <aside style={{ flex: '1 1 280px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={sideCard(t)}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 650 }}>Where history is kept</h2>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>Inside this app, in your Snowflake account. No Git and no outside connection: nothing leaves Snowflake.</p>
            <p style={muted(t, { margin: 0, fontSize: 13 })}>Every version is kept with the Snowflake user who saved it. Settings » Backups copies it with the rest of the project.</p>
            <div style={{ fontSize: 11.5, fontWeight: 650, letterSpacing: '0.04em', textTransform: 'uppercase', color: t.textSecondary }}>Read it with SQL</div>
            <pre style={{ margin: 0, padding: 12, borderRadius: 8, background: t.appBg, border: `1px solid ${t.cellBorder}`, fontFamily: t.fontMono, fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{historySql(appName)}</pre>
          </div>
          <GitCopyCard t={t} />
        </aside>
      </div>
    </div>
  );
}

/** Copying History to a Git repository is a later version's (V16): this version says so, and offers nothing. */
export function GitCopyCard({ t }: { t: Theme }): JSX.Element {
  return (
    <div style={{ ...sideCard(t), padding: '12px 18px', gap: 4 }}>
      <h2 style={{ margin: 0, fontSize: 13.5, fontWeight: 650 }}>Copy to your Git repository</h2>
      <p style={muted(t, { margin: 0, fontSize: 12.5 })}>Not available in this version.</p>
    </div>
  );
}

export function ChangeLine({
  entry, first, t, expanded, onExpand, onOpen, onCompare, onRestore,
}: {
  entry: HistoryFeedEntry;
  first: boolean;
  t: Theme;
  expanded: boolean;
  onExpand: () => void;
  onOpen: (item: HistoryFeedItem) => void;
  onCompare: (item: HistoryFeedItem) => void;
  onRestore: (item: HistoryFeedItem, version: number) => Promise<void>;
}): JSX.Element {
  // The first line is every item as it was when History started: a count, its kinds, and the list on request.
  const started = entry.change === 'started';
  const single = entry.count === 1 && !started ? entry.items[0] : undefined;
  const version = restorableVersion(entry);
  const restorable = entry.items.filter((item) => item.removed || !item.isCurrentVersion);
  return (
    <div data-history-line={entry.change} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '10px 14px', padding: '13px 16px', borderTop: first ? 'none' : `1px solid ${t.cellBorder}` }}>
      <div style={{ width: 44, flex: 'none', paddingTop: 6, fontFamily: t.fontMono, fontSize: 12, color: t.textSecondary }}>{timeLabel(entry.at)}</div>
      <Avatar entry={entry} t={t} />
      <div style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ lineHeight: 1.45, fontSize: 13.5 }}>
          <strong style={{ fontWeight: 650 }}>{authorLabel(entry.by)}</strong>{started ? <span style={{ color: t.textSecondary }}> · </span> : ' '}
          {actionLabel(entry)}{' '}
          {single ? (
            <button type="button" onClick={() => onOpen(single)} style={{ ...linkButton(t), textDecoration: 'none', fontFamily: t.fontMono, fontWeight: 500, fontSize: 13 }}>{single.name}</button>
          ) : (
            <button type="button" onClick={onExpand} aria-expanded={expanded} style={{ ...linkButton(t), textDecoration: 'none', fontFamily: t.fontMono, fontWeight: 500, fontSize: 13 }}>{itemLabel(entry)}</button>
          )}
        </div>
        <div style={muted(t, { fontSize: 12.5 })}>
          {started || new Set(entry.items.map((item) => item.kind)).size > 1 ? kindsLabel(entry.items) : kindLabel(entry.kind, entry.count)}{entry.detail ? ` · ${entry.detail}` : ''}
        </div>
        {expanded && !single ? (
          <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
            {entry.items.map((item) => (
              <li key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => onOpen(item)} style={{ ...linkButton(t), textDecoration: 'none', fontFamily: t.fontMono, fontWeight: 500, fontSize: 12.5 }}>{item.name}</button>
                {started || new Set(entry.items.map((other) => other.kind)).size > 1 ? <span style={muted(t, { fontSize: 12 })}>{kindLabel(item.kind)}</span> : null}
                <span style={versionPill(t)}>v{item.version}</span>
                {item.detail ? <span style={muted(t, { fontSize: 12 })}>{item.detail}</span> : null}
                {entry.change === 'removed' && item.removed && item.version > 1 ? (
                  <button type="button" onClick={() => void onRestore(item, item.version - 1)} style={smallButton(t)}><RotateCcw size={12} aria-hidden="true" /> Restore</button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingTop: 3 }}>
        {entry.certified ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 8px', borderRadius: 6, background: `${t.success}1f`, color: t.success, fontSize: 11.5, fontWeight: 650, letterSpacing: '0.03em' }}>
            <ShieldCheck size={12} aria-hidden="true" /> CERTIFIED
          </span>
        ) : null}
        {single ? <span style={versionPill(t)}>v{single.version}</span> : null}
        {single && entry.canCompare ? <button type="button" onClick={() => onCompare(single)} style={smallButton(t)}>Compare</button> : null}
        {entry.canRestore && single && version && version > 0 && (single.removed || !single.isCurrentVersion) ? (
          <button type="button" onClick={() => void onRestore(single, version)} style={smallButton(t)} aria-label={`Restore v${version} of ${single.name}`}>
            <RotateCcw size={12} aria-hidden="true" /> Restore
          </button>
        ) : null}
        {entry.canRestore && !single && restorable.length ? (
          <button type="button" onClick={onExpand} aria-expanded={expanded} style={smallButton(t)}><RotateCcw size={12} aria-hidden="true" /> {groupRestoreLabel(entry, expanded)}</button>
        ) : null}
      </div>
    </div>
  );
}

function Avatar({ entry, t }: { entry: HistoryFeedEntry; t: Theme }): JSX.Element {
  const base: CSSProperties = { width: 30, height: 30, flex: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 650 };
  if (entry.by.kind === 'ai') return <div aria-hidden="true" style={{ ...base, background: `${t.accent}1f`, color: t.accent, fontWeight: 700 }}>AI</div>;
  if (entry.by.kind === 'zlens') return <div aria-hidden="true" style={{ ...base, background: t.pillBg, color: t.textPrimary, fontSize: 13, fontWeight: 700 }}>Z</div>;
  return <div aria-hidden="true" style={{ ...base, background: t.accent, color: 'var(--accent-fg, #fff)' }}>{initials(entry.by.name)}</div>;
}

function BackLink({ t, onClick, label }: { t: Theme; onClick: () => void; label: string }): JSX.Element {
  return (
    <div>
      <button type="button" onClick={onClick} style={{ ...linkButton(t), textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <ArrowLeft size={13} aria-hidden="true" /> {label}
      </button>
    </div>
  );
}

function versionPill(t: Theme): CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', height: 24, padding: '0 8px', borderRadius: 6, border: `1px solid ${t.btnBorder}`, fontFamily: t.fontMono, fontSize: 12, color: t.textPrimary };
}

function kindChip(t: Theme): CSSProperties {
  return { height: 22, padding: '0 8px', borderRadius: 6, background: t.pillBg, fontSize: 11, fontWeight: 650, letterSpacing: '0.05em', display: 'inline-flex', alignItems: 'center' };
}

function sideCard(t: Theme): CSSProperties {
  return { border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 };
}

function filterLabel(t: Theme): CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: t.textSecondary };
}

function selectStyle(t: Theme): CSSProperties {
  return { height: 32, padding: '0 8px', border: `1px solid ${t.inputBorder}`, borderRadius: 8, background: t.inputBg, color: t.textPrimary, font: `12.5px ${t.font}` };
}
