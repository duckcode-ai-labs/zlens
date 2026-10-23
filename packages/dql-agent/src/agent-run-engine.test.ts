import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deadlineScale,
  AgentRunEngine,
  FileAgentRunStore,
  InMemoryAgentRunStore,
  defaultAgentRunStorePath,
  resolveClarificationContinuation,
  selectRoute,
  routeReasoningEffort,
  compareResolvedPlanShadow,
  agentRouteDeadlineMs,
  agentRequestDeadlineMs,
  createAgentRunBudget,
  createAgentRunCancellationError,
  type AgentRouteExecutorResult,
  type AgentRunEvent,
  type AgentRunProgressV1,
  type AgentRunPlanner,
  type AgentRunRoute,
  type AgentRunStore,
} from "./agent-run-engine.js";
import { defaultAgentRunGates } from "./agent-run-gates.js";
import { decideAgentAction, type IntentDecision } from "./intent-controller.js";
import type { AgentEvidenceCandidate } from './meaning-resolution.js';
import type { AskTraceObserverV1 } from './ask-observability/index.js';

/** Router-owned proof used by engine-boundary tests; do not synthesize routes from IDs. */
function safeExploratoryCascade() {
  return {
    version: 1 as const,
    requirements: {
      version: 1 as const,
      measures: ['revenue'],
      dimensions: ['customer'],
      entityTerms: ['customer'],
      entityDisplayTerms: ['customer name'],
      memberTerms: ['Brittany Barrera'],
    },
    sourceCoverage: [
      { version: 1 as const, source: 'semantic' as const, status: 'available' as const, candidateIds: ['semantic:metric:revenue'] },
      { version: 1 as const, source: 'exploratory' as const, status: 'available' as const, candidateIds: ['dbt:model:orders', 'runtime:column:revenue', 'runtime:column:customer_name'] },
    ],
    attempts: [
      { version: 1 as const, tier: 'certified' as const, outcome: 'unavailable' as const, candidateIds: [], reason: 'No certified complete tuple.', planFrozen: false },
      { version: 1 as const, tier: 'semantic' as const, outcome: 'ineligible' as const, candidateIds: ['semantic:metric:revenue'], reason: 'Semantic tuple is incomplete.', planFrozen: false },
      { version: 1 as const, tier: 'governed_relational' as const, outcome: 'unavailable' as const, candidateIds: [], reason: 'No certified relationship path.', planFrozen: false },
      { version: 1 as const, tier: 'exploratory_sql' as const, outcome: 'executable' as const, candidateIds: ['dbt:model:orders', 'runtime:column:revenue', 'runtime:column:customer_name'], reason: 'One same-snapshot qualified physical relation covers the requested fields.', planFrozen: false },
    ],
    selectedTier: 'exploratory_sql' as const,
    planFrozen: false,
    stopReason: 'selected' as const,
  };
}

/** A router-owned, already-frozen exploration plan for host authorization tests. */
function frozenExploratoryDecision(): IntentDecision {
  const cascade = safeExploratoryCascade();
  const candidateIds = ['dbt:model:orders', 'runtime:column:revenue', 'runtime:column:customer_name'];
  return {
    action: 'answer',
    confidence: 1,
    followsUp: false,
    source: 'heuristic',
    reason: 'The router froze one review-required exploratory closure.',
    retrievalEvidence: { snapshotId: 'snapshot-frozen-exploration', candidateCount: candidateIds.length, candidateIds },
    analyticalCascadeDecision: {
      ...cascade,
      planFrozen: true,
      attempts: cascade.attempts.map((attempt) => attempt.tier === 'exploratory_sql'
        ? { ...attempt, planFrozen: true }
        : attempt),
    },
    resolvedAnalyticalPlan: {
      mode: 'authoritative',
      capability: 'bounded_exploration',
      planId: 'rap:frozen-exploration',
      fingerprint: 'sha256:frozen-exploration',
      snapshotId: 'snapshot-frozen-exploration',
    } as IntentDecision['resolvedAnalyticalPlan'],
  };
}

/** A router-owned frozen semantic decision for trace-boundary tests. */
function frozenSemanticDecision(): IntentDecision {
  const metricId = 'semantic:metric:revenue';
  return {
    action: 'answer',
    confidence: 1,
    followsUp: false,
    source: 'heuristic',
    reason: 'The router froze one compiler-compatible semantic tuple.',
    retrievalEvidence: {
      snapshotId: 'snapshot-frozen-semantic',
      candidateCount: 1,
      candidateIds: [metricId],
    },
    analyticalCascadeDecision: {
      version: 1,
      requirements: {
        version: 1,
        measures: ['revenue'],
        dimensions: [],
        entityTerms: [],
        entityDisplayTerms: [],
        memberTerms: [],
      },
      sourceCoverage: [{
        version: 1,
        source: 'semantic',
        status: 'available',
        candidateIds: [metricId],
      }],
      attempts: [
        {
          version: 1,
          tier: 'certified',
          outcome: 'unavailable',
          candidateIds: [],
          reason: 'No certified complete tuple.',
          planFrozen: false,
        },
        {
          version: 1,
          tier: 'semantic',
          outcome: 'executable',
          candidateIds: [metricId],
          reason: 'The selected semantic members are compiler-compatible.',
          planFrozen: true,
        },
      ],
      selectedTier: 'semantic',
      planFrozen: true,
      stopReason: 'selected',
    },
    resolvedAnalyticalPlan: {
      mode: 'authoritative',
      capability: 'semantic_execution',
      planId: 'rap:frozen-semantic',
      fingerprint: 'sha256:frozen-semantic',
      snapshotId: 'snapshot-frozen-semantic',
    } as IntentDecision['resolvedAnalyticalPlan'],
  };
}

describe("routeReasoningEffort", () => {
  it("runs cheap/mechanical routes at low effort", () => {
    expect(routeReasoningEffort("conversation")).toBe("low");
    expect(routeReasoningEffort("clarify")).toBe("low");
    expect(routeReasoningEffort("certified_answer")).toBe("low");
    expect(routeReasoningEffort("blocked")).toBe("low");
  });

  it("runs the heavy authoring/investigation routes at high effort", () => {
    expect(routeReasoningEffort("research")).toBe("high");
    expect(routeReasoningEffort("sql_cell")).toBe("high");
    expect(routeReasoningEffort("dql_block_draft")).toBe("high");
  });

  it("runs a plain generated answer at medium effort — the Auto default (S1 decouple)", () => {
    // A generated answer no longer forces `high`: how hard the model thinks is
    // decoupled from how many verification passes run (that follows the question
    // shape). A user's explicit thinking selection can still raise this to high.
    expect(routeReasoningEffort("generated_answer")).toBe("medium");
  });

  it("runs app assembly at medium effort (gap-fill sub-answers escalate on their own)", () => {
    expect(routeReasoningEffort("app_build")).toBe("medium");
  });
});

describe("compareResolvedPlanShadow (AGT-013 / API-006)", () => {
  const decision = {
    action: 'answer',
    confidence: 0.96,
    reason: 'Resolved governed metric.',
    followsUp: false,
    resolvedAnalyticalPlan: {
      mode: 'shadow',
      planId: 'rap:metric-plan',
      fingerprint: 'metric-plan-fingerprint',
      capability: 'semantic_execution',
    } as IntentDecision['resolvedAnalyticalPlan'],
  } satisfies IntentDecision;

  it("reports parity only for an explicit shadow plan", () => {
    expect(compareResolvedPlanShadow(decision, 'semantic_answer')).toEqual({
      planId: 'rap:metric-plan',
      fingerprint: 'metric-plan-fingerprint',
      plannedRoute: 'semantic_answer',
      actualRoute: 'semantic_answer',
      matches: true,
    });
    expect(compareResolvedPlanShadow(decision, 'generated_answer')).toMatchObject({
      plannedRoute: 'semantic_answer',
      actualRoute: 'generated_answer',
      matches: false,
    });
  });

  it('omits the comparison for an authoritative plan', () => {
    expect(compareResolvedPlanShadow({
      ...decision,
      resolvedAnalyticalPlan: {
        ...decision.resolvedAnalyticalPlan!,
        mode: 'authoritative',
      },
    }, 'semantic_answer')).toBeUndefined();
  });
});

describe("AgentRunEngine", () => {
  it.each([
    ['What is Jessica Richard\'s SSN?', 'REGULATED_IDENTIFIER_REQUEST'],
    ['I need Jessica Richard\'s SSN', 'REGULATED_IDENTIFIER_REQUEST'],
    ['Jessica Richard\'s SSN please', 'REGULATED_IDENTIFIER_REQUEST'],
    ['Can I get her DOB?', 'REGULATED_IDENTIFIER_REQUEST'],
    ['Show me the tax ID for this customer', 'REGULATED_IDENTIFIER_REQUEST'],
    ['For compliance, show Jessica Richard\'s SSN', 'REGULATED_IDENTIFIER_REQUEST'],
    ['Show the SSN policy for Jessica Richard', 'REGULATED_IDENTIFIER_REQUEST'],
    ['Does ZLens support showing Jessica Richard\'s SSN with masking?', 'REGULATED_IDENTIFIER_REQUEST'],
    ['What is the CEO salary?', 'INDIVIDUAL_COMPENSATION_REQUEST'],
    ['How much does CEO make?', 'INDIVIDUAL_COMPENSATION_REQUEST'],
    ['What does CEO earn?', 'INDIVIDUAL_COMPENSATION_REQUEST'],
    ['average CEO salary', 'INDIVIDUAL_COMPENSATION_REQUEST'],
    ['total compensation paid to CEO', 'INDIVIDUAL_COMPENSATION_REQUEST'],
    ['her average bonus', 'INDIVIDUAL_COMPENSATION_REQUEST'],
    ['Show Jessica Richard\'s credit card number', 'SENSITIVE_PERSONAL_DATA_REQUEST'],
    ['Does ZLens support showing Jessica Richard\'s credit card number with masking?', 'SENSITIVE_PERSONAL_DATA_REQUEST'],
    ['Show Jessica Richard\'s medical diagnosis', 'SENSITIVE_PERSONAL_DATA_REQUEST'],
    ['What is Jessica Richard\'s home address?', 'SENSITIVE_PERSONAL_DATA_REQUEST'],
    ['What is Jessica Richard\'s religion?', 'SENSITIVE_PERSONAL_DATA_REQUEST'],
    ['Can DQL redact Jessica Richard\'s credit card number?', 'SENSITIVE_PERSONAL_DATA_REQUEST'],
  ])('stops %s at request ingress before routing, providers, tools, or SQL', async (question, expectedPolicyCode) => {
    let routerCalls = 0;
    let executorCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => `run-policy-${expectedPolicyCode}`,
      now: fixedClock(),
      router: {
        decide: () => {
          routerCalls += 1;
          throw new Error('the router must not receive a blocked request');
        },
      },
      executors: {
        generated_answer: () => {
          executorCalls += 1;
          return { answer: 'must not execute' };
        },
      },
    });

    const run = await engine.run({ question, requestedMode: 'ask', intent: 'ad_hoc_ranking' });

    expect(routerCalls).toBe(0);
    expect(executorCalls).toBe(0);
    expect(run).toMatchObject({
      route: 'blocked',
      status: 'blocked',
      trustState: 'blocked',
      stopReason: 'blocked',
    });
    expect(run.telemetry).toMatchObject({ providerRoundTrips: 0, toolCalls: 0, sqlExecutions: 0 });
    expect(run.events.some((event) => event.type === 'executor.started')).toBe(false);
    expect(run.artifacts[0]?.payload).toMatchObject({
      analyticalCoverageGap: { code: 'POLICY_BLOCKED' },
      analyticalFailure: { code: 'POLICY_BLOCKED' },
    });
    expect(run.diagnosticReceipt?.failure?.code).toBe('POLICY_BLOCKED');
  });

  it('does not block a safe aggregate compensation question at ingress', async () => {
    let executorCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-policy-aggregate',
      now: fixedClock(),
      executors: {
        research: () => {
          executorCalls += 1;
          return { answer: 'Normal planning continued.', status: 'completed', trustState: 'review_required' };
        },
      },
    });

    const run = await engine.run({
      question: 'What is the average salary by department?',
      requestedMode: 'research',
      intent: 'ad_hoc_ranking',
    });

    expect(executorCalls).toBe(1);
    expect(run.status).not.toBe('blocked');
  });

  it.each([
    ['missing category', { action: 'answer', category: undefined }, 'ad_hoc_ranking', 'ask'],
    ['missing category in auto', { action: 'answer', category: undefined }, 'ad_hoc_ranking', 'auto'],
    ['forged conversational category', { action: 'answer', category: 'conversational' }, 'ad_hoc_ranking', 'ask'],
    ['forged conversational action', { action: 'converse', category: 'conversational' }, 'ad_hoc_ranking', 'ask'],
    ['mismatched clarify intent', { action: 'answer', category: 'unclear' }, 'clarify', 'ask'],
  ] as const)('fails closed for analytical Ask with %s and no RAP', async (_label, forged, intent, requestedMode) => {
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => `run-host-analytical-${_label}`,
      now: fixedClock(),
      router: {
        decide: () => ({
          action: forged.action,
          confidence: 0.99,
          reason: 'Injected router decision.',
          followsUp: false,
          source: 'llm',
          ...(forged.category ? { category: forged.category } : {}),
        }),
      },
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return { answer: 'A 999', trustState: 'review_required', status: 'needs_review' };
        },
      },
    });

    const run = await engine.run({
      question: 'who are the top customers by revenue',
      requestedMode,
      intent,
    });

    expect(generatedCalls).toBe(0);
    expect(run).toMatchObject({ route: 'blocked', status: 'blocked', trustState: 'blocked' });
    expect(run.answer).toContain('could not freeze an exact analytical plan');
    expect(run.events.some((event) => event.type === 'executor.started' && event.route === 'generated_answer')).toBe(false);
  });

  it.each([
    ['hi', 'greeting'],
    ['explain revenue definition', undefined],
  ] as const)('keeps the no-data turn %j out of analytical execution', async (question, expectedKind) => {
    let generatedCalls = 0;
    let conversationCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => `run-host-non-data-${question}`,
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'answer',
          confidence: 0.99,
          reason: 'Injected analytical route.',
          followsUp: false,
          source: 'llm',
          category: 'data_analysis',
        }),
      },
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return { answer: 'must not run' };
        },
        conversation: () => {
          conversationCalls += 1;
          return { answer: 'No warehouse query was needed.', answerKind: 'conversational' };
        },
      },
    });

    const run = await engine.run({ question, requestedMode: 'ask', intent: 'ad_hoc_ranking' });

    expect(generatedCalls).toBe(0);
    expect(conversationCalls).toBe(1);
    expect(run).toMatchObject({ route: 'conversation', status: 'completed', trustState: 'not_applicable' });
    expect(run.routeDecision?.conversationalKind).toBe(expectedKind);
  });

  // AGT-028: retrieval surfaced governed candidates but no exact tuple froze.
  // This used to fail closed, which is the "governed-only" dead end reported from
  // production ("who are the top customers for BCM" → an unanswerable
  // clarification, then "ZLens could not freeze an exact analytical plan").
  // A coverage gap is a discovery result, not a terminal state: the run now
  // continues into the generated lane. The safety property the original test
  // protected is preserved by the LABEL, not by refusing — the answer is never
  // presented as governed.
  it('continues into a review-required generated answer when analytical Ask has candidates but no frozen plan', async () => {
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-analytical-no-rap',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'answer',
          confidence: 0.8,
          reason: 'Retrieved candidates, but no exact analytical tuple was resolved.',
          followsUp: false,
          source: 'heuristic',
          category: 'data_lookup',
          retrievalEvidence: {
            snapshotId: 'snapshot-jaffle',
            candidateCount: 2,
            candidateIds: ['semantic:metric:orders.revenue', 'dql:block:top_beverage_customers'],
          },
          analyticalCascadeDecision: safeExploratoryCascade(),
        }),
      },
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return { answer: 'Legacy generator chose customers instead of revenue.' };
        },
      },
    });

    const run = await engine.run({
      question: 'who are the top customers by revenue',
      requestedMode: 'ask',
    });

    expect(generatedCalls).toBe(1);
    expect(run.route).toBe('generated_answer');
    expect(run.status).toBe('needs_review');
    // The load-bearing guarantee: an answer produced without a frozen plan is
    // labelled review-required and is never certified or governed.
    expect(run.trustState).toBe('review_required');
    expect(run.summary).toBe('Created review-required agent output.');
    expect(run.events.some((event) => event.type === 'executor.started' && event.route === 'generated_answer')).toBe(true);
  });

  it('CTX-007 persists the router-owned cascade unchanged in the V3 receipt', async () => {
    const cascade = {
      ...safeExploratoryCascade(),
      sourceCoverage: [
        { version: 1 as const, source: 'certified' as const, status: 'stale' as const, candidateIds: ['dql:block:stale'] },
        { version: 1 as const, source: 'semantic' as const, status: 'errored' as const, candidateIds: ['semantic:metric:revenue'] },
        { version: 1 as const, source: 'governed_relational' as const, status: 'skipped' as const, candidateIds: [] },
        { version: 1 as const, source: 'exploratory' as const, status: 'available' as const, candidateIds: ['runtime:table:orders'] },
      ],
    };
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-v3-cascade',
      now: fixedClock(),
      router: { decide: () => ({
        action: 'answer', confidence: 0.6, followsUp: false, source: 'heuristic',
        reason: 'The router selected bounded exploration.', analyticalCascadeDecision: cascade,
      }) },
      executors: { generated_answer: () => ({ answer: 'Review-required result.' }) },
    });

    const run = await engine.run({ question: 'revenue by sales channel', requestedMode: 'ask' });
    expect(run.diagnosticReceiptV3).toMatchObject({
      sourceCoverage: cascade.sourceCoverage,
      cascade,
      planFrozen: false,
    });
    expect(run.diagnosticReceiptV3?.cascade?.attempts).toEqual(cascade.attempts);
  });

  it('AGT-036 executes every independently frozen ordinary Ask task with its task-local program', async () => {
    const requirements = {
      version: 1 as const,
      measures: ['revenue'],
      dimensions: [],
      entityTerms: [],
      entityDisplayTerms: [],
      memberTerms: [],
    };
    const taskExecution = (taskId: string, programId: string) => {
      const state = {
        version: 1 as const,
        mode: 'authoritative' as const,
        phase: 'compiled' as const,
        frame: {
          version: 3 as const,
          questionFingerprint: `sha256:${taskId}`,
          kind: 'aggregation' as const,
          requirements,
          conversation: { binding: 'none' as const },
        },
        mission: {
          version: 1 as const,
          mode: 'ask' as const,
          taskLimit: 3,
          planningContinuationLimit: 2,
          tasks: [{ id: taskId, kind: 'direct_answer' as const, question: `Revenue task ${taskId}` }],
          hypotheses: [],
        },
        workspace: {
          version: 1 as const,
          snapshotId: 'snapshot:compound',
          sourceCoverage: [],
          admittedCandidateIds: ['semantic:metric:revenue'],
          excludedCandidates: [],
          tools: [],
        },
        program: {
          version: 1 as const,
          id: programId,
          frameFingerprint: `sha256:${taskId}`,
          taskIds: [taskId],
          candidateIds: ['semantic:metric:revenue'],
          executionCandidateIds: ['semantic:metric:revenue'],
          requiredRoles: ['metric' as const],
          filters: [],
          comparison: { kind: 'none' as const, terms: [] },
          relationshipRequirements: [],
          outputs: {
            measures: ['revenue'],
            dimensions: [],
            entityDisplayTerms: [],
            assertions: ['all_requested_measures' as const, 'result_contract' as const],
          },
        },
        conversationDelta: {
          version: 2 as const,
          sourceQuestionFingerprint: `sha256:${taskId}`,
          partialFrame: { kind: 'aggregation' as const, requirements, planningMode: 'initial_planner' as const },
          programId,
        },
        planningContinuations: 1,
        toolCalls: 2,
        executionAttempts: 0,
        repairAttempts: 0,
      };
      const compilerDecision = frozenSemanticDecision();
      const { askAnalystDecision: _runtimeOnly, ...compilerOnlyDecision } = compilerDecision;
      return {
        version: 1 as const,
        taskId,
        state,
        program: state.program,
        meaningResolution: {
          version: 1 as const,
          selectedConceptIds: ['semantic:metric:revenue'],
          queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
        },
        requirementSeed: {
          version: 1 as const,
          sourceQuestion: `Revenue task ${taskId}`,
          requirements,
          queryIntent: { measures: ['revenue'], dimensions: [], filters: [] },
        },
        tierReadiness: {
          connector: 'ready' as const,
          activeTarget: 'ready' as const,
          semanticCompiler: 'ready' as const,
          physicalSchema: 'ready' as const,
        },
        compilerDecision: compilerOnlyDecision,
        resolvedPlan: {
          version: 2 as const,
          programId,
          compiler: 'metricflow' as const,
          selectedTier: 'semantic' as const,
          planFrozen: true,
          reviewRequired: false,
          planFingerprint: `sha256:${programId}`,
        },
      };
    };
    const first = taskExecution('task-1', 'program:task-1');
    const second = taskExecution('task-2', 'program:task-2');
    const decision = frozenSemanticDecision();
    decision.askAnalystDecision = {
      version: 1,
      mode: 'authoritative',
      state: first.state,
      resolvedPlan: first.resolvedPlan,
      frozenPlan: {
        source: 'deterministic',
        rationale: 'Two independently frozen ordinary Ask tasks.',
        steps: [
          { id: 'task-1', askAnalystTaskId: 'task-1', route: 'semantic_answer', goal: 'Revenue task 1', successCriteria: [] },
          { id: 'task-2', askAnalystTaskId: 'task-2', route: 'semantic_answer', goal: 'Revenue task 2', successCriteria: [] },
        ],
      },
      taskExecutions: [first, second],
    };
    const executedPrograms: string[] = [];
    const executedQuestions: string[] = [];
    const executedChildIds: string[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-compound-authoritative-ask',
      now: fixedClock(),
      planner: {
        plan: vi.fn(() => { throw new Error('The legacy planner must not replace a runtime-frozen compound Ask.'); }),
        replan: vi.fn(() => ({ decision: 'accept' as const })),
      },
      router: { decide: () => decision },
      executors: {
        semantic_answer: ({ request }) => {
          const programId = request.askAnalystProgram?.id;
          if (!programId) throw new Error('Expected a task-local Ask program at the executor boundary.');
          executedPrograms.push(programId);
          executedQuestions.push(request.question);
          executedChildIds.push(request.askAnalystTaskChild?.taskId ?? 'missing');
          return {
            answer: `Result for ${programId}`,
            artifacts: [{
              id: `answer:${programId}`,
              kind: 'answer',
              title: programId,
              trustState: 'governed',
              payload: {
                result: {
                  columns: ['revenue'],
                  rows: [{ revenue: programId === first.program.id ? 1 : 2 }],
                  rowCount: 1,
                  resultFingerprint: `result:${programId}`,
                  answerTier: 'semantic_metric',
                },
              },
            }],
          };
        },
      },
    });

    const run = await engine.run({ question: 'show revenue; show revenue again', requestedMode: 'ask' });

    expect(executedPrograms).toEqual([first.program.id, second.program.id]);
    expect(executedQuestions).toEqual(['Revenue task task-1', 'Revenue task task-2']);
    expect(executedChildIds).toEqual(['task-1', 'task-2']);
    expect(run.plan?.steps.map((step) => step.askAnalystTaskId)).toEqual(['task-1', 'task-2']);
    expect(run.steps.map((step) => step.route)).toEqual(['semantic_answer', 'semantic_answer']);
    expect(run.steps.map((step) => step.status)).toEqual(['passed', 'passed']);

    // A failure in the first immutable child must not hide task-2 from the
    // trace or turn task-2's result into a misleading partial success.
    const failedThenContinued: string[] = [];
    const failureEngine = new AgentRunEngine({
      idGenerator: () => 'run-compound-authoritative-failure',
      now: fixedClock(),
      planner: {
        plan: vi.fn(() => { throw new Error('The legacy planner must not replace frozen children.'); }),
        replan: vi.fn(() => ({ decision: 'accept' as const })),
      },
      router: { decide: () => decision },
      executors: {
        semantic_answer: ({ request }) => {
          const taskId = request.askAnalystTaskChild?.taskId;
          failedThenContinued.push(taskId ?? 'missing');
          if (taskId === 'task-1') {
            return {
              status: 'blocked' as const,
              trustState: 'blocked' as const,
              summary: 'The first frozen child could not execute.',
              artifacts: [{
                id: 'failure:task-1', kind: 'answer' as const, title: 'Task 1 failure', trustState: 'blocked' as const,
                payload: { code: 'TASK_1_BLOCKED' },
              }],
            };
          }
          return {
            answer: 'Task 2 must remain a receipt only when task 1 blocks.',
            artifacts: [{
              id: 'answer:task-2', kind: 'answer' as const, title: 'Task 2', trustState: 'governed' as const,
              payload: {
                result: {
                  columns: ['revenue'], rows: [{ revenue: 2 }], rowCount: 1,
                  resultFingerprint: 'result:task-2', answerTier: 'semantic_metric',
                },
              },
            }],
          };
        },
      },
    });
    const failedRun = await failureEngine.run({ question: 'show revenue; show revenue again', requestedMode: 'ask' });
    expect(failedThenContinued).toEqual(['task-1', 'task-2']);
    expect(failedRun.steps.map((step) => step.status)).toEqual(['blocked', 'passed']);
    expect(failedRun).toMatchObject({ status: 'blocked', trustState: 'blocked' });
    expect(failedRun.answer).toContain('No partial result was accepted');
    expect(failedRun.answer).not.toContain('Task 2 must remain');

    // V2 task-outcome semantics are deliberately opt-in.  An authoritative
    // ordinary Ask with independently frozen children must retain a completed
    // sibling when another independent child fails, rather than reusing the
    // legacy all-or-nothing aggregate above.  The compact outcome summary is
    // host-owned; a client cannot mint it through an executor response.
    const partialDecision = {
      ...decision,
      askAnalystDecision: {
        ...decision.askAnalystDecision!,
        taskOutcomeSummary: {
          version: 1 as const,
          // Compiler-time summaries carry no execution success. The engine
          // checkpoints task-2 only after its canonical result artifact.
          status: 'blocked' as const,
          trustState: 'blocked' as const,
          taskCount: 2,
          successfulTaskIds: [],
          failedTaskIds: [],
          dependencyBlockedTaskIds: [],
        },
        taskOutcomes: [],
      },
    };
    const partialCalls: string[] = [];
    const partialEngine = new AgentRunEngine({
      idGenerator: () => 'run-compound-authoritative-partial',
      now: fixedClock(),
      router: { decide: () => partialDecision },
      executors: {
        semantic_answer: ({ request }) => {
          const taskId = request.askAnalystTaskChild?.taskId ?? 'missing';
          partialCalls.push(taskId);
          if (taskId === 'task-1') {
            return {
              status: 'blocked' as const,
              trustState: 'blocked' as const,
              summary: 'Task 1 could not execute.',
            };
          }
          return {
            answer: 'Task 2 completed independently.',
            trustState: 'governed' as const,
            artifacts: [{
              id: 'answer:task-2:partial', kind: 'answer' as const, title: 'Task 2', trustState: 'governed' as const,
              payload: { result: { columns: ['revenue'], rows: [{ revenue: 2 }], rowCount: 1, resultFingerprint: 'result:task-2:partial', answerTier: 'semantic_metric' } },
            }],
          };
        },
      },
    });
    const partialRun = await partialEngine.run({ question: 'show revenue; show revenue again', requestedMode: 'ask' });
    expect(partialCalls).toEqual(['task-1', 'task-2']);
    expect(partialRun).toMatchObject({ status: 'completed', trustState: 'governed' });
    expect(partialRun.analyticalTaskOutcomeSummary).toMatchObject({
      status: 'partial', trustState: 'governed', successfulTaskIds: ['task-2'], failedTaskIds: ['task-1'],
    });
    expect(partialRun.analyticalTaskOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-1', status: 'blocked', trustState: 'blocked' }),
      expect.objectContaining({ taskId: 'task-2', status: 'completed', trustState: 'governed' }),
    ]));
    expect(partialRun.artifacts.map((artifact) => artifact.id)).toContain('answer:task-2:partial');
    expect(partialRun.answer).not.toContain('No partial result was accepted');

    {
      // AGT-036: compilation must checkpoint no success before task 1, then
      // persist task 1's canonical result before the later child begins.
      const checkpoints: AgentRunProgressV1[] = [];
      const checkpointStore: AgentRunStore = {
        save: () => undefined,
        get: () => undefined,
        saveProgress: (snapshot) => {
          checkpoints.push(JSON.parse(JSON.stringify(snapshot)) as AgentRunProgressV1);
        },
      };
      const checkpointEngine = new AgentRunEngine({
        idGenerator: () => 'run-compound-checkpoint',
        now: fixedClock(),
        store: checkpointStore,
        router: { decide: () => partialDecision },
        executors: {
          semantic_answer: ({ request }) => {
            const taskId = request.askAnalystTaskChild?.taskId;
            return taskId === 'task-1'
              ? {
                  answer: 'Task 1 completed.',
                  trustState: 'governed' as const,
                  artifacts: [{
                    id: 'answer:task-1:checkpoint', kind: 'answer' as const, title: 'Task 1', trustState: 'governed' as const,
                    payload: { result: { columns: ['revenue'], rows: [{ revenue: 1 }], rowCount: 1, resultFingerprint: 'result:task-1:checkpoint' } },
                  }],
                }
              : { status: 'blocked' as const, trustState: 'blocked' as const, summary: 'Task 2 stopped for this checkpoint test.' };
          },
        },
      });
      await checkpointEngine.run({ question: 'show revenue; show revenue again', requestedMode: 'ask' });

      const preExecution = checkpoints.find((snapshot) =>
        snapshot.analyticalTaskOutcomeSummary?.taskCount === 2
        && snapshot.steps.length === 0);
      expect(preExecution?.analyticalTaskOutcomeSummary?.successfulTaskIds).toEqual([]);
      const afterTaskOne = checkpoints.find((snapshot) =>
        snapshot.analyticalTaskOutcomes?.some((outcome) =>
          outcome.taskId === 'task-1'
          && outcome.status === 'completed'
          && outcome.resultFingerprint === 'result:task-1:checkpoint'));
      expect(afterTaskOne?.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'answer:task-1:checkpoint' }),
      ]));
      expect(afterTaskOne?.analyticalTaskOutcomeSummary?.successfulTaskIds).toEqual(['task-1']);
    }

    {
      // AGT-036: review-required prose alone is not a successful task.
      const reviewOnlyEngine = new AgentRunEngine({
        idGenerator: () => 'run-compound-review-only',
        now: fixedClock(),
        router: { decide: () => partialDecision },
        executors: {
          semantic_answer: ({ request }) => request.askAnalystTaskChild?.taskId === 'task-1'
            ? {
                answer: 'Generated SQL is ready for review.',
                status: 'needs_review' as const,
                trustState: 'review_required' as const,
              }
            : {
                status: 'blocked' as const,
                trustState: 'blocked' as const,
                summary: 'The second task did not execute.',
              },
        },
      });
      const reviewOnlyRun = await reviewOnlyEngine.run({ question: 'show revenue; show revenue again', requestedMode: 'ask' });
      expect(reviewOnlyRun).toMatchObject({ status: 'blocked', trustState: 'blocked' });
      expect(reviewOnlyRun.analyticalTaskOutcomeSummary).toMatchObject({
        status: 'blocked', successfulTaskIds: [], failedTaskIds: ['task-1', 'task-2'],
      });
      expect(reviewOnlyRun.analyticalTaskOutcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          taskId: 'task-1', status: 'blocked',
          failure: expect.objectContaining({ code: 'TASK_EXECUTION_RESULT_MISSING' }),
        }),
      ]));
    }

    // A dependent child is not an independent fallback.  When its parent did
    // not complete, the engine must retain the child's typed
    // `dependency_blocked` outcome without invoking the child executor.
    const dependentSecond = {
      ...second,
      state: {
        ...second.state,
        mission: {
          ...second.state.mission,
          tasks: second.state.mission.tasks.map((task) => ({ ...task, dependencies: ['task-1'] })),
        },
      },
    };
    const dependencyDecision = {
      ...partialDecision,
      askAnalystDecision: {
        ...partialDecision.askAnalystDecision,
        state: first.state,
        taskExecutions: [first, dependentSecond],
      },
    };
    const dependencyCalls: string[] = [];
    const dependencyEngine = new AgentRunEngine({
      idGenerator: () => 'run-compound-authoritative-dependency',
      now: fixedClock(),
      router: { decide: () => dependencyDecision },
      executors: {
        semantic_answer: ({ request }) => {
          const taskId = request.askAnalystTaskChild?.taskId ?? 'missing';
          dependencyCalls.push(taskId);
          return taskId === 'task-1'
            ? { status: 'blocked' as const, trustState: 'blocked' as const, summary: 'Task 1 could not execute.' }
            : { answer: 'This dependent child must not run.', trustState: 'governed' as const };
        },
      },
    });
    const dependencyRun = await dependencyEngine.run({ question: 'show revenue; then show it by region', requestedMode: 'ask' });
    expect(dependencyCalls).toEqual(['task-1']);
    expect(dependencyRun).toMatchObject({ status: 'blocked', trustState: 'blocked' });
    expect(dependencyRun.analyticalTaskOutcomeSummary).toMatchObject({
      status: 'blocked', successfulTaskIds: [], failedTaskIds: ['task-1'], dependencyBlockedTaskIds: ['task-2'],
    });
    expect(dependencyRun.analyticalTaskOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-2', status: 'dependency_blocked', dependencyTaskIds: ['task-1'] }),
    ]));
  });

  it('tells the decision story of a pipeline run from its V9 receipt: the typed intent, the tiers tried, a frozen executable (item 7 of the NBA validation)', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-v9-story',
      now: fixedClock(),
      router: { decide: () => ({ ...frozenExploratoryDecision(), route: 'generated_answer', reason: 'pipeline' } as IntentDecision) },
      executors: {
        generated_answer: () => ({
          answer: 'points by player',
          status: 'completed', trustState: 'governed', answerKind: 'governed', resolvedRoute: 'generated_answer',
          askPipelineReceipt: {
            version: 9,
            vocabularyFingerprint: 'v',
            intent: { version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'metric:points' }, { ref: 'metric:games' }], groupBy: [{ ref: 'entity:player', role: 'key' }], display: ['dimension:player_name'], filters: [], ordering: { ref: 'metric:points', direction: 'desc' }, limit: 5, expectedShape: 'ranking', unresolved: [], provenance: {} },
            dispatches: [{ purpose: 'intent:read', ms: 10 }],
            candidates: [], refusals: [],
            tiers: [{ round: 1, tier: 'certified', outcome: 'refused' }, { round: 1, tier: 'semantic', outcome: 'refused' }, { round: 1, tier: 'relational', outcome: 'prepared' }],
            executed: { tier: 'relational', sqlFingerprint: 'sha256:x', rowCount: 5, ms: 3, proofs: [] },
            timings: {}, reuse: 'none',
            context: { version: 1, admitted: { byKind: { metric: 4, dimension: 6, entity: 2, relation: 3, skill: 1, hint: 1 } } },
          },
        } as never),
      },
    });
    const run = await engine.run({ question: 'top five players by points', requestedMode: 'ask' });
    expect(run.diagnosticReceiptV4?.summary).toMatchObject({
      understoodRequest: { measures: 2, dimensions: 2, entityRequested: true, ranking: { direction: 'top', limit: 5, defaultedLimit: false } },
      // The evidence a pipeline run read is its ledger, by role — never "no role evidence" for a run that answered.
      evidenceByRole: [{ role: 'categorical_dimension', candidateCount: 6 }, { role: 'context', candidateCount: 2 }, { role: 'entity_key', candidateCount: 2 }, { role: 'metric', candidateCount: 4 }, { role: 'relation', candidateCount: 3 }],
      tierDecisions: [
        { tier: 'certified', outcome: 'ineligible', planFrozen: false },
        { tier: 'semantic', outcome: 'ineligible', planFrozen: false },
        { tier: 'governed_relational', outcome: 'executable', planFrozen: true },
      ],
      selectedPlan: { tier: 'governed_relational', planFrozen: true },
    });
  });

  it('AGT-034/OBS-014 records a mismatched exploratory authorization as an internal no-execution incident', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-exploratory-authorization-mismatch',
      now: fixedClock(),
      router: { decide: () => frozenExploratoryDecision() },
      executors: {
        generated_answer: () => ({
          answer: 'This answer must not be accepted.',
          analyticalExecutionFreeze: {
            version: 1,
            selectedTier: 'exploratory_sql',
            // A target/SQL authorization cannot mint or substitute plan
            // authority after the router froze the closure.
            planId: 'rap:forged-after-sql',
            planFingerprint: 'sha256:frozen-exploration',
            snapshotId: 'snapshot-frozen-exploration',
            targetFingerprint: 'target:test',
            sqlFingerprint: 'sql:test',
            candidateIds: ['dbt:model:orders', 'runtime:column:revenue', 'runtime:column:customer_name'],
            authorization: 'capability_minted',
          },
        }),
      },
    });

    const run = await engine.run({ question: 'revenue by customer', requestedMode: 'ask' });

    expect(run).toMatchObject({ status: 'blocked', trustState: 'blocked' });
    expect(run.diagnosticReceipt?.failure).toMatchObject({
      code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH',
      phase: 'sql.authorize',
      recoverable: false,
      safeActions: ['export_redacted_trace'],
    });
    expect(run.diagnosticReceiptV4?.summary).toMatchObject({
      terminalIncident: {
        code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH',
        boundary: 'sql.authorize',
        origin: 'internal_invariant',
        impact: 'execution_not_attempted',
        safeAction: 'export_redacted_trace',
      },
      safeNextAction: 'export_redacted_trace',
    });
  });

  it('OBS-014 records a frozen semantic warehouse binder failure as a typed execution incident', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-semantic-warehouse-binder',
      now: fixedClock(),
      router: { decide: () => authoritativeDecision('semantic_execution') },
      executors: {
        semantic_answer: () => ({
          answer: 'The selected warehouse relation is unavailable.',
          status: 'blocked',
          trustState: 'blocked',
          stopReason: 'blocked',
          artifacts: [{
            id: 'semantic-binder-failure',
            kind: 'answer',
            title: 'Semantic execution could not complete',
            trustState: 'blocked',
            payload: {
              analyticalFailure: {
                version: 1,
                code: 'RELATION_NOT_FOUND',
                phase: 'execution',
                message: 'A governed relation required by the selected plan is unavailable.',
                recoverability: 'refresh_snapshot',
                failedBindings: [],
                snapshotId: 'snapshot-semantic-binder',
                safeActions: ['change_authorized_connection', 'refresh_snapshot'],
              },
              warehouseFailure: {
                version: 1,
                origin: 'warehouse',
                stage: 'execution',
                category: 'unknown_relation',
                retryDisposition: 'refresh_metadata',
                redactedMessage: 'Binder Error: Catalog [redacted] does not exist.',
              },
            },
          }],
          evaluations: [],
          nextActions: [],
        }),
      },
    });

    const run = await engine.run({ question: 'revenue by region', requestedMode: 'ask' });

    expect(run).toMatchObject({ status: 'blocked', trustState: 'blocked' });
    expect(run.diagnosticReceiptV4?.summary).toMatchObject({
      terminalIncident: {
        code: 'ANALYTICAL_EXECUTION_FAILED',
        boundary: 'sql.execute',
        origin: 'warehouse',
        impact: 'execution_failed',
        safeAction: 'change_authorized_connection',
      },
      safeNextAction: 'change_authorized_connection',
    });
  });

  it('OBS-014 classifies a router-frozen pre-SQL semantic compilation failure without rewriting provider or SQL counts', async () => {
    let sequence = 0;
    const spans: Array<{ id: string; name: string; payload?: unknown; outcome?: string; reasonCode?: string }> = [];
    const observer = {
      enabled: true,
      recordingStatus: 'recording',
      startSpan: (input) => {
        const id = `compile-span-${++sequence}`;
        spans.push({ id, name: input.name, payload: input.payload });
        return id;
      },
      finishSpan: (spanId, input) => {
        const span = spans.find((candidate) => candidate.id === spanId);
        if (span) Object.assign(span, input);
      },
      recordCandidateDecision: () => {},
      recordLink: () => {},
      finalize: () => undefined,
      markPartial: () => {},
      reference: () => undefined,
    } satisfies AskTraceObserverV1;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-frozen-plan-compilation-failure',
      now: fixedClock(),
      traceObserverFactory: () => observer,
      router: { decide: () => frozenSemanticDecision() },
      executors: {
        semantic_answer: () => ({
          answer: 'No answer was produced.',
          status: 'blocked',
          trustState: 'blocked',
          stopReason: 'blocked',
          artifacts: [{
            id: 'semantic-compile-failure',
            kind: 'answer',
            title: 'Semantic compilation could not complete',
            trustState: 'blocked',
            payload: {
              analyticalFailure: {
                version: 1,
                code: 'COMPILATION_FAILED',
                phase: 'compilation',
                safeActions: ['edit_dql', 'open_sql_notebook'],
              },
            },
          }],
          telemetry: {
            version: 1,
            stageDurationsMs: { provider: 11, total: 11 },
            providerRoundTrips: 1,
            toolCalls: 0,
            sqlExecutions: 0,
            repairs: 0,
            egressReceipts: 1,
          },
        }),
      },
    });

    const run = await engine.run({ question: 'revenue by region', requestedMode: 'ask' });
    const summary = run.diagnosticReceiptV4?.summary;

    expect(run).toMatchObject({ route: 'semantic_answer', status: 'blocked', trustState: 'blocked' });
    expect(run.telemetry).toMatchObject({ providerRoundTrips: 1, toolCalls: 0, sqlExecutions: 0, repairs: 0 });
    expect(run.diagnosticReceipt?.failure).toMatchObject({ code: 'COMPILATION_FAILED' });
    expect(summary).toMatchObject({
      summaryFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      terminalIncident: {
        version: 1,
        code: 'COMPILATION_FAILED',
        boundary: 'semantic.compile',
        origin: 'semantic_compiler',
        impact: 'execution_not_attempted',
        safeAction: 'edit_dql',
      },
      safeNextAction: 'edit_dql',
    });
    expect(run.diagnosticReceiptV4?.terminalIncident).toEqual(summary?.terminalIncident);
    const terminal = spans.find((span) => span.name === 'semantic.compile' && span.reasonCode === 'post_freeze_failure');
    expect(terminal).toMatchObject({
      outcome: 'error',
      payload: { kind: 'result', failureCode: 'COMPILATION_FAILED', safeAction: 'edit_dql' },
    });
    expect(spans.some((span) => span.name === 'sql.execute')).toBe(false);
  });

  it('OBS-014 preserves a frozen semantic result-contract rejection as result validation, not execution', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-frozen-semantic-result-validation-failure',
      now: fixedClock(),
      router: { decide: () => frozenSemanticDecision() },
      executors: {
        semantic_answer: () => ({
          answer: 'The returned result was not accepted.',
          status: 'blocked',
          trustState: 'blocked',
          stopReason: 'blocked',
          artifacts: [{
            id: 'semantic-result-validation-failure',
            kind: 'answer',
            title: 'Semantic result did not match the frozen plan',
            trustState: 'blocked',
            payload: {
              analyticalFailure: {
                version: 1,
                code: 'RESULT_CONTRACT_MISMATCH',
                phase: 'result_validation',
                message: 'The returned result was not accepted.',
                safeActions: ['inspect_failure'],
              },
              // Legacy answer-loop compatibility payloads can carry this
              // redacted string after a result rejection. V4 must still keep
              // the result-validation boundary.
              executionError: 'The frozen result contract rejected the returned fields.',
            },
          }],
          evaluations: [],
          nextActions: [],
          telemetry: {
            version: 1,
            stageDurationsMs: { execution: 7, total: 7 },
            providerRoundTrips: 0,
            toolCalls: 0,
            sqlExecutions: 1,
            repairs: 0,
            egressReceipts: 0,
          },
        }),
      },
    });

    const run = await engine.run({ question: 'revenue by region', requestedMode: 'ask' });

    expect(run.diagnosticReceiptV4?.summary.terminalIncident).toMatchObject({
      code: 'RESULT_CONTRACT_MISMATCH',
      boundary: 'result.validate',
      origin: 'result_validator',
      impact: 'answer_not_produced',
      safeAction: 'inspect_failure',
    });
    expect(run.diagnosticReceiptV4?.summary.terminalIncident?.code).not.toBe('ANALYTICAL_EXECUTION_FAILED');
  });

  it('AGT-005 keeps a serialized MetricFlow compiler receipt out of the connection-failure path', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-serialized-semantic-compiler-failure',
      now: fixedClock(),
      router: { decide: () => frozenSemanticDecision() },
      executors: {
        semantic_answer: () => ({
          answer: 'No answer was produced.',
          status: 'blocked',
          trustState: 'blocked',
          stopReason: 'blocked',
          artifacts: [{
            id: 'semantic-runtime-compile-failure',
            kind: 'answer',
            title: 'Semantic compilation could not complete',
            trustState: 'blocked',
            // Some old provider-tool serialization paths retained this
            // compiler receipt but lost the outer analyticalFailure wrapper.
            // It remains a typed pre-SQL compiler failure, not a connection.
            payload: {
              semanticExecutionTrace: {
                adapter: 'metricflow-cli',
                status: 'failed',
                failure: {
                  code: 'SEMANTIC_COMPILATION_FAILED',
                  phase: 'compilation',
                  message: 'MetricFlow requires the exact selected group-by item in order_by.',
                  safeActions: ['edit_dql'],
                },
              },
            },
          }],
          evaluations: [],
          nextActions: [],
          telemetry: {
            version: 1,
            stageDurationsMs: { provider: 11, total: 11 },
            providerRoundTrips: 1,
            toolCalls: 0,
            sqlExecutions: 0,
            repairs: 0,
            egressReceipts: 1,
          },
        }),
      },
    });

    const run = await engine.run({ question: 'top customers by revenue', requestedMode: 'ask' });

    expect(run.diagnosticReceiptV4?.summary.terminalIncident).toMatchObject({
      code: 'COMPILATION_FAILED',
      boundary: 'semantic.compile',
      origin: 'semantic_compiler',
      impact: 'execution_not_attempted',
    });
    expect(run.diagnosticReceiptV4?.summary.terminalIncident?.code).not.toBe('ANALYTICAL_EXECUTION_FAILED');
  });

  it('AGT-031 persists one same-plan exploratory repair without reopening routing', async () => {
    const initialFreeze = {
      version: 1 as const,
      selectedTier: 'exploratory_sql' as const,
      planId: 'rap:frozen-exploration',
      planFingerprint: 'sha256:frozen-exploration',
      snapshotId: 'snapshot-frozen-exploration',
      targetFingerprint: 'target:test',
      sqlFingerprint: 'a'.repeat(32),
      candidateIds: ['dbt:model:orders', 'runtime:column:revenue', 'runtime:column:customer_name'],
      authorization: 'capability_minted' as const,
      authorizationAttempt: { version: 1 as const, index: 0 as const },
    };
    const repairFreeze = {
      ...initialFreeze,
      sqlFingerprint: 'b'.repeat(32),
      authorizationAttempt: {
        version: 1 as const,
        index: 1 as const,
        parentSqlFingerprint: initialFreeze.sqlFingerprint,
      },
    };
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-exploratory-same-plan-repair',
      now: fixedClock(),
      router: { decide: () => frozenExploratoryDecision() },
      executors: {
        generated_answer: () => ({
          answer: 'The corrected exploratory query returned a review-required result.',
          status: 'completed',
          trustState: 'review_required',
          analyticalExecutionFreeze: initialFreeze,
          analyticalExecutionRepairFreeze: repairFreeze,
        }),
      },
    });

    const run = await engine.run({ question: 'revenue by customer', requestedMode: 'ask' });

    expect(run).toMatchObject({ status: 'completed', trustState: 'review_required' });
    expect(run.routeDecision?.analyticalCascadeDecision).toMatchObject({
      selectedTier: 'exploratory_sql',
      planFrozen: true,
      exploratoryExecutionFreeze: initialFreeze,
      exploratoryRepairExecutionFreeze: repairFreeze,
    });
    expect(run.routeDecision?.resolvedAnalyticalPlan).toMatchObject({
      planId: initialFreeze.planId,
      fingerprint: initialFreeze.planFingerprint,
      snapshotId: initialFreeze.snapshotId,
      capability: 'bounded_exploration',
    });
  });

  it('AGT-031 denies a second or mismatched exploratory repair receipt without execution fallback', async () => {
    const initialFreeze = {
      version: 1 as const,
      selectedTier: 'exploratory_sql' as const,
      planId: 'rap:frozen-exploration',
      planFingerprint: 'sha256:frozen-exploration',
      snapshotId: 'snapshot-frozen-exploration',
      targetFingerprint: 'target:test',
      sqlFingerprint: 'a'.repeat(32),
      candidateIds: ['dbt:model:orders', 'runtime:column:revenue', 'runtime:column:customer_name'],
      authorization: 'capability_minted' as const,
      authorizationAttempt: { version: 1 as const, index: 0 as const },
    };
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-exploratory-second-repair-denied',
      now: fixedClock(),
      router: { decide: () => frozenExploratoryDecision() },
      executors: {
        generated_answer: () => ({
          answer: 'This must not be accepted.',
          analyticalExecutionFreeze: initialFreeze,
          analyticalExecutionRepairFreeze: {
            ...initialFreeze,
            sqlFingerprint: 'c'.repeat(32),
            // A repair may only refer to the initial receipt. This forged
            // parent simulates a second repair or changed SQL lineage.
            authorizationAttempt: {
              version: 1 as const,
              index: 1 as const,
              parentSqlFingerprint: 'b'.repeat(32),
            },
          },
        }),
      },
    });

    const run = await engine.run({ question: 'revenue by customer', requestedMode: 'ask' });

    expect(run).toMatchObject({ status: 'blocked', trustState: 'blocked' });
    expect(run.diagnosticReceipt?.failure).toMatchObject({
      code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH',
      phase: 'sql.authorize',
      recoverable: false,
      safeActions: ['export_redacted_trace'],
    });
  });

  it('allows one bounded same-route repair after an ordinary generated Ask attempt fails', async () => {
    let replanCalls = 0;
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-ordinary-ask-no-replan',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'answer',
          confidence: 0.8,
          reason: 'A review-required generated answer is needed.',
          followsUp: false,
          source: 'heuristic',
        }),
      },
      planner: {
        plan: ({ request, routeDecision }) => ({
          source: 'deterministic',
          rationale: routeDecision.reason,
          steps: [{
            id: 'step-1',
            route: 'generated_answer',
            goal: request.question,
            successCriteria: [],
          }],
        }),
        replan: () => {
          replanCalls += 1;
          return replanCalls === 1
            ? { decision: 'repair', repairHint: 'Try another provider plan.' }
            : { decision: 'accept' };
        },
      },
      executors: {
        generated_answer: () => ({
          summary: 'The generated attempt needs manual review.',
          evaluations: [{
            id: 'generated-contract',
            label: 'Generated contract',
            passed: false,
            severity: 'blocking',
            message: 'The generated attempt did not satisfy its result contract.',
            suggestedRepair: 'Replan the generated answer.',
          }],
        }),
      },
    });

    const run = await engine.run({ question: 'revenue by customer', requestedMode: 'ask' },
      (event) => events.push(event));

    expect(replanCalls).toBe(2);
    expect(run.steps[0]).toMatchObject({ route: 'generated_answer', attempts: 2, status: 'blocked' });
    expect(events.filter((event) => event.type === 'repair.attempted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'replan.decided')).toHaveLength(2);
  });

  it('retains the separately budgeted replanner for explicit Research', async () => {
    let replanCalls = 0;
    let executionCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-research-replan-separate',
      now: fixedClock(),
      planner: {
        plan: ({ request }) => ({
          source: 'llm',
          rationale: 'Explicit Research plan.',
          steps: [{ id: 'step-1', route: 'research', goal: request.question, successCriteria: [] }],
        }),
        replan: () => {
          replanCalls += 1;
          return { decision: 'repair', repairHint: 'Retry the bounded Research step.' };
        },
      },
      executors: {
        research: () => {
          executionCalls += 1;
          return executionCalls === 1
            ? {
                summary: 'Research evidence is incomplete.',
                evaluations: [{
                  id: 'research-evidence',
                  label: 'Research evidence',
                  passed: false,
                  severity: 'warning',
                  message: 'One bounded Research retry is needed.',
                  suggestedRepair: 'Retry the Research step.',
                }],
              }
            : { summary: 'Research evidence complete.', answer: 'Research complete.' };
        },
      },
    });

    const run = await engine.run({ question: 'diagnose revenue risk', requestedMode: 'research' });

    expect(replanCalls).toBe(1);
    expect(executionCalls).toBe(2);
    expect(run.steps[0]).toMatchObject({ route: 'research', attempts: 2, status: 'repaired' });
  });

  it('does not grant an injected planner or replanner authority after an Ask plan is frozen', async () => {
    let plannerCalls = 0;
    let replanCalls = 0;
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-authoritative-plan-boundary',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'answer',
          confidence: 1,
          reason: 'Exact governed semantic binding.',
          followsUp: false,
          resolvedAnalyticalPlan: {
            mode: 'authoritative',
            capability: 'semantic_execution',
            planId: 'resolved-plan:food-revenue',
            fingerprint: 'sha256:food-revenue-plan',
          },
        } as IntentDecision),
      },
      planner: {
        plan: () => {
          plannerCalls += 1;
          throw new Error('injected planner must not run');
        },
        replan: () => {
          replanCalls += 1;
          throw new Error('injected replanner must not run');
        },
      },
      executors: {
        semantic_answer: () => ({
          summary: 'Exact plan execution failed validation.',
          evaluations: [{
            id: 'result-contract',
            label: 'Result contract',
            passed: false,
            severity: 'blocking',
            message: 'The frozen output contract did not validate.',
            suggestedRepair: 'Regenerate the answer.',
          }],
        }),
      },
    });

    const run = await engine.run({ question: 'food revenue', requestedMode: 'ask' }, (event) => events.push(event));

    expect(plannerCalls).toBe(0);
    expect(replanCalls).toBe(0);
    expect(run.route).toBe('semantic_answer');
    expect(run.steps[0]).toMatchObject({ attempts: 1, status: 'blocked' });
    expect(events.map((event) => event.type)).not.toContain('replan.decided');
    expect(events.map((event) => event.type)).not.toContain('repair.attempted');
    const routeEvent = events.find((event) => event.type === 'route.decided');
    expect(routeEvent?.payload).not.toHaveProperty('resolvedPlanShadow');
  });

  it('preserves a router-frozen bare-ranking certified block without a second meaning selection or generated downgrade', async () => {
    const store = new InMemoryAgentRunStore();
    let certifiedCalls = 0;
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      store,
      idGenerator: () => 'run-frozen-top-customers',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'answer', confidence: 1, followsUp: false, source: 'heuristic',
          reason: 'The certified top_customers block completely covers bare ranking.',
          meaningResolution: {
            interpretedQuestion: 'who are the top customers', questionType: 'ranking',
            selectedConceptIds: ['dql:block:top_customers'],
            recommendedExecutionId: 'dql:block:top_customers',
            queryIntent: { measures: [], dimensions: ['customer_name'], filters: [] },
            rejectedCandidates: [], confidence: 'high', missingInformation: [], recommendedRoute: 'certified',
          },
          resolvedAnalyticalPlan: {
            mode: 'authoritative', capability: 'certified_execution',
            planId: 'rap:top-customers', fingerprint: 'sha256:top-customers',
          },
          analyticalCascadeDecision: {
            version: 1,
            requirements: { version: 1, measures: [], dimensions: ['customer_name'], entityTerms: ['customer'], entityDisplayTerms: ['customer_name'], memberTerms: [] },
            sourceCoverage: [{ version: 1, source: 'certified', status: 'available', candidateIds: ['dql:block:top_customers'] }],
            attempts: [{ version: 1, tier: 'certified', outcome: 'executable', candidateIds: ['dql:block:top_customers'], reason: 'The block owns the requested ranking outputs.', planFrozen: true }],
            selectedTier: 'certified', planFrozen: true, stopReason: 'selected',
          },
        } as IntentDecision),
      },
      executors: {
        certified_answer: ({ routeDecision }) => {
          certifiedCalls += 1;
          expect(routeDecision?.meaningResolution?.selectedConceptIds).toEqual(['dql:block:top_customers']);
          return {
            resolvedRoute: 'certified_answer',
            answerTier: 'certified_block',
            answer: 'Top customers from the certified block.',
            status: 'completed', trustState: 'certified', stopReason: 'certified_answer_found',
            artifacts: [{ id: 'answer:top-customers', kind: 'answer', title: 'Certified top customers', ref: 'top_customers', trustState: 'certified', payload: { selectedConceptIds: ['dql:block:top_customers'] } }],
          };
        },
        generated_answer: () => { generatedCalls += 1; return { answer: 'must not run' }; },
      },
    });

    const run = await engine.run({ question: 'who are the top customers', requestedMode: 'ask' });

    expect(certifiedCalls).toBe(1);
    expect(generatedCalls).toBe(0);
    expect(run).toMatchObject({ route: 'certified_answer', trustState: 'certified', stopReason: 'certified_answer_found' });
    expect(run.routeDecision?.meaningResolution?.selectedConceptIds).toEqual(['dql:block:top_customers']);
    expect(store.get(run.id)).toMatchObject({
      route: 'certified_answer', trustState: 'certified',
      routeDecision: { meaningResolution: { selectedConceptIds: ['dql:block:top_customers'] } },
    });
  });

  it('persists a router-issued relationship gap witness without broadening generic route state', async () => {
    const store = new InMemoryAgentRunStore();
    const engine = new AgentRunEngine({
      store,
      idGenerator: () => 'run-persisted-relationship-gap',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'block', confidence: 1, followsUp: false, source: 'heuristic',
          reason: 'The snapshot lacks a certified, validated, fanout-safe relationship closure.',
          terminalOutcome: {
            kind: 'modeling_gap', code: 'ANALYTICAL_MODELING_GAP',
            message: 'No safe relationship closure exists.',
            candidateIds: ['dbt:model:customers', 'dbt:model:order_items'],
            gap: {
              code: 'MISSING_RELATIONSHIP',
              missing: ['a certified, validated, fanout-safe relationship proof'],
              witnessCandidateIds: ['dbt:model:customers', 'dbt:model:order_items'],
            },
          },
        } as IntentDecision),
      },
    });

    const run = await engine.run({ question: 'which customers bought perishable products?', requestedMode: 'ask' });

    expect(run).toMatchObject({ route: 'blocked', status: 'blocked', trustState: 'blocked' });
    expect(run.routeDecision?.terminalOutcome?.gap).toEqual({
      code: 'MISSING_RELATIONSHIP',
      missing: ['a certified, validated, fanout-safe relationship proof'],
      witnessCandidateIds: ['dbt:model:customers', 'dbt:model:order_items'],
    });
    expect(store.get(run.id)?.routeDecision?.terminalOutcome?.gap?.code).toBe('MISSING_RELATIONSHIP');
  });

  it('fails a frozen tier in place when an executor reports a different route', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-frozen-route-mismatch',
      now: fixedClock(),
      router: { decide: () => authoritativeDecision('certified_execution') },
      executors: {
        certified_answer: () => ({
          resolvedRoute: 'generated_answer',
          answer: 'Generated fallback must not escape this frozen certified plan.',
          status: 'needs_review', trustState: 'review_required',
        }),
      },
    });

    const run = await engine.run({ question: 'top customers', requestedMode: 'ask' });

    expect(run).toMatchObject({ route: 'certified_answer', status: 'blocked', trustState: 'blocked' });
    expect(run.evaluations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'frozen-plan-route-mismatch', passed: false }),
    ]));
  });

  it("routes a confident certified match to a completed certified answer run", async () => {
    const store = new InMemoryAgentRunStore();
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      store,
      idGenerator: () => "run-certified",
      now: fixedClock(),
      planner: fixedRoutePlanner("certified_answer"),
      executors: {
        certified_answer: () => ({
          answer: "Revenue is $2.8M.",
          evaluations: [{
            id: "certified-execution",
            label: "Certified execution",
            passed: true,
            severity: "info",
            message: "Executed certified block revenue_total.",
          }],
        }),
      },
    });

    const run = await engine.run({
      question: "what is total revenue?",
      intent: "exact_certified_lookup",
      executionTarget: { target: "connection", connectionName: "reporting" },
    }, (event) => events.push(event));

    expect(run).toMatchObject({
      id: "run-certified",
      route: "certified_answer",
      status: "completed",
      trustState: "certified",
      stopReason: "certified_answer_found",
      answer: "Revenue is $2.8M.",
      executionTarget: { target: "connection", connectionName: "reporting" },
    });
    expect(run.artifacts[0]).toMatchObject({ kind: "answer", trustState: "certified" });
    expect(run.lifecycle).toMatchObject({ state: "terminal", phase: "run.completed" });
    expect(run.diagnosticReceipt).toMatchObject({
      version: 1,
      runId: "run-certified",
      route: "certified_answer",
    });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "plan.created",
      "step.started",
      "route.decided",
      "executor.started",
      "evaluation.recorded",
      "artifact.created",
      "step.completed",
      "run.completed",
    ]);
    expect(store.get("run-certified")).toMatchObject({
      route: "certified_answer",
      executionTarget: { target: "connection", connectionName: "reporting" },
    });
  });

  it.each([
    ['success', {
      version: 1, mode: 'verified_facts', outcome: 'success', attempted: true,
      factCount: 2, maxRows: 10, validationFailures: [],
    }],
    ['deterministic fallback', {
      version: 1, mode: 'verified_facts', outcome: 'deterministic_fallback', attempted: true,
      factCount: 2, maxRows: 10, validationFailures: ['UNPARSEABLE_CLAIMS'],
    }],
    ['intentional skip', {
      version: 1, mode: 'skip', outcome: 'skipped', attempted: false,
      factCount: 0, maxRows: 0, validationFailures: [], skipReason: 'no_provider',
    }],
  ] as const)('persists narration integrity receipt for %s through the durable run store', async (_name, receipt) => {
    const store = new InMemoryAgentRunStore();
    const engine = new AgentRunEngine({
      store,
      idGenerator: () => `run-narration-${receipt.outcome}`,
      now: fixedClock(),
      planner: fixedRoutePlanner('certified_answer'),
      executors: {
        certified_answer: () => ({
          answer: 'Answer retained independently of narration presentation.',
          narrationIntegrityReceipt: receipt,
        }),
      },
    });
    const run = await engine.run({ question: 'total revenue', intent: 'exact_certified_lookup' });
    expect(run.narrationIntegrityReceipt).toEqual(receipt);
    expect(store.get(run.id)?.narrationIntegrityReceipt).toEqual(receipt);
  });

  it("API-007 records blocked outcomes as run.failed with the precise failure class", async () => {
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-provider-failed",
      now: fixedClock(),
      planner: fixedRoutePlanner("generated_answer"),
      executors: {
        generated_answer: () => ({
          status: "blocked",
          trustState: "blocked",
          stopReason: "blocked",
          summary: "The configured AI provider is unavailable.",
          artifacts: [{
            id: "provider-failure",
            kind: "answer",
            title: "AI answer provider failed",
            trustState: "blocked",
            payload: { providerFailure: { code: "AI_PROVIDER_FAILURE" } },
          }],
          evaluations: [{
            id: "ai-provider",
            label: "AI provider",
            passed: false,
            severity: "blocking",
            message: "The configured AI provider is unavailable.",
          }],
          nextActions: [{ id: "retry-after-provider", label: "Retry", route: "generated_answer" }],
        }),
      },
    });

    const run = await engine.run({
      question: "Who are the top customers for BCM?",
      intent: "ad_hoc_ranking",
    }, (event) => events.push(event));

    expect(run.lifecycle).toMatchObject({ state: "terminal", phase: "run.failed" });
    expect(run.diagnosticReceipt?.failure).toMatchObject({
      code: "AI_PROVIDER_FAILURE",
      phase: "run.failed",
    });
    expect(events.at(-1)?.type).toBe("run.failed");
  });

  it("treats a compiler-owned semantic answer as terminal governed output", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-semantic-route",
      now: fixedClock(),
      planner: fixedRoutePlanner("semantic_answer"),
      executors: {
        semantic_answer: () => ({
          answer: "Revenue was $2.8M by region.",
          answerTier: "semantic_metric",
        }),
      },
    });

    const run = await engine.run({ question: "revenue by region" }, () => {});
    expect(run).toMatchObject({
      route: "semantic_answer",
      status: "completed",
      trustState: "governed",
      stopReason: "governed_semantic_answer",
    });
    expect(run.artifacts[0]).toMatchObject({ title: "Answer from Metrics", trustState: "governed" });
  });

  it("escalates a shape-failed certified answer to generated_answer", async () => {
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-certified-shape-repair",
      now: fixedClock(),
      planner: fixedRoutePlanner("certified_answer"),
      gates: defaultAgentRunGates,
      executors: {
        certified_answer: () => ({
          answer: "Food and drink revenue.",
          artifacts: [{
            id: "certified",
            kind: "answer",
            title: "Certified answer",
            trustState: "certified",
            payload: {
              answer: "Food and drink revenue.",
              result: {
                columns: ["category", "revenue"],
                rows: [{ category: "Food", revenue: 10 }],
                rowCount: 1,
              },
            },
          }],
        }),
        generated_answer: () => ({
          answer: "Product revenue.",
          artifacts: [{
            id: "generated",
            kind: "answer",
            title: "Generated answer",
            trustState: "review_required",
            payload: {
              answer: "Product revenue.",
              result: {
                columns: ["product_name", "category", "revenue"],
                rows: [{ product_name: "Classic Jaffle", category: "Food", revenue: 10 }],
                rowCount: 1,
              },
            },
          }],
        }),
      },
    });

    const run = await engine.run({
      question: "show revenue by product with product name, category, and revenue",
      intent: "exact_certified_lookup",
    }, (event) => events.push(event));

    expect(run.route).toBe("generated_answer");
    expect(run.repairAttempts).toBe(0);
    expect(run.escalationAttempts).toBe(1);
    expect(run.budgetUsage?.usage).toMatchObject({
      laneExecutionAttemptsUsed: 0,
      engineEscalationsUsed: 1,
    });
    expect(run.steps.map((step) => step.route)).toEqual(["certified_answer", "generated_answer"]);
    expect(run.steps[0]?.evaluations.some((evaluation) => evaluation.id === "answer-shape" && !evaluation.passed)).toBe(true);
    expect(events.some((event) =>
      event.type === "escalated"
      && Boolean(event.payload)
      && (event.payload as { route?: string }).route === "generated_answer"
    )).toBe(true);
  });

  it("keeps a model_declined Ask terminal after its bounded in-lane repair", async () => {
    const events: AgentRunEvent[] = [];
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-declined-escalate",
      now: fixedClock(),
      planner: fixedRoutePlanner("generated_answer"),
      gates: defaultAgentRunGates,
      executors: {
        // Mirrors the real local-runtime answer executor: the answer loop already
        // spent its repair, so this is inspectable but not actionable by the engine.
        generated_answer: () => {
          generatedCalls += 1;
          return {
            answer: "I could not compose a governed query for this from the available tables and metrics.",
            answerRefusalCode: "model_declined",
            status: "needs_review",
            artifacts: [],
            evaluations: [{
              id: "declined-despite-context",
              label: "Answer grounding",
              passed: false,
              severity: "warning",
              message: "Declined despite context.",
            }],
          };
        },
        research: () => ({
          answer: "Investigated the join path across orders, products, and locations and composed a review-required query.",
          artifacts: [{
            id: "research",
            kind: "answer",
            title: "Research",
            trustState: "review_required",
            payload: { answer: "Investigated and composed a review-required query." },
          }],
        }),
      },
    });

    const run = await engine.run({
      question: "average tax by location by product",
      intent: "ad_hoc_analysis",
    }, (event) => events.push(event));

    expect(generatedCalls).toBe(1);
    expect(run.escalationAttempts).toBe(0);
    expect(run.steps.map((step) => step.route)).toEqual(["generated_answer"]);
    expect(run.stopReason).not.toBe("needs_clarification");
    expect(events.some((event) => event.type === "escalated")).toBe(false);
  });

  it("opens research as review-required durable work for investigate requests", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-research", now: fixedClock() });
    const run = await engine.run({
      question: "why is revenue down by segment?",
      intent: "diagnose_change",
      requestedMode: "research",
      signals: { certifiedScore: 0.8, hasRetrieval: true },
    });

    expect(run.route).toBe("research");
    expect(run.status).toBe("needs_review");
    expect(run.trustState).toBe("review_required");
    expect(run.artifacts).toEqual([
      expect.objectContaining({ kind: "research_run", trustState: "review_required" }),
    ]);
    expect(run.nextActions.map((action) => action.id)).toEqual(["create-block", "insert-sql"]);
    expect(run.nextActions[0]).toMatchObject({ label: "Review DQL draft" });
  });

  it("fails closed ordinary generated answers while preserving explicit SQL-cell authoring", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-generated", now: fixedClock() });

    const generated = await engine.run({
      question: "show customer orders",
      intent: "ad_hoc_ranking",
      signals: { metricScore: 0.7, certifiedScore: 0.1, hasRetrieval: true },
    });
    const sqlCell = await engine.run({
      question: "create a SQL notebook cell for customer orders",
      intent: "ad_hoc_ranking",
      signals: { metricScore: 0.7, hasRetrieval: true },
    });

    expect(generated.route).toBe("blocked");
    expect(generated.status).toBe("blocked");
    expect(generated.trustState).toBe("blocked");
    expect(sqlCell.route).toBe("sql_cell");
    expect(sqlCell.artifacts[0]?.kind).toBe("sql_cell");
    expect(sqlCell.stopReason).toBe("artifact_created");
  });

  it("does not let a generated executor self-promote an analytical Ask without a RAP", async () => {
    let executorCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-resolved-certified",
      now: fixedClock(),
      executors: {
        generated_answer: () => {
          executorCalls += 1;
          return {
            resolvedRoute: "certified_answer",
            summary: "Answered from certified block revenue_total.",
            answer: "Revenue is $2.8M.",
            status: "completed",
            trustState: "certified",
            stopReason: "certified_answer_found",
            artifacts: [{
              id: "answer:certified",
              kind: "answer",
              title: "Certified answer",
              trustState: "certified",
              payload: { route: { tier: "certified_block", ref: "revenue_total" } },
            }],
          };
        },
      },
    });

    const run = await engine.run({ question: "what is total revenue?", requestedMode: "ask" });

    expect(executorCalls).toBe(0);
    expect(run.route).toBe("blocked");
    expect(run.status).toBe("blocked");
    expect(run.trustState).toBe("blocked");
    expect(run.steps[0]?.route).toBe("blocked");
  });

  it("routes block and app requests to their durable artifact surfaces", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-artifact", now: fixedClock() });

    const block = await engine.run({
      question: "turn this reviewed SQL into a DQL block draft",
      intent: "ad_hoc_ranking",
      signals: { hasRetrieval: true },
    });
    const app = await engine.run({
      question: "build a COO revenue app",
      intent: "ad_hoc_ranking",
      signals: { certifiedScore: 0.9, hasRetrieval: true },
    });

    expect(block).toMatchObject({
      route: "dql_block_draft",
      status: "needs_review",
      trustState: "review_required",
    });
    expect(block.artifacts[0]?.kind).toBe("dql_block_draft");
    expect(app.route).toBe("app_build");
    expect(app.artifacts[0]?.kind).toBe("app_draft");
  });

  it("blocks when a blocking evaluator fails", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-blocked",
      now: fixedClock(),
      executors: {
        sql_cell: () => ({
          evaluations: [{
            id: "sql-safety",
            label: "SQL safety",
            passed: false,
            severity: "blocking",
            message: "Only read-only SELECT/WITH SQL is allowed.",
          }],
        }),
      },
    });

    const run = await engine.run({
      question: "create sql to delete bad rows",
      requestedMode: "sql",
      intent: "ad_hoc_ranking",
    });

    expect(run.status).toBe("blocked");
    expect(run.trustState).toBe("blocked");
    expect(run.stopReason).toBe("blocked");
    expect(run.artifacts).toHaveLength(1);
    expect(run).toMatchObject({
      diagnosticReceipt: {
        failure: { code: "EXECUTION_BLOCKED" },
      },
    });
  });

  it('discards executor answer prose when a blocking result-contract evaluation fails', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-invalid-result-discarded',
      now: fixedClock(),
      router: { decide: () => authoritativeDecision('semantic_execution') },
      planner: fixedRoutePlanner('semantic_answer'),
      executors: {
        semantic_answer: () => ({
          answer: 'INVALID_RESULT_MUST_DISCARD',
          summary: 'INVALID_SUMMARY_MUST_DISCARD',
          evaluations: [{
            id: 'result-contract',
            label: 'Result contract',
            passed: false,
            severity: 'blocking',
            message: 'The semantic result did not satisfy the frozen output contract.',
          }],
          artifacts: [{
            id: 'invalid-result-diagnostic',
            kind: 'answer',
            title: 'Invalid result diagnostic',
            trustState: 'blocked',
            payload: { result: { rows: [{ secret: 'INVALID_ROW' }] } },
          }],
        }),
      },
    });

    const run = await engine.run({ question: 'food revenue percentage', requestedMode: 'ask' });

    expect(run).toMatchObject({
      status: 'blocked',
      trustState: 'blocked',
      summary: 'The semantic result did not satisfy the frozen output contract.',
      answer: 'The semantic result did not satisfy the frozen output contract.',
    });
    expect(JSON.stringify({ answer: run.answer, summary: run.summary })).not.toContain('INVALID_');
    expect(run.artifacts).toEqual([expect.objectContaining({ id: 'invalid-result-diagnostic' })]);
  });

  it("API-007 retains only explicitly blocked diagnostic artifacts on terminal runs", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-blocked-diagnostic",
      now: fixedClock(),
      router: { decide: () => authoritativeDecision('bounded_exploration') },
      executors: {
        generated_answer: () => ({
          status: "blocked",
          trustState: "blocked",
          stopReason: "blocked",
          artifacts: [
            { id: "failure", kind: "answer", title: "Failed analytical run", trustState: "blocked", payload: { code: "PERMISSION_DENIED" } },
            { id: "unsafe", kind: "sql_cell", title: "Untrusted SQL", trustState: "review_required", payload: { sql: "select 1" } },
          ],
        }),
      },
    });

    const run = await engine.run({ question: "revenue today", requestedMode: "ask" });

    expect(run.status).toBe("blocked");
    expect(run.artifacts).toEqual([
      expect.objectContaining({ id: "failure", trustState: "blocked" }),
    ]);
  });

  it("returns a blocked run instead of throwing when an executor fails", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-error",
      now: fixedClock(),
      executors: {
        research: () => {
          throw new Error("warehouse unavailable");
        },
      },
    });

    const run = await engine.run({
      question: "research churn drivers",
      requestedMode: "research",
      intent: "diagnose_change",
    });

    expect(run.route).toBe("blocked");
    expect(run.status).toBe("blocked");
    expect(run.evaluations[0]).toMatchObject({
      id: "executor-error",
      severity: "blocking",
      message: "warehouse unavailable",
    });
    expect(run.events.at(-1)?.type).toBe("run.failed");
    expect(run.diagnosticReceipt).toMatchObject({
      failure: {
        code: "EXECUTOR_FAILURE",
        phase: "executor.started",
        recoverable: true,
      },
    });
    // A run without an artifact still gets one blocked diagnostic artifact to
    // render its failure; the receipt itself lives on the run root only.
    expect(run.artifacts[0]).toMatchObject({ kind: "answer", trustState: "blocked", payload: { diagnostic: true } });
  });

  it("persists a bounded timeout even when it occurs during retrieval-first routing", async () => {
    const store = new InMemoryAgentRunStore();
    const controller = new AbortController();
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const engine = new AgentRunEngine({
      idGenerator: () => "run-routing-timeout",
      now: fixedClock(),
      store,
      router: {
        decide: async () => {
          throw controller.signal.reason;
        },
      },
    });

    const run = await engine.run({
      question: "top products by revenue",
      requestedMode: "ask",
      signal: controller.signal,
    });

    expect(run).toMatchObject({
      id: "run-routing-timeout",
      route: "blocked",
      status: "blocked",
      stopReason: "blocked",
    });
    expect(run.summary).toContain("reached its time limit");
    expect(run.summary).toContain("does not prove a cross-model join");
    expect(run.events.at(-1)?.type).toBe("run.failed");
    expect(store.get("run-routing-timeout")?.summary).toContain("reached its time limit");
  });

  it('classifies an explicit Research root deadline without directing the user to start Research again', async () => {
    const store = new InMemoryAgentRunStore();
    const controller = new AbortController();
    controller.abort(new DOMException('The Research deadline elapsed.', 'TimeoutError'));
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-research-root-timeout',
      now: fixedClock(),
      store,
      router: {
        decide: async () => {
          throw controller.signal.reason;
        },
      },
    });

    const run = await engine.run({
      question: 'Research revenue by product category and locations',
      requestedMode: 'research',
      signal: controller.signal,
    });

    expect(run.summary).toContain('Research run reached its bounded deadline');
    expect(run.summary).not.toContain('use Research');
    expect(run.diagnosticReceipt?.failure).toMatchObject({
      code: 'RESEARCH_RUN_DEADLINE',
      phase: 'research.run',
      safeActions: ['inspect_failure'],
    });
    expect(run.diagnosticReceiptV4?.terminalIncident).toEqual(expect.objectContaining({
      code: 'RESEARCH_RUN_DEADLINE',
      boundary: 'run',
      safeAction: 'inspect_failure',
    }));
  });

  it('surfaces an all-branch bounded Research outcome as one stored V4 incident with a narrower-Research recovery action', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-research-branch-timeout',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'investigate',
          confidence: 1,
          followsUp: false,
          reason: 'The user explicitly requested Research.',
        }),
      },
      executors: {
        research: () => ({
          status: 'needs_review',
          trustState: 'review_required',
          stopReason: 'human_review_required',
          answer: 'Limited Research: every admitted branch reached its bounded window before producing a receipt-backed finding.',
          artifacts: [{
            id: 'research-timeouts',
            kind: 'research_run',
            title: 'Limited Research',
            trustState: 'review_required',
            payload: {
              researchBranchReceipts: [
                { version: 1, branchId: 'h1', childRunId: 'h1', index: 1, state: 'timed_out', verdict: 'failed', stopReason: 'research_branch_timeout' },
                { version: 1, branchId: 'h2', childRunId: 'h2', index: 2, state: 'skipped', verdict: 'skipped', stopReason: 'budget_exhausted' },
              ],
            },
          }],
        }),
      },
    });

    const run = await engine.run({
      question: 'Research revenue by product category, locations, and customer concentration.',
      requestedMode: 'research',
    });

    expect(run).toMatchObject({ route: 'research', status: 'needs_review', trustState: 'review_required' });
    expect(run.diagnosticReceiptV4?.summary).toMatchObject({
      terminalIncident: {
        code: 'RESEARCH_BRANCH_TIMEOUT',
        boundary: 'run',
        origin: 'governance_gate',
        impact: 'answer_not_produced',
        safeAction: 'inspect_research_failures',
      },
      safeNextAction: 'inspect_research_failures',
    });
    expect(run.diagnosticReceiptV4?.terminalIncident).toEqual(run.diagnosticReceiptV4?.summary.terminalIncident);
    expect(run.diagnosticReceiptV4?.summary.researchBranchSummary).toMatchObject({
      partialSuccess: false,
      timedOutBranches: 1,
      skippedBranches: 1,
    });
  });

  it('keeps a receipt-backed partial Research answer successful while storing child limitations, evidence, and a branch recovery action', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-research-partial-success',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'investigate',
          confidence: 1,
          followsUp: false,
          reason: 'The user explicitly requested Research.',
        }),
      },
      executors: {
        research: () => ({
          status: 'needs_review',
          trustState: 'review_required',
          stopReason: 'human_review_required',
          answer: 'One receipt-backed Research observation is available; the remaining branches are limited.',
          artifacts: [{
            id: 'research-partial-success',
            kind: 'research_run',
            title: 'Partial Research',
            trustState: 'review_required',
            payload: {
              researchBranchReceipts: [
                { version: 1, branchId: 'h1', childRunId: 'child-1', index: 1, state: 'completed', verdict: 'inconclusive', stopReason: 'completed' },
                { version: 1, branchId: 'h2', childRunId: 'child-2', index: 2, state: 'failed', verdict: 'failed', stopReason: 'execution_failed' },
                { version: 1, branchId: 'h3', childRunId: 'child-3', index: 3, state: 'failed', verdict: 'failed', stopReason: 'execution_failed' },
                { version: 1, branchId: 'h4', childRunId: 'child-4', index: 4, state: 'failed', verdict: 'failed', stopReason: 'execution_failed' },
                { version: 1, branchId: 'h5', childRunId: 'child-5', index: 5, state: 'failed', verdict: 'failed', stopReason: 'execution_failed' },
              ],
              researchLedgerV2: {
                entries: [{ id: 'child-1', branchId: 'h1', status: 'observed', receipts: ['a'.repeat(64)] }],
              },
              researchRuns: [
                {
                  id: 'child-1',
                  routeDecision: {
                    retrievalEvidence: {
                      candidateTraceMetadata: [
                        { role: 'metric' },
                        { role: 'categorical_dimension' },
                      ],
                    },
                  },
                  context: {
                    branchAuthority: {
                      selectedTier: 'semantic',
                      planFrozen: true,
                      planId: 'rap:child-1',
                      planFingerprint: 'sha256:child-1',
                    },
                  },
                },
              ],
            },
          }],
        }),
      },
    });

    const run = await engine.run({
      question: 'Research revenue by product category, compare locations, and identify top customers.',
      requestedMode: 'research',
    });

    expect(run).toMatchObject({ route: 'research', status: 'needs_review', trustState: 'review_required' });
    expect(run.diagnosticReceiptV4?.terminalIncident).toBeUndefined();
    expect(run.diagnosticReceiptV4?.summary).toMatchObject({
      safeNextAction: 'inspect_research_failures',
      researchBranchSummary: {
        totalBranches: 5,
        completedBranches: 1,
        receiptBackedBranches: 1,
        failedBranches: 4,
        timedOutBranches: 0,
        skippedBranches: 0,
        partialSuccess: true,
        failureReasons: [{ code: 'execution_failed', branchCount: 4 }],
        availableChildPlans: [{ tier: 'semantic', frozenPlanCount: 1, branchCount: 1, reviewRequired: false }],
        linkedChildRunCount: 5,
        safeAction: 'inspect_research_failures',
      },
    });
    expect(run.diagnosticReceiptV4?.summary.evidenceByRole).toEqual(expect.arrayContaining([
      { role: 'metric', candidateCount: 1 },
      { role: 'categorical_dimension', candidateCount: 1 },
    ]));
  });

  it("persists runs to a project-local file store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dql-agent-run-store-"));
    try {
      const path = defaultAgentRunStorePath(dir);
      const store = new FileAgentRunStore({ path });
      const engine = new AgentRunEngine({
        store,
        idGenerator: () => "run-file-store",
        now: fixedClock(),
      });

      const run = await engine.run({
        question: "create a SQL cell for revenue",
        requestedMode: "sql",
      });
      const reloaded = new FileAgentRunStore({ path });

      expect(reloaded.get(run.id)?.route).toBe("sql_cell");
      expect(reloaded.list().map((item) => item.id)).toEqual(["run-file-store"]);
      expect(readFileSync(path, "utf-8")).toContain('"version": 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AgentRunEngine loop (plan → build → evaluate → modify)", () => {
  it("repairs a failing gate and accepts the repaired result", async () => {
    const events: AgentRunEvent[] = [];
    let calls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-repair",
      now: fixedClock(),
      gates: defaultAgentRunGates,
      executors: {
        sql_cell: () => {
          calls += 1;
          // First build has no SQL (gate fails → retry); the repair produces SQL.
          const payload = calls === 1 ? {} : { sql: "select 1" };
          return { artifacts: [{ id: `sql:${calls}`, kind: "sql_cell", title: "Cell", trustState: "review_required", payload }] };
        },
      },
    });

    const run = await engine.run({ question: "create a sql cell", requestedMode: "sql" }, (event) => events.push(event));

    expect(calls).toBe(2);
    expect(run.route).toBe("sql_cell");
    expect(run.status).toBe("needs_review");
    expect(run.repairAttempts).toBe(1);
    expect(run.escalationAttempts).toBe(0);
    expect(run.budgetUsage?.usage).toMatchObject({
      laneExecutionAttemptsUsed: 1,
      engineEscalationsUsed: 0,
    });
    expect(run.steps[0]?.attempts).toBe(2);
    expect(run.steps[0]?.status).toBe("repaired");
    expect(events.map((event) => event.type)).toContain("repair.attempted");
  });

  it("prefers machine-facing repairAction hints over planner prose during retry", async () => {
    const events: AgentRunEvent[] = [];
    const seenRepairHints: Array<string | undefined> = [];
    let calls = 0;
    const planner: AgentRunPlanner = {
      plan: ({ request }) => ({
        source: "deterministic",
        rationale: "Test plan",
        steps: [{
          id: "step-1",
          route: "generated_answer",
          goal: request.question,
          successCriteria: [],
        }],
      }),
      replan: () => ({
        decision: "repair",
        repairHint: "planner returned broad prose",
      }),
    };
    const engine = new AgentRunEngine({
      idGenerator: () => "run-machine-repair-hint",
      now: fixedClock(),
      planner,
      executors: {
        generated_answer: ({ repairHint }) => {
          calls += 1;
          seenRepairHints.push(repairHint);
          if (calls === 1) {
            return {
              summary: "Grounding gap.",
              evaluations: [{
                id: "grounding-gap",
                label: "Metadata grounding",
                passed: false,
                severity: "warning",
                message: "A metadata relation was missing from the inspected context.",
                suggestedRepair: "Retry with wider metadata context.",
                repairAction: {
                  kind: "retry",
                  hint: "code=unknown_relation; relation=dev.supplies",
                },
              }],
            };
          }
          return {
            summary: "Repaired answer.",
            answer: "Repaired answer.",
            evaluations: [{
              id: "grounding-gap",
              label: "Metadata grounding",
              passed: true,
              severity: "info",
              message: "Context expanded.",
            }],
          };
        },
      },
    });

    const run = await engine.run({ question: "include product supply details", requestedMode: "app" }, (event) => events.push(event));

    expect(run.repairAttempts).toBe(1);
    expect(seenRepairHints).toEqual([undefined, "code=unknown_relation; relation=dev.supplies"]);
    expect(events.find((event) => event.type === "repair.attempted")?.payload).toMatchObject({
      repairHint: "code=unknown_relation; relation=dev.supplies",
    });
  });

  it("short-circuits after a governed semantic answer but continues after a generated answer (R2.3)", async () => {
    const twoStepPlanner: AgentRunPlanner = {
      plan: ({ request }) => ({
        source: "deterministic",
        rationale: "two-step plan",
        steps: [
          { id: "s1", route: "generated_answer", goal: request.question, successCriteria: [] },
          { id: "s2", route: "research", goal: "dig deeper", successCriteria: [] },
        ],
      }),
      replan: () => ({ decision: "accept" }),
    };
    const cleanAnswer = (answerTier: string) => ({
      answerTier,
      status: "completed" as const,
      trustState: "review_required" as const,
      summary: `${answerTier} answer`,
      artifacts: [{ id: "a", kind: "answer" as const, title: "A", trustState: "review_required" as const, payload: {} }],
    });

    // Semantic answer (From Metrics) → research step is skipped.
    let semanticResearch = 0;
    const semanticEngine = new AgentRunEngine({
      idGenerator: () => "run-semantic-terminal",
      now: fixedClock(),
      planner: twoStepPlanner,
      executors: {
        generated_answer: () => cleanAnswer("semantic_metric"),
        research: () => { semanticResearch += 1; return { summary: "research" }; },
      },
    });
    await semanticEngine.run({ question: "revenue by region", requestedMode: "auto" }, () => {});
    expect(semanticResearch).toBe(0);

    // Generated SQL answer (same status) → research step DOES run. The tier, not
    // the route or status, is the discriminator.
    let generatedResearch = 0;
    const generatedEngine = new AgentRunEngine({
      idGenerator: () => "run-generated-continues",
      now: fixedClock(),
      planner: twoStepPlanner,
      executors: {
        generated_answer: () => cleanAnswer("generated_sql"),
        research: () => { generatedResearch += 1; return { summary: "research" }; },
      },
    });
    await generatedEngine.run({ question: "why did margin drop", requestedMode: "auto" }, () => {});
    expect(generatedResearch).toBe(1);
  });

  it("keeps a generated answer with no grounding terminal", async () => {
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-escalate",
      now: fixedClock(),
      router: { decide: () => authoritativeDecision('bounded_exploration') },
      gates: defaultAgentRunGates,
      executors: {
        generated_answer: () => ({ answer: "", artifacts: [] }),
        research: () => ({
          summary: "Grounded research dossier.",
          artifacts: [{ id: "r1", kind: "research_run", title: "Research", trustState: "review_required", payload: {} }],
          evaluations: [{ id: "catalog-grounding", label: "Catalog grounding", passed: true, severity: "info", message: "Grounded." }],
        }),
      },
    });

    const run = await engine.run({
      question: "show me something ungrounded",
      intent: "ad_hoc_ranking",
      signals: { certifiedScore: 0.1, hasRetrieval: true },
    }, (event) => events.push(event));

    expect(run.route).toBe("generated_answer");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.status).toBe("passed");
    expect(run.repairAttempts).toBe(0);
    expect(run.escalationAttempts).toBe(0);
    expect(run.budgetUsage?.usage).toMatchObject({
      laneExecutionAttemptsUsed: 0,
      engineEscalationsUsed: 0,
    });
    expect(events.map((event) => event.type)).not.toContain("escalated");
  });

  it("does not spend the engine escalation budget for a terminal lookup gap", async () => {
    let researchCalls = 0;
    const events: AgentRunEvent[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-escalation-budget",
      now: fixedClock(),
      router: { decide: () => authoritativeDecision('bounded_exploration') },
      maxEngineEscalations: 0,
      gates: defaultAgentRunGates,
      executors: {
        generated_answer: () => ({ answer: "", artifacts: [] }),
        research: () => {
          researchCalls += 1;
          return { summary: "Should not run." };
        },
      },
    });

    const run = await engine.run({
      question: "show me something ungrounded",
      intent: "ad_hoc_ranking",
      signals: { certifiedScore: 0.1, hasRetrieval: true },
    }, (event) => events.push(event));

    expect(researchCalls).toBe(0);
    expect(run.route).toBe("generated_answer");
    expect(run.status).toBe("needs_review");
    expect(run.repairAttempts).toBe(0);
    expect(run.escalationAttempts).toBe(0);
    expect(run.budgetUsage?.limits.engineEscalations).toBe(0);
    expect(events.some((event) => event.type === "escalated")).toBe(false);
  });

  it("repairs one ordinary shape failure without turning it into Research", async () => {
    let generatedCalls = 0;
    let researchCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-shape-bounded",
      now: fixedClock(),
      maxRepairAttempts: 1,
      gates: defaultAgentRunGates,
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return {
            answer: "Customer list without the requested measure.",
            artifacts: [{
              id: `generated:${generatedCalls}`,
              kind: "answer",
              title: "Generated answer",
              trustState: "review_required",
              payload: {
                answer: "Customer list without the requested measure.",
                result: { columns: ["customer_name"], rows: [{ customer_name: "A" }], rowCount: 1 },
              },
            }],
          };
        },
        research: () => {
          researchCalls += 1;
          return { summary: "This must remain explicit." };
        },
      },
    });

    const run = await engine.run({ question: "Who are the top customers by revenue?" });

    expect(generatedCalls).toBe(2);
    expect(researchCalls).toBe(0);
    expect(run.steps.map((step) => step.route)).toEqual(["generated_answer"]);
    expect(run.escalationAttempts).toBe(0);
    expect(run.repairAttempts).toBe(1);
    expect(run.status).toBe("needs_review");
  });

  it("escalates an app build with no certified coverage to a block draft", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-app-escalate",
      now: fixedClock(),
      gates: defaultAgentRunGates,
      executors: {
        app_build: () => ({
          artifacts: [{ id: "a1", kind: "app_draft", title: "App", trustState: "review_required", payload: { session: { status: "needs_coverage" } } }],
        }),
        dql_block_draft: () => ({
          summary: "Drafted the gap block.",
          artifacts: [{ id: "b1", kind: "dql_block_draft", title: "Gap block", trustState: "review_required", payload: { certifierVerdict: { ready: true } } }],
        }),
      },
    });

    const run = await engine.run({ question: "build a revenue dashboard", requestedMode: "app" });

    expect(run.steps[0]?.route).toBe("app_build");
    expect(run.steps[0]?.status).toBe("escalated");
    expect(run.route).toBe("dql_block_draft");
  });

  it("stops repairing once the modify budget is exhausted and finishes review-required", async () => {
    let calls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-budget",
      now: fixedClock(),
      maxRepairAttempts: 1,
      gates: defaultAgentRunGates,
      executors: {
        sql_cell: () => {
          calls += 1;
          return { artifacts: [{ id: `sql:${calls}`, kind: "sql_cell", title: "Cell", trustState: "review_required", payload: {} }] };
        },
      },
    });

    const run = await engine.run({ question: "create a sql cell", requestedMode: "sql" });

    expect(calls).toBe(2); // initial build + one repair, then budget exhausted
    expect(run.repairAttempts).toBe(1);
    expect(run.escalationAttempts).toBe(0);
    expect(run.status).toBe("needs_review");
  });

  it("runs a multi-step plan and aggregates artifacts across steps", async () => {
    const planner: AgentRunPlanner = {
      plan: () => ({
        source: "llm",
        rationale: "Investigate, then draft a governed block.",
        steps: [
          { id: "s1", route: "research", goal: "Investigate drivers", successCriteria: [] },
          { id: "s2", route: "dql_block_draft", goal: "Draft the metric block", successCriteria: [] },
        ],
      }),
      replan: () => ({ decision: "accept" }),
    };
    const executors = {
      research: (): AgentRouteExecutorResult => ({
        summary: "Research done.",
        artifacts: [{ id: "r1", kind: "research_run" as const, title: "Research", trustState: "review_required" as const, payload: {} }],
      }),
      dql_block_draft: (): AgentRouteExecutorResult => ({
        summary: "Draft done.",
        artifacts: [{ id: "b1", kind: "dql_block_draft" as const, title: "Block", trustState: "review_required" as const, payload: { certifierVerdict: { ready: true } } }],
      }),
    };
    const engine = new AgentRunEngine({ idGenerator: () => "run-multi", now: fixedClock(), planner, gates: defaultAgentRunGates, executors });

    const run = await engine.run({ question: "why is revenue down, then make a block" });

    expect(run.plan?.source).toBe("llm");
    expect(run.steps.map((step) => step.route)).toEqual(["research", "dql_block_draft"]);
    expect(run.route).toBe("dql_block_draft");
    expect(run.artifacts.map((artifact) => artifact.kind)).toEqual(["research_run", "dql_block_draft"]);
  });

  it("preserves an earlier step's answer when the final step only drafts an artifact", async () => {
    const planner: AgentRunPlanner = {
      plan: () => ({
        source: "llm",
        rationale: "Answer, then draft a governed block.",
        steps: [
          { id: "s1", route: "generated_answer", goal: "Answer the question", successCriteria: [] },
          { id: "s2", route: "dql_block_draft", goal: "Draft the metric block", successCriteria: [] },
        ],
      }),
      replan: () => ({ decision: "accept" }),
    };
    const executors = {
      generated_answer: (): AgentRouteExecutorResult => ({
        summary: "Answered.",
        answer: "Total revenue is $1.2M across 3 regions.",
        artifacts: [{ id: "a1", kind: "answer" as const, title: "Answer", trustState: "review_required" as const, payload: {} }],
      }),
      dql_block_draft: (): AgentRouteExecutorResult => ({
        summary: "Draft done.",
        // A later step that only drafts an artifact must not drop the earlier answer.
        artifacts: [{ id: "b1", kind: "dql_block_draft" as const, title: "Block", trustState: "review_required" as const, payload: { certifierVerdict: { ready: true } } }],
      }),
    };
    const engine = new AgentRunEngine({ idGenerator: () => "run-preserve", now: fixedClock(), planner, gates: defaultAgentRunGates, executors });

    const run = await engine.run({ question: "what is total revenue, then make a block" });

    expect(run.steps.map((step) => step.route)).toEqual(["generated_answer", "dql_block_draft"]);
    expect(run.answer).toBe("Total revenue is $1.2M across 3 regions.");
  });
});

describe("AgentRunEngine audience", () => {
  it("collapses a stakeholder authoring request to a governed answer + certification handoff", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-sh", now: fixedClock() });
    const run = await engine.run({ question: "create a sql cell for revenue", requestedMode: "sql", audience: "stakeholder" });
    expect(run.route).toBe("generated_answer");
    expect(run.status).toBe("needs_review");
    expect(run.nextActions.some((action) => action.id === "request-certification")).toBe(true);
    expect(run.nextActions.some((action) => action.route === "sql_cell" || action.route === "dql_block_draft")).toBe(false);
  });

  it("keeps authoring routes for an analyst", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-an", now: fixedClock() });
    const run = await engine.run({ question: "create a sql cell for revenue", requestedMode: "sql", audience: "analyst" });
    expect(run.route).toBe("sql_cell");
  });

  it("keeps a stakeholder app-coverage gap in ordinary Ask, not implicit Research", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-sh-app",
      now: fixedClock(),
      gates: defaultAgentRunGates,
      executors: {
        app_build: () => ({
          artifacts: [{ id: "a1", kind: "app_draft", title: "App", trustState: "review_required", payload: { session: { status: "needs_coverage" } } }],
        }),
        research: () => ({
          summary: "Grounded research instead.",
          artifacts: [{ id: "r1", kind: "research_run", title: "Research", trustState: "review_required", payload: {} }],
          evaluations: [{ id: "catalog-grounding", label: "Catalog grounding", passed: true, severity: "info", message: "Grounded." }],
        }),
      },
    });
    const run = await engine.run({ question: "build a revenue dashboard", requestedMode: "app", audience: "stakeholder" });
    expect(run.steps[0]?.route).toBe("app_build");
    expect(run.steps[0]?.status).toBe("escalated");
    expect(run.route).toBe("generated_answer");
  });

  it("answers anyway for a stakeholder instead of dead-ending on clarify", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-anyway", now: fixedClock() });
    const run = await engine.run({ question: "what is total revenue?", intent: "ad_hoc_ranking", audience: "stakeholder" });
    expect(run.route).toBe("generated_answer");
  });

  it("still clarifies for a stakeholder when the catalog flags missing context", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-missing", now: fixedClock() });
    const run = await engine.run({
      question: "show me the thing",
      intent: "ad_hoc_ranking",
      audience: "stakeholder",
      signals: { missingContext: ["Which measure should I use?"] },
    });
    expect(run.route).toBe("clarify");
  });

  it("answers anyway for an analyst soft clarify (nothing governed matched) instead of dead-ending", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-analyst-anyway", now: fixedClock() });
    const run = await engine.run({ question: "what is total revenue?", intent: "ad_hoc_ranking", audience: "analyst" });
    expect(run.route).toBe("generated_answer");
  });

  it("lets the governed answer loop handle a router-only clarification for an analyst", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-router-anyway",
      now: fixedClock(),
      router: {
        decide: () => ({
          action: "clarify",
          confidence: 0.82,
          reason: "The ranking could be interpreted in more than one way.",
          clarifyingQuestion: "Rank by spend or by product variety?",
          followsUp: false,
        }),
      },
      executors: {
        generated_answer: () => ({ answer: "Melissa leads by beverage spend and product variety." }),
      },
    });

    const run = await engine.run({
      question: "Who are the top customers buying different beverage products?",
      intent: "ad_hoc_ranking",
      audience: "analyst",
    });

    expect(run.route).toBe("generated_answer");
    expect(run.status).not.toBe("needs_clarification");
    expect(run.answer).toContain("Melissa");
  });

  it("keeps a genuine analyst clarify (explicit missing context) as clarify", async () => {
    const engine = new AgentRunEngine({ idGenerator: () => "run-analyst-missing", now: fixedClock() });
    const run = await engine.run({
      question: "show me the thing",
      intent: "ad_hoc_ranking",
      audience: "analyst",
      signals: { missingContext: ["Which measure should I use?"] },
    });
    expect(run.route).toBe("clarify");
  });

  it("strips analyst next-actions from a stakeholder run", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-sh-na",
      now: fixedClock(),
      executors: {
        research: () => ({
          summary: "Research.",
          status: "needs_review",
          artifacts: [{ id: "r1", kind: "research_run", title: "Research", trustState: "review_required", payload: {} }],
          nextActions: [
            { id: "create-block", label: "Create DQL draft", route: "dql_block_draft", artifactKind: "dql_block_draft" },
            { id: "drill", label: "Drill down", route: "research" },
          ],
        }),
      },
    });
    const run = await engine.run({ question: "why is revenue down?", requestedMode: "research", audience: "stakeholder" });
    expect(run.nextActions.some((action) => action.id === "create-block")).toBe(false);
    expect(run.nextActions.some((action) => action.id === "drill")).toBe(true);
    expect(run.nextActions.some((action) => action.id === "request-certification")).toBe(true);
  });
});

describe("clarification continuations — Ask surface", () => {
  /**
   * The reported clarify loop. On the Ask surface a clarification persists the
   * RESOLVED analytical route (`generated_answer`) with
   * `runStatus: 'needs_clarification'`, and thread runs clear `history`. The
   * engine's only lookup matched `route === 'clarify'`, so it never found the
   * pending clarification: the reply ran context-free and was clarified again.
   *
   * `buildConversationSnapshot` publishes `pendingClarification` correctly —
   * nothing consumed it. Now the engine reads it first.
   */
  function askSurfaceContext(overrides: Record<string, unknown> = {}) {
    return {
      conversationContext: {
        conversationEnvelope: {
          threadId: "thr_1",
          recentTurns: [{
            id: "trn_1",
            question: "What is total revenue?",
            answerSummary: "Do you mean gross or net revenue?",
            // The route the run WOULD have taken — not 'clarify'.
            route: "generated_answer",
            runStatus: "needs_clarification",
          }],
          pendingClarification: {
            sourceTurnId: "trn_1",
            question: "Do you mean gross or net revenue?",
            sourceQuestion: "What is total revenue?",
          },
          ...overrides,
        },
      },
    };
  }

  it("recovers the original question from the envelope when the route is not 'clarify'", () => {
    // `history` is empty — thread runs clear it — so the envelope is the ONLY
    // source. Before this, the turn scan required `route === 'clarify'` and
    // found nothing, so the reply ran as a bare context-free word.
    const continuation = resolveClarificationContinuation({
      question: "net",
      history: [],
      ...askSurfaceContext(),
    });

    expect(continuation).toBeDefined();
    expect(continuation!.sourceQuestion).toBe("What is total revenue?");
    expect(continuation!.clarifyingQuestion).toBe("Do you mean gross or net revenue?");
    expect(continuation!.resolvedQuestion).toContain("What is total revenue?");
    expect(continuation!.resolvedQuestion).toContain("net");
  });

  it("still works from a legacy envelope carrying only serverSnapshot", () => {
    const continuation = resolveClarificationContinuation({
      question: "net",
      history: [],
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "What is total revenue?",
            answerSummary: "Do you mean gross or net revenue?",
            route: "clarify",
          }],
        },
      },
    });

    expect(continuation?.sourceQuestion).toBe("What is total revenue?");
  });

  it("uses the exact source run for a structured choice even without conversation storage", () => {
    const continuation = resolveClarificationContinuation({
      question: "Lost Deal Activity Count",
      selectedEvidenceId: "semantic:metric:sales.lost_deal_activity_count",
      clarificationSourceQuestion: "Compare monthly competitive losses by competitor and activity count",
      history: [],
    });

    expect(continuation).toMatchObject({
      sourceQuestion: "Compare monthly competitive losses by competitor and activity count",
      reply: "Lost Deal Activity Count",
    });
  });

  it("treats an original-question structured dimension click as a continuation", () => {
    const continuation = resolveClarificationContinuation({
      question: "Show the top names by revenue",
      selectedEvidenceId: "semantic:uncategorized:dimension:account_revenue.account_name",
      clarificationSourceQuestion: "Show the top names by revenue",
      history: [],
    });

    expect(continuation).toMatchObject({
      sourceQuestion: "Show the top names by revenue",
      reply: "Show the top names by revenue",
    });
  });

  it('binds a structured click to the server-persisted source frame instead of a client-carried label', () => {
    const continuation = resolveClarificationContinuation({
      question: 'Customer Name',
      selectedEvidenceId: 'semantic:uncategorized:dimension:account_revenue.customer_name',
      // This can be stale after a reload; it must not replace the server
      // source question before retrieval or routing.
      clarificationSourceQuestion: 'Customer Name',
      threadId: 'thr-server-issued-selection',
      conversationContext: {
        serverIssuedClarificationSelection: {
          version: 1,
          threadId: 'thr-server-issued-selection',
          sourceTurnId: 'turn-server-issued-selection',
          snapshotId: 'snapshot-server-issued-selection',
        },
        conversationEnvelope: {
          version: 1,
          threadId: 'thr-server-issued-selection',
          recentTurns: [],
          pendingClarification: {
            sourceTurnId: 'turn-server-issued-selection',
            sourceQuestion: 'Show the top names by revenue',
            question: 'Which governed display field should DQL use?',
            selection: {
              version: 1,
              optionIds: ['semantic:uncategorized:dimension:account_revenue.customer_name'],
              ambiguityCandidateIds: ['semantic:uncategorized:dimension:account_revenue.customer_name'],
              snapshotId: 'snapshot-server-issued-selection',
            },
          },
        },
      },
    });

    expect(continuation).toMatchObject({
      sourceQuestion: 'Show the top names by revenue',
      reply: 'Customer Name',
    });
  });

  it("does not fold a complete new question into a pending clarification", () => {
    const continuation = resolveClarificationContinuation({
      question: "Which warehouses shipped late last quarter?",
      history: [],
      ...askSurfaceContext(),
    });

    expect(continuation).toBeUndefined();
  });
});

describe("clarification continuations", () => {
  it("treats a substantive new question without punctuation as a fresh turn", () => {
    const continuation = resolveClarificationContinuation({
      question: "who are the customers userd the beverage products",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "what product they bought for this amount?",
            answerSummary: "Which product meaning do you want?",
            route: "clarify",
          }],
        },
      },
    });

    expect(continuation).toBeUndefined();
  });

  it("recovers to a previously successful analytical question after clarification", () => {
    const continuation = resolveClarificationContinuation({
      question: "what region has the most revenue",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [
            {
              question: "what region has the most revenue",
              answerSummary: "Philadelphia has the highest revenue.",
              route: "answer",
              runStatus: "completed",
            },
            {
              question: "filter that customer",
              answerSummary: "Which customer column should define the answer?",
              route: "clarify",
              runStatus: "needs_clarification",
            },
          ],
        },
      },
    });

    expect(continuation).toBeUndefined();
  });

  it("treats a compact metric-by-dimension request as a fresh turn", () => {
    const continuation = resolveClarificationContinuation({
      question: "revenue by region",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "filter that customer",
            answerSummary: "Which customer column should define the answer?",
            route: "clarify",
            runStatus: "needs_clarification",
          }],
        },
      },
    });

    expect(continuation).toBeUndefined();
  });

  it("recovers the original question and actual clarifying question from persisted turns", () => {
    const continuation = resolveClarificationContinuation({
      question: "yes",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "Who are the top customers buying different beverage products?",
            answerSummary: "Do you want total beverage spend or a per-product breakdown?",
            route: "clarify",
          }],
        },
      },
    });

    expect(continuation).toMatchObject({
      sourceQuestion: "Who are the top customers buying different beverage products?",
      clarifyingQuestion: "Do you want total beverage spend or a per-product breakdown?",
      reply: "yes",
    });
    expect(continuation?.resolvedQuestion).toContain("User clarification: yes");
    expect(continuation?.resolvedQuestion).toContain("Do not repeat the same clarification");
  });

  it("recovers the analytical question from an already repeated clarification chain", () => {
    const continuation = resolveClarificationContinuation({
      question: "yes, per product",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [
            {
              question: "Who are the top customers buying different beverage products?",
              answerSummary: "Rank by spend or by product variety?",
              route: "clarify",
            },
            {
              question: "yes",
              answerSummary: "Do you mean individual products or total beverage revenue?",
              route: "clarify",
            },
          ],
        },
      },
    });

    expect(continuation?.sourceQuestion).toBe("Who are the top customers buying different beverage products?");
    expect(continuation?.clarifyingQuestion).toBe("Do you mean individual products or total beverage revenue?");
    expect(continuation?.resolvedQuestion).toContain("User clarification: yes, per product");
  });

  it("fails closed a free-text clarification continuation that still has no frozen RAP", async () => {
    let routed = false;
    let executedQuestion = "";
    const engine = new AgentRunEngine({
      idGenerator: () => "run-clarification-follow-up",
      now: fixedClock(),
      router: {
        decide: () => {
          routed = true;
          return { action: "clarify", confidence: 0.9, reason: "Ask again", followsUp: true };
        },
      },
      executors: {
        generated_answer: ({ request }) => {
          executedQuestion = request.question;
          return { answer: "Melissa leads across five beverage product types." };
        },
      },
    });

    const run = await engine.run({
      question: "yes",
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "Who are the top customers buying different beverage products?",
            answerSummary: "Do you want total beverage spend or a per-product breakdown?",
            route: "clarify",
          }],
        },
      },
    });

    expect(routed).toBe(false);
    expect(executedQuestion).toBe("");
    expect(run.question).toBe("yes");
    expect(run.route).toBe("blocked");
    expect(run.answer).toContain("could not freeze an exact analytical plan");
    expect(run.events[0]?.payload).toMatchObject({ question: "yes", clarificationResolved: true });
  });

  it("AGT-011 routes a structured meaning choice against the original question and selected evidence", async () => {
    const selectedEvidenceId = "semantic:metric:dbt_core_models.total_ccu_count";
    let routedQuestion = "";
    let routedEvidenceId: string | undefined;
    let executedQuestion = "";
    let executedEvidenceId: string | undefined;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-structured-clarification",
      now: fixedClock(),
      router: {
        decide: (request) => {
          routedQuestion = request.question;
          routedEvidenceId = request.selectedEvidenceId;
          return {
            action: "answer",
            confidence: 1,
            reason: "The user selected an exact governed metric.",
            source: "heuristic",
            category: "data_lookup",
            meaningResolution: {
              interpretedQuestion: request.question,
              questionType: "lookup",
              selectedConceptIds: [selectedEvidenceId],
              recommendedExecutionId: selectedEvidenceId,
              queryIntent: { measures: [selectedEvidenceId], dimensions: [], filters: [] },
              rejectedCandidates: [],
              confidence: "high",
              missingInformation: [],
              recommendedRoute: "semantic",
            },
          };
        },
      },
      executors: {
        semantic_answer: ({ request }) => {
          executedQuestion = request.question;
          executedEvidenceId = request.selectedEvidenceId;
          return { answer: "Total CCU count is 42." };
        },
      },
    });

    const run = await engine.run({
      question: "Total CCU Count",
      selectedEvidenceId,
      conversationContext: {
        serverSnapshot: {
          recentTurns: [{
            question: "What is the total CCU count?",
            answerSummary: "Which total CCU count meaning do you want?",
            route: "clarify",
          }],
        },
      },
    });

    expect(routedQuestion).toBe("What is the total CCU count?");
    expect(executedQuestion).toBe("What is the total CCU count?");
    expect(routedEvidenceId).toBe(selectedEvidenceId);
    expect(executedEvidenceId).toBe(selectedEvidenceId);
    expect(run.question).toBe("Total CCU Count");
    expect(run.route).toBe("semantic_answer");
    expect(run.answer).toBe("Total CCU count is 42.");
  });

  it("AGT-011 returns identifier-bound options with a hard clarification", async () => {
    const clarificationOptions = [{
      id: "semantic:metric:orders.total_revenue",
      label: "Total Revenue",
      description: "Recognized order revenue.",
      kind: "semantic_metric",
    }];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-structured-options",
      now: fixedClock(),
      router: {
        decide: () => ({
          action: "clarify",
          confidence: 0.7,
          reason: "Two governed meanings are materially different.",
          requiresClarification: true,
          clarifyingQuestion: "Which revenue meaning do you want?",
          clarificationOptions,
        }),
      },
    });

    const run = await engine.run({ question: "What is revenue?" });

    expect(run.status).toBe("needs_clarification");
    expect(run.clarificationOptions).toEqual(clarificationOptions);
  });

  it("AGT-014 preserves entity-path options discovered by the selected semantic executor", async () => {
    const clarificationOptions = [{
      id: "semantic-path:report_date:bcm_ccu_pc",
      label: "Use Report Date via bcm_ccu_pc",
      question: "Who are the top customers and what is their BCM this month?",
      kind: "semantic_entity_path",
    }];
    const engine = new AgentRunEngine({
      idGenerator: () => "run-runtime-path-options",
      now: fixedClock(),
      router: {
        decide: () => ({
          action: "answer",
          confidence: 0.9,
          reason: "A governed semantic metric and dimension were resolved.",
          requiresClarification: false,
          meaningResolution: {
            interpretedQuestion: "Who are the top customers and what is their BCM this month?",
            questionType: "ranking",
            selectedConceptIds: ["semantic:metric:total_bcm"],
            recommendedExecutionId: "semantic:metric:total_bcm",
            queryIntent: { measures: ["total_bcm"], dimensions: ["customer"], filters: [] },
            rejectedCandidates: [],
            confidence: "high",
            missingInformation: [],
            recommendedRoute: "semantic",
          },
          resolvedAnalyticalPlan: {
            mode: 'authoritative',
            capability: 'semantic_execution',
            planId: 'rap:total-bcm-customer-month',
            fingerprint: 'sha256:total-bcm-customer-month',
          } as IntentDecision['resolvedAnalyticalPlan'],
        }),
      },
      executors: {
        semantic_answer: () => ({
          status: "needs_clarification",
          trustState: "not_applicable",
          stopReason: "needs_clarification",
          answerRefusalCode: "ambiguous",
          answer: "Choose the governed entity path for Report Date.",
          clarificationOptions,
        }),
      },
    });

    const run = await engine.run({ question: "Who are the top customers and what is their BCM this month?" });

    expect(run.status).toBe("needs_clarification");
    expect(run.clarificationOptions).toEqual(clarificationOptions);
  });

  it("fails closed before a legacy generator can reinterpret a consumed structured choice", async () => {
    const selectedEvidenceId = "semantic:metric:sales.lost_opportunities_count";
    const repeatedOptions = [{
      id: selectedEvidenceId,
      label: "Lost Opportunities Count",
      kind: "semantic_metric",
    }];
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-no-repeated-clarification",
      now: fixedClock(),
      router: {
        decide: () => ({
          action: "answer",
          confidence: 0.8,
          reason: "Continue the governed cascade after consuming the selected identity.",
          source: "heuristic",
          category: "data_lookup",
        }),
      },
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return {
            status: "needs_clarification",
            trustState: "not_applicable",
            stopReason: "needs_clarification",
            answerRefusalCode: "ambiguous",
            answer: "Which governed metric should I use?",
            clarificationOptions: repeatedOptions,
          };
        },
      },
    });

    const run = await engine.run({
      question: "Lost Opportunities Count",
      selectedEvidenceId,
    });

    expect(run.status).toBe("blocked");
    expect(run.trustState).toBe("blocked");
    expect(generatedCalls).toBe(0);
    expect(run.clarificationOptions).toBeUndefined();
    expect(run.answer).toContain("could not freeze an exact analytical plan");
  });
});

describe('Ask trace continuity links (OBS-008)', () => {
  it('records clarification, prior-result, and host-derived repair relationships without routing from them', async () => {
    const links: Array<Record<string, unknown>> = [];
    const observer = traceLinkObserver(links);
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-trace-continuity',
      now: fixedClock(),
      traceObserverFactory: () => observer,
      router: {
        decide: () => ({ action: 'converse', confidence: 1, reason: 'Deterministic conversation.', source: 'heuristic' }),
      },
      executors: { conversation: async () => ({ answer: 'Done.' }) },
    });

    await engine.run({
      question: 'Revenue',
      selectedEvidenceId: 'semantic:metric:revenue',
      clarificationSourceQuestion: 'Which revenue metric should I use?',
      selectedResultBinding: {
        version: 1,
        sourceRunId: 'run-prior-result',
        sourceArtifactId: 'artifact-prior-result',
        canonicalColumn: 'customer_name',
        value: 'not-persisted-in-trace',
        rowFingerprint: 'sha256:row',
        resultFingerprint: 'sha256:result',
      },
      workspaceContext: { traceDerivation: 'analytical_repair', sourceRunId: 'run-source-repair' },
    });

    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'clarification_continuation', choiceFingerprint: expect.stringMatching(/^sha256:/) }),
      expect.objectContaining({ kind: 'prior_result', targetRunId: 'run-prior-result', choiceFingerprint: expect.stringMatching(/^sha256:/) }),
      expect.objectContaining({ kind: 'derived_repair', targetRunId: 'run-source-repair' }),
    ]));
    expect(JSON.stringify(links)).not.toContain('not-persisted-in-trace');
  });

  it('records prior-result conversation binding before routing without retaining a member value', async () => {
    const spans: Array<Record<string, unknown>> = [];
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-trace-prior-result-binding',
      now: fixedClock(),
      traceObserverFactory: () => traceLinkObserver([], spans),
      router: {
        decide: () => ({ action: 'converse', confidence: 1, reason: 'Deterministic conversation.', source: 'heuristic' }),
      },
      executors: { conversation: async () => ({ answer: 'Done.' }) },
    });

    await engine.run({
      question: 'Which region does she belong to?',
      selectedResultBinding: {
        version: 1,
        sourceRunId: 'run-prior-result',
        sourceArtifactId: 'artifact-prior-result',
        canonicalColumn: 'customer_name',
        value: 'not-persisted-in-trace',
        rowFingerprint: 'sha256:row',
        resultFingerprint: 'sha256:result',
      },
    });

    expect(spans.find((span) => span.name === 'conversation.hydrate')).toMatchObject({
      payload: { kind: 'conversation', continuation: true, binding: 'prior_result' },
    });
    expect(JSON.stringify(spans)).not.toContain('not-persisted-in-trace');
  });
});

describe("selectRoute", () => {
  it("uses the authoritative plan capability instead of the legacy recommended route", () => {
    const decision = {
      action: 'answer',
      confidence: 0.9,
      reason: 'Resolved.',
      followsUp: false,
      meaningResolution: {
        interpretedQuestion: 'Revenue by customer',
        questionType: 'ranking',
        selectedConceptIds: ['dbt:column:orders.amount'],
        queryIntent: { measures: ['revenue'], dimensions: ['customer'], filters: [] },
        rejectedCandidates: [],
        confidence: 'high',
        missingInformation: [],
        recommendedRoute: 'semantic',
      },
      resolvedAnalyticalPlan: {
        mode: 'authoritative',
        capability: 'governed_relational',
      } as IntentDecision['resolvedAnalyticalPlan'],
    } satisfies IntentDecision;
    expect(selectRoute({ question: 'Revenue by customer' }, decision)).toBe('generated_answer');
    expect(selectRoute({ question: 'Revenue by customer', requestedMode: 'research' }, decision)).toBe('research');
  });

  it("uses explicit mode before heuristics", () => {
    const decision = decideAgentAction({
      question: "build a dashboard but just give SQL",
      intent: "ad_hoc_ranking",
      signals: { certifiedScore: 0.9 },
    });
    expect(selectRoute({ question: "build a dashboard but just give SQL", requestedMode: "sql" }, decision)).toBe("sql_cell");
  });

  it("routes a conversational turn to the conversation route before authoring regexes", () => {
    const decision = decideAgentAction({ question: "hi", intent: "clarify" });
    expect(decision.action).toBe("converse");
    expect(selectRoute({ question: "hi" }, decision)).toBe("conversation");
  });
});

describe("AgentRunEngine — conversation route", () => {
  it("completes a conversational run with no governance chrome and no trust badge", async () => {
    const store = new InMemoryAgentRunStore();
    const engine = new AgentRunEngine({
      store,
      idGenerator: () => "run-converse",
      now: fixedClock(),
      executors: {
        conversation: () => ({
          answer: "Hi! I answer questions about your data.",
          answerKind: "conversational",
          status: "completed",
          trustState: "not_applicable",
          stopReason: "conversational_reply",
          artifacts: [],
          evaluations: [],
          nextActions: [{ id: "suggest-question-1", label: "What is total revenue?" }],
        }),
      },
    });
    const run = await engine.run({ question: "hi" });
    expect(run).toMatchObject({
      route: "conversation",
      status: "completed",
      trustState: "not_applicable",
      stopReason: "conversational_reply",
      answerKind: "conversational",
      answer: "Hi! I answer questions about your data.",
    });
    expect(run.artifacts).toHaveLength(0);
    expect(run.evaluations).toHaveLength(0);
    expect(run.nextActions[0]).toMatchObject({ id: "suggest-question-1" });
  });

  it("passes conversation through for a stakeholder audience", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-converse-stakeholder",
      now: fixedClock(),
      executors: {
        conversation: () => ({ answer: "Hello!", answerKind: "conversational", status: "completed", trustState: "not_applicable", evaluations: [] }),
      },
    });
    const run = await engine.run({ question: "hello", audience: "stakeholder" });
    expect(run.route).toBe("conversation");
    expect(run.status).toBe("completed");
  });

  it.each([
    "what we are talking about here?",
    "what we are reviewing in this chat",
    "what are we revewing and discussing in whole conversaion?",
  ])("routes Ask-mode conversation recap '%s' to conversation when context exists", async (question) => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-context-recap",
      now: fixedClock(),
      executors: {
        conversation: ({ request }) => ({
          answer: `We were talking about ${request.conversationContext?.sourceQuestion}.`,
          answerKind: "conversational",
          status: "completed",
          trustState: "not_applicable",
          evaluations: [],
        }),
      },
    });

    const run = await engine.run({
      question,
      requestedMode: "ask",
      conversationContext: {
        sourceQuestion: "Top products by revenue",
        resultColumns: ["product_name", "category", "revenue"],
      },
    });

    expect(run.route).toBe("conversation");
    expect(run.answerKind).toBe("conversational");
    expect(run.answer).toContain("Top products by revenue");
    expect(run.artifacts).toHaveLength(0);
  });

  it("does not let an injected conversational decision bypass an analytical RAP boundary", async () => {
    let conversationCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-router",
      now: fixedClock(),
      router: { decide: () => ({ action: "converse", confidence: 0.99, reason: "router says hi", conversationalKind: "greeting", followsUp: false }) },
      executors: {
        conversation: () => { conversationCalls += 1; return { answer: "routed reply", answerKind: "conversational", status: "completed", trustState: "not_applicable", evaluations: [] }; },
      },
    });
    // A question the deterministic tier would send to the data cascade, forced to converse by the router.
    const run = await engine.run({ question: "what is total revenue?", signals: { certifiedScore: 0.9 } });
    expect(conversationCalls).toBe(0);
    expect(run.route).toBe("blocked");
    expect(run.answer).toContain('could not freeze an exact analytical plan');
  });

  it("runs retrieval-first routing for Ask mode before selecting the governed executor", async () => {
    let routerCalls = 0;
    let semanticCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => "run-ask-router",
      now: fixedClock(),
      router: {
        decide: () => {
          routerCalls += 1;
          return {
            action: "answer",
            confidence: 0.9,
            reason: "Resolved against a semantic metric.",
            followsUp: false,
            meaningResolution: {
              interpretedQuestion: "Monthly rollover balance by customer",
              questionType: "ranking",
              selectedConceptIds: ["semantic:rollover_balance_amount"],
              recommendedExecutionId: "semantic:rollover_balance_amount",
              queryIntent: { measures: ["rollover_balance_amount"], dimensions: ["customer"], filters: [] },
              rejectedCandidates: [],
              confidence: "high",
              missingInformation: [],
              recommendedRoute: "semantic",
            },
          };
        },
      },
      executors: {
        semantic_answer: () => {
          semanticCalls += 1;
          return {
            answer: "Resolved semantic answer.",
            answerTier: "semantic_metric",
          };
        },
      },
    });

    const run = await engine.run({ question: "monthly rollover balance", requestedMode: "ask" });

    expect(routerCalls).toBe(1);
    // Still the point of this test: a high-confidence semantic RECOMMENDATION is
    // not a frozen plan, so the semantic executor must not run.
    expect(semanticCalls).toBe(0);
    // A semantic recommendation alone is not an executable physical fallback.
    // The engine must not manufacture generated SQL without the router's
    // same-snapshot qualified exploratory decision.
    expect(run.route).toBe("blocked");
    expect(run.trustState).toBe("blocked");
  });

  it("falls back to deterministic routing when the router throws", async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => "run-router-throws",
      now: fixedClock(),
      router: { decide: () => { throw new Error("router down"); } },
      executors: {
        conversation: () => ({ answer: "hi", answerKind: "conversational", status: "completed", trustState: "not_applicable", evaluations: [] }),
      },
    });
    const run = await engine.run({ question: "hi" });
    expect(run.route).toBe("conversation");
  });

  it('persists additive content-free V2 telemetry while retaining the V1 receipt', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-telemetry',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      executors: {
        generated_answer: () => ({
          answer: 'done',
          status: 'needs_review',
          trustState: 'review_required',
          telemetry: {
            version: 1,
            stageDurationsMs: { retrieval: 12, execution: 8, total: 30 },
            providerRoundTrips: 1,
            toolCalls: 2,
            sqlExecutions: 1,
            repairs: 0,
            egressReceipts: 1,
            warehouseDurationMs: 8,
          },
          providerEgressReceipts: [{
            version: 1,
            purpose: 'answer_generation',
            provider: 'test',
            permittedCategories: ['question'],
            resultRowCount: 0,
            columnCount: 0,
            redactionPolicyId: 'zero-result-rows-v1',
            optIn: false,
            payloadFingerprint: 'a'.repeat(64),
          }],
        }),
      },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(run.diagnosticReceipt?.version).toBe(1);
    expect(run.diagnosticReceiptV2).toMatchObject({
      version: 2,
      runId: 'run-telemetry',
      telemetry: {
        providerRoundTrips: 1,
        toolCalls: 2,
        sqlExecutions: 1,
        egressReceipts: 1,
        warehouseDurationMs: 8,
      },
      providerEgressReceiptFingerprints: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
    expect(JSON.stringify(run.diagnosticReceiptV2)).not.toContain('done');
    expect(JSON.stringify(run.diagnosticReceiptV2)).not.toContain('rows');
  });

  it('persists physical dispatch evidence when the executor throws after send', async () => {
    const receipt = {
      version: 1 as const,
      purpose: 'answer_generation' as const,
      provider: 'openai',
      permittedCategories: ['question' as const],
      resultRowCount: 0,
      columnCount: 0,
      redactionPolicyId: 'no-result-rows-v1',
      optIn: false,
      payloadFingerprint: `sha256:${'a'.repeat(64)}`,
    };
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-failed-dispatch-evidence',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      executors: {
        generated_answer: () => {
          throw Object.assign(new Error('provider failed after send'), {
            providerDispatchEvidence: {
              providerEgressReceipts: [receipt],
              providerRoundTrips: 1,
              toolCalls: 0,
              sqlExecutions: 0,
              repairs: 0,
              fallbackReason: 'provider_error',
            },
          });
        },
      },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(run.status).toBe('blocked');
    expect(run.providerEgressReceipts).toEqual([receipt]);
    expect(run.telemetry).toMatchObject({ providerRoundTrips: 1, egressReceipts: 1, fallbackReason: 'provider_error' });
    expect(run.diagnosticReceiptV2).toMatchObject({
      telemetry: { providerRoundTrips: 1, egressReceipts: 1 },
      providerEgressReceiptFingerprints: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
  });

  it('retains physical dispatch evidence on cancellation after send', async () => {
    const cancellation = Object.assign(new DOMException('cancelled after send', 'AbortError'), {
      providerDispatchEvidence: {
        providerEgressReceipts: [{
          version: 1,
          purpose: 'answer_generation',
          provider: 'ollama',
          permittedCategories: ['question'],
          resultRowCount: 0,
          columnCount: 0,
          redactionPolicyId: 'no-result-rows-v1',
          optIn: false,
          payloadFingerprint: `sha256:${'b'.repeat(64)}`,
        }],
        providerRoundTrips: 1,
        toolCalls: 0,
        sqlExecutions: 0,
        repairs: 0,
        fallbackReason: 'cancelled',
      },
    });
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-cancelled-dispatch-evidence',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      executors: { generated_answer: () => { throw cancellation; } },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(run.status).toBe('blocked');
    expect(run.diagnosticReceipt?.failure?.code).not.toBe('RUN_CANCELLED');
    expect(run.telemetry).toMatchObject({ providerRoundTrips: 1, egressReceipts: 1, fallbackReason: 'cancelled' });
    expect(run.providerEgressReceipts).toHaveLength(1);
  });

  it('does not treat an unbranded executor AbortError as user cancellation', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-unbranded-cancel-message',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      executors: {
        generated_answer: () => {
          throw new DOMException('Stopped by user.', 'AbortError');
        },
      },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(run).toMatchObject({
      status: 'blocked',
      trustState: 'blocked',
      stopReason: 'blocked',
    });
    expect(run.diagnosticReceipt?.failure).toMatchObject({
      code: 'EXECUTOR_FAILURE',
      recoverable: true,
    });
    expect(run.events.at(-1)?.type).toBe('run.failed');
  });

  it('applies one 45s/180s hard deadline with deterministic route soft targets', async () => {
    expect(agentRequestDeadlineMs('ask')).toBe(45_000);
    expect(agentRequestDeadlineMs('research')).toBe(180_000);
    expect(agentRouteDeadlineMs('certified_answer')).toBe(5_000);
    expect(agentRouteDeadlineMs('semantic_answer')).toBe(5_000);
    // Generation may take a real tool round (look something up, then use it)
    // rather than a single blind shot, so its discovery window covers that.
    expect(agentRouteDeadlineMs('generated_answer')).toBe(30_000);
    expect(agentRouteDeadlineMs('research')).toBe(180_000);
    const observed: number[] = [];
    const controller = new AbortController();
    controller.abort(new DOMException('route deadline', 'TimeoutError'));
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-route-deadline',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      routeTimeoutSignal: (durationMs) => {
        observed.push(durationMs);
        return controller.signal;
      },
      executors: {
        generated_answer: ({ request }) => {
          if (request.signal?.aborted) throw request.signal.reason;
          return { answer: 'unreachable' };
        },
      },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(observed).toEqual([45_000]);
    expect(run).toMatchObject({
      status: 'blocked',
      trustState: 'blocked',
      diagnosticReceiptV2: { telemetry: { fallbackReason: 'executor_failure' } },
    });
    expect(run.summary).toContain('time limit');
  });

  it('accepts a frozen semantic result after its 5s soft target but before the 45s hard ceiling', async () => {
    let nowMs = 0;
    const budget = createAgentRunBudget({
      requestedMode: 'ask', startedAtMs: 0, nowMs: () => nowMs,
      timeoutSignal: () => new AbortController().signal,
    });
    const decision = {
      action: 'answer', confidence: 1, reason: 'exact semantic binding', followsUp: false,
      resolvedAnalyticalPlan: { mode: 'authoritative', capability: 'semantic_execution' } as never,
    } satisfies IntentDecision;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-late-frozen-semantic',
      now: () => new Date(nowMs),
      router: { decide: async () => decision },
      planner: fixedRoutePlanner('semantic_answer'),
      executors: { semantic_answer: () => {
        nowMs = 6_000;
        return { answer: 'Validated late semantic result.' };
      } },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask', runBudget: budget });
    expect(run.answer).toBe('Validated late semantic result.');
    expect(run.status).not.toBe('needs_clarification');
  });

  it('refuses a new ordinary analytical branch after its soft target when no plan is frozen', async () => {
    // Past the 30s generated-answer soft target.
    let nowMs = 31_000;
    const budget = createAgentRunBudget({
      requestedMode: 'ask', startedAtMs: 0, nowMs: () => nowMs,
      timeoutSignal: () => new AbortController().signal,
    });
    let executions = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-soft-refusal', now: () => new Date(nowMs),
      router: { decide: async () => ({ action: 'answer', confidence: 0.5, reason: 'no frozen plan', followsUp: false }) },
      planner: fixedRoutePlanner('generated_answer'),
      executors: { generated_answer: () => { executions += 1; return { answer: 'must not run' }; } },
    });
    const run = await engine.run({ question: 'unknown metric', requestedMode: 'ask', runBudget: budget });
    expect(executions).toBe(0);
    expect(run.status).toBe('needs_clarification');
    expect(run.answer).toContain('discovery window ended');
  });

  it('returns findings already validated when the soft target elapses mid-plan, instead of blocking', async () => {
    // Step 1 lands a finding, then the clock passes the 30s generated-answer
    // soft target. Admission control stops step 2 from starting — but the run
    // has something true to say, and throwing it away would make the user
    // re-run the same investigation from zero.
    let nowMs = 1_000;
    const budget = createAgentRunBudget({
      requestedMode: 'ask', startedAtMs: 0, nowMs: () => nowMs,
      timeoutSignal: () => new AbortController().signal,
    });
    const twoStep: AgentRunPlanner = {
      plan: ({ request }) => ({
        source: 'deterministic',
        rationale: 'two-step plan',
        steps: [
          { id: 's1', route: 'generated_answer', goal: request.question, successCriteria: [] },
          { id: 's2', route: 'generated_answer', goal: 'second pass', successCriteria: [] },
        ],
      }),
      replan: () => ({ decision: 'accept' }),
    };
    let executions = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-soft-partial', now: () => new Date(nowMs),
      router: { decide: async () => ({ action: 'answer', confidence: 0.5, reason: 'no frozen plan', followsUp: false }) },
      planner: twoStep,
      executors: { generated_answer: () => {
        executions += 1;
        nowMs = 31_000; // step 2 will be refused admission
        return {
          answer: 'Revenue by month.',
          status: 'needs_review' as const,
          trustState: 'review_required' as const,
          artifacts: [{ id: 'a1', kind: 'answer' as const, title: 'Revenue by month', trustState: 'review_required' as const, payload: {} }],
        };
      } },
    });
    const run = await engine.run({ question: 'revenue then margin', requestedMode: 'ask', runBudget: budget });

    expect(executions).toBe(1);
    expect(budget.mayStartDiscovery('generated_answer')).toBe(false);
    expect(run.status).not.toBe('blocked');
    expect(run.trustState).not.toBe('blocked');
    expect(run.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'a1' })]));
  });

  it('stops new Research queries at 150s while retaining a validated partial executor result', async () => {
    let nowMs = 149_000;
    const budget = createAgentRunBudget({
      requestedMode: 'research', startedAtMs: 0, nowMs: () => nowMs,
      timeoutSignal: () => new AbortController().signal,
    });
    let calls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-research-soft', now: () => new Date(nowMs),
      router: { decide: async () => ({ action: 'investigate', confidence: 0.8, reason: 'explicit research', followsUp: false }) },
      planner: fixedRoutePlanner('research'),
      executors: { research: () => {
        calls += 1;
        nowMs = 151_000;
        return { answer: 'Validated partial finding.', artifacts: [{ id: 'partial', kind: 'research_run', title: 'Partial', trustState: 'review_required', payload: { limitations: ['branch budget ended'] } }] };
      } },
    });
    const run = await engine.run({ question: 'research revenue', requestedMode: 'research', runBudget: budget });
    expect(calls).toBe(1);
    expect(run.answer).toBe('Validated partial finding.');
    expect(budget.mayStartDiscovery('research')).toBe(false);
    expect(run.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'partial' })]));
  });

  it('starts the absolute deadline before a router that ignores AbortSignal', async () => {
    const deadline = new AbortController();
    deadline.abort(new DOMException('request deadline', 'TimeoutError'));
    const observed: number[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-routing-deadline',
      router: { decide: async () => new Promise<IntentDecision>(() => {}) },
      routeTimeoutSignal: (durationMs) => {
        observed.push(durationMs);
        return deadline.signal;
      },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(observed).toEqual([45_000]);
    expect(run).toMatchObject({ status: 'blocked', trustState: 'blocked' });
    expect(run.answer).toBeUndefined();
  });

  it('continues a pre-freeze modeling gap into the review-required generated tier', async () => {
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-typed-modeling-gap',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'block', confidence: 1, followsUp: false, source: 'heuristic',
          reason: 'The selected metric does not model a reachable workspace grouping.',
          terminalOutcome: {
            kind: 'modeling_gap',
            code: 'ANALYTICAL_MODELING_GAP',
            message: 'The selected metric does not model a reachable workspace grouping.',
            candidateIds: [],
          },
          analyticalCascadeDecision: safeExploratoryCascade(),
        }),
      },
    });
    const run = await engine.run({ question: 'Rank workspaces by cost', requestedMode: 'ask' });
    expect(run).toMatchObject({
      route: 'generated_answer',
      status: 'needs_review',
    });
    expect(run.summary).toBe('Created review-required agent output.');
    expect(run.summary).not.toBe('Agent run is blocked.');
  });

  it('AGT-029 dispatches an authoritative Ask coverage decision without legacy gap rescue', async () => {
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-authoritative-coverage-boundary',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'block',
          confidence: 1,
          followsUp: false,
          source: 'heuristic',
          reason: 'The canonical Ask runtime recorded the pre-freeze coverage result.',
          terminalOutcome: {
            kind: 'modeling_gap',
            code: 'ANALYTICAL_MODELING_GAP',
            message: 'The canonical Ask cascade did not select an executable plan.',
            candidateIds: [],
          },
          analyticalCascadeDecision: safeExploratoryCascade(),
          // The engine must dispatch this canonical state as-is. If it applied
          // its legacy rescue, this test would invoke generated_answer and
          // manufacture a second cascade decision.
          askAnalystDecision: {
            version: 1,
            mode: 'authoritative',
            state: {
              version: 1,
              mode: 'authoritative',
              phase: 'blocked',
              frame: {
                version: 3,
                questionFingerprint: 'sha256:authoritative-coverage-boundary',
                kind: 'analytical',
                requirements: {
                  version: 1,
                  measures: ['revenue'],
                  dimensions: [],
                  entityTerms: [],
                  entityDisplayTerms: [],
                  memberTerms: [],
                },
                conversation: { binding: 'none' },
              },
              mission: {
                version: 1,
                mode: 'ask',
                taskLimit: 1,
                planningContinuationLimit: 1,
                tasks: [],
                hypotheses: [],
              },
              workspace: {
                version: 1,
                snapshotId: 'snapshot:authoritative-coverage-boundary',
                sourceCoverage: [],
                admittedCandidateIds: [],
                excludedCandidates: [],
                tools: [],
              },
              program: {
                version: 1,
                id: 'program:authoritative-coverage-boundary',
                frameFingerprint: 'sha256:authoritative-coverage-boundary',
                taskIds: [],
                candidateIds: [],
                executionCandidateIds: [],
                requiredRoles: [],
                filters: [],
                relationshipRequirements: [],
                outputs: {
                  measures: ['revenue'],
                  dimensions: [],
                  entityDisplayTerms: [],
                  assertions: ['all_requested_measures', 'result_contract'],
                },
              },
              conversationDelta: {
                version: 1,
                sourceQuestionFingerprint: 'sha256:authoritative-coverage-boundary',
                partialFrame: {
                  kind: 'analytical',
                  requirements: {
                    version: 1,
                    measures: ['revenue'],
                    dimensions: [],
                    entityTerms: [],
                    entityDisplayTerms: [],
                    memberTerms: [],
                  },
                },
              },
              planningContinuations: 0,
              toolCalls: 0,
              executionAttempts: 0,
              repairAttempts: 0,
            } as never,
          },
        }),
      },
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return { answer: 'This legacy fallback must not run.' };
        },
      },
    });

    const run = await engine.run({ question: 'Rank workspaces by cost', requestedMode: 'ask' });

    expect(generatedCalls).toBe(0);
    expect(run).toMatchObject({ route: 'blocked', status: 'blocked', trustState: 'blocked' });
    expect(run.summary).toContain('canonical Ask cascade');
  });

  it('does not ask a clarification the user has already answered', async () => {
    // The reported loop: "who are the top customers for BCM" returned "Top by
    // which governed metric?", the user answered in prose, and the IDENTICAL
    // question came back. Their reply reads as a complete new question, so it
    // re-entered the cascade fresh and produced the same clarification.
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-repeat-clarify',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'clarify', confidence: 1, followsUp: false, source: 'heuristic',
          requiresClarification: true,
          reason: 'A ranking needs a governed metric.',
          clarifyingQuestion: 'Top by which governed metric?',
          retrievalEvidence: { snapshotId: 's', candidateCount: 2, candidateIds: ['semantic:metric:bcm'] },
        }),
      },
      executors: {
        generated_answer: () => { generatedCalls += 1; return { answer: 'ranked' }; },
      },
    });
    const run = await engine.run({
      question: 'I need a top 10 BCM customers who have top revenue',
      requestedMode: 'ask',
      history: [
        { role: 'user', text: 'who are the top customers for BCM' },
        { role: 'assistant', text: 'Top by which governed metric?' },
        { role: 'user', text: 'I need a top 10 BCM customers who have top revenue' },
      ],
    });
    expect(run.route).not.toBe('clarify');
    expect(generatedCalls).toBe(1);
  });

  it('still asks a clarification that is waiting for its first answer', async () => {
    // A pending question is not a repeat — suppressing it would skip the one
    // clarification that legitimately needed asking.
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-first-clarify',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'clarify', confidence: 1, followsUp: false, source: 'heuristic',
          requiresClarification: true,
          reason: 'A ranking needs a governed metric.',
          clarifyingQuestion: 'Top by which governed metric?',
          retrievalEvidence: { snapshotId: 's', candidateCount: 2, candidateIds: ['semantic:metric:bcm'] },
        }),
      },
    });
    const run = await engine.run({
      question: 'who are the top customers for BCM',
      requestedMode: 'ask',
      history: [{ role: 'user', text: 'who are the top customers for BCM' }],
    });
    expect(run.route).toBe('clarify');
  });

  it('executes a compatible certified metric block for bare natural-language analytical wording', async () => {
    // Built-CLI A01 regression: retrieval correctly selected
    // `dql:block:monthly_revenue` and froze certified execution, but the
    // no-data boundary read "What is monthly revenue?" as a definition merely
    // because the candidate ID uses the same words. That silently produced a
    // completed conversational run with zero rows/SQL instead of execution.
    let certifiedCalls = 0;
    let conversationCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-monthly-revenue-execution',
      now: fixedClock(),
      router: {
        decide: () => ({
          ...authoritativeDecision('certified_execution'),
          retrievalEvidence: {
            snapshotId: 'snapshot-monthly-revenue',
            candidateCount: 1,
            candidateIds: ['dql:block:monthly_revenue'],
          },
        }),
      },
      executors: {
        certified_answer: () => {
          certifiedCalls += 1;
          return {
            answer: 'Monthly revenue was executed from the certified block.',
            evaluations: [{
              id: 'certified-execution',
              label: 'Certified execution',
              passed: true,
              severity: 'info',
              message: 'Executed the immutable monthly_revenue artifact.',
            }],
          };
        },
        conversation: () => {
          conversationCalls += 1;
          return { answer: 'This must not replace a certified metric execution.' };
        },
      },
    });

    const run = await engine.run({ question: 'What is monthly revenue?', requestedMode: 'ask' });

    expect(certifiedCalls).toBe(1);
    expect(conversationCalls).toBe(0);
    expect(run).toMatchObject({
      route: 'certified_answer',
      status: 'completed',
      trustState: 'certified',
      stopReason: 'certified_answer_found',
    });
  });

  it('keeps explicit metric-definition wording conversational even with a certified execution candidate', async () => {
    let certifiedCalls = 0;
    let conversationCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-monthly-revenue-definition',
      now: fixedClock(),
      router: {
        decide: () => ({
          ...authoritativeDecision('certified_execution'),
          retrievalEvidence: {
            snapshotId: 'snapshot-monthly-revenue',
            candidateCount: 1,
            candidateIds: ['dql:block:monthly_revenue'],
          },
        }),
      },
      executors: {
        certified_answer: () => {
          certifiedCalls += 1;
          return { answer: 'This must not execute for an explicit definition question.' };
        },
        conversation: () => {
          conversationCalls += 1;
          return { answer: 'Monthly revenue is the certified monthly gross-revenue metric.' };
        },
      },
    });

    const run = await engine.run({ question: 'What does monthly revenue mean?', requestedMode: 'ask' });

    expect(certifiedCalls).toBe(0);
    expect(conversationCalls).toBe(1);
    expect(run).toMatchObject({
      route: 'conversation',
      status: 'completed',
      trustState: 'not_applicable',
      stopReason: 'conversational_reply',
    });
  });

  it.each([
    ['What is semantic:metric:revenue?', 'semantic:metric:revenue'],
    ['What is dql:block:revenue?', 'dql:block:revenue'],
  ])('keeps a raw qualified object identifier in the definition lane: %s', async (question, candidateId) => {
    let certifiedCalls = 0;
    let conversationCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => `run-qualified-definition-${candidateId.replaceAll(':', '-')}`,
      now: fixedClock(),
      router: {
        decide: () => ({
          ...authoritativeDecision('certified_execution'),
          retrievalEvidence: {
            snapshotId: 'snapshot-qualified-definition',
            candidateCount: 1,
            candidateIds: [candidateId],
          },
        }),
      },
      executors: {
        certified_answer: () => {
          certifiedCalls += 1;
          return { answer: 'This must not execute for a raw qualified identifier.' };
        },
        conversation: () => {
          conversationCalls += 1;
          return { answer: `Definition for ${candidateId}.` };
        },
      },
    });

    const run = await engine.run({ question, requestedMode: 'ask' });

    expect(certifiedCalls).toBe(0);
    expect(conversationCalls).toBe(1);
    expect(run).toMatchObject({
      route: 'conversation',
      status: 'completed',
      trustState: 'not_applicable',
      stopReason: 'conversational_reply',
    });
  });

  it('answers a definitional question about a named artifact instead of asking which meaning to bind', async () => {
    // Reported shape: "what is food_vs_drink_revenue?" came back as "Which
    // governed meaning should DQL bind: food_vs_drink_revenue or …?" — asking the
    // user to disambiguate the single artifact they just named.
    //
    // This must be caught BEFORE the terminal guard: the ambiguity gate has
    // already set action 'clarify' by the time the boundary runs, so a check
    // placed after it is unreachable.
    let conversationCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-definitional',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'clarify', confidence: 1, followsUp: false, source: 'heuristic',
          requiresClarification: true,
          reason: 'Bounded retrieval found multiple governed meanings.',
          clarifyingQuestion: 'Which governed meaning should DQL bind?',
          retrievalEvidence: {
            snapshotId: 's', candidateCount: 2,
            candidateIds: ['dql:block:food_vs_drink_revenue', 'dbt:model:order_items'],
          },
        }),
      },
      executors: {
        conversation: () => {
          conversationCalls += 1;
          return { answer: 'definition', answerKind: 'conversational', status: 'completed', trustState: 'not_applicable', evaluations: [] };
        },
      },
    });
    const run = await engine.run({ question: 'what is food_vs_drink_revenue?', requestedMode: 'ask' });
    expect(conversationCalls).toBe(1);
    expect(run.route).toBe('conversation');
  });

  it('sends an explicit named-block measure request to the certified metadata executor instead of clarification', async () => {
    let generatedCalls = 0;
    let conversationCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-named-block-measure-definition',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'clarify', confidence: 1, followsUp: false, source: 'heuristic',
          requiresClarification: true,
          reason: 'Bounded retrieval found multiple governed meanings.',
          clarifyingQuestion: 'Which governed meaning should DQL bind?',
          retrievalEvidence: {
            snapshotId: 's', candidateCount: 2,
            candidateIds: ['dql:block:top_customers', 'dbt:model:dim_customers'],
          },
        }),
      },
      executors: {
        conversation: () => {
          conversationCalls += 1;
          return { answer: 'must not use conversational fallback' };
        },
        generated_answer: () => {
          generatedCalls += 1;
          return {
            answer: 'Certified artifact metadata for top_customers.',
            answerKind: 'certified',
            status: 'completed',
            trustState: 'certified',
            resolvedRoute: 'certified_answer',
            stopReason: 'certified_answer_found',
          };
        },
      },
    });

    const run = await engine.run({ question: 'what does the top_customers block measure?', requestedMode: 'ask' });

    expect(conversationCalls).toBe(0);
    expect(generatedCalls).toBe(1);
    expect(run).toMatchObject({
      route: 'certified_answer',
      trustState: 'certified',
      status: 'completed',
      stopReason: 'certified_answer_found',
    });
  });

  it('still clarifies an analytical question that merely names an artifact', async () => {
    // The other half: "top_customers by region" names a block but asks for a
    // grouping, so it is an execution request and the gate must stand.
    let conversationCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-named-but-analytical',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'clarify', confidence: 1, followsUp: false, source: 'heuristic',
          requiresClarification: true,
          reason: 'Bounded retrieval found multiple governed meanings.',
          clarifyingQuestion: 'Which governed meaning should DQL bind?',
          retrievalEvidence: { snapshotId: 's', candidateCount: 2, candidateIds: ['dql:block:top_customers'] },
        }),
      },
      executors: {
        conversation: () => { conversationCalls += 1; return { answer: 'x', answerKind: 'conversational' }; },
      },
    });
    const run = await engine.run({ question: 'top_customers by region', requestedMode: 'ask' });
    expect(conversationCalls).toBe(0);
    expect(run.route).toBe('clarify');
  });

  it('does not rescue a block it synthesizes without qualified physical-path proof (AGT-029)', async () => {
    // The reported production dead end. `enforceOrdinaryAnalyticalPlanBoundary`
    // already converted a ROUTER-reported modeling gap into an answer, but then
    // synthesized its OWN ANALYTICAL_MODELING_GAP block further down and never
    // re-applied that rescue — so the most common way an ordinary Ask failed
    // ("ZLens could not freeze an exact analytical plan…") bypassed the fix.
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-synthesized-gap',
      now: fixedClock(),
      router: {
        // No terminalOutcome: the router is content. The block below is
        // synthesized by the boundary itself because nothing froze.
        decide: () => ({
          action: 'answer', confidence: 0.8, followsUp: false, source: 'heuristic',
          reason: 'Retrieved governed candidates.',
          category: 'data_lookup',
          retrievalEvidence: {
            snapshotId: 'snapshot-bcm',
            candidateCount: 3,
            candidateIds: ['semantic:metric:billed_consumption_monthly'],
          },
        }),
      },
      executors: {
        generated_answer: () => {
          generatedCalls += 1;
          return { answer: 'Top customers by billed consumption.' };
        },
      },
    });
    const run = await engine.run({ question: 'who are the top customers for BCM', requestedMode: 'ask' });
    expect(generatedCalls).toBe(0);
    expect(run.route).toBe('blocked');
    expect(run.trustState).toBe('blocked');
  });

  it('still fails closed when nothing was retrieved, so a forged decision cannot bypass the boundary', async () => {
    // The safety half of the same change: with no governed evidence at all, a
    // synthesized modeling gap is indistinguishable from an absent/forged router
    // decision and must remain terminal.
    let generatedCalls = 0;
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-no-evidence',
      now: fixedClock(),
      router: {
        decide: () => ({
          action: 'converse', confidence: 0.99, followsUp: false, source: 'llm',
          category: 'conversational', reason: 'Injected router decision.',
        }),
      },
      executors: {
        generated_answer: () => { generatedCalls += 1; return { answer: 'should not run' }; },
      },
    });
    const run = await engine.run({ question: 'who are the top customers by revenue', requestedMode: 'ask' });
    expect(generatedCalls).toBe(0);
    expect(run.route).toBe('blocked');
  });

  it('rejects a late executor success even when the executor ignores AbortSignal', async () => {
    const controller = new AbortController();
    let complete!: (value: AgentRouteExecutorResult) => void;
    const ignoredSignalWork = new Promise<AgentRouteExecutorResult>((resolve) => { complete = resolve; });
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-ignored-signal',
      now: fixedClock(),
      planner: fixedRoutePlanner('generated_answer'),
      routeTimeoutSignal: () => controller.signal,
      executors: { generated_answer: () => ignoredSignalWork },
    });
    const pending = engine.run({ question: 'revenue', requestedMode: 'ask' });
    await Promise.resolve();
    controller.abort(new DOMException('route deadline', 'TimeoutError'));
    complete({ answer: 'late success must not persist' });
    const run = await pending;
    expect(run).toMatchObject({ status: 'blocked', trustState: 'blocked' });
    expect(run.answer).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain('late success must not persist');
  });

  it('uses one absolute deadline across planning and execution', async () => {
    const epoch = Date.parse('2026-06-29T00:00:00.000Z');
    let elapsedMs = 0;
    const observed: number[] = [];
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-absolute-deadline',
      now: () => new Date(epoch + elapsedMs),
      router: {
        decide: () => {
          elapsedMs = 10_000;
          return { action: 'answer', confidence: 1, reason: 'generated', followsUp: false, source: 'heuristic' };
        },
      },
      planner: {
        plan: ({ request, routeDecision }) => {
          elapsedMs = 12_000;
          return {
            source: 'deterministic' as const,
            rationale: routeDecision.reason,
            steps: [{ id: 'step-1', route: 'generated_answer' as const, goal: request.question, successCriteria: [] }],
          };
        },
        replan: () => ({ decision: 'accept' }),
      },
      routeTimeoutSignal: (durationMs) => {
        observed.push(durationMs);
        return new AbortController().signal;
      },
      executors: { generated_answer: () => ({ answer: 'within remaining budget' }) },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask' });
    expect(run.status).not.toBe('blocked');
    expect(observed).toEqual([45_000]);
  });

  it('keeps an already-aborted user cancellation terminal during routing', async () => {
    const controller = new AbortController();
    controller.abort(createAgentRunCancellationError());
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-routing-cancelled',
      now: fixedClock(),
      router: { decide: async () => new Promise<IntentDecision>(() => {}) },
    });
    const run = await engine.run({ question: 'revenue', requestedMode: 'ask', signal: controller.signal });
    expect(run).toMatchObject({
      route: 'cancelled',
      status: 'cancelled',
      trustState: 'not_applicable',
      stopReason: 'cancelled',
      summary: 'Stopped by user.',
      nextActions: [],
    });
    expect(run.events.at(-1)?.type).toBe('run.cancelled');
    expect(run.diagnosticReceipt).toMatchObject({
      failure: { code: 'RUN_CANCELLED', recoverable: false, safeActions: [] },
    });
    expect(run.answer).toBeUndefined();
  });

  it('records user cancellation while the meaning router is still running', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const meaningStarted = new Promise<void>((resolve) => { started = resolve; });
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-meaning-cancelled',
      now: fixedClock(),
      router: {
        decide: async () => {
          started();
          return new Promise<IntentDecision>(() => {});
        },
      },
    });
    const pending = engine.run({ question: 'top customers', requestedMode: 'ask', signal: controller.signal });
    await meaningStarted;
    controller.abort(createAgentRunCancellationError());
    const run = await pending;
    expect(run).toMatchObject({
      route: 'cancelled',
      status: 'cancelled',
      trustState: 'not_applicable',
      stopReason: 'cancelled',
      nextActions: [],
      telemetry: { fallbackReason: 'cancelled' },
    });
    expect(run.events.at(-1)?.type).toBe('run.cancelled');
  });

  it('records user cancellation during a research executor without repair or escalation', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const researchStarted = new Promise<void>((resolve) => { started = resolve; });
    const engine = new AgentRunEngine({
      idGenerator: () => 'run-research-cancelled',
      now: fixedClock(),
      planner: fixedRoutePlanner('research'),
      executors: {
        research: ({ request }) => new Promise<AgentRouteExecutorResult>((_resolve, reject) => {
          started();
          if (request.signal?.aborted) {
            reject(request.signal.reason);
            return;
          }
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
        }),
      },
    });
    const pending = engine.run({ question: 'research revenue drivers', requestedMode: 'research', signal: controller.signal });
    await researchStarted;
    controller.abort(createAgentRunCancellationError());
    const run = await pending;
    expect(run).toMatchObject({
      route: 'research',
      status: 'cancelled',
      trustState: 'not_applicable',
      stopReason: 'cancelled',
      nextActions: [],
      diagnosticReceipt: { failure: { code: 'RUN_CANCELLED', recoverable: false } },
    });
    expect(run.events.at(-1)?.type).toBe('run.cancelled');
  });
});

function fixedClock(): () => Date {
  return () => new Date("2026-06-29T00:00:00.000Z");
}

function traceLinkObserver(links: Array<Record<string, unknown>>, spans: Array<Record<string, unknown>> = []): AskTraceObserverV1 {
  return {
    enabled: true,
    recordingStatus: 'recording',
    startSpan: (input) => {
      spans.push({ name: input.name, payload: input.payload });
      return '1111111111111111';
    },
    finishSpan: () => {},
    recordCandidateDecision: () => {},
    recordLink: (link) => links.push(link as Record<string, unknown>),
    finalize: () => undefined,
    markPartial: () => {},
    reference: () => undefined,
  };
}

function authoritativeDecision(
  capability: 'certified_execution' | 'semantic_execution' | 'governed_relational' | 'bounded_exploration',
): IntentDecision {
  return {
    action: 'answer',
    confidence: 1,
    reason: 'Exact immutable analytical plan.',
    followsUp: false,
    source: 'heuristic',
    resolvedAnalyticalPlan: {
      mode: 'authoritative',
      capability,
      planId: `rap:test:${capability}`,
      fingerprint: `sha256:test:${capability}`,
    } as IntentDecision['resolvedAnalyticalPlan'],
  };
}

function fixedRoutePlanner(route: AgentRunRoute): AgentRunPlanner {
  return {
    plan: ({ request, routeDecision }) => ({
      source: "deterministic",
      rationale: routeDecision.reason,
      steps: [{
        id: "step-1",
        route,
        goal: request.question,
        successCriteria: [],
      }],
    }),
    replan: ({ currentStep }) => {
      const failing = currentStep.evaluations.find((evaluation) => !evaluation.passed && evaluation.suggestedRepair);
      if (failing?.repairAction?.kind === "escalate") {
        return {
          decision: "escalate",
          route: failing.repairAction.route,
          repairHint: failing.repairAction.hint ?? failing.suggestedRepair,
        };
      }
      return failing?.suggestedRepair
        ? { decision: "repair", repairHint: failing.suggestedRepair }
        : { decision: "accept" };
    },
  };
}

describe('deadline scaling for slow providers', () => {
  it('defaults to 1x, so nothing changes without the env var', () => {
    expect(deadlineScale({})).toBe(1);
    expect(deadlineScale({ ZLENS_AGENT_DEADLINE_SCALE: 'abc' })).toBe(1);
    expect(deadlineScale({ ZLENS_AGENT_DEADLINE_SCALE: '0' })).toBe(1);
  });

  it('never TIGHTENS a deadline someone is relying on', () => {
    // Below 1x would shorten a safety budget rather than extend it.
    expect(deadlineScale({ ZLENS_AGENT_DEADLINE_SCALE: '0.25' })).toBe(1);
  });

  it('scales up but stays bounded, so a typo cannot hang a run', () => {
    expect(deadlineScale({ ZLENS_AGENT_DEADLINE_SCALE: '8' })).toBe(8);
    expect(deadlineScale({ ZLENS_AGENT_DEADLINE_SCALE: '1000' })).toBe(20);
  });
});
