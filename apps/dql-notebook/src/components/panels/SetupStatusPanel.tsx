import { useCallback, useEffect, useState } from 'react';
import { api, type LocalOperation, type SnowflakeAppSetupStatus, type WarehouseSetupStatus } from '../../api/client';
import { useDispatch } from '../../store/NotebookStore';
import type { themes } from '../../themes/notebook-theme';
import { askReadinessSetupLine } from '../agent/AskReadinessStrip';

const RUNNING_POLL_MS = 2_000;

type Detail = {
  phase?: string;
  elapsedMs?: number;
  tables?: number;
  checks?: { tablesChecked: number; tables: number; joins: { done: number; total: number }; largeTables: number; resumed: number };
};

const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`;

/** 42 s, 3 min, 1.2 h. */
export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 6) / 10} h`;
}

/**
 * The time left and the credits so far of a check stage, from the speed it has
 * had: both are estimates and say so. Credits only where ZLens runs on the
 * app's own X-Small warehouse (one credit an hour). Exported for tests.
 */
export function checkEstimates(operation: Pick<LocalOperation, 'detail'> | null, credits: boolean): string | null {
  const detail = operation?.detail as Detail | undefined;
  const checks = detail?.checks;
  const elapsed = detail?.elapsedMs ?? 0;
  if (!checks || elapsed <= 0) return null;
  const parts: string[] = [`${shortDuration(elapsed)} so far`];
  // From the speed of the tables checked in this run; only once there is something to go by.
  if (checks.tablesChecked >= 3 && elapsed >= 10_000 && checks.tables > checks.tablesChecked) {
    const left = ((checks.tables - checks.tablesChecked) / checks.tablesChecked) * elapsed;
    parts.push(`about ${shortDuration(left)} left`);
  }
  if (credits) {
    const used = elapsed / 3_600_000;
    parts.push(used < 0.01 ? 'under 0.01 credits' : `about ${used.toFixed(2)} credits`);
  }
  return `${parts.join(' · ')} (estimate)`;
}

/** The lines of the Setup page, stage by stage. Exported for tests. */
export function setupStageLines(status: WarehouseSetupStatus): Array<{ key: string; tone: 'done' | 'running' | 'waiting' | 'caution'; text: string }> {
  const setup = status.setup;
  if (!setup) return [];
  const lines: Array<{ key: string; tone: 'done' | 'running' | 'waiting' | 'caution'; text: string }> = [];
  const live = status.operation && (status.operation.status === 'running' || status.operation.status === 'queued') ? status.operation : null;
  const schemas = setup.scopes.reduce((total, scope) => total + scope.schemas.length, 0);
  const where = `${count(schemas, 'schema', 'schemas')} in ${setup.scopes.map((scope) => scope.catalogOrDatabase).join(', ')}`;
  const read = setup.read;
  if (read.state === 'running') lines.push({ key: 'read', tone: 'running', text: live?.type === 'warehouse-read' && live.message ? live.message : `Reading names in ${where}…` });
  else if (read.state === 'done') lines.push({ key: 'read', tone: 'done', text: `Read ${count(read.relations ?? 0, 'table', 'tables')} in ${where}: names, types, comments, keys.` });
  else if (read.state === 'stopped') lines.push({ key: 'read', tone: 'caution', text: 'Reading names was stopped. Nothing was read.' });
  else lines.push({ key: 'read', tone: 'caution', text: `Reading names failed: ${read.error ?? 'unknown error'}` });
  if (read.state !== 'done') return lines;
  lines.push({ key: 'ready', tone: 'done', text: 'Ready to ask. Answers are labeled AI-generated until you review the drafts.' });
  // Ask's Snowflake Cortex (fix plan risk 3): ready with its model, or not ready with the line an admin runs.
  const ask = askReadinessSetupLine(status.askReadiness); if (ask) lines.push(ask);
  const checks = setup.checks;
  if (!checks || checks.state === 'off') {
    lines.push({ key: 'checks', tone: 'waiting', text: 'Data checks: off. Check the data to draft models for review.' });
    return lines;
  }
  if (checks.state === 'running') {
    lines.push({ key: 'checks', tone: 'running', text: live?.type === 'warehouse-check' && live.message ? live.message : 'Checking keys and joins on the data…' });
    return lines;
  }
  if (checks.state === 'stopped') lines.push({ key: 'checks', tone: 'caution', text: 'Data checks: stopped. Resume picks up where they stopped.' });
  else if (checks.state === 'failed') lines.push({ key: 'checks', tone: 'caution', text: `Data checks did not finish: ${checks.error ?? 'unknown error'}. Resume picks up where they stopped.` });
  else {
    const sampled = checks.sampled ? ` · ${count(checks.sampled, 'table', 'tables')} checked on samples` : '';
    if (checks.warehouse?.refused) lines.push({ key: 'faster', tone: 'caution', text: `Check faster was not available (${checks.warehouse.refused}): checked on X-Small.` });
    else if (checks.warehouse && checks.warehouse.size !== 'XSMALL') lines.push({ key: 'faster', tone: checks.warehouse.resized ? 'caution' : 'done', text: checks.warehouse.resized ? `Checked on a ${checks.warehouse.size === 'MEDIUM' ? 'Medium' : 'Small'} warehouse; it has not gone back to X-Small yet.` : `Checked on a ${checks.warehouse.size === 'MEDIUM' ? 'Medium' : 'Small'} warehouse, back to X-Small now.` });
    lines.push({ key: 'checks', tone: 'done', text: `Data checks done${checks.at ? ` ${new Date(checks.at).toLocaleString()}` : ''}${sampled}.` });
    lines.push({ key: 'search', tone: checks.search === 'meaning' ? 'done' : 'waiting', text: checks.search === 'meaning' ? 'Search by meaning: on.' : `Search by words${checks.searchNote ? ` (${checks.searchNote})` : ''}.` });
    lines.push({ key: 'drafts', tone: 'done', text: checks.proposalId ? `Drafts ready: ${count(checks.drafted ?? 0, 'model', 'models')} wait for review.` : 'Nothing new to draft.' });
  }
  return lines;
}

/**
 * The Setup page (onboarding design P5): every stage of the two-stage setup
 * with counts, time, an estimate and credits, what could not be checked, and
 * Stop, Resume, Check again and "Check this table now". Shown in Settings »
 * Database. An install set up in one go before says when.
 */
export function SetupStatusPanel({ connectionId, credits, t }: { connectionId: string | undefined; credits: boolean; t: (typeof themes)[keyof typeof themes] }) {
  const dispatch = useDispatch();
  const [status, setStatus] = useState<WarehouseSetupStatus | null>(null);
  const [legacy, setLegacy] = useState<SnowflakeAppSetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!connectionId) return;
    try {
      const current = await api.getWarehouseSetup(connectionId);
      setStatus(current);
      if (!current.setup && credits) setLegacy(await api.getSnowflakeAppSetup().catch(() => null));
    } catch {
      // An older server: no Setup page.
    }
  }, [connectionId, credits]);
  useEffect(() => { void load(); }, [load]);
  const running = status?.stage === 'reading' || status?.stage === 'checking';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { void load(); }, RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const card = { maxWidth: 640, border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg, padding: '14px 18px', display: 'flex', flexDirection: 'column' as const, gap: 9, fontFamily: t.font };
  const button = { height: 29, padding: '0 12px', borderRadius: 8, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 11.5, fontWeight: 650, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: t.font } as const;

  if (!status?.setup) {
    if (legacy?.managed && legacy.state === 'done') {
      return (
        <section aria-label="Setup" style={card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: t.textPrimary }}>Setup</div>
          <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.5 }}>
            Set up{legacy.at ? ` on ${new Date(legacy.at).toLocaleDateString()}` : ''}: read {count(legacy.relations ?? 0, 'table', 'tables')} in {legacy.database ?? 'the database'}{typeof legacy.drafted === 'number' ? ` and drafted ${count(legacy.drafted, 'model', 'models')}` : ''}. Choose more schemas below to read them too.
          </div>
        </section>
      );
    }
    return null;
  }
  const lines = setupStageLines(status);
  const setup = status.setup;
  const checks = setup.checks;
  const estimate = status.stage === 'checking' ? checkEstimates(status.operation, credits) : null;
  const problems = [
    ...(setup.read.warnings ?? []).map((text) => ({ relations: [] as string[], kind: 'warning', text })),
    ...(checks?.problems ?? []),
  ];
  const tone = (value: string) => value === 'done' ? 'var(--status-success)' : value === 'caution' ? 'var(--status-warning)' : value === 'running' ? t.textPrimary : t.textMuted;
  const mark = (value: string) => value === 'done' ? '✓' : value === 'running' ? '…' : value === 'caution' ? '!' : '·';
  return (
    <section aria-label="Setup" style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.textPrimary }}>Setup</div>
        {setup.read.at ? <div style={{ fontSize: 10.5, color: t.textMuted }}>set up {new Date(setup.read.at).toLocaleString()}</div> : null}
      </div>
      <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {lines.map((line) => (
          <li key={line.key} style={{ display: 'flex', gap: 8, fontSize: 11.5, lineHeight: 1.5, color: tone(line.tone) }}>
            <span aria-hidden style={{ width: 12, flexShrink: 0, textAlign: 'center' }}>{mark(line.tone)}</span>
            <span>{line.text}</span>
          </li>
        ))}
      </ol>
      {estimate ? <div style={{ fontSize: 11, color: t.textMuted }}>{estimate}</div> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {running && status.operation?.cancellable ? (
          <button type="button" disabled={busy} style={button} onClick={() => void act(() => api.cancelOperation(status.operation!.id))}>{status.stage === 'checking' ? 'Pause' : 'Stop'}</button>
        ) : null}
        {status.stage === 'ready' && connectionId ? (
          <button type="button" disabled={busy} style={button} onClick={() => void act(() => api.startSetupCheck(connectionId))}>{checks?.state === 'stopped' || checks?.state === 'failed' ? 'Resume' : 'Check the data'}</button>
        ) : null}
        {status.stage === 'checked' && connectionId ? (
          <button type="button" disabled={busy} style={button} onClick={() => void act(() => api.startSetupCheck(connectionId, { fresh: true }))}>Check again</button>
        ) : null}
        {(status.stage === 'failed' || status.stage === 'stopped') && connectionId ? (
          <button type="button" disabled={busy} style={button} onClick={() => void act(() => api.startSetupRead(connectionId, { mode: 'selected_scopes', scopes: setup.scopes, check: setup.check }))}>Read again</button>
        ) : null}
        {checks?.proposalId ? (
          <button type="button" style={button} onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'modeling' })}>Review the drafts</button>
        ) : null}
      </div>
      {problems.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: t.textPrimary }}>Not checked ({problems.length.toLocaleString('en-US')})</div>
          <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {problems.slice(0, 50).map((problem, index) => (
              <li key={`${problem.kind}-${index}`} style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.45 }}>
                {problem.text}
                {connectionId && problem.relations.length && (problem.kind === 'too_big' || problem.kind === 'failed') && !running ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act(() => api.startSetupCheck(connectionId, { anyway: problem.relations }))}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--accent)', fontWeight: 600, textDecoration: 'underline' }}
                    >
                      Check this table now
                    </button>
                  </>
                ) : null}
              </li>
            ))}
            {problems.length > 50 ? <li style={{ fontSize: 11, color: t.textMuted }}>… and {(problems.length - 50).toLocaleString('en-US')} more</li> : null}
          </ul>
        </div>
      ) : null}
      {error ? <div role="alert" style={{ fontSize: 11.5, color: 'var(--status-error)' }}>{error}</div> : null}
    </section>
  );
}
