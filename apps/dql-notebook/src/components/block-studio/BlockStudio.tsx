import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { certifiedByLabel, plainCertificationChecks } from '@zlens/core/apps/reader-trust';
import { useShallow } from 'zustand/react/shallow';
import { useQuery } from '@tanstack/react-query';
import { renderSemanticBlockSource } from '@zlens/core/blocks';
import { AlertTriangle, Blocks, Bot, CheckCircle2, CheckSquare, ChevronLeft, ChevronRight, Code2, Database, FileInput, Loader2, MoreHorizontal, PanelRightOpen, Pencil, Play, Plus, Search, ShieldCheck, Sparkles, Square, Trash2, X, type LucideIcon } from 'lucide-react';
import { hostReadOnly, readOnlyReason, useHostUi } from '../../host/host-ui';
import { api, DqlApiError, type BlockCertificationOperationResult } from '../../api/client';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { useOperations } from '../../operations/OperationsProvider';
import { newestMatchingBlockCertificationOperation } from '../../operations/operation-state';
import { controlStyle } from '../../themes/control-tokens';
import { CommaListInput } from '../common/CommaListInput';
import { SourceTextField } from '../common/SourceTextField';
import type {
  BlockStudioDiagnostic,
  DatabaseSchemaNode,
  SemanticLayerState,
  SemanticObjectDetail,
  SemanticTreeNode,
  BlockStudioImportSession,
  BlockStudioImportSessionSummary,
  BlockStudioImportCandidate,
  BlockStudioOpenPayload,
  BlockStudioMetadata,
  BlockStudioDbtStatus,
  BlockParameterDefinition,
  SemanticDimension,
  SemanticCompatibility,
  Domain,
} from '../../store/types';

/** Display name for the engine that will actually execute a semantic query. */
const RUNTIME_ENGINE_LABEL: Record<string, string> = {
  native: 'Native (DQL)',
  'metricflow-cli': 'Local MetricFlow',
  'dbt-cloud': 'dbt Cloud',
};

/** Turn a machine incompatibility reason into a one-line explanation. */
function describeIncompatibility(reason: string): string {
  switch (reason) {
    case 'no_join_path': return 'No join path from this metric’s model to this dimension.';
    case 'one_to_many_only': return 'Reachable only through a one-to-many join, which would repeat each metric value.';
    case 'not_shared_across_metrics': return 'Not reachable from every selected metric.';
    case 'metric_unresolved': return 'The selected metric could not be resolved.';
    default: return 'Not compatible with the selected metrics.';
  }
}

const ALL_TIME_GRAINS = ['day', 'week', 'month', 'quarter', 'year'];

/** The grains a selected time dimension actually supports — from the
 *  compatibility answer or the catalog time-dimension list — falling back to all
 *  five when the base grain is unknown. */
function selectedTimeGrains(
  timeDimensionName: string | undefined,
  compatibleDimByName: Map<string, SemanticDimension>,
  timeDimensions: SemanticDimension[],
): string[] {
  if (!timeDimensionName) return ALL_TIME_GRAINS;
  const fromCompat = compatibleDimByName.get(timeDimensionName)?.granularities;
  if (fromCompat && fromCompat.length > 0) return fromCompat;
  const fromCatalog = timeDimensions.find((d) =>
    (d.reference ?? d.name) === timeDimensionName || d.name === timeDimensionName
  )?.granularities;
  if (fromCatalog && fromCatalog.length > 0) return fromCatalog;
  return ALL_TIME_GRAINS;
}
import { themes } from '../../themes/notebook-theme';
import type { Theme, ThemeMode } from '../../themes/notebook-theme';
import { SQLCellEditor } from '../cells/SQLCellEditor';
import { ChartOutput, CHART_TYPE_OPTIONS, resolveChartType } from '../output/ChartOutput';
import { MiniLineageGraph } from '../lineage/MiniLineageGraph';
import { LineagePathSection, LayerSummary } from '../lineage/LineagePathBreadcrumb';
import type { CompletePathResult } from '../lineage/lineage-constants';
import { TableOutput } from '../output/TableOutput';
import { BlockLibraryPanel } from '../panels/BlockLibraryPanel';
import { BuildSidebar } from '../panels/BuildSidebar';
import { blockDomainOptions, certifyNeedsDomain } from './domain-options';
import { MetricDetailPanel } from '../panels/MetricDetailPanel';
import { SemanticSearchBar } from '../panels/SemanticSearchBar';
import { SemanticTreeNode as TreeRow } from '../panels/SemanticTreeNode';
import type { AiSqlDraftMeta } from '../agent/AiSqlDraftDialog';
import { BlockStatusBadge } from '../blocks/BlockStatusBadge';
import { BlockReplacementLink, OpenReplacementButton } from '../blocks/BlockRetirement';
import { UnifiedAgentRunPanel, usePersistedAgentThreadId, type InsertDqlPayload } from '../agent/UnifiedAgentRunPanel';
import { AiSidePanel, AI_SIDE_PANEL_EXPANDED_WIDTH } from '../agent/AiSidePanel';
import {
  appendSemanticRefToQuery,
  buildSemanticRef,
  inferVisualParameterType,
  parseBlockFields,
  parseVisualBlockParameters,
  getDqlSectionBody,
  hasCompleteBlockEnvelope,
  reconcileSemanticCompatibility,
  removeVisualBlockParameter,
  parseSemanticVisualFields,
  setSemanticArray,
  setSemanticMetrics,
  setSemanticRuntimeFilters,
  setSemanticScalar,
  setBlockName,
  setBlockArray,
  setBlockStringField,
  setBlockQuery,
  setBlockTags,
  setDqlSectionBody,
  upsertVisualBlockParameter,
  upsertSemanticSelection,
  upsertVisualizationConfig,
  visualParameterDefaultText,
} from '../../utils/block-studio';
import { getTypeColor } from '../../utils/type-colors';
import { BlockParameterControls } from '../parameters/BlockParameterControls';
import type { BlockEntry } from '../blocks/block-types';
import { buildCatalogFooter } from '../panels/build-footer';

type ExplorerTab = 'blocks' | 'semantic' | 'database';
type ResultTab = 'results' | 'parameters' | 'lineage' | 'save' | 'history';
type BlockStudioWorkspaceMode = 'start' | 'manual' | 'import';
// 'detail' = the prototype's read-only block overview shown when an existing
// block is opened from the explorer; "Open in builder" enters visual/source.
type BlockStudioEditorMode = 'detail' | 'visual' | 'source';

interface FlatSemanticRow {
  node: SemanticTreeNode;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
}

const TREE_ROW_HEIGHT = 31;
const TREE_OVERSCAN = 10;

export function BlockStudio() {
  const hostUi = useHostUi();
  const readOnlyBlocks = hostReadOnly(hostUi, 'block_library');
  const readOnlyBlocksReason = readOnlyBlocks ? readOnlyReason(hostUi, 'block_library') : '';
  const state = useNotebookStore(useShallow((store) => ({
    activeBlockPath: store.activeBlockPath,
    authoredDomains: store.authoredDomains,
    blockStudioDbtStatus: store.blockStudioDbtStatus,
    blockStudioDirty: store.blockStudioDirty,
    blockStudioDraft: store.blockStudioDraft,
    blockStudioImportOpen: store.blockStudioImportOpen,
    blockStudioLastRun: store.blockStudioLastRun,
    blockStudioMetadata: store.blockStudioMetadata,
    blockStudioPreview: store.blockStudioPreview,
    blockStudioValidation: store.blockStudioValidation,
    files: store.files,
    schemaTables: store.schemaTables,
    semanticLayer: store.semanticLayer,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const { operations, track: trackOperation } = useOperations();
  const t = themes[state.themeMode];
  const [draftSessionId, setDraftSessionId] = useState(() => readBlockStudioDraftId());
  const agentScope = state.activeBlockPath
    ? `block-studio.block.${encodeURIComponent(state.activeBlockPath)}`
    : `block-studio.draft.${draftSessionId}`;
  const agentThread = usePersistedAgentThreadId(agentScope);
  const [explorerTab, setExplorerTab] = useState<ExplorerTab>('blocks');
  const [resultTab, setResultTab] = useState<ResultTab>('results');
  const [domainFilter, setDomainFilter] = useState(() => readBlockStudioDomain());
  const [databaseTree, setDatabaseTree] = useState<DatabaseSchemaNode[]>([]);
  const [expandedDbNodes, setExpandedDbNodes] = useState<Record<string, boolean>>({});
  const [databaseQuery, setDatabaseQuery] = useState('');
  const [loadingDbNodes, setLoadingDbNodes] = useState<Set<string>>(new Set());
  // Real tables→columns for IDE-style SQL completion inside the block's query
  // body. The Block Studio catalog is included because a notebook schema may
  // not have been opened before a user starts authoring a block.
  const editorSchema = useMemo(
    () => {
      const liveSchema = state.schemaTables.map((tbl) => [tbl.name, tbl.columns.map((c) => c.name)] as const);
      const catalogSchema = flattenDatabaseTables(databaseTree).map((table) => [table.path, table.columns] as const);
      const entries = new Map<string, string[]>();
      for (const [table, columns] of [...catalogSchema, ...liveSchema]) {
        if (table) entries.set(table, columns);
      }
      return entries.size > 0 ? Object.fromEntries(entries) : undefined;
    },
    [state.schemaTables, databaseTree],
  );
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runErrorDetails, setRunErrorDetails] = useState<string | null>(null);
  const [queryDetailsOpen, setQueryDetailsOpen] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runElapsedMs, setRunElapsedMs] = useState(0);
  const [parameterValues, setParameterValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryScope, setRecoveryScope] = useState<'save' | 'run' | null>(null);
  const [repairNotice, setRepairNotice] = useState<string | null>(null);
  const [repairWarning, setRepairWarning] = useState<string | null>(null);
  const [certificationOperationId, setCertificationOperationId] = useState<string | null>(null);
  const mutationInFlightRef = useRef(false);
  // One-shot: how the NEXT block open should present. 'builder' skips the
  // read-only detail overview when the user just created the block from an answer.
  const openIntentRef = useRef<'builder' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [identityGapNotice, setIdentityGapNotice] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pendingDeleteBlock, setPendingDeleteBlock] = useState<{ path: string; name: string } | null>(null);
  const [deletingBlock, setDeletingBlock] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [blockLibraryRefreshKey, setBlockLibraryRefreshKey] = useState(0);
  const [saveIdentityOpen, setSaveIdentityOpen] = useState(false);
  const [dirtyGuardOpen, setDirtyGuardOpen] = useState(false);
  const pendingBlockOpenRef = useRef<BlockEntry | null>(null);
  const pendingIdentityActionRef = useRef<'save' | 'certify' | null>(null);
  const newAfterSaveRef = useRef(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<Array<{ hash: string; date: string; author: string; message: string }>>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyStatus, setHistoryStatus] = useState<{ status: Awaited<ReturnType<typeof api.getBlockHistory>>['status']; message?: string }>({ status: 'ok' });
  const historyRequestRef = useRef<{ key: string; seq: number }>({ key: '', seq: 0 });
  const [lineageLoading, setLineageLoading] = useState(false);
  const [lineageDetail, setLineageDetail] = useState<{
    node: { id: string; type: string; name: string; domain?: string } | null;
    incoming: Array<{ edge: { type: string }; node?: { id: string; type: string; name: string; domain?: string } }>;
    outgoing: Array<{ edge: { type: string }; node?: { id: string; type: string; name: string; domain?: string } }>;
  } | null>(null);
  const [lineageGraph, setLineageGraph] = useState<{ nodes: Array<{ id: string; type: string; name: string; domain?: string; layer?: string }>; edges: Array<{ source: string; target: string; type: string }> } | null>(null);
  const [lineagePaths, setLineagePaths] = useState<CompletePathResult | null>(null);
  const [leftPaneWidth, setLeftPaneWidth] = useState(340);
  const [bottomPaneHeight, setBottomPaneHeight] = useState(320);
  const [leftPaneCollapsed, setLeftPaneCollapsed] = useState(false);
  const [bottomPaneCollapsed, setBottomPaneCollapsed] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => typeof window !== 'undefined' ? window.innerWidth < 900 : false);
  const [workspaceMode, setWorkspaceMode] = useState<BlockStudioWorkspaceMode>(() => state.blockStudioImportOpen ? 'import' : 'start');
  const [editorMode, setEditorMode] = useState<BlockStudioEditorMode>('visual');
  const [aiDockOpen, setAiDockOpen] = useState(() => readBlockStudioBoolean('dql.block-studio.ai.open', false));
  const [aiDockWidth, setAiDockWidth] = useState(() => readBlockStudioNumber('dql.block-studio.ai.width', 420, 360, 520));
  const [aiDockExpanded, setAiDockExpanded] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [agentPanelEpoch, setAgentPanelEpoch] = useState(0);
  const [importSession, setImportSession] = useState<BlockStudioImportSession | null>(null);
  const [importSessions, setImportSessions] = useState<BlockStudioImportSessionSummary[]>([]);
  const [importSessionsLoading, setImportSessionsLoading] = useState(false);
  const [semanticInsertChoice, setSemanticInsertChoice] = useState<SemanticObjectDetail | null>(null);
  const [databaseInsertWarning, setDatabaseInsertWarning] = useState<string | null>(null);
  // How the governed Ask-AI overlay was opened: 'ask' = freeform, 'build' = draft a
  // new block, 'edit' = modify the current block. Drives requested mode + edit context.
  const [askAiKind, setAskAiKind] = useState<'ask' | 'build' | 'edit'>('ask');
  const [askAiInitialInput, setAskAiInitialInput] = useState('');
  const [askAiSeed, setAskAiSeed] = useState<{ text: string; mode: 'auto' | 'block'; nonce: number } | undefined>(undefined);
  const [contextInspectorOpen, setContextInspectorOpen] = useState(false);
  const [certificationResult, setCertificationResult] = useState<{
    ok?: boolean;
    pending?: boolean;
    checklist?: {
      metadata: boolean;
      validation: boolean;
      run: boolean;
      tests: boolean;
      chart: boolean;
      lineage: boolean;
      aiReviewed: boolean;
      blockers: string[];
      issues?: BlockStudioDiagnostic[];
      checkedAt?: string;
    };
    certification?: {
      certified: boolean;
      errors: Array<{ rule: string; message: string }>;
      warnings: Array<{ rule: string; message: string }>;
    };
    blockers?: string[];
    error?: string;
    phase?: string;
    progress?: number;
    message?: string;
  } | null>(null);
  const lastActiveBlockPathRef = useRef<string | null>(state.activeBlockPath);
  const certificationPathsRef = useRef(new Set<string>());
  const handledCertificationOperationsRef = useRef(new Set<string>());
  const blockScopeEpochRef = useRef(0);
  const liveDraftRef = useRef(state.blockStudioDraft);
  liveDraftRef.current = state.blockStudioDraft;

  const resetBlockScopedActivity = useCallback(() => {
    blockScopeEpochRef.current += 1;
    setRunning(false);
    setRunError(null);
    setRunErrorDetails(null);
    setQueryDetailsOpen(false);
    setRunStartedAt(null);
    setRunElapsedMs(0);
    setParameterValues({});
    setSaving(false);
    setRepairing(false);
    setRecoveryError(null);
    setRecoveryScope(null);
    setRepairNotice(null);
    setRepairWarning(null);
    setSaveError(null);
    setCertificationResult(null);
    setCertificationOperationId(null);
    setHistoryEntries([]);
    setHistoryLoaded(false);
    setHistoryStatus({ status: 'ok' });
    setResultTab('results');
  }, []);

  const catalogQuery = useQuery({
    queryKey: ['block-studio', 'catalog', 'summary'],
    queryFn: () => api.getBlockStudioCatalog({ includeSemantic: false }),
    staleTime: 30_000,
  });
  const dbtStatusQuery = useQuery({
    queryKey: ['block-studio', 'dbt-status'],
    queryFn: () => api.getBlockStudioDbtStatus(),
    staleTime: 30_000,
  });
  const semanticLayerQuery = useQuery({
    queryKey: ['semantic-layer'],
    queryFn: () => api.getSemanticLayer(),
    staleTime: 30_000,
  });

  useEffect(() => {
    const invalidate = () => setBlockLibraryRefreshKey((current) => current + 1);
    window.addEventListener('dql:block-library-invalidated', invalidate);
    return () => window.removeEventListener('dql:block-library-invalidated', invalidate);
  }, []);

  useEffect(() => {
    if (certificationOperationId) return;
    const operation = newestMatchingBlockCertificationOperation(operations, {
      activePath: state.activeBlockPath,
      sourceFingerprint: state.blockStudioMetadata?.sourceFingerprint,
    });
    if (!operation || handledCertificationOperationsRef.current.has(operation.id)) return;
    // Only a certification still in progress is picked up again. A finished one
    // from earlier must not replay its checklist or error, or keep Certify disabled.
    if (operation.status !== 'queued' && operation.status !== 'running') return;
    trackOperation(operation);
    setCertificationOperationId(operation.id);
    const result = operation.result as BlockCertificationOperationResult | undefined;
    certificationPathsRef.current = new Set([
      state.activeBlockPath,
      operation.scope.startsWith('block:') ? operation.scope.slice('block:'.length) : undefined,
      result?.oldPath,
      result?.draftPath,
      result?.newPath,
    ].filter((value): value is string => Boolean(value)));
  }, [
    certificationOperationId,
    operations,
    state.activeBlockPath,
    state.blockStudioMetadata?.sourceFingerprint,
    trackOperation,
  ]);

  useEffect(() => {
    if (!certificationOperationId) return;
    const operation = operations.find((candidate) => candidate.id === certificationOperationId);
    if (!operation) return;
    if (operation.status === 'queued' || operation.status === 'running') {
      setCertificationResult({
        pending: true,
        phase: operation.phase,
        progress: operation.progress,
        message: operation.message,
      });
      return;
    }
    if (operation.status === 'succeeded') {
      const result = operation.result as BlockCertificationOperationResult | undefined;
      setCertificationResult({
        pending: false,
        ok: result?.outcome === 'certified',
        checklist: result?.checklist,
        blockers: result?.blockers ?? result?.checklist?.blockers,
        error: result?.outcome === 'draft_saved_with_blockers'
          ? 'The draft was saved. Resolve the certification blockers and try again.'
          : result?.outcome === 'certified_unchanged_with_blockers'
            ? 'The certified version is unchanged. Resolve these blockers to re-certify it.'
            : undefined,
      });
      setSaveError(null);
    } else {
      setSaveError(operation.error?.message ?? 'Certification did not complete. The draft remains saved.');
      setCertificationResult({ pending: false, error: operation.error?.message ?? operation.message });
    }
    handledCertificationOperationsRef.current.add(operation.id);
    setCertificationOperationId(null);
    setResultTab('save');
  }, [certificationOperationId, operations]);

  useEffect(() => {
    dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG_LOADING', loading: catalogQuery.isLoading });
    if (catalogQuery.data) {
      dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG', catalog: catalogQuery.data });
      setDatabaseTree(catalogQuery.data.databaseTree);
      setCatalogError(null);
    } else if (catalogQuery.isError) {
      setCatalogError('Failed to load schema. Check your connection and try refreshing.');
    }
  }, [catalogQuery.data, catalogQuery.isError, catalogQuery.isLoading, dispatch]);

  useEffect(() => {
    if (dbtStatusQuery.data) dispatch({ type: 'SET_BLOCK_STUDIO_DBT_STATUS', status: dbtStatusQuery.data });
    else if (dbtStatusQuery.isError) dispatch({ type: 'SET_BLOCK_STUDIO_DBT_STATUS', status: null });
  }, [dbtStatusQuery.data, dbtStatusQuery.isError, dispatch]);

  useEffect(() => {
    dispatch({ type: 'SET_SEMANTIC_LOADING', loading: semanticLayerQuery.isLoading });
    if (semanticLayerQuery.data) dispatch({ type: 'SET_SEMANTIC_LAYER', layer: semanticLayerQuery.data });
  }, [dispatch, semanticLayerQuery.data, semanticLayerQuery.isLoading]);

  const refreshImportSessions = useCallback(async () => {
    setImportSessionsLoading(true);
    try {
      const result = await api.listBlockStudioImports();
      setImportSessions(result.sessions ?? []);
    } catch {
      setImportSessions([]);
    } finally {
      setImportSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshImportSessions();
  }, [refreshImportSessions]);

  useEffect(() => {
    const previous = lastActiveBlockPathRef.current;
    const current = state.activeBlockPath;
    if (current !== previous) {
      const operation = certificationOperationId
        ? operations.find((candidate) => candidate.id === certificationOperationId)
        : undefined;
      const result = operation?.result as BlockCertificationOperationResult | undefined;
      const certificationPaths = new Set([
        ...certificationPathsRef.current,
        result?.oldPath,
        result?.draftPath,
        result?.newPath,
      ].filter((value): value is string => Boolean(value)));
      const isCertificationTransition = Boolean(
        current
        && certificationPaths.has(current)
        && (!previous || certificationPaths.has(previous)),
      );
      if (!isCertificationTransition) {
        certificationPathsRef.current.clear();
        resetBlockScopedActivity();
      }
    }
    if (current && current !== previous) {
      dispatch({ type: 'CLOSE_BLOCK_IMPORT' });
    }
    lastActiveBlockPathRef.current = current;
  }, [state.activeBlockPath, certificationOperationId, dispatch, operations, resetBlockScopedActivity]);

  useEffect(() => {
    if (!state.blockStudioDirty) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [state.blockStudioDirty]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (!state.blockStudioDraft.trim()) return;
      void api.validateBlockStudio(state.blockStudioDraft, state.activeBlockPath, controller.signal)
        .then((validation) => {
          if (!controller.signal.aborted) dispatch({ type: 'SET_BLOCK_STUDIO_VALIDATION', validation });
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [state.blockStudioDraft, state.activeBlockPath, dispatch]);

  const filteredDatabaseTree = useMemo(
    () => filterDatabaseTree(databaseTree, databaseQuery),
    [databaseTree, databaseQuery],
  );
  const databaseStats = useMemo(
    () => summarizeDatabaseTree(databaseTree),
    [databaseTree],
  );
  const semanticStats = {
    metrics: state.semanticLayer.metrics.length,
    measures: state.semanticLayer.measures.length,
    dimensions: state.semanticLayer.dimensions.length,
    timeDimensions: state.semanticLayer.timeDimensions.length,
    entities: state.semanticLayer.entities.length,
    hierarchies: state.semanticLayer.hierarchies.length,
    semanticModels: state.semanticLayer.semanticModels.length,
    savedQueries: state.semanticLayer.savedQueries.length,
  };
  const semanticObjectCount = countSemanticObjects(semanticStats);

  useEffect(() => {
    const updateCompactLayout = () => setCompactLayout(window.innerWidth < 900);
    updateCompactLayout();
    window.addEventListener('resize', updateCompactLayout);
    return () => window.removeEventListener('resize', updateCompactLayout);
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem('dql.block-studio.ai.open', aiDockOpen ? '1' : '0'); } catch { /* best effort */ }
  }, [aiDockOpen]);

  useEffect(() => {
    try { window.localStorage.setItem('dql.block-studio.ai.width', String(aiDockWidth)); } catch { /* best effort */ }
  }, [aiDockWidth]);

  useEffect(() => {
    if (!domainFilter) return;
    try { window.localStorage.setItem('dql.block-studio.domain', domainFilter); } catch { /* best effort */ }
  }, [domainFilter]);

  useEffect(() => {
    const activeDomain = state.blockStudioMetadata?.domain?.trim();
    if (activeDomain && activeDomain !== 'uncategorized') setDomainFilter(activeDomain);
  }, [state.activeBlockPath, state.blockStudioMetadata?.domain]);

  useEffect(() => {
    if (!state.blockStudioImportOpen) return;
    if (!readOnlyBlocks) setWorkspaceMode('import');
    dispatch({ type: 'CLOSE_BLOCK_IMPORT' });
  }, [dispatch, readOnlyBlocks, state.blockStudioImportOpen]);

  useEffect(() => {
    setWorkspaceMode(hasBlockStudioWorkspaceContent(state) ? 'manual' : 'start');
    setEditorMode(parseBlockFields(state.blockStudioDraft)?.blockType === 'semantic' ? 'visual' : 'source');
  }, [state.activeBlockPath]);

  const draftMetadata = useMemo(() => {
    const parsed = parseBlockFields(state.blockStudioDraft);
    if (!state.blockStudioMetadata) return parsed;
    return {
      ...parsed,
      name: parsed?.name || state.blockStudioMetadata.name,
      domain: parsed?.domain || state.blockStudioMetadata.domain,
      description: parsed?.description || state.blockStudioMetadata.description,
      owner: parsed?.owner || state.blockStudioMetadata.owner,
      tags: parsed?.tags?.length ? parsed.tags : state.blockStudioMetadata.tags,
      blockType: parsed?.blockType || 'custom',
      status: parsed?.status || state.blockStudioMetadata.reviewStatus || 'draft',
    };
  }, [state.blockStudioDraft, state.blockStudioMetadata]);
  const activeBlockName = draftMetadata?.name ?? state.blockStudioMetadata?.name ?? null;
  const blockType = draftMetadata?.blockType ?? 'custom';
  const isSemanticBlock = blockType === 'semantic';
  const hasActiveDraft = Boolean(state.blockStudioDraft.trim() || state.blockStudioMetadata || state.activeBlockPath);

  // Opening an EXISTING block from the library lands on the read-only detail
  // overview; new drafts (no saved path) go straight to the builder. A block the
  // user just created from an AI answer is the second case, not the first — they
  // asked to build on it, so honour that intent for exactly one open.
  useEffect(() => {
    if (!state.activeBlockPath) return;
    if (openIntentRef.current === 'builder') {
      openIntentRef.current = null;
      setEditorMode(parseBlockFields(state.blockStudioDraft)?.blockType === 'semantic' ? 'visual' : 'source');
      return;
    }
    if (state.activeBlockPath) setEditorMode('detail');
  }, [state.activeBlockPath]);

  const loadBlockLineage = useCallback(async (blockName: string) => {
    const scopeEpoch = blockScopeEpochRef.current;
    const nodeId = `block:${blockName}`;
    dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
    setLineageLoading(true);
    try {
      const [detail, focused, paths] = await Promise.all([
        api.fetchLineageNode(nodeId),
        // Block Studio is a focused authoring view, not the project-wide
        // lineage explorer. Bound the neighborhood so large projects remain
        // readable while preserving the block's technical context.
        api.queryLineage({ focus: nodeId, upstreamDepth: 3, downstreamDepth: 2 }),
        api.fetchLineagePaths(nodeId, { maxDepth: 6, maxPaths: 6 }),
      ]);
      if (scopeEpoch !== blockScopeEpochRef.current) return;
      setLineageDetail(detail);
      setLineageGraph(focused.graph ?? null);
      setLineagePaths(paths);
    } catch {
      if (scopeEpoch !== blockScopeEpochRef.current) return;
      setLineageDetail(null);
      setLineageGraph(null);
      setLineagePaths(null);
    } finally {
      if (scopeEpoch === blockScopeEpochRef.current) setLineageLoading(false);
    }
  }, [dispatch]);

  useEffect(() => {
    if (!activeBlockName) return;
    void loadBlockLineage(activeBlockName);
  }, [activeBlockName, loadBlockLineage]);

  const historySourceFingerprint = state.blockStudioMetadata?.sourceFingerprint;
  const loadBlockHistory = useCallback(() => {
    const blockPath = state.activeBlockPath;
    if (!blockPath || historyLoaded) return;
    const key = `${blockPath}\u0000${historySourceFingerprint ?? ''}`;
    if (historyRequestRef.current.key === key) return; // this version is already loading
    const seq = historyRequestRef.current.seq + 1;
    historyRequestRef.current = { key, seq };
    const scopeEpoch = blockScopeEpochRef.current;
    const settle = (entries: typeof historyEntries, status: typeof historyStatus) => {
      if (historyRequestRef.current.seq !== seq) return;
      historyRequestRef.current = { key: '', seq };
      if (scopeEpoch !== blockScopeEpochRef.current || blockPath !== lastActiveBlockPathRef.current) return;
      setHistoryEntries(entries);
      setHistoryStatus(status);
      setHistoryLoaded(true);
    };
    void api.getBlockHistory(blockPath)
      .then((result) => settle(result.entries, { status: result.status, message: result.message }))
      .catch((error) => settle([], { status: 'error', message: error instanceof Error ? error.message : String(error) }));
  }, [historyLoaded, historySourceFingerprint, state.activeBlockPath]);

  // A saved block gets a new path or source fingerprint: drop the old history
  // and load it again if the History tab is showing.
  useEffect(() => {
    historyRequestRef.current = { key: '', seq: historyRequestRef.current.seq + 1 };
    setHistoryLoaded(false);
  }, [state.activeBlockPath, historySourceFingerprint]);
  useEffect(() => {
    if (resultTab === 'history' && !historyLoaded) loadBlockHistory();
  }, [historyLoaded, loadBlockHistory, resultTab]);

  const handleDraftChange = (draft: string) => {
    setRunError(null);
    setRunErrorDetails(null);
    setSaveError(null);
    setRecoveryError(null);
    setRecoveryScope(null);
    setRepairNotice(null);
    setRepairWarning(null);
    dispatch({ type: 'SET_BLOCK_STUDIO_DRAFT', draft });
    const parsed = parseBlockFields(draft);
    const current = state.blockStudioMetadata;
    if (!parsed || !current || !hasCompleteBlockEnvelope(draft)) return;
    const next = {
      ...current,
      name: parsed.name || current.name,
      domain: parsed.domain || current.domain,
      description: parsed.description,
      owner: parsed.owner,
      tags: parsed.tags,
      reviewStatus: parsed.status || current.reviewStatus,
    };
    if (
      next.name !== current.name
      || next.domain !== current.domain
      || next.description !== current.description
      || next.owner !== current.owner
      || next.reviewStatus !== current.reviewStatus
      || next.tags.join('\u0000') !== current.tags.join('\u0000')
    ) {
      dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata: next });
    }
  };

  // Query-mode toggle: rebuild the draft as a semantic or raw-SQL (custom)
  // block, preserving the identity fields. No-op if already in that mode.
  const switchBuilderMode = (mode: 'semantic' | 'custom') => {
    if ((mode === 'semantic') === isSemanticBlock) return;
    const meta = state.blockStudioMetadata;
    const name = meta?.name || (mode === 'semantic' ? 'new_semantic_block' : 'new_sql_block');
    let next = mode === 'semantic' ? buildSemanticSkeleton(name) : buildCustomSkeleton(name);
    next = setBlockName(next, name);
    // Start raw SQL from an empty query so the textarea isn't pre-filled with
    // the skeleton's placeholder SELECT.
    if (mode === 'custom') next = setBlockQuery(next, '');
    if (meta) {
      next = setBlockStringField(next, 'domain', meta.domain || 'uncategorized');
      next = setBlockStringField(next, 'description', meta.description ?? '');
      next = setBlockStringField(next, 'owner', meta.owner ?? '');
      next = setBlockTags(next, meta.tags ?? []);
    }
    handleDraftChange(next);
    setEditorMode('visual');
  };

  const applySemanticComposition = (metrics: string[], dimensions: string[]) => {
    const meta = state.blockStudioMetadata;
    let next = isSemanticBlock
      ? state.blockStudioDraft
      : buildSemanticSkeleton(meta?.name || 'new_semantic_block');
    if (!isSemanticBlock && meta) {
      next = setBlockStringField(next, 'domain', meta.domain || 'uncategorized');
      next = setBlockStringField(next, 'description', meta.description ?? '');
      next = setBlockStringField(next, 'owner', meta.owner ?? '');
      next = setBlockTags(next, meta.tags ?? []);
    }
    next = setSemanticMetrics(next, metrics);
    next = setSemanticArray(next, 'dimensions', dimensions);
    handleDraftChange(next);
    setSemanticInsertChoice(null);
    setDatabaseInsertWarning(null);
    setWorkspaceMode('manual');
    setEditorMode('visual');
  };

  const resetToBlockStudioHome = () => {
    resetBlockScopedActivity();
    dispatch({ type: 'START_NEW_BLOCK_WORKSPACE' });
    setDraftSessionId(makeBlockStudioDraftId());
    setImportSession(null);
    setWorkspaceMode('start');
    setEditorMode('visual');
  };

  // A retired block offers its replacement: opening it is opening a saved block.
  const openReplacementBlock = (path: string) => {
    const name = state.blockStudioMetadata?.replacement?.name ?? path.split('/').pop()?.replace(/\.dql$/, '') ?? path;
    void openSavedBlock({ name, path } as BlockEntry);
  };

  const openSavedBlock = async (block: BlockEntry) => {
    try {
      const file = {
        name: block.path.split('/').pop() ?? block.name,
        path: block.path,
        type: 'block' as const,
        folder: 'blocks',
      };
      const payload = await api.openBlockStudio(block.path);
      resetBlockScopedActivity();
      if (!state.files.some((candidate) => candidate.path === block.path)) {
        dispatch({ type: 'FILE_ADDED', file });
      }
      dispatch({ type: 'OPEN_BLOCK_STUDIO', file, payload });
      setCatalogError(null);
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : 'Could not open this block.');
    }
  };

  const completePendingWorkspaceNavigation = () => {
    const pendingBlock = pendingBlockOpenRef.current;
    pendingBlockOpenRef.current = null;
    if (pendingBlock) {
      void openSavedBlock(pendingBlock);
      return;
    }
    resetToBlockStudioHome();
  };

  // Return to the Block Studio home — the page that offers the three ways in
  // (Ask AI / Import SQL / Build manually). After saving a block there was no
  // route back to where that choice is made.
  const goToBlockStudioHome = () => {
    pendingBlockOpenRef.current = null;
    if (state.blockStudioDirty) {
      setDirtyGuardOpen(true);
      return;
    }
    resetToBlockStudioHome();
  };

  // "New block" now lands on the home page rather than jumping straight into the
  // manual form: after saving a block the user had no route back to the place
  // where the AI / import / manual choice is made.
  const beginNewWorkspace = () => {
    goToBlockStudioHome();
  };

  const requestOpenBlock = (block: BlockEntry) => {
    if (block.path === state.activeBlockPath) return;
    if (state.blockStudioDirty) {
      pendingBlockOpenRef.current = block;
      setDirtyGuardOpen(true);
      return;
    }
    void openSavedBlock(block);
  };

  const beginManualDraft = (type: 'custom' | 'semantic') => {
    const name = type === 'semantic' ? 'new_semantic_block' : 'new_sql_block';
    const draftDomain = domainFilter || 'uncategorized';
    const skeleton = type === 'semantic' ? buildSemanticSkeleton(name) : buildCustomSkeleton(name);
    const source = setBlockStringField(skeleton, 'domain', draftDomain);
    dispatch({ type: 'SET_BLOCK_STUDIO_DRAFT', draft: source });
    dispatch({
      type: 'SET_BLOCK_STUDIO_METADATA',
      metadata: {
        name,
        path: null,
        domain: draftDomain,
        folderPath: '',
        description: '',
        owner: '',
        tags: [],
        reviewStatus: 'draft',
        sourceKind: 'manual',
      },
    });
    dispatch({ type: 'SET_BLOCK_STUDIO_PREVIEW', preview: null });
    dispatch({ type: 'SET_BLOCK_STUDIO_VALIDATION', validation: null });
    setWorkspaceMode('manual');
    setEditorMode('visual');
  };

  const handleRun = async () => {
    const scopeEpoch = blockScopeEpochRef.current;
    setRunning(true);
    setRunError(null);
    setRunErrorDetails(null);
    setQueryDetailsOpen(false);
    setRunStartedAt(Date.now());
    setRunElapsedMs(0);
    dispatch({ type: 'SET_BLOCK_STUDIO_PREVIEW', preview: null });
    try {
      const preview = await api.runBlockStudio(state.blockStudioDraft, state.activeBlockPath, parameterValues);
      if (scopeEpoch !== blockScopeEpochRef.current) return;
      dispatch({ type: 'SET_BLOCK_STUDIO_PREVIEW', preview });
      if (preview.validation) dispatch({ type: 'SET_BLOCK_STUDIO_VALIDATION', validation: preview.validation });
      setRecoveryError(null);
      setRecoveryScope(null);
      setResultTab('results');
    } catch (error) {
      if (scopeEpoch !== blockScopeEpochRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      const technicalDetails = blockStudioErrorTechnicalDetails(error);
      setRunError(message);
      setRunErrorDetails(technicalDetails);
      setRecoveryError(technicalDetails ?? message);
      setRecoveryScope('run');
      setResultTab(/required parameter|provide required parameter/i.test(message) ? 'parameters' : 'results');
    } finally {
      if (scopeEpoch === blockScopeEpochRef.current) {
        setRunning(false);
        setRunStartedAt(null);
      }
    }
  };

  const handleFixAndRun = async (
    errorOverride?: string,
    options: { requireCertificationReady?: boolean } = {},
  ) => {
    const repairError = errorOverride ?? recoveryError;
    if (repairing || !repairError) return;
    const originalSource = state.blockStudioDraft;
    const scopeEpoch = blockScopeEpochRef.current;
    setRepairing(true);
    setSaveError(null);
    setRepairNotice(null);
    setRepairWarning(null);
    try {
      const repaired = await api.repairAndRunBlockStudio(
        originalSource,
        repairError,
        parameterValues,
        activeBlockName ?? state.blockStudioMetadata?.name ?? undefined,
      );
      if (scopeEpoch !== blockScopeEpochRef.current) return;
      if (liveDraftRef.current !== originalSource) {
        throw new Error('The block changed while AI repair was running. The stale repair was not applied.');
      }
      const validation = await api.validateBlockStudio(repaired.source, state.activeBlockPath);
      if (scopeEpoch !== blockScopeEpochRef.current) return;
      if (validation.saveable === false) {
        throw new Error(validation.diagnostics.find((item) => item.severity === 'error')?.message
          ?? 'The repaired DQL still has an authoring error.');
      }
      if (liveDraftRef.current !== originalSource) {
        throw new Error('The block changed while AI repair was running. The stale repair was not applied.');
      }
      const certificationAssessment = options.requireCertificationReady
        ? await api.assessBlockStudioCertification(repaired.source)
        : null;
      if (scopeEpoch !== blockScopeEpochRef.current) return;
      if (liveDraftRef.current !== originalSource) {
        throw new Error('The block changed while AI repair was running. The stale repair was not applied.');
      }
      handleDraftChange(repaired.source);
      dispatch({ type: 'SET_BLOCK_STUDIO_VALIDATION', validation });
      dispatch({ type: 'SET_BLOCK_STUDIO_PREVIEW', preview: repaired.preview });
      setRunError(null);
      setRecoveryError(null);
      setRecoveryScope(null);
      setRunErrorDetails(null);
      if (certificationAssessment && !certificationAssessment.ok) {
        const blockerCount = Math.max(1, certificationAssessment.blockers.length);
        const firstIssue = certificationAssessment.checklist.issues?.find((item) => item.severity === 'error');
        setCertificationResult({
          pending: false,
          ok: false,
          checklist: certificationAssessment.checklist,
          certification: certificationAssessment.certification,
          blockers: certificationAssessment.blockers,
          error: 'The repair attempt ran, but certification requirements are still not ready.',
        });
        setRepairWarning(
          `The repair attempt ran, but ${blockerCount} certification fix${blockerCount === 1 ? '' : 'es'} remain${blockerCount === 1 ? 's' : ''}.${firstIssue?.title ? ` ${firstIssue.title}.` : ''}`,
        );
        setEditorMode('source');
        setResultTab('save');
        setBottomPaneCollapsed(false);
        return;
      }
      if (certificationAssessment?.ok) {
        setCertificationResult(null);
        setRepairNotice(`${repaired.repairMode === 'ai' ? 'AI repaired' : 'ZLens repaired'} the draft, and every certification check now passes. Review the changes, then click Certify.`);
      } else {
        setRepairNotice(`${repaired.repairMode === 'ai' ? 'AI fixed' : 'ZLens fixed'} the draft and the corrected block ran successfully. Review the changes, then save the draft.`);
      }
      setEditorMode('source');
      setResultTab('results');
      setBottomPaneCollapsed(false);
    } catch (error) {
      if (scopeEpoch !== blockScopeEpochRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      const technicalDetails = blockStudioErrorTechnicalDetails(error);
      setRunError(message);
      setRunErrorDetails(technicalDetails);
      setRecoveryError(technicalDetails ?? message);
      setRecoveryScope('run');
      setResultTab('results');
      setBottomPaneCollapsed(false);
    } finally {
      if (scopeEpoch === blockScopeEpochRef.current) setRepairing(false);
    }
  };

  const persistBlockStudioDraft = async (source = state.blockStudioDraft): Promise<BlockStudioOpenPayload> => {
    if (!state.blockStudioMetadata) {
      throw new Error('Block metadata is required before saving.');
    }
    const payload = await api.saveBlockStudio({
      path: state.activeBlockPath,
      source,
      metadata: {
        name: state.blockStudioMetadata.name,
        domain: state.blockStudioMetadata.domain,
        folderPath: state.blockStudioMetadata.folderPath,
        description: state.blockStudioMetadata.description,
        owner: state.blockStudioMetadata.owner,
        tags: state.blockStudioMetadata.tags,
        sourceKind: state.blockStudioMetadata.sourceKind,
        sourcePath: state.blockStudioMetadata.sourcePath,
        importId: state.blockStudioMetadata.importId,
        candidateId: state.blockStudioMetadata.candidateId,
        lineage: state.blockStudioMetadata.lineage,
      },
    });
    setBlockLibraryRefreshKey((current) => current + 1);
    dispatch({
      type: 'OPEN_BLOCK_STUDIO',
      file: {
        name: `${payload.metadata.name}.dql`,
        path: payload.path,
        type: 'block',
        folder: 'blocks',
      },
      payload,
    });
    const existing = state.files.some((file) => file.path === payload.path);
    if (!existing) {
      dispatch({
        type: 'FILE_ADDED',
        file: {
          name: `${payload.metadata.name}.dql`,
          path: payload.path,
          type: 'block',
          folder: 'blocks',
        },
      });
    }
    if (payload.lineageRefresh?.status === 'ready') {
      // Compatibility with older runtimes. New runtimes publish this refresh as
      // a background task so save acknowledgement is never held by compilation.
      void loadBlockLineage(payload.metadata.name);
    } else if (payload.lineageRefresh?.status === 'failed') {
      setSaveError(`Block saved, but lineage refresh failed: ${payload.lineageRefresh.message ?? 'compile failed'}`);
      setTimeout(() => setSaveError(null), 7000);
    }
    return payload;
  };

  const handleSave = async (): Promise<boolean> => {
    if (!state.blockStudioMetadata?.name.trim() || !state.blockStudioMetadata.owner.trim()) {
      pendingIdentityActionRef.current = 'save';
      setSaveIdentityOpen(true);
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const sourceToSave = state.blockStudioMetadata.reviewStatus === 'certified' && state.blockStudioDirty
        ? setBlockStringField(state.blockStudioDraft, 'status', 'draft')
        : state.blockStudioDraft;
      const validation = await api.validateBlockStudio(sourceToSave, state.activeBlockPath);
      dispatch({ type: 'SET_BLOCK_STUDIO_VALIDATION', validation });
      if (validation.saveable === false || (validation.saveable === undefined && !validation.valid)) {
        const message = validation.diagnostics.find((item) => item.severity === 'error')?.message
          ?? 'Fix the block errors before saving.';
        setSaveError(`Draft not saved: ${message}`);
        setRecoveryError(message);
        setRecoveryScope('save');
        setEditorMode('source');
        return false;
      }
      const editingCertified = state.blockStudioMetadata.reviewStatus === 'certified';
      const saved = await persistBlockStudioDraft(sourceToSave);
      setRecoveryError(null);
      setRecoveryScope(null);
      setRepairNotice(null);
      setRepairWarning(null);
      // Edits to a certified block land in a draft beside it; say so, so the move to the draft is not a surprise.
      if (editingCertified && /(^|\/)_drafts\//.test(saved.path)) {
        setRepairNotice('Saved as a draft beside the certified block. The certified version stays in use until this draft is certified.');
      }
      setResultTab('save');
      return true;
    } catch (err: any) {
      const msg = err?.message ?? 'Save failed';
      // The server re-validates: show its reason with the same recovery actions as the page's own check.
      if (err?.code === 'BLOCK_VALIDATION_FAILED') {
        setSaveError(`Draft not saved: ${msg}`);
        setRecoveryError(msg);
        setRecoveryScope('save');
        setEditorMode('source');
        return false;
      }
      setSaveError(err?.code === 'BLOCK_EXISTS' || err?.status === 409 ? 'A block with this name already exists in this folder. Rename it and try again.' : msg);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const requestDeleteBlock = (path: string, name: string) => {
    setDeleteError(null);
    setPendingDeleteBlock({ path, name });
    setDeleteDialogOpen(true);
  };

  const handleDeleteBlock = async () => {
    const blockPath = pendingDeleteBlock?.path;
    if (!blockPath) return;
    setDeletingBlock(true);
    setDeleteError(null);
    try {
      const deleted = await api.deleteBlockStudio(blockPath);
      dispatch({ type: 'FILE_REMOVED', path: deleted.path });
      if (state.activeBlockPath === deleted.path) {
        dispatch({ type: 'START_NEW_BLOCK_WORKSPACE' });
        setDraftSessionId(makeBlockStudioDraftId());
        setImportSession(null);
        setWorkspaceMode('start');
        setEditorMode('visual');
      }
      setDeleteDialogOpen(false);
      setPendingDeleteBlock(null);
      setBlockLibraryRefreshKey((current) => current + 1);
      if (deleted.lineageRefresh?.status === 'failed') {
        setCatalogError(`Block deleted, but lineage refresh failed: ${deleted.lineageRefresh.message ?? 'compile failed'}`);
      }
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingBlock(false);
    }
  };

  const handleCertify = async (override?: { source: string; metadata: BlockStudioMetadata }): Promise<boolean> => {
    if (
      !state.blockStudioMetadata?.name.trim()
      || !state.blockStudioMetadata.owner.trim()
      || certifyNeedsDomain(override?.source ?? state.blockStudioDraft, (override?.metadata ?? state.blockStudioMetadata).domain, state.authoredDomains)
    ) {
      pendingIdentityActionRef.current = 'certify';
      setSaveIdentityOpen(true);
      return false;
    }
    if (mutationInFlightRef.current || certificationOperationId) return false;
    mutationInFlightRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      setCertificationResult(null);
      const draftToCertify = override?.source ?? state.blockStudioDraft;
      const metadataToCertify = override?.metadata ?? state.blockStudioMetadata;
      const sourceToSave = state.blockStudioMetadata.reviewStatus === 'certified' && (state.blockStudioDirty || Boolean(override))
        ? setBlockStringField(draftToCertify, 'status', 'draft')
        : draftToCertify;
      const clientRevision = `${state.blockStudioMetadata.sourceFingerprint ?? 'new'}:${Date.now()}`;
      const idempotencyKey = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `block-certification-${clientRevision}`;
      const accepted = await api.requestBlockStudioCertification({
        source: sourceToSave,
        path: state.activeBlockPath,
        metadata: metadataToCertify,
        expectedSourceFingerprint: state.blockStudioMetadata.sourceFingerprint,
        clientRevision,
        idempotencyKey,
      });
      trackOperation(accepted.operation);
      setCertificationOperationId(accepted.operation.id);
      certificationPathsRef.current = new Set([
        state.activeBlockPath,
        accepted.draft?.path,
      ].filter((value): value is string => Boolean(value)));
      dispatch({ type: 'BLOCK_CERTIFICATION_ACCEPTED', source: sourceToSave, ...(accepted.draft ? { draft: accepted.draft } : {}) });
      // A draft written beside a certified block shows in the sidebar straight away.
      setBlockLibraryRefreshKey((current) => current + 1);
      setCertificationResult({
        pending: true,
      });
      setResultTab('save');
      return true;
    } catch (err: any) {
      certificationPathsRef.current.clear();
      const msg = err?.message ?? 'Certification could not start';
      setSaveError(
        err?.code === 'SOURCE_CHANGED'
          ? 'This block changed on disk after you opened it. Reopen it to certify the latest version.'
          : err?.code === 'BLOCK_EXISTS'
            ? 'A block with this name already exists in this folder. Rename it and try again.'
            : msg,
      );
      return false;
    } finally {
      mutationInFlightRef.current = false;
      setSaving(false);
    }
  };

  useEffect(() => {
    const action = pendingIdentityActionRef.current;
    if (!action || !state.blockStudioMetadata?.name.trim() || !state.blockStudioMetadata.owner.trim()) return;
    pendingIdentityActionRef.current = null;
    const operation = action === 'certify' ? handleCertify() : handleSave();
    void operation.then((saved) => {
      if (saved && newAfterSaveRef.current) {
        newAfterSaveRef.current = false;
        completePendingWorkspaceNavigation();
      }
    });
  }, [state.blockStudioMetadata?.name, state.blockStudioMetadata?.owner, state.blockStudioDraft]);

  // Cmd/Ctrl+S on this page runs this page's save, so the identity check,
  // validation, the certified-to-draft rule and the sidebar refresh all apply.
  const saveShortcutRef = useRef(handleSave);
  saveShortcutRef.current = handleSave;
  const saveShortcutEnabledRef = useRef(false);
  saveShortcutEnabledRef.current = Boolean(state.blockStudioMetadata) && !saving;
  useEffect(() => {
    const onSaveShortcut = () => { if (saveShortcutEnabledRef.current) void saveShortcutRef.current(); };
    window.addEventListener('dql:block-studio-save', onSaveShortcut);
    return () => window.removeEventListener('dql:block-studio-save', onSaveShortcut);
  }, []);

  const handleImportCandidateSelect = (candidate: BlockStudioImportCandidate) => {
    const candidatePath = candidate.savedPath ?? candidate.draftSave?.path ?? '';
    const payload = {
      path: candidatePath,
      source: candidate.dqlSource,
      metadata: {
        name: candidate.name,
        path: candidatePath || null,
        domain: candidate.domain,
        description: candidate.description,
        owner: candidate.owner,
        tags: candidate.tags,
        reviewStatus: candidate.reviewStatus,
        sourceKind: candidate.sourceKind,
        sourcePath: candidate.sourcePath,
        importId: importSession?.id,
        candidateId: candidate.id,
        lineage: candidate.lineage.sourceTables,
      },
      companionPath: null,
      validation: candidate.validation ?? {
        valid: true,
        diagnostics: [],
        semanticRefs: { metrics: [], dimensions: [], segments: [] },
        executableSql: null,
      },
    };
    dispatch({
      type: 'OPEN_BLOCK_STUDIO',
      file: {
        name: `${candidate.name}.dql`,
        path: candidatePath,
        type: 'block',
        folder: 'blocks',
        isNew: !candidatePath,
      },
      payload,
    });
    dispatch({ type: 'SET_BLOCK_STUDIO_PREVIEW', preview: candidate.preview });
    setResultTab('results');
    setWorkspaceMode('manual');
    setEditorMode('visual');
  };

  const handleImportCandidateSaved = (candidate: BlockStudioImportCandidate, block: BlockStudioOpenPayload) => {
    const existing = state.files.some((file) => file.path === block.path);
    if (!existing) {
      dispatch({
        type: 'FILE_ADDED',
        file: {
          name: `${block.metadata.name}.dql`,
          path: block.path,
          type: 'block',
          folder: 'blocks',
        },
      });
    }
    setImportSession((current) => current ? {
      ...current,
      candidates: current.candidates.map((item) => item.id === candidate.id ? candidate : item),
    } : current);
    void refreshImportSessions();
  };

  const handleSemanticInsert = (item: SemanticObjectDetail) => {
    setDatabaseInsertWarning(null);
    if (item.kind === 'metric' || item.kind === 'dimension') {
      if (isSemanticBlock) {
        handleDraftChange(upsertSemanticSelection(state.blockStudioDraft, {
          kind: item.kind === 'metric' ? 'metric' : 'dimension',
          name: item.kind === 'dimension' ? item.reference ?? item.name : item.name,
        }));
        setSemanticInsertChoice(null);
      } else {
        setSemanticInsertChoice(item);
      }
      dispatch({ type: 'ADD_SEMANTIC_RECENT', name: item.name });
      return;
    }
    if (!isSemanticBlock) {
      setSemanticInsertChoice(item);
      return;
    }
    if (item.kind === 'segment' && item.sql) {
      if (isSemanticBlock) {
        setDatabaseInsertWarning('Segments are SQL. Keep this Semantic Block on metrics and dimensions, or switch to a SQL Block to inline the segment.');
        return;
      }
      handleDraftChange(appendSnippetToDraft(state.blockStudioDraft, `/* segment:${item.name} */ (${item.sql})`));
      return;
    }
    if (item.kind === 'pre_aggregation') {
      if (isSemanticBlock) {
        setDatabaseInsertWarning('Pre-aggregations are referenced by the semantic runtime, not pasted into a query. This Semantic Block stays on metrics and dimensions.');
        return;
      }
      handleDraftChange(appendSnippetToDraft(state.blockStudioDraft, `/* pre_aggregation:${item.name} */`));
    }
  };

  const handleDatabaseInsert = (snippet: string) => {
    setSemanticInsertChoice(null);
    if (isSemanticBlock) {
      setDatabaseInsertWarning('Database tables and SELECT snippets belong in SQL blocks. Use a SQL Block for raw SELECT work, or keep this Semantic Block on metrics and dimensions.');
      return;
    }
    handleDraftChange(appendSnippetToDraft(state.blockStudioDraft, snippet));
  };

  const handleAiSqlInsert = (sql: string, meta?: AiSqlDraftMeta) => {
    const sourceBeforeInsert = state.blockStudioDraft.trim()
      ? state.blockStudioDraft
      : buildCustomSkeleton(meta?.title?.trim() || 'AI Generated Block');
    const nextDraft = meta?.blockSource?.trim()
      ? meta.blockSource.trim()
      : applyGeneratedSqlToBlockDraft(sourceBeforeInsert, sql);
    handleDraftChange(nextDraft);
    const parsed = parseBlockFields(nextDraft);
    if (parsed) {
      dispatch({
        type: 'SET_BLOCK_STUDIO_METADATA',
        metadata: {
          name: parsed.name || meta?.title || 'AI Generated Block',
          path: state.activeBlockPath,
          domain: parsed.domain || meta?.domain || 'analytics',
          description: parsed.description || meta?.description || `AI generated block for ${meta?.question ?? 'analysis'}`,
          owner: parsed.owner || meta?.owner || '',
          tags: parsed.tags.length > 0 ? parsed.tags : (meta?.tags ?? ['ai-generated', 'review-required']),
          reviewStatus: parsed.status || 'draft',
          sourceKind: state.blockStudioMetadata?.sourceKind ?? 'ai-generated',
          sourcePath: state.blockStudioMetadata?.sourcePath,
          importId: state.blockStudioMetadata?.importId,
          candidateId: state.blockStudioMetadata?.candidateId,
          lineage: state.blockStudioMetadata?.lineage,
        },
      });
    }
    dispatch({
      type: 'SET_BLOCK_STUDIO_VALIDATION',
      validation: {
        valid: true,
        diagnostics: [
          {
            severity: 'info',
            code: 'ai_sql_draft_inserted',
            message: parsed
              ? 'AI generated a draft block with metadata, SQL, visualization, and tests. Run preview, review joins and grain, then save.'
              : 'AI generated SQL inserted. Run preview, review joins and grain, then save or certify.',
          },
        ],
        semanticRefs: { metrics: [], dimensions: [], segments: [] },
        executableSql: sql.trim(),
      },
    });
    setResultTab('results');
  };

  const addGeneratedDqlToBlockStudio = async (payload: InsertDqlPayload) => {
    const generatedSource = payload.dqlArtifact?.source?.trim();
    const sql = (payload.sql ?? '').trim();
    if (!generatedSource && !sql) return;
    // Semantic-first authoring: if the governed catalog can express this question
    // as {metrics} x {dimensions}, save the simple semantic block rather than the
    // SQL body we happened to answer with. The answer may have come from a
    // certified SQL block — reuse is the right ANSWER, but it is the wrong shape
    // to author a new governed block from. Falls back to the answer's artifact
    // when the catalog cannot cover the question.
    let semanticSource: string | undefined;
    if (payload.question?.trim()) {
      try {
        const composed = await api.composeSemanticBlock(payload.question.trim());
        if (composed.ok && composed.source.trim()) semanticSource = composed.source.trim();
      } catch {
        // Compose is an optimization, never a blocker.
      }
    }
    // `||` not `??`: both operands are .trim()ed, so a blank-but-present artifact
    // source is '' — with `??` that skipped the SQL fallback and posted an empty
    // source, which the server rejects with 400 and the answer's SQL was lost.
    const source = semanticSource
      || generatedSource
      || applyGeneratedSqlToBlockDraft(
        buildCustomSkeleton(payload.title?.trim() || 'AI Generated Block'),
        sql,
      );
    const parsed = parseBlockFields(source);
    const name = parsed?.name || payload.dqlArtifact?.name || payload.title || 'AI Generated Block';
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.saveAgentBlockDraft({
        source,
        name,
        domain: parsed?.domain || state.blockStudioMetadata?.domain || 'uncategorized',
        description: parsed?.description || `AI-generated draft for ${payload.title ?? name}`,
        tags: parsed?.tags?.length ? parsed.tags : ['ai-generated', 'review-required'],
        runId: payload.sourceRunId,
        sql: sql || undefined,
        columns: payload.result?.columns,
      });
      openIntentRef.current = 'builder';
      // The SQL is left as the creator wrote it; the suggestion to add the key is for them to review.
      setIdentityGapNotice(saved.prefill?.identityGap?.message ?? null);
      dispatch({
        type: 'OPEN_BLOCK_STUDIO',
        file: {
          name: `${saved.metadata.name}.dql`,
          path: saved.path,
          type: 'block',
          folder: 'blocks',
          isNew: false,
        },
        payload: saved,
      });
      if (!state.files.some((file) => file.path === saved.path)) {
        dispatch({
          type: 'FILE_ADDED',
          file: {
            name: `${saved.metadata.name}.dql`,
            path: saved.path,
            type: 'block',
            folder: 'blocks',
          },
        });
      }
      setBlockLibraryRefreshKey((current) => current + 1);
      setWorkspaceMode('manual');
      setEditorMode('visual');
      setResultTab('save');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  // Block AI always requests the explicit block route. The server still runs the
  // universal governed answer lifecycle to produce DQL, compiled SQL, preview
  // evidence, and trust, but returns an ownerless transient artifact until the
  // user explicitly chooses Add to Block Studio.
  const openAskAi = (opts?: { kind?: 'ask' | 'build' | 'edit'; initialInput?: string; autoRun?: string }) => {
    const kind = opts?.kind ?? 'ask';
    setResultTab('results');
    setAskAiKind(kind);
    setAskAiInitialInput(opts?.initialInput ?? '');
    setAskAiSeed(opts?.autoRun ? { text: opts.autoRun, mode: 'block', nonce: Date.now() } : undefined);
    setAiDockOpen(true);
  };

  const ensureDbColumns = async (node: DatabaseSchemaNode) => {
    if (!node.path || node.kind !== 'table' || (node.children && node.children.length > 0)) return;
    setLoadingDbNodes((prev) => new Set(prev).add(node.id));
    try {
      const columns = await api.describeTable(node.path);
      setDatabaseTree((prev) => updateDatabaseTree(prev, node.id, {
        ...node,
        children: columns.map((column) => ({
          id: `db-column:${node.path}:${column.name}`,
          label: column.name,
          kind: 'column' as const,
          path: node.path,
          type: column.type,
        })),
      }));
    } finally {
      setLoadingDbNodes((prev) => { const next = new Set(prev); next.delete(node.id); return next; });
    }
  };

  const refreshDatabaseTree = useCallback(async () => {
    try {
      const catalog = (await catalogQuery.refetch()).data;
      if (catalog?.databaseTree) {
        setDatabaseTree(catalog.databaseTree);
      }
      if (catalog) dispatch({ type: 'SET_BLOCK_STUDIO_CATALOG', catalog });
    } catch { /* non-fatal */ }
  }, [catalogQuery, dispatch]);

  useEffect(() => {
    if (!running || !runStartedAt) return;
    const updateElapsed = () => setRunElapsedMs(Date.now() - runStartedAt);
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [running, runStartedAt]);

  const currentChart = state.blockStudioValidation?.chartConfig ?? state.blockStudioPreview?.chartConfig ?? { chart: 'table' };
  const activeResultChartType = state.blockStudioPreview
    ? resolveChartType(state.blockStudioPreview.result, state.blockStudioPreview.chartConfig)
    : 'table';
  const startLeftResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = leftPaneWidth;
    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.min(560, Math.max(300, startWidth + moveEvent.clientX - startX));
      setLeftPaneWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startBottomResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = bottomPaneHeight;
    const onMove = (moveEvent: MouseEvent) => {
      const next = Math.min(500, Math.max(180, startHeight - (moveEvent.clientY - startY)));
      setBottomPaneHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startAiResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = aiDockWidth;
    const onMove = (moveEvent: MouseEvent) => {
      setAiDockWidth(Math.min(520, Math.max(360, startWidth - (moveEvent.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const bottomPaneVisible = hasActiveDraft && !bottomPaneCollapsed;
  const rootGridColumns = compactLayout
    ? 'minmax(0, 1fr)'
    : `${leftPaneCollapsed ? 0 : leftPaneWidth}px ${leftPaneCollapsed ? 0 : 6}px minmax(0, 1fr) ${aiDockOpen ? 6 : 0}px ${aiDockOpen ? (aiDockExpanded ? `min(${AI_SIDE_PANEL_EXPANDED_WIDTH}px, 52vw)` : `${aiDockWidth}px`) : 0}`;
  const rootGridRows = compactLayout
    ? leftPaneCollapsed
      ? !bottomPaneVisible
        ? 'minmax(0, 1fr) 0 0'
        : `minmax(0, 1fr) 6px ${bottomPaneHeight}px`
      : !bottomPaneVisible
        ? 'minmax(220px, 34vh) minmax(0, 1fr) 0 0'
        : `minmax(220px, 34vh) minmax(320px, 1fr) 6px ${bottomPaneHeight}px`
    : !bottomPaneVisible
      ? 'minmax(0, 1fr) 0 0'
      : `minmax(0, 1fr) 6px ${bottomPaneHeight}px`;
  const editorGridColumn = compactLayout ? '1' : '3';
  const editorGridRow = compactLayout ? (leftPaneCollapsed ? '1' : '2') : '1';
  const bottomResizeGridColumn = compactLayout ? '1' : '3';
  const bottomResizeGridRow = compactLayout ? (leftPaneCollapsed ? '2' : '3') : '2';
  const bottomPaneGridColumn = compactLayout ? '1' : '3';
  const bottomPaneGridRow = compactLayout ? (leftPaneCollapsed ? '3' : '4') : '3';

  return (
    <div
      style={{
        flex: 1,
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: rootGridColumns,
        gridTemplateRows: rootGridRows,
        overflow: 'hidden',
        background: t.appBg,
      }}
    >
      <div style={{ gridColumn: '1', gridRow: compactLayout ? '1' : '1 / 4', borderRight: leftPaneCollapsed ? 'none' : `1px solid ${t.headerBorder}`, borderBottom: compactLayout && !leftPaneCollapsed ? `1px solid ${t.headerBorder}` : 'none', display: leftPaneCollapsed ? 'none' : 'flex', flexDirection: 'column', overflow: 'hidden', background: t.sidebarBg, minWidth: 0 }}>
        {/* Prototype explorer: tabs / search + new-block / catalog / sync footer.
            The unified catalog is the same clean object-display as the notebook
            Build sidebar; selected refs append to the block draft. */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <BuildSidebar
            tabs={['blocks', 'semantic', 'database']}
            defaultTab={explorerTab}
            blockDomain={domainFilter}
            onBlockDomainChange={setDomainFilter}
            onInsertText={(text) => {
              if (isSemanticBlock) {
                setDatabaseInsertWarning('That snippet is SQL. Use a SQL Block for raw SELECT work, or keep this Semantic Block on metrics and dimensions.');
                return;
              }
              handleDraftChange(appendSnippetToDraft(state.blockStudioDraft, text));
            }}
            onSemanticCompose={applySemanticComposition}
            onNewBlock={readOnlyBlocks ? undefined : beginNewWorkspace}
            onOpenBlock={requestOpenBlock}
            onDeleteBlock={readOnlyBlocks ? undefined : (block) => requestDeleteBlock(block.path, block.name)}
            blockLibraryRefreshKey={blockLibraryRefreshKey}
            onCollapse={() => setLeftPaneCollapsed(true)}
            footer={state.semanticLayer.loading
              ? `Loading ${(state.blockStudioDbtStatus?.counts.metrics ?? 0).toLocaleString()} semantic metrics…`
              : buildCatalogFooter({
                provider: state.semanticLayer.provider,
                dbtModels: state.blockStudioDbtStatus?.counts.models,
                warehouseTables: Math.max(databaseStats.tables, state.schemaTables.length),
                metrics: state.semanticLayer.metrics.length,
              })}
            footerStatus={state.semanticLayer.loading ? 'loading' : 'ready'}
          />
        </div>
      </div>

      <div
        onMouseDown={leftPaneCollapsed ? undefined : startLeftResize}
        style={{
          gridColumn: '2',
          gridRow: '1 / 4',
          display: leftPaneCollapsed || compactLayout ? 'none' : 'block',
          cursor: 'col-resize',
          background: t.headerBorder,
        }}
      />

      <div style={{ display: compactLayout && aiDockOpen ? 'none' : 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', gridColumn: editorGridColumn, gridRow: editorGridRow }}>
        {/* v1.3.3 Hex cleanup — tight single-row editor toolbar to match
            the explorer header; drop wordy subtitle. */}
        <style>{`
          @keyframes dql-agent-fadein { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
          @keyframes dql-agent-run-spin { to { transform: rotate(360deg); } }
        `}</style>
        {/* Prototype toolbar: breadcrumb · status pill · Visual/Source toggle · actions */}
        <div style={{ height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: `1px solid ${t.headerBorder}`, background: t.cellBg, overflowX: 'auto' }}>
          {leftPaneCollapsed && (
            <button
              onClick={() => setLeftPaneCollapsed(false)}
              style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 14, fontFamily: t.font, padding: 0, lineHeight: 1 }}
              title="Open explorer"
            >
              ›
            </button>
          )}
          {/* The breadcrumb root is the way BACK. It was a plain span, so once you
              were inside a block or a draft there was no route to the Block Studio
              home other than picking some other block from the explorer. */}
          <button
            type="button"
            onClick={goToBlockStudioHome}
            title="Back to Block Studio"
            className="dql-hover"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', padding: '2px 4px', margin: '0 -4px', borderRadius: 6, color: t.textMuted, fontSize: 12, fontFamily: t.font, whiteSpace: 'nowrap', cursor: 'pointer' }}
          >
            <ChevronLeft size={12} strokeWidth={2} /> Blocks
          </button>
          <ChevronRight size={11} color={t.textMuted} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, fontWeight: 600, color: t.textPrimary, fontFamily: t.fontMono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>
            {activeBlockName || state.blockStudioMetadata?.name || (hasActiveDraft ? 'new_block' : (isSemanticBlock ? 'semantic' : 'sql'))}
          </span>
          {state.blockStudioMetadata?.reviewStatus && (
            <BlockStatusBadge status={state.blockStudioMetadata.reviewStatus} t={t} />
          )}
          {state.blockStudioMetadata?.reviewStatus === 'deprecated' && (
            <BlockReplacementLink
              info={{ status: state.blockStudioMetadata.reviewStatus, replacedBy: state.blockStudioMetadata.replacedBy, deprecatedOn: state.blockStudioMetadata.deprecatedOn, replacement: state.blockStudioMetadata.replacement }}
              t={t}
              onOpen={openReplacementBlock}
            />
          )}
          {hasActiveDraft && workspaceMode === 'manual' && editorMode !== 'detail' && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.headerBorder}`, borderRadius: 7, background: t.appBg, marginLeft: 6, flexShrink: 0 }}>
              <button type="button" onClick={() => setEditorMode('visual')} style={editorModeButtonStyle(t, editorMode === 'visual')}>Visual Builder</button>
              <button type="button" onClick={() => setEditorMode('source')} style={editorModeButtonStyle(t, editorMode === 'source')}>DQL Source</button>
            </div>
          )}
          {hasActiveDraft && (
            <TemplateButton
              label={`Context${blockContextCount(state.blockStudioDraft) ? ` (${blockContextCount(state.blockStudioDraft)})` : ''}`}
              Icon={Database}
              onClick={() => setContextInspectorOpen((open) => !open)}
            />
          )}
          <div style={{ flex: 1 }} />
          {/* The block overview has its own Run and Delete; the toolbar shows them only while editing. */}
          <BlockToolbarActions
            readOnly={readOnlyBlocks}
            readOnlyReason={readOnlyBlocksReason}
            hasActiveDraft={hasActiveDraft}
            activeBlockPath={state.activeBlockPath}
            detail={editorMode === 'detail'}
            running={running}
            saving={saving}
            certifying={Boolean(certificationOperationId)}
            certified={state.blockStudioMetadata?.reviewStatus === 'certified'}
            onDelete={() => requestDeleteBlock(state.activeBlockPath!, state.blockStudioMetadata?.name || activeBlockName || state.activeBlockPath!)}
            onNew={beginNewWorkspace}
            onAsk={() => openAskAi({ kind: 'ask' })}
            onModify={() => openAskAi({ kind: 'edit', initialInput: `Modify this block${activeBlockName ? ` (${activeBlockName})` : ''}: ` })}
            onRun={() => void handleRun()}
            onSave={() => void handleSave()}
            onCertify={() => void handleCertify()}
          />
          {readOnlyBlocks && (
            <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>{readOnlyBlocksReason}</span>
          )}
          {saveError && (
            <span style={{ fontSize: 11, color: 'var(--status-error)', fontFamily: t.font, padding: '4px 8px', background: 'var(--status-error-bg)', borderRadius: 6 }}>
              {saveError}
            </span>
          )}
        </div>
        {recoveryError && recoveryScope === 'save' && (
          <div role="alert" style={{ flexShrink: 0, display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--status-error)', background: 'var(--status-error-bg)', color: t.textPrimary, fontFamily: t.font }}>
            <AlertTriangle size={16} color="var(--status-error)" style={{ marginTop: 1, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700 }}>This draft was not saved. Your work is still editable.</div>
              <div style={{ marginTop: 2, fontSize: 11.5, lineHeight: 1.45, color: t.textSecondary }}>{recoveryError}</div>
              {(state.blockStudioValidation?.diagnostics.filter((item) => item.severity === 'error').length ?? 0) > 1 && (
                <div style={{ marginTop: 4, fontSize: 10.5, color: t.textMuted }}>
                  {state.blockStudioValidation!.diagnostics.filter((item) => item.severity === 'error').slice(1, 3).map((item) => item.message).join(' · ')}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => void handleFixAndRun()} disabled={repairing} style={{ ...primaryImportButtonStyle(t), display: 'inline-flex', alignItems: 'center', gap: 6, opacity: repairing ? .72 : 1 }}>
                {repairing ? <Loader2 size={13} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Sparkles size={13} />}
                {repairing ? 'Fixing & running…' : 'Fix with AI & run'}
              </button>
              <button type="button" onClick={() => setEditorMode('source')} style={secondaryImportButtonStyle(t)}>Edit DQL</button>
              <button
                type="button"
                onClick={() => openAskAi({ kind: 'edit', initialInput: `Help me fix this block error without changing its intended grain, parameters, or trust state: ${recoveryError} ` })}
                style={secondaryImportButtonStyle(t)}
              >
                Open Block AI
              </button>
            </div>
          </div>
        )}
        {repairNotice && (
          <div role="status" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--status-success)', background: 'var(--status-success-bg)', color: t.textSecondary, fontSize: 11.5, fontFamily: t.font }}>
            <CheckCircle2 size={14} color="var(--status-success)" /> {repairNotice}
          </div>
        )}
        {repairWarning && (
          <div role="status" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--status-warning-border)', background: 'var(--status-warning-bg)', color: t.textSecondary, fontSize: 11.5, fontFamily: t.font }}>
            <AlertTriangle size={14} color="var(--status-warning)" /> {repairWarning}
          </div>
        )}
        {identityGapNotice && (
          <div role="status" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--status-warning-border)', background: 'var(--status-warning-bg)', color: t.textSecondary, fontSize: 11.5, fontFamily: t.font }}>
            <AlertTriangle size={14} color="var(--status-warning)" /> {identityGapNotice}
          </div>
        )}
        {hasActiveDraft && contextInspectorOpen && (
          <BlockContextInspector
            source={state.blockStudioDraft}
            databaseStats={databaseStats}
            semanticCount={semanticObjectCount}
            onChange={handleDraftChange}
            onOpenExplorer={() => { setLeftPaneCollapsed(false); setExplorerTab('database'); }}
            onOpenAi={() => openAskAi({ kind: 'edit', initialInput: 'Review and improve this block context. Keep only grounded business references, sources, constraints, and caveats: ' })}
            t={t}
          />
        )}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {workspaceMode === 'import' ? (
            <BlockStudioImportWorkspace
              session={importSession}
              sessions={importSessions}
              sessionsLoading={importSessionsLoading}
              onClose={() => setWorkspaceMode(hasActiveDraft ? 'manual' : 'start')}
              onSessionChange={setImportSession}
              onRefreshSessions={refreshImportSessions}
              onSelectCandidate={handleImportCandidateSelect}
              onSavedCandidate={handleImportCandidateSaved}
              defaultDomain={state.blockStudioMetadata?.domain ?? domainFilter}
              defaultOwner={state.blockStudioMetadata?.owner ?? ''}
              themeMode={state.themeMode}
              t={t}
              inline
            />
          ) : !hasActiveDraft ? (
            <BlockStudioStartPage
              dbtStatus={state.blockStudioDbtStatus}
              semanticStats={semanticStats}
              semanticObjectCount={semanticObjectCount}
              databaseStats={databaseStats}
              onCreateSql={readOnlyBlocks ? undefined : () => beginManualDraft('custom')}
              onCreateSemantic={readOnlyBlocks ? undefined : () => beginManualDraft('semantic')}
              readOnlyReason={readOnlyBlocksReason}
              onImport={readOnlyBlocks ? undefined : () => setWorkspaceMode('import')}
              onBuildDql={() => openAskAi({ kind: 'build', initialInput: 'Draft a reusable DQL block that ' })}
              t={t}
            />
          ) : editorMode === 'detail' ? (
            <BlockDetailView
              metadata={state.blockStudioMetadata}
              source={state.blockStudioDraft}
              parameters={state.blockStudioValidation?.parameters ?? []}
              preview={state.blockStudioPreview}
              lastRun={state.blockStudioLastRun ?? undefined}
              lineageDetail={lineageDetail}
              isSemanticBlock={isSemanticBlock}
              running={running}
              onOpenBuilder={() => setEditorMode('visual')}
              onOpenSource={() => setEditorMode('source')}
              onOpenReplacement={openReplacementBlock}
              onDelete={readOnlyBlocks ? undefined : () => state.activeBlockPath && requestDeleteBlock(state.activeBlockPath, state.blockStudioMetadata?.name || activeBlockName || state.activeBlockPath)}
              onRun={() => void handleRun()}
              onOpenHistory={() => {
                setResultTab('history');
                setBottomPaneCollapsed(false);
                loadBlockHistory();
              }}
              t={t}
            />
          ) : editorMode === 'visual' ? (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
              <BuilderModeBar mode={isSemanticBlock ? 'semantic' : 'custom'} onModeChange={switchBuilderMode} t={t} />
              <div style={{ flex: 1, minHeight: 0 }}>
                {isSemanticBlock ? (
                  <SemanticBlockBuilder
                    key={`sem-${state.activeBlockPath ?? draftSessionId}`}
                    source={state.blockStudioDraft}
                    metadata={state.blockStudioMetadata}
                    semanticLayer={state.semanticLayer}
                    dbtStatus={state.blockStudioDbtStatus}
                    domainOptions={state.authoredDomains}
                    chartConfig={currentChart}
                    onChange={handleDraftChange}
                    onMetadataChange={(next) => state.blockStudioMetadata && dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata: { ...state.blockStudioMetadata, ...next } })}
                    onOpenAi={() => openAskAi({ kind: 'edit', initialInput: 'Help resolve the selected semantic metrics and dimensions for this block: ' })}
                    onSetupRuntime={() => {
                      dispatch({ type: 'SET_SETTINGS_TAB', tab: 'project' });
                      dispatch({ type: 'SET_MAIN_VIEW', view: 'settings' });
                    }}
                    t={t}
                  />
                ) : (
                  <SqlBlockVisualBuilder
                    key={`sql-${state.activeBlockPath ?? draftSessionId}`}
                    source={state.blockStudioDraft}
                    metadata={state.blockStudioMetadata}
                    domainOptions={state.authoredDomains}
                    chartConfig={currentChart}
                    onChange={handleDraftChange}
                    onMetadataChange={(next) => state.blockStudioMetadata && dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata: { ...state.blockStudioMetadata, ...next } })}
                    onConvertToDql={() => setEditorMode('source')}
                    t={t}
                  />
                )}
              </div>
            </div>
          ) : (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {(semanticInsertChoice || databaseInsertWarning) && (
                <BuilderNotice
                  semanticChoice={semanticInsertChoice}
                  databaseWarning={databaseInsertWarning}
                  onDismiss={() => { setSemanticInsertChoice(null); setDatabaseInsertWarning(null); }}
                  onInsertAdvanced={() => {
                    if (!semanticInsertChoice) return;
                    const ref = buildSemanticRef(semanticInsertChoice.kind === 'metric' ? 'metric' : 'dimension', semanticInsertChoice.name);
                    handleDraftChange(appendSemanticRefToQuery(state.blockStudioDraft, ref));
                    setSemanticInsertChoice(null);
                  }}
                  onCreateSemantic={readOnlyBlocks ? undefined : () => dispatch({ type: 'OPEN_NEW_BLOCK_MODAL', blockType: 'semantic' })}
                  t={t}
                />
              )}
              {/* Prototype IDE chrome: file path bar + editor + 208px right rail. */}
              <div style={{ height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: '1px solid var(--border-subtle)', background: t.appBg }}>
                <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {state.activeBlockPath ?? blockStudioPathPreview(state.blockStudioMetadata)}
                </span>
                {state.blockStudioDirty && (
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--status-warning)', flexShrink: 0 }} title="Unsaved changes" />
                )}
                <div style={{ flex: 1 }} />
                {!state.blockStudioValidation ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: t.textMuted, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: t.font }}>
                    <Loader2 size={12} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> Checking
                  </span>
                ) : state.blockStudioValidation.diagnostics.filter((item) => item.severity === 'error').length === 0 ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--status-success)', fontWeight: 600, whiteSpace: 'nowrap', fontFamily: t.font }}>
                    <CheckCircle2 size={12} /> Valid
                  </span>
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--status-warning)', fontWeight: 600, whiteSpace: 'nowrap', fontFamily: t.font }}>
                    <AlertTriangle size={12} /> {state.blockStudioValidation!.diagnostics.filter((item) => item.severity === 'error').length} problem{state.blockStudioValidation!.diagnostics.filter((item) => item.severity === 'error').length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', background: t.cellBg, borderRight: '1px solid var(--border-subtle)' }}>
                  <SQLCellEditor
                    value={state.blockStudioDraft}
                    onChange={handleDraftChange}
                    onRun={() => void handleRun()}
                    themeMode={state.themeMode}
                    autoFocus
                    wrap={false}
                    fillHeight
                    schema={editorSchema}
                    dqlMode
                    errorMessage={state.blockStudioValidation?.diagnostics.find((item) => item.severity === 'error')?.message}
                  />
                </div>
                {!compactLayout && (
                  <DqlSourceRail
                    source={state.blockStudioDraft}
                    diagnostics={state.blockStudioValidation?.diagnostics ?? []}
                    parameterCount={state.blockStudioValidation?.parameters?.length ?? 0}
                    t={t}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div
        onMouseDown={bottomPaneVisible ? startBottomResize : undefined}
        style={{
          gridColumn: bottomResizeGridColumn,
          gridRow: bottomResizeGridRow,
          display: bottomPaneVisible ? 'block' : 'none',
          cursor: 'row-resize',
          background: t.headerBorder,
        }}
      />

      <div style={{ gridColumn: bottomPaneGridColumn, gridRow: bottomPaneGridRow, borderTop: bottomPaneVisible ? `1px solid ${t.headerBorder}` : 'none', display: bottomPaneVisible ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden', background: t.cellBg }}>
        {/* Compact bottom workspace: keep only tabs that are actively useful
            during block authoring. Validation and test details still run in
            the background and certification flow, but do not compete for
            attention as primary tabs. */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '0 16px', borderBottom: `1px solid ${t.headerBorder}`, flexWrap: 'wrap' }}>
          <OutputTab active={resultTab === 'results'} onClick={() => setResultTab('results')} label="Results" t={t} />
          <OutputTab active={resultTab === 'parameters'} onClick={() => setResultTab('parameters')} label={`Run inputs${(state.blockStudioValidation?.parameters?.length ?? 0) > 0 ? ` · ${state.blockStudioValidation!.parameters!.length}` : ''}`} t={t} />
          <OutputTab active={resultTab === 'lineage'} onClick={() => setResultTab('lineage')} label="Lineage" t={t} />
          <OutputTab active={resultTab === 'history'} onClick={() => {
            setResultTab('history');
            loadBlockHistory();
          }} label="History" t={t} />
          <OutputTab active={resultTab === 'save'} onClick={() => setResultTab('save')} label="Metadata" t={t} />
          <div style={{ flex: 1 }} />
          {state.blockStudioPreview ? (
            <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, whiteSpace: 'nowrap' }}>
              {state.blockStudioPreview.result.executionTime ? `Ran in ${(state.blockStudioPreview.result.executionTime / 1000).toFixed(1)}s · ` : ''}
              {state.blockStudioPreview.result.rowCount ?? state.blockStudioPreview.result.rows.length} rows
            </span>
          ) : null}
          <button
            onClick={() => setBottomPaneCollapsed(true)}
            style={{ background: 'transparent', border: 'none', color: t.textMuted, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '4px 6px' }}
            title="Hide pane"
          >
            ▾ Hide
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {resultTab === 'results' && (
            running ? (
              <BlockStudioRunStatusCard elapsedMs={runElapsedMs} />
            ) : state.blockStudioPreview ? (
              <div style={{ display: 'grid', gap: 12, padding: 12 }}>
                {state.blockStudioPreview.invocation?.resolvedParameters?.length ? (
                  <BlockInvocationSnapshot values={state.blockStudioPreview.invocation.resolvedParameters} t={t} />
                ) : null}
                {activeResultChartType === 'table' ? (
                  <TableOutput result={state.blockStudioPreview.result} themeMode={state.themeMode} />
                ) : (
                  <ChartOutput
                    result={state.blockStudioPreview.result}
                    chartConfig={state.blockStudioPreview.chartConfig}
                    themeMode={state.themeMode}
                  />
                )}
                <details
                  open={queryDetailsOpen}
                  onToggle={(event) => setQueryDetailsOpen(event.currentTarget.open)}
                  style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.pillBg }}
                >
                  <summary style={{ cursor: 'pointer', padding: '9px 11px', fontSize: 11, fontWeight: 700, color: t.textSecondary, fontFamily: t.font }}>
                    Query details
                  </summary>
                  <pre style={{ margin: 0, padding: '0 11px 11px', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 10.5, lineHeight: 1.45, color: t.textMuted, fontFamily: t.fontMono }}>
                    {state.blockStudioPreview.sql}
                  </pre>
                </details>
              </div>
            ) : runError ? (
              <BlockStudioRunErrorCard
                message={runError}
                technicalDetails={runErrorDetails}
                repairing={repairing}
                onFix={() => void handleFixAndRun(runErrorDetails ?? runError)}
                onEdit={() => setEditorMode('source')}
              />
            ) : (
              <EmptyPanel message="Run the block to preview results." />
            )
          )}
          {resultTab === 'lineage' && (
            <BlockLineagePanel
              blockName={activeBlockName}
              loading={lineageLoading}
              detail={lineageDetail}
              graph={lineageGraph}
              paths={lineagePaths}
              onSelectNode={(nodeId) => {
                dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
                dispatch({ type: 'OPEN_LINEAGE_DRAWER', nodeId });
              }}
              onOpenInspector={() => {
                if (activeBlockName) {
                  const nodeId = `block:${activeBlockName}`;
                  dispatch({ type: 'SET_LINEAGE_FOCUS', nodeId });
                  dispatch({ type: 'OPEN_LINEAGE_DRAWER', nodeId });
                }
              }}
              t={t}
            />
          )}
          {resultTab === 'parameters' && (
            <BlockStudioParameterPanel
              parameters={state.blockStudioValidation?.parameters ?? []}
              values={parameterValues}
              onChange={(name, value) => setParameterValues((current) => ({ ...current, [name]: value }))}
              onReset={(name) => setParameterValues((current) => {
                const next = { ...current };
                delete next[name];
                return next;
              })}
              onRun={() => void handleRun()}
              running={running}
              t={t}
            />
          )}
          {resultTab === 'history' && (
            <HistoryPanel
              entries={historyEntries}
              loaded={historyLoaded}
              status={historyStatus.status}
              message={historyStatus.message}
              onOpenSourceControl={() => dispatch({ type: 'SET_SIDEBAR_PANEL', panel: 'git' })}
              t={t}
            />
          )}
          {resultTab === 'save' && (
            <div style={{ display: 'grid', gap: 12 }}>
              {state.activeBlockPath && state.blockStudioMetadata && (
                <div style={{ padding: '12px 12px 0' }}>
                  <StatusWorkflow
                    currentStatus={state.blockStudioMetadata.reviewStatus ?? 'draft'}
                    blockPath={state.activeBlockPath}
                    onStatusChanged={(newStatus) => {
                      if (state.blockStudioMetadata) {
                        dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata: { ...state.blockStudioMetadata, reviewStatus: newStatus } });
                        dispatch({ type: 'SET_BLOCK_STUDIO_DRAFT', draft: setBlockStringField(state.blockStudioDraft, 'status', newStatus) });
                      }
                    }}
                    t={t}
                  />
                </div>
              )}
              {certificationResult && (
                <CertificationChecklistPanel
                  result={certificationResult}
                  t={t}
                  repairing={repairing}
                  onEditSource={() => setEditorMode('source')}
                  onEditParameters={() => setResultTab('parameters')}
                  onReviewMetrics={() => {
                    setLeftPaneCollapsed(false);
                    setExplorerTab('semantic');
                    setEditorMode('visual');
                  }}
                  onRun={() => void handleRun()}
                  onFix={(issue) => void handleFixAndRun(
                    issue.technicalDetails ?? issue.message,
                    { requireCertificationReady: true },
                  )}
                  onFixDescription={(description) => {
                    // The person's explicit one-click fix: write the shown
                    // description into the source, then certify that source.
                    if (!state.blockStudioMetadata) return;
                    const metadata = { ...state.blockStudioMetadata, description };
                    const source = setBlockStringField(state.blockStudioDraft, 'description', description);
                    dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata });
                    handleDraftChange(source);
                    void handleCertify({ source, metadata });
                  }}
                />
              )}
              <SavePanel
                metadata={state.blockStudioMetadata}
                draftMetadata={draftMetadata}
                onChange={(next) => {
                  if (!state.blockStudioMetadata) return;
                  dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata: { ...state.blockStudioMetadata, ...next } });
                  let draft = state.blockStudioDraft;
                  if (typeof next.name === 'string') draft = setBlockName(draft, next.name);
                  if (typeof next.domain === 'string') draft = setBlockStringField(draft, 'domain', next.domain);
                  if (typeof next.owner === 'string') draft = setBlockStringField(draft, 'owner', next.owner);
                  if (typeof next.description === 'string') draft = setBlockStringField(draft, 'description', next.description);
                  if (next.tags) draft = setBlockTags(draft, next.tags);
                  handleDraftChange(draft);
                }}
                t={t}
              />
            </div>
          )}
        </div>
      </div>

      {hasActiveDraft && bottomPaneCollapsed && (
        <div style={{ position: 'absolute', right: 16, bottom: 16 }}>
          <button
            onClick={() => setBottomPaneCollapsed(false)}
            style={{ background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textSecondary, cursor: 'pointer', fontSize: 12, fontFamily: t.font, padding: '8px 12px' }}
          >
            Open Results
          </button>
        </div>
      )}

      {!compactLayout && aiDockOpen && (
        <div onMouseDown={startAiResize} style={{ gridColumn: '4', gridRow: '1 / 4', cursor: 'col-resize', background: t.headerBorder }} />
      )}

      {aiDockOpen && (
        <AiSidePanel
          t={t}
          title="Block AI"
          subtitle={activeBlockName ? `Current block: ${activeBlockName}` : 'Unsaved governed block draft'}
          expanded={aiDockExpanded}
          onToggleExpanded={() => setAiDockExpanded((value) => !value)}
          onClose={() => { setAiDockOpen(false); setAiDockExpanded(false); }}
          onNewChat={() => { agentThread.resetThreadId(); setAgentPanelEpoch((value) => value + 1); }}
          running={aiRunning}
          compact={compactLayout}
          ariaLabel="Block Studio AI"
          style={{
            gridColumn: compactLayout ? '1' : '5',
            gridRow: compactLayout ? editorGridRow : '1 / 4',
          }}
        >
          <UnifiedAgentRunPanel
              key={`${agentScope}:${agentPanelEpoch}`}
              themeMode={state.themeMode}
              title="Block AI"
              scopeHint={activeBlockName ? `Current block: ${activeBlockName}` : 'Block Studio project context'}
              workspaceContext={{
                surface: 'block-studio',
                task: askAiKind === 'edit' ? 'edit_block' : 'author_block',
                draftSessionId,
                blockStudioDraft: state.blockStudioDraft,
                activeBlockPath: state.activeBlockPath,
                domain: state.blockStudioMetadata?.domain,
                importId: importSession?.id,
                importCandidateId: importSession?.candidates[0]?.id,
                ...(askAiKind === 'edit' ? { mode: 'edit', blockPath: state.activeBlockPath } : {}),
              }}
              initialMode="block"
              initialInput={askAiInitialInput}
              autoRun={askAiSeed}
              threadId={agentThread.threadId}
              onThreadIdChange={agentThread.onThreadIdChange}
              onRunningChange={setAiRunning}
              onInsertSql={(sql, title) => handleAiSqlInsert(sql, { question: title ?? activeBlockName ?? 'analysis', title })}
              onInsertDql={(payload) => { void addGeneratedDqlToBlockStudio(payload); }}
              answerFirstCards
              insertDqlActionLabel="Add to Block Studio"
              emptyHint="Describe the governed block you need. ZLens checks certified blocks and semantic metrics before creating a review-required draft."
              examplePrompts={[
                { label: 'Build from business question', prompt: 'Build a reusable governed DQL block for this business question: ' },
                { label: 'Find reusable blocks', prompt: 'Which certified DQL blocks already answer this analysis, and what should be reused instead of duplicated?' },
                { label: 'Review this block', prompt: 'Review this block for grain, compatible metrics and dimensions, parameters, tests, and certification gaps.' },
              ]}
          />
        </AiSidePanel>
      )}

      {!aiDockOpen && !compactLayout && (
        <button type="button" onClick={() => setAiDockOpen(true)} title="Open Block AI" aria-label="Open Block AI" style={{ position: 'absolute', right: 16, bottom: 16, zIndex: 5, width: 34, height: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.accent, cursor: 'pointer', boxShadow: '0 6px 18px rgba(0, 0, 0, 0.12)' }}>
          <PanelRightOpen size={16} strokeWidth={2} />
        </button>
      )}

      {saveIdentityOpen && state.blockStudioMetadata && (
        <BlockIdentityDialog
          metadata={state.blockStudioMetadata}
          domains={pendingIdentityActionRef.current === 'certify' && certifyNeedsDomain(state.blockStudioDraft, state.blockStudioMetadata.domain, state.authoredDomains)
            ? state.authoredDomains
            : undefined}
          onCancel={() => {
            pendingIdentityActionRef.current = null;
            setSaveIdentityOpen(false);
          }}
          onConfirm={(identity) => {
            let draft = setBlockName(state.blockStudioDraft, identity.name);
            draft = setBlockStringField(draft, 'owner', identity.owner);
            if (identity.domain) draft = setBlockStringField(draft, 'domain', identity.domain);
            dispatch({ type: 'SET_BLOCK_STUDIO_METADATA', metadata: { ...state.blockStudioMetadata!, ...identity } });
            dispatch({ type: 'SET_BLOCK_STUDIO_DRAFT', draft });
            setSaveIdentityOpen(false);
          }}
          t={t}
        />
      )}
      {dirtyGuardOpen && (
        <DirtyWorkDialog
          saving={saving}
          onCancel={() => setDirtyGuardOpen(false)}
          onDiscard={() => {
            setDirtyGuardOpen(false);
            completePendingWorkspaceNavigation();
          }}
          onSave={async () => {
            newAfterSaveRef.current = true;
            setDirtyGuardOpen(false);
            const saved = await handleSave();
            if (saved) {
              newAfterSaveRef.current = false;
              completePendingWorkspaceNavigation();
            }
          }}
          t={t}
        />
      )}
      {deleteDialogOpen && pendingDeleteBlock && (
        <DeleteBlockDialog
          blockName={pendingDeleteBlock.name}
          blockPath={pendingDeleteBlock.path}
          deleting={deletingBlock}
          error={deleteError}
          onCancel={() => {
            if (deletingBlock) return;
            setDeleteDialogOpen(false);
            setPendingDeleteBlock(null);
            setDeleteError(null);
          }}
          onConfirm={() => void handleDeleteBlock()}
          t={t}
        />
      )}
    </div>
  );
}

function ExplorerTabButton({
  active,
  onClick,
  label,
  busy,
  Icon,
  variant = 'secondary',
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  busy?: boolean;
  Icon?: LucideIcon;
  variant?: 'primary' | 'secondary' | 'danger';
  title?: string;
}) {
  const t = themes[useNotebookStore((state) => state.themeMode)];
  const primary = variant === 'primary';
  const danger = variant === 'danger';
  // One shape for every toolbar control — same height, radius, icon size and
  // label weight. Only colour carries the meaning (accent = commit, red =
  // destructive, neutral = navigate). Delete and Save were previously bespoke
  // inline styles with their own heights and radii, which is what made the
  // toolbar read as a row of mismatched boxes.
  return (
    <button
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      title={title ?? label}
      style={{
        background: primary ? t.accent : danger ? `${t.error}0d` : active ? `${t.accent}18` : t.btnBg,
        border: `1px solid ${primary ? t.accent : danger ? `${t.error}55` : active ? t.accent : t.btnBorder}`,
        borderRadius: 6,
        height: 28,
        color: primary ? '#ffffff' : danger ? t.error : active ? t.accent : t.textSecondary,
        cursor: busy ? 'wait' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: primary ? 800 : 600,
        fontFamily: t.font,
        padding: '0 10px',
        whiteSpace: 'nowrap',
        opacity: busy ? 0.7 : 1,
      }}
    >
      {busy ? <Loader2 size={13} strokeWidth={2} aria-hidden="true" /> : Icon ? <Icon size={13} strokeWidth={2} aria-hidden="true" /> : null}
      {busy ? `${label}...` : label}
    </button>
  );
}

/**
 * The toolbar's action buttons. Under a host without dataset.author the person
 * may look and run, but not create, delete, save, certify or ask AI to change:
 * those are left out and the toolbar says why once.
 */
export function BlockToolbarActions(props: {
  readOnly: boolean;
  readOnlyReason: string;
  hasActiveDraft: boolean;
  activeBlockPath: string | null | undefined;
  detail: boolean;
  running: boolean;
  saving: boolean;
  certifying: boolean;
  certified: boolean;
  onDelete: () => void;
  onNew: () => void;
  onAsk: () => void;
  onModify: () => void;
  onRun: () => void;
  onSave: () => void;
  onCertify: () => void;
}) {
  const { readOnly, hasActiveDraft, activeBlockPath, detail } = props;
  return (
    <>
      {/* The block overview has its own Run and Delete; the toolbar shows them only while editing. */}
      {!readOnly && activeBlockPath && !detail && (
        <TemplateButton label="Delete" Icon={Trash2} variant="danger" title="Delete this saved block" onClick={props.onDelete} />
      )}
      {!readOnly && <TemplateButton label="New block" Icon={Plus} onClick={props.onNew} />}
      {hasActiveDraft && (
        <>
          {/* A saved block gets one AI action, Modify with AI; Ask AI is for a block not saved yet. */}
          {!readOnly && !activeBlockPath && <TemplateButton label="Ask AI" Icon={Sparkles} onClick={props.onAsk} />}
          {/* Modify the block currently in the editor — the governed cascade in
              edit mode (workspaceContext.mode='edit' + blockPath). */}
          {!readOnly && activeBlockPath && <TemplateButton label="Modify with AI" Icon={Sparkles} onClick={props.onModify} />}
          {!detail && <TemplateButton label="Run" Icon={Play} onClick={props.onRun} busy={props.running} />}
          {!readOnly && (
            <>
              <TemplateButton
                label={props.saving ? 'Saving' : 'Save draft'}
                Icon={CheckCircle2}
                variant="secondary"
                busy={props.saving}
                onClick={props.onSave}
                title="Save changes as a review-required draft"
              />
              <TemplateButton
                label={props.certified ? 'Re-certify' : 'Certify'}
                Icon={ShieldCheck}
                variant="primary"
                busy={props.saving || props.certifying}
                onClick={props.onCertify}
                title="Run validation, query, tests, chart, and lineage gates before certification"
              />
            </>
          )}
        </>
      )}
    </>
  );
}

function TemplateButton(props: { label: string; onClick: () => void; busy?: boolean; Icon?: LucideIcon; variant?: 'primary' | 'secondary' | 'danger'; title?: string }) {
  return <ExplorerTabButton active={false} {...props} />;
}

// Prototype DQL-source right rail (208px): Outline of the block's sections
// with real line numbers, Problems from live validation, and Context counts.
function DqlSourceRail({
  source,
  diagnostics,
  parameterCount,
  t,
}: {
  source: string;
  diagnostics: BlockStudioDiagnostic[];
  parameterCount: number;
  t: Theme;
}) {
  const lines = source.split('\n');
  const sectionColor: Record<string, string> = {
    block: 'var(--text-tertiary)',
    parameters: 'var(--accent)',
    query: 'var(--status-success)',
    tests: 'var(--status-warning)',
    visualization: 'var(--cat-audit)',
  };
  const outline: Array<{ label: string; line: number; color: string }> = [];
  lines.forEach((line, index) => {
    const match = line.match(/^\s*(block|parameters|query|tests|visualization)\b/);
    if (match && !outline.some((row) => row.label.toLowerCase().startsWith(match[1]))) {
      const key = match[1];
      const label = key === 'block' ? 'Metadata'
        : key === 'parameters' ? `Parameters${parameterCount ? ` · ${parameterCount}` : ''}`
        : key.charAt(0).toUpperCase() + key.slice(1);
      outline.push({ label, line: index + 1, color: sectionColor[key] ?? 'var(--text-tertiary)' });
    }
  });
  const testCount = (source.match(/^\s*assert\b/gm) ?? []).length;
  const modelCount = new Set((source.match(/\b(?:from|join)\s+([a-z_][\w.]*)/gi) ?? []).map((token) => token.replace(/^(from|join)\s+/i, ''))).size;
  const errors = diagnostics.filter((item) => item.severity === 'error');
  return (
    <div style={{ width: 208, flexShrink: 0, background: t.appBg, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <div style={{ padding: '12px 14px 6px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, fontFamily: t.font }}>Outline</div>
      <div style={{ padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {outline.length === 0 ? <span style={{ fontSize: 11, color: t.textMuted, padding: '2px 8px', fontFamily: t.font }}>No sections yet.</span> : outline.map((row) => (
          <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px', borderRadius: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: row.color, flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 11.5, fontWeight: 550, color: t.textSecondary, fontFamily: t.font }}>{row.label}</span>
            <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>:{row.line}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: '14px 14px 6px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, fontFamily: t.font }}>Problems</div>
      {errors.length === 0 ? (
        <div style={{ padding: '0 14px', fontSize: 11.5, color: 'var(--status-success)', display: 'flex', alignItems: 'center', gap: 6, fontFamily: t.font }}>
          <CheckCircle2 size={12} /> No problems
        </div>
      ) : (
        <div style={{ padding: '0 14px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {errors.slice(0, 4).map((item, index) => (
            <span key={index} style={{ fontSize: 11, color: 'var(--status-error)', lineHeight: 1.4, fontFamily: t.font }}>{item.message}</span>
          ))}
        </div>
      )}
      <div style={{ padding: '14px 14px 6px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, fontFamily: t.font }}>Context</div>
      <div style={{ padding: '0 14px 16px', display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, color: t.textSecondary, fontFamily: t.font }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--accent)' }} />{parameterCount} parameter{parameterCount === 1 ? '' : 's'} bound</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--status-success)' }} />{modelCount} model{modelCount === 1 ? '' : 's'} referenced</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--status-warning)' }} />{testCount} test{testCount === 1 ? '' : 's'} declared</span>
      </div>
    </div>
  );
}

// Prototype output-pane tab: quiet text with a 2px accent underline when active.
function OutputTab({ active, onClick, label, t }: { active: boolean; onClick: () => void; label: string; t: Theme }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '9px 1px',
        fontSize: 11.5,
        fontWeight: 650,
        cursor: 'pointer',
        border: 'none',
        background: 'none',
        fontFamily: t.font,
        whiteSpace: 'nowrap',
        color: active ? t.textPrimary : t.textMuted,
        boxShadow: active ? `inset 0 -2px 0 0 ${t.accent}` : 'none',
      }}
    >
      {label}
    </button>
  );
}

// Prototype segmented toggle: 2px-padded track, active = accent tint + accent text.
function editorModeButtonStyle(t: Theme, active: boolean): React.CSSProperties {
  return controlStyle(t, { variant: active ? 'accent' : 'ghost', size: 'xs', active });
}

// Prototype semantic chips: pill radius, mono identifiers, accent tint when selected.
function selectionChipStyle(t: Theme, selected: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    background: selected ? 'var(--accent-dim)' : t.btnBg,
    border: `1px solid ${selected ? `${t.accent}55` : t.btnBorder}`,
    borderRadius: 999,
    color: selected ? t.accent : t.textSecondary,
    cursor: 'pointer',
    fontSize: 11.5,
    fontFamily: t.fontMono,
    lineHeight: 1.2,
    padding: '4px 9px',
  };
}

function BlockIdentityDialog({
  metadata,
  domains,
  onCancel,
  onConfirm,
  t,
}: {
  metadata: BlockStudioOpenPayload['metadata'];
  /** Set when certifying needs a Domain first (an Ask draft in no Domain): the dialog asks for one. */
  domains?: Domain[];
  onCancel: () => void;
  onConfirm: (identity: { name: string; owner: string; domain?: string }) => void;
  t: Theme;
}) {
  const [name, setName] = useState(metadata.name);
  const [owner, setOwner] = useState(metadata.owner);
  const [domain, setDomain] = useState('');
  const domainOptions = domains ? blockDomainOptions(undefined, domains) : [];
  const ready = Boolean(name.trim() && owner.trim() && (!domains || domain));
  return (
    <div role="dialog" aria-modal="true" aria-label="Save block" style={{ position: 'absolute', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.32)', padding: 18 }}>
      <div style={{ width: 420, maxWidth: '100%', display: 'grid', gap: 14, padding: 18, borderRadius: 10, border: `1px solid ${t.headerBorder}`, background: t.cellBg, boxShadow: '0 24px 70px rgba(0,0,0,.35)' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 850, color: t.textPrimary }}>Save governed block</div>
          <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.45, color: t.textMuted }}>Name and owner are required. ZLens will run the local governance checks and certify the block when they pass; otherwise it remains a draft with blockers.</div>
        </div>
        <FieldLabel label="Block name" t={t}><input autoFocus value={name} onChange={(event) => setName(event.target.value)} style={importInputStyle(t)} /></FieldLabel>
        <FieldLabel label="Owner" t={t}><input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="analytics@company.com or team name" style={importInputStyle(t)} /></FieldLabel>
        {domains && (
          <FieldLabel label="Domain" t={t}>
            <select aria-label="Certify into domain" value={domain} onChange={(event) => setDomain(event.target.value)} style={importInputStyle(t)}>
              <option value="">Select domain…</option>
              {domainOptions.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
            </select>
            <div style={{ fontSize: 10, lineHeight: 1.45, color: t.textMuted }}>This draft came from an AI answer and is not in a Domain yet. Pick the Domain it belongs to.</div>
          </FieldLabel>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onCancel} style={secondaryImportButtonStyle(t)}>Cancel</button>
          <button type="button" disabled={!ready} onClick={() => ready && onConfirm({ name: name.trim(), owner: owner.trim(), ...(domains ? { domain } : {}) })} style={{ ...primaryImportButtonStyle(t), opacity: ready ? 1 : .55 }}>{domains ? 'Certify block' : 'Save block'}</button>
        </div>
      </div>
    </div>
  );
}

function DirtyWorkDialog({
  saving,
  onSave,
  onDiscard,
  onCancel,
  t,
}: {
  saving: boolean;
  onSave: () => Promise<void>;
  onDiscard: () => void;
  onCancel: () => void;
  t: Theme;
}) {
  return (
    <div role="dialog" aria-modal="true" aria-label="Unsaved block" style={{ position: 'fixed', inset: 0, zIndex: 90, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(0, 0, 0, 0.42)' }}>
      <div style={{ width: 'min(430px, 100%)', border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg, padding: 18, display: 'grid', gap: 14, boxShadow: '0 20px 60px rgba(0, 0, 0, 0.24)' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>Save this block before leaving?</div>
          <div style={{ marginTop: 5, fontSize: 12, lineHeight: 1.5, color: t.textMuted, fontFamily: t.font }}>Your current Block Studio workspace has unsaved changes.</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onCancel} disabled={saving} style={secondaryImportButtonStyle(t)}>Cancel</button>
          <button type="button" onClick={onDiscard} disabled={saving} style={{ ...secondaryImportButtonStyle(t), color: t.error }}>Discard</button>
          <button type="button" onClick={() => void onSave()} disabled={saving} style={primaryImportButtonStyle(t)}>{saving ? 'Saving…' : 'Save block'}</button>
        </div>
      </div>
    </div>
  );
}

function DeleteBlockDialog({
  blockName,
  blockPath,
  deleting,
  error,
  onCancel,
  onConfirm,
  t,
}: {
  blockName: string;
  blockPath: string;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  t: Theme;
}) {
  return (
    <div role="dialog" aria-modal="true" aria-label="Delete block" style={{ position: 'fixed', inset: 0, zIndex: 95, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(0, 0, 0, 0.42)' }}>
      <div style={{ width: 'min(460px, 100%)', border: `1px solid ${t.error}55`, borderRadius: 12, background: t.cellBg, padding: 18, display: 'grid', gap: 14, boxShadow: '0 20px 60px rgba(0, 0, 0, 0.26)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ width: 30, height: 30, display: 'grid', placeItems: 'center', borderRadius: 8, background: `${t.error}12` }}><Trash2 size={16} color={t.error} /></span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>Delete “{blockName}”?</div>
            <div style={{ marginTop: 3, fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>{blockPath}</div>
          </div>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5, color: t.textSecondary, fontFamily: t.font }}>
          This removes the saved <code>.dql</code> block and its generated semantic companion. Unsaved editor changes are discarded. Git can recover committed versions.
        </div>
        {error && <div role="alert" style={{ padding: '8px 10px', borderRadius: 7, border: `1px solid ${t.error}45`, background: `${t.error}0d`, color: t.error, fontSize: 11, lineHeight: 1.4 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={onCancel} disabled={deleting} style={secondaryImportButtonStyle(t)}>Cancel</button>
          <button type="button" onClick={onConfirm} disabled={deleting} style={{ ...primaryImportButtonStyle(t), background: t.error, borderColor: t.error, opacity: deleting ? 0.65 : 1 }}>
            {deleting ? <><Loader2 size={13} className="dql-spin" /> Deleting…</> : <><Trash2 size={13} /> Delete block</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BlockStudioStartPage({
  dbtStatus,
  semanticStats,
  semanticObjectCount,
  databaseStats,
  onCreateSql,
  onCreateSemantic,
  readOnlyReason,
  onImport,
  onBuildDql,
  t,
}: {
  dbtStatus: BlockStudioDbtStatus | null;
  semanticStats: {
    metrics: number;
    measures: number;
    dimensions: number;
    timeDimensions: number;
    entities: number;
    hierarchies: number;
    semanticModels: number;
    savedQueries: number;
  };
  semanticObjectCount: number;
  databaseStats: { schemas: number; tables: number; columns: number };
  onCreateSql?: () => void;
  onCreateSemantic?: () => void;
  readOnlyReason?: string;
  onImport?: () => void;
  onBuildDql: () => void;
  t: Theme;
}) {
  const manualActions = [
    onCreateSql && {
      title: 'Blank SQL block',
      detail: 'Start with an empty custom query.',
      action: onCreateSql,
      label: 'Create',
      Icon: Code2,
    },
    onCreateSemantic && {
      title: 'Semantic block',
      detail: 'Build directly from governed metrics.',
      action: onCreateSemantic,
      label: 'Build',
      Icon: Blocks,
    },
  ].filter((card): card is NonNullable<typeof card> => Boolean(card));
  const dbtReady = Boolean(dbtStatus?.artifacts.manifest.exists);
  const semanticMetricCount = dbtStatus?.counts.metrics ?? semanticStats.metrics;
  const sourceSummary = dbtStatus
    ? `${dbtStatus.counts.models} dbt models · ${semanticMetricCount} MetricFlow metrics`
    : 'Waiting for dbt artifacts';
  const projectLabel = dbtStatus?.projectName || dbtStatus?.projectPath?.split('/').filter(Boolean).pop() || 'dbt project';

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 22, display: 'grid', gap: 14, alignContent: 'start', background: t.appBg }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>Create DQL blocks</div>
          <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.45, marginTop: 5, maxWidth: 560, fontFamily: t.font }}>
            Start from SQL you already have, or describe the business asset you want ZLens to build from project context.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', border: `1px solid ${dbtReady ? '#2ea04340' : t.headerBorder}`, borderRadius: 8, background: dbtReady ? '#2ea0430d' : t.cellBg }}>
          <CheckCircle2 size={15} strokeWidth={2} color={dbtReady ? '#2ea043' : t.textMuted} aria-hidden="true" />
          <span style={{ fontSize: 11, color: dbtReady ? '#2ea043' : t.textMuted, fontWeight: 700, fontFamily: t.font }}>
            {dbtReady ? 'dbt ready' : 'dbt pending'}
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
        <PrimaryStartAction
          title="Ask AI"
          detail="Describe the business asset you need. ZLens uses this domain's blocks, models, and semantic metrics to draft it."
          label="Describe block"
          Icon={Bot}
          onClick={onBuildDql}
          t={t}
        />
        {onImport && (
          <PrimaryStartAction
            title="Import SQL"
            detail="Paste scripts, upload files, or point at a folder. ZLens analyzes candidates without writing block files until you save."
            label="Start import"
            Icon={FileInput}
            onClick={onImport}
            t={t}
          />
        )}
        {onCreateSemantic && (
          <PrimaryStartAction
            title="Build manually"
            detail="Use the visual semantic builder for multiple metrics, compatible dimensions, time grain, filters, and chart intent."
            label="Open builder"
            Icon={Blocks}
            onClick={onCreateSemantic}
            t={t}
          />
        )}
      </div>
      {readOnlyReason && !onCreateSemantic && (
        <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>{readOnlyReason}</div>
      )}

      <details style={importDisclosureStyle(t)}>
        <summary style={importSummaryStyle(t)}>Manual options</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          {manualActions.map((card) => (
            <CompactStartTile
              key={card.title}
              title={card.title}
              detail={card.detail}
              label={card.label}
              Icon={card.Icon}
              onClick={card.action}
              t={t}
            />
          ))}
        </div>
      </details>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
        <ReadinessChip Icon={Database} label={projectLabel ? `${projectLabel} dbt` : 'dbt context'} value={sourceSummary} tone={dbtReady ? 'success' : 'neutral'} t={t} />
        <ReadinessChip Icon={Database} label="Database" value={`${databaseStats.tables} tables`} tone={databaseStats.tables > 0 ? 'success' : 'neutral'} t={t} />
        <ReadinessChip Icon={Blocks} label="DQL semantic layer" value={`${semanticObjectCount} objects`} tone={semanticObjectCount > 0 ? 'success' : 'neutral'} t={t} />
      </section>
    </div>
  );
}

function PrimaryStartAction({
  title,
  detail,
  label,
  Icon,
  onClick,
  t,
}: {
  title: string;
  detail: string;
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  t: Theme;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        border: `1px solid ${t.accent}`,
        borderRadius: 8,
        background: t.cellBg,
        color: t.textPrimary,
        cursor: 'pointer',
        display: 'grid',
        gridTemplateColumns: '42px minmax(0, 1fr) auto',
        gap: 12,
        alignItems: 'center',
        padding: 16,
        minHeight: 104,
        textAlign: 'left',
        fontFamily: t.font,
        boxShadow: `inset 0 0 0 1px ${t.accent}22`,
      }}
    >
      <span style={{ width: 42, height: 42, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${t.accent}18`, color: t.accent }}>
        <Icon size={20} strokeWidth={2} aria-hidden="true" />
      </span>
      <span style={{ display: 'grid', gap: 5, minWidth: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 850, color: t.textPrimary }}>{title}</span>
        <span style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.4 }}>{detail}</span>
      </span>
      <span style={{ color: '#ffffff', background: t.accent, borderRadius: 6, padding: '7px 10px', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </button>
  );
}

function CompactStartTile({
  title,
  detail,
  label,
  Icon,
  onClick,
  t,
}: {
  title: string;
  detail: string;
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  t: Theme;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left',
        background: t.cellBg,
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 8,
        padding: 12,
        cursor: 'pointer',
        color: t.textPrimary,
        display: 'grid',
        gridTemplateColumns: '30px minmax(0, 1fr)',
        gap: 10,
        minHeight: 94,
        fontFamily: t.font,
        alignItems: 'start',
      }}
    >
      <span style={{ width: 30, height: 30, borderRadius: 7, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: `${t.accent}14`, color: t.accent }}>
        <Icon size={16} strokeWidth={2} aria-hidden="true" />
      </span>
      <span style={{ display: 'grid', gap: 5, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: t.textPrimary }}>{title}</span>
        <span style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35 }}>{detail}</span>
        <span style={{ color: t.accent, fontSize: 11, fontWeight: 800 }}>{label}</span>
      </span>
    </button>
  );
}

function StartPill({ label, t }: { label: string; t: Theme }) {
  return (
    <span style={{
      border: `1px solid ${t.headerBorder}`,
      borderRadius: 999,
      color: t.textSecondary,
      background: t.btnBg,
      fontSize: 10,
      fontWeight: 750,
      padding: '3px 7px',
      lineHeight: 1.2,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

function ReadinessChip({
  Icon,
  label,
  value,
  tone,
  t,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  tone: 'success' | 'neutral';
  t: Theme;
}) {
  const color = tone === 'success' ? '#2ea043' : t.textMuted;
  return (
    <div style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg, padding: '9px 10px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span style={{ color, display: 'inline-flex', flexShrink: 0 }}>
        <Icon size={15} strokeWidth={2} aria-hidden="true" />
      </span>
      <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 10, color: t.textMuted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <span style={{ fontSize: 12, color: t.textPrimary, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value}
        </span>
      </span>
    </div>
  );
}

function DbtStatusRows({ status, t }: { status: BlockStudioDbtStatus | null; t: Theme }) {
  if (!status) {
    return <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>Checking dbt project status…</div>;
  }
  const artifactRows = [
    ['manifest.json', status.artifacts.manifest],
    ['catalog.json', status.artifacts.catalog],
    ['semantic_manifest.json', status.artifacts.semanticManifest],
    ['run_results.json', status.artifacts.runResults],
  ] as const;
  return (
    <div style={{ display: 'grid', gap: 9 }}>
      <InfoLine label="Project" value={status.projectName || status.projectPath || 'not detected'} t={t} />
      <InfoLine label="Provider" value={status.provider || 'none'} t={t} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <ImportPill label={`${status.counts.models} models`} tone="info" t={t} />
        <ImportPill label={`${status.counts.sources} sources`} tone="info" t={t} />
        <ImportPill label={`${status.counts.metrics} metrics`} tone="info" t={t} />
        <ImportPill label={`${status.counts.savedQueries} saved queries`} tone="info" t={t} />
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {artifactRows.map(([label, artifact]) => (
          <div key={label} style={{ display: 'grid', gridTemplateColumns: '180px 70px minmax(0, 1fr)', gap: 8, alignItems: 'center', fontSize: 12, fontFamily: t.font }}>
            <span style={{ color: t.textSecondary }}>{label}</span>
            <span style={{ color: artifact.exists ? '#2ea043' : '#d29922', fontWeight: 800 }}>{artifact.exists ? 'ready' : 'missing'}</span>
            <span title={artifact.path} style={{ color: t.textMuted, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.path}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: status.artifacts.manifest.exists ? t.textMuted : '#d29922', lineHeight: 1.45, fontFamily: t.font }}>
        {status.setupHint}
      </div>
    </div>
  );
}

function BlockContextInspector({
  source,
  databaseStats,
  semanticCount,
  onChange,
  onOpenExplorer,
  onOpenAi,
  t,
}: {
  source: string;
  databaseStats: { schemas: number; tables: number; columns: number };
  semanticCount: number;
  onChange: (source: string) => void;
  onOpenExplorer: () => void;
  onOpenAi: () => void;
  t: Theme;
}) {
  const field = (name: string) => source.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '';
  const array = (name: string) => (source.match(new RegExp(`\\b${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'i'))?.[1].match(/"([^"]*)"/g) ?? [])
    .map((value) => value.slice(1, -1));
  const tokenFields = [
    { key: 'primaryTerms', label: 'Business terms', hint: 'net revenue, active customer' },
    { key: 'sourceSystems', label: 'Source systems', hint: 'billing, product events' },
    { key: 'synonyms', label: 'Question aliases', hint: 'sales, bookings' },
  ];
  return (
    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${t.headerBorder}`, background: t.appBg, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, fontWeight: 750, color: t.textPrimary }}>Block context</div>
        <span style={{ fontSize: 11, color: t.textMuted }}>Only grounded context is kept with the block and used for retrieval.</span>
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onOpenExplorer} style={secondaryImportButtonStyle(t)}>{databaseStats.tables} database tables</button>
        <button type="button" onClick={onOpenAi} style={secondaryImportButtonStyle(t)}>Review with AI</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
        <FieldLabel label="Business outcome" t={t}>
          <SourceTextField value={field('businessOutcome')} onChange={(next) => onChange(setBlockStringField(source, 'businessOutcome', next))} placeholder="Decision or outcome this block supports" style={importInputStyle(t)} />
        </FieldLabel>
        <FieldLabel label="Agent guidance" t={t}>
          <SourceTextField value={field('llmContext')} onChange={(next) => onChange(setBlockStringField(source, 'llmContext', next))} placeholder="When to use this block" style={importInputStyle(t)} />
        </FieldLabel>
        {tokenFields.map((item) => (
          <ContextTokenEditor key={item.key} label={item.label} hint={item.hint} values={array(item.key)} onChange={(values) => onChange(setBlockArray(source, item.key, values))} t={t} />
        ))}
        <FieldLabel label="Rules and caveats" t={t}>
          {/* One rule per line; the block keeps them as a list (`caveats = [...]`). */}
          <SourceTextField multiline rows={2} value={(array('caveats').length > 0 ? array('caveats') : [field('caveats')].filter(Boolean)).join('\n')} onChange={(next) => onChange(setBlockArray(source, 'caveats', next.split(/\r?\n/)))} placeholder="Known limitation or interpretation rule, one per line" style={{ ...importInputStyle(t), resize: 'vertical' }} />
        </FieldLabel>
      </div>
      <div style={{ fontSize: 10, color: t.textMuted }}>Available authoring context: {semanticCount} semantic objects, {databaseStats.schemas} schemas, {databaseStats.columns} columns. SQL completion uses the same loaded catalog.</div>
    </div>
  );
}

function ContextTokenEditor({ label, hint, values, onChange, t }: { label: string; hint: string; values: string[]; onChange: (values: string[]) => void; t: Theme }) {
  const [input, setInput] = useState('');
  const add = () => {
    const next = input.split(',').map((value) => value.trim()).filter(Boolean);
    if (next.length > 0) onChange([...values, ...next]);
    setInput('');
  };
  return (
    <FieldLabel label={label} t={t}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: 6, minHeight: 36, border: `1px solid ${t.cellBorder}`, borderRadius: 6, background: t.cellBg }}>
        {values.map((value) => <button type="button" key={value} onClick={() => onChange(values.filter((item) => item !== value))} title="Remove" style={{ ...selectionChipStyle(t, true), border: 'none', cursor: 'pointer' }}>{value} ×</button>)}
        <input value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); add(); } }} onBlur={add} placeholder={values.length ? 'Add another…' : hint} style={{ minWidth: 120, flex: 1, border: 'none', outline: 'none', background: 'transparent', color: t.textPrimary, fontSize: 11, fontFamily: t.font }} />
      </div>
    </FieldLabel>
  );
}

function VisualParameterEditor({
  source,
  kind,
  onChange,
  t,
}: {
  source: string;
  kind: 'custom' | 'semantic';
  onChange: (next: string) => void;
  t: Theme;
}) {
  const parameters = useMemo(() => parseVisualBlockParameters(source), [source]);
  const [name, setName] = useState('');
  const [defaultText, setDefaultText] = useState('');
  const [required, setRequired] = useState(true);
  const [policy, setPolicy] = useState<'dynamic' | 'static' | 'business' | 'derived' | 'optional' | 'ambiguous_review_required'>('dynamic');
  const [typeMode, setTypeMode] = useState<'auto' | 'string' | 'number' | 'boolean' | 'date' | 'string[]' | 'number[]' | 'date[]'>('auto');
  const inferredType = inferVisualParameterType(defaultText, name);
  const parameterType = typeMode === 'auto' ? inferredType : typeMode;
  const input = importInputStyle(t);

  const add = () => {
    if (!name.trim()) return;
    onChange(upsertVisualBlockParameter(source, {
      name,
      type: parameterType,
      required: required && !defaultText.trim(),
      defaultText,
      policy,
    }));
    setName('');
    setDefaultText('');
    setRequired(true);
    setPolicy('dynamic');
    setTypeMode('auto');
  };

  return (
    <PanelBox title="Runtime parameters" t={t}>
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.45 }}>
          Add a values-only input once, then reuse this block for a different period, region, customer set, or limit.
          {kind === 'custom'
            ? <> Use <code>{'${parameter_name}'}</code> in SQL where the value belongs; ZLens always binds it safely.</>
            : ' Choose a semantic field above as a filter to create its governed parameter binding.'}
        </div>
        {parameters.length > 0 && (
          <div style={{ display: 'grid', gap: 7 }}>
            {parameters.map((parameter) => {
              const currentDefault = visualParameterDefaultText(parameter);
              const save = (next: Partial<{
                type: typeof parameter.type;
                required: boolean;
                defaultText: string;
                policy: typeof parameter.policy;
              }>) => onChange(upsertVisualBlockParameter(source, {
                name: parameter.name,
                type: next.type ?? parameter.type,
                required: next.required ?? parameter.required,
                defaultText: next.defaultText ?? currentDefault,
                policy: next.policy ?? parameter.policy,
              }));
              return (
                <div key={parameter.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) 122px minmax(150px, 1fr) 118px auto', gap: 7, alignItems: 'center', padding: 8, border: `1px solid ${t.cellBorder}`, borderRadius: 7, background: t.cellBg }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: t.textPrimary }}>{parameter.name}</div>
                    <div style={{ fontSize: 10, color: t.textMuted }}>{parameter.binding?.kind ?? 'declared value'} · {parameter.required ? 'required' : 'has default'}</div>
                  </div>
                  <select aria-label={`${parameter.name} type`} value={parameter.type} onChange={(event) => save({ type: event.target.value as typeof parameter.type })} style={input}>
                    {PARAMETER_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                  {parameter.type === 'boolean' ? (
                    <select aria-label={`${parameter.name} default`} value={currentDefault} onChange={(event) => save({ defaultText: event.target.value, required: false })} style={input}>
                      <option value="">Required / no default</option><option value="true">True</option><option value="false">False</option>
                    </select>
                  ) : (
                    <input aria-label={`${parameter.name} default`} value={currentDefault} onChange={(event) => {
                      const nextDefault = event.target.value;
                      const wasAutoTyped = parameter.type === inferVisualParameterType(currentDefault, parameter.name);
                      save({
                        defaultText: nextDefault,
                        required: nextDefault.trim() ? false : parameter.required,
                        ...(wasAutoTyped ? { type: inferVisualParameterType(nextDefault, parameter.name) } : {}),
                      });
                    }} placeholder={parameter.type.endsWith('[]') ? 'West, East' : parameter.required ? 'Required value' : 'Default value'} style={input} />
                  )}
                  <select aria-label={`${parameter.name} policy`} value={parameter.policy} onChange={(event) => save({ policy: event.target.value as typeof parameter.policy })} style={input}>
                    {PARAMETER_POLICY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                  <button type="button" onClick={() => onChange(removeVisualBlockParameter(source, parameter.name))} title={`Remove ${parameter.name}`} style={{ border: 'none', background: 'transparent', color: t.error, cursor: 'pointer', fontSize: 16, padding: '3px 5px' }}>×</button>
                </div>
              );
            })}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) minmax(150px, 1.3fr) 150px 130px auto', gap: 7, alignItems: 'center', padding: 9, border: `1px dashed ${t.btnBorder}`, borderRadius: 7, background: t.appBg }}>
          <input aria-label="New parameter name" value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} placeholder="region_set" style={input} />
          <input aria-label="New parameter default" value={defaultText} onChange={(event) => { setDefaultText(event.target.value); if (event.target.value.trim()) setRequired(false); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} placeholder="Central, East or 2026-01-01" style={input} />
          <select aria-label="New parameter type" value={typeMode} onChange={(event) => setTypeMode(event.target.value as typeof typeMode)} style={input}>
            <option value="auto">Auto · {inferredType}</option>
            {PARAMETER_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: t.textSecondary, fontSize: 11, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={required && !defaultText.trim()} onChange={(event) => setRequired(event.target.checked)} /> Required
          </label>
          <button type="button" onClick={add} disabled={!name.trim()} style={{ ...primaryImportButtonStyle(t), opacity: name.trim() ? 1 : .5 }}>Add</button>
        </div>
        <div style={{ fontSize: 10, color: t.textMuted }}>Type is inferred from a value you enter: <code>10</code> → number, <code>2026-01-01</code> → date, <code>West, East</code> → string[]. You can override it at any time.</div>
      </div>
    </PanelBox>
  );
}

const PARAMETER_TYPE_OPTIONS = ['string', 'number', 'boolean', 'date', 'string[]', 'number[]', 'date[]'] as const;
const PARAMETER_POLICY_OPTIONS = ['dynamic', 'static', 'business', 'derived', 'optional', 'ambiguous_review_required'] as const;

// ── Prototype block detail (Block Studio Redesign) ──────────────────────────
// Read-only overview for an opened block: icon tile + mono name + status pill,
// meta line, "Open in builder", stat strip, Outputs pills, Parameters table,
// DQL source with "Open in DQL Source", Tests checklist, collapsed Lineage.
const CERTIFICATION_SURFACE_LABELS: Record<string, string> = {
  'block-studio': 'Block Studio',
  'sql-import': 'SQL import',
  'app-dataset': 'App Dataset',
  cli: 'zlens certify',
};

/** Tests are optional; Certify runs them, and a column test must hold on every row. */
export const BLOCK_TESTS_HINT = 'Optional. Certify runs them: a declared test must pass, and a column test must hold on every row.';

/** Why a certified block shows Recertify: its source changed after the receipt was written. */
export const CERTIFIED_SOURCE_CHANGED_LINE = 'Edited after it was certified: this source no longer matches its certification receipt, so Ask treats the block as needing recertification. Open it in the builder and Re-certify.';

/** One line saying who certified this block and when (D5) — or that no receipt exists. */
export function certificationReceiptLine(receipt: BlockStudioMetadata['certification'] | undefined): string {
  if (!receipt) return 'Certified · no certification receipt on file (certified before receipts were recorded, or edited by hand).';
  return certifiedByLabel({ by: receipt.certifiedBy, name: receipt.certifiedByName, at: receipt.certifiedAt });
}

/** The receipt's ids and exact record, kept under Technical details (D6). */
export function certificationReceiptTechnical(receipt: NonNullable<BlockStudioMetadata['certification']>): string {
  const when = Number.isNaN(Date.parse(receipt.certifiedAt)) ? receipt.certifiedAt : new Date(receipt.certifiedAt).toLocaleString();
  const via = CERTIFICATION_SURFACE_LABELS[receipt.via] ?? receipt.via;
  return [
    `Recorded as ${receipt.certifiedBy}`,
    when,
    `via ${via}`,
    `${receipt.rules === 'enterprise' ? 'enterprise' : 'OSS'} rules`,
    receipt.sourceSha256 ? `source sha256 ${receipt.sourceSha256.slice(0, 12)}…` : '',
  ].filter(Boolean).join(' · ');
}

export function BlockDetailView({
  metadata,
  source,
  parameters,
  preview,
  lastRun,
  lineageDetail,
  isSemanticBlock,
  running,
  onOpenBuilder,
  onOpenSource,
  onOpenReplacement,
  onDelete,
  onRun,
  onOpenHistory,
  t,
}: {
  metadata: BlockStudioOpenPayload['metadata'] | null;
  source: string;
  parameters: BlockParameterDefinition[];
  preview: { sql: string; result: { rows: Array<Record<string, unknown>>; rowCount?: number; executionTime?: number } } | null;
  lastRun?: BlockCertificationOperationResult['runSummary'];
  lineageDetail: { incoming: Array<unknown>; outgoing: Array<unknown> } | null;
  isSemanticBlock: boolean;
  running: boolean;
  onOpenBuilder: () => void;
  onOpenSource: () => void;
  onOpenReplacement?: (path: string) => void;
  onDelete?: () => void;
  onRun: () => void;
  onOpenHistory: () => void;
  t: Theme;
}) {
  const certified = (metadata?.reviewStatus ?? '').toLowerCase() === 'certified';
  const name = metadata?.name || 'block';
  const semanticFields = isSemanticBlock ? parseSemanticVisualFields(source) : null;
  const queryBody = source.match(/query\s*=\s*"""([\s\S]*?)"""/i)?.[1]?.trim() ?? '';
  const outputs = semanticFields
    ? Array.from(new Set([...semanticFields.dimensions, ...(semanticFields.timeDimension ? [semanticFields.timeDimension] : []), ...semanticFields.metrics]))
    : extractSelectAliases(queryBody);
  const tests = (source.match(/^\s*assert\b.*$/gm) ?? []).map((line) => line.trim());
  const upCount = lineageDetail?.incoming?.length ?? 0;
  const downCount = lineageDetail?.outgoing?.length ?? 0;
  const [lineageOpen, setLineageOpen] = useState(false);
  const upstreamNames = ((lineageDetail?.incoming ?? []) as Array<{ node?: { name?: string } }>).map((item) => item.node?.name).filter(Boolean).slice(0, 3) as string[];
  const downstreamNames = ((lineageDetail?.outgoing ?? []) as Array<{ node?: { name?: string } }>).map((item) => item.node?.name).filter(Boolean).slice(0, 3) as string[];
  const sectionLabel: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted, marginBottom: 8, fontFamily: t.font };
  const lineagePill = (label: string, accent = false): React.ReactNode => (
    <span key={label} style={{ padding: '3px 9px', borderRadius: 999, border: `1px solid ${accent ? `${t.accent}59` : t.headerBorder}`, background: accent ? 'var(--accent-dim)' : 'var(--bg-1)', color: accent ? t.accent : t.textSecondary, fontFamily: t.fontMono, fontWeight: accent ? 600 : 400, fontSize: 11.5 }}>{label}</span>
  );
  const lineageArrow = <span style={{ color: t.textMuted, fontSize: 11 }}>→</span>;
  const lastRunDuration = preview?.result.executionTime ?? lastRun?.executionTime;
  const stats: Array<[string, string]> = [
    ['Last run', preview || lastRun ? (typeof lastRunDuration === 'number' ? `${(lastRunDuration / 1000).toFixed(1)}s` : 'Completed') : 'Not run yet'],
    ['Rows', preview ? String(preview.result.rowCount ?? preview.result.rows.length) : lastRun ? String(lastRun.rowCount) : '—'],
    ['Used in', downCount > 0 ? `${downCount} downstream` : '—'],
    ['Tests', tests.length > 0 ? `${tests.length} declared` : 'None yet'],
  ];
  return (
    <div style={{ height: '100%', overflow: 'auto', background: t.appBg }}>
      <div style={{ width: 'min(860px, 100% - 48px)', margin: '0 auto', padding: '26px 0 40px', display: 'flex', flexDirection: 'column', gap: 20, animation: 'dql-agent-fadein 0.25s ease-out', fontFamily: t.font }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <span style={{ width: 42, height: 42, borderRadius: 10, background: certified ? 'var(--status-success-bg)' : 'var(--accent-dim)', color: certified ? 'var(--status-success)' : t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, border: '1px solid var(--border-subtle)' }}>
            <Blocks size={20} strokeWidth={1.75} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 17, fontWeight: 700, color: t.textPrimary, fontFamily: t.fontMono, letterSpacing: '-0.01em' }}>{name}</span>
              {metadata?.reviewStatus ? <BlockStatusBadge status={certified && metadata.certificationSourceChanged ? 'pending_recertification' : metadata.reviewStatus} t={t} /> : null}
              {metadata?.reviewStatus === 'deprecated' ? (
                <BlockReplacementLink info={{ status: metadata.reviewStatus, replacedBy: metadata.replacedBy, deprecatedOn: metadata.deprecatedOn, replacement: metadata.replacement }} t={t} onOpen={onOpenReplacement} />
              ) : null}
            </div>
            <div style={{ fontSize: 12, color: t.textMuted, marginTop: 4 }}>
              {[metadata?.domain, metadata?.folderPath ? `folder: ${metadata.folderPath}` : null, metadata?.owner, ...(metadata?.tags?.length ? [metadata.tags.join(', ')] : [])].filter(Boolean).join(' · ') || 'Unsaved draft'}
            </div>
            {certified ? (
              <div data-testid="block-certification-receipt" style={{ fontSize: 11.5, color: t.textMuted, marginTop: 4 }}>
                {certificationReceiptLine(metadata?.certification)}
                {metadata?.certification && plainCertificationChecks(metadata.certification.checks).length ? (
                  <div data-testid="block-certification-checks">Checks passed: {plainCertificationChecks(metadata.certification.checks).join(' · ')}</div>
                ) : null}
                {metadata?.certification ? (
                  <details className="dql-technical-details">
                    <summary style={{ cursor: 'pointer' }}>Technical details</summary>
                    <span>{certificationReceiptTechnical(metadata.certification)}</span>
                  </details>
                ) : null}
              </div>
            ) : null}
            {certified && metadata?.certificationSourceChanged ? (
              <div data-testid="block-certification-source-changed" role="status" style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12, color: 'var(--status-warning)', marginTop: 6 }}>
                <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{CERTIFIED_SOURCE_CHANGED_LINE}</span>
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {metadata?.reviewStatus === 'deprecated' && onOpenReplacement ? (
              <OpenReplacementButton info={{ status: metadata.reviewStatus, replacedBy: metadata.replacedBy, deprecatedOn: metadata.deprecatedOn, replacement: metadata.replacement }} t={t} onOpen={onOpenReplacement} />
            ) : null}
            <button type="button" onClick={onOpenBuilder} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 32, padding: '0 14px', borderRadius: 8, border: 'none', background: t.accent, color: '#fff', fontSize: 12.5, fontWeight: 650, cursor: 'pointer', fontFamily: t.font, boxShadow: '0 1px 4px rgba(107,93,211,0.25)' }}>
              <Pencil size={13} strokeWidth={1.75} /> Open in builder
            </button>
            <button type="button" onClick={onRun} disabled={running} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 13px', borderRadius: 8, border: `1px solid ${t.headerBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, opacity: running ? 0.7 : 1 }}>
              {running ? <Loader2 size={12} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Play size={11} fill="currentColor" />} Run
            </button>
            {onDelete ? (
              <button type="button" aria-label={`Delete ${name}`} title="Delete block" onClick={onDelete} style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${t.error}55`, background: `${t.error}0d`, color: t.error, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <Trash2 size={14} />
              </button>
            ) : null}
            <button type="button" title="History and metadata" onClick={onOpenHistory} style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${t.headerBorder}`, background: t.cellBg, color: t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <MoreHorizontal size={15} />
            </button>
          </div>
        </div>

        {metadata?.description ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.6, color: t.textSecondary, maxWidth: 640 }}>{metadata.description}</div>
        ) : null}

        {/* stat strip */}
        <div style={{ display: 'flex', border: '1px solid var(--border-subtle)', borderRadius: 10, background: t.cellBg, overflow: 'hidden' }}>
          {stats.map(([label, value], index) => (
            <div key={label} style={{ flex: 1, padding: '12px 16px', borderRight: index < stats.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>{label}</div>
              <div style={{ fontSize: 14, fontWeight: 650, color: t.textPrimary, marginTop: 3 }}>{value}</div>
            </div>
          ))}
        </div>

        {/* outputs */}
        <div>
          <div style={sectionLabel}>Outputs</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {outputs.length > 0 ? outputs.map((output) => (
              <span key={output} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, padding: '4px 10px', borderRadius: 999, background: 'var(--accent-dim)', color: t.accent, border: `1px solid ${t.accent}33`, fontFamily: t.fontMono }}>{output}</span>
            )) : <span style={{ fontSize: 11.5, color: t.textMuted }}>Open the builder to define outputs.</span>}
          </div>
        </div>

        {/* parameters */}
        <div>
          <div style={sectionLabel}>Parameters</div>
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 9, overflow: 'hidden', background: t.cellBg }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr 1fr 0.9fr', gap: 8, padding: '7px 12px', background: 'var(--bg-1)', borderBottom: '1px solid var(--border-subtle)', fontSize: 10.5, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <span>Name</span><span>Type</span><span>Default</span><span>Policy</span>
            </div>
            {parameters.length === 0 ? (
              <div style={{ padding: '9px 12px', fontSize: 12, color: t.textMuted }}>No parameters — this block always runs the same way.</div>
            ) : parameters.map((parameter, index) => (
              <div key={parameter.name} style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr 1fr 0.9fr', gap: 8, padding: '8px 12px', borderBottom: index < parameters.length - 1 ? '1px solid var(--border-subtle)' : 'none', fontSize: 12, alignItems: 'center' }}>
                <span style={{ fontFamily: t.fontMono, fontWeight: 600, color: t.textPrimary }}>{parameter.name}</span>
                <span style={{ color: t.textSecondary }}>{parameter.type}</span>
                <span style={{ fontFamily: t.fontMono, color: parameter.default !== undefined && parameter.default !== null && parameter.default !== '' ? 'var(--status-warning)' : t.textMuted }}>
                  {parameter.default !== undefined && parameter.default !== null && parameter.default !== '' ? JSON.stringify(parameter.default) : parameter.required ? 'required' : '—'}
                </span>
                <span style={{ color: t.textMuted }}>{parameter.policy}</span>
              </div>
            ))}
          </div>
        </div>

        {/* DQL source */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ ...sectionLabel, marginBottom: 0 }}>DQL source</span>
            <button type="button" onClick={onOpenSource} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', background: 'none', color: t.accent, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, padding: 0 }}>
              Open in DQL Source <ChevronRight size={11} strokeWidth={2} />
            </button>
          </div>
          <pre style={{ margin: 0, border: '1px solid var(--border-subtle)', background: t.cellBg, borderRadius: 9, padding: '13px 15px', fontSize: 11.5, lineHeight: 1.65, fontFamily: t.fontMono, whiteSpace: 'pre', overflowX: 'auto', color: t.textPrimary, maxHeight: 320, overflowY: 'auto' }}>{source.trim() || 'Open the builder to author this block.'}</pre>
        </div>

        {/* tests + lineage */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div>
            <div style={sectionLabel}>Tests</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {tests.length > 0 ? tests.map((test) => (
                <div key={test} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <CheckCircle2 size={13} color="var(--status-success)" strokeWidth={2} style={{ flexShrink: 0 }} />
                  <span style={{ fontFamily: t.fontMono, color: t.textSecondary }}>{test}</span>
                </div>
              )) : <span style={{ fontSize: 11.5, color: t.textMuted }}>No tests yet — add assertions in the builder before certification.</span>}
            </div>
          </div>
          <div>
            <button type="button" onClick={() => setLineageOpen((open) => !open)} style={{ display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'none', cursor: 'pointer', padding: 0, fontFamily: t.font, marginBottom: 8 }}>
              <ChevronRight size={11} color={t.textMuted} strokeWidth={2} style={{ transform: lineageOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }} />
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>Lineage</span>
              {!lineageOpen ? <span style={{ fontSize: 10.5, color: t.textMuted }}>{upCount} upstream · {downCount} downstream</span> : null}
            </button>
            {lineageOpen ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11.5, animation: 'dql-agent-fadein 0.18s ease-out' }}>
                {upstreamNames.length > 0 ? upstreamNames.map((upstreamName) => lineagePill(upstreamName)) : lineagePill('no upstream')}
                {lineageArrow}
                {lineagePill(name, true)}
                {lineageArrow}
                {downstreamNames.length > 0 ? downstreamNames.map((downstreamName) => lineagePill(downstreamName)) : lineagePill('no downstream yet')}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function SemanticBlockBuilder({
  source,
  metadata,
  semanticLayer,
  dbtStatus,
  domainOptions,
  chartConfig,
  onChange,
  onMetadataChange,
  onOpenAi,
  onSetupRuntime,
  t,
}: {
  source: string;
  metadata: BlockStudioOpenPayload['metadata'] | null;
  semanticLayer: SemanticLayerState;
  dbtStatus: BlockStudioDbtStatus | null;
  domainOptions: Domain[];
  chartConfig: { chart?: string; x?: string; y?: string; color?: string; title?: string };
  onChange: (next: string) => void;
  onMetadataChange: (next: Partial<BlockStudioOpenPayload['metadata']>) => void;
  onOpenAi: () => void;
  onSetupRuntime: () => void;
  t: Theme;
}) {
  const parsedValues = parseSemanticVisualFields(source);
  const values = { ...parsedValues, filters: parsedValues.requestedFilters };
  const [compatibleDimensions, setCompatibleDimensions] = useState<SemanticDimension[]>([]);
  const [loadingCompatibility, setLoadingCompatibility] = useState(false);
  // The FULL compatibility answer so the builder can show which engine will run,
  // per-dimension incompatibility reasons, and — crucially — an explicit error
  // state instead of silently graying every dimension when the call fails.
  const [compatibility, setCompatibility] = useState<SemanticCompatibility | null>(null);
  const [compatibilityError, setCompatibilityError] = useState<string | null>(null);
  const [compatibilityReloadKey, setCompatibilityReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    if (values.metrics.length === 0) {
      setCompatibleDimensions([]);
      setCompatibility(null);
      setCompatibilityError(null);
      setLoadingCompatibility(false);
      return;
    }
    setCompatibleDimensions([]);
    setCompatibility(null);
    setLoadingCompatibility(true);
    setCompatibilityError(null);
    void api.getCompatibility(values.metrics).then((result) => {
      if (cancelled) return;
      setCompatibility(result);
      setCompatibleDimensions(result.dimensions);
    }).catch((error: unknown) => {
      if (cancelled) return;
      setCompatibleDimensions([]);
      setCompatibilityError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setLoadingCompatibility(false);
    });
    return () => { cancelled = true; };
  }, [semanticLayer.dimensions, values.metrics.join('|'), compatibilityReloadKey]);
  const compatibleNames = new Set(compatibleDimensions.flatMap((dimension) => [
    dimension.reference ?? dimension.name,
    dimension.name,
  ]));
  const qualifiedByName = new Map(compatibleDimensions.flatMap((dimension) => [
    [dimension.reference ?? dimension.name, dimension.qualifiedName ?? undefined] as const,
    [dimension.name, dimension.qualifiedName ?? undefined] as const,
  ]));
  const reasonByName = new Map((compatibility?.incompatible ?? []).map((item) => [item.name, describeIncompatibility(item.reason)] as const));
  const compatibleDimByName = new Map(compatibleDimensions.flatMap((dimension) => [
    [dimension.reference ?? dimension.name, dimension] as const,
    [dimension.name, dimension] as const,
  ]));
  const allDimensions = Array.from(new Map(
    [...semanticLayer.dimensions, ...semanticLayer.timeDimensions].map((dimension) => {
      const reference = dimension.reference ?? dimension.name;
      return [reference, { ...dimension, name: reference }] as const;
    }),
  ).values());
  const allDimensionByName = new Map(allDimensions.flatMap((dimension) => [
    [dimension.name, dimension] as const,
    [dimension.reference ?? dimension.name, dimension] as const,
  ]));
  const eligibleDimensions = compatibleDimensions.map((dimension) => {
    const reference = dimension.reference ?? dimension.name;
    const catalogDimension = allDimensionByName.get(reference) ?? allDimensionByName.get(dimension.name);
    return { ...catalogDimension, ...dimension, name: reference };
  });
  const eligibleTimeDimensions = eligibleDimensions.filter((dimension) => dimension.isTimeDimension || dimension.type === 'time');
  const compactInput = compactBuilderInputStyle(t);
  const [metricSearch, setMetricSearch] = useState('');
  const [dimensionSearch, setDimensionSearch] = useState('');
  const metricByName = useMemo(() => new Map(semanticLayer.metrics.map((metric) => [metric.name, metric])), [semanticLayer.metrics]);
  const dimensionByName = useMemo(() => new Map(
    [...allDimensions, ...eligibleDimensions].flatMap((dimension) => [
      [dimension.name, dimension] as const,
      [dimension.reference ?? dimension.name, dimension] as const,
    ]),
  ), [allDimensions, eligibleDimensions]);
  const metricMatches = useMemo(() => findSemanticFieldMatches(semanticLayer.metrics, metricSearch), [semanticLayer.metrics, metricSearch]);
  const dimensionMatches = useMemo(() => findSemanticFieldMatches(eligibleDimensions, dimensionSearch), [eligibleDimensions, dimensionSearch]);
  const testsBody = getDqlSectionBody(source, 'tests');
  const outputFields = Array.from(new Set([...values.dimensions, ...(values.timeDimension ? [values.timeDimension] : []), ...values.metrics]));
  const updateText = (field: 'name' | 'domain' | 'description' | 'owner', value: string) => {
    onMetadataChange({ [field]: value });
    onChange(field === 'name' ? setBlockName(source, value) : setBlockStringField(source, field, value));
  };
  const toggleMetric = (metric: string) => {
    const metrics = values.metrics.includes(metric)
      ? values.metrics.filter((item) => item !== metric)
      : [...values.metrics, metric];
    onChange(setSemanticMetrics(source, metrics));
  };
  const setDimensions = (dimensions: string[]) => onChange(setSemanticArray(source, 'dimensions', dimensions));
  const toggleDimension = (dimension: string) => {
    const next = values.dimensions.includes(dimension)
      ? values.dimensions.filter((item) => item !== dimension)
      : [...values.dimensions, dimension];
    setDimensions(next);
  };
  useEffect(() => {
    if (!compatibility || values.metrics.length === 0) return;
    const next = reconcileSemanticCompatibility(source, Array.from(compatibleNames));
    if (next !== source) onChange(next);
  }, [compatibility, source]);
  return (
    <div style={{ height: '100%', overflow: 'auto', background: t.appBg }}>
    <div style={{ width: 'min(820px, 100% - 48px)', margin: '0 auto', padding: '24px 0 40px', display: 'flex', flexDirection: 'column', animation: 'dql-agent-fadein 0.25s ease-out' }}>
      <CompactBlockIdentity
        metadata={metadata}
        domains={domainOptions}
        onTextChange={updateText}
        onFolderChange={(folderPath) => onMetadataChange({ folderPath })}
        onTagsChange={(tags) => { onMetadataChange({ tags }); onChange(setBlockTags(source, tags)); }}
        t={t}
      />
        <PanelBox title="Metric and grain" hint="Pick governed semantic objects — they compile to the DQL script." t={t}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 750, color: t.textSecondary }}>Governed metrics · {values.metrics.length} selected</span>
            {loadingCompatibility && <span style={{ fontSize: 10, color: t.textMuted }}>Checking compatibility…</span>}
          </div>
          <EnterpriseSemanticPicker
            kind="metric"
            total={semanticLayer.metrics.length}
            search={metricSearch}
            onSearchChange={setMetricSearch}
            matches={metricMatches}
            pool={semanticLayer.metrics}
            selected={values.metrics}
            resolveLabel={(name) => metricByName.get(name)?.label || name}
            onToggle={toggleMetric}
            compatible={(name) => metricByName.get(name)?.execution?.status !== 'requires_setup' && metricByName.get(name)?.execution?.status !== 'unsupported'}
            t={t}
          />
          {semanticLayer.metrics.some((metric) => metric.execution && metric.execution.status !== 'ready') && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 10.5, color: t.textMuted, lineHeight: 1.4 }}>
              <span style={{ flex: 1 }}>Complex metrics are imported but need a full semantic runtime to execute.</span>
              <button type="button" onClick={onSetupRuntime} style={{ border: 'none', background: 'transparent', color: t.accent, fontSize: 10.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>Set up runtime →</button>
            </div>
          )}
          {(compatibility?.engine || compatibility?.degraded) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: t.textMuted, marginTop: 2 }}>
              <span style={{ padding: '1px 7px', borderRadius: 999, background: 'var(--accent-dim)', color: 'var(--accent)', fontWeight: 700 }}>
                Runs via {RUNTIME_ENGINE_LABEL[compatibility.engine] ?? compatibility.engine}
              </span>
              {compatibility.degraded && <span style={{ color: 'var(--status-warning)' }}>{compatibility.degraded}</span>}
            </div>
          )}
          {compatibilityError && (
            <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--status-warning)', lineHeight: 1.4, marginTop: 4 }}>
              <AlertTriangle size={14} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1 }}>Could not verify governed dimensions: {compatibilityError}. Dimension selection is paused so an unapproved join cannot be saved.</span>
              <button type="button" onClick={() => setCompatibilityReloadKey((k) => k + 1)} style={secondaryImportButtonStyle(t)}>Retry</button>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 8 }}>
            <FieldLabel label="Time dimension" t={t}>
              <select disabled={values.metrics.length === 0 || loadingCompatibility || Boolean(compatibilityError)} value={values.timeDimension} onChange={(event) => onChange(setSemanticScalar(source, 'time_dimension', event.target.value))} style={{ ...compactInput, opacity: values.metrics.length === 0 || loadingCompatibility || compatibilityError ? 0.6 : 1 }}>
                <option value="">None</option>
                {eligibleTimeDimensions.map((dimension) => (
                  <option key={dimension.reference ?? dimension.name} value={dimension.reference ?? dimension.name}>
                    {dimension.label || dimension.name} · {dimension.name}
                  </option>
                ))}
              </select>
            </FieldLabel>
            <FieldLabel label="Grain" t={t}>
              <select value={values.granularity} onChange={(event) => onChange(setSemanticScalar(source, 'granularity', event.target.value))} style={compactInput}>
                <option value="">None</option>
                {selectedTimeGrains(values.timeDimension, compatibleDimByName, semanticLayer.timeDimensions).map((grain) => <option key={grain} value={grain}>{grain}</option>)}
              </select>
            </FieldLabel>
          </div>
          {semanticLayer.metrics.length === 0 && (
            semanticLayer.loading ? (
              <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: t.textMuted, lineHeight: 1.45 }}>
                <Loader2 size={14} className="dql-spin" />
                Loading {(dbtStatus?.counts.metrics ?? 0).toLocaleString()} semantic metrics from parsed dbt artifacts… Large catalogs continue loading in the background.
              </div>
            ) : (dbtStatus?.counts.metrics ?? 0) > 0 || dbtStatus?.artifacts.semanticManifest.exists ? (
              <div role="alert" style={{ fontSize: 12, color: 'var(--status-warning)', lineHeight: 1.45 }}>
                dbt artifacts contain {(dbtStatus?.counts.metrics ?? 0).toLocaleString()} metrics, but Block Studio could not load them. Refresh the semantic layer; another dbt parse is not required.
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--status-warning)', lineHeight: 1.45 }}>
                No semantic metrics were discovered. Run dbt parse or import a semantic layer, then refresh Block Studio.
              </div>
            )
          )}
          {values.metrics.length > 1 && compatibility && compatibleDimensions.length === 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#d29922', fontSize: 11, lineHeight: 1.4 }}>
              <AlertTriangle size={14} /> These metrics do not expose a common dimension or join path.
              <button type="button" onClick={onOpenAi} style={secondaryImportButtonStyle(t)}>Resolve with AI</button>
            </div>
          )}
        </PanelBox>

        <PanelBox title="Chart intent" hint="How apps and answers render this block by default." t={t}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
            <FieldLabel label="Type" t={t}>
              <select value={chartConfig.chart ?? 'table'} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, chart: event.target.value }))} style={compactInput}>
                <option value="table">Table</option>
                {CHART_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </FieldLabel>
            <FieldLabel label="X axis" t={t}><select value={chartConfig.x ?? ''} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, x: event.target.value }))} style={compactInput}><option value="">Auto</option>{outputFields.map((field) => <option key={field} value={field}>{businessLabel(field)}</option>)}</select></FieldLabel>
            <FieldLabel label="Y axis" t={t}><select value={chartConfig.y ?? ''} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, y: event.target.value }))} style={compactInput}><option value="">Auto</option>{outputFields.map((field) => <option key={field} value={field}>{businessLabel(field)}</option>)}</select></FieldLabel>
            <FieldLabel label="Series / color" t={t}><select value={chartConfig.color ?? ''} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, color: event.target.value }))} style={compactInput}><option value="">None</option>{outputFields.map((field) => <option key={field} value={field}>{businessLabel(field)}</option>)}</select></FieldLabel>
          </div>
          <FieldLabel label="Title" t={t}>
            <input value={chartConfig.title ?? ''} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, title: event.target.value }))} placeholder="Chart title" style={compactInput} />
          </FieldLabel>
        </PanelBox>

      <PanelBox title="Dimensions" hint="Governed group-bys checked against the metric's join path." t={t}>
        {values.metrics.length === 0 ? (
          <div style={{ fontSize: 12, color: t.textMuted }}>Choose one or more governed metrics first. Only their connected, approved dimensions will appear.</div>
        ) : loadingCompatibility ? (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: t.textMuted }}><Loader2 size={14} className="dql-spin" />Checking common governed dimensions…</div>
        ) : compatibilityError ? (
          <div style={{ fontSize: 12, color: 'var(--status-warning)' }}>Dimension selection is unavailable until compatibility succeeds.</div>
        ) : eligibleDimensions.length === 0 ? (
          <div style={{ fontSize: 12, color: t.textMuted }}>No dimensions are loaded yet.</div>
        ) : (
          <EnterpriseSemanticPicker
            kind="dimension"
            total={eligibleDimensions.length}
            search={dimensionSearch}
            onSearchChange={setDimensionSearch}
            matches={dimensionMatches}
            pool={eligibleDimensions}
            selected={values.dimensions}
            resolveLabel={(name) => dimensionByName.get(name)?.label || name}
            resolveMachineName={(name) => qualifiedByName.get(name) ?? dimensionByName.get(name)?.name ?? name}
            reasonFor={(name) => reasonByName.get(name)}
            onToggle={toggleDimension}
            compatible={(name) => compatibleNames.has(name)}
            disabled={values.metrics.length === 0 || loadingCompatibility || Boolean(compatibilityError)}
            emptyHint={loadingCompatibility ? 'Checking common governed dimensions…' : compatibilityError ? 'Retry compatibility before selecting dimensions.' : 'Choose a metric first; dimensions are checked against its governed join path.'}
            t={t}
          />
        )}
      </PanelBox>

      <PanelBox title="Filters and parameters" hint="Values-only inputs so this block is reusable across periods and regions." t={t}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {Array.from(new Set([...values.dimensions, ...(values.timeDimension ? [values.timeDimension] : [])])).map((name) => {
            const selected = values.filters.includes(name);
            return <button key={name} type="button" onClick={() => onChange(setSemanticRuntimeFilters(source, selected ? values.filters.filter((item) => item !== name) : [...values.filters, name]))} style={selectionChipStyle(t, selected)}>{dimensionByName.get(name)?.label || name}</button>;
          })}
        </div>
        <div style={{ fontSize: 10, color: t.textMuted, marginTop: 8 }}>{values.dimensions.length === 0 && !values.timeDimension ? 'Search and add a compatible dimension first, then choose whether it should also be a dynamic filter.' : 'Selected fields become governed runtime filters. Values stay dynamic rather than being hard-coded into SQL.'}</div>
        {values.filters.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>{values.filters.map((filter) => <span key={filter} style={selectionChipStyle(t, true)}>{businessLabel(filter)} · dynamic</span>)}</div>}
      </PanelBox>

      <VisualParameterEditor
        source={source}
        kind="semantic"
        onChange={onChange}
        t={t}
      />

      <PanelBox title={`Output fields${outputFields.length ? ` · ${outputFields.length}` : ''}`} hint="What consumers see when this block answers a question." t={t}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{outputFields.length > 0 ? outputFields.map((field) => <span key={field} style={selectionChipStyle(t, true)}>{businessLabel(field)}</span>) : <span style={{ fontSize: 11, color: t.textMuted }}>Select metrics and dimensions to define outputs.</span>}</div>
      </PanelBox>
      <PanelBox title="Tests" hint={BLOCK_TESTS_HINT} t={t}>
        <SourceTextField multiline value={testsBody} onChange={(next) => onChange(setDqlSectionBody(source, 'tests', next))} placeholder={'assert row_count >= 1\nassert total_revenue >= 0'} style={{ ...compactInput, minHeight: 64, resize: 'vertical', fontFamily: t.fontMono }} />
      </PanelBox>

      <details style={{ padding: '14px 0', color: t.textSecondary, fontFamily: t.font }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 750 }}>Generated DQL preview</summary>
        <pre style={{ maxHeight: 240, overflow: 'auto', margin: '10px 0 0', whiteSpace: 'pre-wrap', color: t.textSecondary, fontSize: 11, lineHeight: 1.45, fontFamily: t.fontMono, border: '1px solid var(--border-subtle)', background: 'var(--bg-2)', borderRadius: 9, padding: '12px 14px' }}>{source}</pre>
      </details>
    </div>
    </div>
  );
}

function CompactBlockIdentity({
  metadata,
  domains,
  onTextChange,
  onFolderChange,
  onTagsChange,
  t,
}: {
  metadata: BlockStudioOpenPayload['metadata'] | null;
  domains: Domain[];
  onTextChange: (field: 'name' | 'domain' | 'description' | 'owner', value: string) => void;
  onFolderChange: (folderPath: string) => void;
  onTagsChange: (tags: string[]) => void;
  t: Theme;
}) {
  const options = blockDomainOptions(metadata?.domain, domains);
  const input = compactBuilderInputStyle(t);
  return (
    <PanelBox title="Details" hint="Name, ownership, and where this block lives." t={t}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <FieldLabel label="Block name" t={t}>
          <input aria-label="Block name" aria-invalid={metadata ? !metadata.name.trim() : undefined} value={metadata?.name ?? ''} onChange={(event) => onTextChange('name', event.target.value)} style={{ ...input, fontFamily: t.fontMono }} />
          {metadata && !metadata.name.trim() && (
            <div role="alert" data-testid="block-name-required" style={{ marginTop: 5, fontSize: 10, color: t.error }}>
              A block needs a name. Type one to save; until then the block keeps its previous name.
            </div>
          )}
        </FieldLabel>
        <FieldLabel label="Domain" t={t}>
          <select aria-label="Block domain" value={metadata?.domain ?? ''} onChange={(event) => onTextChange('domain', event.target.value)} style={input}>
            <option value="">Select domain…</option>
            {options.map((domain) => (
              <option key={domain.value} value={domain.value} disabled={domain.disabled}>
                {domain.label}
              </option>
            ))}
          </select>
        </FieldLabel>
        <FieldLabel label="Owner" t={t}><input value={metadata?.owner ?? ''} onChange={(event) => onTextChange('owner', event.target.value)} placeholder="Required to save" style={input} /></FieldLabel>
        <FieldLabel label="Tags" t={t}><CommaListInput values={metadata?.tags ?? []} onChange={onTagsChange} placeholder="finance, emea" style={input} /></FieldLabel>
        <div style={{ gridColumn: '1 / -1' }}>
          <FieldLabel label="Folder (optional)" t={t}>
            <input
              aria-label="Block folder"
              value={metadata?.folderPath ?? ''}
              onChange={(event) => onFolderChange(event.target.value)}
              placeholder="executive/monthly"
              style={{ ...input, fontFamily: t.fontMono }}
            />
          </FieldLabel>
          <div style={{ marginTop: 5, fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>
            {blockStudioPathPreview(metadata)}
          </div>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <FieldLabel label="Description" t={t}><input value={metadata?.description ?? ''} onChange={(event) => onTextChange('description', event.target.value)} placeholder="What business question does this answer?" style={input} /></FieldLabel>
        </div>
      </div>
    </PanelBox>
  );
}

type SemanticPickerField = {
  name: string;
  label?: string;
  description?: string;
  domain?: string;
  type?: string;
};

function findSemanticFieldMatches<T extends SemanticPickerField>(fields: T[], search: string): T[] {
  const normalized = search.trim().toLowerCase();
  if (normalized.length < 2) return [];
  return fields.filter((field) => [field.name, field.label, field.description, field.domain]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(normalized)))
    .slice(0, 30);
}

// Prototype picker: selected semantic objects render as removable mono chips
// (Σ purple for measures, green for dimensions) and "+ Add …" opens a 300px
// searchable popover anchored right:0 with an autofocused input and a
// "Showing top N of M · type to search all" footer.
function EnterpriseSemanticPicker({
  kind,
  total,
  search,
  onSearchChange,
  matches,
  pool = [],
  selected,
  resolveLabel,
  resolveMachineName,
  reasonFor,
  onToggle,
  compatible = () => true,
  disabled = false,
  emptyHint,
  t,
}: {
  kind: 'metric' | 'dimension';
  total: number;
  search: string;
  onSearchChange: (value: string) => void;
  matches: SemanticPickerField[];
  /** Full pool for the popover's default top-8 listing before a search. */
  pool?: SemanticPickerField[];
  selected: string[];
  resolveLabel: (name: string) => string;
  /** The machine identifier to show under the label (qualified name ?? name). */
  resolveMachineName?: (name: string) => string | undefined;
  /** Human explanation for an incompatible row (shown as its tooltip). */
  reasonFor?: (name: string) => string | undefined;
  onToggle: (name: string) => void;
  compatible?: (name: string) => boolean;
  disabled?: boolean;
  emptyHint?: string;
  t: Theme;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const label = kind === 'metric' ? 'measures' : 'dimensions';
  const glyph = kind === 'metric' ? 'Σ' : 'ab';
  const chipColor = kind === 'metric' ? 'var(--accent)' : 'var(--status-success)';
  const chipBg = kind === 'metric' ? 'var(--accent-dim)' : 'var(--status-success-bg)';
  const searching = search.trim().length >= 2;
  const results = searching ? matches : pool.filter((field) => !selected.includes(field.name)).slice(0, 8);
  const closePicker = () => { setOpen(false); onSearchChange(''); };
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) closePicker();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closePicker(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 9 }}>
      {selected.map((name) => (
        <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, padding: '4px 9px', borderRadius: 999, background: chipBg, color: chipColor, border: `1px solid ${kind === 'metric' ? 'rgba(107,93,211,0.2)' : 'rgba(46,139,87,0.25)'}`, fontFamily: t.fontMono }}>
          {kind === 'metric' ? `Σ ${resolveLabel(name)}` : resolveLabel(name)}
          <button type="button" onClick={() => onToggle(name)} title={`Remove ${resolveLabel(name)}`} style={{ border: 'none', background: 'none', color: chipColor, cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1, fontFamily: 'inherit' }}>×</button>
        </span>
      ))}
      <span ref={wrapRef} style={{ position: 'relative' }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
          title={disabled ? emptyHint : `Add ${kind}`}
          style={{ border: '1.5px dashed var(--border-strong)', background: 'transparent', borderRadius: 999, padding: '4px 10px', fontSize: 11, fontFamily: t.font, color: disabled ? t.textMuted : t.textSecondary, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}
        >
          + Add {kind}
        </button>
        {open && !disabled ? (
          <div style={{ position: 'absolute', right: 0, top: 30, zIndex: 40, width: 300, background: t.cellBg, border: `1px solid ${t.headerBorder}`, borderRadius: 10, boxShadow: '0 10px 30px rgba(26,26,26,0.14)', overflow: 'hidden', animation: 'dql-agent-fadein 0.12s ease-out' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
              <Search size={12} color={t.textMuted} style={{ flexShrink: 0 }} />
              <input
                ref={inputRef}
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder={`Search ${total.toLocaleString()} ${label}…`}
                style={{ flex: 1, border: 'none', background: 'none', outline: 'none', fontSize: 12, fontFamily: t.font, color: t.textPrimary, minWidth: 0 }}
              />
              <button type="button" onClick={closePicker} style={{ border: 'none', background: 'none', color: t.textMuted, cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1 }}>×</button>
            </div>
            <div style={{ maxHeight: 208, overflow: 'auto' }}>
              {results.length === 0 ? (
                <div style={{ padding: 10, fontSize: 11, color: t.textMuted }}>{searching ? `No ${label} match “${search}”.` : `No more ${label} to add.`}</div>
              ) : results.map((field) => {
                const isSelected = selected.includes(field.name);
                const isCompatible = compatible(field.name);
                const machineName = resolveMachineName?.(field.name) ?? field.name;
                const showMachine = machineName !== (field.label || field.name);
                const incompatReason = !isCompatible
                  ? (reasonFor?.(field.name) ?? 'Not compatible with every selected metric')
                  : undefined;
                return (
                  <button
                    key={field.name}
                    type="button"
                    disabled={!isCompatible}
                    onClick={() => { onToggle(field.name); if (!isSelected) closePicker(); }}
                    title={incompatReason ?? field.description ?? machineName}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', background: isSelected ? chipBg : 'none', cursor: isCompatible ? 'pointer' : 'not-allowed', textAlign: 'left', fontFamily: t.font, borderBottom: '1px solid var(--border-subtle)', opacity: isCompatible ? 1 : 0.5 }}
                  >
                    <span style={{ flexShrink: 0, width: 16, height: 16, borderRadius: 4, background: chipBg, color: chipColor, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: kind === 'metric' ? 10 : 9, fontWeight: 700, fontFamily: t.fontMono }}>{glyph}</span>
                    <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1, overflow: 'hidden' }}>
                      <span style={{ fontSize: 12, fontFamily: t.font, color: t.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{field.label || field.name}</span>
                      {showMachine ? <span style={{ fontSize: 10, fontFamily: t.fontMono, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{machineName}</span> : null}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 10, color: t.textMuted }}>{field.domain || field.type || ''}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ padding: '6px 10px', background: 'var(--bg-1)', fontSize: 10, color: t.textMuted }}>
              {searching
                ? `${results.length} match${results.length === 1 ? '' : 'es'} · certified shown first`
                : `Showing top ${results.length} of ${total.toLocaleString()} · type to search all`}
            </div>
          </div>
        ) : null}
      </span>
    </div>
  );
}

// Query-authoring mode toggle (Semantic picker / Raw SQL) shown above the
// visual builder, per the Block Studio prototype's Query section.
function BuilderModeBar({ mode, onModeChange, t }: { mode: 'semantic' | 'custom'; onModeChange: (mode: 'semantic' | 'custom') => void; t: Theme }) {
  const options: Array<{ key: 'semantic' | 'custom'; label: string }> = [
    { key: 'semantic', label: 'Semantic picker' },
    { key: 'custom', label: 'Raw SQL' },
  ];
  return (
    <div style={{ flexShrink: 0, borderBottom: `1px solid ${t.headerBorder}`, background: t.appBg }}>
      <div style={{ width: 'min(820px, 100% - 48px)', margin: '0 auto', padding: '10px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>Query</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: 2, border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.cellBg }}>
          {options.map((option) => {
            const active = option.key === mode;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => onModeChange(option.key)}
                style={{ border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: t.font, background: active ? 'var(--accent-dim)' : 'transparent', color: active ? t.accent : t.textMuted }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
          {mode === 'semantic' ? 'Pick governed metrics & dimensions — they compile to DQL.' : 'Write SQL and convert it into a governed DQL script.'}
        </span>
      </div>
    </div>
  );
}

function SqlBlockVisualBuilder({
  source,
  metadata,
  domainOptions,
  chartConfig,
  onChange,
  onMetadataChange,
  onConvertToDql,
  t,
}: {
  source: string;
  metadata: BlockStudioOpenPayload['metadata'] | null;
  domainOptions: Domain[];
  chartConfig: { chart?: string; x?: string; y?: string; color?: string; title?: string };
  onChange: (next: string) => void;
  onMetadataChange: (next: Partial<BlockStudioOpenPayload['metadata']>) => void;
  onConvertToDql: () => void;
  t: Theme;
}) {
  const input = compactBuilderInputStyle(t);
  const parsedQuery = source.match(/query\s*=\s*"""([\s\S]*?)"""/i)?.[1]?.trim() ?? '';
  // Local editing state so keystrokes never fight the source round-trip (the
  // builder is remounted with a fresh key when the edited block changes).
  const [sqlDraft, setSqlDraft] = useState(parsedQuery);
  const outputs = extractSelectAliases(sqlDraft);
  const testsBody = getDqlSectionBody(source, 'tests');
  const editSql = (value: string) => {
    setSqlDraft(value);
    onChange(setBlockQuery(source, value));
  };
  const updateText = (field: 'name' | 'domain' | 'description' | 'owner', value: string) => {
    onMetadataChange({ [field]: value });
    onChange(field === 'name' ? setBlockName(source, value) : setBlockStringField(source, field, value));
  };
  return (
    <div style={{ height: '100%', overflow: 'auto', background: t.appBg }}>
    <div style={{ width: 'min(820px, 100% - 48px)', margin: '0 auto', padding: '24px 0 40px', display: 'flex', flexDirection: 'column', animation: 'dql-agent-fadein 0.25s ease-out' }}>
      <CompactBlockIdentity
        metadata={metadata}
        domains={domainOptions}
        onTextChange={updateText}
        onFolderChange={(folderPath) => onMetadataChange({ folderPath })}
        onTagsChange={(tags) => { onMetadataChange({ tags }); onChange(setBlockTags(source, tags)); }}
        t={t}
      />
      <PanelBox title="Query" hint="Write raw SQL — it compiles into a governed DQL script." t={t}>
        <textarea
          rows={7}
          value={sqlDraft}
          onChange={(event) => editSql(event.target.value)}
          spellCheck={false}
          style={{ border: '1px solid var(--border-default)', background: 'var(--bg-1)', borderRadius: 8, padding: '10px 12px', fontSize: 11.5, lineHeight: 1.6, fontFamily: t.fontMono, color: t.textPrimary, outline: 'none', resize: 'vertical' }}
          placeholder={'SELECT\n  category,\n  SUM(revenue) AS revenue\nFROM {{ ref(\'orders\') }}\nGROUP BY 1'}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onConvertToDql}
            disabled={!sqlDraft.trim()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 12px', borderRadius: 8, border: `1px solid ${t.accent}`, background: 'var(--accent-dim)', color: t.accent, fontSize: 11.5, fontWeight: 650, cursor: sqlDraft.trim() ? 'pointer' : 'not-allowed', fontFamily: t.font, opacity: sqlDraft.trim() ? 1 : 0.6 }}
          >
            Convert to DQL script
          </button>
          <span style={{ fontSize: 10.5, color: t.textMuted, fontFamily: t.font }}>
            Detects <span style={{ fontFamily: t.fontMono }}>{'${params}'}</span> and grounds tables against dbt. Open the DQL Source editor for the full script.
          </span>
        </div>
      </PanelBox>
      <PanelBox title="Chart intent" hint="How apps and answers render this block by default." t={t}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
          <FieldLabel label="Type" t={t}>
            <select value={chartConfig.chart ?? 'table'} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, chart: event.target.value }))} style={input}>
              <option value="table">Table</option>
              {CHART_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </FieldLabel>
          <FieldLabel label="X axis" t={t}><select value={chartConfig.x ?? ''} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, x: event.target.value }))} style={input}><option value="">Auto</option>{outputs.map((output) => <option key={output} value={output}>{businessLabel(output)}</option>)}</select></FieldLabel>
          <FieldLabel label="Y axis" t={t}><select value={chartConfig.y ?? ''} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, y: event.target.value }))} style={input}><option value="">Auto</option>{outputs.map((output) => <option key={output} value={output}>{businessLabel(output)}</option>)}</select></FieldLabel>
          <FieldLabel label="Series / color" t={t}><select value={chartConfig.color ?? ''} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, color: event.target.value }))} style={input}><option value="">None</option>{outputs.map((output) => <option key={output} value={output}>{businessLabel(output)}</option>)}</select></FieldLabel>
        </div>
        <FieldLabel label="Title" t={t}><input value={chartConfig.title ?? ''} onChange={(event) => onChange(upsertVisualizationConfig(source, { ...chartConfig, title: event.target.value }))} style={input} /></FieldLabel>
      </PanelBox>
      <PanelBox title="Business outputs" hint="What consumers see when this block answers a question." t={t}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {outputs.length > 0 ? outputs.map((output) => <span key={output} style={selectionChipStyle(t, true)}>{businessLabel(output)}</span>) : <span style={{ fontSize: 11, color: t.textMuted }}>Add aliases in DQL Source to expose business-friendly output names.</span>}
        </div>
      </PanelBox>
      <VisualParameterEditor source={source} kind="custom" onChange={onChange} t={t} />
      <PanelBox title="Tests" hint={BLOCK_TESTS_HINT} t={t}>
        <SourceTextField multiline value={testsBody} onChange={(next) => onChange(setDqlSectionBody(source, 'tests', next))} placeholder={'assert row_count >= 1\nassert revenue >= 0'} style={{ ...input, minHeight: 64, resize: 'vertical', fontFamily: t.fontMono }} />
      </PanelBox>
      <details style={{ padding: '14px 0', color: t.textSecondary, fontFamily: t.font }}>
        <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 750 }}>Generated DQL preview</summary>
        <pre style={{ maxHeight: 240, overflow: 'auto', margin: '10px 0 0', whiteSpace: 'pre-wrap', color: t.textSecondary, fontSize: 11, lineHeight: 1.45, fontFamily: t.fontMono, border: '1px solid var(--border-subtle)', background: 'var(--bg-2)', borderRadius: 9, padding: '12px 14px' }}>{source}</pre>
      </details>
    </div>
    </div>
  );
}

function BuilderNotice({
  semanticChoice,
  databaseWarning,
  onDismiss,
  onInsertAdvanced,
  onCreateSemantic,
  t,
}: {
  semanticChoice: SemanticObjectDetail | null;
  databaseWarning: string | null;
  onDismiss: () => void;
  onInsertAdvanced: () => void;
  onCreateSemantic?: () => void;
  t: Theme;
}) {
  const message = semanticChoice
    ? `${semanticChoice.kind === 'metric' ? 'Metric' : 'Dimension'} "${semanticChoice.name}" belongs in a Semantic Block. SQL Blocks can still use advanced @metric/@dim refs when you choose that explicitly.`
    : databaseWarning ?? '';
  return (
    <div style={{ padding: '10px 12px', borderBottom: `1px solid ${t.headerBorder}`, background: `${t.accent}10`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.4, flex: 1, minWidth: 260 }}>{message}</span>
      {semanticChoice && (
        <>
          {onCreateSemantic && <button onClick={onCreateSemantic} style={secondaryImportButtonStyle(t)}>Create Semantic Block</button>}
          <button onClick={onInsertAdvanced} style={primaryImportButtonStyle(t)}>Insert advanced ref</button>
        </>
      )}
      <button onClick={onDismiss} style={secondaryImportButtonStyle(t)}>Dismiss</button>
    </div>
  );
}

function SegmentedTab({ active, onClick, label, t }: { active: boolean; onClick: () => void; label: string; t: Theme }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        borderBottom: `2px solid ${active ? t.accent : 'transparent'}`,
        color: active ? t.textPrimary : t.textMuted,
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        fontFamily: t.font,
        padding: '10px 2px',
        marginBottom: -1,
      }}
    >
      {label}
    </button>
  );
}

type ImportSourceMode = 'path' | 'paste' | 'upload';
type SmartImportPhase = 'idle' | 'creating' | 'running' | 'saving' | 'complete';
type SmartImportItemStatus = 'queued' | 'running' | 'ready' | 'saving' | 'saved' | 'needs_attention';

interface SmartImportCounts {
  saved: number;
  ready: number;
  attention: number;
  processing: number;
}

interface SmartImportItem {
  id: string;
  name: string;
  sourcePath: string;
  status: SmartImportItemStatus;
  message?: string;
  rows?: number;
  savedPath?: string;
}

function rowCountForImportCandidate(candidate: BlockStudioImportCandidate): number | undefined {
  const rowCount = candidate.preview?.result?.rowCount ?? candidate.preview?.result?.rows?.length;
  return typeof rowCount === 'number' ? rowCount : undefined;
}

function isDraftBlockPath(path?: string | null): boolean {
  if (!path) return false;
  return path.startsWith('blocks/_drafts/') || /^domains\/[^/]+\/blocks\/_drafts\//.test(path);
}

/**
 * Where an import candidate stands on the trust path, read from the DQL it
 * saved: only a source whose status is certified (written by the explicit
 * Certify action) counts as certified. Saving writes a draft.
 */
export function importCandidateTrust(candidate: Pick<BlockStudioImportCandidate, 'reviewStatus' | 'dqlSource' | 'savedPath' | 'draftSave'>): 'certified' | 'draft_saved' | 'unsaved' {
  if (candidate.reviewStatus === 'saved' && /^\s*status\s*=\s*"certified"/m.test(candidate.dqlSource ?? '')) return 'certified';
  if (candidate.reviewStatus === 'saved' || candidate.draftSave?.status === 'saved' || isDraftBlockPath(candidate.savedPath)) return 'draft_saved';
  return 'unsaved';
}

function smartItemFromCandidate(candidate: BlockStudioImportCandidate): SmartImportItem {
  if (candidate.reviewStatus === 'saved') {
    const certified = importCandidateTrust(candidate) === 'certified';
    return {
      id: candidate.id,
      name: candidate.name,
      sourcePath: candidate.sourcePath,
      status: 'saved',
      rows: rowCountForImportCandidate(candidate),
      message: certified ? 'Certified.' : 'Draft saved · needs review. Certify it when it is ready.',
    };
  }
  if (candidate.validation?.valid === false) {
    return {
      id: candidate.id,
      name: candidate.name,
      sourcePath: candidate.sourcePath,
      status: 'needs_attention',
      message: candidate.validation.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ?? 'DQL validation needs attention.',
    };
  }
  if (candidate.preview) {
    return {
      id: candidate.id,
      name: candidate.name,
      sourcePath: candidate.sourcePath,
      status: 'ready',
      rows: rowCountForImportCandidate(candidate),
      savedPath: candidate.savedPath,
      message: isDraftBlockPath(candidate.savedPath)
        ? 'Preview ran successfully. Draft is saved for review.'
        : 'Preview ran successfully. Nothing is written until you save.',
    };
  }
  if (candidate.draftSave?.status === 'saved' || isDraftBlockPath(candidate.savedPath)) {
    return {
      id: candidate.id,
      name: candidate.name,
      sourcePath: candidate.sourcePath,
      status: 'ready',
      savedPath: candidate.draftSave?.path ?? candidate.savedPath,
      message: 'Draft saved. Run preview, then certify when ready.',
    };
  }
  if (candidate.draftSave?.status === 'error') {
    return {
      id: candidate.id,
      name: candidate.name,
      sourcePath: candidate.sourcePath,
      status: 'needs_attention',
      message: candidate.draftSave.error ?? 'Draft preparation failed.',
    };
  }
  return {
    id: candidate.id,
    name: candidate.name,
    sourcePath: candidate.sourcePath,
    status: 'queued',
    message: 'Ready to process.',
  };
}

function importAnalysisMessage(status: BlockStudioImportCandidate['analysisStatus']): string {
  if (status === 'retrieving') return 'Checking certified blocks and semantic metrics.';
  if (status === 'reviewing') return 'Reviewing governed evidence and building the candidate.';
  if (status === 'ready') return 'Analysis ready. Preparing preview.';
  if (status === 'needs_attention') return 'Analysis needs attention.';
  return 'Queued for governed retrieval.';
}

async function waitForDqlImportAnalysis(
  importId: string,
  onProgress: (session: BlockStudioImportSession) => void,
): Promise<BlockStudioImportSession> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const next = await api.getDqlGenerationSession(importId);
    onProgress(next);
    if (next.candidates.every((candidate) => candidate.analysisStatus === 'ready' || candidate.analysisStatus === 'needs_attention')) {
      return next;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  throw new Error('Import analysis is still running. You can leave this workspace and resume the session later.');
}

async function mapWithUiConcurrency<T>(items: T[], limit: number, mapper: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await mapper(items[index]);
    }
  });
  await Promise.all(workers);
}

function isAiGeneratedCandidate(candidate: BlockStudioImportCandidate): boolean {
  return Boolean(candidate.generationMode || candidate.draftSave || isDraftBlockPath(candidate.savedPath));
}

function smartImportPhaseLabel(phase: SmartImportPhase): string {
  if (phase === 'creating') return 'Reading SQL';
  if (phase === 'running') return 'Running previews';
  if (phase === 'saving') return 'Saving blocks';
  if (phase === 'complete') return 'Import complete';
  return 'Ready';
}

function smartImportStatusLabel(status: SmartImportItemStatus): string {
  if (status === 'needs_attention') return 'needs attention';
  return status.replace('_', ' ');
}

function smartImportStatusTone(status: SmartImportItemStatus): 'ok' | 'warn' | 'info' {
  if (status === 'saved' || status === 'ready') return 'ok';
  if (status === 'needs_attention') return 'warn';
  return 'info';
}

function BlockStudioImportWorkspace({
  session,
  sessions,
  sessionsLoading,
  onClose,
  onSessionChange,
  onRefreshSessions,
  onSelectCandidate,
  onSavedCandidate,
  defaultDomain,
  defaultOwner,
  themeMode,
  t,
  inline = false,
}: {
  session: BlockStudioImportSession | null;
  sessions: BlockStudioImportSessionSummary[];
  sessionsLoading: boolean;
  onClose: () => void;
  onSessionChange: (session: BlockStudioImportSession | null) => void;
  onRefreshSessions: () => Promise<void>;
  onSelectCandidate: (candidate: BlockStudioImportCandidate) => void;
  onSavedCandidate: (candidate: BlockStudioImportCandidate, block: BlockStudioOpenPayload) => void;
  defaultDomain: string;
  defaultOwner: string;
  themeMode: ThemeMode;
  t: Theme;
  inline?: boolean;
}) {
  const [mode, setMode] = useState<ImportSourceMode>('paste');
  const [path, setPath] = useState('');
  const [pasteSql, setPasteSql] = useState('');
  const [uploadSources, setUploadSources] = useState<Array<{ path: string; content: string }>>([]);
  const [domain, setDomain] = useState(defaultDomain);
  const [owner, setOwner] = useState(defaultOwner);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'one'; id: string } | { kind: 'all' } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(true);
  const [candidateSearch, setCandidateSearch] = useState('');
  const [showAllCandidates, setShowAllCandidates] = useState(false);
  const [candidateErrors, setCandidateErrors] = useState<Record<string, string>>({});
  const [smartPhase, setSmartPhase] = useState<SmartImportPhase>('idle');
  const [smartItems, setSmartItems] = useState<Record<string, SmartImportItem>>({});
  // Certify refused only because the description still says "review
  // required": the fix the server suggested, offered as one explicit click.
  const [certifyFix, setCertifyFix] = useState<{ candidateId: string; suggestedDescription: string } | null>(null);

  const selectedCandidate = useMemo(() => {
    if (!session) return null;
    return session.candidates.find((candidate) => candidate.id === selectedId) ?? session.candidates[0] ?? null;
  }, [session, selectedId]);

  useEffect(() => {
    if (!session?.candidates.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !session.candidates.some((candidate) => candidate.id === selectedId)) {
      setSelectedId(session.candidates[0].id);
    }
  }, [session, selectedId]);

  useEffect(() => {
    setCandidateErrors({});
  }, [session?.id]);

  useEffect(() => {
    setSourceOpen(!session?.candidates.length);
  }, [session?.id, session?.candidates.length]);

  useEffect(() => {
    if (!session) {
      setSmartItems({});
      setSmartPhase('idle');
      return;
    }
    setSmartItems(Object.fromEntries(session.candidates.map((candidate) => [candidate.id, smartItemFromCandidate(candidate)])));
    setSmartPhase((phase) => phase === 'idle' ? 'complete' : phase);
  }, [session?.id]);

  const candidateMatches = useMemo(() => {
    const normalized = candidateSearch.trim().toLowerCase();
    const source = session?.candidates ?? [];
    if (!normalized) return source;
    return source.filter((candidate) => [
      candidate.name,
      candidate.domain,
      candidate.sourcePath,
      candidate.description,
      ...candidate.lineage.sourceTables,
    ].some((value) => value.toLowerCase().includes(normalized)));
  }, [candidateSearch, session]);
  const visibleCandidates = showAllCandidates || candidateSearch.trim()
    ? candidateMatches
    : candidateMatches.slice(0, 10);
  const smartCandidateItems = session?.candidates.map((candidate) => smartItems[candidate.id] ?? smartItemFromCandidate(candidate)) ?? [];
  const smartCounts = smartCandidateItems.reduce<SmartImportCounts>((counts, item) => {
    if (item.status === 'saved') counts.saved += 1;
    else if (item.status === 'ready') counts.ready += 1;
    else if (item.status === 'needs_attention') counts.attention += 1;
    else counts.processing += 1;
    return counts;
  }, { saved: 0, ready: 0, attention: 0, processing: 0 });
  const certifiedCount = session?.candidates.filter((candidate) => importCandidateTrust(candidate) === 'certified').length ?? 0;
  const draftSavedCount = session?.candidates.filter((candidate) => importCandidateTrust(candidate) === 'draft_saved').length ?? 0;
  const activeStep = !session ? 1 : smartCounts.saved > 0 || draftSavedCount > 0 ? 3 : 2;
  const readyCount = session?.candidates.filter((candidate) => candidate.validation?.valid !== false).length ?? 0;

  const sourceReady = Boolean(mode === 'paste'
    ? pasteSql.trim()
    : mode === 'upload'
      ? uploadSources.length > 0
      : path.trim());

  const buildImportPayload = () => {
    if (mode === 'paste') {
      return {
        inputMode: 'paste' as const,
        sourceKind: 'raw-sql' as const,
        domain,
        owner,
        sources: [{ path: 'pasted.sql', content: pasteSql }],
        async: true,
        persistence: 'session-only' as const,
      };
    }
    if (mode === 'upload') {
      return {
        inputMode: 'upload' as const,
        sourceKind: 'raw-sql' as const,
        domain,
        owner,
        sources: uploadSources,
        async: true,
        persistence: 'session-only' as const,
      };
    }
    return { path, inputMode: 'path' as const, sourceKind: 'raw-sql' as const, domain, owner, async: true, persistence: 'session-only' as const };
  };

    const runSmartImport = async () => {
    setLoading(true);
    setSavingAll(true);
    setError(null);
    setCandidateErrors({});
    setSmartItems({});
      setSmartPhase('creating');
      try {
        const created = await api.createDqlGenerationSession(buildImportPayload());
        let workingSession: BlockStudioImportSession = created;
        let items: Record<string, SmartImportItem> = Object.fromEntries(created.candidates.map((candidate) => [
          candidate.id,
          { ...smartItemFromCandidate(candidate), status: 'queued' as SmartImportItemStatus, message: 'Queued for governed retrieval.' },
        ]));
      const updateItem = (candidateId: string, updater: (item: SmartImportItem) => SmartImportItem) => {
        items = { ...items, [candidateId]: updater(items[candidateId]) };
        setSmartItems(items);
      };
      const replaceCandidate = (candidate: BlockStudioImportCandidate) => {
        workingSession = {
          ...workingSession,
          candidates: workingSession.candidates.map((item) => item.id === candidate.id ? candidate : item),
        };
        onSessionChange(workingSession);
      };

      onSessionChange(workingSession);
      setSelectedId(workingSession.candidates[0]?.id ?? null);
      setSmartItems(items);
      await onRefreshSessions();

        setSmartPhase('running');
        workingSession = await waitForDqlImportAnalysis(created.id, (next) => {
          workingSession = next;
          onSessionChange(next);
          for (const candidate of next.candidates) {
            updateItem(candidate.id, (item) => ({
              ...item,
              name: candidate.name,
              sourcePath: candidate.sourcePath,
              status: candidate.analysisStatus === 'needs_attention'
                ? 'needs_attention'
                : candidate.analysisStatus === 'ready'
                  ? 'queued'
                  : 'running',
              message: importAnalysisMessage(candidate.analysisStatus),
            }));
          }
        });
        await mapWithUiConcurrency(workingSession.candidates, 2, async (candidate) => {
          if (candidate.analysisStatus === 'needs_attention') return;
          updateItem(candidate.id, (item) => ({ ...item, status: 'running', message: 'Running preview.' }));
          try {
            const next = await api.previewDqlGenerationCandidate(workingSession.id, candidate.id);
            replaceCandidate(next);
            updateItem(candidate.id, (item) => ({
              ...item,
              name: next.name,
              sourcePath: next.sourcePath,
              status: 'ready',
              rows: rowCountForImportCandidate(next),
              savedPath: next.draftSave?.path ?? next.savedPath,
              message: next.recommendedAction === 'reuse_existing'
                ? 'A governed block already answers this SQL. Reuse it instead of saving a duplicate.'
                : 'Preview ran successfully. Nothing is written until you save.',
            }));
        } catch (err: any) {
          const message = err?.message ?? 'Preview failed.';
          setCandidateErrors((current) => ({ ...current, [candidate.id]: message }));
          updateItem(candidate.id, (item) => ({ ...item, status: 'needs_attention', message }));
          }
        });

        onSessionChange(workingSession);
        setSelectedId(workingSession.candidates.find((candidate) => candidate.reviewStatus !== 'rejected')?.id ?? workingSession.candidates[0]?.id ?? null);
        await onRefreshSessions();
        setSmartPhase('complete');
    } catch (err: any) {
      setError(err?.message ?? 'Import failed.');
      setSmartPhase('idle');
    } finally {
      setLoading(false);
      setSavingAll(false);
    }
  };

    const resumeSession = async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        const next = await api.getDqlGenerationSession(id).catch(() => api.getBlockStudioImport(id));
        onSessionChange(next);
      setSelectedId(next.candidates.find((candidate) => candidate.reviewStatus !== 'saved' && candidate.reviewStatus !== 'rejected')?.id ?? next.candidates[0]?.id ?? null);
      setCandidateErrors({});
      setSmartPhase('complete');
    } catch (err: any) {
      setError(err?.message ?? 'Failed to resume import session.');
    } finally {
      setLoading(false);
    }
  };

  const deleteSession = async (id: string) => {
    setPendingDelete({ kind: 'one', id });
  };

  const clearSessions = async () => {
    if (sessions.length === 0) return;
    setPendingDelete({ kind: 'all' });
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const action = pendingDelete;
    setLoading(true);
    setError(null);
    try {
      if (action.kind === 'one') {
        await api.deleteBlockStudioImport(action.id);
      } else {
        await api.clearBlockStudioImports();
      }
      if (action.kind === 'all' || session?.id === action.id) {
        onSessionChange(null);
        setSelectedId(null);
      }
      setPendingDelete(null);
      await onRefreshSessions();
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update import history.');
    } finally {
      setLoading(false);
    }
  };

  const updateCandidate = (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    onSessionChange({
      ...session,
      candidates: session.candidates.map((item) => item.id === candidate.id ? candidate : item),
    });
    setSmartItems((current) => ({ ...current, [candidate.id]: smartItemFromCandidate(candidate) }));
  };

    const runCandidate = async (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    setLoading(true);
    setError(null);
    setCandidateErrors((current) => {
      if (!current[candidate.id]) return current;
      const next = { ...current };
      delete next[candidate.id];
      return next;
      });
      try {
        const next = isAiGeneratedCandidate(candidate)
          ? await api.previewDqlGenerationCandidate(session.id, candidate.id)
          : await api.runBlockStudioImportCandidate(session.id, candidate.id);
        updateCandidate(next);
      setSelectedId(next.id);
      setCandidateErrors((current) => {
        if (!current[candidate.id]) return current;
        const cleared = { ...current };
        delete cleared[candidate.id];
        return cleared;
      });
    } catch (err: any) {
      const message = err?.message ?? 'Candidate run failed.';
      setError(message);
      setSelectedId(candidate.id);
      setCandidateErrors((current) => ({ ...current, [candidate.id]: message }));
    } finally {
      setLoading(false);
    }
  };

    const saveCandidate = async (candidate: BlockStudioImportCandidate) => {
      if (!session) return;
      const saveOwner = candidate.owner.trim() || owner.trim();
      if (!saveOwner) {
        setError('Owner is required before a block can be saved or certified.');
        return;
      }
      setLoading(true);
      setError(null);
      try {
        if (isAiGeneratedCandidate(candidate)) {
          const response = await api.saveSelectedDqlGenerationCandidates(session.id, { candidateIds: [candidate.id], owner: saveOwner });
          onSessionChange(response.session);
          const result = response.results[0];
          if (!result || result.status === 'error') throw new Error(result?.error ?? result?.blockers.join(' ') ?? 'Candidate save failed.');
          if (result.candidate) updateCandidate(result.candidate);
          if (result.candidate && result.block) onSavedCandidate(result.candidate, result.block);
          if (result.status === 'draft' && result.blockers.length > 0) {
            setError(`Saved as a draft. Before it can be certified: ${result.blockers.join(' ')}`);
          }
        } else {
          const result = await api.saveBlockStudioImportCandidate(session.id, candidate.id);
          updateCandidate(result.candidate);
          onSavedCandidate(result.candidate, result.block);
        }
        await onRefreshSessions();
    } catch (err: any) {
      const message = err?.message ?? 'Candidate save failed.';
      setError(message.includes('409') || message.includes('already exists')
        ? 'A block with this name already exists. Rename this candidate, then save again.'
        : message);
    } finally {
      setLoading(false);
    }
  };

  // The explicit Certify action: runs the certification rules against the
  // saved draft and, only when they pass, certifies it and records who did.
  const certifyCandidate = async (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    if (!(candidate.owner.trim() || owner.trim())) {
      setError('Owner is required before a block can be certified.');
      return;
    }
    setLoading(true);
    setError(null);
    setCertifyFix(null);
    try {
      const response = await api.certifyDqlGenerationCandidate(session.id, candidate.id);
      updateCandidate(response.candidate);
      onSavedCandidate(response.candidate, response.block);
      await onRefreshSessions();
    } catch (err: any) {
      const issues: BlockStudioDiagnostic[] = Array.isArray(err?.details?.issues) ? err.details.issues : [];
      const describedFix = issues.find((issue) => issue.code === 'description_review_required' && issue.suggestedDescription);
      if (describedFix?.suggestedDescription) setCertifyFix({ candidateId: candidate.id, suggestedDescription: describedFix.suggestedDescription });
      const message = issues.length > 0
        ? issues.map((issue) => issue.message).join(' ')
        : err?.message ?? 'Certification failed.';
      setError(`Not certified; the draft is unchanged. ${message}`);
    } finally {
      setLoading(false);
    }
  };

  // One explicit click: write the suggested description, then certify.
  const fixDescriptionAndCertify = async (candidate: BlockStudioImportCandidate, description: string) => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const next = await api.updateDqlGenerationCandidate(session.id, candidate.id, { description });
      updateCandidate(next);
    } catch (err: any) {
      setError(err?.message ?? 'Could not update the description.');
      setLoading(false);
      return;
    }
    setLoading(false);
    await certifyCandidate({ ...candidate, description });
  };

  const saveAll = async () => {
    if (!session) return;
    const saveOwner = owner.trim() || session.defaults.owner.trim();
    if (!saveOwner) {
      setError('Owner is required before blocks can be saved or certified.');
      return;
    }
    setSavingAll(true);
    setError(null);
    try {
      const candidateIds = session.candidates
        .filter((candidate) => candidate.reviewStatus !== 'rejected' && candidate.analysisStatus !== 'needs_attention')
        .map((candidate) => candidate.id);
      const result = await api.saveSelectedDqlGenerationCandidates(session.id, { candidateIds, owner: saveOwner });
      onSessionChange(result.session);
      const errorsByCandidateId = new Map(result.results.filter((item) => item.status === 'error').map((item) => [item.candidateId, item.error ?? item.blockers.join(' ')]));
      const savedByCandidateId = new Map(result.results.filter((item) => item.path).map((item) => [item.candidateId, item.path]));
      setSmartItems(Object.fromEntries(result.session.candidates.map((candidate) => {
        const errorMessage = errorsByCandidateId.get(candidate.id);
        const savedPath = savedByCandidateId.get(candidate.id) ?? candidate.savedPath;
        if (errorMessage) {
          return [candidate.id, {
            ...smartItemFromCandidate(candidate),
            status: 'needs_attention' as const,
            message: errorMessage.includes('409') || errorMessage.includes('already exists')
              ? 'A block with this name already exists. Rename it in advanced details, then save again.'
              : errorMessage,
          }];
        }
        if (savedPath || candidate.reviewStatus === 'saved') {
          return [candidate.id, {
            ...smartItemFromCandidate(candidate),
            status: 'saved' as const,
            savedPath,
            message: importCandidateTrust(candidate) === 'certified' ? 'Certified.' : 'Draft saved · needs review. Certify it when it is ready.',
          }];
        }
        return [candidate.id, smartItemFromCandidate(candidate)];
      })));
      await onRefreshSessions();
      const failedCount = result.results.filter((item) => item.status === 'error').length;
      if (failedCount > 0) {
        setError(`${result.results.length - failedCount} saved as drafts; ${failedCount} need attention. Saving never certifies: review each draft, then click Certify.`);
      }
    } catch (err: any) {
      setError(err?.message ?? 'Save all failed.');
    } finally {
      setSavingAll(false);
    }
  };

  const rejectCandidate = async (candidate: BlockStudioImportCandidate) => {
    if (!session) return;
    const next = await api.updateBlockStudioImportCandidate(session.id, candidate.id, { reviewStatus: 'rejected' });
    updateCandidate(next);
    void onRefreshSessions();
  };

  const handleFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    const sqlFiles = list.filter((file) => file.name.toLowerCase().endsWith('.sql'));
    const sources = await Promise.all(sqlFiles.map(async (file) => ({ path: file.name, content: await file.text() })));
    setUploadSources(sources);
    if (sources.length > 0) setPath('');
  };

  return (
    <div style={{ position: 'relative', height: '100%', display: 'grid', gridTemplateRows: '80px minmax(0, 1fr)', minHeight: 0, background: t.appBg, borderRadius: inline ? 0 : 8 }}>
      <header style={{ borderBottom: `1px solid ${t.headerBorder}`, background: t.cellBg, padding: '14px 14px 12px', display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 260 }}>
          <span style={{ width: 34, height: 34, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: t.accent, background: `${t.accent}16`, flexShrink: 0 }}>
            <Sparkles size={17} strokeWidth={2} aria-hidden="true" />
          </span>
          <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>Import SQL to DQL</span>
            <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              SQL source to AI-grounded drafts to review and certify
            </span>
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(130px, 1fr))', gap: 6, width: 'min(560px, 44vw)', minWidth: 390 }}>
          <ImportStep index={1} active={activeStep === 1} complete={Boolean(session)} title="Source" detail={mode === 'paste' ? 'Paste SQL' : mode === 'upload' ? 'Upload files' : 'Local path'} t={t} />
          <ImportStep index={2} active={activeStep === 2} complete={smartCounts.ready > 0 || smartCounts.saved > 0} title="Draft" detail={session ? `${session.candidates.length} blocks · ${readyCount} ready` : 'Generate DQL'} t={t} />
          <ImportStep index={3} active={activeStep === 3} complete={certifiedCount > 0} title="Review" detail={certifiedCount > 0 ? `${certifiedCount} certified` : draftSavedCount > 0 ? `${draftSavedCount} draft${draftSavedCount === 1 ? '' : 's'} saved · certify next` : 'Preview and certify'} t={t} />
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={onClose}
          title="Close import"
          aria-label="Close import"
          style={{ ...secondaryImportButtonStyle(t), width: 32, height: 32, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
        >
          <X size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      <div style={{ minHeight: 0, display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)' }}>
        <aside style={{ borderRight: `1px solid ${t.headerBorder}`, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', minHeight: 0, background: t.cellBg }}>
          <section style={{ borderBottom: `1px solid ${t.headerBorder}`, padding: 12, display: 'grid', gap: 10 }}>
            <button
              onClick={() => setSourceOpen((open) => !open)}
              style={{ background: 'transparent', border: 'none', color: t.textPrimary, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: 0, fontFamily: t.font, textAlign: 'left' }}
            >
              <FileInput size={14} strokeWidth={2} color={t.accent} aria-hidden="true" />
              <span style={{ fontSize: 12, fontWeight: 800, flex: 1 }}>Source</span>
              {session && <span style={{ fontSize: 10, color: t.textMuted }}>{sourceOpen ? 'Hide' : 'Edit'}</span>}
            </button>
            {sourceOpen ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 4 }}>
                  {(['paste', 'upload', 'path'] as const).map((value) => (
                    <button
                      key={value}
                      onClick={() => setMode(value)}
                      style={{
                        ...secondaryImportButtonStyle(t),
                        padding: '6px 4px',
                        color: mode === value ? t.accent : t.textSecondary,
                        borderColor: mode === value ? t.accent : t.btnBorder,
                        background: mode === value ? `${t.accent}14` : t.btnBg,
                      }}
                    >
                      {value === 'paste' ? 'Paste SQL' : value === 'upload' ? 'Upload files' : 'Local path'}
                    </button>
                  ))}
                </div>
                {mode === 'path' && (
                    <FieldLabel label="Path" t={t}>
                      <input
                        value={path}
                        onChange={(event) => {
                          setPath(event.target.value);
                          if (event.target.value.trim()) setUploadSources([]);
                        }}
                        placeholder="./queries or ./legacy.sql"
                        style={importInputStyle(t)}
                      />
                    </FieldLabel>
                )}
                {mode === 'upload' && (
                    <FieldLabel label="Upload SQL files" t={t}>
                      <input type="file" multiple accept=".sql,text/sql,text/plain" onChange={(event) => void handleFiles(event.target.files)} style={importInputStyle(t)} />
                      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
                        {uploadSources.length > 0 ? `${uploadSources.length} SQL file(s) ready` : 'Choose one or more SQL files.'}
                      </span>
                    </FieldLabel>
                )}
                {mode === 'paste' && (
                  <FieldLabel label="Paste SQL" t={t}>
                    <textarea value={pasteSql} onChange={(event) => setPasteSql(event.target.value)} placeholder="select ...; go&#10;select ..." style={{ ...importInputStyle(t), minHeight: session ? 86 : 150, resize: 'vertical', fontFamily: t.fontMono }} />
                  </FieldLabel>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <FieldLabel label="Domain" t={t}>
                    <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="auto" style={importInputStyle(t)} />
                  </FieldLabel>
                  <FieldLabel label="Owner" t={t}>
                    <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="analytics" style={importInputStyle(t)} />
                  </FieldLabel>
                </div>
                <button
                  onClick={() => void runSmartImport()}
                  disabled={loading || !sourceReady}
                  style={{ ...primaryImportButtonStyle(t), padding: '8px 12px', opacity: loading || !sourceReady ? 0.65 : 1, cursor: loading || !sourceReady ? 'not-allowed' : 'pointer' }}
                >
                  {loading ? smartImportPhaseLabel(smartPhase) : 'Generate DQL drafts'}
                </button>
                <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.45 }}>
                  Uses dbt, MetricFlow, warehouse catalog, and existing DQL context when available.
                </div>
              </>
            ) : (
              <button
                onClick={() => setSourceOpen(true)}
                style={{ ...secondaryImportButtonStyle(t), display: 'grid', gap: 4, textAlign: 'left', width: '100%', justifyItems: 'start' }}
              >
                <span style={{ fontSize: 11, color: t.textSecondary }}>{mode === 'paste' ? 'Pasted SQL' : mode === 'upload' ? 'Uploaded files' : 'Local path'}</span>
                <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.textMuted, fontFamily: t.fontMono }}>
                  {session?.inputPath ?? (mode === 'paste' ? 'pasted.sql' : mode === 'upload' ? `${uploadSources.length} file(s)` : path || './queries')}
                </span>
              </button>
            )}
          </section>

          <section style={{ minHeight: 0, overflow: 'auto', padding: 12, display: 'grid', alignContent: 'start', gap: 10 }}>
            {!session ? (
              <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.5 }}>
                Paste SQL, upload files, or choose a local path. Analysis stays in this session until you save a block.
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>Drafts</span>
                    <ImportPill label={`${session.candidates.length}`} tone="info" t={t} />
                    {smartCounts.ready > 0 && <ImportPill label={`${smartCounts.ready} ready`} tone="ok" t={t} />}
                    {smartCounts.attention > 0 && <ImportPill label={`${smartCounts.attention} attention`} tone="warn" t={t} />}
                  </div>
                  {session.candidates.length > 6 && (
                    <input
                      value={candidateSearch}
                      onChange={(event) => setCandidateSearch(event.target.value)}
                      placeholder="Search drafts, tables, files..."
                      style={importInputStyle(t)}
                    />
                  )}
                </div>
                {visibleCandidates.map((candidate) => {
                  const selected = candidate.id === selectedCandidate?.id;
                  const warnings = candidate.warnings ?? candidate.lineage.warnings;
                  const runError = candidateErrors[candidate.id];
                  const rowCount = candidate.preview?.result?.rowCount ?? candidate.preview?.result?.rows?.length;
                  const item = smartItems[candidate.id] ?? smartItemFromCandidate(candidate);
                  return (
                    <button
                      key={candidate.id}
                      onClick={() => {
                        setSelectedId(candidate.id);
                      }}
                      style={{
                        border: `1px solid ${selected ? t.accent : runError ? '#f8514955' : t.headerBorder}`,
                        borderRadius: 8,
                        background: selected ? `${t.accent}10` : t.appBg,
                        color: t.textPrimary,
                        padding: 10,
                        display: 'grid',
                        gap: 6,
                        textAlign: 'left',
                        cursor: 'pointer',
                        minWidth: 0,
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ minWidth: 0, flex: 1, fontSize: 12, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{candidate.name}</span>
                        <ImportPill label={smartImportStatusLabel(item.status)} tone={smartImportStatusTone(item.status)} t={t} />
                      </span>
                      <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono, overflowWrap: 'anywhere' }}>
                        {candidate.lineage.statementIndex}/{candidate.lineage.totalStatements} · {candidate.sourcePath}
                      </span>
                      <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        <ImportPill label={importCandidateTrust(candidate) === 'certified' ? 'certified' : importCandidateTrust(candidate) === 'draft_saved' ? 'draft saved' : candidate.reviewStatus} tone={candidate.reviewStatus === 'rejected' ? 'warn' : importCandidateTrust(candidate) === 'certified' ? 'ok' : 'info'} t={t} />
                        <ImportPill label={candidate.validation?.valid === false ? 'fix' : 'valid'} tone={candidate.validation?.valid === false ? 'warn' : 'ok'} t={t} />
                        {typeof rowCount === 'number' && <ImportPill label={`${rowCount} rows`} tone="ok" t={t} />}
                        {warnings.length > 0 && <ImportPill label={`${warnings.length} warning`} tone="warn" t={t} />}
                      </span>
                      {(runError || item.message) && (
                        <span style={{ fontSize: 11, color: runError ? '#f85149' : t.textMuted, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
                          {runError ?? item.message}
                        </span>
                      )}
                    </button>
                  );
                })}
                {!showAllCandidates && !candidateSearch.trim() && candidateMatches.length > 10 && (
                  <button onClick={() => setShowAllCandidates(true)} style={secondaryImportButtonStyle(t)}>
                    Show all {candidateMatches.length} drafts
                  </button>
                )}
                {!session.candidates.some(isAiGeneratedCandidate) && smartCounts.ready > 0 && (
                  <button onClick={() => void saveAll()} disabled={savingAll} style={primaryImportButtonStyle(t)}>{savingAll ? 'Saving...' : 'Save valid blocks'}</button>
                )}
              </>
            )}
          </section>

          <details open={historyOpen} onToggle={(event) => setHistoryOpen((event.currentTarget as HTMLDetailsElement).open)} style={{ borderTop: `1px solid ${t.headerBorder}`, padding: 12, display: 'grid', gap: 8 }}>
            <summary style={{ cursor: 'pointer', color: t.textSecondary, fontSize: 11, fontWeight: 800, fontFamily: t.font }}>
              Import history{sessions.length > 0 ? ` (${sessions.length})` : ''}
            </summary>
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => void onRefreshSessions()} style={secondaryImportButtonStyle(t)}>Refresh</button>
                {sessions.length > 0 && <button onClick={() => void clearSessions()} style={secondaryImportButtonStyle(t)}>Clear</button>}
              </div>
              {sessionsLoading ? (
                <div style={{ fontSize: 12, color: t.textMuted }}>Loading...</div>
              ) : sessions.length === 0 ? (
                <div style={{ fontSize: 12, color: t.textMuted }}>No saved import sessions.</div>
              ) : (
                <div style={{ display: 'grid', gap: 6, maxHeight: 140, overflow: 'auto' }}>
                  {sessions.slice(0, 6).map((item) => (
                    <div key={item.id} style={{ border: `1px solid ${session?.id === item.id ? t.accent : t.btnBorder}`, borderRadius: 8, background: session?.id === item.id ? `${t.accent}10` : t.btnBg, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', overflow: 'hidden' }}>
                      <button onClick={() => void resumeSession(item.id)} style={{ background: 'transparent', border: 'none', color: t.textSecondary, cursor: 'pointer', fontFamily: t.font, padding: '8px 9px', textAlign: 'left', display: 'grid', gap: 3, minWidth: 0 }}>
                        <span style={{ fontSize: 11 }}>{item.candidateCount} candidates · {item.savedCount} saved</span>
                        <span style={{ fontSize: 10, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.inputPath}</span>
                      </button>
                      <button onClick={() => void deleteSession(item.id)} title="Delete local import session" style={{ background: 'transparent', border: 'none', borderLeft: `1px solid ${t.headerBorder}`, color: t.textMuted, cursor: 'pointer', fontFamily: t.font, padding: '0 8px', fontSize: 11, fontWeight: 700 }}>
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </details>
        </aside>

        <main style={{ minWidth: 0, minHeight: 0, overflow: 'auto', padding: 20, background: t.appBg }}>
          {error && (
            <div role="alert" style={{ padding: '10px 12px', color: '#f85149', background: '#f8514914', border: `1px solid #f8514933`, borderRadius: 8, marginBottom: 12, fontSize: 12 }}>
              {error}
            </div>
          )}
          {session && selectedCandidate && certifyFix?.candidateId === selectedCandidate.id && (
            <div role="status" style={{ padding: '10px 12px', border: `1px solid ${t.accent}55`, background: `${t.accent}0d`, borderRadius: 8, marginBottom: 12, display: 'grid', gap: 8, fontSize: 12, color: t.textSecondary, lineHeight: 1.45 }}>
              <div>
                Certifying is the review, so the description should say what the block returns, not that it needs review. The description becomes:
              </div>
              <div style={{ color: t.textPrimary, fontWeight: 700 }}>{certifyFix.suggestedDescription}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  onClick={() => void fixDescriptionAndCertify(selectedCandidate, certifyFix.suggestedDescription)}
                  disabled={loading}
                  style={primaryImportButtonStyle(t)}
                >
                  Remove "review required" from the description and certify
                </button>
                <button onClick={() => setCertifyFix(null)} style={secondaryImportButtonStyle(t)}>Edit the description myself</button>
              </div>
            </div>
          )}
          {!session || !selectedCandidate ? (
            <ImportGuide t={t} />
          ) : (
            <ImportCandidateDetail
              session={session}
              candidate={selectedCandidate}
              loading={loading}
              onCandidateUpdated={updateCandidate}
              onRun={runCandidate}
              onSave={saveCandidate}
              onCertify={certifyCandidate}
              onReject={rejectCandidate}
              onReviewInEditor={onSelectCandidate}
              runError={candidateErrors[selectedCandidate.id] ?? null}
              themeMode={themeMode}
              t={t}
            />
          )}
        </main>
      </div>
      {pendingDelete && (
        <ImportConfirmPanel
          t={t}
          busy={loading}
          title={pendingDelete.kind === 'all' ? 'Clear import history?' : 'Delete import preview?'}
          message={pendingDelete.kind === 'all'
            ? `This removes ${sessions.length} local import preview${sessions.length === 1 ? '' : 's'} from .dql/imports. Saved blocks stay in the project.`
            : 'This removes the selected local import preview from .dql/imports. Saved blocks stay in the project.'}
          confirmLabel={pendingDelete.kind === 'all' ? 'Clear history' : 'Delete preview'}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
  );
}

function ImportConfirmPanel({
  title,
  message,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
  t,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  t: Theme;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.22)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 20,
      }}
    >
      <div
        style={{
          width: 'min(420px, 92vw)',
          background: t.cellBg,
          color: t.textPrimary,
          border: `1px solid ${t.headerBorder}`,
          borderRadius: 8,
          boxShadow: '0 18px 48px rgba(0, 0, 0, 0.30)',
          padding: 16,
          display: 'grid',
          gap: 12,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 800, fontFamily: t.font }}>{title}</div>
        <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.5, fontFamily: t.font }}>{message}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} disabled={busy} style={secondaryImportButtonStyle(t)}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={{ ...primaryImportButtonStyle(t), opacity: busy ? 0.65 : 1 }}>
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function SmartImportOverview({
  session,
  items,
  counts,
  phase,
  onShowAdvanced,
  onSelectItem,
  t,
}: {
  session: BlockStudioImportSession;
  items: SmartImportItem[];
  counts: SmartImportCounts;
  phase: SmartImportPhase;
  onShowAdvanced: () => void;
  onSelectItem: (id: string) => void;
  t: Theme;
}) {
  const total = items.length || session.candidates.length;
  const orderedItems = [...items].sort((left, right) => {
    const priority: Record<SmartImportItemStatus, number> = {
      needs_attention: 0,
      running: 1,
      saving: 2,
      queued: 3,
      ready: 4,
      saved: 5,
    };
    return priority[left.status] - priority[right.status] || left.name.localeCompare(right.name);
  });
    const headline = counts.attention > 0
      ? `${counts.ready} ready, ${counts.attention} need attention`
      : counts.processing > 0
        ? smartImportPhaseLabel(phase)
        : counts.ready > 0
          ? `${counts.ready} draft${counts.ready === 1 ? '' : 's'} ready for review`
          : `${counts.saved} DQL block${counts.saved === 1 ? '' : 's'} saved`;
    const detail = counts.attention > 0
      ? 'Ready candidates remain in this session. Fix the exceptions in advanced details before saving.'
      : counts.processing > 0
        ? 'ZLens is previewing SQL and keeping generated drafts saved.'
        : counts.ready > 0
          ? 'Generated DQL drafts are saved under blocks/_drafts or domains/<domain>/blocks/_drafts. Open a candidate to review, preview, and certify.'
          : 'Saved drafts stay drafts until someone clicks Certify; certified blocks move to the canonical blocks folder.';

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <PanelBox title="Import Summary" t={t}>
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: t.textPrimary, fontFamily: t.font }}>{headline}</div>
              <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font, lineHeight: 1.45, marginTop: 4 }}>{detail}</div>
              <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, overflowWrap: 'anywhere', marginTop: 6 }}>
                Source: {session.inputPath}
              </div>
            </div>
            <ImportPill label={`${total} found`} tone="info" t={t} />
            <ImportPill label={smartImportPhaseLabel(phase)} tone={counts.attention > 0 ? 'warn' : 'ok'} t={t} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(110px, 1fr))', gap: 8 }}>
              <SmartCount label="Certified" value={counts.saved} tone="ok" t={t} />
            <SmartCount label="Ready" value={counts.ready} tone="ok" t={t} />
            <SmartCount label="Needs attention" value={counts.attention} tone="warn" t={t} />
            <SmartCount label="Processing" value={counts.processing} tone="info" t={t} />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={onShowAdvanced} style={counts.attention > 0 ? primaryImportButtonStyle(t) : secondaryImportButtonStyle(t)}>
              {counts.attention > 0 ? 'Fix exceptions' : 'Open advanced details'}
            </button>
          </div>
        </div>
      </PanelBox>

      <PanelBox title="Blocks" t={t}>
        {orderedItems.length === 0 ? (
          <EmptyPanel message="Import status will appear here." />
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {orderedItems.slice(0, 40).map((item) => (
              <button
                key={item.id}
                onClick={() => onSelectItem(item.id)}
                style={{
                  border: `1px solid ${item.status === 'needs_attention' ? '#d2992255' : t.headerBorder}`,
                  borderRadius: 8,
                  background: item.status === 'needs_attention' ? '#d299220f' : t.appBg,
                  color: t.textPrimary,
                  padding: 11,
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  gap: 8,
                  textAlign: 'left',
                  cursor: 'pointer',
                  alignItems: 'start',
                }}
              >
                <span style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: t.textPrimary, fontFamily: t.font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                  <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono, overflowWrap: 'anywhere' }}>{item.savedPath ?? item.sourcePath}</span>
                  {item.message && (
                    <span style={{ fontSize: 11, color: item.status === 'needs_attention' ? '#d29922' : t.textMuted, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
                      {item.message}
                    </span>
                  )}
                </span>
                <span style={{ display: 'grid', justifyItems: 'end', gap: 5 }}>
                  <ImportPill label={smartImportStatusLabel(item.status)} tone={smartImportStatusTone(item.status)} t={t} />
                  {item.rows !== undefined && <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>{item.rows} rows</span>}
                </span>
              </button>
            ))}
            {orderedItems.length > 40 && (
              <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>
                {orderedItems.length - 40} more block(s). Open advanced details to search the full list.
              </div>
            )}
          </div>
        )}
      </PanelBox>
    </div>
  );
}

export function ImportCandidateDetail({
  session,
  candidate,
  loading,
  onCandidateUpdated,
  onRun,
  onSave,
  onCertify,
  onReject,
  onReviewInEditor,
  runError,
  themeMode,
  initialContextOpen = false,
  t,
}: {
  session: BlockStudioImportSession;
  candidate: BlockStudioImportCandidate;
  loading: boolean;
  onCandidateUpdated: (candidate: BlockStudioImportCandidate) => void;
  onRun: (candidate: BlockStudioImportCandidate) => Promise<void>;
  onSave: (candidate: BlockStudioImportCandidate) => Promise<void>;
  onCertify: (candidate: BlockStudioImportCandidate) => Promise<void>;
  onReject: (candidate: BlockStudioImportCandidate) => Promise<void>;
  onReviewInEditor: (candidate: BlockStudioImportCandidate) => void;
  runError?: string | null;
  themeMode: ThemeMode;
  /** Whether "Show context" starts open. */
  initialContextOpen?: boolean;
  t: Theme;
}) {
  const [name, setName] = useState(candidate.name);
  const [domain, setDomain] = useState(candidate.domain);
  const [owner, setOwner] = useState(candidate.owner);
  const [description, setDescription] = useState(candidate.description);
  const [tags, setTags] = useState(candidate.tags.join(', '));
  const [terms, setTerms] = useState((candidate.terms ?? []).join(', '));
  const [pattern, setPattern] = useState(candidate.pattern || 'custom');
  const [grain, setGrain] = useState(candidate.grain ?? '');
  const [entities, setEntities] = useState((candidate.entities ?? []).join(', '));
  const [outputs, setOutputs] = useState((candidate.outputs ?? []).join(', '));
  const [dimensions, setDimensions] = useState((candidate.dimensions ?? []).join(', '));
  const [allowedFilters, setAllowedFilters] = useState((candidate.allowedFilters ?? []).join(', '));
  const [sourceSystems, setSourceSystems] = useState((candidate.sourceSystems ?? []).join(', '));
  const [replacementFor, setReplacementFor] = useState((candidate.replacementFor ?? []).join(', '));
  const [reviewCadence, setReviewCadence] = useState(candidate.reviewCadence ?? 'monthly');
  const [sql, setSql] = useState(candidate.sql);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(initialContextOpen);

  useEffect(() => {
    setName(candidate.name);
    setDomain(candidate.domain);
    setOwner(candidate.owner);
    setDescription(candidate.description);
    setTags(candidate.tags.join(', '));
    setTerms((candidate.terms ?? []).join(', '));
    setPattern(candidate.pattern || 'custom');
    setGrain(candidate.grain ?? '');
    setEntities((candidate.entities ?? []).join(', '));
    setOutputs((candidate.outputs ?? []).join(', '));
    setDimensions((candidate.dimensions ?? []).join(', '));
    setAllowedFilters((candidate.allowedFilters ?? []).join(', '));
    setSourceSystems((candidate.sourceSystems ?? []).join(', '));
    setReplacementFor((candidate.replacementFor ?? []).join(', '));
    setReviewCadence(candidate.reviewCadence ?? 'monthly');
    setSql(candidate.sql);
    setEditError(null);
    setContextOpen(false);
  }, [candidate.id, candidate.name, candidate.domain, candidate.owner, candidate.description, candidate.tags, candidate.terms, candidate.pattern, candidate.grain, candidate.entities, candidate.outputs, candidate.dimensions, candidate.allowedFilters, candidate.sourceSystems, candidate.replacementFor, candidate.reviewCadence, candidate.sql]);

  const listOf = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
  const sameList = (value: string, list: string[] | undefined) => listOf(value).join('\u0000') === (list ?? []).join('\u0000');
  // What the person sees in the fields is what gets saved: a field that
  // differs from the candidate is a pending edit, applied before any action.
  const editsPending = name !== candidate.name
    || domain !== candidate.domain
    || owner !== candidate.owner
    || description !== candidate.description
    || !sameList(tags, candidate.tags)
    || !sameList(terms, candidate.terms)
    || pattern !== (candidate.pattern || 'custom')
    || grain !== (candidate.grain ?? '')
    || !sameList(entities, candidate.entities)
    || !sameList(outputs, candidate.outputs)
    || !sameList(dimensions, candidate.dimensions)
    || !sameList(allowedFilters, candidate.allowedFilters)
    || !sameList(sourceSystems, candidate.sourceSystems)
    || !sameList(replacementFor, candidate.replacementFor)
    || reviewCadence !== (candidate.reviewCadence ?? 'monthly')
    || sql !== candidate.sql;

    const saveEdits = async (): Promise<BlockStudioImportCandidate | null> => {
      setEditError(null);
      try {
        const patch = {
          name,
          domain,
          owner,
          description,
          tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
          terms: terms.split(',').map((value) => value.trim()).filter(Boolean),
          pattern,
          grain,
          entities: entities.split(',').map((value) => value.trim()).filter(Boolean),
          outputs: outputs.split(',').map((value) => value.trim()).filter(Boolean),
          dimensions: dimensions.split(',').map((value) => value.trim()).filter(Boolean),
          allowedFilters: allowedFilters.split(',').map((value) => value.trim()).filter(Boolean),
          sourceSystems: sourceSystems.split(',').map((value) => value.trim()).filter(Boolean),
          replacementFor: replacementFor.split(',').map((value) => value.trim()).filter(Boolean),
          reviewCadence,
          sql,
          llmContext: candidate.llmContext,
        };
        const next = isAiGeneratedCandidate(candidate)
          ? await api.updateDqlGenerationCandidate(session.id, candidate.id, patch)
          : await api.updateBlockStudioImportCandidate(session.id, candidate.id, patch);
        onCandidateUpdated(next);
        return next;
    } catch (err: any) {
      setEditError(err?.message ?? 'Could not update candidate.');
      return null;
    }
  };

  // Save draft, Certify and Edit full DQL act on the fields as shown: pending
  // edits are applied first, so validation reads the current values.
  const withEditsApplied = async (action: (next: BlockStudioImportCandidate) => unknown) => {
    if (!editsPending) {
      await action(candidate);
      return;
    }
    const next = await saveEdits();
    if (next) await action(next);
  };

  const assist = async (action: string) => {
    setAiBusy(action);
    setEditError(null);
    try {
      const next = await api.assistBlockStudioImportCandidate(session.id, candidate.id, action);
      onCandidateUpdated(next);
    } catch (err: any) {
      setEditError(err?.message ?? 'AI assist failed.');
    } finally {
      setAiBusy(null);
    }
  };

    const warnings = candidate.warnings ?? candidate.lineage.warnings;
    const inputStyle = importInputStyle(t);
    const previewRowCount = candidate.preview?.result?.rowCount ?? candidate.preview?.result?.rows?.length;
    const draftPath = candidate.draftSave?.path ?? (isDraftBlockPath(candidate.savedPath) ? candidate.savedPath : undefined);
    const reuseRecommended = candidate.recommendedAction === 'reuse_existing' || candidate.draftSave?.status === 'skipped';
    const trust = importCandidateTrust(candidate);
    const contextCount = candidate.lineage.sourceTables.length + (candidate.evidence?.length ?? 0) + candidate.lineage.parameters.length + warnings.length;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: t.textPrimary }}>{candidate.name}</div>
          <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, marginTop: 3 }}>{candidate.sourcePath} · statement {candidate.lineage.statementIndex}/{candidate.lineage.totalStatements}</div>
        </div>
        <button onClick={() => void onRun(candidate)} disabled={loading} style={secondaryImportButtonStyle(t)}>{loading ? 'Running...' : 'Preview'}</button>
        <button onClick={() => setContextOpen((open) => !open)} style={contextOpen ? primaryImportButtonStyle(t) : secondaryImportButtonStyle(t)}>
          {contextOpen ? 'Hide context' : `Show context${contextCount > 0 ? ` (${contextCount})` : ''}`}
        </button>
        <button onClick={() => void withEditsApplied(onReviewInEditor)} style={primaryImportButtonStyle(t)}>Edit full DQL</button>
        {/* Save writes a draft; Certify is the separate, explicit trust action. */}
        <button onClick={() => void withEditsApplied(onSave)} disabled={loading || trust === 'certified' || reuseRecommended} style={trust === 'draft_saved' && !editsPending ? secondaryImportButtonStyle(t) : primaryImportButtonStyle(t)}>{reuseRecommended ? 'Reuse existing' : trust === 'certified' ? 'Saved' : trust === 'draft_saved' ? 'Save draft again' : 'Save draft'}</button>
        {isAiGeneratedCandidate(candidate) && !reuseRecommended && (
          <button
            onClick={() => void withEditsApplied(onCertify)}
            disabled={loading || trust !== 'draft_saved'}
            title={trust === 'certified' ? 'Certified' : trust === 'unsaved' ? 'Save the draft first, then certify it.' : 'Run the certification rules and certify this block as its reviewer.'}
            style={trust === 'draft_saved' ? primaryImportButtonStyle(t) : secondaryImportButtonStyle(t)}
          >
            {trust === 'certified' ? 'Certified' : 'Certify'}
          </button>
        )}
      </div>

      {editsPending && (
        <div role="status" style={{ fontSize: 12, color: t.textSecondary, background: `${t.accent}10`, border: `1px solid ${t.accent}40`, borderRadius: 8, padding: '8px 10px', lineHeight: 1.45 }}>
          You changed the review details. Save draft, Certify and Edit full DQL use the values shown.
        </div>
      )}
      {editError && <div role="alert" style={{ fontSize: 12, color: '#f85149', background: '#f8514914', borderRadius: 8, padding: 10 }}>{editError}</div>}
      {runError && (
        <div role="alert" style={{ fontSize: 12, color: '#f85149', background: '#f8514914', border: `1px solid #f8514933`, borderRadius: 8, padding: 10, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
          Preview failed: {runError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <ImportPill label={candidate.draftSave?.status === 'skipped' ? 'reuse recommended' : trust === 'certified' ? 'certified' : trust === 'draft_saved' ? 'draft saved · needs review' : candidate.reviewStatus} tone={candidate.reviewStatus === 'rejected' ? 'warn' : candidate.draftSave?.status === 'skipped' || trust === 'certified' ? 'ok' : 'info'} t={t} />
        <ImportPill label={`${Math.round(candidate.confidence * 100)}% confidence`} tone="info" t={t} />
        <ImportPill label={candidate.validation?.valid === false ? 'needs fixes' : 'valid'} tone={candidate.validation?.valid === false ? 'warn' : 'ok'} t={t} />
        {typeof previewRowCount === 'number' && <ImportPill label={`${previewRowCount} rows`} tone="ok" t={t} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: contextOpen ? 'minmax(0, 1fr) minmax(320px, 380px)' : 'minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 12 }}>
          <PanelBox title="Review details" t={t}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <FieldLabel label="Name" t={t}><input value={name} onChange={(event) => setName(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Domain" t={t}><input value={domain} onChange={(event) => setDomain(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Owner" t={t}><input value={owner} onChange={(event) => setOwner(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Tags" t={t}><textarea value={tags} onChange={(event) => setTags(event.target.value)} style={{ ...inputStyle, minHeight: 58, resize: 'vertical' }} /></FieldLabel>
            </div>
            <FieldLabel label="Business description" t={t}><textarea value={description} onChange={(event) => setDescription(event.target.value)} style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} /></FieldLabel>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
              <FieldLabel label="Pattern" t={t}>
                <select value={pattern} onChange={(event) => setPattern(event.target.value)} style={inputStyle}>
                  {['custom', 'metric_wrapper', 'entity_profile', 'entity_rollup', 'ranking', 'trend', 'bridge', 'drilldown', 'replacement'].map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </FieldLabel>
              <FieldLabel label="Grain" t={t}><input value={grain} onChange={(event) => setGrain(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Review cadence" t={t}>
                <select value={reviewCadence} onChange={(event) => setReviewCadence(event.target.value)} style={inputStyle}>
                  {['weekly', 'monthly', 'quarterly', 'semiannual', 'annual'].map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </FieldLabel>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <FieldLabel label="Entities" t={t}><input value={entities} onChange={(event) => setEntities(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Outputs" t={t}><input value={outputs} onChange={(event) => setOutputs(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Dimensions" t={t}><input value={dimensions} onChange={(event) => setDimensions(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Allowed filters" t={t}><input value={allowedFilters} onChange={(event) => setAllowedFilters(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Source systems" t={t}><input value={sourceSystems} onChange={(event) => setSourceSystems(event.target.value)} style={inputStyle} /></FieldLabel>
              <FieldLabel label="Terms" t={t}><input value={terms} onChange={(event) => setTerms(event.target.value)} style={inputStyle} /></FieldLabel>
            </div>
            <FieldLabel label="Replaces" t={t}><input value={replacementFor} onChange={(event) => setReplacementFor(event.target.value)} style={inputStyle} /></FieldLabel>
            <button onClick={() => void saveEdits()} disabled={!editsPending} style={{ ...(editsPending ? primaryImportButtonStyle(t) : secondaryImportButtonStyle(t)), justifySelf: 'start' }}>{editsPending ? 'Apply edits' : 'Edits applied'}</button>
          </PanelBox>

          {candidate.preview && (
            <PanelBox title="Preview Results" t={t}>
              <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.45 }}>
                Query ran successfully{typeof previewRowCount === 'number' ? ` and returned ${previewRowCount} rows` : ''}.
              </div>
              <div style={{ maxHeight: 320, overflow: 'auto', border: `1px solid ${t.headerBorder}`, borderRadius: 8 }}>
                <TableOutput result={candidate.preview.result} themeMode={themeMode} />
              </div>
            </PanelBox>
          )}

          <details style={importDisclosureStyle(t)}>
            <summary style={importSummaryStyle(t)}>Original SQL</summary>
            <textarea value={sql} onChange={(event) => setSql(event.target.value)} style={{ ...inputStyle, minHeight: 210, fontFamily: t.fontMono, resize: 'vertical', marginTop: 10 }} />
          </details>

          <details style={importDisclosureStyle(t)}>
            <summary style={importSummaryStyle(t)}>Draft DQL block</summary>
            <pre style={{ margin: '10px 0 0', whiteSpace: 'pre-wrap', fontSize: 11, lineHeight: 1.45, color: t.textSecondary, fontFamily: t.fontMono }}>{candidate.dqlSource}</pre>
          </details>
        </div>

        {contextOpen && (
        <div style={{ display: 'grid', gap: 12 }}>
          {((candidate.similarityMatches?.length ?? 0) > 0 || candidate.draftSave?.status === 'skipped') && (
            <PanelBox title="Reuse recommendation" t={t}>
              <div style={{ display: 'grid', gap: 8 }}>
                <InfoLine label="Action" value={candidate.recommendedAction ?? 'create_new'} t={t} />
                {candidate.draftSave?.reason && <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.4 }}>{candidate.draftSave.reason}</div>}
                {(candidate.similarityMatches ?? []).slice(0, 3).map((match, index) => (
                  <div key={`${match.objectKey ?? match.name}-${index}`} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 7, padding: 8, background: t.appBg }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: t.textSecondary, overflowWrap: 'anywhere' }}>{match.name}</div>
                    <div style={{ fontSize: 10, color: t.textMuted, marginTop: 3 }}>{match.kind} · {Math.round(match.score * 100)}% · {match.recommendedAction}</div>
                    <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35, marginTop: 5 }}>{match.reason}</div>
                  </div>
                ))}
              </div>
            </PanelBox>
          )}

          {((candidate.parameterDecisions?.length ?? 0) > 0 || (candidate.filterBindings?.length ?? 0) > 0) && (
            <PanelBox title="Parameter contract" t={t}>
              <div style={{ display: 'grid', gap: 8 }}>
                {(candidate.parameterDecisions ?? []).slice(0, 8).map((decision) => (
                  <div key={decision.name} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 7, padding: 8, background: t.appBg }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 800, color: t.textSecondary }}>{decision.name}</span>
                      <span style={{ fontSize: 10, color: t.textMuted }}>{decision.policy}</span>
                    </div>
                    <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35, marginTop: 5 }}>{decision.sourceExpression} = {String(decision.value)}</div>
                    <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35, marginTop: 5 }}>{decision.reason}</div>
                  </div>
                ))}
                {(candidate.filterBindings ?? []).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {(candidate.filterBindings ?? []).map((binding) => (
                      <ImportPill key={binding.filter} label={`${binding.filter} -> ${binding.binding}`} tone="info" t={t} />
                    ))}
                  </div>
                )}
              </div>
            </PanelBox>
          )}

          <PanelBox title="Grounding" t={t}>
            <div style={{ display: 'grid', gap: 5 }}>
              <div style={{ fontSize: 10, color: t.textMuted, textTransform: 'uppercase', fontWeight: 800 }}>Source tables</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {candidate.lineage.sourceTables.length ? candidate.lineage.sourceTables.map((table) => <ImportPill key={table} label={table} tone="info" t={t} />) : <span style={{ fontSize: 12, color: t.textMuted }}>None detected</span>}
              </div>
            </div>
            {(candidate.evidence ?? []).length > 0 && (
              <div style={{ display: 'grid', gap: 6 }}>
                <div style={{ fontSize: 10, color: t.textMuted, textTransform: 'uppercase', fontWeight: 800 }}>Context used</div>
                {(candidate.evidence ?? []).slice(0, 5).map((item, index) => (
                  <div key={`${item.objectKey ?? item.name}-${index}`} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 7, padding: 8, background: t.appBg }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: t.textSecondary, overflowWrap: 'anywhere' }}>{item.name}</div>
                    <div style={{ fontSize: 10, color: t.textMuted, marginTop: 3 }}>{item.kind}{item.reason ? ` · ${item.reason}` : ''}</div>
                    {item.description && (
                      <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.35, marginTop: 5 }}>{item.description}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'grid', gap: 5 }}>
              <div style={{ fontSize: 10, color: t.textMuted, textTransform: 'uppercase', fontWeight: 800 }}>Parameters</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {candidate.lineage.parameters.length ? candidate.lineage.parameters.map((param) => <ImportPill key={param} label={param} tone="warn" t={t} />) : <span style={{ fontSize: 12, color: t.textMuted }}>None detected</span>}
              </div>
            </div>
            {warnings.length > 0 && (
              <div style={{ display: 'grid', gap: 6 }}>
                <div style={{ fontSize: 10, color: '#d29922', textTransform: 'uppercase', fontWeight: 800 }}>Warnings</div>
                {warnings.map((warning, index) => <div key={index} style={{ fontSize: 12, color: '#d29922', lineHeight: 1.4 }}>{warning}</div>)}
              </div>
            )}
          </PanelBox>

          <details style={importDisclosureStyle(t)}>
            <summary style={importSummaryStyle(t)}>Generation audit</summary>
            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              <InfoLine label="Method" value={candidate.generationMode === 'ai' ? `AI-assisted local generation (${candidate.generationProvider ?? 'configured provider'})` : 'Deterministic local generation'} t={t} />
              {draftPath && <InfoLine label="Draft path" value={draftPath} t={t} />}
              <InfoLine label="Default test" value="assert row_count > 0" t={t} />
              <InfoLine label="Split strategy" value={candidate.splitStrategy ?? 'semicolon-go'} t={t} />
              {candidate.llmContext && <InfoLine label="Agent use" value={candidate.llmContext} t={t} />}
              {(candidate.conversionNotes ?? []).map((note, index) => <div key={index} style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.4 }}>{note}</div>)}
            </div>
          </details>

          <details style={importDisclosureStyle(t)}>
            <summary style={importSummaryStyle(t)}>AI refine tools</summary>
            <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
              <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.45 }}>
                Use these only when the generated draft needs a targeted improvement before certification.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {[
                  ['explain', 'Explain'],
                  ['fix-validation', 'Fix validation'],
                  ['infer-chart', 'Infer chart'],
                  ['propose-tests', 'Propose tests'],
                ].map(([action, label]) => (
                  <button key={action} onClick={() => void assist(action)} disabled={Boolean(aiBusy)} style={secondaryImportButtonStyle(t)}>
                    {aiBusy === action ? 'Working...' : label}
                  </button>
                ))}
              </div>
            {(candidate.aiAssistance ?? []).length > 0 && (
              <div style={{ display: 'grid', gap: 8 }}>
                {(candidate.aiAssistance ?? []).slice().reverse().map((item, index) => (
                  <div key={`${item.createdAt}-${index}`} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, padding: 9, background: t.appBg }}>
                    <div style={{ fontSize: 10, color: t.textMuted, fontWeight: 800, textTransform: 'uppercase' }}>{item.action} · {item.status}</div>
                    <div style={{ fontSize: 12, color: t.textSecondary, lineHeight: 1.45, marginTop: 5 }}>{item.summary}</div>
                  </div>
                ))}
              </div>
            )}
            </div>
          </details>
          <button onClick={() => void onReject(candidate)} disabled={candidate.reviewStatus === 'rejected'} style={{ ...secondaryImportButtonStyle(t), justifySelf: 'start' }}>
            {candidate.reviewStatus === 'rejected' ? 'Rejected' : 'Reject draft'}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}

function ImportStep({ index, active, complete, title, detail, t }: { index: number; active: boolean; complete: boolean; title: string; detail: string; t: Theme }) {
  const color = complete ? '#2ea043' : active ? t.accent : t.textMuted;
  return (
    <div
      style={{
        border: `1px solid ${active ? t.accent : t.headerBorder}`,
        borderRadius: 8,
        padding: '9px 10px',
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1fr)',
        gap: 8,
        alignItems: 'center',
        background: active ? `${t.accent}10` : t.cellBg,
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 999,
          display: 'inline-grid',
          placeItems: 'center',
          background: `${color}18`,
          color,
          fontSize: 11,
          fontWeight: 800,
          fontFamily: t.font,
        }}
      >
        {complete ? '✓' : index}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>{title}</span>
        <span style={{ display: 'block', fontSize: 10, color: t.textMuted, fontFamily: t.font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span>
      </span>
    </div>
  );
}

function ImportGuide({ t }: { t: Theme }) {
  const items = [
    ['1', 'Add SQL', 'Paste SQL, upload files, or point to an enterprise SQL folder.'],
    ['2', 'Generate drafts', 'ZLens analyzes statements, project metadata, tables, and business context.'],
    ['3', 'Review and certify', 'Preview results, edit metadata, then certify the governed block.'],
  ];
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <EmptyPanel message="Add SQL to analyze DQL candidates without creating block files." />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        {items.map(([index, title, detail]) => (
          <div key={title} style={{ border: `1px solid ${t.headerBorder}`, borderRadius: 8, background: t.appBg, padding: 12, display: 'grid', gap: 6 }}>
            <span style={{ width: 22, height: 22, borderRadius: 999, display: 'inline-grid', placeItems: 'center', background: `${t.accent}18`, color: t.accent, fontSize: 11, fontWeight: 800, fontFamily: t.font }}>
              {index}
            </span>
            <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>{title}</span>
            <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, lineHeight: 1.4 }}>{detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FieldLabel({ label, children, t }: { label: string; children: React.ReactNode; t: Theme }) {
  return (
    <label style={{ display: 'grid', gap: 5 }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, letterSpacing: '0.05em', textTransform: 'uppercase', fontFamily: t.font }}>{label}</span>
      {children}
    </label>
  );
}

// Prototype (Block Studio Redesign) builder row: label column left, content
// right, hairline divider below — replaces the old bordered card look.
function PanelBox({ title, hint, children, t }: { title: string; hint?: string; children: React.ReactNode; t: Theme }) {
  return (
    <section style={{ display: 'grid', gridTemplateColumns: '176px minmax(0, 1fr)', gap: 24, padding: '18px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 650, color: t.textPrimary, fontFamily: t.font }}>{title}</div>
        {hint ? <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.45, marginTop: 3, fontFamily: t.font }}>{hint}</div> : null}
      </div>
      <div style={{ minWidth: 0, display: 'grid', gap: 10, alignContent: 'start' }}>
        {children}
      </div>
    </section>
  );
}

function InfoLine({ label, value, t }: { label: string; value: string; t: Theme }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1fr)', gap: 8, fontSize: 12, fontFamily: t.font }}>
      <span style={{ color: t.textMuted }}>{label}</span>
      <span title={value} style={{ color: t.textSecondary, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}

function ImportPill({ label, tone, t }: { label: string; tone: 'ok' | 'warn' | 'info'; t: Theme }) {
  const color = tone === 'ok' ? '#2ea043' : tone === 'warn' ? '#d29922' : t.accent;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}18`, borderRadius: 999, padding: '3px 7px', fontFamily: t.font, textTransform: 'uppercase' }}>
      {label}
    </span>
  );
}

function SmartCount({ label, value, tone, t }: { label: string; value: number; tone: 'ok' | 'warn' | 'info'; t: Theme }) {
  const color = tone === 'ok' ? '#2ea043' : tone === 'warn' ? '#d29922' : t.accent;
  return (
    <div style={{ border: `1px solid ${color}33`, borderRadius: 8, background: `${color}10`, padding: '8px 10px', display: 'grid', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 17, fontWeight: 800, color, fontFamily: t.font, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, textTransform: 'uppercase', fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </div>
  );
}

function importDisclosureStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 8,
    background: t.cellBg,
    padding: 12,
    color: t.textPrimary,
    fontFamily: t.font,
  };
}

function importSummaryStyle(t: Theme): React.CSSProperties {
  return {
    cursor: 'pointer',
    color: t.textSecondary,
    fontSize: 11,
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontFamily: t.font,
  };
}

function importInputStyle(t: Theme): React.CSSProperties {
  return {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '8px 10px',
    outline: 'none',
    minWidth: 0,
  };
}

function compactBuilderInputStyle(t: Theme): React.CSSProperties {
  return {
    ...importInputStyle(t),
    boxSizing: 'border-box',
    fontSize: 11.5,
    minHeight: 32,
    padding: '6px 8px',
  };
}

function secondaryImportButtonStyle(t: Theme): React.CSSProperties {
  return {
    background: t.btnBg,
    border: `1px solid ${t.btnBorder}`,
    borderRadius: 6,
    color: t.textSecondary,
    cursor: 'pointer',
    fontSize: 11,
    fontFamily: t.font,
    padding: '6px 10px',
  };
}

function primaryImportButtonStyle(t: Theme): React.CSSProperties {
  return {
    ...secondaryImportButtonStyle(t),
    background: `${t.accent}18`,
    border: `1px solid ${t.accent}`,
    color: t.accent,
    fontWeight: 700,
  };
}

function StudioStatCard({ label, value, t }: { label: string; value: number; t: Theme }) {
  return (
    <div
      style={{
        background: t.cellBg,
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 10,
        padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, color: t.textMuted, fontFamily: t.font, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: t.textPrimary, fontFamily: t.font, marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

function DiagnosticsPanel({ diagnostics, t }: { diagnostics: BlockStudioDiagnostic[]; t: Theme }) {
  if (diagnostics.length === 0) {
    return <EmptyPanel message="No validation messages." />;
  }
  return (
    <div style={{ display: 'grid', gap: 8, padding: 12 }}>
      {diagnostics.map((diagnostic, index) => (
        <div
          key={`${diagnostic.code ?? diagnostic.message}-${index}`}
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${diagnostic.severity === 'error' ? t.error : diagnostic.severity === 'warning' ? t.warning : t.cellBorder}`,
            background: diagnostic.severity === 'error' ? `${t.error}12` : diagnostic.severity === 'warning' ? `${t.warning}12` : t.pillBg,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: diagnostic.severity === 'error' ? t.error : diagnostic.severity === 'warning' ? t.warning : t.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {diagnostic.field ? `${diagnostic.severity} · ${diagnostic.field}` : diagnostic.severity}
          </div>
          {diagnostic.title && <div style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary, marginTop: 4 }}>{diagnostic.title}</div>}
          {(diagnostic.references?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
              {diagnostic.references!.map((reference) => <code key={reference} style={{ fontSize: 10, color: t.accent, background: t.pillBg, borderRadius: 4, padding: '2px 5px' }}>{reference}</code>)}
            </div>
          )}
          <div style={{ fontSize: 12, color: t.textPrimary, marginTop: 4 }}>{diagnostic.message}</div>
          {diagnostic.correction && <div style={{ fontSize: 11.5, color: t.textSecondary, marginTop: 5 }}><strong>How to fix:</strong> {diagnostic.correction}</div>}
          {diagnostic.technicalDetails && diagnostic.technicalDetails !== diagnostic.message && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ cursor: 'pointer', color: t.textMuted, fontSize: 10.5, fontWeight: 700 }}>Technical details</summary>
              <pre style={{ margin: '6px 0 0', maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: t.textMuted, fontSize: 10, lineHeight: 1.4, fontFamily: t.fontMono }}>{diagnostic.technicalDetails}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

function VisualizationPanel({
  chartConfig,
  onChange,
  t,
}: {
  chartConfig: { chart?: string; x?: string; y?: string; color?: string; title?: string };
  onChange: (config: { chart?: string; x?: string; y?: string; color?: string; title?: string }) => void;
  t: Theme;
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '8px 10px',
    outline: 'none',
  };

  return (
    <div style={{ display: 'grid', gap: 10, padding: 12 }}>
      <select value={chartConfig.chart ?? 'table'} onChange={(event) => onChange({ ...chartConfig, chart: event.target.value })} style={inputStyle}>
        <option value="table">Table</option>
        {CHART_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <input value={chartConfig.x ?? ''} onChange={(event) => onChange({ ...chartConfig, x: event.target.value })} placeholder="x binding" style={inputStyle} />
      <input value={chartConfig.y ?? ''} onChange={(event) => onChange({ ...chartConfig, y: event.target.value })} placeholder="y binding" style={inputStyle} />
      <input value={chartConfig.color ?? ''} onChange={(event) => onChange({ ...chartConfig, color: event.target.value })} placeholder="color binding" style={inputStyle} />
      <input value={chartConfig.title ?? ''} onChange={(event) => onChange({ ...chartConfig, title: event.target.value })} placeholder="title" style={inputStyle} />
    </div>
  );
}


function BlockLineagePanel({
  blockName,
  loading,
  detail,
  graph,
  paths,
  onSelectNode,
  onOpenInspector,
  t,
}: {
  blockName: string | null;
  loading: boolean;
  detail: {
    node: { id: string; type: string; name: string; domain?: string } | null;
    incoming: Array<{ edge: { type: string }; node?: { id: string; type: string; name: string; domain?: string } }>;
    outgoing: Array<{ edge: { type: string }; node?: { id: string; type: string; name: string; domain?: string } }>;
  } | null;
  graph: {
    nodes: Array<{ id: string; type: string; name: string; domain?: string; layer?: string }>;
    edges: Array<{ source: string; target: string; type: string }>;
  } | null;
  paths: CompletePathResult | null;
  onSelectNode: (nodeId: string) => void;
  onOpenInspector: () => void;
  t: Theme;
}) {
  if (!blockName) {
    return <EmptyPanel message="Lineage will appear once the block has a name." />;
  }

  if (loading) {
    return <EmptyPanel message="Loading block lineage…" />;
  }

  if (!detail?.node) {
    return (
      <div style={{ padding: 12, display: 'grid', gap: 12 }}>
        <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>
          No lineage node was found for this block yet. Save the block to compile and refresh its focused lineage automatically.
        </div>
        <div>
          <button
            onClick={onOpenInspector}
            style={{ background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textPrimary, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 10px' }}
          >
            Open Focused Lineage
          </button>
        </div>
      </div>
    );
  }

  const focalNodeId = `block:${blockName}`;

  return (
    <div style={{ padding: 12, display: 'grid', gap: 12, overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>
            {detail.node.name}
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
            {detail.node.domain ? `Domain: ${detail.node.domain}` : 'Block lineage focus'}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button
          onClick={onOpenInspector}
          style={{ background: t.btnBg, border: `1px solid ${t.btnBorder}`, borderRadius: 6, color: t.textPrimary, cursor: 'pointer', fontSize: 11, fontFamily: t.font, padding: '6px 10px' }}
        >
          Open Focused Lineage
        </button>
      </div>

      {/* Layer Summary */}
      {paths?.layerSummary && <LayerSummary layerSummary={paths.layerSummary} t={t} />}

      {/* Embedded Mini-Graph */}
      {graph && graph.nodes.length > 0 && (
        <MiniLineageGraph
          nodes={graph.nodes}
          edges={graph.edges}
          focalNodeId={focalNodeId}
          height={360}
          onNodeClick={onSelectNode}
          layoutMode="flow"
        />
      )}

      {/* Complete Paths (from API) */}
      {paths && (paths.upstreamPaths.length > 0 || paths.downstreamPaths.length > 0) && (
        <div style={{ display: 'grid', gap: 10 }}>
          {paths.upstreamPaths.length > 0 && (
            <LineagePathSection
              title="Source to Block"
              paths={paths.upstreamPaths}
              onNodeClick={onSelectNode}
              focalNodeId={focalNodeId}
              t={t}
            />
          )}
          {paths.downstreamPaths.length > 0 && (
            <LineagePathSection
              title="Block to Consumption"
              paths={paths.downstreamPaths}
              onNodeClick={onSelectNode}
              focalNodeId={focalNodeId}
              t={t}
            />
          )}
        </div>
      )}

      {/* v1.3.3 Hex cleanup — dropped the collapsible Upstream/Downstream
          1-hop list. The mini-graph (visual) and Source-to-Block /
          Block-to-Consumption chains above already cover the same data;
          the 1-hop list was a third duplicate view. */}
    </div>
  );
}

function SavePanel({
  metadata,
  draftMetadata,
  onChange,
  t,
}: {
  metadata: { name: string; domain: string; folderPath?: string; description: string; owner: string; tags: string[] } | null;
  draftMetadata: ReturnType<typeof parseBlockFields> | null;
  onChange: (next: Partial<{ name: string; domain: string; folderPath?: string; description: string; owner: string; tags: string[] }>) => void;
  t: Theme;
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 6,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '8px 10px',
    outline: 'none',
  };

  const values = {
    name: draftMetadata?.name || metadata?.name || '',
    domain: draftMetadata?.domain || metadata?.domain || 'uncategorized',
    folderPath: metadata?.folderPath || '',
    description: draftMetadata?.description || metadata?.description || '',
    owner: draftMetadata?.owner || metadata?.owner || '',
    tags: draftMetadata?.tags || metadata?.tags || [],
  };

  return (
    <div style={{ display: 'grid', gap: 10, padding: 12 }}>
      <input value={values.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="Block name" style={inputStyle} />
      <input value={values.domain} onChange={(event) => onChange({ domain: event.target.value })} placeholder="Domain" style={inputStyle} />
      <input value={values.folderPath} onChange={(event) => onChange({ folderPath: event.target.value })} placeholder="Folder (optional), e.g. executive/monthly" style={{ ...inputStyle, fontFamily: t.fontMono }} />
      <input value={values.owner} onChange={(event) => onChange({ owner: event.target.value })} placeholder="Owner" style={inputStyle} />
      <input value={values.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="Description" style={inputStyle} />
      <CommaListInput values={values.tags} onChange={(tags) => onChange({ tags })} placeholder="Tags" style={inputStyle} />
    </div>
  );
}

function BlockStudioParameterPanel({
  parameters,
  values,
  onChange,
  onReset,
  onRun,
  running,
  t,
}: {
  parameters: BlockParameterDefinition[];
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
  onReset: (name: string) => void;
  onRun: () => void;
  running: boolean;
  t: Theme;
}) {
  if (parameters.length === 0) return <EmptyPanel message="This block has no runtime parameters. Add typed params in DQL Source when scope should be configurable." />;
  return (
    <div style={{ padding: 14, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: t.textPrimary }}>Test parameter values</div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 3 }}>These values affect only the preview. Save defaults in the block definition.</div>
        </div>
        <button type="button" onClick={onRun} disabled={running} style={primaryImportButtonStyle(t)}>{running ? 'Running…' : 'Run preview'}</button>
      </div>
      <BlockParameterControls parameters={parameters} values={values} onChange={onChange} onReset={onReset} t={t} includeNonRuntime card />
    </div>
  );
}

function BlockInvocationSnapshot({ values, t }: { values: Array<{ name: string; value: unknown; source: string }>; t: Theme }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {values.map((item) => <span key={item.name} style={{ fontSize: 10, color: t.textSecondary, background: t.appBg, border: `1px solid ${t.cellBorder}`, borderRadius: 999, padding: '4px 7px' }}>{item.name} = {Array.isArray(item.value) ? item.value.join(', ') : String(item.value)} <span style={{ color: t.textMuted }}>({item.source})</span></span>)}
    </div>
  );
}

function EmptyPanel({ message }: { message: string }) {
  const t = themes[useNotebookStore((state) => state.themeMode)];
  return <div style={{ padding: 16, fontSize: 12, color: t.textMuted }}>{message}</div>;
}

function BlockStudioRunStatusCard({ elapsedMs }: { elapsedMs: number }) {
  const t = themes[useNotebookStore((state) => state.themeMode)];
  return (
    <div style={{ padding: 12 }}>
      <div style={{
        display: 'grid',
        gap: 8,
        border: `1px solid ${t.headerBorder}`,
        borderRadius: 8,
        background: t.cellBg,
        padding: 12,
        color: t.textPrimary,
        fontFamily: t.font,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700 }}>
          <Loader2 size={16} strokeWidth={2} color={t.accent} aria-hidden="true" />
          <span>Running preview</span>
          <span style={{ marginLeft: 'auto', color: t.textMuted, fontSize: 11, fontWeight: 500 }}>
            {formatElapsed(elapsedMs)}
          </span>
        </div>
        <div style={{ color: t.textMuted, fontSize: 12, lineHeight: 1.45 }}>
          Executing the block query against the active connection.
        </div>
      </div>
    </div>
  );
}

function blockStudioErrorTechnicalDetails(error: unknown): string | null {
  if (!(error instanceof DqlApiError) || !error.details || typeof error.details !== 'object' || Array.isArray(error.details)) {
    return null;
  }
  const value = (error.details as { technicalDetails?: unknown }).technicalDetails;
  return typeof value === 'string' && value.trim() ? value : null;
}

function BlockStudioRunErrorCard({
  message,
  technicalDetails,
  repairing,
  onFix,
  onEdit,
}: {
  message: string;
  technicalDetails?: string | null;
  repairing: boolean;
  onFix: () => void;
  onEdit: () => void;
}) {
  const t = themes[useNotebookStore((state) => state.themeMode)];
  return (
    <div style={{ padding: 12 }}>
      <div style={{
        display: 'grid',
        gap: 8,
        border: '1px solid rgba(248, 81, 73, 0.35)',
        borderRadius: 8,
        background: 'rgba(248, 81, 73, 0.08)',
        color: t.textPrimary,
        fontFamily: t.font,
        padding: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#f85149' }}>
          <AlertTriangle size={16} strokeWidth={2} aria-hidden="true" />
          <span>Preview failed</span>
        </div>
        <div style={{ color: t.textPrimary, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {message}
        </div>
        <div style={{ color: t.textMuted, fontSize: 11.5, lineHeight: 1.45 }}>
          Correct the named field or runtime problem, then run the same draft again. Nothing was saved or certified.
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          <button type="button" onClick={onFix} disabled={repairing} style={{ ...primaryImportButtonStyle(t), display: 'inline-flex', alignItems: 'center', gap: 6, opacity: repairing ? .72 : 1 }}>
            {repairing ? <Loader2 size={13} style={{ animation: 'dql-agent-run-spin 0.8s linear infinite' }} /> : <Sparkles size={13} />}
            {repairing ? 'Fixing & running…' : 'Fix with AI & run'}
          </button>
          <button type="button" onClick={onEdit} style={secondaryImportButtonStyle(t)}>Edit DQL</button>
        </div>
        {technicalDetails && technicalDetails !== message && (
          <details style={{ borderTop: `1px solid ${t.headerBorder}`, paddingTop: 7 }}>
            <summary style={{ cursor: 'pointer', color: t.textMuted, fontSize: 10.5, fontWeight: 700 }}>Technical details</summary>
            <pre style={{ margin: '7px 0 0', maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: t.textMuted, fontSize: 10, lineHeight: 1.4, fontFamily: t.fontMono }}>{technicalDetails}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

const STATUS_COLORS: Record<string, string> = {
  draft: '#8b949e',
  review: '#d29922',
  certified: '#3fb950',
  deprecated: '#f85149',
};

const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: [],
  review: ['draft'],
  certified: ['deprecated'],
  deprecated: ['draft'],
};

function StatusWorkflow({
  currentStatus,
  blockPath,
  onStatusChanged,
  t,
}: {
  currentStatus: string;
  blockPath: string | null;
  onStatusChanged: (newStatus: string) => void;
  t: Theme;
}) {
  const [updating, setUpdating] = useState(false);
  const transitions = STATUS_TRANSITIONS[currentStatus] ?? [];

  const handleTransition = async (newStatus: string) => {
    if (!blockPath) return;
    setUpdating(true);
    try {
      const result = await api.updateBlockStatus(blockPath, newStatus);
      if (result.ok && result.status) {
        onStatusChanged(result.status);
      }
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '10px 12px', background: t.pillBg, borderRadius: 8,
    }}>
      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>Status:</span>
      <span style={{
        fontSize: 11, fontWeight: 600,
        color: STATUS_COLORS[currentStatus] ?? t.textMuted,
        background: `${STATUS_COLORS[currentStatus] ?? t.textMuted}18`,
        padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase',
        letterSpacing: '0.04em', fontFamily: t.font,
      }}>{currentStatus}</span>
      <span style={{ flex: 1 }} />
      {transitions.map((status) => (
        <button key={status} onClick={() => void handleTransition(status)} disabled={updating} style={{
          background: status === 'certified' ? '#3fb950' : status === 'deprecated' ? '#f85149' : t.btnBg,
          border: `1px solid ${status === 'certified' ? '#3fb950' : status === 'deprecated' ? '#f85149' : t.btnBorder}`,
          borderRadius: 4, color: status === 'certified' || status === 'deprecated' ? '#fff' : t.textSecondary,
          cursor: updating ? 'not-allowed' : 'pointer', fontSize: 10, fontWeight: 600,
          fontFamily: t.font, padding: '3px 10px', textTransform: 'capitalize',
          opacity: updating ? 0.5 : 1,
        }}>
          {updating ? '...' : status === 'certified' ? 'Certify' : status === 'deprecated' ? 'Deprecate' : `Move to ${status}`}
        </button>
      ))}
    </div>
  );
}

function CertificationChecklistPanel({
  result,
  t,
  repairing,
  onEditSource,
  onEditParameters,
  onReviewMetrics,
  onRun,
  onFix,
  onFixDescription,
}: {
  result: {
    ok?: boolean;
    pending?: boolean;
    checklist?: {
      metadata: boolean;
      validation: boolean;
      run: boolean;
      tests: boolean;
      chart: boolean;
      lineage: boolean;
      aiReviewed: boolean;
      blockers: string[];
      issues?: BlockStudioDiagnostic[];
      checkedAt?: string;
    };
    certification?: {
      certified: boolean;
      errors: Array<{ rule: string; message: string }>;
      warnings: Array<{ rule: string; message: string }>;
    };
    blockers?: string[];
    error?: string;
    phase?: string;
    progress?: number;
    message?: string;
  };
  t: Theme;
  repairing: boolean;
  onEditSource: () => void;
  onEditParameters: () => void;
  onReviewMetrics: () => void;
  onRun: () => void;
  onFix: (issue: BlockStudioDiagnostic) => void;
  onFixDescription?: (description: string) => void;
}) {
  const checklist = result.checklist;
  const testsAreBlocking = Boolean(
    checklist?.issues?.some((issue) => issue.code === 'tests_failed')
    || checklist?.blockers.some((blocker) => /tests? must pass|test failed/i.test(blocker)),
  );
  const items = checklist ? [
    ['Metadata', checklist.metadata, true],
    ['Validation', checklist.validation, true],
    ['Run', checklist.run, true],
    ['Tests', checklist.tests, testsAreBlocking],
    ['Chart', checklist.chart, false],
    ['Lineage', checklist.lineage, false],
  ] as const : [];
  const blockers = Array.from(new Set((result.blockers?.length ? result.blockers : checklist?.blockers ?? []).map(formatCertificationBlocker)));
  const issues = checklist?.issues?.length
    ? checklist.issues
    : blockers.map((message): BlockStudioDiagnostic => ({
        severity: 'error',
        code: 'certification_blocker',
        title: 'Certification requirement is not ready',
        message,
        correction: 'Update the block, run it again, and retry certification.',
        action: message === 'The query must run successfully.' ? 'run_again' : 'edit_source',
      }));
  const accent = result.pending ? t.accent : result.ok ? '#3fb950' : '#d29922';
  return (
    <div style={{ margin: '12px 12px 0', border: `1px solid ${accent}55`, borderRadius: 8, background: `${accent}0d`, padding: 12, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: accent, fontFamily: t.font }}>
          {result.pending ? 'Certification running' : result.ok ? 'Block certified' : 'Unable to certify'}
        </span>
        {checklist?.checkedAt && <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.fontMono }}>{checklist.checkedAt}</span>}
      </div>
      <div style={{ fontSize: 12, color: t.textMuted, lineHeight: 1.45 }}>
        {result.pending
          ? result.message ?? 'The exact draft is saved and the certification gates are running in the background.'
          : result.ok
          ? checklist?.tests
            ? 'Latest edits were saved, the block ran successfully, tests passed, and status was updated to certified.'
            : 'Latest edits were saved, the block ran successfully, no block tests are defined, and status was updated to certified.'
          : `The draft is saved. Certification stopped with ${issues.length || 1} required fix${issues.length === 1 ? '' : 'es'}; nothing was partially certified.`}
      </div>
      {result.pending && (
        <div style={{ display: 'grid', gap: 5 }}>
          <div style={{ height: 5, borderRadius: 999, background: t.headerBorder, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.max(4, Math.min(100, result.progress ?? 4))}%`, borderRadius: 999, background: t.accent, transition: 'width 180ms ease' }} />
          </div>
          <div style={{ fontSize: 10.5, color: t.textMuted, display: 'flex', justifyContent: 'space-between' }}>
            <span>{result.phase ? result.phase.replace(/_/g, ' ') : 'queued'}</span>
            <span>{Math.round(result.progress ?? 0)}%</span>
          </div>
        </div>
      )}
      {items.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {items.map(([label, ok, required]) => (
            <span key={label} title={!ok && !required ? `${label} is optional for local certification.` : undefined} style={{ fontSize: 11, fontWeight: 700, color: ok ? '#3fb950' : required ? '#d29922' : t.textMuted, background: ok ? '#3fb95018' : required ? '#d2992218' : t.pillBg, borderRadius: 999, padding: '4px 8px' }}>
              {ok ? '✓' : required ? '!' : '○'} {label}{!ok && !required ? ' · optional' : ''}
            </span>
          ))}
        </div>
      )}
      {result.error && issues.length === 0 && <div style={{ fontSize: 12, color: '#f85149' }}>{result.error}</div>}
      {!result.pending && !result.ok && issues.length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 10, color: '#d29922', textTransform: 'uppercase', fontWeight: 800 }}>
            Fixes before certification · {issues.length}
          </div>
          {issues.map((issue, index) => {
            const actionLabel = issue.action === 'review_metrics'
              ? 'Review metrics'
              : issue.action === 'run_again'
                ? 'Run block'
                : issue.action === 'edit_parameters'
                  ? 'Edit run inputs'
                  : issue.action === 'configure_runtime'
                    ? 'Review runtime'
                    : issue.action === 'fix_description'
                      ? 'Edit the description myself'
                      : 'Edit source';
            const handleAction = issue.action === 'review_metrics' || issue.action === 'configure_runtime'
              ? onReviewMetrics
              : issue.action === 'run_again'
                ? onRun
                : issue.action === 'edit_parameters'
                  ? onEditParameters
                : onEditSource;
            return (
              <div key={`${issue.code ?? issue.message}-${index}`} style={{ display: 'grid', gap: 7, border: `1px solid ${accent}44`, borderRadius: 8, background: t.cellBg, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <AlertTriangle size={14} color={accent} style={{ marginTop: 1, flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 7, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: t.textPrimary }}>{issue.title ?? 'Certification requirement is not ready'}</span>
                      {issue.field && <span style={{ fontSize: 10, color: t.textMuted }}>{issue.field}</span>}
                    </div>
                    {(issue.references?.length ?? 0) > 0 && (
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                        {issue.references!.map((reference) => <code key={reference} style={{ fontSize: 10, color: t.accent, background: t.pillBg, borderRadius: 4, padding: '2px 5px' }}>{reference}</code>)}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: 11.5, lineHeight: 1.45, color: t.textSecondary }}>{issue.message}</div>
                {issue.correction && <div style={{ fontSize: 11.5, lineHeight: 1.45, color: t.textPrimary }}><strong>How to fix:</strong> {issue.correction}</div>}
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  {issue.action === 'fix_description' && issue.suggestedDescription && onFixDescription && (
                    <button type="button" onClick={() => onFixDescription(issue.suggestedDescription!)} style={primaryImportButtonStyle(t)}>
                      Remove "review required" from the description and certify
                    </button>
                  )}
                  <button type="button" onClick={handleAction} style={secondaryImportButtonStyle(t)}>{actionLabel}</button>
                  {issue.technicalDetails && (
                    <button type="button" onClick={() => onFix(issue)} disabled={repairing} style={secondaryImportButtonStyle(t)}>
                      {repairing ? 'Fixing…' : 'Fix with AI & run'}
                    </button>
                  )}
                </div>
                {issue.technicalDetails && issue.technicalDetails !== issue.message && (
                  <details>
                    <summary style={{ cursor: 'pointer', color: t.textMuted, fontSize: 10.5, fontWeight: 700 }}>Technical details</summary>
                    <pre style={{ margin: '6px 0 0', maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: t.textMuted, fontSize: 10, lineHeight: 1.4, fontFamily: t.fontMono }}>{issue.technicalDetails}</pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
      {(result.certification?.warnings?.length ?? 0) > 0 && (
        <div style={{ display: 'grid', gap: 5 }}>
          <div style={{ fontSize: 10, color: t.textMuted, textTransform: 'uppercase', fontWeight: 800 }}>Warnings</div>
          {result.certification!.warnings.map((warning) => <div key={`${warning.rule}-${warning.message}`} style={{ fontSize: 12, color: t.textMuted }}>{warning.rule}: {warning.message}</div>)}
        </div>
      )}
    </div>
  );
}

function formatCertificationBlocker(blocker: string): string {
  const clean = blocker.trim();
  const lower = clean.toLowerCase();
  if (lower === 'missing owner' || lower === 'block has owner: missing owner') return 'Owner is required.';
  if (lower === 'missing domain' || lower === 'block has domain: missing domain') return 'Domain is required.';
  if (lower === 'missing description' || lower === 'block has description: missing description') return 'Description is required.';
  if (lower === 'block has not run successfully') return 'The query must run successfully.';
  if (lower === 'tests must pass before certification' || lower.startsWith('all tests pass:')) return 'Tests must pass.';
  if (lower === 'at least one test assertion is required before certification' || lower.startsWith('block has tests:')) return 'Add at least one test assertion.';
  if (lower === 'visualization config is missing') return 'Choose a visualization.';
  return clean;
}

function TestsPanel({
  source,
  blockPath,
  testResults,
  running,
  onRunTests,
  t,
}: {
  source: string;
  blockPath: string | null;
  testResults: Array<{ field: string; operator: string; expected: string; passed: boolean; actual?: string }> | null;
  running: boolean;
  onRunTests: () => void;
  t: Theme;
}) {
  // Quick parse for test assertions from source
  const assertionMatches = [...source.matchAll(/assert\s+(\w+)\s*(>=?|<=?|==|!=|IN)\s*(\S+)/g)];
  const assertions = assertionMatches.map((m) => ({ field: m[1], operator: m[2], expected: m[3] }));

  return (
    <div style={{ padding: 12, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
          Test Assertions
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={onRunTests} disabled={running || !blockPath} style={{
          background: t.accent, border: 'none', borderRadius: 6, color: '#fff',
          cursor: running || !blockPath ? 'not-allowed' : 'pointer',
          fontSize: 11, fontWeight: 600, fontFamily: t.font, padding: '5px 14px',
          opacity: running || !blockPath ? 0.5 : 1,
        }}>
          {running ? 'Running...' : 'Run Tests'}
        </button>
      </div>

      {assertions.length === 0 && (
        <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
          No test assertions found. Add assertions in your block:
          <pre style={{
            margin: '8px 0 0', padding: '8px 10px', background: t.editorBg,
            border: `1px solid ${t.cellBorder}`, borderRadius: 6,
            fontSize: 10, fontFamily: t.fontMono, color: t.textSecondary,
          }}>
{`tests {
  assert row_count > 0
  assert max_value <= 1000000
}`}
          </pre>
        </div>
      )}

      {assertions.map((a, i) => {
        const result = testResults?.[i];
        const passed = result?.passed;
        return (
          <div key={i} style={{
            padding: '8px 12px', borderRadius: 8,
            border: `1px solid ${result ? (passed ? '#3fb95040' : '#f8514940') : t.cellBorder}`,
            background: result ? (passed ? '#3fb95008' : '#f8514908') : 'transparent',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            {result && (
              <span style={{
                fontSize: 14, color: passed ? '#3fb950' : '#f85149', fontWeight: 700,
              }}>{passed ? '\u2713' : '\u2717'}</span>
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: t.textPrimary, fontFamily: t.fontMono }}>
                {a.field} {a.operator} {a.expected}
              </div>
              {result && !passed && result.actual && (
                <div style={{ fontSize: 11, color: '#f85149', fontFamily: t.font, marginTop: 2 }}>
                  Actual: {result.actual}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {testResults && testResults.length > 0 && (
        <div style={{
          padding: '8px 12px', background: t.pillBg, borderRadius: 8,
          fontSize: 12, fontFamily: t.font, color: t.textSecondary,
        }}>
          {testResults.filter((r) => r.passed).length}/{testResults.length} passed
        </div>
      )}
    </div>
  );
}

function HistoryPanel({
  entries,
  loaded,
  status,
  message,
  onOpenSourceControl,
  t,
}: {
  entries: Array<{ hash: string; date: string; author: string; message: string }>;
  loaded: boolean;
  status: 'ok' | 'not_a_repo' | 'git_unavailable' | 'error';
  message?: string;
  onOpenSourceControl: () => void;
  t: Theme;
}) {
  if (!loaded) {
    return <EmptyPanel message="Loading version history…" />;
  }
  if (entries.length === 0) {
    const text = status === 'not_a_repo'
      ? 'This project is not a Git repository yet, so blocks have no version history. Set up Git from Source control.'
      : status === 'git_unavailable'
        ? (message ?? 'Git is not installed or is not on the PATH of the ZLens server, so version history is unavailable.')
        : status === 'error'
          ? `Version history could not be loaded: ${message ?? 'unknown error'}`
          : 'No commits include this block yet. Commit it from Source control to start its history.';
    return (
      <div style={{ padding: 16, display: 'grid', gap: 10, justifyItems: 'start' }}>
        <div role={status === 'error' ? 'alert' : undefined} style={{ fontSize: 12, color: status === 'error' ? t.error : t.textMuted, fontFamily: t.font, lineHeight: 1.5 }}>
          {text}
        </div>
        {status !== 'git_unavailable' && (
          <button
            type="button"
            onClick={onOpenSourceControl}
            style={{
              border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.textPrimary,
              borderRadius: 6, padding: '5px 10px', fontSize: 12, fontFamily: t.font, cursor: 'pointer',
            }}
          >
            {status === 'not_a_repo' ? 'Set up Git in Source control' : 'Open Source control'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ padding: 12, display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
        Version History
      </div>
      {entries.map((entry) => (
        <div key={entry.hash} style={{
          padding: '8px 12px', border: `1px solid ${t.cellBorder}`,
          borderRadius: 8, background: t.inputBg,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{
              fontSize: 10, fontFamily: t.fontMono, color: t.accent,
              background: `${t.accent}12`, padding: '1px 6px', borderRadius: 4,
            }}>
              {entry.hash.slice(0, 7)}
            </span>
            <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
              {new Date(entry.date).toLocaleDateString()}
            </span>
            <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font, marginLeft: 'auto' }}>
              {entry.author}
            </span>
          </div>
          <div style={{ fontSize: 12, color: t.textPrimary, fontFamily: t.font }}>
            {entry.message}
          </div>
        </div>
      ))}
    </div>
  );
}

function DatabaseExplorer({
  tree,
  totalTree,
  expanded,
  setExpanded,
  onEnsureColumns,
  onInsert,
  query,
  onQueryChange,
  stats,
  connectionName,
  loadingNodes,
  onRefresh,
  t,
}: {
  tree: DatabaseSchemaNode[];
  totalTree: DatabaseSchemaNode[];
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onEnsureColumns: (node: DatabaseSchemaNode) => Promise<void>;
  onInsert: (snippet: string) => void;
  query: string;
  onQueryChange: (value: string) => void;
  stats: { schemas: number; tables: number; columns: number };
  connectionName: string;
  loadingNodes: Set<string>;
  onRefresh: () => void;
  t: Theme;
}) {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 8,
    color: t.textPrimary,
    fontSize: 12,
    fontFamily: t.font,
    padding: '8px 10px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const renderNode = (node: DatabaseSchemaNode, depth: number = 0): React.ReactNode => {
    const hasChildren = node.kind !== 'column';
    const isExpanded = expanded[node.id] ?? depth < 1;
    const isLoading = loadingNodes.has(node.id);
    const childCount = node.kind === 'schema'
      ? node.children?.length
      : node.kind === 'table'
        ? node.children?.length
        : undefined;

    // Color-coded badge for column types
    const badgeText = node.kind === 'column' ? node.type : node.kind;
    const badgeColor = node.kind === 'column' && node.type ? getTypeColor(node.type, t.accent) : undefined;

    return (
      <div key={node.id}>
        <TreeRow
          label={isLoading ? `${node.label} …` : node.label}
          depth={depth}
          count={childCount}
          expanded={hasChildren ? isExpanded : undefined}
          onToggle={hasChildren ? () => {
            setExpanded((prev) => ({ ...prev, [node.id]: !isExpanded }));
            if (!isExpanded) void onEnsureColumns(node);
          } : undefined}
          badge={badgeText}
          badgeColor={badgeColor}
          onClick={() => {
            if (node.kind === 'table' && node.path) onInsert(node.path);
            // Qualified column insert: table.column instead of bare column
            if (node.kind === 'column') {
              const tableName = node.path ? node.path.split('.').pop() : '';
              onInsert(tableName ? `${tableName}.${node.label}` : node.label);
            }
          }}
          onDoubleClick={() => {
            if (node.kind === 'table' && node.path) onInsert(`SELECT *\nFROM ${node.path}\nLIMIT 100`);
          }}
          t={t}
        />
        {hasChildren && isExpanded && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <>
      <div style={{ padding: 12, display: 'grid', gap: 12, borderBottom: `1px solid ${t.headerBorder}`, background: `${t.cellBg}66` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>Database Browser</div>
            <div style={{ fontSize: 11, color: t.textMuted, fontFamily: t.font }}>
              Browse the active connection, inspect schemas and columns, then insert tables or starter queries into the block.
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={onRefresh}
              title="Refresh schema"
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                color: t.textMuted, fontSize: 14, lineHeight: 1,
              }}
            >
              ↻
            </button>
            <span style={{ fontSize: 10, fontWeight: 700, color: t.accent, background: `${t.accent}18`, borderRadius: 999, padding: '5px 9px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {connectionName}
            </span>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
          <StudioStatCard label="Schemas" value={stats.schemas} t={t} />
          <StudioStatCard label="Tables" value={stats.tables} t={t} />
          <StudioStatCard label="Columns" value={stats.columns} t={t} />
        </div>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search schemas, tables, columns..."
          style={inputStyle}
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: tree.length > 0 ? '6px 0 0' : 0 }}>
        {totalTree.length === 0 ? (
          <EmptyPanel message="No schemas were found for the active connection yet." />
        ) : tree.length === 0 ? (
          <EmptyPanel message="No database objects match the current search." />
        ) : (
          tree.map((node) => renderNode(node))
        )}
      </div>
    </>
  );
}

function SemanticRow({
  row,
  selectedId,
  setSelectedId,
  expanded,
  setExpanded,
  onInsert,
  favorites,
  dispatch,
  t,
}: {
  row: FlatSemanticRow;
  selectedId: string | null;
  setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onInsert: (item: SemanticObjectDetail) => void;
  favorites: Set<string>;
  dispatch: ReturnType<typeof useDispatch>;
  t: Theme;
}) {
  const { node, depth, hasChildren, isExpanded } = row;
  const refName = node.id.split(':').slice(1).join(':');
  if (hasChildren) {
    return (
      <TreeRow
        label={node.label}
        depth={depth}
        count={node.children?.length}
        expanded={isExpanded}
        onToggle={() => setExpanded((prev) => ({ ...prev, [node.id]: !isExpanded }))}
        onClick={() => setSelectedId(node.id)}
        selected={selectedId === node.id}
        t={t}
      />
    );
  }

  const reference = typeof node.meta?.reference === 'string'
    ? node.meta.reference
    : refName;
  const technicalName = typeof node.meta?.localName === 'string'
    ? node.meta.localName
    : reference;
  const technicalLabel = typeof node.meta?.cube === 'string'
    && (node.kind === 'dimension' || node.kind === 'time_dimension')
    ? `${technicalName} · ${node.meta.cube}`
    : technicalName;
  return (
    <TreeRow
      label={node.label}
      secondaryLabel={technicalLabel}
      depth={depth}
      badge={node.kind}
      selected={selectedId === node.id}
      onClick={() => setSelectedId(node.id)}
      onDoubleClick={() => {
        void api.getSemanticObject(node.id).then(onInsert).catch(() => undefined);
      }}
      onFavoriteToggle={node.kind === 'metric' || node.kind === 'dimension'
        ? () => void api.toggleFavorite(refName).then((next) => dispatch({ type: 'SET_SEMANTIC_FAVORITES', favorites: next }))
        : undefined}
      favorite={node.kind === 'metric' || node.kind === 'dimension' ? favorites.has(refName) : undefined}
      t={t}
    />
  );
}

function appendSnippetToDraft(source: string, snippet: string): string {
  const queryMatch = source.match(/query\s*=\s*"""([\s\S]*?)"""/i);
  if (queryMatch) {
    return source.replace(queryMatch[0], `query = """${queryMatch[1].trimEnd()}\n${snippet}\n"""`);
  }
  if (/^\s*block\s+"/i.test(source.trim())) {
    return source.replace(/\n\}\s*$/, `\n\n  query = """\n${snippet}\n  """\n}\n`);
  }
  return `${source.trimEnd()}\n${snippet}\n`;
}

function applyGeneratedSqlToBlockDraft(source: string, sql: string): string {
  const clean = sql.trim().replace(/;\s*$/, '');
  if (!clean) return source;
  const sourceText = source.trim();
  if (!sourceText) return clean;

  const queryMatch = source.match(/query\s*=\s*"""[\s\S]*?"""/i);
  if (queryMatch) {
    return source.replace(queryMatch[0], `query = """\n${clean}\n  """`);
  }

  if (/^\s*block\s+"/i.test(sourceText)) {
    const queryBlock = `\n  query = """\n${clean}\n  """\n`;
    if (/\}\s*$/.test(source)) {
      return source.replace(/\}\s*$/, `${queryBlock}}\n`);
    }
    return `${source.trimEnd()}${queryBlock}`;
  }

  return clean;
}

function buildSemanticSkeleton(name: string): string {
  return renderSemanticBlockSource({
    name,
    status: 'draft',
    metrics: [],
    dimensions: [],
    visualization: { chart: 'table' },
  });
}

function buildCustomSkeleton(name: string): string {
  return `block "${name}" {
  domain = "uncategorized"
  type = "custom"
  description = ""
  owner = ""
  tags = []

  query = """
SELECT 1 AS value
"""

  visualization {
    chart = "table"
  }
}

`;
}

const BLOCK_STUDIO_DRAFT_SESSION_KEY = 'dql.block-studio.draft-session';

function makeBlockStudioDraftId(): string {
  const id = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try { window.localStorage.setItem(BLOCK_STUDIO_DRAFT_SESSION_KEY, id); } catch { /* ignore */ }
  return id;
}

/**
 * The unsaved-draft session id, stable across navigation. It scopes the Block AI
 * conversation thread, so minting a fresh one on every mount silently discarded
 * the conversation (and any in-flight run) each time the user left Block Studio
 * and came back. Only an explicit "new block" or a delete starts a new session.
 */
function readBlockStudioDraftId(): string {
  try {
    const stored = window.localStorage.getItem(BLOCK_STUDIO_DRAFT_SESSION_KEY)?.trim();
    if (stored) return stored;
  } catch { /* ignore */ }
  return makeBlockStudioDraftId();
}

function readBlockStudioDomain(): string {
  if (typeof window === 'undefined') return '';
  try { return window.localStorage.getItem('dql.block-studio.domain')?.trim() ?? ''; } catch { return ''; }
}

function readBlockStudioBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value == null ? fallback : value === '1';
  } catch {
    return fallback;
  }
}

function readBlockStudioNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

function hasBlockStudioWorkspaceContent(state: { blockStudioDraft: string; blockStudioMetadata: unknown; activeBlockPath: string | null }): boolean {
  return Boolean(state.blockStudioDraft.trim() || state.blockStudioMetadata || state.activeBlockPath);
}

function blockStudioPathPreview(metadata: Pick<BlockStudioOpenPayload['metadata'], 'name' | 'domain' | 'folderPath'> | null): string {
  const domain = metadata?.domain?.trim() || 'uncategorized';
  const folder = metadata?.folderPath?.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const slug = (metadata?.name || 'new_block').toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'new-block';
  return `domains/${domain}/blocks/${folder ? `${folder}/` : ''}${slug}.dql`;
}

function extractSelectAliases(sql: string): string[] {
  const select = sql.match(/\bselect\b([\s\S]*?)\bfrom\b/i)?.[1] ?? '';
  if (!select) return [];
  return Array.from(new Set(select.split(',').map((expression) => {
    const alias = expression.match(/\bas\s+([a-zA-Z_][\w$]*)\s*$/i)?.[1];
    if (alias) return alias;
    const simple = expression.trim().match(/(?:^|\.)([a-zA-Z_][\w$]*)$/)?.[1];
    return simple ?? '';
  }).filter(Boolean))).slice(0, 24);
}

function businessLabel(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function collectFacetValues(node: SemanticTreeNode | null, key: string): string[] {
  if (!node) return [];
  const values = new Set<string>();
  const visit = (current: SemanticTreeNode) => {
    const value = current.meta?.[key];
    if (typeof value === 'string' && value.trim()) values.add(value.trim());
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function filterSemanticTree(node: SemanticTreeNode, filters: { query: string; provider: string; domain: string; cube: string; owner: string; tag: string; type: string }): SemanticTreeNode | null {
  const q = filters.query.trim().toLowerCase();
  const metaValues = Object.values(node.meta ?? {})
    .filter((value): value is string | number | boolean => value != null)
    .map((value) => String(value).toLowerCase());
  const matchesQuery = !q || node.label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q) || metaValues.some((value) => value.includes(q));
  const matchesType = !filters.type || node.kind === filters.type || node.kind === 'provider' || node.kind === 'domain' || node.kind === 'group';
  const matchesDomain = !filters.domain || node.kind === 'provider' || node.kind === 'group' || node.meta?.domain === filters.domain || (node.kind === 'domain' && node.label === filters.domain);
  const matchesProvider = !filters.provider || node.meta?.provider === filters.provider || node.id === `provider:${filters.provider}`;
  const matchesCube = !filters.cube || node.meta?.cube === filters.cube;
  const matchesOwner = !filters.owner || node.meta?.owner === filters.owner;
  const matchesTag = !filters.tag || String(node.meta?.tags ?? '').split(',').filter(Boolean).includes(filters.tag);

  const children = (node.children ?? [])
    .map((child) => filterSemanticTree(child, filters))
    .filter((child): child is SemanticTreeNode => Boolean(child));

  if (children.length > 0) {
    return { ...node, children, count: node.kind === 'provider' || node.kind === 'domain' || node.kind === 'group' ? children.length : node.count };
  }

  return matchesQuery && matchesType && matchesDomain && matchesProvider && matchesCube && matchesOwner && matchesTag
    ? { ...node, children: [] }
    : null;
}

function flattenSemanticRows(nodes: SemanticTreeNode[], expanded: Record<string, boolean>, depth: number = 0): FlatSemanticRow[] {
  const rows: FlatSemanticRow[] = [];
  for (const node of nodes) {
    const hasChildren = Boolean(node.children && node.children.length > 0);
    const isExpanded = expanded[node.id] ?? depth < 3;
    rows.push({ node, depth, hasChildren, isExpanded });
    if (hasChildren && isExpanded) {
      rows.push(...flattenSemanticRows(node.children ?? [], expanded, depth + 1));
    }
  }
  return rows;
}

function updateDatabaseTree(tree: DatabaseSchemaNode[], nodeId: string, replacement: DatabaseSchemaNode): DatabaseSchemaNode[] {
  return tree.map((node) => {
    if (node.id === nodeId) return replacement;
    if (!node.children) return node;
    return { ...node, children: updateDatabaseTree(node.children, nodeId, replacement) };
  });
}

function filterDatabaseTree(tree: DatabaseSchemaNode[], query: string): DatabaseSchemaNode[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return tree;

  const filterNode = (node: DatabaseSchemaNode): DatabaseSchemaNode | null => {
    const matches = [node.label, node.path, node.type]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalized));

    const children = (node.children ?? [])
      .map((child) => filterNode(child))
      .filter((child): child is DatabaseSchemaNode => Boolean(child));

    if (matches || children.length > 0) {
      return { ...node, children };
    }
    return null;
  };

  return tree
    .map((node) => filterNode(node))
    .filter((node): node is DatabaseSchemaNode => Boolean(node));
}

function summarizeDatabaseTree(tree: DatabaseSchemaNode[]): { schemas: number; tables: number; columns: number } {
  let schemas = 0;
  let tables = 0;
  let columns = 0;

  const visit = (node: DatabaseSchemaNode) => {
    if (node.kind === 'schema') schemas += 1;
    if (node.kind === 'table') tables += 1;
    if (node.kind === 'column') columns += 1;
    for (const child of node.children ?? []) visit(child);
  };

  for (const node of tree) visit(node);
  return { schemas, tables, columns };
}

function flattenDatabaseTables(tree: DatabaseSchemaNode[]): Array<{ path: string; columns: string[] }> {
  const tables: Array<{ path: string; columns: string[] }> = [];
  const visit = (node: DatabaseSchemaNode) => {
    if (node.kind === 'table' && node.path) {
      tables.push({ path: node.path, columns: (node.children ?? []).filter((child) => child.kind === 'column').map((child) => child.label) });
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of tree) visit(node);
  return tables;
}

function blockContextCount(source: string): number {
  const fields = ['businessOutcome', 'llmContext', 'primaryTerms', 'sourceSystems', 'synonyms', 'caveats'];
  return fields.filter((field) => new RegExp(`\\b${field}\\s*=`, 'i').test(source)).length;
}

function hasSemanticNodes(tree: SemanticTreeNode | null): boolean {
  return Boolean(tree && tree.children && tree.children.length > 0);
}

function countSemanticObjects(stats: {
  metrics: number;
  measures: number;
  dimensions: number;
  timeDimensions: number;
  entities: number;
  hierarchies: number;
  semanticModels: number;
  savedQueries: number;
}): number {
  return stats.metrics
    + stats.measures
    + stats.dimensions
    + stats.timeDimensions
    + stats.entities
    + stats.hierarchies
    + stats.semanticModels
    + stats.savedQueries;
}

function countSemanticLeafNodes(tree: SemanticTreeNode | null): number {
  if (!tree) return 0;
  const objectKinds = new Set<SemanticTreeNode['kind']>([
    'cube',
    'metric',
    'measure',
    'dimension',
    'time_dimension',
    'entity',
    'hierarchy',
    'segment',
    'pre_aggregation',
    'semantic_model',
    'saved_query',
  ]);
  let count = objectKinds.has(tree.kind) ? 1 : 0;
  for (const child of tree.children ?? []) {
    count += countSemanticLeafNodes(child);
  }
  return count;
}

function buildFallbackSemanticTree(layer: SemanticLayerState): SemanticTreeNode | null {
  if (
    layer.metrics.length === 0 &&
    layer.measures.length === 0 &&
    layer.dimensions.length === 0 &&
    layer.timeDimensions.length === 0 &&
    layer.entities.length === 0 &&
    layer.hierarchies.length === 0 &&
    layer.semanticModels.length === 0 &&
    layer.savedQueries.length === 0
  ) {
    return null;
  }

  const provider = layer.provider ?? 'dql';
  const domainMap = new Map<string, SemanticTreeNode[]>();

  const pushToDomain = (domain: string, entry: SemanticTreeNode) => {
    const next = domainMap.get(domain) ?? [];
    next.push(entry);
    domainMap.set(domain, next);
  };

  for (const metric of layer.metrics) {
    const domain = metric.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `metric:${metric.name}`,
      label: metric.label || metric.name,
      kind: 'metric',
      meta: {
        provider,
        domain,
        cube: metric.table,
        owner: metric.owner ?? '',
        tags: metric.tags.join(','),
      },
    });
  }

  for (const measure of layer.measures) {
    const domain = measure.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `measure:${measure.name}`,
      label: measure.label || measure.name,
      kind: 'measure',
      meta: { provider, domain, cube: measure.cube ?? measure.table, owner: measure.owner ?? '', tags: measure.tags.join(','), agg: measure.agg },
    });
  }

  for (const dimension of layer.dimensions) {
    const domain = dimension.domain || 'uncategorized';
    const reference = dimension.reference ?? dimension.name;
    pushToDomain(domain, {
      id: `dimension:${reference}`,
      label: dimension.label || dimension.name,
      kind: 'dimension',
      meta: {
        provider,
        domain,
        cube: dimension.cube ?? dimension.table,
        reference,
        localName: dimension.name,
        qualifiedName: dimension.qualifiedName ?? null,
        owner: dimension.owner ?? '',
        tags: dimension.tags.join(','),
      },
    });
  }

  for (const dimension of layer.timeDimensions) {
    const domain = dimension.domain || 'uncategorized';
    const reference = dimension.reference ?? dimension.name;
    pushToDomain(domain, {
      id: `time_dimension:${reference}`,
      label: dimension.label || dimension.name,
      kind: 'time_dimension',
      meta: {
        provider,
        domain,
        cube: dimension.cube ?? dimension.table,
        reference,
        localName: dimension.name,
        qualifiedName: dimension.qualifiedName ?? null,
        owner: dimension.owner ?? '',
        tags: dimension.tags.join(','),
      },
    });
  }

  for (const entity of layer.entities) {
    const domain = entity.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `entity:${entity.name}`,
      label: entity.label || entity.name,
      kind: 'entity',
      meta: { provider, domain, cube: entity.cube ?? entity.table, owner: entity.owner ?? '', tags: entity.tags.join(','), type: entity.type },
    });
  }

  for (const model of layer.semanticModels) {
    const domain = model.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `semantic_model:${model.name}`,
      label: model.label || model.name,
      kind: 'semantic_model',
      meta: { provider, domain, table: model.table, owner: model.owner ?? '', tags: model.tags.join(',') },
    });
  }

  for (const savedQuery of layer.savedQueries) {
    const domain = savedQuery.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `saved_query:${savedQuery.name}`,
      label: savedQuery.label || savedQuery.name,
      kind: 'saved_query',
      meta: { provider, domain, owner: savedQuery.owner ?? '', tags: savedQuery.tags.join(',') },
    });
  }

  for (const hierarchy of layer.hierarchies) {
    const domain = hierarchy.domain || 'uncategorized';
    pushToDomain(domain, {
      id: `hierarchy:${hierarchy.name}`,
      label: hierarchy.label || hierarchy.name,
      kind: 'hierarchy',
      meta: {
        provider,
        domain,
      },
    });
  }

  const domainNodes = Array.from(domainMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, items]) => {
      const metrics = items.filter((item) => item.kind === 'metric');
      const measures = items.filter((item) => item.kind === 'measure');
      const dimensions = items.filter((item) => item.kind === 'dimension');
      const timeDimensions = items.filter((item) => item.kind === 'time_dimension');
      const entities = items.filter((item) => item.kind === 'entity');
      const hierarchies = items.filter((item) => item.kind === 'hierarchy');
      const semanticModels = items.filter((item) => item.kind === 'semantic_model');
      const savedQueries = items.filter((item) => item.kind === 'saved_query');
      const children: SemanticTreeNode[] = [];
      const pushGroup = (kind: SemanticTreeNode['kind'], label: string, groupItems: SemanticTreeNode[]) => {
        if (groupItems.length === 0) return;
        children.push({
          id: `group:${domain}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          label,
          kind: 'group',
          count: groupItems.length,
          meta: { provider, domain, objectKind: kind },
          children: groupItems.sort((a, b) => a.label.localeCompare(b.label)),
        });
      };
      if (metrics.length > 0) {
        pushGroup('metric', 'Metrics', metrics);
      }
      pushGroup('measure', 'Measures', measures);
      if (dimensions.length > 0) {
        pushGroup('dimension', 'Dimensions', dimensions);
      }
      pushGroup('time_dimension', 'Time Dimensions', timeDimensions);
      pushGroup('entity', 'Entities', entities);
      if (hierarchies.length > 0) {
        pushGroup('hierarchy', 'Hierarchies', hierarchies);
      }
      pushGroup('semantic_model', 'Semantic Models', semanticModels);
      pushGroup('saved_query', 'Saved Queries', savedQueries);
      return {
        id: `domain:${provider}:${domain}`,
        label: domain,
        kind: 'domain' as const,
        count: children.length,
        meta: { provider, domain },
        children,
      };
    });

  return {
    id: 'root:semantic',
    label: 'Semantic Layer',
    kind: 'group',
    children: [
      {
        id: `provider:${provider}`,
        label: provider.toUpperCase(),
        kind: 'provider',
        count: domainNodes.length,
        meta: { provider },
        children: domainNodes,
      },
    ],
  };
}
