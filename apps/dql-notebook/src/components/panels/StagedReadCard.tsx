import { useEffect, useRef, useState } from 'react';
import { api, type CheckWarehouseSize, type ConnectionMetadataScopeV1, type WarehouseSetupStatus } from '../../api/client';
import type { themes } from '../../themes/notebook-theme';
import { checkSizeWords, setupEstimates, type SelectedScopeTotals } from './connection-metadata-scope';

const POLL_MS = 1_000;

/** What the card says about a setup in progress or done. Exported for tests. */
export function stagedReadLine(status: WarehouseSetupStatus | null): { tone: 'info' | 'success' | 'caution'; text: string } | null {
  if (!status?.setup) return null;
  const live = status.operation && (status.operation.status === 'running' || status.operation.status === 'queued') ? status.operation : null;
  if (status.stage === 'reading') return { tone: 'info', text: live?.message && live.phase !== 'queued' && live.phase !== 'starting' ? live.message : 'Reading names…' };
  if (status.stage === 'failed') return { tone: 'caution', text: `Could not read the chosen schemas: ${status.setup.read.error ?? 'unknown error'}` };
  if (status.stage === 'stopped') return { tone: 'caution', text: 'Reading was stopped. Nothing was read.' };
  const relations = status.setup.read.relations ?? 0;
  return { tone: 'success', text: `Read ${relations.toLocaleString('en-US')} table${relations === 1 ? '' : 's'}: names, types, comments, keys. Ready to ask.` };
}

/**
 * Guided Setup's "Read these tables" (onboarding design P3): names, types,
 * comments and declared keys of what is ticked, with no table scanned; then,
 * when the box is ticked, the data checks in the background. The card follows
 * the read with its counts and offers Stop; when it is done, setup moves on.
 */
export function StagedReadCard({
  connectionId,
  selected,
  mode,
  totals,
  checkRowBudget,
  credits,
  blocked,
  onReady,
  t,
}: {
  connectionId: string | undefined;
  selected: ConnectionMetadataScopeV1['scopes'];
  mode: ConnectionMetadataScopeV1['mode'];
  totals: SelectedScopeTotals | null;
  checkRowBudget?: number;
  /** Say the background checks' warehouse credits (the app on its own X-Small warehouse). */
  credits: boolean;
  /** Why reading cannot start (nothing ticked, too much at once), or null. */
  blocked: string | null;
  onReady: (status: WarehouseSetupStatus) => void;
  t: (typeof themes)[keyof typeof themes];
}) {
  const [check, setCheck] = useState(true);
  // "Check faster" (decision D6): only in the app, where ZLens may resize its own warehouse.
  const [checkSize, setCheckSize] = useState<CheckWarehouseSize>('XSMALL');
  const [status, setStatus] = useState<WarehouseSetupStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readySent = useRef<string | null>(null);

  // A setup already under way (a reload, a restart) is picked up where it is.
  useEffect(() => {
    if (!connectionId) return;
    let alive = true;
    void api.getWarehouseSetup(connectionId).then((current) => { if (alive && current.setup) setStatus(current); }).catch(() => undefined);
    return () => { alive = false; };
  }, [connectionId]);

  const reading = status?.stage === 'reading';
  useEffect(() => {
    if (!connectionId || !reading) return;
    const timer = window.setInterval(() => {
      void api.getWarehouseSetup(connectionId).then(setStatus).catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [connectionId, reading]);

  useEffect(() => {
    const done = status && (status.stage === 'ready' || status.stage === 'checking' || status.stage === 'checked');
    const key = status?.setup?.read.operationId ?? null;
    if (done && key && readySent.current !== key) {
      readySent.current = key;
      onReady(status);
    }
  }, [status, onReady]);

  const start = async () => {
    if (!connectionId || blocked) return;
    setStarting(true);
    setError(null);
    try {
      setStatus(await api.startSetupRead(connectionId, {
        mode,
        scopes: selected,
        check,
        ...(credits && check && checkSize !== 'XSMALL' ? { checkSize } : {}),
        ...(totals && totals.sized > 0 ? { tablesExpected: totals.tables } : {}),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };
  const stop = async () => {
    const id = status?.operation?.id;
    if (!id || !connectionId) return;
    try {
      await api.cancelOperation(id);
    } finally {
      setStatus(await api.getWarehouseSetup(connectionId).catch(() => status));
    }
  };

  const estimates = totals && totals.sized > 0 ? setupEstimates(totals, { checkRowBudget, credits }) : null;
  const line = stagedReadLine(status);
  const disabled = starting || reading || Boolean(blocked) || !connectionId;
  const lineColor = line?.tone === 'caution' ? 'var(--status-warning)' : line?.tone === 'success' ? 'var(--status-success)' : t.textSecondary;
  return (
    <section aria-label="Read these tables" style={{ maxWidth: 640, border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10, fontFamily: t.font }}>
      <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.55 }}>
        ZLens reads names, types, comments and declared keys first, with no table scanned, so you can ask right away. The data checks behind the drafted models run in the background.
      </div>
      {estimates ? (
        <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>
          {estimates.names} {check ? estimates.checks : ''}
        </div>
      ) : null}
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: t.textSecondary, cursor: reading ? 'default' : 'pointer' }}>
        <input type="checkbox" checked={check} disabled={reading} onChange={(event) => setCheck(event.target.checked)} />
        <span>Check the data in the background <span style={{ color: t.textMuted }}>· keys, joins and rules, then the search index</span></span>
      </label>
      {credits && check ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: t.textSecondary }}>
          <span>Check on</span>
          <select
            value={checkSize}
            disabled={reading}
            onChange={(event) => setCheckSize(event.target.value as CheckWarehouseSize)}
            style={{ height: 26, borderRadius: 6, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textPrimary, fontSize: 11.5, fontFamily: t.font }}
          >
            {(['XSMALL', 'SMALL', 'MEDIUM'] as const).map((size) => (
              <option key={size} value={size}>{estimates ? checkSizeWords(estimates.checkSeconds, size) : size === 'XSMALL' ? 'X-Small (the app\'s own)' : size === 'SMALL' ? 'Small, then back to X-Small' : 'Medium, then back to X-Small'}</option>
            ))}
          </select>
          <span style={{ color: t.textMuted }}>(estimate)</span>
        </label>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => void start()}
          disabled={disabled}
          title={blocked ?? undefined}
          style={{ height: 32, padding: '0 14px', borderRadius: 8, border: 'none', background: t.accent, color: 'var(--accent-fg)', fontSize: 12, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, fontFamily: t.font }}
        >
          {reading ? 'Reading…' : status?.setup && status.stage !== 'failed' && status.stage !== 'stopped' ? 'Read again' : 'Read these tables'}
        </button>
        {reading && status?.operation?.cancellable ? (
          <button type="button" onClick={() => void stop()} style={{ height: 32, padding: '0 12px', borderRadius: 8, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 12, fontWeight: 650, cursor: 'pointer', fontFamily: t.font }}>
            Stop
          </button>
        ) : null}
        {blocked && !reading ? <span style={{ fontSize: 11, color: t.textMuted }}>{blocked}</span> : null}
      </div>
      {line ? <div role="status" style={{ fontSize: 11.5, color: lineColor, lineHeight: 1.5 }}>{line.text}</div> : null}
      {error ? <div role="alert" style={{ fontSize: 11.5, color: 'var(--status-error)' }}>{error}</div> : null}
    </section>
  );
}
