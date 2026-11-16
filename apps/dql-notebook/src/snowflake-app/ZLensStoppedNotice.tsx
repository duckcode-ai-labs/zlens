import React, { useEffect, useState } from 'react';
import { useNotebookStore } from '../store/NotebookStore';
import { themes } from '../themes/notebook-theme';
import { START_GIVE_UP_MS, startZLensAgain, useZLensStopped, type ZLensStopped } from './zlens-stopped';

/** What the page says once ZLens stopped. */
export function zlensStoppedWords(stopped: ZLensStopped): { title: string; detail: string; start: string } {
  const minutes = stopped.idleMinutes;
  const detail = stopped.reason === 'idle'
    ? `ZLens stopped because no one used it for ${minutes === undefined ? 'a while' : `${minutes} minute${minutes === 1 ? '' : 's'}`}.`
    : stopped.reason === 'stopped'
      ? 'ZLens was stopped.'
      : 'ZLens was stopped, or this page lost its connection to it.';
  return {
    title: 'ZLens stopped',
    detail: `${detail} This page will not start it again by itself.`,
    start: 'Starting ZLens takes about 2 to 3 minutes, longer right after an install or update.',
  };
}

/** The line while ZLens starts again: the time so far, as m:ss. */
export function startingWords(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `Starting ZLens… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}. This page opens it when it is ready.`;
}

export const GAVE_UP_WORDS = `ZLens has not started after ${Math.round(START_GIVE_UP_MS / 60_000)} minutes. Check again in a few minutes.`;

type StartState = { phase: 'waiting' } | { phase: 'starting'; since: number } | { phase: 'gave-up' };

/**
 * The app for Snowflake stopped (zlens-stopped.ts): say so over the page, and start it again only when the
 * person asks. The page stays here while ZLens starts and opens it only once ZLens answers.
 */
export function ZLensStoppedNotice() {
  const stopped = useZLensStopped();
  const themeMode = useNotebookStore((state) => state.themeMode);
  const [state, setState] = useState<StartState>({ phase: 'waiting' });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.phase !== 'starting') return undefined;
    // A clock on the page only: it sends nothing.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);
  if (!stopped) return null;
  const t = themes[themeMode];
  const words = zlensStoppedWords(stopped);
  const starting = state.phase === 'starting';
  const start = () => {
    const since = Date.now();
    setNow(since);
    setState({ phase: 'starting', since });
    void startZLensAgain().then((outcome) => {
      if (outcome === 'gave-up') setState({ phase: 'gave-up' });
      else window.location.reload();
    });
  };
  return (
    <div data-testid="zlens-stopped" style={{ position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: t.modalOverlay }}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="zlens-stopped-title"
        aria-describedby="zlens-stopped-detail"
        style={{ width: '100%', maxWidth: 460, background: t.modalBg, border: `1px solid ${t.cellBorder}`, borderRadius: 10, padding: 20, fontFamily: t.font, color: t.textPrimary, display: 'flex', flexDirection: 'column', gap: 12 }}
      >
        <h2 id="zlens-stopped-title" style={{ fontSize: 16, fontWeight: 600 }}>{words.title}</h2>
        <p id="zlens-stopped-detail" style={{ fontSize: 13, lineHeight: 1.5, color: t.textSecondary }}>{words.detail}</p>
        <p style={{ fontSize: 12.5, lineHeight: 1.5, color: t.textMuted }}>{words.start}</p>
        {state.phase === 'gave-up' ? <p role="status" style={{ fontSize: 12.5, lineHeight: 1.5, color: t.textSecondary }}>{GAVE_UP_WORDS}</p> : null}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
          {state.phase === 'starting' ? <span role="status" style={{ fontSize: 12.5, color: t.textSecondary }}>{startingWords(now - state.since)}</span> : null}
          <button
            type="button"
            autoFocus
            onClick={start}
            disabled={starting}
            style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: 'none', background: t.accent, color: '#fff', cursor: starting ? 'default' : 'pointer', opacity: starting ? 0.6 : 1 }}
          >
            {state.phase === 'gave-up' ? 'Check again' : 'Start ZLens again'}
          </button>
        </div>
      </div>
    </div>
  );
}
