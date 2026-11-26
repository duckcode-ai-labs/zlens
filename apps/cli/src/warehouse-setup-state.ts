/**
 * The two-stage setup of a warehouse project (onboarding design "pick your
 * data, fast first, details later", P3):
 *
 * 1. "read": names, types, comments and declared keys of the schemas the
 *    person chose. Metadata only, no table is scanned. When it is done the
 *    project is Ready: Ask answers from the catalog alone ("draft first").
 * 2. "check": the data checks behind the drafted models (keys, joins, rules)
 *    and the search index, in the background. When they land, the drafts
 *    wait for review and answers get better.
 *
 * Each stage runs as a background operation. What they did is kept in
 * `.dql/local/warehouse-setup.json`, so a restart, an idle stop or an upgrade
 * knows where setup stands.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SetupStageState = 'running' | 'done' | 'failed' | 'stopped';

export interface SetupReadStage {
  state: SetupStageState;
  operationId?: string;
  startedAt?: string;
  at?: string;
  /** Tables and views read. */
  relations?: number;
  /** Optional reads that failed (keys, comments, views), in plain words. */
  warnings?: string[];
  error?: string;
}

export interface SetupCheckStage {
  state: SetupStageState | 'off';
  operationId?: string;
  startedAt?: string;
  at?: string;
  /** The drafts waiting for review. */
  proposalId?: string;
  drafted?: number;
  search?: 'meaning' | 'words';
  searchNote?: string;
  error?: string;
  /** What could not be checked, by table (onboarding design P4). */
  problems?: Array<{ relations: string[]; kind: string; text: string }>;
  /** Tables checked on a block sample (over the row budget). */
  sampled?: number;
  /** Statements answered from an earlier run: what a resume did not ask again. */
  resumed?: number;
}

export interface WarehouseSetupStateV1 {
  version: 1;
  connectionId: string;
  scopes: Array<{ catalogOrDatabase: string; schemas: string[] }>;
  /** Run the data checks in the background once names are read (decision D3: on by default). */
  check: boolean;
  read: SetupReadStage;
  checks?: SetupCheckStage;
}

export function warehouseSetupStatePath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'warehouse-setup.json');
}

export function readWarehouseSetupState(projectRoot: string): WarehouseSetupStateV1 | null {
  const path = warehouseSetupStatePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as WarehouseSetupStateV1;
    return value?.version === 1 && value.read && Array.isArray(value.scopes) ? value : null;
  } catch {
    return null;
  }
}

export function writeWarehouseSetupState(projectRoot: string, state: WarehouseSetupStateV1): void {
  const path = warehouseSetupStatePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  renameSync(temporary, path);
}

/** A stage that was running when ZLens stopped did not finish: it says so. */
export function settleInterruptedStages(state: WarehouseSetupStateV1, running: (operationId: string | undefined) => boolean): WarehouseSetupStateV1 {
  const interrupted = 'ZLens stopped before this finished. Start it again to continue.';
  const read = state.read.state === 'running' && !running(state.read.operationId)
    ? { ...state.read, state: 'failed' as const, error: interrupted }
    : state.read;
  const checks = state.checks?.state === 'running' && !running(state.checks.operationId)
    ? { ...state.checks, state: 'failed' as const, error: interrupted }
    : state.checks;
  return read === state.read && checks === state.checks ? state : { ...state, read, ...(checks ? { checks } : {}) };
}

/**
 * Where setup stands, in one word:
 * - `choose`: nothing read yet, the person chooses what ZLens reads;
 * - `reading`: names are being read;
 * - `ready`: names are read, Ask works; the checks are off or not started;
 * - `checking`: ready, and the checks run in the background;
 * - `checked`: the checks are done, the drafts wait for review;
 * - `failed` / `stopped`: the read failed or was stopped (a failed or stopped
 *   check leaves setup `ready`, with the check's own state saying why).
 */
export type WarehouseSetupStage = 'choose' | 'reading' | 'ready' | 'checking' | 'checked' | 'failed' | 'stopped';

export function warehouseSetupStage(state: WarehouseSetupStateV1 | null): WarehouseSetupStage {
  if (!state) return 'choose';
  if (state.read.state === 'running') return 'reading';
  if (state.read.state === 'failed') return 'failed';
  if (state.read.state === 'stopped') return 'stopped';
  if (state.checks?.state === 'running') return 'checking';
  if (state.checks?.state === 'done') return 'checked';
  return 'ready';
}

/**
 * Setup in one line, with numbers where there are any: what the launcher page
 * shows before ZLens opens (onboarding design P5, `core.setup_status`).
 */
export function setupStatusLine(
  state: WarehouseSetupStateV1 | null,
  operation: { status: string; progress: number; message: string; type: string } | null,
): { stage: WarehouseSetupStage; line: string; percent: number | null } {
  const stage = warehouseSetupStage(state);
  const running = operation && (operation.status === 'running' || operation.status === 'queued') ? operation : null;
  switch (stage) {
    case 'choose':
      return { stage, line: 'Open ZLens and choose the data it reads.', percent: null };
    case 'reading': {
      // The operation's own words, without the database's name: the launcher's row names nothing of the person's.
      const words = running?.message && /^Reading (names|keys and comments)/.test(running.message) ? running.message : 'Reading names.';
      return { stage, line: words.replace(/ in [^:(]+?(?= ?[:(])/, ''), percent: running?.progress ?? null };
    }
    case 'failed':
      return { stage, line: `ZLens could not read the chosen schemas: ${state?.read.error ?? 'unknown error'}`, percent: null };
    case 'stopped':
      return { stage, line: 'Reading was stopped. Open ZLens to start it again.', percent: null };
    case 'checking': {
      // The check stage's share of its own work: 50–92 of the operation's 0–100 is the checks, then the index.
      const percent = running ? Math.max(0, Math.min(100, Math.round(((running.progress - 50) / 49) * 100))) : null;
      return { stage, line: `ZLens is ready to ask. Background checks: ${percent ?? 0}%.`, percent };
    }
    case 'checked': {
      const problems = state?.checks?.problems?.length ?? 0;
      return { stage, line: `ZLens is ready to ask. Background checks done: drafts wait for review${problems ? `; ${problems} ${problems === 1 ? 'table' : 'tables'} not checked` : ''}.`, percent: 100 };
    }
    default: {
      // Between the read and the checks it asked for, the checks are about to start, not off.
      if (state?.check && (state.checks?.state ?? 'off') === 'off') return { stage, line: 'ZLens is ready to ask. Background checks are starting.', percent: 0 };
      const why = state?.checks?.state === 'stopped' ? 'were stopped' : state?.checks?.state === 'failed' ? 'did not finish' : 'are off';
      return { stage, line: `ZLens is ready to ask. The background checks ${why}.`, percent: null };
    }
  }
}
