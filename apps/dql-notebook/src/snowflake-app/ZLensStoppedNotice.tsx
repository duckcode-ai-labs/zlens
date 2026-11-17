import React, { useEffect, useState } from 'react';
import { useNotebookStore } from '../store/NotebookStore';
import { themes } from '../themes/notebook-theme';
import { useSnowflakeApp } from './snowflake-app-mode';
import { START_GIVE_UP_MS, startZLensAgain, useZLensStopped, watchForStoppedService, type ZLensStopped } from './zlens-stopped';

/** What the page says once ZLens stopped. */
export function zlensStoppedWords(stopped: ZLensStopped): { title: string; detail: string; start: string } {
  if (stopped.startNow) {
    return {
      title: 'ZLens is starting',
      detail: 'ZLens had stopped. It is starting again now.',
      start: 'This takes about 2 to 3 minutes, longer right after an install or update.',
    };
  }
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

/**
 * After a stop, Snowflake asks the person to sign in again before it lets them back in, even minutes after the last
 * sign-in (V17 tester: 5 times in a day). A page that sends the person to sign in at once has them back before ZLens
 * is ready; so it waits until ZLens has usually started (restarts took 1 to 2.5 minutes) and says why.
 */
export const SIGN_IN_AFTER_MS = 120_000;

/** The line while the page waits to send the person to Snowflake's sign-in. */
export function signInWords(elapsedMs: number): string {
  const left = Math.max(0, Math.ceil((SIGN_IN_AFTER_MS - elapsedMs) / 1000));
  return `After a stop, Snowflake asks you to sign in again. This page takes you there in ${left} s. If Snowflake then says the service is not yet running, ZLens needs a little longer: reload that page in a minute.`;
}

type StartState =
  | { phase: 'waiting' }
  | { phase: 'starting'; since: number }
  | { phase: 'sign-in'; since: number }
  | { phase: 'gave-up' };

/**
 * The app for Snowflake stopped (zlens-stopped.ts): say so over the page, and start it again only when the
 * person asks. The page stays here while ZLens starts and opens it only once ZLens answers.
 */
export function ZLensStoppedNotice() {
  const stopped = useZLensStopped();
  const snowflakeApp = useSnowflakeApp();
  const themeMode = useNotebookStore((state) => state.themeMode);
  useEffect(() => {
    // Only inside Snowflake: there, Snowflake answers a request for a stopped app itself.
    if (snowflakeApp) watchForStoppedService();
  }, [snowflakeApp]);
  const [state, setState] = useState<StartState>({ phase: 'waiting' });
  const [now, setNow] = useState(() => Date.now());
  const start = () => {
    const since = Date.now();
    setNow(since);
    setState({ phase: 'starting', since });
    void startZLensAgain().then((outcome) => {
      if (outcome === 'gave-up') setState({ phase: 'gave-up' });
      else if (outcome === 'sign-in') setState({ phase: 'sign-in', since });
      else window.location.reload();
    });
  };
  useEffect(() => {
    if (state.phase !== 'starting' && state.phase !== 'sign-in') return undefined;
    // A clock on the page only: it sends nothing.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);
  useEffect(() => {
    if (state.phase !== 'sign-in') return undefined;
    // Off to Snowflake's sign-in once ZLens has usually started; it comes back to ZLens after the sign-in.
    const timer = setTimeout(() => window.location.reload(), Math.max(0, state.since + SIGN_IN_AFTER_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    // The person is here and ZLens has already been asked to start (their request woke it): no need to ask them.
    if (stopped?.startNow && state.phase === 'waiting') start();
    // start() only reads module functions and sets state; it changes with every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopped, state.phase]);
  if (!stopped) return null;
  const t = themes[themeMode];
  // Once ZLens is starting, the notice says so, whatever stopped it (V17 patch 4 tester: the countdown showed under
  // "ZLens stopped … will not start it again by itself").
  const words = zlensStoppedWords(state.phase === 'starting' || state.phase === 'sign-in' ? { ...stopped, startNow: true } : stopped);
  const starting = state.phase === 'starting';
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
          {state.phase === 'sign-in' ? <span role="status" style={{ fontSize: 12.5, lineHeight: 1.5, color: t.textSecondary }}>{signInWords(now - state.since)}</span> : null}
          <button
            type="button"
            autoFocus
            onClick={state.phase === 'sign-in' ? () => window.location.reload() : start}
            disabled={starting}
            style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: 'none', background: t.accent, color: '#fff', cursor: starting ? 'default' : 'pointer', opacity: starting ? 0.6 : 1 }}
          >
            {state.phase === 'gave-up' ? 'Check again' : state.phase === 'sign-in' ? 'Sign in now' : 'Start ZLens again'}
          </button>
        </div>
      </div>
    </div>
  );
}
