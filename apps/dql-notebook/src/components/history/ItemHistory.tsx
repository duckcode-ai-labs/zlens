import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { historyApi, type HistoryItem, type HistoryRestoreResult, type HistoryVersionRow } from '../../api/history';
import type { Theme } from '../../themes/notebook-theme';
import { authorLabel, stateLabel, whenLabel } from './history-words';

/**
 * The History tab (V15, the ZLens app for Snowflake): every version of one saved query, App or notebook, newest
 * first, with who saved it and what changed. Two versions can be compared, and any older one restored: restoring
 * saves it as the next version, a draft, and never changes an old version.
 */
export interface ItemHistoryProps {
  path: string;
  t: Theme;
  /** Opens Compare for two versions (older first). */
  onCompare: (from: number, to: number) => void;
  /** After a restore wrote the item again (the screen showing it reloads). */
  onRestored?: (result: HistoryRestoreResult) => void;
  /** Changes when the item was saved again: History loads again (the new version is kept just after a save). */
  refreshToken?: string;
}

/** A version is kept just after the save that made it answered: a load after a save looks again shortly. */
const AFTER_SAVE_MS = 800;

export function ItemHistory({ path, t, onCompare, onRestored, refreshToken }: ItemHistoryProps): JSX.Element {
  const [item, setItem] = useState<HistoryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ version: number; files: Array<{ path: string; content: string }> } | null>(null);
  const [reload, setReload] = useState(0);

  const firstLoad = useRef(true);
  useEffect(() => {
    let active = true;
    const load = () => historyApi.item(path)
      .then((loaded) => {
        if (!active) return;
        setItem(loaded);
        setSelected(loaded.banner ? [loaded.banner.certified, loaded.banner.draft] : []);
        setError(null);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setItem(null);
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });
    setLoading(true);
    void load();
    const again = firstLoad.current ? undefined : window.setTimeout(() => { void load(); }, AFTER_SAVE_MS);
    firstLoad.current = false;
    return () => {
      active = false;
      if (again) window.clearTimeout(again);
    };
  }, [path, reload, refreshToken]);

  const toggle = (version: number) => setSelected((current) => (
    current.includes(version) ? current.filter((value) => value !== version) : [...current.slice(-1), version]
  ));

  const restore = useCallback(async (row: HistoryVersionRow) => {
    if (!item) return;
    setBusy(row.version);
    setNotice(null);
    setError(null);
    try {
      const result = await historyApi.restore(item.item.key, row.version);
      setNotice(`${result.message}, as a draft.`);
      setReload((value) => value + 1);
      onRestored?.(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [item, onRestored]);

  const view = useCallback(async (version: number) => {
    if (!item) return;
    try {
      setViewing(await historyApi.version(item.item.key, version));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [item]);

  if (loading && !item) return <p role="status" style={muted(t, { padding: 16 })}>Loading versions…</p>;
  if (!item) {
    return (
      <p role="status" style={muted(t, { padding: 16 })}>
        {error && /no versions/i.test(error) ? 'No versions yet. Each save in ZLens will show here, with who saved it.' : `History could not be loaded: ${error ?? 'unknown error'}`}
      </p>
    );
  }

  return (
    <ItemHistoryView
      item={item}
      t={t}
      selected={selected}
      busy={busy}
      notice={notice}
      error={error}
      viewing={viewing}
      onToggle={toggle}
      onCompare={onCompare}
      onView={(version) => void view(version)}
      onRestore={(row) => void restore(row)}
      onCloseView={() => setViewing(null)}
    />
  );
}

/** The History tab as it is drawn, from what was loaded (rendered on its own in tests). */
export function ItemHistoryView({
  item, t, selected, busy = null, notice = null, error = null, viewing = null, onToggle, onCompare, onView, onRestore, onCloseView,
}: {
  item: HistoryItem;
  t: Theme;
  selected: number[];
  busy?: number | null;
  notice?: string | null;
  error?: string | null;
  viewing?: { version: number; files: Array<{ path: string; content: string }> } | null;
  onToggle: (version: number) => void;
  onCompare: (from: number, to: number) => void;
  onView: (version: number) => void;
  onRestore: (row: HistoryVersionRow) => void;
  onCloseView: () => void;
}): JSX.Element {
  const pair = [...selected].sort((a, b) => a - b);
  const savedQuery = item.item.kind === 'saved_query';
  const next = item.item.currentVersion + 1;
  return (
    <section aria-label="Version history" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14, fontFamily: t.font, color: t.textPrimary }}>
      {item.banner ? (
        <div role="note" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', padding: '11px 14px', borderRadius: 10, background: `${t.warning}1a`, border: `1px solid ${t.warning}55`, color: t.textPrimary, fontSize: 13, lineHeight: 1.5 }}>
          <span style={{ flex: '1 1 320px', minWidth: 0 }}>
            v{item.banner.draft} is an edit of certified v{item.banner.certified} and is not certified yet. Compare the two, then certify v{item.banner.draft} or restore v{item.banner.certified}.
          </span>
          <button type="button" onClick={() => onCompare(item.banner!.certified, item.banner!.draft)} style={linkButton(t)}>
            Compare v{item.banner.certified} and v{item.banner.draft}
          </button>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <span style={muted(t, { flex: '1 1 200px' })}>
          {selected.length === 0 ? 'Select two versions to compare them.' : `${selected.length} version${selected.length === 1 ? '' : 's'} selected`}
        </span>
        <button type="button" disabled={pair.length !== 2} onClick={() => onCompare(pair[0]!, pair[1]!)} style={button(t, pair.length === 2)}>
          Compare selected
        </button>
      </div>

      {notice ? <p role="status" style={{ margin: 0, fontSize: 12.5, color: t.success }}>{notice}</p> : null}
      {error ? <p role="alert" style={{ margin: 0, fontSize: 12.5, color: t.error }}>{error}</p> : null}

      <div style={{ overflowX: 'auto', border: `1px solid ${t.cellBorder}`, borderRadius: 10 }}>
        <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: t.tableHeaderBg, textAlign: 'left' }}>
              <th scope="col" style={th(t, { width: 36 })}><span style={visuallyHidden}>Select</span></th>
              <th scope="col" style={th(t)}>Version</th>
              <th scope="col" style={th(t)}>Saved</th>
              <th scope="col" style={th(t)}>By</th>
              <th scope="col" style={th(t)}>What changed</th>
              <th scope="col" style={th(t)}>State</th>
              <th scope="col" style={th(t)}><span style={visuallyHidden}>Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {item.versions.map((row) => {
              const isSelected = selected.includes(row.version);
              return (
                <tr key={row.version} data-version={row.version} style={{ background: isSelected ? `${t.accent}0d` : 'transparent' }}>
                  <td style={td(t)}>
                    <input
                      type="checkbox"
                      aria-label={`Select v${row.version}`}
                      checked={isSelected}
                      disabled={row.state === 'removed'}
                      onChange={() => onToggle(row.version)}
                      style={{ width: 15, height: 15, accentColor: t.accent }}
                    />
                  </td>
                  <td style={td(t, { fontFamily: t.fontMono, fontWeight: 600 })}>v{row.version}</td>
                  <td style={td(t, { whiteSpace: 'nowrap' })}>{whenLabel(row.at)}</td>
                  <td style={td(t, { whiteSpace: 'nowrap' })}>{authorLabel(row.by, false)}</td>
                  <td style={td(t, { lineHeight: 1.5 })}>{row.detail ?? changeWords(row)}</td>
                  <td style={td(t, { whiteSpace: 'nowrap' })}><StatePill state={row.state} t={t} /></td>
                  <td style={td(t, { whiteSpace: 'nowrap', textAlign: 'right' })}>
                    {row.state !== 'removed' ? (
                      <button type="button" onClick={() => onView(row.version)} style={smallButton(t)} aria-label={`View v${row.version}`}>View</button>
                    ) : null}
                    {row.canRestore ? (
                      <button
                        type="button"
                        onClick={() => onRestore(row)}
                        disabled={busy !== null}
                        style={{ ...smallButton(t), marginLeft: 6 }}
                        aria-label={`Restore v${row.version}`}
                        title={`Restore v${row.version} as v${next}, a draft`}
                      >
                        <RotateCcw size={12} aria-hidden="true" /> {busy === row.version ? 'Restoring…' : 'Restore'}
                      </button>
                    ) : null}
                    {row.current ? <span style={muted(t, { marginLeft: 8 })}>Current</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p style={muted(t, { margin: 0 })}>
        {savedQuery
          ? `Restoring never changes an old version: it saves a copy as the next version (v${next}), as a draft. Certified versions stay exactly as they were certified, with their receipts.`
          : `Restoring never changes an old version: it saves a copy as the next version (v${next}).`}
      </p>

      {viewing ? <VersionViewer viewing={viewing} onClose={onCloseView} t={t} /> : null}
    </section>
  );
}

function changeWords(row: HistoryVersionRow): string {
  switch (row.change) {
    case 'started': return row.state === 'certified' ? 'Certified, as it was when History started' : 'As it was when History started';
    case 'created': return 'Created';
    case 'drafted': return 'Drafted from Ask';
    case 'removed': return 'Removed. It can be restored';
    case 'certified': return 'Certified';
    default: return row.change[0]!.toUpperCase() + row.change.slice(1);
  }
}

export function StatePill({ state, t }: { state: HistoryVersionRow['state']; t: Theme }): JSX.Element {
  const tone = state === 'certified' ? t.success : state === 'draft' ? t.warning : t.textMuted;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: 6, background: `${tone}1f`, color: state === 'saved' || state === 'removed' ? t.textSecondary : tone, fontSize: 11.5, fontWeight: 650 }}>
      {stateLabel(state)}
    </span>
  );
}

function VersionViewer({ viewing, onClose, t }: { viewing: { version: number; files: Array<{ path: string; content: string }> }; onClose: () => void; t: Theme }): JSX.Element {
  return (
    <div role="dialog" aria-label={`v${viewing.version}`} style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 10, background: t.cellBg, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: `1px solid ${t.cellBorder}` }}>
        <strong style={{ fontSize: 13, flex: 1 }}>v{viewing.version}, as it was saved</strong>
        <button type="button" onClick={onClose} aria-label="Close" style={{ ...smallButton(t), padding: '0 6px' }}><X size={13} /></button>
      </div>
      {viewing.files.map((file) => (
        <div key={file.path} style={{ borderTop: `1px solid ${t.cellBorder}` }}>
          <div style={muted(t, { padding: '7px 12px', fontFamily: t.fontMono, fontSize: 11.5 })}>{file.path}</div>
          <pre style={{ margin: 0, padding: '0 12px 12px', maxHeight: 320, overflow: 'auto', fontFamily: t.fontMono, fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: t.textPrimary }}>{file.content}</pre>
        </div>
      ))}
    </div>
  );
}

export const visuallyHidden: CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };

export function muted(t: Theme, extra: CSSProperties = {}): CSSProperties {
  return { fontSize: 12.5, color: t.textSecondary, lineHeight: 1.55, ...extra };
}

function th(t: Theme, extra: CSSProperties = {}): CSSProperties {
  return { padding: '9px 12px', borderBottom: `1px solid ${t.cellBorder}`, fontSize: 11.5, fontWeight: 650, color: t.textSecondary, ...extra };
}

function td(t: Theme, extra: CSSProperties = {}): CSSProperties {
  return { padding: '10px 12px', borderBottom: `1px solid ${t.cellBorder}`, verticalAlign: 'top', color: t.textPrimary, ...extra };
}

export function button(t: Theme, enabled = true, primary = false): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 7,
    border: `1px solid ${primary ? t.accent : t.btnBorder}`, background: primary ? t.accent : t.btnBg,
    color: primary ? 'var(--accent-fg, #fff)' : enabled ? t.textPrimary : t.textMuted,
    cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.6, font: `${primary ? 650 : 500} 12.5px ${t.font}`, whiteSpace: 'nowrap',
  };
}

export function smallButton(t: Theme): CSSProperties {
  return { display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 10px', borderRadius: 7, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textPrimary, cursor: 'pointer', font: `500 12px ${t.font}` };
}

export function linkButton(t: Theme): CSSProperties {
  return { padding: 0, border: 'none', background: 'transparent', color: t.accent, cursor: 'pointer', font: `650 12.5px ${t.font}`, textDecoration: 'underline', textUnderlineOffset: 2 };
}
