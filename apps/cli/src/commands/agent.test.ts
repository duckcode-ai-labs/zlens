import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAnalysisQuestionPlan,
  contextRetrievalBudgetForQuestion,
  type AgentAnswer,
  type AgentFollowUpContext,
  type AgentProvider,
  type AgentRun,
  type AskTraceObserverV1,
} from '@zlens/agent';
import { __test__, createDirectCliAskTraceProvider, evalResultRefused, runCanonicalCliAsk } from './agent.js';
import { answerFromRuntimeRun, projectRuntimeRun } from './agent-eval-runtime.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function answerResult(overrides: Partial<AgentAnswer> = {}): AgentAnswer {
  return {
    kind: 'uncertified',
    sourceTier: 'dbt_manifest',
    certification: 'ai_generated',
    reviewStatus: 'draft_ready',
    text: 'Answer',
    citations: [],
    considered: [],
    proposedSql: 'select 1 as orders',
    contextPack: {
      id: 'ctx_eval_1',
      objects: [],
      evidenceRoles: [],
      allowedSqlContext: {
        relations: [{ relation: 'dev.orders', columns: [{ name: 'orders' }] }],
        sourceBlockSql: [],
      },
      retrievalDiagnostics: {
        selectedRelations: [{ relation: 'dev.orders', score: 1, reason: 'test' }],
        selectedEvidence: [],
        selectedJoinPaths: [],
        schemaShapeCandidates: [],
      },
      missingContext: [],
      routeDecision: {
        route: 'generated_sql',
        intent: 'ad_hoc_ranking',
        reason: 'test',
        trustLabel: 'review_required',
        reviewStatus: 'draft_ready',
        selectedEvidence: [],
        missingContext: [],
        followUps: [],
      },
      freshness: {},
      warnings: [],
    } as unknown as AgentAnswer['contextPack'],
    result: {
      columns: [{ name: 'orders' }],
      rows: [{ orders: 1 }],
      rowCount: 1,
      executionTime: 12,
      sql: 'select 1 as orders',
    },
    evidence: {
      route: [{
        tool: 'inspect_metadata_context',
        status: 'checked',
        label: 'Runtime tables and columns attached',
      }],
      lineage: [],
      businessContext: [],
      selectedAssets: [],
      sourceTables: [],
      semanticObjects: [],
      toolCalls: [{
        name: 'inspect_metadata_context',
        status: 'checked',
        inputSummary: '{"question":"orders"}',
        outputSummary: '{"contextPackId":"ctx_eval_1"}',
        order: 1,
      }],
      citations: [],
    } as AgentAnswer['evidence'],
    ...overrides,
  };
}

function runtimeRun(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: 'runtime-eval-run',
    question: 'question',
    requestedMode: 'ask',
    route: 'generated_answer',
    status: 'needs_review',
    trustState: 'review_required',
    stopReason: 'human_review_required',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    steps: [],
    summary: 'Persisted runtime answer.',
    artifacts: [],
    evaluations: [],
    events: [],
    nextActions: [],
    repairAttempts: 0,
    ...overrides,
  } as AgentRun;
}

describe('direct CLI Ask trace bridge (OBS-001, OBS-007)', () => {
  it('submits a direct Ask once through the canonical runtime and prints its trace reference', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/api/connections')) {
        return new Response(JSON.stringify({ connections: [] }), { status: 200 });
      }
      if (url.endsWith('/api/ask-traces/cli-capability')) {
        return new Response(JSON.stringify({
          capability: 'runtime-issued-capability',
          expiresAt: '2026-08-22T00:00:30.000Z',
          scope: 'agent-runs',
        }), { status: 201 });
      }
      if (url.endsWith('/api/agent-runs')) {
        return new Response(JSON.stringify({
          run: {
            id: 'server-run-1', route: 'generated_answer', trustState: 'review_required',
            answer: 'Prepared a review-required answer.',
            traceReference: { traceId: '0123456789abcdef0123456789abcdef', recordingStatus: 'complete' },
          },
        }), { status: 201 });
      }
      return new Response('not found', { status: 404 });
    }));
    const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCanonicalCliAsk('show customer revenue', undefined, {
      runtimeUrl: 'http://127.0.0.1:4777',
      provider: 'ollama',
      format: 'json',
    } as any);

    expect(requests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:4777/api/connections',
      'http://127.0.0.1:4777/api/ask-traces/cli-capability',
      'http://127.0.0.1:4777/api/agent-runs',
    ]);
    const submitted = JSON.parse(String(requests[2]?.init?.body));
    expect(submitted).toMatchObject({
      question: 'show customer revenue',
      workspaceContext: { provider: 'ollama' },
    });
    expect(submitted.workspaceContext).not.toHaveProperty('surface');
    expect(new Headers(requests[2]?.init?.headers).get('x-dql-ask-trace-capability')).toBe('runtime-issued-capability');
    expect(JSON.parse(String(printed.mock.calls[0]?.[0]))).toMatchObject({
      runId: 'server-run-1',
      traceId: '0123456789abcdef0123456789abcdef',
      traceRecordingStatus: 'complete',
    });
  });

  it('records one physical attempt and waits for provider result settlement', async () => {
    const spans: Array<{
      id: string;
      name: string;
      finish?: { outcome?: string; reasonCode?: string; payload?: unknown };
    }> = [];
    const trace = {
      enabled: true,
      recordingStatus: 'recording',
      startSpan: (input: { name: string }) => {
        const id = `span-${spans.length + 1}`;
        spans.push({ id, name: input.name });
        return id;
      },
      finishSpan: (spanId: string | undefined, input?: { outcome?: string; reasonCode?: string; payload?: unknown }) => {
        const span = spans.find((candidate) => candidate.id === spanId);
        if (span) span.finish = input;
      },
      recordCandidateDecision: () => {},
      recordLink: () => {},
      finalize: () => undefined,
      markPartial: () => {},
      reference: () => undefined,
    } as unknown as AskTraceObserverV1;
    const provider: AgentProvider = {
      name: 'openai',
      available: async () => true,
      generate: async (_messages, options) => {
        const dispatch = {
          provider: 'openai' as const,
          operation: 'generate' as const,
          attemptIndex: 1,
          model: 'fixture-model',
          envelope: {},
        };
        options?.onProviderDispatch?.(dispatch);
        options?.onProviderDispatchComplete?.({
          ...dispatch,
          settlement: 'transport',
          outcome: 'ok',
        });
        // A result settlement is the terminal event. The transport milestone
        // must not create a second span or falsely close the first one.
        options?.onProviderDispatchComplete?.({
          ...dispatch,
          settlement: 'result',
          outcome: 'ok',
        });
        return 'fixture answer';
      },
    };

    await expect(createDirectCliAskTraceProvider(provider, trace).generate([{ role: 'user', content: 'hi' }])).resolves.toBe('fixture answer');

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: 'provider.attempt',
      finish: {
        outcome: 'ok',
        reasonCode: 'completed',
        payload: { kind: 'provider', attempt: { transportOutcome: 'ok' } },
      },
    });
  });
});

describe('agent eval answer harness', () => {
  it('reads an eval file from the project root, or from an absolute path as given', () => {
    expect(__test__.evalFilePath('/work/project', 'tests/evals.yml')).toBe('/work/project/tests/evals.yml');
    expect(__test__.evalFilePath('/work/project', '/bench/nba/evals.yml')).toBe('/bench/nba/evals.yml');
    expect(__test__.evalFilePath('/work/project', undefined)).toBe('/work/project/agent-evals.yml');
  });

  it('scores a benchmark question by its correct answer, ignoring column names', () => {
    const answered = answerResult({ result: { columns: ['policy', 'losses'], rows: [{ policy: 'P2', losses: 20 }, { policy: 'P1', losses: 10 }] } as AgentAnswer['result'] });
    const expected = { goldRows: [{ policy_number: 'P1', total_loss: 10 }, { policy_number: 'P2', total_loss: 20 }], goldSql: 'select ...' };

    const right = __test__.evaluateCase({ question: 'loss by policy', expected }, answered);
    expect(right.failures).toEqual([]);
    expect(right.executionMatched).toBe(true);
    expect(right.goldMatchReason).toBeUndefined();

    const wrong = __test__.evaluateCase(
      { question: 'loss by policy', expected: { goldRows: [{ policy_number: 'P1', total_loss: 10 }] } },
      answered,
    );
    expect(wrong.executionMatched).toBe(false);
    expect(wrong.goldMatchReason).toBe('returned 2 row(s); the correct answer has 1');
    expect(wrong.failures).toEqual(['answer does not match the correct answer: returned 2 row(s); the correct answer has 1']);
  });

  it('scores a refusal on a question with a correct answer as wrong, not as a match', () => {
    const refused = answerResult({ kind: 'no_answer', result: undefined });
    const evaluation = __test__.evaluateCase(
      { question: 'loss by policy', expected: { goldRows: [] } },
      refused,
    );
    // An empty correct answer is not matched by saying nothing.
    expect(evaluation.executionMatched).toBe(false);
    expect(evaluation.goldMatchReason).toBe('no data answer was returned');
    expect(evaluation.failures.some((failure) => failure.startsWith('FALSE REFUSAL'))).toBe(true);
  });

  it('records the trust label, answering path, proofs, SQL and row count of each answer', () => {
    const run = runtimeRun({
      trustState: 'governed',
      diagnosticReceiptV9: { executed: { tier: 'semantic', sqlFingerprint: 'f', rowCount: 2, ms: 5, proofs: ['certified_join:policy_claim'] } },
    } as Partial<AgentRun>);
    const answered = answerResult({
      sql: 'select policy, sum(loss) from claims group by 1',
      result: { columns: ['policy', 'loss'], rows: [{ policy: 'P1', loss: 1 }, { policy: 'P2', loss: 2 }] } as AgentAnswer['result'],
    });
    expect(__test__.answerEvidence(run, answered)).toEqual({
      trustState: 'governed',
      tier: 'semantic',
      proofs: ['certified_join:policy_claim'],
      sql: 'select policy, sum(loss) from claims group by 1',
      rowCount: 2,
    });
    expect(__test__.answerEvidence(runtimeRun({}), answerResult({ sql: undefined, proposedSql: undefined, result: undefined }))).toEqual({
      trustState: 'review_required',
    });
    const egressed = runtimeRun({
      providerEgressReceipts: [{ resultRowCount: 0 }, { resultRowCount: 3 }],
    } as unknown as Partial<AgentRun>);
    expect(__test__.answerEvidence(egressed, answerResult({ sql: undefined, proposedSql: undefined, result: undefined }))?.egress)
      .toEqual({ receipts: 2, resultRows: 3 });
  });

  it('records a question the runtime never answered as failed, not as a refusal', () => {
    const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const result = __test__.runtimeErrorResult(
      { name: 'slow', question: 'How many policies?', expected: { answerable: true, goldRows: [[2]] } },
      aborted,
      600_123,
      600_000,
    );
    expect(result).toMatchObject({
      name: 'slow',
      passed: false,
      runtimeError: 'no answer within 600s',
      executionMatched: false,
      failures: ['the runtime did not answer: no answer within 600s'],
    });
    expect(evalResultRefused(result)).toBe(false);
    const metrics = __test__.computeEvalMetrics([result]);
    expect(metrics.runtime_error_count).toBe(1);
    expect(metrics.false_refusal_count).toBe(0);
    expect(metrics.execution_match_rate).toBe(0);

    const other = __test__.runtimeErrorResult({ question: 'q' }, new Error('socket hang up'), 5, 120_000);
    expect(other.runtimeError).toBe('socket hang up');
    expect(other.executionMatched).toBeUndefined();
  });

  it('scores the persisted certified runtime route rather than an absent AgentAnswer context pack', () => {
    const persisted = runtimeRun({
      route: 'certified_answer',
      status: 'completed',
      trustState: 'certified',
      telemetry: {
        version: 1, stageDurationsMs: { total: 12 }, providerRoundTrips: 0,
        toolCalls: 0, sqlExecutions: 1, repairs: 0, egressReceipts: 0, fallbackReason: 'none',
      },
      routeDecision: {
        action: 'answer', confidence: 1, followsUp: false, reason: 'Exact certified block.',
        retrievalEvidence: { snapshotId: 'snapshot-certified', candidateCount: 1, candidateIds: ['dql:block:top_customers'] },
      },
    });

    const evaluation = __test__.evaluateCase(
      { question: 'who are the top customers', expected: { route: 'certified', kind: 'certified', certification: 'certified' } },
      answerFromRuntimeRun(persisted),
      projectRuntimeRun(persisted),
    );

    expect(evaluation.failures).toEqual([]);
  });

  it('uses persisted telemetry for generated route/report counts', () => {
    const persisted = runtimeRun({
      telemetry: {
        version: 1, stageDurationsMs: { total: 12 }, providerRoundTrips: 1,
        toolCalls: 2, sqlExecutions: 1, repairs: 0, egressReceipts: 1, fallbackReason: 'none',
      },
      routeDecision: {
        action: 'answer', confidence: 0.8, followsUp: false, reason: 'Qualified exploration.',
        retrievalEvidence: { snapshotId: 'snapshot-generated', candidateCount: 3, candidateIds: ['dbt:model:orders'] },
      },
    });
    const projection = projectRuntimeRun(persisted);
    const evaluation = __test__.evaluateCase(
      { question: 'show orders', expected: { route: 'generated_sql', kind: 'uncertified', minToolCalls: 2 } },
      answerFromRuntimeRun(persisted),
      projection,
    );
    const trace = __test__.buildEvalTrace({
      testCase: { question: 'show orders', expected: { minToolCalls: 2 } },
      result: answerFromRuntimeRun(persisted),
      evaluation,
      durationMs: 12,
      draftSaved: false,
      runtime: projection,
    });

    expect(evaluation.failures).toEqual([]);
    expect(projection).toMatchObject({ retrievalCandidateCount: 3, toolCallCount: 2 });
    expect(trace.find((stage) => stage.stage === 'tools')?.payload).toMatchObject({
      evidenceSource: 'persisted_agent_run.telemetry', observedToolCalls: 2,
    });
  });

  it('scores a persisted relationship gap as typed modeling-gap/no_answer, not a fake clarification', () => {
    const persisted = runtimeRun({
      route: 'blocked', status: 'blocked', trustState: 'blocked',
      routeDecision: {
        action: 'block', confidence: 1, followsUp: false, reason: 'No safe relationship closure.',
        terminalOutcome: {
          kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP',
          message: 'No certified fanout-safe relationship closure exists.',
          candidateIds: ['dbt:model:customers'],
          gap: {
            code: 'MISSING_RELATIONSHIP',
            missing: ['a certified, validated, fanout-safe relationship proof'],
            witnessCandidateIds: ['dbt:model:customers', 'dbt:model:order_items'],
          },
        },
      },
    });
    const projection = projectRuntimeRun(persisted);
    const evaluation = __test__.evaluateCase(
      {
        question: 'who are the top customers for perishable products',
        expected: { answerable: false, kind: 'no_answer', route: 'blocked', terminalOutcomeKind: 'modeling_gap', missingContextKind: 'relationship' },
      },
      answerFromRuntimeRun(persisted),
      projection,
    );

    expect(projection).toMatchObject({
      route: 'blocked',
      terminalOutcome: { kind: 'modeling_gap', gap: { code: 'MISSING_RELATIONSHIP' } },
      clarificationOptionCount: 0,
    });
    expect(evaluation.failures).toEqual([]);
  });

  it('does not score a generic metric/dimension modeling gap as a missing relationship', () => {
    const persisted = runtimeRun({
      route: 'blocked', status: 'blocked', trustState: 'blocked',
      routeDecision: {
        action: 'block', confidence: 1, followsUp: false, reason: 'Revenue is not modeled.',
        terminalOutcome: {
          kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP',
          message: 'The requested revenue measure is not modeled.', candidateIds: ['semantic:metric:orders.revenue'],
          gap: {
            code: 'MISSING_MEASURE',
            missing: ['revenue'],
            witnessCandidateIds: ['semantic:metric:orders.revenue'],
          },
        },
      },
    });
    const evaluation = __test__.evaluateCase(
      {
        question: 'show me revenue by customer',
        expected: { answerable: false, kind: 'no_answer', route: 'blocked', terminalOutcomeKind: 'modeling_gap', missingContextKind: 'relationship' },
      },
      answerFromRuntimeRun(persisted),
      projectRuntimeRun(persisted),
    );

    expect(evaluation.failures).toContain('missing context kind relationship was not reported');
  });

  it('scores expected rows as an execution match', () => {
    const evaluation = __test__.evaluateCase(
      {
        question: 'orders',
        expected: {
          rows: [{ orders: 1 }],
        },
      },
      answerResult(),
    );

    expect(evaluation.failures).toEqual([]);
    expect(evaluation.executionMatched).toBe(true);
  });

  it('enforces minimum observed tool calls for agentic eval cases', () => {
    const passing = __test__.evaluateCase(
      {
        question: 'orders',
        expected: {
          minToolCalls: 1,
        },
      },
      answerResult(),
    );
    const failing = __test__.evaluateCase(
      {
        question: 'orders',
        expected: {
          minToolCalls: 2,
        },
      },
      answerResult(),
    );

    expect(passing.failures).toEqual([]);
    expect(failing.failures).toEqual(['toolCalls expected at least 2, got 1']);
  });

  it('maps the CLI depth flag into an exploratory budget; effort no longer forces depth (S1)', () => {
    const plan = buildAnalysisQuestionPlan('show order count');

    expect(__test__.cliAnalysisDepth({ analysisDepth: 'deep' } as any)).toBe('deep');
    expect(__test__.cliAnalysisDepth({ analysisDepth: 'wide' } as any)).toBeUndefined();
    expect(__test__.cliReasoningEffort({ reasoningEffort: 'HIGH' } as any)).toBe('high');
    expect(__test__.cliReasoningEffort({ reasoningEffort: 'max' } as any)).toBeUndefined();

    // An explicit --analysis-depth deep still widens the retrieval budget.
    expect(contextRetrievalBudgetForQuestion({
      questionPlan: plan,
      requestedDepth: __test__.cliAnalysisDepth({ analysisDepth: 'deep' } as any),
    })).toMatchObject({
      analysisDepth: 'deep',
      strictness: 'exploratory',
      limit: 160,
    });

    // But --reasoning-effort high ALONE no longer widens it (the S1 decouple):
    // a simple lookup keeps the quick/balanced budget even at high effort.
    expect(contextRetrievalBudgetForQuestion({
      questionPlan: plan,
      reasoningEffort: __test__.cliReasoningEffort({ reasoningEffort: 'high' } as any),
    })).toMatchObject({
      analysisDepth: 'quick',
      strictness: 'balanced',
      limit: 100,
    });
  });

  it('includes execution-match rate in aggregate metrics', () => {
    const metrics = __test__.computeEvalMetrics([
      {
        name: 'match',
        passed: true,
        failures: [],
        durationMs: 20,
        executionMs: 12,
        executionMatched: true,
        kind: 'uncertified',
        route: 'generated_sql',
        contextObjects: 1,
        followUp: false,
        draftSaved: false,
        toolCalls: 1,
        expected: { minToolCalls: 1 },
        trace: [],
      },
      {
        name: 'miss',
        passed: false,
        failures: ['executed rows did not match expected rows'],
        durationMs: 20,
        executionMs: 10,
        executionMatched: false,
        kind: 'uncertified',
        route: 'generated_sql',
        contextObjects: 1,
        followUp: false,
        draftSaved: false,
        toolCalls: 0,
        expected: { minToolCalls: 1 },
        trace: [],
      },
    ]);

    expect(metrics.execution_match_rate).toBe(0.5);
    expect(metrics.tool_requirement_pass_rate).toBe(0.5);
    expect(metrics.tool_observed_case_count).toBe(1);
    expect(metrics.avg_tool_calls).toBe(0.5);
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: 0.5 })).toBe(true);
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: 0.75 })).toBe(false);
    expect(__test__.agentEvalThresholdsPass({ ...metrics, tool_requirement_pass_rate: null }, { minToolRequirement: 1 })).toBe(true);

    // Class-B wrong-number gate: execution_match_rate is 0.5 here, so a 0.5 bar
    // passes and a 1.0 bar fails — this is the gate that guards a speed lever from
    // shipping a fan-out/grain regression.
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, minExecutionMatch: 0.5 })).toBe(true);
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, minExecutionMatch: 1 })).toBe(false);
    // A rate gate with no applicable cases (judge_pass_rate is null here) is
    // vacuously satisfied — you never fail on a metric you did not measure.
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, minJudgePass: 1 })).toBe(true);
    // Trust-mislabel ceiling: 0 wrong-certified passes a ceiling of 0; 1 would fail it.
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, maxWrongCertified: 0 })).toBe(true);
    expect(__test__.agentEvalThresholdsPass({ ...metrics, wrong_certified_count: 1 }, { minToolRequirement: null, maxWrongCertified: 0 })).toBe(false);
  });

  it('derives grounded-narration metrics only from durable receipts, never rows or fallback prose', () => {
    const success = __test__.narrationOutcomeForEval({
      version: 1,
      mode: 'verified_facts',
      outcome: 'success',
      attempted: true,
      factCount: 3,
      maxRows: 10,
      validationFailures: [],
    });
    const fallback = __test__.narrationOutcomeForEval({
      version: 1,
      mode: 'verified_facts',
      outcome: 'deterministic_fallback',
      attempted: true,
      factCount: 3,
      maxRows: 10,
      validationFailures: ['UNPARSEABLE_CLAIMS'],
    });
    const errored = __test__.narrationOutcomeForEval({
      version: 1,
      mode: 'verified_facts',
      outcome: 'error',
      attempted: true,
      factCount: 3,
      maxRows: 10,
      validationFailures: [],
      errorCode: 'narration_error',
    });
    // A row-bearing skipped result must not silently enter the denominator.
    const skipped = __test__.narrationOutcomeForEval({
      version: 1,
      mode: 'skip',
      outcome: 'skipped',
      attempted: false,
      factCount: 0,
      maxRows: 0,
      validationFailures: [],
      skipReason: 'no_provider',
    });
    expect(success).toEqual({ narrationAttempted: true, narrationFallback: false });
    expect(fallback).toEqual({ narrationAttempted: true, narrationFallback: true });
    // A provider error is an attempted but ungrounded narration.  Counting it
    // as a success would mask a hot-path failure behind a healthy-looking rate.
    expect(errored).toEqual({ narrationAttempted: true, narrationFallback: true });
    expect(skipped).toEqual({});

    const base = {
      passed: true, failures: [] as string[], durationMs: 1, kind: 'uncertified' as const,
      contextObjects: 1, followUp: false, draftSaved: false, toolCalls: 0, trace: [] as never[],
    };
    const metrics = __test__.computeEvalMetrics([
      { ...base, name: 'success with arbitrary prose', ...success },
      { ...base, name: 'fallback without reader marker', ...fallback },
      { ...base, name: 'error without reader marker', ...errored },
      { ...base, name: 'skipped despite rows', ...skipped },
    ] as unknown as Parameters<typeof __test__.computeEvalMetrics>[0]);
    expect(metrics.grounded_narration_attempted).toBe(3);
    expect(metrics.grounded_narration_rate).toBeCloseTo(1 / 3);
  });

  it('builds structured trace stages for offline analysis', () => {
    const result = answerResult({
      draftBlock: {
        path: 'blocks/_drafts/orders.dql',
        askedTimes: 1,
        proposedContractId: 'sales.Order.orders',
      },
    });
    const evaluation = __test__.evaluateCase(
      {
        question: 'orders',
        expected: {
          rows: [{ orders: 1 }],
        },
      },
      result,
    );
    const trace = __test__.buildEvalTrace({
      testCase: {
        question: 'orders',
        expected: { rows: [{ orders: 1 }] },
      },
      result,
      evaluation,
      durationMs: 25,
      draftSaved: true,
    });

    expect(trace.map((stage) => stage.stage)).toEqual([
      'context',
      'rewrite',
      'lane',
      'tools',
      'answer',
      'validation',
      'execution',
      'draft',
      'observability',
      'scoring',
    ]);
    expect(trace.find((stage) => stage.stage === 'execution')).toMatchObject({
      status: 'passed',
      payload: {
        rowCount: 1,
        executionMatched: true,
        columns: ['orders'],
      },
    });
    expect(trace.find((stage) => stage.stage === 'tools')).toMatchObject({
      status: 'passed',
      payload: {
        observedToolCalls: 1,
        providerToolCalls: [
          expect.objectContaining({
            name: 'inspect_metadata_context',
            status: 'checked',
          }),
        ],
        routeEvidence: [
          expect.objectContaining({
            tool: 'inspect_metadata_context',
            status: 'checked',
          }),
        ],
      },
    });
    expect(trace.find((stage) => stage.stage === 'rewrite')).toMatchObject({
      status: 'not_run',
      message: 'No follow-up rewrite/context was supplied for this case.',
    });
    expect(trace.find((stage) => stage.stage === 'draft')).toMatchObject({
      status: 'passed',
      payload: { draftPath: 'blocks/_drafts/orders.dql' },
    });
  });

  it('captures follow-up rewrite context in the eval trace', () => {
    const followUp: AgentFollowUpContext = {
      kind: 'generic',
      sourceTurnId: 'turn_supply',
      sourceQuestion: 'give me product and supply info',
      sourceBlockName: 'product_supply_breakdown',
      filters: ['product_id in previous result'],
      dimensions: ['product_id', 'supply_id'],
      priorResultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
      priorResultValues: {
        product_id: ['BEV-001', 'JAF-001'],
      },
      priorResultRef: {
        id: 'turn_supply',
        question: 'give me product and supply info',
        columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
        rowCount: 65,
        sourceSql: 'SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10',
      },
      priorDqlArtifact: {
        kind: 'sql_block',
        name: 'product_supply_breakdown',
        source: 'block "product_supply_breakdown" {\n  type = "custom"\n  query = """SELECT product_id, supply_id, supply_name, supply_cost FROM analytics.product_supplies ORDER BY supply_cost DESC LIMIT 10"""\n}',
        orderBy: [{ name: 'supply_cost', direction: 'desc' }],
        limit: 10,
      },
      priorLimit: 10,
      priorMeasures: ['supply_cost'],
      resolvedReferences: ['previous results'],
    };
    const result = answerResult();
    const evaluation = __test__.evaluateCase(
      {
        question: 'include product details with previous results',
        followUp,
      },
      result,
    );
    const trace = __test__.buildEvalTrace({
      testCase: {
        question: 'include product details with previous results',
        followUp,
      },
      result,
      evaluation,
      durationMs: 25,
      draftSaved: false,
    });

    expect(trace.find((stage) => stage.stage === 'rewrite')).toMatchObject({
      status: 'passed',
      message: 'Follow-up context attached (generic).',
      payload: {
        kind: 'generic',
        sourceTurnId: 'turn_supply',
        sourceQuestion: 'give me product and supply info',
        sourceBlockName: 'product_supply_breakdown',
        priorResultColumns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
        priorResultRef: {
          id: 'turn_supply',
          rowCount: 65,
          columns: ['product_id', 'supply_id', 'supply_name', 'supply_cost'],
          sourceSql: expect.stringContaining('analytics.product_supplies'),
        },
        priorDqlArtifact: {
          kind: 'sql_block',
          name: 'product_supply_breakdown',
          source: expect.stringContaining('block "product_supply_breakdown"'),
          orderBy: [{ name: 'supply_cost', direction: 'desc' }],
          limit: 10,
        },
        priorLimit: 10,
        priorMeasures: ['supply_cost'],
        resolvedReferences: ['previous results'],
      },
    });
  });

  it('marks the tools trace stage failed when a required tool-call floor is missed', () => {
    const result = answerResult();
    const evaluation = __test__.evaluateCase(
      {
        question: 'orders',
        expected: { minToolCalls: 2 },
      },
      result,
    );
    const trace = __test__.buildEvalTrace({
      testCase: {
        question: 'orders',
        expected: { minToolCalls: 2 },
      },
      result,
      evaluation,
      durationMs: 25,
      draftSaved: false,
    });

    expect(trace.find((stage) => stage.stage === 'tools')).toMatchObject({
      status: 'failed',
      message: 'Observed 1 provider tool call(s), below the minimum of 2.',
      payload: {
        observedToolCalls: 1,
        expectedMinToolCalls: 2,
      },
    });
    expect(trace.find((stage) => stage.stage === 'scoring')).toMatchObject({
      status: 'failed',
      payload: {
        expected: { minToolCalls: 2 },
      },
    });
  });
  it('scores false refusals on answerable cases, and keeps genuine refusals honest', () => {
    const base = {
      failures: [] as string[], durationMs: 10, contextObjects: 1, followUp: false,
      draftSaved: false, toolCalls: 0, trace: [] as never[],
    };
    const metrics = __test__.computeEvalMetrics([
      // Answerable by inference (a real expectation, not a refusal expectation),
      // but the run refused → FALSE REFUSAL. This is the reported BCM shape.
      { ...base, name: 'bcm-ranking', passed: false, kind: 'no_answer', route: 'clarify',
        expected: { kind: 'certified' } },
      // Answerable and answered.
      { ...base, name: 'answered', passed: true, kind: 'uncertified', route: 'generated_sql',
        expected: { kind: 'uncertified' } },
      // Explicitly answerable, answered.
      { ...base, name: 'explicit-answerable', passed: true, kind: 'uncertified', route: 'generated_sql',
        expected: { answerable: true } },
      // Must refuse, and did → protects against "never dead-end" becoming hallucination.
      { ...base, name: 'weather', passed: true, kind: 'no_answer', route: 'clarify',
        expected: { kind: 'no_answer' } },
      // No expectations at all → excluded from both denominators.
      { ...base, name: 'unscored', passed: true, kind: 'uncertified', route: 'generated_sql' },
    ] as unknown as Parameters<typeof __test__.computeEvalMetrics>[0]);

    expect(metrics.answerable_case_count).toBe(3);
    expect(metrics.false_refusal_count).toBe(1);
    expect(metrics.false_refusal_rate).toBeCloseTo(1 / 3);
    expect(metrics.refusal_required_case_count).toBe(1);
    expect(metrics.refusal_recall).toBe(1);

    // Ceiling gates on the measured value.
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, maxFalseRefusal: 0.5 })).toBe(true);
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, maxFalseRefusal: 0.1 })).toBe(false);
    expect(__test__.agentEvalThresholdsPass(metrics, { minToolRequirement: null, minRefusalRecall: 1 })).toBe(true);
    // No answerable case scored means "unknown", never "perfect".
    expect(__test__.agentEvalThresholdsPass(
      { ...metrics, false_refusal_rate: null }, { minToolRequirement: null, maxFalseRefusal: 0 },
    )).toBe(true);
  });

  it('treats an explicit answerable:false as a genuine-refusal case even with other expectations', () => {
    const base = {
      failures: [] as string[], durationMs: 10, contextObjects: 1, followUp: false,
      draftSaved: false, toolCalls: 0, trace: [] as never[],
    };
    const metrics = __test__.computeEvalMetrics([
      { ...base, name: 'policy-blocked', passed: true, kind: 'no_answer', route: 'clarify',
        expected: { answerable: false, certification: 'analyst_review_required' } },
    ] as unknown as Parameters<typeof __test__.computeEvalMetrics>[0]);
    expect(metrics.answerable_case_count).toBe(0);
    expect(metrics.false_refusal_rate).toBeNull();
    expect(metrics.refusal_recall).toBe(1);
  });

  it('separates a dead end from an answerable clarification and a conversational decline', () => {
    // Three outcomes, learned from a live runtime run against the jaffle fixture:
    //   - no options            → dead end (the reported BCM loop)
    //   - options offered       → answerable next turn; a cost, not a defect
    //   - conversational reply  → asserts nothing about the data, so for an
    //                             out-of-scope question it is the CORRECT outcome
    // Collapsing any two of these misreports the product.
    const base = {
      failures: [] as string[], durationMs: 10, contextObjects: 1, followUp: false,
      draftSaved: false, toolCalls: 0, trace: [] as never[],
    };
    const metrics = __test__.computeEvalMetrics([
      { ...base, name: 'dead-end', passed: false, kind: 'no_answer', route: 'clarify',
        clarificationOptionCount: 0, expected: { answerable: true } },
      { ...base, name: 'asked-well', passed: true, kind: 'no_answer', route: 'clarify',
        clarificationOptionCount: 2, expected: { answerable: true } },
      { ...base, name: 'answered', passed: true, kind: 'uncertified', route: 'generated_sql',
        expected: { answerable: true } },
      { ...base, name: 'weather', passed: true, kind: 'uncertified', route: undefined,
        conversational: true, expected: { answerable: false } },
    ] as unknown as Parameters<typeof __test__.computeEvalMetrics>[0]);

    expect(metrics.answerable_case_count).toBe(3);
    expect(metrics.false_refusal_count).toBe(1);          // only the zero-option one
    expect(metrics.false_refusal_rate).toBeCloseTo(1 / 3);
    expect(metrics.clarification_rate).toBeCloseTo(1 / 3); // only the option-bearing one
    // A conversational decline counts as correctly refusing an out-of-scope ask.
    expect(metrics.refusal_recall).toBe(1);
  });

  it('counts a substantive conversational reply as an answer, not a dead end', () => {
    // A governed definition ("**top_customers** — Top 10 customers by lifetime
    // spend…") is exactly what a "what does X mean?" turn should return. The
    // first version of this scorer treated every conversational reply as a
    // decline and reported the feature working as the feature failing — caught
    // by a live run, not by a unit test.
    const base = {
      failures: [] as string[], durationMs: 10, contextObjects: 1, followUp: false,
      draftSaved: false, toolCalls: 0, trace: [] as never[],
    };
    const metrics = __test__.computeEvalMetrics([
      { ...base, name: 'definition', passed: true, kind: 'uncertified', route: undefined,
        conversational: true, conversationalAnswer: true, expected: { answerable: true } },
      { ...base, name: 'weather', passed: true, kind: 'uncertified', route: undefined,
        conversational: true, conversationalAnswer: true, expected: { answerable: false } },
      { ...base, name: 'dead-end', passed: false, kind: 'no_answer', route: 'clarify',
        clarificationOptionCount: 0, expected: { answerable: true } },
    ] as unknown as Parameters<typeof __test__.computeEvalMetrics>[0]);

    expect(metrics.answerable_case_count).toBe(2);
    // Only the true dead end counts against us; the definition does not.
    expect(metrics.false_refusal_count).toBe(1);
    // And an out-of-scope question answered conversationally still counts as
    // correctly declining.
    expect(metrics.refusal_recall).toBe(1);
  });

});
