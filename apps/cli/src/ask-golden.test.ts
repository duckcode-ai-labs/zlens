import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { verifyAskNarration } from '@zlens/agent';
import { startLocalServer, type AskAgentRuntimeMode } from './local-runtime.js';
import { createSeededSqliteExecutor, type GoldenSeed, type SeededSqliteExecutor } from './testkit/seeded-sqlite-executor.js';
import { readEnv } from '@zlens/core';

/**
 * THE GOLDEN HARNESS — does the product return the RIGHT ROWS?
 *
 * The Ask battery proves a turn ends honestly. This proves a turn is correct:
 * every question carries hand-reviewed reference SQL, the reference runs
 * against the same seeded engine the server queries, and the answer's rows
 * must equal it. Tier and trust are asserted too, because a right number
 * with a wrong badge is still a wrong answer.
 *
 * Three lanes, one file:
 *   - questions: single turns over the jaffle-golden fixture (the real
 *     jaffle-shop-duckdb metadata, a 12-customer data subset).
 *   - conversation: the five verbatim turns of the Sept 3 2026 session,
 *     through real HTTP ingress, thread persistence, retrieval, compile and
 *     execute — nothing pre-resolved, nothing injected.
 *   - reference SQL: the seed and the references agree (no server).
 *
 * Provider: replayed cassettes by default (hermetic CI). `ZLENS_ASK_GOLDEN_LIVE=1`
 * uses the provider configured in `ZLENS_ASK_GOLDEN_PROVIDER_PROJECT`'s
 * `.dql/provider-settings.json`; add `ZLENS_ASK_GOLDEN_RECORD=1` to (re)record.
 * `ZLENS_ASK_GOLDEN_MODE` selects the server's Ask runtime mode.
 * `ZLENS_ASK_GOLDEN_REPEAT=n` replays each case n times and requires the same
 * outcome, tier and rows every time (the stability lane).
 *
 * Baseline honesty: the legacy runtime's baseline (17/34) is documented in
 * `baseline-report-authoritative_v2.json`, never asserted. The pipeline's
 * suite carries no known-failure exemptions: every case must pass. The one
 * exception is a lane that declares `gate: "floor"` in its `golden.json`
 * (the warehouse-only lane, `ask-golden-jaffle-warehouse.test.ts`): it
 * measures a gap still being closed, so it records every case and fails only
 * below the floor its committed baseline sets.
 */

type Outcome = 'rows' | 'clarify_or_rows' | 'gap' | 'conversation' | 'answered_with_caveat' | 'gap_or_caveat';
/**
 * `reviewable`: the rows must be right, and the answer may be certified, governed or review-required (AI-drafted SQL over the schema).
 * `review_required`: the rows must be right, and the answer must be labelled for review: a semantic compile through a join that is
 * not a certified relationship (every jaffle-golden relationship is a draft), never From Metrics.
 */
type Tier = 'certified' | 'governed' | 'any' | 'reviewable' | 'review_required' | 'none';
interface Reference { sql: string; columns: Record<string, string[]>; identity?: string[] }
interface GoldenCase extends Reference {
  id: string; question: string; outcome?: Outcome; tier: Tier;
  identity?: string[]; keys?: string[]; ordered?: boolean; requiredColumns?: string[];
  alternatives?: Reference[]; note?: string;
  keeps?: string[]; saysAll?: string[]; forbids?: { route?: string; block?: string; rowCountAbove?: number; booleanBreakdown?: boolean; sql?: boolean; says?: string[] };
}

const here = dirname(fileURLToPath(import.meta.url));
/**
 * `ZLENS_ASK_GOLDEN_FIXTURE` selects the fixture: `jaffle-golden` (default; its
 * cases live at test/ask-golden/*.json) or another fixture directory whose
 * cases live at test/ask-golden/<fixture>/*.json (e.g. `nba-golden`: a
 * Snowflake-shaped dbt project with no semantic layer, parameterized
 * certified blocks and non-unique player names).
 */
const FIXTURE = readEnv('ZLENS_ASK_GOLDEN_FIXTURE') ?? 'jaffle-golden';
const caseDirOf = (fixture: string) => fixture === 'jaffle-golden' ? resolve(here, '../test/ask-golden') : resolve(here, '../test/ask-golden', fixture);
const goldenDir = caseDirOf(FIXTURE);
const fixtureDir = resolve(here, '../test/fixtures', FIXTURE);
/**
 * A lane may borrow another lane's cases and seed through `golden.json` in its
 * case directory. `jaffle-warehouse-golden` asks jaffle-golden's questions over
 * jaffle-golden's seed, with no dbt manifest:
 *   - `questionsFrom` / `seedFrom`: the fixture whose cases and seed are used;
 *   - `tierPolicy`: the trust a case must carry here, by the tier it carries
 *     there (a database-only project has no dbt metrics, so `governed` becomes
 *     `reviewable`: right rows, any honest label);
 *   - `gate: 'floor'`: cases are recorded, not asserted one by one; the lane
 *     fails only when fewer pass than `floor.askGolden` in the committed
 *     `baseline` file. Ports that raise the score raise the floor with it.
 */
interface LaneConfig { questionsFrom?: string; seedFrom?: string; tierPolicy?: Partial<Record<Tier, Tier>>; gate?: 'every_case' | 'floor'; baseline?: string }
const laneConfigPath = join(goldenDir, 'golden.json');
const LANE = (existsSync(laneConfigPath) ? JSON.parse(readFileSync(laneConfigPath, 'utf8')) : {}) as LaneConfig;
const FLOOR_GATE = LANE.gate === 'floor';
const questionsDir = LANE.questionsFrom ? caseDirOf(LANE.questionsFrom) : goldenDir;
const withTierPolicy = (spec: GoldenCase): GoldenCase => {
  const tier = LANE.tierPolicy?.[spec.tier];
  return tier ? { ...spec, tier } : spec;
};
const questions = (JSON.parse(readFileSync(join(questionsDir, 'questions.json'), 'utf8')) as { questions: GoldenCase[] }).questions.map(withTierPolicy);
const conversation = (JSON.parse(readFileSync(join(questionsDir, 'conversation.json'), 'utf8')) as { turns: GoldenCase[] }).turns.map(withTierPolicy);
const seed = JSON.parse(readFileSync(join(resolve(here, '../test/fixtures', LANE.seedFrom ?? FIXTURE), 'seeds', 'seed.json'), 'utf8')) as GoldenSeed;

const LIVE = readEnv('ZLENS_ASK_GOLDEN_LIVE') === '1';
// The built product scales its run deadline for a subscription CLI (~35 s a
// dispatch on a larger vocabulary); under vitest that scale is off, so a live
// lane sets it explicitly. Replay is instant and keeps the strict deadline.
if (LIVE && !readEnv('ZLENS_AGENT_DEADLINE_SCALE')) process.env.ZLENS_AGENT_DEADLINE_SCALE = '4';
// The suite runs on the native semantic engine, as CI does (no MetricFlow
// there). A developer's own `mf` on PATH would otherwise change the engine,
// and every prompt that mentions it, between recording and replay.
if (!readEnv('ZLENS_METRICFLOW_BIN')) process.env.ZLENS_METRICFLOW_BIN = join(tmpdir(), 'dql-ask-golden-no-metricflow', 'mf');
const RECORD = readEnv('ZLENS_ASK_GOLDEN_RECORD') === '1';
const REPEAT = Math.max(1, Number(readEnv('ZLENS_ASK_GOLDEN_REPEAT') ?? '1') || 1);
/** `ZLENS_ASK_GOLDEN_KEEP=1` leaves the temporary project (and its run/trace stores) on disk for inspection. */
const KEEP = readEnv('ZLENS_ASK_GOLDEN_KEEP') === '1';
const MODE = readEnv('ZLENS_ASK_GOLDEN_MODE') as AskAgentRuntimeMode | undefined;
// The live lane reads provider settings from a project you name; there is no default path.
const PROVIDER_PROJECT = readEnv('ZLENS_ASK_GOLDEN_PROVIDER_PROJECT') ?? '';
if (LIVE && !PROVIDER_PROJECT) throw new Error('ZLENS_ASK_GOLDEN_LIVE=1 requires ZLENS_ASK_GOLDEN_PROVIDER_PROJECT (a project with .dql/provider-settings.json).');
/** Comma-separated question ids to run alone (debugging a failure); empty runs everything. */
const ONLY = new Set((readEnv('ZLENS_ASK_GOLDEN_ONLY') ?? '').split(',').map((id) => id.trim()).filter(Boolean));
const selected = <T extends { id: string }>(items: T[]): T[] => (ONLY.size ? items.filter((item) => ONLY.has(item.id)) : items);
const CASSETTES = join(fixtureDir, 'test-cassettes', 'golden');
const INFRASTRUCTURE = /\b(provider|dispatch(es)?|budget|orchestration|snapshot|closure|kernel|tool path|retry)\b/i;

// ── build identity ──────────────────────────────────────────────────────────
function buildIdentity(): Record<string, string> {
  const root = resolve(here, '../../..');
  const git = (command: string) => { try { return execSync(command, { cwd: root, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
  const sha = git('git rev-parse HEAD');
  const dirty = git('git status --porcelain -- apps/cli/src packages/dql-agent/src packages/dql-core/src');
  const diff = git('git diff -- apps/cli/src packages/dql-agent/src packages/dql-core/src');
  const content = createHash('sha256').update(sha).update(dirty).update(diff).digest('hex').slice(0, 16);
  return { commit: sha, dirty: dirty ? 'true' : 'false', contentFingerprint: content, mode: MODE ?? 'default', provider: LIVE ? 'live' : 'cassette-replay', fixture: FIXTURE };
}

// ── row comparison ──────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

function findColumn(actualColumns: string[], candidates: string[]): string | undefined {
  const wanted = candidates.map(norm);
  const exact = actualColumns.find((column) => wanted.includes(norm(column)));
  if (exact) return exact;
  // `order_id__customer` carries `customer`; `customer__customer_name` carries `customer_name`.
  const carried = actualColumns.find((column) => wanted.some((candidate) => norm(column).endsWith(candidate) && candidate.length >= 4));
  if (carried) return carried;
  // A period the question named may be spelled into the alias (`gross_profit_2025`,
  // `revenue_2025_q1`): the name is the same column; the values are still compared.
  // A period the AI spelled into its own column name (revenue_2025, lost_count_fy26) is not a different column.
  const unperiod = (column: string) => norm(column.toLowerCase().replace(/_(?:(19|20)\d{2}|fy(?:\d{4}|\d{2}))(_(q[1-4]|\d{2}))?$/, ''));
  const periodMatch = actualColumns.find((column) => wanted.includes(unperiod(column)));
  if (periodMatch) return periodMatch;
  // An aggregate spelled into the alias (`fg3m_total`, `orders_count`, `revenue_sum`) is the same column; the values are still compared.
  const unaggregated = (column: string) => norm(column.toLowerCase().replace(/_(total|sum|count|value|amount)$/, ''));
  return actualColumns.find((column) => wanted.includes(unaggregated(column)));
}

function sameValue(expected: unknown, actual: unknown): boolean {
  if (expected === null || expected === undefined) return actual === null || actual === undefined || actual === '';
  if (typeof expected === 'number') {
    const value = typeof actual === 'number' ? actual : Number(actual);
    if (!Number.isFinite(value)) return false;
    return Math.abs(value - expected) <= Math.max(0.011, Math.abs(expected) * 1e-6);
  }
  if (typeof expected === 'boolean') return actual === expected || actual === (expected ? 1 : 0) || String(actual).toLowerCase() === String(expected);
  const left = String(expected).trim().toLowerCase();
  const right = String(actual ?? '').trim().toLowerCase();
  if (left === right) return true;
  // Dates: compare the calendar day when both sides carry one.
  const day = /^\d{4}-\d{2}-\d{2}/;
  if (day.test(left) && day.test(right)) return left.slice(0, 10) === right.slice(0, 10);
  return false;
}

interface RowMatch { ok: boolean; reason?: string; mapped?: Record<string, string> }

function matchReference(reference: Reference, spec: GoldenCase, actualColumns: string[], actualRows: Row[]): RowMatch {
  const mapped: Record<string, string> = {};
  const identity = new Set(reference.identity ?? spec.identity ?? []);
  for (const [name, aliases] of Object.entries(reference.columns)) {
    const found = findColumn(actualColumns, [name, ...aliases]);
    if (found) mapped[name] = found;
    else if (!identity.has(name)) return { ok: false, reason: `column ${name} (aliases ${aliases.join(', ')}) not in result columns ${actualColumns.join(', ')}` };
  }
  if (identity.size > 0 && ![...identity].some((name) => mapped[name])) {
    return { ok: false, reason: `no identity column among ${[...identity].join(', ')} in ${actualColumns.join(', ')}` };
  }
  for (const required of spec.requiredColumns ?? []) {
    if (!mapped[required]) return { ok: false, reason: `required column ${required} missing from ${actualColumns.join(', ')}` };
  }
  const expectedRows = executor!.query(reference.sql);
  if (expectedRows.length !== actualRows.length) {
    return { ok: false, reason: `expected ${expectedRows.length} rows, got ${actualRows.length}`, mapped };
  }
  const compareRow = (expected: Row, actual: Row) => Object.entries(mapped).every(([name, column]) => sameValue(expected[name], actual[column]));
  if (spec.ordered) {
    for (let index = 0; index < expectedRows.length; index += 1) {
      if (!compareRow(expectedRows[index]!, actualRows[index]!)) {
        return { ok: false, reason: `row ${index} differs: expected ${JSON.stringify(expectedRows[index])}, got ${JSON.stringify(actualRows[index])}`, mapped };
      }
    }
    return { ok: true, mapped };
  }
  const remaining = [...actualRows];
  for (const expected of expectedRows) {
    const at = remaining.findIndex((actual) => compareRow(expected, actual));
    if (at < 0) return { ok: false, reason: `no row matches ${JSON.stringify(expected)}`, mapped };
    remaining.splice(at, 1);
  }
  return { ok: true, mapped };
}

function matchAny(spec: GoldenCase, actualColumns: string[], actualRows: Row[]): RowMatch {
  const references: Reference[] = [{ sql: spec.sql, columns: spec.columns }, ...(spec.alternatives ?? [])];
  let last: RowMatch = { ok: false, reason: 'no reference' };
  for (const reference of references) {
    last = matchReference(reference, spec, actualColumns, actualRows);
    if (last.ok) return last;
  }
  return last;
}

// ── the server ──────────────────────────────────────────────────────────────
let executor: SeededSqliteExecutor | undefined;
interface Harness { base: string; root: string; server?: Server }
let harness: Harness | undefined;
const report: Record<string, unknown>[] = [];

async function startGolden(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'dql-ask-golden-'));
  cpSync(fixtureDir, root, { recursive: true });
  rmSync(join(root, '.dql'), { recursive: true, force: true });
  rmSync(join(root, 'test-cassettes'), { recursive: true, force: true });
  // A database-only fixture commits the catalog `zlens sync warehouse` wrote:
  // it is project source there, not runtime state. Everything else under
  // .dql/ stays dropped.
  const catalog = join(fixtureDir, '.dql', 'warehouse-catalog.json');
  if (existsSync(catalog)) {
    mkdirSync(join(root, '.dql'), { recursive: true });
    cpSync(catalog, join(root, '.dql', 'warehouse-catalog.json'));
  }
  if (LIVE) {
    mkdirSync(join(root, '.dql'), { recursive: true });
    for (const file of ['provider-settings.json', 'oauth-credentials.json']) {
      const source = join(PROVIDER_PROJECT, '.dql', file);
      if (existsSync(source)) cpSync(source, join(root, '.dql', file));
    }
  }
  if (!readEnv('ZLENS_EVAL_CASSETTE_DIR')) {
    mkdirSync(CASSETTES, { recursive: true });
    process.env.ZLENS_EVAL_CASSETTE_DIR = CASSETTES;
    process.env.ZLENS_EVAL_CASSETTE_MODE = LIVE ? (RECORD ? 'record' : 'live') : 'replay';
  }
  executor = createSeededSqliteExecutor(seed);
  let server: Server | undefined;
  const port = await startLocalServer({
    rootDir: root,
    projectRoot: root,
    executor,
    connection: { driver: 'sqlite', filepath: ':memory:' },
    ...(MODE ? { askAgentRuntimeMode: MODE } : {}),
    preferredPort: 0,
    captureServer: (created) => { server = created; },
  });
  return { base: `http://127.0.0.1:${port}`, root, get server() { return server; } };
}

async function ask(question: string, threadId?: string) {
  const response = await fetch(`${harness!.base}/api/agent-runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // A scored harness never writes review drafts into its fixture project:
    // a draft from one question would change what the next question reads.
    body: JSON.stringify({ question, requestedMode: 'ask', reviewDraftCapture: 'off', ...(threadId ? { threadId } : {}) }),
  });
  const payload = await response.json() as { run: any; error?: unknown };
  return { status: response.status, run: payload.run, raw: payload };
}

async function createThread(): Promise<string> {
  const response = await fetch(`${harness!.base}/api/agent/threads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ surface: 'notebook', title: 'golden' }),
  });
  const payload = await response.json() as { thread: { id: string } };
  return payload.thread.id;
}

const answerArtifact = (run: any) => (run?.artifacts ?? []).find((artifact: any) => artifact?.kind === 'answer' && artifact?.payload?.result);
const resultOf = (run: any): { columns: string[]; rows: Row[] } | undefined => {
  const result = answerArtifact(run)?.payload?.result;
  if (!result || !Array.isArray(result.rows)) return undefined;
  const columns = Array.isArray(result.columns)
    ? result.columns.map((column: any) => typeof column === 'string' ? column : String(column?.name ?? ''))
    : Object.keys(result.rows[0] ?? {});
  return { columns, rows: result.rows as Row[] };
};
const executedSql = (run: any): string => (run?.artifacts ?? [])
  .map((artifact: any) => artifact?.payload?.sql ?? artifact?.payload?.result?.sql ?? artifact?.payload?.dqlArtifact?.source ?? '').join('\n');
const userText = (run: any): string => [run?.answer, run?.summary, run?.businessAnswer?.headline, run?.businessAnswer?.narrative]
  .filter((value) => typeof value === 'string').join('\n');
const trustOk = (tier: Tier, trust: string | undefined) => tier === 'none' ? true
  : tier === 'certified' ? trust === 'certified'
    : tier === 'review_required' ? trust === 'review_required'
      : tier === 'reviewable' ? ['certified', 'governed', 'review_required'].includes(trust ?? '')
        : ['certified', 'governed'].includes(trust ?? '');

interface Verdict { pass: boolean; reasons: string[]; observed: Record<string, unknown> }

/** The pipeline's own receipt, when the run carries one: what it read, what it prepared, what refused. */
function pipelineObserved(run: any): Record<string, unknown> {
  const payload = (run?.artifacts ?? []).map((artifact: any) => artifact?.payload).find((p: any) => p?.askPipeline);
  const receipt = payload?.askPipeline;
  if (!receipt) return {};
  const intent = receipt.intent;
  return {
    pipeline: {
      reading: intent?.reading,
      measures: intent?.measures?.map((m: any) => `${m.ref}${m.scope?.length ? ` where ${m.scope.map((p: any) => `${p.ref} ${p.op} ${p.values.join('/')}`).join(' and ')}` : ''}`),
      groupBy: intent?.groupBy?.map((g: any) => `${g.ref}:${g.role}${g.grain ? `/${g.grain}` : ''}`),
      display: intent?.display, filters: intent?.filters?.map((p: any) => `${p.ref} ${p.op} ${p.values.join('/')}`),
      ordering: intent?.ordering, limit: intent?.limit, unresolved: intent?.unresolved,
      candidates: receipt.candidates?.map((c: any) => `${c.tier}/${c.trust}: ${c.proof?.[0]}`),
      refusals: receipt.refusals?.map((r: any) => `${r.tier}/${r.code}: ${String(r.message).slice(0, 220)}`),
      dispatches: receipt.dispatches, executed: receipt.executed, timings: receipt.timings, reuse: receipt.reuse, failure: receipt.failure, tiers: receipt.tiers,
    },
  };
}

function judge(spec: GoldenCase, run: any, run0?: any): Verdict {
  const reasons: string[] = [];
  const result = resultOf(run);
  const outcome: Outcome = spec.outcome ?? 'rows';
  const observed: Record<string, unknown> = {
    route: run?.route, status: run?.status, trust: run?.trustState, stop: run?.stopReason, answerKind: run?.answerKind,
    columns: result?.columns, rowCount: result?.rows.length, text: userText(run).slice(0, 240),
    sql: executedSql(run).replace(/\s+/g, ' ').slice(0, 400),
    providerRoundTrips: run?.telemetry?.providerRoundTrips, block: run?.diagnosticReceiptV8?.observations?.find?.((o: any) => o.tool === 'run_certified')?.candidateIds?.[0],
    steps: (run?.steps ?? []).map((step: any) => `${step.route}:${step.status}:${step.attempt ?? ''}`),
    repairAttempts: run?.repairAttempts, escalationAttempts: run?.escalationAttempts,
    failedEvaluations: (run?.evaluations ?? []).filter((e: any) => e && e.passed === false).map((e: any) => `${e.id}:${String(e.message).slice(0, 160)}`),
    failure: run?.diagnosticReceiptV9?.failure ? `${run.diagnosticReceiptV9.failure.stage}/${run.diagnosticReceiptV9.failure.reason}: ${String(run.diagnosticReceiptV9.failure.message).slice(0, 160)}` : run?.diagnosticReceiptV9 ? undefined : `no pipeline receipt: ${String(run?.answer ?? '').slice(0, 120)}`,
    refusalCode: run?.answerRefusalCode ?? run?.artifacts?.find?.((artifact: any) => artifact?.payload?.refusalCode)?.payload?.refusalCode,
    runKeys: run?.diagnosticReceiptV9 ? undefined : Object.keys(run ?? {}).slice(0, 40),
    ...pipelineObserved(run),
  };
  if (INFRASTRUCTURE.test(userText(run))) reasons.push('user text describes the machinery');
  const isClarify = run?.status === 'needs_clarification' || run?.route === 'clarify';
  // An honest gap is a pipeline verdict (not modeled, no data, ambiguous,
  // policy), never a provider or warehouse failure wearing a blocked status.
  // The V9 receipt is dropped on the engine's provider-failure path (a known
  // gap, tracked for Slice C), so the V1 receipt and the route decision are
  // consulted too.
  // A run without a pipeline receipt never reported a verdict (the engine
  // drops the receipt on its provider-failure path; tracked for Slice C).
  const receipt = run?.diagnosticReceiptV9;
  const failure = receipt?.failure ?? (receipt ? undefined : { stage: 'engine', reason: 'no_receipt', message: run?.answer ?? run?.summary ?? 'no pipeline receipt on the run' });
  const refusalCode = run?.answerRefusalCode ?? run?.artifacts?.find?.((artifact: any) => artifact?.payload?.refusalCode)?.payload?.refusalCode;
  const honestGapCode = refusalCode === undefined || ['modeling_gap', 'no_data', 'ambiguous', 'policy_blocked', 'grounding_gap'].includes(String(refusalCode));
  const isGap = (run?.status === 'blocked' || (run?.route === 'generated_answer' && !result)) && !failure && honestGapCode;
  if (outcome === 'conversation') {
    if (run?.route !== 'conversation') reasons.push(`expected a conversational reply, got route ${run?.route}`);
    return { pass: reasons.length === 0, reasons, observed };
  }
  if (outcome === 'gap') {
    if (!isGap && !isClarify) reasons.push(`expected an honest gap, got ${run?.route}/${run?.status}${failure ? ` (failure: ${String(failure.message).slice(0, 120)})` : ''}${refusalCode ? ` [${refusalCode}]` : ''} with ${result?.rows.length ?? 0} rows`);
    if (spec.forbids?.sql && (run?.telemetry?.sqlExecutions ?? 0) > 0) reasons.push(`a gap must execute nothing; ${run.telemetry.sqlExecutions} SQL executed`);
    return { pass: reasons.length === 0, reasons, observed };
  }
  // An answer that must SAY something: the measured part is delivered and the
  // part this project does not compute is refused in the text.
  // Either reading is honest: nothing holds the asked-for field, so the turn
  // is a gap, or it answers with a stand-in and must SAY what stood in.
  if (outcome === 'gap_or_caveat') {
    if (isGap || isClarify) return { pass: reasons.length === 0, reasons, observed };
    for (const phrase of spec.saysAll ?? []) if (!userText(run).toLowerCase().includes(phrase.toLowerCase())) reasons.push(`the answer never says ${JSON.stringify(phrase)}`);
    return { pass: reasons.length === 0, reasons, observed };
  }
  if (outcome === 'answered_with_caveat') {
    if (isGap || isClarify) reasons.push(`expected an answer with a caveat, got ${run?.route}/${run?.status}${refusalCode ? ` [${refusalCode}]` : ''}`);
    for (const phrase of spec.saysAll ?? []) if (!userText(run).toLowerCase().includes(phrase.toLowerCase())) reasons.push(`the answer never says ${JSON.stringify(phrase)}`);
    for (const phrase of spec.forbids?.says ?? []) if (userText(run).toLowerCase().includes(phrase.toLowerCase())) reasons.push(`the answer says ${JSON.stringify(phrase)}`);
    return { pass: reasons.length === 0, reasons, observed };
  }
  if (outcome === 'clarify_or_rows' && isClarify) return { pass: reasons.length === 0, reasons, observed };
  if (!result) { reasons.push(`no result rows: ${run?.route}/${run?.status}/${run?.stopReason} — ${userText(run).slice(0, 200)}`); return { pass: false, reasons, observed }; }
  const match = matchAny(spec, result.columns, result.rows);
  if (!match.ok) reasons.push(`rows differ from reference: ${match.reason}`);
  if (!trustOk(spec.tier, run?.trustState)) reasons.push(`trust ${run?.trustState} does not satisfy ${spec.tier}`);
  if (spec.forbids?.route && run?.route === spec.forbids.route) reasons.push(`forbidden route ${spec.forbids.route}`);
  if (spec.forbids?.block && String(observed.block ?? '').includes(spec.forbids.block)) reasons.push(`forbidden block ${spec.forbids.block}`);
  if (spec.forbids?.rowCountAbove !== undefined && result.rows.length > spec.forbids.rowCountAbove) reasons.push(`row count ${result.rows.length} above ${spec.forbids.rowCountAbove}`);
  if (spec.forbids?.booleanBreakdown && result.columns.some((column) => /is_drink_item|is_food_item/i.test(column))) reasons.push('answered as a true/false breakdown');
  void run0;
  return { pass: reasons.length === 0, reasons, observed };
}

/**
 * `ZLENS_ASK_GOLDEN_BASELINE_OUT=<file>` records a full run's per-case results
 * in a baseline file: under the fixture's name for a cassette replay (what CI
 * runs), under `<fixture>:live` for a live run. A replay of a floor-gated lane
 * also sets `floor.askGolden` to its score.
 */
function writeBaseline(path: string, passed: number) {
  const baseline = (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}) as Record<string, any>;
  const build = buildIdentity();
  const key = LIVE ? `${FIXTURE}:live` : FIXTURE;
  baseline.askGolden = {
    ...(baseline.askGolden ?? {}),
    [key]: {
      commit: build.commit,
      dirty: build.dirty === 'true',
      provider: LIVE ? `live${RECORD ? ', recorded to cassettes' : ''}` : 'cassette replay',
      passed,
      total: report.length,
      cases: report.map((entry) => ({
        lane: entry.lane, id: entry.id, pass: entry.pass, route: entry.route ?? null, trust: entry.trust ?? null,
        ...(entry.pass ? {} : { reasons: (entry.reasons as string[] | undefined ?? []).map((reason) => reason.slice(0, 240)) }),
      })),
    },
  };
  if (FLOOR_GATE && !LIVE) baseline.floor = { ...(baseline.floor ?? {}), askGolden: passed };
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

/** A floor-gated lane scores a refused request as a failed case instead of stopping. */
function httpFailure(status: number, raw: unknown): Verdict {
  return { pass: false, reasons: [`HTTP ${status}: ${JSON.stringify(raw).slice(0, 300)}`], observed: { status: `http_${status}` } };
}

function record(lane: string, spec: GoldenCase, verdict: Verdict, extra: Record<string, unknown> = {}) {
  report.push({ lane, id: spec.id, question: spec.question, pass: verdict.pass, reasons: verdict.reasons, ...verdict.observed, ...extra });
}

function assertVerdict(spec: GoldenCase, verdict: Verdict) {
  // A floor-gated lane records every case and asserts the total at the end.
  if (FLOOR_GATE) return;
  // The pipeline's suite carries no known-failure exemptions. The legacy
  // runtime's baseline (17/34) is documented in
  // test/ask-golden/baseline-report-authoritative_v2.json, not asserted.
  const detail = JSON.stringify({ id: spec.id, question: spec.question, reasons: verdict.reasons, observed: verdict.observed }, null, 2);
  expect(verdict.pass, detail).toBe(true);
}

// ── lanes ───────────────────────────────────────────────────────────────────
describe('golden reference SQL agrees with the seed', () => {
  const local = createSeededSqliteExecutor(seed);
  it.each(questions.filter((q) => q.sql).map((q) => [q.id, q] as const))('%s reference runs and returns rows', (_id, spec) => {
    const rows = local.query(spec.sql);
    expect(rows.length, spec.sql).toBeGreaterThan(0);
    for (const alternative of spec.alternatives ?? []) expect(local.query(alternative.sql).length).toBeGreaterThan(0);
  });
  it.skipIf(FIXTURE !== 'jaffle-golden')('the seed holds Ryan Byrd, the twelve golden customers, and two customers named Jordan Lee', () => {
    expect(local.query(`SELECT customer_name FROM dev.customers WHERE lower(customer_name) = 'ryan byrd'`)).toHaveLength(1);
    expect(local.query(`SELECT customer_id FROM dev.customers WHERE lower(customer_name) = 'jordan lee'`)).toHaveLength(2);
    expect(local.query('SELECT customer_id FROM dev.customers')).toHaveLength(14);
  });
});

describe('golden harness', () => {
  beforeAll(async () => { harness = await startGolden(); }, 180_000);
  afterAll(async () => {
    await new Promise<void>((done) => harness?.server ? harness.server.close(() => done()) : done());
    if (harness && !KEEP) rmSync(harness.root, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    if (harness && KEEP) console.log(`[ask-golden] kept project root ${harness.root}`);
    const out = join(tmpdir(), 'dql-ask-golden');
    mkdirSync(out, { recursive: true });
    const file = join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}-${FIXTURE}-${MODE ?? 'default'}.json`);
    const passed = report.filter((entry) => entry.pass).length;
    writeFileSync(file, JSON.stringify({ build: buildIdentity(), passed, total: report.length, cases: report }, null, 2));
    // eslint-disable-next-line no-console
    console.log(`\n[ask-golden] ${passed}/${report.length} passed · report ${file}`);
    const baselineOut = readEnv('ZLENS_ASK_GOLDEN_BASELINE_OUT');
    if (baselineOut && ONLY.size === 0 && REPEAT === 1) writeBaseline(baselineOut, passed);
  });

  describe.skipIf(selected(questions).length === 0)('questions', () => {
    it.each(selected(questions).map((q) => [q.id, q] as const))('%s returns the reference rows with the right trust', async (_id, spec) => {
      const verdicts: Verdict[] = [];
      for (let attempt = 0; attempt < REPEAT; attempt += 1) {
        const { status, run, raw } = await ask(spec.question);
        if (!FLOOR_GATE) expect(status, JSON.stringify(raw).slice(0, 400)).toBe(201);
        verdicts.push(status === 201 ? judge(spec, run) : httpFailure(status, raw));
      }
      const verdict = verdicts[0]!;
      record('questions', spec, verdict, {
        repeats: REPEAT,
        stable: verdicts.every((v) => v.pass === verdict.pass && v.observed.trust === verdict.observed.trust),
        ...(REPEAT > 1 ? { repeatObserved: verdicts.map((v) => ({ pass: v.pass, reasons: v.reasons, route: v.observed.route, status: v.observed.status, trust: v.observed.trust, rowCount: v.observed.rowCount, text: String(v.observed.text ?? '').slice(0, 300), pipeline: v.observed.pipeline })) } : {}),
      });
      if (REPEAT > 1) {
        expect(verdicts.map((v) => `${v.pass}:${v.observed.trust}:${v.observed.rowCount}`), 'unstable across repeats').toEqual(Array(REPEAT).fill(`${verdict.pass}:${verdict.observed.trust}:${verdict.observed.rowCount}`));
      }
      assertVerdict(spec, verdict);
    }, 240_000);
  });

  // Research on the pipeline: the question is read once, the change is measured
  // and broken down by governed dimensions, and every figure the report states
  // is checked here against SQL on the same seed the server queried.
  const RESEARCH_CASE = 'investigation-revenue-drop';
  const RESEARCH_QUESTION = 'why did revenue change in August 2025?';
  describe.skipIf(FIXTURE !== 'jaffle-golden' || (ONLY.size > 0 && !ONLY.has(RESEARCH_CASE)))('research', () => {
    it(`${RESEARCH_CASE} measures the change and breaks it down on governed queries`, async () => {
      const response = await fetch(`${harness!.base}/api/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: RESEARCH_QUESTION, requestedMode: 'research' }),
      });
      const payload = await response.json() as { run: any; error?: unknown };
      expect(response.status, JSON.stringify(payload).slice(0, 400)).toBe(201);
      const run = payload.run;
      const report = (run.artifacts ?? []).find((artifact: any) => artifact?.kind === 'research_run')?.payload?.investigation;
      const ledger = run.diagnosticReceiptV9?.investigation;
      const detail = JSON.stringify({ status: run.status, trust: run.trustState, stop: run.stopReason, answer: run.answer, programs: ledger?.programs?.map((program: any) => [program.kind, program.dimension, program.outcome, program.verdict]), budget: ledger?.budget }, null, 0).slice(0, 2_000);

      // The oracle: revenue in each period, from the seed the server queried.
      const period = (from: string, to: string) => Number(executor!.query(
        `SELECT SUM(CASE WHEN ordered_at >= '${from}' AND ordered_at < '${to}' THEN product_price ELSE 0 END) AS revenue FROM dev.order_items`,
      )[0]!.revenue);
      const august = period('2025-08-01', '2025-09-01');
      const july = period('2025-07-01', '2025-08-01');
      const breakdowns = (ledger?.programs ?? []).filter((program: any) => program.kind === 'contribution');
      const governed = (report?.queries ?? []).filter((query: any) => query.outcome === 'answered').every((query: any) => ['certified', 'semantic', 'relational'].includes(query.tier));
      const narration = report ? verifyAskNarration({ text: report.text, factSet: report.facts }) : { ok: false, failures: ['no report'], unverified: [] };
      const reasons: string[] = [];
      if (!report) reasons.push('the run carries no investigation report');
      if (report && Math.abs(Number(report.headline?.current?.value) - august) > 0.011) reasons.push(`August ${report.headline?.current?.value} is not ${august}`);
      if (report && Math.abs(Number(report.headline?.prior?.value) - july) > 0.011) reasons.push(`July ${report.headline?.prior?.value} is not ${july}`);
      if (breakdowns.length === 0) reasons.push('the change was not broken down by any dimension');
      if (!governed) reasons.push('a breakdown answered outside the governed tiers');
      if (!narration.ok) reasons.push(`the report text is not verified: ${narration.failures.join(', ')}`);
      if (run.trustState !== 'review_required') reasons.push(`trust ${run.trustState} is not review_required`);

      record('research', { id: RESEARCH_CASE, question: RESEARCH_QUESTION } as GoldenCase, {
        pass: reasons.length === 0,
        reasons,
        observed: {
          route: run.route, status: run.status, trust: run.trustState, text: run.answer ?? run.summary,
          headline: report?.headline?.text, drivers: (report?.drivers ?? []).map((driver: any) => `${driver.path.map((step: any) => `${step.dimension.label}: ${step.member.label}`).join(' › ')} ${driver.share} ${driver.verdict}`),
          budget: ledger?.budget,
        } as any,
      } as Verdict);
      expect(reasons, detail).toEqual([]);
    }, 300_000);
  });

  describe.skipIf(selected(conversation).length === 0)('the five-turn conversation', () => {
    let threadId: string;
    let previous: any;
    beforeAll(async () => { threadId = await createThread(); });
    it.each(selected(conversation).map((turn) => [turn.id, turn] as const))('%s', async (_id, spec) => {
      const { status, run, raw } = await ask(spec.question, threadId);
      if (!FLOOR_GATE) expect(status, JSON.stringify(raw).slice(0, 400)).toBe(201);
      const verdict = status === 201 ? judge(spec, run, previous) : httpFailure(status, raw);
      previous = run;
      record('conversation', spec, verdict, { threadId, keeps: spec.keeps });
      assertVerdict(spec, verdict);
    }, 240_000);
  });

  // The floor: runs last, after every case above has been recorded.
  describe.skipIf(!FLOOR_GATE || ONLY.size > 0 || REPEAT > 1)('floor', () => {
    it('passes at least as many cases as the committed baseline', () => {
      const baselinePath = join(goldenDir, LANE.baseline ?? 'baseline.json');
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
        floor: { askGolden: number };
        askGolden: Record<string, { cases: Array<{ lane: string; id: string; pass: boolean }> }>;
      };
      const floor = baseline.floor.askGolden;
      const passed = report.filter((entry) => entry.pass).length;
      const before = new Set((baseline.askGolden[FIXTURE]?.cases ?? []).filter((item) => item.pass).map((item) => `${item.lane}:${item.id}`));
      const now = new Set(report.filter((entry) => entry.pass).map((entry) => `${entry.lane}:${entry.id}`));
      const lost = [...before].filter((key) => !now.has(key));
      const gained = [...now].filter((key) => !before.has(key));
      const line = `${FIXTURE}: ${passed}/${report.length} passed (floor ${floor})`
        + (gained.length ? ` · newly passing: ${gained.join(', ')}` : '')
        + (lost.length ? ` · no longer passing: ${lost.join(', ')}` : '');
      // eslint-disable-next-line no-console
      console.log(`\n[ask-golden] ${line}`);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        try { writeFileSync(summary, `### Ask golden, warehouse-only lane\n\n${line}\n\n`, { flag: 'a' }); } catch { /* summary is best effort */ }
      }
      expect(passed, `${line}. Raise the floor in ${baselinePath} when a change lifts the score; a drop below it is a regression.`).toBeGreaterThanOrEqual(floor);
    });
  });
});
