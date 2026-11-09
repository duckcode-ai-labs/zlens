import type {
  AgentDqlArtifactReference,
  CascadeAnswerResult,
  AgentResultPayload,
  CertifiedBlockInvocationInput,
  AgentSchemaTable,
  AnalysisDepth,
  AnalyticalCascadeTierV1,
  AnalyticalFreshnessObservationV1,
  AnalyticalFreshnessRequestV1,
  ConversationSnapshot,
  GroundingExpansionResult,
  KGNode,
  LocalContextPack,
  ReasoningEffort,
  ResolvedAnalyticalPlan,
  SemanticQueryCompiler,
  DomainContextEnvelope,
  ProviderDispatchEvent,
  ProviderPayloadRowShape,
  AgenticSqlExecutionCapabilityV1,
  AgentConversationBindingV1,
  ExploratoryExecutionAuthorizationAttemptV1,
  ExploratoryExecutionFreezeV1,
  AnalyticalTaskDependencyBindingV1,
  NarrationIntegrityReceiptV1,
  ProviderFailureDiagnosticV1,
  ConversationResultMemberSetV1,
} from '@zlens/agent';
import type { DQLManifest, ProviderDispatchPhaseV1, ProviderEgressPurpose, ProviderEgressReceiptV1 } from '@zlens/core';

export type ProviderId = 'anthropic' | 'claude-agent-sdk' | 'claude-code' | 'codex' | 'openai' | 'gemini' | 'ollama' | 'custom-openai' | 'cortex';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentConversationContext {
  activeSurface?: 'notebook' | 'block' | 'app' | 'research' | 'chat' | string;
  conversationStateVersion?: number;
  activeTurnId?: string;
  activeTopic?: string;
  conversationSummary?: string;
  /** Canonical v1 server envelope shared by routing, planning, and execution. */
  conversationEnvelope?: ConversationSnapshot;
  /** Server-built bounded snapshot: recent turns, semantic recall, working state, and topic relation. */
  serverSnapshot?: ConversationSnapshot;
  turns?: AgentConversationTurn[];
  sourceAnswerId?: string;
  sourceCertifiedBlock?: string;
  sourceQuestion?: string;
  sourceAnswerSummary?: string;
  followupKind?: 'generic' | 'drilldown' | 'contextual';
  requestedFilters?: string[];
  requestedDimensions?: string[];
  answerContract?: unknown;
  resultColumns?: string[];
  resultRowsSample?: Record<string, unknown>[];
  resultDimensionValues?: Record<string, string[]>;
  /** Server-persisted local result-set bindings; not a client execution authority. */
  resultMemberSets?: ConversationResultMemberSetV1[];
  appliedFilters?: Record<string, unknown>;
  priorLimit?: number;
  priorMeasures?: string[];
  outputColumns?: string[];
  trustLabel?: string;
  reviewStatus?: string;
  certification?: string;
  route?: string;
  contextPackId?: string;
  draftBlockPath?: string;
  dqlArtifact?: AgentDqlArtifactReference;
  cascade?: CascadeAnswerResult;
  selectedEvidence?: unknown[];
  sourceSql?: string;
  /** Server-derived compound parent binding; HTTP ingress strips client copies. */
  analyticalTaskDependencyBinding?: AnalyticalTaskDependencyBindingV1;
  updatedAt?: string;
}

export interface AgentConversationTurn {
  id: string;
  question: string;
  answerSummary?: string;
  completedAt?: string;
  artifactKind?: string;
  sourceCertifiedBlock?: string;
  route?: string;
  trustLabel?: string;
  reviewStatus?: string;
  certification?: string;
  contextPackId?: string;
  dqlArtifact?: AgentDqlArtifactReference;
  cascade?: CascadeAnswerResult;
  narrationIntegrityReceipt?: NarrationIntegrityReceiptV1;
  requestedFilters?: string[];
  requestedDimensions?: string[];
  requestedMeasures?: string[];
  answerContract?: unknown;
  topN?: number;
  result?: {
    columns?: string[];
    rowsSample?: Record<string, unknown>[];
    dimensionValues?: Record<string, string[]>;
    memberSets?: ConversationResultMemberSetV1[];
    measureColumns?: string[];
    rowCount?: number;
  };
  sourceSql?: string;
}

export interface BlockProposal {
  name: string;
  path?: string;
  domain: string;
  owner: string;
  description: string;
  sql: string;
  blockType?: 'custom' | 'semantic';
  dqlSource?: string;
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ dimension: string; operator: string; values: string[] }>;
  timeDimension?: { name: string; granularity: string };
  tags?: string[];
  chartType?: string;
}

/**
 * Normalized event a provider streams back for each step of an agent run.
 * The UI renders these in order; the final `proposal` (if any) routes through
 * the governance gate before `/api/blocks/save-from-cell`.
 */
export type AgentTurn =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; output: unknown; isError?: boolean }
  | { kind: 'proposal'; proposal: BlockProposal; governance: { certified: boolean; errors: string[]; warnings: string[] } }
  | {
      kind: 'error';
      message: string;
      dispatchEvidence?: ProviderDispatchTerminalEvidence;
      /** Redacted classification captured at the provider boundary. */
      providerDiagnostic?: ProviderFailureDiagnosticV1;
    }
  | { kind: 'done'; stopReason?: string };

export interface ProviderDispatchTerminalEvidence {
  providerEgressReceipts: ProviderEgressReceiptV1[];
  providerRoundTrips: number;
  /**
   * When set, the host captured the complete request-scoped egress ledger.
   * Its receipt count is the sole authority for provider round trips; readiness
   * checks and other non-dispatch trace spans must never inflate that count.
   * Omitted evidence remains readable for direct executor/test compatibility.
   */
  authoritativeProviderRoundTrips?: boolean;
  toolCalls: number;
  sqlExecutions: number;
  repairs: number;
  fallbackReason: string;
}

export interface ProviderDispatchEvidenceSink {
  observe(
    event: ProviderDispatchEvent,
    context: {
      purpose: ProviderEgressPurpose;
      dispatchPhase: ProviderDispatchPhaseV1;
      optIn: boolean;
      serializedResultShape?: ProviderPayloadRowShape;
      cumulativeResultRowCount?: number;
      /** Parent physical receipt for one admitted same-provider retry. */
      retryOfAttemptIndex?: number;
      /**
       * Server-owned subtype for the bounded planner phase. `research_hypothesis`
       * is the one root investigation-plan transport; it is deliberately
       * separate from the Simple Ask planning calls made by admitted Research
       * children. A child cannot spend the root's one hypothesis-plan slot.
       */
      planningKind?: 'initial' | 'targeted_revision' | 'research_hypothesis';
    },
  ): Record<string, unknown>;
  snapshot(fallbackReason?: string): ProviderDispatchTerminalEvidence;
  /** Run-budget guard checked before every provider-visible tool branch. */
  mayStartToolCall?(): boolean;
  /**
   * Physical sends this ledger will still admit for the run. The loop that
   * plans its turns against a dispatch count reads THIS, so the number it
   * reserves its final narration send against is the one actually enforced.
   */
  remainingDispatches?(): number;
}

export interface AgentRunRequest {
  provider: ProviderId;
  /**
   * Host-only V2 Ask ingress handoff.  It is copied from the package run
   * engine after immutable retrieval and cannot be selected by browser/MCP
   * request JSON.  The provider adapter uses it only to enable the bounded
   * tool loop; SQL/trust/execution remain host-owned.
   */
  askAgentRuntimeMode?: 'authoritative_v2' | 'pipeline_v3';
  /**
   * Server-owned continuation guard. A persisted plural prior-result member
   * binding is a filter on a newly frozen program, not permission for the
   * legacy cross-result arithmetic shortcut. HTTP ingress never accepts it.
   */
  skipCrossResultComputation?: boolean;
  /**
   * Server-owned boundary flag for a router-frozen deterministic certified
   * execution. `false` means this invocation cannot consult or dispatch an AI
   * provider, so the provider wrapper must not perform a readiness check or
   * record a provider preflight span. HTTP ingress never accepts this field.
   */
  providerPreflightRequired?: boolean;
  /**
   * Server-owned SQL compiled from an already frozen, one-relation Ask
   * program. It is only admitted after the authoritative runtime proved every
   * selected field against the same snapshot. The runner still sends it through
   * the normal closure validation and one-shot execution capability; it merely
   * avoids asking a provider to regenerate an identical physical projection.
   * HTTP/MCP input must never hydrate this field.
   */
  deterministicExploratoryProposal?: {
    sql: string;
    summary?: string;
    suggestedViz?: string;
  };
  /** Server-owned run-scoped accounting shared by routing, planning and answer generation. */
  providerDispatchEvidenceSink?: ProviderDispatchEvidenceSink;
  messages: ChatTurn[];
  upstream?: { cellId?: string; sql?: string; preview?: unknown };
  conversationContext?: AgentConversationContext;
  /**
   * Server-owned decision that admits prior analytical state for this turn.
   * It is persisted as a receipt and never inferred from unstructured history
   * by downstream execution code.
   */
  conversationBinding?: AgentConversationBindingV1;
  /**
   * Reasoning effort for this run (low/medium/high). Resolved upstream from the
   * engine's per-route effort clamped by the provider's Settings ceiling; the
   * SDK runners translate it into their native param and no-op when unsupported.
   */
  reasoningEffort?: ReasoningEffort;
  /** Context/prompt depth for governed Ask AI. Research routes pass deep. */
  analysisDepth?: AnalysisDepth;
  /**
   * Server-resolved workflow mode. This is deliberately distinct from
   * `analysisDepth`: choosing more thinking must not silently grant Research
   * tools, Research dispatch budget, or result-row consent semantics.
   */
  orchestrationMode?: 'ask' | 'research';
  /** Explicit per-run Research consent; absent/false for every ordinary Ask and repair. */
  researchResultRowsOptIn?: boolean;
  /** Explicit Research-only permission for bounded semantic-member selection. */
  allowProviderSemanticMemberSelection?: boolean;
  projectRoot: string;
  /**
   * The agent run this turn belongs to. Used to key the execution
   * authorization, so proofs cannot cross turns.
   */
  agentRunId?: string;
  /** Server-resolved domain and purpose scope; clients never supply imports. */
  domainContext?: DomainContextEnvelope;
  /** Immutable server-owned manifest used for the entire governed answer. */
  projectSnapshot?: { snapshotId: string; manifest: DQLManifest };
  /** Final guard invoked before execution and answer publication. */
  assertProjectSnapshot?: (snapshotId: string) => void;
  executeCertifiedBlock?: (block: KGNode, invocation?: CertifiedBlockInvocationInput) => Promise<AgentResultPayload>;
  executeGeneratedSql?: (sql: string, artifact?: AgentDqlArtifactReference) => Promise<AgentResultPayload>;
  /**
   * Server-only exact-existence probe over the project's allowlisted
   * physical columns (`agent.runtimeValueGrounding`). Clients never supply
   * this; the host-first binder uses it to ground a member literal without
   * a provider dispatch.
   */
  probeAllowlistedLiteral?: (literal: string) => Promise<{
    status: 'matched' | 'no_match' | 'ambiguous' | 'disabled' | 'unavailable';
    matches: Array<{ relation: string; column: string; canonicalValue: string }>;
  }>;
  /** Server-only whole-catalog term lookup for truthful modeling-gap refusals. */
  catalogTermMentioned?: (term: string) => Promise<boolean>;
  /**
   * Server-only freeze for a router-selected exploratory proposal. The client
   * never supplies this callback or the returned opaque capability.
   */
  prepareExploratorySqlExecution?: (
    sql: string,
    artifact?: AgentDqlArtifactReference,
    /** Exactly one same-plan repair may request a fresh host capability. */
    authorizationAttempt?: Extract<ExploratoryExecutionAuthorizationAttemptV1, { index: 1 }>,
  ) => Promise<{
    capability: AgenticSqlExecutionCapabilityV1;
    freeze: ExploratoryExecutionFreezeV1;
  }>;
  /** Server-only generated execution capability; never accepted from a client payload. */
  executeAgenticGeneratedSql?: (
    capability: AgenticSqlExecutionCapabilityV1,
    sql: string,
    artifact?: AgentDqlArtifactReference,
  ) => Promise<AgentResultPayload>;
  executeDqlArtifact?: (artifact: AgentDqlArtifactReference) => Promise<AgentResultPayload>;
  getSchemaContext?: (question: string, contextPack?: LocalContextPack) => Promise<AgentSchemaTable[]>;
  /**
   * Bounded, equality-predicated lookup of specific relations the model
   * referenced but retrieval never inspected. Used only after the cached
   * catalog misses, so a real table is not refused without ever asking the
   * warehouse whether it exists.
   */
  probeNamedRelations?: (relations: string[]) => Promise<GroundingExpansionResult | undefined>;
  /** Active warehouse dialect so Lane-2 semantic compiles emit dialect-correct SQL. */
  semanticDriver?: string;
  /** Logical->physical table mapping for the semantic compiler, when resolved. */
  semanticTableMapping?: Record<string, string>;
  /** Shared host compiler for native, local MetricFlow, or dbt Cloud semantic execution. */
  semanticQueryCompiler?: SemanticQueryCompiler;
  /**
   * Qualified IDs selected by the bounded meaning resolver. They are advisory
   * for relevance but identifier-bound; the answer loop still runs its own
   * deterministic contract/compiler/policy checks before execution.
   */
  preferredEvidenceIds?: string[];
  preferredExecutionId?: string;
  /** Router-owned immutable v2 plan. Provider adapters must pass it through unchanged. */
  resolvedAnalyticalPlan?: ResolvedAnalyticalPlan;
  /**
   * Router-owned pre-freeze cascade choice. The provider adapter forwards this
   * unchanged to the answer loop so an eligible exploratory plan cannot reopen
   * certified or semantic selection after meaning has been resolved.
   */
  selectedCascadeTier?: Exclude<AnalyticalCascadeTierV1, 'clarify_or_gap'>;
  /**
   * Immutable physical evidence selected by the router for a pre-freeze
   * exploratory tier. This is an execution authority, not a relevance hint:
   * provider prompts and SQL validation may use only this candidate closure.
   */
  exploratoryCandidateIds?: string[];
  /**
   * Candidate-ID-scoped physical prompt/execution pack for `exploratory_sql`.
   * The broad prepared pack remains host diagnostics and is never provider
   * authority once the router has selected this tier.
   */
  preparedExploratoryContextPack?: LocalContextPack;
  /** Server-observed identity for a generated proposal's execution target. */
  generatedProposalTargetFingerprint?: string;
  /** Server-captured instant used to bind relative periods deterministically. */
  analyticalReferenceInstant?: string;
  /** Route-locked, snapshot-bound freshness lookup prepared by the execution host. */
  resolveAnalyticalFreshness?: (request: AnalyticalFreshnessRequestV1) => Promise<AnalyticalFreshnessObservationV1>;
  /**
   * Request-scoped ranked evidence prepared before routing. Hosts pass this to
   * prevent the provider adapter from rebuilding and re-searching the same
   * metadata snapshot after the meaning/route decision has already been made.
   */
  preparedContextPack?: LocalContextPack;
}

/** Additive server-only result returned by a runner after its final turn. */
export interface AgentRunnerTerminalResult {
}

export interface AgentRunner {
  run(
    req: AgentRunRequest,
    emit: (turn: AgentTurn) => void,
    signal: AbortSignal,
  ): Promise<AgentRunnerTerminalResult | void>;
}

/**
 * Public-facing name for the adapter contract a provider must implement.
 * `AgentRunner` is the internal call site; `LLMProvider` is what community
 * authors target when they add a new `providers/<name>.ts`. Keep in sync.
 */
export type LLMProvider = AgentRunner;
