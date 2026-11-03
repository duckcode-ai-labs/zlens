// Meanings: what each table and column holds, in words.
//
// A database with no comments gives Ask nothing but names. AI can draft the
// words from names, types and keys; a person reads them and keeps or changes
// them. A draft helps Ask find a table and is labelled on every answer that
// used it, and it never raises an answer's trust. Accepting takes the label
// off. It certifies nothing.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, Sparkles } from 'lucide-react';
import { hostReadOnly, useHostUi } from '../../host/host-ui';
import { api, type MeaningDraftJob, type MeaningTableDetail, type MeaningTableState, type MeaningTableSummary, type MeaningsOverview } from '../../api/client';
import type { themes } from '../../themes/notebook-theme';

type Theme = (typeof themes)[keyof typeof themes];
type Filter = 'all' | MeaningTableState;

const STATE_LABEL: Record<MeaningTableState, string> = {
  needs_review: 'AI draft',
  reviewed: 'Reviewed',
  stale: 'Stale',
  described: 'From the warehouse',
  undescribed: 'No description',
};

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'needs_review', label: 'Needs review' },
  { id: 'stale', label: 'Stale' },
  { id: 'undescribed', label: 'No description' },
  { id: 'reviewed', label: 'Reviewed' },
];

const POLL_MS = 2_000;

export function sourceLabel(source: 'ai' | 'person' | 'warehouse' | undefined): string | null {
  if (source === 'ai') return 'AI draft';
  if (source === 'warehouse') return 'Warehouse comment';
  if (source === 'person') return 'A person';
  return null;
}

/** What a run sends and costs, in the words shown before anyone chooses it. */
export function draftPlanLine(plan: MeaningsOverview['plan']): string {
  const sent = plan.sendsSampleValues
    ? 'Sends table names, column names, types, keys and sample values from the value profile.'
    : 'Sends table names, column names, types and keys. No rows.';
  return `${plan.tables.toLocaleString()} ${plan.tables === 1 ? 'table' : 'tables'} and ${plan.columns.toLocaleString()} columns, in ${plan.calls.toLocaleString()} ${plan.calls === 1 ? 'call' : 'calls'} on your own AI provider: about ${plan.estimatedInputTokens.toLocaleString()} tokens in and ${plan.estimatedOutputTokens.toLocaleString()} out. ${sent}`;
}

/** The tables a group holds: its domain's model, or its schema when no model binds it. */
export function meaningGroups(tables: MeaningTableSummary[]): Array<{ key: string; label: string; tables: MeaningTableSummary[] }> {
  const groups = new Map<string, { key: string; label: string; tables: MeaningTableSummary[] }>();
  for (const table of tables) {
    const key = table.domain ? `domain:${table.domain}` : `schema:${table.schema ?? ''}`;
    const label = table.domain ?? table.schema ?? 'Tables';
    const group = groups.get(key) ?? { key, label, tables: [] };
    group.tables.push(table);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(b.key.startsWith('domain:')) - Number(a.key.startsWith('domain:')) || a.label.localeCompare(b.label));
}

function useMeanings() {
  const [overview, setOverview] = useState<MeaningsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const load = useCallback(async () => {
    try {
      const next = await api.getMeanings();
      if (!mounted.current) return;
      setOverview(next);
      setError(null);
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not load the tables.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const running = overview?.drafting.job?.running === true;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);
  return { overview, error, loading, load };
}

function draftResultLine(job: MeaningDraftJob): string | null {
  if (job.error) return `The draft failed: ${job.error}`;
  if (!job.report) return null;
  const { tablesDrafted, columnsDrafted, failed, stopped } = job.report;
  const words = `Drafted ${tablesDrafted.toLocaleString()} ${tablesDrafted === 1 ? 'table' : 'tables'} and ${columnsDrafted.toLocaleString()} column descriptions. None is reviewed yet.`;
  if (stopped) return `${words} Stopped early: ${stopped}`;
  return failed.length ? `${words} ${failed.reduce((total, item) => total + item.tables.length, 0)} tables were not drafted; run it again to finish them.` : words;
}

/** The choice to draft: what it sends, what it costs, and how far it has got. */
export function DraftMeaningsCard({ t, onChanged, quiet = false }: { t: Theme; onChanged?: () => void; quiet?: boolean }) {
  const { overview, error, load } = useMeanings();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showDropped, setShowDropped] = useState(false);
  const job = overview?.drafting.job;
  const running = job?.running === true;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onChanged?.();
    wasRunning.current = running;
  }, [running, onChanged]);
  const start = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.startMeaningDraft();
      await load();
    } catch (problem) {
      setFailure(problem instanceof Error ? problem.message : 'The draft could not start.');
    } finally {
      setBusy(false);
    }
  };
  if (error || !overview) return error && !quiet ? <div role="alert" style={{ fontSize: 11.5, color: t.error }}>{error}</div> : null;
  const { plan, drafting } = overview;
  const result = job ? draftResultLine(job) : null;
  const dropped = job?.report?.dropped ?? [];
  if (plan.tables === 0 && !running && !result) return null;
  return (
    <section aria-label="Draft what these tables mean" style={{ ...card(t), display: 'grid', gap: 8, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--accent-dim)', color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Sparkles size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>Draft what these tables mean</div>
          <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.5, marginTop: 2 }}>
            {plan.tables > 0 ? draftPlanLine(plan) : 'Every table has a draft.'}
          </div>
        </div>
        {plan.tables > 0 ? (
          <button type="button" onClick={() => void start()} disabled={busy || running || !drafting.available} style={primaryButton(t)}>
            {busy || running ? <Loader2 size={13} className="spin" aria-hidden /> : null}
            {running ? 'Drafting…' : 'Draft the meanings'}
          </button>
        ) : null}
      </div>
      {!drafting.available && drafting.reason ? <div style={{ fontSize: 11, color: t.textMuted }}>{drafting.reason}</div> : null}
      {running ? <div role="status" style={{ fontSize: 11.5, color: t.textSecondary }}>{job!.done} of {job!.total} calls done. You can leave this page; it keeps going.</div> : null}
      {result && !running ? <div role="status" style={{ fontSize: 11.5, lineHeight: 1.5, color: job?.error ? t.error : t.textSecondary }}>{result}</div> : null}
      {failure ? <div role="alert" style={{ fontSize: 11.5, color: t.error }}>{failure}</div> : null}
      {dropped.length > 0 && !running ? (
        <div>
          <button type="button" onClick={() => setShowDropped((open) => !open)} aria-expanded={showDropped} style={linkButton(t)}>
            {showDropped ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {dropped.length} {dropped.length === 1 ? 'description' : 'descriptions'} dropped by the checks
          </button>
          {showDropped ? (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11, color: t.textSecondary, lineHeight: 1.5, maxHeight: 180, overflow: 'auto' }}>
              {dropped.map((item) => <li key={`${item.relation}.${item.column ?? ''}.${item.reason}`}>{item.relation}{item.column ? `.${item.column}` : ''}: {item.reason}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Pill({ state, t }: { state: MeaningTableState; t: Theme }) {
  const tone = state === 'reviewed' ? 'var(--status-success)' : state === 'stale' ? t.error : state === 'needs_review' ? t.accent : t.textMuted;
  return <span style={{ fontSize: 9.5, fontWeight: 700, borderRadius: 999, padding: '1px 7px', border: `1px solid ${tone}`, color: tone, whiteSpace: 'nowrap' }}>{STATE_LABEL[state]}</span>;
}

function TableEditor({ id, readOnly, t, onChanged }: { id: string; readOnly: boolean; t: Theme; onChanged: () => void }) {
  const [detail, setDetail] = useState<MeaningTableDetail | null>(null);
  const [description, setDescription] = useState('');
  const [otherNames, setOtherNames] = useState('');
  const [columns, setColumns] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed?: boolean } | null>(null);

  const show = useCallback((next: MeaningTableDetail) => {
    setDetail(next);
    setDescription(next.description ?? '');
    setOtherNames(next.otherNames.join(', '));
    setColumns(Object.fromEntries(next.columnDetails.map((column) => [column.name, column.description ?? ''])));
  }, []);
  useEffect(() => {
    void api.getMeaningTable(id).then((result) => show(result.table)).catch((failure) => setMessage({ text: failure instanceof Error ? failure.message : 'Could not load this table.', failed: true }));
  }, [id, show]);

  if (!detail) return <div style={{ padding: 12, fontSize: 11.5, color: message?.failed ? t.error : t.textMuted }}>{message?.text ?? 'Loading…'}</div>;

  const changedColumns = Object.fromEntries(detail.columnDetails.filter((column) => (columns[column.name] ?? '') !== (column.description ?? '')).map((column) => [column.name, columns[column.name] ?? '']));
  const names = otherNames.split(',').map((name) => name.trim()).filter(Boolean);
  const tableChanged = description !== (detail.description ?? '') || names.join('|') !== detail.otherNames.join('|');
  const dirty = tableChanged || Object.keys(changedColumns).length > 0;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { table } = await api.saveMeaningTable({ id, ...(tableChanged ? { description, otherNames: names } : {}), columns: changedColumns });
      show(table);
      setMessage({ text: 'Saved. Your words are never overwritten by a draft.' });
      onChanged();
    } catch (failure) {
      setMessage({ text: failure instanceof Error ? failure.message : 'Could not save.', failed: true });
    } finally {
      setBusy(false);
    }
  };
  const accept = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.acceptMeanings([id]);
      show((await api.getMeaningTable(id)).table);
      setMessage({ text: 'Accepted. The AI label is off.' });
      onChanged();
    } catch (failure) {
      setMessage({ text: failure instanceof Error ? failure.message : 'Could not accept.', failed: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: '10px 12px 12px', borderTop: `1px solid ${t.headerBorder}`, display: 'grid', gap: 10 }}>
      {detail.state === 'stale' ? <div role="status" style={{ fontSize: 11.5, color: t.error }}>The columns changed after this draft, so Ask no longer uses it. Draft the meanings again, or write your own below.</div> : null}
      <label style={labelStyle(t)}>
        <span>What one row is {detail.source ? <small style={{ color: t.textMuted, fontWeight: 500 }}>{sourceLabel(detail.source)}</small> : null}</span>
        <textarea value={description} readOnly={readOnly} rows={2} onChange={(event) => setDescription(event.target.value)} style={{ ...input(t), resize: 'vertical' }} />
      </label>
      <label style={labelStyle(t)}>
        <span>Other names people use <small style={{ color: t.textMuted, fontWeight: 500 }}>separated by commas</small></span>
        <input value={otherNames} readOnly={readOnly} onChange={(event) => setOtherNames(event.target.value)} style={input(t)} />
      </label>
      {detail.evidence.length > 0 ? (
        <div style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.5 }}>
          <span style={{ color: t.textMuted }}>Why this draft: </span>
          {detail.model ? `${detail.model}${detail.date ? ` on ${detail.date}` : ''} read ` : 'Read from '}{detail.evidence.join(', ')}. It saw no rows{detail.evidence.some((line) => line.startsWith('sample values')) ? ' beyond those samples' : ''}, so check what the names can't prove.
        </div>
      ) : null}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: t.textMuted, fontSize: 10.5 }}>
            <th scope="col" style={{ ...cell, width: '26%', fontWeight: 600 }}>Column</th>
            <th scope="col" style={{ ...cell, fontWeight: 600 }}>What it holds</th>
            <th scope="col" style={{ ...cell, width: 120, fontWeight: 600 }}>Written by</th>
          </tr>
        </thead>
        <tbody>
          {detail.columnDetails.map((column) => (
            <tr key={column.name} style={{ borderTop: `1px solid ${t.headerBorder}` }}>
              <td style={{ ...cell, color: t.textPrimary, overflowWrap: 'anywhere' }}><code style={{ fontFamily: t.fontMono }}>{column.name}</code>{column.type ? <div style={{ fontSize: 10, color: t.textMuted }}>{column.type}</div> : null}</td>
              <td style={cell}><input aria-label={`What ${column.name} holds`} value={columns[column.name] ?? ''} readOnly={readOnly} onChange={(event) => setColumns((current) => ({ ...current, [column.name]: event.target.value }))} style={input(t)} /></td>
              <td style={{ ...cell, color: t.textMuted, fontSize: 10.5 }}>{sourceLabel(column.source) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {readOnly ? null : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => void save()} disabled={busy || !dirty} style={secondaryButton(t)}>Save my edits</button>
          {detail.state === 'needs_review' ? <button type="button" onClick={() => void accept()} disabled={busy || dirty} title={dirty ? 'Save your edits first' : undefined} style={primaryButton(t)}><Check size={13} /> Accept this table</button> : null}
          {message ? <span role={message.failed ? 'alert' : 'status'} style={{ fontSize: 11, color: message.failed ? t.error : t.textSecondary }}>{message.text}</span> : null}
        </div>
      )}
    </div>
  );
}

export function MeaningsPanel({ domain, t }: { domain: string | null; t: Theme }) {
  const { overview, error, loading, load } = useMeanings();
  const readOnly = hostReadOnly(useHostUi(), 'domains');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [wholeProject, setWholeProject] = useState(false);
  const [openTable, setOpenTable] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const scoped = useMemo(() => {
    const tables = overview?.tables ?? [];
    const inDomain = domain ? tables.filter((table) => table.domain === domain) : [];
    return domain && inDomain.length > 0 && !wholeProject ? inDomain : tables;
  }, [overview, domain, wholeProject]);
  const counts = useMemo(() => {
    const totals: Partial<Record<Filter, number>> = { all: scoped.length };
    for (const table of scoped) totals[table.state] = (totals[table.state] ?? 0) + 1;
    return totals;
  }, [scoped]);
  const visible = useMemo(() => {
    const words = query.trim().toLowerCase();
    return scoped.filter((table) => (filter === 'all' || table.state === filter)
      && (!words || table.relation.toLowerCase().includes(words) || (table.description ?? '').toLowerCase().includes(words)));
  }, [scoped, filter, query]);
  const groups = useMemo(() => meaningGroups(visible), [visible]);

  const acceptGroup = async (label: string, tables: MeaningTableSummary[]) => {
    setNotice(null);
    try {
      const outcome = await api.acceptMeanings(tables.filter((table) => table.state === 'needs_review').map((table) => table.id));
      setNotice(`Accepted ${outcome.accepted} ${outcome.accepted === 1 ? 'table' : 'tables'} in ${label}.`);
      await load();
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : 'Could not accept.');
    }
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 20 }}>
      <h2 style={{ margin: 0, fontSize: 15 }}>Meanings</h2>
      <p style={{ margin: '6px 0 16px', color: t.textSecondary, fontSize: 11.5, lineHeight: 1.55, maxWidth: 720 }}>
        What each table and column holds, in words. Ask searches these words, so a question about &quot;revenue&quot; can find a table no name says it about. An AI draft helps Ask find tables and is named on every answer that used it. It never raises an answer&apos;s trust. Accepting a draft takes the AI label off; it certifies nothing.
      </p>
      {readOnly ? null : <DraftMeaningsCard t={t} onChanged={() => void load()} />}
      {loading ? <Empty text="Loading tables…" t={t} /> : error ? <Empty text={error} t={t} failed /> : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {FILTERS.map((item) => (
              <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)} style={filterButton(t, filter === item.id)}>
                {item.label} <small style={{ color: t.textMuted }}>{counts[item.id] ?? 0}</small>
              </button>
            ))}
            <input aria-label="Find a table" placeholder="Find a table" value={query} onChange={(event) => setQuery(event.target.value)} style={{ ...input(t), width: 200, marginLeft: 'auto' }} />
          </div>
          {domain && scoped.length !== (overview?.tables.length ?? 0) ? (
            <button type="button" onClick={() => setWholeProject(true)} style={{ ...linkButton(t), marginBottom: 10 }}>Show every table, not only {domain}&apos;s</button>
          ) : null}
          {notice ? <div role="status" style={{ fontSize: 11.5, color: t.textSecondary, marginBottom: 10 }}>{notice}</div> : null}
          {groups.length === 0 ? <Empty text="No table matches." t={t} /> : groups.map((group, index) => {
            const open = openGroups[group.key] ?? index === 0;
            const waiting = group.tables.filter((table) => table.state === 'needs_review').length;
            return (
              <section key={group.key} aria-label={group.label} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 }}>
                  <button type="button" aria-expanded={open} onClick={() => setOpenGroups((current) => ({ ...current, [group.key]: !open }))} style={{ ...linkButton(t), color: t.textPrimary, fontWeight: 700, fontSize: 12 }}>
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {group.label}
                  </button>
                  <small style={{ color: t.textMuted }}>{group.tables.length} {group.tables.length === 1 ? 'table' : 'tables'}{waiting ? `, ${waiting} to review` : ''}</small>
                  {waiting > 0 && !readOnly ? <button type="button" onClick={() => void acceptGroup(group.label, group.tables)} style={{ ...secondaryButton(t), marginLeft: 'auto' }}>Accept all {waiting}</button> : null}
                </div>
                {open ? (
                  <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                    {group.tables.map((table) => (
                      <div key={table.id} style={{ ...card(t), padding: 0 }}>
                        <button type="button" aria-expanded={openTable === table.id} onClick={() => setOpenTable(openTable === table.id ? null : table.id)} style={rowButton(t)}>
                          {openTable === table.id ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <code style={{ fontFamily: t.fontMono, fontSize: 11.5, color: t.textPrimary, overflowWrap: 'anywhere' }}>{table.relation}</code>
                              <Pill state={table.state} t={t} />
                            </span>
                            <span style={{ display: 'block', fontSize: 11, color: t.textSecondary, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{table.description ?? 'Nothing says what this table holds yet.'}</span>
                          </span>
                          <small style={{ color: t.textMuted, whiteSpace: 'nowrap' }}>{table.describedColumns} of {table.columns} columns</small>
                        </button>
                        {openTable === table.id ? <TableEditor id={table.id} readOnly={readOnly} t={t} onChanged={() => void load()} /> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function Empty({ text, t, failed }: { text: string; t: Theme; failed?: boolean }) {
  return <div style={{ border: `1px dashed ${t.headerBorder}`, borderRadius: 9, padding: 16, color: failed ? t.error : t.textMuted, fontSize: 11.5 }}>{text}</div>;
}

const cell: CSSProperties = { padding: '5px 8px 5px 0', verticalAlign: 'top' };
const card = (t: Theme): CSSProperties => ({ border: `1px solid ${t.headerBorder}`, borderRadius: 10, padding: '11px 12px', background: t.cellBg, minWidth: 0 });
const input = (t: Theme): CSSProperties => ({ width: '100%', boxSizing: 'border-box', border: `1px solid ${t.btnBorder}`, borderRadius: 7, background: t.cellBg, color: t.textPrimary, fontSize: 11.5, fontWeight: 400, fontFamily: t.font, padding: '5px 8px' });
const labelStyle = (t: Theme): CSSProperties => ({ display: 'grid', gap: 4, fontSize: 11.5, fontWeight: 700, color: t.textPrimary });
const primaryButton = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 7, border: `1px solid ${t.accent}`, background: t.accent, color: 'var(--accent-fg)', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' });
const secondaryButton = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textPrimary, fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' });
const linkButton = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', background: 'transparent', color: t.accent, fontSize: 11, cursor: 'pointer', padding: 0 });
const filterButton = (t: Theme, active: boolean): CSSProperties => ({ border: `1px solid ${active ? t.accent : t.btnBorder}`, background: active ? 'var(--accent-dim)' : t.btnBg, color: active ? t.accent : t.textSecondary, borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' });
const rowButton = (t: Theme): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', background: 'transparent', color: t.textSecondary, padding: '8px 12px', textAlign: 'left', cursor: 'pointer' });
