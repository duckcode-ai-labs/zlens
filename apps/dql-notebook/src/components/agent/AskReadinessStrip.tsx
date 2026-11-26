import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api, type AskReadiness } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';

/**
 * ASK IS NOT READY, SAID WHERE PEOPLE MEET ASK (fix plan risk 3). A person must never find out that Ask's Snowflake
 * Cortex is not set up by asking a question and getting a raw error: above the question box, this strip says so
 * with the one line an admin runs (the CORTEX_USER grant with the app's real name, or the account's cross-region
 * setting) and a "Check again". The words come from the server (GET /api/ask/readiness), the same ones the launcher
 * shows. Nothing shows while Ask is ready, while the first check runs, or when Ask does not use Cortex.
 */

/** What the strip shows, or nothing. Exported for tests. */
export function askReadinessStrip(readiness: AskReadiness | null): {
  headline: string;
  message?: string;
  fixIntro?: string;
  fixSql?: string;
  checkedAt: string;
} | null {
  if (!readiness || readiness.state === 'not_applicable' || readiness.state === 'checking' || readiness.state === 'ready') return null;
  return {
    headline: readiness.headline,
    ...(readiness.message ? { message: readiness.message } : {}),
    ...(readiness.fixSql ? { fixSql: readiness.fixSql, ...(readiness.fixIntro ? { fixIntro: readiness.fixIntro } : {}) } : {}),
    checkedAt: readiness.checkedAt,
  };
}

/** "Checked at 14:05": the check's time on this computer's clock. */
export function checkedAtLabel(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  return `Checked at ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
}

// One reading for every Ask panel on the page: the server keeps the result, so panels share it.
let shared: AskReadiness | null = null;
let readAt = 0;
let reading: Promise<void> | null = null;
const listeners = new Set<(value: AskReadiness | null) => void>();

function publish(value: AskReadiness): void {
  shared = value;
  readAt = Date.now();
  for (const listener of listeners) listener(value);
}

/** Reads the server's readiness, at most once a minute unless `force`. */
function readAskReadiness(force = false): Promise<void> {
  if (reading) return reading;
  if (!force && shared && Date.now() - readAt < 60_000) return Promise.resolve();
  // Started inside a promise, so a page (or a test) without this API just shows no strip.
  reading = Promise.resolve()
    .then(() => api.getAskReadiness())
    .then(publish)
    .catch(() => { /* a missing strip must not break Ask */ })
    .finally(() => { reading = null; });
  return reading;
}

/** Tests: forget the shared reading. */
export function resetAskReadinessForTests(): void {
  shared = null;
  readAt = 0;
  reading = null;
}

const CHECKING_POLL_MS = 3_000;
const NOT_READY_POLL_MS = 60_000;

export function AskReadinessStrip({ t, style, initial }: { t: Theme; style?: CSSProperties; /** Tests and previews: the reading to start from. */ initial?: AskReadiness | null }): JSX.Element | null {
  const [readiness, setReadiness] = useState<AskReadiness | null>(initial !== undefined ? initial : shared);
  const [rechecking, setRechecking] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    listeners.add(setReadiness);
    void readAskReadiness();
    return () => { listeners.delete(setReadiness); };
  }, []);

  // While the first check runs, ask again every few seconds; while Ask is not ready, every minute (the server
  // checks again by itself, so a grant an admin runs shows here without a reload).
  useEffect(() => {
    if (!readiness || readiness.state === 'ready' || readiness.state === 'not_applicable') return undefined;
    const timer = window.setTimeout(() => { void readAskReadiness(true); }, readiness.state === 'checking' ? CHECKING_POLL_MS : NOT_READY_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [readiness]);

  const checkAgain = useCallback(async () => {
    setRechecking(true);
    try {
      publish(await api.checkAskReadinessAgain());
    } catch {
      /* the strip keeps what it showed */
    } finally {
      setRechecking(false);
    }
  }, []);

  const strip = askReadinessStrip(readiness);
  if (!strip) return null;
  const copy = () => {
    if (!strip.fixSql) return;
    void navigator.clipboard?.writeText(strip.fixSql).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };
  const button: CSSProperties = {
    border: '1px solid var(--border-default)',
    background: 'var(--bg-2)',
    color: t.textPrimary,
    borderRadius: 7,
    padding: '3px 10px',
    fontSize: 12,
    cursor: 'pointer',
  };
  return (
    <div
      role="alert"
      data-testid="ask-readiness-strip"
      style={{
        display: 'grid',
        gap: 6,
        padding: '10px 12px',
        marginBottom: 8,
        borderRadius: 10,
        border: `1px solid color-mix(in srgb, ${t.warning} 45%, transparent)`,
        background: `color-mix(in srgb, ${t.warning} 8%, var(--bg-2))`,
        fontSize: 12.5,
        lineHeight: 1.5,
        color: t.textSecondary,
        ...style,
      }}
    >
      <div style={{ fontWeight: 600, color: t.textPrimary }}>{strip.headline}</div>
      {strip.message ? <div>{strip.message}</div> : null}
      {strip.fixSql ? (
        <>
          {strip.fixIntro ? <div style={{ fontSize: 11.5, color: t.textMuted }}>{strip.fixIntro}</div> : null}
          <code
            data-testid="ask-readiness-fix"
            style={{ display: 'block', fontFamily: t.fontMono, fontSize: 12, padding: '6px 8px', borderRadius: 6, background: 'var(--bg-1)', border: '1px solid var(--border-subtle)', color: t.textPrimary, whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' }}
          >
            {strip.fixSql}
          </code>
        </>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <button type="button" onClick={() => { void checkAgain(); }} disabled={rechecking} style={{ ...button, cursor: rechecking ? 'default' : 'pointer' }}>
          {rechecking ? 'Checking…' : 'Check again'}
        </button>
        {strip.fixSql ? <button type="button" onClick={copy} style={button}>{copied ? 'Copied' : 'Copy the line'}</button> : null}
        <span style={{ fontSize: 11, color: t.textMuted }}>{checkedAtLabel(strip.checkedAt)}</span>
      </div>
    </div>
  );
}
