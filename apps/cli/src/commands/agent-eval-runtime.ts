/**
 * Runtime driver for `zlens agent eval`.
 *
 * An in-process driver would skip the V2 router, `AgentRunEngine`,
 * `enforceOrdinaryAnalyticalPlanBoundary`
 * and `defaultAgentRunGates`. Every dead-end this harness exists to measure lives
 * in that skipped half — the router can block before the cascade runs, the engine
 * synthesizes its own modeling-gap block, and the gates declare refusal codes
 * terminal. Measuring the answer loop alone reports a cleaner picture than users
 * experience.
 *
 * This driver posts the same body the Ask panel posts and scores the persisted
 * `AgentRun`, so the suite exercises routing, gates, and the transport projection
 * as a real end-to-end contract.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AgentAnswer, AgentRun, AgentRunRoute, AgentRunStatus, AgentRunTrustState } from '@zlens/agent';

/** Eval-facing view of a run, shaped like the fields the scorer already reads. */
export interface RuntimeDrivenRun {
  kind: 'certified' | 'uncertified' | 'no_answer';
  route?: 'certified' | 'generated_sql' | 'research' | 'clarify' | 'blocked';
  runRoute: AgentRunRoute;
  status: AgentRunStatus;
  trustState: AgentRunTrustState;
  answer?: string;
  proposedSql?: string;
  rows?: unknown[];
  clarificationOptionCount: number;
  refusalCode?: string;
  runId: string;
  /**
   * A conversational reply (greeting, capability, polite redirect). It asserts
   * nothing about the data, so it is neither an answer nor a refusal — scoring it
   * as either misreads the correct outcome for an out-of-scope question.
   */
  conversational: boolean;
  /**
   * Did the meaning resolver actually run for this turn?
   *
   * With no provider configured it cannot, and `mayAssumeInterpretation` goes
   * false (AGT-017) — DQL deliberately refuses to settle `booked_revenue` vs
   * `billed_revenue` by lexical rank with semantic judgment switched off. Every
   * ambiguous question then clarifies. That is correct behaviour, but it makes a
   * clarification rate measured without a provider meaningless, so the harness
   * has to be able to say so.
  */
  meaningResolved: boolean;
  /**
   * Count captured by the persisted router retrieval receipt. This is not a
   * synthetic context-pack size: runtime runs do not return an AgentAnswer
   * context pack through the transport projection.
   */
  retrievalCandidateCount?: number;
  /** Source-lane coverage retained by the router-owned cascade receipt. */
  sourceCoverage?: NonNullable<AgentRun['diagnosticReceiptV3']>['sourceCoverage'];
  /** Typed terminal authority, distinct from a user-facing clarification. */
  terminalOutcome?: NonNullable<AgentRun['routeDecision']>['terminalOutcome'];
  /** Provider/tool count recorded by persisted runtime telemetry. */
  toolCallCount: number;
  /**
   * PHYSICAL provider round trips for the run.
   *
   * Tool calls are cheap and dispatches are not: on a subscription transport
   * one dispatch is a process spawn and tens of seconds of wall clock, and the
   * recorded big-repo failures were dispatch exhaustion, not tool exhaustion.
   * A quality gain bought with three extra round trips per question is a
   * regression for the person waiting, so it is measured and gateable.
   */
  providerDispatchCount: number;
  /**
   * OBS-008: compact receipt evidence only. Evaluation never opens the trace
   * store or treats a trace as answer authority.
   */
  observability?: {
    recordingStatus: NonNullable<AgentRun['traceReference']>['recordingStatus'];
    storeSchemaVersion: 1;
    traceFingerprint?: string;
  };
}

/**
 * Did this run decline to produce a usable answer?
 *
 * `needs_review` is deliberately NOT a refusal: a review-required generated
 * answer is the intended outcome when no governed plan froze, and counting it as
 * a refusal would make the false-refusal metric punish the very behaviour the
 * cascade is supposed to produce.
 */
export function runtimeRunRefused(run: Pick<AgentRun, 'route' | 'status'>): boolean {
  return run.route === 'blocked'
    || run.route === 'clarify'
    || run.status === 'blocked'
    || run.status === 'needs_clarification';
}

/** Map an engine route onto the vocabulary the eval cases already use. */
export function evalRouteForRun(route: AgentRunRoute): RuntimeDrivenRun['route'] {
  switch (route) {
    case 'certified_answer': return 'certified';
    case 'semantic_answer': return 'certified';
    case 'generated_answer': return 'generated_sql';
    case 'research': return 'research';
    case 'clarify': return 'clarify';
    // A typed terminal modeling/policy gap is not a clarification. Collapsing
    // it to `clarify` made eval reports claim the user had a choice when the
    // persisted run explicitly recorded a blocked no-answer.
    case 'blocked': return 'blocked';
    default: return undefined;
  }
}

/**
 * Collapse a run into the coarse `kind` the existing expectations assert.
 * Certification follows TRUST, not route: a certified route that degraded to a
 * review-required answer must not be scored as certified.
 */
export function evalKindForRun(run: Pick<AgentRun, 'route' | 'status' | 'trustState'>): RuntimeDrivenRun['kind'] {
  if (runtimeRunRefused(run)) return 'no_answer';
  if (run.trustState === 'certified') return 'certified';
  return 'uncertified';
}

function firstArtifactPayload(run: AgentRun, kinds: string[]): Record<string, unknown> | undefined {
  for (const artifact of run.artifacts ?? []) {
    if (!kinds.includes(String(artifact.kind))) continue;
    if (artifact.payload && typeof artifact.payload === 'object') {
      return artifact.payload as Record<string, unknown>;
    }
  }
  return undefined;
}

/** Pull SQL and result rows out of the run's artifacts, when it produced any. */
export function runtimeRunOutputs(run: AgentRun): { proposedSql?: string; rows?: unknown[] } {
  const payload = firstArtifactPayload(run, ['sql_cell', 'dql_block', 'generated_answer', 'answer', 'result']);
  const sql = typeof payload?.sql === 'string'
    ? payload.sql
    : typeof payload?.compiledSql === 'string' ? payload.compiledSql : undefined;
  const resultRecord = payload?.result && typeof payload.result === 'object'
    ? payload.result as Record<string, unknown>
    : undefined;
  const rows = Array.isArray(resultRecord?.rows)
    ? resultRecord.rows as unknown[]
    : Array.isArray(payload?.rows) ? payload.rows as unknown[] : undefined;
  return {
    ...(sql ? { proposedSql: sql } : {}),
    ...(rows ? { rows } : {}),
  };
}

export function projectRuntimeRun(run: AgentRun): RuntimeDrivenRun {
  const refusalEvaluation = (run.evaluations ?? []).find((evaluation) => !evaluation.passed);
  const sourceCoverage = run.diagnosticReceiptV3?.sourceCoverage
    ?? run.routeDecision?.analyticalCascadeDecision?.sourceCoverage;
  const retrievalCandidateCount = run.routeDecision?.retrievalEvidence?.candidateCount;
  return {
    kind: evalKindForRun(run),
    route: evalRouteForRun(run.route),
    runRoute: run.route,
    status: run.status,
    trustState: run.trustState,
    clarificationOptionCount: run.clarificationOptions?.length ?? 0,
    runId: run.id,
    conversational: run.route === 'conversation' || run.answerKind === 'conversational',
    meaningResolved: Boolean(run.routeDecision?.meaningResolution),
    toolCallCount: run.telemetry?.toolCalls ?? 0,
    providerDispatchCount: run.telemetry?.providerRoundTrips ?? 0,
    ...(typeof retrievalCandidateCount === 'number' ? { retrievalCandidateCount } : {}),
    ...(sourceCoverage ? { sourceCoverage } : {}),
    ...(run.routeDecision?.terminalOutcome ? { terminalOutcome: run.routeDecision.terminalOutcome } : {}),
    ...(run.traceReference ? {
      observability: {
        recordingStatus: run.traceReference.recordingStatus,
        storeSchemaVersion: run.traceReference.storeSchemaVersion,
        ...(run.traceReference.traceFingerprint ? { traceFingerprint: run.traceReference.traceFingerprint } : {}),
      },
    } : {}),
    ...(run.answer ? { answer: run.answer } : {}),
    ...(refusalEvaluation?.id ? { refusalCode: refusalEvaluation.id } : {}),
    ...runtimeRunOutputs(run),
  };
}

export interface RuntimeDriverOptions {
  runtimeBase: string;
  question: string;
  requestedMode?: 'ask' | 'auto' | 'research';
  threadId?: string;
  /** The scope selection (domain, purpose, model area, skills) the notebook would send; resolved server-side. */
  workspaceContext?: Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Post one question to a running `zlens notebook` and return the persisted run.
 *
 * Failures are surfaced rather than swallowed: a harness that silently scores a
 * transport error as a refusal would report a false-refusal spike that no code
 * change caused.
 */
/**
 * POST without the global fetch's five-minute cap. Node's fetch abandons any
 * response whose headers take longer than 300 s, so `--case-timeout-ms 900000`
 * was silently five minutes: a slow question on a large warehouse was scored
 * as "the runtime did not answer" while the runtime was still answering.
 * node:http waits until the case timeout's own abort.
 *
 * Each case opens its own connection (`agent: false`). Node keeps connections
 * alive by default and the runtime closes an idle one after five seconds, while
 * the eval spends a few seconds between cases reading the schema. A case posted
 * as that connection closed failed with ECONNRESET or "socket hang up": 8 of 27
 * GitLab questions, scored as the runtime not answering.
 */
const postWithoutFetchCap: typeof fetch = (input, init) => new Promise((resolve, reject) => {
  const url = new URL(String(input));
  const body = typeof init?.body === 'string' ? init.body : '';
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: init?.method ?? 'POST',
    agent: false,
    headers: { ...(init?.headers as Record<string, string> | undefined), 'Content-Length': String(Buffer.byteLength(body)) },
    ...(init?.signal ? { signal: init.signal } : {}),
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', () => resolve(new Response(Buffer.concat(chunks).toString('utf-8'), { status: response.statusCode ?? 500, headers: response.headers as Record<string, string> })));
  });
  request.on('error', reject);
  request.end(body);
});

export async function driveViaRuntime(options: RuntimeDriverOptions): Promise<AgentRun> {
  const base = options.runtimeBase.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? postWithoutFetchCap;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  try {
    const response = await fetchImpl(`${base}/api/agent-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: options.question,
        requestedMode: options.requestedMode ?? 'ask',
        // Scoring a suite must not write review drafts into the project.
        reviewDraftCapture: 'off',
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(options.workspaceContext && Object.keys(options.workspaceContext).length ? { workspaceContext: options.workspaceContext } : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Runtime returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
    }
    // The endpoint wraps the record (`{ run }`); older/streamed paths return it
    // bare. Accept both rather than guessing one and failing the whole suite.
    const body = await response.json() as { run?: AgentRun } | AgentRun;
    const run = (body as { run?: AgentRun }).run ?? body as AgentRun;
    if (!run || typeof run.id !== 'string') {
      throw new Error(`Runtime response was not an agent run: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return run;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Adapt a persisted run into the `AgentAnswer` shape the existing scorer reads,
 * so both drivers share one set of assertions.
 *
 * Fields the run genuinely does not carry are left UNDEFINED rather than
 * defaulted. An expectation that references one then fails loudly instead of
 * passing against a fabricated value — a harness that quietly invents
 * `sourceTier` would report agreement it never observed.
 */
export function answerFromRuntimeRun(run: AgentRun): AgentAnswer {
  const projected = projectRuntimeRun(run);
  const certification = projected.kind === 'no_answer'
    ? 'analyst_review_required'
    : run.trustState === 'certified'
      ? 'certified'
      : run.trustState === 'review_required'
        ? 'analyst_review_required'
        : 'ai_generated';
  return {
    kind: projected.kind,
    certification,
    reviewStatus: run.trustState === 'review_required' ? 'analyst_review_required' : 'none',
    text: run.answer ?? run.summary,
    citations: [],
    considered: [],
    ...(projected.proposedSql ? { proposedSql: projected.proposedSql } : {}),
    ...(projected.rows ? { result: { columns: [], rows: projected.rows, rowCount: projected.rows.length } } : {}),
    ...(projected.refusalCode ? { refusalCode: projected.refusalCode } : {}),
    // Carried so the scorer can tell an answerable clarification from a dead end.
    ...(run.clarificationOptions?.length ? { clarificationOptions: run.clarificationOptions } : {}),
    ...(projected.conversational ? { answerKind: 'conversational' } : {}),
  } as unknown as AgentAnswer;
}
