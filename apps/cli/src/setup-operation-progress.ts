/**
 * What a warehouse setup operation says while it runs (onboarding design
 * "pick your data, fast first, details later", P2). One status, always with
 * numbers: the phase, the counts so far, the time so far. It is reported as
 * the operation's phase, progress, message and `detail`, so the background
 * tasks panel, the operations stream and the setup status all show it.
 *
 * A heartbeat reports again every two seconds, so the time and counts on the
 * page never stand still for longer than that while a statement runs.
 */
import type { LocalOperationProgress } from './local-operation-coordinator.js';
import type { WarehouseReadProgress } from './warehouse-metadata.js';

export type SetupPhase = 'find' | 'names' | 'catalog' | 'check' | 'index';

export interface SetupDetail {
  [key: string]: unknown;
  kind: 'warehouse-setup';
  phase: SetupPhase;
  database?: string;
  schemas?: number;
  /** Tables the read found so far (names, then keys and comments). */
  tables: number;
  /** Tables the schema sizes said to expect, when known. */
  tablesExpected?: number;
  /** Statements of the current read: done of all. */
  statementsDone?: number;
  statements?: number;
  /** The background checks' counts (onboarding design P4). */
  checks?: {
    tablesChecked: number;
    tables: number;
    keys: { done: number; total: number };
    joins: { done: number; total: number };
    /** Tables over the row budget: checked on a block sample. */
    largeTables: number;
    /** Statements answered from an earlier run. */
    resumed: number;
  };
  startedAt: string;
  phaseStartedAt: string;
  elapsedMs: number;
}

/** Where each phase sits in the operation's 0–100 progress. */
const SPAN: Record<SetupPhase, [number, number]> = {
  find: [2, 5],
  names: [5, 30],
  catalog: [30, 50],
  check: [50, 92],
  index: [92, 99],
};

export class SetupOperationProgress {
  private detail: SetupDetail;
  private readonly started: number;
  private phaseStarted: number;

  constructor(
    private readonly report: (progress: Partial<LocalOperationProgress>) => void,
    initial: { database?: string; tablesExpected?: number } = {},
    private readonly now: () => number = Date.now,
  ) {
    this.started = now();
    this.phaseStarted = this.started;
    const at = new Date(this.started).toISOString();
    this.detail = {
      kind: 'warehouse-setup',
      phase: 'find',
      tables: 0,
      startedAt: at,
      phaseStartedAt: at,
      elapsedMs: 0,
      ...(initial.database ? { database: initial.database } : {}),
      ...(initial.tablesExpected !== undefined ? { tablesExpected: initial.tablesExpected } : {}),
    };
  }

  get current(): SetupDetail {
    return { ...this.detail, elapsedMs: this.now() - this.started };
  }

  /** Enter a phase: its statement counts start again. */
  phase(phase: SetupPhase, patch: Partial<Omit<SetupDetail, 'kind' | 'phase'>> = {}): void {
    this.phaseStarted = this.now();
    const { statementsDone: _done, statements: _all, ...rest } = this.detail;
    this.detail = { ...rest, ...patch, phase, phaseStartedAt: new Date(this.phaseStarted).toISOString() };
    this.emit();
  }

  update(patch: Partial<Omit<SetupDetail, 'kind' | 'phase'>>): void {
    this.detail = { ...this.detail, ...patch };
    this.emit();
  }

  /** A metadata read's progress (names or keys and comments). */
  read(progress: WarehouseReadProgress): void {
    this.update({
      statementsDone: progress.queriesDone,
      statements: progress.queries,
      // The keys-and-comments read finds the tables the names read found: the count never goes back.
      tables: Math.max(progress.tables, this.detail.tables),
      ...(progress.catalogOrDatabase ? { database: progress.catalogOrDatabase } : {}),
    });
  }

  /** Report again every `everyMs` while a statement runs; returns the stop. */
  heartbeat(everyMs = 2_000): () => void {
    const timer = setInterval(() => this.emit(), everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  emit(): void {
    const detail = this.current;
    this.report({
      phase: detail.phase,
      progress: setupPercent(detail),
      message: setupMessage(detail),
      detail,
    });
  }
}

export function setupPercent(detail: SetupDetail): number {
  const [from, to] = SPAN[detail.phase];
  const checks = detail.phase === 'check' ? detail.checks : undefined;
  const part = checks && checks.tables > 0
    ? Math.min(1, (checks.tablesChecked / checks.tables) * 0.6 + (checks.joins.total > 0 ? (checks.joins.done / checks.joins.total) * 0.4 : 0))
    : detail.statements && detail.statements > 0
      ? Math.min(1, (detail.statementsDone ?? 0) / detail.statements)
      : 0;
  return Math.round(from + (to - from) * part);
}

/** 42 s, 3 min 05 s, 1 h 02 min. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`;

/** The one line the status shows, with numbers and the time so far. */
export function setupMessage(detail: SetupDetail): string {
  const where = detail.database ? ` in ${detail.database}` : '';
  const time = formatDuration(detail.elapsedMs);
  // Sizes are what the catalog said before the read; a read that finds more says how many it found.
  const tables = detail.tablesExpected && detail.tables <= detail.tablesExpected
    ? `${detail.tables.toLocaleString('en-US')} of ${count(detail.tablesExpected, 'table', 'tables')}`
    : count(detail.tables, 'table', 'tables');
  const statements = detail.statements ? ` (statement ${Math.min(detail.statements, (detail.statementsDone ?? 0) + (detail.statementsDone === detail.statements ? 0 : 1))} of ${detail.statements})` : '';
  switch (detail.phase) {
    case 'find':
      return `Finding the schemas${where} · ${time}`;
    case 'names':
      return `Reading names${where}: ${tables} so far${statements} · ${time}`;
    case 'catalog':
      return `Reading keys and comments${where}${statements}: ${tables} · ${time}`;
    case 'check': {
      const checks = detail.checks;
      if (!checks || checks.tables === 0) return `Checking keys and joins on the data${where} · ${time}`;
      const parts = [`${checks.tablesChecked.toLocaleString('en-US')} of ${count(checks.tables, 'table', 'tables')}`];
      if (checks.joins.total > 0) parts.push(`${checks.joins.done.toLocaleString('en-US')} of ${count(checks.joins.total, 'join', 'joins')}`);
      if (checks.largeTables > 0) parts.push(`${checks.largeTables.toLocaleString('en-US')} on samples`);
      if (checks.resumed > 0) parts.push('resumed');
      return `Checking keys and joins${where}: ${parts.join(' · ')} · ${time}`;
    }
    case 'index':
      return `Building the search index · ${time}`;
  }
}
