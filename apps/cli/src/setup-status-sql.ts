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
 */
import { sqlString } from './history/history-sql-log.js';

export interface SetupStatusRow {
  stage: string;
  line: string;
  percent: number | null;
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
  return [
    `MERGE INTO ${table} t`,
    `USING (SELECT 1 AS id, CURRENT_TIMESTAMP() AS updated_at, ${sqlString(row.stage, 40)} AS stage, ${sqlString(row.line, 500)} AS line, ${percent} AS percent) s`,
    'ON t.id = s.id',
    'WHEN MATCHED THEN UPDATE SET updated_at = s.updated_at, stage = s.stage, line = s.line, percent = s.percent',
    'WHEN NOT MATCHED THEN INSERT (id, updated_at, stage, line, percent) VALUES (s.id, s.updated_at, s.stage, s.line, s.percent)',
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
