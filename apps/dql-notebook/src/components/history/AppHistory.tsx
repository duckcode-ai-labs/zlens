import { useEffect } from 'react';
import { History as HistoryIcon, X } from 'lucide-react';
import type { HistoryRestoreResult } from '../../api/history';
import { useSnowflakeApp } from '../../snowflake-app/snowflake-app-mode';
import type { Theme } from '../../themes/notebook-theme';
import { ItemHistory, smallButton } from './ItemHistory';
import { appHistoryPath } from './history-navigation';

/**
 * An App's History (V2, the ZLens app for Snowflake only). From App Studio's "More draft actions" menu and from the
 * App's view: every saved version of the App (its App Studio saves and its publishes), with Compare, and Restore
 * as a draft, as saved queries have. Nothing here outside the app for Snowflake: open source keeps Source control.
 */

/** The "History" entry of App Studio's "More draft actions" menu. */
export function AppHistoryMenuItem({ onOpen }: { onOpen: () => void }): JSX.Element | null {
  const snowflakeApp = useSnowflakeApp();
  if (!snowflakeApp) return null;
  return (
    <button type="button" role="menuitem" onClick={onOpen}>
      <HistoryIcon size={14} /> History
    </button>
  );
}

/** The App view's History button: opens the App's versions on the History page. */
export function AppHistoryButton({ appId, className, onOpen }: { appId: string; className?: string; onOpen: (path: string) => void }): JSX.Element | null {
  const snowflakeApp = useSnowflakeApp();
  if (!snowflakeApp) return null;
  return (
    <button type="button" className={className} title="History: every saved version of this App" aria-label="History" onClick={() => onOpen(appHistoryPath(appId))}>
      <HistoryIcon size={15} />
    </button>
  );
}

/** The App's versions over App Studio: the versions table, Compare and Restore (as the App's draft). */
export function AppHistoryDialog({
  appId, name, t, onClose, onCompare, onRestored,
}: {
  appId: string;
  name: string;
  t: Theme;
  onClose: () => void;
  onCompare: (from: number, to: number) => void;
  onRestored?: (result: HistoryRestoreResult) => void;
}): JSX.Element {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15, 23, 42, 0.35)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 16px' }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`History of ${name}`}
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(960px, 100%)', maxHeight: '86vh', overflow: 'auto', background: t.appBg, color: t.textPrimary, border: `1px solid ${t.cellBorder}`, borderRadius: 12, boxShadow: '0 18px 48px rgba(15, 23, 42, 0.25)', fontFamily: t.font }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: `1px solid ${t.cellBorder}` }}>
          <HistoryIcon size={16} color={t.accent} aria-hidden="true" />
          <h2 style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 15, fontWeight: 650, overflowWrap: 'anywhere' }}>History · {name}</h2>
          <button type="button" onClick={onClose} aria-label="Close History" style={{ ...smallButton(t), padding: '0 6px' }}><X size={14} /></button>
        </header>
        <ItemHistory path={appHistoryPath(appId)} t={t} onCompare={onCompare} {...(onRestored ? { onRestored } : {})} />
      </section>
    </div>
  );
}
