import { useCallback, useEffect, useState } from 'react';
import { api, type SnowflakeAppBackups, type SnowflakeAppSetupStatus } from '../../api/client';
import { useDispatch } from '../../store/NotebookStore';

const POLL_MS = 3000;
const DISMISSED_KEY = 'zlens.snowflakeAppSetup.dismissed';

function readDismissed(): string | null {
  try { return window.localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}

function writeDismissed(value: string): void {
  try { window.localStorage.setItem(DISMISSED_KEY, value); } catch { /* the banner just shows again */ }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the strip says, or nothing. Exported for tests. */
export function snowflakeAppSetupMessage(status: SnowflakeAppSetupStatus | null): { tone: 'info' | 'caution'; text: string; action?: 'review' | 'retry'; key?: string } | null {
  if (!status?.managed) return null;
  const database = status.database ?? 'your database';
  if (status.state === 'idle' || status.state === 'running') {
    return { tone: 'info', text: `ZLens is reading the tables in ${database} and drafting your models. This takes a minute or two.` };
  }
  if (status.state === 'failed') {
    return { tone: 'caution', text: `ZLens could not read the tables in ${database}: ${status.error ?? 'unknown error'}`, action: 'retry' };
  }
  const waiting = status.waitingDraft;
  if (!waiting) return null;
  const read = typeof status.relations === 'number' ? `ZLens read ${plural(status.relations, 'table or view', 'tables and views')} in ${database} and drafted ` : 'ZLens drafted ';
  return {
    tone: 'info',
    text: `${read}${plural(waiting.models, 'model', 'models')}${waiting.joins ? ` and ${plural(waiting.joins, 'join', 'joins')}` : ''}. Nothing is saved until you review them.`,
    action: 'review',
    key: waiting.proposalId,
  };
}

/**
 * After a reinstall the project is empty, but the customer's stage may hold a copy of the old one (backup design
 * B5): offer the newest. Nothing to offer once anything is saved, or with no copies. Exported for tests.
 */
export function snowflakeAppRestoreOffer(backups: SnowflakeAppBackups | null): { text: string; file: string } | null {
  if (!backups?.managed || !backups.projectIsEmpty || !backups.stage) return null;
  const newest = backups.exports[0];
  if (!newest) return null;
  const when = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/.exec(newest.file);
  const date = when ? `${when[1]}-${when[2]}-${when[3]}` : newest.lastModified;
  return { text: `A copy of your ZLens projects from ${date} is in ${backups.stage}.`, file: newest.file };
}

/**
 * The ZLens app for Snowflake sets itself up: it reads the tables in the database it was granted and drafts
 * the models. This strip says so while it runs, then points to the drafts waiting for review.
 * Renders nothing outside the Snowflake app.
 */
export function SnowflakeAppSetupBanner({ enabled }: { enabled: boolean }) {
  const dispatch = useDispatch();
  const [status, setStatus] = useState<SnowflakeAppSetupStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());

  const [backups, setBackups] = useState<SnowflakeAppBackups | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await api.getSnowflakeAppSetup()); } catch { /* a missing strip must not break the page */ }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    void api.getSnowflakeAppBackups().then(setBackups);
  }, [enabled, load]);

  const settled = status?.state === 'done' || status?.state === 'failed' || status?.managed === false;
  useEffect(() => {
    if (!enabled || settled) return;
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, settled, load]);

  const offer = enabled ? snowflakeAppRestoreOffer(backups) : null;
  if (offer && dismissed !== `restore:${offer.file}`) {
    const link = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'var(--accent)', fontWeight: 600, textDecoration: 'underline' } as const;
    return (
      <div role="status" data-testid="snowflake-app-restore-offer" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 14px', padding: '6px 16px', fontSize: 12.5, lineHeight: 1.4, background: 'var(--accent-dim)', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontWeight: 600 }}>{restoring ?? offer.text}</span>
        {!restoring && (
          <button
            type="button"
            style={link}
            onClick={() => {
              setRestoring('Restoring. ZLens restarts to load your projects: this page reloads in about a minute.');
              void api.restoreSnowflakeAppExport(offer.file)
                .then(() => { window.setTimeout(() => window.location.reload(), 60_000); })
                .catch((cause) => setRestoring(`Could not restore: ${cause instanceof Error ? cause.message : String(cause)}`));
            }}
          >
            Restore it
          </button>
        )}
        {!restoring && (
          <button type="button" aria-label="Hide" style={{ ...link, marginLeft: 'auto', textDecoration: 'none', color: 'var(--text-secondary)' }} onClick={() => { writeDismissed(`restore:${offer.file}`); setDismissed(`restore:${offer.file}`); }}>
            ×
          </button>
        )}
      </div>
    );
  }
  const message = enabled ? snowflakeAppSetupMessage(status) : null;
  if (!message || (message.key && message.key === dismissed)) return null;
  const caution = message.tone === 'caution';
  const linkStyle = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: caution ? 'var(--status-warning, var(--accent))' : 'var(--accent)', fontWeight: 600, textDecoration: 'underline' } as const;
  return (
    <div
      role="status"
      data-testid="snowflake-app-setup-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '6px 14px',
        padding: '6px 16px',
        fontSize: 12.5,
        lineHeight: 1.4,
        background: caution ? 'var(--status-warning-bg, var(--accent-dim))' : 'var(--accent-dim)',
        color: 'var(--text-primary)',
        borderBottom: `1px solid ${caution ? 'var(--status-warning-border, var(--border-default))' : 'var(--border-subtle)'}`,
      }}
    >
      <span style={{ fontWeight: 600 }}>{message.text}</span>
      {message.action === 'review' && (
        <button type="button" style={linkStyle} onClick={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'modeling' })}>Review the drafts</button>
      )}
      {message.action === 'retry' && (
        <button type="button" style={linkStyle} onClick={() => { void api.retrySnowflakeAppSetup().then(setStatus).catch(() => undefined); }}>Try again</button>
      )}
      {message.key && (
        <button
          type="button"
          aria-label="Hide"
          style={{ ...linkStyle, marginLeft: 'auto', textDecoration: 'none', color: 'var(--text-secondary)' }}
          onClick={() => { writeDismissed(message.key!); setDismissed(message.key!); }}
        >
          ×
        </button>
      )}
    </div>
  );
}
