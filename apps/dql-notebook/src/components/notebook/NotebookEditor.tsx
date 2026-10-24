import type { Theme } from "../../themes/notebook-theme";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from 'zustand/react/shallow';
import { Clock3, History, Sparkles } from "lucide-react";
import { makeCell, useDispatch, useNotebookStore } from "../../store/NotebookStore";
import { themes } from "../../themes/notebook-theme";
import {
  api,
  type AgentConversationThread,
  type DatasetSource,
  type NotebookResearchRun,
} from "../../api/client";
import { WelcomeScreen } from "./WelcomeScreen";
import { CellList } from "./CellList";
import { DashboardView } from "./DashboardView";
import { DocumentMetadataRow } from "./DocumentMetadataRow";
import { useOpenBlockInStudio } from "../agent/AiBuildResult";
import {
  UnifiedAgentRunPanel,
  usePersistedAgentThreadId,
  type InsertDqlPayload,
  type SqlNotebookDraftMeta,
} from "../agent/UnifiedAgentRunPanel";
import {
  AiSidePanel,
  AiSidePanelAction,
  AI_SIDE_PANEL_EXPANDED_WIDTH,
} from "../agent/AiSidePanel";
import { emitNotebookResearchChanged } from "../../utils/notebook-research";
import type { Cell, NotebookDocMetadata, NotebookFile } from "../../store/types";
import { DatasetImportPanel } from "./DatasetImportPanel";
import { focusInsertedNotebookCell } from "../../utils/notebook-cell-focus";
import {
  correctionProvenanceForDraft,
  useOpenAnswerInNotebook,
} from "../../utils/answer-to-notebook";
import { extractSqlFromText } from "../../utils/block-studio";
import { useQueryExecution } from "../../hooks/useQueryExecution";

interface NotebookEditorProps {
  onOpenFile: (file: NotebookFile) => void;
  registerCellRef: (id: string, el: HTMLDivElement | null) => void;
}

type AiHistoryBadge = {
  total: number;
  active: number;
  blocked: number;
};

const EMPTY_AI_HISTORY_BADGE: AiHistoryBadge = {
  total: 0,
  active: 0,
  blocked: 0,
};

export function NotebookEditor({ onOpenFile, registerCellRef }: NotebookEditorProps) {
  const state = useNotebookStore(useShallow((store) => ({
    activeFile: store.activeFile,
    cells: store.cells,
    dashboardMode: store.dashboardMode,
    files: store.files,
    notebookMetadata: store.notebookMetadata,
    notebookTitle: store.notebookTitle,
    queryLog: store.queryLog,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const openAnswerInNotebook = useOpenAnswerInNotebook();
  const t = themes[state.themeMode];
  const [aiOpen, setAiOpen] = useState(false);
  const [aiHistoryOpen, setAiHistoryOpen] = useState(false);
  const [aiSourceCellId, setAiSourceCellId] = useState<string | null>(null);
  const [aiInitialInput, setAiInitialInput] = useState('');
  const [aiHistoryRefreshKey, setAiHistoryRefreshKey] = useState(0);
  const [aiHistoryBadge, setAiHistoryBadge] = useState<AiHistoryBadge>(
    EMPTY_AI_HISTORY_BADGE,
  );
  const [datasetImport, setDatasetImport] = useState<{
    open: boolean;
    afterId?: string;
  }>({ open: false });
  const [datasets, setDatasets] = useState<DatasetSource[]>([]);
  const [compactWorkspace, setCompactWorkspace] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 900px)").matches,
  );
  const activeNotebookPath = state.activeFile?.path;

  const aiSourceCell = useMemo(
    () => state.cells.find((cell) => cell.id === aiSourceCellId) ?? null,
    [aiSourceCellId, state.cells],
  );
  const aiContext = useMemo(
    () =>
      buildNotebookAiContext({
        notebookPath: activeNotebookPath,
        notebookTitle: state.notebookTitle,
        notebookMetadata: state.notebookMetadata,
        cell: aiSourceCell,
        cells: state.cells,
        datasets,
      }),
    [
      activeNotebookPath,
      aiSourceCell,
      datasets,
      state.cells,
      state.notebookMetadata,
      state.notebookTitle,
    ],
  );

  const openFileForAiHistory = useCallback((file: NotebookFile) => {
    setAiSourceCellId(null);
    setAiInitialInput('');
    setAiOpen(true);
    setAiHistoryOpen(true);
    onOpenFile(file);
  }, [onOpenFile]);

  useEffect(() => {
    if (!activeNotebookPath) {
      setAiHistoryBadge(EMPTY_AI_HISTORY_BADGE);
      return;
    }

    let cancelled = false;
    api.listNotebookResearch({ path: activeNotebookPath, limit: 1 })
      .then((page) => {
        if (cancelled) return;
        setAiHistoryBadge({
          total: page.counts.total,
          active: page.counts.needsReview + page.counts.errors + page.counts.draftReady + page.counts.certificationReady,
          blocked: page.counts.blocked,
        });
      })
      .catch(() => {
        if (!cancelled) setAiHistoryBadge(EMPTY_AI_HISTORY_BADGE);
      });

    return () => {
      cancelled = true;
    };
  }, [activeNotebookPath, aiHistoryOpen, aiHistoryRefreshKey, state.queryLog.length]);

  // The AddCellBar "AI" tile opens the governed Notebook AI drawer at its insertion
  // position (routed through the same DQL-first cascade as Ask AI), replacing the
  // old regex SQL-draft dialog. Decoupled via a window event (no prop threading
  // through CellList), mirroring the existing dql:semantic-used pattern.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ afterId?: string }>).detail;
      setAiSourceCellId(detail?.afterId ?? null);
      setAiInitialInput('');
      setAiHistoryOpen(false);
      setAiOpen(true);
    };
    window.addEventListener('dql:open-notebook-ai', handler);
    return () => window.removeEventListener('dql:open-notebook-ai', handler);
  }, []);

  useEffect(() => {
    const refresh = () => {
      void api
        .getDatasets()
        .then((payload) => setDatasets(payload.datasets))
        .catch(() => setDatasets([]));
    };
    refresh();
    window.addEventListener("dql:datasets-changed", refresh);
    return () => window.removeEventListener("dql:datasets-changed", refresh);
  }, [activeNotebookPath]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setCompactWorkspace(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ afterId?: string }>).detail;
      setDatasetImport({ open: true, afterId: detail?.afterId });
    };
    window.addEventListener("dql:open-dataset-import", handler);
    return () => window.removeEventListener("dql:open-dataset-import", handler);
  }, []);

  const openAiForCell = useCallback(
    (cellId: string, prompt?: string) => {
      setAiSourceCellId(cellId);
      setAiInitialInput(prompt?.trim() ?? "");
      setAiHistoryOpen(false);
      setAiOpen(true);
    },
    [],
  );

  const insertAiSqlCell = useCallback(
    (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => {
      const trimmed = sql.trim();
      if (!trimmed) return;
      const cell = makeCell("sql", trimmed);
      cell.name = safeCellName(title ?? "AI SQL draft");
      cell.correctionProvenance = correctionProvenanceForDraft({
        question: meta?.question,
        generatedSql: trimmed,
        sourceRunId: meta?.sourceRunId,
      });
      const datasetRefs = datasets
        .filter((dataset) =>
          new RegExp(`\\b${escapeRegExp(dataset.alias)}\\b`, "i").test(trimmed),
        )
        .map((dataset) => ({
          id: dataset.id,
          alias: dataset.alias,
          role:
            dataset.storageMode === "staged"
              ? ("staged" as const)
              : ("source" as const),
          fingerprint: dataset.fileFingerprint,
        }));
      if (datasetRefs.length > 0) {
        cell.executionTarget = { target: "local" };
        cell.datasetRefs = datasetRefs;
      }
      dispatch({
        type: "ADD_CELL",
        cell,
        afterId: aiSourceCellId ?? undefined,
      });
      focusInsertedNotebookCell(cell.id);
      setAiSourceCellId(cell.id);
      setAiOpen(true);
    },
    [aiSourceCellId, datasets, dispatch],
  );

  // DQL-first insertion (default): create a self-contained query cell seeded with
  // the governed answer's compiled SQL body + executed result + chart config, and
  // carry the DQL artifact as provenance (surfaced + save-as-block on the cell).
  const insertGeneratedDqlCell = useCallback(
    (payload: InsertDqlPayload) => {
      // No notebook open: ADD_CELL would write into an empty store behind the
      // welcome screen and the user would see nothing happen.
      if (!state.activeFile) {
        void openAnswerInNotebook(payload, { datasets });
        return;
      }
      const sql = (payload.sql ?? payload.dqlArtifact?.source ?? "").trim();
      if (!sql) return;
      if (payload.mixedSourcePlan) {
        const plan = payload.mixedSourcePlan;
        const contextCell = makeCell(
          "markdown",
          [
            `### ${payload.title ?? 'Mixed-source analysis'}`,
            '',
            `This analysis combines a bounded warehouse extraction with the local dataset \`${plan.localDataset}\`.`,
            '',
            ...(plan.warehouseRelations?.length ? [`- Warehouse sources: ${plan.warehouseRelations.map((relation) => `\`${relation}\``).join(', ')}`] : []),
            `- Join: \`${plan.warehouseKey}\` = \`${plan.localKey}\``,
            '- Trust: local mixed-source analysis · review required',
            '- Run the warehouse cell below, then confirm **Create joined analysis**.',
          ].join('\n'),
        );
        contextCell.name = safeCellName('Analysis context');
        const extractionCell = makeCell("sql", sql);
        extractionCell.name = safeCellName(payload.title ?? "Warehouse extraction");
        extractionCell.mixedSourcePlan = plan;
        extractionCell.executionTarget = { target: 'connection' };
        extractionCell.datasetRefs = [{
          id: plan.datasetId ?? plan.localDataset,
          alias: plan.localDataset,
          role: 'source',
        }];
        extractionCell.annotations = [{
          id: `note_${Date.now()}_mixed_source`,
          body: `AI prepared a bounded warehouse extraction for a local join with ${plan.localDataset} on ${plan.warehouseKey} = ${plan.localKey}. Review required.`,
          createdAt: new Date().toISOString(),
          author: 'ZLens',
        }];
        dispatch({ type: "ADD_CELL", cell: contextCell, afterId: aiSourceCellId ?? undefined });
        dispatch({ type: "ADD_CELL", cell: extractionCell, afterId: contextCell.id });
        focusInsertedNotebookCell(extractionCell.id);
        setAiSourceCellId(extractionCell.id);
        setAiOpen(true);
        return;
      }
      const dqlSource = payload.dqlArtifact?.source?.trim();
      const cell = makeCell(dqlSource ? "dql" : "sql", dqlSource || sql);
      cell.name = safeCellName(
        payload.title ?? payload.dqlArtifact?.name ?? "AI analysis",
      );
      if (payload.result) {
        cell.result = payload.result;
        cell.status = "success";
        cell.executionCount = 1;
      }
      if (payload.chartConfig) cell.chartConfig = payload.chartConfig;
      cell.correctionProvenance = correctionProvenanceForDraft({
        question: payload.question,
        generatedSql: payload.sql ?? payload.dqlArtifact?.compiledSql,
        generatedDql: dqlSource,
        sourceRunId: payload.sourceRunId,
      });
      if (payload.dqlArtifact) {
        cell.dqlArtifact = {
          source: payload.dqlArtifact.source,
          sql: payload.sql,
          name: payload.dqlArtifact.name,
          sourcePath: payload.dqlArtifact.sourcePath,
          kind: payload.dqlArtifact.kind,
          metrics: payload.dqlArtifact.metrics,
          dimensions: payload.dqlArtifact.dimensions,
          parameters: payload.dqlArtifact.parameters,
          parameterValues: payload.dqlArtifact.parameterValues,
          persistence: payload.dqlArtifact.persistence,
          trustState: payload.dqlArtifact.trustState,
          compiledSql: payload.dqlArtifact.compiledSql ?? payload.sql,
          ...(payload.question ? { question: payload.question } : {}),
        };
        cell.dqlParameterValues = payload.dqlArtifact.parameterValues;
      }
      const datasetRefs = datasets
        .filter((dataset) =>
          new RegExp(`\\b${escapeRegExp(dataset.alias)}\\b`, "i").test(sql),
        )
        .map((dataset) => ({
          id: dataset.id,
          alias: dataset.alias,
          role:
            dataset.storageMode === "staged"
              ? ("staged" as const)
              : ("source" as const),
          fingerprint: dataset.fileFingerprint,
        }));
      if (datasetRefs.length > 0) {
        cell.executionTarget = { target: "local" };
        cell.datasetRefs = datasetRefs;
        if (cell.dqlArtifact) cell.dqlArtifact.reviewState = "review_required";
      }
      dispatch({
        type: "ADD_CELL",
        cell,
        afterId: aiSourceCellId ?? undefined,
      });
      focusInsertedNotebookCell(cell.id);
      setAiSourceCellId(cell.id);
      setAiOpen(true);
    },
    [aiSourceCellId, datasets, dispatch],
  );

  const { executeCell } = useQueryExecution();

  const replaceSelectedCellFromAi = useCallback(
    (payload: InsertDqlPayload) => {
      if (!aiSourceCellId) return;
      const sql = (payload.sql ?? payload.dqlArtifact?.source ?? '').trim();
      const dqlSource = payload.dqlArtifact?.source?.trim();
      const content = dqlSource || sql;
      if (!content) return;
      dispatch({
        type: 'UPDATE_CELL',
        id: aiSourceCellId,
        updates: {
          type: dqlSource ? 'dql' : 'sql',
          content,
          name: safeCellName(payload.title ?? payload.dqlArtifact?.name ?? 'AI edited cell'),
          execution: undefined,
          fromSnapshot: false,
          ...(payload.result
            ? { result: payload.result, status: 'success', executionCount: 1, stale: false }
            : { result: undefined, status: 'idle', executionCount: undefined }),
          ...(payload.chartConfig ? { chartConfig: payload.chartConfig } : {}),
          correctionProvenance: correctionProvenanceForDraft({
            question: payload.question,
            generatedSql: payload.sql ?? payload.dqlArtifact?.compiledSql,
            generatedDql: dqlSource,
            sourceRunId: payload.sourceRunId,
          }),
          ...(payload.dqlArtifact
            ? {
                dqlArtifact: {
                  source: payload.dqlArtifact.source,
                  sql: payload.sql,
                  name: payload.dqlArtifact.name,
                  sourcePath: payload.dqlArtifact.sourcePath,
                  kind: payload.dqlArtifact.kind,
                  metrics: payload.dqlArtifact.metrics,
                  dimensions: payload.dqlArtifact.dimensions,
                  parameters: payload.dqlArtifact.parameters,
                  parameterValues: payload.dqlArtifact.parameterValues,
                  persistence: payload.dqlArtifact.persistence,
                  trustState: payload.dqlArtifact.trustState,
                  compiledSql: payload.dqlArtifact.compiledSql ?? payload.sql,
                  ...(payload.question ? { question: payload.question } : {}),
                },
                dqlParameterValues: payload.dqlArtifact.parameterValues,
              }
            : { dqlArtifact: undefined, dqlParameterValues: undefined }),
        },
      });
      focusInsertedNotebookCell(aiSourceCellId);
      // An AI repair that lands as an unrun cell has not fixed anything yet —
      // the user still has to press run to find out whether it worked. When the
      // fix arrives without a result of its own, run it, the same way
      // "Format & Run" does. The 80ms tick lets the dispatched cell reach the
      // state ref that `executeCell` reads.
      if (!payload.result) {
        const cellId = aiSourceCellId;
        setTimeout(() => { void executeCell(cellId); }, 80);
      }
    },
    [aiSourceCellId, dispatch, executeCell],
  );

  const askFromHistory = useCallback((run: NotebookResearchRun) => {
    setAiSourceCellId(run.sourceCellId ?? null);
    setAiInitialInput(run.question);
    setAiHistoryOpen(false);
    setAiOpen(true);
  }, []);

  const openResearchFromAgentRun = useCallback(async (runId: string, notebookPath?: string) => {
    if (notebookPath && notebookPath !== activeNotebookPath) {
      const file = state.files.find((candidate) => candidate.path === notebookPath);
      if (file) onOpenFile(file);
    }
    try {
      const run = await api.getNotebookResearch(runId);
      setAiSourceCellId(run.sourceCellId ?? null);
      setAiInitialInput(run.question);
      emitNotebookResearchChanged({
        notebookPath: run.notebookPath,
        sourceCellId: run.sourceCellId,
        runId: run.id,
        reason: 'agent-run-open-research',
      });
    } catch {
      emitNotebookResearchChanged({
        notebookPath,
        runId,
        reason: 'agent-run-open-research',
      });
    }
    setAiHistoryRefreshKey(Date.now());
    setAiHistoryOpen(true);
    setAiOpen(true);
  }, [activeNotebookPath, onOpenFile, state.files]);

  if (!state.activeFile) {
    return <WelcomeScreen onOpenFile={onOpenFile} onOpenResearchFile={openFileForAiHistory} />;
  }

  // Dashboard / presentation mode
  if (state.dashboardMode) {
    return <DashboardView />;
  }

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: t.appBg,
      }}
    >
      {/* Notebook toolbar */}
      <NotebookToolbar
        t={t}
        aiOpen={aiOpen}
        historyOpen={aiHistoryOpen}
        historyBadge={aiHistoryBadge}
        onToggleAi={() => {
          setAiSourceCellId(null);
          setAiInitialInput('');
          setAiOpen((open) => !open);
        }}
        onToggleHistory={() => {
          setAiOpen(true);
          setAiHistoryOpen((open) => !open);
        }}
      />

      <div
        style={{
          flex: 1,
          display: 'flex',
          position: 'relative',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {/* Scrollable cell area */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "auto",
            padding: "0 0 40px",
            display: compactWorkspace && aiOpen ? "none" : "block",
          }}
        >
          <DocumentMetadataRow />
          {datasetImport.open && (
            <DatasetImportPanel
              afterId={datasetImport.afterId}
              onClose={() => setDatasetImport({ open: false })}
            />
          )}
          <CellList
            registerCellRef={registerCellRef}
            researchRefreshKey={aiHistoryRefreshKey}
            onStartResearch={openAiForCell}
          />
        </div>
        <div
          style={{ display: aiOpen ? "contents" : "none" }}
          aria-hidden={!aiOpen}
        >
          <NotebookAiDrawer
            t={t}
            notebookPath={activeNotebookPath}
            sourceCell={aiSourceCell}
            upstreamContext={aiContext}
            initialInput={aiInitialInput}
            historyOpen={aiHistoryOpen}
            historyRefreshKey={aiHistoryRefreshKey}
            onClose={() => setAiOpen(false)}
            onToggleHistory={() => setAiHistoryOpen((open) => !open)}
            onInsertSql={insertAiSqlCell}
            onInsertDql={insertGeneratedDqlCell}
            onReplaceDql={replaceSelectedCellFromAi}
            onAskFromHistory={askFromHistory}
            onOpenResearch={openResearchFromAgentRun}
            compact={compactWorkspace}
          />
        </div>
      </div>
    </div>
  );
}

function NotebookToolbar({
  t,
  aiOpen,
  historyOpen,
  historyBadge,
  onToggleAi,
  onToggleHistory,
}: {
  t: Theme;
  aiOpen: boolean;
  historyOpen: boolean;
  historyBadge: AiHistoryBadge;
  onToggleAi: () => void;
  onToggleHistory: () => void;
}) {
  const state = useNotebookStore(useShallow((store) => ({
    cellCount: store.cells.length,
    notebookDirty: store.notebookDirty,
  })));

  // Format last saved placeholder (we don't track real save times yet)
  const cellCount = state.cellCount;
  const historyTone = historyBadge.blocked > 0
    ? t.error
    : historyBadge.active > 0
      ? t.warning
      : t.accent;
  const historyTitle = historyBadge.total > 0
    ? [
        `${historyBadge.total} AI histor${historyBadge.total === 1 ? 'y item' : 'y items'}`,
        historyBadge.active > 0 ? `${historyBadge.active} open` : undefined,
        historyBadge.blocked > 0 ? `${historyBadge.blocked} blocked` : undefined,
      ].filter(Boolean).join(' · ')
    : 'Open notebook AI history';

  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.cellBg,
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 12,
      }}
    >
      {/* Breadcrumb */}
      <Breadcrumb t={t} />

      <div style={{ flex: 1 }} />

      <button
        type="button"
        title={aiOpen ? 'Hide notebook AI' : 'Ask AI about this notebook'}
        onClick={onToggleAi}
        style={{
          height: 26,
          border: `1px solid ${aiOpen ? t.accent : t.btnBorder}`,
          background: aiOpen ? `${t.accent}16` : t.btnBg,
          color: aiOpen ? t.accent : t.textSecondary,
          borderRadius: 6,
          padding: '0 9px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          fontWeight: 700,
          fontFamily: t.font,
          cursor: 'pointer',
        }}
      >
        <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
        Notebook AI
      </button>

      <button
        type="button"
        title={historyTitle}
        onClick={onToggleHistory}
        style={{
          height: 26,
          border: `1px solid ${historyOpen ? historyTone : t.btnBorder}`,
          background: historyOpen ? `${historyTone}12` : t.btnBg,
          color: historyOpen ? historyTone : t.textSecondary,
          borderRadius: 6,
          padding: '0 9px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          fontWeight: 700,
          fontFamily: t.font,
          cursor: 'pointer',
        }}
      >
        <History size={14} strokeWidth={2} aria-hidden="true" />
        History
        {historyBadge.total > 0 && (
          <span
            aria-label={historyTitle}
            style={{
              minWidth: 18,
              height: 18,
              borderRadius: 999,
              padding: '0 6px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: `1px solid ${historyTone}`,
              background: `${historyTone}14`,
              color: historyTone,
              fontSize: 10,
              fontWeight: 800,
              lineHeight: 1,
            }}
          >
            {historyBadge.total > 99 ? '99+' : historyBadge.total}
          </span>
        )}
      </button>

      {/* Meta info */}
      <span
        style={{
          fontSize: 11,
          color: t.textMuted,
          fontFamily: t.font,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span>
          {cellCount} {cellCount === 1 ? 'cell' : 'cells'}
        </span>
        {state.notebookDirty && (
          <span style={{ color: t.warning }}>● unsaved</span>
        )}
      </span>
    </div>
  );
}

function NotebookAiDrawer({
  t,
  notebookPath,
  sourceCell,
  upstreamContext,
  initialInput,
  historyOpen,
  historyRefreshKey,
  onClose,
  onToggleHistory,
  onInsertSql,
  onInsertDql,
  onReplaceDql,
  onAskFromHistory,
  onOpenResearch,
  compact,
}: {
  t: Theme;
  notebookPath?: string;
  sourceCell: Cell | null;
  upstreamContext?: string;
  initialInput: string;
  historyOpen: boolean;
  historyRefreshKey: number;
  onClose: () => void;
  onToggleHistory: () => void;
  onInsertSql: (sql: string, title?: string, meta?: SqlNotebookDraftMeta) => void;
  onInsertDql: (payload: InsertDqlPayload) => void;
  onReplaceDql: (payload: InsertDqlPayload) => void;
  onAskFromHistory: (run: NotebookResearchRun) => void;
  onOpenResearch: (id: string, notebookPath?: string) => void | Promise<void>;
  compact: boolean;
}) {
  const state = useNotebookStore(useShallow((store) => ({
    notebookTitle: store.notebookTitle,
    themeMode: store.themeMode,
  })));
  const openBlockInStudio = useOpenBlockInStudio();
  // Server-persisted conversation thread, keyed per notebook so a page refresh
  // resumes the same conversation.
  const agentThread = usePersistedAgentThreadId(`notebook:${notebookPath ?? 'notebook'}`);
  const [expanded, setExpanded] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  // Bump to remount the panel so "New chat" clears the transcript, not just the
  // thread id (mirrors Block Studio).
  const [aiPanelEpoch, setAiPanelEpoch] = useState(0);
  const sourceTitle = sourceCell
    ? `${sourceCell.type.toUpperCase()} cell${sourceCell.name ? ` · ${sourceCell.name}` : ''}`
    : 'Whole notebook';
  const scopeHint = sourceCell
    ? 'This cell + dbt, semantic metadata, certified saved queries, prior AI history'
    : 'Whole notebook + dbt, semantic metadata, certified saved queries, prior AI history';
  const agentRunSelectedObject = sourceCell
    ? { kind: 'cell' as const, id: sourceCell.id, title: sourceCell.name, path: notebookPath }
    : notebookPath
      ? { kind: 'notebook' as const, path: notebookPath, title: state.notebookTitle || 'Notebook' }
      : undefined;
  const agentRunWorkspaceContext = {
    ...notebookAiCellContext(sourceCell),
    notebookPath,
    notebookTitle: state.notebookTitle,
    sourceCellId: sourceCell?.id,
    sourceCellName: sourceCell?.name,
    sourceCellType: sourceCell?.type,
    notebookContext: upstreamContext,
  };

  return (
    <AiSidePanel
      t={t}
      title="Notebook AI"
      subtitle={sourceTitle}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((value) => !value)}
      onClose={onClose}
      compact={compact}
      onNewChat={() => { agentThread.resetThreadId(); setAiPanelEpoch((value) => value + 1); }}
      running={aiRunning}
      ariaLabel="Notebook AI"
      headerActions={(
        <AiSidePanelAction
          t={t}
          label={historyOpen ? 'Hide AI history' : 'Show AI history'}
          onClick={onToggleHistory}
          active={historyOpen}
        >
          <History size={14} />
        </AiSidePanelAction>
      )}
      dock="overlay"
    >
      {historyOpen && (
        <NotebookAiHistoryPanel
          t={t}
          notebookPath={notebookPath}
          sourceCellId={sourceCell?.id}
          refreshKey={historyRefreshKey}
          currentThreadId={agentThread.threadId}
          onOpenConversation={(id) => {
            // Remount the panel on that thread so it loads the conversation.
            agentThread.onThreadIdChange(id);
            setAiPanelEpoch((value) => value + 1);
            onToggleHistory();
          }}
          onAskFromHistory={onAskFromHistory}
        />
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <UnifiedAgentRunPanel
          key={`auto:${notebookPath ?? 'notebook'}:${sourceCell?.id ?? 'all'}:${aiPanelEpoch}`}
          themeMode={state.themeMode}
          title="Notebook AI"
          scopeHint={scopeHint}
          notebookPath={notebookPath}
          selectedObject={agentRunSelectedObject}
          workspaceContext={agentRunWorkspaceContext}
          initialMode="auto"
          initialInput={initialInput}
          threadId={agentThread.threadId}
          onThreadIdChange={agentThread.onThreadIdChange}
          onRunningChange={setAiRunning}
          onInsertSql={onInsertSql}
          onInsertDql={onInsertDql}
          onReplaceDql={sourceCell ? onReplaceDql : undefined}
          answerFirstCards
          insertDqlActionLabel="Add to notebook"
          // The button both replaces AND runs, so it has to say so.
          replaceDqlActionLabel={sourceCell ? 'Replace cell & run' : undefined}
          onOpenBlock={(path, name) => { void openBlockInStudio(path, name ?? path); }}
          onOpenResearch={(id, path) => { void onOpenResearch(id, path); }}
        />
      </div>
    </AiSidePanel>
  );
}

function NotebookAiHistoryPanel({
  t,
  notebookPath,
  sourceCellId,
  refreshKey,
  currentThreadId,
  onOpenConversation,
  onAskFromHistory,
}: {
  t: Theme;
  notebookPath?: string;
  sourceCellId?: string;
  refreshKey: number;
  currentThreadId?: string;
  onOpenConversation: (threadId: string) => void;
  onAskFromHistory: (run: NotebookResearchRun) => void;
}) {
  const [conversations, setConversations] = useState<AgentConversationThread[]>([]);
  const [runs, setRuns] = useState<NotebookResearchRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!notebookPath) {
      setConversations([]);
      setRuns([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Notebook AI conversations belong to the whole notebook; saved research
    // can be narrowed to the cell the panel was opened from.
    Promise.all([
      api.listAgentThreads({ notebookPath, limit: 12 })
        .then((page) => page.threads)
        // Conversations are best-effort: a missing store must not hide research.
        .catch(() => [] as AgentConversationThread[]),
      api.listNotebookResearch({
        path: notebookPath,
        sourceCellId,
        sort: 'updated_desc',
        limit: 12,
      }),
    ])
      .then(([threads, page]) => {
        if (cancelled) return;
        setConversations(threads);
        setRuns(page.runs);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentThreadId, notebookPath, refreshKey, sourceCellId]);

  return (
    <NotebookAiHistoryList
      t={t}
      conversations={conversations}
      runs={runs}
      loading={loading}
      error={error}
      sourceCellId={sourceCellId}
      currentThreadId={currentThreadId}
      onOpenConversation={onOpenConversation}
      onAskFromHistory={onAskFromHistory}
    />
  );
}

/**
 * What Notebook AI sends about the cell it was opened from: the cell's query
 * and, after a failed run, its error. The runtime hands both to the model with
 * the question, so "Fix this query" has a query to fix.
 */
export function notebookAiCellContext(cell: Cell | null): { cellSql?: string; cellError?: string } {
  if (!cell) return {};
  const sql = cell.type === 'sql'
    ? cell.content.trim()
    : cell.type === 'dql'
      ? extractSqlFromText(cell.content)?.trim()
      : undefined;
  return {
    ...(sql ? { cellSql: sql } : {}),
    ...(sql && cell.error ? { cellError: cell.error } : {}),
  };
}

/** The AI history list: this notebook's Notebook AI conversations, then its saved research. */
export function NotebookAiHistoryList({
  t,
  conversations,
  runs,
  loading,
  error,
  sourceCellId,
  currentThreadId,
  onOpenConversation,
  onAskFromHistory,
}: {
  t: Theme;
  conversations: AgentConversationThread[];
  runs: NotebookResearchRun[];
  loading: boolean;
  error: string | null;
  sourceCellId?: string;
  currentThreadId?: string;
  onOpenConversation: (threadId: string) => void;
  onAskFromHistory: (run: NotebookResearchRun) => void;
}) {
  const subheadingStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 800,
    color: t.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    margin: '2px 0 -2px',
  };

  return (
    <div
      style={{
        borderBottom: `1px solid ${t.headerBorder}`,
        background: t.appBg,
        maxHeight: 260,
        overflow: 'auto',
        padding: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Clock3 size={14} color={t.textMuted} />
        <div style={{ fontSize: 11, fontWeight: 850, color: t.textSecondary, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          AI history
        </div>
        <div style={{ flex: 1 }} />
        {loading && <span style={{ fontSize: 11, color: t.textMuted }}>Loading</span>}
      </div>
      {error && <div style={{ fontSize: 11, color: t.error, lineHeight: 1.4 }}>{error}</div>}
      {!loading && !error && conversations.length === 0 && runs.length === 0 && (
        <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.45 }}>
          No saved AI history for this {sourceCellId ? 'cell' : 'notebook'} yet.
        </div>
      )}
      <div style={{ display: 'grid', gap: 7 }}>
        {conversations.length > 0 && <div style={subheadingStyle}>Conversations</div>}
        {conversations.map((thread) => {
          const current = thread.id === currentThreadId;
          return (
            <button
              key={thread.id}
              type="button"
              title={current ? 'This conversation is open' : 'Continue this conversation'}
              onClick={() => onOpenConversation(thread.id)}
              style={{
                border: `1px solid ${current ? t.accent : t.cellBorder}`,
                background: t.cellBg,
                color: t.textPrimary,
                borderRadius: 8,
                padding: '8px 9px',
                textAlign: 'left',
                cursor: 'pointer',
                display: 'grid',
                gap: 4,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {thread.title || 'Notebook AI conversation'}
                </span>
                {current && (
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: t.accent, fontWeight: 850 }}>
                    open
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>
                {formatHistoryDate(thread.updatedAt)}
              </div>
            </button>
          );
        })}
        {conversations.length > 0 && runs.length > 0 && <div style={subheadingStyle}>Research</div>}
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            onClick={() => onAskFromHistory(run)}
            style={{
              border: `1px solid ${t.cellBorder}`,
              background: t.cellBg,
              color: t.textPrimary,
              borderRadius: 8,
              padding: '8px 9px',
              textAlign: 'left',
              cursor: 'pointer',
              display: 'grid',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {run.title || run.question}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: historyRunTone(run, t), fontWeight: 850 }}>
                {formatHistoryStatus(run)}
              </span>
            </div>
            <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {run.question}
            </div>
            <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>
              {formatHistoryDate(run.updatedAt)}
              {run.generatedSql || run.reviewedSql ? ' · SQL saved' : ''}
              {run.dqlPromotionAction ? ` · ${run.dqlPromotionAction.split('_').join(' ')}` : ''}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function buildNotebookAiContext(input: {
  notebookPath?: string;
  notebookTitle?: string;
  notebookMetadata: NotebookDocMetadata;
  cell: Cell | null;
  cells: Cell[];
  datasets: DatasetSource[];
}): string {
  const lines: string[] = [];
  lines.push("Notebook AI contract:");
  lines.push(
    [
      "- Use the same path for research, SQL generation, SQL repair, DQL reuse checks, and DQL draft planning.",
      "- Always check certified DQL blocks, draft blocks, dbt/semantic metadata, and runtime schema before proposing new SQL.",
      "- Return one clear outcome: Reuse certified block, Use existing draft, Review SQL preview, Fix SQL, Create DQL draft, Needs review, or Cannot answer yet.",
      "- For review-required DQL artifacts, prefer reusable parameterizable SQL preview logic over hard-coded literals when the business question implies a reusable block.",
      "- Keep DQL certification manual; do not claim SQL previews or drafts are certified.",
      "- Imported CSV and staged warehouse snapshots are point-in-time local data. Never label a mixed local result certified.",
      "- Before a cross-source join, state the governed source, local dataset, proposed join keys and cardinality, freshness mismatch, extraction scope, and review-required trust label.",
      "- If join keys are ambiguous or likely many-to-many, ask a focused follow-up question instead of guessing.",
      "- Never request or include complete dataset rows. Use the supplied schema/profile/lineage and only bounded redacted samples from explicit tools.",
      "- Explain business purpose, grain, filters/parameters, technical lineage, duplicate/reuse evidence, preview status, and next action.",
    ].join("\n"),
  );
  lines.push(
    `Notebook: ${input.notebookTitle || input.notebookPath || "Untitled notebook"}`,
  );
  if (input.notebookPath) lines.push(`Path: ${input.notebookPath}`);
  const metadata = [
    input.notebookMetadata.purpose ? `Purpose: ${compactText(input.notebookMetadata.purpose, 1200)}` : '',
    input.notebookMetadata.description ? `Business context: ${compactText(input.notebookMetadata.description, 800)}` : '',
    input.notebookMetadata.status ? `Notebook status: ${input.notebookMetadata.status}` : '',
    input.notebookMetadata.ownerDomain ? `Owner domain: ${input.notebookMetadata.ownerDomain}` : '',
    input.notebookMetadata.usesDomains?.length ? `Uses domains: ${input.notebookMetadata.usesDomains.join(', ')}` : '',
    input.notebookMetadata.projectFilter ? `Scope filter: ${input.notebookMetadata.projectFilter}` : '',
    input.notebookMetadata.categories?.length ? `Categories: ${input.notebookMetadata.categories.join(', ')}` : '',
  ].filter(Boolean);
  if (metadata.length > 0) lines.push(metadata.join('\n'));

  const narrative = input.cells
    .filter((cell) => cell.type === 'markdown' && cell.content.trim())
    .slice(0, 12)
    .map((cell, index) => `${index + 1}. ${compactText(cell.content, 700)}`);
  if (narrative.length > 0) {
    lines.push('Notebook research narrative:');
    lines.push(narrative.join('\n'));
  }

  const researchEvidence = input.cells
    .filter((cell) => cell.annotations?.length || cell.upstream || cell.dependencies?.length)
    .slice(0, 30)
    .map((cell) => {
      const parts = [
        `${cell.type.toUpperCase()}${cell.name ? ` ${cell.name}` : ` ${cell.id}`}`,
        cell.upstream ? `upstream=${cell.upstream}` : '',
        cell.dependencies?.length
          ? `dependencies=${cell.dependencies.map((dependency) => dependency.output ?? dependency.cellId).join(',')}`
          : '',
        cell.annotations?.length
          ? `research=${cell.annotations.map((annotation) => `${annotation.kind ?? 'note'}:${compactText(annotation.body, 240)}`).join(' | ')}`
          : '',
      ].filter(Boolean);
      return `- ${parts.join(' · ')}`;
    });
  if (researchEvidence.length > 0) {
    lines.push('Notebook dependency and research evidence:');
    lines.push(researchEvidence.join('\n'));
  }
  if (input.datasets.length > 0) {
    const selectedIds = new Set(
      input.cell?.datasetRefs?.map((reference) => reference.id) ?? [],
    );
    const ranked = [...input.datasets]
      .sort(
        (a, b) => Number(selectedIds.has(b.id)) - Number(selectedIds.has(a.id)),
      )
      .slice(0, 20);
    lines.push("Available notebook datasets (metadata only; no full rows):");
    lines.push(
      ranked
        .map((dataset) =>
          [
            `- ${dataset.name} as ${dataset.alias}`,
            `storage=${dataset.storageMode}`,
            `trust=${dataset.trustState}`,
            `rows=${dataset.profile.rowCount}`,
            `refreshed=${dataset.refreshedAt}`,
            `columns=${dataset.profile.columns
              .slice(0, 40)
              .map(
                (column) =>
                  `${column.name}:${column.type}${column.flags?.length ? `[${column.flags.join("|")}]` : ""}`,
              )
              .join(", ")}`,
            dataset.lineage
              ? `lineage=${compactText(JSON.stringify(dataset.lineage), 700)}`
              : "",
            dataset.schemaDrift
              ? `schema_drift=${compactText(JSON.stringify(dataset.schemaDrift), 400)}`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n"),
    );
  }
  if (input.cell) {
    lines.push(`Selected cell: ${input.cell.type.toUpperCase()}${input.cell.name ? ` ${input.cell.name}` : ''}`);
    const parameterValues = input.cell.blockBinding?.parameterValues
      ?? input.cell.dqlParameterValues
      ?? input.cell.dqlArtifact?.parameterValues;
    if (parameterValues && Object.keys(parameterValues).length > 0) {
      lines.push(`Selected parameters: ${compactText(JSON.stringify(parameterValues), 800)}`);
    }
    if (input.cell.blockBinding) {
      lines.push(`Block binding: ${input.cell.blockBinding.path} · ${input.cell.blockBinding.state}`);
    }
    if (input.cell.dqlArtifact?.trustState || input.cell.dqlArtifact?.reviewState) {
      lines.push(`Trust: ${input.cell.dqlArtifact.trustState ?? input.cell.dqlArtifact.reviewState}`);
    }
    if (input.cell.error) lines.push(`Current error: ${input.cell.error}`);
    if (input.cell.result) {
      lines.push(`Result columns: ${input.cell.result.columns.join(', ')}`);
      lines.push(`Result rows: ${input.cell.result.rowCount ?? input.cell.result.rows.length}`);
    }
    lines.push('Selected cell content:');
    lines.push(input.cell.content);
  } else {
    const executableCells = input.cells
      .filter((cell) => cell.type === 'sql' || cell.type === 'dql')
      .slice(0, 8)
      .map((cell, index) => `${index + 1}. ${cell.type.toUpperCase()}${cell.name ? ` ${cell.name}` : ''}: ${compactText(cell.content, 600)}`);
    if (executableCells.length > 0) {
      lines.push('Notebook SQL/DQL cells:');
      lines.push(executableCells.join('\n'));
    }
  }
  return lines.join('\n\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactText(value: string | undefined, limit: number): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > limit ? `${clean.slice(0, Math.max(0, limit - 3))}...` : clean;
}

function safeCellName(value: string): string {
  const clean = value
    .replace(/[^a-zA-Z0-9_ -]+/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return clean || 'ai_sql_draft';
}

function formatHistoryDate(value?: string): string {
  if (!value) return 'Saved';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Saved';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatHistoryStatus(run: NotebookResearchRun): string {
  if (run.status === 'error') return 'error';
  if (run.reviewStatus === 'certified') return 'certified';
  if (run.reviewStatus === 'draft_created') return 'draft';
  if (run.reviewStatus === 'completed') return 'done';
  return 'review';
}

function historyRunTone(run: NotebookResearchRun, t: Theme): string {
  if (run.status === 'error' || run.reviewChecklist?.blockers.length) return t.error;
  if (run.reviewStatus === 'certified' || run.reviewStatus === 'completed') return t.success;
  if (run.reviewStatus === 'draft_created') return t.accent;
  return t.warning;
}

function Breadcrumb({ t }: { t: Theme }) {
  const activeFile = useNotebookStore((state) => state.activeFile);
  if (!activeFile) return null;

  const parts = activeFile.path.split('/').filter(Boolean);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        fontFamily: t.fontMono,
        color: t.textMuted,
        overflow: 'hidden',
      }}
    >
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span style={{ color: t.textMuted, opacity: 0.5 }}>/</span>
          )}
          <span
            style={{
              color: i === parts.length - 1 ? t.textSecondary : t.textMuted,
              fontWeight: i === parts.length - 1 ? 500 : 400,
              whiteSpace: 'nowrap' as const,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: i === parts.length - 1 ? 200 : 100,
            }}
          >
            {part}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}
