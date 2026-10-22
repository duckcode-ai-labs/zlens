import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileDiff, Loader2, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, type ContextAuthoringProposalV1 } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';
import { describeProposalOperation, groupProposalDiagnostics, proposalOriginWords, proposalReviewTitle, proposalScopeNames } from './proposal-review-words';

export function ContextProposalReviewDrawer({
  proposal,
  theme,
  onClose,
  onCommitted,
  onDiscarded,
}: {
  proposal: ContextAuthoringProposalV1;
  theme: Theme;
  onClose: () => void;
  onCommitted: (proposal: ContextAuthoringProposalV1) => void;
  /** Drafts from the database can be turned down; without this, closing keeps them for later. */
  onDiscarded?: (proposal: ContextAuthoringProposalV1) => void;
}): JSX.Element {
  const [current, setCurrent] = useState(proposal);
  const [selected, setSelected] = useState(() => proposal.operations.map((operation) => operation.id));
  const [busy, setBusy] = useState<'preview' | 'rebase' | 'commit' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebaseAvailable, setRebaseAvailable] = useState(false);
  const blocking = current.diagnostics.filter((diagnostic) => diagnostic.severity === 'blocking');
  const patchesByOperation = useMemo(() => new Map(current.operations.map((operation) => [operation.id, current.patches.filter((patch) => patch.operationId === operation.id)])), [current]);
  const notes = useMemo(() => groupProposalDiagnostics(current.diagnostics, current.origin), [current]);
  const scopeNames = useMemo(() => proposalScopeNames(current), [current]);
  // Drafts from the database wait until they are saved or discarded (new-user round 2, Q3).
  const keptDrafts = current.origin === 'warehouse_discovery' && current.status === 'proposed';

  /**
   * Reviewing a large import means toggling many checkboxes in a row. Each
   * toggle re-previews on the server and mints a new proposal hash, so they are
   * coalesced into one request per burst instead of one per click.
   */
  const pendingSelection = useRef<string[] | null>(null);
  const repreviewTimer = useRef<number | null>(null);
  useEffect(() => () => { if (repreviewTimer.current) window.clearTimeout(repreviewTimer.current); }, []);

  const updateSelection = (operationId: string, checked: boolean) => {
    const previous = pendingSelection.current ?? selected;
    const next = checked ? [...previous, operationId] : previous.filter((id) => id !== operationId);
    pendingSelection.current = next;
    setSelected(next);
    setError(null);
    setRebaseAvailable(false);
    if (repreviewTimer.current) window.clearTimeout(repreviewTimer.current);
    repreviewTimer.current = window.setTimeout(() => {
      const requested = pendingSelection.current ?? next;
      pendingSelection.current = null;
      setBusy('preview');
      void api.repreviewContextProposal(current.id, requested)
        .then((refreshed) => {
          setCurrent(refreshed);
          setSelected(refreshed.operations.map((operation) => operation.id));
        })
        .catch((cause) => {
          setSelected(current.operations.map((operation) => operation.id));
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setBusy(null));
    }, 350);
  };

  const commit = async () => {
    setBusy('commit');
    setError(null);
    setRebaseAvailable(false);
    try {
      const result = await api.commitContextProposal(current.id, current.proposalHash, crypto.randomUUID());
      setCurrent(result.proposal);
      onCommitted(result.proposal);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRebaseAvailable(true);
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy('discard');
    setError(null);
    try {
      const discarded = await api.discardContextProposal(current.id);
      onDiscarded?.(discarded);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const rebase = async () => {
    setBusy('rebase');
    setError(null);
    try {
      const refreshed = await api.repreviewContextProposal(current.id, selected, { rebase: true });
      setCurrent(refreshed);
      setSelected(refreshed.operations.map((operation) => operation.id));
      setRebaseAvailable(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div role="presentation" onClick={() => !busy && onClose()} style={{ position: 'fixed', inset: 0, zIndex: 130, background: 'rgba(8, 10, 16, .48)', display: 'flex', justifyContent: 'flex-end' }}>
      <aside role="dialog" aria-modal="true" aria-label="Review context proposal" onClick={(event) => event.stopPropagation()} style={{ width: 'min(720px, 96vw)', height: '100%', background: theme.appBg, borderLeft: '1px solid var(--border-default)', boxShadow: '-18px 0 50px rgba(0,0,0,.24)', display: 'flex', flexDirection: 'column' }}>
        <header style={{ minHeight: 58, padding: '0 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent-dim)', color: theme.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><FileDiff size={16} /></span>
          <div style={{ flex: 1 }}>
            <strong style={{ fontSize: 14 }}>{proposalReviewTitle(current.origin)}</strong>
            <div style={{ marginTop: 2, fontSize: 10.5, color: theme.textMuted }}>{proposalOriginWords(current.origin)} · needs review</div>
          </div>
          <button type="button" aria-label="Close proposal" disabled={Boolean(busy)} onClick={onClose} style={iconButton(theme)}><X size={15} /></button>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginBottom: 14 }}>
            <Summary label="Files" value={current.impact.files} theme={theme} />
            <Summary label="Modeling" value={current.impact.modelingChanges} theme={theme} />
            <Summary label="Skills" value={current.impact.skillChanges} theme={theme} />
            <Summary label="Datasets" value={current.impact.datasetChanges} theme={theme} />
          </div>
          <div style={{ padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 9, background: 'var(--bg-1)', color: theme.textSecondary, fontSize: 11, lineHeight: 1.5, marginBottom: 14 }}>
            <ShieldCheck size={14} style={{ verticalAlign: -3, marginRight: 7, color: theme.accent }} />
            {keptDrafts
              ? 'Nothing is saved yet. These drafts are kept until you save or discard them, so you can close this and come back. Save writes every ticked change together, or nothing.'
              : 'Nothing is saved yet. Save writes every ticked change together, or nothing.'}
          </div>

          <div role="list" aria-label="Notes">
            {notes.map((note) => (
              <div key={note.key} role="listitem" style={{ display: 'flex', gap: 8, padding: '8px 10px', marginBottom: 6, borderRadius: 7, background: note.severity === 'blocking' ? 'var(--status-error-bg, rgba(180,50,50,.1))' : 'var(--bg-1)', color: note.severity === 'blocking' ? 'var(--status-error, #c45555)' : theme.textSecondary, fontSize: 10.5 }}>
                {note.severity === 'blocking' ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
                <span>{note.summary}</span>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
            {current.operations.map((operation) => {
              const patches = patchesByOperation.get(operation.id) ?? [];
              return (
                <section key={operation.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 9, overflow: 'hidden', background: theme.cellBg }}>
                  <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 12px', cursor: busy ? 'wait' : 'pointer' }}>
                    <input type="checkbox" checked={selected.includes(operation.id)} disabled={Boolean(busy)} onChange={(event) => updateSelection(operation.id, event.target.checked)} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b style={{ display: 'block', fontSize: 11.5 }}>{describeProposalOperation(operation, scopeNames)}</b>
                    </span>
                  </label>
                  {patches.filter((patch) => patch.changed).map((patch) => (
                    <details key={`${patch.operationId}-${patch.path}`} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <summary style={{ padding: '8px 12px', cursor: 'pointer', color: theme.textSecondary, fontSize: 10.5 }}>File change · <code>{patch.path}</code></summary>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--border-subtle)' }}>
                        <Patch title="Before" value={patch.before} theme={theme} />
                        <Patch title="After" value={patch.after} theme={theme} />
                      </div>
                    </details>
                  ))}
                </section>
              );
            })}
          </div>
          {error ? <div role="alert" style={{ color: 'var(--status-error, #c45555)', fontSize: 11, marginTop: 12 }}>{error}</div> : null}

          <details aria-label="Technical details" style={{ marginTop: 16, border: '1px solid var(--border-subtle)', borderRadius: 9, background: 'var(--bg-1)' }}>
            <summary style={{ padding: '8px 12px', cursor: 'pointer', color: theme.textSecondary, fontSize: 10.5 }}>Technical details</summary>
            <div style={{ padding: '4px 12px 12px', fontSize: 10, color: theme.textMuted, lineHeight: 1.55, display: 'grid', gap: 8 }}>
              <div>Proposal <code>{current.proposalHash.slice(0, 12)}</code> · {current.origin} · revision {current.revision ?? 1} · {current.trustState}</div>
              {current.diagnostics.length ? (
                <ul aria-label="Notes as written" style={{ margin: 0, paddingLeft: 16 }}>
                  {current.diagnostics.map((diagnostic, index) => (
                    <li key={`${diagnostic.code}-${index}`}>
                      <code>{diagnostic.code}</code> · {diagnostic.message}
                      {(diagnostic.operationIds ?? (diagnostic.operationId ? [diagnostic.operationId] : [])).length
                        ? <> · <code style={{ overflowWrap: 'anywhere' }}>{(diagnostic.operationIds ?? [diagnostic.operationId!]).join(', ')}</code></>
                        : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <ul aria-label="Changes by id" style={{ margin: 0, paddingLeft: 16 }}>
                {current.operations.map((operation) => {
                  const count = (patchesByOperation.get(operation.id) ?? []).length;
                  return <li key={operation.id}><code style={{ overflowWrap: 'anywhere' }}>{operation.id}</code> · {count} patch{count === 1 ? '' : 'es'}</li>;
                })}
              </ul>
            </div>
          </details>
        </div>

        <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ flex: 1, fontSize: 10.5, color: theme.textMuted }}>{selected.length} of {current.operations.length} change{current.operations.length === 1 ? '' : 's'} ticked</span>
          {rebaseAvailable ? <button type="button" onClick={() => void rebase()} disabled={Boolean(busy)} style={secondaryButton(theme)}><RefreshCw size={13} /> Rebase proposal</button> : null}
          {keptDrafts && onDiscarded ? <button type="button" onClick={() => void discard()} disabled={Boolean(busy)} style={secondaryButton(theme)}><Trash2 size={13} /> {busy === 'discard' ? 'Discarding…' : 'Discard drafts'}</button> : null}
          <button type="button" onClick={onClose} disabled={Boolean(busy)} style={secondaryButton(theme)}>{keptDrafts ? 'Keep for later' : 'Cancel'}</button>
          <button type="button" onClick={() => void commit()} disabled={Boolean(busy) || selected.length === 0 || blocking.length > 0} style={{ ...primaryButton(theme), opacity: busy || selected.length === 0 || blocking.length ? .55 : 1 }}>
            {busy ? <Loader2 size={13} /> : <ShieldCheck size={13} />} {busy === 'preview' ? 'Updating…' : busy === 'commit' ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function Summary({ label, value, theme }: { label: string; value: number; theme: Theme }) {
  return <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '9px 10px', background: theme.cellBg }}><b style={{ fontSize: 15 }}>{value}</b><span style={{ display: 'block', marginTop: 2, color: theme.textMuted, fontSize: 9.5 }}>{label}</span></div>;
}

function Patch({ title, value, theme }: { title: string; value: string; theme: Theme }) {
  return <div style={{ minWidth: 0, background: 'var(--bg-1)', padding: 9 }}><b style={{ fontSize: 9, color: theme.textMuted }}>{title}</b><pre style={{ margin: '7px 0 0', fontSize: 9.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto', color: theme.textSecondary }}>{value || '∅'}</pre></div>;
}

const iconButton = (theme: Theme): React.CSSProperties => ({ border: '1px solid var(--border-subtle)', background: theme.cellBg, color: theme.textSecondary, width: 29, height: 29, borderRadius: 7, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' });
const secondaryButton = (theme: Theme): React.CSSProperties => ({ border: '1px solid var(--border-default)', background: theme.cellBg, color: theme.textPrimary, minHeight: 31, borderRadius: 7, padding: '0 12px', cursor: 'pointer' });
const primaryButton = (theme: Theme): React.CSSProperties => ({ ...secondaryButton(theme), background: theme.accent, borderColor: theme.accent, color: 'var(--accent-fg)', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 650 });
