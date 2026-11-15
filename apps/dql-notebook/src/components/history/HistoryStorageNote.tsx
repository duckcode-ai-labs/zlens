import { useEffect, useState } from 'react';
import { historyApi, type HistoryStatus } from '../../api/history';
import type { Theme } from '../../themes/notebook-theme';
import { formatBytes } from './history-words';

/**
 * Settings » Backups, in the app for Snowflake: how much room History takes on the app's volume (V15), with a
 * warning from 1 GiB, and whether its change log reached the app's SQL view.
 */
export function historyStorageWords(status: HistoryStatus): { line: string; warning?: string; log: string } {
  const line = `History keeps ${status.versions} version${status.versions === 1 ? '' : 's'} of ${status.items} item${status.items === 1 ? '' : 's'} and takes ${formatBytes(status.sizeBytes)} of the app's volume.`;
  const warning = status.sizeWarning
    ? `That is over ${formatBytes(status.warnAtBytes)}. The volume holds 10 GB in all: keep an eye on it, and ask your Snowflake admin before it fills.`
    : undefined;
  const log = status.sqlLog.state === 'skipped'
    ? 'Its change log could not be written to the app_public.history view; History itself works.'
    : status.sqlLog.state === 'written' || (status.sqlLog.state === 'nothing' && status.sqlLog.lastWrittenAt)
      ? `Its change log is readable with SQL in ${status.sqlLog.table?.split('.')[0] ?? 'the app'}.app_public.history.`
      : status.sqlLog.state === 'off'
        ? 'Its change log is not copied to SQL here.'
        : `Its change log reaches the app_public.history view in batches${status.sqlLog.pending ? ` (${status.sqlLog.pending} waiting)` : ''}.`;
  return { line, ...(warning ? { warning } : {}), log };
}

export function HistoryStorageNote({ t }: { t: Theme }): JSX.Element | null {
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  useEffect(() => {
    let active = true;
    historyApi.status().then((loaded) => { if (active) setStatus(loaded); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  if (!status) return null;
  const words = historyStorageWords(status);
  return (
    <div data-testid="history-storage" style={{ border: `1px solid ${status.sizeWarning ? t.warning : t.headerBorder}`, borderRadius: 10, padding: 14, background: t.cellBg, marginTop: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: t.textPrimary, marginBottom: 6 }}>History</div>
      <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5 }}>{words.line} {words.log}</div>
      {words.warning ? <div role="alert" style={{ fontSize: 12, color: t.warning, lineHeight: 1.5, marginTop: 6 }}>{words.warning}</div> : null}
    </div>
  );
}
