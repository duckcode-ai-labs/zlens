import type { CortexAskReadiness } from '@zlens/agent';
import { appCoreTable, sqlString } from './history/history-sql-log.js';

/**
 * ASK READINESS FOR THE LAUNCHER. In the ZLens app for Snowflake, the launcher page (Snowsight's Launch app) cannot
 * reach ZLens itself: it reads `app_public.launcher_status()`, which returns the last Ask readiness ZLens kept in the
 * app's own table `<app>.core.ask_readiness` (setup.sql) as its `ask_readiness` field. So the admin who installed the
 * app sees "Ask is not ready" and the exact grant line on the page they are already on, before anyone asks.
 *
 * One row (id 1), written when a result is new or differs from the last one. Never SQL, rows, questions or anything
 * from the customer's data: the readiness state, its words, the fix line, the model and the time. Best effort: if
 * the write fails (the container's session may not be allowed to write to the app's schema), the launcher simply
 * shows no Ask line, and ZLens's own pages still show readiness.
 */
export const ASK_READINESS_TABLE = 'ASK_READINESS';

/** The fields the launcher shows (and nothing else). */
export function launcherAskReadiness(readiness: CortexAskReadiness): Record<string, string> {
  const fields: Record<string, string | undefined> = {
    state: readiness.state,
    headline: readiness.headline,
    message: readiness.message,
    fixSql: readiness.fixSql,
    fixIntro: readiness.fixIntro,
    model: readiness.model,
    fellBackFrom: readiness.fellBackFrom,
    checkedAt: readiness.checkedAt,
  };
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
}

/** The statement that keeps `readiness` as the one row of `<app>.CORE.ASK_READINESS`; null when the app's name is unusable. */
export function askReadinessStatement(appName: string, readiness: CortexAskReadiness): string | null {
  const table = appCoreTable(appName, ASK_READINESS_TABLE);
  if (!table) return null;
  const json = sqlString(JSON.stringify(launcherAskReadiness(readiness)), 8000);
  return [
    `MERGE INTO ${table} t`,
    `USING (SELECT 1 AS id, PARSE_JSON(${json}) AS readiness, TO_TIMESTAMP_TZ(${sqlString(readiness.checkedAt, 40)}) AS checked_at) s`,
    'ON t.id = s.id',
    'WHEN MATCHED THEN UPDATE SET readiness = s.readiness, checked_at = s.checked_at',
    'WHEN NOT MATCHED THEN INSERT (id, readiness, checked_at) VALUES (s.id, s.readiness, s.checked_at)',
  ].join('\n');
}

/**
 * Writes a result for the launcher when it is new or changed. The first result after a start is always written, so
 * the launcher's "checked at" is this run's. A failed write is told once and then skipped for the run.
 */
export function askReadinessWriter(options: {
  appName: string;
  query: (sql: string) => Promise<unknown>;
  warn?: (message: string) => void;
}): (readiness: CortexAskReadiness, changed: boolean) => Promise<void> {
  let written = false;
  let skipped = false;
  return async (readiness, changed) => {
    if (skipped || (written && !changed)) return;
    const statement = askReadinessStatement(options.appName, readiness);
    if (!statement) return;
    try {
      await options.query(statement);
      written = true;
    } catch (error) {
      skipped = true;
      (options.warn ?? console.warn)(`[zlens] Could not keep Ask readiness for the launcher (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); ZLens's own pages still show it.`);
    }
  };
}
