import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowRight, BarChart3, Bot, ChevronDown, ChevronRight, Clock, FileText,
  Loader2, MapPin, RefreshCw, Search, ShieldCheck, Sparkles, Table2, Trash2, Workflow, X,
} from 'lucide-react';
import { api, type AppDocumentSummary, type DashboardDocumentResponse, type DashboardRunResponse, type LocalAppInvestigation } from '../../api/client';
import { EmptyPanel, PanelCard, PanelHead, StatusSeal } from './AppSidePanels';
import { cleanStakeholderCopy, formatBusinessLabel, tidyTitle } from './app-text';
import { themes, type ThemeMode } from '../../themes/notebook-theme';
import type { AppAnalysisHandoff, AppResearchSeed, CreateInvestigationResult } from './app-research-types';
import { formatVariableEntryValue } from './app-variables';
import { StructuredAnswerText } from '../agent/AgentAnswerCard';
import { DriverChart } from '../agent/DriverChart';

/**
 * The App analysis (Research) surface: the investigation list, the report it
 * renders, and the formatting that turns a stored investigation into readable
 * business prose.
 *
 * Extracted from `AppsView.tsx`, where it was the single largest feature and
 * sat interleaved with the App shell it has nothing to do with.
 */

const inFlightResearchSeedRequests = new Map<string, Promise<CreateInvestigationResult>>();

function formatActiveFilterContext(filters: Record<string, unknown>): string {
  const entries = Object.entries(filters).filter(([key]) => key !== 'smartView');
  if (!entries.length) return 'No app filters set';
  return entries.map(([key, value]) => `${formatBusinessLabel(key)} ${formatVariableEntryValue(key, value)}`).join(', ');
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return formatResearchValue(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function asUiRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}


function KeyValueInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="dql-app-keyvalue-inline">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export function ResearchPanel({
  appDoc,
  dashboardDoc,
  seed,
  themeMode,
  onSeedHandled,
  onDashboardChanged,
  onInvestigationsChanged,
  onActiveInvestigationChange,
}: {
  appDoc: AppDocumentSummary | null;
  dashboardDoc: DashboardDocumentResponse | null;
  seed: AppResearchSeed | null;
  themeMode: ThemeMode;
  onSeedHandled: () => void;
  onDashboardChanged: (dashboard: DashboardDocumentResponse['dashboard']) => void;
  onInvestigationsChanged: (investigations: LocalAppInvestigation[]) => void;
  onActiveInvestigationChange: (investigation: LocalAppInvestigation | null) => void;
}) {
  const appId = appDoc?.app.id;
  const activeDashboardId = dashboardDoc?.dashboard.id;
  const t = themes[themeMode];
  const [items, setItems] = useState<LocalAppInvestigation[]>(() => appDoc?.investigations ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evidenceTab, setEvidenceTab] = useState<'preview' | 'sql' | 'assumptions' | 'context'>('preview');
  const [sqlDraft, setSqlDraft] = useState('');
  const [showResearchHistory, setShowResearchHistory] = useState(false);
  const [reportNavigatorOpen, setReportNavigatorOpen] = useState(false);
  const [pendingAnalysisTitle, setPendingAnalysisTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!appId) {
      setItems([]);
      setSelectedId(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api.listAppInvestigations(appId).then((investigations) => {
      if (cancelled) return;
      setError(null);
      setItems(investigations);
      const sorted = sortResearchInvestigations(investigations);
      setSelectedId((current) => current ?? sorted.find((item) => item.status === 'ready')?.id ?? sorted[0]?.id ?? null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  useEffect(() => {
    onInvestigationsChanged(items);
  }, [items, onInvestigationsChanged]);

  useEffect(() => {
    if (!seed || !appId) return;
    let cancelled = false;
    const investigationInput = {
      dashboardId: seed.dashboardId ?? activeDashboardId,
      sourceTileId: seed.sourceTileId,
      sourceBlockId: seed.sourceBlockId,
      title: seed.title,
      question: seed.question,
      intent: seed.intent,
      context: seed.context,
      generatedSql: seed.generatedSql,
      run: true,
    };
    const pendingTitle = cleanResearchScopeText(seed.title ?? seed.question) || 'requested follow-up';
    const seedKey = `${appId}:${JSON.stringify(investigationInput)}`;
    const create = async () => {
      setBusy('create');
      setPendingAnalysisTitle(pendingTitle);
      setError(null);
      let request = inFlightResearchSeedRequests.get(seedKey);
      if (!request) {
        request = api.createAppInvestigation(appId, investigationInput);
        inFlightResearchSeedRequests.set(seedKey, request);
        void request.finally(() => {
          window.setTimeout(() => inFlightResearchSeedRequests.delete(seedKey), 5000);
        });
      }
      const result = await request;
      if (cancelled) return;
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        setPendingAnalysisTitle(null);
        onSeedHandled();
        return;
      }
      const created = result.investigation;
      const applyInvestigation = (investigation: LocalAppInvestigation) => {
        setItems((current) => upsertInvestigation(current, investigation));
        setSelectedId(investigation.id);
        setEvidenceTab('preview');
        setReportNavigatorOpen(false);
        if (investigation.status !== 'draft' && investigation.status !== 'running') {
          setPendingAnalysisTitle(null);
        }
      };
      applyInvestigation(created);
      if (created.status !== 'draft' && created.status !== 'running') {
        onSeedHandled();
        return;
      }
      setBusy(created.id);
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 1000);
        });
        if (cancelled) return;
        const refreshed = await api.getAppInvestigation(appId, created.id);
        if (cancelled) return;
        if (refreshed && refreshed.status !== 'draft' && refreshed.status !== 'running') {
          setBusy(null);
          applyInvestigation(refreshed);
          onSeedHandled();
          return;
        }
      }
      onSeedHandled();
      setBusy(null);
      setPendingAnalysisTitle(null);
      setError('Analysis is still running. Reopen it or refresh to load the latest proof.');
    };
    const timer = window.setTimeout(() => void create(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [seed?.nonce, appId, activeDashboardId, onSeedHandled]);

  const sortedItems = useMemo(() => sortResearchInvestigations(items), [items]);
  const selected = sortedItems.find((item) => item.id === selectedId)
    ?? sortedItems.find((item) => item.status === 'ready')
    ?? sortedItems[0]
    ?? null;
  useEffect(() => {
    onActiveInvestigationChange(selected);
    return () => onActiveInvestigationChange(null);
  }, [selected, onActiveInvestigationChange]);
  const recentHistory = sortedItems
    .filter((item) => item.id !== selected?.id)
    .filter((item) => showResearchHistory || item.status !== 'error')
    .slice(0, showResearchHistory ? 40 : 5);
  const hiddenHistoryCount = Math.max(0, sortedItems.length - (selected ? 1 : 0) - recentHistory.length);
  const selectedReport = selected ? buildResearchReport(selected) : null;
  const selectedMemo = selectedReport ? buildResearchMemo(selectedReport) : '';
  const creatingReport = busy === 'create' || Boolean(pendingAnalysisTitle);
  const pendingReportVisible = creatingReport && Boolean(pendingAnalysisTitle);
  const creatingInitialReport = creatingReport && !selected;

  useEffect(() => {
    setSqlDraft(selected?.generatedSql ?? '');
  }, [selected?.id, selected?.generatedSql]);

  const rerunResearch = async (investigation: LocalAppInvestigation, sqlOverride?: string): Promise<LocalAppInvestigation | null> => {
    if (!appId) return null;
    setBusy(investigation.id);
    setError(null);
    const reviewedSql = sqlOverride?.trim();
    const result = await api.runAppInvestigation(appId, investigation.id, reviewedSql ? { generatedSql: reviewedSql } : undefined);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setItems((current) => upsertInvestigation(current, result.investigation));
    setEvidenceTab('preview');
    return result.investigation;
  };

  const rebuildResearchSql = async (investigation: LocalAppInvestigation): Promise<LocalAppInvestigation | null> => {
    if (!appId) return null;
    setBusy(`rebuild:${investigation.id}`);
    setError(null);
    const result = await api.runAppInvestigation(appId, investigation.id, { repairMode: 'rebuild_from_certified' });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setItems((current) => upsertInvestigation(current, result.investigation));
    setEvidenceTab(result.investigation.error ? 'sql' : 'preview');
    return result.investigation;
  };

  const pinResearch = async (investigation: LocalAppInvestigation): Promise<LocalAppInvestigation | null> => {
    if (!appId) return null;
    setBusy(`pin:${investigation.id}`);
    setError(null);
    const result = await api.pinAppInvestigation(appId, investigation.id, {
      dashboardId: investigation.dashboardId ?? activeDashboardId,
      title: investigation.title,
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setItems((current) => upsertInvestigation(current, result.investigation));
    setSelectedId(result.investigation.id);
    if (result.dashboard) onDashboardChanged(result.dashboard);
    return result.investigation;
  };

  const promoteResearch = async (investigation: LocalAppInvestigation) => {
    if (!appId) return;
    if (!investigation.generatedSql) {
      setError('Add reviewed SQL before creating a draft saved query.');
      return;
    }
    const pinned = investigation.pinnedAiPinId ? investigation : await pinResearch(investigation);
    const pinId = pinned?.pinnedAiPinId;
    if (!pinId) return;
    setBusy(`promote:${investigation.id}`);
    setError(null);
    const result = await api.promoteAiPin(appId, pinId);
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? 'Draft saved query could not be created.');
      return;
    }
    const refreshed = await api.getAppInvestigation(appId, investigation.id);
    if (refreshed) setItems((current) => upsertInvestigation(current, refreshed));
  };

  const promoteReviewedResearch = async (investigation: LocalAppInvestigation) => {
    const reviewedSql = sqlDraft.trim();
    let target = investigation;
    if (reviewedSql && reviewedSql !== (investigation.generatedSql ?? '').trim()) {
      const rerun = await rerunResearch(investigation, reviewedSql);
      if (!rerun) return;
      target = rerun;
    }
    await promoteResearch(target);
  };

  const pinReviewedResearch = async (investigation: LocalAppInvestigation) => {
    const reviewedSql = sqlDraft.trim();
    let target = investigation;
    if (reviewedSql && reviewedSql !== (investigation.generatedSql ?? '').trim()) {
      const rerun = await rerunResearch(investigation, reviewedSql);
      if (!rerun) return null;
      target = rerun;
    }
    return pinResearch(target);
  };

  if (!appDoc) return <EmptyPanel title="No App selected." detail="Choose an App before writing analysis." />;

  return (
    <div className={`dql-app-research-shell ${reportNavigatorOpen || (!selected && !creatingInitialReport) ? 'history-open' : 'history-collapsed'}`}>
      <section className="dql-app-research-list">
        <div className="dql-app-research-head">
          <span><Search size={14} /> Analysis</span>
          <div>
            <b>{items.length}</b>
            {selected ? (
              <button type="button" onClick={() => setReportNavigatorOpen(false)} title="Close analysis history">
                Close
              </button>
            ) : null}
          </div>
        </div>
        {loading ? <EmptyPanel title="Loading analysis..." detail="Reading local app analysis." compact /> : null}
        {error ? <div className="dql-app-error">{error}</div> : null}
        {!loading && items.length === 0 ? (
          <EmptyPanel title="No analysis yet." detail="Start from Copilot so the analysis keeps the original question, filters, and selected result context." compact />
        ) : null}
        <div className="dql-app-research-items">
          {selected ? (
            <>
              <div className="dql-app-research-group-label">Current analysis</div>
              <ResearchListButton
                item={selected}
                selected
                onClick={() => {
                  setError(null);
                  setSelectedId(selected.id);
                  setEvidenceTab('preview');
                  setReportNavigatorOpen(false);
                }}
              />
            </>
          ) : null}
          {recentHistory.length ? (
            <div className="dql-app-research-group-label">Recent history</div>
          ) : null}
          {recentHistory.map((item) => (
            <ResearchListButton
              key={item.id}
              item={item}
              selected={selected?.id === item.id}
              onClick={() => {
                setError(null);
                setSelectedId(item.id);
                setEvidenceTab('preview');
                setReportNavigatorOpen(false);
              }}
            />
          ))}
          {hiddenHistoryCount > 0 ? (
            <button
              type="button"
              className="dql-app-research-history-toggle"
              onClick={() => setShowResearchHistory((value) => !value)}
            >
              <span>{showResearchHistory ? 'Hide older runs' : `Show ${hiddenHistoryCount} older run${hiddenHistoryCount === 1 ? '' : 's'}`}</span>
              <small>{showResearchHistory ? 'Keep the current analysis focused' : 'Includes failed and superseded analysis attempts'}</small>
            </button>
          ) : null}
        </div>
      </section>

      <section className="dql-app-research-detail">
        {pendingReportVisible ? (
          <>
            <div className="dql-app-report-toolbar">
              <div>
                <span>New memo</span>
                <b>{pendingAnalysisTitle}</b>
              </div>
              {items.length ? (
                <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => setReportNavigatorOpen((value) => !value)}>
                  <Search size={13} /> {reportNavigatorOpen ? 'Hide history' : `Analysis history (${items.length})`}
                </button>
              ) : null}
            </div>
            {error ? <div className="dql-app-error">{error}</div> : null}
            <div className="dql-app-research-creating active">
              <Workflow size={24} />
              <span>Preparing business memo</span>
              <h2>Writing business memo...</h2>
              <p>ZLens is opening a scoped memo for "{pendingAnalysisTitle}". The previous memo stays in history while this answer is built from the typed context, active filters, certified block evidence, and preview proof.</p>
              <div className="dql-app-research-creating-steps">
                <small>Reading current filters</small>
                <small>Checking certified saved query context</small>
                <small>Building narrative and proof appendix</small>
              </div>
            </div>
          </>
        ) : selected && selectedReport ? (
          <>
            <div className="dql-app-report-toolbar">
              <div>
                <span>Current memo</span>
                <b>{formatResearchListTitle(selected)}</b>
              </div>
              <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => setReportNavigatorOpen((value) => !value)}>
                <Search size={13} /> {reportNavigatorOpen ? 'Hide history' : `Memo history (${items.length})`}
              </button>
            </div>
            {creatingReport || busy === selected.id || selected.status === 'running' ? (
              <div className={`dql-app-research-status ${creatingReport ? 'opening' : ''}`}>
                <Workflow size={14} />
                <div>
                  <span>{creatingReport ? 'Opening a new business memo...' : 'Refreshing the memo from certified evidence, active filters, and optional preview proof...'}</span>
                  {pendingAnalysisTitle ? <small>{pendingAnalysisTitle}</small> : null}
                </div>
              </div>
            ) : null}
            {error ? <div className="dql-app-error">{error}</div> : null}

            <article className="dql-app-research-report">
              <header className="dql-app-report-hero">
                <div className="dql-app-report-status-row">
                  <span><Search size={13} /> Business memo</span>
                  <StatusSeal tone={selected.status === 'error' ? 'draft' : 'agentic'}>{selected.reviewStatus}</StatusSeal>
                </div>
                <h2>{selectedReport.title}</h2>
                <p>{selectedReport.scope}</p>
                <div className="dql-app-report-context-line">
                  {selectedReport.contextFacts.map((fact) => (
                    <span key={fact.label}><b>{fact.label}</b>{fact.value}</span>
                  ))}
                </div>
                <div className="dql-app-report-actions">
                  <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => void pinReviewedResearch(selected)} disabled={busy === `pin:${selected.id}`}>
                    <MapPin size={13} /> {selected.pinnedAiPinId ? 'Added to App' : 'Add reviewed insight to App'}
                  </button>
                  <button type="button" className="dql-apps-btn dql-apps-btn-primary" onClick={() => void promoteReviewedResearch(selected)} disabled={!(sqlDraft.trim() || selected.generatedSql) || busy === `promote:${selected.id}`}>
                    <FileText size={13} /> {busy === `promote:${selected.id}` ? 'Drafting...' : 'Create draft saved query'}
                  </button>
                  <details className="dql-app-report-review-actions">
                    <summary>Reviewer tools</summary>
                    <div>
                      <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => void rerunResearch(selected, sqlDraft)} disabled={busy === selected.id}>
                        <Workflow size={13} /> {busy === selected.id ? 'Refreshing...' : 'Refresh memo'}
                      </button>
                      {selectedReport.previewIssue?.canRebuild ? (
                        <button type="button" className="dql-apps-btn dql-apps-btn-line" onClick={() => void rebuildResearchSql(selected)} disabled={busy === `rebuild:${selected.id}`}>
                          <Workflow size={13} /> {busy === `rebuild:${selected.id}` ? 'Rebuilding...' : 'Rebuild SQL'}
                        </button>
                      ) : null}
                    </div>
                  </details>
                </div>
                {selectedReport.previewIssue ? (
                  <div className="dql-app-report-warning">
                    <AlertTriangle size={14} />
                    <span>{selectedReport.previewIssue.message}</span>
                  </div>
                ) : null}
              </header>

              <section className="dql-app-report-section dql-app-report-paper">
                {selectedReport.sections.length ? (
                  <ResearchReportSections sections={selectedReport.sections} />
                ) : (
                  <StructuredAnswerText text={selectedMemo} t={t} compact />
                )}
              </section>

              {selectedReport.keyNumbers.length || selectedReport.drivers.length ? (
                <section className={`dql-app-report-section dql-app-report-evidence-story ${selectedReport.keyNumbers.length && selectedReport.drivers.length ? '' : 'single'}`}>
                  {selectedReport.keyNumbers.length ? (
                    <div>
                      <h3>{selectedReport.intent === 'segment_compare' ? 'Segment numbers' : selectedReport.intent === 'diagnose_change' ? 'Movement numbers' : 'Key numbers'}</h3>
                      <div className="dql-app-report-numbers">
                        {selectedReport.keyNumbers.map((metric) => (
                          <div key={metric.label} className="dql-app-report-number">
                            <span>{metric.label}</span>
                            <b>{metric.value}</b>
                            <small>{metric.detail}</small>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {selectedReport.drivers.length ? (
                    <div>
                      <h3>{selectedReport.intent === 'anomaly_investigation' ? 'Exception view' : selectedReport.intent === 'entity_drilldown' ? 'Entity view' : 'Driver view'}</h3>
                      <DriverChart drivers={selectedReport.drivers} />
                    </div>
                  ) : null}
                </section>
              ) : null}

              <details className="dql-app-report-section dql-app-report-appendix">
                <summary>
                  <span>Technical appendix</span>
                  <small>SQL, preview rows, caveats, routing, and source context for analyst review</small>
                  <ChevronDown size={15} />
                </summary>
                <div className="dql-app-research-evidence-head">
                  <div>
                    <h3>SQL and proof</h3>
                    <p>Use this appendix only when you need to inspect routing, repair generated SQL, or validate source context before pinning this memo to the app.</p>
                  </div>
                  <div className="dql-app-research-tabs">
                    {(['preview', 'sql', 'assumptions', 'context'] as const).map((tab) => (
                      <button key={tab} type="button" className={evidenceTab === tab ? 'on' : ''} onClick={() => setEvidenceTab(tab)}>
                        {tab === 'assumptions' ? 'Caveats' : formatBusinessLabel(tab)}
                      </button>
                    ))}
                  </div>
                </div>
                <ResearchEvidence
                  investigation={selected}
                  tab={evidenceTab}
                  sqlDraft={sqlDraft}
                  onSqlDraftChange={setSqlDraft}
                />
              </details>
            </article>
          </>
        ) : (
          <>
            {error ? <div className="dql-app-error">{error}</div> : null}
            {creatingInitialReport ? (
              <div className="dql-app-research-creating">
                <Workflow size={22} />
                <span>Preparing business memo</span>
                <h2>Writing business memo...</h2>
                <p>{pendingAnalysisTitle ? `ZLens is opening a scoped memo for "${pendingAnalysisTitle}".` : 'ZLens is using the Copilot context, active filters, certified saved query evidence, and any available preview proof to create the main-canvas memo.'}</p>
              </div>
            ) : (
              <EmptyPanel title="Start analysis from Copilot." detail="Ask a follow-up, add context, then review the analysis here." />
            )}
          </>
        )}
      </section>
    </div>
  );
}

export function ResearchListButton({
  item,
  selected,
  onClick,
}: {
  item: LocalAppInvestigation;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={[
        selected ? 'on' : '',
        `status-${item.status}`,
      ].filter(Boolean).join(' ')}
      onClick={onClick}
    >
      <span>{formatResearchListTitle(item)}</span>
      <small>{formatResearchListMeta(item)}</small>
    </button>
  );
}

function researchScopeFromContext(rawContext: unknown, fallbackQuestion: string): string {
  const fallback = cleanResearchScopeText(fallbackQuestion) || 'Review this app result.';
  const text = typeof rawContext === 'string' ? rawContext.trim() : '';
  if (!text) return fallback;

  const labeledScope = extractLabeledResearchScope(text);
  if (labeledScope) return labeledScope;

  const withoutMetadata = text
    .replace(/\bCurrent app filters:\s*[\s\S]*$/i, '')
    .replace(/\bCertified block to start from:\s*[\s\S]*$/i, '')
    .replace(/\bSource result:\s*[\s\S]*$/i, '')
    .replace(/\bUser intent:\s*[\s\S]*$/i, '');
  return cleanResearchScopeText(withoutMetadata) || fallback;
}

function extractLabeledResearchScope(text: string): string {
  const labelPattern = /(?:^|\n)\s*(Analysis goal|Analysis question|Report question|Research question|Proof question|Evidence question|Validation question|Reusable block goal|Business question|Question):\s*/i;
  const match = labelPattern.exec(text);
  if (!match) return '';
  const start = (match.index ?? 0) + match[0].length;
  const rest = text.slice(start);
  const stop = rest.search(/(?:^|\n)\s*(Current app filters|Certified block to start from|Source result|User intent|Review status|Trust status):/i);
  const scope = stop >= 0 ? rest.slice(0, stop) : rest;
  return cleanResearchScopeText(scope);
}

function cleanResearchScopeText(value: string): string {
  const cleaned = value
    .replace(/^\/(ask|research|report|analy[sz]e|analysis|proof|evidence|validate|verify|add\s+block|create\s+block|draft\s+block|block)\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= 280) return cleaned;
  const clipped = cleaned.slice(0, 280).replace(/\s+\S*$/, '').trim();
  return clipped ? `${clipped}...` : cleaned.slice(0, 280);
}

function buildResearchReport(investigation: LocalAppInvestigation) {
  const metrics = asUiRecord(investigation.metrics);
  const context = asUiRecord(investigation.context);
  const evidence = asUiRecord(investigation.evidence);
  const planner = asUiRecord(evidence.planner);
  const routeDecision = analysisRouteDecisionForReport(context, evidence, planner);
  const focusBlock = asUiRecord(context.focusBlock);
  const preview = firstResearchPreview(investigation);
  const previewResult = asUiRecord(preview?.result);
  const previewRows = Array.isArray(previewResult.rows) ? previewResult.rows.length : 0;
  const contextQuestion = researchScopeFromContext(context.userProvidedContext, investigation.question);
  const actionMode = typeof context.actionMode === 'string' ? context.actionMode : undefined;
  const sourceName = String(metrics.context ?? focusBlock.title ?? investigation.sourceBlockId ?? 'selected app result');
  const activeFilters = String(context.activeFilterSummary ?? formatActiveFilterContext(asUiRecord(context.activeFilters)));
  const reportType = researchIntentTitle(investigation.intent, actionMode);
  const title = researchReportDisplayTitle(investigation, contextQuestion, actionMode, sourceName);
  const scope = researchReportScopeLine(reportType, contextQuestion, sourceName, activeFilters);
  const summary = investigation.summary?.trim()
    || `ZLens wrote review-required analysis for ${sourceName}: ${investigation.question}. The selected app result is available, but this analysis still needs human review before it becomes governed business logic.`;
  const recommendation = investigation.recommendation?.trim()
    || 'Use this as analyst-reviewed analysis first. Confirm the metric grain, filters, source tables, and caveats before adding it to the app or drafting a reusable saved query.';
  const keyNumbers = [
    {
      label: String(metrics.currentLabel ?? 'Current'),
      value: formatResearchValue(metrics.currentValue),
      detail: String(metrics.currentDetail ?? 'current selected result'),
    },
    {
      label: String(metrics.baselineLabel ?? 'Baseline'),
      value: formatResearchValue(metrics.baselineValue),
      detail: String(metrics.baselineDetail ?? 'comparison or prior value'),
    },
    {
      label: String(metrics.deltaLabel ?? 'Delta'),
      value: formatResearchValue(metrics.delta),
      detail: String(metrics.deltaDetail ?? 'change or gap to explain'),
    },
    { label: 'Preview', value: previewRows ? `${previewRows} rows` : 'not captured', detail: 'bounded preview sample' },
  ].filter(isMeaningfulReportMetric);
  const drivers = buildResearchReportDrivers(investigation);
  const hasReportEvidence = previewRows > 0 || keyNumbers.length > 0 || drivers.length > 0 || Object.keys(metrics).length > 0;
  const normalizedSections = normalizeResearchReportSections(investigation.reportSections)
    .filter((section) => shouldShowResearchReportSection(section, investigation.error, hasReportEvidence));
  return {
    title,
    intent: investigation.intent,
    actionMode,
    scope,
    summary,
    recommendation,
    routeDecision,
    sections: normalizedSections,
    previewIssue: previewIssueForReport(investigation.error, typeof planner.sqlErrorKind === 'string' ? planner.sqlErrorKind : undefined, hasReportEvidence),
    contextFacts: [
      { label: 'Type', value: reportType },
      { label: 'Source', value: sourceName },
      { label: 'Filters', value: activeFilters },
      { label: 'Review', value: formatBusinessLabel(investigation.reviewStatus) },
    ],
    keyNumbers,
    drivers,
  };
}

function analysisRouteDecisionForReport(
  context: Record<string, unknown>,
  evidence: Record<string, unknown>,
  planner: Record<string, unknown>,
): { mode: string; reason: string; nextAction: string; confidence?: number } | null {
  const originatingAnswer = asUiRecord(context.originatingAnswer);
  const raw = asUiRecord(context.routeDecision);
  const fallback = asUiRecord(originatingAnswer.decision);
  const evidenceDecision = asUiRecord(evidence.routeDecision);
  const plannerDecision = asUiRecord(planner.routeDecision);
  const decision = Object.keys(raw).length ? raw
    : Object.keys(fallback).length ? fallback
      : Object.keys(evidenceDecision).length ? evidenceDecision
        : Object.keys(plannerDecision).length ? plannerDecision
          : {};
  const reason = typeof decision.reason === 'string' ? decision.reason.trim() : '';
  const nextAction = typeof decision.nextAction === 'string' ? decision.nextAction.trim() : '';
  if (!reason && !nextAction) return null;
  const mode = typeof decision.mode === 'string' && decision.mode.trim()
    ? formatBusinessLabel(decision.mode)
    : 'Analysis';
  const confidence = typeof decision.confidence === 'number' && Number.isFinite(decision.confidence)
    ? Math.round(Math.max(0, Math.min(1, decision.confidence)) * 100)
    : undefined;
  return { mode, reason, nextAction, confidence };
}

export function appAnalysisHandoffFromInvestigation(investigation: LocalAppInvestigation): AppAnalysisHandoff {
  const context = asUiRecord(investigation.context);
  const evidence = asUiRecord(investigation.evidence);
  const planner = asUiRecord(evidence.planner);
  const routeDecision = analysisRouteDecisionForReport(context, evidence, planner);
  const actionMode = context.actionMode === 'block'
    ? 'block'
    : context.actionMode === 'evidence'
      ? 'evidence'
      : 'research';
  const userContext = typeof context.userProvidedContext === 'string' && context.userProvidedContext.trim()
    ? context.userProvidedContext.trim()
    : investigation.question;
  const question = researchScopeFromContext(userContext, investigation.question)
    || stripResearchTitlePrefix(investigation.title)
    || stripResearchTitlePrefix(investigation.question)
    || 'Refine this analysis';
  return {
    mode: actionMode,
    question,
    context: userContext,
    decision: routeDecision
      ? {
        reason: routeDecision.reason,
        nextAction: routeDecision.nextAction,
      }
      : undefined,
  };
}

function previewIssueForReport(error?: string, kind?: string, hasCertifiedEvidence = false): { message: string; canRebuild: boolean } | null {
  const detail = error?.trim();
  if (!detail) return null;
  if (hasCertifiedEvidence && (kind === 'runtime_unavailable' || kind === 'unknown' || /\bAI provider did not return a governed answer\b/i.test(detail))) {
    return null;
  }
  if (kind === 'runtime_unavailable') {
    return {
      message: 'Preview could not run because the warehouse or execution runtime is unavailable. Resume or choose an active warehouse, then refresh the report. The SQL may not need to change.',
      canRebuild: false,
    };
  }
  if (kind === 'timeout') {
    return {
      message: 'Preview timed out. Narrow filters or simplify the SQL in the trace appendix, then refresh before promoting this report.',
      canRebuild: false,
    };
  }
  if (kind === 'safety') {
    return {
      message: 'DQL blocked this preview because the SQL is not safe read-only analytical SQL. Rebuild from the certified saved query or edit it as a SELECT/WITH query before refreshing.',
      canRebuild: true,
    };
  }
  return {
    message: 'SQL preview needs review. Edit the SQL in the trace appendix or rebuild it from the certified saved query context before promoting this report.',
    canRebuild: true,
  };
}

function shouldShowResearchReportSection(
  section: NonNullable<LocalAppInvestigation['reportSections']>[number],
  error: string | undefined,
  hasReportEvidence: boolean,
): boolean {
  const sectionId = String(section.id ?? '').toLowerCase();
  if (section.kind === 'review_boundary' || sectionId === 'review-boundary') {
    return false;
  }
  if (sectionId === 'preview-unavailable' && hasReportEvidence) {
    return false;
  }
  if (
    sectionId === 'sql-repair-path' &&
    hasReportEvidence &&
    /\bAI provider did not return a governed answer\b/i.test(error ?? '')
  ) {
    return false;
  }
  return true;
}

function isMeaningfulReportMetric(metric: { label: string; value: string; detail: string }): boolean {
  const value = metric.value.trim().toLowerCase();
  return Boolean(value) && value !== 'n/a' && value !== 'not captured' && value !== 'not available';
}

function researchReportDisplayTitle(
  investigation: LocalAppInvestigation,
  contextQuestion: string,
  actionMode: string | undefined,
  sourceName: string,
): string {
  const cleanQuestion = stripResearchTitlePrefix(contextQuestion)
    || stripResearchTitlePrefix(investigation.title)
    || stripResearchTitlePrefix(investigation.question);
  const label = actionMode === 'block'
    ? 'Reusable logic'
    : actionMode === 'evidence'
      ? 'Proof brief'
      : 'Analysis';
  const fallback = formatBusinessLabel(sourceName);
  const core = cleanQuestion || fallback;
  return `${label}: ${truncateReportTitle(core)}`;
}

function researchReportScopeLine(
  reportType: string,
  contextQuestion: string,
  sourceName: string,
  activeFilters: string,
): string {
  const question = stripResearchTitlePrefix(contextQuestion);
  const parts = [
    question ? `Question: ${question}` : '',
    `Source: ${sourceName}`,
    activeFilters && activeFilters !== 'No app filters set' ? `Filters: ${activeFilters}` : '',
    `Status: ${reportType} / review-required`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function stripResearchTitlePrefix(value?: string | null): string {
  return cleanResearchScopeText(String(value ?? ''))
    .replace(/^(analysis|report|research|proof|proof brief|reusable logic|reusable logic brief|change analysis|driver analysis|segment comparison|entity drilldown|anomaly review|validation result)\s*:\s*/i, '')
    .replace(/^(analysis goal|analysis question|report question|research question|proof question|evidence question|validation question|reusable block goal|business question|question)\s*:\s*/i, '')
    .trim();
}

function truncateReportTitle(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= 96) return clean;
  const clipped = clean.slice(0, 96).replace(/\s+\S*$/, '').trim();
  return `${clipped || clean.slice(0, 96)}...`;
}

function researchIntentTitle(intent: LocalAppInvestigation['intent'], actionMode?: string): string {
  if (actionMode === 'evidence') return 'Proof Brief';
  if (actionMode === 'block') return 'Reusable Logic Brief';
  if (intent === 'diagnose_change') return 'Change Analysis';
  if (intent === 'segment_compare') return 'Segment Comparison';
  if (intent === 'entity_drilldown') return 'Entity Drilldown';
  if (intent === 'anomaly_investigation') return 'Anomaly Review';
  if (intent === 'trust_gap_review') return 'Proof Review';
  return 'Driver Analysis';
}

function buildResearchReportDrivers(investigation: LocalAppInvestigation): Array<{ title: string; value: string; explanation: string }> {
  const cards = (investigation.driverCards ?? [])
    .map(asUiRecord)
    .filter((item) => Object.keys(item).length > 0);
  if (cards.length) {
    return cards.slice(0, 8).map((record, index) => ({
      title: String(record.title ?? `Driver ${index + 1}`),
      value: String(record.contribution ?? record.value ?? record.metric ?? 'Proof'),
      explanation: String(record.explanation ?? 'Review this driver against the source rows and metric grain.'),
    }));
  }
  const preview = firstResearchPreview(investigation);
  const result = asUiRecord(preview?.result);
  const rows = Array.isArray(result.rows) ? result.rows.map(asUiRecord).filter((row) => Object.keys(row).length > 0) : [];
  return rows.slice(0, 5).map((row, index) => {
    const keys = Object.keys(row);
    const titleKey = keys.find((key) => /name|player|customer|account|segment|team/i.test(key)) ?? keys[0] ?? `row_${index + 1}`;
    const valueKey = keys.find((key) => /point|revenue|total|score|value|delta|count/i.test(key) && key !== titleKey) ?? keys[1] ?? titleKey;
    return {
      title: String(row[titleKey] ?? `Preview row ${index + 1}`),
      value: formatResearchValue(row[valueKey]),
      explanation: `This row is part of the bounded preview sample for ${formatBusinessLabel(valueKey)}.`,
    };
  });
}

function buildResearchMemo(report: ReturnType<typeof buildResearchReport>): string {
  if (report.sections.length > 0) {
    return report.sections.map((section) => {
      const bullets = section.bullets?.length
        ? `\n\n${section.bullets.map((bullet) => `- ${bullet}`).join('\n')}`
        : '';
      return `## ${section.title}\n${section.body}${bullets}`;
    }).join('\n\n');
  }
  const topNumber = report.keyNumbers.find((metric) => metric.value !== 'not available' && metric.label !== 'Preview');
  const comparison = report.keyNumbers.find((metric) => /baseline|comparison|next/i.test(metric.label) && metric.value !== 'not available');
  const gap = report.keyNumbers.find((metric) => /delta|gap|change/i.test(metric.label) && metric.value !== 'not available');
  const leadDriver = report.drivers[0];
  const nextDriver = report.drivers[1];
  const source = report.contextFacts.find((fact) => fact.label === 'Source')?.value;
  const filters = report.contextFacts.find((fact) => fact.label === 'Filters')?.value;
  const evidenceLine = [
    topNumber ? `${topNumber.label}: ${topNumber.value} (${topNumber.detail})` : '',
    comparison ? `${comparison.label}: ${comparison.value} (${comparison.detail})` : '',
    gap ? `${gap.label}: ${gap.value} (${gap.detail})` : '',
  ].filter(Boolean).join('; ');
  const driverLine = leadDriver
    ? `${leadDriver.title} is the strongest visible driver in this bounded preview${leadDriver.value ? ` (${leadDriver.value})` : ''}.${nextDriver ? ` The next visible comparison is ${nextDriver.title}${nextDriver.value ? ` (${nextDriver.value})` : ''}.` : ''}`
    : 'The report does not yet have ranked drivers. Add a clearer metric, time grain, or segment field before treating the analysis as complete.';
  const contextLine = [
    source ? `source: ${source}` : '',
    filters ? `filters: ${filters}` : '',
  ].filter(Boolean).join('; ');
  const decisionHeading = report.actionMode === 'block'
    ? '## Reusable logic decision'
    : report.actionMode === 'evidence' || report.intent === 'trust_gap_review'
      ? '## Validation result'
      : '## Business interpretation';
  const decisionText = report.actionMode === 'block'
    ? 'This is a candidate reusable saved query design, not a certified answer yet. Preserve the business question, parameter defaults, allowed filters, output grain, and proof path before certification.'
    : report.actionMode === 'evidence' || report.intent === 'trust_gap_review'
      ? `The claim should be treated as validated only inside this bounded analysis context${contextLine ? ` (${contextLine})` : ''}. Use the appendix when a reviewer needs SQL, preview rows, caveats, or source trace.`
      : `${driverLine} Treat the conclusion as a directional stakeholder explanation until the analyst confirms SQL, grain, filters, joins, and lineage.`;
  const sections: string[] = [
    '## Executive answer',
    report.summary,
    decisionHeading,
    decisionText,
  ];
  if (evidenceLine) {
    sections.push('## Key numbers', `The bounded preview shows ${evidenceLine}. These numbers are useful for review and stakeholder framing but still need source validation before promotion.`);
  }
  sections.push(
    '## Recommended next step',
    report.recommendation,
    '## Review boundary',
    'This report is AI-generated and review-required. Use it to guide analysis, then validate SQL, grain, filters, joins, and source proof before pinning it to the app or turning it into a reusable saved query.',
  );
  return sections.join('\n\n');
}

function ResearchReportSections({
  sections,
}: {
  sections: ReturnType<typeof buildResearchReport>['sections'];
}) {
  return (
    <div className="dql-app-report-dynamic-sections">
      {sections.map((section) => (
        <section key={section.id} className={`dql-app-report-dynamic-section tone-${section.tone ?? 'neutral'}`}>
          <div className="dql-app-report-dynamic-head">
            <span>{reportSectionKicker(section)}</span>
            <h3>{section.title}</h3>
          </div>
          <MemoSectionBody text={section.body} />
          {section.bullets?.length ? (
            <ul>
              {section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function MemoSectionBody({ text }: { text: string }) {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
  if (!paragraphs.length) return null;
  return (
    <div className="dql-app-report-memo-body">
      {paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
    </div>
  );
}

function reportSectionKicker(section: NonNullable<LocalAppInvestigation['reportSections']>[number]): string {
  switch (section.kind) {
    case 'executive_answer':
      return 'Answer';
    case 'business_interpretation':
      return 'Interpretation';
    case 'key_numbers':
      return 'Numbers';
    case 'validation':
      return 'Proof';
    case 'reusable_logic':
      return 'Reusable logic';
    case 'recommended_next_step':
      return 'Next step';
    case 'review_boundary':
      return 'Review boundary';
    default:
      if (/focus/i.test(section.title)) return 'Scope';
      if (/repair|preview|sql/i.test(section.title)) return 'Appendix note';
      return 'Report note';
  }
}

function normalizeResearchReportSections(value: LocalAppInvestigation['reportSections']): Array<NonNullable<LocalAppInvestigation['reportSections']>[number]> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((section): section is NonNullable<LocalAppInvestigation['reportSections']>[number] => {
      return Boolean(section)
        && typeof section.title === 'string'
        && section.title.trim().length > 0
        && typeof section.body === 'string'
        && section.body.trim().length > 0;
    })
    .slice(0, 8)
    .map((section, index) => ({
      ...section,
      id: section.id || `section-${index + 1}`,
      title: section.title.trim(),
      body: section.body.trim(),
      bullets: Array.isArray(section.bullets) ? section.bullets.filter(Boolean).slice(0, 8) : undefined,
      evidenceRefs: Array.isArray(section.evidenceRefs) ? section.evidenceRefs.filter(Boolean).slice(0, 8) : undefined,
    }));
}

function ResearchEvidence({
  investigation,
  tab,
  sqlDraft,
  onSqlDraftChange,
}: {
  investigation: LocalAppInvestigation;
  tab: 'preview' | 'sql' | 'assumptions' | 'context';
  sqlDraft: string;
  onSqlDraftChange: (value: string) => void;
}) {
  if (tab === 'sql') {
    return (
      <div className="dql-app-research-sql-review">
        <textarea
          value={sqlDraft}
          onChange={(event) => onSqlDraftChange(event.target.value)}
          spellCheck={false}
          placeholder="Generated SQL will appear here for review."
        />
        {investigation.error ? <div className="dql-app-error">{investigation.error}</div> : null}
      </div>
    );
  }
  const evidence = asUiRecord(investigation.evidence);
  if (tab === 'assumptions') {
    const assumptions = Array.isArray(evidence.assumptions) ? evidence.assumptions : [];
    const trust = asUiRecord(evidence.trustStatus);
    return (
      <div className="dql-app-research-assumptions">
        {assumptions.length ? assumptions.map((item, index) => <p key={index}>{String(item)}</p>) : <p>Refresh the report to capture assumptions.</p>}
        <KeyValueInline label="Trust" value={String(trust.label ?? 'AI-generated report')} />
        <KeyValueInline label="Review" value={investigation.reviewStatus} />
      </div>
    );
  }
  if (tab === 'context') {
    return (
      <pre className="dql-app-research-code">
        {JSON.stringify({
          certifiedContext: evidence.certifiedContext,
          trustStatus: evidence.trustStatus,
          planner: evidence.planner,
        }, null, 2)}
      </pre>
    );
  }
  return <ResearchPreviewTable investigation={investigation} />;
}

function ResearchPreviewTable({ investigation }: { investigation: LocalAppInvestigation }) {
  const preview = firstResearchPreview(investigation);
  if (!preview) return <EmptyPanel title="No preview rows yet." detail="Refresh the report with SQL or selected tile results to capture proof." compact />;
  const result = asUiRecord(preview.result);
  const rows = Array.isArray(result.rows) ? result.rows.map(asUiRecord).filter((row): row is Record<string, unknown> => Boolean(row)).slice(0, 8) : [];
  const columns = Array.isArray(result.columns) ? result.columns.map(String).slice(0, 8) : Object.keys(rows[0] ?? {}).slice(0, 8);
  if (!rows.length || !columns.length) return <EmptyPanel title="No preview rows yet." detail="The report captured proof, but no row preview was available." compact />;
  return (
    <div className="dql-app-research-table">
      <table>
        <thead>
          <tr>{columns.map((column) => <th key={column}>{formatBusinessLabel(column)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function firstResearchPreview(investigation: LocalAppInvestigation): Record<string, unknown> | null {
  const previews = Array.isArray(investigation.resultPreviews) ? investigation.resultPreviews : [];
  return previews.map(asUiRecord).find((preview) => Boolean(preview.result)) ?? null;
}

export function upsertInvestigation(items: LocalAppInvestigation[], next: LocalAppInvestigation): LocalAppInvestigation[] {
  const without = items.filter((item) => item.id !== next.id);
  return sortResearchInvestigations([next, ...without]);
}

export function sortResearchInvestigations(items: LocalAppInvestigation[]): LocalAppInvestigation[] {
  return [...items].sort((a, b) => researchTimestamp(b) - researchTimestamp(a));
}

function researchTimestamp(item: LocalAppInvestigation): number {
  const value = new Date(item.updatedAt || item.lastRunAt || item.createdAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

function formatResearchListTitle(item: LocalAppInvestigation): string {
  const cleaned = item.title
    .replace(/^\s*(write\s+the\s+report\s+brief|the\s+research\s+question|research\s+question)\s*:\s*/i, '')
    .replace(/^\s*research\b/i, 'Analysis')
    .replace(/^\s*report\b/i, 'Analysis')
    .trim();
  const title = formatBusinessLabel(cleaned || item.title);
  if (title.length <= 64) return title;
  return `${title.slice(0, 61).trim()}...`;
}

function formatResearchListMeta(item: LocalAppInvestigation): string {
  const status = item.status === 'error'
    ? 'Needs SQL review'
    : item.status === 'ready'
      ? 'Ready'
      : item.status === 'running'
        ? 'Running'
        : 'Draft';
  const time = formatResearchAge(item.updatedAt || item.lastRunAt || item.createdAt);
  return `${formatBusinessLabel(item.intent)} / ${status}${time ? ` / ${time}` : ''}`;
}

function formatResearchAge(value?: string): string {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function researchIntentFromPrompt(text: string): LocalAppInvestigation['intent'] {
  const value = text.toLowerCase();
  if (/\b(trust|rely|certif|lineage|gap|caveat)\b/.test(value)) return 'trust_gap_review';
  if (/\b(anomal|exception|outlier|spike|dip)\b/.test(value)) return 'anomaly_investigation';
  if (/\b(compare|versus| vs |segment|cohort)\b/.test(value)) return 'segment_compare';
  if (/\b(customer|account|user|client|alice|johnson|entity)\b/.test(value)) return 'entity_drilldown';
  if (/\b(why|changed|change|drop|decline|increase|decrease)\b/.test(value)) return 'diagnose_change';
  return 'driver_breakdown';
}

function formatResearchValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) >= 100 ? Math.round(value).toLocaleString() : Number(value.toFixed(2)).toLocaleString();
  }
  if (typeof value === 'string' && value.trim()) return value;
  return 'n/a';
}
