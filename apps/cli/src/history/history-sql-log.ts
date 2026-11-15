import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * THE SQL LOG (V15 decision H8): a content-free copy of History's change list in the app's own table
 * `<app>.core.history_log`, which setup.sql shows as the view `app_public.history` to the app_admin role. It holds
 * when, who, which item, its kind, its version, the kind of change and whether it is a certification; never SQL,
 * row values or file content.
 *
 * Written in batches, only when the app's warehouse is already running (so it never starts one by itself) or at the
 * daily stop. Best effort: History works without it. If writing fails (the container's session may not be allowed
 * to write to the app's own schema; this is checked at the release test install), the log is skipped for the rest
 * of the run with one warning, and History is unaffected.
 */
export interface SqlLogRow {
  commit: string;
  changedAt: string;
  changedBy: string;
  item: string;
  kind: string;
  version: number;
  change: string;
  certified: boolean;
}

export type SqlLogQuery = (sql: string) => Promise<Array<Record<string, unknown>>>;

export interface HistorySqlLogOptions {
  /** The installed app's name (its database), from ZLENS_SNOWFLAKE_APP_NAME. */
  appName: string;
  /** The app's own warehouse, from the project connection. */
  warehouse: () => string | undefined;
  query: SqlLogQuery;
  /** Where the log remembers the last commit it wrote. */
  stateFile: string;
  now?: () => Date;
  warn?: (message: string) => void;
}

export type SqlLogState = 'off' | 'waiting' | 'written' | 'skipped' | 'nothing';

interface SavedState {
  lastCommit?: string;
  lastWrittenAt?: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const BATCH = 200;
/** The daily stop: at a stop, the log is written when the last write is this old. */
const DAILY_MS = 20 * 3_600_000;

export function sqlLogTable(appName: string): string | null {
  const name = appName.trim();
  if (!name) return null;
  const app = IDENTIFIER.test(name) ? name : /^[^"\u0000-\u001f]+$/.test(name) ? `"${name}"` : null;
  return app ? `${app}.CORE.HISTORY_LOG` : null;
}

/** A Snowflake string literal: quotes doubled, backslashes kept as backslashes, control characters dropped. */
export function sqlString(value: string, max = 1000): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
  return `'${clean.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export function mergeStatement(table: string, rows: SqlLogRow[]): string {
  const values = rows.map((row) => `(${[
    sqlString(row.commit, 64),
    sqlString(row.changedAt, 40),
    sqlString(row.changedBy, 255),
    sqlString(row.item, 1000),
    sqlString(row.kind, 40),
    String(Math.max(0, Math.floor(row.version))),
    sqlString(row.change, 40),
    row.certified ? 'TRUE' : 'FALSE',
  ].join(', ')})`).join(',\n  ');
  return [
    `MERGE INTO ${table} t`,
    'USING (SELECT column1 AS commit_id, TO_TIMESTAMP_TZ(column2) AS changed_at, column3 AS changed_by, column4 AS item,',
    '  column5 AS kind, column6 AS version, column7 AS change, column8 AS certified',
    `  FROM VALUES\n  ${values}) s`,
    'ON t.commit_id = s.commit_id AND t.item = s.item AND t.version = s.version',
    'WHEN NOT MATCHED THEN INSERT (commit_id, changed_at, changed_by, item, kind, version, change, certified)',
    '  VALUES (s.commit_id, s.changed_at, s.changed_by, s.item, s.kind, s.version, s.change, s.certified)',
  ].join('\n');
}

export class HistorySqlLog {
  private skipped = false;
  private lastError: string | undefined;
  private readonly table: string | null;

  constructor(private readonly options: HistorySqlLogOptions) {
    this.table = sqlLogTable(options.appName);
  }

  get tableName(): string | null {
    return this.table;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  readState(): SavedState {
    try {
      return existsSync(this.options.stateFile) ? JSON.parse(readFileSync(this.options.stateFile, 'utf-8')) as SavedState : {};
    } catch {
      return {};
    }
  }

  private writeState(state: SavedState): void {
    const temp = `${this.options.stateFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state), 'utf-8');
    renameSync(temp, this.options.stateFile);
  }

  status(): { state: SqlLogState; table: string | null; lastWrittenAt?: string; error?: string } {
    const saved = this.readState();
    return {
      state: !this.table ? 'off' : this.skipped ? 'skipped' : saved.lastWrittenAt ? 'written' : 'waiting',
      table: this.table,
      ...(saved.lastWrittenAt ? { lastWrittenAt: saved.lastWrittenAt } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /** Whether the app's warehouse is running now (SHOW runs without one). */
  private async warehouseRunning(): Promise<boolean> {
    const warehouse = this.options.warehouse()?.trim();
    if (!warehouse || !IDENTIFIER.test(warehouse.replace(/^"|"$/g, ''))) return false;
    try {
      const rows = await this.options.query(`SHOW WAREHOUSES LIKE ${sqlString(warehouse.replace(/^"|"$/g, ''), 255)}`);
      return rows.some((row) => /^(STARTED|RESIZING)$/i.test(String(row.state ?? row.STATE ?? '')));
    } catch {
      return false;
    }
  }

  /**
   * Writes `pending` (oldest first). Without `atStop`, only while the warehouse is already running; at a stop, also
   * when the last write is a day old.
   */
  async flush(pending: SqlLogRow[], options: { atStop?: boolean; force?: boolean } = {}): Promise<SqlLogState> {
    if (!this.table) return 'off';
    if (this.skipped) return 'skipped';
    if (!pending.length) return 'nothing';
    const saved = this.readState();
    const dayOld = !saved.lastWrittenAt || this.now().getTime() - Date.parse(saved.lastWrittenAt) >= DAILY_MS;
    if (!options.force && !(options.atStop && dayOld) && !(await this.warehouseRunning())) return 'waiting';
    try {
      for (let start = 0; start < pending.length; start += BATCH) {
        const batch = pending.slice(start, start + BATCH);
        await this.options.query(mergeStatement(this.table, batch));
        this.writeState({ lastCommit: batch.at(-1)!.commit, lastWrittenAt: this.now().toISOString() });
      }
      return 'written';
    } catch (error) {
      this.skipped = true;
      this.lastError = error instanceof Error ? error.message : String(error);
      (this.options.warn ?? console.warn)(
        `[zlens] History could not write its change log to ${this.table} (${this.lastError}). History keeps working inside the app; the SQL log is skipped until ZLens starts again.`,
      );
      return 'skipped';
    }
  }
}
