import React, { useState } from 'react';
import { useNotebookStore } from '../store/NotebookStore';
import { themes } from '../themes/notebook-theme';
import { useZLensStopped, type ZLensStopped } from './zlens-stopped';

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

/**
 * The app for Snowflake stopped (zlens-stopped.ts): say so over the page, and start it again only when the
 * person asks. Reloading the page opens ZLens's address, which wakes the service.
 */
export function ZLensStoppedNotice() {
  const stopped = useZLensStopped();
  const themeMode = useNotebookStore((state) => state.themeMode);
  const [starting, setStarting] = useState(false);
  if (!stopped) return null;
  const t = themes[themeMode];
  const words = zlensStoppedWords(stopped);
  const start = () => {
    setStarting(true);
    window.location.reload();
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
          {starting ? <span role="status" style={{ fontSize: 12.5, color: t.textSecondary }}>Starting ZLens…</span> : null}
          <button
            type="button"
            autoFocus
            onClick={start}
            disabled={starting}
            style={{ fontSize: 13, padding: '7px 14px', borderRadius: 6, border: 'none', background: t.accent, color: '#fff', cursor: starting ? 'default' : 'pointer', opacity: starting ? 0.6 : 1 }}
          >
            Start ZLens again
          </button>
        </div>
      </div>
    </div>
  );
}
