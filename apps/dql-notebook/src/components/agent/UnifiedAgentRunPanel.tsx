import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HostAnswerActions } from './HostAnswerActions';
import { CitedDocuments, appliedListStyle, appliedTagStyle } from './CitedDocuments';
import { hostAllows, hostReader, hostRefusal, useHostPage, useHostUi } from '../../host/host-ui';
import { createPortal } from 'react-dom';
import { normalizeDqlArtifactReference } from '@zlens/core/artifacts';
import {
  ArrowRight,
  ArrowUp,
  Blocks,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code2,
  Copy,
  Database,
  FileSearch,
  Save,
  GitBranch,
  LayoutDashboard,
  Lightbulb,
  ListTree,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Minimize2,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import {
  api,
  DqlApiError,
  mintAgentRunSubmissionId,
  normalizeQueryResultPayload,
  type AgentConversationTurn,
  type AgentRun,
  type AgentRunStreamMessage,
  type CreateAgentRunInput,
  type AgentRunArtifact,
  type AgentRunAudience,
  type AgentRunClarificationOption,
  type AgentRunEvent,
  type AgentRunRequestedMode,
  type AgentRunRoute,
  type AgentRunSelectedObject,
  type AgentRunStatus,
  type AgentRunStep,
  type AgentRunStepStatus,
  type AgentRunStopReason,
  type AgentRunTrustState,
  type AnalyticalTaskOutcomeSummaryV1,
  type AnalyticalTaskOutcomeV1,
  type AskDecisionSummaryV1,
  type AskDecisionSummaryV2,
  type AskTraceDataV1,
  type AgentThinkingMode,
  type AgentSelectedResultBinding,
  type AppBuildProposal,
  type AppStudioBuildDraft,
  type MixedSourceNotebookPlan,
} from '../../api/client';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import { controlStyle } from '../../themes/control-tokens';
import { AskComposerOptions } from './AskComposerOptions';
import { ASK_NEEDS_AI_PROVIDER_HEADING, answerSourceOf, answerSourceOfPayload, answerTrustBadge, answerTrustHeading, askNeedsAiProvider } from './answer-trust';
import { StructuredAnswerText } from './AgentAnswerCard';
import { AppBuildProposalPanel, OPEN_IN_APP_STUDIO_LABEL, defaultProposalSelection, type AppBuildBriefEdits } from '../apps/AppBuildProposalPanel';
import { openAppProposalInStudio } from '../apps/app-studio-handoff';
import { ResultView } from '../output/ResultView';
import { DraftReviewCard } from '../blocks/DraftReviewCard';
import { SaveAsBlockModal } from '../modals/SaveAsBlockModal';
import { BlockParameterControls, isRuntimeEditableParameter } from '../parameters/BlockParameterControls';
export { deriveResultChartConfig } from '../output/ResultView';
import type { QueryResult, AppSummary, CellChartConfig, Cell, BlockParameterDefinition, ExecutionTarget } from '../../store/types';
import { useNotebook } from '../../store/NotebookStore';
import { projectExamplePrompts } from './project-prompts';
import { buildConversationContext } from './agentConversationContext';
import { describeJoin, explainAskRun, explanationForTrace, isAskPipelineReceipt, type RunExplanation } from './ask-run-explanation';
import { runContextLine, runContextSummary } from './run-context-summary';
import { AskRunChecks, AskRunDataUsed, AskRunFlow } from './AskRunFlow';
import { InvestigationFlow } from './InvestigationFlow';
import { InvestigationReport } from './InvestigationReport';
import { explainInvestigation, investigationActiveLabel, investigationReportOf, isInvestigationReceipt } from './investigation-view';
import type { AgentConversationDqlArtifact } from '../../llm/types';
import { addAskResultFilter, askArtifactStateKey, askResultFilterCandidates } from '../../utils/ask-runtime-parameters';

export type ThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'run'; id: string; run: AgentRun };

/** Must stay byte-for-byte aligned with the full Ask trace legacy notice. */
export const CANONICAL_DECISION_SUMMARY_UNAVAILABLE = 'Canonical decision summary unavailable for this older run';

/**
 * Research is an explicit workflow decision. Thinking depth remains an
 * independent request setting, so selecting high effort cannot accidentally
 * turn a normal Ask into a research run.
 */
export function resolveComposerRequestedMode(input: {
  initialMode: AgentRunRequestedMode;
  researchMode: boolean;
  modeOverride?: AgentRunRequestedMode;
  pendingMode?: AgentRunRequestedMode;
}): AgentRunRequestedMode {
  if (input.modeOverride) return input.modeOverride;
  if (input.pendingMode) return input.pendingMode;
  if (input.researchMode) return 'research';
  // A dedicated Research surface starts selected, but can intentionally be
  // changed back to ordinary Ask by its visible mode control.
  return input.initialMode === 'research' ? 'ask' : input.initialMode;
}

/** Replace only the failed presentation; the immutable source remains in the run store. */
export function replacePresentedAgentRun(items: ThreadItem[], sourceRunId: string, repairedRun: AgentRun): ThreadItem[] {
  return items.map((item) => item.kind === 'run' && item.run.id === sourceRunId
    ? { kind: 'run', id: repairedRun.id, run: repairedRun }
    : item);
}

/**
 * A surface may keep one durable thread while presenting only the turns that
 * still match its current server-reconstructed context. This is deliberately a
 * presentation boundary: no history is deleted, and callers opt in with an
 * artifact value written by the server rather than a browser trust claim.
 */
function runMatchesPresentationContext(run: AgentRun, contextKey: string): boolean {
  return run.artifacts.some((artifact) => {
    const payload = artifact.payload;
    return Boolean(payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && (payload as Record<string, unknown>).contextScope === contextKey);
  });
}

export function presentThreadItemsForContext(items: ThreadItem[], contextKey: string | undefined): ThreadItem[] {
  if (!contextKey) return items;
  const presented: ThreadItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === 'run') {
      if (runMatchesPresentationContext(item.run, contextKey)) presented.push(item);
      continue;
    }
    const next = items[index + 1];
    // Keep a new question while its matching server run is pending. Historic
    // orphaned user bubbles are not current context and remain in the durable
    // thread rather than being rendered as a new App Autopilot exchange.
    if (!next || (next.kind === 'run' && runMatchesPresentationContext(next.run, contextKey))) {
      presented.push(item);
    }
  }
  return presented;
}

/**
 * Build the compact client history used when a persisted server thread is not
 * available. Clarification turns must carry the actual question in `answer`;
 * the generic run summary ("Needs clarification...") cannot resolve a reply.
 */
export function agentRunHistoryFromItems(items: ThreadItem[]): Array<{ role: 'user' | 'assistant'; text: string }> {
  const history: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const item of items) {
    if (item.kind === 'user') {
      history.push({ role: 'user', text: item.text });
      continue;
    }
    const failed = item.run.status === 'blocked' || item.run.status === 'cancelled' || item.run.stopReason === 'cancelled' || item.run.artifacts?.some((artifact) => {
      const payload = payloadOf(artifact);
      return Boolean(payload.executionError || payload.warehouseFailure || payload.analyticalFailure);
    });
    if (failed) {
      // A failed turn cannot become fallback prompt authority. Remove its paired
      // user message too; the next submission already carries the new question.
      if (history.at(-1)?.role === 'user') history.pop();
      continue;
    }
    history.push({ role: 'assistant', text: acceptedAskAnswer(item.run)?.trim() || item.run.summary });
  }
  return history.slice(-12);
}

/**
 * An authoritative Ask card must render the persisted fact-bound envelope,
 * never a free-form executor answer that happened to share the run. Legacy
 * and conversational runs retain their historical presentation contract.
 */
export function acceptedAskAnswer(run: AgentRun): string | undefined {
  if (run.askAnalystState?.mode === 'authoritative' || run.diagnosticReceiptV5?.state) {
    return run.businessAnswer?.answer;
  }
  return run.answer;
}

/** A submitted run that may outlive this mounted panel (tab switch, reload, or navigation). */
export interface PendingAgentRun {
  id: string;
  question: string;
  threadId?: string;
  startedAt: string;
  /** The submission's Idempotency-Key, minted once per explicit submit. */
  submissionId?: string;
  /** The local question item this submission answers; the answer is paired by id, never by text. */
  userItemId?: string;
}

interface AgentBlockSave {
  runId: string;
  source: string;
  name: string;
  dqlArtifact?: AgentConversationDqlArtifact;
}

const ACTIVE_RUNS_STORAGE_KEY = 'dql.agent.active-runs.v1';

/** An empty-state suggestion chip: the label is shown, the prompt is submitted. */
export type ExamplePrompt = { label: string; prompt: string };

export interface SqlNotebookDraftMeta {
  question?: string;
  sourceRunId?: string;
}

interface UnifiedAgentRunPanelProps {
  themeMode: ThemeMode;
  title?: string;
  scopeHint?: string;
  /** A control that replaces the scope chip above the composer (Ask home's scope picker). */
  scopeControl?: React.ReactNode;
  /** Change the Ask scope from an answer ("Scope Ask to Commerce", "Clear scope"). */
  onScopeChange?: (scope: { domain: string; modelAreaId?: string; purpose?: string } | undefined) => void;
  /** Surface-specific composer guidance for authoring modes. */
  composerPlaceholder?: string;
  onClearScope?: () => void;
  /** Override the empty-state suggestion chips so a surface can offer tailored prompts. */
  examplePrompts?: ExamplePrompt[];
  /** Override the empty-state hint line above the suggestion chips. */
  emptyHint?: string;
  notebookPath?: string;
  selectedObject?: AgentRunSelectedObject;
  workspaceContext?: Record<string, unknown>;
  /**
   * Optional server-issued artifact context key for surfaces that retain one
   * durable thread while showing only the current contextual exchange.
   */
  presentationContextKey?: string;
  initialMode?: AgentRunRequestedMode;
  initialInput?: string;
  /** Seed the thread (for resuming a saved conversation). */
  initialItems?: ThreadItem[];
  /** Fires whenever the thread changes, so a host can persist the conversation. */
  onItemsChange?: (items: ThreadItem[]) => void;
  /**
   * Resume a server-persisted conversation thread (read at mount). Prior turns
   * hydrate the panel unless `initialItems` already seeded it. Without one, the
   * panel creates a thread on the first question and reports it via
   * `onThreadIdChange`.
   */
  threadId?: string;
  /** Fires when the panel creates a server thread, so a host can persist the id. */
  onThreadIdChange?: (id: string) => void;
  /** 'stakeholder' (consumption-only) hides authoring modes + adds the certify handoff. */
  audience?: AgentRunAudience;
  autoRun?: { text: string; mode?: AgentRunRequestedMode; nonce: number };
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  /**
   * DQL-first insertion: the whole governed artifact (compiled SQL body + DQL
   * provenance + executed result + chart config) so the host can create a
   * self-contained, ready-rendered query cell. Preferred over onInsertSql when set.
   */
  onInsertDql?: (payload: InsertDqlPayload) => void;
  /** Replace the host-selected notebook cell after an explicit user action. */
  onReplaceDql?: (payload: InsertDqlPayload) => void;
  /**
   * Optional host handoff for authoring surfaces. Fires once when a completed
   * non-certified run produces a new DQL/SQL artifact, allowing the host to
   * populate an unsaved editor without changing the agent engine or RunCard.
   */
  onArtifactReady?: (payload: InsertDqlPayload, run: AgentRun) => void;
  /** Explicit handoff for immutable Modeling/Skills authoring proposals. */
  onReviewAuthoringProposal?: (artifact: AgentRun['artifacts'][number], run: AgentRun) => void;
  /**
   * Explicit handoff for an App Autopilot review artifact. The shared AgentRun
   * owns the conversation and lifecycle; the App host owns the one guarded
   * local-draft Apply control.
   */
  onReviewAppAutopilotChange?: (artifact: AgentRun['artifacts'][number], run: AgentRun) => void;
  /** Focus the host's explicit Dataset-tile picker after a bounded App refusal. */
  onSelectAppAutopilotTile?: () => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string, sourceAskRunId?: string) => void;
  /** Navigate into an app/dashboard (used by the "Added to app" success link). */
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
  /** Reports whether a run is in flight, so a host can avoid unmounting mid-run. */
  onRunningChange?: (running: boolean) => void;
  /** Use Ask's answer-first narrative/result card inside a compact authoring panel. */
  answerFirstCards?: boolean;
  /** Add a contextual DQL insertion action to an answer-first card. */
  insertDqlActionLabel?: string;
  /** Add a second explicit action for replacing the selected notebook cell. */
  replaceDqlActionLabel?: string;
  /**
   * Opt into the redesigned "Ask" experience: a wide chat column with a page
   * header, centered 720px transcript of plain-text answers + trust lines +
   * artifact chips, a right-hand inspector that opens on chip click, and
   * select-to-follow-up. Off by default so embedded surfaces (Block Studio Ask,
   * dashboard copilot, notebook chat) keep the compact panel unchanged.
   */
  askLayout?: boolean;
}

/** Payload for DQL-first cell insertion from a governed answer artifact. */
export interface InsertDqlPayload {
  sql?: string;
  dqlArtifact?: AgentConversationDqlArtifact;
  result?: QueryResult;
  chartConfig?: CellChartConfig;
  title?: string;
  mixedSourcePlan?: MixedSourceNotebookPlan;
  /** Canonical run identity used for stable explicit draft commits. */
  sourceRunId?: string;
  /** The question this artifact answered, so an authoring host can recompose it. */
  question?: string;
  /** Preserve the exact Ask execution target when the artifact moves to Notebook. */
  executionTarget?: Cell['executionTarget'];
}

const ROUTE_LABEL: Record<AgentRunRoute, string> = {
  conversation: 'Chat',
  certified_answer: 'Certified answer',
  semantic_answer: 'Governed semantic answer',
  generated_answer: 'Generated answer',
  research: 'Research plan',
  sql_cell: 'SQL cell',
  dql_block_draft: 'Saved query draft',
  modeling_draft: 'Modeling proposal',
  skill_draft: 'Skill proposal',
  app_build: 'App plan',
  clarify: 'Clarify',
  cancelled: 'Stopped by user',
  blocked: 'Blocked',
};

export function UnifiedAgentRunPanel({
  themeMode,
  title = 'AI Copilot',
  scopeHint = 'Auto routes to answer, research, SQL, saved query, or app',
  composerPlaceholder = 'Ask anything about your data…',
  onClearScope,
  scopeControl,
  onScopeChange,
  examplePrompts,
  emptyHint,
  notebookPath,
  selectedObject,
  workspaceContext,
  presentationContextKey,
  initialMode = 'auto',
  initialInput = '',
  initialItems,
  onItemsChange,
  threadId: threadIdProp,
  onThreadIdChange,
  audience = 'analyst',
  autoRun,
  onInsertSql,
  onInsertDql,
  onReplaceDql,
  onArtifactReady,
  onReviewAuthoringProposal,
  onReviewAppAutopilotChange,
  onSelectAppAutopilotTile,
  onOpenBlock,
  onOpenResearch,
  onOpenApp,
  onRunningChange,
  answerFirstCards = false,
  insertDqlActionLabel,
  replaceDqlActionLabel,
  askLayout = false,
}: UnifiedAgentRunPanelProps): JSX.Element {
  const { state: notebookState, dispatch: notebookDispatch } = useNotebook();
  // With a host: a person who may not ask is not offered the box (the host says why and where to ask for it), and a
  // reader's screen says what answers are built on in plain words.
  const hostUi = useHostUi();
  const hostPage = useHostPage();
  const askRefusal = hostRefusal(hostUi, 'ask');
  const reader = hostReader(hostUi);
  // An empty Ask suggests questions this project's own metrics can answer. Ask
  // opened directly (a link, a reader's only page) has not loaded the semantic
  // layer yet: load it once here; a failure just keeps the general examples.
  const semanticRequested = useRef(false);
  useEffect(() => {
    if (semanticRequested.current || notebookState.semanticLayer.loading || (notebookState.semanticLayer.metrics ?? []).length) return undefined;
    semanticRequested.current = true;
    // The store outlives this panel, so the answer is kept even after it closes.
    void Promise.resolve()
      .then(() => api.getSemanticLayer())
      .then((layer) => notebookDispatch({ type: 'SET_SEMANTIC_LAYER', layer }))
      .catch(() => undefined);
    return undefined;
  }, [notebookDispatch, notebookState.semanticLayer.loading, notebookState.semanticLayer.metrics]);
  const projectPrompts = useMemo(
    () => projectExamplePrompts(notebookState.semanticLayer.metrics ?? [], notebookState.semanticLayer.dimensions ?? [], notebookState.semanticLayer.timeDimensions ?? []),
    [notebookState.semanticLayer.metrics, notebookState.semanticLayer.dimensions, notebookState.semanticLayer.timeDimensions],
  );
  const t = themes[themeMode];
  // One clean composer everywhere: an auto-routed box — no mode chips. Capability
  // still varies server-side by `audience` (analyst keeps the
  // authoring routes so SQL/blocks generate; stakeholder is consumption-only), but
  // the chrome is uniform. A next-action can pre-route the *next* question (e.g.
  // "Draft this as a block") via this one-shot ref: consumed once at submit and cleared
  // the moment the user edits the prefilled prompt. The default is always auto.
  const pendingModeRef = useRef<AgentRunRequestedMode | undefined>(undefined);
  const [input, setInput] = useState(initialInput);
  const [items, setItems] = useState<ThreadItem[]>(initialItems ?? []);
  const [runningEvents, setRunningEvents] = useState<AgentRunEvent[]>([]);
  const [streamingAnswer, setStreamingAnswer] = useState('');
  const [running, setRunning] = useState(false);
  const [backgroundRun, setBackgroundRun] = useState<PendingAgentRun | null>(null);
  const [blockToSave, setBlockToSave] = useState<AgentBlockSave | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The composer "thinking" selection, sticky across refreshes. `auto` defers to
  // the engine's shape-adaptive routing; the user can change it mid-conversation.
  const [thinkingMode, setThinkingMode] = useState<AgentThinkingMode>(() => readStoredThinkingMode());
  const [researchMode, setResearchMode] = useState(initialMode === 'research');
  const [researchResultRowsOptIn, setResearchResultRowsOptIn] = useState(false);
  // The connection Ask runs on: the notebook's own, else the project default. It is not a composer choice.
  const [executionConnectionName, setExecutionConnectionName] = useState<string>();
  const changeThinkingMode = useCallback((mode: AgentThinkingMode) => {
    setThinkingMode(mode);
    try { window.localStorage.setItem(THINKING_MODE_STORAGE_KEY, mode); } catch { /* best-effort */ }
  }, []);
  const changeResearchMode = useCallback((enabled: boolean) => {
    setResearchMode(enabled);
    // Result rows are a one-run consent under Research only. Never retain it
    // after the reader returns to Ask.
    if (!enabled) setResearchResultRowsOptIn(false);
  }, []);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInitialInputRef = useRef(initialInput);
  const lastAutoRunNonceRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const pendingRunRef = useRef<PendingAgentRun | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryEpochRef = useRef(0);
  const streamingDeltaBufferRef = useRef('');
  const streamingFrameRef = useRef<number | null>(null);
  const resetStreamingAnswer = useCallback(() => {
    streamingDeltaBufferRef.current = '';
    if (streamingFrameRef.current !== null) {
      window.cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
    setStreamingAnswer('');
  }, []);
  const appendStreamingDelta = useCallback((delta: string) => {
    streamingDeltaBufferRef.current += delta;
    if (streamingFrameRef.current !== null) return;
    streamingFrameRef.current = window.requestAnimationFrame(() => {
      streamingFrameRef.current = null;
      const buffered = streamingDeltaBufferRef.current;
      streamingDeltaBufferRef.current = '';
      if (buffered) setStreamingAnswer((current) => current + buffered);
    });
  }, []);
  useEffect(() => () => {
    if (streamingFrameRef.current !== null) window.cancelAnimationFrame(streamingFrameRef.current);
  }, []);
  const contextualExecutionTarget = workspaceContext?.executionTarget;
  const contextualExecutionConnectionName = contextualExecutionTarget
    && typeof contextualExecutionTarget === 'object'
    && !Array.isArray(contextualExecutionTarget)
    && (contextualExecutionTarget as Record<string, unknown>).target === 'connection'
    && typeof (contextualExecutionTarget as Record<string, unknown>).connectionName === 'string'
    ? String((contextualExecutionTarget as Record<string, unknown>).connectionName)
    : undefined;
  // A notebook working against imported datasets runs on the LOCAL DuckDB
  // workspace. Ask could only ever emit `{target:'connection'}`, so it sent the
  // same question to the default warehouse — where those dataset tables do not
  // exist — and refused a query the notebook beside it runs happily.
  const contextualLocalTarget = contextualExecutionTarget
    && typeof contextualExecutionTarget === 'object'
    && !Array.isArray(contextualExecutionTarget)
    && (contextualExecutionTarget as Record<string, unknown>).target === 'local';

  useEffect(() => {
    let cancelled = false;
    void api.getConnections()
      .then((info) => {
        if (cancelled) return;
        const names = Object.keys(info.connections ?? {}).sort((left, right) => left.localeCompare(right));
        setExecutionConnectionName(selectAgentExecutionConnection(
          names,
          info.default,
          contextualExecutionConnectionName,
        ));
      })
      .catch(() => {
        if (!cancelled) setExecutionConnectionName(undefined);
      });
    return () => { cancelled = true; };
  }, [contextualExecutionConnectionName]);

  // The composer grows with what is typed, up to a few lines, and shrinks back after sending.
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [input]);

  // ── Ask redesign (askLayout) state ────────────────────────────────────────
  // Which artifact is open in the right inspector, and its active tab. Null =
  // inspector closed. Keyed by run+artifact id so it survives new turns.
  const [inspector, setInspector] = useState<{ runId: string; artifactId: string; tab: AskInspectorTab } | null>(null);
  // Select-to-follow-up popover, anchored at a text selection inside a
  // [data-followup] zone (answer text or the inspector result table).
  const [pop, setPop] = useState<{
    text: string;
    source: 'answer' | 'table';
    left: number;
    top: number;
    selectedResultBinding?: AgentSelectedResultBinding;
  } | null>(null);
  const [popDraft, setPopDraft] = useState('');
  const popInputRef = useRef<HTMLInputElement>(null);
  const askScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Do not leave an inspector pointed at a turn which a surface has just
    // marked historical by changing its presentation context.
    setInspector(null);
  }, [presentationContextKey]);

  useEffect(() => {
    if (!initialInput || running) return;
    if (initialInput === lastInitialInputRef.current) return;
    lastInitialInputRef.current = initialInput;
    setInput(initialInput);
  }, [initialInput, running]);

  const presentedItems = useMemo(
    () => presentThreadItemsForContext(items, presentationContextKey),
    [items, presentationContextKey],
  );
  const history = useMemo(() => agentRunHistoryFromItems(presentedItems), [presentedItems]);

  // FOLLOW THE LATEST TURN. A new question, and then its answer, are brought
  // into view (the question at the top, its answer below it). A reader who
  // has scrolled up to an earlier turn is left where they are when an answer
  // arrives; asking again always brings the new turn into view.
  const railScrollRef = useRef<HTMLDivElement | null>(null);
  const followTurnRef = useRef<FollowLatestTurnState>({ previousCount: 0, readingEarlier: false });
  useLayoutEffect(() => {
    const container = askLayout ? askScrollRef.current : railScrollRef.current;
    const latestUserTurn = [...presentedItems].reverse().find((item) => item.kind === 'user');
    const state = followTurnRef.current;
    const action = followLatestTurnAction(state, { latestUserTurnId: latestUserTurn?.id, count: presentedItems.length });
    state.previousUserTurnId = latestUserTurn?.id;
    state.previousCount = presentedItems.length;
    if (action !== 'scroll' || !container) return;
    const bubble = latestUserTurnElement(container);
    if (!bubble) return;
    container.scrollTop += bubble.getBoundingClientRect().top - container.getBoundingClientRect().top - 12;
    state.readingEarlier = false;
  }, [askLayout, presentedItems]);
  const onThreadScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const bubble = latestUserTurnElement(container);
    followTurnRef.current.readingEarlier = Boolean(bubble)
      && bubble!.getBoundingClientRect().top > container.getBoundingClientRect().bottom;
  }, []);

  // Report thread changes to a host (for conversation persistence) without
  // re-subscribing when the callback identity changes each render.
  const onItemsChangeRef = useRef(onItemsChange);
  onItemsChangeRef.current = onItemsChange;
  const onArtifactReadyRef = useRef(onArtifactReady);
  onArtifactReadyRef.current = onArtifactReady;
  const onReviewAppAutopilotChangeRef = useRef(onReviewAppAutopilotChange);
  onReviewAppAutopilotChangeRef.current = onReviewAppAutopilotChange;
  const onSelectAppAutopilotTileRef = useRef(onSelectAppAutopilotTile);
  onSelectAppAutopilotTileRef.current = onSelectAppAutopilotTile;
  const deliveredAppAutopilotArtifactsRef = useRef(new Set<string>());
  useEffect(() => {
    onItemsChangeRef.current?.(items);
  }, [items]);
  useEffect(() => {
    const callback = onReviewAppAutopilotChangeRef.current;
    if (!callback) return;
    for (const item of presentedItems) {
      if (item.kind !== 'run') continue;
      const artifact = item.run.artifacts.find((candidate) => candidate.kind === 'app_autopilot_change');
      if (!artifact) continue;
      const key = `${item.run.id}:${artifact.id}`;
      if (deliveredAppAutopilotArtifactsRef.current.has(key)) continue;
      deliveredAppAutopilotArtifactsRef.current.add(key);
      callback(artifact, item.run);
    }
  }, [presentedItems]);

  // Server-side conversation thread: created lazily on the first question (unless
  // the host passed one), then sent with every run so the server injects prior
  // turns and persists new ones. Kept in a ref so submit closures always see the
  // latest id; thread failures degrade to the client-built conversation context.
  const threadIdRef = useRef<string | undefined>(threadIdProp);
  const onThreadIdChangeRef = useRef(onThreadIdChange);
  onThreadIdChangeRef.current = onThreadIdChange;

  const appendFinishedRun = useCallback((run: AgentRun, pending: PendingAgentRun) => {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    clearActiveAgentRun(run.id);
    clearActiveAgentRun(pending.id);
    clearSubmissionInput(pending.submissionId);
    if (activeRunIdRef.current === run.id) activeRunIdRef.current = null;
    pendingRunRef.current = null;
    setBackgroundRun(null);
    setRunningEvents(retainLiveAgentEvents(run.events));
    resetStreamingAnswer();
    setItems((current) => mergeFinishedRun(current, run, pending));
    if (run.route !== 'certified_answer') {
      const ready = artifactReadyPayloadFromRun(run);
      if (ready) onArtifactReadyRef.current?.(ready, run);
    }
  }, [resetStreamingAnswer]);

  const adoptRepairedRun = useCallback((sourceRunId: string, repairedRun: AgentRun) => {
    setItems((current) => replacePresentedAgentRun(current, sourceRunId, repairedRun));
    setInspector((current) => {
      if (!current || current.runId !== sourceRunId) return current;
      const artifact = repairedRun.artifacts[0];
      return artifact ? { runId: repairedRun.id, artifactId: artifact.id, tab: current.tab } : null;
    });
    setError(null);
    const ready = artifactReadyPayloadFromRun(repairedRun);
    if (ready) onArtifactReadyRef.current?.(ready, repairedRun);
  }, []);

  const recoverPendingRun = useCallback((pending: PendingAgentRun) => {
    if (recoveryTimerRef.current !== null) window.clearTimeout(recoveryTimerRef.current);
    if (isProvisionalAgentRunId(pending.id)) {
      // The server never told this tab which run it started (a reload landed
      // between submit and `accepted`). Re-send the identical request under
      // the same Idempotency-Key: the runtime attaches to the run that claim
      // started, or starts it now if the first attempt never arrived. Without
      // the stored request there is nothing safe to resend.
      const input = pending.submissionId ? readSubmissionInput(pending.submissionId) : undefined;
      if (!input) {
        clearActiveAgentRun(pending.id);
        clearSubmissionInput(pending.submissionId);
        return undefined;
      }
      const recoveryEpoch = ++recoveryEpochRef.current;
      let current = pending;
      activeRunIdRef.current = null;
      pendingRunRef.current = current;
      setBackgroundRun(current);
      setRunning(true);
      resetStreamingAnswer();
      setRunningEvents([]);
      const controller = new AbortController();
      abortRef.current = controller;
      let accepted = false;
      void api.createAgentRunStream(input, (message) => {
        if (message.kind === 'accepted') {
          const previousPendingId = current.id;
          current = { ...current, id: message.runId };
          activeRunIdRef.current = message.runId;
          pendingRunRef.current = current;
          setBackgroundRun(current);
          clearActiveAgentRun(previousPendingId);
          saveActiveAgentRun(current);
          accepted = true;
        } else if (message.kind === 'event') {
          setRunningEvents((existing) => retainLiveAgentEvents([...existing, message.event]));
        } else if (message.kind === 'answer-delta') {
          appendStreamingDelta(message.delta);
        } else {
          setRunningEvents(retainLiveAgentEvents(message.run.events));
        }
      }, controller.signal).then((run) => {
        if (recoveryEpoch !== recoveryEpochRef.current) return;
        if (current.id !== run.id) {
          clearActiveAgentRun(current.id);
          current = { ...current, id: run.id };
        }
        appendFinishedRun(run, current);
        setRunning(false);
      }).catch((error: unknown) => {
        if (controller.signal.aborted || recoveryEpoch !== recoveryEpochRef.current) return;
        if (accepted) {
          recoverPendingRun(current);
          return;
        }
        clearActiveAgentRun(current.id);
        clearSubmissionInput(current.submissionId);
        pendingRunRef.current = null;
        setBackgroundRun(null);
        setRunning(false);
        setError(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
      });
      return () => {
        if (recoveryEpoch === recoveryEpochRef.current) recoveryEpochRef.current += 1;
      };
    }
    const recoveryEpoch = ++recoveryEpochRef.current;
    activeRunIdRef.current = pending.id;
    pendingRunRef.current = pending;
    setBackgroundRun(pending);
    setRunning(true);
    resetStreamingAnswer();
    setRunningEvents([]);

    const check = async () => {
      if (recoveryEpoch !== recoveryEpochRef.current || activeRunIdRef.current !== pending.id) return;
      try {
        const state = await api.getAgentRunState(pending.id);
        if (recoveryEpoch !== recoveryEpochRef.current || activeRunIdRef.current !== pending.id) return;
        if (state.lifecycleState === 'terminal') {
          appendFinishedRun(state.run, pending);
          setRunning(false);
          return;
        }
        setRunningEvents(retainLiveAgentEvents(state.progress.events));
        recoveryTimerRef.current = window.setTimeout(() => { void check(); }, 600);
      } catch {
        if (recoveryEpoch !== recoveryEpochRef.current || activeRunIdRef.current !== pending.id) return;
        recoveryTimerRef.current = window.setTimeout(() => { void check(); }, 1_200);
      }
    };
    void check();
    return () => {
      if (recoveryEpoch === recoveryEpochRef.current) recoveryEpochRef.current += 1;
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
    };
  }, [appendFinishedRun, appendStreamingDelta, resetStreamingAnswer]);

  // Resume: when mounted with a threadId, hydrate the conversation from the
  // server-persisted turns. The server thread is the source of truth for
  // ANSWERS: host-seeded `initialItems` can be a stale partial snapshot (the
  // localStorage copy is quota-capped and drops run payloads), so we replace
  // local items whenever the server holds more completed turns than the local
  // copy has answer cards. A richer in-memory session (equal counts) is kept.
  const hydratedThreadRef = useRef(false);
  useEffect(() => {
    if (!threadIdProp || hydratedThreadRef.current) return;
    hydratedThreadRef.current = true;
    threadIdRef.current ??= threadIdProp;
    let cancelled = false;
    api.getAgentThread(threadIdProp)
      .then(({ turns, runs }) => {
        if (cancelled || turns.length === 0) return;
        setItems((current) => {
          const localAnswerCount = current.filter((item) => item.kind === 'run').length;
          const canonical = threadItemsFromTurns(turns, runs);
          if (turns.length >= localAnswerCount) return canonical;
          const canonicalRuns = new Map(canonical.flatMap((item) =>
            item.kind === 'run' ? [[item.run.id, item.run] as const] : []));
          return current.map((item) => item.kind === 'run' && canonicalRuns.has(item.run.id)
            ? { ...item, run: canonicalRuns.get(item.run.id)! }
            : item);
        });
      })
      .catch(() => {
        // Unknown/pruned thread (or store unavailable): forget the id so the next
        // question starts a fresh thread instead of writing into the void.
        if (!cancelled && threadIdRef.current === threadIdProp) threadIdRef.current = undefined;
      });
    return () => { cancelled = true; };
  }, [threadIdProp]);

  // The server deliberately keeps an accepted run alive when this view unmounts.
  // Reconnect by run id rather than rerunning the question, so switching tabs,
  // windows, or routes never duplicates work or loses the completed answer.
  useEffect(() => {
    const pending = findActiveAgentRun(threadIdProp ?? threadIdRef.current);
    // The local stream is already healthy for a just-created thread; do not
    // replace its live event feed with polling merely because the host persisted
    // the new thread id.
    if (!pending || abortRef.current) return;
    return recoverPendingRun(pending);
  }, [recoverPendingRun, threadIdProp]);

  useEffect(() => {
    const reconnectWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (abortRef.current) return;
      const pending = pendingRunRef.current ?? findActiveAgentRun(threadIdProp ?? threadIdRef.current);
      if (pending) recoverPendingRun(pending);
    };
    document.addEventListener('visibilitychange', reconnectWhenVisible);
    return () => document.removeEventListener('visibilitychange', reconnectWhenVisible);
  }, [recoverPendingRun, threadIdProp]);

  const submit = async (
    textOverride?: string,
    modeOverride?: AgentRunRequestedMode,
    selectedEvidenceId?: string,
    clarificationSourceQuestion?: string,
    researchSourceRun?: AgentRun,
    selectedResultBinding?: AgentSelectedResultBinding,
  ) => {
    const text = (textOverride ?? input).trim();
    if (!text || running) return;
    const activeMode = resolveComposerRequestedMode({
      initialMode,
      researchMode,
      modeOverride,
      pendingMode: pendingModeRef.current,
    });
    const resultRowsOptInForRun = researchResultRowsOptInForRun(activeMode, researchResultRowsOptIn);
    // Consent is intentionally one-shot and never inherited by the next run.
    setResearchResultRowsOptIn(false);
    pendingModeRef.current = undefined;
    // One identity per explicit submit. It is the Idempotency-Key of this
    // request and the pairing key between this question item and its answer;
    // the question text is neither, so asking twice starts two runs.
    let submissionId = mintAgentRunSubmissionId();
    rememberTabSubmission(submissionId);
    const userItem: ThreadItem = { kind: 'user', id: makeId('user'), text };
    setItems((current) => [...current, userItem]);
    setInput('');
    setError(null);
    setRunning(true);
    setRunningEvents([]);
    resetStreamingAnswer();
    const controller = new AbortController();
    abortRef.current = controller;
    // This is a browser-local pending key only.  It is never sent to the
    // runtime and never used for cancellation, reload, or a SQL capability.
    // Those paths begin only after `agent-run-accepted` supplies the canonical
    // server-owned run id.
    const provisionalRunId = makeId('pending');
    let pending: PendingAgentRun = { id: provisionalRunId, question: text, threadId: threadIdRef.current, startedAt: new Date().toISOString(), submissionId, userItemId: userItem.id };
    activeRunIdRef.current = null;
    pendingRunRef.current = pending;
    setBackgroundRun(pending);
    // Persisted before the request leaves: a reload before `accepted` finds
    // this record and re-sends the same submission under the same key.
    saveActiveAgentRun(pending);
    let receivedStreamMessage = false;
    let acceptedServerRun = false;
    let recovering = false;
    try {
      // Thread-scoped persistence: make sure a server thread exists so this run is
      // recorded as a turn. Best-effort — never block the question on it; without
      // a thread the run simply falls back to the client-built context below.
      if (!threadIdRef.current) {
        try {
          const thread = await api.createAgentThread({
            surface: askLayout
              ? 'ask'
              : typeof workspaceContext?.surface === 'string'
                ? workspaceContext.surface
                : notebookPath
                  ? 'notebook'
                  : 'agent',
            title: text,
            ...(notebookPath ? { notebookPath } : {}),
          });
          threadIdRef.current = thread.id;
          onThreadIdChangeRef.current?.(thread.id);
          pending = { ...pending, threadId: thread.id };
          pendingRunRef.current = pending;
          setBackgroundRun(pending);
          saveActiveAgentRun(pending);
        } catch {
          // Conversation store unavailable — proceed without a threadId.
        }
      }
      const priorAuthoringRun = (activeMode === 'modeling' || activeMode === 'skill')
        ? [...presentedItems].reverse().find((item): item is Extract<ThreadItem, { kind: 'run' }> => item.kind === 'run' && item.run.artifacts.some((artifact) => artifact.kind === (activeMode === 'modeling' ? 'modeling_change_proposal' : 'skill_change_proposal')))?.run
        : undefined;
      const priorAuthoringArtifact = priorAuthoringRun?.artifacts.find((artifact) => artifact.kind === (activeMode === 'modeling' ? 'modeling_change_proposal' : 'skill_change_proposal'));
      const runInput = {
        question: text,
        requestId: submissionId,
        ...(selectedEvidenceId ? { selectedEvidenceId } : {}),
        ...(clarificationSourceQuestion ? { clarificationSourceQuestion } : {}),
        ...(selectedResultBinding ? { selectedResultBinding } : {}),
        requestedMode: activeMode,
        audience,
        selectedObject: selectedObject ?? (notebookPath ? { kind: 'notebook' as const, path: notebookPath } : undefined),
        ...(researchSourceRun?.executionTarget
          ? { executionTarget: researchSourceRun.executionTarget }
          : contextualLocalTarget
          ? { executionTarget: { target: 'local' as const } }
          : executionConnectionName
            ? { executionTarget: { target: 'connection' as const, connectionName: executionConnectionName } }
            : {}),
        workspaceContext: {
          ...(workspaceContext ?? {}),
          ...(notebookPath ? { notebookPath } : {}),
          ...(researchSourceRun ? { researchSource: researchSourceFromRun(researchSourceRun) } : {}),
          ...(priorAuthoringRun && priorAuthoringArtifact ? {
            sourceRunId: priorAuthoringRun.id,
            sourceArtifactId: priorAuthoringArtifact.id,
            revision: (priorAuthoringRun.derivation?.revision ?? 1) + 1,
            // The draft still on screen. Without its id the next message could
            // only start over, so "make that many_to_one" rebuilt from scratch.
            ...(priorAuthoringArtifact.ref ? { priorProposalId: priorAuthoringArtifact.ref } : {}),
          } : {}),
        },
        conversationContext: buildConversationContext(presentedItems),
        history,
        thinkingMode,
        researchResultRowsOptIn: resultRowsOptInForRun,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
      };
      storeSubmissionInput(submissionId, runInput);
      const onStreamMessage = (message: AgentRunStreamMessage) => {
        receivedStreamMessage = true;
        if (message.kind === 'accepted') {
          // Replace the local-only placeholder before any progress, recovery,
          // or Stop action can observe the run.  Persisting only this canonical
          // ID makes a reload reconnect to the run the server actually owns.
          const previousPendingId = pending.id;
          pending = { ...pending, id: message.runId };
          activeRunIdRef.current = message.runId;
          pendingRunRef.current = pending;
          setBackgroundRun(pending);
          clearActiveAgentRun(previousPendingId);
          saveActiveAgentRun(pending);
          acceptedServerRun = true;
        } else if (message.kind === 'event') {
          setRunningEvents((current) => retainLiveAgentEvents([...current, message.event]));
        } else if (message.kind === 'answer-delta') {
          appendStreamingDelta(message.delta);
        } else {
          setRunningEvents(retainLiveAgentEvents(message.run.events));
        }
      };
      let run: AgentRun;
      try {
        run = await api.createAgentRunStream(runInput, onStreamMessage, controller.signal);
      } catch (error) {
        if (!(error instanceof DqlApiError) || error.code !== 'IDEMPOTENCY_CONFLICT') throw error;
        if (error.runId) {
          // The key already started a run for this submission (a reload
          // re-sent it with a different context); attach to that run.
          clearActiveAgentRun(pending.id);
          pending = { ...pending, id: error.runId };
          activeRunIdRef.current = error.runId;
          pendingRunRef.current = pending;
          setBackgroundRun(pending);
          saveActiveAgentRun(pending);
          recovering = true;
          recoverPendingRun(pending);
          return;
        }
        // A collision on a fresh identity: mint another and resend exactly once.
        clearSubmissionInput(submissionId);
        submissionId = mintAgentRunSubmissionId();
        rememberTabSubmission(submissionId);
        pending = { ...pending, submissionId };
        pendingRunRef.current = pending;
        saveActiveAgentRun(pending);
        const retryInput = { ...runInput, requestId: submissionId };
        storeSubmissionInput(submissionId, retryInput);
        run = await api.createAgentRunStream(retryInput, onStreamMessage, controller.signal);
      }
      // A compliant runtime emits `accepted` first.  Keep the completion path
      // defensive for an interrupted/older transport so it cannot leave a
      // provisional ID in browser state.
      if (pending.id !== run.id) {
        const previousPendingId = pending.id;
        pending = { ...pending, id: run.id };
        activeRunIdRef.current = run.id;
        pendingRunRef.current = pending;
        clearActiveAgentRun(previousPendingId);
        saveActiveAgentRun(pending);
      }
      appendFinishedRun(run, pending);
    } catch (err) {
      if (!controller.signal.aborted) {
        const unknownOutcomeRunId = err instanceof DqlApiError && err.code === 'REQUEST_OUTCOME_UNKNOWN' ? err.runId : undefined;
        setError(`${err instanceof Error ? err.message : String(err)}${unknownOutcomeRunId ? ` Run ${unknownOutcomeRunId}.` : ''}`);
        setInput(text);
        // If streaming disconnected after the server began reporting progress,
        // let the persisted run finish and quietly reconnect to its final answer.
        if (receivedStreamMessage && acceptedServerRun) {
          recovering = true;
          recoverPendingRun(pending);
        } else {
          clearActiveAgentRun(pending.id);
          clearSubmissionInput(pending.submissionId);
          if (activeRunIdRef.current === pending.id) activeRunIdRef.current = null;
          pendingRunRef.current = null;
          setBackgroundRun(null);
        }
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (!recovering) setRunning(false);
    }
  };

  const handleSubmit = () => {
    void submit();
  };

  const handleStop = () => {
    const runId = activeRunIdRef.current;
    // Stop the server-owned run first so a hidden/background process cannot
    // keep spending provider time after the visible composer has stopped.
    if (runId) void api.cancelAgentRun(runId).catch(() => undefined);
    abortRef.current?.abort();
    recoveryEpochRef.current += 1;
    if (recoveryTimerRef.current !== null) window.clearTimeout(recoveryTimerRef.current);
    clearActiveAgentRun(runId ?? '');
    if (pendingRunRef.current) {
      clearActiveAgentRun(pendingRunRef.current.id);
      clearSubmissionInput(pendingRunRef.current.submissionId);
    }
    activeRunIdRef.current = null;
    pendingRunRef.current = null;
    setBackgroundRun(null);
    resetStreamingAnswer();
    setRunningEvents([]);
    setRunning(false);
    setError('Stopped. No answer or draft was saved.');
  };

  const onRunningChangeRef = useRef(onRunningChange);
  onRunningChangeRef.current = onRunningChange;
  useEffect(() => {
    onRunningChangeRef.current?.(running);
  }, [running]);

  useEffect(() => {
    if (!autoRun?.text || running) return;
    if (lastAutoRunNonceRef.current === autoRun.nonce) return;
    lastAutoRunNonceRef.current = autoRun.nonce;
    void submit(autoRun.text, autoRun.mode ?? initialMode);
  }, [autoRun?.nonce, autoRun?.text, autoRun?.mode, initialMode, running]);

  useEffect(() => () => {
    // Route changes only detach this view. The server-owned run and its fetch
    // handshake must continue; only the explicit Stop action cancels provider work.
    recoveryEpochRef.current += 1;
    if (recoveryTimerRef.current !== null) window.clearTimeout(recoveryTimerRef.current);
  }, []);

  // Pre-selected app target when the panel is opened inside an app (the global
  // rail); on the Ask home there is none and the picker lists/creates apps.
  const appContext = {
    appId: typeof workspaceContext?.appId === 'string' ? workspaceContext.appId : undefined,
    dashboardId: typeof workspaceContext?.dashboardId === 'string' ? workspaceContext.dashboardId : undefined,
    dashboardTitle: typeof workspaceContext?.dashboardTitle === 'string' ? workspaceContext.dashboardTitle : undefined,
  };

  const handleNextAction = (run: AgentRun, action: AgentRun['nextActions'][number]) => {
    if (action.id === 'select-app-dataset-tile') {
      const selectTile = onSelectAppAutopilotTileRef.current;
      if (selectTile) selectTile();
      else setError('Choose “Edit with AI” on a saved Dataset tile in App Studio first.');
      return;
    }
    if (action.id === 'review-app-autopilot-change') {
      const artifact = run.artifacts.find((candidate) => candidate.kind === 'app_autopilot_change');
      if (!artifact) {
        setError('This AI run does not include a reviewable tile change.');
        return;
      }
      onReviewAppAutopilotChangeRef.current?.(artifact, run);
      return;
    }
    if (action.id === 'review-modeling-proposal' || action.id === 'review-skill-proposal') {
      const expectedKind = action.id === 'review-modeling-proposal'
        ? 'modeling_change_proposal'
        : 'skill_change_proposal';
      const artifact = run.artifacts.find((candidate) => candidate.kind === expectedKind);
      if (!artifact) {
        setError('This authoring run does not include a reviewable proposal.');
        return;
      }
      if (onReviewAuthoringProposal) onReviewAuthoringProposal(artifact, run);
      else if (artifact.ref) {
        try { window.sessionStorage.setItem('dql-context-proposal-handoff', artifact.ref); } catch { /* best effort */ }
        window.dispatchEvent(new CustomEvent('dql:open-context-proposal', { detail: { proposalId: artifact.ref, kind: artifact.kind } }));
      }
      return;
    }
    if (action.id === 'save-dql-block') {
      const dqlArtifact = answerDqlArtifactFromRun(run);
      const source = dqlArtifact?.source?.trim() ?? answerSqlFromRun(run)?.trim();
      if (!source) {
        setError('This answer does not include a reusable DQL or SQL artifact yet.');
        return;
      }
      setBlockToSave({
        runId: run.id,
        source,
        name: dqlArtifact?.name ?? `${run.question.slice(0, 48).trim() || 'saved_answer'}`,
        dqlArtifact,
      });
      return;
    }
    if (action.id === 'scope-to-domain' || action.id === 'clear-scope') {
      // Scope Ask to the domain the answer came from, or clear a scope that no
      // longer exists; the question waits in the box to be asked again.
      const suggested = runContextSummary(askPipelineReceiptOf(run)).suggestedDomain;
      if (action.id === 'scope-to-domain' && !suggested) {
        setError('This answer did not name a domain to scope to.');
        return;
      }
      onScopeChange?.(action.id === 'scope-to-domain' ? { domain: suggested! } : undefined);
      setInput(run.question);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (action.id === 'create-relationship') {
      // The join the AI wrote goes to the relationship builder, filled in.
      const used = recordOf(recordOf(askPipelineReceiptOf(run)?.context)?.used);
      const join = (Array.isArray(used?.joins) ? used.joins : []).map(recordOf)
        .find((item) => item?.authority === 'none' && Array.isArray(item.relations) && item.relations.length === 2);
      if (!join) {
        setError('This answer did not record the join to save.');
        return;
      }
      try { window.sessionStorage.setItem('dql-relationship-draft-handoff', JSON.stringify({ relations: join.relations, keys: Array.isArray(join.keys) ? join.keys : [] })); } catch { /* best effort */ }
      window.dispatchEvent(new CustomEvent('dql:open-relationship-draft'));
      return;
    }
    if (action.id === 'research-deeper' || action.id === 'investigate-drivers') {
      void submit(run.question, 'research', undefined, undefined, run);
      return;
    }
    // A conversational suggestion chip carries the whole question as its label — run it.
    if (action.id.startsWith('suggest-question')) {
      void submit(action.label, 'auto');
      return;
    }
    pendingModeRef.current = routeToMode(action.route);
    setInput(nextPromptFor(run, action.route));
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // ── Ask redesign helpers ──────────────────────────────────────────────────
  // Open the inspector on an artifact chip. Picks a sensible starting tab.
  const openInspector = useCallback((runId: string, artifactId: string, tab: AskInspectorTab = 'trust') => {
    setInspector({ runId, artifactId, tab });
  }, []);

  // Send a follow-up carrying the selected quote as context, then scroll down.
  const sendFollowUp = useCallback((question: string) => {
    const q = question.trim();
    if (!q) return;
    const selectedResultBinding = pop?.selectedResultBinding;
    setPop(null);
    setPopDraft('');
    try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
    // A selected result is server-revalidated by stable run/artifact/row
    // fingerprints. Never append rendered text as `Regarding:` authority:
    // prose is ambiguous, locale-formatted, and disappears on reload.
    void submit(q, undefined, undefined, undefined, undefined, selectedResultBinding);
    requestAnimationFrame(() => {
      if (askScrollRef.current) askScrollRef.current.scrollTop = askScrollRef.current.scrollHeight;
    });
  }, [pop, submit]);

  // Text-selection watcher for the follow-up popover (askLayout only). A
  // selection of ≥3 chars inside a [data-followup] zone opens the popover at
  // the selection rect; Esc or an empty selection dismisses it.
  useEffect(() => {
    if (!askLayout) return;
    const onMouseUp = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest('[data-selpop]')) return;
      window.setTimeout(() => {
        const sel = window.getSelection();
        const text = sel && sel.rangeCount ? sel.toString().trim() : '';
        if (!text || text.length < 3) { setPop((p) => (p ? null : p)); return; }
        const anchor = sel!.anchorNode;
        const el = anchor && (anchor.nodeType === 1 ? (anchor as HTMLElement) : anchor.parentElement);
        const zone = el?.closest('[data-followup]') as HTMLElement | null;
        if (!zone) { setPop((p) => (p ? null : p)); return; }
        const rect = sel!.getRangeAt(0).getBoundingClientRect();
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - 340));
        const top = rect.bottom + 176 > window.innerHeight ? Math.max(12, rect.top - 176) : rect.bottom + 8;
        const source = (zone.getAttribute('data-followup') as 'answer' | 'table') || 'answer';
        const runId = zone.getAttribute('data-followup-run-id');
        const artifactId = zone.getAttribute('data-followup-artifact-id');
        const sourceRun = runId ? items.find((item): item is Extract<ThreadItem, { kind: 'run' }> => item.kind === 'run' && item.run.id === runId)?.run : undefined;
        const sourceArtifact = sourceRun && artifactId ? sourceRun.artifacts.find((artifact) => artifact.id === artifactId) : undefined;
        void selectedResultBindingForSelection({
          selectedText: text,
          run: sourceRun,
          artifact: sourceArtifact,
        }).then((selectedResultBinding) => {
          setPop({ text: text.slice(0, 220), source, left, top, ...(selectedResultBinding ? { selectedResultBinding } : {}) });
          setPopDraft('');
          requestAnimationFrame(() => popInputRef.current?.focus());
        });
      }, 0);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setPop(null); };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [askLayout, items]);

  // ── Redesigned Ask experience ─────────────────────────────────────────────
  if (askLayout) {
    const activeInspector = inspector
      ? (() => {
          const item = items.find((it) => it.kind === 'run' && it.run.id === inspector.runId);
          if (!item || item.kind !== 'run') return null;
          const artifact = item.run.artifacts.find((a) => a.id === inspector.artifactId);
          if (!artifact) return null;
          return { run: item.run, artifact };
        })()
      : null;
    return (
      <div style={{ display: 'flex', height: '100%', minHeight: 0, flex: 1, minWidth: 0, width: '100%', background: 'var(--bg-canvas)' }}>
        {blockToSave ? (
          <SaveAsBlockModal
            cell={{
              id: `agent-${blockToSave.runId}`,
              type: blockToSave.dqlArtifact ? 'dql' : 'sql',
              content: blockToSave.source,
              name: blockToSave.name,
              status: 'success',
              ...(blockToSave.dqlArtifact ? { dqlArtifact: blockToSave.dqlArtifact } : {}),
            } satisfies Cell}
            initialContent={blockToSave.source}
            initialName={blockToSave.name}
            onClose={() => setBlockToSave(null)}
            onSaved={() => setBlockToSave(null)}
          />
        ) : null}
        <style>{ASK_KEYFRAMES}</style>

        {/* Chat column */}
        <div style={{ flex: 1, minWidth: 360, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-canvas)' }}>
          <div style={{ height: 46, flexShrink: 0, borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 9, padding: '0 24px' }}>
            <div style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--accent-dim)', border: '1px solid var(--status-info-border)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Sparkles size={13} />
            </div>
            <span style={{ fontSize: 13.5, fontWeight: 650, color: t.textPrimary, whiteSpace: 'nowrap' }}>{title === 'AI Copilot' ? 'Ask your data' : title}</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: t.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{reader ? 'Certified answers first, then approved metrics, then new SQL marked Needs review' : 'Certified first · semantic next · generated SQL last'}</span>
          </div>

          <div ref={askScrollRef} data-testid="ask-thread-scroll" onScroll={onThreadScroll} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ width: 'min(720px, 100% - 48px)', margin: '0 auto', padding: '26px 0 12px', display: 'flex', flexDirection: 'column', gap: 26 }}>
              {presentedItems.length === 0 && !running && askRefusal ? (
                <div role="note" style={{ margin: 'auto 0', display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center', color: t.textSecondary, paddingTop: 40 }}>
                  <div style={largeIconShellStyle(t)}><Sparkles size={20} /></div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.5, maxWidth: 420, color: t.textSecondary }}>{askRefusal.reason ?? 'Asking questions is not open to you here.'}</div>
                  {askRefusal.next ? (
                    <button
                      type="button"
                      className="dql-hover"
                      onClick={() => { hostPage.openPage({ id: `refusal-${askRefusal.next!.href}`, label: askRefusal.next!.label, href: askRefusal.next!.href }); notebookDispatch({ type: 'SET_MAIN_VIEW', view: 'host_page' }); }}
                      style={{ height: 34, padding: '0 14px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--accent-fg, #fff)', cursor: 'pointer', fontFamily: t.font, fontSize: 13, fontWeight: 600 }}
                    >
                      {askRefusal.next.label}
                    </button>
                  ) : null}
                </div>
              ) : presentedItems.length === 0 && !running ? (
                <div style={{ margin: 'auto 0', display: 'grid', gap: 14, justifyItems: 'center', textAlign: 'center', color: t.textSecondary, paddingTop: 40 }}>
                  <div style={largeIconShellStyle(t)}><Sparkles size={20} /></div>
                  <div style={{ fontSize: 13.5, lineHeight: 1.5, maxWidth: 400, color: t.textSecondary }}>{emptyHint ?? DEFAULT_EMPTY_HINT}</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 520 }}>
                    {(examplePrompts ?? (projectPrompts.length ? projectPrompts : EXAMPLE_PROMPTS)).map((ex) => (
                      <button key={ex.label} type="button" className="dql-hover dql-lift" onClick={() => { setInput(ex.prompt); requestAnimationFrame(() => inputRef.current?.focus()); }} style={suggestionChipStyle(t)}>{ex.label}</button>
                    ))}
                  </div>
                </div>
              ) : null}

              {presentedItems.map((item) => item.kind === 'user' ? (
                <div key={item.id} data-thread-user-turn={item.id} style={askUserBubbleStyle(t)}>{item.text}</div>
              ) : (
                <AskRunCard
                  key={item.id}
                  run={item.run}
                  t={t}
                  themeMode={themeMode}
                  threadId={threadIdRef.current}
                  appContext={appContext}
                  selectedArtifactId={inspector?.runId === item.run.id ? inspector.artifactId : undefined}
                  onOpenArtifact={(artifactId, tab) => openInspector(item.run.id, artifactId, tab)}
                  onOpenApp={onOpenApp}
                  onInsertSql={onInsertSql}
                  onInsertDql={onInsertDql}
                  onOpenBlock={onOpenBlock}
                  onOpenResearch={onOpenResearch}
                  onSelectClarification={(option) => {
                    const selection = clarificationSelectionInput(option, item.run.question);
                    void submit(selection.question, undefined, selection.selectedEvidenceId, item.run.question);
                  }}
                  onNextAction={(action) => handleNextAction(item.run, action)}
                  onRepairedRun={adoptRepairedRun}
                />
              ))}

              {running && <RunProgress events={runningEvents} t={t} streamingAnswer={streamingAnswer} thinkingMode={thinkingMode} backgroundRun={backgroundRun} />}
            </div>
          </div>

            {/* The composer sits below the thread, not over it: the thread's scroll area ends where the scope chip
                begins, so the end of an answer (its action row) is never covered. */}
            {askRefusal ? null : (
            <div data-testid="ask-composer-dock" style={{ flexShrink: 0, width: 'min(720px, 100% - 48px)', margin: '0 auto', padding: '10px 0 16px', background: 'var(--bg-canvas)' }}>
              {error ? <div style={{ color: t.error, fontSize: 12, marginBottom: 8 }}>{error}</div> : null}
              {scopeControl ? <div style={{ marginBottom: 7 }}>{scopeControl}</div> : onClearScope ? (
                <div style={{ width: 'fit-content', maxWidth: '100%', marginBottom: 7, padding: '4px 7px 4px 9px', border: '1px solid var(--border-default)', borderRadius: 999, background: 'var(--bg-2)', color: t.textMuted, fontSize: 11, display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scopeHint}</span>
                  <button type="button" onClick={onClearScope} aria-label="Clear modeling scope" title="Clear modeling scope" style={{ border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 1 }}><X size={12} /></button>
                </div>
              ) : null}
              <div className="dql-ask-composer" style={{ background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 14, boxShadow: '0 1px 2px rgba(26,26,26,0.03), 0 6px 22px rgba(26,26,26,0.05)', display: 'flex', flexDirection: 'column' }}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => { setInput(event.target.value); pendingModeRef.current = undefined; }}
                  rows={1}
                  placeholder={composerPlaceholder}
                  onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleSubmit(); } }}
                  style={{ border: 'none', background: 'transparent', resize: 'none', outline: 'none', boxShadow: 'none', padding: '14px 16px 4px', minHeight: 48, maxHeight: 200, overflowY: 'auto', fontSize: 14, lineHeight: 1.5, color: t.textPrimary, fontFamily: t.font }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 8px 8px' }}>
                  <AskComposerOptions
                    t={t}
                    thinkingMode={thinkingMode}
                    onThinkingMode={changeThinkingMode}
                    research={researchMode}
                    onResearch={changeResearchMode}
                    researchRows={researchResultRowsOptIn}
                    onResearchRows={setResearchResultRowsOptIn}
                    researchRowsTitle={RESEARCH_TOOL_ROWS_CONSENT_TITLE}
                  />
                  <div style={{ flex: 1 }} />
                  {running ? (
                    <button type="button" className="dql-hover" onClick={handleStop} title="Stop the active agent run" style={{ height: 34, padding: '0 12px', borderRadius: 10, border: `1px solid ${t.error}`, background: t.btnBg, color: t.error, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontFamily: t.font, fontSize: 12.5, fontWeight: 600 }}>
                      <Square size={13} fill="currentColor" /> Stop
                    </button>
                  ) : null}
                  <button type="button" className="dql-hover dql-lift" title="Ask" onClick={handleSubmit} disabled={!input.trim() || running} style={{ width: 34, height: 34, borderRadius: 10, border: 'none', background: (input.trim() && !running) ? 'var(--accent)' : 'var(--bg-4)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: (input.trim() && !running) ? 'pointer' : 'default', boxShadow: (input.trim() && !running) ? '0 1px 5px rgba(107,93,211,0.3)' : 'none' }}>
                    {running ? <Loader2 size={15} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <ArrowUp size={15} />}
                  </button>
                </div>
              </div>
              <div style={{ textAlign: 'center', fontSize: 11, color: t.textMuted, marginTop: 8 }}>Each answer says what it is built on: certified, governed, or needs review.</div>
            </div>
            )}
        </div>

        {/* Inspector */}
        {activeInspector ? (
          <AskInspector
            run={activeInspector.run}
            artifact={activeInspector.artifact}
            tab={inspector!.tab}
            t={t}
            appContext={appContext}
            onOpenApp={onOpenApp}
            onChangeTab={(tab) => setInspector((prev) => (prev ? { ...prev, tab } : prev))}
            onClose={() => setInspector(null)}
            onSaveBlock={() => handleNextAction(activeInspector.run, { id: 'save-dql-block', label: 'Save as saved query', route: 'dql_block_draft' })}
            onInsertSql={onInsertSql}
            onInsertDql={onInsertDql}
          />
        ) : null}

        {pop ? (
          <FollowUpPopover
            t={t}
            text={pop.text}
            source={pop.source}
            left={pop.left}
            top={pop.top}
            draft={popDraft}
            inputRef={popInputRef}
            onDraftChange={setPopDraft}
            onClose={() => setPop(null)}
            onSend={sendFollowUp}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, flex: 1, minWidth: 0, width: '100%', background: t.cellBg }}>
      {blockToSave ? (
        <SaveAsBlockModal
          cell={{
            id: `agent-${blockToSave.runId}`,
            type: blockToSave.dqlArtifact ? 'dql' : 'sql',
            content: blockToSave.source,
            name: blockToSave.name,
            status: 'success',
            ...(blockToSave.dqlArtifact ? { dqlArtifact: blockToSave.dqlArtifact } : {}),
          } satisfies Cell}
          initialContent={blockToSave.source}
          initialName={blockToSave.name}
          onClose={() => setBlockToSave(null)}
          onSaved={() => setBlockToSave(null)}
        />
      ) : null}
      <style>{`
        @keyframes dql-agent-run-spin { to { transform: rotate(360deg); } }
        @keyframes dql-agent-fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
        @keyframes dql-agent-thinking-dot { 0%, 65%, 100% { opacity: .28; transform: translateY(0); } 32% { opacity: 1; transform: translateY(-2px); } }
        @keyframes dql-agent-activity-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
        .dql-agent-thinking-dot { animation: dql-agent-thinking-dot 1.05s ease-in-out infinite; }
        .dql-agent-activity { animation: dql-agent-activity-in .22s ease-out; }
        .dql-hover { transition: filter .15s ease, transform .12s ease, box-shadow .15s ease, background .15s ease, color .15s ease, border-color .15s ease; }
        .dql-hover:hover { filter: brightness(1.07); }
        .dql-hover:active { transform: translateY(0.5px); }
        .dql-lift:hover { transform: translateY(-1px); }
        details > summary::-webkit-details-marker { display: none; }
        @media (prefers-reduced-motion: reduce) { .dql-agent-thinking-dot, .dql-agent-activity { animation: none !important; } }
      `}</style>

      <div ref={railScrollRef} onScroll={onThreadScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {presentedItems.length === 0 && !running ? (
          <div style={{ margin: 'auto 0', display: 'grid', gap: 14, justifyItems: 'center', textAlign: 'center', color: t.textSecondary }}>
            <div style={largeIconShellStyle(t)}><Sparkles size={20} /></div>
            <div style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 380, color: t.textSecondary }}>
              {emptyHint ?? DEFAULT_EMPTY_HINT}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 520 }}>
              {(examplePrompts ?? (projectPrompts.length ? projectPrompts : EXAMPLE_PROMPTS)).map((ex) => (
                <button key={ex.label} type="button" className="dql-hover dql-lift" onClick={() => { setInput(ex.prompt); requestAnimationFrame(() => inputRef.current?.focus()); }} style={suggestionChipStyle(t)}>
                  {ex.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {presentedItems.map((item) => item.kind === 'user' ? (
          <div key={item.id} data-thread-user-turn={item.id} style={userBubbleStyle(t)}>{item.text}</div>
        ) : answerFirstCards ? (
          <AskRunCard
            key={item.id}
            run={item.run}
            t={t}
            themeMode={themeMode}
            threadId={threadIdRef.current}
            appContext={appContext}
            onOpenApp={onOpenApp}
            onInsertSql={onInsertSql}
            onInsertDql={onInsertDql}
            onReplaceDql={onReplaceDql}
            insertDqlActionLabel={insertDqlActionLabel}
            replaceDqlActionLabel={replaceDqlActionLabel}
            onOpenBlock={onOpenBlock}
            onOpenResearch={onOpenResearch}
            onSelectClarification={(option) => {
              const selection = clarificationSelectionInput(option, item.run.question);
              void submit(selection.question, undefined, selection.selectedEvidenceId, item.run.question);
            }}
            onNextAction={(action) => handleNextAction(item.run, action)}
            onRepairedRun={adoptRepairedRun}
          />
        ) : (
          <RunCard
            key={item.id}
            run={item.run}
            t={t}
            themeMode={themeMode}
            appContext={appContext}
            onOpenApp={onOpenApp}
            onInsertSql={onInsertSql}
            onInsertDql={onInsertDql}
            onOpenBlock={onOpenBlock}
            onOpenResearch={onOpenResearch}
            onSelectClarification={(option) => {
              const selection = clarificationSelectionInput(option, item.run.question);
              void submit(selection.question, undefined, selection.selectedEvidenceId, item.run.question);
            }}
            onNextAction={(action) => handleNextAction(item.run, action)}
          />
        ))}

        {running && <RunProgress events={runningEvents} t={t} streamingAnswer={streamingAnswer} thinkingMode={thinkingMode} backgroundRun={backgroundRun} />}
      </div>

      {error ? <div style={{ margin: '0 16px 8px', color: t.error, fontSize: 12 }}>{error}</div> : null}

      <div style={{ padding: '10px 16px 14px', borderTop: `1px solid ${t.headerBorder}`, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11, color: t.textMuted, flex: 1, minWidth: 180, display: 'flex', alignItems: 'center', gap: 6 }}>
            {scopeControl ?? <span>{scopeHint}</span>}
            {!scopeControl && onClearScope ? <button type="button" onClick={onClearScope} aria-label="Clear modeling scope" title="Clear modeling scope" style={{ border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 2 }}><X size={12} /></button> : null}
          </div>
          <AskComposerOptions
            t={t}
            thinkingMode={thinkingMode}
            onThinkingMode={changeThinkingMode}
            research={researchMode}
            onResearch={changeResearchMode}
            researchRows={researchResultRowsOptIn}
            onResearchRows={setResearchResultRowsOptIn}
            researchRowsTitle={RESEARCH_TOOL_ROWS_CONSENT_TITLE}
            align="end"
          />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => { setInput(event.target.value); pendingModeRef.current = undefined; }}
            rows={2}
            placeholder={composerPlaceholder}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSubmit();
              }
            }}
            style={inputStyle(t)}
          />
          <button
            type="button"
            className="dql-hover dql-lift"
            onClick={handleSubmit}
            disabled={!input.trim() || running}
            style={sendButtonStyle(t, Boolean(input.trim()) && !running)}
          >
            {running ? <Loader2 size={15} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Send size={15} />}
            <span>{running ? 'Working' : 'Ask'}</span>
          </button>
          {running ? <button type="button" className="dql-hover" onClick={handleStop} style={{ ...sendButtonStyle(t, true), background: t.btnBg, borderColor: t.error, color: t.error }} title="Stop the active agent run"><Square size={13} fill="currentColor" /><span>Stop</span></button> : null}
        </div>
      </div>
    </div>
  );
}

const DEFAULT_EMPTY_HINT = 'Ask a question. Each answer says what it is built on: certified, governed, or needs review. Use Research deeper on any answer to investigate what changed.';
const EXAMPLE_PROMPTS: ExamplePrompt[] = [
  { label: 'What is total revenue?', prompt: 'What is total revenue?' },
  { label: 'Why is revenue down by region?', prompt: 'Why is revenue down by region?' },
  { label: 'Top customers by revenue this quarter', prompt: 'Top customers by revenue this quarter' },
  { label: 'How have orders trended over the last 6 months?', prompt: 'How have orders trended over the last 6 months?' },
];

// ── Server-thread resume ─────────────────────────────────────────────────────

/**
 * Host helper: persist the panel's server thread id in localStorage (keyed per
 * surface) so a page refresh resumes the same conversation. Wire the returned
 * `threadId`/`onThreadIdChange` straight into `UnifiedAgentRunPanel` props;
 * `resetThreadId` starts a fresh conversation on the next question.
 */
export { usePersistedAgentThreadId } from './usePersistedAgentThreadId';

function readActiveAgentRuns(): PendingAgentRun[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ACTIVE_RUNS_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PendingAgentRun => {
      if (!entry || typeof entry !== 'object') return false;
      const value = entry as Record<string, unknown>;
      return typeof value.id === 'string'
        && typeof value.question === 'string'
        && typeof value.startedAt === 'string'
        && (value.threadId === undefined || typeof value.threadId === 'string')
        && (value.submissionId === undefined || typeof value.submissionId === 'string')
        && (value.userItemId === undefined || typeof value.userItemId === 'string');
    });
  } catch {
    return [];
  }
}

function saveActiveAgentRun(run: PendingAgentRun): void {
  try {
    const otherRuns = readActiveAgentRuns().filter((entry) => entry.id !== run.id);
    window.localStorage.setItem(ACTIVE_RUNS_STORAGE_KEY, JSON.stringify([...otherRuns, run].slice(-12)));
  } catch {
    // A run continues on the server even if browser storage is unavailable.
  }
}

function clearActiveAgentRun(runId: string): void {
  try {
    const remaining = readActiveAgentRuns().filter((entry) => entry.id !== runId);
    window.localStorage.setItem(ACTIVE_RUNS_STORAGE_KEY, JSON.stringify(remaining));
  } catch {
    // Best effort only: an old entry is harmless and will be de-duplicated if found.
  }
}

const PROVISIONAL_RUN_ID_PREFIX = 'pending_';
/** A browser-local pending key that no server has accepted yet. */
export function isProvisionalAgentRunId(runId: string): boolean {
  return runId.startsWith(PROVISIONAL_RUN_ID_PREFIX);
}

const SUBMISSION_INPUT_STORAGE_PREFIX = 'dql-ask-submission:';
const SUBMISSION_INPUT_TTL_MS = 10 * 60_000;

/**
 * The exact request of a submission, kept for this tab only while the run
 * is pending, so a reload before the server accepted it re-sends the same
 * body under the same Idempotency-Key and attaches to whatever it started.
 */
function storeSubmissionInput(submissionId: string, input: CreateAgentRunInput): void {
  try {
    window.sessionStorage.setItem(`${SUBMISSION_INPUT_STORAGE_PREFIX}${submissionId}`, JSON.stringify({ at: Date.now(), input }));
  } catch {
    // Without storage a reload simply cannot resume a not-yet-accepted submission.
  }
}

function readSubmissionInput(submissionId: string): CreateAgentRunInput | undefined {
  try {
    const raw = window.sessionStorage.getItem(`${SUBMISSION_INPUT_STORAGE_PREFIX}${submissionId}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { at?: unknown; input?: unknown };
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > SUBMISSION_INPUT_TTL_MS) return undefined;
    if (!parsed.input || typeof parsed.input !== 'object') return undefined;
    const input = parsed.input as CreateAgentRunInput;
    return typeof input.question === 'string' ? { ...input, requestId: submissionId } : undefined;
  } catch {
    return undefined;
  }
}

function clearSubmissionInput(submissionId?: string): void {
  if (!submissionId) return;
  try {
    window.sessionStorage.removeItem(`${SUBMISSION_INPUT_STORAGE_PREFIX}${submissionId}`);
  } catch {
    // Best effort.
  }
}

/**
 * Place a finished run in the thread. The answer is paired with the question
 * item the submission created (by id); the text of the question is never the
 * pairing key, so two identical questions keep two answers. A pending record
 * from before submission ids existed falls back to the text match.
 */
export function mergeFinishedRun(current: ThreadItem[], run: AgentRun, pending: Pick<PendingAgentRun, 'question' | 'userItemId'>): ThreadItem[] {
  if (current.some((item) => item.kind === 'run' && item.run.id === run.id)) {
    return current.map((item) => item.kind === 'run' && item.run.id === run.id
      ? { ...item, id: run.id, run }
      : item);
  }
  // A reload can happen after the question was sent but before its local item
  // was rendered. Restore that question ahead of the recovered answer.
  const alreadyHasQuestion = pending.userItemId
    ? current.some((item) => item.kind === 'user' && item.id === pending.userItemId)
    : current.some((item) => item.kind === 'user' && item.text === pending.question);
  return [
    ...current,
    ...(alreadyHasQuestion ? [] : [{ kind: 'user' as const, id: pending.userItemId ?? `${run.id}-question`, text: pending.question }]),
    { kind: 'run' as const, id: run.id, run },
  ];
}

const TAB_SUBMISSIONS_STORAGE_KEY = 'dql.agent.tab-submissions.v1';

/** The submissions this tab minted; a thread-less pending run is adopted only by the tab that started it. */
function rememberTabSubmission(submissionId: string): void {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(TAB_SUBMISSIONS_STORAGE_KEY) ?? '[]');
    const ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    window.sessionStorage.setItem(TAB_SUBMISSIONS_STORAGE_KEY, JSON.stringify([...ids.filter((id) => id !== submissionId), submissionId].slice(-24)));
  } catch { /* per-tab memory unavailable */ }
}

function tabOwnsSubmission(submissionId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(TAB_SUBMISSIONS_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) && parsed.includes(submissionId);
  } catch {
    return false;
  }
}

/**
 * Which pending run a view adopts on mount: the run of its thread, or a
 * thread-less run this tab itself submitted. A reload in one tab never
 * attaches another tab's new-chat run.
 */
export function adoptablePendingRun(runs: PendingAgentRun[], threadId: string | undefined, owns: (submissionId: string) => boolean): PendingAgentRun | undefined {
  const ordered = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (threadId) return ordered.find((entry) => entry.threadId === threadId);
  return ordered.find((entry) => !entry.threadId && Boolean(entry.submissionId) && owns(entry.submissionId!));
}

function findActiveAgentRun(threadId?: string): PendingAgentRun | undefined {
  return adoptablePendingRun(readActiveAgentRuns(), threadId, tabOwnsSubmission);
}

const THINKING_MODE_STORAGE_KEY = 'dql.agent.thinkingMode';
/** Visible consent copy mirrors the provider egress boundary exactly. */
export const RESEARCH_TOOL_ROWS_CONSENT_TITLE = 'One-run consent: during explicit Research, lets the AI word the summary from the figures the investigation computed, never result rows. Every number it writes is checked against those figures; without this, the summary is written from the figures directly. Ordinary Ask keeps result rows local.';
/** The browser may request row egress only for the Research run currently being submitted. */
export function researchResultRowsOptInForRun(
  requestedMode: AgentRunRequestedMode,
  checked: boolean,
): boolean {
  return requestedMode === 'research' && checked;
}
export function selectAgentExecutionConnection(
  names: string[],
  defaultName?: string,
  preferredName?: string,
): string | undefined {
  if (preferredName && names.includes(preferredName)) return preferredName;
  if (defaultName && names.includes(defaultName)) return defaultName;
  return names[0];
}

function readStoredThinkingMode(): AgentThinkingMode {
  try {
    const stored = window.localStorage.getItem(THINKING_MODE_STORAGE_KEY);
    return stored === 'low' || stored === 'medium' || stored === 'high' || stored === 'auto' ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

const AGENT_RUN_ROUTES = new Set<AgentRunRoute>([
  'conversation', 'certified_answer', 'semantic_answer', 'generated_answer', 'research',
  'sql_cell', 'dql_block_draft', 'modeling_draft', 'skill_draft', 'app_build', 'clarify', 'cancelled', 'blocked',
]);
const AGENT_RUN_TRUST_STATES = new Set<AgentRunTrustState>([
  'certified', 'governed', 'grounded', 'review_required', 'blocked', 'not_applicable',
]);
const AGENT_RUN_STATUSES = new Set<AgentRunStatus>([
  'completed', 'needs_review', 'needs_clarification', 'cancelled', 'blocked',
]);
const AGENT_RUN_STOP_REASONS = new Set<AgentRunStopReason>([
  'conversational_reply',
  'certified_answer_found',
  'governed_semantic_answer',
  'governed_compound_answer',
  'generated_review_required',
  'artifact_created',
  'needs_clarification',
  'human_review_required',
  'cancelled',
  'blocked',
]);

/**
 * Rebuild the panel's thread items from server-persisted conversation turns.
 * A stored turn is a compact snapshot (question + answer summary + capped result),
 * not a full AgentRun — so each run is reconstructed minimally: enough for the
 * RunCard (route, trust, answer, result preview) and for
 * `buildConversationContext` to keep working as the no-threadId fallback.
 */
export { askFailureOrigin, askFailureDetail, ASK_FAILURE_PRESENTATION };

export function threadItemsFromTurns(turns: AgentConversationTurn[], runs: AgentRun[] = []): ThreadItem[] {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const persistedRunIds = new Set(turns.flatMap((turn) => turn.agentRunId ? [turn.agentRunId] : []));
  const repairedSourceRunIds = new Set(runs.flatMap((run) => {
    const derivation = run.derivation;
    return derivation?.kind === 'analytical_repair'
      && persistedRunIds.has(run.id)
      && typeof derivation.sourceRunId === 'string'
      ? [derivation.sourceRunId]
      : [];
  }));
  // A repair is persisted as an immutable derived turn for audit. Present it as
  // the replacement answer instead of replaying the failed question twice.
  return turns.filter((turn) => !turn.agentRunId || !repairedSourceRunIds.has(turn.agentRunId)).flatMap((turn): ThreadItem[] => {
    const run = turn.agentRunId ? runsById.get(turn.agentRunId) : undefined;
    return [
      { kind: 'user', id: `${turn.id}-q`, text: turn.question },
      { kind: 'run', id: run?.id ?? turn.id, run: run ?? runFromConversationTurn(turn) },
    ];
  });
}

function runFromConversationTurn(turn: AgentConversationTurn): AgentRun {
  const route: AgentRunRoute = AGENT_RUN_ROUTES.has(turn.route as AgentRunRoute)
    ? (turn.route as AgentRunRoute)
    : 'generated_answer';
  const trustState: AgentRunTrustState = AGENT_RUN_TRUST_STATES.has(turn.trustLabel as AgentRunTrustState)
    ? (turn.trustLabel as AgentRunTrustState)
    : turn.certification === 'certified'
      ? 'certified'
      : 'not_applicable';
  const status: AgentRunStatus = AGENT_RUN_STATUSES.has(turn.runStatus as AgentRunStatus)
    ? (turn.runStatus as AgentRunStatus)
    : 'completed';
  const stopReason: AgentRunStopReason = AGENT_RUN_STOP_REASONS.has(turn.stopReason as AgentRunStopReason)
    ? (turn.stopReason as AgentRunStopReason)
    : status === 'cancelled'
      ? 'cancelled'
      : status === 'blocked'
      ? 'blocked'
      : status === 'needs_clarification'
        ? 'needs_clarification'
        : status === 'needs_review'
          ? 'human_review_required'
          : route === 'conversation'
            ? 'conversational_reply'
            : trustState === 'certified'
              ? 'certified_answer_found'
              : 'artifact_created';
  const columns = (turn.result?.columns ?? []).filter((column): column is string => typeof column === 'string');
  const columnsMeta = (turn.result?.columnsMeta ?? []).filter((meta): meta is NonNullable<AgentConversationTurn['result']>['columnsMeta'] extends (infer M)[] | undefined ? M : never => Boolean(meta && typeof meta === 'object' && typeof (meta as { name?: unknown }).name === 'string'));
  // Stored samples are positional arrays; rebuild keyed rows for the result view.
  const rows = (turn.result?.rowsSample ?? [])
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
  const result = columns.length > 0
    ? { columns, rows, rowCount: turn.result?.rowCount ?? rows.length, ...(columnsMeta.length ? { columnsMeta } : {}) }
    : undefined;
  const artifact: AgentRunArtifact | undefined = result || turn.sql || turn.dqlArtifact || turn.sourceCertifiedBlock
    ? {
        id: `${turn.id}-artifact`,
        kind: 'answer',
        title: turn.sourceCertifiedBlock ?? turn.question,
        trustState,
        ref: turn.sourceCertifiedBlock,
        payload: {
          ...(turn.sourceCertifiedBlock ? { sourceCertifiedBlock: turn.sourceCertifiedBlock } : {}),
          ...(turn.certification ? { certification: turn.certification } : {}),
          ...(turn.contextPackId ? { contextPackId: turn.contextPackId } : {}),
          ...(turn.sql ? { sql: turn.sql } : {}),
          ...(turn.dqlArtifact ? { dqlArtifact: turn.dqlArtifact } : {}),
          ...(turn.cascade ? { cascade: turn.cascade } : {}),
          ...(result ? { result } : {}),
          ...(turn.contract && Object.keys(turn.contract).length > 0
            ? { contextPack: { questionPlan: { requestedShape: turn.contract } } }
            : {}),
        },
      }
    : undefined;
  return {
    id: turn.id,
    question: turn.question,
    requestedMode: 'auto',
    route,
    status,
    trustState,
    stopReason,
    startedAt: turn.createdAt,
    completedAt: turn.createdAt,
    summary: turn.answerSummary ?? turn.question,
    answer: turn.answerText ?? turn.answerSummary,
    answerKind: route === 'conversation' ? 'conversational' : undefined,
    narrationIntegrityReceipt: turn.narrationIntegrityReceipt,
    steps: [],
    artifacts: artifact ? [artifact] : [],
    evaluations: [],
    events: [],
    nextActions: [],
    repairAttempts: 0,
    // The saved run this turn came from, so "How it was answered" can read its record back.
    ...(turn.agentRunId ? { agentRunId: turn.agentRunId } : {}),
  };
}

function routeMatchLabel(route?: AgentRunRoute): string {
  switch (route) {
    case 'certified_answer': return 'Found a compatible certified saved query';
    case 'semantic_answer': return 'Found a compatible semantic metric';
    case 'generated_answer': return 'Identified the relevant tables and columns';
    case 'research': return 'Identified evidence for deeper analysis';
    case 'app_build': return 'Found governed assets for the app';
    case 'sql_cell': return 'Identified the query context';
    case 'dql_block_draft': return 'Identified reusable governed logic';
    case 'modeling_draft': return 'Resolved current models and relationship evidence';
    case 'skill_draft': return 'Resolved current domain guidance and governed references';
    case 'clarify': return 'Identified a missing business detail';
    case 'cancelled': return 'Stopped by user';
    default: return 'Identified the best answer path';
  }
}

function routeExecutionLabel(route: AgentRunRoute | undefined, events: AgentRunEvent[]): string {
  if (events.some((event) => event.type === 'repair.attempted')) return 'Refining the query and trying again';
  if (events.some((event) => event.type === 'escalated')) return 'Expanding the evidence search';
  switch (route) {
    case 'certified_answer':
    case 'semantic_answer': return 'Running the semantic query';
    case 'generated_answer': return 'Building and running a grounded query';
    case 'research': return 'Researching the strongest evidence';
    case 'app_build': return 'Assembling the app from governed assets';
    case 'sql_cell': return 'Building and checking the SQL';
    case 'dql_block_draft': return 'Drafting the governed logic';
    case 'modeling_draft': return 'Building a reviewable modeling proposal';
    case 'skill_draft': return 'Building a reviewable Skill proposal';
    case 'clarify': return 'Preparing a focused clarification';
    default: return 'Preparing the answer';
  }
}

/** The route of the latest routed step, if any (drives conversation-aware chrome). */
function latestRoute(events: AgentRunEvent[]): AgentRunRoute | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].route) return events[i].route;
  }
  return undefined;
}

export interface LongRunGuidance {
  title: string;
  detail: string;
}

/** UI-003 — progressive, actionable copy for genuinely long governed work. */
export function longRunGuidanceFor(
  elapsedSeconds: number,
  route?: AgentRunRoute,
  hasRepair = false,
): LongRunGuidance | null {
  if (elapsedSeconds < 12) return null;
  if (!route && elapsedSeconds < 24 && !hasRepair) {
    return {
      title: 'Still resolving the governed evidence',
      detail: 'The bounded request is still selecting its answer path. ZLens will stop at the normal deadline instead of silently switching to a longer workflow.',
    };
  }
  if (route === 'research') {
    return {
      title: 'Deep research is validating the analysis',
      detail: 'This can use several AI and SQL steps. Reusable relationships and semantic metrics make future investigations faster; reviewed repeat answers can be saved and certified.',
    };
  }
  return {
    title: hasRepair ? 'Applying one bounded query repair' : 'Finishing the bounded query path',
    detail: 'ZLens is compiling or running the selected governed path. An ordinary lookup stops at its deadline instead of silently restarting as Research.',
  };
}

/** UI-003 — keep the optimization path visible beside the completed result. */
export function completedRunGuidanceFor(
  elapsedSeconds: number,
  route: AgentRunRoute,
  trustState: AgentRunTrustState,
  repairAttempts: number,
): LongRunGuidance | null {
  if (trustState === 'certified' || (elapsedSeconds < 20 && repairAttempts === 0)) return null;
  if (route !== 'research' && route !== 'generated_answer') return null;
  return {
    title: route === 'research' ? 'Make future research faster' : 'Make this question faster next time',
    detail: 'If this analysis is reusable, save it as a saved query, review it, then certify it. Add repeated joins to Domain Modeling and reusable measures to the semantic layer to reduce future AI work and token usage.',
  };
}

/** One step of an Ask run's story: what it searched, what it missed, what ran. */
export interface AskStoryStep {
  phase: string;
  title: string;
  detail?: string;
  state: 'done' | 'missed' | 'failed';
  ms?: number;
  at: number;
}

function askStoryStepOf(value: unknown): AskStoryStep | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.title !== 'string' || typeof record.at !== 'number') return undefined;
  const state = record.state === 'missed' || record.state === 'failed' ? record.state : 'done';
  return {
    phase: typeof record.phase === 'string' ? record.phase : 'step',
    title: record.title,
    state,
    at: record.at,
    ...(typeof record.detail === 'string' && record.detail ? { detail: record.detail } : {}),
    ...(typeof record.ms === 'number' ? { ms: record.ms } : {}),
  };
}

/** The story steps a live run has streamed so far, in order. */
export function askStoryStepsFromEvents(events: AgentRunEvent[]): AskStoryStep[] {
  return events
    .map((event) => askStoryStepOf((event.payload as { askStep?: unknown } | undefined)?.askStep))
    .filter((entry): entry is AskStoryStep => Boolean(entry));
}

/** The story a finished run kept on its pipeline receipt. */
export function askStoryStepsFromReceipt(receipt: unknown): AskStoryStep[] {
  const story = receipt && typeof receipt === 'object' ? (receipt as { story?: unknown }).story : undefined;
  return Array.isArray(story) ? story.map(askStoryStepOf).filter((entry): entry is AskStoryStep => Boolean(entry)) : [];
}

/** Live events kept for the progress view: every story step, plus the most recent other events. */
export function retainLiveAgentEvents(events: AgentRunEvent[], tail = 8): AgentRunEvent[] {
  const others = new Set(events.filter((event) => !askStoryStepOf((event.payload as { askStep?: unknown } | undefined)?.askStep)).slice(-tail));
  return events.filter((event) => others.has(event) || Boolean(askStoryStepOf((event.payload as { askStep?: unknown } | undefined)?.askStep)));
}

/**
 * What the run is doing right now, named from the last step it finished: the
 * long wait is usually an AI call, and "Working" alone does not say so.
 */
export function askStoryActiveLabel(steps: AskStoryStep[]): string {
  const last = steps[steps.length - 1];
  if (!last) return 'Searching the project';
  const researching = investigationActiveLabel(last);
  if (researching) return researching;
  const title = last.title;
  if (last.phase === 'context') return 'Asking the AI to read the question';
  if (title === 'Asked the AI to read the question' || title === 'Asked the AI to correct its reading' || title.startsWith('Asked the AI to read the question again')) return 'Checking the reading against the project';
  if (title.startsWith('Fetched ')) return 'Asking the AI to read the question with those fields';
  if (title.startsWith('Searched every table for the missing field: found')) return 'Asking the AI to draft SQL with those tables';
  if (last.phase === 'read') return 'Looking for a certified saved query or semantic metric';
  // The first title is what runs stored before the two-governed-sources change say.
  if (title === 'Asking the AI to write SQL from the tables' || title === 'No governed answer: asking the tables directly' || (last.phase === 'schema' && title.startsWith('Chose '))) return 'Asking the AI to draft SQL from the tables';
  if (last.phase === 'schema' && /^(Re)?[Dd]rafted SQL/.test(title)) return 'Running the drafted query';
  if (last.phase === 'execute' && last.state === 'failed') return 'Asking the AI to correct the query';
  if (last.phase === 'tier' && last.state === 'done') return 'Running the query';
  if (last.phase === 'join') return 'Preparing the query again with the proven join';
  if (last.phase === 'execute') return 'Writing the answer';
  return 'Looking for a certified saved query or semantic metric';
}

export function formatStepDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 50) return '';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

export function AskStoryList({ steps, t, active }: { steps: AskStoryStep[]; t: Theme; active?: string }): JSX.Element {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  return (
    <ol aria-label="What the agent did" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 5 }}>
      {steps.map((entry, index) => {
        const color = entry.state === 'failed' ? 'var(--status-warning)' : entry.state === 'missed' ? t.textMuted : t.textSecondary;
        const expanded = Boolean(open[index]);
        const sqlLike = entry.phase === 'schema' && /^\s*(select|with)\b/i.test(entry.detail ?? '');
        return (
          <li key={`${entry.at}-${index}`} style={{ display: 'grid', gridTemplateColumns: '16px minmax(0, 1fr) auto', columnGap: 9, alignItems: 'start' }}>
            <span aria-hidden="true" style={{ height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color }}>
              {entry.state === 'done' ? <Check size={12} strokeWidth={2.2} /> : entry.state === 'failed' ? <X size={12} strokeWidth={2.2} /> : <ChevronRight size={12} strokeWidth={2.2} />}
            </span>
            <span style={{ minWidth: 0 }}>
              {entry.detail ? (
                <button
                  type="button"
                  className="dql-hover"
                  aria-expanded={expanded}
                  onClick={() => setOpen((current) => ({ ...current, [index]: !current[index] }))}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', color: entry.state === 'missed' ? t.textMuted : t.textPrimary, fontSize: 12.5, lineHeight: 1.4, fontFamily: t.font, display: 'inline-flex', alignItems: 'baseline', gap: 4 }}
                >
                  {entry.title}
                  {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                </button>
              ) : (
                <span style={{ color: entry.state === 'missed' ? t.textMuted : t.textPrimary, fontSize: 12.5, lineHeight: 1.4 }}>{entry.title}</span>
              )}
              {entry.detail && expanded ? (
                <span style={{ display: 'block', marginTop: 3, fontSize: 11, lineHeight: 1.45, color: t.textMuted, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: sqlLike ? 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)' : t.font }}>{entry.detail}</span>
              ) : null}
            </span>
            <span style={{ fontSize: 10.5, lineHeight: '18px', color: t.textMuted, fontVariantNumeric: 'tabular-nums' }}>{formatStepDuration(entry.ms)}</span>
          </li>
        );
      })}
      {active ? (
        <li style={{ display: 'grid', gridTemplateColumns: '16px minmax(0, 1fr)', columnGap: 9, alignItems: 'center', color: t.textPrimary }}>
          <span aria-hidden="true" style={{ display: 'inline-flex', justifyContent: 'center' }}><AgentThinkingDots /></span>
          <span style={{ fontSize: 12.5, lineHeight: 1.4, fontWeight: 620 }}>{active}</span>
        </li>
      ) : null}
    </ol>
  );
}

/** The kept story of a finished Ask run, collapsed to one line until opened. */
export function AskRunStory({ receipt, t }: { receipt: unknown; t: Theme }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const steps = askStoryStepsFromReceipt(receipt);
  if (steps.length === 0) return null;
  const timings = receipt && typeof receipt === 'object' ? (receipt as { timings?: Record<string, number> }).timings : undefined;
  const total = typeof timings?.total === 'number' ? timings.total + (typeof timings.context === 'number' ? timings.context : 0) : undefined;
  const missed = steps.filter((entry) => entry.state !== 'done').length;
  return (
    <div style={{ display: 'grid', gap: 7 }}>
      <button
        type="button"
        className="dql-hover"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: t.textMuted, fontSize: 11.5, fontFamily: t.font }}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {`${total !== undefined ? `Worked for ${formatStepDuration(total) || 'under a second'} · ` : ''}${steps.length} step${steps.length === 1 ? '' : 's'}${missed ? ` · ${missed} looked and missed` : ''}`}
      </button>
      {expanded ? <div style={{ paddingLeft: 4 }}><AskStoryList steps={steps} t={t} /></div> : null}
    </div>
  );
}

export interface LiveAgentActivity {
  id: 'search' | 'match' | 'execute' | 'verify' | 'background';
  label: string;
  state: 'complete' | 'active';
}

/**
 * A small, evidence-safe activity trail for the live response. Technical engine
 * phases such as planning and validation are intentionally translated into what
 * the user can observe: searching, matching, querying, and checking the result.
 */
export function liveAgentActivityFor(events: AgentRunEvent[], reconnecting = false): LiveAgentActivity[] {
  if (events.length === 0 && reconnecting) {
    return [{ id: 'background', label: 'Continuing this request in the background', state: 'active' }];
  }
  const route = latestRoute(events);
  if (route === 'conversation') return [];
  const hasRoute = events.some((event) => event.type === 'route.decided');
  const hasExecution = events.some((event) =>
    event.type === 'executor.started'
    || event.type === 'step.started'
    || event.type === 'repair.attempted'
    || event.type === 'escalated'
  );
  const hasEvaluation = events.some((event) => event.type === 'evaluation.recorded');
  const activity: LiveAgentActivity[] = [{
    id: 'search',
    label: 'Resolving governed evidence and business meaning',
    state: hasRoute ? 'complete' : 'active',
  }];
  if (hasRoute) {
    activity.push({
      id: 'match',
      label: routeMatchLabel(route),
      state: hasExecution || hasEvaluation ? 'complete' : 'active',
    });
  }
  if (hasExecution || hasEvaluation) {
    activity.push({
      id: 'execute',
      label: routeExecutionLabel(route, events),
      state: hasEvaluation ? 'complete' : 'active',
    });
  }
  if (hasEvaluation) {
    activity.push({
      id: 'verify',
      label: 'Checking the result against governed evidence',
      state: 'active',
    });
  }
  return activity;
}

/**
 * Live agent activity — a transient, boxless activity trail. It reports the
 * evidence and execution path without exposing the old planner/validator state
 * machine, and disappears as soon as the final answer is available.
 */
function RunProgress({ events, t, streamingAnswer, thinkingMode, backgroundRun }: {
  events: AgentRunEvent[];
  t: Theme;
  streamingAnswer?: string;
  thinkingMode?: AgentThinkingMode;
  backgroundRun?: PendingAgentRun | null;
}) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const runStartedAt = backgroundRun?.startedAt ?? events.find((event) => event.type === 'run.started')?.at;
  const startedAtMs = runStartedAt ? Date.parse(runStartedAt) : clock;
  const elapsedSeconds = Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((clock - startedAtMs) / 1_000)) : 0;
  const longRunGuidance = longRunGuidanceFor(
    elapsedSeconds,
    latestRoute(events),
    events.some((event) => event.type === 'repair.attempted'),
  );
  // The activity trail is transient. As soon as answer text starts streaming,
  // replace it with the answer itself; when the run completes this component is
  // unmounted, leaving no planning/validation chrome beside the final response.
  if (streamingAnswer) {
    return (
      <div style={{ alignSelf: 'stretch', padding: '4px 2px 8px', fontSize: 13.5, lineHeight: 1.55, color: t.textPrimary, whiteSpace: 'pre-wrap', animation: 'dql-agent-fadein 0.22s ease-out' }}>
        {streamingAnswer}
      </div>
    );
  }
  const isConversation = latestRoute(events) === 'conversation';
  if (isConversation) {
    return (
      <div role="status" aria-live="polite" style={{ alignSelf: 'stretch', display: 'flex', alignItems: 'center', gap: 9, padding: '5px 2px 9px', color: t.textSecondary, animation: 'dql-agent-fadein 0.22s ease-out' }}>
        <AgentThinkingDots />
        <span style={{ fontSize: 13, lineHeight: 1.4 }}>Replying…</span>
      </div>
    );
  }
  const storySteps = askStoryStepsFromEvents(events);
  if (storySteps.length > 0) {
    return (
      <div role="status" aria-live="polite" aria-label="Agent activity" style={{ alignSelf: 'stretch', display: 'grid', gap: 7, padding: '5px 2px 10px', animation: 'dql-agent-fadein 0.22s ease-out' }}>
        <AskStoryList steps={storySteps} t={t} active={`${askStoryActiveLabel(storySteps)} · ${elapsedSeconds} s`} />
      </div>
    );
  }
  const activity = liveAgentActivityFor(events, Boolean(backgroundRun));
  const waitHint = elapsedSeconds >= 12
    ? longRunGuidance?.title
    : thinkingMode === 'high'
      ? 'Thorough mode is cross-checking the result.'
      : null;
  return (
    <div role="status" aria-live="polite" aria-label="Agent activity" style={{ alignSelf: 'stretch', display: 'grid', gap: 7, padding: '5px 2px 10px', animation: 'dql-agent-fadein 0.22s ease-out' }}>
      {activity.map((item) => (
        <div key={item.id} className="dql-agent-activity" style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 18, color: item.state === 'active' ? t.textPrimary : t.textMuted }}>
          <span aria-hidden="true" style={{ width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', color: item.state === 'active' ? t.accent : t.textMuted }}>
            {item.state === 'active' ? <AgentThinkingDots /> : <Check size={13} strokeWidth={2.2} />}
          </span>
          <span style={{ fontSize: 12.5, lineHeight: 1.4, fontWeight: item.state === 'active' ? 620 : 450 }}>
            {item.label}{item.state === 'active' ? '…' : ''}
          </span>
        </div>
      ))}
      {waitHint ? <span style={{ paddingLeft: 25, fontSize: 10.5, lineHeight: 1.4, color: t.textMuted }}>{waitHint}</span> : null}
    </div>
  );
}

function AgentThinkingDots(): JSX.Element {
  return (
    <span aria-hidden="true" style={{ width: 16, height: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
      {[0, 1, 2].map((index) => (
        <span key={index} className="dql-agent-thinking-dot" style={{ width: 3, height: 3, borderRadius: 999, background: 'var(--accent)', animationDelay: `${index * 120}ms` }} />
      ))}
    </span>
  );
}

/** Render a capped list with a "Show all (N)" toggle instead of silently clipping. */
function ExpandableList<T>({ items, t, renderItem, cap = 4 }: {
  items: T[];
  t: Theme;
  renderItem: (item: T, index: number) => React.ReactNode;
  cap?: number;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, cap);
  return (
    <>
      {shown.map((item, index) => renderItem(item, index))}
      {items.length > cap ? (
        <button
          type="button"
          className="dql-hover"
          onClick={() => setExpanded((v) => !v)}
          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', color: t.accent, fontSize: 11, padding: '2px 0', display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {expanded ? 'Show less' : `Show all (${items.length})`}
        </button>
      ) : null}
    </>
  );
}

export function analyticalTaskOutcomePresentation(outcome: AnalyticalTaskOutcomeV1): {
  glyph: '✓' | '↳' | '!';
  label: string;
  detail: string;
  tone: 'success' | 'warning' | 'muted';
} {
  const summary = outcome.summary
    ?? (typeof outcome.gap?.message === 'string' ? outcome.gap.message : undefined)
    ?? 'Task outcome recorded.';
  if (outcome.status === 'completed' || outcome.status === 'partial') {
    return { glyph: '✓', label: outcome.status === 'partial' ? 'Partial result' : 'Completed', detail: summary, tone: 'success' };
  }
  if (outcome.status === 'dependency_blocked') {
    const dependencies = outcome.dependencyTaskIds?.length
      ? ` Waiting for ${outcome.dependencyTaskIds.join(', ')}.`
      : '';
    return { glyph: '↳', label: 'Dependency blocked', detail: `${summary}${dependencies}`, tone: 'muted' };
  }
  const failureCode = outcome.failure?.code ? ` (${outcome.failure.code})` : '';
  return { glyph: '!', label: outcome.status === 'gap' ? 'Needs coverage' : 'Blocked', detail: `${summary}${failureCode}`, tone: 'warning' };
}

export function AnalyticalTaskOutcomeList({
  outcomes,
  summary,
  t,
}: {
  // Persisted runs are local JSON. Keep the renderer defensive even if a
  // caller bypasses the store's V3 receipt normalizer.
  outcomes?: unknown;
  summary?: unknown;
  t: Theme;
}): JSX.Element | null {
  const safeOutcomes = Array.isArray(outcomes)
    ? outcomes.filter(isAnalyticalTaskOutcomeForDisplay)
    : [];
  const safeSummary = isAnalyticalTaskOutcomeSummaryForDisplay(summary) ? summary : undefined;
  // Keep the established single-task answer surface unchanged; this compact
  // receipt is only additional context for compound Ask outcomes.
  if (safeOutcomes.length < 2) return null;
  const heading = safeSummary
    ? safeSummary.status === 'completed'
      ? `Analytical tasks · ${safeSummary.taskCount} completed`
      : safeSummary.status === 'partial'
        ? `Analytical tasks · ${safeSummary.successfulTaskIds.length} of ${safeSummary.taskCount} completed`
        : 'Analytical tasks · no completed task'
    : 'Analytical tasks';
  return (
    <div style={{ display: 'grid', gap: 5, padding: '8px 10px', border: `1px solid ${t.cellBorder}`, borderRadius: 8, background: t.cellBg }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: t.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>{heading}</div>
      {safeOutcomes.map((outcome) => {
        const presentation = analyticalTaskOutcomePresentation(outcome);
        const color = presentation.tone === 'success' ? t.success : presentation.tone === 'muted' ? t.textMuted : t.warning;
        return (
          <div key={outcome.taskId} style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 11.5, color: t.textSecondary }}>
            <span style={{ color, fontWeight: 800 }}>{presentation.glyph}</span>
            <span><strong>{outcome.taskId}</strong> · <strong>{presentation.label}</strong> · {presentation.detail}</span>
          </div>
        );
      })}
    </div>
  );
}

function isAnalyticalTaskOutcomeForDisplay(value: unknown): value is AnalyticalTaskOutcomeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.taskId === 'string'
    && (record.status === 'completed' || record.status === 'partial' || record.status === 'gap'
      || record.status === 'blocked' || record.status === 'dependency_blocked');
}

function isAnalyticalTaskOutcomeSummaryForDisplay(value: unknown): value is AnalyticalTaskOutcomeSummaryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.status === 'completed' || record.status === 'partial' || record.status === 'blocked')
    && typeof record.taskCount === 'number'
    && Array.isArray(record.successfulTaskIds)
    && Array.isArray(record.failedTaskIds)
    && Array.isArray(record.dependencyBlockedTaskIds);
}

function RunCard({
  run,
  t,
  themeMode,
  appContext,
  onOpenApp,
  onInsertSql,
  onInsertDql,
  onOpenBlock,
  onOpenResearch,
  onSelectClarification,
  onNextAction,
}: {
  run: AgentRun;
  t: Theme;
  themeMode: ThemeMode;
  appContext?: { appId?: string; dashboardId?: string; dashboardTitle?: string };
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string, sourceAskRunId?: string) => void;
  onSelectClarification?: (option: AgentRunClarificationOption) => void;
  onNextAction: (action: AgentRun['nextActions'][number]) => void;
}) {
  const { dispatch } = useNotebook();
  const hostUiState = useHostUi();
  // A conversational reply renders as a plain assistant bubble — no route label,
  // trust badge, checks, or evidence. Just the answer + optional suggestion chips.
  if (run.route === 'conversation') {
    const isGeneralKnowledge = run.answerKind === 'general_knowledge';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: 'dql-agent-fadein 0.3s ease-out' }}>
        <div style={assistantBubbleStyle(t)}>
          {isGeneralKnowledge ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: t.textMuted, marginBottom: 6, fontWeight: 650 }}>
              <Lightbulb size={11} /> General knowledge — not from your data
            </div>
          ) : null}
          <div style={{ fontSize: 13.5, lineHeight: 1.55, color: t.textPrimary }}>
            {run.answer ? <StructuredAnswerText text={cleanAnswerText(run.answer)} t={t} /> : run.summary}
          </div>
        </div>
        {run.nextActions.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {run.nextActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="dql-hover dql-lift"
                onClick={() => onNextAction(action)}
                style={suggestionChipStyle(t)}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const steps = run.steps ?? [];
  const multiStep = steps.length > 1;
  const isLlmPlan = run.plan?.source === 'llm';
  const evidence = evidenceFromRun(run);
  const trustNote = trustExplainer(run);
  // A result worth saving: a real answer or research artifact (not blocked/clarify).
  const pinnable = isAgentRunPinnable(run);
  // Saving an answer as a block is authoring; under a host, only for people who may (HH-9).
  const mayAuthorBlocks = hostAllows(hostUiState, 'dataset.author');
  // Offer a one-click deepening on quick answers (unless the agent already routed deep).
  const isAnswer = run.route === 'certified_answer' || run.route === 'generated_answer';
  const hasResearchAction = run.nextActions.some((a) => a.route === 'research');
  const showResearchDeeper = isAnswer && pinnable && !hasResearchAction;
  const sourceArtifact = answerDqlArtifactFromRun(run);
  const canSaveBlock = mayAuthorBlocks && pinnable && !sourceArtifact?.sourcePath && Boolean(sourceArtifact?.source ?? answerSqlFromRun(run));
  const startedAtMs = Date.parse(run.startedAt);
  const completedAtMs = Date.parse(run.completedAt);
  const elapsedSeconds = Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
    ? Math.max(0, Math.round((completedAtMs - startedAtMs) / 1_000))
    : 0;
  const completedGuidance = completedRunGuidanceFor(elapsedSeconds, run.route, run.trustState, run.repairAttempts);
  return (
    <div style={runCardStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusIcon run={run} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 850, color: t.textPrimary }}>{simpleRunTitle(run)}</div>
        </div>
        <TrustBadge run={run} t={t} />
      </div>

      {trustNote ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11, color: t.textMuted, lineHeight: 1.4 }}>
          {run.trustState === 'certified' ? <ShieldCheck size={12} color={t.success} style={{ flex: '0 0 auto', marginTop: 1 }} /> : run.trustState === 'governed' || run.trustState === 'grounded' ? <ShieldCheck size={12} color={t.accent} style={{ flex: '0 0 auto', marginTop: 1 }} /> : <ShieldAlert size={12} color={t.warning} style={{ flex: '0 0 auto', marginTop: 1 }} />}
          <span>{trustNote}</span>
        </div>
      ) : null}
      <RunContextNote run={run} t={t} />

      {(isLlmPlan || multiStep || run.repairAttempts > 0) ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {isLlmPlan ? <MetaChip t={t} icon={<ListTree size={11} />} label="AI plan" tone="accent" /> : null}
          {multiStep ? <MetaChip t={t} icon={<Route size={11} />} label={`${steps.length} steps`} tone="muted" /> : null}
          {run.repairAttempts > 0 ? <MetaChip t={t} icon={<Wrench size={11} />} label={`${run.repairAttempts} repair${run.repairAttempts > 1 ? 's' : ''}`} tone="warning" /> : null}
        </div>
      ) : null}

      {run.summary && !(acceptedAskAnswer(run) && sameText(cleanPresentationText(run.summary), cleanAnswerText(acceptedAskAnswer(run)!))) ? (
        <div style={{ fontSize: 12.5, lineHeight: 1.45, color: t.textSecondary }}>{cleanPresentationText(run.summary)}</div>
      ) : null}
      {acceptedAskAnswer(run) ? <div style={answerBoxStyle(t)}><StructuredAnswerText text={cleanAnswerText(acceptedAskAnswer(run)!)} t={t} /></div> : null}

      <AnalyticalTaskOutcomeList
        outcomes={run.analyticalTaskOutcomes}
        summary={run.analyticalTaskOutcomeSummary}
        t={t}
      />

      <ClarificationChoiceList run={run} t={t} onSelect={onSelectClarification} />

      {evidence.length > 0 ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: t.textMuted }}>Evidence:</span>
          {evidence.map((ev) => (
            <span key={ev.label} style={evidenceChipStyle(t, ev.certified)}>
              {ev.certified ? <ShieldCheck size={11} /> : <FileSearch size={11} />}
              <span>{ev.label}</span>
            </span>
          ))}
        </div>
      ) : null}

      <AppliedLearnings run={run} t={t} />

      {run.artifacts.length > 0 ? (
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
          {run.artifacts.map((artifact) => (
            <ArtifactView
              key={artifact.id}
              artifact={artifact}
              t={t}
              themeMode={themeMode}
              onInsertSql={onInsertSql}
              onInsertDql={onInsertDql}
              sourceRunId={run.id}
              sourceQuestion={run.question}
              onOpenBlock={onOpenBlock}
              onOpenResearch={onOpenResearch}
              onOpenApp={onOpenApp}
              onNextAction={onNextAction}
            />
          ))}
        </div>
      ) : null}

      {multiStep ? (
        <StepTrace steps={steps} t={t} />
      ) : (
        <VerificationChecks evaluations={run.evaluations} t={t} />
      )}

      <CitedDocuments run={run} t={t} />

      <AskRunStory receipt={run.diagnosticReceiptV9} t={t} />

      {run.events.length > 0 || run.traceReference ? (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          {run.events.length > 0 ? (
            <button
              type="button"
              className="dql-hover"
              onClick={() => dispatch({ type: 'OPEN_AGENT_LOG', run })}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
                background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                color: t.textMuted, fontSize: 11.5, fontFamily: t.font,
              }}
              title="See what the agent did and where the time went"
            >
              <ListTree size={12} /> View steps · where the time went
            </button>
          ) : null}
          {run.traceReference ? (
            <button
              type="button"
              className="dql-hover"
              onClick={() => dispatch({ type: 'OPEN_ASK_TRACE', runId: run.id })}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
                background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                color: t.accent, fontSize: 11.5, fontFamily: t.font, fontWeight: 650,
              }}
              title="Open the local, redacted Ask trace"
            >
              <GitBranch size={12} /> Open full trace
            </button>
          ) : null}
        </div>
      ) : null}

      {completedGuidance ? (
        <div style={{ display: 'grid', gap: 3, padding: '8px 9px', border: `1px solid ${t.accent}33`, borderRadius: 7, background: `${t.accent}0a` }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: t.textSecondary, fontSize: 11, fontWeight: 800 }}>
            <Lightbulb size={11} color={t.accent} /> {completedGuidance.title}
          </span>
          <span style={{ fontSize: 10.5, color: t.textMuted, lineHeight: 1.45 }}>{completedGuidance.detail}</span>
        </div>
      ) : null}

      {/* RFC 0010 HH-9: the host's actions on an answer that needs review. */}
      <HostAnswerActions run={run} t={t} />

      {(pinnable || showResearchDeeper || run.nextActions.length > 0) ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {pinnable ? <AddToAppButton run={run} t={t} appContext={appContext} onOpenApp={onOpenApp} /> : null}
          {canSaveBlock ? (
            <button type="button" className="dql-hover" onClick={() => onNextAction({ id: 'save-dql-block', label: 'Save as saved query', route: 'dql_block_draft' })} style={smallButtonStyle(t)}>
              <Save size={11} /> Save as saved query
            </button>
          ) : null}
          {showResearchDeeper ? (
            <button
              type="button"
              className="dql-hover"
              onClick={() => onNextAction({ id: 'research-deeper', label: 'Research this deeper', route: 'research' })}
              style={smallButtonStyle(t)}
              title="Run a slower, multi-step investigation on this question"
            >
              <FileSearch size={11} />
              Research this deeper
            </button>
          ) : null}
          {/* confirm-app-build is owned by the proposal card itself, not a composer action. */}
          {run.nextActions.filter((a) => a.id !== 'pin-to-app' && a.id !== 'research-deeper' && a.id !== 'confirm-app-build' && a.id !== 'request-certification').map((action) => (
              <button
                key={action.id}
                type="button"
                className="dql-hover"
                onClick={() => onNextAction(action)}
                style={smallButtonStyle(t)}
              >
                {action.label}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Ask redesign — plain-text transcript, artifact chips, inspector, follow-up.
// Adopted from "Ask AI Redesign.dc.html". Reuses the existing run/artifact
// logic (ArtifactView, ResultView, AddToAppButton, trust helpers) so every
// api call and handoff keeps working.
// ══════════════════════════════════════════════════════════════════════════

export type AskInspectorTab = 'how' | 'dql' | 'sql' | 'data' | 'checks' | 'lineage' | 'trust';

/**
 * Failed analytical runs keep the complete research scaffold visible even when
 * compilation stopped before producing one of the text artifacts. This makes a
 * remounted Ask/Notebook/Block run explain what is absent instead of silently
 * removing its DQL or SQL section. Acceptance: UI-012, UI-013, E2E-015.
 */
export function askInspectorTabsForState(input: {
  analytical: boolean;
  blocked: boolean;
  hasDql: boolean;
  hasSql: boolean;
  hasLineage: boolean;
  /** The run carries the Ask pipeline's record: the step-by-step flow, data used and checks replace the older sections. */
  pipeline?: boolean;
  hasChecks?: boolean;
  /** The run is a Research investigation: its programs replace the step-by-step flow. */
  investigation?: boolean;
}): Array<{ id: AskInspectorTab; label: string }> {
  const tabs: Array<{ id: AskInspectorTab; label: string }> = [];
  if (input.investigation) {
    tabs.push({ id: 'how', label: 'How it was researched' });
    if (input.hasDql) tabs.push({ id: 'dql', label: 'DQL' });
    if (input.hasSql) tabs.push({ id: 'sql', label: 'SQL' });
    tabs.push({ id: 'trust', label: 'Trust & steps' });
    return tabs;
  }
  if (input.pipeline) {
    tabs.push({ id: 'how', label: 'How it answered' });
    if (input.hasDql) tabs.push({ id: 'dql', label: 'DQL' });
    if (input.hasSql) tabs.push({ id: 'sql', label: 'SQL' });
    tabs.push({ id: 'data', label: 'Data used' });
    if (input.hasChecks) tabs.push({ id: 'checks', label: 'Checks' });
    return tabs;
  }
  if (input.analytical) tabs.push({ id: 'how', label: 'How it answered' });
  if (input.hasDql || (input.analytical && input.blocked)) tabs.push({ id: 'dql', label: 'DQL' });
  if (input.hasSql || (input.analytical && input.blocked)) tabs.push({ id: 'sql', label: 'SQL' });
  if (input.hasLineage) tabs.push({ id: 'lineage', label: 'Lineage' });
  tabs.push({ id: 'trust', label: 'Trust & steps' });
  return tabs;
}

const ASK_KEYFRAMES = `
  @keyframes dql-agent-run-spin { to { transform: rotate(360deg); } }
  @keyframes dql-agent-fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  @keyframes dql-agent-thinking-dot { 0%, 65%, 100% { opacity: .28; transform: translateY(0); } 32% { opacity: 1; transform: translateY(-2px); } }
  @keyframes dql-agent-activity-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
  .dql-agent-thinking-dot { animation: dql-agent-thinking-dot 1.05s ease-in-out infinite; }
  .dql-agent-activity { animation: dql-agent-activity-in .22s ease-out; }
  .dql-hover { transition: filter .15s ease, transform .12s ease, box-shadow .15s ease, background .15s ease, color .15s ease, border-color .15s ease; }
  .dql-hover:hover { filter: brightness(1.03); }
  .dql-hover:active { transform: translateY(0.5px); }
  .dql-lift:hover { transform: translateY(-1px); }
  .dql-ask-ghost:hover { background: var(--bg-0); color: var(--text-primary) !important; }
  .dql-ask-chip:hover { border-color: var(--accent) !important; box-shadow: 0 1px 6px rgba(107,93,211,0.12); }
  .dql-ask-composer:focus-within { border-color: var(--border-focus, var(--accent)) !important; box-shadow: 0 0 0 2px color-mix(in srgb, var(--border-focus, var(--accent)) 35%, transparent), 0 6px 22px rgba(26,26,26,0.05) !important; }
  details > summary::-webkit-details-marker { display: none; }
  @media (prefers-reduced-motion: reduce) { .dql-agent-thinking-dot, .dql-agent-activity { animation: none !important; } }
`;

function askUserBubbleStyle(t: Theme): React.CSSProperties {
  return { alignSelf: 'flex-end', maxWidth: '82%', background: 'var(--bg-0)', color: t.textPrimary, borderRadius: '16px 16px 4px 16px', padding: '10px 14px', fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', animation: 'dql-agent-fadein 0.25s ease-out' };
}

function askGhostBtnStyle(t: Theme): React.CSSProperties {
  return controlStyle(t, { variant: 'ghost', size: 'sm' });
}

/** Rich artifacts render inline (they own interactive flows); the rest chip out. */
function isRichAskArtifact(artifact: AgentRunArtifact, payload: Record<string, unknown>): boolean {
  return artifact.kind === 'app_proposal'
    || artifact.kind === 'dql_block_draft'
    || artifact.kind === 'research_run'
    || Boolean(extractMixedSourceNotebookPlan(payload));
}

export function askArtifactMeta(artifact: AgentRunArtifact, payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const result = extractResult(payload);
  const kindLabel = artifact.kind === 'answer' ? (result?.rows?.length ? 'Table' : 'Answer')
    : artifact.kind === 'sql_cell' ? 'SQL'
    : artifact.kind === 'dql_block_draft' ? 'Saved query'
    : artifact.kind === 'research_run' ? 'Research'
    : 'Result';
  parts.push(kindLabel);
  const rowCount = result?.rowCount ?? result?.rows?.length;
  if (typeof rowCount === 'number') parts.push(`${rowCount} row${rowCount === 1 ? '' : 's'}`);
  if (typeof result?.executionTime === 'number' && result.executionTime > 0) {
    parts.push(result.executionTime >= 1000
      ? `${(result.executionTime / 1000).toFixed(1)}s`
      : `${result.executionTime.toFixed(result.executionTime < 10 ? 1 : 0)}ms`);
  }
  const compilationFailure = askCompilationFailureKind(payload);
  const provenance = artifact.trustState === 'certified'
    ? 'certified saved query'
    : artifact.trustState === 'governed' || artifact.trustState === 'grounded'
      ? 'governed'
      : artifact.trustState === 'blocked'
        ? compilationFailure === 'semantic'
          ? 'semantic compilation failed'
          : compilationFailure === 'generic'
            ? 'compilation failed'
            : 'blocked'
        // An investigation's figures can come from governed metrics; the report stays review-required.
        : artifact.kind === 'research_run' && investigationReportOf(payload)
          ? 'review required'
          : isAppViewPayload(payload)
            ? 'from this App · needs review'
            : answerSourceOfPayload(payload, artifact.trustState) === 'block_as_evidence'
              ? 'certified saved query · needs review'
              : answerSourceOfPayload(payload, artifact.trustState) === 'governed_definitions'
                ? 'governed definitions · needs review'
                : 'AI-generated';
  parts.push(provenance);
  return parts.join(' · ');
}

/**
 * Research verdicts are branch evidence, not generic run evaluations. The
 * route/catalog/workspace checks can all be informational while every actual
 * research branch failed, so never use their green count as a Research health
 * summary. This projection reads only the typed, persisted V2 ledger.
 */
export interface ResearchVerdictSummaryV1 {
  branchCount: number;
  groundableBranchCount: number;
  limitedScope: boolean;
  /** Additive V3 distinction: structural lineage is not analytical execution. */
  lineageBranchCount: number;
  verdicts: Record<'supported' | 'contradicted' | 'inconclusive' | 'failed' | 'skipped', number>;
  compactLabel: string;
  detail: string;
}

const RESEARCH_VERDICTS = ['supported', 'contradicted', 'inconclusive', 'failed', 'skipped'] as const;

export function researchVerdictSummary(payload: Record<string, unknown>): ResearchVerdictSummaryV1 | undefined {
  // V3 adds structural lineage evidence without teaching V1/V2 readers that a
  // graph walk is a result execution.  Older persisted runs retain the exact
  // V2 projection below.
  const ledger = recordOf(payload.researchLedgerV3) ?? recordOf(payload.researchLedgerV2);
  if (!ledger) return undefined;
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  const verdicts: ResearchVerdictSummaryV1['verdicts'] = {
    supported: 0,
    contradicted: 0,
    inconclusive: 0,
    failed: 0,
    skipped: 0,
  };
  for (const entry of entries) {
    const verdict = recordOf(entry)?.verdict;
    if (typeof verdict === 'string' && RESEARCH_VERDICTS.includes(verdict as typeof RESEARCH_VERDICTS[number])) {
      verdicts[verdict as keyof typeof verdicts] += 1;
    }
  }
  const branchCount = entries.length;
  const lineageBranchCount = entries.filter((entry) => recordOf(entry)?.evidenceKind === 'lineage_graph').length;
  const groundableBranchCount = typeof ledger.groundableBranchCount === 'number'
    && Number.isFinite(ledger.groundableBranchCount)
    && ledger.groundableBranchCount >= 0
    ? Math.trunc(ledger.groundableBranchCount)
    : branchCount;
  const limitedScope = ledger.limitedScope === true || groundableBranchCount < 3;
  const fragments = RESEARCH_VERDICTS.flatMap((verdict) => {
    const count = verdicts[verdict];
    if (!count) return [];
    return [`${count} ${verdict}`];
  });
  const branchLabel = branchCount === 0
    ? 'no branch verdicts recorded'
    : fragments.join(' · ');
  const compactLabel = limitedScope
    ? `Limited research scope · ${branchLabel}`
    : `Research branches · ${branchLabel}`;
  const lineageDetail = lineageBranchCount > 0
    ? ` ${lineageBranchCount} structural lineage ${lineageBranchCount === 1 ? 'check was' : 'checks were'} local-only and non-causal.`
    : '';
  const detail = limitedScope
    ? `Limited research scope: ${groundableBranchCount} of at least 3 evidence-supported branches were available. Verdicts: ${branchLabel}.${lineageDetail}`
    : `${groundableBranchCount} evidence-supported branches were available. Verdicts: ${branchLabel}.${lineageDetail}`;
  return { branchCount, groundableBranchCount, limitedScope, lineageBranchCount, verdicts, compactLabel, detail };
}

export function researchVerdictSummaryForRun(run: AgentRun): ResearchVerdictSummaryV1 | undefined {
  const researchArtifact = run.artifacts.find((artifact) => artifact.kind === 'research_run');
  return researchArtifact ? researchVerdictSummary(payloadOf(researchArtifact)) : undefined;
}

function resultCardTitle(run: AgentRun, artifact: AgentRunArtifact): string {
  const generic = /^(?:certified|governed semantic|review-required|exploratory dbt-grounded) answer$/i.test(artifact.title.trim());
  const source = generic ? run.question : artifact.title;
  const clean = cleanPresentationText(source).replace(/[?.!]+$/, '').trim();
  if (!clean) return 'Answer result';
  const title = clean.charAt(0).toUpperCase() + clean.slice(1);
  return title.length > 88 ? `${title.slice(0, 85).trimEnd()}…` : title;
}

interface AskLineageEntry {
  name: string;
  kind?: string;
  detail?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Legacy artifacts can lose the outer analytical-failure wrapper while
 * serializing a semantic adapter failure. The semantic receipt and the V4
 * terminal incident are both durable, typed pre-warehouse evidence, so use
 * them to keep the compact Ask card and failure hint phase-specific.
 */
function askCompilationFailureKind(payload: Record<string, unknown>): 'semantic' | 'generic' | undefined {
  const semanticTrace = recordOf(payload.semanticExecutionTrace);
  const traceFailure = recordOf(semanticTrace?.failure);
  if (
    traceFailure?.phase === 'compilation'
    && (traceFailure.code === 'SEMANTIC_COMPILATION_FAILED'
      || traceFailure.code === 'COMPILATION_FAILED')
  ) {
    return 'semantic';
  }

  const v4Diagnostic = recordOf(payload.diagnosticReceiptV4);
  const v4Terminal = recordOf(v4Diagnostic?.terminalIncident)
    ?? recordOf(recordOf(v4Diagnostic?.summary)?.terminalIncident);
  if (v4Terminal?.code === 'COMPILATION_FAILED') {
    return v4Terminal.boundary === 'semantic.compile' ? 'semantic' : 'generic';
  }

  const analyticalFailure = recordOf(payload.analyticalFailure);
  const failureCode = typeof analyticalFailure?.code === 'string'
    ? analyticalFailure.code
    : typeof payload.failureCode === 'string'
      ? payload.failureCode
      : undefined;
  const failurePhase = typeof analyticalFailure?.phase === 'string'
    ? analyticalFailure.phase
    : undefined;
  if (failureCode === 'COMPILATION_FAILED' && (failurePhase === undefined || failurePhase === 'compilation')) {
    return semanticTrace ? 'semantic' : 'generic';
  }
  return undefined;
}

function lineageEntriesFromRun(run: AgentRun): AskLineageEntry[] {
  const entries: AskLineageEntry[] = [];
  const seen = new Set<string>();
  const add = (value: unknown, fallbackKind?: string) => {
    const record = recordOf(value);
    if (!record) return;
    const name = [record.name, record.label, record.relation, record.objectName]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    if (!name) return;
    const kind = typeof record.kind === 'string' ? record.kind : fallbackKind;
    const key = `${kind ?? ''}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const detail = [record.description, record.provenance, record.sourceTier, record.source]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    entries.push({ name, kind, detail });
  };
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const evidence = recordOf(payload.evidence);
    for (const key of ['lineage', 'sourceTables', 'semanticObjects', 'selectedAssets'] as const) {
      const values = evidence?.[key];
      if (Array.isArray(values)) values.forEach((value) => add(value, key === 'sourceTables' ? 'source' : undefined));
    }
    const plan = recordOf(payload.analysisPlan) ?? recordOf(evidence?.analysisPlan);
    const candidates = plan?.candidateTables;
    if (Array.isArray(candidates)) candidates.forEach((value) => add(value, 'relation'));
  }
  return entries.slice(0, 24);
}

/** The Ask pipeline's record for a run: on the run itself, or on one of its answer payloads. */
/** The domain, skills and enforced filters that shaped an answer, in one quiet line. */
function RunContextNote({ run, t }: { run: Pick<AgentRun, 'diagnosticReceiptV9' | 'artifacts'>; t: Theme }) {
  const line = runContextLine(runContextSummary(askPipelineReceiptOf(run)));
  if (!line) return null;
  return <div data-testid="run-context-note" style={{ fontSize: 10.5, color: t.textMuted, lineHeight: 1.45 }}>{line}</div>;
}

export function askPipelineReceiptOf(run: Pick<AgentRun, 'diagnosticReceiptV9' | 'artifacts'>): Record<string, unknown> | undefined {
  if (isAskPipelineReceipt(run.diagnosticReceiptV9)) return run.diagnosticReceiptV9;
  const onPayload = (run.artifacts ?? []).map((artifact) => payloadOf(artifact).askPipeline).find(isAskPipelineReceipt);
  return onPayload as Record<string, unknown> | undefined;
}

export function hasAskPipelineReceipt(run: Pick<AgentRun, 'diagnosticReceiptV9' | 'artifacts'>): boolean {
  return Boolean(askPipelineReceiptOf(run));
}

export function preferredAskInspectorTab(run: AgentRun, artifact: AgentRunArtifact): AskInspectorTab {
  const payload = payloadOf(artifact);
  if (hasAskPipelineReceipt(run)) return 'how';
  if (run.diagnosticReceiptV8?.mode === 'authoritative_v2' || hasAnalyticalInspectorContract(payload)) return 'how';
  if ((answerDqlArtifactFromRun(run) ?? resolveArtifactDqlView(payload))?.source) return 'dql';
  if (answerSqlFromRun(run) ?? (typeof payload.sql === 'string' ? payload.sql : undefined)) return 'sql';
  if (lineageEntriesFromRun(run).length > 0) return 'lineage';
  return 'trust';
}

function InlineAskResultCard({
  run,
  artifact,
  selected,
  t,
  themeMode,
  onInspect,
}: {
  run: AgentRun;
  artifact: AgentRunArtifact;
  selected: boolean;
  t: Theme;
  themeMode: ThemeMode;
  onInspect: (tab: AskInspectorTab) => void;
}) {
  const payload = payloadOf(artifact);
  const result = extractResult(payload);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [expanded]);
  if (!result) return null;
  const chartConfig = inlineAskChartConfig(payload, result);
  const inspectorTab = preferredAskInspectorTab(run, artifact);
  const dqlArtifact = answerDqlArtifactFromRun(run) ?? resolveArtifactDqlView(payload);
  const certifiedName = artifact.trustState === 'certified' ? certifiedBlockName(artifact, payload) : undefined;
  const card = (
    <section
      data-followup="table"
      data-followup-run-id={run.id}
      data-followup-artifact-id={artifact.id}
      aria-label={`${resultCardTitle(run, artifact)} result`}
      style={{
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`,
        borderRadius: 12,
        background: 'var(--bg-2)',
        overflow: 'hidden',
        boxShadow: expanded ? '0 24px 80px rgba(15,23,42,0.28)' : selected ? '0 2px 10px rgba(107,93,211,0.12)' : '0 1px 3px rgba(26,26,26,0.04)',
        ...(expanded ? { width: 'min(1440px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 48px)' } : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ width: 30, height: 30, borderRadius: 8, background: artifact.trustState === 'certified' ? 'var(--status-success-bg)' : 'var(--accent-dim)', color: artifact.trustState === 'certified' ? 'var(--status-success)' : 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <ArtifactIcon kind={artifact.kind} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: t.textPrimary, lineHeight: 1.35 }}>{resultCardTitle(run, artifact)}</div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>{askArtifactMeta(artifact, payload)}</div>
        </div>
        <button type="button" className="dql-ask-ghost" onClick={() => onInspect(inspectorTab)} style={askGhostBtnStyle(t)}>
          <ListTree size={12} /> Inspect
        </button>
        <button
          type="button"
          className="dql-ask-ghost"
          aria-label={expanded ? 'Return result to Copilot' : 'Expand result'}
          title={expanded ? 'Return result to Copilot' : 'Expand this result for wide tables'}
          onClick={() => setExpanded((value) => !value)}
          style={askGhostBtnStyle(t)}
        >
          {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          {expanded ? 'Restore' : 'Expand result'}
        </button>
      </div>
      {dqlArtifact ? (
        <ExecutableDqlResult
          artifact={dqlArtifact}
          certifiedBlockName={certifiedName}
          initialResult={result}
          initialChartConfig={chartConfig}
          payload={payload}
          executionTarget={run.executionTarget}
          t={t}
          themeMode={themeMode}
          embedded
          expanded={expanded}
        />
      ) : (
        <ResultView
          result={result}
          themeMode={themeMode}
          t={t}
          chartConfig={chartConfig}
          embedded
          tabLabels={{ table: 'Results', chart: 'Visualization' }}
          contentMaxHeight={expanded ? 'calc(100vh - 172px)' : undefined}
          tableMaxHeight={expanded ? 'calc(100vh - 250px)' : undefined}
        />
      )}
    </section>
  );

  if (!expanded || typeof document === 'undefined') return card;
  return (
    <>
      <div style={{ minHeight: 96, border: '1px dashed var(--border-default)', borderRadius: 12, display: 'grid', placeItems: 'center', color: t.textMuted, fontSize: 11.5 }}>
        Result is open in the expanded viewer.
      </div>
      {createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${resultCardTitle(run, artifact)} expanded result`}
          onClick={() => setExpanded(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 120, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(15,23,42,0.48)', backdropFilter: 'blur(3px)' }}
        >
          <div onClick={(event) => event.stopPropagation()} style={{ minWidth: 0, maxWidth: '100%' }}>
            {card}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

interface AskRunCardProps {
  run: AgentRun;
  t: Theme;
  themeMode: ThemeMode;
  threadId?: string;
  appContext?: { appId?: string; dashboardId?: string; dashboardTitle?: string };
  selectedArtifactId?: string;
  onOpenArtifact?: (artifactId: string, tab: AskInspectorTab) => void;
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  onReplaceDql?: (payload: InsertDqlPayload) => void;
  insertDqlActionLabel?: string;
  replaceDqlActionLabel?: string;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string, sourceAskRunId?: string) => void;
  onSelectClarification?: (option: AgentRunClarificationOption) => void;
  onNextAction: (action: AgentRun['nextActions'][number]) => void;
  onRepairedRun: (sourceRunId: string, repairedRun: AgentRun) => void;
}

function AskRunCard(props: AskRunCardProps) {
  const {
  run,
  t,
  themeMode,
  threadId,
  appContext,
  selectedArtifactId,
  onOpenArtifact,
  onOpenApp,
  onInsertSql,
  onInsertDql,
  onReplaceDql,
  insertDqlActionLabel,
  replaceDqlActionLabel,
  onOpenBlock,
  onOpenResearch,
  onSelectClarification,
  onNextAction,
  onRepairedRun,
  } = props;
  const { dispatch } = useNotebook();
  const hostUiState = useHostUi();
  const [copied, setCopied] = useState(false);
  const openArtifact = onOpenArtifact ?? (() => dispatch({ type: 'OPEN_AGENT_LOG', run }));

  // Conversational replies stay a plain bubble — no trust line, chips, or actions.
  if (run.route === 'conversation') {
    const isGeneralKnowledge = run.answerKind === 'general_knowledge';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, animation: 'dql-agent-fadein 0.3s ease-out', maxWidth: '100%' }}>
        {isGeneralKnowledge ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: t.textMuted, fontWeight: 650 }}>
            <Lightbulb size={11} /> General knowledge — not from your data
          </div>
        ) : null}
        <div data-followup="answer" style={{ fontSize: 14.5, lineHeight: 1.65, color: t.textPrimary }}>
          {run.answer ? <StructuredAnswerText text={cleanAnswerText(run.answer)} t={t} /> : run.summary}
        </div>
        {run.nextActions.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {run.nextActions.map((action) => (
              <button key={action.id} type="button" className="dql-hover dql-lift" onClick={() => onNextAction(action)} style={suggestionChipStyle(t)}>{action.label}</button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const certified = run.trustState === 'certified';
  const blocked = run.status === 'blocked';
  const cancelled = run.status === 'cancelled' || run.stopReason === 'cancelled' || run.route === 'cancelled';
  const needsClarification = run.status === 'needs_clarification';
  // A clarify turn's `answer` IS the question being asked, and a blocked run's
  // `answer` is the business-language reason the loop wrote. Dropping both left
  // the user with a canned headline and nothing actionable underneath.
  const presentationAnswer = acceptedAskAnswer(run);
  const outcomeLabel = cancelled
    ? 'Stopped by user'
    : blocked
    ? (askNeedsAiProvider(run) ? ASK_NEEDS_AI_PROVIDER_HEADING : askFailureOrigin(run) === 'no_data' ? 'No matching data' : 'Couldn’t run this query')
    : needsClarification
      ? 'Needs clarification'
      : !certified && !readFromAppView(run) && run.artifacts.some((artifact) => artifact.kind === 'research_run' && investigationReportOf(payloadOf(artifact)))
        ? 'Research report'
        // One trust decision: the heading, the badge and the card read the same trust and source.
        : answerTrustHeading(run);
  // The card supplies its own headline, so the body wants the most SPECIFIC text
  // available: the producer's own message beats the canned per-code headline,
  // which is the same sentence for everything unclassified.
  const failureMessage = cancelled ? (run.summary || 'Stopped by user.') : blocked ? askFailureDetail(run) : undefined;
  const captureWarning = askRunCaptureWarning(run);
  const evidence = evidenceFromRun(run);
  const certifiedSource = certified ? certifiedBlockSourceFromRun(run) : undefined;
  // A host kept this answer's figures from this person until someone checks it (RFC 0010 HH-14).
  const figuresWithheld = (run as { figuresWithheld?: boolean }).figuresWithheld === true;
  const displayArtifacts = cancelled || figuresWithheld ? [] : run.artifacts;
  const inlineResultArtifacts = displayArtifacts.filter((artifact) => {
    const payload = payloadOf(artifact);
    return !isRichAskArtifact(artifact, payload) && Boolean(extractResult(payload));
  });
  const inlineResultIds = new Set(inlineResultArtifacts.map((artifact) => artifact.id));
  const chipArtifacts = displayArtifacts.filter((a) => !isRichAskArtifact(a, payloadOf(a)) && !inlineResultIds.has(a.id));
  const richArtifacts = displayArtifacts.filter((a) => isRichAskArtifact(a, payloadOf(a)));
  const primaryArtifact = inlineResultArtifacts[0] ?? chipArtifacts[0] ?? displayArtifacts[0];
  const researchArtifact = displayArtifacts.find((artifact) => artifact.kind === 'research_run');
  const researchVerdicts = researchVerdictSummaryForRun(run);
  const passedChecks = researchVerdicts ? 0 : run.evaluations.filter((e) => e.severity === 'info').length;

  // Reuse RunCard's action gating so the quiet row offers the same real actions.
  const pinnable = isAgentRunPinnable(run);
  // Saving an answer as a block is authoring; under a host, only for people who may (HH-9).
  const mayAuthorBlocks = hostAllows(hostUiState, 'dataset.author');
  const isAnswer = run.route === 'certified_answer' || run.route === 'semantic_answer' || run.route === 'generated_answer';
  const hasResearchAction = run.nextActions.some((a) => a.route === 'research');
  const showResearchDeeper = isAnswer && pinnable && !hasResearchAction;
  const sourceArtifact = answerDqlArtifactFromRun(run);
  const canSaveBlock = mayAuthorBlocks && pinnable && !sourceArtifact?.sourcePath && Boolean(sourceArtifact?.source ?? answerSqlFromRun(run));
  const insertionPayload = (insertDqlActionLabel && onInsertDql) || (replaceDqlActionLabel && onReplaceDql)
    ? artifactReadyPayloadFromRun(run)
    : undefined;

  const copyAnswer = () => {
    const text = presentationAnswer ? cleanAnswerText(presentationAnswer) : failureMessage ?? run.summary;
    if (!text) return;
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: '100%', animation: 'dql-agent-fadein 0.3s ease-out' }}>
      {/* Trust line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        {cancelled
          ? <Route size={14} color={t.textMuted} />
          : blocked
          ? <ShieldAlert size={14} color={t.error} />
          : certified
            ? <ShieldCheck size={14} color={t.success} />
            : <Sparkles size={14} color={t.accent} />}
        <span style={{ fontSize: 12, fontWeight: 650, color: cancelled ? t.textMuted : blocked ? t.error : t.textSecondary }}>{outcomeLabel}</span>
        {certified && certifiedSource ? (
          <CertifiedBlockSource source={certifiedSource} t={t} />
        ) : certified && evidence[0] ? (
          <span style={{ fontSize: 11, color: t.textMuted }}>from <span style={{ color: t.accent, fontWeight: 600 }}>{evidence[0].label}</span></span>
        ) : !blocked && !cancelled && researchVerdicts && researchArtifact ? (
          <button
            type="button"
            aria-label="Open Research branch evidence"
            onClick={() => openArtifact(researchArtifact.id, 'trust')}
            style={{ fontSize: 11, color: researchVerdicts.limitedScope ? t.warning : t.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: t.font, display: 'inline-flex', alignItems: 'center', gap: 4, textAlign: 'left' }}
          >
            <FileSearch size={11} color={researchVerdicts.limitedScope ? t.warning : t.accent} /> {researchVerdicts.compactLabel}
          </button>
        ) : !blocked && !cancelled && primaryArtifact && passedChecks > 0 ? (
          <button type="button" onClick={() => openArtifact(primaryArtifact.id, hasAskPipelineReceipt(run) ? 'checks' : 'trust')} style={{ fontSize: 11, color: t.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: t.font, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={11} color={t.success} /> {passedChecks} check{passedChecks === 1 ? '' : 's'} passed
          </button>
        ) : null}
      </div>

      {/* Answer (plain text, selectable for follow-up) */}
      {presentationAnswer ? (
        <div data-followup="answer" style={{ fontSize: 14.5, lineHeight: 1.65, color: t.textPrimary }}>
          <StructuredAnswerText text={cleanAnswerText(presentationAnswer)} t={t} />
        </div>
      ) : cancelled ? (
        <div data-followup="answer" style={{ fontSize: 14, lineHeight: 1.6, color: t.textMuted }}>{cleanPresentationText(run.summary || 'Stopped by user.')}</div>
      ) : failureMessage ? (
        <AskFailureCard
          run={run}
          detail={failureMessage}
          threadId={threadId}
          onRepaired={(repaired) => onRepairedRun(run.id, repaired)}
          t={t}
        />
      ) : run.summary ? (
        <div data-followup="answer" style={{ fontSize: 14, lineHeight: 1.6, color: t.textSecondary }}>{cleanPresentationText(run.summary)}</div>
      ) : null}

      {captureWarning ? (
        <div role="status" style={{ fontSize: 11.5, lineHeight: 1.5, color: t.warning, borderLeft: `2px solid ${t.warning}`, paddingLeft: 8 }}>
          Capture warning: {cleanPresentationText(captureWarning)} The query result is still valid.
        </div>
      ) : null}

      <ClarificationChoiceList run={run} t={t} onSelect={onSelectClarification} />

      {/* Executed results live in the transcript; the inspector owns DQL/SQL/lineage/trust. */}
      {/* The answer's own words already say why its figures are hidden (the host's withheld answer); this note is only
          for an answer that came without them. */}
      {figuresWithheld && !run.summary ? (
        <div role="note" data-testid="ask-figures-withheld" style={{ padding: '10px 12px', border: `1px solid ${t.cellBorder}`, borderLeft: `3px solid ${t.warning}`, borderRadius: 8, background: t.cellBg, fontSize: 12.5, color: t.textSecondary }}>
          The figures stay hidden until an analyst checks this answer. What it would be built on is kept for the check.
        </div>
      ) : null}
      {inlineResultArtifacts.map((artifact) => (
        <InlineAskResultCard
          key={artifact.id}
          run={run}
          artifact={artifact}
          selected={artifact.id === selectedArtifactId}
          t={t}
          themeMode={themeMode}
          onInspect={(tab) => openArtifact(artifact.id, tab)}
        />
      ))}

      {/* Artifact chips */}
      {chipArtifacts.map((artifact) => {
        const payload = payloadOf(artifact);
        const selected = artifact.id === selectedArtifactId;
        return (
          <button
            key={artifact.id}
            type="button"
            className="dql-ask-chip"
            onClick={() => openArtifact(artifact.id, preferredAskInspectorTab(run, artifact))}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: 'fit-content', maxWidth: '100%', padding: '9px 12px', borderRadius: 10, border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-default)'}`, background: 'var(--bg-2)', boxShadow: selected ? '0 1px 6px rgba(107,93,211,0.12)' : 'none', cursor: 'pointer', textAlign: 'left', fontFamily: t.font }}
          >
            <span style={{ width: 30, height: 30, borderRadius: 7, background: artifact.trustState === 'certified' ? 'var(--status-success-bg)' : 'var(--accent-dim)', color: artifact.trustState === 'certified' ? 'var(--status-success)' : 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <ArtifactIcon kind={artifact.kind} />
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cleanPresentationText(artifact.title)}</span>
              <span style={{ fontSize: 11, color: t.textMuted }}>{askArtifactMeta(artifact, payload)}</span>
            </span>
            <ChevronRight size={14} color={t.textMuted} style={{ flexShrink: 0, marginLeft: 6 }} />
          </button>
        );
      })}

      {/* Rich artifacts render inline to preserve their interactive flows */}
      {richArtifacts.length > 0 ? (
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
          {richArtifacts.map((artifact) => (
            <ArtifactView
              key={artifact.id}
              artifact={artifact}
              t={t}
              themeMode={themeMode}
              onInsertSql={onInsertSql}
              onInsertDql={onInsertDql}
              insertDqlActionLabel={insertDqlActionLabel}
              sourceRunId={run.id}
              sourceQuestion={run.question}
              onOpenBlock={onOpenBlock}
              onOpenResearch={onOpenResearch}
              onOpenApp={onOpenApp}
              onNextAction={onNextAction}
            />
          ))}
        </div>
      ) : null}

      {/* RFC 0010 HH-15: team documents the answer read — cited context only */}
      <CitedDocuments run={run} t={t} />

      {/* What the run did, kept with the answer and replayable after a reload */}
      <AskRunStory receipt={run.diagnosticReceiptV9} t={t} />

      {/* RFC 0010 HH-9/HH-10: the host's review of this answer, or its actions for getting one. */}
      <HostAnswerActions run={run} t={t} />

      {/* Tier 2: a review-required answer leaves a draft block for review. */}
      {run.reviewDraft?.path ? (
        <div data-testid="ask-review-draft" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: t.textMuted, marginTop: -2, marginBottom: 4 }}>
          <span>
            Saved for review as a draft saved query (not certified): <code style={{ fontFamily: t.fontMono, fontSize: 11 }}>{run.reviewDraft.path}</code>
            {run.reviewDraft.created ? '' : ` · asked ${run.reviewDraft.askedTimes} times`}
          </span>
          <button
            type="button"
            className="dql-ask-ghost"
            onClick={() => {
              const path = run.reviewDraft!.path;
              if (onOpenBlock) {
                onOpenBlock(path);
                return;
              }
              const file = { name: path.split('/').pop() ?? path, path, type: 'block' as const, folder: 'blocks' };
              void api.openBlockStudio(path).then((payload) => dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload })).catch(() => undefined);
            }}
            style={askGhostBtnStyle(t)}
          >
            <Blocks size={12} /> Open draft to review
          </button>
        </div>
      ) : null}

      {/* Quiet action row */}
      {(presentationAnswer || failureMessage || insertionPayload || pinnable || canSaveBlock || showResearchDeeper || primaryArtifact) ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', marginTop: -2 }}>
          {insertionPayload && onInsertDql ? (
            <button type="button" className="dql-ask-ghost" onClick={() => onInsertDql(insertionPayload)} style={askGhostBtnStyle(t)}>
              <Plus size={12} /> {insertDqlActionLabel}
            </button>
          ) : null}
          {insertionPayload && onReplaceDql && replaceDqlActionLabel ? (
            <button type="button" className="dql-ask-ghost" onClick={() => onReplaceDql(insertionPayload)} style={askGhostBtnStyle(t)}>
              <Pencil size={12} /> {replaceDqlActionLabel}
            </button>
          ) : null}
          {presentationAnswer || failureMessage ? (
            <button type="button" className="dql-ask-ghost" onClick={copyAnswer} style={askGhostBtnStyle(t)}>
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
          {pinnable ? <AddToAppButton run={run} t={t} appContext={appContext} onOpenApp={onOpenApp} /> : null}
          {canSaveBlock ? (
            <button type="button" className="dql-ask-ghost" onClick={() => onNextAction({ id: 'save-dql-block', label: 'Save as saved query', route: 'dql_block_draft' })} style={askGhostBtnStyle(t)}>
              <Blocks size={12} /> Save as saved query
            </button>
          ) : null}
          {showResearchDeeper ? (
            <button type="button" className="dql-ask-ghost" onClick={() => onNextAction({ id: 'research-deeper', label: 'Research this deeper', route: 'research' })} style={askGhostBtnStyle(t)}>
              <FileSearch size={12} /> Research deeper
            </button>
          ) : null}
          {primaryArtifact ? (
            <button type="button" className="dql-ask-ghost" onClick={() => openArtifact(primaryArtifact.id, hasAnalyticalInspectorContract(payloadOf(primaryArtifact)) || hasAskPipelineReceipt(run) || run.agentRunId ? 'how' : 'trust')} style={askGhostBtnStyle(t)}>
              <ListTree size={12} /> {researchArtifact && investigationReportOf(payloadOf(researchArtifact)) ? 'How it was researched' : 'How it was answered'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ClarificationChoiceList({
  run,
  t,
  onSelect,
}: {
  run: AgentRun;
  t: Theme;
  onSelect?: (option: AgentRunClarificationOption) => void;
}) {
  if (run.status !== 'needs_clarification' || !run.clarificationOptions?.length || !onSelect) return null;
  return (
    <div aria-label="Choose a governed meaning" style={{ display: 'grid', gap: 7, maxWidth: 620 }}>
      {run.clarificationOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          className="dql-hover dql-lift"
          onClick={() => onSelect(option)}
          title={option.kind === 'member' ? `Read the question about ${option.label}` : `Use governed evidence ${option.id}`}
          style={{ display: 'grid', gap: 3, width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border-default)', background: 'var(--bg-2)', color: t.textPrimary, cursor: 'pointer', textAlign: 'left', fontFamily: t.font }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>{option.label}</span>
          {option.description ? <span style={{ fontSize: 11, lineHeight: 1.4, color: t.textMuted }}>{option.description}</span> : null}
        </button>
      ))}
    </div>
  );
}

interface AnalyticalInspectorContract {
  plan?: Record<string, unknown>;
  frame?: Record<string, unknown>;
  graph?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  facts?: Record<string, unknown>;
  narrative?: Record<string, unknown>;
  freshness?: Record<string, unknown>;
  failure?: Record<string, unknown>;
  semantic?: Record<string, unknown>;
  diagnostic?: Record<string, unknown>;
  /** Server-produced V4 story; never derive a competing incident from spans. */
  decisionSummary?: AskDecisionSummaryV1;
  /** V1.15 concise runtime story shown before the advanced local trace. */
  runtimeDecisionSummary?: AskDecisionSummaryV2;
  /**
   * V8 is the compact inspector authority only when the server served the
   * run in authoritative V2 mode. Earlier diagnostic receipts remain the
   * reader for legacy and shadow runs.
   */
  runtimeReceiptV8?: NonNullable<AgentRun['diagnosticReceiptV8']>;
}

function isAgentRunDiagnosticReceiptV8(value: unknown): value is NonNullable<AgentRun['diagnosticReceiptV8']> {
  const receipt = recordOf(value);
  return receipt?.version === 8
    && receipt.mode === 'authoritative_v2'
    && Array.isArray(receipt.contextCoverage)
    && Array.isArray(receipt.observations)
    && Array.isArray(receipt.tierAttempts)
    && recordOf(receipt.outcome) !== undefined;
}

/**
 * A run that stopped outside the v2 analytical lane — a refusal ("could not
 * compose a governed query", "drafted a query but the table was not in the
 * retrieved metadata"), or a raw execution error — still has a reason worth
 * showing. Rebuild the minimum failure record from whatever the envelope carried
 * so "How it was answered" opens with a real account instead of vanishing
 * exactly when the user needs to see why it stopped.
 */
function fallbackAnalyticalFailure(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const executionError = payload.executionError;
  if (typeof executionError === 'string' && executionError.trim()) {
    return { stage: 'execution', message: executionError };
  }
  const errorRecord = recordOf(executionError);
  if (errorRecord) return { stage: 'execution', ...errorRecord };
  const refusalCode = typeof payload.refusalCode === 'string' ? payload.refusalCode : undefined;
  if (refusalCode) {
    const details = recordOf(payload.refusalDetails);
    const message = typeof details?.message === 'string' && details.message.trim()
      ? details.message
      : typeof payload.answer === 'string' && payload.answer.trim()
        ? payload.answer
        : 'No answer was accepted for this question.';
    return { stage: 'answer', code: refusalCode, message };
  }
  return undefined;
}

export function hasAnalyticalInspectorContract(payload: Record<string, unknown>): boolean {
  return Boolean(
    recordOf(payload.resolvedAnalyticalPlan)
    || recordOf(payload.analyticalExecutionGraph)
    || recordOf(payload.analyticalExecutionReceipt)
    || recordOf(payload.analyticalFailure)
    || recordOf(payload.semanticExecutionTrace)
    || recordOf(payload.diagnosticReceipt)
    || recordOf(payload.diagnosticReceiptV3)
    || recordOf(payload.diagnosticReceiptV4)
    || recordOf(payload.diagnosticReceiptV5)
    || isAgentRunDiagnosticReceiptV8(payload.diagnosticReceiptV8)
    || fallbackAnalyticalFailure(payload),
  );
}

export function analyticalInspectorContract(payload: Record<string, unknown>): AnalyticalInspectorContract | undefined {
  if (!hasAnalyticalInspectorContract(payload)) return undefined;
  // V3 is additive, but it is the newer source of cascade/source/provider
  // truth. Merge legacy fields only when V3 intentionally does not carry one;
  // preferring V1 hid the diagnostic users needed on normal answer artifacts.
  const legacyDiagnostic = recordOf(payload.diagnosticReceipt);
  const v3Diagnostic = recordOf(payload.diagnosticReceiptV3);
  const v4Diagnostic = recordOf(payload.diagnosticReceiptV4);
  const v5Diagnostic = recordOf(payload.diagnosticReceiptV5);
  const v8Diagnostic = isAgentRunDiagnosticReceiptV8(payload.diagnosticReceiptV8)
    ? payload.diagnosticReceiptV8
    : undefined;
  const diagnostic = v5Diagnostic || v4Diagnostic || v3Diagnostic
    ? {
        ...legacyDiagnostic,
        ...v3Diagnostic,
        ...v4Diagnostic,
        ...v5Diagnostic,
        failure: v3Diagnostic?.failure ?? legacyDiagnostic?.failure,
      }
    : legacyDiagnostic;
  // `diagnostic.plan` is the orchestration step plan, not the analytical plan.
  // Treating it as a ResolvedAnalyticalPlan made a pre-planning failure claim
  // "Ranking: Not requested" even for "top customers". Only the explicit,
  // snapshot-bound analytical contract may populate frame semantics.
  const plan = recordOf(payload.resolvedAnalyticalPlan)
    ?? recordOf(diagnostic?.resolvedAnalyticalPlan);
  return {
    plan,
    frame: recordOf(plan?.analyticalFrame),
    graph: recordOf(payload.analyticalExecutionGraph),
    receipt: recordOf(payload.analyticalExecutionReceipt),
    facts: recordOf(payload.analyticalFacts),
    narrative: recordOf(payload.analyticalNarrative),
    freshness: recordOf(payload.analyticalFreshnessObservation),
    failure: recordOf(payload.analyticalFailure) ?? recordOf(diagnostic?.failure) ?? fallbackAnalyticalFailure(payload),
    semantic: recordOf(payload.semanticExecutionTrace),
    diagnostic,
    ...(isAskDecisionSummaryV1(v4Diagnostic?.summary) ? { decisionSummary: v4Diagnostic.summary } : {}),
    ...(isAskDecisionSummaryV2(v5Diagnostic?.summary) ? { runtimeDecisionSummary: v5Diagnostic.summary } : {}),
    ...(v8Diagnostic ? { runtimeReceiptV8: v8Diagnostic } : {}),
  };
}

function isAskDecisionSummaryV1(value: unknown): value is AskDecisionSummaryV1 {
  const summary = recordOf(value);
  return summary?.version === 1
    && typeof summary.summaryFingerprint === 'string'
    && recordOf(summary.understoodRequest) !== undefined
    && Array.isArray(summary.evidenceByRole)
    && Array.isArray(summary.tierDecisions)
    && typeof summary.safeNextAction === 'string';
}

function isAskDecisionSummaryV2(value: unknown): value is AskDecisionSummaryV2 {
  const summary = recordOf(value);
  return summary?.version === 2
    && typeof summary.summaryFingerprint === 'string'
    && typeof summary.runtimeMode === 'string'
    && typeof summary.whatHappened === 'string'
    && typeof summary.why === 'string'
    && typeof summary.impact === 'string';
}

export function analyticalInspectorSections(): string[] {
  return ['Performance & provider egress', 'Plan', 'DQL', 'Compiled SQL', 'Lineage', 'Trust & evidence', 'Actual steps', 'Failure & repair'];
}

export function analyticalRepairActionLabels(safeActions: string[]): string[] {
  return [
    safeActions.includes('retry_same_plan') ? 'Retry same plan' : undefined,
    safeActions.includes('refresh_snapshot') ? 'Refresh snapshot and prepare retry' : undefined,
    safeActions.includes('request_access') || safeActions.includes('change_authorized_connection')
      ? 'Change connection or request access'
      : undefined,
    safeActions.includes('edit_dql') ? 'Open DQL to repair' : undefined,
    safeActions.includes('open_sql_notebook') ? 'Open SQL in Notebook' : undefined,
    safeActions.includes('reapply_semantic_runtime') ? 'Reapply semantic runtime settings' : undefined,
  ].filter((label): label is string => Boolean(label));
}

/**
 * The retained AgentRun telemetry predates the local Ask trace and is useful
 * only for runs that have no addressable trace.  It is not authoritative once
 * a trace exists: a legacy counter can describe a planned provider/SQL stage
 * even when the frozen route stopped before that physical boundary.
 *
 * Keep this projection deliberately narrow.  Provider readiness, SQL
 * generation, validation, and authorization are useful trace stages but are
 * not provider egress or warehouse execution.  The "Calls" row therefore
 * counts only actual physical attempts, while the stage row retains the rest
 * of the canonical timeline without inventing a provider or SQL duration.
 */
function canonicalPhysicalTraceFacts(trace: Pick<AskTraceDataV1, 'envelope' | 'spans'>): {
  totalDurationMs: number | undefined;
  sqlExecutionDurationMs: number | undefined;
  stages: string;
  providerAttempts: number;
  toolCalls: number;
  sqlExecutions: number;
  repairs: number;
} {
  const durations = new Map<string, number>();
  let providerAttempts = 0;
  let toolCalls = 0;
  let sqlExecutions = 0;
  let repairs = 0;

  for (const span of trace.spans) {
    let physicalStage: 'provider' | 'tool' | 'sql' | 'repair' | undefined;
    if (span.name === 'provider.attempt') {
      // Admission-denied spans are important evidence, but their producer
      // explicitly records that no bytes were sent.  Do not turn that safety
      // guard into a provider call/timing in the performance counter.
      const admission = recordOf(recordOf(span.payload)?.attempt)?.admission;
      if (admission !== 'denied') {
        providerAttempts += 1;
        physicalStage = 'provider';
      }
    } else if (span.name === 'tool.call') {
      toolCalls += 1;
      physicalStage = 'tool';
    } else if (span.name === 'sql.execute') {
      sqlExecutions += 1;
      physicalStage = 'sql';
    } else if (span.name === 'sql.repair') {
      repairs += 1;
      physicalStage = 'repair';
    }

    const duration = traceDurationMs(span.durationMs);
    if (duration === undefined) continue;

    // Never display `provider: …` or `sql: …` from a preflight, compiler, or
    // validation span.  Those are not physical provider/warehouse attempts.
    const stage = physicalStage
      ?? (span.stage === 'provider' || span.stage === 'tool' || span.stage === 'sql' || span.stage === 'request'
        ? undefined
        : span.stage);
    if (!stage) continue;
    durations.set(stage, (durations.get(stage) ?? 0) + duration);
  }

  const orderedStages = [
    'conversation', 'snapshot', 'retrieval', 'context', 'meaning', 'cascade', 'plan',
    'provider', 'tool', 'sql', 'repair', 'result', 'narration', 'research', 'persistence',
  ];
  const stages = orderedStages
    .flatMap((stage) => durations.has(stage)
      ? [`${stage}: ${formatTelemetryDuration(durations.get(stage))}`]
      : [])
    .join(' · ');
  const sqlExecutionDurationMs = durations.get('sql');
  return {
    totalDurationMs: traceDurationMs(trace.envelope.durationMs),
    sqlExecutionDurationMs,
    stages: stages || 'No completed physical provider, tool, SQL, or repair stage was recorded.',
    providerAttempts,
    toolCalls,
    sqlExecutions,
    repairs,
  };
}

/**
 * Authoritative V2 records the selected/frozen execution directly in V8. The
 * compact inspector must read that receipt instead of combining a completed
 * V8 execution with an earlier V1/V3 planning envelope. Those envelopes are
 * retained for compatibility, but describe a different authority boundary.
 */
export interface AuthoritativeV8CompactInspectorProjection {
  receipt: NonNullable<AgentRun['diagnosticReceiptV8']>;
  selectedTier?: string;
  planId?: string;
  frozenPlanFingerprint?: string;
  candidateIds: string[];
  candidateAdmissionCount: number;
  retainedCandidateCount: number;
  tierAttempts: NonNullable<AgentRun['diagnosticReceiptV8']>['tierAttempts'];
}

export function authoritativeV8CompactInspectorProjection(
  receipt: AgentRun['diagnosticReceiptV8'] | AskTraceDataV1['runtimeReceiptV8'] | undefined,
): AuthoritativeV8CompactInspectorProjection | undefined {
  if (receipt?.mode !== 'authoritative_v2') return undefined;

  // A freeze observation is the only source of the immutable plan identity.
  // Prefer the last one because a same-plan repair, when permitted, retains
  // the same plan identity while adding a later execution observation.
  const observations = [...receipt.observations];
  const frozenPlanObservation = observations.slice().reverse().find((observation) =>
    observation.frozen === true && (typeof observation.planId === 'string' || typeof observation.inputFingerprint === 'string'),
  ) ?? observations.slice().reverse().find((observation) => observation.frozen === true);
  const executedObservation = observations.slice().reverse().find((observation) => observation.outcome === 'executed');
  const selectedAttempt = receipt.tierAttempts.slice().reverse().find((attempt) => attempt.frozen)
    ?? receipt.tierAttempts.slice().reverse().find((attempt) => attempt.outcome === 'executed')
    ?? undefined;
  // An eligible inspection is evidence, not controller authority. For an
  // unfrozen V8 turn, use the kernel's current progression instead of the
  // first card that happened to be inspected.
  const selectedTier = frozenPlanObservation?.tier
    ?? executedObservation?.tier
    ?? selectedAttempt?.tier
    ?? receipt.controllerTier;
  const candidateIds = frozenPlanObservation?.candidateIds?.length
    ? frozenPlanObservation.candidateIds
    : executedObservation?.candidateIds?.length
      ? executedObservation.candidateIds
      : selectedAttempt?.candidateIds ?? [];

  return {
    receipt,
    selectedTier,
    ...(typeof frozenPlanObservation?.planId === 'string' ? { planId: frozenPlanObservation.planId } : {}),
    ...(typeof frozenPlanObservation?.inputFingerprint === 'string'
      ? { frozenPlanFingerprint: frozenPlanObservation.inputFingerprint }
      : {}),
    candidateIds,
    candidateAdmissionCount: receipt.initialCandidateCount,
    retainedCandidateCount: receipt.retainedCandidateCount,
    tierAttempts: receipt.tierAttempts,
  };
}

function authoritativeV8PlanLabel(projection: AuthoritativeV8CompactInspectorProjection): string {
  if (projection.planId) return `${projection.planId}${projection.receipt.planFrozen ? ' · frozen' : ''}`;
  return projection.receipt.planFrozen ? 'Frozen plan ID not retained' : 'No plan frozen';
}

function authoritativeV8TierAttemptsLabel(projection: AuthoritativeV8CompactInspectorProjection): string {
  if (projection.tierAttempts.length === 0) return 'No tier attempt was retained.';
  return projection.tierAttempts.map((attempt) =>
    `${attempt.tier}: ${attempt.outcome}${attempt.frozen ? ' (frozen)' : ''}`,
  ).join(' · ');
}

function authoritativeV8CoverageLabel(projection: AuthoritativeV8CompactInspectorProjection): string {
  if (projection.receipt.contextCoverage.length === 0) return 'No source coverage was retained.';
  return projection.receipt.contextCoverage.map((coverage) =>
    `${coverage.source}: ${coverage.status} (${coverage.admittedCandidateCount} admitted${coverage.excludedCandidateCount ? `, ${coverage.excludedCandidateCount} excluded` : ''})`,
  ).join('\n');
}

function authoritativeV8ExecutionLabel(projection: AuthoritativeV8CompactInspectorProjection): string {
  const outcome = projection.receipt.outcome;
  return `${outcome.connectionAttempted ? 'Connection attempted' : 'No connection attempted'} · ${outcome.executionAttempts} execution attempt${outcome.executionAttempts === 1 ? '' : 's'}`;
}

function authoritativeV8FactsLabel(projection: AuthoritativeV8CompactInspectorProjection): string {
  const outcome = projection.receipt.outcome;
  return `${outcome.factCount} validated fact${outcome.factCount === 1 ? '' : 's'} · ${outcome.narration.replace(/_/g, ' ')}`;
}

/**
 * Authoritative V2 runs carry one durable, server-owned V8 counter receipt.
 * Prefer it over independently counted spans/legacy telemetry so the compact
 * story and inspector cannot disagree about provider/tool/execution totals.
 */
function authoritativeV8Activity(
  run: AgentRun,
  trace?: Pick<AskTraceDataV1, 'runtimeReceiptV8'>,
): NonNullable<AskTraceDataV1['runtimeReceiptV8']>['activity'] | undefined {
  const receipt = trace?.runtimeReceiptV8 ?? run.diagnosticReceiptV8;
  return receipt?.mode === 'authoritative_v2' ? receipt.activity : undefined;
}

interface AskPipelineActivity {
  providerDispatches: number;
  toolCalls: number;
  executionAttempts: number;
  repairs: number;
  /** Queries the host sent to the warehouse, and how many came back with an error. */
  warehouseAttempts?: number;
  warehouseFailures?: number;
}

/**
 * The Ask pipeline's receipt is the authority on what physically happened in
 * a `pipeline_v3` run: every provider dispatch, every prepared candidate or
 * refusal, and the one execution. Spans are an index; the receipt counts.
 */
export function pipelineV9Activity(
  run: Pick<AgentRun, 'diagnosticReceiptV9'>,
  trace?: Pick<AskTraceDataV1, 'runtimeReceiptV9'>,
): AskPipelineActivity | undefined {
  const receipt = recordOf(trace?.runtimeReceiptV9) ?? recordOf(run.diagnosticReceiptV9);
  if (!receipt || !Array.isArray(receipt.dispatches)) return undefined;
  const dispatches = receipt.dispatches.map((entry) => recordOf(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const candidates = Array.isArray(receipt.candidates) ? receipt.candidates.length : 0;
  const refusals = Array.isArray(receipt.refusals) ? receipt.refusals.length : 0;
  const warehouse = recordOf(receipt.warehouse);
  const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
  const executions = count(warehouse?.executions);
  return {
    providerDispatches: dispatches.length,
    toolCalls: candidates + refusals,
    executionAttempts: executions ?? (recordOf(receipt.executed) ? 1 : 0),
    repairs: dispatches.filter((entry) => typeof entry.purpose === 'string' && /repair|correct/i.test(entry.purpose)).length,
    ...(count(warehouse?.attempts) === undefined ? {} : { warehouseAttempts: count(warehouse?.attempts) }),
    ...(count(warehouse?.failures) === undefined ? {} : { warehouseFailures: count(warehouse?.failures) }),
  };
}

/**
 * The plan of a pipeline run is its intent: what was read, what was
 * measured, how it was grouped and restricted, which tiers were tried and
 * which executed, with the proofs. Rendered from `diagnosticReceiptV9`.
 */
export function askPipelinePlanRows(receipt: Record<string, unknown>): Array<[string, string]> {
  const intent = recordOf(receipt.intent) ?? {};
  const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map((item) => recordOf(item)).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const text = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  const predicate = (item: Record<string, unknown>) => `${text(item.ref)} ${text(item.op)} ${strings(item.values).length ? strings(item.values).join('/') : Array.isArray(item.values) ? (item.values as unknown[]).map(String).join('/') : ''}`.trim();
  const measures = list(intent.measures).map((measure) => {
    const derived = recordOf(measure.derived);
    const base = derived ? `${text(measure.alias) || text(measure.ref)} = ${text(derived.numerator)} / ${text(derived.denominator)}` : `${text(measure.ref)}${measure.alias ? ` as ${text(measure.alias)}` : ''}${measure.aggregation ? ` (${text(measure.aggregation)})` : ''}`;
    const scope = list(measure.scope).map(predicate);
    return scope.length ? `${base} where ${scope.join(' and ')}` : base;
  });
  const groupBy = list(intent.groupBy).map((group) => `${text(group.ref)} (${text(group.role)}${group.grain ? ` ${text(group.grain)}` : ''})`);
  const time = recordOf(intent.time);
  const window = recordOf(time?.window);
  const ordering = recordOf(intent.ordering);
  const tiers = list(receipt.tiers).map((tier) => `${text(tier.tier)}: ${text(tier.outcome)}${tier.detail ? ` — ${text(tier.detail).slice(0, 120)}` : ''}`);
  const executed = recordOf(receipt.executed);
  const candidates = list(receipt.candidates);
  const proofs = [...candidates.flatMap((candidate) => strings(candidate.proof)), ...strings(executed?.proofs)];
  const none = 'None';
  return [
    ['Reading', text(intent.reading) || text(receipt.reading) || 'Not recorded'],
    ['Measures', measures.join('\n') || none],
    ['Group by', groupBy.join(', ') || none],
    ['Display', strings(intent.display).join(', ') || none],
    ['Filters', list(intent.filters).map(predicate).join('\n') || none],
    ['Time', [time?.ref ? `axis ${text(time.ref)}` : '', time?.grain ? `grain ${text(time.grain)}` : '', window ? `window ${text(window.start)} → ${text(window.end)}${window.expression ? ` ("${text(window.expression)}")` : ''}` : ''].filter(Boolean).join(' · ') || none],
    ['Population', intent.population === 'all' ? 'Every member of the grain (zero-filled)' : 'Matched members'],
    ['Ordering', ordering ? `${text(ordering.ref)} ${text(ordering.direction)}${intent.limit ? ` · limit ${text(intent.limit)}` : ''}` : intent.limit ? `limit ${text(intent.limit)}` : none],
    ['Unresolved', list(intent.unresolved).map((clause) => `${text(clause.clause)}${clause.material ? ' (material)' : ''}${strings(clause.options).length ? `: ${strings(clause.options).join(', ')}` : ''}`).join('\n') || none],
    ['Tiers tried', tiers.join('\n') || none],
    ['Executed', executed ? `${text(executed.tier)} · ${text(executed.rowCount)} row(s) · ${text(executed.sqlFingerprint)}` : 'Nothing executed'],
    ['Proofs', proofs.join('\n') || none],
    ['Grounding', strings(receipt.grounding).join('\n') || none],
    ['Reuse', text(receipt.reuse) || 'none'],
    ...contextRows(recordOf(receipt.context)),
  ];
}

/** What the run READ and ENFORCED from the authored context, by name: the skills and hints rendered, the policies applied, the joins used. */
function contextRows(context: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!context) return [];
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map((item) => recordOf(item)).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  const rendered = recordOf(context.rendered); const enforced = recordOf(context.enforced); const used = recordOf(context.used);
  const none = 'None';
  const skills = strings(rendered?.skills); const hints = strings(rendered?.hints);
  // A setting the run RECORDED is not a rule it ENFORCED: the two are never one row.
  const describePolicy = (policy: Record<string, unknown>) => `${String(policy.policyId ?? '')}${policy.field ? ` · ${String(policy.field)}` : ''}${policy.effect ? ` · ${String(policy.effect)}` : ''}`.trim();
  const isRecorded = (policy: Record<string, unknown>) => /^recorded\b|\bnot (yet )?applied\b|^skipped\b/i.test(String(policy.effect ?? ''));
  const policies = list(enforced?.policies).filter((policy) => !isRecorded(policy)).map(describePolicy);
  const recorded = list(enforced?.policies).filter(isRecorded).map(describePolicy);
  const joins = list(used?.joins).map((join) => (Array.isArray(join.relations) && join.relations.length === 2
    ? describeJoin(join)
    : `${String(join.relationshipId ?? join.source ?? '')} (${String(join.authority ?? '')}${join.scope ? `, ${String(join.scope)}` : ''})`));
  return [
    ['Skills applied', skills.join(', ') || none],
    ['Hints applied', hints.join(', ') || none],
    ['Policies enforced', policies.join('\n') || none],
    ['Settings recorded, not enforced', recorded.join('\n') || none],
    ['Joins used', joins.join('\n') || none],
  ];
}

function askRuntimeEvidenceLabel(mode: AgentRun['askAgentRuntimeMode'] | AskTraceDataV1['runtimeMode'] | undefined): string | undefined {
  if (mode === 'authoritative_v2') return 'Authoritative V2 receipt';
  if (mode === 'pipeline_v3') return 'Ask pipeline receipt';
  return undefined;
}

function traceDurationMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * `trace` is supplied only by the inspector's on-demand local trace request.
 * It is intentionally not embedded in AgentRun/thread/SSE state.
 */
export function agentRunPerformanceRows(
  run: AgentRun,
  trace?: Pick<AskTraceDataV1, 'envelope' | 'spans' | 'runtimeReceiptV8' | 'runtimeReceiptV9' | 'runtimeMode'>,
): Array<[string, string]> | undefined {
  if (trace) {
    const physical = canonicalPhysicalTraceFacts(trace);
    const v8Activity: (NonNullable<AskTraceDataV1['runtimeReceiptV8']>['activity'] & Partial<AskPipelineActivity>) | AskPipelineActivity | undefined = authoritativeV8Activity(run, trace) ?? pipelineV9Activity(run, trace);
    const v8Projection = authoritativeV8CompactInspectorProjection(trace.runtimeReceiptV8 ?? run.diagnosticReceiptV8);
    const providerAttempts = v8Activity?.providerDispatches ?? physical.providerAttempts;
    const toolCalls = v8Activity?.toolCalls ?? physical.toolCalls;
    const executions = v8Activity?.executionAttempts ?? physical.sqlExecutions;
    const repairs = v8Activity?.repairs ?? physical.repairs;
    const providerRows = providerEgressSummary(run, providerAttempts);
    const orchestrationDurationMs = physical.totalDurationMs === undefined
      ? undefined
      : Math.max(0, physical.totalDurationMs - (physical.sqlExecutionDurationMs ?? 0));
    const planIds = Array.from(new Set([
      ...(v8Projection?.planId ? [v8Projection.planId] : []),
      ...(run.artifacts ?? []).flatMap((artifact) => {
      const payload = payloadOf(artifact);
      const plan = recordOf(payload.resolvedAnalyticalPlan)
        ?? recordOf(recordOf(payload.diagnosticReceipt)?.resolvedAnalyticalPlan);
      const receipt = recordOf(payload.analyticalExecutionReceipt);
      return [plan?.planId, receipt?.planId].filter((value): value is string => typeof value === 'string' && value.length > 0);
      }),
    ]));
    const artifactIds = Array.from(new Set((run.artifacts ?? [])
      .map((artifact) => artifact.id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0)));
    return [
      ['Total', physical.totalDurationMs === undefined ? 'Not recorded' : formatTelemetryDuration(physical.totalDurationMs)],
      ['Warehouse', physical.sqlExecutionDurationMs === undefined ? 'Not recorded' : formatTelemetryDuration(physical.sqlExecutionDurationMs)],
      ['Orchestration', orchestrationDurationMs === undefined ? 'Not recorded' : formatTelemetryDuration(orchestrationDurationMs)],
      ['Stages', physical.stages],
      ['Calls', `${providerAttempts} provider · ${toolCalls} tool · ${executions} SQL · ${repairs} repair`],
      // A run that reached the warehouse and got nothing back must say so:
      // "0 SQL" alone reads as "nothing was tried".
      ...(v8Activity?.warehouseAttempts
        ? [['Warehouse calls', `${v8Activity.warehouseAttempts} attempted · ${v8Activity.warehouseAttempts - (v8Activity.warehouseFailures ?? 0)} successful${v8Activity.warehouseFailures ? ` · ${v8Activity.warehouseFailures} failed` : ''}`] as [string, string]]
        : []),
      ['Provider rows', providerRows],
      ['Trace evidence', authoritativeV8Activity(run, trace) ? 'Authoritative V2 receipt (canonical physical egress and execution counts)' : v8Activity ? 'Ask pipeline receipt (dispatch, preparation and execution counts)' : 'Canonical local physical trace'],
      ...(askRuntimeEvidenceLabel(trace.runtimeMode ?? run.askAgentRuntimeMode)
        ? [['Ask runtime', askRuntimeEvidenceLabel(trace.runtimeMode ?? run.askAgentRuntimeMode)!] as [string, string]]
        : []),
      ...(run.narrationIntegrityReceipt ? [['Narration', narrationIntegritySummary(run.narrationIntegrityReceipt)] as [string, string]] : []),
      ['Plan ID', planIds.length > 0 ? planIds.join(', ') : 'Not recorded'],
      ['Artifact IDs', artifactIds.length > 0 ? artifactIds.join(', ') : 'None'],
      ['Fallback', run.telemetry?.fallbackReason ?? 'None'],
    ];
  }
  const telemetry = run.telemetry;
  if (!telemetry) return undefined;
  const v8Activity = authoritativeV8Activity(run) ?? pipelineV9Activity(run);
  const v8Projection = authoritativeV8CompactInspectorProjection(run.diagnosticReceiptV8);
  const totalDurationMs = telemetry.stageDurationsMs.total;
  const warehouseDurationMs = telemetry.warehouseDurationMs;
  const orchestrationDurationMs = totalDurationMs === undefined || warehouseDurationMs === undefined
    ? undefined
    : Math.max(0, totalDurationMs - warehouseDurationMs);
  const planIds = Array.from(new Set([
    ...(v8Projection?.planId ? [v8Projection.planId] : []),
    ...(run.artifacts ?? []).flatMap((artifact) => {
    const payload = payloadOf(artifact);
    const plan = recordOf(payload.resolvedAnalyticalPlan)
      ?? recordOf(recordOf(payload.diagnosticReceipt)?.resolvedAnalyticalPlan);
    const receipt = recordOf(payload.analyticalExecutionReceipt);
    return [plan?.planId, receipt?.planId].filter((value): value is string => typeof value === 'string' && value.length > 0);
    }),
  ]));
  const artifactIds = Array.from(new Set((run.artifacts ?? [])
    .map((artifact) => artifact.id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)));
  return [
    ['Total', formatTelemetryDuration(telemetry.stageDurationsMs.total)],
    ['Warehouse', telemetry.warehouseDurationMs === undefined ? 'Not recorded' : formatTelemetryDuration(telemetry.warehouseDurationMs)],
    ['Orchestration', orchestrationDurationMs === undefined ? 'Not recorded' : formatTelemetryDuration(orchestrationDurationMs)],
    ['Stages', Object.entries(telemetry.stageDurationsMs)
      .filter(([stage]) => stage !== 'total')
      .map(([stage, duration]) => `${stage}: ${formatTelemetryDuration(duration)}`)
      .join(' · ')],
    ['Calls', `${v8Activity?.providerDispatches ?? telemetry.providerRoundTrips} provider · ${v8Activity?.toolCalls ?? telemetry.toolCalls} tool · ${v8Activity?.executionAttempts ?? telemetry.sqlExecutions} SQL · ${v8Activity?.repairs ?? telemetry.repairs} repair`],
    ['Provider rows', providerEgressSummary(run, v8Activity?.providerDispatches ?? telemetry.providerRoundTrips)],
    ...(authoritativeV8Activity(run) ? [['Trace evidence', 'Authoritative V2 receipt (canonical physical egress and execution counts)'] as [string, string]] : v8Activity ? [['Trace evidence', 'Ask pipeline receipt (dispatch, preparation and execution counts)'] as [string, string]] : []),
    ...(askRuntimeEvidenceLabel(run.askAgentRuntimeMode)
      ? [['Ask runtime', askRuntimeEvidenceLabel(run.askAgentRuntimeMode)!] as [string, string]]
      : []),
    ...(run.narrationIntegrityReceipt ? [['Narration', narrationIntegritySummary(run.narrationIntegrityReceipt)] as [string, string]] : []),
    ['Plan ID', planIds.length > 0 ? planIds.join(', ') : 'Not recorded'],
    ['Artifact IDs', artifactIds.length > 0 ? artifactIds.join(', ') : 'None'],
    ['Fallback', telemetry.fallbackReason ?? 'None'],
  ];
}

/**
 * Render provider row egress from server-produced physical receipts only.
 * A row count never implies Research: an ordinary Ask with a legacy/malformed
 * receipt must be described as Ask evidence, while explicit Research retains
 * its consent language. New runs only emit a receipt at physical dispatch.
 */
export function providerEgressSummary(
  run: Pick<AgentRun, 'requestedMode' | 'providerEgressReceipts'>,
  providerAttempts: number,
): string {
  if (providerAttempts === 0) return '0 result rows sent to providers (0 content-free receipts)';
  const receipts = run.providerEgressReceipts ?? [];
  if (receipts.length === 0) {
    return `No retained egress receipt for ${providerAttempts} recorded provider attempt${providerAttempts === 1 ? '' : 's'}`;
  }
  const rowReceipts = receipts.filter((receipt) => receipt.resultRowCount > 0);
  const rowCount = rowReceipts.reduce((sum, receipt) => sum + receipt.resultRowCount, 0);
  const phaseLabel = (receipt: typeof receipts[number]) => {
    const phase = typeof receipt.dispatchPhase === 'string'
      ? receipt.dispatchPhase
      : typeof receipt.purpose === 'string'
        ? receipt.purpose
        : undefined;
    return phase?.replace(/_/g, ' ');
  };
  const contentFreePhases = [...new Set(receipts
    .filter((receipt) => receipt.resultRowCount === 0)
    .map(phaseLabel)
    .filter((phase): phase is string => Boolean(phase)))];
  if (rowCount === 0) {
    const phaseSuffix = contentFreePhases.length > 0
      ? ` ${contentFreePhases.join(', ')}`
      : '';
    return `0 result rows sent to providers (${receipts.length} content-free${phaseSuffix} receipt${receipts.length === 1 ? '' : 's'})`;
  }
  const rowPhases = [...new Set(rowReceipts.map(phaseLabel).filter((phase): phase is string => Boolean(phase)))];
  const legacyReadOnly = rowReceipts.every((receipt) => receipt.legacyReadOnly === true);
  if (legacyReadOnly) {
    return `${rowCount} bounded, redacted legacy non-Research result row${rowCount === 1 ? '' : 's'} retained as read-only evidence; not a current egress authority`;
  }
  const explicitResearch = run.requestedMode === 'research'
    && rowReceipts.every((receipt) => receipt.purpose === 'research_narration' || receipt.purpose === 'research_tool');
  if (explicitResearch) {
    return `${rowCount} bounded, redacted Research result row${rowCount === 1 ? '' : 's'} sent with explicit run consent${rowPhases.length ? ` during ${rowPhases.join(', ')}` : ''}`;
  }
  return `${rowCount} bounded, redacted Ask result row${rowCount === 1 ? '' : 's'} sent during ${rowPhases.join(', ') || 'an unrecorded provider phase'}`;
}

type CanonicalPerformanceTraceState =
  | { state: 'legacy' | 'loading' | 'unavailable'; trace?: undefined }
  | { state: 'loaded'; trace: AskTraceDataV1 };

/**
 * Hydrate only the addressable, redacted trace while the inline inspector is
 * open.  The full trace remains outside AgentRun, thread, and SSE state; this
 * state is discarded with the inspector.  Until it arrives, do not briefly
 * show stale legacy counters for a trace-backed run.
 */
/**
 * The step-by-step explanation of an Ask pipeline run: from the run's own
 * record, or — for a run rebuilt from a saved thread turn — read back from the
 * saved run's trace. `unavailable` when a saved run has no record any more.
 */
function useAskRunExplanation(run: AgentRun, payload: Record<string, unknown>): { explanation?: RunExplanation; unavailable: boolean } {
  const receipt = askPipelineReceiptOf(run);
  const savedRunId = receipt ? undefined : run.agentRunId;
  const [fetched, setFetched] = useState<{ runId: string; explanation?: RunExplanation }>();
  useEffect(() => {
    if (!savedRunId) return undefined;
    let active = true;
    void api.getAskTraceByRun(savedRunId)
      .then((trace) => { if (active) setFetched({ runId: savedRunId, explanation: explanationForTrace(trace) }); })
      .catch(() => { if (active) setFetched({ runId: savedRunId }); });
    return () => { active = false; };
  }, [savedRunId]);
  return useMemo(() => {
    // An investigation's root receipt is not one answer: its programs explain it instead.
    if (receipt && isInvestigationReceipt(receipt)) return { unavailable: false };
    if (receipt) return { explanation: explainAskRun({ receipt, payload, evaluations: run.evaluations, status: run.status }), unavailable: false };
    if (savedRunId && fetched?.runId === savedRunId) return { explanation: fetched.explanation, unavailable: !fetched.explanation };
    return { unavailable: false };
  }, [receipt, payload, run.evaluations, run.status, savedRunId, fetched]);
}

function useCanonicalPerformanceTrace(run: AgentRun): CanonicalPerformanceTraceState {
  const traceId = run.traceReference?.traceId;
  const recordingStatus = run.traceReference?.recordingStatus;
  const [state, setState] = useState<CanonicalPerformanceTraceState>(() => traceId
    ? { state: 'loading' }
    : { state: 'legacy' });

  useEffect(() => {
    let active = true;
    if (!traceId) {
      setState({ state: 'legacy' });
      return () => { active = false; };
    }
    if (recordingStatus === 'unavailable' || recordingStatus === 'detail_expired') {
      setState({ state: 'unavailable' });
      return () => { active = false; };
    }
    setState({ state: 'loading' });
    void api.getAskTraceByRun(run.id).then((trace) => {
      if (!active) return;
      // A stale response must not be used to describe a different run after
      // the inspector moves to its replacement/repaired artifact.
      setState(trace.envelope.runId === run.id
        ? { state: 'loaded', trace }
        : { state: 'unavailable' });
    }).catch(() => {
      if (active) setState({ state: 'unavailable' });
    });
    return () => { active = false; };
  }, [run.id, traceId, recordingStatus]);

  // The prior run's trace can survive one render before the effect resets.
  // Never let it replace this run's local facts.
  return state.state === 'loaded' && state.trace.envelope.runId !== run.id
    ? { state: 'loading' }
    : state;
}

function narrationIntegritySummary(receipt: NonNullable<AgentRun['narrationIntegrityReceipt']>): string {
  if (receipt.outcome === 'skipped') {
    return `Skipped${receipt.skipReason ? ` (${receipt.skipReason.replace(/_/g, ' ')})` : ''}`;
  }
  if (receipt.outcome === 'success') {
    return receipt.mode === 'verified_facts'
      ? `Fact-verified (${receipt.factCount} facts)`
      : 'Preview-grounded';
  }
  if (receipt.outcome === 'deterministic_fallback') {
    const codes = receipt.validationFailures.length > 0 ? ` (${receipt.validationFailures.join(', ')})` : '';
    return `Deterministic fallback${codes}`;
  }
  return 'Narration unavailable; the retained answer was not replaced.';
}

function AnalyticalHowAnswered({
  run,
  contract,
  dqlArtifact,
  sql,
  lineage,
  t,
  onInsertSql,
  onInsertDql,
  onSaveBlock,
}: {
  run: AgentRun;
  contract: AnalyticalInspectorContract;
  dqlArtifact?: AgentConversationDqlArtifact;
  sql?: string;
  lineage: AskLineageEntry[];
  t: Theme;
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  onSaveBlock: () => void;
}) {
  const { dispatch } = useNotebook();
  const plan = contract.plan;
  const frame = contract.frame;
  const graph = contract.graph;
  const receipt = contract.receipt;
  const semantic = contract.semantic;
  const semanticFailure = recordOf(semantic?.failure);
  const authoritativeV8 = authoritativeV8CompactInspectorProjection(
    run.diagnosticReceiptV8 ?? contract.runtimeReceiptV8,
  );
  // The Ask pipeline leaves its receipt on the answer artifact: what it read,
  // which tiers it prepared, what refused and why, what executed.
  const askPipeline = recordOf(run.diagnosticReceiptV9) ?? recordOf((run.artifacts ?? []).map((artifact) => recordOf(artifact.payload)).find((payload) => payload?.askPipeline)?.askPipeline);
  // A completed V8 finish_answer is the server-owned terminal outcome. A
  // stale legacy planning failure in the answer artifact must not turn that
  // validated execution back into a compact-panel failure.
  const v8FinishedAnswer = authoritativeV8?.receipt.terminalOutcome?.kind === 'finish_answer';
  const failure = v8FinishedAnswer ? undefined : contract.failure ?? semanticFailure;
  // V4 is a durable, server-produced story. Prefer the run-level receipt
  // because it survives an artifact shape change; an artifact copy is only a
  // backwards-compatible transport fallback. The inspector must not infer a
  // second incident from spans or generic failure text when this exists.
  const decisionSummary = run.diagnosticReceiptV4?.summary ?? contract.decisionSummary;
  const runtimeDecisionSummary = run.diagnosticReceiptV5?.summary ?? contract.runtimeDecisionSummary;
  const researchBranchSummary = decisionSummary?.researchBranchSummary;
  // A receipt-backed partial Research result is still a root success. Its
  // failed child branches belong in Failure & repair as limitations, not as a
  // synthetic root terminal incident.
  const partialResearchBranchSummary = researchBranchSummary?.partialSuccess === true
    ? researchBranchSummary
    : undefined;
  const semanticAuthoringRequest = recordOf(semantic?.authoringRequest);
  const semanticRuntimeRequest = recordOf(semantic?.runtimeRequest);
  const semanticBindings = recordList(semantic?.bindings);
  const semanticSteps = recordList(semantic?.steps);
  const semanticTargetBinding = recordOf(semantic?.targetBinding);
  const semanticSnapshot = recordOf(semanticTargetBinding?.semanticSnapshot);
  const semanticExecutionTarget = recordOf(semanticTargetBinding?.executionTarget);
  const semanticTargetContext = recordOf(semanticExecutionTarget?.redactedContext);
  const semanticCompileTarget = recordOf(semanticTargetBinding?.compileTarget);
  const semanticReceipt = recordOf(semantic?.executionReceipt);
  const semanticCandidates = recordList(semanticFailure?.candidates);
  const cascade = recordOf(contract.diagnostic?.cascade);
  const sourceCoverage = recordList(contract.diagnostic?.sourceCoverage);
  const cascadeAttempts = recordList(cascade?.attempts);
  const providerDiagnostic = recordOf(contract.diagnostic?.provider);
  const timeContext = recordOf(frame?.timeContext);
  const comparison = recordOf(frame?.comparison);
  const ranking = recordOf(frame?.ranking);
  const dimensions = recordList(frame?.dimensions);
  const members = recordList(frame?.memberBindings);
  const periods = recordList(timeContext?.periods);
  const outputs = recordList(frame?.requestedOutputs);
  const graphNodes = recordList(graph?.nodes);
  const safeActions = Array.from(new Set([
    ...stringList(failure?.safeActions),
    ...stringList(semanticFailure?.safeActions),
  ]));
  const failedBindings = recordList(failure?.failedBindings);
  const semanticSqlExcerpt = recordOf(semanticFailure?.sqlExcerpt);
  const result = run.artifacts.map((artifact) => extractResult(payloadOf(artifact))).find(Boolean);
  const performanceTrace = useCanonicalPerformanceTrace(run);
  const performanceRows = performanceTrace.state === 'loaded'
    ? agentRunPerformanceRows(run, performanceTrace.trace)
    : performanceTrace.state === 'legacy'
      ? agentRunPerformanceRows(run)
      : undefined;
  const sourceTitle = dqlArtifact?.name ?? run.question;
  const askPipelineReceipt = recordOf(run.diagnosticReceiptV9);
  const planRows: Array<[string, string]> = askPipelineReceipt && recordOf(askPipelineReceipt.intent) ? askPipelinePlanRows(askPipelineReceipt) : authoritativeV8 ? [
    ['Objective', authoritativeV8.receipt.objective.replace(/_/g, ' ')],
    ['Selected tier', authoritativeV8.selectedTier ?? 'No executable tier selected'],
    ['Frozen plan', authoritativeV8PlanLabel(authoritativeV8)],
    ['Frozen plan fingerprint', authoritativeV8.frozenPlanFingerprint ?? 'Not retained'],
    ['Candidate admissions', `${authoritativeV8.candidateAdmissionCount} initial · ${authoritativeV8.retainedCandidateCount} retained`],
    ['Context expansions', String(authoritativeV8.receipt.expansionCount)],
    ['Tier attempts', authoritativeV8TierAttemptsLabel(authoritativeV8)],
  ] : [
    ['Question type', displayValue(frame?.questionType ?? plan?.questionType)],
    ['Selected route', displayValue(graph?.route ?? plan?.recommendedRoute)],
    ['Metric', stringList(frame?.metricConceptIds).join(', ')],
    ['Entity grain', stringList(frame?.entityGrainIds).join(', ')],
    ['Dimensions', dimensions.map((item) => `${displayValue(item.dimensionId)} (${displayValue(item.role)})`).join(', ')],
    ['Member filters', members.map((item) => `${displayValue(item.dimensionId)}: ${Array.isArray(item.canonicalValues) ? item.canonicalValues.length : 0} bound value(s)`).join(', ')],
    ['Time policy', [timeContext?.timeRole, timeContext?.grain, timeContext?.timezone, timeContext?.completenessPolicy].map(displayValue).filter(Boolean).join(' · ')],
    ['Periods', periods.map((item) => `${displayValue(item.id)}: ${displayValue(item.start)} → ${displayValue(item.end)}`).join('\n')],
    ['Comparison', comparison ? `${displayValue(comparison.basePeriodId)} vs ${stringList(comparison.comparisonPeriodIds).join(', ')} · ${displayValue(comparison.alignment)}` : frame ? 'Not requested' : 'Not available — analytical planning did not complete'],
    ['Ranking', ranking ? `${displayValue(ranking.direction)} · top ${displayValue(ranking.limit)} · ${displayValue(ranking.tiePolicy)}` : frame ? 'Not requested' : 'Not available — analytical planning did not complete'],
    ['Outputs', outputs.map((item) => `${displayValue(item.id)} (${displayValue(item.kind)})`).join(', ')],
    ['Semantic metrics', stringList(semanticAuthoringRequest?.metrics).join(', ')],
    ['Semantic dimensions', stringList(semanticAuthoringRequest?.dimensions).join(', ')],
    ['Review assumption', run.trustState === 'review_required' && run.route === 'semantic_answer'
      ? 'The semantic grouping was inferred for the requested dimension; verify before reuse.'
      : 'None'],
  ];
  const trustRows: Array<[string, string]> = authoritativeV8 ? [
    ['Trust state', run.trustState],
    ['Snapshot', authoritativeV8.receipt.snapshotId ?? 'Not retained'],
    ['Frozen plan', authoritativeV8PlanLabel(authoritativeV8)],
    ['Frozen plan fingerprint', authoritativeV8.frozenPlanFingerprint ?? 'Not retained'],
    ['Candidate admissions', `${authoritativeV8.candidateAdmissionCount} initial · ${authoritativeV8.retainedCandidateCount} retained`],
    ['Selected candidates', authoritativeV8.candidateIds.join(', ') || 'Not retained'],
    ['Cascade', authoritativeV8.selectedTier ?? 'No executable tier selected'],
    ['Plan frozen', authoritativeV8.receipt.planFrozen ? 'true' : 'false'],
    ['Tier attempts', authoritativeV8TierAttemptsLabel(authoritativeV8)],
    ['Connection & execution', authoritativeV8ExecutionLabel(authoritativeV8)],
    ['Validated facts', authoritativeV8FactsLabel(authoritativeV8)],
    ['Source coverage', authoritativeV8CoverageLabel(authoritativeV8)],
    ['Final stop', authoritativeV8.receipt.finalStopReason.replace(/_/g, ' ')],
  ] : [
    ['Trust state', run.trustState],
    ['Snapshot', displayValue(plan?.snapshotId ?? graph?.snapshotId)],
    ['Plan fingerprint', displayValue(plan?.fingerprint ?? graph?.planFingerprint)],
    ['Graph fingerprint', displayValue(graph?.fingerprint)],
    ['Receipt', displayValue(receipt?.receiptId)],
    ['Result fingerprint', displayValue(receipt?.resultFingerprint)],
    ['Freshness observed through', displayValue(contract.freshness?.observedThrough)],
    ['Fact set', displayValue(contract.facts?.fingerprint)],
    ['Semantic adapter', displayValue(semantic?.adapter)],
    ['Semantic compile status', displayValue(semantic?.status)],
    ['Target proof', displayValue(recordOf(semanticTargetBinding?.proof)?.status)],
    ['Target binding', displayValue(semanticTargetBinding?.bindingFingerprint)],
    ['Compile target', displayValue(semanticCompileTarget?.kind)],
    ['Local semantic snapshot', displayValue(semanticSnapshot?.semanticCatalogFingerprint ?? semanticSnapshot?.sourceFingerprint)],
    ['Runtime metric inventory proof', displayValue(semanticCompileTarget?.semanticCatalogFingerprint)],
    ['Execution target', [
      semanticExecutionTarget?.driver,
      semanticTargetContext?.account,
      semanticTargetContext?.database,
      semanticTargetContext?.schema,
      semanticTargetContext?.role,
      semanticTargetContext?.warehouse,
    ].map(displayValue).filter(Boolean).join(' · ')],
    ['Semantic receipt', displayValue(semanticReceipt?.receiptId)],
    ['Warehouse query ID', displayValue(semanticReceipt?.queryId)],
    ['Executed SQL proof', displayValue(semanticReceipt?.executedSqlFingerprint)],
    ['Runtime metrics', stringList(semanticRuntimeRequest?.metrics).join(', ')],
    ['Runtime dimensions', stringList(semanticRuntimeRequest?.dimensions).join(', ')],
    ['Member bindings', semanticBindings.map((binding) =>
      `${displayValue(binding.authoringReference)} → ${displayValue(binding.runtimeReference)}`
      + `${stringList(binding.entityPath).length ? ` via ${stringList(binding.entityPath).join(' → ')}` : ''}`
      + ` (${displayValue(binding.status)})`).join('\n')],
    ['Cascade', displayValue(cascade?.selectedTier) || displayValue(cascade?.stopReason)],
    // The pipeline freezes its executable before it runs; a run that never carried a V2 freeze flag shows no row rather than a misleading "false".
    ...(contract.diagnostic?.planFrozen === undefined ? [] : [['Plan frozen', displayValue(contract.diagnostic.planFrozen)] as [string, string]]),
    ['Provider phase/cause', [displayValue(providerDiagnostic?.phase), displayValue(providerDiagnostic?.cause)].filter(Boolean).join(' · ')],
    ['Provider recovery', displayValue(providerDiagnostic?.safeAction)],
    ['Source coverage', sourceCoverage.map((entry) => `${displayValue(entry.source)}: ${displayValue(entry.status)}`).join('\n')],
  ];
  const displayedCascadeAttempts = authoritativeV8?.tierAttempts ?? cascadeAttempts;
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const repairResultMessage = (
    label: string,
    response: Awaited<ReturnType<typeof api.deriveAnalyticalRepair>>,
  ) => {
    const transition = response.derivation.trustTransition;
    return `${label} as immutable derivation ${response.derivation.derivationId}. Trust: ${transition.previous} → ${transition.next}${transition.requiresReview ? ' (review required)' : ''}.`;
  };
  const openDqlRepair = async () => {
    if (!dqlArtifact?.source || !onInsertDql) return;
    try {
      const response = await api.deriveAnalyticalRepair(run.id, { version: 1, action: 'edit_dql', dqlSource: dqlArtifact.source });
      onInsertDql({
        sql,
        dqlArtifact,
        result,
        title: sourceTitle,
        sourceRunId: run.id,
        question: run.question,
      });
      setRepairMessage(repairResultMessage('Opened DQL in Notebook', response));
    } catch (error) {
      setRepairMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const openSqlRepair = async () => {
    if (!sql || !onInsertSql) return;
    try {
      const response = await api.deriveAnalyticalRepair(run.id, { version: 1, action: 'open_sql_notebook', sqlText: sql });
      onInsertSql(sql, `${sourceTitle} repair`, {
        question: run.question,
        sourceRunId: run.id,
      });
      setRepairMessage(repairResultMessage('Opened SQL in Notebook', response));
    } catch (error) {
      setRepairMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const deriveSimpleRepair = async (action: 'retry_same_plan' | 'refresh_snapshot') => {
    try {
      const response = await api.deriveAnalyticalRepair(run.id, { version: 1, action });
      const label = action === 'retry_same_plan'
        ? 'Prepared the same bounded plan for retry'
        : 'Refreshed the governed snapshot and prepared the same plan for retry';
      setRepairMessage(repairResultMessage(label, response));
    } catch (error) {
      setRepairMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const openAccessRepair = async () => {
    try {
      const response = await api.deriveAnalyticalRepair(run.id, { version: 1, action: 'request_access' });
      setRepairMessage(repairResultMessage('Recorded the access/connection repair and opened Database settings', response));
      dispatch({ type: 'SET_SETTINGS_TAB', tab: 'database' });
      dispatch({ type: 'SET_MAIN_VIEW', view: 'settings' });
    } catch (error) {
      setRepairMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const openSemanticRuntimeSetup = () => {
    dispatch({ type: 'SET_SETTINGS_TAB', tab: 'project' });
    dispatch({ type: 'SET_MAIN_VIEW', view: 'settings' });
    setRepairMessage('Opened Project & dbt settings. Test and apply the intended dbt Cloud Semantic Layer environment to refresh its verified metric inventory.');
  };

  return (
    <div style={{ display: 'grid', gap: 9 }} aria-label="How it answered">
      {/*
        Outcome first. The real execution error used to sit at the BOTTOM of this
        panel, below Plan, DQL, SQL, Lineage, Trust and Steps, so a failed run
        showed six sections of diagnostics before saying what actually went
        wrong. Success or the warehouse's own message now leads.
      */}
      <div
        role="status"
        style={{
          display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8,
          border: `1px solid ${failure ? 'var(--status-error-border)' : 'var(--status-success-border)'}`,
          background: failure ? 'var(--status-error-bg)' : 'var(--status-success-bg)',
        }}
      >
        {failure
          ? <ShieldAlert size={13} color="var(--status-error)" style={{ flexShrink: 0, marginTop: 2 }} />
          : <ShieldCheck size={13} color="var(--status-success)" style={{ flexShrink: 0, marginTop: 2 }} />}
        <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: failure ? 'var(--status-error)' : 'var(--status-success)' }}>
            {failure ? 'Execution failed' : 'Answered successfully'}
          </div>
          {failure ? (
            <>
              {/* The engine's own words, not a paraphrase — that is what makes
                  a failure actionable. */}
              <div style={{ marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: t.fontMono, fontSize: 11 }}>
                {typeof failure.message === 'string' && failure.message.trim()
                  ? failure.message
                  : 'The engine did not report a message. Open the DQL and SQL tabs to inspect what ran.'}
              </div>
              <div style={{ marginTop: 4, fontSize: 10.5, color: t.textMuted }}>
                {[failure.code, failure.phase ? `during ${failure.phase}` : ''].filter(Boolean).map(displayValue).join(' · ')}
              </div>
            </>
          ) : (
            <div style={{ marginTop: 2 }}>
              {typeof receipt?.rowCount === 'number'
                ? `Returned ${receipt.rowCount} row${receipt.rowCount === 1 ? '' : 's'}.`
                : 'The query ran and returned a result.'}
            </div>
          )}
        </div>
      </div>

      {run.traceReference ? (
        <button
          type="button"
          className="dql-hover"
          onClick={() => dispatch({ type: 'OPEN_ASK_TRACE', runId: run.id })}
          style={{
            display: 'inline-flex', alignItems: 'center', justifySelf: 'start', gap: 5,
            background: 'transparent', border: 'none', cursor: 'pointer', padding: '1px 0',
            color: t.accent, fontSize: 11.5, fontFamily: t.font, fontWeight: 700,
          }}
          title="Open the local, redacted Ask trace"
        >
          <GitBranch size={12} /> Open full trace
        </button>
      ) : null}

      {askPipeline
        ? <InspectorAskPipelineStory receipt={askPipeline} t={t} />
        : authoritativeV8
        ? <InspectorAuthoritativeV8DecisionStory projection={authoritativeV8} t={t} />
        : runtimeDecisionSummary
          ? <InspectorRuntimeDecisionStory summary={runtimeDecisionSummary} t={t} />
          : decisionSummary
            ? <InspectorDecisionStory summary={decisionSummary} t={t} />
            : <InspectorDecisionSummaryUnavailable t={t} />}

      <AnalyticalInspectorSection index={1} label="Performance & provider egress" t={t} open>
        {performanceTrace.state === 'loading' ? (
          <InspectorEmpty t={t}>Loading the local physical trace. Legacy counters are withheld until its recorded attempts are available.</InspectorEmpty>
        ) : performanceRows ? (
          <InspectorRows rows={performanceRows} t={t} />
        ) : performanceTrace.state === 'unavailable' ? (
          <InspectorEmpty t={t}>Canonical physical performance evidence is unavailable for this trace-backed run.</InspectorEmpty>
        ) : (
          <InspectorEmpty t={t}>Performance details were not recorded for this legacy run.</InspectorEmpty>
        )}
        {performanceTrace.state === 'unavailable' && run.traceReference ? (
          <p style={{ margin: 0, color: t.textMuted, fontSize: 10.5, lineHeight: 1.45 }}>
            The local trace detail is unavailable, so physical provider and SQL counters are not shown for this trace-backed run.
          </p>
        ) : null}
      </AnalyticalInspectorSection>

      <AnalyticalInspectorSection index={2} label="Plan" t={t} open={!failure}>
        <InspectorRows rows={planRows} t={t} />
      </AnalyticalInspectorSection>

      {/*
        DQL, Compiled SQL and Lineage each have their OWN tab. Repeating them
        here meant a user read the same script twice and could not tell whether
        the two copies were the same thing — which is exactly the confusion this
        panel should remove. Diagnostics that exist nowhere else stay below.
      */}
      <AnalyticalInspectorSection index={3} label="Trust & evidence" t={t}>
        <InspectorRows rows={trustRows} t={t} mono />
      </AnalyticalInspectorSection>

      <AnalyticalInspectorSection index={4} label="Actual steps" t={t}>
        <div style={{ display: 'grid', gap: 6 }}>
          {!authoritativeV8 && semanticSteps.map((step, index) => (
            <div key={`semantic:${displayValue(step.id) || index}`} style={{ fontSize: 11.5, color: t.textSecondary }}>
              <strong style={{ color: displayValue(step.status) === 'failed' ? 'var(--status-error)' : t.textPrimary }}>
                {index + 1}. {displayValue(step.label)}
              </strong>
              {' '}— {displayValue(step.status)} · {displayValue(step.detail)}
            </div>
          ))}
          {!authoritativeV8 && run.steps.map((step) => (
            <div key={step.id} style={{ fontSize: 11.5, color: t.textSecondary }}>
              <strong style={{ color: t.textPrimary }}>{step.index + 1}. {step.goal}</strong> — {step.status}, {step.attempts} attempt{step.attempts === 1 ? '' : 's'}
            </div>
          ))}
          {!authoritativeV8 && graphNodes.map((node, index) => (
            <div key={displayValue(node.id) || index} style={{ fontSize: 11.5, color: t.textSecondary }}>
              <span style={{ color: t.accent, fontFamily: t.fontMono }}>{index + 1}. {displayValue(node.kind)}</span>
              {' '}· {displayValue(node.id)}
            </div>
          ))}
          {displayedCascadeAttempts.map((attempt, index) => (
            <div key={`cascade:${displayValue(attempt.tier)}:${index}`} style={{ fontSize: 11.5, color: t.textSecondary }}>
              <span style={{ color: t.accent, fontFamily: t.fontMono }}>{index + 1}. {displayValue(attempt.tier)}</span>
              {' '}— {displayValue(attempt.outcome)} · {displayValue(attempt.reasonCode) || displayValue(recordOf(attempt)?.reason)}{attempt.frozen === true ? ' · frozen' : ''}
            </div>
          ))}
          {authoritativeV8 && displayedCascadeAttempts.length === 0 ? <InspectorEmpty t={t}>No authoritative V2 tier attempt was retained.</InspectorEmpty> : null}
          {!authoritativeV8 && semanticSteps.length === 0 && run.steps.length === 0 && graphNodes.length === 0 && displayedCascadeAttempts.length === 0 ? <InspectorEmpty t={t}>No executable steps were recorded.</InspectorEmpty> : null}
        </div>
      </AnalyticalInspectorSection>

      <AnalyticalInspectorSection index={5} label="Failure & repair" t={t} open={Boolean(failure || partialResearchBranchSummary)}>
        {failure ? (
          <div style={{ display: 'grid', gap: 9 }}>
            {/* The engine's message now leads the whole panel, so only the
                diagnostics that exist nowhere else belong here. */}
            <InspectorRows rows={[
              ['Failure ID', displayValue(failure.failureId)],
              ['Recoverability', displayValue(failure.recoverability)],
              ['Failed bindings', failedBindings.map((item) => `${displayValue(item.qualifiedId ?? item.role)} (${displayValue(item.reasonCode)})`).join(', ')],
              ['Safe actions', safeActions.join(', ')],
              ['DQL fingerprint', displayValue(failure.dqlFingerprint)],
              ['SQL fingerprint', displayValue(failure.sqlFingerprint)],
              ['Semantic failure code', displayValue(semanticFailure?.code)],
              ['Failing identifier', displayValue(semanticFailure?.identifier)],
              ['Compiled SQL proof', displayValue(semanticFailure?.compiledSqlFingerprint)],
              ['Path candidates', semanticCandidates.map((candidate) =>
                `${displayValue(candidate.label)}\n${displayValue(candidate.runtimeReference)}`).join('\n')],
            ]} t={t} mono />
            {displayValue(semanticSqlExcerpt?.text) ? (
              <div>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: t.textSecondary, marginBottom: 5 }}>
                  Failing SQL context · lines {displayValue(semanticSqlExcerpt?.startLine)}–{displayValue(semanticSqlExcerpt?.endLine)}
                </div>
                <pre style={codeStyle(t)}>{displayValue(semanticSqlExcerpt?.text)}</pre>
              </div>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Safe repair actions">
              {safeActions.includes('edit_dql') && onInsertDql ? (
                <button type="button" onClick={() => void openDqlRepair()} style={smallButtonStyle(t)}>
                  <Wrench size={12} /> Open DQL to repair
                </button>
              ) : null}
              {safeActions.includes('open_sql_notebook') && onInsertSql ? (
                <button type="button" onClick={() => void openSqlRepair()} style={smallButtonStyle(t)}>
                  <Code2 size={12} /> Open SQL in Notebook
                </button>
              ) : null}
              {safeActions.includes('retry_same_plan') ? (
                <button type="button" onClick={() => void deriveSimpleRepair('retry_same_plan')} style={smallButtonStyle(t)}>
                  <RefreshCw size={12} /> Retry same plan
                </button>
              ) : null}
              {safeActions.includes('refresh_snapshot') ? (
                <button type="button" onClick={() => void deriveSimpleRepair('refresh_snapshot')} style={smallButtonStyle(t)}>
                  <RefreshCw size={12} /> Refresh snapshot and prepare retry
                </button>
              ) : null}
              {safeActions.includes('request_access') || safeActions.includes('change_authorized_connection') ? (
                <button type="button" onClick={() => void openAccessRepair()} style={smallButtonStyle(t)}>
                  <ShieldAlert size={12} /> Change connection or request access
                </button>
              ) : null}
              {safeActions.includes('reapply_semantic_runtime') ? (
                <button type="button" onClick={openSemanticRuntimeSetup} style={smallButtonStyle(t)}>
                  <RefreshCw size={12} /> Reapply semantic runtime settings
                </button>
              ) : null}
            </div>
          </div>
        ) : partialResearchBranchSummary ? (
          <ResearchPartialFailureRepair summary={partialResearchBranchSummary} t={t} />
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <InspectorEmpty t={t}>No failure was recorded for this run.</InspectorEmpty>
            {dqlArtifact?.sourcePath ? null : dqlArtifact?.source ? (
              <button type="button" onClick={onSaveBlock} style={smallButtonStyle(t)}><Save size={12} /> Save as draft saved query</button>
            ) : null}
          </div>
        )}
      </AnalyticalInspectorSection>
      {repairMessage ? <div role="status" style={{ fontSize: 10.5, color: repairMessage.toLowerCase().includes('created') ? 'var(--status-success)' : 'var(--status-error)' }}>{repairMessage}</div> : null}
    </div>
  );
}

/**
 * The authoritative V2 compact story is deliberately V8-only. In particular,
 * it never reports a V1/V3 frame count or cascade placeholder beside a V8
 * frozen/executed plan because those records can describe the pre-V2 path.
 */
export function InspectorAuthoritativeV8DecisionStory({
  projection,
  t,
}: {
  projection: AuthoritativeV8CompactInspectorProjection;
  t: Theme;
}): JSX.Element {
  const terminal = projection.receipt.terminalOutcome;
  const successful = terminal?.kind === 'finish_answer';
  const rows: Array<[string, string]> = [
    ['Objective', projection.receipt.objective.replace(/_/g, ' ')],
    ['Candidate admissions', `${projection.candidateAdmissionCount} initial · ${projection.retainedCandidateCount} retained`],
    ['Selected tier', projection.selectedTier ?? 'No executable tier selected'],
    ['Frozen plan', authoritativeV8PlanLabel(projection)],
    ['Frozen plan fingerprint', projection.frozenPlanFingerprint ?? 'Not retained'],
    ['Tier attempts', authoritativeV8TierAttemptsLabel(projection)],
    ['Connection & execution', authoritativeV8ExecutionLabel(projection)],
    ['Validated facts', authoritativeV8FactsLabel(projection)],
    ['Final outcome', terminal
      ? `${terminal.kind.replace(/_/g, ' ')} · ${terminal.reasonCode.replace(/_/g, ' ')}`
      : projection.receipt.finalStopReason.replace(/_/g, ' ')],
    ['Safe next action', terminal?.safeAction ? inspectorSafeNextAction(terminal.safeAction as AskDecisionSummaryV1['safeNextAction']) : 'None'],
  ];
  return (
    <section
      aria-label="Authoritative Ask decision story"
      style={{
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${successful ? 'var(--status-success-border)' : 'var(--status-warning-border)'}`,
        background: successful ? 'var(--status-success-bg)' : 'var(--status-warning-bg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: successful ? 'var(--status-success)' : 'var(--status-warning)', fontSize: 12, fontWeight: 750, marginBottom: 8 }}>
        {successful ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
        Authoritative Ask decision story
      </div>
      <InspectorRows rows={rows} t={t} mono />
    </section>
  );
}

/**
 * THE ASK PIPELINE STORY. One interpretation, every tier prepared before
 * anything committed, the proofs that ran. Every line comes from the receipt
 * the pipeline persisted on the answer; nothing here is inferred from prose.
 */
export function InspectorAskPipelineStory({ receipt, t }: { receipt: Record<string, unknown>; t: Theme }): JSX.Element {
  const intent = recordOf(receipt.intent);
  const refOf = (value: unknown): string => {
    const record = recordOf(value);
    return typeof record?.ref === 'string' ? record.ref : typeof value === 'string' ? value : '';
  };
  const clause = (value: unknown): string => {
    const record = recordOf(value);
    if (!record) return '';
    const values = stringList(record.values).join('/') || (Array.isArray(record.values) ? record.values.map(displayValue).join('/') : '');
    return `${displayValue(record.ref)} ${displayValue(record.op)} ${values}`.trim();
  };
  const measures = recordList(intent?.measures).map((measure) => {
    const scope = recordList(measure.scope).map(clause).filter(Boolean);
    return `${displayValue(measure.ref)}${scope.length ? ` where ${scope.join(' and ')}` : ''}`;
  });
  const groupBy = recordList(intent?.groupBy).map((group) => `${displayValue(group.ref)} (${displayValue(group.role)}${group.grain ? `, ${displayValue(group.grain)}` : ''})`);
  const display = stringList(intent?.display);
  const filters = recordList(intent?.filters).map(clause).filter(Boolean);
  const ordering = recordOf(intent?.ordering);
  const tiers = recordList(receipt.tiers).map((attempt) => `${displayValue(attempt.tier)}: ${displayValue(attempt.outcome)}${attempt.detail ? ` (${displayValue(attempt.detail)})` : ''}`);
  const candidates = recordList(receipt.candidates);
  const executed = recordOf(receipt.executed);
  const chosen = executed ? candidates.find((candidate) => candidate.tier === executed.tier) : undefined;
  const dispatches = recordList(receipt.dispatches);
  const failure = recordOf(receipt.failure);
  const warehouse = recordOf(receipt.warehouse);
  const warehouseAttempts = typeof warehouse?.attempts === 'number' && warehouse.attempts > 0 ? warehouse.attempts : 0;
  const warehouseFailures = typeof warehouse?.failures === 'number' && warehouse.failures > 0 ? warehouse.failures : 0;
  const executionState = executed
    ? `${displayValue(executed.rowCount)} rows in ${displayValue(executed.ms)} ms · ${stringList(executed.proofs).join(' ')}`
    : warehouseAttempts > 0
      ? `${warehouseAttempts} warehouse quer${warehouseAttempts === 1 ? 'y' : 'ies'} attempted · ${warehouseFailures} failed · no successful warehouse query ran`
      : 'no warehouse query ran';
  const refusals = recordList(receipt.refusals).map((refusal) => `${displayValue(refusal.tier)}/${displayValue(refusal.code)}: ${displayValue(refusal.message)}`);
  const timings = recordOf(receipt.timings);
  const successful = Boolean(executed) && !failure;
  const rows: Array<[string, string]> = [
    ['Read as', typeof intent?.reading === 'string' && intent.reading ? intent.reading : 'The interpreter did not produce a reading'],
    ['Measures', measures.join('; ')],
    ['Grouped by', groupBy.join('; ')],
    ['Displayed', display.join(', ')],
    ['Filters', filters.join(' and ')],
    ['Ordering', ordering ? `${displayValue(ordering.ref)} ${displayValue(ordering.direction)}${intent?.limit ? ` · top ${displayValue(intent.limit)}` : ''}` : intent?.limit ? `top ${displayValue(intent.limit)}` : ''],
    ['Tiers tried', tiers.join(' · ')],
    ['Prepared', chosen ? `${displayValue(chosen.tier)} · ${displayValue(chosen.trust)} · ${stringList(chosen.proof).join(' ')}` : candidates.length ? candidates.map((candidate) => `${displayValue(candidate.tier)} (${displayValue(candidate.trust)})`).join(', ') : 'nothing prepared'],
    ['Executed', executionState],
    ['Model calls', dispatches.length ? `${dispatches.length} (${dispatches.map((dispatch) => `${displayValue(dispatch.purpose)} ${displayValue(dispatch.ms)} ms`).join(', ')})` : '0'],
    ['Reuse', typeof receipt.reuse === 'string' && receipt.reuse !== 'none' ? `${receipt.reuse} reused` : ''],
    ['Stopped', failure ? `${displayValue(failure.stage)}: ${displayValue(failure.message)}` : ''],
    ['Last completed phase', typeof receipt.lastCompletedPhase === 'string' ? receipt.lastCompletedPhase : ''],
    ['Refusals', refusals.join('\n')],
    ['Timings', timings ? Object.entries(timings).map(([stage, ms]) => `${stage} ${displayValue(ms)} ms`).join(' · ') : ''],
    ['Vocabulary', displayValue(receipt.vocabularyFingerprint)],
  ];
  return (
    <section
      aria-label="Ask pipeline story"
      style={{
        padding: '10px 12px', borderRadius: 8,
        border: `1px solid ${successful ? 'var(--status-success-border)' : 'var(--status-warning-border)'}`,
        background: successful ? 'var(--status-success-bg)' : 'var(--status-warning-bg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: successful ? 'var(--status-success)' : 'var(--status-warning)', fontSize: 12, fontWeight: 750, marginBottom: 8 }}>
        {successful ? <ShieldCheck size={13} /> : <ShieldAlert size={13} />}
        Ask pipeline story
      </div>
      <InspectorRows rows={rows} t={t} mono />
    </section>
  );
}

/**
 * The compact inspector and full Trace page intentionally render the same
 * durable V4 fields and fingerprint. This is presentation only: it never
 * promotes a span-derived guess into a second failure explanation.
 */
export function InspectorRuntimeDecisionStory({ summary, t }: { summary: AskDecisionSummaryV2; t: Theme }): JSX.Element {
  const issue = /did not complete|paused/i.test(summary.whatHappened);
  const rows: Array<[string, string]> = [
    ['What happened', summary.whatHappened],
    ['Why', summary.why],
    ['Impact on answer', summary.impact],
    ['How to proceed', inspectorSafeNextAction(summary.nextAction)],
    ['Program', `${summary.programTaskCount} task${summary.programTaskCount === 1 ? '' : 's'} · ${summary.admittedCandidateCount} admitted candidates · ${summary.toolCallCount} tool calls · ${summary.executionAttempts} execution attempt${summary.executionAttempts === 1 ? '' : 's'}${summary.selectedCompiler ? ` · ${summary.selectedCompiler.replace(/_/g, ' ')}` : ''}.`],
    ['Runtime receipt', summary.summaryFingerprint],
  ];
  return (
    <section
      aria-label="Ask runtime story"
      style={{
        padding: '10px 12px', borderRadius: 8,
        border: `1px solid ${issue ? 'var(--status-error-border)' : 'var(--status-success-border)'}`,
        background: issue ? 'var(--status-error-bg)' : 'var(--status-success-bg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: issue ? 'var(--status-error)' : 'var(--status-success)', fontSize: 12, fontWeight: 750, marginBottom: 8 }}>
        {issue ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
        Ask runtime story
      </div>
      <InspectorRows rows={rows} t={t} mono />
    </section>
  );
}

export function InspectorDecisionStory({ summary, t }: { summary: AskDecisionSummaryV1; t: Theme }): JSX.Element {
  const request = summary.understoodRequest;
  const researchBranches = summary.researchBranchSummary;
  const researchLimited = researchBranches?.partialSuccess === true;
  const rows: Array<[string, string]> = [
    ['Understood request', `${request.measures} measure${request.measures === 1 ? '' : 's'}, ${request.dimensions} dimension${request.dimensions === 1 ? '' : 's'}${request.entityRequested ? ', an entity output' : ''}${request.ranking ? `, ${request.ranking.direction} ${request.ranking.limit}${request.ranking.defaultedLimit ? ' (default)' : ''}` : ''}. Conversation binding: ${request.conversationBinding.replace(/_/g, ' ')}.`],
    ['Evidence by role', summary.evidenceByRole.length > 0
      ? summary.evidenceByRole.map((entry) => `${entry.role.replace(/_/g, ' ')}: ${entry.candidateCount}`).join(' · ')
      : 'No role evidence was retained for this run.'],
    ['Tier decisions', summary.tierDecisions.length > 0
      ? summary.tierDecisions.map((entry) => `${entry.tier}: ${entry.outcome}${entry.planFrozen ? ' (frozen)' : ''}`).join(' · ')
      : 'No cascade tier receipt was recorded.'],
    ['Selected plan', summary.selectedPlan
      ? `${summary.selectedPlan.tier.replace(/_/g, ' ')}${summary.selectedPlan.planFrozen ? ' frozen' : ''}${summary.selectedPlan.reviewRequired ? '; review required' : ''}.`
      : 'No executable plan was selected.'],
    ...(researchBranches ? [['Research branch evidence', inspectorResearchBranchEvidence(researchBranches)] as [string, string]] : []),
    ['Failure or repair', summary.terminalIncident
      ? `${summary.terminalIncident.code.replace(/_/g, ' ')} at ${summary.terminalIncident.boundary}; ${summary.terminalIncident.impact.replace(/_/g, ' ')}.`
      : researchLimited
        ? `Research limitations: ${researchBranches!.failedBranches + researchBranches!.timedOutBranches + researchBranches!.skippedBranches} child branches did not complete; completed receipt-backed findings remain available.`
        : 'No terminal incident was recorded.'],
    ['Safe next action', inspectorSafeNextAction(summary.safeNextAction)],
    ['Summary fingerprint', summary.summaryFingerprint],
  ];
  const issue = Boolean(summary.terminalIncident || researchLimited);
  return (
    <section
      aria-label="Ask decision story"
      style={{
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${issue ? 'var(--status-error-border)' : 'var(--status-success-border)'}`,
        background: issue ? 'var(--status-error-bg)' : 'var(--status-success-bg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: issue ? 'var(--status-error)' : 'var(--status-success)', fontSize: 12, fontWeight: 750, marginBottom: 8 }}>
        {issue ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
        Ask decision story
      </div>
      <InspectorRows rows={rows} t={t} mono />
    </section>
  );
}

/**
 * Render the same stored child-branch evidence in the inspector's Failure &
 * repair accordion. This is deliberately separate from a terminal failure:
 * a receipt-backed Research finding remains a successful root answer.
 */
export function ResearchPartialFailureRepair({
  summary,
  t,
}: {
  summary: NonNullable<AskDecisionSummaryV1['researchBranchSummary']>;
  t: Theme;
}): JSX.Element {
  const limitedBranches = summary.failedBranches + summary.timedOutBranches + summary.skippedBranches;
  return (
    <div aria-label="Research branch limitations" style={{ display: 'grid', gap: 8 }}>
      <InspectorRows rows={[
        ['Root outcome', 'The root Research answer remains successful; these child limitations are not a terminal incident.'],
        ['Research branch evidence', inspectorResearchBranchEvidence(summary)],
        ['Limitations', `${limitedBranches} child ${limitedBranches === 1 ? 'branch did' : 'branches did'} not complete. Receipt-backed findings remain available.`],
        ['Safe next action', inspectorSafeNextAction(summary.safeAction)],
      ]} t={t} />
    </div>
  );
}

function inspectorSafeNextAction(action: AskDecisionSummaryV1['safeNextAction']): string {
  return action === 'inspect_research_failures'
    ? 'Inspect failed or timed-out branches; retry narrower Research if the missing evidence matters.'
    : action.replace(/_/g, ' ');
}

function inspectorResearchBranchEvidence(summary: NonNullable<AskDecisionSummaryV1['researchBranchSummary']>): string {
  const reasons = summary.failureReasons.length > 0
    ? summary.failureReasons.map((entry) => `${entry.code.replace(/_/g, ' ')}: ${entry.branchCount}`).join(' · ')
    : 'no displayable reason code';
  const plans = summary.availableChildPlans.length > 0
    ? ` Persisted child plans: ${summary.availableChildPlans
      .map((plan) => `${plan.tier.replace(/_/g, ' ')} frozen ×${plan.frozenPlanCount} for ${plan.branchCount} ${plan.branchCount === 1 ? 'branch' : 'branches'}${plan.reviewRequired ? ' (review required)' : ''}`)
      .join(' · ')}.`
    : ' No frozen child plan evidence was retained.';
  return `${summary.receiptBackedBranches} receipt-backed ${summary.receiptBackedBranches === 1 ? 'finding' : 'findings'} · ${summary.failedBranches} failed · ${summary.timedOutBranches} timed out · ${summary.skippedBranches} skipped. Reasons: ${reasons}.${plans} ${summary.linkedChildRunCount} linked child ${summary.linkedChildRunCount === 1 ? 'run' : 'runs'}.`;
}

export function InspectorDecisionSummaryUnavailable({ t }: { t: Theme }): JSX.Element {
  return (
    <section
      aria-label="Ask decision story unavailable"
      style={{
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--status-warning-border)',
        background: 'var(--status-warning-bg)',
        color: t.textSecondary,
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--status-warning)', fontSize: 12, fontWeight: 750, marginBottom: 4 }}>
        <ShieldAlert size={13} /> Ask decision story
      </div>
      <div>{CANONICAL_DECISION_SUMMARY_UNAVAILABLE}.</div>
      <div style={{ marginTop: 3, color: t.textMuted, fontSize: 11.5 }}>Open the full trace to inspect its raw advanced evidence.</div>
    </section>
  );
}

function AnalyticalInspectorSection({
  index,
  label,
  t,
  open = false,
  children,
}: {
  index: number;
  label: string;
  t: Theme;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-1)', overflow: 'hidden' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none', padding: '8px 10px', display: 'flex', gap: 7, alignItems: 'center', fontSize: 11.5, fontWeight: 700, color: t.textPrimary }}>
        <span style={{ width: 18, height: 18, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-dim)', color: 'var(--accent)', fontSize: 10 }}>{index}</span>
        {label}
      </summary>
      <div style={{ display: 'grid', gap: 8, padding: '0 10px 10px' }}>{children}</div>
    </details>
  );
}

function InspectorRows({ rows, t, mono = false }: { rows: Array<[string, string]>; t: Theme; mono?: boolean }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.filter(([, value]) => value).map(([label, value]) => (
        <div key={label} style={{ display: 'grid', gridTemplateColumns: '112px minmax(0, 1fr)', gap: 8, alignItems: 'start' }}>
          <span style={{ fontSize: 10.5, color: t.textMuted }}>{label}</span>
          <span style={{ fontSize: 10.5, color: t.textSecondary, fontFamily: mono ? t.fontMono : t.font, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function InspectorEmpty({ t, children }: { t: Theme; children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: t.textMuted }}>{children}</div>;
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item) => recordOf(item) ? [recordOf(item)!] : []) : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function formatTelemetryDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Not recorded';
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${Math.round(value)}ms`;
}

/**
 * Turn a picked clarification option into the next request.
 *
 * The option's `id` carries the binding; the QUESTION must stay the user's own.
 * Falling back to `option.label` re-asked the label as if it were the question,
 * so picking "customers.customers" to disambiguate "who are the top customers"
 * submitted the literal string `customers.customers` — and the run then tried to
 * answer that, producing nonsense SQL against a question nobody asked.
 */
export function clarificationSelectionInput(
  option: AgentRunClarificationOption,
  sourceQuestion?: string,
): {
  question: string;
  selectedEvidenceId: string;
} {
  const original = sourceQuestion?.trim();
  // The analytical question is the user's own, always: an option's `question`
  // is UI prose (a reading plus a label) and submitting it as the question
  // makes the next turn answer a sentence nobody asked.
  return {
    question: original || option.question?.trim() || option.label,
    selectedEvidenceId: option.id,
  };
}

/**
 * Compact, immutable baseline handed to an explicit Research-deeper run.
 * Research may attempt a richer governed query, but it must retain the exact
 * successful Ask SQL/DQL, result sample, and target as its safe fallback rather
 * than recomposing the baseline on an unrelated default connection.
 */
export function researchSourceFromRun(run: AgentRun): Record<string, unknown> {
  const result = run.artifacts
    .map((artifact) => extractResult(payloadOf(artifact)))
    .find((candidate): candidate is QueryResult => Boolean(candidate));
  const sourceRef = run.artifacts.find((artifact) => artifact.ref)?.ref;
  return {
    runId: run.id,
    question: run.question,
    trustState: run.trustState,
    executionTarget: run.executionTarget,
    sourceCertifiedBlock: sourceRef,
    sql: answerSqlFromRun(run),
    dqlArtifact: answerDqlArtifactFromRun(run),
    ...(result ? {
      result: {
        columns: result.columns,
        rows: result.rows.slice(0, 24),
        rowCount: result.rowCount,
        ...(result.columnsMeta?.length ? { columnsMeta: result.columnsMeta } : {}),
      },
    } : {}),
  };
}

export function isAgentRunPinnable(run: AgentRun): boolean {
  const hasMixedSourcePlan = run.artifacts.some((artifact) =>
    Boolean(extractMixedSourceNotebookPlan(payloadOf(artifact))),
  );
  return !hasMixedSourcePlan
    && run.status !== 'blocked'
    && run.status !== 'cancelled'
    && run.stopReason !== 'cancelled'
    && run.status !== 'needs_clarification'
    // A run that produced only a DQL artifact — "the DQL from Ask AI" — is
    // exactly what people want on a page, but it used to render no Add-to-App
    // button at all because it carries no `answer` artifact. This mirrors the
    // `canSaveBlock` gate, which already accepted that case.
    && (run.artifacts.some((artifact) => artifact.kind === 'answer' || artifact.kind === 'research_run')
      || Boolean(answerDqlArtifactFromRun(run) ?? answerSqlFromRun(run)));
}

function AskInspector({
  run,
  artifact,
  tab,
  t,
  appContext,
  onOpenApp,
  onChangeTab,
  onClose,
  onSaveBlock,
  onInsertSql,
  onInsertDql,
}: {
  run: AgentRun;
  artifact: AgentRunArtifact;
  tab: AskInspectorTab;
  t: Theme;
  appContext?: { appId?: string; dashboardId?: string; dashboardTitle?: string };
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
  onChangeTab: (tab: AskInspectorTab) => void;
  onClose: () => void;
  onSaveBlock: () => void;
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
}) {
  const hostUiState = useHostUi();
  const payload = payloadOf(artifact);
  const dqlArtifact = answerDqlArtifactFromRun(run) ?? resolveArtifactDqlView(payload);
  const sqlEvidence = answerSqlEvidenceFromRun(run) ?? (typeof payload.sql === 'string' && payload.sql.trim() ? { sql: payload.sql, origin: 'compiled' as const } : undefined);
  const sql = sqlEvidence?.sql;
  const resultData = extractResult(payload);
  const insertTitle = resultCardTitle(run, artifact);
  const evidence = evidenceFromRun(run);
  const lineage = lineageEntriesFromRun(run);
  const trustNote = trustExplainer(run);
  const certified = artifact.trustState === 'certified';
  const cancelled = run.status === 'cancelled' || run.stopReason === 'cancelled' || run.route === 'cancelled';
  const blocked = !cancelled && (run.status === 'blocked' || artifact.trustState === 'blocked');
  const pinnable = isAgentRunPinnable(run);
  // Saving an answer as a block is authoring; under a host, only for people who may (HH-9).
  const mayAuthorBlocks = hostAllows(hostUiState, 'dataset.author');
  // V8 is persisted at the run boundary. An older answer artifact may not
  // duplicate it, but it still deserves the compact authoritative story.
  const analytical = analyticalInspectorContract(payload)
    ?? (run.diagnosticReceiptV8?.mode === 'authoritative_v2' ? {} : undefined);
  // An Ask pipeline run explains itself step by step from its own record.
  const runExplanation = useAskRunExplanation(run, payload);
  const explanation = runExplanation.explanation;
  const { dispatch } = useNotebook();
  const traceRunId = run.agentRunId ?? (run.traceReference ? run.id : undefined);
  // A Research investigation explains itself program by program.
  const investigationReport = useMemo(() => (artifact.kind === 'research_run' ? investigationReportOf(payload) : undefined), [artifact.kind, payload]);
  const investigationExplanation = useMemo(
    () => (investigationReport ? explainInvestigation({ receipt: run.diagnosticReceiptV9, report: investigationReport }) : undefined),
    [investigationReport, run.diagnosticReceiptV9],
  );

  const tabs = askInspectorTabsForState({
    analytical: Boolean(analytical),
    blocked,
    hasDql: Boolean(dqlArtifact?.source),
    hasSql: Boolean(sql),
    hasLineage: lineage.length > 0,
    pipeline: Boolean(explanation),
    hasChecks: Boolean(explanation?.checks.length),
    investigation: Boolean(investigationExplanation),
  });
  const activeTab = tabs.some((x) => x.id === tab) ? tab : tabs[0].id;

  const badgeLabel = cancelled ? 'Cancelled' : blocked ? 'Blocked' : certified ? 'Certified' : artifact.trustState === 'governed' || artifact.trustState === 'grounded' ? 'Governed' : investigationReport ? 'Review required' : isAppViewPayload(payload) ? 'Needs review' : 'AI-generated';
  const badgeColor = cancelled ? 'var(--text-tertiary)' : blocked ? 'var(--status-error)' : certified ? 'var(--status-success)' : artifact.trustState === 'governed' || artifact.trustState === 'grounded' ? 'var(--accent)' : 'var(--status-warning)';
  const badgeBg = cancelled ? 'var(--bg-3)' : blocked ? 'var(--status-error-bg)' : certified ? 'var(--status-success-bg)' : artifact.trustState === 'governed' || artifact.trustState === 'grounded' ? 'var(--accent-dim)' : 'var(--status-warning-bg)';

  return (
    <div style={{ width: 'clamp(300px, 34vw, 440px)', flexShrink: 0, background: 'var(--bg-2)', borderLeft: '1px solid var(--border-default)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '14px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ width: 32, height: 32, borderRadius: 8, background: badgeBg, color: badgeColor, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: '1px solid var(--border-subtle)' }}>
          <ArtifactIcon kind={artifact.kind} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 650, color: t.textPrimary, lineHeight: 1.35 }}>{resultCardTitle(run, artifact)}</div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>{askArtifactMeta(artifact, payload)}</div>
        </div>
        <span style={{ border: `1px solid ${badgeColor}`, color: badgeColor, background: badgeBg, borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 700, flexShrink: 0, marginTop: 2 }}>{badgeLabel}</span>
        <button type="button" onClick={onClose} title="Close" className="dql-ask-ghost" style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'none', color: t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
          <X size={14} />
        </button>
      </div>

      {/* Action row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        {pinnable ? <AddToAppButton run={run} t={t} appContext={appContext} onOpenApp={onOpenApp} /> : null}
        {pinnable && mayAuthorBlocks ? (
          <button type="button" className="dql-hover" onClick={onSaveBlock} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-2)', color: t.textSecondary, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: t.font }}>
            <Blocks size={13} /> Save as saved query
          </button>
        ) : null}
        <div style={{ flex: 1 }} />
        <button type="button" title="More" className="dql-hover" style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border-default)', background: 'var(--bg-2)', color: t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <MoreHorizontal size={14} />
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
        {tabs.map((x) => (
          <button key={x.id} type="button" onClick={() => onChangeTab(x.id)} style={{ padding: '10px 1px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none', background: 'none', fontFamily: t.font, whiteSpace: 'nowrap', color: activeTab === x.id ? t.textPrimary : t.textMuted, boxShadow: activeTab === x.id ? `inset 0 -2px 0 0 ${t.accent}` : 'none' }}>{x.label}</button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 16px 20px' }}>
        {activeTab === 'how' && investigationExplanation ? (
          <InvestigationFlow
            explanation={investigationExplanation}
            t={t}
            onOpenTrace={traceRunId ? () => dispatch({ type: 'OPEN_ASK_TRACE', runId: traceRunId }) : undefined}
          />
        ) : activeTab === 'how' && explanation ? (
          <AskRunFlow
            explanation={explanation}
            t={t}
            onOpenTab={onChangeTab}
            onOpenTrace={traceRunId ? () => dispatch({ type: 'OPEN_ASK_TRACE', runId: traceRunId }) : undefined}
          />
        ) : activeTab === 'how' && analytical ? (
          <AnalyticalHowAnswered
            run={run}
            contract={analytical}
            dqlArtifact={dqlArtifact}
            sql={sql}
            lineage={lineage}
            t={t}
            onInsertSql={onInsertSql}
            onInsertDql={onInsertDql}
            onSaveBlock={onSaveBlock}
          />
        ) : null}
        {activeTab === 'dql' ? (
          dqlArtifact?.source ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: t.textMuted }}>Reusable governed artifact — save it as a saved query to certify.</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {onInsertDql ? (
                    <button
                      type="button"
                      onClick={() => onInsertDql({
                        sql,
                        dqlArtifact,
                        result: resultData,
                        chartConfig: resultData ? extractChartConfig(payload, resultData) : undefined,
                        title: insertTitle,
                        sourceRunId: run.id,
                        question: run.question,
                      })}
                      style={smallButtonStyle(t)}
                    >
                      Open DQL in notebook
                    </button>
                  ) : null}
                  <CopyButton text={dqlArtifact.source} t={t} title="Copy DQL" />
                </div>
              </div>
              <pre style={codeStyle(t)}>{dqlArtifact.source}</pre>
            </>
          ) : (
            <InspectorEmpty t={t}>The selected plan failed before a DQL source could be materialized. Review the Plan and Failure & repair sections.</InspectorEmpty>
          )
        ) : null}
        {activeTab === 'sql' ? (
          sql ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: t.textMuted }}>{ANSWER_SQL_LABELS[sqlEvidence?.origin ?? 'compiled']} Open it in Notebook to inspect or repair.</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {onInsertSql ? (
                    <button
                      type="button"
                      onClick={() => onInsertSql(sql, insertTitle, {
                        question: run.question,
                        sourceRunId: run.id,
                      })}
                      style={smallButtonStyle(t)}
                    >
                      Open SQL in notebook
                    </button>
                  ) : null}
                  <CopyButton text={sqlEvidence?.params?.length ? `${sql}\n\n-- parameters\n${sqlEvidence.params.map((value, index) => `-- $${index + 1} = ${JSON.stringify(value)}`).join('\n')}` : sql} t={t} title="Copy SQL" />
                </div>
              </div>
              <pre style={codeStyle(t)}>{sql}</pre>
              {sqlEvidence?.params?.length ? (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: t.textMuted, marginBottom: 4 }}>Bound parameters, in order — the placeholders above stand for these values.</div>
                  <div style={{ display: 'grid', gap: 3 }}>
                    {sqlEvidence.params.map((value, index) => (
                      <div key={`sql-param-${index + 1}`} style={{ display: 'flex', gap: 8, fontSize: 11.5, fontFamily: 'var(--font-mono, monospace)', color: t.textPrimary }}>
                        <span style={{ color: t.textMuted, minWidth: 26 }}>${index + 1}</span>
                        <span>{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <InspectorEmpty t={t}>Compilation stopped before SQL was produced. The DQL, plan, trust evidence, and failure steps are still retained.</InspectorEmpty>
          )
        ) : null}
        {activeTab === 'data' && explanation ? <AskRunDataUsed data={explanation.dataUsed} t={t} /> : null}
        {activeTab === 'checks' && explanation ? <AskRunChecks checks={explanation.checks} t={t} /> : null}
        {activeTab === 'lineage' ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>Governed semantic objects and physical sources used to produce this result.</div>
            {lineage.map((entry) => (
              <div key={`${entry.kind ?? 'asset'}:${entry.name}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 10px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-1)' }}>
                <GitBranch size={13} color={t.accent} style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 650, color: t.textPrimary }}>{entry.name}</div>
                  <div style={{ fontSize: 10.5, color: t.textMuted, marginTop: 2 }}>{[entry.kind, entry.detail].filter(Boolean).join(' · ')}</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {activeTab === 'trust' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {runExplanation.unavailable ? <InspectorEmpty t={t}>The step-by-step record for this answer is no longer kept.</InspectorEmpty> : null}
            {trustNote ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, background: certified ? 'var(--status-success-bg)' : 'var(--status-warning-bg)', border: `1px solid ${certified ? 'var(--status-success-border)' : 'var(--status-warning-border)'}` }}>
                {certified ? <ShieldCheck size={13} color="var(--status-success)" style={{ flexShrink: 0, marginTop: 1 }} /> : <ShieldAlert size={13} color="var(--status-warning)" style={{ flexShrink: 0, marginTop: 1 }} />}
                <span style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.5 }}>{trustNote}</span>
              </div>
            ) : null}
            <RunContextNote run={run} t={t} />
            {evidence.length > 0 ? (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Evidence</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {evidence.map((ev) => (
                    <span key={ev.label} style={evidenceChipStyle(t, ev.certified)}>
                      {ev.certified ? <ShieldCheck size={11} /> : <FileSearch size={11} />}<span>{ev.label}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {run.evaluations.length > 0 ? (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Verification checks</div>
                <VerificationChecks evaluations={run.evaluations} t={t} />
              </div>
            ) : null}
            {run.steps.length > 0 ? (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>Steps</div>
                <StepTrace steps={run.steps} t={t} />
              </div>
            ) : null}
            <AppliedLearnings run={run} t={t} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FollowUpPopover({
  t,
  text,
  source,
  left,
  top,
  draft,
  inputRef,
  onDraftChange,
  onClose,
  onSend,
}: {
  t: Theme;
  text: string;
  source: 'answer' | 'table';
  left: number;
  top: number;
  draft: string;
  inputRef: React.RefObject<HTMLInputElement>;
  onDraftChange: (value: string) => void;
  onClose: () => void;
  onSend: (question: string) => void;
}) {
  const chip = (label: string, question: string) => (
    <button type="button" onClick={() => onSend(question)} style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-1)', color: t.textSecondary, borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 550, cursor: 'pointer', fontFamily: t.font }}>{label}</button>
  );
  return (
    <div data-selpop="true" style={{ position: 'fixed', left, top, zIndex: 90, width: 324, background: 'var(--bg-2)', border: '1px solid var(--border-default)', borderRadius: 12, boxShadow: '0 10px 32px rgba(26,26,26,0.16)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, animation: 'dql-agent-fadein 0.14s ease-out', fontFamily: t.font }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Sparkles size={12} color={t.accent} />
        <span style={{ fontSize: 11, fontWeight: 700, color: t.textSecondary }}>Follow up on this</span>
        <span style={{ fontSize: 10, color: t.textMuted }}>{source === 'table' ? 'from the result' : 'from the answer'}</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onClose} style={{ width: 20, height: 20, borderRadius: 5, border: 'none', background: 'none', color: t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0 }}><X size={12} /></button>
      </div>
      <div style={{ borderLeft: `2px solid ${t.accent}`, background: 'var(--accent-dim)', borderRadius: '0 6px 6px 0', padding: '5px 9px', fontSize: 11.5, color: t.textSecondary, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>“{text}”</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSend(draft); } }}
          placeholder="Ask about this…"
          style={{ flex: 1, minWidth: 0, border: '1px solid var(--border-default)', borderRadius: 8, padding: '7px 10px', fontSize: 12.5, fontFamily: t.font, color: t.textPrimary, background: 'var(--bg-1)', outline: 'none' }}
        />
        <button type="button" onClick={() => onSend(draft)} title="Send follow-up" style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><ArrowUp size={13} /></button>
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {chip('Why is this?', 'Why is this happening?')}
        {chip('Root cause', 'What is the root cause?')}
        {chip('Break it down', 'Break this down further')}
      </div>
    </div>
  );
}

function defaultAppName(question: string): string {
  const cleaned = question.replace(/^\/\w+\s+/, '').trim().replace(/[?.!]+$/, '');
  const title = cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'New app';
  return title.slice(0, 60);
}

/**
 * Keep Ask-to-App failures actionable. A raw 405 here means the browser bundle
 * is talking to a Notebook runtime that predates the unified App Build API (or
 * was not restarted after rebuilding). Falling back to the legacy `/api/apps`
 * write would bypass the private-draft contract, so fail closed and explain the
 * one safe recovery instead.
 */
export function askAppWriteErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : '';
  if ((error instanceof DqlApiError && error.status === 405) || /method not allowed/i.test(message)) {
    return 'This Notebook server is older than the App Studio shown in your browser. Restart zlens notebook, reload this page, and try again. No Project files were published.';
  }
  return message || fallback;
}

export function appPinDestinationLabel(appName: string, dashboardTitle?: string): string {
  return dashboardTitle?.trim() ? `${appName} › ${dashboardTitle.trim()}` : appName;
}

export interface AskAppDestination {
  id: string;
  kind: 'draft' | 'project';
  appId: string;
  name: string;
  draft?: AppStudioBuildDraft;
  pageId?: string;
  pageTitle?: string;
}

/** Coalesce Project Apps that already have a local edit draft into one choice. */
export function askAppDestinations(apps: AppSummary[], drafts: AppStudioBuildDraft[]): AskAppDestination[] {
  const localDrafts = drafts.filter((draft) => draft.state !== 'project_published');
  const draftedProjectIds = new Set(localDrafts.flatMap((draft) => draft.baseApp?.appId ? [draft.baseApp.appId] : []));
  return [
    ...localDrafts.map((draft): AskAppDestination => ({
      id: `draft:${draft.id}`,
      kind: 'draft',
      appId: draft.appId,
      name: draft.name,
      draft,
      pageId: draft.pages[0]?.id,
      pageTitle: draft.pages[0]?.metadata.title,
    })),
    ...apps.filter((app) => !draftedProjectIds.has(app.id)).map((app): AskAppDestination => {
      const pageId = app.homepage?.type === 'dashboard' ? app.homepage.id : app.dashboards[0]?.id;
      return {
        id: `project:${app.id}`,
        kind: 'project',
        appId: app.id,
        name: app.name,
        pageId,
        pageTitle: app.dashboards.find((dashboard) => dashboard.id === pageId)?.title,
      };
    }),
  ];
}

/**
 * Save an Ask result into the unified local AppBuildDraft. The result remains
 * editable in Studio; certified answers keep their block identity and all
 * other answers are materialized as review-required local evidence.
 */
/** Adding an answer to an App is authoring it; under a host, only for people who may (HH-9). */
function AddToAppButton(props: Parameters<typeof AddToAppMenu>[0]) {
  return hostAllows(useHostUi(), 'app.author') ? <AddToAppMenu {...props} /> : null;
}

function AddToAppMenu({
  run,
  t,
  appContext,
  onOpenApp,
}: {
  run: AgentRun;
  t: Theme;
  appContext?: { appId?: string; dashboardId?: string; dashboardTitle?: string };
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [destinations, setDestinations] = useState<AskAppDestination[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<'list' | 'new'>('list');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** With a host: the answer's text could not be added (its figures depend on who looks); this adds it live instead. */
  const [liveInstead, setLiveInstead] = useState<(() => Promise<void>) | null>(null);
  /** The tile name, editable before adding rather than silently derived. */
  const [tileName, setTileName] = useState('');
  const [done, setDone] = useState<{
    appId: string;
    draftId: string;
    pageId?: string;
    name: string;
    pageTitle?: string;
    tileTitle: string;
    kind: 'certified' | 'review' | 'narrative' | 'existing';
  } | null>(null);
  const createdRef = useRef<AppStudioBuildDraft | null>(null);

  const loadApps = async () => {
    setDestinations(null);
    setLoadError(false);
    const [projectApps, appBuilds] = await Promise.allSettled([api.listAppsStrict(), api.listAppBuilds()]);
    if (projectApps.status === 'rejected' && appBuilds.status === 'rejected') {
      setDestinations([]);
      setLoadError(true);
      return;
    }
    const choices = askAppDestinations(
      projectApps.status === 'fulfilled' ? projectApps.value : [],
      appBuilds.status === 'fulfilled' ? appBuilds.value.drafts : [],
    );
    setDestinations(choices);
    if (choices.length === 0) setView('new');
  };

  const openPicker = () => {
    setOpen(true);
    setError(null);
    setView('list');
    createdRef.current = null;
    setNewName(defaultAppName(run.question));
    setTileName(defaultAppName(run.question));
    void loadApps();
  };

  const closePicker = () => {
    if (busy) return; // don't dismiss mid-write (would hide the error/result)
    setOpen(false);
    setError(null);
  };

  const addToDraft = async (draft: AppStudioBuildDraft, name: string, requestedPageId?: string, pageTitle?: string, live = false) => {
    const tileTitle = tileName.trim() || defaultAppName(run.question);
    const dqlArtifact = answerDqlArtifactFromRun(run);
    const certifiedBlock = certifiedBlockNameFromRun(run);
    setLiveInstead(null);
    let result: Awaited<ReturnType<typeof api.addAskResultToAppBuild>>;
    try {
      result = await api.addAskResultToAppBuild(draft.id, {
        expectedRevision: draft.revision,
        expectedProposalHash: draft.proposalHash,
        pageId: requestedPageId,
        title: tileTitle,
        question: run.question,
        answer: acceptedAskAnswer(run) ?? run.summary,
        certifiedBlockId: certifiedBlock,
        dqlSource: dqlArtifact?.source,
        sql: answerSqlFromRun(run),
        visualization: runChartConfig(run)?.chart,
        runId: run.id,
        ...(live ? { mode: 'live' as const } : {}),
      });
    } catch (e) {
      // With a host, an answer whose figures depend on who looks is added as a live tile, never as its text.
      if (!live && e instanceof DqlApiError && e.code === 'ANSWER_FIGURES_DEPEND_ON_READER'
        && Array.isArray((e.details as { ways?: unknown } | undefined)?.ways) && ((e.details as { ways: Array<{ id?: string }> }).ways).some((way) => way.id === 'live')) {
        setLiveInstead(() => async () => {
          setBusy(true);
          setError(null);
          try {
            await addToDraft(draft, name, requestedPageId, pageTitle, true);
          } catch (again) {
            setError(askAppWriteErrorMessage(again, 'Could not add to app.'));
          } finally {
            setBusy(false);
          }
        });
      }
      throw e;
    }
    setDone({
      appId: result.draft.appId,
      draftId: result.draft.id,
      pageId: result.pageId,
      name,
      pageTitle: result.draft.pages.find((page) => page.id === result.pageId)?.metadata.title ?? pageTitle,
      tileTitle,
      kind: result.deduped ? 'existing' : certifiedBlock ? 'certified' : (dqlArtifact?.source || answerSqlFromRun(run)) ? 'review' : 'narrative',
    });
    window.dispatchEvent(new CustomEvent('dql-app-build-updated', {
      detail: { draft: result.draft, pageId: result.pageId, tileId: result.tileId },
    }));
    setOpen(false);
  };

  const ensureDraft = async (destination: AskAppDestination): Promise<AppStudioBuildDraft> => {
    if (destination.draft) return destination.draft;
    const latest = await api.listAppBuilds();
    const existing = latest.drafts.find((draft) => draft.state !== 'project_published' && draft.baseApp?.appId === destination.appId);
    if (existing) return existing;
    return (await api.createAppBuild({
      baseAppId: destination.appId,
      goal: `Edit ${destination.name} with an Ask result`,
      authoringMode: 'ai',
      sourcePolicy: certifiedBlockNameFromRun(run) ? 'governed_only' : 'include_review_required',
      template: 'blank',
      entrypoint: 'ask',
    })).draft;
  };

  const addToExisting = async (destination: AskAppDestination) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const draft = await ensureDraft(destination);
      const pageId = appContext?.appId === destination.appId ? appContext.dashboardId : destination.pageId;
      await addToDraft(draft, destination.name, pageId, destination.pageTitle);
    } catch (e) {
      setError(askAppWriteErrorMessage(e, 'Could not add to app.'));
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    if (busy) return;
    const name = newName.trim() || defaultAppName(run.question);
    setBusy(true);
    setError(null);
    try {
      // Reuse an app already created this session if the prior pin failed.
      if (!createdRef.current) {
        createdRef.current = (await api.createAppBuild({
          name,
          goal: run.question,
          authoringMode: 'ai',
          sourcePolicy: certifiedBlockNameFromRun(run) ? 'governed_only' : 'include_review_required',
          template: 'blank',
          entrypoint: 'ask',
        })).draft;
      }
      await addToDraft(createdRef.current, name, createdRef.current.pages[0]?.id, createdRef.current.pages[0]?.metadata.title);
      createdRef.current = null;
    } catch (e) {
      setError(askAppWriteErrorMessage(e, 'Could not create the app.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {done ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr) auto',
            alignItems: 'center',
            gap: 8,
            minWidth: 260,
            maxWidth: 440,
            padding: '8px 9px',
            borderRadius: 9,
            background: `${t.success}12`,
            color: t.success,
            border: `1px solid ${t.success}55`,
          }}
        >
          <span style={{ width: 26, height: 26, borderRadius: 999, display: 'grid', placeItems: 'center', background: `${t.success}20` }}>
            <CheckCircle2 size={15} />
          </span>
          <span style={{ display: 'grid', gap: 1, minWidth: 0 }}>
            <b style={{ fontSize: 11.5 }}>
              {done.kind === 'existing'
                ? 'Already on this page'
                : done.kind === 'certified'
                  ? 'Saved as a certified tile'
                  : done.kind === 'review'
                    ? 'Saved — review required'
                    : 'Saved as editable narrative'}
            </b>
            <span title={appPinDestinationLabel(done.name, done.pageTitle)} style={{ fontSize: 10.5, color: t.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {appPinDestinationLabel(done.name, done.pageTitle)} · editable draft
            </span>
            <span title={done.tileTitle} style={{ fontSize: 10, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Tile: {done.tileTitle}
            </span>
            {done.kind === 'review' || done.kind === 'narrative' ? (
              <span style={{ fontSize: 10, color: t.textMuted, lineHeight: 1.35 }}>
                Stays local and cannot publish until reviewed, promoted, or removed.
              </span>
            ) : null}
          </span>
          {onOpenApp ? (
            <button
              type="button"
              className="dql-hover"
              onClick={() => onOpenApp(done.appId, done.pageId, done.draftId)}
              style={{ ...smallButtonStyle(t), color: t.success, whiteSpace: 'nowrap' }}
              title="Open the App page containing this tile"
            >
              Open App <ArrowRight size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="dql-hover dql-lift" onClick={openPicker} style={done ? smallButtonStyle(t) : heroAddButtonStyle(t)}>
        <LayoutDashboard size={13} />
        {done ? 'Add to another' : 'Add to app'}
      </button>
      {open ? (
        <>
          <div onClick={closePicker} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={addPopoverStyle(t)}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{view === 'new' ? 'Name the new App draft' : 'Save to an editable App'}</span>
              <button type="button" onClick={closePicker} style={{ border: 'none', background: 'transparent', color: t.textMuted, cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
            </div>
            {error ? <div style={{ fontSize: 11, color: t.error, marginBottom: 7, lineHeight: 1.4 }}>{error}</div> : null}
            {error && liveInstead ? (
              <button type="button" className="dql-hover" disabled={busy} onClick={() => void liveInstead()} style={{ ...smallButtonStyle(t), marginBottom: 8 }}>
                Add as a live tile
              </button>
            ) : null}
            {view === 'new' ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void createAndAdd(); }}
                  placeholder="App name"
                  style={pickerInputStyle(t)}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  {destinations && destinations.length > 0 ? <button type="button" className="dql-hover" onClick={() => setView('list')} style={smallButtonStyle(t)}>Back</button> : null}
                  <button type="button" className="dql-hover" disabled={busy || !newName.trim()} onClick={() => void createAndAdd()} style={{ ...heroAddButtonStyle(t), flex: 1, justifyContent: 'center' }}>
                    {busy ? <Loader2 size={13} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Plus size={13} />}
                    Create draft &amp; add
                  </button>
                </div>
              </div>
            ) : destinations === null ? (
              <div style={{ fontSize: 11.5, color: t.textMuted, padding: '8px 2px' }}>Loading apps…</div>
            ) : loadError ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 11.5, color: t.error, lineHeight: 1.4 }}>Couldn't load your apps.</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="dql-hover" onClick={() => void loadApps()} style={smallButtonStyle(t)}>Retry</button>
                  <button type="button" className="dql-hover" onClick={() => setView('new')} style={{ ...newAppRowStyle(t), width: 'auto', flex: 1, marginBottom: 0, justifyContent: 'center' }}>
                    <Plus size={13} /> New app…
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 3, maxHeight: 244, overflow: 'auto' }}>
                {/* Name the tile before it lands. It used to be derived from the
                    question with no way to change it afterwards. */}
                <label style={{ display: 'grid', gap: 3, marginBottom: 5 }}>
                  <span style={{ fontSize: 10.5, color: t.textMuted }}>Tile name</span>
                  <input
                    value={tileName}
                    onChange={(e) => setTileName(e.target.value)}
                    placeholder={defaultAppName(run.question)}
                    maxLength={120}
                    style={pickerInputStyle(t)}
                  />
                </label>
                <button type="button" className="dql-hover" onClick={() => setView('new')} style={newAppRowStyle(t)}>
                  <Plus size={13} /> New app…
                </button>
                {destinations.map((destination) => (
                  <button key={destination.id} type="button" className="dql-hover" disabled={busy} onClick={() => void addToExisting(destination)} style={appRowStyle(t)}>
                    <LayoutDashboard size={13} style={{ flex: '0 0 auto', opacity: 0.7 }} />
                    <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 1, overflow: 'hidden', textAlign: 'left' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{destination.name}</span>
                      <small style={{ color: t.textMuted }}>{destination.kind === 'draft' ? 'Local editable draft' : 'Project App · creates a safe edit draft'}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Plain-English trust line so a stakeholder knows what they can rely on. */
/**
 * EXP-002 — the trust explainer must reflect execution truth. An exploratory
 * candidate is not an executed answer merely because dbt-grounded SQL exists.
 */
export function trustExplainer(run: AgentRun): string | null {
  if (run.status === 'cancelled' || run.stopReason === 'cancelled' || run.route === 'cancelled') return 'Stopped by user. No result was accepted.';
  if (run.trustState === 'review_required' && run.route === 'semantic_answer') {
    return 'Review required: ZLens inferred the semantic grouping for the requested dimension. Verify this business mapping before reuse.';
  }
  if (readFromAppView(run)) {
    if (run.trustState === 'certified') return 'Read from this App’s current results; every tile it read runs a certified source.';
    if (run.trustState === 'governed') return 'Read from this App’s current results, from governed tiles.';
    return 'Read from this App’s current results. A tile it read needs review: check its source before relying on it.';
  }
  if (run.trustState === 'certified') return 'Answered from a certified saved query.';
  if (run.route === 'dql_block_draft') return 'Prepared an ownerless review draft. Add it to Saved queries when you are ready to save it.';
  if (run.trustState === 'governed' && answerSourceOf(run) === 'block_as_evidence') return 'Served from a certified saved query as published; the saved query is not certified for this exact question.';
  if (run.trustState === 'governed') return 'Built from semantic metrics and dimensions.';
  if (run.trustState === 'grounded') return 'Ran cleanly against your data. Save it as a saved query when it is reusable.';
  if (isExploratoryDbtRun(run)) {
    const payloads = run.artifacts
      .map((artifact) => artifact.payload)
      .filter((payload): payload is Record<string, unknown> => Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)));
    const executed = payloads.some((payload) => {
      const result = payload.result;
      return Boolean(result && typeof result === 'object' && !Array.isArray(result));
    });
    if (executed) {
      return 'Exploratory · DBT-grounded. The query and bounded join probes ran, but no certified relationship path covers it yet.';
    }
    const executionError = payloads.find((payload) => typeof payload.executionError === 'string')?.executionError;
    if (typeof executionError === 'string' && executionError.trim()) {
      return 'Exploratory · DBT-grounded. ZLens prepared a review-required query, but its bounded execution failed. Inspect the error and DQL artifact before reuse.';
    }
    return 'Exploratory · DBT-grounded. ZLens prepared a review-required query, but it has not executed yet.';
  }
  // Authoring routes produce a source proposal, not an answer. Telling the user
  // to "save it as a block" there is both wrong and the reason Modeling AI still
  // read as Ask AI: a modeling/skill draft is saved to its YAML after review.
  if (run.route === 'modeling_draft') return 'AI-drafted modeling proposal. Review the exact source diff, then save it as a draft — nothing is written or joinable yet.';
  if (run.route === 'skill_draft') return 'AI-drafted Skill proposal. Review it, then save it as a draft — it will not guide any agent until you activate it.';
  if (run.trustState === 'review_required' && answerSourceOf(run) === 'block_as_evidence') return 'Computed by a certified saved query that is not certified for this question, and the reading does not cover all of it: review it before relying on it.';
  if (run.trustState === 'review_required' && answerSourceOf(run) === 'governed_definitions') return 'Computed from governed definitions, but the reading does not cover all of the question: review it before relying on it.';
  if (run.trustState === 'review_required') return 'AI-generated answer. Save it as a saved query when you want to keep it.';
  if (run.trustState === 'blocked') return null;
  return null;
}

function isExploratoryDbtRun(run: AgentRun): boolean {
  return run.artifacts.some((artifact) => {
    const payload = artifact.payload;
    return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Record<string, unknown>).exploratoryCandidate);
  });
}

export function simpleRunTitle(run: AgentRun): string {
  if (run.status === 'cancelled' || run.stopReason === 'cancelled' || run.route === 'cancelled') return 'Stopped by user';
  // No model ran: say what Ask needs, never "AI-generated answer" (round 3).
  if (askNeedsAiProvider(run)) return ASK_NEEDS_AI_PROVIDER_HEADING;
  if (run.trustState === 'certified' || readFromAppView(run)) return answerTrustHeading(run);
  if (run.route === 'dql_block_draft') return 'Draft saved query';
  if (isExploratoryDbtRun(run)) return 'Exploratory DBT-grounded answer';
  // The route is not the source: a certified block served as evidence runs on
  // the generated_answer route without any SQL the AI wrote.
  if (run.route === 'semantic_answer' || run.route === 'generated_answer' || run.route === 'certified_answer') return answerTrustHeading(run);
  return ROUTE_LABEL[run.route];
}

/**
 * The `app_proposal` artifact card: the Ask App proposal before it opens in
 * App Studio (design D9). Per-tile toggles choose the data the App keeps;
 * "Open in App Studio" makes a local App Studio draft (no App files) and opens
 * Apps on it at the AI Data step. Publishing goes through the publish checks.
 */
function AppProposalArtifact({
  artifact,
  payload,
  t,
  onOpenApp,
}: {
  artifact: AgentRunArtifact;
  payload: Record<string, unknown>;
  t: Theme;
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
}) {
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
  const proposal = payload.proposal && typeof payload.proposal === 'object'
    ? payload.proposal as AppBuildProposal
    : undefined;
  const proposalHash = typeof payload.proposalHash === 'string' ? payload.proposalHash : undefined;
  const [selected, setSelected] = useState<Set<string>>(() => (proposal ? defaultProposalSelection(proposal) : new Set()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ appId: string; draftId: string; name: string } | null>(null);

  if (!proposal || !sessionId) {
    return (
      <div style={artifactStyle(t)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ArtifactIcon kind={artifact.kind} />
          <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary }}>{artifact.title}</div>
        </div>
        <div style={{ fontSize: 11.5, color: t.textMuted }}>This proposal is no longer available. Ask again to rebuild it.</div>
      </div>
    );
  }

  const openInStudio = async (edits: AppBuildBriefEdits) => {
    setBusy(true);
    setError(null);
    const result = await openAppProposalInStudio({
      sessionId,
      selectedTileIds: selected,
      proposalHash,
      edits,
      openInStudio: (id, input) => api.openAppAiBuildInStudio(id, input),
      onOpenApp,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpened({ appId: result.appId, draftId: result.draftId, name: result.name });
  };

  return (
    <div style={artifactStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ArtifactIcon kind={artifact.kind} />
        <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cleanPresentationText(artifact.title)}
        </div>
      </div>
      {opened ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: t.success, fontSize: 12, fontWeight: 750 }}>
            <CheckCircle2 size={13} /> {opened.name} is a draft in App Studio
          </span>
          {onOpenApp ? (
            <button type="button" className="dql-hover" onClick={() => onOpenApp(opened.appId, undefined, opened.draftId)} style={smallButtonStyle(t)}>
              {OPEN_IN_APP_STUDIO_LABEL}
            </button>
          ) : (
            <span style={{ fontSize: 11.5, color: t.textMuted }}>Find it in Apps under Drafts.</span>
          )}
        </div>
      ) : (
        <AppBuildProposalPanel
          proposal={proposal}
          t={t}
          selected={selected}
          onToggle={(tileId) => {
            setSelected((current) => {
              const next = new Set(current);
              if (next.has(tileId)) next.delete(tileId);
              else next.add(tileId);
              return next;
            });
          }}
          onCreate={(edits) => void openInStudio(edits)}
          defaultName={artifact.title}
          busy={busy}
          error={error}
          compact
        />
      )}
    </div>
  );
}

function ExecutableDqlResult({
  artifact,
  certifiedBlockName,
  initialResult,
  initialChartConfig,
  payload,
  executionTarget,
  t,
  themeMode,
  embedded = false,
  expanded = false,
}: {
  artifact: AgentConversationDqlArtifact;
  certifiedBlockName?: string;
  initialResult: QueryResult;
  initialChartConfig?: CellChartConfig;
  payload: Record<string, unknown>;
  executionTarget?: ExecutionTarget;
  t: Theme;
  themeMode: ThemeMode;
  embedded?: boolean;
  expanded?: boolean;
}) {
  const [activeArtifact, setActiveArtifact] = useState<AgentConversationDqlArtifact>(artifact);
  const [parameters, setParameters] = useState<BlockParameterDefinition[]>(() => artifact.parameters ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...(artifact.parameterValues ?? {}),
    ...resolvedParameterValues(payload),
  }));
  const [result, setResult] = useState(initialResult);
  const [chartConfig, setChartConfig] = useState<CellChartConfig | undefined>(initialChartConfig);
  const [loading, setLoading] = useState(Boolean(certifiedBlockName));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingFilter, setAddingFilter] = useState(false);
  const [filterColumn, setFilterColumn] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const runInFlightRef = useRef(false);
  const upstreamArtifactRef = useRef(artifact);
  upstreamArtifactRef.current = artifact;
  const artifactStateKey = askArtifactStateKey(artifact);

  useEffect(() => {
    const upstreamArtifact = upstreamArtifactRef.current;
    setActiveArtifact(upstreamArtifact);
    setAddingFilter(false);
    if (!certifiedBlockName) {
      setParameters(upstreamArtifact.parameters ?? []);
      setValues({
        ...(upstreamArtifact.parameterValues ?? {}),
        ...resolvedParameterValues(payload),
      });
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api.getCertifiedBlockParameters(certifiedBlockName)
      .then((response) => {
        if (cancelled) return;
        setParameters(response.parameters);
        setValues((current) => ({
          ...Object.fromEntries(response.parameters.flatMap((parameter) => parameter.default === undefined ? [] : [[parameter.name, parameter.default]])),
          ...current,
        }));
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [artifactStateKey, certifiedBlockName]);

  const run = async () => {
    if (runInFlightRef.current) return;
    runInFlightRef.current = true;
    setRunning(true);
    setError(null);
    try {
      const response = await api.invokeDqlArtifact(activeArtifact, values, undefined, certifiedBlockName, executionTarget);
      setResult(response.result);
      setActiveArtifact(response.artifact);
      if (response.result.chartConfig && typeof response.result.chartConfig === 'object') {
        setChartConfig(response.result.chartConfig as CellChartConfig);
      }
      if (response.parameters.length > 0) setParameters(response.parameters);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      runInFlightRef.current = false;
      setRunning(false);
    }
  };

  const filterCandidates = useMemo(
    () => askResultFilterCandidates(activeArtifact, result),
    [activeArtifact, result],
  );
  const openFilterEditor = () => {
    const candidate = filterCandidates[0];
    if (!candidate) return;
    setFilterColumn(candidate.column);
    setFilterValue(candidate.values[0] == null ? '' : String(candidate.values[0]));
    setAddingFilter(true);
    setError(null);
  };
  const addResultFilter = async () => {
    try {
      // A generated SQL answer needs a real dialect parse to place the
      // predicate, so the server owns that edit. A semantic block binds to a
      // declared dimension and stays local.
      const added = activeArtifact.kind === 'sql_block'
        ? await api.addDqlArtifactResultFilter(activeArtifact, result.columns, filterColumn, filterValue, executionTarget)
        : addAskResultFilter(activeArtifact, result, filterColumn, filterValue);
      setActiveArtifact(added.artifact as typeof activeArtifact);
      setParameters(added.artifact.parameters ?? []);
      setValues((current) => ({ ...current, ...(added.artifact.parameterValues ?? {}) }));
      setAddingFilter(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const editable = parameters.some(isRuntimeEditableParameter);
  const appliedInputs = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return (
    <div style={{ display: 'grid', gap: 9 }}>
      {appliedInputs.length > 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: embedded ? '8px 12px 0' : 0 }}>
          <span style={{ fontSize: 10.5, fontWeight: 750, color: t.textMuted }}>Applied inputs</span>
          {appliedInputs.map(([name, value]) => (
            <span key={name} style={{ fontSize: 10.5, color: t.textSecondary, border: `1px solid ${t.cellBorder}`, background: t.appBg, borderRadius: 999, padding: '2px 7px' }}>
              {name.replace(/_/g, ' ')} = {formatAppliedParameterValue(value)}
            </span>
          ))}
        </div>
      ) : null}
      {loading ? <div style={{ fontSize: 10.5, color: t.textMuted }}>Loading reusable inputs…</div> : editable || filterCandidates.length > 0 ? (
        <div style={{ display: 'grid', gap: 8, padding: 9, margin: embedded ? '0 12px' : 0, border: `1px solid ${t.cellBorder}`, borderRadius: 7, background: t.appBg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: t.textPrimary }}>Change DQL inputs</div>
              <div style={{ fontSize: 10, color: t.textMuted }}>Reruns this DQL artifact directly. It does not start another AI search.</div>
            </div>
            {filterCandidates.length > 0 ? (
              <button type="button" onClick={openFilterEditor} style={smallButtonStyle(t)}>
                <Plus size={11} /> Add result filter
              </button>
            ) : null}
            <button type="button" disabled={running} onClick={() => void run()} style={{ ...smallButtonStyle(t), color: t.accent, opacity: running ? .65 : 1 }}>
              {running ? <Loader2 size={11} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Sparkles size={11} />}
              {running ? 'Running…' : 'Apply'}
            </button>
          </div>
          {addingFilter ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) minmax(150px, 1fr) auto auto', gap: 7, alignItems: 'end', padding: 8, border: `1px solid ${t.cellBorder}`, borderRadius: 7, background: t.cellBg }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 10, fontWeight: 750, color: t.textSecondary }}>
                Result column
                <select
                  aria-label="Result column for new DQL input"
                  value={filterColumn}
                  onChange={(event) => {
                    const column = event.target.value;
                    const candidate = filterCandidates.find((item) => item.column === column);
                    setFilterColumn(column);
                    setFilterValue(candidate?.values[0] == null ? '' : String(candidate.values[0]));
                  }}
                  style={askParameterControlStyle(t)}
                >
                  {filterCandidates.map((candidate) => <option key={candidate.column} value={candidate.column}>{candidate.column.split('_').join(' ')}</option>)}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 10, fontWeight: 750, color: t.textSecondary }}>
                Default value
                <input
                  aria-label="Default value for new DQL input"
                  value={filterValue}
                  list={`ask-filter-${filterColumn}`}
                  onChange={(event) => setFilterValue(event.target.value)}
                  style={askParameterControlStyle(t)}
                />
                <datalist id={`ask-filter-${filterColumn}`}>
                  {(filterCandidates.find((candidate) => candidate.column === filterColumn)?.values ?? []).map((value) => (
                    <option key={`${typeof value}:${String(value)}`} value={String(value)} />
                  ))}
                </datalist>
              </label>
              <button type="button" onClick={() => { void addResultFilter(); }} style={{ ...smallButtonStyle(t), color: t.accent }}>Add input</button>
              <button type="button" onClick={() => setAddingFilter(false)} style={smallButtonStyle(t)}>Cancel</button>
            </div>
          ) : null}
          {parameters.length > 0 ? (
            <BlockParameterControls parameters={parameters} values={values} onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))} t={t} />
          ) : null}
          {filterCandidates.length > 0 ? (
            <div style={{ fontSize: 9.5, color: t.textMuted }}>
              Extra filters are available only for semantic dimensions in this result. They stay transient until you explicitly save a saved query.
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <div style={{ fontSize: 10.5, color: t.error }}>{error}</div> : null}
      <ResultView
        result={result}
        themeMode={themeMode}
        t={t}
        chartConfig={chartConfig}
        embedded={embedded}
        tabLabels={embedded ? { table: 'Results', chart: 'Visualization' } : undefined}
        contentMaxHeight={expanded ? 'calc(100vh - 172px)' : undefined}
        tableMaxHeight={expanded ? 'calc(100vh - 250px)' : undefined}
      />
    </div>
  );
}

export function resolvedParameterValues(payload: Record<string, unknown>): Record<string, unknown> {
  const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
    ? payload.result as Record<string, unknown>
    : undefined;
  const raw = Array.isArray(result?.parameters) ? result.parameters : Array.isArray(payload.parameters) ? payload.parameters : [];
  return Object.fromEntries(raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as { name?: unknown; value?: unknown };
    return typeof record.name === 'string' ? [[record.name, record.value]] : [];
  }));
}

function formatAppliedParameterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function certifiedBlockName(artifact: AgentRunArtifact, payload: Record<string, unknown>): string | undefined {
  const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
    ? payload.result as Record<string, unknown>
    : undefined;
  const block = payload.block && typeof payload.block === 'object' && !Array.isArray(payload.block)
    ? payload.block as Record<string, unknown>
    : undefined;
  const candidates = [result?.blockName, payload.sourceCertifiedBlock, block?.name, artifact.ref];
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
}

function ArtifactView({
  artifact,
  t,
  themeMode,
  onInsertSql,
  onInsertDql,
  insertDqlActionLabel,
  sourceRunId,
  sourceQuestion,
  onOpenBlock,
  onOpenResearch,
  onOpenApp,
  onNextAction,
}: {
  artifact: AgentRunArtifact;
  t: Theme;
  themeMode: ThemeMode;
  onInsertSql?: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql?: (payload: InsertDqlPayload) => void;
  insertDqlActionLabel?: string;
  sourceRunId?: string;
  sourceQuestion?: string;
  onOpenBlock?: (path: string, name?: string) => void;
  onOpenResearch?: (id: string, notebookPath?: string, sourceAskRunId?: string) => void;
  onOpenApp?: (appId: string, dashboardId?: string, draftId?: string) => void;
  onNextAction?: (action: AgentRun['nextActions'][number]) => void;
}) {
  const payload = artifact.payload && typeof artifact.payload === 'object' ? artifact.payload as Record<string, unknown> : {};
  // Two-phase app build: the proposal card owns the confirm flow (toggles + Create).
  if (artifact.kind === 'app_proposal') {
    return <AppProposalArtifact artifact={artifact} payload={payload} t={t} onOpenApp={onOpenApp} />;
  }
  // A Research investigation renders as its report; runs of the earlier
  // hypothesis Research keep the plan and verdict view below.
  const investigation = artifact.kind === 'research_run' ? investigationReportOf(payload) : undefined;
  if (investigation) {
    const trendSql = typeof payload.sql === 'string' && payload.sql.trim() ? payload.sql : undefined;
    return (
      <div style={artifactStyle(t)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ArtifactIcon kind={artifact.kind} />
          <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cleanPresentationText(artifact.title)}
          </div>
        </div>
        <InvestigationReport report={investigation} t={t} themeMode={themeMode} />
        {trendSql && onInsertSql ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => onInsertSql(trendSql, artifact.title, { question: sourceQuestion, sourceRunId })} style={smallButtonStyle(t)}>
              Insert the trend query as SQL
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  const resultData = extractResult(payload);
  const dqlArtifact = resolveArtifactDqlView(payload);
  const mixedSourcePlan = extractMixedSourceNotebookPlan(payload);
  const sql = typeof payload.sql === 'string'
    ? payload.sql
    : typeof payload.sqlPreview === 'string'
      ? payload.sqlPreview
      : typeof payload.proposedSql === 'string'
        ? payload.proposedSql
        : undefined;
  const name = typeof payload.name === 'string' ? payload.name : artifact.title;
  const path = typeof payload.path === 'string' ? payload.path : artifact.ref;
  const draftBlock = payload.draftBlock && typeof payload.draftBlock === 'object' && !Array.isArray(payload.draftBlock)
    ? payload.draftBlock as Record<string, unknown>
    : undefined;
  const draftBlockPath = typeof draftBlock?.path === 'string' ? draftBlock.path : undefined;
  const draftBlockName = typeof draftBlock?.name === 'string' ? draftBlock.name : undefined;
  const dqlPath = dqlArtifact?.sourcePath ?? draftBlockPath ?? (artifact.kind === 'dql_block_draft' ? path : undefined);
  const dqlName = dqlArtifact?.name ?? draftBlockName ?? name;
  const dqlOpenLabel = dqlArtifact?.kind === 'sql_block' || artifact.kind === 'dql_block_draft'
    ? 'Open DQL draft'
    : 'Open DQL artifact';
  const plan = payload.plan && typeof payload.plan === 'object' ? payload.plan as Record<string, unknown> : undefined;
  const steps = Array.isArray(plan?.steps) ? plan.steps as Array<Record<string, unknown>> : [];
  const gaps = Array.isArray(plan?.gaps) ? plan.gaps.map(String) : [];
  const researchRunId = typeof payload.researchRunId === 'string'
    ? payload.researchRunId
    : artifact.kind === 'research_run' && typeof artifact.ref === 'string'
      ? artifact.ref
      : undefined;
  const notebookPath = typeof payload.notebookPath === 'string' ? payload.notebookPath : undefined;
  const generatedPaths = Array.isArray(payload.generatedPaths)
    ? payload.generatedPaths.filter((item): item is string => typeof item === 'string')
    : [];
  const narration = payload.narration && typeof payload.narration === 'object' ? payload.narration as Record<string, unknown> : undefined;
  const keyFindings = Array.isArray(narration?.keyFindings)
    ? narration.keyFindings.filter((item): item is string => typeof item === 'string')
    : [];
  const recommendation = typeof narration?.recommendation === 'string' ? narration.recommendation : undefined;
  const certifiedName = artifact.trustState === 'certified' ? certifiedBlockName(artifact, payload) : undefined;
  const researchVerdicts = artifact.kind === 'research_run' ? researchVerdictSummary(payload) : undefined;

  // A governed DQL block draft renders through the shared draft-review card:
  // DQL-first, grounding + enriched metadata + verdict, draft-first status.
  if (artifact.kind === 'dql_block_draft') {
    const strList = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
    const verdict = payload.certifierVerdict && typeof payload.certifierVerdict === 'object'
      ? payload.certifierVerdict as { blocking?: unknown; warnings?: unknown; ready?: unknown }
      : undefined;
    return (
      <DraftReviewCard
        t={t}
        name={typeof payload.name === 'string' ? payload.name : name}
        status="draft"
        description={typeof payload.description === 'string' ? payload.description : undefined}
        dql={dqlArtifact?.source ?? (typeof payload.dqlSource === 'string' ? payload.dqlSource : undefined)}
        sqlPreview={sql}
        grain={typeof payload.grain === 'string' ? payload.grain : undefined}
        outputs={strList(payload.outputs)}
        dimensions={strList(payload.dimensions) ?? dqlArtifact?.dimensions}
        entities={strList(payload.entities)}
        certifierVerdict={verdict ? { blocking: strList(verdict.blocking) ?? [], warnings: strList(verdict.warnings) ?? [], ready: Boolean(verdict.ready) } : undefined}
        actions={
          <>
            {sql && onInsertDql ? (
              <button
                type="button"
                onClick={() => onInsertDql({
                  sql,
                  dqlArtifact,
                  result: resultData,
                  chartConfig: resultData ? extractChartConfig(payload, resultData) : undefined,
                  title: name,
                  sourceRunId,
                  question: sourceQuestion,
                })}
                style={smallButtonStyle(t)}
              >
                {insertDqlActionLabel ?? 'Insert as DQL cell'}
              </button>
            ) : sql && onInsertSql ? (
              <button
                type="button"
                onClick={() => onInsertSql(sql, name, {
                  question: sourceQuestion,
                  sourceRunId,
                })}
                style={smallButtonStyle(t)}
              >
                Insert SQL preview
              </button>
            ) : null}
            {dqlPath && onOpenBlock ? (
              <button type="button" onClick={() => onOpenBlock(dqlPath, dqlName)} style={smallButtonStyle(t)}>{dqlOpenLabel}</button>
            ) : null}
          </>
        }
      />
    );
  }

  return (
    <div style={artifactStyle(t)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ArtifactIcon kind={artifact.kind} />
        <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {cleanPresentationText(artifact.title)}
        </div>
      </div>
      {researchVerdicts ? (
        <div
          role="status"
          aria-label={researchVerdicts.detail}
          style={{ borderLeft: `3px solid ${researchVerdicts.limitedScope ? t.warning : t.accent}`, padding: '7px 9px', borderRadius: 6, background: researchVerdicts.limitedScope ? `${t.warning}10` : `${t.accent}0d`, display: 'grid', gap: 2 }}
        >
          <strong style={{ fontSize: 11.5, color: researchVerdicts.limitedScope ? t.warning : t.textPrimary }}>
            {researchVerdicts.limitedScope ? 'Limited research scope' : 'Research branch verdicts'}
          </strong>
          <span style={{ fontSize: 11, color: t.textSecondary, lineHeight: 1.4 }}>{researchVerdicts.detail}</span>
        </div>
      ) : null}
      {keyFindings.length > 0 ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: t.textSecondary }}>Key findings</div>
          <ExpandableList
            items={keyFindings}
            t={t}
            renderItem={(finding, index) => (
              <div key={index} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.4, display: 'flex', gap: 6 }}>
                <span style={{ color: t.accent }}>•</span><span>{finding}</span>
              </div>
            )}
          />
        </div>
      ) : steps.length > 0 ? (
        <div style={{ display: 'grid', gap: 5 }}>
          <ExpandableList
            items={steps}
            t={t}
            renderItem={(step, index) => (
              <div key={index} style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.35 }}>
                {index + 1}. {String((step as { thought?: unknown; expectation?: unknown }).thought ?? (step as { expectation?: unknown }).expectation ?? 'Research step')}
              </div>
            )}
          />
        </div>
      ) : null}
      {recommendation ? (
        <div style={{ fontSize: 11.5, color: t.textPrimary, lineHeight: 1.4, display: 'flex', gap: 6 }}>
          <span style={{ color: t.accent }}>→</span><span>{recommendation}</span>
        </div>
      ) : null}
      {resultData ? dqlArtifact ? (
        <ExecutableDqlResult
          artifact={dqlArtifact}
          certifiedBlockName={certifiedName}
          initialResult={resultData}
          initialChartConfig={extractChartConfig(payload, resultData)}
          payload={payload}
          t={t}
          themeMode={themeMode}
        />
      ) : <ResultView result={resultData} themeMode={themeMode} t={t} chartConfig={extractChartConfig(payload, resultData)} /> : null}
      {dqlArtifact ? (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: t.textSecondary, listStyle: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Blocks size={12} /><span>View DQL artifact</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {dqlArtifact.source ? <CopyButton text={dqlArtifact.source} t={t} title="Copy DQL" /> : null}
              {!dqlPath && onNextAction ? (
                <button
                  type="button"
                  className="dql-hover"
                  title="Save this DQL as a reusable saved query"
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); onNextAction({ id: 'save-dql-block', label: 'Save as saved query', route: 'dql_block_draft' }); }}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: t.accent, display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 700, padding: '2px 4px' }}
                >
                  <Save size={12} /> Save as saved query
                </button>
              ) : null}
            </span>
          </summary>
          {dqlArtifact.sourcePath ? (
            <div style={{ marginTop: 6, fontSize: 10.5, color: t.textMuted }}>
              {dqlArtifact.sourcePath}
            </div>
          ) : null}
          <pre style={{ ...codeStyle(t), marginTop: 6 }}>{dqlArtifact.source}</pre>
        </details>
      ) : null}
      {sql ? (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: t.textSecondary, listStyle: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Code2 size={12} /><span>{artifactSqlDisclosureLabel(Boolean(dqlArtifact))}</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <CopyButton text={sql} t={t} title="Copy SQL" />
            </span>
          </summary>
          <pre style={{ ...codeStyle(t), marginTop: 6 }}>{sql}</pre>
        </details>
      ) : null}
      {gaps.length > 0 ? (
        <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.4 }}>
          Gaps: {gaps.join(', ')}
        </div>
      ) : null}
      {generatedPaths.length > 0 ? (
        <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.4 }}>
          Files: {generatedPaths.join(', ')}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {researchRunId && onOpenResearch ? (
          <button
            type="button"
            aria-label="Open research evidence"
            onClick={() => onOpenResearch(researchRunId, notebookPath, sourceRunId)}
            style={smallButtonStyle(t)}
          >
            Open research
          </button>
        ) : null}
        {sql && onInsertDql ? (
          <button
            type="button"
            onClick={() => onInsertDql({
              sql,
              dqlArtifact,
              result: resultData,
              chartConfig: resultData ? extractChartConfig(payload, resultData) : undefined,
              title: name,
              mixedSourcePlan,
              sourceRunId,
              question: sourceQuestion,
            })}
            style={mixedSourcePlan ? {
              ...smallButtonStyle(t),
              background: t.accent,
              borderColor: t.accent,
              color: '#fff',
              fontWeight: 850,
              padding: '7px 11px',
            } : smallButtonStyle(t)}
          >
            {mixedSourcePlan ? 'Add workflow to notebook' : dqlArtifact ? 'Insert as DQL cell' : 'Add SQL to notebook'}
          </button>
        ) : sql && onInsertSql ? (
          <button
            type="button"
            onClick={() => onInsertSql(sql, name, {
              question: sourceQuestion,
              sourceRunId,
            })}
            style={smallButtonStyle(t)}
          >
            Insert SQL preview
          </button>
        ) : null}
        {dqlPath && onOpenBlock ? (
          <button type="button" onClick={() => onOpenBlock(dqlPath, dqlName)} style={smallButtonStyle(t)}>{dqlOpenLabel}</button>
        ) : null}
      </div>
    </div>
  );
}

function StatusIcon({ run }: { run: AgentRun }) {
  if (run.trustState === 'certified') return <ShieldCheck size={16} color="#16a34a" />;
  if (run.trustState === 'governed') return <ShieldCheck size={16} color="#2563eb" />;
  if (run.trustState === 'grounded') return <ShieldCheck size={16} color="#2563eb" />;
  if (run.status === 'completed') return <CheckCircle2 size={16} color="#16a34a" />;
  if (run.status === 'cancelled' || run.stopReason === 'cancelled') return <Route size={16} color="#737373" />;
  if (run.status === 'blocked') return <Route size={16} color="#ef4444" />;
  return <Route size={16} color="#d97706" />;
}

function ArtifactIcon({ kind }: { kind: AgentRunArtifact['kind'] }) {
  if (kind === 'sql_cell') return <Code2 size={14} />;
  if (kind === 'dql_block_draft') return <Blocks size={14} />;
  if (kind === 'app_draft' || kind === 'app_proposal') return <LayoutDashboard size={14} />;
  if (kind === 'research_run') return <FileSearch size={14} />;
  return <Sparkles size={14} />;
}

function TrustBadge({ run, t }: { run: AgentRun; t: Theme }) {
  const color = run.trustState === 'certified'
    ? t.success
    : run.trustState === 'governed' || run.trustState === 'grounded'
      ? t.accent
      : run.trustState === 'blocked'
        ? t.error
        : run.trustState === 'not_applicable'
          ? t.textMuted
          : t.warning;
  const label = run.status === 'cancelled' || run.stopReason === 'cancelled'
    ? 'Cancelled'
    : run.trustState === 'certified'
    ? 'Certified'
    : run.route === 'dql_block_draft'
      ? 'Draft'
      : isExploratoryDbtRun(run)
        ? 'Exploratory'
      // "Needs input" promises an affordance, so it belongs only to a run that
      // actually asked the user something. A blocked run is a refusal: calling
      // it "Needs input" told people to supply something that was never named.
      : run.status === 'needs_clarification'
        ? 'Needs input'
        // A refusal reads "Refused", or "Not answered" when no model ran (answerTrustBadge).
        : answerTrustBadge(run);
  return (
    <span style={{ border: `1px solid ${color}55`, color, background: `${color}12`, borderRadius: 999, padding: '3px 7px', fontSize: 10, fontWeight: 850 }}>
      {label}
    </span>
  );
}

/**
 * Verification checks for a single-step run. The governance proof matters, but a
 * stack of green "OK" lines clutters the stakeholder view. Any *flagged* check
 * (review / blocking) stays inline so the reason is visible; the passed checks
 * fold into one quiet, collapsed "N checks verified" disclosure.
 */
function VerificationChecks({ evaluations, t }: { evaluations: AgentRun['evaluations']; t: Theme }) {
  if (evaluations.length === 0) return null;
  const flagged = evaluations.filter((evaluation) => !evaluation.passed);
  const passed = evaluations.filter((evaluation) => evaluation.passed);
  return (
    <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      {flagged.map((evaluation) => (
        <EvaluationRow key={evaluation.id} evaluation={evaluation} t={t} />
      ))}
      {passed.length > 0 ? (
        <details>
          <summary
            className="dql-hover"
            style={{ cursor: 'pointer', listStyle: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: t.textMuted, width: 'fit-content' }}
          >
            <ShieldCheck size={12} color={t.success} />
            <span>{passed.length} check{passed.length > 1 ? 's' : ''} verified</span>
          </summary>
          <div style={{ display: 'grid', gap: 5, marginTop: 7 }}>
            {passed.map((evaluation) => (
              <EvaluationRow key={evaluation.id} evaluation={evaluation} t={t} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function EvaluationRow({ evaluation, t }: { evaluation: AgentRun['evaluations'][number]; t: Theme }) {
  const color = evaluation.passed ? t.success : evaluation.severity === 'blocking' ? t.error : t.warning;
  return (
    <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 11.5, color: t.textSecondary, minWidth: 0 }}>
      <span style={{ color, lineHeight: '16px', flex: '0 0 auto', fontWeight: 800 }}>
        {evaluation.passed ? 'OK' : evaluation.severity === 'blocking' ? 'Stop' : 'Review'}
      </span>
      {/* minWidth 0 + anywhere: long unbroken tokens (qualified relation names,
          SQL error fragments) must wrap instead of widening the chat column. */}
      <span style={{ lineHeight: 1.4, minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
        {evaluation.message}
        {!evaluation.passed && evaluation.suggestedRepair ? (
          <span style={{ display: 'block', color: t.textMuted, marginTop: 1 }}>↳ {evaluation.suggestedRepair}</span>
        ) : null}
      </span>
    </div>
  );
}

function MetaChip({ t, icon, label, tone }: { t: Theme; icon: React.ReactNode; label: string; tone: 'accent' | 'muted' | 'warning' }) {
  const color = tone === 'accent' ? t.accent : tone === 'warning' ? t.warning : t.textMuted;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: `1px solid ${color}44`, color, background: `${color}10`, borderRadius: 999, padding: '2px 7px', fontSize: 10, fontWeight: 800 }}>
      {icon}
      <span>{label}</span>
    </span>
  );
}

function stepStatusColor(status: AgentRunStepStatus, t: Theme): string {
  switch (status) {
    case 'passed':
      return t.success;
    case 'repaired':
      return t.accent;
    case 'escalated':
      return t.accent;
    case 'blocked':
      return t.error;
    default:
      return t.warning;
  }
}

function StepTrace({ steps, t }: { steps: AgentRunStep[]; t: Theme }) {
  return (
    <details style={{ border: `1px solid ${t.headerBorder}`, background: t.cellBg, borderRadius: 8, padding: '6px 9px' }}>
      <summary style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 800, color: t.textSecondary, listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
        <ListTree size={13} />
        <span>Plan trace · {steps.length} steps</span>
      </summary>
      <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
        {steps.map((step) => {
          const color = stepStatusColor(step.status, t);
          return (
            <div key={step.id} style={{ display: 'grid', gap: 4, paddingLeft: 8, borderLeft: `2px solid ${color}55` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11.5, fontWeight: 850, color: t.textPrimary }}>{step.index}. {ROUTE_LABEL[step.route]}</span>
                <span style={{ border: `1px solid ${color}55`, color, background: `${color}12`, borderRadius: 999, padding: '1px 6px', fontSize: 9.5, fontWeight: 850, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  {step.status === 'escalated' ? <GitBranch size={10} /> : step.status === 'repaired' ? <Wrench size={10} /> : null}
                  {step.status.split('_').join(' ')}
                </span>
                {step.attempts > 1 ? <span style={{ fontSize: 10, color: t.textMuted }}>{step.attempts} attempts</span> : null}
              </div>
              {step.goal ? <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35 }}>{step.goal}</div> : null}
              {step.evaluations.length > 0 ? (
                <div style={{ display: 'grid', gap: 4 }}>
                  {step.evaluations.map((evaluation) => (
                    <EvaluationRow key={evaluation.id} evaluation={evaluation} t={t} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function routeToMode(route?: AgentRunRoute): AgentRunRequestedMode | undefined {
  if (route === 'research') return 'research';
  if (route === 'sql_cell') return 'sql';
  if (route === 'dql_block_draft') return 'block';
  if (route === 'modeling_draft') return 'modeling';
  if (route === 'skill_draft') return 'skill';
  if (route === 'app_build') return 'app';
  if (route === 'certified_answer' || route === 'semantic_answer' || route === 'generated_answer') return 'ask';
  return undefined;
}

function nextPromptFor(run: AgentRun, route?: AgentRunRoute): string {
  if (route === 'sql_cell') return `Create a SQL cell for: ${run.question}`;
  if (route === 'dql_block_draft') return `Create a saved query draft for: ${run.question}`;
  if (route === 'modeling_draft') return `Revise the modeling proposal for: ${run.question}`;
  if (route === 'skill_draft') return `Revise the Skill proposal for: ${run.question}`;
  if (route === 'app_build') return `Build an app for: ${run.question}`;
  if (route === 'research') return `Research deeper: ${run.question}`;
  return run.question;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface FollowLatestTurnState {
  previousUserTurnId?: string;
  previousCount: number;
  /** The reader scrolled up so the latest turn is below the visible area. */
  readingEarlier: boolean;
}

/**
 * Whether the thread scrolls to its latest turn after its items change.
 * A new question (or a thread just loaded) always scrolls; an answer added to
 * the latest question scrolls unless the reader is reading an earlier turn;
 * anything else (an answer updating in place, a reload of the same turns)
 * leaves the scroll position alone.
 */
export function followLatestTurnAction(
  state: FollowLatestTurnState,
  next: { latestUserTurnId?: string; count: number },
): 'scroll' | 'stay' {
  if (!next.latestUserTurnId || next.count <= state.previousCount) return 'stay';
  if (next.latestUserTurnId !== state.previousUserTurnId) return 'scroll';
  return state.readingEarlier ? 'stay' : 'scroll';
}

function latestUserTurnElement(container: HTMLElement): HTMLElement | null {
  const bubbles = container.querySelectorAll<HTMLElement>('[data-thread-user-turn]');
  return bubbles.length ? bubbles[bubbles.length - 1]! : null;
}

/**
 * "review-required" reads as "AI-generated" to a stakeholder. The article
 * before it changes with it: "a review-required answer" becomes "an
 * AI-generated answer", never "a AI-generated answer".
 */
export function toAiGeneratedWording(text: string): string {
  return text.replace(/\b(?:(an?)(\s+))?review-required\b/gi, (_match, article?: string, space?: string) => {
    if (!article) return 'AI-generated';
    return `${article.charAt(0) === 'A' ? 'An' : 'an'}${space ?? ' '}AI-generated`;
  });
}

/** Strip the internal "Outcome: <reuse|draft|fix|...>" routing line meant for the
 *  notebook parser, plus markdown emphasis markers — stakeholders should see clean
 *  prose, not pipeline jargon or literal asterisks/backticks. */
function cleanAnswerText(answer: string): string {
  return toAiGeneratedWording(answer)
    .replace(/^\s*Outcome\s*:\s*[^\n]*\n+/i, '')
    .replace(/^\s*Review required:\s*/gim, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^_(.+?)_$/gm, '$1')
    .trim();
}

function cleanPresentationText(value: string): string {
  return toAiGeneratedWording(value)
    .replace(/^\s*Review required:\s*/gim, '')
    .replace(/\bqueued for review\b/gi, 'saved as a draft')
    .trim();
}

/** True when two strings say the same thing modulo whitespace/punctuation/case. */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s.,!?'"()`*_-]+/g, ' ').trim();
  return norm(a) === norm(b);
}

/** Pull a QueryResult (columns/rows) out of an artifact payload, for visualization. */
export function extractResult(payload: Record<string, unknown>): QueryResult | undefined {
  const candidates: unknown[] = [
    payload.result,
    payload.resultPreview,
    (payload.researchRun as { resultPreview?: unknown } | undefined)?.resultPreview,
    (payload.result as { result?: unknown } | undefined)?.result,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    // A result-shaped object has a rows array and/or a columns array. Anything
    // else isn't a query result.
    if (!Array.isArray(record.rows) && !Array.isArray(record.columns)) continue;
    const normalized = normalizeQueryResultPayload(record);
    const rows = normalized.rows;
    const columns = normalized.columns;
    // Return a legitimately-empty result (0 rows, known columns/rowCount) so it
    // renders as "0 rows matched" instead of vanishing — a run that executed and
    // matched nothing must be distinguishable from one that produced no result.
    if (rows.length === 0 && columns.length === 0 && typeof record.rowCount !== 'number') continue;
    return {
      columns,
      rows,
      rowCount: normalized.rowCount,
      // The units contract travels with the rows: without it the KPI card,
      // the chart and the headline fall back to guessing from column names.
      ...(normalized.columnsMeta?.length ? { columnsMeta: normalized.columnsMeta } : {}),
      ...(normalized.resultFingerprint ? { resultFingerprint: normalized.resultFingerprint } : {}),
      ...(normalized.executionReceipt ? { executionReceipt: normalized.executionReceipt } : {}),
      ...(normalized.trustState ? { trustState: normalized.trustState } : {}),
      ...(normalized.answerTier ? { answerTier: normalized.answerTier } : {}),
      ...(normalized.executionTime !== undefined ? { executionTime: normalized.executionTime } : {}),
    } as QueryResult;
  }
  return undefined;
}

/**
 * Build a reload-safe reference only when the selected rendered text maps to
 * one unambiguous raw result cell. Formatting (for example "$1,651.00") is
 * intentionally not reverse-parsed; in that case the follow-up remains plain
 * language rather than inventing a filter from display text.
 */
export async function selectedResultBindingForSelection(input: {
  selectedText: string;
  run?: AgentRun;
  artifact?: AgentRunArtifact;
}): Promise<AgentSelectedResultBinding | undefined> {
  const selectedText = input.selectedText.trim();
  if (!selectedText || !input.run || !input.artifact) return undefined;
  const result = extractResult(payloadOf(input.artifact));
  if (!result?.resultFingerprint || !result.columns.length) return undefined;
  const matches = result.rows.flatMap((row) => result.columns.flatMap((column) => {
    const value = selectedResultBindingValue(row[column]);
    return value === selectedText ? [{ column, value, row }] : [];
  }));
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const rowFingerprint = await browserStableFingerprint({
    columns: result.columns,
    row: Object.fromEntries(result.columns.map((column) => [column, match.row[column]])),
  });
  if (!rowFingerprint) return undefined;
  return {
    version: 1,
    sourceRunId: input.run.id,
    sourceArtifactId: input.artifact.id,
    canonicalColumn: match.column,
    value: match.value,
    rowFingerprint,
    resultFingerprint: result.resultFingerprint,
  };
}

function selectedResultBindingValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

function browserStableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(browserStableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${browserStableStringify(record[key])}`).join(',')}}`;
}

async function browserStableFingerprint(value: unknown): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(browserStableStringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Recover the agent's intended chart configuration (type + x/y/color/palette) from
 * an answer artifact so the live result view honors it instead of auto-guessing —
 * parity with AgentAnswerCard. Falls back to `suggestedViz` for the chart type and
 * fills in sensible x/y from the columns when the agent didn't specify them.
 */
function extractChartConfig(payload: Record<string, unknown>, result: QueryResult): CellChartConfig | undefined {
  const resultRecord = payload.result && typeof payload.result === 'object' ? payload.result as Record<string, unknown> : undefined;
  const raw = (resultRecord?.chartConfig && typeof resultRecord.chartConfig === 'object'
    ? resultRecord.chartConfig
    : payload.chartConfig && typeof payload.chartConfig === 'object'
      ? payload.chartConfig
      : {}) as Record<string, unknown>;
  const suggested = typeof payload.suggestedViz === 'string' ? payload.suggestedViz
    : typeof resultRecord?.suggestedViz === 'string' ? resultRecord.suggestedViz
    : undefined;
  const storedDecisionSource = raw.decisionSource === 'authored' || raw.decisionSource === 'agent'
    || raw.decisionSource === 'data' || raw.decisionSource === 'user'
    ? raw.decisionSource
    : undefined;
  const chartRaw = typeof raw.chart === 'string' ? raw.chart : suggested;
  const chart = chartRaw
    ? (chartRaw.toLowerCase().replace(/_/g, '-') === 'single-value' ? 'kpi' : chartRaw)
    : undefined;
  const columns = result.columns;
  const pick = (key: string): string | undefined =>
    typeof raw[key] === 'string' && columns.includes(raw[key] as string) ? raw[key] as string : undefined;
  const metrics = Array.isArray(raw.metrics)
    ? raw.metrics.filter((value): value is string => typeof value === 'string' && columns.includes(value))
    : [];
  const config: CellChartConfig = {
    ...(chart ? { chart } : {}),
    ...(chart ? { decisionSource: storedDecisionSource ?? 'agent' as const } : {}),
    ...(typeof raw.rationale === 'string' ? { rationale: raw.rationale } : {}),
    ...(pick('x') ? { x: pick('x') } : {}),
    ...(pick('y') ? { y: pick('y') } : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
    ...(pick('color') ? { color: pick('color') } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.colorPalette === 'string' ? { colorPalette: raw.colorPalette as CellChartConfig['colorPalette'] } : {}),
    ...(typeof raw.maxItems === 'number' ? { maxItems: raw.maxItems } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

export function inlineAskChartConfig(payload: Record<string, unknown>, result: QueryResult): CellChartConfig | undefined {
  const resolved = extractChartConfig(payload, result);
  // A backend recommendation of `table` should not remove Visualization from
  // the transcript when the returned data is chartable. Authored/user table
  // choices stay authoritative; agent/default choices remain suggestions.
  return resolved?.chart === 'table'
    && (resolved.metrics?.length ?? 0) <= 1
    && resolved.decisionSource !== 'authored'
    && resolved.decisionSource !== 'user'
    ? { ...resolved, chart: undefined }
    : resolved;
}

export function resolveArtifactDqlView(payload: Record<string, unknown>): AgentConversationDqlArtifact | undefined {
  const dqlArtifact = normalizeDqlArtifactReference(payload.dqlArtifact);
  if (dqlArtifact) return dqlArtifact;
  const researchRun = payload.researchRun && typeof payload.researchRun === 'object' && !Array.isArray(payload.researchRun)
    ? payload.researchRun as Record<string, unknown>
    : undefined;
  return normalizeDqlArtifactReference(researchRun?.dqlArtifact);
}

export function artifactSqlDisclosureLabel(hasDqlArtifact: boolean): string {
  return hasDqlArtifact ? 'View compiled SQL preview' : 'View SQL preview';
}

/** Small copy-to-clipboard control. Safe inside a <summary> (stops the toggle). */
function CopyButton({ text, t, title = 'Copy' }: { text: string; t: Theme; title?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context) — fail quietly.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      className="dql-hover"
      style={{
        border: 'none', background: 'transparent', cursor: 'pointer',
        color: copied ? t.success : t.textMuted, display: 'inline-flex', alignItems: 'center',
        gap: 3, fontSize: 10.5, fontWeight: 650, padding: '2px 4px',
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : null}
    </button>
  );
}

/**
 * An answer read from the App page it was asked on (N3): the server read the page run's tiles, sources and rows.
 * It is labelled by the tiles it read — never "AI-generated SQL", and never certified unless every tile was.
 */
export function readFromAppView(run: Pick<AgentRun, 'artifacts'>): boolean {
  return (run.artifacts ?? []).some((artifact) => isAppViewPayload(payloadOf(artifact)));
}

function isAppViewPayload(payload: Record<string, unknown>): boolean {
  return Boolean(payload.appView && typeof payload.appView === 'object');
}

function payloadOf(artifact: AgentRunArtifact): Record<string, unknown> {
  return artifact.payload && typeof artifact.payload === 'object' && !Array.isArray(artifact.payload)
    ? artifact.payload as Record<string, unknown>
    : {};
}

/** Governed sources behind a run, surfaced as trust chips (manifest grounding). */
type AppliedLearning = { kind: 'memory' | 'hint'; id?: string; label: string; detail?: string };

// Pull the memories + approved Hint-Graph corrections that shaped this answer out
// of the answer artifact payload, for the transparency chip.
function appliedLearningsFromRun(run: AgentRun): AppliedLearning[] {
  const out: AppliedLearning[] = [];
  const seen = new Set<string>();
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const memories = Array.isArray(payload.memoryContext) ? payload.memoryContext : [];
    for (const raw of memories) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as { id?: unknown; title?: unknown; content?: unknown };
      const label = typeof m.title === 'string' ? m.title.trim() : '';
      if (!label || seen.has(`m:${label}`)) continue;
      seen.add(`m:${label}`);
      out.push({ kind: 'memory', id: typeof m.id === 'string' ? m.id : undefined, label, detail: typeof m.content === 'string' ? m.content : undefined });
    }
    const hints = Array.isArray(payload.appliedHints) ? payload.appliedHints : [];
    for (const raw of hints) {
      if (!raw || typeof raw !== 'object') continue;
      const h = raw as {
        hintId?: unknown;
        title?: unknown;
        guidance?: unknown;
        scopeReason?: unknown;
        graphReason?: unknown;
        matchSignals?: {
          lexicalScore?: unknown;
          graphScore?: unknown;
          lexicalRank?: unknown;
        };
        lesson?: {
          rule?: unknown;
          category?: unknown;
          avoid?: unknown;
          expectedOutcome?: unknown;
        };
      };
      const label = typeof h.title === 'string' ? h.title.trim() : '';
      if (!label || seen.has(`h:${label}`)) continue;
      seen.add(`h:${label}`);
      const rule = typeof h.lesson?.rule === 'string'
        ? h.lesson.rule
        : typeof h.guidance === 'string'
          ? h.guidance
          : undefined;
      const matched = [
        typeof h.scopeReason === 'string' ? h.scopeReason : undefined,
        typeof h.graphReason === 'string' ? h.graphReason : undefined,
      ].filter(Boolean).join('; ');
      const lexicalScore = typeof h.matchSignals?.lexicalScore === 'number'
        ? h.matchSignals.lexicalScore
        : undefined;
      const graphScore = typeof h.matchSignals?.graphScore === 'number'
        ? h.matchSignals.graphScore
        : undefined;
      const scoreEvidence = lexicalScore !== undefined || graphScore !== undefined
        ? `Signals: lexical ${(lexicalScore ?? 0).toFixed(2)}, graph ${(graphScore ?? 0).toFixed(2)}`
        : undefined;
      out.push({
        kind: 'hint',
        id: typeof h.hintId === 'string' ? h.hintId : undefined,
        label,
        detail: [
          rule,
          matched ? `Matched: ${matched}` : undefined,
          scoreEvidence,
        ].filter(Boolean).join(' · ') || undefined,
      });
    }
  }
  return out.slice(0, 6);
}

// Transparency + control: shows which learned memories/hints the agent recalled
// for this answer, and lets the user stop using a bad auto-captured memory inline.
function AppliedLearnings({ run, t }: { run: AgentRun; t: Theme }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const items = useMemo(
    () => appliedLearningsFromRun(run).filter((it) => !it.id || !dismissed.has(it.id)),
    [run, dismissed],
  );
  if (items.length === 0) return null;
  const stopUsing = async (id: string) => {
    try {
      await api.deleteAgentMemory(id);
      setDismissed((prev) => new Set(prev).add(id));
    } catch {
      /* best-effort — leave it shown if the delete fails */
    }
  };
  return (
    <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={appliedChipStyle(t)}>
        <Lightbulb size={11} />
        <span>Applied {items.length} learning{items.length > 1 ? 's' : ''}</span>
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
      </button>
      {open ? (
        <div style={appliedListStyle(t)}>
          {items.map((it) => (
            <div key={`${it.kind}:${it.label}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span style={appliedTagStyle(t, it.kind)}>{it.kind === 'hint' ? 'governed lesson' : 'memory'}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 11.5, fontWeight: 650, color: t.textPrimary }}>{it.label}</div>
                {it.detail ? <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.4, marginTop: 1 }}>{it.detail}</div> : null}
              </div>
              {it.kind === 'memory' && it.id ? (
                <button type="button" onClick={() => void stopUsing(it.id!)} style={appliedStopStyle(t)}>Stop using</button>
              ) : null}
            </div>
          ))}
          <div style={{ fontSize: 10.5, color: t.textMuted }}>
            Advisory only — learnings never override a certified answer. Manage them under Settings → Agent learning.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function evidenceFromRun(run: AgentRun): Array<{ label: string; certified: boolean }> {
  const out: Array<{ label: string; certified: boolean }> = [];
  const seen = new Set<string>();
  const certifiedRun = run.trustState === 'certified';
  const push = (label: unknown, certified: boolean) => {
    if (typeof label !== 'string' || !label.trim() || seen.has(label)) return;
    seen.add(label);
    out.push({ label, certified });
  };
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    if (artifact.ref) push(artifact.ref, certifiedRun);
    const plan = payload.plan && typeof payload.plan === 'object' ? payload.plan as Record<string, unknown> : undefined;
    if (Array.isArray(plan?.sources)) plan.sources.forEach((source) => push(source, certifiedRun));
    push((payload.sourceCertifiedBlock as string), true);
  }
  return out.slice(0, 4);
}

/** Best-effort SQL behind a run, for the certification handoff. */
/**
 * The SQL of a run, WITH ITS LIFECYCLE. One string cannot say whether the
 * warehouse ran this statement, rejected it, or never saw it, and calling every
 * one of them "attempted" told a reader that a successful governed answer had
 * only been tried. The bound parameters travel with it: placeholder SQL without
 * its values is not a reproducible handoff.
 */
export interface AnswerSqlEvidence {
  sql: string;
  origin: 'executed' | 'failed' | 'compiled' | 'proposed';
  params?: unknown[];
}

export const ANSWER_SQL_LABELS: Record<AnswerSqlEvidence['origin'], string> = {
  executed: 'Executed SQL — this statement produced the result.',
  failed: 'Attempted SQL — the warehouse rejected this statement.',
  compiled: 'Compiled SQL — prepared for this reading, not executed.',
  proposed: 'Proposed SQL — review required before it runs.',
};

export function answerSqlEvidenceFromRun(run: AgentRun): AnswerSqlEvidence | undefined {
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const researchRun = payload.researchRun && typeof payload.researchRun === 'object' ? payload.researchRun as Record<string, unknown> : undefined;
    const result = payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
      ? payload.result as Record<string, unknown>
      : undefined;
    const dqlArtifact = normalizeDqlArtifactReference(payload.dqlArtifact);
    const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
    const params = Array.isArray(payload.sqlParams) ? payload.sqlParams as unknown[]
      : Array.isArray(result?.sqlParams) ? result!.sqlParams as unknown[]
      : undefined;
    const withParams = (sql: string, origin: AnswerSqlEvidence['origin']): AnswerSqlEvidence => ({ sql, origin, ...(params?.length ? { params } : {}) });
    const executed = text(result?.sql);
    if (executed) return withParams(executed, 'executed');
    const failed = text(payload.executionError) ? text(payload.sql) : undefined;
    if (failed) return withParams(failed, 'failed');
    const proposed = text(payload.proposedSql) ?? text(researchRun?.generatedSql) ?? text(researchRun?.reviewedSql);
    if (proposed) return withParams(proposed, 'proposed');
    const compiled = text(payload.sql) ?? text(payload.sqlPreview) ?? text(dqlArtifact?.compiledSql);
    if (compiled) return withParams(compiled, 'compiled');
  }
  return undefined;
}

function answerSqlFromRun(run: AgentRun): string | undefined {
  return answerSqlEvidenceFromRun(run)?.sql;
}

/**
 * The certified block backing this run, if any.
 *
 * A certified block added to an App should become a real block tile rather than
 * a review-required pin: it keeps its block identity, re-runs with the
 * dashboard's filters, and survives publication (which strips pins).
 */
function certifiedBlockNameFromRun(run: AgentRun): string | undefined {
  if (run.trustState !== 'certified') return undefined;
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const name = payload.blockName ?? payload.blockId ?? normalizeDqlArtifactReference(payload.dqlArtifact)?.name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return undefined;
}

/**
 * The certified block a Certified answer ran and the owner the block records
 * (its `owner` declaration, the accountable person; not who certified it).
 * `owner` is null when none is recorded, so the answer can say so.
 */
export function certifiedBlockSourceFromRun(run: AgentRun): { name: string; owner: string | null } | undefined {
  if (run.trustState !== 'certified') return undefined;
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const ref = typeof payload.certifiedBlockRef === 'string' ? payload.certifiedBlockRef : undefined;
    const name = certifiedBlockNameFromRun({ ...run, artifacts: [artifact] }) ?? ref?.replace(/^block:/, '').replace(/^[^.]+\./, '');
    if (!name) continue;
    const owner = typeof payload.certifiedBlockOwner === 'string' && payload.certifiedBlockOwner.trim() ? payload.certifiedBlockOwner.trim() : null;
    return { name, owner };
  }
  return undefined;
}

/** "from <block> · Owner: <name>", with "not set" rather than a blank. */
export function CertifiedBlockSource({ source, t }: { source: { name: string; owner: string | null }; t: Theme }) {
  return (
    <span style={{ fontSize: 11, color: t.textMuted }}>
      from <span style={{ color: t.accent, fontWeight: 600 }}>{source.name}</span> · Owner: <span style={{ color: source.owner ? t.textSecondary : t.warning, fontWeight: 600 }}>{source.owner ?? 'not set'}</span>
    </span>
  );
}

/** The chart configuration the run produced, so a pinned tile is not forced to `table`. */
function runChartConfig(run: AgentRun): CellChartConfig | undefined {
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const result = extractResult(payload);
    if (!result) continue;
    const config = extractChartConfig(payload, result);
    if (config) return config;
  }
  return undefined;
}

/** The executed rows, so a pinned tile renders data instead of an empty summary. */
function runResult(run: AgentRun): QueryResult | undefined {
  for (const artifact of run.artifacts) {
    const result = extractResult(payloadOf(artifact));
    if (result) return result;
  }
  return undefined;
}

function answerDqlArtifactFromRun(run: AgentRun): AgentConversationDqlArtifact | undefined {
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const dqlArtifact = normalizeDqlArtifactReference(payload.dqlArtifact);
    if (dqlArtifact) return dqlArtifact;
    const researchRun = payload.researchRun && typeof payload.researchRun === 'object' && !Array.isArray(payload.researchRun)
      ? payload.researchRun as Record<string, unknown>
      : undefined;
    const researchArtifact = normalizeDqlArtifactReference(researchRun?.dqlArtifact);
    if (researchArtifact) return researchArtifact;
  }
  return undefined;
}

export function artifactReadyPayloadFromRun(run: AgentRun): InsertDqlPayload | undefined {
  const canCommitBlockDraft = run.route === 'dql_block_draft'
    && run.status !== 'blocked'
    && run.status !== 'cancelled'
    && run.stopReason !== 'cancelled'
    && run.status !== 'needs_clarification';
  if (run.route === 'certified_answer' || (!isAgentRunPinnable(run) && !canCommitBlockDraft)) return undefined;
  const dqlArtifact = answerDqlArtifactFromRun(run);
  const sql = answerSqlFromRun(run);
  if ((!dqlArtifact?.source || dqlArtifact.sourcePath) && !sql) return undefined;
  for (const artifact of run.artifacts) {
    const payload = payloadOf(artifact);
    const result = extractResult(payload);
    const mixedSourcePlan = extractMixedSourceNotebookPlan(payload);
    if (result) {
      return {
        sql,
        dqlArtifact,
        result,
        chartConfig: extractChartConfig(payload, result),
        title: dqlArtifact?.name ?? artifact.title ?? run.question,
        mixedSourcePlan,
        sourceRunId: run.id,
        question: run.question,
        executionTarget: run.executionTarget,
      };
    }
    if (mixedSourcePlan) {
      return {
        sql,
        dqlArtifact,
        title: dqlArtifact?.name ?? artifact.title ?? run.question,
        mixedSourcePlan,
        sourceRunId: run.id,
        question: run.question,
        executionTarget: run.executionTarget,
      };
    }
  }
  return {
    sql,
    dqlArtifact,
    title: dqlArtifact?.name ?? run.question,
    sourceRunId: run.id,
    question: run.question,
    executionTarget: run.executionTarget,
  };
}

function extractMixedSourceNotebookPlan(payload: Record<string, unknown>): MixedSourceNotebookPlan | undefined {
  const value = payload.mixedSourcePlan;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const plan = value as Record<string, unknown>;
  const required = ['localDataset', 'localAlias', 'localKey', 'warehouseKey', 'warehouseExpression', 'warehouseSql'] as const;
  if (!required.every((key) => typeof plan[key] === 'string' && String(plan[key]).trim())) return undefined;
  return {
    datasetId: typeof plan.datasetId === 'string' ? plan.datasetId : undefined,
    datasetName: typeof plan.datasetName === 'string' ? plan.datasetName : undefined,
    localDataset: String(plan.localDataset),
    localAlias: String(plan.localAlias),
    localKey: String(plan.localKey),
    warehouseKey: String(plan.warehouseKey),
    warehouseExpression: String(plan.warehouseExpression),
    warehouseSql: String(plan.warehouseSql),
    warehouseRelations: Array.isArray(plan.warehouseRelations)
      ? plan.warehouseRelations.filter((value): value is string => typeof value === 'string')
      : undefined,
  };
}

function evidenceChipStyle(t: Theme, certified: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 10.5,
    padding: '2px 7px',
    borderRadius: 999,
    background: certified ? `${t.success}14` : t.cellBg,
    color: certified ? t.success : t.textMuted,
    border: `1px solid ${certified ? `${t.success}44` : t.headerBorder}`,
  };
}

function appliedChipStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    fontSize: 10.5,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 999,
    background: `${t.accent}14`,
    color: t.accent,
    border: `1px solid ${t.accent}33`,
    cursor: 'pointer',
  };
}



function appliedStopStyle(t: Theme): React.CSSProperties {
  return {
    flex: '0 0 auto',
    fontSize: 10.5,
    border: `1px solid ${t.headerBorder}`,
    background: 'transparent',
    color: t.textMuted,
    borderRadius: 6,
    padding: '2px 7px',
    cursor: 'pointer',
  };
}

function iconShellStyle(t: Theme): React.CSSProperties {
  return {
    width: 30,
    height: 30,
    borderRadius: 8,
    background: `${t.accent}14`,
    border: `1px solid ${t.accent}36`,
    color: t.accent,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
  };
}

function largeIconShellStyle(t: Theme): React.CSSProperties {
  return { ...iconShellStyle(t), width: 40, height: 40 };
}

function suggestionChipStyle(t: Theme): React.CSSProperties {
  return { ...controlStyle(t, { variant: 'secondary', size: 'md', pill: true }), fontWeight: 550 };
}

function inputStyle(t: Theme): React.CSSProperties {
  return {
    flex: 1,
    minHeight: 54,
    maxHeight: 140,
    resize: 'none',
    border: `1px solid ${t.btnBorder}`,
    background: t.inputBg,
    color: t.textPrimary,
    borderRadius: 12,
    padding: '11px 13px',
    fontSize: 13,
    lineHeight: 1.45,
    fontFamily: t.font,
    outline: 'none',
    boxShadow: 'none',
  };
}

function sendButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  // Keeps its taller `lg` footprint but shares the radius, type scale and
  // disabled treatment with every other control.
  return {
    ...controlStyle(t, { variant: enabled ? 'primary' : 'secondary', size: 'lg' }),
    ...(enabled ? {} : { color: t.textMuted }),
  };
}

function heroAddButtonStyle(t: Theme): React.CSSProperties {
  return {
    border: 'none',
    background: t.accent,
    color: '#fff',
    borderRadius: 8,
    padding: '7px 13px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: t.font,
    cursor: 'pointer',
    boxShadow: `0 1px 5px ${t.accent}4d`,
  };
}

function addPopoverStyle(t: Theme): React.CSSProperties {
  return {
    position: 'absolute',
    bottom: 'calc(100% + 6px)',
    left: 0,
    zIndex: 41,
    width: 264,
    background: t.cellBg,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 10,
    boxShadow: '0 12px 32px rgba(0,0,0,0.2)',
    padding: 10,
  };
}

function appRowStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 9px',
    borderRadius: 7,
    border: 'none',
    background: 'transparent',
    color: t.textSecondary,
    fontSize: 12.5,
    fontWeight: 550,
    fontFamily: t.font,
    cursor: 'pointer',
  };
}

function newAppRowStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 9px',
    borderRadius: 7,
    border: `1px dashed ${t.accent}66`,
    background: `${t.accent}0d`,
    color: t.accent,
    fontSize: 12.5,
    fontWeight: 650,
    fontFamily: t.font,
    cursor: 'pointer',
    marginBottom: 2,
  };
}

function pickerInputStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    border: `1px solid ${t.btnBorder}`,
    background: t.inputBg,
    color: t.textPrimary,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12.5,
    fontFamily: t.font,
    outline: 'none',
  };
}

function userBubbleStyle(t: Theme): React.CSSProperties {
  return {
    alignSelf: 'flex-end',
    maxWidth: '88%',
    background: `${t.accent}16`,
    color: t.textPrimary,
    border: `1px solid ${t.accent}32`,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12.5,
    lineHeight: 1.45,
  };
}

function assistantBubbleStyle(t: Theme): React.CSSProperties {
  return {
    alignSelf: 'flex-start',
    maxWidth: '92%',
    color: t.textPrimary,
    border: `1px solid ${t.cellBorder}`,
    background: t.appBg,
    borderRadius: 10,
    padding: '10px 12px',
  };
}

function runCardStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    background: t.appBg,
    borderRadius: 8,
    padding: 10,
    display: 'grid',
    gap: 10,
    // A grid's implicit column track floors at the widest child's min-content
    // (e.g. a long SQL line in "View query"), inflating every row past the chat
    // column and leaving a horizontal-scroll white gutter after results/refresh.
    // minmax(0, 1fr) lets children shrink; wide content scrolls in its own box.
    gridTemplateColumns: 'minmax(0, 1fr)',
    minWidth: 0,
    maxWidth: '100%',
  };
}

function artifactStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    background: t.cellBg,
    borderRadius: 8,
    padding: 9,
    display: 'grid',
    gap: 8,
    gridTemplateColumns: 'minmax(0, 1fr)',
    minWidth: 0,
    maxWidth: '100%',
  };
}

function answerBoxStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    background: t.cellBg,
    borderRadius: 8,
    padding: 9,
    fontSize: 12.5,
    color: t.textPrimary,
    lineHeight: 1.45,
  };
}

function codeStyle(t: Theme): React.CSSProperties {
  return {
    margin: 0,
    maxHeight: 180,
    overflow: 'auto',
    border: `1px solid ${t.headerBorder}`,
    background: t.editorBg,
    color: t.textPrimary,
    borderRadius: 7,
    padding: 9,
    fontSize: 11,
    lineHeight: 1.45,
    fontFamily: t.fontMono,
    whiteSpace: 'pre-wrap',
  };
}

function askParameterControlStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 5,
    color: t.textPrimary,
    padding: '5px 7px',
    fontSize: 11,
    fontFamily: t.font,
  };
}

function smallButtonStyle(t: Theme): React.CSSProperties {
  return controlStyle(t, { variant: 'secondary', size: 'sm' });
}

/**
 * What a failure of each ORIGIN means, and what the user can do about it.
 *
 * Before this, every failure rendered as one grey paragraph, so a warehouse
 * rejection, a governance refusal and a DQL block-compile problem were
 * indistinguishable — and the most common line, "The selected route could not
 * compile its immutable analytical plan", is the DEFAULT for anything
 * unclassified. The origin is decided at the throw site (see
 * `analytical-error.ts`), so the card can finally say which of them happened.
 */
const ASK_FAILURE_PRESENTATION: Record<string, { title: string; hint: string }> = {
  warehouse: {
    title: 'The warehouse rejected the query',
    hint: 'The SQL reached your warehouse and it refused. The message below is the driver\u2019s own.',
  },
  execution: {
    title: 'The selected query did not complete',
    hint: 'ZLens froze the selected plan and began execution, but the current connection could not complete it. Review the connection or warehouse state, then retry.',
  },
  dql_compilation: {
    title: 'ZLens could not build a reusable saved query',
    hint: 'The query itself is fine \u2014 only saving this answer as a saved query is affected.',
  },
  governance_gate: {
    title: 'ZLens stopped this before running it',
    hint: 'A governance check refused the query, so it never reached the warehouse.',
  },
  retrieval_gap: {
    title: 'ZLens could not confirm this data exists',
    hint: 'The relation was not in the inspected metadata. Refreshing the connection scope usually resolves it.',
  },
  ambiguity: {
    title: 'One detail is missing',
    hint: 'Answer the question above and ZLens will continue.',
  },
  provider_missing: {
    title: ASK_NEEDS_AI_PROVIDER_HEADING,
    hint: 'No AI model ran. The owner can connect one in Settings; everything else in ZLens works without AI.',
  },
  provider: {
    title: 'The AI provider failed',
    hint: 'Nothing was run. Retry, or check the provider in Settings.',
  },
  orchestration_budget: {
    title: 'Ask could not freeze one executable plan',
    hint: 'Nothing was run. Ask stopped its own planning loop before another provider call; narrow the metric or dimension and retry.',
  },
  host: {
    title: 'ZLens hit an internal error',
    hint: 'This is a defect in ZLens. The detail below is what to report.',
  },
  modeling_gap: {
    title: 'Nothing in this project answers this question',
    hint: 'No query ran. Add or review the missing metric, dimension, relationship, or allocation rule.',
  },
  no_data: {
    title: 'No matching data',
    hint: 'The query ran and returned no rows for the requested period or filter. The data may end before it.',
  },
  proof_integrity: {
    title: 'Not executed: exact semantic proof was not established',
    hint: 'ZLens could not establish the exact metric, requested grain, join keys, and fanout proof. Warehouse success cannot create that authority.',
  },
  identity_integrity: {
    title: 'ZLens found an internal identity or target-binding defect',
    hint: 'No query ran. This is an orchestration integrity defect, not missing business modeling.',
  },
  policy: {
    title: 'Policy or permissions blocked this query',
    hint: 'No AI repair was attempted. Use only the server-provided access or connection actions.',
  },
  result_contract: {
    title: 'The warehouse result did not match the frozen plan',
    hint: 'The query ran, but ZLens rejected the returned columns, types, grain, or row bound.',
  },
  compile: {
    title: 'ZLens could not compile the frozen plan',
    hint: 'The query did not reach the warehouse. Review the exact plan binding and compiler diagnostic.',
  },
  timeout: {
    title: 'This run reached its hard deadline',
    hint: 'ZLens stopped the run at its request-owned deadline and did not accept a later result.',
  },
  cancel: {
    title: 'This run was cancelled',
    hint: 'Cancellation is terminal and no later provider or warehouse result was accepted.',
  },
  unknown: {
    title: 'The query could not be completed',
    hint: 'Inspect the details or use the bounded repair when it is available.',
  },
};

/** The failure origin recorded on the run. Missing attribution stays unknown. */
function askFailureOrigin(run: AgentRun): string {
  if (run.status === 'cancelled' || run.stopReason === 'cancelled' || run.route === 'cancelled' || run.diagnosticReceipt?.failure?.code === 'RUN_CANCELLED') {
    return 'cancel';
  }
  if (askNeedsAiProvider(run)) return 'provider_missing';
  // V4 is the canonical receipt for terminal Ask incidents. It must win over
  // a legacy compatibility refusal code carried in an answer artifact: after
  // `sql.execute`, this is no longer a retrieval/grounding problem.
  const terminalIncident = run.diagnosticReceiptV4?.terminalIncident;
  if (terminalIncident?.code === 'ANALYTICAL_EXECUTION_FAILED' && terminalIncident.boundary === 'sql.execute') {
    return 'execution';
  }
  if (terminalIncident?.code === 'RESULT_CONTRACT_MISMATCH' && terminalIncident.boundary === 'result.validate') {
    return 'result_contract';
  }
  for (const artifact of run.artifacts ?? []) {
    const rawPayload = payloadOf(artifact);
    const payload = rawPayload as {
      warehouseFailure?: { origin?: unknown };
      providerFailure?: { code?: unknown };
      refusalCode?: unknown;
      gap?: { kind?: unknown };
      executionError?: unknown;
      analyticalFailure?: { code?: unknown; phase?: unknown };
      aggregationSafetyProof?: { status?: unknown };
    } | undefined;
    const origin = payload?.warehouseFailure?.origin;
    const code = typeof payload?.analyticalFailure?.code === 'string' ? payload.analyticalFailure.code : '';
    if (askCompilationFailureKind(rawPayload)) return 'compile';
    if (payload?.refusalCode === 'no_data' || payload?.gap?.kind === 'not_retrieved') return 'no_data';
    if (payload?.refusalCode === 'modeling_gap') return 'modeling_gap';
    if (payload?.aggregationSafetyProof?.status === 'blocked') return 'proof_integrity';
    if (['IDENTIFIER_SCOPE_INVALID', 'EXECUTION_TARGET_MISMATCH', 'SEMANTIC_TARGET_BINDING_MISSING', 'SEMANTIC_SOURCE_DRIFT'].includes(code)) return 'identity_integrity';
    if (['POLICY_DENIED', 'PERMISSION_DENIED'].includes(code)) return 'policy';
    if (code === 'RESULT_CONTRACT_MISMATCH') return 'result_contract';
    if (['TIMEOUT', 'SEMANTIC_COMPILATION_TIMEOUT'].includes(code)) return 'timeout';
    if (code === 'EXECUTION_CANCELLED') return 'cancel';
    if (['COMPILATION_FAILED', 'DIALECT_ERROR', 'SEMANTIC_ADAPTER_NOT_READY'].includes(code)) return 'compile';
    if (typeof origin === 'string' && origin in ASK_FAILURE_PRESENTATION) return origin;
    // `executionError` is a legacy display carrier. A typed compiler or
    // result-validation failure can retain the same string without crossing
    // the SQL execution boundary, so only use it when the payload has no
    // typed analytical failure. Typed execution remains an execution card.
    const hasTypedAnalyticalFailure = payload?.analyticalFailure !== undefined;
    const typedExecutionFailure = hasTypedAnalyticalFailure
      && payload?.analyticalFailure?.phase === 'execution';
    const legacyExecutionFailure = !hasTypedAnalyticalFailure
      && (payload?.refusalCode === 'execution_error'
        || (typeof payload?.executionError === 'string' && payload.executionError.trim().length > 0));
    if (typedExecutionFailure || legacyExecutionFailure) return 'execution';
    if (payload?.providerFailure?.code === 'orchestration_budget_exhausted'
      || payload?.providerFailure?.code === 'PROVIDER_DISPATCH_BUDGET_EXHAUSTED'
      || payload?.refusalCode === 'orchestration_budget_exhausted') return 'orchestration_budget';
    if (payload?.providerFailure || payload?.refusalCode === 'provider_error') return 'provider';
    // Without these two, every refusal that is not a modeling gap fell through
    // to `unknown` — so the already-written ambiguity and retrieval-gap cards
    // were unreachable and users saw "The query could not be completed" instead
    // of the reason the run actually recorded.
    if (payload?.refusalCode === 'ambiguous') return 'ambiguity';
    if (payload?.refusalCode === 'grounding_gap') return 'retrieval_gap';
  }
  if (run.diagnosticReceipt?.failure?.code === 'orchestration_budget_exhausted') return 'orchestration_budget';
  if (run.diagnosticReceipt?.failure?.code === 'AI_PROVIDER_FAILURE') return 'provider';
  return 'unknown';
}

export function askRunCaptureWarning(run: AgentRun): string | undefined {
  for (const artifact of run.artifacts ?? []) {
    const payload = payloadOf(artifact);
    const warnings = Array.isArray(payload.validationWarnings)
      ? payload.validationWarnings.filter((item): item is string => typeof item === 'string')
      : [];
    const warning = warnings.find((item) => /captur|reusable DQL block|save as (?:a )?block/i.test(item));
    if (warning) return warning;
  }
  return undefined;
}

export function askRunAllowsExecutionRepair(run: AgentRun): boolean {
  const capability = run.repairCapability;
  return capability?.version === 1
    && capability.automatic.eligible === true
    && capability.automatic.action === 'repair_embedded_sql'
    && capability.automatic.correctionCode === 'SQL_EXECUTION_REPAIR'
    && capability.automatic.attemptsRemaining > 0
    && capability.routeLocked === true
    && capability.targetLocked === true
    && capability.sourceImmutable === true;
}

/**
 * A failure the user can act on: what happened, in whose words, and what to try.
 */
function AskFailureCard({
  run,
  detail,
  threadId,
  onRepaired,
  t,
}: {
  run: AgentRun;
  detail: string;
  threadId?: string;
  onRepaired: (run: AgentRun) => void;
  t: Theme;
}): JSX.Element {
  const origin = askFailureOrigin(run);
  const presentation = ASK_FAILURE_PRESENTATION[origin] ?? ASK_FAILURE_PRESENTATION.unknown;
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const canRepair = askRunAllowsExecutionRepair(run);
  const repair = async () => {
    if (repairing) return;
    setRepairing(true);
    setRepairError(null);
    try {
      const response = await api.repairAgentRunExecution(run.id, threadId);
      onRepaired(response.run);
    } catch (cause) {
      setRepairError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRepairing(false);
    }
  };
  return (
    <div
      data-followup="answer"
      style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        padding: '11px 13px', borderRadius: 9,
        border: `1px solid ${t.error}33`, background: `${t.error}0d`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <ShieldAlert size={13} color={t.error} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: t.textPrimary }}>{presentation.title}</span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: t.textSecondary, wordBreak: 'break-word' }}>
        {cleanPresentationText(detail)}
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: t.textMuted }}>{presentation.hint}</div>
      {canRepair ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          <button
            type="button"
            className="dql-hover"
            disabled={repairing}
            onClick={() => void repair()}
            style={{ ...smallButtonStyle(t), opacity: repairing ? 0.7 : 1 }}
          >
            <Wrench size={12} /> {repairing ? 'Fixing and retrying…' : 'Fix and retry'}
          </button>
          <span style={{ fontSize: 10.5, color: t.textMuted }}>One bounded repair attempt on the same data target.</span>
        </div>
      ) : null}
      {repairError ? (
        <div role="alert" style={{ fontSize: 11.5, lineHeight: 1.45, color: t.error }}>{cleanPresentationText(repairError)}</div>
      ) : null}
    </div>
  );
}

/**
 * The most specific failure text a run carries.
 *
 * Preference order matters: `warehouseFailure.redactedMessage` is the producer's
 * own words, `run.summary` is the safe headline plus its diagnostic, and
 * `diagnosticReceipt.failure.message` is the bare per-code headline — the least
 * informative of the three and identical across every unclassified failure.
 */
function askFailureDetail(run: AgentRun): string | undefined {
  const relationshipGap = terminalRelationshipGapDetail(run);
  if (relationshipGap) return relationshipGap;
  for (const artifact of run.artifacts ?? []) {
    const payload = payloadOf(artifact) as {
      warehouseFailure?: { redactedMessage?: unknown; diagnostic?: unknown };
      executionError?: unknown;
      refusalDetails?: { message?: unknown };
    } | undefined;
    const failure = payload?.warehouseFailure;
    // `refusalDetails.message` is the reason a refusal actually recorded. It was
    // never read, so a blocked run showed the generic headline instead.
    const specific = [
      failure?.redactedMessage,
      failure?.diagnostic,
      payload?.executionError,
      payload?.refusalDetails?.message,
    ]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (specific) return specific;
  }
  const bindingDetail = retainedPlanBindingFailure(run);
  if (bindingDetail) return bindingDetail;
  return run.summary || run.diagnosticReceipt?.failure?.message;
}

/**
 * The relationship proof receipt is typed authority from the router/cascade,
 * not an inference from a broad blocked route or an exception string. Surface
 * it before legacy executor text so `EXECUTION_BLOCKED` cannot hide a safe
 * no-join decision in the main Ask answer card.
 */
function terminalRelationshipGapDetail(run: AgentRun): string | undefined {
  const receipts: Array<Record<string, unknown> | undefined> = [
    recordOf(run.diagnosticReceiptV3),
    ...run.artifacts.map((artifact) => recordOf(payloadOf(artifact).diagnosticReceiptV3)),
  ];
  const route = recordOf(run.routeDecision);
  const routeTerminal = recordOf(route?.terminalOutcome);
  const routeGap = recordOf(routeTerminal?.gap);
  const candidates = [
    ...receipts.flatMap((receipt) => [
      recordOf(receipt?.terminalGap),
      recordOf(recordOf(receipt?.cascade)?.terminalGap),
    ]),
    routeGap,
  ];
  if (!candidates.some((gap) => gap?.code === 'MISSING_RELATIONSHIP')) return undefined;
  return 'This Ask needs a certified relationship or approved allocation proof before it can run. ZLens did not infer a relationship or execute a query.';
}

/** Defensive compatibility for persisted runs produced before router
 * reconciliation. New runs should arrive as clarification/modeling-gap
 * outcomes, but a retained RAP still contains enough safe business context to
 * avoid the legacy one-line “Agent run is blocked” presentation. */
function retainedPlanBindingFailure(run: AgentRun): string | undefined {
  const plans = [
    recordOf(recordOf(run.diagnosticReceipt)?.resolvedAnalyticalPlan),
    ...(run.artifacts ?? []).flatMap((artifact) => {
      const payload = payloadOf(artifact);
      return [
        recordOf(payload.resolvedAnalyticalPlan),
        recordOf(recordOf(payload.diagnosticReceipt)?.resolvedAnalyticalPlan),
      ];
    }),
  ].filter((plan): plan is Record<string, unknown> => Boolean(plan));
  for (const plan of plans) {
    const query = recordOf(plan.query);
    const bindings = [
      ...recordList(query?.measures).map((binding) => ({ kind: 'metric', binding })),
      ...recordList(query?.dimensions).map((binding) => ({ kind: 'dimension', binding })),
      ...recordList(query?.filters).flatMap((filter) => {
        const binding = recordOf(filter.binding);
        return binding ? [{ kind: 'filter', binding }] : [];
      }),
    ];
    const failed = bindings.find(({ binding }) => binding.status === 'ambiguous' || binding.status === 'unresolved');
    if (!failed) continue;
    const requested = displayValue(failed.binding.requested) || `requested ${failed.kind}`;
    const choices = Array.isArray(failed.binding.candidateIds)
      ? failed.binding.candidateIds.filter((value): value is string => typeof value === 'string').map(qualifiedBindingLabel)
      : [];
    if (failed.binding.status === 'ambiguous' && choices.length > 1) {
      return `I found more than one governed ${failed.kind} for “${requested}”: ${choices.join(' or ')}. Choose one before I run the query.`;
    }
    return `I couldn’t identify one governed ${failed.kind} for “${requested}”. Review that model binding before retrying.`;
  }
  return undefined;
}

function qualifiedBindingLabel(id: string): string {
  const local = id.split(/[:./]/).filter(Boolean).at(-1) ?? id;
  return local.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
