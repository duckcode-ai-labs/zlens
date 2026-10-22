import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildConversationContext, type ConversationThreadItem } from './agentConversationContext';
import type { AgentRunEvent, AskTraceDataV1 } from '../../api/client';
import { themes } from '../../themes/notebook-theme';
import type * as UnifiedAgentRunPanelModule from './UnifiedAgentRunPanel';

let resolveArtifactDqlView: typeof UnifiedAgentRunPanelModule.resolveArtifactDqlView;
let artifactSqlDisclosureLabel: typeof UnifiedAgentRunPanelModule.artifactSqlDisclosureLabel;
let deriveResultChartConfig: typeof UnifiedAgentRunPanelModule.deriveResultChartConfig;
let artifactReadyPayloadFromRun: typeof UnifiedAgentRunPanelModule.artifactReadyPayloadFromRun;
let longRunGuidanceFor: typeof UnifiedAgentRunPanelModule.longRunGuidanceFor;
let completedRunGuidanceFor: typeof UnifiedAgentRunPanelModule.completedRunGuidanceFor;
let trustExplainer: typeof UnifiedAgentRunPanelModule.trustExplainer;
let askArtifactMeta: typeof UnifiedAgentRunPanelModule.askArtifactMeta;
let preferredAskInspectorTab: typeof UnifiedAgentRunPanelModule.preferredAskInspectorTab;
let inlineAskChartConfig: typeof UnifiedAgentRunPanelModule.inlineAskChartConfig;
let resolvedParameterValues: typeof UnifiedAgentRunPanelModule.resolvedParameterValues;
let agentRunHistoryFromItems: typeof UnifiedAgentRunPanelModule.agentRunHistoryFromItems;
let liveAgentActivityFor: typeof UnifiedAgentRunPanelModule.liveAgentActivityFor;
let answerSqlEvidenceFromRun: typeof UnifiedAgentRunPanelModule.answerSqlEvidenceFromRun;
let clarificationSelectionInput: typeof UnifiedAgentRunPanelModule.clarificationSelectionInput;
let researchSourceFromRun: typeof UnifiedAgentRunPanelModule.researchSourceFromRun;
let isAgentRunPinnable: typeof UnifiedAgentRunPanelModule.isAgentRunPinnable;
let hasAnalyticalInspectorContract: typeof UnifiedAgentRunPanelModule.hasAnalyticalInspectorContract;
let analyticalInspectorContract: typeof UnifiedAgentRunPanelModule.analyticalInspectorContract;
let analyticalInspectorSections: typeof UnifiedAgentRunPanelModule.analyticalInspectorSections;
let analyticalRepairActionLabels: typeof UnifiedAgentRunPanelModule.analyticalRepairActionLabels;
let askInspectorTabsForState: typeof UnifiedAgentRunPanelModule.askInspectorTabsForState;
let threadItemsFromTurns: typeof UnifiedAgentRunPanelModule.threadItemsFromTurns;
let replacePresentedAgentRun: typeof UnifiedAgentRunPanelModule.replacePresentedAgentRun;
let presentThreadItemsForContext: typeof UnifiedAgentRunPanelModule.presentThreadItemsForContext;
let selectAgentExecutionConnection: typeof UnifiedAgentRunPanelModule.selectAgentExecutionConnection;
let appPinDestinationLabel: typeof UnifiedAgentRunPanelModule.appPinDestinationLabel;
let askAppDestinations: typeof UnifiedAgentRunPanelModule.askAppDestinations;
let askAppWriteErrorMessage: typeof UnifiedAgentRunPanelModule.askAppWriteErrorMessage;
let askRunAllowsExecutionRepair: typeof UnifiedAgentRunPanelModule.askRunAllowsExecutionRepair;
let agentRunPerformanceRows: typeof UnifiedAgentRunPanelModule.agentRunPerformanceRows;
let mergeFinishedRun: typeof UnifiedAgentRunPanelModule.mergeFinishedRun;
let pipelineV9Activity: typeof UnifiedAgentRunPanelModule.pipelineV9Activity;
let askStoryStepsFromEvents: typeof UnifiedAgentRunPanelModule.askStoryStepsFromEvents;
let askStoryStepsFromReceipt: typeof UnifiedAgentRunPanelModule.askStoryStepsFromReceipt;
let retainLiveAgentEvents: typeof UnifiedAgentRunPanelModule.retainLiveAgentEvents;
let formatStepDuration: typeof UnifiedAgentRunPanelModule.formatStepDuration;
let AskStoryList: typeof UnifiedAgentRunPanelModule.AskStoryList;
let askStoryActiveLabel: typeof UnifiedAgentRunPanelModule.askStoryActiveLabel;
let AskRunStory: typeof UnifiedAgentRunPanelModule.AskRunStory;
let askPipelinePlanRows: typeof UnifiedAgentRunPanelModule.askPipelinePlanRows;
let askRunCaptureWarning: typeof UnifiedAgentRunPanelModule.askRunCaptureWarning;
let askFailureOriginTyped: typeof UnifiedAgentRunPanelModule.askFailureOrigin;
let askFailurePresentation: typeof UnifiedAgentRunPanelModule.ASK_FAILURE_PRESENTATION;
let extractResult: typeof UnifiedAgentRunPanelModule.extractResult;
let adoptablePendingRun: typeof UnifiedAgentRunPanelModule.adoptablePendingRun;
let selectedResultBindingForSelection: typeof UnifiedAgentRunPanelModule.selectedResultBindingForSelection;
let resolveComposerRequestedMode: typeof UnifiedAgentRunPanelModule.resolveComposerRequestedMode;
let researchResultRowsOptInForRun: typeof UnifiedAgentRunPanelModule.researchResultRowsOptInForRun;
let researchToolRowsConsentTitle: typeof UnifiedAgentRunPanelModule.RESEARCH_TOOL_ROWS_CONSENT_TITLE;
let providerEgressSummary: typeof UnifiedAgentRunPanelModule.providerEgressSummary;
let researchVerdictSummary: typeof UnifiedAgentRunPanelModule.researchVerdictSummary;
let researchVerdictSummaryForRun: typeof UnifiedAgentRunPanelModule.researchVerdictSummaryForRun;
let authoritativeV8CompactInspectorProjection: typeof UnifiedAgentRunPanelModule.authoritativeV8CompactInspectorProjection;
let InspectorDecisionStory: typeof UnifiedAgentRunPanelModule.InspectorDecisionStory;
let InspectorAuthoritativeV8DecisionStory: typeof UnifiedAgentRunPanelModule.InspectorAuthoritativeV8DecisionStory;
let ResearchPartialFailureRepair: typeof UnifiedAgentRunPanelModule.ResearchPartialFailureRepair;
let InspectorDecisionSummaryUnavailable: typeof UnifiedAgentRunPanelModule.InspectorDecisionSummaryUnavailable;
let inspectorLegacySummaryNotice: typeof UnifiedAgentRunPanelModule.CANONICAL_DECISION_SUMMARY_UNAVAILABLE;
let analyticalTaskOutcomePresentation: typeof UnifiedAgentRunPanelModule.analyticalTaskOutcomePresentation;
let AnalyticalTaskOutcomeList: typeof UnifiedAgentRunPanelModule.AnalyticalTaskOutcomeList;

beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./UnifiedAgentRunPanel');
    resolveArtifactDqlView = module.resolveArtifactDqlView;
    artifactSqlDisclosureLabel = module.artifactSqlDisclosureLabel;
    deriveResultChartConfig = module.deriveResultChartConfig;
    artifactReadyPayloadFromRun = module.artifactReadyPayloadFromRun;
    longRunGuidanceFor = module.longRunGuidanceFor;
    completedRunGuidanceFor = module.completedRunGuidanceFor;
    trustExplainer = module.trustExplainer;
    askArtifactMeta = module.askArtifactMeta;
    preferredAskInspectorTab = module.preferredAskInspectorTab;
    inlineAskChartConfig = module.inlineAskChartConfig;
    resolvedParameterValues = module.resolvedParameterValues;
    agentRunHistoryFromItems = module.agentRunHistoryFromItems;
    liveAgentActivityFor = module.liveAgentActivityFor;
    answerSqlEvidenceFromRun = module.answerSqlEvidenceFromRun;
    clarificationSelectionInput = module.clarificationSelectionInput;
    researchSourceFromRun = module.researchSourceFromRun;
    isAgentRunPinnable = module.isAgentRunPinnable;
    hasAnalyticalInspectorContract = module.hasAnalyticalInspectorContract;
    analyticalInspectorContract = module.analyticalInspectorContract;
    analyticalInspectorSections = module.analyticalInspectorSections;
    analyticalRepairActionLabels = module.analyticalRepairActionLabels;
    askInspectorTabsForState = module.askInspectorTabsForState;
    threadItemsFromTurns = module.threadItemsFromTurns;
    replacePresentedAgentRun = module.replacePresentedAgentRun;
    presentThreadItemsForContext = module.presentThreadItemsForContext;
    selectAgentExecutionConnection = module.selectAgentExecutionConnection;
    appPinDestinationLabel = module.appPinDestinationLabel;
    askAppDestinations = module.askAppDestinations;
    askAppWriteErrorMessage = module.askAppWriteErrorMessage;
    askRunAllowsExecutionRepair = module.askRunAllowsExecutionRepair;
    agentRunPerformanceRows = module.agentRunPerformanceRows;
    mergeFinishedRun = module.mergeFinishedRun;
    pipelineV9Activity = module.pipelineV9Activity;
    askStoryStepsFromEvents = module.askStoryStepsFromEvents;
    askStoryStepsFromReceipt = module.askStoryStepsFromReceipt;
    retainLiveAgentEvents = module.retainLiveAgentEvents;
    formatStepDuration = module.formatStepDuration;
    AskStoryList = module.AskStoryList;
    askStoryActiveLabel = module.askStoryActiveLabel;
    AskRunStory = module.AskRunStory;
    askPipelinePlanRows = module.askPipelinePlanRows;
    askRunCaptureWarning = module.askRunCaptureWarning;
    askFailureOriginTyped = module.askFailureOrigin;
    askFailurePresentation = module.ASK_FAILURE_PRESENTATION;
    extractResult = module.extractResult;
    adoptablePendingRun = module.adoptablePendingRun;
    selectedResultBindingForSelection = module.selectedResultBindingForSelection;
    resolveComposerRequestedMode = module.resolveComposerRequestedMode;
    researchResultRowsOptInForRun = module.researchResultRowsOptInForRun;
    researchToolRowsConsentTitle = module.RESEARCH_TOOL_ROWS_CONSENT_TITLE;
    providerEgressSummary = module.providerEgressSummary;
    researchVerdictSummary = module.researchVerdictSummary;
    researchVerdictSummaryForRun = module.researchVerdictSummaryForRun;
    authoritativeV8CompactInspectorProjection = module.authoritativeV8CompactInspectorProjection;
    InspectorDecisionStory = module.InspectorDecisionStory;
    InspectorAuthoritativeV8DecisionStory = module.InspectorAuthoritativeV8DecisionStory;
    ResearchPartialFailureRepair = module.ResearchPartialFailureRepair;
    InspectorDecisionSummaryUnavailable = module.InspectorDecisionSummaryUnavailable;
    inspectorLegacySummaryNotice = module.CANONICAL_DECISION_SUMMARY_UNAVAILABLE;
    analyticalTaskOutcomePresentation = module.analyticalTaskOutcomePresentation;
    AnalyticalTaskOutcomeList = module.AnalyticalTaskOutcomeList;
});

describe('UnifiedAgentRunPanel DQL-first artifact display helpers', () => {

  it('APP-065 keeps a matching App Autopilot tile-selection refusal visible in its current presentation context', () => {
    const contextScope = 'build_1:overview:no-tile:no-preview';
    const run = {
      id: 'run_select_dataset_tile',
      question: 'Show this as a bar chart.',
      route: 'app_build',
      status: 'blocked',
      trustState: 'blocked',
      stopReason: 'blocked',
      summary: 'APP_AUTOPILOT_DATASET_TILE_REQUIRED: select one saved Dataset tile before asking App Autopilot to make a change.',
      answer: 'APP_AUTOPILOT_DATASET_TILE_REQUIRED: select one saved Dataset tile before asking App Autopilot to make a change.',
      artifacts: [{
        id: 'answer:select-dataset-tile',
        kind: 'answer',
        title: 'Select a Dataset tile',
        trustState: 'blocked',
        payload: {
          version: 1,
          kind: 'app_autopilot_tile_required',
          code: 'APP_AUTOPILOT_DATASET_TILE_REQUIRED',
          contextScope,
        },
      }],
      evaluations: [],
      events: [],
      nextActions: [{ id: 'select-app-dataset-tile', label: 'Select a Dataset tile' }],
      steps: [],
      repairAttempts: 0,
    } as never;

    const presented = presentThreadItemsForContext([
      { kind: 'user', id: 'question', text: 'Show this as a bar chart.' },
      { kind: 'run', id: 'run_select_dataset_tile', run },
    ], contextScope);

    expect(presented).toHaveLength(2);
    expect(presented[0]).toMatchObject({ kind: 'user', text: 'Show this as a bar chart.' });
    expect(presented[1]).toMatchObject({
      kind: 'run',
      run: {
        artifacts: [expect.objectContaining({
          payload: expect.objectContaining({ kind: 'app_autopilot_tile_required', contextScope }),
        })],
      },
    });
  });

  it('AGT-036 renders a successful independent Ask task beside a typed failed or dependency-blocked sibling', () => {
    const outcomes = [{
      version: 1 as const,
      taskId: 'task-1',
      status: 'completed' as const,
      trustState: 'governed' as const,
      summary: 'Revenue result validated.',
      resultFingerprint: 'result:task-1',
    }, {
      version: 1 as const,
      taskId: 'task-2',
      status: 'dependency_blocked' as const,
      trustState: 'blocked' as const,
      summary: 'The child needs the parent result.',
      dependencyTaskIds: ['task-1'],
      failure: { version: 1 as const, code: 'DEPENDENCY_BLOCKED', message: 'The child needs the parent result.', phase: 'dependency' as const },
    }];
    const markup = renderToStaticMarkup(createElement(AnalyticalTaskOutcomeList, {
      outcomes,
      summary: {
        version: 1,
        status: 'partial',
        trustState: 'governed',
        taskCount: 2,
        successfulTaskIds: ['task-1'],
        failedTaskIds: [],
        dependencyBlockedTaskIds: ['task-2'],
      },
      t: themes.paper,
    }));
    expect(markup).toContain('Analytical tasks · 1 of 2 completed');
    expect(markup).toContain('task-1');
    expect(markup).toContain('Completed');
    expect(markup).toContain('task-2');
    expect(markup).toContain('Dependency blocked');
    expect(markup).toContain('Waiting for task-1');
    expect(analyticalTaskOutcomePresentation({
      version: 1,
      taskId: 'task-gap',
      status: 'gap',
      trustState: 'blocked',
      summary: 'No safe region field.',
      failure: { version: 1, code: 'TASK_COMPILER_UNAVAILABLE', message: 'No safe region field.', phase: 'planning' },
    })).toMatchObject({ glyph: '!', label: 'Needs coverage', tone: 'warning' });
  });

  it('AGT-036 ignores malformed persisted V3 task receipts instead of rendering or throwing', () => {
    const markup = renderToStaticMarkup(createElement(AnalyticalTaskOutcomeList, {
      outcomes: { taskId: 'not-an-array' } as unknown,
      summary: { status: 'partial', taskCount: 'two' } as unknown,
      t: themes.paper,
    }));
    expect(markup).toBe('');
  });

  it('OBS-014 gives old inspector runs the same canonical-summary-unavailable notice as full trace', () => {
    const markup = renderToStaticMarkup(createElement(InspectorDecisionSummaryUnavailable, { t: themes.paper }));
    expect(markup).toContain(inspectorLegacySummaryNotice);
    expect(markup).toContain('Open the full trace to inspect its raw advanced evidence.');
    expect(markup).not.toContain('provider-dependent stage');
  });

  it('OBS-012 keeps a root-successful partial Research answer visible while showing stored child limitations', () => {
    const summary = {
      version: 1,
      summaryFingerprint: 'p'.repeat(64),
      understoodRequest: { measures: 1, dimensions: 2, entityRequested: true, outputCount: 1, conversationBinding: 'none' },
      evidenceByRole: [{ role: 'metric', candidateCount: 1 }],
      tierDecisions: [],
      researchBranchSummary: {
        version: 1,
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
      safeNextAction: 'inspect_research_failures',
    } as const;
    const markup = renderToStaticMarkup(createElement(InspectorDecisionStory, { summary: summary as never, t: themes.paper }));
    expect(markup).toContain('Research branch evidence');
    expect(markup).toContain('1 receipt-backed finding');
    expect(markup).toContain('execution failed: 4');
    expect(markup).toContain('semantic frozen ×1 for 1 branch');
    expect(markup).toContain('Research limitations: 4 child branches did not complete');
    expect(markup).toContain('Inspect failed or timed-out branches; retry narrower Research');
    expect(markup).not.toContain('No terminal incident was recorded.');
  });

  it('OBS-012 renders stored partial Research limitations in Failure & repair without inventing a root failure', () => {
    const summary = {
      version: 1,
      totalBranches: 5,
      completedBranches: 2,
      receiptBackedBranches: 2,
      failedBranches: 3,
      timedOutBranches: 0,
      skippedBranches: 0,
      partialSuccess: true,
      failureReasons: [{ code: 'execution_failed', branchCount: 3 }],
      availableChildPlans: [{ tier: 'semantic', frozenPlanCount: 2, branchCount: 2, reviewRequired: false }],
      linkedChildRunCount: 5,
      safeAction: 'inspect_research_failures',
    } as const;
    const markup = renderToStaticMarkup(createElement(ResearchPartialFailureRepair, { summary: summary as never, t: themes.paper }));
    expect(markup).toContain('Research branch limitations');
    expect(markup).toContain('The root Research answer remains successful');
    expect(markup).toContain('2 receipt-backed findings');
    expect(markup).toContain('3 failed');
    expect(markup).toContain('execution failed: 3');
    expect(markup).toContain('3 child branches did not complete');
    expect(markup).toContain('Inspect failed or timed-out branches; retry narrower Research');
    expect(markup).not.toContain('No failure was recorded for this run.');
  });

  it('keeps explicit Research separate from high thinking and preserves one-shot actions', () => {
    expect(resolveComposerRequestedMode({ initialMode: 'auto', researchMode: false })).toBe('auto');
    expect(resolveComposerRequestedMode({ initialMode: 'auto', researchMode: true })).toBe('research');
    expect(resolveComposerRequestedMode({ initialMode: 'research', researchMode: false })).toBe('ask');
    expect(resolveComposerRequestedMode({
      initialMode: 'auto', researchMode: true, pendingMode: 'block',
    })).toBe('block');
  });

  it('describes Research summary consent separately from ordinary Ask narration rows', () => {
    expect(researchResultRowsOptInForRun('ask', true)).toBe(false);
    expect(researchResultRowsOptInForRun('auto', true)).toBe(false);
    expect(researchResultRowsOptInForRun('research', false)).toBe(false);
    expect(researchResultRowsOptInForRun('research', true)).toBe(true);
    expect(researchToolRowsConsentTitle).toContain('word the summary from the figures the investigation computed, never result rows');
    expect(researchToolRowsConsentTitle).toContain('checked against those figures');
    expect(researchToolRowsConsentTitle).not.toContain('200');
    expect(researchToolRowsConsentTitle).toContain('Ordinary Ask keeps result rows local');
  });

  it('labels a legacy category classifier without presenting it as meaning resolution', () => {
    expect(providerEgressSummary({
      requestedMode: 'ask',
      providerEgressReceipts: [{
        version: 1,
        purpose: 'classification',
        dispatchPhase: 'classification',
        provider: 'local',
        permittedCategories: ['instructions', 'question'],
        resultRowCount: 0,
        columnCount: 0,
        redactionPolicyId: 'no-result-rows-v1',
        optIn: false,
        payloadFingerprint: 'sha256:classification',
      }],
    }, 1)).toBe('0 result rows sent to providers (1 content-free classification receipt)');
  });

  it('labels imported legacy ordinary narration rows as read-only rather than current Ask egress', () => {
    expect(providerEgressSummary({
      requestedMode: 'ask',
      providerEgressReceipts: [{
        version: 1,
        purpose: 'answer_narration',
        provider: 'local',
        permittedCategories: ['instructions', 'question', 'result_rows'],
        resultRowCount: 3,
        cumulativeResultRowCount: 3,
        columnCount: 2,
        redactionPolicyId: 'legacy-local-v1',
        optIn: true,
        payloadFingerprint: 'sha256:legacy',
        legacyReadOnly: true,
      }],
    }, 1)).toBe('3 bounded, redacted legacy non-Research result rows retained as read-only evidence; not a current egress authority');
  });

  it('renders typed Research branch verdicts instead of rebranding informational run checks as passes', () => {
    // This is the API-serialized no-provider fixture shape: the route/catalog
    // evaluations may be informational, while both physical branch validators
    // failed. The presentation must say that plainly and retain limited scope.
    const payload = JSON.parse(JSON.stringify({
      researchLedgerV2: {
        version: 2,
        groundableBranchCount: 2,
        limitedScope: true,
        entries: [
          { branchId: 'h1', verdict: 'failed' },
          { branchId: 'h2', verdict: 'failed' },
        ],
      },
    })) as Record<string, unknown>;
    expect(researchVerdictSummary(payload)).toMatchObject({
      branchCount: 2,
      groundableBranchCount: 2,
      limitedScope: true,
      verdicts: { failed: 2 },
      compactLabel: 'Limited research scope · 2 failed',
    });
    expect(researchVerdictSummary(payload)?.detail).toContain('2 of at least 3 evidence-supported branches');
    expect(researchVerdictSummary(payload)?.compactLabel).not.toMatch(/passed|verified/i);

    const run = {
      id: 'ask-research-no-provider',
      route: 'research',
      artifacts: [{ id: 'research-artifact', kind: 'research_run', title: 'Research plan', payload }],
      evaluations: [
        { id: 'route-decision', severity: 'info', passed: true },
        { id: 'catalog-grounding', severity: 'info', passed: true },
        { id: 'research-workspace', severity: 'info', passed: true },
      ],
    } as any;
    expect(researchVerdictSummaryForRun(run)?.compactLabel).toBe('Limited research scope · 2 failed');
  });

  it('prefers the additive V3 ledger and labels local lineage as non-causal rather than query execution', () => {
    const payload = JSON.parse(JSON.stringify({
      researchLedgerV2: {
        version: 2,
        groundableBranchCount: 1,
        limitedScope: true,
        entries: [{ branchId: 'legacy', verdict: 'failed' }],
      },
      researchLedgerV3: {
        version: 3,
        groundableBranchCount: 2,
        limitedScope: true,
        entries: [
          { branchId: 'lineage', evidenceKind: 'lineage_graph', verdict: 'inconclusive' },
          { branchId: 'analytics', evidenceKind: 'analytical_result', verdict: 'failed' },
        ],
      },
    })) as Record<string, unknown>;

    expect(researchVerdictSummary(payload)).toMatchObject({
      branchCount: 2,
      groundableBranchCount: 2,
      lineageBranchCount: 1,
      verdicts: { inconclusive: 1, failed: 1 },
      compactLabel: 'Limited research scope · 1 inconclusive · 1 failed',
    });
    expect(researchVerdictSummary(payload)?.detail).toContain('1 structural lineage check was local-only and non-causal.');
    expect(researchVerdictSummary(payload)?.detail).not.toMatch(/SQL execution|provider result/i);
  });

  it('names the exact App page used by the added-result confirmation', () => {
    expect(appPinDestinationLabel('Customer Health', 'Executive overview')).toBe('Customer Health › Executive overview');
    expect(appPinDestinationLabel('Customer Health')).toBe('Customer Health');
  });

  it('turns an Ask-to-App 405 into a safe runtime compatibility recovery', () => {
    expect(askAppWriteErrorMessage(Object.assign(new Error('Method not allowed'), { status: 405 }), 'Could not create the app.')).toContain('Restart zlens notebook');
    expect(askAppWriteErrorMessage(new Error('Draft conflict'), 'Could not create the app.')).toBe('Draft conflict');
    expect(askAppWriteErrorMessage(null, 'Could not create the app.')).toBe('Could not create the app.');
  });

  it('lists editable drafts once and turns an unedited Project App into a safe draft destination', () => {
    const editDraft = {
      id: 'draft-edit', appId: 'project-app', name: 'Project App edits', state: 'local_draft',
      baseApp: { appId: 'project-app' }, pages: [{ id: 'overview', metadata: { title: 'Overview' } }],
    } as never;
    const localDraft = {
      id: 'draft-local', appId: 'local-app', name: 'Local App', state: 'local_draft',
      pages: [{ id: 'page-1', metadata: { title: 'Analysis' } }],
    } as never;
    const destinations = askAppDestinations([
      { id: 'project-app', name: 'Project App', dashboards: [{ id: 'overview', title: 'Overview' }] },
      { id: 'other-project', name: 'Other Project', dashboards: [{ id: 'main', title: 'Main' }] },
    ] as never, [editDraft, localDraft]);

    expect(destinations.map((destination) => destination.id)).toEqual([
      'draft:draft-edit',
      'draft:draft-local',
      'project:other-project',
    ]);
    expect(destinations[0]).toMatchObject({ kind: 'draft', pageId: 'overview' });
    expect(destinations[2]).toMatchObject({ kind: 'project', pageId: 'main', pageTitle: 'Main' });
  });

  it('keeps Ask on an explicit valid connection and falls back to the server default', () => {
    const names = ['analytics', 'reporting'];
    expect(selectAgentExecutionConnection(names, 'analytics', 'reporting')).toBe('reporting');
    expect(selectAgentExecutionConnection(names, 'analytics', 'deleted-connection')).toBe('analytics');
    expect(selectAgentExecutionConnection(names, 'missing-default')).toBe('analytics');
    expect(selectAgentExecutionConnection([], 'analytics')).toBeUndefined();
  });

  it('UI-027 the units contract travels with the rows out of the artifact', () => {
    const result = extractResult({
      result: {
        columns: ['aov'], rows: [{ aov: 10.2 }], rowCount: 1,
        columnsMeta: [{ name: 'aov', kind: 'currency', unit: 'USD' }, { bogus: true }],
      },
    });
    expect(result?.columnsMeta).toEqual([{ name: 'aov', kind: 'currency', unit: 'USD' }]);
    expect(extractResult({ result: { columns: ['n'], rows: [{ n: 1 }], rowCount: 1 } })?.columnsMeta).toBeUndefined();
  });

  it('UI-026 a thread-less pending run is adopted only by the tab that submitted it', () => {
    const runs = [
      { id: 'r-old', question: 'a', startedAt: '2026-09-06T10:00:00.000Z', submissionId: 'sub-a' },
      { id: 'r-new', question: 'b', startedAt: '2026-09-06T10:01:00.000Z', submissionId: 'sub-b' },
      { id: 'r-thr', question: 'c', startedAt: '2026-09-06T10:02:00.000Z', threadId: 'thr-1', submissionId: 'sub-c' },
      { id: 'r-legacy', question: 'd', startedAt: '2026-09-06T10:03:00.000Z' },
    ];
    expect(adoptablePendingRun(runs, undefined, (id) => id === 'sub-a')?.id).toBe('r-old');
    expect(adoptablePendingRun(runs, undefined, () => false)).toBeUndefined();
    expect(adoptablePendingRun(runs, 'thr-1', () => false)?.id).toBe('r-thr');
  });

  it('normalizes positional connector rows before the result renderer indexes them (AGT-032)', () => {
    expect(extractResult({
      result: {
        columns: [{ name: 'customer' }, { name: 'revenue' }],
        rows: [['Ada', 42], ['Grace', 37]],
        rowCount: 2,
      },
    })).toMatchObject({
      columns: ['customer', 'revenue'],
      rows: [
        { customer: 'Ada', revenue: 42 },
        { customer: 'Grace', revenue: 37 },
      ],
      rowCount: 2,
    });
  });

  it('shows automatic Ask repair only from the retained server capability', () => {
    const inferredLegacyRun = {
      status: 'blocked',
      artifacts: [{ payload: { sql: 'select 1', warehouseFailure: { category: 'syntax' } } }],
    };
    expect(askRunAllowsExecutionRepair(inferredLegacyRun as never)).toBe(false);
    expect(askRunAllowsExecutionRepair({
      ...inferredLegacyRun,
      repairCapability: {
        version: 1,
        automatic: { eligible: true, action: 'repair_embedded_sql', correctionCode: 'SQL_EXECUTION_REPAIR', attemptsRemaining: 1 },
        routeLocked: true,
        targetLocked: true,
        sourceImmutable: true,
      },
    } as never)).toBe(true);
    expect(askRunAllowsExecutionRepair({
      ...inferredLegacyRun,
      repairCapability: {
        version: 1,
        automatic: { eligible: false, action: 'none', correctionCode: 'MANUAL_REVIEW_REQUIRED', attemptsRemaining: 0 },
        routeLocked: true,
        targetLocked: true,
        sourceImmutable: true,
      },
    } as never)).toBe(false);
  });

  it('promotes a repaired run into the presented transcript for inspector and follow-up actions', () => {
    const failed = { id: 'run_failed', status: 'blocked', artifacts: [] } as never;
    const repaired = {
      id: 'run_failed:repair:1',
      question: 'Top customers',
      status: 'needs_review',
      artifacts: [{ id: 'repaired_artifact', kind: 'answer', payload: { result: { columns: ['name'], rows: [{ name: 'Ada' }], rowCount: 1 } } }],
    } as never;
    const items = replacePresentedAgentRun([
      { kind: 'user', id: 'question', text: 'Top customers' },
      { kind: 'run', id: 'run_failed', run: failed },
    ], 'run_failed', repaired);
    expect(items[1]).toMatchObject({ kind: 'run', id: 'run_failed:repair:1', run: repaired });
    expect(buildConversationContext(items as ConversationThreadItem[])).toMatchObject({
      activeTurnId: 'run_failed:repair:1',
      sourceAnswerId: 'run_failed:repair:1',
      resultColumns: ['name'],
      resultRowsSample: [{ name: 'Ada' }],
    });
  });

  it('collapses the immutable failed turn when a persisted repair derivation exists', () => {
    const turns = [
      { id: 'turn_failed', threadId: 'thread', agentRunId: 'run_failed', seq: 1, question: 'Top customers', createdAt: '2026-08-03T00:00:00Z' },
      { id: 'turn_repaired', threadId: 'thread', agentRunId: 'run_repaired', seq: 2, question: 'Top customers', createdAt: '2026-08-03T00:00:01Z' },
    ] as never;
    const runs = [
      { id: 'run_failed', artifacts: [] },
      { id: 'run_repaired', artifacts: [], derivation: { kind: 'analytical_repair', sourceRunId: 'run_failed' } },
    ] as never;
    const items = threadItemsFromTurns(turns, runs);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Top customers' });
    expect(items[1]).toMatchObject({ kind: 'run', id: 'run_repaired' });
  });

  it('UI-012 exposes the complete seven-section analytical inspector for success and failure payloads', () => {
    expect(hasAnalyticalInspectorContract({
      resolvedAnalyticalPlan: { planId: 'plan-1' },
      analyticalExecutionGraph: { graphId: 'graph-1' },
    })).toBe(true);
    expect(hasAnalyticalInspectorContract({
      analyticalFailure: { code: 'PERMISSION_DENIED', phase: 'execution' },
    })).toBe(true);
    expect(hasAnalyticalInspectorContract({
      semanticExecutionTrace: {
        version: 1,
        adapter: 'dbt-cloud',
        status: 'ambiguous',
      },
    })).toBe(true);
    const repaired = {
      diagnosticReceipt: {
        phase: 'run.completed',
        repair: { sourceRunId: 'failed-run', targetPreserved: true },
        execution: { rowCount: 2, resultFingerprint: 'result-2' },
      },
      result: { columns: ['name'], rows: [{ name: 'Ada' }, { name: 'Grace' }] },
    };
    expect(hasAnalyticalInspectorContract(repaired)).toBe(true);
    expect(analyticalInspectorContract(repaired)).toMatchObject({
      diagnostic: { phase: 'run.completed', execution: { rowCount: 2 } },
      failure: undefined,
    });
    expect(hasAnalyticalInspectorContract({
      diagnosticReceipt: {
        version: 1,
        runId: 'run-failed',
        phase: 'executor.started',
        failure: { code: 'EXECUTOR_FAILURE' },
      },
    })).toBe(true);
    const cascadeV3 = analyticalInspectorContract({
      diagnosticReceiptV3: {
        version: 3,
        runId: 'run-v3',
        planFrozen: false,
        finalStopReason: 'human_review_required',
        sourceCoverage: [{ source: 'semantic', status: 'available', candidateIds: ['semantic:metric:revenue'] }],
        cascade: {
          selectedTier: 'exploratory_sql',
          attempts: [{ tier: 'semantic', outcome: 'ineligible', reason: 'Incomplete dimensions.' }],
        },
        provider: { phase: 'generation', cause: 'gateway', safeAction: 'retry_same_provider' },
      },
    });
    expect(cascadeV3?.diagnostic).toMatchObject({
      version: 3,
      sourceCoverage: [{ source: 'semantic', status: 'available' }],
      provider: { cause: 'gateway' },
    });
    const mergedReceipts = analyticalInspectorContract({
      diagnosticReceipt: { version: 1, phase: 'run.completed', failure: { code: 'LEGACY_FAILURE' } },
      diagnosticReceiptV3: {
        version: 3,
        runId: 'run-both',
        planFrozen: false,
        finalStopReason: 'human_review_required',
        sourceCoverage: [{ source: 'runtime_schema', status: 'errored', candidateIds: [] }],
        cascade: { stopReason: 'coverage_gap', attempts: [{ tier: 'exploratory_sql', outcome: 'unavailable', reason: 'runtime schema failed' }] },
        provider: { phase: 'preflight', cause: 'model_not_found', safeAction: 'fix_provider_configuration' },
      },
    });
    expect(mergedReceipts?.diagnostic).toMatchObject({
      version: 3,
      sourceCoverage: [{ source: 'runtime_schema', status: 'errored' }],
      cascade: { attempts: [{ tier: 'exploratory_sql', outcome: 'unavailable' }] },
      provider: { phase: 'preflight', cause: 'model_not_found' },
      failure: { code: 'LEGACY_FAILURE' },
    });
    const v4 = analyticalInspectorContract({
      diagnosticReceiptV4: {
        version: 4,
        runId: 'run-v4',
        finalStopReason: 'execution_failed',
        summary: {
          version: 1,
          summaryFingerprint: 'sha256:shared-inspector-trace-story',
          understoodRequest: { measures: 1, dimensions: 1, entityRequested: true, outputCount: 2, conversationBinding: 'none' },
          evidenceByRole: [{ role: 'metric', candidateCount: 1 }],
          tierDecisions: [{ tier: 'exploratory_sql', outcome: 'executable', planFrozen: true }],
          selectedPlan: { tier: 'exploratory_sql', planFrozen: true, reviewRequired: true },
          terminalIncident: {
            version: 1,
            code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH',
            boundary: 'sql.authorize',
            origin: 'internal_invariant',
            impact: 'execution_not_attempted',
            safeAction: 'export_redacted_trace',
          },
          safeNextAction: 'export_redacted_trace',
        },
      },
    });
    expect(v4?.decisionSummary).toMatchObject({
      summaryFingerprint: 'sha256:shared-inspector-trace-story',
      terminalIncident: {
        code: 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH',
        boundary: 'sql.authorize',
        impact: 'execution_not_attempted',
      },
    });
    const v5 = analyticalInspectorContract({
      diagnosticReceiptV5: {
        version: 5,
        runId: 'run-v5',
        finalStopReason: 'selected',
        summary: {
          version: 2,
          summaryFingerprint: 'sha256:ask-runtime-story',
          runtimeMode: 'authoritative',
          whatHappened: 'The Ask runtime compiled one route-neutral program with the metricflow compiler.',
          why: 'The selected plan passed the current compiler and trust boundary.',
          impact: 'The displayed answer is bound to validated result facts.',
          nextAction: 'none',
          selectedCompiler: 'metricflow',
          programTaskCount: 1,
          admittedCandidateCount: 3,
          toolCallCount: 4,
          executionAttempts: 1,
        },
      },
    });
    expect(v5?.runtimeDecisionSummary).toMatchObject({
      summaryFingerprint: 'sha256:ask-runtime-story',
      runtimeMode: 'authoritative',
      selectedCompiler: 'metricflow',
      executionAttempts: 1,
    });
    expect(analyticalInspectorSections()).toEqual([
      'Performance & provider egress',
      'Plan',
      'DQL',
      'Compiled SQL',
      'Lineage',
      'Trust & evidence',
      'Actual steps',
      'Failure & repair',
    ]);
  });

  it('shows content-free timing/call/egress evidence and leaves legacy runs unrecorded', () => {
    const run = {
      telemetry: {
        version: 1,
        stageDurationsMs: { retrieval: 20, total: 1500 },
        providerRoundTrips: 1,
        toolCalls: 2,
        sqlExecutions: 1,
        repairs: 0,
        egressReceipts: 1,
        warehouseDurationMs: 10,
      },
      providerEgressReceipts: [{ resultRowCount: 0 }],
      artifacts: [{ id: 'artifact-1', payload: { resolvedAnalyticalPlan: { planId: 'plan-1' } } }],
    } as unknown as Parameters<typeof agentRunPerformanceRows>[0];
    expect(agentRunPerformanceRows(run)).toEqual(expect.arrayContaining([
      ['Total', '1.5s'],
      ['Warehouse', '10ms'],
      ['Orchestration', '1.5s'],
      ['Calls', '1 provider · 2 tool · 1 SQL · 0 repair'],
      ['Provider rows', '0 result rows sent to providers (1 content-free receipt)'],
      ['Plan ID', 'plan-1'],
      ['Artifact IDs', 'artifact-1'],
    ]));
    expect(agentRunPerformanceRows({} as Parameters<typeof agentRunPerformanceRows>[0])).toBeUndefined();
  });

  it('OBS-017 uses the one authoritative V8 receipt for compact call counts instead of independently counted spans', () => {
    const trace = {
      envelope: {
        version: 1, traceId: 'v'.repeat(32), rootSpanId: 'w'.repeat(16), runId: 'v8-counts', surface: 'browser', mode: 'ask',
        questionFingerprint: 'sha256:question', status: 'completed', recordingStatus: 'complete', startedAt: '2026-08-30T12:00:00.000Z', durationMs: 30,
        spanCount: 3, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      // Deliberately stale/over-counted physical spans. V8 is the one runtime
      // authority for an authoritative V2 run.
      spans: [
        { version: 1, traceId: 'v'.repeat(32), spanId: 'w'.repeat(16), ordinal: 0, name: 'provider.attempt', stage: 'provider', startedAt: '2026-08-30T12:00:00.000Z', outcome: 'ok', reasonCode: 'ok', payload: { kind: 'provider' } },
        { version: 1, traceId: 'v'.repeat(32), spanId: 'x'.repeat(16), ordinal: 1, name: 'tool.call', stage: 'tool', startedAt: '2026-08-30T12:00:00.001Z', outcome: 'ok', reasonCode: 'ok', payload: { kind: 'tool' } },
        { version: 1, traceId: 'v'.repeat(32), spanId: 'y'.repeat(16), ordinal: 2, name: 'sql.execute', stage: 'sql', startedAt: '2026-08-30T12:00:00.002Z', outcome: 'ok', reasonCode: 'ok', payload: { kind: 'sql' } },
      ],
      candidateDecisions: [], links: [], runtimeMode: 'authoritative_v2',
      runtimeReceiptV8: {
        version: 8, mode: 'authoritative_v2', turnClass: 'analytics', retainedCandidateCount: 0, initialCandidateCount: 0,
        expansionCount: 0, objective: 'analytics', contextCoverage: [], excludedCandidateCount: 0, exclusionReasonCodes: [], observations: [], tierAttempts: [],
        planFrozen: true, outcome: { connectionAttempted: true, executionAttempts: 1, factCount: 1, narration: 'fact_bound' },
        activity: { providerDispatches: 0, toolCalls: 4, executionAttempts: 1, repairs: 1 }, toolDurationMs: 0, finalStopReason: 'completed',
      },
    } as unknown as AskTraceDataV1;
    const run = { requestedMode: 'ask', providerEgressReceipts: [] } as unknown as Parameters<typeof agentRunPerformanceRows>[0];

    expect(agentRunPerformanceRows(run, trace)).toEqual(expect.arrayContaining([
      ['Calls', '0 provider · 4 tool · 1 SQL · 1 repair'],
      ['Trace evidence', 'Authoritative V2 receipt (canonical physical egress and execution counts)'],
      ['Ask runtime', 'Authoritative V2 receipt'],
    ]));
  });

  it('OBS-017 makes the compact authoritative V8 story win over contradictory legacy planning placeholders', () => {
    const v8 = {
      version: 8 as const,
      mode: 'authoritative_v2' as const,
      turnClass: 'analytics' as const,
      snapshotId: 'snapshot-v8',
      retainedCandidateCount: 80,
      initialCandidateCount: 24,
      expansionCount: 0,
      objective: 'analytics' as const,
      contextCoverage: [{
        version: 2 as const,
        source: 'certified',
        status: 'available' as const,
        admittedCandidateCount: 4,
        excludedCandidateCount: 0,
        reasonCodes: ['SOURCE_AVAILABLE'],
      }],
      excludedCandidateCount: 0,
      exclusionReasonCodes: [],
      observations: [{
        version: 1 as const,
        tool: 'run_certified',
        outcome: 'eligible' as const,
        tier: 'certified',
        reasonCode: 'ASK_V2_EXECUTION_AUTHORIZED',
        candidateIds: ['commerce::block::customer_profile'],
        planId: 'ask-v2:certified:plan-4503',
        frozen: true,
        inputFingerprint: 'sha256:frozen-plan-4503',
        origin: 'freeze',
      }, {
        version: 1 as const,
        tool: 'run_certified',
        outcome: 'executed' as const,
        tier: 'certified',
        reasonCode: 'CERTIFIED_EXECUTED',
        candidateIds: ['commerce::block::customer_profile'],
        planId: 'ask-v2:certified:plan-4503',
        origin: 'execution',
      }],
      tierAttempts: [{
        version: 2 as const,
        tier: 'certified',
        outcome: 'eligible' as const,
        reasonCode: 'ASK_V2_EXECUTION_AUTHORIZED',
        candidateIds: ['commerce::block::customer_profile'],
        frozen: true,
      }, {
        version: 2 as const,
        tier: 'certified',
        outcome: 'executed' as const,
        reasonCode: 'CERTIFIED_EXECUTED',
        candidateIds: ['commerce::block::customer_profile'],
        frozen: true,
      }],
      planFrozen: true,
      terminalOutcome: { version: 2 as const, kind: 'finish_answer', reasonCode: 'ASK_V2_VALIDATED_RESULT', origin: 'execution' },
      outcome: { connectionAttempted: true, executionAttempts: 1, factCount: 11, narration: 'fact_bound' as const },
      activity: { providerDispatches: 0, toolCalls: 2, executionAttempts: 1, repairs: 0 },
      toolDurationMs: 0,
      finalStopReason: 'certified_answer_found',
    };
    const contradictoryLegacy = analyticalInspectorContract({
      diagnosticReceiptV3: {
        version: 3,
        runId: 'legacy-planning-copy',
        planFrozen: false,
        finalStopReason: 'coverage_gap',
        sourceCoverage: [],
        cascade: { attempts: [] },
        provider: { phase: 'generation', cause: 'unknown', safeAction: 'retry_after_connection' },
      },
      diagnosticReceiptV8: v8,
    });
    expect(contradictoryLegacy?.runtimeReceiptV8).toMatchObject({ mode: 'authoritative_v2', planFrozen: true });

    const projection = authoritativeV8CompactInspectorProjection(v8);
    expect(projection).toMatchObject({
      selectedTier: 'certified',
      planId: 'ask-v2:certified:plan-4503',
      frozenPlanFingerprint: 'sha256:frozen-plan-4503',
      candidateAdmissionCount: 24,
      retainedCandidateCount: 80,
    });
    const markup = renderToStaticMarkup(createElement(InspectorAuthoritativeV8DecisionStory, {
      projection: projection!,
      t: themes.paper,
    }));
    expect(markup).toContain('Authoritative Ask decision story');
    expect(markup).toContain('certified');
    expect(markup).toContain('ask-v2:certified:plan-4503');
    expect(markup).toContain('24 initial');
    expect(markup).toContain('11 validated facts');
    expect(markup).not.toContain('No cascade tier receipt was recorded');
    expect(markup).not.toContain('analytical planning did not complete');
    expect(markup).not.toContain('0 measures');
  });

  it('AGT-047 uses the controller-owned semantic progression for an unfrozen compact story', () => {
    const v8 = {
      version: 8 as const, mode: 'authoritative_v2' as const, turnClass: 'analytics' as const,
      retainedCandidateCount: 80, initialCandidateCount: 24, expansionCount: 0, objective: 'analytics' as const,
      contextCoverage: [], excludedCandidateCount: 0, exclusionReasonCodes: [], observations: [],
      tierAttempts: [
        { version: 2 as const, tier: 'semantic' as const, outcome: 'eligible' as const, reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE', candidateIds: ['semantic:metric:revenue'], frozen: false },
        { version: 2 as const, tier: 'certified' as const, outcome: 'eligible' as const, reasonCode: 'CERTIFIED_CANDIDATES_AVAILABLE', candidateIds: [], frozen: false },
      ],
      controllerTier: 'semantic' as const,
      planFrozen: false,
      terminalOutcome: { version: 2 as const, kind: 'gap' as const, reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED', origin: 'agent_control' as const },
      outcome: { connectionAttempted: false, executionAttempts: 0, factCount: 0, narration: 'not_retained' as const },
      activity: { providerDispatches: 6, toolCalls: 5, executionAttempts: 0, repairs: 0 }, toolDurationMs: 0,
      finalStopReason: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
    };
    expect(authoritativeV8CompactInspectorProjection(v8)).toMatchObject({
      selectedTier: 'semantic',
      candidateAdmissionCount: 24,
    });
  });

  it('AGT-047 projects the current exploratory controller tier after semantic compilation became unavailable', () => {
    const v8 = {
      version: 8 as const, mode: 'authoritative_v2' as const, turnClass: 'analytics' as const,
      retainedCandidateCount: 80, initialCandidateCount: 24, expansionCount: 0, objective: 'analytics' as const,
      contextCoverage: [], excludedCandidateCount: 0, exclusionReasonCodes: [], observations: [],
      tierAttempts: [
        { version: 2 as const, tier: 'semantic' as const, outcome: 'eligible' as const, reasonCode: 'SEMANTIC_CANDIDATES_AVAILABLE', candidateIds: ['semantic:metric:revenue'], frozen: false },
        { version: 2 as const, tier: 'semantic' as const, outcome: 'unavailable' as const, reasonCode: 'SEMANTIC_EXECUTION_UNAVAILABLE', candidateIds: ['semantic:metric:revenue'], frozen: false },
        { version: 2 as const, tier: 'governed_relational' as const, outcome: 'unavailable' as const, reasonCode: 'GOVERNED_RELATIONAL_EXECUTION_UNAVAILABLE', candidateIds: [], frozen: false },
      ],
      controllerTier: 'exploratory_sql' as const,
      planFrozen: false,
      terminalOutcome: { version: 2 as const, kind: 'gap' as const, reasonCode: 'ASK_V2_TOOL_PROGRESSION_REQUIRED', origin: 'agent_control' as const },
      outcome: { connectionAttempted: false, executionAttempts: 0, factCount: 0, narration: 'not_retained' as const },
      activity: { providerDispatches: 4, toolCalls: 4, executionAttempts: 0, repairs: 0 }, toolDurationMs: 0,
      finalStopReason: 'ASK_V2_TOOL_PROGRESSION_REQUIRED',
    };
    expect(authoritativeV8CompactInspectorProjection(v8)).toMatchObject({
      selectedTier: 'exploratory_sql',
    });
  });

  it('OBS-010 projects ordinary Ask egress from its actual meaning receipt without calling it Research', () => {
    const trace = JSON.parse(JSON.stringify({
      envelope: {
        version: 1, traceId: '9'.repeat(32), rootSpanId: '8'.repeat(16), runId: 'ordinary-semantic',
        surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question', status: 'completed',
        recordingStatus: 'complete', startedAt: '2026-08-24T12:00:00.000Z', completedAt: '2026-08-24T12:00:00.030Z', durationMs: 30,
        spanCount: 3, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [
        { version: 1, traceId: '9'.repeat(32), spanId: '8'.repeat(16), ordinal: 0, name: 'ask.run', stage: 'request', startedAt: '2026-08-24T12:00:00.000Z', durationMs: 30, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'stage' } },
        { version: 1, traceId: '9'.repeat(32), spanId: '7'.repeat(16), ordinal: 1, name: 'provider.attempt', stage: 'provider', startedAt: '2026-08-24T12:00:00.001Z', durationMs: 10, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'provider' } },
        { version: 1, traceId: '9'.repeat(32), spanId: '6'.repeat(16), ordinal: 2, name: 'sql.execute', stage: 'sql', startedAt: '2026-08-24T12:00:00.012Z', durationMs: 12, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'sql', execution: { reviewRequired: false } } },
      ],
      candidateDecisions: [], links: [],
    })) as AskTraceDataV1;
    const run = {
      requestedMode: 'ask',
      providerEgressReceipts: [{
        version: 1,
        purpose: 'answer_generation',
        dispatchPhase: 'meaning_resolution',
        provider: 'test',
        permittedCategories: ['instructions', 'question'],
        resultRowCount: 0,
        columnCount: 0,
        redactionPolicyId: 'no-result-rows-v1',
        optIn: false,
        payloadFingerprint: 'a'.repeat(64),
      }],
    } as unknown as Parameters<typeof agentRunPerformanceRows>[0];
    const rows = agentRunPerformanceRows(run, trace);
    const providerRows = rows?.find(([label]) => label === 'Provider rows')?.[1] ?? '';
    expect(providerRows).toBe('0 result rows sent to providers (1 content-free meaning resolution receipt)');
    expect(providerRows).not.toContain('Research');
    expect(rows).toEqual(expect.arrayContaining([
      ['Calls', '1 provider · 0 tool · 1 SQL · 0 repair'],
    ]));
  });

  it('uses the API-serialized canonical trace instead of stale legacy provider and SQL telemetry for an exact certified route', () => {
    // This mirrors the frozen certified/no-connection runtime shape: older
    // telemetry can still contain planned provider/SQL counters, but the
    // local trace proves neither physical boundary was reached.
    const trace = JSON.parse(JSON.stringify({
      envelope: {
        version: 1, traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), runId: 'certified-no-connection',
        surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question', status: 'blocked',
        recordingStatus: 'complete', startedAt: '2026-08-23T12:00:00.000Z', completedAt: '2026-08-23T12:00:00.042Z', durationMs: 42,
        spanCount: 4, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [
        { version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), ordinal: 0, name: 'ask.run', stage: 'request', startedAt: '2026-08-23T12:00:00.000Z', durationMs: 42, outcome: 'error', reasonCode: 'post_freeze_failure', payload: { kind: 'stage' } },
        { version: 1, traceId: 'a'.repeat(32), spanId: 'c'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 1, name: 'cascade.evaluate', stage: 'cascade', startedAt: '2026-08-23T12:00:00.001Z', durationMs: 8, outcome: 'ok', reasonCode: 'cascade_selected', payload: { kind: 'cascade' } },
        { version: 1, traceId: 'a'.repeat(32), spanId: 'd'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 2, name: 'plan.freeze', stage: 'plan', startedAt: '2026-08-23T12:00:00.010Z', durationMs: 1, outcome: 'ok', reasonCode: 'plan_frozen', payload: { kind: 'cascade' } },
        { version: 1, traceId: 'a'.repeat(32), spanId: 'e'.repeat(16), parentSpanId: 'b'.repeat(16), ordinal: 3, name: 'result.normalize', stage: 'result', startedAt: '2026-08-23T12:00:00.012Z', durationMs: 1, outcome: 'error', reasonCode: 'post_freeze_failure', payload: { kind: 'result', failureCode: 'CONNECTION_NOT_CONFIGURED', safeAction: 'configure_connection' } },
      ],
      candidateDecisions: [], links: [],
    })) as AskTraceDataV1;
    const staleRun = {
      telemetry: {
        version: 1,
        stageDurationsMs: { provider: 21, execution: 1, total: 42 },
        providerRoundTrips: 0,
        toolCalls: 0,
        sqlExecutions: 1,
        repairs: 0,
        egressReceipts: 1,
      },
      providerEgressReceipts: [{ resultRowCount: 7 }],
    } as unknown as Parameters<typeof agentRunPerformanceRows>[0];

    const rows = agentRunPerformanceRows(staleRun, trace);
    expect(rows).toEqual(expect.arrayContaining([
      ['Total', '42ms'],
      ['Warehouse', 'Not recorded'],
      ['Orchestration', '42ms'],
      ['Calls', '0 provider · 0 tool · 0 SQL · 0 repair'],
      ['Provider rows', '0 result rows sent to providers (0 content-free receipts)'],
      ['Trace evidence', 'Canonical local physical trace'],
    ]));
    const stageSummary = rows?.find(([label]) => label === 'Stages')?.[1] ?? '';
    expect(stageSummary).toContain('cascade: 8ms');
    expect(stageSummary).not.toContain('provider:');
    expect(stageSummary).not.toContain('sql:');
  });

  it('keeps genuine provider, tool, SQL, and repair counts tied to their physical trace attempts', () => {
    const trace = JSON.parse(JSON.stringify({
      envelope: {
        version: 1, traceId: 'f'.repeat(32), rootSpanId: '1'.repeat(16), runId: 'physical-attempts',
        surface: 'browser', mode: 'ask', questionFingerprint: 'sha256:question', status: 'completed',
        recordingStatus: 'complete', startedAt: '2026-08-23T12:00:00.000Z', completedAt: '2026-08-23T12:00:00.100Z', durationMs: 100,
        spanCount: 7, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [
        { version: 1, traceId: 'f'.repeat(32), spanId: '1'.repeat(16), ordinal: 0, name: 'provider.preflight', stage: 'provider', startedAt: '2026-08-23T12:00:00.000Z', durationMs: 4, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'provider' } },
        { version: 1, traceId: 'f'.repeat(32), spanId: '2'.repeat(16), ordinal: 1, name: 'provider.attempt', stage: 'provider', startedAt: '2026-08-23T12:00:00.004Z', durationMs: 12, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'provider' } },
        { version: 1, traceId: 'f'.repeat(32), spanId: '3'.repeat(16), ordinal: 2, name: 'tool.call', stage: 'tool', startedAt: '2026-08-23T12:00:00.016Z', durationMs: 3, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'tool' } },
        { version: 1, traceId: 'f'.repeat(32), spanId: '4'.repeat(16), ordinal: 3, name: 'sql.generate', stage: 'sql', startedAt: '2026-08-23T12:00:00.019Z', durationMs: 2, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'sql' } },
        { version: 1, traceId: 'f'.repeat(32), spanId: '5'.repeat(16), ordinal: 4, name: 'sql.execute', stage: 'sql', startedAt: '2026-08-23T12:00:00.021Z', durationMs: 10, outcome: 'ok', reasonCode: 'completed', payload: { kind: 'sql' } },
        { version: 1, traceId: 'f'.repeat(32), spanId: '6'.repeat(16), ordinal: 5, name: 'sql.repair', stage: 'sql', startedAt: '2026-08-23T12:00:00.031Z', durationMs: 5, outcome: 'ok', reasonCode: 'repair_attempted', payload: { kind: 'sql' } },
        // Admission denial is retained as a trace stage, but no provider
        // bytes were sent and it must not inflate physical call/timing rows.
        { version: 1, traceId: 'f'.repeat(32), spanId: '7'.repeat(16), ordinal: 6, name: 'provider.attempt', stage: 'provider', startedAt: '2026-08-23T12:00:00.036Z', durationMs: 8, outcome: 'denied', reasonCode: 'provider_failure', payload: { kind: 'provider', attempt: { admission: 'denied' } } },
      ],
      candidateDecisions: [], links: [],
    })) as AskTraceDataV1;
    const run = {
      telemetry: {
        version: 1, stageDurationsMs: { provider: 99, total: 999 }, providerRoundTrips: 0, toolCalls: 0, sqlExecutions: 0, repairs: 0, egressReceipts: 1,
      },
      providerEgressReceipts: [{ resultRowCount: 0 }],
    } as unknown as Parameters<typeof agentRunPerformanceRows>[0];

    const rows = agentRunPerformanceRows(run, trace);
    expect(rows).toEqual(expect.arrayContaining([
      ['Warehouse', '10ms'],
      ['Orchestration', '90ms'],
      ['Calls', '1 provider · 1 tool · 1 SQL · 1 repair'],
      ['Provider rows', '0 result rows sent to providers (1 content-free receipt)'],
    ]));
    const stageSummary = rows?.find(([label]) => label === 'Stages')?.[1] ?? '';
    expect(stageSummary).toContain('provider: 12ms');
    expect(stageSummary).toContain('tool: 3ms');
    expect(stageSummary).toContain('sql: 10ms');
    expect(stageSummary).toContain('repair: 5ms');
    expect(stageSummary).not.toContain('provider: 16ms');
    expect(stageSummary).not.toContain('provider: 20ms');
  });

  it.each([
    [{ analyticalFailure: { code: 'POLICY_DENIED' } }, 'policy'],
    [{ analyticalFailure: { code: 'PERMISSION_DENIED' } }, 'policy'],
    [{ analyticalFailure: { code: 'RESULT_CONTRACT_MISMATCH' } }, 'result_contract'],
    [{ analyticalFailure: { code: 'TIMEOUT' } }, 'timeout'],
    [{ analyticalFailure: { code: 'EXECUTION_CANCELLED' } }, 'cancel'],
    [{ analyticalFailure: { code: 'COMPILATION_FAILED' } }, 'compile'],
    [{ analyticalFailure: { code: 'IDENTIFIER_SCOPE_INVALID' } }, 'identity_integrity'],
    [{ aggregationSafetyProof: { status: 'blocked' } }, 'proof_integrity'],
    [{ refusalCode: 'modeling_gap' }, 'modeling_gap'],
    [{ warehouseFailure: { origin: 'warehouse' } }, 'warehouse'],
  ])('renders a truthful typed failure state for %j', (payload, expected) => {
    expect((askFailureOriginTyped as (run: unknown) => string)({
      status: 'blocked', artifacts: [{ payload }],
    })).toBe(expected);
  });

  it('separates post-execution capture warnings from query failure', () => {
    expect(askRunCaptureWarning({
      status: 'needs_review',
      artifacts: [{ payload: { validationWarnings: ['This answer could not be captured as a reusable DQL block: parser error'] } }],
    } as never)).toMatch(/captured as a reusable DQL block/);
    expect(askRunCaptureWarning({ status: 'blocked', artifacts: [] } as never)).toBeUndefined();
  });

  it('uses proof-specific not-executed copy for blocked semantic authority', () => {
    expect(askFailurePresentation.proof_integrity).toEqual({
      title: 'Not executed: exact semantic proof was not established',
      hint: 'ZLens could not establish the exact metric, requested grain, join keys, and fanout proof. Warehouse success cannot create that authority.',
    });
  });

  it('UI-012 never interprets the orchestration step plan as an analytical ranking plan', () => {
    const contract = analyticalInspectorContract({
      diagnosticReceipt: {
        version: 1,
        runId: 'run-failed-before-planning',
        phase: 'run.failed',
        plan: {
          source: 'deterministic',
          rationale: 'Top customer request.',
          steps: [{ id: 'answer', route: 'generated_answer' }],
        },
        failure: { code: 'AI_PROVIDER_FAILURE' },
      },
    });
    expect(contract?.plan).toBeUndefined();
    expect(contract?.frame).toBeUndefined();

    const resolved = analyticalInspectorContract({
      diagnosticReceipt: {
        version: 1,
        runId: 'run-ranked',
        phase: 'run.failed',
        resolvedAnalyticalPlan: {
          analyticalFrame: {
            ranking: { direction: 'top', limit: 10, tiePolicy: 'include_ties' },
          },
        },
      },
    });
    expect(resolved?.frame?.ranking).toMatchObject({ direction: 'top', limit: 10 });
  });

  it('UI-013 capability-gates repair actions without offering a permission bypass', () => {
    expect(analyticalRepairActionLabels(['refresh_snapshot', 'edit_dql', 'open_sql_notebook', 'reapply_semantic_runtime'])).toEqual([
      'Refresh snapshot and prepare retry',
      'Open DQL to repair',
      'Open SQL in Notebook',
      'Reapply semantic runtime settings',
    ]);
    expect(analyticalRepairActionLabels(['request_access', 'change_authorized_connection'])).toEqual([
      'Change connection or request access',
    ]);
    expect(analyticalRepairActionLabels(['request_access', 'change_authorized_connection'])).not.toContain('Open SQL in Notebook');
  });

  it('UI-012/UI-013 keeps DQL, SQL, plan, and trust tabs visible after terminal compilation failure', () => {
    expect(askInspectorTabsForState({
      analytical: true,
      blocked: true,
      hasDql: true,
      hasSql: true,
      hasLineage: false,
    }).map((tab) => tab.id)).toEqual(['how', 'dql', 'sql', 'trust']);

    expect(askInspectorTabsForState({
      analytical: true,
      blocked: true,
      hasDql: false,
      hasSql: false,
      hasLineage: false,
    }).map((tab) => tab.id)).toEqual(['how', 'dql', 'sql', 'trust']);
  });

  it('UI-011 restores applied certified-block inputs in the inline Ask result', () => {
    expect(resolvedParameterValues({
      result: {
        rows: [{ product_name: 'Flame Impala', revenue: 38800 }],
        parameters: [
          { name: 'product_name', value: 'Flame Impala', source: 'question' },
          { name: 'top_n', value: 5, source: 'question' },
        ],
      },
    })).toEqual({ product_name: 'Flame Impala', top_n: 5 });
  });

  it('UI-010 keeps the user question and carries the choice as stable identity', () => {
    // The regression this pins: with no source question the label was re-asked
    // AS the question, so picking "customers.customers" to disambiguate
    // "who are the top customers" submitted the literal string
    // `customers.customers` — and the next run tried to answer that.
    expect(clarificationSelectionInput({
      id: 'semantic:metric:dbt_core_models.total_ccu_count',
      label: 'Total CCU Count',
      description: 'Billable CCU consumption.',
      kind: 'semantic_metric',
    }, 'How much CCU did we bill last month?')).toEqual({
      question: 'How much CCU did we bill last month?',
      selectedEvidenceId: 'semantic:metric:dbt_core_models.total_ccu_count',
    });
  });

  it('UI-010 keeps the original Revenue/top-10 question when Account Name is the structured display choice', () => {
    expect(clarificationSelectionInput({
      id: 'semantic:uncategorized:dimension:account_revenue.account_name',
      label: 'Account Name',
      kind: 'semantic_member',
    }, 'Show the top names by revenue')).toEqual({
      question: 'Show the top names by revenue',
      selectedEvidenceId: 'semantic:uncategorized:dimension:account_revenue.account_name',
    });
  });

  it('never re-asks a bare governed identifier as the question', () => {
    const option = { id: 'semantic:model:customers', label: 'customers.customers', kind: 'semantic_member' };
    expect(clarificationSelectionInput(option, 'who are the top customers').question)
      .toBe('who are the top customers');
    // The label remains the last resort only when no original question exists.
    expect(clarificationSelectionInput(option).question).toBe('customers.customers');
    expect(clarificationSelectionInput(option, '   ').question).toBe('customers.customers');
  });

  it('UI-012 resubmits the original question while a semantic path option carries stable identity', () => {
    expect(clarificationSelectionInput({
      id: 'semantic-path:report_date:bcm_ccu_pc',
      label: 'Use Report Date via bcm_ccu_pc',
      question: 'Who are the top customers and what is their BCM this month?',
      kind: 'semantic_entity_path',
    })).toEqual({
      question: 'Who are the top customers and what is their BCM this month?',
      selectedEvidenceId: 'semantic-path:report_date:bcm_ccu_pc',
    });
  });

  it('says whether the warehouse ran the SQL, and carries the values its placeholders stand for', () => {
    const run = (payload: Record<string, unknown>) => ({
      id: 'run-1', question: 'q', artifacts: [{ id: 'a1', kind: 'answer', payload }],
    } as unknown as Parameters<typeof answerSqlEvidenceFromRun>[0]);
    expect(answerSqlEvidenceFromRun(run({
      sql: 'SELECT 1 WHERE d >= ? AND d < ?',
      sqlParams: ['2016-01-01', '2018-01-01'],
      result: { sql: 'SELECT 1 WHERE d >= ? AND d < ?', rows: [], columns: [] },
    }))).toEqual({ sql: 'SELECT 1 WHERE d >= ? AND d < ?', origin: 'executed', params: ['2016-01-01', '2018-01-01'] });
    expect(answerSqlEvidenceFromRun(run({ sql: 'SELECT bad', executionError: 'Binder Error' }))?.origin).toBe('failed');
    expect(answerSqlEvidenceFromRun(run({ proposedSql: 'SELECT 1' }))?.origin).toBe('proposed');
    expect(answerSqlEvidenceFromRun(run({ sql: 'SELECT 1' }))?.origin).toBe('compiled');
  });

  it("prefers the user's own question over an option's generated prose", () => {
    // The option's `question` is a reading plus a label ("The user wants a
    // ranking of the best players ... — Total points"). Submitting that as the
    // analytical question makes the next turn answer a sentence nobody asked.
    expect(clarificationSelectionInput({
      id: 'metric:total_points',
      label: 'Total points',
      question: 'The user wants a ranking of the best players, but "best" could mean several measures. — Total points',
      kind: 'vocabulary',
    }, 'Who are our best players?')).toEqual({
      question: 'Who are our best players?',
      selectedEvidenceId: 'metric:total_points',
    });
  });

  it('keeps the exact successful Ask baseline for an explicit Research-deeper run', () => {
    expect(researchSourceFromRun({
      id: 'run-answer-1',
      question: 'Show revenue by region',
      trustState: 'review_required',
      executionTarget: { target: 'connection', connectionName: 'reporting' },
      artifacts: [{
        id: 'answer-1',
        kind: 'answer',
        title: 'Answer',
        trustState: 'review_required',
        ref: 'regional_revenue',
        payload: {
          result: {
            columns: ['region', 'revenue'],
            rows: [{ region: 'West', revenue: 120 }],
            rowCount: 1,
            sql: 'SELECT region, SUM(revenue) AS revenue FROM analytics.orders GROUP BY region',
          },
          dqlArtifact: {
            kind: 'sql_block',
            name: 'regional_revenue',
            source: 'block "regional_revenue" {}',
            persistence: 'transient',
            trustState: 'review_required',
          },
        },
      }],
    } as any)).toMatchObject({
      runId: 'run-answer-1',
      executionTarget: { target: 'connection', connectionName: 'reporting' },
      sourceCertifiedBlock: 'regional_revenue',
      sql: 'SELECT region, SUM(revenue) AS revenue FROM analytics.orders GROUP BY region',
      result: {
        columns: ['region', 'revenue'],
        rows: [{ region: 'West', revenue: 120 }],
        rowCount: 1,
      },
    });
  });

  it('UI-010 does not expose failed grounding drafts as reusable answers', () => {
    const failedRun = {
      status: 'blocked',
      artifacts: [{
        id: 'draft-1',
        kind: 'dql_block_draft',
        title: 'Invalid draft',
        trustState: 'blocked',
        payload: {},
      }],
    } as Parameters<typeof isAgentRunPinnable>[0];
    expect(isAgentRunPinnable(failedRun)).toBe(false);

    const completedRun = {
      status: 'completed',
      artifacts: [{
        id: 'answer-1',
        kind: 'answer',
        title: 'Executed answer',
        trustState: 'review_required',
        payload: {},
      }],
    } as Parameters<typeof isAgentRunPinnable>[0];
    expect(isAgentRunPinnable(completedRun)).toBe(true);
  });

  it('shows a lightweight search → match → query activity trail instead of planning phases', () => {
    const event = (type: AgentRunEvent['type'], route?: AgentRunEvent['route']): AgentRunEvent => ({
      id: type,
      runId: 'run-1',
      type,
      at: '2026-07-18T00:00:00.000Z',
      message: type,
      route,
    });
    const searching = liveAgentActivityFor([event('run.started')]);
    expect(searching).toEqual([expect.objectContaining({ id: 'search', state: 'active' })]);

    const matched = liveAgentActivityFor([
      event('run.started'),
      event('route.decided', 'semantic_answer'),
    ]);
    expect(matched.map((item) => item.label)).toEqual([
      'Resolving governed evidence and business meaning',
      'Found a compatible semantic metric',
    ]);
    expect(matched[1]?.state).toBe('active');

    const querying = liveAgentActivityFor([
      event('run.started'),
      event('route.decided', 'semantic_answer'),
      event('executor.started', 'semantic_answer'),
    ]);
    expect(querying.at(-1)).toMatchObject({ id: 'execute', label: 'Running the semantic query', state: 'active' });
    expect(querying.some((item) => /plan|validate/i.test(item.label))).toBe(false);
  });

  it('shows durable background continuation instead of reconnecting when a view remounts', () => {
    expect(liveAgentActivityFor([], true)).toEqual([{
      id: 'background',
      label: 'Continuing this request in the background',
      state: 'active',
    }]);
  });

  it('finishes the transient activity trail by checking governed evidence', () => {
    const base = {
      runId: 'run-1',
      at: '2026-07-18T00:00:00.000Z',
      message: 'event',
      route: 'generated_answer' as const,
    };
    const activity = liveAgentActivityFor([
      { ...base, id: 'start', type: 'run.started' },
      { ...base, id: 'route', type: 'route.decided' },
      { ...base, id: 'execute', type: 'executor.started' },
      { ...base, id: 'verify', type: 'evaluation.recorded' },
    ]);
    expect(activity.at(-1)).toMatchObject({
      id: 'verify',
      label: 'Checking the result against governed evidence',
      state: 'active',
    });
    expect(activity.slice(0, -1).every((item) => item.state === 'complete')).toBe(true);
  });

  it('UI-003 progressively explains long SQL generation and its durable optimization path', () => {
    expect(longRunGuidanceFor(11, 'generated_answer')).toBeNull();
    expect(longRunGuidanceFor(15)).toMatchObject({ title: 'Still resolving the governed evidence' });
    expect(longRunGuidanceFor(15, 'generated_answer')?.title).toContain('Finishing');
    expect(longRunGuidanceFor(25, 'generated_answer')?.detail).toContain('stops at its deadline');
    expect(longRunGuidanceFor(25, 'research')?.title).toContain('Deep research');
  });

  it('UI-003 shows completed guidance only for long, non-certified reusable work', () => {
    expect(completedRunGuidanceFor(28, 'generated_answer', 'review_required', 0)?.detail).toContain('review it, then certify it');
    expect(completedRunGuidanceFor(28, 'generated_answer', 'certified', 0)).toBeNull();
    expect(completedRunGuidanceFor(8, 'generated_answer', 'review_required', 0)).toBeNull();
  });

  it('charts an arbitrary 3-column result whose names do not match the strict auto-detector', () => {
    const { config, chartable } = deriveResultChartConfig({
      columns: ['product_name', 'total_value', 'order_count'],
      rows: [
        { product_name: 'Widget', total_value: 100, order_count: 4 },
        { product_name: 'Gadget', total_value: 80, order_count: 2 },
      ],
      rowCount: 2,
    });
    expect(chartable).toBe(true);
    expect(config.chart).toBe('grouped-bar');
    expect(config.x).toBe('product_name');
    expect(config.y).toBe('total_value');
  });

  it('picks a line chart when the category column is time-like', () => {
    const { config, chartable } = deriveResultChartConfig({
      columns: ['month', 'revenue'],
      rows: [{ month: '2026-01', revenue: 10 }, { month: '2026-02', revenue: 20 }],
      rowCount: 2,
    });
    expect(chartable).toBe(true);
    expect(config.chart).toBe('line');
    expect(config.x).toBe('month');
  });

  it('uses a KPI for one returned aggregate instead of a bar chart', () => {
    const { config, chartable } = deriveResultChartConfig({
      columns: ['total_revenue'],
      rows: [{ total_revenue: 42000 }],
      rowCount: 1,
    });
    expect(chartable).toBe(true);
    expect(config.chart).toBe('kpi');
  });

  it('uses grouped bars for one category with multiple numeric measures', () => {
    const { config } = deriveResultChartConfig({
      columns: ['region', 'revenue', 'orders'],
      rows: [{ region: 'North', revenue: 420, orders: 23 }, { region: 'South', revenue: 390, orders: 18 }],
      rowCount: 2,
    });
    expect(config.chart).toBe('grouped-bar');
  });

  it('keeps a validated Sankey recommendation and its source/target/value bindings', () => {
    const { config, chartable } = deriveResultChartConfig(
      {
        columns: ['product_category', 'product_name', 'product_revenue'],
        rows: [
          { product_category: 'Beverage', product_name: 'Coffee', product_revenue: 1200 },
          { product_category: 'Beverage', product_name: 'Tea', product_revenue: 900 },
        ],
        rowCount: 2,
      },
      { chart: 'sankey', x: 'product_category', color: 'product_name', y: 'product_revenue', decisionSource: 'agent' },
    );
    expect(chartable).toBe(true);
    expect(config).toMatchObject({
      chart: 'sankey',
      x: 'product_category',
      color: 'product_name',
      y: 'product_revenue',
      decisionSource: 'agent',
    });
  });

  it('rejects Sankey when the result has no target dimension', () => {
    const { config } = deriveResultChartConfig(
      {
        columns: ['product_name', 'product_revenue'],
        rows: [{ product_name: 'Coffee', product_revenue: 1200 }],
        rowCount: 1,
      },
      { chart: 'sankey', decisionSource: 'agent' },
    );
    expect(config.chart).toBe('kpi');
  });

  it('uses a business label rather than an adjacent technical identifier for the chart axis', () => {
    const { config } = deriveResultChartConfig({
      columns: ['customer_id', 'customer_name', 'revenue'],
      rows: [{ customer_id: 'c_1', customer_name: 'Acme', revenue: 420 }],
      rowCount: 1,
    });
    expect(config.x).toBe('customer_name');
  });

  it('overrides an incompatible agent bar preference for a time series', () => {
    const { config } = deriveResultChartConfig(
      {
        columns: ['month', 'revenue'],
        rows: [{ month: '2026-01', revenue: 10 }, { month: '2026-02', revenue: 20 }],
        rowCount: 2,
      },
      { chart: 'bar', decisionSource: 'agent' },
    );
    expect(config.chart).toBe('line');
    expect(config.decisionSource).toBe('data');
  });

  it('is not chartable when there is no numeric column', () => {
    const { chartable } = deriveResultChartConfig({
      columns: ['status', 'owner'],
      rows: [{ status: 'open', owner: 'a' }, { status: 'closed', owner: 'b' }],
      rowCount: 2,
    });
    expect(chartable).toBe(false);
  });

  it('honors an authored chart config over the heuristic', () => {
    const { config } = deriveResultChartConfig(
      {
        columns: ['region', 'sales'],
        rows: [{ region: 'NA', sales: 5 }],
        rowCount: 1,
      },
      { chart: 'pie', x: 'region', y: 'sales', decisionSource: 'authored' },
    );
    expect(config.chart).toBe('pie');
  });

  it('treats a returned DQL artifact as the primary inspectable artifact', () => {
    const artifact = resolveArtifactDqlView({
      sqlPreview: 'SELECT date_trunc(\'month\', order_date) AS month, SUM(revenue) AS total_revenue FROM orders GROUP BY 1',
      dqlArtifact: {
        kind: 'semantic_block',
        name: 'monthly_revenue',
        sourcePath: 'semantic-layer/blocks/revenue/monthly_revenue.yaml',
        source: '  block "monthly_revenue" {\n    type = "semantic"\n    metric = "total_revenue"\n  }\n',
      },
    });

    expect(artifact).toMatchObject({
      kind: 'semantic_block',
      name: 'monthly_revenue',
      sourcePath: 'semantic-layer/blocks/revenue/monthly_revenue.yaml',
      source: '  block "monthly_revenue" {\n    type = "semantic"\n    metric = "total_revenue"\n  }\n',
    });
    expect(artifactSqlDisclosureLabel(Boolean(artifact))).toBe('View compiled SQL preview');
  });

  it('can resolve a nested research-run DQL artifact before falling back to SQL preview language', () => {
    const artifact = resolveArtifactDqlView({
      researchRun: {
        reviewedSql: 'SELECT 1',
        dqlArtifact: {
          kind: 'sql_block',
          name: 'product_supply_top_value',
          source: 'block "product_supply_top_value" {\n  status = "draft"\n}',
        },
      },
    });

    expect(artifact).toMatchObject({
      kind: 'sql_block',
      name: 'product_supply_top_value',
    });
    expect(artifactSqlDisclosureLabel(Boolean(artifact))).toBe('View compiled SQL preview');
  });

  it('labels SQL-only output as a preview instead of the default query artifact', () => {
    expect(resolveArtifactDqlView({ sql: 'SELECT 1' })).toBeUndefined();
    expect(artifactSqlDisclosureLabel(false)).toBe('View SQL preview');
  });

  it('EXP-002 does not claim an exploratory query ran when bounded execution failed', () => {
    expect(trustExplainer({
      trustState: 'review_required',
      artifacts: [{
        kind: 'answer',
        payload: {
          exploratoryCandidate: { kind: 'dbt_grounded_exploration' },
          executionError: 'ZLens could not parse the exploratory SQL.',
        },
      }],
    } as any)).toContain('bounded execution failed');
  });

  it('N3 labels an answer read from the App page by the tiles it read, never as AI-written SQL', () => {
    const fromApp = (trustState: string) => ({
      trustState,
      route: trustState === 'certified' ? 'certified_answer' : 'generated_answer',
      artifacts: [{ kind: 'answer', trustState, payload: { appView: { appId: 'nba', tiles: [] }, answer: 'James Harden is first.' } }],
    } as any);
    expect(trustExplainer(fromApp('review_required'))).toBe('Read from this App’s current results. A tile it read needs review: check its source before relying on it.');
    expect(trustExplainer(fromApp('review_required'))).not.toContain('AI-generated');
    expect(trustExplainer(fromApp('certified'))).toBe('Read from this App’s current results; every tile it read runs a certified source.');
    expect(askArtifactMeta(fromApp('review_required').artifacts[0], fromApp('review_required').artifacts[0].payload)).toContain('from this App · needs review');
  });

  it('EXP-002 describes an exploratory answer as executed only when result evidence exists', () => {
    expect(trustExplainer({
      trustState: 'review_required',
      artifacts: [{
        kind: 'answer',
        payload: {
          exploratoryCandidate: { kind: 'dbt_grounded_exploration' },
          result: { columns: ['customer_name'], rows: [{ customer_name: 'Melissa' }], rowCount: 1 },
        },
      }],
    } as any)).toContain('query and bounded join probes ran');
  });

  it('hands semantic and generated SQL artifacts to Block Studio but never duplicates a certified answer', () => {
    expect(artifactReadyPayloadFromRun({
      id: 'certified',
      question: 'revenue',
      route: 'certified_answer',
      artifacts: [{ kind: 'answer', payload: { sql: 'SELECT 1' } }],
    } as any)).toBeUndefined();

    expect(artifactReadyPayloadFromRun({
      id: 'semantic',
      question: 'revenue by region',
      artifacts: [{ kind: 'answer', payload: { dqlArtifact: { kind: 'semantic_block', name: 'revenue_by_region', source: 'block "revenue_by_region" {\n  type = "semantic"\n  metric = "revenue"\n}' } } }],
    } as any)).toMatchObject({ dqlArtifact: { kind: 'semantic_block', name: 'revenue_by_region' } });

    expect(artifactReadyPayloadFromRun({
      id: 'generated',
      question: 'unmatched analysis',
      executionTarget: { target: 'connection', connectionName: 'reporting' },
      artifacts: [{ kind: 'answer', payload: { sql: 'SELECT region, SUM(revenue) AS revenue FROM orders GROUP BY region' } }],
    } as any)).toMatchObject({
      sql: expect.stringContaining('SELECT region'),
      executionTarget: { target: 'connection', connectionName: 'reporting' },
    });

    expect(artifactReadyPayloadFromRun({
      id: 'block-run',
      question: 'build revenue and margin by region',
      status: 'needs_review',
      route: 'dql_block_draft',
      artifacts: [{
        kind: 'dql_block_draft',
        trustState: 'review_required',
        payload: {
          dqlArtifact: {
            kind: 'semantic_block',
            name: 'revenue_and_margin_by_region',
            source: 'block "revenue_and_margin_by_region" {\n  type = "semantic"\n  metrics = ["revenue", "margin"]\n  dimensions = ["region"]\n}',
          },
          sql: 'SELECT region, revenue, margin FROM semantic_result',
        },
      }],
    } as any)).toMatchObject({
      sourceRunId: 'block-run',
      dqlArtifact: {
        name: 'revenue_and_margin_by_region',
      },
    });

    expect(artifactReadyPayloadFromRun({
      id: 'blocked',
      question: 'failed analysis',
      status: 'blocked',
      route: 'generated_answer',
      artifacts: [{ kind: 'answer', payload: { sql: 'SELECT broken FROM missing_table' } }],
    } as any)).toBeUndefined();
  });

  it('describes the full executed result count even when only a row sample is present', () => {
    expect(askArtifactMeta({ kind: 'answer', trustState: 'certified' } as any, {
      result: {
        columns: ['customer_name', 'revenue'],
        rows: Array.from({ length: 8 }, (_, index) => ({ customer_name: `C${index}`, revenue: 10 - index })),
        rowCount: 10,
        executionTime: 2100,
      },
    })).toBe('Table · 10 rows · 2.1s · certified saved query');
  });

  it('keeps the exact certified-title result visibly certified instead of relabeling it as generated', () => {
    const run = {
      id: 'exact-certified-title',
      question: 'Top Customers by Revenue',
      route: 'certified_answer',
      status: 'completed',
      trustState: 'certified',
      routeDecision: {
        analyticalCascadeDecision: { selectedTier: 'certified', planFrozen: true },
      },
      artifacts: [{
        id: 'answer', kind: 'answer', trustState: 'certified',
        payload: { selectedConceptIds: ['revenue_operations::block::Top Customers by Revenue'] },
      }],
    } as any;
    expect(trustExplainer(run)).toBe('Answered from a certified saved query.');
    expect(askArtifactMeta(run.artifacts[0], run.artifacts[0].payload)).toContain('certified saved query');
  });

  it('AGT-005/UI-012 labels a frozen semantic compiler failure as compile, never connection or AI-generated', () => {
    const payload = {
      analyticalFailure: {
        code: 'COMPILATION_FAILED',
        phase: 'compilation',
      },
      semanticExecutionTrace: {
        adapter: 'metricflow-cli',
        status: 'failed',
        failure: {
          code: 'SEMANTIC_COMPILATION_FAILED',
          phase: 'compilation',
        },
      },
    };
    const run = { status: 'blocked', artifacts: [{ payload }] } as never;

    expect(askArtifactMeta({ kind: 'answer', trustState: 'blocked' } as never, payload))
      .toBe('Answer · semantic compilation failed');
    expect(askFailureOriginTyped(run)).toBe('compile');
    expect(askFailurePresentation.compile.hint).toContain('did not reach the warehouse');
    expect(askFailurePresentation.compile.hint).not.toContain('connection');
  });

  it('AGT-005/UI-012 preserves semantic compilation attribution from trace-only and V4 terminal receipts', () => {
    const traceOnlyPayload = {
      semanticExecutionTrace: {
        adapter: 'metricflow-cli',
        status: 'failed',
        failure: {
          code: 'SEMANTIC_COMPILATION_FAILED',
          phase: 'compilation',
        },
      },
    };
    const v4TerminalPayload = {
      diagnosticReceiptV4: {
        version: 4,
        terminalIncident: {
          code: 'COMPILATION_FAILED',
          boundary: 'semantic.compile',
        },
      },
    };

    for (const payload of [traceOnlyPayload, v4TerminalPayload]) {
      const run = { status: 'blocked', artifacts: [{ payload }] } as never;
      expect(askArtifactMeta({ kind: 'answer', trustState: 'blocked' } as never, payload))
        .toBe('Answer · semantic compilation failed');
      expect(askFailureOriginTyped(run)).toBe('compile');
    }
  });

  it('opens the technical inspector on DQL before SQL, lineage, or trust', () => {
    const artifact = {
      id: 'answer-1',
      kind: 'answer',
      title: 'Certified answer',
      trustState: 'certified',
      payload: {
        sql: 'SELECT 1',
        dqlArtifact: { kind: 'certified_block', name: 'top_customers', source: 'block "top_customers" {}' },
      },
    } as any;
    expect(preferredAskInspectorTab({ artifacts: [artifact] } as any, artifact)).toBe('dql');
  });

  it('keeps Visualization available when the backend merely recommends a table', () => {
    expect(inlineAskChartConfig({ result: { chartConfig: { chart: 'table' } } }, {
      columns: ['customer_name', 'revenue'],
      rows: [{ customer_name: 'A', revenue: 10 }, { customer_name: 'B', revenue: 8 }],
      rowCount: 2,
    })).toMatchObject({ chart: undefined, decisionSource: 'agent' });
  });

  it('UI-012 keeps a multi-metric table so no requested measure is hidden', () => {
    expect(inlineAskChartConfig({
      result: {
        chartConfig: {
          chart: 'table',
          decisionSource: 'data',
          metrics: ['revenue', 'refunds', 'gross_margin'],
        },
      },
    }, {
      columns: ['customer_name', 'revenue', 'refunds', 'gross_margin'],
      rows: [{ customer_name: 'Zoom', revenue: 1200, refunds: 100, gross_margin: 0.42 }],
      rowCount: 1,
    })).toMatchObject({
      chart: 'table',
      decisionSource: 'data',
      metrics: ['revenue', 'refunds', 'gross_margin'],
    });
  });

  it('sends the actual clarification question in client fallback history', () => {
    expect(agentRunHistoryFromItems([
      { kind: 'user', id: 'q1', text: 'Who are the top beverage customers?' },
      {
        kind: 'run',
        id: 'r1',
        run: {
          summary: 'Needs clarification before a governed answer can be produced.',
          answer: 'Rank by total beverage spend or by individual product?',
        } as any,
      },
    ])).toEqual([
      { role: 'user', text: 'Who are the top beverage customers?' },
      { role: 'assistant', text: 'Rank by total beverage spend or by individual product?' },
    ]);
  });

  it('does not feed a failed SQL turn into the following fallback prompt', () => {
    expect(agentRunHistoryFromItems([
      { kind: 'user', id: 'q1', text: 'Show revenue by source.' },
      {
        kind: 'run',
        id: 'r1',
        run: {
          status: 'blocked',
          summary: 'The warehouse rejected the query.',
          artifacts: [{ payload: { executionError: 'syntax error near source::' } }],
        } as any,
      },
      { kind: 'user', id: 'q2', text: 'Show total revenue.' },
    ])).toEqual([{ role: 'user', text: 'Show total revenue.' }]);
  });
});

describe('persisted conversation hydration', () => {
  it('preserves cancelled lifecycle truth and excludes it from fallback authority', () => {
    const items = threadItemsFromTurns([{
      id: 'turn_cancelled',
      threadId: 'thread_1',
      seq: 1,
      question: 'show revenue by region',
      answerSummary: 'Stopped by user.',
      route: 'sql_cell',
      trustLabel: 'not_applicable',
      runStatus: 'cancelled',
      stopReason: 'cancelled',
      createdAt: '2026-07-29T00:00:00.000Z',
    }]);
    const runItem = items.find((item) => item.kind === 'run');
    const run = runItem?.kind === 'run' ? runItem.run : undefined;
    expect(run).toMatchObject({
      route: 'sql_cell',
      status: 'cancelled',
      trustState: 'not_applicable',
      stopReason: 'cancelled',
      summary: 'Stopped by user.',
    });
    expect(run ? isAgentRunPinnable(run) : true).toBe(false);
    expect(agentRunHistoryFromItems(items)).toEqual([]);
  });

  it('preserves blocked lifecycle truth instead of fabricating a completed run', () => {
    const items = threadItemsFromTurns([{
      id: 'turn_blocked',
      threadId: 'thread_1',
      seq: 1,
      question: 'show restricted payroll',
      answerSummary: 'Access was denied.',
      route: 'blocked',
      trustLabel: 'blocked',
      runStatus: 'blocked',
      stopReason: 'blocked',
      createdAt: '2026-07-29T00:00:00.000Z',
    }]);
    const run = items.find((item) => item.kind === 'run');
    expect(run?.kind === 'run' ? run.run : undefined).toMatchObject({
      status: 'blocked',
      stopReason: 'blocked',
      trustState: 'blocked',
    });
  });

  it('preserves review-required lifecycle truth after reload', () => {
    const items = threadItemsFromTurns([{
      id: 'turn_review',
      threadId: 'thread_1',
      seq: 2,
      question: 'forecast next quarter',
      answerSummary: 'Generated forecast draft.',
      route: 'generated_answer',
      trustLabel: 'review_required',
      runStatus: 'needs_review',
      stopReason: 'human_review_required',
      createdAt: '2026-07-29T00:01:00.000Z',
    }]);
    const run = items.find((item) => item.kind === 'run');
    expect(run?.kind === 'run' ? run.run : undefined).toMatchObject({
      status: 'needs_review',
      stopReason: 'human_review_required',
      trustState: 'review_required',
    });
  });
});

describe('buildConversationContext', () => {
  it('carries prior result columns and low-cardinality dimension values for follow-ups', () => {
    const items: ConversationThreadItem[] = [
      { kind: 'user', id: 'u1', text: 'revenue by category' },
      {
        kind: 'run',
        id: 'r1',
        run: {
          id: 'run_1',
          question: 'Can you give me food vs drink revenue?',
          completedAt: '2026-07-03T00:00:01.000Z',
          artifacts: [{
            kind: 'answer',
            ref: 'food_vs_drink_revenue',
            payload: {
              sourceCertifiedBlock: 'food_vs_drink_revenue',
              reviewStatus: 'certified',
              certification: 'certified',
              route: { tier: 'certified_block', label: 'Answered from certified block food_vs_drink_revenue' },
              contextPack: {
                questionPlan: {
                  requestedShape: {
                    dimensions: ['category'],
                    measures: ['revenue'],
                    filters: ['last month'],
                    topN: { n: 2, scope: 'overall' },
                  },
                },
              },
              result: {
                columns: ['category', 'revenue'],
                rows: [
                  { category: 'Food', revenue: 240877 },
                  { category: 'Drink', revenue: 396567 },
                ],
              },
            },
          }],
          summary: 'Food and Drink revenue split.',
          answer: 'Certified answer from food_vs_drink_revenue.',
        },
      },
    ];

    expect(buildConversationContext(items)).toMatchObject({
      activeSurface: 'notebook',
      sourceAnswerId: 'run_1',
      sourceCertifiedBlock: 'food_vs_drink_revenue',
      sourceQuestion: 'Can you give me food vs drink revenue?',
      sourceAnswerSummary: 'Certified answer from food_vs_drink_revenue.',
      resultColumns: ['category', 'revenue'],
      resultDimensionValues: { category: ['Food', 'Drink'] },
      outputColumns: ['category', 'revenue'],
      requestedFilters: ['last month'],
      requestedDimensions: ['category'],
      priorLimit: 2,
      priorMeasures: ['revenue'],
      reviewStatus: 'certified',
      certification: 'certified',
    });
  });

  it('carries the prior DQL artifact for DQL-first follow-up grounding', () => {
    const items: ConversationThreadItem[] = [
      {
        kind: 'run',
        id: 'r1',
        run: {
          id: 'run_semantic',
          question: 'monthly revenue by channel',
          completedAt: '2026-07-03T00:00:01.000Z',
          artifacts: [{
            kind: 'answer',
            payload: {
              cascade: {
                terminalLane: 'semantic',
                routeTier: 'semantic_metric',
                label: 'Lane 2 semantic DQL artifact was terminal',
                artifactKind: 'semantic_block',
                outcome: {
                  lane: 'semantic',
                  routeTier: 'semantic_metric',
                  metrics: ['total_revenue'],
                  dimensions: ['channel'],
                  rowCount: 1,
                },
              },
              dqlArtifact: {
                kind: 'semantic_block',
                name: 'monthly_revenue_by_channel',
                sourcePath: 'semantic-layer/blocks/revenue/monthly_revenue_by_channel.yaml',
                source: 'block "monthly_revenue_by_channel" {\n  type = "semantic"\n  metric = "total_revenue"\n}',
                metrics: ['total_revenue'],
                dimensions: ['channel'],
                filters: [{ dimension: 'channel', operator: 'equals', values: ['Online'] }],
                timeDimension: { name: 'order_date', granularity: 'month' },
              },
              result: {
                columns: ['month', 'channel', 'total_revenue'],
                rows: [{ month: '2026-06-01', channel: 'Online', total_revenue: 1200 }],
                rowCount: 1,
              },
            },
          }],
          summary: 'Monthly revenue by channel.',
          answer: 'Online revenue was 1200.',
        },
      },
    ];

    expect(buildConversationContext(items)).toMatchObject({
      dqlArtifact: {
        kind: 'semantic_block',
        name: 'monthly_revenue_by_channel',
        metrics: ['total_revenue'],
        dimensions: ['channel'],
        filters: [{ dimension: 'channel', operator: 'equals', values: ['Online'] }],
        timeDimension: { name: 'order_date', granularity: 'month' },
      },
      cascade: {
        terminalLane: 'semantic',
        routeTier: 'semantic_metric',
        outcome: {
          lane: 'semantic',
          metrics: ['total_revenue'],
          dimensions: ['channel'],
        },
      },
      turns: [
        {
          id: 'run_semantic',
          dqlArtifact: {
            kind: 'semantic_block',
            source: expect.stringContaining('metric = "total_revenue"'),
          },
          cascade: {
            terminalLane: 'semantic',
            routeTier: 'semantic_metric',
          },
        },
      ],
    });
  });

  it('extracts result context from research-run previews for follow-ups', () => {
    const items: ConversationThreadItem[] = [
      {
        kind: 'run',
        id: 'r1',
        run: {
          id: 'run_products',
          question: 'Top products by revenue with product name, category, and revenue',
          completedAt: '2026-07-03T00:00:02.000Z',
          artifacts: [{
            kind: 'research_run',
            ref: 'nbr_123',
            payload: {
              researchRun: {
                resultPreview: {
                  columns: ['product_name', 'category', 'revenue', 'units'],
                  rows: [
                    { product_name: 'for richer or pourover', category: 'Drink', revenue: 100275, units: 14325 },
                    { product_name: 'vanilla ice', category: 'Drink', revenue: 84474, units: 14079 },
                  ],
                  rowCount: 10,
                },
              },
              resultPreview: {
                columns: ['product_name', 'category', 'revenue', 'units'],
                rows: [
                  { product_name: 'for richer or pourover', category: 'Drink', revenue: 100275, units: 14325 },
                ],
                rowCount: 10,
              },
            },
          }],
          summary: 'Top products by revenue.',
          answer: 'Revenue is concentrated in top drink products.',
        },
      },
    ];

    expect(buildConversationContext(items)).toMatchObject({
      sourceAnswerId: 'run_products',
      sourceQuestion: 'Top products by revenue with product name, category, and revenue',
      resultColumns: ['product_name', 'category', 'revenue', 'units'],
      resultDimensionValues: {
        product_name: ['for richer or pourover', 'vanilla ice'],
        category: ['Drink'],
      },
      priorMeasures: ['revenue', 'units'],
    });
  });

  it('builds a bounded structured turn history and marks the active analytical turn', () => {
    const items: ConversationThreadItem[] = [
      {
        kind: 'run',
        id: 'r1',
        run: {
          id: 'run_products',
          question: 'Top products by revenue',
          completedAt: '2026-07-03T00:00:01.000Z',
          artifacts: [{
            kind: 'answer',
            payload: {
              result: {
                columns: ['product_name', 'category', 'revenue'],
                rows: [{ product_name: 'for richer or pourover', category: 'Drink', revenue: 100275 }],
                rowCount: 10,
              },
            },
          }],
          summary: 'Top products by revenue.',
          answer: 'The top product is for richer or pourover.',
        },
      },
      {
        kind: 'run',
        id: 'r2',
        run: {
          id: 'run_customers',
          question: 'who are the customers for this product?',
          completedAt: '2026-07-03T00:00:02.000Z',
          artifacts: [{
            kind: 'answer',
            payload: {
              result: {
                columns: ['customer_name', 'product_name', 'revenue'],
                rows: [
                  { customer_name: 'Mr. Matthew Meyer', product_name: 'for richer or pourover', revenue: 70 },
                  { customer_name: 'Aaron Gardner', product_name: 'for richer or pourover', revenue: 63 },
                ],
                rowCount: 2,
              },
            },
          }],
          summary: 'Customers for the top product.',
          answer: 'Mr. Matthew Meyer and Aaron Gardner bought the product.',
        },
      },
    ];

    expect(buildConversationContext(items)).toMatchObject({
      conversationStateVersion: 1,
      activeTurnId: 'run_customers',
      activeTopic: 'who are the customers for this product?',
      resultDimensionValues: {
        customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
        product_name: ['for richer or pourover'],
      },
      turns: [
        {
          id: 'run_products',
          question: 'Top products by revenue',
          result: {
            columns: ['product_name', 'category', 'revenue'],
            dimensionValues: {
              product_name: ['for richer or pourover'],
              category: ['Drink'],
            },
          },
        },
        {
          id: 'run_customers',
          question: 'who are the customers for this product?',
          result: {
            columns: ['customer_name', 'product_name', 'revenue'],
            dimensionValues: {
              customer_name: ['Mr. Matthew Meyer', 'Aaron Gardner'],
              product_name: ['for richer or pourover'],
            },
          },
        },
      ],
    });
  });
});

describe('a refusal is still inspectable', () => {
  let hasContract: typeof UnifiedAgentRunPanelModule.hasAnalyticalInspectorContract;
  let contractOf: typeof UnifiedAgentRunPanelModule.analyticalInspectorContract;

  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./UnifiedAgentRunPanel');
    hasContract = module.hasAnalyticalInspectorContract;
    contractOf = module.analyticalInspectorContract;
  });

  it('opens "How it was answered" for a bare refusal with no analytical contract', () => {
    // Regression: these refusals rendered as a plain sentence with only Copy —
    // no DQL, no SQL, no "How it was answered" — so the user could not see why
    // the query stopped or carry it into a notebook to research.
    const groundingGap = {
      refusalCode: 'grounding_gap',
      answer: 'I could not compose a governed query for this from the available tables and metrics.',
    };
    expect(hasContract(groundingGap)).toBe(true);
    expect(contractOf(groundingGap)?.failure).toMatchObject({ stage: 'answer', code: 'grounding_gap' });

    const unretrievedTable = {
      refusalCode: 'ungrounded_table',
      refusalDetails: { message: 'It uses a table that was not part of the metadata retrieved for this question.' },
    };
    expect(hasContract(unretrievedTable)).toBe(true);
    expect(contractOf(unretrievedTable)?.failure).toMatchObject({ code: 'ungrounded_table' });

    // A raw execution error is a failure too, even outside the v2 lane.
    expect(hasContract({ executionError: 'Binder Error: column "revenu" not found' })).toBe(true);

    // A healthy answer is unchanged — no phantom failure section.
    expect(hasContract({ sql: 'select 1', result: { columns: [], rows: [] } })).toBe(false);
  });
});

/**
 * Every failure used to render as one grey paragraph, so a warehouse rejection,
 * a governance refusal and a DQL block-compile problem looked identical — and
 * the most common line, "could not compile its immutable analytical plan", is
 * the DEFAULT for anything unclassified. The card keys off the origin recorded
 * at the throw site.
 */
describe('failure card origin and detail', () => {
  let askFailureOrigin: typeof UnifiedAgentRunPanelModule.askFailureOrigin;
  let askFailureDetail: typeof UnifiedAgentRunPanelModule.askFailureDetail;
  let ASK_FAILURE_PRESENTATION: typeof UnifiedAgentRunPanelModule.ASK_FAILURE_PRESENTATION;

  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    const module = await import('./UnifiedAgentRunPanel');
    askFailureOrigin = module.askFailureOrigin;
    askFailureDetail = module.askFailureDetail;
    ASK_FAILURE_PRESENTATION = module.ASK_FAILURE_PRESENTATION;
  });

  function runWith(payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      id: 'r', question: 'q', summary: 'safe headline. real cause from summary',
      artifacts: [{ id: 'a', kind: 'answer', title: 'Answer', payload }],
      ...extra,
    } as never;
  }

  it('reads the origin recorded on the run', () => {
    for (const origin of ['warehouse', 'dql_compilation', 'governance_gate', 'retrieval_gap', 'provider', 'host']) {
      expect(askFailureOrigin(runWith({ warehouseFailure: { origin } }))).toBe(origin);
    }
  });

  it('a no-data outcome is headed neutrally, never as a modeling gap or a failed run', () => {
    expect(askFailureOrigin(runWith({ refusalCode: 'no_data' }))).toBe('no_data');
    expect(askFailureOrigin(runWith({ gap: { kind: 'not_retrieved', message: 'no rows fell inside 2026-01-01..2026-02-01' } }))).toBe('no_data');
    expect(askFailureOrigin(runWith({ refusalCode: 'modeling_gap', gap: { kind: 'not_modeled' } }))).toBe('modeling_gap');
    expect(ASK_FAILURE_PRESENTATION.no_data.title).toBe('No matching data');
    expect(ASK_FAILURE_PRESENTATION.no_data.title).not.toMatch(/could not|couldn/i);
  });

  it('recognizes provider failures even when an older run has no warehouse attribution', () => {
    expect(askFailureOrigin(runWith({ providerFailure: { code: 'AI_PROVIDER_FAILURE' } }))).toBe('provider');
    expect(askFailureOrigin(runWith({ refusalCode: 'provider_error' }))).toBe('provider');
    expect(askFailureOrigin(runWith({}, {
      diagnosticReceipt: { failure: { code: 'AI_PROVIDER_FAILURE', message: 'provider unavailable' } },
    }))).toBe('provider');
  });

  it('UI-012 presents a recorded SQL execution incident before a legacy grounding compatibility code', () => {
    const run = runWith({
      refusalCode: 'grounding_gap',
      executionError: 'connection reset by peer',
    }, {
      diagnosticReceiptV4: {
        version: 4,
        terminalIncident: {
          version: 1,
          code: 'ANALYTICAL_EXECUTION_FAILED',
          boundary: 'sql.execute',
          origin: 'warehouse',
          impact: 'execution_failed',
          safeAction: 'retry_same_plan',
        },
      },
    });

    expect(askFailureOrigin(run)).toBe('execution');
    expect(ASK_FAILURE_PRESENTATION.execution.title).toBe('The selected query did not complete');
    expect(ASK_FAILURE_PRESENTATION.execution.title).not.toMatch(/context|metadata/i);
    expect(askFailureOrigin(runWith({
      refusalCode: 'execution_error',
      executionError: 'connection reset by peer',
    }))).toBe('execution');
  });

  it('UI-012 keeps typed compilation and result validation out of the execution card', () => {
    const compilation = runWith({
      refusalCode: 'execution_error',
      executionError: 'adapter rejected the selected group-by item',
      analyticalFailure: { code: 'COMPILATION_FAILED', phase: 'compilation' },
    }, {
      diagnosticReceiptV4: {
        version: 4,
        terminalIncident: {
          version: 1,
          code: 'COMPILATION_FAILED',
          boundary: 'semantic.compile',
          origin: 'semantic_compiler',
          impact: 'execution_not_attempted',
          safeAction: 'edit_dql',
        },
      },
    });
    const resultValidation = runWith({
      refusalCode: 'execution_error',
      executionError: 'the returned columns were rejected',
      analyticalFailure: { code: 'RESULT_CONTRACT_MISMATCH', phase: 'result_validation' },
    }, {
      diagnosticReceiptV4: {
        version: 4,
        terminalIncident: {
          version: 1,
          code: 'RESULT_CONTRACT_MISMATCH',
          boundary: 'result.validate',
          origin: 'result_validator',
          impact: 'answer_not_produced',
          safeAction: 'inspect_failure',
        },
      },
    });
    const execution = runWith({
      refusalCode: 'grounding_gap',
      executionError: 'connection reset by peer',
      analyticalFailure: { code: 'EXECUTION_FAILED', phase: 'execution' },
    });

    expect(askFailureOrigin(compilation)).toBe('compile');
    expect(askFailureOrigin(resultValidation)).toBe('result_contract');
    expect(askFailureOrigin(execution)).toBe('execution');
    expect(ASK_FAILURE_PRESENTATION.compile.title).not.toMatch(/connection|query did not complete/i);
    expect(ASK_FAILURE_PRESENTATION.result_contract.title).not.toMatch(/connection|query did not complete/i);
  });

  it('UI-011 distinguishes an internal dispatch budget from a provider outage', () => {
    expect(askFailureOrigin(runWith({
      providerFailure: { code: 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED' },
      refusalCode: 'model_declined',
    }))).toBe('orchestration_budget');
    expect(askFailureOrigin(runWith({
      providerFailure: { code: 'orchestration_budget_exhausted' },
      refusalCode: 'orchestration_budget_exhausted',
    }))).toBe('orchestration_budget');
    expect(askFailureOrigin(runWith({}, {
      diagnosticReceipt: {
        failure: { code: 'orchestration_budget_exhausted', message: 'bounded orchestration exhausted' },
      },
    }))).toBe('orchestration_budget');
    expect(ASK_FAILURE_PRESENTATION.orchestration_budget.title).not.toMatch(/provider failed/i);
    expect(ASK_FAILURE_PRESENTATION.orchestration_budget.hint).not.toMatch(/settings/i);
  });

  it('keeps an unknown or missing origin unattributed', () => {
    expect(askFailureOrigin(runWith({}))).toBe('unknown');
    expect(askFailureOrigin(runWith({ warehouseFailure: { origin: 'not_a_real_origin' } }))).toBe('unknown');
  });

  it('gives every origin its own title and guidance', () => {
    const titles = Object.values(ASK_FAILURE_PRESENTATION).map((p) => p.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(Object.values(ASK_FAILURE_PRESENTATION).every((p) => p.hint.trim().length > 0)).toBe(true);
  });

  // A block-compile failure happens AFTER the query ran, so it must not read as
  // a query failure.
  it('does not describe a DQL block failure as a query failure', () => {
    const p = ASK_FAILURE_PRESENTATION.dql_compilation;
    expect(p.title).not.toMatch(/warehouse|rejected/i);
    expect(p.hint).toMatch(/query itself is fine/i);
  });

  it('prefers the producer message over the canned headline', () => {
    const detail = askFailureDetail(runWith({
      warehouseFailure: { origin: 'warehouse', redactedMessage: 'Binder Error: no such column: amt' },
    }, { diagnosticReceipt: { failure: { message: 'could not compile its immutable analytical plan' } } }));
    expect(detail).toBe('Binder Error: no such column: amt');
  });

  it('shows a typed missing relationship proof ahead of a generic blocked executor message', () => {
    const run = runWith({
      diagnosticReceiptV3: {
        version: 3,
        terminalGap: {
          version: 1,
          code: 'MISSING_RELATIONSHIP',
          requirement: 'certified_relationship_or_allocation_proof',
          witnessCandidateIds: ['semantic:relationship:competitor_to_account'],
        },
      },
      executionError: 'EXECUTION_BLOCKED',
    }, {
      diagnosticReceiptV3: {
        version: 3,
        terminalGap: {
          version: 1,
          code: 'MISSING_RELATIONSHIP',
          requirement: 'certified_relationship_or_allocation_proof',
          witnessCandidateIds: ['semantic:relationship:competitor_to_account'],
        },
      },
      summary: 'EXECUTION_BLOCKED',
    });

    expect(askFailureDetail(run)).toBe(
      'This Ask needs a certified relationship or approved allocation proof before it can run. ZLens did not infer a relationship or execute a query.',
    );
  });

  it('falls back through executionError, then summary', () => {
    expect(askFailureDetail(runWith({ executionError: 'exec blew up' }))).toBe('exec blew up');
    expect(askFailureDetail(runWith({}))).toBe('safe headline. real cause from summary');
  });

  it('UI-010/012 explains a legacy generic blocked run from its retained qualified bindings', () => {
    const run = runWith({
      resolvedAnalyticalPlan: {
        capability: 'blocked',
        query: {
          measures: [{ requested: 'case volume', status: 'resolved', candidateIds: ['semantic:support:metric:case_volume'] }],
          dimensions: [{
            requested: 'account',
            status: 'ambiguous',
            candidateIds: [
              'semantic:support:dimension:billing_account',
              'semantic:support:dimension:service_account',
            ],
          }],
          filters: [],
        },
      },
    }, {
      status: 'blocked',
      summary: 'Agent run is blocked.',
      diagnosticReceipt: { failure: { message: 'Agent run is blocked.' } },
    });

    expect(askFailureDetail(run)).toBe(
      'I found more than one governed dimension for “account”: Billing Account or Service Account. Choose one before I run the query.',
    );
    expect(askFailureDetail(run)).not.toBe('Agent run is blocked.');
  });

  it('AGT-027 carries a selected table cell as a stable result binding, not appended Regarding prose', async () => {
    const artifact = {
      id: 'answer:customers',
      kind: 'answer',
      title: 'Customers',
      trustState: 'governed',
      payload: {
        result: {
          columns: ['customer_name', 'revenue'],
          rows: [{ customer_name: 'Melissa Davis', revenue: 1411 }],
          rowCount: 1,
          resultFingerprint: 'a'.repeat(64),
        },
      },
    } as any;
    const run = { id: 'run:customers', artifacts: [artifact] } as any;
    const binding = await selectedResultBindingForSelection({
      selectedText: 'Melissa Davis', run, artifact,
    });
    expect(binding).toMatchObject({
      version: 1,
      sourceRunId: 'run:customers',
      sourceArtifactId: 'answer:customers',
      canonicalColumn: 'customer_name',
      value: 'Melissa Davis',
      resultFingerprint: 'a'.repeat(64),
    });
    expect(binding?.rowFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('AGT-040 explains a review-required semantic answer as an inferred grouping', () => {
    expect(trustExplainer({
      status: 'needs_review',
      stopReason: 'human_review_required',
      route: 'semantic_answer',
      trustState: 'review_required',
      artifacts: [],
    } as any)).toContain('inferred the semantic grouping');
  });
});

describe('submission identity in the thread', () => {
  const run = (id: string) => ({ id, question: 'top customers', route: 'generated_answer', status: 'completed', trustState: 'governed', events: [], steps: [], artifacts: [] } as unknown as Parameters<typeof mergeFinishedRun>[1]);
  it('pairs the answer with the question item of its submission, never with equal text', () => {
    const items = [
      { kind: 'user' as const, id: 'user_1', text: 'top customers' },
      { kind: 'run' as const, id: 'run_1', run: run('run_1') },
      { kind: 'user' as const, id: 'user_2', text: 'top customers' },
    ];
    const merged = mergeFinishedRun(items, run('run_2'), { question: 'top customers', userItemId: 'user_2' });
    expect(merged.map((item) => item.id)).toEqual(['user_1', 'run_1', 'user_2', 'run_2']);
  });
  it('restores the question under its submission id when a reload lost the local item', () => {
    const merged = mergeFinishedRun([], run('run_2'), { question: 'top customers', userItemId: 'user_2' });
    expect(merged.map((item) => item.id)).toEqual(['user_2', 'run_2']);
  });
  it('a pending record without a submission id falls back to the text match', () => {
    const merged = mergeFinishedRun([{ kind: 'user' as const, id: 'user_1', text: 'top customers' }], run('run_1'), { question: 'top customers' });
    expect(merged.map((item) => item.id)).toEqual(['user_1', 'run_1']);
  });
});

describe('the Ask pipeline receipt is the authority on call counts', () => {
  const receipt = {
    version: 1, vocabularyFingerprint: 'v', dispatches: [{ purpose: 'resolve', ms: 900 }, { purpose: 'intent:repair', ms: 700 }],
    candidates: [{ tier: 'semantic', trust: 'governed', proof: [] }], refusals: [{ tier: 'certified', code: 'no_certified_block', message: 'none', repairable: false }],
    tiers: [], executed: { tier: 'semantic', sqlFingerprint: 'f', rowCount: 3, ms: 12, proofs: [] }, timings: {},
  };
  it('counts dispatches, preparation and the execution from the receipt', () => {
    expect(pipelineV9Activity({ diagnosticReceiptV9: receipt })).toEqual({ providerDispatches: 2, toolCalls: 2, executionAttempts: 1, repairs: 1 });
    expect(pipelineV9Activity({})).toBeUndefined();
  });
  it('performance rows prefer the receipt over absent physical spans for a pipeline run', () => {
    const trace = {
      envelope: {
        version: 1, traceId: 'p'.repeat(32), rootSpanId: 'q'.repeat(16), runId: 'v9-counts', surface: 'browser', mode: 'ask',
        questionFingerprint: 'sha256:question', status: 'completed', recordingStatus: 'complete', startedAt: '2026-09-05T12:00:00.000Z', durationMs: 1600,
        spanCount: 0, candidateDecisionCount: 0, droppedRecordCount: 0,
      },
      spans: [],
      runtimeReceiptV9: receipt,
      runtimeMode: 'pipeline_v3' as const,
    } as unknown as Parameters<typeof agentRunPerformanceRows>[1];
    const run = { requestedMode: 'ask', providerEgressReceipts: [], askAgentRuntimeMode: 'pipeline_v3' } as unknown as Parameters<typeof agentRunPerformanceRows>[0];
    expect(agentRunPerformanceRows(run, trace)).toEqual(expect.arrayContaining([
      ['Calls', '2 provider · 2 tool · 1 SQL · 1 repair'],
      ['Trace evidence', 'Ask pipeline receipt (dispatch, preparation and execution counts)'],
      ['Ask runtime', 'Ask pipeline receipt'],
    ]));
  });
});

describe('the inspector plan of a pipeline run is its intent', () => {
  it('renders reading, measures with a ratio formula, grain, window, population, tiers and proofs from the V9 receipt', () => {
    const rows = Object.fromEntries(askPipelinePlanRows({
      version: 1, vocabularyFingerprint: 'v', reading: 'AOV in 2025',
      intent: {
        reading: 'Average order value in 2025', measures: [{ ref: 'ratio:metric:order_item.revenue/metric:orders.orders', derived: { kind: 'ratio', numerator: 'metric:order_item.revenue', denominator: 'metric:orders.orders' }, alias: 'aov' }, { ref: 'metric:orders.order_total', scope: [{ ref: 'dimension:orders.is_drink_order', op: 'is_true', values: [] }] }],
        groupBy: [{ ref: 'entity:locations.location', role: 'key' }], display: ['dimension:locations.location_name'], filters: [{ ref: 'dimension:customers.customer_name', op: 'eq', values: ['Jordan Lee'] }],
        time: { ref: 'dimension:orders.ordered_at', window: { start: '2025-01-01', end: '2026-01-01', expression: 'in 2025' } }, population: 'all', ordering: { ref: 'measure:0', direction: 'desc' }, limit: 5, unresolved: [], provenance: {},
      },
      dispatches: [], candidates: [{ tier: 'relational', trust: 'governed', proof: ['every member of dev.locations is a row'] }], refusals: [],
      tiers: [{ round: 0, tier: 'certified', outcome: 'refused', detail: 'no block' }, { round: 0, tier: 'semantic', outcome: 'refused' }, { round: 0, tier: 'relational', outcome: 'prepared' }],
      executed: { tier: 'relational', sqlFingerprint: 'sha256:abc', rowCount: 6, ms: 3, proofs: ['executed on the warehouse: 6 rows in 3 ms'] }, timings: {}, grounding: ['customer_name: "jordan lee" is stored as "Jordan Lee"'],
    }));
    expect(rows.Reading).toBe('Average order value in 2025');
    expect(rows.Measures).toBe('aov = metric:order_item.revenue / metric:orders.orders\nmetric:orders.order_total where dimension:orders.is_drink_order is_true');
    expect(rows['Group by']).toBe('entity:locations.location (key)');
    expect(rows.Filters).toBe('dimension:customers.customer_name eq Jordan Lee');
    expect(rows.Time).toBe('axis dimension:orders.ordered_at · window 2025-01-01 → 2026-01-01 ("in 2025")');
    expect(rows.Population).toBe('Every member of the grain (zero-filled)');
    expect(rows['Skills applied']).toBeUndefined(); // no ledger, no context rows
    const named = Object.fromEntries(askPipelinePlanRows({
      version: 1, intent: { reading: 'x', measures: [], groupBy: [], display: [], filters: [], unresolved: [], provenance: {} }, dispatches: [], candidates: [], refusals: [], tiers: [], timings: {},
      context: { rendered: { byKind: {}, charsByKind: {}, totalChars: 0, truncated: [], skills: ['skill:nba.player_reporting'], hints: ['hint_1'] }, enforced: { policies: [{ policyId: 'skill:nba.player_reporting', field: 'participated', effect: 'applied participated = true' }, { policyId: 'skill:nba.player_reporting', field: 'comparisonAlignment', effect: 'recorded (calendar_period); not yet applied to period scopes' }], requiredFilters: [], gaps: [] }, used: { joins: [{ source: 'warehouse_proof', authority: 'proven_default', scope: 'within_domain' }], relations: [] } },
    }));
    expect(named['Skills applied']).toBe('skill:nba.player_reporting');
    expect(named['Hints applied']).toBe('hint_1');
    expect(named['Policies enforced']).toBe('skill:nba.player_reporting · participated · applied participated = true');
    expect(named['Settings recorded, not enforced']).toBe('skill:nba.player_reporting · comparisonAlignment · recorded (calendar_period); not yet applied to period scopes');
    expect(named['Joins used']).toBe('warehouse_proof (proven_default, within_domain)');
    expect(rows.Ordering).toBe('measure:0 desc · limit 5');
    expect(rows['Tiers tried']).toBe('certified: refused — no block\nsemantic: refused\nrelational: prepared');
    expect(rows.Executed).toBe('relational · 6 row(s) · sha256:abc');
    expect(rows.Proofs).toBe('every member of dev.locations is a row\nexecuted on the warehouse: 6 rows in 3 ms');
    expect(rows.Grounding).toMatch(/stored as "Jordan Lee"/);
  });
});


describe('the story an Ask run tells while it works and keeps afterwards', () => {
  const event = (index: number, payload?: unknown): AgentRunEvent => ({ id: `e${index}`, runId: 'r', type: 'executor.started', at: '2026-09-11T00:00:00Z', message: `m${index}`, ...(payload ? { payload } : {}) });
  const stepEvent = (index: number, title: string, state = 'done') => event(index, { askStep: { version: 1, phase: 'tier', title, state, at: index, ms: 1200 } });

  it('reads the streamed steps in order and ignores events that are not steps', () => {
    const steps = askStoryStepsFromEvents([event(1), stepEvent(2, 'Searched the project: 4 tables'), stepEvent(3, 'Certified blocks: no answer', 'missed'), event(4, { other: true })]);
    expect(steps.map((entry) => [entry.title, entry.state])).toEqual([['Searched the project: 4 tables', 'done'], ['Certified blocks: no answer', 'missed']]);
  });

  it('keeps every step of a long run while trimming the other live events', () => {
    const events = [...Array.from({ length: 12 }, (_, index) => stepEvent(index, `step ${index}`)), ...Array.from({ length: 20 }, (_, index) => event(100 + index))];
    const kept = retainLiveAgentEvents(events);
    expect(askStoryStepsFromEvents(kept)).toHaveLength(12);
    expect(kept.filter((entry) => !(entry.payload as { askStep?: unknown } | undefined)?.askStep)).toHaveLength(8);
  });

  it('replays the kept story of a finished run from its receipt, and a receipt without one has none', () => {
    expect(askStoryStepsFromReceipt({ story: [{ version: 1, phase: 'execute', title: 'Ran the AI-drafted query: 1 row', state: 'done', at: 5, ms: 80 }] })[0]).toMatchObject({ title: 'Ran the AI-drafted query: 1 row', ms: 80 });
    expect(askStoryStepsFromReceipt({})).toEqual([]);
    expect(askStoryStepsFromReceipt(undefined)).toEqual([]);
  });

  it('renders each step with its outcome and time, and the step still in progress', () => {
    const markup = renderToStaticMarkup(createElement(AskStoryList, {
      t: themes.light,
      active: 'Working · 12 s',
      steps: [
        { phase: 'context', title: 'Searched the project: 19 tables', state: 'done', ms: 432, at: 1 },
        { phase: 'tier', title: 'Semantic layer: no answer', state: 'missed', detail: 'product_price is not a semantic metric', at: 2 },
        { phase: 'execute', title: 'The warehouse rejected the draft: correcting it once', state: 'failed', ms: 2_300, at: 3 },
      ],
    }));
    expect(markup).toContain('aria-label="What the agent did"');
    expect(markup).toContain('Searched the project: 19 tables');
    expect(markup).toContain('432 ms');
    expect(markup).toContain('Semantic layer: no answer');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('product_price is not a semantic metric');
    expect(markup).toContain('2.3 s');
    expect(markup).toContain('Working · 12 s');
  });

  it('a finished run shows one line that opens its story: how long, how many steps, how many places it looked and missed', () => {
    const markup = renderToStaticMarkup(createElement(AskRunStory, {
      t: themes.light,
      receipt: { timings: { total: 20_000, context: 400 }, story: [
        { version: 1, phase: 'read', title: 'Read the question', state: 'done', at: 1 },
        { version: 1, phase: 'tier', title: 'Certified blocks: no answer', state: 'missed', at: 2 },
        { version: 1, phase: 'execute', title: 'Ran the AI-drafted query: 3 rows', state: 'done', at: 3 },
      ] },
    }));
    expect(markup).toContain('Worked for 20 s · 3 steps · 1 looked and missed');
    expect(renderToStaticMarkup(createElement(AskRunStory, { t: themes.light, receipt: {} }))).toBe('');
  });

  it('names what the run is waiting on from the last step it finished', () => {
    const at = (phase: string, title: string, state: 'done' | 'missed' | 'failed' = 'done') => ({ phase, title, state, at: 1 });
    expect(askStoryActiveLabel([])).toBe('Searching the project');
    expect(askStoryActiveLabel([at('context', 'Searched the project: 19 tables')])).toBe('Asking the AI to read the question');
    expect(askStoryActiveLabel([at('read', 'Asked the AI to read the question')])).toBe('Checking the reading against the project');
    expect(askStoryActiveLabel([at('search', 'Fetched 4 fields the first reading had not seen')])).toBe('Asking the AI to read the question with those fields');
    expect(askStoryActiveLabel([at('read', 'Settled the reading')])).toBe('Looking for a certified saved query or semantic metric');
    expect(askStoryActiveLabel([at('schema', 'Asking the AI to write SQL from the tables')])).toBe('Asking the AI to draft SQL from the tables');
    expect(askStoryActiveLabel([at('schema', 'No governed answer: asking the tables directly')])).toBe('Asking the AI to draft SQL from the tables');
    expect(askStoryActiveLabel([at('schema', 'Chose the tables dev.products, dev.supplies')])).toBe('Asking the AI to draft SQL from the tables');
    expect(askStoryActiveLabel([at('schema', 'Drafted SQL over dev.products')])).toBe('Running the drafted query');
    expect(askStoryActiveLabel([at('search', 'Searched every table for the missing field: found crm.deal_notes')])).toBe('Asking the AI to draft SQL with those tables');
    expect(askStoryActiveLabel([at('execute', 'The warehouse rejected the draft: correcting it once', 'failed')])).toBe('Asking the AI to correct the query');
    expect(askStoryActiveLabel([at('tier', 'Governed tables and joins: prepared an answer')])).toBe('Running the query');
    expect(askStoryActiveLabel([at('execute', 'Ran the governed tables and joins query: 1 row')])).toBe('Writing the answer');
  });

  it('formats step timings the way a person reads them', () => {
    expect(formatStepDuration(20)).toBe('');
    expect(formatStepDuration(640)).toBe('640 ms');
    expect(formatStepDuration(2_340)).toBe('2.3 s');
    expect(formatStepDuration(27_400)).toBe('27 s');
    expect(formatStepDuration(95_000)).toBe('1 min 35 s');
  });
});
