import { useCallback, useEffect, useState } from 'react';
import { api, type SnowflakeAppBackups } from '../../api/client';
import type { Theme } from '../../themes/notebook-theme';

/** "ZLENS_BACKUP_20261109_220000" as a date a person reads. */
export function backupLabel(name: string, createdOn?: string): string {
  const parsed = createdOn ? new Date(createdOn) : undefined;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const match = /(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/.exec(name);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC` : name;
}

/** The SQL an admin runs to put a snapshot back. */
export function restoreLine(app: string, name: string): string {
  return `CALL ${app}.app_public.restore_backup('${name}');`;
}

/** The SQL an admin runs to keep a copy outside the app. */
export function stageSetupLines(app: string): string[] {
  return [
    'CREATE STAGE MY_DB.MY_SCHEMA.ZLENS_BACKUPS;',
    `GRANT USAGE ON DATABASE MY_DB TO APPLICATION ${app};`,
    `GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ${app};`,
    `GRANT READ, WRITE ON STAGE MY_DB.MY_SCHEMA.ZLENS_BACKUPS TO APPLICATION ${app};`,
  ];
}

/**
 * Settings » Backups, in the ZLens app for Snowflake only (approved design B1–B6): the daily snapshots of the
 * app's volume and how to restore one, Back up now, and the copies in the customer's own stage.
 */
export function SnowflakeAppBackupsPanel({ t, initial }: { t: Theme; initial: SnowflakeAppBackups }) {
  const [status, setStatus] = useState<SnowflakeAppBackups>(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => { setStatus(await api.getSnowflakeAppBackups()); }, []);
  useEffect(() => {
    if (!status.running) return;
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [status.running, load]);

  const card = { border: `1px solid ${t.headerBorder}`, borderRadius: 10, padding: 14, background: t.cellBg, marginTop: 14 } as const;
  const muted = { fontSize: 12, color: t.textSecondary, lineHeight: 1.5 } as const;
  const button = { height: 28, padding: '0 11px', borderRadius: 6, border: `1px solid ${t.accent}`, background: t.accent, color: '#fff', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font } as const;
  const code = { display: 'block', fontFamily: t.fontMono, fontSize: 11.5, background: t.appBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, padding: '6px 8px', marginTop: 6, whiteSpace: 'pre-wrap' as const };

  const backUpNow = async () => {
    setError(null);
    try {
      await api.backUpSnowflakeAppNow();
      setMessage('Backing up: a snapshot of the projects, then a copy to your stage if one is set. This takes about a minute.');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const restore = async (file: string) => {
    if (!window.confirm(`Replace every project in ZLens with the copy ${file}? Work saved since then is lost (a snapshot of today's projects is taken first only if you back up now).`)) return;
    setError(null);
    try {
      await api.restoreSnowflakeAppExport(file, true);
      setMessage('Restoring. ZLens restarts to load the copy: reload this page in about a minute.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 700 }}>Backups</div>
      <div style={{ ...muted, marginTop: 4, maxWidth: 720 }}>
        ZLens backs up its projects once a day, when it stops for the day, and keeps the last 7. These backups stay inside
        the app: uninstalling it removes them, so keep a copy in a stage of your own as well (below).
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>Snapshots in the app</div>
          <button type="button" style={button} disabled={status.running} onClick={() => void backUpNow()}>
            {status.running ? 'Backing up…' : 'Back up now'}
          </button>
        </div>
        {status.snapshots.length === 0 ? (
          <div style={{ ...muted, marginTop: 8 }}>No backups yet. The first is taken when ZLens next stops for the day, or now.</div>
        ) : (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
            {status.snapshots.map((snapshot) => (
              <li key={snapshot.name}>
                {backupLabel(snapshot.name, snapshot.createdOn)}{snapshot.state === 'CREATED' ? '' : ` (${snapshot.state.toLowerCase()})`}
              </li>
            ))}
          </ul>
        )}
        {status.snapshots[0] && (
          <div style={{ ...muted, marginTop: 10 }}>
            To put one back, an admin runs this in a Snowsight worksheet. ZLens stops and starts again in about three minutes.
            <code style={code}>{restoreLine(status.app, status.snapshots[0].name)}</code>
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 650 }}>Copies in your own stage</div>
        {status.stage ? (
          <>
            <div style={{ ...muted, marginTop: 6 }}>
              Once a day, when something changed, ZLens copies its projects to <code>{status.stage}</code> and keeps the last 14.
              These copies stay if the app is uninstalled, and open in ZLens on a laptop too.
            </div>
            {status.exports.length === 0 ? (
              <div style={{ ...muted, marginTop: 8 }}>No copies yet.</div>
            ) : (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
                {status.exports.map((item) => (
                  <li key={item.file} style={{ marginTop: 3 }}>
                    <code>{item.file}</code>{' '}
                    <button type="button" onClick={() => void restore(item.file)} style={{ background: 'none', border: 'none', padding: 0, color: t.accent, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>
                      Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <div style={{ ...muted, marginTop: 6 }}>
            {status.stageError ?? 'Not set up. To keep a copy that outlives the app, an admin runs this in a worksheet (your database and schema in place of MY_DB and MY_SCHEMA), then enters MY_DB.MY_SCHEMA.ZLENS_BACKUPS as "Stage for ZLens backups" on the app\'s Configurations tab:'}
            {!status.stageError && <code style={code}>{stageSetupLines(status.app).join('\n')}</code>}
          </div>
        )}
      </div>
      {message && <div role="status" style={{ ...muted, marginTop: 10, color: 'var(--status-success)' }}>{message}</div>}
      {error && <div role="alert" style={{ ...muted, marginTop: 10, color: t.error }}>{error}</div>}
    </div>
  );
}
