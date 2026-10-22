/**
 * Ask Trace — local, addressable evidence for one Ask/Research run.
 *
 * The page deliberately hydrates a trace by run id. Notebook state holds only
 * that id; it never stores a prompt, SQL text, row data, provider response, or
 * an unbounded trace. The API's typed trace contract is already redacted.
 *
 * Acceptance: OBS-009, OBS-010, UI-012.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { CSSProperties } from 'react';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Clock3,
  Database,
  Filter,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  api,
  type AskTraceCandidateDecisionV1,
  type AskTraceDataV1,
  type AskTraceSpanV1,
} from '../../api/client';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { explanationForTrace } from './ask-run-explanation';
import { AskRunDecisionView, AskRunTraceSummary } from './AskRunDecisionView';
import { InvestigationDecisionView } from './InvestigationDecisionView';
import { explainInvestigation, isInvestigationReceipt } from './investigation-view';

type TraceTab = 'tree' | 'graph' | 'timeline';
type TraceSelection = { kind: 'span'; spanId: string } | { kind: 'candidates' };

const CANDIDATE_PAGE_SIZE = 50;
const TRACE_PAGE_POLL_MS = 1_500;
/** Stored V4 summaries are authoritative. Never infer a replacement story from old spans. */
export const CANONICAL_DECISION_SUMMARY_UNAVAILABLE = 'Canonical decision summary unavailable for this older run';

/** URL focus is presentation state only; trace evidence remains API-hydrated. */
export function askTraceFocusFromSearch(search: string | undefined): 'research' | undefined {
  if (!search) return undefined;
  return new URLSearchParams(search).get('focus') === 'research' ? 'research' : undefined;
}

/**
 * A Research branch ledger is represented by the receipt-bound validation
 * stage. Fall back to the plan/synthesis stage for a run that never reached a
 * child branch, without inventing a branch outcome.
 */
export function researchFocusSpanForTrace(trace: AskTraceDataV1): AskTraceSpanV1 | undefined {
  const research = trace.spans.filter((span) => span.stage === 'research' || span.name.startsWith('research.'));
  return research.find((span) => span.name === 'research.lineage')
    ?? research.find((span) => span.name === 'research.validate')
    ?? research.find((span) => span.name === 'research.plan')
    ?? research[0];
}

/**
 * A compact, receipt-bound explanation for the dedicated local lineage
 * program. It deliberately uses only typed counts and outcome codes: no
 * target text, graph content, provider payload, SQL, result rows, or causal
 * conclusion may enter the trace page through this helper.
 */
export function lineageResearchStoryForSpan(span: AskTraceSpanV1 | undefined): string | undefined {
  if (span?.name !== 'research.lineage' || span.payload.kind !== 'research' || span.payload.evidenceKind !== 'lineage_graph') {
    return undefined;
  }

  const payload = span.payload;
  const status = payload.lineageStatus ?? 'unavailable';
  const upstream = typeof payload.upstreamNodeCount === 'number' ? payload.upstreamNodeCount : 0;
  const downstream = typeof payload.downstreamNodeCount === 'number' ? payload.downstreamNodeCount : 0;
  const bounds = [
    typeof payload.lineageMaxDepth === 'number' ? `depth ${payload.lineageMaxDepth}` : undefined,
    typeof payload.lineageMaxRoutes === 'number' ? `${payload.lineageMaxRoutes} routes` : undefined,
    typeof payload.lineageMaxNodes === 'number' ? `${payload.lineageMaxNodes} nodes` : undefined,
    typeof payload.lineageMaxEdges === 'number' ? `${payload.lineageMaxEdges} edges` : undefined,
  ].filter((value): value is string => Boolean(value));
  const bounded = bounds.length > 0 ? ` Bounded to ${bounds.join(', ')}.` : '';
  const boundary = ' It is non-causal evidence about local structure only—not provider, SQL, warehouse, result, or causal evidence.';

  if (status === 'completed') {
    return `The frozen local lineage graph resolved the requested target and observed ${upstream} upstream and ${downstream} downstream nodes.${bounded}${boundary}`;
  }
  if (status === 'truncated') {
    return `The frozen local lineage graph resolved the requested target, but the bounded traversal stopped before a complete structural view was available.${bounded}${boundary}`;
  }
  if (status === 'ambiguous') {
    return `The frozen local lineage graph found more than one exact target. No broader search or query was attempted.${boundary}`;
  }
  if (status === 'missing') {
    return `The frozen local lineage graph did not contain the exact requested target. No broader search or query was attempted.${boundary}`;
  }
  if (status === 'stale') {
    return `The local lineage snapshot did not match the frozen Research snapshot, so structural evidence was not used.${boundary}`;
  }
  return `Local lineage evidence was unavailable for this Research branch. No broader search or query was attempted.${boundary}`;
}

function expandedThroughTraceSpan(trace: AskTraceDataV1, spanId: string, initial: Set<string>): Set<string> {
  const byId = new Map(trace.spans.map((span) => [span.spanId, span]));
  const next = new Set(initial);
  let current: string | undefined = spanId;
  while (current) {
    next.add(current);
    current = byId.get(current)?.parentSpanId;
  }
  return next;
}

export function AskTracePage({ runId }: { runId: string }): JSX.Element {
  const themeMode = useNotebookStore((state) => state.themeMode);
  const t = themes[themeMode];
  const dispatch = useDispatch();
  const [trace, setTrace] = useState<AskTraceDataV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TraceTab>('tree');
  const [selection, setSelection] = useState<TraceSelection | null>(null);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [candidateOffset, setCandidateOffset] = useState(0);
  const [showExcluded, setShowExcluded] = useState(false);
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 900);
  const requestedFocus = askTraceFocusFromSearch(typeof window !== 'undefined' ? window.location.search : undefined);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const next = await api.getAskTraceByRun(runId);
        if (!active) return;
        setTrace(next);
        setError(null);
        setLoading(false);
        if (next.envelope.recordingStatus === 'recording') {
          timer = window.setTimeout(() => void load(), TRACE_PAGE_POLL_MS);
        }
      } catch (cause) {
        if (!active) return;
        setLoading(false);
        setError(errorMessage(cause));
      }
    };
    void load();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    const resize = () => setIsNarrow(window.innerWidth < 900);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    if (!trace) return;
    setExpanded(traceInitialExpanded(trace));
    setSelection((prior) => prior ?? { kind: 'span', spanId: trace.envelope.rootSpanId });
    setCandidateOffset(0);
    setShowExcluded(false);
  }, [trace?.envelope.traceId]);

  useEffect(() => {
    if (!trace || requestedFocus !== 'research') return;
    const span = researchFocusSpanForTrace(trace);
    if (!span) return;
    setTab('tree');
    setSelection({ kind: 'span', spanId: span.spanId });
    setExpanded((prior) => expandedThroughTraceSpan(trace, span.spanId, prior));
    const focusResearch = () => document.getElementById(`ask-trace-span-${span.spanId}`)?.focus();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focusResearch);
    } else {
      focusResearch();
    }
  }, [requestedFocus, trace?.envelope.traceId]);

  const goBack = () => {
    // Preserve the actual browser journey: a trace opened from the catalog
    // returns there, while one opened from an Ask answer returns to that Ask.
    // A directly loaded detail has no safe prior DQL route, so land on the
    // local catalog rather than navigating an unrelated browser history entry.
    if (typeof window !== 'undefined' && window.history.state?.askTraceRunId && window.history.length > 1) {
      window.history.back();
      return;
    }
    dispatch({ type: 'OPEN_ASK_OBSERVABILITY' });
  };
  const openCatalog = () => dispatch({ type: 'OPEN_ASK_OBSERVABILITY' });
  const selectIncidentSpan = (spanId: string) => {
    setSelection({ kind: 'span', spanId });
    // The incident card deliberately links only to a typed stage identifier;
    // it does not embed trace payloads in the URL or DOM. A short delay lets a
    // tab/detail transition commit before moving keyboard focus.
    window.requestAnimationFrame(() => document.getElementById(`ask-trace-span-${spanId}`)?.focus());
  };

  if (loading && !trace) return <TraceLoading t={t} />;
  if (error && !trace) return <TraceFailure t={t} message={error} onBack={goBack} onRetry={() => window.location.reload()} />;
  if (!trace) return <TraceFailure t={t} message="No local trace data is available for this Ask run." onBack={goBack} onRetry={() => window.location.reload()} />;
  const researchFocus = requestedFocus === 'research' ? researchFocusSpanForTrace(trace) : undefined;
  const lineageStory = lineageResearchStoryForSpan(researchFocus);
  // An Ask pipeline run is explained as a decision flow; the recorded events stay below as an advanced view.
  const pipelineExplanation = explanationForTrace(trace);
  // A Research run is explained as its investigation: the programs as a branching flow.
  const researchReceipt = (trace as { runtimeReceiptV9?: unknown }).runtimeReceiptV9;
  const investigationExplanation = isInvestigationReceipt(researchReceipt) ? explainInvestigation({ receipt: researchReceipt }) : undefined;

  return (
    <main style={{ flex: 1, minWidth: 0, overflow: 'auto', background: t.appBg, color: t.textPrimary, fontFamily: t.font }}>
      <div style={{ maxWidth: 1_600, margin: '0 auto', padding: isNarrow ? '16px 14px 28px' : '20px 24px 34px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" onClick={goBack} style={backLinkStyle(t)}>
            <ArrowLeft size={14} /> Back
          </button>
          <button type="button" onClick={openCatalog} style={{ ...backLinkStyle(t), color: t.textMuted }}>
            <Search size={13} /> All local traces
          </button>
        </div>
        <TraceHeader trace={trace} t={t} onRefresh={() => window.location.reload()} />
        {researchFocus ? (
          <div role="status" aria-live="polite" style={{ margin: '0 0 12px', padding: '9px 11px', border: `1px solid ${t.accent}`, borderRadius: 8, background: `${t.accent}0d`, color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>
            {lineageStory ?? 'Research evidence selected. This trace retains bounded branch verdicts. A lineage branch records local structural evidence only; it never represents provider, SQL, warehouse, result, or causal evidence.'}
          </div>
        ) : null}
        <TraceDecisionStory trace={trace} t={t} onSelectSpan={selectIncidentSpan} />
        {investigationExplanation ? <InvestigationDecisionView explanation={investigationExplanation} t={t} isNarrow={isNarrow} /> : null}
        {pipelineExplanation ? <AskRunDecisionView trace={trace} explanation={pipelineExplanation} t={t} isNarrow={isNarrow} /> : null}
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', color: t.textSecondary, fontSize: 13, fontWeight: 750, padding: '8px 0' }}>
            {pipelineExplanation ? 'Recorded events (advanced)' : 'Advanced evidence'}
          </summary>
          <div style={{ marginTop: 8 }}>
        {trace.runtimeReceiptV8 ? <V2AdvancedDecisionEvidence receipt={trace.runtimeReceiptV8} t={t} /> : null}
        <TraceTabs selected={tab} onSelect={setTab} t={t} hideGraph={Boolean(pipelineExplanation)} />
        {tab === 'graph' && !pipelineExplanation ? (
          <div id="ask-trace-panel-graph" role="tabpanel" aria-labelledby="ask-trace-tab-graph" style={traceSplitLayout(isNarrow)}>
            <TraceGraph trace={trace} t={t} selection={selection} onSelect={(spanId) => setSelection({ kind: 'span', spanId })} />
            <TraceDetail
              trace={trace}
              t={t}
              selection={selection}
              candidateOffset={candidateOffset}
              onCandidateOffset={setCandidateOffset}
              showExcluded={showExcluded}
              onShowExcluded={setShowExcluded}
            />
          </div>
        ) : tab === 'timeline' ? (
          <div id="ask-trace-panel-timeline" role="tabpanel" aria-labelledby="ask-trace-tab-timeline" style={traceSplitLayout(isNarrow)}>
            <TraceTimeline trace={trace} t={t} selection={selection} onSelect={(spanId) => setSelection({ kind: 'span', spanId })} />
            <TraceDetail
              trace={trace}
              t={t}
              selection={selection}
              candidateOffset={candidateOffset}
              onCandidateOffset={setCandidateOffset}
              showExcluded={showExcluded}
              onShowExcluded={setShowExcluded}
            />
          </div>
        ) : (
          <div id="ask-trace-panel-tree" role="tabpanel" aria-labelledby="ask-trace-tab-tree" style={treeSplitLayout(isNarrow)}>
            <TraceTree
              trace={trace}
              t={t}
              query={query}
              onQuery={setQuery}
              expanded={expanded}
              onExpanded={setExpanded}
              selection={selection}
              onSelect={setSelection}
              isNarrow={isNarrow}
            />
            <TraceDetail
              trace={trace}
              t={t}
              selection={selection}
              candidateOffset={candidateOffset}
              onCandidateOffset={setCandidateOffset}
              showExcluded={showExcluded}
              onShowExcluded={setShowExcluded}
            />
          </div>
        )}
          </div>
        </details>
      </div>
    </main>
  );
}

export function traceHeaderFacts(trace: AskTraceDataV1): {
  selectedTier: string | undefined;
  candidateCount: number;
  candidateLabel: 'candidate admissions' | 'candidate decisions';
} {
  const { envelope } = trace;
  const authoritativeV8 = trace.runtimeReceiptV8?.mode === 'authoritative_v2'
    ? trace.runtimeReceiptV8
    : undefined;
  const authoritativeTier = authoritativeV8?.tierAttempts.find((attempt) => attempt.frozen)?.tier
    ?? authoritativeV8?.tierAttempts.find((attempt) => attempt.outcome === 'executed')?.tier
    ?? authoritativeV8?.controllerTier;
  const selectedTier = authoritativeV8 ? authoritativeTier : envelope.selectedTier;
  // V8 owns the bounded initial workspace for an authoritative run. The
  // legacy envelope can contain a larger pre-V2 decision count, which must
  // remain legacy-only instead of inflating the admission count shown here.
  const candidateCount = authoritativeV8
    ? authoritativeV8.initialCandidateCount
    : envelope.candidateDecisionCount;
  return {
    selectedTier,
    candidateCount,
    candidateLabel: authoritativeV8 ? 'candidate admissions' : 'candidate decisions',
  };
}

function TraceHeader({ trace, t, onRefresh }: { trace: AskTraceDataV1; t: Theme; onRefresh: () => void }): JSX.Element {
  const { envelope } = trace;
  const runtimeMode = trace.runtimeReceiptV8?.mode ?? trace.runtimeMode;
  const header = traceHeaderFacts(trace);
  const running = envelope.recordingStatus === 'recording';
  const issue = envelope.status === 'failed' || envelope.status === 'blocked' || envelope.status === 'interrupted';
  return (
    <header style={{ margin: '10px 0 16px', padding: '16px 18px', border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 19, fontWeight: 750, letterSpacing: '-0.015em' }}>Ask trace</div>
          <div style={{ marginTop: 4, fontSize: 12, color: t.textMuted, fontFamily: t.fontMono }}>
            Run {shortId(envelope.runId)} · Trace {shortId(envelope.traceId)}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <StatusPill t={t} value={envelope.status} issue={issue} />
          <Pill t={t} icon={<ShieldCheck size={12} />}>{envelope.trustState ?? 'Trust not recorded'}</Pill>
          {runtimeMode ? <Pill t={t} icon={<GitBranch size={12} />}>{askRuntimeModeLabel(runtimeMode)}</Pill> : null}
          <Pill t={t} icon={<GitBranch size={12} />}>{header.selectedTier ?? 'No executable tier'}</Pill>
          <Pill t={t} icon={<Clock3 size={12} />}>{formatMs(envelope.durationMs)} </Pill>
          <button type="button" onClick={onRefresh} title="Refresh local trace evidence" style={iconButtonStyle(t)}>
            <RefreshCw size={13} className={running ? 'ask-trace-recording' : undefined} />
            <span className="sr-only">Refresh trace</span>
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, fontSize: 11.5, color: t.textMuted }}>
        <span>{envelope.spanCount} recorded stages</span>
        <span aria-hidden="true">·</span>
        <span>{header.candidateCount} {header.candidateLabel}</span>
        <span aria-hidden="true">·</span>
        <span>{recordingLabel(envelope.recordingStatus)}</span>
        {envelope.droppedRecordCount > 0 ? <span role="status">· {envelope.droppedRecordCount} bounded records omitted</span> : null}
      </div>
      <div style={{ marginTop: 9, fontSize: 11, color: t.textMuted, lineHeight: 1.45 }}>
        {trace.valuesWithheld
          ? 'You are reviewing someone else\'s question. This trace shows how it was read and answered: each step and its outcome, refusals, timings, the tables and joins, and the SQL with its values shown as ?. It holds none of its values: no result rows (only about how many), AI replies, check messages or words of the question; columns named after values read column_1, column_2, and its fingerprints are keyed to this trace.'
          : trace.runtimeReceiptV9
          ? 'This local trace keeps the run record: what each AI call was for, how long it took and its reply, the checks, the SQL that ran and a sample of its rows. Full prompts, credentials and file paths are not kept.'
          : 'This local trace contains typed execution evidence only. Prompts, SQL text, result rows, provider responses, credentials, and file paths are not retained.'}
      </div>
    </header>
  );
}

function askRuntimeModeLabel(mode: NonNullable<AskTraceDataV1['runtimeMode']>): string {
  return mode === 'pipeline_v3' ? 'Ask pipeline runtime' : 'Authoritative V2 runtime';
}

function TraceTabs({ selected, onSelect, t, hideGraph = false }: { selected: TraceTab; onSelect: (tab: TraceTab) => void; t: Theme; hideGraph?: boolean }): JSX.Element {
  // A pipeline run's decision flow above replaces the span graph.
  const tabs: Array<{ id: TraceTab; label: string }> = [
    { id: 'tree', label: 'Trace Tree' },
    ...(hideGraph ? [] : [{ id: 'graph' as const, label: 'Agent Graph' }]),
    { id: 'timeline', label: 'Timeline' },
  ];
  if (hideGraph && selected === 'graph') selected = 'tree';
  return (
    <div role="tablist" aria-label="Ask trace views" style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${t.cellBorder}`, marginBottom: 14, overflowX: 'auto' }}>
      {tabs.map((tab) => {
        const active = tab.id === selected;
        return (
          <button
            key={tab.id}
            id={`ask-trace-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`ask-trace-panel-${tab.id}`}
            onClick={() => onSelect(tab.id)}
            style={{
              border: 'none', borderBottom: `2px solid ${active ? t.accent : 'transparent'}`, background: 'transparent', color: active ? t.textPrimary : t.textMuted,
              cursor: 'pointer', padding: '8px 10px', font: `650 12px ${t.font}`, whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Answer-first operational explanation. Every sentence below is assembled
 * from the typed, allowlisted trace contract: it never surfaces an exception,
 * provider message, SQL fragment, candidate label, row, or prompt.
 */
export interface TraceIncidentSummaryV1 {
  state: 'healthy' | 'attention';
  whatHappened: string;
  why: string;
  impact: string;
  howToFix: string;
  spanId?: string;
}

export function incidentSummaryForTrace(trace: AskTraceDataV1): TraceIncidentSummaryV1 {
  // An authoritative V2 tool-runtime receipt owns its terminal boundary. Do
  // not reconstruct a second business explanation from lower-level spans.
  if (trace.runtimeReceiptV8?.mode === 'authoritative_v2') return incidentSummaryFromRuntimeReceiptV8(trace.runtimeReceiptV8);
  if (trace.runtimeDecisionSummary) return incidentSummaryFromRuntimeDecisionSummary(trace.runtimeDecisionSummary);
  // New runs carry one server-produced story. Do not build a competing generic
  // incident from spans; only legacy runs fall through to the compatibility
  // renderer below.
  if (trace.decisionSummary) return incidentSummaryFromDecisionSummary(trace.decisionSummary);
  // The persisted firstIssue pointer is a compact convenience, not the sole
  // authority. Older traces can point at a recoverable certified miss even
  // when a later frozen plan failed. Recompute the action-worthy issue from
  // the safe, typed stages before presenting an incident to an operator.
  const issue = prioritizedIssueForTrace(trace);
  // This is a router-supplied, enumerated terminal proof requirement, not a
  // relationship inferred from the question or from a generic denial. It must
  // outrank coverage text so a safe no-join block never renders as a request to
  // refresh unrelated sources.
  const relationshipGap = terminalRelationshipGapForTrace(trace, issue);
  if (relationshipGap) {
    return {
      state: 'attention',
      whatHappened: 'The Ask stopped because the requested relationship is not certified.',
      why: 'The cascade recorded MISSING_RELATIONSHIP: this request needs a certified relationship or approved allocation proof.',
      impact: 'No query executed; ZLens did not infer a relationship or allocation for the requested ranking.',
      howToFix: 'Add or certify the required relationship or approved allocation proof, then retry the Ask.',
      spanId: relationshipGap.span.spanId,
    };
  }
  // A declared-fiscal-calendar ambiguity is a more precise, authoritative
  // terminal condition than the same snapshot's general source coverage.
  // Prefer the selected terminal cascade span (firstIssueSpanId), then a
  // fiscal terminal cascade witnessed in the typed API payload.
  const fiscalClarification = fiscalClarificationForTrace(trace, issue);
  if (fiscalClarification) {
    return {
      state: 'attention',
      whatHappened: 'The Ask needs a declared fiscal calendar and date role before it can answer.',
      why: 'The fiscal-period request could not bind to a declared fiscal calendar and date role in the recorded snapshot.',
      impact: 'No query executed; ZLens is waiting for a choice that changes the analytical plan.',
      howToFix: 'Select or declare the fiscal calendar and date role, then retry the Ask.',
      spanId: fiscalClarification.span.spanId,
    };
  }
  const completedResult = traceHasAcceptedTerminalResult(trace);
  const hasExecutedAnswer = completedResult;
  const terminalCascade = terminalCascadeForTrace(trace);
  const cascade = terminalCascade?.span ?? trace.spans.find((span) => span.payload.kind === 'cascade');
  const unavailableSources = cascadeUnavailableSources(cascade);
  const fallbackImpact = hasExecutedAnswer
    ? 'The data result completed. This issue may affect the explanation or a follow-up, not the recorded result.'
    : 'No executable data answer was completed for this Ask run.';

  const connectionConfigurationFailure = postFreezeConnectionConfigurationFailureForTrace(trace, issue);
  if (connectionConfigurationFailure) {
    const certified = connectionConfigurationFailure.tier === 'certified';
    return {
      state: 'attention',
      whatHappened: certified
        ? 'The frozen certified plan could not reach a database connection.'
        : 'The frozen analytical plan could not reach a database connection.',
      why: certified
        ? 'The certified plan was frozen, but no database connection was configured before ZLens could compile or execute its saved query.'
        : 'The selected plan was frozen, but no database connection was configured before ZLens could compile or execute it.',
      impact: certified
        ? 'No query or data result executed after the frozen certified plan.'
        : 'No query or data result executed after the frozen analytical plan.',
      howToFix: 'Open Connections, add or select a warehouse or local DuckDB/file connection, then retry the Ask. Recorded safe action: configure a database connection.',
      spanId: connectionConfigurationFailure.span.spanId,
    };
  }

  const semanticFailure = postFreezeSemanticFailureForTrace(trace, issue);
  if (semanticFailure) {
    return {
      state: 'attention',
      whatHappened: 'The frozen semantic plan did not complete.',
      why: `The semantic plan was frozen, then ${semanticFailureReason(semanticFailure.failureCode)}.`,
      impact: 'No data result or query completed after the frozen semantic plan failed.',
      howToFix: `Configure or restore the required semantic compiler, semantic layer, or execution target, then retry. Recorded safe action: ${semanticFailureSafeAction(semanticFailure.safeAction)}.`,
      spanId: semanticFailure.span.spanId,
    };
  }

  // A cascade terminal decision is authoritative. It takes precedence over a
  // prior expected/skipped detail stage, including traces recorded before the
  // observer learned not to promote `meaning.resolve: skipped/unknown`.
  const terminalCascadeWins = Boolean(
    terminalCascade
      && (trace.envelope.terminalOutcome === 'needs_clarification' || !issue || issue.stage === 'cascade' || issue.outcome === 'skipped'),
  );
  if (terminalCascadeWins && terminalCascade?.decision.stopReason === 'ambiguous') {
    return {
      state: 'attention',
      whatHappened: 'The Ask needs one ambiguity-changing business choice before it can answer.',
      why: 'The cascade recorded more than one business meaning that would change the analytical plan.',
      impact: 'No query executed; ZLens is waiting for a choice that changes the analytical plan.',
      howToFix: 'Select the requested business meaning, then retry the Ask.',
      spanId: terminalCascade.span.spanId,
    };
  }

  if (terminalCascadeWins && (terminalCascade?.decision.stopReason === 'coverage_gap' || terminalCascade?.decision.stopReason === 'denied' || terminalCascade?.decision.stopReason === 'post_freeze_failure')) {
    const denied = terminalCascade.decision.stopReason === 'denied';
    const postFreezeFailure = terminalCascade.decision.stopReason === 'post_freeze_failure';
    const sourceExplanation = unavailableSources.length
      ? `The trace recorded incomplete coverage from ${unavailableSources.join(', ')}.`
      : denied
        ? 'The cascade recorded a policy or safety denial before a plan could continue.'
        : postFreezeFailure
          ? 'The selected plan failed after it was frozen, so ZLens did not silently choose another tier.'
          : 'The available evidence did not produce one safe executable plan.';
    return {
      state: 'attention',
      whatHappened: postFreezeFailure
        ? 'The frozen analytical plan did not complete.'
        : 'The Ask flow stopped before it could freeze an executable analytical plan.',
      why: sourceExplanation,
      impact: fallbackImpact,
      howToFix: denied
        ? 'Review the supported model, permitted scope, and approved relationship path, then retry the Ask.'
        : unavailableSources.length
          ? 'Refresh or restore the listed local sources, then retry the Ask.'
          : 'Use the recorded candidate and cascade evidence to resolve the missing business meaning, then retry.',
      spanId: terminalCascade.span.spanId,
    };
  }

  if (!issue && trace.envelope.terminalOutcome === 'needs_clarification') {
    return {
      state: 'attention',
      whatHappened: 'The Ask is waiting for one clarification before it can answer.',
      why: 'The recorded run ended in a clarification state without an executable plan.',
      impact: 'No query executed while the required choice remains unresolved.',
      howToFix: 'Provide the requested business choice, then retry the Ask.',
    };
  }

  if (!issue) {
    return {
      state: 'healthy',
      whatHappened: 'The recorded Ask flow completed without a terminal trace issue.',
      why: 'The selected route reached its recorded terminal stage.',
      impact: hasExecutedAnswer ? 'A data result was recorded for this Ask run.' : 'The trace records a completed non-query response.',
      howToFix: 'No recovery action is required. Open a stage below only if you need the execution evidence.',
    };
  }

  const provider = providerIncident(issue);
  if (provider) {
    return {
      state: 'attention',
      whatHappened: 'A provider-dependent stage did not complete.',
      why: `The recorded provider cause is ${provider.cause}.`,
      impact: fallbackImpact,
      howToFix: provider.safeAction,
      spanId: issue.spanId,
    };
  }

  if (issue.name === 'sql.authorize' || issue.outcome === 'denied' && issue.stage === 'sql') {
    return {
      state: 'attention',
      whatHappened: 'The SQL plan was not authorized for execution.',
      why: 'The trace records a SQL authorization denial; execution was not attempted after that denial.',
      impact: fallbackImpact,
      howToFix: 'Review the supported model, permitted scope, and approved relationship path, then retry the Ask.',
      spanId: issue.spanId,
    };
  }

  if (issue.stage === 'tool') {
    return {
      state: 'attention',
      whatHappened: 'A required local tool step failed.',
      why: 'The trace records a typed tool failure without retaining the raw tool error.',
      impact: fallbackImpact,
      howToFix: 'Inspect the related stage and retry after the required local source or tool is available.',
      spanId: issue.spanId,
    };
  }

  if (issue.stage === 'cascade') {
    const sourceExplanation = unavailableSources.length
      ? `The trace recorded incomplete coverage from ${unavailableSources.join(', ')}.`
      : 'The available evidence did not produce one safe executable plan.';
    return {
      state: 'attention',
      whatHappened: 'The Ask flow stopped before it could freeze an executable analytical plan.',
      why: sourceExplanation,
      impact: fallbackImpact,
      howToFix: unavailableSources.length
        ? 'Refresh or restore the listed local sources, then retry the Ask.'
        : 'Use the recorded candidate and cascade evidence to resolve the missing business meaning, then retry.',
      spanId: issue.spanId,
    };
  }

  return {
    state: 'attention',
    whatHappened: `The ${stageLabel(issue.name)} stage did not complete.`,
    why: `The recorded outcome is ${outcomeText(issue.outcome)}.`,
    impact: fallbackImpact,
    howToFix: 'Open the related stage to review its typed evidence and follow the recorded safe recovery action, if present.',
    spanId: issue.spanId,
  };
}

/** V8 terminal explanations are assembled only from allowlisted receipt fields. */
export function incidentSummaryFromRuntimeReceiptV8(receipt: NonNullable<AskTraceDataV1['runtimeReceiptV8']>): TraceIncidentSummaryV1 {
  const terminal = receipt.terminalOutcome;
  const failed = terminal && terminal.kind !== 'finish_answer';
  if (!failed) {
    return {
      state: 'healthy',
      whatHappened: 'The bounded Ask tool runtime completed this answer.',
      why: `${receipt.tierAttempts.length} ordered tier attempt${receipt.tierAttempts.length === 1 ? '' : 's'} were recorded before the final answer.`,
      impact: receipt.outcome.executionAttempts > 0
        ? 'The recorded plan reached execution; inspect the result and fact receipt for the validated answer.'
        : 'This turn completed without a warehouse execution.',
      howToFix: 'No recovery action is required for the recorded run.',
    };
  }
  const boundary = terminal.origin.replace(/_/g, ' ');
  const reason = terminal.reasonCode.replace(/_/g, ' ').toLowerCase();
  const semanticToolContract = terminal.origin === 'validation'
    && /^SEMANTIC_(?:ENGINE|TIME|FILTER|IDENTIFIER|CAPABILITY)_/.test(terminal.reasonCode);
  return {
    state: 'attention',
    whatHappened: semanticToolContract
      ? 'The Ask rejected the selected semantic tool binding before execution.'
      : terminal.kind === 'clarification'
      ? 'The Ask needs one business choice before it can continue.'
      : terminal.kind === 'provider_failure'
        ? 'The Ask stopped at the AI provider boundary.'
        : terminal.kind === 'execution_failure'
          ? 'The Ask stopped after the selected plan reached execution.'
          : terminal.kind === 'denied'
            ? 'The Ask stopped at a safety or authorization boundary.'
            : terminal.kind === 'budget_exhausted'
              ? 'The Ask reached its bounded work budget before it could complete.'
              : 'The Ask did not find one safe executable route in the recorded workspace.',
    why: `Terminal boundary: ${boundary}. Recorded reason: ${reason}.`,
    impact: receipt.outcome.executionAttempts > 0
      ? 'A selected plan was attempted, but no completed data answer was retained for this run.'
      : semanticToolContract
        ? 'No warehouse execution was started because the snapshot-bound semantic contract was not valid.'
        : 'No warehouse execution was started for this run.',
    howToFix: terminal.safeAction
      ? safeActionInstruction(terminal.safeAction as Parameters<typeof safeActionInstruction>[0])
      : 'Review the typed tool observations and source coverage, then retry only after the recorded gap is addressed.',
  };
}

export function incidentSummaryFromRuntimeDecisionSummary(summary: NonNullable<AskTraceDataV1['runtimeDecisionSummary']>): TraceIncidentSummaryV1 {
  const attention = /did not complete|paused|blocked/i.test(summary.whatHappened);
  return {
    state: attention ? 'attention' : 'healthy',
    whatHappened: summary.whatHappened,
    why: summary.why,
    impact: summary.impact,
    howToFix: safeActionInstruction(summary.nextAction),
  };
}

/**
 * Project the one stored server decision summary into the inspector copy.
 * Exported for the presentation regression so safe-action wording cannot drift
 * from the canonical V4 incident while raw spans remain Advanced-only detail.
 */
export function incidentSummaryFromDecisionSummary(summary: NonNullable<AskTraceDataV1['decisionSummary']>): TraceIncidentSummaryV1 {
  const incident = summary.terminalIncident;
  const researchBranches = summary.researchBranchSummary;
  if (!incident && researchBranches?.partialSuccess) {
    const incomplete = researchBranches.failedBranches + researchBranches.timedOutBranches + researchBranches.skippedBranches;
    return {
      state: 'attention',
      whatHappened: `Research completed with ${researchBranches.receiptBackedBranches} receipt-backed ${researchBranches.receiptBackedBranches === 1 ? 'finding' : 'findings'} and ${incomplete} limited ${incomplete === 1 ? 'branch' : 'branches'}.`,
      why: `Recorded branch reasons: ${researchBranchReasonText(researchBranches)}.${researchBranchPlanText(researchBranches) ? ` ${researchBranchPlanText(researchBranches)}` : ''}`,
      // This is intentionally not the generic terminal-failure impact: the
      // durable root result remains valid at its recorded trust state.
      impact: 'The completed receipt-backed finding remains available; failed, timed-out, or skipped branches are limitations, not discarded evidence.',
      howToFix: safeActionInstruction(researchBranches.safeAction),
    };
  }
  if (!incident) {
    return {
      state: 'healthy',
      whatHappened: summary.selectedPlan
        ? `The ${summary.selectedPlan.tier.replace('_', ' ')} plan completed its recorded Ask path.`
        : 'The Ask completed without a terminal incident.',
      why: `The stored decision summary ${summary.summaryFingerprint.slice(0, 12)} recorded the selected plan and tier decisions.`,
      impact: summary.selectedPlan?.reviewRequired
        ? summary.selectedPlan.tier === 'semantic'
          ? 'The result requires review because semantic execution used an inferred business or dimension mapping.'
          : summary.selectedPlan.tier === 'exploratory_sql'
            ? 'The result is review-required because it used exploratory SQL.'
            : 'The result is review-required because the selected plan requires review.'
        : 'The recorded result retains its selected trust state.',
      howToFix: 'No recovery action is required.',
    };
  }
  const action = safeActionInstruction(incident.safeAction);
  return {
    state: 'attention',
    whatHappened: incident.code === 'INTERNAL_EXPLORATORY_AUTHORIZATION_STATE_MISMATCH'
      ? 'ZLens rejected an inconsistent exploratory SQL authorization receipt before execution.'
      : `The Ask stopped at ${incident.boundary.replace('.', ' ')}.`,
    why: `Recorded origin: ${incident.origin.replace('_', ' ')}; impact: ${incident.impact.replace(/_/g, ' ')}.`,
    impact: incident.impact === 'execution_not_attempted'
      ? 'No SQL execution was attempted for this Ask run.'
      : 'No accepted data answer was completed for this Ask run.',
    howToFix: action,
  };
}

function safeActionInstruction(action: NonNullable<AskTraceDataV1['decisionSummary']>['safeNextAction']): string {
  return action === 'export_redacted_trace'
    ? 'Export the redacted trace and share the recorded SQL authorization incident with ZLens support.'
    : action === 'configure_connection'
      ? 'Configure the selected database connection, then retry the same Ask.'
      : action === 'change_authorized_connection'
        ? 'Choose an authorized connection that contains the recorded governed relation, then retry the same Ask.'
        : action === 'retry_same_plan'
          ? 'Retry the same frozen plan after the recorded condition is resolved.'
          : action === 'edit_dql'
            ? 'Edit the recorded governed DQL or semantic mapping, then retry the same Ask.'
            : action === 'open_sql_notebook'
              ? 'Open a SQL notebook to inspect the compiler-ready plan, correct it, then retry the same Ask.'
              : action === 'refresh_snapshot'
                ? 'Refresh the recorded local snapshot, then retry the same Ask.'
                : action === 'reapply_semantic_runtime'
                  ? 'Reapply the configured semantic runtime for the frozen plan, then retry the same Ask.'
                  : action === 'request_access'
                    ? 'Request access to the recorded governed source, then retry the same Ask.'
                    : action === 'review_analytical_failure'
                      ? 'Review the recorded analytical failure before changing the frozen plan.'
                      : action === 'inspect_research_failures'
                        ? 'Inspect the failed or timed-out Research branches, then retry a narrower Research question if the missing evidence still matters.'
                      : action === 'none'
                        ? 'No automatic recovery is safe for this run.'
                        : 'Inspect the recorded decision and advanced evidence before retrying.';
}

function researchBranchReasonText(summary: NonNullable<NonNullable<AskTraceDataV1['decisionSummary']>['researchBranchSummary']>): string {
  const reasons = summary.failureReasons
    .map((entry) => `${entry.code.replace(/_/g, ' ')}: ${entry.branchCount}`)
    .join(' · ');
  return reasons || 'limited child branches were recorded without a displayable failure reason';
}

function researchBranchPlanText(summary: NonNullable<NonNullable<AskTraceDataV1['decisionSummary']>['researchBranchSummary']>): string | undefined {
  if (summary.availableChildPlans.length === 0) return undefined;
  return `Persisted child plans: ${summary.availableChildPlans
    .map((plan) => `${plan.tier.replace(/_/g, ' ')} frozen ×${plan.frozenPlanCount} for ${plan.branchCount} ${plan.branchCount === 1 ? 'branch' : 'branches'}${plan.reviewRequired ? ' (review required)' : ''}`)
    .join(' · ')}.`;
}

/**
 * Advanced V8 evidence is intentionally a compact structured audit: opaque
 * qualified IDs, reason codes, fingerprints, and durations only. It never
 * renders prompts, SQL/DQL text, rows, provider content, credentials, or
 * chain-of-thought.
 */
function V2AdvancedDecisionEvidence({
  receipt,
  t,
}: {
  receipt: NonNullable<AskTraceDataV1['runtimeReceiptV8']>;
  t: Theme;
}): JSX.Element {
  const entries = receipt.observations.map((observation, index) => ({
    sequence: index + 1,
    tool: observation.tool,
    outcome: observation.outcome,
    tier: observation.tier,
    reasonCode: observation.reasonCode,
    candidateIds: observation.candidateIds,
    planId: observation.planId,
    frozen: observation.frozen,
    retryable: observation.retryable,
    safeAction: observation.safeAction,
    durationMs: observation.durationMs,
    inputFingerprint: observation.inputFingerprint,
    outputFingerprint: observation.outputFingerprint,
    origin: observation.origin,
    provider: observation.provider && {
      phase: observation.provider.phase,
      cause: observation.provider.cause,
      retryable: observation.provider.retryable,
      safeAction: observation.provider.safeAction,
    },
  }));
  return (
    <section aria-label="V2 advanced decision evidence" style={{ margin: '0 0 14px', padding: '12px 13px', border: `1px solid ${t.cellBorder}`, borderRadius: 9, background: t.cellBg }}>
      <div style={{ color: t.textSecondary, fontSize: 12, fontWeight: 750 }}>V2 tool-runtime evidence</div>
      <div style={{ marginTop: 4, color: t.textMuted, fontSize: 11.5, lineHeight: 1.45 }}>
        Qualified IDs, source state, reason codes, structural fingerprints, and timings only. SQL/DQL text, result rows, prompts, credentials, provider responses, and hidden reasoning are not retained.
      </div>
      <pre style={{ margin: '10px 0 0', padding: 10, overflow: 'auto', maxHeight: 340, borderRadius: 7, background: t.appBg, color: t.textSecondary, fontSize: 10.5, lineHeight: 1.45, fontFamily: t.fontMono }}>
        {JSON.stringify({
          version: receipt.version,
          mode: receipt.mode,
          snapshotId: receipt.snapshotId,
          contextCoverage: receipt.contextCoverage,
          exclusions: {
            count: receipt.excludedCandidateCount,
            reasonCodes: receipt.exclusionReasonCodes,
          },
          tierAttempts: receipt.tierAttempts,
          planFrozen: receipt.planFrozen,
          terminalOutcome: receipt.terminalOutcome,
          outcome: receipt.outcome,
          activity: receipt.activity,
          toolDurationMs: receipt.toolDurationMs,
          finalStopReason: receipt.finalStopReason,
          observations: entries,
        }, null, 2)}
      </pre>
    </section>
  );
}

/** The default top-to-bottom story for V4 runs. Old traces remain readable. */
export function TraceDecisionStory({ trace, t, onSelectSpan: _onSelectSpan }: { trace: AskTraceDataV1; t: Theme; onSelectSpan: (spanId: string) => void }): JSX.Element {
  const pipeline = explanationForTrace(trace);
  if (pipeline) return <AskRunTraceSummary explanation={pipeline} t={t} />;
  const runtimeV8 = trace.runtimeReceiptV8;
  if (runtimeV8?.mode === 'authoritative_v2') {
    const terminal = runtimeV8.terminalOutcome;
    const attention = Boolean(terminal && terminal.kind !== 'finish_answer');
    const coverage = runtimeV8.contextCoverage.length > 0
      ? runtimeV8.contextCoverage.map((entry) => `${entry.source.replace(/_/g, ' ')}: ${entry.status} (${entry.admittedCandidateCount} admitted${entry.excludedCandidateCount ? `, ${entry.excludedCandidateCount} outside workspace` : ''})`).join(' · ')
      : 'No retrieval source coverage was retained for this older V2 run.';
    // V8 activity is the one canonical counter source for compact prose. It
    // is populated by the server's physical provider-egress wrapper, so a
    // planner/provider observation cannot make the trace claim a send.
    const toolCalls = runtimeV8.activity?.toolCalls ?? runtimeV8.observations.length;
    const providerCalls = runtimeV8.activity?.providerDispatches ?? 0;
    const executionAttempts = runtimeV8.activity?.executionAttempts ?? runtimeV8.outcome.executionAttempts;
    const repairs = runtimeV8.activity?.repairs ?? 0;
    const validation = runtimeV8.observations.filter((entry) => entry.origin === 'validation' || entry.outcome === 'ineligible' || entry.outcome === 'ambiguous' || entry.outcome === 'unavailable');
    const corrections = runtimeV8.observations.filter((entry) => entry.retryable).length;
    const selectedTier = runtimeV8.tierAttempts.find((entry) => entry.frozen)?.tier
      ?? runtimeV8.tierAttempts.find((entry) => entry.outcome === 'executed')?.tier
      ?? runtimeV8.controllerTier;
    const sections: Array<[string, string]> = [
      ['Objective', `${runtimeV8.objective.replace(/_/g, ' ')} turn · ${runtimeV8.mode.replace(/_/g, ' ')} runtime.`],
      ['Context coverage', `${coverage}${runtimeV8.excludedCandidateCount ? ` Total workspace exclusions: ${runtimeV8.excludedCandidateCount} (${runtimeV8.exclusionReasonCodes.map((code) => code.replace(/_/g, ' ').toLowerCase()).join(', ')}).` : ''}`],
      ['LLM & tool decisions', `${toolCalls} tool call${toolCalls === 1 ? '' : 's'} · ${providerCalls} physical provider dispatch${providerCalls === 1 ? '' : 'es'} · ${runtimeV8.expansionCount} same-snapshot expansion${runtimeV8.expansionCount === 1 ? '' : 's'}.`],
      ['Validation & correction', `${validation.length} validation/coverage observation${validation.length === 1 ? '' : 's'} · ${Math.max(corrections, repairs)} bounded correction${Math.max(corrections, repairs) === 1 ? '' : 's'}.`],
      ['Cascade & freeze', `${runtimeV8.tierAttempts.length} ordered tier attempt${runtimeV8.tierAttempts.length === 1 ? '' : 's'} · ${selectedTier?.replace(/_/g, ' ') ?? 'no executable tier'}${runtimeV8.planFrozen ? ' · frozen' : ' · not frozen'}.`],
      ['Connection & execution', `${runtimeV8.outcome.connectionAttempted ? 'connection attempted' : 'no connection attempted'} · ${executionAttempts} execution attempt${executionAttempts === 1 ? '' : 's'}.`],
      ['Facts & narration', `${runtimeV8.outcome.factCount} validated fact${runtimeV8.outcome.factCount === 1 ? '' : 's'} · ${runtimeV8.outcome.narration.replace(/_/g, ' ')}.`],
      ['Failure boundary', terminal
        ? `${terminal.origin.replace(/_/g, ' ')} · ${terminal.kind.replace(/_/g, ' ')} · ${terminal.reasonCode.replace(/_/g, ' ').toLowerCase()}.`
        : 'No terminal failure was retained.'],
      ['Safe next action', terminal?.safeAction
        ? safeActionInstruction(terminal.safeAction as Parameters<typeof safeActionInstruction>[0])
        : 'Inspect the validated result or continue with a grounded follow-up.'],
    ];
    return (
      <section aria-label="Ask decision story" style={{ margin: '0 0 14px', padding: '14px 16px', border: `1px solid ${attention ? t.warning : t.success}`, borderRadius: 11, background: t.cellBg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: attention ? t.warning : t.success, fontSize: 13, fontWeight: 750 }}>
          {attention ? <AlertTriangle size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
          Ask decision story
          <span style={{ color: t.textMuted, fontFamily: t.fontMono, fontSize: 10.5, fontWeight: 500 }}>V8 · {runtimeV8.snapshotId ? shortId(runtimeV8.snapshotId) : 'snapshot unavailable'}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 11, marginTop: 12 }}>
          {sections.map(([label, value]) => (
            <div key={label} style={{ minWidth: 0 }}>
              <div style={{ color: t.textMuted, fontSize: 10.5, fontWeight: 750, letterSpacing: '.025em', textTransform: 'uppercase' }}>{label}</div>
              <div style={{ marginTop: 4, color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>{value}</div>
            </div>
          ))}
        </div>
      </section>
    );
  }
  const runtime = trace.runtimeDecisionSummary;
  const runtimeV6 = trace.runtimeReceiptV6;
  if (runtime) {
    const attention = /did not complete|paused|blocked/i.test(runtime.whatHappened);
    const roleCoverage = runtimeV6?.roleCoverage?.length
      ? runtimeV6.roleCoverage.map((entry) => `${entry.role.replace(/_/g, ' ')}: ${entry.candidateCount}`).join(' · ')
      : undefined;
    const planner = runtimeV6?.planning;
    const cascade = runtimeV6?.cascade;
    const sections: Array<[string, string]> = [
          ['What happened', runtime.whatHappened],
          ['Why', runtime.why],
          ['Impact', runtime.impact],
          ['Role coverage', roleCoverage ?? `${runtime.admittedCandidateCount} qualified candidate${runtime.admittedCandidateCount === 1 ? '' : 's'} admitted.`],
          ['Planner & verification', planner
            ? `${planner.mode.replace(/_/g, ' ')} · ${planner.plannerCalls} planner call${planner.plannerCalls === 1 ? '' : 's'} · verification ${planner.verification.status.replace(/_/g, ' ')}.`
            : `${runtime.runtimeMode} · ${runtime.programTaskCount} task${runtime.programTaskCount === 1 ? '' : 's'} · deterministic receipt.`],
          ['Cascade & freeze', cascade
            ? `${cascade.attempts.length} tier attempt${cascade.attempts.length === 1 ? '' : 's'} · ${cascade.selectedTier?.replace(/_/g, ' ') ?? 'no executable tier'}${cascade.planFrozen ? ' · frozen' : ' · not frozen'}.`
            : `${runtime.selectedCompiler ?? 'none'} · no cascade receipt.`],
          ['Connection & execution', runtimeV6
            ? `${runtimeV6.connection.attempted ? 'connection attempted after freeze' : 'no connection attempted'} · ${runtimeV6.execution.attempts} execution attempt${runtimeV6.execution.attempts === 1 ? '' : 's'}.`
            : `${runtime.selectedCompiler ?? 'none'} · ${runtime.executionAttempts} execution attempt${runtime.executionAttempts === 1 ? '' : 's'}.`],
          ['Facts', runtimeV6
            ? `${runtimeV6.facts.factCount} validated fact${runtimeV6.facts.factCount === 1 ? '' : 's'}${runtimeV6.facts.resultFingerprint ? ' bound to the result.' : '.'}`
            : 'No V6 fact receipt was retained.'],
          ...(runtimeV6?.origin
            ? [['Origin boundary', `${runtimeV6.origin.boundary.replace(/_/g, ' ')} · ${runtimeV6.origin.origin.replace(/_/g, ' ')} · ${runtimeV6.origin.impact.replace(/_/g, ' ')}.`] as [string, string]]
            : []),
          ...(runtimeV6?.story?.length
            ? [['Decision path', runtimeV6.story.map((step) => `${step.stage.replace(/_/g, ' ')}: ${step.status.replace(/_/g, ' ')}`).join(' · ')] as [string, string]]
            : []),
          ['Safe next action', safeActionInstruction(runtimeV6?.safeNextAction ?? runtime.nextAction)],
        ];
    return (
      <section aria-label="Ask decision story" style={{ margin: '0 0 14px', padding: '14px 16px', border: `1px solid ${attention ? t.warning : t.success}`, borderRadius: 11, background: t.cellBg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: attention ? t.warning : t.success, fontSize: 13, fontWeight: 750 }}>
          {attention ? <AlertTriangle size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
          Ask decision story
          <span style={{ color: t.textMuted, fontFamily: t.fontMono, fontSize: 10.5, fontWeight: 500 }}>#{runtime.summaryFingerprint.slice(0, 12)}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 11, marginTop: 12 }}>
          {sections.map(([label, value]) => (
            <div key={label} style={{ minWidth: 0 }}>
              <div style={{ color: t.textMuted, fontSize: 10.5, fontWeight: 750, letterSpacing: '.025em', textTransform: 'uppercase' }}>{label}</div>
              <div style={{ marginTop: 4, color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>{value}</div>
            </div>
          ))}
        </div>
      </section>
    );
  }
  const summary = trace.decisionSummary;
  if (!summary) {
    return (
      <section aria-label="Ask decision story unavailable" style={{ margin: '0 0 14px', padding: '14px 16px', border: `1px solid ${t.warning}`, borderRadius: 11, background: t.cellBg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: t.warning, fontSize: 13, fontWeight: 750 }}>
          <AlertTriangle size={15} aria-hidden="true" /> Ask decision story
        </div>
        <p style={{ margin: '8px 0 0', color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>
          {CANONICAL_DECISION_SUMMARY_UNAVAILABLE}.
        </p>
        <p style={{ margin: '4px 0 0', color: t.textMuted, fontSize: 11.5, lineHeight: 1.45 }}>
          This trace predates the stored canonical summary. Raw stages remain available only in Advanced evidence.
        </p>
      </section>
    );
  }
  const request = summary.understoodRequest;
  const researchBranches = summary.researchBranchSummary;
  const researchLimited = researchBranches?.partialSuccess === true;
  const researchEvidence = researchBranches
    ? `${researchBranches.receiptBackedBranches} receipt-backed ${researchBranches.receiptBackedBranches === 1 ? 'finding' : 'findings'} · ${researchBranches.failedBranches} failed · ${researchBranches.timedOutBranches} timed out · ${researchBranches.skippedBranches} skipped. Reasons: ${researchBranchReasonText(researchBranches)}. ${researchBranchPlanText(researchBranches) ?? 'No frozen child plan evidence was retained.'} ${researchBranches.linkedChildRunCount} linked child ${researchBranches.linkedChildRunCount === 1 ? 'run' : 'runs'}.`
    : undefined;
  const sections: Array<[string, string]> = [
    ['Understood request', `${request.measures} measure${request.measures === 1 ? '' : 's'}, ${request.dimensions} dimension${request.dimensions === 1 ? '' : 's'}${request.entityRequested ? ', an entity output' : ''}${request.ranking ? `, ${request.ranking.direction} ${request.ranking.limit}${request.ranking.defaultedLimit ? ' (default)' : ''}` : ''}. Conversation binding: ${request.conversationBinding.replace(/_/g, ' ')}.`],
    ['Evidence by role', summary.evidenceByRole.length > 0
      ? summary.evidenceByRole.map((entry) => `${entry.role.replace(/_/g, ' ')}: ${entry.candidateCount}`).join(' · ')
      : 'No role evidence was retained for this run.' ],
    ['Tier decisions', summary.tierDecisions.length > 0
      ? summary.tierDecisions.map((entry) => `${entry.tier}: ${entry.outcome}${entry.planFrozen ? ' (frozen)' : ''}`).join(' · ')
      : 'No cascade tier receipt was recorded.' ],
    ['Selected plan', summary.selectedPlan
      ? `${summary.selectedPlan.tier.replace('_', ' ')}${summary.selectedPlan.planFrozen ? ' frozen' : ''}${summary.selectedPlan.reviewRequired ? '; review required' : ''}.`
      : 'No executable plan was selected.' ],
    ...(researchEvidence ? [['Research branch evidence', researchEvidence] as [string, string]] : []),
    ['Failure or repair', summary.terminalIncident
      ? `${summary.terminalIncident.code.replace(/_/g, ' ')} at ${summary.terminalIncident.boundary}; ${summary.terminalIncident.impact.replace(/_/g, ' ')}.`
      : researchLimited
        ? `Research limitations: ${researchBranches!.failedBranches + researchBranches!.timedOutBranches + researchBranches!.skippedBranches} child branches did not complete; completed receipt-backed findings remain available.`
        : 'No terminal incident was recorded.' ],
    ['Safe next action', safeActionInstruction(summary.safeNextAction)],
  ];
  const issue = Boolean(summary.terminalIncident || researchLimited);
  return (
    <section aria-label="Ask decision story" style={{ margin: '0 0 14px', padding: '14px 16px', border: `1px solid ${issue ? t.warning : t.success}`, borderRadius: 11, background: t.cellBg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: issue ? t.warning : t.success, fontSize: 13, fontWeight: 750 }}>
        {issue ? <AlertTriangle size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
        Ask decision story
        <span style={{ color: t.textMuted, fontFamily: t.fontMono, fontSize: 10.5, fontWeight: 500 }}>#{summary.summaryFingerprint.slice(0, 12)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 11, marginTop: 12 }}>
        {sections.map(([label, value]) => (
          <div key={label} style={{ minWidth: 0 }}>
            <div style={{ color: t.textMuted, fontSize: 10.5, fontWeight: 750, letterSpacing: '.025em', textTransform: 'uppercase' }}>{label}</div>
            <div style={{ marginTop: 4, color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>{value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function prioritizedIssueForTrace(trace: AskTraceDataV1): AskTraceSpanV1 | undefined {
  const postFreeze = trace.spans
    .filter((span) => isIssueSpanForTrace(span) && isPostFreezePhysicalFailureForTrace(trace, span))
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  if (postFreeze) return postFreeze;

  const terminalCascade = terminalCascadeForTrace(trace)?.span;
  if (terminalCascade) return terminalCascade;

  const persisted = trace.envelope.firstIssueSpanId
    ? trace.spans.find((span) => span.spanId === trace.envelope.firstIssueSpanId)
    : undefined;
  if (persisted && isIssueSpanForTrace(persisted) && !isRecoverableCascadeAttemptForTrace(persisted)) return persisted;

  return trace.spans
    .filter((span) => isIssueSpanForTrace(span) && !isRecoverableCascadeAttemptForTrace(span))
    .sort((left, right) => right.ordinal - left.ordinal)[0];
}

function isIssueSpanForTrace(span: AskTraceSpanV1): boolean {
  if (span.outcome === 'error' || span.outcome === 'denied' || span.outcome === 'unavailable' || span.outcome === 'interrupted' || span.outcome === 'cancelled') return true;
  return span.outcome === 'skipped' && [
    'meaning_rejected', 'snapshot_unavailable', 'source_stale', 'source_unavailable', 'cascade_ambiguous',
    'cascade_unavailable', 'cascade_denied', 'post_freeze_failure', 'provider_failure', 'tool_failure',
    'sql_denied', 'sql_failure', 'execution_failed', 'cancelled', 'interrupted', 'recording_failure', 'cap_reached',
  ].includes(span.reasonCode);
}

function isRecoverableCascadeAttemptForTrace(span: AskTraceSpanV1): boolean {
  if (span.stage !== 'cascade' || !span.name.startsWith('cascade.') || span.name === 'cascade.evaluate' || span.name === 'cascade.clarify_or_gap') return false;
  if (span.outcome !== 'unavailable' && !(span.outcome === 'skipped' && span.reasonCode === 'cascade_ineligible')) return false;
  const decision = cascadeDecisionRecord(span);
  const selectedTier = decision?.selectedTier;
  const attempt = Array.isArray(decision?.attempts) ? decision?.attempts[0] : undefined;
  const attemptOutcome = attempt && typeof attempt === 'object' ? (attempt as Record<string, unknown>).outcome : undefined;
  return decision?.stopReason === 'selected'
    && typeof selectedTier === 'string'
    && selectedTier !== cascadeTierForSpan(span.name)
    && (attemptOutcome === 'unavailable' || attemptOutcome === 'ineligible');
}

function isPostFreezePhysicalFailureForTrace(trace: AskTraceDataV1, span: AskTraceSpanV1): boolean {
  if (span.reasonCode === 'post_freeze_failure') return true;
  if (span.stage !== 'provider' && span.stage !== 'tool' && span.stage !== 'sql' && span.stage !== 'result') return false;
  return trace.spans.some((candidate) => candidate.name === 'plan.freeze' && candidate.outcome === 'ok' && candidate.ordinal < span.ordinal);
}

function cascadeTierForSpan(name: AskTraceSpanV1['name']): string | undefined {
  const tiers: Partial<Record<AskTraceSpanV1['name'], string>> = {
    'cascade.certified': 'certified',
    'cascade.semantic': 'semantic',
    'cascade.governed_relational': 'governed_relational',
    'cascade.exploratory_sql': 'exploratory_sql',
    'cascade.clarify_or_gap': 'clarify_or_gap',
  };
  return tiers[name];
}

function traceHasAcceptedTerminalResult(trace: AskTraceDataV1): boolean {
  const terminalSucceeded = trace.envelope.status === 'completed'
    && trace.envelope.terminalOutcome !== 'blocked'
    && trace.envelope.terminalOutcome !== 'needs_clarification'
    && trace.envelope.terminalOutcome !== 'cancelled';
  return terminalSucceeded && trace.spans.some((span) => span.name === 'result.normalize'
    && span.outcome === 'ok'
    && span.payload.kind === 'result'
    && typeof span.payload.resultFingerprint === 'string'
    && /^(?:sha256:)?[a-f0-9]{64}$/i.test(span.payload.resultFingerprint));
}

function postFreezeSemanticFailureForTrace(
  trace: AskTraceDataV1,
  issue: AskTraceSpanV1 | undefined,
): { span: AskTraceSpanV1; failureCode?: string; safeAction?: string } | undefined {
  if (!issue || issue.name !== 'result.normalize' || issue.reasonCode !== 'post_freeze_failure' || issue.payload.kind !== 'result') return undefined;
  const frozenSemantic = trace.spans.some((span) => span.name === 'plan.freeze'
    && span.outcome === 'ok'
    && cascadeDecisionRecord(span)?.selectedTier === 'semantic');
  if (!frozenSemantic) return undefined;
  return {
    span: issue,
    ...(typeof issue.payload.failureCode === 'string' ? { failureCode: issue.payload.failureCode } : {}),
    ...(typeof issue.payload.safeAction === 'string' ? { safeAction: issue.payload.safeAction } : {}),
  };
}

function postFreezeConnectionConfigurationFailureForTrace(
  trace: AskTraceDataV1,
  issue: AskTraceSpanV1 | undefined,
): { span: AskTraceSpanV1; tier?: string } | undefined {
  if (!issue
    || issue.name !== 'result.normalize'
    || issue.reasonCode !== 'post_freeze_failure'
    || issue.payload.kind !== 'result'
    || issue.payload.failureCode !== 'CONNECTION_NOT_CONFIGURED') return undefined;
  const freeze = trace.spans
    .filter((span) => span.name === 'plan.freeze' && span.outcome === 'ok' && span.ordinal < issue.ordinal)
    .sort((left, right) => right.ordinal - left.ordinal)[0];
  if (!freeze) return undefined;
  const selectedTier = cascadeDecisionRecord(freeze)?.selectedTier;
  return {
    span: issue,
    ...(typeof selectedTier === 'string' ? { tier: selectedTier } : {}),
  };
}

function semanticFailureReason(code: string | undefined): string {
  const labels: Record<string, string> = {
    COMPILATION_FAILED: 'semantic compilation failed (COMPILATION_FAILED)',
    SEMANTIC_ADAPTER_NOT_READY: 'the required semantic layer was unavailable (SEMANTIC_ADAPTER_NOT_READY)',
    SEMANTIC_TARGET_BINDING_MISSING: 'the semantic execution target was unavailable (SEMANTIC_TARGET_BINDING_MISSING)',
    EXECUTION_TARGET_MISMATCH: 'the semantic execution target did not match the frozen plan (EXECUTION_TARGET_MISMATCH)',
    SEMANTIC_SOURCE_DRIFT: 'the semantic source drifted after planning (SEMANTIC_SOURCE_DRIFT)',
    SEMANTIC_MEMBER_BINDING_FAILED: 'a semantic member could not bind to the frozen plan (SEMANTIC_MEMBER_BINDING_FAILED)',
    SEMANTIC_PATH_AMBIGUOUS: 'the semantic relationship path remained ambiguous (SEMANTIC_PATH_AMBIGUOUS)',
    SEMANTIC_COMPILATION_TIMEOUT: 'semantic compilation timed out (SEMANTIC_COMPILATION_TIMEOUT)',
  };
  return code && labels[code] ? labels[code]! : 'the typed semantic execution stage failed';
}

function semanticFailureSafeAction(action: string | undefined): string {
  const labels: Record<string, string> = {
    inspect_failure: 'inspect the typed failure',
    retry_same_plan: 'retry the same frozen plan',
    retry_same_request: 'retry the same request',
    refresh_snapshot: 'refresh the local snapshot',
    edit_dql: 'edit the governed DQL or semantic mapping',
    open_sql_notebook: 'open the SQL Notebook for review',
    request_access: 'request access to the authorized execution target',
    change_authorized_connection: 'change the authorized connection',
    configure_connection: 'configure a database connection',
    reapply_semantic_runtime: 'reapply the semantic runtime',
    review_analytical_failure: 'review the analytical failure',
  };
  return action && labels[action] ? labels[action]! : 'inspect the typed failure';
}

type TraceCascadeTerminalV1 = {
  span: AskTraceSpanV1;
  decision: {
    stopReason: 'selected' | 'ambiguous' | 'coverage_gap' | 'denied' | 'post_freeze_failure';
    requiresDeclaredFiscalCalendar: boolean;
    terminalGap?: {
      code: 'MISSING_RELATIONSHIP';
      requirement: 'certified_relationship_or_allocation_proof';
    };
  };
};

function terminalRelationshipGapForTrace(
  trace: AskTraceDataV1,
  issue: AskTraceSpanV1 | undefined,
): TraceCascadeTerminalV1 | undefined {
  const issueCascade = issue ? terminalCascadeFromSpan(issue) : undefined;
  if (issueCascade?.decision.terminalGap) return issueCascade;
  const terminal = terminalCascadeForTrace(trace);
  if (terminal?.decision.terminalGap) return terminal;
  return trace.spans
    .flatMap((span) => {
      const candidate = terminalCascadeFromSpan(span);
      return candidate?.decision.terminalGap ? [candidate] : [];
    })
    .sort((left, right) => right.span.ordinal - left.span.ordinal)
    .find((candidate) => candidate.span.name === 'cascade.evaluate')
    ?? trace.spans
      .flatMap((span) => {
        const candidate = terminalCascadeFromSpan(span);
        return candidate?.decision.terminalGap ? [candidate] : [];
      })
      .sort((left, right) => right.span.ordinal - left.span.ordinal)[0];
}

function terminalCascadeForTrace(trace: AskTraceDataV1): TraceCascadeTerminalV1 | undefined {
  const candidates = trace.spans
    .flatMap((span) => {
      const terminal = terminalCascadeFromSpan(span);
      return terminal ? [terminal] : [];
    })
    .sort((left, right) => right.span.ordinal - left.span.ordinal);
  // A stale/missing first-issue pointer must not let a recoverable
  // pre-freeze attempt eclipse the actual terminal cascade decision carried by
  // the typed API payload.
  const fiscal = candidates.find((candidate) => candidate.decision.stopReason === 'ambiguous' && candidate.decision.requiresDeclaredFiscalCalendar);
  if (fiscal) return fiscal;
  return candidates.find((candidate) => candidate.span.name === 'cascade.clarify_or_gap')
    ?? candidates.find((candidate) => candidate.span.name === 'cascade.evaluate')
    ?? candidates[0];
}

function fiscalClarificationForTrace(trace: AskTraceDataV1, issue: AskTraceSpanV1 | undefined): TraceCascadeTerminalV1 | undefined {
  const selected = issue ? terminalCascadeFromSpan(issue) : undefined;
  if (selected?.decision.stopReason === 'ambiguous' && selected.decision.requiresDeclaredFiscalCalendar) return selected;
  const candidates = trace.spans
    .flatMap((span) => {
      const terminal = terminalCascadeFromSpan(span);
      return terminal ? [terminal] : [];
    })
    .filter((candidate) => candidate.decision.stopReason === 'ambiguous' && candidate.decision.requiresDeclaredFiscalCalendar)
    .sort((left, right) => right.span.ordinal - left.span.ordinal);
  return candidates.find((candidate) => candidate.span.name === 'cascade.clarify_or_gap') ?? candidates[0];
}

function terminalCascadeFromSpan(span: AskTraceSpanV1): TraceCascadeTerminalV1 | undefined {
  const decision = cascadeDecision(span);
  return decision && decision.stopReason !== 'selected' ? { span, decision } : undefined;
}

function cascadeDecision(span: AskTraceSpanV1): TraceCascadeTerminalV1['decision'] | undefined {
  const record = cascadeDecisionRecord(span);
  if (!record) return undefined;
  const stopReason = record.stopReason;
  if (stopReason !== 'selected' && stopReason !== 'ambiguous' && stopReason !== 'coverage_gap' && stopReason !== 'denied' && stopReason !== 'post_freeze_failure') return undefined;
  const terminalGap = terminalRelationshipGapFromRecord(record);
  return {
    stopReason,
    requiresDeclaredFiscalCalendar: record.requiresDeclaredFiscalCalendar === true,
    ...(terminalGap ? { terminalGap } : {}),
  };
}

function terminalRelationshipGapFromRecord(record: Record<string, unknown>): TraceCascadeTerminalV1['decision']['terminalGap'] | undefined {
  const value = record.terminalGap;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const gap = value as Record<string, unknown>;
  if (gap.code !== 'MISSING_RELATIONSHIP'
    || gap.requirement !== 'certified_relationship_or_allocation_proof') return undefined;
  return {
    code: 'MISSING_RELATIONSHIP',
    requirement: 'certified_relationship_or_allocation_proof',
  };
}

function cascadeDecisionRecord(span: AskTraceSpanV1): Record<string, unknown> | undefined {
  if (span.payload.kind !== 'cascade') return undefined;
  const payload = span.payload as Record<string, unknown>;
  const nested = payload.decision;
  // `decision` is the current local runtime wire shape. The flat fallback
  // keeps V1 readers safe for a previously serialized, allowlisted cascade
  // payload without treating arbitrary payloads as a decision.
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested as Record<string, unknown>;
  return payload;
}

function TraceIncidentSummary({ trace, t, onSelectSpan }: { trace: AskTraceDataV1; t: Theme; onSelectSpan: (spanId: string) => void }): JSX.Element {
  const summary = incidentSummaryForTrace(trace);
  const sections: Array<[string, string]> = [
    ['What happened', summary.whatHappened],
    ['Why', summary.why],
    ['Impact on answer', summary.impact],
    ['How to fix', summary.howToFix],
  ];
  const issueColor = summary.state === 'attention' ? t.warning : t.success;
  return (
    <section aria-label="Ask incident summary" style={{ margin: '0 0 14px', padding: '14px 16px', border: `1px solid ${issueColor}`, borderRadius: 11, background: t.cellBg }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: issueColor, fontSize: 13, fontWeight: 750 }}>
          {summary.state === 'attention' ? <AlertTriangle size={15} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
          {summary.state === 'attention' ? 'Answer incident summary' : 'Answer completion summary'}
        </div>
        {summary.spanId ? (
          <button type="button" onClick={() => onSelectSpan(summary.spanId!)} style={secondaryButtonStyle(t)}>
            View related stage
          </button>
        ) : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 11, marginTop: 12 }}>
        {sections.map(([label, value]) => (
          <div key={label} style={{ minWidth: 0 }}>
            <div style={{ color: t.textMuted, fontSize: 10.5, fontWeight: 750, letterSpacing: '.025em', textTransform: 'uppercase' }}>{label}</div>
            <div style={{ marginTop: 4, color: t.textSecondary, fontSize: 12, lineHeight: 1.45 }}>{value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function providerIncident(span: AskTraceSpanV1): { cause: string; safeAction: string } | undefined {
  if (span.payload.kind !== 'provider') return undefined;
  const attempt = span.payload.attempt as Record<string, unknown>;
  const cause = knownProviderCause(attempt.cause);
  if (!cause) return undefined;
  return { cause: providerCauseLabel(cause), safeAction: providerSafeAction(attempt.safeAction) };
}

function cascadeUnavailableSources(span: AskTraceSpanV1 | undefined): string[] {
  const decision = span ? cascadeDecisionRecord(span) : undefined;
  if (!decision) return [];
  const sourceCoverage = Array.isArray(decision.sourceCoverage) ? decision.sourceCoverage : [];
  return sourceCoverage.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const source = knownCoverageSource(record.source);
    const status = record.status;
    return source && (status === 'unavailable' || status === 'errored' || status === 'stale') ? [source] : [];
  });
}

function knownProviderCause(value: unknown): string | undefined {
  const known = new Set(['authentication', 'model_not_found', 'rate_limited', 'gateway', 'network', 'provider_timeout', 'run_deadline', 'admission_denied', 'dispatch_budget', 'cancelled', 'unknown']);
  return typeof value === 'string' && known.has(value) ? value : undefined;
}

function providerCauseLabel(cause: string): string {
  const labels: Record<string, string> = {
    authentication: 'authentication is not ready', model_not_found: 'the selected model is unavailable', rate_limited: 'the provider rate limit was reached', gateway: 'the provider gateway failed', network: 'the provider network request failed', provider_timeout: 'the provider timed out', run_deadline: 'the Ask run reached its deadline', admission_denied: 'provider admission was denied', dispatch_budget: 'the dispatch budget was exhausted', cancelled: 'the run was cancelled', unknown: 'an unknown provider condition occurred',
  };
  return labels[cause] ?? 'an unknown provider condition occurred';
}

function providerSafeAction(value: unknown): string {
  const actions: Record<string, string> = {
    retry_same_provider: 'Retry once with the same configured provider when the recorded retry policy allows it.',
    fix_provider_configuration: 'Check the configured provider credentials and selected model, then retry.',
    wait_and_retry: 'Wait for the provider limit to clear, then retry with the same provider.',
    inspect_run: 'Inspect the related stage and local provider readiness evidence before retrying.',
    none: 'No automatic recovery is safe. Inspect the related stage before changing configuration.',
  };
  return typeof value === 'string' && actions[value] ? actions[value]! : 'Inspect the related stage and local provider readiness evidence before retrying.';
}

function knownCoverageSource(value: unknown): string | undefined {
  const labels: Record<string, string> = {
    certified: 'certified saved queries', semantic: 'semantic models', dbt_manifest: 'dbt manifest', runtime_schema: 'runtime schema', vector: 'local vector index', graph: 'relationship graph', conversation: 'conversation context', business: 'business context', safe_value: 'safe value lookup', relational: 'governed relationships',
  };
  return typeof value === 'string' ? labels[value] : undefined;
}

function TraceTree({
  trace, t, query, onQuery, expanded, onExpanded, selection, onSelect, isNarrow,
}: {
  trace: AskTraceDataV1;
  t: Theme;
  query: string;
  onQuery: (value: string) => void;
  expanded: Set<string>;
  onExpanded: (next: Set<string>) => void;
  selection: TraceSelection | null;
  onSelect: (next: TraceSelection) => void;
  isNarrow: boolean;
}): JSX.Element {
  const treeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tree = useMemo(() => buildSpanTree(trace.spans, trace.envelope.rootSpanId), [trace.spans, trace.envelope.rootSpanId]);
  const queryTokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchingIds = useMemo(() => new Set(trace.spans.filter((span) => spanMatches(span, queryTokens)).map((span) => span.spanId)), [trace.spans, queryTokens]);
  const visibleExpanded = useMemo(() => {
    if (!queryTokens.length) return expanded;
    const next = new Set(expanded);
    const ancestors = new Map(trace.spans.map((span) => [span.spanId, span.parentSpanId]));
    for (const id of matchingIds) {
      let current = ancestors.get(id);
      while (current) {
        next.add(current);
        current = ancestors.get(current);
      }
    }
    return next;
  }, [expanded, matchingIds, queryTokens.length, trace.spans]);
  const visibleIds = useMemo(() => flattenVisibleTree(tree, visibleExpanded, queryTokens.length ? matchingIds : undefined), [tree, visibleExpanded, queryTokens.length, matchingIds]);

  const focusRelative = (id: string, delta: number) => {
    const index = visibleIds.indexOf(id);
    const next = visibleIds[Math.max(0, Math.min(visibleIds.length - 1, index + delta))];
    if (next) treeRefs.current[next]?.focus();
  };
  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, node: TraceTreeNode) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); focusRelative(node.span.spanId, 1); }
    if (event.key === 'ArrowUp') { event.preventDefault(); focusRelative(node.span.spanId, -1); }
    if (event.key === 'ArrowRight' && node.children.length > 0) {
      event.preventDefault();
      if (!visibleExpanded.has(node.span.spanId)) onExpanded(new Set([...expanded, node.span.spanId]));
      else treeRefs.current[node.children[0]?.span.spanId]?.focus();
    }
    if (event.key === 'ArrowLeft' && node.children.length > 0 && visibleExpanded.has(node.span.spanId)) {
      event.preventDefault();
      const next = new Set(expanded); next.delete(node.span.spanId); onExpanded(next);
    } else if (event.key === 'ArrowLeft' && node.parentId) {
      event.preventDefault(); treeRefs.current[node.parentId]?.focus();
    }
    if (event.key === 'Home') { event.preventDefault(); treeRefs.current[visibleIds[0] ?? '']?.focus(); }
    if (event.key === 'End') { event.preventDefault(); treeRefs.current[visibleIds[visibleIds.length - 1] ?? '']?.focus(); }
  };

  return (
    <aside style={{ position: isNarrow ? 'static' : 'sticky', top: 0, maxHeight: isNarrow ? undefined : 'calc(100vh - 116px)', display: 'flex', flexDirection: 'column', minWidth: 0, border: `1px solid ${t.cellBorder}`, borderRadius: 11, background: t.cellBg, overflow: 'hidden' }}>
      <div style={{ padding: '11px 11px 9px', borderBottom: `1px solid ${t.cellBorder}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <strong style={{ fontSize: 12.5 }}>Trace tree</strong>
          <span style={{ color: t.textMuted, fontSize: 10.5 }}>{trace.spans.length} stages</span>
        </div>
        <label style={{ position: 'relative', display: 'block' }}>
          <Search size={13} style={{ position: 'absolute', left: 8, top: 8, color: t.textMuted }} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search stage or reason"
            aria-label="Search trace stages"
            style={{ width: '100%', boxSizing: 'border-box', padding: '7px 8px 7px 28px', borderRadius: 7, background: t.inputBg, border: `1px solid ${t.inputBorder}`, color: t.textPrimary, font: `12px ${t.font}` }}
          />
        </label>
      </div>
      <div role="tree" aria-label="Ask trace stages" style={{ overflow: 'auto', padding: '7px 5px 10px' }}>
        {tree.map((node) => (
          <TraceTreeRow
            key={node.span.spanId}
            node={node}
            depth={0}
            t={t}
            queryActive={queryTokens.length > 0}
            matches={matchingIds}
            expanded={visibleExpanded}
            persistedExpanded={expanded}
            onExpanded={onExpanded}
            selection={selection}
            onSelect={onSelect}
            onKeyDown={onTreeKeyDown}
            registerRef={(id, element) => { treeRefs.current[id] = element; }}
          />
        ))}
        {trace.candidateDecisions.length > 0 ? (
          <button
            type="button"
            role="treeitem"
            aria-selected={selection?.kind === 'candidates'}
            onClick={() => onSelect({ kind: 'candidates' })}
            style={{ ...treeButtonStyle(t, selection?.kind === 'candidates'), marginTop: 5, paddingLeft: 9 }}
          >
            <Database size={12} aria-hidden="true" /> Candidate decisions <span style={{ marginLeft: 'auto', color: t.textMuted }}>{trace.candidateDecisions.length}</span>
          </button>
        ) : null}
      </div>
    </aside>
  );
}

function TraceTreeRow({
  node, depth, t, queryActive, matches, expanded, persistedExpanded, onExpanded, selection, onSelect, onKeyDown, registerRef,
}: {
  node: TraceTreeNode;
  depth: number;
  t: Theme;
  queryActive: boolean;
  matches: Set<string>;
  expanded: Set<string>;
  persistedExpanded: Set<string>;
  onExpanded: (next: Set<string>) => void;
  selection: TraceSelection | null;
  onSelect: (next: TraceSelection) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>, node: TraceTreeNode) => void;
  registerRef: (id: string, element: HTMLButtonElement | null) => void;
}): JSX.Element | null {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.span.spanId);
  const selected = selection?.kind === 'span' && selection.spanId === node.span.spanId;
  const matchesQuery = !queryActive || matches.has(node.span.spanId) || node.children.some((child) => branchMatches(child, matches));
  if (!matchesQuery) return null;
  const toggle = (event: React.MouseEvent) => {
    event.stopPropagation();
    const next = new Set(persistedExpanded);
    if (isExpanded) next.delete(node.span.spanId); else next.add(node.span.spanId);
    onExpanded(next);
  };
  return (
    <div role="none">
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        {hasChildren ? (
          <button type="button" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${stageLabel(node.span.name)}`} aria-expanded={isExpanded} onClick={toggle} style={treeToggleStyle(t)}>
            {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : <span style={{ width: 24, flexShrink: 0 }} />}
        <button
          ref={(element) => registerRef(node.span.spanId, element)}
          id={`ask-trace-span-${node.span.spanId}`}
          type="button"
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={selected}
          aria-expanded={hasChildren ? isExpanded : undefined}
          data-trace-tree-id={node.span.spanId}
          onClick={() => onSelect({ kind: 'span', spanId: node.span.spanId })}
          onKeyDown={(event) => onKeyDown(event, node)}
          style={{ ...treeButtonStyle(t, selected), paddingLeft: 7, minHeight: 29 }}
        >
          <OutcomeIcon outcome={node.span.outcome} size={12} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{stageLabel(node.span.name)}</span>
          <span style={{ marginLeft: 'auto', fontFamily: t.fontMono, color: t.textMuted, fontSize: 9.5 }}>{formatMs(node.span.durationMs)}</span>
        </button>
      </div>
      {hasChildren && isExpanded ? (
        <div role="group" style={{ marginLeft: 13, borderLeft: `1px solid ${t.cellBorder}` }}>
          {node.children.map((child) => (
            <TraceTreeRow
              key={child.span.spanId}
              node={child}
              depth={depth + 1}
              t={t}
              queryActive={queryActive}
              matches={matches}
              expanded={expanded}
              persistedExpanded={persistedExpanded}
              onExpanded={onExpanded}
              selection={selection}
              onSelect={onSelect}
              onKeyDown={onKeyDown}
              registerRef={registerRef}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TraceDetail({ trace, t, selection, candidateOffset, onCandidateOffset, showExcluded, onShowExcluded }: {
  trace: AskTraceDataV1;
  t: Theme;
  selection: TraceSelection | null;
  candidateOffset: number;
  onCandidateOffset: (offset: number) => void;
  showExcluded: boolean;
  onShowExcluded: (show: boolean) => void;
}): JSX.Element {
  if (selection?.kind === 'candidates') {
    return <CandidateDetail trace={trace} t={t} offset={candidateOffset} onOffset={onCandidateOffset} showExcluded={showExcluded} onShowExcluded={onShowExcluded} />;
  }
  const span = trace.spans.find((item) => item.spanId === (selection?.kind === 'span' ? selection.spanId : trace.envelope.rootSpanId)) ?? trace.spans[0];
  if (!span) return <EmptyDetail t={t} />;
  return <SpanDetail trace={trace} span={span} t={t} />;
}

function SpanDetail({ trace, span, t }: { trace: AskTraceDataV1; span: AskTraceSpanV1; t: Theme }): JSX.Element {
  const attributes = useMemo(() => detailRows(span.payload), [span.payload]);
  const related = trace.spans.filter((candidate) => candidate.parentSpanId === span.spanId);
  return (
    <section aria-label={`Trace detail for ${stageLabel(span.name)}`} style={detailCardStyle(t)}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><OutcomeIcon outcome={span.outcome} size={16} /><h1 style={{ fontSize: 18, margin: 0 }}>{stageLabel(span.name)}</h1></div>
          <div style={{ color: t.textMuted, fontSize: 12, marginTop: 5 }}>Stage: {span.stage} · {outcomeText(span.outcome)} · {reasonLabel(span.reasonCode)}</div>
        </div>
        <Pill t={t} icon={<Clock3 size={12} />}>{formatMs(span.durationMs)}</Pill>
      </div>
      <DetailGrid t={t} rows={[
        ['Started', formatDate(span.startedAt)],
        ['Completed', span.completedAt ? formatDate(span.completedAt) : 'Still recording'],
        ['Span ID', shortId(span.spanId)],
        ['Parent span', span.parentSpanId ? shortId(span.parentSpanId) : 'Trace root'],
      ]} />
      <section style={subsectionStyle(t)}>
        <h2 style={sectionHeadingStyle(t)}>Recorded evidence</h2>
        {attributes.length ? <DetailGrid t={t} rows={attributes} /> : <p style={mutedStyle(t)}>No additional typed evidence was recorded for this stage.</p>}
      </section>
      <section style={subsectionStyle(t)}>
        <h2 style={sectionHeadingStyle(t)}>Downstream stages</h2>
        {related.length ? (
          <ul style={{ margin: 0, paddingLeft: 18, color: t.textSecondary, fontSize: 12.5, lineHeight: 1.7 }}>
            {related.map((child) => <li key={child.spanId}>{stageLabel(child.name)} — {outcomeText(child.outcome)} ({formatMs(child.durationMs)})</li>)}
          </ul>
        ) : <p style={mutedStyle(t)}>No downstream physical stage was recorded.</p>}
      </section>
      <p style={{ ...mutedStyle(t), marginTop: 15 }}>Evidence is metadata-only. It explains what the system attempted without showing request text, SQL, values, or returned rows.</p>
    </section>
  );
}

function CandidateDetail({ trace, t, offset, onOffset, showExcluded, onShowExcluded }: {
  trace: AskTraceDataV1;
  t: Theme;
  offset: number;
  onOffset: (offset: number) => void;
  showExcluded: boolean;
  onShowExcluded: (show: boolean) => void;
}): JSX.Element {
  const nonExcluded = trace.candidateDecisions.filter((item) => item.decision !== 'excluded');
  const excluded = trace.candidateDecisions.filter((item) => item.decision === 'excluded');
  const visible = showExcluded ? [...nonExcluded, ...excluded] : nonExcluded;
  const page = visible.slice(offset, offset + CANDIDATE_PAGE_SIZE);
  const nextOffset = Math.min(Math.max(0, visible.length - CANDIDATE_PAGE_SIZE), offset + CANDIDATE_PAGE_SIZE);
  const previousOffset = Math.max(0, offset - CANDIDATE_PAGE_SIZE);
  return (
    <section aria-label="Candidate decision detail" style={detailCardStyle(t)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 18, margin: 0 }}>Candidate decisions</h1>
          <p style={{ ...mutedStyle(t), margin: '5px 0 0' }}>Lifecycle evidence is recorded before ranking and package trimming. Candidate identifiers are qualified IDs, not definitions or values.</p>
        </div>
        <Pill t={t} icon={<Database size={12} />}>{trace.candidateDecisions.length} total</Pill>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 8px', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => { onShowExcluded(!showExcluded); onOffset(0); }} style={secondaryButtonStyle(t)} aria-pressed={showExcluded}>
          <Filter size={12} /> {showExcluded ? 'Hide exclusions' : `Show ${excluded.length} exclusions`}
        </button>
        <span style={{ fontSize: 11, color: t.textMuted }}>Showing {visible.length ? offset + 1 : 0}–{Math.min(offset + CANDIDATE_PAGE_SIZE, visible.length)} of {visible.length}</span>
      </div>
      <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 8, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640, fontSize: 11.5 }}>
          <thead><tr style={{ background: t.tableHeaderBg, color: t.textMuted, textAlign: 'left' }}><th style={tableHeadStyle}>Lifecycle</th><th style={tableHeadStyle}>Role</th><th style={tableHeadStyle}>Source</th><th style={tableHeadStyle}>Reason</th><th style={tableHeadStyle}>Qualified ID</th></tr></thead>
          <tbody>
            {page.map((candidate) => <CandidateRow key={`${candidate.sequence}-${candidate.candidateId}-${candidate.decision}`} candidate={candidate} t={t} />)}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7, marginTop: 10 }}>
        <button type="button" disabled={offset === 0} onClick={() => onOffset(previousOffset)} style={secondaryButtonStyle(t)}>Previous 50</button>
        <button type="button" disabled={offset + CANDIDATE_PAGE_SIZE >= visible.length} onClick={() => onOffset(nextOffset)} style={secondaryButtonStyle(t)}>Next 50</button>
      </div>
    </section>
  );
}

function CandidateRow({ candidate, t }: { candidate: AskTraceCandidateDecisionV1; t: Theme }): JSX.Element {
  return (
    <tr>
      <td style={tableCellStyle(t)}>{humanize(candidate.decision)}</td>
      <td style={tableCellStyle(t)}>{humanize(candidate.role)}</td>
      <td style={tableCellStyle(t)}>{humanize(candidate.source)}</td>
      <td style={tableCellStyle(t)}>{humanize(candidate.reasonCode)}</td>
      <td style={{ ...tableCellStyle(t), fontFamily: t.fontMono, color: t.textMuted, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={candidate.candidateId}>{shortId(candidate.candidateId, 22)}</td>
    </tr>
  );
}

function TraceGraph({ trace, t, selection, onSelect }: { trace: AskTraceDataV1; t: Theme; selection: TraceSelection | null; onSelect: (spanId: string) => void }): JSX.Element {
  const graph = useMemo(() => traceGraph(trace.spans, trace.envelope.rootSpanId, trace.envelope.traceId, trace.links, t), [trace.spans, trace.envelope.rootSpanId, trace.envelope.traceId, trace.links, t]);
  const grouped = trace.spans.length > 250;
  return (
    <section style={{ height: 620, minHeight: 420, border: `1px solid ${t.cellBorder}`, borderRadius: 11, overflow: 'hidden', background: t.cellBg }}>
      <div style={{ padding: '10px 13px', borderBottom: `1px solid ${t.cellBorder}`, fontSize: 11.5, color: t.textMuted }}>
        {grouped
          ? 'Large trace: stages are grouped by physical stage to keep the graph navigable.'
          : `${trace.links.length ? `${trace.links.length} continuation or Research link${trace.links.length === 1 ? '' : 's'} shown with dashed edges. ` : ''}Select a stage node to inspect its typed detail.`}
      </div>
      <div style={{ height: 'calc(100% - 40px)' }}>
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          fitView
          minZoom={0.25}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, node) => {
            const spanId = String(node.id);
            if (graph.spanIds.has(spanId)) onSelect(spanId);
          }}
          colorMode={t.appBg.toLowerCase().includes('0') ? 'dark' : 'light'}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selection?.kind === 'span' ? <span className="sr-only">Selected stage {selection.spanId}</span> : null}
    </section>
  );
}

export interface TraceTimelineRowV1 {
  span: AskTraceSpanV1;
  /** Exact persisted duration when it is safe to display; never the visual clamp. */
  recordedDurationMs?: number;
  /** Positive, bounded scale value used only to draw a visible bar. */
  visualDurationMs: number;
  leftPercent: number;
  widthPercent: number;
  durationLabel: string;
  accessibleLabel: string;
}

export interface TraceTimelinePresentationV1 {
  /** Exact persisted root/run duration; it remains unavailable while recording. */
  totalLabel: string;
  rows: TraceTimelineRowV1[];
}

/**
 * Keep presentation duration truth separate from a minimum visual width.
 * A zero-duration physical stage is valid evidence and must remain `0 ms` in
 * labels and accessibility text even though its bar needs pixels to be seen.
 */
export function traceTimelinePresentation(trace: AskTraceDataV1, nowMs = Date.now()): TraceTimelinePresentationV1 {
  const spans = [...trace.spans].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const start = dateMs(trace.envelope.startedAt) ?? nowMs;
  const inferredEnd = Math.max(...spans.map((span) => (dateMs(span.completedAt) ?? dateMs(span.startedAt) ?? start)), start + 1);
  const end = dateMs(trace.envelope.completedAt) ?? inferredEnd;
  const visualTotal = Math.max(1, safeNonNegativeDuration(end - start) ?? 1);
  const recordedTotal = safeNonNegativeDuration(trace.envelope.durationMs);
  const rows = spans.map((span) => {
    const began = dateMs(span.startedAt) ?? start;
    const recordedDurationMs = safeNonNegativeDuration(span.durationMs);
    const inferredDuration = safeNonNegativeDuration((dateMs(span.completedAt) ?? began) - began);
    const visualDurationMs = Math.max(1, recordedDurationMs ?? inferredDuration ?? 1);
    const leftPercent = Math.max(0, Math.min(100, ((began - start) / visualTotal) * 100));
    const widthPercent = Math.max(1.5, Math.min(100 - leftPercent, (visualDurationMs / visualTotal) * 100));
    const durationLabel = formatMs(recordedDurationMs);
    return {
      span,
      recordedDurationMs,
      visualDurationMs,
      leftPercent,
      widthPercent,
      durationLabel,
      accessibleLabel: `${stageLabel(span.name)}. ${outcomeText(span.outcome)}. ${durationLabel}.`,
    };
  });
  return { totalLabel: formatMs(recordedTotal), rows };
}

export function TraceTimeline({ trace, t, selection, onSelect }: { trace: AskTraceDataV1; t: Theme; selection: TraceSelection | null; onSelect: (spanId: string) => void }): JSX.Element {
  const timeline = traceTimelinePresentation(trace);
  return (
    <section style={detailCardStyle(t)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div><h1 style={{ fontSize: 18, margin: 0 }}>Timeline</h1><p style={{ ...mutedStyle(t), margin: '5px 0 10px' }}>Waterfall of bounded physical stages. Durations are recorded locally; no external telemetry exporter is used.</p></div>
        <span style={{ color: t.textMuted, fontFamily: t.fontMono, fontSize: 11 }}>{timeline.totalLabel} total</span>
      </div>
      <div style={{ display: 'grid', gap: 5 }}>
        {timeline.rows.map((row) => {
          const { span } = row;
          const selected = selection?.kind === 'span' && selection.spanId === span.spanId;
          return (
            <button key={span.spanId} type="button" aria-label={row.accessibleLabel} onClick={() => onSelect(span.spanId)} style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 260px) minmax(90px, 1fr) 58px', gap: 8, alignItems: 'center', border: 0, background: selected ? `${t.accent}10` : 'transparent', color: t.textPrimary, cursor: 'pointer', borderRadius: 6, padding: '5px 6px', textAlign: 'left' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}><OutcomeIcon outcome={span.outcome} size={11} /> {stageLabel(span.name)}</span>
              <span style={{ height: 13, position: 'relative', borderRadius: 99, background: t.tableHeaderBg, overflow: 'hidden' }}>
                <span data-trace-timeline-bar={span.spanId} style={{ position: 'absolute', left: `${row.leftPercent}%`, width: `${row.widthPercent}%`, top: 0, bottom: 0, borderRadius: 99, background: outcomeColor(t, span.outcome) }} />
              </span>
              <span style={{ color: t.textMuted, fontFamily: t.fontMono, fontSize: 10.5, textAlign: 'right' }}>{row.durationLabel}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export interface TraceTreeNode { span: AskTraceSpanV1; parentId?: string; children: TraceTreeNode[]; }

export function traceInitialExpanded(trace: AskTraceDataV1): Set<string> {
  const byId = new Map(trace.spans.map((span) => [span.spanId, span]));
  const initial = new Set<string>([trace.envelope.rootSpanId]);
  for (const span of trace.spans) {
    if (span.parentSpanId === trace.envelope.rootSpanId) initial.add(span.spanId);
  }
  // Prefer the same action-worthy issue shown in the answer-first summary so
  // a later post-freeze failure is opened instead of a recoverable cascade
  // attempt retained by an older persisted first-issue pointer.
  let current = prioritizedIssueForTrace(trace)?.spanId ?? trace.envelope.firstIssueSpanId;
  while (current) {
    initial.add(current);
    current = byId.get(current)?.parentSpanId;
  }
  return initial;
}

export function buildSpanTree(spans: AskTraceSpanV1[], rootSpanId: string): TraceTreeNode[] {
  const nodes = new Map<string, TraceTreeNode>(spans.map((span) => [span.spanId, { span, parentId: span.parentSpanId, children: [] }]));
  const roots: TraceTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent && parent.span.spanId !== node.span.spanId) parent.children.push(node);
    else roots.push(node);
  }
  const sorter = (left: TraceTreeNode, right: TraceTreeNode) => left.span.ordinal - right.span.ordinal;
  for (const node of nodes.values()) node.children.sort(sorter);
  roots.sort(sorter);
  const root = nodes.get(rootSpanId);
  if (root && !roots.includes(root)) return [root, ...roots.filter((item) => item !== root)];
  return roots;
}

export function flattenVisibleTree(nodes: TraceTreeNode[], expanded: Set<string>, matching?: Set<string>): string[] {
  const result: string[] = [];
  const appendVisible = (node: TraceTreeNode) => {
    const matches = !matching || matching.has(node.span.spanId) || branchMatches(node, matching);
    if (!matches) return;
    result.push(node.span.spanId);
    if (expanded.has(node.span.spanId)) for (const child of node.children) appendVisible(child);
  };
  for (const node of nodes) appendVisible(node);
  return result;
}

function branchMatches(node: TraceTreeNode, matches: Set<string>): boolean {
  return matches.has(node.span.spanId) || node.children.some((child) => branchMatches(child, matches));
}

function spanMatches(span: AskTraceSpanV1, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const haystack = `${span.name} ${span.stage} ${span.outcome} ${span.reasonCode} ${span.payload.kind}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function traceGraph(spans: AskTraceSpanV1[], rootSpanId: string, traceId: string, links: AskTraceDataV1['links'], t: Theme): { nodes: Node[]; edges: Edge[]; spanIds: Set<string> } {
  const source = spans.length > 250 ? groupTraceSpans(spans) : spans;
  const byId = new Map(source.map((span) => [span.spanId, span]));
  const depthFor = (span: AskTraceSpanV1): number => {
    let depth = 0; let cursor = span.parentSpanId; const visited = new Set<string>();
    while (cursor && byId.has(cursor) && !visited.has(cursor)) { depth += 1; visited.add(cursor); cursor = byId.get(cursor)?.parentSpanId; }
    return depth;
  };
  const rowsByDepth = new Map<number, number>();
  const nodes: Node[] = source.map((span) => {
    const depth = depthFor(span);
    const row = rowsByDepth.get(depth) ?? 0;
    rowsByDepth.set(depth, row + 1);
    return {
      id: span.spanId,
      position: { x: depth * 230 + 28, y: row * 78 + 22 },
      data: { label: `${stageLabel(span.name)}\n${outcomeText(span.outcome)} · ${formatMs(span.durationMs)}` },
      style: { width: 190, borderRadius: 8, border: `1px solid ${outcomeColor(t, span.outcome)}`, background: t.cellBg, color: t.textPrimary, fontSize: 11, lineHeight: 1.35, whiteSpace: 'pre-line', padding: 8 },
    };
  });
  const edges: Edge[] = source.filter((span) => span.parentSpanId && byId.has(span.parentSpanId)).map((span) => ({ id: `${span.parentSpanId}-${span.spanId}`, source: span.parentSpanId!, target: span.spanId, style: { stroke: t.cellBorderActive }, animated: false }));
  // Links point to another Ask/Research run, not to an arbitrary payload. The
  // external endpoint is represented as a local, non-selectable node so the
  // graph preserves relationship direction without fetching another trace.
  const relationNodes: Node[] = [];
  links.forEach((link, index) => {
    const currentIsSource = link.sourceTraceId === traceId;
    const currentIsTarget = link.targetTraceId === traceId;
    if (!currentIsSource && !currentIsTarget) return;
    const externalId = `trace-link-${index}`;
    relationNodes.push({
      id: externalId,
      position: { x: (currentIsSource ? 1 : -1) * 240 + 28, y: Math.max(nodes.length, 1) * 78 + relationNodes.length * 68 + 22 },
      data: { label: `${humanize(link.kind)}\nlinked Ask or Research run` },
      style: { width: 190, borderRadius: 8, border: `1px dashed ${t.accent}`, background: t.tableHeaderBg, color: t.textPrimary, fontSize: 11, lineHeight: 1.35, whiteSpace: 'pre-line', padding: 8 },
      selectable: false,
    });
    const localRootId = byId.has(rootSpanId) ? rootSpanId : source[0]?.spanId;
    if (!localRootId) return;
    if (currentIsSource) {
      edges.push({ id: `trace-link-${index}-out`, source: localRootId, target: externalId, label: humanize(link.kind), style: { stroke: t.accent, strokeDasharray: '5 4' }, labelStyle: { fill: t.textMuted, fontSize: 10 } });
    } else {
      edges.push({ id: `trace-link-${index}-in`, source: externalId, target: localRootId, label: humanize(link.kind), style: { stroke: t.accent, strokeDasharray: '5 4' }, labelStyle: { fill: t.textMuted, fontSize: 10 } });
    }
  });
  nodes.push(...relationNodes);
  if (!nodes.some((node) => node.id === rootSpanId) && nodes.length) nodes[0]!.style = { ...nodes[0]!.style, borderColor: t.accent };
  return { nodes, edges, spanIds: new Set(source.map((span) => span.spanId)) };
}

function groupTraceSpans(spans: AskTraceSpanV1[]): AskTraceSpanV1[] {
  const byStage = new Map<string, AskTraceSpanV1[]>();
  for (const span of spans) byStage.set(span.stage, [...(byStage.get(span.stage) ?? []), span]);
  return [...byStage.values()].map((group, index) => {
    const first = group[0]!;
    return {
      ...first,
      spanId: `group-${first.stage}-${index}`,
      parentSpanId: undefined,
      name: first.name,
      ordinal: index,
      durationMs: group.reduce((total, span) => total + (span.durationMs ?? 0), 0),
      payload: { kind: 'stage', count: group.length },
    };
  });
}

function DetailGrid({ t, rows }: { t: Theme; rows: Array<[string, string]> }): JSX.Element {
  return <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 0.36fr) minmax(0, 1fr)', gap: '7px 12px', margin: '16px 0 0', fontSize: 12 }}>
    {rows.map(([label, value]) => <FragmentRow key={label} label={label} value={value} t={t} />)}
  </dl>;
}

function FragmentRow({ label, value, t }: { label: string; value: string; t: Theme }): JSX.Element {
  return <><dt style={{ color: t.textMuted }}>{label}</dt><dd style={{ margin: 0, color: t.textSecondary, wordBreak: 'break-word', minWidth: 0 }}>
    {value.includes('\n')
      ? <pre style={{ margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: t.fontMono, fontSize: 11, lineHeight: 1.45 }}>{value}</pre>
      : value}
  </dd></>;
}

function detailRows(payload: AskTraceSpanV1['payload']): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'kind' || value === undefined) continue;
    rows.push([labelForKey(key), traceValueDisplay(value)]);
  }
  return rows;
}

/** A recorded value as the reader can see it: lists and objects as indented JSON, cut at about 2,000 characters. */
export function traceValueDisplay(value: unknown, limit = 2_000): string {
  if (value === null) return 'None';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.length === 0) return 'None';
  if (typeof value !== 'object') return 'Not recorded';
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    return 'Not recorded';
  }
  return text.length > limit ? `${text.slice(0, limit)}\n… ${text.length - limit} more characters` : text;
}

function humanize(value: string): string { return value.replace(/_/g, ' '); }
function outcomeText(outcome: AskTraceSpanV1['outcome']): string { return humanize(outcome); }
function reasonLabel(reason: string): string { return humanize(reason); }
export function stageLabel(name: string): string { return humanize(name.replace(/\./g, ' · ')); }
function labelForKey(value: string): string { return humanize(value.replace(/([A-Z])/g, ' $1')).replace(/^./, (letter: string) => letter.toUpperCase()); }
function dateMs(value?: string): number | undefined { const parsed = value ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : undefined; }
function safeNonNegativeDuration(value?: number): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined; }
function formatDate(value: string): string { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? 'Not recorded' : parsed.toLocaleString(); }
export function formatMs(value?: number): string {
  if (value === 0) return '0 ms';
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}
function shortId(value: string, max = 16): string { return value.length <= max ? value : `${value.slice(0, Math.max(6, Math.floor(max / 2)))}…${value.slice(-Math.max(4, Math.floor(max / 3)))}`; }
function recordingLabel(status: string): string { return humanize(status); }
function errorMessage(cause: unknown): string { return cause instanceof Error && cause.message ? cause.message : 'Unable to load local trace evidence.'; }

function OutcomeIcon({ outcome, size }: { outcome: AskTraceSpanV1['outcome']; size: number }): JSX.Element {
  if (outcome === 'ok') return <CheckCircle2 size={size} aria-label="Completed" />;
  if (outcome === 'error' || outcome === 'denied') return <XCircle size={size} aria-label={outcome === 'denied' ? 'Denied' : 'Failed'} />;
  if (outcome === 'unavailable' || outcome === 'interrupted') return <AlertTriangle size={size} aria-label={outcome} />;
  if (outcome === 'cancelled' || outcome === 'skipped') return <CircleOff size={size} aria-label={outcome} />;
  return <LoaderCircle size={size} aria-label="Recording" />;
}

function outcomeColor(t: Theme, outcome: AskTraceSpanV1['outcome']): string {
  if (outcome === 'ok') return t.success;
  if (outcome === 'error' || outcome === 'denied') return t.error;
  if (outcome === 'unavailable' || outcome === 'interrupted') return t.warning;
  return t.textMuted;
}

function Pill({ t, icon, children }: { t: Theme; icon: JSX.Element; children: React.ReactNode }): JSX.Element {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 7px', border: `1px solid ${t.cellBorder}`, borderRadius: 999, color: t.textSecondary, fontSize: 10.5, lineHeight: 1.1, background: t.tableHeaderBg }}>{icon}{children}</span>;
}

function StatusPill({ t, value, issue }: { t: Theme; value: string; issue: boolean }): JSX.Element {
  return <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 7px', border: `1px solid ${issue ? t.error : t.success}`, borderRadius: 999, color: issue ? t.error : t.success, fontSize: 10.5, fontWeight: 700, background: issue ? `${t.error}0d` : `${t.success}0d` }}>{issue ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}{value}</span>;
}

function TraceLoading({ t }: { t: Theme }): JSX.Element { return <div role="status" aria-live="polite" style={{ flex: 1, display: 'grid', placeItems: 'center', color: t.textMuted, fontFamily: t.font }}><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><LoaderCircle size={16} /> Loading local Ask trace…</span></div>; }
function TraceFailure({ t, message, onBack, onRetry }: { t: Theme; message: string; onBack: () => void; onRetry: () => void }): JSX.Element { return <div role="alert" style={{ margin: '42px auto', maxWidth: 640, padding: 22, border: `1px solid ${t.error}`, borderRadius: 11, color: t.textPrimary, fontFamily: t.font, background: t.cellBg }}><div style={{ display: 'flex', gap: 8, alignItems: 'center', color: t.error, fontWeight: 700 }}><AlertTriangle size={17} /> Trace unavailable</div><p style={{ color: t.textSecondary, lineHeight: 1.5 }}>{message}</p><div style={{ display: 'flex', gap: 8 }}><button type="button" onClick={onRetry} style={secondaryButtonStyle(t)}>Retry</button><button type="button" onClick={onBack} style={secondaryButtonStyle(t)}>Back to Ask AI</button></div></div>; }
function EmptyDetail({ t }: { t: Theme }): JSX.Element { return <section style={detailCardStyle(t)}><h1 style={{ fontSize: 18, marginTop: 0 }}>No stage selected</h1><p style={mutedStyle(t)}>Select a trace stage or candidate decision from the tree.</p></section>; }

const detailCardStyle = (t: Theme): CSSProperties => ({ padding: '18px', minWidth: 0, border: `1px solid ${t.cellBorder}`, borderRadius: 11, background: t.cellBg });
const traceSplitLayout = (isNarrow: boolean): CSSProperties => ({ display: 'grid', gridTemplateColumns: isNarrow ? 'minmax(0, 1fr)' : 'minmax(300px, 1.15fr) minmax(300px, 0.85fr)', gap: 14, alignItems: 'start' });
const treeSplitLayout = (isNarrow: boolean): CSSProperties => ({ display: 'grid', gridTemplateColumns: isNarrow ? 'minmax(0, 1fr)' : 'minmax(300px, 350px) minmax(0, 1fr)', gap: 14, alignItems: 'start' });
const subsectionStyle = (t: Theme): CSSProperties => ({ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${t.cellBorder}` });
const sectionHeadingStyle = (t: Theme): CSSProperties => ({ margin: '0 0 8px', fontSize: 12.5, color: t.textPrimary });
const mutedStyle = (t: Theme): CSSProperties => ({ color: t.textMuted, fontSize: 12, lineHeight: 1.5 });
const backLinkStyle = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: 0, border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer', font: `600 12px ${t.font}` });
const iconButtonStyle = (t: Theme): CSSProperties => ({ display: 'inline-grid', placeItems: 'center', width: 27, height: 27, border: `1px solid ${t.cellBorder}`, borderRadius: 7, background: t.cellBg, color: t.textSecondary, cursor: 'pointer' });
const treeToggleStyle = (t: Theme): CSSProperties => ({ display: 'grid', placeItems: 'center', flex: '0 0 24px', width: 24, height: 29, padding: 0, border: 0, background: 'transparent', color: t.textMuted, cursor: 'pointer' });
const treeButtonStyle = (t: Theme, selected: boolean): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0, padding: '5px 7px', border: `1px solid ${selected ? t.accent : 'transparent'}`, borderRadius: 6, background: selected ? `${t.accent}12` : 'transparent', color: selected ? t.textPrimary : t.textSecondary, cursor: 'pointer', font: `500 11px ${t.font}` });
const secondaryButtonStyle = (t: Theme): CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 8px', border: `1px solid ${t.cellBorder}`, borderRadius: 7, background: t.cellBg, color: t.textSecondary, cursor: 'pointer', font: `600 11px ${t.font}` });
const tableHeadStyle: CSSProperties = { padding: '8px 9px', fontSize: 10, fontWeight: 750, letterSpacing: '.02em', whiteSpace: 'nowrap' };
const tableCellStyle = (t: Theme): CSSProperties => ({ padding: '8px 9px', borderTop: `1px solid ${t.cellBorder}`, color: t.textSecondary, verticalAlign: 'top' });
