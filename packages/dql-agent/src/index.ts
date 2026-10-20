/**
 * Public surface for `@zlens/agent`.
 *
 * Consumers (CLI, MCP server, notebook UI) typically import:
 *   - `reindexProject(root)` to rebuild the KG
 *   - `KGStore` for direct queries
 *   - `answer({ ... })` for the block-first answer loop
 *   - the providers (Claude/OpenAI/Gemini/Ollama)
 */

import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import type { DQLManifest } from "@zlens/core";
import {
  buildManifest,
  loadProjectConfig,
  resolveDbtManifestPath,
  resolveSemanticLayerWithDiagnostics,
} from "@zlens/core";
import { KGStore } from "./kg/sqlite-fts.js";
import { buildKGFromManifest, buildKGFromSemanticLayer, declaredDomainIds } from "./kg/build.js";
import { loadSkills, skillsDir } from "./skills/loader.js";
import type { Skill } from "./skills/loader.js";
import type { KGEdge, KGNode } from "./kg/types.js";
import { defaultMetadataPath, ensureMetadataCatalogFresh, openMetadataCatalog } from "./metadata/catalog.js";
import { reindexHints, listHintsFromGit } from "./hints/git-store.js";
import { findStaleApprovedHints, type StaleHintFinding } from "./hints/staleness.js";

export { KGStore } from "./kg/sqlite-fts.js";
export type {
  KGNode,
  KGEdge,
  KGNodeKind,
  KGSearchHit,
  KGFeedbackRow,
  KGSearchOptions,
} from "./kg/types.js";
export { buildKGFromManifest, buildKGFromSemanticLayer } from "./kg/build.js";
export {
  activeSkills,
  buildSkillBlockHints,
  loadSkills,
  parseSkill,
  renderSkill,
  buildSkillsPrompt,
  selectRelevantSkills,
  buildSkillMetricHints,
  expandQuestionWithSkillVocabulary,
  writeSkill,
  previewSkillChange,
  applySkillChange,
  hashSkillSource,
  upsertSkill,
  deleteSkill,
  migrateLegacySkills,
  configuredSkillsPath,
  skillsDir,
  legacySkillsDir,
  skillPath,
} from "./skills/loader.js";
export type {
  Skill,
  SkillLoadResult,
  WriteSkillInput,
  SkillChangePreview,
  SkillSourcePatch,
  SelectRelevantSkillsOptions,
} from "./skills/loader.js";
export { seedDefaultSkills } from "./skills/defaults.js";
export {
  ANALYTICAL_ORCHESTRATION_CONTRACT_VERSION,
  assertCanonicalResult,
  buildAnalyticalTaskGraph,
  buildAnalyticalCascadeDecision,
  buildAnalyticalRequirementSeedV1,
  buildAnalyticalRequirementSet,
  currentQuestionLiteralMemberTerms,
  withAnalyticalPriorResultMemberBinding,
  buildAnalyticalTurnPlan,
  buildCoverageGap,
  buildResearchEvidenceLedger,
  buildResearchEvidenceLedgerV2,
  buildResearchEvidenceLedgerV3,
  buildResearchHypothesisPlanV2,
  canonicalResultBindingValue,
  canonicalResultRowFingerprint,
  classifyProviderFailure,
  evidenceCandidateRoles,
  canonicalResultRows,
  capResearchBranches,
  fuseContextCandidates,
  inferAnalyticalTurnKind,
  inferResearchValidatorKind,
  normalizeCanonicalQueryResult,
  normalizeAnalyticalExecutionFingerprint,
  normalizeAnalyticalExecutionReceipt,
  retrieveContextLanes,
  resolveTopRankedRegionDependency,
  researchVerdictFromValidatedObservation,
  selectRoleBalancedMeaningCandidates,
  selectRoleBalancedWorkspaceCandidates,
  splitAnalyticalTasks,
  summarizeTaskOutcomes,
  validateSelectedResultBinding,
} from './analytical-orchestration.js';
export { evaluateAnalyticalRequestPolicy, type AnalyticalRequestPolicyOptions } from './analytical-request-policy.js';
export type { AnalyticalRequestPolicyDecision } from './analytical-request-policy.js';
/** V2 retrieval-first, LLM-controlled bounded Ask runtime. */
export type {
  AskRuntimeModeV2,
  AskTurnClassV2,
  AskToolNameV2,
  AskExecutionTierV2,
  AskEvidenceHandleV1,
  AskSemanticEngineV1,
  AskSemanticRuntimeSelectionV1,
  AskToolObservationV1,
  AskToolObservationOutcomeV1,
  AskCascadeTierAttemptV2,
  AskAgentTerminalOutcomeV2,
  AskAgentTerminalOutcomeKindV2,
  AskContextCoverageV2,
  AgentRunDiagnosticReceiptV8,
  ResearchEvidenceLedgerV4,
} from './ask-runtime/legacy-receipts.js';
export { projectResearchEvidenceLedgerV4, RESEARCH_LEDGER_BRANCH_CAP } from './ask-runtime/legacy-receipts.js';
/** Local-only, additive Ask/Research execution tracing (OBS-001..OBS-010). */
export * from './ask-observability/index.js';
export type {
  AnalyticalAnswerSectionV1,
  AnalyticalCascadeDecisionV1,
  AnalyticalCascadeTerminalGapV1,
  AnalyticalCascadeTierOutcomeV1,
  AnalyticalCascadeTierV1,
  AnalyticalCoverageGapV1,
  AnalyticalRequirementSetV1,
  AnalyticalTimeWindowV1,
  RequirementClauseMetaV1,
  RequirementClauseProvenance,
  AnalyticalPriorResultMemberBindingV1,
  AnalyticalRequirementSeedV1,
  AgentSelectedResultBindingV1,
  AgentSelectedResultBindingValidation,
  AnalyticalTaskKind,
  AnalyticalTaskDependencyBindingV1,
  AnalyticalTaskDependencyResolution,
  AnalyticalTaskDependencyV1,
  AnalyticalTaskOutputContractV1,
  AnalyticalTaskStatus,
  AnalyticalTaskV1,
  AnalyticalTaskFailureV1,
  AnalyticalTaskOutcomeV1,
  AnalyticalTaskOutcomeStatusV1,
  AnalyticalTaskOutcomeSummaryV1,
  AnalyticalTaskOutcomeTrustStateV1,
  AnalyticalTurnAnswerV1,
  AnalyticalTurnKind,
  AnalyticalTurnPlanV1,
  CanonicalQueryResultV1,
  CascadeTierAttemptV1,
  ContextSourceCoverageV1,
  ContextSourceCoverageStatusV1,
  ContextCandidateCardV1,
  ContextFusionDiagnosticsV1,
  ContextFusionResultV1,
  EvidenceCandidateRoleV1,
  AskDecisionSummaryV1,
  AskDecisionSummaryV2,
  AskAnalystRuntimeModeV1,
  AskPlanningModeV1,
  BusinessQuestionFrameV3,
  BusinessQuestionFrameV4,
  AnalyticalHypothesisV1,
  AnalyticalHypothesisKindV1,
  AnalyticalMissionV1,
  EvidenceWorkspaceToolReceiptV1,
  EvidenceWorkspaceV1,
  EvidenceWorkspaceV2,
  AnalyticalProgramV1,
  AnalyticalProgramV2,
  AnalyticalProgramV3,
  AnalyticalPlannerBusinessRoleV2,
  AnalyticalPlannerTaskV2,
  AnalyticalPlannerInterpretationV2,
  CanonicalRelationshipPathReceiptV1,
  AnalyticalInputAtomV1,
  TrustedAnalyticalTaskAnchorV1,
  AnalyticalProgram,
  ResolvedAnalyticalPlanV2,
  AskAnalystConversationDeltaV1,
  AskAnalystConversationDeltaV2,
  AskAnalystStateV1,
  AskAnalystStateV2,
  AskAnalystStateV3,
  AskAnalystState,
  BusinessAnswerV1,
  BusinessAnswerV2,
  BusinessAnswer,
  AnalyticalPlannerCandidateCardV1,
  AnalyticalPlannerRequestV1,
  AnalyticalPlannerOperationV1,
  AnalyticalPlannerTaskProposalV1,
  AnalyticalPlannerProposalV1,
  TargetedContextRequestV1,
  TargetedContextResultV1,
  ProgramVerificationFeedbackV1,
  AskAnalystPlanningReceiptV1,
  AskTerminalIncidentV1,
  ExploratoryExecutionFreezeV1,
  ExploratoryRequiredOutputBindingProofV1,
  ExploratoryExecutionAuthorizationAttemptV1,
  ExploratoryExecutionAuthorizationReceiptV1,
  AgentRunDiagnosticReceiptV3,
  AgentRunDiagnosticReceiptV4,
  AgentRunDiagnosticReceiptV5,
  AgentRunDiagnosticReceiptV6,
  ProviderFailureCauseV1,
  ProviderFailureDiagnosticV1,
  ResearchEvidenceLedgerV1,
  ResearchEvidenceLedgerV2,
  ResearchEvidenceLedgerV3,
  ResearchLedgerEntryV1,
  ResearchEvidenceLedgerEntryV2,
  ResearchEvidenceLedgerEntryV3,
  ResearchEvidenceLedgerAnalyticalEntryV3,
  ResearchEvidenceLedgerLineageEntryV3,
  ResearchEvidenceLedgerAnalyticalInputV3,
  ResearchEvidenceLedgerLineageInputV3,
  ResearchEvidenceKindV3,
  ResearchLineageEvidenceReceiptV1,
  ResearchLineageEvidenceStatusV1,
  ResearchLineageResolutionV1,
  ResearchLineageNodeTypeV1,
  ResearchEvidenceValidatorKindV2,
  ResearchEvidenceValidatorV2,
  ResearchHypothesisPlanEntryV2,
  ResearchHypothesisPlanV2,
} from './analytical-orchestration.js';
export {
  APP_SOURCE_REUSABLE_TAG,
  hasGeneratedAppSourceOrigin,
  isExplicitlyReusableAppSource,
} from './app-source-policy.js';
export {
  AppSourceCatalogError,
  appSourceTrustTier,
  matchAppSourceCatalogRecords,
  queryAppSourceCatalog,
  rankAppSourcesByTrust,
  resolveAppSourceCatalogRecords,
  shortlistAppSources,
} from './app-source-catalog.js';
export {
  APP_BUILD_HANDOFF_SOURCE_LIMIT,
  appBuildHandoffSourceKind,
  appBuildHandoffSourceSummary,
  appDraftSourceFromCatalogRecord,
  appStudioDraftPath,
  createAppBuildHandoffDraft,
} from './app-build-handoff.js';
export type {
  AppBuildHandoffGap,
  AppBuildHandoffInput,
  AppBuildHandoffSourceSummary,
} from './app-build-handoff.js';
export {
  planAppBuildBrief,
  deterministicDatasetQuery,
  datasetPlannedQueryCoversRequirement,
} from './app-builder-orchestrator.js';
export {
  DATASET_PROOF_RELATIVE_PATH,
  LOCAL_DATASET_PROOF_RELATIVE_PATH,
  datasetBlockProofMaterial,
  datasetDescriptorFromSemanticMetrics,
  datasetDescriptorFromManifestBlock,
  datasetBindingAuthorityForManifestBlock,
  buildDatasetComparisonPlan,
  executeDatasetComparisonPlan,
  loadDatasetGrainProofs,
  planDriverQueries,
  foldDriverAnalysis,
  driverTotalTileId,
  driverDimensionTileId,
  isDriverExecutionTileId,
} from './datasets/index.js';
export type {
  DriverAnalysisV1,
  DriverDimensionV1,
  DriverMemberV1,
  DriverQueryPlan,
  DriverQueryPlanResult,
} from './datasets/index.js';
export type {
  DatasetBindingAuthority,
  DatasetBlockProofMaterial,
  DatasetCatalogDescriptorResult,
  DatasetComparisonPlanResult,
  SemanticDatasetMeasureProjection,
  SemanticMetricsDatasetProjectionInput,
} from './datasets/index.js';
export type {
  AppBuilderBuildBrief,
  AppBuilderComponentRole,
  AppBuilderComponentView,
  AppBuilderPlannedComponent,
  AppBuilderPlannerCompletion,
  AppBuilderPlannerCompletionInput,
  AppBuilderPlannerCompletionResult,
  AppBuilderPlannerProvenance,
  PlanAppBuildBriefInput,
} from './app-builder-orchestrator.js';
export type {
  AppSourceCatalogPage,
  AppSourceCatalogQuery,
  AppSourceCatalogRecord,
  AppSourceEligibility,
  AppSourceTrust,
} from './app-source-catalog.js';
export { seedDomainSkills, buildDomainReferenceSkills } from "./skills/domain-skills.js";
export {
  draftDomainSkillBootstrap,
  buildDomainSkillBootstrapPrompt,
  mergeDomainSkillBootstrapEnrichment,
} from "./skills/bootstrap.js";
export type {
  DomainBootstrapCandidate,
  DomainSkillBootstrapAiDraft,
  DomainSkillBootstrapEnrichment,
} from "./skills/bootstrap.js";
export {
  buildContextAuthoringProposal,
  contextAuthoringDependencyClosure,
  contextAuthoringProposalHash,
  FileContextAuthoringProposalStore,
} from './context-authoring.js';
export type {
  ContextAuthoringDiagnosticV1,
  DatasetAuthoringChange,
  DatasetDraftAuthoringChange,
  ContextAuthoringOperation,
  ContextAuthoringOrigin,
  ContextAuthoringPatchV1,
  ContextAuthoringProposalInput,
  ContextAuthoringProposalV1,
} from './context-authoring.js';
export type {
  SeedDefaultSkillsOptions,
  SeedDefaultSkillsResult,
} from "./skills/defaults.js";
export {
  certifiedBlockProvesRequestedTopN,
  certifiedBlockDeclaresQualifiers,
  buildCertifiedBlockInvocationInput,
  parseProposal,
  compactSemanticRuntimeFailure,
  materializeKnowledgeLensSkills,
  normalizeWarehouseSqlFailure,
  scopeContextPackToExploratoryCandidateClosure,
  trimCertifiedBlockResultToRequestedTopN,
} from "./answer-loop.js";
export {
  classifyAnalyticalFailure,
  createAnalyticalFailure,
  deriveAnalyticalRepair,
  redactAnalyticalDiagnostic,
} from './analytical-failure-repair.js';
export {
  PROVIDER_RESULT_ROW_REDACTION_POLICY_ID,
  PROVIDER_ZERO_RESULT_ROWS_POLICY_ID,
  assertProviderPayloadAllowed,
  boundProviderResultRows,
  createProviderDispatchEgressReceipt,
  createProviderEgressReceipt,
  inspectProviderPayloadRowShape,
  markProviderMetadata,
  markProviderMetadataArray,
  prepareProviderContextForDispatch,
  prepareServerOwnedProviderSchemaContext,
  prepareProviderWireEnvelopeForDispatch,
  providerPayloadFingerprint,
  redactProviderResultRows,
  stripProviderResultRows,
  ASK_NARRATION_RESULT_ROW_POLICY_ID,
  MAX_RESEARCH_NARRATION_RESULT_ROWS,
  MAX_ASK_NARRATION_RESULT_ROWS,
  DEFAULT_ASK_ROW_EGRESS_POLICY,
  ZERO_ROW_EGRESS_POLICY,
  RESEARCH_ROW_EGRESS_POLICY,
  resolveProviderResultRowEgressPolicy,
  type ProviderPayloadGuardPolicy,
  type ProviderPayloadRowShape,
  type BoundedProviderResultRows,
  type ProviderResultRowEgressPolicy,
  type ProviderResultRowEgressAuthorityV1,
} from './provider-egress.js';
export { buildAggregationSafetyProof } from './aggregation-safety-proof.js';
export {
  analyticalError,
  analyticalErrorBlocksAnswer,
  analyticalErrorDetail,
  analyticalErrorHeadline,
  tagAnalyticalError,
  withAnalyticalErrorOrigin,
  withAnalyticalErrorOriginSync,
  ANALYTICAL_ERROR_PROPERTY,
} from './analytical-error.js';
export type {
  AnalyticalErrorDetailV1,
  AnalyticalErrorOffending,
  AnalyticalErrorOrigin,
  AnalyticalErrorStage,
} from './analytical-error.js';
export { resolveAnalyticalPeriods, calendarComparisonBounds } from './analytical-period-resolution.js';
export type {
  AnalyticalFreshnessObservationV1,
  AnalyticalFreshnessRequestV1,
  ResolveAnalyticalPeriodsResult,
} from './analytical-period-resolution.js';
export type {
  AnalyticalFailedBindingInput,
  AnalyticalFailedRunV1,
  AnalyticalRepairAction,
  AnalyticalRepairDerivationResult,
  AnalyticalRepairDerivationV1,
  AnalyticalRepairRequestV1,
  CreateAnalyticalFailureInput,
} from './analytical-failure-repair.js';
export { detectResultSetOperation, computeResultSetOperation, refersToPriorResult, type PriorResultShape } from "./conversation/result-ops.js";
export type { ResultSetOperation, PriorResultData, ResultSetComputation } from "./conversation/result-ops.js";
export type {
  AgentConversationBindingV1,
  SemanticExecutionTrace,
  SemanticQueryCompiler,
} from "./answer-loop.js";
export {
  GENERATED_ANALYTICAL_TUPLE_DRIFT_MESSAGE,
  frozenRequiredOutputAliasesForPlan,
  frozenRequiredOutputBindingProofsForPlan,
  validateFrozenRequiredOutputProjection,
  validateGeneratedAnalyticalProposal,
  type GeneratedAnalyticalProposalV1,
  type GeneratedAnalyticalProposalValidation,
  type GeneratedAnalyticalTupleDriftCode,
  type FrozenRequiredOutputProjectionValidation,
} from './generated-analytical-proposal.js';
export { resolveDomainContextEnvelope, domainContextSearchDomains, askScopeFromWorkspace, workspaceContextForScope, type AskScopeSelectionV1 } from './domain-context.js';
export type { DomainContextEnvelope, KnowledgeLens, ResolveDomainContextInput } from './domain-context.js';
export {
  stampTrustLabel,
  trustLabelIdForAnswer,
  type TrustStampableAnswer,
} from "./trust/stamp.js";
export {
  decideAgentAction,
  classifyConversationalTurn,
  looksLikeComposeApp,
  looksLikeFollowUp,
  type AgentAction,
  type ConversationalKind,
  type IntentDecision,
  type IntentDecisionInput,
  type IntentSignals,
} from "./intent-controller.js";
export {
  AgentRunEngine,
  AGENT_RUN_ESCALATION_MAP,
  createDeterministicAgentRunPlanner,
  defaultSuccessCriteria,
  FileAgentRunStore,
  InMemoryAgentRunStore,
  defaultAgentRunStorePath,
  selectRoute,
  routeReasoningEffort,
  compareResolvedPlanShadow,
  agentRouteDeadlineMs,
  agentRequestDeadlineMs,
  createAgentRunBudget,
  deadlineScale,
  setProcessDefaultDeadlineScale,
  AGENT_RUN_USER_CANCEL_CODE,
  createAgentRunCancellationError,
  isAgentRunUserCancellation,
  deterministicResultFactsForAnswer,
} from "./agent-run-engine.js";
export type { FileAgentRunStoreOptions } from "./agent-run-engine.js";
export {
  verifyAskNarration,
  renderAskNarrationBrief,
  verifiableNumbersFromFacts,
  ASK_NARRATION_SYSTEM_PROMPT,
  type AskNarrationFactSetV1,
  type AskNarrationVerification,
} from "./ask-result-narration.js";
export {
  readMetadataCatalogHealth,
  readAgentRunStoreHealth,
  type MetadataCatalogHealth,
  type AgentRunStoreHealth,
} from "./metadata/health.js";
export {
  SqliteAgentRunStore,
  defaultAgentRunSqlitePath,
  resolveAgentRunRetention,
  interruptedAgentRun,
  agentRunForStorage,
  agentRunFromStorage,
  agentRunProgressForStorage,
  agentRunProgressFromStorage,
  type SqliteAgentRunStoreOptions,
} from "./agent-run-store.js";
export { claimRuntimeOwner, releaseRuntimeOwner, runtimeOwnerAlive, RUNTIME_OWNER_STALE_MS } from "./runtime-owner.js";
export type { Awaitable, AwaitableMethods, PromisedMethods } from "./store-types.js";
export { ftsTokens } from "./memory/fts-query.js";
export type {
  AgentRouteExecutionContext,
  AgentRouteExecutor,
  AgentRouteExecutorResult,
  AgentRouter,
  AgentRun,
  AgentRunAnswerKind,
  AgentRunReviewDraftV1,
  AgentRunArtifact,
  AgentRunArtifactKind,
  AgentRunAudience,
  AgentRunBudget,
  AgentRunEngineOptions,
  AgentRunEvaluation,
  AgentRunEvaluationSeverity,
  AgentRunDiagnosticFailureV1,
  AgentRunDiagnosticReceiptV1,
  AgentRunDiagnosticReceiptV2,
  NarrationIntegrityReceiptV1,
  AgentRunEvent,
  AgentRunExecutionTarget,
  AgentRunExecutors,
  AgentRunGate,
  AgentRunGateContext,
  AgentRunGates,
  AgentRunNextAction,
  AgentRunPlan,
  AgentRunPlanInput,
  AgentRunPlanner,
  AgentRunPlanSource,
  AgentRunPlannedStep,
  AgentRunReplanDecision,
  AgentRunReplanInput,
  AgentRunRepairAction,
  AgentRunRequest,
  AgentRunRequestedMode,
  AgentRunRoute,
  AgentRunLifecycleState,
  AgentRunLifecycleV1,
  AgentRunProgressV1,
  AgentRunPriorResultMemberBindingV1,
  AgentRunSelectedObject,
  AgentRunStatus,
  AgentRunStep,
  AgentRunStepStatus,
  AgentRunStopReason,
  AgentRunStore,
  AgentRunTrustState,
  ResolvedPlanShadowComparison,
} from "./agent-run-engine.js";
export { defaultAgentRunGates } from "./agent-run-gates.js";
export {
  narrateResult,
  type NarrateInput,
  type NarrateItem,
  type NarrateResult,
  type NarrateResultData,
  type NarrateCompletion,
  type NarrateOptions,
} from "./narrate.js";
export {
  createLlmAgentRunPlanner,
  type AgentRunPlannerCompletion,
  type LlmAgentRunPlannerOptions,
} from "./agent-run-planner.js";
export {
  buildMeaningEvidencePackage,
  findExplicitEvidenceReference,
  validateMeaningResolution,
  routeForEvidenceCandidate,
  questionTypeFromText,
  defaultQueryIntent,
  type AgentEvidenceKind,
  type AgentEvidenceTrustTier,
  type AgentEvidenceCompatibility,
  type AgentEvidenceCandidate,
  type AgentRelationshipSafetyEvidence,
  type AgentRetrievalEvidence,
  type MeaningQueryIntent,
  type MeaningQuestionType,
  type MeaningExecutionRoute,
  type MeaningConfidence,
  type MeaningResolution,
  type MeaningResolutionInput,
  type AgentMeaningResolver,
} from "./meaning-resolution.js";
export {
  synthesizeAnswer,
  inferFormat,
  computeResultStats,
  type SynthesizeInput,
  type SynthesizeOptions,
  type SynthesizeResult,
  type SynthesizeCompletion,
  type SynthesisFormat,
  type SynthesizeResultPreview,
  type SynthesizeColumnStat,
} from "./synthesize.js";
export {
  buildDeterministicDashboardStory,
  validateDashboardStoryBrief,
  type DashboardStoryBuildInput,
  type DashboardStoryBuildResult,
  type DashboardStoryTileResult,
} from "./dashboard-story.js";
export {
  planApp,
  type AppPlan as AgentAppPlan,
  type AppPlanSection,
  type AppPlanFilter as AgentAppPlanFilter,
  type PlanBlock,
} from "./app-planner.js";
export {
  planResearch,
  type ResearchPlan,
  type ResearchStep,
  type ResearchFollowUp,
} from "./research-loop.js";
export { loadSemanticMetrics } from "./propose/build-from-prompt.js";
export type {
  AgentAnalysisPlan,
  AgentAnswer,
  AgentCitation,
  AgentDqlArtifactReference,
  AgentEvidence,
  AgentEvidenceAsset,
  AgentEvidenceContextItem,
  AgentEvidenceLineageNode,
  AgentEvidenceLineageRole,
  AgentEvidenceOutcome,
  AgentEvidenceRouteStatus,
  AgentEvidenceRouteStep,
  AgentEvidenceToolCall,
  AgentFollowUpContext,
  AgentMemberBinding,
  AgentJoinPath,
  AgentIntent,
  AgentPriorResultReference,
  AgentResultPayload,
  CertifiedBlockInvocationInput,
  AgentSchemaColumn,
  AgentSchemaTable,
  AnalysisDepth,
  AnswerKind,
  AnswerLoopInput,
  AiRoute,
  AiRouteTier,
  WarehouseSqlFailureCategory,
  WarehouseSqlFailureV1,
  WarehouseSqlRetryDisposition,
} from "./answer-loop.js";
export { buildResolvedAnalyticalPlan, deriveResolvedAnalyticalPlan, resolvePlanTimeRange } from './resolved-analytical-plan.js';
export type {
  BuildResolvedAnalyticalPlanInput,
  ResolvedAnalyticalPlan,
  ResolvedAnalyticalPlanDelta,
  ResolvedPlanCapability,
  ResolvedPlanCompatibilityProof,
  ResolvedPlanMemberBinding,
} from './resolved-analytical-plan.js';
export {
  adaptAnalyticalFreshnessRequest,
  adaptAnalyticalSemanticGraph,
  adaptResolvedAnalyticalPlan,
  buildPlanExecutionRegistry,
} from './plan-execution-adapter.js';
export type { AnalyticalFreshnessAdapterBinding } from './plan-execution-adapter.js';
export {
  normalizeEvidenceAnalyticalCapability,
  solveAnalyticalCompatibility,
  type AnalyticalCapabilityCandidate,
  type AnalyticalCapabilityNormalizationResult,
  type AnalyticalCompatibilityCode,
  type AnalyticalCompatibilityFailure,
  type AnalyticalCompatibilityResult,
  type AnalyticalFitClass,
} from './analytical-compatibility.js';
export { buildDeterministicAnalyticalFrame } from './analytical-frame.js';
export {
  buildAnalyticalCapabilityReadiness,
  type AnalyticalCapabilityReadiness,
  type AnalyticalReadinessQuestion,
} from './analytical-readiness.js';
export {
  buildAnalyticalExecutionGraph,
  executeAnalyticalExecutionGraph,
} from './analytical-execution-graph.js';
export type {
  AnalyticalExecutionGraphV1,
  AnalyticalExecutionGraphNode,
  AnalyticalExecutionGraphBlockedCode,
  AnalyticalExecutionReceiptV1,
  AnalyticalExecutionRoute,
  AnalyticalGraphAlignNode,
  AnalyticalGraphCalculateNode,
  AnalyticalGraphExecutionFailureCode,
  AnalyticalGraphExecutionResult,
  AnalyticalGraphMemberFilter,
  AnalyticalGraphRankNode,
  AnalyticalGraphSourceInvocationNode,
  AnalyticalGraphValidateNode,
  AnalyticalSourceResult,
  BuildAnalyticalExecutionGraphResult,
} from './analytical-execution-graph.js';
export {
  buildAnalyticalResultFacts,
  renderDeterministicAnalyticalNarrative,
  validateAnalyticalNarrativeClaims,
  renderAnalyticalFactBrief,
  parseAnalyticalNarrativeClaims,
  composeVerifiedAnalyticalNarrative,
} from './analytical-result-facts.js';
export type {
  ComposedAnalyticalNarrative,
  AnalyticalNarrativeCompletion,
} from './analytical-result-facts.js';
export type {
  AnalyticalNarrativeClaimV1,
  AnalyticalNarrativeV1,
  AnalyticalNarrativeValidationResult,
  AnalyticalResultFactKind,
  AnalyticalResultFactSetV1,
  AnalyticalResultFactV1,
  BuildAnalyticalResultFactsResult,
} from './analytical-result-facts.js';
export {
  buildGovernedRelationalRegistry,
  compileGovernedRelationalExecutionGraph,
  compileGovernedRelationalPlan,
  finalizeGovernedCompilationReceipt,
  renderGovernedRelationalAst,
  renderGovernedRelationalDqlArtifact,
} from './governed-relational-compiler.js';
export type {
  GovernedCompilationReceipt,
  GovernedAnalyticalGraphCompilationReceipt,
  GovernedAnalyticalGraphCompileResult,
  GovernedRelation,
  GovernedRelationColumn,
  GovernedRelationship,
  GovernedRelationalAst,
  GovernedRelationalCompileResult,
  GovernedRelationalRegistry,
  RelationalAggregate,
} from './governed-relational-compiler.js';
export type {
  AdaptResolvedAnalyticalPlanInput,
  PlanExecutionBinding,
  PlanExecutionBlockedCode,
  PlanExecutionRegistryEntry,
  SemanticGraphExecutionBinding,
  SemanticGraphInvocation,
} from './plan-execution-adapter.js';
export {
  matchSemanticMetric,
  VECTOR_ONLY_METRIC_SCORE_FLOOR,
  VECTOR_ONLY_METRIC_SEPARATION_MARGIN,
} from "./metadata/metric-match.js";
export {
  aggregationIntegrityIssuesForSql,
  buildGrainLedger,
  detectFanoutRisks,
  fanoutWarningsForSql,
  type AggregationIntegrityIssue,
  type AggregationIntegrityIssueKind,
  type FanoutRisk,
  type GrainLedger,
  type RelationGrain,
} from "./metadata/grain-ledger.js";
export {
  runAgenticToolLoop,
  runAgenticToolLoopDetailed,
  runTextProtocolToolLoopDetailed,
  parseTextToolCall,
  type AgenticToolLoopOptions,
  type TextToolLoopResult,
  advertisedTools,
  admittedToolNames,
} from "./agentic/tool-loop.js";
export {
  buildSemanticStageTools,
  type SemanticStageToolsInput,
} from "./agentic/toolset.js";
export {
  deriveAgenticTrust,
  normalizeSql,
  type AgenticTrustResult,
  type CompiledSemanticRecord,
} from "./agentic/answer-contract.js";
export {
  IdentifierLedger,
  editDistance,
  type AdmittedIdentifier,
  type IdentifierSource,
  type LedgerAdjudication,
} from "./agentic/identifier-ledger.js";
export {
  AGENTIC_LANES,
  DEFAULT_MAX_ITERATIONS,
  LEGACY_ORCHESTRATOR_POLICY,
  laneRunsShadowComparison,
  laneUsesAgenticOrchestrator,
  resolveOrchestratorPolicy,
  type AgenticLane,
  type OrchestratorMode,
  type OrchestratorPolicy,
} from "./agentic/orchestrator-policy.js";
export {
  ORCHESTRATOR_FALLBACK_STEP,
  answerAgentic,
  withFallbackEvidence,
  type AgenticLaneHandler,
  type AnswerAgenticOptions,
  type LegacyAnswerFn,
  type OrchestratorDiagnostic,
} from "./agentic/orchestrator.js";
export {
  ANALYST_TOOL_POLICY,
  adjudicateProposedSql,
  evidenceSourceForTool,
  harvestIdentifiers,
  withLedgerHarvest,
} from "./agentic/ledger-tools.js";
export {
  createAnalystLaneHandler,
  runAnalystLoop,
  type AnalystLoopDeps,
  type AnalystOutcome,
  type AnalystStep,
} from "./agentic/analyst-loop.js";
export { planAnalystTurn, parseAnalystTurnPlan, type AnalystTurnPlan } from './agentic/turn-plan.js';
export {
  boundedPreviewSql,
  buildPreviewQueryTool,
  type PreviewExecutor,
} from "./agentic/preview-tool.js";
export {
  MAX_VALUE_PROBE_COLUMN_QUERIES,
  buildSearchValuesTool,
  buildValueProbeSql,
  isProbeSafeColumn,
  type ProbeColumn,
  type ProbeRelation,
  type SearchValuesOptions,
  type ValueProbeCoverageStatus,
  type ValueProbeCoverageV1,
} from "./agentic/value-probe.js";
export { renderContextValidationRefusalForUser } from "./answer-loop.js";
export {
  composeBusinessExplanation,
  explainObject,
  type BusinessExplanation,
  type ExplainableObject,
} from "./agentic/business-explanation.js";
export {
  ASSUMPTION_DOMINANCE_RATIO,
  assumeDominantCandidate,
  renderAssumptionPreamble,
  type AnswerAssumption,
  type AssumptionAbout,
  type AssumptionCandidate,
} from "./agentic/assumptions.js";
export {
  composeSemanticQueryForQuestion,
  composeSemanticQueryFromCompiledMembers,
  composeSemanticQueryFromMembers,
  renderSemanticDqlArtifact,
  semanticDqlArtifactName,
  type ComposeSemanticQueryInput,
  type SemanticBridgeFilter,
  type SemanticBridgeOrderBy,
  type SemanticBridgeQueryResult,
  type SemanticDqlArtifactInput,
  type SemanticMemberSelection,
} from "./semantic-bridge/compose.js";
export {
  DQL_TOOL_REGISTRY,
  dqlMcpToolNamesForSurface,
  dqlToolDefinitionsForSurface,
  dqlToolNamesForSurface,
  getDqlToolDefinition,
} from "./tools/registry.js";
export type {
  DqlToolDefinition,
  DqlToolName,
  DqlToolSurface,
  JsonSchema,
} from "./tools/registry.js";
export {
  cascadeTraceToEvidenceRouteSteps,
  createCascadeAnswerResult,
  createCascadeTrace,
  terminalLaneForRouteTier,
  type CascadeAnswerResult,
  type CascadeAnswerResultInput,
  type CascadeAnswerTier,
  type CascadeCertifiedOutcome,
  type CascadeEvidenceRouteStep,
  type CascadeGeneratedOutcome,
  type CascadeLane,
  type CascadeLaneOutcome,
  type CascadeLaneStatus,
  type CascadeLaneTrace,
  type CascadeLaneTraceInput,
  type CascadeRefusalOutcome,
  type CascadeSemanticOutcome,
  type CascadeTraceInput,
} from "./cascade/cascade.js";
export {
  shouldClarifyBeforeGeneration,
  type CascadeClarifyInput,
  type CascadeMissingContext,
  type CascadeRouteDecisionLike,
} from "./cascade/triage.js";
export {
  routeForCascadeAnswerTier,
  selectCascadeRunRoute,
  type CascadeAction,
  type CascadeAnswerRouteTier,
  type CascadeRequestedMode,
  type CascadeRouteDecision,
  type CascadeRouteRequest,
  type CascadeRunRoute,
} from "./cascade/route-policy.js";
export {
  DEFAULT_CASCADE_BUDGET_MODEL,
  canUseEngineEscalation,
  canUseLaneRepair,
  contextRetrievalBudgetForQuestion,
  analysisDepthForQuestion,
  cascadeBudgetTrace,
  cascadeBudgetUsage,
  createCascadeBudgetState,
  mcpTier2RegroundRepairBudget,
  mergeCascadeBudgetModel,
  promptContextBudgetForQuestion,
  proposalToolBudgetForQuestion,
  recordEngineEscalation,
  recordLaneRepair,
  type CascadeAnalysisDepth,
  type CascadeBudgetModel,
  type CascadeBudgetState,
  type CascadeBudgetTrace,
  type CascadeBudgetUsage,
  type CascadeLaneBudgetLimits,
  type CascadeLaneRepairKind,
  type ContextRetrievalBudget,
  type ContextRetrievalStrictness,
  type McpTier2RepairBudget,
  type PartialCascadeBudgetModel,
  type PromptContextBudget,
  type ProposalToolBudget,
  type ProposalToolBudgetClass,
  type ProposalToolBudgetOptions,
} from "./cascade/budgets.js";
export type { MetricMatch, MatchSemanticMetricOptions } from "./metadata/metric-match.js";
export {
  APP_BUILDER_SKILLS,
  planAppFromPrompt,
  validateAppPlan,
  generateAppFromPlan,
  materializeAppPlanDocuments,
} from "./app-builder.js";
export type {
  AppBuilderSkill,
  AppBuilderSkillId,
  AppMode,
  AppRequirement,
  RequirementCoverage,
  AppPlan,
  AppPlanAnalysisIntent,
  AppPlanFilter,
  AppPlanFollowUpAction,
  AppPlanPage,
  AppPlanTile,
  AppPlanTileKind,
  AppPlanTileRole,
  AppPlanTrustState,
  AppPlanValidationIssue,
  AppPlanValidationResult,
  GeneratedAppPackage,
  GenerateAppFromPlanOptions,
  PlanAppFromPromptInput,
} from "./app-builder.js";
export {
  MemoryStore,
  defaultMemoryPath,
  ensureDefaultMemoryFiles,
} from "./memory/sqlite-memory.js";
export type {
  AgentMemory,
  AgentMemoryInput,
  AgentMemoryScope,
  MemorySearchOptions,
  MemoryStoreLike,
} from "./memory/sqlite-memory.js";
export { memoryRecordForStorage } from "./memory/sqlite-memory.js";
export {
  ConversationStore,
  defaultConversationPath,
  legacyConversationPath,
  prepareConversationPath,
  newConversationThread,
  conversationTurnForStorage,
  conversationTurnFromStorage,
  conversationTurnSearchTags,
} from "./conversation/session-store.js";
export type {
  ConversationStoreLike,
  ConversationStoreMethods,
  ConversationThread,
  ConversationTurn,
  ConversationTurnInput,
  ConversationResultMemberEntityV1,
  ConversationResultMemberSetV1,
  ConversationTurnResult,
  ConversationTurnSearchOptions,
} from "./conversation/session-store.js";
export {
  emptyWorkingState,
  parseWorkingState,
  reduceWorkingState,
} from "./conversation/working-state.js";
export type {
  ConversationTopicFrame,
  ConversationWorkingState,
  TopicRelation,
} from "./conversation/working-state.js";
export {
  renderStructuredConversationSummary,
  updateRollingSummary,
  updateStructuredConversationSummary,
} from "./conversation/rolling-summary.js";
export type {
  ConversationSummaryEntryState,
  ConversationSummaryEntryV1,
  ConversationSummaryV1,
} from "./conversation/rolling-summary.js";
export {
  advanceThreadState,
  advanceThreadStateAsync,
  buildConversationSnapshot,
  loadConversationSnapshot,
  conversationEnvelopeFromContext,
  conversationHistoryFromContext,
  conversationTurnContextState,
  isLikelyClarificationReply,
  recallRelevantTurns,
  renderConversationEnvelopeForPrompt,
} from "./conversation/snapshot.js";
export type {
  ConversationEnvelopeV1,
  ConversationHistoryMessage,
  ConversationSnapshot,
  ConversationSnapshotOptions,
  ConversationSnapshotTurn,
} from "./conversation/snapshot.js";
export { conversationTurnTrust, isTrustedConversationTurn } from "./conversation/turn-trust.js";
export type { ConversationTurnTrust, ConversationTurnTrustInput } from "./conversation/turn-trust.js";
export {
  MetadataCatalog,
  buildLocalContextPack,
  buildMetadataSnapshot,
  defaultMetadataPath,
  metadataSnapshotPath,
  activeMetadataSnapshotPath,
  acquireActiveKnowledgeSnapshot,
  activeKnowledgeSnapshotLeaseCount,
  currentMetadataFingerprint,
  ensureMetadataCatalogFresh,
  metadataObjectToAllowedSqlRelation,
  openMetadataCatalog,
  openActiveKnowledgeSnapshot,
  readIndexedDomainKnowledge,
  readIndexedKnowledge360,
  retrieveMetadataSnapshotCandidates,
  planAgentAnswer,
  recordRuntimeSchemaSnapshot,
  latestRuntimeSchemaSnapshotForProject,
  recordQueryRun,
  applyContextPackCompatibility,
  toAgentRetrievalEvidence,
  upsertMetadataSnapshot,
} from "./metadata/catalog.js";
export {
  buildBlockBusinessFingerprint,
  buildBlockSqlFingerprints,
  fingerprintSql,
  normalizeBusinessFingerprintToken,
  normalizeSqlForFingerprint,
} from "./metadata/block-fingerprints.js";
export type {
  BlockBusinessFingerprint,
  BlockSqlFingerprints,
  BuildBlockBusinessFingerprintInput,
} from "./metadata/block-fingerprints.js";
export {
  buildAnalysisQuestionPlan,
  certifiedApplicabilityForObject,
  scoreAllowedSqlRelationWithAnalysisPlan,
  scoreMetadataObjectWithAnalysisPlan,
  sortAllowedSqlContextForAnalysisPlan,
} from "./metadata/analysis-planner.js";
export type {
  AnalysisEntityMention,
  AnalysisQuestionMode,
  AnalysisQuestionPlan,
  AllowedSqlRelationScore,
  CertifiedApplicabilityKind,
  CertifiedBlockApplicability,
} from "./metadata/analysis-planner.js";
export {
  grainMatches,
  requestedGrainFromPlan,
} from "./metadata/grain-gate.js";
export type {
  GrainGateKind,
  GrainGateResult,
  RequestedGrain,
} from "./metadata/grain-gate.js";
export {
  validateSqlAgainstLocalContext,
  executionRelationIdentity,
  inspectedRelationMatches,
} from "./metadata/sql-context-validation.js";
export { upgradeVectorIndexForProject, awaitVectorIndexUpgrade } from "./metadata/catalog.js";
export { indexedVectorProviderId } from "./metadata/catalog-indexed-provider.js";
export {
  projectEmbeddingProvider,
  readProjectEmbeddingSettings,
  isHashedEmbeddingProvider,
  clearProjectEmbeddingCache,
  autoUpgradeProjectEmbeddings,
  type ProjectEmbeddingSettings,
  type EmbeddingAutoUpgradeResult,
} from "./embeddings/project-embeddings.js";
export {
  applyGroundingExpansion,
  expandGroundingFromCatalog,
} from "./grounding/regrounding.js";
export {
  ContextLedger,
  createContextLedger,
} from "./grounding/context-ledger.js";
export type {
  GroundingContextExpander,
  GroundingExpansionRequest,
  GroundingExpansionResult,
  MergedGroundingContext,
} from "./grounding/regrounding.js";
export type {
  ContextLedgerExpansionResult,
  ContextLedgerInput,
  ContextLedgerSqlValidationOptions,
} from "./grounding/context-ledger.js";
export {
  buildSchemaGrounding,
  buildGroundingFromRuntimeRelations,
  renderGroundingForPrompt,
  resolveRelationsInSql,
  resolveInternalRelationIds,
  validateSqlAgainstGrounding,
  internalRelationIdsInSql,
  relationKeys,
} from "./metadata/sql-grounding.js";
export type {
  SchemaGrounding,
  GroundedTable,
  GroundedColumn,
  GroundedJoinKey,
  BuildSchemaGroundingOptions,
  RuntimeRelationInput,
  RelationResolution,
  GroundingValidationCode,
  GroundingValidationResult,
} from "./metadata/sql-grounding.js";
export { selectRelevantModels } from "./metadata/sql-retrieval.js";
export type { SelectRelevantModelsOptions } from "./metadata/sql-retrieval.js";
export {
  assessAnalyticalRelationship,
  planAnalyticalPath,
  validateAnalyticalSql,
  exploratoryCandidatePlan,
  exploratoryPathFingerprint,
  humanizeAnalyticalEntityId,
  analyticalPolicyUserFacingReason,
  type AnalyticalPolicyCode,
  type AnalyticalJoinPlanEdge,
  type AnalyticalPathPlan,
  type AnalyticalPathRequest,
  type AnalyticalRelationshipDecision,
  type AnalyticalPathDisposition,
  type AnalyticalEdgeLifecycle,
  type AnalyticalExploratoryEdge,
  type AnalyticalExploratoryPath,
} from "./metadata/analytical-policy.js";
export {
  deriveGeneratedDraftSlug,
  deriveSemanticDraftName,
  renderGeneratedSqlDqlArtifact,
  upsertGeneratedDqlArtifactDraft,
  upsertGeneratedDraft,
  upsertReviewRequiredAnswerDraft,
  reviewAnswerFingerprint,
  findReviewDraftByFingerprint,
} from "./metadata/drafts.js";
export type { GeneratedDqlArtifactDraftRecord, SemanticDraftNameInput, ReviewRequiredAnswerDraftRecord, ReviewRequiredAnswerDraft } from "./metadata/drafts.js";
export {
  persistOwner,
  readPersistedOwner,
  resolveLocalOwner,
} from "./metadata/identity.js";
export type { ResolveOwnerOptions } from "./metadata/identity.js";
export {
  propose,
  proposePlan,
  buildProposePreview,
  buildFromPrompt,
  loadDbtArtifacts,
  artifactsFromWarehouseCatalog,
  upsertProposedDraft,
  renderProposedDraft,
  blockSlug,
  resolveProposeConfig,
  DEFAULT_PROPOSE_CONFIG,
  classifyModel,
  resolveDomain,
  enrichProposal,
  enrichProposals,
} from "./propose/index.js";
export type {
  ProposeOptions,
  ProposeSummary,
  ProposalResult,
  ProposalInference,
  ProposalRanking,
  ProposedPattern,
  ProposePlan,
  ProposePlanOptions,
  ProposePlanDomain,
  ProposePlanCandidate,
  ProposePreviewOptions,
  BuildFromPromptOptions,
  BuildFromPromptContext,
  BuildFromPromptResult,
  BuildCellResult,
  BuildBlockResult,
  BuildMode,
  BuildRoute,
  CertifierVerdict,
  ProposeConfig,
  ProposeConfigInput,
  Classification,
  ClassificationResult,
  ProposedDraftRecord,
  WrittenDraft,
  DbtArtifacts,
  DbtModelNode,
  DbtSourceNode,
  DbtColumn,
  EnrichFacts,
  EnrichedContent,
  EnrichOptions,
  ReflectableDraft,
  ExecutionProbe,
  BlockReflection,
  ReflectionFix,
} from "./propose/index.js";
export { reflectAndReviseBlock } from "./propose/index.js";
export { mineJoinPatterns, type JoinPatternCandidate } from "./propose/join-mining.js";
export {
  analyzeFailureClusters,
  improvementProposalsFromKg,
  type FailureSignal,
  type ImprovementProposal,
} from "./propose/failure-analysis.js";
export type {
  BuildLocalContextPackRequest,
  CertifiedFitConfirmation,
  CertifiedFitConfirmationRequest,
  CertifiedFitConfirmationResult,
  EnsureMetadataCatalogOptions,
  EnsureMetadataCatalogResult,
  ActiveKnowledgeSnapshotLease,
  DqlContextPack,
  LocalContextPack,
  MetadataCandidateConflict,
  MetadataDiagnostic,
  MetadataEdge,
  MetadataAgentIntent,
  MetadataAllowedSqlContext,
  MetadataAnswerRoute,
  MetadataEvidenceRole,
  MetadataFollowUpContext,
  MetadataMissingContext,
  MetadataObject,
  MetadataIdentityResolution,
  MetadataRetrievalLaneCandidate,
  MetadataRetrievalLaneName,
  MetadataRetrievalLaneResult,
  MetadataSnapshotRetrievalResult,
  MetadataVectorSearchResult,
  MetadataRouteDecision,
  GrainGateRouteInfo,
  MetadataDomainShard,
  MetadataSourceFingerprint,
  MetadataSnapshot,
  MetadataTrustLabel,
  PlanAgentAnswerResult,
  QueryRunSummary,
  RuntimeSchemaSnapshot,
  RuntimeSchemaTable,
  RuntimeSchemaColumn,
  RuntimeSchemaScope,
  RuntimeSchemaObservedTarget,
} from "./metadata/catalog.js";
export type {
  SqlContextValidationCode,
  SqlContextValidationOffending,
  SqlContextValidationOptions,
  SqlContextValidationResult,
} from "./metadata/sql-context-validation.js";
export type {
  GeneratedDraftBlock,
  GeneratedDraftRecord,
} from "./metadata/drafts.js";
// --- Scoped correction memory (hints) ---
export {
  HintStore,
} from "./hints/store.js";
export type {
  SearchApprovedHintsOptions,
} from "./hints/store.js";
export {
  recordCorrectionTrace,
  evaluateHint,
  reviewHint,
  reindexHints,
  ensureHintIndexFresh,
  hintIndexProjectionFingerprint,
  listHintsFromGit,
  getHintFromGit,
  getCorrectionTraceFromGit,
  writeHintFile,
  readHintFile,
  hintsDir,
  evaluationsDir,
  tracesDir,
  reviewsDir,
  defaultHintIndexPath,
  hintEvaluationFilePath,
  readHintEvaluationFile,
  getHintEvaluationFromGit,
  listHintEvaluationsFromGit,
  updateHintCandidate,
  retireHint,
  reopenHint,
  supersedeHint,
  HintLifecycleError,
  requiresEvaluatedApproval,
} from "./hints/git-store.js";
export type {
  EnsureHintIndexFreshResult,
} from "./hints/git-store.js";
export {
  recordGovernedCorrection,
  reviewGovernedHint,
  inspectGovernedHint,
  editGovernedHintCandidate,
  reopenGovernedHint,
  resolveGovernedHintContext,
} from "./hints/lifecycle.js";
export type {
  GovernedHintContext,
  GovernedHintExecutionResult,
  ExecuteGovernedHintSql,
  ResolveGovernedHintContext,
  RecordGovernedCorrectionInput,
  ReviewGovernedHintInput,
  ReviewGovernedHintResult,
  GovernedHintInspection,
  EditGovernedHintCandidateInput,
} from "./hints/lifecycle.js";
export {
  collectHintDependencies,
  currentHintDependencyFingerprints,
  staleHintDependencies,
} from "./hints/dependencies.js";
export {
  buildCorrectionEvalCase,
  emitCorrectionEvalCase,
  appendCorrectionEvalCase,
  CORRECTIONS_EVAL_RELATIVE_PATH,
  type CorrectionEvalCase,
} from "./hints/correction-eval.js";
export {
  findStaleHints,
  findStaleApprovedHints,
  type StaleHintFinding,
  type HintScopeTargetKind,
} from "./hints/staleness.js";
export type {
  RecordCorrectionTraceInput,
  RecordCorrectionTraceResult,
  EvaluateHintInput,
  EvaluateHintResult,
  ReviewHintInput,
  ReviewHintResult,
  UpdateHintCandidateInput,
} from "./hints/git-store.js";
export {
  retrieveScopedHints,
} from "./hints/retrieval.js";
export type {
  AppliedHint,
  HintRetrievalResult,
  RetrieveScopedHintsOptions,
} from "./hints/retrieval.js";
export {
  hintAppliesToScope,
  hintsConflict,
} from "./hints/types.js";
export {
  deriveHintLesson,
  lessonForHint,
  normalizeHintLesson,
  hintLessonSearchText,
} from "./hints/lesson.js";
export {
  buildHintGraphEdges,
  questionHintGraphTargetIds,
  highSignalHintGraphTargetIds,
  describeHintGraphOverlap,
  hintGraphOverlapScore,
} from "./hints/graph.js";
export type {
  CorrectionTrace,
  Hint,
  HintEvaluation,
  HintEvaluationCheck,
  HintEvaluationStatus,
  HintDependency,
  HintDependencyKind,
  HintGraphEdge,
  HintGraphEdgeKind,
  HintLesson,
  HintLifecycleFailure,
  HintReview,
  HintScope,
  HintStatus,
  QuestionScope,
  ScopedHintMatch,
} from "./hints/types.js";
// --- Pluggable semantic retrieval (embeddings) ---
export {
  HashedTokenEmbeddingProvider,
  defaultEmbeddingProvider,
  envEmbeddingProvider,
  setProcessDefaultEmbeddingProvider,
  resolveEmbeddingProvider,
  cosineSimilarity,
  hybridRank,
  probeLocalOllamaEmbeddings,
  embeddingProviderFromIndexedId,
} from "./embeddings/provider.js";
export type {
  EmbeddingProvider,
  HybridRankItem,
  HybridRankOptions,
  HybridRanked,
  LocalOllamaEmbeddings,
} from "./embeddings/provider.js";
export type {
  AppliedContextHint,
  RuntimeValueMatch,
} from "./metadata/catalog.js";
export {
  buildRuntimeValueIndex,
  normalizeValueIndexText,
} from "./grounding/value-index.js";
export type {
  RuntimeValueIndexEntry,
  ValueIndexSnapshot,
} from "./grounding/value-index.js";
export {
  bedrockClaudeTransport,
  BedrockConverseProvider,
  bedrockConverseTransport,
  createBedrockClaudeProvider,
  createBedrockConverseProvider,
  createVertexClaudeProvider,
  defaultAwsCredentials,
  defaultGoogleAccessToken,
  signAwsRequest,
  vertexClaudeTransport,
  vertexHost,
  type AwsCredentials,
  type BedrockClaudeOptions,
  type BedrockConverseOptions,
  type GoogleAccessToken,
  type VertexClaudeOptions,
  type ProviderHttpTransport,
} from "./providers/index.js";
export {
  ClaudeProvider,
  runAnthropicNativeToolLoop,
  type AnthropicToolLoopTransport,
  anthropicToolLoopPost,
  OpenAIProvider,
  GeminiProvider,
  OllamaProvider,
  ollamaBaseUrl,
  ollamaNotRunning,
  DEFAULT_OLLAMA_BASE_URL,
  pickProvider,
  buildProvider,
  streamOrGenerate,
  normalizeAnthropicBaseUrl,
  normalizeGeminiBaseUrl,
  REASONING_EFFORTS,
  isReasoningEffort,
  coerceReasoningEffort,
  clampReasoningEffort,
  bumpReasoningEffort,
  supportsReasoningEffort,
  geminiReasoningStyle,
  effortToThinkingBudget,
  THINKING_MODES,
  isThinkingMode,
  coerceThinkingMode,
  resolveThinkingMode,
  prepareProviderHttpDispatch,
  completeProviderHttpDispatch,
  setProviderUsageListener,
} from "./providers/index.js";
export type {
  AgentProvider,
  AgentMessage,
  AgentToolDefinition,
  ProviderName,
  ProviderDispatchEvent,
  ProviderDispatchCompletionEvent,
  ProviderDispatchCompletionObserver,
  ProviderDispatchRejectionEvent,
  ProviderDispatchRejectionObserver,
  ProviderDispatchObserver,
  ProviderDispatchOperation,
  ProviderRunOptions,
  ProviderCurrentToolPolicy,
  ProviderPhysicalDispatchPhaseResolver,
  ProviderToolLoopOptions,
  NativeToolLoopStop,
  NativeToolLoopResult,
  ReasoningEffort,
  GeminiReasoningStyle,
  ThinkingMode,
  ProviderUsageLine,
} from "./providers/index.js";

/**
 * Default location for the agent's SQLite KG file.
 * Mirrors the manifest cache layout under `.dql/cache/`.
 */
export function defaultKgPath(projectRoot: string): string {
  return join(projectRoot, ".dql", "cache", "agent-kg.sqlite");
}

const AGENT_INDEX_SCHEMA_VERSION = '3';
const AGENT_RUNTIME_MARKER = join('.dql', 'cache', 'agent-runtime-version');

/**
 * Record the installed CLI version that owns the local indexes. The marker is
 * rewritten only when the version changes, so ordinary restarts remain warm
 * while an npm upgrade makes every readiness path see the same stale state.
 */
export function recordAgentRuntimeVersion(projectRoot: string, runtimeVersion: string): boolean {
  const root = resolve(projectRoot);
  const normalized = runtimeVersion.trim() || 'unknown';
  const path = join(root, AGENT_RUNTIME_MARKER);
  try {
    if (existsSync(path) && readFileSync(path, 'utf-8').trim() === normalized) return false;
  } catch {
    // Replace an unreadable marker atomically below.
  }
  mkdirSync(join(root, '.dql', 'cache'), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${normalized}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, path);
  invalidateAgentProjectState(root);
  return true;
}

export interface ReindexOptions {
  manifest?: DQLManifest;
  /** Path to the KG sqlite file. Defaults to `.dql/cache/agent-kg.sqlite`. */
  kgPath?: string;
  /** Set to false to skip re-loading Skills. */
  loadSkills?: boolean;
  /** Force the KG rebuild even when its graph fingerprint is unchanged. */
  forceKgIndex?: boolean;
  /** Force the metadata catalog rebuild even when its fingerprint is unchanged. */
  forceMetadataCatalog?: boolean;
}

export interface ReindexProjectResult {
  nodes: number;
  edges: number;
  skills: number;
  kgRebuilt: boolean;
  metadataRefreshed: boolean;
  kgFingerprint: string;
  metadataFingerprint: string;
  /** Approved hints whose scope targets no longer exist (W4.6); empty when none. */
  staleHints: StaleHintFinding[];
}

export interface EnsureAgentProjectReadyResult extends ReindexProjectResult {
  /** True when the existing in-process, versioned project state was reused. */
  cacheHit: boolean;
  /** Lightweight source version used to invalidate the warm state. */
  sourceVersion: string;
}

interface WarmProjectIndexEntry {
  sourceVersion: string;
  promise: Promise<ReindexProjectResult>;
}

const warmProjectIndexes = new Map<string, WarmProjectIndexEntry>();

/**
 * Cheap source version for the agent indexes. It watches compiled artifacts,
 * constant-time authoring-root directory tokens, and the small mutable
 * skill/hint trees. File watchers and in-process mutation paths explicitly
 * invalidate block/domain edits; warm candidate requests never traverse a
 * large block tree just to decide whether the prepared snapshot can be reused.
 */
export function agentProjectSourceVersion(projectRoot: string): string {
  const root = resolve(projectRoot);
  const tokens: string[] = [`agent-index-schema:${AGENT_INDEX_SCHEMA_VERSION}`];
  const addPath = (path: string): void => {
    try {
      const stat = statSync(path);
      tokens.push(`${path}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      tokens.push(`${path}:missing`);
    }
  };
  for (const relative of [
    'dql-manifest.json',
    'dql.config.json',
    'dql.config.yaml',
    'dql.config.yml',
    'datalex-manifest.json',
    'semantic_manifest.json',
    join('target', 'manifest.json'),
    join('target', 'semantic_manifest.json'),
    AGENT_RUNTIME_MARKER,
  ]) addPath(join(root, relative));

  try {
    const config = loadProjectConfig(root);
    const dbtManifest = resolveDbtManifestPath(root);
    if (dbtManifest) addPath(resolve(dbtManifest));
    const semanticPath = config.semanticLayer?.path;
    if (semanticPath) addPath(resolve(root, semanticPath));
  } catch {
    // The reindex path will surface real configuration errors. Versioning remains
    // best-effort so a malformed config does not make the cache itself fail.
  }

  // New OSS projects keep shared skills visible and Git-owned at `skills/`.
  // Watch the historical path as well until project migrations are complete.
  addSmallTreeState(skillsDir(root), tokens);
  addDirectoryState(join(root, 'blocks'), tokens);
  addDirectoryState(join(root, 'domains'), tokens);
  addSmallTreeState(join(root, '.dql', 'skills'), tokens);
  addSmallTreeState(join(root, '.dql', 'hints'), tokens);
  return createHash('sha1').update(tokens.sort().join('\n')).digest('hex');
}

function addDirectoryState(dir: string, tokens: string[]): void {
  try {
    const stat = statSync(dir);
    tokens.push(`${dir}:directory:${stat.size}:${stat.mtimeMs}`);
  } catch {
    tokens.push(`${dir}:directory:missing`);
  }
}

function addSmallTreeState(dir: string, tokens: string[], budget = 2_000): void {
  if (budget <= 0 || !existsSync(dir)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (tokens.length >= budget) return;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) addSmallTreeState(path, tokens, budget);
    else if (entry.isFile()) {
      try {
        const stat = statSync(path);
        tokens.push(`${path}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        // File changed while the version was sampled; the next request resamples.
      }
    }
  }
}

/**
 * Prepare the local KG/catalog once per source version. Concurrent questions
 * share the same in-flight promise, eliminating duplicate cold-start rebuilds.
 */
export async function ensureAgentProjectReady(
  projectRoot: string,
  opts: ReindexOptions = {},
): Promise<EnsureAgentProjectReadyResult> {
  const root = resolve(projectRoot);
  const sourceVersion = agentProjectSourceVersion(root);
  const existing = warmProjectIndexes.get(root);
  if (existing?.sourceVersion === sourceVersion) {
    return { ...(await existing.promise), cacheHit: true, sourceVersion };
  }

  const promise = reindexProject(root, opts).then((result) => {
    const catalog = openMetadataCatalog(root);
    try {
      catalog.setState('prepared_source_version', sourceVersion);
    } finally {
      catalog.close();
    }
    return result;
  });
  warmProjectIndexes.set(root, { sourceVersion, promise });
  try {
    return { ...(await promise), cacheHit: false, sourceVersion };
  } catch (error) {
    if (warmProjectIndexes.get(root)?.promise === promise) warmProjectIndexes.delete(root);
    throw error;
  }
}

/** Cheap, persisted readiness check used by Setup/Settings after a restart. */
export function isAgentProjectIndexReady(projectRoot: string): boolean {
  const root = resolve(projectRoot);
  if (!existsSync(defaultKgPath(root)) || !existsSync(defaultMetadataPath(root))) return false;
  const expected = agentProjectSourceVersion(root);
  try {
    const catalog = openMetadataCatalog(root);
    try {
      return catalog.state('prepared_source_version') === expected;
    } finally {
      catalog.close();
    }
  } catch {
    return false;
  }
}

/** Explicit invalidation for hosts that mutate project sources in-process. */
export function invalidateAgentProjectState(projectRoot?: string): void {
  if (projectRoot) warmProjectIndexes.delete(resolve(projectRoot));
  else warmProjectIndexes.clear();
}

/**
 * Rebuild the KG from the project's manifest. Safe to call on every save —
 * incremental indexing can land later; the wholesale rebuild is fast on the
 * scale dql projects realistically reach (thousands of nodes).
 */
export async function reindexProject(
  projectRoot: string,
  opts: ReindexOptions = {},
): Promise<ReindexProjectResult> {
  const manifest = opts.manifest ?? loadManifest(projectRoot);
  const manifestGraph = buildKGFromManifest(manifest);
  const semanticLayer = loadAgentSemanticLayer(projectRoot);
  const semanticGraph = buildKGFromSemanticLayer(semanticLayer, declaredDomainIds(manifest));
  let nodes = [...manifestGraph.nodes, ...semanticGraph.nodes];
  let edges = [...manifestGraph.edges, ...semanticGraph.edges];

  // Skills become KG nodes too so the agent can retrieve them.
  let skills: Skill[] = [];
  if (opts.loadSkills !== false) {
    const result = loadSkills(projectRoot);
    skills = result.skills;
    for (const s of skills) {
      const skillIdentity = s.qualifiedId ?? s.id;
      nodes.push({
        nodeId: `skill:${skillIdentity}`,
        kind: "skill",
        name: s.id,
        domain: s.domain,
        status: s.status,
        owner: s.owner,
        description: s.description,
        llmContext: s.body,
        sourcePath: s.sourcePath,
        sourceTier: "business_context",
        provenance: "DQL domain skill",
        payload: {
          localId: s.localId ?? s.id,
          qualifiedId: s.qualifiedId,
          scope: s.scope,
          user: s.user,
          domains: s.domains ?? [],
          modelAreaRefs: s.modelAreaRefs ?? [],
          kind: s.kind,
          triggers: s.triggers ?? [],
          exclusions: s.exclusions ?? [],
          preferredMetrics: s.preferredMetrics,
          preferredBlocks: s.preferredBlocks,
          preferredDimensions: s.preferredDimensions ?? [],
          requiredFilters: s.requiredFilters ?? [],
          clarifyWhen: s.clarifyWhen ?? [],
          examples: s.examples ?? [],
          sourceRefs: s.sourceRefs ?? [],
          vocabulary: s.vocabulary,
        },
      });
      for (const domain of s.domains ?? (s.domain ? [s.domain] : [])) {
        edges.push({ src: `domain:${domain}`, dst: `skill:${skillIdentity}`, kind: "contains" });
      }
    }
  }

  ({ nodes, edges } = dedupeGraph(nodes, edges));
  const kgFingerprint = fingerprintKgGraph(nodes, edges);

  const kg = new KGStore(opts.kgPath ?? defaultKgPath(projectRoot));
  let kgRebuilt = false;
  try {
    if (opts.forceKgIndex || kg.meta("fingerprint") !== kgFingerprint) {
      kg.rebuild(nodes, edges, { fingerprint: kgFingerprint });
      kgRebuilt = true;
    }
  } finally {
    kg.close();
  }
  const metadataRefresh = await ensureMetadataCatalogFresh(projectRoot, {
    manifest,
    semanticLayer,
    // Built once above for the KG store; the snapshot reads the same graphs.
    graphs: { manifestGraph, semanticGraph },
    // `loadSkills: false` preserves the historical KG opt-out, while the
    // metadata catalog still owns a complete immutable snapshot for context
    // retrieval and will load its source-owned skill records itself.
    skills: opts.loadSkills === false ? undefined : skills,
    force: opts.forceMetadataCatalog,
  });
  // Rebuild the approved-hint index (Git authoritative; SQLite is a view). Safe
  // when no hints exist — yields an empty index.
  try {
    reindexHints(projectRoot, opts.kgPath ?? defaultKgPath(projectRoot));
  } catch {
    // Hint indexing is advisory; never fail a reindex over it.
  }
  // W4.6 — after reindexing, flag approved hints whose scope targets vanished (e.g.
  // a renamed dbt model) so they can be retired/re-scoped instead of silently firing
  // stale guidance. Advisory; never fails a reindex.
  let staleHints: StaleHintFinding[] = [];
  try {
    const approved = listHintsFromGit(projectRoot).filter((hint) => hint.status === 'approved');
    if (approved.length > 0) {
      const kgForStale = new KGStore(opts.kgPath ?? defaultKgPath(projectRoot));
      try {
        staleHints = findStaleApprovedHints(approved, kgForStale);
      } finally {
        kgForStale.close();
      }
    }
  } catch {
    // Staleness detection is advisory.
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    skills: skills.length,
    kgRebuilt,
    metadataRefreshed: metadataRefresh.refreshed,
    kgFingerprint,
    metadataFingerprint: metadataRefresh.fingerprint,
    staleHints,
  };
}

/**
 * Promotion suggester — surface uncertified answers that have accumulated
 * positive feedback so an analyst can certify them as proper blocks.
 */
export function getPromotionCandidates(
  projectRoot: string,
  minUps = 5,
): Array<{
  blockId: string;
  question: string;
  ups: number;
}> {
  const kg = new KGStore(defaultKgPath(projectRoot));
  try {
    return kg.promotionCandidates(minUps);
  } finally {
    kg.close();
  }
}

function loadManifest(projectRoot: string): DQLManifest {
  // Agent readiness is already source-versioned and cold-only. Build from the
  // current Git-owned DQL declarations here instead of accepting an emitted
  // manifest whose name-keyed block projection may predate duplicate/manual
  // drafts. Warm App catalog queries continue to read only the active SQLite
  // snapshot; they do not rebuild or recursively parse source artifacts.
  return buildManifest({
    projectRoot,
    dbtManifestPath: resolveDbtManifestPath(projectRoot) ?? undefined,
  });
}

export function loadAgentSemanticLayer(projectRoot: string) {
  const config = loadProjectConfig(projectRoot);
  const semanticConfig = config.semanticLayer?.provider
    ? (config.semanticLayer as Parameters<
        typeof resolveSemanticLayerWithDiagnostics
      >[0])
    : config.semanticLayer?.path
      ? { provider: "dql" as const, path: config.semanticLayer.path }
      : undefined;
  const configured = resolveSemanticLayerWithDiagnostics(
    semanticConfig,
    projectRoot,
  ).layer;
  // An empty configured layer (scaffold default `provider: 'dql'` with no
  // definitions) must not shadow a real dbt MetricFlow layer — that would strip
  // every metric/dimension/measure node from the KG and disable the governed
  // metric answer tier. Substance wins over configuration.
  if (configured && semanticLayerHasContent(configured)) return configured;

  if (config.dbt?.projectDir) {
    const dbtLayer = resolveSemanticLayerWithDiagnostics(
      {
        provider: "dbt",
        projectPath: config.dbt.projectDir,
      },
      projectRoot,
    ).layer;
    if (dbtLayer && semanticLayerHasContent(dbtLayer)) return dbtLayer;
  }
  return configured ?? undefined;
}

/** True when the layer defines ANY semantics — metrics, dimensions, or measures. */
function semanticLayerHasContent(layer: NonNullable<ReturnType<typeof resolveSemanticLayerWithDiagnostics>["layer"]>): boolean {
  return layer.listMetrics().length > 0
    || layer.listDimensions().length > 0
    || layer.listMeasures().length > 0;
}

function dedupeGraph(
  nodes: KGNode[],
  edges: KGEdge[],
): { nodes: KGNode[]; edges: KGEdge[] } {
  const byId = new Map<string, KGNode>();
  for (const node of nodes) {
    const existing = byId.get(node.nodeId);
    byId.set(node.nodeId, existing ? mergeNode(existing, node) : node);
  }
  const edgeKeys = new Set<string>();
  const uniqueEdges: KGEdge[] = [];
  for (const edge of edges) {
    if (!byId.has(edge.src) || !byId.has(edge.dst)) continue;
    const key = `${edge.src}\u0000${edge.dst}\u0000${edge.kind}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    uniqueEdges.push(edge);
  }
  return { nodes: Array.from(byId.values()), edges: uniqueEdges };
}

function mergeNode(a: KGNode, b: KGNode): KGNode {
  return {
    ...a,
    ...b,
    description: b.description || a.description,
    llmContext:
      [a.llmContext, b.llmContext].filter(Boolean).join("\n\n") || undefined,
    tags: Array.from(new Set([...(a.tags ?? []), ...(b.tags ?? [])])),
    examples: [...(a.examples ?? []), ...(b.examples ?? [])],
    sourcePath: b.sourcePath ?? a.sourcePath,
    gitSha: b.gitSha ?? a.gitSha,
  };
}

function fingerprintKgGraph(nodes: KGNode[], edges: KGEdge[]): string {
  const stableNodes = nodes
    .map((node) => stripUndefinedDeep(node) as Record<string, unknown>)
    .sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
  const stableEdges = edges
    .map((edge) => stripUndefinedDeep(edge) as Record<string, unknown>)
    .sort((a, b) => [
      String(a.src).localeCompare(String(b.src)),
      String(a.dst).localeCompare(String(b.dst)),
      String(a.kind).localeCompare(String(b.kind)),
    ].find((cmp) => cmp !== 0) ?? 0);
  return createHash("sha256")
    .update(stableStringify({ nodes: stableNodes, edges: stableEdges }))
    .digest("hex");
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) return "\"[Circular]\"";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
    seen.delete(value);
    return out;
  }
  const record = value as Record<string, unknown>;
  const out = `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return out;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    out[key] = stripUndefinedDeep(raw);
  }
  return out;
}
export { planResearchHypotheses, parseResearchHypotheses, hypothesesToSteps, type ResearchHypothesis, type ResearchAssets } from './agentic/research-agent.js';
export { narrationMaxTokensForFacts } from './analytical-result-facts.js';
export { rerankCandidates, applyRerank, parseRerankReply, type RerankOutcome, type RerankCandidate } from './agentic/rerank.js';
export {
  AgenticExecutionCapabilityGate,
  mintFinalSqlAuthorization,
  verifyFinalSql,
  createAgenticSqlExecutionCapability,
  verifyAgenticSqlExecutionCapability,
  qualifyAuthorizationReferences,
  fingerprintSqlBindings,
  // `fingerprintSql` / `normalizeSqlForFingerprint` already exist in this
  // barrel from another module; the authorization variants are aliased rather
  // than shadowing them, so neither caller silently gets the other's semantics.
  fingerprintSql as fingerprintAuthorizedSql,
  normalizeSqlForFingerprint as normalizeAuthorizedSql,
  type FinalSqlAuthorizationV1,
  type AgenticSqlExecutionCapabilityV1,
  type ExecutionAuthorizationBindingV1,
  type SqlAuthorizationVerdict,
  type SqlAuthorizationCheck,
  type SqlAuthorizationReferences,
  type IdentifierEvidence,
} from './agentic/sql-authorization.js';

export { parseAnalyticalTimeWindow } from './requirement-clauses.js';

// Scripted analysts for the Ask battery: the runtime is judged by what the
// user gets no matter how the model behaves.
export {
  createScriptedAnalystProvider,
  SCRIPTED_ANALYST_PERSONAS,
  type ScriptedAnalystPersona,
  type ScriptedAnalystProvider,
} from './testing/scripted-analyst-provider.js';

export { composeAnswer, terminalTitle, type TerminalAnswerShape, type TerminalIncidentCode, type ComposedAnswer, type HostFloorRefusalReason } from './ask-runtime/compose-answer.js';

export { probeSemanticJoinFanout } from './semantic-bridge/fanout-probe.js';
export type { SemanticFanoutProbeFailureCodeV1, SemanticFanoutProbeResultV1 } from './semantic-bridge/fanout-probe.js';

// Ask pipeline (intent → prepare → execute): the interpreter-first runtime.
export * from './ask-pipeline/index.js';
export * from './research/investigation/index.js';
export { generateStructured, extractFirstJsonObject, type StructuredReply } from './providers/structured-output.js';

export * from './relationship-validation.js';
export * from './relationship-suggestions.js';
export * from './concept-draft.js';
export { renderPhysicalIdentifier, renderPhysicalRelation } from './governed-relational-compiler.js';
export {
  draftStoryNarrative,
  deterministicStoryNarrative,
  validateStoryBlocks,
  storyDraftUserPrompt,
  STORY_DRAFT_SYSTEM_PROMPT,
} from './story-draft.js';
export type { StoryDraftInput, StoryDraftResult, StoryDraftComplete } from './story-draft.js';
export {
  draftCanvasPage,
  deterministicCanvasPage,
  canvasDraftUserPrompt,
  CANVAS_DRAFT_SYSTEM_PROMPT,
} from './canvas-draft.js';
export type { CanvasDraftInput, CanvasDraftResult } from './canvas-draft.js';

export { runGatedTool, setAgentToolGate, type AgentToolCall, type AgentToolGate } from './agentic/tool-gate.js';
export * from './knowledge/index.js';
