import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { ArrowLeft, Play, RotateCcw } from 'lucide-react';
import { historyApi, type HistoryAppChange, type HistoryCompare, type HistoryDiffLine, type HistoryItem, type HistoryRestoreResult, type HistoryRunCompare, type HistoryVersionCard } from '../../api/history';
import type { Theme } from '../../themes/notebook-theme';
import { StatePill, button, muted } from './ItemHistory';
import { authorLabel, whenLabel } from './history-words';

/**
 * Compare two versions (V15): who and when for each, the SQL line by line, the saved query's fields, every file
 * of a notebook, and, on request, both versions run now on the app's warehouse with their rows side by side. An App
 * is compared in words (V3): its name, pages, tiles, text, layout and data; its files are under Technical details.
 * From here the older version can be restored (as the next version, a draft) or the newer one certified.
 */
export interface CompareVersionsProps {
  path: string;
  from: number;
  to: number;
  t: Theme;
  onBack: () => void;
  /** Opens the file a version is in (Block Studio), to certify it there. */
  onCertify?: (card: HistoryVersionCard) => void;
  onRestored?: (result: HistoryRestoreResult) => void;
}

export function CompareVersions({ path, from, to, t, onBack, onCertify, onRestored }: CompareVersionsProps): JSX.Element {
  const [compare, setCompare] = useState<HistoryCompare | null>(null);
  const [item, setItem] = useState<HistoryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<HistoryRunCompare | null>(null);
  const [running, setRunning] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    Promise.all([historyApi.compare(path, from, to), historyApi.item(path)])
      .then(([compared, loaded]) => {
        if (!active) return;
        setCompare(compared);
        setItem(loaded);
      })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [path, from, to, reload]);

  const runBoth = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      setRun(await historyApi.runBoth(path, from, to));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }, [path, from, to]);

  const restore = useCallback(async () => {
    setRestoring(true);
    setError(null);
    try {
      const result = await historyApi.restore(compare?.item.key ?? path, from);
      setNotice(`${result.message}, as a draft.`);
      setReload((value) => value + 1);
      onRestored?.(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoring(false);
    }
  }, [compare, path, from, onRestored]);

  if (!compare) {
    return <p role={error ? 'alert' : 'status'} style={muted(t, { padding: 20 })}>{error ? `Compare could not be loaded: ${error}` : 'Comparing…'}</p>;
  }

  return (
    <CompareView
      compare={compare}
      item={item}
      run={run}
      from={from}
      to={to}
      t={t}
      running={running}
      restoring={restoring}
      notice={notice}
      error={error}
      onRestore={() => void restore()}
      onRunBoth={() => void runBoth()}
      onCertify={onCertify}
      onBack={onBack}
    />
  );
}

/** Compare as it is drawn, from what was loaded (rendered on its own in tests). */
export function CompareView({
  compare, item, run, from, to, t, running = false, restoring = false, notice = null, error = null, onRestore, onRunBoth, onCertify, onBack,
}: {
  compare: HistoryCompare;
  item: HistoryItem | null;
  run: HistoryRunCompare | null;
  from: number;
  to: number;
  t: Theme;
  running?: boolean;
  restoring?: boolean;
  notice?: string | null;
  error?: string | null;
  onRestore: () => void;
  onRunBoth: () => void;
  onCertify?: (card: HistoryVersionCard) => void;
  onBack: () => void;
}): JSX.Element {
  const savedQuery = compare.item.kind === 'saved_query';
  const app = compare.item.kind === 'app' ? compare.app ?? { changes: [] } : null;
  const current = item?.item.currentVersion ?? compare.item.currentVersion;
  const fromRow = item?.versions.find((row) => row.version === from);
  const canRestore = Boolean(fromRow?.canRestore);
  const canCertify = savedQuery && compare.to.state === 'draft' && to === current && Boolean(onCertify) && !compare.item.removed;
  const changedFields = (compare.fields ?? []).filter((field) => field.changed && field.field !== 'status');
  const sameFields = (compare.fields ?? []).filter((field) => !field.changed && ['owner', 'tags', 'chart'].includes(field.field));
  const changedFiles = compare.files.filter((file) => file.status !== 'same');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, maxWidth: '100%', fontFamily: t.font, color: t.textPrimary }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px 20px' }}>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 650, letterSpacing: '-0.01em' }}>Compare v{from} and v{to}</h1>
          <p style={muted(t, { margin: '6px 0 0', fontSize: 13 })}>
            {compare.from.state === 'certified' && compare.to.state === 'draft'
              ? 'What changed between the certified version and the draft edit, and what it does to the result.'
              : `What changed in ${compare.item.name} between these two versions.`}
          </p>
        </div>
        <div data-compare-actions style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
          {canRestore ? (
            <button type="button" onClick={onRestore} disabled={restoring} style={button(t, !restoring)}>
              <RotateCcw size={13} aria-hidden="true" /> {restoring ? 'Restoring…' : `Restore v${from} as v${current + 1}`}
            </button>
          ) : null}
          {canCertify ? (
            <button type="button" onClick={() => onCertify!(compare.to)} style={button(t, true, true)}>Certify v{to}</button>
          ) : null}
        </div>
      </div>

      {notice ? <p role="status" style={{ margin: 0, fontSize: 12.5, color: t.success }}>{notice}</p> : null}
      {error ? <p role="alert" style={{ margin: 0, fontSize: 12.5, color: t.error }}>{error}</p> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <VersionCardView card={compare.from} savedQuery={savedQuery} t={t} />
        <VersionCardView card={compare.to} savedQuery={savedQuery} t={t} />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {savedQuery && compare.sql ? <Chip t={t} text={compare.sql.changed ? `SQL · ${compare.sql.changed} line${compare.sql.changed === 1 ? '' : 's'} changed` : 'SQL unchanged'} /> : null}
        {changedFields.map((field) => <Chip key={field.field} t={t} text={`${field.label} changed`} />)}
        {run ? <Chip t={t} text={`Result · ${resultWords(run)}`} /> : null}
        {sameFields.length ? <Chip t={t} quiet text={`${listWords(sameFields.map((field) => field.label))} unchanged`} /> : null}
        {app ? <Chip t={t} text={app.changes.length ? `${app.changes.length} change${app.changes.length === 1 ? '' : 's'}` : 'No change to the pages, tiles or data'} /> : null}
        {!savedQuery && !app ? <Chip t={t} text={`${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} changed`} /> : null}
      </div>

      {savedQuery && compare.sql ? (
        <Section title="SQL" t={t}><DiffLines lines={compare.sql.lines} t={t} /></Section>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
        {savedQuery && compare.fields ? (
          <Section title="Fields" t={t} style={{ flex: '1 1 420px' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 400, borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', background: t.tableHeaderBg }}>
                    <th scope="col" style={cell(t, true)}>Field</th>
                    <th scope="col" style={cell(t, true)}>v{from}</th>
                    <th scope="col" style={cell(t, true)}>v{to}</th>
                  </tr>
                </thead>
                <tbody>
                  {compare.fields.filter((field) => field.changed || ['description', 'owner', 'tags', 'chart'].includes(field.field)).map((field) => (
                    <tr key={field.field}>
                      <th scope="row" style={{ ...cell(t), textAlign: 'left', fontWeight: 550 }}>{field.label}</th>
                      <td style={{ ...cell(t), ...(field.changed ? removedTone(t) : { color: t.textSecondary }) }}>{field.before || '—'}</td>
                      <td style={{ ...cell(t), ...(field.changed ? addedTone(t) : { color: t.textSecondary }) }}>{field.changed ? (field.after || '—') : 'Same'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        ) : null}

        {savedQuery ? (
          <Section title="Result, run now" t={t} style={{ flex: '1 1 320px' }}>
            {run ? <RunTable run={run} from={from} to={to} t={t} /> : (
              <div style={{ padding: '12px 14px', display: 'grid', gap: 10 }}>
                <p style={muted(t, { margin: 0 })}>Runs both versions' SQL on the app's warehouse and shows the rows side by side, new rows marked.</p>
                <div><button type="button" onClick={onRunBoth} disabled={running} style={button(t, !running)}><Play size={13} aria-hidden="true" /> {running ? 'Running both…' : 'Run both'}</button></div>
              </div>
            )}
          </Section>
        ) : null}
      </div>

      {app ? <Section title="What changed" t={t}><AppChangeList changes={app.changes} from={from} to={to} t={t} /></Section> : null}

      {app && changedFiles.length ? (
        <details data-technical-details style={{ minWidth: 0, border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg }}>
          <summary style={{ cursor: 'pointer', padding: '11px 14px', fontSize: 13, fontWeight: 600, color: t.textSecondary }}>Technical details</summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 12, padding: '0 14px 14px' }}>
            <p style={muted(t, { margin: 0 })}>The App's files as History keeps them, line by line.</p>
            {changedFiles.map((file) => (
              <Section key={file.path} title={`${file.path} · ${file.status}`} t={t}><DiffLines lines={file.lines} t={t} /></Section>
            ))}
          </div>
        </details>
      ) : null}

      {!savedQuery && !app ? changedFiles.map((file) => (
        <Section key={file.path} title={`${file.path} · ${file.status}`} t={t}><DiffLines lines={file.lines} t={t} /></Section>
      )) : null}

      <p style={muted(t, { margin: 0 })}>
        {savedQuery
          ? `Certifying v${to} records a new receipt with your Snowflake user and keeps v${from}'s receipt in History. Restoring v${from} saves it as v${current + 1}, a draft, so the certified history is never rewritten.`
          : `Restoring v${from} saves it as v${current + 1}; no version is ever changed.`}
      </p>
      <div><button type="button" onClick={onBack} style={{ ...button(t), border: 'none', background: 'transparent', padding: 0, color: t.accent }}><ArrowLeft size={13} aria-hidden="true" /> Back to History</button></div>
    </div>
  );
}

function VersionCardView({ card, savedQuery, t }: { card: HistoryVersionCard; savedQuery: boolean; t: Theme }): JSX.Element {
  return (
    <div data-version-card={card.version} style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg, padding: 14, display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: t.fontMono, fontWeight: 600, fontSize: 15 }}>v{card.version}</span>
        <StatePill state={card.state} t={t} />
      </div>
      <div style={muted(t)}>{whenLabel(card.at)} · {authorLabel(card.by, false)}</div>
      {savedQuery ? (
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          {card.oldReport ? `Old report: ${card.oldReport}` : card.state === 'certified' ? `Certified${card.certifiedBy ? ` by ${card.certifiedBy}` : ''}` : 'Not compared with the old report yet'}
        </div>
      ) : null}
    </div>
  );
}

/** An App's changes between two versions, one per line, added in green and removed in red. */
export function AppChangeList({ changes, from, to, t }: { changes: HistoryAppChange[]; from: number; to: number; t: Theme }): JSX.Element {
  if (!changes.length) {
    return <p style={muted(t, { padding: '12px 14px', margin: 0 })}>v{from} and v{to} have the same name, pages, tiles and data.</p>;
  }
  return (
    <ul style={{ margin: 0, padding: '6px 0', listStyle: 'none' }}>
      {changes.map((change, index) => {
        const tone = /^(Tile|Page|Data|Description) added\b/.test(change.text) ? addedTone(t) : /^(Tile|Page|Data|Description) removed\b/.test(change.text) ? removedTone(t) : {};
        return (
          <li key={index} data-app-change={change.kind} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 14px', fontSize: 13.5, lineHeight: 1.5, overflowWrap: 'anywhere', ...tone }}>
            <span aria-hidden="true" style={{ flex: 'none', width: 70, fontSize: 11, fontWeight: 650, letterSpacing: '0.04em', textTransform: 'uppercase', color: t.textSecondary }}>{APP_CHANGE_KIND[change.kind]}</span>
            <span style={{ minWidth: 0 }}>{change.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

const APP_CHANGE_KIND: Record<HistoryAppChange['kind'], string> = {
  name: 'Name', description: 'About', page: 'Page', tile: 'Tile', text: 'Text', layout: 'Layout', filters: 'Filters', data: 'Data', settings: 'Settings',
};

function Section({ title, t, children, style }: { title: string; t: Theme; children: React.ReactNode; style?: CSSProperties }): JSX.Element {
  return (
    <section aria-label={title} style={{ minWidth: 0, maxWidth: '100%', border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg, overflow: 'hidden', ...style }}>
      <h2 style={{ margin: 0, padding: '11px 14px', fontSize: 13.5, fontWeight: 650, borderBottom: `1px solid ${t.cellBorder}`, overflowWrap: 'anywhere' }}>{title}</h2>
      {children}
    </section>
  );
}

function Chip({ text, t, quiet }: { text: string; t: Theme; quiet?: boolean }): JSX.Element {
  return <span style={{ display: 'inline-flex', alignItems: 'center', height: 26, padding: '0 10px', borderRadius: 999, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: quiet ? t.textSecondary : t.textPrimary, fontSize: 12 }}>{text}</span>;
}

export function DiffLines({ lines, t }: { lines: HistoryDiffLine[]; t: Theme }): JSX.Element {
  if (!lines.length) return <p style={muted(t, { padding: '10px 14px', margin: 0 })}>Empty in both versions.</p>;
  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <div style={{ minWidth: 560, padding: '6px 0', fontFamily: t.fontMono, fontSize: 12.5, lineHeight: 1.75 }}>
        {lines.map((line, index) => (
          <div key={index} data-diff={line.kind} style={{ display: 'flex', ...(line.kind === 'removed' ? removedTone(t) : line.kind === 'added' ? addedTone(t) : {}) }}>
            <span aria-hidden="true" style={{ width: 40, flex: 'none', textAlign: 'right', paddingRight: 10, color: t.textMuted }}>{line.kind === 'removed' ? '' : line.newNumber}</span>
            <span style={{ width: 18, flex: 'none', textAlign: 'center', fontWeight: 650 }}>
              {line.kind === 'removed' ? <><span aria-hidden="true">−</span><span style={hidden}>removed</span></> : line.kind === 'added' ? <><span aria-hidden="true">+</span><span style={hidden}>added</span></> : ' '}
            </span>
            <span style={{ whiteSpace: 'pre', paddingRight: 16 }}>{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunTable({ run, from, to, t }: { run: HistoryRunCompare; from: number; to: number; t: Theme }): JSX.Element {
  const failed = run.from.error || run.to.error;
  return (
    <div>
      {failed ? <p role="alert" style={{ margin: 0, padding: '10px 14px', fontSize: 12.5, color: t.error }}>{run.from.error ? `v${from}: ${run.from.error}` : ''}{run.from.error && run.to.error ? ' · ' : ''}{run.to.error ? `v${to}: ${run.to.error}` : ''}</p> : null}
      <div style={{ overflowX: 'auto', maxHeight: 360 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: t.tableHeaderBg }}>
              {run.keyColumns.map((column) => <th key={column} scope="col" style={{ ...cell(t, true), textAlign: 'left' }}>{column}</th>)}
              {run.valueColumns.flatMap((column) => [
                <th key={`${column}:from`} scope="col" style={{ ...cell(t, true), textAlign: 'right' }}>v{from} {column}</th>,
                <th key={`${column}:to`} scope="col" style={{ ...cell(t, true), textAlign: 'right' }}>v{to} {column}</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {run.rows.map((row, index) => (
              <tr key={index} data-row-state={row.state} style={row.state === 'new' ? addedTone(t) : row.state === 'removed' ? removedTone(t) : undefined}>
                {row.key.map((value, keyIndex) => <th key={keyIndex} scope="row" style={{ ...cell(t), textAlign: 'left', fontWeight: 550, fontVariantNumeric: 'tabular-nums' }}>{show(value)}</th>)}
                {run.valueColumns.flatMap((column, valueIndex) => [
                  <td key={`${column}:from`} style={{ ...cell(t), textAlign: 'right', fontVariantNumeric: 'tabular-nums', ...(row.from ? {} : { color: t.textMuted }) }}>
                    {row.from ? show(row.from[valueIndex]) : '—'}
                  </td>,
                  <td key={`${column}:to`} style={{ ...cell(t), textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: row.state === 'changed' || row.state === 'new' ? 650 : 400 }}>
                    {row.to ? show(row.to[valueIndex]) : '—'}
                  </td>,
                ])}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={muted(t, { margin: 0, padding: '10px 14px', borderTop: `1px solid ${t.cellBorder}` })}>{runSummary(run, from, to)}</p>
    </div>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function resultWords(run: HistoryRunCompare): string {
  const parts: string[] = [];
  if (run.summary.new) parts.push(`${run.summary.new} new row${run.summary.new === 1 ? '' : 's'}`);
  if (run.summary.removed) parts.push(`${run.summary.removed} row${run.summary.removed === 1 ? '' : 's'} gone`);
  if (run.summary.changed) parts.push(`${run.summary.changed} row${run.summary.changed === 1 ? '' : 's'} changed`);
  if (run.summary.same) parts.push(`${run.summary.same} row${run.summary.same === 1 ? '' : 's'} the same`);
  return parts.join(', ') || 'no rows';
}

export function runSummary(run: HistoryRunCompare, from: number, to: number): string {
  const { same, changed, new: added, removed } = run.summary;
  const before = run.from.rowCount;
  if (!changed && !added && !removed) return `v${from} and v${to} return the same ${same} row${same === 1 ? '' : 's'}.`;
  const pieces = [
    same === before && before > 0 ? `The ${before} row${before === 1 ? '' : 's'} in v${from} come out the same.` : `${same} of v${from}'s ${before} rows come out the same.`,
    added ? `v${to} adds ${added}.` : '',
    removed ? `v${to} drops ${removed}.` : '',
    changed ? `${changed} changed.` : '',
  ];
  return pieces.filter(Boolean).join(' ');
}

function listWords(words: string[]): string {
  const said = words.map((word, index) => (index ? word.toLowerCase() : word));
  if (said.length <= 1) return said.join('');
  return `${said.slice(0, -1).join(', ')} and ${said.at(-1)}`;
}

const hidden: CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' };

function removedTone(t: Theme): CSSProperties {
  return { background: `${t.error}14`, color: t.error };
}

function addedTone(t: Theme): CSSProperties {
  return { background: `${t.success}14`, color: t.success };
}

function cell(t: Theme, head = false): CSSProperties {
  return head
    ? { padding: '9px 14px', fontSize: 11.5, fontWeight: 650, color: t.textSecondary, borderBottom: `1px solid ${t.cellBorder}` }
    : { padding: '9px 14px', borderTop: `1px solid ${t.cellBorder}`, verticalAlign: 'top', lineHeight: 1.5 };
}
