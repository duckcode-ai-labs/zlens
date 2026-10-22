import React, { useState } from 'react';
import type { AgentAnswerCascade, AgentTurn } from '../../llm/types';
import type { AiRoute, CellChartConfig, QueryResult } from '../../store/types';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import { api } from '../../api/client';
import { ChartOutput, CHART_TYPE_OPTIONS, categoryColumns, measureColumns, resolveChartType } from '../output/ChartOutput';
import { TableOutput } from '../output/TableOutput';
import { deriveResultChartConfig } from '../output/ResultView';
import { TrustBadge, DerivationWalkPanel, type TrustState } from '@zlens/ui';
import type { Business360ResultV2 } from '@zlens/core/lineage';
import { buildDerivationWalk, type DerivationWalk } from '@zlens/core/lineage/derivation';
import { useNotebook } from '../../store/NotebookStore';
import { formatDisplayValue, type DisplayColumnMeta } from '../../utils/value-format';
import { GuidedBySkills, RouteBadge } from './AiBuildResult';

type AnswerTab = 'answer' | 'dql' | 'visual' | 'data' | 'lineage' | 'context' | 'sql' | 'review';

export interface AgentAnswerInvestigationRequest {
  question: string;
  title?: string;
  answerSummary?: string;
  blockName?: string;
  sql?: string;
  evidence?: unknown;
}

interface EvidenceRouteStep {
  tool?: string;
  status?: string;
  label?: string;
  detail?: string;
}

interface EvidenceAsset {
  nodeId?: string;
  kind?: string;
  name?: string;
  description?: string;
  sourceTier?: string;
  certification?: string;
  provenance?: string;
  sourcePath?: string;
  owner?: string;
  domain?: string;
  status?: string;
  role?: string;
}

interface EvidenceContextItem {
  label?: string;
  value?: string;
  source?: string;
}

interface AgentEvidence {
  route?: EvidenceRouteStep[];
  lineage?: EvidenceAsset[];
  businessContext?: EvidenceContextItem[];
  analysisPlan?: AgentAnalysisPlan;
  outcome?: {
    name?: string;
    owner?: string;
    decisionUse?: string;
    reviewCadence?: string;
    caveats?: string[];
  };
  selectedAssets?: EvidenceAsset[];
  sourceTables?: EvidenceAsset[];
  semanticObjects?: EvidenceAsset[];
  validation?: {
    status?: string;
    message?: string;
  };
  execution?: {
    status?: string;
    message?: string;
    rowCount?: number;
    executionTime?: number;
  };
  citations?: Array<{ kind?: string; name?: string; provenance?: string }>;
}

interface AgentAnalysisPlan {
  question?: string;
  intent?: string;
  routeReason?: string;
  grain?: string;
  measures?: string[];
  dimensions?: string[];
  candidateTables?: Array<{ relation?: string; columns?: string[]; reason?: string }>;
  candidateJoins?: Array<{ leftRelation?: string; leftColumn?: string; rightRelation?: string; rightColumn?: string; reason?: string }>;
  trustedContext?: Array<{ kind?: string; name?: string; certification?: string; sourceTier?: string }>;
  assumptions?: string[];
  sql?: string;
  suggestedViz?: string;
  followUps?: string[];
  repairAttempts?: number;
}

interface AgentDqlArtifact {
  kind?: 'certified_block' | 'semantic_block' | 'sql_block' | string;
  source?: string;
  name?: string;
  sourcePath?: string;
  metrics?: string[];
  dimensions?: string[];
  filters?: Array<{ dimension?: string; operator?: string; values?: string[] }>;
  timeDimension?: { name?: string; granularity?: string };
  orderBy?: Array<{ name?: string; direction?: 'asc' | 'desc' | string }>;
  limit?: number;
}

export interface AgentDqlArtifactMeta {
  kind?: string;
  source: string;
  name?: string;
  sourcePath?: string;
  metrics: string[];
  dimensions: string[];
  filters: string[];
  timeDimension?: string;
  orderBy: string[];
  limit?: number;
}

export interface AgentAnswerEnvelope {
  kind: 'certified' | 'uncertified' | 'no_answer';
  /** Effective host-issued result trust. Takes precedence over legacy display fields. */
  trustState?: string;
  sourceTier?: string;
  certification?: string;
  reviewStatus?: string;
  trustLabel?: string;
  /** Canonical trust stamp from the answer loop (single source of truth). */
  trustLabelInfo?: { id?: string; display?: string };
  confidence?: number;
  text?: string;
  answer?: string;
  sql?: string;
  proposedSql?: string;
  suggestedViz?: string;
  block?: { name?: string; sourcePath?: string; status?: string; domain?: string };
  result?: {
    columns?: unknown[];
    rows?: unknown[];
    rowCount?: number;
    columnsMeta?: unknown[];
    resultFingerprint?: string;
    executionReceipt?: Record<string, unknown>;
    trustState?: string;
    answerTier?: string;
    executionTime?: number;
    chartConfig?: unknown;
    sql?: string;
    blockName?: string;
    blockPath?: string;
  };
  executionError?: string;
  citations?: Array<{ kind?: string; name?: string; provenance?: string }>;
  evidence?: AgentEvidence;
  analysisPlan?: AgentAnalysisPlan;
  sourceCertifiedBlock?: string;
  contextPackId?: string;
  validationWarnings?: string[];
  selectedEvidence?: unknown[];
  draftBlockId?: string;
  draftBlock?: { path?: string; name?: string };
  promoteCommand?: string;
  dqlArtifact?: AgentDqlArtifact;
  // Spec 16 — business-context skills that guided this answer (backend-populated).
  appliedSkills?: Array<{ id: string; description?: string }>;
  // Spec 17 (part C) — how this answer was reached (backend-populated).
  route?: AiRoute;
  cascade?: AgentAnswerCascade;
}

export function resolveDqlArtifactMeta(answer: AgentAnswerEnvelope): AgentDqlArtifactMeta | null {
  const artifact = answer.dqlArtifact;
  const source = artifact?.source?.trim();
  if (!source) return null;
  return {
    source,
    kind: artifact?.kind,
    name: artifact?.name,
    sourcePath: artifact?.sourcePath,
    metrics: cleanStringList(artifact?.metrics),
    dimensions: cleanStringList(artifact?.dimensions),
    filters: (artifact?.filters ?? [])
      .map((filter) => {
        const dimension = filter.dimension?.trim();
        const operator = filter.operator?.trim() || 'equals';
        const values = cleanStringList(filter.values);
        if (!dimension || values.length === 0) return '';
        return `${dimension} ${operator} ${values.join(', ')}`;
      })
      .filter(Boolean),
    timeDimension: artifact?.timeDimension?.name
      ? [artifact.timeDimension.name, artifact.timeDimension.granularity].filter(Boolean).join(' / ')
      : undefined,
    orderBy: (artifact?.orderBy ?? [])
      .map((order) => {
        const name = order.name?.trim();
        const direction = order.direction?.trim();
        return name && direction ? `${name} ${direction}` : '';
      })
      .filter(Boolean),
    limit: typeof artifact?.limit === 'number' && Number.isFinite(artifact.limit) ? artifact.limit : undefined,
  };
}

export function extractGovernedAnswer(events: AgentTurn[]): AgentAnswerEnvelope | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind !== 'tool_result' || event.id !== 'governed_answer') continue;
    const output = event.output;
    if (output && typeof output === 'object' && 'kind' in output) return output as AgentAnswerEnvelope;
  }
  return null;
}

function cleanStringList(values: unknown): string[] {
  return Array.isArray(values)
    ? values.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean)
    : [];
}

function normalizeAgentResult(answer: AgentAnswerEnvelope): QueryResult | null {
  const result = answer.result;
  if (!result || !Array.isArray(result.rows)) return null;
  const rawColumns = Array.isArray(result.columns) ? result.columns : [];
  const columns = rawColumns.map((column) => {
    if (typeof column === 'string') return column;
    if (column && typeof column === 'object' && typeof (column as { name?: unknown }).name === 'string') {
      return String((column as { name: unknown }).name);
    }
    return String(column);
  });
  const inferredColumns = columns.length > 0
    ? columns
    : result.rows.find((row) => row && typeof row === 'object' && !Array.isArray(row))
      ? Object.keys(result.rows.find((row) => row && typeof row === 'object' && !Array.isArray(row)) as Record<string, unknown>)
      : result.rows.find((row) => Array.isArray(row))
        ? (result.rows.find((row) => Array.isArray(row)) as unknown[]).map((_, index) => `column_${index + 1}`)
        : [];
  const rows = result.rows.map((row): Record<string, unknown> => {
    if (Array.isArray(row)) return Object.fromEntries(inferredColumns.map((column, index) => [column, row[index]]));
    if (row && typeof row === 'object') {
      const record = row as Record<string, unknown>;
      return Object.fromEntries(inferredColumns.map((column) => [column, record[column]]));
    }
    return Object.fromEntries(inferredColumns.map((column) => [column, undefined]));
  });
  const columnsMeta = Array.isArray(result.columnsMeta)
    ? result.columnsMeta.filter((meta): meta is QueryResult['columnsMeta'] extends (infer M)[] | undefined ? M : never =>
        Boolean(meta && typeof meta === 'object' && typeof (meta as { name?: unknown }).name === 'string' && typeof (meta as { kind?: unknown }).kind === 'string'))
    : [];
  return {
    columns: inferredColumns,
    rows,
    rowCount: typeof result.rowCount === 'number' ? result.rowCount : rows.length,
    ...(columnsMeta.length ? { columnsMeta } : {}),
    ...(typeof result.resultFingerprint === 'string' ? { resultFingerprint: result.resultFingerprint } : {}),
    ...(result.executionReceipt && typeof result.executionReceipt === 'object' ? { executionReceipt: result.executionReceipt } : {}),
    ...(typeof result.trustState === 'string' ? { trustState: result.trustState } : {}),
    ...(typeof result.answerTier === 'string' ? { answerTier: result.answerTier } : {}),
    executionTime: result.executionTime,
  };
}

function normalizeChartConfig(config: unknown, answer: AgentAnswerEnvelope): CellChartConfig | undefined {
  const raw = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  const authoredChart = typeof raw.chart === 'string' ? raw.chart : undefined;
  const storedDecisionSource = raw.decisionSource === 'authored' || raw.decisionSource === 'agent'
    || raw.decisionSource === 'data' || raw.decisionSource === 'user'
    ? raw.decisionSource
    : undefined;
  const chart = authoredChart
    ? authoredChart
    : typeof answer.suggestedViz === 'string'
      ? answer.suggestedViz
      : undefined;
  const normalizedChart = chart
    ? chart.toLowerCase().replace(/_/g, '-') === 'single-value' ? 'kpi' : chart
    : undefined;
  return {
    ...(normalizedChart ? { chart: normalizedChart } : {}),
    ...(normalizedChart ? { decisionSource: storedDecisionSource ?? (authoredChart ? 'authored' : 'agent' as const) } : {}),
    ...(typeof raw.rationale === 'string' ? { rationale: raw.rationale } : {}),
    ...(typeof raw.x === 'string' ? { x: raw.x } : {}),
    ...(typeof raw.y === 'string' ? { y: raw.y } : {}),
    ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
  };
}

function completeChartConfig(config: CellChartConfig | undefined, result: QueryResult | null): CellChartConfig | undefined {
  if (!result || result.columns.length === 0) return config;
  return deriveResultChartConfig(result, config).config;
}

function cleanQuestion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
}

function compactAgentAnswerSummary(value: string): string {
  const answer = extractAgentAnswerSection(value, ['Answer', 'Business summary', 'Summary']);
  if (answer) return truncateAgentAnswer(answer, 340);
  const stopRegex = /^(?:reuse evidence|certified result preview|result preview|result summary|trust status|next action|recommended action|sql used by block|reusable block sql|proposed sql|sql generated|sql draft|evidence|parameters|lineage|technical lineage)\s*:/i;
  const sqlRegex = /^(?:SELECT|WITH|FROM|WHERE|GROUP BY|ORDER BY|LIMIT)\b/i;
  const collected: string[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s*/.test(line) || /^```/.test(line) || /^\|/.test(line)) continue;
    if (/^outcome\s*:/i.test(line)) continue;
    if (stopRegex.test(line) || sqlRegex.test(line)) {
      if (collected.length > 0) break;
      continue;
    }
    collected.push(line);
    if (collected.length >= 5) break;
  }
  const clean = collected.join(' ')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateAgentAnswer(clean, 340);
}

function extractAgentAnswerSection(value: string, headings: string[]): string | undefined {
  const lines = value.split(/\r?\n/);
  const headingPattern = headings
    .map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const startRegex = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:[-*]\\s*)?(?:\\*\\*)?(${headingPattern})(?:\\*\\*)?\\s*:\\s*(.*)$`, 'i');
  const boundaryRegex = /^\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?[A-Z][A-Za-z /-]{2,42}(?:\*\*)?\s*:/;
  const startIndex = lines.findIndex((line) => startRegex.test(line));
  if (startIndex < 0) return undefined;
  const first = lines[startIndex]?.match(startRegex)?.[2]?.trim() ?? '';
  const collected = first ? [first] : [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (boundaryRegex.test(line)) break;
    if (/^\s*```/.test(line)) break;
    if (line.trim()) collected.push(line.trim());
  }
  const clean = collected.join(' ').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
  return clean || undefined;
}

function truncateAgentAnswer(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  const clipped = clean.slice(0, maxLength - 1);
  const sentenceEnd = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('; '));
  if (sentenceEnd > 100) return clipped.slice(0, sentenceEnd + 1).trim();
  const wordEnd = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, wordEnd > 80 ? wordEnd : clipped.length).trim()}...`;
}

export function AgentAnswerCard({
  answer,
  themeMode,
  showSql = true,
  compact = false,
  sourceQuestion,
  onInvestigate,
  onInsertSql,
  onCreateBlock,
}: {
  answer: AgentAnswerEnvelope;
  themeMode: ThemeMode;
  showSql?: boolean;
  compact?: boolean;
  sourceQuestion?: string;
  onInvestigate?: (request: AgentAnswerInvestigationRequest) => void;
  onInsertSql?: (
    sql: string,
    title?: string,
    meta?: { question?: string; sourceRunId?: string },
  ) => void;
  onCreateBlock?: (sql: string, meta: { title?: string; description?: string; tags?: string[] }) => void;
}) {
  const t = themes[themeMode];
  const { dispatch } = useNotebook();
  const result = normalizeAgentResult(answer);
  const baseChartConfig = normalizeChartConfig(answer.result?.chartConfig, answer);
  const [chartConfigOverride, setChartConfigOverride] = useState<CellChartConfig | undefined>();
  const chartConfig = completeChartConfig({ ...(baseChartConfig ?? {}), ...(chartConfigOverride ?? {}) }, result);
  const hasChart = Boolean(result && resolveChartType(result, chartConfig) !== 'table');
  const analysisPlan = answer.analysisPlan ?? answer.evidence?.analysisPlan;
  const sql = showSql ? answer.sql ?? answer.result?.sql ?? answer.proposedSql ?? analysisPlan?.sql : undefined;
  const dqlArtifact = resolveDqlArtifactMeta(answer);
  const executionError = answer.executionError
    ?? (answer.evidence?.execution?.status === 'failed' ? answer.evidence.execution.message : undefined);
  const blockPath = answer.result?.blockPath ?? answer.block?.sourcePath;
  const hasSqlPanel = Boolean(sql || executionError || (showSql && blockPath));
  const hasEvidence = Boolean(answer.evidence);
  const [tab, setTab] = useState<AnswerTab>('answer');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const trustState = resolveAnswerTrustState(answer);
  const trustAccent = trustStateColor(trustState, t);
  const rawSummary = (answer.answer ?? answer.text ?? '').replace(/\n\n_Question:_[\s\S]*$/m, '').trim();
  const summary = compact ? compactAgentAnswerSummary(rawSummary) : rawSummary;
  const blockName = answer.result?.blockName ?? answer.block?.name ?? answer.citations?.find((c) => c.kind === 'block')?.name;
  const investigationBlockName = resolveInvestigationBlockName(answer, blockName);
  const provenance = buildAnswerProvenance(answer, result, blockName, blockPath);
  const [insertMessage, setInsertMessage] = useState<string | null>(null);
  const canInsertSql = Boolean(onInsertSql && sql);
  const canCreateBlock = Boolean(onCreateBlock && sql);
  const investigationQuestion = cleanQuestion(analysisPlan?.question)
    ?? cleanQuestion(sourceQuestion)
    ?? cleanQuestion(summary)
    ?? 'Investigate this answer';
  const canInvestigate = Boolean(onInvestigate && investigationQuestion);
  const outcome = resolveAgentOutcome(answer, {
    sql,
    executionError,
    blockName,
    blockPath,
    result,
  });
  const insertSql = () => {
    if (!onInsertSql || !sql) return;
    onInsertSql(sql, blockName ?? analysisPlan?.question ?? 'AI SQL preview', {
      question: sourceQuestion ?? analysisPlan?.question,
    });
    setInsertMessage('Inserted SQL preview cell for review.');
  };
  const createBlock = () => {
    if (!onCreateBlock || !sql) return;
    onCreateBlock(sql, {
      title: dqlArtifact?.name ?? blockName ?? analysisPlan?.question ?? 'AI DQL draft',
      description: summary || analysisPlan?.routeReason || 'AI generated DQL draft.',
      tags: ['ai-generated', 'review-required'],
    });
  };
  const investigate = () => {
    if (!onInvestigate || !investigationQuestion) return;
    onInvestigate({
      question: investigationQuestion,
      title: investigationBlockName ? `${investigationBlockName}: ${investigationQuestion}` : investigationQuestion,
      answerSummary: summary,
      blockName: investigationBlockName,
      sql,
      evidence: answer.evidence,
    });
  };
  const tabItems: Array<{ id: AnswerTab; label: string; visible: boolean }> = [
    { id: 'answer', label: compact ? 'Summary' : 'Answer', visible: true },
    { id: 'dql', label: 'DQL', visible: Boolean(dqlArtifact) },
    { id: 'visual', label: compact ? 'Chart' : 'Visualization', visible: hasChart },
    { id: 'data', label: 'Data', visible: Boolean(result) },
    { id: 'sql', label: 'SQL / Saved query', visible: showSql && hasSqlPanel },
    { id: 'lineage', label: compact ? 'Trace' : 'Lineage', visible: hasEvidence },
    { id: 'context', label: compact ? 'Context' : 'Business Context', visible: hasEvidence },
    { id: 'review', label: compact ? 'Trust' : 'Review', visible: hasEvidence || Boolean(answer.citations?.length) },
  ];
  const tabs = tabItems.filter((item) => item.visible);
  const activeTab = tabs.some((item) => item.id === tab) ? tab : 'answer';
  const detailTabs = tabs.filter((item) => item.id !== 'answer');
  const activeDetailTab = detailTabs.some((item) => item.id === tab) ? tab : detailTabs[0]?.id;
  const renderTabPanel = (targetTab: AnswerTab) => {
    if (targetTab === 'answer') {
      return (
        <AnswerPanel
          summary={summary}
          answer={answer}
          blockName={blockName}
          evidence={answer.evidence}
          analysisPlan={analysisPlan}
          result={result}
          sourceTier={answer.sourceTier}
          compact={compact}
          t={t}
        />
      );
    }
    if (targetTab === 'dql' && dqlArtifact) return <DqlArtifactPanel artifact={dqlArtifact} t={t} />;
    if (targetTab === 'visual' && result && hasChart) {
      return (
        <div style={{ padding: compact ? '8px 10px' : '10px 12px', minHeight: compact ? 180 : 220, display: 'grid', gap: 10 }}>
          <ChartCustomizationPanel
            result={result}
            chartConfig={chartConfig}
            t={t}
            onChange={(next) => setChartConfigOverride((current) => ({ ...(current ?? {}), ...next, decisionSource: 'user', rationale: 'Adjusted manually.' }))}
          />
          <ChartOutput result={result} themeMode={themeMode} chartConfig={chartConfig} />
        </div>
      );
    }
    if (targetTab === 'data' && result) {
      return (
        <div style={{ maxHeight: compact ? 320 : 420, overflow: 'auto' }}>
          <TableOutput result={result} themeMode={themeMode} />
        </div>
      );
    }
    if (targetTab === 'lineage') return <LineagePanel evidence={answer.evidence} t={t} />;
    if (targetTab === 'context') return <BusinessContextPanel evidence={answer.evidence} t={t} />;
    if (targetTab === 'sql' && showSql && hasSqlPanel) return <SqlPanel sql={sql} blockPath={blockPath} executionError={executionError} t={t} />;
    if (targetTab === 'review') return <ReviewPanel answer={answer} t={t} />;
    return null;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 10, whiteSpace: 'normal' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <TrustBadge state={trustState} />
        <RouteBadge t={t} route={answer.route} />
        {formatCascadeOutcome(answer.cascade) && (
          <span
            style={{
              border: `1px solid ${t.cellBorder}`,
              borderRadius: 999,
              padding: '3px 8px',
              fontSize: 11,
              fontWeight: 700,
              color: t.textSecondary,
              background: t.tableHeaderBg,
            }}
          >
            {formatCascadeOutcome(answer.cascade)}
          </span>
        )}
        {!compact && blockName && (
          <span style={{ fontSize: 12, fontFamily: t.fontMono, color: t.textSecondary }}>
            block: {blockName}
          </span>
        )}
        {result && (
          <span style={{ fontSize: 12, color: t.textMuted }}>
            {(result.rowCount ?? result.rows.length).toLocaleString()} rows
            {result.executionTime !== undefined && <> - {Math.round(result.executionTime)}ms</>}
          </span>
        )}
        {canInvestigate && (
          <button
            type="button"
            onClick={investigate}
            style={{
              border: `1px solid ${t.accent}`,
              borderRadius: 6,
              background: `${t.accent}12`,
              color: t.accent,
              cursor: 'pointer',
              padding: compact ? '4px 8px' : '5px 10px',
              fontSize: 11,
              fontFamily: t.font,
              fontWeight: 800,
            }}
          >
            {compact ? 'Investigate' : 'Investigate deeper'}
          </button>
        )}
        {canCreateBlock && (
          <button
            type="button"
            onClick={createBlock}
            style={{
              border: `1px solid ${t.accent}`,
              borderRadius: 6,
              background: t.cellBg,
              color: t.accent,
              cursor: 'pointer',
              padding: compact ? '4px 8px' : '5px 10px',
              fontSize: 11,
              fontFamily: t.font,
              fontWeight: 700,
            }}
          >
            {compact ? 'DQL draft' : dqlArtifact ? 'Review DQL draft' : 'Create DQL draft'}
          </button>
        )}
        {canInsertSql && (
          <button
            type="button"
            onClick={insertSql}
            style={{
              border: `1px solid ${t.accent}`,
              borderRadius: 6,
              background: `${t.accent}18`,
              color: t.accent,
              cursor: 'pointer',
              padding: compact ? '4px 8px' : '5px 10px',
              fontSize: 11,
              fontFamily: t.font,
              fontWeight: 700,
            }}
          >
            {compact ? 'SQL preview' : 'Insert SQL preview'}
          </button>
        )}
      </div>
      {insertMessage && <div style={{ fontSize: 11, color: '#3fb950' }}>{insertMessage}</div>}
      <OutcomeBanner outcome={outcome} t={t} compact={compact} />

      <div style={{ border: `1px solid ${t.cellBorder}`, borderTop: `2px solid ${trustAccent}`, borderRadius: compact ? 10 : 6, overflow: 'hidden', background: t.cellBg }}>
        {!compact && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '4px 10px', borderBottom: `1px solid ${t.cellBorder}`, background: `${t.tableHeaderBg}70`, flexWrap: 'wrap' }}>
            {tabs.map((item) => (
              <SegmentButton key={item.id} active={activeTab === item.id} label={item.label} onClick={() => setTab(item.id)} t={t} />
            ))}
            {!showSql && blockPath && (
              <span style={{ marginLeft: 'auto', minWidth: 0, fontSize: 11, fontFamily: t.fontMono, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {blockPath}
              </span>
            )}
          </div>
        )}
        {compact ? renderTabPanel('answer') : renderTabPanel(activeTab)}
        {compact && detailTabs.length > 0 && (
          <div style={{ borderTop: `1px solid ${t.cellBorder}`, background: `${t.tableHeaderBg}45` }}>
            <button
              type="button"
              onClick={() => setDetailsOpen((value) => !value)}
              style={{
                width: '100%',
                border: 0,
                background: 'transparent',
                color: t.textSecondary,
                padding: '8px 12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 800,
              }}
            >
              <span>Details</span>
              <span style={{ color: t.textMuted, fontFamily: t.fontMono }}>{detailsOpen ? 'hide' : 'show evidence'}</span>
            </button>
            {detailsOpen && (
              <div style={{ borderTop: `1px solid ${t.cellBorder}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '4px 12px', flexWrap: 'wrap' }}>
                  {detailTabs.map((item) => (
                    <SegmentButton key={item.id} active={activeDetailTab === item.id} label={item.label} onClick={() => setTab(item.id)} t={t} />
                  ))}
                </div>
                {activeDetailTab ? renderTabPanel(activeDetailTab) : null}
              </div>
            )}
          </div>
        )}
        <ProvenanceFooter items={provenance} t={t} accent={trustAccent} />
        <GuidedBySkills
          t={t}
          skills={answer.appliedSkills}
          onOpenSkills={() => dispatch({ type: 'SET_MAIN_VIEW', view: 'skills' })}
          onSuggestCorrection={(skill) => {
            try { window.sessionStorage.setItem('dql-skill-ai-correction', JSON.stringify({ skillId: skill.id, question: sourceQuestion, feedback: 'Correct the guidance that shaped this answer.' })); } catch { /* best effort */ }
            dispatch({ type: 'SET_MAIN_VIEW', view: 'skills' });
          }}
        />
      </div>
    </div>
  );
}

type AgentOutcomeKind =
  | 'reuse_certified_block'
  | 'use_existing_draft'
  | 'generate_sql_cell'
  | 'fix_sql'
  | 'create_dql_draft'
  | 'needs_review'
  | 'cannot_answer';

interface AgentOutcome {
  kind: AgentOutcomeKind;
  label: string;
  detail: string;
  nextAction: string;
  tone: 'success' | 'accent' | 'warning' | 'error' | 'muted';
}

export function resolveAgentOutcome(
  answer: AgentAnswerEnvelope,
  context: {
    sql?: string;
    executionError?: string;
    blockName?: string;
    blockPath?: string;
    result: QueryResult | null;
  },
): AgentOutcome {
  if (answer.kind === 'no_answer') {
    return {
      kind: 'cannot_answer',
      label: 'Cannot answer yet',
      detail: 'The assistant did not find enough trusted context to safely answer or generate SQL.',
      nextAction: 'Clarify the business object, metric, grain, or source table.',
      tone: 'error',
    };
  }
  if (answer.certification === 'certified' || answer.kind === 'certified') {
    const block = context.blockName ?? answer.sourceCertifiedBlock ?? answer.block?.name;
    return {
      kind: 'reuse_certified_block',
      label: 'Reuse certified saved query',
      detail: block ? `Existing saved query ${block} answers this request.` : 'A certified DQL artifact answers this request.',
      nextAction: 'Use the certified saved query instead of creating duplicate SQL.',
      tone: 'success',
    };
  }
  if (context.executionError || answer.executionError) {
    return {
      kind: 'fix_sql',
      label: 'Fix SQL',
      detail: 'The generated or selected SQL needs correction before it can become reusable DQL.',
      nextAction: 'Ask AI to repair, edit manually, then rerun preview.',
      tone: 'error',
    };
  }
  if (answer.draftBlock?.path || answer.draftBlockId) {
    return {
      kind: 'use_existing_draft',
      label: 'Use existing draft',
      detail: `A review-required DQL draft is available at ${answer.draftBlock?.path ?? answer.draftBlockId}.`,
      nextAction: 'Open the draft, review metadata/tests/lineage, then certify manually.',
      tone: 'accent',
    };
  }
  if (answer.dqlArtifact?.source?.trim()) {
    return {
      kind: 'create_dql_draft',
      label: 'Review DQL draft',
      detail: 'A review-required DQL artifact is available for analyst review.',
      nextAction: 'Review DQL metadata, query logic, lineage, and result preview before certification.',
      tone: 'warning',
    };
  }
  if (context.sql) {
    return {
      kind: context.result ? 'generate_sql_cell' : 'create_dql_draft',
      label: context.result ? 'Review SQL preview' : 'Create DQL draft',
      detail: context.result
        ? `Review-required SQL preview returned ${(context.result.rowCount ?? context.result.rows.length).toLocaleString()} row${(context.result.rowCount ?? context.result.rows.length) === 1 ? '' : 's'}.`
        : 'Review-required SQL is available but still needs preview and DQL metadata review.',
      nextAction: context.result
        ? 'Create a DQL draft after reviewing parameters and lineage; insert SQL only as a notebook preview.'
        : 'Run preview, inspect parameters, then create a draft saved query.',
      tone: 'warning',
    };
  }
  return {
    kind: 'needs_review',
    label: 'Needs review',
    detail: 'The assistant returned business context but no executable certified answer or SQL draft.',
    nextAction: 'Review evidence and ask for a specific SQL, reuse, or DQL draft action.',
    tone: 'muted',
  };
}

function OutcomeBanner({ outcome, t, compact }: { outcome: AgentOutcome; t: Theme; compact?: boolean }) {
  const accent = outcomeToneColor(outcome.tone, t);
  return (
    <div
      style={{
        border: `1px solid ${accent}45`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: compact ? 10 : 7,
        background: `${accent}10`,
        padding: compact ? '9px 10px' : '10px 12px',
        display: 'grid',
        gap: compact ? 4 : 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <span
          style={{
            border: `1px solid ${accent}55`,
            background: `${accent}14`,
            color: accent,
            borderRadius: 999,
            padding: '2px 7px',
            fontSize: 10,
            fontWeight: 850,
            lineHeight: 1.1,
            textTransform: 'uppercase',
            letterSpacing: 0,
            flexShrink: 0,
          }}
        >
          {outcome.label}
        </span>
        <span style={{ fontSize: compact ? 12 : 12.5, color: t.textPrimary, fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {outcome.detail}
        </span>
      </div>
      <div style={{ fontSize: compact ? 11.5 : 12, color: t.textSecondary, lineHeight: 1.45 }}>
        Next: {outcome.nextAction}
      </div>
    </div>
  );
}

function outcomeToneColor(tone: AgentOutcome['tone'], t: Theme): string {
  switch (tone) {
    case 'success':
      return t.success;
    case 'accent':
      return t.accent;
    case 'warning':
      return t.warning;
    case 'error':
      return t.error;
    case 'muted':
    default:
      return t.textMuted;
  }
}

/**
 * Consumer-facing "Why?" affordance. Lazily fetches the business-360 payload
 * for the answer's source block and assembles a plain-language derivation walk
 * (value → block → term/metric → dbt model/source). It deliberately reuses
 * `queryBusiness360` (via the runtime route) plus the answer's evidence/citations
 * and never renders the raw lineage graph. Collapsed by default; additive — if
 * the fetch fails or returns nothing, nothing is shown.
 */
function WhyDerivation({ answer, blockName }: { answer: AgentAnswerEnvelope; blockName: string }) {
  const [walk, setWalk] = useState<DerivationWalk | null>(null);
  const [loading, setLoading] = useState(false);
  const [requested, setRequested] = useState(false);

  const loadWalk = React.useCallback(async () => {
    if (requested) return;
    setRequested(true);
    setLoading(true);
    try {
      const business360 = (await api.fetchBusiness360(blockName)) as Business360ResultV2 | null;
      if (!business360) {
        setWalk(null);
        return;
      }
      const outcome = answer.evidence?.outcome;
      const metricRefs = collectSemanticNames(answer, 'metric');
      const dimensionRefs = collectSemanticNames(answer, 'dimension');
      const generated = answer.certification !== 'certified' && answer.kind !== 'certified';
      const assembled = buildDerivationWalk({
        business360,
        block: {
          name: blockName,
          owner: outcome?.owner,
          status: answer.block?.status ?? answer.certification,
          reviewCadence: outcome?.reviewCadence,
          caveats: outcome?.caveats,
          decisionUse: outcome?.decisionUse,
          metricRefs,
          dimensionRefs,
        },
        value: extractHeadlineValue(answer),
        generated,
        trustLabel: answer.trustLabel,
      });
      setWalk(assembled);
    } catch {
      setWalk(null);
    } finally {
      setLoading(false);
    }
  }, [answer, blockName, requested]);

  // The DerivationWalkPanel owns the open/closed state; we trigger the lazy
  // fetch the first time the consumer expands it via a wrapper button.
  if (!requested) {
    return (
      <button
        type="button"
        onClick={() => void loadWalk()}
        aria-expanded={false}
        style={{
          alignSelf: 'flex-start',
          border: 0,
          background: 'transparent',
          color: 'var(--accent, inherit)',
          cursor: 'pointer',
          padding: '4px 0',
          fontSize: 12,
          fontWeight: 700,
          textDecoration: 'underline',
          textUnderlineOffset: 3,
        }}
      >
        Why? Show how this was derived
      </button>
    );
  }
  if (loading) {
    return <div style={{ fontSize: 11.5, color: 'var(--text-tertiary, inherit)' }}>Assembling derivation…</div>;
  }
  if (!walk) return null;
  return <DerivationWalkPanel walk={walk} defaultOpen />;
}

function collectSemanticNames(answer: AgentAnswerEnvelope, kind: 'metric' | 'dimension'): string[] {
  const fromEvidence = (answer.evidence?.semanticObjects ?? [])
    .filter((asset) => asset.kind === kind)
    .map((asset) => asset.name)
    .filter((name): name is string => Boolean(name));
  if (fromEvidence.length > 0) return fromEvidence;
  const plan = answer.analysisPlan ?? answer.evidence?.analysisPlan;
  return (kind === 'metric' ? plan?.measures : plan?.dimensions) ?? [];
}

export function extractHeadlineValue(answer: AgentAnswerEnvelope): string | undefined {
  const result = answer.result;
  if (result && Array.isArray(result.rows) && result.rows.length === 1) {
    const row = result.rows[0];
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const entries = Object.entries(row as Record<string, unknown>);
      if (entries.length === 1 && (typeof entries[0]![1] === 'number' || typeof entries[0]![1] === 'string')) {
        const [column, value] = entries[0]!;
        // A declared unit renders the headline by contract; a legacy result
        // keeps the raw value exactly as before.
        const meta = normalizeAgentResult(answer)?.columnsMeta?.find((candidate) => candidate.name === column);
        return meta ? formatDisplayValue(column, value, [value], { meta }) : String(value);
      }
    }
  }
  return undefined;
}

function AnswerPanel({
  summary,
  answer,
  blockName,
  evidence,
  analysisPlan,
  result,
  sourceTier,
  compact,
  t,
}: {
  summary: string;
  answer?: AgentAnswerEnvelope;
  blockName?: string;
  evidence?: AgentEvidence;
  analysisPlan?: AgentAnalysisPlan;
  result: QueryResult | null;
  sourceTier?: string;
  compact?: boolean;
  t: Theme;
}) {
  const nextAction = analysisPlan?.followUps?.[0];
  return (
    <div style={{ padding: compact ? 14 : 12, display: 'flex', flexDirection: 'column', gap: compact ? 10 : 12 }}>
      {summary ? (
        <StructuredAnswerText text={summary} t={t} compact={compact} summaryOnly={compact} />
      ) : (
        <div style={{ fontSize: 12, color: t.textMuted }}>No summary text was returned.</div>
      )}
      {answer && blockName && <WhyDerivation answer={answer} blockName={blockName} />}
      {compact ? (
        <div style={{ fontSize: 11.5, color: t.textMuted, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {[
            sourceTier ? formatBusinessTier(sourceTier) : null,
            result ? `${(result.rowCount ?? result.rows.length).toLocaleString()} rows` : null,
            evidence?.validation?.status === 'failed' ? 'needs review' : null,
            evidence?.execution?.status === 'failed' ? 'data check failed' : null,
          ]
            .filter(Boolean)
            .map((label, idx) => (
              <React.Fragment key={`${label}-${idx}`}>
                {idx > 0 && <span style={{ color: t.cellBorder }}>·</span>}
                <span>{label}</span>
              </React.Fragment>
            ))}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {sourceTier && <Pill label={formatLabel(sourceTier)} t={t} />}
          {result && <Pill label={`${(result.rowCount ?? result.rows.length).toLocaleString()} rows`} t={t} />}
          {evidence?.validation?.status && <Pill label={`validation: ${evidence.validation.status}`} t={t} />}
          {evidence?.execution?.status && <Pill label={`execution: ${evidence.execution.status}`} t={t} />}
        </div>
      )}
      {result && !compact && <ResultPreview result={result} t={t} compact={compact} />}
      {analysisPlan && !compact && (
        <div style={{
          display: 'grid',
          gap: 7,
          padding: compact ? '9px 10px' : 10,
          border: `1px solid ${t.cellBorder}`,
          borderRadius: 8,
          background: `${t.tableHeaderBg}45`,
        }}>
          {analysisPlan.routeReason && (
            <div style={{ fontSize: compact ? 12.5 : 12, lineHeight: 1.45, color: t.textSecondary }}>
              {analysisPlan.routeReason}
            </div>
          )}
          {(analysisPlan.grain || analysisPlan.measures?.length || analysisPlan.dimensions?.length) && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {analysisPlan.grain && <Pill label={`grain: ${analysisPlan.grain}`} t={t} />}
              {analysisPlan.measures?.slice(0, 2).map((measure) => <Pill key={`measure-${measure}`} label={measure} t={t} />)}
              {analysisPlan.dimensions?.slice(0, 2).map((dimension) => <Pill key={`dimension-${dimension}`} label={dimension} t={t} />)}
            </div>
          )}
          {analysisPlan.candidateJoins && analysisPlan.candidateJoins.length > 0 && (
            <div style={{ fontSize: 12, color: t.textMuted }}>
              Join: <span style={{ color: t.textSecondary }}>{formatJoinPath(analysisPlan.candidateJoins[0])}</span>
            </div>
          )}
          {nextAction && (
            <div style={{ fontSize: 12, color: t.textMuted }}>
              Next: <span style={{ color: t.textSecondary }}>{nextAction}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function StructuredAnswerText({
  text,
  t,
  compact = false,
  summaryOnly = false,
}: {
  text: string;
  t: Theme;
  compact?: boolean;
  summaryOnly?: boolean;
}) {
  const displayText = summaryOnly ? compactAgentAnswerSummary(text) : text;
  const nodes = renderStructuredAnswer(displayText, t, compact);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 7 : 8,
        color: t.textPrimary,
        fontFamily: t.font,
        overflowWrap: 'anywhere',
      }}
    >
      {nodes}
    </div>
  );
}

function renderStructuredAnswer(text: string, t: Theme, compact: boolean): React.ReactNode[] {
  const lines = normalizeStructuredAnswerText(text).split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      i += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const lang = line.replace(/^```/, '').trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      nodes.push(
        <pre key={`code-${key++}`} style={answerCodeBlockStyle(t, compact)} aria-label={lang ? `${lang} code` : 'code'}>
          {codeLines.join('\n')}
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      nodes.push(
        <div key={`heading-${key++}`} style={answerHeadingStyle(t, compact, level)}>
          {inlineAnswerMarkdown(heading[2], t)}
        </div>,
      );
      i += 1;
      continue;
    }

    if (/^[-*_]{3,}$/.test(line)) {
      nodes.push(<hr key={`hr-${key++}`} style={{ width: '100%', border: 0, borderTop: `1px solid ${t.cellBorder}`, margin: compact ? '2px 0' : '4px 0' }} />);
      i += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, i)) {
      const tableLines: string[] = [];
      while (i < lines.length && isMarkdownTableLine(lines[i].trim())) {
        tableLines.push(lines[i].trim());
        i += 1;
      }
      nodes.push(
        <MarkdownAnswerTable
          key={`table-${key++}`}
          lines={tableLines}
          t={t}
          compact={compact}
        />,
      );
      continue;
    }

    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      nodes.push(
        <div key={`quote-${key++}`} style={answerCalloutStyle(t, compact)}>
          {inlineAnswerMarkdown(quoteLines.join(' '), t)}
        </div>,
      );
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ''));
        i += 1;
      }
      nodes.push(
        <ul key={`ul-${key++}`} style={answerListStyle(t, compact)}>
          {items.map((item, index) => (
            <li key={`${item}-${index}`} style={answerListItemStyle(t, compact)}>
              {inlineAnswerMarkdown(item, t)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      nodes.push(
        <ol key={`ol-${key++}`} style={answerListStyle(t, compact)}>
          {items.map((item, index) => (
            <li key={`${item}-${index}`} style={answerListItemStyle(t, compact)}>
              {inlineAnswerMarkdown(item, t)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const candidate = lines[i].trim();
      if (!candidate) break;
      if (isStructuredAnswerBlockStart(candidate) && paragraphLines.length > 0) break;
      paragraphLines.push(candidate);
      i += 1;
      if (isStructuredAnswerBlockStart(lines[i]?.trim() ?? '')) break;
    }
    const paragraph = paragraphLines.join(' ');
    nodes.push(
      <div
        key={`p-${key++}`}
        style={nodes.length === 0 && isTrustLead(paragraph)
          ? answerCalloutStyle(t, compact)
          : answerParagraphStyle(t, compact)}
      >
        {inlineAnswerMarkdown(paragraph, t)}
      </div>,
    );
  }

  return nodes;
}

function normalizeStructuredAnswerText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\|\s+\|(?=[^\n]*\|)/g, '|\n|');
}

function isStructuredAnswerBlockStart(line: string): boolean {
  return Boolean(
    line.startsWith('```')
      || /^(#{1,4})\s+/.test(line)
      || /^[-*_]{3,}$/.test(line)
      || isMarkdownTableLine(line)
      || line.startsWith('>')
      || /^[-*+]\s+/.test(line)
      || /^\d+\.\s+/.test(line),
  );
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const current = lines[index]?.trim() ?? '';
  const next = lines[index + 1]?.trim() ?? '';
  return isMarkdownTableLine(current) && isMarkdownTableDivider(next);
}

function isMarkdownTableLine(line: string): boolean {
  return line.startsWith('|') && line.endsWith('|') && parseMarkdownTableRow(line).length >= 2;
}

function isMarkdownTableDivider(line: string): boolean {
  if (!isMarkdownTableLine(line)) return false;
  const cells = parseMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function MarkdownAnswerTable({
  lines,
  t,
  compact,
}: {
  lines: string[];
  t: Theme;
  compact: boolean;
}) {
  const header = parseMarkdownTableRow(lines[0] ?? '');
  const divider = parseMarkdownTableRow(lines[1] ?? '');
  const rows = lines.slice(2).map(parseMarkdownTableRow).filter((row) => row.length > 0);
  const columnCount = Math.max(header.length, ...rows.map((row) => row.length), 0);
  if (columnCount === 0) return null;
  const alignments = Array.from({ length: columnCount }, (_, index) => {
    const marker = divider[index]?.replace(/\s+/g, '') ?? '';
    if (marker.startsWith(':') && marker.endsWith(':')) return 'center' as const;
    if (marker.endsWith(':')) return 'right' as const;
    return 'left' as const;
  });
  const normalizedHeader = Array.from({ length: columnCount }, (_, index) => header[index] ?? '');
  return (
    <div style={answerTableWrapStyle(t)}>
      <table style={answerTableStyle(t, compact)}>
        <thead>
          <tr>
            {normalizedHeader.map((cell, index) => (
              <th key={`h-${index}`} style={answerTableCellStyle(t, compact, true, alignments[index])}>
                {inlineAnswerMarkdown(cell, t)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`r-${rowIndex}`}>
              {Array.from({ length: columnCount }, (_, cellIndex) => (
                <td key={`c-${rowIndex}-${cellIndex}`} style={answerTableCellStyle(t, compact, false, alignments[cellIndex])}>
                  {inlineAnswerMarkdown(row[cellIndex] ?? '', t)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isTrustLead(value: string): boolean {
  return /\b(certified|uncertified|review[- ]required|draft|trusted|trust)\b/i.test(value);
}

function inlineAnswerMarkdown(text: string, t: Theme): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const boldItalic = remaining.match(/\*{3}(.+?)\*{3}/);
    const bold = remaining.match(/\*{2}(.+?)\*{2}/);
    const code = remaining.match(/`([^`]+?)`/);
    const link = remaining.match(/\[([^\]]+?)\]\((https?:\/\/[^)\s]+|\/[^)\s]+|#[^)\s]+)\)/);
    const italic = remaining.match(/\*([^\s*](?:.*?[^\s*])?)\*/);
    const candidates = [
      boldItalic ? { match: boldItalic, type: 'boldItalic' as const } : null,
      bold ? { match: bold, type: 'bold' as const } : null,
      code ? { match: code, type: 'code' as const } : null,
      link ? { match: link, type: 'link' as const } : null,
      italic ? { match: italic, type: 'italic' as const } : null,
    ].filter(Boolean) as Array<{ match: RegExpMatchArray; type: 'boldItalic' | 'bold' | 'code' | 'link' | 'italic' }>;

    if (candidates.length === 0) {
      parts.push(<React.Fragment key={`plain-${key++}`}>{remaining}</React.Fragment>);
      break;
    }

    const first = candidates.reduce((left, right) => ((left.match.index ?? 0) <= (right.match.index ?? 0) ? left : right));
    const index = first.match.index ?? 0;
    if (index > 0) parts.push(<React.Fragment key={`plain-${key++}`}>{remaining.slice(0, index)}</React.Fragment>);

    if (first.type === 'boldItalic') {
      parts.push(<strong key={`bi-${key++}`} style={{ fontStyle: 'italic', color: t.textPrimary }}>{first.match[1]}</strong>);
    } else if (first.type === 'bold') {
      parts.push(<strong key={`b-${key++}`} style={{ color: t.textPrimary }}>{first.match[1]}</strong>);
    } else if (first.type === 'italic') {
      parts.push(<em key={`i-${key++}`}>{first.match[1]}</em>);
    } else if (first.type === 'code') {
      parts.push(
        <code key={`code-${key++}`} style={answerInlineCodeStyle(t)}>
          {first.match[1]}
        </code>,
      );
    } else if (first.type === 'link') {
      parts.push(
        <a key={`link-${key++}`} href={first.match[2]} target="_blank" rel="noopener noreferrer" style={{ color: t.accent, textDecoration: 'underline' }}>
          {first.match[1]}
        </a>,
      );
    }

    remaining = remaining.slice(index + first.match[0].length);
  }

  return <>{parts}</>;
}

function answerParagraphStyle(t: Theme, compact: boolean): React.CSSProperties {
  return {
    color: t.textPrimary,
    fontSize: compact ? 13 : 13,
    lineHeight: compact ? 1.55 : 1.6,
  };
}

function answerHeadingStyle(t: Theme, compact: boolean, level: number): React.CSSProperties {
  return {
    color: t.textPrimary,
    fontSize: compact ? 13 : Math.max(13, 15 - level),
    fontWeight: 800,
    lineHeight: 1.35,
    marginTop: level <= 2 ? 2 : 0,
  };
}

function answerCalloutStyle(t: Theme, compact: boolean): React.CSSProperties {
  return {
    color: t.textPrimary,
    fontSize: compact ? 12.5 : 12.5,
    lineHeight: 1.5,
    padding: compact ? '8px 9px' : '9px 10px',
    border: `1px solid ${t.cellBorder}`,
    borderLeft: `3px solid ${t.accent}`,
    borderRadius: 6,
    background: `${t.tableHeaderBg}55`,
  };
}

function answerListStyle(t: Theme, compact: boolean): React.CSSProperties {
  return {
    margin: 0,
    paddingLeft: compact ? 18 : 20,
    color: t.textPrimary,
    display: 'grid',
    gap: compact ? 4 : 5,
  };
}

function answerListItemStyle(t: Theme, compact: boolean): React.CSSProperties {
  return {
    color: t.textPrimary,
    fontSize: compact ? 13 : 13,
    lineHeight: 1.5,
    paddingLeft: 2,
  };
}

function answerTableWrapStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%',
    maxWidth: '100%',
    overflowX: 'auto',
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 8,
    background: t.editorBg,
  };
}

function answerTableStyle(t: Theme, compact: boolean): React.CSSProperties {
  return {
    width: '100%',
    minWidth: compact ? 360 : 420,
    borderCollapse: 'collapse',
    color: t.textPrimary,
    fontSize: compact ? 12 : 12.5,
    lineHeight: 1.45,
  };
}

function answerTableCellStyle(
  t: Theme,
  compact: boolean,
  header: boolean,
  align: 'left' | 'center' | 'right',
): React.CSSProperties {
  return {
    padding: compact ? '6px 8px' : '7px 9px',
    borderBottom: `1px solid ${t.cellBorder}`,
    color: header ? t.textMuted : t.textPrimary,
    background: header ? `${t.tableHeaderBg}75` : undefined,
    fontFamily: header ? t.fontMono : t.font,
    fontSize: header ? (compact ? 10.5 : 11) : undefined,
    fontWeight: header ? 800 : 500,
    textAlign: align,
    whiteSpace: 'nowrap',
    verticalAlign: 'top',
  };
}

function answerInlineCodeStyle(t: Theme): React.CSSProperties {
  return {
    background: t.editorBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 4,
    color: t.accent,
    fontFamily: t.fontMono,
    fontSize: '0.92em',
    padding: '1px 4px',
  };
}

function answerCodeBlockStyle(t: Theme, compact: boolean): React.CSSProperties {
  return {
    margin: 0,
    padding: compact ? 9 : 10,
    overflow: 'auto',
    maxHeight: compact ? 220 : 280,
    borderRadius: 6,
    background: t.editorBg,
    color: t.textPrimary,
    border: `1px solid ${t.cellBorder}`,
    fontSize: compact ? 11.5 : 12,
    fontFamily: t.fontMono,
    lineHeight: 1.5,
    whiteSpace: 'pre',
  };
}

function ResultPreview({ result, t, compact }: { result: QueryResult; t: Theme; compact?: boolean }) {
  const columns = (result.columns.length > 0 ? result.columns : Object.keys(result.rows[0] ?? {})).slice(0, compact ? 3 : 4);
  const rows = result.rows.slice(0, compact ? 4 : 5);
  if (columns.length === 0 || rows.length === 0) return null;
  return (
    <div style={{
      border: `1px solid ${t.cellBorder}`,
      borderRadius: 8,
      overflow: 'hidden',
      background: t.editorBg,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 10,
        padding: '7px 9px',
        borderBottom: `1px solid ${t.cellBorder}`,
        color: t.textMuted,
        fontSize: 11,
        fontFamily: t.fontMono,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}>
        <span>Preview</span>
        <span>{rows.length} of {(result.rowCount ?? result.rows.length).toLocaleString()} rows</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} style={{
                  textAlign: 'left',
                  padding: '7px 9px',
                  color: t.textMuted,
                  fontSize: 11,
                  fontFamily: t.fontMono,
                  borderBottom: `1px solid ${t.cellBorder}`,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {formatLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map((column) => (
                  <td key={`${rowIndex}-${column}`} style={{
                    padding: '7px 9px',
                    color: t.textPrimary,
                    fontSize: compact ? 12 : 12.5,
                    borderBottom: rowIndex < rows.length - 1 ? `1px solid ${t.cellBorder}` : 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {formatPreviewValue(column, row[column], rows.map((item) => item[column]), result.columnsMeta?.find((meta) => meta.name === column))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LineagePanel({ evidence, t }: { evidence?: AgentEvidence; t: Theme }) {
  const lineage = evidence?.lineage ?? [];
  if (lineage.length === 0) {
    return <EmptyPanel t={t}>No lineage evidence was returned for this answer.</EmptyPanel>;
  }
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {lineage.map((asset, idx) => (
        <div key={`${asset.nodeId ?? asset.name}-${idx}`} style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ width: 8, height: 8, borderRadius: 8, marginTop: 5, background: asset.role === 'question' ? t.accent : t.textMuted }} />
            {idx < lineage.length - 1 && <div style={{ width: 1, flex: 1, minHeight: 18, background: t.cellBorder }} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{asset.name ?? asset.nodeId}</span>
              {asset.role && <Pill label={formatLabel(asset.role)} t={t} />}
              {asset.kind && <Pill label={formatLabel(asset.kind)} t={t} />}
            </div>
            {asset.description && <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 3 }}>{asset.description}</div>}
            {(asset.sourcePath || asset.provenance) && (
              <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {asset.provenance ?? asset.sourcePath}
                {asset.sourcePath && asset.provenance ? ` - ${asset.sourcePath}` : ''}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BusinessContextPanel({ evidence, t }: { evidence?: AgentEvidence; t: Theme }) {
  const context = evidence?.businessContext ?? [];
  const outcome = evidence?.outcome;
  if (!outcome && context.length === 0) {
    return <EmptyPanel t={t}>No business context was returned for this answer.</EmptyPanel>;
  }
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {outcome && (
        <div style={{ display: 'grid', gap: 6 }}>
          <SectionTitle t={t}>Outcome</SectionTitle>
          {outcome.name && <KeyValue label="Outcome" value={outcome.name} t={t} />}
          {outcome.owner && <KeyValue label="Owner" value={outcome.owner} t={t} />}
          {outcome.decisionUse && <KeyValue label="Decision Use" value={outcome.decisionUse} t={t} />}
          {outcome.reviewCadence && <KeyValue label="Review Cadence" value={outcome.reviewCadence} t={t} />}
          {outcome.caveats?.map((caveat, idx) => <KeyValue key={`caveat-${idx}`} label="Caveat" value={caveat} t={t} />)}
        </div>
      )}
      {context.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <SectionTitle t={t}>Context</SectionTitle>
          {context.map((item, idx) => (
            <KeyValue
              key={`${item.label}-${idx}`}
              label={item.label ?? 'Context'}
              value={item.value ?? ''}
              source={item.source}
              t={t}
            />
          ))}
        </div>
      )}
      {evidence?.semanticObjects && evidence.semanticObjects.length > 0 && (
        <AssetList title="Semantic Objects" assets={evidence.semanticObjects} t={t} />
      )}
      {evidence?.sourceTables && evidence.sourceTables.length > 0 && (
        <AssetList title="Source Tables" assets={evidence.sourceTables} t={t} />
      )}
    </div>
  );
}

function ReviewPanel({ answer, t }: { answer: AgentAnswerEnvelope; t: Theme }) {
  const evidence = answer.evidence;
  const analysisPlan = answer.analysisPlan ?? evidence?.analysisPlan;
  const citations = evidence?.citations ?? answer.citations ?? [];
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <KeyValue label="Certification" value={formatLabel(answer.certification ?? answer.kind)} t={t} />
        {formatCascadeOutcome(answer.cascade) && <KeyValue label="Cascade" value={formatCascadeOutcome(answer.cascade) ?? ''} t={t} />}
        {answer.reviewStatus && <KeyValue label="Review Status" value={formatLabel(answer.reviewStatus)} t={t} />}
        {typeof answer.confidence === 'number' && <KeyValue label="Confidence" value={`${Math.round(answer.confidence * 100)}%`} t={t} />}
        {evidence?.validation?.message && (
          <KeyValue label={`Validation ${evidence.validation.status ?? ''}`.trim()} value={evidence.validation.message} t={t} />
        )}
        {evidence?.execution?.message && (
          <KeyValue label={`Execution ${evidence.execution.status ?? ''}`.trim()} value={evidence.execution.message} t={t} />
        )}
        {answer.executionError && <KeyValue label="Execution Error" value={answer.executionError} t={t} />}
        {answer.kind !== 'certified' && (
          <KeyValue label="Promotion Path" value="Create draft saved query, edit SQL, attach tests, then certify after analyst approval." t={t} />
        )}
      </div>
      {analysisPlan && (
        <div style={{ display: 'grid', gap: 6 }}>
          <SectionTitle t={t}>Analysis Plan</SectionTitle>
          {analysisPlan.question && <KeyValue label="Question" value={analysisPlan.question} t={t} />}
          {analysisPlan.intent && <KeyValue label="Intent" value={formatLabel(analysisPlan.intent)} t={t} />}
          {analysisPlan.grain && <KeyValue label="Grain" value={analysisPlan.grain} t={t} />}
          {analysisPlan.candidateTables && analysisPlan.candidateTables.length > 0 && (
            <KeyValue
              label="Tables"
              value={analysisPlan.candidateTables.slice(0, 5).map((table) => table.relation).filter(Boolean).join(', ')}
              t={t}
            />
          )}
          {analysisPlan.candidateJoins && analysisPlan.candidateJoins.length > 0 && (
            <KeyValue
              label="Join Paths"
              value={analysisPlan.candidateJoins.slice(0, 3).map(formatJoinPath).join('; ')}
              t={t}
            />
          )}
          {analysisPlan.assumptions && analysisPlan.assumptions.length > 0 && (
            <KeyValue label="Assumptions" value={analysisPlan.assumptions.join(' ')} t={t} />
          )}
          {typeof analysisPlan.repairAttempts === 'number' && analysisPlan.repairAttempts > 0 && (
            <KeyValue label="SQL Repair" value={`${analysisPlan.repairAttempts} retry`} t={t} />
          )}
        </div>
      )}
      {citations.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SectionTitle t={t}>Citations</SectionTitle>
          {citations.slice(0, 8).map((citation, idx) => (
            <div key={`${citation.kind}-${citation.name}-${idx}`} style={{ fontSize: 12, color: t.textSecondary, fontFamily: t.fontMono }}>
              {citation.kind ?? 'source'}: {citation.name ?? 'unknown'}
              {citation.provenance && <span style={{ color: t.textMuted }}> ({citation.provenance})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AssetList({ title, assets, t }: { title: string; assets: EvidenceAsset[]; t: Theme }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SectionTitle t={t}>{title}</SectionTitle>
      {assets.map((asset, idx) => (
        <div key={`${asset.nodeId ?? asset.name}-${idx}`} style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 4 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{asset.name ?? asset.nodeId}</span>
            {asset.kind && <Pill label={formatLabel(asset.kind)} t={t} />}
            {asset.certification && <Pill label={formatLabel(asset.certification)} t={t} />}
          </div>
          {asset.description && <div style={{ fontSize: 12, color: t.textSecondary }}>{asset.description}</div>}
          {(asset.sourcePath || asset.owner || asset.domain) && (
            <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>
              {[asset.domain, asset.owner, asset.sourcePath].filter(Boolean).join(' - ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DqlArtifactPanel({ artifact, t }: { artifact: AgentDqlArtifactMeta; t: Theme }) {
  const metadata = [
    artifact.kind ? { label: 'Kind', value: formatLabel(artifact.kind) } : null,
    artifact.name ? { label: 'Name', value: artifact.name } : null,
    artifact.sourcePath ? { label: 'Source Path', value: artifact.sourcePath } : null,
    artifact.metrics.length > 0 ? { label: 'Metrics', value: artifact.metrics.join(', ') } : null,
    artifact.dimensions.length > 0 ? { label: 'Dimensions', value: artifact.dimensions.join(', ') } : null,
    artifact.timeDimension ? { label: 'Time', value: artifact.timeDimension } : null,
    artifact.filters.length > 0 ? { label: 'Filters', value: artifact.filters.join('; ') } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {metadata.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {metadata.map((item) => (
            <KeyValue key={item.label} label={item.label} value={item.value} t={t} />
          ))}
        </div>
      )}
      <pre style={codePanelStyle(t, 340)}>
        {artifact.source}
      </pre>
    </div>
  );
}

function SqlPanel({ sql, blockPath, executionError, t }: { sql?: string; blockPath?: string; executionError?: string; t: Theme }) {
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {blockPath && (
        <div style={{ fontSize: 12, color: t.textSecondary }}>
          Source saved query: <span style={{ fontFamily: t.fontMono, color: t.textPrimary }}>{blockPath}</span>
        </div>
      )}
      {executionError && (
        <div style={{
          padding: 10,
          border: '1px solid rgba(248, 81, 73, 0.35)',
          borderRadius: 6,
          background: 'rgba(248, 81, 73, 0.10)',
          color: '#ff7b72',
          fontSize: 12,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
        }}>
          {executionError}
        </div>
      )}
      {sql ? (
        <pre style={codePanelStyle(t, 260)}>
          {sql}
        </pre>
      ) : (
        <div style={{ fontSize: 12, color: t.textMuted }}>No SQL text was returned for this answer.</div>
      )}
    </div>
  );
}

function codePanelStyle(t: Theme, maxHeight: number): React.CSSProperties {
  return {
    margin: 0,
    padding: 10,
    overflow: 'auto',
    maxHeight,
    borderRadius: 4,
    background: t.editorBg,
    color: t.textPrimary,
    border: `1px solid ${t.cellBorder}`,
    fontSize: 12,
    fontFamily: t.fontMono,
    whiteSpace: 'pre',
  };
}

function KeyValue({ label, value, source, t }: { label: string; value: string; source?: string; t: Theme }) {
  if (!value) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: 10, fontSize: 12, alignItems: 'baseline' }}>
      <span style={{ color: t.textMuted }}>{label}</span>
      <span style={{ color: t.textSecondary }}>
        {value}
        {source && <span style={{ color: t.textMuted }}> ({source})</span>}
      </span>
    </div>
  );
}

function SectionTitle({ children, t }: { children: React.ReactNode; t: Theme }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, fontFamily: t.fontMono, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
      {children}
    </div>
  );
}

function EmptyPanel({ children, t }: { children: React.ReactNode; t: Theme }) {
  return <div style={{ padding: 12, fontSize: 12, color: t.textMuted }}>{children}</div>;
}

function Pill({ label, t }: { label: string; t: Theme }) {
  return (
    <span style={{
      fontSize: 11,
      fontFamily: t.fontMono,
      color: t.textSecondary,
      padding: '2px 6px',
      borderRadius: 4,
      background: t.editorBg,
      border: `1px solid ${t.cellBorder}`,
    }}>
      {label}
    </span>
  );
}

interface ProvenanceItem {
  label: string;
  value: string;
}

function ProvenanceFooter({ items, t, accent }: { items: ProvenanceItem[]; t: Theme; accent: string }) {
  if (items.length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 16px',
        alignItems: 'center',
        padding: '7px 10px',
        borderTop: `1px solid ${t.cellBorder}`,
        boxShadow: `inset 0 2px 0 ${accent}`,
        background: t.editorBg,
        color: t.textMuted,
        fontFamily: t.fontMono,
        fontSize: 10.5,
      }}
    >
      {items.map((item) => (
        <span key={`${item.label}-${item.value}`} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: t.textMuted }}>{item.label}</span>{' '}
          <strong style={{ color: t.textSecondary, fontWeight: 600 }}>{item.value}</strong>
        </span>
      ))}
    </div>
  );
}

function SegmentButton({ active, label, onClick, t }: { active: boolean; label: string; onClick: () => void; t: Theme }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 2px',
        fontSize: 11.5,
        border: 0,
        borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
        borderRadius: 0,
        background: 'transparent',
        color: active ? t.accent : t.textSecondary,
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function ChartCustomizationPanel({
  result,
  chartConfig,
  t,
  onChange,
}: {
  result: QueryResult;
  chartConfig?: CellChartConfig;
  t: Theme;
  onChange: (next: Partial<CellChartConfig>) => void;
}) {
  const columns = result.columns;
  if (columns.length === 0) return null;
  const chartTypeOptions = CHART_TYPE_OPTIONS.filter((option) => option.value !== 'table');
  // The offered defaults follow the result's own contract: a key or a label is
  // never the value axis, however numeric its values look.
  const measures = measureColumns(result);
  const categories = categoryColumns(result);
  const x = chartConfig?.x && columns.includes(chartConfig.x) ? chartConfig.x : categories[0] ?? columns[0] ?? '';
  const y = chartConfig?.y && columns.includes(chartConfig.y) ? chartConfig.y : measures.find((column) => column !== x) ?? columns.find((column) => column !== x) ?? columns[0] ?? '';
  const color = chartConfig?.color && columns.includes(chartConfig.color) ? chartConfig.color : '';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
        gap: 8,
        alignItems: 'end',
        border: `1px solid ${t.cellBorder}`,
        borderRadius: 7,
        background: `${t.tableHeaderBg}55`,
        padding: 10,
      }}
    >
      <ChartControlLabel label="Chart type" t={t}>
        <select
          value={chartConfig?.chart ?? 'bar'}
          onChange={(event) => onChange({ chart: event.target.value })}
          style={chartControlSelectStyle(t)}
        >
          {chartTypeOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </ChartControlLabel>
      <ChartControlLabel label="X axis" t={t}>
        <select
          value={x}
          onChange={(event) => onChange({ x: event.target.value })}
          style={chartControlSelectStyle(t)}
        >
          {columns.map((column) => <option key={column} value={column}>{column}</option>)}
        </select>
      </ChartControlLabel>
      <ChartControlLabel label="Y axis" t={t}>
        <select
          value={y}
          onChange={(event) => onChange({ y: event.target.value })}
          style={chartControlSelectStyle(t)}
        >
          {columns.map((column) => <option key={column} value={column}>{column}</option>)}
        </select>
      </ChartControlLabel>
      <ChartControlLabel label="Color" t={t}>
        <select
          value={color}
          onChange={(event) => onChange({ color: event.target.value || undefined })}
          style={chartControlSelectStyle(t)}
        >
          <option value="">None</option>
          {columns.map((column) => <option key={column} value={column}>{column}</option>)}
        </select>
      </ChartControlLabel>
    </div>
  );
}

function ChartControlLabel({
  label,
  t,
  children,
}: {
  label: string;
  t: Theme;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'grid', gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 10.5, color: t.textMuted, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function chartControlSelectStyle(t: Theme): React.CSSProperties {
  return {
    width: '100%',
    minWidth: 0,
    height: 30,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    background: t.editorBg,
    color: t.textPrimary,
    fontFamily: t.font,
    fontSize: 12,
    padding: '0 8px',
  };
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatJoinPath(join: NonNullable<AgentAnalysisPlan['candidateJoins']>[number]): string {
  const left = [join.leftRelation, join.leftColumn].filter(Boolean).join('.');
  const right = [join.rightRelation, join.rightColumn].filter(Boolean).join('.');
  const path = [left, right].filter(Boolean).join(' to ');
  return join.reason ? `${path} (${join.reason})` : path;
}

function formatPreviewValue(column: string, value: unknown, values: unknown[], meta?: DisplayColumnMeta): string {
  if (value === null || value === undefined) return '-';
  return formatDisplayValue(column, value, values, meta ? { meta } : {});
}

function formatBusinessTier(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes('certified')) return 'trusted business context';
  if (normalized.includes('ai') || normalized.includes('generated')) return 'AI draft';
  if (normalized.includes('no_answer')) return 'needs more context';
  return formatLabel(value);
}

export function resolveAnswerTrustState(answer: AgentAnswerEnvelope): TrustState {
  // The host's effective decision takes precedence over display-era fields.
  // A coverage downgrade must never render as governed because a stale
  // certification or reviewStatus still says otherwise.
  const effectiveTrust = answer.result?.trustState ?? answer.trustState;
  if (effectiveTrust === 'certified') return 'certified';
  if (effectiveTrust === 'governed') return 'reviewed';
  if (effectiveTrust === 'review_required') return 'review';
  if (effectiveTrust === 'blocked') return 'no_answer';
  // Prefer the canonical trust stamp from the answer loop for older payloads.
  switch (answer.trustLabelInfo?.id) {
    case 'certified': return 'certified';
    case 'reviewed': return 'review';
    case 'ai_generated': return 'ai_generated';
    case 'conflict': return 'review';
    case 'insufficient_context': return answer.kind === 'no_answer' ? 'no_answer' : 'uncertified';
    default: break;
  }
  if (answer.kind === 'no_answer') return 'no_answer';
  if (answer.certification === 'certified' || answer.reviewStatus === 'certified') return 'certified';
  if (answer.reviewStatus === 'draft_ready' || answer.reviewStatus === 'analyst_review_required') return 'review';
  if (answer.certification === 'ai_generated') return 'ai_generated';
  if (answer.certification === 'analyst_review_required' || answer.certification === 'uncertified') return 'uncertified';
  return answer.kind === 'certified' ? 'certified' : 'draft';
}

function trustStateColor(state: TrustState, t: Theme): string {
  if (state === 'certified') return t.success;
  if (state === 'no_answer') return t.error;
  if (state === 'deprecated') return t.textMuted;
  return t.warning;
}

function buildAnswerProvenance(
  answer: AgentAnswerEnvelope,
  result: QueryResult | null,
  blockName?: string,
  blockPath?: string,
): ProvenanceItem[] {
  const items: ProvenanceItem[] = [];
  const firstAsset = answer.evidence?.selectedAssets?.[0] ?? answer.evidence?.lineage?.find((asset) => asset.owner || asset.domain || asset.sourcePath);
  const sourceName = blockName ?? firstAsset?.name;
  const sourcePath = blockPath ?? firstAsset?.sourcePath ?? firstAsset?.provenance;

  if (sourceName) items.push({ label: answer.kind === 'certified' ? 'source' : 'draft source', value: sourceName });
  if (firstAsset?.owner ?? answer.evidence?.outcome?.owner) items.push({ label: 'owner', value: firstAsset?.owner ?? answer.evidence?.outcome?.owner ?? '' });
  if (sourcePath) items.push({ label: 'path', value: sourcePath });
  if (answer.sourceTier) items.push({ label: 'tier', value: formatLabel(answer.sourceTier) });
  if (formatCascadeOutcome(answer.cascade)) items.push({ label: 'cascade', value: formatCascadeOutcome(answer.cascade) ?? '' });
  if (result) {
    const rows = result.rowCount ?? result.rows.length;
    const timing = result.executionTime !== undefined ? ` - ${Math.round(result.executionTime)}ms` : '';
    items.push({ label: 'run', value: `${rows.toLocaleString()} rows${timing}` });
  }
  if (answer.reviewStatus && answer.reviewStatus !== 'certified') items.push({ label: 'next', value: formatLabel(answer.reviewStatus) });

  return dedupeProvenanceItems(items).slice(0, 5);
}

export function formatCascadeOutcome(cascade?: AgentAnswerCascade): string | undefined {
  if (!cascade?.terminalLane && !cascade?.routeTier) return undefined;
  const lane = formatCascadeLane(cascade.terminalLane);
  const tier = formatCascadeTier(cascade.routeTier);
  return [lane, tier].filter(Boolean).join(' · ') || undefined;
}

function formatCascadeLane(value?: string): string | undefined {
  switch (value) {
    case 'certified':
      return 'Lane 1 certified';
    case 'semantic':
      return 'Lane 2 semantic';
    case 'generated':
      return 'Lane 3 generated';
    case 'refusal':
      return 'Lane 4 refusal';
    default:
      return value ? formatLabel(value) : undefined;
  }
}

function formatCascadeTier(value?: string): string | undefined {
  switch (value) {
    case 'certified_block':
      return 'Certified saved query';
    case 'semantic_metric':
      return 'Semantic metric';
    case 'generated_sql':
      return 'Generated SQL';
    case 'business_context':
      return 'Business context';
    case 'no_answer':
      return 'No answer';
    default:
      return value ? formatLabel(value) : undefined;
  }
}

function resolveInvestigationBlockName(answer: AgentAnswerEnvelope, fallback?: string): string | undefined {
  return cleanSourceName(answer.sourceCertifiedBlock)
    ?? firstBlockName(answer.evidence?.selectedAssets)
    ?? firstBlockName(answer.evidence?.lineage)
    ?? firstBlockName(answer.citations)
    ?? cleanSourceName(answer.block?.name)
    ?? cleanSourceName(answer.result?.blockName)
    ?? cleanSourceName(fallback);
}

function firstBlockName(items?: Array<{ kind?: string; name?: string }>): string | undefined {
  return items
    ?.map((item) => (item.kind === 'block' ? cleanSourceName(item.name) : undefined))
    .find((value): value is string => Boolean(value));
}

function cleanSourceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean || undefined;
}

function dedupeProvenanceItems(items: ProvenanceItem[]): ProvenanceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = item.value.trim();
    if (!value) return false;
    const key = `${item.label}:${value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function statusColor(status?: string): string {
  if (status === 'selected' || status === 'passed' || status === 'executed') return '#3fb950';
  if (status === 'failed') return '#ff7b72';
  if (status === 'warning' || status === 'checked') return '#f0883e';
  return '#8b949e';
}

function nextTilePosition(dashboard: { layout: { items: Array<{ y: number; h: number }> } }): { x: number; y: number; w: number; h: number } {
  const y = dashboard.layout.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  return { x: 0, y, w: 6, h: 3 };
}

function nextTileId(dashboard: { layout: { items: Array<{ i: string }> } }, raw: string): string {
  const base = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tile';
  const used = new Set(dashboard.layout.items.map((item) => item.i));
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function normalizeVizTypeForDashboard(value: unknown): string {
  const chart = String(value ?? 'table').toLowerCase().replace(/-/g, '_');
  if (chart === 'single_value' || chart === 'kpi' || chart === 'line' || chart === 'bar' || chart === 'area'
    || chart === 'pie' || chart === 'donut' || chart === 'grouped_bar' || chart === 'stacked_bar' || chart === 'scatter'
    || chart === 'heatmap' || chart === 'histogram' || chart === 'waterfall' || chart === 'pivot' || chart === 'map'
    || chart === 'funnel' || chart === 'sankey') {
    return chart;
  }
  return 'table';
}
