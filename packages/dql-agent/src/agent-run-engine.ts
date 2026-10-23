import type { AgentRunKnowledgeV1 } from './knowledge/consult.js';
import { composeAnswer, type TerminalIncidentCode } from './ask-runtime/compose-answer.js';
import type { AnswerRefusalCode } from './answer-loop.js';
import type { AskPipelineReceiptV9 } from './ask-pipeline/outcomes.js';
import { createHash, randomUUID } from "node:crypto";
import {
  normalizeProviderEgressReceiptV1,
  type AgentRunTelemetryV1,
  type AnalyticalRepairCapabilityV1,
  type ProviderEgressReceiptV1,
} from '@zlens/core';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  classifyConversationalTurn,
  looksLikeDefinitionalAboutNamedObject,
  looksLikeNamedCertifiedArtifactMetadataRequest,
  decideAgentAction,
  looksLikeComposeApp,
  type AskAnalystTaskExecutionV1,
  type IntentDecision,
  type IntentSignals,
} from "./intent-controller.js";
import { selectCascadeRunRoute } from "./cascade/route-policy.js";
import {
  canUseEngineEscalation,
  canUseLaneRepair,
  cascadeBudgetTrace,
  createCascadeBudgetState,
  recordEngineEscalation,
  recordLaneRepair,
  type CascadeAnalysisDepth,
  type CascadeBudgetTrace,
  type PartialCascadeBudgetModel,
} from "./cascade/budgets.js";
import type { MetadataAgentIntent } from "./metadata/catalog.js";
import type { AgentConversationBindingV1 } from './answer-loop.js';
import { buildAnalysisQuestionPlan } from "./metadata/analysis-planner.js";
import type { ReasoningEffort, ThinkingMode } from "./providers/reasoning-effort.js";
import {
  conversationHistoryFromContext,
  isLikelyClarificationReply,
} from "./conversation/snapshot.js";
import {
  buildCoverageGap,
  classifyProviderFailure,
  type AgentRunDiagnosticReceiptV6,
  type AgentRunDiagnosticReceiptV5,
  type AnalyticalProgram,
  type AskAnalystState,
  type BusinessAnswer,
  type AgentRunDiagnosticReceiptV4,
  type AskDecisionSummaryV1,
  type AskResearchBranchSummaryV1,
  type AskTerminalIncidentV1,
  type AnalyticalRequirementSeedV1,
  type TrustedAnalyticalTaskAnchorV1,
  type AgentRunDiagnosticReceiptV3,
  type ProviderFailureDiagnosticV1,
  type ExploratoryExecutionFreezeV1,
  type AgentSelectedResultBindingV1,
  type AnalyticalTaskOutcomeV1,
  type AnalyticalTaskOutcomeSummaryV1,
  type AnalyticalTaskOutcomeTrustStateV1,
  type AnalyticalTurnPlanV1,
  normalizeCanonicalQueryResult, type AnalyticalCascadeTierV1, type AnalyticalCascadeTierOutcomeV1 } from './analytical-orchestration.js';
import type { AgentRetrievalEvidence, MeaningResolution } from './meaning-resolution.js';
import type { AgentRunDiagnosticReceiptV8, AskRuntimeModeV2 } from './ask-runtime/legacy-receipts.js';
import { evaluateAnalyticalRequestPolicy } from './analytical-request-policy.js';
import { frozenRequiredOutputBindingProofsForPlan } from './generated-analytical-proposal.js';
import {
  attachAskTraceObserverV1,
  askTraceObserverForV1,
  finalizeAgentRunTraceV1,
  noOpAskTraceObserverV1,
  recordAuthoritativeRouterDecisionV1,
  recordAuthoritativePlanFreezeV1,
  recordEngineTraceEventV1,
  recordExecutionAttemptSummaryV1,
} from './ask-observability/index.js';
import type { AskTraceObserverV1, AgentRunTraceReferenceV1, AskTraceSurfaceV1 } from './ask-observability/index.js';
import { nonMeasureColumnRole, readEnv } from '@zlens/core';

export type AgentRunRequestedMode = "auto" | "ask" | "research" | "sql" | "block" | "app" | "modeling" | "skill";

/**
 * Who the run serves. `analyst` (the Notebook) keeps every route, including
 * authoring (sql_cell, dql_block_draft). `stakeholder` (Chat / Apps / Research)
 * is consumption-only: authoring routes collapse to a governed answer and the
 * run offers a "request certification" handoff instead of inline authoring.
 */
export type AgentRunAudience = "stakeholder" | "analyst";

/** Routes a stakeholder may never land on (analyst authoring lives in the Notebook). */
const ANALYST_ONLY_ROUTES = new Set<AgentRunRoute>(["sql_cell", "dql_block_draft", "modeling_draft", "skill_draft"]);

export type AgentRunRoute =
  | "conversation"
  | "certified_answer"
  | "semantic_answer"
  | "generated_answer"
  | "research"
  | "sql_cell"
  | "dql_block_draft"
  | "modeling_draft"
  | "skill_draft"
  | "app_build"
  | "clarify"
  /** Terminal sentinel used when cancellation happens before a route is chosen. */
  | "cancelled"
  | "blocked";

export interface ResolvedPlanShadowComparison {
  planId: string;
  fingerprint: string;
  plannedRoute: AgentRunRoute;
  actualRoute: AgentRunRoute;
  matches: boolean;
}

/**
 * Compare the pre-execution plan with the selected route without changing it.
 * Authoritative plans never emit or persist this migration-only diagnostic.
 * Acceptance: AGT-013, API-006.
 */
export function compareResolvedPlanShadow(
  decision: IntentDecision,
  actualRoute: AgentRunRoute,
): ResolvedPlanShadowComparison | undefined {
  const plan = decision.resolvedAnalyticalPlan;
  if (!plan || plan.mode !== 'shadow') return undefined;
  const plannedRoute: AgentRunRoute = decision.action === 'investigate'
    ? 'research'
    : plan.capability === 'certified_execution'
    ? 'certified_answer'
    : plan.capability === 'semantic_execution'
      ? 'semantic_answer'
      : plan.capability === 'governed_relational'
        ? 'generated_answer'
        : plan.capability === 'bounded_exploration'
          ? 'research'
          : 'blocked';
  return {
    planId: plan.planId,
    fingerprint: plan.fingerprint,
    plannedRoute,
    actualRoute,
    matches: plannedRoute === actualRoute,
  };
}

/**
 * How the run's answer should be read for trust. `governed` is the default (a
 * data answer grounded in certified/generated SQL). `conversational` and
 * `general_knowledge` mark replies that do NOT come from the warehouse — the UI
 * renders them as plain chat and never attaches a data-trust badge.
 */
export type AgentRunAnswerKind = "governed" | "conversational" | "general_knowledge";

export type AgentRunStatus = "completed" | "needs_review" | "needs_clarification" | "cancelled" | "blocked";
export type AgentRunTrustState = "certified" | "governed" | "grounded" | "review_required" | "blocked" | "not_applicable";
export type AgentRunLifecycleState = "queued" | "running" | "cancelling" | "terminal";

/**
 * Durable lifecycle for an accepted run. This is intentionally separate from
 * `AgentRunStatus`, which remains the terminal analytical outcome.
 *
 * Acceptance: API-008, UI-014.
 */
export interface AgentRunLifecycleV1 {
  version: 1;
  state: AgentRunLifecycleState;
  phase: AgentRunEvent["type"] | "queued";
  revision: number;
  eventCursor: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type AgentRunStopReason =
  | "conversational_reply"
  | "certified_answer_found"
  | "governed_semantic_answer"
  | "governed_compound_answer"
  | "generated_review_required"
  | "artifact_created"
  | "needs_clarification"
  | "human_review_required"
  | "cancelled"
  | "blocked";

/** Stable host-issued reason for a user cancellation. Provider AbortErrors do
 * not carry this code and therefore remain distinguishable executor failures. */
export const AGENT_RUN_USER_CANCEL_CODE = "RUN_CANCELLED" as const;

export function createAgentRunCancellationError(): Error & { code: typeof AGENT_RUN_USER_CANCEL_CODE } {
  return Object.assign(new Error("Stopped by user."), { code: AGENT_RUN_USER_CANCEL_CODE });
}

export function isAgentRunUserCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === AGENT_RUN_USER_CANCEL_CODE;
}

export type AgentRunArtifactKind =
  | "answer"
  | "research_run"
  | "sql_cell"
  | "dql_block_draft"
  | "app_draft"
  | "modeling_change_proposal"
  | "skill_change_proposal"
  /** Two-phase app build: the confirmable pre-create content list. */
  | "app_proposal"
  /** A reviewed App Studio mutation carried by the universal App Autopilot run. */
  | "app_autopilot_change";

export type AgentRunEvaluationSeverity = "info" | "warning" | "blocking";

/**
 * How the loop should react when an evaluation fails.
 * - `retry`   → re-run the same route with the repair hint (the executor owns
 *   the actual repair, e.g. the answer-loop SQL repair or reflect-before-certify).
 * - `escalate`→ switch to a different route (e.g. answer that can't be grounded
 *   escalates to research; an app build with no coverage escalates to a block draft).
 * When omitted, a failing evaluation is terminal for its severity.
 */
export interface AgentRunRepairAction {
  kind: "retry" | "escalate";
  route?: AgentRunRoute;
  hint?: string;
}

export interface AgentRunEvaluation {
  id: string;
  label: string;
  passed: boolean;
  severity: AgentRunEvaluationSeverity;
  message: string;
  evidence?: unknown;
  /** Human-facing repair suggestion; presence also marks the eval as actionable. */
  suggestedRepair?: string;
  /** Machine-facing remediation the engine loop should attempt. */
  repairAction?: AgentRunRepairAction;
}

export interface AgentRunArtifact {
  id: string;
  kind: AgentRunArtifactKind;
  title: string;
  trustState: AgentRunTrustState;
  ref?: string;
  payload?: unknown;
  /**
   * The content address (`sha256:` of the canonical JSON) of `payload` in
   * the run store. A persisted run keeps the address and the store hydrates
   * `payload` on `get`; an index listing carries the address alone.
   */
  payloadRef?: string;
}

export interface AgentRunDiagnosticFailureV1 {
  code: string;
  phase: string;
  message: string;
  recoverable: boolean;
  safeActions: string[];
}

/**
 * One stable presentation receipt for successful and failed executable runs.
 * Detailed analytical contracts stay on their original artifact; this receipt
 * binds them to the immutable run trace and prevents an outer executor failure
 * from erasing the plan/steps already produced.
 *
 * Acceptance: API-007, UI-012, UI-013, SEC-004.
 */
export interface AgentRunDiagnosticReceiptV1 {
  version: 1;
  runId: string;
  phase: string;
  route?: AgentRunRoute;
  /** Snapshot-bound analytical plan; distinct from the orchestration step plan. */
  resolvedAnalyticalPlan?: IntentDecision["resolvedAnalyticalPlan"];
  plan?: AgentRunPlan;
  steps: AgentRunStep[];
  artifacts: AgentRunArtifact[];
  evaluations: AgentRunEvaluation[];
  failure?: AgentRunDiagnosticFailureV1;
  repairCapability?: AnalyticalRepairCapabilityV1;
  providerEgressReceipts?: ProviderEgressReceiptV1[];
}

/** Content-free additive diagnostics; V1 remains readable for legacy detail. */
export interface AgentRunDiagnosticReceiptV2 {
  version: 2;
  runId: string;
  route?: AgentRunRoute;
  status: AgentRunStatus;
  telemetry: AgentRunTelemetryV1;
  providerEgressReceiptFingerprints: string[];
  repairCapabilityFingerprint?: string;
}

/**
 * Durable, content-free outcome of the answer narration stage.
 *
 * This receipt is deliberately independent of the rendered prose and result
 * rows: an evaluator must never infer that narration was attempted from either
 * of those presentation details. It lets the host distinguish a verified
 * narrative, a clearly labelled deterministic floor, an intentional skip, and
 * an infrastructure failure after the run is persisted.
 */
export interface NarrationIntegrityReceiptV1 {
  version: 1;
  mode: "skip" | "verified_facts" | "preview_grounded";
  outcome: "skipped" | "success" | "deterministic_fallback" | "error";
  /** A provider-backed narration invocation actually began. */
  attempted: boolean;
  /** Count only for fact-verified narration; never contains result values. */
  factCount: number;
  maxRows: number;
  /** Stable verifier codes, not provider prose or raw result values. */
  validationFailures: string[];
  /**
   * Ordinary Ask answers keep their deterministic, receipt-bound answer text.
   * Only an explicit Research run may dispatch a provider narrator or send
   * result rows after execution.
   */
  skipReason?: "no_answer" | "no_provider" | "nothing_to_narrate" | "ordinary_ask";
  /** Stable host code only; raw provider errors are intentionally not persisted. */
  errorCode?: "narration_error";
}

export interface AgentRunNextAction {
  id: string;
  label: string;
  route?: AgentRunRoute;
  artifactKind?: AgentRunArtifactKind;
}

export interface AgentRunClarificationOption {
  /** Stable retrieved evidence ID; display text must never be used as identity. */
  id: string;
  label: string;
  description?: string;
  kind?: string;
  /** Question to resubmit while the stable option id carries the chosen binding. */
  question?: string;
}

export interface AgentRunSelectedObject {
  kind: "notebook" | "cell" | "block" | "app" | "dashboard" | "research" | "workspace" | "domain" | "model_area" | "model" | "relationship" | "skill";
  id?: string;
  title?: string;
  path?: string;
}

export type AgentRunExecutionTarget =
  | { target: "connection"; connectionName?: string }
  | { target: "local" };

/**
 * Host-only lineage for a bounded Ask child composed by an explicit Research
 * run. This is deliberately separate from `workspaceContext`: it changes
 * dispatch accounting but is never hydrated from public JSON. The child still
 * routes its own question through the normal Ask cascade; the marker only
 * binds physical provider traffic to the already-admitted Research root.
 */
export interface AgentRunResearchBranchV1 {
  rootRunId: string;
  childRunId: string;
  branchId: string;
  index: number;
}

/**
 * Server-owned execution handoff for one already-verified ordinary Ask task.
 *
 * This is deliberately separate from the legacy `workspaceContext`
 * `analyticalTaskChild` marker.  The latter was introduced for the old
 * compound scheduler and only prevents recursive scheduling; it does not bind
 * a frozen AskAnalyst task to its task-local question.  Public request parsers
 * must never hydrate this object.  The original parent question remains on the
 * outer run for conversation and trace persistence only.
 */
export interface AgentRunAskAnalystTaskChildV1 {
  version: 1;
  taskId: string;
  question: string;
  instructions: string[];
}

/**
 * Server-owned continuity constraint reconstructed from a persisted thread
 * result.  It is deliberately not accepted at public ingress: the values are
 * an immutable execution filter only after the host proves their source turn
 * and result binding.  Keeping the display dimension and result fingerprint
 * beside the host requirement seed makes a plural follow-up such as "those
 * customers" auditable without making prior rows provider context.
 */
export interface AgentRunPriorResultMemberBindingV1 {
  version: 1;
  displayDimension: string;
  values: string[];
  sourceTurnId?: string;
  resultFingerprint?: string;
}

export interface AgentRunRequest {
  question: string;
  /**
   * Host-only requirement seed for an internally composed child Ask. Public
   * JSON request parsers must never hydrate this field. It lets a bounded
   * Research hypothesis retain its planner-selected target tuple without
   * re-parsing planner prose as additional user measures.
   */
  hostRequirementSeed?: AnalyticalRequirementSeedV1;
  /**
   * Host-only exact-existence probe over the project's allowlisted physical
   * columns (`agent.runtimeValueGrounding`). Public JSON parsers must never
   * hydrate this; the local server attaches it so the host-first binder can
   * ground a member literal without a provider dispatch.
   */
  probeAllowlistedLiteral?: (literal: string) => Promise<{
    status: 'matched' | 'no_match' | 'ambiguous' | 'disabled' | 'unavailable';
    matches: Array<{ relation: string; column: string; canonicalValue: string }>;
  }>;
  /**
   * Host-only whole-catalog term lookup. Retention-bounded evidence must
   * never authorize a "not modeled" claim on its own.
   */
  catalogTermMentioned?: (term: string) => Promise<boolean>;
  /**
   * Host-only shape continuity from one completed, result-backed Ask turn.
   * HTTP/MCP parsers must never accept this: it is emitted only after the
   * local conversation store proves the source turn and result fingerprint.
   */
  trustedTaskAnchor?: TrustedAnalyticalTaskAnchorV1;
  /**
   * Host-only Ask Analyst state. The authoritative runtime creates this before
   * the legacy compiler broker runs; public JSON parsers must never hydrate it.
   */
  askAnalystState?: AskAnalystState;
  /** Immutable route-neutral program built by AskAnalystRuntimeV1. */
  askAnalystProgram?: AnalyticalProgram;
  /** Runtime-owned, validated meaning selection. Compiler brokers may not replace it. */
  askAnalystMeaningResolution?: MeaningResolution;
  /** Snapshot-scoped readiness supplied before compiler selection. */
  askAnalystTierReadiness?: {
    connector: 'ready' | 'unavailable' | 'unknown';
    activeTarget: 'ready' | 'unavailable' | 'unknown';
    semanticCompiler: 'ready' | 'unavailable' | 'unknown';
    semanticCandidateReadiness?: Array<{
      candidateId: string;
      status: 'ready' | 'unavailable' | 'unknown';
      engines?: Array<'native' | 'metricflow-cli' | 'dbt-cloud'>;
      nativeCompilerProven?: boolean;
    }>;
    physicalSchema: 'ready' | 'unavailable' | 'unknown';
    targetFingerprint?: string;
  };
  /** Host-only checkpoint hook; public JSON input never hydrates runtime state. */
  askAnalystCheckpoint?: (state: AskAnalystState) => void;
  /** Runtime-owned frozen execution plan; engine must consume it verbatim. */
  askAnalystFrozenPlan?: AgentRunPlan;
  /** Same-snapshot retrieval handoff from the Ask runtime to the compiler broker. */
  askAnalystEvidence?: AgentRetrievalEvidence;
  /**
   * Host-only V2 runtime handoff. Public ingress cannot select the migration
   * mode or inject a snapshot/agent state; the router creates this after the
   * one immutable retrieval boundary.
   */
  askAgentRuntimeMode?: AskRuntimeModeV2;
  /**
   * Server-owned frozen-task execution boundary.  It makes the child question
   * authoritative for compiler/executor input while preserving the submitted
   * parent question only on the outer persisted run and trace.
   */
  askAnalystTaskChild?: AgentRunAskAnalystTaskChildV1;
  /**
   * Server-owned explicit Research-child lineage. Public request parsers must
   * never hydrate it. It grants no route or SQL authority: each child still
   * needs its own frozen analytical plan and selected closure.
   */
  researchBranch?: AgentRunResearchBranchV1;
  /** Exact candidate selected from a prior structured clarification. */
  selectedEvidenceId?: string;
  /**
   * Server-validated reference to a row/value in a persisted prior result.
   * It is additive to ordinary conversation context and never an execution
   * authority by itself.
   */
  selectedResultBinding?: AgentSelectedResultBindingV1;
  /**
   * Server-reconstructed plural prior-result constraint. Public JSON parsers
   * must never hydrate this field; the host materializes it from a persisted
   * conversation thread before the Ask runtime frames the question.
   */
  priorResultMemberBinding?: AgentRunPriorResultMemberBindingV1;
  /**
   * Host-only terminal diagnostic when a selected result cannot be re-bound.
   *
   * `options` carries the members the reference could have meant. An ambiguous
   * singular reference is answerable the moment the user says which one they
   * meant, so a gap that can offer choices becomes a clarification rather than
   * a dead end.
   */
  selectedResultBindingGap?: { code: string; message: string; options?: AgentRunClarificationOption[] };
  /**
   * When `question` is a clarification continuation, the user's ORIGINAL
   * analytical question. Used for artifact naming and planning so the
   * clarification prose in `question` does not leak into either.
   */
  clarificationSourceQuestion?: string;
  requestedMode?: AgentRunRequestedMode;
  /** Explicit, per-run Research consent. Never inherited by later runs. */
  researchResultRowsOptIn?: boolean;
  /** Defaults to "analyst" (Notebook). Stakeholder surfaces pass "stakeholder". */
  audience?: AgentRunAudience;
  intent?: MetadataAgentIntent;
  signals?: IntentSignals;
  selectedObject?: AgentRunSelectedObject;
  /** Explicit data target. All planning, metadata, compilation, and execution for this run use it. */
  executionTarget?: AgentRunExecutionTarget;
  workspaceContext?: Record<string, unknown>;
  conversationContext?: Record<string, unknown>;
  /** Server-owned admission result for prior conversation material. */
  conversationBinding?: AgentConversationBindingV1;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Server-side conversation thread this run belongs to (persistence + resume). */
  threadId?: string;
  runId?: string;
  /** Optional run-specific model effort. Hosts should still apply provider/settings ceilings. */
  reasoningEffort?: ReasoningEffort;
  /** Optional run-specific context depth for governed answer retrieval and prompting. */
  analysisDepth?: CascadeAnalysisDepth;
  /**
   * The user's chat-composer "thinking" selection for this thread. `auto` (or
   * unset) defers to shape-adaptive routing; `low`/`medium`/`high` resolve to an
   * effort+depth bundle via `resolveThinkingMode`. Explicit `reasoningEffort` /
   * `analysisDepth` above (e.g. CLI flags) take precedence over this.
   */
  thinkingMode?: ThinkingMode;
  /** Host-only cancellation signal. JSON request parsers must never hydrate it. */
  signal?: AbortSignal;
  /**
   * Server-owned trace surface. Public request parsers must never hydrate it;
   * local runtime admission derives it from a per-runtime capability instead.
   */
  traceSurface?: AskTraceSurfaceV1;
  /**
   * Host-only single wall-clock authority. Soft targets stop new discovery;
   * only `hardSignal` cancels a frozen plan/compile/execution. JSON parsers
   * must never hydrate this object.
   */
  runBudget?: AgentRunBudget;
}

export interface AgentRunBudget {
  readonly startedAtMs: number;
  readonly hardDeadlineMs: number;
  readonly hardSignal: AbortSignal;
  readonly mode: 'ask' | 'research';
  elapsedMs(): number;
  remainingMs(): number;
  softTargetMs(route: AgentRunRoute): number;
  mayStartDiscovery(route: AgentRunRoute): boolean;
  /**
   * Narration runs AFTER the result has settled, so it cannot share the route's
   * discovery target — a certified route finishes inside its 5s window and would
   * then be refused the one dispatch that turns those rows into a sentence.
   */
  narrationSoftTargetMs(): number;
  mayStartNarration(): boolean;
  /**
   * Wall clock held back from the analyst and its narration so the host floor
   * — the tier ladder the host walks itself when the analyst's turn ends with
   * nothing executed — always has room to run one governed query.
   */
  hostFloorReserveMs: number;
  mayStartHostFloor(): boolean;
}

export interface AgentRunEvent {
  id: string;
  runId: string;
  type:
    | "run.started"
    | "plan.created"
    | "step.started"
    | "route.decided"
    | "executor.started"
    | "evaluation.recorded"
    | "replan.decided"
    | "repair.attempted"
    | "escalated"
    | "artifact.created"
    | "step.completed"
    | "run.completed"
    | "run.cancelled"
    | "run.failed";
  at: string;
  message: string;
  route?: AgentRunRoute;
  status?: AgentRunStatus;
  trustState?: AgentRunTrustState;
  payload?: unknown;
}

/** A single planned step (the plan is an ordered list of these). */
export interface AgentRunPlannedStep {
  id: string;
  route: AgentRunRoute;
  goal: string;
  successCriteria: string[];
  /**
   * Server-owned analytical task identity for a compound authoritative Ask.
   * It is absent for legacy/LLM plans and public request payloads cannot mint
   * it.  When present, the engine swaps in the matching immutable task
   * program, meaning resolution, readiness, and cascade receipt.
   */
  askAnalystTaskId?: string;
}

export type AgentRunPlanSource = "llm" | "deterministic";

export interface AgentRunPlan {
  source: AgentRunPlanSource;
  rationale: string;
  steps: AgentRunPlannedStep[];
}

export type AgentRunStepStatus =
  | "passed"
  | "repaired"
  | "needs_review"
  | "escalated"
  | "clarify"
  | "blocked";

/** A step after it has executed — carries its evaluations + artifacts for the trace. */
export interface AgentRunStep {
  id: string;
  index: number;
  route: AgentRunRoute;
  /** Server-owned frozen Ask task binding when this step is a compound child. */
  askAnalystTaskId?: string;
  resolvedRoute?: AgentRunRoute;
  goal: string;
  successCriteria: string[];
  status: AgentRunStepStatus;
  attempts: number;
  summary?: string;
  evaluations: AgentRunEvaluation[];
  artifacts: AgentRunArtifact[];
}

/** Immutable provenance for a user-triggered derived execution. */
export interface AgentRunDerivationV1 {
  version: 1;
  kind: "analytical_repair" | "authoring_revision";
  sourceRunId: string;
  sourceFailureId?: string;
  sourceArtifactId?: string;
  attempt: number;
  revision?: number;
}

export interface AgentRun {
  id: string;
  question: string;
  requestedMode: AgentRunRequestedMode;
  /** Additive durable binding receipt for the question that produced this run. */
  conversationBinding?: AgentConversationBindingV1;
  route: AgentRunRoute;
  status: AgentRunStatus;
  trustState: AgentRunTrustState;
  stopReason: AgentRunStopReason;
  startedAt: string;
  completedAt: string;
  selectedObject?: AgentRunSelectedObject;
  /** Exact data target used for planning, compilation, and execution. */
  executionTarget?: AgentRunExecutionTarget;
  routeDecision?: IntentDecision;
  plan?: AgentRunPlan;
  steps: AgentRunStep[];
  summary: string;
  answer?: string;
  /**
   * The host keeps this answer's figures from this person until someone
   * checks it (RFC 0010 HH-14): the run holds what it is built on, never a value.
   */
  figuresWithheld?: boolean;
  /**
   * Team documents the answer read (knowledge sources, RFC 0010 HH-15): a
   * figure-free note and citations. Context only — never part of trust.
   */
  knowledge?: AgentRunKnowledgeV1;
  /** How to read `answer` for trust; defaults to "governed". */
  answerKind?: AgentRunAnswerKind;
  artifacts: AgentRunArtifact[];
  evaluations: AgentRunEvaluation[];
  events: AgentRunEvent[];
  nextActions: AgentRunNextAction[];
  clarificationOptions?: AgentRunClarificationOption[];
  /** Same-lane repair reruns. Escalations are tracked separately. */
  repairAttempts: number;
  /** Engine-level route escalations, separate from same-lane repairs. */
  escalationAttempts?: number;
  /** Visible budget model and spend for audits/traces. */
  budgetUsage?: CascadeBudgetTrace;
  lifecycle?: AgentRunLifecycleV1;
  diagnosticReceipt?: AgentRunDiagnosticReceiptV1;
  diagnosticReceiptV2?: AgentRunDiagnosticReceiptV2;
  /** Additive content-free cascade/provider receipt; V1/V2 remain readable. */
  diagnosticReceiptV3?: AgentRunDiagnosticReceiptV3;
  /** Additive canonical Ask story. Older V1/V2/V3 receipts remain readable. */
  diagnosticReceiptV4?: AgentRunDiagnosticReceiptV4;
  /** Additive V1.15 runtime/state/fact receipt; V1-V4 remain readable. */
  diagnosticReceiptV5?: AgentRunDiagnosticReceiptV5;
  /** Additive retrieval-first Ask story. V1-V5 remain readable. */
  diagnosticReceiptV6?: AgentRunDiagnosticReceiptV6;
  /** Additive concise Ask inspector. V1-V6 remain readable. */
  /** Additive V2 tool-runtime receipt. V1-V6 readers remain unchanged. */
  diagnosticReceiptV8?: AgentRunDiagnosticReceiptV8;
  /** Additive Ask-pipeline receipt: intent, every prepared candidate and refusal, the executed SQL fingerprint, verbatim failures. */
  diagnosticReceiptV9?: AskPipelineReceiptV9;
  /** Server-owned Ask rollout mode that produced this run; old runs omit it. */
  askAgentRuntimeMode?: AskRuntimeModeV2;
  /** Fact-driven result envelope generated after the accepted executor result. */
  businessAnswer?: BusinessAnswer;
  /** Typed Ask runtime state retained across persistence/reload. */
  askAnalystState?: AskAnalystState;
  narrationIntegrityReceipt?: NarrationIntegrityReceiptV1;
  telemetry?: AgentRunTelemetryV1;
  /** Server-owned automatic repair authority. Legacy runs omit it and fail closed. */
  repairCapability?: AnalyticalRepairCapabilityV1;
  /** Content-free provider payload evidence. */
  providerEgressReceipts?: ProviderEgressReceiptV1[];
  /** The source run remains immutable; repaired executions are new runs. */
  derivation?: AgentRunDerivationV1;
  /** Turn-level clause graph and per-clause outcomes for conversational analytics. */
  analyticalTurnPlan?: AnalyticalTurnPlanV1;
  analyticalTaskOutcomes?: AnalyticalTaskOutcomeV1[];
  /** Additive compound-Ask status; legacy runs omit this field. */
  analyticalTaskOutcomeSummary?: AnalyticalTaskOutcomeSummaryV1;
  /** Additive local trace reference; detailed evidence stays in ask-observability.sqlite. */
  traceReference?: AgentRunTraceReferenceV1;
  /** Who asked, when a host signs people in (RFC 0010); local runs omit it. */
  ownerId?: string;
  /**
   * The durable review draft a review-required (Tier-2) answer left behind,
   * so a person can review and certify it. The executed `dqlArtifact` stays
   * transient (it is the execution receipt); this is a separate saved copy.
   */
  reviewDraft?: AgentRunReviewDraftV1;
}

export interface AgentRunReviewDraftV1 {
  version: 1;
  /** Project-relative `.dql` path under `blocks/_drafts/` or `domains/<d>/blocks/_drafts/`. */
  path: string;
  /** Always draft: capturing an answer never certifies it. */
  status: 'draft';
  /** How many times this answer (by SQL fingerprint or question) was asked. */
  askedTimes: number;
  /** False when an existing draft was reused (de-duplicated). */
  created: boolean;
  /** sha256 of the normalized answer SQL. */
  fingerprint: string;
}

/**
 * Lightweight durable state written while a run is executing. It deliberately
 * excludes answer deltas and raw result rows; those remain transient until the
 * terminal, gate-accepted AgentRun is saved.
 *
 * Acceptance: API-008, UI-014, PERF-002, SEC-004.
 */
export interface AgentRunProgressV1 {
  version: 1;
  id: string;
  question: string;
  requestedMode: AgentRunRequestedMode;
  selectedObject?: AgentRunSelectedObject;
  executionTarget?: AgentRunExecutionTarget;
  route?: AgentRunRoute;
  trustState?: AgentRunTrustState;
  plan?: AgentRunPlan;
  steps: AgentRunStep[];
  artifacts: AgentRunArtifact[];
  evaluations: AgentRunEvaluation[];
  events: AgentRunEvent[];
  lifecycle: AgentRunLifecycleV1;
  analyticalTurnPlan?: AnalyticalTurnPlanV1;
  analyticalTaskOutcomes?: AnalyticalTaskOutcomeV1[];
  analyticalTaskOutcomeSummary?: AnalyticalTaskOutcomeSummaryV1;
  /** Typed local continuation checkpoint; not part of public trace export. */
  askAnalystState?: AskAnalystState;
  /** Allows restart finalization/UI to find the local trace without shipping spans. */
  traceReference?: AgentRunTraceReferenceV1;
  /** Who asked, when a host signs people in (RFC 0010); local runs omit it. */
  ownerId?: string;
}

export interface AgentRouteExecutionContext {
  runId: string;
  request: AgentRunRequest;
  route: AgentRunRoute;
  routeDecision?: IntentDecision;
  maxRepairAttempts: number;
  /** 0 on the first build of a step; increments on each repair re-run. */
  attempt: number;
  /** The goal the planner assigned to this step. */
  stepGoal?: string;
  /** Evaluations from the previous attempt (so executors can target the repair). */
  priorEvaluations?: AgentRunEvaluation[];
  /**
   * Artifacts this run has already validated. Read when the discovery budget
   * elapses, so partial findings can be returned instead of thrown away.
   */
  priorArtifacts?: AgentRunArtifact[];
  /** The repair hint the loop wants this re-run to act on. */
  repairHint?: string;
  emit: (event: Omit<AgentRunEvent, "id" | "runId" | "at">) => void;
  /**
   * Stream answer text to the client as it is generated. Deltas are transient
   * (never persisted on the run) — the final `answer` remains authoritative.
   * A no-op when the host did not wire streaming.
   */
  emitAnswerDelta?: (delta: string) => void;
}

export interface AgentRouteExecutorResult {
  summary?: string;
  answer?: string;
  /**
   * Route resolved by a deeper executor-owned cascade. For example, Ask mode may
   * execute through the generated-answer route, then the answer loop can prove
   * the result came from a certified block.
   */
  resolvedRoute?: AgentRunRoute;
  /**
   * Cascade tier that actually produced the answer (certified_block /
   * semantic_metric / generated_sql / business_context / no_answer). Lets the
   * engine short-circuit on a governed tier even when the route was generated_answer.
   */
  answerTier?: string;
  /** Canonical host result retained only for the executor-to-engine boundary. */
  result?: unknown;
  /** How to read `answer` for trust; defaults to "governed". */
  answerKind?: AgentRunAnswerKind;
  status?: AgentRunStatus;
  trustState?: AgentRunTrustState;
  stopReason?: AgentRunStopReason;
  /**
   * When this result is a governed no-answer, the reason the answer loop refused —
   * so the gate can distinguish a genuine clarify (`ambiguous`) from a retryable
   * decline (`model_declined`) or grounding gap without inspecting prose. Absent
   * for any successful answer.
   */
  answerRefusalCode?: 'grounding_gap' | 'modeling_gap' | 'no_data' | 'ambiguous' | 'model_declined' | 'provider_error' | 'orchestration_budget_exhausted' | 'policy_blocked' | 'execution_error';
  artifacts?: AgentRunArtifact[];
  evaluations?: AgentRunEvaluation[];
  nextActions?: AgentRunNextAction[];
  /** Executor-discovered ambiguity options, such as MetricFlow entity paths. */
  clarificationOptions?: AgentRunClarificationOption[];
  repairAttempts?: number;
  providerEgressReceipts?: ProviderEgressReceiptV1[];
  /** The Ask pipeline's receipt; the engine persists it on the run root as `diagnosticReceiptV9`. */
  askPipelineReceipt?: AskPipelineReceiptV9;
  telemetry?: AgentRunTelemetryV1;
  /** Content-free narration outcome; persisted by the run engine. */
  narrationIntegrityReceipt?: NarrationIntegrityReceiptV1;
  /**
   * A physical provider boundary discovered by the serving executor.  The
   * engine persists it on the route decision so receipts do not have to infer
   * a provider outage from a reader-facing no-answer sentence.
   */
  providerFailure?: ProviderFailureDiagnosticV1;
  /**
   * Explicit host-owned evidence that a router-selected exploratory proposal
   * was validated and bound to one immutable execution capability. The engine
   * consumes this receipt; it never infers a freeze from a route label or ID.
   */
  analyticalExecutionFreeze?: ExploratoryExecutionFreezeV1;
  /** One bounded same-plan repair receipt, never a replacement route/plan. */
  analyticalExecutionRepairFreeze?: ExploratoryExecutionFreezeV1;
  analyticalTurnPlan?: AnalyticalTurnPlanV1;
  analyticalTaskOutcomes?: AnalyticalTaskOutcomeV1[];
  /** Optional executor update to the runtime state after a fact-backed result. */
  askAnalystState?: AskAnalystState;
  businessAnswer?: BusinessAnswer;
  /** Team documents the answer read; persisted as the run's `knowledge`, never read for trust. */
  knowledge?: AgentRunKnowledgeV1;
}

export type AgentRouteExecutor = (
  context: AgentRouteExecutionContext,
) => AgentRouteExecutorResult | Promise<AgentRouteExecutorResult>;

export type AgentRunExecutors = Partial<Record<AgentRunRoute, AgentRouteExecutor>>;

/** A gate evaluates an executed step's result and returns authoritative evaluations. */
export interface AgentRunGateContext {
  route: AgentRunRoute;
  request: AgentRunRequest;
  routeDecision?: IntentDecision;
  result: AgentRouteExecutorResult;
  attempt: number;
}

export type AgentRunGate = (context: AgentRunGateContext) => AgentRunEvaluation[];

export type AgentRunGates = Partial<Record<AgentRunRoute, AgentRunGate>>;

export interface AgentRunPlanInput {
  request: AgentRunRequest;
  routeDecision: IntentDecision;
  defaultRoute: AgentRunRoute;
  maxSteps: number;
  audience: AgentRunAudience;
}

export interface AgentRunReplanInput {
  request: AgentRunRequest;
  plan: AgentRunPlan;
  currentStep: AgentRunStep;
  remainingSteps: AgentRunPlannedStep[];
  attemptsUsed: number;
  repairAttemptsUsed: number;
  maxRepairAttempts: number;
  engineEscalationsUsed?: number;
  maxEngineEscalations?: number;
  budgetUsage?: CascadeBudgetTrace;
}

export type AgentRunReplanDecision =
  | { decision: "accept" }
  | { decision: "repair"; repairHint: string }
  | { decision: "escalate"; route: AgentRunRoute; goal?: string; repairHint?: string }
  | { decision: "clarify"; question?: string };

export interface AgentRunPlanner {
  plan(input: AgentRunPlanInput): AgentRunPlan | Promise<AgentRunPlan>;
  replan(input: AgentRunReplanInput): AgentRunReplanDecision | Promise<AgentRunReplanDecision>;
}

export interface AgentRunStore {
  save(run: AgentRun): void | Promise<void>;
  get(id: string): AgentRun | undefined | Promise<AgentRun | undefined>;
  list?(): AgentRun[] | Promise<AgentRun[]>;
  saveProgress?(progress: AgentRunProgressV1): void | Promise<void>;
  getProgress?(id: string): AgentRunProgressV1 | undefined | Promise<AgentRunProgressV1 | undefined>;
}

/**
 * An injectable router that decides the high-level action for a request. When
 * present the engine awaits it instead of the built-in deterministic decision;
 * a forced `requestedMode` still bypasses routing entirely. The router itself is
 * responsible for its own fallback (heuristics) when an LLM is unavailable.
 */
export interface AgentRouter {
  decide(request: AgentRunRequest): IntentDecision | Promise<IntentDecision>;
}

export interface AgentRunEngineOptions {
  executors?: AgentRunExecutors;
  gates?: AgentRunGates;
  planner?: AgentRunPlanner;
  router?: AgentRouter;
  store?: AgentRunStore;
  idGenerator?: () => string;
  now?: () => Date;
  maxRepairAttempts?: number;
  maxEngineEscalations?: number;
  budgets?: PartialCascadeBudgetModel;
  maxSteps?: number;
  /** Injectable for deterministic deadline tests; production uses AbortSignal.timeout. */
  routeTimeoutSignal?: (durationMs: number) => AbortSignal;
  /**
   * How the ingress policy screens personal data (analytical-request-policy.ts):
   * by wording (default) or, when a host refuses by column, `columns`.
   */
  sensitiveQuestions?: 'wording' | 'columns';
  /**
   * Runtime-owned trace factory. It is additive and must return a no-op observer
   * on any local store fault; the engine never waits for a network exporter.
   */
  traceObserverFactory?: (input: {
    runId: string;
    request: AgentRunRequest;
    startedAt: string;
    requestedMode: AgentRunRequestedMode;
  }) => AskTraceObserverV1 | undefined;
}

const DEFAULT_MAX_STEPS = 4;

export function agentRouteDeadlineMs(route: AgentRunRoute): number | undefined {
  if (route === 'certified_answer' || route === 'semantic_answer') return 5_000;
  if (route === 'clarify') return 10_000;
  // Generation may now take a genuine tool round (look something up, then use
  // it) instead of a single blind shot, so the discovery window has to cover it.
  // Subscription-CLI providers cost roughly 10-15s per dispatch, so a window
  // under ~30s silently reduces the loop back to a single blind attempt.
  if (route === 'generated_answer') return 30_000;
  if (route === 'research') return 180_000;
  return undefined;
}

/** Default request-ingress deadlines. */
const DEFAULT_ASK_DEADLINE_MS = 45_000;
/** An investigation runs a dozen or more governed queries, some drafted by the AI, so Research gets three minutes. */
const DEFAULT_RESEARCH_DEADLINE_MS = 180_000;
/** Ceiling on any override, so a typo cannot hang a run indefinitely. */
const MAX_DEADLINE_MS = 600_000;

/**
 * A deadline multiplier for slow providers.
 *
 * The 45s Ask budget assumes a hosted model. A local Ollama model needs ~7s for
 * a one-word reply, so the meaning call alone can exhaust the whole window and
 * every question comes back "The discovery window ended before an exact plan was
 * frozen" — which makes a local model unusable at the default, and DQL is
 * local-first by design.
 *
 * Deliberately a MULTIPLIER rather than an absolute: the relationship between
 * the Ask and Research budgets, and between each and its soft targets, is
 * load-bearing, so scaling keeps them proportional instead of letting one
 * setting invert them.
 */
/**
 * Host-registered default scale, set from the ACTIVE provider's latency
 * class. ZLens knows a local Ollama model or a subscription-CLI passthrough
 * costs 10-90s per dispatch; making every user of a slow provider discover
 * an environment variable turned that knowledge into a support ticket. An
 * explicit ZLENS_AGENT_DEADLINE_SCALE still wins over this default.
 */
let processDefaultDeadlineScale = 1;

export function setProcessDefaultDeadlineScale(scale: number): void {
  processDefaultDeadlineScale = Number.isFinite(scale) ? Math.min(Math.max(scale, 1), 20) : 1;
}

export function deadlineScale(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(readEnv('ZLENS_AGENT_DEADLINE_SCALE', env));
  if (!Number.isFinite(raw) || raw <= 0) return processDefaultDeadlineScale;
  // Bounded: below 1 would tighten a safety deadline someone is relying on.
  return Math.min(Math.max(raw, 1), 20);
}

/** The request envelope starts before retrieval/routing, so a stuck router can
 * never evade the route-specific deadline that is selected later. */
export function agentRequestDeadlineMs(requestedMode: AgentRunRequestedMode): number {
  const base = requestedMode === 'research' ? DEFAULT_RESEARCH_DEADLINE_MS : DEFAULT_ASK_DEADLINE_MS;
  return Math.min(base * deadlineScale(), MAX_DEADLINE_MS);
}

/** Create the one request-ingress deadline authority used by every stage. */
export function createAgentRunBudget(input: {
  requestedMode?: AgentRunRequestedMode;
  startedAtMs?: number;
  inheritedSignal?: AbortSignal;
  timeoutSignal?: (durationMs: number) => AbortSignal;
  /** Injectable monotonic wall clock for deterministic soft-boundary tests. */
  nowMs?: () => number;
}): AgentRunBudget {
  const nowMs = input.nowMs ?? Date.now;
  const startedAtMs = input.startedAtMs ?? nowMs();
  const mode = input.requestedMode === 'research' ? 'research' as const : 'ask' as const;
  const scale = deadlineScale();
  const hardDeadlineMs = Math.min(
    (mode === 'research' ? DEFAULT_RESEARCH_DEADLINE_MS : DEFAULT_ASK_DEADLINE_MS) * scale,
    MAX_DEADLINE_MS,
  );
  const timeout = (input.timeoutSignal ?? AbortSignal.timeout)(hardDeadlineMs);
  const hardSignal = input.inheritedSignal
    ? AbortSignal.any([input.inheritedSignal, timeout])
    : timeout;
  const elapsedMs = () => Math.max(0, nowMs() - startedAtMs);
  const remainingMs = () => Math.max(0, hardDeadlineMs - elapsedMs());
  const softTargetMs = (route: AgentRunRoute): number => {
    const base = mode === 'research' ? 150_000 : (agentRouteDeadlineMs(route) ?? 15_000);
    // Scaled with the hard deadline: a soft target that stayed fixed while the
    // ceiling moved would stop new work long before the run was actually out of
    // time, which is the same dead end by a different route.
    return Math.min(base * scale, hardDeadlineMs);
  };
  // Narration must still be reachable after a full generation window, and must
  // leave the hard deadline (45s ask / 180s research) room to land.
  // The floor's slice comes off the END of the run: the analyst's soft target
  // and the narration window both stop short of it, so neither can spend the
  // time the host needs to answer when they did not.
  const hostFloorReserveMs = mode === 'research' ? 15_000 : 8_000;
  const narrationSoftTargetMs = () => Math.min(
    (mode === 'research' ? 160_000 : 38_000) * scale,
    Math.max(hardDeadlineMs - hostFloorReserveMs, Math.floor(hardDeadlineMs / 2)),
  );
  return Object.freeze({
    startedAtMs,
    hardDeadlineMs,
    hardSignal,
    mode,
    elapsedMs,
    remainingMs,
    softTargetMs,
    mayStartDiscovery: (route: AgentRunRoute) => !hardSignal.aborted && elapsedMs() < softTargetMs(route),
    narrationSoftTargetMs,
    mayStartNarration: () => !hardSignal.aborted && elapsedMs() < narrationSoftTargetMs(),
    hostFloorReserveMs,
    mayStartHostFloor: () => !hardSignal.aborted && remainingMs() > 1_500,
  });
}

/**
 * Routes whose gate failure is better answered by switching routes than by
 * re-running the same executor (repair can't add what the route can't produce).
 */
export const AGENT_RUN_ESCALATION_MAP: Partial<Record<AgentRunRoute, AgentRunRoute>> = {
  // Ordinary answers never silently turn into Research. A certified shape gap
  // may still explicitly escalate to generated_answer through its gate; after
  // the one bounded generated repair, the result remains visible for review.
  app_build: "dql_block_draft",
};

/** Resolve the request's audience, defaulting to analyst (Notebook) for back-compat. */
export function resolveAudience(request: AgentRunRequest): AgentRunAudience {
  return request.audience ?? "analyst";
}

/** A stakeholder may never land on an authoring route — collapse it to a governed answer. */
export function constrainRouteForAudience(route: AgentRunRoute, audience: AgentRunAudience): AgentRunRoute {
  if (audience === "stakeholder" && ANALYST_ONLY_ROUTES.has(route)) return "generated_answer";
  return route;
}

/**
 * "Answer anyway, labeled" — get a best-effort governed answer rather than a
 * dead-end clarify. The answer loop does its own grounding/retrieval and can still
 * return a needs-clarification result if it genuinely can't proceed.
 *
 * - A SOFT clarify ("nothing governed matched") is answered anyway for EVERY
 *   audience — analysts included — so a real analytical question never dead-ends.
 * - A genuine clarify (explicit missing context, explicit clarify intent, or a
 *   trust-gap review) stays a clarify for analysts; stakeholders keep the legacy
 *   answer-anyway affordance unless the catalog explicitly flagged missing context.
 */
export function answerAnywayRoute(
  route: AgentRunRoute,
  request: AgentRunRequest,
  audience: AgentRunAudience,
  decision?: IntentDecision,
): AgentRunRoute {
  if (route !== "clarify") return route;
  // Meaning resolution found real, material ambiguity. This is a hard safety
  // boundary: generated SQL must not guess which similarly named metric/block
  // the user intended.
  if (decision?.requiresClarification === true) return "clarify";
  const explicitMissing = (request.signals?.missingContext?.length ?? 0) > 0;
  const explicitClarifyIntent = request.intent === "clarify" || request.intent === "trust_gap_review";
  // A router suggestion alone is not enough to dead-end an answerable data
  // question. Let the governed answer loop search certified/semantic context and
  // generate review-required DQL; it can still return a precise clarification if
  // execution genuinely lacks required context.
  if (!explicitMissing && !explicitClarifyIntent) return "generated_answer";
  if (decision?.clarifySoft === true && !explicitMissing) return "generated_answer";
  if (audience === "stakeholder" && !explicitMissing) return "generated_answer";
  return "clarify";
}

export interface ClarificationContinuation {
  sourceQuestion: string;
  clarifyingQuestion: string;
  reply: string;
  resolvedQuestion: string;
}

/**
 * Resolve the turn immediately after a persisted clarification. The visible run
 * still keeps the user's short reply (for example, "yes"), while executors receive
 * the original analytical question plus the reply so metadata retrieval does not
 * restart from a context-free word and ask the same clarification again.
 */
export function resolveClarificationContinuation(request: AgentRunRequest): ClarificationContinuation | undefined {
  const reply = request.question.trim();
  const explicitSourceQuestion = request.clarificationSourceQuestion?.trim();
  const structuredSelection = Boolean(request.selectedEvidenceId && explicitSourceQuestion);
  if (!reply || (!structuredSelection && !isLikelyClarificationReply(reply))) return undefined;

  const fromServer = latestClarificationFromConversationContext(request.conversationContext);
  const serverIssuedStructuredSelection = structuredSelection
    ? serverIssuedStructuredClarification(request)
    : undefined;
  const fromHistory = latestClarificationFromHistory(request.history);
  // A UI selection is bound to the exact run that rendered the options. Carry
  // that run's source question explicitly so the continuation still works when
  // the optional conversation store is unavailable, after a reload, or when
  // the user selects an option on an older visible answer. Server history still
  // supplies the original clarifying prose when it is available.
  const pending = serverIssuedStructuredSelection
    ?? (explicitSourceQuestion
      ? {
          sourceQuestion: explicitSourceQuestion,
          clarifyingQuestion: fromServer?.clarifyingQuestion
            ?? fromHistory?.clarifyingQuestion
            ?? 'Which governed meaning should be used?',
        }
      : fromServer ?? fromHistory);
  // A structured option intentionally submits the original question together
  // with a stable, server-issued identifier.  Treating that exact text as a
  // fresh question drops the persisted typed frame and makes the router ask
  // the same clarification again.  The equality guard remains important for
  // free-text replies, where an unchanged question carries no new meaning.
  if (!pending || (!structuredSelection && pending.sourceQuestion.trim().toLowerCase() === reply.toLowerCase())) return undefined;

  return {
    ...pending,
    reply,
    resolvedQuestion: [
      pending.sourceQuestion.trim(),
      `Clarification asked: ${pending.clarifyingQuestion.trim()}`,
      `User clarification: ${reply}`,
      'Proceed with the most specific governed interpretation supported by the original request and this reply. Do not repeat the same clarification. If the reply does not select one of several options explicitly, choose the narrowest concrete interpretation consistent with the original wording and state that assumption in the answer.',
    ].join('\n\n'),
  };
}

/**
 * Use the original server snapshot for an identifier-bound continuation when
 * it carries the host-only authority record that local runtime reconstructs
 * from its persisted thread.  This prevents a browser-provided label (or a
 * stale client source question) from replacing the typed analytical frame
 * before router validation.  The router still performs the final snapshot and
 * option-ID validation before any plan can freeze.
 */
function serverIssuedStructuredClarification(
  request: AgentRunRequest,
): Pick<ClarificationContinuation, 'sourceQuestion' | 'clarifyingQuestion'> | undefined {
  if (!request.threadId) return undefined;
  const context = clarificationRecord(request.conversationContext);
  const authority = clarificationRecord(context?.serverIssuedClarificationSelection);
  if (authority?.version !== 1
    || clarificationString(authority.threadId) !== request.threadId) return undefined;
  const authoritySourceTurnId = clarificationString(authority.sourceTurnId);
  const authoritySnapshotId = clarificationString(authority.snapshotId);
  if (!authoritySourceTurnId || !authoritySnapshotId) return undefined;

  for (const source of [
    clarificationRecord(context?.conversationEnvelope),
    clarificationRecord(context?.serverSnapshot),
  ]) {
    if (clarificationString(source?.threadId) !== request.threadId) continue;
    const pending = clarificationRecord(source?.pendingClarification);
    const selection = clarificationRecord(pending?.selection);
    if (clarificationString(pending?.sourceTurnId) !== authoritySourceTurnId
      || clarificationString(selection?.snapshotId) !== authoritySnapshotId) continue;
    const sourceQuestion = clarificationString(pending?.sourceQuestion);
    const clarifyingQuestion = clarificationString(pending?.question);
    if (sourceQuestion && clarifyingQuestion) return { sourceQuestion, clarifyingQuestion };
  }
  return undefined;
}

function latestClarificationFromHistory(
  history: AgentRunRequest['history'],
): Pick<ClarificationContinuation, 'sourceQuestion' | 'clarifyingQuestion'> | undefined {
  if (!history?.length) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn.role !== 'assistant' || !turn.text.trim().endsWith('?')) continue;
    let fallbackQuestion: string | undefined;
    for (let prior = index - 1; prior >= 0; prior -= 1) {
      if (history[prior].role === 'user' && history[prior].text.trim()) {
        fallbackQuestion = history[prior].text;
        if (!isLikelyClarificationReply(history[prior].text)) {
          return { sourceQuestion: history[prior].text, clarifyingQuestion: turn.text };
        }
      }
    }
    if (fallbackQuestion) return { sourceQuestion: fallbackQuestion, clarifyingQuestion: turn.text };
  }
  return undefined;
}

function latestClarificationFromConversationContext(
  context: Record<string, unknown> | undefined,
): Pick<ClarificationContinuation, 'sourceQuestion' | 'clarifyingQuestion'> | undefined {
  const contextRecord = clarificationRecord(context);
  const snapshot = clarificationRecord(contextRecord?.serverSnapshot);
  const envelope = clarificationRecord(contextRecord?.conversationEnvelope);

  // PRIMARY: the envelope's own pending clarification. `buildConversationSnapshot`
  // already detects one correctly (`route === 'clarify' || runStatus ===
  // 'needs_clarification'`) and applies the one-shot reply guard — but nothing
  // consumed it, so the scan below was the only path, and it matched on
  // `route === 'clarify'` alone. On the Ask surface a clarification persisted
  // the RESOLVED analytical route, so the scan never matched, the reply ran
  // context-free, and the same clarification was asked again.
  //
  // Both envelope keys are read; neither may be dropped while older clients
  // still write only `serverSnapshot`.
  for (const source of [envelope, snapshot]) {
    const pending = clarificationRecord(source?.pendingClarification);
    const clarifyingQuestion = clarificationString(pending?.question);
    const sourceQuestion = clarificationString(pending?.sourceQuestion);
    if (clarifyingQuestion && sourceQuestion) return { sourceQuestion, clarifyingQuestion };
  }

  // FALLBACK: the legacy turn scan, for envelopes persisted before the write
  // side recorded `route: 'clarify'`.
  const sources = [snapshot?.recentTurns, contextRecord?.turns];
  for (const source of sources) {
    if (!Array.isArray(source) || source.length === 0) continue;
    const latestIndex = source.length - 1;
    const latest = clarificationRecord(source[latestIndex]);
    const route = clarificationString(latest?.route);
    const clarifyingQuestion = clarificationString(latest?.answerSummary);
    if (route !== 'clarify' || !clarifyingQuestion) continue;

    // A previously deployed client may already have persisted a repeated
    // clarification chain (original question -> "yes" -> clarify again). Walk
    // back through that chain so the next reply recovers the analytical request,
    // not the terse intermediate reply.
    let sourceQuestion = clarificationString(latest?.question);
    for (let index = latestIndex; index >= 0; index -= 1) {
      const candidate = clarificationRecord(source[index]);
      if (clarificationString(candidate?.route) !== 'clarify') break;
      const question = clarificationString(candidate?.question);
      if (!question) continue;
      sourceQuestion = question;
      if (!isLikelyClarificationReply(question)) break;
    }
    if (sourceQuestion) {
      return { sourceQuestion, clarifyingQuestion };
    }
  }
  return undefined;
}

function clarificationRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clarificationString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Task-adaptive reasoning effort per route — the DQL differentiator. Cheap,
 * mechanical routes (chat, clarify, blocked, a pre-written certified lookup) run
 * `low`; a plain generated answer runs `medium` (the "Auto" default — S1); the
 * heavy authoring/investigation routes that genuinely reason over a whole
 * research workspace or draft a block run `high`. This is the reasoning-effort
 * half of the S1 decouple: it sets how hard the model THINKS per call and is no
 * longer welded to how many verification passes run (that follows the question
 * shape — see `questionShapeClass`/`analysisDepthForQuestion`). A user's explicit
 * thinking selection overrides this default; the host also clamps by the
 * provider's Settings ceiling before sending it to the model.
 */
export function routeReasoningEffort(route: AgentRunRoute): ReasoningEffort {
  switch (route) {
    case "conversation":
    case "clarify":
    case "certified_answer":
    case "semantic_answer":
    case "blocked":
      return "low";
    case "generated_answer":
    case "app_build":
      return "medium";
    case "research":
    case "sql_cell":
    case "dql_block_draft":
      return "high";
    default:
      return "medium";
  }
}

/** Audience-aware escalation target: stakeholders never escalate into authoring. */
export function escalationRouteFor(route: AgentRunRoute, audience: AgentRunAudience): AgentRunRoute | undefined {
  const target = AGENT_RUN_ESCALATION_MAP[route];
  if (!target) return undefined;
  if (audience === "stakeholder" && ANALYST_ONLY_ROUTES.has(target)) return "generated_answer";
  return target;
}

/** The handoff action shown on a stakeholder's review-required output. */
function requestCertificationAction(): AgentRunNextAction {
  return { id: "request-certification", label: "Request certification" };
}

/**
 * For stakeholders, strip analyst-authoring next actions and, on review-required
 * output, offer the certification handoff. Analysts keep their actions untouched.
 */
function applyAudienceToNextActions(
  actions: AgentRunNextAction[],
  audience: AgentRunAudience,
  status: AgentRunStatus,
): AgentRunNextAction[] {
  if (audience !== "stakeholder") return actions;
  const consumption = actions.filter((action) =>
    !ANALYST_ONLY_ROUTES.has(action.route ?? "clarify")
    && action.artifactKind !== "sql_cell"
    && action.artifactKind !== "dql_block_draft"
    && !/insert-sql|create-block|promote|open-review|draft/i.test(action.id));
  if (status === "needs_review" && !consumption.some((action) => action.id === "request-certification")) {
    consumption.push(requestCertificationAction());
  }
  return consumption;
}

export class InMemoryAgentRunStore implements AgentRunStore {
  private readonly runs = new Map<string, AgentRun>();
  private readonly progress = new Map<string, AgentRunProgressV1>();

  save(run: AgentRun): void {
    this.progress.delete(run.id);
    this.runs.set(run.id, run);
  }

  get(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  list(): AgentRun[] {
    return [...this.runs.values()];
  }

  saveProgress(progress: AgentRunProgressV1): void {
    if (!this.runs.has(progress.id)) this.progress.set(progress.id, progress);
  }

  getProgress(id: string): AgentRunProgressV1 | undefined {
    return this.progress.get(id);
  }
}

export interface FileAgentRunStoreOptions {
  path: string;
  maxRuns?: number;
}

export class FileAgentRunStore implements AgentRunStore {
  private readonly path: string;
  private readonly maxRuns: number;

  constructor(options: FileAgentRunStoreOptions) {
    this.path = options.path;
    this.maxRuns = options.maxRuns ?? 500;
  }

  save(run: AgentRun): void {
    const runs = this.list();
    const index = runs.findIndex((candidate) => candidate.id === run.id);
    if (index >= 0) {
      runs[index] = run;
    } else {
      runs.push(run);
    }
    const pruned = runs
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, this.maxRuns);
    this.write(pruned);
  }

  saveProgress(_progress: AgentRunProgressV1): void {
    // The file store is retained only for backwards-compatible tests and old
    // embedders. Durable in-progress state is provided by SqliteAgentRunStore.
  }

  getProgress(_id: string): AgentRunProgressV1 | undefined {
    return undefined;
  }

  get(id: string): AgentRun | undefined {
    return this.list().find((run) => run.id === id);
  }

  list(): AgentRun[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as {
        runs?: unknown;
      };
      if (!Array.isArray(parsed.runs)) return [];
      return parsed.runs.flatMap((run) => isAgentRunRecord(run) ? [run] : []);
    } catch {
      return [];
    }
  }

  private write(runs: AgentRun[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ version: 1, runs }, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, this.path);
  }
}

export function defaultAgentRunStorePath(projectRoot: string): string {
  return join(projectRoot, ".dql", "local", "agent-runs.json");
}

function isAgentRunRecord(value: unknown): value is AgentRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.question === "string"
    && typeof record.route === "string"
    && Array.isArray(record.events)
    && Array.isArray(record.artifacts)
    && Array.isArray(record.evaluations);
}

/** Outcome of a single accepted step (status/trust/artifacts derived from evaluations). */
interface StepOutcome {
  status: AgentRunStatus;
  trustState: AgentRunTrustState;
  artifacts: AgentRunArtifact[];
  stopReason: AgentRunStopReason;
  summary: string;
  /** Cascade tier that produced the answer (drives governed short-circuit). */
  terminalTier?: string;
}

export class AgentRunEngine {
  private readonly executors: AgentRunExecutors;
  private readonly gates: AgentRunGates;
  private readonly planner: AgentRunPlanner;
  private readonly router?: AgentRouter;
  private readonly store?: AgentRunStore;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly budgetModel: PartialCascadeBudgetModel;
  private readonly maxSteps: number;
  private readonly routeTimeoutSignal: (durationMs: number) => AbortSignal;
  private readonly traceObserverFactory?: AgentRunEngineOptions['traceObserverFactory'];
  private readonly sensitiveQuestions: 'wording' | 'columns';

  constructor(options: AgentRunEngineOptions = {}) {
    this.sensitiveQuestions = options.sensitiveQuestions === 'columns' ? 'columns' : 'wording';
    this.executors = options.executors ?? {};
    this.gates = options.gates ?? {};
    this.planner = options.planner ?? createDeterministicAgentRunPlanner();
    this.router = options.router;
    this.store = options.store;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.budgetModel = {
      ...options.budgets,
      lane: {
        ...options.budgets?.lane,
        execution: options.maxRepairAttempts ?? options.budgets?.lane?.execution,
      },
      engineEscalations: options.maxEngineEscalations ?? options.budgets?.engineEscalations,
    };
    this.maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
    this.routeTimeoutSignal = options.routeTimeoutSignal ?? ((durationMs) => AbortSignal.timeout(durationMs));
    this.traceObserverFactory = options.traceObserverFactory;
  }

  /**
   * Decide the high-level action. A forced `requestedMode` bypasses routing.
   * Otherwise an injected router (LLM-assisted) wins; failing that, the built-in
   * deterministic decision. The router owns its own fallback to heuristics.
   */
  private async decideRoute(request: AgentRunRequest): Promise<IntentDecision> {
    const requestedAction = requestedModeToAction(request.requestedMode);
    // `ask` constrains the eventual analytical action to a direct answer, but it
    // still needs retrieval-first meaning resolution. Treating it like the SQL,
    // block, or app authoring modes used to bypass the evidence router entirely
    // on the primary Ask surface.
    if (requestedAction && request.requestedMode !== "ask") {
      return buildIntentDecision(request);
    }
    if (this.router) {
      try {
        const routed = await this.router.decide(request);
        if (
          request.requestedMode === "ask"
          && routed.action !== "converse"
          && routed.action !== "compose_app"
          && routed.requiresClarification !== true
          && !routed.terminalOutcome
        ) {
          return { ...routed, action: "answer" };
        }
        return routed;
      } catch (error) {
        if (request.signal?.aborted) throw request.signal.reason ?? error;
        if (error instanceof Error && error.name === "AbortError") throw error;
        // Router failed entirely — fall back to deterministic routing.
      }
    }
    return buildIntentDecision(request);
  }

  async run(
    request: AgentRunRequest,
    onEvent?: (event: AgentRunEvent) => void,
    onAnswerDelta?: (delta: string) => void,
  ): Promise<AgentRun> {
    const submittedQuestion = request.question;
    const clarificationContinuation = resolveClarificationContinuation(request);
    if (clarificationContinuation) {
      request = {
        ...request,
        // A structured choice is already an exact meaning binding, carried
        // separately as `selectedEvidenceId`. Retrieve and execute against the
        // original analytical question so artifact names, planning, and SQL
        // shape are not polluted by clarification prose. A FREE-TEXT reply has
        // no such binding, so it must be folded into the question.
        question: request.selectedEvidenceId
          ? clarificationContinuation.sourceQuestion
          : clarificationContinuation.resolvedQuestion,
        clarificationSourceQuestion: clarificationContinuation.sourceQuestion,
      };
    }
    const runId = request.runId ?? this.idGenerator();
    const startedAt = this.timestamp();
    const runStartedAtMs = Date.parse(startedAt);
    const requestedMode = request.requestedMode ?? "auto";
    // OBS-001/OBS-002: valid engine requests receive a server-owned trace after
    // their run ID is known.  The observer is explicitly non-authoritative and
    // a factory/store failure becomes a no-op, never an Ask failure.
    let traceObserver: AskTraceObserverV1 = noOpAskTraceObserverV1;
    try {
      traceObserver = this.traceObserverFactory?.({ runId, request, startedAt, requestedMode })
        ?? noOpAskTraceObserverV1;
    } catch {
      traceObserver = noOpAskTraceObserverV1;
    }
    // The engine-owned ID is available before retrieval/routing. Bind it to
    // this internal request object now so request-scoped host capabilities
    // (for example one cold-literal probe) can never be minted against an
    // anonymous or browser-supplied identity. Public ingress still strips any
    // caller-provided `runId` before the engine chooses this value.
    request = attachAskTraceObserverV1({ ...request, runId }, traceObserver);
    // Continuity is relationship evidence, not new routing input. Keep only
    // stable run IDs and one-way fingerprints so a trace can explain why this
    // turn reused a clarification/result/derived plan without persisting chat
    // text, values, SQL, or an invented parent trace.
    if (clarificationContinuation) {
      traceObserver.recordLink({
        kind: 'clarification_continuation',
        choiceFingerprint: traceLinkFingerprint(request.selectedEvidenceId ?? clarificationContinuation.sourceQuestion),
      });
    }
    if (request.selectedResultBinding) {
      traceObserver.recordLink({
        kind: 'prior_result',
        targetRunId: request.selectedResultBinding.sourceRunId,
        choiceFingerprint: traceLinkFingerprint([
          request.selectedResultBinding.sourceArtifactId,
          request.selectedResultBinding.canonicalColumn,
          request.selectedResultBinding.rowFingerprint,
          request.selectedResultBinding.resultFingerprint,
        ].join('\u0000')),
      });
    }
    const derivedSourceRunId = traceDerivedSourceRunId(request.workspaceContext);
    if (derivedSourceRunId) {
      traceObserver.recordLink({
        kind: 'derived_repair',
        targetRunId: derivedSourceRunId,
        choiceFingerprint: traceLinkFingerprint(derivedSourceRunId),
      });
    }
    const conversationBinding = traceConversationBinding(request, clarificationContinuation);
    const conversationTrace = traceObserver.startSpan({
      name: 'conversation.hydrate',
      stage: 'conversation',
      payload: {
        kind: 'conversation',
        continuation: conversationBinding !== 'none',
        binding: conversationBinding,
      },
    });
    traceObserver.finishSpan(conversationTrace, { outcome: 'ok', reasonCode: 'completed' });
    const runBudget = request.runBudget ?? createAgentRunBudget({
      requestedMode,
      startedAtMs: runStartedAtMs,
      inheritedSignal: request.signal,
      timeoutSignal: this.routeTimeoutSignal,
      nowMs: () => this.now().getTime(),
    });
    // Preserve the non-enumerable observer across the immutable request update.
    // A plain spread drops symbol properties, which previously made the router
    // lose candidate/cascade/freeze evidence even though the engine still
    // emitted its own outer spans.
    request = attachAskTraceObserverV1({ ...request, runBudget, signal: runBudget.hardSignal }, traceObserver);
    const events: AgentRunEvent[] = [];
    let plan: AgentRunPlan | undefined;
    const executedSteps: AgentRunStep[] = [];
    const progress: AgentRunProgressV1 = {
      version: 1,
      id: runId,
      question: submittedQuestion,
      requestedMode,
      selectedObject: request.selectedObject,
      executionTarget: request.executionTarget,
      steps: [],
      artifacts: [],
      evaluations: [],
      events: [],
      lifecycle: {
        version: 1,
        state: "running",
        phase: "queued",
        revision: 0,
        eventCursor: 0,
        startedAt,
        updatedAt: startedAt,
      },
      ...(traceObserver.reference() ? { traceReference: traceObserver.reference() } : {}),
    };
    let checkpointQueue: Promise<void> = Promise.resolve();
    const persistProgress = () => {
      if (!this.store?.saveProgress) return;
      const snapshot: AgentRunProgressV1 = {
        ...progress,
        lifecycle: { ...progress.lifecycle },
        steps: [...progress.steps],
        artifacts: [...progress.artifacts],
        evaluations: [...progress.evaluations],
        events: [...progress.events],
        ...(progress.analyticalTaskOutcomes
          ? { analyticalTaskOutcomes: progress.analyticalTaskOutcomes.map((outcome) => ({
              ...outcome,
              ...(outcome.dependencyTaskIds ? { dependencyTaskIds: [...outcome.dependencyTaskIds] } : {}),
            })) }
          : {}),
        ...(progress.analyticalTaskOutcomeSummary
          ? {
              analyticalTaskOutcomeSummary: {
                ...progress.analyticalTaskOutcomeSummary,
                successfulTaskIds: [...progress.analyticalTaskOutcomeSummary.successfulTaskIds],
                failedTaskIds: [...progress.analyticalTaskOutcomeSummary.failedTaskIds],
                dependencyBlockedTaskIds: [...progress.analyticalTaskOutcomeSummary.dependencyBlockedTaskIds],
              },
            }
          : {}),
        ...(progress.askAnalystState ? { askAnalystState: progress.askAnalystState } : {}),
      };
      checkpointQueue = checkpointQueue.then(async () => {
        try {
          await this.store?.saveProgress?.(snapshot);
        } catch {
          // Progress persistence is additive; terminal persistence remains
          // authoritative and must not be failed by a checkpoint write.
        }
      });
    };
    const emit = (event: Omit<AgentRunEvent, "id" | "runId" | "at">) => {
      const full: AgentRunEvent = {
        id: `${runId}:event:${events.length + 1}`,
        runId,
        at: this.timestamp(),
        ...event,
      };
      events.push(full);
      progress.events = events.slice(-200);
      progress.lifecycle = {
        ...progress.lifecycle,
        phase: full.type,
        revision: progress.lifecycle.revision + 1,
        eventCursor: events.length,
        updatedAt: full.at,
      };
      if (full.route) progress.route = full.route;
      if (full.trustState) progress.trustState = full.trustState;
      if (full.type === "plan.created" && full.payload && typeof full.payload === "object") {
        progress.plan = full.payload as AgentRunPlan;
      }
      if (full.type === "artifact.created" && full.payload && typeof full.payload === "object") {
        const artifact = full.payload as AgentRunArtifact;
        progress.artifacts = [...progress.artifacts.filter((candidate) => candidate.id !== artifact.id), artifact];
      }
      if (full.type === "evaluation.recorded" && full.payload && typeof full.payload === "object") {
        const evaluation = full.payload as AgentRunEvaluation;
        progress.evaluations = [
          ...progress.evaluations.filter((candidate) => candidate.id !== evaluation.id),
          evaluation,
        ];
      }
      if (full.type === "step.completed") progress.steps = [...executedSteps];
      // Event payloads are intentionally not copied: they may contain raw
      // answer/tool data. The typed mapping records only stage identity.
      recordEngineTraceEventV1(traceObserver, full);
      const traceReference = traceObserver.reference();
      if (traceReference) progress.traceReference = traceReference;
      persistProgress();
      onEvent?.(full);
    };

    emit({
      type: "run.started",
      message: "Started governed agent run.",
      payload: {
        question: submittedQuestion,
        requestedMode,
        selectedObject: request.selectedObject,
        ...(clarificationContinuation ? { clarificationResolved: true } : {}),
      },
    });
    // AskAnalystRuntimeV1 emits typed state checkpoints after framing and each
    // bounded tool action. They are local/restart material only and are never
    // exported through the content-free trace projection.
    // Checkpointing adds a callback after the observer was attached above.
    // Preserve the non-enumerable trace observer through this immutable update:
    // otherwise the authoritative runtime can record its router state while
    // the later provider/compiler/execution adapter sees a no-op observer.
    // That made a successfully executed deterministic physical program appear
    // to have no SQL generation, validation, authorization, or execution in
    // the same trace.
    request = attachAskTraceObserverV1({
      ...request,
      askAnalystCheckpoint: (state) => {
        progress.askAnalystState = state;
        persistProgress();
      },
    }, traceObserver);

    // This check is intentionally before route selection.  A restricted direct
    // disclosure must not be embedded, retrieved, sent to a provider, value
    // probed, or compiled merely to explain why it cannot be answered.
    const ingressPolicy = evaluateAnalyticalRequestPolicy(submittedQuestion, { sensitiveData: this.sensitiveQuestions });
    if (!ingressPolicy.allowed) {
      const routeDecision: IntentDecision = {
        action: 'answer',
        confidence: 1,
        reason: 'The request is unavailable under the Ask data-safety policy.',
        followsUp: false,
        source: 'heuristic',
        terminalOutcome: {
          kind: 'policy_blocked',
          code: 'ANALYTICAL_POLICY_BLOCKED',
          message: ingressPolicy.message,
          candidateIds: [],
        },
      };
      const coverageGap = buildCoverageGap({
        code: 'POLICY_BLOCKED',
        phase: 'retrieval',
        message: ingressPolicy.message,
        searchedSources: [],
        attemptedRoutes: [],
        missing: [],
        recoverable: false,
        planFrozen: false,
        nextActions: ingressPolicy.nextActions,
      });
      const evaluation: AgentRunEvaluation = {
        id: 'request-policy',
        label: 'Ask request policy',
        passed: false,
        severity: 'blocking',
        message: ingressPolicy.message,
      };
      const artifact: AgentRunArtifact = {
        id: `${runId}:policy`,
        kind: 'answer',
        title: 'Ask request unavailable',
        trustState: 'blocked',
        payload: {
          analyticalCoverageGap: coverageGap,
          analyticalFailure: {
            code: 'POLICY_BLOCKED',
            phase: 'request_policy',
            message: ingressPolicy.message,
            recoverable: false,
            safeActions: ingressPolicy.nextActions,
          },
        },
      };
      emit({
        type: 'route.decided',
        message: routeDecision.reason,
        route: 'blocked',
        payload: routeDecision,
      });
      emit({
        type: 'evaluation.recorded',
        message: evaluation.message,
        route: 'blocked',
        payload: evaluation,
      });
      emit({
        type: 'artifact.created',
        message: 'Created answer artifact.',
        route: 'blocked',
        trustState: 'blocked',
        payload: artifact,
      });
      emit({
        type: 'run.failed',
        message: ingressPolicy.message,
        route: 'blocked',
        status: 'blocked',
        trustState: 'blocked',
      });
      const completedAt = this.timestamp();
      const run: AgentRun = {
        id: runId,
        question: submittedQuestion,
        requestedMode,
        conversationBinding: request.conversationBinding ?? traceConversationBinding(request, clarificationContinuation),
        route: 'blocked',
        status: 'blocked',
        trustState: 'blocked',
        stopReason: 'blocked',
        startedAt,
        completedAt,
        selectedObject: request.selectedObject,
        executionTarget: request.executionTarget,
        routeDecision,
        steps: [],
        summary: ingressPolicy.message,
        answer: ingressPolicy.message,
        answerKind: 'governed',
        artifacts: [artifact],
        evaluations: [evaluation],
        events,
        nextActions: ingressPolicy.nextActions.map((id) => ({ id, label: id === 'ask_for_an_approved_aggregate' ? 'Ask for an approved aggregate' : 'Inspect data policy' })),
        repairAttempts: 0,
        escalationAttempts: 0,
        budgetUsage: cascadeBudgetTrace(createCascadeBudgetState(this.budgetModel)),
        telemetry: emptyRunTelemetry(durationBetweenMs(startedAt, completedAt), 'policy_blocked'),
        lifecycle: terminalLifecycle(progress.lifecycle, 'run.failed', completedAt, events.length),
      };
      run.diagnosticReceipt = diagnosticReceiptForRun(run);
      run.diagnosticReceiptV2 = diagnosticReceiptV2ForRun(run);
      run.diagnosticReceiptV3 = diagnosticReceiptV3ForRun(run);
      run.diagnosticReceiptV4 = diagnosticReceiptV4ForRun(run);
      attachAskAnalystRuntimeReceipt(run, request.askAgentRuntimeMode);
      run.artifacts = attachDiagnosticReceipt(run.artifacts, run.diagnosticReceipt);
      // Observability is deliberately finalized only after the authoritative
      // receipt exists, and before the ordinary run store persists its compact
      // reference. A local trace write failure never changes this outcome.
      finalizeAgentRunTraceV1(traceObserver, run);
      await checkpointQueue;
      await this.store?.save(run);
      return run;
    }

    const audience = resolveAudience(request);
    // Initialize a deterministic decision so router/provider timeouts can still
    // be persisted as a complete blocked run with an inspectable trace. The old
    // pre-try await escaped the engine and left active UI runs looking endless.
    let routeDecision: IntentDecision = buildIntentDecision(request);
    try {
      const classifySpan = traceObserver.startSpan({
        name: 'request.classify',
        stage: 'request',
        payload: { kind: 'stage', requestedMode },
      });
      routeDecision = clarificationContinuation && !request.selectedEvidenceId
        ? {
            action: "answer",
            confidence: 1,
            reason: "This continues a pending clarification, so I will resolve it against the original analytical question and produce a governed answer instead of asking again.",
            followsUp: true,
            source: "heuristic",
        }
        : await awaitWithAbort(this.decideRoute(request), request.signal);
      routeDecision = enforceOrdinaryAnalyticalPlanBoundary(request, routeDecision);
      traceObserver.finishSpan(classifySpan, { outcome: 'ok', reasonCode: 'route_selected' });
      // Router/cascade evidence is captured after its authoritative decision
      // is sealed. The trace adapter only projects IDs, counters, and typed
      // receipts; it never participates in route selection.
      recordAuthoritativeRouterDecisionV1(traceObserver, routeDecision);
      const defaultRoute = answerAnywayRoute(
        constrainRouteForAudience(selectRoute(request, routeDecision), audience),
        request,
        audience,
        routeDecision,
      );
      const authoritativeAsk = routeDecision.resolvedAnalyticalPlan?.mode === 'authoritative'
        && requestedMode !== 'research';
      // AskAnalystRuntimeV1 owns the single immutable task program. The
      // engine may still use the legacy deterministic/LLM planners for every
      // other surface, but it must never replace a runtime-frozen Ask task
      // with a new generic one-step interpretation.
      const runtimeFrozenPlan = authoritativeAsk
        ? routeDecision.askAnalystDecision?.frozenPlan
        : undefined;
      const activePlanner = authoritativeAsk && !runtimeFrozenPlan
        ? createDeterministicAgentRunPlanner()
        : this.planner;
      const planningSignal = request.runBudget?.hardSignal ?? request.signal;
      plan = runtimeFrozenPlan ?? await awaitWithAbort(Promise.resolve(activePlanner.plan({
        request,
        routeDecision,
        defaultRoute,
        maxSteps: this.maxSteps,
        audience,
      })), planningSignal);
      emit({
        type: "plan.created",
        message: plan.rationale,
        route: plan.steps[0]?.route,
        payload: plan,
      });

      // Normalize planned routes to the audience (works for LLM and deterministic
      // plans alike): stakeholders never author and never dead-end on clarify
      // without explicit missing context.
      const queue: AgentRunPlannedStep[] = plan.steps.map((step) => ({
        ...step,
        route: answerAnywayRoute(constrainRouteForAudience(step.route, audience), request, audience, routeDecision),
      }));
      // A multi-task authoritative Ask has one frozen task queue.  V2 task
      // outcome receipts may retain an independent sibling when another task
      // fails; persisted pre-V2 decisions deliberately retain the historical
      // all-or-nothing aggregate below.  Neither mode may silently omit a
      // task or substitute a freshly parsed child graph.
      const authoritativeTaskExecutions = authoritativeAsk
        ? routeDecision.askAnalystDecision?.taskExecutions ?? []
        : [];
      const initialTaskOutcomes = authoritativeAsk
        ? routeDecision.askAnalystDecision?.taskOutcomes ?? []
        : [];
      const initialTaskOutcomeSummary = authoritativeAsk
        ? routeDecision.askAnalystDecision?.taskOutcomeSummary
        : undefined;
      const authoritativePartialOutcomeMode = Boolean(
        initialTaskOutcomeSummary
        && initialTaskOutcomeSummary.taskCount > 1,
      );
      const authoritativeCompoundAsk = authoritativeTaskExecutions.length > 1 || authoritativePartialOutcomeMode;
      if (initialTaskOutcomes.length > 0) progress.analyticalTaskOutcomes = initialTaskOutcomes;
      if (initialTaskOutcomeSummary) progress.analyticalTaskOutcomeSummary = initialTaskOutcomeSummary;
      const authoritativeTaskIds = new Set(authoritativeTaskExecutions.map((task) => task.taskId));
      const authoritativeQueueIds = queue
        .map((step) => step.askAnalystTaskId)
        .filter((taskId): taskId is string => Boolean(taskId));
      const authoritativeQueueValid = !authoritativeCompoundAsk || (
        queue.length === authoritativeTaskExecutions.length
        && authoritativeQueueIds.length === authoritativeTaskExecutions.length
        && new Set(authoritativeQueueIds).size === authoritativeQueueIds.length
        && authoritativeQueueIds.every((taskId) => authoritativeTaskIds.has(taskId))
      );
      if (!authoritativeQueueValid) {
        throw Object.assign(
          new Error('The authoritative Ask runtime did not supply one frozen execution step for every executable task.'),
          { code: 'ASK_ANALYST_TASK_PLAN_MISMATCH' },
        );
      }
      const budgets = createCascadeBudgetState(this.budgetModel);
      let stepCount = 0;
      let finalStep: AgentRunStep | undefined;
      let finalResult: AgentRouteExecutorResult | undefined;
      let finalOutcome: StepOutcome | undefined;
      let clarifyOutcome: { step: AgentRunStep; question?: string } | undefined;
      // The last step that actually produced a user-facing answer. A later
      // non-answer step (e.g. a research/draft step that emits only an artifact)
      // must not drop the data answer an earlier step already computed.
      let bestAnswerResult: AgentRouteExecutorResult | undefined;
      /** Dependencies skipped after a parent execution failure. */
      const runtimeDependencyBlockedTaskIds = new Map<string, string[]>();
      // Compiler receipts describe what can be attempted, never what has
      // executed.  Persist an execution-only aggregate before task 1 starts,
      // and again after every task reaches a terminal step.  That makes an
      // interrupted local run recoverable without advertising compiled tasks
      // as completed work.
      const checkpointAuthoritativeTaskOutcomes = () => {
        if (!authoritativePartialOutcomeMode) return;
        const aggregate = aggregateAuthoritativeTaskOutcomes({
          initialTaskOutcomes,
          taskExecutions: authoritativeTaskExecutions,
          steps: executedSteps,
          dependencyBlockedTaskIds: runtimeDependencyBlockedTaskIds,
          taskCount: initialTaskOutcomeSummary?.taskCount,
          finalized: false,
        });
        progress.analyticalTaskOutcomes = aggregate.outcomes;
        progress.analyticalTaskOutcomeSummary = aggregate.summary;
        progress.steps = [...executedSteps];
        persistProgress();
      };
      checkpointAuthoritativeTaskOutcomes();

      // The runtime bounds ordinary Ask to three accepted tasks.  Once it
      // accepts a compound mission, every frozen child must receive one
      // execution attempt even when the generic engine's normal plan cap is
      // smaller.  Do not turn the cap into a silent partial answer.
      const executionStepLimit = authoritativeCompoundAsk ? queue.length : this.maxSteps;
      while (queue.length > 0 && stepCount < executionStepLimit) {
        const planned = queue.shift()!;
        stepCount += 1;
        const route = planned.route;
        const stepId = `${runId}:step:${stepCount}`;
        // A compound authoritative Ask carries one immutable compiler handoff
        // per accepted task.  Swap it in at the execution boundary rather than
        // letting task-2 inherit task-1's frame, candidates, or cascade.
        const taskExecution = authoritativeAsk && planned.askAnalystTaskId
          ? routeDecision.askAnalystDecision?.taskExecutions?.find((task) => task.taskId === planned.askAnalystTaskId)
          : undefined;
        const taskQuestion = taskExecution
          ? taskExecution.state.mission.tasks.find((task) => task.id === taskExecution.taskId)?.question
            ?? planned.goal
          : undefined;
        const taskRequest = taskExecution && taskQuestion
          ? attachAskTraceObserverV1({
              ...request,
              // Every compiler and executor sees only the frozen child
              // question.  The submitted parent remains captured by the root
              // trace observer and is restored onto the persisted run below.
              question: taskQuestion,
              askAnalystTaskChild: {
                version: 1 as const,
                taskId: taskExecution.taskId,
                question: taskQuestion,
                instructions: [...planned.successCriteria],
              },
              askAnalystState: taskExecution.state,
              askAnalystProgram: taskExecution.program,
              askAnalystMeaningResolution: taskExecution.meaningResolution,
              askAnalystTierReadiness: taskExecution.tierReadiness,
              hostRequirementSeed: taskExecution.requirementSeed,
            }, traceObserver)
          : request;
        let taskRouteDecision = taskExecution
          ? taskScopedRouteDecision(routeDecision, taskExecution)
          : routeDecision;

        emit({
          type: "step.started",
          message: `Step ${stepCount}: ${planned.goal}`,
          route,
          payload: { stepId, index: stepCount, goal: planned.goal, successCriteria: planned.successCriteria },
        });
        const resolvedPlanShadow = stepCount === 1
          ? compareResolvedPlanShadow(taskRouteDecision, route)
          : undefined;
        emit({
          type: "route.decided",
          message: stepCount === 1
            ? taskRouteDecision.reason
            : `Routed step ${stepCount} to ${route.replaceAll("_", " ")}.`,
          route,
          payload: stepCount === 1
            ? {
                ...taskRouteDecision,
                ...(resolvedPlanShadow
                  ? { resolvedPlanShadow }
                  : {}),
              }
            : { route, goal: planned.goal },
        });

        // V2 compound Ask treats a task dependency as an execution boundary,
        // not a reason to reinterpret or replan the child.  A dependent child
        // may use its predecessor only after that predecessor produced an
        // accepted result.  Independent siblings continue to their own frozen
        // programs after a failure; this branch is deliberately restricted to
        // the additive V2 receipt so pre-V2 persisted compound runs preserve
        // their historical all-or-nothing behavior.
        const dependencyTaskIds = taskExecution
          ? taskExecution.dependencyTaskIds
            ?? taskExecution.state.mission.tasks.find((task) => task.id === taskExecution.taskId)?.dependencies
            ?? []
          : [];
        const unmetDependencyIds = authoritativePartialOutcomeMode && taskExecution
          ? dependencyTaskIds.filter((dependencyTaskId) => !hasAcceptedAuthoritativeTaskResult(
              executedSteps.find((step) => step.askAnalystTaskId === dependencyTaskId),
            ))
          : [];
        if (taskExecution && unmetDependencyIds.length > 0) {
          runtimeDependencyBlockedTaskIds.set(taskExecution.taskId, unmetDependencyIds);
          const summary = 'This task was not executed because a required task did not complete successfully.';
          const dependencyStep: AgentRunStep = {
            id: stepId,
            index: stepCount,
            route,
            ...(planned.askAnalystTaskId ? { askAnalystTaskId: planned.askAnalystTaskId } : {}),
            goal: planned.goal,
            successCriteria: planned.successCriteria,
            status: 'blocked',
            attempts: 0,
            summary,
            evaluations: [{
              id: `task-dependency:${taskExecution.taskId}`,
              label: 'Task dependency',
              passed: false,
              severity: 'blocking',
              message: summary,
              evidence: { dependencyTaskIds: unmetDependencyIds },
            }],
            artifacts: [],
          };
          executedSteps.push(dependencyStep);
          const dependencyOutcome: StepOutcome = {
            status: 'blocked',
            trustState: 'blocked',
            artifacts: [],
            stopReason: 'blocked',
            summary,
          };
          finalStep = dependencyStep;
          finalResult = { status: 'blocked', trustState: 'blocked', summary };
          finalOutcome = dependencyOutcome;
          checkpointAuthoritativeTaskOutcomes();
          emit({
            type: 'step.completed',
            message: `Step ${stepCount} dependency blocked.`,
            route,
            status: 'blocked',
            trustState: 'blocked',
            payload: { stepId, status: 'blocked', dependencyTaskIds: unmetDependencyIds },
          });
          continue;
        }

        let attempt = 0;
        let repairHint: string | undefined;
        let priorEvaluations: AgentRunEvaluation[] | undefined;
        let result: AgentRouteExecutorResult = {};
        let evaluations: AgentRunEvaluation[] = [];
        let escalation: { route: AgentRunRoute; goal?: string; hint?: string } | undefined;
        let stepStatus: AgentRunStepStatus = "needs_review";
        let clarifyQuestion: string | undefined;
        let isClarify = false;

        // Build → evaluate → modify loop for this step.
        for (;;) {
          emit({
            type: "executor.started",
            message: attempt === 0
              ? `Running ${route.replaceAll("_", " ")} executor.`
              : `Re-running ${route.replaceAll("_", " ")} executor (repair attempt ${attempt}).`,
            route,
          });
          // Provider readiness belongs at the provider boundary. The engine
          // cannot infer it from an executor return value: a deterministic
          // route may be provider-free and a provider route can fail during
          // preflight before any executor result exists.
          result = await this.executeRoute({
            runId,
            request: taskRequest,
            route,
            routeDecision: taskRouteDecision,
            maxRepairAttempts: budgets.limits.lane.execution,
            attempt,
            stepGoal: planned.goal,
            priorEvaluations,
            priorArtifacts: progress.artifacts,
            repairHint,
            emit,
            emitAnswerDelta: onAnswerDelta,
          });
          recordExecutionAttemptSummaryV1(traceObserver, result);
          // The router owns a frozen analytical tier. An executor may report a
          // same-tier execution failure, but it cannot turn a certified or
          // semantic plan into generated work (or vice versa) after execution
          // has started. Keep this guard in the engine as well as host adapters
          // so an injected/legacy executor cannot redefine durable provenance.
          const planWasFrozen = taskRouteDecision.analyticalCascadeDecision?.planFrozen === true;
          taskRouteDecision = applyExploratoryExecutionFreeze(taskRouteDecision, result.analyticalExecutionFreeze);
          taskRouteDecision = applyExploratoryExecutionFreeze(taskRouteDecision, result.analyticalExecutionRepairFreeze);
          // Legacy/non-authoritative execution has no task-local durable
          // decision. Promote the validated host authorization receipts back
          // to the run-level decision so the persisted run and trace retain
          // the same immutable exploratory handoff that the executor used.
          // Authoritative compound Ask keeps its outer decision as a turn
          // summary and records each task-local handoff independently.
          // A single authoritative task is still the whole Ask answer.  Its
          // host-issued exploratory execution freeze must be promoted to the
          // outer decision so V3/V6 persistence and the trace retain the same
          // capability receipt that authorized SQL.  Compound Ask keeps each
          // frozen child isolated under its task execution receipts.
          if (!taskExecution || (routeDecision.askAnalystDecision?.taskExecutions?.length ?? 0) === 1) {
            routeDecision = taskRouteDecision;
          }
          // The router froze the exploratory plan before SQL generation. The
          // host receipt below only authorizes this exact SQL/target against
          // that immutable plan; it never creates a second freeze transition.
          if (!planWasFrozen && taskRouteDecision.analyticalCascadeDecision?.planFrozen) {
            recordAuthoritativePlanFreezeV1(traceObserver, taskRouteDecision.analyticalCascadeDecision);
          }
          result = preserveFrozenAnalyticalRoute(route, taskRouteDecision, result);
          result = consumeRepeatedClarificationSelection(taskRequest, taskRouteDecision, result);
          if (result.analyticalTurnPlan) progress.analyticalTurnPlan = result.analyticalTurnPlan;
          if (result.analyticalTaskOutcomes) progress.analyticalTaskOutcomes = result.analyticalTaskOutcomes;
          persistProgress();

          // A terminal V2 `finish_answer` is accepted only after the host has
          // frozen one snapshot-bound plan and recorded an actual execution
          // result.  The generic evaluator predates that runtime and can
          // otherwise request a legacy replan of the very same certified
          // artifact.  That second invocation is correctly refused by the
          // V2 kernel as `POST_FREEZE_REPAIR_REQUIRED`, but it also discards
          // the valid result which already ran.  Preserve the successful V2
          // boundary here; terminal V2 errors still flow through the ordinary
          // evaluation and blocked-outcome path below.
          evaluations = this.evaluate({ route, request: taskRequest, routeDecision: taskRouteDecision, result, attempt });
          for (const evaluation of evaluations) {
            emit({
              type: "evaluation.recorded",
              message: evaluation.message,
              route,
              payload: evaluation,
            });
          }

          // An executor that explicitly self-declares blocked is terminal (infra blocker).
          if (result.status === "blocked") {
            stepStatus = "blocked";
            break;
          }

          const failing = evaluations.find((evaluation) => !evaluation.passed && evaluation.suggestedRepair);
          if (!failing) {
            stepStatus = attempt > 0 ? "repaired" : "passed";
            break;
          }

          // A frozen analytical plan has one route and no downstream planner,
          // rematch, route escalation, or whole-answer regeneration authority.
          // Typed server-issued repair is a separate derived run.
          //
          // AN ASK V2 TURN IS ONE TURN. Its kernel owns a single immutable
          // snapshot, one frozen plan and one terminal; re-running the
          // executor cannot improve it and actively destroys it — the second
          // pass opens a fresh lane closure over a state that already
          // finished, so a result the first pass validated (and preserved
          // through a narration failure) is replaced by that pass's
          // budget-exhausted refusal. Observed live: a governed relational
          // query executed and returned rows, and the run reported "DQL
          // stopped at its own orchestration budget" with zero facts.
          if (authoritativeAsk || taskRouteDecision.analyticalCascadeDecision?.planFrozen === true) {
            stepStatus = 'needs_review';
            break;
          }

          const currentStep: AgentRunStep = {
            id: stepId,
            index: stepCount,
            route,
            goal: planned.goal,
            successCriteria: planned.successCriteria,
            status: "needs_review",
            attempts: attempt + 1,
            summary: result.summary,
            evaluations,
            artifacts: result.artifacts ?? [],
          };
          const decision = await activePlanner.replan({
            request: taskRequest,
            plan,
            currentStep,
            remainingSteps: queue,
            attemptsUsed: attempt,
            repairAttemptsUsed: budgets.usage.laneExecutionAttemptsUsed,
            maxRepairAttempts: budgets.limits.lane.execution,
            engineEscalationsUsed: budgets.usage.engineEscalationsUsed,
            maxEngineEscalations: budgets.limits.engineEscalations,
            budgetUsage: cascadeBudgetTrace(budgets),
          });
          emit({
            type: "replan.decided",
            message: describeReplan(decision),
            route,
            payload: decision,
          });

          if (decision.decision === "repair") {
            const nextRepairHint = repairHintForEvaluation(failing, decision.repairHint);
            if (!canUseLaneRepair(budgets, "execution")) {
              stepStatus = "needs_review";
              emit({
                type: "repair.attempted",
                message: `Repair budget exhausted for ${route.replaceAll("_", " ")}.`,
                route,
                payload: {
                  repairHint: nextRepairHint,
                  budgetUsage: cascadeBudgetTrace(budgets),
                },
              });
              break;
            }
            recordLaneRepair(budgets, "execution");
            attempt += 1;
            repairHint = nextRepairHint;
            priorEvaluations = evaluations;
            emit({
              type: "repair.attempted",
              message: `Repairing ${route.replaceAll("_", " ")}: ${repairHint}`,
              route,
              payload: { attempt, repairHint, budgetUsage: cascadeBudgetTrace(budgets) },
            });
            continue;
          }
          if (decision.decision === "escalate") {
            if (!canUseEngineEscalation(budgets)) {
              stepStatus = "needs_review";
              emit({
                type: "escalated",
                message: `Escalation budget exhausted for ${route.replaceAll("_", " ")}.`,
                route,
                payload: { decision, budgetUsage: cascadeBudgetTrace(budgets) },
              });
              break;
            }
            recordEngineEscalation(budgets);
            escalation = { route: decision.route, goal: decision.goal, hint: repairHintForEvaluation(failing, decision.repairHint) };
            stepStatus = "escalated";
            emit({
              type: "escalated",
              message: `Escalating ${route.replaceAll("_", " ")} → ${decision.route.replaceAll("_", " ")}.`,
              route,
              payload: { ...decision, budgetUsage: cascadeBudgetTrace(budgets) },
            });
            break;
          }
          if (decision.decision === "clarify") {
            isClarify = true;
            clarifyQuestion = decision.question;
            stepStatus = "clarify";
            break;
          }
          // "accept"
          stepStatus = "needs_review";
          break;
        }

        // Escalated steps are recorded in the trace but their output is superseded.
        if (escalation) {
          executedSteps.push({
            id: stepId,
            index: stepCount,
            route,
            ...(planned.askAnalystTaskId ? { askAnalystTaskId: planned.askAnalystTaskId } : {}),
            goal: planned.goal,
            successCriteria: planned.successCriteria,
            status: "escalated",
            attempts: attempt + 1,
            summary: result.summary,
            evaluations,
            artifacts: [],
          });
          checkpointAuthoritativeTaskOutcomes();
          emit({
            type: "step.completed",
            message: `Step ${stepCount} escalated to ${escalation.route.replaceAll("_", " ")}.`,
            route,
            payload: { stepId, status: "escalated" },
          });
          queue.unshift({
            id: `${stepId}:escalation`,
            route: escalation.route,
            goal: escalation.goal ?? `Escalated from ${route} to ${escalation.route}.`,
            successCriteria: [],
          });
          continue;
        }

        const outcome = computeStepOutcome(
          route,
          result,
          evaluations,
          taskRequest,
          isClarify,
          clarifyQuestion,
          taskRouteDecision.terminalOutcome?.message,
        );
        const step: AgentRunStep = {
          id: stepId,
          index: stepCount,
          route,
          ...(planned.askAnalystTaskId ? { askAnalystTaskId: planned.askAnalystTaskId } : {}),
          resolvedRoute: result.resolvedRoute,
          goal: planned.goal,
          successCriteria: planned.successCriteria,
          status: outcome.status === "blocked" ? "blocked" : stepStatus,
          attempts: attempt + 1,
          summary: outcome.summary,
          evaluations,
          artifacts: outcome.artifacts,
        };
        executedSteps.push(step);

        for (const artifact of outcome.artifacts) {
          emit({
            type: "artifact.created",
            message: `Created ${artifact.kind.replaceAll("_", " ")} artifact.`,
            route,
            trustState: artifact.trustState,
            payload: artifact,
          });
        }
        // Artifact events above are the immutable result proof. Checkpoint the
        // task only after that proof has joined persisted progress; a restart
        // between task siblings can then retain a completed independent result
        // and mark only its dependents as blocked.
        checkpointAuthoritativeTaskOutcomes();
        emit({
          type: "step.completed",
          message: `Step ${stepCount} ${step.status}.`,
          route,
          status: outcome.status,
          trustState: outcome.trustState,
          payload: { stepId, status: step.status },
        });

        if (isClarify) {
          clarifyOutcome = { step, question: clarifyQuestion };
          finalStep = step;
          finalResult = result;
          finalOutcome = outcome;
          // Every accepted authoritative child was frozen before the first
          // execution.  A blocked/clarify outcome for task-1 must not prevent
          // task-2 from receiving its independently scoped attempt and receipt.
          // Finalization below aggregates these outcomes as all-or-nothing, so
          // no partial answer can escape.
          if (!authoritativeCompoundAsk) break;
          continue;
        }

        finalStep = step;
        finalResult = result;
        finalOutcome = outcome;
        if (outcome.status !== "blocked" && typeof result.answer === "string" && result.answer.trim().length > 0) {
          bestAnswerResult = result;
        }

        if (outcome.status === "blocked" && !authoritativeCompoundAsk) break;
        if (outcome.status === "needs_clarification" && !authoritativeCompoundAsk) break;
        // A successful task is terminal only for a single-task Ask.  Multi-task
        // authoritative plans were all frozen before execution and therefore
        // continue to their own task-local result receipt.
        const hasMoreAuthoritativeTasks = authoritativeAsk
          && (routeDecision.askAnalystDecision?.taskExecutions?.length ?? 0) > 1;
        if (isTerminalSuccess(route, outcome) && !hasMoreAuthoritativeTasks) break;
        // Otherwise continue to the next planned step (if any remain).
      }

      const authoritativeTaskOutcomeAggregate = authoritativePartialOutcomeMode
        ? aggregateAuthoritativeTaskOutcomes({
            initialTaskOutcomes,
            taskExecutions: authoritativeTaskExecutions,
            steps: executedSteps,
            dependencyBlockedTaskIds: runtimeDependencyBlockedTaskIds,
            taskCount: initialTaskOutcomeSummary?.taskCount,
            finalized: true,
          })
        : undefined;
      const authoritativeCompoundFailure = authoritativeCompoundAsk && !authoritativePartialOutcomeMode
        ? compoundAskFailureForFrozenTasks({
            expectedTaskIds: [...authoritativeTaskIds],
            plan,
            steps: executedSteps,
          })
        : undefined;
      const run = this.finalizeRun({
        runId,
        request,
        requestedMode,
        startedAt,
        routeDecision,
        plan,
        steps: executedSteps,
        finalStep,
        finalResult,
        finalOutcome,
        clarifyOutcome,
        bestAnswerResult,
        ...(authoritativeTaskOutcomeAggregate ? { authoritativeTaskOutcomeAggregate } : {}),
        ...(authoritativeCompoundFailure ? { authoritativeCompoundFailure } : {}),
        budgetUsage: cascadeBudgetTrace(budgets),
        events,
      });
      run.question = submittedQuestion;
      emit({
        type: run.status === "blocked" ? "run.failed" : "run.completed",
        message: run.status === "blocked"
          ? "Agent run failed with a blocked outcome."
          : `Agent run completed with status ${run.status}.`,
        route: run.route,
        status: run.status,
        trustState: run.trustState,
        payload: { budgetUsage: run.budgetUsage },
      });
      run.completedAt = this.timestamp();
      run.lifecycle = terminalLifecycle(
        progress.lifecycle,
        run.status === "blocked" ? "run.failed" : "run.completed",
        run.completedAt,
        events.length,
      );
      run.diagnosticReceipt = diagnosticReceiptForRun(run);
      run.diagnosticReceiptV2 = diagnosticReceiptV2ForRun(run);
      run.diagnosticReceiptV3 = diagnosticReceiptV3ForRun(run);
      run.diagnosticReceiptV4 = diagnosticReceiptV4ForRun(run);
      attachAskAnalystRuntimeReceipt(run, request.askAgentRuntimeMode);
      run.artifacts = attachDiagnosticReceipt(run.artifacts, run.diagnosticReceipt);
      finalizeAgentRunTraceV1(traceObserver, run);
      await checkpointQueue;
      await this.store?.save(run);
      return run;
    } catch (err) {
      const dispatchEvidence = providerDispatchEvidenceFromError(err);
      const userCancelled = isAgentRunUserCancellation(request.signal?.reason) || isAgentRunUserCancellation(err);
      if (userCancelled) {
        const message = "Stopped by user.";
        const cancelledRoute = progress.route ?? "cancelled";
        const cancelledPhase = progress.lifecycle.phase;
        emit({
          type: "run.cancelled",
          message,
          route: cancelledRoute,
          status: "cancelled",
          trustState: "not_applicable",
        });
        const completedAt = this.timestamp();
        const failure: AgentRunDiagnosticFailureV1 = {
          code: AGENT_RUN_USER_CANCEL_CODE,
          phase: cancelledPhase,
          message,
          recoverable: false,
          safeActions: [],
        };
        const evaluations: AgentRunEvaluation[] = [
          ...progress.evaluations,
          {
            id: "run-cancelled",
            label: "Run cancelled",
            passed: true,
            severity: "info",
            message,
          },
        ];
        const receipt: AgentRunDiagnosticReceiptV1 = {
          version: 1,
          runId,
          phase: failure.phase,
          route: cancelledRoute,
          plan,
          steps: executedSteps,
          artifacts: progress.artifacts,
          evaluations,
          failure,
        };
        const run: AgentRun = {
          id: runId,
          question: submittedQuestion,
          requestedMode,
          conversationBinding: request.conversationBinding ?? traceConversationBinding(request, clarificationContinuation),
          route: cancelledRoute,
          status: "cancelled",
          trustState: "not_applicable",
          stopReason: "cancelled",
          startedAt,
          completedAt,
          selectedObject: request.selectedObject,
          executionTarget: request.executionTarget,
          routeDecision,
          plan,
          steps: executedSteps,
          summary: message,
          artifacts: progress.artifacts,
          evaluations,
          events,
          nextActions: [],
          repairAttempts: 0,
          escalationAttempts: 0,
          budgetUsage: cascadeBudgetTrace(createCascadeBudgetState(this.budgetModel)),
          diagnosticReceipt: receipt,
          ...(dispatchEvidence.providerEgressReceipts.length
            ? { providerEgressReceipts: dispatchEvidence.providerEgressReceipts }
            : {}),
          telemetry: {
            ...emptyRunTelemetry(durationBetweenMs(startedAt, completedAt), "cancelled"),
            providerRoundTrips: dispatchEvidence.providerRoundTrips,
            toolCalls: dispatchEvidence.toolCalls,
            sqlExecutions: dispatchEvidence.sqlExecutions,
            repairs: dispatchEvidence.repairs,
            egressReceipts: dispatchEvidence.providerEgressReceipts.length,
          },
          lifecycle: terminalLifecycle(progress.lifecycle, "run.cancelled", completedAt, events.length),
        };
        run.diagnosticReceiptV2 = diagnosticReceiptV2ForRun(run);
        run.diagnosticReceiptV3 = diagnosticReceiptV3ForRun(run);
        run.diagnosticReceiptV4 = diagnosticReceiptV4ForRun(run);
        attachAskAnalystRuntimeReceipt(run, request.askAgentRuntimeMode);
        finalizeAgentRunTraceV1(traceObserver, run);
        await checkpointQueue;
        await this.store?.save(run);
        return run;
      }
      const message = isOrchestrationBudgetExhausted(err)
        ? 'Ask could not complete within its bounded orchestration. Nothing was executed; narrow the metric or dimension and retry.'
        : err instanceof Error && err.name === "TimeoutError"
        ? requestedMode === 'research'
          ? 'This Research run reached its bounded deadline before finalization. Review the recorded branch receipts and trace, then narrow the investigation and retry. No result was accepted.'
          : "This analytical run reached its time limit before it finished. A timeout alone does not prove a cross-model join or semantic-modeling problem. Open Trust & Steps to see the last recorded phase; retry the same bounded question or use Research for a longer budget. No result was accepted."
        : err instanceof Error ? err.message : String(err);
      const failedRoute = progress.route;
      const failedPhase = progress.lifecycle.phase;
      emit({
        type: "run.failed",
        message,
        route: "blocked",
        status: "blocked",
        trustState: "blocked",
      });
      const completedAt = this.timestamp();
      const failure = diagnosticFailureFromError(err, failedPhase, requestedMode);
      const evaluations: AgentRunEvaluation[] = [
        ...progress.evaluations,
        {
          id: "executor-error",
          label: "Executor error",
          passed: false,
          severity: "blocking",
          message,
          suggestedRepair: failure.recoverable ? "Retry the same request." : undefined,
        },
      ];
      const retainedArtifacts = progress.artifacts.filter((artifact) => artifact.trustState === "blocked");
      const receipt: AgentRunDiagnosticReceiptV1 = {
        version: 1,
        runId,
        phase: failure.phase,
        route: failedRoute,
        plan,
        steps: executedSteps,
        artifacts: retainedArtifacts,
        evaluations,
        failure,
      };
      const run: AgentRun = {
        id: runId,
        question: submittedQuestion,
        requestedMode,
        conversationBinding: request.conversationBinding ?? traceConversationBinding(request, clarificationContinuation),
        route: "blocked",
        status: "blocked",
        trustState: "blocked",
        stopReason: "blocked",
        startedAt,
        completedAt,
        selectedObject: request.selectedObject,
        executionTarget: request.executionTarget,
        routeDecision,
        plan,
        steps: executedSteps,
        summary: message,
        artifacts: attachDiagnosticReceipt(retainedArtifacts, receipt),
        evaluations,
        events,
        nextActions: failure.recoverable
          ? [{ id: "retry-failed-run", label: "Retry request", route: failedRoute }]
          : [],
        repairAttempts: 0,
        escalationAttempts: 0,
        budgetUsage: cascadeBudgetTrace(createCascadeBudgetState(this.budgetModel)),
        diagnosticReceipt: receipt,
        ...(dispatchEvidence.providerEgressReceipts.length
          ? { providerEgressReceipts: dispatchEvidence.providerEgressReceipts }
          : {}),
        telemetry: {
          ...emptyRunTelemetry(durationBetweenMs(startedAt, completedAt), dispatchEvidence.fallbackReason),
          providerRoundTrips: dispatchEvidence.providerRoundTrips,
          toolCalls: dispatchEvidence.toolCalls,
          sqlExecutions: dispatchEvidence.sqlExecutions,
          repairs: dispatchEvidence.repairs,
          egressReceipts: dispatchEvidence.providerEgressReceipts.length,
        },
        lifecycle: terminalLifecycle(progress.lifecycle, "run.failed", completedAt, events.length),
      };
      run.diagnosticReceiptV2 = diagnosticReceiptV2ForRun(run);
      run.diagnosticReceiptV3 = diagnosticReceiptV3ForRun(run);
      run.diagnosticReceiptV4 = diagnosticReceiptV4ForRun(run);
      attachAskAnalystRuntimeReceipt(run, request.askAgentRuntimeMode);
      run.artifacts = attachDiagnosticReceipt(retainedArtifacts, receipt);
      finalizeAgentRunTraceV1(traceObserver, run);
      await checkpointQueue;
      await this.store?.save(run);
      return run;
    }
  }

  private finalizeRun(input: {
    runId: string;
    request: AgentRunRequest;
    requestedMode: AgentRunRequestedMode;
    startedAt: string;
    routeDecision: IntentDecision;
    plan: AgentRunPlan;
    steps: AgentRunStep[];
    finalStep?: AgentRunStep;
    finalResult?: AgentRouteExecutorResult;
    finalOutcome?: StepOutcome;
    clarifyOutcome?: { step: AgentRunStep; question?: string };
    bestAnswerResult?: AgentRouteExecutorResult;
    authoritativeTaskOutcomeAggregate?: AuthoritativeTaskOutcomeAggregateV1;
    authoritativeCompoundFailure?: AuthoritativeCompoundFailureV1;
    budgetUsage: CascadeBudgetTrace;
    events: AgentRunEvent[];
  }): AgentRun {
    const { finalStep, finalResult, finalOutcome } = input;
    const repairAttempts = input.budgetUsage.usage.laneExecutionAttemptsUsed;
    const escalationAttempts = input.budgetUsage.usage.engineEscalationsUsed;
    const completedAt = this.timestamp();

    if (input.authoritativeTaskOutcomeAggregate) {
      const aggregate = input.authoritativeTaskOutcomeAggregate;
      const successfulSteps = input.steps.filter((step) => {
        const taskId = step.askAnalystTaskId;
        return taskId
          ? aggregate.summary.successfulTaskIds.includes(taskId)
          : false;
      });
      const lastSuccessfulStep = [...successfulSteps].reverse()[0];
      const route = lastSuccessfulStep?.resolvedRoute ?? lastSuccessfulStep?.route ?? 'blocked';
      const hasSuccessfulTask = aggregate.summary.successfulTaskIds.length > 0;
      const status: AgentRunStatus = !hasSuccessfulTask
        ? 'blocked'
        : aggregate.summary.trustState === 'review_required'
          ? 'needs_review'
          : 'completed';
      const artifacts = input.steps.flatMap((step) => step.artifacts);
      const evaluations = input.steps.flatMap((step) => step.evaluations);
      const partialSummary = taskOutcomeAggregateSummaryText(aggregate.summary);
      return {
        id: input.runId,
        question: input.request.question,
        requestedMode: input.requestedMode,
        conversationBinding: input.request.conversationBinding ?? traceConversationBinding(input.request, undefined),
        route,
        status,
        trustState: aggregate.summary.trustState,
        stopReason: status === 'blocked'
          ? 'blocked'
          : aggregate.summary.trustState === 'review_required'
            ? 'generated_review_required'
            : 'governed_compound_answer',
        startedAt: input.startedAt,
        completedAt,
        selectedObject: input.request.selectedObject,
        executionTarget: input.request.executionTarget,
        routeDecision: input.routeDecision,
        plan: input.plan,
        steps: input.steps,
        summary: partialSummary,
        answer: partialSummary,
        answerKind: 'governed',
        artifacts,
        evaluations,
        events: input.events,
        nextActions: applyAudienceToNextActions(
          defaultNextActions(route, status),
          resolveAudience(input.request),
          status,
        ),
        repairAttempts,
        escalationAttempts,
        budgetUsage: input.budgetUsage,
        analyticalTaskOutcomes: aggregate.outcomes,
        analyticalTaskOutcomeSummary: aggregate.summary,
        ...authoringDerivationFromRequest(input.request),
      };
    }

    if (input.authoritativeCompoundFailure) {
      const failure = input.authoritativeCompoundFailure;
      const failedSteps = input.steps.filter((step) =>
        step.askAnalystTaskId && failure.failedTaskIds.includes(step.askAnalystTaskId));
      // The per-task steps remain on the run and trace as evidence, but a
      // compound Ask never adopts an earlier data artifact/answer after one
      // accepted frozen task failed.  Returning only the failed artifacts
      // avoids presenting a partial result as the response to the whole ask.
      const artifacts = failedSteps.flatMap((step) => step.artifacts);
      const evaluations = [
        ...input.steps.flatMap((step) => step.evaluations),
        {
          id: 'authoritative-compound-all-or-nothing',
          label: 'Frozen Ask task completion',
          passed: false,
          severity: 'blocking' as const,
          message: failure.message,
          evidence: {
            expectedTaskIds: failure.expectedTaskIds,
            completedTaskIds: failure.completedTaskIds,
            failedTaskIds: failure.failedTaskIds,
            missingTaskIds: failure.missingTaskIds,
          },
        },
      ];
      return {
        id: input.runId,
        question: input.request.question,
        requestedMode: input.requestedMode,
        conversationBinding: input.request.conversationBinding ?? traceConversationBinding(input.request, undefined),
        route: 'blocked',
        status: 'blocked',
        trustState: 'blocked',
        stopReason: 'blocked',
        startedAt: input.startedAt,
        completedAt,
        selectedObject: input.request.selectedObject,
        executionTarget: input.request.executionTarget,
        routeDecision: input.routeDecision,
        plan: input.plan,
        steps: input.steps,
        summary: failure.message,
        answer: failure.message,
        answerKind: 'governed',
        artifacts,
        evaluations,
        events: input.events,
        nextActions: applyAudienceToNextActions(
          defaultNextActions('blocked', 'blocked'),
          resolveAudience(input.request),
          'blocked',
        ),
        repairAttempts,
        escalationAttempts,
        budgetUsage: input.budgetUsage,
        ...authoringDerivationFromRequest(input.request),
      };
    }

    if (!finalStep || !finalResult || !finalOutcome) {
      // No step produced a usable result (e.g. an empty plan). Treat as blocked.
      return {
        id: input.runId,
        question: input.request.question,
        requestedMode: input.requestedMode,
        conversationBinding: input.request.conversationBinding ?? traceConversationBinding(input.request, undefined),
        route: "blocked",
        status: "blocked",
        trustState: "blocked",
        stopReason: "blocked",
        startedAt: input.startedAt,
        completedAt,
        selectedObject: input.request.selectedObject,
        executionTarget: input.request.executionTarget,
        routeDecision: input.routeDecision,
        plan: input.plan,
        steps: input.steps,
        summary: "The agent run produced no executable step.",
        artifacts: [],
        evaluations: [{
          id: "empty-plan",
          label: "Empty plan",
          passed: false,
          severity: "blocking",
          message: "The planner returned no runnable steps.",
        }],
        events: input.events,
        nextActions: [],
        repairAttempts,
        escalationAttempts,
        budgetUsage: input.budgetUsage,
        ...authoringDerivationFromRequest(input.request),
      };
    }

    const route = finalResult.resolvedRoute ?? finalStep.resolvedRoute ?? finalStep.route;
    // Provider diagnostics are produced at the physical runner boundary.
    // Merge only that typed, redacted observation; executor prose never gets
    // to rewrite routing, trust, or cascade authority.
    // A V2 provider boundary can be observed by the tool runner after its
    // legacy-shaped no-answer envelope has already crossed the local executor
    // adapter.  The immutable V2 state is shared with this finalizer and is
    // the durable source of truth at that point.  Project its terminal
    // provider observation here, at the persisted route-decision boundary,
    // rather than trying to infer it from user-facing error prose upstream.
    const providerFailure = finalResult.providerFailure
      // Planner/preflight failures can be terminal before a V2 executor emits
      // an answer envelope.  The typed decision is already the authoritative
      // boundary in that case; retain it for older receipt readers without
      // classifying user-facing prose.
      ?? input.routeDecision.providerFailure;
    const finalRouteDecision = providerFailure
      ? { ...input.routeDecision, providerFailure }
      : input.routeDecision;
    // Aggregate artifacts across every accepted step so a multi-step plan
    // (e.g. research → block draft) surfaces all of its durable work, while the
    // status/trust/answer reflect the final step.
    const artifacts = input.steps.flatMap((step) => step.artifacts);
    // If the final step produced no user-facing answer (e.g. it only drafted an
    // artifact), fall back to the last step that DID answer so the run never
    // drops a data answer an earlier step already computed.
    const finalHasAnswer = finalOutcome.status !== "blocked"
      && typeof finalResult.answer === "string" && finalResult.answer.trim().length > 0;
    const answerSource = finalHasAnswer ? finalResult : (input.bestAnswerResult ?? finalResult);
    const acceptedAnswer = finalOutcome.status === "blocked"
      ? finalOutcome.summary
      : input.clarifyOutcome?.question ?? answerSource.answer;
    return {
      id: input.runId,
      question: input.request.question,
      requestedMode: input.requestedMode,
      conversationBinding: input.request.conversationBinding ?? traceConversationBinding(input.request, undefined),
      route,
      status: finalOutcome.status,
      trustState: finalOutcome.trustState,
      stopReason: finalOutcome.stopReason,
      startedAt: input.startedAt,
      completedAt,
      selectedObject: input.request.selectedObject,
      executionTarget: input.request.executionTarget,
      routeDecision: finalRouteDecision,
      plan: input.plan,
      steps: input.steps,
      summary: finalOutcome.summary,
      answer: acceptedAnswer,
      answerKind: answerSource.answerKind ?? "governed",
      artifacts,
      evaluations: finalStep.evaluations,
      events: input.events,
      nextActions: applyAudienceToNextActions(
        finalResult.nextActions ?? defaultNextActions(route, finalOutcome.status),
        resolveAudience(input.request),
        finalOutcome.status,
      ),
      ...(finalOutcome.status === "needs_clarification"
        && (finalResult.clarificationOptions?.length || input.routeDecision.clarificationOptions?.length)
        ? { clarificationOptions: finalResult.clarificationOptions ?? input.routeDecision.clarificationOptions }
        : {}),
      repairAttempts: finalResult.repairAttempts ?? repairAttempts,
      ...(finalResult.providerEgressReceipts?.length
        ? { providerEgressReceipts: finalResult.providerEgressReceipts }
        : {}),
      ...(finalResult.telemetry ? {
        telemetry: withTotalDuration(finalResult.telemetry, durationBetweenMs(input.startedAt, completedAt)),
      } : {}),
      ...(finalResult.narrationIntegrityReceipt ? {
        narrationIntegrityReceipt: finalResult.narrationIntegrityReceipt,
      } : {}),
      ...(finalResult.askPipelineReceipt ? { diagnosticReceiptV9: finalResult.askPipelineReceipt } : {}),
      ...(finalResult.askAnalystState ? { askAnalystState: finalResult.askAnalystState } : {}),
      ...(finalResult.businessAnswer ? { businessAnswer: finalResult.businessAnswer } : {}),
      ...(finalResult.knowledge ? { knowledge: finalResult.knowledge } : {}),
      escalationAttempts,
      budgetUsage: input.budgetUsage,
      ...(finalResult.analyticalTurnPlan ? { analyticalTurnPlan: finalResult.analyticalTurnPlan } : {}),
      ...(finalResult.analyticalTaskOutcomes ? { analyticalTaskOutcomes: finalResult.analyticalTaskOutcomes } : {}),
      ...authoringDerivationFromRequest(input.request),
    };
  }

  private evaluate(context: AgentRunGateContext): AgentRunEvaluation[] {
    // The Ask pipeline proves its own answer (entailment, compilation, the
    // filter and fan-out proofs). The legacy gates re-read the question with
    // regexes and would re-judge a proven answer; its evaluations stand.
    if (context.request.askAgentRuntimeMode === 'pipeline_v3') return context.result.evaluations ?? [];
    const gate = this.gates[context.route];
    if (gate) return gate(context);
    return context.result.evaluations
      ?? defaultEvaluations(context.route, context.request, context.routeDecision);
  }

  private async executeRoute(context: AgentRouteExecutionContext): Promise<AgentRouteExecutorResult> {
    const executor = this.executors[context.route];
    if (executor) {
      const frozenPlan = context.routeDecision?.resolvedAnalyticalPlan?.mode === 'authoritative';
      const startsAnalyticalWork = context.route === 'certified_answer'
        || context.route === 'semantic_answer'
        || context.route === 'generated_answer'
        || context.route === 'research';
      if (
        startsAnalyticalWork
        && !frozenPlan
        && context.request.runBudget
        && !context.request.runBudget.mayStartDiscovery(context.route)
      ) {
        return softBoundaryResult(context.route, context.request.runBudget, context.priorArtifacts);
      }
      const signal = context.request.runBudget?.hardSignal ?? context.request.signal;
      if (signal?.aborted) throw signal.reason ?? routeTimeoutError();
      // Route executors own physical provider/tool/SQL boundaries. Preserve the
      // non-enumerable observer when adding the run signal; a normal object
      // spread would otherwise leave canonical routing evidence intact while
      // silently dropping every physical execution span.
      const execution = Promise.resolve(executor({
        ...context,
        request: attachAskTraceObserverV1(
          { ...context.request, ...(signal ? { signal } : {}) },
          askTraceObserverForV1(context.request),
        ),
      }));
      return awaitWithAbort(execution, signal);
    }
    return defaultExecutorResult(context.route, context.request, context.routeDecision);
  }

  private absoluteDeadlineSignal(
    deadlineMs: number,
    runStartedAtMs: number,
    inherited: AbortSignal | undefined,
  ): AbortSignal {
    const elapsedMs = Math.max(0, this.now().getTime() - runStartedAtMs);
    const remainingMs = deadlineMs - elapsedMs;
    const deadlineSignal = remainingMs <= 0
      ? alreadyAbortedSignal(routeTimeoutError())
      : this.routeTimeoutSignal(remainingMs);
    return inherited ? AbortSignal.any([inherited, deadlineSignal]) : deadlineSignal;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

interface AuthoritativeCompoundFailureV1 {
  expectedTaskIds: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  missingTaskIds: string[];
  message: string;
}

/**
 * Execution-final receipt for the additive V2 ordinary-Ask task contract.
 * It is deliberately separate from `AuthoritativeCompoundFailureV1`: old
 * persisted compound decisions do not opt in merely by deserializing beside
 * this newer code.
 */
interface AuthoritativeTaskOutcomeAggregateV1 {
  outcomes: AnalyticalTaskOutcomeV1[];
  summary: AnalyticalTaskOutcomeSummaryV1;
}

function canonicalTaskResultArtifactForStep(step: AgentRunStep | undefined): {
  resultFingerprint: string;
} | undefined {
  if (!step) return undefined;
  for (const artifact of step.artifacts) {
    if (artifact.kind !== 'answer' || artifact.trustState === 'blocked') continue;
    const payload = objectRecordForResultFacts(artifact.payload);
    const result = objectRecordForResultFacts(payload?.result);
    const fingerprint = stringForResultFacts(result?.resultFingerprint);
    if (!result || !fingerprint) continue;
    const canonical = canonicalResultForFactProjection(result);
    if (!canonical || canonical.columns.length === 0 || canonical.resultFingerprint !== fingerprint) continue;
    return { resultFingerprint: fingerprint };
  }
  return undefined;
}

function hasAcceptedAuthoritativeTaskResult(step: AgentRunStep | undefined): boolean {
  if (step?.status !== 'passed' && step?.status !== 'repaired' && step?.status !== 'needs_review') return false;
  // A generated/review-required response becomes an accepted independent task
  // only once the immutable canonical result artifact is present.  Narrative
  // text alone is not evidence that a query executed.
  return Boolean(canonicalTaskResultArtifactForStep(step));
}

function aggregateAuthoritativeTaskOutcomes(input: {
  initialTaskOutcomes: AnalyticalTaskOutcomeV1[];
  taskExecutions: AskAnalystTaskExecutionV1[];
  steps: AgentRunStep[];
  dependencyBlockedTaskIds: ReadonlyMap<string, string[]>;
  taskCount?: number;
  /** False while a run is in-flight: unattempted tasks are still pending. */
  finalized?: boolean;
}): AuthoritativeTaskOutcomeAggregateV1 {
  const outcomeByTaskId = new Map<string, AnalyticalTaskOutcomeV1>();
  for (const outcome of input.initialTaskOutcomes) {
    // Each compiler task is authoritative exactly once. Preserve a planning
    // gap/dependency receipt while permitting a matching executable task to
    // replace only its own provisional status after it actually runs.
    outcomeByTaskId.set(outcome.taskId, {
      ...outcome,
      ...(outcome.dependencyTaskIds ? { dependencyTaskIds: [...outcome.dependencyTaskIds] } : {}),
    });
  }
  const orderedTaskIds = [
    ...input.taskExecutions.map((task) => task.taskId),
    ...input.initialTaskOutcomes.map((outcome) => outcome.taskId),
  ].filter((taskId, index, all) => all.indexOf(taskId) === index);

  for (const taskExecution of input.taskExecutions) {
    const taskId = taskExecution.taskId;
    const dependencyTaskIds = input.dependencyBlockedTaskIds.get(taskId);
    if (dependencyTaskIds?.length) {
      outcomeByTaskId.set(taskId, {
        version: 1,
        taskId,
        status: 'dependency_blocked',
        trustState: 'blocked',
        summary: 'This task was not executed because a required task did not complete successfully.',
        failure: {
          version: 1,
          code: 'DEPENDENCY_BLOCKED',
          message: 'A prerequisite task did not complete successfully.',
          phase: 'dependency',
        },
        dependencyTaskIds: [...dependencyTaskIds],
      });
      continue;
    }
    const step = input.steps.find((candidate) => candidate.askAnalystTaskId === taskId);
    if (!step) {
      if (!input.finalized) continue;
      outcomeByTaskId.set(taskId, {
        version: 1,
        taskId,
        status: 'blocked',
        trustState: 'blocked',
        summary: 'This task did not receive its required frozen execution attempt.',
        failure: {
          version: 1,
          code: 'TASK_EXECUTION_MISSING',
          message: 'This task did not receive its required frozen execution attempt.',
          phase: 'execution',
        },
      });
      continue;
    }
    if (hasAcceptedAuthoritativeTaskResult(step)) {
      const trustState = taskOutcomeTrustForExecutedStep(step, taskExecution);
      const resultFingerprint = taskResultFingerprintForStep(step);
      outcomeByTaskId.set(taskId, {
        version: 1,
        taskId,
        status: 'completed',
        trustState,
        summary: step.summary,
        ...(resultFingerprint ? { resultFingerprint } : {}),
      });
      continue;
    }
    const isClarification = step.status === 'clarify';
    const acceptedWithoutCanonicalResult = step.status === 'passed'
      || step.status === 'repaired'
      || step.status === 'needs_review';
    const message = acceptedWithoutCanonicalResult
      ? 'This task did not produce an immutable canonical result artifact.'
      : step.summary ?? (isClarification
      ? 'This task requires a business clarification before it can run.'
      : 'This task did not complete its frozen execution.');
    outcomeByTaskId.set(taskId, {
      version: 1,
      taskId,
      status: isClarification ? 'gap' : 'blocked',
      trustState: 'blocked',
      summary: message,
      failure: {
        version: 1,
        code: acceptedWithoutCanonicalResult
          ? 'TASK_EXECUTION_RESULT_MISSING'
          : isClarification ? 'TASK_REQUIRES_CLARIFICATION' : 'TASK_EXECUTION_FAILED',
        message,
        phase: 'execution',
      },
    });
  }

  const outcomes = orderedTaskIds
    .map((taskId) => outcomeByTaskId.get(taskId))
    .filter((outcome): outcome is AnalyticalTaskOutcomeV1 => Boolean(outcome));
  const successfulTaskIds = outcomes
    .filter((outcome) => outcome.status === 'completed' || outcome.status === 'partial')
    .map((outcome) => outcome.taskId);
  const failedTaskIds = outcomes
    .filter((outcome) => outcome.status !== 'completed' && outcome.status !== 'partial' && outcome.status !== 'dependency_blocked')
    .map((outcome) => outcome.taskId);
  const dependencyBlockedTaskIds = outcomes
    .filter((outcome) => outcome.status === 'dependency_blocked')
    .map((outcome) => outcome.taskId);
  const successfulTrustStates = outcomes
    .filter((outcome) => outcome.status === 'completed' || outcome.status === 'partial')
    .map((outcome) => outcome.trustState ?? 'blocked');
  const taskCount = Math.max(input.taskCount ?? 0, outcomes.length);
  return {
    outcomes,
    summary: {
      version: 1,
      status: successfulTaskIds.length === 0
        ? 'blocked'
        : failedTaskIds.length || dependencyBlockedTaskIds.length || successfulTaskIds.length < taskCount
          ? 'partial'
          : 'completed',
      trustState: leastTrustedExecutedTaskOutcomeState(successfulTrustStates),
      taskCount,
      successfulTaskIds,
      failedTaskIds,
      dependencyBlockedTaskIds,
    },
  };
}

function taskOutcomeTrustForExecutedStep(
  step: AgentRunStep,
  taskExecution: AskAnalystTaskExecutionV1,
): AnalyticalTaskOutcomeTrustStateV1 {
  const artifactStates = step.artifacts
    .map((artifact) => normalizeTaskOutcomeTrustState(artifact.trustState))
    .filter((state): state is AnalyticalTaskOutcomeTrustStateV1 => Boolean(state));
  const compiledState = taskExecution.compiledTrustState
    ?? taskOutcomeTrustStateForCompiler(taskExecution.resolvedPlan.compiler);
  // A review-required compiler is never elevated merely because an adapter
  // artifact used the older `governed` label.
  if (step.status === 'needs_review' || compiledState === 'review_required') return 'review_required';
  return leastTrustedExecutedTaskOutcomeState([...artifactStates, compiledState]);
}

function normalizeTaskOutcomeTrustState(
  trustState: AgentRunTrustState,
): AnalyticalTaskOutcomeTrustStateV1 | undefined {
  if (trustState === 'grounded') return 'governed';
  return trustState === 'certified'
    || trustState === 'governed'
    || trustState === 'review_required'
    || trustState === 'blocked'
    || trustState === 'not_applicable'
    ? trustState
    : undefined;
}

function taskOutcomeTrustStateForCompiler(
  compiler: AskAnalystTaskExecutionV1['resolvedPlan']['compiler'],
): AnalyticalTaskOutcomeTrustStateV1 {
  if (compiler === 'certified') return 'certified';
  if (compiler === 'metricflow' || compiler === 'governed_relational') return 'governed';
  if (compiler === 'exploratory_sql') return 'review_required';
  return 'blocked';
}

function leastTrustedExecutedTaskOutcomeState(
  states: AnalyticalTaskOutcomeTrustStateV1[],
): AnalyticalTaskOutcomeTrustStateV1 {
  if (states.length === 0) return 'blocked';
  const score: Record<AnalyticalTaskOutcomeTrustStateV1, number> = {
    certified: 4,
    governed: 3,
    review_required: 2,
    not_applicable: 1,
    blocked: 0,
  };
  return states.reduce((least, candidate) => score[candidate] < score[least] ? candidate : least);
}

function taskResultFingerprintForStep(step: AgentRunStep): string | undefined {
  return canonicalTaskResultArtifactForStep(step)?.resultFingerprint;
}

function taskOutcomeAggregateSummaryText(summary: AnalyticalTaskOutcomeSummaryV1): string {
  if (summary.status === 'completed') {
    return `All ${summary.taskCount} independent analytical task${summary.taskCount === 1 ? '' : 's'} completed.`;
  }
  if (summary.status === 'partial') {
    return `${summary.successfulTaskIds.length} of ${summary.taskCount} independent analytical task${summary.taskCount === 1 ? '' : 's'} completed. The remaining task receipts explain what needs attention.`;
  }
  return 'No independently executable analytical task completed. Review the task receipts for the recorded gaps or dependency blocks.';
}

/**
 * A compound authoritative Ask is accepted only after every task has its own
 * immutable program.  Preserve a receipt for every attempted child, then make
 * the parent terminal when any child blocked/clarified/escalated or was never
 * attempted.  This is intentionally evaluated after the queue drains so a
 * first failure cannot hide a later frozen task from the trace.
 */
function compoundAskFailureForFrozenTasks(input: {
  expectedTaskIds: string[];
  plan: AgentRunPlan;
  steps: AgentRunStep[];
}): AuthoritativeCompoundFailureV1 | undefined {
  const expectedTaskIds = [...input.expectedTaskIds];
  const expected = new Set(expectedTaskIds);
  const taskSteps = input.steps.filter((step) => step.askAnalystTaskId && expected.has(step.askAnalystTaskId));
  const completedTaskIds = [...new Set(taskSteps
    .filter((step) => step.status === 'passed' || step.status === 'repaired' || step.status === 'needs_review')
    .map((step) => step.askAnalystTaskId!))];
  const failedTaskIds = [...new Set(taskSteps
    .filter((step) => step.status === 'blocked' || step.status === 'clarify' || step.status === 'escalated')
    .map((step) => step.askAnalystTaskId!))];
  const attempted = new Set(taskSteps.map((step) => step.askAnalystTaskId!));
  const missingTaskIds = expectedTaskIds.filter((taskId) => !attempted.has(taskId));
  if (failedTaskIds.length === 0 && missingTaskIds.length === 0 && completedTaskIds.length === expectedTaskIds.length) {
    return undefined;
  }
  const failureParts = [
    failedTaskIds.length ? `${failedTaskIds.length} frozen task${failedTaskIds.length === 1 ? '' : 's'} failed` : '',
    missingTaskIds.length ? `${missingTaskIds.length} frozen task${missingTaskIds.length === 1 ? '' : 's'} did not receive an execution attempt` : '',
  ].filter(Boolean);
  return {
    expectedTaskIds,
    completedTaskIds,
    failedTaskIds,
    missingTaskIds,
    message: `The Ask plan ran every available frozen task, but ${failureParts.join(' and ') || 'the task receipts were incomplete'}. No partial result was accepted.`,
  };
}

function traceLinkFingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Only a host-produced repair derivation is linkable; ordinary authoring context is not. */
function traceDerivedSourceRunId(workspaceContext: AgentRunRequest['workspaceContext']): string | undefined {
  if (!workspaceContext || typeof workspaceContext !== 'object' || Array.isArray(workspaceContext)) return undefined;
  const record = workspaceContext as Record<string, unknown>;
  const derivation = record.traceDerivation;
  if (derivation !== 'analytical_repair' && derivation !== 'derived_repair') return undefined;
  return typeof record.sourceRunId === 'string' && record.sourceRunId.trim()
    ? record.sourceRunId
    : undefined;
}

/**
 * Record only why the conversation boundary was available, never the member,
 * question, row, or free-text selection that it carried. The local runtime
 * resolves its typed follow-up before retrieval; this trace label lets an
 * office reproduction distinguish a missing binding from a later retrieval or
 * execution failure without turning traces into chat persistence.
 */
function traceConversationBinding(
  request: AgentRunRequest,
  clarification: ClarificationContinuation | undefined,
): AgentConversationBindingV1 {
  if (clarification || request.selectedEvidenceId) return 'structured_clarification';
  if (request.conversationBinding) return request.conversationBinding;
  if (request.selectedResultBinding) return 'prior_result';
  const context = request.conversationContext;
  if (!context || Object.keys(context).length === 0) return 'none';
  if ('analyticalTaskDependencyBinding' in context) return 'task_dependency';
  // A snapshot merely makes a prior binding *available*. It is not evidence
  // that this self-contained question selected it.
  return 'none';
}

/**
 * Ordinary analytical Ask cannot delegate meaning to the legacy answer
 * generator. Retrieval/meaning must first produce the immutable RAP consumed by
 * every later compiler and executor. This host-side gate protects callers that
 * inject or deserialize an older router decision as well as the canonical
 * router producer.
 */
/** An ordinary Ask turn (not Research, App Build, or another explicit mode). */
function isOrdinaryAskRequest(request: AgentRunRequest): boolean {
  return request.requestedMode === undefined
    || request.requestedMode === 'auto'
    || request.requestedMode === 'ask';
}

/**
 * A modeling/coverage gap is a pre-freeze DISCOVERY result, not permission to
 * terminate an ordinary Ask. Keep the diagnostic as a typed reason, clear the
 * blocked RAP, and let the answer executor continue through the governed
 * relational and review-required generated lanes (AGT-028, EXP-001).
 *
 * `requireGovernedEvidence` separates the two callers, and it is what keeps the
 * analytical-RAP safety boundary intact:
 *
 *   - A gap the ROUTER reported is already proof that discovery ran and found a
 *     modelling limit, so it is rescued unconditionally (the original AGT-028
 *     behaviour).
 *   - A block this module SYNTHESIZES only means "nothing froze here". That is
 *     also what an absent, LLM-authored, or forged router decision looks like,
 *     so it is rescued only when retrieval actually surfaced governed
 *     candidates. With no evidence at all it must still fail closed — a forged
 *     `converse`/`answer` must never bypass the boundary on an analytical
 *     question.
 *
 * Returns `undefined` when the decision is not a rescuable modeling gap, so
 * callers can fall through to their own handling.
 */
function rescueModelingGapForOrdinaryAsk(
  request: AgentRunRequest,
  decision: IntentDecision,
  options: { requireGovernedEvidence?: boolean } = {},
): IntentDecision | undefined {
  if (!isOrdinaryAskRequest(request)) return undefined;
  if (decision.terminalOutcome?.kind !== 'modeling_gap') return undefined;
  // A frozen plan is authoritative. Only a PRE-FREEZE coverage observation may
  // advance through the later governed-relational/exploratory tiers. This keeps
  // compiler, policy, validation, and warehouse failures terminal after a plan
  // has been accepted while restoring the required certified → semantic →
  // relational → review-required exploration cascade for missing dimensions.
  if (decision.resolvedAnalyticalPlan?.mode === 'authoritative') return undefined;
  // Genuine user-facing ambiguity and an explicit evidence pick stay terminal.
  if (decision.requiresClarification === true) return undefined;
  if (request.selectedEvidenceId) return undefined;
  // The router, not this host boundary, owns cascade eligibility. A typed
  // pre-freeze coverage gap advances only when the same snapshot recorded an
  // executable exploratory tier. This prevents a semantic-only candidate or a
  // forged/old terminal decision from quietly becoming generated SQL.
  const exploratoryAttempt = decision.analyticalCascadeDecision?.attempts.find(
    (attempt) => attempt.tier === 'exploratory_sql',
  );
  if (
    decision.analyticalCascadeDecision?.selectedTier !== 'exploratory_sql'
    || decision.analyticalCascadeDecision.planFrozen
    || exploratoryAttempt?.outcome !== 'executable'
    || exploratoryAttempt.candidateIds.length === 0
  ) return undefined;
  if (options.requireGovernedEvidence) {
    const governedEvidence = (decision.retrievalEvidence?.candidateCount ?? 0) > 0
      || (decision.meaningResolution?.selectedConceptIds.length ?? 0) > 0;
    if (!governedEvidence) return undefined;
  }
  return {
    ...decision,
    action: 'answer',
    confidence: Math.min(decision.confidence, 0.55),
    reason: `${decision.terminalOutcome.message} Continuing through DBT-grounded relational and review-required generated analysis before asking for a modeling change.`,
    terminalOutcome: undefined,
    resolvedAnalyticalPlan: undefined,
    requiresClarification: false,
    // The premise of this rescue is that NO governed plan froze, so the turn
    // must not take `selectRoute`'s certified/semantic shortcut — that path
    // stamps `certified`/`governed` trust off a bare RECOMMENDATION, which is a
    // suggestion, not a bound execution contract. Keep the meaning evidence for
    // citations and downgrade the route to governed SQL, which is review-required.
    ...(decision.meaningResolution
      ? {
          meaningResolution: {
            ...decision.meaningResolution,
            recommendedRoute: 'governed_sql' as const,
          },
        }
      : {}),
  };
}

/**
 * Consume the router's immutable cascade decision without reparsing the
 * question or reconstructing a tier from route/identifier text. The selected
 * tier is intentionally sufficient for dispatch; compilation and execution
 * still validate the frozen plan or review-required exploratory SQL.
 */
function routeFromAnalyticalCascade(decision: IntentDecision): AgentRunRoute | undefined {
  const cascade = decision.analyticalCascadeDecision;
  if (!cascade) return undefined;
  if (cascade.stopReason === 'denied' || cascade.stopReason === 'coverage_gap' || cascade.stopReason === 'post_freeze_failure') {
    return 'blocked';
  }
  if (cascade.stopReason === 'ambiguous') return 'clarify';
  switch (cascade.selectedTier) {
    case 'certified':
      return cascade.planFrozen ? 'certified_answer' : undefined;
    case 'semantic':
      return cascade.planFrozen ? 'semantic_answer' : undefined;
    case 'governed_relational':
    case 'exploratory_sql':
      return 'generated_answer';
    default:
      return undefined;
  }
}

/**
 * A frozen router decision is an immutable execution contract, not a hint that
 * a downstream answer loop may replace with another meaning/tier. The executor
 * is still free to return a terminal compilation, provider, adapter, or result
 * failure, but it must retain the selected route while doing so.
 */
function preserveFrozenAnalyticalRoute(
  route: AgentRunRoute,
  decision: IntentDecision,
  result: AgentRouteExecutorResult,
): AgentRouteExecutorResult {
  const frozen = decision.analyticalCascadeDecision?.planFrozen === true
    || decision.resolvedAnalyticalPlan?.mode === 'authoritative';
  if (!frozen || !result.resolvedRoute || result.resolvedRoute === route) return result;

  return {
    resolvedRoute: route,
    status: 'blocked',
    trustState: 'blocked',
    stopReason: 'blocked',
    summary: `The frozen ${route.replaceAll('_', ' ')} plan could not execute as selected. ZLens did not substitute another analytical tier.`,
    answer: 'The selected analytical plan could not be executed as selected. No fallback answer was returned.',
    artifacts: [],
    evaluations: [{
      id: 'frozen-plan-route-mismatch',
      label: 'Frozen analytical route',
      passed: false,
      severity: 'blocking',
      message: `The executor reported ${result.resolvedRoute.replaceAll('_', ' ')} after the router froze ${route.replaceAll('_', ' ')}.`,
      evidence: {
        selectedRoute: route,
        reportedRoute: result.resolvedRoute,
        selectedTier: decision.analyticalCascadeDecision?.selectedTier,
        planId: decision.resolvedAnalyticalPlan?.planId,
      },
    }],
  };
}

/**
 * Promote only an explicit host-issued exploratory freeze into the router
 * decision that will be persisted. This deliberately does not inspect route
 * names, SQL strings, or identifier patterns: a selected tier is immutable
 * only when its own candidate set, snapshot, target, and capability receipt
 * all agree.
 */
function applyExploratoryExecutionFreeze(
  decision: IntentDecision,
  freeze: ExploratoryExecutionFreezeV1 | undefined,
): IntentDecision {
  if (!freeze) return decision;
  const cascade = decision.analyticalCascadeDecision;
  const attempt = cascade?.attempts.find((candidate) => candidate.tier === 'exploratory_sql');
  const selectedPlan = decision.resolvedAnalyticalPlan;
  const existing = cascade?.exploratoryExecutionFreeze;
  const existingRepair = cascade?.exploratoryRepairExecutionFreeze;
  const authorizationAttempt = normalizedExploratoryAuthorizationAttempt(freeze);
  const sameCandidates = Boolean(
    attempt
    && attempt.candidateIds.length === freeze.candidateIds.length
    && attempt.candidateIds.every((candidate, index) => candidate === freeze.candidateIds[index]),
  );
  const retrievalSnapshotId = decision.retrievalEvidence?.snapshotId;
  const validBaseReceipt = Boolean(
    cascade
    && cascade.selectedTier === 'exploratory_sql'
    && cascade.planFrozen === true
    && attempt?.outcome === 'executable'
    && attempt.planFrozen === true
    && sameCandidates
    && freeze.version === 1
    && freeze.selectedTier === 'exploratory_sql'
    && freeze.authorization === 'capability_minted'
    && freeze.planId.trim()
    && freeze.planFingerprint.trim()
    && freeze.snapshotId.trim()
    && freeze.targetFingerprint.trim()
    && freeze.sqlFingerprint.trim()
    && selectedPlan?.capability === 'bounded_exploration'
    && selectedPlan.planId === freeze.planId
    && selectedPlan.fingerprint === freeze.planFingerprint
    && selectedPlan.snapshotId === freeze.snapshotId
    && freezeCarriesRequiredOutputBindings(selectedPlan, freeze)
    && (!retrievalSnapshotId || retrievalSnapshotId === freeze.snapshotId),
  );
  if (!validBaseReceipt) {
    throw exploratoryAuthorizationStateMismatch();
  }
  // A replay of one exact host handoff is harmless. A repair is a fresh,
  // separately-minted capability, but its receipt must name the initial SQL
  // authorization and keep every immutable plan binding identical.
  if (authorizationAttempt.index === 0) {
    if (existing) {
      if (sameExploratoryAuthorizationReceipt(existing, freeze)) return decision;
      throw exploratoryAuthorizationStateMismatch();
    }
    if (existingRepair) throw exploratoryAuthorizationStateMismatch();
    return withExploratoryAuthorizationReceipt(decision, freeze, 'initial');
  }
  if (authorizationAttempt.index !== 1
    || !authorizationAttempt.parentSqlFingerprint
    || !existing
    || existingRepair
    || authorizationAttempt.parentSqlFingerprint !== existing.sqlFingerprint
    || !sameExploratoryPlanBindings(existing, freeze)) {
    throw exploratoryAuthorizationStateMismatch();
  }
  return withExploratoryAuthorizationReceipt(decision, freeze, 'repair');
}

function withExploratoryAuthorizationReceipt(
  decision: IntentDecision,
  freeze: ExploratoryExecutionFreezeV1,
  kind: 'initial' | 'repair',
): IntentDecision {
  const cascade = decision.analyticalCascadeDecision!;
  return {
    ...decision,
    analyticalCascadeDecision: {
      ...cascade,
      ...(kind === 'initial'
        ? { exploratoryExecutionFreeze: freeze }
        : { exploratoryRepairExecutionFreeze: freeze }),
      attempts: cascade.attempts.map((candidate) => candidate.tier === 'exploratory_sql'
        ? {
            ...candidate,
            // The router froze the plan before SQL generation. The host only
            // binds exact SQL/target bytes to that immutable plan. A repair
            // cannot choose another tier or mutate the analytical frame.
            reason: kind === 'repair'
              ? `${candidate.reason} Host authorized one same-plan SQL repair against frozen plan ${freeze.planId}.`
              : `${candidate.reason} Host authorized SQL execution against frozen plan ${freeze.planId}.`,
          }
        : candidate),
    },
  };
}

function normalizedExploratoryAuthorizationAttempt(
  freeze: ExploratoryExecutionFreezeV1,
): { index: 0 | 1; parentSqlFingerprint?: string } {
  const attempt = freeze.authorizationAttempt;
  // V1/V3 persisted receipts predate explicit authorization-attempt evidence.
  // They are compatible only as the original handoff, never as a repair.
  if (!attempt) return { index: 0 };
  if (attempt.version !== 1 || (attempt.index !== 0 && attempt.index !== 1)) {
    throw exploratoryAuthorizationStateMismatch();
  }
  if (attempt.index === 0) {
    if ('parentSqlFingerprint' in attempt && attempt.parentSqlFingerprint) {
      throw exploratoryAuthorizationStateMismatch();
    }
    return { index: 0 };
  }
  if (!attempt.parentSqlFingerprint?.trim()) throw exploratoryAuthorizationStateMismatch();
  return { index: 1, parentSqlFingerprint: attempt.parentSqlFingerprint };
}

function sameExploratoryPlanBindings(
  left: ExploratoryExecutionFreezeV1,
  right: ExploratoryExecutionFreezeV1,
): boolean {
  return left.version === right.version
    && left.selectedTier === right.selectedTier
    && left.planId === right.planId
    && left.planFingerprint === right.planFingerprint
    && left.snapshotId === right.snapshotId
    && left.targetFingerprint === right.targetFingerprint
    && left.authorization === right.authorization
    && sameFrozenRequiredOutputBindings(left.requiredOutputBindings, right.requiredOutputBindings)
    && left.candidateIds.length === right.candidateIds.length
    && left.candidateIds.every((candidate, index) => candidate === right.candidateIds[index]);
}

function freezeCarriesRequiredOutputBindings(
  plan: IntentDecision['resolvedAnalyticalPlan'] | undefined,
  freeze: ExploratoryExecutionFreezeV1,
): boolean {
  if (!plan) return false;
  // Pre-V4 persisted plans did not carry an output contract. They remain
  // readable, but newly frozen plans with explicit outputs must carry the
  // exact physical binding proofs below.
  const required = plan.outputContract?.requiredOutputs ?? [];
  if (required.length === 0) return true;
  const expected = frozenRequiredOutputBindingProofsForPlan(plan);
  const actual = freeze.requiredOutputBindings;
  return expected.length === required.length
    && Array.isArray(actual)
    && sameFrozenRequiredOutputBindings(actual, expected);
}

function sameFrozenRequiredOutputBindings(
  left: ExploratoryExecutionFreezeV1['requiredOutputBindings'],
  right: ExploratoryExecutionFreezeV1['requiredOutputBindings'],
): boolean {
  const normalize = (bindings: ExploratoryExecutionFreezeV1['requiredOutputBindings']): string[] =>
    (bindings ?? []).map((binding) => [
      binding.version,
      binding.outputName.toLowerCase().replace(/["`\[\]]/g, ''),
      binding.qualifiedId,
      binding.relation.toLowerCase().replace(/["`\[\]]/g, '').replace(/\s*\.\s*/g, '.'),
      binding.column.toLowerCase().replace(/["`\[\]]/g, ''),
    ].join('|')).sort();
  const leftBindings = normalize(left);
  const rightBindings = normalize(right);
  return leftBindings.length === rightBindings.length
    && leftBindings.every((binding, index) => binding === rightBindings[index]);
}

function sameExploratoryAuthorizationReceipt(
  left: ExploratoryExecutionFreezeV1,
  right: ExploratoryExecutionFreezeV1,
): boolean {
  const leftAttempt = normalizedExploratoryAuthorizationAttempt(left);
  const rightAttempt = normalizedExploratoryAuthorizationAttempt(right);
  return sameExploratoryPlanBindings(left, right)
    && left.sqlFingerprint === right.sqlFingerprint
    && left.authorization === right.authorization
    && leftAttempt.index === rightAttempt.index
    && leftAttempt.parentSqlFingerprint === rightAttempt.parentSqlFingerprint;
}

function exploratoryAuthorizationStateMismatch(): Error {
  return Object.assign(
    new Error('The exploratory SQL authorization receipt did not match the already-frozen analytical plan. Execution was not attempted.'),
    { code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH' },
  );
}

/**
 * Has this exact clarification already been asked in this thread?
 *
 * The reported loop: "who are the top customers for BCM" returned "Top by which
 * governed metric?", the user answered in prose, and the IDENTICAL question came
 * back. Their reply reads as a complete new question — which is a defensible
 * classification — so it re-entered the cascade fresh, retrieved the same
 * evidence, and produced the same clarification. Nothing in the loop noticed it
 * had already been there.
 *
 * Asking twice is proof the question does not work: the user has already seen it
 * and responded, and a third identical prompt cannot produce a different reply.
 * Whatever the best available interpretation is, committing to it and saying so
 * beats asking again.
 */
function clarificationAlreadyAsked(
  clarifyingQuestion: string | undefined,
  history: AgentRunRequest['history'],
): boolean {
  const asking = clarifyingQuestion?.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!asking || !history?.length) return false;
  let sawAssistantAsk = false;
  for (const turn of history) {
    if (turn.role !== 'assistant') continue;
    if (turn.text.replace(/\s+/g, ' ').trim().toLowerCase().includes(asking)) sawAssistantAsk = true;
  }
  if (!sawAssistantAsk) return false;
  // Only a loop once the user has actually replied to it. A clarification still
  // waiting for its first answer is not a repeat.
  const lastAsk = [...history].reverse().findIndex(
    (turn) => turn.role === 'assistant' && turn.text.replace(/\s+/g, ' ').trim().toLowerCase().includes(asking),
  );
  return lastAsk > 0;
}

function enforceOrdinaryAnalyticalPlanBoundary(
  request: AgentRunRequest,
  decision: IntentDecision,
): IntentDecision {
  // V2 deliberately has no deterministic business-meaning terminal at this
  // seam.  Its candidate workspace is a bounded agent input, and pre-freeze
  // ineligible/unavailable/ambiguous outcomes are returned to that same tool
  // loop.  Do not let V1's rescue/reinterpretation policy create a second
  // authority before the tool runtime can try the next safe tier.
  // The Ask pipeline interprets the question itself, once, with the model;
  // no regex here may pre-empt it into a block or a conversational reply.
  if (request.askAgentRuntimeMode === 'pipeline_v3') {
    return decision;
  }
  // AskAnalystRuntimeV1 has already retrieved, planned, verified and (when
  // possible) frozen this ordinary Ask turn.  The engine is a dispatcher at
  // this boundary, not a second cascade owner.  In particular, do not let the
  // legacy modelling-gap rescue reinterpret a pre-freeze canonical decision:
  // that used to turn one immutable cascade into two competing routes.
  // Post-freeze executor/warehouse safety checks remain below the engine
  // boundary and are intentionally unchanged.
  if (decision.askAnalystDecision?.mode === 'authoritative'
    || request.askAnalystState?.mode === 'authoritative') {
    return decision;
  }
  const ordinaryAsk = request.requestedMode === undefined
    || request.requestedMode === 'auto'
    || request.requestedMode === 'ask';
  const terminal = decision.action === 'clarify'
    || decision.action === 'block'
    || decision.requiresClarification === true
    || Boolean(decision.terminalOutcome);
  const inboundRescue = rescueModelingGapForOrdinaryAsk(request, decision);
  if (inboundRescue) return inboundRescue;

  // A clarification the user has already seen and answered cannot be asked
  // again. Checked before the `terminal` guard for the same reason as the
  // definitional case: the gate has already set `action: 'clarify'` by here.
  if (
    ordinaryAsk
    && decision.action === 'clarify'
    && clarificationAlreadyAsked(
      decision.clarifyingQuestion,
      request.history?.length ? request.history : conversationHistoryFromContext(request.conversationContext),
    )
  ) {
    return {
      ...decision,
      action: 'answer',
      confidence: Math.min(decision.confidence, 0.6),
      reason: `This clarification was already asked and answered in this thread, so DQL proceeded with the best supported interpretation instead of repeating it: ${decision.clarifyingQuestion ?? ''}`.trim(),
      requiresClarification: false,
      clarifyingQuestion: undefined,
      terminalOutcome: undefined,
      resolvedAnalyticalPlan: undefined,
    };
  }

  // A DEFINITIONAL question about an artifact it names is not an analytical
  // request, and must be caught before the `terminal` guard below — the
  // ambiguity gate has already set `action: 'clarify'` by this point, so any
  // check placed after it is unreachable.
  //
  // Without this, "what is food_vs_drink_revenue?" is answered with "Which
  // governed meaning should DQL bind: food_vs_drink_revenue or …?" — asking the
  // user to disambiguate the one artifact they just named. The plan cannot see
  // it because it reads the artifact's OWN NAME as analytical intent: that name
  // contains "vs", so the mode comes back `comparison`.
  const namedCertifiedArtifactMetadata = looksLikeNamedCertifiedArtifactMetadataRequest(
    request.question,
    decision.retrievalEvidence?.candidateIds ?? [],
  );
  if (
    ordinaryAsk
    && !request.selectedEvidenceId
    && (
      namedCertifiedArtifactMetadata
      || looksLikeDefinitionalAboutNamedObject(
        request.question,
        decision.retrievalEvidence?.candidateIds ?? [],
      )
    )
  ) {
    return {
      ...decision,
      // Only this explicit selected-block grammar has an artifact-local,
      // deterministic metadata result. Broader definition wording remains
      // conversational so a metric phrase cannot acquire certified trust just
      // because a similarly named block was retrieved.
      action: namedCertifiedArtifactMetadata ? 'answer' : 'converse',
      category: namedCertifiedArtifactMetadata ? 'data_lookup' : 'conversational',
      confidence: 1,
      reason: namedCertifiedArtifactMetadata
        ? 'This asks what one selected certified artifact means, so its artifact metadata is returned without running a query.'
        : 'This asks what a governed artifact means, so it is answered from its definition rather than by running a query.',
      requiresClarification: false,
      clarifyingQuestion: undefined,
      clarificationOptions: undefined,
      terminalOutcome: undefined,
      resolvedAnalyticalPlan: undefined,
    };
  }
  const exactSemanticContinuation = Boolean(
    request.selectedEvidenceId
    && decision.meaningResolution?.recommendedRoute === 'semantic'
    && decision.meaningResolution.recommendedExecutionId === request.selectedEvidenceId,
  );
  if (
    !ordinaryAsk
    || terminal
    || exactSemanticContinuation
    || decision.resolvedAnalyticalPlan?.mode === 'authoritative'
  ) return decision;
  const explicitAuthoring = looksLikeComposeApp(request.question)
    || /\b(sql\s+(?:notebook\s+)?cell|notebook\s+cell|write a select|generate a query|dql block|block draft|draft block|create[^.?!]*block|turn[^.?!]*into[^.?!]*block)\b/i.test(request.question);
  if (explicitAuthoring) return decision;
  const history = request.history?.length
    ? request.history
    : conversationHistoryFromContext(request.conversationContext);
  const questionPlan = buildAnalysisQuestionPlan(request.question);
  const conversationalKind = classifyConversationalTurn(
    request.question,
    history.length > 0 || Boolean(request.conversationContext && Object.keys(request.conversationContext).length > 0),
  );
  const definitionOnly = questionPlan.mode === 'definition'
    && questionPlan.requestedShape.dimensions.length === 0
    && questionPlan.requestedShape.filters.length === 0
    && questionPlan.timeTerms.length === 0;
  // Router category/action are advisory and may be absent or forged. A
  // deterministic host parse owns the no-data lanes too, so a forged
  // `data_analysis` cannot turn "hi" into SQL and a forged `answer` cannot
  // turn a glossary definition into an analytical execution.
  if (ordinaryAsk && (conversationalKind || definitionOnly)) {
    return {
      ...decision,
      action: 'converse',
      category: 'conversational',
      ...(conversationalKind ? { conversationalKind } : {}),
      confidence: 1,
      reason: definitionOnly
        ? 'This requests a definition, not a warehouse result, so no analytical execution is needed.'
        : 'This is a conversational turn and does not request governed data.',
      requiresClarification: false,
    };
  }
  const analyticalIntents = new Set<MetadataAgentIntent>([
    'exact_certified_lookup',
    'ad_hoc_ranking',
    'driver_breakdown',
    'diagnose_change',
    'segment_compare',
    'entity_drilldown',
    'anomaly_investigation',
  ]);
  const analyticalIntent = analyticalIntents.has(questionPlan.routeIntent)
    || Boolean(request.intent && analyticalIntents.has(request.intent));
  const analyticalShape = questionPlan.mode !== 'clarify'
    && questionPlan.mode !== 'definition'
    && (
      questionPlan.requestedShape.measures.length > 0
      || questionPlan.requestedShape.dimensions.length > 0
      || questionPlan.requestedShape.filters.length > 0
      || questionPlan.timeTerms.length > 0
      || questionPlan.requestedShape.rankingDirection !== undefined
    );
  const governedEvidence = (decision.retrievalEvidence?.candidateCount ?? 0) > 0
    || (decision.meaningResolution?.selectedConceptIds.length ?? 0) > 0;
  const analytical = analyticalIntent || analyticalShape || governedEvidence;
  if (
    !analytical
  ) return decision;

  const message = 'ZLens could not freeze an exact analytical plan for the requested metric, grain, filters, ordering, and outputs. Choose a governed identifier or model the missing capability before retrying.';
  const blocked: IntentDecision = {
    ...decision,
    action: 'block',
    confidence: 1,
    reason: message,
    requiresClarification: false,
    terminalOutcome: {
      kind: 'modeling_gap',
      code: 'ANALYTICAL_MODELING_GAP',
      message,
      candidateIds: decision.retrievalEvidence?.candidateIds ?? [],
    },
  };
  // The block synthesized HERE is a modeling gap too, so it must face the same
  // rescue as one arriving from the router. Without this, the rescue above
  // silently did not apply to the most common way an ordinary Ask gets blocked:
  // retrieval found governed candidates, no exact tuple froze, and the run
  // dead-ended instead of continuing to the generated lane.
  return rescueModelingGapForOrdinaryAsk(request, blocked, { requireGovernedEvidence: true }) ?? blocked;
}

function softBoundaryResult(
  route: AgentRunRoute,
  budget: AgentRunBudget,
  priorArtifacts: readonly AgentRunArtifact[] = [],
): AgentRouteExecutorResult {
  const seconds = Math.round(budget.softTargetMs(route) / 1_000);
  // Admission control must never turn work that already validated into a
  // refusal. A run that established findings and then ran out of clock has
  // something true to say; answering `blocked` discards it and asks the user
  // to start the same investigation over. Partial and labelled beats nothing.
  const established = priorArtifacts.filter(
    (artifact) => artifact.trustState !== "blocked" && artifact.trustState !== "not_applicable",
  );
  if (established.length > 0) {
    const titles = established.map((artifact) => artifact.title).filter((title) => Boolean(title));
    const named = titles.length === 1
      ? titles[0]
      : `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
    const plural = established.length === 1;
    return {
      resolvedRoute: route,
      status: "needs_review",
      trustState: "review_required",
      stopReason: "human_review_required",
      summary: `The ${seconds}-second discovery target elapsed. Returning what was established rather than discarding it.`,
      answer: titles.length > 0
        ? `The discovery window ended before the whole question was covered, so this is partial: ${named}. ${plural ? "It was" : "They were"} validated before the clock ran out; nothing beyond ${plural ? "it" : "them"} was investigated. Continue to pick up from here.`
        : `The discovery window ended before the whole question was covered. ${established.length} validated finding${plural ? "" : "s"} from this run ${plural ? "is" : "are"} attached; nothing beyond ${plural ? "it" : "them"} was investigated.`,
      artifacts: [...established],
      evaluations: [],
      nextActions: [{ id: "continue-after-soft-target", label: "Continue the investigation" }],
    };
  }
  return {
    resolvedRoute: 'clarify',
    status: 'needs_clarification',
    trustState: 'blocked',
    stopReason: 'needs_clarification',
    summary: `The ${seconds}-second discovery target elapsed before an analytical plan was frozen. No new provider, tool, or retrieval branch was started.`,
    answer: budget.mode === 'research'
      ? `Research stopped starting new queries at ${seconds} seconds. Refine the question or retry; any already validated partial findings remain available.`
      : 'The discovery window ended before ZLens could freeze an exact analytical plan. Refine the metric or grain, or retry the same bounded question.',
    artifacts: [],
    evaluations: [],
    nextActions: [{ id: 'retry-after-soft-target', label: 'Retry the same question' }],
  };
}

function providerDispatchEvidenceFromError(error: unknown): {
  providerEgressReceipts: ProviderEgressReceiptV1[];
  providerRoundTrips: number;
  toolCalls: number;
  sqlExecutions: number;
  repairs: number;
  fallbackReason: string;
} {
  const empty = {
    providerEgressReceipts: [] as ProviderEgressReceiptV1[],
    providerRoundTrips: 0,
    toolCalls: 0,
    sqlExecutions: 0,
    repairs: 0,
    fallbackReason: 'executor_failure',
  };
  if (!error || typeof error !== 'object') return empty;
  const value = (error as { providerDispatchEvidence?: unknown }).providerDispatchEvidence;
  if (!value || typeof value !== 'object') return empty;
  const record = value as Record<string, unknown>;
  const count = (key: string): number => Number.isInteger(record[key]) && Number(record[key]) >= 0 ? Number(record[key]) : 0;
  return {
    providerEgressReceipts: Array.isArray(record.providerEgressReceipts)
      ? record.providerEgressReceipts.flatMap((receipt) => {
          const normalized = normalizeProviderEgressReceiptV1(receipt);
          return normalized ? [normalized] : [];
        })
      : [],
    providerRoundTrips: count('providerRoundTrips'),
    toolCalls: count('toolCalls'),
    sqlExecutions: count('sqlExecutions'),
    repairs: count('repairs'),
    fallbackReason: typeof record.fallbackReason === 'string' ? record.fallbackReason : 'executor_failure',
  };
}

function alreadyAbortedSignal(reason: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

function routeTimeoutError(): DOMException {
  return new DOMException('The absolute agent route deadline elapsed.', 'TimeoutError');
}

function awaitWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    // The callee may already have started before its cancellation state was
    // observed. Consume any eventual rejection while refusing its result.
    void work.catch(() => undefined);
    return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function authoringDerivationFromRequest(request: AgentRunRequest): { derivation?: AgentRunDerivationV1 } {
  if (request.requestedMode !== 'modeling' && request.requestedMode !== 'skill') return {};
  const sourceRunId = typeof request.workspaceContext?.sourceRunId === 'string'
    ? request.workspaceContext.sourceRunId
    : undefined;
  if (!sourceRunId) return {};
  const revision = Math.max(1, Number(request.workspaceContext?.revision ?? 1) || 1);
  return {
    derivation: {
      version: 1,
      kind: 'authoring_revision',
      sourceRunId,
      sourceArtifactId: typeof request.workspaceContext?.sourceArtifactId === 'string'
        ? request.workspaceContext.sourceArtifactId
        : undefined,
      attempt: revision,
      revision,
    },
  };
}

function terminalLifecycle(
  prior: AgentRunLifecycleV1,
  phase: "run.completed" | "run.cancelled" | "run.failed",
  completedAt: string,
  eventCursor: number,
): AgentRunLifecycleV1 {
  return {
    ...prior,
    state: "terminal",
    phase,
    revision: prior.revision + 1,
    eventCursor,
    updatedAt: completedAt,
    completedAt,
  };
}

function diagnosticFailureFromError(
  error: unknown,
  phase: string,
  requestedMode?: AgentRunRequestedMode,
): AgentRunDiagnosticFailureV1 {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const lower = `${name} ${message}`.toLowerCase();
  if (
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH'
  ) {
    return {
      code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH',
      phase: 'sql.authorize',
      message: 'The frozen exploratory plan did not match the SQL authorization receipt. Execution was not attempted.',
      recoverable: false,
      safeActions: ['export_redacted_trace'],
    };
  }
  if (isOrchestrationBudgetExhausted(error)) {
    return {
      code: 'orchestration_budget_exhausted',
      phase,
      message: 'Ask exhausted its bounded orchestration before a final answer was available.',
      recoverable: false,
      safeActions: ['inspect_failure'],
    };
  }
  if (name === "TimeoutError" || lower.includes("time limit") || lower.includes("timeout")) {
    if (requestedMode === 'research') {
      return {
        code: 'RESEARCH_RUN_DEADLINE',
        phase: 'research.run',
        message: 'Research reached its bounded run deadline before finalization.',
        recoverable: true,
        safeActions: ['inspect_failure'],
      };
    }
    return {
      code: "TIMEOUT",
      phase,
      message,
      recoverable: true,
      safeActions: ["retry_same_plan"],
    };
  }
  if (isAgentRunUserCancellation(error)) {
    return {
      code: "RUN_CANCELLED",
      phase,
      message: "Stopped by user.",
      recoverable: false,
      safeActions: [],
    };
  }
  return {
    code: "EXECUTOR_FAILURE",
    phase,
    message,
    recoverable: true,
    safeActions: ["retry_same_request", "inspect_failure"],
  };
}

function isOrchestrationBudgetExhausted(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:run-wide provider dispatch|orchestration) budget exhausted/i.test(message);
}

function diagnosticReceiptForRun(run: AgentRun): AgentRunDiagnosticReceiptV1 {
  const failureEvaluation = run.evaluations.find((evaluation) => !evaluation.passed && evaluation.severity === "blocking");
  const analyticalFailure = run.artifacts
    .map((artifact) => artifact.payload)
    .filter((payload): payload is Record<string, unknown> =>
      Boolean(payload) && typeof payload === "object" && !Array.isArray(payload))
    .map((payload) => payload.analyticalFailure)
    .find((failure): failure is Record<string, unknown> =>
      Boolean(failure) && typeof failure === "object" && !Array.isArray(failure));
  const failureCode = typeof analyticalFailure?.code === "string"
    ? analyticalFailure.code
    : failureEvaluation?.id === "ai-provider"
      ? "AI_PROVIDER_FAILURE"
      : failureEvaluation?.id === "query-execution"
        ? "QUERY_EXECUTION_FAILED"
        : failureEvaluation?.id === "trust-boundary"
          ? "POLICY_BLOCKED"
          : "EXECUTION_BLOCKED";
  return {
    version: 1,
    runId: run.id,
    phase: run.lifecycle?.phase ?? (run.status === "blocked" ? "run.failed" : run.status === "cancelled" ? "run.cancelled" : "run.completed"),
    route: run.route,
    ...(run.routeDecision?.resolvedAnalyticalPlan
      ? { resolvedAnalyticalPlan: run.routeDecision.resolvedAnalyticalPlan }
      : {}),
    plan: run.plan,
    steps: run.steps,
    artifacts: run.artifacts,
    evaluations: run.evaluations,
    ...(run.repairCapability ? { repairCapability: run.repairCapability } : {}),
    ...(run.providerEgressReceipts?.length ? { providerEgressReceipts: run.providerEgressReceipts } : {}),
    ...(run.status === "blocked" || run.status === "cancelled"
      ? {
          failure: {
            code: run.status === "cancelled" ? AGENT_RUN_USER_CANCEL_CODE : failureCode,
            phase: run.lifecycle?.phase ?? (run.status === "cancelled" ? "run.cancelled" : "run.failed"),
            message: run.status === "cancelled" ? "Stopped by user." : failureEvaluation?.message ?? run.summary,
            recoverable: run.status === "cancelled" ? false : Boolean(run.nextActions.length),
            safeActions: run.status === "cancelled" ? [] : run.nextActions.map((action) => action.id),
          },
        }
      : {}),
  };
}

function diagnosticReceiptV2ForRun(run: AgentRun): AgentRunDiagnosticReceiptV2 {
  const telemetry = run.telemetry ?? emptyRunTelemetry(durationBetweenMs(run.startedAt, run.completedAt), 'not_recorded');
  return {
    version: 2,
    runId: run.id,
    route: run.route,
    status: run.status,
    telemetry,
    providerEgressReceiptFingerprints: (run.providerEgressReceipts ?? []).map(receiptFingerprint),
    ...(run.repairCapability ? { repairCapabilityFingerprint: receiptFingerprint(run.repairCapability) } : {}),
  };
}

/**
 * Build a compact V3 receipt from existing durable run state. It intentionally
 * records identifiers and outcomes, never raw metadata, result rows, provider
 * payloads, or secret-bearing URLs.
 */
function diagnosticReceiptV3ForRun(run: AgentRun): AgentRunDiagnosticReceiptV3 {
  // The router is the sole cascade authority. Do not reconstruct a tier from
  // route names or identifier text here: that erased stale/error lane states
  // and falsely reported governed-relational success for pure exploration.
  const cascade = run.routeDecision?.analyticalCascadeDecision;
  // The router may retain a broader terminal witness for presentation, while
  // the cascade carries the only persistable, enumerated relationship-proof
  // receipt. Prefer that immutable cascade value and do not infer a gap from a
  // failure message or route label here.
  const terminalGap = cascade?.terminalGap;
  const sourceCoverage = cascade?.sourceCoverage ?? [];
  const planFrozen = cascade?.planFrozen ?? false;
  const artifactProviderDiagnostic = run.artifacts
    .map((artifact) => artifact.payload)
    .filter((payload): payload is Record<string, unknown> => Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload))
    .map((payload) => payload.providerFailure)
    .find((failure): failure is Record<string, unknown> => Boolean(failure) && typeof failure === 'object' && !Array.isArray(failure));
  const persistedProviderDiagnostic = artifactProviderDiagnostic?.diagnostic;
  const provider = run.routeDecision?.providerFailure
    ?? (persistedProviderDiagnostic && typeof persistedProviderDiagnostic === 'object'
    ? persistedProviderDiagnostic as AgentRunDiagnosticReceiptV3['provider']
    : (() => {
        const failure = run.diagnosticReceipt?.failure;
        return failure && (failure.code === 'AI_PROVIDER_FAILURE' || /provider/i.test(failure.code))
          ? classifyProviderFailure({ message: failure.message, code: failure.code, phase: 'generation' })
          : undefined;
      })());
  return {
    version: 3,
    runId: run.id,
    sourceCoverage,
    ...(cascade ? { cascade } : {}),
    ...(terminalGap ? { terminalGap } : {}),
    planFrozen,
    ...(provider ? { provider } : {}),
    finalStopReason: run.stopReason,
  };
}

/**
 * Build the one canonical, content-safe Ask story. This is produced from the
 * authoritative run receipt once, then joined by both the inspector and the
 * full local trace. Neither surface is allowed to reconstruct an incident from
 * spans or a generic error string.
 */
function diagnosticReceiptV4ForRun(run: AgentRun): AgentRunDiagnosticReceiptV4 {
  const cascade = run.routeDecision?.analyticalCascadeDecision;
  const requirements = cascade?.requirements;
  const candidates = run.routeDecision?.retrievalEvidence?.candidateTraceMetadata ?? [];
  const roleCounts = new Map<AskDecisionSummaryV1['evidenceByRole'][number]['role'], number>();
  for (const candidate of candidates) {
    roleCounts.set(candidate.role, (roleCounts.get(candidate.role) ?? 0) + 1);
  }
  const researchBranchObservability = researchBranchObservabilityForRun(run);
  for (const evidence of researchBranchObservability.evidenceByRole) {
    roleCounts.set(evidence.role, (roleCounts.get(evidence.role) ?? 0) + evidence.candidateCount);
  }
  const terminalIncident = terminalIncidentForRun(run, cascade?.stopReason);
  const runtimeReviewRequired = run.askAnalystState?.resolvedPlan?.reviewRequired === true
    || run.routeDecision?.askAnalystDecision?.state.resolvedPlan?.reviewRequired === true;
  // A pipeline run (V9) carries its reading in the receipt: the story is told
  // from the typed intent, the tiers it tried and the executable it ran — not
  // from the V2 cascade fields it never filled (which read as "0 measures,
  // 0 dimensions, no executable plan" for a run that answered).
  const v9 = run.diagnosticReceiptV9;
  const v9Intent = v9?.intent?.kind === 'analytics' ? v9.intent : undefined;
  if (v9 && roleCounts.size === 0) {
    // The ledger counts what the run admitted, by vocabulary kind; those are its roles.
    const kindRole: Record<string, AskDecisionSummaryV1['evidenceByRole'][number]['role']> = { metric: 'metric', measure: 'metric', entity: 'entity_key', dimension: 'categorical_dimension', relation: 'relation', column: 'context', block: 'context', term: 'context', relationship: 'relationship', skill: 'context', hint: 'context', concept: 'context' };
    for (const [kind, count] of Object.entries(v9.context?.admitted?.byKind ?? {})) {
      const role = kindRole[kind];
      if (role && count > 0) roleCounts.set(role, (roleCounts.get(role) ?? 0) + count);
    }
  }
  const v9Understood = v9Intent
    ? {
        measures: v9Intent.measures.length,
        dimensions: v9Intent.groupBy.length + v9Intent.display.length,
        entityRequested: v9Intent.groupBy.some((group) => group.role === 'key') || v9Intent.display.length > 0,
        outputCount: v9Intent.measures.length + v9Intent.groupBy.length + v9Intent.display.length,
        ...(v9Intent.ordering ? { ranking: { direction: (v9Intent.ordering.direction === 'asc' ? 'bottom' : 'top') as 'top' | 'bottom', limit: v9Intent.limit ?? 0, defaultedLimit: v9Intent.limit === undefined } } : {}),
      }
    : undefined;
  const summaryInput = {
    version: 1 as const,
    understoodRequest: {
      ...(v9Understood ?? {
        measures: requirements?.measures.length ?? 0,
        dimensions: requirements?.dimensions.length ?? 0,
        entityRequested: Boolean((requirements?.entityTerms.length ?? 0) || (requirements?.entityDisplayTerms.length ?? 0)),
        outputCount: requirements?.outputTerms?.length ?? 0,
        ...(requirements?.ranking
          ? { ranking: { ...requirements.ranking } }
          : {}),
      }),
      // This comes from the server-owned request admission, not a generic
      // `followsUp` heuristic. A complete question with thread history is
      // still `none` unless it explicitly selected a valid binding.
      conversationBinding: run.conversationBinding ?? 'none',
    },
    evidenceByRole: [...roleCounts.entries()]
      .map(([role, candidateCount]) => ({ role, candidateCount }))
      .sort((left, right) => left.role.localeCompare(right.role)),
    tierDecisions: v9
      ? v9.tiers.map((attempt) => ({
        tier: ({ certified: 'certified', semantic: 'semantic', relational: 'governed_relational', exploratory: 'exploratory_sql' } as Record<string, AnalyticalCascadeTierV1>)[attempt.tier] ?? 'governed_relational',
        outcome: (attempt.outcome === 'prepared' || attempt.outcome === 'executed' ? 'executable' : 'ineligible') as AnalyticalCascadeTierOutcomeV1,
        planFrozen: attempt.outcome === 'prepared' || attempt.outcome === 'executed',
      }))
      : (cascade?.attempts ?? []).map((attempt) => ({
        tier: attempt.tier,
        outcome: attempt.outcome,
        planFrozen: attempt.planFrozen,
      })),
    ...(v9?.executed
      ? {
          // The pipeline freezes the executable (sql + params + snapshot) before it runs: an executed tier is a frozen plan.
          selectedPlan: { tier: ({ certified: 'certified', semantic: 'semantic', relational: 'governed_relational', exploratory: 'exploratory_sql' } as Record<string, Exclude<AnalyticalCascadeTierV1, 'clarify_or_gap'>>)[v9.executed.tier] ?? 'governed_relational', planFrozen: true, reviewRequired: v9.executed.tier === 'exploratory' || runtimeReviewRequired },
        }
      : cascade?.selectedTier
        ? {
            selectedPlan: {
              tier: cascade.selectedTier,
              planFrozen: cascade.planFrozen,
              reviewRequired: cascade.selectedTier === 'exploratory_sql' || runtimeReviewRequired,
            },
          }
        : {}),
    ...(terminalIncident ? { terminalIncident } : {}),
    ...(researchBranchObservability.summary ? { researchBranchSummary: researchBranchObservability.summary } : {}),
    safeNextAction: terminalIncident?.safeAction
      ?? (researchBranchObservability.summary?.partialSuccess
        ? researchBranchObservability.summary.safeAction
        : 'none') as AskDecisionSummaryV1['safeNextAction'],
  };
  const summary: AskDecisionSummaryV1 = {
    ...summaryInput,
    summaryFingerprint: receiptFingerprint(summaryInput),
  };
  return {
    version: 4,
    runId: run.id,
    summary,
    ...(terminalIncident ? { terminalIncident } : {}),
    finalStopReason: run.stopReason,
  };
}

/**
 * Attach the V1.15 runtime state after the executor settles. The state was
 * created before the compiler broker ran; this final projection adds only
 * outcome counters and never asks a legacy layer to reinterpret the question.
 */
function attachAskAnalystRuntimeReceipt(run: AgentRun, runtimeMode?: AskRuntimeModeV2): void {
  if (runtimeMode) run.askAgentRuntimeMode = runtimeMode;
}



function analyticalExecutionAttemptCount(run: AgentRun): number {
  const executableRoutes = new Set<AgentRunRoute>([
    'certified_answer', 'semantic_answer', 'generated_answer', 'research',
  ]);
  return run.steps
    .filter((step) => executableRoutes.has(step.resolvedRoute ?? step.route))
    .reduce((total, step) => total + step.attempts, 0);
}


const RESULT_FACT_MAX_ROWS = 10;
const RESULT_FACT_MAX_COLUMNS = 12;
const RESULT_FACT_MAX_VALUE_CHARS = 1_024;
// A "top 10" answer that enumerates five rows is not the answer that was
// asked for. The projection retains ten rows; narrate all of them.
const RESULT_FACT_NARRATIVE_ROWS = 10;

interface AuthoritativeExecutedAnswerArtifactV1 {
  artifact: AgentRunArtifact;
  payload: Record<string, unknown>;
  /** Canonical fingerprint of the final, frozen execution result. */
  resultFingerprint: string;
}

interface DeterministicResultFactV1 {
  factId: string;
  kind: 'result_scope' | 'result_row' | 'result_window' | 'result_aggregate';
  resultFingerprint: string;
  rowIndex?: number;
  values?: Record<string, unknown>;
  details?: Record<string, unknown>;
  provenance: {
    artifactId: string;
    trustState: AgentRunTrustState;
    answerTier?: string;
    executionReceiptFingerprint?: string;
  };
}

interface DeterministicResultFactSetV1 {
  version: 1;
  factSetId: string;
  resultFingerprint: string;
  facts: DeterministicResultFactV1[];
}

interface DeterministicResultNarrativeV1 {
  version: 1;
  factSetId: string;
  text: string;
  claims: Array<{ claimId: string; factIds: string[]; text: string }>;
}

/**
 * Turn a successful canonical result into local, result-fingerprint-bound
 * facts when a compiler did not emit the stricter analytical graph fact set.
 * This never calls a provider and never trusts an executor's prose.  It is
 * deliberately bounded by rows, columns, and scalar size so a result cannot
 * turn an Ask receipt into an unbounded secondary data store.
 */
function attachDeterministicResultFacts(run: AgentRun): void {
  if (run.status !== 'completed' && run.status !== 'needs_review') return;
  // Do not let a prior SQL cell, a draft, or an unrelated answer artifact
  // become reader-facing fact authority. A fact projection belongs only to the
  // executed answer artifact from the final authoritative frozen plan.
  const authoritative = authoritativeExecutedAnswerArtifactsForRun(run);
  const authoritativeIds = new Set(authoritative.map(({ artifact }) => artifact.id));
  if (authoritativeIds.size === 0) return;
  run.artifacts = run.artifacts.map((artifact) => {
    if (!authoritativeIds.has(artifact.id)) return artifact;
    const payload = objectRecordForResultFacts(artifact.payload);
    if (!payload || payload.kind === 'no_answer' || hasFactLinkedNarrative(payload)) return artifact;
    const projection = deterministicResultFactProjection({
      artifactId: artifact.id,
      trustState: artifact.trustState,
      question: run.question,
      result: payload.result,
      answerTier: typeof payload.answerTier === 'string' ? payload.answerTier : undefined,
    });
    if (!projection) return artifact;
    return {
      ...artifact,
      payload: {
        ...payload,
        analyticalFacts: projection.factSet,
        analyticalNarrative: projection.narrative,
      },
    };
  });
}

/**
 * Facts and narrative may only come from the final execution artifact selected
 * by an authoritative frozen Ask plan. `run.artifacts` intentionally retains
 * earlier durable work for inspection, so scanning it wholesale would let a
 * stale SQL cell or previous answer supersede the result the engine actually
 * accepted. Multiple final answer artifacts are acceptable only when they
 * prove the same canonical result fingerprint; ambiguity fails closed.
 */
function authoritativeExecutedAnswerArtifactsForRun(run: AgentRun): AuthoritativeExecutedAnswerArtifactV1[] {
  // Notebook Ask submits ordinary analytical turns as `auto`; the runtime has
  // already classified and frozen the authoritative Ask plan by this point.
  // Treating only the legacy explicit `ask` mode as fact eligible discarded
  // verified result facts after a successful query and produced the generic
  // "no fact-linked narrative" message. Other modes remain closed here.
  const runtimeFrozenAuthoritative = run.askAnalystState?.mode === 'authoritative'
    && run.askAnalystState.resolvedPlan?.planFrozen === true;
  const decisionFrozenAuthoritative = run.routeDecision?.resolvedAnalyticalPlan?.mode === 'authoritative'
    && run.routeDecision.analyticalCascadeDecision?.planFrozen === true;
  if ((run.requestedMode !== 'ask' && run.requestedMode !== 'auto')
    || run.status === 'blocked'
    || run.status === 'cancelled'
    || (!runtimeFrozenAuthoritative && !decisionFrozenAuthoritative)) {
    return [];
  }
  const finalStep = [...run.steps].reverse().find((step) =>
    (step.resolvedRoute ?? step.route) === run.route
    && step.status !== 'blocked'
    && step.status !== 'clarify');
  const finalAnswerIds = new Set(
    finalStep?.artifacts
      .filter((artifact) => artifact.kind === 'answer' && artifact.trustState !== 'blocked')
      .map((artifact) => artifact.id),
  );
  const acceptedArtifactIds = finalAnswerIds;
  if (!acceptedArtifactIds.size) return [];
  const candidates = run.artifacts.flatMap((artifact) => {
    if (!acceptedArtifactIds.has(artifact.id) || artifact.kind !== 'answer' || artifact.trustState === 'blocked') return [];
    const payload = objectRecordForResultFacts(artifact.payload);
    const rawResult = payload && objectRecordForResultFacts(payload.result);
    const canonical = rawResult ? canonicalResultForFactProjection(rawResult) : undefined;
    if (!payload || !canonical) return [];
    return [{ artifact, payload, resultFingerprint: canonical.resultFingerprint }];
  });
  const resultFingerprints = new Set(candidates.map((candidate) => candidate.resultFingerprint));
  return resultFingerprints.size === 1 ? candidates : [];
}

/**
 * The host's own facts about an executed result, before any narrator sees it.
 *
 * Exported because an ordinary Ask decides whether to narrate BEFORE the run
 * receipt is assembled, and that decision needs the fact set to exist: without
 * it, narration was planned as "nothing to narrate" for every governed answer
 * and the setting could never take effect. Same projection, same bounds, no
 * provider — the caller simply gets to ask earlier.
 */
export function deterministicResultFactsForAnswer(input: {
  artifactId: string;
  trustState: AgentRunTrustState;
  question: string;
  result: unknown;
  answerTier?: string;
}): { factSet: DeterministicResultFactSetV1; narrative: DeterministicResultNarrativeV1 } | undefined {
  return deterministicResultFactProjection(input);
}

function deterministicResultFactProjection(input: {
  artifactId: string;
  trustState: AgentRunTrustState;
  question: string;
  result: unknown;
  answerTier?: string;
}): { factSet: DeterministicResultFactSetV1; narrative: DeterministicResultNarrativeV1 } | undefined {
  const rawResult = objectRecordForResultFacts(input.result);
  const canonical = rawResult ? canonicalResultForFactProjection(rawResult) : undefined;
  if (!rawResult || !canonical) return undefined;
  const rawReceipt = objectRecordForResultFacts(rawResult.executionReceipt);
  const receiptFingerprint = stringForResultFacts(rawReceipt?.resultFingerprint);
  if (canonical.columns.length === 0) return undefined;
  const columns = canonical.columns.slice(0, RESULT_FACT_MAX_COLUMNS);
  const rows = canonical.rows.slice(0, RESULT_FACT_MAX_ROWS).map((row) =>
    Object.fromEntries(columns.flatMap((column) => {
      const value = boundedResultFactValue(row[column]);
      return value === undefined ? [] : [[column, value] as const];
    })),
  );
  const provenance = {
    artifactId: input.artifactId,
    trustState: input.trustState,
    ...(input.answerTier ?? canonical.answerTier ? { answerTier: input.answerTier ?? canonical.answerTier } : {}),
    ...(receiptFingerprint ? { executionReceiptFingerprint: receiptFingerprint } : {}),
  };
  const scopeDetails = {
    rowCount: canonical.rowCount,
    returnedRowCount: canonical.rows.length,
    columns,
    ...(canonical.truncated ? { truncated: true } : {}),
  };
  // The applied window is host-computed at the execution boundary and rides
  // on the result payload itself — never provider prose. Without it, a
  // truthful zero-row window answer is indistinguishable from a failure.
  const rawWindow = objectRecordForResultFacts(rawResult.appliedTimeWindow);
  const appliedTimeWindow = rawWindow
    && stringForResultFacts(rawWindow.expression)
    && stringForResultFacts(rawWindow.startInclusive)
    && stringForResultFacts(rawWindow.endExclusive)
    ? {
      expression: stringForResultFacts(rawWindow.expression)!,
      startInclusive: stringForResultFacts(rawWindow.startInclusive)!,
      endExclusive: stringForResultFacts(rawWindow.endExclusive)!,
    }
    : undefined;
  // WHAT THE ROWS ADD UP TO.
  //
  // A reader asking "top customers by net ARR" wants the leader, roughly what
  // they are worth, and how concentrated the top of the list is. The projection
  // could state only that N rows came back and then recite them — every number
  // present, no number meaning anything. These aggregates are computed here,
  // deterministically, over the SAME canonical rows the row facts cite, so a
  // narrative can say something true about the shape of the answer without any
  // model inventing arithmetic.
  const aggregate = deterministicResultAggregate(columns, canonical.rows);
  const facts: DeterministicResultFactV1[] = [
    {
      factId: deterministicResultFactId(canonical.resultFingerprint, 'scope', scopeDetails),
      kind: 'result_scope',
      resultFingerprint: canonical.resultFingerprint,
      details: scopeDetails,
      provenance,
    },
    ...(appliedTimeWindow ? [{
      factId: deterministicResultFactId(canonical.resultFingerprint, 'window', appliedTimeWindow),
      kind: 'result_window' as const,
      resultFingerprint: canonical.resultFingerprint,
      details: appliedTimeWindow,
      provenance,
    }] : []),
    ...(aggregate ? [{
      factId: deterministicResultFactId(canonical.resultFingerprint, 'aggregate', aggregate),
      kind: 'result_aggregate' as const,
      resultFingerprint: canonical.resultFingerprint,
      details: aggregate as unknown as Record<string, unknown>,
      provenance,
    }] : []),
    ...rows.map((values, rowIndex) => ({
      factId: deterministicResultFactId(canonical.resultFingerprint, `row:${rowIndex}`, values),
      kind: 'result_row' as const,
      resultFingerprint: canonical.resultFingerprint,
      rowIndex,
      values,
      provenance,
    })),
  ];
  const factSetPayload = {
    version: 1 as const,
    resultFingerprint: canonical.resultFingerprint,
    facts,
  };
  const factSet: DeterministicResultFactSetV1 = {
    ...factSetPayload,
    factSetId: `result-facts:${deterministicResultHash(factSetPayload).slice(0, 24)}`,
  };
  const narrative = deterministicResultNarrative({
    question: input.question,
    factSet,
    rowCount: canonical.rowCount,
    returnedRowCount: canonical.rows.length,
    truncated: canonical.truncated === true,
    columns,
  });
  return { factSet, narrative };
}

/**
 * The measure column an answer is really about, and what its values add up to.
 *
 * Deliberately conservative: it reports only what the returned rows literally
 * contain — a total, the largest value, the leader's share of that total. It
 * computes no rates, no growth, no comparison to a period nobody asked for.
 * Everything here is checkable against the row facts beside it.
 */
interface DeterministicResultAggregateV1 {
  measureColumn: string;
  labelColumn?: string;
  total: number;
  maximum: number;
  minimum: number;
  rowsAggregated: number;
  /** The label of the row holding `maximum`, when the result has one. */
  leaderLabel?: string;
  /** Leader's share of the total, 0..1, only when the total is positive. */
  leaderShare?: number;
}

/**
 * Render a measure the way a business reader expects to see it.
 *
 * A governed answer used to print `1234567.89` and `0.0731`, which is
 * technically the value and practically unreadable — the reader has to do the
 * formatting the product should have done. The column's own name is the only
 * signal used, and no value is ever rounded away: money and counts keep two
 * and zero decimals respectively because that is what they mean, and anything
 * unrecognized is printed with thousands separators and nothing else.
 */
/**
 * Make a stored label readable without changing what it says.
 *
 * A month grouping arrived as `"2024-09-01T00:00:00.000Z"` — wrapping quotes
 * and a midnight timestamp that no reader asked about — which is the value
 * exactly, and unreadable. Only the presentation changes: the underlying fact
 * still carries the original string, so nothing that verifies against it moves.
 */
function deterministicResultDisplayText(value: string): string {
  const unquoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
  // An ISO instant at exactly midnight UTC is a date, not a moment.
  const midnight = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z?$/.exec(unquoted);
  return midnight ? midnight[1]! : unquoted;
}

function deterministicResultMeasureText(value: number, column: string): string {
  if (!Number.isFinite(value)) return String(value);
  const name = column.toLowerCase();
  if (/(?:^|_)(?:pct|percent|percentage|rate|share|ratio)(?:_|$)/.test(name)) {
    // A stored fraction and a stored percentage are both common; only the
    // clearly fractional range is scaled, so 0.42 reads as 42% and 42 as 42%.
    const percent = Math.abs(value) <= 1 ? value * 100 : value;
    return `${percent.toFixed(1)}%`;
  }
  if (/(?:^|_)(?:arr|mrr|revenue|amount|cost|spend|price|value|sales|margin|bookings|acv|tcv)(?:_|$)/.test(name)) {
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  }
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function deterministicResultAggregate(
  columns: string[],
  rows: ReadonlyArray<Record<string, unknown>>,
): DeterministicResultAggregateV1 | undefined {
  if (rows.length === 0 || columns.length === 0) return undefined;
  const numericColumn = (column: string): boolean => {
    let numeric = 0;
    let present = 0;
    for (const row of rows) {
      const value = row[column];
      if (value === null || value === undefined) continue;
      present += 1;
      if (typeof value === 'number' && Number.isFinite(value)) numeric += 1;
    }
    // An identifier column is numeric too; require that it is mostly numbers
    // AND that the column is not obviously a key.
    // A rank or position is numeric too, and summing one ("rank totals 15")
    // or naming its largest value as the leader inverts a ranking.
    return present > 0 && numeric === present
      && !/(?:^|_)(?:id|key|number|year|month|day)(?:_|$)/i.test(column)
      && nonMeasureColumnRole(column) === undefined;
  };
  // WHICH NUMBER IS THE ANSWER ABOUT?
  //
  // A result carrying both `gross_revenue` and `order_count` has two honest
  // totals, and only one of them is what the question was about. Prefer a
  // column that names a business measure; a count is a fact about the rows,
  // not usually the subject. Failing that, the last numeric column — a
  // ranking puts its measure after the label it ranks.
  const numericColumns = columns.filter(numericColumn);
  if (numericColumns.length === 0) return undefined;
  const businessMeasure = numericColumns.find((column) =>
    /(?:^|_)(?:arr|mrr|revenue|amount|spend|cost|price|value|sales|margin|bookings|acv|tcv|total)(?:_|$)/i.test(column));
  const measureColumn = businessMeasure ?? numericColumns[numericColumns.length - 1]!;
  const labelColumn = columns.find((column) => column !== measureColumn
    && rows.some((row) => typeof row[column] === 'string' && String(row[column]).trim()));
  let total = 0;
  let maximum = Number.NEGATIVE_INFINITY;
  let minimum = Number.POSITIVE_INFINITY;
  let rowsAggregated = 0;
  let leaderLabel: string | undefined;
  for (const row of rows) {
    const value = row[measureColumn];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    rowsAggregated += 1;
    total += value;
    minimum = Math.min(minimum, value);
    if (value > maximum) {
      maximum = value;
      const label = labelColumn ? row[labelColumn] : undefined;
      leaderLabel = typeof label === 'string' && label.trim() ? label : undefined;
    }
  }
  if (rowsAggregated === 0) return undefined;
  const rounded = (value: number): number => Number(value.toFixed(4));
  return {
    measureColumn,
    ...(labelColumn ? { labelColumn } : {}),
    total: rounded(total),
    maximum: rounded(maximum),
    minimum: rounded(minimum),
    rowsAggregated,
    ...(leaderLabel ? { leaderLabel } : {}),
    ...(total > 0 ? { leaderShare: Number((maximum / total).toFixed(4)) } : {}),
  };
}

function deterministicResultNarrative(input: {
  question: string;
  factSet: DeterministicResultFactSetV1;
  rowCount: number;
  returnedRowCount: number;
  truncated: boolean;
  columns: string[];
}): DeterministicResultNarrativeV1 {
  const scope = input.factSet.facts[0]!;
  const windowFact = input.factSet.facts.find((fact) => fact.kind === 'result_window');
  const windowText = windowFact
    ? `${String(windowFact.details?.expression)} (${String(windowFact.details?.startInclusive)} through ${String(windowFact.details?.endExclusive)}, end exclusive)`
    : undefined;
  const claims: DeterministicResultNarrativeV1['claims'] = [{
    claimId: 'claim:result_scope',
    factIds: [scope.factId],
    text: `The query returned ${input.rowCount.toLocaleString()} row${input.rowCount === 1 ? '' : 's'} across ${input.columns.length.toLocaleString()} column${input.columns.length === 1 ? '' : 's'}${input.truncated ? '; the returned rows are truncated.' : '.'}`,
  }];
  // LEAD WITH WHAT THE ANSWER MEANS.
  //
  // A row count is a fact about the query, not about the business. When the
  // result has a measure, say what it totals and who leads it before reciting
  // rows — that is the sentence a reader actually needed, and every number in
  // it comes from the aggregate fact it cites.
  const aggregateFact = input.factSet.facts.find((fact) => fact.kind === 'result_aggregate');
  const aggregate = aggregateFact?.details as unknown as DeterministicResultAggregateV1 | undefined;
  if (aggregateFact && aggregate) {
    const measureLabel = humanizeResultColumn(aggregate.measureColumn);
    const totalText = deterministicResultMeasureText(aggregate.total, aggregate.measureColumn);
    const parts = [aggregate.rowsAggregated === 1
      // With a single row there is nothing to total: saying so would be
      // arithmetic theatre. State the value itself.
      ? `${measureLabel} is ${totalText}.`
      : `Across the ${aggregate.rowsAggregated.toLocaleString()} returned rows, ${measureLabel} totals ${totalText}.`];
    // A leader is only meaningful against other rows.
    if (aggregate.leaderLabel && aggregate.rowsAggregated > 1) {
      const leaderText = deterministicResultMeasureText(aggregate.maximum, aggregate.measureColumn);
      const shareText = aggregate.leaderShare !== undefined
        ? ` — ${(aggregate.leaderShare * 100).toFixed(1)}% of the returned total`
        : '';
      parts.push(`${aggregate.leaderLabel} leads with ${leaderText}${shareText}.`);
    }
    claims.push({
      claimId: 'claim:result_aggregate',
      factIds: [aggregateFact.factId],
      text: parts.join(' '),
    });
  }
  if (windowFact && windowText && input.returnedRowCount > 0) {
    claims.push({
      claimId: 'claim:result_window',
      factIds: [windowFact.factId],
      text: `Rows are filtered to ${windowText}.`,
    });
  }
  const rowFacts = input.factSet.facts
    .filter((fact): fact is DeterministicResultFactV1 & { rowIndex: number; values: Record<string, unknown> } =>
      fact.kind === 'result_row' && fact.rowIndex !== undefined && Boolean(fact.values),
    )
    .slice(0, RESULT_FACT_NARRATIVE_ROWS);
  const rankedQuestion = /\b(?:top|highest|most|least|lowest)\b/i.test(input.question);
  for (const fact of rowFacts) {
    const values = fact.values;
    const labelColumn = input.columns.find((column) => /(?:customer|account|client|user|name)(?:_|$)/i.test(column) && values[column] != null)
      ?? input.columns.find((column) => values[column] != null);
    const label = labelColumn ? deterministicResultDisplayValue(values[labelColumn]) : undefined;
    const details = input.columns
      .filter((column) => column !== labelColumn && values[column] !== undefined)
      .map((column) => `${humanizeResultColumn(column)}: ${typeof values[column] === 'number'
        ? deterministicResultMeasureText(values[column] as number, column)
        : deterministicResultDisplayValue(values[column])}`);
    const text = label
      ? `${rankedQuestion ? 'Returned result' : 'Result'} ${fact.rowIndex + 1}: ${label}${details.length > 0 ? ` — ${details.join('; ')}` : ''}.`
      : `Returned result ${fact.rowIndex + 1}${details.length > 0 ? `: ${details.join('; ')}` : '.'}`;
    claims.push({
      claimId: `claim:result_row:${fact.rowIndex}`,
      factIds: [fact.factId],
      text,
    });
  }
  if (rowFacts.length === 0 && input.returnedRowCount === 0) {
    // A LIMIT truncates surplus rows; returning zero therefore proves the
    // window itself matched nothing. Naming the exact dates turns "failure"
    // into "true and actionable": the reader can see at once whether their
    // data simply ends before the requested period.
    claims.push({
      claimId: 'claim:no_returned_rows',
      factIds: windowFact ? [scope.factId, windowFact.factId] : [scope.factId],
      text: windowFact && windowText
        ? `The query returned no rows for the requested window ${windowText} — the governed source holds no matching rows in that period.`
        : 'The query completed with zero returned rows.',
    });
  }
  return {
    version: 1,
    factSetId: input.factSet.factSetId,
    text: claims.map((claim) => claim.text).join(' '),
    claims,
  };
}

function hasFactLinkedNarrative(payload: Record<string, unknown>): boolean {
  const factSet = objectRecordForResultFacts(payload.analyticalFacts);
  const narrative = objectRecordForResultFacts(payload.analyticalNarrative);
  if (!factSet || !narrative || typeof factSet.factSetId !== 'string' || narrative.factSetId !== factSet.factSetId) return false;
  // Facts may only narrate the exact canonical result that the artifact
  // persists. A graph-native fact set produced before a normalization or
  // execution-receipt change is useful diagnostics, but it is not authority
  // for the reader-facing answer.
  const rawResult = objectRecordForResultFacts(payload.result);
  const canonical = rawResult ? canonicalResultForFactProjection(rawResult) : undefined;
  if (rawResult && (!canonical || factSet.resultFingerprint !== canonical.resultFingerprint)) return false;
  const factIds = new Set(
    Array.isArray(factSet.facts)
      ? factSet.facts.flatMap((fact) => {
          const record = objectRecordForResultFacts(fact);
          return typeof record?.factId === 'string' ? [record.factId] : [];
        })
      : [],
  );
  if (factIds.size === 0 || !Array.isArray(narrative.claims)) return false;
  const claims = narrative.claims.flatMap((claim) => {
    const record = objectRecordForResultFacts(claim);
    const ids = Array.isArray(record?.factIds)
      ? record.factIds.filter((id): id is string => typeof id === 'string')
      : [];
    return ids.length > 0 ? [ids] : [];
  });
  return claims.length > 0 && claims.every((ids) => ids.every((id) => factIds.has(id)));
}

function canonicalResultForFactProjection(rawResult: Record<string, unknown>): ReturnType<typeof normalizeCanonicalQueryResult> | undefined {
  const rawReceipt = objectRecordForResultFacts(rawResult.executionReceipt);
  const suppliedFingerprint = stringForResultFacts(rawResult.resultFingerprint);
  const receiptFingerprint = stringForResultFacts(rawReceipt?.resultFingerprint);
  // The persisted result fingerprint identifies the exact rendered row set.
  // A nested receipt can identify an earlier graph/adapter boundary instead,
  // so retain it separately as provenance but never let it replace the reader
  // result identity. The host has already admitted this internal result at the
  // execution boundary; this projector never accepts public row input.
  return normalizeCanonicalQueryResult({
    columns: rawResult.columns,
    rows: rawResult.rows,
    rowCount: rawResult.rowCount,
    executionTime: rawResult.executionTime,
    resultFingerprint: suppliedFingerprint ?? receiptFingerprint,
    executionReceipt: rawResult.executionReceipt,
    trustState: rawResult.trustState,
    answerTier: rawResult.answerTier,
  });
}

function objectRecordForResultFacts(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringForResultFacts(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedResultFactValue(value: unknown): unknown | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return typeof value === 'string' && value.length > RESULT_FACT_MAX_VALUE_CHARS ? undefined : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return value.toString();
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized.length <= RESULT_FACT_MAX_VALUE_CHARS ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function deterministicResultFactId(resultFingerprint: string, kind: string, payload: unknown): string {
  return `result-fact:${deterministicResultHash({ resultFingerprint, kind, payload }).slice(0, 24)}`;
}

function deterministicResultHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function deterministicResultDisplayValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return deterministicResultDisplayText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'not-a-number';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return typeof value === 'undefined' ? 'undefined' : String(value);
}

function humanizeResultColumn(column: string): string {
  return column.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function businessAnswerForRun(run: AgentRun): BusinessAnswer {
  // An accepted compound Ask is all-or-nothing. The engine deliberately
  // continues through later frozen children after an earlier one fails so the
  // trace has a receipt for each task; it must not then replace the aggregate
  // terminal message with a generic connection incident or a later child
  // result. The blocking evaluation is server-generated at finalization, not
  // executor prose, so it is a safe deterministic answer authority here.
  const compoundFailure = run.evaluations.find((evaluation) =>
    evaluation.id === 'authoritative-compound-all-or-nothing'
    && evaluation.severity === 'blocking'
    && evaluation.passed === false
    && typeof evaluation.message === 'string'
    && evaluation.message.trim().length > 0);
  if (compoundFailure) {
    return {
      version: 1,
      mode: 'deterministic_fallback',
      trustState: 'blocked',
      factIds: [],
      answer: compoundFailure.message,
      limitations: ['No partial result was accepted because one or more frozen Ask tasks did not complete.'],
    };
  }
  const authoritative = authoritativeExecutedAnswerArtifactsForRun(run);
  const factIds = new Set<string>();
  const resultFingerprint = authoritative[0]?.resultFingerprint;
  const factSetIds = new Set<string>();
  const narratives: Array<{
    text: string;
    factSetId: string;
    claims: Array<{ factIds: string[] }>;
  }> = [];
  for (const { payload: record } of authoritative) {
    const factSet = record.analyticalFacts;
    if (factSet && typeof factSet === 'object' && !Array.isArray(factSet)) {
      const factRecord = factSet as Record<string, unknown>;
      if (factRecord.resultFingerprint !== resultFingerprint) continue;
      if (typeof factRecord.factSetId === 'string') factSetIds.add(factRecord.factSetId);
      if (Array.isArray(factRecord.facts)) {
        for (const fact of factRecord.facts) {
          if (fact && typeof fact === 'object' && typeof (fact as Record<string, unknown>).factId === 'string') {
            factIds.add((fact as Record<string, unknown>).factId as string);
          }
        }
      }
    }
    const narrative = record.analyticalNarrative;
    if (narrative && typeof narrative === 'object' && !Array.isArray(narrative)) {
      const narrativeRecord = narrative as Record<string, unknown>;
      const text = typeof narrativeRecord.text === 'string' ? narrativeRecord.text.trim() : '';
      const factSetId = typeof narrativeRecord.factSetId === 'string' ? narrativeRecord.factSetId : '';
      const claims = Array.isArray(narrativeRecord.claims)
        ? narrativeRecord.claims.flatMap((claim) => {
            if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return [];
            const claimRecord = claim as Record<string, unknown>;
            const ids = Array.isArray(claimRecord.factIds)
              ? claimRecord.factIds.filter((id): id is string => typeof id === 'string')
              : [];
            return [{ factIds: ids }];
          })
        : [];
      if (text && factSetId) narratives.push({ text, factSetId, claims });
    }
  }
  const acceptedNarrative = narratives.find((narrative) =>
    factSetIds.has(narrative.factSetId)
    && narrative.claims.length > 0
    && narrative.claims.every((claim) => claim.factIds.length > 0 && claim.factIds.every((id) => factIds.has(id))));
  const factsOnly = Boolean(acceptedNarrative);
  const deterministicAnswer = run.status === 'blocked' || run.status === 'cancelled'
    ? deterministicTerminalAnswerForRun(run)
    : run.status === 'needs_clarification'
      ? 'One business choice is required before ZLens can run this question.'
      : run.analyticalTaskOutcomeSummary?.status === 'partial'
        ? taskOutcomeAggregateSummaryText(run.analyticalTaskOutcomeSummary)
      : 'The query completed, but no fact-linked narrative was retained. Open the result to review the validated data.';
  return {
    version: 1,
    mode: factsOnly ? 'facts_only' : 'deterministic_fallback',
    trustState: run.trustState === 'grounded' ? 'governed' : run.trustState,
    factIds: [...factIds].sort(),
    ...(resultFingerprint ? { resultFingerprint } : {}),
    ...(run.analyticalTaskOutcomeSummary ? { taskOutcomeSummary: run.analyticalTaskOutcomeSummary } : {}),
    answer: acceptedNarrative?.text ?? deterministicAnswer,
    limitations: run.status === 'blocked'
      ? ['No executable result was accepted.']
      : run.status === 'needs_clarification'
        ? ['A materially different executable business meaning requires a choice.']
        : run.analyticalTaskOutcomeSummary?.status === 'partial'
          ? ['One or more independent analytical tasks did not complete; inspect the retained task receipts.']
        : factsOnly
          ? []
          : ['Narrative is deterministic because no validated analytical fact set was retained.'],
  };
}

/**
 * A blocked Ask still needs a useful, content-safe explanation.  Derive this
 * only from the typed terminal incident already persisted for the run: never
 * surface a raw connector, provider, SQL, or model error through the answer
 * field.  The trace retains the redacted diagnostic receipt for operators.
 */
/** Words that carry no business meaning when matching a question to a field. */
const UNMODELED_STOP_WORDS = new Set([
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'the', 'a', 'an',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'has', 'have', 'had',
  'for', 'from', 'with', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'by', 'per', 'each',
  'me', 'my', 'our', 'his', 'her', 'their', 'them', 'they', 'he', 'she', 'it', 'that', 'this',
  'show', 'list', 'give', 'find', 'tell', 'belongs', 'belong', 'get', 'top', 'most', 'many',
  // Generic request nouns: "what is the % DOD ACM value?" asks for a metric's
  // VALUE, it does not ask for a field named "value". Declaring these
  // unmodeled turned ordinary phrasings into false refusals on large repos.
  'value', 'values', 'info', 'information', 'detail', 'details', 'data', 'datas',
  'number', 'numbers', 'figure', 'figures', 'result', 'results', 'stats', 'statistics',
  'total', 'totals', 'current', 'latest', 'overall', 'summary', 'breakdown', 'highest', 'lowest',
]);

/** The identifier leaves the snapshot actually admitted, as plain labels. */
function modeledFieldLabels(run: AgentRun): string[] {
  const state = run.askAnalystState ?? run.routeDecision?.askAnalystDecision?.state;
  const ids = [
    ...(state?.workspace?.workspaceCandidateIds ?? []),
    ...(state?.workspace?.admittedCandidateIds ?? []),
  ];
  const labels = ids.map((id) => {
    const leaf = id.split(':').pop() ?? id;
    return (leaf.split('.').pop() ?? leaf).replace(/_/g, ' ').trim().toLowerCase();
  }).filter((label) => label.length > 2);
  return [...new Set(labels)];
}

/**
 * Say what is missing, and what exists instead.
 *
 * "ZLens could not prove one safe analytical path" is true and useless: it does
 * not say which part of the question could not be served, so the reader cannot
 * tell a modeling gap from a bug and has nothing to try next. When a term in
 * the question matches nothing the snapshot admitted — asking for "region"
 * where only locations are modeled — naming that term and the nearest governed
 * fields turns a dead end into a next step.
 */
function unmodeledTermForRun(run: AgentRun): { term: string; modeled: string[] } | undefined {
  const question = typeof run.question === 'string' ? run.question : '';
  if (!question.trim()) return undefined;
  const labels = modeledFieldLabels(run);
  if (labels.length === 0) return undefined;
  const haystack = labels.join(' ');
  const unmodeled = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !UNMODELED_STOP_WORDS.has(word))
    // A term the admitted snapshot never mentions, in any field, anywhere.
    .find((word) => !haystack.includes(word) && !haystack.includes(word.replace(/s$/, '')));
  if (!unmodeled) return undefined;
  return { term: unmodeled, modeled: labels };
}

function unmodeledRequestAnswer(run: AgentRun): string | undefined {
  const unmodeled = unmodeledTermForRun(run);
  return unmodeled ? composeAnswer({ kind: 'unmodeled_term', ...unmodeled }).text : undefined;
}


/**
 * NEVER HAND A READER AN INFRASTRUCTURE SENTENCE.
 *
 * "The AI provider could not complete this Ask step. Check provider readiness"
 * is written for whoever runs the server. The person who asked about beverage
 * revenue cannot act on it, and it says nothing about their question — while
 * the run is still holding everything retrieval proved: the relations, the
 * metrics, the certified blocks it considered.
 *
 * This is the floor under every failure. It states plainly that the question
 * was not answered, names the governed assets that came closest, and never
 * claims the data is absent — retrieval finding nothing and a transport
 * failing are different things, and only the reader can decide what to ask
 * next.
 */
/**
 * The governed assets this run retrieved, as business labels. The pipeline
 * records its reading on the run receipt; a run without one names nothing.
 */
function retrievedAssetLabels(run: AgentRun): string[] {
  const intent = run.diagnosticReceiptV9?.intent;
  const ids = intent ? [...intent.measures.map((measure) => measure.ref), ...intent.groupBy.map((group) => group.ref), ...intent.display] : [];
  const labels = ids.map((id) => {
    const leaf = id.split(':').pop() ?? id;
    return (leaf.split('.').pop() ?? leaf).replace(/_/g, ' ').trim().toLowerCase();
  }).filter((label) => label.length > 2 && !/^\d/.test(label));
  return [...new Set(labels)];
}

function lastResortAnswerForRun(run: AgentRun, cause: 'provider' | 'budget'): string {
  return composeAnswer({ kind: 'last_resort', cause, assets: retrievedAssetLabels(run) }).text;
}

function deterministicTerminalAnswerForRun(run: AgentRun): string {
  const incident = terminalIncidentForRun(
    run,
    run.routeDecision?.analyticalCascadeDecision?.stopReason,
  );
  const code = incident?.code;
  const known: TerminalIncidentCode[] = [
    'CONNECTION_NOT_CONFIGURED', 'PROVIDER_FAILURE', 'COMPILATION_FAILED', 'RESULT_CONTRACT_MISMATCH',
    'ANALYTICAL_COVERAGE_GAP', 'ANALYTICAL_EXECUTION_FAILED', 'CANCELLED', 'RUN_TIMEOUT',
  ];
  return composeAnswer({
    kind: 'incident',
    code: known.includes(code as TerminalIncidentCode) ? code as TerminalIncidentCode : undefined,
    assets: retrievedAssetLabels(run),
    ...(code === 'ANALYTICAL_COVERAGE_GAP' ? { unmodeled: unmodeledTermForRun(run) } : {}),
  }).text;
}




function providerFailureForRun(run: AgentRun): ProviderFailureDiagnosticV1 | undefined {
  if (run.routeDecision?.providerFailure) return run.routeDecision.providerFailure;
  if (run.diagnosticReceiptV3?.provider) return run.diagnosticReceiptV3.provider;
  for (const artifact of run.artifacts) {
    const payload = artifact.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const failure = (payload as Record<string, unknown>).providerFailure;
    if (!failure || typeof failure !== 'object' || Array.isArray(failure)) continue;
    const diagnostic = (failure as Record<string, unknown>).diagnostic;
    if (diagnostic && typeof diagnostic === 'object' && !Array.isArray(diagnostic)) {
      return diagnostic as ProviderFailureDiagnosticV1;
    }
  }
  return undefined;
}


type AskSummaryEvidenceRole = AskDecisionSummaryV1['evidenceByRole'][number]['role'];
type AskResearchBranchFailureCode = AskResearchBranchSummaryV1['failureReasons'][number]['code'];
type AskResearchChildTier = AskResearchBranchSummaryV1['availableChildPlans'][number]['tier'];

const ASK_SUMMARY_EVIDENCE_ROLES: readonly AskSummaryEvidenceRole[] = [
  'metric',
  'entity_key',
  'entity_label',
  'categorical_dimension',
  'time_dimension',
  'member',
  'relationship',
  'context',
];

const ASK_RESEARCH_BRANCH_FAILURE_CODES: readonly AskResearchBranchFailureCode[] = [
  'execution_failed',
  'research_branch_timeout',
  'budget_exhausted',
  'run_deadline',
  'cancelled',
];

const ASK_RESEARCH_CHILD_TIERS: readonly AskResearchChildTier[] = [
  'certified',
  'semantic',
  'governed_relational',
  'exploratory_sql',
];

/**
 * Project only persisted, typed Research child evidence into V4. The root
 * result remains authoritative: this helper never promotes a failed branch
 * into a root incident or infers a missing plan from spans.
 */
function researchBranchObservabilityForRun(run: AgentRun): {
  summary?: AskResearchBranchSummaryV1;
  evidenceByRole: Array<{ role: AskSummaryEvidenceRole; candidateCount: number }>;
} {
  // A persisted V4 receipt can be reprojected after request normalization by
  // a host. The root route is therefore the durable authority as well as the
  // original requested mode: an explicit Research run must not lose its
  // child-story merely because an older host omitted `requestedMode` while
  // preserving the authoritative `research` route and research artifact.
  if (run.requestedMode !== 'research' && run.route !== 'research') {
    return { evidenceByRole: [] };
  }

  const payload = persistedResearchArtifactPayloadForRun(run);
  if (!payload) return { evidenceByRole: [] };

  const rawReceipts = Array.isArray(payload.researchBranchReceipts)
    ? payload.researchBranchReceipts
    : [];
  const receipts = new Map<string, Record<string, unknown>>();
  for (const value of rawReceipts) {
    const receipt = clarificationRecord(value);
    const childRunId = clarificationString(receipt?.childRunId);
    const branchId = clarificationString(receipt?.branchId);
    const state = clarificationString(receipt?.state);
    const stopReason = clarificationString(receipt?.stopReason);
    // This field is producer-owned. A malformed imported receipt must not
    // become an apparently successful Research story.
    if (!receipt || !childRunId || !branchId || !state || !stopReason) continue;
    const key = `${childRunId}:${branchId}`;
    if (!receipts.has(key)) receipts.set(key, receipt);
  }
  if (receipts.size === 0) return { evidenceByRole: [] };

  const childRuns = persistedResearchChildRuns(payload);
  const evidenceByRole = persistedResearchChildEvidenceByRole(childRuns);
  const receiptBackedChildIds = persistedReceiptBackedResearchChildIds(payload);

  let completedBranches = 0;
  let failedBranches = 0;
  let timedOutBranches = 0;
  let skippedBranches = 0;
  const failureReasons = new Map<AskResearchBranchFailureCode, number>();
  const linkedChildRunIds = new Set<string>();
  for (const receipt of receipts.values()) {
    const childRunId = clarificationString(receipt.childRunId)!;
    linkedChildRunIds.add(childRunId);
    const state = clarificationString(receipt.state);
    const stopReason = clarificationString(receipt.stopReason);
    if (state === 'completed' && stopReason === 'completed') {
      completedBranches += 1;
      continue;
    }
    if (state === 'timed_out') timedOutBranches += 1;
    else if (state === 'skipped') skippedBranches += 1;
    else failedBranches += 1;
    if (isAskResearchBranchFailureCode(stopReason)) {
      failureReasons.set(stopReason, (failureReasons.get(stopReason) ?? 0) + 1);
    }
  }

  const receiptBackedBranches = [...receipts.values()]
    .filter((receipt) => clarificationString(receipt.state) === 'completed'
      && clarificationString(receipt.stopReason) === 'completed'
      && receiptBackedChildIds.has(clarificationString(receipt.childRunId)!))
    .length;
  const incompleteBranches = failedBranches + timedOutBranches + skippedBranches;
  const summary: AskResearchBranchSummaryV1 = {
    version: 1,
    totalBranches: receipts.size,
    completedBranches,
    receiptBackedBranches,
    failedBranches,
    timedOutBranches,
    skippedBranches,
    partialSuccess: receiptBackedBranches > 0 && incompleteBranches > 0,
    failureReasons: [...failureReasons.entries()]
      .map(([code, branchCount]) => ({ code, branchCount }))
      .sort((left, right) => left.code.localeCompare(right.code)),
    availableChildPlans: persistedResearchChildPlans(childRuns),
    linkedChildRunCount: linkedChildRunIds.size,
    safeAction: 'inspect_research_failures',
  };
  return { summary, evidenceByRole };
}

/** Use only the durable root research artifact with branch receipts. */
function persistedResearchArtifactPayloadForRun(run: AgentRun): Record<string, unknown> | undefined {
  let selected: Record<string, unknown> | undefined;
  let selectedCount = -1;
  for (const artifact of run.artifacts) {
    if (artifact.kind !== 'research_run') continue;
    const payload = clarificationRecord(artifact.payload);
    const count = Array.isArray(payload?.researchBranchReceipts) ? payload.researchBranchReceipts.length : 0;
    if (payload && count > selectedCount) {
      selected = payload;
      selectedCount = count;
    }
  }
  return selected;
}

function persistedResearchChildRuns(payload: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [
    ...(Array.isArray(payload.researchRuns) ? payload.researchRuns : []),
    payload.researchRun,
  ];
  const byId = new Map<string, Record<string, unknown>>();
  for (const value of candidates) {
    const child = clarificationRecord(value);
    const id = clarificationString(child?.id);
    if (child && id && !byId.has(id)) byId.set(id, child);
  }
  return [...byId.values()];
}

function persistedResearchChildEvidenceByRole(
  childRuns: readonly Record<string, unknown>[],
): Array<{ role: AskSummaryEvidenceRole; candidateCount: number }> {
  const counts = new Map<AskSummaryEvidenceRole, number>();
  for (const child of childRuns) {
    const routeDecision = clarificationRecord(child.routeDecision);
    const retrieval = clarificationRecord(routeDecision?.retrievalEvidence);
    const candidates = Array.isArray(retrieval?.candidateTraceMetadata)
      ? retrieval.candidateTraceMetadata
      : [];
    for (const value of candidates) {
      const candidate = clarificationRecord(value);
      const role = clarificationString(candidate?.role);
      if (!isAskSummaryEvidenceRole(role)) continue;
      counts.set(role, (counts.get(role) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([role, candidateCount]) => ({ role, candidateCount }))
    .sort((left, right) => left.role.localeCompare(right.role));
}

function persistedReceiptBackedResearchChildIds(payload: Record<string, unknown>): Set<string> {
  const ledger = clarificationRecord(payload.researchLedgerV2);
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const ids = new Set<string>();
  for (const value of entries) {
    const entry = clarificationRecord(value);
    const id = clarificationString(entry?.id);
    const receipts = Array.isArray(entry?.receipts) ? entry.receipts : [];
    if (entry?.status === 'observed' && id && receipts.some((receipt) => clarificationString(receipt))) {
      ids.add(id);
    }
  }
  return ids;
}

function persistedResearchChildPlans(
  childRuns: readonly Record<string, unknown>[],
): AskResearchBranchSummaryV1['availableChildPlans'] {
  const plansByTier = new Map<AskResearchChildTier, { planKeys: Set<string>; childRunIds: Set<string> }>();
  for (const child of childRuns) {
    const childRunId = clarificationString(child.id);
    const context = clarificationRecord(child.context);
    const authority = clarificationRecord(context?.branchAuthority);
    const tier = clarificationString(authority?.selectedTier);
    const planId = clarificationString(authority?.planId);
    const planFingerprint = clarificationString(authority?.planFingerprint);
    if (!childRunId || authority?.planFrozen !== true || !isAskResearchChildTier(tier) || !planId || !planFingerprint) continue;
    const entry = plansByTier.get(tier) ?? { planKeys: new Set<string>(), childRunIds: new Set<string>() };
    entry.planKeys.add(`${planId}:${planFingerprint}`);
    entry.childRunIds.add(childRunId);
    plansByTier.set(tier, entry);
  }
  return [...plansByTier.entries()]
    .map(([tier, value]) => ({
      tier,
      frozenPlanCount: value.planKeys.size,
      branchCount: value.childRunIds.size,
      reviewRequired: tier === 'exploratory_sql',
    }))
    .sort((left, right) => left.tier.localeCompare(right.tier));
}

function isAskSummaryEvidenceRole(value: string | undefined): value is AskSummaryEvidenceRole {
  return Boolean(value) && ASK_SUMMARY_EVIDENCE_ROLES.includes(value as AskSummaryEvidenceRole);
}

function isAskResearchBranchFailureCode(value: string | undefined): value is AskResearchBranchFailureCode {
  return Boolean(value) && ASK_RESEARCH_BRANCH_FAILURE_CODES.includes(value as AskResearchBranchFailureCode);
}

function isAskResearchChildTier(value: string | undefined): value is AskResearchChildTier {
  return Boolean(value) && ASK_RESEARCH_CHILD_TIERS.includes(value as AskResearchChildTier);
}

function terminalIncidentForRun(
  run: AgentRun,
  cascadeStopReason: string | undefined,
): AskTerminalIncidentV1 | undefined {
  const runtimeState = run.askAnalystState ?? run.routeDecision?.askAnalystDecision?.state;
  const planFrozen = runtimeState?.resolvedPlan?.planFrozen === true
    || run.routeDecision?.analyticalCascadeDecision?.planFrozen === true;
  const executionRecorded = analyticalExecutionAttemptCount(run) > 0
    || (run.telemetry?.sqlExecutions ?? 0) > 0;
  const executionSetupFailure = terminalConnectionSetupFailureForRun(run);
  // Connection wording is legal only after an immutable plan crossed its
  // actual connector boundary. A planner/verification failure is never a
  // "current connection" incident merely because an older adapter used a
  // broad blocked status.
  if (executionSetupFailure && planFrozen) {
    return {
      version: 1,
      code: 'CONNECTION_NOT_CONFIGURED',
      boundary: 'sql.execute',
      origin: 'governance_gate',
      impact: 'execution_not_attempted',
      safeAction: 'configure_connection',
    };
  }
  const failureCode = run.diagnosticReceipt?.failure?.code;
  if (failureCode === 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH') {
    return {
      version: 1,
      code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH',
      boundary: 'sql.authorize',
      origin: 'internal_invariant',
      impact: 'execution_not_attempted',
      safeAction: 'export_redacted_trace',
    };
  }
  if (failureCode === 'RESEARCH_RUN_DEADLINE') {
    return {
      version: 1,
      code: 'RESEARCH_RUN_DEADLINE',
      boundary: 'run',
      origin: 'governance_gate',
      impact: 'answer_not_produced',
      safeAction: 'inspect_failure',
    };
  }
  // A completed root can still be materially limited when every admitted
  // Research child exhausted its bounded window. This is producer-owned
  // receipt evidence, not an incident reconstructed from trace timing. It
  // must be visible in the same V4 summary used by the inspector and full
  // trace so the user is never told there was no incident after a zero-finding
  // investigation.
  if (terminalResearchBranchTimeoutForRun(run)) {
    return {
      version: 1,
      code: 'RESEARCH_BRANCH_TIMEOUT',
      boundary: 'run',
      origin: 'governance_gate',
      impact: 'answer_not_produced',
      safeAction: 'inspect_research_failures',
    };
  }
  if (failureCode === 'RUN_CANCELLED' || run.status === 'cancelled') {
    return { version: 1, code: 'CANCELLED', boundary: 'run', origin: 'unknown', impact: 'run_cancelled', safeAction: 'none' };
  }
  // A deadline that ended the run before any tier decided anything is a
  // timeout at the phase it reached — never "coverage gap at cascade".
  if (failureCode === 'TIMEOUT') {
    return { version: 1, code: 'RUN_TIMEOUT', boundary: 'run', origin: 'governance_gate', impact: 'answer_not_produced', safeAction: 'inspect_failure' };
  }
  if (failureCode === 'CONNECTION_NOT_CONFIGURED' && planFrozen) {
    return { version: 1, code: 'CONNECTION_NOT_CONFIGURED', boundary: 'sql.execute', origin: 'governance_gate', impact: 'execution_not_attempted', safeAction: 'configure_connection' };
  }
  // A frozen semantic/analytical plan may fail while the compiler is resolving
  // its already-proven identifiers.  That is categorically different from a
  // warehouse failure: no statement was authorized or executed.  Preserve the
  // producer's typed `COMPILATION_FAILED` cause before consulting connector
  // evidence so both Ask surfaces tell the same pre-SQL story.
  const compilationFailure = terminalCompilationFailureForRun(run);
  if (compilationFailure) {
    const semantic = isSemanticCompilationForRun(run);
    return {
      version: 1,
      code: 'COMPILATION_FAILED',
      boundary: semantic ? 'semantic.compile' : 'plan.compile',
      origin: semantic ? 'semantic_compiler' : 'plan_compiler',
      impact: 'execution_not_attempted',
      safeAction: compilationFailure.safeAction,
    };
  }
  // Result validation is a distinct post-execution boundary. The statement
  // may have run successfully, but its rows were deliberately rejected
  // against the immutable plan; do not rewrite that evidence as a connection
  // or SQL execution failure merely because both happen after plan freeze.
  const resultValidationFailure = terminalResultValidationFailureForRun(run);
  if (resultValidationFailure) {
    return {
      version: 1,
      code: 'RESULT_CONTRACT_MISMATCH',
      boundary: 'result.validate',
      origin: 'result_validator',
      impact: 'answer_not_produced',
      safeAction: resultValidationFailure.safeAction,
    };
  }
  const warehouseFailure = terminalWarehouseFailureForRun(run);
  if (warehouseFailure) {
    return {
      version: 1,
      code: 'ANALYTICAL_EXECUTION_FAILED',
      boundary: 'sql.execute',
      origin: 'warehouse',
      impact: 'execution_failed',
      // A typed missing relation after a frozen plan reached the connector is
      // not a generic retry. The target may be an empty local database or a
      // different approved warehouse, so direct the operator to that target.
      safeAction: warehouseFailure.category === 'unknown_relation'
        ? 'change_authorized_connection'
        : 'inspect_failure',
    };
  }
  if (run.diagnosticReceiptV3?.provider) {
    return { version: 1, code: 'PROVIDER_FAILURE', boundary: 'provider', origin: 'provider', impact: 'answer_not_produced', safeAction: 'inspect_failure' };
  }
  if (cascadeStopReason === 'coverage_gap' || cascadeStopReason === 'ambiguous' || cascadeStopReason === 'denied') {
    return { version: 1, code: 'ANALYTICAL_COVERAGE_GAP', boundary: 'cascade', origin: 'governance_gate', impact: 'answer_not_produced', safeAction: 'inspect_failure' };
  }
  // Planning/meaning/reference validation has no connection or SQL boundary.
  // Preserve that truth even when an older adapter gives the terminal run a
  // broad `blocked` status without a cascade stop reason.
  if (run.status === 'blocked'
    && runtimeState?.phase === 'blocked'
    && !planFrozen
    && !executionRecorded) {
    return {
      version: 1,
      code: 'ANALYTICAL_COVERAGE_GAP',
      boundary: 'cascade',
      origin: 'governance_gate',
      impact: 'answer_not_produced',
      safeAction: 'inspect_failure',
    };
  }
  if (run.status === 'blocked' && planFrozen && executionRecorded) {
    return { version: 1, code: 'ANALYTICAL_EXECUTION_FAILED', boundary: 'sql.execute', origin: 'unknown', impact: 'execution_failed', safeAction: 'inspect_failure' };
  }
  if (run.status === 'blocked') {
    return { version: 1, code: 'ANALYTICAL_COVERAGE_GAP', boundary: 'cascade', origin: 'governance_gate', impact: 'answer_not_produced', safeAction: 'inspect_failure' };
  }
  return undefined;
}

/**
 * Read only the narrow host setup receipt emitted before a connector receives
 * SQL. This must win over the broad analytical failure payload because a
 * semantic graph can catch the host error after its compiler work completed.
 */
function terminalConnectionSetupFailureForRun(run: AgentRun): boolean {
  return run.artifacts.some((artifact) => {
    const payload = artifact.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const setup = (payload as Record<string, unknown>).observabilityExecutionFailure;
    if (!setup || typeof setup !== 'object' || Array.isArray(setup)) return false;
    const record = setup as Record<string, unknown>;
    return record.version === 1
      && record.phase === 'execution'
      && record.cause === 'connection_not_configured'
      && record.safeAction === 'configure_connection';
  });
}

/**
 * Read only a producer-owned analytical failure. A compiler failure may have
 * prepared SQL text, but it is still pre-execution until the durable telemetry
 * records a SQL call. This guard keeps a real warehouse failure from being
 * relabeled as semantic/planning just because a legacy adapter reused a broad
 * failure code in a later stage.
 */
function terminalCompilationFailureForRun(
  run: AgentRun,
): { safeAction: AskTerminalIncidentV1['safeAction'] } | undefined {
  if ((run.telemetry?.sqlExecutions ?? 0) > 0) return undefined;
  for (const artifact of run.artifacts) {
    const payload = artifact.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    const failure = record.analyticalFailure;
    if (failure && typeof failure === 'object' && !Array.isArray(failure)) {
      const failureRecord = failure as Record<string, unknown>;
      if (failureRecord.code === 'COMPILATION_FAILED' && failureRecord.phase === 'compilation') {
        return {
          safeAction: terminalIncidentSafeAction(failureRecord.safeActions) ?? 'inspect_failure',
        };
      }
    }
    // Semantic adapters retain their own compiler receipt. Some historical
    // answer-loop paths lose the outer analytical-failure wrapper while
    // serializing a failed provider tool result; the typed semantic receipt is
    // still a pre-SQL compiler fact and must never fall through to the generic
    // "current connection" incident. It is only considered before a durable
    // SQL execution counter exists, so a real warehouse failure keeps its
    // execution classification.
    const semanticTrace = record.semanticExecutionTrace;
    if (!semanticTrace || typeof semanticTrace !== 'object' || Array.isArray(semanticTrace)) continue;
    const traceFailure = (semanticTrace as Record<string, unknown>).failure;
    if (!traceFailure || typeof traceFailure !== 'object' || Array.isArray(traceFailure)) continue;
    const traceFailureRecord = traceFailure as Record<string, unknown>;
    if (
      traceFailureRecord.phase === 'compilation'
      && (traceFailureRecord.code === 'SEMANTIC_COMPILATION_FAILED'
        || traceFailureRecord.code === 'COMPILATION_FAILED')
    ) {
      return {
        safeAction: terminalIncidentSafeAction(traceFailureRecord.safeActions) ?? 'inspect_failure',
      };
    }
  }
  return undefined;
}

/**
 * A validated result-contract rejection is neither a compiler failure nor a
 * warehouse failure. Read only the producer-owned typed failure so malformed
 * or legacy error text cannot manufacture this incident.
 */
function terminalResultValidationFailureForRun(
  run: AgentRun,
): { safeAction: AskTerminalIncidentV1['safeAction'] } | undefined {
  for (const artifact of run.artifacts) {
    const payload = artifact.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const failure = (payload as Record<string, unknown>).analyticalFailure;
    if (!failure || typeof failure !== 'object' || Array.isArray(failure)) continue;
    const failureRecord = failure as Record<string, unknown>;
    if (failureRecord.code !== 'RESULT_CONTRACT_MISMATCH' || failureRecord.phase !== 'result_validation') continue;
    return {
      safeAction: terminalIncidentSafeAction(failureRecord.safeActions) ?? 'inspect_failure',
    };
  }
  return undefined;
}

function isSemanticCompilationForRun(run: AgentRun): boolean {
  // Only the router-owned cascade may identify a semantic execution tier.
  // Direct/legacy semantic callers can still carry an immutable plan, but
  // without that authority their failure is accurately a generic plan compile
  // incident rather than a reconstructed semantic route.
  return run.routeDecision?.analyticalCascadeDecision?.selectedTier === 'semantic';
}

/** Keep V4's recovery action in the same compact vocabulary as trace spans. */
function terminalIncidentSafeAction(value: unknown): AskTerminalIncidentV1['safeAction'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions: readonly AskTerminalIncidentV1['safeAction'][] = [
    'export_redacted_trace',
    'configure_connection',
    'change_authorized_connection',
    'inspect_failure',
    'retry_same_plan',
    'refresh_snapshot',
    'edit_dql',
    'open_sql_notebook',
    'request_access',
    'reapply_semantic_runtime',
    'review_analytical_failure',
    'inspect_research_failures',
    'none',
  ];
  return value.find((action): action is AskTerminalIncidentV1['safeAction'] =>
    typeof action === 'string' && actions.includes(action as AskTerminalIncidentV1['safeAction']),
  );
}

/**
 * A Research root is deliberately allowed to complete its receipt-bound
 * synthesis after child deadlines. Surface a terminal incident only when no
 * child completed an observation and all admitted children were bounded out;
 * a partially successful investigation remains a review-required answer with
 * a limited-scope note rather than a false failure.
 */
function terminalResearchBranchTimeoutForRun(run: AgentRun): boolean {
  for (const artifact of run.artifacts) {
    const payload = artifact.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const receipts = (payload as Record<string, unknown>).researchBranchReceipts;
    if (!Array.isArray(receipts) || receipts.length === 0) continue;
    const stopReasons = receipts
      .map((receipt) => receipt && typeof receipt === 'object'
        ? (receipt as Record<string, unknown>).stopReason
        : undefined)
      .filter((reason): reason is string => typeof reason === 'string');
    if (stopReasons.length !== receipts.length) continue;
    const allBounded = stopReasons.every((reason) =>
      reason === 'research_branch_timeout' || reason === 'budget_exhausted',
    );
    if (allBounded && stopReasons.some((reason) => reason === 'research_branch_timeout')) return true;
  }
  return false;
}

/**
 * Read only enum evidence emitted at the real connector boundary. SQL text and
 * redacted driver diagnostics remain in the artifact inspector; they cannot
 * become routing or trace-summary authority.
 */
function terminalWarehouseFailureForRun(
  run: AgentRun,
): { category: string } | undefined {
  for (const artifact of run.artifacts) {
    const payload = artifact.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const failure = (payload as Record<string, unknown>).warehouseFailure;
    if (!failure || typeof failure !== 'object' || Array.isArray(failure)) continue;
    const record = failure as Record<string, unknown>;
    if (record.version === 1 && record.origin === 'warehouse' && typeof record.category === 'string') {
      return { category: record.category };
    }
  }
  return undefined;
}

function emptyRunTelemetry(total: number, fallbackReason: string): AgentRunTelemetryV1 {
  return {
    version: 1,
    stageDurationsMs: { total },
    providerRoundTrips: 0,
    toolCalls: 0,
    sqlExecutions: 0,
    repairs: 0,
    egressReceipts: 0,
    fallbackReason,
  };
}

function withTotalDuration(telemetry: AgentRunTelemetryV1, total: number): AgentRunTelemetryV1 {
  return {
    ...telemetry,
    stageDurationsMs: { ...telemetry.stageDurationsMs, total },
  };
}

function durationBetweenMs(startedAt: string, completedAt: string): number {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? Math.min(86_400_000, duration) : 0;
}

function receiptFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function attachDiagnosticReceipt(
  artifacts: AgentRunArtifact[],
  receipt: AgentRunDiagnosticReceiptV1,
): AgentRunArtifact[] {
  // RECEIPTS LIVE ON THE RUN ROOT, ONCE. They used to be stamped into the
  // answer artifact's payload as well — eight copies of the same objects on
  // every run — and the store then had to strip them back out. The transport
  // projection presents the root receipts on the answer artifact for readers
  // that expect them there; persistence never carries them twice. A run with
  // no artifact still gets one blocked diagnostic artifact so its failure
  // has somewhere to render.
  if (artifacts.length === 0 && receipt.failure) {
    return [{
      id: `${receipt.runId}:diagnostic`,
      kind: "answer",
      title: "Agent run diagnostics",
      trustState: "blocked",
      payload: { diagnostic: true },
    }];
  }
  return artifacts;
}




function computeStepOutcome(
  route: AgentRunRoute,
  result: AgentRouteExecutorResult,
  evaluations: AgentRunEvaluation[],
  request: AgentRunRequest,
  isClarify: boolean,
  clarifyQuestion?: string,
  terminalOutcomeMessage?: string,
): StepOutcome {
  const fallback = defaultOutcome(route);
  if (isClarify) {
    return {
      status: "needs_clarification",
      trustState: "not_applicable",
      artifacts: [],
      stopReason: "needs_clarification",
      summary: result.summary ?? clarifyQuestion ?? fallback.summary,
    };
  }
  const rawStatus = result.status ?? statusFromEvaluations(route, evaluations, fallback.status);
  const rawTrustState = result.trustState ?? trustStateFromEvaluations(route, evaluations, fallback.trustState);
  // A unique semantic grouping may be inferred only under the runtime's
  // explicit review contract.  Preserve that contract through the generic
  // engine adapter instead of allowing a successful MetricFlow executor to
  // silently re-label it as governed.
  const runtimeReviewRequired = request.askAnalystState?.resolvedPlan?.reviewRequired === true;
  const status = runtimeReviewRequired && rawStatus === 'completed'
    ? 'needs_review'
    : rawStatus;
  const trustState = runtimeReviewRequired && status !== 'blocked' && status !== 'needs_clarification'
    ? 'review_required'
    : rawTrustState;
  // API-007 / AGT-019: a blocked analytical run may carry an intentionally
  // redacted failure envelope needed for inspection and immutable repair. Keep
  // only artifacts that the executor explicitly marked blocked; never retain a
  // governed/reviewable artifact merely because it happened to accompany a
  // terminal failure.
  const rawArtifacts = status === "blocked"
    ? (result.artifacts ?? []).filter((artifact) => artifact.trustState === "blocked")
    : result.artifacts ?? defaultArtifacts(route, result, request);
  const artifacts = runtimeReviewRequired && status !== 'blocked'
    ? rawArtifacts.map((artifact) => artifact.trustState === 'blocked'
      ? artifact
      : { ...artifact, trustState: 'review_required' as const })
    : rawArtifacts;
  const stopReason = result.stopReason ?? stopReasonFor(route, status, trustState, artifacts);
  return {
    status,
    trustState,
    artifacts,
    stopReason,
    summary: status === "blocked"
      ? terminalOutcomeMessage ?? blockingOutcomeSummary(evaluations, result, fallback.summary)
      : result.summary ?? fallback.summary,
    ...(result.answerTier ? { terminalTier: result.answerTier } : {}),
  };
}

/**
 * The sentence a typed refusal code deserves. These are the honest,
 * user-actionable readings; the coarse code is still what machines branch on.
 */
const REFUSAL_CODES = new Set<AnswerRefusalCode>([
  'grounding_gap', 'modeling_gap', 'no_data', 'ambiguous', 'model_declined', 'provider_error',
  'orchestration_budget_exhausted', 'policy_blocked', 'execution_error',
]);

function refusalCodeSummary(code: string | undefined): string | undefined {
  return REFUSAL_CODES.has(code as AnswerRefusalCode)
    ? composeAnswer({ kind: 'refusal', refusalCode: code as AnswerRefusalCode }).text
    : undefined;
}

function blockingOutcomeSummary(
  evaluations: AgentRunEvaluation[],
  result: Pick<AgentRouteExecutorResult, 'answerRefusalCode' | 'answer' | 'askPipelineReceipt'>,
  fallback: string,
): string {
  const messages = evaluations
    .filter((evaluation) => !evaluation.passed && evaluation.severity === 'blocking')
    .map((evaluation) => evaluation.message.trim())
    .filter(Boolean);
  if (messages[0]) return messages[0];
  // The Ask pipeline writes its own sentence from the verbatim compiler or
  // warehouse message ("DuckDB connection failed: ..."). That sentence is the
  // truth this run recorded; the coarse refusal-code sentence is not.
  if (result.askPipelineReceipt && typeof result.answer === 'string' && result.answer.trim()) return result.answer.trim();
  // A typed refusal is the truth this run actually recorded. The old fallback
  // fabricated "did not pass its required validation" whenever no evaluation
  // was blocking and the route's default summary contained "Answered" — it
  // asserted a validation that never ran, and masked deadline/budget/gap
  // terminals behind an invented one.
  const typed = refusalCodeSummary(result.answerRefusalCode);
  if (typed) return typed;
  return fallback.includes('Answered')
    ? 'The run stopped before an answer was accepted. Open the trace for the exact boundary.'
    : fallback;
}

function consumeRepeatedClarificationSelection(
  request: AgentRunRequest,
  routeDecision: IntentDecision,
  result: AgentRouteExecutorResult,
): AgentRouteExecutorResult {
  const selectedEvidenceId = request.selectedEvidenceId;
  if (!selectedEvidenceId || result.status !== 'needs_clarification') return result;
  const options = result.clarificationOptions ?? routeDecision.clarificationOptions ?? [];
  if (!options.some((option) => option.id === selectedEvidenceId)) return result;
  const { clarificationOptions: _repeatedOptions, ...withoutRepeatedOptions } = result;
  // The same option came back a second time. That is a continuation failure,
  // not a proven modeling gap: nothing here compared what the project can do
  // with what the question needs, so the answer must not claim a missing
  // capability. It says what happened, keeps whatever the run did say, and
  // does not re-render the option the user already picked.
  const asked = (result.answer ?? result.summary ?? '').trim();
  const message = `You chose ${selectedEvidenceId}, and the run came back asking the same thing instead of using it${asked ? `: "${asked.replace(/\s+/g, ' ').slice(0, 200)}"` : ''}. That is a continuation failure in DQL, not a gap in this project's modeling. Ask the question again naming that meaning, or open the trace to see where the selection was lost.`;
  return {
    ...withoutRepeatedOptions,
    status: 'needs_review',
    trustState: 'review_required',
    stopReason: 'human_review_required',
    answerRefusalCode: 'ambiguous',
    summary: message,
    answer: message,
  };
}

/**
 * Rehydrate the server-owned compiler decision for one frozen Ask task.  The
 * outer decision remains the durable turn summary, while this scoped view is
 * the sole authority passed to the executor/evaluator for the current step.
 */
function taskScopedRouteDecision(
  outer: IntentDecision,
  task: AskAnalystTaskExecutionV1,
): IntentDecision {
  return {
    ...task.compilerDecision,
    // The task compiler consumes its canonical local semantic execution ID
    // (for example `semantic:account_revenue:revenue`), while the persisted
    // meaning receipt must retain the exact qualified candidate selected by
    // the immutable planner (`semantic:metric:account_revenue.revenue`).
    // Preserve that reader-facing identity without changing the frozen
    // compiler plan or allowing a task to reinterpret meaning.
    meaningResolution: {
      ...task.meaningResolution,
      ...(outer.meaningResolution?.recommendedExecutionId
        ? { recommendedExecutionId: outer.meaningResolution.recommendedExecutionId }
        : {}),
    },
    ...(outer.providerFailure ? { providerFailure: outer.providerFailure } : {}),
    // `compileVerifiedAskTasks` accepts a task only after the compiler broker
    // supplied its complete resolved-plan authority. Do not manufacture a
    // legacy resolved plan here from a V2 receipt.
    ...(task.compilerDecision.resolvedAnalyticalPlan
      ? { resolvedAnalyticalPlan: task.compilerDecision.resolvedAnalyticalPlan }
      : {}),
    askAnalystDecision: {
      version: 1,
      mode: outer.askAnalystDecision?.mode ?? 'authoritative',
      state: task.state,
      resolvedPlan: task.resolvedPlan,
      ...(outer.askAnalystDecision?.frozenPlan ? { frozenPlan: outer.askAnalystDecision.frozenPlan } : {}),
    },
  };
}

function isTerminalSuccess(route: AgentRunRoute, outcome: StepOutcome): boolean {
  // A completed certified answer is the terminal success — no further steps add trust.
  // A conversational reply is likewise terminal (there is no data work to chain).
  // Every other accepted step falls through so a multi-step plan can keep going; the
  // run loop ends naturally when the planned queue empties or maxSteps is hit.
  if (route === "conversation" && outcome.status === "completed") return true;
  if ((route === "certified_answer" || route === "semantic_answer") && outcome.status === "completed") return true;
  // A governed SEMANTIC answer (deterministically compiled from the semantic layer)
  // is as terminal as a certified block for a metric question — no further step adds
  // trust. Generated SQL (generated_sql / business_context) stays NON-terminal so a
  // multi-step plan can still chain a research step.
  if (outcome.status === "completed" && outcome.terminalTier === "semantic_metric") return true;
  return false;
}

function describeReplan(decision: AgentRunReplanDecision): string {
  switch (decision.decision) {
    case "repair":
      return `Repairing the current route: ${decision.repairHint}`;
    case "escalate":
      return `Escalating to ${decision.route.replaceAll("_", " ")}.`;
    case "clarify":
      return decision.question ?? "Needs a clarifying question before continuing.";
    default:
      return "Accepting the current result.";
  }
}

function repairHintForEvaluation(evaluation: AgentRunEvaluation, plannerHint?: string): string {
  return evaluation.repairAction?.hint
    ?? plannerHint
    ?? evaluation.suggestedRepair
    ?? "Revise and retry.";
}

/**
 * The default, fully deterministic planner. Produces a single-step plan from the
 * existing route selection and drives repair/escalation from failing evaluations.
 * Used when no LLM planner is injected — keeps the engine offline + testable.
 */
export function createDeterministicAgentRunPlanner(): AgentRunPlanner {
  return {
    plan({ request, routeDecision, defaultRoute }) {
      return {
        source: "deterministic",
        rationale: routeDecision.reason,
        steps: [{
          id: "step-1",
          route: defaultRoute,
          goal: request.question,
          successCriteria: defaultSuccessCriteria(defaultRoute),
        }],
      };
    },
    replan({ request, currentStep, attemptsUsed, maxRepairAttempts }) {
      const failing = currentStep.evaluations.find((evaluation) => !evaluation.passed && evaluation.suggestedRepair);
      if (!failing) return { decision: "accept" };
      const audience = resolveAudience(request);
      const action = failing.repairAction;
      const requested = action?.kind === "escalate" ? action.route : undefined;
      // Honor an explicit escalate target, else the route's default — then clamp for the audience.
      const rawEscalation = requested ?? AGENT_RUN_ESCALATION_MAP[currentStep.route];
      const escalationRoute = rawEscalation
        ? (audience === "stakeholder" && ANALYST_ONLY_ROUTES.has(rawEscalation) ? "generated_answer" : rawEscalation)
        : undefined;
      const hint = action?.hint ?? failing.suggestedRepair ?? "Revise and retry.";

      if (action?.kind === "escalate" && escalationRoute) {
        return { decision: "escalate", route: escalationRoute, goal: hint, repairHint: hint };
      }
      if (attemptsUsed < maxRepairAttempts) {
        return { decision: "repair", repairHint: hint };
      }
      if (action?.kind === "retry") {
        return { decision: "accept" };
      }
      if (escalationRoute) {
        return { decision: "escalate", route: escalationRoute, goal: hint, repairHint: hint };
      }
      return { decision: "accept" };
    },
  };
}

export function defaultSuccessCriteria(route: AgentRunRoute): string[] {
  switch (route) {
    case "conversation":
      return ["A direct, friendly reply — no data routing needed."];
    case "certified_answer":
      return ["Answer is backed by a certified saved query or governed metric."];
    case "semantic_answer":
      return ["Answer is compiled from governed semantic members and executed without generated SQL."];
    case "generated_answer":
      return ["Answer is grounded in governed context and marked review-required."];
    case "research":
      return ["Research dossier is grounded in catalog or context-pack evidence."];
    case "sql_cell":
      return ["Generated SQL executes against the preview without errors."];
    case "dql_block_draft":
      return ["Draft passes the certifier with no blockers (still human-reviewed)."];
    case "modeling_draft":
      return ["Every proposed model and relationship resolves to current repository metadata and remains review-required."];
    case "skill_draft":
      return ["The Skill proposal is scope-qualified, non-executable, and saved only through explicit review."];
    case "app_build":
      return ["App tiles are backed by certified saved queries."];
    case "clarify":
      return ["A single sharp clarifying question is returned."];
    default:
      return [];
  }
}

function buildIntentDecision(request: AgentRunRequest): IntentDecision {
  const hasConversationContext = Boolean(request.conversationContext && Object.keys(request.conversationContext).length > 0);
  const history = request.history?.length
    ? request.history
    : conversationHistoryFromContext(request.conversationContext);
  const conversationalKind = classifyConversationalTurn(
    request.question,
    Boolean(history.length > 0 || hasConversationContext),
  );
  if (request.requestedMode === "ask" && conversationalKind && hasConversationContext) {
    return {
      action: "converse",
      confidence: 0.9,
      reason: "This asks about the prior conversation, so I will answer from conversation context instead of querying governed data.",
      conversationalKind,
      category: "conversational",
      source: "heuristic",
      followsUp: true,
    };
  }
  const forcedAction = requestedModeToAction(request.requestedMode);
  if (forcedAction) {
    return {
      action: forcedAction,
      confidence: 1,
      reason: `User selected ${request.requestedMode} mode.`,
      followsUp: history.length > 0,
    };
  }
  return decideAgentAction({
    question: request.question,
    intent: request.intent ?? "ad_hoc_ranking",
    signals: request.signals,
    history,
  });
}

function requestedModeToAction(mode: AgentRunRequestedMode | undefined): IntentDecision["action"] | undefined {
  if (!mode || mode === "auto") return undefined;
  if (mode === "app") return "compose_app";
  if (mode === "research") return "investigate";
  if (mode === "ask" || mode === "sql" || mode === "block" || mode === "modeling" || mode === "skill") return "answer";
  return undefined;
}

export function selectRoute(request: AgentRunRequest, decision: IntentDecision): AgentRunRoute {
  if (decision.meaningResolutionErrorCode === 'invalid_evidence_reference') return 'blocked';
  if (decision.action === 'block') return 'blocked';
  const authoritativePlan = decision.resolvedAnalyticalPlan?.mode === 'authoritative'
    ? decision.resolvedAnalyticalPlan
    : undefined;
  // Producer invariant: the immutable plan is the authority. A caller cannot
  // combine an answer decision with blocked capability and suppress both the
  // typed clarification and modeling/policy diagnostic.
  if (authoritativePlan?.capability === 'blocked') {
    if (decision.requiresClarification === true) return 'clarify';
    return 'blocked';
  }
  const cascadeRoute = routeFromAnalyticalCascade(decision);
  if (cascadeRoute) return cascadeRoute;
  const explicitMode = request.requestedMode;
  if (explicitMode === 'modeling') return 'modeling_draft';
  if (explicitMode === 'skill') return 'skill_draft';
  if (explicitMode && explicitMode !== 'auto' && explicitMode !== 'ask') {
    return selectCascadeRunRoute(request, decision);
  }
  const plan = decision.resolvedAnalyticalPlan;
  // Research is an explicit request mode, never a phrase/category/depth
  // inference. Diagnosis and bounded exploration in ordinary Ask stay on the
  // review-required generated route over the same frozen plan.
  if (decision.action === 'investigate') {
    if (plan?.capability === 'certified_execution') return 'certified_answer';
    if (plan?.capability === 'semantic_execution') return 'semantic_answer';
    if (plan?.capability === 'governed_relational' || plan?.capability === 'bounded_exploration') return 'generated_answer';
    return decision.requiresClarification ? 'clarify' : 'blocked';
  }
  if (decision.action !== 'answer') return selectCascadeRunRoute(request, decision);
  if (plan?.mode === 'authoritative' && decision.requiresClarification !== true) {
    if (plan.capability === 'certified_execution') return 'certified_answer';
    if (plan.capability === 'semantic_execution') return 'semantic_answer';
    if (plan.capability === 'governed_relational') return 'generated_answer';
    if (plan.capability === 'bounded_exploration') return 'generated_answer';
    return 'blocked';
  }
  // Retrieval + meaning resolution already established a compatible execution
  // class. Route directly to the shared answer executor instead of paying for a
  // planner/tool-search pass. The executor still owns authorization and runtime
  // compatibility validation.
  if (decision.action === "answer" && decision.meaningResolution && decision.requiresClarification !== true) {
    if (decision.meaningResolution.recommendedRoute === "certified") return "certified_answer";
    if (decision.meaningResolution.recommendedRoute === "semantic") return "semantic_answer";
  }
  return selectCascadeRunRoute(request, decision);
}

function defaultExecutorResult(
  route: AgentRunRoute,
  request: AgentRunRequest,
  decision?: IntentDecision,
): AgentRouteExecutorResult {
  const fallback = defaultOutcome(route);
  const terminalMessage = route === 'blocked' ? decision?.terminalOutcome?.message : undefined;
  return {
    summary: terminalMessage ?? fallback.summary,
    answer: route === "clarify" ? decision?.clarifyingQuestion : undefined,
    evaluations: defaultEvaluations(route, request, decision),
    artifacts: defaultArtifacts(route, {}, request),
  };
}

function defaultOutcome(route: AgentRunRoute): Pick<AgentRun, "status" | "trustState" | "summary"> {
  switch (route) {
    case "conversation":
      return {
        status: "completed",
        trustState: "not_applicable",
        summary: "Replied conversationally.",
      };
    case "certified_answer":
      return {
        status: "completed",
        trustState: "certified",
        summary: "Answered from certified DQL context.",
      };
    case "semantic_answer":
      return {
        status: "completed",
        trustState: "governed",
        summary: "Answered from governed semantic definitions.",
      };
    case "clarify":
      return {
        status: "needs_clarification",
        trustState: "not_applicable",
        summary: "Needs clarification before a governed answer can be produced.",
      };
    case "blocked":
      return {
        status: "blocked",
        trustState: "blocked",
        summary: "Agent run is blocked.",
      };
    default:
      return {
        status: "needs_review",
        trustState: "review_required",
        summary: "Created review-required agent output.",
      };
  }
}

function defaultEvaluations(
  route: AgentRunRoute,
  _request: AgentRunRequest,
  decision?: IntentDecision,
): AgentRunEvaluation[] {
  // A conversational reply carries no governance checks — it renders as plain chat.
  if (route === "conversation") return [];
  const base: AgentRunEvaluation[] = [{
    id: "route-decision",
    label: "Route decision",
    passed: true,
    severity: "info",
    message: decision?.reason ?? `Routed request to ${route.replaceAll("_", " ")}.`,
  }];
  if (route === "certified_answer") {
    base.push({
      id: "certified-context",
      label: "Certified context",
      passed: true,
      severity: "info",
      message: "Certified status must come from the route executor or resolved answer-loop tier, not token-overlap routing.",
    });
  }
  if (route === "semantic_answer") {
    base.push({
      id: "semantic-context",
      label: "Governed semantic context",
      passed: true,
      severity: "info",
      message: "The semantic compiler, not the language model, owns the executed SQL.",
    });
  }
  if (route === "generated_answer" || route === "sql_cell") {
    base.push({
      id: "review-boundary",
      label: "Review boundary",
      passed: true,
      severity: "warning",
      message: "Generated SQL or metadata-derived analysis remains review-required.",
    });
  }
  if (route === "dql_block_draft") {
    base.push({
      id: "certification-boundary",
      label: "Certification boundary",
      passed: true,
      severity: "warning",
      message: "AI may create a draft saved query, but certification stays gated by review.",
    });
  }
  return base;
}

function statusFromEvaluations(
  route: AgentRunRoute,
  evaluations: AgentRunEvaluation[],
  fallback: AgentRunStatus,
): AgentRunStatus {
  if (evaluations.some((evaluation) => !evaluation.passed && evaluation.severity === "blocking")) return "blocked";
  if (route === "clarify") return "needs_clarification";
  if (route === "conversation") return "completed";
  if (route === "certified_answer") return "completed";
  if (route === "semantic_answer") return "completed";
  return fallback;
}

function trustStateFromEvaluations(
  route: AgentRunRoute,
  evaluations: AgentRunEvaluation[],
  fallback: AgentRunTrustState,
): AgentRunTrustState {
  if (evaluations.some((evaluation) => !evaluation.passed && evaluation.severity === "blocking")) return "blocked";
  if (route === "certified_answer") return "certified";
  if (route === "semantic_answer") return "governed";
  if (route === "clarify" || route === "conversation") return "not_applicable";
  // A generated/research answer that grounded to the catalog AND executed cleanly against
  // real data is "grounded" — honest verification pending human certification (never auto-certified).
  if (route === "research" || route === "generated_answer") {
    const grounded = evaluations.find((evaluation) => evaluation.id === "catalog-grounding")?.passed;
    const executed = evaluations.find((evaluation) => evaluation.id === "result-executed")?.passed;
    if (grounded && executed) return "grounded";
  }
  return fallback;
}

function defaultArtifacts(
  route: AgentRunRoute,
  result: Pick<AgentRouteExecutorResult, "answer">,
  request: AgentRunRequest,
): AgentRunArtifact[] {
  const trustState = defaultOutcome(route).trustState;
  switch (route) {
    case "certified_answer":
    case "semantic_answer":
    case "generated_answer":
      return [{
        id: `${route}:answer`,
        kind: "answer",
        title: route === "certified_answer"
          ? "Certified answer"
          : route === "semantic_answer"
            ? "Answer from Metrics"
            : "Generated answer",
        trustState,
        payload: { question: request.question, answer: result.answer },
      }];
    case "research":
      return [{
        id: "research:run",
        kind: "research_run",
        title: "Research run",
        trustState,
        payload: { question: request.question },
      }];
    case "sql_cell":
      return [{
        id: "notebook:sql-cell",
        kind: "sql_cell",
        title: "Generated SQL cell",
        trustState,
        payload: { question: request.question },
      }];
    case "dql_block_draft":
      return [{
        id: "dql:block-draft",
        kind: "dql_block_draft",
        title: "Saved query draft",
        trustState,
        payload: { question: request.question },
      }];
    case "app_build":
      return [{
        id: "app:draft",
        kind: "app_draft",
        title: "App draft",
        trustState,
        payload: { question: request.question },
      }];
    default:
      return [];
  }
}

function stopReasonFor(
  route: AgentRunRoute,
  status: AgentRunStatus,
  trustState: AgentRunTrustState,
  artifacts: AgentRunArtifact[],
): AgentRunStopReason {
  if (status === "cancelled") return "cancelled";
  if (status === "blocked" || trustState === "blocked") return "blocked";
  // A semantic result may be executable yet require review because the
  // runtime used one declared inferred grouping. Other reviewable authoring
  // routes keep their existing artifact-created stop semantics.
  if (route === "semantic_answer" && (status === "needs_review" || trustState === "review_required")) return "human_review_required";
  if (route === "conversation") return "conversational_reply";
  if (status === "needs_clarification") return "needs_clarification";
  if (route === "certified_answer") return "certified_answer_found";
  if (route === "semantic_answer") return "governed_semantic_answer";
  if (artifacts.length > 0 && route !== "generated_answer") return "artifact_created";
  return "generated_review_required";
}

function defaultNextActions(route: AgentRunRoute, status: AgentRunStatus): AgentRunNextAction[] {
  if (status === "blocked" || status === "cancelled") return [];
  if (route === "certified_answer") {
    return [
      { id: "research-gap", label: "Research missing breakdown", route: "research" },
      { id: "build-app", label: "Build app from certified answer", route: "app_build" },
    ];
  }
  if (route === "semantic_answer") {
    return [
      { id: "create-block", label: "Save as reviewed saved query", route: "dql_block_draft", artifactKind: "dql_block_draft" },
      { id: "research-gap", label: "Research deeper", route: "research" },
    ];
  }
  if (route === "research") {
    return [
      { id: "create-block", label: "Review DQL draft", route: "dql_block_draft", artifactKind: "dql_block_draft" },
      { id: "insert-sql", label: "Insert SQL preview", route: "sql_cell", artifactKind: "sql_cell" },
    ];
  }
  if (route === "sql_cell") {
    return [{ id: "create-block", label: "Review as DQL draft", route: "dql_block_draft", artifactKind: "dql_block_draft" }];
  }
  if (route === "dql_block_draft") {
    return [{ id: "open-review", label: "Open review checklist", artifactKind: "dql_block_draft" }];
  }
  if (route === "app_build") {
    return [{ id: "open-app", label: "Open app draft", artifactKind: "app_draft" }];
  }
  return [];
}
