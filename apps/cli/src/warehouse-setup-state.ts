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
import { launcherAskReadiness, type LauncherAskReadiness, type SetupStatusRow } from './setup-status-sql.js';

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
  /**
   * "Check faster" (onboarding design P7): the size the checks ran on, whether the app's warehouse was resized
   * (and so must go back to X-Small), or why the resize was refused.
   */
  warehouse?: { size: string; resized: boolean; refused?: string };
  /**
   * What the drafts hold, in the words Guided Setup's "Draft my models" says (onboarding design D8): models
   * and joins drafted from so many tables, the Domain they go in, the staging copies left out.
   */
  summary?: {
    models: number;
    joins: number;
    relations: number;
    validated: boolean;
    sampled: number;
    /** Tables read but over the draft budget, left for Modeling to draft. */
    leftOut?: number;
    domain?: string;
    stagingHidden?: Array<{ relation: string; finalRelation: string }>;
    readNotes?: string[];
  };
}

export interface WarehouseSetupStateV1 {
  version: 1;
  connectionId: string;
  scopes: Array<{ catalogOrDatabase: string; schemas: string[] }>;
  /** Run the data checks in the background once names are read (decision D3: on by default). */
  check: boolean;
  /** "Check faster": the size of the app's own warehouse for the checks (decision D6); X-Small when absent. */
  checkSize?: string;
  /**
   * How the checks draft (Guided Setup's Rename and "Show staging tables", onboarding design D8): the Domain
   * the drafts go in, and staging copies drafted too. A check run again keeps them, and asks the warehouse
   * only what its earlier runs did not.
   */
  draft?: { domain?: string; includeStaging?: boolean };
  read: SetupReadStage;
  checks?: SetupCheckStage;
}

/** Words a driver uses when a statement ran into its time limit (Snowflake's own cancel, any driver's deadline). */
const TIME_LIMIT = /\bSQL execution canceled\b|exceeded the \d+ ?ms deadline|statement reached its statement or warehouse timeout|statement timed out/i;

/**
 * A setup error in plain words, for the Setup page, the strip, the banner and the launcher alike (they all read it
 * from here): a statement that ran into its time limit says so, never "SQL execution canceled" or "exceeded the
 * 60000ms deadline" (the Snowflake large test, 26 Nov 2026). Other errors keep their own words.
 */
export function plainSetupError(message: string): string {
  if (!TIME_LIMIT.test(message)) return message;
  const deadline = /exceeded the (\d+) ?ms deadline/i.exec(message);
  const seconds = deadline ? Math.round(Number(deadline[1]) / 1000) : undefined;
  return `a statement took longer than ${seconds ? `${seconds} seconds` : 'its time limit'}, so ZLens stopped it`;
}

/** Whether a check failure is a statement that ran into its time limit. */
export function isTimeLimitError(message: string): boolean {
  return TIME_LIMIT.test(message);
}

/** What the Setup page says of tables a background check skipped at its time limit, and that Ask still uses them. */
export function timeLimitProblemText(names: string, tables: number, seconds: number): string {
  const one = tables <= 1;
  return `${names}: not checked. A check took longer than the ${seconds}-second limit for background checks, so ZLens skipped it, and the drafts do not rely on it. Ask can still use ${one ? 'it' : 'them'}: ${one ? 'its' : 'their'} columns were read.`;
}

/**
 * A setup state saved by an earlier build says its errors the same plain way: a time-out kept as a failed check
 * ("a check failed: Snowflake query failed: SQL execution canceled") reads as one.
 */
function withPlainErrors(state: WarehouseSetupStateV1, statementSeconds = 60): WarehouseSetupStateV1 {
  const read = state.read.error && isTimeLimitError(state.read.error) ? { ...state.read, error: plainSetupError(state.read.error) } : state.read;
  let checks = state.checks;
  if (checks?.error && isTimeLimitError(checks.error)) checks = { ...checks, error: plainSetupError(checks.error) };
  if (checks?.problems?.some((problem) => problem.kind === 'failed' && isTimeLimitError(problem.text))) {
    checks = {
      ...checks,
      problems: checks.problems.map((problem) => {
        if (problem.kind !== 'failed' || !isTimeLimitError(problem.text)) return problem;
        const names = problem.text.split(': a check failed:')[0] ?? problem.text;
        return { ...problem, kind: 'too_big', text: timeLimitProblemText(names, problem.relations.length, statementSeconds) };
      }),
    };
  }
  return read === state.read && checks === state.checks ? state : { ...state, read, ...(checks ? { checks } : {}) };
}

export function warehouseSetupStatePath(projectRoot: string): string {
  return join(projectRoot, '.dql', 'local', 'warehouse-setup.json');
}

export function readWarehouseSetupState(projectRoot: string): WarehouseSetupStateV1 | null {
  const path = warehouseSetupStatePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as WarehouseSetupStateV1;
    return value?.version === 1 && value.read && Array.isArray(value.scopes) ? withPlainErrors(value) : null;
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
 * shows before ZLens opens (onboarding design P5, `core.setup_status`). With
 * Ask's readiness (fix plan risk 3), the row carries it for the launcher, and
 * a line that says "ZLens is ready to ask." says Ask's own headline instead
 * while Ask's Snowflake Cortex is not set up.
 */
export function setupStatusLine(
  state: WarehouseSetupStateV1 | null,
  operation: { status: string; progress: number; message: string; type: string } | null,
  askReadiness?: Parameters<typeof launcherAskReadiness>[0],
): SetupStatusRow & { stage: WarehouseSetupStage } {
  return withAskReadiness(setupStageLine(state, operation), launcherAskReadiness(askReadiness));
}

function withAskReadiness<T extends SetupStatusRow>(row: T, ask: LauncherAskReadiness | undefined): T {
  if (!ask) return row;
  const notReady = ask.state !== 'ready' && ask.headline;
  return { ...row, ...(notReady ? { line: row.line.replace('ZLens is ready to ask.', ask.headline!) } : {}), askReadiness: ask };
}

function setupStageLine(
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
