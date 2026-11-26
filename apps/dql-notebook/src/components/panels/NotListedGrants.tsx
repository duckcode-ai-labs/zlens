import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { themes } from '../../themes/notebook-theme';

/** The grants that let the app read another database or schema, with its name filled in. Exported for tests. */
export function notListedGrantLines(appName: string): string {
  const app = appName || '<this app>';
  return [
    `GRANT USAGE ON DATABASE MY_DB TO APPLICATION ${app};`,
    `GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ${app};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ${app};`,
    `GRANT SELECT ON ALL VIEWS IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ${app};`,
  ].join('\n');
}

/**
 * Under the schema picker in the ZLens app for Snowflake (onboarding design P6): the app lists only what is granted
 * to it, so a database or schema not listed needs a grant from the Snowflake admin. Grants stay the admin's job.
 */
export function NotListedGrants({ t }: { t: (typeof themes)[keyof typeof themes] }) {
  const [appName, setAppName] = useState('');
  useEffect(() => {
    let alive = true;
    void api.getSnowflakeAppSetup().then((status) => { if (alive && status.appName) setAppName(status.appName); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return (
    <details style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
      <summary style={{ cursor: 'pointer' }}>Not listed? Your Snowflake admin grants it to this app</summary>
      <div style={{ marginTop: 6, lineHeight: 1.5 }}>
        Run this in a worksheet with your database and schema in place of MY_DB and MY_SCHEMA, then press Find available databases &amp; schemas again. ZLens sees a new grant within a minute.
      </div>
      <pre style={{ marginTop: 6, padding: '8px 10px', borderRadius: 7, border: `1px solid ${t.cellBorder}`, background: t.editorBg, color: t.textPrimary, fontFamily: t.fontMono, fontSize: 10.5, whiteSpace: 'pre-wrap' }}>
        {notListedGrantLines(appName)}
      </pre>
    </details>
  );
}
