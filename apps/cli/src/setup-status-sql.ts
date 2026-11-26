/**
 * Setup's status for the launcher page (onboarding design P5): the container
 * keeps one row in the app's own table `<app>.core.setup_status`, the way
 * History writes `core.history_log`, and `app_public.launcher_status()`
 * returns it, so the page in Snowsight can say "ZLens is ready to ask.
 * Background checks: 25%." before ZLens opens.
 *
 * Best effort: a change of stage is written at once, progress at most every
 * `minIntervalMs`. If writing fails (the container's session may not be
 * allowed to write the app's own schema), it is skipped for the rest of the
 * run with one warning; setup is unaffected.
 *
 * The row also carries Ask's readiness (fix plan risk 3) in `ask_readiness`:
 * whether Ask's Snowflake Cortex is set up, and the one line an ACCOUNTADMIN
 * runs when it is not, so the launcher can say so before anyone asks. One row,
 * one write path, one launcher read.
 */
import { sqlString } from './history/history-sql-log.js';

/** Ask's readiness as the launcher shows it: the server's words, never anything from the person's data. */
export type LauncherAskReadiness = Record<string, string>;

export interface SetupStatusRow {
  stage: string;
  line: string;
  percent: number | null;
  /** Ask's readiness (settings/ask-readiness.ts), in the launcher's fields; absent before ZLens has checked. */
  askReadiness?: LauncherAskReadiness;
}

/** The Ask readiness fields the launcher shows (and nothing else); undefined before a check has answered. */
export function launcherAskReadiness(readiness: { state: string; headline?: string; message?: string; fixSql?: string; fixIntro?: string; model?: string; fellBackFrom?: string; checkedAt?: string } | null | undefined): LauncherAskReadiness | undefined {
  if (!readiness?.headline || readiness.state === 'checking' || readiness.state === 'not_applicable') return undefined;
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

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function setupStatusTable(appName: string): string | null {
  const name = appName.trim();
  if (!name) return null;
  const app = IDENTIFIER.test(name) ? name : /^[^"\u0000-\u001f]+$/.test(name) ? `"${name}"` : null;
  return app ? `${app}.CORE.SETUP_STATUS` : null;
}

/** One row, kept as the only one (id 1). */
export function setupStatusStatement(table: string, row: SetupStatusRow): string {
  const percent = row.percent === null || !Number.isFinite(row.percent) ? 'NULL' : String(Math.max(0, Math.min(100, Math.round(row.percent))));
  // Quotes doubled by sqlString, so the JSON survives the string literal.
  const ask = row.askReadiness ? `PARSE_JSON(${sqlString(JSON.stringify(row.askReadiness), 8000)})` : 'NULL';
  return [
    `MERGE INTO ${table} t`,
    `USING (SELECT 1 AS id, CURRENT_TIMESTAMP() AS updated_at, ${sqlString(row.stage, 40)} AS stage, ${sqlString(row.line, 500)} AS line, ${percent} AS percent, ${ask} AS ask_readiness) s`,
    'ON t.id = s.id',
    'WHEN MATCHED THEN UPDATE SET updated_at = s.updated_at, stage = s.stage, line = s.line, percent = s.percent, ask_readiness = s.ask_readiness',
    'WHEN NOT MATCHED THEN INSERT (id, updated_at, stage, line, percent, ask_readiness) VALUES (s.id, s.updated_at, s.stage, s.line, s.percent, s.ask_readiness)',
  ].join('\n');
}

export class SetupStatusWriter {
  private skipped = false;
  private lastWritten = 0;
  private lastRow: string | undefined;
  private pending: Promise<void> = Promise.resolve();
  private readonly table: string | null;

  constructor(private readonly options: {
    appName: string;
    query: (sql: string) => Promise<unknown>;
    minIntervalMs?: number;
    now?: () => number;
    warn?: (message: string) => void;
  }) {
    this.table = setupStatusTable(options.appName);
  }

  /** Writes the row: at once when `force` (a change of stage), else when the last write is old enough. */
  write(row: SetupStatusRow, options: { force?: boolean } = {}): Promise<void> {
    if (!this.table || this.skipped) return this.pending;
    const key = JSON.stringify(row);
    if (key === this.lastRow) return this.pending;
    const now = this.options.now?.() ?? Date.now();
    if (!options.force && now - this.lastWritten < (this.options.minIntervalMs ?? 30_000)) return this.pending;
    this.lastWritten = now;
    this.lastRow = key;
    const table = this.table;
    this.pending = this.pending.then(async () => {
      if (this.skipped) return;
      try {
        await this.options.query(setupStatusStatement(table, row));
      } catch (error) {
        this.skipped = true;
        (this.options.warn ?? console.warn)(`[zlens] Could not write setup's status to ${table} (${error instanceof Error ? error.message : String(error)}). Setup goes on; the launcher page shows no setup status until ZLens starts again.`);
      }
    });
    return this.pending;
  }
}
